// v1.1.0: business records. Scope defaults and the one-time confirmation, migration 1 to 11 into 12, a v1.0.0 backup, downgrade guards for
// every new collection, validation of every new field, invoices (nothing posts without a tap), aging, gross reimbursables, payees and the
// 1099 rules, trips, budgets and rollups, the private vault pairs and the numbers-only digest.
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { L, memAdapter, PASS, E } from './_load.mjs';
import { clone } from './_v070.mjs';
import { buildAdversarial, stripJobFields } from './_adversarial.mjs';

const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), T = live('tax'), B = live('business'), P = live('priv'), M = live('metrics'), V = live('vault'), Mem = live('memory');
const PRIV = 'a private passphrase 99';
const TODAY = '2026-11-14';
let ORIG = null;
const fastDerive = async (pass, salt) => {
  const base = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};
// Hooks live inside the describe blocks that use a vault: all test files share one process (test/index.js).
const fast = () => {
  beforeEach(() => { ORIG = L.vault.deriveKey; L.vault.deriveKey = fastDerive; });
  afterEach(() => { L.vault.deriveKey = ORIG; try { L.priv.close('system'); } catch (e) { /* ignore */ } });
};

const proj = (id, name, o) => Object.assign({ id, name, kind: 'client', status: 'active', nextAction: '', archived: false }, o);
const inc = (date, v, o) => E(Object.assign({ domain: 'money', type: 'income', date, value: v }, o));
const exp = (date, v, o) => E(Object.assign({ domain: 'money', type: 'expense', date, value: v }, o));
const build = (fn) => { const s = S.defaultState(); fn(s); return S.validateState(clone(s)); };
const text = (x) => JSON.stringify(x);
const line = (d, q, c, o) => Object.assign({ description: d, qty: q, unitCents: c }, o);
async function vault(state) {
  S._setAdapter(memAdapter()); S.lock(); await S.init(PASS);
  if (state) await S.replaceState(state);
}

describe('scope: business or personal', () => {
  test('an entry with no scope takes it from its line of work (business kinds are business); an explicit scope wins', () => {
    const s = build((x) => {
      x.projects.push(proj('c', 'Client'), proj('j', 'Day job', { kind: 'job' }));
      x.entries.push(inc('2026-01-01', 10, { id: 'a', projectId: 'c' }), inc('2026-01-01', 10, { id: 'b', projectId: 'j' }), inc('2026-01-01', 10, { id: 'c1' }), inc('2026-01-01', 10, { id: 'd', projectId: 'j', scope: 'business' }), inc('2026-01-01', 10, { id: 'e', projectId: 'c', scope: 'personal' }));
    });
    const biz = B.isBiz(s), by = Object.fromEntries(s.entries.map((e) => [e.id, biz(e)]));
    assert.deepEqual(by, { a: true, b: false, c1: false, d: true, e: false });
    assert.deepEqual(B.scopeCounts(s), { business: 2, personal: 3 });
  });
  test('migration leaves entries as they are and asks once; confirming fixes each scope, setScope changes one', () => {
    const { state } = buildAdversarial(L); const old = clone(state);
    delete old.settings.business; old.schema = 11;
    const m = S.validateState(clone(old));
    const hasMoney = m.entries.some((e) => e.domain === 'money' && (e.type === 'income' || e.type === 'expense'));
    assert.equal(m.settings.business.scopeConfirmed, !hasMoney); assert.ok(hasMoney);
    assert.ok(m.entries.every((e) => e.scope === undefined || old.entries.find((o) => o.id === e.id).scope === e.scope), 'no entry is rewritten');
    const before = B.scopeCounts(m);
    B.confirmScope(m);
    assert.equal(m.settings.business.scopeConfirmed, true); assert.deepEqual(B.scopeCounts(m), before, 'confirming changes no figure');
    assert.ok(m.entries.filter((e) => e.domain === 'money' && (e.type === 'income' || e.type === 'expense')).every((e) => e.scope === 'business' || e.scope === 'personal'));
    const one = m.entries.find((e) => e.domain === 'money' && e.type === 'expense');
    B.setScope(m, [one.id], 'personal'); assert.equal(one.scope, 'personal');
    assert.throws(() => B.setScope(m, [one.id], 'x'));
  });
  test('a fresh install, and a migrated state with no money entries, start confirmed', () => {
    assert.equal(S.defaultState().settings.business.scopeConfirmed, true);
    const old = clone(S.defaultState()); delete old.settings.business; old.schema = 11;
    assert.equal(S.validateState(old).settings.business.scopeConfirmed, true);
  });
});

