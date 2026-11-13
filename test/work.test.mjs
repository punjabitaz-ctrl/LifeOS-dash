// v0.4.0 Work: schema 3, projects, pipeline, outcomes, carry-over, stale flag, digest privacy, sync.
import test from 'node:test';
import assert from 'node:assert/strict';
import { L, memAdapter, PASS, E } from './_load.mjs';

const S = L.store, M = L.metrics, V = L.vault;
const TODAY = '2026-11-12';           // a Thursday; its week starts 2026-11-09
const WK = '2026-11-09';
const clone = (x) => JSON.parse(JSON.stringify(x));
const proj = (o) => Object.assign({ id: 'p-' + Math.random().toString(36).slice(2), name: 'Proj', kind: 'job', status: 'active', nextAction: '', archived: false }, o);
const item = (o) => Object.assign({ id: 'i-' + Math.random().toString(36).slice(2), title: 'Item', org: '', kind: 'job', stage: 'lead', source: '', nextStep: '', updatedAt: TODAY, notes: '' }, o);
const outcome = (o) => E(Object.assign({ domain: 'work', type: 'outcome', date: TODAY, status: 'todo' }, o));
function withWork(fn) { const s = S.defaultState(); fn(s); return S.validateState(clone(s)); }

function schema2() {
  const s = S.defaultState();
  s.schema = 2; delete s.projects; delete s.pipeline;
  s.accounts.push({ id: 'a1', name: 'Checking', kind: 'cash', liability: false, archived: false });
  s.budgets.push({ category: 'Groceries', value: 400 });
  s.recurring.push({ id: 'r1', title: 'Rent', value: 1500, category: 'Housing', type: 'expense', cadence: 'monthly', nextDate: '2026-12-01', active: true });
  s.entries.push(E({ domain: 'assets', type: 'balance', value: 100, accountId: 'a1', title: 'Checking' }), outcome({ title: 'Old outcome', status: 'done' }));
  s.memory.lessons.push({ id: 'l1', text: 'lesson', createdAt: 1 });
  return s;
}
function schema1() {
  const s = schema2();
  s.schema = 1; delete s.accounts; delete s.recurring; delete s.budgets; delete s.categories;
  s.entries = [E({ domain: 'assets', type: 'balance', value: 100, title: 'Checking' }), outcome({ title: 'Old outcome', status: 'done' })];
  return s;
}

// ---- migration ----
test('schema 1 and 2 migrate to 3 with no data loss', () => {
  for (const make of [schema1, schema2]) {
    const src = make(), m = S.validateState(clone(src));
    assert.equal(m.schema, 4);
    assert.deepEqual(m.projects, []); assert.deepEqual(m.pipeline, []);
    assert.deepEqual(m.entries.map((e) => e.title), src.entries.map((e) => e.title));
    assert.equal(m.entries.find((e) => e.title === 'Old outcome').status, 'done');
    assert.deepEqual(m.memory, src.memory);
    assert.equal(M.headline(m, 'work', TODAY).display, '1 of 1');
    assert.deepEqual(S.validateState(clone(m)), m, 'idempotent');
  }
  const m2 = S.validateState(schema2());
  assert.equal(m2.accounts.length, 1); assert.equal(m2.budgets[0].value, 400); assert.equal(m2.recurring[0].title, 'Rent');
  assert.equal(S.validateState(schema1()).accounts.length, 1);
});
test('migration runs on unlock of stored schema 1 and 2 vaults', async () => {
  for (const make of [schema1, schema2]) {
    const ad = memAdapter(); S._setAdapter(ad); S.lock();
    const salt = V.newSalt(), key = await V.deriveKey(PASS, salt);
    ad._m.set('envelope', await V.makeEnvelope(key, salt, make()));
    const st = await S.unlock(PASS);
    assert.equal(st.schema, 4); assert.equal(st.entries.length, 2);
    await S.commit((x) => { x.projects.push(proj({ name: 'New' })); });
    const raw = await V.decrypt(key, ad._m.get('envelope'));
    assert.equal(raw.schema, 4); assert.equal(raw.projects.length, 1);
  }
});
test('a v0.3.0 backup (schema 2) imports cleanly', async () => {
  const salt = V.newSalt(), key = await V.deriveKey(PASS, salt);
  const text = JSON.stringify(await V.makeEnvelope(key, salt, schema2()));
  const got = await V.importBackup(PASS, text);
  assert.equal(got.schema, 4); assert.equal(got.entries.length, 2); assert.equal(got.accounts.length, 1); assert.deepEqual(got.projects, []);
});
test('a schema 3 backup round trips projects and pipeline', async () => {
  const s = withWork((x) => { x.projects.push(proj({ id: 'p1', name: 'Alpha' })); x.pipeline.push(item({ id: 'i1', title: 'Role' })); });
  const back = await V.importBackup(PASS, await V.exportBackup(PASS, s));
  assert.deepEqual(back.projects, s.projects); assert.deepEqual(back.pipeline, s.pipeline);
});

