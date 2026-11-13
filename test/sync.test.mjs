import test from 'node:test';
import assert from 'node:assert/strict';
import { L, memAdapter, PASS, E } from './_load.mjs';

const TOKEN = 'ya29.SECRETTOKENVALUE_1234567890abcdef';
const OTHER = 'a totally different passphrase';

function drive(opts = {}) {
  const d = { file: null, calls: [], version: 1, etag: '"e1"', fail: null, size: null, clen: null };
  const res = (status, body, headers = {}) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  d.put = (text) => { d.file = { id: 'file12345', text }; d.version++; d.etag = '"e' + d.version + '"'; };
  d.fetch = async (url, o) => {
    d.calls.push({ url, method: o.method, headers: o.headers, opts: o });
    assert.equal(o.credentials, 'omit'); assert.equal(o.redirect, 'error'); assert.ok(o.signal);
    if (d.fail) { const f = d.fail(url, o); if (f) return f; }
    const u = new URL(url);
    if (u.pathname === '/drive/v3/files') return res(200, { files: d.file ? [{ id: d.file.id, size: String(d.size ?? d.file.text.length), version: String(d.version) }] : [] });
    if (u.pathname.startsWith('/drive/v3/files/') && u.searchParams.get('alt') === 'media') return res(200, d.file.text, { etag: d.etag, ...(d.clen ? { 'content-length': String(d.clen) } : {}) });
    if (u.pathname.startsWith('/drive/v3/files/')) return res(200, { id: d.file.id, version: String(d.version) });
    if (o.method === 'POST') { d.put(o.body.split('Content-Type: application/json\r\n\r\n')[1].split('\r\n--')[0]); return res(200, { id: 'file12345' }); }
    if (o.method === 'PATCH') {
      if (o.headers['If-Match'] && o.headers['If-Match'] !== d.etag) return res(412, '');
      d.put(o.body); return res(200, { id: 'file12345' });
    }
    return res(500, 'x');
  };
  d.writes = () => d.calls.filter((c) => c.method === 'POST' || c.method === 'PATCH').length;
  return d;
}

async function setup() {
  const ad = memAdapter();
  L.store._setAdapter(ad);
  L.store.lock();
  await L.store.init(PASS);
  await L.store.commit((s) => { s.entries.push(E({ domain: 'money', type: 'expense', value: 5 })); });
  const d = drive();
  L.sync._setFetch(d.fetch);
  L.sync._setToken(TOKEN, 3600);
  return { ad, d };
}

test('auth url: scope, response_type token, state nonce', () => {
  const cid = 'abc-123.apps.googleusercontent.com';
  const u = new URL(L.sync.buildAuthUrl(cid, 'https://x.example/', 'nonce123'));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.appdata');
  assert.equal(u.searchParams.get('response_type'), 'token');
  assert.equal(u.searchParams.get('state'), 'nonce123');
  assert.equal(u.searchParams.get('client_id'), cid);
  assert.equal(u.searchParams.get('redirect_uri'), 'https://x.example/');
  assert.throws(() => L.sync.buildAuthUrl('evil&x=1', 'https://x.example/', 'n'), /client ID/);
});

test('begin stores only a nonce and needs https (or localhost)', () => {
  const store = new Map(), storage = { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k), removeItem: (k) => store.delete(k) };
  const url = L.sync.begin('abc.apps.googleusercontent.com', { loc: { protocol: 'https:', hostname: 'x.example', origin: 'https://x.example', pathname: '/app/' }, storage });
  const nonce = new URL(url).searchParams.get('state');
  assert.match(nonce, /^[0-9a-f]{32}$/);
  assert.equal([...store.values()].join(), nonce);
  assert.throws(() => L.sync.begin('abc.apps.googleusercontent.com', { loc: { protocol: 'http:', hostname: 'example.com' }, storage }), /https/);
  assert.equal(L.sync.isAvailable({ protocol: 'http:', hostname: '127.0.0.1' }), true);
  assert.equal(L.sync.isAvailable({ protocol: 'file:', hostname: '' }), false);
});

