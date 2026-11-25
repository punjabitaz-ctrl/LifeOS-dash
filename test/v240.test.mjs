// v2.4.0 (SPEC.md "v2.4.0 addendum: Taxes and assets by country"): a country and a currency on every account and tax checklist item,
// country tax records and tax-year profiles the owner types, a country list (United States and Spain to start, more can be added) and
// exchange rates the owner types. Schema 24 with clean migrations and a downgrade guard. Amounts stay in their own currency; a total
// across currencies is only made with a rate the owner entered, and nothing is ever looked up.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L, PASS, memAdapter, E } from './_load.mjs';
import { fastKeys, realKeys, clone, PRIV } from './_archive.mjs';
import { buildAdversarial, ADV_MARK } from './_adversarial.mjs';

const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), O = view('ops'), C = view('countries'), M = view('metrics'), P = view('priv'), N = view('nav'), Q = view('search');
const NOSTORE = { get: async () => { throw new Error('NO_STORAGE'); }, set: async () => { throw new Error('NO_STORAGE'); }, del: async () => { throw new Error('NO_STORAGE'); } };
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { P.close(); } catch (e) { /* closed */ } try { S.lock(); } catch (e) { /* locked */ } S._setAdapter(NOSTORE); realKeys(); } });
const DAY = '2026-11-20';
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
async function vault(state) { const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS); if (state) await S.replaceState(state); return ad; }

// A vault with a US checking account, a US card, a Spanish bank account in EUR and a Spanish mortgage in EUR.
function world() {
  const s = S.defaultState();
  s.accounts.push(
    { id: 'us1', name: 'Checking', kind: 'cash', liability: false, archived: false, country: 'US', currency: 'USD' },
    { id: 'us2', name: 'Card', kind: 'credit', liability: true, archived: false, country: 'US', currency: 'USD' },
    { id: 'es1', name: 'Banco', kind: 'cash', liability: false, archived: false, country: 'ES', currency: 'EUR' },
    { id: 'es2', name: 'Hipoteca', kind: 'mortgage', liability: true, archived: false, country: 'ES', currency: 'EUR' });
  s.entries.push(
    E({ id: 'b1', domain: 'assets', type: 'balance', date: '2026-11-01', title: 'Checking', value: 10000, accountId: 'us1' }),
    E({ id: 'b2', domain: 'assets', type: 'balance', date: '2026-11-01', title: 'Card', value: 500, accountId: 'us2' }),
    E({ id: 'b3', domain: 'assets', type: 'balance', date: '2026-11-01', title: 'Banco', value: 5000, accountId: 'es1' }),
    E({ id: 'b4', domain: 'assets', type: 'balance', date: '2026-11-01', title: 'Hipoteca', value: 1000, accountId: 'es2' }));
  return S.validateState(s);
}

// ---------------------------------------------------------------- migration
test('schema 24: every older schema migrates with US and USD on every account and tax item, the default list and no rates', () => {
  assert.equal(S.SCHEMA, 24); assert.equal(S.defaultState().schema, 24);
  assert.deepEqual(S.defaultState().settings.countries, { home: 'US', list: [{ code: 'US', name: 'United States', currency: 'USD' }, { code: 'ES', name: 'Spain', currency: 'EUR' }] });
  assert.deepEqual(S.defaultState().settings.fx, []); assert.deepEqual(S.defaultState().countryTax, []); assert.deepEqual(S.defaultState().countryTaxYears, []);
  for (const n of [1, 11, 21, 22, 23]) {
    const o = clone(S.defaultState()); o.schema = n;
    delete o.countryTax; delete o.countryTaxYears; delete o.settings.countries; delete o.settings.fx;
    if (n < 21) { delete o.meals; delete o.mealLog; delete o.settings.food; }
    if (n < 23) delete o.settings.overview;
    if (n === 1) { for (const k of ['recurring', 'budgets', 'categories']) delete o[k]; o.accounts = []; }
    o.accounts.push({ id: 'a1', name: 'Old bank', kind: 'cash', liability: false, archived: false });
    if (n >= 6) o.taxItems.push({ id: 't1', year: 2026, title: 'W-2', state: 'needed' });
    o.entries.push(E({ id: 'e1', domain: 'assets', type: 'balance', date: '2026-11-01', title: 'Old bank', value: 1234.56, accountId: 'a1' }));
    // An older copy cannot carry the new fields: anything there is dropped, not trusted.
    o.accounts[0].country = 'ES'; o.accounts[0].currency = 'EUR'; o.countryTax = [{ id: 'x' }];
    const v = S.validateState(o);
    assert.equal(v.schema, 24, 'from ' + n); assert.equal(v.sourceSchema, n);
    assert.deepEqual([v.accounts[0].country, v.accounts[0].currency], ['US', 'USD'], 'account from ' + n);
    if (n >= 6) assert.equal(v.taxItems[0].country, 'US');
    assert.deepEqual(v.countryTax, []); assert.deepEqual(v.countryTaxYears, []); assert.deepEqual(v.settings.fx, []);
    assert.deepEqual(v.settings.countries, C.defaultSettings());
    // the money reads exactly as before: one USD balance, no conversion
    const nw = M.netWorthDetail(v, DAY);
    assert.equal(nw.totalCents, 123456); assert.deepEqual(nw.unconverted, []); assert.equal(nw.rows[0].currency, undefined);
  }
});

