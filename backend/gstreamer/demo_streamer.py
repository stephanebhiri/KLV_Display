#!/usr/bin/env python3
"""
Demo VP8 File Streamer
Reads pre-encoded VP8 WebM file and streams via WebRTC
No encoding - just passthrough for minimal CPU usage
"""
import sys
import json
import asyncio
import signal
from pathlib import Path

# GStreamer imports
import gi
gi.require_version('Gst', '1.0')
gi.require_version('GstWebRTC', '1.0')
from gi.repository import Gst, GstWebRTC, GLib

Gst.init(None)

class DemoStreamer:
    def __init__(self, video_path: str, ipc_path: str = '/tmp/demo-webrtc.sock'):
        self.video_path = video_path
        self.ipc_path = ipc_path
        self.pipeline = None
        self.loop = None
        self.clients = {}  # client_id -> webrtcbin
        self.running = False

    def _log(self, msg):
        print(f"[DemoStreamer] {msg}", flush=True)

    def create_pipeline(self):
        """Create GStreamer pipeline for VP8 file to WebRTC"""
        # Pipeline: filesrc -> demux -> VP8 payloader -> WebRTC
        # No decoding/encoding - VP8 passthrough!
        pipeline_str = f'''
            filesrc location="{self.video_path}" !
            matroskademux name=demux !
            queue !
            rtpvp8pay pt=96 !
            tee name=t allow-not-linked=true
        '''

        self.pipeline = Gst.parse_launch(pipeline_str)
        self.tee = self.pipeline.get_by_name('t')

        # Add bus watch
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect('message', self._on_bus_message)

        self._log(f"Pipeline created for {self.video_path}")

    def _on_bus_message(self, bus, message):
        t = message.type
        if t == Gst.MessageType.ERROR:
            err, debug = message.parse_error()
            self._log(f"Error: {err.message}")
            self._log(f"Debug: {debug}")
        elif t == Gst.MessageType.EOS:
            self._log("End of stream - looping...")
            # Seek to beginning for loop
            self.pipeline.seek_simple(
                Gst.Format.TIME,
                Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT,
                0
            )
        elif t == Gst.MessageType.STATE_CHANGED:
            if message.src == self.pipeline:
                old, new, pending = message.parse_state_changed()
                self._log(f"State: {old.value_nick} -> {new.value_nick}")

    def add_client(self, client_id: str):
        """Add a new WebRTC client"""
        self._log(f"Adding client {client_id}")

        # Create webrtcbin for this client
        webrtcbin = Gst.ElementFactory.make('webrtcbin', f'webrtc-{client_id}')
        webrtcbin.set_property('bundle-policy', 3)  # max-bundle
        webrtcbin.set_property('stun-server', 'stun://stun.l.google.com:19302')

        # Add TURN server for NAT traversal (configure via TURN_URL env var)
        turn_url = os.environ.get("TURN_URL")
        if turn_url:
            webrtcbin.emit("add-turn-server", turn_url)

        # Connect signals
        webrtcbin.connect('on-negotiation-needed', self._on_negotiation_needed, client_id)
        webrtcbin.connect('on-ice-candidate', self._on_ice_candidate, client_id)
        webrtcbin.connect('notify::ice-connection-state', self._on_ice_state, client_id)

        # Add to pipeline
        self.pipeline.add(webrtcbin)

        # Link tee to webrtcbin
        tee_pad = self.tee.get_request_pad('src_%u')
        queue = Gst.ElementFactory.make('queue', f'queue-{client_id}')
        self.pipeline.add(queue)
        queue.sync_state_with_parent()

        tee_pad.link(queue.get_static_pad('sink'))
        queue.get_static_pad('src').link(webrtcbin.get_request_pad('sink_0'))

        webrtcbin.sync_state_with_parent()

        self.clients[client_id] = {
            'webrtcbin': webrtcbin,
            'queue': queue,
            'tee_pad': tee_pad
        }

    def _on_negotiation_needed(self, webrtcbin, client_id):
        """Create and send offer"""
        self._log(f"Creating offer for {client_id}")
        promise = Gst.Promise.new_with_change_func(
            self._on_offer_created, webrtcbin, client_id
        )
        webrtcbin.emit('create-offer', None, promise)

    def _on_offer_created(self, promise, webrtcbin, client_id):
        reply = promise.get_reply()
        offer = reply.get_value('offer')
        webrtcbin.emit('set-local-description', offer, None)

        sdp_text = offer.sdp.as_text()
        self._send_to_client(client_id, {
            'type': 'offer',
            'sdp': sdp_text
        })

    def _on_ice_candidate(self, webrtcbin, mline_index, candidate, client_id):
        self._send_to_client(client_id, {
            'type': 'ice-candidate',
            'candidate': candidate,
            'sdpMLineIndex': mline_index
        })

    def _on_ice_state(self, webrtcbin, pspec, client_id):
        state = webrtcbin.get_property('ice-connection-state')
        self._log(f"ICE state for {client_id}: {state}")

    def set_remote_description(self, client_id: str, sdp: str, sdp_type: str):
        """Set answer from browser"""
        if client_id not in self.clients:
            return

        webrtcbin = self.clients[client_id]['webrtcbin']
        sdp_msg = GstWebRTC.WebRTCSessionDescription.new(
            GstWebRTC.WebRTCSDPType.ANSWER,
            Gst.sdp_message_new_from_text(sdp)[1]
        )
        webrtcbin.emit('set-remote-description', sdp_msg, None)

    def add_ice_candidate(self, client_id: str, candidate: str, mline_index: int):
        """Add ICE candidate from browser"""
        if client_id not in self.clients:
            return
        webrtcbin = self.clients[client_id]['webrtcbin']
        webrtcbin.emit('add-ice-candidate', mline_index, candidate)

    def remove_client(self, client_id: str):
        """Remove a WebRTC client"""
        if client_id not in self.clients:
            return

        client = self.clients.pop(client_id)
        # Cleanup elements
        client['webrtcbin'].set_state(Gst.State.NULL)
        client['queue'].set_state(Gst.State.NULL)
        self.tee.release_request_pad(client['tee_pad'])
        self.pipeline.remove(client['webrtcbin'])
        self.pipeline.remove(client['queue'])

        self._log(f"Removed client {client_id}")

    def _send_to_client(self, client_id: str, message: dict):
        """Send message to Node.js via stdout"""
        msg = {'clientId': client_id, **message}
        print(json.dumps(msg), flush=True)

    def start(self):
        """Start the pipeline"""
        self.create_pipeline()
        self.pipeline.set_state(Gst.State.PLAYING)
        self.running = True
        self._log("Pipeline started")

    def stop(self):
        """Stop the pipeline"""
        self.running = False
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
        self._log("Pipeline stopped")

    def run(self):
        """Main loop - read commands from stdin"""
        self.start()

        self.loop = GLib.MainLoop()

        # Handle stdin in separate thread
        import threading
        def read_stdin():
            while self.running:
                try:
                    line = sys.stdin.readline()
                    if not line:
                        break
                    msg = json.loads(line.strip())
                    GLib.idle_add(self._handle_message, msg)
                except Exception as e:
                    self._log(f"Stdin error: {e}")

        stdin_thread = threading.Thread(target=read_stdin, daemon=True)
        stdin_thread.start()

        # Handle signals
        def on_signal(sig, frame):
            self._log("Signal received, stopping...")
            self.stop()
            self.loop.quit()

        signal.signal(signal.SIGINT, on_signal)
        signal.signal(signal.SIGTERM, on_signal)

        self.loop.run()

    def _handle_message(self, msg):
        """Handle message from Node.js"""
        msg_type = msg.get('type')
        client_id = msg.get('clientId')

        if msg_type == 'add-client':
            self.add_client(client_id)
        elif msg_type == 'remove-client':
            self.remove_client(client_id)
        elif msg_type == 'answer':
            self.set_remote_description(client_id, msg['sdp'], 'answer')
        elif msg_type == 'ice-candidate':
            self.add_ice_candidate(client_id, msg['candidate'], msg['sdpMLineIndex'])
        elif msg_type == 'change-video':
            self._change_video(msg['path'])

        return False  # Don't repeat

    def _change_video(self, new_path: str):
        """Change the video file being streamed"""
        self._log(f"Changing video to {new_path}")
        self.pipeline.set_state(Gst.State.NULL)
        self.video_path = new_path

        # Recreate pipeline with new file
        filesrc = self.pipeline.get_by_name('filesrc0')
        if filesrc:
            filesrc.set_property('location', new_path)

        self.pipeline.set_state(Gst.State.PLAYING)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: demo_streamer.py <video.webm>")
        sys.exit(1)

    video_path = sys.argv[1]
    streamer = DemoStreamer(video_path)
    streamer.run()
