// Independent review (privacy, AI boundary, data integrity). Proof tests: a test named "PV-n" that fails demonstrates finding PV-n
// in docs/review/privacy.md. Every other test is a check that passed at review time. Markers hold spaces so they can never appear by
// chance in base64 or hex output.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { L, memAdapter, PASS } from './_load.mjs';

const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), M = live('metrics'), R = live('revenue'), P = live('priv'), Mem = live('memory'), C = live('csv'), A = live('activities');
const PRIV = 'review private passphrase 7';
const T = '2026-11-10', WK = '2026-11-09', WE = '2026-11-15';
const MK = 'PVX probe ';
let n = 0;
const mk = (tag, max) => { const s = MK + (n++) + ' ' + tag + ' end'; return max ? s.slice(0, max) : s; };
const clone = (x) => JSON.parse(JSON.stringify(x));
const has = (x) => (typeof x === 'string' ? x : JSON.stringify(x)).includes('PVX');
const fastDerive = async (pass, salt) => {
  const base = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};
const E = (o) => M.validateEntry(Object.assign({ date: T }, o));
async function fresh(state) {
  try { P.close('system'); } catch (e) { /* ignore */ }
  S._setAdapter(memAdapter()); S.lock(); await S.init(PASS);
  if (state) await S.replaceState(state);
}

