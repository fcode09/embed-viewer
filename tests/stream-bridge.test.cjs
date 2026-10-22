const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const code = readFileSync(join(__dirname, '../stream/bridge.js'), 'utf8');
function setup() {
  return runInNewContext(`${code}\nDriveRange;`, { AbortController, Response, ReadableStream, TextDecoder, TypeError, setTimeout, clearTimeout });
}
function partial({ status = 206, contentRange = 'bytes 0-1023/4096', length = '1024', mime = 'video/mp4', body = new Uint8Array(1024) } = {}) {
  const headers = { 'Content-Type': mime };
  if (contentRange !== null) headers['Content-Range'] = contentRange;
  if (length !== null) headers['Content-Length'] = length;
  return new Response(body, { status, headers });
}

test('accepts bounded, open, suffix and zero-start ranges', () => {
  const { parseRange } = setup();
  for (const value of ['bytes=0-1023', 'bytes=1024-', 'bytes=-512', 'bytes=0-0']) assert.ok(parseRange(value));
});
test('rejects missing, multiple, inverted and unsafe ranges', () => {
  const { parseRange } = setup();
  for (const value of [null, '', 'bytes=-', 'bytes=-0', 'bytes=9-2', 'bytes=0-1,4-5', 'bytes=9007199254740992-', 'items=0-1']) assert.throws(() => parseRange(value));
});
test('checks response metadata for bounded, suffix and short open ranges', () => {
  const { parseRange, validateResponse } = setup();
  assert.equal(validateResponse(partial(), parseRange('bytes=0-1023')).total, 4096);
  assert.equal(validateResponse(partial({ contentRange: 'bytes 3584-4095/4096', length: '512' }), parseRange('bytes=-512')).length, 512);
  assert.equal(validateResponse(partial(), parseRange('bytes=0-')).length, 1024);
});
test('fails closed for missing CORS-readable headers, HTML, wrong offsets and oversized source', () => {
  const { parseRange, validateResponse } = setup();
  for (const options of [{ status: 200 }, { status: 403 }, { contentRange: null }, { length: null }, { length: '999' }, { mime: 'text/html' }, { contentRange: 'bytes 1-1024/4096' }, { contentRange: 'bytes 0-1023/999999999' }, { contentRange: 'bytes 0-512/4096', length: '513' }]) {
    assert.throws(() => validateResponse(partial(options), parseRange('bytes=0-1023')));
  }
});
test('streams validated bytes with key only in header and no cookies/cache/redirects', async () => {
  const { openRange } = setup();
  const controller = new AbortController();
  let transferred = 0;
  let finished = 0;
  const result = await openRange({ range: 'bytes=0-1023', key: 'fixture-key', controller, onBytes: p => { transferred += p.bytes; }, onFinish: () => { finished++; } }, async (url, options) => {
    assert.equal(new URL(url).hostname, 'www.googleapis.com');
    assert.equal(new URL(url).searchParams.has('key'), false);
    assert.equal(options.headers['X-Goog-Api-Key'], 'fixture-key');
    assert.equal(options.headers.Range, 'bytes=0-1023');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    return partial();
  });
  assert.equal(result.status, 206);
  assert.equal(result.headers.get('content-range'), 'bytes 0-1023/4096');
  assert.equal((await result.arrayBuffer()).byteLength, 1024);
  assert.equal(transferred, 1024);
  assert.equal(finished, 1);
});
test('returns response before the entire upstream body arrives', async () => {
  const { openRange } = setup();
  let source;
  const upstream = partial({ body: new ReadableStream({ start(controller) { source = controller; } }) });
  const result = await openRange({ range: 'bytes=0-1023', key: 'fixture-key', controller: new AbortController() }, async () => upstream);
  const reader = result.body.getReader();
  source.enqueue(new Uint8Array(16));
  const first = await reader.read();
  assert.equal(first.value.length, 16);
  assert.equal(first.done, false);
  await reader.cancel();
});
test('consumer cancellation aborts the upstream fetch', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const upstream = partial({ body: new ReadableStream({ cancel() { cancelled = true; } }) });
  const result = await setup().openRange({ range: 'bytes=0-1023', key: 'fixture-key', controller }, async () => upstream);
  await result.body.cancel();
  assert.equal(controller.signal.aborted, true);
  assert.equal(cancelled, true);
});
test('rejects truncated and oversized streams', async () => {
  for (const bytes of [512, 2048]) {
    const controller = new AbortController();
    const result = await setup().openRange({ range: 'bytes=0-1023', key: 'fixture-key', controller }, async () => partial({ body: new Uint8Array(bytes) }));
    await assert.rejects(result.arrayBuffer(), /Media transfer interrupted/);
    assert.equal(controller.signal.aborted, true);
  }
});
test('invalid headers cancel the response before media bytes are read', async () => {
  let cancelled = false;
  const upstream = partial({ status: 200, body: new ReadableStream({ cancel() { cancelled = true; } }) });
  await assert.rejects(setup().openRange({ range: 'bytes=0-1023', key: 'fixture-key', controller: new AbortController() }, async () => upstream), /HTTP 200/);
  assert.equal(cancelled, true);
});
test('network errors do not disclose raw remote errors', async () => {
  await assert.rejects(setup().openRange({ range: 'bytes=0-1023', key: 'fixture-key', controller: new AbortController() }, async () => { throw new TypeError('fixture-key in error'); }), error => {
    assert.match(error.message, /Drive API access failed/);
    assert.doesNotMatch(error.message, /fixture-key/);
    return true;
  });
});

