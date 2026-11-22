import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { createApp } from '../lib/app.mjs';
import { Tokens, hashToken, newToken } from '../lib/tokens.mjs';
import { cli } from '../index.mjs';

const APP = 'https://lifeos.example.test';
const MARK = 'ADV "quoted" marker with spaces and \'quotes\'';
let dir, logs, ctx, base, tok, nowMs = 1_800_000_000_000;
const env = (rev, extra = {}) => JSON.stringify(Object.assign({ v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: 600000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }, iv: 'AAAAAAAAAAAAAAAA', ct: 'QUJDREVGR0hJSktMTU5PUA==', rev }, extra));
const env2 = (rev) => JSON.stringify({ v: 1, fmt: 2, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: 600000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }, iv: 'AAAAAAAAAAAAAAAA', ct: 'QUJDREVGR0hJSktMTU5PUA==', wraps: [{ kind: 'passphrase', kdf: { salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }, iv: 'AAAAAAAAAAAAAAAA', ct: 'QUJD' }], data: { iv: 'AAAAAAAAAAAAAAAA', ct: 'QUJDREVGR0hJSktMTU5PUA==' }, rev });
const arch = (year) => JSON.stringify({ v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: 600000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }, iv: 'AAAAAAAAAAAAAAAA', ct: 'QUJDREVGR0hJSktMTU5PUA==', arch: 1, year });
async function start(over = {}) {
  dir = mkdtempSync(join(tmpdir(), 'lifeos-srv-'));
  logs = [];
  const cfg = loadConfig({}, Object.assign({ configDir: join(dir, 'cfg'), dataDir: join(dir, 'data'), appOrigins: [APP], port: 0, writePerMin: 5000, log: (l) => logs.push(l), now: () => nowMs }, over));
  ctx = createApp(cfg);
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + ctx.server.address().port;
  tok = ctx.tokens.add('laptop');
}
async function stop() { await new Promise((r) => { ctx.server.closeAllConnections(); ctx.server.close(r); }); rmSync(dir, { recursive: true, force: true }); }
const call = (path, o = {}) => fetch(base + path, Object.assign({}, o, { headers: Object.assign({ authorization: 'Bearer ' + tok }, o.headers || {}) }));
const put = (path, body, exp, extra = {}) => call(path, { method: 'PUT', body, headers: Object.assign({ 'content-type': 'application/json', 'x-expected-rev': String(exp) }, extra) });

before(() => start());
after(() => stop());