// ---- never downgraded ----
test('a schema 3 vault is never downgraded by an older backup or an unknown newer schema', async () => {
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  await S.commit((x) => { x.projects.push(proj({ name: 'Keep' })); });
  const salt = V.newSalt(), key = await V.deriveKey(PASS, salt);
  const bk = await V.importBackup(PASS, JSON.stringify(await V.makeEnvelope(key, salt, schema2())));
  assert.equal(bk.schema, 4);
  // SEC-28: an older-format backup would drop the project, so it needs an explicit choice.
  await assert.rejects(S.replaceState(bk), (e) => e.code === 'OLDER_FORMAT');
  assert.equal(S.getState().projects.length, 1);
  await S.replaceState(bk, { allowWorkLoss: true });
  assert.equal(S.getState().schema, 4);
  const k3 = await V.deriveKey(PASS, V.parseEnvelope(ad._m.get('envelope')).salt);
  assert.equal((await V.decrypt(k3, ad._m.get('envelope'))).schema, 4);
  assert.throws(() => S.validateState(Object.assign(S.defaultState(), { schema: 5 })), /schema/);
  assert.throws(() => S.validateState(Object.assign(S.defaultState(), { schema: 2.5 })));
});

// ---- validation and caps ----
test('project validation and cap', () => {
  const ok = withWork((x) => { x.projects.push(proj({ id: 'a', name: '  Trim  ', nextDate: '2026-12-01', nextAction: 'call' })); });
  assert.equal(ok.projects[0].name, 'Trim'); assert.equal(ok.projects[0].nextDate, '2026-12-01');
  const bad = (o) => { const s = S.defaultState(); s.projects.push(proj(Object.assign({ id: 'z' }, o))); return () => S.validateState(s); };
  assert.throws(bad({ name: '' })); assert.throws(bad({ name: 'x'.repeat(201) })); assert.throws(bad({ kind: 'weird' }));
  assert.throws(bad({ status: 'weird' })); assert.throws(bad({ nextAction: 'x'.repeat(201) })); assert.throws(bad({ nextDate: '2026-02-30' }));
  assert.throws(bad({ archived: 'no' })); assert.throws(bad({ id: '' })); assert.throws(bad({ id: 5 }));
  const s = S.defaultState(); s.projects.push(proj({ id: 'd' }), proj({ id: 'd' }));
  assert.throws(() => S.validateState(s), /duplicate/);
  const stripped = S.validateState(Object.assign(S.defaultState(), { projects: [Object.assign(proj({ id: 'q' }), { extra: 'x', secret: 1 })] }));
  assert.deepEqual(Object.keys(stripped.projects[0]).sort(), ['archived', 'id', 'kind', 'name', 'nextAction', 'status']);
  const big = S.defaultState(); big.projects = Array.from({ length: 200 }, (_, i) => proj({ id: 'p' + i }));
  assert.equal(S.validateState(big).projects.length, 200);
  big.projects.push(proj({ id: 'p200' })); assert.throws(() => S.validateState(big), /too many/);
});
test('pipeline validation and cap', () => {
  const ok = withWork((x) => { x.pipeline.push(item({ id: 'a', org: 'Org', source: 'friend', nextStep: 'email', nextDate: '2026-12-01', notes: 'n', stage: 'interview' })); });
  assert.equal(ok.pipeline[0].stage, 'interview');
  const bad = (o) => { const s = S.defaultState(); s.pipeline.push(item(Object.assign({ id: 'z' }, o))); return () => S.validateState(s); };
  assert.throws(bad({ title: '' })); assert.throws(bad({ title: 'x'.repeat(201) })); assert.throws(bad({ org: 'x'.repeat(201) }));
  assert.throws(bad({ kind: 'weird' })); assert.throws(bad({ stage: 'weird' })); assert.throws(bad({ source: 'x'.repeat(201) }));
  assert.throws(bad({ nextStep: 'x'.repeat(201) })); assert.throws(bad({ notes: 'x'.repeat(2001) })); assert.throws(bad({ updatedAt: 'yesterday' }));
  assert.throws(bad({ updatedAt: undefined })); assert.throws(bad({ nextDate: '2026-13-01' })); assert.throws(bad({ title: 5 }));
  for (const st of M.STAGES) assert.doesNotThrow(bad({ stage: st }));
  assert.deepEqual(M.STAGES, ['lead', 'contacted', 'applied', 'interview', 'offer', 'won', 'lost']);
  const s = S.defaultState(); s.pipeline = Array.from({ length: 1000 }, (_, i) => item({ id: 'i' + i }));
  assert.equal(S.validateState(s).pipeline.length, 1000);
  s.pipeline.push(item({ id: 'i1000' })); assert.throws(() => S.validateState(s), /too many/);
  const x = S.defaultState(); x.pipeline.push(item({ id: 'd' }), item({ id: 'd' })); assert.throws(() => S.validateState(x), /duplicate/);
  const f = S.defaultState(); f.pipeline.push(JSON.parse('{"id":"a","title":"t","kind":"job","stage":"lead","updatedAt":"2026-11-01","__proto__":{"x":1}}'));
  assert.throws(() => S.validateState(f));
});
test('bidi characters are stripped from project and pipeline text', () => {
  const s = withWork((x) => { x.projects.push(proj({ name: 'a‮b' })); x.pipeline.push(item({ title: 'c​d', org: 'e⁦f' })); });
  assert.equal(s.projects[0].name, 'ab'); assert.equal(s.pipeline[0].title, 'cd'); assert.equal(s.pipeline[0].org, 'ef');
});
test('store.commit validates work data and rolls back on failure', async () => {
  S._setAdapter(memAdapter()); S.lock(); await S.init(PASS);
  await assert.rejects(S.commit((x) => { x.pipeline.push(item({ stage: 'nope' })); }));
  assert.equal(S.getState().pipeline.length, 0);
  await S.commit((x) => { x.pipeline.push(item({ title: 'Ok' })); });
  assert.equal(S.getState().pipeline.length, 1);
});

