// v2.0.0 (SPEC.md "v2.0.0 addendum: NAS" and "Amendment (v2.0.0 build)"): the app's NAS sync target against the real service,
// archive copies, the device token, schema 20, and the AI home hosts. The service itself is tested in server/test/.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { L, PASS, memAdapter, E } from './_load.mjs';
import { build, vault, io, clone, fastKeys, realKeys, PRIV, TODAY, ARCH_MARK } from './_archive.mjs';
import { loadConfig } from '../server/lib/config.mjs';
import { createApp } from '../server/lib/app.mjs';
import { hashToken } from '../server/lib/tokens.mjs';

const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), N = live('nas'), A = live('archive'), O = live('ops'), AI = live('ai'), V = live('vault'), P = live('priv');
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const MARK = 'ADV "quoted" marker with spaces \'single\' \\ back and a tab\t';
const APP = 'https://lifeos.example.test';
const rej = async (p, re) => { try { await p; } catch (e) { if (re) assert.match(String(e.message) + ' ' + e.code, re); return e; } assert.fail('expected a rejection'); };

let srv = null, sent = [], dir = null, nowMs = 1_800_000_000_000;
async function startService(over = {}) {
  dir = mkdtempSync(join(tmpdir(), 'lifeos-v200-'));
  const cfg = loadConfig({}, Object.assign({ configDir: join(dir, 'cfg'), dataDir: join(dir, 'data'), appOrigins: [APP], port: 0, writePerMin: 5000, rateLimitPerMin: 50000, log: () => {}, now: () => nowMs }, over));
  const a = createApp(cfg);
  await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
  srv = Object.assign(a, { base: 'http://127.0.0.1:' + a.server.address().port });
  sent = [];
  // Every request the app makes is recorded (url, method, headers, body) before it goes out.
  L.nas._setFetch(async (url, o) => { sent.push({ url: String(url), method: o.method, headers: Object.assign({}, o.headers), body: typeof o.body === 'string' ? o.body : undefined }); return fetch(url, o); });
  L.nas._setBase(srv.base);
}
async function stopService() {
  L.nas._setFetch(null); L.nas._setBase(null);
  if (srv) { srv.server.closeAllConnections(); await new Promise((r) => srv.server.close(r)); srv = null; }
  if (dir) rmSync(dir, { recursive: true, force: true });
}
const test = (name, fn) => nodeTest(name, async (t) => {
  fastKeys(); O._reset(); await startService();
  try { return await fn(t); } finally { try { P.close('system'); } catch (e) { /* closed */ } try { S.lock(); } catch (e) { /* locked */ } await stopService(); realKeys(); }
});
// Make a device: a fresh vault whose token is registered on the running service. Returns the stored-envelope adapter.
async function device(state, name = 'laptop', o = {}) {
  const ad = await vault(state, o);
  const { hash } = await N.createToken();
  srv.tokens.register(name, hash);
  return ad;
}
const cur = () => S.getState().settings.nas;
const rev = async () => (await (await fetch(srv.base + '/v1/health', { headers: { authorization: 'Bearer ' + S.getState().settings.nas.token } })).json()).rev;

