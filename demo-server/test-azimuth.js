/**
 * Verifies that the FOV cone direction sent over WS matches the
 * sensor->frame-center bearing implied by the KLV data.
 * Frontend draws the cone at (platform.heading + sensor.azimuth).
 */
import WebSocket from 'ws';

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1), p2 = toRad(lat2), dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const angleDiff = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

const demoId = process.argv[2] || 'cheyenne';
const ws = new WebSocket('ws://127.0.0.1:3001');
const samples = [];

ws.on('open', () => ws.send(JSON.stringify({ type: 'start-klv', demoId })));

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type !== 'klv') return;
  const d = msg.data;
  if (d.target?.latitude == null) return;
  samples.push(d);
  if (samples.length < 10) return;

  ws.close();
  // Real MISB data: measured azimuth (tag 18) and geolocated frame center
  // legitimately disagree by a few degrees (terrain model, timing). 5 degrees
  // still catches orientation bugs (a dropped azimuth is off by ~90) without
  // flagging genuine sensor/geolocation noise.
  const TOLERANCE_DEG = 5;
  let failures = 0;
  for (const s of samples) {
    const expected = bearingDeg(s.sensor.latitude, s.sensor.longitude, s.target.latitude, s.target.longitude);
    const coneDir = ((s.platform.heading || 0) + (s.sensor.azimuth || 0) + 360) % 360;
    const err = angleDiff(coneDir, expected);
    if (err > TOLERANCE_DEG) failures++;
    console.log(`cone=${coneDir.toFixed(1)}° expected=${expected.toFixed(1)}° err=${err.toFixed(1)}° slant=${s.target.slantRangeM}m`);
  }
  console.log(failures === 0 ? 'PASS' : `FAIL (${failures}/${samples.length} packets off by >${TOLERANCE_DEG}°)`);
  process.exit(failures === 0 ? 0 : 1);
});

setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 15000);
