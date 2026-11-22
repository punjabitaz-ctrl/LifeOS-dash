// Crypto/storage/sync review proof tests (docs/review/crypto.md). Each test asserts the correct behaviour; a failure demonstrates the finding.
import test, { beforeEach, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { L, memAdapter, PASS, E, resealLike } from './_load.mjs';

const live = (k) => new Proxy({}, { get: (_, p) => L[k][p], set: (_, p, v) => { L[k][p] = v; return true; } });
const S = live('store'), P = live('priv'), V = live('vault'), M = live('metrics');
const PRIV = 'a private passphrase 99', PRIV2 = 'another private pass 77';
const TOKEN = 'ya29.REVIEWTOKEN_abcdefghijklmnop';
const clone = (x) => JSON.parse(JSON.stringify(x));

let ORIG = null;
const fastDerive = async (pass, salt) => {
  const base = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};
// Harness only (v1.0.0): the tests and their hooks sit in one describe block, so the fast key derivation and the vault close in the
// hooks apply to these tests alone and not to every other test file that test/index.js loads into the same process.
// Harness only: yield once so test/index.js registers these after the other files' first top-level tests (store.test.mjs checks
// that no storage adapter exists before any test installs one).
await new Promise((r) => setTimeout(r, 0));
describe('crypto review proofs (CR)', () => {
beforeEach(() => { ORIG = L.vault.deriveKey; L.vault.deriveKey = fastDerive; });
afterEach(() => { L.vault.deriveKey = ORIG; try { L.priv.close('system'); } catch (e) { /* ignore */ } });

function drive() {
  const d = { file: null, version: 1, etag: '"e1"', onWrite: null };
  const res = (status, body, headers = {}) => ({ status, ok: status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  d.put = (text) => { d.file = { id: 'file12345', text }; d.version++; d.etag = '"e' + d.version + '"'; };
  d.fetch = async (url, o) => {
    const u = new URL(url);
    if (u.pathname === '/drive/v3/files') return res(200, { files: d.file ? [{ id: d.file.id, size: String(d.file.text.length), version: String(d.version) }] : [] });
    if (u.searchParams.get('alt') === 'media') return res(200, d.file.text, { etag: d.etag });
    if (u.pathname.startsWith('/drive/v3/files/')) return res(200, { id: d.file.id, version: String(d.version) });
    // Simulates the user saving an edit while the (possibly large, slow) upload is on the wire.
    if (d.onWrite) await d.onWrite();
    if (o.method === 'POST') { d.put(o.body.split('Content-Type: application/json\r\n\r\n')[1].split('\r\n--')[0]); return res(200, { id: 'file12345' }); }
    if (o.method === 'PATCH') { d.put(o.body); return res(200, { id: 'file12345' }); }
    return res(500, 'x');
  };
  return d;
}
async function fresh() {
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  const d = drive(); L.sync._setFetch(d.fetch); L.sync._setToken(TOKEN, 3600);
  return { ad, d };
}
// Another device (same passphrase) writes a newer Drive copy.
async function otherDeviceWrites(d, mutate) {
  const env = JSON.parse(d.file.text);
  const salt = V.parseEnvelope(env).salt, key = await V.deriveKey(PASS, salt);
  const raw = await V.decrypt(key, env);
  mutate(raw);
  const m = { rev: env.rev + 1, updatedAt: '2026-11-14T00:00:00.000Z', deviceId: 'other-device' };
  raw._meta = m;
  d.put(JSON.stringify(await resealLike(env, raw, m)));
}
const entryDuringUpload = () => S.commit((s) => { s.entries.push(E({ id: 'typed-during-upload', domain: 'money', type: 'expense', value: 2 })); });

test('CR-1a: an edit saved while an upload is in flight is still treated as unsynced', async () => {
  const { d } = await fresh();
  await L.sync.run();
  await S.commit((s) => { s.entries.push(E({ domain: 'money', type: 'expense', value: 1 })); });
  d.onWrite = entryDuringUpload;
  assert.equal((await L.sync.run()).kind, 'uploaded');
  d.onWrite = null;
  const remote = await S.inspectEnvelope(JSON.parse(d.file.text));
  assert.ok(!remote.state.entries.some((e) => e.id === 'typed-during-upload'), 'precondition: the Drive copy lacks the edit');
  // Correct: the next sync must see a local change and upload it. Actual: 'in-sync', the edit never reaches Drive.
  assert.notEqual((await L.sync.run()).kind, 'in-sync');
});

test('CR-1b: that edit is then dropped by a plain download offer (no conflict, no backup)', async () => {
  const { d } = await fresh();
  await L.sync.run();
  await S.commit((s) => { s.entries.push(E({ domain: 'money', type: 'expense', value: 1 })); });
  d.onWrite = entryDuringUpload;
  await L.sync.run();
  d.onWrite = null;
  await otherDeviceWrites(d, (raw) => { raw.entries.push(E({ id: 'from-other-device', domain: 'money', type: 'expense', value: 3 })); });
  const dec = await L.sync.run();
  // Correct: both copies changed, so this is a conflict (losing copy saved first). Actual: 'download-offer' ("no changes on this device").
  assert.equal(dec.kind, 'conflict');
});

test('CR-2a: public daily checks added while the private vault is closed make it impossible to open', async () => {
  await fresh();
  await P.setUp(PRIV);
  await P.write((s) => { M.addHabit(s, 'Private one'); M.addHabit(s, 'Private two'); }, { newPrivate: true });
  P.close();
  // Closed: the main state shows 0 checks, so the UI path (metrics.addHabit) allows 8 more.
  await S.commit((s) => { for (let i = 0; i < 8; i++) M.addHabit(s, 'Public ' + i); });
  await assert.doesNotReject(P.open(PRIV));
});

test('CR-2b: nesting a public parent while the vault is closed makes it impossible to open (v0.12 lines of work)', async () => {
  await fresh();
  await S.commit((s) => { s.projects.push({ id: 'pub-p', name: 'Agency', kind: 'venture', status: 'active', nextAction: '' }); });
  await P.setUp(PRIV);
  await P.write((s) => { s.projects.push({ id: 'priv-q', name: 'Secret client', kind: 'client', status: 'active', nextAction: '', parentId: 'pub-p' }); }, { newPrivate: true });
  P.close();
  await S.commit((s) => {
    s.projects.push({ id: 'pub-r', name: 'Holding', kind: 'venture', status: 'active', nextAction: '' });
    s.projects.find((p) => p.id === 'pub-p').parentId = 'pub-r';
  });
  await assert.doesNotReject(P.open(PRIV));
});

test('CR-3: a private passphrase change racing a restore or sync adopt writes back the older private data', async () => {
  await fresh();
  await P.setUp(PRIV);
  await P.write((s) => { s.entries.push(E({ id: 'x1', domain: 'money', type: 'expense', value: 1 })); }, { newPrivate: true });
  const older = clone(S.getState());
  await P.write((s) => { s.entries.push(E({ id: 'z1', domain: 'money', type: 'expense', value: 9 })); }, { newPrivate: true });
  const newer = clone(S.getState());
  await S.replaceState(older);
  const pc = P.changePassphrase(PRIV, PRIV2);
  await S.replaceState(newer); // stands in for adoptEnvelope or a restore landing while the change derives keys
  await pc;
  await P.open(PRIV2);
  const v = P.view(S.getState());
  assert.ok(v.entries.some((e) => e.id === 'z1'), 'private record z1 from the newer copy was overwritten');
});

test('CR-4: validateState keeps a numeric audit ts that the Settings screen cannot render', () => {
  const s = S.defaultState();
  s.audit = [{ ts: 5, action: 'x' }];
  const out = S.validateState(clone(s));
  // app.js renders a.ts.replace(...): a number throws and the whole Settings screen is replaced by an error.
  assert.equal(typeof out.audit[0].ts, 'string');
});
});
