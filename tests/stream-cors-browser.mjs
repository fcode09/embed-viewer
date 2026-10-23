// Optional integration smoke test. All API responses are local synthetic fixtures.
// Usage: node tests/stream-cors-browser.mjs [path-to-chromium-browser]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = new URL('../', import.meta.url);
const assets = new Map([
  ['/stream/', 'stream/index.html'], ['/stream/player.js', 'stream/player.js'],
  ['/stream/worker.js', 'stream/worker.js'], ['/stream/bridge.js', 'stream/bridge.js'],
  ['/styles.css', 'styles.css'], ['/drive-player.css', 'drive-player.css'], ['/media-controls.js', 'media-controls.js'],
]);
let fixture;
let metadataCalls = 0;
let sent = 0;
const ranges = [];
const fixtureServer = createServer((request, response) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'X-Goog-Api-Key, Range', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
  if (request.method === 'OPTIONS') { response.writeHead(204, cors).end(); return; }
  if (request.headers['x-goog-api-key'] !== 'fixture-key') { response.writeHead(403, cors).end(); return; }
  if (request.url === '/metadata') {
    metadataCalls++;
    response.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ id: '1-XFihL-VwXZK1J7o81nQwm5WuJyYExP9', size: String(fixture.length), mimeType: 'video/mp4' }));
    return;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || '');
  if (!range || !fixture) { response.writeHead(400, cors).end(); return; }
  ranges.push(request.headers.range);
  const start = range[1] ? Number(range[1]) : Math.max(0, fixture.length - Number(range[2]));
  const end = range[1] ? Math.min(range[2] ? Number(range[2]) : fixture.length - 1, fixture.length - 1) : fixture.length - 1;
  if (start >= fixture.length) { response.writeHead(416, cors).end(); return; }
  // Intentionally do NOT expose Content-Range through CORS.
  response.writeHead(206, { ...cors, 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${fixture.length}` });
  let position = start;
  const interval = setInterval(() => {
    const next = Math.min(end + 1, position + 8192);
    sent += next - position;
    response.write(fixture.subarray(position, next));
    position = next;
    if (position > end) { clearInterval(interval); response.end(); }
  }, 30);
  response.on('close', () => clearInterval(interval));
});
await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
const fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;
const appServer = createServer(async (request, response) => {
  const asset = assets.get(request.url);
  if (!asset) { response.writeHead(404).end(); return; }
  try {
    let body = await readFile(new URL(asset, root));
    if (asset === 'stream/worker.js') {
      // Dependency injection for this test only; production assets are not changed.
      const prefix = `const fixtureFetch = self.fetch.bind(self); self.fetch = (input, options) => { const url = new URL(input); if (url.origin !== 'https://www.googleapis.com') throw new Error('Unexpected test destination'); return fixtureFetch(${JSON.stringify(fixtureOrigin)} + (url.searchParams.has('fields') ? '/metadata' : '/media'), options); };\n`;
      body = Buffer.concat([Buffer.from(prefix), body]);
    }
    response.writeHead(200, { 'Content-Type': asset.endsWith('.html') ? 'text/html' : asset.endsWith('.css') ? 'text/css' : 'text/javascript', 'Cache-Control': 'no-store' }).end(body);
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
const appOrigin = `http://127.0.0.1:${appServer.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'embed-cors-smoke-'));
const executable = process.argv[2] || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error('Browser launch timed out')), 15000);
    browser.on('error', error => { clearTimeout(timer); reject(error); });
    browser.stderr.on('data', chunk => { log += chunk; const match = /DevTools listening on (ws:\/\/\S+)/.exec(log); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  socket = new WebSocket(endpoint);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const item = pending.get(message.id);
    if (item) { clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  await send('Page.navigate', { url: `${appOrigin}/stream/` }, sessionId);
  await pause(300);
  const encoded = await evaluate(`(async () => {
    const mime = ['video/mp4;codecs=avc1.42001E', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mime) throw new Error('This test requires MP4 MediaRecorder support');
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d'); const stream = canvas.captureStream(20);
    const recorder = new MediaRecorder(stream, { mimeType: mime }); const chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise(resolve => recorder.onstop = resolve); recorder.start(); let frame = 0;
    const timer = setInterval(() => { context.fillStyle = frame++ % 2 ? '#245244' : '#142c40'; context.fillRect(0,0,320,180); context.fillStyle = '#d2f7b6'; context.font = '24px sans-serif'; context.fillText('CORS fixture ' + frame,20,90); }, 50);
    await new Promise(resolve => setTimeout(resolve,2600)); clearInterval(timer); recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer()); let text = '';
    for (let i=0;i<bytes.length;i+=8192) text += String.fromCharCode(...bytes.subarray(i,i+8192)); return btoa(text);
  })()`);
  fixture = Buffer.from(encoded, 'base64');
  assert.equal(ranges.length, 0);
  await evaluate(`document.getElementById('stream-key').value = 'fixture-key'; document.getElementById('stream-form').requestSubmit()`);
  for (let i = 0; i < 120; i++) {
    if (await evaluate(`!document.getElementById('custom-controls').hidden`)) break;
    await pause(100);
  }
  const diagnostics = await evaluate(`document.getElementById('stream-diagnostics').textContent`);
  assert.match(diagnostics, /CONTENT_RANGE_FROM_METADATA/);
  assert.equal(await evaluate(`document.getElementById('custom-controls').hidden`), false, await evaluate(`document.getElementById('playback-status').textContent`));
  assert.equal(metadataCalls, 1);
  assert.equal(await evaluate(`document.getElementById('stream-key').value`), '');
  await evaluate(`document.getElementById('play-pause').click()`);
  await pause(650);
  assert.ok(await evaluate(`document.querySelector('video').currentTime`) > 0.1);
  console.log(`PASS browser metadata fallback with CORS-hidden Content-Range; playback advanced; ${sent} transferred bytes for ${fixture.length}-byte synthetic MP4.`);
  await evaluate(`document.getElementById('play-pause').click(); document.getElementById('seek').value='1.5'; document.getElementById('seek').dispatchEvent(new Event('input'))`);
  await pause(300);
  assert.ok(Math.abs(await evaluate(`document.querySelector('video').currentTime`) - 1.5) < 0.3);
  await evaluate(`document.getElementById('stop-stream').click()`);
  assert.equal(await evaluate(`document.querySelector('video').hasAttribute('src')`), false);
  assert.equal(await evaluate(`localStorage.length + sessionStorage.length`), 0);
  console.log('PASS native seek, close, no key storage. All API data was local fixture data; real Drive remains a user-key check.');
  await send('Browser.close');
} finally {
  socket?.close();
  if (browser.exitCode === null) browser.kill();
  appServer.closeAllConnections(); appServer.close();
  fixtureServer.closeAllConnections(); fixtureServer.close();
}
