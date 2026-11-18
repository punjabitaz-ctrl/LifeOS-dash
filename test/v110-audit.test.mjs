// v1.1.0 independent audit: regression tests for SEC-71 to SEC-83 and proofs of every tax rule with hand-computed values (each expected
// figure is worked out in the comment beside it). Deviations (a) to (e) of the builder are judged here too.
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { L, memAdapter, PASS, E } from './_load.mjs';
import { clone } from './_v070.mjs';

const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), T = live('tax'), B = live('business'), P = live('priv'), M = live('metrics'), Mem = live('memory');
const PRIV = 'a private passphrase 99';
let ORIG = null;
const fastDerive = async (pass, salt) => {
  const base = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};
const fast = () => {
  beforeEach(() => { ORIG = L.vault.deriveKey; L.vault.deriveKey = fastDerive; });
  afterEach(() => { L.vault.deriveKey = ORIG; try { L.priv.close('system'); } catch (e) { /* ignore */ } });
};
const proj = (id, name, o) => Object.assign({ id, name, kind: 'client', status: 'active', nextAction: '', archived: false }, o);
const inc = (date, v, o) => E(Object.assign({ domain: 'money', type: 'income', date, value: v, scope: 'business' }, o));
const exp = (date, v, o) => E(Object.assign({ domain: 'money', type: 'expense', date, value: v, scope: 'business' }, o));
const line = (d, q, c) => ({ description: d, qty: q, unitCents: c });
const build = (fn, patch) => {
  const s = S.defaultState();
  T.startDefaultYear(s, 2026);
  if (patch) T.setProfile(s, 2026, Object.assign({}, s.taxYears['2026'], patch));
  if (fn) fn(s);
  return S.validateState(clone(s));
};
const p26 = (patch) => Object.assign(clone(T.cleanProfile(T.defaultProfile(2026))), patch || {});
async function vault(state) { S._setAdapter(memAdapter()); S.lock(); await S.init(PASS); if (state) await S.replaceState(state); }

describe('SEC-71 to SEC-73: self-employment tax', () => {
  test('SEC-71: the half-SE deduction covers the 12.4% and 2.9% parts only, never the additional Medicare tax', () => {
    const se = T.seTax(p26(), 30000000);       // profit $300,000, single
    assert.equal(se.netEarningsCents, 27705000);  // 30,000,000 x 0.9235
    assert.equal(se.ssCents, 2287800);            // min(27,705,000, 18,450,000) x 0.124
    assert.equal(se.medicareCents, 803445);       // 27,705,000 x 0.029
    assert.equal(se.addlCents, 69345);            // (27,705,000 - 20,000,000) x 0.009
    assert.equal(se.totalCents, 3160590);
    assert.equal(se.deductionCents, 1545623);     // (2,287,800 + 803,445) / 2 = 1,545,622.5 -> 1,545,623 (the builder gave 1,580,295)
    const c = T.compute(build((x) => x.entries.push(inc('2026-03-01', 300000)), { federalEffectiveRate: 0.2 }), 2026);
    assert.equal(c.incomeBaseCents, 30000000 - 1545623);   // 28,454,377
    assert.equal(c.federalTaxCents, 5690875);              // 28,454,377 x 0.2 = 5,690,875.4
  });
  test('SEC-72: additional Medicare uses the threshold less W-2 wages (floored at 0); Social Security uses the room left', () => {
    const w = p26({ otherSsEarningsCents: 15000000 });   // $150,000 of W-2 wages, profit $100,000
    const se = T.seTax(w, 10000000);
    assert.equal(se.netEarningsCents, 9235000);
    assert.equal(se.ssRoomCents, 3450000); assert.equal(se.ssCents, 427800);   // 3,450,000 x 0.124
    assert.equal(se.medicareCents, 267815);                                   // 9,235,000 x 0.029
    assert.equal(se.addlThresholdCents, 5000000); assert.equal(se.addlCents, 38115);   // (9,235,000 - 5,000,000) x 0.009
    assert.equal(se.deductionCents, 347808);   // (427,800 + 267,815) / 2 = 347,807.5 -> 347,808
    const over = T.seTax(p26({ otherSsEarningsCents: 25000000 }), 10000000);   // wages above both the base and the threshold
    assert.equal(over.ssCents, 0); assert.equal(over.addlThresholdCents, 0);
    assert.equal(over.addlCents, 83115);       // 9,235,000 x 0.009
    assert.equal(over.deductionCents, 133908); // 267,815 / 2 = 133,907.5 -> 133,908
    const none = T.seTax(p26(), 10000000); assert.equal(none.addlCents, 0, 'no wages: $92,350 is under $200,000');
    const mfj = T.seTax(p26({ filingStatus: 'mfj', addlMedicareThreshold: 25000000, otherSsEarningsCents: 20000000 }), 10000000);
    assert.equal(mfj.addlCents, 38115);        // threshold 25,000,000 - 20,000,000 = 5,000,000, same as above
  });
  test('SEC-73: no SE tax under $400 of net earnings; the floor is a profile value (default 40000 with a source note)', () => {
    const p = p26();
    assert.equal(p.seMinNetEarningsCents, 40000); assert.match(T.defaultProfile(2026).sourceNote, /under \$400/);
    const below = T.seTax(p, 43300);           // net 43,300 x 0.9235 = 39,987.55 -> 39,988 < 40,000
    assert.equal(below.netEarningsCents, 39988); assert.equal(below.totalCents, 0); assert.equal(below.deductionCents, 0); assert.equal(below.belowMinimum, true);
    const at = T.seTax(p, 43313);              // 39,999.56 -> 40,000: at the floor, taxed
    assert.equal(at.netEarningsCents, 40000); assert.equal(at.ssCents, 4960); assert.equal(at.medicareCents, 1160); assert.equal(at.deductionCents, 3060);
    assert.equal(T.seTax(p, -100000).totalCents, 0, 'a loss has no SE tax');
    const old = clone(T.defaultProfile(2026)); delete old.seMinNetEarningsCents;
    assert.equal(T.cleanProfile(old).seMinNetEarningsCents, 40000, 'a profile saved before the field existed gets the default');
  });
  test('SEC-73: the floor is editable and validated', () => {
    const z = T.seTax(p26({ seMinNetEarningsCents: 0 }), 43300);
    assert.equal(z.ssCents, 4959);   // 39,988 x 0.124 = 4,958.512 -> 4,959
    assert.equal(z.medicareCents, 1160);   // 39,988 x 0.029 = 1,159.652 -> 1,160
    assert.throws(() => T.cleanProfile(p26({ seMinNetEarningsCents: -1 })));
    assert.throws(() => T.cleanProfile(p26({ seMinNetEarningsCents: 1.5 })));
  });
});