// ---- outcomes linked to projects ----
test('outcomes link to projects; dangling links are dropped, other entries unaffected', () => {
  const s = withWork((x) => { x.projects.push(proj({ id: 'p1', name: 'Alpha' })); x.entries.push(outcome({ title: 'Linked', projectId: 'p1' }), outcome({ title: 'Ghost', projectId: 'gone' }), outcome({ title: 'Plain' })); });
  const by = (t) => s.entries.find((e) => e.title === t);
  assert.equal(by('Linked').projectId, 'p1'); assert.equal(by('Ghost').projectId, undefined); assert.equal(by('Ghost').title, 'Ghost');
  assert.equal(by('Plain').projectId, undefined);
  assert.throws(() => outcome({ projectId: 5 })); assert.throws(() => outcome({ projectId: 'x'.repeat(101) }));
  assert.equal(E({ domain: 'health', type: 'workout', projectId: 'p1' }).projectId, undefined, 'only outcomes carry a project link');
  const csv = L.csv.exportEntries([by('Linked')]);
  assert.ok(csv.split('\r\n')[0].endsWith('"projectId"')); assert.ok(csv.includes('"p1"'));
  assert.ok(L.csv.exportPipeline(s.pipeline).startsWith('"id","title","org"'));
  assert.ok(L.csv.exportProjects(s.projects).includes('"Alpha"'));
  assert.ok(L.csv.exportPipeline([item({ title: '=cmd()' })]).includes(`"'=cmd()"`));
});