// ---------------------------------------------------------------- token
test('the device token is made in the browser, kept only inside the encrypted state, and only its hash is returned', async () => {
  const ad = await vault(null);
  const r = await N.createToken();
  const t = cur().token;
  assert.match(t, /^lfs_[A-Za-z0-9_-]{43}$/);
  assert.equal(r.hash, hashToken(t)); assert.deepEqual(Object.keys(r), ['hash']);
  assert.ok(!JSON.stringify(r).includes(t));
  // not in the stored bytes, the audit log, the diagnostics text or a sync fingerprint
  assert.ok(!JSON.stringify(ad._m.get('envelope')).includes(t));
  assert.ok(!JSON.stringify(S.getState().audit).includes(t) && S.getState().audit.some((a) => a.action === 'nas token created'));
  assert.ok(!O.format(S.getState(), { version: '2.0.0', userAgent: 'x' }).includes(t));
  assert.equal(await L.sync.fingerprint(S.getState()), await L.sync.fingerprint(Object.assign(clone(S.getState()), { settings: Object.assign(clone(S.getState().settings), { nas: { token: '', tokenAt: '', remoteRev: -1, srev: -1, fp: '', keySalt: '' } }) })));
  // it is read back after a lock and unlock, so it really is in the sealed state
  S.lock(); await S.unlock(PASS);
  assert.equal(cur().token, t);
  assert.notEqual(N.makeToken(), N.makeToken());
});
test('setToken takes only a well-formed token; removeToken clears the token and the bookkeeping', async () => {
  await vault(null);
  for (const bad of ['', 'lfs_short', 'xyz_' + 'A'.repeat(43), 'lfs_' + 'A'.repeat(44), 'lfs_' + 'A'.repeat(42) + '!', MARK, 5, null]) { const e = await rej(N.setToken(bad)); assert.equal(e.code, 'BAD_TOKEN'); assert.ok(!String(e.message).includes('AAAA')); }
  const good = 'lfs_' + 'Ab1_-'.repeat(8) + 'Ab1';
  await N.setToken('  ' + good + ' ');
  assert.equal(cur().token, good); assert.equal(await N.currentHash(), hashToken(good));
  await N.removeToken();
  assert.deepEqual(cur(), { token: '', tokenAt: '', remoteRev: -1, srev: -1, fp: '', keySalt: '' });
  assert.equal(N.hasToken(), false);
  // a changed token keeps what this device last synced
  await S.commit((x) => { x.settings.nas.remoteRev = 7; x.settings.nas.srev = 2; });
  await N.setToken(good); await N.removeToken(); await N.createToken();
  assert.deepEqual([cur().remoteRev, cur().srev], [7, 2]);
});
test('without a token no request is made; the message says what to do', async () => {
  await vault(null);
  const e = await rej(N.run(), /token/); assert.equal(e.code, 'NAS_AUTH'); assert.equal(sent.length, 0);
});

