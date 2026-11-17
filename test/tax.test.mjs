// v1.1.0: tax estimates. Integer cents and one rounding rule, the 2026 profile, SE tax around the wage base, the additional Medicare
// threshold, due-date shifts, safe-harbor installments, the Schedule C summary, effective rates with no default, private-vault refusal
// and the exact notice. Every expected figure below is computed by hand in the comment beside it.
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { L, memAdapter, PASS, E } from './_load.mjs';
import { clone } from './_v070.mjs';

const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), T = live('tax'), B = live('business'), P = live('priv'), M = live('metrics');
const PRIV = 'a private passphrase 99';
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

const inc = (date, v, o) => E(Object.assign({ domain: 'money', type: 'income', date, value: v, scope: 'business' }, o));
const exp = (date, v, o) => E(Object.assign({ domain: 'money', type: 'expense', date, value: v, scope: 'business' }, o));
const withProfile = (fn, patch) => {
  const s = S.defaultState();
  T.startDefaultYear(s, 2026);
  if (patch) T.setProfile(s, 2026, Object.assign({}, s.taxYears['2026'], patch));
  if (fn) fn(s);
  return S.validateState(clone(s));
};

describe('rounding and the 2026 profile', () => {
  test('mulDiv rounds half away from zero, exactly, with no floating point', () => {
    assert.equal(T.mulDiv(1, 1, 2), 1); assert.equal(T.mulDiv(-1, 1, 2), -1);   // 0.5 -> 1, -0.5 -> -1
    assert.equal(T.mulDiv(4, 1, 10), 0); assert.equal(T.mulDiv(5, 1, 10), 1); assert.equal(T.mulDiv(6, 1, 10), 1);
    assert.equal(T.mulDiv(-14, 1, 10), -1); assert.equal(T.mulDiv(-15, 1, 10), -2);
    // 9,007,199,254,740,991 x 9,235 / 10,000 would lose digits as a float: the exact answer is 8318,... checked by BigInt
    const a = 9007199254740, b = 9235, d = 10000;
    assert.equal(BigInt(T.mulDiv(a, b, d)), (2n * BigInt(a) * BigInt(b) + BigInt(d)) / (2n * BigInt(d)));
    assert.throws(() => T.mulDiv(1.5, 1, 1)); assert.throws(() => T.mulDiv(1, 1, 0));
  });
  test('the 2026 defaults: wage base, mileage rate periods, 1099 threshold and date, no effective rates', () => {
    const p = T.defaultProfile(2026);
    assert.equal(p.ssWageBase, 18450000); assert.equal(p.nec1099Threshold, 200000); assert.equal(p.nec1099Due, '2027-01-31');
    assert.deepEqual(p.mileageRates.map((r) => [r.from, r.centsPerMile]), [['2026-01-01', 72.5], ['2026-07-01', 76]]);
    assert.equal(p.federalEffectiveRate, null); assert.equal(p.njEffectiveRate, null);
    assert.equal(T.defaultProfile(2027), null, 'no defaults for another year');
    assert.equal(T.cleanProfile(p).ssWageBase, p.ssWageBase);
  });
  test('the notice and the refusal sentence are exact', () => {
    assert.equal(T.NOTICE, 'Estimate. Numbers only, not tax advice. Confirm with your accountant.');
    assert.equal(T.BLOCK_MESSAGE, 'Open the private vault to see tax figures.');
    assert.equal(T.EXPORT_WARNING, 'This file is not encrypted. It contains your business records, payee names and mileage log. Store it somewhere safe.');
    const c = T.compute(withProfile(), 2026);
    assert.equal(c.notice, T.NOTICE);
  });
  test('profile validation: rates, ssRate plus medicareRate must equal seRate, caps, bad dates and prototype keys', () => {
    const p = T.defaultProfile(2026);
    assert.throws(() => T.cleanProfile(Object.assign(clone(p), { seRate: 0.2 })));
    assert.throws(() => T.cleanProfile(Object.assign(clone(p), { federalEffectiveRate: 1.5 })));
    assert.throws(() => T.cleanProfile(Object.assign(clone(p), { nec1099Due: '2027-02-31' })));
    assert.throws(() => T.cleanProfile(Object.assign(clone(p), { filingStatus: 'x' })));
    assert.throws(() => T.cleanProfile(Object.assign(clone(p), { ssWageBase: -1 })));
    assert.throws(() => T.cleanProfile(Object.assign(clone(p), { mileageRates: [{ from: '2026-01-01', centsPerMile: 1 }, { from: '2026-01-01', centsPerMile: 2 }] })));
    const bad = JSON.parse('{"__proto__":{"x":1},"2026":' + JSON.stringify(p) + '}');
    assert.throws(() => T.cleanTaxYears(bad));
    assert.ok(!({}).x);
  });
});

