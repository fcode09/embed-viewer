const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const source = readFileSync(join(__dirname, '../drive-api-check.js'), 'utf8');

function setup(fetcher) {
  const elements = Object.fromEntries(['api-form', 'api-key', 'check', 'result'].map(id => [id, {
    value: '', disabled: false, events: {},
    addEventListener(name, action) { this.events[name] = action; },
  }]));
  const context = {
    document: { querySelector: selector => elements[selector.slice(1)] },
    location: { protocol: 'http:' },
    fetch: fetcher, AbortController, setTimeout, clearTimeout, TypeError,
  };
  runInNewContext(source, context);
  return { probe: context.checkDriveAccess, elements, context };
}

function response({ status = 206, mime = 'video/mp4', length = '1024', data } = {}) {
  const bytes = data ?? new Uint8Array(1024);
  if (!data) bytes.set([102, 116, 121, 112], 4);
  let read = false;
  const tracked = { reads: 0, cancelled: false };
  const reader = {
    async read() { tracked.reads++; if (read) return { done: true }; read = true; return { value: bytes, done: false }; },
    async cancel() { tracked.cancelled = true; },
  };
  return {
    status, tracked,
    headers: new Map([['content-type', mime], ['content-length', length]]),
    body: { getReader: () => reader, async cancel() { tracked.cancelled = true; } },
  };
}

test('validates a 1 KB MP4 fragment with no cookies and key only in a header', async () => {
  const sample = response();
  const { probe } = setup(async (url, options) => {
    assert.equal(new URL(url).hostname, 'www.googleapis.com');
    assert.equal(new URL(url).searchParams.get('key'), null);
    assert.equal(options.headers['X-Goog-Api-Key'], 'test-key');
    assert.equal(options.headers.Range, 'bytes=0-1023');
    assert.equal(options.credentials, 'omit');
    return sample;
  });
  const result = await probe('test-key');
  assert.equal(result.bytes, 1024);
  assert.equal(result.mimeType, 'video/mp4');
  assert.equal(sample.tracked.cancelled, true);
});

test('refuses an ignored Range request without reading the body', async () => {
  const sample = response({ status: 200 });
  await assert.rejects(setup(async () => sample).probe('test-key'), /206 partial/);
  assert.equal(sample.tracked.reads, 0);
  assert.equal(sample.tracked.cancelled, true);
});

test('rejects HTML and oversized declared bodies without reading them', async () => {
  for (const options of [{ mime: 'text/html' }, { length: '162154433' }]) {
    const sample = response(options);
    await assert.rejects(setup(async () => sample).probe('test-key'));
    assert.equal(sample.tracked.reads, 0);
    assert.equal(sample.tracked.cancelled, true);
  }
});

test('caps streamed content even without a Content-Length header', async () => {
  const sample = response({ length: null, data: new Uint8Array(2048) });
  await assert.rejects(setup(async () => sample).probe('test-key'), /exceeded the 1 KB/);
  assert.equal(sample.tracked.cancelled, true);
});

test('rejects incomplete data and an unexpected MP4 signature', async () => {
  for (const data of [new Uint8Array(512), new Uint8Array(1024)]) {
    await assert.rejects(setup(async () => response({ data })).probe('test-key'));
  }
});

test('clears the key input and restores the submit button', async () => {
  const { elements: e } = setup(async () => response());
  e['api-key'].value = 'test-key';
  await e['api-form'].events.submit({ preventDefault() {} });
  assert.equal(e['api-key'].value, '');
  assert.equal(e.check.disabled, false);
  assert.match(e.result.textContent, /Fragment check passed/);
});

test('does not issue requests without a key or from file URLs', async () => {
  let calls = 0;
  const { probe, elements: e, context } = setup(async () => { calls++; });
  await assert.rejects(probe('  '), /Enter a restricted/);
  context.location.protocol = 'file:';
  await e['api-form'].events.submit({ preventDefault() {} });
  assert.equal(calls, 0);
  assert.match(e.result.textContent, /node serve.mjs/);
});

test('reports network failure without echoing the key or remote error', async () => {
  const { elements: e } = setup(async () => { throw new TypeError('remote secret-value'); });
  e['api-key'].value = 'secret-value';
  await e['api-form'].events.submit({ preventDefault() {} });
  assert.match(e.result.textContent, /network access, CORS/);
  assert.doesNotMatch(e.result.textContent, /secret-value/);
  assert.equal(e.check.disabled, false);
});
