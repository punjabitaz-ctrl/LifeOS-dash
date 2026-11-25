// v2.1.0 (SPEC.md "v2.1.0 addendum: Eating"): saved meals, the meal log, the protein target, schema 21, the digest, the private vault,
// search and the AI boundary.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { L, PASS, memAdapter } from './_load.mjs';
import { fastKeys, realKeys, clone, PRIV } from './_archive.mjs';

const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), P = view('priv'), O = view('ops'), F = view('food'), M = view('metrics'), Mem = view('memory'), Q = view('search');
const NOSTORE = { get: async () => { throw new Error('NO_STORAGE'); }, set: async () => { throw new Error('NO_STORAGE'); }, del: async () => { throw new Error('NO_STORAGE'); } };
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { P.close('system'); } catch (e) { /* closed */ } try { S.lock(); } catch (e) { /* locked */ } S._setAdapter(NOSTORE); realKeys(); } });
const WK = '2026-11-23', TODAY = '2026-11-25'; // a Monday and the Wednesday of that week
const MARK = 'EATLEAK "q" marker with spaces';
async function vault(state, o = {}) {
  S._setAdapter(memAdapter()); S.lock(); await S.init(PASS);
  if (state) await S.replaceState(state);
  if (o.priv) { await P.setUp(PRIV); await P.open(PRIV); }
}
function sample() {
  const s = S.defaultState();
  const eggs = F.addMeal(s, { name: '3 eggs and toast', protein: '21', slot: 'breakfast' });
  const bowl = F.addMeal(s, { name: 'Chicken rice bowl', protein: '45', slot: 'lunch' });
  F.setProteinTarget(s, '150');
  return { s, eggs, bowl };
}

test('saved meals: add, edit, validation, cap and slot order', () => {
  const { s, eggs, bowl } = sample();
  assert.deepEqual(s.meals.map((m) => [m.name, m.protein, m.slot]), [['3 eggs and toast', 21, 'breakfast'], ['Chicken rice bowl', 45, 'lunch']]);
  F.updateMeal(s, eggs, { name: '  4 eggs‮ and toast ', protein: '28', slot: 'breakfast' });
  assert.equal(s.meals[0].name, '4 eggs and toast', 'bidi controls and extra spaces removed');
  assert.equal(s.meals[0].protein, 28);
  for (const bad of ['', '-1', '301', '2.5', '1e2', 'abc', ' ']) assert.throws(() => F.addMeal(s, { name: 'x', protein: bad }), /whole number/, bad);
  assert.throws(() => F.addMeal(s, { name: '   ', protein: '5' }), /name/);
  assert.throws(() => F.addMeal(s, { name: 'x'.repeat(61), protein: '5' }), /60/);
  assert.throws(() => F.addMeal(s, { name: 'x', protein: '5', slot: 'brunch' }), /list/);
  assert.equal(F.addMeal(s, { name: 'Dates', protein: '0' }) && s.meals[2].slot, 'any', 'slot defaults to any time');
  F.addMeal(s, { name: 'Yogurt', protein: '15', slot: 'snack' });
  assert.deepEqual(F.mealsBySlot(s).map((g) => g.slot), ['breakfast', 'lunch', 'snack', 'any']);
  while (s.meals.length < F.MEAL_CAP) F.addMeal(s, { name: 'm' + s.meals.length, protein: '1' });
  assert.throws(() => F.addMeal(s, { name: 'one more', protein: '1' }), /up to 50/);
  assert.equal(S.validateState(clone(s)).meals.length, 50);
  const over = clone(s); over.meals.push({ id: 'z', name: 'z', protein: 1, slot: 'any' });
  assert.throws(() => S.validateState(over), /too many/);
  void bowl;
});