describe('meals, mileage and the home office', () => {
  test('meals are rounded per entry at the profile percentage', () => {
    // 33.33 = 3333 cents; 50% = 1666.5 -> 1667 per entry; two entries 3334, not 3333 (6666 x 50% = 3333 would be the wrong rule)
    const s = withProfile((x) => { x.entries.push(exp('2026-03-01', 33.33, { category: 'Meals' }), exp('2026-03-02', 33.33, { category: 'Meals' })); });
    const c = T.compute(s, 2026), meals = c.lines.find((l) => l.id === 'meals');
    assert.equal(meals.grossCents, 6666); assert.equal(meals.cents, 3334); assert.equal(c.expenseCents, 3334);
    const half = withProfile((x) => { x.entries.push(exp('2026-03-01', 33.33, { category: 'Meals' })); }, { mealsPct: 100 });
    assert.equal(T.compute(half, 2026).lines.find((l) => l.id === 'meals').cents, 3333, 'the percentage is the profile\'s');
  });
  test('mileage uses the rate period that contains the trip date, with fractional cents rounded per trip', () => {
    const p = T.defaultProfile(2026);
    const t = (date, miles, rt) => T.tripCents(p, { date, miles, roundTrip: !!rt });
    assert.equal(t('2026-06-30', 100), 7250);    // 1000 tenths x 725 / 100 = 7250
    assert.equal(t('2026-07-01', 100), 7600);    // 1000 x 760 / 100
    assert.equal(t('2026-01-01', 33.3), 2414);   // 333 x 725 / 100 = 2414.25
    assert.equal(t('2026-01-01', 33.3, true), 4829); // 666 x 725 / 100 = 4828.5 -> 4829
    assert.equal(t('2026-07-02', 0.1), 8);       // 1 x 760 / 100 = 7.6 -> 8
    assert.equal(t('2025-12-31', 10), null, 'no rate covers the date');
    assert.equal(t('2026-06-30', 100) + t('2026-07-01', 100), 14850);
  });
  test('home office: simplified rate, square-foot cap and months used, rounded once', () => {
    const p = T.defaultProfile(2026), h = (sq, mo) => T.homeOfficeCents(p, { squareFeet: sq, monthsUsed: mo });
    assert.equal(h(300, 12), 150000); assert.equal(h(350, 12), 150000, 'capped at 300 square feet');
    assert.equal(h(200, 6), 50000); assert.equal(h(300, 7), 87500);
    assert.equal(h(250, 5), 52083);              // 125000 x 5 / 12 = 52083.33
    assert.equal(h(0, 12), 0); assert.equal(T.homeOfficeCents(p, null), 0);
  });
});

