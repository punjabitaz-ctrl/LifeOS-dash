// v1.2.0 audit (SEC-84 onwards): independent proofs for vault archiving and the Activity CSV import, one regression test per finding.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { L, PASS, memAdapter } from './_load.mjs';
import { build, vault, io, figuresIn, clone, fastKeys, realKeys, PRIV, TODAY } from './_archive.mjs';

const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), A = live('archive'), P = live('priv');
const snap = () => JSON.stringify(S.getState());
const run = (o) => A.archiveYear(Object.assign({ passphrase: PASS, today: TODAY, drive: true, download: true, io: io({}) }, o));
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); try { return await fn(t); } finally { realKeys(); A.drop(); if (L.priv.isOpen()) L.priv.close(); } });
// figures as the open private vault shows them (the merged view)
const viewFigures = (today) => figuresIn(Object.assign({}, L, { store: { getState: () => P.view(S.getState()) } }), today);
const sameFigures = (a, b, what) => { for (const k of Object.keys(a)) assert.deepEqual(b[k], a[k], what + ': ' + k); };

// ---- failure injection: each step of archiveYear fails once; the live vault (state, revision, stored bytes) is unchanged ----
test('SEC-84 proof: a failure at write, verify, Drive upload, Drive re-download or commit leaves the live vault byte for byte unchanged', async () => {
  const ad = await vault(build());
  const raw = async () => JSON.stringify(await ad.get('envelope'));
  const s0 = snap(), r0 = S.getMeta().rev, b0 = await raw();
  const same = async (what) => { assert.equal(snap(), s0, what); assert.equal(S.getMeta().rev, r0, what); assert.equal(await raw(), b0, what); };
  const V = L.vault;
  // 1. write: the envelope cannot be made
  const mk = V.makeEnvelope; V.makeEnvelope = async () => { throw new Error('WRITE_FAIL'); };
  try { await assert.rejects(run({ year: 2021 }), /WRITE_FAIL/); } finally { V.makeEnvelope = mk; }
  await same('write');
  // 2. verify: the file decrypts to something else (decrypt is swapped for one call after the write)
  const dc = V.decrypt; let n = 0;
  V.decrypt = async (k, b) => { const o = await dc(k, b); if (o && o.kind === 'lifeos-archive' && !n++) o.records.entries.pop(); return o; };
  try { await assert.rejects(run({ year: 2021 }), /not a valid LifeOS archive|did not match|checksum/); } finally { V.decrypt = dc; }
  await same('verify');
  // 3. Drive upload fails, no download asked
  await assert.rejects(run({ year: 2021, download: false, io: Object.assign(io({}), { put: async () => { throw new Error('UPLOAD_FAIL'); } }) }), /UPLOAD_FAIL/);
  await same('upload');
  // 4. Drive re-download fails, or returns another file
  await assert.rejects(run({ year: 2021, download: false, io: Object.assign(io({}), { get: async () => { throw new Error('GET_FAIL'); } }) }), /GET_FAIL/);
  await same('re-download');
  const other = {}; await vault(build()); // a valid archive of the same year from another vault
  const ad2 = memAdapter(); void ad2;
  await run({ year: 2021, download: false, io: io(other) });
  S._setAdapter(ad); S.lock(); await S.unlock(PASS);
  await same('relock');
  await assert.rejects(run({ year: 2021, download: false, io: Object.assign(io({}), { get: async () => other.files['lifeos-archive-2021.json'] }) }), /did not match|passphrase did not work|not a valid/);
  await same('re-download of a different file');
  // 5. Drive fails and the download is not confirmed
  await assert.rejects(run({ year: 2021, io: Object.assign(io({ confirm: false }), { put: async () => { throw new Error('UPLOAD_FAIL'); } }) }), /No verified copy/);
  await same('no copy');
  // 6. commit: storage refuses the write
  const set = ad.set; ad.set = async () => { throw new Error('COMMIT_FAIL'); };
  try { await assert.rejects(run({ year: 2021 }), /COMMIT_FAIL/); } finally { ad.set = set; }
  await same('commit');
  // and then it works, in exactly one commit
  await run({ year: 2021 });
  assert.equal(S.getMeta().rev, r0 + 1);
});

