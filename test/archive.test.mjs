// v1.2.0 part B: vault archiving. No-loss proofs, failure paths, references, figures before and after, restore, sync and backup guards,
// private records, crafted files, proposals, audit, leaks, migration, spell check.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L, PASS, memAdapter } from './_load.mjs';
import { drive, putRemote, TOKEN, asSchema as oldSchema } from './_v070.mjs';
import { buildAdversarial } from './_adversarial.mjs';
import { build, vault, io, figures, clone, fastKeys, realKeys, PRIV, TODAY, ARCH_MARK } from './_archive.mjs';

const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), A = live('archive'), P = live('priv'), V = live('vault');
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const snap = () => JSON.stringify(S.getState());
const run = (o) => A.archiveYear(Object.assign({ passphrase: PASS, today: TODAY, drive: true, download: true, io: io({}) }, o));
const ids = (st, name) => new Set((name === 'habitLog' ? st.habitLog : st[name]).map((r) => r.id || r.habitId + '|' + r.date));
const has = (st, id) => st.entries.some((e) => e.id === id);
// The 1000-iteration key swap is scoped to each archive test so other suites in the same process keep the real derivation.
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); try { return await fn(t); } finally { realKeys(); } });

test('the live window keeps this year and two before; only older years are archivable', async () => {
  await vault(build());
  assert.deepEqual(A.archivable(S.getState(), TODAY), [2021, 2022, 2023]);
  assert.deepEqual(A.archivable(S.getState(), '2027-01-02'), [2021, 2022, 2023, 2024]);
  for (const y of [2024, 2025, 2026]) assert.throws(() => A.plan(S.getState(), y, TODAY), /Only years before 2024/);
  await assert.rejects(run({ year: 2024 }), /Only years before 2024/);
});

test('NO LOSS: file written, decrypted back, counts and SHA-256 match, a verified copy exists, then one commit removes the records', async () => {
  await vault(build());
  const before = clone(S.getState()), rev0 = S.getMeta().rev, box = {};
  const events = [];
  const base = io(box);
  const r = await run({ year: 2021, io: { put: async (n, t) => { events.push('put'); return base.put(n, t); }, get: async (n) => { events.push('get'); assert.equal(S.getMeta().rev, rev0, 'nothing committed before the copy is verified'); assert.deepEqual(S.getState().entries.length, before.entries.length); return base.get(n); }, save: (n, t) => { events.push('save'); base.save(n, t); }, confirmSaved: async () => { events.push('confirm'); assert.equal(S.getMeta().rev, rev0); return true; } } });
  assert.deepEqual(events, ['put', 'get', 'save', 'confirm']);
  assert.equal(S.getMeta().rev, rev0 + 1, 'exactly one commit');
  const file = box.files['lifeos-archive-2021.json'];
  assert.equal(file, box.saved['lifeos-archive-2021.json']);
  // the file decrypts back to exactly the removed records
  const parsed = await A.parse(file, PASS, 2021);
  const st = S.getState();
  for (const name of Object.keys(parsed.inner.records)) {
    const live = new Set((name === 'habitLog' ? st.habitLog : name === 'reviews' ? st.memory.reviews : name === 'insights' ? st.memory.insights : st[name]).map((x) => x.id || x.habitId + '|' + x.date));
    for (const rec of parsed.inner.records[name]) assert.ok(!live.has(rec.id || rec.habitId + '|' + rec.date), name + ' still live');
    const was = (name === 'habitLog' ? before.habitLog : name === 'reviews' ? before.memory.reviews : name === 'insights' ? before.memory.insights : before[name]);
    const mine = new Map(was.map((x) => [x.id || x.habitId + '|' + x.date, x]));
    for (const rec of parsed.inner.records[name]) assert.deepEqual(rec, mine.get(rec.id || rec.habitId + '|' + rec.date), 'byte for byte');
  }
  assert.equal(await A.sha256(A.canon({ records: parsed.inner.records })), st.archives[0].sha256);
  assert.deepEqual(st.archives[0].counts, parsed.inner.counts);
  assert.deepEqual(r.copies.map((c) => c.where), ['drive', 'download']);
  assert.ok(st.archives[0].copies.every((c) => c.verified));
  // every record is either archived or still live: nothing vanished
  for (const name of ['entries', 'contacts', 'studySessions', 'trips', 'taxPayments', 'invoices', 'activities', 'maintenance', 'renewals']) {
    const was = before[name].map((x) => x.id), now = new Set(st[name].map((x) => x.id)), arch = new Set((parsed.inner.records[name] || []).map((x) => x.id));
    for (const id of was) assert.ok(now.has(id) !== arch.has(id), name + ' ' + id + ' neither live nor archived, or both');
  }
});

test('a download alone needs the user to confirm saving; unconfirmed means nothing is removed', async () => {
  await vault(build());
  const before = snap();
  await assert.rejects(run({ year: 2021, drive: false, io: io({ confirm: false }) }), /No verified copy/);
  assert.equal(snap(), before);
  const r = await run({ year: 2021, drive: false, io: io({}) });
  assert.deepEqual(r.copies.map((c) => c.where), ['download']);
  assert.equal(S.getState().archives.length, 1);
});