test('maps a CORS-hidden Content-Range from verified file size and exact partial length', () => {
  const { parseRange, validateResponse } = setup();
  const details = validateResponse(partial({ contentRange: null }), parseRange('bytes=0-1023'), 4096);
  assert.equal(details.start, 0);
  assert.equal(details.end, 1023);
  assert.equal(details.total, 4096);
  assert.equal(details.rangeSource, 'metadata');
});

test('uses metadata only when Content-Range is hidden and streams the derived local response', async () => {
  let lookups = 0;
  const response = await setup().openRange({
    range: 'bytes=0-1023', key: 'fixture-key', controller: new AbortController(),
    getMetadata: async () => { lookups++; return { size: 4096 }; },
  }, async () => partial({ contentRange: null }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-1023/4096');
  assert.equal((await response.arrayBuffer()).byteLength, 1024);
  assert.equal(lookups, 1);
});

test('derives open and suffix ranges but rejects bad lengths, totals and exposed malformed ranges', () => {
  const { parseRange, validateResponse } = setup();
  const open = validateResponse(partial({ contentRange: null, length: '3072' }), parseRange('bytes=1024-'), 4096);
  assert.equal(open.end, 4095);
  const suffix = validateResponse(partial({ contentRange: null, length: '512' }), parseRange('bytes=-512'), 4096);
  assert.equal(suffix.start, 3584);
  for (const size of [undefined, 0, -1, 999999999, NaN]) assert.throws(() => validateResponse(partial({ contentRange: null }), parseRange('bytes=0-1023'), size));
  for (const options of [{ length: null }, { length: '999' }, { length: '9999999' }, { contentRange: 'invalid' }]) assert.throws(() => validateResponse(partial({ contentRange: null, ...options }), parseRange('bytes=0-1023'), 4096));
});

test('visible valid Content-Range needs no metadata request', async () => {
  const response = await setup().openRange({ range: 'bytes=0-1023', key: 'fixture-key', controller: new AbortController(),
    getMetadata: async () => assert.fail('Must not request metadata when range is exposed'),
  }, async () => partial());
  await response.arrayBuffer();
});

function fileMetadata(data = { id: '1-XFihL-VwXZK1J7o81nQwm5WuJyYExP9', size: '4096', mimeType: 'video/mp4' }) {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}
test('loads only bounded, validated metadata using the same header-only key', async () => {
  const result = await setup().loadMetadata({ key: 'fixture-key', controller: new AbortController() }, async (url, options) => {
    assert.equal(new URL(url).searchParams.get('fields'), 'id,size,mimeType');
    assert.equal(new URL(url).searchParams.has('key'), false);
    assert.equal(options.headers['X-Goog-Api-Key'], 'fixture-key');
    assert.equal(options.credentials, 'omit');
    return fileMetadata();
  });
  assert.equal(result.size, 4096);
});

test('metadata validation rejects wrong identity, format, size and oversized JSON', async () => {
  for (const data of [null, {}, { id: 'another-file', size: '4096', mimeType: 'video/mp4' }, { id: '1-XFihL-VwXZK1J7o81nQwm5WuJyYExP9', size: '999999999', mimeType: 'video/mp4' }]) {
    await assert.rejects(setup().loadMetadata({ key: 'fixture-key', controller: new AbortController() }, async () => fileMetadata(data)), error => error.code === 'INVALID_METADATA');
  }
  await assert.rejects(setup().loadMetadata({ key: 'fixture-key', controller: new AbortController() }, async () => new Response(' '.repeat(4097), { headers: { 'Content-Type': 'application/json' } })), /4 KB/);
});
