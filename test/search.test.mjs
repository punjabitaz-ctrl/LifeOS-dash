// v1.6.0 B18: search across everything. Matching (case, accents, no RegExp, special characters), coverage of every area, the in-memory
// index lifetime (built on unlock, dropped on lock and on private close, never stored), the private vault and Wellbeing rules, and speed at the caps.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L, PASS, memAdapter } from './_load.mjs';
import { fastKeys, realKeys, clone, PRIV } from './_archive.mjs';
import { buildAdversarial, ADV_MARK } from './_adversarial.mjs';

const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), Q = view('search'), P = view('priv'), W = view('wellbeing'), O = view('ops');
const nope = async () => { throw new Error('NO_STORAGE'); };
const NOSTORE = { get: nope, set: nope, del: nope };
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { P.close('system'); } catch (e) { /* closed */ } try { S.lock(); } catch (e) { /* locked */ } S._setAdapter(NOSTORE); realKeys(); } });
const job = (o) => Object.assign({ title: 'Role', org: 'Co', kind: 'job', stage: 'lead', source: '', nextStep: '', updatedAt: '2026-11-01', notes: '' }, o);
async function vault(fn, o = {}) {
  const st = S.defaultState(); if (fn) fn(st);
  S._setAdapter(memAdapter()); S.lock(); await S.init(PASS);
  await S.replaceState(S.validateState(clone(st)));
  if (o.priv) await P.setUp(PRIV);
}
const hits = (q) => Q.query(q).groups.flatMap((g) => g.items.map((i) => g.area + ':' + i.label));