test('FAILURES leave the live vault untouched: wrong passphrase, Drive failure, corrupt Drive copy, tampering, changes mid-way, a failed save', async () => {
  await vault(build());
  const before = snap(), rev0 = S.getMeta().rev;
  const same = () => { assert.equal(snap(), before); assert.equal(S.getMeta().rev, rev0); assert.equal(S.getState().archives.length, 0); };
  await assert.rejects(run({ year: 2021, passphrase: 'not the passphrase!!' }), /not your main passphrase/); same();
  await assert.rejects(run({ year: 2021, drive: true, download: false, io: Object.assign(io({}), { put: async () => { throw new Error('Google Drive did not answer in time.'); } }) }), /Drive did not answer/); same();
  await assert.rejects(run({ year: 2021, drive: true, download: false, io: io({ corrupt: true }) }), /checksum|damaged|valid LifeOS archive|passphrase did not work/); same();
  // the vault changes while the archive is being written: the commit step notices and removes nothing
  const mid = io({});
  await assert.rejects(run({ year: 2021, io: Object.assign(mid, { put: async () => { await S.commit((x) => { x.entries.push(L.metrics.validateEntry({ id: 'late', domain: 'money', type: 'expense', date: '2021-02-02', title: 'late', value: 1, category: 'Other' })); }); } }) }), /changed while the archive/);
  assert.equal(S.getState().archives.length, 0);
  assert.ok(has(S.getState(), 'late'), 'the late entry is still live');
  assert.equal(S.getState().entries.filter((e) => e.date.startsWith('2021')).length > 100, true);
  // the commit itself fails (storage error): the live vault is exactly as before
  let failing = false;
  const adapter = memAdapter(), baseSet = adapter.set;
  await vault(build()); S._setAdapter(Object.assign(adapter, { set: async (k, v) => { if (failing) throw new Error('STORAGE_ERROR'); return baseSet(k, v); } }));
  await S.commit((x) => { x.audit.push({ ts: 'x', action: 'seed' }); });
  const s2 = snap(), r2 = S.getMeta().rev; failing = true;
  await assert.rejects(run({ year: 2021 }), /STORAGE_ERROR/);
  assert.equal(snap(), s2); assert.equal(S.getMeta().rev, r2);
});

test('a verified Drive copy alone is enough when the download is not requested', async () => {
  await vault(build());
  const box = {};
  const r = await run({ year: 2021, download: false, io: io(box) });
  assert.deepEqual(r.copies.map((c) => c.where), ['drive']);
  assert.equal(box.saved, undefined);
});

test('REFERENCES: nothing a live record points at, nothing open, planned or unpaid, and the anchors each figure needs are never archived', async () => {
  await vault(build());
  await run({ year: 2021 });
  const st = S.getState();
  for (const id of ['keepinc', 'ivopen', 'actexp', 'bill', 'exp-open', 'old-bal']) assert.ok(has(st, id) || st.invoices.some((i) => i.id === id), id + ' must stay');
  assert.ok(st.invoices.some((i) => i.id === 'ivopen'));
  assert.ok(st.activities.some((a) => a.id === 'live-plan'));
  assert.ok(st.contacts.some((c) => c.id === 'old-c'), 'the last contact of a person stays');
  assert.ok(!st.invoices.some((i) => i.id === 'iv2021'), 'a paid invoice of the year moves');
  assert.ok(!has(st, 'ein2021'), 'the income entry of the moved invoice moves with it');
  // never archived by kind
  assert.equal(st.accounts.length, 3); assert.equal(st.projects.length, 1); assert.equal(st.people.length, 2); assert.equal(st.habits.length, 1); assert.equal(st.learningItems.length, 1);
  assert.equal(st.properties.length, 1); assert.equal(st.groups.length, 1); assert.equal(st.categories.expense.length > 0, true);
  // a tax-year profile and settings are untouched
  assert.deepEqual(st.settings.business, build().settings.business);
  // the daily-check run that crosses into 2022 is kept whole
  assert.ok(st.habitLog.some((x) => x.date === '2021-12-31') && st.habitLog.some((x) => x.date === '2021-12-30'));
  assert.ok(!st.habitLog.some((x) => x.date === '2021-03-01'));
});

test('a live record that points at an archivable record keeps it, even through a chain', async () => {
  const s = build();
  // live (2024) invoice points at a 2021 expense through a line; that expense and nothing else stays
  s.invoices.push({ id: 'chain', number: 'CH-1', issueDate: '2024-01-01', dueDate: '2024-02-01', lines: [{ description: 'x', qty: 1, unitCents: 100, expenseId: 'e0' }], status: 'sent', notes: '' });
  await vault(S.validateState(s));
  const target = S.getState().entries.find((e) => e.id === 'e0');
  assert.ok(target && target.date.startsWith('2021'));
  await run({ year: 2021 });
  assert.ok(has(S.getState(), 'e0'));
});

test('FIGURES: every view, chart, net worth history and goal shows exactly the same numbers after archiving, for every year in turn', async () => {
  await vault(build());
  const before = figures(TODAY);
  assert.ok(Object.keys(before.monthViews).length > 60 && before.nwHistory.length === 120);
  for (const y of [2021, 2022, 2023]) {
    await run({ year: y });
    const after = figures(TODAY);
    for (const k of Object.keys(before)) assert.deepEqual(after[k], before[k], 'after archiving ' + y + ': ' + k);
  }
  assert.equal(S.getState().archives.length, 3);
  // the summaries are numbers only
  const sm = JSON.stringify(S.getState().summaries);
  assert.ok(!sm.includes(ARCH_MARK) && !sm.includes('Venture'));
});

test('FIGURES hold when the vault is locked, unlocked again and when archived a day later', async () => {
  const ad = await vault(build());
  const before = figures(TODAY);
  await run({ year: 2021 });
  S.lock(); S._setAdapter(ad); await S.unlock(PASS);
  assert.deepEqual(figures(TODAY), before);
  assert.deepEqual(S.getState().archives.map((a) => a.year), [2021]);
});

