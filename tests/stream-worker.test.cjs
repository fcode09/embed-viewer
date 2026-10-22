const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const bridge = readFileSync(join(__dirname, '../stream/bridge.js'), 'utf8');
const worker = readFileSync(join(__dirname, '../stream/worker.js'), 'utf8');
const playback = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function setup(fetcher) {
  const handlers = {};
  const calls = [];
  const messages = [];
  const clients = new Map();
  function client(id, path = '/stream/') {
    const item = { id, type: 'window', url: `http://localhost${path}`, postMessage(data, ports) {
      messages.push({ id, ...data });
      if (data.type === 'DRIVE_KEY_REQUEST') { ports[0].postMessage({ key: `${id}-key` }); ports[0].close(); }
    } };
    clients.set(id, item);
    return item;
  }
  client('tab-a'); client('tab-b'); client('outside', '/index.html');
  const context = {
    URL, AbortController, Response, ReadableStream, MessageChannel, TextDecoder, TypeError, setTimeout, clearTimeout,
    importScripts() {},
    self: { registration: { scope: 'http://localhost/stream/' }, clients: { get: async id => clients.get(id), claim: async () => {} }, addEventListener: (name, fn) => { handlers[name] = fn; } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (fetcher) return fetcher(url, options);
      return new Response(new Uint8Array(1024), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-1023/4096', 'Content-Length': '1024' } });
    },
  };
  runInNewContext(`${bridge}\n${worker}`, context);
  function request({ id = 'tab-a', path = '/stream/media/sipcop.mp4', range = 'bytes=0-1023', query = `playback=${playback}`, method = 'GET' } = {}) {
    let response;
    const headers = new Headers(); if (range) headers.set('Range', range);
    handlers.fetch({ clientId: id, request: new Request(`http://localhost${path}?${query}`, { method, headers }), respondWith(value) { response = value; } });
    return response;
  }
  return { handlers, calls, messages, clients, request };
}

test('intercepts only the exact virtual media route', () => {
  const { request } = setup();
  assert.equal(request({ path: '/index.html' }), undefined);
  assert.equal(request({ path: '/stream/player.js' }), undefined);
  assert.equal(request({ path: '/stream/media/other.mp4' }), undefined);
});
test('rejects unrelated clients, invalid sessions, query keys and missing ranges without contacting Google', async () => {
  const state = setup();
  for (const options of [{ id: 'outside' }, { id: 'missing' }, { query: 'playback=invalid' }, { query: `playback=${playback}&key=not-allowed` }, { method: 'POST' }, { range: null }]) {
    const response = await state.request(options);
    assert.ok(response.status >= 400);
  }
  assert.equal(state.calls.length, 0);
});
test('obtains fresh per-tab keys for each request and preserves client isolation', async () => {
  const state = setup();
  for (const id of ['tab-a', 'tab-b', 'tab-a']) {
    const response = await state.request({ id });
    await response.arrayBuffer();
  }
  assert.deepEqual(state.calls.map(call => call.options.headers['X-Goog-Api-Key']), ['tab-a-key', 'tab-b-key', 'tab-a-key']);
  assert.equal(state.messages.filter(message => message.type === 'DRIVE_KEY_REQUEST').length, 3);
});
test('closing one tab cancels only its own transfer', async () => {
  const state = setup(async () => new Response(new ReadableStream(), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-1023/4096', 'Content-Length': '1024' } }));
  const first = await state.request();
  const second = await state.request({ id: 'tab-b' });
  state.handlers.message({ data: { type: 'STOP_STREAM', playbackId: playback }, source: state.clients.get('tab-a') });
  assert.equal(state.calls[0].options.signal.aborted, true);
  assert.equal(state.calls[1].options.signal.aborted, false);
  await first.body.cancel(); await second.body.cancel();
});
test('invalid close messages cannot cancel another client', async () => {
  const state = setup();
  const response = await state.request();
  state.handlers.message({ data: { type: 'STOP_STREAM', playbackId: playback }, source: state.clients.get('outside') });
  assert.equal(state.calls[0].options.signal.aborted, false);
  await response.body.cancel();
});
test('API failures return a typed failure without a full-download fallback', async () => {
  const state = setup(async () => new Response('denied', { status: 403 }));
  const response = await state.request();
  assert.equal(response.status, 502);
  assert.match(await response.text(), /HTTP 403/);
  assert.equal(state.calls.length, 1);
  assert.equal(state.messages.some(message => message.type === 'STREAM_ERROR'), true);
});

test('diagnostics retain safe headers and a structured metadata access failure', async () => {
  const state = setup(async url => new URL(url).searchParams.has('fields') ? new Response('fixture-private-response', { status: 403 }) : new Response('fixture-private-response', { status: 206, headers: {
    'Content-Type': 'video/mp4', 'Content-Length': '1024',
  } }));
  const response = await state.request();
  assert.equal(response.status, 502);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const failure = await response.json();
  assert.equal(failure.code, 'METADATA_HTTP');
  assert.equal(failure.stage, 'metadata-request');
  assert.equal(failure.workerVersion, 'range-metadata-v3');
  const headers = state.messages.find(message => message.type === 'STREAM_DIAGNOSTIC');
  assert.equal(headers.details.httpStatus, 206);
  assert.equal(headers.details.contentRange, 'missing or invalid');
  assert.doesNotMatch(JSON.stringify(state.messages), /fixture-private-response|tab-a-key/);
});

test('uses API metadata for hidden range headers, caches only size per session and clears it on close', async () => {
  const state = setup(async url => new URL(url).searchParams.has('fields') ? new Response(JSON.stringify({ id: '1-XFihL-VwXZK1J7o81nQwm5WuJyYExP9', mimeType: 'video/mp4', size: '4096' }), { headers: { 'Content-Type': 'application/json' } }) : new Response(new Uint8Array(1024), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Length': '1024' } }));
  for (let i = 0; i < 2; i++) {
    const response = await state.request();
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 0-1023/4096');
    await response.arrayBuffer();
  }
  assert.equal(state.calls.filter(call => new URL(call.url).searchParams.has('fields')).length, 1);
  assert.equal(state.messages.some(message => message.type === 'STREAM_DIAGNOSTIC' && message.details.code === 'CONTENT_RANGE_FROM_METADATA'), true);
  state.handlers.message({ source: state.clients.get('tab-a'), data: { type: 'STOP_STREAM', playbackId: playback } });
  const response = await state.request();
  await response.arrayBuffer();
  assert.equal(state.calls.filter(call => new URL(call.url).searchParams.has('fields')).length, 2);
});