// ---- SEC-84: a money link split across a year boundary ----
test('SEC-84: an activity and its expense (and an invoice and its income) in different years are archived together or not at all', async () => {
  const s = build();
  s.entries.push(L.metrics.validateEntry({ id: 'x-exp', domain: 'money', type: 'expense', date: '2022-01-03', title: 'paid later', value: 40, category: 'Other' }));
  s.activities.push({ id: 'x-act', title: 'Late paid', category: s.activityCategories[0], state: 'done', date: '2021-12-30', place: '', withPeople: [], costCents: 4000, expenseId: 'x-exp', paidOn: '2022-01-03' });
  s.entries.push(L.metrics.validateEntry({ id: 'x-inc', domain: 'money', type: 'income', date: '2022-01-04', title: 'received later', value: 50, category: 'Business', status: 'received' }));
  s.invoices.push({ id: 'x-inv', number: 'X-1', issueDate: '2021-12-01', dueDate: '2021-12-31', lines: [{ description: 'w', qty: 1, unitCents: 5000 }], status: 'paid', paidOn: '2021-12-29', incomeId: 'x-inc', notes: '' });
  await vault(S.validateState(s));
  await run({ year: 2021 });
  const st = S.getState();
  assert.ok(st.activities.some((a) => a.id === 'x-act' && a.expenseId === 'x-exp'), 'the activity stays with its live expense');
  assert.ok(st.invoices.some((i) => i.id === 'x-inv' && i.incomeId === 'x-inc'), 'the invoice stays with its live income');
  // archiving 2022 later keeps each pair whole too (the 2021 half belongs to a year already archived, so both stay live)
  await run({ year: 2022, today: '2027-02-01' });
  const st2 = S.getState();
  assert.ok(st2.activities.some((a) => a.id === 'x-act') && st2.entries.some((e) => e.id === 'x-exp'));
  assert.ok(st2.invoices.some((i) => i.id === 'x-inv') && st2.entries.some((e) => e.id === 'x-inc'));
});

// ---- SEC-85: private records' figures while the vault is open ----
async function privateVault() {
  const s = build();
  await vault(S.validateState(s), { priv: true });
  await P.open(PRIV);
  const st = S.getState();
  const pick = (f) => st.entries.filter(f).map((e) => e.id);
  const ids = [].concat(
    pick((e) => e.date.startsWith('2021-0') && e.type === 'expense').slice(0, 4),
    pick((e) => e.date.startsWith('2021-1') && e.type === 'income').slice(0, 2),
    pick((e) => e.date.startsWith('2021-06') && e.type === 'balance' && e.accountId === 'acc1'),
    pick((e) => e.date.startsWith('2021-03') && e.type === 'workout').slice(0, 2),
    pick((e) => e.date.startsWith('2021-04') && e.type === 'sleep'),
    pick((e) => e.date.startsWith('2022-05') && e.type === 'expense').slice(0, 1));
  for (const id of ids) await P.moveIn('entries', id);
  for (const id of ['ss20215', 'ss20217']) await P.moveIn('studySessions', id);
  await P.moveIn('contacts', 'sc20218');
  await P.moveIn('activities', 'ac2021');
  return ids;
}
test('SEC-85: with the private vault open, every figure is the same after archiving a year that holds private records; closed too', async () => {
  await privateVault();
  const openBefore = viewFigures(TODAY);
  P.close(); await new Promise((r) => setTimeout(r, 30));
  const closedBefore = figuresIn(L, TODAY);
  await P.open(PRIV);
  const box = {};
  await run({ year: 2021, io: io(box) });
  sameFigures(openBefore, viewFigures(TODAY), 'open, after archiving');
  P.close(); await new Promise((r) => setTimeout(r, 30));
  sameFigures(closedBefore, figuresIn(L, TODAY), 'closed, after archiving');
  // no private figure is in the public summaries
  assert.ok(!JSON.stringify(S.getState().summaries).includes('"private"'));
  await P.open(PRIV);
  sameFigures(openBefore, viewFigures(TODAY), 'open again');
  // the private figures stay in the private vault: a write made while open never copies them into the main state
  const pub = JSON.stringify(S.getState().summaries);
  assert.notEqual(JSON.stringify(P.view(S.getState()).summaries), pub);
  await P.write((x) => { x.entries.push(L.metrics.validateEntry({ id: 'w-open', domain: 'money', type: 'expense', date: '2026-11-01', title: 'w', value: 1, category: 'Other' })); });
  assert.equal(JSON.stringify(S.getState().summaries), pub);
  assert.deepEqual(L.metrics.weeklyDigest(P.view(S.getState()), '2026-11-02'), L.metrics.weeklyDigest(S.getState(), '2026-11-02'));
  // and the closed views keep the "Some private items are hidden" marker for the domains whose figures they now leave out
  assert.ok(S.getState().priv.marks.includes('entries') && S.getState().priv.marks.includes('studySessions'));
  // restoring the year removes the private figures in the same write, and every figure is as before
  await A.restoreYear(box.files['lifeos-archive-2021.json'], PASS, 2021);
  assert.deepEqual(P.view(S.getState()).summaries, {});
  await P.write((x) => { x.entries = x.entries.filter((e) => e.id !== 'w-open'); });
  sameFigures(openBefore, viewFigures(TODAY), 'open, after restoring');
});