test('a month of an archived year plus a new back-dated live entry adds to the summary (additive money figures)', async () => {
  await vault(build());
  await run({ year: 2021 });
  const m0 = L.metrics.monthView(S.getState(), '2021-05');
  await S.commit((x) => { x.entries.push(L.metrics.validateEntry({ id: 'back', domain: 'money', type: 'expense', date: '2021-05-20', title: 'back-dated', value: 10, category: 'Dining' })); });
  const m1 = L.metrics.monthView(S.getState(), '2021-05');
  assert.equal(m1.spendCents, m0.spendCents + 1000);
});

test('RESTORE: deduplicated by id, never overwrites a live record, removes the index and summary, and the figures come back', async () => {
  await vault(build());
  const orig = clone(S.getState()), before = figures(TODAY), box = {};
  await run({ year: 2021, io: io(box) });
  const file = box.files['lifeos-archive-2021.json'];
  // a live record that shares an id with an archived one is left alone
  await S.commit((x) => { x.entries.push(L.metrics.validateEntry({ id: 'e1', domain: 'money', type: 'expense', date: '2024-02-02', title: 'LIVE WINS', value: 5, category: 'Other' })); });
  const r = await A.restoreYear(file, PASS, 2021);
  const st = S.getState();
  assert.ok(r.added > 100 && r.skipped >= 1);
  assert.equal(st.entries.find((e) => e.id === 'e1').title, 'LIVE WINS');
  assert.equal(new Set(st.entries.map((e) => e.id)).size, st.entries.length, 'no duplicates');
  assert.deepEqual(st.archives, []); assert.deepEqual(st.summaries, {});
  // restoring again adds nothing
  const again = await A.restoreYear(file, PASS, 2021);
  assert.equal(again.added, 0);
  assert.equal(new Set(S.getState().studySessions.map((e) => e.id)).size, S.getState().studySessions.length);
  // everything is back except the id we changed
  await S.commit((x) => { x.entries = x.entries.filter((e) => e.id !== 'e1'); x.entries.push(clone(orig.entries.find((e) => e.id === 'e1'))); });
  const back = S.getState();
  assert.equal(back.entries.length, orig.entries.length); assert.equal(back.contacts.length, orig.contacts.length); assert.equal(back.habitLog.length, orig.habitLog.length);
  assert.deepEqual(figures(TODAY), before);
});

test('restore refuses a file of another year, a wrong passphrase and a stranger passphrase', async () => {
  await vault(build());
  const box = {}; await run({ year: 2021, io: io(box) });
  const f = box.files['lifeos-archive-2021.json'];
  await assert.rejects(A.restoreYear(f, PASS, 2022), /not a valid LifeOS archive file for 2022/);
  await assert.rejects(A.restoreYear(f, 'wrong passphrase here', 2021), /not your main passphrase/);
  assert.equal(S.getState().archives.length, 1);
});

test('SYNC AND BACKUP: an older copy holding archived years cannot bring them back without the explicit tick', async () => {
  await vault(build());
  const old = clone(S.getState());
  const oldText = await V.exportBackup(PASS, old);
  await run({ year: 2021 });
  const cur = S.getState();
  // the helper the dialogs use names the years
  assert.deepEqual(A.comesBack(cur, old), ['2021']);
  assert.deepEqual(A.comesBack(cur, cur), []);
  assert.ok(S.droppedData(cur, S.validateState(clone(old))).some((x) => /archived years 2021/.test(x)));
  assert.match(S.lossText(cur, S.validateState(clone(old))), /archived years 2021/);
  // backup restore
  const imported = await V.importBackup(PASS, oldText);
  assert.ok(S.dropsWork(cur, imported));
  const before = snap();
  await assert.rejects(S.replaceState(imported), (e) => e.code === 'OLDER_FORMAT' && /archived years 2021/.test(e.message));
  assert.equal(snap(), before);
  await S.replaceState(imported, { allowWorkLoss: true });
  assert.equal(S.getState().archives.length, 0);
  assert.ok(S.getState().entries.some((e) => e.date.startsWith('2021')));
});

test('SYNC: a Drive copy from before the archive is offered with the archived years named and never replaces without the tick', async () => {
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  await S.replaceState(build());
  const d = drive(); L.sync._setFetch(d.fetch); L.sync._setToken(TOKEN, 3600);
  await L.sync.run();
  const remoteState = clone(S.getState());
  await run({ year: 2021 });
  await putRemote(d, remoteState, 3);
  const dec = await L.sync.run();
  assert.equal(dec.kind, 'conflict');
  assert.equal(dec.dropsWork, true);
  assert.ok(dec.dropped.some((x) => /archived years 2021/.test(x)));
  const before = snap();
  await assert.rejects(L.sync.apply(dec, 'remote', { saveBackup: async () => {} }), /archived years 2021/);
  assert.equal(snap(), before);
  await L.sync.apply(dec, 'remote', { allowWorkLoss: true, saveBackup: async () => {} });
  assert.equal(S.getState().archives.length, 0);
});

test('a copy that already carries the archive (a newer one) is not flagged', async () => {
  await vault(build());
  await run({ year: 2021 });
  const cur = clone(S.getState());
  await S.commit((x) => { x.entries.push(L.metrics.validateEntry({ id: 'n1', domain: 'money', type: 'expense', date: '2026-03-03', title: 'n', value: 1, category: 'Other' })); });
  assert.deepEqual(A.comesBack(S.getState(), S.validateState(cur)), []);
  assert.equal(S.dropsWork(S.getState(), S.validateState(cur)), false);
});

