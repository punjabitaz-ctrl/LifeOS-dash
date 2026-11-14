// v0.11.0 audit: regression tests for SEC-62 to SEC-68 and SEC-70 (the older-app check against the real v0.10.0 code); see "v0.11.0 audit" in docs/SECURITY.md.
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { L, memAdapter, PASS, E } from './_load.mjs';
import { drive, TOKEN, clone } from './_v070.mjs';
import { buildAdversarial, ADV_MARK } from './_adversarial.mjs';

const live = (k) => new Proxy({}, { get: (_, p) => L[k][p], set: (_, p, v) => { L[k][p] = v; return true; } });
const S = live('store'), P = live('priv'), V = live('vault'), M = live('metrics'), Mem = live('memory'), W = live('wellbeing');
const PRIV = 'a private passphrase 99';
const TODAY = '2026-11-14', WK = '2026-11-09';
let ORIG = null;
const fastDerive = async (pass, salt) => {
  const base = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};
const text = (x) => JSON.stringify(x);
function full() {
  const { state } = buildAdversarial(L);
  const s = clone(state);
  s.settings.provider = { kind: 'none', baseUrl: '', model: '', apiKey: '' };
  return S.validateState(clone(s));
}
let ad = null;
async function vault(state, opts = {}) {
  ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  if (state) await S.replaceState(state);
  if (opts.setUp !== false) await P.setUp(PRIV);
}
const deferred = () => { let r; const p = new Promise((res) => { r = res; }); return { p, r }; };

