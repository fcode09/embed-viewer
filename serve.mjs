// Optional local preview only. The site itself has no backend dependency.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { createCoordinator } from './p2p/coordinator.mjs';
import './p2p/core.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/drive-api-check.html', ['drive-api-check.html', 'text/html; charset=utf-8']],
  ['/drive-api-check.js', ['drive-api-check.js', 'text/javascript; charset=utf-8']],
  ['/drive-player.html', ['drive-player.html', 'text/html; charset=utf-8']],
  ['/drive-player.css', ['drive-player.css', 'text/css; charset=utf-8']],
  ['/drive-download.js', ['drive-download.js', 'text/javascript; charset=utf-8']],
  ['/drive-player.js', ['drive-player.js', 'text/javascript; charset=utf-8']],
  ['/media-controls.js', ['media-controls.js', 'text/javascript; charset=utf-8']],
  ['/stream/', ['stream/index.html', 'text/html; charset=utf-8']],
  ['/stream/index.html', ['stream/index.html', 'text/html; charset=utf-8']],
  ['/stream/player.js', ['stream/player.js', 'text/javascript; charset=utf-8']],
  ['/stream/worker.js', ['stream/worker.js', 'text/javascript; charset=utf-8']],
  ['/stream/bridge.js', ['stream/bridge.js', 'text/javascript; charset=utf-8']],
]);

for (const file of ['core.js', 'cache.js', 'network.js', 'broker.js', 'setup.js', 'setup.html', 'manifest.json']) assets.set(`/p2p/${file}`, [`p2p/${file}`, file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.json') ? 'application/json' : 'text/javascript; charset=utf-8']);
for (const file of ['index.html', 'player.js', 'worker.js']) assets.set(`/stream/peer/${file}`, [`stream/peer/${file}`, file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8']);
assets.set('/stream/peer/', ['stream/peer/index.html', 'text/html; charset=utf-8']);
// Node 24 has WebCrypto globally; this fallback only supports older compatible Node.
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const coordinator = process.argv.includes('--p2p') ? createCoordinator({ origin: 'http://127.0.0.1:4173', getManifest: async () => PeerCore.validateManifest(JSON.parse(await readFile(new URL('./p2p/manifest.json', import.meta.url), 'utf8'))) }) : null;

const server = createServer(async (request, response) => {
  if (coordinator && await coordinator.handle(request, response)) return;
  const path = (request.url ?? '/').split('?')[0];
  const asset = assets.get(path);
  if (!asset || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const content = await readFile(new URL(asset[0], import.meta.url));
    response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(error.code === 'ENOENT' ? 'Not found. Operator: publish p2p/manifest.json from /p2p/setup.html first.' : 'Unable to read preview asset');
  }
});

server.on('error', (error) => {
  console.error(`Preview server: ${error.message}`);
  process.exitCode = 1;
});
server.on('close', () => coordinator?.close());
server.listen(4173, '127.0.0.1', () => console.log(`Embed Lab: http://127.0.0.1:4173${coordinator ? ' — local P2P coordinator enabled' : ''}`));
