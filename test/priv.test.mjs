// v0.11.0 part A: the private vault. Crypto, drops, routing, moves, hiding, main-only outputs, backup and sync, crafted blobs, migration.
import test, { mock, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { L, memAdapter, PASS, E } from './_load.mjs';
import { drive, putRemote, TOKEN, clone } from './_v070.mjs';
import { buildAdversarial, ADV_MARK } from './_adversarial.mjs';

// Live views: the whole suite shares one process, and other files swap L.* for the built bundle, so resolve on every use.
const live = (k) => new Proxy({}, { get: (_, p) => L[k][p], set: (_, p, v) => { L[k][p] = v; return true; } });
const S = live('store'), P = live('priv'), V = live('vault');
const PRIV = 'a private passphrase 99';
const TODAY = '2026-11-14', WK = '2026-11-09';
let ORIG = null;
const realDerive = (...a) => ORIG(...a);
// Real PBKDF2 (600000) is exercised in the crypto test; everywhere else a fast derivation keeps the file quick.
const fastDerive = async (pass, salt) => {
  const base = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};
// A state with a record in every collection, text markers, and every link kind.
function full() {
  const { state } = buildAdversarial(L);
  const s = clone(state);
  s.settings.provider = { kind: 'none', baseUrl: '', model: '', apiKey: '' };
  s.budgets.push({ category: 'Groceries', value: 300 });
  s.cycle = { startDate: '2026-10-01', sprintDays: 42, sprintsPerCycle: 2, restDays: 7, alternateHeavyLight: true, firstWeek: 'heavy' };
  s.habitLog.push({ habitId: 'h1', date: '2026-11-10' }, { habitId: 'h1', date: '2026-11-11' });
  s.entries.push(E({ id: 'ex1', domain: 'money', type: 'expense', date: '2026-11-12', title: 'Paid ticket ' + ADV_MARK + 'ex1', value: 25, category: 'Other' }));
  const a1 = s.activities.find((a) => a.id === 'a1'); a1.expenseId = 'ex1'; a1.paidOn = '2026-11-12';
  s.goals.push({ id: 'g3', title: 'Child goal ' + ADV_MARK + 'g3', horizon: 'weekly', domain: 'work', metric: 'manual', direction: 'up', startValue: 0, targetValue: 5, startDate: '2026-11-09', dueDate: '2026-11-15', parentId: 'g2', state: 'active', notes: '', createdAt: '2026-11-01T00:00:00.000Z' });
  s.learningItems[0].goalId = 'g2';
  s.activities.find((a) => a.id === 'a2').goalId = 'g2';
  return S.validateState(clone(s));
}
const keyOf = (c, r) => (c === 'cycle' ? 'cycle' : c === 'budgets' ? r.category : c === 'habitLog' ? r.habitId + '|' + r.date : r.id);
const rec = (st, c) => (c === 'cycle' ? (st.cycle ? [st.cycle] : []) : st[c]);
const sorted = (st) => {
  const o = clone(st);
  for (const c of P.COLLECTIONS) if (c !== 'cycle') o[c] = o[c].slice().sort((a, b) => keyOf(c, a).localeCompare(keyOf(c, b)));
  for (const p of o.people) { p.pipelineIds.sort(); p.projectIds.sort(); }
  return o;
};
const strip = (st) => { const o = sorted(st); delete o.audit; delete o.priv; delete o.memory; return o; };
async function vault(state, opts = {}) {
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  if (state) await S.replaceState(state);
  if (opts.setUp !== false) await P.setUp(PRIV);
  return ad;
}
const text = (x) => JSON.stringify(x);
// categories, workout types and activity categories are lists, not records: they stay in the main state by design
const nomark = (st) => text(Object.assign({}, st, { categories: 0, kinds: 0, activityCategories: 0 }));
const ids = (st) => P.COLLECTIONS.map((c) => [c, rec(st, c).map((r) => keyOf(c, r))]);
const pick = { entries: 'ex1', accounts: 'acc1', recurring: 'r1', budgets: 'Groceries', projects: 'p1', pipeline: 'pl1', goals: 'g1', maintenance: 'mt1', vehicles: 'v1', properties: 'pp1', renewals: 'rn1', documents: 'dc1', taxItems: 'tx1', learningItems: 'li1', studySessions: 'ss1', takeaways: 'tk1', activities: 'a2', people: 'sp1', groups: 'sg1', contacts: 'sc1', habits: 'h1', habitLog: 'h1|2026-11-10', cycle: 'cycle' };

describe('v0.11.0 part A: private vault', () => {
beforeEach(() => { ORIG = L.vault.deriveKey; L.vault.deriveKey = fastDerive; });
afterEach(() => { L.vault.deriveKey = ORIG; try { L.priv.close('system'); } catch (e) { /* ignore */ } });

// ---------------------------------------------------------------- crypto
test('inner crypto: own salt, fresh IV per write, PBKDF2 600000, AES-GCM 256, non-extractable key, rev bound inside and outside', async () => {
  V.deriveKey = async (pass, salt) => { const k = await realDerive(pass, salt); seen.push({ k, salt }); return k; };
  const seen = [];
  const sub = globalThis.crypto.subtle, orig = sub.deriveKey.bind(sub), params = [];
  sub.deriveKey = (a, ...r) => { params.push(a); return orig(a, ...r); };
  try {
    await vault(null);
    const st = S.getState();
    assert.equal(st.priv.v, 1); assert.deepEqual(Object.keys(st.priv).sort(), ['ct', 'iv', 'kdf', 'marks', 'rev', 'v']);
    assert.deepEqual([st.priv.kdf.name, st.priv.kdf.hash, st.priv.kdf.iter], ['PBKDF2', 'SHA-256', 600000]);
    assert.ok(params.length >= 2 && params.every((p) => p.iterations === 600000 && p.hash === 'SHA-256'));
    assert.ok(seen.every((x) => x.k.extractable === false && x.k.algorithm.name === 'AES-GCM' && x.k.algorithm.length === 256));
    assert.equal(Buffer.from(st.priv.kdf.salt, 'base64').length, 16); assert.equal(Buffer.from(st.priv.iv, 'base64').length, 12);
    const env = await S.exportEnvelope();
    assert.notEqual(env.kdf.salt, st.priv.kdf.salt, 'own salt');
    const iv0 = st.priv.iv, rev0 = st.priv.rev;
    await P.write((x) => { x.audit.push({ ts: new Date().toISOString(), action: 'x' }); }, {});
    assert.notEqual(S.getState().priv.iv, iv0, 'fresh IV on every write'); assert.equal(S.getState().priv.rev, rev0 + 1);
    // rev bound inside: decrypt the blob directly
    const key = await realDerive(PRIV, new Uint8Array(Buffer.from(st.priv.kdf.salt, 'base64')));
    const inner = await V.decrypt(key, S.getState().priv);
    assert.equal(inner.rev, S.getState().priv.rev); assert.equal(inner.schema, 1); assert.deepEqual(inner.wellbeing, {});
    // and outside: a swapped rev is refused on open
    P.close('system');
    const bad = clone(S.getState()); bad.priv.rev += 1;
    await S.replaceState(bad);
    await assert.rejects(P.open(PRIV), /revision/);
    assert.ok(!P.isOpen());
  } finally { sub.deriveKey = orig; V.deriveKey = fastDerive; }
});

test('private passphrase: at least 12 characters, different from the main one (compared by deriving, nothing stored)', async () => {
  await vault(null, { setUp: false });
  await assert.rejects(P.setUp('short one'), /12 characters/);
  await assert.rejects(P.setUp(PASS), /different from your main/);
  assert.ok(!S.getState().priv);
  await P.setUp(PRIV);
  assert.ok(P.isOpen() && P.isSetUp(S.getState()));
  await assert.rejects(P.setUp('another passphrase 1'), /already set up/);
  assert.ok(!JSON.stringify(S.getState()).includes(PRIV) && !JSON.stringify(S.getState()).includes(PASS));
  // the main passphrase can never become the private one, either way round
  await assert.rejects(S.changePassphrase(PASS, PRIV), /different from the private/);
  P.close('system');
  await assert.rejects(P.open('wrong passphrase 123'), /BAD_PRIVATE_PASSPHRASE/);
  await assert.rejects(P.changePassphrase(PRIV, PASS), /different from your main/);
  await assert.rejects(P.changePassphrase('wrong passphrase 123', 'a new private pass 1'), /BAD_PRIVATE_PASSPHRASE/);
  await P.open(PRIV);
  assert.ok(P.isOpen());
});

test('privAutoLockSec: default 60, 15 to 1800 only', () => {
  assert.equal(S.defaultState().settings.privAutoLockSec, 60);
  const ok = (n) => { const s = S.defaultState(); s.settings.privAutoLockSec = n; return S.validateState(clone(s)).settings.privAutoLockSec; };
  assert.equal(ok(15), 15); assert.equal(ok(1800), 1800);
  for (const n of [14, 1801, 30.5, '60', null]) assert.throws(() => ok(n), /privAutoLockSec/);
  const s = clone(S.defaultState()); delete s.settings.privAutoLockSec;
  assert.equal(S.validateState(s).settings.privAutoLockSec, 60);
});

// ---------------------------------------------------------------- drops
async function openWith(state) { await vault(state); assert.ok(P.isOpen()); }
const moved = async () => { await P.moveIn('accounts', 'acc1', { children: true }); await P.moveIn('people', 'sp1', { children: true }); };

test('the key and plaintext are dropped by the private timer (default 60 s, setting 15 to 1800)', async () => {
  await openWith(full());
  await moved();
  const view = P.view(S.getState()), held = view.accounts.find((a) => a.id === 'acc1');
  assert.ok(held.name.includes(ADV_MARK));
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  try {
    P.touch(); mock.timers.tick(59000); assert.ok(P.isOpen(), 'still open at 59 s');
    P.touch(); mock.timers.tick(30000); assert.ok(P.isOpen(), 'activity restarts the timer');
    mock.timers.tick(31000); assert.ok(!P.isOpen(), 'closed after 60 s idle');
    await S.commit((x) => { x.settings.privAutoLockSec = 15; });
    mock.timers.reset(); mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  } finally { mock.timers.reset(); }
  assert.deepEqual(Object.keys(held), [], 'the record objects held by a view are emptied');
  assert.equal(P.view(S.getState()), S.getState(), 'closed view is the base state itself');
  assert.throws(() => P.getWellbeing(), /closed/);
  await P.open(PRIV);
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  try { P.touch(); mock.timers.tick(14999); assert.ok(P.isOpen()); mock.timers.tick(2); assert.ok(!P.isOpen(), '15 s setting'); } finally { mock.timers.reset(); }
  // a stalled timer is caught by the wall clock check
  await P.open(PRIV); P.touch();
  const real = Date.now; Date.now = () => real() + 16000;
  try { assert.equal(P.checkExpiry(), true); } finally { Date.now = real; }
  assert.ok(!P.isOpen());
});

test('dropped on visibility hidden, app lock, wipe, either passphrase change, replaceState and before any AI call', async () => {
  const doc = Object.assign(new EventTarget(), { hidden: false });
  globalThis.document = doc;
  try {
    await openWith(full());
    doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange')); assert.ok(!P.isOpen(), 'hidden');
    doc.hidden = false;
    await P.open(PRIV); S.lock(); assert.ok(!P.isOpen(), 'app lock (and auto-lock, which calls the same lock)');
    await S.unlock(PASS); await P.open(PRIV);
    await S.changePassphrase(PASS, 'a new main passphrase 1'); assert.ok(!P.isOpen(), 'main passphrase change');
    await P.open(PRIV);
    await P.changePassphrase(PRIV, 'a new private pass 1'); assert.ok(!P.isOpen(), 'private passphrase change');
    await assert.rejects(P.open(PRIV), /BAD_PRIVATE/);
    await P.open('a new private pass 1');
    await assert.rejects(L.ai.complete({ kind: 'manual', baseUrl: '', model: '', apiKey: '' }, { system: 's', user: 'u' }), /MANUAL/);
    assert.ok(!P.isOpen(), 'before any AI call');
    await P.open('a new private pass 1');
    await S.replaceState(clone(S.getState())); assert.ok(!P.isOpen(), 'replaceState (restore, sync adoption)');
    await P.open('a new private pass 1');
    await S.wipe(); assert.ok(!P.isOpen(), 'wipe'); assert.ok(!S.isUnlocked());
  } finally { delete globalThis.document; }
});

// ---------------------------------------------------------------- moves
test('every collection: move in hides it and its text, move out restores it, references intact after a round trip', async () => {
  const orig = full();
  await openWith(orig);
  for (const c of P.COLLECTIONS) {
    const id = pick[c], before = S.getState();
    assert.ok(rec(before, c).some((r) => keyOf(c, r) === id), c + ' fixture');
    await P.moveIn(c, id);
    const main = S.getState();
    assert.ok(!rec(main, c).some((r) => keyOf(c, r) === id), c + ' left the main state');
    assert.ok(S.getState().priv.marks.includes(c), c + ' marked');
    const inView = rec(P.view(main), c).some((r) => keyOf(c, r) === id);
    assert.ok(inView, c + ' present in the view');
    S.validateState(clone(main)); // the main state alone stays valid: nothing dangles
    await P.moveOut(c, id);
    assert.ok(!S.getState().priv.marks.includes(c), c + ' mark cleared');
  }
  assert.deepEqual(strip(S.getState()), strip(orig), 'after moving every collection in and out, the state is the same');
  assert.deepEqual(S.getState().priv.marks, []);
});

test('all in at once: closed state is valid and holds no private text or reference; open view equals the original', async () => {
  const orig = full();
  await openWith(orig);
  for (const c of P.COLLECTIONS) for (const r of rec(S.getState(), c).slice()) if (P.isOpen() && rec(S.getState(), c).some((x) => keyOf(c, x) === keyOf(c, r))) await P.moveIn(c, keyOf(c, r), { children: false });
  const main = S.getState();
  for (const c of P.COLLECTIONS) assert.equal(rec(main, c).length, 0, c + ' is empty in main');
  assert.ok(!nomark(main).includes(ADV_MARK), 'no marker in the main state');
  assert.ok(P.COLLECTIONS.every((c) => main.priv.marks.includes(c)));
  const noBlob = text(Object.assign({}, main, { priv: 0 }));
  assert.ok(!/"sp1"|"acc1"|"sc1"/.test(noBlob), 'no id of a private record either');
  S.validateState(clone(main));
  assert.deepEqual(strip(P.view(main)), strip(orig), 'the open view is the original');
  const ct = await S.exportEnvelope();
  // the main plaintext (decrypted with the main key only) has no private text
  const key = await fastDerive(PASS, V.parseEnvelope(ct).salt);
  assert.ok(!nomark(await V.decrypt(key, ct)).includes(ADV_MARK));
});

test('moves and references: overlays re-apply when open, nothing dangles or leaks when closed', async () => {
  const orig = full();
  await openWith(orig);
  await P.moveIn('pipeline', 'pl1'); await P.moveIn('projects', 'p1'); await P.moveIn('groups', 'sg1'); await P.moveIn('goals', 'g2');
  const main = S.getState();
  const person = main.people.find((p) => p.id === 'sp1');
  assert.deepEqual([person.pipelineIds, person.projectIds, person.groupId], [[], [], undefined], 'public person lost the references to private records');
  assert.equal(main.entries.find((e) => e.id === 'e-none'), undefined);
  assert.ok(!main.entries.some((e) => e.projectId === 'p1'));
  assert.equal(main.goals.find((g) => g.id === 'g3').parentId, undefined);
  assert.equal(main.learningItems[0].goalId, undefined);
  S.validateState(clone(main));
  const v = P.view(main), vp = v.people.find((p) => p.id === 'sp1');
  assert.deepEqual([vp.pipelineIds, vp.projectIds, vp.groupId], [['pl1'], ['p1'], 'sg1'], 'overlays applied in the view');
  assert.equal(v.goals.find((g) => g.id === 'g3').parentId, 'g2');
  assert.deepEqual(main.people.find((p) => p.id === 'sp1').pipelineIds, [], 'the view did not touch the main state');
  // a public record edited while open keeps its private references private
  await P.write((x) => { x.people.find((p) => p.id === 'sp1').notes = 'edited note'; });
  assert.deepEqual(S.getState().people.find((p) => p.id === 'sp1').pipelineIds, []);
  assert.equal(P.view(S.getState()).people.find((p) => p.id === 'sp1').groupId, 'sg1');
  // deleting the private target drops the reference everywhere, nothing dangles
  await P.write((x) => { x.pipeline = x.pipeline.filter((p) => p.id !== 'pl1'); });
  assert.deepEqual(P.view(S.getState()).people.find((p) => p.id === 'sp1').pipelineIds, []);
  await P.write((x) => { x.people = x.people.filter((p) => p.id !== 'sp1'); });
  const inner = await openInner();
  assert.ok(!inner.links.some((l) => l.fromId === 'sp1'), 'links of a deleted public record are gone');
  // move out restores real references
  await P.moveOut('projects', 'p1');
  assert.ok(S.getState().projects.some((p) => p.id === 'p1'));
});
async function openInner() {
  const st = S.getState(); return V.decrypt(await fastDerive(PRIV, new Uint8Array(Buffer.from(st.priv.kdf.salt, 'base64'))), st.priv);
}

test('activity and expense move together, in either direction; a habit takes its ticks; parents offer their children', async () => {
  await openWith(full());
  await P.moveIn('activities', 'a1');
  assert.ok(!S.getState().entries.some((e) => e.id === 'ex1') && !S.getState().activities.some((a) => a.id === 'a1'), 'activity moved with its expense');
  await P.moveOut('entries', 'ex1');
  assert.ok(S.getState().entries.some((e) => e.id === 'ex1') && S.getState().activities.some((a) => a.id === 'a1' && a.expenseId === 'ex1'), 'expense moved out with its activity');
  await P.moveIn('entries', 'ex1');
  assert.ok(!S.getState().activities.some((a) => a.id === 'a1'));
  assert.equal(P.view(S.getState()).activities.find((a) => a.id === 'a1').expenseId, 'ex1');
  await P.moveOut('activities', 'a1');
  // a new expense made for a public activity in private mode drags its activity along (never one without the other)
  await P.moveIn('habits', 'h1');
  assert.equal(S.getState().habitLog.length, 0, 'ticks went with the habit');
  assert.equal(P.view(S.getState()).habitLog.length, 2);
  await P.moveOut('habits', 'h1');
  assert.equal(S.getState().habitLog.length, 2);
  // children
  assert.deepEqual(P.childrenOf(P.view(S.getState()), 'people', 'sp1'), [{ collection: 'contacts', id: 'sc1' }]);
  await P.moveIn('people', 'sp1');
  assert.ok(S.getState().contacts.some((c) => c.id === 'sc1' && c.personId === undefined), 'child left public keeps working, unlinked while closed');
  assert.equal(P.view(S.getState()).contacts.find((c) => c.id === 'sc1').personId, 'sp1', 'relinked in the view');
  await P.moveOut('people', 'sp1');
  await P.moveIn('people', 'sp1', { children: true });
  assert.equal(S.getState().contacts.length, 0);
  await P.moveOut('people', 'sp1', { children: true });
  assert.equal(S.getState().contacts.length, 1); assert.equal(S.getState().contacts[0].personId, 'sp1');
  for (const [c, id, kid] of [['learningItems', 'li1', 'studySessions'], ['projects', 'p1', 'entries'], ['accounts', 'acc1', 'entries'], ['properties', 'pp1', 'maintenance'], ['groups', 'sg1', 'people']]) {
    const n = rec(S.getState(), kid).length;
    assert.ok(P.childrenOf(P.view(S.getState()), c, id).length > 0, c + ' has children');
    await P.moveIn(c, id, { children: true });
    assert.ok(rec(S.getState(), kid).length < n, c + ' children moved');
    await P.moveOut(c, id, { children: true });
    assert.equal(rec(S.getState(), kid).length, n);
  }
});

test('single write path: edits stay where the record lives; new records are public unless private mode is on', async () => {
  await openWith(full());
  await P.moveIn('people', 'sp1');
  await P.write((x) => { x.people.find((p) => p.id === 'sp1').name = 'Renamed ' + ADV_MARK + 'priv'; x.projects.find((p) => p.id === 'p1').name = 'Public rename'; });
  assert.ok(!text(S.getState()).includes('Renamed'), 'a private record is never written into the main state');
  assert.equal(S.getState().projects.find((p) => p.id === 'p1').name, 'Public rename');
  assert.ok(P.view(S.getState()).people.some((p) => p.name.startsWith('Renamed')));
  await P.write((x) => { x.accounts.push({ id: 'newpub', name: 'New public', kind: 'cash', liability: false, archived: false }); });
  assert.ok(S.getState().accounts.some((a) => a.id === 'newpub'));
  await P.write((x) => { x.accounts.push({ id: 'newpriv', name: 'New secret ' + ADV_MARK, kind: 'cash', liability: false, archived: false }); }, { newPrivate: true });
  assert.ok(!S.getState().accounts.some((a) => a.id === 'newpriv') && !text(S.getState()).includes('New secret'));
  assert.ok(P.view(S.getState()).accounts.some((a) => a.id === 'newpriv'));
  assert.ok(S.getState().priv.marks.includes('accounts'));
  // a failing write changes nothing, in either layer
  const snap = text(S.getState());
  await assert.rejects(P.write((x) => { x.accounts.push({ id: 'bad', name: '', kind: 'cash', liability: false, archived: false }); }, { newPrivate: true }));
  assert.equal(text(S.getState()), snap);
  assert.ok(P.view(S.getState()).accounts.some((a) => a.id === 'newpriv'));
  // closed: write is a plain commit, and private modes are refused
  P.close('system');
  await assert.rejects(P.write(() => {}, { newPrivate: true }), /closed/);
  await assert.rejects(P.moveIn('people', 'sp1'), /Open the private vault/);
  await P.write((x) => { x.projects.find((p) => p.id === 'p1').name = 'Closed edit'; });
  assert.equal(S.getState().projects.find((p) => p.id === 'p1').name, 'Closed edit');
});

test('SEC-27/28 style size guard (SEC-49): a private vault that would be too large is refused and nothing changes', async () => {
  await openWith(full());
  const enc = V.encrypt;
  V.encrypt = async () => ({ iv: 'AAAAAAAAAAAAAAAA', ct: 'A'.repeat(40e6 + 4) });
  const before = text(S.getState());
  try { await assert.rejects(P.moveIn('accounts', 'acc1'), /too large/); } finally { V.encrypt = enc; }
  assert.equal(text(S.getState()), before);
  assert.ok(S.getState().accounts.some((a) => a.id === 'acc1'));
  await P.moveIn('accounts', 'acc1');
});

// ---------------------------------------------------------------- totals while closed and open
function world() {
  const s = S.defaultState();
  const mk = (o) => E(o);
  s.accounts.push({ id: 'aPub', name: 'Checking', kind: 'cash', liability: false, archived: false }, { id: 'aPriv', name: 'Secret savings', kind: 'investment', liability: false, archived: false });
  s.entries.push(
    mk({ id: 'b1', domain: 'assets', type: 'balance', date: '2026-11-10', title: 'Checking', value: 1000, accountId: 'aPub' }),
    mk({ id: 'b2', domain: 'assets', type: 'balance', date: '2026-11-10', title: 'Secret savings', value: 5000, accountId: 'aPriv' }),
    mk({ id: 'x1', domain: 'money', type: 'expense', date: '2026-11-10', title: 'Lunch', value: 100, category: 'Other' }),
    mk({ id: 'x2', domain: 'money', type: 'expense', date: '2026-11-11', title: 'Secret spend', value: 250, category: 'Other' }),
    mk({ id: 'w1', domain: 'health', type: 'workout', date: '2026-11-10', title: 'Run', minutes: 30, kind: 'cardio' }),
    mk({ id: 'w2', domain: 'health', type: 'workout', date: '2026-11-11', title: 'Lift', minutes: 40, kind: 'strength' }),
    mk({ id: 'w3', domain: 'health', type: 'workout', date: '2026-11-12', title: 'Secret session', minutes: 50, kind: 'strength' }));
  s.people.push(
    { id: 'pPub', name: 'Pat Public', cadenceDays: 7, importantDates: [], pipelineIds: [], projectIds: [], facts: [], notes: '', archived: false, createdAt: '2026-08-01T00:00:00.000Z' },
    { id: 'pPriv', name: 'Sam Secret', cadenceDays: 7, importantDates: [], pipelineIds: [], projectIds: [], facts: [], notes: '', archived: false, createdAt: '2026-08-01T00:00:00.000Z' });
  s.contacts.push({ id: 'c1', personId: 'pPub', date: '2026-09-01', channel: 'call', notes: '' }, { id: 'c2', personId: 'pPriv', date: '2026-09-01', channel: 'call', notes: '' });
  s.goals.push({ id: 'gNet', title: 'Net worth goal', horizon: 'annual', domain: 'assets', metric: 'netWorth', direction: 'up', startValue: 0, targetValue: 10000, startDate: '2026-01-01', dueDate: '2026-12-31', state: 'active', notes: '', createdAt: '2026-01-01T00:00:00.000Z' });
  s.settings.targets.workoutsPerWeek = 3;
  return S.validateState(clone(s));
}
const nums = (st) => ({
  netWorth: L.metrics.netWorthDetail(st, TODAY).totalCents,
  spend: L.metrics.monthView(st, '2026-11').spendCents,
  workouts: L.metrics.workoutWeek(st, WK).sessions,
  overdue: L.social.summary(st, TODAY).overdue,
  goal: L.goals.evaluate(st, st.goals.find((g) => g.id === 'gNet'), TODAY).progress,
  headlines: L.DOMAINS.map((d) => L.metrics.headline(st, d.id, TODAY).display),
});
test('totals are computed from the main state only while closed, and include private records while open', async () => {
  await openWith(world());
  const all = nums(P.view(S.getState()));
  assert.deepEqual([all.netWorth, all.spend, all.workouts, all.overdue, all.goal], [600000, 35000, 3, 2, 0.6]);
  await P.moveIn('accounts', 'aPriv', { children: true }); await P.moveIn('entries', 'x2'); await P.moveIn('entries', 'w3'); await P.moveIn('people', 'pPriv', { children: true });
  const open = nums(P.view(S.getState()));
  assert.deepEqual(open, all, 'open: nothing changed by moving');
  P.close();
  const closed = nums(P.view(S.getState()));
  assert.deepEqual([closed.netWorth, closed.spend, closed.workouts, closed.overdue, closed.goal], [100000, 10000, 2, 1, 0.1], 'closed: main state only');
  // a state that never had the private records gives identical numbers and headlines
  const never = world(); never.accounts = never.accounts.filter((a) => a.id !== 'aPriv'); never.entries = never.entries.filter((e) => !['b2', 'x2', 'w3'].includes(e.id));
  never.people = never.people.filter((p) => p.id !== 'pPriv'); never.contacts = never.contacts.filter((c) => c.id !== 'c2');
  assert.deepEqual(closed, nums(S.validateState(clone(never))));
  assert.ok(!text(closed).includes('Secret'));
  // search, review pieces, at a glance
  assert.deepEqual(L.social.search(S.getState(), 'Sam'), [], 'search finds nothing private while closed');
  assert.ok(!text(L.social.roster(S.getState(), TODAY)).includes('Secret'));
  assert.ok(!text(L.activities.glance(S.getState(), TODAY, 30)).includes('Secret'));
  await P.open(PRIV);
  assert.ok(L.social.search(P.view(S.getState()), 'Sam').length > 0);
});

// ---------------------------------------------------------------- main-only outputs
test('prompts, digest, insights, review records, audit and CSV always use the main state, even while open', async () => {
  const w = world(); w.settings.provider = { kind: 'manual', baseUrl: '', model: '', apiKey: '' };
  await openWith(w);
  await P.moveIn('accounts', 'aPriv', { children: true }); await P.moveIn('entries', 'x2'); await P.moveIn('entries', 'w3'); await P.moveIn('people', 'pPriv');
  const base = S.getState(), view = P.view(base);
  assert.ok(P.isView(view) && P.mainOnly(view) === base);
  assert.notDeepEqual(nums(view), nums(base), 'the open view differs from the main state');
  assert.deepEqual(L.metrics.weeklyDigest(view, WK), L.metrics.weeklyDigest(base, WK));
  assert.deepEqual(L.memory.rulesInsights(view, WK), L.memory.rulesInsights(base, WK));
  for (const lv of [1]) assert.deepEqual(L.memory.buildPrompt(view, lv, { from: WK, to: '2026-11-15' }), L.memory.buildPrompt(base, lv, { from: WK, to: '2026-11-15' }));
  const prompt = text(L.memory.buildPrompt(view, 1, { from: WK, to: '2026-11-15' }));
  assert.ok(!/Secret|Sam|pPriv/.test(prompt));
  // CSV: private records are dropped even if a caller hands them over
  const csv = L.csv.exportEntries(view.entries);
  assert.ok(!csv.includes('Secret') && csv.includes('Lunch'));
  assert.ok(!L.csv.exportEntries(P.view(S.getState()).entries.filter((e) => e.domain === 'health')).includes('Secret'));
  // backup export from a view carries the main state only, plus the blob unchanged
  const bk = await V.importBackup('backup passphrase 1', await V.exportBackup('backup passphrase 1', view));
  assert.ok(!text(bk).includes('Secret'), 'backup from a view has no private records in the clear');
  assert.deepEqual(bk.priv, S.getState().priv);
  // the audit log holds action names only
  const audit = S.getState().audit.map((a) => a.action);
  assert.ok(audit.includes('private vault set up') && audit.includes('private vault moved in'));
  assert.ok(!text(S.getState().audit).match(/aPriv|Secret|accounts|entries|people/), 'no collection or record detail in the audit log');
  P.close(); await new Promise((r) => setTimeout(r, 20));
  await P.open(PRIV); await new Promise((r) => setTimeout(r, 20));
  const acts = S.getState().audit.map((a) => a.action);
  assert.ok(acts.includes('private vault closed') && acts.includes('private vault opened'));
});

// ---------------------------------------------------------------- backup and sync
test('backup carries priv unchanged; restoring a copy without a private vault needs the explicit choice', async () => {
  const orig = full();
  await openWith(orig); await P.moveIn('people', 'sp1', { children: true });
  const priv = clone(S.getState().priv);
  const backup = await V.exportBackup('backup passphrase 1', S.getState());
  assert.ok(!backup.includes(ADV_MARK));
  const restored = await V.importBackup('backup passphrase 1', backup);
  assert.deepEqual(restored.priv, priv);
  assert.deepEqual(S.droppedData(S.getState(), restored), []);
  // a copy with no private vault
  const without = clone(restored); delete without.priv; const clean = S.validateState(without);
  assert.deepEqual(S.droppedData(S.getState(), clean), ['private vault']);
  assert.match(S.lossText(S.getState(), clean), /private vault/);
  await assert.rejects(S.replaceState(clean), (e) => e.code === 'OLDER_FORMAT' && /private vault/.test(e.message));
  assert.ok(S.getState().priv, 'nothing was replaced');
  await S.replaceState(restored);
  assert.deepEqual(S.getState().priv, priv, 'restoring a copy that has one carries it over');
  await S.replaceState(clean, { allowWorkLoss: true });
  assert.ok(!S.getState().priv);
  // and a vault that has none can take a copy that has none without any prompt
  assert.deepEqual(S.droppedData(S.getState(), clean), []);
});

test('sync with the vault closed: ciphertext only, priv unchanged, both copies say yes or no, never dropped silently', async () => {
  const d = drive(); L.sync._setFetch(d.fetch); L.sync._setToken(TOKEN, 3600);
  const orig = full();
  await openWith(orig); await P.moveIn('accounts', 'acc1', { children: true }); await P.moveIn('people', 'sp1', { children: true });
  P.close();
  const priv = clone(S.getState().priv);
  const r1 = await L.sync.run({});
  assert.equal(r1.kind, 'uploaded');
  assert.ok(!d.file.text.includes(ADV_MARK) && !d.file.text.includes('"sp1"'), 'nothing private in what Google holds');
  assert.deepEqual(S.getState().priv, priv, 'sync with the vault closed leaves the blob as it was');
  // another device downloads and opens it
  const env = JSON.parse(d.file.text), remoteKey = await fastDerive(PASS, V.parseEnvelope(env).salt);
  const remoteRaw = await V.decrypt(remoteKey, env);
  assert.deepEqual(remoteRaw.priv, priv);
  const ad2 = memAdapter(); S._setAdapter(ad2); S.lock(); await S.init(PASS);
  const r2 = await L.sync.run({ passphrase: PASS });
  assert.equal(r2.kind, 'download-offer'); assert.equal(r2.remote.priv, true); assert.equal(r2.local.priv, false); assert.equal(r2.dropsWork, false);
  await L.sync.apply(r2, 'download', {});
  assert.deepEqual(S.getState().priv, priv);
  await P.open(PRIV);
  assert.ok(P.view(S.getState()).people.some((p) => p.id === 'sp1'));
});

test('conflict: remote without a private vault over a local one needs the explicit choice', async () => {
  const d = drive(); L.sync._setFetch(d.fetch); L.sync._setToken(TOKEN, 3600);
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 5 })); });
  await L.sync.run({});
  const rem = clone(S.getState()); delete rem.priv;
  rem.entries.push(E({ domain: 'money', type: 'expense', value: 6 }));
  await putRemote(d, rem, 3);
  await P.setUp(PRIV); P.close('system');
  const dec = await L.sync.run({});
  assert.equal(dec.kind, 'conflict'); assert.deepEqual([dec.local.priv, dec.remote.priv], [true, false]);
  assert.equal(dec.dropsWork, true); assert.deepEqual(dec.dropped, ['private vault']);
  await assert.rejects(L.sync.apply(dec, 'remote', { saveBackup: async () => {} }), (e) => e.code === 'OLDER_FORMAT' && /private vault/.test(e.message));
  assert.ok(S.getState().priv);
  await L.sync.apply(dec, 'remote', { allowWorkLoss: true, saveBackup: async () => {} });
  assert.ok(!S.getState().priv);
});