// ---- SEC-86: business budgets over the life of a project ----
test('SEC-86: a project budget (all time) shows the same actual after archiving', async () => {
  const s = build();
  s.projects[0].budgetCents = 1000000; s.projects[0].budgetPeriod = 'project';
  await vault(S.validateState(s));
  const before = L.business.budgetFor(S.getState(), 'p1', TODAY), rb = L.business.budgetRollup(S.getState(), 'p1', TODAY);
  await run({ year: 2021 });
  assert.deepEqual(L.business.budgetFor(S.getState(), 'p1', TODAY), before);
  assert.deepEqual(L.business.budgetRollup(S.getState(), 'p1', TODAY), rb);
});

// ---- SEC-87: the accountant export from an opened archive ----
test('SEC-87: the accountant export from an opened archive matches the one made before archiving, and carries no private record', async () => {
  const s = build();
  s.projects[0].kind = 'client';
  await vault(S.validateState(s), { priv: true });
  const before = L.tax.exportPackage(S.getState(), 2021, false);
  assert.ok(!before.blocked && before.income.length > 0);
  const box = {};
  await run({ year: 2021, io: io(box) });
  await A.openArchive(box.files['lifeos-archive-2021.json'], PASS, 2021);
  assert.deepEqual(L.tax.exportPackage(A.exportState(), 2021, false), before);
  A.drop();
  // a private business expense of 2022 archived with the vault open never reaches the export made without the private tick
  await P.open(PRIV);
  const pe = S.getState().entries.find((e) => e.date.startsWith('2022') && e.type === 'expense' && e.projectId === 'p1');
  await P.moveIn('entries', pe.id);
  const pre = L.tax.exportPackage(P.view(S.getState()), 2022, false), preInc = L.tax.exportPackage(P.view(S.getState()), 2022, true);
  assert.equal(pre.blocked, true); assert.ok(!preInc.blocked);
  const b2 = {};
  await run({ year: 2022, io: io(b2) });
  await A.openArchive(b2.files['lifeos-archive-2022.json'], PASS, 2022);
  assert.equal(L.tax.exportPackage(A.exportState(), 2022, false).blocked, true, 'open vault, no tick: refused as before');
  const inc = L.tax.exportPackage(A.exportState(true), 2022, true);
  assert.deepEqual(Object.assign({}, inc, { privateIncluded: true }), preInc, 'with the tick: the same package as before');
  P.close(); await new Promise((r) => setTimeout(r, 30));
  await A.openArchive(b2.files['lifeos-archive-2022.json'], PASS, 2022);
  assert.equal(L.tax.exportPackage(A.exportState(), 2022, false).blocked, true, 'closed: refused as before');
  assert.throws(() => A.exportState(true), /Open the private vault/);
});