describe('migration, backups and downgrade guards', () => {
  fast();
  const OLD = { 3: ['projects', 'pipeline'], 4: ['cycle', 'kinds', 'habits', 'habitLog'], 5: ['goals'], 6: ['properties', 'vehicles', 'maintenance', 'renewals', 'documents', 'taxItems'], 7: ['learningItems', 'studySessions', 'takeaways'], 8: ['activities', 'activityCategories'], 9: ['groups', 'people', 'contacts'] };
  const NEWKEYS = ['payees', 'invoices', 'trips', 'taxPayments', 'taxYears', 'homeOffice', 'taxMap'];
  function asSchema(n, st) {
    const o = clone(st); o.schema = n; delete o.priv;
    if (n < 18) stripJobFields(o); // v1.6.0 audit: an older format holds no job fields
    for (const [v, keys] of Object.entries(OLD)) if (Number(v) > n) for (const k of keys) delete o[k];
    if (n < 6) { delete o.settings.home; for (const r of o.recurring || []) delete r.household; }
    if (n < 7) delete o.settings.learning;
    if (n < 4) delete o.settings.health;
    if (n < 2) for (const k of ['accounts', 'recurring', 'budgets', 'categories']) delete o[k];
    if (n < 9) for (const a of o.activities || []) delete a.expenseId;
    if (n < 10) delete o.settings.privAutoLockSec;
    delete o.settings.layouts;
    if (n < 12) {
      for (const k of NEWKEYS) delete o[k];
      delete o.settings.business;
      o.entries = o.entries.filter((e) => e.id !== 'ex2' && e.id !== 'in2');
      for (const p of o.projects || []) { delete p.budgetCents; delete p.budgetPeriod; }
      for (const e of o.entries) for (const k of ['scope', 'billable', 'reimbursable', 'cardPaid', 'billedInvoiceId', 'payeeId']) delete e[k];
    }
    return o;
  }
  const full = () => { const { state } = buildAdversarial(L); const s = clone(state); s.settings.provider = { kind: 'none', baseUrl: '', model: '', apiKey: '' }; return S.validateState(clone(s)); };

  test('schemas 1 to 11 migrate into 12 with no loss, no business records invented, and the scope question asked when money exists', () => {
    const src = full();
    for (let n = 1; n <= 11; n++) {
      const old = asSchema(n, src), oldText = text(old), got = S.validateState(clone(old));
      assert.equal(got.schema, 19); assert.equal(got.sourceSchema, n);
      const gotText = text(got);
      for (const m of new Set(oldText.match(/LEAK mark \d+/g) || [])) assert.ok(gotText.includes(m), 'schema ' + n + ' lost ' + m);
      for (const k of ['payees', 'invoices', 'trips', 'taxPayments']) assert.deepEqual(got[k], [], k);
      assert.deepEqual(got.taxYears, {}); assert.deepEqual(got.homeOffice, {}); assert.deepEqual(got.taxMap, []);
      assert.equal(got.settings.business.scopeConfirmed, false, 'schema ' + n + ': the one-time confirmation is pending');
      assert.equal(got.settings.business.invoiceFormat, 'INV-{NNNN}'); assert.equal(got.settings.business.invoiceNext, 1);
      assert.ok(got.entries.every((e) => e.scope === undefined), 'entries are not rewritten');
    }
  });
  test('a v1.0.0 backup (schema 11) imports cleanly into an empty vault and a stored schema 11 vault migrates on unlock', async () => {
    const eleven = asSchema(11, full());
    const salt = V.newSalt(), key = await ORIG('backup passphrase 1', salt);
    const imp = await V.importBackup('backup passphrase 1', JSON.stringify(await V.makeEnvelope(key, salt, eleven)));
    assert.equal(imp.schema, 19); assert.equal(imp.sourceSchema, 11);
    await vault(null);
    assert.deepEqual(S.droppedData(S.getState(), imp), []);
    await S.replaceState(imp);
    assert.equal(S.getState().schema, 19);
    const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
    const env = await S.exportEnvelope(); const salt2 = V.parseEnvelope(env).salt, key2 = await fastDerive(PASS, salt2);
    await ad.set('envelope', await V.makeEnvelope(key2, salt2, eleven));
    S.lock();
    const st = await S.unlock(PASS);
    assert.equal(st.schema, 19); assert.equal(st.settings.business.scopeConfirmed, false);
    await S.commit(() => {});
    assert.equal((await V.decrypt(key2, await ad.get('envelope'))).schema, 19);
  });
  test('downgrade guards: an older copy cannot silently strip invoices, trips, payees, tax payments, tax years, home office, the tax map, budgets or scopes', async () => {
    const cur = build((s) => {
      T.startDefaultYear(s, 2026);
      s.projects.push(proj('c', 'Client'));
      s.entries.push(exp('2026-01-01', 5, { id: 'x', scope: 'business', category: 'Supplies' }));
      B.addPayee(s, { name: 'Pat' }); B.createInvoice(s, { projectId: 'c', issueDate: TODAY, dueDate: TODAY, lines: [line('x', 1, 100)] });
      B.addTrip(s, { date: TODAY, miles: '5', from: '', to: '', purpose: '' }); T.addPayment(s, { year: 2026, jurisdiction: 'nj', quarter: 1, amountCents: 5, paidOn: TODAY });
      B.setHomeOffice(s, 2026, { squareFeet: 10, monthsUsed: 1 }); T.setLineMap(s, 'Gym', 'other'); B.setBudget(s, 'c', 5000, 'month');
    });
    const old = (st) => S.validateState(asSchema(11, st));
    const names = S.droppedData(cur, old(cur));
    for (const n of ['invoices', 'mileage trips', 'payees', 'estimated tax payments', 'tax year profiles', 'home-office figures', 'tax line mappings', 'project budgets', 'business expense and income marks']) assert.ok(names.includes(n), n + ' in ' + names);
    assert.match(S.lossText(cur, old(cur)), /invoice/);
    const one = (fn, name) => { const d = S.droppedData(build(fn), S.validateState(asSchema(11, build(() => {})))); assert.ok(d.includes(name), name + ' in ' + d); };
    one((s) => { B.createInvoice(s, { issueDate: TODAY, dueDate: TODAY, lines: [] }); }, 'invoices');
    one((s) => { B.addTrip(s, { date: TODAY, miles: '5' }); }, 'mileage trips');
    one((s) => { B.addPayee(s, { name: 'Pat' }); }, 'payees');
    one((s) => { T.addPayment(s, { year: 2026, jurisdiction: 'nj', quarter: 1, amountCents: 5, paidOn: TODAY }); }, 'estimated tax payments');
    one((s) => { T.startDefaultYear(s, 2026); }, 'tax year profiles');
    one((s) => { B.setHomeOffice(s, 2026, { squareFeet: 10, monthsUsed: 1 }); }, 'home-office figures');
    one((s) => { T.setLineMap(s, 'Gym', 'other'); }, 'tax line mappings');
    assert.deepEqual(S.droppedData(build(() => {}), old(build(() => {}))), []);
    await vault(cur);
    await assert.rejects(S.replaceState(old(cur)), (e) => e.code === 'OLDER_FORMAT' && /invoice/.test(e.message));
    assert.equal(S.getState().invoices.length, 1);
    await S.replaceState(old(cur), { allowWorkLoss: true });
    assert.deepEqual(S.getState().invoices, []);
    assert.throws(() => S.validateState(Object.assign(S.defaultState(), { schema: 20 })), /schema/);
  });
});