// ---- carry-over ----
test('carry-over is offered, never automatic, and only copies what the user picks', async () => {
  S._setAdapter(memAdapter()); S.lock(); await S.init(PASS);
  await S.commit((x) => {
    x.projects.push(proj({ id: 'p1', name: 'Alpha' }));
    x.entries.push(outcome({ title: 'Unfinished', date: '2026-11-04', projectId: 'p1' }), outcome({ title: 'Finished', date: '2026-11-04', status: 'done' }),
      outcome({ title: 'Other', date: '2026-11-05' }), outcome({ title: 'Ancient', date: '2026-08-01' }), outcome({ title: 'Now', date: TODAY }));
  });
  const before = S.getState().entries.length;
  const c = M.carryOverCandidates(S.getState(), WK);
  assert.deepEqual(c.map((e) => e.title), ['Unfinished', 'Other'], 'todo only, from the last 4 weeks, not finished, not old');
  // Looking at it, running the review digest and committing something else never carries anything.
  M.weeklyDigest(S.getState(), WK); M.headline(S.getState(), 'work', TODAY);
  await S.commit((x) => { x.memory.reviews.push({ id: 'r', weekOf: WK, digest: M.weeklyDigest(x, WK), priorities: ['a', 'b', 'c'], completedAt: 1 }); });
  assert.equal(S.getState().entries.length, before);
  await S.commit((x) => { const made = M.carryOver(x, [c[0].id], WK); assert.equal(made.length, 1); });
  const st = S.getState(), made = st.entries.find((e) => e.title === 'Unfinished' && e.date === WK);
  assert.equal(st.entries.length, before + 1); assert.equal(made.status, 'todo'); assert.equal(made.projectId, 'p1');
  assert.deepEqual(M.carryOverCandidates(st, WK).map((e) => e.title), ['Other'], 'carried item is not offered again');
  await assert.rejects(S.commit((x) => { M.carryOver(x, ['nope'], WK); }), /cannot be carried/);
  await assert.rejects(S.commit((x) => { M.carryOver(x, 'all', WK); }));
  assert.equal(S.getState().entries.length, before + 1);
  // A later "done" for the same outcome removes the offer.
  await S.commit((x) => { x.entries.push(outcome({ title: 'Other', date: '2026-11-07', status: 'done' })); });
  assert.deepEqual(M.carryOverCandidates(S.getState(), WK), []);
});

// ---- stale and overdue ----
test('pipeline item is stale at 14 days without update, never when won or lost', () => {
  const upd = (d, stage) => item({ updatedAt: d, stage: stage || 'applied' });
  assert.equal(M.isStale(upd('2026-10-30'), TODAY), false, '13 days');
  assert.equal(M.isStale(upd('2026-10-29'), TODAY), true, '14 days');
  assert.equal(M.isStale(upd('2026-01-01'), TODAY), true);
  assert.equal(M.isStale(upd(TODAY), TODAY), false);
  assert.equal(M.isStale(upd('2026-01-01', 'won'), TODAY), false); assert.equal(M.isStale(upd('2026-01-01', 'lost'), TODAY), false);
  const s = withWork((x) => { x.pipeline.push(upd('2026-10-29'), upd('2026-10-30'), upd('2026-01-01', 'lost')); });
  assert.equal(M.workSummary(s, TODAY).stale, 1); assert.equal(M.workSummary(s, TODAY).openPipeline, 2);
});
test('overdue next actions: active, not archived, date before today', () => {
  const s = withWork((x) => {
    x.projects.push(proj({ name: 'A', nextDate: '2026-11-11' }), proj({ name: 'B', nextDate: TODAY }), proj({ name: 'C', nextDate: '2026-11-01', status: 'paused' }),
      proj({ name: 'D', nextDate: '2026-11-01', archived: true }), proj({ name: 'E' }), proj({ name: 'F', nextDate: '2026-10-01', status: 'done' }), proj({ name: 'G', nextDate: '2026-10-01' }));
  });
  assert.deepEqual(M.overdueProjects(s, TODAY).map((p) => p.name), ['G', 'A']);
  assert.equal(M.workSummary(s, TODAY).overdue, 2);
  assert.equal(M.workSummary(s, TODAY).activeProjects, 4, 'A, B, E, G');
  assert.throws(() => M.overdueProjects(s, 'x'));
});