test('a stored schema 23 vault migrates on unlock and is written back as 24; a newer schema is refused', async () => {
  const o = clone(S.defaultState()); o.schema = 23;
  delete o.countryTax; delete o.countryTaxYears; delete o.settings.countries; delete o.settings.fx;
  o.accounts.push({ id: 'a1', name: 'Old bank', kind: 'cash', liability: false, archived: false });
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  await S.commit((x) => { Object.assign(x, S.validateState(o)); });
  const st = await (async () => { S.lock(); return S.unlock(PASS); })();
  assert.equal(st.schema, 24); assert.equal(st.accounts[0].country, 'US');
  const newer = clone(S.defaultState()); newer.schema = 25;
  assert.throws(() => S.validateState(newer), /schema/);
});

test('validator: codes, currencies, rates and caps are checked; free text is capped; a tax ID is never stored', () => {
  const base = () => clone(world());
  const bad = [
    (s) => { s.accounts[0].country = 'usa'; }, (s) => { s.accounts[0].currency = 'eur'; }, (s) => { s.accounts[0].currency = 7; },
    (s) => { s.settings.countries.list.push({ code: 'FR', name: 'France', currency: 'EURO' }); },
    (s) => { s.settings.countries.home = 'FR'; },
    (s) => { s.settings.countries.list = []; },
    (s) => { s.settings.fx = [{ currency: 'USD', rate: 1, asOf: DAY }]; },
    (s) => { s.settings.fx = [{ currency: 'EUR', rate: 0, asOf: DAY }]; },
    (s) => { s.settings.fx = [{ currency: 'EUR', rate: 1.0000001, asOf: DAY }]; },
    (s) => { s.settings.fx = [{ currency: 'EUR', rate: 1.08, asOf: 'today' }]; },
    (s) => { s.countryTax = [{ id: 'r', country: 'ES', year: 2026, kind: 'fee', title: 'x', amountCents: 1, currency: 'EUR', notes: '' }]; },
    (s) => { s.countryTax = [{ id: 'r', country: 'ES', year: 2026, kind: 'paid', title: 'x', amountCents: 1.5, currency: 'EUR', notes: '' }]; },
    (s) => { s.countryTax = [{ id: 'r', country: 'ES', year: 2026, kind: 'paid', title: 'x'.repeat(201), amountCents: 1, currency: 'EUR', notes: '' }]; },
    (s) => { s.countryTaxYears = [{ country: 'ES', year: 2026, residency: 'maybe', note: '' }]; },
    (s) => { s.countryTaxYears = [{ country: 'ES', year: 2026, residency: 'resident', days: 367, note: '' }]; },
  ];
  for (const [i, f] of bad.entries()) { const s = base(); f(s); assert.throws(() => S.validateState(s), /Invalid data|schema|country|currency|rate|tax/i, 'case ' + i); }
  const s = base();
  s.countryTax = [{ id: 'r', country: 'ES', year: 2026, kind: 'paid', title: 'IRPF 2026', amountCents: 123456, currency: 'EUR', date: '2026-06-30', notes: '', extra: 'dropped' }];
  const v = S.validateState(s);
  assert.deepEqual(v.countryTax[0], { id: 'r', country: 'ES', year: 2026, kind: 'paid', title: 'IRPF 2026', amountCents: 123456, currency: 'EUR', date: '2026-06-30', notes: '' });
});