describe('self-employment tax', () => {
  const p = T.defaultProfile(2026);
  test('plain case: net earnings, Social Security, Medicare and the half deduction', () => {
    const se = T.seTax(p, 10000000);   // $100,000.00
    assert.equal(se.netEarningsCents, 9235000);   // x 0.9235
    assert.equal(se.ssCents, 1145140);            // 9,235,000 x 0.124
    assert.equal(se.medicareCents, 267815);       // x 0.029
    assert.equal(se.addlCents, 0); assert.equal(se.totalCents, 1412955);
    assert.equal(se.deductionCents, 706478);      // 1,412,955 / 2 = 706,477.5 -> 706,478
    assert.deepEqual(T.seTax(p, 0), T.seTax(p, -500));
    assert.equal(T.seTax(p, -500).totalCents, 0, 'a loss has no SE tax');
  });
  test('otherSsEarnings: Social Security stops at the wage base room (at, below and above)', () => {
    const at = Object.assign(clone(p), { otherSsEarningsCents: 9215000 });     // room 9,235,000 = the net earnings exactly
    assert.equal(T.seTax(at, 10000000).ssCents, 1145140);
    const below = Object.assign(clone(p), { otherSsEarningsCents: 9216000 });   // room 9,234,000
    assert.equal(T.seTax(below, 10000000).ssCents, 1145016);                    // 9,234,000 x 0.124
    const none = Object.assign(clone(p), { otherSsEarningsCents: 0 });
    assert.equal(T.seTax(none, 10000000).ssCents, 1145140, 'net under the base: no cap');
    const above = T.seTax(none, 25000000);   // net 23,087,500 > base 18,450,000
    assert.equal(above.ssCents, 2287800);    // 18,450,000 x 0.124
    assert.equal(above.medicareCents, 669538);   // 23,087,500 x 0.029 = 669,537.5 -> 669,538
    assert.equal(above.addlCents, 27788);    // (23,087,500 - 20,000,000) x 0.009 = 27,787.5 -> 27,788
    const full = Object.assign(clone(p), { otherSsEarningsCents: 18450000 });
    assert.equal(T.seTax(full, 10000000).ssCents, 0, 'the wage base is already used up elsewhere');
    const over = Object.assign(clone(p), { otherSsEarningsCents: 99999999 });
    assert.equal(T.seTax(over, 10000000).ssCents, 0, 'never negative');
    assert.equal(T.seTax(full, 10000000).medicareCents, 267815, 'Medicare has no cap');
  });
  test('the additional Medicare threshold follows the filing status', () => {
    assert.deepEqual(T.THRESHOLD_BY_STATUS, { single: 20000000, hoh: 20000000, mfj: 25000000, mfs: 12500000 });
    // profit $300,000 -> net earnings 27,705,000
    const at = (st) => T.seTax(Object.assign(clone(p), { filingStatus: st, addlMedicareThreshold: T.THRESHOLD_BY_STATUS[st] }), 30000000).addlCents;
    assert.equal(at('single'), 69345);  // 7,705,000 x 0.009
    assert.equal(at('hoh'), 69345);
    assert.equal(at('mfj'), 24345);     // 2,705,000 x 0.009
    assert.equal(at('mfs'), 136845);    // 15,205,000 x 0.009
    const just = Object.assign(clone(p), { addlMedicareThreshold: 9235000 });
    assert.equal(T.seTax(just, 10000000).addlCents, 0, 'net exactly at the threshold: nothing above it');
  });
});

