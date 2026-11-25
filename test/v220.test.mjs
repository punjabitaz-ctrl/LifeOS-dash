// v2.2.0 (SPEC.md "v2.2.0 addendum: Learning goals"): degree and language kinds, a next step with an optional date, minutes per week
// on an item, dates due in the next 30 days (tile, review, at a glance), schema 22, downgrade guards, search and the private vault.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L, PASS, memAdapter } from './_load.mjs';
import { fastKeys, realKeys, clone, PRIV } from './_archive.mjs';

const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), P = view('priv'), O = view('ops'), Ln = view('learning'), M = view('metrics'), Mem = view('memory'), Q = view('search'), A = view('activities');
const NOSTORE = { get: async () => { throw new Error('NO_STORAGE'); }, set: async () => { throw new Error('NO_STORAGE'); }, del: async () => { throw new Error('NO_STORAGE'); } };
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { P.close('system'); } catch (e) { /* closed */ } try { S.lock(); } catch (e) { /* locked */ } S._setAdapter(NOSTORE); realKeys(); } });
const WK = '2026-11-23', TODAY = '2026-11-25'; // a Monday and the Wednesday of that week
const MARK = 'GOALLEAK "q" marker with spaces';
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
async function vault(state, o = {}) {
  S._setAdapter(memAdapter()); S.lock(); await S.init(PASS);
  if (state) await S.replaceState(state);
  if (o.priv) { await P.setUp(PRIV); await P.open(PRIV); }
}
// Three goals of different kinds with next steps and dates; one planned, one paused, one done.
function sample() {
  const s = S.defaultState();
  const cert = Ln.addItem(s, { title: 'Cloud architect certification', kind: 'certification', provider: 'Vendor', targetDate: '2026-12-10', examDate: '2026-12-08', nextAction: 'Book the exam', nextDate: '2026-11-28', weeklyMinutes: '180' }, '2026-11-01').id;
  const deg = Ln.addItem(s, { title: 'MBA', kind: 'degree', provider: 'A school', totalUnits: '48', doneUnits: '12', unitLabel: 'credits', targetDate: '2028-05-01', nextAction: 'Register for spring term', nextDate: '2026-11-20' }, '2026-09-01').id;
  const lang = Ln.addItem(s, { title: 'Japanese', kind: 'language', weeklyMinutes: '150', examDate: '2027-07-05' }, '2026-10-01').id;
  const skill = Ln.addItem(s, { title: 'Public speaking', kind: 'skill', state: 'planned', targetDate: '2026-12-20' }, TODAY).id;
  const paused = Ln.addItem(s, { title: 'Guitar', kind: 'skill', state: 'paused', targetDate: '2026-11-30', nextAction: 'Restring' }, '2026-06-01').id;
  const done = Ln.addItem(s, { title: 'Old course', kind: 'course', state: 'done', targetDate: '2026-11-27' }, '2026-11-01').id;
  Ln.addSession(s, { itemId: cert, minutes: '60', date: '2026-11-23' }, TODAY);
  Ln.addSession(s, { itemId: cert, minutes: '45', date: TODAY }, TODAY);
  Ln.addSession(s, { itemId: lang, minutes: '30', date: '2026-11-24' }, TODAY);
  Ln.addSession(s, { itemId: lang, minutes: '20', date: '2026-11-22' }, TODAY); // the week before
  Ln.addSession(s, { itemId: cert, minutes: '15', date: '2026-11-26' }, TODAY); // later in the week: not counted on Wednesday
  return { s, cert, deg, lang, skill, paused, done };
}

test('kinds: certification, degree, skill and language are offered with the earlier kinds; unknown kinds are refused', () => {
  for (const k of ['certification', 'degree', 'skill', 'language']) assert.ok(Ln.KINDS.includes(k), k);
  for (const k of Ln.OLD_KINDS) assert.ok(Ln.KINDS.includes(k), 'kept ' + k);
  assert.deepEqual([Ln.KIND_LABEL.degree, Ln.KIND_LABEL.language], ['Degree', 'Language']);
  assert.deepEqual([...Ln.EXAM_KINDS], ['certification', 'degree', 'language']);
  const s = S.defaultState();
  assert.throws(() => Ln.addItem(s, { title: 'x', kind: 'diploma' }, TODAY), /Unknown kind/);
  const id = Ln.addItem(s, { title: 'Spanish', kind: 'language' }, TODAY).id;
  Ln.updateItem(s, id, { kind: 'degree' }); assert.equal(s.learningItems[0].kind, 'degree');
  assert.throws(() => Ln.updateItem(s, id, { kind: 'nope' }), /Unknown kind/);
});