// ---------------------------------------------------------------- sync
test('first sync uploads; the second is in sync; a local change uploads again with the expected revision; bookkeeping lives in settings.nas only', async () => {
  const ad = await device(null);
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 5 })); });
  let r = await N.run();
  assert.equal(r.kind, 'uploaded'); assert.equal(r.target, 'nas');
  assert.equal(sent.filter((q) => q.method === 'PUT')[0].headers['X-Expected-Rev'], 'none');
  assert.equal(cur().srev, 0); assert.equal(cur().remoteRev, r.rev); assert.match(cur().fp, /^[0-9a-f]{64}$/);
  assert.deepEqual(S.getState().settings.sync, { clientId: '', remoteRev: -1, fp: '', fileId: '', keySalt: '' }, 'Drive bookkeeping untouched');
  assert.equal((await N.run()).kind, 'in-sync');
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 6 })); });
  r = await N.run(); assert.equal(r.kind, 'uploaded');
  assert.equal(sent.filter((q) => q.method === 'PUT').slice(-1)[0].headers['X-Expected-Rev'], '0');
  assert.equal(cur().srev, 1); assert.equal(await rev(), 1);
  // the stored copy is exactly the sealed envelope that was sent
  const stored = JSON.parse(readFileSync(join(dir, 'data', 'vault', readdirSync(join(dir, 'data', 'vault')).sort().pop()), 'utf8'));
  assert.deepEqual(stored, JSON.parse(sent.filter((q) => q.method === 'PUT').pop().body));
  void ad;
});
test('compare-and-swap: a write that lands between the read and the put is refused, nothing is overwritten, and the next sync shows the conflict', async () => {
  await device(null);
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 1 })); });
  await N.run();
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 2 })); });
  const keep = (await (await fetch(srv.base + '/v1/vault', { headers: { authorization: 'Bearer ' + cur().token } })).text());
  // another device writes right after this one reads
  let hit = false;
  L.nas._setFetch(async (url, o) => {
    if (o.method === 'PUT' && !hit) { hit = true; const other = await fetch(url, { method: 'PUT', headers: Object.assign({}, o.headers, { 'X-Expected-Rev': '0' }), body: keep }); assert.equal(other.status, 200); }
    return fetch(url, o);
  });
  const e = await rej(N.run()); assert.equal(e.code, 'REMOTE_CHANGED'); assert.match(e.message, /Nothing was overwritten/);
  assert.equal(await rev(), 1, 'the other writer\'s copy is the current one');
  assert.equal(cur().srev, 0, 'bookkeeping did not move');
  L.nas._setFetch(null); L.nas._setFetch((u, o) => fetch(u, o));
  // the copy that won is a valid sealed copy of the same content, so the next sync simply writes this device's change on top of it
  const d = await N.run();
  assert.equal(d.kind, 'uploaded'); assert.equal(await rev(), 2);
});
test('two devices: a remote change is a download offer, both changed is a conflict that saves the losing copy first; adopting never takes the other device\'s token', async () => {
  const adA = await device(null, 'laptop');
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 11 })); });
  await N.run();
  const tokenA = cur().token;
  const envA = clone(adA._m.get('envelope'));
  // device B is a copy of device A's vault with its own token
  const adB = memAdapter(); await adB.set('envelope', envA); S._setAdapter(adB); S.lock(); await S.unlock(PASS);
  const { hash } = await N.createToken(); srv.tokens.register('phone', hash);
  const tokenB = cur().token; assert.notEqual(tokenA, tokenB);
  assert.equal((await N.run()).kind, 'in-sync', 'a new token keeps what this copy last synced');
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 22 })); });
  let r = await N.run(); assert.equal(r.kind, 'uploaded');
  // back on A: B's change is newer, A has none: an offer
  S._setAdapter(adA); S.lock(); await S.unlock(PASS);
  assert.equal(cur().token, tokenA);
  const d = await N.run(); assert.equal(d.kind, 'download-offer'); assert.equal(d.remote.entries, 2); assert.equal(d.local.entries, 1);
  const saved = [];
  // A also changes: a conflict
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 33 })); });
  const c = await N.run(); assert.equal(c.kind, 'conflict');
  await rej(N.apply(c, 'remote', {}), /backup/);
  const done = await N.apply(c, 'remote', { saveBackup: async (t, n) => { saved.push([n, t]); } });
  assert.equal(done.kind, 'downloaded'); assert.equal(saved.length, 1); assert.match(saved[0][0], /^lifeos-local-copy-/);
  assert.equal(S.getState().entries.length, 2);
  assert.equal(cur().token, tokenA, 'this device keeps its own token after adopting a copy');
  assert.equal((await N.run()).kind, 'in-sync');
  // keep local on a second conflict: the NAS copy is saved, then replaced
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 44 })); });
  S._setAdapter(adB); S.lock(); await S.unlock(PASS);
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 55 })); });
  await N.run();
  S._setAdapter(adA); S.lock(); await S.unlock(PASS);
  const c2 = await N.run(); assert.equal(c2.kind, 'conflict');
  const up = await N.apply(c2, 'local', { saveBackup: async (t, n) => { saved.push([n, t]); } });
  assert.equal(up.kind, 'uploaded'); assert.match(saved[1][0], /^lifeos-nas-copy-/);
  assert.equal((await N.apply(c2, 'cancel')).kind, 'cancelled');
  await rej(N.apply(c2, 'bogus', {}), /Unknown/);
});
test('rollback: a copy older than the last sync is refused (for example after a version was restored on the service)', async () => {
  await device(null);
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 1 })); }); await N.run();
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 2 })); }); await N.run();
  const list = await N.versions(); assert.equal(list.length, 2);
  const r = await fetch(srv.base + '/v1/versions/' + list[1].id + '/restore', { method: 'POST', headers: { authorization: 'Bearer ' + cur().token, 'x-expected-rev': String(list[0].id) } });
  assert.equal(r.status, 200);
  const e = await rej(N.run()); assert.equal(e.code, 'ROLLBACK'); assert.equal(O.codeFor(e), 'SYNC_ROLLBACK');
  assert.match(await N.getVersion(list[1].id), /"rev"/);
  await rej(N.getVersion(99999), /no longer/); await rej(N.getVersion(-1));
});
test('a NAS copy under another passphrase asks for it with NAS wording; a wrong one is refused; a tampered copy fails closed', async () => {
  const adA = await device(null);
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 1 })); }); await N.run();
  const token = cur().token;
  // a different vault (other key) on this device sees the same NAS copy
  const adC = memAdapter(); S._setAdapter(adC); S.lock(); await S.init('another passphrase 123');
  await S.commit((x) => { x.settings.nas = Object.assign({}, x.settings.nas, { token }); });
  let e = await rej(N.run()); assert.equal(e.code, 'NEED_PASSPHRASE'); assert.match(e.message, /NAS copy/); assert.ok(!/Drive/.test(e.message));
  e = await rej(N.run({ passphrase: 'wrong passphrase here' })); assert.equal(e.code, 'WRONG_PASSPHRASE'); assert.match(e.message, /NAS copy/);
  const d = await N.run({ passphrase: PASS }); assert.ok(['conflict', 'download-offer'].includes(d.kind)); assert.equal(d.passphraseDiffers, true);
  // junk on the service
  const bad = await fetch(srv.base + '/v1/vault', { method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-expected-rev': '0' }, body: '{"v":1}' });
  assert.equal(bad.status, 422);
  void adA;
});
test('unreachable, refused token, limits and odd replies map to fixed codes and fixed messages (no raw network text, no token)', async () => {
  await device(null);
  const token = cur().token;
  const ERR = 'ECONNREFUSED connect 100.64.1.2:443 ' + MARK;
  L.nas._setFetch(async () => { throw Object.assign(new TypeError('fetch failed: ' + ERR), { cause: ERR }); });
  let e = await rej(N.run()); assert.equal(e.code, 'NAS_UNREACHABLE'); assert.match(e.message, /Connect Tailscale and try again\./);
  assert.ok(!e.message.includes('100.64') && !e.message.includes('ADV') && !e.message.includes(token));
  assert.equal(O.codeFor(e), 'SYNC_NAS_UNREACHABLE');
  const t = await N.test(); assert.equal(t.ok, false); assert.equal(t.code, 'NAS_UNREACHABLE'); assert.match(t.message, /Tailscale/);
  const reply = (status, body, headers = {}) => async () => ({ status, ok: status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => body });
  for (const [st, code, re] of [[401, 'NAS_AUTH', /token/], [413, 'TOO_LARGE', /too large/], [422, 'REMOTE_INVALID', /format/], [429, 'HTTP', /limiting/], [500, 'HTTP', /HTTP 500/]]) {
    L.nas._setFetch(reply(st, 'x'.repeat(10) + MARK, { 'x-rev': '3' }));
    e = await rej(N.run()); assert.equal(e.code, code, String(st)); assert.match(e.message, re); assert.ok(!e.message.includes('ADV') && !e.message.includes(token));
  }
  L.nas._setFetch(reply(200, 'not json', { 'x-rev': '0' })); e = await rej(N.run()); assert.equal(e.code, 'REMOTE_INVALID');
  L.nas._setFetch(reply(200, '{}', {})); e = await rej(N.run()); assert.equal(e.code, 'REMOTE_INVALID');
  L.nas._setFetch(reply(409, JSON.stringify({ code: 'CONFLICT', rev: 4 }))); e = await rej(N.run()); assert.equal(e.code, 'REMOTE_INVALID');
  // an oversized chunked reply is cut off at 64 MB
  L.nas._setFetch(async () => ({ status: 200, ok: true, headers: { get: (k) => (k.toLowerCase() === 'x-rev' ? '0' : null) }, body: { getReader: () => ({ read: async () => ({ done: false, value: { byteLength: 70 * 1024 * 1024 } }), cancel: async () => {} }) } }));
  e = await rej(N.run()); assert.equal(e.code, 'TOO_LARGE');
  // diagnostics hold codes only
  O.recordError(new Error('x'), 'sync'); // unmapped: nothing kept
  const txt = O.format(S.getState(), { version: '2.0.0', userAgent: 'x' });
  assert.ok(!txt.includes('100.64') && !txt.includes('ADV') && !txt.includes(token));
  assert.ok(O.CODES.includes('SYNC_NAS_UNREACHABLE') && O.CODES.includes('SYNC_NAS_AUTH'));
});
test('every request goes to the one configured name over https with credentials omitted, no redirects, the token only in the Authorization header', async () => {
  await device(null);
  L.nas._setBase(null);
  const prev = L.HOSTS; L.HOSTS = { app: 'a.example.test', sync: 'sync.example.test', 'ai-nas': 'n.example.test', 'ai-pc': 'p.example.test' };
  const seen = [];
  L.nas._setFetch(async (url, o) => { seen.push({ url, o }); throw new TypeError('offline'); });
  try {
    await rej(N.run()); await rej(N.putNamed('lifeos-archive-2020.json', '{}')); await rej(N.versions()); await N.test();
    assert.ok(seen.length >= 4);
    for (const q of seen) {
      assert.match(q.url, /^https:\/\/sync\.example\.test\/v1\//); assert.ok(!q.url.includes('?') && !q.url.includes('#') && !q.url.includes('lfs_'));
      assert.equal(q.o.credentials, 'omit'); assert.equal(q.o.redirect, 'error'); assert.equal(q.o.referrerPolicy, 'no-referrer'); assert.equal(q.o.cache, 'no-store');
      assert.ok(/^Bearer lfs_/.test(q.o.headers.Authorization));
      assert.deepEqual(Object.keys(q.o.headers).filter((k) => k !== 'Authorization' && k !== 'Content-Type' && k !== 'X-Expected-Rev'), []);
    }
    assert.equal(N.isAvailable({ protocol: 'https:', hostname: 'x' }), true);
    assert.equal(N.isAvailable({ protocol: 'http:', hostname: 'lifeos.example.test' }), false);
    assert.equal(N.isAvailable({ protocol: 'file:', hostname: '' }), false);
    L.HOSTS = undefined; assert.equal(N.isAvailable({ protocol: 'https:', hostname: 'x' }), false);
  } finally { L.HOSTS = prev; }
  // the test hook cannot point anywhere but localhost
  for (const u of ['https://evil.example', 'http://evil.example:8080', 'http://localhost.evil.example:8080', 'http://127.0.0.1:80/x']) { L.nas._setBase(u); L.HOSTS = undefined; assert.equal(N.isConfigured(), false, u); }
  L.HOSTS = prev;
});

// ---------------------------------------------------------------- nothing but ciphertext leaves
test('no plaintext, passphrase, recovery key or key material ever reaches the service: every request and every stored byte is checked against adversarial markers', async () => {
  const st = build([2024]);
  st.entries.push(E({ domain: 'money', type: 'expense', value: 7, title: MARK + ' lunch', notes: MARK, category: 'Dining' }));
  st.accounts.push({ id: 'accM', name: MARK + ' acct', kind: 'cash', liability: false, archived: false });
  const ad = await device(st, 'laptop', { priv: true });
  await S.commit((x) => { x.settings.business.name = MARK; x.settings.aiHosts.nasModel = 'llama3.2'; x.settings.provider = { kind: 'anthropic', baseUrl: '', model: 'claude-haiku-4-5', apiKey: 'sk-ant-' + 'k'.repeat(30) + MARK.replace(/[^\x21-\x7e]/g, '') }; });
  const h = await S.beginRecovery(PASS); await h.finish(h.key);
  const rk = h.key;
  await P.open(PRIV);
  await P.commit((w) => { w.records.entries = [E({ domain: 'money', type: 'expense', value: 9, title: 'PRIVSECRET ' + MARK })]; });
  P.close('system');
  await N.run();
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 8, title: MARK + ' two' })); });
  await N.run();
  await N.putNamed('lifeos-archive-2024.json', JSON.stringify(Object.assign(JSON.parse(ad._m.get('envelope') ? JSON.stringify(V.cleanEnvelope(ad._m.get('envelope'))) : '{}'), { arch: 1, year: 2024 })));
  const markers = [PASS, PRIV, rk, rk.replace(/-/g, ''), rk.replace(/-/g, '').slice(0, 20), MARK, MARK.trim(), 'marker with spaces', 'quoted', ARCH_MARK, 'PRIVSECRET', 'sk-ant-', 'llama3.2', 'Dining', 'lunch'];
  const everything = sent.map((q) => q.url + '\n' + JSON.stringify(q.headers) + '\n' + (q.body || '')).join('\n');
  assert.ok(sent.length >= 5 && sent.some((q) => q.method === 'PUT'));
  for (const m of markers) assert.ok(!everything.includes(m), 'request holds ' + m.slice(0, 12));
  for (const q of sent) {
    assert.ok(!q.url.includes(cur().token) && !(q.body || '').includes(cur().token));
    if (q.method === 'PUT') { const o = JSON.parse(q.body); assert.ok(Object.keys(o).every((k) => ['v', 'kdf', 'iv', 'ct', 'fmt', 'wraps', 'data', 'rev', 'updatedAt', 'deviceId', 'arch', 'year'].includes(k))); }
  }
  const files = [];
  for (const sub of ['vault', 'archives']) for (const f of readdirSync(join(dir, 'data', sub))) files.push(readFileSync(join(dir, 'data', sub, f), 'utf8'));
  assert.ok(files.length >= 3);
  for (const f of files) for (const m of markers) assert.ok(!f.includes(m), 'stored file holds ' + m.slice(0, 12));
  // the token is not in any stored byte either (only its hash is on the service)
  const tokensFile = readFileSync(srv.config.tokensFile, 'utf8');
  assert.ok(!tokensFile.includes(cur().token) && !files.join('').includes(cur().token));
  // and what the service stored opens with the passphrase and with the recovery key, so it is a complete, sealed copy
  const copy = await (await fetch(srv.base + '/v1/vault', { headers: { authorization: 'Bearer ' + cur().token } })).text();
  const info = await S.inspectEnvelope(JSON.parse(copy), PASS); assert.ok(info.state.entries.some((e) => e.title.includes('two')));
});