// ---------------------------------------------------------------- crafted blobs, wrong passphrase
test('crafted priv blobs are rejected by validateState without the key, and never cost the main state', async () => {
  await openWith(full());
  await P.moveIn('accounts', 'acc1');
  P.close('system');
  const good = clone(S.getState());
  const before = text(S.getState());
  const mut = (f) => { const o = clone(good); f(o.priv, o); return o; };
  const cases = {
    'wrong iter': mut((p) => { p.kdf.iter = 599999; }),
    'iter as text': mut((p) => { p.kdf.iter = '600000'; }),
    'oversized ct': mut((p) => { p.ct = 'A'.repeat(40e6 + 4); }),
    'bad base64 ct': mut((p) => { p.ct = '!!!!not base64!!!!'; }),
    'bad base64 iv': mut((p) => { p.iv = 'AAAA*AAAAAAAAAAA'; }),
    'short iv': mut((p) => { p.iv = 'AAAAAAAA'; }),
    'bad salt': mut((p) => { p.kdf.salt = 'AAAA'; }),
    'unknown field': mut((p) => { p.extra = 1; }),
    'unknown kdf field': mut((p) => { p.kdf.extra = 1; }),
    'version': mut((p) => { p.v = 2; }),
    'hash': mut((p) => { p.kdf.hash = 'SHA-1'; }),
    'rev negative': mut((p) => { p.rev = -1; }),
    'rev float': mut((p) => { p.rev = 1.5; }),
    'marks unknown name': mut((p) => { p.marks = ['accounts', 'notacollection']; }),
    'marks __proto__': mut((p) => { p.marks = ['__proto__']; }),
    'marks constructor': mut((p) => { p.marks = ['constructor']; }),
    'marks duplicates': mut((p) => { p.marks = ['accounts', 'accounts']; }),
    'marks not a list': mut((p) => { p.marks = { accounts: 1 }; }),
    'marks not text': mut((p) => { p.marks = [1]; }),
    'priv as array': (() => { const o = clone(good); o.priv = []; return o; })(),
    'priv in schema 9': (() => { const o = clone(good); o.schema = 9; return o; })(),
  };
  const protoKey = JSON.parse(JSON.stringify(good).replace('"marks":["accounts"]', '"marks":["accounts"],"__proto__":{"x":1}'));
  cases['__proto__ key'] = protoKey;
  for (const [name, o] of Object.entries(cases)) {
    assert.throws(() => S.validateState(o), /Invalid data/, name);
    await assert.rejects(S.replaceState(o), /Invalid data/, name);
    assert.equal(text(S.getState()), before, name + ': main state untouched');
  }
  // a crafted vault on disk: unlock refuses it and the stored envelope is untouched
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  const stored = JSON.stringify(await ad.get('envelope'));
  const sub = (await S.exportEnvelope());
  const key = await fastDerive(PASS, V.parseEnvelope(sub).salt);
  const badEnv = await V.makeEnvelope(key, V.parseEnvelope(sub).salt, Object.assign(clone(good), { priv: cases['wrong iter'].priv, _meta: { rev: sub.rev, updatedAt: sub.updatedAt, deviceId: sub.deviceId } }));
  await ad.set('envelope', Object.assign(badEnv, { rev: sub.rev, updatedAt: sub.updatedAt, deviceId: sub.deviceId }));
  const raw = JSON.stringify(await ad.get('envelope'));
  S.lock();
  await assert.rejects(S.unlock(PASS), /Invalid data/);
  assert.equal(JSON.stringify(await ad.get('envelope')), raw);
  assert.notEqual(raw, stored);
  // a v0.10.0-style backup of a crafted state is refused by import
  await assert.rejects(V.importBackup('backup passphrase 1', await (async () => { const s = S.defaultState(); const salt = V.newSalt(); const k = await fastDerive('backup passphrase 1', salt); return JSON.stringify(await V.makeEnvelope(k, salt, Object.assign(clone(s), { priv: cases['bad salt'].priv }))); })()), /Invalid data|BAD/);
});