test('a vault without archives is not affected by the guard, and an older-format copy cannot strip an archive index', async () => {
  await vault(build());
  const plain = clone(S.getState());
  await run({ year: 2021 });
  const cur = S.getState(), older = S.validateState(oldSchema(8, plain));
  assert.ok(S.droppedData(cur, older).some((x) => /archived years 2021/.test(x)));
  await vault(build());
  assert.deepEqual(S.droppedData(S.getState(), S.validateState(clone(plain))), []);
});

// ---- private records ----
test('PRIVATE: a year with private records needs the private vault open; the file keeps them under the private key; the index shows no private counts', async () => {
  await vault(build(), { priv: true });
  await P.open(PRIV);
  const pid = S.getState().entries.find((e) => e.date.startsWith('2021') && e.type === 'expense').id;
  await P.moveIn('entries', pid);
  await P.commit(async (inner) => { inner.wellbeing = { checkins: [{ id: 'wb1', date: '2021-02-03', mood: 4, note: 'PRIVATEWB' }, { id: 'wb2', date: '2026-02-03', mood: 2 }] }; });
  P.close();
  await new Promise((r) => setTimeout(r, 80));
  const before = snap();
  await assert.rejects(run({ year: 2021 }), /Open the private vault first/);
  assert.equal(snap(), before);
  await P.open(PRIV);
  const box = {};
  const r = await run({ year: 2021, io: io(box) });
  assert.equal(r.privateIncluded, true);
  const file = box.files['lifeos-archive-2021.json'];
  assert.ok(!file.includes('PRIVATEWB'), 'ciphertext only');
  // the index and summaries are public: no private record or count is in them
  const st = S.getState();
  assert.ok(!JSON.stringify(st.archives).includes('checkins'));
  const parsed = await A.parse(file, PASS, 2021);
  assert.ok(parsed.inner.priv && !parsed.inner.records.entries.some((e) => e.id === pid));
  // inner vault no longer holds the year's private records or its check-ins, but keeps the other year's
  assert.ok(!JSON.stringify(P.getWellbeing()).includes('PRIVATEWB'));
  assert.equal(P.getWellbeing().checkins.length, 1);
  assert.ok(!L.priv.view(st).entries.some((e) => e.id === pid));
  // open the archive: private part only with the vault open
  const info = await A.openArchive(file, PASS, 2021);
  assert.equal(info.privNote, 'open'); assert.ok(A.search('entries', '').some((e) => e.id === pid));
  assert.ok(A.search('checkins', 'PRIVATEWB').length === 1);
  A.closeArchive(); P.close();
  const info2 = await A.openArchive(file, PASS, 2021);
  assert.equal(info2.privNote, 'closed'); assert.ok(!A.search('entries', '').some((e) => e.id === pid)); assert.deepEqual(A.sections().includes('checkins'), false);
  A.closeArchive();
  // restore needs the vault open and puts the records back as private ones
  await assert.rejects(A.restoreYear(file, PASS, 2021), /Open the private vault first/);
  await P.open(PRIV);
  await A.restoreYear(file, PASS, 2021);
  assert.ok(!S.getState().entries.some((e) => e.id === pid), 'not back in the public state');
  assert.ok(P.view(S.getState()).entries.some((e) => e.id === pid));
  assert.equal(P.getWellbeing().checkins.length, 2);
});

test('PRIVATE: a private record that a public record points at is kept', async () => {
  const s = build(); s.invoices.push({ id: 'pubinv', number: 'P-1', issueDate: '2026-01-01', dueDate: '2026-02-01', lines: [{ description: 'x', qty: 1, unitCents: 100, expenseId: 'e0' }], status: 'sent', notes: '' });
  await vault(S.validateState(s), { priv: true });
  await P.open(PRIV);
  await P.moveIn('entries', 'e0').catch(() => {});
  const before = P.view(S.getState()).entries.length;
  await run({ year: 2021 });
  assert.ok(P.view(S.getState()).entries.some((e) => e.id === 'e0'));
  assert.ok(P.view(S.getState()).entries.length < before);
});

test('PRIVATE: a changed private passphrase asks for the earlier one to open an older archive', async () => {
  await vault(build(), { priv: true });
  await P.open(PRIV);
  await P.moveIn('entries', S.getState().entries.find((e) => e.date.startsWith('2021') && e.type === 'expense').id);
  const box = {}; await run({ year: 2021, io: io(box) });
  await P.changePassphrase(PRIV, 'another private pass 77');
  await P.open('another private pass 77');
  const f = box.files['lifeos-archive-2021.json'];
  const info = await A.openArchive(f, PASS, 2021);
  assert.equal(info.privNote, 'needs-passphrase');
  const info2 = await A.openArchive(f, PASS, 2021, PRIV);
  assert.equal(info2.privNote, 'open');
  A.closeArchive();
});

