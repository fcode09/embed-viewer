'use strict';

// Transport helpers shared with unit tests. No credentials or media are cached.
const DriveRange = (() => {
  const endpoint = 'https://www.googleapis.com/drive/v3/files/1-XFihL-VwXZK1J7o81nQwm5WuJyYExP9?alt=media';
  const metadataEndpoint = 'https://www.googleapis.com/drive/v3/files/1-XFihL-VwXZK1J7o81nQwm5WuJyYExP9?fields=id,size,mimeType';
  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
  function responseDetails(response) {
    const range = response.headers.get('content-range') || '';
    const length = response.headers.get('content-length') || '';
    return {
      httpStatus: response.status,
      mimeType: (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() === 'video/mp4' ? 'video/mp4' : 'other or missing',
      contentRange: /^bytes \d+-\d+\/\d+$/.test(range) ? range : 'missing or invalid',
      contentLength: /^\d{1,16}$/.test(length) ? length : 'missing or invalid',
    };
  }
  function parseRange(value) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(value || '');
    if (!match || (!match[1] && !match[2])) throw new Error('A single byte range is required.');
    const start = match[1] ? Number(match[1]) : null;
    const end = match[2] ? Number(match[2]) : null;
    for (const number of [start, end]) if (number !== null && (!Number.isSafeInteger(number) || number < 0)) throw new Error('Invalid byte range.');
    if ((start === null && end === 0) || (start !== null && end !== null && start > end)) throw new Error('Invalid byte range.');
    return { start, end };
  }
  function validateResponse(response, range, verifiedSize) {
    if (response.status !== 206) fail('UPSTREAM_HTTP', `Drive returned HTTP ${response.status}; partial media is required.`);
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'video/mp4') fail('INVALID_MEDIA_TYPE', 'Drive did not return video/mp4.');
    const rawRange = response.headers.get('content-range');
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(rawRange || '');
    let start, end, total;
    let rangeSource = 'header';
    if (match) {
      [start, end, total] = match.slice(1).map(Number);
    } else {
      // CORS may hide Content-Range while exposing Content-Length. Do not invent a total:
      // use this file's validated API metadata plus HTTP 206 single-range semantics.
      if (rawRange !== null || !Number.isSafeInteger(verifiedSize) || verifiedSize < 8 || verifiedSize > 200 * 1048576) fail('MISSING_CONTENT_RANGE', 'Content-Range is unavailable and no valid file size was verified.');
      const rawLength = response.headers.get('content-length');
      if (!/^\d{1,16}$/.test(rawLength || '')) fail('INVALID_CONTENT_LENGTH', 'Content-Length is missing or inconsistent.');
      const length = Number(rawLength);
      total = verifiedSize;
      start = range.start === null ? Math.max(0, total - range.end) : range.start;
      end = start + length - 1;
      rangeSource = 'metadata';
    }
    if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || end >= total || total > 200 * 1048576) throw new Error('Invalid media range or file exceeds the 200 MiB safety limit.');
    const expectedStart = range.start === null ? Math.max(0, total - range.end) : range.start;
    const expectedEnd = range.start === null ? total - 1 : Math.min(range.end ?? total - 1, total - 1);
    if (start !== expectedStart || end > expectedEnd) throw new Error('Drive returned a different byte range.');
    // A bounded probe must return exactly the requested bytes; an open range may be shorter.
    if ((range.end !== null || range.start === null) && end !== expectedEnd) throw new Error('The bounded media range is incomplete.');
    const length = end - start + 1;
    if (response.headers.get('content-length') !== String(length)) fail('INVALID_CONTENT_LENGTH', 'Content-Length is missing or inconsistent.');
    return { start, end, total, length, rangeSource };
  }
  async function loadMetadata({ key, controller }, fetcher = fetch) {
    let response;
    let reader;
    try {
      response = await fetcher(metadataEndpoint, {
        headers: { 'X-Goog-Api-Key': key }, mode: 'cors', credentials: 'omit', cache: 'no-store',
        redirect: 'error', referrerPolicy: 'strict-origin-when-cross-origin', signal: controller.signal,
      });
      if (response.status !== 200) fail('METADATA_HTTP', `Drive metadata returned HTTP ${response.status}.`);
      if (!(response.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) fail('INVALID_METADATA', 'Drive metadata is not JSON.');
      reader = response.body.getReader();
      let text = '';
      let received = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > 4096) fail('INVALID_METADATA', 'Drive metadata exceeded the 4 KB safety limit.');
        text += new TextDecoder().decode(value);
      }
      let data;
      try { data = JSON.parse(text); } catch { fail('INVALID_METADATA', 'Drive metadata is not valid JSON.'); }
      if (!data || data.id !== '1-XFihL-VwXZK1J7o81nQwm5WuJyYExP9' || data.mimeType !== 'video/mp4' || !/^\d{1,16}$/.test(data.size || '')) fail('INVALID_METADATA', 'Drive metadata does not describe the expected MP4 file.');
      const size = Number(data.size);
      if (!Number.isSafeInteger(size) || size < 8 || size > 200 * 1048576) fail('INVALID_METADATA', 'Drive metadata size is invalid or exceeds the 200 MiB safety limit.');
      return { size };
    } catch (error) {
      if (error instanceof TypeError) fail('METADATA_ACCESS_FAILED', 'The browser could not read Drive file metadata.');
      throw error;
    } finally {
      try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch { /* Already closed. */ }
    }
  }
  async function openRange({ range, key, controller, onBytes = () => {}, onFinish = () => {}, onError = () => {}, onHeaders = () => {}, getMetadata = async () => null, onRangeMapped = () => {} }, fetcher = fetch) {
    const parsed = parseRange(range);
    let upstream;
    let reader;
    let timer;
    let finished = false;
    let timedOut = false;
    const idle = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30000); };
    const finish = () => { if (!finished) { finished = true; clearTimeout(timer); onFinish(); } };
    try {
      idle();
      upstream = await fetcher(endpoint, {
        headers: { 'X-Goog-Api-Key': key, Range: range }, mode: 'cors', credentials: 'omit',
        cache: 'no-store', redirect: 'error', referrerPolicy: 'strict-origin-when-cross-origin', signal: controller.signal,
      });
      onHeaders(responseDetails(upstream));
      let metadata;
      if (upstream.status === 206 && (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() === 'video/mp4' && upstream.headers.get('content-range') === null) metadata = await getMetadata();
      const details = validateResponse(upstream, parsed, metadata?.size);
      if (details.rangeSource === 'metadata') onRangeMapped(details);
      clearTimeout(timer);
      reader = upstream.body.getReader();
      let received = 0;
      const body = new ReadableStream({
        async pull(output) {
          try {
            idle();
            const { value, done } = await reader.read();
            clearTimeout(timer);
            if (done) {
              if (received !== details.length) throw new Error('The partial media response was truncated.');
              finish();
              output.close();
              return;
            }
            if (received + value.length > details.length) throw new Error('The partial media response exceeded its declared range.');
            received += value.length;
            onBytes({ bytes: value.length, total: details.total });
            output.enqueue(value);
          } catch {
            const cancelled = controller.signal.aborted && !timedOut;
            controller.abort();
            await reader.cancel().catch(() => {});
            finish();
            const message = timedOut ? 'Drive stopped responding for 30 seconds.' : 'Media transfer interrupted. Close and retry this session.';
            if (!cancelled) onError(message);
            output.error(new Error(message));
          }
        },
        async cancel() { controller.abort(); await reader.cancel().catch(() => {}); finish(); },
      });
      return new Response(body, { status: 206, headers: {
        'Content-Type': 'video/mp4', 'Content-Range': `bytes ${details.start}-${details.end}/${details.total}`,
        'Content-Length': String(details.length), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
      } });
    } catch (error) {
      controller.abort();
      try { await upstream?.body?.cancel(); } catch { /* Already closed. */ }
      finish();
      if (timedOut) throw new Error('Drive stopped responding for 30 seconds.');
      if (error instanceof TypeError) fail('UPSTREAM_ACCESS_FAILED', 'Drive API access failed. Check CORS, key restrictions, network access, and redirects.');
      throw error;
    }
  }
  return { parseRange, validateResponse, openRange, loadMetadata };
})();
