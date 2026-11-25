// v1.5.0 "Weekly loop": review due and streak, consolidation offers, rejection categories, muting, target proposals,
// Test connection, and the calendar file.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { L, PASS, memAdapter, E } from './_load.mjs';
import { fastKeys, realKeys, clone } from './_archive.mjs';
import { maint, renew } from './_v070.mjs';

const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), Mem = view('memory'), AI = view('ai'), CAL = view('calendar'), O = view('ops'), P = view('priv'), M = view('metrics');
const ROOT = new URL('..', import.meta.url).pathname;
const src = (f) => readFileSync(join(ROOT, f), 'utf8');
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { S.lock(); } catch (e) { /* locked */ } realKeys(); } });
const fresh = () => S.validateState(S.defaultState());
const WK = '2026-11-09', WEND = '2026-11-15';
const PERIOD = { from: WK, to: WEND };
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------- B11: review due, streak, offers
test('B11 review due: not at 6 days, due at 7, never reviewed counts from the day the loop started (SEC-102), also across a year end', () => {
  const st = fresh();
  st.memory.startedOn = '2026-11-14';
  assert.deepEqual(Mem.reviewDue(st, '2026-11-20'), { due: false, never: true, days: null, last: '' });
  assert.deepEqual(Mem.reviewDue(st, '2026-11-21'), { due: true, never: true, days: null, last: '' });
  st.memory.lastReviewAt = '2026-11-01';
  assert.deepEqual([Mem.reviewDue(st, '2026-11-07').due, Mem.reviewDue(st, '2026-11-07').days], [false, 6]);
  assert.deepEqual([Mem.reviewDue(st, '2026-11-08').due, Mem.reviewDue(st, '2026-11-08').days], [true, 7]);
  assert.equal(Mem.reviewDue(st, '2026-11-30').due, true);
  st.memory.lastReviewAt = '2026-12-28';
  assert.equal(Mem.reviewDue(st, '2027-01-03').due, false); assert.equal(Mem.reviewDue(st, '2027-01-04').due, true);
  st.memory.lastReviewAt = '2028-02-24'; // leap year: 7 days later is 2028-03-02
  assert.equal(Mem.reviewDue(st, '2028-03-01').due, false); assert.equal(Mem.reviewDue(st, '2028-03-02').due, true);
});
test('B11 markReviewed records the date and never moves it backwards; bad dates are refused', () => {
  const st = fresh();
  Mem.markReviewed(st, '2026-11-14'); assert.equal(st.memory.lastReviewAt, '2026-11-14');
  Mem.markReviewed(st, '2026-11-10'); assert.equal(st.memory.lastReviewAt, '2026-11-14');
  assert.throws(() => Mem.markReviewed(st, '14/11/2026'), /Invalid date/);
});
test('B11 streak: consecutive weeks, counted from this week or from last week while this week has no review; a gap ends it', () => {
  const st = fresh();
  const rv = (weekOf) => st.memory.reviews.push({ id: 'r' + weekOf, weekOf, digest: { week: '2026-11-02', domains: {} }, priorities: ['a', 'b', 'c'], completedAt: weekOf + 'T10:00:00.000Z' });
  assert.equal(Mem.reviewStreak(st, '2026-11-14'), 0);
  rv('2026-11-02'); rv('2026-10-26'); rv('2026-10-19');
  assert.equal(Mem.reviewStreak(st, '2026-11-04'), 3, 'this week (11-02) is done');
  assert.equal(Mem.reviewStreak(st, '2026-11-11'), 3, 'this week (11-09) has none yet: counted from last week');
  assert.equal(Mem.reviewStreak(st, '2026-11-18'), 0, 'two weeks without a review ends the streak');
  rv('2026-10-05');
  assert.equal(Mem.reviewStreak(st, '2026-11-04'), 3, 'a gap (10-12) stops the count');
  // year end: weeks of 2026-12-21, 2026-12-28 and 2027-01-04
  const y = fresh();
  for (const w of ['2026-12-21', '2026-12-28', '2027-01-04']) y.memory.reviews.push({ id: w, weekOf: w, digest: { week: '2026-11-02', domains: {} }, priorities: ['a', 'b', 'c'], completedAt: w + 'T10:00:00.000Z' });
  assert.equal(Mem.reviewStreak(y, '2027-01-06'), 3);
});
test('B11 schema 17 migration: an older vault takes lastReviewAt from its latest review; a new vault has none', () => {
  const old = clone(fresh()); old.schema = 16; delete old.memory.lastReviewAt; delete old.memory.mutes;
  old.memory.reviews.push({ id: 'a', weekOf: '2026-11-02', digest: { week: '2026-11-02', domains: {} }, priorities: ['a', 'b', 'c'], completedAt: '2026-11-06T09:00:00.000Z' }, { id: 'b', weekOf: '2026-11-09', digest: { week: '2026-11-02', domains: {} }, priorities: ['a', 'b', 'c'], completedAt: '2026-11-13T09:00:00.000Z' });
  const got = S.validateState(old);
  assert.equal(got.schema, 23); assert.equal(got.sourceSchema, 16); assert.equal(got.memory.lastReviewAt, '2026-11-13'); assert.deepEqual(got.memory.mutes, []);
  assert.equal(fresh().memory.lastReviewAt, '');
  const bad = clone(fresh()); bad.memory.lastReviewAt = '2026-02-30'; assert.throws(() => S.validateState(bad), /lastReviewAt/);
});