describe('deductions: mileage, meals, home office (SEC-74), gross reimbursables', () => {
  test('mileage: dated periods, round trips, rounding per trip, out-of-order list sorted, empty list deducts nothing', () => {
    const p = p26();
    assert.equal(T.tripCents(p, { date: '2026-06-30', miles: 100, roundTrip: false }), 7250);   // 100 x 72.5
    assert.equal(T.tripCents(p, { date: '2026-07-01', miles: 100, roundTrip: false }), 7600);   // 100 x 76
    assert.equal(T.tripCents(p, { date: '2026-07-01', miles: 10.1, roundTrip: true }), 1535);   // 20.2 x 76 = 1,535.2
    assert.equal(T.tripCents(p, { date: '2026-01-02', miles: 0.3, roundTrip: false }), 22);     // 0.3 x 72.5 = 21.75 -> 22
    const rev = T.cleanProfile(p26({ mileageRates: [{ from: '2026-07-01', centsPerMile: 76 }, { from: '2026-01-01', centsPerMile: 72.5 }] }));
    assert.deepEqual(rev.mileageRates.map((r) => r.from), ['2026-01-01', '2026-07-01']);
    const empty = T.cleanProfile(p26({ mileageRates: [] }));
    assert.equal(T.tripCents(empty, { date: '2026-07-01', miles: 100, roundTrip: false }), null);
    const c = T.compute(build((x) => { B.addTrip(x, { date: '2026-03-01', miles: '10', from: '', to: '', purpose: '' }); }, { mileageRates: [] }), 2026);
    assert.equal(c.mileageCents, 0); assert.equal(c.unratedTrips, 1);
  });
  test('meals at their percentage, rounded per entry', () => {
    const c = T.compute(build((x) => x.entries.push(inc('2026-01-01', 1000), exp('2026-01-02', 100.01, { category: 'Meals' }), exp('2026-01-03', 0.03, { category: 'Meals' }))), 2026);
    assert.equal(c.lines.find((l) => l.id === 'meals').cents, 5001 + 2);   // 10,001 / 2 = 5,000.5 -> 5,001 ; 3 / 2 = 1.5 -> 2
    const c80 = T.compute(build((x) => x.entries.push(exp('2026-01-02', 100, { category: 'Meals' })), { mealsPct: 80 }), 2026);
    assert.equal(c80.expenseCents, 8000);
  });
  test('home office: rate x min(sq ft, cap) x months / 12, and SEC-74 limited to income less other business expenses', () => {
    const p = p26();
    assert.equal(T.homeOfficeCents(p, { squareFeet: 400, monthsUsed: 12 }), 150000);   // capped at 300 x $5
    assert.equal(T.homeOfficeCents(p, { squareFeet: 120, monthsUsed: 7 }), 35000);     // 120 x 500 x 7 / 12 = 35,000
    assert.equal(T.homeOfficeCents(p, { squareFeet: 100, monthsUsed: 5 }), 20833);     // 100 x 500 x 5 / 12 = 20,833.3
    const lim = T.compute(build((x) => { x.entries.push(inc('2026-02-01', 1000), exp('2026-02-02', 300, { category: 'Supplies' })); B.setHomeOffice(x, 2026, { squareFeet: 300, monthsUsed: 12 }); }), 2026);
    assert.equal(lim.homeOfficeFullCents, 150000); assert.equal(lim.homeOfficeCents, 70000);   // 100,000 - 30,000
    assert.equal(lim.homeOfficeLimited, true); assert.equal(lim.profitCents, 0); assert.equal(lim.se.totalCents, 0);
    const loss = T.compute(build((x) => { x.entries.push(exp('2026-02-02', 300, { category: 'Supplies' })); B.setHomeOffice(x, 2026, { squareFeet: 300, monthsUsed: 12 }); }), 2026);
    assert.equal(loss.homeOfficeCents, 0, 'never creates or increases a loss'); assert.equal(loss.profitCents, -30000);
    const full = T.compute(build((x) => { x.entries.push(inc('2026-02-01', 5000)); B.setHomeOffice(x, 2026, { squareFeet: 300, monthsUsed: 12 }); }), 2026);
    assert.equal(full.homeOfficeCents, 150000); assert.equal(full.homeOfficeLimited, false);
    assert.equal(full.byLineOfWork.lines.reduce((a, r) => a + r.homeOfficeCents, 0), full.homeOfficeCents, 'the by-line table uses the limited figure');
    const lim2 = full.byLineOfWork.lines.reduce((a, r) => a + r.netCents, 0); assert.equal(lim2, full.profitCents);
  });
  test('reimbursable expenses are gross: the invoice counts in full when received, the expense keeps its own line', () => {
    let s = build((x) => {
      x.projects.push(proj('c', 'Client'));
      x.entries.push(exp('2026-02-01', 500, { id: 'rx', category: 'Travel', billable: true, reimbursable: true, projectId: 'c' }));
      const inv = B.createInvoice(x, { projectId: 'c', issueDate: '2026-02-05', dueDate: '2026-03-07', lines: [line('Work', 1, 100000)] });
      B.addBillable(x, inv.id, 'rx'); B.markSent(x, inv.id); B.createExpectedIncome(x, inv.id);
    });
    const id = s.invoices[0].id;
    assert.equal(B.invoiceTotal(s.invoices[0]), 150000);
    let c = T.compute(s, 2026);
    assert.equal(c.incomeCents, 0, 'expected income is not counted'); assert.equal(c.expenseCents, 50000);
    B.markPaid(s, id, '2026-03-01'); B.settleIncome(s, id); s = S.validateState(clone(s));
    c = T.compute(s, 2026);
    assert.equal(c.incomeCents, 150000); assert.equal(c.lines.find((l) => l.id === 'travel').cents, 50000);
    assert.equal(c.reimbursedCents, 50000); assert.equal(c.profitCents, 100000);
    assert.equal(s.entries.filter((e) => e.type === 'income').length, 1, 'one income per invoice');
    assert.throws(() => B.settleIncome(s, id), /already counted/);
  });
});

