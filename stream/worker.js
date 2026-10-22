'use strict';
importScripts('./bridge.js');

const scopeUrl = new URL(self.registration.scope);
const mediaPath = `${scopeUrl.pathname}media/sipcop.mp4`;
const transfers = new Map();
const metadataBySession = new Map();
const workerVersion = 'range-metadata-v3';
function allowedClient(client) {
  if (!client || client.type !== 'window') return false;
  const url = new URL(client.url);
  return url.origin === scopeUrl.origin && [scopeUrl.pathname, `${scopeUrl.pathname}index.html`].includes(url.pathname);
}
function validPlayback(value) { return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value); }
function notify(client, playbackId, type, payload) {
  try { client.postMessage({ type, playbackId, workerVersion, ...payload }); } catch { /* Tab already closed. */ }
}
function keyFromClient(client, playbackId) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error('The player did not provide a key. Close and prepare it again.')); }, 5000);
    channel.port1.onmessage = event => {
      clearTimeout(timer);
      channel.port1.close();
      const key = event.data?.key;
      if (typeof key !== 'string' || !key.trim()) reject(new Error('This playback session is closed or has no key.'));
      else resolve(key.trim());
    };
    client.postMessage({ type: 'DRIVE_KEY_REQUEST', playbackId }, [channel.port2]);
  });
}
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
// No skipWaiting: updates must not replace a worker during active playback.
self.addEventListener('message', event => {
  if (event.data?.type !== 'STOP_STREAM' || !allowedClient(event.source) || !validPlayback(event.data.playbackId)) return;
  const id = `${event.source.id}:${event.data.playbackId}`;
  for (const controller of transfers.get(id) || []) controller.abort();
  transfers.delete(id);
  metadataBySession.delete(id);
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== scopeUrl.origin || url.pathname !== mediaPath) return;
  event.respondWith(handleMedia(event, url));
});
async function handleMedia(event, url) {
  const playbackId = url.searchParams.get('playback');
  if (event.request.method !== 'GET' || !validPlayback(playbackId) || [...url.searchParams.keys()].some(key => key !== 'playback')) return new Response('Invalid media request.', { status: 400 });
  const client = await self.clients.get(event.clientId);
  if (!allowedClient(client)) return new Response('Player client unavailable.', { status: 403 });
  const range = event.request.headers.get('range');
  try { DriveRange.parseRange(range); } catch { return new Response('A single byte range is required.', { status: 416 }); }
  const controller = new AbortController();
  const id = `${client.id}:${playbackId}`;
  if (!transfers.has(id)) transfers.set(id, new Set());
  const active = transfers.get(id);
  active.add(controller);
  const abort = () => controller.abort();
  event.request.signal.addEventListener('abort', abort, { once: true });
  if (event.request.signal.aborted) controller.abort();
  const finish = () => {
    event.request.signal.removeEventListener('abort', abort);
    active.delete(controller);
    if (!active.size && transfers.get(id) === active) transfers.delete(id);
  };
  let stage = 'key-handshake';
  try {
    const key = await keyFromClient(client, playbackId);
    controller.signal.throwIfAborted();
    stage = 'drive-request';
    notify(client, playbackId, 'STREAM_RANGE', { range });
    return await DriveRange.openRange({ range, key, controller,
      onBytes: data => notify(client, playbackId, 'STREAM_BYTES', data), onFinish: finish,
      onHeaders: details => {
        stage = 'range-validation';
        notify(client, playbackId, 'STREAM_DIAGNOSTIC', { stage, details });
      },
      getMetadata: async () => {
        if (metadataBySession.has(id)) return metadataBySession.get(id);
        stage = 'metadata-request';
        notify(client, playbackId, 'STREAM_DIAGNOSTIC', { stage, details: { code: 'METADATA_REQUESTED' } });
        const metadata = await DriveRange.loadMetadata({ key, controller });
        controller.signal.throwIfAborted();
        metadataBySession.set(id, metadata);
        stage = 'range-validation';
        notify(client, playbackId, 'STREAM_DIAGNOSTIC', { stage, details: { code: 'METADATA_SIZE_VERIFIED', contentLength: String(metadata.size) } });
        return metadata;
      },
      onRangeMapped: details => notify(client, playbackId, 'STREAM_DIAGNOSTIC', { stage: 'range-mapping', details: {
        code: 'CONTENT_RANGE_FROM_METADATA', contentRange: `bytes ${details.start}-${details.end}/${details.total}`, contentLength: String(details.length),
      } }),
      onError: message => notify(client, playbackId, 'STREAM_ERROR', { message, code: 'MEDIA_TRANSFER_INTERRUPTED', stage: 'media-body' }),
    });
  } catch (error) {
    finish();
    const message = error.name === 'AbortError' ? 'Media request cancelled.' : error.message;
    const failure = { message, code: error.code || 'STREAM_REQUEST_FAILED', stage, workerVersion };
    if (error.name !== 'AbortError') notify(client, playbackId, 'STREAM_ERROR', failure);
    return new Response(JSON.stringify(failure), { status: 502, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } });
  }
}