// ---- SEC-88: wellbeing check-ins keep their newest and a run that crosses into the next year ----
test('SEC-88: archiving keeps the newest Wellbeing check-in and a run of daily check-ins that reaches the next year', async () => {
  await vault(build(), { priv: true });
  await P.open(PRIV);
  const ci = [{ id: 'w1', date: '2021-03-01', mood: 3 }, { id: 'w2', date: '2021-12-30', mood: 3 }, { id: 'w3', date: '2021-12-31', mood: 4 }, { id: 'w4', date: '2022-01-01', mood: 4 }];
  await P.commit(async (inner) => { inner.wellbeing = { checkins: ci }; });
  const w0 = P.getWellbeing();
  const before = { g: L.wellbeing.goalValue(w0, 'wbCheckinsPerWeek', TODAY), s: L.wellbeing.streak(w0, '2022-01-01') };
  await run({ year: 2021 });
  const w = P.getWellbeing();
  assert.deepEqual(w.checkins.map((c) => c.id).sort(), ['w2', 'w3', 'w4']);
  assert.deepEqual({ g: L.wellbeing.goalValue(w, 'wbCheckinsPerWeek', TODAY), s: L.wellbeing.streak(w, '2022-01-01') }, before);
  // only check-ins of 2021: the newest stays
  await vault(build(), { priv: true });
  await P.open(PRIV);
  await P.commit(async (inner) => { inner.wellbeing = { checkins: [{ id: 'z1', date: '2021-03-01', mood: 3 }, { id: 'z2', date: '2021-04-01', mood: 3 }] }; });
  const g0 = L.wellbeing.goalValue(P.getWellbeing(), 'wbCheckinsPerWeek', TODAY);
  await run({ year: 2021 });
  assert.equal(L.wellbeing.goalValue(P.getWellbeing(), 'wbCheckinsPerWeek', TODAY), g0);
});

// ---- SEC-89: restore with the private vault closed while it holds records ----
test('SEC-89: restore refuses while the private vault is closed and holds records, so no link to a private record is dropped', async () => {
  await vault(build(), { priv: true });
  const box = {};
  await run({ year: 2021, io: io(box) });
  await P.open(PRIV);
  await P.moveIn('projects', 'p1');
  P.close(); await new Promise((r) => setTimeout(r, 30));
  const s0 = snap();
  await assert.rejects(A.restoreYear(box.files['lifeos-archive-2021.json'], PASS, 2021), /Open the private vault/);
  assert.equal(snap(), s0);
  await P.open(PRIV);
  await A.restoreYear(box.files['lifeos-archive-2021.json'], PASS, 2021);
  const v = P.view(S.getState());
  assert.ok(v.entries.filter((e) => e.date.startsWith('2021') && e.projectId === 'p1').length > 5, 'restored records keep their link to the private line of work');
});

// ---- SEC-90: a private import never drops a category or health type ----
test('SEC-90: a private import rejects (with a reason) rows naming a category or health type not in the lists; a public one still offers them', async () => {
  await vault(null, { priv: true });
  await P.open(PRIV);
  const parsed = L.csv.parse(['title,date,state,category,also health,health kind', 'Pottery,2026-11-01,done,Ceramics,yes,cardio', 'Swim,2026-11-02,done,,yes,Aquatics', 'Walk,2026-11-03,done,,,'].join('\n'));
  const map = { title: 0, date: 1, state: 2, category: 3, alsoHealth: 4, healthKind: 5 };
  const pl = await L.activities.planImport(parsed, { map, asPrivate: true, createCategories: ['ceramics'], createKinds: ['aquatics'] }, P.view(S.getState()), TODAY);
  assert.deepEqual(pl.add.map((x) => x.activity.title), ['Walk']);
  assert.deepEqual(pl.rejected.map((r) => r.row), [2, 3]);
  assert.match(pl.rejected[0].reason, /category is not in your list/); assert.match(pl.rejected[1].reason, /health type is not in your list/);
  assert.ok(!pl.rejected.some((r) => /Ceramics|Aquatics/.test(r.reason)), 'reasons never echo the cell');
  assert.deepEqual(pl.unknownCategories, ['Ceramics']); assert.deepEqual(pl.unknownKinds, ['Aquatics']);
  assert.deepEqual(pl.newCategories, []); assert.deepEqual(pl.newKinds, []);
  const pub = await L.activities.planImport(parsed, { map, createCategories: ['ceramics'] }, P.view(S.getState()), TODAY);
  assert.equal(pub.add.length, 3); assert.deepEqual(pub.newCategories, ['Ceramics']);
});