// A marker in every free-text field of every collection of the main state (schema 11).
function fixture() {
  const s = S.defaultState();
  s.categories.expense.push(mk('cat', 40)); s.categories.income.push(mk('icat', 40));
  const ec = s.categories.expense[s.categories.expense.length - 1], ic = s.categories.income[s.categories.income.length - 1];
  s.accounts.push({ id: 'acc1', name: mk('account'), kind: 'cash', liability: false, archived: false });
  s.projects.push({ id: 'p1', name: mk('venture'), kind: 'venture', status: 'active', nextAction: mk('next'), nextDate: '2026-11-01', archived: false },
    { id: 'p2', name: mk('client line'), kind: 'client', status: 'active', nextAction: mk('next2'), archived: false, parentId: 'p1' },
    { id: 'p3', name: mk('archived line'), kind: 'website', status: 'done', nextAction: '', archived: true });
  s.entries.push(
    E({ domain: 'money', type: 'expense', title: mk('expense'), value: 12.5, category: ec, notes: mk('note'), projectId: 'p2' }),
    E({ domain: 'money', type: 'income', title: mk('income'), value: 1000, category: ic, notes: mk('note'), projectId: 'p2' }),
    E({ domain: 'money', type: 'income', title: mk('expected'), value: 400, status: 'expected', dueDate: '2026-11-30', notes: mk('note'), projectId: 'p1' }),
    E({ domain: 'money', type: 'income', title: mk('overdue'), value: 70, status: 'expected', dueDate: '2026-11-01', notes: mk('note') }),
    E({ domain: 'money', type: 'income', title: mk('written off'), value: 55, status: 'written-off', notes: mk('note'), projectId: 'p3' }),
    E({ domain: 'assets', type: 'balance', title: mk('balance'), value: 5000, accountId: 'acc1', notes: mk('note') }),
    E({ domain: 'work', type: 'outcome', title: mk('outcome'), status: 'todo', projectId: 'p1', notes: mk('note') }),
    E({ domain: 'health', type: 'workout', title: mk('workout'), minutes: 30, kind: mk('wkind', 40), notes: mk('note') }),
    E({ domain: 'health', type: 'weight', date: '2026-11-02', title: mk('weight a'), value: 190.37, notes: mk('note') }),
    E({ domain: 'health', type: 'weight', title: mk('weight b'), value: 187.29, notes: mk('note') }),
    E({ domain: 'health', type: 'bodyfat', title: mk('bodyfat'), value: 23.71, notes: mk('note') }),
    E({ domain: 'health', type: 'sleep', title: mk('sleep'), value: 7, notes: mk('note') }),
    E({ domain: 'activities', type: 'session', title: mk('session'), notes: mk('note') }),
    E({ domain: 'social', type: 'contact', title: mk('contact'), person: mk('legacy person', 100), notes: mk('note') }),
    E({ domain: 'learning', type: 'hours', title: mk('hours'), value: 1.3333, notes: mk('note') }),
    E({ domain: 'wellbeing', type: 'mood', title: mk('mood'), value: 2, notes: mk('note') }));
  s.recurring.push({ id: 'r1', title: mk('recurring'), value: 9, category: ec, type: 'expense', cadence: 'monthly', nextDate: '2026-11-12', active: true, household: true, projectId: 'p1' },
    { id: 'r2', title: mk('retainer'), value: 800, category: ic, type: 'income', cadence: 'monthly', nextDate: '2026-12-01', active: true, projectId: 'p2' });
  s.budgets.push({ category: ec, value: 100 });
  s.pipeline.push({ id: 'pl1', title: mk('pipe'), org: mk('org'), kind: 'deal', stage: 'lead', source: mk('src'), nextStep: mk('step'), nextDate: '2026-11-01', updatedAt: '2026-10-01', notes: mk('note') });
  s.goals.push(
    { id: 'g1', title: mk('goal weight'), horizon: 'quarterly', domain: 'health', metric: 'weight', direction: 'down', startValue: 200, targetValue: 170, startDate: '2026-10-01', dueDate: '2026-12-31', state: 'active', notes: mk('note'), createdAt: '2026-10-01' },
    { id: 'g2', title: mk('goal fat'), horizon: 'quarterly', domain: 'health', metric: 'bodyFat', direction: 'down', startValue: 30, targetValue: 18, startDate: '2026-10-01', dueDate: '2026-12-31', state: 'active', notes: mk('note'), createdAt: '2026-10-01' },
    { id: 'g3', title: mk('goal revenue'), horizon: 'monthly', domain: 'work', metric: 'revenueMonth', direction: 'up', startValue: 0, targetValue: 5000, startDate: '2026-11-01', dueDate: '2026-11-30', state: 'active', projectId: 'p1', rollup: true, notes: mk('note'), createdAt: '2026-10-01' },
    { id: 'g4', title: mk('goal manual'), horizon: 'annual', domain: 'wellbeing', metric: 'manual', direction: 'up', startValue: 0, targetValue: 10, manualValue: 3, startDate: '2026-01-01', dueDate: '2026-12-31', state: 'active', notes: mk('note'), createdAt: '2026-01-01' });
  s.kinds.push(mk('kind', 40));
  s.habits.push({ id: 'h1', name: mk('habit', 60) }); s.habitLog.push({ habitId: 'h1', date: T });
  s.properties.push({ id: 'pp1', name: mk('property'), kind: 'house', archived: false });
  s.vehicles.push({ id: 'v1', name: mk('vehicle'), odometerUnit: 'mi', archived: false });
  s.maintenance.push({ id: 'mt1', title: mk('maint'), area: mk('area', 60), cadence: 'quarterly', vendor: mk('vendor'), notes: mk('note'), state: 'done', lastDone: T, cost: 4000, propertyId: 'pp1' },
    { id: 'mt2', title: mk('maint2'), area: '', cadence: 'once', vendor: '', notes: '', state: 'open', nextDue: '2026-11-01', vehicleId: 'v1' });
  s.renewals.push({ id: 'rn1', title: mk('renewal'), kind: 'subscription', provider: mk('provider'), dueDate: '2026-11-12', cadence: 'monthly', autoRenews: true, state: 'open', amount: 1599, notes: mk('note') });
  s.documents.push({ id: 'dc1', title: mk('doc'), kind: mk('dkind', 60), whereKept: mk('where'), notes: mk('note'), expires: '2026-11-20' });
  s.taxItems.push({ id: 'tx1', year: 2025, title: mk('tax'), state: 'needed', notes: mk('note'), dueDate: '2026-11-11' });
  s.learningItems.push({ id: 'li1', title: mk('learn'), kind: 'certification', provider: mk('lprov'), state: 'active', unitLabel: mk('u', 30), totalUnits: 10, doneUnits: 2, expiresOn: '2026-12-01', notes: mk('note'), createdAt: '2026-10-01' });
  s.studySessions.push({ id: 'ss1', itemId: 'li1', date: T, minutes: 40, notes: mk('note') });
  s.takeaways.push({ id: 'tk1', itemId: 'li1', date: T, text: mk('takeaway') });
  s.activityCategories.push(mk('acat', 40));
  const acat = s.activityCategories[s.activityCategories.length - 1];
  s.activities.push(
    { id: 'a1', title: mk('act'), category: acat, state: 'done', date: T, minutes: 90, place: mk('place'), withPeople: [mk('with', 100)], costCents: 2500, returnCents: 4000, worthIt: 4, alsoHealth: true, healthKind: s.kinds[s.kinds.length - 1], alsoSocial: true, notes: mk('note') },
    { id: 'a2', title: mk('act2'), category: 'event', state: 'planned', date: '2026-11-18', endDate: '2026-11-20', place: mk('place2'), withPeople: [], costCents: 700, alsoHealth: false, alsoSocial: false, notes: mk('note') });
  s.groups.push({ id: 'sg1', name: mk('group', 100), cadenceDays: 7 });
  s.people.push({ id: 'sp1', name: mk('person', 100), groupId: 'sg1', cadenceDays: 5, importantDates: [{ label: mk('date label', 100), monthDay: '02-29', year: 1990 }],
    pipelineIds: ['pl1'], projectIds: ['p1'], facts: [{ id: 'sf1', label: mk('fl', 40), text: mk('fact'), addedOn: T }], notes: mk('pnote'), archived: false, createdAt: '2026-10-01' });
  s.contacts.push({ id: 'sc1', personId: 'sp1', date: T, channel: 'in person', notes: mk('cnote') });
  const dg = M.weeklyDigest(S.validateState(clone(S.defaultState())), WK);
  s.memory.reviews.push({ id: 'rv1', weekOf: '2026-11-02', digest: dg, priorities: [mk('prio1'), mk('prio2'), mk('prio3')], completedAt: '2026-11-08T10:00:00Z' });
  s.memory.insights.push(
    { id: 'i1', level: 1, period: { from: WK, to: WE }, domain: 'money', text: mk('proposed insight'), source: 'ai', status: 'proposed', createdAt: T },
    { id: 'i2', level: 1, period: { from: WK, to: WE }, domain: 'work', text: mk('rejected insight'), source: 'ai', status: 'rejected', createdAt: T, decidedAt: T },
    { id: 'i3', level: 1, period: { from: WK, to: WE }, domain: 'wellbeing', text: mk('old wellbeing insight'), source: 'rules', status: 'approved', createdAt: T, decidedAt: T });
  return S.validateState(clone(s));
}
async function ledgerImport(state) {
  const csv = 'Date,Amount,Line,Category,Description,Status,Due\n' +
    `2026-11-03,"$1,250.00","${mk('ledger line')}","${mk('lcat', 40)}","${mk('ledger desc')}",received,\n` +
    `2026-11-04,(30.00),"${mk('ledger line 2')}",,"${mk('ledger desc 2')}",,\n` +
    `2026-11-05,300,,,"${mk('ledger desc 3')}",invoiced,2026-11-25\n`;
  const pl = await R.plan(C.parse(csv), { map: { date: 0, amount: 1, line: 2, category: 3, description: 4, status: 5, due: 6 } }, state, T);
  return pl;
}

