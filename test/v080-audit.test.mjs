// v0.8.0 audit regression tests (SEC-49 onward) and the checks the audit asked for: the Settings study target, the tile fallback once
// Learning data exists, the full SEC-44 bypass set on every typed Learning field, search speed at the cap and vault size at the caps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { L, memAdapter, PASS, E, S, M, V, Mem, TODAY, WK, clone, build, fresh, live } from './_v070.mjs';

const Ln = live('learning');
let n = 0;
const item = (o) => Object.assign({ id: 'li-' + (n++), title: 'Item ' + n, kind: 'course', provider: '', state: 'active', notes: '' }, o);
const sess = (o) => Object.assign({ id: 'ss-' + (n++), date: '2026-11-10', minutes: 30, notes: '' }, o);
const day = (i) => new Date(Date.parse('2020-01-01T00:00:00Z') + (i % 2500) * 864e5).toISOString().slice(0, 10);
// Learning at its caps with every typed text field full of a character that takes three bytes in UTF-8.
function fullLearning(ch, sessionNote) {
  const s = S.defaultState();
  s.settings.learning = { weeklyMinutes: 300 };
  s.learningItems = Array.from({ length: Ln.ITEM_CAP }, (_, i) => ({ id: 'i' + i, title: ch.repeat(200), kind: 'certification', provider: ch.repeat(200), state: 'active', totalUnits: 100, doneUnits: 5, unitLabel: ch.repeat(30), startDate: day(i), targetDate: day(i + 400), examDate: day(i + 100), expiresOn: day(i + 900), notes: ch.repeat(2000) }));
  s.studySessions = Array.from({ length: Ln.SESSION_CAP }, (_, i) => ({ id: 's' + i, itemId: 'i' + (i % 1000), date: day(i), minutes: 30, notes: ch.repeat(sessionNote) }));
  s.takeaways = Array.from({ length: Ln.TAKEAWAY_CAP }, (_, i) => ({ id: 't' + i, itemId: 'i' + (i % 1000), date: day(i), text: ch.repeat(1000) }));
  return s;
}

// SEC-49: a typed session note is capped at 200 characters; older hours notes carried over keep their full 2,000 characters.
test('SEC-49: typed study session notes are capped so Learning at its caps fits the 64 MB backup and sync limit', () => {
  const s = S.defaultState();
  assert.throws(() => Ln.addSession(s, { minutes: 20, notes: 'a'.repeat(Ln.SESSION_NOTE_MAX + 1) }, TODAY), /up to 200 characters/);
  assert.equal(s.studySessions.length, 0);
  Ln.addSession(s, { minutes: 20, notes: 'b'.repeat(Ln.SESSION_NOTE_MAX) }, TODAY);
  assert.equal(s.studySessions[0].notes.length, 200);
  const old = S.validateState(Object.assign(S.defaultState(), { studySessions: [sess({ notes: 'c'.repeat(2000) })] }));
  assert.equal(old.studySessions[0].notes.length, 2000, 'a carried-over note is still valid');
  const legacy = S.defaultState(); legacy.schema = 6; delete legacy.learningItems; delete legacy.studySessions; delete legacy.takeaways; delete legacy.settings.learning;
  legacy.entries.push(E({ domain: 'learning', type: 'hours', title: 'Long note hours', value: 1, notes: 'd'.repeat(1900) }));
  const up = S.validateState(legacy);
  assert.equal(up.studySessions.length, 1); assert.ok(up.studySessions[0].notes.endsWith('d'.repeat(1900)));
});

test('SEC-49: Learning alone at the typed caps with three-byte text exports under 64 MB', async () => {
  const st = S.validateState(fullLearning('€', Ln.SESSION_NOTE_MAX));
  const out = await V.exportBackup(PASS, st);
  assert.ok(out.length < V.MAX_BACKUP, String(out.length));
});

test('SEC-49: an over-size vault is refused by export and by sync with a clear message, and nothing is written or cut', async () => {
  const big = S.validateState(fullLearning('€', 2000));
  await assert.rejects(V.exportBackup(PASS, big), (e) => /larger than 64 MB, so no file was made/.test(e.message) && /study sessions/.test(e.message));
  const { d } = await fresh();
  await L.sync.run();
  const before = d.file.text, writes = d.writes;
  await S.commit((x) => { x.studySessions = big.studySessions.slice(0, 12000); });
  await assert.rejects(L.sync.run(), (e) => e.code === 'TOO_LARGE' && /nothing was uploaded/.test(e.message) && /unchanged/.test(e.message));
  assert.equal(d.file.text, before); assert.equal(d.writes, writes);
  assert.equal(S.getState().studySessions.length, 12000, 'the local vault keeps everything');
});