test('tampered ciphertext and a swapped inner rev fail to open (structure is fine); wrong passphrase leaves everything as it was', async () => {
  await openWith(full());
  await P.moveIn('accounts', 'acc1');
  P.close('system');
  const main = text(S.getState());
  const flip = clone(S.getState()); const b = Buffer.from(flip.priv.ct, 'base64'); b[b.length >> 1] ^= 1; flip.priv.ct = b.toString('base64');
  await S.replaceState(flip);
  await assert.rejects(P.open(PRIV), /BAD_PRIVATE_PASSPHRASE/);
  assert.ok(!P.isOpen());
  assert.ok(!text(S.getState()).includes('=cmd|x account'), 'main state intact, the moved account is not in it');
  const swapped = clone(S.getState()); swapped.priv.rev = 7;
  await S.replaceState(swapped);
  await assert.rejects(P.open(PRIV), /BAD_PRIVATE_PASSPHRASE|revision/);
  await assert.rejects(P.open('not the right passphrase'), /BAD_PRIVATE_PASSPHRASE/);
  assert.equal(S.getState().entries.length > 0, true);
  assert.ok(main.length > 100);
});

test('inner data is validated on open: a blob with unknown collections, bad links or forbidden keys is refused', async () => {
  await vault(full(), { setUp: false });
  const key = await fastDerive(PRIV, V.newSalt());
  const mk = async (inner) => {
    const salt = V.newSalt(), k = await fastDerive(PRIV, salt), e = await V.encrypt(k, inner);
    let sb = ''; for (const x of salt) sb += String.fromCharCode(x);
    return { v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: 600000, salt: btoa(sb) }, iv: e.iv, ct: e.ct, rev: inner.rev, marks: [] };
  };
  const base = { schema: 1, rev: 0, records: {}, links: [], wellbeing: {} };
  const variants = {
    unknownCollection: Object.assign(clone(base), { records: { nope: [] } }),
    badRecord: Object.assign(clone(base), { records: { accounts: [{ id: 'x', name: '', kind: 'cash', liability: false, archived: false }] } }),
    badLink: Object.assign(clone(base), { links: [{ fromCollection: 'people', fromId: 'sp1', field: 'notAField', toId: 'x' }] }),
    extraField: Object.assign(clone(base), { extra: 1 }),
    proto: JSON.parse('{"schema":1,"rev":0,"records":{},"links":[],"wellbeing":{"__proto__":{"x":1}}}'),
  };
  for (const [name, inner] of Object.entries(variants)) {
    const bad = clone(S.getState()); bad.priv = await mk(inner);
    await S.replaceState(bad);
    await assert.rejects(P.open(PRIV), /private|Invalid|BAD_PRIVATE/i, name);
    assert.ok(!P.isOpen(), name);
  }
  void key;
});