test('next step, its date and minutes per week: validated, cleared when blank, never a secret', () => {
  const { s, cert } = sample();
  const it = () => s.learningItems.find((i) => i.id === cert);
  assert.deepEqual([it().nextAction, it().nextDate, it().weeklyMinutes], ['Book the exam', '2026-11-28', 180]);
  Ln.setNextStep(s, cert, 'Finish practice test 2', '2026-12-01');
  assert.deepEqual([it().nextAction, it().nextDate], ['Finish practice test 2', '2026-12-01']);
  Ln.setNextStep(s, cert, '', '');
  assert.ok(!('nextAction' in it()) && !('nextDate' in it()), 'both blank clears both');
  Ln.setNextStep(s, cert, 'Only a step', '');
  assert.ok(it().nextAction === 'Only a step' && !('nextDate' in it()));
  assert.throws(() => Ln.setNextStep(s, cert, 'x'.repeat(Ln.NEXT_MAX + 1), ''), /up to 200/);
  assert.throws(() => Ln.setNextStep(s, cert, 'x', '2026-02-30'), /Next step date/);
  assert.throws(() => Ln.setNextStep(s, cert, 42, ''), /must be text/);
  assert.throws(() => Ln.setNextStep(s, cert, 'Send form with 123-45-6789', ''), (e) => e.message === Ln.SECRET_MESSAGE);
  assert.equal(it().nextAction, 'Only a step', 'a refused step changes nothing');
  for (const bad of ['-1', '1.5', '10081', 'abc', '123456']) assert.throws(() => Ln.updateItem(s, cert, { weeklyMinutes: bad }), /Minutes per week/, bad);
  Ln.updateItem(s, cert, { weeklyMinutes: '0' }); assert.ok(!('weeklyMinutes' in it()), 'zero is none');
  Ln.updateItem(s, cert, { weeklyMinutes: '10080' }); assert.equal(it().weeklyMinutes, 10080);
  Ln.updateItem(s, cert, { weeklyMinutes: '' }); assert.ok(!('weeklyMinutes' in it()));
  assert.throws(() => Ln.updateItem(s, cert, { state: 'done' }), /cannot be changed/, 'state still moves only by tap');
});

test('due soon: open items only, targets and next steps in the next 30 days plus overdue ones, in date order', () => {
  const { s, cert, deg, skill } = sample();
  const due = Ln.dueSoon(s, TODAY);
  assert.deepEqual(due.map((d) => [d.title, d.what, d.date, d.overdue]), [
    ['MBA', 'next', '2026-11-20', true],
    ['Cloud architect certification', 'next', '2026-11-28', false],
    ['Cloud architect certification', 'target', '2026-12-10', false],
    ['Public speaking', 'target', '2026-12-20', false],
  ], 'paused, done and far dates are left out; exams have their own list');
  assert.equal(due[0].id, deg); assert.equal(due[0].step, 'Register for spring term'); assert.equal(due[0].days, -5);
  assert.equal(due[1].id, cert); assert.equal(due[1].days, 3); assert.equal(due[3].id, skill);
  // the window is today and the 29 days after it
  assert.ok(Ln.dueSoon(s, '2026-11-11').every((d) => d.date <= '2026-12-10'));
  assert.ok(!Ln.dueSoon(s, '2026-11-10').some((d) => d.what === 'target' && d.title.startsWith('Cloud')), 'day 31 is outside');
  assert.ok(Ln.dueSoon(s, '2026-11-11').some((d) => d.what === 'target' && d.title.startsWith('Cloud')), 'day 30 is inside');
  // same date: title, then target before next step
  const t = S.defaultState();
  Ln.addItem(t, { title: 'B', targetDate: '2026-12-01', nextDate: '2026-12-01' }, TODAY); Ln.addItem(t, { title: 'A', nextDate: '2026-12-01' }, TODAY);
  assert.deepEqual(Ln.dueSoon(t, TODAY).map((d) => d.title + ':' + d.what), ['A:next', 'B:target', 'B:next']);
});

