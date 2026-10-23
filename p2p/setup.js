'use strict';
const publisherCache = new PeerCache();
const publisherElement = id => document.getElementById(id);
let publisherController = null;
let manifestUrl = null;
document.getElementById('publisher-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (publisherController || !publisherElement('publisher-consent').checked) return;
  const key = publisherElement('publisher-key').value.trim();
  publisherElement('publisher-key').value = '';
  if (!key || location.protocol === 'file:') { publisherElement('publisher-status').textContent = 'Use the local HTTP preview and enter a restricted standard key.'; return; }
  publisherController = new AbortController();
  publisherElement('publisher-start').disabled = true;
  publisherElement('publisher-cancel').hidden = false;
  publisherElement('publisher-export').hidden = true;
  publisherElement('publisher-progress').hidden = false;
  try {
    await publisherCache.ready;
    publisherElement('publisher-status').textContent = 'Reading the real Drive source. This consumes your project quota and local bandwidth.';
    const manifest = await PeerCore.bootstrap({ key, cache: publisherCache, signal: publisherController.signal, onProgress({ received, total, blocks }) {
      publisherElement('publisher-progress').value = received / total;
      publisherElement('publisher-status').textContent = `${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB; ${blocks} complete blocks hashed and stored. Verifying the source version after completion.`;
    } });
    if (manifestUrl) URL.revokeObjectURL(manifestUrl);
    manifestUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }));
    publisherElement('publisher-export').href = manifestUrl;
    publisherElement('publisher-export').hidden = false;
    publisherElement('publisher-status').textContent = 'Drive preparation complete and source version confirmed. Download the JSON and place it at p2p/manifest.json. No MP4 was uploaded to the server.';
  } catch (error) {
    publisherElement('publisher-status').textContent = error.name === 'AbortError' ? 'Preparation cancelled. No manifest was published.' : error.message;
  } finally {
    publisherController = null;
    publisherElement('publisher-start').disabled = false;
    publisherElement('publisher-cancel').hidden = true;
  }
});
publisherElement('publisher-cancel').addEventListener('click', () => publisherController?.abort());
window.addEventListener('pagehide', () => { publisherController?.abort(); if (manifestUrl) URL.revokeObjectURL(manifestUrl); });
