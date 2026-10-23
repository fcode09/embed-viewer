'use strict';
importScripts('../../p2p/core.js', '../bridge.js');
const workerVersion = 'peer-blocks-v1';
const sessions = new Map();
const prefix = new URL('./', self.location.href).pathname;
const mediaPath = `${prefix}media/sipcop.mp4`;
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
async function validClient(id) {
  const client = await self.clients.get(id);
  if (!client || client.type !== 'window') throw new Error('Viewer not open.');
  const url = new URL(client.url);
  if (url.origin !== self.location.origin || ![prefix, `${prefix}index.html`].includes(url.pathname)) throw new Error('Unexpected client.');
  return client;
}
self.addEventListener('message', event => {
  if (event.data?.type === 'peer-stop' && event.source?.id) sessions.delete(event.source.id);
});
async function session(client, playback) {
  const previous = sessions.get(client.id);
  if (previous?.playback === playback) return previous;
  const response = await fetch('/p2p/manifest.json', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
  const manifest = await PeerCore.validateManifest(await PeerCore.boundedJson(response));
  const value = { playback, manifest }; sessions.set(client.id, value); return value;
}
function requestBlock(client, playback, contentId, index, signal) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let timer;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); channel.port1.close(); };
    const abort = () => { channel.port1.postMessage({ type: 'cancel' }); cleanup(); reject(new Error('Media request cancelled.')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    timer = setTimeout(() => { abort(); }, 45000);
    channel.port1.onmessage = event => {
      const data = event.data;
      cleanup();
      if (data?.error || !(data?.bytes instanceof ArrayBuffer)) { reject(new Error('Block could not be loaded.')); return; }
      resolve(new Uint8Array(data.bytes));
    };
    client.postMessage({ type: 'peer-block', playback, contentId, index, workerVersion }, [channel.port2]);
  });
}
async function media(request, clientId) {
  const url = new URL(request.url), playback = url.searchParams.get('playback');
  if (!/^[a-f0-9-]{36}$/.test(playback || '') || [...url.searchParams.keys()].some(key => key !== 'playback')) return new Response('Invalid session', { status: 400 });
  try {
    const client = await validClient(clientId);
    const { manifest } = await session(client, playback);
    let range;
    try { range = request.headers.has('range') ? DriveRange.parseRange(request.headers.get('range')) : { start: 0, end: manifest.size - 1 }; }
    catch { return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${manifest.size}` } }); }
    const start = range.start === null ? Math.max(0, manifest.size - range.end) : range.start;
    const end = range.start === null ? manifest.size - 1 : Math.min(range.end ?? manifest.size - 1, manifest.size - 1);
    if (start >= manifest.size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${manifest.size}` } });
    const abort = new AbortController();
    const cancel = () => abort.abort();
    request.signal.addEventListener('abort', cancel, { once: true });
    let position = start;
    const body = new ReadableStream({
      async pull(output) {
        try {
          if (position > end) { request.signal.removeEventListener('abort', cancel); output.close(); return; }
          const index = Math.floor(position / PeerCore.BLOCK_SIZE);
          const bytes = await requestBlock(client, playback, manifest.contentId, index, abort.signal);
          await PeerCore.verifyBlock(manifest, index, bytes);
          const offset = position - index * PeerCore.BLOCK_SIZE;
          const count = Math.min(bytes.length - offset, end - position + 1);
          output.enqueue(bytes.slice(offset, offset + count)); position += count;
        } catch { request.signal.removeEventListener('abort', cancel); abort.abort(); output.error(new Error('Video block unavailable. See viewer status.')); }
      },
      cancel() { request.signal.removeEventListener('abort', cancel); abort.abort(); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: request.headers.has('range') ? 206 : 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(end - start + 1), ...(request.headers.has('range') ? { 'Content-Range': `bytes ${start}-${end}/${manifest.size}` } : {}), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' } });
  } catch { return new Response('Viewer or published manifest unavailable.', { status: 503 }); }
}
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname === mediaPath && event.request.method === 'GET') event.respondWith(media(event.request, event.clientId));
});
