// v0.7.0 audit regression tests (SEC-44 to SEC-47). SEC-48 is covered in test/smoke-home-admin.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E, S, M, Ad, TODAY, WK, clone, build, renew } from './_v070.mjs';

// SEC-44: the secrets guard folds what a paste can hide a number behind.
test('SEC-44: secrets guard is not bypassed by spaces, dots, dashes, invisible characters or non-ASCII digits', () => {
  const card = '4111111111111111';
  const sneaky = [
    '4111.1111.1111.1111', '4111 1111  1111 1111', '4111 1111-1111 1111', '4111 - 1111 - 1111 - 1111', '4111 1111 1111 1111',
    '4111 1111 1111 1111', '4111–1111–1111–1111', '4111​1111​1111​1111', '4111⁠' + card.slice(4), '4111­' + card.slice(4),
    '４１１１１１１１１１１１１１１１', // full-width
    '٤١١١١١١١١١١١١١١١', // Arabic-Indic
    '४१११ ११११ ११११ ११११', // Devanagari, grouped
    '3782.822463.10005', '3782 - 822463 - 10005',
    '123.45.6789', '123 - 45 - 6789', '123–45–6789', '123−45−6789', '123 45 6789', '1２3-45-6789', '١٢٣٤٥٦٧٨٩',
    '12​3​45​6789', 'SSN: 123 . 45 . 6789',
  ];
  for (const x of sneaky) {
    assert.equal(Ad.looksSecret(x), true, JSON.stringify(x));
    const s = S.defaultState();
    assert.throws(() => Ad.addDocument(s, { title: 'Card', whereKept: x }), (e) => e.message === Ad.SECRET_MESSAGE, JSON.stringify(x));
    assert.equal(s.documents.length, 0);
  }
  // No false positives on years, dates, phone numbers, amounts, versions and addresses.
  const fine = ['Renewed 2024.2025.2026.2027', '2024 - 2025 - 2026 - 2027', '2026.11.14', '14.11.2026', 'Call (609) 555-1234', '+1 609 555 1234', '+33 1 23 45 67 89', '+44 20 7946 0958', '609.555.1234',
    '€ 1.234.567,89', '1 234 567 890', '$ 12,345,678.90', 'IP 192.168.100.200', 'ISBN 978-0-306-40615-7', 'Version 10.2.3', 'Room 12 - 3', 'Shelf 4, box 1111', '4111 1111 1111 1112',
    '２０２６', '٢٠٢٦-١١-١٤', 'Top drawer of the oak desk'];
  for (const x of fine) assert.equal(Ad.looksSecret(x), false, JSON.stringify(x));
});

// SEC-45: renewals and tax items get the same guard where a card, licence or ID number could be pasted.
test('SEC-45: renewal title, provider and notes and tax item title and notes refuse card and ID numbers', () => {
  for (const f of ['title', 'provider', 'notes']) {
    const s = S.defaultState(), input = { title: 'Car insurance', kind: 'insurance', provider: 'Acme', dueDate: '2026-12-01', cadence: 'annual', notes: '' };
    input[f] = (f === 'title' ? 'Policy card ' : '') + '4111 1111 1111 1111';
    assert.throws(() => Ad.addRenewal(s, input, TODAY), (e) => e.message === Ad.SECRET_MESSAGE_FIELD, f);
    assert.equal(s.renewals.length, 0);
    input[f] = 'License 123-45-6789';
    assert.throws(() => Ad.addRenewal(s, input, TODAY), /ID number/, f);
  }
  for (const f of ['title', 'notes']) {
    const s = S.defaultState(), input = { year: '2025', title: 'W-2', notes: '' };
    input[f] = 'SSN 123 45 6789';
    assert.throws(() => Ad.addTaxItem(s, input), (e) => e.message === Ad.SECRET_MESSAGE_FIELD, f);
    assert.equal(s.taxItems.length, 0);
  }
  assert.doesNotMatch(Ad.SECRET_MESSAGE_FIELD, /index/);
  // Ordinary text still goes in, including policy-style numbers that are not 9 digits or Luhn-valid cards.
  const s = S.defaultState();
  Ad.addRenewal(s, { title: 'Car insurance 2026', kind: 'insurance', provider: 'Acme', dueDate: '2026-12-01', cadence: 'annual', notes: 'Policy AB-1234567, call 609-555-1234' }, TODAY);
  Ad.addTaxItem(s, { year: '2025', title: '1099-INT from bank', notes: '' });
  assert.equal(S.validateState(clone(s)).renewals.length, 1);
  // Older home/due entries with such notes still migrate: the guard is on typing, never on unlock.
  const old = S.defaultState(); old.schema = 5;
  for (const k of ['properties', 'vehicles', 'maintenance', 'renewals', 'documents', 'taxItems']) delete old[k];
  old.entries.push(E({ domain: 'home', type: 'due', title: 'Licence', due: '2026-12-01', status: 'open', notes: 'number 123-45-6789' }));
  assert.equal(S.validateState(clone(old)).renewals.length, 1);
});

