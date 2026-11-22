// The HTTP layer. Plain http on localhost behind Caddy (TLS is Caddy's job). Every route needs a device token except the CORS preflight.
// Logs hold the method, a fixed route label, the status code, and sizes: never a path value, header, token, address or body.
import { createServer } from 'node:http';
import { Storage } from './storage.mjs';
import { Tokens } from './tokens.mjs';
import { cleanEnvelope, ARCHIVE_NAME } from './validate.mjs';

const JSON_HDR = { 'content-type': 'application/json; charset=utf-8' };
const VERSION_ID = /^\d{1,10}$/;

class Window {
  constructor(limit, now) { this.limit = limit; this.now = now; this.m = new Map(); }
  // true when this hit is allowed. Fixed one-minute windows per key; old windows are dropped as they are seen.
  hit(key) {
    const t = this.now(), minute = Math.floor(t / 60000);
    if (this.m.size > 5000) for (const [k, v] of this.m) if (v.minute !== minute) this.m.delete(k);
    let e = this.m.get(key);
    if (!e || e.minute !== minute) { e = { minute, n: 0 }; this.m.set(key, e); }
    e.n++;
    return e.n <= this.limit;
  }
  over(key) { const e = this.m.get(key); return !!e && e.minute === Math.floor(this.now() / 60000) && e.n >= this.limit; }
}

