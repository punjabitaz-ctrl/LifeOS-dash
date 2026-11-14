import { test } from 'node:test';
import assert from 'node:assert/strict';
import { L, E } from './_load.mjs';
const M = L.metrics;
const TODAY = '2026-11-12'; // Thursday; week 2026-11-09 .. 2026-11-15
const st = () => L.store.defaultState();
const withEntries = (...es) => { const s = st(); s.entries = es; return s; };

test('weekStart returns Monday', () => {
  assert.equal(M.weekStart('2026-11-12'), '2026-11-09');
  assert.equal(M.weekStart('2026-11-09'), '2026-11-09');
  assert.equal(M.weekStart('2026-11-15'), '2026-11-09');
  assert.equal(M.weekStart('2026-11-16'), '2026-11-16');
  assert.throws(() => M.weekStart('nope'));
});
test('DOMAINS shape and alias', () => {
  assert.equal(L.DOMAINS, M.DOMAINS);
  assert.deepEqual(M.DOMAINS.map((d) => d.id), ['money', 'assets', 'work', 'health', 'activities', 'social', 'learning', 'home', 'admin', 'goals', 'wellbeing']);
  for (const d of M.DOMAINS) for (const t of d.types) assert.ok(Array.isArray(t.fields));
});
test('validateEntry', () => {
  assert.throws(() => M.validateEntry({ domain: 'x', type: 'y', date: '2026-01-01', title: 't' }), /domain/);
  assert.throws(() => M.validateEntry({ domain: 'money', type: 'income', date: '2026-02-30', title: 't', value: 1 }), /Date/);
  assert.throws(() => M.validateEntry({ domain: 'money', type: 'income', date: '2026-01-01', title: '  ', value: 1 }), /Title/);
  assert.throws(() => M.validateEntry({ domain: 'money', type: 'income', date: '2026-01-01', title: 't' }), /required/);
  assert.throws(() => M.validateEntry({ domain: 'wellbeing', type: 'mood', date: '2026-01-01', title: 't', value: 6 }));
  assert.throws(() => M.validateEntry({ domain: 'social', type: 'contact', date: '2026-01-01', title: 't' }), /Person/);
  assert.throws(() => M.validateEntry({ domain: 'work', type: 'outcome', date: '2026-01-01', title: 't', status: 'weird' }));
  const e = M.validateEntry({ domain: 'money', type: 'income', date: '2026-01-01', title: 't', value: '12.5', notes: '  hi ' });
  assert.equal(e.value, 12.5); assert.equal(e.notes, 'hi'); assert.ok(e.id && e.createdAt);
  assert.equal(M.validateEntry({ domain: 'work', type: 'outcome', date: '2026-01-01', title: 't' }).status, 'todo');
});