test('fragment parsing: only a matching state is accepted', () => {
  const good = '#access_token=' + TOKEN + '&token_type=Bearer&expires_in=3599&state=n1&scope=https://www.googleapis.com/auth/drive.appdata';
  const r = L.sync.parseFragment(good, 'n1');
  assert.equal(r.token, TOKEN); assert.equal(r.expiresIn, 3599);
  for (const [h, n] of [[good, 'n2'], [good, null], [good.replace('&state=n1', ''), 'n1'], ['#access_token=' + TOKEN + '&token_type=Bearer&state=', 'n1']]) {
    assert.throws(() => L.sync.parseFragment(h, n), (e) => e.code === 'STATE' && !e.message.includes(TOKEN));
  }
  assert.equal(L.sync.parseFragment('#section', 'n1'), null);
  assert.equal(L.sync.parseFragment('', 'n1'), null);
  assert.throws(() => L.sync.parseFragment('#error=access_denied&state=n1', 'n1'), (e) => e.code === 'DENIED');
  assert.throws(() => L.sync.parseFragment(good.replace('drive.appdata', 'drive'), 'n1'), (e) => e.code === 'BAD_SCOPE');
});

test('consumeReturn strips the fragment first, keeps token in memory, rejects a bad state', () => {
  L.sync.disconnect();
  const mk = (hash, nonce) => {
    const store = new Map(nonce ? [['lifeos.oauth.state', nonce]] : []);
    const log = [];
    return { log, store, loc: { hash, pathname: '/p', search: '?q=1' }, hist: { replaceState: (a, b, u) => log.push(u) },
      storage: { getItem: (k) => store.get(k) ?? null, removeItem: (k) => store.delete(k) } };
  };
  let m = mk('#access_token=' + TOKEN + '&token_type=Bearer&state=zz', 'yy');
  L.sync.consumeReturn(m.loc, m.storage, m.hist);
  assert.deepEqual(m.log, ['/p?q=1']); assert.equal(L.sync.isConnected(), false);
  const r = L.sync.takeReturn();
  assert.ok(r.error && !r.error.includes(TOKEN)); assert.equal(m.store.size, 0);
  m = mk('#access_token=' + TOKEN + '&token_type=Bearer&state=yy&expires_in=3000', 'yy');
  L.sync.consumeReturn(m.loc, m.storage, m.hist);
  assert.equal(L.sync.isConnected(), true); assert.deepEqual(L.sync.takeReturn(), { connected: true });
  L.sync.disconnect();
});