// ---------------------------------------------------------------- destroy, shadows, size, inner API
test('destroy removes the vault and every private record; part B API: commit and getWellbeing', async () => {
  await openWith(full());
  await P.moveIn('people', 'sp1');
  await P.commit((i) => { i.wellbeing.checkins = [{ id: 'c1', date: TODAY, mood: 4 }]; });
  assert.deepEqual(P.getWellbeing(), { checkins: [{ id: 'c1', date: TODAY, mood: 4 }] });
  assert.ok(S.getState().priv.marks.includes('wellbeing'));
  const inner = await openInner(); assert.equal(inner.rev, S.getState().priv.rev);
  assert.ok(!text(L.metrics.weeklyDigest(P.view(S.getState()), WK)).includes('checkins'));
  await P.destroy();
  assert.ok(!P.isOpen() && !S.getState().priv);
  assert.ok(!S.getState().people.some((p) => p.id === 'sp1'));
  assert.ok(S.getState().audit.some((a) => a.action === 'private vault destroyed'));
});

test('a private record whose key collides with a public one is shadowed, kept, and never loses data', async () => {
  const w = full();
  await openWith(w);
  await P.moveIn('budgets', 'Groceries');
  await S.commit((x) => { x.budgets.push({ category: 'Groceries', value: 111 }); }); // a public one made while the vault was open elsewhere
  const v = P.view(S.getState());
  assert.equal(v.budgets.filter((b) => b.category === 'Groceries').length, 1);
  assert.equal(v.budgets.find((b) => b.category === 'Groceries').value, 111, 'public wins in the view');
  await assert.rejects(P.moveIn('budgets', 'Groceries'), /already exists/);
  await P.write((x) => { x.projects[0].name = 'touch'; });
  P.close('system'); await P.open(PRIV);
  const inner = await openInner(); assert.equal(inner.records.budgets.length, 1); assert.equal(inner.records.budgets[0].value, 300);
  // cycle: one slot
  await P.moveIn('cycle', 'cycle');
  assert.equal(S.getState().cycle, null);
  await S.commit((x) => { x.cycle = { startDate: '2026-11-01', sprintDays: 7, sprintsPerCycle: 1, restDays: 0, alternateHeavyLight: false, firstWeek: 'heavy' }; });
  assert.equal(P.view(S.getState()).cycle.startDate, '2026-11-01', 'public wins in the view');
  await assert.rejects(P.moveIn('cycle', 'cycle'), /already exists/);
  assert.equal(await P.moveOut('cycle', 'cycle'), 0);
  await P.write((x) => { x.cycle.sprintDays = 14; });
  assert.equal(S.getState().cycle.sprintDays, 14);
  assert.equal((await openInner()).records.cycle[0].startDate, '2026-10-01', 'the private cycle is untouched');
});

