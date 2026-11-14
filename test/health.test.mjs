// v0.5.0 Health: schema 4, body metrics, workouts, training cycle, sleep, daily checks, project delete, guards, privacy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { L, memAdapter, PASS, E } from './_load.mjs';
// store.test.mjs asserts that no storage adapter exists yet. These tests install one, so register them after it
// (test/index.js loads files concurrently; a slow import here, like money.test.mjs has, keeps that order).
await import('../build.mjs');

// v020.test.mjs evals the built bundle, which replaces L.store, L.metrics and friends. Resolve them on every use so a test
// never mixes an old store with a new sync module, whatever order the files load in.
const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), M = live('metrics'), V = live('vault'), Mem = live('memory');
const TODAY = '2026-11-12';          // a Thursday; its week starts 2026-11-09
const WK = '2026-11-09';
const clone = (x) => JSON.parse(JSON.stringify(x));
const proj = (o) => Object.assign({ id: 'p-' + Math.random().toString(36).slice(2), name: 'Proj', kind: 'job', status: 'active', nextAction: '', archived: false }, o);
const outcome = (o) => E(Object.assign({ domain: 'work', type: 'outcome', date: TODAY, status: 'todo' }, o));
const H = (type, date, value, extra) => E(Object.assign({ domain: 'health', type, date, value }, extra));
const W = (date, value) => H('weight', date, value, { title: 'Weight' });
function build(fn) { const s = S.defaultState(); fn(s); return S.validateState(clone(s)); }
const NEW_FIELDS = ['cycle', 'kinds', 'habits', 'habitLog'];
function asSchema(n, s) {
  const o = clone(s); o.schema = n;
  if (n < 4) { for (const k of NEW_FIELDS) delete o[k]; delete o.settings.health; }
  if (n < 3) { delete o.projects; delete o.pipeline; }
  if (n < 2) { for (const k of ['accounts', 'recurring', 'budgets', 'categories']) delete o[k]; }
  return o;
}
function legacyBase() {
  const s = S.defaultState();
  s.entries.push(E({ domain: 'health', type: 'workout', date: '2026-11-10', title: 'Old run' }), E({ domain: 'health', type: 'weight', date: '2026-11-10', title: 'w', value: 190 }),
    E({ domain: 'health', type: 'sleep', date: '2026-11-10', title: 's', value: 7 }), E({ domain: 'assets', type: 'balance', date: '2026-11-10', title: 'Checking', value: 100 }));
  s.memory.lessons.push({ id: 'l1', text: 'lesson', createdAt: 1 });
  return s;
}

// ---- migrations ----
test('schema 1, 2 and 3 migrate to 4 with no data loss and sensible health defaults', () => {
  const base = legacyBase();
  base.accounts.push({ id: 'a1', name: 'Checking', kind: 'cash', liability: false, archived: false });
  base.projects.push(proj({ id: 'p1', name: 'Alpha' }));
  base.pipeline.push({ id: 'i1', title: 'Role', org: '', kind: 'job', stage: 'lead', source: '', nextStep: '', updatedAt: TODAY, notes: '' });
  base.entries.push(outcome({ title: 'Linked', projectId: 'p1' }));
  for (const n of [1, 2, 3]) {
    const src = asSchema(n, base);
    if (n === 1) src.entries = src.entries.filter((e) => e.type !== 'outcome');   // schema 1 has no project links
    const m = S.validateState(clone(src));
    assert.equal(m.schema, 9);
    assert.deepEqual(m.entries.map((e) => e.title), src.entries.map((e) => e.title));
    assert.equal(m.entries.find((e) => e.title === 'w').value, 190);
    assert.deepEqual(m.memory, src.memory);
    assert.equal(m.cycle, null); assert.deepEqual(m.habits, []); assert.deepEqual(m.habitLog, []);
    assert.deepEqual(m.kinds, M.DEFAULT_KINDS); assert.deepEqual(m.settings.health, { units: 'lb' });
    assert.equal(M.headline(m, 'health', TODAY).display, '1 of 4'.replace('1', '1'));
    if (n >= 3) { assert.equal(m.projects[0].name, 'Alpha'); assert.equal(m.pipeline[0].title, 'Role'); assert.equal(m.entries.find((e) => e.title === 'Linked').projectId, 'p1'); }
    if (n === 2) assert.equal(m.accounts[0].name, 'Checking');
    assert.deepEqual(S.validateState(clone(m)), m, 'idempotent');
  }
  // Health keys smuggled into an older format are ignored, not trusted.
  const sneaky = asSchema(3, base); sneaky.cycle = { startDate: '2026-01-05', sprintDays: 7, sprintsPerCycle: 1, restDays: 0, alternateHeavyLight: false, firstWeek: 'heavy' }; sneaky.habits = [{ id: 'h', name: 'x' }];
  const m = S.validateState(sneaky); assert.equal(m.cycle, null); assert.deepEqual(m.habits, []);
});
test('migration is persisted on unlock of stored schema 1, 2 and 3 vaults', async () => {
  for (const n of [1, 2, 3]) {
    const ad = memAdapter(); S._setAdapter(ad); S.lock();
    const salt = V.newSalt(), key = await V.deriveKey(PASS, salt);
    const src = asSchema(n, legacyBase()); if (n === 1) src.entries = src.entries.filter((e) => e.domain !== 'work');
    ad._m.set('envelope', await V.makeEnvelope(key, salt, src));
    const st = await S.unlock(PASS);
    assert.equal(st.schema, 9); assert.equal(st.entries.length, 4);
    await S.commit((x) => { M.addHabit(x, 'Mobility'); });
    const raw = await V.decrypt(key, ad._m.get('envelope'));
    assert.equal(raw.schema, 9); assert.equal(raw.habits.length, 1); assert.equal(raw.entries.length, 4);
    S.lock();
  }
});
test('a v0.4.0 (schema 3) backup imports cleanly and carries work data', async () => {
  const s = asSchema(3, build((x) => { x.projects.push(proj({ id: 'p1', name: 'Alpha' })); x.entries.push(E({ domain: 'health', type: 'weight', value: 180 })); }));
  const salt = V.newSalt(), key = await V.deriveKey(PASS, salt);
  const got = await V.importBackup(PASS, JSON.stringify(await V.makeEnvelope(key, salt, s)));
  assert.equal(got.schema, 9); assert.equal(got.sourceSchema, 3); assert.equal(got.projects[0].name, 'Alpha'); assert.equal(got.entries.length, 1);
  assert.deepEqual(got.habits, []); assert.ok(!JSON.stringify(got).includes('sourceSchema'));
  // A schema 4 backup round trips the new collections.
  const s4 = build((x) => { M.addHabit(x, 'H1'); x.cycle = { startDate: '2026-01-05', sprintDays: 14, sprintsPerCycle: 2, restDays: 7, alternateHeavyLight: true, firstWeek: 'light' }; x.kinds.push('sled'); x.settings.health = { units: 'kg', weightTarget: 80 }; });
  s4.habitLog.length = 0;
  const back = await V.importBackup(PASS, await V.exportBackup(PASS, s4));
  assert.deepEqual([back.cycle, back.kinds, back.habits, back.settings.health], [s4.cycle, s4.kinds, s4.habits, s4.settings.health]);
});