describe('validation of every new field', () => {
  const ok = () => { const s = S.defaultState(); s.projects.push(proj('c', 'Client')); return s; };
  const inv = (o) => Object.assign({ id: 'i1', number: 'INV-0001', projectId: 'c', issueDate: '2026-01-01', dueDate: '2026-01-31', lines: [line('a', 1, 100)], status: 'draft', notes: '' }, o);
  const bad = (fn, why) => assert.throws(() => S.validateState(clone((() => { const s = ok(); fn(s); return s; })())), undefined, why);
  const good = (fn) => S.validateState(clone((() => { const s = ok(); fn(s); return s; })()));
  test('invoices: shape, dates, status rules, numbers unique (case-insensitive), lines capped, totals bounded, prototype keys', () => {
    good((s) => { s.invoices = [inv()]; });
    bad((s) => { s.invoices = [inv(), inv({ id: 'i2' })]; }, 'duplicate number');
    bad((s) => { s.invoices = [inv(), inv({ id: 'i2', number: 'inv-0001' })]; }, 'duplicate number differing in case');
    bad((s) => { s.invoices = [inv(), inv()]; }, 'duplicate id');
    bad((s) => { s.invoices = [inv({ dueDate: '2025-12-31' })]; }, 'due before issue');
    bad((s) => { s.invoices = [inv({ issueDate: '2026-02-30' })]; }, 'bad date');
    bad((s) => { s.invoices = [inv({ status: 'open' })]; }, 'status');
    bad((s) => { s.invoices = [inv({ status: 'paid' })]; }, 'paid without a date');
    bad((s) => { s.invoices = [inv({ paidOn: '2026-01-02' })]; }, 'a paid date on a draft');
    bad((s) => { s.invoices = [inv({ lines: Array.from({ length: 51 }, () => line('a', 1, 1)) })]; }, 'too many lines');
    bad((s) => { s.invoices = [inv({ lines: [line('a', 0, 100)] })]; }, 'zero quantity');
    bad((s) => { s.invoices = [inv({ lines: [line('a', 1.005, 100)] })]; }, 'three decimals');
    bad((s) => { s.invoices = [inv({ lines: [line('a', 1, -1)] })]; }, 'negative price');
    bad((s) => { s.invoices = [inv({ lines: [line('a', 1, 1.5)] })]; }, 'fractional cents');
    bad((s) => { s.invoices = [inv({ lines: [line('a', 1, 1e11), line('b', 1, 1e11)] })]; }, 'total too large');
    bad((s) => { s.invoices = [inv({ number: '' })]; }, 'empty number');
    bad((s) => { s.invoices = Array.from({ length: 5001 }, (_, i) => inv({ id: 'i' + i, number: 'N' + i })); }, 'cap');
    const raw = JSON.parse('{"id":"i1","number":"N","issueDate":"2026-01-01","dueDate":"2026-01-02","lines":[],"status":"draft","notes":"","__proto__":{"polluted":1}}');
    assert.throws(() => S.validateState(clone(Object.assign(ok(), { invoices: [raw] }))), /forbidden key/); assert.ok(!({}).polluted);
    const cleaned = good((s) => { s.invoices = [inv({ extra: 'x', lines: [Object.assign(line('a', 1, 1), { junk: 1 })] })]; });
    assert.equal(cleaned.invoices[0].extra, undefined); assert.equal(cleaned.invoices[0].lines[0].junk, undefined);
  });
  test('invoices: merged views allow a number clash between public and private halves, and dangling links are dropped', () => {
    const a = B.cleanInvoices([inv(), inv({ id: 'i2' })], { merged: true }); assert.equal(a.length, 2);
    const s = good((x) => { x.invoices = [inv({ projectId: 'ghost', incomeId: 'ghost' })]; });
    assert.equal(s.invoices[0].projectId, undefined); assert.equal(s.invoices[0].incomeId, undefined);
    const e = good((x) => { x.entries.push(exp('2026-01-01', 5, { id: 'e1', billedInvoiceId: 'nope', payeeId: 'nope' })); });
    assert.equal(e.entries[0].billedInvoiceId, undefined); assert.equal(e.entries[0].payeeId, undefined);
  });
  test('trips: miles one decimal and in range, dates, line link, caps and text', () => {
    const tr = (o) => Object.assign({ id: 't1', date: '2026-01-01', from: 'a', to: 'b', miles: 12.3, purpose: 'p', roundTrip: false }, o);
    good((s) => { s.trips = [tr()]; });
    for (const o of [{ miles: 0 }, { miles: 0.05 }, { miles: 10000 }, { miles: 1.23 }, { miles: '5' }, { date: '2026-13-01' }, { from: 'x'.repeat(121) }, { purpose: 'x'.repeat(201) }, { roundTrip: 'yes' }]) bad((s) => { s.trips = [tr(o)]; }, JSON.stringify(o));
    bad((s) => { s.trips = [tr(), tr()]; }, 'duplicate id');
    bad((s) => { s.trips = Array.from({ length: 10001 }, (_, i) => tr({ id: 't' + i })); }, 'cap');
    assert.equal(good((s) => { s.trips = [tr({ projectId: 'ghost' })]; }).trips[0].projectId, undefined);
  });
  test('payees, tax payments, tax years, home office, the tax map and settings', () => {
    const pe = (o) => Object.assign({ id: 'p1', name: 'Pat', tinOnFile: false, archived: false }, o);
    good((s) => { s.payees = [pe()]; }); bad((s) => { s.payees = [pe(), pe()]; }); bad((s) => { s.payees = [pe({ name: '' })]; }); bad((s) => { s.payees = [pe({ w9Date: '2026-02-31' })]; });
    bad((s) => { s.payees = Array.from({ length: 1001 }, (_, i) => pe({ id: 'p' + i })); }, 'cap');
    const tp = (o) => Object.assign({ id: 'x1', year: 2026, jurisdiction: 'federal', quarter: 1, amountCents: 100, paidOn: '2026-04-01' }, o);
    good((s) => { s.taxPayments = [tp()]; });
    for (const o of [{ quarter: 5 }, { jurisdiction: 'x' }, { amountCents: 0 }, { amountCents: 1.5 }, { year: 1800 }, { paidOn: 'x' }]) bad((s) => { s.taxPayments = [tp(o)]; }, JSON.stringify(o));
    bad((s) => { s.taxPayments = [tp(), tp()]; });
    bad((s) => { s.taxPayments = Array.from({ length: 2001 }, (_, i) => tp({ id: 'x' + i })); }, 'cap');
    good((s) => { s.taxYears = { 2026: T.defaultProfile(2026) }; }); bad((s) => { s.taxYears = { 1: T.defaultProfile(2026) }; }); bad((s) => { s.taxYears = { 2026: Object.assign(T.defaultProfile(2026), { ssWageBase: 'x' }) }; });
    good((s) => { s.homeOffice = { 2026: { squareFeet: 100, monthsUsed: 12 } }; });
    bad((s) => { s.homeOffice = { 2026: { squareFeet: 100, monthsUsed: 13 } }; }); bad((s) => { s.homeOffice = { 2026: { squareFeet: -1, monthsUsed: 1 } }; });
    good((s) => { s.taxMap = [{ category: 'Gym', line: 'other' }]; }); bad((s) => { s.taxMap = [{ category: 'Gym', line: 'car' }]; }); bad((s) => { s.taxMap = [{ category: '', line: 'other' }]; });
    const protoMap = JSON.parse('{"__proto__":{"x":1},"2026":{"squareFeet":1,"monthsUsed":1}}');
    assert.throws(() => S.validateState(clone(Object.assign(ok(), { homeOffice: protoMap }))));
    bad((s) => { s.settings.business.invoiceFormat = 'INV'; }, 'no counter'); bad((s) => { s.settings.business.invoiceFormat = 'INV-{NNNN}-{X}'; }, 'unknown token');
    bad((s) => { s.settings.business.invoiceNext = 0; }); bad((s) => { s.settings.business.name = 'x'.repeat(121); });
    bad((s) => { s.projects[0].budgetCents = -1; }); bad((s) => { s.projects[0].budgetCents = 100; s.projects[0].budgetPeriod = 'week'; });
    good((s) => { s.projects[0].budgetCents = 100; s.projects[0].budgetPeriod = 'month'; });
  });
  test('entry flags: scope whitelist, flags on expenses only, links', () => {
    assert.throws(() => exp('2026-01-01', 5, { scope: 'x' }));
    const e = exp('2026-01-01', 5, { billable: true, reimbursable: true, cardPaid: true, payeeId: 'p' });
    assert.deepEqual([e.billable, e.reimbursable, e.cardPaid, e.payeeId], [true, true, true, 'p']);
    const i = inc('2026-01-01', 5, { billable: true, reimbursable: true, cardPaid: true });
    assert.deepEqual([i.billable, i.reimbursable, i.cardPaid], [undefined, undefined, undefined], 'income takes no expense flags');
  });
});