test('summary, tile and review: due and overdue counts; the tile sub line is unchanged when nothing is due', () => {
  const { s } = sample();
  const sum = Ln.summary(s, TODAY);
  assert.deepEqual([sum.due.length, sum.overdue, sum.active, sum.stalled.length], [4, 1, 3, 1]);
  const R = (label, display, value, sub) => ({ label, display, value, sub });
  assert.equal(Ln.headline(s, TODAY, R).sub, '3 active items, next exam 2026-12-08, 1 overdue, 3 due in 30 days');
  const plain = S.defaultState(); Ln.addItem(plain, { title: 'x' }, TODAY);
  assert.equal(Ln.headline(plain, TODAY, R).sub, '1 active item, no exam dated');
  assert.equal(M.headline(plain, 'learning', TODAY).sub, '1 active item, no exam dated');
  const rv = Ln.reviewWeek(s, WK, TODAY);
  assert.deepEqual(rv.due.map((d) => d.what + ':' + d.date), ['next:2026-11-20', 'next:2026-11-28', 'target:2026-12-10', 'target:2026-12-20']);
  const before = JSON.stringify(s); Ln.reviewWeek(s, WK, TODAY); Ln.summary(s, TODAY); Ln.dueSoon(s, TODAY); assert.equal(JSON.stringify(s), before, 'reading changes nothing');
});

test('kind counts and minutes this week per item', () => {
  const { s, cert, lang, deg } = sample();
  assert.deepEqual(Ln.kindCounts(s), [{ kind: 'certification', label: 'Certification', count: 1 }, { kind: 'degree', label: 'Degree', count: 1 }, { kind: 'language', label: 'Language', count: 1 }]);
  const wm = Ln.weekMinutesByItem(s, TODAY);
  assert.equal(wm.get(cert), 105, 'Monday and today, not tomorrow'); assert.equal(wm.get(lang), 30, 'last week left out'); assert.equal(wm.get(deg), undefined);
  assert.equal(Ln.weekMinutesByItem(s, '2026-11-29').get(cert), 120);
  assert.deepEqual(Ln.kindCounts(S.defaultState()), []);
});

test('at a glance: learning targets, next steps and exams within 30 days; an overdue one shows today; registered once', () => {
  const { s } = sample();
  const g = Ln.glanceItems(s, TODAY);
  assert.deepEqual(g.map((x) => [x.title, x.date]), [
    ['Next step for MBA (overdue): Register for spring term', TODAY],
    ['Next step for Cloud architect certification: Book the exam', '2026-11-28'],
    ['Learning target: Cloud architect certification', '2026-12-10'],
    ['Learning target: Public speaking', '2026-12-20'],
    ['Exam: Cloud architect certification', '2026-12-08'],
  ]);
  assert.equal(new Set(g.map((x) => x.id)).size, g.length, 'ids are unique');
  const before = A.glanceProviders().map((p) => p.id);
  assert.ok(!before.includes('learning-dates'), 'not registered until the app starts');
  try {
    Ln.registerGlance(); Ln.registerGlance();
    assert.equal(A.glanceProviders().filter((p) => p.id === 'learning-dates').length, 1, 'safe to repeat');
    const all = A.glance(s, TODAY), mine = all.today.concat(all.week, all.later).filter((x) => x.source === 'learning-dates');
    assert.equal(mine.length, 5); assert.equal(mine[0].sourceLabel, 'Learning');
  } finally { A.unregisterGlanceProvider('learning-dates'); }
  assert.ok(/L\.learning\.registerGlance\(\)/.test(src('src/ui/app.js')), 'the app registers it at start');
});

