// v0.3.0 audit regression tests (SEC-16 onward) and schema-2 sync coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { L, memAdapter, PASS, E } from './_load.mjs';
import { buildAll } from '../build.mjs';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

const TOKEN = 'ya29.SECRETTOKENVALUE_v030_abcdefghij';
const NEWPASS = 'a brand new passphrase 2026';

function drive() {
  const d = { file: null, version: 1, etag: '"e1"', calls: [], fail: null, body: null };
  const res = (status, body, headers = {}) => ({
    status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  d.put = (text) => { d.file = { id: 'file12345', text }; d.version++; d.etag = '"e' + d.version + '"'; };
  d.fetch = async (url, o) => {
    d.calls.push({ url, method: o.method });
    if (d.fail) { const f = d.fail(url, o); if (f) return f; }
    const u = new URL(url);
    if (u.pathname === '/drive/v3/files') return res(200, { files: d.file ? [{ id: d.file.id, size: String(d.file.text.length), version: String(d.version) }] : [] });
    if (u.searchParams.get('alt') === 'media') return res(200, d.file.text, { etag: d.etag });
    if (u.pathname.startsWith('/drive/v3/files/')) return res(200, { id: d.file.id, version: String(d.version) });
    if (o.method === 'POST') { d.put(o.body.split('Content-Type: application/json\r\n\r\n')[1].split('\r\n--')[0]); return res(200, { id: 'file12345' }); }
    if (o.method === 'PATCH') { if (o.headers['If-Match'] && o.headers['If-Match'] !== d.etag) return res(412, ''); d.put(o.body); return res(200, { id: 'file12345' }); }
    return res(500, 'x');
  };
  d.writes = () => d.calls.filter((c) => c.method === 'POST' || c.method === 'PATCH').length;
  return d;
}
async function fresh(pass = PASS) {
  const ad = memAdapter();
  L.store._setAdapter(ad); L.store.lock();
  await L.store.init(pass);
  const d = drive();
  L.sync._setFetch(d.fetch); L.sync._setToken(TOKEN, 3600);
  return { ad, d };
}
// Schema 2 content: accounts, budgets, recurring (due in the past, so it would be posted if anything auto-posted).
function addMoney(x) {
  x.accounts.push({ id: 'acc-1', name: 'Checking', kind: 'cash', liability: false, archived: false },
    { id: 'acc-2', name: 'Visa', kind: 'credit', liability: true, archived: false });
  x.budgets.push({ category: 'Groceries', value: 400 });
  x.recurring.push({ id: 'rec-1', title: 'Rent', value: 1500, category: 'Housing', type: 'expense', cadence: 'monthly', nextDate: '2026-01-01', active: true });
  x.categories.expense.push('Pets');
  x.entries.push(E({ domain: 'assets', type: 'balance', value: 2500.55, accountId: 'acc-1', title: 'Checking' }),
    E({ domain: 'assets', type: 'balance', value: 300.1, accountId: 'acc-2', title: 'Visa' }),
    E({ domain: 'money', type: 'expense', value: 12.34, category: 'Groceries' }));
}
function money(s) {
  return JSON.stringify({ a: s.accounts, b: s.budgets, r: s.recurring, c: s.categories, n: s.entries.length,
    nw: L.metrics.netWorthDetail(s, '2026-12-31').totalCents });
}
async function schema1Envelope(pass, entries, salt) {
  salt = salt || L.vault.newSalt();
  const key = await L.vault.deriveKey(pass, salt);
  const s1 = { schema: 1, settings: { currency: 'USD', autoLockMin: 15, targets: { workoutsPerWeek: 4, contactDays: 30, savingsRate: 0.2 }, provider: { kind: 'none', baseUrl: '', model: '', apiKey: '' } },
    entries, memory: { insights: [], lessons: [], reviews: [] }, audit: [] };
  return { env: await L.vault.makeEnvelope(key, salt, s1), key, salt };
}

// ---- SEC-16: token dropped on lock (UI calls disconnect; covered in smoke-sync). Core contract checked here. ----
test('SEC-16 disconnect drops the token', () => {
  L.sync._setToken(TOKEN, 3600); assert.equal(L.sync.isConnected(), true);
  L.sync.disconnect(); assert.equal(L.sync.isConnected(), false); assert.equal(L.sync.expiresAt(), 0);
});

// ---- SEC-17: passphrase change edge cases ----
test('SEC-17 after a passphrase change the Drive copy is re-uploaded under the new key', async () => {
  const { d } = await fresh();
  await L.store.commit((x) => { x.entries.push(E({ domain: 'health', type: 'workout' })); });
  assert.equal((await L.sync.run()).kind, 'uploaded');
  await L.store.changePassphrase(PASS, NEWPASS);
  await assert.rejects(L.sync.run(), (e) => e.code === 'NEED_PASSPHRASE');
  const r = await L.sync.run({ passphrase: PASS });
  assert.equal(r.kind, 'uploaded', 'must not report in-sync while Drive is still under the old passphrase');
  await assert.rejects(L.vault.importBackup(PASS, d.file.text));
  assert.equal((await L.vault.importBackup(NEWPASS, d.file.text)).entries.length, 1);
  assert.equal((await L.sync.run()).kind, 'in-sync');
});

test('SEC-17 a newer Drive copy under the old passphrase is never adopted silently after a local change', async () => {
  const { ad, d } = await fresh();
  await L.sync.run();
  const old = await ad.get('envelope');
  // Another device, still on the old passphrase, writes a newer copy.
  await L.store.commit((x) => { x.entries.push(E({ domain: 'health', type: 'workout' })); });
  d.put(JSON.stringify(await L.store.exportEnvelope()));
  await ad.set('envelope', old); L.store.lock(); await L.store.unlock(PASS);
  await L.store.changePassphrase(PASS, NEWPASS);
  const w = d.writes();
  const dec = await L.sync.run({ passphrase: PASS });
  assert.equal(dec.kind, 'conflict');
  assert.equal(dec.passphraseDiffers, true);
  assert.equal(d.writes(), w);
  await assert.rejects(L.sync.apply(dec, 'remote', {}), (e) => e.code === 'NEED_BACKUP');
  L.store.lock(); await L.store.unlock(NEWPASS);
});

test('SEC-17 another device changed the passphrase: offer flags it, download switches the key', async () => {
  const { ad, d } = await fresh();
  await L.sync.run();
  const old = await ad.get('envelope');
  await L.store.changePassphrase(PASS, NEWPASS);
  await L.store.commit((x) => { x.entries.push(E({ domain: 'health', type: 'workout' })); });
  d.put(JSON.stringify(await L.store.exportEnvelope()));
  await ad.set('envelope', old); L.store.lock(); await L.store.unlock(PASS);
  const dec = await L.sync.run({ passphrase: NEWPASS });
  assert.equal(dec.kind, 'download-offer'); assert.equal(dec.passphraseDiffers, true);
  assert.equal((await L.sync.apply(dec, 'download')).kind, 'downloaded');
  L.store.lock();
  await assert.rejects(L.store.unlock(PASS));
  await L.store.unlock(NEWPASS);
  assert.equal(L.store.getState().entries.length, 1);
  assert.equal((await L.sync.run()).kind, 'in-sync');
});

// ---- SEC-18: _headers ----
test('SEC-18 _headers: CSP equals meta plus frame-ancestors, HSTS without preload/includeSubDomains, lines under 2000 chars', () => {
  const { html, headers, csp } = buildAll();
  const meta = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)[1];
  assert.equal(meta, csp);
  const line = headers.split('\n').find((l) => l.startsWith('  Content-Security-Policy: '));
  assert.equal(line, `  Content-Security-Policy: ${meta}; frame-ancestors 'none'`);
  const hsts = headers.split('\n').find((l) => /Strict-Transport-Security/.test(l));
  assert.match(hsts, /max-age=\d+$/);
  assert.ok(!/preload|includeSubDomains/i.test(headers));
  for (const l of headers.split('\n')) assert.ok(l.length < 2000, 'header line too long: ' + l.length);
  assert.match(csp, /connect-src https:\/\/api\.anthropic\.com https:\/\/www\.googleapis\.com http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\*;/);
});

// ---- SEC-19: backup restore keeps this device's sync bookkeeping ----
test('SEC-19 replaceState keeps current sync settings (rollback floor and client ID)', async () => {
  const { d } = await fresh();
  await L.store.commit((x) => { x.settings.sync.clientId = 'mine-1.apps.googleusercontent.com'; });
  await L.sync.run();
  const before = JSON.stringify(L.store.getState().settings.sync);
  const backup = L.store.defaultState();
  backup.settings.sync = { clientId: 'attacker-9.apps.googleusercontent.com', remoteRev: -1, fp: '', fileId: '' };
  backup.entries.push(E({ domain: 'health', type: 'workout' }));
  await L.store.replaceState(backup);
  assert.equal(JSON.stringify(L.store.getState().settings.sync), before);
  assert.equal(L.store.getState().entries.length, 1);
  assert.ok(d.file);
});

// ---- SEC-20: a download offer is not applied if the device changed after the check ----
test('SEC-20 download-offer refuses to replace local changes made after run()', async () => {
  const { ad, d } = await fresh();
  await L.sync.run();
  const old = await ad.get('envelope');
  await L.store.commit((x) => { x.entries.push(E({ domain: 'health', type: 'workout' })); });
  d.put(JSON.stringify(await L.store.exportEnvelope()));
  await ad.set('envelope', old); L.store.lock(); await L.store.unlock(PASS);
  const dec = await L.sync.run();
  assert.equal(dec.kind, 'download-offer');
  await L.store.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 1, title: 'late edit' })); });
  await assert.rejects(L.sync.apply(dec, 'download'), (e) => e.code === 'LOCAL_CHANGED');
  assert.ok(L.store.getState().entries.some((e) => e.title === 'late edit'));
});