describe('invoices: nothing posts without a tap', () => {
  const base = () => { const s = S.defaultState(); T.startDefaultYear(s, 2026); s.projects.push(proj('c', 'Client A')); return s; };
  test('numbers follow the format and counter, skip a taken number, and can be set by hand', () => {
    const s = base(); s.settings.business.invoiceFormat = '{YYYY}-{NNN}'; s.settings.business.invoiceNext = 7;
    const a = B.createInvoice(s, { issueDate: '2026-03-01', dueDate: '2026-03-31', lines: [] });
    assert.equal(a.number, '2026-007'); assert.equal(s.settings.business.invoiceNext, 8);
    s.settings.business.invoiceNext = 7; const b = B.createInvoice(s, { issueDate: '2026-03-01', dueDate: '2026-03-31', lines: [] });
    assert.equal(b.number, '2026-008', 'a taken number is skipped'); assert.equal(s.settings.business.invoiceNext, 9);
    assert.throws(() => B.createInvoice(s, { number: '2026-007', issueDate: '2026-03-01', dueDate: '2026-03-31', lines: [] }), /already used/);
    assert.throws(() => B.createInvoice(s, { number: '2026-007'.toLowerCase(), issueDate: '2026-03-01', dueDate: '2026-03-31', lines: [] }), /already used/);
    const c = B.createInvoice(s, { number: 'HAND-1', issueDate: '2026-03-01', dueDate: '2026-03-31', lines: [] }); assert.equal(c.number, 'HAND-1'); assert.equal(s.settings.business.invoiceNext, 9);
    assert.equal(B.formatNumber('{YY}/{NN}', 3, '2026-01-01'), '26/03');
  });
  test('line totals are quantity times price rounded half away from zero, and the invoice total is their sum', () => {
    assert.equal(B.lineTotal(line('a', 1.5, 333)), 500);      // 499.5 -> 500
    assert.equal(B.lineTotal(line('a', 0.01, 50)), 1);        // 0.5 -> 1
    assert.equal(B.lineTotal(line('a', 2.25, 1001)), 2252);   // 2252.25
    assert.equal(B.invoiceTotal({ lines: [line('a', 1.5, 333), line('b', 3, 100)] }), 800);
  });
  test('create, send, expected income, paid, income received: each is a tap, the income counts once, and nothing is created by the previous step', () => {
    const s = base();
    const inv = B.createInvoice(s, { projectId: 'c', issueDate: '2026-02-01', dueDate: '2026-03-03', lines: [line('Work', 2, 50000)] });
    assert.equal(s.entries.length, 0, 'a draft creates no income'); assert.throws(() => B.createExpectedIncome(s, inv.id), /sent/);
    B.markSent(s, inv.id); assert.equal(s.entries.length, 0, 'sending creates no income');
    const e = B.createExpectedIncome(s, inv.id);
    assert.equal(e.status, 'expected'); assert.equal(e.value, 1000); assert.equal(e.dueDate, '2026-03-03'); assert.equal(e.scope, 'business'); assert.equal(inv.incomeId, e.id);
    assert.throws(() => B.createExpectedIncome(s, inv.id), /already/);
    assert.equal(T.compute(s, 2026).incomeCents, 0, 'expected income is not counted');
    B.markPaid(s, inv.id, '2026-03-10'); assert.equal(s.entries.find((x) => x.id === e.id).status, 'expected', 'paid does not receive the income');
    assert.equal(T.compute(s, 2026).incomeCents, 0);
    const r = B.settleIncome(s, inv.id);
    assert.equal(r.id, e.id); assert.equal(r.status, 'received'); assert.equal(r.date, '2026-03-10'); assert.equal(s.entries.length, 1);
    assert.equal(T.compute(s, 2026).incomeCents, 100000, 'counted once');
    assert.throws(() => B.settleIncome(s, inv.id), /already counted/); assert.equal(s.entries.length, 1);
  });
  test('paid with no expected income creates one received entry only on the settle tap; zero-total invoices create none', () => {
    const s = base();
    const inv = B.createInvoice(s, { issueDate: '2026-02-01', dueDate: '2026-03-03', lines: [line('Work', 1, 12345)] });
    B.markSent(s, inv.id); B.markPaid(s, inv.id, '2026-02-20'); assert.equal(s.entries.length, 0);
    const e = B.settleIncome(s, inv.id); assert.equal(e.value, 123.45); assert.equal(e.status, undefined); assert.equal(s.entries.length, 1);
    const z = B.createInvoice(s, { issueDate: '2026-02-01', dueDate: '2026-03-03', lines: [line('Free', 1, 0)] });
    B.markSent(s, z.id); assert.throws(() => B.createExpectedIncome(s, z.id), /more than zero/);
    assert.throws(() => B.markSent(s, B.createInvoice(s, { issueDate: '2026-02-01', dueDate: '2026-03-03', lines: [] }).id), /at least one line/);
  });
  test('void unlinks (income kept), paid cannot be voided, delete frees billed expenses, only drafts are edited', () => {
    const s = base();
    s.entries.push(exp('2026-01-05', 20, { id: 'x1', projectId: 'c', billable: true, scope: 'business' }));
    const inv = B.createInvoice(s, { projectId: 'c', issueDate: '2026-02-01', dueDate: '2026-03-03', lines: [] });
    B.addBillable(s, inv.id, 'x1'); assert.equal(s.entries[0].billedInvoiceId, inv.id); assert.equal(inv.lines[0].unitCents, 2000); assert.equal(inv.lines[0].expenseId, 'x1');
    assert.throws(() => B.addBillable(s, inv.id, 'x1'), /already/);
    B.editDraft(s, inv.id, { lines: [] }); assert.equal(s.entries[0].billedInvoiceId, undefined, 'removing the line frees the expense');
    B.addBillable(s, inv.id, 'x1'); B.markSent(s, inv.id); const e = B.createExpectedIncome(s, inv.id);
    assert.throws(() => B.addBillable(s, inv.id, 'x1'), /draft/); assert.throws(() => B.editDraft(s, inv.id, { notes: 'x' }), /draft/);
    assert.throws(() => B.deleteInvoice(s, inv.id), /Void/);
    B.voidInvoice(s, inv.id); const v = s.invoices.find((x) => x.id === inv.id); assert.equal(v.status, 'void'); assert.equal(v.incomeId, undefined); assert.ok(s.entries.some((x) => x.id === e.id), 'the income entry is never deleted');
    assert.equal(s.entries.find((x) => x.id === 'x1').billedInvoiceId, undefined); assert.throws(() => B.voidInvoice(s, inv.id), /Already/);
    B.deleteInvoice(s, inv.id); assert.equal(s.invoices.length, 0);
    const p = B.createInvoice(s, { issueDate: '2026-02-01', dueDate: '2026-03-03', lines: [line('a', 1, 1)] }); B.markPaid(s, p.id, '2026-02-02'); assert.throws(() => B.voidInvoice(s, p.id), /paid/);
  });
  test('billable expenses: only billable, only of the same line of work, never netted (gross treatment)', () => {
    const s = base(); s.projects.push(proj('d', 'Client B'));
    s.entries.push(exp('2026-01-05', 20, { id: 'x1', projectId: 'c', billable: true, scope: 'business', category: 'Supplies' }), exp('2026-01-06', 30, { id: 'x2', projectId: 'c', scope: 'business', category: 'Supplies' }),
      exp('2026-01-07', 40, { id: 'x3', projectId: 'd', billable: true, scope: 'business', category: 'Supplies' }), inc('2026-02-10', 20, { id: 'in', scope: 'business', projectId: 'c' }));
    const inv = B.createInvoice(s, { projectId: 'c', issueDate: '2026-02-01', dueDate: '2026-03-03', lines: [] });
    assert.throws(() => B.addBillable(s, inv.id, 'x2'), /not marked billable/); assert.throws(() => B.addBillable(s, inv.id, 'x3'), /another line/);
    assert.deepEqual(B.unbilled(s, 'c').map((e) => e.id), ['x1']); assert.deepEqual(B.unbilled(s, null).map((e) => e.id).sort(), ['x1', 'x3']);
    B.addBillable(s, inv.id, 'x1'); assert.deepEqual(B.unbilled(s, 'c'), []);
    const c = T.compute(s, 2026);
    assert.equal(c.lines.find((l) => l.id === 'supplies').cents, 2000 + 3000 + 4000, 'the billed expense keeps its own deduction');
    assert.equal(c.incomeCents, 2000);
  });
  test('reimbursables are shown gross: the deduction is never reduced and the reimbursed total is information only', () => {
    const s = base();
    s.entries.push(exp('2026-01-05', 80, { id: 'x1', projectId: 'c', billable: true, reimbursable: true, scope: 'business', category: 'Travel' }), exp('2026-01-06', 20, { id: 'x2', scope: 'business', category: 'Travel', reimbursable: true }));
    const inv = B.createInvoice(s, { projectId: 'c', issueDate: '2026-02-01', dueDate: '2026-03-03', lines: [line('Fee', 1, 100000)] });
    B.addBillable(s, inv.id, 'x1'); B.markSent(s, inv.id);
    let c = T.compute(s, 2026); assert.equal(c.reimbursedCents, 0); assert.equal(c.lines.find((l) => l.id === 'travel').cents, 10000);
    B.markPaid(s, inv.id, '2026-03-01'); B.settleIncome(s, inv.id);
    c = T.compute(s, 2026);
    assert.equal(c.lines.find((l) => l.id === 'travel').cents, 10000, 'gross: 80 + 20');
    assert.equal(c.reimbursedCents, 8000, 'only the billed reimbursable on a paid invoice');
    assert.equal(c.incomeCents, 100000 + 8000, 'the invoice counts as income once, with the expense line inside it');
    assert.equal(c.profitCents, 108000 - 10000);
  });
});

