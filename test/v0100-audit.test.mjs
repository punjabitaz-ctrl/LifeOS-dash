// v0.10.0 audit: regression tests for SEC-57 to SEC-61, the migration and conversion contract (nothing dropped, nothing duplicated,
// re-running converts nothing twice), adversarial names, and error and console privacy for every Social mutator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { L, PASS, E, S, M, V, Mem, TODAY, WK, clone, build, fresh } from './_v070.mjs';
import { buildAdversarial, ADV_MARK } from './_adversarial.mjs';

const So = new Proxy({}, { get: (_, p) => L.social[p] }), Ac = new Proxy({}, { get: (_, p) => L.activities[p] });
let n = 0;
const per = (o) => Object.assign({ id: 'p-' + (n++), name: 'Person ' + n, importantDates: [], pipelineIds: [], projectIds: [], facts: [], notes: '', archived: false }, o);
const act = (o) => Object.assign({ id: 'ac-' + (n++), title: 'Activity', category: 'outing', state: 'done', date: '2026-11-10', place: '', withPeople: [], alsoHealth: false, alsoSocial: true, notes: '' }, o);
const SE = (o) => E(Object.assign({ domain: 'social', type: 'contact' }, o));
const lastIds = (s) => [...So.lastContacts(s, TODAY).keys()].sort();

test('SEC-57: a name shared by two people is ambiguous: no contact is attributed to either, and the count of shared names is reported', () => {
  const s = build((x) => {
    x.people.push(per({ id: 'a', name: 'Sam' }), per({ id: 'b', name: ' SAM ' }), per({ id: 'c', name: 'Sammy' }), per({ id: 'd', name: 'Al' }));
    x.activities.push(act({ withPeople: ['sam'] }), act({ withPeople: ['Alice', 'Sammy'] }));
  });
  assert.deepEqual(lastIds(s), ['c'], 'Sam is ambiguous; Sammy is exact; Al is never matched by Alice (no substring match)');
  assert.equal(So.ambiguousNames(s), 1);
  assert.equal(So.contactsBetween(s, WK, TODAY), 1);
  assert.equal(So.roster(s, TODAY).find((r) => r.id === 'a').never, true);
  // the same pair in a converted entry is not guessed either: the entry stays an entry
  const t = clone(s); t.entries.push(SE({ id: 'e1', date: '2026-11-01', title: 'Call', person: 'sam' }));
  const v = S.validateState(clone(t));
  assert.equal(So.convertible(v), 0); assert.equal(So.convertEntries(v), 0); assert.equal(v.entries.length, 1); assert.equal(v.contacts.length, 0);
  // a unique name still works, and renaming one of the pair removes the ambiguity
  const u = clone(s); u.people.find((p) => p.id === 'b').name = 'Sam B'; const w = S.validateState(u);
  assert.equal(So.ambiguousNames(w), 0); assert.deepEqual(lastIds(w), ['a', 'c']);
});

test('SEC-58: names match across Unicode forms (composed, decomposed, full-width) and a duplicate in another form is refused', () => {
  const nfc = 'José Åse', nfd = 'José Åse', wide = 'Ｊｏｓé Åse';
  const s = build((x) => { x.people.push(per({ id: 'j', name: nfc })); x.activities.push(act({ withPeople: [nfd] }), act({ date: '2026-11-12', withPeople: [wide] })); });
  assert.deepEqual(lastIds(s), ['j']); assert.equal(So.roster(s, TODAY)[0].last, '2026-11-12');
  assert.throws(() => So.addPerson(clone(s), { name: nfd }), /already in your list/);
  assert.equal(So.search(s, 'josé').length, 1); assert.deepEqual(So.unknownNames(s, [nfd, wide]), []);
  // the migration merges the forms into one person
  const old = S.defaultState(); old.entries.push(SE({ id: 'e1', date: '2026-10-01', title: 'A', person: nfc }), SE({ id: 'e2', date: '2026-10-02', title: 'B', person: nfd }));
  const m = clone(old); m.schema = 8; delete m.groups; delete m.people; delete m.contacts;
  const got = S.validateState(m); assert.equal(got.people.length, 1); assert.equal(got.contacts.length, 2);
});

