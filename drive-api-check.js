'use strict';

const apiEndpoint = 'https://www.googleapis.com/drive/v3/files/1-XFihL-VwXZK1J7o81nQwm5WuJyYExP9?alt=media';
const byteLimit = 1024;

async function checkDriveAccess(apiKey, fetcher = fetch) {
  if (!apiKey.trim()) throw new Error('Enter a restricted standard API key.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let response;
  let reader;
  try {
    response = await fetcher(apiEndpoint, {
      method: 'GET',
      headers: { 'X-Goog-Api-Key': apiKey.trim(), Range: 'bytes=0-1023' },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'strict-origin-when-cross-origin',
      signal: controller.signal,
    });
    if (response.status !== 206) {
      throw new Error(`HTTP ${response.status}: a 206 partial video response is required. Check the API, key restrictions, and public file access. The body was not read.`);
    }
    const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (mimeType !== 'video/mp4') throw new Error('The response is not video/mp4. No video body was read.');
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== byteLimit) throw new Error('Unexpected response length. The body was not read.');
    reader = response.body.getReader();
    const bytes = new Uint8Array(byteLimit);
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (received + value.length > byteLimit) throw new Error('The response exceeded the 1 KB read limit. The request was cancelled.');
      bytes.set(value, received);
      received += value.length;
    }
    if (received !== byteLimit) throw new Error('The partial response was incomplete.');
    if (String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp') throw new Error('The fragment does not have the expected MP4 file signature.');
    return { bytes: received, mimeType };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The check timed out after 12 seconds.');
    if (error instanceof TypeError) throw new Error('The browser could not read the response. Check network access, CORS, and key restrictions.');
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    try {
      if (reader) await reader.cancel();
      else await response?.body?.cancel();
    } catch { /* The stream may already be closed or aborted. */ }
  }
}

const apiForm = document.querySelector('#api-form');
const apiInput = document.querySelector('#api-key');
const checkButton = document.querySelector('#check');
const result = document.querySelector('#result');

apiForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (checkButton.disabled) return;
  if (location.protocol === 'file:') {
    result.textContent = 'Open this check using node serve.mjs at http://127.0.0.1:4173/drive-api-check.html, not as a local file.';
    return;
  }
  const apiKey = apiInput.value.trim();
  apiInput.value = '';
  checkButton.disabled = true;
  result.textContent = 'Checking a 1 KB fragment directly with Google Drive API…';
  try {
    const checked = await checkDriveAccess(apiKey);
    result.textContent = `Fragment check passed: HTTP 206, ${checked.bytes} bytes, ${checked.mimeType}, MP4 signature verified.\nThis does not yet prove full playback or seeking support.`;
  } catch (error) {
    result.textContent = error.message;
  } finally {
    checkButton.disabled = false;
  }
});