// ---------------------------------------------------------------- archives
test('archive copies: the NAS copy is written, downloaded again, decrypted and matched; only then does it count as the verified copy', async () => {
  const st = build([2021, 2022, 2023, 2024, 2025, 2026]);
  await device(st);
  const nio = Object.assign(io({}), { nasPut: (n, t) => N.putNamed(n, t), nasGet: (n) => N.getNamed(n) });
  const r = await A.archiveYear({ year: 2021, passphrase: PASS, today: TODAY, drive: false, nas: true, download: false, io: nio });
  assert.deepEqual(r.copies.map((c) => c.where), ['nas']); assert.equal(r.copies[0].verified, true);
  assert.deepEqual(S.getState().archives[0].copies.map((c) => c.where), ['nas']);
  assert.deepEqual((await (await fetch(srv.base + '/v1/archives', { headers: { authorization: 'Bearer ' + cur().token } })).json()).archives.map((a) => a.name), ['lifeos-archive-2021.json']);
  // the NAS copy opens read-only from the NAS
  const text = await N.getNamed('lifeos-archive-2021.json');
  const info = await A.openArchive(text, PASS, 2021); assert.equal(info.year, 2021);
  A.drop();
  await rej(N.getNamed('lifeos-archive-2019.json'), /not on the NAS/); await rej(N.getNamed('../vault.json'), /not an archive/); await rej(N.putNamed('evil.json', '{}'), /not an archive/);
});
test('a NAS copy that comes back damaged is not a verified copy: nothing is removed from the vault', async () => {
  const st = build([2021, 2022, 2023, 2024, 2025, 2026]);
  await device(st);
  const before = JSON.stringify(S.getState().entries);
  const nio = Object.assign(io({}), { nasPut: (n, t) => N.putNamed(n, t), nasGet: async (n) => { const t = await N.getNamed(n); return t.slice(0, -30) + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; } });
  await rej(A.archiveYear({ year: 2021, passphrase: PASS, today: TODAY, drive: false, nas: true, download: false, io: nio }));
  assert.equal(JSON.stringify(S.getState().entries), before); assert.deepEqual(S.getState().archives, []);
  // an unreachable NAS with no other copy: the same
  L.nas._setFetch(async () => { throw new TypeError('offline'); });
  const e = await rej(A.archiveYear({ year: 2021, passphrase: PASS, today: TODAY, drive: false, nas: true, download: false, io: nio })); assert.equal(e.code, 'NAS_UNREACHABLE');
  assert.equal(JSON.stringify(S.getState().entries), before);
  // with a confirmed download as well, the archive goes ahead on that verified copy alone
  const box = {}; const both = Object.assign(io(box), { nasPut: nio.nasPut, nasGet: nio.nasGet });
  const ok = await A.archiveYear({ year: 2021, passphrase: PASS, today: TODAY, drive: false, nas: true, download: true, io: both });
  assert.deepEqual(ok.copies.map((c) => c.where), ['download']);
});