describe('aging', () => {
  test('buckets at every boundary, open means sent, and only sent invoices count', () => {
    const due = '2026-06-30', mk = (id, n, status) => ({ id, number: n, issueDate: '2026-01-01', dueDate: due, lines: [line('a', 1, 100)], status, notes: '' });
    const s = S.defaultState(); s.invoices = [mk('a', 'A', 'sent'), mk('d', 'D', 'draft'), mk('v', 'V', 'void'), Object.assign(mk('p', 'P', 'paid'), { paidOn: '2026-02-01' })];
    const day = (n) => L.home.dates.addDays(due, n);
    const at = (n) => B.aging(s, day(n));
    assert.equal(at(-5).buckets.current.count, 1); assert.equal(at(0).buckets.current.count, 1, 'due today is current'); assert.equal(at(0).overdueCount, 0);
    assert.equal(at(1).buckets.d1_30.count, 1); assert.equal(at(1).overdueCount, 1); assert.equal(at(30).buckets.d1_30.count, 1);
    assert.equal(at(31).buckets.d31_60.count, 1); assert.equal(at(60).buckets.d31_60.count, 1);
    assert.equal(at(61).buckets.d61_90.count, 1); assert.equal(at(90).buckets.d61_90.count, 1);
    assert.equal(at(91).buckets.over90.count, 1); assert.equal(at(400).buckets.over90.count, 1);
    for (const n of [-5, 0, 1, 30, 31, 60, 61, 90, 91]) { const a = at(n); assert.equal(Object.values(a.buckets).reduce((x, b) => x + b.count, 0), 1); assert.equal(a.openCount, 1); assert.equal(a.openCents, 100); }
    assert.deepEqual(B.BUCKETS.map((b) => b[0]), ['current', 'd1_30', 'd31_60', 'd61_90', 'over90']);
  });
});