// ---- SEC-91 (Info): the activities CSV never carries a private record, even if handed the merged view ----
test('SEC-91: exportActivities leaves out private records even when given the open view', async () => {
  const s = S.defaultState();
  s.activities.push({ id: 'a1', title: 'Public walk', category: s.activityCategories[0], state: 'done', date: '2026-11-01', place: '', withPeople: [] },
    { id: 'a2', title: 'Secret walk', category: s.activityCategories[0], state: 'done', date: '2026-11-02', place: '', withPeople: [] });
  await vault(S.validateState(s), { priv: true });
  await P.open(PRIV);
  await P.moveIn('activities', 'a2');
  const out = L.csv.exportActivities(P.view(S.getState()).activities);
  assert.ok(out.includes('Public walk') && !out.includes('Secret walk'));
});

// ---- SEC-92: the restore and sync warnings name archived years once and give the right reason ----
test('SEC-92: an older copy lists the archived years once, the reason says they come back, and the refusal names them', async () => {
  await vault(build());
  const old = clone(S.getState());
  await run({ year: 2021 });
  const cur = S.getState();
  const v13 = S.validateState(Object.assign(clone(old), { schema: 13, archives: undefined, summaries: undefined, settings: Object.assign(clone(old.settings), { archiveSuggestMB: undefined }) }));
  const d = S.droppedData(cur, v13);
  assert.equal(d.filter((x) => /archived years/.test(x)).length, 1, 'named once: ' + d.join(' | '));
  const why = S.lossWhy(d, true, 'This backup');
  assert.match(why, /older version/); assert.match(why, /come back into the live vault/); assert.ok(!/no private vault/.test(why));
  const why14 = S.lossWhy(S.droppedData(cur, S.validateState(clone(old))), false, 'The Drive copy');
  assert.ok(!/no private vault|older/.test(why14) && /come back/.test(why14));
  await assert.rejects(S.replaceState(S.validateState(clone(old))), (e) => e.code === 'OLDER_FORMAT' && /archived years 2021/.test(e.message) && !/has no archived/.test(e.message));
  await assert.rejects(S.replaceState(v13), (e) => e.code === 'OLDER_FORMAT' && /older version/.test(e.message) && /come back/.test(e.message) && /archived years 2021/.test(e.message));
});

// ---- crafted private part (proof): tampered, foreign key, or no key; the live vault is never touched ----
test('a crafted private part is rejected on open and restore, and without the private key nothing private is read or written', async () => {
  await vault(build(), { priv: true });
  await P.open(PRIV);
  await P.moveIn('entries', S.getState().entries.find((e) => e.date.startsWith('2021') && e.type === 'expense').id);
  const box = {};
  await run({ year: 2021, io: io(box) });
  const f = box.files['lifeos-archive-2021.json'], env = JSON.parse(f);
  const V = L.vault, salt = V.parseEnvelope(env).salt, key = await V.deriveKey(PASS, salt), inner = await V.decrypt(key, env);
  const reseal = async (o) => JSON.stringify(Object.assign(await V.makeEnvelope(key, salt, o), { arch: 1, year: 2021 }));
  const ct = Buffer.from(inner.priv.ct, 'base64'); ct[5] ^= 1;
  const tampered = await reseal(Object.assign(clone(inner), { priv: Object.assign({}, inner.priv, { ct: ct.toString('base64') }) }));
  const foreign = await reseal(Object.assign(clone(inner), { priv: Object.assign({}, inner.priv, { kdf: { salt: Buffer.alloc(16, 7).toString('base64') } }) }));
  const data = () => JSON.stringify(Object.assign({}, S.getState(), { audit: 0 }));
  const s0 = data();
  await assert.rejects(A.openArchive(tampered, PASS, 2021), /BAD_PRIVATE_PASSPHRASE/);
  await assert.rejects(A.restoreYear(tampered, PASS, 2021), /BAD_PRIVATE_PASSPHRASE/);
  assert.equal((await A.openArchive(foreign, PASS, 2021)).privNote, 'needs-passphrase');
  A.drop();
  await assert.rejects(A.restoreYear(foreign, PASS, 2021), /earlier private passphrase/);
  await assert.rejects(A.restoreYear(foreign, PASS, 2021, 'not the private one 1'), /BAD_PRIVATE_PASSPHRASE/);
  P.close(); await new Promise((r) => setTimeout(r, 30));
  const info = await A.openArchive(f, PASS, 2021);
  assert.equal(info.privNote, 'closed'); assert.equal(info.privateCounts, null);
  A.drop();
  await assert.rejects(A.restoreYear(f, PASS, 2021), /Open the private vault/);
  assert.equal(data(), s0, 'no record, index, summary or private blob changed');
});
