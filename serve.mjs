// Optional local preview only. The site itself has no backend dependency.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/drive-api-check.html', ['drive-api-check.html', 'text/html; charset=utf-8']],
  ['/drive-api-check.js', ['drive-api-check.js', 'text/javascript; charset=utf-8']],
]);


const server = createServer(async (request, response) => {
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
    response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(error.code === 'ENOENT' ? 'Not found' : 'Unable to read preview asset');
  }
});

server.on('error', (error) => {
  console.error(`Preview server: ${error.message}`);
  process.exitCode = 1;
});
server.listen(4173, '127.0.0.1', () => console.log('Embed Lab: http://127.0.0.1:4173'));