test('downgrade guard: an older copy cannot silently drop countries, currencies, tax records, profiles or rates', () => {
  const cur = clone(world());
  assert.deepEqual(S.droppedData(clone(S.defaultState()), Object.assign(clone(S.defaultState()), { sourceSchema: 23 })), [], 'a plain US vault loses nothing');
  C.setRate(cur, 'EUR', '1.08', DAY);
  C.addRecord(cur, { country: 'ES', year: 2026, kind: 'paid', title: 'IRPF', amount: '100', currency: 'EUR' });
  C.setProfile(cur, 'ES', 2026, { residency: 'resident', days: '200' });
  C.addCountry(cur, { code: 'PT', name: 'Portugal', currency: 'EUR' });
  cur.taxItems.push({ id: 't1', year: 2026, title: 'Modelo 100', state: 'needed', country: 'ES' });
  const names = S.droppedData(S.validateState(cur), Object.assign(clone(S.defaultState()), { sourceSchema: 23 }));
  for (const n of ['account countries and currencies', 'country tax records', 'country tax profiles', 'countries on tax checklist items', 'exchange rates', 'country list']) assert.ok(names.includes(n), n);
  assert.deepEqual(S.droppedData(S.validateState(cur), Object.assign(clone(S.validateState(cur)), { sourceSchema: 24 })), []);
});

// ---------------------------------------------------------------- honest totals
test('net worth: a balance in another currency is left out and listed until a rate is typed; then it is converted exactly', () => {
  const s = world();
  const nw = M.netWorthDetail(s, DAY);
  assert.equal(nw.totalCents, 1000000 - 50000, 'only the USD accounts are in the total');
  assert.deepEqual(nw.unconverted.map((r) => [r.name, r.currency, r.nativeCents]).sort(), [['Banco', 'EUR', 500000], ['Hipoteca', 'EUR', -100000]]);
  C.setRate(s, 'EUR', '1.08', DAY);
  const nw2 = M.netWorthDetail(s, DAY);
  assert.deepEqual(nw2.unconverted, []);
  assert.equal(nw2.totalCents, 1000000 - 50000 + 540000 - 108000);
  const banco = nw2.rows.find((r) => r.name === 'Banco');
  assert.deepEqual([banco.cents, banco.nativeCents, banco.currency], [540000, 500000, 'EUR']);
  // exact cents: no binary float drift, halves round away from zero
  const t = clone(s); t.settings.fx = [{ currency: 'EUR', rate: 1.5, asOf: DAY }];
  assert.equal(C.toHome(t.settings, 1, 'EUR'), 2); assert.equal(C.toHome(t.settings, -1, 'EUR'), -2); assert.equal(C.toHome(t.settings, 3, 'EUR'), 5);
  t.settings.fx = [{ currency: 'EUR', rate: 1.123457, asOf: DAY }];
  assert.equal(C.toHome(t.settings, 999999999, 'EUR'), 1123456999); // 999999999 x 1.123457 = 1123456998.876543, the nearest cent
  assert.equal(C.toHome(t.settings, 100, 'GBP'), null, 'no rate, no number');
  // SEC-143: a converted figure past the exact integer range is never shown as a number
  t.settings.fx = [{ currency: 'EUR', rate: 1000000, asOf: DAY }];
  assert.equal(C.toHome(t.settings, 1e13, 'EUR'), null);
  const big = C.combine(t.settings, [{ currency: 'EUR', net: 1e13 }], ['net']);
  assert.deepEqual([big.ok, big.missing], [false, ['EUR']]);
  const huge = C.combine(t.settings, [{ currency: 'USD', net: Number.MAX_SAFE_INTEGER }, { currency: 'EUR', net: 1000 }], ['net']);
  assert.deepEqual([huge.ok, huge.tooLarge], [false, true]);
  assert.equal(C.toHome(t.settings, 100, 'USD'), 100);
});

