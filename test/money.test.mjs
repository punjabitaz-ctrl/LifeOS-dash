import { test } from 'node:test';
import assert from 'node:assert/strict';
import { L, memAdapter, PASS, E } from './_load.mjs';
import { build, buildAll } from '../build.mjs';

const S = L.store, M = L.metrics;
const st = () => S.defaultState();
const bal = (title, value, date, extra) => E(Object.assign({ domain: 'assets', type: 'balance', title, value, date }, extra));
const acct = (id, name, kind, liability, archived = false) => ({ id, name, kind, liability, archived });
const exp = (value, date, category, title) => E(Object.assign({ domain: 'money', type: 'expense', value, date, category }, title ? { title } : {}));
const inc = (value, date, category) => E({ domain: 'money', type: 'income', value, date, category });
const TODAY = '2026-11-12';

// ---- migration ----
function schema1() {
  const s = st();
  delete s.accounts; delete s.recurring; delete s.budgets; delete s.categories;
  s.schema = 1;
  s.entries = [bal('Checking', 1000, '2026-10-01'), bal('checking', 1500, '2026-11-01'), bal('Visa', -300, '2026-11-02'), exp(20, '2026-11-03')];
  return s;
}
test('schema 1 migrates to 2 without losing entries; accounts derived from balance titles', () => {
  const m = S.validateState(JSON.parse(JSON.stringify(schema1())));
  assert.equal(m.schema, 2);
  assert.equal(m.entries.length, 4);
  assert.equal(m.accounts.length, 2);
  const chk = m.accounts.find((a) => a.name === 'Checking'), visa = m.accounts.find((a) => a.name === 'Visa');
  assert.equal(chk.liability, false); assert.equal(visa.liability, true); assert.equal(visa.kind, 'credit');
  assert.equal(m.entries.filter((e) => e.accountId === chk.id).length, 2);
  assert.ok(m.categories.expense.includes('Groceries') && Array.isArray(m.budgets) && Array.isArray(m.recurring));
  const nw = M.netWorthDetail(m, TODAY);
  assert.equal(nw.total, 1200); assert.equal(nw.liabilities, 300);
  // same result as the schema 1 view of the data
  assert.equal(M.netWorthDetail(S.validateState(JSON.parse(JSON.stringify(schema1()))), TODAY).total, nw.total);
});
test('migration is idempotent and re-validating schema 2 keeps accounts', () => {
  const m = S.validateState(schema1()), again = S.validateState(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(again.accounts, m.accounts);
  assert.deepEqual(again, m);
});
test('a v0.2.0 backup imports cleanly and unlock migrates a stored schema 1 vault', async () => {
  const V = L.vault, salt = V.newSalt(), key = await V.deriveKey('old backup passphrase', salt);
  const env = JSON.stringify(await V.makeEnvelope(key, salt, schema1()));
  const got = await V.importBackup('old backup passphrase', env);
  assert.equal(got.schema, 2); assert.equal(got.entries.length, 4); assert.equal(got.accounts.length, 2);
  const ad = memAdapter(); S._setAdapter(ad);
  const k2 = await V.deriveKey(PASS, salt);
  ad._m.set('envelope', await V.makeEnvelope(k2, salt, schema1()));
  const s = await S.unlock(PASS);
  assert.equal(s.schema, 2);
  await S.commit(() => {});
  S.lock();
  assert.equal((await S.unlock(PASS)).accounts.length, 2);
  S.lock();
});
test('schema 1 data that would break the new schema is still rejected, unknown schemas too', () => {
  const s = schema1(); s.entries[0].value = 'x';
  assert.throws(() => S.validateState(s));
  assert.throws(() => S.validateState(Object.assign(S.defaultState(), { schema: 3 })));
});

// ---- accounts and net worth ----
test('net worth: latest balance per account, liabilities subtracted, archived excluded', () => {
  const s = st();
  s.accounts = [acct('a', 'Bank', 'cash', false), acct('b', 'Brokerage', 'investment', false), acct('c', 'Mortgage', 'mortgage', true), acct('d', 'Old', 'cash', false, true)];
  s.entries = [
    bal('Bank', 100, '2026-10-01', { accountId: 'a' }), bal('Bank', 250.55, '2026-11-01', { accountId: 'a' }),
    bal('Brokerage', 1000, '2026-11-02', { accountId: 'b' }),
    bal('Mortgage', 400, '2026-10-05', { accountId: 'c' }), bal('Mortgage', 390, '2026-11-05', { accountId: 'c' }),
    bal('Old', 9999, '2026-11-05', { accountId: 'd' }),
  ];
  const n = M.netWorthDetail(s, TODAY);
  assert.equal(n.assetsCents, 125055); assert.equal(n.liabilitiesCents, 39000); assert.equal(n.totalCents, 86055);
  assert.equal(n.total, 860.55); assert.equal(n.count, 3);
  assert.deepEqual(n.byKind.map((k) => k.kind), ['investment', 'cash']);
  assert.ok(Math.abs(n.byKind.reduce((a, k) => a + k.share, 0) - 1) < 1e-9);
  assert.equal(M.netWorthDetail(s, '2026-10-02').totalCents, 10000);
  s.accounts[3].archived = false;
  assert.equal(M.netWorthDetail(s, TODAY).totalCents, 86055 + 999900);
  assert.equal(M.headline(s, 'assets', TODAY).value, 10859.55);
});
test('a positive amount on a liability account still reduces net worth; legacy untied balances still work', () => {
  const s = st();
  s.accounts = [acct('c', 'Card', 'credit', true)];
  s.entries = [bal('Card', -50, '2026-11-01', { accountId: 'c' }), bal('Cash box', 80, '2026-11-01')];
  assert.equal(M.netWorthDetail(s, TODAY).totalCents, 3000);
  s.entries.push(bal('card', 25, '2026-11-09'));  // matched to the account by name
  assert.equal(M.netWorthDetail(s, TODAY).totalCents, 5500);
});
test('net worth history by month with assets and liabilities split', () => {
  const s = st();
  s.accounts = [acct('a', 'Bank', 'cash', false), acct('c', 'Loan', 'loan', true)];
  s.entries = [bal('Bank', 100, '2026-09-15', { accountId: 'a' }), bal('Loan', 40, '2026-09-20', { accountId: 'c' }), bal('Bank', 500, '2026-11-03', { accountId: 'a' })];
  const h = M.netWorthHistory(s, 4, TODAY);
  assert.deepEqual(h.map((x) => x.month), ['2026-08', '2026-09', '2026-10', '2026-11']);
  assert.deepEqual(h.map((x) => x.total), [0, 60, 60, 460]);
  assert.deepEqual(h.map((x) => x.liabilities), [0, 40, 40, 40]);
  assert.deepEqual(h.map((x) => x.assets), [0, 100, 100, 500]);
  assert.equal(M.netWorthHistory(s, 1, '2026-01-31').length, 1);
});

// ---- integer cents ----
test('money maths uses integer cents (no float drift)', () => {
  const s = st();
  s.entries = [];
  for (let i = 0; i < 10; i++) s.entries.push(exp(0.1, '2026-11-02'));
  s.entries.push(exp(0.2, '2026-11-03'), inc(0.3, '2026-11-04'), exp(19.99, '2026-11-05'), exp(0.01, '2026-11-05'));
  const v = M.monthView(s, '2026-11');
  assert.equal(v.spendCents, 100 + 20 + 1999 + 1);
  assert.equal(v.spend, 21.2); assert.equal(v.incomeCents, 30); assert.equal(v.net, -20.9);
  assert.ok(Number.isInteger(v.spendCents) && Number.isInteger(v.netCents));
  assert.equal(M.cents(1.15), 115); assert.equal(M.cents(0.29), 29);
  const t = st(); t.accounts = [acct('a', 'A', 'cash', false)];
  t.entries = [bal('A', 0.1, '2026-11-01', { accountId: 'a' }), bal('B', 0.2, '2026-11-01')];
  assert.equal(M.netWorthDetail(t, TODAY).totalCents, 30);
});

// ---- categories, budgets, month view ----
test('entries carry a validated category and default categories exist', () => {
  assert.equal(exp(5, '2026-11-02', ' Dining ').category, 'Dining');
  assert.throws(() => exp(5, '2026-11-02', 'x'.repeat(41)));
  assert.equal(E({ domain: 'work', type: 'outcome', category: 'ignored' }).category, undefined);
  const d = st();
  assert.ok(d.categories.expense.length >= 8 && d.categories.income.length >= 3);
  d.categories.expense.push('Pets');
  assert.deepEqual(S.validateState(d).categories.expense.slice(-1), ['Pets']);
  const dd = st(); dd.categories.expense.push('groceries');
  assert.throws(() => S.validateState(dd), /duplicate/);
});
test('month view: income, spend, savings rate, category vs budget, cash-flow trend', () => {
  const s = st();
  s.budgets = [{ category: 'Groceries', value: 100 }, { category: 'Dining', value: 50 }, { category: 'Travel', value: 300 }];
  s.entries = [inc(3000, '2026-11-01', 'Salary'), exp(70.25, '2026-11-03', 'Groceries'), exp(40, '2026-11-04', 'Groceries'), exp(30, '2026-11-05', 'Dining'),
    exp(1200, '2026-11-01', 'Housing'), exp(10, '2026-11-06'), exp(500, '2026-10-20', 'Housing'), inc(2000, '2026-10-01', 'Salary'), exp(5, '2026-12-01')];
  const v = M.monthView(s, '2026-11');
  assert.equal(v.incomeCents, 300000); assert.equal(v.spendCents, 135025);
  assert.equal(v.netCents, 164975); assert.equal(Math.round(v.savingsRate * 10000) / 100, 54.99);
  const g = v.categories.find((c) => c.category === 'Groceries');
  assert.deepEqual([g.spentCents, g.budgetCents, g.remainingCents, g.over], [11025, 10000, -1025, true]);
  const d = v.categories.find((c) => c.category === 'Dining');
  assert.deepEqual([d.spentCents, d.remainingCents, d.over], [3000, 2000, false]);
  assert.equal(v.categories.find((c) => c.category === 'Travel').spentCents, 0);
  assert.equal(v.categories.find((c) => c.category === 'Housing').budgetCents, null);
  assert.ok(v.categories.some((c) => c.category === M.UNCAT));
  assert.equal(v.budgetCents, 45000); assert.equal(v.budgetedSpentCents, 14025);
  assert.equal(M.monthView(st(), '2026-11').savingsRate, null);
  const cf = M.cashflow(s, 6, TODAY);
  assert.equal(cf.length, 6); assert.equal(cf[5].month, '2026-11'); assert.equal(cf[4].netCents, 150000); assert.equal(cf[0].incomeCents, 0);
  assert.throws(() => M.monthView(s, '2026-13'));
  assert.equal(M.headline(s, 'money', TODAY).value, 55);
});

// ---- recurring ----
function recState() {
  const s = st();
  s.recurring = [
    { id: 'r1', title: 'Rent', value: 1500, category: 'Housing', type: 'expense', cadence: 'monthly', nextDate: '2026-11-01', active: true },
    { id: 'r2', title: 'Pay', value: 2000.5, category: 'Salary', type: 'income', cadence: 'weekly', nextDate: '2026-11-20', active: true },
    { id: 'r3', title: 'Off', value: 5, category: '', type: 'expense', cadence: 'yearly', nextDate: '2026-01-01', active: false },
    { id: 'r4', title: 'Jan31', value: 5, category: '', type: 'expense', cadence: 'monthly', nextDate: '2026-01-31', active: true },
  ];
  return S.validateState(s);
}
test('recurring only proposes; nothing is posted until confirmed', () => {
  const s = recState();
  const due = M.dueRecurring(s, TODAY);
  assert.deepEqual(due.map((d) => d.id), ['r4', 'r1']);
  assert.equal(s.entries.length, 0);
  M.weeklyDigest(s, TODAY); M.headline(s, 'money', TODAY); M.monthView(s, '2026-11'); S.validateState(s);
  assert.equal(s.entries.length, 0);
  assert.equal(M.dueRecurring(s, '2026-10-01').filter((d) => d.id === 'r1').length, 0);
});
test('confirming posts one entry and advances; skipping posts nothing; not-due is refused', () => {
  const s = recState();
  const e = M.confirmRecurring(s, 'r1', TODAY);
  assert.equal(s.entries.length, 1); assert.equal(e.value, 1500); assert.equal(e.date, '2026-11-01'); assert.equal(e.category, 'Housing'); assert.equal(e.type, 'expense');
  assert.equal(s.recurring[0].nextDate, '2026-12-01');
  assert.throws(() => M.confirmRecurring(s, 'r1', TODAY), /not due/);
  assert.throws(() => M.confirmRecurring(s, 'r2', TODAY), /not due/);
  assert.throws(() => M.confirmRecurring(s, 'r3', TODAY), /not due/);
  assert.throws(() => M.confirmRecurring(s, 'nope', TODAY), /not found/);
  M.skipRecurring(s, 'r4', TODAY);
  assert.equal(s.entries.length, 1); assert.equal(s.recurring[3].nextDate, '2026-02-28');
  assert.equal(M.advanceDate('2028-02-29', 'yearly'), '2029-02-28');
  assert.equal(M.advanceDate('2026-12-15', 'monthly'), '2027-01-15');
  assert.equal(M.advanceDate('2026-12-30', 'weekly'), '2027-01-06');
});
test('recurring confirmation goes through store.commit and persists', async () => {
  S._setAdapter(memAdapter());
  await S.init(PASS);
  await S.commit((x) => { x.recurring.push({ id: 'r', title: 'Gym', value: 30, category: 'Health', type: 'expense', cadence: 'monthly', nextDate: '2026-11-01', active: true }); });
  assert.equal(S.getState().entries.length, 0);
  await S.commit((x) => { M.confirmRecurring(x, 'r', TODAY); });
  assert.equal(S.getState().entries.length, 1);
  S.lock();
  assert.equal((await S.unlock(PASS)).entries[0].title, 'Gym');
  S.lock();
});

// ---- validation ----
test('validateState rejects malformed accounts, recurring and budgets', () => {
  const bad = (f) => { const s = st(); f(s); assert.throws(() => S.validateState(s)); };
  const ok = { id: 'a', name: 'N', kind: 'cash', liability: false, archived: false };
  const rec = { id: 'r', title: 'T', value: 5, category: '', type: 'expense', cadence: 'monthly', nextDate: '2026-11-01', active: true };
  for (const f of [
    (x) => { x.accounts = 'no'; }, (x) => { x.accounts = [null]; }, (x) => { x.accounts = [{ ...ok, kind: 'crypto' }]; },
    (x) => { x.accounts = [{ ...ok, name: '' }]; }, (x) => { x.accounts = [{ ...ok, name: 'n'.repeat(201) }]; }, (x) => { x.accounts = [{ ...ok, liability: 'yes' }]; },
    (x) => { x.accounts = [{ ...ok, archived: 1 }]; }, (x) => { x.accounts = [ok, ok]; }, (x) => { x.accounts = [{ ...ok, id: 5 }]; },
    (x) => { x.accounts = Array.from({ length: 201 }, (_, i) => ({ ...ok, id: 'i' + i })); },
    (x) => { x.recurring = [{ ...rec, cadence: 'daily' }]; }, (x) => { x.recurring = [{ ...rec, value: -1 }]; }, (x) => { x.recurring = [{ ...rec, value: '5' }]; },
    (x) => { x.recurring = [{ ...rec, nextDate: '2026-02-31' }]; }, (x) => { x.recurring = [{ ...rec, type: 'balance' }]; }, (x) => { x.recurring = [{ ...rec, active: 'true' }]; },
    (x) => { x.recurring = [{ ...rec, title: 't'.repeat(201) }]; }, (x) => { x.recurring = [rec, rec]; }, (x) => { x.recurring = [{ ...rec, category: 'c'.repeat(41) }]; },
    (x) => { x.recurring = Array.from({ length: 501 }, (_, i) => ({ ...rec, id: 'i' + i })); },
    (x) => { x.budgets = [{ category: 'A', value: -5 }]; }, (x) => { x.budgets = [{ category: '', value: 5 }]; }, (x) => { x.budgets = [{ category: 'A', value: Infinity }]; },
    (x) => { x.budgets = [{ category: 'A', value: 1 }, { category: 'A', value: 2 }]; }, (x) => { x.budgets = {}; },
    (x) => { x.budgets = Array.from({ length: 101 }, (_, i) => ({ category: 'c' + i, value: 1 })); },
    (x) => { x.categories = { expense: 'x', income: [] }; }, (x) => { x.categories = { expense: [1], income: [] }; },
    (x) => { x.categories = { expense: Array.from({ length: 51 }, (_, i) => 'c' + i), income: [] }; },
    (x) => { x.accounts = JSON.parse('[{"id":"a","name":"n","kind":"cash","liability":false,"__proto__":{"x":1}}]'); },
  ]) bad(f);
  const good = st(); good.accounts = [ok]; good.recurring = [rec]; good.budgets = [{ category: 'A', value: 1.005 }];
  const clean = S.validateState(good);
  assert.equal(clean.budgets[0].value, 1.01 === clean.budgets[0].value ? 1.01 : clean.budgets[0].value);
});
test('validateState rebuilds from whitelists: unknown fields dropped, credit kinds forced to liabilities', () => {
  const s = st();
  s.accounts = [{ id: 'a', name: ' Card ', kind: 'credit', liability: false, archived: false, secret: 'x' }];
  s.recurring = [{ id: 'r', title: 'T', value: 5, category: '', type: 'expense', cadence: 'monthly', nextDate: '2026-11-01', active: true, extra: 1 }];
  s.extra = 1;
  const c = S.validateState(s);
  assert.deepEqual(c.accounts[0], { id: 'a', name: 'Card', kind: 'credit', liability: true, archived: false });
  assert.ok(!('extra' in c) && !('extra' in c.recurring[0]));
  const e = st(); e.entries = [{ ...exp(5, '2026-11-02', 'ok'), category: 'x'.repeat(41) }];
  assert.throws(() => S.validateState(e));
});
test('digest carries money numbers only and no names; its validator checks them', () => {
  const s = st();
  s.accounts = [acct('a', 'SecretBank', 'cash', false), acct('c', 'SecretLoan', 'loan', true)];
  s.budgets = [{ category: 'SecretCat', value: 100 }];
  s.entries = [bal('SecretBank', 900, '2026-11-02', { accountId: 'a' }), bal('SecretLoan', 100, '2026-11-02', { accountId: 'c' }),
    exp(40, '2026-11-10', 'SecretCat', 'SecretTitle'), inc(1000, '2026-11-11', 'Salary')];
  s.recurring = [{ id: 'r', title: 'SecretRec', value: 5, category: '', type: 'expense', cadence: 'monthly', nextDate: '2026-11-01', active: true }];
  const d = M.weeklyDigest(s, '2026-11-09');
  assert.deepEqual(d.money, { income: 1000, spend: 40, budgetUsedPct: 40, netWorth: 800, liabilities: 100 });
  const j = JSON.stringify(d);
  for (const bad of ['Secret', 'Salary', '"a"']) assert.ok(!j.includes(bad), bad);
  for (const v of Object.values(d.money)) assert.equal(typeof v, 'number');
  s.memory.reviews.push({ id: 'x', weekOf: '2026-11-09', digest: d, priorities: ['a', 'b', 'c'], completedAt: 'x' });
  assert.deepEqual(S.validateState(s).memory.reviews[0].digest.money, d.money);
  s.memory.reviews[0].digest.money.spend = 'x';
  assert.throws(() => S.validateState(s));
  L.memory.propose(s, L.memory.rulesInsights(st(), '2026-11-09'), { level: 1, period: { from: '2026-11-09', to: '2026-11-15' }, source: 'rules' });
  const { system, user } = L.memory.buildPrompt(s, 1, { from: '2026-11-09', to: '2026-11-15' });
  assert.ok(!(system + user).includes('Secret'));
});

// ---- hosting ----
test('_headers carries the meta CSP plus frame-ancestors and hardening headers', () => {
  const { html, headers, csp } = buildAll();
  const meta = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)[1];
  assert.equal(meta, csp);
  assert.ok(headers.startsWith('/*\n'));
  assert.ok(headers.includes(`  Content-Security-Policy: ${meta}; frame-ancestors 'none'`));
  for (const h of ['Strict-Transport-Security: max-age=', 'X-Content-Type-Options: nosniff', 'Referrer-Policy: no-referrer', 'Cross-Origin-Opener-Policy: same-origin', 'Cache-Control: no-cache']) assert.ok(headers.includes(h), h);
  assert.match(headers, /Permissions-Policy: camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\)/);
  assert.ok(!headers.includes(String.fromCharCode(0x2014)));
  assert.equal(build(), html);
});