test('upload when remote missing; token never lands in state, storage or audit', async () => {
  const { ad, d } = await setup();
  const r = await L.sync.run();
  assert.equal(r.kind, 'uploaded');
  assert.equal(d.calls.filter((c) => c.method === 'POST').length, 1);
  const env = JSON.parse(d.file.text);
  assert.equal(env.rev, r.rev); assert.equal(typeof env.deviceId, 'string');
  assert.equal(d.calls[0].headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(L.store.getState().settings.sync.remoteRev, r.rev);
  assert.equal(L.store.getState().settings.sync.fileId, 'file12345');
  const blob = JSON.stringify([...ad._m.entries()]) + JSON.stringify(L.store.getState());
  assert.ok(!blob.includes(TOKEN));
  assert.ok(L.store.getState().audit.some((a) => /sync/.test(a.action)));
  assert.equal((await L.sync.run()).kind, 'in-sync');
});

test('local-only change uploads with If-Match', async () => {
  const { d } = await setup();
  await L.sync.run();
  await L.store.commit((s) => { s.entries.push(E({ domain: 'money', type: 'expense', value: 7 })); });
  const r = await L.sync.run();
  assert.equal(r.kind, 'uploaded');
  const patch = d.calls.find((c) => c.method === 'PATCH');
  assert.ok(patch.headers['If-Match']);
  assert.equal(JSON.parse(d.file.text).rev, r.rev);
});

async function remoteAhead() {
  const s = await setup();
  await L.sync.run();
  const before = await s.ad.get('envelope');
  await L.store.commit((x) => { x.entries.push(E({ domain: 'money', type: 'income', value: 99 })); });
  s.d.put(JSON.stringify(await L.store.exportEnvelope()));          // another device wrote this
  await s.ad.set('envelope', before);                                // this device is still at the old copy
  L.store.lock(); await L.store.unlock(PASS);
  return s;
}

test('download offered when remote is newer and local unchanged; apply adopts it', async () => {
  const { d } = await remoteAhead();
  const w = d.writes();
  const dec = await L.sync.run();
  assert.equal(dec.kind, 'download-offer');
  assert.equal(dec.remote.entries, dec.local.entries + 1);
  assert.ok(dec.remote.rev > dec.local.rev);
  assert.equal(d.writes(), w);
  const out = await L.sync.apply(dec, 'download');
  assert.equal(out.kind, 'downloaded');
  assert.equal(L.store.getState().entries.length, dec.remote.entries);
  assert.equal(L.store.getMeta().rev, dec.remote.rev);
  assert.equal((await L.sync.run()).kind, 'in-sync');
});

test('both changed: decision request, nothing written; resolution saves the losing copy first', async () => {
  const { ad, d } = await remoteAhead();
  await L.store.commit((x) => { x.entries.push(E({ domain: 'health', type: 'workout' })); });
  const envBefore = JSON.stringify(await ad.get('envelope')), fileBefore = d.file.text, w = d.writes();
  const dec = await L.sync.run();
  assert.equal(dec.kind, 'conflict');
  assert.ok(dec.local.entries >= 1 && dec.remote.entries >= 1);
  assert.equal(d.writes(), w); assert.equal(d.file.text, fileBefore);
  assert.equal(JSON.stringify(await ad.get('envelope')), envBefore);
  await assert.rejects(L.sync.apply(dec, 'local', {}), (e) => e.code === 'NEED_BACKUP');
  assert.equal(d.writes(), w);
  const saved = [];
  const remoteRev = dec.remote.rev;
  const out = await L.sync.apply(dec, 'local', { saveBackup: async (t, n) => { saved.push([t, n]); assert.equal(d.writes(), w); } });
  assert.equal(saved.length, 1); assert.equal(saved[0][0], fileBefore);
  assert.equal(out.kind, 'uploaded'); assert.ok(out.rev > remoteRev);
  assert.equal(JSON.parse(d.file.text).rev, out.rev);
});

test('both changed: choosing the Drive copy backs up the local copy first', async () => {
  const { d } = await remoteAhead();
  await L.store.commit((x) => { x.entries.push(E({ domain: 'health', type: 'workout' })); });
  const dec = await L.sync.run();
  const saved = [];
  const out = await L.sync.apply(dec, 'remote', { saveBackup: async (t, n) => saved.push(t) });
  assert.equal(out.kind, 'downloaded');
  assert.equal(JSON.parse(saved[0]).v, 1);
  assert.equal(L.store.getState().entries.length, dec.remote.entries);
});

test('outer/inner rev mismatch is rejected', async () => {
  const { d } = await setup();
  await L.sync.run();
  const env = JSON.parse(d.file.text); env.rev += 5; d.put(JSON.stringify(env));
  await assert.rejects(L.sync.run(), (e) => e.code === 'TAMPER');
  const env2 = JSON.parse(d.file.text); delete env2.rev; delete env2.updatedAt; delete env2.deviceId; d.put(JSON.stringify(env2));
  await assert.rejects(L.sync.run(), (e) => e.code === 'TAMPER');
});

test('older remote than last sync is rejected as rollback', async () => {
  const { ad, d } = await setup();
  await L.sync.run();
  const old = d.file.text;
  await L.store.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 1 })); });
  await L.sync.run();
  d.put(old);
  await assert.rejects(L.sync.run(), (e) => e.code === 'ROLLBACK');
});

test('oversized or malformed remote is rejected', async () => {
  const { d } = await setup();
  await L.sync.run();
  d.size = 65 * 1024 * 1024;
  await assert.rejects(L.sync.run(), (e) => e.code === 'TOO_LARGE');
  d.size = null; d.clen = 70 * 1024 * 1024;
  await assert.rejects(L.sync.run(), (e) => e.code === 'TOO_LARGE');
  d.clen = null;
  for (const bad of ['not json', '[]', '{"v":1}', JSON.stringify({ v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: 1, salt: 'AAAA' }, iv: 'x', ct: 'y' })]) {
    d.put(bad);
    await assert.rejects(L.sync.run(), (e) => e.code === 'REMOTE_INVALID', bad);
  }
  // decrypts fine but the state is garbage
  const salt = L.vault.newSalt(), key = await L.vault.deriveKey(PASS, salt);
  const env = await L.vault.makeEnvelope(key, salt, { schema: 1, entries: 'nope', _meta: { rev: 9, updatedAt: 'x', deviceId: 'd' } });
  Object.assign(env, { rev: 9, updatedAt: 'x', deviceId: 'd' });
  d.put(JSON.stringify(env));
  await assert.rejects(L.sync.run({ passphrase: PASS }), (e) => e.code === 'REMOTE_INVALID');
  assert.equal(d.writes(), 1);
});