test('assets by country: each country in its own currencies, all countries side by side, a combined total only with every rate', () => {
  const s = world();
  const a = C.assets(s, DAY);
  const us = a.countries.find((c) => c.code === 'US'), es = a.countries.find((c) => c.code === 'ES');
  assert.deepEqual(us.totals.map((b) => [b.currency, b.assets, b.liabilities, b.net]), [['USD', 1000000, 50000, 950000]]);
  assert.deepEqual(es.totals.map((b) => [b.currency, b.assets, b.liabilities, b.net]), [['EUR', 500000, 100000, 400000]]);
  assert.deepEqual(us.accounts.map((r) => r.name).sort(), ['Card', 'Checking']); assert.deepEqual(es.accounts.map((r) => r.name).sort(), ['Banco', 'Hipoteca']);
  assert.deepEqual(a.totals.map((b) => [b.currency, b.net]), [['USD', 950000], ['EUR', 400000]], 'home currency first, never added together');
  assert.deepEqual([a.combined.ok, a.combined.missing], [false, ['EUR']]);
  assert.equal(us.combined.ok, true, 'one country in the home currency needs no rate');
  C.setRate(s, 'EUR', '1.08', DAY);
  const b = C.assets(s, DAY);
  assert.deepEqual([b.combined.ok, b.combined.net, b.combined.currency], [true, 950000 + 432000, 'USD']);
  // A USD account held in Spain counts for Spain, in USD.
  s.accounts.push({ id: 'es3', name: 'Dollar account', kind: 'cash', liability: false, archived: false, country: 'ES', currency: 'USD' });
  s.entries.push(E({ domain: 'assets', type: 'balance', date: '2026-11-02', title: 'Dollar account', value: 10, accountId: 'es3' }));
  const c = C.assets(S.validateState(s), DAY).countries.find((x) => x.code === 'ES');
  assert.deepEqual(c.totals.map((x) => [x.currency, x.net]), [['USD', 1000], ['EUR', 400000]]);
  // Archived accounts stay out, as on the Assets screen.
  s.accounts.find((x) => x.id === 'es1').archived = true;
  assert.ok(!C.assets(S.validateState(s), DAY).countries.find((x) => x.code === 'ES').accounts.some((r) => r.name === 'Banco'));
});

test('taxes by country: the owner\'s records by currency, the year profile, checklist counts; US estimates only for the home country', () => {
  const s = world();
  C.addRecord(s, { country: 'ES', year: 2026, kind: 'paid', title: 'IRPF quarterly', amount: '1,200.50', currency: 'EUR', date: '2026-04-20' });
  C.addRecord(s, { country: 'ES', year: 2026, kind: 'owed', title: 'Annual return', amount: '300', currency: 'EUR' });
  C.addRecord(s, { country: 'ES', year: 2025, kind: 'refund', title: 'Last year', amount: '50', currency: 'EUR' });
  C.addRecord(s, { country: 'US', year: 2026, kind: 'paid', title: 'Withholding', amount: '900' });
  C.setProfile(s, 'ES', 2026, { residency: 'resident', days: '190', filingDue: '2027-06-30', note: 'Gestor: Ana' });
  s.taxItems.push({ id: 't1', year: 2026, title: 'Modelo 100', state: 'needed', dueDate: '', country: 'ES' }, { id: 't2', year: 2026, title: 'W-2', state: 'received', dueDate: '', country: 'US' }, { id: 't3', year: 2026, title: 'Modelo 720', state: 'filed', dueDate: '', country: 'ES' });
  s.taxPayments.push({ id: 'p1', year: 2026, jurisdiction: 'federal', quarter: 1, amountCents: 250000, paidOn: '2026-04-15' });
  const v = S.validateState(s);
  const T = C.taxes(v, 2026), es = T.find((c) => c.code === 'ES'), us = T.find((c) => c.code === 'US');
  assert.deepEqual(es.records.map((r) => r.title).sort(), ['Annual return', 'IRPF quarterly']);
  assert.deepEqual(es.totals.map((b) => [b.currency, b.paid, b.owed, b.refund]), [['EUR', 120050, 30000, 0]]);
  assert.deepEqual([es.profile.residency, es.profile.days, es.profile.filingDue], ['resident', 190, '2027-06-30']);
  assert.deepEqual([es.items, es.openItems, us.items, us.openItems], [2, 1, 1, 1], 'filed items are not open');
  assert.equal(es.estimates, undefined, 'no tax rules or estimates for Spain');
  assert.deepEqual([us.estimates.federal, us.estimates.nj, us.estimates.currency], [250000, 0, 'USD']);
  assert.deepEqual(us.totals.map((b) => [b.currency, b.paid]), [['USD', 90000]]);
  assert.equal(C.taxes(v, 2025).find((c) => c.code === 'ES').totals[0].refund, 5000);
});

