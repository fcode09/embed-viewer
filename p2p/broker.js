'use strict';

globalThis.PeerBroker = class PeerBroker {
  constructor({ manifest, cache, keyProvider, onStats = () => {}, onStatus = () => {}, fetcher = fetch }) {
    Object.assign(this, { manifest, cache, keyProvider, onStats, onStatus, fetcher });
    this.life = new AbortController(); this.network = null; this.inflight = new Map();
    this.stats = { cache: 0, peer: 0, drive: 0 }; this.active = 0; this.waiters = []; this.saving = true;
    this.verified = new Set(); this.initialInventory = null;
  }
  async localBlock(index) {
    try {
      const value = await this.cache.get(this.manifest.contentId, index);
      if (!value) { this.verified.delete(index); return null; }
      const bytes = await PeerCore.verifyBlock(this.manifest, index, value);
      this.verified.add(index); return bytes;
    } catch { this.verified.delete(index); await this.cache.delete(this.manifest.contentId, index).catch(() => {}); return null; }
  }
  async inventory() {
    // Initial inventory must be validated, not inferred from draft metadata alone.
    if (!this.initialInventory) this.initialInventory = (async () => {
      const indices = await this.cache.indices(this.manifest);
      for (const index of indices) {
        this.life.signal.throwIfAborted();
        await this.localBlock(index);
      }
    })();
    await this.initialInventory;
    return [...this.verified];
  }
  async block(index, signal) {
    PeerCore.blockLength(this.manifest, index);
    this.life.signal.throwIfAborted(); signal?.throwIfAborted();
    let pending = this.inflight.get(index);
    if (!pending) {
      pending = this.load(index).finally(() => this.inflight.delete(index));
      this.inflight.set(index, pending);
    }
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
  }
  async slot() {
    this.life.signal.throwIfAborted();
    if (this.active >= 4) await new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    else this.active++;
    this.life.signal.throwIfAborted();
  }
  release() {
    // Hand the reserved slot directly to the oldest waiter; no overbooking gap.
    const next = this.waiters.shift();
    if (next) next.resolve(); else this.active--;
  }
  async load(index) {
    await this.slot();
    try {
      let source = 'cache', bytes = await this.localBlock(index);
      this.life.signal.throwIfAborted();
      if (!bytes && this.network && !this.network.life.signal.aborted) { bytes = await this.network.request(index); source = 'peer'; }
      this.life.signal.throwIfAborted();
      if (!bytes) {
        source = 'drive';
        const key = this.keyProvider()?.trim();
        if (!key) throw new Error('This block is not cached or available from a peer. Close and prepare with a restricted Drive key for fallback.');
        const controller = new AbortController();
        const abort = () => controller.abort();
        this.life.signal.addEventListener('abort', abort, { once: true });
        try {
          const start = index * PeerCore.BLOCK_SIZE, end = start + PeerCore.blockLength(this.manifest, index) - 1;
          const response = await DriveRange.openRange({ range: `bytes=${start}-${end}`, key, controller, getMetadata: async () => ({ size: this.manifest.size }) }, this.fetcher);
          bytes = new Uint8Array(await response.arrayBuffer());
        } finally { this.life.signal.removeEventListener('abort', abort); controller.abort(); }
        try { await PeerCore.verifyBlock(this.manifest, index, bytes); }
        catch { this.close(); throw new Error('Drive bytes do not match the published manifest. The operator must regenerate it before playback can continue.'); }
      }
      this.life.signal.throwIfAborted();
      await PeerCore.verifyBlock(this.manifest, index, bytes);
      if (source !== 'cache' && this.saving) {
        try { await this.cache.put(this.manifest, index, bytes); this.verified.add(index); this.network?.changed(); }
        catch { this.saving = false; this.onStatus('Browser cache write failed. Playback continues without saving new blocks.'); }
      }
      this.life.signal.throwIfAborted();
      this.stats[source] += bytes.length; this.onStats({ ...this.stats });
      return bytes;
    } finally { this.release(); }
  }
  close() {
    if (this.life.signal.aborted) return;
    this.life.abort(); this.network?.close(); this.network = null;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new DOMException('Stream closed.', 'AbortError'));
  }
};
