/**
 * KLV Display Demo Server
 * Lightweight server for pre-encoded video streaming
 * No real-time decoding - video served directly, KLV synced via WebSocket
 */
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

// Demo assets
const ASSETS_DIR = join(__dirname, '../demo-assets');
const FRONTEND_DIR = join(__dirname, '../frontend/dist');

// Available demos
const DEMOS = {
  cheyenne: { name: 'Cheyenne', folder: 'Cheyenne', hasKLV: true },
  falls: { name: 'Falls', folder: 'Falls', hasKLV: true, dualSensor: true },
  truck: { name: 'Truck', folder: 'Truck', hasKLV: true }
};

// Normalize dual-sensor klv.json ({ sensors: { name: { packets } } })
// into the flat { duration, packetCount, packets } shape used by the
// WebSocket streaming path, tagging each packet with its sensor.
// The HTTP API keeps serving the raw shape (the client-sync frontend
// handles dualSensor itself).
function normalizeKLV(raw) {
  if (!raw.dualSensor || !raw.sensors) return raw;
  const packets = [];
  for (const [sensorKey, sensor] of Object.entries(raw.sensors)) {
    for (const p of sensor.packets || []) {
      packets.push({ ...p, _sensor: p.imageSourceSensor || sensorKey });
    }
  }
  packets.sort((a, b) => a.relativeTimeMs - b.relativeTimeMs);
  return {
    source: raw.source,
    duration: packets.length ? packets[packets.length - 1].relativeTimeMs : 0,
    packetCount: packets.length,
    packets
  };
}

// Load KLV data: klvRaw served over HTTP, klvData (flat) streamed over WS
const klvRaw = {};
const klvData = {};
for (const [id, demo] of Object.entries(DEMOS)) {
  const klvPath = join(ASSETS_DIR, demo.folder, 'klv.json');
  if (existsSync(klvPath)) {
    try {
      const raw = JSON.parse(readFileSync(klvPath, 'utf-8'));
      const flat = normalizeKLV(raw);
      if (flat.packets?.length) {
        klvRaw[id] = raw;
        klvData[id] = flat;
        console.log(`Loaded ${flat.packetCount} KLV packets for ${demo.name}${raw.dualSensor ? ` (dual sensor: ${Object.keys(raw.sensors).join(', ')})` : ''}`);
      } else {
        console.log(`No KLV packets for ${demo.name}`);
      }
    } catch (err) {
      console.log(`No KLV for ${demo.name}`);
    }
  }
  demo.hasKLV = Boolean(klvData[id]?.packets?.length);
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Serve React demo frontend
const DEMO_FRONTEND_DIR = join(__dirname, '../frontend/dist-demo');
app.use(express.static(DEMO_FRONTEND_DIR));

// Serve demo assets (video files)
app.use('/demo', express.static(ASSETS_DIR));

// API: list available demos
app.get('/api/demos', (req, res) => {
  const demos = Object.entries(DEMOS).map(([id, demo]) => ({
    id,
    name: demo.name,
    hasKLV: demo.hasKLV,
    dualSensor: demo.dualSensor || false,
    videoUrl: `/demo/${demo.folder}/video.webm`,
    duration: klvData[id]?.duration || 0
  }));
  res.json({ demos });
});

// API: get KLV data for a demo (raw shape, incl. dualSensor structure)
app.get('/api/demos/:id/klv', (req, res) => {
  const { id } = req.params;
  if (!klvRaw[id]) {
    return res.status(404).json({ error: 'KLV not found' });
  }
  res.json(klvRaw[id]);
});

// API: status
app.get('/api/status', (req, res) => {
  res.json({
    mode: 'demo',
    streaming: false,
    clients: wss.clients.size,
    demos: Object.keys(DEMOS)
  });
});

// Geometry helpers (sensor -> frame center)
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;
const EARTH_RADIUS_M = 6371000;

function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1), p2 = toRad(lat2), dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function groundDistanceM(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1), p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1), dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// Format KLV packet for frontend (structured format).
// Prefers native MISB fields (tag 18 azimuth, tag 21 slant range); falls
// back to sensor -> frame center geometry when an older klv.json lacks them.
function formatKLVForFrontend(pkt, sensorName) {
  let relativeAzimuth = 0;
  let slantRangeM = 1500;
  const hasGeometry = [pkt.sensorLatitude, pkt.sensorLongitude, pkt.frameCenterLat, pkt.frameCenterLon]
    .every((v) => typeof v === 'number' && isFinite(v));
  if (typeof pkt.sensorRelativeAzimuth === 'number') {
    relativeAzimuth = pkt.sensorRelativeAzimuth;
    if (typeof pkt.slantRange === 'number') slantRangeM = Math.round(pkt.slantRange);
  } else if (hasGeometry) {
    const bearing = bearingDeg(pkt.sensorLatitude, pkt.sensorLongitude, pkt.frameCenterLat, pkt.frameCenterLon);
    relativeAzimuth = (bearing - (pkt.platformHeading || 0) + 360) % 360;
    const ground = groundDistanceM(pkt.sensorLatitude, pkt.sensorLongitude, pkt.frameCenterLat, pkt.frameCenterLon);
    const dAlt = (pkt.sensorAltitude ?? 0) - (pkt.frameCenterElev ?? 0);
    slantRangeM = Math.round(Math.sqrt(ground * ground + dAlt * dAlt));
  }

  return {
    sensor: {
      latitude: pkt.sensorLatitude,
      longitude: pkt.sensorLongitude,
      altitude: pkt.sensorAltitude,
      azimuth: relativeAzimuth, // Relative to platform heading
      hfov: pkt.horizontalFOV,
      vfov: pkt.verticalFOV
    },
    platform: {
      heading: pkt.platformHeading,
      pitch: pkt.platformPitch,
      roll: pkt.platformRoll
    },
    target: {
      latitude: pkt.frameCenterLat,
      longitude: pkt.frameCenterLon,
      elevation: pkt.frameCenterElev,
      slantRangeM
    },
    unixTimestamp: typeof pkt.timestamp === 'number' ? pkt.timestamp / 1000 : null,
    _sensorName: sensorName
  };
}

