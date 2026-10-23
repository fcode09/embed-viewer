'use strict';

const element = id => document.getElementById(id);
const video = element('native-video');
const statusText = element('playback-status');
const prepare = element('prepare-stream');
let runtimeKey = '';
let playbackId = null;
let probeController = null;
let registration = null;
let transferred = 0;
let rangeRequests = 0;
let totalBytes = 0;
let lastWorkerError = '';
const diagnosticLines = [];
function diagnostic(stage, details = {}) {
  // Only protocol metadata is admitted; never log keys, full URLs, headers, or raw errors.
  const safe = { stage };
  for (const field of ['code', 'httpStatus', 'mimeType', 'contentRange', 'contentLength', 'workerVersion']) {
    if (['string', 'number'].includes(typeof details[field])) safe[field] = details[field];
  }
  const line = JSON.stringify(safe);
  diagnosticLines.push(line);
  if (diagnosticLines.length > 30) diagnosticLines.shift();
  element('stream-diagnostics').textContent = diagnosticLines.join('\n');
  console.info('[Drive stream]', safe);
}

async function probeFailure(response) {
  if ((response.headers.get('content-type') || '').includes('application/json')) {
    const reader = response.body.getReader();
    let text = '';
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024) return 'The worker error response exceeded the diagnostic limit.';
        text += new TextDecoder().decode(value);
      }
      const failure = JSON.parse(text);
      diagnostic(failure.stage || 'probe', failure);
      return typeof failure.message === 'string' ? failure.message : 'The worker rejected the media probe.';
    } finally { await reader.cancel().catch(() => {}); }
  }
  await response.body?.cancel();
  return lastWorkerError || `The local range probe returned HTTP ${response.status}.`;
}
const playbackControls = createVideoControls({ video, isActive: () => !!playbackId,
  description: 'Range-streaming session. Transfer figures include metadata probes and repeated/overlapping ranges.',
});

function updateStats() {
  element('stream-stats').textContent = `${rangeRequests} range request(s); ${(transferred / 1048576).toFixed(2)} MiB received${totalBytes ? `; source size ${(totalBytes / 1048576).toFixed(2)} MiB` : ''}. Counts may include repeated bytes.`;
}
function stopStream() {
  if (playbackId) navigator.serviceWorker?.controller?.postMessage({ type: 'STOP_STREAM', playbackId });
  playbackId = null;
  runtimeKey = '';
  probeController?.abort();
  probeController = null;
  video.pause();
  video.removeAttribute('src');
  video.load();
  playbackControls.reset();
  prepare.disabled = false;
  element('stop-stream').hidden = true;
}
function onWorkerMessage(event) {
  if (!registration || event.source !== navigator.serviceWorker.controller || !playbackId || event.data?.playbackId !== playbackId) return;
  if (event.data.type === 'DRIVE_KEY_REQUEST') {
    event.ports[0]?.postMessage({ key: runtimeKey });
    event.ports[0]?.close();
  } else if (event.data.type === 'STREAM_BYTES') {
    transferred += event.data.bytes;
    totalBytes = event.data.total;
    updateStats();
  } else if (event.data.type === 'STREAM_RANGE') {
    rangeRequests++;
    updateStats();
  } else if (event.data.type === 'STREAM_ERROR') {
    lastWorkerError = event.data.message;
    diagnostic(event.data.stage || 'worker', { code: event.data.code || 'STREAM_REQUEST_FAILED', workerVersion: event.data.workerVersion || 'legacy' });
    // Let the probe's 502 complete so Network retains the actual failure instead of "cancelled".
    if (!probeController) stopStream();
    statusText.textContent = `${event.data.message} Use the original viewer or close and prepare a new session.`;
  } else if (event.data.type === 'STREAM_DIAGNOSTIC') {
    diagnostic(event.data.stage, { ...event.data.details, workerVersion: event.data.workerVersion });
  }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', onWorkerMessage);
async function connectWorker() {
  if (!isSecureContext || !('serviceWorker' in navigator)) throw new Error('This browser needs Service Workers and HTTPS, or a secure local preview. Use the original viewer instead.');
  let timeout;
  try {
    return await Promise.race([
      (async () => {
        registration = await navigator.serviceWorker.register('./worker.js', { scope: './', updateViaCache: 'none' });
        if (registration.waiting) {
          diagnostic('worker-update', { code: 'UPDATE_WAITING' });
          throw new Error('A worker update is waiting. Close all /stream/ tabs, reopen this page, and try again.');
        }
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
        if (navigator.serviceWorker.controller?.scriptURL !== new URL('./worker.js', location.href).href) throw new Error('An unexpected worker controls this page. Reload or use the original viewer.');
        diagnostic('worker-ready', { code: 'WORKER_CONTROLLED' });
      })(),
      new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('Streaming setup timed out. Reload this page or use the original viewer.')), 10000); }),
    ]);
  } finally { clearTimeout(timeout); }
}
element('stream-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (prepare.disabled) return;
  const key = element('stream-key').value.trim();
  element('stream-key').value = '';
  if (!key) { statusText.textContent = 'Enter your restricted standard API key.'; return; }
  stopStream();
  prepare.disabled = true;
  element('stop-stream').hidden = false;
  transferred = 0;
  rangeRequests = 0;
  totalBytes = 0;
  lastWorkerError = '';
  diagnosticLines.length = 0;
  diagnostic('session-start', { code: 'PREPARING' });
  updateStats();
  const current = crypto.randomUUID();
  playbackId = current;
  runtimeKey = key;
  statusText.textContent = 'Preparing the isolated browser worker and testing a 1 KB range.';
  try {
    await connectWorker();
    if (playbackId !== current) return;
    probeController = new AbortController();
    const mediaUrl = new URL(`./media/sipcop.mp4?playback=${current}`, location.href);
    const response = await fetch(mediaUrl, { headers: { Range: 'bytes=0-1023' }, cache: 'no-store', signal: probeController.signal });
    diagnostic('probe-response', { httpStatus: response.status });
    if (response.status !== 206 || response.headers.get('content-length') !== '1024') {
      throw new Error(await probeFailure(response));
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== 1024 || String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp') throw new Error('The range probe did not return the expected MP4 fragment.');
    if (playbackId !== current) return;
    probeController = null;
    diagnostic('probe-passed', { code: 'MP4_FRAGMENT_VERIFIED' });
    video.preload = 'metadata';
    video.src = mediaUrl.href;
    video.load();
    statusText.textContent = 'Range/header probe passed. Reading metadata without waiting for a full download; press Play when ready.';
  } catch (error) {
    if (playbackId !== current) return;
    stopStream();
    statusText.textContent = error.name === 'AbortError' ? 'Streaming cancelled.' : `${error.message} The original viewer is still available. No full download was started as a fallback.`;
  }
});
element('stop-stream').addEventListener('click', () => { stopStream(); statusText.textContent = 'Stream stopped and key removed from page memory. In-flight transfers were cancelled.'; element('stream-key').focus(); });
video.addEventListener('error', () => {
  if (!playbackId) return;
  stopStream();
  statusText.textContent = 'The browser could not play this stream. Session stopped and key cleared. Retry or use the original Drive viewer; no full download was started.';
});
window.addEventListener('pagehide', () => { stopStream(); });