test('SEC-59: converting later contact entries never drops, never duplicates, takes a fresh id on a clash, and is idempotent', () => {
  const s = build((x) => {
    x.people.push(per({ id: 'sam', name: 'Sam' }));
    x.contacts.push({ id: 'e1', personId: 'sam', date: '2026-11-01', channel: 'call', notes: '' });
    x.entries.push(SE({ id: 'e1', date: '2026-10-01', title: 'Coffee', person: 'sam' }), SE({ id: 'e2', date: '2026-10-02', title: 'Walk', person: 'New Pal' }),
      SE({ id: 'e3', date: '2026-10-03', title: 'T'.repeat(200), person: 'Sam', notes: 'x'.repeat(2000) }), E({ domain: 'health', type: 'workout', date: '2026-11-10', title: 'Run' }));
  });
  const before = s.entries.length + s.contacts.length;
  assert.equal(So.convertible(s), 2, 'the over-long entry cannot convert'); assert.equal(s.entries.length, 4, 'counting changes nothing');
  const t = clone(s); assert.equal(So.convertEntries(t), 2);
  const v = S.validateState(clone(t)); // the contact id clash used to make this throw
  assert.equal(v.entries.length + v.contacts.length, before, 'nothing dropped, nothing duplicated');
  assert.deepEqual(v.entries.map((e) => e.id).sort(), ['e3', v.entries.find((e) => e.domain === 'health').id].sort());
  assert.equal(v.contacts.filter((c) => c.notes === 'Coffee').length, 1); assert.notEqual(v.contacts.find((c) => c.notes === 'Coffee').id, 'e1');
  assert.deepEqual(v.people.map((p) => p.name).sort(), ['New Pal', 'Sam'], 'no empty person for the entry that cannot convert');
  const again = clone(v); assert.equal(So.convertible(again), 0); assert.equal(So.convertEntries(again), 0); assert.deepEqual(S.validateState(again), v, 'second run changes nothing');
  // the migration itself is idempotent: validating its output again changes nothing
  const old = S.defaultState(); old.entries.push(SE({ id: 'm1', date: '2026-10-01', title: 'A', person: 'Kim' }), SE({ id: 'm2', date: '2026-10-02', title: 'B', person: 'kim' }));
  const m = clone(old); m.schema = 8; delete m.groups; delete m.people; delete m.contacts;
  const once = S.validateState(m), twice = S.validateState(clone(once));
  assert.deepEqual(twice, once); assert.equal(once.people.length, 1); assert.equal(once.contacts.length, 2); assert.equal(So.convertible(once), 0);
});

test('SEC-59: entries arriving by CSV import after the migration convert through the offer, once', async () => {
  await fresh();
  await S.commit((x) => So.addPerson(x, { name: 'Ann Lee' }));
  const parsed = L.csv.parse('date,title,person\n2026-10-01,Lunch,ann  lee\n2026-10-02,Call,Bo\n');
  const r = L.csv.toEntries(parsed, { domain: 'social', type: 'contact', map: { date: 'date', title: 'title', person: 'person' } });
  await S.commit((x) => { x.entries = x.entries.concat(r.entries); });
  assert.equal(So.convertible(S.getState()), 2);
  await S.commit((x) => So.convertEntries(x));
  const st = S.getState();
  assert.equal(st.entries.filter((e) => e.domain === 'social').length, 0); assert.equal(st.contacts.length, 2); assert.deepEqual(st.people.map((p) => p.name).sort(), ['Ann Lee', 'Bo']);
  await S.commit((x) => assert.equal(So.convertEntries(x), 0)); assert.equal(S.getState().contacts.length, 2);
});

test('SEC-60: at a glance an important date shows only its label and the person name', () => {
  const s = build((x) => x.people.push(per({ id: 'a', name: 'Sam', importantDates: [{ label: 'Birthday', monthDay: '11-20', year: 1990 }] })));
  const g = Ac.glance(s, TODAY), it = g.later.find((x) => x.source === 'important-dates');
  assert.equal(it.title, 'Birthday: Sam'); assert.ok(!/\d/.test(it.title));
});

test('SEC-61: Social at its caps in three-byte text is refused whole by backup with a message naming logged contacts and facts; nothing is cut', async () => {
  const big = S.defaultState(), pad = (k) => '€'.repeat(k);
  for (let i = 0; i < 30; i++) big.groups.push({ id: 'g' + i, name: pad(98) + String(i).padStart(2, '0'), cadenceDays: 30 });
  for (let i = 0; i < 1000; i++) {
    big.people.push({ id: 'p' + i, name: pad(96) + String(i).padStart(4, '0'), groupId: 'g' + (i % 30), importantDates: Array.from({ length: 5 }, () => ({ label: pad(100), monthDay: '02-29' })), pipelineIds: [], projectIds: [],
      facts: Array.from({ length: 50 }, (_, j) => ({ id: 'f' + i + '-' + j, label: pad(40), text: pad(200), addedOn: '2026-11-01' })), notes: pad(200), archived: false });
    for (let j = 0; j < 20; j++) big.contacts.push({ id: 'c' + i + '-' + j, personId: 'p' + i, date: '2026-11-01', channel: 'call', notes: pad(200) });
  }
  const st = S.validateState(big);
  assert.equal(st.contacts.length, 20000); assert.equal(st.people[999].facts.length, 50);
  const bytes = new TextEncoder().encode(JSON.stringify(st)).length;
  assert.ok(bytes > 50 * 1048576, 'about 56 MB of JSON: ' + bytes);
  await assert.rejects(V.exportBackup(PASS, st), (e) => /64 MB/.test(e.message) && /logged contacts, facts/.test(e.message) && !e.message.includes('€'));
  assert.equal(st.contacts.length, 20000, 'nothing cut');
});

