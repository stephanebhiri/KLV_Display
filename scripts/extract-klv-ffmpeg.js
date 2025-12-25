#!/usr/bin/env node
/**
 * Extract KLV using ffmpeg and parse
 */
import { execSync, spawn } from 'child_process';
import { writeFileSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// SMPTE 336M UAS Local Set key
const UAS_KEY = Buffer.from([
  0x06, 0x0E, 0x2B, 0x34, 0x02, 0x0B, 0x01, 0x01,
  0x0E, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00
]);

function parseBER(buffer, offset) {
  if (offset >= buffer.length) return { length: 0, bytesRead: 0 };
  const firstByte = buffer[offset];
  if (firstByte < 0x80) {
    return { length: firstByte, bytesRead: 1 };
  }
  const numBytes = firstByte & 0x7f;
  let length = 0;
  for (let i = 0; i < numBytes && offset + 1 + i < buffer.length; i++) {
    length = (length << 8) | buffer[offset + 1 + i];
  }
  return { length, bytesRead: 1 + numBytes };
}

function parseKLVPacket(data) {
  const result = {};
  let offset = 0;

  while (offset < data.length - 2) {
    const tag = data[offset++];
    const { length: len, bytesRead } = parseBER(data, offset);
    offset += bytesRead;
    if (offset + len > data.length) break;
    if (len === 0) continue; // Skip empty tags (like tags 11, 12)

    const value = data.slice(offset, offset + len);
    offset += len;

    switch (tag) {
      case 2: // Timestamp (UNIX microseconds)
        if (len === 8) {
          const high = value.readUInt32BE(0);
          const low = value.readUInt32BE(4);
          result.timestamp = (high * 0x100000000 + low) / 1000;
        }
        break;
      case 3: result.missionId = value.toString('utf8'); break;
      case 4: result.platformTailNumber = value.toString('utf8'); break;
      case 5: result.platformHeading = (value.readUInt16BE(0) / 0xFFFF) * 360; break;
      case 6: result.platformPitch = (value.readInt16BE(0) / 0x7FFF) * 20; break;
      case 7: result.platformRoll = (value.readInt16BE(0) / 0x7FFF) * 50; break;
      case 8: result.platformTrueAirspeed = value.readUInt8(0); break; // m/s
      case 9: result.platformIndicatedAirspeed = value.readUInt8(0); break; // m/s
      case 10: result.platformDesignation = value.toString('utf8'); break;
      case 11: result.imageSourceSensor = value.toString('utf8'); break;
      case 12: result.imageCoordinateSystem = value.toString('utf8'); break;
      case 13: result.sensorLatitude = (value.readInt32BE(0) / 0x7FFFFFFF) * 90; break;
      case 14: result.sensorLongitude = (value.readInt32BE(0) / 0x7FFFFFFF) * 180; break;
      case 15: result.sensorAltitude = (value.readUInt16BE(0) / 0xFFFF) * 19900 - 900; break;
      case 16: result.horizontalFOV = (value.readUInt16BE(0) / 0xFFFF) * 180; break;
      case 17: result.verticalFOV = (value.readUInt16BE(0) / 0xFFFF) * 180; break;
      case 18: result.sensorRelativeAzimuth = (value.readUInt32BE(0) / 0xFFFFFFFF) * 360; break;
      case 19: result.sensorRelativeElevation = (value.readInt32BE(0) / 0x7FFFFFFF) * 180 - 180; break;
      case 20: result.sensorRelativeRoll = (value.readUInt32BE(0) / 0xFFFFFFFF) * 360; break;
      case 21: result.slantRange = (value.readUInt32BE(0) / 0xFFFFFFFF) * 5000000; break; // meters
      case 22: result.targetWidth = (value.readUInt16BE(0) / 0xFFFF) * 10000; break; // meters
      case 23: result.frameCenterLat = (value.readInt32BE(0) / 0x7FFFFFFF) * 90; break;
      case 24: result.frameCenterLon = (value.readInt32BE(0) / 0x7FFFFFFF) * 180; break;
      case 25: result.frameCenterElev = (value.readUInt16BE(0) / 0xFFFF) * 19900 - 900; break;
      // Image corner offsets (relative to frame center)
      case 26: result.offsetCornerLat1 = (value.readInt16BE(0) / 0x7FFF) * 0.075; break;
      case 27: result.offsetCornerLon1 = (value.readInt16BE(0) / 0x7FFF) * 0.075; break;
      case 28: result.offsetCornerLat2 = (value.readInt16BE(0) / 0x7FFF) * 0.075; break;
      case 29: result.offsetCornerLon2 = (value.readInt16BE(0) / 0x7FFF) * 0.075; break;
      case 30: result.offsetCornerLat3 = (value.readInt16BE(0) / 0x7FFF) * 0.075; break;
      case 31: result.offsetCornerLon3 = (value.readInt16BE(0) / 0x7FFF) * 0.075; break;
      case 32: result.offsetCornerLat4 = (value.readInt16BE(0) / 0x7FFF) * 0.075; break;
      case 33: result.offsetCornerLon4 = (value.readInt16BE(0) / 0x7FFF) * 0.075; break;
      case 38: result.securityLocalMetadataSet = value.toString('hex'); break;
      case 48: result.securityClassification = value.toString('utf8'); break;
      case 56: result.platformGroundSpeed = value.readUInt8(0); break; // m/s
      case 57: result.groundRange = (value.readUInt32BE(0) / 0xFFFFFFFF) * 5000000; break; // meters
      case 65: result.uasLdsVersionNumber = value.readUInt8(0); break;
    }
  }

  return result;
}

function extractKLVPackets(rawData) {
  const packets = [];
  let offset = 0;
  let startTimestamp = null;

  while (offset < rawData.length - 16) {
    // Find UAS key
    const keyPos = rawData.indexOf(UAS_KEY, offset);
    if (keyPos === -1) break;

    // Parse BER length
    const afterKey = keyPos + 16;
    if (afterKey >= rawData.length) break;

    const { length, bytesRead } = parseBER(rawData, afterKey);
    if (length === 0) {
      offset = keyPos + 1;
      continue;
    }

    const valueStart = afterKey + bytesRead;
    if (valueStart + length > rawData.length) break;

    const klvValue = rawData.slice(valueStart, valueStart + length);
    const parsed = parseKLVPacket(klvValue);

    if (Object.keys(parsed).length > 0) {
      if (parsed.timestamp) {
        if (startTimestamp === null) startTimestamp = parsed.timestamp;
        parsed.relativeTimeMs = Math.floor(parsed.timestamp - startTimestamp);
      } else {
        parsed.relativeTimeMs = packets.length * 1000;
      }
      packets.push(parsed);
    }

    offset = valueStart + length;
  }

  return packets;
}

async function extractFromFile(tsPath, outputPath, ptsOffsetMs = 0) {
  console.log(`Extracting KLV from ${tsPath}...`);

  // Try different stream mappings - some files have multiple data streams
  const streamMappings = ['0:d', '0:1', '0:2'];

  for (const mapping of streamMappings) {
    const rawData = await tryExtractStream(tsPath, mapping);
    if (rawData && rawData.length > 0) {
      console.log(`Raw KLV data: ${rawData.length} bytes (from ${mapping})`);
      const packets = extractKLVPackets(rawData);
      console.log(`Parsed ${packets.length} KLV packets`);

      if (packets.length > 0) {
        const duration = packets[packets.length - 1].relativeTimeMs;
        const output = {
          source: tsPath.split('/').pop(),
          duration,
          packetCount: packets.length,
          ptsOffsetMs,  // Video-KLV timing offset
          packets
        };
        writeFileSync(outputPath, JSON.stringify(output, null, 2));
        console.log(`Saved to ${outputPath}\n`);
        return output;
      }
    }
  }

  console.log('No KLV data found in any stream\n');
  return { packets: [], duration: 0, ptsOffsetMs: 0 };
}

function tryExtractStream(tsPath, mapping) {
  return new Promise((resolve) => {
    const chunks = [];
    const ffmpeg = spawn('ffmpeg', [
      '-i', tsPath,
      '-map', mapping,
      '-c', 'copy',
      '-f', 'data',
      '-'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));

    ffmpeg.on('close', () => {
      if (chunks.length === 0) {
        resolve(null);
      } else {
        resolve(Buffer.concat(chunks));
      }
    });

    ffmpeg.on('error', () => resolve(null));
  });
}

// Get first PTS for a stream
function getFirstPTS(tsPath, streamSelector) {
  return new Promise((resolve) => {
    const ffprobe = spawn('ffprobe', [
      '-select_streams', streamSelector,
      '-show_entries', 'packet=pts_time',
      '-of', 'csv=p=0',
      tsPath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let output = '';
    ffprobe.stdout.on('data', (chunk) => { output += chunk.toString(); });
    ffprobe.on('close', () => {
      const firstLine = output.split('\n')[0]?.trim();
      const pts = parseFloat(firstLine);
      resolve(isNaN(pts) ? null : pts);
    });
  });
}

// Main
async function main() {
  const videos = ['Cheyenne', 'Falls', 'Truck'];
  const samplesDir = join(__dirname, '../samples/normalized');
  const demoDir = join(__dirname, '../demo-assets');

  for (const video of videos) {
    const tsPath = join(samplesDir, `${video}.ts`);
    const outputPath = join(demoDir, video, 'klv.json');

    try {
      // Get video and KLV PTS offsets
      const videoPTS = await getFirstPTS(tsPath, 'v:0');
      const klvPTS = await getFirstPTS(tsPath, 'd:0') || await getFirstPTS(tsPath, '1');

      const ptsOffset = (videoPTS && klvPTS) ? Math.round((videoPTS - klvPTS) * 1000) : 0;
      console.log(`${video}: videoPTS=${videoPTS?.toFixed(3)}s, klvPTS=${klvPTS?.toFixed(3)}s, offset=${ptsOffset}ms`);

      await extractFromFile(tsPath, outputPath, ptsOffset);
    } catch (err) {
      console.error(`Error processing ${video}:`, err.message);
    }
  }
}

main();