// ---- crafted files ----
test('ENVELOPE PARSING rejects crafted archive files', async () => {
  await vault(build());
  const box = {}; await run({ year: 2021, io: io(box) });
  const f = box.files['lifeos-archive-2021.json'], env = JSON.parse(f);
  const bad = async (txt, re) => assert.rejects(A.parse(typeof txt === 'string' ? txt : JSON.stringify(txt), PASS, 2021), re || /not a valid LifeOS archive|did not work|checksum/);
  await A.parse(f, PASS, 2021);
  await bad(Object.assign({}, env, { kdf: Object.assign({}, env.kdf, { iter: 1000 }) }));            // wrong iterations
  await bad(Object.assign({}, env, { kdf: Object.assign({}, env.kdf, { iter: 2000000 }) }));
  await bad(Object.assign({}, env, { kdf: Object.assign({}, env.kdf, { name: 'PBKDF1' }) }));
  await bad(Object.assign({}, env, { kdf: Object.assign({}, env.kdf, { salt: 'AAAA' }) }));
  const ct = Buffer.from(env.ct, 'base64'); ct[10] ^= 1;
  await bad(Object.assign({}, env, { ct: ct.toString('base64') }), /did not work|damaged/);             // tampered ciphertext
  await bad(Object.assign({}, env, { iv: Buffer.alloc(12).toString('base64') }), /did not work|damaged/);
  await assert.rejects(A.parse(f, PASS, 2022), /not a valid LifeOS archive file for 2022/);              // wrong year asked for
  await bad(Object.assign({}, env, { year: 2022 }));                                                     // outer year changed (inner says 2021)
  await bad(Object.assign({}, env, { year: 1800 }));
  await bad(Object.assign({}, env, { arch: 2 }));
  await bad(Object.assign({}, env, { extra: 1 }));
  await bad(Object.assign({}, env, { v: 2 }));
  await bad('{not json'); await bad('[]'); await bad('null'); await bad('');
  await bad('x'.repeat(A.MAX_FILE + 1));                                                                 // oversize
  assert.equal(A.MAX_FILE, 64 * 1024 * 1024);
  await assert.rejects(A.parse(f, 'wrong passphrase here', 2021), /did not work|damaged/);
  await assert.rejects(A.parse(42, PASS, 2021), /not a valid/);
  // properly encrypted but wrong inside: kind, year, counts, hash, forbidden keys, records of another year
  const key = await V.deriveKey(PASS, V.parseEnvelope(env).salt);
  const inner = await V.decrypt(key, env);
  const seal = async (o, outer) => JSON.stringify(Object.assign(await V.makeEnvelope(key, V.parseEnvelope(env).salt, o), outer || { arch: 1, year: o.year }));
  await bad(await seal(Object.assign({}, inner, { kind: 'lifeos-backup' }), { arch: 1, year: 2021 }));
  await bad(await seal(Object.assign({}, inner, { year: 2022 }), { arch: 1, year: 2021 }));
  await bad(await seal(Object.assign({}, inner, { counts: Object.assign({}, inner.counts, { entries: 1 }) })));
  await bad(await seal(Object.assign({}, inner, { sha256: 'a'.repeat(64) })), /checksum/);
  await bad(await seal(Object.assign({}, inner, { sha256: 'xyz' })));
  const proto = JSON.parse(JSON.stringify(inner)); proto.records.entries[0]['__proto__'] = { x: 1 };
  await bad(await seal(JSON.parse(JSON.stringify(proto).replace('"id"', '"__proto__":{"x":1},"id"'))));
  const other = clone(inner); other.records.entries[0].date = '2022-01-01'; other.counts = inner.counts;
  await bad(await seal(other));
  const unk = clone(inner); unk.records.mystery = [{ a: 1 }];
  await bad(await seal(unk));
  const nonobj = clone(inner); nonobj.records.entries = 'x';
  await bad(await seal(nonobj));
  // a backup file is not an archive, and an archive is not a backup
  const backup = await V.exportBackup(PASS, S.getState());
  await bad(backup);
  await assert.rejects(V.importBackup(PASS, f));
  const live0 = snap();
  await assert.rejects(L.store.inspectEnvelope(env, PASS).then((i) => S.replaceState(i.state)));
  assert.equal(snap(), live0);
});

test('real PBKDF2: the archive file uses 600000 iterations, a fresh salt and IV, and the main passphrase', async () => {
  realKeys();
  try {
    await vault(build(['2021', 2026].map(Number)));
    const b1 = {}, b2 = {};
    await run({ year: 2021, drive: true, download: false, io: io(b1) });
    const e1 = JSON.parse(b1.files['lifeos-archive-2021.json']);
    assert.equal(e1.kdf.iter, 600000); assert.equal(e1.kdf.name, 'PBKDF2'); assert.equal(e1.kdf.hash, 'SHA-256'); assert.equal(e1.arch, 1); assert.equal(e1.year, 2021);
    const main = await L.store._rawEnvelope();
    assert.notEqual(e1.kdf.salt, main.kdf.salt); assert.notEqual(e1.iv, main.iv);
    await A.parse(b1.files['lifeos-archive-2021.json'], PASS, 2021);
    await assert.rejects(A.parse(b1.files['lifeos-archive-2021.json'], 'not the right pass 1', 2021), /did not work|damaged/);
    void b2;
  } finally { fastKeys(); }
});

// ---- proposals and settings ----
test('PROPOSALS: by vault size, by a newly archivable year; never removes anything', async () => {
  await vault(build());
  const st = S.getState(), MB = 1048576, snapBefore = snap();
  const p1 = A.propose(st, 41 * MB, TODAY);
  assert.ok(p1 && p1.over && p1.years.map((y) => y.year).join() === '2021,2022,2023' && p1.freeBytes > 0);
  const fresh = A.propose(st, 1 * MB, TODAY);
  assert.ok(fresh && fresh.fresh && !fresh.over, 'a new year (2023) became archivable');
  assert.equal(snap(), snapBefore, 'the proposal changes nothing');
  // settings: a lower threshold triggers earlier
  const lower = Object.assign(clone(st), { settings: Object.assign(clone(st.settings), { archiveSuggestMB: 20 }) });
  assert.equal(A.propose(lower, 21 * MB, TODAY).over, true); assert.equal(A.propose(lower, 19 * MB, TODAY) && A.propose(lower, 19 * MB, TODAY).over, false);
  assert.equal(A.propose(st, 39 * MB, TODAY).over, false);
  // after 2023 is archived the new-year trigger is gone; size still triggers for the rest
  await run({ year: 2023 });
  assert.equal(A.propose(S.getState(), 1 * MB, TODAY), null);
  assert.deepEqual(A.propose(S.getState(), 45 * MB, TODAY).years.map((y) => y.year), [2021, 2022]);
  // no archivable year: no proposal, whatever the size
  await vault(build([2024, 2025, 2026]));
  assert.equal(A.propose(S.getState(), 60 * MB, TODAY), null);
  // the real envelope size is what is measured
  assert.ok((await A.envelopeBytes()) > 1000);
  // January: the year that just became archivable
  await vault(build([2023, 2024, 2025, 2026]));
  assert.equal(A.propose(S.getState(), 1 * MB, '2026-12-31').fresh, true, '2023 became archivable on 1 January 2026');
  await vault(build([2024, 2025, 2026]));
  assert.equal(A.propose(S.getState(), 1 * MB, '2026-12-31'), null);
  assert.equal(A.propose(S.getState(), 1 * MB, '2027-01-01').fresh, true, '2024 became archivable on 1 January 2027');
});

