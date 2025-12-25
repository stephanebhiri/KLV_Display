import { useState, useEffect, useRef, useCallback } from 'react';
import { Map } from './components/Map';
import { InfoPanel } from './components/InfoPanel';
import './App.css';

// Format raw KLV packet to frontend structure (same as backend/src/parsers/klv.js)
function formatKLV(pkt, sensorName) {
  if (!pkt) return null;

  // Use KLV values directly (same as real backend)
  const azimuth = pkt.sensorRelativeAzimuth;
  const elevation = pkt.sensorRelativeElevation;
  const slantRange = pkt.slantRange;

  // Build image corners if available (for FOV polygon)
  let imageCorners = null;
  if (pkt.offsetCornerLat1 !== undefined && pkt.frameCenterLat) {
    imageCorners = [
      { lat: pkt.frameCenterLat + pkt.offsetCornerLat1, lon: pkt.frameCenterLon + pkt.offsetCornerLon1 },
      { lat: pkt.frameCenterLat + pkt.offsetCornerLat2, lon: pkt.frameCenterLon + pkt.offsetCornerLon2 },
      { lat: pkt.frameCenterLat + pkt.offsetCornerLat3, lon: pkt.frameCenterLon + pkt.offsetCornerLon3 },
      { lat: pkt.frameCenterLat + pkt.offsetCornerLat4, lon: pkt.frameCenterLon + pkt.offsetCornerLon4 }
    ];
  }

  return {
    sensor: {
      latitude: pkt.sensorLatitude,
      longitude: pkt.sensorLongitude,
      altitudeM: pkt.sensorAltitude,
      azimuth: azimuth,
      elevation: elevation,
      roll: pkt.sensorRelativeRoll,
      hfov: pkt.horizontalFOV,
      vfov: pkt.verticalFOV,
      name: pkt.imageSourceSensor
    },
    platform: {
      heading: pkt.platformHeading,
      pitch: pkt.platformPitch,
      roll: pkt.platformRoll,
      groundSpeed: pkt.platformGroundSpeed,
      trueAirspeed: pkt.platformTrueAirspeed,
      indicatedAirspeed: pkt.platformIndicatedAirspeed,
      designation: pkt.platformDesignation,
      tailNumber: pkt.platformTailNumber
    },
    target: {
      latitude: pkt.frameCenterLat,
      longitude: pkt.frameCenterLon,
      elevationM: pkt.frameCenterElev,
      slantRangeM: Math.round(slantRange || 0),
      groundRange: pkt.groundRange,
      width: pkt.targetWidth
    },
    mission: {
      platformDesignation: pkt.platformDesignation || 'Unknown',
      id: pkt.missionId || `DEMO-${sensorName?.toUpperCase() || 'UNKNOWN'}`,
      tailNumber: pkt.platformTailNumber
    },
    imageCorners: imageCorners,
    timestamp: pkt.timestamp,
    _sensorName: sensorName
  };
}

// Demo Video Player with time sync callback (60fps via requestAnimationFrame)
function DemoVideoPlayer({ src, onTimeUpdate, onPlay, onPause }) {
  const videoRef = useRef(null);
  const rafRef = useRef(null);
  const isPlayingRef = useRef(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // 60fps time sync loop
    const syncLoop = () => {
      if (isPlayingRef.current && video && !video.paused) {
        onTimeUpdate?.(video.currentTime * 1000);
      }
      rafRef.current = requestAnimationFrame(syncLoop);
    };

    const handlePlay = () => {
      isPlayingRef.current = true;
      onPlay?.();
      rafRef.current = requestAnimationFrame(syncLoop);
    };

    const handlePause = () => {
      isPlayingRef.current = false;
      onPause?.();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);

    // Start loop if already playing
    if (!video.paused) {
      isPlayingRef.current = true;
      rafRef.current = requestAnimationFrame(syncLoop);
    }

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [onTimeUpdate, onPlay, onPause]);

  return (
    <div className="video-container">
      <video
        ref={videoRef}
        src={src}
        controls
        autoPlay
        muted
        playsInline
        style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
      />
    </div>
  );
}

