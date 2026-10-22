const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../p2p/core.js');
// The existing browser helper is a global lexical binding, not a CommonJS export.
globalThis.DriveRange = require('node:vm').runInThisContext(require('node:fs').readFileSync(require('node:path').join(__dirname, '../stream/bridge.js'), 'utf8') + '\nDriveRange;');
require('../p2p/broker.js');
async function setup() {
  const bytes = new Uint8Array(64); bytes.set([102,116,121,112], 4);
  const manifest = { schema: 1, fileId: PeerCore.FILE_ID, version: '1', size: bytes.length, mimeType: 'video/mp4', blockSize: PeerCore.BLOCK_SIZE, hashes: [await PeerCore.digest(bytes)] };
  manifest.contentId = await PeerCore.contentId(manifest);
  const rows = new Map();
  const cache = { get: async (id, index) => rows.get(index) || null, delete: async (id, index) => rows.delete(index), put: async (meta, index, data) => rows.set(index, data), indices: async () => [...rows.keys()] };
  let drive = 0;
  const broker = new PeerBroker({ manifest, cache, keyProvider: () => 'dummy', fetcher: async (url, options) => {
    drive++; assert.equal(options.headers.Range, 'bytes=0-63'); assert.equal(options.headers['X-Goog-Api-Key'], 'dummy');
    return new Response(bytes, { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Length': '64' } });
  } });
  return { bytes, broker, cache, rows, drive: () => drive };
}
test('cache wins, corrupt cache is discarded, concurrent requests coalesce; replay needs no Drive', async () => {
  const { bytes, rows, broker, drive } = await setup();
  rows.set(0, new Uint8Array(64));
  const values = await Promise.all([broker.block(0), broker.block(0)]);
  assert.deepEqual(values[0], bytes); assert.equal(drive(), 1);
  await broker.block(0); assert.equal(drive(), 1); assert.equal(broker.stats.cache, 64); broker.close();
});
test('verified peer supplies a block without originating a Drive request and saves it locally', async () => {
  const { bytes, rows, broker, drive } = await setup(); let changed = 0;
  broker.network = { life: new AbortController(), request: async () => bytes, changed: () => changed++, close() {} };
  await broker.block(0); assert.equal(drive(), 0); assert.deepEqual(rows.get(0), bytes); assert.equal(changed, 1); assert.equal(broker.stats.peer, 64);
  broker.close();
});
test('unavailable peer falls back to Drive, but serving a peer never causes Drive downloads', async () => {
  const { broker, drive } = await setup();
  assert.equal(await broker.localBlock(0), null); assert.equal(drive(), 0);
  broker.network = { life: new AbortController(), request: async () => null, changed() {}, close() {} };
  await broker.block(0); assert.equal(drive(), 1); broker.close();
});
test('cache failure is non-fatal; mismatched Drive bytes stop the source', async () => {
  const { broker, bytes } = await setup(); broker.cache.put = async () => { throw new Error('quota'); };
  assert.deepEqual(await broker.block(0), bytes); assert.equal(broker.saving, false); broker.close();
  const other = await setup(); other.broker.manifest.hashes[0] = '0'.repeat(64);
  await assert.rejects(other.broker.block(0), /regenerate/); assert.equal(other.broker.life.signal.aborted, true);
});
test('a missing key fails only on a cache/peer miss; closed sessions reject', async () => {
  const { broker } = await setup(); broker.keyProvider = () => '';
  await assert.rejects(broker.block(0), /restricted Drive key/); broker.close();
  await assert.rejects(broker.block(0));
});
test('a source never exceeds four simultaneous block loads and closing rejects its queue', async () => {
  const { broker } = await setup();
  const pending = [];
  for (let i = 0; i < 4; i++) await broker.slot();
  pending.push(broker.slot()); pending.push(broker.slot());
  assert.equal(broker.active, 4); assert.equal(broker.waiters.length, 2);
  broker.release(); await pending[0]; assert.equal(broker.active, 4);
  broker.close(); await assert.rejects(pending[1]);
});