describe('invoices: no double counting, void, optional line of work (deviation e)', () => {
  test('void keeps the expected income unlinked and uncounted; paid then settled counts once on the paid date', () => {
    const s = build((x) => {
      const a = B.createInvoice(x, { issueDate: '2026-04-01', dueDate: '2026-05-01', lines: [line('A', 2, 12345)] });
      B.markSent(x, a.id); B.createExpectedIncome(x, a.id); B.voidInvoice(x, a.id);
    });
    const inv = s.invoices[0];
    assert.equal(inv.status, 'void'); assert.equal(inv.incomeId, undefined);
    const e = s.entries.find((x) => x.type === 'income');
    assert.equal(e.status, 'expected', 'never deleted, never received');
    assert.equal(T.compute(s, 2026).incomeCents, 0);
    assert.equal(B.aging(s, '2026-12-31').openCount, 0, 'a void invoice is not open');
  });
  test('(e) an invoice with no line of work: line totals, aging and Unassigned income all work', () => {
    const s = build((x) => {
      const a = B.createInvoice(x, { issueDate: '2026-01-01', dueDate: '2026-01-31', lines: [line('A', 1.5, 3333), line('B', 0.33, 101)] });
      B.markSent(x, a.id); B.createExpectedIncome(x, a.id);
    });
    const inv = s.invoices[0];
    assert.equal(inv.projectId, undefined);
    assert.equal(B.lineTotal(inv.lines[0]), 5000);   // 1.5 x 3,333 = 4,999.5 -> 5,000
    assert.equal(B.lineTotal(inv.lines[1]), 33);     // 0.33 x 101 = 33.33 -> 33
    assert.equal(B.invoiceTotal(inv), 5033);
    const ag = B.aging(s, '2026-03-15');            // 43 days past due
    assert.equal(ag.buckets.d31_60.count, 1); assert.equal(ag.buckets.d31_60.cents, 5033); assert.equal(ag.overdueCents, 5033);
    const e = s.entries.find((x) => x.type === 'income');
    assert.equal(e.projectId, undefined); assert.equal(e.value, 50.33);
    B.markPaid(s, inv.id, '2026-03-20'); B.settleIncome(s, inv.id);
    const c = T.compute(S.validateState(clone(s)), 2026);
    assert.equal(c.incomeCents, 5033); assert.equal(c.byLineOfWork.lines[0].projectId, null); assert.equal(c.byLineOfWork.lines[0].incomeCents, 5033);
  });
});