test('schema 22: migrations from 1 and 21 keep every item; an older format cannot carry the new kinds or fields', () => {
  assert.equal(S.SCHEMA, 24); assert.equal(Ln.GOALS_SCHEMA, 22);
  for (const n of [1, 7, 20, 21]) {
    const o = clone(S.defaultState()); o.schema = n;
    if (n === 1) { for (const k of ['accounts', 'recurring', 'budgets', 'categories']) delete o[k]; }
    if (n < 21) { delete o.meals; delete o.mealLog; delete o.settings.food; }
    const v = S.validateState(o);
    assert.equal(v.schema, 24); assert.deepEqual(v.learningItems, []);
  }
  const { s } = sample();
  const cur = S.validateState(clone(s));
  assert.equal(cur.learningItems.length, 6);
  assert.deepEqual(cur.learningItems.find((i) => i.title === 'MBA').nextAction, 'Register for spring term');
  // A schema 21 copy with older kinds only and the new fields smuggled in: the fields are dropped, the items kept.
  const o21 = clone(cur); o21.schema = 21; o21.learningItems = o21.learningItems.filter((i) => i.kind !== 'degree' && i.kind !== 'language');
  const v21 = S.validateState(o21);
  assert.equal(v21.learningItems.length, 4);
  assert.ok(v21.learningItems.every((i) => !('nextAction' in i) && !('nextDate' in i) && !('weeklyMinutes' in i)));
  // A schema 21 copy cannot name a kind it did not know.
  const bad21 = clone(cur); bad21.schema = 21;
  assert.throws(() => S.validateState(bad21), /Invalid data/);
  // Strict validation of the new fields in the current format.
  const bads = [
    (x) => { x.learningItems[0].nextAction = 5; }, (x) => { x.learningItems[0].nextAction = 'x'.repeat(201); }, (x) => { x.learningItems[0].nextDate = '2026-13-01'; },
    (x) => { x.learningItems[0].weeklyMinutes = -1; }, (x) => { x.learningItems[0].weeklyMinutes = 1.5; }, (x) => { x.learningItems[0].weeklyMinutes = 10081; }, (x) => { x.learningItems[0].kind = 'diploma'; },
  ];
  for (const f of bads) { const x = clone(cur); f(x); assert.throws(() => S.validateState(x), /Invalid data/, String(f)); }
  const zero = clone(cur); zero.learningItems[0].weeklyMinutes = 0; zero.learningItems[0].nextAction = '';
  const vz = S.validateState(zero).learningItems[0];
  assert.ok(!('weeklyMinutes' in vz) && !('nextAction' in vz), 'empty values are simply absent');
  const extra = clone(cur); extra.learningItems[0].secretField = MARK;
  assert.ok(!JSON.stringify(S.validateState(extra)).includes('GOALLEAK'), 'unknown fields are not kept');
});

test('downgrade guards name the learning goal data an older-format copy cannot carry', () => {
  const { s } = sample();
  const cur = S.validateState(clone(s));
  const older = clone(cur); older.schema = 21; older.learningItems = older.learningItems.filter((i) => i.kind !== 'degree' && i.kind !== 'language');
  const next = S.validateState(older);
  const lost = S.droppedData(cur, next);
  for (const n of ['degree and language learning items', 'learning next steps', 'minutes per week on learning items']) assert.ok(lost.includes(n), n);
  assert.ok(S.dropsWork(cur, next));
  assert.match(S.lossText(cur, next), /your learning next steps/);
  // Nothing of the new kind in the vault: nothing is named.
  const plain = S.defaultState(); Ln.addItem(plain, { title: 'A course', kind: 'course' }, TODAY);
  const pc = S.validateState(clone(plain)), po = clone(pc); po.schema = 21;
  assert.deepEqual(S.droppedData(pc, S.validateState(po)).filter((n) => /learning|degree/.test(n)), [], 'nothing to lose, nothing named');
  assert.ok(src('src/core/store.js').includes('if (src < 22)'));
});