describe('payees and 1099-NEC', () => {
  test('a tax ID is never stored: SSN and EIN shapes in a payee name are refused, and the schema has no field for one', () => {
    const s = S.defaultState();
    for (const n of ['123-45-6789', 'Pat 123456789', '12-3456789', 'EIN 12-3456789', 'Pat 123 45 6789']) assert.throws(() => B.addPayee(s, { name: n }), undefined, n);
    const p = B.addPayee(s, { name: 'Pat Contractor', tinOnFile: true, w9Date: '2026-01-02' });
    assert.deepEqual(Object.keys(p).sort(), ['archived', 'id', 'name', 'tinOnFile', 'w9Date']);
    assert.throws(() => B.updatePayee(s, p.id, { name: '123-45-6789' })); assert.equal(s.payees[0].name, 'Pat Contractor');
    const rest = clone(s); rest.payees[0].taxId = '123-45-6789'; assert.equal(S.validateState(rest).payees[0].taxId, undefined, 'unknown keys are dropped');
  });
  test('totals per payee count business expenses of the year, leave out card payments, and flag at the profile threshold', () => {
    const s = S.defaultState(); T.startDefaultYear(s, 2026);
    const a = B.addPayee(s, { name: 'Ann' }), b = B.addPayee(s, { name: 'Bo' });
    s.entries.push(exp('2026-02-01', 1500, { scope: 'business', payeeId: a.id }), exp('2026-03-01', 499.99, { scope: 'business', payeeId: a.id }), exp('2026-03-02', 600, { scope: 'business', payeeId: a.id, cardPaid: true }),
      exp('2026-03-03', 2000, { scope: 'business', payeeId: b.id }), exp('2026-03-04', 100, { scope: 'personal', payeeId: b.id }), exp('2025-12-31', 900, { scope: 'business', payeeId: b.id }));
    const pt = T.payeeTotals(S.validateState(clone(s)), 2026), by = Object.fromEntries(pt.rows.map((r) => [r.payeeId, r]));
    assert.equal(by[a.id].totalCents, 199999); assert.equal(by[a.id].reaches, false); assert.equal(by[a.id].cardCents, 60000); assert.equal(by[a.id].nearCents, 1);
    assert.equal(by[b.id].totalCents, 200000); assert.equal(by[b.id].reaches, true, 'at the threshold counts');
    assert.equal(pt.thresholdCents, 200000); assert.equal(pt.due.date, '2027-02-01'); assert.equal(pt.rows[0].payeeId, b.id, 'largest first');
    const t2 = S.validateState(clone(s)); T.setProfile(t2, 2026, Object.assign({}, t2.taxYears['2026'], { nec1099Threshold: 250000 }));
    assert.equal(T.payeeTotals(t2, 2026).rows.every((r) => !r.reaches), true, 'the threshold comes from the profile');
  });
  test('assign, unlink on delete and the expense-only rule', () => {
    const s = S.defaultState(); const p = B.addPayee(s, { name: 'Pat' });
    s.entries.push(exp('2026-02-01', 5, { id: 'x' }), inc('2026-02-01', 5, { id: 'i' }));
    B.assignPayee(s, 'x', p.id, { cardPaid: true }); assert.equal(s.entries[0].payeeId, p.id); assert.equal(s.entries[0].cardPaid, true);
    assert.throws(() => B.assignPayee(s, 'i', p.id)); assert.throws(() => B.assignPayee(s, 'x', 'ghost'));
    assert.equal(B.deletePayee(s, p.id), 1); assert.equal(s.entries[0].payeeId, undefined); assert.equal(s.entries.length, 2, 'expenses are kept');
  });
});

