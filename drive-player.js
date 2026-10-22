'use strict';

const element = id => document.getElementById(id);
const video = element('native-video');
const statusText = element('playback-status');
const prepare = element('prepare');
const cancelDownload = element('cancel-download');
const releaseButton = element('release-video');
const progress = element('download-progress');
let downloadController = null;
let blobUrl = null;
const playbackControls = createVideoControls({ video, isActive: () => !!blobUrl, description: 'This is the downloaded copy, not remote streaming.' });

function releaseVideo() {
  video.pause();
  video.removeAttribute('src');
  video.load();
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = null;
  releaseButton.hidden = true;
  playbackControls.reset();
}

element('download-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (downloadController) return;
  if (location.protocol === 'file:') { statusText.textContent = 'Use http://127.0.0.1:4173/drive-player.html with node serve.mjs.'; return; }
  if (!element('download-consent').checked) { statusText.textContent = 'Confirm the full download before continuing.'; return; }
  const key = element('player-key').value.trim();
  element('player-key').value = '';
  if (!key) { statusText.textContent = 'Enter your restricted standard API key.'; return; }
  releaseVideo();
  downloadController = new AbortController();
  prepare.disabled = true;
  cancelDownload.hidden = false;
  progress.hidden = false;
  progress.value = 0;
  statusText.textContent = 'Downloading directly from Drive. Playback will be available after the complete file arrives.';
  try {
    const blob = await downloadDriveVideo(key, {
      signal: downloadController.signal,
      onProgress({ received, total }) {
        if (total) progress.value = received / total;
        else progress.removeAttribute('value');
        element('download-size').textContent = `${(received / 1048576).toFixed(1)} MiB received${total ? ` of ${(total / 1048576).toFixed(1)} MiB` : ''}. You can cancel.`;
      },
    });
    blobUrl = URL.createObjectURL(blob);
    video.src = blobUrl;
    video.preload = 'metadata';
    video.load();
    releaseButton.hidden = false;
    progress.value = 1;
    element('download-size').textContent = `Complete: ${(blob.size / 1048576).toFixed(1)} MiB. Temporary browser copy; no permanent cache.`;
    statusText.textContent = 'Download complete. Reading video metadata; playback is not yet verified.';
  } catch (error) {
    statusText.textContent = error.name === 'AbortError' ? 'Download cancelled. No video was prepared.' : error.message;
  } finally {
    downloadController = null;
    prepare.disabled = false;
    cancelDownload.hidden = true;
  }
});

cancelDownload.addEventListener('click', () => downloadController?.abort());
releaseButton.addEventListener('click', () => {
  releaseVideo();
  progress.hidden = true;
  element('download-size').textContent = 'Video released. A new download requires the key and your confirmation.';
  statusText.textContent = 'Player closed and temporary video URL released.';
  element('player-key').focus();
});