test('logging copies the protein, so a later edit or delete of the saved meal never changes a past day', () => {
  const { s, eggs, bowl } = sample();
  F.logMeal(s, eggs, WK); F.logMeal(s, bowl, WK); F.logOneOff(s, '30', WK);
  F.updateMeal(s, eggs, { name: '2 eggs', protein: '14' });
  assert.equal(F.day(s, WK).protein, 21 + 45 + 30);
  F.deleteMeal(s, bowl);
  const d = F.day(s, WK);
  assert.equal(d.protein, 96); assert.equal(d.meals, 3);
  assert.deepEqual(d.rows.map((r) => F.mealName(s, r)), ['2 eggs', 'Removed meal', 'One-off']);
  assert.equal(s.mealLog[1].mealId, undefined, 'the link is dropped, the row kept');
  assert.throws(() => F.logMeal(s, bowl, WK), /no longer exists/);
  assert.throws(() => F.logMeal(s, eggs, '2026-02-30'), /day/);
  assert.throws(() => F.logOneOff(s, '400', WK), /whole number/);
});

test('day and week figures: target share, days at target, average per logged day, ate-for-health share; no data is null, never zero', () => {
  const s = S.defaultState();
  let w = F.week(s, WK);
  assert.equal(w.proteinAvg, null); assert.equal(w.proteinDays, null, 'no target: Set a target'); assert.equal(w.forHealthRate, null); assert.equal(w.meals, 0);
  assert.equal(F.day(s, WK).share, null);
  const { s: t, eggs, bowl } = sample();
  F.logMeal(t, eggs, WK); F.logMeal(t, bowl, WK); F.logOneOff(t, '90', WK);  // Mon 156
  F.logMeal(t, bowl, '2026-11-24');                                         // Tue 45
  F.logMeal(t, eggs, '2026-11-30');                                         // next Monday: outside the week
  w = F.week(t, WK);
  assert.equal(w.meals, 4); assert.equal(w.loggedDays, 2);
  assert.equal(w.proteinAvg, Math.round((156 + 45) / 2), 'days with nothing logged are left out');
  assert.equal(w.proteinDays, 1);
  assert.equal(w.forHealthRate, null, 'nothing answered yet');
  const ids = t.mealLog.filter((r) => r.date >= WK && r.date <= '2026-11-29').map((r) => r.id);
  F.setForHealth(t, ids[0], true); F.setForHealth(t, ids[1], true); F.setForHealth(t, ids[2], false);
  w = F.week(t, WK);
  assert.equal(w.answered, 3); assert.equal(w.forHealth, 2); assert.equal(w.forHealthRate, 66.7);
  F.setForHealth(t, ids[2], null);
  assert.equal(F.week(t, WK).forHealthRate, 100, 'cleared answers count in neither direction');
  assert.throws(() => F.setForHealth(t, ids[0], 'yes'), /yes or no/);
  const d = F.day(t, WK);
  assert.equal(d.share, 1); assert.equal(d.left, 0);
  assert.deepEqual(F.digest(t, WK), { meals: 4, proteinAvg: 101, proteinDays: 1, forHealthRate: 100 });
  assert.deepEqual(F.digest(S.defaultState(), WK), { meals: 0, proteinAvg: 0, proteinDays: 0, forHealthRate: 0 });
  F.removeLog(t, ids[0]);
  assert.equal(F.day(t, WK).meals, 2);
});

test('protein target: typed by the owner, 1 to 1000 whole grams, empty clears, never suggested', () => {
  const s = S.defaultState();
  assert.equal(F.targetOf(s), null);
  assert.deepEqual(s.settings.food, {}, 'a new vault has no target');
  assert.equal(F.setProteinTarget(s, ' 160 '), 160);
  for (const bad of ['0', '1001', '12.5', 'x']) assert.throws(() => F.setProteinTarget(s, bad), /whole number/);
  assert.equal(F.setProteinTarget(s, ''), null); assert.equal(F.targetOf(s), null);
  const v = clone(S.defaultState()); v.settings.food = { proteinTarget: 2000 };
  assert.throws(() => S.validateState(v), /protein target/);
  v.settings.food = { proteinTarget: 150, extra: 'x' };
  assert.deepEqual(S.validateState(v).settings.food, { proteinTarget: 150 }, 'unknown keys dropped');
});

