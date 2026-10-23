'use strict';

globalThis.PeerCache = class PeerCache {
  constructor() {
    this.database = null;
    this.ready = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error('IndexedDB is unavailable.')); return; }
      const request = indexedDB.open('embed-peer-cache-v1', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('blocks', { keyPath: 'key' });
        const entries = db.createObjectStore('entries', { keyPath: 'key' });
        entries.createIndex('content', 'contentId');
        db.createObjectStore('manifests', { keyPath: 'contentId' });
      };
      request.onerror = () => reject(new Error('Browser storage could not be opened.'));
      request.onblocked = () => reject(new Error('Browser storage is blocked by another tab.'));
      request.onsuccess = () => {
        this.database = request.result;
        this.database.onversionchange = () => this.database.close();
        resolve(this.database);
      };
    });
    // Consumers receive the failure through methods; avoid an unhandled rejection on creation.
    this.ready.catch(() => {});
  }
  async get(contentId, index) {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      const request = db.transaction('blocks').objectStore('blocks').get([contentId, index]);
      request.onsuccess = () => resolve(request.result?.data ? new Uint8Array(request.result.data) : null);
      request.onerror = () => reject(new Error('Cached video could not be read.'));
    });
  }
  async entries() {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      const request = db.transaction('entries').objectStore('entries').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Cache metadata could not be read.'));
    });
  }
  async indices(manifest) {
    const rows = await this.entries();
    return rows.filter(row => row.contentId === manifest.contentId && row.hash === manifest.hashes[row.index] && row.size === PeerCore.blockLength(manifest, row.index)).map(row => row.index);
  }
  async usage() { return (await this.entries()).reduce((sum, row) => sum + row.size, 0); }
  async pin(contentId) {
    if (!navigator.locks) return () => {};
    return this.mutate(() => new Promise((resolve, reject) => {
      let release;
      const held = new Promise(done => { release = done; });
      navigator.locks.request(`embed-peer-content:${contentId}`, { mode: 'shared' }, async () => { resolve(release); await held; }).catch(reject);
    }));
  }
  async mutate(action) {
    return navigator.locks ? navigator.locks.request('embed-peer-cache-write', action) : action();
  }
  async put(manifest, index, bytes) {
    const verified = await PeerCore.verifyBlock(manifest, index, bytes);
    return this.putDraft(manifest, index, verified, manifest.hashes[index]);
  }
  async putDraft(meta, index, bytes, hash) {
    if (bytes.byteLength !== PeerCore.blockLength(meta, index)) throw new Error('Invalid cache block size.');
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return this.mutate(async () => {
      const db = await this.ready;
      const locked = navigator.locks ? await navigator.locks.query() : null;
      const protectedIds = new Set((locked?.held || []).filter(lock => lock.name.startsWith('embed-peer-content:')).map(lock => lock.name.slice('embed-peer-content:'.length)));
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['blocks', 'entries'], 'readwrite');
        const blocks = tx.objectStore('blocks'), entries = tx.objectStore('entries');
        const request = entries.getAll();
        request.onsuccess = () => {
          const rows = request.result;
          const old = rows.find(row => row.contentId === meta.contentId && row.index === index);
          let used = rows.reduce((sum, row) => sum + row.size, 0) - (old?.size || 0);
          for (const row of rows.sort((a, b) => a.at - b.at)) {
            if (used + data.byteLength <= PeerCore.MAX_BYTES) break;
            if (!locked || row.contentId === meta.contentId || protectedIds.has(row.contentId)) continue;
            blocks.delete(row.key); entries.delete(row.key); used -= row.size;
          }
          if (used + data.byteLength > PeerCore.MAX_BYTES) { tx.abort(); return; }
          const key = [meta.contentId, index];
          blocks.put({ key, data });
          entries.put({ key, contentId: meta.contentId, index, size: data.byteLength, hash, at: Date.now() });
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(new Error('Cache is full, unavailable, or its write was cancelled. Playback can continue without saving.'));
      });
    });
  }
  async delete(contentId, index) {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['blocks', 'entries'], 'readwrite');
      tx.objectStore('blocks').delete([contentId, index]);
      tx.objectStore('entries').delete([contentId, index]);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(new Error('Cache block could not be deleted.'));
    });
  }
  async saveManifest(manifest) {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('manifests', 'readwrite'); tx.objectStore('manifests').put(manifest);
      tx.oncomplete = resolve; tx.onerror = () => reject(new Error('Manifest could not be saved locally.'));
    });
  }
  async clear() {
    return this.mutate(async () => {
      const db = await this.ready;
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['blocks', 'entries', 'manifests'], 'readwrite');
        for (const name of ['blocks', 'entries', 'manifests']) tx.objectStore(name).clear();
        tx.oncomplete = resolve; tx.onerror = () => reject(new Error('Local video data could not be deleted.'));
      });
    });
  }
};