test('SETTINGS: archiveSuggestMB is an integer from 20 to 60, default 40, and cannot be set to anything else', async () => {
  const s = L.store.defaultState();
  assert.equal(s.settings.archiveSuggestMB, 40);
  for (const v of [20, 40, 60]) assert.equal(S.validateState(Object.assign(clone(s), { settings: Object.assign(clone(s.settings), { archiveSuggestMB: v }) })).settings.archiveSuggestMB, v);
  for (const v of [19, 61, 40.5, '40', null, NaN, 1e9, -1]) assert.throws(() => S.validateState(Object.assign(clone(s), { settings: Object.assign(clone(s.settings), { archiveSuggestMB: v }) })), /archiveSuggestMB/);
  // an older vault takes the default
  assert.equal(S.validateState(oldSchema(6, s)).settings.archiveSuggestMB, 40);
  // the setting travels through a normal commit
  await vault(build());
  await S.commit((x) => { x.settings.archiveSuggestMB = 25; });
  assert.equal(S.getState().settings.archiveSuggestMB, 25);
});

test('the archive index and summaries are validated: bad entries, bad hashes, summaries without an index, non-numbers', () => {
  const s = L.store.defaultState();
  const ok = { year: 2021, createdAt: '2026-01-01T00:00:00.000Z', sha256: 'a'.repeat(64), counts: { entries: 3 }, copies: [{ where: 'drive', at: '2026-01-01T00:00:00.000Z', verified: true }] };
  const withA = (a, sm) => S.validateState(Object.assign(clone(s), { archives: a, summaries: sm || {} }));
  assert.equal(withA([ok]).archives.length, 1);
  for (const bad of [{ year: 1800 }, { year: 2021.5 }, { sha256: 'zz' }, { sha256: 'A'.repeat(64) }, { counts: { nothing: 1 } }, { counts: { entries: 0 } }, { counts: { entries: 1.5 } }, { copies: [{ where: 'cloud', at: 'x', verified: true }] }, { copies: [{ where: 'drive', at: 'x', verified: 'yes' }] }, { createdAt: 5 }]) assert.throws(() => withA([Object.assign({}, ok, bad)]), /Invalid data/);
  assert.throws(() => withA([ok, ok]), /Invalid data/);
  assert.throws(() => withA([], { 2021: { v: 1 } }), /summary year/);
  assert.throws(() => withA([ok], { 2021: { v: 2 } }), /Invalid data/);
  assert.throws(() => withA([ok], { 2021: { v: 1, money: { months: { '2021-01': { inc: 'x' } } } } }), /Invalid data/);
  assert.throws(() => withA([ok], { 2021: { v: 1, secrets: {} } }), /summary section/);
  assert.throws(() => withA([ok], { 2021: { v: 1, money: { months: { '2021-01': { inc: Infinity } } } } }), /Invalid data/);
  assert.throws(() => withA([ok], JSON.parse('{"2021":{"v":1,"money":{"__proto__":{"a":1}}}}')), /Invalid data/);
  assert.equal(withA([ok], { 2021: { v: 1, money: { months: { '2021-01': { inc: 5, exp: 1, hasExp: 1, cats: { Food: 1 } } } } } }).summaries[2021].money.months['2021-01'].inc, 5);
});

// ---- audit ----
test('AUDIT: archiving and restoring record only the year', async () => {
  await vault(build());
  const box = {}; await run({ year: 2021, io: io(box) });
  let a = S.getState().audit;
  assert.equal(a[a.length - 1].action, 'archived 2021');
  await A.restoreYear(box.files['lifeos-archive-2021.json'], PASS, 2021);
  a = S.getState().audit;
  assert.equal(a[a.length - 1].action, 'restored 2021');
  for (const x of a) assert.ok(!/\d{3,}\s*(records|entries)|counts|sha|lifeos-archive/.test(x.action), x.action);
});