const approved = (st, level, from, to, domain, text, o) => st.memory.insights.push(Object.assign({ id: 'i' + st.memory.insights.length, level, period: { from, to }, domain: domain || 'money', text: text || 'Insight ' + st.memory.insights.length, source: 'rules', status: 'approved', createdAt: from + 'T10:00:00.000Z' }, o || {}));
test('B11 offers: the month that just ended is offered once it has approved weekly insights, with what would be merged', () => {
  const st = fresh();
  approved(st, 1, '2026-10-05', '2026-10-11', 'money', 'Spend rose in October.'); approved(st, 1, '2026-10-26', '2026-11-01', 'health', 'Four workouts.');
  approved(st, 1, '2026-11-02', '2026-11-08', 'work', 'November week.');
  st.memory.insights.push({ id: 'p', level: 1, period: { from: '2026-10-12', to: '2026-10-18' }, domain: 'home', text: 'Not approved', source: 'rules', status: 'proposed', createdAt: '2026-10-12T00:00:00.000Z' });
  const o = Mem.consolidationOffers(st, '2026-11-02');
  assert.equal(o.length, 1); assert.deepEqual(o[0].period, { from: '2026-10-01', to: '2026-10-31' }); assert.equal(o[0].level, 2); assert.equal(o[0].count, 2);
  assert.deepEqual(o[0].items.map((i) => i.text), ['Spend rose in October.', 'Four workouts.']);
  assert.deepEqual(Mem.consolidationOffers(st, '2026-10-31').filter((x) => x.level === 2), [], 'on the last day of the month it has not ended: only September counts, and it has nothing');
  assert.equal(Mem.consolidationOffers(st, '2026-11-30').length, 1, 'still offered later in the next month, until done');
  assert.deepEqual(Mem.consolidationOffers(st, '2026-12-01').map((x) => x.period.from), ['2026-11-01'], 'a month on, October is no longer the last month: only November is offered');
});
test('B11 offers: a monthly entry for that period (any status) ends the offer; a quarter is offered from approved monthly entries', () => {
  const st = fresh();
  approved(st, 1, '2026-10-05', '2026-10-11', 'money', 'Weekly one.');
  Mem.mergeByRules(st, 2, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(Mem.consolidationOffers(st, '2026-11-03'), [], 'a proposed monthly entry exists');
  const m = st.memory.insights.find((i) => i.level === 2); assert.deepEqual([m.status, m.source, m.kind, m.domain], ['proposed', 'rules', 'merge', 'overall']);
  assert.equal(m.text, 'Weekly one.');
  Mem.decide(st, m.id, 'approved');
  const q = Mem.consolidationOffers(st, '2027-01-05');
  assert.equal(q.length, 1); assert.deepEqual([q[0].level, q[0].period, q[0].count], [3, { from: '2026-10-01', to: '2026-12-31' }, 1]);
  Mem.mergeByRules(st, 3, q[0].period);
  assert.deepEqual(Mem.consolidationOffers(st, '2027-01-05'), []);
});
test('B11 offers across a year end: January offers December and Q4 of the year before; April offers Q1; mid-quarter offers the quarter before', () => {
  const st = fresh();
  approved(st, 1, '2026-12-14', '2026-12-20', 'money', 'December week.');
  approved(st, 2, '2026-11-01', '2026-11-30', 'overall', 'November month.');
  const jan = Mem.consolidationOffers(st, '2027-01-04');
  assert.deepEqual(jan.map((x) => [x.level, x.period.from, x.period.to]), [[2, '2026-12-01', '2026-12-31'], [3, '2026-10-01', '2026-12-31']]);
  const s2 = fresh(); approved(s2, 2, '2027-03-01', '2027-03-31', 'overall', 'March.');
  assert.deepEqual(Mem.consolidationOffers(s2, '2027-04-05').map((x) => [x.level, x.period.from, x.period.to]), [[3, '2027-01-01', '2027-03-31']]);
  assert.deepEqual(Mem.consolidationOffers(s2, '2027-05-05').map((x) => x.level), [3], 'Q1 is still the last finished quarter in May');
  assert.deepEqual(Mem.consolidationOffers(s2, '2027-07-05'), [], 'in July the last quarter is Q2, which has nothing');
  assert.throws(() => Mem.consolidationOffers(fresh(), '2027-1-4'), /Invalid date/);
});
test('B11 offers do not depend on the time zone: the local calendar date of a moment near midnight gives the same offers in every zone', () => {
  const st = fresh(); approved(st, 1, '2026-12-07', '2026-12-13', 'money', 'December week.');
  const d = new Date(2027, 0, 1, 0, 30), local = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  assert.equal(local, '2027-01-01');
  assert.deepEqual(Mem.consolidationOffers(st, local).map((x) => x.period.from), ['2026-12-01']);
  const e = new Date(2026, 11, 31, 23, 30), le = e.getFullYear() + '-' + String(e.getMonth() + 1).padStart(2, '0') + '-' + String(e.getDate()).padStart(2, '0');
  assert.deepEqual(Mem.consolidationOffers(st, le), [], 'on 31 December December has not ended and November has nothing');
});
test('B11 offers leave out wellbeing and body-metric insights, and merging never creates a decided entry', () => {
  const st = fresh();
  approved(st, 1, '2026-10-05', '2026-10-11', 'wellbeing', 'Mood note.'); approved(st, 1, '2026-10-12', '2026-10-18', 'health', 'Weight moved down from 180 to 178.', { source: 'rules' });
  assert.deepEqual(Mem.consolidationOffers(st, '2026-11-03'), []);
  assert.throws(() => Mem.mergeByRules(st, 2, { from: '2026-10-01', to: '2026-10-31' }), /Nothing approved/);
  assert.throws(() => Mem.mergeByRules(st, 1, { from: '2026-10-01', to: '2026-10-31' }), /Invalid level/);
  approved(st, 1, '2026-10-19', '2026-10-25', 'money', 'x'.repeat(280));
  approved(st, 1, '2026-10-26', '2026-11-01', 'money', 'y'.repeat(280));
  Mem.mergeByRules(st, 2, { from: '2026-10-01', to: '2026-10-31' });
  const m = st.memory.insights.find((i) => i.level === 2);
  assert.equal(m.status, 'proposed'); assert.equal(m.text.length, 280); assert.ok(m.text.endsWith('...'));
  assert.ok(!m.text.includes('Mood note') && !m.text.includes('Weight moved'));
});

// ---------------------------------------------------------------- B12: categories, prompt counts, PV-6
const mkIns = (st, domain, text, o) => { Mem.propose(st, [Object.assign({ domain, text }, o || {})], { level: 1, period: PERIOD, source: (o && o.source) || 'rules' }); return st.memory.insights[st.memory.insights.length - 1]; };
test('B12 rejecting stores one fixed category; an unknown category is refused; approving clears it; it survives validation', () => {
  const st = fresh();
  const a = mkIns(st, 'money', 'Savings rate this week was 10%, below your 20% target.', { kind: 'savings' }), b = mkIns(st, 'work', 'Done 3 of 5.');
  assert.deepEqual(Mem.REASONS, ['wrong-number', 'not-relevant', 'already-known', 'too-vague', 'other']);
  assert.throws(() => Mem.decide(st, a.id, 'rejected', undefined, { category: 'my landlord' }), /Invalid rejection reason/);
  assert.equal(a.status, 'proposed', 'a refused category changes nothing');
  Mem.decide(st, a.id, 'rejected', 'typed note stays local', { category: 'wrong-number', now: '2026-11-10T10:00:00Z' });
  assert.deepEqual([a.status, a.reason, a.decidedAt], ['rejected', 'wrong-number', '2026-11-10T10:00:00.000Z']);
  Mem.decide(st, b.id, 'rejected'); assert.equal(b.reason, undefined, 'older callers without a category still work');
  const back = S.validateState(clone(st)); assert.equal(back.memory.insights[0].reason, 'wrong-number'); assert.equal(back.memory.insights[0].kind, 'savings');
  Mem.decide(st, a.id, 'approved'); assert.equal(a.reason, undefined);
  const bad = clone(st); bad.memory.insights[1].reason = 'because'; assert.throws(() => S.validateState(bad), /rejection reason/);
  const bad2 = clone(st); bad2.memory.insights[1].kind = 'Bad Kind'; assert.throws(() => S.validateState(bad2), /insight kind/);
});
test('B12 the prompt carries counts per reason per area over 12 weeks, numbers and fixed words only; PV-6 still holds', () => {
  const st = fresh();
  const mk = (d, text, cat, at) => {
    let i;
    if (d === 'wellbeing') { i = { id: 'wb', level: 1, period: PERIOD, domain: d, text, source: 'rules', status: 'proposed', createdAt: '2026-11-01T00:00:00.000Z' }; st.memory.insights.push(i); } else i = mkIns(st, d, text);
    Mem.decide(st, i.id, 'rejected', 'landlord "Pat Example" ' + text, { category: cat, now: at });
  };
  mk('money', 'Savings rate this week was 10%.', 'wrong-number', '2026-11-02T10:00:00Z'); mk('money', 'Spend rose 12%.', 'wrong-number', '2026-11-03T10:00:00Z'); mk('money', 'Net worth moved up.', 'too-vague', '2026-11-04T10:00:00Z');
  mk('health', 'Workout target met.', 'not-relevant', '2026-10-20T10:00:00Z'); mk('work', 'Old insight text.', 'already-known', '2026-07-01T10:00:00Z');
  mk('wellbeing', 'Mood moved.', 'other', '2026-11-05T10:00:00Z');
  assert.deepEqual(Mem.rejectionCounts(st, WEND), { money: { 'wrong-number': 2, 'too-vague': 1 }, health: { 'not-relevant': 1 } });
  for (const lv of [1, 2, 3]) {
    const p = Mem.buildPrompt(st, lv, lv === 1 ? PERIOD : { from: '2026-10-01', to: '2026-12-31' });
    assert.match(p.user, /- rejection reasons by area, last 12 weeks \(counts\): health: not relevant 1; money: wrong number 2, too vague 1\./);
    assert.match(p.user, /recently rejected insights by area: /);
    for (const leak of ['Pat Example', 'landlord', 'Savings rate', 'Spend rose', 'Workout target', 'Old insight', 'Mood', 'wellbeing: ']) assert.ok(!p.user.includes(leak), leak + ' reached the prompt');
  }
  assert.equal(Mem.buildPrompt(fresh(), 1, PERIOD).user.includes('rejection reasons by area'), false, 'no line without any categorised rejection');
  // the window is 12 weeks counted back from the end of the period (84 days): 2026-08-23 is in, 2026-08-22 is out
  const w = fresh();
  const x1 = mkIns(w, 'money', 'a'), x2 = mkIns(w, 'money', 'b');
  Mem.decide(w, x1.id, 'rejected', undefined, { category: 'other', now: '2026-08-23T00:00:00Z' }); Mem.decide(w, x2.id, 'rejected', undefined, { category: 'other', now: '2026-08-22T23:59:59Z' });
  assert.deepEqual(Mem.rejectionCounts(w, WEND), { money: { other: 1 } });
});
test('B12 PV-6 and SEC-66: lessons text and wellbeing never reach any prompt, and the system text names no user data', () => {
  const st = fresh();
  const i = mkIns(st, 'money', 'Savings rate this week was 10%.'); Mem.decide(st, i.id, 'rejected', 'secret reason 4111', { category: 'too-vague', now: '2026-11-10T10:00:00Z' });
  assert.equal(st.memory.lessons.length, 1);
  const p = Mem.buildPrompt(st, 1, PERIOD);
  assert.ok(!p.user.includes('secret reason') && !p.system.includes('secret reason') && !p.user.includes('4111'));
  assert.ok(!/wellbeing/.test(p.system.split('domain must be one of:')[1].split('.')[0]));
  assert.match(p.user, /- current targets: workoutsPerWeek 4, contactDays 30, savingsRate 0.2, studyMinutes 0, backupReminderDays 7/);
});

// ---------------------------------------------------------------- B12: muting
const reject = (st, domain, kind, at, o) => { const i = mkIns(st, domain, (o && o.text) || 'Text ' + st.memory.insights.length, Object.assign({ kind }, o && o.source ? { source: o.source } : {})); Mem.decide(st, i.id, 'rejected', undefined, { category: 'not-relevant', now: at }); return i; };
test('B12 muting: exactly 3 rejections of the same kind in the same area within 8 weeks mutes it, 2 do not', () => {
  const st = fresh();
  reject(st, 'health', 'workouts', '2026-11-01T10:00:00Z'); reject(st, 'health', 'workouts', '2026-11-05T10:00:00Z');
  assert.deepEqual(Mem.mutedList(st), []); assert.equal(Mem.isMuted(st, 'health', 'workouts'), false);
  reject(st, 'health', 'workouts', '2026-11-08T10:00:00Z');
  assert.deepEqual(Mem.mutedList(st).map((m) => [m.domain, m.kind, m.label]), [['health', 'workouts', 'Workout target']]);
  assert.equal(Mem.isMuted(st, 'health', 'workouts'), true);
  const back = S.validateState(clone(st)); assert.deepEqual(back.memory.mutes.map((m) => [m.domain, m.kind, m.active]), [['health', 'workouts', true]]);
  reject(st, 'health', 'workouts', '2026-11-09T10:00:00Z'); assert.equal(st.memory.mutes.length, 1, 'a fourth rejection does not add a second entry');
});
test('B12 muting: a different kind or a different area does not count; AI insights and uncategorised kinds do not mute', () => {
  const st = fresh();
  reject(st, 'health', 'workouts', '2026-11-01T10:00:00Z'); reject(st, 'money', 'workouts', '2026-11-02T10:00:00Z'); reject(st, 'health', 'sleep', '2026-11-03T10:00:00Z');
  assert.deepEqual(Mem.mutedList(st), []);
  for (let n = 0; n < 4; n++) { const i = mkIns(st, 'work', 'AI text ' + n, { source: 'ai' }); Mem.decide(st, i.id, 'rejected', undefined, { category: 'other', now: '2026-11-0' + (n + 1) + 'T10:00:00Z' }); }
  for (let n = 0; n < 4; n++) { const i = mkIns(st, 'home', 'No kind ' + n); Mem.decide(st, i.id, 'rejected', undefined, { now: '2026-11-0' + (n + 1) + 'T10:00:00Z' }); }
  assert.deepEqual(Mem.mutedList(st), []);
});
test('B12 muting: three rejections spread over more than 8 weeks do not mute; the 56 day boundary is included and one second more is out', () => {
  const st = fresh(), t0 = Date.parse('2026-09-01T12:00:00Z');
  reject(st, 'money', 'savings', iso(t0)); reject(st, 'money', 'savings', iso(t0 + 30 * DAY));
  reject(st, 'money', 'savings', iso(t0 + 56 * DAY + 1000));
  assert.deepEqual(Mem.mutedList(st), [], '56 days and one second after the first');
  const edge = fresh();
  reject(edge, 'money', 'savings', iso(t0)); reject(edge, 'money', 'savings', iso(t0 + 30 * DAY)); reject(edge, 'money', 'savings', iso(t0 + 56 * DAY));
  assert.equal(Mem.mutedList(edge).length, 1, 'exactly 56 days after the first still counts');
  const later = fresh();
  reject(later, 'money', 'savings', iso(t0)); reject(later, 'money', 'savings', iso(t0 + 20 * DAY)); reject(later, 'money', 'savings', iso(t0 + 90 * DAY)); reject(later, 'money', 'savings', iso(t0 + 100 * DAY));
  assert.deepEqual(Mem.mutedList(later), [], 'only two fall in the last 8 weeks');
  reject(later, 'money', 'savings', iso(t0 + 110 * DAY)); assert.equal(Mem.mutedList(later).length, 1, 'three within 8 weeks later on');
});
test('B12 rules stop proposing a muted kind (it is listed, never silent); other kinds in the area are still proposed', () => {
  const st = S.validateState(clone(fresh()));
  st.entries.push(E({ id: 'w1', domain: 'health', type: 'workout', date: '2026-11-10', title: 'Run', value: 1 }));
  const before = Mem.rulesInsights(st, WK).filter((i) => i.domain === 'health');
  assert.ok(before.some((i) => i.kind === 'workouts'), 'workout rule is proposed');
  assert.ok(Mem.rulesInsights(st, WK).every((i) => /^[a-z][a-z0-9-]*$/.test(i.kind)));
  for (const d of ['2026-11-01', '2026-11-02', '2026-11-03']) reject(st, 'health', 'workouts', d + 'T10:00:00Z');
  const after = Mem.rulesInsights(st, WK);
  assert.ok(!after.some((i) => i.domain === 'health' && i.kind === 'workouts'));
  assert.equal(Mem.mutedList(st).length, 1);
  assert.equal(after.length, Mem.rulesInsights(Object.assign(clone(st), { memory: Object.assign(clone(st.memory), { mutes: [] }) }), WK).length - 1, 'only the muted kind is gone');
});
test('B12 unmute: one call brings the kind back, earlier rejections stop counting, and it needs three new rejections to mute again', () => {
  const st = fresh();
  for (const d of ['2026-11-01', '2026-11-02', '2026-11-03']) reject(st, 'health', 'workouts', d + 'T10:00:00Z');
  assert.equal(Mem.isMuted(st, 'health', 'workouts'), true);
  assert.throws(() => Mem.unmute(st, 'health', 'sleep'), /not muted/);
  Mem.unmute(st, 'health', 'workouts', { now: '2026-11-05T10:00:00Z' });
  assert.deepEqual([Mem.isMuted(st, 'health', 'workouts'), Mem.mutedList(st).length], [false, 0]);
  assert.throws(() => Mem.unmute(st, 'health', 'workouts'), /not muted/);
  reject(st, 'health', 'workouts', '2026-11-06T10:00:00Z'); reject(st, 'health', 'workouts', '2026-11-07T10:00:00Z');
  assert.equal(Mem.isMuted(st, 'health', 'workouts'), false, 'two new rejections after the unmute');
  reject(st, 'health', 'workouts', '2026-11-08T10:00:00Z');
  assert.equal(Mem.isMuted(st, 'health', 'workouts'), true, 'the third new one mutes again');
  assert.equal(st.memory.mutes.length, 1);
  assert.equal(S.validateState(clone(st)).memory.mutes[0].active, true);
  const dup = clone(st); dup.memory.mutes.push(clone(dup.memory.mutes[0])); assert.throws(() => S.validateState(dup), /duplicate mute/);
});
test('B12 downgrade guard: an older-format copy cannot replace muted suggestions or rejection reasons silently', () => {
  const cur = fresh();
  for (const d of ['2026-11-01', '2026-11-02', '2026-11-03']) reject(cur, 'health', 'workouts', d + 'T10:00:00Z');
  const old = clone(cur); old.schema = 16; delete old.memory.mutes; delete old.memory.lastReviewAt; for (const i of old.memory.insights) { delete i.reason; delete i.kind; }
  const next = S.validateState(old);
  assert.deepEqual(S.droppedData(cur, next), ['muted suggestions', 'rejection reasons']);
  assert.equal(S.dropsWork(cur, next), true);
  const c2 = fresh(); const x = mkIns(c2, 'money', 'a'); Mem.decide(c2, x.id, 'rejected', undefined, { category: 'other' });
  const o2 = clone(c2); o2.schema = 16; for (const i of o2.memory.insights) delete i.reason;
  assert.deepEqual(S.droppedData(c2, S.validateState(o2)), ['rejection reasons']);
  assert.deepEqual(S.droppedData(fresh(), S.validateState(Object.assign(clone(fresh()), { schema: 16 }))), []);
});

// ---------------------------------------------------------------- B12: target proposals
test('B12 targets inside their ranges are accepted from an AI reply, with the exact keys and values kept', () => {
  const reply = JSON.stringify([
    { domain: 'health', text: 'Workouts have run above target.', target: { key: 'workoutsPerWeek', value: 5 } },
    { domain: 'social', text: 'Contacts are frequent.', target: { key: 'contactDays', value: 14 } },
    { domain: 'money', text: 'Savings are steady.', target: { key: 'savingsRate', value: 0.25 } },
    { domain: 'learning', text: 'Study is regular.', target: { key: 'studyMinutes', value: 180 } },
    { domain: 'overall', text: 'Backups are made often.', target: { key: 'backupReminderDays', value: 14 } }]);
  const items = Mem.parseResponse(reply).concat(Mem.parseResponse(JSON.stringify([{ domain: 'work', text: 'No change.' }])));
  assert.deepEqual(items.map((i) => i.target), [{ key: 'workoutsPerWeek', value: 5 }, { key: 'contactDays', value: 14 }, { key: 'savingsRate', value: 0.25 }, { key: 'studyMinutes', value: 180 }, { key: 'backupReminderDays', value: 14 }, undefined]);
  for (const [k, lo, hi] of [['workoutsPerWeek', 0, 21], ['contactDays', 1, 365], ['savingsRate', 0, 1], ['studyMinutes', 0, 10080], ['backupReminderDays', 1, 60]])
    for (const v of [lo, hi]) assert.deepEqual(Mem.cleanTarget({ key: k, value: v }), { key: k, value: v }, k + ' ' + v);
});
test('B12 targets outside their ranges, unknown keys, non-numbers, fractions of whole numbers and extra fields are rejected', () => {
  const bad = [{ key: 'workoutsPerWeek', value: 22 }, { key: 'workoutsPerWeek', value: -1 }, { key: 'workoutsPerWeek', value: 3.5 }, { key: 'contactDays', value: 0 }, { key: 'contactDays', value: 366 },
    { key: 'savingsRate', value: 20 }, { key: 'savingsRate', value: -0.1 }, { key: 'savingsRate', value: NaN }, { key: 'studyMinutes', value: 10081 }, { key: 'backupReminderDays', value: 0 }, { key: 'backupReminderDays', value: 61 },
    { key: 'backupReminderDays', value: '14' }, { key: 'autoLockMin', value: 5 }, { key: '__proto__', value: 1 }, { key: 'toString', value: 1 }, { key: 'workoutsPerWeek', value: 4, extra: 1 }, { key: 'workoutsPerWeek', value: 4, applied: true }, null, 'x', [1]];
  for (const t of bad) {
    assert.throws(() => Mem.cleanTarget(t), /Invalid target change/, JSON.stringify(t));
    assert.throws(() => Mem.parseResponse(JSON.stringify([{ domain: 'health', text: 'x', target: t }])), /invalid target change/, JSON.stringify(t));
    const st = fresh(); assert.throws(() => Mem.propose(st, [{ domain: 'health', text: 'x', target: t }], { level: 1, period: PERIOD, source: 'ai' }), /Invalid target change/);
    assert.equal(st.memory.insights.length, 0);
  }
  assert.equal(Mem.parseResponse(JSON.stringify([{ domain: 'health', text: 'ok' }])).length, 1);
});
test('B12 a stored insight with an out-of-range target is refused by validation, so a crafted backup cannot carry one', () => {
  const st = fresh(); Mem.propose(st, [{ domain: 'health', text: 'x', target: { key: 'workoutsPerWeek', value: 5 } }], { level: 1, period: PERIOD, source: 'ai' });
  assert.deepEqual(S.validateState(clone(st)).memory.insights[0].target, { key: 'workoutsPerWeek', value: 5 });
  for (const t of [{ key: 'workoutsPerWeek', value: 99 }, { key: 'nope', value: 1 }, { key: 'workoutsPerWeek', value: 5, applied: false }]) { const b = clone(st); b.memory.insights[0].target = t; assert.throws(() => S.validateState(b), /insight target/); }
});
test('B12 a target change applies only after approval, shows before and after, and lands in one commit', async () => {
  S._setAdapter(memAdapter()); await S.init(PASS);
  await S.commit((x) => { Mem.propose(x, [{ domain: 'health', text: 'Workouts have run above target.', target: { key: 'workoutsPerWeek', value: 5 } }], { level: 1, period: PERIOD, source: 'ai' }); });
  const id = S.getState().memory.insights[0].id;
  assert.equal(S.getState().settings.targets.workoutsPerWeek, 4, 'proposing changes nothing');
  const pv = Mem.targetPreview(S.getState(), id); assert.deepEqual([pv.key, pv.beforeText, pv.afterText, pv.applied], ['workoutsPerWeek', '4', '5', false]);
  await assert.rejects(S.commit((x) => { Mem.applyTarget(x, id); }), /Approve the insight/);
  assert.equal(S.getState().settings.targets.workoutsPerWeek, 4);
  const rev = S.getMeta().rev;
  await S.commit((x) => { Mem.decide(x, id, 'approved'); Mem.applyTarget(x, id); });
  const st = S.getState();
  assert.equal(st.settings.targets.workoutsPerWeek, 5); assert.equal(st.memory.insights[0].status, 'approved'); assert.deepEqual(st.memory.insights[0].target, { key: 'workoutsPerWeek', value: 5, applied: true });
  assert.equal(S.getMeta().rev, rev + 1, 'approval and change are one write');
  await assert.rejects(S.commit((x) => { Mem.applyTarget(x, id); }), /already applied/);
});
test('B12 every target key writes its own setting; percent and minutes show in plain units', () => {
  const st = fresh();
  const ids = [['contactDays', 10, (s) => s.settings.targets.contactDays, '30', '10'], ['savingsRate', 0.3, (s) => s.settings.targets.savingsRate, '20%', '30%'], ['studyMinutes', 90, (s) => s.settings.learning.weeklyMinutes, '0', '90'], ['backupReminderDays', 3, (s) => s.settings.backupReminderDays, '7', '3']];
  for (const [k, v, get, b, a] of ids) {
    const i = mkIns(st, 'overall', 'Change ' + k, { source: 'ai', target: { key: k, value: v } });
    const pv = Mem.targetPreview(st, i.id); assert.deepEqual([pv.beforeText, pv.afterText], [b, a], k);
    Mem.decide(st, i.id, 'approved'); Mem.applyTarget(st, i.id); assert.equal(get(st), v, k);
  }
  assert.doesNotThrow(() => S.validateState(clone(st)), 'the changed settings are valid');
  assert.throws(() => Mem.targetPreview(st, 'nope'), /no target change/);
});

// ---------------------------------------------------------------- B13: Test connection
const bodyRes = (obj, status = 200) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status });
const KEY = 'sk-ant-SECRETKEY1234';
test('B13 Test connection sends the fixed prompt with no user data and reports success', async () => {
  const seen = [];
  const f = async (url, o) => { seen.push({ url, o }); return bodyRes({ content: [{ type: 'text', text: 'OK' }] }); };
  const r = await AI.testConnection({ kind: 'anthropic', apiKey: KEY, model: 'claude-x' }, f);
  assert.deepEqual(r, { ok: true, code: null });
  assert.equal(seen.length, 1); assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
  const body = JSON.parse(seen[0].o.body);
  assert.equal(body.system, 'Connection test. Reply with the single word OK.'); assert.deepEqual(body.messages, [{ role: 'user', content: 'Reply with OK.' }]); assert.equal(body.max_tokens, 600);
  assert.ok(!seen[0].o.body.includes(KEY) && seen[0].o.headers['x-api-key'] === KEY);
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'system']);
  const loc = []; const r2 = await AI.testConnection({ kind: 'local', baseUrl: 'http://localhost:11434/v1', model: 'm' }, async (u, o) => { loc.push([u, o.body]); return bodyRes({ choices: [{ message: { content: 'OK' } }] }); });
  assert.equal(r2.ok, true); assert.equal(loc[0][0], 'http://localhost:11434/v1/chat/completions'); assert.ok(loc[0][1].includes('Reply with OK.'));
  assert.equal(AI.TEST_PROMPT.user, 'Reply with OK.');
});
test('B13 Test connection maps every failure to one fixed code, keeps no message text, and records only the code', async () => {
  const prov = { kind: 'anthropic', apiKey: KEY, model: 'claude-x' };
  const cases = [
    ['AI_HTTP', async () => bodyRes('internal host db-7.corp.example said no', 401)], ['AI_HTTP', async () => bodyRes('boom', 500)], ['AI_HTTP', async () => bodyRes('', 429)],
    ['AI_NETWORK', async () => { throw new TypeError('connect ECONNREFUSED 10.0.0.9:443 secret-host.internal'); }],
    ['AI_TIMEOUT', async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; }],
    ['AI_BAD_REPLY', async () => bodyRes('not json at all')], ['AI_BAD_REPLY', async () => bodyRes({ content: [] })], ['AI_BAD_REPLY', async () => bodyRes({ content: [{ type: 'text', text: '' }] })],
  ];
  for (const [code, f] of cases) {
    O._reset();
    const r = await AI.testConnection(prov, f);
    assert.deepEqual(r, { ok: false, code }, code);
    const text = JSON.stringify(r) + JSON.stringify(O._pending());
    for (const leak of ['secret-host', 'db-7', 'ECONNREFUSED', 'aborted', 'boom', KEY, 'said no']) assert.ok(!text.includes(leak), leak);
    assert.deepEqual(O._pending().map((d) => [d.code, d.area]), [[code, 'ai']]);
  }
  // a reply too large to read, a hostile error object, and settings that cannot send anything at all
  assert.equal((await AI.testConnection(prov, async () => new Response('x'.repeat(1024 * 1024 + 10), { status: 200 }))).code, 'AI_BAD_REPLY');
  assert.equal((await AI.testConnection(prov, async () => { throw { get message() { throw new Error('trap'); }, get name() { throw new Error('trap'); } }; })).ok, false);
  for (const p of [{ kind: 'manual' }, { kind: 'none' }, { kind: 'anthropic', apiKey: '', model: 'm' }, { kind: 'local', baseUrl: 'http://evil.example:1234/v1', model: 'm' }, { kind: 'weird' }, null]) {
    const r = await AI.testConnection(p, async () => assert.fail('nothing may be sent'));
    assert.deepEqual(r, { ok: false, code: 'AI_FAIL' });
  }
});
test('B13 the app shows a Test connection button and docs/AI-SETUP.md exists with the three set-ups', () => {
  const app = src('src/ui/app.js');
  assert.ok(/id: 'p-test'/.test(app) && /L\.ai\.testConnection\(p\)/.test(app));
  const doc = src('docs/AI-SETUP.md');
  for (const need of [/Anthropic/, /spend limit/i, /model/i, /manual/i, /Ollama/, /OLLAMA_ORIGINS/, /Test connection/, /v2\.0\.0/]) assert.match(doc, need);
  assert.ok(!/—/.test(doc), 'no em dashes');
});

