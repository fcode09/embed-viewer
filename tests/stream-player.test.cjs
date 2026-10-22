const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const code = readFileSync(join(__dirname, '../stream/player.js'), 'utf8');

function setup() {
  const items = new Map();
  const element = id => {
    if (!items.has(id)) items.set(id, {
      value: '', textContent: '', disabled: false, hidden: false, events: {},
      addEventListener(name, callback) { this.events[name] = callback; },
      pause() {}, load() {}, removeAttribute() {}, focus() {},
    });
    return items.get(id);
  };
  const events = {};
  const controller = { scriptURL: 'http://localhost/stream/worker.js', postMessage() {} };
  const serviceWorker = {
    controller, ready: Promise.resolve(),
    register: async () => ({ active: controller }),
    addEventListener(name, callback) { events[name] = callback; },
  };
  const logs = [];
  let requestSignal;
  let respond;
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const context = {
    URL, AbortController, Uint8Array, TextDecoder, setTimeout, clearTimeout,
    crypto: { randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    document: { getElementById: element }, navigator: { serviceWorker },
    location: { href: 'http://localhost/stream/' }, isSecureContext: true,
    window: { addEventListener() {} },
    createVideoControls: () => ({ reset() {} }),
    console: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    fetch: async (url, options) => {
      requestSignal = options.signal;
      started();
      return new Promise(resolve => { respond = resolve; });
    },
  };
  runInNewContext(code, context);
  return { element, events, controller, logs, requestStarted, get signal() { return requestSignal; }, respond: response => respond(response) };
}

test('worker failure does not abort the probe before its error response can be inspected', async () => {
  const state = setup();
  state.element('stream-key').value = 'fixture-secret';
  const pending = state.element('stream-form').events.submit({ preventDefault() {} });
  await state.requestStarted;
  state.events.message({ source: state.controller, ports: [], data: {
    type: 'STREAM_ERROR', playbackId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    message: 'Content-Range is missing or not readable through CORS.', code: 'MISSING_CONTENT_RANGE', stage: 'range-validation',
  } });
  const prematurelyAborted = state.signal.aborted;
  state.respond(new Response(JSON.stringify({ message: 'Content-Range is missing or not readable through CORS.', code: 'MISSING_CONTENT_RANGE', stage: 'range-validation' }), { status: 502, headers: { 'Content-Type': 'application/json' } }));
  await pending;
  assert.equal(prematurelyAborted, false, 'Worker error must not hide its 502 behind a cancelled probe');
  assert.match(state.element('playback-status').textContent, /Content-Range/);
  assert.equal(state.element('prepare-stream').disabled, false);
  assert.doesNotMatch(JSON.stringify(state.logs), /fixture-secret/);
  assert.match(state.element('stream-diagnostics').textContent, /MISSING_CONTENT_RANGE/);
});

test('manual close still aborts the probe and does not expose the key in diagnostics', async () => {
  const state = setup();
  state.element('stream-key').value = 'fixture-secret';
  const pending = state.element('stream-form').events.submit({ preventDefault() {} });
  await state.requestStarted;
  state.element('stop-stream').events.click();
  assert.equal(state.signal.aborted, true);
  state.respond(new Response('cancelled', { status: 502 }));
  await pending;
  assert.doesNotMatch(state.element('stream-diagnostics').textContent, /fixture-secret/);
  assert.equal(state.element('stream-key').value, '');
});
