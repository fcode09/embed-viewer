const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const source = readFileSync(join(__dirname, '../drive-download.js'), 'utf8');

function setup() {
  const context = { AbortController, Blob, TypeError, setTimeout, clearTimeout };
  runInNewContext(source, context);
  return context.downloadDriveVideo;
}

function sample({ status = 200, mime = 'video/mp4', length = '16', chunks } = {}) {
  const bytes = new Uint8Array(16);
  bytes.set([102, 116, 121, 112], 4);
  const queue = chunks ? [...chunks] : [bytes];
  const state = { reads: 0, cancelled: false };
  const reader = {
    async read() { state.reads++; return queue.length ? { value: queue.shift(), done: false } : { done: true }; },
    async cancel() { state.cancelled = true; },
  };
  return { state, status, headers: new Map([['content-type', mime], ['content-length', length]]), body: { getReader: () => reader, async cancel() { state.cancelled = true; } } };
}

test('downloads with a header-only key and creates a browser Blob', async () => {
  const response = sample();
  const updates = [];
  const blob = await setup()('fixture-key', { onProgress: p => updates.push(p) }, async (url, options) => {
    assert.equal(new URL(url).hostname, 'www.googleapis.com');
    assert.equal(new URL(url).searchParams.has('key'), false);
    assert.equal(options.headers['X-Goog-Api-Key'], 'fixture-key');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Range, undefined);
    return response;
  });
  assert.equal(blob.type, 'video/mp4');
  assert.equal(blob.size, 16);
  assert.equal(updates[0].received, 16);
  assert.equal(response.state.cancelled, true);
});

test('refuses empty credentials without fetching', async () => {
  await assert.rejects(setup()(' ', {}, async () => assert.fail('Must not fetch')), /restricted/);
});

test('rejects HTTP errors, partial bodies, HTML and large declared files without reading', async () => {
  for (const options of [{ status: 403 }, { status: 206 }, { mime: 'text/html' }, { length: String(201 * 1048576) }]) {
    const response = sample(options);
    await assert.rejects(setup()('fixture-key', {}, async () => response));
    assert.equal(response.state.reads, 0);
    assert.equal(response.state.cancelled, true);
  }
});

test('accepts a split signature and an unknown total size', async () => {
  const bytes = new Uint8Array(16);
  bytes.set([102, 116, 121, 112], 4);
  const response = sample({ length: null, chunks: [bytes.subarray(0, 5), bytes.subarray(5)] });
  const blob = await setup()('fixture-key', {}, async () => response);
  assert.equal(blob.size, 16);
});

test('rejects incorrect signatures and truncated content', async () => {
  for (const response of [sample({ chunks: [new Uint8Array(16)] }), sample({ length: '20' }), sample({ chunks: [], length: null })]) {
    await assert.rejects(setup()('fixture-key', {}, async () => response));
    assert.equal(response.state.cancelled, true);
  }
});

test('enforces the streamed size cap independently of declared length', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  chunk.set([102, 116, 121, 112], 4);
  const response = sample({ length: null, chunks: Array(201).fill(chunk) });
  await assert.rejects(setup()('fixture-key', {}, async () => response), /200 MiB/);
  assert.equal(response.state.cancelled, true);
});

test('cancellation aborts the request and releases the body reader', async () => {
  const controller = new AbortController();
  const response = sample();
  let requestSignal;
  await assert.rejects(setup()('fixture-key', { signal: controller.signal }, async (url, options) => {
    requestSignal = options.signal;
    controller.abort();
    return response;
  }), error => error.name === 'AbortError');
  assert.equal(requestSignal.aborted, true);
  assert.equal(response.state.cancelled, true);
});

test('network errors do not echo remote messages or keys', async () => {
  await assert.rejects(setup()('fixture-key', {}, async () => { throw new TypeError('sensitive remote details'); }), error => {
    assert.match(error.message, /network access, CORS/);
    assert.doesNotMatch(error.message, /sensitive|fixture-key/);
    return true;
  });
});

test('idle timeout aborts download with an actionable message', async () => {
  let timeout;
  const context = { AbortController, Blob, TypeError, setTimeout: callback => { timeout = callback; return 1; }, clearTimeout() {} };
  runInNewContext(source, context);
  await assert.rejects(context.downloadDriveVideo('fixture-key', {}, async (url, options) => {
    timeout();
    options.signal.throwIfAborted();
  }), /30 seconds without data/);
});
