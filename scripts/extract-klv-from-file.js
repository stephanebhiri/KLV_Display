#!/usr/bin/env node
/**
 * Extract KLV from TS file using the same logic as UDP splitter
 */
import { createReadStream, writeFileSync } from 'fs';
import { dirname, basename, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// SMPTE 336M UAS Local Set key
const UAS_KEY = Buffer.from([
  0x06, 0x0E, 0x2B, 0x34, 0x02, 0x0B, 0x01, 0x01,
  0x0E, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00
]);

// KLVA registration descriptor identifier
const KLVA_ID = 0x4B4C5641; // "KLVA" in ASCII

class TSKLVExtractor {
  constructor() {
    this.pmtPid = null;
    this.klvPids = new Set();
    this.pesBuffers = new Map();
    this.klvPackets = [];
    this.tsPacketCount = 0;
    this.startPTS = null;
  }

  extractFromFile(filePath) {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const stream = createReadStream(filePath);

      stream.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        // Process 188-byte TS packets
        while (buffer.length >= 188) {
          if (buffer[0] !== 0x47) {
            const syncPos = buffer.indexOf(0x47, 1);
            if (syncPos === -1) {
              buffer = Buffer.alloc(0);
              break;
            }
            buffer = buffer.slice(syncPos);
            continue;
          }

          this._processPacket(buffer.slice(0, 188));
          buffer = buffer.slice(188);
        }
      });

      stream.on('end', () => {
        resolve(this.klvPackets);
      });

      stream.on('error', reject);
    });
  }

  _processPacket(packet) {
    this.tsPacketCount++;
    const pid = ((packet[1] & 0x1f) << 8) | packet[2];
    const payloadStart = (packet[1] & 0x40) !== 0;
    const adaptationField = (packet[3] & 0x30) >> 4;

    let offset = 4;
    if (adaptationField === 2 || adaptationField === 3) {
      offset += 1 + packet[4];
    }
    if (adaptationField === 1 || adaptationField === 3) {
      if (offset < 188) {
        const payload = packet.slice(offset);

        if (pid === 0) {
          this._parsePAT(payload);
        } else if (pid === this.pmtPid) {
          this._parsePMT(payload, payloadStart);
        } else if (this.klvPids.has(pid)) {
          this._processKLVPid(pid, payload, payloadStart, packet);
        }
      }
    }
  }

  _parsePAT(payload) {
    if (payload.length < 8) return;
    let offset = 0;
    if (payload[0] !== 0) offset = payload[0] + 1;

    if (payload[offset] !== 0x00) return; // Not PAT
    const sectionLength = ((payload[offset + 1] & 0x0f) << 8) | payload[offset + 2];

    offset += 8;
    const endPos = Math.min(offset + sectionLength - 9, payload.length - 4);

    while (offset < endPos) {
      const programNum = (payload[offset] << 8) | payload[offset + 1];
      const pmtPid = ((payload[offset + 2] & 0x1f) << 8) | payload[offset + 3];
      offset += 4;

      if (programNum !== 0 && !this.pmtPid) {
        this.pmtPid = pmtPid;
      }
    }
  }

  _parsePMT(payload, payloadStart) {
    if (!payloadStart) return;
    if (payload.length < 12) return;

    let offset = 0;
    if (payload[0] !== 0) offset = payload[0] + 1;

    if (payload[offset] !== 0x02) return; // Not PMT
    const sectionLength = ((payload[offset + 1] & 0x0f) << 8) | payload[offset + 2];
    const programInfoLength = ((payload[offset + 10] & 0x0f) << 8) | payload[offset + 11];

    offset += 12 + programInfoLength;
    const endPos = Math.min(3 + sectionLength - 4, payload.length);

    while (offset + 5 <= endPos) {
      const streamType = payload[offset];
      const elementaryPid = ((payload[offset + 1] & 0x1f) << 8) | payload[offset + 2];
      const esInfoLength = ((payload[offset + 3] & 0x0f) << 8) | payload[offset + 4];

      // Check descriptors for KLVA
      const descEnd = Math.min(offset + 5 + esInfoLength, payload.length);
      for (let di = offset + 5; di + 2 <= descEnd;) {
        const descTag = payload[di];
        const descLen = payload[di + 1];
        if (di + 2 + descLen > descEnd) break;

        // Registration descriptor (0x05) with KLVA
        if (descTag === 0x05 && descLen >= 4) {
          const formatId = payload.readUInt32BE(di + 2);
          if (formatId === KLVA_ID) {
            if (!this.klvPids.has(elementaryPid)) {
              this.klvPids.add(elementaryPid);
              console.log(`Found KLV PID: 0x${elementaryPid.toString(16)}`);
            }
          }
        }
        di += 2 + descLen;
      }

      // Also check stream type 0x15 (private data) or 0x06 (PES private)
      if ((streamType === 0x15 || streamType === 0x06) && esInfoLength === 0) {
        // Possible KLV without descriptor
        if (!this.klvPids.has(elementaryPid)) {
          this.klvPids.add(elementaryPid);
          console.log(`Possible KLV PID (type ${streamType}): 0x${elementaryPid.toString(16)}`);
        }
      }

      offset += 5 + esInfoLength;
    }
  }

  _processKLVPid(pid, payload, payloadStart, fullPacket) {
    if (!this.pesBuffers.has(pid)) {
      this.pesBuffers.set(pid, { buffer: Buffer.alloc(0), pts: null });
    }
    const state = this.pesBuffers.get(pid);

    if (payloadStart) {
      // Flush previous buffer
      if (state.buffer.length > 0) {
        this._extractKLVFromPES(state.buffer, pid, state.pts);
      }
      state.buffer = payload;

      // Extract PTS
      if (payload.length >= 14 && payload[0] === 0x00 && payload[1] === 0x00 && payload[2] === 0x01) {
        const flags = payload[7];
        if (flags & 0x80) { // PTS present
          const pts = this._readPTS(payload, 9);
          state.pts = pts;
        }
      }
    } else {
      state.buffer = Buffer.concat([state.buffer, payload]);
    }
  }

  _readPTS(data, offset) {
    if (offset + 5 > data.length) return null;
    const b = data;
    return (
      ((b[offset] & 0x0e) << 29) |
      (b[offset + 1] << 22) |
      ((b[offset + 2] & 0xfe) << 14) |
      (b[offset + 3] << 7) |
      (b[offset + 4] >> 1)
    );
  }

  _extractKLVFromPES(pesData, pid, pts) {
    // Skip PES header
    if (pesData.length < 9) return;
    if (pesData[0] !== 0x00 || pesData[1] !== 0x00 || pesData[2] !== 0x01) return;

    const headerLen = pesData[8];
    const dataStart = 9 + headerLen;
    if (dataStart >= pesData.length) return;

    const klvData = pesData.slice(dataStart);

    // Find UAS key
    const keyPos = klvData.indexOf(UAS_KEY);
    if (keyPos === -1) return;

    // Parse BER length
    const afterKey = keyPos + 16;
    if (afterKey >= klvData.length) return;

    const { length, bytesRead } = this._parseBER(klvData, afterKey);
    if (length === 0) return;

    const valueStart = afterKey + bytesRead;
    if (valueStart + length > klvData.length) return;

    const klvValue = klvData.slice(valueStart, valueStart + length);
    const parsed = this._parseKLV(klvValue);

    // Calculate time
    if (pts !== null) {
      if (this.startPTS === null) this.startPTS = pts;
      parsed.relativeTimeMs = Math.floor((pts - this.startPTS) / 90); // PTS is 90kHz
    } else {
      parsed.relativeTimeMs = this.klvPackets.length * 1000;
    }

    parsed.pid = pid;
    this.klvPackets.push(parsed);
  }

  _parseBER(buffer, offset) {
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

  _parseKLV(data) {
    const result = {};
    let offset = 0;

    while (offset < data.length - 2) {
      const tag = data[offset++];
      const { length: len, bytesRead } = this._parseBER(data, offset);
      offset += bytesRead;
      if (offset + len > data.length) break;

      const value = data.slice(offset, offset + len);
      offset += len;

      switch (tag) {
        case 2: // Timestamp
          if (len === 8) {
            const high = value.readUInt32BE(0);
            const low = value.readUInt32BE(4);
            result.timestamp = (high * 0x100000000 + low) / 1000;
          }
          break;
        case 5: // Platform heading
          if (len === 2) result.platformHeading = (value.readUInt16BE(0) / 0xFFFF) * 360;
          break;
        case 6: // Platform pitch
          if (len === 2) result.platformPitch = (value.readInt16BE(0) / 0x7FFF) * 20;
          break;
        case 7: // Platform roll
          if (len === 2) result.platformRoll = (value.readInt16BE(0) / 0x7FFF) * 50;
          break;
        case 13: // Sensor lat
          if (len === 4) result.sensorLatitude = (value.readInt32BE(0) / 0x7FFFFFFF) * 90;
          break;
        case 14: // Sensor lon
          if (len === 4) result.sensorLongitude = (value.readInt32BE(0) / 0x7FFFFFFF) * 180;
          break;
        case 15: // Sensor alt
          if (len === 2) result.sensorAltitude = (value.readUInt16BE(0) / 0xFFFF) * 19900 - 900;
          break;
        case 23: // Frame center lat
          if (len === 4) result.frameCenterLat = (value.readInt32BE(0) / 0x7FFFFFFF) * 90;
          break;
        case 24: // Frame center lon
          if (len === 4) result.frameCenterLon = (value.readInt32BE(0) / 0x7FFFFFFF) * 180;
          break;
        case 25: // Frame center elev
          if (len === 2) result.frameCenterElev = (value.readUInt16BE(0) / 0xFFFF) * 19900 - 900;
          break;
      }
    }

    return result;
  }
}

// Main
async function main() {
  const videos = ['Cheyenne', 'Falls', 'Truck'];
  const samplesDir = join(__dirname, '../samples/normalized');
  const demoDir = join(__dirname, '../demo-assets');

  for (const video of videos) {
    console.log(`\n=== Processing ${video} ===`);
    const extractor = new TSKLVExtractor();
    const tsPath = join(samplesDir, `${video}.ts`);

    try {
      const packets = await extractor.extractFromFile(tsPath);
      console.log(`Extracted ${packets.length} KLV packets`);

      if (packets.length > 0) {
        const duration = packets[packets.length - 1].relativeTimeMs;
        const output = {
          source: `${video}.ts`,
          duration,
          packetCount: packets.length,
          packets
        };
        const outputPath = join(demoDir, video, 'klv.json');
        writeFileSync(outputPath, JSON.stringify(output, null, 2));
        console.log(`Saved to ${outputPath}`);
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
  }
}

main();