// Active KLV streams per client
const clientStreams = new Map();

// WebSocket for KLV streaming
wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substring(2, 10);
  console.log('Client connected:', clientId);

  clientStreams.set(clientId, { ws, interval: null, demo: null, index: 0, startTime: null });

  // Send initial status
  ws.send(JSON.stringify({
    type: 'status',
    clientId,
    streaming: false,
    source: null,
    mode: 'demo'
  }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const client = clientStreams.get(clientId);

      if (msg.type === 'start-klv') {
        const demoId = msg.demoId;
        const demoInfo = DEMOS[demoId];
        const klv = klvData[demoId];

        if (!klv || !klv.packets.length) {
          ws.send(JSON.stringify({ type: 'error', message: 'No KLV data' }));
          return;
        }

        // Stop previous stream
        if (client.interval) clearInterval(client.interval);

        client.demo = klv;
        client.demoName = demoInfo?.name || demoId;
        client.index = 0;
        client.startTime = Date.now();

        console.log(`Starting KLV stream for ${demoId} (${klv.packetCount} packets)`);

        // Send stream started
        ws.send(JSON.stringify({
          type: 'stream-started',
          source: `Demo: ${client.demoName}`,
          mode: 'demo'
        }));

        // Send KLV packets synced to video time
        client.interval = setInterval(() => {
          if (!client.demo || client.index >= client.demo.packets.length) {
            // Loop back
            client.index = 0;
            client.startTime = Date.now();
            return;
          }

          const elapsed = Date.now() - client.startTime;

          // Send all packets up to current time
          while (client.index < client.demo.packets.length &&
                 client.demo.packets[client.index].relativeTimeMs <= elapsed) {
            const pkt = client.demo.packets[client.index];
            const sensorLabel = pkt._sensor || client.demoName;
            ws.send(JSON.stringify({
              type: 'klv',
              sensorId: pkt._sensor || 'demo-sensor',
              sensorName: sensorLabel,
              data: formatKLVForFrontend(pkt, sensorLabel)
            }));
            client.index++;
          }
        }, 100);
      }

      if (msg.type === 'stop-klv' || msg.type === 'stop') {
        if (client.interval) clearInterval(client.interval);
        client.demo = null;
        ws.send(JSON.stringify({ type: 'stream-stopped' }));
        console.log('KLV stream stopped');
      }

      if (msg.type === 'seek') {
        const seekTimeMs = msg.timeMs || 0;
        if (client.demo) {
          client.startTime = Date.now() - seekTimeMs;
          client.index = client.demo.packets.findIndex(p => p.relativeTimeMs >= seekTimeMs);
          if (client.index === -1) client.index = 0;
          console.log(`Seeked to ${seekTimeMs}ms, index ${client.index}`);
        }
      }
    } catch (err) {
      console.error('WS message error:', err.message);
    }
  });

  ws.on('close', () => {
    const client = clientStreams.get(clientId);
    if (client?.interval) clearInterval(client.interval);
    clientStreams.delete(clientId);
    console.log('Client disconnected:', clientId);
  });
});

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║           KLV Display - DEMO Mode                      ║
║   Pre-encoded video streaming (no real-time decode)   ║
╠════════════════════════════════════════════════════════╣
║   Server: http://localhost:${PORT}                       ║
║   Available demos:                                     ║
║   - Cheyenne (with KLV)                               ║
║   - Falls (Dual Sensor KLV)                           ║
║   - Truck (with KLV)                                  ║
╚════════════════════════════════════════════════════════╝
  `);
});