// ---------------------------------------------------------------- migration and old versions
const OLD = { 3: ['projects', 'pipeline'], 4: ['cycle', 'kinds', 'habits', 'habitLog'], 5: ['goals'], 6: ['properties', 'vehicles', 'maintenance', 'renewals', 'documents', 'taxItems'], 7: ['learningItems', 'studySessions', 'takeaways'], 8: ['activities', 'activityCategories'], 9: ['groups', 'people', 'contacts'] };
function asSchema(n, st) {
  const o = clone(st); o.schema = n; delete o.priv;
  for (const [v, keys] of Object.entries(OLD)) if (Number(v) > n) for (const k of keys) delete o[k];
  if (n < 6) { delete o.settings.home; for (const r of o.recurring || []) delete r.household; }
  if (n < 7) delete o.settings.learning;
  if (n < 4) delete o.settings.health;
  if (n < 2) for (const k of ['accounts', 'recurring', 'budgets', 'categories']) delete o[k];
  delete o.settings.privAutoLockSec;
  if (n < 9) for (const a of o.activities || []) delete a.expenseId;
  return o;
}
test('schema 1 to 9 migrate into 10 with no loss: every text an old copy held is still there', () => {
  const src = full();
  for (let n = 1; n <= 9; n++) {
    const old = asSchema(n, src), oldText = text(old);
    const got = S.validateState(clone(old));
    assert.equal(got.schema, 10); assert.equal(got.sourceSchema, n); assert.ok(!got.priv); assert.equal(got.settings.privAutoLockSec, 60);
    const gotText = text(got);
    for (const m of new Set(oldText.match(/LEAK mark \d+/g) || [])) assert.ok(gotText.includes(m), 'schema ' + n + ' lost ' + m);
    for (const c of P.COLLECTIONS) assert.ok(c === 'cycle' ? got.cycle === null || typeof got.cycle === 'object' : Array.isArray(got[c]), c);
  }
  const nine = asSchema(9, src), got9 = S.validateState(clone(nine));
  assert.deepEqual(strip(got9), strip(S.validateState(clone(src))), 'schema 9 round trips exactly');
});

