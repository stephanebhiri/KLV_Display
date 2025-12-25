/**
 * KLV Display - Demo Server
 * VP8 File → WebRTC (no encoding)
 * KLV File → WebSocket (synced)
 */
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const ASSETS_DIR = join(__dirname, '../demo-assets');
const FRONTEND_DIR = join(__dirname, '../frontend/dist');

// Demo videos configuration
const DEMOS = {
  cheyenne: { id: 'cheyenne', name: 'Cheyenne', folder: 'Cheyenne', hasKLV: true },
  falls: { id: 'falls', name: 'Falls', folder: 'Falls', hasKLV: false },
  truck: { id: 'truck', name: 'Truck', folder: 'Truck', hasKLV: true }
};

// Load KLV data
const klvData = {};
for (const [id, demo] of Object.entries(DEMOS)) {
  const klvPath = join(ASSETS_DIR, demo.folder, 'klv.json');
  if (existsSync(klvPath)) {
    try {
      klvData[id] = JSON.parse(readFileSync(klvPath, 'utf-8'));
      console.log(`[KLV] Loaded ${klvData[id].packetCount} packets for ${demo.name}`);
    } catch (err) {
      console.log(`[KLV] No data for ${demo.name}`);
    }
  }
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Demo streamer process
let streamerProcess = null;
let currentDemo = null;

// Client state
const clients = new Map();

// Express middleware
app.use(express.json());
app.use(express.static(join(__dirname, 'public'))); // Standalone demo page
app.use(express.static(FRONTEND_DIR)); // React app if built
app.use('/demo', express.static(ASSETS_DIR));

// API: List demos (both endpoints for compatibility)
app.get('/api/simulator/files', (req, res) => {
  const files = Object.values(DEMOS).map(demo => ({
    id: demo.id,
    name: demo.name,
    file: join(ASSETS_DIR, demo.folder, 'video.webm'),
    codec: 'vp8',
    hasKLV: demo.hasKLV
  }));
  res.json({ files });
});

app.get('/api/demos', (req, res) => {
  const demos = Object.values(DEMOS).map(demo => ({
    id: demo.id,
    name: demo.name,
    videoUrl: `/demo/${demo.folder}/video.webm`,
    hasKLV: demo.hasKLV
  }));
  res.json({ demos });
});

app.get('/api/demos/:id/klv', (req, res) => {
  const id = req.params.id;
  const klv = klvData[id];
  if (!klv) {
    return res.json({ packets: [] });
  }
  res.json({ packets: klv.packets });
});

// API: Status
app.get('/api/status', (req, res) => {
  res.json({
    streaming: currentDemo !== null,
    source: currentDemo?.name || null,
    mode: 'demo',
    clients: clients.size,
    webrtcReady: streamerProcess !== null,
    framebufferRunning: true,
    framebufferStats: { framesIn: 30, framesOut: 30, framesRepeated: 0 },
    simulator: { running: currentDemo !== null, codec: 'vp8' }
  });
});

// API: Start demo (like simulator start)
app.post('/api/simulator/start', async (req, res) => {
  const { fileId } = req.body;
  const demo = DEMOS[fileId];

  if (!demo) {
    return res.status(400).json({ error: 'Unknown demo' });
  }

  // Stop current
  stopDemo();

  // Start new
  currentDemo = demo;
  const videoPath = join(ASSETS_DIR, demo.folder, 'video.webm');

  // Start streamer
  startStreamer(videoPath);

  // Notify clients
  broadcast({ type: 'demo-started', demo: demo.name, hasKLV: demo.hasKLV });

  res.json({ success: true, file: demo.name, codec: 'vp8' });
});

// API: Stop
app.post('/api/simulator/stop', (req, res) => {
  stopDemo();
  res.json({ success: true });
});

// API: Start UDP stream (for compatibility)
app.post('/api/stream/udp', (req, res) => {
  // In demo mode, start default demo
  if (!currentDemo) {
    currentDemo = DEMOS.cheyenne;
    const videoPath = join(ASSETS_DIR, currentDemo.folder, 'video.webm');
    startStreamer(videoPath);
  }
  res.json({ success: true, mode: 'demo' });
});

// Start VP8 streamer process
function startStreamer(videoPath) {
  if (streamerProcess) {
    streamerProcess.kill();
  }

  const streamerScript = join(__dirname, '../backend/gstreamer/demo_streamer.py');
  streamerProcess = spawn('python3', [streamerScript, videoPath], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Handle messages from streamer
  streamerProcess.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      try {
        if (line.startsWith('{')) {
          const msg = JSON.parse(line);
          handleStreamerMessage(msg);
        } else {
          console.log('[Streamer]', line);
        }
      } catch (e) {
        console.log('[Streamer]', line);
      }
    }
  });

  streamerProcess.stderr.on('data', (data) => {
    console.error('[Streamer ERR]', data.toString().trim());
  });

  streamerProcess.on('close', (code) => {
    console.log('[Streamer] Exited with code', code);
    streamerProcess = null;
  });

  console.log('[Streamer] Started with', videoPath);
}