export function createApp(cfg) {
  const storage = new Storage(cfg.dataDir, cfg.now), tokens = new Tokens(cfg.tokensFile, cfg.now);
  const general = new Window(cfg.rateLimitPerMin, cfg.now), fails = new Window(cfg.authFailPerMin, cfg.now), writes = new Window(cfg.writePerMin, cfg.now);
  const allowed = new Set(cfg.appOrigins);
  let inflight = 0;

  function clientKey(req) {
    // SEC-136: the last entry is the address the nearest proxy (Caddy) saw; earlier entries are whatever the client sent.
    if (cfg.trustProxy) { const x = req.headers['x-forwarded-for']; if (typeof x === 'string' && x) { const last = x.split(',').pop().trim().slice(0, 64); if (last) return last; } }
    return req.socket.remoteAddress || 'unknown';
  }
  function send(req, res, st, body, headers, ctx) {
    const h = Object.assign({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, headers || {});
    const origin = req.headers.origin;
    if (typeof origin === 'string' && allowed.has(origin.toLowerCase())) {
      h['access-control-allow-origin'] = origin; h.vary = 'Origin'; h['access-control-expose-headers'] = 'X-Rev';
    }
    const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    if (body !== undefined && typeof body !== 'string' && !h['content-type']) Object.assign(h, JSON_HDR);
    h['content-length'] = Buffer.byteLength(payload);
    res.writeHead(st, h);
    res.end(payload);
    ctx.status = st; ctx.out = Buffer.byteLength(payload);
  }
  const fail = (req, res, st, code, ctx, extra, headers) => send(req, res, st, Object.assign({ code }, extra || {}), headers, ctx);

  // Reads at most `max` bytes; a longer body is refused as soon as it is known (header) or seen (stream) and the connection is closed.
  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      const cl = req.headers['content-length'];
      if (cl !== undefined && (!/^\d+$/.test(cl) || Number(cl) > max)) { const e = new Error('big'); e.code = 'TOO_BIG'; return reject(e); }
      const parts = []; let n = 0, done = false;
      req.on('data', (c) => {
        if (done) return;
        n += c.length;
        if (n > max) { done = true; const e = new Error('big'); e.code = 'TOO_BIG'; reject(e); return; }
        parts.push(c);
      });
      req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts).toString('utf8')); } });
      req.on('error', () => { if (!done) { done = true; const e = new Error('read'); e.code = 'READ'; reject(e); } });
      // SEC-137: a client that goes away mid-body settles the read too, so the upload slot is always given back.
      req.on('close', () => { if (!done) { done = true; const e = new Error('read'); e.code = 'READ'; reject(e); } });
    });
  }
  const expectedOf = (req) => {
    const v = req.headers['x-expected-rev'];
    if (v === 'none') return 'none';
    if (typeof v === 'string' && /^\d{1,10}$/.test(v)) return Number(v);
    return undefined;
  };

  async function handle(req, res, ctx) {
    const origin = req.headers.origin;
    const originOk = origin === undefined || (typeof origin === 'string' && allowed.has(origin.toLowerCase()));
    if (req.url.length > 200) return fail(req, res, 414, 'URL', ctx);
    let path;
    try { const u = new URL(req.url, 'http://x'); path = u.pathname; } catch (e) { return fail(req, res, 400, 'URL', ctx); }
    ctx.route = 'other';
    // CORS preflight: answered only for the configured app origin(s).
    if (req.method === 'OPTIONS') {
      ctx.route = 'preflight';
      if (!originOk || origin === undefined) return fail(req, res, 403, 'ORIGIN', ctx);
      return send(req, res, 204, undefined, {
        'access-control-allow-methods': 'GET, PUT, POST', 'access-control-allow-headers': 'authorization, content-type, x-expected-rev',
        'access-control-max-age': '600',
      }, ctx);
    }
    if (!originOk) return fail(req, res, 403, 'ORIGIN', ctx);
    const key = clientKey(req);
    if (!general.hit(key) || fails.over(key)) return fail(req, res, 429, 'RATE', ctx, undefined, { 'retry-after': '60' });
    const m = /^Bearer (\S{1,200})$/.exec(String(req.headers.authorization || ''));
    let dev = null;
    try { dev = m ? tokens.check(m[1]) : null; } catch (e) { return fail(req, res, 500, 'CONFIG', ctx); }
    if (!dev) { fails.hit(key); return fail(req, res, 401, 'AUTH', ctx); }

    const route = (label, methods) => { ctx.route = label; return methods.includes(req.method); };
    const notAllowed = (methods) => fail(req, res, 405, 'METHOD', ctx, undefined, { allow: methods.join(', ') });
    // SEC-137: a refused body closes the connection, so the rest of it is never read.
    const bodyErr = (e) => (e && e.code === 'TOO_BIG' ? fail(req, res, 413, 'TOO_BIG', ctx, undefined, { connection: 'close' }) : fail(req, res, 400, 'READ', ctx, undefined, { connection: 'close' }));
    // SEC-137: at most cfg.maxUploads bodies are buffered at once (each up to 64 MB), whatever the rate limits allow.
    const upload = async (max) => {
      if (inflight >= cfg.maxUploads) { const e = new Error('busy'); e.code = 'BUSY'; throw e; }
      inflight++;
      try { return await readBody(req, max); } finally { inflight--; }
    };
    const uploadErr = (e) => (e && e.code === 'BUSY' ? fail(req, res, 503, 'BUSY', ctx, undefined, { 'retry-after': '5', connection: 'close' }) : bodyErr(e));
    const needJson = () => /^application\/json\b/i.test(String(req.headers['content-type'] || ''));

    if (path === '/v1/health') {
      if (!route('health', ['GET'])) return notAllowed(['GET']);
      const c = storage.current();
      return send(req, res, 200, { ok: true, rev: c ? c.id : null }, undefined, ctx);
    }
    if (path === '/v1/vault') {
      ctx.route = 'vault';
      if (req.method === 'GET') {
        const c = storage.current();
        if (!c) return fail(req, res, 404, 'EMPTY', ctx);
        const v = storage.readVersion(c.id);
        return send(req, res, 200, v.text, { 'content-type': JSON_HDR['content-type'], 'x-rev': String(c.id) }, ctx);
      }
      if (req.method === 'PUT') {
        const exp = expectedOf(req);
        if (exp === undefined) return fail(req, res, 400, 'EXPECTED', ctx);
        if (!writes.hit(key)) return fail(req, res, 429, 'RATE', ctx, undefined, { 'retry-after': '60' });
        if (!needJson()) return fail(req, res, 415, 'TYPE', ctx);
        let text;
        try { text = await upload(cfg.maxVault); } catch (e) { return uploadErr(e); }
        ctx.in = Buffer.byteLength(text);
        let c;
        try { c = cleanEnvelope(text); } catch (e) { return fail(req, res, 422, 'INVALID', ctx); }
        const r = await storage.putVault(JSON.stringify(c.env), c.rev, exp);
        if (!r.ok) return fail(req, res, 409, 'CONFLICT', ctx, { rev: r.rev });
        return send(req, res, 200, { ok: true, rev: r.rev }, { 'x-rev': String(r.rev) }, ctx);
      }
      return notAllowed(['GET', 'PUT']);
    }
    if (path === '/v1/versions') {
      if (!route('versions', ['GET'])) return notAllowed(['GET']);
      return send(req, res, 200, { versions: storage.versions().slice(0, 30).map((v) => ({ id: v.id, envRev: v.envRev, at: v.at, size: v.size })) }, undefined, ctx);
    }
    let mm = /^\/v1\/versions\/([^/]+)$/.exec(path);
    if (mm) {
      ctx.route = 'version';
      if (req.method !== 'GET') return notAllowed(['GET']);
      if (!VERSION_ID.test(mm[1])) return fail(req, res, 404, 'NOT_FOUND', ctx);
      const v = storage.readVersion(Number(mm[1]));
      if (!v) return fail(req, res, 404, 'NOT_FOUND', ctx);
      return send(req, res, 200, v.text, { 'content-type': JSON_HDR['content-type'], 'x-rev': String(v.meta.id) }, ctx);
    }
    mm = /^\/v1\/versions\/([^/]+)\/restore$/.exec(path);
    if (mm) {
      if (!route('restore', ['POST'])) return notAllowed(['POST']);
      const exp = expectedOf(req);
      if (exp === undefined || exp === 'none') return fail(req, res, 400, 'EXPECTED', ctx);
      if (!VERSION_ID.test(mm[1])) return fail(req, res, 404, 'NOT_FOUND', ctx);
      if (!writes.hit(key)) return fail(req, res, 429, 'RATE', ctx, undefined, { 'retry-after': '60' });
      const r = await storage.restore(Number(mm[1]), exp);
      if (r.missing) return fail(req, res, 404, 'NOT_FOUND', ctx);
      if (!r.ok) return fail(req, res, 409, 'CONFLICT', ctx, { rev: r.rev });
      return send(req, res, 200, { ok: true, rev: r.rev }, { 'x-rev': String(r.rev) }, ctx);
    }
    if (path === '/v1/archives') {
      if (!route('archives', ['GET'])) return notAllowed(['GET']);
      return send(req, res, 200, { archives: storage.archives() }, undefined, ctx);
    }
    mm = /^\/v1\/archives\/([^/]+)$/.exec(path);
    if (mm) {
      ctx.route = 'archive';
      const am = ARCHIVE_NAME.exec(mm[1]);
      if (req.method !== 'GET' && req.method !== 'PUT') return notAllowed(['GET', 'PUT']);
      if (!am) return fail(req, res, 404, 'NOT_FOUND', ctx);
      if (req.method === 'GET') {
        const t = storage.readArchive(mm[1]);
        if (t === null) return fail(req, res, 404, 'NOT_FOUND', ctx);
        return send(req, res, 200, t, { 'content-type': JSON_HDR['content-type'] }, ctx);
      }
      if (!writes.hit(key)) return fail(req, res, 429, 'RATE', ctx, undefined, { 'retry-after': '60' });
      if (!needJson()) return fail(req, res, 415, 'TYPE', ctx);
      let text;
      try { text = await upload(cfg.maxArchive); } catch (e) { return uploadErr(e); }
      ctx.in = Buffer.byteLength(text);
      let c;
      try { c = cleanEnvelope(text, { archiveYear: Number(am[1]) }); } catch (e) { return fail(req, res, 422, 'INVALID', ctx); }
      const r = await storage.putArchive(mm[1], JSON.stringify(c.env));
      if (!r.ok) return fail(req, res, 507, 'FULL', ctx);
      return send(req, res, 200, { ok: true }, undefined, ctx);
    }
    return fail(req, res, 404, 'NOT_FOUND', ctx);
  }

  const server = createServer((req, res) => {
    const ctx = { t: cfg.now(), status: 0, in: 0, out: 0, route: 'other' };
    res.on('close', () => {
      const method = ['GET', 'PUT', 'POST', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER';
      cfg.log('ts=' + new Date(ctx.t).toISOString() + ' method=' + method + ' route=' + ctx.route + ' status=' + (ctx.status || 0) + ' in=' + ctx.in + ' out=' + ctx.out + ' ms=' + (cfg.now() - ctx.t));
    });
    handle(req, res, ctx).catch(() => { if (!res.headersSent) fail(req, res, 500, 'INTERNAL', ctx); else res.destroy(); });
  });
  server.requestTimeout = 120000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 40;
  server.maxRequestsPerSocket = 200;
  return { server, storage, tokens, config: cfg };
}