describe('the year\'s figures end to end', () => {
  const build = (patch) => withProfile((x) => {
    x.entries.push(inc('2026-02-01', 6000, { title: 'Client A' }), inc('2026-03-01', 4000, { title: 'Client B' }), exp('2026-02-10', 1000, { category: 'Supplies' }), exp('2026-02-11', 100.01, { category: 'Meals' }),
      exp('2026-04-01', 25, { category: 'Gym' }), exp('2026-04-02', 77, { category: 'Supplies', scope: 'personal' }), inc('2026-05-01', 999, { status: 'expected', dueDate: '2026-06-01' }), inc('2025-12-31', 5, {}));
    B.addTrip(x, { date: '2026-07-01', from: 'a', to: 'b', miles: '100', purpose: 'client' });
    B.setHomeOffice(x, 2026, { squareFeet: 300, monthsUsed: 12 });
  }, patch);
  test('profit, SE tax and estimated income tax from hand-computed figures', () => {
    const c = T.compute(build({ federalEffectiveRate: 0.22, njEffectiveRate: 0.05 }), 2026);
    // income 6,000 + 4,000 = 1,000,000 (expected and personal and 2025 entries are not counted)
    assert.equal(c.incomeCents, 1000000);
    // expenses: supplies 100,000 + meals 50% of 10,001 = 5,001 (5000.5 rounds up) + Gym (unmapped, counted in full) 2,500
    assert.equal(c.expenseCents, 107501); assert.equal(c.unmapped.cents, 2500); assert.equal(c.unmapped.count, 1);
    assert.equal(c.mileageCents, 7600); assert.equal(c.homeOfficeCents, 150000);
    assert.equal(c.profitCents, 1000000 - 107501 - 7600 - 150000);          // 734,899
    assert.equal(c.profitCents, 734899);
    const se = c.se;
    assert.equal(se.netEarningsCents, 678679);    // 734,899 x 0.9235 = 678,679.2265
    assert.equal(se.ssCents, 84156);              // 678,679 x 0.124 = 84,156.2
    assert.equal(se.medicareCents, 19682);        // x 0.029 = 19,681.69
    assert.equal(se.addlCents, 0); assert.equal(se.totalCents, 103838);
    assert.equal(se.deductionCents, 51919);       // half of 103,838
    assert.equal(c.incomeBaseCents, 682980);      // 734,899 - 51,919
    assert.equal(c.federalTaxCents, 150256);      // 682,980 x 0.22 = 150,255.6
    // SEC-75 (v1.1.0 audit): NJ allows no deduction for half of SE tax, so the NJ base is the profit itself.
    assert.equal(c.njBaseCents, 734899);
    assert.equal(c.njTaxCents, 36745);            // 734,899 x 0.05 = 36,744.95 -> 36,745
    assert.equal(c.setAsideCents, 103838 + 150256 + 36745);   // 290,839
  });
  test('effective rates have no default: the estimates are null until entered, and the set-aside waits for both', () => {
    const c = T.compute(build(), 2026);
    assert.equal(c.federalTaxCents, null); assert.equal(c.njTaxCents, null); assert.equal(c.setAsideCents, null); assert.equal(c.gapCents, null);
    assert.equal(c.se.totalCents, 103838, 'SE tax needs no rate of the user\'s');
    const one = T.compute(build({ federalEffectiveRate: 0.22 }), 2026);
    assert.equal(one.federalTaxCents, 150256); assert.equal(one.njTaxCents, null); assert.equal(one.setAsideCents, null);
  });
  test('the set-aside gap compares with the reserve account balance (latest balance entry)', () => {
    const s = build({ federalEffectiveRate: 0.22, njEffectiveRate: 0.05 });
    assert.equal(T.compute(s, 2026).reserveCents, null); assert.equal(T.compute(s, 2026).gapCents, null);
    s.accounts.push({ id: 'ac', name: 'Reserve', kind: 'cash', liability: false, archived: false });
    s.entries.push(E({ domain: 'assets', type: 'balance', accountId: 'ac', date: '2026-05-01', value: 1000, title: 'old' }), E({ domain: 'assets', type: 'balance', accountId: 'ac', date: '2026-06-01', value: 2000, title: 'new' }));
    s.settings.business.reserveAccountId = 'ac';
    const c = T.compute(S.validateState(clone(s)), 2026);
    assert.equal(c.reserveCents, 200000); assert.equal(c.gapCents, 290839 - 200000);
  });
  test('no profile for the year: figures without SE or income tax, and nothing invented', () => {
    const s = S.defaultState(); s.entries.push(inc('2026-02-01', 100));
    const c = T.compute(S.validateState(clone(s)), 2026);
    assert.equal(c.hasProfile, false); assert.equal(c.incomeCents, 10000); assert.equal(c.se, undefined); assert.equal(c.federalTaxCents, undefined);
    assert.equal(T.digest(S.validateState(clone(s)), '2026-02-01'), null);
  });
  test('Schedule C lines equal the Money totals exactly, per line and in total, and the line-of-work columns add up', () => {
    const s = withProfile((x) => {
      x.projects.push({ id: 'cl', name: 'Client', kind: 'client', status: 'active', nextAction: '', archived: false }, { id: 'web', name: 'Site', kind: 'website', status: 'active', nextAction: '', archived: false, parentId: 'cl' });
      x.entries.push(inc('2026-01-05', 1234.56, { projectId: 'cl' }), inc('2026-01-06', 100.1, { projectId: 'web' }), inc('2026-01-07', 5),
        exp('2026-01-08', 19.99, { category: 'Supplies', projectId: 'cl' }), exp('2026-01-09', 0.01, { category: 'Supplies', projectId: 'web' }), exp('2026-01-10', 45.45, { category: 'Meals', projectId: 'cl' }),
        exp('2026-01-11', 12.34, { category: 'Advertising' }), exp('2026-01-12', 8.88, { category: 'Mystery' }), exp('2026-01-13', 70, { category: 'Rent', reimbursable: true }));
      B.addTrip(x, { date: '2026-01-14', from: 'a', to: 'b', miles: '12.3', purpose: 'p', projectId: 'cl' });
      B.setHomeOffice(x, 2026, { squareFeet: 120, monthsUsed: 5 });
    });
    const c = T.compute(s, 2026), cents = (v) => Math.round(v * 100);
    const gross = {}; for (const e of s.entries) if (e.type === 'expense' && e.scope === 'business') gross[e.category] = (gross[e.category] || 0) + cents(e.value);
    const byId = Object.fromEntries(c.lines.map((l) => [l.id, l]));
    assert.equal(byId.supplies.cents, gross.Supplies); assert.equal(byId.advertising.cents, gross.Advertising); assert.equal(byId.rent.cents, gross.Rent);
    assert.equal(byId.meals.grossCents, gross.Meals); assert.equal(byId.meals.cents, T.mulDiv(gross.Meals, 50, 100));
    assert.equal(c.unmapped.cents, gross.Mystery);
    assert.equal(byId.car.cents, c.mileageCents); assert.equal(byId.homeOffice.cents, c.homeOfficeCents);
    const sumLines = c.lines.filter((l) => l.id !== 'car' && l.id !== 'homeOffice').reduce((x, l) => x + l.cents, 0);
    assert.equal(sumLines + c.unmapped.cents, c.expenseCents);
    assert.equal(c.incomeCents - c.expenseCents - c.mileageCents - c.homeOfficeCents, c.profitCents);
    const lw = c.byLineOfWork, col = (k) => lw.lines.reduce((x, r) => x + r[k], 0);
    assert.equal(col('incomeCents'), c.incomeCents); assert.equal(col('expenseCents'), c.expenseCents);
    assert.equal(col('mileageCents'), c.mileageCents); assert.equal(col('homeOfficeCents'), c.homeOfficeCents); assert.equal(col('netCents'), c.profitCents);
    const roll = lw.rollups.find((r) => r.projectId === 'cl');
    assert.ok(roll); assert.equal(roll.incomeCents, cents(1234.56) + cents(100.1));
    assert.equal(c.reimbursedCents, 0, 'a reimbursable expense not on a paid invoice is not reimbursed');
    const pkg = T.accountantPackage(s, 2026);
    assert.equal(pkg.expenses.reduce((x, r) => x + r.deductibleCents, 0), c.expenseCents);
    assert.equal(pkg.expenses.reduce((x, r) => x + r.grossCents, 0), Object.values(gross).reduce((x, y) => x + y, 0));
  });
  test('a tax line map moves a category; car and home office cannot be mapped', () => {
    const s = withProfile((x) => { x.entries.push(exp('2026-01-08', 10, { category: 'Gym' })); T.setLineMap(x, 'Gym', 'other'); });
    assert.equal(T.compute(s, 2026).lines.find((l) => l.id === 'other').cents, 1000); assert.equal(T.compute(s, 2026).unmapped.count, 0);
    assert.throws(() => T.setLineMap(s, 'Gym', 'car')); assert.throws(() => T.setLineMap(s, 'Gym', 'homeOffice')); assert.throws(() => T.setLineMap(s, 'Gym', 'nope'));
    assert.throws(() => S.validateState(Object.assign(clone(s), { taxMap: [{ category: 'x', line: 'car' }] })));
  });
});