// ---------------------------------------------------------------- mutators
test('mutators: add and remove countries, rates, records and profiles, with plain messages for every refusal', () => {
  const s = world();
  assert.throws(() => C.addCountry(s, { code: 'P', name: 'Portugal', currency: 'EUR' }), /two-letter/);
  assert.throws(() => C.addCountry(s, { code: 'PT', name: '', currency: 'EUR' }), /name/);
  assert.throws(() => C.addCountry(s, { code: 'PT', name: 'Portugal', currency: 'EU' }), /three-letter/);
  assert.throws(() => C.addCountry(s, { code: 'es', name: 'Spain again', currency: 'EUR' }), /already/);
  assert.equal(C.addCountry(s, { code: 'pt', name: ' Portugal ', currency: 'eur' }), 'PT');
  assert.deepEqual(C.find(s.settings, 'PT'), { code: 'PT', name: 'Portugal', currency: 'EUR' });
  assert.throws(() => C.removeCountry(s, 'US'), /home country/);
  assert.throws(() => C.removeCountry(s, 'ES'), /still use/);
  C.removeCountry(s, 'PT'); assert.equal(C.find(s.settings, 'PT'), null);
  for (let i = 0; C.list(s.settings).length < C.COUNTRY_CAP; i++) C.addCountry(s, { code: 'Q' + String.fromCharCode(65 + i), name: 'Q' + i, currency: 'QQQ' });
  assert.throws(() => C.addCountry(s, { code: 'ZZ', name: 'Z', currency: 'ZZZ' }), /up to 20/);
  // rates
  assert.throws(() => C.setRate(s, 'USD', '1', DAY), /other than USD/);
  for (const r of ['0', '-1', 'abc', '2000000']) assert.throws(() => C.setRate(s, 'EUR', r, DAY), /above 0/, r);
  assert.throws(() => C.setRate(s, 'EUR', '1.0800001', DAY), /six decimals/);
  assert.throws(() => C.setRate(s, 'EUR', '1.08', ''), /date/);
  assert.deepEqual(C.setRate(s, 'eur', ' 1.08 ', DAY), { currency: 'EUR', rate: 1.08, asOf: DAY });
  assert.deepEqual(C.setRate(s, 'EUR', '1.1', '2026-11-21'), { currency: 'EUR', rate: 1.1, asOf: '2026-11-21' }, 'replaced, not added');
  assert.equal(s.settings.fx.length, 1);
  assert.equal(C.setRate(s, 'EUR', '', ''), null); assert.deepEqual(s.settings.fx, []);
  // records
  assert.throws(() => C.addRecord(s, { country: 'FR', year: 2026, kind: 'paid', title: 'x', amount: '1' }), /list first/);
  assert.throws(() => C.addRecord(s, { country: 'ES', year: 2026, kind: 'paid', title: '', amount: '1' }), /what this is/);
  assert.throws(() => C.addRecord(s, { country: 'ES', year: 2026, kind: 'paid', title: 'x', amount: '1.234' }), /number/);
  assert.throws(() => C.addRecord(s, { country: 'ES', year: 1900, kind: 'paid', title: 'x', amount: '1' }), /tax year/);
  const r = C.addRecord(s, { country: 'ES', year: 2026, kind: 'paid', title: 'IRPF', amount: '10' });
  assert.deepEqual([r.currency, r.amountCents], ['EUR', 1000], 'the country currency by default');
  C.editRecord(s, r.id, { country: 'ES', year: 2026, kind: 'owed', title: 'IRPF due', amount: '12.5', currency: 'EUR', notes: 'n' });
  assert.deepEqual([s.countryTax[0].kind, s.countryTax[0].amountCents, s.countryTax[0].notes], ['owed', 1250, 'n']);
  C.deleteRecord(s, r.id); assert.deepEqual(s.countryTax, []);
  assert.throws(() => C.deleteRecord(s, r.id), /not found/);
  // profiles
  assert.throws(() => C.setProfile(s, 'ES', 2026, { residency: 'resident', days: '400' }), /0 to 366|whole number/);
  C.setProfile(s, 'ES', 2026, { residency: 'nonresident', days: '45' });
  C.setProfile(s, 'ES', 2026, { residency: 'resident', days: '200' });
  assert.equal(s.countryTaxYears.length, 1); assert.deepEqual([s.countryTaxYears[0].residency, s.countryTaxYears[0].days], ['resident', 200]);
  assert.equal(C.setProfile(s, 'ES', 2026, { residency: 'unsure', days: '', filingDue: '', note: '' }), null);
  assert.deepEqual(s.countryTaxYears, [], 'all empty removes the profile');
  S.validateState(s);
});

