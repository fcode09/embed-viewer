'use strict';
const element = id => document.getElementById(id);
const video = element('native-video');
const cache = new PeerCache();
let current = null, preparing = false;
const status = text => { element('playback-status').textContent = text; };
const peerStatus = text => { element('peer-status').textContent = text; };
const controls = createVideoControls({ video, isActive: () => Boolean(current), description: 'Cached progressive video' });
const mib = value => `${(value / 1048576).toFixed(1)} MiB`;
async function cacheStatus() {
  try { element('cache-status').textContent = `Saved video blocks: ${mib(await cache.usage())} / 200 MiB in this origin/browser profile.`; }
  catch { element('cache-status').textContent = 'Browser storage is unavailable. Playback can continue without saving.'; }
}
cacheStatus();
function close() {
  const previous = current; current = null;
  previous?.broker.close(); previous?.unpin();
  if (previous) previous.key = '';
  navigator.serviceWorker?.controller?.postMessage({ type: 'peer-stop' });
  video.pause(); video.removeAttribute('src'); video.load(); controls.reset();
  element('stream-key').value = '';
  element('stop-stream').hidden = true; element('peer-toggle').disabled = true;
  element('peer-toggle').textContent = 'Enable peer sharing'; element('peer-consent').checked = false;
  element('peer-upload-limit').disabled = false;
  peerStatus('Sharing is off. Cached blocks are retained.');
}
async function workerReady() {
  if (!isSecureContext || !navigator.serviceWorker) throw new Error('Use a Service Worker-capable browser and the local HTTP preview.');
  const registration = await navigator.serviceWorker.register('worker.js', { scope: './', updateViaCache: 'none' });
  await registration.update();
  if (registration.waiting) throw new Error('A worker update is waiting. Close all peer-pilot tabs, then reopen this page.');
  const deadline = performance.now() + 10000;
  while (!navigator.serviceWorker.controller?.scriptURL.endsWith('/stream/peer/worker.js')) {
    if (performance.now() > deadline) throw new Error('Peer worker is not controlling this page. Reload the pilot.');
    await PeerCore.delay(50);
  }
}
navigator.serviceWorker?.addEventListener('message', event => {
  if (event.source?.scriptURL !== new URL('worker.js', location.href).href || event.data?.type !== 'peer-block' || !event.ports[0]) return;
  const port = event.ports[0], data = event.data, session = current;
  const controller = new AbortController();
  port.onmessage = message => { if (message.data?.type === 'cancel') controller.abort(); };
  if (!session || data.playback !== session.playback || data.contentId !== session.manifest.contentId) { port.postMessage({ error: true }); port.close(); return; }
  session.broker.block(data.index, controller.signal).then(bytes => {
    if (session !== current || controller.signal.aborted) return;
    const copy = bytes.slice().buffer;
    port.postMessage({ bytes: copy }, [copy]);
  }).catch(error => {
    if (session === current && !controller.signal.aborted) {
      session.failure = error.name === 'AbortError' ? 'Stream closed.' : error.message;
      status(session.failure);
    }
    if (!controller.signal.aborted) port.postMessage({ error: true });
  }).finally(() => port.close());
});
element('stream-form').addEventListener('submit', async event => {
  event.preventDefault(); if (preparing) return;
  let key = element('stream-key').value.trim(); element('stream-key').value = '';
  preparing = true; element('prepare-stream').disabled = true; close();
  try {
    status('Loading the operator-published manifest. No Google request yet.');
    const manifest = await PeerCore.validateManifest(await PeerCore.boundedJson(await fetch('/p2p/manifest.json', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10000) })));
    await workerReady();
    let unpin = () => {};
    try { await cache.ready; unpin = await cache.pin(manifest.contentId); } catch { /* Cache is optional. */ }
    const session = { key, manifest, playback: crypto.randomUUID(), unpin, broker: null };
    key = '';
    session.broker = new PeerBroker({ manifest, cache, keyProvider: () => session.key, onStatus: status, onStats: stats => {
      if (current !== session) return;
      element('stream-stats').textContent = `Useful complete blocks — cache ${mib(stats.cache)} · peers ${mib(stats.peer)} · Drive ${mib(stats.drive)}. Network/protocol overhead is additional.`;
      cacheStatus();
    } });
    current = session;
    element('stop-stream').hidden = false; element('peer-toggle').disabled = false;
    // The user may enable peers before starting native media loading.
    status('Manifest ready. Enable sharing if desired, then press Load video. Drive is only used for missing blocks.');
    element('load-video').hidden = false;
  } catch (error) { status(`Preparation stopped: ${error.message} Operator setup: /p2p/setup.html → publish p2p/manifest.json.`); }
  finally { key = ''; preparing = false; element('prepare-stream').disabled = false; }
});
element('load-video').addEventListener('click', () => {
  if (!current) return;
  video.src = `media/sipcop.mp4?playback=${current.playback}`; video.preload = 'metadata'; video.load();
  element('load-video').hidden = true; status('Loading verified blocks. Play when the controls are ready.');
});
element('stop-stream').addEventListener('click', () => { close(); element('load-video').hidden = true; status('Stream closed. Key cleared; cached video retained.'); });
element('peer-toggle').addEventListener('click', async () => {
  const session = current; if (!session) return;
  if (session.broker.network) {
    session.broker.network.close(); session.broker.network = null;
    element('peer-toggle').textContent = 'Enable peer sharing'; element('peer-consent').checked = false;
    element('peer-upload-limit').disabled = false;
    peerStatus('Sharing is off. Cache and Drive remain available.'); return;
  }
  if (!element('peer-consent').checked) { peerStatus('Read and accept the bandwidth and privacy notice before sharing.'); return; }
  if (!element('peer-upload-limit').reportValidity()) return;
  const uploadMiB = element('peer-upload-limit').valueAsNumber;
  if (!Number.isFinite(uploadMiB) || uploadMiB < 0.5 || uploadMiB > 8) { peerStatus('Choose an upload limit between 0.5 and 8 MiB/s.'); return; }
  element('peer-toggle').disabled = true;
  element('peer-upload-limit').disabled = true;
  const network = new PeerNetwork({ manifest: session.manifest, uploadBytesPerSecond: uploadMiB * 1048576, getBlock: index => session.broker.localBlock(index), inventory: () => session.broker.inventory(), onStatus: peerStatus, onUpload: bytes => peerStatus(`Sharing enabled. Useful upload: ${mib(bytes)} / 200 MiB this session (${uploadMiB} MiB/s payload cap).`) });
  session.broker.network = network;
  try {
    await network.start();
    if (session !== current) { network.close(); return; }
    element('peer-toggle').textContent = 'Disable peer sharing';
  } catch (error) { network.close(); if (session === current) { session.broker.network = null; peerStatus(error.message); } }
  finally {
    if (session === current) {
      element('peer-toggle').disabled = false;
      element('peer-upload-limit').disabled = Boolean(session.broker.network && !network.life.signal.aborted);
    }
  }
});
element('cache-delete').addEventListener('click', async () => {
  if (preparing || !confirm('Stop this tab and delete all saved pilot video blocks in this browser profile? Other open tabs may save blocks again.')) return;
  const pending = current ? [...current.broker.inflight.values()] : [];
  close(); element('load-video').hidden = true;
  await Promise.allSettled(pending);
  try { await cache.clear(); status('Saved pilot video deleted. Other project data was not removed.'); }
  catch { status('The browser could not delete the saved video.'); }
  cacheStatus();
});
video.addEventListener('error', () => { if (current) status(current.failure || 'The browser could not play this stream. Check the manifest, missing-block/key access, or use the original viewer.'); });
window.addEventListener('pagehide', close);