describe('trips, home office and the secrets guard', () => {
  test('trips are logged, deleted and refused when their text looks like a secret', () => {
    const s = S.defaultState();
    const t = B.addTrip(s, { date: '2026-06-30', from: 'Office', to: 'Client', miles: '12.3', purpose: 'Meeting' }); assert.equal(t.miles, 12.3);
    assert.throws(() => B.addTrip(s, { date: '2026-06-30', miles: '1', purpose: 'card 4111 1111 1111 1111' }));
    assert.throws(() => B.addTrip(s, { date: '2026-06-30', miles: '1.25' })); assert.throws(() => B.addTrip(s, { date: '2026-06-30', miles: '0' })); assert.throws(() => B.addTrip(s, { date: 'x', miles: '1' }));
    B.deleteTrip(s, t.id); assert.equal(s.trips.length, 0); assert.throws(() => B.deleteTrip(s, t.id));
    assert.throws(() => B.saveSettings(s, { name: 'Acme', address: '4111 1111 1111 1111' }));
    assert.throws(() => B.createInvoice(s, { issueDate: '2026-01-01', dueDate: '2026-01-02', lines: [], notes: 'ssn 123-45-6789' }));
    assert.throws(() => B.createInvoice(s, { issueDate: '2026-01-01', dueDate: '2026-01-02', lines: [line('card 4111 1111 1111 1111', 1, 1)] }));
    assert.throws(() => T.addPayment(s, { year: 2026, jurisdiction: 'nj', quarter: 1, amountCents: 1, paidOn: '2026-01-01', confirmation: '4111 1111 1111 1111' }));
  });
  test('home office limits: years, months, square feet', () => {
    const s = S.defaultState();
    assert.deepEqual(B.setHomeOffice(s, 2026, { squareFeet: 200, monthsUsed: 6 }), { squareFeet: 200, monthsUsed: 6 });
    assert.throws(() => B.setHomeOffice(s, 2026, { squareFeet: 200, monthsUsed: 13 })); assert.throws(() => B.setHomeOffice(s, 2026, { squareFeet: -1, monthsUsed: 1 }));
    assert.throws(() => B.setHomeOffice(s, 2026, { squareFeet: 1.5, monthsUsed: 1 }));
  });
});

describe('budgets per project and rollups', () => {
  const mk = () => build((s) => {
    s.projects.push(proj('par', 'Parent', { kind: 'venture' }), proj('k1', 'Kid one', { parentId: 'par' }), proj('k2', 'Kid two', { parentId: 'par' }), proj('solo', 'Solo'));
    s.entries.push(exp('2026-11-02', 40, { projectId: 'k1' }), exp('2026-11-03', 30, { projectId: 'k2' }), exp('2026-10-30', 100, { projectId: 'k1' }), exp('2026-11-04', 5, { projectId: 'par' }),
      exp('2026-11-05', 12.5, { projectId: 'solo' }), inc('2026-11-05', 999, { projectId: 'solo' }), exp('2026-11-06', 7, {}));
  });
  test('a monthly budget counts this month only, a project budget all time, over is a status and income never counts', () => {
    const s = mk();
    B.setBudget(s, 'k1', 5000, 'month'); B.setBudget(s, 'solo', 1250, 'project');
    const k1 = B.budgetFor(s, 'k1', '2026-11-14'); assert.deepEqual([k1.actualCents, k1.budgetCents, k1.remainingCents, k1.status, k1.period], [4000, 5000, 1000, 'ok', 'month']);
    assert.equal(B.budgetFor(s, 'k1', '2026-10-31').actualCents, 10000); assert.equal(B.budgetFor(s, 'k1', '2026-10-31').status, 'over');
    const so = B.budgetFor(s, 'solo', '2026-11-14'); assert.deepEqual([so.actualCents, so.status, so.remainingCents], [1250, 'ok', 0], 'equal is not over');
    B.setBudget(s, 'solo', 1249, 'project'); assert.equal(B.budgetFor(s, 'solo', '2026-11-14').status, 'over');
    assert.equal(B.budgetFor(s, 'k2', '2026-11-14').status, 'none'); assert.equal(B.budgetFor(s, 'k2', '2026-11-14').budgetCents, null); assert.equal(B.budgetFor(s, 'ghost', '2026-11-14'), null);
    B.setBudget(s, 'k1', 0); assert.equal(s.projects.find((p) => p.id === 'k1').budgetCents, undefined);
    assert.throws(() => B.setBudget(s, 'k1', 100, 'week')); assert.throws(() => B.setBudget(s, 'ghost', 100, 'month')); assert.throws(() => B.setBudget(s, 'k1', 1.5, 'month'));
  });
  test('a parent rollup uses the parent budget, else the children\'s sum when they share a period, else none', () => {
    const s = mk();
    B.setBudget(s, 'k1', 5000, 'month'); B.setBudget(s, 'k2', 2500, 'month');
    let r = B.budgetRollup(s, 'par', '2026-11-14'); assert.deepEqual([r.budgetCents, r.actualCents, r.status, r.period], [7500, 7500, 'ok', 'month'], 'own 5 + kid one 40 + kid two 30 = 75.00');
    B.setBudget(s, 'k2', 2400, 'month'); r = B.budgetRollup(s, 'par', '2026-11-14'); assert.deepEqual([r.budgetCents, r.status], [7400, 'over']);
    B.setBudget(s, 'k2', 2400, 'project'); r = B.budgetRollup(s, 'par', '2026-11-14'); assert.equal(r.budgetCents, null); assert.equal(r.status, 'none', 'mixed periods have no rollup budget');
    B.setBudget(s, 'par', 10000, 'project'); r = B.budgetRollup(s, 'par', '2026-11-14'); assert.deepEqual([r.budgetCents, r.actualCents, r.period], [10000, 17500, 'project'], 'parent budget wins; project period counts all time');
    assert.equal(B.budgetRollup(s, 'ghost', '2026-11-14'), null);
  });
});

