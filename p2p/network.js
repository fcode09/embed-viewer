'use strict';

globalThis.PeerNetwork = class PeerNetwork {
  constructor({ manifest, getBlock, inventory, onStatus = () => {}, onUpload = () => {}, uploadBytesPerSecond = 4 * 1048576 }) {
    if (!Number.isFinite(uploadBytesPerSecond) || uploadBytesPerSecond < 524288 || uploadBytesPerSecond > 8 * 1048576) throw new RangeError('Choose an upload limit between 0.5 and 8 MiB/s.');
    Object.assign(this, { manifest, getBlock, inventory, onStatus, onUpload, uploadBytesPerSecond });
    this.life = new AbortController();
    this.peers = new Map(); this.candidates = []; this.bad = new Map();
    this.uploaded = 0; this.uploading = false; this.id = null; this.token = null;
  }
  uploadDelay(bytes, elapsedMs) {
    return Math.max(0, bytes / this.uploadBytesPerSecond * 1000 - elapsedMs);
  }
  async start() {
    if (!navigator.locks || !globalThis.RTCPeerConnection) throw new Error('This browser cannot run the local P2P pilot.');
    let acquired;
    const started = new Promise(resolve => { acquired = resolve; });
    navigator.locks.request('embed-peer-sharing', { ifAvailable: true }, async lock => {
      if (!lock || this.life.signal.aborted) { acquired(false); return; }
      await new Promise(resolve => { this.release = resolve; acquired(true); });
    }).catch(() => acquired(false));
    if (!await started) throw new Error('Another tab in this browser profile is already sharing. Cache and Drive still work.');
    try {
      const session = await this.http('/p2p/session', { contentId: this.manifest.contentId });
      this.id = session.peerId; this.token = session.token;
      this.readEvents().catch(() => { if (!this.life.signal.aborted) { this.onStatus('Local coordinator disconnected. Cache and Drive remain available.'); this.close(); } });
      this.heartbeat = setInterval(() => this.post({ type: 'heartbeat' }).catch(() => this.close()), 15000);
      await this.announce();
      this.onStatus('Sharing enabled: local WebRTC only; no external STUN/TURN.');
    } catch (error) { this.close(); throw error; }
  }
  async http(path, value) {
    const response = await fetch(path, { method: value ? 'POST' : 'GET', headers: { ...(value ? { 'Content-Type': 'application/json' } : {}), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) }, body: value ? JSON.stringify(value) : undefined, signal: AbortSignal.any([this.life.signal, AbortSignal.timeout(10000)]), credentials: 'omit', cache: 'no-store', redirect: 'error' });
    return PeerCore.boundedJson(response);
  }
  post(value) { return this.http('/p2p/message', value); }
  signal(peerId, kind, payload = '') { return this.post({ type: 'signal', to: peerId, kind, payload }); }
  async announce() {
    if (!this.token || this.life.signal.aborted) return;
    const have = await this.inventory().catch(() => []);
    if (this.life.signal.aborted) return;
    await this.post({ type: 'announce', have, free: !this.uploading && this.uploaded < PeerCore.MAX_BYTES });
  }
  changed() {
    if (this.announcement || this.life.signal.aborted) return;
    this.announcement = setTimeout(() => { this.announcement = null; this.announce().catch(() => {}); }, 1000);
  }
  async readEvents() {
    const response = await fetch('/p2p/events', { headers: { Authorization: `Bearer ${this.token}` }, signal: this.life.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error('Coordinator unavailable.');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let text = '';
    try {
      while (!this.life.signal.aborted) {
        const { value, done } = await reader.read(); if (done) throw new Error('Coordinator closed.');
        text += decoder.decode(value, { stream: true });
        if (text.length > 131072) throw new Error('Oversized coordinator event.');
        let end;
        while ((end = text.indexOf('\n\n')) >= 0) {
          const event = text.slice(0, end); text = text.slice(end + 2);
          if (!event.startsWith('data: ')) continue;
          const data = JSON.parse(event.slice(6));
          if (data.type === 'peers') {
            this.candidates = data.candidates;
            for (const candidate of this.candidates) this.ensure(candidate.peerId).catch(() => {});
          } else if (data.type === 'signal') this.receiveSignal(data).catch(() => this.drop(data.from));
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  async ensure(id, incoming = false) {
    if (this.peers.has(id)) return this.peers.get(id);
    if (!this.id || id === this.id || (this.bad.get(id) || 0) > Date.now() || this.peers.size >= (incoming ? 5 : 4) || this.life.signal.aborted) return null;
    const pc = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: 'all' });
    const peer = { id, pc, channel: null, pending: null, ice: [], score: 0, sending: false };
    this.peers.set(id, peer);
    pc.onicecandidate = event => { if (event.candidate) this.signal(id, 'ice', JSON.stringify(event.candidate.toJSON())).catch(() => this.drop(id)); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.drop(id); };
    pc.ondatachannel = event => {
      if (peer.channel || event.channel.label !== 'verified-video-blocks' || !event.channel.ordered || event.channel.maxRetransmits !== null || event.channel.maxPacketLifeTime !== null) { event.channel.close(); return; }
      this.attach(peer, event.channel);
    };
    if (this.id < id) {
      this.attach(peer, pc.createDataChannel('verified-video-blocks', { ordered: true }));
      await pc.setLocalDescription(await pc.createOffer());
      await this.signal(id, 'offer', pc.localDescription.sdp);
    } else if (!incoming) await this.signal(id, 'connect');
    return peer;
  }
  async receiveSignal({ from, kind, payload }) {
    if (kind === 'close') { this.drop(from, false); return; }
    const peer = await this.ensure(from, true);
    if (!peer) return;
    if (kind === 'offer' && from < this.id) {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: payload });
      for (const ice of peer.ice.splice(0)) await peer.pc.addIceCandidate(ice);
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      await this.signal(from, 'answer', peer.pc.localDescription.sdp);
    } else if (kind === 'answer' && from > this.id) {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: payload });
      for (const ice of peer.ice.splice(0)) await peer.pc.addIceCandidate(ice);
    } else if (kind === 'ice') {
      const ice = JSON.parse(payload);
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(ice);
      else if (peer.ice.length < 64) peer.ice.push(ice);
    }
  }
  attach(peer, channel) {
    peer.channel = channel; channel.binaryType = 'arraybuffer';
    channel.onclose = () => this.drop(peer.id);
    channel.onerror = () => this.drop(peer.id);
    channel.onmessage = event => {
      try {
        if (typeof event.data === 'string') {
          if (event.data.length > 2048) throw new Error('Oversized control.');
          const data = JSON.parse(event.data);
          if (data.type === 'request') { this.sendBlock(peer, data).catch(() => this.drop(peer.id)); return; }
          const pending = peer.pending;
          if (!pending || data.id !== pending.id) throw new Error('Unexpected transfer.');
          if (data.type === 'begin' && data.contentId === this.manifest.contentId && data.index === pending.index && data.length === pending.bytes.length && !pending.begun) pending.begun = true;
          else if (data.type === 'end' && pending.begun && pending.offset === pending.bytes.length) pending.resolve(pending.bytes);
          else if (data.type === 'error') pending.reject(new Error('Peer unavailable.'));
          else throw new Error('Invalid transfer header.');
        } else {
          const pending = peer.pending;
          if (!pending?.begun || !(event.data instanceof ArrayBuffer) || !event.data.byteLength || event.data.byteLength > 16384 || pending.offset + event.data.byteLength > pending.bytes.length) throw new Error('Invalid peer frame.');
          clearTimeout(pending.first);
          pending.bytes.set(new Uint8Array(event.data), pending.offset); pending.offset += event.data.byteLength;
        }
      } catch { this.drop(peer.id); }
    };
  }
  async request(index) {
    const candidates = this.candidates.filter(item => item.free && item.have.includes(index))
      .map(item => this.peers.get(item.peerId)).filter(peer => peer?.channel?.readyState === 'open' && !peer.pending)
      .sort((a, b) => a.score - b.score);
    // One bounded peer attempt avoids adding multiple four-second stalls to playback.
    const peer = candidates[0]; if (!peer) return null;
    const start = performance.now();
    try {
      const bytes = await new Promise((resolve, reject) => {
        const pending = { id: crypto.randomUUID(), index, bytes: new Uint8Array(PeerCore.blockLength(this.manifest, index)), offset: 0, begun: false };
        const done = (fn, value) => {
          clearTimeout(pending.first); clearTimeout(pending.deadline);
          if (peer.pending === pending) peer.pending = null;
          fn(value);
        };
        pending.resolve = value => done(resolve, value); pending.reject = error => done(reject, error);
        pending.first = setTimeout(() => pending.reject(new Error('Peer first-byte deadline.')), 1000);
        pending.deadline = setTimeout(() => pending.reject(new Error('Peer block deadline.')), 4000);
        peer.pending = pending;
        peer.channel.send(JSON.stringify({ type: 'request', id: pending.id, contentId: this.manifest.contentId, index }));
      });
      await PeerCore.verifyBlock(this.manifest, index, bytes);
      peer.score = performance.now() - start;
      return bytes;
    } catch { this.bad.set(peer.id, Date.now() + 60000); this.drop(peer.id); return null; }
  }
  async sendBlock(peer, request) {
    const channel = peer.channel;
    const send = value => { if (channel.readyState === 'open') channel.send(JSON.stringify(value)); };
    if (typeof request.id !== 'string' || request.id.length > 64 || request.contentId !== this.manifest.contentId || !Number.isInteger(request.index) || request.index < 0 || request.index >= this.manifest.hashes.length) throw new Error('Invalid block request.');
    if (this.uploading || peer.sending || this.uploaded + PeerCore.blockLength(this.manifest, request.index) > PeerCore.MAX_BYTES) { send({ type: 'error', id: request.id }); return; }
    this.uploading = true; peer.sending = true; this.changed();
    try {
      const bytes = await this.getBlock(request.index); // Cache only. Never originates a Drive fetch.
      if (!bytes || this.life.signal.aborted) { send({ type: 'error', id: request.id }); return; }
      await PeerCore.verifyBlock(this.manifest, request.index, bytes);
      send({ type: 'begin', id: request.id, index: request.index, contentId: this.manifest.contentId, length: bytes.length });
      const started = performance.now(); let sent = 0;
      while (sent < bytes.length) {
        this.life.signal.throwIfAborted();
        if (channel.readyState !== 'open') throw new Error('Peer closed.');
        while (channel.bufferedAmount > 262144) { await PeerCore.delay(20, this.life.signal); if (channel.readyState !== 'open') throw new Error('Peer closed.'); }
        const end = Math.min(bytes.length, sent + 16384);
        channel.send(bytes.slice(sent, end)); this.uploaded += end - sent; sent = end;
        this.onUpload(this.uploaded);
        // Payload cap; protocol/ICE/SCTP overhead is additional bandwidth.
        await PeerCore.delay(this.uploadDelay(sent, performance.now() - started), this.life.signal);
      }
      send({ type: 'end', id: request.id });
    } finally { this.uploading = false; peer.sending = false; this.changed(); }
  }
  drop(id, notify = true) {
    const peer = this.peers.get(id); if (!peer) return;
    this.peers.delete(id); peer.pending?.reject(new Error('Peer closed.'));
    peer.channel?.close(); peer.pc.close();
    if (notify && !this.life.signal.aborted && this.token) this.signal(id, 'close').catch(() => {});
  }
  close() {
    if (this.life.signal.aborted) return;
    // Best effort leave; disconnection and TTL also clean up presence.
    if (this.token) fetch('/p2p/message', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` }, body: '{"type":"leave"}', credentials: 'omit', keepalive: true }).catch(() => {});
    this.life.abort(); clearInterval(this.heartbeat); clearTimeout(this.announcement);
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.release?.(); this.token = null; this.candidates = [];
  }
};