// ---- downgrade guards (SEC-27 / SEC-28 extended to schema 4) ----
const TOKEN = 'ya29.SECRETTOKENVALUE_v050_abcdefghij';
function drive() {
  const d = { file: null, version: 1, etag: '"e1"', writes: 0 };
  const res = (status, body, headers = {}) => ({ status, ok: status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  d.put = (text) => { d.file = { id: 'file12345', text }; d.version++; d.etag = '"e' + d.version + '"'; };
  d.fetch = async (url, o) => {
    const u = new URL(url);
    if (u.pathname === '/drive/v3/files') return res(200, { files: d.file ? [{ id: d.file.id, size: String(d.file.text.length), version: String(d.version) }] : [] });
    if (u.searchParams.get('alt') === 'media') return res(200, d.file.text, { etag: d.etag });
    if (u.pathname.startsWith('/drive/v3/files/')) return res(200, { id: d.file.id, version: String(d.version) });
    d.writes++;
    if (o.method === 'POST') { d.put(o.body.split('Content-Type: application/json\r\n\r\n')[1].split('\r\n--')[0]); return res(200, { id: 'file12345' }); }
    if (o.method === 'PATCH') { d.put(o.body); return res(200, { id: 'file12345' }); }
    return res(500, 'x');
  };
  return d;
}
async function fresh() {
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  const d = drive(); L.sync._setFetch(d.fetch); L.sync._setToken(TOKEN, 3600);
  return { ad, d };
}
async function putRemote(d, content, bump) {
  const env1 = JSON.parse(d.file.text);
  const salt = V.parseEnvelope(env1).salt, key = await V.deriveKey(PASS, salt);
  const raw = await V.decrypt(key, env1);
  const m = { rev: env1.rev + bump, updatedAt: '2026-11-12T00:00:00.000Z', deviceId: 'other-device' };
  d.put(JSON.stringify(Object.assign(await V.makeEnvelope(key, salt, Object.assign(content, { settings: raw.settings, _meta: m })), m)));
}
const CYCLE = { startDate: '2026-01-05', sprintDays: 14, sprintsPerCycle: 2, restDays: 7, alternateHeavyLight: true, firstWeek: 'heavy' };
const CASES = {
  'training cycle': (x) => { x.cycle = clone(CYCLE); },
  'daily checks': (x) => { M.addHabit(x, 'Protein'); },
  'workout types': (x) => { x.kinds.push('sled'); },
  'body targets and units': (x) => { x.settings.health.weightTarget = 170; },
};
test('schema 4 data is protected from older-format backups on restore, and every collection is named', async () => {
  const schema3 = () => asSchema(3, S.defaultState());
  for (const [name, mutate] of Object.entries(CASES)) {
    const { ad } = await fresh();
    await S.commit(mutate);
    const salt = V.newSalt(), key = await V.deriveKey(PASS, salt);
    const bk = await V.importBackup(PASS, JSON.stringify(await V.makeEnvelope(key, salt, schema3())));
    assert.equal(bk.sourceSchema, 3);
    assert.deepEqual(S.droppedData(S.getState(), bk), [name]);
    const before = JSON.stringify(ad._m.get('envelope'));
    await assert.rejects(S.replaceState(bk), (e) => e.code === 'OLDER_FORMAT' && e.message.includes(name) && /Nothing was replaced/.test(e.message));
    await assert.rejects(S.replaceState(Mem.demoteApproved(bk)), (e) => e.code === 'OLDER_FORMAT');
    await assert.rejects(S.replaceState(bk, { allowWorkLoss: 'yes' }), (e) => e.code === 'OLDER_FORMAT');
    assert.equal(JSON.stringify(ad._m.get('envelope')), before, 'stored vault untouched');
    await S.replaceState(bk, { allowWorkLoss: true });
    assert.equal(S.getState().schema, 9); assert.equal(S.getState().cycle, null); assert.deepEqual(S.getState().habits, []); assert.deepEqual(S.getState().kinds, M.DEFAULT_KINDS);
  }
  // Nothing to lose, nothing flagged: defaults, an older backup into an empty vault, and a schema 4 backup over health data.
  const { } = await fresh();
  const salt = V.newSalt(), key = await V.deriveKey(PASS, salt);
  const old = await V.importBackup(PASS, JSON.stringify(await V.makeEnvelope(key, salt, schema3())));
  await S.replaceState(old);
  await S.commit(CASES['daily checks']);
  const same = await V.importBackup(PASS, await V.exportBackup(PASS, S.getState()));
  await S.replaceState(same);
  assert.equal(S.getState().habits.length, 1);
  // A schema 3 backup that still has work data does not hide the lost health data, and both are named together.
  await S.commit((x) => { x.projects.push(proj({ id: 'px', name: 'P' })); x.cycle = clone(CYCLE); });
  const t = S.getState();
  const s2 = await V.importBackup(PASS, JSON.stringify(await V.makeEnvelope(key, salt, asSchema(2, S.defaultState()))));
  assert.equal(S.lossText(t, s2), '1 projects, your training cycle and 1 daily checks');
  assert.equal(S.lossText(t, old), 'your training cycle and 1 daily checks');
});
test('schema 4 data is protected from an older (schema 3) Drive copy in a download offer and a conflict', async () => {
  const { ad, d } = await fresh();
  await S.commit(CASES['daily checks']);
  await S.commit(CASES['training cycle']);
  await L.sync.run();
  await putRemote(d, asSchema(3, S.defaultState()), 3);
  const dec = await L.sync.run();
  assert.equal(dec.kind, 'download-offer'); assert.equal(dec.dropsWork, true);
  assert.deepEqual(dec.dropped, ['training cycle', 'daily checks'].sort((a, b) => ['training cycle', 'daily checks'].indexOf(a) - ['training cycle', 'daily checks'].indexOf(b)));
  assert.deepEqual([dec.remote.schema, dec.local.schema, dec.local.habits, dec.local.cycle], [3, 9, 1, true]);
  const before = JSON.stringify(ad._m.get('envelope')), w = d.writes;
  await assert.rejects(L.sync.apply(dec, 'download'), (e) => e.code === 'OLDER_FORMAT' && /daily checks/.test(e.message) && /training cycle/.test(e.message) && /Nothing was replaced/.test(e.message));
  await assert.rejects(L.sync.apply(dec, 'download', { allowWorkLoss: 1 }), (e) => e.code === 'OLDER_FORMAT');
  assert.equal(JSON.stringify(ad._m.get('envelope')), before); assert.equal(d.writes, w);
  assert.equal(S.getState().habits.length, 1);
  await L.sync.apply(dec, 'download', { allowWorkLoss: true });
  assert.equal(S.getState().habits.length, 0); assert.equal(S.getState().schema, 9);
  // Conflict: keeping this device is never blocked; choosing the older copy is, and a copy is saved first.
  const f = await fresh();
  await L.sync.run();
  await putRemote(f.d, asSchema(3, S.defaultState()), 2);
  await S.commit((x) => { x.entries.push(W('2026-11-10', 190)); });
  const c0 = await L.sync.run();
  assert.equal(c0.kind, 'conflict'); assert.equal(c0.dropsWork, false, 'no health collections yet, nothing to lose');
  await S.commit(CASES['workout types']);
  const c = await L.sync.run();
  assert.equal(c.dropsWork, true); assert.deepEqual(c.dropped, ['workout types']);
  await assert.rejects(L.sync.apply(c, 'remote', { saveBackup: async () => {} }), (e) => e.code === 'OLDER_FORMAT');
  assert.equal((await L.sync.apply(c, 'local', { saveBackup: async () => {} })).kind, 'uploaded');
  assert.deepEqual((await V.importBackup(PASS, f.d.file.text)).kinds.slice(-1), ['sled']);
  // A schema 3 remote is not flagged when this device has no schema 4 data and a schema 4 remote never is.
  const g = await fresh();
  await L.sync.run();
  await putRemote(g.d, asSchema(3, S.defaultState()), 2);
  assert.equal((await L.sync.run()).dropsWork, false);
});
test('a newer schema 5 is refused by unlock, backup import and sync, and nothing is written', async () => {
  const { ad, d } = await fresh();
  await S.commit(CASES['daily checks']);
  await L.sync.run();
  await putRemote(d, Object.assign(clone(S.getState()), { schema: 10 }), 1);
  const remote = d.file.text, w = d.writes, before = JSON.stringify(ad._m.get('envelope'));
  await assert.rejects(L.sync.run(), (e) => e.code === 'REMOTE_INVALID');
  assert.equal(d.file.text, remote); assert.equal(d.writes, w); assert.equal(JSON.stringify(ad._m.get('envelope')), before);
  const salt = V.newSalt(), key = await V.deriveKey(PASS, salt);
  await assert.rejects(V.importBackup(PASS, JSON.stringify(await V.makeEnvelope(key, salt, Object.assign(clone(S.getState()), { schema: 10 })))), /schema/);
  assert.throws(() => S.validateState(Object.assign(S.defaultState(), { schema: 10 })), /schema/);
});

// ---- project delete (SEC-31) ----
test('deleting a project keeps its outcomes and unlinks them; other links are untouched', async () => {
  await fresh();
  await S.commit((x) => {
    x.projects.push(proj({ id: 'p1', name: 'A' }), proj({ id: 'p2', name: 'B' }));
    x.entries.push(outcome({ title: 'o1', projectId: 'p1' }), outcome({ title: 'o2', projectId: 'p1', status: 'done' }), outcome({ title: 'o3', projectId: 'p2' }), outcome({ title: 'o4' }));
  });
  const s = S.getState();
  assert.equal(M.linkedOutcomeCount(s, 'p1'), 2); assert.equal(M.linkedOutcomeCount(s, 'p2'), 1);
  const before = M.headline(s, 'work', TODAY).display;
  let n;
  await S.commit((x) => { n = M.deleteProject(x, 'p1'); });
  assert.equal(n, 2);
  const t = S.getState();
  assert.deepEqual(t.projects.map((p) => p.id), ['p2']);
  assert.deepEqual(t.entries.filter((e) => e.type === 'outcome').map((e) => [e.title, e.projectId]).sort(), [['o1', undefined], ['o2', undefined], ['o3', 'p2'], ['o4', undefined]]);
  assert.equal(t.entries.find((e) => e.title === 'o2').status, 'done');
  assert.equal(M.headline(t, 'work', TODAY).display, before, 'outcome counts unchanged');
  await assert.rejects(S.commit((x) => { M.deleteProject(x, 'nope'); }), /not found/);
  assert.equal(S.getState().projects.length, 1, 'failed delete rolled back');
});
test('archived projects do not count toward the 200 cap; a total cap still bounds the list', () => {
  const many = (live, arch) => build((x) => {
    for (let i = 0; i < live; i++) x.projects.push(proj({ id: 'l' + i }));
    for (let i = 0; i < arch; i++) x.projects.push(proj({ id: 'a' + i, archived: true }));
  });
  assert.equal(many(200, 0).projects.length, 200);
  assert.equal(many(200, 300).projects.length, 500);
  assert.equal(many(200, 1800).projects.length, 2000);
  assert.throws(() => many(201, 0), /too many/);
  assert.throws(() => many(201, 100), /too many/);
  assert.throws(() => many(200, 1801), /too many/);
  // Archiving one makes room for another live project.
  const s = many(200, 0); s.projects[0].archived = true; s.projects.push(proj({ id: 'new' }));
  assert.equal(S.validateState(clone(s)).projects.length, 201);
});

// ---- body metrics ----
const SERIES = [['2026-10-01', 200], ['2026-10-15', 198], ['2026-10-29', 196], ['2026-11-05', 195], ['2026-11-12', 194]];
const withWeights = (extra) => build((x) => { for (const [d, v] of SERIES) x.entries.push(W(d, v)); extra && extra(x); });
test('moving average uses the last 7 entries, with a shorter window at the start', () => {
  assert.deepEqual(M.movingAverage([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 7), [1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7]);
  assert.deepEqual(M.movingAverage([]), []);
  assert.deepEqual(M.bodySeries(withWeights(), 'weight').map((p) => p.avg), [200, 199, 198, 197.25, 196.6]);
  assert.throws(() => M.bodySeries(withWeights(), 'sleep'));
});
test('weekly rate, latest and progress to target (lb)', () => {
  const m = M.bodyMetrics(withWeights((x) => { x.settings.health.weightStart = 210; x.settings.health.weightTarget = 180; }), 'weight', TODAY);
  assert.equal(m.unit, 'lb'); assert.equal(m.latest, 194); assert.equal(m.avg, 196.6); assert.equal(m.count, 5);
  assert.equal(m.weeklyRate, -1, '(194 - 198) / 28 days * 7, window starts 2026-10-15');
  assert.equal(m.progressPct, 53.3, '(210 - 194) / (210 - 180)'); assert.equal(m.toTarget, -14);
  // Start defaults to the first entry; progress is clamped to 0..100.
  const d = M.bodyMetrics(withWeights((x) => { x.settings.health.weightTarget = 180; }), 'weight', TODAY);
  assert.equal(d.start, 200); assert.equal(d.progressPct, 30);
  assert.equal(M.bodyMetrics(withWeights((x) => { x.settings.health.weightStart = 190; x.settings.health.weightTarget = 180; }), 'weight', TODAY).progressPct, 0);
  assert.equal(M.bodyMetrics(withWeights((x) => { x.settings.health.weightTarget = 195; }), 'weight', TODAY).progressPct, 100);
  assert.equal(M.bodyMetrics(withWeights((x) => { x.settings.health.weightStart = 180; x.settings.health.weightTarget = 180; }), 'weight', TODAY).progressPct, null);
  // Gaining toward a higher target works the same way.
  const g = M.bodyMetrics(build((x) => { x.entries.push(W('2026-11-01', 150), W('2026-11-12', 155)); x.settings.health.weightTarget = 160; }), 'weight', TODAY);
  assert.equal(g.progressPct, 50); assert.equal(g.toTarget, 5);
  // Fewer than two entries in the window, or none at all.
  assert.equal(M.bodyMetrics(build((x) => { x.entries.push(W('2026-09-01', 150), W('2026-11-12', 149)); }), 'weight', TODAY).weeklyRate, null);
  const none = M.bodyMetrics(build(() => {}), 'weight', TODAY);
  assert.deepEqual([none.count, none.latest, none.avg, none.weeklyRate, none.progressPct], [0, null, null, null, null]);
  // Entries after today are ignored.
  assert.equal(M.bodyMetrics(withWeights((x) => { x.entries.push(W('2026-11-20', 150)); }), 'weight', TODAY).latest, 194);
});
test('kilograms: same maths, conversion and a unit switch that converts entries and targets', () => {
  const kg = build((x) => {
    x.settings.health = { units: 'kg', weightStart: 92, weightTarget: 80 };
    x.entries.push(W('2026-11-01', 90), W('2026-11-08', 89), W('2026-11-12', 88));
  });
  const m = M.bodyMetrics(kg, 'weight', TODAY);
  assert.equal(m.unit, 'kg'); assert.equal(m.latest, 88); assert.equal(m.avg, 89);
  assert.equal(m.weeklyRate, -1.27, '(88 - 90) / 11 days * 7'); assert.equal(m.progressPct, 33.3);
  assert.equal(M.convertWeight(220, 'lb', 'kg'), 99.8); assert.equal(M.convertWeight(100, 'kg', 'lb'), 220.5); assert.equal(M.convertWeight(5, 'kg', 'kg'), 5);
  assert.throws(() => M.convertWeight(1, 'lb', 'stone'));
  const lb = build((x) => { x.settings.health = { units: 'lb', weightStart: 220, weightTarget: 200, bodyFatTarget: 15 }; x.entries.push(W('2026-11-12', 220), H('bodyfat', '2026-11-12', 20, { title: 'bf' })); });
  M.setWeightUnits(lb, 'kg');
  assert.deepEqual([lb.settings.health.units, lb.settings.health.weightStart, lb.settings.health.weightTarget, lb.settings.health.bodyFatTarget], ['kg', 99.790321, 90.718474, 15]);
  assert.equal(lb.entries.find((e) => e.type === 'weight').value, 99.790321); assert.equal(lb.entries.find((e) => e.type === 'bodyfat').value, 20);
  assert.doesNotThrow(() => S.validateState(clone(lb)));
  assert.throws(() => M.setWeightUnits(lb, 'stone'));
  assert.equal(M.bodyMetrics(build((x) => { x.entries.push(H('bodyfat', '2026-11-12', 21.5, { title: 'b' })); }), 'bodyfat', TODAY).unit, '%');
});

// ---- workouts ----
const trainingWeek = () => build((x) => {
  x.entries.push(
    H('workout', '2026-11-09', undefined, { title: 'a', kind: 'strength', minutes: 45, effort: 8 }), H('workout', '2026-11-10', undefined, { title: 'b', kind: 'kettlebell', minutes: 30 }),
    H('workout', '2026-11-11', undefined, { title: 'c', kind: 'strength', minutes: 60, effort: 6 }), H('workout', '2026-11-12', undefined, { title: 'd' }),
    H('workout', '2026-11-15', undefined, { title: 'e', kind: 'cardio', minutes: 20 }),
    H('workout', '2026-11-08', undefined, { title: 'prev', kind: 'strength', minutes: 12 }), H('workout', '2026-11-16', undefined, { title: 'next', kind: 'strength', minutes: 99 }));
  x.cycle = { startDate: '2026-11-02', sprintDays: 14, sprintsPerCycle: 2, restDays: 7, alternateHeavyLight: true, firstWeek: 'heavy' };
});
test('workout entries carry kind, minutes and effort with validation; old workouts still load', () => {
  const e = H('workout', '2026-11-10', undefined, { kind: ' mace and clubs ', minutes: '45', effort: 7 });
  assert.deepEqual([e.kind, e.minutes, e.effort], ['mace and clubs', 45, 7]);
  assert.equal(H('workout', '2026-11-10', undefined, {}).kind, undefined);
  assert.equal(E({ domain: 'health', type: 'workout', kind: 'x', minutes: 0 }).minutes, 0);
  for (const bad of [{ minutes: -1 }, { minutes: 1441 }, { minutes: 'abc' }, { effort: 0 }, { effort: 11 }, { effort: 5.5 }, { kind: 'k'.repeat(41) }, { kind: 5 }]) assert.throws(() => H('workout', '2026-11-10', undefined, bad), /must be/);
  assert.throws(() => H('weight', '2026-11-10', 1001, {})); assert.throws(() => H('bodyfat', '2026-11-10', 101, {})); assert.throws(() => H('sleep', '2026-11-10', 25, {}));
  assert.equal(H('sleep', '2026-11-10', 7.5, {}).value, 7.5);
  const csv = L.csv.exportEntries([H('workout', '2026-11-10', undefined, { kind: '=cmd()', minutes: 5 })]);
  assert.ok(csv.includes('"\'=cmd()"')); assert.ok(csv.split('\r\n')[0].includes('"kind","minutes","effort"'));
});
test('week view: sessions vs target, minutes, mix by kind and week numbers', () => {
  const s = trainingWeek(), w = M.workoutWeek(s, WK);
  assert.equal(w.sessions, 5); assert.equal(w.target, 4); assert.equal(w.minutes, 155);
  assert.deepEqual(w.mix, [{ kind: 'strength', count: 2, minutes: 105 }, { kind: 'kettlebell', count: 1, minutes: 30 }, { kind: 'cardio', count: 1, minutes: 20 }, { kind: 'untyped', count: 1, minutes: 0 }]);
  assert.equal(w.isoWeek, 46); assert.equal(w.cycleWeek, 2);
  assert.equal(M.workoutWeek(s, '2026-11-11').weekStart, WK, 'any date in the week works');
  assert.equal(M.workoutWeek(s, '2026-11-02').cycleWeek, 1); assert.equal(M.workoutWeek(s, '2026-10-26').cycleWeek, 0);
  assert.equal(M.workoutWeek(build(() => {}), WK).cycleWeek, null);
  assert.deepEqual([M.workoutWeek(s, '2026-11-02').sessions, M.workoutWeek(s, '2026-11-16').sessions], [1, 1]);
  assert.deepEqual([M.isoWeek('2026-01-01'), M.isoWeek('2024-12-30'), M.isoWeek('2027-01-01'), M.isoWeek('2026-12-28'), M.isoWeek('2026-11-15')], [1, 1, 53, 53, 46]);
  assert.deepEqual([M.weekNumber('2026-11-02', '2026-11-02'), M.weekNumber('2026-11-08', '2026-11-02'), M.weekNumber('2026-11-09', '2026-11-02'), M.weekNumber('2026-11-01', '2026-11-02')], [1, 1, 2, 0]);
  assert.throws(() => M.isoWeek('nope'));
});

// ---- training cycle ----
test('training cycle: sprint, day, heavy or light, rest period, days to rest', () => {
  const at = (d, c) => M.trainingCycle(c || CYCLE, d);
  const pick = (c) => [c.phase, c.sprint, c.dayInSprint, c.week, c.daysToRest, c.cycleNumber];
  assert.deepEqual(pick(at('2026-01-05')), ['sprint', 1, 1, 'heavy', 28, 1]);
  assert.deepEqual(pick(at('2026-01-11')), ['sprint', 1, 7, 'heavy', 22, 1]);
  assert.deepEqual(pick(at('2026-01-12')), ['sprint', 1, 8, 'light', 21, 1]);
  assert.deepEqual(pick(at('2026-01-18')), ['sprint', 1, 14, 'light', 15, 1], 'last day of sprint 1');
  assert.deepEqual(pick(at('2026-01-19')), ['sprint', 2, 1, 'heavy', 14, 1], 'sprint boundary: alternation continues (week 3 is heavy)');
  assert.deepEqual(pick(at('2026-02-01')), ['sprint', 2, 14, 'light', 1, 1], 'last training day');
  const r1 = at('2026-02-02'), r7 = at('2026-02-08');
  assert.deepEqual([r1.phase, r1.restDay, r1.daysToRest, r1.daysToTraining, r1.week, r1.sprint], ['rest', 1, 0, 7, null, 0]);
  assert.deepEqual([r7.phase, r7.restDay, r7.daysToTraining], ['rest', 7, 1]);
  assert.deepEqual(pick(at('2026-02-09')), ['sprint', 1, 1, 'heavy', 28, 2], 'a new cycle restarts at heavy');
  assert.deepEqual(pick(at('2026-03-16')), ['sprint', 1, 1, 'heavy', 28, 3]);
  // Before the start.
  const b = at('2026-01-04'); assert.deepEqual([b.phase, b.daysToStart, b.sprint, b.week, b.daysToRest], ['before', 1, 0, null, null]);
  assert.equal(at('2025-01-05').daysToStart, 365);
  // First week light, no alternation, no rest days, a one-day sprint.
  assert.equal(at('2026-01-05', Object.assign({}, CYCLE, { firstWeek: 'light' })).week, 'light');
  assert.equal(at('2026-01-12', Object.assign({}, CYCLE, { firstWeek: 'light' })).week, 'heavy');
  assert.equal(at('2026-01-12', Object.assign({}, CYCLE, { alternateHeavyLight: false })).week, null);
  const nr = Object.assign({}, CYCLE, { restDays: 0 });
  assert.deepEqual(pick(at('2026-02-02', nr)), ['sprint', 1, 1, 'heavy', null, 2]);
  const one = { startDate: '2026-01-05', sprintDays: 1, sprintsPerCycle: 3, restDays: 1, alternateHeavyLight: true, firstWeek: 'heavy' };
  assert.deepEqual([at('2026-01-07', one).sprint, at('2026-01-08', one).phase, at('2026-01-09', one).cycleNumber], [3, 'rest', 2]);
  assert.throws(() => M.trainingCycle(null, TODAY)); assert.throws(() => M.trainingCycle(CYCLE, 'x'));
  // Labels and the dashboard tile sub line.
  assert.equal(M.cycleLabel(at('2026-01-05')), 'Sprint 1 of 2, day 1 of 14, heavy week');
  assert.equal(M.cycleLabel(at('2026-02-03')), 'Rest period, day 2 of 7');
  assert.equal(M.cycleLabel(at('2026-01-04')), 'Cycle starts in 1 day');
  assert.equal(M.cycleLabel(M.trainingCycle(Object.assign({}, CYCLE, { alternateHeavyLight: false }), '2026-01-05')), 'Sprint 1 of 2, day 1 of 14');
  const s = build((x) => { x.cycle = clone(CYCLE); });
  assert.equal(M.headline(s, 'health', '2026-01-07').sub, '4 to go. Sprint 1 of 2, day 3 of 14, heavy week');
  assert.equal(M.headline(build(() => {}), 'health', '2026-01-07').sub, '4 to go');
});

// ---- sleep ----
test('sleep: 7-day average, previous week and a 14 night series', () => {
  const s = build((x) => { for (const [d, v] of [['2026-11-06', 6], ['2026-11-08', 7], ['2026-11-10', 8], ['2026-11-12', 9], ['2026-11-10', 7], ['2026-11-05', 4], ['2026-11-02', 8], ['2026-10-30', 6.5]]) x.entries.push(H('sleep', d, v, { title: 's' })); });
  const z = M.sleepSummary(s, TODAY);
  assert.equal(z.avg7, 7.4, '(6+7+8+9+7)/5 over 2026-11-06..2026-11-12'); assert.equal(z.nights7, 5);
  assert.equal(z.prevAvg7, 6.17, '(4+8+6.5)/3 over 2026-10-30..2026-11-05'); assert.equal(z.delta, 1.23);
  assert.equal(z.series.length, 14); assert.equal(z.series[13].date, TODAY); assert.equal(z.series[13].value, 9); assert.equal(z.series[12].value, null);
  assert.equal(z.series.find((p) => p.date === '2026-11-10').value, 7.5, 'two entries on a night average');
  const e = M.sleepSummary(build(() => {}), TODAY);
  assert.deepEqual([e.avg7, e.nights7, e.prevAvg7, e.delta], [null, 0, null, null]);
});

// ---- daily checks ----
function withHabits() {
  return build((x) => {
    x.habits = [{ id: 'h1', name: 'Protein' }, { id: 'h2', name: 'Mobility' }];
    for (const d of ['2026-11-12', '2026-11-11', '2026-11-10', '2026-11-08', '2026-11-05']) x.habitLog.push({ habitId: 'h1', date: d });
    x.habitLog.push({ habitId: 'h2', date: TODAY });
  });
}
test('habit completion rate and streak', () => {
  const s = withHabits();
  assert.deepEqual(M.habitStats(s, 'h1', TODAY), { checks7: 4, rate7: 57.1, streak: 3, doneToday: true });
  assert.deepEqual(M.habitStats(s, 'h2', TODAY), { checks7: 1, rate7: 14.3, streak: 1, doneToday: true });
  const nt = clone(s); nt.habitLog = nt.habitLog.filter((x) => !(x.habitId === 'h1' && x.date === TODAY));
  assert.deepEqual(M.habitStats(nt, 'h1', TODAY), { checks7: 3, rate7: 42.9, streak: 2, doneToday: false }, 'streak counts from yesterday until today is ticked');
  assert.equal(M.habitStats(s, 'h1', '2026-11-10').streak, 1, 'a gap on 2026-11-09 ends the streak');
  assert.equal(M.habitStats(s, 'h1', '2026-11-09').streak, 1, 'untouched today: counted from yesterday');
  assert.equal(M.habitStats(s, 'h1', '2026-11-07').streak, 0);
  assert.equal(M.habitRate(s, '2026-11-06', TODAY), 35.7, '(4 + 1) / (2 habits * 7 days)');
  assert.equal(M.habitRate(s, WK, '2026-11-15'), 28.6, '(3 + 1) / 14');
  assert.equal(M.habitRate(build(() => {}), WK, '2026-11-15'), 0);
  assert.deepEqual(M.habitStats(s, 'missing', TODAY), { checks7: 0, rate7: 0, streak: 0, doneToday: false });
});
test('habits: add, tick, untick, delete, and the cap of 8', async () => {
  await fresh();
  let h;
  await S.commit((x) => { h = M.addHabit(x, '  Protein target  '); });
  assert.equal(S.getState().habits[0].name, 'Protein target');
  await S.commit((x) => { assert.equal(M.toggleHabit(x, h.id, TODAY), true); });
  assert.equal(S.getState().habitLog.length, 1);
  await S.commit((x) => { assert.equal(M.toggleHabit(x, h.id, TODAY), false); });
  assert.equal(S.getState().habitLog.length, 0);
  await S.commit((x) => { M.toggleHabit(x, h.id, TODAY); M.toggleHabit(x, h.id, '2026-11-11'); });
  await S.commit((x) => { M.deleteHabit(x, h.id); });
  assert.deepEqual([S.getState().habits.length, S.getState().habitLog.length], [0, 0]);
  await S.commit((x) => { for (let i = 0; i < 8; i++) M.addHabit(x, 'h' + i); });
  await assert.rejects(S.commit((x) => { M.addHabit(x, 'ninth'); }), /up to 8/);
  assert.equal(S.getState().habits.length, 8);
  await assert.rejects(S.commit((x) => { M.addHabit(x, ''); }), /1 to 60/);
  await assert.rejects(S.commit((x) => { M.addHabit(x, 'x'.repeat(61)); }), /1 to 60/);
  await assert.rejects(S.commit((x) => { M.toggleHabit(x, 'nope', TODAY); }), /not found/);
  await assert.rejects(S.commit((x) => { M.toggleHabit(x, S.getState().habits[0].id, '2026-13-01'); }), /Invalid date/);
});

// ---- validateState ----
const base4 = () => clone(S.defaultState());
const bad = (mut, re) => { const s = base4(); mut(s); assert.throws(() => S.validateState(s), re || /Invalid data/); };
test('validateState rejects malformed cycle, habits, kinds, habit log and health settings', () => {
  const okc = () => clone(CYCLE);
  for (const c of ['x', 5, [], true]) bad((s) => { s.cycle = c; }, /cycle/);
  const cyc = (k, v) => bad((s) => { s.cycle = okc(); s.cycle[k] = v; });
  for (const v of [undefined, '2026-02-30', '26-01-05', 5, null]) cyc('startDate', v);
  for (const v of [0, 366, 1.5, '7', NaN, -1, undefined]) cyc('sprintDays', v);
  for (const v of [0, 53, 2.5, '2', undefined]) cyc('sprintsPerCycle', v);
  for (const v of [-1, 91, 1.5, '7', undefined]) cyc('restDays', v);
  for (const v of ['yes', 1, undefined, null]) cyc('alternateHeavyLight', v);
  for (const v of ['medium', 'Heavy', undefined, 1]) cyc('firstWeek', v);
  bad((s) => { s.cycle = JSON.parse('{"__proto__":{"x":1},"startDate":"2026-01-05","sprintDays":7,"sprintsPerCycle":1,"restDays":0,"alternateHeavyLight":false,"firstWeek":"heavy"}'); }, /forbidden/);
  const good = base4(); good.cycle = Object.assign(okc(), { sprintDays: 365, sprintsPerCycle: 52, restDays: 0, extra: 'dropped' });
  const out = S.validateState(good); assert.ok(!('extra' in out.cycle)); assert.equal(out.cycle.sprintDays, 365);
  good.cycle = null; assert.equal(S.validateState(good).cycle, null);
  delete good.cycle; assert.equal(S.validateState(good).cycle, null);

  for (const v of ['x', {}, 5]) bad((s) => { s.habits = v; }, /daily checks/);
  bad((s) => { s.habits = Array.from({ length: 9 }, (_, i) => ({ id: 'h' + i, name: 'n' })); }, /too many/);
  bad((s) => { s.habits = [{ id: 'a', name: 'x' }, { id: 'a', name: 'y' }]; }, /duplicate/);
  for (const hb of [null, 'x', { id: 'a' }, { id: 'a', name: '' }, { id: 'a', name: ' ' }, { id: 'a', name: 'x'.repeat(61) }, { id: 5, name: 'x' }, { name: 'x' }, { id: 'a', name: 5 }]) bad((s) => { s.habits = [hb]; });
  const ok8 = base4(); ok8.habits = Array.from({ length: 8 }, (_, i) => ({ id: 'h' + i, name: 'n' + i, junk: 1 }));
  assert.equal(S.validateState(ok8).habits.length, 8); assert.ok(!('junk' in S.validateState(ok8).habits[0]));
  const bidi = base4(); bidi.habits = [{ id: 'a', name: 'ab‮c' }]; assert.equal(S.validateState(bidi).habits[0].name, 'abc');

  for (const v of ['x', {}, 5]) bad((s) => { s.kinds = v; }, /workout types/);
  bad((s) => { s.kinds = Array.from({ length: 31 }, (_, i) => 'k' + i); }, /too many/);
  bad((s) => { s.kinds = ['Run', 'run']; }, /duplicate/);
  for (const k of ['', '  ', 'x'.repeat(41), 5, null, {}]) bad((s) => { s.kinds = [k]; });
  const k30 = base4(); k30.kinds = Array.from({ length: 30 }, (_, i) => 'k' + i); assert.equal(S.validateState(k30).kinds.length, 30);
  const k0 = base4(); k0.kinds = []; assert.deepEqual(S.validateState(k0).kinds, []);
  const kd = base4(); delete kd.kinds; assert.deepEqual(S.validateState(kd).kinds, M.DEFAULT_KINDS);

  const withLog = (log) => bad((s) => { s.habits = [{ id: 'h1', name: 'x' }]; s.habitLog = log; });
  for (const v of ['x', {}, 5]) bad((s) => { s.habitLog = v; }, /habit log/);
  for (const x of [null, 'x', { habitId: 'h1' }, { habitId: 'h1', date: '2026-02-30' }, { habitId: 5, date: TODAY }, { date: TODAY }]) withLog([x]);
  withLog(new Array(100001).fill({ habitId: 'h1', date: TODAY }));
  const lg = base4(); lg.habits = [{ id: 'h1', name: 'x' }]; lg.habitLog = [{ habitId: 'h1', date: TODAY }, { habitId: 'h1', date: TODAY }, { habitId: 'gone', date: TODAY }, { habitId: 'h1', date: '2026-11-11', extra: 1 }];
  assert.deepEqual(S.validateState(lg).habitLog, [{ habitId: 'h1', date: TODAY }, { habitId: 'h1', date: '2026-11-11' }], 'duplicates collapse and dangling ticks drop');

  for (const v of ['x', 5, []]) bad((s) => { s.settings.health = v; }, /health settings/);
  bad((s) => { s.settings.health = { units: 'stone' }; }, /units/); bad((s) => { s.settings.health = {}; });
  for (const [k, v] of [['weightTarget', 0], ['weightTarget', 1001], ['weightStart', 'x'], ['weightStart', NaN], ['bodyFatTarget', 101], ['bodyFatStart', 0], ['bodyFatStart', -3]]) bad((s) => { s.settings.health = { units: 'lb', [k]: v }; });
  const hs = base4(); hs.settings.health = { units: 'kg', weightStart: 90.0400004, weightTarget: null, bodyFatTarget: 12, stray: 1 };
  // SEC-34: targets keep 6 decimals (as converted weights do), so a unit switch round trip does not drift.
  assert.deepEqual(S.validateState(hs).settings.health, { units: 'kg', weightStart: 90.04, bodyFatTarget: 12 });
  // Entries and review digests are checked too.
  bad((s) => { s.entries = [{ id: 'e', domain: 'health', type: 'workout', date: TODAY, title: 't', minutes: 5000, createdAt: 1 }]; }, /entry 1/);
  const dg = (o) => ({ week: WK, domains: {}, health: Object.assign({ sessions: 1, minutes: 2, avgSleep: 7, weightChange: -1, habitRate: 50 }, o) });
  const rv = (d) => bad((s) => { s.memory.reviews = [{ id: 'r', weekOf: WK, digest: d, priorities: ['a', 'b', 'c'], completedAt: 1 }]; });
  for (const o of [{ avgSleep: 25 }, { habitRate: 101 }, { sessions: 1.5 }, { minutes: -1 }, { weightChange: 'x' }, { sessions: undefined }]) rv(dg(o));
  rv(Object.assign(dg(), { health: 'x' }));
  const okr = base4(); okr.memory.reviews = [{ id: 'r', weekOf: WK, digest: Object.assign(dg(), { health: Object.assign(dg().health, { habits: ['leak'] }) }), priorities: ['a', 'b', 'c'], completedAt: 1 }];
  assert.deepEqual(Object.keys(S.validateState(okr).memory.reviews[0].digest.health).sort(), ['avgSleep', 'habitRate', 'minutes', 'sessions', 'weightChange']);
  // Unknown top-level keys never survive.
  const x = base4(); x.injected = { a: 1 }; assert.ok(!('injected' in S.validateState(x)));
});

// ---- privacy: digest, prompt, insights, audit, errors ----
const EVIL = { habit: 'ZZHABIT<img src=x onerror=alert(1)>', note: 'ZZNOTE secret', kind: 'ZZKIND', title: 'ZZTITLE' };
function evilState() {
  return build((x) => {
    x.habits = [{ id: 'h1', name: EVIL.habit }, { id: 'h2', name: 'Mobility' }];
    for (const d of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-08']) x.habitLog.push({ habitId: 'h1', date: d });
    x.habitLog.push({ habitId: 'h2', date: '2026-11-11' });
    x.kinds.push(EVIL.kind);
    x.entries.push(H('workout', '2026-11-10', undefined, { title: EVIL.title, kind: EVIL.kind, minutes: 50, effort: 9, notes: EVIL.note }),
      H('workout', '2026-11-11', undefined, { title: EVIL.title, kind: 'strength', minutes: 40, notes: EVIL.note }),
      H('sleep', '2026-11-10', 7, { title: EVIL.title, notes: EVIL.note }), H('sleep', '2026-11-11', 8, { title: EVIL.title }));
    for (const [d, v] of SERIES) x.entries.push(W(d, v));
    x.entries.push(H('workout', '2026-11-12', undefined, { title: 'x', kind: 'cardio' }), H('workout', '2026-11-13', undefined, { title: 'y' }));
    x.memory.insights.push({ id: 'i1', level: 1, period: { from: WK, to: '2026-11-15' }, domain: 'health', text: 'approved text', source: 'rules', status: 'approved', createdAt: 1 });
  });
}
test('weekly digest health fields are numeric facts, and no habit name, note, title or kind reaches the digest or any prompt', () => {
  const s = evilState(), dg = M.weeklyDigest(s, WK);
  assert.deepEqual(dg.health, { sessions: 4, minutes: 90, avgSleep: 7.5, weightChange: -1, habitRate: 28.6 }, 'habit ticks in week: 3 + 1 of 14');
  for (const v of Object.values(dg.health)) assert.equal(typeof v, 'number');
  const prev = M.weeklyDigest(s, '2026-11-02').health;
  assert.deepEqual([prev.sessions, prev.habitRate, prev.weightChange], [0, 7.1, -1]);
  assert.deepEqual(M.healthDigest(build(() => {}), WK), { sessions: 0, minutes: 0, avgSleep: 0, weightChange: 0, habitRate: 0 });
  const blob = JSON.stringify(dg);
  const p1 = Mem.buildPrompt(s, 1, { from: WK, to: '2026-11-15' }), p2 = Mem.buildPrompt(s, 2, { from: '2026-11-01', to: '2026-11-30' }), p3 = Mem.buildPrompt(s, 3, { from: '2026-10-01', to: '2026-12-31' });
  const rules = JSON.stringify(Mem.rulesInsights(s, WK));
  for (const secret of ['ZZHABIT', 'ZZNOTE', 'ZZKIND', 'ZZTITLE', 'Mobility', 'onerror', 'img src', 'strength', 'cardio']) {
    for (const [name, text] of [['digest', blob], ['prompt1', p1.system + p1.user], ['prompt2', p2.system + p2.user], ['prompt3', p3.system + p3.user], ['rules', rules]]) assert.ok(!text.includes(secret), secret + ' leaked into ' + name);
  }
  assert.match(p1.user, /health detail: sessions 4, minutes 90, average sleep 7.5 hours, daily checks completed 28.6%/);
  // SEC-32: body metrics stay in the vault, so the weight change is never part of a prompt.
  assert.ok(!/weight/i.test(p1.user + p2.user + p3.user), 'no weight in any prompt');
  // The digest stored with a weekly review passes validateState and keeps only the five fields.
  const s2 = clone(s); s2.memory.reviews = [{ id: 'r', weekOf: WK, digest: dg, priorities: ['a', 'b', 'c'], completedAt: 1 }];
  assert.deepEqual(S.validateState(s2).memory.reviews[0].digest.health, dg.health);
});
test('rules insights for health are numeric facts with no advice wording', () => {
  const s = evilState(), ins = Mem.rulesInsights(s, WK).filter((i) => i.domain === 'health').map((i) => i.text);
  assert.deepEqual(ins, [
    'Workout target met: 4 of 4 this week.',
    'Average sleep this week was 7.5 hours.',
    'Weight moved down 1 lb this week.',
    'Daily checks completed: 28.6% this week (last week 7.1%).',
  ]);
  const advice = /\b(should|try|consider|recommend\w*|aim|avoid|improve\w*|need|must|ought|diagnos\w*|doctor|physician|healthy|unhealthy|risk\w*|too (low|high|little|much)|good|bad|great|poor|more sleep|keep it up|great job)\b/i;
  const kg = clone(s); kg.settings.health.units = 'kg';
  const all = ins.concat(Mem.rulesInsights(kg, WK).map((i) => i.text), Mem.rulesInsights(s, '2026-11-02').map((i) => i.text));
  for (const t of all) { assert.ok(!advice.test(t), t); assert.ok(/\d/.test(t), 'states a number: ' + t); assert.ok(t.length <= 280); assert.ok(!t.includes('—')); }
  assert.ok(Mem.rulesInsights(kg, WK).some((i) => i.text === 'Weight moved down 1 kg this week.'));
  // Proposed insights are still only proposals.
  const t = clone(s); Mem.propose(t, Mem.rulesInsights(t, WK), { level: 1, period: { from: WK, to: '2026-11-15' }, source: 'rules' });
  assert.ok(t.memory.insights.filter((i) => i.id !== 'i1').every((i) => i.status === 'proposed'));
  // Nothing logged: no health insight at all.
  assert.deepEqual(Mem.rulesInsights(build(() => {}), WK).filter((i) => i.domain === 'health'), []);
});
test('body metrics stay out of the audit log and error messages', async () => {
  await fresh();
  await S.commit((x) => { x.entries.push(W(TODAY, 187.3)); x.settings.health.weightTarget = 171.5; M.addHabit(x, 'SecretHabit'); }, {});
  const aud = JSON.stringify(S.getState().audit);
  assert.ok(!/187|171|SecretHabit/.test(aud));
  for (const f of [() => M.validateEntry({ domain: 'health', type: 'weight', date: TODAY, title: 't', value: 'sec-1234' }), () => M.validateEntry({ domain: 'health', type: 'workout', date: TODAY, title: 't', minutes: 98765 }),
    () => S.validateState(Object.assign(base4(), { habits: [{ id: 'a', name: 'x'.repeat(99) + 'SecretHabit' }] })), () => S.validateState(Object.assign(base4(), { settings: Object.assign(base4().settings, { health: { units: 'lb', weightTarget: 98765 } }) }))]) {
    try { f(); assert.fail('should throw'); } catch (e) { assert.ok(!/sec-1234|98765|SecretHabit/.test(e.message), e.message); }
  }
});

// ---- sync round trip with schema 4 data ----
const healthShape = (s) => JSON.stringify({ c: s.cycle, k: s.kinds, h: s.habits, l: s.habitLog, hs: s.settings.health, e: s.entries.filter((e) => e.domain === 'health').map((e) => [e.type, e.date, e.value, e.kind, e.minutes, e.effort, e.title, e.notes]) });
function addHealth(x) {
  x.cycle = clone(CYCLE); x.kinds.push('SyncKind'); x.settings.health = { units: 'kg', weightStart: 95, weightTarget: 85, bodyFatTarget: 14 };
  const h = M.addHabit(x, 'SyncHabit'); M.toggleHabit(x, h.id, TODAY); M.toggleHabit(x, h.id, '2026-11-11');
  x.entries.push(H('workout', TODAY, undefined, { title: 'SyncWorkout', kind: 'SyncKind', minutes: 33, effort: 7, notes: 'SyncNotes' }), W(TODAY, 90.5), H('sleep', TODAY, 6.5, { title: 'SyncSleep' }), H('bodyfat', TODAY, 18.2, { title: 'SyncFat' }));
}
test('sync round trip with schema 4 data: ciphertext only, restores on another device', async () => {
  const { d } = await fresh();
  await S.commit(addHealth);
  const want = healthShape(S.getState());
  assert.equal((await L.sync.run()).kind, 'uploaded');
  for (const secret of ['SyncHabit', 'SyncKind', 'SyncNotes', 'SyncWorkout', 'SyncSleep', 'SyncFat', '90.5']) assert.ok(!d.file.text.includes(secret), 'no plaintext on Drive: ' + secret);
  const up = await V.importBackup(PASS, d.file.text);
  assert.equal(up.schema, 9); assert.equal(healthShape(up), want);
  const ad2 = memAdapter(); S._setAdapter(ad2); S.lock(); await S.init(PASS);
  const dec = await L.sync.run({ passphrase: PASS });
  assert.equal(dec.kind, 'download-offer'); assert.equal(dec.dropsWork, false);
  await L.sync.apply(dec, 'download');
  assert.equal(healthShape(S.getState()), want);
  S.lock(); await S.unlock(PASS);
  assert.equal(healthShape(S.getState()), want); assert.equal(S.getState().schema, 9);
  assert.equal((await L.sync.run()).kind, 'in-sync');
  // A schema 3 device downloading this copy migrates up and keeps everything it had.
  const ad3 = memAdapter(); S._setAdapter(ad3); S.lock();
  const salt = V.newSalt(), key = await V.deriveKey(PASS, salt);
  ad3._m.set('envelope', await V.makeEnvelope(key, salt, asSchema(3, S.defaultState())));
  assert.equal((await S.unlock(PASS)).schema, 9);
});