// Demo Selector Panel
function DemoSelector({ demos, currentDemo, onSelect, isPlaying }) {
  return (
    <div className="simulator-panel">
      <div className="simulator-header">
        <span>SAMPLE STREAMS</span>
        {isPlaying && <span className="live-badge">ACTIVE</span>}
      </div>
      <div className="simulator-files">
        {demos.map(demo => (
          <button
            key={demo.id}
            className={`${currentDemo?.id === demo.id ? 'active' : ''}`}
            onClick={() => onSelect(demo)}
          >
            {demo.name}
            {demo.hasKLV && <span style={{ marginLeft: '8px', opacity: 0.7 }}>• KLV</span>}
            {demo.dualSensor && <span style={{ marginLeft: '4px', color: '#8b5cf6' }}>• MULTI</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

// System Capabilities Panel
function SystemCapabilities({ currentDemo, isDualSensor, sensorCount }) {
  return (
    <div className="simulator-panel" style={{ fontSize: '11px', fontFamily: 'monospace' }}>
      <div className="simulator-header">
        <span>SYSTEM CAPABILITIES</span>
      </div>
      <div style={{ padding: '8px 12px', lineHeight: '1.6' }}>
        <div style={{ color: '#6b7280', marginBottom: '8px', borderBottom: '1px solid #374151', paddingBottom: '6px' }}>
          LIVE MODE FEATURES
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '10px 1fr', gap: '2px 8px', marginBottom: '12px' }}>
          <span style={{ color: '#22c55e' }}>■</span><span>UDP/RTP Real-Time Ingest</span>
          <span style={{ color: '#22c55e' }}>■</span><span>STANAG 4609 MPEG-TS Demux</span>
          <span style={{ color: '#22c55e' }}>■</span><span>MISB ST 0601 KLV Parsing</span>
          <span style={{ color: '#22c55e' }}>■</span><span>Multi-Sensor Detection & Display</span>
          <span style={{ color: '#22c55e' }}>■</span><span>WebRTC Ultra-Low Latency (&lt;200ms)</span>
          <span style={{ color: '#22c55e' }}>■</span><span>Auto Stream Lock & Recovery</span>
        </div>

        <div style={{ color: '#6b7280', marginBottom: '8px', borderBottom: '1px solid #374151', paddingBottom: '6px' }}>
          CURRENT SESSION
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: '2px 8px' }}>
          <span style={{ color: '#9ca3af' }}>Mode:</span>
          <span>DEMO / Pre-recorded</span>
          <span style={{ color: '#9ca3af' }}>Stream:</span>
          <span>{currentDemo?.name || '—'}</span>
          <span style={{ color: '#9ca3af' }}>Sensors:</span>
          <span>{isDualSensor ? `${sensorCount} Active` : sensorCount > 0 ? '1 Active' : '—'}</span>
          <span style={{ color: '#9ca3af' }}>Protocol:</span>
          <span>HTTP Progressive</span>
        </div>

        <div style={{ marginTop: '12px', padding: '8px', background: '#1f2937', borderRadius: '4px', color: '#9ca3af', fontSize: '10px' }}>
          <div style={{ color: '#f59e0b', marginBottom: '4px' }}>ℹ DEMO MODE</div>
          This demonstration uses pre-recorded STANAG 4609 streams.
          Full system supports real-time UDP ingest on configurable ports with automatic
          codec detection (H.264/H.265/MPEG-2) and hardware-accelerated transcoding.
        </div>
      </div>
    </div>
  );
}

function DemoApp() {
  const [demos, setDemos] = useState([]);
  const [currentDemo, setCurrentDemo] = useState(null);
  const [klvData, setKlvData] = useState(null);
  const [sensors, setSensors] = useState({});
  const [isPlaying, setIsPlaying] = useState(false);
  const [ptsOffsetMs, setPtsOffsetMs] = useState(0);

  // Multi-sensor support
  const [isDualSensor, setIsDualSensor] = useState(false);
  const [sensorPackets, setSensorPackets] = useState({}); // { sensorId: packets[] }
  const sensorIndices = useRef({}); // { sensorId: currentIndex }

  // Load available demos
  useEffect(() => {
    fetch('/api/demos')
      .then(res => res.json())
      .then(data => {
        setDemos(data.demos || []);
        if (data.demos?.length > 0) {
          selectDemo(data.demos[0]);
        }
      })
      .catch(err => console.error('Failed to load demos:', err));
  }, []);

  // Select a demo
  const selectDemo = async (demo) => {
    setCurrentDemo(demo);
    setKlvData(null);
    setSensors({});
    setSensorPackets({});
    sensorIndices.current = {};
    setPtsOffsetMs(0);
    setIsDualSensor(false);

    if (demo.hasKLV) {
      try {
        const res = await fetch(`/api/demos/${demo.id}/klv`);
        const data = await res.json();
        const offset = data.ptsOffsetMs || 0;
        setPtsOffsetMs(offset);

        // Check for dual sensor format
        if (data.dualSensor && data.sensors) {
          setIsDualSensor(true);
          const newSensorPackets = {};
          const initialSensors = {};

          for (const [sensorId, sensorData] of Object.entries(data.sensors)) {
            newSensorPackets[sensorId] = sensorData.packets || [];
            sensorIndices.current[sensorId] = 0;
            if (sensorData.packets?.length > 0) {
              initialSensors[sensorId] = formatKLV(sensorData.packets[0], sensorId);
            }
          }

          setSensorPackets(newSensorPackets);
          setSensors(initialSensors);
          // Use first sensor as primary klvData
          const firstSensor = Object.values(initialSensors)[0];
          setKlvData(firstSensor);
          console.log(`Loaded dual sensor KLV: ${Object.keys(newSensorPackets).join(', ')}`);
        } else {
          // Single sensor format
          const packets = data.packets || [];
          setSensorPackets({ 'default': packets });
          sensorIndices.current = { 'default': 0 };
          console.log(`Loaded ${packets.length} KLV packets, ptsOffset=${offset}ms`);
          if (packets.length > 0) {
            const formatted = formatKLV(packets[0], demo.name);
            setKlvData(formatted);
            setSensors({ 'default': formatted });
          }
        }
      } catch (err) {
        console.error('Failed to load KLV:', err);
      }
    }
  };

  // Sync KLV with video time (apply PTS offset for accurate sync)
  const handleTimeUpdate = useCallback((timeMs) => {
    const sensorIds = Object.keys(sensorPackets);
    if (sensorIds.length === 0) return;

    // Apply PTS offset: KLV time = video time + offset
    const klvTimeMs = timeMs + ptsOffsetMs;
    let hasChanges = false;
    const newSensors = {};

    // Update each sensor independently
    for (const sensorId of sensorIds) {
      const packets = sensorPackets[sensorId];
      if (!packets || packets.length === 0) continue;

      let idx = sensorIndices.current[sensorId] || 0;

      // Move forward
      while (idx < packets.length - 1 && packets[idx + 1].relativeTimeMs <= klvTimeMs) {
        idx++;
      }

      // Move back (seek backwards)
      while (idx > 0 && packets[idx].relativeTimeMs > klvTimeMs) {
        idx--;
      }

      if (idx !== sensorIndices.current[sensorId]) {
        hasChanges = true;
        sensorIndices.current[sensorId] = idx;
      }

      newSensors[sensorId] = formatKLV(packets[idx], sensorId);
    }

    if (hasChanges) {
      setSensors(newSensors);
      // Use first sensor as primary klvData
      const firstSensor = Object.values(newSensors)[0];
      setKlvData(firstSensor);
    }
  }, [sensorPackets, ptsOffsetMs]);

  // Status object for InfoPanel
  const status = {
    streaming: isPlaying,
    source: currentDemo ? `Demo: ${currentDemo.name}` : null,
    mode: 'demo'
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>STANAG 4609 / MISB ST 0601 — Metadata Viewer</h1>
        <div className="controls">
          <span className="demo-badge">DEMONSTRATION</span>
          {currentDemo && (
            <span className="source-info" style={{ fontFamily: 'monospace', fontSize: '12px' }}>
              SRC: {currentDemo.name.toUpperCase()} |
              SENSORS: {isDualSensor ? Object.keys(sensors).length : Object.keys(sensors).length > 0 ? 1 : 0} |
              STATUS: {isPlaying ? 'STREAMING' : 'STANDBY'}
            </span>
          )}
        </div>
      </header>

      <main className="app-main">
        <div className="left-panel">
          {currentDemo && (
            <DemoVideoPlayer
              src={currentDemo.videoUrl}
              onTimeUpdate={handleTimeUpdate}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />
          )}
          <Map klvData={klvData} sensors={sensors} />
        </div>
        <div className="right-panel">
          <InfoPanel
            klvData={klvData}
            sensors={sensors}
            status={status}
            isConnected={true}
          />
          <DemoSelector
            demos={demos}
            currentDemo={currentDemo}
            onSelect={selectDemo}
            isPlaying={isPlaying}
          />
          <SystemCapabilities
            currentDemo={currentDemo}
            isDualSensor={isDualSensor}
            sensorCount={Object.keys(sensors).length}
          />
        </div>
      </main>
    </div>
  );
}

export default DemoApp;