// ---------------------------------------------------------------- schema 20
test('schema 20: migrations from every older schema give an empty NAS record and empty host choices; bad values fail; the number after is refused', () => {
  assert.equal(S.SCHEMA, 21);
  const full = S.defaultState();
  for (let n = 1; n <= 19; n++) {
    const o = clone(full); o.schema = n; delete o.settings.nas; delete o.settings.aiHosts;
    const got = S.validateState(o);
    assert.equal(got.schema, 21); assert.equal(got.sourceSchema, n);
    assert.deepEqual(got.settings.nas, { token: '', tokenAt: '', remoteRev: -1, srev: -1, fp: '', keySalt: '' });
    assert.deepEqual(got.settings.aiHosts, { nasModel: '', pcModel: '', fallback: '' });
  }
  const ok = clone(full); ok.settings.nas = { token: 'lfs_' + 'A'.repeat(43), tokenAt: '2026-11-22', remoteRev: 5, srev: 2, fp: 'a'.repeat(64), keySalt: 'A'.repeat(22) + '==' };
  ok.settings.aiHosts = { nasModel: 'm1', pcModel: 'm2', fallback: 'nas' };
  assert.deepEqual(S.validateState(clone(ok)).settings.nas, ok.settings.nas);
  for (const [k, v] of [['token', 'lfs_x'], ['token', 5], ['tokenAt', 'yesterday'], ['remoteRev', -2], ['srev', 1e10], ['fp', 'zz'], ['keySalt', 'bad']]) {
    const b = clone(ok); b.settings.nas[k] = v; assert.throws(() => S.validateState(b), /Invalid data/, k);
  }
  for (const [k, v] of [['fallback', 'cloud'], ['nasModel', 'x'.repeat(101)], ['pcModel', 5]]) { const b = clone(ok); b.settings.aiHosts[k] = v; assert.throws(() => S.validateState(b), /Invalid data/, k); }
  const b2 = clone(ok); b2.settings.nas = 'x'; assert.throws(() => S.validateState(b2), /Invalid data/);
  assert.throws(() => S.validateState(Object.assign(clone(full), { schema: 22 })), /schema/);
  const p = clone(full); p.settings.provider = { kind: 'nas', baseUrl: 'http://evil.example', model: 'm', apiKey: 'secret' };
  const pv = S.validateState(p).settings.provider; assert.deepEqual([pv.kind, pv.baseUrl, pv.apiKey, pv.model], ['nas', '', '', 'm'], 'a stored address or key is never kept for a home host');
});
test('downgrade guards: an older backup restored here keeps this device\'s NAS token, bookkeeping and host choices; a restored backup on a new vault starts with no token', async () => {
  await device(null);
  await N.run();
  await S.commit((x) => { x.settings.aiHosts = { nasModel: 'keepme', pcModel: '', fallback: 'nas' }; });
  const before = clone(cur()), hosts = clone(S.getState().settings.aiHosts);
  const old = clone(S.getState()); old.schema = 19; delete old.settings.nas; delete old.settings.aiHosts;
  await S.replaceState(S.validateState(old));
  assert.deepEqual(cur(), before); assert.deepEqual(S.getState().settings.aiHosts, hosts);
  // a same-schema backup from another device never brings its token
  const other = clone(S.getState()); other.settings.nas.token = 'lfs_' + 'Z'.repeat(43); other.settings.nas.remoteRev = 99;
  await S.replaceState(S.validateState(other));
  assert.deepEqual(cur(), before);
  // backup restore on the lock screen creates a vault with an empty NAS record
  const backup = clone(S.getState()); backup.settings.nas.token = 'lfs_' + 'Y'.repeat(43);
  const imp = S.validateState(backup);
  S.lock(); S._setAdapter(memAdapter());
  // v2.0.0 audit (SEC-138): this step called a function that does not exist and skipped its check; it now runs the real lock-screen restore.
  await S.createFromBackup('a new passphrase 123', imp);
  assert.ok(S.isUnlocked());
  assert.deepEqual(S.getState().settings.nas, { token: '', tokenAt: '', remoteRev: -1, srev: -1, fp: '', keySalt: '' });
});
test('a copy downloaded as the first vault of a device (Drive install) never brings the other device\'s token', async () => {
  const ad = await device(null);
  await N.run();
  const envText = JSON.stringify(await S.exportEnvelope());
  S.lock(); S._setAdapter(memAdapter());
  const info = await S.installEnvelope(JSON.parse(envText), PASS);
  assert.deepEqual(info.state.settings.nas, { token: '', tokenAt: '', remoteRev: -1, srev: -1, fp: '', keySalt: '' });
  assert.deepEqual(S.getState().settings.nas, { token: '', tokenAt: '', remoteRev: -1, srev: -1, fp: '', keySalt: '' });
  void ad;
});
test('the sync fingerprint ignores the NAS record (the token and bookkeeping are this device\'s, not content)', async () => {
  await device(null);
  const fp = await L.sync.fingerprint(S.getState());
  await S.commit((x) => { x.settings.nas.remoteRev = 44; x.settings.nas.srev = 3; x.settings.nas.fp = 'b'.repeat(64); });
  assert.equal(await L.sync.fingerprint(S.getState()), fp);
  await S.commit((x) => { x.settings.aiHosts.fallback = 'pc'; });
  assert.notEqual(await L.sync.fingerprint(S.getState()), fp, 'a host choice is a real setting');
});