test('auth: no token, bad token and revoked token are refused with one code; health needs a token', async () => {
  assert.equal((await fetch(base + '/v1/health')).status, 401);
  assert.equal((await fetch(base + '/v1/health', { headers: { authorization: 'Bearer lfs_' + 'A'.repeat(43) } })).status, 401);
  assert.equal((await fetch(base + '/v1/health', { headers: { authorization: 'Bearer short' } })).status, 401);
  const r = await call('/v1/health');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, rev: null });
});
test('tokens are stored only as SHA-256 hashes, file mode 0600, and checked against every hash', () => {
  const raw = readFileSync(ctx.config.tokensFile, 'utf8');
  assert.ok(!raw.includes(tok));
  assert.ok(raw.includes(hashToken(tok)));
  assert.equal(statSync(ctx.config.tokensFile).mode & 0o777, 0o600);
  const t = new Tokens(join(dir, 'x', 'tokens.json'));
  const a = t.add('a'), b = t.add('b');
  assert.equal(t.check(a), 'a'); assert.equal(t.check(b), 'b'); assert.equal(t.check(newToken()), null); assert.equal(t.check(undefined), null);
  assert.throws(() => t.register('a', hashToken('zzz')), /already exists/);
  assert.throws(() => t.register('bad/name', hashToken('q')), /Device names/);
  assert.throws(() => t.register('c', 'nothex'), /64 lowercase hex/);
});
test('revoke takes effect on the next request without a restart; add by hash works', async () => {
  const t2 = newToken();
  ctx.tokens.register('phone', hashToken(t2));
  const ok = await fetch(base + '/v1/health', { headers: { authorization: 'Bearer ' + t2 } });
  assert.equal(ok.status, 200);
  assert.equal(ctx.tokens.revoke('phone'), true);
  assert.equal(ctx.tokens.revoke('phone'), false);
  assert.equal((await fetch(base + '/v1/health', { headers: { authorization: 'Bearer ' + t2 } })).status, 401);
  // another process (the CLI) changing the file is also seen
  writeFileSync(ctx.config.tokensFile, JSON.stringify({ v: 1, devices: [] }));
  assert.equal((await call('/v1/health')).status, 401);
  ctx.tokens.register('laptop', hashToken(tok));
  assert.equal((await call('/v1/health')).status, 200);
});
test('empty vault is 404 EMPTY; first put needs expected none; compare-and-swap and 409 with the current revision', async () => {
  let r = await call('/v1/vault'); assert.equal(r.status, 404); assert.equal((await r.json()).code, 'EMPTY');
  r = await put('/v1/vault', env(5), 'none'); assert.equal(r.status, 200); assert.equal((await r.json()).rev, 0);
  r = await put('/v1/vault', env(6), 'none'); assert.equal(r.status, 409); assert.deepEqual(await r.json(), { code: 'CONFLICT', rev: 0 });
  r = await put('/v1/vault', env(6), 7); assert.equal(r.status, 409); assert.equal((await r.json()).rev, 0);
  r = await put('/v1/vault', env2(6), 0); assert.equal(r.status, 200); assert.equal((await r.json()).rev, 1);
  r = await call('/v1/vault'); assert.equal(r.status, 200); assert.equal(r.headers.get('x-rev'), '1');
  assert.equal(JSON.parse(await r.text()).rev, 6);
  r = await call('/v1/vault', { method: 'PUT', body: env(7), headers: { 'content-type': 'application/json' } }); assert.equal(r.status, 400);
});
test('two writers with the same expected revision: exactly one wins', async () => {
  const cur = (await (await call('/v1/health')).json()).rev;
  const [a, b] = await Promise.all([put('/v1/vault', env(10), cur), put('/v1/vault', env(11), cur)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});
test('writes are atomic: no temp files remain, the newest file is the vault, only 30 are kept', async () => {
  let cur = (await (await call('/v1/health')).json()).rev;
  for (let i = 0; i < 35; i++) { const r = await put('/v1/vault', env(100 + i), cur); cur = (await r.json()).rev; }
  const files = readdirSync(join(dir, 'data', 'vault'));
  assert.equal(files.length, 30);
  assert.ok(files.every((f) => !f.startsWith('.tmp-')));
  const list = (await (await call('/v1/versions')).json()).versions;
  assert.equal(list.length, 30);
  assert.equal(list[0].id, cur); assert.equal(list[0].envRev, 134);
  assert.ok(list.every((v, i) => i === 0 || list[i - 1].id > v.id));
  assert.deepEqual(Object.keys(list[0]).sort(), ['at', 'envRev', 'id', 'size']);
});
test('versions: download one and restore it as the current copy under a new revision (CAS applies)', async () => {
  const list = (await (await call('/v1/versions')).json()).versions, old = list[5], cur = list[0].id;
  const dl = await call('/v1/versions/' + old.id); assert.equal(dl.status, 200); assert.equal(JSON.parse(await dl.text()).rev, old.envRev);
  assert.equal((await call('/v1/versions/999999')).status, 404);
  assert.equal((await call('/v1/versions/abc')).status, 404);
  let r = await call('/v1/versions/' + old.id + '/restore', { method: 'POST', headers: { 'x-expected-rev': String(cur - 1) } }); assert.equal(r.status, 409);
  r = await call('/v1/versions/' + old.id + '/restore', { method: 'POST', headers: { 'x-expected-rev': String(cur) } });
  assert.equal(r.status, 200); const nr = (await r.json()).rev; assert.equal(nr, cur + 1);
  const now = await call('/v1/vault'); assert.equal(now.headers.get('x-rev'), String(nr)); assert.equal(JSON.parse(await now.text()).rev, old.envRev);
  r = await call('/v1/versions/424242/restore', { method: 'POST', headers: { 'x-expected-rev': String(nr) } }); assert.equal(r.status, 404);
  r = await call('/v1/versions/' + old.id + '/restore', { method: 'POST' }); assert.equal(r.status, 400);
});
test('validation: only the envelope shape is accepted; unknown fields, bad rev, non-json and oversized bodies are refused', async () => {
  const cur = (await (await call('/v1/health')).json()).rev;
  const bads = ['not json', '[]', '{}', env(1, { extra: 'x' }), env(-1), env(1.5), JSON.stringify({ v: 1, kdf: {}, iv: 'AAAA', ct: 'not base64 !!' , rev: 1 }),
    env2(1).replace('"fmt":2', '"fmt":3'), env(1, { arch: 1, year: 2020 }), JSON.stringify({ v: 2, kdf: {}, iv: 'AAAA', ct: 'AAAA', rev: 1 }),
    env(1).replace('"rev":1', '"rev":1,"__proto__":{"x":1}')];
  for (const b of bads) { const r = await put('/v1/vault', b, cur); assert.equal(r.status, 422, b.slice(0, 40)); }
  assert.equal((await call('/v1/vault', { method: 'PUT', body: env(1), headers: { 'content-type': 'text/plain', 'x-expected-rev': String(cur) } })).status, 415);
  assert.equal((await call('/v1/health')).status, 200);
});
test('stored copy is rebuilt from known fields (a plaintext marker in an allowed string field is bounded, other fields refused)', async () => {
  const cur = (await (await call('/v1/health')).json()).rev;
  const r = await put('/v1/vault', env(500, { updatedAt: '2026-11-22T00:00:00Z', deviceId: 'dev-1' }), cur);
  assert.equal(r.status, 200);
  assert.equal((await put('/v1/vault', env(501, { note: MARK }), cur + 1)).status, 422);
  assert.equal((await put('/v1/vault', env(501, { deviceId: 'x'.repeat(101) }), cur + 1)).status, 422);
  const all = readdirSync(join(dir, 'data', 'vault')).map((f) => readFileSync(join(dir, 'data', 'vault', f), 'utf8')).join('');
  // v2.0.0 audit: the marker searched for in stored copies has spaces, so it can never match base64 by chance
  assert.ok(!all.includes('marker with spaces'));
});
test('size caps: Content-Length over the cap is refused at once, a chunked body over the cap is cut off', async () => {
  const s2 = loadConfig({}, { configDir: join(dir, 'cfg2'), dataDir: join(dir, 'data2'), appOrigins: [APP], maxVault: 2048, maxArchive: 2048, log: () => {} });
  const a2 = createApp(s2); await new Promise((r) => a2.server.listen(0, '127.0.0.1', r));
  const t2 = a2.tokens.add('d'), b2 = 'http://127.0.0.1:' + a2.server.address().port;
  const big = env(1, { deviceId: 'd' }).replace('QUJD', 'QUJD'.repeat(2000));
  let r = await fetch(b2 + '/v1/vault', { method: 'PUT', body: big, headers: { authorization: 'Bearer ' + t2, 'content-type': 'application/json', 'x-expected-rev': 'none' } });
  assert.equal(r.status, 413);
  const chunks = (async function* () { for (let i = 0; i < 20; i++) yield Buffer.alloc(1024, 65); })();
  r = await fetch(b2 + '/v1/vault', { method: 'PUT', body: chunks, duplex: 'half', headers: { authorization: 'Bearer ' + t2, 'content-type': 'application/json', 'x-expected-rev': 'none' } }).catch(() => ({ status: 413 }));
  assert.equal(r.status, 413);
  r = await fetch(b2 + '/v1/archives/lifeos-archive-2020.json', { method: 'PUT', body: big, headers: { authorization: 'Bearer ' + t2, 'content-type': 'application/json' } });
  assert.equal(r.status, 413);
  a2.server.closeAllConnections(); await new Promise((r2) => a2.server.close(r2));
});
test('archives: list, put, get, names validated, year must match the name, overwrite allowed', async () => {
  assert.deepEqual((await (await call('/v1/archives')).json()).archives, []);
  assert.equal((await put('/v1/archives/lifeos-archive-2024.json', arch(2024), 0)).status, 200);
  assert.equal((await put('/v1/archives/lifeos-archive-2024.json', arch(2023), 0)).status, 422);
  assert.equal((await put('/v1/archives/lifeos-archive-2024.json', env(1), 0)).status, 422);
  assert.equal((await put('/v1/archives/..%2Fvault.json', arch(2024), 0)).status, 404);
  assert.equal((await put('/v1/archives/evil.json', arch(2024), 0)).status, 404);
  assert.equal((await put('/v1/archives/lifeos-archive-2025.json', arch(2025), 0)).status, 200);
  assert.equal((await put('/v1/archives/lifeos-archive-2024.json', arch(2024), 0)).status, 200);
  const l = (await (await call('/v1/archives')).json()).archives;
  assert.deepEqual(l.map((x) => x.name), ['lifeos-archive-2024.json', 'lifeos-archive-2025.json']);
  const g = await call('/v1/archives/lifeos-archive-2025.json'); assert.equal(g.status, 200); assert.equal(JSON.parse(await g.text()).year, 2025);
  assert.equal((await call('/v1/archives/lifeos-archive-1999.json')).status, 404);
  assert.deepEqual(readdirSync(join(dir, 'data')).sort(), ['archives', 'vault']);
});
test('CORS: only the configured app origin gets headers; other origins are refused; preflight answered only for it', async () => {
  let r = await call('/v1/health', { headers: { origin: APP } });
  assert.equal(r.headers.get('access-control-allow-origin'), APP); assert.equal(r.headers.get('vary'), 'Origin');
  assert.equal(r.headers.get('access-control-allow-credentials'), null);
  for (const o of ['https://evil.example', 'http://lifeos.example.test', 'https://lifeos.example.test.evil.example', 'null']) {
    r = await call('/v1/health', { headers: { origin: o } });
    assert.equal(r.status, 403, o); assert.equal(r.headers.get('access-control-allow-origin'), null);
    r = await fetch(base + '/v1/vault', { method: 'OPTIONS', headers: { origin: o, 'access-control-request-method': 'PUT' } });
    assert.equal(r.status, 403); assert.equal(r.headers.get('access-control-allow-origin'), null);
  }
  r = await fetch(base + '/v1/vault', { method: 'OPTIONS', headers: { origin: APP, 'access-control-request-method': 'PUT' } });
  assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), APP);
  assert.match(r.headers.get('access-control-allow-headers'), /authorization/);
  assert.notEqual(r.headers.get('access-control-allow-origin'), '*');
});
test('config refuses wildcard and malformed origins and an empty list', () => {
  for (const o of ['*', 'https://*.example.com', 'lifeos.example.com', 'https://a.test/path']) assert.throws(() => loadConfig({}, { configDir: '/tmp/x', appOrigins: [o] }), /origin/i);
  assert.throws(() => loadConfig({}, { configDir: '/tmp/x', appOrigins: [] }), /at least one/);
});
test('rate limits: failed tokens, general, and writes are limited per client', async () => {
  const c = loadConfig({}, { configDir: join(dir, 'c3'), dataDir: join(dir, 'd3'), appOrigins: [APP], authFailPerMin: 3, rateLimitPerMin: 8, writePerMin: 2, log: () => {}, now: () => nowMs });
  const a = createApp(c); await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
  const t3 = a.tokens.add('d'), b3 = 'http://127.0.0.1:' + a.server.address().port;
  const H = { authorization: 'Bearer lfs_' + 'B'.repeat(43) };
  const st = [];
  for (let i = 0; i < 5; i++) st.push((await fetch(b3 + '/v1/health', { headers: H })).status);
  assert.deepEqual(st.slice(0, 3), [401, 401, 401]); assert.equal(st[3], 429); assert.ok((await fetch(b3 + '/v1/health', { headers: { authorization: 'Bearer ' + t3 } })).status === 429);
  nowMs += 61000;
  assert.equal((await fetch(b3 + '/v1/health', { headers: { authorization: 'Bearer ' + t3 } })).status, 200);
  const w = [];
  for (let i = 0; i < 3; i++) w.push((await fetch(b3 + '/v1/archives/lifeos-archive-2020.json', { method: 'PUT', body: arch(2020), headers: { authorization: 'Bearer ' + t3, 'content-type': 'application/json' } })).status);
  assert.deepEqual(w, [200, 200, 429]);
  a.server.closeAllConnections(); await new Promise((r) => a.server.close(r));
});
test('logs hold the method, a route label, status and sizes only: no token, origin, path value, header or body text', async () => {
  const before = logs.length;
  await put('/v1/archives/lifeos-archive-2022.json', arch(2022), 0);
  await call('/v1/health', { headers: { origin: APP, 'x-note': MARK } });
  await fetch(base + '/v1/vault', { headers: { authorization: 'Bearer ' + tok.slice(0, -1) + 'x' } });
  const all = logs.join('\n');
  assert.ok(logs.length > before);
  assert.ok(!all.includes(tok) && !all.includes(hashToken(tok)) && !all.includes('lifeos-archive-2022') && !all.includes(APP) && !all.includes('127.0.0.1') && !all.includes('ADV'));
  for (const l of logs) assert.match(l, /^ts=\S+ method=(GET|PUT|POST|OPTIONS|OTHER) route=[a-z]+ status=\d+ in=\d+ out=\d+ ms=\d+$/);
  const dir0 = dir; assert.ok(existsSync(dir0));
});
test('methods and paths: unknown routes 404, wrong methods 405, long urls refused', async () => {
  assert.equal((await call('/v1/nothing')).status, 404);
  assert.equal((await call('/v1/health', { method: 'DELETE' })).status, 405);
  assert.equal((await call('/v1/vault', { method: 'DELETE' })).status, 405);
  assert.equal((await call('/' + 'a'.repeat(300))).status, 414);
});
test('CLI: add prints a token once and stores only its hash; register by hash; revoke; list shows names only', async () => {
  const out = []; const e = { LIFEOS_CONFIG_DIR: join(dir, 'clicfg') };
  assert.equal(await cli(['token', 'add', 'nas-test'], e, (s) => out.push(s)), 0);
  const token = /lfs_[A-Za-z0-9_-]{43}/.exec(out[0])[0];
  assert.ok(!readFileSync(join(dir, 'clicfg', 'tokens.json'), 'utf8').includes(token));
  assert.equal(await cli(['token', 'register', 'phone', hashToken('x')], e, (s) => out.push(s)), 0);
  out.length = 0; await cli(['token', 'list'], e, (s) => out.push(s));
  assert.equal(out.length, 2); assert.ok(out.every((l) => !l.includes(token) && !/[0-9a-f]{64}/.test(l)));
  assert.equal(await cli(['token', 'revoke', 'nas-test'], e, () => {}), 0);
  assert.equal(await cli(['token', 'revoke', 'nas-test'], e, () => {}), 1);
  assert.equal(await cli(['token', 'bogus'], e, () => {}), 2);
});
test('the service source uses only node: built-ins and has no package dependencies', () => {
  const files = ['index.mjs', 'lib/app.mjs', 'lib/config.mjs', 'lib/storage.mjs', 'lib/tokens.mjs', 'lib/validate.mjs'];
  for (const f of files) {
    const t = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    for (const m of t.matchAll(/from '([^']+)'/g)) assert.ok(m[1].startsWith('node:') || m[1].startsWith('./'), f + ' imports ' + m[1]);
    assert.ok(!/\beval\(|new Function|child_process/.test(t), f);
  }
});
test('startup removes leftover temp files; a crash between write and rename never leaves a half-written current copy', async () => {
  const { Storage } = await import('../lib/storage.mjs');
  const d = mkdtempSync(join(tmpdir(), 'lifeos-stor-'));
  const s1 = new Storage(d);
  await s1.putVault(env(1), 1, 'none');
  writeFileSync(join(d, 'vault', '.tmp-deadbeef'), 'half a file'); writeFileSync(join(d, 'archives', '.tmp-feed'), 'half');
  const s2 = new Storage(d);
  assert.deepEqual(readdirSync(join(d, 'vault')).filter((f) => f.startsWith('.tmp-')), []); assert.deepEqual(readdirSync(join(d, 'archives')), []);
  assert.equal(s2.current().id, 0); assert.equal(s2.readVersion(0).text, env(1));
  rmSync(d, { recursive: true, force: true });
});