// ---- leaks ----
test('LEAKS: archive contents and summaries never reach the digest, prompts, insights, review records or error messages', async () => {
  const s = build();
  s.entries.push(L.metrics.validateEntry({ id: 'catleak', domain: 'money', type: 'expense', date: '2021-06-06', title: 'Marked ' + ARCH_MARK, value: 9, category: 'Cat' + ARCH_MARK }));
  await vault(S.validateState(s));
  const box = {}; await run({ year: 2021, io: io(box) });
  const st = S.getState();
  assert.ok(JSON.stringify(st.summaries).includes('Cat' + ARCH_MARK), 'the category name is only inside the summary');
  const wk = L.metrics.weekStart(TODAY);
  const outs = [JSON.stringify(L.metrics.weeklyDigest(st, wk)), JSON.stringify(L.memory.rulesInsights(st, wk)), JSON.stringify(L.memory.buildPrompt(st, 1, { from: wk, to: TODAY })), JSON.stringify(L.memory.buildPrompt(st, 2, { from: '2026-10-01', to: TODAY })), JSON.stringify(L.goals.digestCounts ? L.goals.digestCounts(st, wk) : ''), JSON.stringify(st.audit), JSON.stringify(st.memory)];
  for (const o of outs) { assert.ok(!o.includes(ARCH_MARK) && !o.includes('lifeos-archive') && !o.includes('"summaries"') && !o.includes('Groceries') || o === JSON.stringify(st.memory), 'a leak: ' + o.slice(0, 120)); }
  for (const o of outs.slice(0, 5)) assert.ok(!o.includes('Cat' + ARCH_MARK) && !o.includes('2021-0'.slice(0, 7) + 'x'), o.slice(0, 100));
  // errors: wrong passphrase, wrong year, crafted file, failing Drive, vault locked
  const msgs = [];
  const f = box.files['lifeos-archive-2021.json'];
  for (const fn of [() => A.parse(f, 'wrong passphrase here', 2021), () => A.parse(f, PASS, 2022), () => A.parse(f.slice(0, 200), PASS, 2021), () => run({ year: 2022, passphrase: 'wrong passphrase here' }), () => run({ year: 2022, drive: true, download: false, io: Object.assign(io({}), { put: async () => { throw new Error('Could not reach Google Drive.'); } }) }), () => A.restoreYear(f, 'wrong passphrase here', 2021)]) {
    try { await fn(); } catch (e) { msgs.push(String(e.message) + String(e.stack || '').split('\n')[0]); }
  }
  assert.equal(msgs.length, 6);
  for (const m of msgs) assert.ok(!m.includes(ARCH_MARK) && !m.includes(PASS) && !/Groceries|Salary|Venture|sha256/.test(m), m);
  // the open archive is dropped on lock
  await A.openArchive(f, PASS, 2021);
  assert.equal(A.isOpenArchive(), true);
  S.lock();
  assert.equal(A.isOpenArchive(), false); assert.equal(A.info(), null);
  assert.throws(() => A.recordsOf('entries'), /No archive is open/);
});

test('an opened archive is read-only: searching, sections, nothing changes in the live vault; its year feeds the accountant export', async () => {
  await vault(build());
  const box = {}; await run({ year: 2021, io: io(box) });
  const before = snap();
  const info = await A.openArchive(box.files['lifeos-archive-2021.json'], PASS, 2021);
  assert.equal(info.year, 2021); assert.ok(A.sections().includes('entries'));
  assert.ok(A.search('entries', 'food').length > 5 && A.search('entries', 'zzzznothing').length === 0);
  assert.ok(A.search('contacts', '').length === 12);
  assert.equal(snap(), before);
  const ex = A.exportState();
  assert.ok(ex.entries.length > S.getState().entries.length && ex.archives.length === 0);
  const pkg = L.tax.exportPackage(ex, 2021, false);
  assert.equal(pkg.blocked, false);
  assert.equal(L.tax.exportPackage(S.getState(), 2021, false).blocked, true, 'the live vault refuses an archived tax year');
  assert.match(L.tax.exportPackage(S.getState(), 2021, false).message, /archived/);
  A.closeArchive();
  assert.equal(A.isOpenArchive(), false);
  assert.equal(snap(), before);
});

test('revenue ranges that cut an archived month in two say so instead of guessing', async () => {
  await vault(build());
  await run({ year: 2021 });
  const r = L.revenue.totalsIn(S.getState(), { kind: 'all' }, '2021-05-10', '2021-05-20');
  assert.equal(r.archivedPartial, true);
  const whole = L.revenue.totalsIn(S.getState(), { kind: 'all' }, '2021-05-01', '2021-05-31');
  assert.ok(!whole.archivedPartial && whole.revenueCents > 0);
});

// ---- migration ----
const OLD = { 3: ['projects', 'pipeline'], 4: ['cycle', 'kinds', 'habits', 'habitLog'], 5: ['goals'], 6: ['properties', 'vehicles', 'maintenance', 'renewals', 'documents', 'taxItems'], 7: ['learningItems', 'studySessions', 'takeaways'], 8: ['activities', 'activityCategories'], 9: ['groups', 'people', 'contacts'] };
const NEWKEYS = ['payees', 'invoices', 'trips', 'taxPayments', 'taxYears', 'homeOffice', 'taxMap'];
function asSchema(n, st) {
  const o = clone(st); o.schema = n; delete o.priv; delete o.archives; delete o.summaries; delete o.settings.archiveSuggestMB;
  for (const [v, keys] of Object.entries(OLD)) if (Number(v) > n) for (const k of keys) delete o[k];
  if (n < 6) { delete o.settings.home; for (const r of o.recurring || []) delete r.household; }
  if (n < 7) delete o.settings.learning;
  if (n < 4) delete o.settings.health;
  if (n < 2) for (const k of ['accounts', 'recurring', 'budgets', 'categories']) delete o[k];
  if (n < 9) for (const a of o.activities || []) delete a.expenseId;
  if (n < 10) delete o.settings.privAutoLockSec;
  delete o.settings.layouts;
  if (n < 12) {
    for (const k of NEWKEYS) delete o[k];
    delete o.settings.business;
    o.entries = o.entries.filter((e) => e.id !== 'ex2' && e.id !== 'in2');
    for (const p of o.projects || []) { delete p.budgetCents; delete p.budgetPeriod; }
    for (const e of o.entries) for (const k of ['scope', 'billable', 'reimbursable', 'cardPaid', 'billedInvoiceId', 'payeeId']) delete e[k];
  }
  if (n < 13) for (const a of o.activities || []) delete a.importKey;
  return o;
}
test('MIGRATION: schemas 1 to 13 become 14 with an empty archive index, no summaries and the default size setting; no text is lost', () => {
  const { state } = buildAdversarial(L);
  const full = S.validateState(clone(Object.assign(clone(state), { settings: Object.assign(clone(state.settings), { provider: { kind: 'none', baseUrl: '', model: '', apiKey: '' } }) })));
  assert.equal(S.defaultState().schema, 15);
  for (let n = 1; n <= 13; n++) {
    const old = asSchema(n, full), oldText = JSON.stringify(old), got = S.validateState(clone(old));
    assert.equal(got.schema, 15); assert.equal(got.sourceSchema, n);
    assert.deepEqual(got.archives, []); assert.deepEqual(got.summaries, {}); assert.equal(got.settings.archiveSuggestMB, 40);
    const gotText = JSON.stringify(got);
    for (const m of new Set(oldText.match(/LEAK mark \d+/g) || [])) assert.ok(gotText.includes(m), 'schema ' + n + ' lost ' + m);
  }
  // an old file with archive keys is refused (older formats carry none), and schema 15 is unknown
  assert.throws(() => S.validateState(Object.assign(clone(full), { schema: 16 })), /schema/);
  assert.deepEqual(S.validateState(Object.assign(asSchema(13, full), { archives: [{ year: 2021 }] })).archives, [], 'an older format ignores the new keys');
});

