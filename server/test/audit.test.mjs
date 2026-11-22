// v2.0.0 audit (docs/SECURITY.md "v2.0.0 audit"): regression tests for the service findings and extra proofs of the service rules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { createApp } from '../lib/app.mjs';

const APP = 'https://lifeos.example.test';
const MARK = 'AUDIT "quoted" marker with spaces';
const env = (rev, extra = {}) => JSON.stringify(Object.assign({ v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: 600000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }, iv: 'AAAAAAAAAAAAAAAA', ct: 'QUJDREVGR0hJSktMTU5PUA==', rev }, extra));
let root, nowMs = 1_800_000_000_000;
before(() => { root = mkdtempSync(join(tmpdir(), 'lifeos-srv-audit-')); });
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
async function svc(over = {}) {
  const d = join(root, 's' + n++);
  const cfg = loadConfig({}, Object.assign({ configDir: join(d, 'cfg'), dataDir: join(d, 'data'), appOrigins: [APP], port: 0, writePerMin: 5000, rateLimitPerMin: 50000, log: () => {}, now: () => nowMs }, over));
  const a = createApp(cfg);
  await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
  const port = a.server.address().port, tok = a.tokens.add('dev');
  const stop = () => new Promise((r) => { a.server.closeAllConnections(); a.server.close(r); });
  return Object.assign(a, { d, port, tok, base: 'http://127.0.0.1:' + port, stop });
}
// A raw request: the path is sent exactly as written (no URL normalisation by a client library).
function raw(port, method, path, headers = {}, body) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (rs) => { let b = ''; rs.on('data', (c) => { b += c; }); rs.on('end', () => res({ status: rs.statusCode, headers: rs.headers, body: b })); });
    r.on('error', rej);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

test('SEC-137: compare-and-swap under 12 concurrent puts with the same expected revision: exactly one wins, no lost update, no torn or temp file', async () => {
  const s = await svc();
  const H = { authorization: 'Bearer ' + s.tok, 'content-type': 'application/json' };
  assert.equal((await fetch(s.base + '/v1/vault', { method: 'PUT', headers: { ...H, 'x-expected-rev': 'none' }, body: env(1) })).status, 200);
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => fetch(s.base + '/v1/vault', { method: 'PUT', headers: { ...H, 'x-expected-rev': '0' }, body: env(10 + i, { deviceId: 'writer-' + i }) })));
  const st = rs.map((r) => r.status);
  assert.equal(st.filter((x) => x === 200).length, 1); assert.equal(st.filter((x) => x === 409).length, 11);
  const winner = st.indexOf(200);
  const files = readdirSync(join(s.d, 'data', 'vault'));
  assert.equal(files.length, 2); assert.ok(files.every((f) => !f.startsWith('.tmp-')));
  for (const f of files) JSON.parse(readFileSync(join(s.d, 'data', 'vault', f), 'utf8'));
  const cur = JSON.parse(await (await fetch(s.base + '/v1/vault', { headers: H })).text());
  assert.equal(cur.deviceId, 'writer-' + winner, 'the current copy is the one write that was accepted');
  const c409 = await rs.find((r) => r.status === 409).json(); assert.deepEqual(c409, { code: 'CONFLICT', rev: 1 });
  await s.stop();
});

test('SEC-136: with trustProxy the rate-limit key is the last X-Forwarded-For entry, so a client cannot rotate its own first entry past the failed-token limit', async () => {
  const s = await svc({ trustProxy: true, authFailPerMin: 3 });
  const bad = { authorization: 'Bearer lfs_' + 'C'.repeat(43) };
  const st = [];
  for (let i = 0; i < 5; i++) st.push((await fetch(s.base + '/v1/health', { headers: { ...bad, 'x-forwarded-for': '198.51.100.' + i + ', 192.0.2.7' } })).status);
  assert.deepEqual(st, [401, 401, 401, 429, 429]);
  // another real client (another last entry) is not affected
  assert.equal((await fetch(s.base + '/v1/health', { headers: { authorization: 'Bearer ' + s.tok, 'x-forwarded-for': '192.0.2.7, 192.0.2.8' } })).status, 200);
  await s.stop();
});