describe('due dates move past weekends and holidays', () => {
  test('every estimate date and the 1099 date shift to the next business day (federal and NJ)', () => {
    const s = withProfile(null, { dueDates: { federal: ['2026-04-18', '2026-06-14', '2026-09-07', '2027-01-15'], nj: ['2026-04-18', '2026-06-14', '2026-09-07', '2027-01-15'] } });
    const d = T.compute(s, 2026).due;
    // Saturday -> Monday; Sunday -> Monday; Labor Day Monday (holiday) -> Tuesday; Friday holiday + weekend + Monday holiday -> Tuesday
    const hol = s.taxYears['2026'].holidays.concat(['2027-01-15']);
    assert.ok(hol.includes('2027-01-18'));
    const s2 = withProfile(null, { dueDates: { federal: ['2026-04-18', '2026-06-14', '2026-09-07', '2027-01-15'], nj: ['2026-04-18', '2026-06-14', '2026-09-07', '2027-01-15'] }, holidays: hol });
    for (const j of ['federal', 'nj']) {
      assert.deepEqual(d[j].map((x) => x.nominal), ['2026-04-18', '2026-06-14', '2026-09-07', '2027-01-15']);
      assert.deepEqual(d[j].map((x) => x.date).slice(0, 3), ['2026-04-20', '2026-06-15', '2026-09-08']);
      assert.deepEqual(T.compute(s2, 2026).due[j].map((x) => x.date), ['2026-04-20', '2026-06-15', '2026-09-08', '2027-01-19']);
    }
    assert.equal(d.nec1099.nominal, '2027-01-31'); assert.equal(d.nec1099.date, '2027-02-01', 'a Sunday moves to Monday');
  });
  test('the default 2026 dates and shiftDue on its own', () => {
    const d = T.compute(withProfile(), 2026).due;
    assert.deepEqual(d.federal.map((x) => x.date), ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15']);
    const h = ['2026-07-03'];
    assert.equal(T.shiftDue('2026-07-03', h), '2026-07-06'); assert.equal(T.shiftDue('2026-07-04', h), '2026-07-06');
    assert.equal(T.shiftDue('2026-07-06', h), '2026-07-06'); assert.equal(T.shiftDue('2026-07-02', h), '2026-07-02');
  });
  test('the Admin timeline carries the estimate dates as rows', () => {
    const rows = T.timelineRows(withProfile());
    assert.ok(rows.length >= 4); assert.ok(rows.every((r) => r.src === 'taxpay' && typeof r.date === 'string'));
  });
});

describe('safe harbor and installments', () => {
  test('installments always add to the target, the remainder cents go to the earliest quarters', () => {
    for (const t of [0, 1, 2, 3, 4, 5, 100001, 999999, 1000000]) {
      const i = T.installments(t);
      assert.equal(i.length, 4); assert.equal(i.reduce((x, y) => x + y, 0), t);
      assert.ok(Math.max(...i) - Math.min(...i) <= 1); assert.deepEqual(i, i.slice().sort((a, b) => b - a));
    }
    assert.deepEqual(T.installments(100001), [25001, 25000, 25000, 25000]);
    assert.deepEqual(T.installments(100003), [25001, 25001, 25001, 25000]);
  });
  test('federal: prior-year percentage (110% with the AGI flag) against 90% of the current estimate; the smaller one is the target', () => {
    const base = (patch) => withProfile((x) => { x.entries.push(inc('2026-02-01', 100000)); }, patch);
    const c = T.compute(base({ priorYearFederalTax: 1000000 }), 2026);
    assert.equal(c.safeHarbor.federal.priorBasedCents, 1000000); assert.equal(c.safeHarbor.federal.currentBasedCents, null, 'no rate: set your rate');
    assert.equal(c.safeHarbor.federal.targetCents, 1000000); assert.deepEqual(c.safeHarbor.federal.installments, [250000, 250000, 250000, 250000]);
    const hi = T.compute(base({ priorYearFederalTax: 1000000, priorYearAgiOver150k: true }), 2026);
    assert.equal(hi.safeHarbor.federal.priorBasedCents, 1100000);
    // with a rate: SE tax 1,412,955 + federal 20% of (10,000,000 - 706,478) = 1,858,704.4 -> 1,858,704 ; sum 3,271,659 x 90% = 2,944,493.1 -> 2,944,493
    const r = T.compute(base({ priorYearFederalTax: 1000000, federalEffectiveRate: 0.2 }), 2026);
    assert.equal(r.safeHarbor.federal.currentBasedCents, 2944493); assert.equal(r.safeHarbor.federal.targetCents, 1000000);
    const small = T.compute(base({ priorYearFederalTax: 90000000, federalEffectiveRate: 0.2 }), 2026);
    assert.equal(small.safeHarbor.federal.targetCents, 2944493, 'the current-year side is smaller');
    const odd = T.compute(base({ priorYearFederalTax: 1000001 }), 2026);
    assert.deepEqual(odd.safeHarbor.federal.installments, [250001, 250000, 250000, 250000]);
  });
  test('NJ: 100% of prior-year tax against 80% of the current-year estimate; paid and remaining', () => {
    const s = withProfile((x) => { x.entries.push(inc('2026-02-01', 100000)); T.addPayment(x, { year: 2026, jurisdiction: 'nj', quarter: 1, amountCents: 100000, paidOn: '2026-04-15' }); }, { priorYearNjTax: 400000, njEffectiveRate: 0.05 });
    const c = T.compute(s, 2026);
    // SEC-75: the NJ base is the profit (no half-SE deduction). NJ tax = 5% of 10,000,000 = 500,000 ; 80% = 400,000 ; prior 400,000 -> target 400,000
    assert.equal(c.safeHarbor.nj.priorBasedCents, 400000); assert.equal(c.safeHarbor.nj.currentBasedCents, 400000); assert.equal(c.safeHarbor.nj.targetCents, 400000);
    assert.equal(c.safeHarbor.nj.paidCents, 100000); assert.equal(c.safeHarbor.nj.remainingCents, 300000);
    assert.equal(c.payments.byQuarter.nj[0], 100000); assert.equal(c.payments.federal, 0);
    assert.equal(T.compute(withProfile(), 2026).safeHarbor.federal, null, 'shown only with the prior-year figure');
  });
});

describe('payments and a new tax year', () => {
  test('payments validate and delete; a bad quarter, jurisdiction, zero amount or an ID-like confirmation is refused', () => {
    const s = S.defaultState();
    const ok = { year: 2026, jurisdiction: 'federal', quarter: 2, amountCents: 5000, paidOn: '2026-06-10', confirmation: 'ABC123' };
    const p = T.addPayment(s, ok); assert.equal(s.taxPayments.length, 1);
    for (const bad of [{ quarter: 5 }, { quarter: 0 }, { jurisdiction: 'ca' }, { amountCents: 0 }, { amountCents: 1.5 }, { paidOn: '2026-02-30' }, { confirmation: '123-45-6789' }]) assert.throws(() => T.addPayment(s, Object.assign({}, ok, bad)), undefined, JSON.stringify(bad));
    T.deletePayment(s, p.id); assert.equal(s.taxPayments.length, 0); assert.throws(() => T.deletePayment(s, 'nope'));
  });
  test('a new tax year copy is offered, never applied until the tap, and carries no prior-year tax or rates it should not', () => {
    const s = withProfile(null, { federalEffectiveRate: 0.2, priorYearFederalTax: 5 });
    assert.equal(T.proposeYear(s, 2026), null, 'nothing earlier to copy');
    const prop = T.proposeYear(s, 2027);
    assert.ok(prop); assert.equal(s.taxYears['2027'], undefined, 'offering changes nothing');
    assert.equal(prop.nec1099Due, '2028-01-31'); assert.equal(prop.dueDates.federal[0], '2027-04-15'); assert.equal(prop.mileageRates[0].from, '2027-01-01');
    assert.equal(prop.priorYearFederalTax, null); assert.match(prop.sourceNote, /Copied from 2026/);
    T.applyNewYear(s, 2027); assert.ok(s.taxYears['2027']); assert.throws(() => T.applyNewYear(s, 2027), undefined, 'a year that has a profile is not overwritten');
    assert.equal(T.defaultProfile(2027), null);
  });
});

describe('private-vault refusal', () => {
  fast();
  const marked = (m) => { const s = withProfile((x) => { x.entries.push(inc('2026-02-01', 100)); }); s.priv = { marks: m }; return s; };
  test('a closed vault holding a business record of the year refuses every tax output; other years and an open view do not', () => {
    for (const m of [['business-2026'], ['business']]) {
      const s = marked(m), msg = 'Open the private vault to see tax figures.';
      const c = T.compute(s, 2026);
      assert.equal(c.blocked, true); assert.equal(c.message, msg); assert.equal(c.incomeCents, undefined); assert.equal(c.se, undefined);
      assert.equal(T.payeeTotals(s, 2026).blocked, true); assert.equal(T.accountantPackage(s, 2026).blocked, true);
      assert.throws(() => T.exportCsv(T.accountantPackage(s, 2026), () => ''), /Open the private vault/);
      assert.equal(T.digest(s, '2026-02-02'), null, 'the digest omits the tax fields');
      assert.equal(T.blocked(s, 2026), true);
      assert.ok(!JSON.stringify(c).includes('"profitCents"') && !JSON.stringify(c).includes('"setAsideCents"'));
    }
    assert.equal(T.compute(marked(['business-2025']), 2026).blocked, false);
    assert.equal(T.compute(marked([]), 2026).blocked, false);
  });
  test('a business expense moved into the real vault and closed makes the figures refuse; opening shows them again', async () => {
    S._setAdapter(memAdapter()); S.lock(); await S.init(PASS);
    const s = withProfile((x) => { x.entries.push(inc('2026-02-01', 100, { id: 'i1' }), exp('2026-02-02', 20, { id: 'x1', category: 'Supplies' })); });
    await S.replaceState(s);
    await P.setUp(PRIV);
    assert.equal(T.compute(S.getState(), 2026).blocked, false);
    await P.moveIn('entries', 'x1', {});
    P.close();
    assert.equal(T.compute(S.getState(), 2026).blocked, true);
    const dg = M.weeklyDigest(S.getState(), '2026-01-26');
    assert.ok(!dg.business || !dg.business.tax, 'no tax fields in the digest while closed');
    await P.open(PRIV);
    const c = T.compute(P.view(S.getState()), 2026);
    assert.equal(c.blocked, false); assert.equal(c.expenseCents, 2000); assert.equal(c.incomeCents, 10000);
  });
});