// Handle messages from Python streamer
function handleStreamerMessage(msg) {
  const { clientId, type, ...data } = msg;
  const client = clients.get(clientId);
  if (!client) return;

  if (type === 'offer') {
    client.ws.send(JSON.stringify({ type: 'webrtc-offer', sdp: data.sdp }));
  } else if (type === 'ice-candidate') {
    client.ws.send(JSON.stringify({
      type: 'webrtc-ice-candidate',
      candidate: data.candidate,
      sdpMLineIndex: data.sdpMLineIndex
    }));
  }
}

// Send to streamer process
function sendToStreamer(msg) {
  if (streamerProcess && streamerProcess.stdin.writable) {
    streamerProcess.stdin.write(JSON.stringify(msg) + '\n');
  }
}

// Stop demo
function stopDemo() {
  if (streamerProcess) {
    streamerProcess.kill();
    streamerProcess = null;
  }
  currentDemo = null;

  // Stop all KLV intervals
  for (const client of clients.values()) {
    if (client.klvInterval) {
      clearInterval(client.klvInterval);
    }
  }

  broadcast({ type: 'stream-stopped' });
}

// Broadcast to all clients
function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const client of clients.values()) {
    if (client.ws.readyState === 1) {
      client.ws.send(str);
    }
  }
}

// WebSocket handling
wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substring(2, 15);
  console.log('[WS] Client connected:', clientId);

  clients.set(clientId, { ws, klvInterval: null, klvIndex: 0 });

  // Send current status
  ws.send(JSON.stringify({
    type: 'status',
    streaming: currentDemo !== null,
    source: currentDemo?.name || null,
    mode: 'demo'
  }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleClientMessage(clientId, msg);
    } catch (e) {
      console.error('[WS] Parse error:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected:', clientId);
    const client = clients.get(clientId);
    if (client?.klvInterval) {
      clearInterval(client.klvInterval);
    }
    clients.delete(clientId);
    sendToStreamer({ type: 'remove-client', clientId });
  });
});

// Handle client WebSocket messages
function handleClientMessage(clientId, msg) {
  const client = clients.get(clientId);
  if (!client) return;

  switch (msg.type) {
    case 'join-webrtc':
      // Client wants to join WebRTC stream
      sendToStreamer({ type: 'add-client', clientId });
      // Also start KLV streaming
      startKLVStream(clientId);
      break;

    case 'webrtc-answer':
      sendToStreamer({ type: 'answer', clientId, sdp: msg.sdp });
      break;

    case 'webrtc-ice-candidate':
      sendToStreamer({
        type: 'ice-candidate',
        clientId,
        candidate: msg.candidate,
        sdpMLineIndex: msg.sdpMLineIndex
      });
      break;

    case 'start-demo':
      // Start specific demo
      const demo = DEMOS[msg.demoId];
      if (demo) {
        stopDemo();
        currentDemo = demo;
        const videoPath = join(ASSETS_DIR, demo.folder, 'video.webm');
        startStreamer(videoPath);
      }
      break;
  }
}

// Start KLV streaming for a client
function startKLVStream(clientId) {
  const client = clients.get(clientId);
  if (!client || !currentDemo) return;

  const klv = klvData[currentDemo.id];
  if (!klv || !klv.packets.length) return;

  // Clear existing interval
  if (client.klvInterval) {
    clearInterval(client.klvInterval);
  }

  client.klvIndex = 0;
  const startTime = Date.now();

  // Stream KLV packets in sync with video time
  client.klvInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;

    // Send all packets up to current time
    while (client.klvIndex < klv.packets.length &&
           klv.packets[client.klvIndex].relativeTimeMs <= elapsed) {
      const pkt = klv.packets[client.klvIndex];

      client.ws.send(JSON.stringify({
        type: 'klv',
        sensorId: 'demo',
        sensorName: currentDemo.name,
        data: formatKLV(pkt)
      }));

      client.klvIndex++;
    }

    // Loop back if finished
    if (client.klvIndex >= klv.packets.length) {
      client.klvIndex = 0;
      client.startTime = Date.now();
    }
  }, 100);
}

// Format KLV for frontend
function formatKLV(pkt) {
  return {
    sensorLatitude: pkt.sensorLatitude || pkt.frameCenterLat,
    sensorLongitude: pkt.sensorLongitude || pkt.frameCenterLon,
    sensorAltitude: pkt.sensorAltitude,
    platformHeading: pkt.platformHeading,
    platformPitch: pkt.platformPitch,
    platformRoll: pkt.platformRoll,
    horizontalFOV: pkt.horizontalFOV,
    verticalFOV: pkt.verticalFOV,
    frameCenterLatitude: pkt.frameCenterLat,
    frameCenterLongitude: pkt.frameCenterLon,
    frameCenterElevation: pkt.frameCenterElev,
    timestamp: pkt.timestamp
  };
}

// Start server
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║          KLV Display - DEMO Server                       ║
║   VP8 Passthrough → WebRTC (no encoding!)               ║
╠══════════════════════════════════════════════════════════╣
║   http://localhost:${PORT}                                  ║
║                                                          ║
║   Demos: Cheyenne (KLV), Falls, Truck (KLV)             ║
║   Total size: ~26 MB                                     ║
╚══════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  stopDemo();
  process.exit(0);
});