describe('the private vault and business records', () => {
  fast();
  test('an invoice and its income entry move together, an expense and its payee follow, and the pair rule holds both ways', async () => {
    const s = build((x) => {
      T.startDefaultYear(x, 2026); x.projects.push(proj('c', 'Client'));
      const inv = B.createInvoice(x, { projectId: 'c', issueDate: '2026-02-01', dueDate: '2026-03-03', lines: [line('Work', 1, 1000)] });
      B.markSent(x, inv.id); B.createExpectedIncome(x, inv.id);
      B.addPayee(x, { name: 'Pat' }); x.entries.push(exp('2026-02-02', 5, { id: 'x1', scope: 'business', payeeId: x.payees[0].id }));
    });
    await vault(s); await P.setUp(PRIV);
    const iid = S.getState().invoices[0].id, eid = S.getState().invoices[0].incomeId;
    await P.moveIn('invoices', iid, { children: true });
    assert.ok(P.isPrivate('entries', eid), 'the income entry moved with its invoice');
    await P.moveOut('entries', eid, { children: true });
    assert.ok(!P.isPrivate('invoices', iid), 'a pair moves together out as well');
    await P.moveIn('payees', S.getState().payees[0].id, { children: true });
    assert.ok(P.isPrivate('entries', 'x1'), 'a payee takes its expenses');
    P.close();
    assert.equal(T.compute(S.getState(), 2026).blocked, true);
    assert.equal(S.getState().payees.length, 0);
  });
  test('a business line of work, trips and tax payments in the vault each refuse the figures when it is closed', async () => {
    for (const mv of [['projects', 'c'], ['trips', 't'], ['taxPayments', 'tp']]) {
      const s = build((x) => {
        T.startDefaultYear(x, 2026); x.projects.push(proj('c', 'Client'));
        x.entries.push(inc('2026-02-01', 10, { projectId: 'c' }));
        x.trips.push({ id: 't', date: '2026-02-02', from: '', to: '', miles: 3, purpose: '', roundTrip: false });
        x.taxPayments.push({ id: 'tp', year: 2026, jurisdiction: 'nj', quarter: 1, amountCents: 5, paidOn: '2026-04-01' });
      });
      await vault(s); await P.setUp(PRIV);
      assert.equal(T.compute(S.getState(), 2026).blocked, false);
      await P.moveIn(mv[0], mv[1], { children: false }); P.close();
      assert.equal(T.compute(S.getState(), 2026).blocked, true, mv[0]);
      P.close('system');
    }
  });
  test('a private value never appears in the closed state, the digest or the AI prompt', async () => {
    const s = build((x) => { T.startDefaultYear(x, 2026); x.entries.push(inc('2026-02-01', 10, { id: 'i1', scope: 'business', title: 'SECRETCLIENT' })); B.addPayee(x, { name: 'SECRETPAYEE' }); });
    await vault(s); await P.setUp(PRIV);
    await P.moveIn('entries', 'i1', {}); await P.moveIn('payees', S.getState().payees[0].id, {});
    P.close();
    const closed = S.getState(); assert.ok(!text(closed).includes('SECRETCLIENT') && !text(closed).includes('SECRETPAYEE'));
    const dg = M.weeklyDigest(closed, '2026-01-26'); assert.ok(!text(dg).includes('SECRET'));
  });
});

describe('the digest carries numbers only', () => {
  test('open invoices, overdue and tax numbers; no invoice text, payee names, trip text or notes', () => {
    const s = build((x) => {
      T.startDefaultYear(x, 2026); x.projects.push(proj('c', 'ClientNameZ'));
      x.entries.push(inc('2026-01-05', 1000, { scope: 'business', title: 'TITLEZ' }));
      const inv = B.createInvoice(x, { projectId: 'c', issueDate: '2026-01-01', dueDate: '2026-01-10', lines: [line('LINEZ', 1, 5000)], notes: 'NOTEZ' }); B.markSent(x, inv.id);
      B.addPayee(x, { name: 'PAYEEZ' }); B.addTrip(x, { date: '2026-01-06', from: 'FROMZ', to: 'TOZ', miles: '5', purpose: 'WHYZ' }); T.addPayment(x, { year: 2026, jurisdiction: 'nj', quarter: 1, amountCents: 5, paidOn: '2026-01-07', confirmation: 'CONFZ' });
      x.settings.business.name = 'BIZNAMEZ';
    });
    const dg = M.weeklyDigest(s, '2026-01-12');
    assert.equal(dg.business.openInvoices, 1); assert.equal(dg.business.openInvoiceCents, 5000); assert.equal(dg.business.overdueInvoices, 1);
    assert.equal(typeof dg.business.tax.profitCents, 'number'); assert.equal(dg.business.tax.estimatedTaxCents, undefined, 'no rate entered: no estimate');
    for (const w of ['TITLEZ', 'LINEZ', 'NOTEZ', 'PAYEEZ', 'FROMZ', 'TOZ', 'WHYZ', 'CONFZ', 'BIZNAMEZ', 'ClientNameZ']) assert.ok(!text(dg).includes(w), w);
    const prompt = text(Mem.buildPrompt(s, 1, { from: '2026-01-12', to: '2026-01-18' }));
    assert.match(prompt, /business detail/);
    for (const w of ['TITLEZ', 'LINEZ', 'NOTEZ', 'PAYEEZ', 'FROMZ', 'TOZ', 'WHYZ', 'CONFZ', 'BIZNAMEZ']) assert.ok(!prompt.includes(w), w);
  });
});