test('schema 21: migrations from 1 and 20 give empty eating data; strict validation of saved meals and the log', () => {
  assert.equal(S.SCHEMA, 24);
  for (const n of [1, 4, 19, 20]) {
    const o = clone(S.defaultState()); o.schema = n; delete o.meals; delete o.mealLog; delete o.settings.food;
    if (n === 1) { for (const k of ['accounts', 'recurring', 'budgets', 'categories']) delete o[k]; }
    const v = S.validateState(o);
    assert.equal(v.schema, 24); assert.deepEqual(v.meals, []); assert.deepEqual(v.mealLog, []); assert.deepEqual(v.settings.food, {});
  }
  // A schema 20 copy that somehow carries the new keys does not smuggle them in.
  const o20 = clone(sample().s); o20.schema = 20;
  const v20 = S.validateState(o20);
  assert.deepEqual(v20.meals, []); assert.deepEqual(v20.settings.food, {});
  const { s, eggs } = sample(); F.logMeal(s, eggs, WK);
  const ok = S.validateState(clone(s));
  assert.equal(ok.meals.length, 2); assert.equal(ok.mealLog.length, 1);
  const bads = [
    (x) => { x.meals[0].protein = 1.5; }, (x) => { x.meals[0].protein = -1; }, (x) => { x.meals[0].name = ''; }, (x) => { x.meals[0].slot = 'brunch'; },
    (x) => { x.meals.push(clone(x.meals[0])); }, (x) => { x.mealLog[0].date = '2026-13-01'; }, (x) => { x.mealLog[0].protein = '21'; },
    (x) => { x.mealLog[0].forHealth = 'yes'; }, (x) => { x.mealLog[0].oneOff = true; }, (x) => { x.mealLog[0].oneOff = false; }, (x) => { x.mealLog.push(clone(x.mealLog[0])); }, (x) => { x.meals = {}; },
  ];
  for (const f of bads) { const x = clone(s); f(x); assert.throws(() => S.validateState(x), /Invalid data/, String(f)); }
  const dangling = clone(s); dangling.mealLog[0].mealId = 'gone';
  assert.equal(S.validateState(dangling).mealLog[0].mealId, undefined, 'a dangling link is dropped, the row kept');
  const extra = clone(s); extra.mealLog[0].note = MARK; extra.meals[0].notes = MARK;
  assert.ok(!JSON.stringify(S.validateState(extra)).includes('EATLEAK'), 'unknown fields are not kept');
  const polluted = JSON.parse(JSON.stringify(clone(s)).replace('"meals":[{', '"meals":[{"__proto__":{"polluted":1},'));
  assert.throws(() => S.validateState(polluted), /forbidden/);
});

test('downgrade guards name the eating data an older-format copy cannot carry', () => {
  const { s, eggs } = sample(); F.logMeal(s, eggs, WK);
  const cur = S.validateState(clone(s));
  const older = clone(cur); older.schema = 20; delete older.meals; delete older.mealLog; delete older.settings.food;
  const next = S.validateState(older);
  const lost = S.droppedData(cur, next);
  for (const n of ['saved meals', 'logged meals', 'protein target']) assert.ok(lost.includes(n), n);
  assert.ok(S.dropsWork(cur, next));
  assert.match(S.lossText(cur, next), /2 saved meals/); assert.match(S.lossText(cur, next), /1 logged meals/);
  const empty = S.validateState(clone(S.defaultState())), e2 = clone(empty); e2.schema = 20; delete e2.meals; delete e2.mealLog; delete e2.settings.food;
  assert.deepEqual(S.droppedData(empty, S.validateState(e2)).filter((n) => /meal|protein/.test(n)), [], 'nothing to lose, nothing named');
});