// ---- SEC-21: fragment stripped even when sessionStorage is unavailable (load-time path) ----
test('SEC-21 at load, a token fragment is stripped and rejected when sessionStorage throws', async () => {
  const prev = L.sync, log = [];
  const g = globalThis, saved = { location: g.location, history: g.history };
  g.location = { hash: '#access_token=' + TOKEN + '&token_type=Bearer&state=abc', pathname: '/app/', search: '' };
  g.history = { replaceState: (a, b, u) => log.push(u) };
  Object.defineProperty(g, 'sessionStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    // sync.js is a classic script; evaluate a fresh copy so its load-time code runs against these globals.
    runInThisContext(readFileSync(new URL('../src/core/sync.js', import.meta.url), 'utf8'));
    assert.deepEqual(log, ['/app/']);
    assert.equal(L.sync.isConnected(), false);
    const r = L.sync.takeReturn();
    assert.ok(r && r.error && !r.error.includes(TOKEN));
  } finally {
    delete g.sessionStorage; g.location = saved.location; g.history = saved.history;
    if (saved.location === undefined) delete g.location;
    if (saved.history === undefined) delete g.history;
    L.sync = prev;
  }
});

// ---- SEC-22: response body capped while streaming, even without Content-Length ----
test('SEC-22 chunked Drive reply over 64 MB is aborted while reading', async () => {
  const { d } = await fresh();
  const chunk = new Uint8Array(8 * 1024 * 1024);
  let reads = 0, aborted = false;
  d.fail = (url, o) => {
    if (!/alt=media/.test(url)) return null;
    o.signal.addEventListener('abort', () => { aborted = true; });
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => { throw new Error('text() must not be used'); },
      body: { getReader: () => ({ read: async () => { reads++; return reads > 20 ? { done: true } : { done: false, value: chunk }; }, cancel: () => {} }) } };
  };
  d.put('{}');
  await assert.rejects(L.sync.run(), (e) => e.code === 'TOO_LARGE');
  assert.ok(reads <= 9 && aborted, 'reads=' + reads);
  // A normal streamed reply still works.
  d.fail = null; d.file = null;
  assert.equal((await L.sync.run()).kind, 'uploaded');
});