test('headline money: savings rate this month', () => {
  const s = withEntries(E({ domain: 'money', type: 'income', value: 5000 }), E({ domain: 'money', type: 'expense', value: 4000 }),
    E({ domain: 'money', type: 'income', value: 999, date: '2026-10-30' }));
  const h = M.headline(s, 'money', TODAY);
  assert.equal(h.value, 20); assert.equal(h.display, '20%'); assert.equal(typeof h.label, 'string'); assert.equal(typeof h.sub, 'string');
  assert.equal(M.headline(st(), 'money', TODAY).display, 'n/a');
});
test('headline assets: latest balance per account', () => {
  const s = withEntries(E({ domain: 'assets', type: 'balance', title: 'Bank', value: 100, date: '2026-10-01' }),
    E({ domain: 'assets', type: 'balance', title: 'bank', value: 300, date: '2026-11-01' }),
    E({ domain: 'assets', type: 'balance', title: 'Card', value: -50, date: '2026-11-02' }));
  const h = M.headline(s, 'assets', TODAY);
  assert.equal(h.value, 250); assert.equal(h.display, '$250'); assert.equal(h.sub, '2 accounts');
});
test('headline work: outcomes done x of y', () => {
  const s = withEntries(E({ domain: 'work', type: 'outcome', status: 'done' }), E({ domain: 'work', type: 'outcome', status: 'todo' }),
    E({ domain: 'work', type: 'outcome', status: 'done', date: '2026-11-01' }));
  const h = M.headline(s, 'work', TODAY);
  assert.equal(h.display, '1 of 2'); assert.equal(h.value, 1);
});
test('headline health: workouts vs target', () => {
  const s = withEntries(E({ domain: 'health', type: 'workout' }), E({ domain: 'health', type: 'workout' }), E({ domain: 'health', type: 'sleep', value: 8 }));
  const h = M.headline(s, 'health', TODAY);
  assert.equal(h.display, '2 of 4'); assert.equal(h.value, 2); assert.equal(h.sub, '2 to go');
});
test('headline activities: distinct active days', () => {
  const s = withEntries(E({ domain: 'activities', type: 'session', date: '2026-11-10' }), E({ domain: 'activities', type: 'session', date: '2026-11-10' }),
    E({ domain: 'activities', type: 'session', date: '2026-11-11' }));
  const h = M.headline(s, 'activities', TODAY);
  assert.equal(h.value, 2); assert.equal(h.sub, '3 sessions');
});
test('headline social: people overdue', () => {
  const s = withEntries(E({ domain: 'social', type: 'contact', person: 'Ann', date: '2026-08-01' }),
    E({ domain: 'social', type: 'contact', person: 'ann', date: '2026-11-01' }),
    E({ domain: 'social', type: 'contact', person: 'Bob', date: '2026-09-01' }),
    E({ domain: 'social', type: 'contact', person: 'Cy', date: '2026-10-20' }));
  const h = M.headline(s, 'social', TODAY);
  assert.equal(h.value, 1); assert.match(h.sub, /^3 tracked/);
});
test('headline learning: items finished this month', () => {
  const s = withEntries(E({ domain: 'learning', type: 'item', status: 'done' }), E({ domain: 'learning', type: 'item', status: 'active' }),
    E({ domain: 'learning', type: 'item', status: 'done', date: '2026-10-10' }), E({ domain: 'learning', type: 'hours', value: 2.5 }));
  const h = M.headline(s, 'learning', TODAY);
  assert.equal(h.value, 1); assert.equal(h.sub, '2.5 hours logged');
});
test('headline home: items due within 30 days', () => {
  const s = withEntries(E({ domain: 'home', type: 'due', due: '2026-11-20', status: 'open' }), E({ domain: 'home', type: 'due', due: '2026-12-12', status: 'open' }),
    E({ domain: 'home', type: 'due', due: '2026-12-13', status: 'open' }), E({ domain: 'home', type: 'due', due: '2026-11-15', status: 'done' }),
    E({ domain: 'home', type: 'due', due: '2026-11-01', status: 'open' }));
  const h = M.headline(s, 'home', TODAY);
  assert.equal(h.value, 2); assert.equal(h.sub, '1 overdue');
});
test('headline goals: share on track, latest per goal, done excluded', () => {
  const s = withEntries(E({ domain: 'goals', type: 'goal', title: 'A', status: 'at-risk', date: '2026-10-01' }),
    E({ domain: 'goals', type: 'goal', title: 'A', status: 'on-track', date: '2026-11-01' }),
    E({ domain: 'goals', type: 'goal', title: 'B', status: 'off-track' }), E({ domain: 'goals', type: 'goal', title: 'C', status: 'done' }));
  const h = M.headline(s, 'goals', TODAY);
  assert.equal(h.value, 50); assert.equal(h.display, '50%');
});
test('headline wellbeing: 7-day mood average', () => {
  const s = withEntries(E({ domain: 'wellbeing', type: 'mood', value: 4, date: '2026-11-12' }), E({ domain: 'wellbeing', type: 'mood', value: 3, date: '2026-11-06' }),
    E({ domain: 'wellbeing', type: 'mood', value: 1, date: '2026-11-05' }));
  const h = M.headline(s, 'wellbeing', TODAY);
  assert.equal(h.value, 3.5); assert.equal(h.display, '3.5');
});
test('headline validates input and works on an empty state for every domain', () => {
  assert.throws(() => M.headline(st(), 'nope', TODAY));
  assert.throws(() => M.headline(st(), 'money', 'x'));
  for (const d of M.DOMAINS) {
    const h = M.headline(st(), d.id, TODAY);
    assert.equal(typeof h.display, 'string'); assert.ok(Number.isFinite(h.value));
  }
});
test('weeklyDigest now vs prev with units', () => {
  const s = withEntries(E({ domain: 'health', type: 'workout', date: '2026-11-10' }), E({ domain: 'health', type: 'workout', date: '2026-11-11' }),
    E({ domain: 'health', type: 'workout', date: '2026-11-03' }), E({ domain: 'wellbeing', type: 'mood', value: 4, date: '2026-11-10' }));
  const d = M.weeklyDigest(s, '2026-11-12');
  assert.equal(d.week, '2026-11-09');
  assert.deepEqual(d.domains.health, { now: 2, prev: 1, unit: 'workouts' });
  // SEC-66 (owner decision, a spec change): wellbeing is kept away from the AI, so an old thin mood entry adds no wellbeing number to the digest.
  assert.equal(d.domains.wellbeing, undefined);
  assert.ok(!('wellbeing' in d.domains));
  assert.equal(d.domains.assets.unit, 'USD');
  assert.deepEqual(Object.keys(d.domains).length, 10);
  assert.ok(!JSON.stringify(d).includes('t0'));
});
test('series returns n weekly points ending this week', () => {
  const s = withEntries(E({ domain: 'health', type: 'workout', date: '2026-11-10' }), E({ domain: 'health', type: 'workout', date: '2026-11-03' }));
  const r = M.series(s, 'health', 3, TODAY);
  assert.deepEqual(r, [{ label: '2026-10-26', value: 0 }, { label: '2026-11-02', value: 1 }, { label: '2026-11-09', value: 1 }]);
  assert.equal(M.series(s, 'money', 4).length, 4);
});