test('a tax ID or ID number is refused wherever the owner types: SSN, EIN, Spanish NIE and DNI', () => {
  const s = world();
  for (const t of ['SSN 123-45-6789', 'EIN 12-3456789', 'NIE X1234567L', 'my DNI is 12345678Z', 'Y7654321G']) {
    assert.throws(() => C.addRecord(s, { country: 'ES', year: 2026, kind: 'paid', title: t, amount: '1' }), /tax ID or an ID number/, t);
    assert.throws(() => C.addRecord(s, { country: 'ES', year: 2026, kind: 'paid', title: 'ok', amount: '1', notes: t }), /tax ID/, t);
    assert.throws(() => C.setProfile(s, 'ES', 2026, { residency: 'resident', note: t }), /tax ID/, t);
    assert.throws(() => C.addCountry(s, { code: 'PT', name: t.slice(0, 60), currency: 'EUR' }), /tax ID/, t);
  }
  assert.deepEqual(s.countryTax, []);
  assert.ok(C.addRecord(s, { country: 'ES', year: 2026, kind: 'paid', title: 'Modelo 130 Q1 2026', amount: '1' }), 'form names and years are fine');
});

// ---------------------------------------------------------------- privacy, search, AI boundary
test('private vault: an account in Spain keeps its country and currency through a move in and out; records and profiles move too', async () => {
  const s = world();
  C.addRecord(s, { country: 'ES', year: 2026, kind: 'paid', title: 'IRPF', amount: '10' });
  C.setProfile(s, 'ES', 2026, { residency: 'resident', days: '200' });
  await vault(S.validateState(s)); await P.setUp(PRIV);
  await P.moveIn('accounts', 'es1');
  assert.ok(!S.getState().accounts.some((a) => a.id === 'es1'));
  const inView = P.view(S.getState()).accounts.find((a) => a.id === 'es1');
  assert.deepEqual([inView.country, inView.currency], ['ES', 'EUR']);
  assert.equal(C.assets(P.view(S.getState()), DAY).countries.find((c) => c.code === 'ES').accounts.length, 2, 'the open view counts it for Spain');
  await P.moveOut('accounts', 'es1');
  const back = S.getState().accounts.find((a) => a.id === 'es1');
  assert.deepEqual([back.country, back.currency], ['ES', 'EUR']);
  const rid = S.getState().countryTax[0].id;
  await P.moveIn('countryTax', rid); await P.moveIn('countryTaxYears', 'ES|2026');
  assert.deepEqual([S.getState().countryTax.length, S.getState().countryTaxYears.length], [0, 0]);
  assert.ok(S.getState().priv.marks.includes('countryTax') && S.getState().priv.marks.includes('countryTaxYears'));
  assert.equal(C.taxes(P.view(S.getState()), 2026).find((c) => c.code === 'ES').records.length, 1);
  P.close();
  assert.equal(C.taxes(S.getState(), 2026).find((c) => c.code === 'ES').records.length, 0, 'closed: nothing private shows');
});

