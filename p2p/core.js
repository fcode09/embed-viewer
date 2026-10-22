'use strict';

globalThis.PeerCore = (() => {
  const FILE_ID = '1-XFihL-VwXZK1J7o81nQwm5WuJyYExP9';
  const BLOCK_SIZE = 1048576;
  const MAX_BYTES = 200 * BLOCK_SIZE;
  const api = `https://www.googleapis.com/drive/v3/files/${FILE_ID}`;
  const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  const digest = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));
  const blockLength = (manifest, index) => {
    if (!Number.isInteger(index) || index < 0 || index >= Math.ceil(manifest.size / BLOCK_SIZE)) throw new Error('Invalid block index.');
    return Math.min(BLOCK_SIZE, manifest.size - index * BLOCK_SIZE);
  };
  async function contentId(meta) {
    return digest(new TextEncoder().encode(JSON.stringify([meta.fileId, meta.version, meta.size, BLOCK_SIZE])));
  }
  async function validateManifest(value) {
    if (!value || value.schema !== 1 || value.fileId !== FILE_ID || value.mimeType !== 'video/mp4' || value.blockSize !== BLOCK_SIZE || !/^\d{1,32}$/.test(value.version || '') || !Number.isSafeInteger(value.size) || value.size < 8 || value.size > MAX_BYTES) throw new Error('Invalid or unsupported video manifest.');
    if (!Array.isArray(value.hashes) || value.hashes.length !== Math.ceil(value.size / BLOCK_SIZE) || !value.hashes.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid block hashes in manifest.');
    if (value.contentId !== await contentId(value)) throw new Error('Manifest content identity does not match its metadata.');
    return Object.freeze({ schema: 1, fileId: FILE_ID, mimeType: 'video/mp4', blockSize: BLOCK_SIZE, version: String(value.version), size: value.size, contentId: value.contentId, hashes: Object.freeze([...value.hashes]) });
  }
  async function verifyBlock(manifest, index, bytes) {
    const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (array.byteLength !== blockLength(manifest, index) || await digest(array) !== manifest.hashes[index]) throw new Error('Block integrity check failed.');
    return array;
  }
  async function boundedJson(response, limit = 65536) {
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}: JSON resource unavailable.`); }
    if (!(response.headers.get('content-type') || '').includes('application/json')) { await response.body?.cancel(); throw new Error('Expected a JSON response.'); }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '', size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('JSON response exceeded its safety limit.');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      try { return JSON.parse(text); } catch { throw new Error('Invalid JSON response.'); }
    } finally { await reader.cancel().catch(() => {}); }
  }
  function driveOptions(key, signal, headers = {}) {
    if (!key?.trim()) throw new Error('A restricted Drive API key is required for missing blocks.');
    return { headers: { 'X-Goog-Api-Key': key.trim(), ...headers }, signal, mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'strict-origin-when-cross-origin' };
  }
  async function metadata(key, signal, fetcher = fetch) {
    const data = await boundedJson(await fetcher(`${api}?fields=id,size,mimeType,version`, driveOptions(key, signal)), 4096);
    const size = Number(data?.size);
    if (!data || data.id !== FILE_ID || data.mimeType !== 'video/mp4' || !/^\d{1,32}$/.test(data.version || '') || !Number.isSafeInteger(size) || size < 8 || size > MAX_BYTES) throw new Error('Drive metadata lacks a valid identity, version, or supported size.');
    const result = { fileId: FILE_ID, mimeType: 'video/mp4', version: String(data.version), size, blockSize: BLOCK_SIZE };
    result.contentId = await contentId(result);
    return result;
  }
  async function bootstrap({ key, cache, signal, onProgress = () => {} }, fetcher = fetch) {
    // One cancellable idle deadline covers headers, metadata, and each body read.
    const lifetime = new AbortController();
    const parentSignal = signal;
    const cancel = () => lifetime.abort(parentSignal.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    let timer;
    const idle = () => { clearTimeout(timer); timer = setTimeout(() => lifetime.abort(new Error('Drive preparation was idle for 30 seconds.')), 30000); };
    signal = lifetime.signal;
    idle();
    let before, unpin = () => {};
    const written = [];
    let response, reader;
    try {
      before = await metadata(key, signal, fetcher);
      unpin = cache.pin ? await cache.pin(before.contentId) : () => {};
      idle();
      response = await fetcher(`${api}?alt=media`, driveOptions(key, signal));
      if (response.status !== 200 || (response.headers.get('content-type') || '').split(';')[0].trim() !== 'video/mp4') throw new Error(`Drive did not return a complete MP4 (HTTP ${response.status}).`);
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) !== before.size) throw new Error('The video length changed before preparation.');
      reader = response.body.getReader();
      const hashes = [];
      let buffer = new Uint8Array(Math.min(BLOCK_SIZE, before.size)), filled = 0, received = 0;
      while (true) {
        signal?.throwIfAborted();
        idle();
        const { value, done } = await reader.read();
        clearTimeout(timer);
        if (done) break;
        if (received + value.length > before.size) throw new Error('Drive sent more video bytes than expected.');
        let position = 0;
        while (position < value.length) {
          const count = Math.min(buffer.length - filled, value.length - position);
          buffer.set(value.subarray(position, position + count), filled);
          filled += count; position += count; received += count;
          if (filled === buffer.length) {
            if (!hashes.length && String.fromCharCode(...buffer.subarray(4, 8)) !== 'ftyp') throw new Error('The source is not the expected MP4.');
            const hash = await digest(buffer);
            const index = hashes.length;
            // Preserve an already-valid block if a repeated preparation is cancelled.
            const existing = cache.get ? await cache.get(before.contentId, index) : null;
            if (!existing || existing.length !== buffer.length || await digest(existing) !== hash) {
              await cache.putDraft(before, index, buffer, hash);
              written.push(index);
            }
            hashes.push(hash);
            onProgress({ received, total: before.size, blocks: hashes.length });
            buffer = new Uint8Array(Math.min(BLOCK_SIZE, before.size - received)); filled = 0;
          }
        }
      }
      if (received !== before.size || filled) throw new Error('The source download was incomplete.');
      idle();
      const after = await metadata(key, signal, fetcher);
      if (after.contentId !== before.contentId) throw new Error('The Drive file changed during preparation. No manifest was published.');
      const manifest = await validateManifest({ ...before, schema: 1, hashes });
      signal.throwIfAborted();
      await cache.saveManifest(manifest);
      signal.throwIfAborted();
      return manifest;
    } catch (error) {
      for (const index of written) await cache.delete(before.contentId, index).catch(() => {});
      if (error instanceof TypeError) throw new Error('Drive preparation failed. Check network access, CORS, and key restrictions.');
      throw error;
    } finally { clearTimeout(timer); parentSignal?.removeEventListener('abort', cancel); unpin(); try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch { /* Closed. */ } }
  }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  return { FILE_ID, BLOCK_SIZE, MAX_BYTES, digest, contentId, blockLength, validateManifest, verifyBlock, boundedJson, metadata, bootstrap, delay };
})();
