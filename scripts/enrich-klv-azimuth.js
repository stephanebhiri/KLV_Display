#!/usr/bin/env node
/**
 * One-time migration: add sensorRelativeAzimuth (MISB tag 18) and slantRange
 * (tag 21) to demo klv.json files that lost them during extraction
 * (extract-klv-demo.js had a single-byte BER length reader that dropped
 * every tag from 18 onward).
 *
 * Both fields are derived from sensor -> frame center geometry, which the
 * surviving tags fully determine. Existing values are never overwritten.
 *
 * Usage: node scripts/enrich-klv-azimuth.js demo-assets/Cheyenne/klv.json [...]
 */
import { readFileSync, writeFileSync } from 'fs';

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

function enrichPacket(pkt) {
  const hasGeometry = [pkt.sensorLatitude, pkt.sensorLongitude, pkt.frameCenterLat, pkt.frameCenterLon]
    .every((v) => typeof v === 'number' && isFinite(v));
  if (!hasGeometry) return false;
  let changed = false;
  if (typeof pkt.sensorRelativeAzimuth !== 'number') {
    const bearing = bearingDeg(pkt.sensorLatitude, pkt.sensorLongitude, pkt.frameCenterLat, pkt.frameCenterLon);
    pkt.sensorRelativeAzimuth = (bearing - (pkt.platformHeading || 0) + 360) % 360;
    changed = true;
  }
  if (typeof pkt.slantRange !== 'number') {
    const ground = groundDistanceM(pkt.sensorLatitude, pkt.sensorLongitude, pkt.frameCenterLat, pkt.frameCenterLon);
    const dAlt = (pkt.sensorAltitude ?? 0) - (pkt.frameCenterElev ?? 0);
    pkt.slantRange = Math.round(Math.sqrt(ground * ground + dAlt * dAlt) * 10) / 10;
    changed = true;
  }
  return changed;
}

for (const file of process.argv.slice(2)) {
  const data = JSON.parse(readFileSync(file, 'utf-8'));
  const packetLists = data.dualSensor && data.sensors
    ? Object.values(data.sensors).map((s) => s.packets || [])
    : [data.packets || []];
  let enriched = 0;
  for (const packets of packetLists) {
    for (const pkt of packets) if (enrichPacket(pkt)) enriched++;
  }
  if (enriched > 0) {
    writeFileSync(file, JSON.stringify(data));
    console.log(`${file}: enriched ${enriched} packets`);
  } else {
    console.log(`${file}: nothing to do`);
  }
}