test('remote with a different passphrase is reported distinctly', async () => {
  const { d } = await setup();
  const salt = L.vault.newSalt(), key = await L.vault.deriveKey(OTHER, salt);
  const m = { rev: 4, updatedAt: '2026-11-13T10:00:00.000Z', deviceId: 'dev-b' };
  const env = Object.assign(await L.vault.makeEnvelope(key, salt, Object.assign(L.store.defaultState(), { _meta: m })), m);
  d.put(JSON.stringify(env));
  await assert.rejects(L.sync.run(), (e) => e.code === 'NEED_PASSPHRASE');
  await assert.rejects(L.sync.run({ passphrase: PASS + 'x' }), (e) => e.code === 'WRONG_PASSPHRASE' && /different passphrase/.test(e.message));
  const dec = await L.sync.run({ passphrase: OTHER });
  assert.ok(dec.kind === 'conflict' || dec.kind === 'download-offer');
  assert.equal(dec.remote.rev, 4);
  assert.equal(d.writes(), 0);
});

test('HTTP 401 maps to a reconnect error and drops the token; no secrets in errors', async () => {
  const { d } = await setup();
  d.fail = () => ({ status: 401, ok: false, headers: { get: () => null }, text: async () => TOKEN });
  await assert.rejects(L.sync.run(), (e) => e.code === 'RECONNECT' && /Reconnect/.test(e.message) && !e.message.includes(TOKEN));
  assert.equal(L.sync.isConnected(), false);
  await assert.rejects(L.sync.run(), (e) => e.code === 'RECONNECT');
  L.sync._setToken(TOKEN);
  d.fail = () => { throw new Error('boom ' + TOKEN); };
  await assert.rejects(L.sync.run(), (e) => e.code === 'NETWORK' && !e.message.includes(TOKEN));
  d.fail = () => ({ status: 500, ok: false, headers: { get: () => null }, text: async () => TOKEN });
  await assert.rejects(L.sync.run(), (e) => e.code === 'HTTP' && !e.message.includes(TOKEN) && !JSON.stringify(e).includes(TOKEN));
});

test('etag precondition failure and version change are handled, nothing overwritten', async () => {
  const { d } = await setup();
  await L.sync.run();
  await L.store.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 3 })); });
  const keep = d.file.text;
  d.fail = (url, o) => (o.method === 'PATCH' ? { status: 412, ok: false, headers: { get: () => null }, text: async () => '' } : null);
  await assert.rejects(L.sync.run(), (e) => e.code === 'REMOTE_CHANGED');
  assert.equal(d.file.text, keep);
  d.fail = (url) => (/fields=id,version/.test(url) ? { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ id: 'file12345', version: '999' }) } : null);
  await assert.rejects(L.sync.run(), (e) => e.code === 'REMOTE_CHANGED');
  assert.equal(d.file.text, keep);
});

test('rev increments on commit, not on quiet commit; old envelopes unlock as rev 0', async () => {
  const ad = memAdapter();
  L.store._setAdapter(ad); L.store.lock();
  await L.store.init(PASS);
  assert.equal(L.store.getMeta().rev, 0);
  await L.store.commit(() => {});
  await L.store.commit(() => {});
  assert.equal(L.store.getMeta().rev, 2);
  await L.store.commit(() => {}, { quiet: true });
  assert.equal(L.store.getMeta().rev, 2);
  const env = await ad.get('envelope');
  assert.equal(env.rev, 2); assert.equal(typeof env.updatedAt, 'string'); assert.ok(env.deviceId);
  L.store.lock(); await L.store.unlock(PASS);
  assert.equal(L.store.getMeta().rev, 2);
  // legacy envelope: no rev anywhere
  const salt = L.vault.newSalt(), key = await L.vault.deriveKey(PASS, salt);
  await ad.set('envelope', await L.vault.makeEnvelope(key, salt, L.store.defaultState()));
  L.store.lock(); await L.store.unlock(PASS);
  assert.equal(L.store.getMeta().rev, 0);
  await L.store.commit(() => {});
  assert.equal(L.store.getMeta().rev, 1);
  // tampered local envelope
  const e2 = await ad.get('envelope'); e2.rev = 50; await ad.set('envelope', e2);
  L.store.lock(); await assert.rejects(L.store.unlock(PASS), /revision/);
});