// ---------------------------------------------------------------- B17: calendar file
const TODAY = '2026-11-14';
const stamp = new Date('2026-11-14T12:00:00Z');
function calState() {
  const s = S.defaultState();
  s.renewals.push(renew({ id: 'rn1', title: 'Car insurance', dueDate: '2026-12-01' }), renew({ id: 'rn2', title: 'Closed one', dueDate: '2026-12-02', state: 'cancelled' }), renew({ id: 'rn3', title: 'Far away', dueDate: '2028-01-01' }), renew({ id: 'rn4', title: 'Past', dueDate: '2026-01-01' }), renew({ id: 'rn5', title: 'Year end', dueDate: '2026-12-31' }));
  s.maintenance.push(maint({ id: 'mt1', title: 'Gutters', nextDue: '2026-11-20' }));
  s.invoices.push({ id: 'iv1', number: 'INV-0001', issueDate: '2026-11-01', dueDate: '2026-12-15', lines: [{ description: 'Work', qty: 1, unitCents: 12345 }], status: 'sent', notes: '' },
    { id: 'iv2', number: 'INV-0002', issueDate: '2026-11-01', dueDate: '2026-12-16', lines: [{ description: 'Work', qty: 1, unitCents: 100 }], status: 'paid', paidOn: '2026-11-05', notes: '' });
  s.goals.push({ id: 'g1', title: 'Run a 10k', horizon: 'quarterly', domain: 'goals', metric: 'manual', direction: 'up', startValue: 0, targetValue: 100, startDate: '2026-10-01', dueDate: '2026-12-30', state: 'active', notes: '', createdAt: '2026-10-01T00:00:00.000Z' });
  s.activities.push({ id: 'ac1', title: 'Beach trip', category: 'outing', state: 'planned', date: '2026-11-25', endDate: '2026-11-27', place: 'Cape May', withPeople: [], alsoHealth: false, alsoSocial: false, notes: '', costCents: 50000 });
  s.people.push({ id: 'pp1', name: 'Sam Example', importantDates: [{ label: 'Birthday', monthDay: '12-25', year: 1990 }], pipelineIds: [], projectIds: [], facts: [], notes: '', archived: false });
  s.learningItems.push({ id: 'li1', title: 'AWS exam', kind: 'certification', provider: 'Vendor', state: 'active', notes: '', examDate: '2026-12-05', expiresOn: '2027-03-01' });
  L.tax.startDefaultYear(s, 2026);
  return S.validateState(clone(s));
}
// A small iCalendar reader for the tests: unfold, check line endings, split into events.
function readIcs(text) {
  assert.ok(text.endsWith('\r\n'), 'ends with CRLF');
  assert.ok(!/[^\r]\n/.test(text) && !/\r(?!\n)/.test(text), 'every line break is CRLF');
  const phys = text.slice(0, -2).split('\r\n');
  for (const l of phys) assert.ok(Buffer.byteLength(l, 'utf8') <= 75, 'physical line over 75 octets: ' + l.length);
  const lines = []; for (const l of phys) { if (l[0] === ' ') { assert.ok(lines.length); lines[lines.length - 1] += l.slice(1); } else lines.push(l); }
  assert.deepEqual([lines[0], lines[1], lines[lines.length - 1]], ['BEGIN:VCALENDAR', 'VERSION:2.0', 'END:VCALENDAR']);
  const events = []; let cur = null;
  for (const l of lines.slice(1, -1)) {
    if (l === 'BEGIN:VEVENT') { assert.equal(cur, null); cur = {}; continue; }
    if (l === 'END:VEVENT') { events.push(cur); cur = null; continue; }
    const m = /^([A-Z][A-Z0-9-]*)((?:;[A-Z]+=[A-Z]+)*):(.*)$/.exec(l); assert.ok(m, 'bad line: ' + l.slice(0, 60));
    if (cur) { assert.ok(!(m[1] in cur), 'repeated property ' + m[1]); cur[m[1]] = { params: m[2], value: m[3] }; }
  }
  assert.equal(cur, null);
  return events;
}
const unesc = (v) => v.replace(/\\([\\;,nN])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
const byKind = (ev, title) => ev.filter((e) => unesc(e.SUMMARY.value) === title);

test('B17 structure: valid iCalendar header and events, CRLF, only the expected properties, window of 12 months, closed and past items left out', () => {
  const r = CAL.build(calState(), { today: TODAY, stamp });
  const ev = readIcs(r.text);
  assert.equal(r.count, ev.length); assert.equal(r.realTitles, false); assert.equal(r.privateIncluded, false);
  assert.match(r.text, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:-\/\/LifeOS\/\/Calendar file\/\/EN\r\n/);
  for (const e of ev) assert.deepEqual(Object.keys(e).sort(), ['DTEND', 'DTSTAMP', 'DTSTART', 'SUMMARY', 'TRANSP', 'UID']);
  const titles = ev.map((e) => unesc(e.SUMMARY.value));
  for (const want of ['LifeOS: renewal due', 'LifeOS: maintenance due', 'LifeOS: tax payment due', 'LifeOS: invoice due', 'LifeOS: goal due', 'LifeOS: exam', 'LifeOS: certification expires', 'LifeOS: planned activity', 'LifeOS: important date']) assert.ok(titles.includes(want), want);
  assert.equal(titles.filter((t) => t === 'LifeOS: renewal due').length, 2, 'two open renewals inside the window (12-01 and 12-31)');
  assert.equal(titles.filter((t) => t === 'LifeOS: invoice due').length, 1, 'the paid invoice is left out');
  const starts = ev.map((e) => e.DTSTART.value); assert.deepEqual(starts, starts.slice().sort(), 'sorted by date');
  assert.ok(starts.every((d) => d >= '20261114' && d <= '20271114'));
  assert.equal(r.text.split('\r\nBEGIN:VEVENT').length - 1, ev.length);
  assert.equal(CAL.filename(TODAY), 'lifeos-calendar-2026-11-14.ics');
});
test('B17 dates: all-day DATE values in the local date, the end is the next day (exclusive), multi-day and year-end items are right', () => {
  const ev = readIcs(CAL.build(calState(), { today: TODAY, stamp }).text);
  const one = (t, d) => ev.filter((e) => unesc(e.SUMMARY.value) === t && e.DTSTART.value === d);
  const yearEnd = one('LifeOS: renewal due', '20261231')[0];
  assert.deepEqual([yearEnd.DTSTART.params, yearEnd.DTEND.params, yearEnd.DTEND.value], [';VALUE=DATE', ';VALUE=DATE', '20270101']);
  const trip = one('LifeOS: planned activity', '20261125')[0]; assert.equal(trip.DTEND.value, '20261128');
  assert.equal(one('LifeOS: maintenance due', '20261120')[0].DTEND.value, '20261121');
  assert.equal(one('LifeOS: important date', '20261225')[0].DTEND.value, '20261226');
  assert.equal(ev[0].DTSTAMP.value, '20261114T120000Z'); assert.ok(!/DTSTART[^:]*:\d{8}T/.test(CAL.build(calState(), { today: TODAY, stamp }).text), 'no time part in a start');
  // a date at the far end of the window, and the leap day
  const s = calState(); s.renewals.push(renew({ id: 'edge', title: 'Edge', dueDate: '2027-11-14' }), renew({ id: 'edge2', title: 'Beyond', dueDate: '2027-11-15' }), renew({ id: 'leap', title: 'Leap', dueDate: '2028-02-29' }));
  const e2 = readIcs(CAL.build(s, { today: TODAY, stamp }).text).map((e) => e.DTSTART.value);
  assert.ok(e2.includes('20271114') && !e2.includes('20271115') && !e2.includes('20280229'));
  const s3 = fresh(); s3.renewals.push(renew({ id: 'l', title: 'Leap', dueDate: '2028-02-29' }));
  const e3 = readIcs(CAL.build(s3, { today: '2028-02-28', stamp }).text); assert.deepEqual([e3[0].DTSTART.value, e3[0].DTEND.value], ['20280229', '20280301']);
});
test('B17 the date part is the same in every time zone (it never goes through a Date in local or UTC time)', () => {
  const a = CAL.build(calState(), { today: TODAY, stamp: new Date('2026-11-14T23:59:59Z') }).text.replace(/DTSTAMP:\S+/g, '');
  const b = CAL.build(calState(), { today: TODAY, stamp: new Date('2026-11-14T00:00:01Z') }).text.replace(/DTSTAMP:\S+/g, '');
  assert.equal(a, b);
  assert.match(CAL.build(calState(), { today: TODAY, stamp: new Date('2026-11-14T23:59:59Z') }).text, /DTSTAMP:20261114T235959Z/);
  assert.ok(!/DTSTAMP:[^\r]*\.\d{3}/.test(a));
});
test('B17 stable UIDs: the same across builds, fixed characters only, unchanged when a date moves, different for different items and kinds', () => {
  const uids = (s, o) => readIcs(CAL.build(s, Object.assign({ today: TODAY, stamp }, o)).text).map((e) => e.UID.value);
  const a = uids(calState()), b = uids(calState(), { stamp: new Date('2027-01-01T00:00:00Z'), realTitles: true });
  assert.deepEqual(a.slice().sort(), b.slice().sort(), 'the same set in both label modes and at another time');
  assert.equal(new Set(a).size, a.length);
  for (const u of a) assert.match(u, /^lifeos-[0-9a-f]{28}@lifeos\.local$/);
  const moved = calState(); moved.renewals.find((r) => r.id === 'rn1').dueDate = '2026-12-09'; moved.renewals.find((r) => r.id === 'rn1').title = 'Renamed';
  assert.deepEqual(uids(moved).slice().sort(), a.slice().sort(), 'moving a date or renaming keeps the event, so a re-import updates it');
  assert.notEqual(CAL.uidOf('renewal', 'x'), CAL.uidOf('maintenance', 'x')); assert.notEqual(CAL.uidOf('renewal', 'x'), CAL.uidOf('renewal', 'y'));
  const t = calState(); t.renewals.find((r) => r.id === 'rn1').id = 'new-id'; assert.notDeepEqual(uids(t).slice().sort(), a.slice().sort());
});
test('B17 labels: generic by default (no title, name, amount, place or note anywhere in the file); real titles only with the tick', () => {
  const s = calState();
  const g = CAL.build(s, { today: TODAY, stamp }).text, r = CAL.build(s, { today: TODAY, stamp, realTitles: true });
  for (const secret of ['Car insurance', 'Gutters', 'INV-0001', 'Run a 10k', 'Beach trip', 'Cape May', 'Sam Example', 'Birthday', 'AWS exam', 'Vendor', '12345', '123.45', '50000', 'estimated tax, quarter']) assert.ok(!g.includes(secret), 'generic file leaks ' + secret);
  assert.equal(CAL.build(s, { today: TODAY, stamp, realTitles: false }).text, g);
  assert.equal(r.realTitles, true);
  const titles = readIcs(r.text).map((e) => unesc(e.SUMMARY.value));
  for (const t of ['LifeOS: Car insurance', 'LifeOS: Gutters', 'LifeOS: Invoice INV-0001', 'LifeOS: Run a 10k', 'LifeOS: Beach trip', 'LifeOS: Birthday: Sam Example', 'LifeOS: AWS exam']) assert.ok(titles.includes(t), t);
  assert.ok(titles.some((t) => /^LifeOS: Federal estimated tax, quarter 4 of 2026$/.test(t)));
  for (const never of ['Cape May', 'Vendor', '12345', '123.45', '50000']) assert.ok(!r.text.includes(never), 'real-title file still must not carry ' + never);
  assert.ok(!/DESCRIPTION|LOCATION|ATTENDEE|ORGANIZER|URL:/.test(r.text));
});
test('B17 escaping: commas, semicolons and backslashes are escaped and round trip; line breaks become \\n', () => {
  const s = fresh(); const title = 'A, B; C \\ D\\n E';
  s.renewals.push({ id: 'e1', title, kind: 'other', provider: '', dueDate: '2026-12-01', cadence: 'once', autoRenews: false, state: 'open', notes: '' });
  const out = CAL.build(s, { today: TODAY, stamp, realTitles: true }).text;
  assert.ok(out.includes('SUMMARY:LifeOS: A\\, B\\; C \\\\ D\\\\n E\r\n'), out.split('\r\n').find((l) => l.startsWith('SUMMARY')));
  assert.equal(unesc(readIcs(out)[0].SUMMARY.value), 'LifeOS: ' + title);
  assert.equal(CAL.escape('a\r\nb\rc\nd e'), 'a\\nb\\nc\\nd\\ne');
  assert.equal(CAL.escape('x\u0000y\u001fz\u007f'), 'x y z ');
});
test('B17 no injection: titles and ids with CRLF, semicolons and END:VEVENT never start a line or add an event or property', () => {
  const hostile = ['Pay\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:evil', 'x;y\nEND:VEVENT', 'END:VEVENT', 'A\rBEGIN:VCALENDAR', 'a;ATTENDEE:mailto:x@y.z\r\nURL:http://evil', 'DTSTART:20200101', 'é'.repeat(120) + '\r\nEND:VCALENDAR', ' END:VEVENT ', 'a\u0000b\u000bc'];
  const s = fresh();
  hostile.forEach((t, i) => s.renewals.push({ id: 'h' + i + '\r\nEND:VEVENT', title: t, kind: 'other', provider: '', dueDate: '2026-12-0' + (i + 1), cadence: 'once', autoRenews: false, state: 'open', notes: '' }));
  s.people.push({ id: 'p\r\nEND:VEVENT', name: 'N\r\nEND:VEVENT;x', importantDates: [{ label: 'L;\r\nEND:VEVENT', monthDay: '12-20' }], pipelineIds: [], projectIds: [], facts: [], notes: '', archived: false });
  for (const real of [false, true]) {
    const r = CAL.build(s, { today: TODAY, stamp, realTitles: real }), ev = readIcs(r.text);
    assert.equal(ev.length, hostile.length + 1);
    assert.equal(r.text.split('\r\n').filter((l) => l === 'END:VEVENT').length, ev.length);
    assert.equal(r.text.split('\r\n').filter((l) => l === 'BEGIN:VEVENT').length, ev.length);
    assert.equal(r.text.split('\r\n').filter((l) => l === 'BEGIN:VCALENDAR' || l === 'END:VCALENDAR').length, 2);
    assert.ok(!/(^|\r\n)(ATTENDEE|URL|DTSTART:2020|SUMMARY:evil)/.test(r.text.replace(/\r\n /g, '')), 'no injected property');
    for (const e of ev) assert.match(e.UID.value, /^lifeos-[0-9a-f]{28}@lifeos\.local$/);
    const body = r.text.replace(/\r\n /g, '');
    if (real) assert.ok(body.includes('Pay\\nEND:VEVENT\\nBEGIN:VEVENT\\nSUMMARY:evil'), 'the hostile text is kept as escaped text inside SUMMARY');
    else assert.ok(!body.includes('Pay'));
  }
  assert.throws(() => CAL.build(s, { today: '14 Nov', stamp }), /Today must be a date/);
});
test('B17 folding: no physical line over 75 octets, continuations start with one space, multibyte characters are never split, unfolding restores the line', () => {
  const long = 'Renewal ' + 'é'.repeat(70) + ' 😀'.repeat(30) + ' plain words that go on and on ' + 'x'.repeat(40);
  const s = fresh(); s.renewals.push(renew({ id: 'L', title: long, dueDate: '2026-12-01' }));
  const out = CAL.build(s, { today: TODAY, stamp, realTitles: true }).text;
  const phys = out.split('\r\n'); assert.ok(phys.some((l) => l.startsWith(' ')), 'something was folded');
  for (const l of phys) { assert.ok(Buffer.byteLength(l) <= 75, Buffer.byteLength(l) + ' octets'); assert.ok(!l.includes('�')); assert.ok(l === '' || l[0] !== '\t'); }
  assert.equal(unesc(readIcs(out)[0].SUMMARY.value), 'LifeOS: ' + long);
  assert.equal(Buffer.from(out, 'utf8').toString('utf8'), out);
  const exact = 'a'.repeat(75); assert.equal(CAL.fold(exact), exact); assert.equal(CAL.fold('a'.repeat(76)), 'a'.repeat(75) + '\r\n a');
  assert.equal(CAL.fold('a'.repeat(74) + 'é'), 'a'.repeat(74) + '\r\n é');
  assert.equal(CAL.fold('a'.repeat(150)).split('\r\n').map((l) => l.length).join(','), '75,75,2', 'the second line holds a space and 74 characters');
});
test('B17 private items: left out by default, by a closed vault and by an untouched tick; in only when the vault is open and the tick is on', async () => {
  S._setAdapter(memAdapter()); await S.init(PASS);
  const base = calState(); delete base.priv;
  await S.replaceState(base);
  await P.setUp('a private passphrase 99');
  await P.moveIn('renewals', 'rn1'); await P.moveIn('maintenance', 'mt1');
  const live = () => S.getState();
  const kinds = (o) => { const r = CAL.build(live(), Object.assign({ today: TODAY, stamp }, o)); return [r.privateIncluded, readIcs(r.text).map((e) => unesc(e.SUMMARY.value))]; };
  const hasPriv = (t) => t.includes('LifeOS: maintenance due') && t.filter((x) => x === 'LifeOS: renewal due').length === 2;
  assert.equal(P.isOpen(), true);
  let [inc, t] = kinds({}); assert.equal(inc, false); assert.ok(!t.includes('LifeOS: maintenance due') && t.filter((x) => x === 'LifeOS: renewal due').length === 1, 'vault open, tick off: private left out');
  [inc, t] = kinds({ includePrivate: true }); assert.equal(inc, true); assert.ok(hasPriv(t), 'vault open, tick on: private included');
  [inc, t] = kinds({ includePrivate: true, realTitles: true }); assert.ok(t.includes('LifeOS: Gutters') && t.includes('LifeOS: Car insurance'));
  [inc, t] = kinds({ includePrivate: 'yes' }); assert.equal(inc, false, 'only a real true counts');
  // the same calendar with the private tick on but the vault closed: nothing private, and no marker that anything is hidden
  P.close('system');
  [inc, t] = kinds({ includePrivate: true, realTitles: true }); assert.equal(inc, false); assert.ok(!t.includes('LifeOS: Gutters') && !t.includes('LifeOS: Car insurance') && !t.includes('LifeOS: maintenance due'));
  assert.equal(CAL.build(live(), { today: TODAY, stamp, includePrivate: true }).text, CAL.build(live(), { today: TODAY, stamp }).text);
  assert.ok(!CAL.build(live(), { today: TODAY, stamp, realTitles: true, includePrivate: true }).text.includes('Gutters'));
});
test('B17 the calendar file touches no network, builds from the state it is given, and the app wires two ticks with warnings and a download', () => {
  const c = src('src/core/calendar.js'); assert.ok(!/fetch|XMLHttpRequest|WebSocket|sendBeacon|innerHTML|Date\.now|toLocale/.test(c));
  const app = src('src/ui/app.js');
  for (const id of ['cal-real', 'cal-priv', 'cal-real-warn', 'cal-priv-warn', 'cal-download']) assert.ok(app.includes("'" + id + "'"), id);
  assert.match(app, /Include real titles/); assert.match(app, /Include private items/); assert.match(app, /not encrypted/);
  assert.match(app, /includePrivate: open && priv\.checked/); assert.match(app, /realTitles: real\.checked/);
  assert.match(app, /download\(L\.calendar\.filename\(today\(\)\), r\.text, 'text\/calendar'\)/);
  assert.ok(!/—/.test(c + app.slice(app.indexOf('weekly loop (v1.5.0)'), app.indexOf('weekly review ----------'))), 'no em dashes in the new copy');
});

// ---------------------------------------------------------------- wiring
test('v1.5.0 wiring: version, schema, build order, new UI ids, and the insight card keeps its approve-only-on-tap rule', () => {
  assert.equal(JSON.parse(src('package.json')).version, '2.3.0'); assert.equal(S.SCHEMA, 23); assert.equal(fresh().schema, 23);
  assert.match(src('build.mjs'), /'memory', 'ai', 'calendar', 'jobs', 'search'\]/);
  const app = src('src/ui/app.js');
  for (const id of ['review-due', 'review-due-start', 'rv-streak', 'dash-streak', 'offer-merge-', 'reject-category', 'approve-apply', 'apply-change', 'muted-none']) assert.ok(app.includes(id), id);
  assert.ok(!/L\.memory\.decide\([^)]*\)[^;]*setTimeout/.test(app));
  const due = app.slice(app.indexOf('function reviewDueCard'), app.indexOf('// ---------- weekly review ----------')); assert.ok(due.length > 50 && !/commit\(|act\(/.test(due), 'the due card only offers a button');
  assert.match(app, /btn\('Start weekly review', function \(\) \{ go\('review'\); \}, 'sm pri', \{ id: 'review-due-start' \}\)/);
});