test('SEC-137: at most maxUploads bodies are buffered at once; an abandoned upload gives its slot back; a refused body closes the connection', async () => {
  const s = await svc({ maxUploads: 2, maxVault: 4096 });
  const head = (len) => ({ authorization: 'Bearer ' + s.tok, 'content-type': 'application/json', 'x-expected-rev': 'none', 'content-length': String(len) });
  // two slow uploads that never finish
  const slow = [0, 1].map(() => { const r = http.request({ host: '127.0.0.1', port: s.port, method: 'PUT', path: '/v1/vault', headers: head(4000), agent: false }); r.on('error', () => {}); r.write('{'); return r; });
  await new Promise((r) => setTimeout(r, 150));
  const busy = await raw(s.port, 'PUT', '/v1/vault', head(env(1).length), env(1));
  assert.equal(busy.status, 503); assert.equal(JSON.parse(busy.body).code, 'BUSY'); assert.equal(busy.headers.connection, 'close');
  for (const r of slow) r.destroy();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await raw(s.port, 'PUT', '/v1/vault', head(env(1).length), env(1))).status, 200, 'the slots came back after the clients went away');
  const big = await raw(s.port, 'PUT', '/v1/vault', { ...head(999999), 'x-expected-rev': '0' });
  assert.equal(big.status, 413); assert.equal(big.headers.connection, 'close');
  // unauthenticated bodies are never read at all
  const anon = await raw(s.port, 'PUT', '/v1/vault', { 'content-type': 'application/json', 'x-expected-rev': '0', 'content-length': String(env(2).length) }, env(2));
  assert.equal(anon.status, 401);
  await s.stop();
});

