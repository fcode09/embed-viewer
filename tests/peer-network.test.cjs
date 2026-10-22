const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../p2p/core.js'); require('../p2p/network.js');
test('local upload defaults to four MiB/s with bounded configurable pacing', () => {
  const options = { manifest: {}, getBlock() {}, inventory() {} };
  const normal = new PeerNetwork(options);
  assert.equal(normal.uploadBytesPerSecond, 4 * 1048576);
  assert.equal(normal.uploadDelay(1048576, 0), 250);
  assert.equal(normal.uploadDelay(1048576, 100), 150);
  assert.equal(normal.uploadDelay(1048576, 300), 0);
  const slow = new PeerNetwork({ ...options, uploadBytesPerSecond: 524288 });
  assert.equal(slow.uploadDelay(1048576, 0), 2000);
  const fast = new PeerNetwork({ ...options, uploadBytesPerSecond: 8 * 1048576 });
  assert.equal(fast.uploadDelay(1048576, 0), 125);
});
test('invalid or unbounded upload rates are rejected before networking', () => {
  for (const uploadBytesPerSecond of [0, -1, NaN, Infinity, '4194304', 524287, 8 * 1048576 + 1]) {
    assert.throws(() => new PeerNetwork({ manifest: {}, uploadBytesPerSecond }), /between 0.5 and 8 MiB\/s/);
  }
});
async function setup() {
  const bytes = new Uint8Array(32), manifest = { contentId: 'trusted', size: 32, hashes: [await PeerCore.digest(bytes)] };
  let closed = false;
  const network = new PeerNetwork({ manifest, getBlock: async () => bytes, inventory: async () => [0] });
  const peer = { id: 'peer-a', score: 0, pc: { close: () => { closed = true; } }, channel: { readyState: 'open', send() {}, close() {} }, pending: null };
  network.peers.set(peer.id, peer); network.candidates = [{ peerId: peer.id, have: [0], free: true }];
  return { bytes, network, peer, closed: () => closed };
}
test('corrupt peer data is rejected and peer is cooled down instead of reaching playback', async () => {
  const { network, peer, closed } = await setup();
  peer.channel.send = () => queueMicrotask(() => { const corrupt = new Uint8Array(32); corrupt[0] = 1; peer.pending.resolve(corrupt); });
  assert.equal(await network.request(0), null); assert.equal(closed(), true); assert.ok(network.bad.get(peer.id) > Date.now()); network.close();
});
test('oversized binary frames close the channel; incomplete bytes never resolve a block', async () => {
  const { network, peer, closed } = await setup(); const channel = peer.channel;
  network.attach(peer, channel);
  channel.send = data => queueMicrotask(() => {
    const request = JSON.parse(data);
    channel.onmessage({ data: JSON.stringify({ type: 'begin', id: request.id, contentId: 'trusted', index: 0, length: 32 }) });
    channel.onmessage({ data: new ArrayBuffer(16385) });
  });
  assert.equal(await network.request(0), null); assert.equal(closed(), true); network.close();
});
test('useful upload cap and single-upload limit refuse without reading cache', async () => {
  const { network, peer } = await setup(); const messages = []; let reads = 0;
  network.getBlock = async () => { reads++; return new Uint8Array(32); };
  peer.channel.send = data => messages.push(JSON.parse(data));
  const request = { type: 'request', id: 'request-a', contentId: 'trusted', index: 0 };
  network.uploaded = PeerCore.MAX_BYTES;
  await network.sendBlock(peer, request); assert.equal(reads, 0); assert.equal(messages[0].type, 'error');
  network.uploaded = 0; network.uploading = true;
  await network.sendBlock(peer, request); assert.equal(reads, 0); network.close();
});
test('closing rejects a pending transfer and removes presence without persistent credentials', async () => {
  const { network, peer } = await setup();
  const pending = network.request(0); network.close();
  assert.equal(await pending, null); assert.equal(network.token, null); assert.equal(network.peers.size, 0); assert.equal(peer.pending, null);
});
