'use strict';

// Public file only. Keys are supplied by the developer at runtime, never stored.
async function downloadDriveVideo(apiKey, { signal, onProgress = () => {} } = {}, fetcher = fetch) {
  if (!apiKey.trim()) throw new Error('Enter your restricted standard API key.');
  const endpoint = 'https://www.googleapis.com/drive/v3/files/1-XFihL-VwXZK1J7o81nQwm5WuJyYExP9?alt=media';
  const maxBytes = 200 * 1024 * 1024;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  let timer;
  let timedOut = false;
  const resetTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
  };
  let response;
  let reader;
  resetTimeout();
  try {
    response = await fetcher(endpoint, {
      headers: { 'X-Goog-Api-Key': apiKey.trim() },
      credentials: 'omit', cache: 'no-store',
      referrerPolicy: 'strict-origin-when-cross-origin', signal: controller.signal,
    });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}: video download failed. Check your key, API restrictions, sharing, and quota.`);
    const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (mimeType !== 'video/mp4') throw new Error('Drive did not return an MP4. The response body was not read.');
    const total = Number(response.headers.get('content-length')) || 0;
    if (total < 0 || total > maxBytes || !Number.isFinite(total)) throw new Error('The declared size exceeds the 200 MiB safety limit or is invalid.');
    reader = response.body.getReader();
    const chunks = [];
    const signature = new Uint8Array(8);
    let received = 0;
    let signatureBytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      resetTimeout();
      if (signal?.aborted) controller.abort();
      controller.signal.throwIfAborted();
      if (received + value.length > maxBytes) throw new Error('Download exceeded the 200 MiB safety limit and was cancelled.');
      const count = Math.min(8 - signatureBytes, value.length);
      if (count) { signature.set(value.subarray(0, count), signatureBytes); signatureBytes += count; }
      if (signatureBytes === 8 && String.fromCharCode(...signature.subarray(4)) !== 'ftyp') throw new Error('The file does not have the expected MP4 signature.');
      chunks.push(value);
      received += value.length;
      onProgress({ received, total });
    }
    controller.signal.throwIfAborted();
    if (received < 8 || (total && total !== received)) throw new Error('The video download is incomplete.');
    return new Blob(chunks, { type: 'video/mp4' });
  } catch (error) {
    if (timedOut) throw new Error('Download stopped after 30 seconds without data. You can try again.');
    if (error.name === 'AbortError') throw error;
    if (error instanceof TypeError) throw new Error('The browser could not download the video. Check network access, CORS, and key restrictions.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
    try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch { /* Already closed. */ }
  }
}
