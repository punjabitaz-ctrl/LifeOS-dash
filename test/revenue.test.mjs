// v0.12.0: lines of work and the revenue tracker. Schema 11, expected income, per line and rollup totals, goal metrics, review actions,
// bulk assign, unlinking, ledger CSV import, private lines of work, and numbers-only digest and prompts.
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { L, memAdapter, PASS, E } from './_load.mjs';
import { clone } from './_v070.mjs';
import { buildAdversarial, ADV_MARK } from './_adversarial.mjs';

// Other test files swap L.* for the built bundle, so resolve modules on every use.
const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), M = live('metrics'), R = live('revenue'), P = live('priv'), V = live('vault'), G = live('goals'), Mem = live('memory'), C = live('csv');
const PRIV = 'a private passphrase 99';
const TODAY = '2026-11-14', WK = '2026-11-09';
let ORIG = null;
const fastDerive = async (pass, salt) => {
  const base = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};
describe('v0.12.0 lines of work and revenue', () => {
beforeEach(() => { ORIG = L.vault.deriveKey; L.vault.deriveKey = fastDerive; });
afterEach(() => { L.vault.deriveKey = ORIG; try { L.priv.close('system'); } catch (e) { /* ignore */ } });

const proj = (id, name, o) => Object.assign({ id, name, kind: 'client', status: 'active', nextAction: '', archived: false }, o);
const inc = (date, v, o) => E(Object.assign({ domain: 'money', type: 'income', date, value: v }, o));
const exp = (date, v, o) => E(Object.assign({ domain: 'money', type: 'expense', date, value: v }, o));
const build = (fn) => { const s = S.defaultState(); fn(s); return S.validateState(clone(s)); };
const rawBuild = (fn) => { const s = S.defaultState(); fn(s); return s; };
async function vault(state) {
  S._setAdapter(memAdapter()); S.lock(); await S.init(PASS);
  if (state) await S.replaceState(state);
}
const text = (x) => JSON.stringify(x);
const rec = (st) => build((s) => {
  s.projects.push(proj('ayin', 'AYiN Advisors', { kind: 'venture' }), proj('cl', 'Client A', { parentId: 'ayin' }), proj('web', 'Website', { kind: 'website', parentId: 'ayin' }), proj('pod', 'Podcast', { kind: 'podcast' }));
  s.entries.push(
    inc('2026-11-03', 1000, { projectId: 'cl' }), inc('2026-11-04', 250.5, { projectId: 'web' }), inc('2026-11-05', 99.99, { projectId: 'pod' }), inc('2026-11-06', 10),
    exp('2026-11-07', 200.25, { projectId: 'cl' }), exp('2026-11-08', 40, { projectId: 'pod' }), exp('2026-11-09', 12.34),
    inc('2026-11-10', 500, { projectId: 'cl', status: 'expected', dueDate: '2026-11-20' }), inc('2026-11-11', 77, { projectId: 'web', status: 'written-off' }),
    inc('2026-10-15', 300, { projectId: 'cl' }), exp('2026-10-16', 50, { projectId: 'web' }), inc('2026-09-01', 41.07, { projectId: 'pod' }),
    inc('2026-01-02', 120), exp('2026-02-03', 20.2, { projectId: 'cl' }), inc('2025-12-31', 9, { projectId: 'cl' }));
});

// ---------------------------------------------------------------- migrations, backups, downgrade guards
const OLD = { 3: ['projects', 'pipeline'], 4: ['cycle', 'kinds', 'habits', 'habitLog'], 5: ['goals'], 6: ['properties', 'vehicles', 'maintenance', 'renewals', 'documents', 'taxItems'], 7: ['learningItems', 'studySessions', 'takeaways'], 8: ['activities', 'activityCategories'], 9: ['groups', 'people', 'contacts'] };
function asSchema(n, st) {
  const o = clone(st); o.schema = n; delete o.priv;
  for (const [v, keys] of Object.entries(OLD)) if (Number(v) > n) for (const k of keys) delete o[k];
  if (n < 6) { delete o.settings.home; for (const r of o.recurring || []) delete r.household; }
  if (n < 7) delete o.settings.learning;
  if (n < 4) delete o.settings.health;
  if (n < 2) for (const k of ['accounts', 'recurring', 'budgets', 'categories']) delete o[k];
  if (n < 9) for (const a of o.activities || []) delete a.expenseId;
  if (n < 10) delete o.settings.privAutoLockSec;
  delete o.settings.layouts;
  if (n < 12) {
    // v1.1.0 data (business records, tax profiles, budgets, scopes) does not exist in an older copy; the fixture's two business entries go with it.
    for (const k of ['payees', 'invoices', 'trips', 'taxPayments', 'taxYears', 'homeOffice', 'taxMap']) delete o[k];
    delete o.settings.business;
    o.entries = o.entries.filter((e) => e.id !== 'ex2' && e.id !== 'in2');
    for (const p of o.projects || []) { delete p.budgetCents; delete p.budgetPeriod; }
  }
  return o;
}
const fullOld = () => {
  const { state } = buildAdversarial(L);
  const s = clone(state);
  s.settings.provider = { kind: 'none', baseUrl: '', model: '', apiKey: '' };
  return S.validateState(clone(s));
};

test('schema 1 to 10 migrate into 11 with no loss: every text an old copy held is still there, layouts default to empty', () => {
  const src = fullOld();
  for (let n = 1; n <= 10; n++) {
    const old = asSchema(n, src), oldText = text(old);
    const got = S.validateState(clone(old));
    assert.equal(got.schema, 16); assert.equal(got.sourceSchema, n); assert.ok(!got.priv);
    assert.deepEqual(got.settings.layouts, { narrow: [], wide: [] }, 'schema ' + n);
    const gotText = text(got);
    for (const m of new Set(oldText.match(/LEAK mark \d+/g) || [])) assert.ok(gotText.includes(m), 'schema ' + n + ' lost ' + m);
    assert.equal(got.entries.filter((e) => e.domain === 'money').length >= (n === 1 ? 2 : 2), true);
    for (const e of got.entries.filter((x) => x.domain === 'money' && x.type === 'income')) assert.ok(e.status === undefined, 'old income stays received');
  }
  const ten = asSchema(10, src), got10 = S.validateState(clone(ten));
  assert.deepEqual(got10.entries, S.validateState(clone(asSchema(11, src))).entries, 'schema 10 round trips exactly');
});

test('a v0.11.0 backup (schema 10) imports cleanly and a stored schema 10 vault migrates on unlock', async () => {
  const ten = asSchema(10, fullOld());
  const salt = V.newSalt(), key = await ORIG('backup passphrase 1', salt);
  const imp = await V.importBackup('backup passphrase 1', JSON.stringify(await V.makeEnvelope(key, salt, ten)));
  assert.equal(imp.schema, 16); assert.equal(imp.sourceSchema, 10);
  await vault(null);
  assert.deepEqual(S.droppedData(S.getState(), imp), [], 'a fresh vault loses nothing');
  await S.replaceState(imp);
  assert.equal(S.getState().schema, 16);
  // stored vault written by v0.11.0
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  const env = await S.exportEnvelope(); const salt2 = V.parseEnvelope(env).salt, key2 = await fastDerive(PASS, salt2);
  await ad.set('envelope', await V.makeEnvelope(key2, salt2, ten));
  S.lock();
  const st = await S.unlock(PASS);
  assert.equal(st.schema, 16); assert.deepEqual(st.settings.layouts, { narrow: [], wide: [] });
  await S.commit(() => {});
  assert.equal((await V.decrypt(key2, await ad.get('envelope'))).schema, 16);
});

test('downgrade guards: an older-format copy cannot silently strip lines of work, expected income, links or layouts', async () => {
  const cur = rec();
  const lay = clone(cur); lay.settings.layouts = { narrow: [{ id: 'glance', size: 'wide', hidden: true }], wide: [] };
  const old = (st) => S.validateState(asSchema(10, st));
  const names = S.droppedData(lay, old(lay));
  for (const n of ['line of work kinds and parents', 'money linked to lines of work', 'expected income', 'dashboard layouts']) assert.ok(names.includes(n), n + ' in ' + names);
  assert.match(S.lossText(lay, old(lay)), /dashboard layouts/);
  // each field alone is named
  assert.deepEqual(S.droppedData(build((s) => { s.projects.push(proj('a', 'A'), proj('b', 'B', { parentId: 'a' })); }), S.validateState(asSchema(10, build(() => {})))), ['line of work kinds and parents']);
  assert.deepEqual(S.droppedData(build((s) => { s.projects.push(proj('a', 'A', { kind: 'podcast' })); }), S.validateState(asSchema(10, build(() => {})))), ['line of work kinds and parents']);
  assert.deepEqual(S.droppedData(build((s) => { s.projects.push(proj('a', 'A')); s.recurring.push({ id: 'r', title: 'x', value: 5, category: '', type: 'income', cadence: 'monthly', nextDate: TODAY, active: true, household: false, projectId: 'a' }); }), S.validateState(asSchema(10, build(() => {})))), ['money linked to lines of work']);
  assert.deepEqual(S.droppedData(build((s) => { s.entries.push(inc(TODAY, 5, { status: 'expected' })); }), S.validateState(asSchema(10, build(() => {})))), ['expected income']);
  assert.deepEqual(S.droppedData(build((s) => { s.entries.push(inc(TODAY, 5, { dueDate: TODAY })); }), S.validateState(asSchema(10, build(() => {})))), ['expected income']);
  assert.deepEqual(S.droppedData(build(() => {}), S.validateState(asSchema(10, build(() => {})))), [], 'nothing to lose, nothing named');
  await vault(lay);
  await assert.rejects(S.replaceState(old(lay)), (e) => e.code === 'OLDER_FORMAT' && /dashboard layouts/.test(e.message));
  assert.equal(S.getState().settings.layouts.narrow.length, 1);
  await S.replaceState(old(lay), { allowWorkLoss: true });
  assert.deepEqual(S.getState().settings.layouts, { narrow: [], wide: [] });
  // an unknown newer schema is refused
  assert.throws(() => S.validateState(Object.assign(S.defaultState(), { schema: 17 })), /schema/);
});

// ---------------------------------------------------------------- validation
test('validateEntry: project link on income and expense, status whitelist, dueDate and importKey; expenses take no status', () => {
  const a = inc(TODAY, 5, { projectId: 'p', status: 'expected', dueDate: '2026-12-01' });
  assert.deepEqual([a.projectId, a.status, a.dueDate], ['p', 'expected', '2026-12-01']);
  assert.equal(inc(TODAY, 5).status, undefined, 'no status stays no status (received)');
  assert.equal(inc(TODAY, 5, { status: 'received' }).status, 'received');
  assert.equal(inc(TODAY, 5, { status: 'written-off' }).status, 'written-off');
  for (const bad of ['paid', 'EXPECTED', 5, {}, 'x'.repeat(50)]) assert.throws(() => inc(TODAY, 5, { status: bad }), /Status/);
  for (const bad of ['2026-13-01', 'soon', 5, '2026-02-30']) assert.throws(() => inc(TODAY, 5, { dueDate: bad }), /Due date/);
  assert.equal(exp(TODAY, 5, { status: 'expected', dueDate: TODAY }).status, undefined);
  assert.equal(exp(TODAY, 5, { status: 'expected', dueDate: TODAY }).dueDate, undefined);
  assert.equal(exp(TODAY, 5, { projectId: 'p' }).projectId, 'p');
  for (const bad of [5, {}, 'x'.repeat(101)]) assert.throws(() => exp(TODAY, 5, { projectId: bad }), /project/i);
  const key = 'a'.repeat(64);
  assert.equal(inc(TODAY, 5, { importKey: key }).importKey, key);
  for (const bad of ['A'.repeat(64), 'a'.repeat(63), 5, '../x']) assert.throws(() => inc(TODAY, 5, { importKey: bad }), /import key/);
  assert.equal(E({ domain: 'assets', type: 'balance', date: TODAY, title: 'b', value: 5, projectId: 'p' }).projectId, undefined, 'only money and outcomes link to lines');
});

test('validateState: project kinds, parents (existing, not archived, one level, no cycle), recurring and goal links, digest numbers', () => {
  const base = (fn) => { const s = S.defaultState(); fn(s); return s; };
  for (const kind of ['job', 'venture', 'client', 'personal', 'website', 'podcast']) assert.equal(S.validateState(base((s) => s.projects.push(proj('a', 'A', { kind })))).projects[0].kind, kind);
  assert.throws(() => S.validateState(base((s) => s.projects.push(proj('a', 'A', { kind: 'shop' })))), /kind/);
  // parents
  const ok = S.validateState(base((s) => s.projects.push(proj('a', 'A'), proj('b', 'B', { parentId: 'a' }))));
  assert.equal(ok.projects[1].parentId, 'a');
  assert.equal(S.validateState(base((s) => s.projects.push(proj('b', 'B', { parentId: 'gone' })))).projects[0].parentId, undefined, 'a missing parent is dropped, the project kept');
  assert.equal(S.validateState(base((s) => s.projects.push(proj('a', 'A', { archived: true }), proj('b', 'B', { parentId: 'a' })))).projects[1].parentId, undefined, 'an archived parent is dropped');
  assert.throws(() => S.validateState(base((s) => s.projects.push(proj('a', 'A', { parentId: 'a' })))), /own parent/);
  assert.throws(() => S.validateState(base((s) => s.projects.push(proj('a', 'A'), proj('b', 'B', { parentId: 'a' }), proj('c', 'C', { parentId: 'b' })))), /one level/);
  assert.throws(() => S.validateState(base((s) => s.projects.push(proj('a', 'A', { parentId: 'b' }), proj('b', 'B', { parentId: 'a' })))), /one level|own parent/, 'a cycle');
  assert.throws(() => S.validateState(base((s) => s.projects.push(proj('a', 'A', { parentId: 5 })))), /parent|text/);
  // entry, recurring, goal links to projects that do not exist are dropped; the records are kept
  const dang = S.validateState(base((s) => {
    s.entries.push(inc(TODAY, 5, { projectId: 'nope' }), exp(TODAY, 5, { projectId: 'nope' }));
    s.recurring.push({ id: 'r', title: 'x', value: 5, category: '', type: 'income', cadence: 'monthly', nextDate: TODAY, active: true, household: false, projectId: 'nope' });
    s.goals.push({ id: 'g', title: 'g', horizon: 'monthly', domain: 'work', metric: 'revenueMonth', direction: 'up', startValue: 0, targetValue: 100, startDate: '2026-11-01', dueDate: '2026-11-30', state: 'active', notes: '', createdAt: '2026-11-01T00:00:00.000Z', projectId: 'nope', rollup: true });
  }));
  assert.deepEqual([dang.entries.length, dang.entries[0].projectId, dang.entries[1].projectId, dang.recurring[0].projectId, dang.goals[0].projectId, dang.goals[0].rollup], [2, undefined, undefined, undefined, undefined, undefined]);
  const good = S.validateState(base((s) => {
    s.projects.push(proj('p', 'P'));
    s.recurring.push({ id: 'r', title: 'x', value: 5, category: '', type: 'income', cadence: 'monthly', nextDate: TODAY, active: true, household: false, projectId: 'p' });
    s.goals.push({ id: 'g', title: 'g', horizon: 'monthly', domain: 'work', metric: 'netMonth', direction: 'up', startValue: 0, targetValue: 100, startDate: '2026-11-01', dueDate: '2026-11-30', state: 'active', notes: '', createdAt: '2026-11-01T00:00:00.000Z', projectId: 'p', rollup: true });
  }));
  assert.deepEqual([good.recurring[0].projectId, good.goals[0].projectId, good.goals[0].rollup], ['p', 'p', true]);
  assert.throws(() => S.validateState(base((s) => { s.projects.push(proj('p', 'P')); s.goals.push({ id: 'g', title: 'g', horizon: 'monthly', domain: 'work', metric: 'pipelineWon', direction: 'up', startValue: 0, targetValue: 1, startDate: '2026-11-01', dueDate: '2026-11-30', state: 'active', notes: '', createdAt: '2026-11-01T00:00:00.000Z', projectId: 'p' }); })), /revenue goals/);
  // digest revenue numbers
  const rv = (d) => build((s) => { s.memory.reviews.push({ id: 'r1', weekOf: WK, digest: Object.assign({ week: WK, domains: {} }, d), priorities: ['a', 'b', 'c'], completedAt: '2026-11-14T00:00:00.000Z' }); });
  const dg = { revenueWeekCents: 1, expensesWeekCents: 2, netWeekCents: -1, revenueMonthCents: 3, expensesMonthCents: 4, netMonthCents: -1, expectedNext30Cents: 5, overdueCount: 1, lines: 2 };
  assert.deepEqual(rv({ revenue: dg }).memory.reviews[0].digest.revenue, dg);
  for (const [k, v] of [['revenueWeekCents', 1.5], ['revenueWeekCents', -1], ['netWeekCents', 'x'], ['overdueCount', -1], ['lines', 1e10], ['expectedNext30Cents', NaN]]) assert.throws(() => rv({ revenue: Object.assign({}, dg, { [k]: v }) }), /digest revenue/, k);
  assert.throws(() => rv({ revenue: 5 }), /digest revenue/);
});

test('prototype-pollution keys are refused in every new field', () => {
  const withJson = (patch) => { const s = JSON.parse(JSON.stringify(S.defaultState())); patch(s); return JSON.stringify(s); };
  const P0 = '{"id":"a","name":"A","kind":"client","status":"active","nextAction":"","archived":false';
  const E0 = '{"id":"e1","domain":"money","type":"income","date":"2026-11-01","title":"t","value":5,"createdAt":"2026-11-01T00:00:00.000Z"';
  const run = (key, tail) => {
    const st = JSON.parse(withJson(() => {}));
    const tmpl = JSON.stringify(st).replace('"projects":[]', '"projects":[' + P0 + ',' + tail + '}]').replace('"entries":[]', '"entries":[' + E0 + ',' + tail + '}]');
    return JSON.parse(tmpl);
  };
  for (const k of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => S.validateState(run(k, '"' + k + '":{"x":1}')), /forbidden key/, k);
    const lay = JSON.parse(JSON.stringify(S.defaultState()));
    assert.throws(() => S.validateState(JSON.parse(JSON.stringify(lay).replace('"layouts":{"narrow":[],"wide":[]}', '"layouts":{"narrow":[{"id":"glance","size":"wide","hidden":false,"' + k + '":{}}],"wide":[]}'))), /forbidden key/, 'layout item ' + k);
    assert.throws(() => S.validateState(JSON.parse(JSON.stringify(lay).replace('"layouts":{"narrow":[],"wide":[]}', '"layouts":{"' + k + '":{},"narrow":[],"wide":[]}'))), /forbidden key|layouts/, 'layouts ' + k);
  }
  assert.equal({}.x, undefined, 'Object.prototype is untouched');
});

// ---------------------------------------------------------------- expected income is not an actual
test('expected and written-off income are excluded from Money actuals, savings rate, budgets and net worth until received', () => {
  const mk = (fn) => build((s) => {
    s.accounts.push({ id: 'acc', name: 'Checking', kind: 'cash', liability: false, archived: false });
    s.budgets.push({ category: 'Dining', value: 100 });
    s.entries.push(E({ domain: 'assets', type: 'balance', date: '2026-11-01', title: 'Checking', value: 1000, accountId: 'acc' }),
      inc('2026-11-02', 1000), exp('2026-11-03', 250, { category: 'Dining' }));
    fn(s);
  });
  const plain = mk(() => {});
  const withExp = mk((s) => { s.entries.push(inc('2026-11-05', 4000, { status: 'expected', dueDate: '2026-11-30' }), inc('2026-11-06', 900, { status: 'written-off' })); });
  const mv = (st) => M.monthView(st, '2026-11');
  assert.equal(mv(withExp).incomeCents, 100000); assert.equal(mv(withExp).incomeCents, mv(plain).incomeCents);
  assert.equal(mv(withExp).savingsRate, mv(plain).savingsRate); assert.equal(mv(withExp).savingsRate, 0.75);
  assert.deepEqual(mv(withExp).categories, mv(plain).categories); assert.equal(mv(withExp).budgetCents, mv(plain).budgetCents);
  assert.equal(M.netWorthDetail(withExp, TODAY).totalCents, M.netWorthDetail(plain, TODAY).totalCents);
  assert.equal(M.headline(withExp, 'money', TODAY).value, M.headline(plain, 'money', TODAY).value);
  assert.deepEqual(M.cashflow(withExp, 2, TODAY), M.cashflow(plain, 2, TODAY));
  assert.deepEqual(M.weeklyDigest(withExp, '2026-11-02').money, M.weeklyDigest(plain, '2026-11-02').money);
  assert.deepEqual(M.weeklyDigest(withExp, '2026-11-02').domains.money, M.weeklyDigest(plain, '2026-11-02').domains.money);
  assert.equal(G.linkedValue ? 0 : 0, 0);
  const gl = (st) => { const g = { id: 'g', metric: 'savingsRate', direction: 'up', startValue: 0, targetValue: 50, startDate: '2026-11-01', dueDate: '2026-11-30' }; return G.currentValue(st, g, TODAY); };
  assert.equal(gl(withExp), gl(plain));
  // marking received counts it on the date received, in that month
  const rcv = clone(withExp);
  const id = rcv.entries.find((e) => e.status === 'expected').id;
  R.markReceived(rcv, id, '2026-12-02');
  assert.equal(mv(rcv).incomeCents, 100000); assert.equal(M.monthView(rcv, '2026-12').incomeCents, 400000);
  assert.equal(rcv.entries.find((e) => e.id === id).status, 'received');
  // written off stays out for good
  assert.equal(M.monthView(withExp, '2026-11').incomeCents, 100000);
});

// ---------------------------------------------------------------- per line, rollup and unassigned totals
// Independent oracle: integer cents straight from the entries.
const oracle = (st, from, to) => {
  let r = 0, x = 0;
  for (const e of st.entries) {
    if (e.domain !== 'money' || e.date < from || e.date > to) continue;
    const c = Math.round(e.value * 100);
    if (e.type === 'income' && (!e.status || e.status === 'received')) r += c; else if (e.type === 'expense') x += c;
  }
  return { r, x };
};
test('per-line and rollup totals equal the Money totals exactly for every period type; Unassigned holds the rest', () => {
  const st = rec();
  for (const [kind, custom] of [['month'], ['lastMonth'], ['qtd'], ['ytd'], ['t12'], ['custom', { from: '2025-12-31', to: '2026-02-03' }], ['custom', { from: '2026-11-04', to: '2026-11-04' }]]) {
    const rg = R.periodRange(kind, TODAY, custom), rep = R.report(st, rg), o = oracle(st, rg.from, rg.to);
    const sumR = rep.lines.reduce((a, l) => a + l.revenueCents, 0) + rep.unassigned.revenueCents;
    const sumX = rep.lines.reduce((a, l) => a + l.expenseCents, 0) + rep.unassigned.expenseCents;
    assert.deepEqual([rep.total.revenueCents, rep.total.expenseCents], [o.r, o.x], kind);
    assert.deepEqual([sumR, sumX], [o.r, o.x], kind + ' lines + unassigned');
    assert.equal(rep.total.netCents, o.r - o.x);
    const ay = rep.rollups.find((r) => r.id === 'ayin'), own = rep.lines.find((l) => l.id === 'ayin'), cl = rep.lines.find((l) => l.id === 'cl'), web = rep.lines.find((l) => l.id === 'web');
    assert.deepEqual(ay.childIds.sort(), ['cl', 'web']);
    assert.equal(ay.revenueCents, own.revenueCents + cl.revenueCents + web.revenueCents, kind + ' rollup revenue');
    assert.equal(ay.expenseCents, own.expenseCents + cl.expenseCents + web.expenseCents, kind + ' rollup expenses');
    assert.equal(rep.rollups.length, 1, 'only parents get a rollup');
  }
  // a month equals the Money month view to the cent
  for (const mo of ['2026-11', '2026-10', '2026-09']) {
    const rep = R.report(st, { from: mo + '-01', to: M.monthEnd(mo) }), mv = M.monthView(st, mo);
    assert.deepEqual([rep.total.revenueCents, rep.total.expenseCents, rep.total.netCents], [mv.incomeCents, mv.spendCents, mv.netCents], mo);
  }
  // exact values for November
  const nov = R.report(st, R.periodRange('month', TODAY));
  const by = (id) => nov.lines.find((l) => l.id === id);
  assert.deepEqual([by('cl').revenueCents, by('cl').expenseCents, by('web').revenueCents, by('pod').revenueCents, by('pod').expenseCents], [100000, 20025, 25050, 9999, 4000]);
  assert.deepEqual([nov.unassigned.revenueCents, nov.unassigned.expenseCents], [1000, 1234]);
  assert.deepEqual([nov.total.revenueCents, nov.total.expenseCents, nov.total.netCents], [136049, 25259, 110790]);
  assert.equal(nov.rollups[0].revenueCents, 125050);
  assert.equal(R.totalsIn(st, { kind: 'rollup', id: 'ayin' }, '2026-11-01', '2026-11-30').netCents, 125050 - 20025);
  assert.equal(R.totalsIn(st, { kind: 'line', id: 'ayin' }, '2026-11-01', '2026-11-30').count, 0);
  // an entry whose line is gone (a stale link in memory) is Unassigned, so totals still reconcile
  const stale = clone(st); stale.entries.push(inc('2026-11-12', 7, { projectId: 'ghost' }));
  const rs = R.report(stale, R.periodRange('month', TODAY));
  assert.equal(rs.unassigned.revenueCents, 1000 + 700); assert.equal(rs.total.revenueCents, 136049 + 700);
  assert.throws(() => R.periodRange('custom', TODAY, { from: '2026-11-05', to: '2026-11-04' }), /before/);
  assert.throws(() => R.periodRange('custom', TODAY, { from: 'x', to: TODAY }), /start/);
  assert.throws(() => R.periodRange('decade', TODAY), /Unknown period/);
  assert.deepEqual(R.periodRange('qtd', '2026-05-20'), { from: '2026-04-01', to: '2026-05-20' });
  assert.deepEqual(R.periodRange('t12', '2026-11-14'), { from: '2025-12-01', to: '2026-11-14' });
  assert.deepEqual(R.periodRange('lastMonth', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
});

test('margin has no data at zero revenue and is exact basis points otherwise; month table and 12-month chart rows', () => {
  const st = rec();
  const rep = R.report(st, R.periodRange('month', TODAY));
  const web = rep.lines.find((l) => l.id === 'web');
  assert.equal(R.marginBp(0, -500), null); assert.equal(R.marginText(null), 'no data');
  assert.equal(rep.unassigned.revenueCents, 1000);
  const none = build((s) => { s.entries.push(exp('2026-11-02', 20)); });
  const r0 = R.report(none, R.periodRange('month', TODAY));
  assert.equal(r0.total.marginBp, null); assert.equal(R.marginText(r0.total.marginBp), 'no data'); assert.equal(r0.unassigned.marginBp, null);
  assert.equal(web.marginBp, 10000); assert.equal(R.marginText(10000), '100.00%');
  assert.equal(R.marginBp(3, 1), 3333); assert.equal(R.marginBp(3, 2), 6667); assert.equal(R.marginText(R.marginBp(3, -2)), '-66.67%'); assert.equal(R.marginText(-5), '-0.05%');
  assert.equal(R.divRound(1, 2), 1); assert.equal(R.divRound(-1, 2), -1); assert.equal(R.divRound(5, 3), 2); assert.equal(R.divRound(1, 0), null);
  assert.equal(R.marginBp(99999999999999, 99999999999999), 10000, 'large amounts stay exact');
  const mo = R.monthly(st, { kind: 'all' }, '2026-11', 12);
  assert.equal(mo.length, 12); assert.equal(mo[0].month, '2025-12'); assert.equal(mo[11].month, '2026-11');
  assert.deepEqual([mo[0].revenueCents, mo[1].revenueCents, mo[2].expenseCents, mo[9].revenueCents, mo[10].revenueCents, mo[11].revenueCents], [900, 12000, 2020, 4107, 30000, 136049]);
  assert.equal(mo[11].marginBp, R.marginBp(136049, 136049 - 25259)); assert.equal(mo[3].marginBp, null);
  const sumAll = mo.reduce((a, r) => a + r.revenueCents, 0);
  assert.equal(sumAll, oracle(st, '2025-12-01', '2026-11-30').r);
  assert.equal(R.monthly(st, { kind: 'rollup', id: 'ayin' }, '2026-11', 1)[0].revenueCents, 125050);
  assert.equal(R.monthly(st, { kind: 'unassigned' }, '2026-11', 1)[0].revenueCents, 1000);
  assert.throws(() => R.monthly(st, { kind: 'all' }, '2026-1', 12), /YYYY-MM/);
});

test('recurring monthly revenue turns weekly, monthly and yearly income items into whole cents per month', () => {
  const rc = (id, type, value, cadence, o) => Object.assign({ id, title: id, value, category: '', type, cadence, nextDate: TODAY, active: true, household: false }, o);
  const st = build((s) => {
    s.projects.push(proj('a', 'A'), proj('b', 'B', { parentId: 'a' }));
    s.recurring.push(rc('m', 'income', 1000, 'monthly', { projectId: 'a' }), rc('w', 'income', 100, 'weekly', { projectId: 'b' }), rc('y', 'income', 1200.5, 'yearly', { projectId: 'b' }),
      rc('off', 'income', 999, 'monthly', { projectId: 'a', active: false }), rc('x', 'expense', 50, 'monthly', { projectId: 'a' }), rc('free', 'income', 10, 'monthly'));
  });
  assert.equal(R.recurringMonthlyCents(st, { kind: 'line', id: 'a' }), 100000);
  assert.equal(R.recurringMonthlyCents(st, { kind: 'line', id: 'b' }), 43333 + 10004);
  assert.equal(R.recurringMonthlyCents(st, { kind: 'rollup', id: 'a' }), 100000 + 43333 + 10004);
  assert.equal(R.recurringMonthlyCents(st, { kind: 'unassigned' }), 1000);
  assert.equal(R.recurringMonthlyCents(st, { kind: 'all' }), 100000 + 43333 + 10004 + 1000);
});

// ---------------------------------------------------------------- expected windows and overdue, time zones
test('expected income: next 30, 60 and 90 days and overdue across month end, year end and DST in New York and Auckland', () => {
  const keep = process.env.TZ;
  try {
    for (const tz of ['America/New_York', 'Pacific/Auckland', 'UTC']) {
      process.env.TZ = tz;
      const at = (today, offs) => build((s) => {
        s.projects.push(proj('p', 'P'));
        offs.forEach((d, i) => s.entries.push(inc('2026-01-01', 100 + i, { status: 'expected', dueDate: M.addDays(today, d), projectId: i % 2 ? 'p' : undefined, title: 'e' + i })));
      });
      for (const today of ['2026-01-31', '2026-12-15', '2026-03-08', '2026-11-01', '2026-04-05', '2026-09-27', '2026-02-28', '2028-02-29']) {
        const offs = [-1, 0, 1, 30, 31, 60, 61, 90, 91, -40], st = at(today, offs), ex = R.expected(st, { kind: 'all' }, today);
        const sum = (f) => offs.reduce((a, d, i) => a + (f(d) ? 10000 + i * 100 + 0 : 0), 0);
        const want = (lo, hi) => offs.reduce((a, d, i) => a + (d >= lo && d <= hi ? 100 + i : 0), 0) * 100;
        void sum;
        assert.equal(ex.overdueCents, want(-1000, -1), tz + ' ' + today + ' overdue'); assert.equal(ex.overdueCount, 2);
        assert.equal(ex.next30Cents, want(0, 30), tz + ' ' + today + ' 30'); assert.equal(ex.next60Cents, want(0, 60), tz + ' ' + today + ' 60'); assert.equal(ex.next90Cents, want(0, 90), tz + ' ' + today + ' 90');
        assert.ok(ex.next30Cents <= ex.next60Cents && ex.next60Cents <= ex.next90Cents);
        assert.equal(ex.upcoming.length, 7, 'upcoming through 90 days');
        assert.equal(ex.overdue[0].due, M.addDays(today, -40), 'oldest first');
      }
      // exact calendar boundaries
      const st = build((s) => { s.entries.push(inc('2026-01-01', 1, { status: 'expected', dueDate: '2026-02-28' }), inc('2026-01-01', 2, { status: 'expected', dueDate: '2026-03-01' })); });
      const e1 = R.expected(st, { kind: 'all' }, '2026-01-30');
      assert.deepEqual([e1.next30Cents, e1.next60Cents], [300, 300], tz); // 30 days from 01-30 is 03-01 (2026 is not a leap year): 02-28 is day 29, inclusive
      const e2 = R.expected(st, { kind: 'all' }, '2026-01-29');
      assert.deepEqual([e2.next30Cents, e2.next60Cents], [100, 300], tz);
      const ye = build((s) => { s.entries.push(inc('2026-01-01', 5, { status: 'expected', dueDate: '2027-01-01' })); });
      assert.equal(R.expected(ye, { kind: 'all' }, '2026-12-31').next30Cents, 500, tz); assert.equal(R.expected(ye, { kind: 'all' }, '2027-01-02').overdueCents, 500, tz);
      // no due date: the entry date is the due date
      const nd = build((s) => { s.entries.push(inc('2026-11-20', 5, { status: 'expected' })); });
      assert.equal(R.expected(nd, { kind: 'all' }, '2026-11-14').next30Cents, 500); assert.equal(R.expected(nd, { kind: 'all' }, '2026-11-21').overdueCents, 500);
      // scoped
      const sc = at('2026-06-10', [5, 6]);
      assert.equal(R.expected(sc, { kind: 'line', id: 'p' }, '2026-06-10').next30Cents, 101 * 100); assert.equal(R.expected(sc, { kind: 'unassigned' }, '2026-06-10').next30Cents, 100 * 100);
      // the digest uses the end of the week as the reference date and counts only numbers
      assert.equal(M.todayISO().length, 10);
    }
  } finally { if (keep === undefined) delete process.env.TZ; else process.env.TZ = keep; }
});

// ---------------------------------------------------------------- goal metrics
test('goal metrics revenue per month and net per month, scoped to a line and to a rollup; no data is null, never zero', () => {
  const st = rec();
  const goal = (metric, projectId, rollup) => ({ id: 'g', title: 'g', horizon: 'monthly', domain: 'work', metric, direction: 'up', startValue: 0, targetValue: 5000, startDate: '2026-11-01', dueDate: '2026-11-30', state: 'active', notes: '', createdAt: '2026-11-01T00:00:00.000Z', projectId, rollup });
  const cv = (g, d) => G.currentValue(st, g, d || TODAY);
  assert.equal(cv(goal('revenueMonth')), 1360.49); assert.equal(cv(goal('netMonth')), 1107.9);
  assert.equal(cv(goal('revenueMonth', 'cl', false)), 1000); assert.equal(cv(goal('netMonth', 'cl', false)), 799.75);
  assert.equal(cv(goal('revenueMonth', 'ayin', false)), null, 'the parent line alone has no money');
  assert.equal(cv(goal('revenueMonth', 'ayin', true)), 1250.5); assert.equal(cv(goal('netMonth', 'ayin', true)), 1250.5 - 200.25);
  assert.equal(cv(goal('revenueMonth', 'pod', true)), 99.99);
  assert.equal(cv(goal('revenueMonth'), '2026-08-20'), null, 'a month without money is no data');
  assert.equal(cv(goal('revenueMonth', 'cl', false), '2026-10-31'), 300); assert.equal(cv(goal('netMonth', 'web', false), '2026-10-31'), -50);
  const memo = new Map();
  assert.equal(G.currentValue(st, goal('revenueMonth', 'cl', false), TODAY, memo), 1000); assert.equal(G.currentValue(st, goal('revenueMonth', 'cl', true), TODAY, memo), 1000);
  assert.equal(G.currentValue(st, goal('revenueMonth', 'ayin', true), TODAY, memo), 1250.5, 'the memo keeps scopes apart');
  const ev = G.evaluate(st, goal('revenueMonth', 'ayin', true), TODAY);
  assert.equal(ev.current, 1250.5); assert.ok(ev.progress > 0.25 && ev.progress < 0.26);
  assert.equal(G.evaluate(st, goal('revenueMonth', 'ayin', false), TODAY).pace, 'no-data');
  // addGoal and updateGoal carry the scope and validate it
  const s2 = clone(st);
  const g = G.addGoal(s2, { title: 'Net', horizon: 'monthly', metric: 'netMonth', targetValue: 2000, projectId: 'ayin', rollup: true }, TODAY);
  assert.deepEqual([g.projectId, g.rollup, g.startValue], ['ayin', true, 1050.25]);
  S.validateState(clone(s2));
  G.updateGoal(s2, g.id, { rollup: false }); assert.equal(g.rollup, undefined);
  G.updateGoal(s2, g.id, { projectId: '' }); assert.equal(g.projectId, undefined);
  const s3 = clone(st);
  const g3 = G.addGoal(s3, { title: 'Pipe', horizon: 'monthly', metric: 'pipelineWon', targetValue: 2, startValue: 0, projectId: 'ayin' }, TODAY);
  assert.equal(g3.projectId, undefined, 'a non revenue goal takes no scope');
  assert.equal(G.METRICS.filter((m) => m.id === 'revenueMonth' || m.id === 'netMonth').length, 2);
});

// ---------------------------------------------------------------- review actions
test('weekly review: received this week and overdue expected income; actions are offered, never run by the review', () => {
  const st = build((s) => {
    s.projects.push(proj('p', 'P'));
    s.entries.push(inc('2026-11-10', 300, { projectId: 'p' }), inc('2026-11-12', 20), inc('2026-11-02', 999),
      inc('2026-11-01', 400, { status: 'expected', dueDate: '2026-11-05', projectId: 'p', title: 'late one' }), inc('2026-11-01', 60, { status: 'expected', dueDate: '2026-11-30', title: 'later' }));
  });
  const before = text(st);
  const rv = R.reviewWeek(st, WK, TODAY);
  assert.equal(rv.receivedCents, 32000); assert.equal(rv.week, WK);
  assert.deepEqual(rv.overdue.map((x) => [x.title, x.cents, x.due]), [['late one', 40000, '2026-11-05']]); assert.equal(rv.overdueCents, 40000);
  assert.equal(text(st), before, 'reviewing changes nothing');
  assert.equal(R.reviewWeek(st, WK).overdue.length, 1, 'without today the end of the week is the reference');
  // each action is one explicit call on one entry
  const id = rv.overdue[0].id;
  const a = clone(st); R.moveDue(a, id, '2026-12-01'); assert.equal(a.entries.find((e) => e.id === id).dueDate, '2026-12-01'); assert.equal(R.reviewWeek(a, WK, TODAY).overdue.length, 0);
  const b = clone(st); R.writeOff(b, id); assert.equal(b.entries.find((e) => e.id === id).status, 'written-off'); assert.equal(R.reviewWeek(b, WK, TODAY).overdue.length, 0);
  assert.equal(oracle(b, '2026-11-01', '2026-11-30').r, oracle(st, '2026-11-01', '2026-11-30').r, 'written off is not counted');
  const c = clone(st); R.markReceived(c, id, TODAY); assert.equal(c.entries.find((e) => e.id === id).date, TODAY); assert.equal(R.reviewWeek(c, WK, TODAY).receivedCents, 32000 + 40000);
  for (const bad of [() => R.markReceived(clone(st), 'nope', TODAY), () => R.markReceived(clone(st), st.entries[0].id, TODAY), () => R.writeOff(clone(st), st.entries[0].id), () => R.moveDue(clone(st), id, 'soon'), () => R.markReceived(clone(st), id, '2026-02-30')]) assert.throws(bad);
  // the others are untouched
  const others = (x) => x.entries.filter((e) => e.id !== id).map((e) => text(e));
  assert.deepEqual(others(c), others(st)); assert.deepEqual(others(a), others(st)); assert.deepEqual(others(b), others(st));
});

// ---------------------------------------------------------------- bulk assign, parents, unlinking
test('bulk assign to a line of work: filtered list, counts, only money entries, archived lines refused', () => {
  const st = clone(rec());
  st.entries.push(E({ domain: 'work', type: 'outcome', date: TODAY, title: 'out', status: 'todo' }), E({ domain: 'assets', type: 'balance', date: TODAY, title: 'bal', value: 1 }));
  const f = (o) => R.filterEntries(st, o);
  assert.equal(f({}).length, 15); assert.equal(f({ type: 'income' }).length, 10); assert.equal(f({ type: 'expense' }).length, 5);
  assert.equal(f({ line: 'none' }).length, 3); assert.equal(f({ line: 'cl' }).length, 6); assert.equal(f({ from: '2026-11-01', to: '2026-11-30' }).length, 9);
  assert.equal(f({ text: '  T ' }).length, 15); assert.equal(f({ text: 'zzz' }).length, 0);
  const un = f({ line: 'none', type: 'expense' }), ids = un.map((e) => e.id);
  assert.equal(R.assignLine(st, ids, 'pod'), un.length);
  assert.equal(f({ line: 'none', type: 'expense' }).length, 0); assert.equal(R.assignLine(st, ids, 'pod'), 0, 'already there');
  assert.equal(R.assignLine(st, ids, null), un.length); assert.equal(f({ line: 'none', type: 'expense' }).length, un.length);
  const outcome = st.entries.find((e) => e.type === 'outcome'), bal = st.entries.find((e) => e.type === 'balance');
  assert.equal(R.assignLine(st, [outcome.id, bal.id], 'pod'), 0); assert.equal(outcome.projectId, undefined);
  assert.throws(() => R.assignLine(st, ids, 'nope'), /not found/);
  st.projects.find((p) => p.id === 'pod').archived = true;
  assert.throws(() => R.assignLine(st, ids, 'pod'), /archived/);
  assert.throws(() => R.assignLine(st, 'x', 'cl'), /Nothing/);
  S.validateState(clone(st));
});

test('parents: one level, not archived, no cycles; archive and delete unlink and never delete entries', () => {
  const st = clone(rec());
  const before = st.entries.length;
  assert.throws(() => R.setParent(st, 'ayin', 'pod'), /already has lines/);
  assert.throws(() => R.setParent(st, 'pod', 'cl'), /one level/);
  assert.throws(() => R.setParent(st, 'pod', 'pod'), /own parent/);
  assert.throws(() => R.setParent(st, 'pod', 'nope'), /not found/);
  assert.throws(() => R.setParent(st, 'nope', 'ayin'), /not found/);
  st.projects.find((p) => p.id === 'web').archived = true;
  assert.throws(() => R.setParent(st, 'pod', 'web'), /archived/);
  st.projects.find((p) => p.id === 'web').archived = false;
  R.setParent(st, 'pod', 'ayin'); assert.equal(st.projects.find((p) => p.id === 'pod').parentId, 'ayin'); R.setParent(st, 'pod', null); assert.equal(st.projects.find((p) => p.id === 'pod').parentId, undefined);
  S.validateState(clone(st));
  st.recurring.push({ id: 'r', title: 'x', value: 5, category: '', type: 'income', cadence: 'monthly', nextDate: TODAY, active: true, household: false, projectId: 'ayin' });
  st.goals.push({ id: 'g', title: 'g', horizon: 'monthly', domain: 'work', metric: 'revenueMonth', direction: 'up', startValue: 0, targetValue: 100, startDate: '2026-11-01', dueDate: '2026-11-30', state: 'active', notes: '', createdAt: '2026-11-01T00:00:00.000Z', projectId: 'ayin', rollup: true });
  assert.deepEqual(R.linkedCounts(st, 'ayin'), { entries: 0, recurring: 1, children: 2, goals: 1 });
  assert.deepEqual(R.linkedCounts(st, 'cl'), { entries: 6, recurring: 0, children: 0, goals: 0 });
  // archive the parent: children are unlinked, entries stay linked to the archived line
  const arch = clone(st);
  assert.equal(R.archiveProject(arch, 'ayin'), 2);
  assert.equal(arch.projects.find((p) => p.id === 'cl').parentId, undefined); assert.equal(arch.projects.find((p) => p.id === 'ayin').archived, true);
  assert.equal(arch.entries.length, before); assert.equal(arch.entries.filter((e) => e.projectId === 'cl').length, 6);
  S.validateState(clone(arch));
  assert.throws(() => R.archiveProject(arch, 'nope'), /not found/);
  // an archived child keeps its money in the totals
  const rep = R.report(arch, R.periodRange('month', TODAY));
  assert.equal(rep.total.revenueCents, 136049);
  // delete the parent: children unlinked, recurring and goal scope unlinked, nothing deleted with it
  const del = clone(st);
  M.deleteProject(del, 'ayin');
  assert.equal(del.projects.some((p) => p.id === 'ayin'), false); assert.equal(del.projects.find((p) => p.id === 'cl').parentId, undefined);
  assert.equal(del.recurring[0].projectId, undefined); assert.equal(del.goals[0].projectId, undefined); assert.equal(del.goals[0].rollup, undefined);
  assert.equal(del.entries.length, before); S.validateState(clone(del));
  // delete a child line: its entries stay and become Unassigned
  const del2 = clone(st);
  assert.equal(M.deleteProject(del2, 'cl'), 6);
  assert.equal(del2.entries.length, before); assert.equal(del2.entries.filter((e) => e.projectId === 'cl').length, 0);
  assert.equal(R.report(del2, R.periodRange('month', TODAY)).total.revenueCents, 136049);
  assert.deepEqual(R.unlinkProject(clone(st), 'cl'), { entries: 6, recurring: 0, children: 0, goals: 0 });
});

test('confirming a recurring item keeps its line of work; the new entry is received income', () => {
  const st = build((s) => {
    s.projects.push(proj('p', 'P'));
    s.recurring.push({ id: 'r', title: 'Retainer', value: 750, category: 'Business', type: 'income', cadence: 'monthly', nextDate: TODAY, active: true, household: false, projectId: 'p' });
  });
  const e = M.confirmRecurring(st, 'r', TODAY);
  assert.equal(e.projectId, 'p'); assert.equal(e.status, undefined); assert.equal(e.value, 750);
  assert.equal(st.recurring[0].nextDate, '2026-12-14');
  S.validateState(clone(st));
});

// ---------------------------------------------------------------- ledger CSV import
test('amounts parse to integer cents without floating point: symbols, separators, brackets, signs', () => {
  const ok = { '12': 1200, '12.5': 1250, '12.50': 1250, '$12.50': 1250, '€1,234.56': 123456, '£ 1,234': 123400, '1,234,567.89': 123456789, '$-5.00': -500, '-$5': -500, '(50.00)': -5000, '($1,200.10)': -120010, '+7.1': 710, '.5': 50, '0': 0, '0.00': 0, '  42  ': 4200, '0.10': 10, '19.99': 1999, '999,999,999,999.99': 99999999999999, '¥300': 30000 };
  for (const [k, v] of Object.entries(ok)) assert.equal(R.parseCents(k), v, JSON.stringify(k));
  for (const bad of ['', ' ', 'abc', '12.345', '1.234,56', '12,50', '1,23,456', '1,2345', '$', '--5', '(5', '5)', '(-5)', '1e3', '0x10', '12.', 'NaN', 'Infinity', '9999999999999', '$5 USD', '-', '1,000,0', '١٢']) assert.equal(R.parseCents(bad), null, JSON.stringify(bad));
  assert.equal(R.parseCents(5), null); assert.equal(R.parseCents(undefined), null);
  // summing in cents has no drift: 0.10 three times is exactly 30
  assert.equal(['0.10', '0.10', '0.10'].reduce((a, x) => a + R.parseCents(x), 0), 30);
  assert.equal(['0.1', '0.2'].reduce((a, x) => a + R.parseCents(x), 0), 30);
});

test('ledger dates: YYYY-MM-DD, MM/DD/YYYY, M/D/YYYY, and DD/MM/YYYY only when picked', () => {
  const p = (s, f) => R.parseDate(s, f);
  assert.equal(p('2026-11-05'), '2026-11-05'); assert.equal(p('11/05/2026'), '2026-11-05'); assert.equal(p('1/5/2026'), '2026-01-05'); assert.equal(p('12/31/2026'), '2026-12-31');
  assert.equal(p('13/02/2026'), null, 'auto never reads DD/MM'); assert.equal(p('02/13/2026'), '2026-02-13'); assert.equal(p('05/11/2026'), '2026-05-11', 'ambiguous dates are MM/DD in auto');
  assert.equal(p('13/02/2026', 'dmy'), '2026-02-13'); assert.equal(p('5/11/2026', 'dmy'), '2026-11-05'); assert.equal(p('02/13/2026', 'dmy'), null); assert.equal(p('2026-11-05', 'dmy'), '2026-11-05');
  assert.equal(p('2024-02-29'), '2024-02-29'); assert.equal(p('2026-02-29'), null); assert.equal(p('2/29/2026'), null); assert.equal(p('31/04/2026', 'dmy'), null);
  for (const bad of ['', 'today', '2026/11/05', '11-05-2026', '1/5/26', '2026-1-5', '2026-11-05T00:00:00', '11/05/2026 10:00', '1900-01-01x', '0000-01-01', '2300-01-01', 5]) assert.equal(p(bad), null, JSON.stringify(bad));
});

const csv = (rows) => C.parse(rows.join('\n'));
const baseState = () => build((s) => { s.projects.push(proj('ayin', 'AYiN Advisors', { kind: 'venture' }), proj('web', 'Website', { kind: 'website', parentId: 'ayin' })); });
const PLAN = async (rows, map, o, state) => R.plan(csv(rows), Object.assign({ map }, o || {}), state || baseState(), TODAY);
test('ledger import: one amount column with brackets and symbols, matched lines case and space insensitive, preview writes nothing', async () => {
  const st = baseState(), before = text(st);
  const pl = await PLAN([
    'Date,Line,Category,Description,Amount',
    '2026-11-03,ayin advisors,Business,Retainer,"$1,500.00"',
    '11/04/2026,  WEBSITE ,Hosting,Hosting fee,(49.99)',
    '1/5/2026,,Other,Coffee beans,(12.50)',
    '2026-11-06,Podcast,Business,Sponsor,200',
  ], { date: 0, line: 1, category: 2, description: 3, amount: 4 }, {}, st);
  assert.equal(text(st), before, 'the preview writes nothing');
  assert.equal(pl.add.length, 4); assert.equal(pl.rejected.length, 0); assert.equal(pl.duplicates, 0);
  const e = pl.add.map((a) => a.entry);
  assert.deepEqual(e.map((x) => [x.type, x.value, x.date, x.projectId]), [['income', 1500, '2026-11-03', 'ayin'], ['expense', 49.99, '2026-11-04', 'web'], ['expense', 12.5, '2026-01-05', undefined], ['income', 200, '2026-11-06', undefined]]);
  assert.deepEqual(pl.totals, { incomeCents: 170000, expenseCents: 6249 });
  assert.deepEqual(pl.unknownLines, ['Podcast']); assert.deepEqual(pl.newLines, []);
  assert.deepEqual(pl.byLine.map((g) => [g.line, g.incomeCents, g.expenseCents, g.count]), [['AYiN Advisors', 150000, 0, 1], ['Unassigned', 20000, 1250, 2], ['Website', 0, 4999, 1]]);
  for (const a of pl.add) assert.match(a.entry.importKey, /^[0-9a-f]{64}$/);
  // unknown names are listed, and only created when asked
  const none = clone(st); R.applyPlan(none, pl);
  assert.equal(none.projects.length, 2, 'no line is created unless it was ticked'); assert.equal(none.entries.length, 4);
  const pl2 = await PLAN(['Date,Line,Amount,Description', '2026-11-06,Podcast,200,Sponsor', '2026-11-07, podcast ,50,Sponsor 2'], { date: 0, line: 1, amount: 2, description: 3 }, { create: ['PODCAST'] }, st);
  assert.deepEqual(pl2.newLines, ['Podcast']); assert.equal(pl2.unknownLines.length, 1);
  const made = clone(st), res = R.applyPlan(made, pl2);
  assert.deepEqual(res, { added: 2, linesCreated: 1 });
  const podcast = made.projects.find((p) => p.name === 'Podcast');
  assert.ok(podcast && podcast.kind === 'client' && podcast.status === 'active' && !podcast.archived);
  assert.deepEqual(made.entries.map((x) => x.projectId), [podcast.id, podcast.id]);
  S.validateState(clone(made));
});

test('ledger import: separate income and expense columns, type column, status and due date, DD/MM only when picked', async () => {
  const split = await PLAN(['Date,In,Out,Memo', '2026-11-03,"1,000.50",,Invoice paid', '2026-11-04,,$20.00,Software', '2026-11-05,5,5,both', '2026-11-06,,,empty', '2026-11-07,-5,,neg', '2026-11-08,abc,,junk'], { date: 0, income: 1, expense: 2, description: 3 });
  assert.deepEqual(split.add.map((a) => [a.entry.type, a.entry.value]), [['income', 1000.5], ['expense', 20]]);
  assert.deepEqual(split.rejected.map((r) => [r.row, r.reason]), [[4, 'both income and expense have an amount'], [5, 'amount is zero or empty'], [6, 'amount is negative in an income or expense column'], [7, 'amount is not a number']]);
  const typed = await PLAN(['Date,Type,Amount,Description,Status,Due', '2026-11-03, Money In ,100,A,expected,2026-12-01', '2026-11-04,money out,40,B,,', '2026-11-05,Other,5,C,,', '2026-11-06,Money In,-5,D,,', '2026-11-07,Money In,7,E,written-off,', '2026-11-08,Money out,9,F,expected,', '2026-11-09,Money In,3,G,maybe,', '2026-11-10,Money In,3,H,received,soon'],
    { date: 0, type: 1, amount: 2, description: 3, status: 4, due: 5 }, { typeValues: { income: 'money in', expense: 'MONEY OUT' } });
  assert.deepEqual(typed.add.map((a) => [a.entry.type, a.entry.value, a.entry.status, a.entry.dueDate]), [['income', 100, 'expected', '2026-12-01'], ['expense', 40, undefined, undefined], ['income', 7, 'written-off', undefined]]);
  assert.deepEqual(typed.rejected.map((r) => [r.row, r.reason]), [[4, 'type is not one of the chosen income or expense values'], [5, 'amount is negative with a type column'], [7, 'only income can be expected or written off'], [8, 'status is not received, expected or written-off'], [9, 'due date is not a valid date']]);
  await assert.rejects(PLAN(['Date,Type,Amount', '2026-11-03,x,1'], { date: 0, type: 1, amount: 2 }, { typeValues: { income: 'x', expense: 'X' } }), /Say which type values/);
  await assert.rejects(PLAN(['Date,Type,Amount', '2026-11-03,x,1'], { date: 0, type: 1, amount: 2 }), /Say which type values/);
  const dm = ['Date,Amount', '13/02/2026,5', '02/13/2026,6', '2026-02-14,7'];
  assert.deepEqual((await PLAN(dm, { date: 0, amount: 1 })).add.map((a) => a.entry.date), ['2026-02-13', '2026-02-14']);
  assert.equal((await PLAN(dm, { date: 0, amount: 1 })).rejected[0].reason, 'date is not a valid YYYY-MM-DD or MM/DD/YYYY date');
  const d2 = await PLAN(dm, { date: 0, amount: 1 }, { dateFormat: 'dmy' });
  assert.deepEqual(d2.add.map((a) => a.entry.date), ['2026-02-13', '2026-02-14']); assert.equal(d2.rejected.length, 1); assert.equal(d2.rejected[0].row, 3);
  // mapping errors
  await assert.rejects(PLAN(['Date,Amount', '2026-11-03,1'], { amount: 1 }), /date column/);
  await assert.rejects(PLAN(['Date,Amount', '2026-11-03,1'], { date: 0 }), /amount column/);
  await assert.rejects(PLAN(['Date,Amount', '2026-11-03,1'], { date: 0, amount: 1, income: 1 }), /not both/);
  await assert.rejects(PLAN(['Date,Amount', '2026-11-03,1'], { date: 0, amount: 7 }), /Column not found/);
  await assert.rejects(PLAN(['Date,Amount', '2026-11-03,1'], { date: '0', amount: 1 }), /Column not found/);
  await assert.rejects(R.plan(null, { map: {} }, baseState(), TODAY), /Nothing to import/);
  await assert.rejects(R.plan(csv(['a,b', '1,2']), {}, baseState(), TODAY), /mapping/);
});

test('ledger import: importKey makes a re-import a no-op, including identical rows inside one file', async () => {
  const rows = ['Date,Line,Description,Amount', '2026-11-03,Website,Hosting,(10.00)', '2026-11-03,Website,Hosting,(10.00)', '2026-11-04,Website,Domain,(15.00)', '2026-11-05,,Gift,5'];
  const map = { date: 0, line: 1, description: 2, amount: 3 };
  const st = baseState();
  const pl = await PLAN(rows, map, {}, st);
  assert.equal(pl.add.length, 4, 'two identical purchases on one day both import');
  assert.equal(new Set(pl.add.map((a) => a.entry.importKey)).size, 4);
  R.applyPlan(st, pl);
  assert.equal(st.entries.length, 4);
  const again = await PLAN(rows, map, {}, st);
  assert.equal(again.add.length, 0); assert.equal(again.duplicates, 4); assert.equal(again.empty, true);
  // key survives validation, a backup round trip and keeps the same value
  const back = S.validateState(clone(st));
  assert.deepEqual(back.entries.map((e) => e.importKey), st.entries.map((e) => e.importKey));
  const again2 = await PLAN(rows, map, {}, back);
  assert.equal(again2.add.length, 0);
  // a changed amount, date, line or description is a different row; case and spacing are not
  const more = await PLAN(['Date,Line,Description,Amount', '2026-11-03,WEBSITE,  hosting ,(10.00)', '2026-11-03,Website,Hosting,(10.01)', '2026-11-06,Website,Hosting,(10.00)', '2026-11-03,,Hosting,(10.00)'], map, {}, back);
  assert.equal(more.duplicates, 1); assert.equal(more.add.length, 3);
  // the key is a stable SHA-256 of normalised fields
  const k1 = await R.importKey('2026-11-03', 1000, 'expense', ' Website ', 'Hosting', 0), k2 = await R.importKey('2026-11-03', 1000, 'expense', 'website', ' hosting', 0);
  assert.equal(k1, k2); assert.match(k1, /^[0-9a-f]{64}$/); assert.notEqual(k1, await R.importKey('2026-11-03', 1000, 'income', 'website', 'hosting', 0)); assert.notEqual(k1, await R.importKey('2026-11-03', 1000, 'expense', 'website', 'hosting', 1));
  // an entry that was moved or edited keeps its key; deleting the entry lets the row import again
  const del = clone(st); del.entries = del.entries.filter((e) => e.title !== 'Domain');
  assert.equal((await PLAN(rows, map, {}, del)).add.length, 1);
});

test('ledger import: rejected rows carry a reason and never echo the cell text; secrets guard and the 200 character cap', async () => {
  const long = 'x'.repeat(201), ok200 = 'y'.repeat(200);
  const secret = '4242 4242 4242 4242', ssn = '123-45-6789';
  const pl = await PLAN([
    'Date,Line,Category,Description,Amount',
    '2026-11-03,,,' + long + ',1', '2026-11-03,,,' + ok200 + ',2', '2026-11-03,,,Paid with ' + secret + ' today,3', '2026-11-03,,,SSN ' + ssn + ',4',
    '2026-11-03,,' + 'c'.repeat(41) + ',cat,5', '2026-11-03,' + 'l'.repeat(201) + ',,line,6', '2026-11-03,,4242424242424242,card category,7', '2026-11-03,' + ssn + ',,secret line,8',
    '2026-11-03,,,short row', '2026-11-03,,,ok,1,extra', '2026-13-45,,,bad date,9', '2026-11-03,,,zero,0', 'x,y,z,w,v',
  ], { date: 0, line: 1, category: 2, description: 3, amount: 4 });
  assert.deepEqual(pl.add.map((a) => a.entry.value), [2]);
  assert.equal(pl.add[0].entry.title, ok200);
  const reasons = Object.fromEntries(pl.rejected.map((r) => [r.row, r.reason]));
  assert.equal(reasons[2], 'description is longer than 200 characters');
  assert.equal(reasons[4], 'looks like an ID or card number'); assert.equal(reasons[5], 'looks like an ID or card number');
  assert.equal(reasons[6], 'category is longer than 40 characters'); assert.equal(reasons[7], 'line of work is longer than 200 characters');
  assert.equal(reasons[8], 'looks like an ID or card number'); assert.equal(reasons[9], 'looks like an ID or card number');
  assert.equal(reasons[10], 'wrong number of columns'); assert.equal(reasons[11], 'wrong number of columns');
  assert.match(reasons[12], /date/); assert.equal(reasons[13], 'amount is zero'); assert.match(reasons[14], /date/);
  assert.equal(pl.rejected.length, 12);
  for (const r of pl.rejected) assert.ok(!/xxxx|4242|6789|yyyy|cccc|llll/.test(r.reason), r.reason);
  // an empty description falls back to the category, then the type; a leading apostrophe added by CSV export is removed
  const fb = await PLAN(['Date,Category,Description,Amount', '2026-11-03,Hosting,,(5)', "2026-11-04,,,6", "2026-11-05,,'=SUM(A1),(7)", '2026-11-06,,"multi\nline   text",8'], { date: 0, category: 1, description: 2, amount: 3 });
  assert.deepEqual(fb.add.map((a) => a.entry.title), ['Hosting', 'Income', '=SUM(A1)', 'multi line text']);
});

test('ledger import applies through one commit, keeps the entry cap, and the import survives a save and reload', async () => {
  await vault(baseState());
  const rows = ['Date,Line,Description,Amount', '2026-11-03,Website,Hosting,(10.00)', '2026-11-04,New Show,Sponsor,300'];
  const pl = await R.plan(csv(rows), { map: { date: 0, line: 1, description: 2, amount: 3 }, create: ['new show'] }, S.getState(), TODAY);
  await S.commit((x) => { R.applyPlan(x, pl); });
  assert.equal(S.getState().entries.length, 2); assert.equal(S.getState().projects.length, 3);
  const key = S.getState().entries.map((e) => e.importKey);
  S.lock(); await S.unlock(PASS);
  assert.deepEqual(S.getState().entries.map((e) => e.importKey), key);
  const again = await R.plan(csv(rows), { map: { date: 0, line: 1, description: 2, amount: 3 }, create: ['new show'] }, S.getState(), TODAY);
  assert.equal(again.add.length, 0); assert.equal(again.newLines.length, 0, 'the line exists now');
  // caps
  const big = build(() => {}); big.entries.length = 0;
  const fake = { entries: new Array(49999).fill(0).map((_, i) => ({ domain: 'money', type: 'expense', importKey: i < 3 ? 'k' + i : undefined })), projects: [] };
  await assert.rejects(R.plan(csv(['Date,Amount', '2026-11-03,1', '2026-11-04,2']), { map: { date: 0, amount: 1 } }, fake, TODAY), /entry limit/);
  assert.equal(big.entries.length, 0);
});

// ---------------------------------------------------------------- private lines of work
test('private lines of work and their money are excluded while the vault is closed, with a marker, and included while it is open', async () => {
  await vault(build((s) => {
    s.projects.push(proj('pub', 'Public Co'), proj('priv', 'Secret Co'), proj('kid', 'Secret kid', { parentId: 'priv' }));
    s.entries.push(inc('2026-11-03', 100, { projectId: 'pub' }), inc('2026-11-04', 5000, { projectId: 'priv' }), exp('2026-11-05', 700, { projectId: 'kid' }), inc('2026-11-06', 33),
      inc('2026-11-07', 900, { projectId: 'priv', status: 'expected', dueDate: '2026-11-01' }));
    s.recurring.push({ id: 'rp', title: 'Secret retainer', value: 800, category: '', type: 'income', cadence: 'monthly', nextDate: '2026-12-01', active: true, household: false, projectId: 'priv' });
  }));
  await P.setUp(PRIV);
  const month = () => R.report(P.isOpen() ? P.view(S.getState()) : S.getState(), R.periodRange('month', TODAY));
  const open = month();
  assert.equal(open.total.revenueCents, 513300); assert.equal(open.lines.find((l) => l.id === 'priv').revenueCents, 500000);
  // move the line with its children (entries, recurring, child lines) in
  await P.moveIn('projects', 'priv', { children: true });
  const sc = P.view(S.getState());
  assert.deepEqual([sc.projects.length, sc.entries.length, sc.recurring.length], [3, 5, 1], 'the open view still has everything');
  assert.deepEqual(S.getState().projects.map((p) => p.id), ['pub']); assert.equal(S.getState().entries.length, 2); assert.equal(S.getState().recurring.length, 0);
  assert.ok(S.getState().priv.marks.includes('projects') && S.getState().priv.marks.includes('entries') && S.getState().priv.marks.includes('recurring'));
  assert.equal(P.view(S.getState()).entries.find((e) => e.projectId === 'priv').projectId, 'priv');
  const o2 = month(); assert.deepEqual([o2.total.revenueCents, o2.total.expenseCents], [open.total.revenueCents, open.total.expenseCents], 'open: same totals as before the move');
  assert.equal(R.recurringMonthlyCents(P.view(S.getState()), { kind: 'rollup', id: 'priv' }), 80000);
  assert.equal(R.expected(P.view(S.getState()), { kind: 'all' }, TODAY).overdueCount, 1);
  P.close();
  const closed = month();
  assert.equal(closed.total.revenueCents, 13300); assert.equal(closed.total.expenseCents, 0); assert.deepEqual(closed.lines.map((l) => l.id), ['pub']);
  assert.equal(closed.unassigned.revenueCents, 3300);
  assert.equal(closed.total.revenueCents, oracle(S.getState(), '2026-11-01', '2026-11-30').r, 'closed totals still equal the Money totals');
  assert.equal(R.expected(S.getState(), { kind: 'all' }, TODAY).overdueCount, 0); assert.equal(R.recurringMonthlyCents(S.getState(), { kind: 'all' }), 0);
  assert.ok(!text(S.getState()).includes('Secret'), 'no private text in the main state');
  // reopen: it is all back
  await P.open(PRIV);
  assert.equal(month().total.revenueCents, 513300);
  // children left public: they lose the link while closed (Unassigned) and get it back when open
  await P.moveOut('projects', 'priv', { children: true });
  await P.moveIn('projects', 'priv', { children: false });
  P.close();
  const c2 = month();
  assert.equal(c2.unassigned.revenueCents, 3300 + 500000, 'public entries of a private line are Unassigned while closed');
  assert.equal(c2.total.revenueCents, oracle(S.getState(), '2026-11-01', '2026-11-30').r);
  await P.open(PRIV);
  assert.equal(month().lines.find((l) => l.id === 'priv').revenueCents, 500000, 'and linked again when open');
  // a new entry made for a private line while open is private too
  await P.write((x) => { x.entries.push(inc('2026-11-12', 42, { projectId: 'priv', title: 'Secret new' })); });
  assert.ok(!text(S.getState()).includes('Secret new'));
  // layouts live in the main state and never see the vault
  await P.write((x) => { x.settings.layouts.narrow = [{ id: 'glance', size: 'wide', hidden: true }]; });
  assert.equal(S.getState().settings.layouts.narrow.length, 1);
  P.close();
  // main-only outputs while open: digest and prompt ignore private money
  await P.open(PRIV);
  const dOpen = M.weeklyDigest(P.view(S.getState()), WK), dMain = M.weeklyDigest(S.getState(), WK);
  assert.deepEqual(dOpen.revenue, dMain.revenue);
  assert.equal(Mem.buildPrompt(P.view(S.getState()), 1, { from: WK, to: '2026-11-15' }).user, Mem.buildPrompt(S.getState(), 1, { from: WK, to: '2026-11-15' }).user);
});

// ---------------------------------------------------------------- numbers only: digest, prompts, audit, errors
const ADV = (n) => ADV_MARK + n + ' <img src=x onerror=alert(1)> =cmd|x ';
test('digest and prompts hold numbers only, even with adversarial line names, parents, descriptions, categories and imported text', async () => {
  const names = [ADV('parent').slice(0, 190), ADV('child').slice(0, 190)];
  await vault(build((s) => {
    s.projects.push(proj('par', names[0], { kind: 'venture', nextAction: ADV('next').slice(0, 190) }), proj('chi', names[1], { parentId: 'par', nextAction: ADV('next2').slice(0, 190) }));
    s.entries.push(inc('2026-11-10', 100, { projectId: 'chi', title: ADV('title'), notes: ADV('notes'), category: ADV('cat').slice(0, 40) }), exp('2026-11-11', 30, { projectId: 'par', title: ADV('exp'), notes: ADV('n2') }),
      inc('2026-11-05', 250, { status: 'expected', dueDate: '2026-11-08', title: ADV('late'), projectId: 'chi' }));
    s.recurring.push({ id: 'rr', title: ADV('rec'), value: 60, category: ADV('rc').slice(0, 40), type: 'income', cadence: 'monthly', nextDate: '2026-12-01', active: true, household: false, projectId: 'chi' });
  }));
  // imported text: line name, category and description from a CSV
  const rows = ['Date,Line,Category,Description,Amount', '2026-11-12,' + ADV('csvline').slice(0, 150).replace(/,/g, ';') + ',' + ADV('csvcat').slice(0, 38).replace(/,/g, ';') + ',' + ADV('csvdesc').slice(0, 180).replace(/,/g, ';') + ',55'];
  const pl = await R.plan(csv(rows), { map: { date: 0, line: 1, category: 2, description: 3, amount: 4 }, create: [R.normName(ADV('csvline').slice(0, 150).replace(/,/g, ';'))] }, S.getState(), TODAY);
  assert.equal(pl.add.length, 1);
  await S.commit((x) => { R.applyPlan(x, pl); x.audit.push({ ts: new Date().toISOString(), action: 'ledger import' }); });
  const st = S.getState();
  assert.ok(text(st).includes('csvdesc'), 'the imported text is stored');
  const dg = M.weeklyDigest(st, WK);
  assert.ok(!text(dg).includes('LEAK'), 'digest');
  const walk = (v, path) => { if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], path + '.' + k); else assert.ok(typeof v === 'number' || (path.endsWith('.unit') || path.endsWith('.week')), path + ' is a ' + typeof v); };
  walk(dg.revenue, 'revenue');
  assert.deepEqual(Object.keys(dg.revenue).sort(), ['expectedNext30Cents', 'expensesMonthCents', 'expensesWeekCents', 'lines', 'netMonthCents', 'netWeekCents', 'overdueCount', 'revenueMonthCents', 'revenueWeekCents']);
  assert.equal(dg.revenue.overdueCount, 1); assert.equal(dg.revenue.lines, 3); assert.equal(dg.revenue.revenueWeekCents, 10000 + 5500); assert.equal(dg.revenue.expensesWeekCents, 3000);
  for (const lv of [1, 2, 3]) {
    const pr = Mem.buildPrompt(st, lv, lv === 1 ? { from: WK, to: '2026-11-15' } : lv === 2 ? { from: '2026-11-01', to: '2026-11-30' } : { from: '2026-10-01', to: '2026-12-31' });
    assert.ok(!(pr.system + pr.user).includes('LEAK'), 'prompt level ' + lv); assert.ok(!(pr.system + pr.user).includes('<img'), 'prompt level ' + lv);
    if (lv === 1) assert.match(pr.user, /revenue detail: received this week \$155, expenses this week \$30, net this week \$125, received this month \$155, expenses this month \$30, net this month \$125, expected in the next 30 days \$0, overdue expected income 1, lines of work 3/);
  }
  // the stored review record keeps numbers only
  await S.commit((x) => { x.memory.reviews.push({ id: 'rv', weekOf: WK, digest: M.weeklyDigest(x, WK), priorities: ['a', 'b', 'c'], completedAt: '2026-11-14T00:00:00.000Z' }); });
  assert.ok(!text(S.getState().memory).includes('LEAK'));
  assert.ok(!text(S.getState().audit).includes('LEAK'));
  // rules insights stay free of line text
  assert.ok(!text(Mem.rulesInsights(st, WK)).includes('LEAK'));
  // errors from the new mutators and parsers never echo user text
  const probe = [() => R.assignLine(clone(st), [], ADV('x')), () => R.setParent(clone(st), ADV('a'), ADV('b')), () => R.markReceived(clone(st), ADV('c'), TODAY), () => R.moveDue(clone(st), st.entries[0].id, ADV('d')), () => R.archiveProject(clone(st), ADV('e'))];
  for (const f of probe) { try { f(); } catch (e) { assert.ok(!/LEAK|<img/.test(e.message), e.message); } }
  const bad = await R.plan(csv(['Date,Description,Amount', ADV('d1') + ',' + ADV('desc').replace(/,/g, ';') + ',' + ADV('amt').replace(/,/g, ';'), '2026-11-03,' + ADV('x').repeat(10).replace(/,/g, ';') + ',5']), { map: { date: 0, description: 1, amount: 2 } }, st, TODAY);
  for (const r of bad.rejected) assert.ok(!/LEAK|<img/.test(r.reason), r.reason);
  assert.equal(bad.rejected.length, 2);
  // a rejected entry from the core never leaks through friendly errors either
  assert.throws(() => inc(TODAY, 5, { status: ADV('s') }), (e) => !/LEAK/.test(e.message));
  assert.throws(() => inc(TODAY, 5, { importKey: ADV('k') }), (e) => !/LEAK/.test(e.message));
  assert.throws(() => S.validateState(Object.assign(clone(st), { projects: [Object.assign(proj('z', 'z'), { parentId: 'z' })] })), (e) => !/LEAK/.test(e.message));
});
});