// ---- headline and trend ----
test('Work headline, tile sub line and 8-week trend use hand-computed numbers', () => {
  const s = withWork((x) => {
    x.projects.push(proj({ name: 'A', nextDate: '2026-11-01' }), proj({ name: 'B', nextDate: '2026-11-20' }));
    x.pipeline.push(item({ stage: 'lead' }), item({ stage: 'interview' }), item({ stage: 'won' }), item({ stage: 'lost' }));
    x.entries.push(outcome({ status: 'done' }), outcome({ status: 'done', date: '2026-11-10' }), outcome({ status: 'todo' }),
      outcome({ status: 'done', date: '2026-11-03' }), outcome({ status: 'done', date: '2026-11-04' }), outcome({ status: 'done', date: '2026-10-14' }),
      outcome({ status: 'todo', date: '2026-10-14' }), outcome({ status: 'done', date: '2026-08-01' }));
  });
  const h = M.headline(s, 'work', TODAY);
  assert.equal(h.display, '2 of 3'); assert.equal(h.value, 2); assert.equal(h.sub, '1 overdue next action, 2 open in pipeline');
  assert.equal(M.headline(withWork(() => {}), 'work', TODAY).sub, '0 overdue next actions, 0 open in pipeline');
  const t = M.series(s, 'work', 8, TODAY);
  assert.equal(t.length, 8);
  assert.deepEqual(t.map((p) => p.label), ['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
  assert.deepEqual(t.map((p) => p.value), [0, 0, 0, 1, 0, 0, 2, 2]);
  const w = M.workSummary(s, TODAY);
  assert.deepEqual(w.counts, { lead: 1, contacted: 0, applied: 0, interview: 1, offer: 0, won: 1, lost: 1 });
  assert.equal(w.done, 2); assert.equal(w.total, 3); assert.equal(w.activeProjects, 2);
});

// ---- digest privacy ----
test('digest and AI prompt carry work numbers only: no project names, org names, titles or notes', () => {
  const s = withWork((x) => {
    x.projects.push(proj({ name: 'ProjSecretName', nextAction: 'ActionSecret', nextDate: '2026-11-01' }));
    x.pipeline.push(item({ title: 'TitleSecret', org: 'OrgSecret', source: 'SourceSecret', nextStep: 'StepSecret', notes: 'NoteSecret', stage: 'interview', updatedAt: '2026-11-10' }),
      item({ title: 'TitleSecret2', org: 'OrgSecret2', stage: 'lead', updatedAt: '2026-10-01' }));
    x.entries.push(outcome({ title: 'OutcomeSecret', notes: 'OutNote', status: 'done' }));
  });
  const dg = M.weeklyDigest(s, WK);
  assert.deepEqual(dg.work, { done: 1, planned: 1, activeProjects: 1, overdueNext: 1, pipeline: { lead: 1, contacted: 0, applied: 0, interview: 1, offer: 0, won: 0, lost: 0 }, moved: 1 });
  const p = L.memory.buildPrompt(s, 1, { from: WK, to: '2026-11-15' });
  const all = JSON.stringify(dg) + p.system + p.user + JSON.stringify(L.memory.rulesInsights(s, WK));
  for (const x of ['ProjSecret', 'ActionSecret', 'TitleSecret', 'OrgSecret', 'SourceSecret', 'StepSecret', 'NoteSecret', 'OutcomeSecret', 'OutNote']) assert.ok(!all.includes(x), x);
  assert.ok(p.user.includes('work detail: outcomes done 1 of 1, active projects 1, overdue next actions 1, moved this week 1'));
  const walk = (o) => { for (const v of Object.values(o)) { if (v && typeof v === 'object') walk(v); else assert.equal(typeof v, 'number', 'numeric or fixed labels only'); } };
  const nums = clone(dg.work); walk(nums);
  // Stored reviews validate the work digest and reject anything else.
  const r = { id: 'r', weekOf: WK, digest: dg, priorities: ['a', 'b', 'c'], completedAt: 1 };
  const good = clone(s); good.memory.reviews.push(r);
  assert.deepEqual(S.validateState(good).memory.reviews[0].digest.work, dg.work);
  const bad = clone(good); bad.memory.reviews[0].digest.work.done = 'ProjSecretName';
  assert.throws(() => S.validateState(bad));
  const bad2 = clone(good); bad2.memory.reviews[0].digest.work.pipeline.lead = -1;
  assert.throws(() => S.validateState(bad2));
  const old = clone(good); delete old.memory.reviews[0].digest.work;
  assert.doesNotThrow(() => S.validateState(old), 'digests from v0.3.0 have no work block');
});

// ---- sync ----
const TOKEN = 'ya29.SECRETTOKENVALUE_work_abcdefghij';
function drive() {
  const d = { file: null, version: 1, etag: '"e1"' };
  const res = (status, body, headers = {}) => ({ status, ok: status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  d.put = (text) => { d.file = { id: 'file12345', text }; d.version++; d.etag = '"e' + d.version + '"'; };
  d.fetch = async (url, o) => {
    const u = new URL(url);
    if (u.pathname === '/drive/v3/files') return res(200, { files: d.file ? [{ id: d.file.id, size: String(d.file.text.length), version: String(d.version) }] : [] });
    if (u.searchParams.get('alt') === 'media') return res(200, d.file.text, { etag: d.etag });
    if (u.pathname.startsWith('/drive/v3/files/')) return res(200, { id: d.file.id, version: String(d.version) });
    if (o.method === 'POST') { d.put(o.body.split('Content-Type: application/json\r\n\r\n')[1].split('\r\n--')[0]); return res(200, { id: 'file12345' }); }
    if (o.method === 'PATCH') { d.put(o.body); return res(200, { id: 'file12345' }); }
    return res(500, 'x');
  };
  return d;
}
const workShape = (s) => JSON.stringify({ p: s.projects, l: s.pipeline, e: s.entries.map((e) => [e.title, e.status, e.projectId]) });
function addWork(x) {
  x.projects.push(proj({ id: 'p1', name: 'SyncProject', nextAction: 'x', nextDate: '2026-11-01' }));
  x.pipeline.push(item({ id: 'i1', title: 'SyncRole', org: 'SyncOrg', stage: 'offer' }));
  x.entries.push(outcome({ title: 'SyncOutcome', projectId: 'p1', status: 'done' }));
}
async function fresh() {
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  const d = drive(); L.sync._setFetch(d.fetch); L.sync._setToken(TOKEN, 3600);
  return { ad, d };
}
test('sync round trip with schema 3 data: ciphertext only, restores on another device', async () => {
  const { ad, d } = await fresh();
  await S.commit(addWork);
  const want = workShape(S.getState());
  assert.equal((await L.sync.run()).kind, 'uploaded');
  for (const secret of ['SyncProject', 'SyncRole', 'SyncOrg', 'SyncOutcome']) assert.ok(!d.file.text.includes(secret), 'no plaintext on Drive');
  const up = await V.importBackup(PASS, d.file.text);
  assert.equal(up.schema, 4); assert.equal(workShape(up), want);
  // Second device, same passphrase, empty vault.
  const ad2 = memAdapter(); S._setAdapter(ad2); S.lock(); await S.init(PASS);
  const dec = await L.sync.run({ passphrase: PASS });
  assert.equal(dec.kind, 'download-offer');
  await L.sync.apply(dec, 'download');
  assert.equal(workShape(S.getState()), want);
  S.lock(); await S.unlock(PASS);
  assert.equal(workShape(S.getState()), want);
  assert.equal((await L.sync.run()).kind, 'in-sync');
});
test('a schema 2 device downloads a schema 3 remote, migrates, and stays at schema 3', async () => {
  const { d } = await fresh();
  await S.commit(addWork);
  const want = workShape(S.getState());
  await L.sync.run();
  const remote = d.file.text;
  // Device B holds a schema 2 vault (v0.3.0), never synced, same passphrase.
  const ad2 = memAdapter(); S._setAdapter(ad2); S.lock();
  const salt = V.newSalt(), key = await V.deriveKey(PASS, salt);
  ad2._m.set('envelope', await V.makeEnvelope(key, salt, Object.assign(clone(S.defaultState()), { schema: 2, projects: undefined, pipeline: undefined })));
  const b = await S.unlock(PASS);
  assert.equal(b.schema, 4);
  const dec = await L.sync.run({ passphrase: PASS });
  assert.equal(dec.kind, 'download-offer');
  await L.sync.apply(dec, 'download');
  assert.equal(S.getState().schema, 4); assert.equal(workShape(S.getState()), want);
  assert.equal(d.file.text, remote, 'a download never writes to Drive');
  const stored = ad2._m.get('envelope');
  assert.equal((await V.decrypt(await V.deriveKey(PASS, V.parseEnvelope(stored).salt), stored)).schema, 4);
});
test('an older (schema 2) remote cannot roll a schema 3 vault back', async () => {
  const { ad, d } = await fresh();
  // Remote starts as a schema 2 copy at rev 0 written by an old device.
  await L.sync.run();
  const old = d.file.text;
  await S.commit(addWork);
  await L.sync.run();
  assert.equal((await V.importBackup(PASS, d.file.text)).schema, 4);
  d.put(old);
  await assert.rejects(L.sync.run(), (e) => e.code === 'ROLLBACK');
  assert.equal(S.getState().projects.length, 1); assert.equal(S.getState().schema, 4);
  const raw = ad._m.get('envelope');
  assert.equal((await V.decrypt(await V.deriveKey(PASS, V.parseEnvelope(raw).salt), raw)).schema, 4);
});
test('conflict with a schema 2 remote keeps both copies and ends at schema 3', async () => {
  const { d } = await fresh();
  await L.sync.run();
  // Another device (schema 2 content) advances the remote.
  const mine = S;
  const env1 = JSON.parse(d.file.text);
  const salt = V.parseEnvelope(env1).salt, key = await V.deriveKey(PASS, salt);
  const s2 = schema2();
  const raw = await V.decrypt(key, env1);
  const env2 = await V.makeEnvelope(key, salt, Object.assign(s2, { settings: raw.settings, _meta: { rev: env1.rev + 5, updatedAt: '2026-11-12T00:00:00.000Z', deviceId: 'other-device' } }));
  Object.assign(env2, { rev: env1.rev + 5, updatedAt: '2026-11-12T00:00:00.000Z', deviceId: 'other-device' });
  d.put(JSON.stringify(env2));
  await mine.commit(addWork);
  const dec = await L.sync.run();
  assert.equal(dec.kind, 'conflict');
  const saved = [];
  // SEC-27: using the older-format Drive copy drops work data, so it needs an explicit choice.
  assert.equal(dec.dropsWork, true);
  await assert.rejects(L.sync.apply(dec, 'remote', { saveBackup: async (t) => saved.push(t) }), (e) => e.code === 'OLDER_FORMAT');
  assert.equal(S.getState().projects.length, 1); assert.equal(saved.length, 0);
  await L.sync.apply(dec, 'remote', { saveBackup: async (t) => saved.push(t), allowWorkLoss: true });
  assert.equal(S.getState().schema, 4); assert.equal(S.getState().entries.length, 2);
  const lost = await V.importBackup(PASS, saved[0]);
  assert.equal(lost.projects.length, 1, 'the losing schema 3 copy is restorable');
});
