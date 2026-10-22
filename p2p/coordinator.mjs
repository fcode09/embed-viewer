import { randomUUID, randomBytes } from 'node:crypto';

// Signalling only: this module has no Google client, media route, or disk writes.
export function createCoordinator({ origin, getManifest, now = Date.now }) {
  const sessions = new Map();
  const joins = new Map();
  const json = (res, status, value) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(value));
  const emit = (peer, value) => {
    if (!peer.events) return;
    if (peer.events.writableLength > 131072) { remove(peer); return; }
    peer.events.write(`data: ${JSON.stringify(value)}\n\n`);
  };
  function broadcast() {
    for (const peer of sessions.values()) {
      const candidates = [...sessions.values()].filter(other => other !== peer && other.contentId === peer.contentId && other.events && other.have.length)
        .sort((a, b) => Number(b.free) - Number(a.free) || b.have.length - a.have.length)
        .slice(0, 4).map(other => ({ peerId: other.id, have: other.have, free: other.free }));
      emit(peer, { type: 'peers', candidates });
    }
  }
  function remove(peer) {
    if (!sessions.delete(peer.id)) return;
    for (const other of sessions.values()) other.links.delete(peer.id);
    peer.events?.end(); peer.events = null;
    // The periodic refresh publishes removals without recursively broadcasting.
  }
  const sweep = setInterval(() => {
    for (const peer of sessions.values()) if (now() - peer.seen > 45000) remove(peer);
    for (const [ip, item] of joins) if (now() - item.at > 60000) joins.delete(ip);
    for (const peer of sessions.values()) peer.events?.write(': keepalive\n\n');
    broadcast();
  }, 15000);
  sweep.unref();
  async function body(req) {
    if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json') throw new Error('JSON required');
    let size = 0, chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) throw new Error('Request too large');
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Object required');
    return data;
  }
  const only = (value, fields) => Object.keys(value).every(key => fields.includes(key));
  async function handle(req, res) {
    const path = (req.url || '').split('?')[0];
    if (!['/p2p/session', '/p2p/events', '/p2p/message'].includes(path)) return false;
    res.setTimeout(60000);
    // Browsers omit Origin on a same-origin GET. Fetch Metadata plus Host
    // admits that SSE request; POST still requires an exact Origin.
    const admitted = req.headers.origin === origin || (req.method === 'GET' && !req.headers.origin && req.headers['sec-fetch-site'] === 'same-origin' && req.headers.host === new URL(origin).host);
    if (req.url !== path || !admitted) { json(res, 403, { code: 'ORIGIN_REQUIRED' }); return true; }
    try {
      if (path === '/p2p/session' && req.method === 'POST') {
        const data = await body(req);
        const manifest = await getManifest();
        if (!only(data, ['contentId']) || data.contentId !== manifest.contentId) { json(res, 409, { code: 'MANIFEST_REQUIRED' }); return true; }
        const ip = req.socket.remoteAddress;
        let bucket = joins.get(ip);
        if (!bucket || now() - bucket.at > 60000) { bucket = { at: now(), count: 0 }; joins.set(ip, bucket); }
        if (++bucket.count > 10 || sessions.size >= 100) { json(res, 429, { code: 'CAPACITY' }); return true; }
        const peer = { id: randomUUID(), token: randomBytes(32).toString('hex'), contentId: data.contentId, blocks: manifest.hashes.length, have: [], free: false, seen: now(), window: now(), count: 0, links: new Set(), events: null };
        sessions.set(peer.id, peer);
        json(res, 201, { peerId: peer.id, token: peer.token, ttlMs: 45000 }); return true;
      }
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      const peer = [...sessions.values()].find(item => item.token === token);
      if (!peer || now() - peer.seen > 45000) { if (peer) remove(peer); json(res, 401, { code: 'SESSION_EXPIRED' }); return true; }
      if (path === '/p2p/events' && req.method === 'GET') {
        if (peer.events) { json(res, 409, { code: 'ALREADY_CONNECTED' }); return true; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        peer.events = res;
        res.on('close', () => { if (peer.events === res) remove(peer); });
        emit(peer, { type: 'ready' }); broadcast(); return true;
      }
      if (path !== '/p2p/message' || req.method !== 'POST') { json(res, 405, { code: 'METHOD' }); return true; }
      if (now() - peer.window >= 60000) { peer.window = now(); peer.count = 0; }
      if (++peer.count > 240) { json(res, 429, { code: 'RATE_LIMIT' }); return true; }
      const data = await body(req);
      peer.seen = now();
      if (data.type === 'leave' && only(data, ['type'])) remove(peer);
      else if (data.type === 'heartbeat' && only(data, ['type'])) { /* Refresh expiry only. */ }
      else if (data.type === 'announce' && only(data, ['type', 'have', 'free']) && typeof data.free === 'boolean' && Array.isArray(data.have) && data.have.length <= peer.blocks && data.have.every(index => Number.isInteger(index) && index >= 0 && index < peer.blocks)) {
        peer.have = [...new Set(data.have)]; peer.free = data.free; broadcast();
      } else if (data.type === 'signal' && only(data, ['type', 'to', 'kind', 'payload'])) {
        const target = sessions.get(data.to);
        const limit = data.kind === 'ice' ? 4096 : 32768;
        if (!target || target === peer || target.contentId !== peer.contentId || !['connect', 'offer', 'answer', 'ice', 'close'].includes(data.kind) || typeof data.payload !== 'string' || data.payload.length > limit || (data.kind !== 'close' && peer.links.size >= 5 && !peer.links.has(target.id))) throw new Error('Invalid signal');
        if (data.kind === 'close') { peer.links.delete(target.id); target.links.delete(peer.id); }
        else peer.links.add(target.id);
        emit(target, { type: 'signal', from: peer.id, kind: data.kind, payload: data.payload });
      } else throw new Error('Unsupported message');
      json(res, 200, { code: 'OK' });
    } catch { if (!res.headersSent) json(res, 400, { code: 'INVALID_REQUEST_OR_MISSING_MANIFEST' }); else res.end(); }
    return true;
  }
  return { handle, close() { clearInterval(sweep); for (const peer of sessions.values()) remove(peer); } };
}