// Harness only (v1.0.0): the fast key derivation applies to this file's tests alone (it was set for the whole process before), and
// the describe block keeps them from running ahead of other files' first tests in the shared process that test/index.js uses.
// Harness only: yield once so test/index.js registers these after the other files' first top-level tests (store.test.mjs checks
// that no storage adapter exists before any test installs one).
await new Promise((r) => setTimeout(r, 0));
describe('privacy review proofs (PV)', () => {
let ORIG = null;
before(() => { ORIG = L.vault.deriveKey; L.vault.deriveKey = fastDerive; });
after(() => { L.vault.deriveKey = ORIG; try { P.close('system'); } catch (e) { /* ignore */ } });

test('privacy: no free text from any collection, the ledger import, private records or wellbeing reaches a prompt, the digest, rules insights or the audit log', async () => {
  await fresh(fixture());
  const pl = await ledgerImport(S.getState());
  assert.equal(pl.add.length, 3);
  await S.commit((x) => { R.applyPlan(x, pl); });
  await P.setUp(PRIV);
  // Private records with their own markers, a person and a project moved in with children, and a wellbeing check-in.
  await P.write((x) => {
    x.entries.push(E({ domain: 'money', type: 'income', title: mk('private income'), value: 777, notes: mk('pnote') }));
    x.projects.push({ id: 'pp9', name: mk('private line'), kind: 'client', status: 'active', nextAction: mk('pnext'), archived: false });
    x.people.push({ id: 'spp', name: mk('private person', 100), importantDates: [], pipelineIds: [], projectIds: [], facts: [], notes: mk('pn'), archived: false });
  }, { newPrivate: true });
  await P.moveIn('people', 'sp1', { children: true });
  await P.moveIn('projects', 'p2', { children: true });
  await P.commit((i) => { if (!i.wellbeing) i.wellbeing = {}; L.wellbeing.save(i.wellbeing, { date: T, mood: 1, mental: 5, intimacy: 2, note: mk('wellbeing note') }); });
  assert.ok(P.isOpen());
  const view = P.view(S.getState()), main = S.getState();
  assert.ok(has(view), 'the open view does hold the markers');
  const outs = [];
  for (const st of [view, main]) {
    outs.push(M.weeklyDigest(st, WK), Mem.rulesInsights(st, WK));
    outs.push(Mem.buildPrompt(st, 1, { from: WK, to: WE }), Mem.buildPrompt(st, 2, { from: '2026-11-01', to: '2026-11-30' }), Mem.buildPrompt(st, 3, { from: '2026-10-01', to: '2026-12-31' }));
  }
  // Digest numbers are the same whether the open view or the main state is passed: private records never count.
  assert.deepEqual(M.weeklyDigest(view, WK), M.weeklyDigest(main, WK));
  // Rules insights proposed and approved by a tap, then the prompts again.
  const items = Mem.rulesInsights(main, WK);
  await P.write((x) => { Mem.propose(x, items, { level: 1, period: { from: WK, to: WE }, source: 'rules' }); });
  const ids = S.getState().memory.insights.filter((i) => i.status === 'proposed' && i.source === 'rules').map((i) => i.id);
  await P.write((x) => { for (const id of ids) Mem.decide(x, id, 'approved'); });
  const p1 = Mem.buildPrompt(S.getState(), 1, { from: WK, to: WE }), p2 = Mem.buildPrompt(S.getState(), 2, { from: '2026-11-01', to: '2026-11-30' });
  outs.push(p1, p2, S.getState().audit);
  for (const o of outs) assert.ok(!has(o), 'marker leaked: ' + JSON.stringify(o).slice(0, 300));
  for (const p of [p1, p2]) {
    const all = p.system + '\n' + p.user;
    assert.ok(!/wellbeing/i.test(all), 'wellbeing named in a prompt');
    assert.ok(!/Weight moved/.test(all) && !all.includes('187.29') && !all.includes('190.37') && !all.includes('23.71'), 'body metric in a prompt');
    assert.ok(!all.includes('777'), 'a private amount reached a prompt');
  }
  // PV-9 fixed (owner rule): the weight rule no longer exists, so no rules insight states a body metric (legacy stored ones are
  // still excluded from prompts; see SEC-32 in test/v050-audit.test.mjs).
  assert.ok(!items.some((i) => /weight/i.test(i.text)), 'no weight rules insight (PV-9)');
  // Goals detail counts leave out the weight and body fat goals (2 of the 4 goals are body goals).
  assert.match(p1.user, /goals detail: active 2,/);
  P.close('system');
});

test('privacy: thrown errors never echo typed text, provider replies or secrets', async () => {
  await fresh(fixture());
  const st = clone(S.getState());
  const msgs = [];
  const grab = (f) => { try { f(); msgs.push('NO THROW'); } catch (e) { msgs.push(String(e && e.message)); } };
  const grabA = async (f) => { try { await f(); msgs.push('NO THROW'); } catch (e) { msgs.push(String(e && e.message)); } };
  grab(() => M.validateEntry({ domain: 'money', type: 'expense', date: 'nope ' + mk('d'), title: mk('t'), value: 1 }));
  grab(() => M.validateEntry({ domain: 'money', type: 'expense', date: T, title: mk('t') + 'x'.repeat(300), value: 1 }));
  grab(() => M.validateEntry({ domain: 'health', type: 'weight', date: T, title: 'w', value: '1874.2 ' + mk('v') }));
  grab(() => A.addActivity(st, { title: mk('a'), place: mk('p') + ' 4111 1111 1111 1111' }, T));
  grab(() => A.addActivity(st, { title: mk('a'), category: mk('nocat') }, T));
  grab(() => L.social.addPerson(st, { name: st.people[0].name }));
  grab(() => L.social.addFact(st, 'sp1', { label: mk('l', 40), text: '123-45-6789 ' + mk('x') }, T));
  grab(() => L.learning.addTakeaway(st, { text: mk('t') + ' 4111111111111111' }, T));
  grab(() => L.wellbeing.save({}, { date: T, note: mk('n') + ' 123-45-6789' }));
  grab(() => L.goals.addGoal(st, { title: mk('g'), horizon: mk('h') }, T));
  grab(() => Mem.parseResponse('[{"domain":"' + mk('d') + '","text":"x"}]'));
  grab(() => Mem.parseResponse(mk('not json')));
  grab(() => S.validateState(Object.assign(clone(st), { projects: [{ id: 'z', name: mk('n') + 'y'.repeat(300), kind: 'client', status: 'active', nextAction: '', archived: false }] })));
  const bad = 'Date,Amount,Description\n2026-11-03,10,"' + mk('d') + ' 4111 1111 1111 1111"\n' + mk('nodate') + ',5,x\n2026-11-03,' + mk('amt') + ',x\n2026-11-03,5,"' + 'z'.repeat(201) + mk('long') + '"\n';
  const pl = await R.plan(C.parse(bad), { map: { date: 0, amount: 1, description: 2 } }, st, T);
  assert.equal(pl.rejected.length, 4);
  msgs.push(JSON.stringify(pl.rejected));
  const prov = { kind: 'local', baseUrl: 'http://localhost:11434/v1', model: 'm', apiKey: 'sk-secret-key-123' };
  await grabA(() => L.ai.complete(prov, { system: 's', user: 'u' }, async () => { throw new Error(mk('net') + ' sk-secret-key-123'); }));
  const body = (t) => ({ ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => { let d = false; return { read: async () => (d ? { done: true } : (d = true, { done: false, value: new TextEncoder().encode(t) })), cancel: async () => {} }; } } });
  await grabA(() => L.ai.complete(prov, { system: 's', user: 'u' }, async () => body(mk('html page'))));
  await grabA(() => L.ai.complete(prov, { system: 's', user: 'u' }, async () => ({ ok: false, status: 500, headers: { get: () => null }, body: null, statusText: mk('st') })));
  await P.setUp(PRIV); P.close('system');
  await grabA(() => P.open('wrong ' + mk('pass')));
  for (const m of msgs) {
    assert.ok(m !== 'NO THROW', 'expected a throw: ' + msgs.indexOf(m));
    assert.ok(!has(m) && !m.includes('sk-secret') && !m.includes('4111') && !m.includes('6789') && !m.includes('1874'), 'error echoed input: ' + m);
  }
});

test('AI never has the final say: replies, rules and pasted text only ever create proposed insights', () => {
  const st = S.validateState(clone(S.defaultState()));
  const items = Mem.parseResponse('[{"domain":"money","text":"x","status":"approved","source":"rules","level":3}]');
  assert.deepEqual(Object.keys(items[0]).sort(), ['domain', 'text']);
  Mem.propose(st, items, { level: 1, period: { from: WK, to: WE }, source: 'ai' });
  Mem.propose(st, [{ domain: 'money', text: 'y', status: 'approved' }], { level: 1, period: { from: WK, to: WE }, source: 'rules' });
  assert.ok(st.memory.insights.every((i) => i.status === 'proposed'));
  assert.throws(() => Mem.parseResponse('[{"domain":"wellbeing","text":"x"}]'), /unknown domain/);
  assert.throws(() => Mem.propose(st, [{ domain: 'wellbeing', text: 'x' }], { level: 1, period: { from: WK, to: WE }, source: 'ai' }));
});

// Seeded PRNG so the money check is repeatable.
function rng(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
test('money integrity: per-line totals plus Unassigned equal Money totals exactly for every month and period, with sub-cent values, statuses and links', () => {
  const r = rng(12345), s = S.defaultState();
  s.projects.push({ id: 'v', name: 'V', kind: 'venture', status: 'active', nextAction: '', archived: false }, { id: 'c', name: 'C', kind: 'client', status: 'active', nextAction: '', archived: false, parentId: 'v' },
    { id: 'x', name: 'X', kind: 'website', status: 'done', nextAction: '', archived: true }, { id: 'y', name: 'Y', kind: 'podcast', status: 'active', nextAction: '', archived: false });
  const pids = ['v', 'c', 'x', 'y', undefined, 'ghost'];
  for (let i = 0; i < 600; i++) {
    const type = r() < 0.5 ? 'income' : 'expense', d = M.addDays('2025-12-20', Math.floor(r() * 400));
    const o = { domain: 'money', type, date: d, title: 't' + i, value: Math.floor(r() * 1e7) / 1000 };
    const p = pids[Math.floor(r() * pids.length)]; if (p) o.projectId = p;
    if (type === 'income') { const q = r(); if (q < 0.15) o.status = 'expected'; else if (q < 0.25) o.status = 'written-off'; else if (q < 0.4) o.status = 'received'; }
    s.entries.push(E(o));
  }
  const st = S.validateState(clone(s));
  for (let m = 0; m < 14; m++) {
    const mo = M.addMonths('2025-12', m), from = mo + '-01', to = M.monthEnd(mo);
    const rep = R.report(st, { from, to }), mv = M.monthView(st, mo);
    assert.equal(rep.total.revenueCents, mv.incomeCents, mo); assert.equal(rep.total.expenseCents, mv.spendCents, mo);
    const lines = rep.lines.reduce((a, l) => [a[0] + l.revenueCents, a[1] + l.expenseCents], [rep.unassigned.revenueCents, rep.unassigned.expenseCents]);
    assert.deepEqual(lines, [rep.total.revenueCents, rep.total.expenseCents]);
    assert.ok(Number.isInteger(rep.total.revenueCents) && Number.isInteger(rep.total.netCents));
    for (const l of rep.lines.concat(rep.rollups, [rep.unassigned, rep.total])) assert.ok(l.marginBp === null || Number.isInteger(l.marginBp));
  }
  for (const k of ['month', 'lastMonth', 'qtd', 'ytd', 't12']) for (const today of ['2026-01-01', '2026-02-28', '2028-02-29', '2026-03-31', '2026-12-31']) {
    const p = R.periodRange(k, today), rep = R.report(st, p), t = R.totalsIn(st, { kind: 'all' }, p.from, p.to);
    assert.equal(rep.total.revenueCents, t.revenueCents); assert.equal(rep.total.expenseCents, t.expenseCents);
  }
});

test('money integrity: an activity cost reaches Money once, only on a tap; skip, delete and edits never double count or lose it', () => {
  const s = S.defaultState();
  s.activities.push({ id: 'a', title: 'Gig', category: 'event', state: 'planned', date: '2026-11-20', place: '', withPeople: [], costCents: 4550, alsoHealth: false, alsoSocial: false, notes: '' });
  const st = S.validateState(clone(s));
  const spend = () => M.monthView(S.validateState(clone(st)), '2026-11').spendCents;
  assert.equal(spend(), 0);
  assert.throws(() => A.createExpense(st, 'a'), /paid or done/);
  A.markPaid(st, 'a', '2026-11-05');
  assert.equal(spend(), 0, 'marking paid does not post');
  A.createExpense(st, 'a');
  assert.throws(() => A.createExpense(st, 'a'), /already/);
  assert.equal(spend(), 4550);
  A.markDone(st, 'a'); assert.equal(A.expenseOffer(st, 'a'), null, 'done after paid offers nothing more');
  A.updateActivity(st, 'a', { cost: '50.00' }); assert.equal(spend(), 5000, 'an edit moves the one expense');
  A.markSkipped(st, 'a'); assert.equal(spend(), 5000, 'skipping keeps the expense');
  A.deleteActivity(st, 'a'); assert.equal(spend(), 5000, 'deleting the activity keeps the expense');
});

// ---------------------------------------------------------------- proof tests for findings (expected to fail until fixed)

test('PV-1: re-importing a ledger while the private vault is closed must not add rows already imported and moved into the vault', async () => {
  await fresh();
  const csv = 'Date,Amount,Line,Description\n2026-11-02,500.00,Client A,Invoice one\n2026-11-03,-20.00,Client A,Fees\n';
  const opts = { map: { date: 0, amount: 1, line: 2, description: 3 }, create: ['Client A'] };
  let pl = await R.plan(C.parse(csv), opts, S.getState(), T);
  await S.commit((x) => { R.applyPlan(x, pl); });
  await P.setUp(PRIV);
  await P.moveIn('projects', S.getState().projects[0].id, { children: true });
  P.close();
  // The UI plans against st(), which is the main state while the vault is closed.
  pl = await R.plan(C.parse(csv), opts, S.getState(), T);
  await S.commit((x) => { R.applyPlan(x, pl); });
  await P.open(PRIV);
  const v = P.view(S.getState()), rep = R.report(v, { from: '2026-11-01', to: '2026-11-30' });
  P.close('system');
  assert.equal(rep.total.revenueCents, 50000, 'revenue counted twice after the re-import');
  assert.equal(v.projects.length, 1, 'a second line of work with the same name was created');
});

test('PV-2: a ledger preview made while the vault is open keeps its line of work when the vault auto-locks before Import', async () => {
  await fresh();
  await S.commit((x) => { x.projects.push({ id: 'pA', name: 'Client A', kind: 'client', status: 'active', nextAction: '', archived: false }); });
  await P.setUp(PRIV);
  await P.moveIn('projects', 'pA', { children: true });
  const pl = await R.plan(C.parse('Date,Amount,Line,Description\n2026-11-02,500.00,Client A,Invoice one\n'), { map: { date: 0, amount: 1, line: 2, description: 3 } }, P.view(S.getState()), T);
  assert.equal(pl.add[0].entry.projectId, 'pA');
  P.close(); // auto-lock timer fires while the preview is on screen
  await P.write((x) => { R.applyPlan(x, pl); });
  await P.open(PRIV);
  const rep = R.report(P.view(S.getState()), { from: '2026-11-01', to: '2026-11-30' });
  P.close('system');
  assert.equal(rep.lines.find((l) => l.id === 'pA').revenueCents, 50000, 'the income silently became Unassigned');
});

test('PV-3: the domain CSV import must not read a decimal comma as a thousands separator', () => {
  const p = C.parse('date,title,value\n2026-11-02,Groceries,"12,50"\n2026-11-03,Rent,"1.234,56"\n');
  const r = C.toEntries(p, { domain: 'money', type: 'expense', map: { date: 'date', title: 'title', value: 'value' } });
  for (const e of r.entries) assert.ok(e.value === 12.5 || e.value === 1234.56, 'imported ' + e.title + ' as ' + e.value);
});

test('PV-4: a monthly recurring item due on the 31st keeps its day of the month', () => {
  const s = S.defaultState();
  s.recurring.push({ id: 'r', title: 'Rent', value: 1500, category: '', type: 'expense', cadence: 'monthly', nextDate: '2026-01-31', active: true });
  const st = S.validateState(clone(s));
  const dates = [];
  for (let i = 0; i < 3; i++) dates.push(M.confirmRecurring(st, 'r', '2026-12-31').date);
  assert.deepEqual(dates, ['2026-01-31', '2026-02-28', '2026-03-31']);
});

test('PV-5: the secrets guard catches an SSN or card number written with slashes, underscores or doubled dashes', () => {
  for (const s of ['SSN 123/45/6789', 'card 4111/1111/1111/1111', 'card 4111_1111_1111_1111', 'ssn 123--45--6789', 'card 4111 - - 1111 1111 1111'])
    assert.ok(L.admin.looksSecret(s), s);
});

test('PV-6: a rejection reason holding a card number or a name is not sent verbatim to the AI provider', () => {
  const st = S.validateState(clone(S.defaultState()));
  Mem.propose(st, [{ domain: 'money', text: 'Savings rate this week was 10%.' }], { level: 1, period: { from: WK, to: WE }, source: 'rules' });
  Mem.decide(st, st.memory.insights[0].id, 'rejected', 'PVX probe Jane Doe card 4111 1111 1111 1111');
  const p = Mem.buildPrompt(st, 1, { from: WK, to: WE });
  assert.ok(!p.user.includes('4111'), 'card number in the prompt');
  assert.ok(!has(p.user), 'typed reason (with a person name) sent verbatim');
});

test('PV-7: a Money CSV export and re-import does not turn written-off or expected income into received actuals', () => {
  const ents = [E({ domain: 'money', type: 'income', date: '2026-11-02', title: 'Bad debt', value: 900, status: 'written-off' }), E({ domain: 'money', type: 'income', date: '2026-11-03', title: 'Invoice', value: 100, status: 'expected', dueDate: '2026-12-01', category: 'Business' })];
  const p = C.parse(C.exportEntries(ents));
  let r;
  try { r = C.toEntries(p, { domain: 'money', type: 'income', map: { date: 'date', title: 'title', value: 'value', status: 'status' } }); } catch (e) { r = C.toEntries(p, { domain: 'money', type: 'income', map: { date: 'date', title: 'title', value: 'value' } }); }
  const s = S.defaultState(); s.entries = r.entries;
  assert.equal(M.monthView(S.validateState(s), '2026-11').incomeCents, 0);
});

test('PV-8: an approved weekly insight from a week that spans two months is offered to a monthly consolidation', () => {
  const st = S.validateState(clone(S.defaultState()));
  const wk = { from: '2026-10-26', to: '2026-11-01' };
  Mem.propose(st, [{ domain: 'money', text: 'Boundary week insight 314.' }], { level: 1, period: wk, source: 'rules' });
  Mem.decide(st, st.memory.insights[0].id, 'approved');
  const oct = Mem.buildPrompt(st, 2, { from: '2026-10-01', to: '2026-10-31' }).user, nov = Mem.buildPrompt(st, 2, { from: '2026-11-01', to: '2026-11-30' }).user;
  assert.ok(oct.includes('Boundary week insight 314') || nov.includes('Boundary week insight 314'));
});

test('PV-9: rules insights never state a body metric value or change (owner rule; SPEC v0.5 allows it, needs a decision)', () => {
  const s = S.defaultState();
  s.entries.push(E({ domain: 'health', type: 'weight', date: '2026-11-02', title: 'w', value: 190.37 }), E({ domain: 'health', type: 'weight', date: T, title: 'w', value: 187.29 }));
  const items = Mem.rulesInsights(S.validateState(clone(s)), WK);
  assert.ok(!items.some((i) => /weight/i.test(i.text)), items.map((i) => i.text).join(' | '));
});

test('PV-10: ledger rows whose description holds a 9-digit invoice, order or payout number are not refused as secrets', async () => {
  const st = S.validateState(clone(S.defaultState()));
  const csv = 'Date,Amount,Description\n2026-11-03,100,INV-202611042\n2026-11-04,50,Order 100234567\n2026-11-05,75,Stripe payout po_123456789\n';
  const pl = await R.plan(C.parse(csv), { map: { date: 0, amount: 1, description: 2 } }, st, T);
  assert.equal(pl.rejected.length, 0, JSON.stringify(pl.rejected));
});
});