// ---------------------------------------------------------------- repository rules for the new files
import { readdirSync as ls, statSync as st2 } from 'node:fs';
nodeTest('the new files: no banned DOM or storage calls, no em dashes, no secrets, tokens, API keys or Tailscale addresses', () => {
  const files = ['src/core/nas.js', 'src/ui/nas-ui.js', 'config/hosts.json', 'docs/NAS-SETUP.md', 'docs/AI-SETUP.md', 'server/Dockerfile', 'server/compose.yaml', 'server/Caddyfile.example', 'test/smoke-nas.mjs', 'test/smoke-nas-service.mjs'];
  const walk = (d) => ls(new URL('../' + d, import.meta.url)).flatMap((f) => (st2(new URL('../' + d + '/' + f, import.meta.url)).isDirectory() ? walk(d + '/' + f) : [d + '/' + f]));
  for (const f of walk('server')) if (!files.includes(f)) files.push(f);
  for (const f of ['src/core/ai.js', 'src/core/store.js', 'src/core/sync.js', 'src/core/archive.js', 'src/ui/archive-ui.js', 'src/ui/sync-ui.js', 'build.mjs', 'docs/CHANGELOG.md']) files.push(f);
  for (const f of files) {
    const t = src(f);
    assert.ok(!/\u2014/.test(t), f + ' has an em dash');
    if (/\.(js|mjs)$/.test(f) && !f.startsWith('test/')) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|localStorage/.test(t.replace(/\/\/.*$/gm, '')), f + ' uses a banned call');
    assert.ok(!/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/.test(t), f + ' holds a Tailscale-range address');
    assert.ok(!/lfs_[A-Za-z0-9_-]{43}/.test(t.replace(/'lfs_' \+|\^lfs_|lfs_\[/g, '')) || f.startsWith('test/'), f + ' holds a token');
    assert.ok(!/sk-ant-[A-Za-z0-9]{10,}|cfut_[A-Za-z0-9]{10,}|CLOUDFLARE_API_TOKEN=[A-Za-z0-9]|(api|bearer)[_ -]?token\s*[:=]\s*["']?[A-Za-z0-9_-]{30,}/i.test(t), f + ' looks like it holds a secret');
  }
  assert.match(src('server/Caddyfile.example'), /dns cloudflare \{env\.CLOUDFLARE_API_TOKEN\}/);
  assert.ok(!/CLOUDFLARE_API_TOKEN\s*[:=]/.test(src('server/compose.yaml')));
  // the settings the UI writes never include a typed address
  assert.ok(!/baseUrl/.test(src('src/ui/nas-ui.js')));
});