// ---- SEC-23: foreign errors never pass their message through ----
test('SEC-23 a foreign error with a string code is replaced by a fixed message', async () => {
  await fresh();
  L.sync._setFetch(async () => { throw Object.assign(new Error('socket hang up ' + TOKEN), { code: 'ECONNRESET' }); });
  await assert.rejects(L.sync.run(), (e) => e.code === 'NETWORK' && !e.message.includes(TOKEN));
});

// ---- SEC-24 (hardening): adoptEnvelope stores only the known envelope fields ----
test('SEC-24 adoptEnvelope stores only the known envelope fields', async () => {
  const { ad } = await fresh();
  const env = await L.store.exportEnvelope();
  const remote = Object.assign({}, env, { junk: 'x'.repeat(1000), kdf: Object.assign({}, env.kdf, { extra: 1 }) });
  const info = await L.store.inspectEnvelope(JSON.parse(JSON.stringify(remote)));
  await L.store.adoptEnvelope(info);
  const stored = await ad.get('envelope');
  assert.deepEqual(Object.keys(stored).sort(), ['ct', 'deviceId', 'iv', 'kdf', 'rev', 'updatedAt', 'v']);
  assert.deepEqual(Object.keys(stored.kdf).sort(), ['hash', 'iter', 'name', 'salt']);
  L.store.lock(); await L.store.unlock(PASS);
});

