#!/usr/bin/env node
/**
 * Extract KLV data with timestamps for demo playback
 */
import { createReadStream } from 'fs';
import { writeFileSync } from 'fs';
import { dirname, basename, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// MISB 0601 Universal Key
const MISB_0601_KEY = Buffer.from([
  0x06, 0x0e, 0x2b, 0x34, 0x02, 0x0b, 0x01, 0x01,
  0x0e, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00
]);

// KLV tag definitions
const KLV_TAGS = {
  2: 'timestamp',
  5: 'platformHeading',
  6: 'platformPitch',
  7: 'platformRoll',
  13: 'sensorLatitude',
  14: 'sensorLongitude',
  15: 'sensorAltitude',
  16: 'horizontalFOV',
  17: 'verticalFOV',
  18: 'sensorRelativeAzimuth',
  19: 'sensorRelativeElevation',
  20: 'sensorRelativeRoll',
  21: 'slantRange',
  22: 'targetWidth',
  23: 'frameCenter_lat',
  24: 'frameCenter_lon',
  25: 'frameCenter_elev',
  40: 'targetLocationLatitude',
  41: 'targetLocationLongitude'
};

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
    const len = data[offset++];
    if (offset + len > data.length) break;

    const value = data.slice(offset, offset + len);
    offset += len;

    const tagName = KLV_TAGS[tag];
    if (tagName) {
      if (tagName === 'timestamp' && len === 8) {
        // UNIX microseconds
        const high = value.readUInt32BE(0);
        const low = value.readUInt32BE(4);
        result.timestamp = (high * 0x100000000 + low) / 1000; // to ms
      } else if (tagName.includes('Latitude') || tagName.includes('lat')) {
        if (len === 4) {
          result[tagName] = (value.readInt32BE(0) / 0x7FFFFFFF) * 90;
        }
      } else if (tagName.includes('Longitude') || tagName.includes('lon')) {
        if (len === 4) {
          result[tagName] = (value.readInt32BE(0) / 0x7FFFFFFF) * 180;
        }
      } else if (tagName.includes('Heading') || tagName.includes('Azimuth')) {
        if (len === 2) {
          result[tagName] = (value.readUInt16BE(0) / 0xFFFF) * 360;
        }
      } else if (tagName.includes('Pitch') || tagName.includes('Roll') || tagName.includes('Elevation')) {
        if (len === 2) {
          result[tagName] = ((value.readInt16BE(0) / 0x7FFF) * 90);
        }
      } else if (tagName.includes('Altitude') || tagName.includes('elev')) {
        if (len === 2) {
          result[tagName] = (value.readUInt16BE(0) / 0xFFFF) * 19900 - 900;
        }
      } else if (tagName === 'slantRange') {
        if (len === 4) {
          result[tagName] = (value.readUInt32BE(0) / 0xFFFFFFFF) * 5000000;
        }
      } else if (tagName === 'horizontalFOV' || tagName === 'verticalFOV') {
        if (len === 2) {
          result[tagName] = (value.readUInt16BE(0) / 0xFFFF) * 180;
        }
      }
    }
  }
  return result;
}

function extractKLVFromTS(tsFilePath, outputPath) {
  return new Promise((resolve, reject) => {
    const packets = [];
    let buffer = Buffer.alloc(0);
    let packetCount = 0;
    let startTime = null;

    const stream = createReadStream(tsFilePath);

    stream.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Process TS packets (188 bytes each)
      while (buffer.length >= 188) {
        if (buffer[0] !== 0x47) {
          // Sync lost, find next sync byte
          const syncPos = buffer.indexOf(0x47, 1);
          if (syncPos === -1) {
            buffer = Buffer.alloc(0);
            break;
          }
          buffer = buffer.slice(syncPos);
          continue;
        }

        const tsPacket = buffer.slice(0, 188);
        buffer = buffer.slice(188);

        // Parse TS header
        const pid = ((tsPacket[1] & 0x1f) << 8) | tsPacket[2];
        const adaptationField = (tsPacket[3] & 0x30) >> 4;

        // Skip PAT/PMT, look for data PIDs (typically 0x101, 0x102 for KLV)
        if (pid >= 0x100 && pid < 0x200) {
          let payloadStart = 4;
          if (adaptationField === 2 || adaptationField === 3) {
            payloadStart += 1 + tsPacket[4];
          }

          if (payloadStart < 188) {
            const payload = tsPacket.slice(payloadStart);

            // Look for MISB 0601 key
            const keyPos = payload.indexOf(MISB_0601_KEY);
            if (keyPos !== -1 && keyPos + 16 < payload.length) {
              const afterKey = keyPos + 16;
              const { length, bytesRead } = parseBER(payload, afterKey);

              if (length > 0 && afterKey + bytesRead + length <= payload.length) {
                const klvData = payload.slice(afterKey + bytesRead, afterKey + bytesRead + length);
                const parsed = parseKLVPacket(klvData);

                if (Object.keys(parsed).length > 0) {
                  packetCount++;

                  // Calculate relative time from first packet
                  if (parsed.timestamp) {
                    if (startTime === null) startTime = parsed.timestamp;
                    parsed.relativeTimeMs = parsed.timestamp - startTime;
                  } else {
                    // Estimate based on packet count (~1 packet per second typically)
                    parsed.relativeTimeMs = packetCount * 1000;
                  }

                  packets.push(parsed);
                }
              }
            }
          }
        }
      }
    });

    stream.on('end', () => {
      console.log(`Extracted ${packets.length} KLV packets from ${basename(tsFilePath)}`);

      // Calculate video duration based on last timestamp
      const duration = packets.length > 0 ? packets[packets.length - 1].relativeTimeMs : 0;

      const output = {
        source: basename(tsFilePath),
        duration: duration,
        packetCount: packets.length,
        packets: packets
      };

      writeFileSync(outputPath, JSON.stringify(output, null, 2));
      console.log(`Saved to ${outputPath}`);
      resolve(output);
    });

    stream.on('error', reject);
  });
}

// Main
const videos = ['Cheyenne', 'Falls', 'Truck'];
const samplesDir = join(__dirname, '../samples/normalized');
const demoDir = join(__dirname, '../demo-assets');

async function main() {
  for (const video of videos) {
    const tsPath = join(samplesDir, `${video}.ts`);
    const outputPath = join(demoDir, video, 'klv.json');

    try {
      await extractKLVFromTS(tsPath, outputPath);
    } catch (err) {
      console.error(`Error processing ${video}:`, err.message);
    }
  }
}

main();