test('a newer schema is refused by unlock and backup import, and nothing is written', async () => {
  const { s } = sample();
  await vault(s);
  const before = S.getState().learningItems.length;
  const newer = clone(S.getState()); newer.schema = 25;
  assert.throws(() => S.validateState(newer), /schema/);
  realKeys(); // backup files are opened with the real derivation
  const salt = L.vault.newSalt(), key = await L.vault.deriveKey(PASS, salt);
  await assert.rejects(L.vault.importBackup(PASS, JSON.stringify(await L.vault.makeEnvelope(key, salt, newer))), /newer|schema/i);
  assert.equal(S.getState().learningItems.length, before);
  // A schema 22 backup round trips every new field.
  const back = await L.vault.importBackup(PASS, await L.vault.exportBackup(PASS, S.getState()));
  assert.deepEqual(back.learningItems, S.getState().learningItems);
});

test('search finds a next step; the private vault moves an item with its next step and sessions; closed, none of it shows', async () => {
  const { s, cert } = sample();
  s.learningItems.find((i) => i.id === cert).nextAction = MARK;
  await vault(s, { priv: true });
  Q.build(S.getState());
  const r = JSON.stringify(Q.query('GOALLEAK'));
  assert.match(r, /learning/); assert.match(r, /Cloud architect/);
  Q.drop();
  assert.equal(P.childrenOf(P.view(S.getState()), 'learningItems', cert).length, 3, 'three sessions');
  await P.moveIn('learningItems', cert, { children: true });
  let base = S.getState();
  assert.ok(!JSON.stringify(base).includes('GOALLEAK'));
  assert.ok(P.marks(base).includes('learningItems'));
  assert.ok(Ln.dueSoon(P.view(base), TODAY).some((d) => d.id === cert), 'open: its dates count');
  P.close('system');
  base = S.getState();
  assert.ok(!Ln.dueSoon(base, TODAY).some((d) => d.id === cert), 'closed: its dates do not show');
  assert.ok(!JSON.stringify(Ln.glanceItems(base, TODAY)).includes('Cloud'));
  await P.open(PRIV);
  await P.moveOut('learningItems', cert, { children: true });
  base = S.getState();
  assert.equal(base.learningItems.find((i) => i.id === cert).nextAction, MARK, 'the next step comes back with the item');
});

test('the digest and the AI prompt carry numbers only: no next step, kind name or provider', () => {
  const { s, cert } = sample();
  s.learningItems.find((i) => i.id === cert).nextAction = MARK;
  s.learningItems.find((i) => i.id === cert).provider = MARK;
  const dg = M.weeklyDigest(s, WK);
  assert.deepEqual(Object.keys(dg.learning).sort(), ['active', 'days', 'finished', 'minutes', 'sessions', 'stalled']);
  assert.ok(!JSON.stringify(dg).includes('GOALLEAK'));
  const txt = JSON.stringify(Mem.buildPrompt(s, 1, { from: WK, to: M.addDays(WK, 6) }));
  assert.ok(!txt.includes('GOALLEAK'), 'no next step or provider');
  assert.ok(!/next step|Register for spring|Book the exam|Japanese|MBA/.test(txt), 'no learning text reaches a provider');
});

test('UI copy: the Learning screen offers the new fields and cards, without em dashes or advice wording', () => {
  const ui = src('src/ui/app.js');
  const a = ui.indexOf('function editItemDialog'), b = ui.indexOf('function reviewLearningCard');
  const ln = ui.slice(ui.indexOf('function itemOptions'), ui.indexOf('\n  }', ui.indexOf('function reviewLearningCard')));
  assert.ok(a > 0 && b > a && ln.length > 5000);
  for (const w of ["id: 'ln-due'", "id: 'ln-kinds'", "'ln-next'", "'ln-next-date'", "'ln-weekly'", 'function nextStepDialog', "'ei-kind'", "'ei-weekly'", 'rv-ln-due-h', 'Ln.EXAM_KINDS']) assert.ok(ln.includes(w), w);
  assert.ok(!ln.includes('—'), 'no em dash');
  assert.ok(!/\b(you should|we recommend|recommended|consider|best practice)\b/i.test(ln), 'no advice wording');
  assert.ok(/view\.lnKind/.test(ln) && !/localStorage|sessionStorage/.test(ln), 'the kind filter is held in memory only');
  assert.ok(/'learningItems'\]\)\)/.test(ui.slice(ui.indexOf('function glanceCard'), ui.indexOf('function glanceCard') + 600)), 'the glance card marks hidden private learning items');
});