test('digest: food numbers only, stored with the review, never in the AI prompt', () => {
  const { s, eggs } = sample();
  const sn = clone(s); sn.meals[0].name = MARK;
  F.logMeal(sn, eggs, WK); F.setForHealth(sn, sn.mealLog[0].id, true);
  const dg = M.weeklyDigest(sn, WK);
  assert.deepEqual(dg.food, { meals: 1, proteinAvg: 21, proteinDays: 0, forHealthRate: 100 });
  assert.ok(!JSON.stringify(dg).includes('EATLEAK'));
  const p = Mem.buildPrompt(sn, 1, { from: WK, to: M.addDays(WK, 6) });
  const txt = JSON.stringify(p);
  assert.ok(!txt.includes('EATLEAK'), 'no meal name');
  assert.ok(!/protein|meal|ate for health/i.test(txt), 'no eating numbers reach a provider');
  // A stored review keeps the food block through validation; older reviews without it stay valid.
  const st = clone(sn); st.memory.reviews.push({ id: 'r1', weekOf: WK, digest: dg, priorities: ['', '', ''], completedAt: '2026-11-29T10:00:00.000Z' });
  const v = S.validateState(st);
  assert.deepEqual(v.memory.reviews[0].digest.food, dg.food);
  const bad = clone(st); bad.memory.reviews[0].digest.food.proteinDays = 8;
  assert.throws(() => S.validateState(bad), /digest food/);
  const old = clone(st); delete old.memory.reviews[0].digest.food;
  assert.equal(S.validateState(old).memory.reviews[0].digest.food, undefined);
});

test('private vault: a saved meal moves with its logged rows; a row logged for a private meal is private; closed, nothing shows', async () => {
  const { s, eggs, bowl } = sample();
  F.logMeal(s, eggs, WK); F.logMeal(s, bowl, WK); F.logOneOff(s, '10', WK);
  s.meals[0].name = MARK;
  await vault(s, { priv: true });
  const n = await P.moveIn('meals', eggs);
  assert.equal(n, 2, 'the meal and its one logged row');
  let base = S.getState();
  assert.deepEqual(base.meals.map((m) => m.id), [bowl]);
  assert.equal(base.mealLog.length, 2);
  assert.ok(!JSON.stringify(base).includes('EATLEAK'));
  assert.ok(P.marks(base).includes('meals') && P.marks(base).includes('mealLog'));
  // a new row logged for the private meal while open goes into the private vault
  await P.write((x) => { F.logMeal(x, eggs, '2026-11-24'); });
  base = S.getState();
  assert.equal(base.mealLog.length, 2, 'the new row is not in the main state');
  assert.equal(F.week(P.view(base), WK).meals, 4, 'open: all rows count');
  P.close('system');
  assert.equal(F.week(S.getState(), WK).meals, 2, 'closed: only public rows count');
  assert.ok(!JSON.stringify(M.weeklyDigest(S.getState(), WK)).includes('EATLEAK'));
  await P.open(PRIV);
  await P.moveOut('meals', eggs);
  base = S.getState();
  assert.equal(base.mealLog.length, 4); assert.equal(base.meals.length, 2);
  assert.ok(!P.marks(base).includes('meals'));
});

test('search finds saved meal names in Health; the meal log has no text to index', async () => {
  const { s, eggs } = sample(); F.logMeal(s, eggs, WK);
  await vault(s);
  Q.build(S.getState());
  const r = JSON.stringify(Q.query('eggs and'));
  assert.match(r, /health/); assert.match(r, /3 eggs and toast/);
  Q.drop();
});

test('diagnostics count the new collections by number only', () => {
  const { s, eggs } = sample(); F.logMeal(s, eggs, WK);
  const keys = O.COUNT_KEYS.map((x) => x[0]);
  assert.ok(keys.includes('meals') && keys.includes('mealLog'));
});
