/* ═══════════════════════════════════════════════════════════════════════
   WizzCall — WebRTC Audio Call Manager
   ═══════════════════════════════════════════════════════════════════════ */

class AudioCall {
  constructor() {
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.audioContext = null;
    this.analyser = null;
    this.isMuted = false;
    this._animFrameId = null;

    // STUN + TURN servers for NAT traversal across different networks
    // STUN alone fails when users are behind symmetric NATs or firewalls.
    // TURN servers act as relays to ensure audio works on ANY network.
    this.iceConfig = {
      iceServers: [
        // Google STUN servers (for direct P2P when possible)
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },

        // Free TURN relay servers from Open Relay Project
        // These relay audio when direct P2P is not possible (different networks)
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turns:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ],
      // Allow both direct (srflx) and relay (relay) candidates
      iceTransportPolicy: 'all',
      // Bundle all media into one connection for better reliability
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    };
  }

  /**
   * Request microphone access from the user
   * @returns {Promise<MediaStream>}
   */
  async requestMicrophone() {
    if (this.localStream) return this.localStream;

    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });

    return this.localStream;
  }

  /**
   * Create a new RTCPeerConnection and wire up event handlers
   * @param {Object} callbacks
   * @param {Function} callbacks.onIceCandidate - Called with ICE candidate
   * @param {Function} callbacks.onTrack - Called with remote MediaStream
   * @param {Function} callbacks.onConnectionStateChange - Called with state string
   */
  createPeerConnection({ onIceCandidate, onTrack, onConnectionStateChange }) {
    // Clean up any existing connection
    if (this.peerConnection) {
      this.peerConnection.close();
    }

    this.peerConnection = new RTCPeerConnection(this.iceConfig);

    // Add local audio tracks to the connection
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });
    }

    // ICE candidate handler — relay to signaling server
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && onIceCandidate) {
        onIceCandidate(event.candidate);
      }
    };

    // Remote track received — attach to audio element
    this.peerConnection.ontrack = (event) => {
      this.remoteStream = event.streams[0];
      if (onTrack) {
        onTrack(this.remoteStream);
      }
      // Set up audio analyser for visualizer
      this._setupAnalyser(this.remoteStream);
    };

    // Connection state changes
    this.peerConnection.onconnectionstatechange = () => {
      if (onConnectionStateChange) {
        onConnectionStateChange(this.peerConnection.connectionState);
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      const iceState = this.peerConnection.iceConnectionState;
      console.log('[WebRTC] ICE state:', iceState);

      // If ICE fails, notify the app so it can attempt an ICE restart
      if (iceState === 'failed' && this._onIceFailedCallback) {
        console.warn('[WebRTC] ICE connection failed — triggering restart');
        this._onIceFailedCallback();
      }
    };

    return this.peerConnection;
  }

  /**
   * Register a callback for when ICE connection fails (for ICE restart)
   * @param {Function} callback
   */
  onIceFailed(callback) {
    this._onIceFailedCallback = callback;
  }

  /**
   * Create an SDP offer (caller side)
   * @param {Object} [options] - Additional offer options
   * @param {boolean} [options.iceRestart] - Set true to trigger ICE restart
   * @returns {Promise<RTCSessionDescriptionInit>}
   */
  async createOffer(options = {}) {
    const offer = await this.peerConnection.createOffer(options);
    await this.peerConnection.setLocalDescription(offer);
    return offer;
  }

  /**
   * Handle an incoming SDP offer and create an answer (callee side)
   * @param {RTCSessionDescriptionInit} offer
   * @returns {Promise<RTCSessionDescriptionInit>}
   */
  async handleOffer(offer) {
    await this.peerConnection.setRemoteDescription(
      new RTCSessionDescription(offer)
    );
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    return answer;
  }

  /**
   * Handle an incoming SDP answer (caller side)
   * @param {RTCSessionDescriptionInit} answer
   */
  async handleAnswer(answer) {
    await this.peerConnection.setRemoteDescription(
      new RTCSessionDescription(answer)
    );
  }

  /**
   * Add a received ICE candidate
   * @param {RTCIceCandidateInit} candidate
   */
  async addIceCandidate(candidate) {
    try {
      await this.peerConnection.addIceCandidate(
        new RTCIceCandidate(candidate)
      );
    } catch (err) {
      console.warn('[WebRTC] Error adding ICE candidate:', err);
    }
  }

  /**
   * Toggle microphone mute
   * @returns {boolean} Current muted state
   */
  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !this.isMuted;
      });
    }
    return this.isMuted;
  }

  /**
   * Set up Web Audio API analyser for remote audio visualization
   * @param {MediaStream} stream
   * @private
   */
  _setupAnalyser(stream) {
    try {
      if (this.audioContext) {
        this.audioContext.close();
      }

      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 64;
      this.analyser.smoothingTimeConstant = 0.8;
      source.connect(this.analyser);
      // Don't connect to destination — we already have the <audio> element playing it
    } catch (err) {
      console.warn('[WebRTC] Could not set up audio analyser:', err);
    }
  }

  /**
   * Get current frequency data for the visualizer
   * @returns {Uint8Array}
   */
  getFrequencyData() {
    if (!this.analyser) return new Uint8Array(0);
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return data;
  }

  /**
   * Start the visualizer animation loop
   * @param {HTMLElement} container - The visualizer container element
   */
  startVisualizer(container) {
    this.stopVisualizer();

    const animate = () => {
      const data = this.getFrequencyData();
      if (data.length > 0) {
        updateVisualizerBars(container, data);
      }
      this._animFrameId = requestAnimationFrame(animate);
    };

    this._animFrameId = requestAnimationFrame(animate);
  }

  /**
   * Stop the visualizer animation loop
   */
  stopVisualizer() {
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
  }

  /**
   * Clean up the current peer connection (keep microphone open for next call)
   */
  cleanup() {
    this.stopVisualizer();

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
      this.analyser = null;
    }

    this.remoteStream = null;
    this.isMuted = false;
  }

  /**
   * Full teardown — releases microphone as well
   */
  destroy() {
    this.cleanup();

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
  }
}
