// Optional local fixture integration: two independent, disposable Edge profiles.
// This does NOT replace the operator's real Drive acceptance test.
// Usage: node tests/peer-browser.mjs [path-to-Chromium-browser]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createCoordinator } from '../p2p/coordinator.mjs';
const root = new URL('../', import.meta.url);
const files = ['p2p/core.js','p2p/cache.js','p2p/network.js','p2p/broker.js','p2p/setup.html','p2p/setup.js','stream/peer/index.html','stream/peer/player.js','stream/peer/worker.js','stream/bridge.js','styles.css','drive-player.css','media-controls.js'];
let fixture, manifest, coordinator, fullDownloads = 0, ranges = 0;
const http = createServer(async (req, res) => {
  if (await coordinator.handle(req, res)) return;
  if (req.url === '/p2p/manifest.json') { if (!manifest) { res.writeHead(404).end(); return; } res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(manifest)); return; }
  if (req.url === '/fixture/metadata') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: '1-XFihL-VwXZK1J7o81nQwm5WuJyYExP9', size: String(fixture.length), version: '1', mimeType: 'video/mp4' })); return; }
  if (req.url === '/fixture/media') {
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    let start = 0, end = fixture.length - 1;
    if (range) { ranges++; start = +range[1]; end = Math.min(+range[2], end); } else fullDownloads++;
    // Content-Range intentionally absent: exercise the metadata mapping path.
    res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1 });
    let offset = start;
    const timer = setInterval(() => { const next = Math.min(end + 1, offset + 65536); res.write(fixture.subarray(offset, next)); offset = next; if (offset > end) { clearInterval(timer); res.end(); } }, 3);
    res.on('close', () => clearInterval(timer)); return;
  }
  const path = req.url === '/stream/peer/' ? '/stream/peer/index.html' : req.url;
  if (!files.includes(path?.slice(1))) { res.writeHead(404).end(); return; }
  try {
    let body = await readFile(new URL(path.slice(1), root));
    if (path === '/stream/peer/player.js' || path === '/p2p/setup.js') {
      // Test-only transport injection; production files and real keys are untouched.
      const prefix = `const fixtureFetch = window.fetch.bind(window); window.fetch = (input, options) => { const url = new URL(input, location.href); return fixtureFetch(url.origin === 'https://www.googleapis.com' ? (url.searchParams.has('fields') ? '/fixture/metadata' : '/fixture/media') : input, options); };\n`;
      body = Buffer.concat([Buffer.from(prefix), body]);
    }
    res.writeHead(200, { 'Content-Type': path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript', 'Cache-Control': 'no-store' }).end(body);
  } catch { res.writeHead(500).end(); }
});
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${http.address().port}`;
coordinator = createCoordinator({ origin, getManifest: async () => { if (!manifest) throw new Error('Missing manifest'); return manifest; } });
const executable = process.argv[2] || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const browsers = [];
async function browser() {
  const profile = await mkdtemp(join(tmpdir(), 'embed-peer-smoke-'));
  const process = spawn(executable, ['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','about:blank'], { windowsHide: true, stdio: ['ignore','ignore','pipe'] });
  const item = { process, socket: null }; browsers.push(item);
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(new Error('Browser startup timeout')), 15000);
    process.on('error', reject); process.stderr.on('data', chunk => { log += chunk; const match = /DevTools listening on (ws:\/\/\S+)/.exec(log); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const socket = new WebSocket(endpoint); item.socket = socket;
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data), task = pending.get(message.id);
    if (task) { clearTimeout(task.timer); pending.delete(message.id); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 25000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const navigate = async path => { await send('Page.navigate', { url: origin + path }, sessionId); await pause(400); };
  const wait = async (expression, label, timeout = 15000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (await evaluate(expression)) return; await pause(100); }
    throw new Error(`${label}: ${await evaluate(`document.body.innerText.slice(-2000)`)}`);
  };
  return { send, evaluate, navigate, wait };
}
try {
  const a = await browser(), b = await browser();
  await a.navigate('/p2p/setup.html');
  const encoded = await a.evaluate(`(async () => {
    const mime = ['video/mp4;codecs=avc1.42001E','video/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mime) throw new Error('MP4 MediaRecorder unavailable');
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    const ctx=canvas.getContext('2d'),stream=canvas.captureStream(20),chunks=[];
    const recorder=new MediaRecorder(stream,{mimeType:mime});recorder.ondataavailable=e=>chunks.push(e.data);
    const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.start();let frame=0;
    const timer=setInterval(()=>{ctx.fillStyle=frame++%2?'#245244':'#142c40';ctx.fillRect(0,0,320,180);ctx.fillStyle='#fff';ctx.fillText('Fixture '+frame,20,90);},50);
    await new Promise(resolve=>setTimeout(resolve,2600));clearInterval(timer);recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());
    const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);
  })()`);
  const mp4 = Buffer.from(encoded, 'base64');
  const padding = Buffer.alloc(3 * 1048576); padding.writeUInt32BE(padding.length); padding.write('free', 4);
  fixture = Buffer.concat([mp4, padding]);
  await a.evaluate(`document.getElementById('publisher-key').value='fixture-key';document.getElementById('publisher-consent').checked=true;document.getElementById('publisher-form').requestSubmit()`);
  await a.wait(`!document.getElementById('publisher-export').hidden`, 'Operator bootstrap failed');
  manifest = await a.evaluate(`fetch(document.getElementById('publisher-export').href).then(response=>response.json())`);
  assert.equal(manifest.hashes.length, 4); assert.equal(fullDownloads, 1);
  console.log('PASS operator bootstrap: bounded blocks saved in IndexedDB; manifest exported; version checked.');
  const prepare = async (client, key = '') => {
    await client.navigate('/stream/peer/');
    await client.evaluate(`document.getElementById('stream-key').value=${JSON.stringify(key)};document.getElementById('stream-form').requestSubmit()`);
    await client.wait(`typeof current !== 'undefined' && !!current`, 'Viewer preparation failed');
  };
  const sharing = async client => {
    await client.evaluate(`document.getElementById('peer-consent').checked=true;document.getElementById('peer-toggle').click()`);
    await client.wait(`current.broker.network?.token && !document.getElementById('peer-toggle').disabled`, 'Sharing startup failed');
  };
  await prepare(a);
  assert.equal(await a.evaluate(`document.getElementById('peer-upload-limit').valueAsNumber`), 4);
  await sharing(a);
  assert.equal(await a.evaluate(`current.broker.network.uploadBytesPerSecond`), 4 * 1048576);
  assert.equal(await a.evaluate(`document.getElementById('peer-upload-limit').disabled`), true);
  await prepare(b, 'fixture-key'); await sharing(b);
  assert.match(await a.evaluate(`(async()=>{const other=new PeerNetwork({manifest:current.manifest,getBlock:async()=>null,inventory:async()=>[]});try{await other.start();return 'unexpected second owner';}catch(error){return error.message;}finally{other.close();}})()`), /Another tab/);
  await b.wait(`current.broker.network.candidates.length && [...current.broker.network.peers.values()].some(peer=>peer.channel?.readyState==='open')`, 'Real WebRTC connection failed');
  const started = Date.now();
  const received = await b.evaluate(`current.broker.block(0).then(bytes=>bytes.length)`);
  assert.equal(received, 1048576); assert.equal(ranges, 0); assert.equal(await b.evaluate('current.broker.stats.peer'), 1048576);
  assert.ok(Date.now() - started >= 200, 'Default upload payload should remain paced at 4 MiB/s');
  assert.equal(await b.evaluate('cache.usage()'), 1048576);
  console.log('PASS independent profiles: real WebRTC transferred a verified 1 MiB block; no origin range; payload paced and saved.');
  await a.evaluate(`document.getElementById('peer-toggle').click()`);
  assert.equal(await a.evaluate(`document.getElementById('peer-upload-limit').disabled`), false);
  await a.evaluate(`document.getElementById('peer-upload-limit').value='0.5'`);
  await sharing(a);
  const renewedId = await a.evaluate('current.broker.network.id');
  await b.wait(`current.broker.network.candidates.some(candidate=>candidate.peerId===${JSON.stringify(renewedId)}) && current.broker.network.peers.get(${JSON.stringify(renewedId)})?.channel?.readyState==='open'`, 'Peer reconnect at changed upload rate failed');
  const slowStarted = Date.now();
  assert.equal(await b.evaluate(`current.broker.block(1).then(bytes=>bytes.length)`), 1048576);
  assert.ok(Date.now() - slowStarted >= 1750, 'Selected 0.5 MiB/s payload cap must be respected');
  assert.equal(ranges, 0);
  console.log('PASS UI upload configuration: 4 MiB/s default, locked while sharing; re-enabled at 0.5 MiB/s with observed pacing.');
  // Reload B into the same disposable profile: the key is absent and local data survives.
  await prepare(b, 'fixture-key');
  assert.equal(await b.evaluate(`current.broker.block(0).then(()=>current.broker.stats.cache)`), 1048576); assert.equal(ranges, 0);
  await a.evaluate(`document.getElementById('stop-stream').click()`);
  assert.equal(await b.evaluate(`current.broker.block(3).then(bytes=>bytes.length)`), fixture.length - 3 * 1048576);
  assert.equal(ranges, 1);
  console.log('PASS reload reused IndexedDB; unavailable peer fell back to one missing Drive-fixture range only.');
  await b.evaluate(`document.getElementById('load-video').click()`);
  await b.wait(`!document.getElementById('custom-controls').hidden`, 'Native video metadata failed');
  await b.evaluate(`document.getElementById('play-pause').click()`);
  await b.wait(`document.querySelector('video').currentTime > 0.15`, 'Native playback did not advance');
  await b.evaluate(`document.querySelector('video').pause();document.querySelector('video').currentTime=1.5`);
  await b.wait(`!document.querySelector('video').seeking && Math.abs(document.querySelector('video').currentTime-1.5)<0.3`, 'Native seek failed');
  await b.evaluate(`document.getElementById('stop-stream').click()`);
  assert.equal(await b.evaluate('localStorage.length + sessionStorage.length'), 0);
  assert.equal(await b.evaluate(`document.getElementById('stream-key').value`), '');
  await b.evaluate(`globalThis.confirm=()=>true;document.getElementById('cache-delete').click()`);
  await b.wait(`document.getElementById('playback-status').textContent.includes('deleted')`, 'Cache deletion failed');
  assert.equal(await b.evaluate('cache.usage()'), 0);
  // Exercise real IndexedDB eviction using a reduced test-only payload budget.
  assert.equal(await b.evaluate(`(async()=>{
    const limit=PeerCore.MAX_BYTES,bytes=new Uint8Array(32),hash=await PeerCore.digest(bytes);
    let release=()=>{};
    try {
      PeerCore.MAX_BYTES=32;
      await cache.putDraft({contentId:'old-fixture',size:32},0,bytes,hash);
      release=await cache.pin('old-fixture');
      let refused=false;try{await cache.putDraft({contentId:'new-fixture',size:32},0,bytes,hash);}catch{refused=true;}
      if(!refused || await cache.usage()!==32) return false;
      release();release=()=>{};
      await cache.putDraft({contentId:'new-fixture',size:32},0,bytes,hash);
      return await cache.get('old-fixture',0)===null && (await cache.get('new-fixture',0)).length===32;
    } finally {release();PeerCore.MAX_BYTES=limit;await cache.clear();}
  })()`), true);
  console.log('PASS real IndexedDB cap/eviction: pinned content protected; inactive data evicted; confirmed deletion.');
  console.log('PASS scoped Service Worker: native MP4 playback and seek; close clears active session/key. Real Drive acceptance remains pending.');
  for (const client of [a,b]) await client.send('Browser.close');
} finally {
  for (const item of browsers) { item.socket?.close(); if (item.process.exitCode === null) item.process.kill(); }
  coordinator.close(); http.closeAllConnections(); http.close();
}