describe('1099-NEC, due dates, safe harbor and installments', () => {
  test('the 1099 threshold: just under is not flagged, exactly at is; card payments are left out', () => {
    const mk = (cents, card) => build((x) => {
      B.addPayee(x, { name: 'Pat' }); const id = x.payees[0].id;
      x.entries.push(exp('2026-05-01', cents / 100, { category: 'Contract labor', payeeId: id }));
      if (card) x.entries.push(exp('2026-05-02', 50, { category: 'Contract labor', payeeId: id, cardPaid: true }));
    });
    assert.equal(T.payeeTotals(mk(199999, true), 2026).rows[0].reaches, false);
    assert.equal(T.payeeTotals(mk(199999, true), 2026).rows[0].cardCents, 5000);
    assert.equal(T.payeeTotals(mk(200000), 2026).rows[0].reaches, true);
    assert.equal(T.payeeTotals(mk(200000), 2026).due.date, '2027-02-01', 'January 31, 2027 is a Sunday');
  });
  test('weekend and holiday shifts', () => {
    const hs = T.defaultProfile(2026).holidays;
    assert.equal(T.shiftDue('2026-07-04', hs), '2026-07-06');   // Saturday -> Monday
    assert.equal(T.shiftDue('2026-11-26', hs), '2026-11-27');   // Thanksgiving (Thursday) -> Friday
    assert.equal(T.shiftDue('2027-01-16', hs), '2027-01-19');   // Saturday, Sunday, then MLK Day -> Tuesday
    assert.equal(T.shiftDue('2027-01-15', hs), '2027-01-15');   // Friday stays
    const d = T.dueDates(T.cleanProfile(p26({ dueDates: { federal: ['2026-04-18', '2026-06-15', '2026-09-15', '2027-01-15'], nj: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-16'] } })));
    assert.equal(d.federal[0].date, '2026-04-20'); assert.equal(d.nj[3].date, '2027-01-19');
  });
  test('federal safe harbor: 100% or 110% of prior-year tax against 90% of the current estimate', () => {
    const mk = (prior, flag) => T.compute(build((x) => x.entries.push(inc('2026-02-01', 100000)), { federalEffectiveRate: 0.1, priorYearFederalTax: prior, priorYearAgiOver150k: !!flag }), 2026);
    // profit 10,000,000: SE 1,412,955 ; deduction (1,145,140 + 267,815) / 2 = 706,477.5 -> 706,478 ; base 9,293,522 ; fed 929,352.2 -> 929,352
    const a = mk(1000000);
    assert.equal(a.se.deductionCents, 706478); assert.equal(a.federalTaxCents, 929352);
    assert.equal(a.safeHarbor.federal.currentBasedCents, 2108076);   // 90% of (1,412,955 + 929,352 = 2,342,307) = 2,108,076.3
    assert.equal(a.safeHarbor.federal.priorBasedCents, 1000000); assert.equal(a.safeHarbor.federal.targetCents, 1000000);
    assert.deepEqual(a.safeHarbor.federal.installments, [250000, 250000, 250000, 250000]);
    const b = mk(1000000, true); assert.equal(b.safeHarbor.federal.priorBasedCents, 1100000); assert.equal(b.safeHarbor.federal.targetCents, 1100000);
    const c = mk(5000000); assert.equal(c.safeHarbor.federal.targetCents, 2108076, 'the current-year side is smaller');
    assert.deepEqual(c.safeHarbor.federal.installments, [527019, 527019, 527019, 527019]);
    assert.equal(mk(null).safeHarbor.federal, null, 'no prior-year figure: not shown');
  });
  test('NJ safe harbor: the lesser of 80% of current-year tax or 100% of prior-year tax', () => {
    const mk = (prior) => T.compute(build((x) => x.entries.push(inc('2026-02-01', 100000)), { njEffectiveRate: 0.05, priorYearNjTax: prior }), 2026);
    // NJ base 10,000,000 (no half-SE deduction, SEC-75) ; tax 500,000 ; 80% = 400,000
    assert.equal(mk(450000).safeHarbor.nj.targetCents, 400000);
    assert.equal(mk(350000).safeHarbor.nj.targetCents, 350000);
    assert.equal(mk(null).safeHarbor.nj, null);
  });
  test('installments: no cent lost or created across four quarters, remainder to the earliest quarters', () => {
    assert.deepEqual(T.installments(2108075), [527019, 527019, 527019, 527018]);
    assert.deepEqual(T.installments(3), [1, 1, 1, 0]);
    let seed = 7;
    for (let i = 0; i < 2000; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const t = seed % 100000000, q = T.installments(t);
      assert.equal(q.reduce((a, b) => a + b, 0), t); assert.ok(Math.max(...q) - Math.min(...q) <= 1);
    }
  });
});

describe('deviation (a), SEC-76: the closed-vault refusal is exact', () => {
  fast();
  const base = () => build((x) => {
    x.projects.push(proj('c', 'Client'), proj('kid', 'Child line'), proj('p', 'Parent', { kind: 'venture' }));
    x.projects.find((q) => q.id === 'kid').parentId = 'p';
    B.addPayee(x, { name: 'Pat' }); x.payees[0].id = 'pe';
    x.entries.push(inc('2026-02-01', 100, { id: 'i26' }), exp('2025-05-01', 40, { id: 'x25', category: 'Contract labor', payeeId: 'pe' }));
    x.entries.push(inc('2024-05-01', 10, { id: 'k24', projectId: 'kid' }));
    x.taxPayments.push({ id: 'tp', year: 2026, jurisdiction: 'federal', quarter: 4, amountCents: 100, paidOn: '2027-01-15' });
    x.payees.push({ id: 'lone', name: 'Nobody', tinOnFile: false, archived: false });
    x.projects.push(proj('empty', 'Empty biz line'));
  });
  const blockedYears = () => [2024, 2025, 2026, 2027].filter((y) => T.blocked(S.getState(), y));
  test('a private payee or line of work with no record of a year refuses nothing (the old wildcard did)', async () => {
    await vault(base()); await P.setUp(PRIV);
    await P.moveIn('payees', 'lone'); await P.moveIn('projects', 'empty'); P.close();
    assert.deepEqual(blockedYears(), []);
    assert.ok(!S.getState().priv.marks.includes('business'));
  });
  test('a public expense whose payee is private refuses its own year only, and moving it to another year while closed refuses that year too', async () => {
    await vault(base()); await P.setUp(PRIV);
    await P.moveIn('payees', 'pe', { children: false }); P.close();
    assert.deepEqual(blockedYears(), [2025]);
    await P.write((x) => { x.entries.find((e) => e.id === 'x25').date = '2026-06-01'; });
    assert.deepEqual(blockedYears(), [2025, 2026], 'never under-refuses after a closed edit');
    await P.write((x) => { x.entries.push(E({ id: 'new', domain: 'money', type: 'expense', date: '2027-01-02', title: 'n', value: 1, scope: 'personal' })); });
    assert.ok(blockedYears().includes(2027), 'a new record while links are hidden marks its year (conservative)');
    await P.open(PRIV);
    assert.equal(T.blocked(P.view(S.getState()), 2026), false, 'an open view never refuses');
  });
  test('a private expense, a private tax payment and a public line under a private parent mark exactly their years', async () => {
    await vault(base()); await P.setUp(PRIV);
    await P.moveIn('entries', 'i26'); P.close();
    assert.deepEqual(blockedYears(), [2026]);
    await P.open(PRIV); await P.moveOut('entries', 'i26'); await P.moveIn('taxPayments', 'tp'); P.close();
    assert.deepEqual(blockedYears(), [2026], 'the payment year, not the 2027 paid date');
    await P.open(PRIV); await P.moveOut('taxPayments', 'tp'); await P.moveIn('projects', 'p', { children: false }); P.close();
    assert.deepEqual(blockedYears(), [2024], 'the child line has business income in 2024 only');
    await P.open(PRIV); await P.moveOut('projects', 'p'); P.close();
    assert.deepEqual(blockedYears(), []);
  });
  test('the digest omits the tax fields (never zero) exactly when the week\'s year is refused; a reserve kept private is hidden (SEC-77)', async () => {
    const s = base(); s.accounts.push({ id: 'ac', name: 'Reserve', kind: 'cash', liability: false, archived: false });
    s.entries.push(E({ id: 'bal', domain: 'assets', type: 'balance', accountId: 'ac', date: '2026-03-01', value: 500, title: 'b' }));
    s.settings.business.reserveAccountId = 'ac';
    await vault(S.validateState(clone(s))); await P.setUp(PRIV);
    assert.equal(T.compute(S.getState(), 2026).reserveCents, 50000);
    await P.moveIn('entries', 'bal'); P.close();
    const c = T.compute(S.getState(), 2026);
    assert.equal(c.blocked, false); assert.equal(c.reserveHidden, true); assert.equal(c.reserveCents, null); assert.equal(c.gapCents, null);
    await P.open(PRIV); await P.moveIn('entries', 'i26'); P.close();
    const dg = M.weeklyDigest(S.getState(), '2026-03-02');
    assert.ok(dg.business && !('tax' in dg.business), 'tax fields omitted');
    assert.ok(!/business profit/.test(JSON.stringify(Mem.buildPrompt(S.getState(), 1, { from: '2026-03-02', to: '2026-03-08' }))));
  });
  test('the mark list stays valid with records spread over many years (no lockout at the old 40-year cap)', async () => {
    const s = build((x) => { for (let y = 1950; y < 2030; y++) x.entries.push(exp(y + '-01-01', 1, { id: 'y' + y })); });
    await vault(s); await P.setUp(PRIV);
    for (let y = 1950; y < 2030; y++) await P.moveIn('entries', 'y' + y);
    P.close();
    assert.equal(S.getState().priv.marks.filter((m) => /^business-\d{4}$/.test(m)).length, 80);
    assert.doesNotThrow(() => S.validateState(clone(S.getState())));
  });
});

describe('SEC-83: a public entry that keeps a private line of work id (PV-2) refuses its year', () => {
  test('marks name projects and a 2026 entry points at a missing line: 2026 refuses, 2025 does not; an open view never does', () => {
    const s = build((x) => { x.entries.push(E({ id: 'd', domain: 'money', type: 'income', date: '2026-04-01', title: 'd', value: 5 })); });
    s.entries[0].projectId = 'gone';
    s.priv = { marks: ['projects'] };
    assert.equal(T.blocked(s, 2026), true); assert.equal(T.blocked(s, 2025), false);
    assert.equal(T.compute(s, 2026).blocked, true);
    s.priv = { marks: [] }; assert.equal(T.blocked(s, 2026), false, 'without private lines the id is not a hidden link');
  });
});

describe('deviation (b), SEC-78: the accountant export', () => {
  fast();
  test('private records stay out unless ticked; with a private business record of the year the unticked export refuses and says why', async () => {
    const s = build((x) => { x.entries.push(inc('2026-02-01', 100, { id: 'pub' }), inc('2026-03-01', 900, { id: 'pv', title: 'SECRET client' })); });
    await vault(s); await P.setUp(PRIV); await P.moveIn('entries', 'pv');
    const view = P.view(S.getState());
    const off = T.exportPackage(view, 2026, false);
    assert.equal(off.blocked, true); assert.equal(off.leftOut, true); assert.match(off.message, /left out/);
    assert.throws(() => T.exportCsv(off, () => ''), /left out/);
    const on = T.exportPackage(view, 2026, true);
    assert.equal(on.privateIncluded, true); assert.equal(on.summary.incomeCents, 100000);
    assert.match(T.exportCsv(on, () => ''), /"Private records","included"/);
    const y25 = T.exportPackage(view, 2025, false);
    assert.equal(y25.blocked, false); assert.equal(y25.privateIncluded, false);
    P.close();
    assert.equal(T.exportPackage(S.getState(), 2026, true).blocked, true, 'closed: refuses even when asked to include');
    assert.equal(T.exportPackage(S.getState(), 2026, false).message, T.BLOCK_MESSAGE);
  });
  test('CSV cells cannot start a formula', () => {
    const s = build((x) => {
      B.addPayee(x, { name: '=HYPERLINK("http://x")' });
      x.entries.push(exp('2026-02-01', 5, { title: '+cmd|x', category: 'Contract labor', payeeId: x.payees[0].id }), inc('2026-02-02', 50, { title: '@SUM(A1)' }));
      B.addTrip(x, { date: '2026-02-03', from: '-2+3', to: '\tx', miles: '1', purpose: 'ok' });
    });
    const csv = T.exportCsv(T.exportPackage(s, 2026, false), () => '');
    for (const bad of ['"=HYPERLINK', '"+cmd', '"@SUM', '"-2+3', '"\tx']) assert.ok(!csv.includes(bad), bad);
    for (const ok of ['"\'=HYPERLINK', '"\'+cmd', '"\'@SUM', '"\'-2+3']) assert.ok(csv.includes(ok), ok);
  });
});

describe('deviation (c): the scope migration counts once, loses nothing and stays stable', () => {
  fast();
  test('schema 11 to 12 writes no scope, asks once, and the derived counts survive a backup round trip and the private vault', async () => {
    const s11 = clone(S.defaultState()); s11.schema = 11; delete s11.settings.business;
    for (const k of ['payees', 'invoices', 'trips', 'taxPayments', 'taxYears', 'homeOffice', 'taxMap']) delete s11[k];
    s11.projects.push(proj('c', 'Client'), proj('h', 'Hobby', { kind: 'personal' }));
    s11.entries.push(E({ id: 'a', domain: 'money', type: 'income', date: '2026-01-01', title: 'a', value: 1, projectId: 'c' }), E({ id: 'b', domain: 'money', type: 'expense', date: '2026-01-02', title: 'b', value: 2, projectId: 'h' }), E({ id: 'd', domain: 'money', type: 'expense', date: '2026-01-03', title: 'd', value: 3 }));
    const m = S.validateState(clone(s11));
    assert.equal(m.schema, 14); assert.equal(m.settings.business.scopeConfirmed, false);
    assert.ok(m.entries.every((e) => e.scope === undefined), 'nothing rewritten');
    assert.deepEqual(B.scopeCounts(m), { business: 1, personal: 2 });
    const again = S.validateState(clone(m));
    assert.deepEqual(B.scopeCounts(again), { business: 1, personal: 2 }); assert.equal(again.settings.business.scopeConfirmed, false);
    assert.deepEqual(m.entries.map((e) => [e.id, e.value]), [['a', 1], ['b', 2], ['d', 3]]);
    await vault(m); await P.setUp(PRIV); await P.moveIn('projects', 'c', { children: false }); P.close();
    assert.equal(T.blocked(S.getState(), 2026), true, 'the line of work that makes entry a business is private: refused, not counted as personal');
    await P.open(PRIV);
    assert.deepEqual(B.scopeCounts(P.view(S.getState())), { business: 1, personal: 2 }, 'the same counts once open');
    await P.write((x) => B.confirmScope(x));
    assert.equal(S.getState().settings.business.scopeConfirmed, true);
    assert.deepEqual(P.view(S.getState()).entries.map((e) => e.scope).sort(), ['business', 'personal', 'personal']);
  });
});

describe('deviation (d): homeOffice and taxYears carry no leaking free text and follow the caps', () => {
  test('prototype keys, unknown years, caps and text limits', () => {
    const s = build();
    for (const bad of ['{"__proto__":{"squareFeet":1,"monthsUsed":1}}', '{"constructor":{"squareFeet":1,"monthsUsed":1}}', '{"2026":{"squareFeet":1,"monthsUsed":13}}', '{"2026":{"squareFeet":"1","monthsUsed":1}}']) {
      const o = clone(s); o.homeOffice = JSON.parse(bad); assert.throws(() => S.validateState(o), bad);
    }
    const o2 = clone(s); o2.homeOffice = { 2026: { squareFeet: 10, monthsUsed: 2, note: 'free text' } };
    assert.deepEqual(S.validateState(o2).homeOffice['2026'], { squareFeet: 10, monthsUsed: 2 }, 'unknown fields are dropped');
    for (const bad of ['{"__proto__":{}}', '{"prototype":{}}']) { const o = clone(s); o.taxYears = JSON.parse(bad); assert.throws(() => S.validateState(o), bad); }
    const many = clone(s); many.taxYears = {}; for (let y = 2000; y < 2031; y++) many.taxYears[y] = clone(s.taxYears['2026']);
    assert.throws(() => S.validateState(many), /too many/);
    const long = clone(s); long.taxYears['2026'].sourceNote = 'x'.repeat(1201); assert.throws(() => S.validateState(long));
    const sneak = clone(s); sneak.taxYears['2026'].extra = 'free text'; sneak.taxYears['2026'].safeHarbor.extra = 'x';
    const v = S.validateState(sneak); assert.equal(v.taxYears['2026'].extra, undefined); assert.equal(v.taxYears['2026'].safeHarbor.extra, undefined);
  });
  test('the profile notes never reach the digest or the prompt', () => {
    const s = build(null, { sourceNote: 'NOTEMARK source', mileageRates: [{ from: '2026-01-01', centsPerMile: 72.5, note: 'RATEMARK note' }] });
    const t = JSON.stringify(M.weeklyDigest(s, '2026-03-02')) + JSON.stringify(Mem.buildPrompt(s, 1, { from: '2026-03-02', to: '2026-03-08' }));
    assert.ok(!t.includes('NOTEMARK') && !t.includes('RATEMARK'));
  });
});

describe('SEC-79: the secrets guard on invoice and payee fields (SSN and EIN shapes)', () => {
  test('EIN and SSN shapes are refused in invoice numbers, lines, notes, business details and payee names', () => {
    const s = build();
    for (const id of ['12-3456789', '123-45-6789', 'EIN 12 3456789']) {
      assert.throws(() => B.createInvoice(s, { issueDate: '2026-01-01', dueDate: '2026-01-31', number: id, lines: [] }), /tax ID|ID number/, 'number ' + id);
      assert.throws(() => B.createInvoice(s, { issueDate: '2026-01-01', dueDate: '2026-01-31', lines: [line('Fee ' + id, 1, 1)] }), /tax ID|ID number/, 'line ' + id);
      assert.throws(() => B.createInvoice(s, { issueDate: '2026-01-01', dueDate: '2026-01-31', lines: [], notes: 'our EIN ' + id }), /tax ID|ID number/, 'notes ' + id);
      assert.throws(() => B.saveSettings(s, { address: '1 Main St ' + id }), /tax ID|ID number/, 'address ' + id);
      assert.throws(() => B.addPayee(s, { name: 'Pat ' + id }), /tax ID/, 'payee ' + id);
    }
    const inv = B.createInvoice(s, { issueDate: '2026-01-01', dueDate: '2026-01-31', lines: [line('Consulting', 1, 100)] });
    assert.throws(() => B.editDraft(s, inv.id, { number: '12-3456789' }), /tax ID/);
    assert.equal(inv.number, 'INV-0001');
  });
});

describe('SEC-80: performance at the caps', () => {
  test('5,000 invoices of 50 lines, 10,000 trips and 50,000 entries compute within a few seconds', () => {
    const s = build();
    s.projects.push(proj('c', 'Client'));
    for (let i = 0; i < 5000; i++) s.invoices.push({ id: 'v' + i, number: 'INV-' + String(i + 1).padStart(4, '0'), projectId: 'c', issueDate: '2026-01-01', dueDate: '2026-02-01', lines: Array.from({ length: 50 }, (_, k) => ({ description: 'l' + k, qty: 1, unitCents: 100 })), status: 'sent', notes: '' });
    for (let i = 0; i < 10000; i++) s.trips.push({ id: 't' + i, date: '2026-0' + (1 + (i % 9)) + '-01', from: '', to: '', miles: 12.3, purpose: '', roundTrip: false, projectId: 'c' });
    for (let i = 0; i < 50000; i++) s.entries.push({ id: 'e' + i, domain: 'money', type: i % 2 ? 'expense' : 'income', date: '2026-0' + (1 + (i % 9)) + '-02', title: 'x', value: 1, scope: 'business', category: 'Supplies', projectId: 'c', createdAt: '2026-01-01T00:00:00.000Z' });
    const v = S.validateState(clone(s));
    const t0 = Date.now();
    const n = B.nextNumber(v, '2026-03-01');
    assert.equal(n.number, 'INV-5001');
    const ag = B.aging(v, '2026-03-01'); assert.equal(ag.openCount, 5000); assert.equal(ag.openCents, 5000 * 5000);
    const c = T.compute(v, 2026); assert.equal(c.incomeCents, 25000 * 100); assert.equal(c.tripCount, 10000);
    T.payeeTotals(v, 2026); L.admin.timeline(v, '2026-03-01'); M.weeklyDigest(v, '2026-03-02');
    const ms = Date.now() - t0;
    assert.ok(ms < 8000, 'took ' + ms + ' ms');
  });
});