describe('v0.11.0 audit', () => {
beforeEach(() => { ORIG = L.vault.deriveKey; L.vault.deriveKey = fastDerive; });
afterEach(() => { L.vault.deriveKey = ORIG; try { L.priv.close('system'); } catch (e) { /* ignore */ } delete globalThis.document; });

// ---------------------------------------------------------------- SEC-62
test('SEC-62: records made from or under a private record are private; nothing derived from one reaches the main state', async () => {
  const s = full();
  const MK = (x) => ADV_MARK + 'derived ' + x;
  s.maintenance.push({ id: 'mrep', title: MK('maint'), area: 'Roof', cadence: 'monthly', vendor: MK('vendor'), notes: MK('mnote'), state: 'done', nextDue: '2026-10-01', lastDone: '2026-10-01', propertyId: 'pp1' });
  s.renewals.push({ id: 'rrep', title: MK('renewal'), kind: 'insurance', provider: MK('prov'), dueDate: '2026-10-01', cadence: 'annual', autoRenews: false, state: 'done', notes: MK('rnote') });
  s.entries.push(E({ id: 'oc1', domain: 'work', type: 'outcome', date: '2026-11-03', title: MK('outcome'), status: 'todo', notes: MK('onote') }));
  s.activities.push({ id: 'aw', title: MK('act'), category: 'event', state: 'done', date: '2026-11-10', place: 'x', withPeople: ['Zed ' + ADV_MARK + 'newname'], costCents: 0, alsoHealth: false, alsoSocial: true, notes: '' });
  await vault(S.validateState(clone(s)));
  for (const [c, id] of [['recurring', 'r1'], ['maintenance', 'mrep'], ['renewals', 'rrep'], ['entries', 'oc1'], ['activities', 'aw'], ['people', 'sp1'], ['learningItems', 'li1'], ['accounts', 'acc1']]) await P.moveIn(c, id);
  const before = (c) => P.view(S.getState())[c].length;
  const n = { entries: before('entries'), maintenance: before('maintenance'), renewals: before('renewals'), people: before('people'), contacts: before('contacts'), studySessions: before('studySessions') };
  const pubLen = (c) => S.getState()[c].length;
  const pub0 = { entries: pubLen('entries'), maintenance: pubLen('maintenance'), renewals: pubLen('renewals'), people: pubLen('people'), contacts: pubLen('contacts'), studySessions: pubLen('studySessions') };
  // the app passes the source records (as it does at each call site); the core decides
  await P.write((x) => { M.confirmRecurring(x, 'r1', TODAY); }, { from: [['recurring', 'r1']] });
  await P.write((x) => { M.carryOver(x, ['oc1'], WK); }, { from: [['entries', 'oc1']] });
  await P.write((x) => { L.home.confirmNext(x, 'mrep'); }, { from: [['maintenance', 'mrep']] });
  await P.write((x) => { L.admin.confirmRenewal(x, 'rrep'); }, { from: [['renewals', 'rrep']] });
  await P.write((x) => { L.social.addPerson(x, { name: 'Zed ' + ADV_MARK + 'newname' }); }, { from: [['activities', 'aw']] });
  // no source named: a record under a private parent is private by its reference
  await P.write((x) => { L.social.logContact(x, 'sp1', { date: TODAY, channel: 'call', notes: MK('contact') }, TODAY); });
  await P.write((x) => { L.learning.addSession(x, { itemId: 'li1', date: TODAY, minutes: 30, notes: MK('session') }, TODAY); });
  await P.write((x) => { x.entries.push(E({ domain: 'assets', type: 'balance', date: TODAY, title: MK('balance'), value: 5, accountId: 'acc1' })); });
  // no source and no reference, but the same write changed a private record: still private
  await P.write((x) => { x.recurring.find((r) => r.id === 'r1').title = MK('recurring edited'); x.entries.push(E({ domain: 'money', type: 'expense', date: TODAY, title: MK('copied'), value: 3, category: 'Other' })); });
  const v = P.view(S.getState());
  assert.equal(v.entries.length, n.entries + 4); assert.equal(v.maintenance.length, n.maintenance + 1); assert.equal(v.renewals.length, n.renewals + 1);
  assert.equal(v.people.length, n.people + 1); assert.equal(v.contacts.length, n.contacts + 1); assert.equal(v.studySessions.length, n.studySessions + 1);
  for (const c of Object.keys(pub0)) assert.equal(S.getState()[c].length, pub0[c], c + ': nothing new in the main state');
  assert.ok(!text(S.getState()).includes('derived'), 'no derived text in the main state');
  // a public source stays public
  await P.write((x) => { x.recurring.push({ id: 'rpub', title: 'Plain public bill', value: 2, category: 'Other', type: 'expense', cadence: 'monthly', nextDate: '2026-11-13', active: true }); });
  await P.write((x) => { M.confirmRecurring(x, 'rpub', TODAY); }, { from: [['recurring', 'rpub']] });
  assert.ok(S.getState().entries.some((e) => e.title === 'Plain public bill'));
  await P.write((x) => { x.entries.push(E({ domain: 'money', type: 'expense', date: TODAY, title: 'Unrelated public', value: 1, category: 'Other' })); });
  assert.ok(S.getState().entries.some((e) => e.title === 'Unrelated public'));
  P.close('system');
  assert.ok(!text(S.getState()).includes('derived'));
});

// ---------------------------------------------------------------- SEC-63
test('SEC-63: a close trigger during an open or a set-up leaves the vault closed', async () => {
  const doc = Object.assign(new EventTarget(), { hidden: false });
  globalThis.document = doc;
  await vault(full());
  await P.moveIn('accounts', 'acc1');
  P.close('system');
  const slow = (gate) => async (p, salt) => { await gate.p; return fastDerive(p, salt); };
  const triggers = {
    'tab hidden': () => { doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange')); },
    'AI call': () => L.ai.complete({ kind: 'manual', baseUrl: '', model: '', apiKey: '' }, { system: 's', user: 'u' }).catch(() => {}),
    'Close button': () => P.close(),
  };
  for (const [name, fire] of Object.entries(triggers)) {
    doc.hidden = false; await S.commit(() => {}, { quiet: true });
    const gate = deferred(); L.vault.deriveKey = slow(gate);
    const pend = P.open(PRIV);
    await new Promise((r) => setTimeout(r, 5));
    fire();
    gate.r();
    await assert.rejects(pend, /closed while it was opening/, name);
    assert.ok(!P.isOpen(), name + ': stays closed');
    doc.hidden = false;
    L.vault.deriveKey = fastDerive;
  }
  // opened while the tab is hidden: refused
  doc.hidden = true;
  await assert.rejects(P.open(PRIV), /closed while it was opening/);
  doc.hidden = false;
  await P.open(PRIV); assert.ok(P.isOpen());
  P.close('system');
  // set-up raced by the tab being hidden: the vault is set up but closed
  await vault(full(), { setUp: false });
  const gate = deferred(); L.vault.deriveKey = slow(gate);
  const pend = P.setUp(PRIV);
  await new Promise((r) => setTimeout(r, 5));
  doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
  gate.r(); await pend; doc.hidden = false;
  assert.ok(P.isSetUp(S.getState()) && !P.isOpen());
  L.vault.deriveKey = fastDerive;
  await P.open(PRIV); assert.ok(P.isOpen());
});

// ---------------------------------------------------------------- SEC-64 and the races
test('SEC-64 and races: a close racing an in-flight write, move or check-in leaves no plaintext and no half write', async () => {
  await vault(full());
  await P.moveIn('accounts', 'acc1');
  // 1. close while the main envelope is being stored: the write is saved (encrypted), reported as done, and nothing stays open
  const realSet = ad.set;
  await S.commit(() => {}, { quiet: true }); // let the quiet audit write from opening finish first
  ad.set = async (k, v) => { P.close('system'); return realSet(k, v); };
  await P.commit((i) => { W.save(i.wellbeing, { date: TODAY, mood: 4, note: 'race note ' + ADV_MARK }); });
  ad.set = realSet;
  assert.ok(!P.isOpen());
  assert.throws(() => P.getWellbeing(), /closed/);
  assert.equal(P.view(S.getState()), S.getState());
  await P.open(PRIV);
  assert.equal(W.byDate(P.getWellbeing(), TODAY).mood, 4, 'saved');
  await S.commit(() => {}, { quiet: true });
  ad.set = async (k, v) => { P.close('system'); return realSet(k, v); };
  await P.moveIn('people', 'sp1');
  ad.set = realSet;
  assert.ok(!P.isOpen() && !S.getState().people.some((p) => p.id === 'sp1'), 'move saved and closed');
  await P.open(PRIV);
  // 2. close while the inner plaintext is being encrypted: refused, nothing written in either layer
  await S.commit(() => {}, { quiet: true });
  const strip = (st) => text(Object.assign({}, st, { audit: 0 })); // opening adds a quiet audit line; everything else must be untouched
  const snap = strip(S.getState()), rev = S.getState().priv.rev, realEnc = V.encrypt;
  const settle = () => S.commit(() => {}, { quiet: true });
  L.vault.encrypt = async (k, obj) => { if (obj && obj.records) P.close('system'); return realEnc(k, obj); };
  try {
    await assert.rejects(P.moveIn('projects', 'p1'), /closed/);
    await P.open(PRIV); await settle();
    await assert.rejects(P.commit((i) => { W.save(i.wellbeing, { date: '2026-11-13', mood: 2 }); }), /closed/);
    await P.open(PRIV); await settle();
    await assert.rejects(P.write((x) => { x.accounts.find((a) => a.id === 'acc1').name = 'changed ' + ADV_MARK; }), /closed/);
  } finally { L.vault.encrypt = realEnc; }
  assert.equal(strip(S.getState()), snap, 'main state and priv blob untouched');
  assert.equal(S.getState().priv.rev, rev);
  assert.ok(S.getState().projects.some((p) => p.id === 'p1'), 'the project is still public: the move did not half happen');
  // 3. close while a check-in's own callback is still running
  await P.open(PRIV);
  const gate = deferred();
  const pend = P.commit(async (i) => { await gate.p; W.save(i.wellbeing, { date: '2026-11-12', mood: 1 }); });
  await new Promise((r) => setTimeout(r, 5));
  P.close('system'); gate.r();
  await assert.rejects(pend, /closed/);
  assert.equal(S.getState().priv.rev, rev);
  await P.open(PRIV);
  assert.equal(W.byDate(P.getWellbeing(), '2026-11-12'), null);
  // 4. queued writes after a close: refused, never applied to the main state as if public
  const q = P.write((x) => { x.accounts.find((a) => a.id === 'acc1').name = 'queued ' + ADV_MARK; });
  P.close('system');
  await assert.rejects(q, /closed/);
  assert.ok(!text(S.getState()).includes('queued'));
});

// ---------------------------------------------------------------- SEC-65
test('SEC-65: no write and no CSV import can add a wellbeing entry to the main state; older ones may still move in', async () => {
  await vault(null, { setUp: false });
  const mood = () => E({ domain: 'wellbeing', type: 'mood', date: TODAY, title: 'mood', value: 3 });
  await assert.rejects(P.write((x) => { x.entries.push(mood()); }), /only in the private vault/);
  assert.equal(S.getState().entries.length, 0);
  await P.setUp(PRIV);
  await assert.rejects(P.write((x) => { x.entries.push(mood()); }), /only in the private vault/);
  await assert.rejects(P.write((x) => { x.entries.push(mood()); }, { newPrivate: true }), /only in the private vault/);
  await assert.rejects(P.write((x) => { const e = E({ domain: 'health', type: 'workout', date: TODAY }); x.entries.push(e); }).then(() => P.write((x) => { const e = x.entries[0]; e.domain = 'wellbeing'; e.type = 'mood'; e.value = 2; })), /only in the private vault/);
  assert.throws(() => L.csv.toEntries(L.csv.parse('date,title,value\r\n2026-11-10,x,3\r\n'), { domain: 'wellbeing', type: 'mood', map: { date: '0', title: '1', value: '2' } }), /cannot be imported/);
  // older thin entries already in the main state still move in (and the guard does not block removing them)
  P.close('system');
  const st = clone(S.getState()); st.entries.push(mood()); await S.replaceState(st);
  await P.open(PRIV);
  await P.write((work, wbw) => { W.moveOld(work, wbw, S.newId); });
  assert.ok(!S.getState().entries.some((e) => e.domain === 'wellbeing'));
  assert.equal(W.byDate(P.getWellbeing(), TODAY).mood, 3);
});

// ---------------------------------------------------------------- SEC-66
test('SEC-66 (owner decision): no wellbeing value in the digest, prompts, rules insights or lessons; old thin mood entries never reach the AI', async () => {
  const s = full();
  s.entries.push(E({ domain: 'wellbeing', type: 'mood', date: '2026-11-10', title: 'Old mood ' + ADV_MARK, value: 2 }));
  s.entries.push(E({ domain: 'wellbeing', type: 'mood', date: '2026-11-03', title: 'Old mood 2', value: 5 }));
  s.memory.insights.push({ id: 'wi1', level: 1, period: { from: WK, to: '2026-11-15' }, domain: 'wellbeing', text: 'Average mood is up from 2 to 4.', source: 'rules', status: 'approved', createdAt: '2026-11-14T00:00:00.000Z', decidedAt: '2026-11-14T00:00:00.000Z' });
  s.memory.insights.push({ id: 'wi2', level: 1, period: { from: WK, to: '2026-11-15' }, domain: 'wellbeing', text: 'Mood dipped midweek.', source: 'ai', status: 'proposed', createdAt: '2026-11-14T00:00:00.000Z' });
  await vault(S.validateState(clone(s)));
  await P.commit((i) => { W.save(i.wellbeing, { date: TODAY, mood: 1, note: 'checkin ' + ADV_MARK }); });
  const st = S.getState(), dg = M.weeklyDigest(st, WK);
  assert.ok(!('wellbeing' in dg.domains) && !text(dg).includes('score'));
  const prompts = [Mem.buildPrompt(st, 1, { from: WK, to: '2026-11-15' }), Mem.buildPrompt(st, 2, { from: '2026-11-01', to: '2026-11-30' }), Mem.buildPrompt(P.view(st), 1, { from: WK, to: '2026-11-15' })];
  for (const p of prompts) { const t = (p.system + p.user).toLowerCase(); assert.ok(!t.includes('wellbeing') && !t.includes('mood') && !t.includes('leak mark'), t.slice(0, 200)); }
  assert.ok(!Mem.rulesInsights(st, WK).some((i) => i.domain === 'wellbeing' || /mood/i.test(i.text)));
  assert.throws(() => Mem.parseResponse('[{"domain":"wellbeing","text":"x"}]'), /unknown domain/);
  assert.throws(() => Mem.propose(clone(st), [{ domain: 'wellbeing', text: 'x' }], { level: 1, period: { from: WK, to: '2026-11-15' }, source: 'rules' }), /Invalid insight/);
  const x = clone(st); Mem.decide(x, 'wi2', 'rejected', 'my mood is my business'); assert.equal(x.memory.lessons.length, st.memory.lessons.length, 'no lesson from a wellbeing insight');
  // the review screen digest and the stored review record carry no wellbeing number
  assert.ok(!text(M.weeklyDigest(P.view(st), WK)).includes('wellbeing'));
});

// ---------------------------------------------------------------- settings (leak smoke exclusion)
test('settings cannot carry private or wellbeing data: only whitelisted numbers, enums and patterned ids survive any write', async () => {
  await vault(full());
  await P.moveIn('people', 'sp1');
  await P.write((x) => { x.settings.wellbeing = { mood: 5 }; x.settings.note = ADV_MARK + 'settings'; x.settings.targets.extra = 'x ' + ADV_MARK; x.settings.learning.title = ADV_MARK; x.settings.health.note = ADV_MARK; x.settings.home.x = ADV_MARK; });
  const set = text(S.getState().settings);
  assert.ok(!set.includes('LEAK') && !set.includes('wellbeing') && !set.includes('mood'), set);
  await assert.rejects(P.write((x) => { x.settings.sync.clientId = ADV_MARK; }), /Invalid data/);
  await assert.rejects(P.write((x) => { x.settings.sync.fileId = 'has spaces ' + ADV_MARK; }), /Invalid data/);
  await assert.rejects(P.write((x) => { x.settings.currency = 'LEAK MARK'; }), /Invalid data/);
  // the only free text left in settings is what the user types into the AI provider form
  assert.deepEqual(Object.keys(S.getState().settings).sort(), ['autoLockMin', 'currency', 'health', 'home', 'learning', 'privAutoLockSec', 'provider', 'sync', 'targets']);
});

// ---------------------------------------------------------------- SEC-68
test('SEC-68: moving a parent with 25,000 children is linear: the move dialog count and the move itself finish in seconds', async () => {
  await vault(null);
  await P.write((x) => {
    x.accounts.push({ id: 'big', name: 'Big account', kind: 'cash', liability: false, archived: false });
    for (let i = 0; i < 25000; i++) x.entries.push(M.validateEntry({ id: 'b' + i, domain: 'assets', type: 'balance', date: '2026-10-01', title: 'b', value: 1, accountId: 'big' }));
  });
  let t0 = Date.now();
  assert.equal(P.childrenOf(P.view(S.getState()), 'accounts', 'big').length, 25000);
  assert.ok(Date.now() - t0 < 5000, 'children counted in ' + (Date.now() - t0) + ' ms');
  t0 = Date.now();
  assert.equal(await P.moveIn('accounts', 'big', { children: true }), 25001);
  const ms = Date.now() - t0;
  assert.ok(ms < 15000, 'moved in ' + ms + ' ms (was about 36 s)');
  assert.equal(S.getState().entries.length, 0);
  assert.equal(P.view(S.getState()).entries.length, 25000);
});

// ---------------------------------------------------------------- older app, real v0.10.0 code
test('SEC-70: the real v0.10.0 code (git commit 8bf2325) cannot read, restore or overwrite a schema 10 vault, locally or through Drive', async (t) => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const old = (f) => execFileSync('git', ['-C', root, 'show', '8bf2325:src/core/' + f], { encoding: 'utf8', maxBuffer: 1 << 26 });
  let srcs;
  try { srcs = ['vault', 'store', 'csv', 'metrics', 'home', 'admin', 'learning', 'activities', 'social', 'goals', 'memory', 'ai', 'sync'].map((f) => old(f + '.js')); }
  catch (e) { t.skip('git history with the v0.10.0 commit is not available here'); return; }
  L.vault.deriveKey = ORIG; // the old build derives for real, so the new build must too
  assert.ok(/SCHEMA = 9,/.test(srcs[1]), 'this is the v0.10.0 store');
  const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, console, JSON, Promise, Uint8Array, Date, Math, Array, Object, Set, Map, Number, String, Error, WeakSet, WeakMap, setTimeout, clearTimeout, AbortController, URL, URLSearchParams, structuredClone, Intl });
  ctx.globalThis = ctx;
  for (const src of srcs) vm.runInContext(src, ctx);
  const O = ctx.LifeOS;
  // a v0.11.0 vault with a private vault, synced to Drive by the new device
  await vault(full());
  await P.moveIn('people', 'sp1');
  P.close('system');
  const d = drive(); L.sync._setFetch(d.fetch); L.sync._setToken(TOKEN, 3600);
  const r = await L.sync.run({}); assert.equal(r.kind, 'uploaded');
  const driveText = d.file.text, writes = d.writes;
  assert.ok(JSON.parse(driveText).ct && d.writes === 1);
  // 1. the old build unlocking a stored schema 10 envelope: refused, storage untouched
  const stored = await ad.get('envelope'), raw = JSON.stringify(stored);
  O.store._setAdapter(ad);
  await assert.rejects(O.store.unlock(PASS), /unsupported schema|Invalid data/);
  assert.equal(JSON.stringify(await ad.get('envelope')), raw);
  // 2. restoring a v0.11.0 backup in the old build: refused
  const backup = await V.exportBackup('backup passphrase 1', S.getState());
  await assert.rejects(O.vault.importBackup('backup passphrase 1', backup), /unsupported schema|Invalid data/);
  // 3. an old device that synced before, then changed its own data, runs sync: it cannot read the Drive copy and writes nothing
  const oad = memAdapter(); O.store._setAdapter(oad); await O.store.init(PASS);
  O.sync._setFetch(d.fetch); O.sync._setToken(TOKEN, 3600);
  await O.store.commit((x) => { x.settings.sync = { clientId: 'abc.apps.googleusercontent.com', remoteRev: 0, fp: '', fileId: 'file12345', keySalt: '' }; });
  await O.store.commit((x) => { x.projects.push({ id: 'oldp', name: 'Old device project', kind: 'job', status: 'active', archived: false, nextAction: '', nextDate: '', createdAt: '2026-11-14T00:00:00.000Z' }); });
  await assert.rejects(O.sync.run({ passphrase: PASS }), (e) => e.code === 'REMOTE_INVALID');
  // 4. and with no local change since its last sync
  await assert.rejects(O.sync.run({ passphrase: PASS }), (e) => e.code === 'REMOTE_INVALID');
  assert.equal(d.writes, writes, 'the old build never uploaded');
  assert.equal(d.file.text, driveText, 'the Drive copy with the private vault is unchanged');
  // the new build still reads it, private vault included
  const info = await S.inspectEnvelope(JSON.parse(d.file.text), PASS);
  assert.ok(info.state.priv && info.state.priv.marks.includes('people'));
  O.store.lock();
});
});