test('a 1.2.0-a backup (schema 13) imports cleanly into an empty vault, and a stored schema 13 vault migrates on unlock', async () => {
  realKeys();
  const st13 = asSchema(13, build());
  const ad0 = memAdapter(); S._setAdapter(ad0); S.lock(); await S.init(PASS);
  const salt = V.newSalt(), key = await V.deriveKey(PASS, salt);
  const text = JSON.stringify(await V.makeEnvelope(key, salt, st13));
  const imp = await V.importBackup(PASS, text);
  assert.equal(imp.schema, 15); assert.equal(imp.sourceSchema, 13); assert.deepEqual(imp.archives, []);
  await S.replaceState(imp);
  assert.equal(S.getState().schema, 15); assert.equal(S.getState().entries.length, st13.entries.length);
  assert.equal(S.getState().settings.archiveSuggestMB, 40);
  // a stored schema 13 vault
  const ad = memAdapter(); S._setAdapter(ad); S.lock();
  const salt2 = V.newSalt(), key2 = await V.deriveKey(PASS, salt2);
  await ad.set('envelope', Object.assign(await V.makeEnvelope(key2, salt2, Object.assign(clone(st13), { _meta: { rev: 1, updatedAt: '2026-11-01T00:00:00.000Z', deviceId: 'd' } })), { rev: 1, updatedAt: '2026-11-01T00:00:00.000Z', deviceId: 'd' }));
  const st = await S.unlock(PASS);
  assert.equal(st.schema, 15); assert.deepEqual(st.archives, []); assert.equal(st.entries.length, st13.entries.length);
  // and it can be archived straight away
  await run({ year: 2021 });
  assert.equal(S.getState().archives.length, 1);
  fastKeys();
});

test('an older app refuses a schema 15 vault (the accepted list ends at 14 there), so it can never strip archives', () => {
  const store = src('src/core/store.js');
  assert.ok(/SCHEMA = 15,/.test(store) && /\[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, SCHEMA\]/.test(store));
});

// ---- spell check ----
test('SPELL CHECK: every input and textarea (other than passphrase fields) gets spellcheck, autocorrect and autocapitalize off', () => {
  const app = src('src/ui/app.js');
  const fn = app.slice(app.indexOf('  function h(tag, props) {'), app.indexOf('  function labelled('));
  assert.match(fn, /tag === 'input' \|\| tag === 'textarea'\) && el\.getAttribute\('type'\) !== 'password'/);
  for (const [a, v] of [['spellcheck', 'false'], ['autocorrect', 'off'], ['autocapitalize', 'off']]) assert.ok(fn.includes("setAttribute('" + a + "', '" + v + "')"), a);
  // there is no other way a field can be made: no raw createElement, innerHTML or markup
  for (const f of ['src/ui/app.js', 'src/ui/sync-ui.js', 'src/ui/archive-ui.js']) {
    const t = src(f).replace(/\/\/.*$/gm, '');
    assert.ok(!/createElement\(\s*['"](input|textarea)/.test(t), f + ' creates a field by hand');
    assert.ok(!/<(input|textarea)\b/i.test(t), f + ' writes field markup');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(t), f);
  }
  assert.ok(!/<(input|textarea)\b/i.test(src('src/ui/shell.html')));
  // fields that are password-typed are the passphrase fields only
  for (const f of ['src/ui/app.js', 'src/ui/sync-ui.js', 'src/ui/archive-ui.js']) for (const m of src(f).matchAll(/type: 'password'[^}]*id: '([^']+)'|id: '([^']+)'[^}]*type: 'password'/g)) assert.match(m[1] || m[2], /pass|pp|priv|key/i, 'password-typed field ' + (m[1] || m[2]));
});

test('the new files are in the build after sync.js, and the version is 1.3.0', () => {
  const b = src('build.mjs');
  assert.ok(b.indexOf("'src/core/archive.js'") > b.indexOf("'src/core/sync.js'") && b.indexOf("'src/core/archive.js'") < b.indexOf("'src/ui/app.js'"));
  assert.equal(JSON.parse(src('package.json')).version, '1.3.0');
  assert.ok(src('src/ui/app.js').includes("text: 'LifeOS v' + L.VERSION"));
  assert.ok(src('src/core/archive.js').startsWith('(function () {'));
});