// ---- schema 2 sync coverage ----
test('schema 2: accounts, budgets, recurring and categories survive upload and download intact', async () => {
  const { ad, d } = await fresh();
  await L.sync.run();
  const old = await ad.get('envelope');
  await L.store.commit(addMoney);
  const want = money(L.store.getState());
  assert.equal((await L.sync.run()).kind, 'uploaded');
  const up = await L.vault.importBackup(PASS, d.file.text);
  assert.equal(up.schema, 5); assert.equal(money(up), want);
  // This device goes back to the older copy, then downloads.
  await ad.set('envelope', old); L.store.lock(); await L.store.unlock(PASS);
  const dec = await L.sync.run();
  assert.equal(dec.kind, 'download-offer');
  await L.sync.apply(dec, 'download');
  assert.equal(money(L.store.getState()), want);
  // The recurring item is overdue but was only proposed, never posted.
  assert.equal(L.metrics.dueRecurring(L.store.getState(), '2026-11-13').length, 1);
  assert.equal(L.store.getState().entries.length, 3);
  L.store.lock(); await L.store.unlock(PASS);
  assert.equal(money(L.store.getState()), want);
  assert.equal((await L.sync.run()).kind, 'in-sync');
});

test('schema 1 device (empty) downloads a schema 2 remote', async () => {
  const { ad, d } = await fresh();
  await L.store.commit(addMoney);
  const want = money(L.store.getState());
  await L.sync.run();
  const remote = d.file.text;
  // New device: a schema 1 vault with the same passphrase (own salt), never synced.
  const s1 = await schema1Envelope(PASS, []);
  await ad.set('envelope', s1.env); L.store.lock(); await L.store.unlock(PASS);
  assert.equal(L.store.getState().schema, 5);
  await assert.rejects(L.sync.run(), (e) => e.code === 'NEED_PASSPHRASE');
  const dec = await L.sync.run({ passphrase: PASS });
  assert.equal(dec.kind, 'download-offer'); assert.equal(dec.passphraseDiffers, true);
  await L.sync.apply(dec, 'download');
  assert.equal(money(L.store.getState()), want);
  assert.equal(d.file.text, remote, 'remote untouched by a download');
  L.store.lock(); await L.store.unlock(PASS);
  assert.equal(money(L.store.getState()), want);
  assert.equal((await L.sync.run()).kind, 'in-sync');
});

test('schema 1 device with data vs schema 2 remote: conflict, losing schema 1 copy saved and restorable', async () => {
  const { ad, d } = await fresh();
  await L.store.commit(addMoney);
  const want = money(L.store.getState());
  await L.sync.run();
  const bal = E({ domain: 'assets', type: 'balance', value: -50, title: 'Old card' });
  const s1 = await schema1Envelope(PASS, [bal]);
  await ad.set('envelope', s1.env); L.store.lock(); await L.store.unlock(PASS);
  const mig = L.store.getState();
  assert.equal(mig.accounts.length, 1); assert.equal(mig.accounts[0].liability, true);
  assert.equal(mig.entries[0].accountId, mig.accounts[0].id);
  const w = d.writes();
  const dec = await L.sync.run({ passphrase: PASS });
  assert.equal(dec.kind, 'conflict'); assert.equal(d.writes(), w);
  const saved = [];
  await L.sync.apply(dec, 'remote', { saveBackup: async (t) => { saved.push(t); assert.equal(L.store.getState().entries[0].title, 'Old card'); } });
  assert.equal(saved.length, 1);
  assert.equal(money(L.store.getState()), want);
  const restored = await L.vault.importBackup(PASS, saved[0]);
  assert.equal(restored.entries.length, 1); assert.equal(restored.entries[0].title, 'Old card');
  assert.equal(restored.accounts.length, 1);
  assert.equal(L.metrics.netWorthDetail(restored, '2026-12-31').totalCents, -5000);
});