test('a stored v0.10.0 vault unlocks, migrates and persists; a v0.10.0 backup imports cleanly and needs no tick on a fresh vault', async () => {
  const ad = memAdapter(); S._setAdapter(ad); S.lock();
  await S.init(PASS);
  const nine = asSchema(9, full());
  const env = await S.exportEnvelope(); const salt = V.parseEnvelope(env).salt, key = await fastDerive(PASS, salt);
  await ad.set('envelope', await V.makeEnvelope(key, salt, nine));
  S.lock();
  const st = await S.unlock(PASS);
  assert.equal(st.schema, 10); assert.equal(st.people.length, 1);
  await S.commit(() => {});
  assert.equal((await V.decrypt(key, await ad.get('envelope'))).schema, 10);
  const backup = JSON.stringify(await V.makeEnvelope(await realDerive('backup passphrase 1', salt), salt, nine));
  const imp = await V.importBackup('backup passphrase 1', backup);
  assert.equal(imp.schema, 10); assert.equal(imp.sourceSchema, 9);
  assert.deepEqual(S.droppedData(S.getState(), imp), []);
  await S.replaceState(imp);
  assert.equal(S.getState().schema, 10);
  // while a vault with a private vault would lose it
  await P.setUp(PRIV);
  assert.deepEqual(S.droppedData(S.getState(), imp), ['private vault']);
  await assert.rejects(S.replaceState(imp), (e) => e.code === 'OLDER_FORMAT');
});

