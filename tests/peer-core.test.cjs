const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../p2p/core.js');

async function fixture(size = PeerCore.BLOCK_SIZE + 8) {
  const bytes = new Uint8Array(size); bytes.set([102, 116, 121, 112], 4);
  const meta = { schema: 1, fileId: PeerCore.FILE_ID, version: '7', size, mimeType: 'video/mp4', blockSize: PeerCore.BLOCK_SIZE };
  meta.contentId = await PeerCore.contentId(meta);
  meta.hashes = [];
  for (let offset = 0; offset < size; offset += PeerCore.BLOCK_SIZE) meta.hashes.push(await PeerCore.digest(bytes.slice(offset, offset + PeerCore.BLOCK_SIZE)));
  return { bytes, manifest: meta };
}
test('manifest identity, bounded size, hash count, and block digest are enforced', async () => {
  const { bytes, manifest } = await fixture();
  assert.equal((await PeerCore.validateManifest(manifest)).contentId, manifest.contentId);
  for (const patch of [{ size: PeerCore.MAX_BYTES + 1 }, { hashes: [] }, { contentId: '0'.repeat(64) }, { fileId: 'another-file' }, { version: '' }]) await assert.rejects(PeerCore.validateManifest({ ...manifest, ...patch }));
  assert.equal((await PeerCore.verifyBlock(manifest, 1, bytes.slice(PeerCore.BLOCK_SIZE))).length, 8);
  await assert.rejects(PeerCore.verifyBlock(manifest, 0, new Uint8Array(2)));
  const corrupt = bytes.slice(0, PeerCore.BLOCK_SIZE); corrupt[0]++;
  await assert.rejects(PeerCore.verifyBlock(manifest, 0, corrupt));
  assert.throws(() => PeerCore.blockLength(manifest, -1));
});
test('operator bootstrap stores one-MiB blocks and checks version before/after; header-only key', async () => {
  const { bytes, manifest } = await fixture();
  const stored = [], calls = []; let saved;
  const result = await PeerCore.bootstrap({ key: 'test-not-a-real-key', signal: new AbortController().signal, cache: {
    putDraft: async (meta, index, data, hash) => { stored.push({ index, length: data.length, hash }); },
    saveManifest: async value => { saved = value; }, delete: async () => {},
  } }, async (url, options) => {
    calls.push(url); assert.ok(!url.includes('test-not-a-real-key')); assert.equal(options.headers['X-Goog-Api-Key'], 'test-not-a-real-key'); assert.equal(options.credentials, 'omit');
    return url.includes('fields=') ? Response.json({ id: PeerCore.FILE_ID, version: '7', size: String(bytes.length), mimeType: 'video/mp4' }) : new Response(bytes, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) } });
  });
  assert.equal(calls.length, 3); assert.equal(stored.length, 2); assert.equal(stored[0].length, PeerCore.BLOCK_SIZE);
  assert.equal(result.contentId, manifest.contentId); assert.deepEqual(saved.hashes, manifest.hashes);
});
test('bootstrap detects changed source version and removes incomplete draft', async () => {
  const { bytes } = await fixture(24); let metadata = 0; const removed = [];
  await assert.rejects(PeerCore.bootstrap({ key: 'dummy', cache: { putDraft: async () => {}, saveManifest: async () => assert.fail('must not publish'), delete: async (id, index) => removed.push(index) } }, async url => url.includes('fields=') ? Response.json({ id: PeerCore.FILE_ID, mimeType: 'video/mp4', size: '24', version: String(++metadata) }) : new Response(bytes, { headers: { 'Content-Type': 'video/mp4' } })), /changed during/);
  assert.deepEqual(removed, [0]);
});
test('a repeated failed bootstrap does not remove a previously valid cached block', async () => {
  const { bytes } = await fixture(24); let metadata = 0;
  await assert.rejects(PeerCore.bootstrap({ key: 'dummy', cache: { get: async () => bytes, putDraft: async () => assert.fail('valid block need not be rewritten'), saveManifest: async () => assert.fail('must not publish'), delete: async () => assert.fail('must retain previous valid block') } }, async url => url.includes('fields=') ? Response.json({ id: PeerCore.FILE_ID, mimeType: 'video/mp4', size: '24', version: String(++metadata) }) : new Response(bytes, { headers: { 'Content-Type': 'video/mp4' } })), /changed during/);
});
test('bounded JSON rejects excess bytes and wrong MIME', async () => {
  await assert.rejects(PeerCore.boundedJson(Response.json({ big: 'x'.repeat(1000) }), 64), /safety limit/);
  await assert.rejects(PeerCore.boundedJson(new Response('{}')), /JSON/);
  await assert.rejects(PeerCore.boundedJson(new Response('do-not-echo-a-key', { headers: { 'Content-Type': 'application/json' } })), error => error.message === 'Invalid JSON response.');
});