// SEC-46: weekly review digests at the caps must still validate, or the review cannot be saved.
test('SEC-46: a weekly review saves when maintenance cost and subscription run-rate are at the caps', () => {
  const s = build((x) => {
    for (let i = 0; i < 2000; i++) x.maintenance.push({ id: 'm' + i, title: 'Job', area: '', cadence: 'once', lastDone: '2026-11-10', cost: 1e11, vendor: '', notes: '', state: 'done' });
    for (let i = 0; i < 2000; i++) x.renewals.push(renew({ id: 'r' + i, kind: 'subscription', cadence: 'custom', everyDays: 1, amount: 1e11, dueDate: '2027-01-01' }));
  });
  const dg = M.weeklyDigest(s, WK);
  assert.equal(dg.home.ytdCostCents, 2e14); assert.ok(dg.admin.runRateCents > 1e14);
  s.memory.reviews.push({ id: 'rv1', weekOf: WK, digest: dg, priorities: ['a', 'b', 'c'], completedAt: new Date().toISOString() });
  const got = S.validateState(clone(s));
  assert.equal(got.memory.reviews[0].digest.home.ytdCostCents, 2e14);
  s.memory.reviews[0].digest.home.ytdCostCents = Number.MAX_SAFE_INTEGER + 2;
  assert.throws(() => S.validateState(clone(s)), /digest home/);
});

// SEC-47: monthly and yearly renewals keep their day of the month after a short month.
test('SEC-47: a renewal on the 31st or 29 February does not drift to an earlier day for ever', () => {
  const chain = (first, cadence, steps) => {
    const s = build((x) => { x.renewals.push(renew({ id: 'c0', title: 'Rent', dueDate: first, cadence })); });
    const dates = [first];
    let id = 'c0';
    for (let i = 0; i < steps; i++) {
      const p = Ad.completeRenewal(s, id, TODAY, TODAY);
      assert.deepEqual(Ad.pendingRenewals(s).map((x) => x.dueDate), [p.dueDate], 'completion and the pending list agree');
      id = Ad.confirmRenewal(s, id).id;
      dates.push(s.renewals.find((r) => r.id === id).dueDate);
    }
    return dates;
  };
  assert.deepEqual(chain('2026-01-31', 'monthly', 6), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31']);
  assert.deepEqual(chain('2026-11-30', 'monthly', 4), ['2026-11-30', '2026-12-30', '2027-01-30', '2027-02-28', '2027-03-30']);
  assert.deepEqual(chain('2026-01-15', 'monthly', 2), ['2026-01-15', '2026-02-15', '2026-03-15']);
  assert.deepEqual(chain('2028-02-29', 'annual', 5), ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29', '2033-02-28']);
  // A date the user moved stays where they put it.
  const s = build((x) => { x.renewals.push(renew({ id: 'a', title: 'Gym', dueDate: '2026-01-31', cadence: 'monthly', state: 'done' }), renew({ id: 'b', title: 'Gym', dueDate: '2026-02-20', cadence: 'monthly', state: 'done' })); });
  assert.deepEqual(Ad.pendingRenewals(s).map((x) => x.dueDate), ['2026-03-20']);
});