test('adversarial names: people and groups called __proto__, constructor or toString are plain data everywhere', async () => {
  const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
  const s = build((x) => {
    names.forEach((nm, i) => { x.groups.push({ id: 'g' + i, name: nm, cadenceDays: 7 }); x.people.push(per({ id: 'q' + i, name: nm, groupId: 'g' + i, importantDates: [{ label: nm, monthDay: '11-20' }] })); });
    x.activities.push(act({ withPeople: names }));
  });
  assert.equal(s.people.length, 5); assert.equal({}.polluted, undefined); assert.equal(Object.prototype.toString.call([]), '[object Array]');
  assert.deepEqual(lastIds(s), ['q0', 'q1', 'q2', 'q3', 'q4']);
  const dg = So.digest(s, WK); assert.deepEqual(dg.byGroup, names.map(() => ({ people: 1, overdue: 0 })));
  const js = JSON.stringify(M.weeklyDigest(s, WK)); for (const nm of names) assert.ok(!js.includes(nm), 'digest has ' + nm);
  assert.equal(So.search(s, 'proto').length, 1); assert.equal(Ac.glance(s, TODAY).later.length, 5);
  const back = await V.importBackup(PASS, await V.exportBackup(PASS, s)); assert.deepEqual(back.people, s.people);
});

test('no Social mutator error, validator error or console line carries a name, label, fact, channel or note', () => {
  const { state } = buildAdversarial(L);
  const p = state.people[0], out = [];
  const orig = {}; for (const k of ['log', 'warn', 'error', 'info', 'debug']) { orig[k] = console[k]; console[k] = (...a) => out.push(a.join(' ')); }
  const errs = [];
  const tryIt = (f) => { try { f(clone(state)); } catch (e) { errs.push(e.message); } };
  try {
    tryIt((x) => So.addPerson(x, { name: p.name }));
    tryIt((x) => So.addPerson(x, { name: ADV_MARK + 'x'.repeat(200) }));
    tryIt((x) => So.addPerson(x, { name: ADV_MARK + 'ok', notes: ADV_MARK + 'card 4111 1111 1111 1111' }));
    tryIt((x) => So.addGroup(x, state.groups[0].name, 7));
    tryIt((x) => So.addGroup(x, ADV_MARK + 'g', ADV_MARK));
    tryIt((x) => So.updatePerson(x, p.id, { [ADV_MARK]: 1 }));
    tryIt((x) => So.addFact(x, p.id, { label: ADV_MARK, text: ADV_MARK + 'ssn 123-45-6789' }, TODAY));
    tryIt((x) => So.addFact(x, p.id, { label: ADV_MARK + 'y'.repeat(60), text: 'ok' }, TODAY));
    tryIt((x) => So.addDate(x, p.id, { label: ADV_MARK, monthDay: ADV_MARK }));
    tryIt((x) => So.logContact(x, p.id, { channel: ADV_MARK, notes: ADV_MARK }, TODAY));
    tryIt((x) => So.logContact(x, p.id, { date: ADV_MARK }, TODAY));
    tryIt((x) => So.addSuggestedGroups(x, [ADV_MARK]));
    tryIt((x) => So.removeFact(x, p.id, ADV_MARK));
    tryIt((x) => So.linkPipeline(x, ADV_MARK, ADV_MARK));
    tryIt((x) => So.setCadence(x, p.id, ADV_MARK));
    for (const bad of [(x) => { x.people[0].name = { v: ADV_MARK }; }, (x) => { x.contacts[0].channel = ADV_MARK; }, (x) => { x.people[0].importantDates[0].monthDay = ADV_MARK; },
      (x) => { x.people[0].facts[0].text = ADV_MARK + 'z'.repeat(300); }, (x) => { x.groups[0].cadenceDays = ADV_MARK; }, (x) => { x.people.push(clone(x.people[0])); }])
      tryIt((x) => { bad(x); S.validateState(x); });
    So.roster(state, TODAY); So.byGroup(state, TODAY); So.reviewWeek(state, WK, TODAY); Mem.rulesInsights(state, WK); Mem.buildPrompt(state, 1, { from: WK, to: '2026-11-15' });
  } finally { for (const k of Object.keys(orig)) console[k] = orig[k]; }
  assert.ok(errs.length >= 20, 'errors provoked: ' + errs.length);
  for (const e of errs.concat(out)) { assert.ok(!e.includes('LEAK'), 'leaks: ' + e.slice(0, 80)); assert.ok(!e.includes('4111') && !e.includes('6789')); }
  const text = (() => { const q = Mem.buildPrompt(state, 1, { from: WK, to: '2026-11-15' }); return q.system + q.user; })();
  for (const w of ['LEAK', 'in person']) assert.ok(!text.includes(w), 'prompt has ' + w);
});