test('paths: traversal, encoded separators, NUL, odd version ids and absolute-form URLs never reach a file outside the data folder', async () => {
  const s = await svc();
  const A = { authorization: 'Bearer ' + s.tok };
  const J = { ...A, 'content-type': 'application/json' };
  const arch = JSON.stringify({ v: 1, kdf: { s: 'x' }, iv: 'AAAA', ct: 'AAAA', arch: 1, year: 2024 });
  for (const p of ['/v1/archives/..%2F..%2Fcfg%2Ftokens.json', '/v1/archives/%2e%2e%2fvault', '/v1/archives/lifeos-archive-2024.json%00.txt', '/v1/archives/lifeos-archive-2024.json%2F', '/v1/archives/LIFEOS-ARCHIVE-2024.JSON', '/v1/archives/lifeos-archive-02024.json', '/v1/archives/lifeos-archive-2024.json.bak']) {
    assert.equal((await raw(s.port, 'PUT', p, J, arch)).status, 404, p);
    assert.equal((await raw(s.port, 'GET', p, A)).status, 404, p);
  }
  for (const p of ['/v1/versions/-1', '/v1/versions/1e3', '/v1/versions/0x1', '/v1/versions/%31', '/v1/versions/..%2F..%2Fcfg', '/v1/versions/12345678901']) assert.equal((await raw(s.port, 'GET', p, A)).status, 404, p);
  // dot segments are resolved by the URL parser before routing: /v1/archives/../health is /v1/health, never a file
  assert.equal((await raw(s.port, 'GET', '/v1/archives/../health', A)).status, 200);
  assert.equal((await raw(s.port, 'GET', 'http://evil.example/v1/health', A)).status, 200);
  const all = [];
  (function walk(d) { for (const f of readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : all.push(join(d, f.name).slice(s.d.length)); })(s.d);
  assert.deepEqual(all.sort(), ['/cfg/tokens.json']);
  await s.stop();
});

test('validation: prototype keys and oversized fields in kdf or wraps are refused; constructor-like keys are stored only as plain data', async () => {
  const s = await svc();
  const H = { authorization: 'Bearer ' + s.tok, 'content-type': 'application/json', 'x-expected-rev': 'none' };
  for (const b of [env(1).replace('"kdf":{', '"kdf":{"__proto__":{"polluted":1},'), env(1, { kdf: { a: { b: { c: { d: { e: { f: 1 } } } } } } }), env(1, { kdf: { s: 'x'.repeat(5000) } }), env(1, { rev: 1e10 }), env(1, { updatedAt: MARK.repeat(3) })]) {
    const r = await fetch(s.base + '/v1/vault', { method: 'PUT', headers: H, body: b });
    assert.equal(r.status, 422, b.slice(0, 60)); assert.deepEqual(await r.json(), { code: 'INVALID' });
  }
  assert.equal(({}).polluted, undefined);
  const r = await fetch(s.base + '/v1/vault', { method: 'PUT', headers: H, body: env(1, { kdf: { constructor: 'c', prototype: 'p' } }) });
  assert.equal(r.status, 200);
  assert.equal(({}).constructor, Object);
  await s.stop();
});

test('safe defaults: no origin means no start; localhost and no proxy trust by default; a missing token file refuses everyone; a broken one fails closed', async () => {
  assert.throws(() => loadConfig({}, { configDir: join(root, 'none') }), /at least one/);
  const c = loadConfig({ LIFEOS_APP_ORIGINS: APP }, { configDir: join(root, 'none2') });
  assert.equal(c.host, '127.0.0.1'); assert.equal(c.trustProxy, false); assert.equal(c.maxUploads, 2);
  const s = await svc();
  rmSync(join(s.d, 'cfg', 'tokens.json'));
  assert.equal((await fetch(s.base + '/v1/health', { headers: { authorization: 'Bearer ' + s.tok } })).status, 401);
  mkdirSync(join(s.d, 'cfg'), { recursive: true }); writeFileSync(join(s.d, 'cfg', 'tokens.json'), '{broken');
  const r = await fetch(s.base + '/v1/health', { headers: { authorization: 'Bearer ' + s.tok } });
  assert.equal(r.status, 500); assert.deepEqual(await r.json(), { code: 'CONFIG' });
  await s.stop();
});

test('CORS: no credentials header and no wildcard on any answer; an allowed origin with a wrong token gets the CORS header but no data', async () => {
  const s = await svc();
  const seen = [];
  for (const [m, p, h] of [['OPTIONS', '/v1/vault', { origin: APP, 'access-control-request-method': 'PUT' }], ['GET', '/v1/health', { origin: APP, authorization: 'Bearer ' + s.tok }], ['GET', '/v1/vault', { origin: APP, authorization: 'Bearer lfs_' + 'D'.repeat(43) }], ['GET', '/v1/health', { origin: 'https://evil.example', authorization: 'Bearer ' + s.tok }]]) {
    const r = await raw(s.port, m, p, h); seen.push(r);
    assert.equal(r.headers['access-control-allow-credentials'], undefined);
    assert.notEqual(r.headers['access-control-allow-origin'], '*');
  }
  assert.equal(seen[2].status, 401); assert.deepEqual(JSON.parse(seen[2].body), { code: 'AUTH' });
  assert.equal(seen[3].status, 403); assert.equal(seen[3].headers['access-control-allow-origin'], undefined);
  await s.stop();
});

test('container and proxy files: non-root, read-only root, no capabilities, published on 127.0.0.1 only; Caddy proxies only to localhost and logs nothing', () => {
  const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  const df = src('Dockerfile'), cp = src('compose.yaml'), cf = src('Caddyfile.example');
  assert.match(df, /^USER node$/m); assert.ok(df.indexOf('USER node') > df.lastIndexOf('RUN '));
  assert.match(cp, /read_only: true/); assert.match(cp, /cap_drop: \["ALL"\]/); assert.match(cp, /no-new-privileges:true/);
  const ports = [...cp.matchAll(/^\s+- "([^"]+)"\s*(#.*)?$/gm)].map((m) => m[1]).filter((p) => /\d+:\d+/.test(p));
  assert.deepEqual(ports, ['127.0.0.1:8787:8787']);
  assert.ok(!/network_mode|privileged|0\.0\.0\.0:/.test(cp));
  for (const m of cf.matchAll(/reverse_proxy (\S+)/g)) assert.match(m[1], /^127\.0\.0\.1:\d+$/);
  assert.match(cf, /output discard/);
});