test('an older app (v0.10.0, schema 9) refuses a schema 10 vault in unlock, backup and sync, so it can never strip the private vault', async () => {
  // Rebuild the v0.10.0 validateState gate (SCHEMA 9, accepted list 1 to 8 and SCHEMA) from the current source in a clean context.
  const read = (f) => readFileSync(new URL('../src/core/' + f, import.meta.url), 'utf8');
  const store = read('store.js').replace('SCHEMA = 10,', 'SCHEMA = 9,').replace('[1, 2, 3, 4, 5, 6, 7, 8, 9, SCHEMA]', '[1, 2, 3, 4, 5, 6, 7, 8, SCHEMA]');
  assert.ok(/SCHEMA = 9,/.test(store) && /\[1, 2, 3, 4, 5, 6, 7, 8, SCHEMA\]/.test(store));
  const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, console, JSON, Promise, Uint8Array, Date, Math, Array, Object, Set, Map, Number, String, Error, WeakSet, WeakMap, setTimeout, clearTimeout, AbortController, URL, URLSearchParams, structuredClone });
  ctx.globalThis = ctx;
  for (const f of ['vault.js', 'csv.js', 'metrics.js', 'home.js', 'admin.js', 'learning.js', 'activities.js', 'social.js', 'goals.js', 'memory.js', 'ai.js', 'sync.js']) {
    if (f === 'csv.js') vm.runInContext(store, ctx);
    vm.runInContext(read(f), ctx);
  }
  const O = ctx.LifeOS;
  await openWith(full()); await P.moveIn('people', 'sp1');
  const mine = clone(S.getState());
  assert.throws(() => O.store.validateState(mine), /unsupported schema/);
  const backup = await V.exportBackup('backup passphrase 1', S.getState());
  await assert.rejects(O.vault.importBackup('backup passphrase 1', backup), /unsupported schema/);
  // unlock of the stored v10 envelope in the old build: refused, storage untouched
  const realEnv = async (state) => { const salt = V.newSalt(), k = await realDerive(PASS, salt), m = { rev: 1, updatedAt: '2026-11-14T00:00:00.000Z', deviceId: 'dev' }; return Object.assign(await V.makeEnvelope(k, salt, Object.assign(clone(state), { _meta: m })), m); };
  const ad = memAdapter(); await ad.set('envelope', await realEnv(S.getState())); const raw = JSON.stringify(await ad.get('envelope'));
  O.store._setAdapter(ad);
  await assert.rejects(O.store.unlock(PASS), /unsupported schema/);
  assert.equal(JSON.stringify(await ad.get('envelope')), raw);
  // sync: the old build cannot adopt it either
  const d = drive(); d.put(JSON.stringify(await realEnv(S.getState())));
  const ad2 = memAdapter(); O.store._setAdapter(ad2); O.store.lock(); await O.store.init(PASS);
  O.sync._setFetch(d.fetch); O.sync._setToken(TOKEN, 3600);
  await assert.rejects(O.sync.run({ passphrase: PASS }), /not a valid LifeOS vault/);
  await S.lock();
});

test('the lock marker contract: marks name collections only and never carry counts', async () => {
  await openWith(full());
  await P.moveIn('accounts', 'acc1'); await P.moveIn('people', 'sp1');
  assert.deepEqual(P.marks(S.getState()).sort(), ['accounts', 'people']);
  assert.deepEqual(P.marks({}), []);
  assert.ok(P.marks(S.getState()).every((m) => typeof m === 'string'));
  assert.ok(S.getState().priv.marks.every((m) => P.MARK_NAMES.includes(m)));
});

test('concurrent writes while open are serialised and keep rev in step', async () => {
  await openWith(full());
  const r0 = S.getState().priv.rev;
  await Promise.all([P.write((x) => { x.projects[0].name = 'one'; }), P.moveIn('accounts', 'acc1'), P.write((x) => { x.projects[0].name = 'three'; })]);
  assert.equal(S.getState().priv.rev, r0 + 3);
  assert.equal(S.getState().projects[0].name, 'three');
  assert.ok(P.view(S.getState()).accounts.some((a) => a.id === 'acc1'));
  const inner = await openInner(); assert.equal(inner.rev, r0 + 3);
});
});