test('matching is plain substring matching: case, accents, composed and full-width forms, invisible characters and spacing are ignored', async () => {
  await vault((s) => { s.projects.push({ id: 'p1', name: 'Café Résumé  Plan', kind: 'venture', status: 'active', nextAction: '', archived: false }); s.pipeline.push(job({ id: 'j1', title: 'Zoë at Ünïcode' })); });
  for (const q of ['cafe', 'CAFÉ', 'café', 'résumé', 'RESUME plan', 'ＣＡＦＥ', 'ca​fe', '  cafe   resume ', 'e re']) assert.deepEqual(hits(q), ['work:Café Résumé  Plan'], q);
  assert.deepEqual(hits('zoe'), ['jobs:Zoë at Ünïcode']); assert.deepEqual(hits('UNICODE'), ['jobs:Zoë at Ünïcode']);
  for (const q of ['', '   ', 'nothing here', 'cafes']) assert.equal(Q.query(q).total, 0, JSON.stringify(q));
  assert.equal(Q.query(undefined).total, 0); assert.equal(Q.query(5).total, 0);
  assert.equal(Q.fold('Ǆ ﬁ'), 'dz fi');
});
test('special characters are literal and no RegExp is built from what is typed', async () => {
  await vault((s) => { for (const [i, n] of ['a.c', 'abc', 'x*y', '(paren', '[brack', 'back\\slash', 'p+q', 'c++', '^start$', 'a|b', 'q?', '$100', '{1,2}'].entries()) s.projects.push({ id: 'p' + i, name: n, kind: 'venture', status: 'active', nextAction: '', archived: false }); });
  const real = globalThis.RegExp; let built = 0;
  globalThis.RegExp = new Proxy(real, { construct(t, a, nt) { built++; return Reflect.construct(t, a, nt); }, apply(t, th, a) { built++; return Reflect.apply(t, th, a); } });
  try {
    const one = (q) => hits(q).map((x) => x.slice(5));
    assert.deepEqual(one('a.c'), ['a.c']); assert.deepEqual(one('.'), ['a.c']); assert.deepEqual(one('x*'), ['x*y']); assert.deepEqual(one('(par'), ['(paren']); assert.deepEqual(one('['), ['[brack']);
    assert.deepEqual(one('\\'), ['back\\slash']); assert.deepEqual(one('p+'), ['p+q']); assert.deepEqual(one('++'), ['c++']); assert.deepEqual(one('^s'), ['^start$']); assert.deepEqual(one('t$'), ['^start$']);
    assert.deepEqual(one('a|b'), ['a|b']); assert.deepEqual(one('q?'), ['q?']); assert.deepEqual(one('$1'), ['$100']); assert.deepEqual(one('{1,'), ['{1,2}']);
    assert.deepEqual(one('.*'), []); assert.deepEqual(one('(?'), []); assert.deepEqual(one('\\d'), []); assert.deepEqual(one('*'), ['x*y']);
    assert.equal(built, 0, 'no RegExp constructed while querying');
  } finally { globalThis.RegExp = real; }
  const src = readFileSync(new URL('../src/core/search.js', import.meta.url), 'utf8');
  assert.ok(!/new RegExp|RegExp\(/.test(src), 'search.js never builds a RegExp');
  assert.ok(!/needle\)?\.(match|test|search|replace|split)\(|\.match\(needle|\.search\(needle/.test(src));
});
test('every area is covered: titles, names, notes and facts, with area labels and navigation keys; results carry ids and collections', async () => {
  const { state } = buildAdversarial(L);
  state.pipeline.push(job({ id: 'jx', title: 'Role at JOBCO', role: 'JOBROLE', stage: 'applied' }));
  await vault(null); await S.replaceState(S.validateState(clone(Object.assign(state, { schema: 21 }))));
  const r = Q.query(ADV_MARK);
  const areas = r.groups.map((g) => g.area);
  for (const a of ['money', 'assets', 'work', 'health', 'goals', 'home', 'admin', 'learning', 'activities', 'social', 'business', 'jobs']) assert.ok(areas.includes(a), 'area ' + a + ' found: ' + areas);
  assert.ok(!areas.includes('wellbeing'), 'a Wellbeing entry in the main state is not searched while the private vault is closed');
  assert.deepEqual(r.groups.map((g) => g.area), Q.ORDER.filter((a) => areas.includes(a)), 'fixed order');
  for (const g of r.groups) { assert.equal(g.label, Q.AREAS[g.area][0]); assert.equal(g.key, Q.AREAS[g.area][1]); for (const i of g.items) { assert.ok(i.label); assert.equal(typeof i.priv, 'boolean'); } }
  assert.deepEqual(Q.query('jobco').groups.map((g) => [g.area, g.key, g.items[0].coll, g.items[0].id]), [['jobs', 'v:jobs', 'pipeline', 'jx']]);
  assert.deepEqual(Q.query('jobrole').groups.map((g) => g.area), ['jobs']);
  // every typed marker is reachable (a fixed list value, id or date is not typed text)
  const missing = []; for (let k = 0; k < 400; k++) { const m = ADV_MARK + k + ' '; if (JSON.stringify(state).includes(m) && !Q.query(m).total) missing.push(k); }
  // Not searched by design: Wellbeing entries (22, 23: only inside the private vault), a document kind (55, a short label) and the business settings (97 to 99, not a collection).
  // (Numbers moved by 2 in the v1.6.0 audit: the fixture gained markers in the job role, 37, and resume label, 38, both of which are found.)
  assert.deepEqual(missing, [22, 23, 55, 97, 98, 99]);
  assert.ok(Q.query(ADV_MARK + '37 ').total && Q.query(ADV_MARK + '38 ').total, 'job role and resume label are searchable');
  const people = Q.query('person name'); assert.ok(people.groups.some((g) => g.area === 'social'));
});
test('facts and important-date labels are searchable; results are capped per area but counted in full', async () => {
  await vault((s) => {
    s.people.push({ id: 'pp', name: 'Pat', importantDates: [{ label: 'Wedding anniversary', monthDay: '06-01' }], pipelineIds: [], projectIds: [], facts: [{ id: 'f1', label: 'Allergy', text: 'Peanuts and shellfish', addedOn: '2026-01-01' }], notes: '', archived: false, createdAt: '2026-01-01T00:00:00.000Z' });
    for (let i = 0; i < 45; i++) s.projects.push({ id: 'q' + i, name: 'Bulk ' + i, kind: 'venture', status: 'active', nextAction: '', archived: false });
  });
  assert.deepEqual(hits('shellfish'), ['social:Pat']); assert.deepEqual(hits('anniversary'), ['social:Pat']);
  const r = Q.query('bulk'); assert.equal(r.total, 45); assert.equal(r.groups[0].count, 45); assert.equal(r.groups[0].items.length, Q.PER_AREA); assert.equal(r.truncated, true);
  assert.equal(Q.query('x'.repeat(500)).q.length, 100);
});
test('index lifetime: built on unlock, rebuilt after a change, dropped on lock, never in storage, history or the address', async () => {
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  assert.ok(Q.isBuilt(), 'built when the vault opens');
  await S.commit((x) => { x.projects.push({ id: 'p1', name: 'SEARCHMARKER alpha', kind: 'venture', status: 'active', nextAction: '', archived: false }); });
  assert.deepEqual(hits('searchmarker'), ['work:SEARCHMARKER alpha'], 'a change shows at the next search');
  await S.commit((x) => { x.projects = []; });
  assert.equal(Q.query('searchmarker').total, 0);
  await S.commit((x) => { x.projects.push({ id: 'p1', name: 'SEARCHMARKER beta', kind: 'venture', status: 'active', nextAction: '', archived: false }); });
  Q.query('searchmarker');
  const raw = JSON.stringify([...ad._m.values()]); assert.ok(!raw.includes('SEARCHMARKER') && !raw.includes('searchmarker'), 'no search text in storage');
  assert.ok(!Object.keys(globalThis).some((k) => /^searchIndex|^_search/i.test(k)));
  S.lock();
  assert.equal(Q.isBuilt(), false, 'dropped on lock');
  assert.equal(Q.query('searchmarker').total, 0, 'a locked vault finds nothing');
  assert.equal(Q.isBuilt(), false, 'a locked query builds nothing');
  const src = readFileSync(new URL('../src/core/search.js', import.meta.url), 'utf8');
  assert.ok(!/localStorage|sessionStorage|indexedDB|history\.|location\.|fetch\(|XMLHttpRequest|console\./.test(src), 'search.js touches no storage, history, address, network or console');
  const ui = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const box = ui.slice(ui.indexOf('function searchBox'), ui.indexOf('// ---------- health (v0.5.0)'));
  assert.ok(!/hist\.|pushState|replaceState|location/.test(box.slice(0, box.indexOf('onclick'))), 'typing touches neither history nor the address');
  await S.unlock(PASS);
  assert.ok(Q.isBuilt(), 'built again on unlock');
});
test('private records and Wellbeing notes are searchable only while the private vault is open, and the index drops on close', async () => {
  await vault((s) => { s.pipeline.push(job({ id: 'pj', title: 'PRIVJOB role', notes: 'secretnote' })); s.projects.push({ id: 'pub', name: 'PUBLICPROJ', kind: 'venture', status: 'active', nextAction: '', archived: false }); }, { priv: true });
  await P.open(PRIV); await P.moveIn('pipeline', 'pj');
  await P.commit((i) => { W.save(i.wellbeing, { date: '2026-11-10', mood: 3, note: 'wellbeingnote text' }); });
  assert.deepEqual(hits('privjob'), ['jobs:PRIVJOB role']); assert.equal(Q.query('privjob').groups[0].items[0].priv, true);
  assert.deepEqual(hits('secretnote'), ['jobs:PRIVJOB role']);
  assert.deepEqual(hits('wellbeingnote'), ['wellbeing:Check-in 2026-11-10']);
  assert.deepEqual(hits('publicproj'), ['work:PUBLICPROJ']); assert.equal(Q.query('publicproj').groups[0].items[0].priv, false);
  assert.ok(Q.hasPrivate());
  P.close('test');
  assert.equal(Q.isBuilt(), false, 'dropped on private close');
  for (const q of ['privjob', 'secretnote', 'wellbeingnote']) assert.equal(Q.query(q).total, 0, q + ' is gone with the vault closed');
  assert.ok(Q.isBuilt() && !Q.hasPrivate(), 'rebuilt from the main state alone');
  assert.deepEqual(hits('publicproj'), ['work:PUBLICPROJ']);
  await P.open(PRIV);
  assert.deepEqual(hits('privjob'), ['jobs:PRIVJOB role'], 'visible again once opened');
  S.lock();
  assert.equal(Q.isBuilt(), false);
  // app lock while open drops everything too
  await S.unlock(PASS);
  assert.equal(Q.query('privjob').total, 0, 'unlocking the app does not open the private vault');
});
test('performance at the caps: 50000 entries and every other collection near its cap build and answer quickly', async () => {
  const s = S.defaultState();
  const mk = (i) => ({ id: 'e' + i, domain: ['money', 'work', 'health', 'learning', 'home', 'social'][i % 6], type: 'note', date: '2026-11-01', title: 'Entry number ' + i + ' café', notes: 'some notes ' + i, createdAt: '2026-11-01T00:00:00.000Z' });
  const st = { entries: Array.from({ length: 50000 }, (_, i) => mk(i)) };
  for (let i = 0; i < 1000; i++) s.pipeline.push(job({ id: 'j' + i, title: 'Job ' + i, notes: 'n' + i }));
  for (let i = 0; i < 1000; i++) s.people.push({ id: 'p' + i, name: 'Person ' + i, importantDates: [], pipelineIds: [], projectIds: [], facts: Array.from({ length: 5 }, (_, k) => ({ id: 'f' + i + '_' + k, label: 'L' + k, text: 'fact ' + k + ' of ' + i, addedOn: '2026-01-01' })), notes: '', archived: false, createdAt: '2026-01-01T00:00:00.000Z' });
  await vault(null);
  const live = S.getState(); live.pipeline = s.pipeline; live.people = s.people;
  live.entries = st.entries.map((e) => ({ id: e.id, domain: e.domain, type: e.type, date: e.date, title: e.title, notes: e.notes, createdAt: e.createdAt }));
  Q.invalidate();
  const t0 = Date.now(); Q.build(); const tb = Date.now() - t0;
  const t1 = Date.now(); const r = Q.query('café'); const t2 = Date.now() - t1;
  assert.equal(r.total, 50000); assert.ok(r.groups.length >= 4);
  assert.ok(tb < 5000, 'build ' + tb + ' ms'); assert.ok(t2 < 1500, 'query ' + t2 + ' ms');
  const t3 = Date.now(); assert.equal(Q.query('fact 3 of 777').total, 1); assert.ok(Date.now() - t3 < 1500);
});
