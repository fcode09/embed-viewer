const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');

async function server(t) {
  const { createCoordinator } = await import('../p2p/coordinator.mjs');
  let coordinator;
  const http = createServer((req, res) => coordinator.handle(req, res));
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  coordinator = createCoordinator({ origin, getManifest: async () => ({ contentId: 'trusted', hashes: ['a','b'] }) });
  t.after(() => { coordinator.close(); http.closeAllConnections(); http.close(); });
  async function post(path, value, token, from = origin) {
    return fetch(origin + path, { method: 'POST', headers: { Origin: from, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
  }
  return { origin, post };
}
test('coordinator admits only trusted same-origin content and RAM session tokens', async t => {
  const { post } = await server(t);
  assert.equal((await post('/p2p/session', { contentId: 'trusted' }, null, 'http://attacker.test')).status, 403);
  assert.equal((await post('/p2p/session', { contentId: 'invented' })).status, 409);
  const response = await post('/p2p/session', { contentId: 'trusted' }); assert.equal(response.status, 201);
  const session = await response.json(); assert.equal(session.token.length, 64);
  assert.equal((await post('/p2p/message', { type: 'heartbeat' }, 'invalid')).status, 401);
  assert.equal((await post('/p2p/message', { type: 'announce', have: [3], free: true }, session.token)).status, 400);
  assert.equal((await post('/p2p/message', { type: 'heartbeat', key: 'must-not-accept' }, session.token)).status, 400);
  assert.equal((await post('/p2p/message', { type: 'announce', have: [0,1], free: true }, session.token)).status, 200);
  assert.equal((await post('/p2p/message', { type: 'leave' }, session.token)).status, 200);
  assert.equal((await post('/p2p/message', { type: 'heartbeat' }, session.token)).status, 401);
});
test('SSE forwards bounded same-room signals without a media endpoint', async t => {
  const { post, origin } = await server(t);
  const a = await (await post('/p2p/session', { contentId: 'trusted' })).json();
  const b = await (await post('/p2p/session', { contentId: 'trusted' })).json();
  const controller = new AbortController(); t.after(() => controller.abort());
  // A browser's same-origin GET normally has Fetch Metadata but no Origin.
  const events = await fetch(origin + '/p2p/events', { headers: { 'Sec-Fetch-Site': 'same-origin', Authorization: `Bearer ${b.token}` }, signal: controller.signal });
  const reader = events.body.getReader(); const decoder = new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value), /ready/);
  assert.equal((await post('/p2p/message', { type: 'signal', to: b.peerId, kind: 'connect', payload: '' }, a.token)).status, 200);
  assert.match(decoder.decode((await reader.read()).value), /"kind":"connect"/);
  assert.equal((await post('/p2p/message', { type: 'signal', to: b.peerId, kind: 'offer', payload: 'x'.repeat(32769) }, a.token)).status, 400);
  controller.abort(); await reader.cancel().catch(() => {});
});
