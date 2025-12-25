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

// Load KLV data
const klvData = {};
for (const [id, demo] of Object.entries(DEMOS)) {
  const klvPath = join(ASSETS_DIR, demo.folder, 'klv.json');
  if (existsSync(klvPath)) {
    try {
      klvData[id] = JSON.parse(readFileSync(klvPath, 'utf-8'));
      if (klvData[id].dualSensor) {
        const sensorNames = Object.keys(klvData[id].sensors);
        console.log(`Loaded dual sensor KLV for ${demo.name}: ${sensorNames.join(', ')}`);
      } else {
        console.log(`Loaded ${klvData[id].packetCount || klvData[id].packets?.length} KLV packets for ${demo.name}`);
      }
    } catch (err) {
      console.log(`No KLV for ${demo.name}`);
    }
  }
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

// API: get KLV data for a demo
app.get('/api/demos/:id/klv', (req, res) => {
  const { id } = req.params;
  if (!klvData[id]) {
    return res.status(404).json({ error: 'KLV not found' });
  }
  res.json(klvData[id]);
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

// Format KLV packet for frontend (structured format)
function formatKLVForFrontend(pkt, sensorName) {
  return {
    sensor: {
      latitude: pkt.sensorLatitude,
      longitude: pkt.sensorLongitude,
      altitude: pkt.sensorAltitude,
      azimuth: 0, // Relative azimuth (0 = forward)
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
      slantRangeM: 1500 // Estimated slant range
    },
    unixTimestamp: pkt.timestamp / 1000,
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
            ws.send(JSON.stringify({
              type: 'klv',
              sensorId: 'demo-sensor',
              sensorName: client.demoName,
              data: formatKLVForFrontend(pkt, client.demoName)
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