test('country tax text is searchable while open, and never reaches the weekly digest, an AI prompt or an audit entry', async () => {
  const { state } = buildAdversarial(L);
  await vault(state);
  const titleMark = state.countryTax[0].title.slice(0, ADV_MARK.length + 3);
  assert.deepEqual(Q.query(titleMark).groups.map((g) => g.area), ['countries']);
  assert.equal(Q.AREAS.countries[1], 'countries'); assert.ok(N.viewOf('countries').name === 'countries');
  const digest = JSON.stringify(M.weeklyDigest(S.getState(), '2026-11-09'));
  for (const t of [state.countryTax[0].title, state.countryTax[0].notes, state.countryTaxYears[0].note]) assert.ok(!digest.includes(t.slice(0, 20)), 'digest');
  assert.ok(!digest.includes('1234567') && !digest.includes('12345.67'), 'no tax figure in the digest');
  const ai = src('src/core/ai.js') + src('src/core/memory.js');
  assert.ok(!/countryTax|countries\./.test(ai), 'the AI code never reads country tax data');
  await S.commit((x) => { C.addRecord(x, { country: 'ES', year: 2026, kind: 'paid', title: 'AUDITMARK title', amount: '1' }); }, 'country tax add');
  assert.ok(!JSON.stringify(S.getState().audit || []).includes('AUDITMARK'));
});

// ---------------------------------------------------------------- wiring
test('wiring: the By country screen, nav, build order, search area; nothing is fetched; plain words only', () => {
  const ui = src('src/ui/app.js'), core = src('src/core/countries.js'), build = src('build.mjs');
  assert.match(build, /'business', 'countries', 'clients'/);
  assert.ok(/view\.name === 'countries' \? countriesScreen\(s\)/.test(ui));
  for (const id of ['cn-chips', 'cn-year', 'cn-assets', 'cn-taxes', 'cn-accounts', 'cn-profile', 'cn-records', 'cn-r-form', 'cn-settings', 'cn-c-form', 'aw-by-country', 'aw-unconverted', 'ac-country', 'ac-currency', 'ac-edit-country', 'tx-country']) assert.ok(ui.includes("'" + id + "'"), id);
  assert.ok(/MORE = Object\.freeze\(\[\['v:assets', 'Assets'\], \['countries', 'By country'\]/.test(src('src/core/nav.js')));
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|import\(/.test(core), 'countries.js makes no request');
  assert.ok(/LifeOS never looks rates up/.test(ui));
  const block = ui.slice(ui.indexOf('// ---------- v2.4.0 taxes and assets by country'), ui.indexOf('// ---------- insights and AI'));
  assert.ok(block.length > 5000);
  assert.ok(!block.includes('—') && !core.includes('—'), 'no em dashes');
  assert.ok(!/\b(you should|we recommend|recommended|consider|best practice)\b/i.test(block + core), 'no advice wording');
  assert.ok(/Not tax advice/.test(block));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(block + core));
  assert.ok(/lockMark\(\['accounts', 'entries', 'countryTax', 'countryTaxYears'/.test(block), 'the screen marks hidden private items');
  assert.deepEqual(JSON.parse(src('package.json')).version, '2.4.0');
  assert.ok(/SEC-144[^\n]*\n[^\n]*!L\.priv\.isOpen\(\) && lockMark\(\['accounts', 'countryTax', 'countryTaxYears', 'taxItems'\]\)\) throw new Error\('Open the private vault first/.test(ui), 'a country is not removed while a private item may use it');
  // the private vault screens name and key the new collections; diagnostics count them by number only
  assert.ok(/c === 'countryTaxYears' \? r\.country \+ '\|' \+ r\.year/.test(ui), 'the UI keys a profile by country and year, as priv.js does');
  assert.ok(/countryTax: 'Country tax amounts', countryTaxYears: 'Country tax years'/.test(ui));
  const keys = O.COUNT_KEYS.map((x) => x[0]);
  assert.ok(keys.includes('countryTax') && keys.includes('countryTaxYears'));
});