// The Settings study target (the engineer had no unit test for the Settings path).
test('Settings study target: validated, capped at 10,080, and a bad value saves nothing from the form', async () => {
  const s = S.defaultState();
  for (const [v, want] of [['0', 0], ['', 0], [null, 0], [undefined, 0], [' 90 ', 90], ['10080', 10080], ['00045', 45], [120, 120]]) assert.equal(Ln.setWeeklyTarget(s, v), want, String(v));
  for (const bad of ['10081', '99999', '-1', '1.5', '1e3', '0x10', 'abc', '60 min', '６０', 'Infinity', 'NaN', '123456']) assert.throws(() => Ln.setWeeklyTarget(s, bad), /whole number from 0 to 10080/, String(bad));
  assert.equal(s.settings.learning.weeklyMinutes, 120);
  for (const bad of [10081, -1, 1.5, '60', NaN, Infinity, null, true]) {
    const x = S.defaultState(); x.settings.learning = { weeklyMinutes: bad };
    assert.throws(() => S.validateState(x), /weekly study minutes/, String(bad));
  }
  const x = S.defaultState(); x.settings.learning = { weeklyMinutes: 60, __extra: 'dropped' };
  assert.deepEqual(S.validateState(x).settings.learning, { weeklyMinutes: 60 });
  // The Settings form saves targets, currency and the study target in one commit: a bad study value leaves every setting as it was.
  await fresh();
  await S.commit((y) => { Ln.setWeeklyTarget(y, '150'); });
  const was = clone(S.getState().settings);
  await assert.rejects(S.commit((y) => { y.settings.targets = { workoutsPerWeek: 9, contactDays: 3, savingsRate: 0.5 }; y.settings.currency = 'EUR'; Ln.setWeeklyTarget(y, '20000'); }), /whole number/);
  assert.deepEqual(S.getState().settings, was);
  await S.commit((y) => { y.settings.currency = 'EUR'; Ln.setWeeklyTarget(y, '200'); });
  assert.equal(S.getState().settings.learning.weeklyMinutes, 200); assert.equal(S.getState().settings.currency, 'EUR');
});

// The tile and digest fall back to the older count only while there is no Learning data; once there is, older entries never mix in.
test('tile fallback: once Learning data exists, kept older entries never change the minutes shown', () => {
  const R = (label, display, value, sub) => ({ label, display, value, sub });
  const legacy = (x) => x.entries.push(E({ domain: 'learning', type: 'item', status: 'done', date: '2026-11-10' }), E({ domain: 'learning', type: 'item', status: 'done', date: '2026-11-11' }), E({ domain: 'learning', type: 'hours', value: 1.333, date: '2026-11-10' }));
  const old = build(legacy);
  assert.equal(M.headline(old, 'learning', TODAY).value, 2); assert.equal(M.weeklyDigest(old, WK).domains.learning.unit !== 'minutes', true);
  const mixed = build((x) => { legacy(x); x.studySessions.push(sess({ date: '2026-11-12', minutes: 25 })); });
  const h = M.headline(mixed, 'learning', TODAY);
  assert.deepEqual([h.label, h.value, h.display], ['Study minutes this week', 25, '25']);
  const dg = M.weeklyDigest(mixed, WK);
  assert.deepEqual([dg.domains.learning.now, dg.domains.learning.unit], [25, 'minutes']); assert.equal(dg.learning.minutes, 25);
  assert.deepEqual(M.series(mixed, 'learning', 2, TODAY).map((p) => p.value), [0, 25]);
  assert.equal(Mem.rulesInsights(mixed, WK).filter((i) => i.domain === 'learning').every((i) => !/ 2 |items/.test(i.text)), true);
  // A study target alone also counts as Learning data, so the old count cannot come back while a target is set.
  const tgt = build((x) => { legacy(x); x.settings.learning = { weeklyMinutes: 90 }; });
  assert.deepEqual([M.headline(tgt, 'learning', TODAY).display, M.weeklyDigest(tgt, WK).domains.learning.unit], ['0 of 90', 'minutes']);
});

// The full SEC-44 bypass set is refused in every typed Learning text field.
test('secrets guard: the full SEC-44 bypass set is refused in item notes, edited notes, session notes and takeaways', () => {
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
    '4111\u202a1111\u202c1111\u202a1111', '\u2066123-45-6789\u2069', '4111 \u202e1111 1111 1111',
  ];
  const s = S.defaultState(), it = Ln.addItem(s, { title: 'Course', notes: 'fine' }, TODAY);
  for (const x of sneaky) {
    const m = (e) => e.message === Ln.SECRET_MESSAGE;
    assert.throws(() => Ln.addItem(s, { title: 'C', notes: 'note ' + x }, TODAY), m, JSON.stringify(x));
    assert.throws(() => Ln.updateItem(s, it.id, { notes: x + ' end' }), m, JSON.stringify(x));
    assert.throws(() => Ln.addSession(s, { minutes: 10, notes: x }, TODAY), m, JSON.stringify(x));
    assert.throws(() => Ln.addTakeaway(s, { text: 'took ' + x }, TODAY), m, JSON.stringify(x));
  }
  assert.deepEqual([s.learningItems.length, s.learningItems[0].notes, s.studySessions.length, s.takeaways.length], [1, 'fine', 0, 0]);
});

test('takeaway search at 5,000 full takeaways: plain substring, no pattern, and fast', () => {
  const s = build((x) => { x.takeaways = Array.from({ length: Ln.TAKEAWAY_CAP }, (_, i) => ({ id: 't' + i, date: day(i), text: 'a'.repeat(980) + ' note ' + i + ' (x+)*$' })); });
  const t0 = performance.now();
  assert.equal(Ln.search(s, 'note 4999 ').length, 1);
  assert.equal(Ln.search(s, '(x+)*$').length, 5000);
  assert.equal(Ln.search(s, '.*').length, 0);
  assert.equal(Ln.search(s, 'a'.repeat(101)).length, 0, 'queries over 100 characters match nothing');
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, 'four searches took ' + ms + ' ms');
});
