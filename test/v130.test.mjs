// v1.3.0 "Safe to live in": storage, backup safety, release engineering, diagnostics, check-live, smoke timeout.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { L, PASS, memAdapter } from './_load.mjs';
import { fastKeys, realKeys, clone } from './_archive.mjs';
import { versionOf, syncDocs, build, buildAll } from '../build.mjs';
import { run as checkLive, parseHeadersFile, metaCsp } from '../scripts/check-live.mjs';

// Live views: other test files run the built bundle in this process, which replaces the L.* modules with fresh copies.
const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), O = view('ops'), V = view('vault');
const ROOT = new URL('..', import.meta.url).pathname;
const src = (f) => readFileSync(join(ROOT, f), 'utf8');
const MARK = 'LEAKMARK-v130-zq81';
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { S.lock(); } catch (e) { /* locked */ } realKeys(); } });
const open = async () => { const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS); return ad; };
const fresh = () => S.validateState(S.defaultState());

// ---------- B6: one version source ----------
test('B6 version: package.json is the only source; the app, README, HANDOFF and the built file all agree, and a mismatch is caught', () => {
  const v = JSON.parse(src('package.json')).version;
  assert.equal(v, '1.3.0'); assert.equal(versionOf(ROOT), v);
  const app = src('src/ui/app.js');
  assert.ok(!/LifeOS v\d/.test(app), 'no literal version in app.js');
  assert.ok(app.includes("text: 'LifeOS v' + L.VERSION"));
  const marks = (f) => [...src(f).matchAll(/<!--version-->([^<]*)<!--\/version-->/g)].map((m) => m[1]);
  assert.deepEqual(marks('README.md'), [v]); assert.deepEqual(marks('docs/HANDOFF.md'), [v]);
  assert.ok(build().includes('globalThis.LifeOS.VERSION = "' + v + '"'));
  assert.ok(src('dist/lifeos.html').includes('globalThis.LifeOS.VERSION = "' + v + '"'), 'dist is built from this version (run node build.mjs)');
  // any version-looking declaration in the shipped sources, scripts, workflows, README or the HANDOFF header must equal it
  const files = ['build.mjs', 'README.md', 'package.json', 'scripts/check-live.mjs', '.github/workflows/tag-release.yml'];
  for (const d of ['src/core', 'src/ui']) for (const f of readdirSync(join(ROOT, d))) files.push(d + '/' + f);
  for (const f of files) for (const m of src(f).matchAll(/LifeOS v(\d+\.\d+\.\d+)|"version"\s*:\s*"([^"]+)"|<!--version-->([^<]*)<!--\/version-->/g)) assert.equal(m[1] || m[2] || m[3], v, f + ' disagrees');
  assert.equal([...src('docs/HANDOFF.md').split('\n').slice(0, 3).join('\n').matchAll(/<!--version-->([^<]*)</g)][0][1], v);
  // build.mjs and the workflow read package.json instead of carrying a number
  assert.ok(/versionOf/.test(src('build.mjs')) && /package\.json/.test(src('.github/workflows/tag-release.yml')));
});
test('B6 version: syncDocs reports a HANDOFF or README that disagrees or lost its marker, and rewrites README', () => {
  const root = mkdtempSync(join(tmpdir(), 'lifeos-ver-')); mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'package.json'), '{"version":"2.0.1"}');
  writeFileSync(join(root, 'README.md'), 'x <!--version-->1.0.0<!--/version--> y');
  writeFileSync(join(root, 'docs/HANDOFF.md'), 'Version <!--version-->1.0.0<!--/version-->');
  const p = syncDocs(root);
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'x <!--version-->2.0.1<!--/version--> y');
  assert.equal(p.length, 1); assert.match(p[0], /HANDOFF.*1\.0\.0.*2\.0\.1/);
  writeFileSync(join(root, 'docs/HANDOFF.md'), 'no marker'); assert.match(syncDocs(root).join(), /HANDOFF.*no <!--version--> marker/);
  writeFileSync(join(root, 'package.json'), '{"version":"two"}'); assert.throws(() => versionOf(root), /needs a version/);
  writeFileSync(join(root, 'package.json'), 'nope'); assert.throws(() => versionOf(root), /not readable/);
});
test('B6 workflow: tags v<version> on push to main with only the default token and contents write; manual backfill input; no wrangler or Worker config', () => {
  const y = src('.github/workflows/tag-release.yml');
  assert.match(y, /on:\s*\n\s*push:\s*\n\s*branches: \[main\]/); assert.match(y, /workflow_dispatch:/);
  assert.match(y, /inputs:\s*\n\s*version:/); assert.match(y, /\n\s+commit:/);
  assert.match(y, /permissions:\s*\n\s*contents: write\n/);
  assert.equal((y.match(/permissions:/g) || []).length, 1); assert.ok(!/pull-requests|id-token|actions:|packages:|issues:/.test(y));
  assert.ok(!/secrets\./.test(y), 'no secret is used'); assert.ok(!/GITHUB_TOKEN|token:/.test(y.replace(/#.*$/gm, '')), 'only the default token, never passed explicitly');
  assert.match(y, /git ls-remote --exit-code --tags origin/); assert.match(y, /tag="v\$version"/);
  assert.match(y, /\[0-9a-f\]\{40\}/);
  for (const f of ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 'worker.js', 'worker.ts', 'src/worker.js']) assert.ok(!existsSync(join(ROOT, f)), f + ' must not exist');
  assert.ok(!readdirSync(ROOT).some((f) => /wrangler/i.test(f)));
});
test('B6 runbook: the backfill runs name the real commits of v1.0.0, v1.1.0 and v1.2.0; the sections the spec lists are there', () => {
  const r = src('docs/RUNBOOK.md');
  const want = { '1.0.0': '3e0fd18', '1.1.0': '3592f5e', '1.2.0': '90be566' };
  for (const [ver, short] of Object.entries(want)) {
    const full = new RegExp('`' + ver.replace(/\./g, '\\.') + '` \\| `([0-9a-f]{40})`').exec(r);
    assert.ok(full, 'table row for ' + ver); assert.ok(full[1].startsWith(short));
    assert.ok(r.includes('-f version=' + ver + ' -f commit=' + full[1]));
    try { assert.equal(execFileSync('git', ['-C', ROOT, 'show', '-s', '--format=%H', full[1]], { encoding: 'utf8' }).trim(), full[1]); } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; /* no git history here */ }
  }
  for (const h of ['How the live copy deploys', 'Roll back', 'schema rule', 'Verify a release', 'If the vault will not open', 'wrangler']) assert.ok(r.includes(h), h);
  assert.ok(/Cloudflare builds and deploys from the `main` branch/.test(r));
});
test('B6 docs: CHANGELOG runs newest first from 1.3.0 to 0.1.0; no em dashes and no advice wording in the new docs and the UI copy', () => {
  const c = src('docs/CHANGELOG.md');
  const heads = [...c.matchAll(/^## (\d+\.\d+\.\d+)/gm)].map((m) => m[1]);
  assert.equal(heads[0], '1.3.0'); assert.equal(heads[heads.length - 1], '0.1.0'); assert.equal(heads.length, 15);
  const num = (v) => v.split('.').map(Number).reduce((a, n) => a * 1000 + n, 0);
  assert.deepEqual(heads.slice().sort((a, b) => num(b) - num(a)), heads);
  for (const f of ['docs/CHANGELOG.md', 'docs/RUNBOOK.md', 'docs/FIRST-RUN.md', 'docs/SYNC-SETUP.md', 'src/core/ops.js', 'src/ui/app.js', 'scripts/check-live.mjs']) assert.ok(!src(f).includes('—'), f + ' has an em dash');
  const copy = src('src/ui/app.js').slice(src('src/ui/app.js').indexOf('// ---------- backup safety, storage and diagnostics (v1.3.0)'), src('src/ui/app.js').indexOf('// ---------- dashboard ----------'));
  assert.ok(copy.length > 3000 && !/\b(you should|we recommend|recommended|consider|best practice)\b/i.test(copy));
});

// ---------- B6: smoke timeout, smoke-command ----------
test('B6 smokes: a per-script time limit fails a hanging script with TIMEOUT, passes a quick one and reports slow ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeos-smk-'));
  writeFileSync(join(dir, 'smoke-a-quick.mjs'), "console.log('quick done');");
  writeFileSync(join(dir, 'smoke-b-hang.mjs'), 'setInterval(() => {}, 1000);');
  const r = spawnSync(process.execPath, [join(ROOT, 'test/smokes.mjs'), '--dir=' + dir, '--timeout=2', '--slow=1'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1); assert.match(r.stdout, /ok   smoke-a-quick\.mjs/); assert.match(r.stdout, /FAIL smoke-b-hang\.mjs \(\d+ s\) TIMEOUT after 2 s/);
  assert.match(r.stdout, /SLOW \(over 1 s\): smoke-b-hang\.mjs/); assert.match(r.stdout, /SMOKES: 1 of 2 failed: smoke-b-hang\.mjs/);
  const s = src('test/smokes.mjs'); assert.ok(/LIFEOS_SMOKE_TIMEOUT_S', 420/.test(s));
});
test('B6 smoke-command: the 15 s wait for a selector that only exists on the private screen is gone', () => {
  const s = src('test/smoke-command.mjs');
  assert.ok(!s.includes('.entry[data-key]'));
  assert.ok(s.includes("page.waitForSelector('.entry-t:has-text(\"' + title + '\")', T)"));
});

// ---------- schema 15 ----------
test('schema 15: a schema 14 backup imports with default ops and settings; ops and settings are validated; ops are kept on restore', async () => {
  realKeys(); // importBackup derives with the real key function
  await open();
  const st14 = clone(S.getState()); st14.schema = 14; delete st14.ops; delete st14.settings.backupReminderDays; delete st14.settings.syncReminder;
  const salt = V.newSalt(), key = await V.deriveKey(PASS, salt);
  const imp = await V.importBackup(PASS, JSON.stringify(await V.makeEnvelope(key, salt, st14)));
  assert.equal(imp.schema, 15); assert.equal(imp.sourceSchema, 14); assert.deepEqual(imp.ops, O.defaultOps()); assert.equal(imp.settings.backupReminderDays, 7); assert.equal(imp.settings.syncReminder, false);
  // a stored schema 14 vault migrates on unlock
  const ad = memAdapter(); S._setAdapter(ad); S.lock();
  const s2 = V.newSalt(), k2 = await V.deriveKey(PASS, s2);
  await ad.set('envelope', Object.assign(await V.makeEnvelope(k2, s2, Object.assign(clone(st14), { _meta: { rev: 3, updatedAt: '2026-11-01T00:00:00.000Z', deviceId: 'd' } })), { rev: 3, updatedAt: '2026-11-01T00:00:00.000Z', deviceId: 'd' }));
  const st = await S.unlock(PASS); assert.equal(st.schema, 15); assert.deepEqual(st.ops, O.defaultOps());
  // validation
  const bad = (f) => assert.throws(() => S.validateState(Object.assign(clone(fresh()), f(clone(fresh())))), /Invalid data/);
  for (const d of [0, 61, 1.5, '7', null]) bad((x) => ({ settings: Object.assign(x.settings, { backupReminderDays: d }) }));
  for (const d of [1, 60]) assert.equal(S.validateState(Object.assign(clone(fresh()), { settings: Object.assign(fresh().settings, { backupReminderDays: d }) })).settings.backupReminderDays, d);
  bad((x) => ({ settings: Object.assign(x.settings, { syncReminder: 'yes' }) }));
  bad((x) => ({ ops: Object.assign(x.ops, { lastBackupAt: '2026-13-40' }) }));
  bad((x) => ({ ops: Object.assign(x.ops, { safeRev: -1 }) }));
  bad((x) => ({ ops: Object.assign(x.ops, { persist: { result: 'maybe', at: '' } }) }));
  bad((x) => ({ ops: 'x' })); bad((x) => ({ ops: Object.assign(x.ops, { diag: 'x' }) }));
  bad((x) => ({ ops: Object.assign(x.ops, { diag: [{ at: 'now', code: 'DECRYPT_FAIL', area: 'sync' }] }) }));
  // restore of an older-format backup keeps this device's ops and reminder settings
  await open();
  await S.commit((x) => { O.markBackup(x, '2026-11-01', 5); x.settings.backupReminderDays = 14; x.settings.syncReminder = true; });
  await S.replaceState(imp);
  assert.equal(S.getState().ops.lastBackupAt, '2026-11-01'); assert.equal(S.getState().settings.backupReminderDays, 14); assert.equal(S.getState().settings.syncReminder, true);
});
test('schema 15: the sync fingerprint ignores ops (so backup dates and diagnostics never look like a local change), and an older app refuses schema 15', async () => {
  await open();
  const fp = await L.sync.fingerprint(S.getState());
  await S.commit((x) => { O.markBackup(x, '2026-11-02', 9); O.push(x.ops, { at: '2026-11-02T10:00:00.000Z', code: 'DECRYPT_FAIL', area: 'lock' }); }, { quiet: true });
  assert.equal(await L.sync.fingerprint(S.getState()), fp);
  await S.commit((x) => { x.settings.backupReminderDays = 9; });
  assert.notEqual(await L.sync.fingerprint(S.getState()), fp, 'a setting is still a change');
  assert.ok(/\[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, SCHEMA\]/.test(src('src/core/store.js')));
});

// ---------- B1 persistent storage ----------
test('B1: persist is requested, a granted answer is recorded; a granted store is not asked again; missing, refusing and throwing APIs never block', async () => {
  await open();
  const calls = [];
  const mk = (o) => Object.assign({ persist: async () => { calls.push('persist'); return true; } }, o);
  assert.equal(await O.persistOnUnlock(mk({}), '2026-11-10'), 'granted');
  assert.deepEqual(S.getState().ops.persist, { result: 'granted', at: '2026-11-10' }); assert.deepEqual(calls, ['persist']);
  // already granted and still persisted: no new request, no write
  const rev = S.getMeta().rev;
  assert.equal(await O.persistOnUnlock(mk({ persisted: async () => true }), '2026-11-11'), 'granted'); assert.deepEqual(calls, ['persist']); assert.equal(S.getMeta().rev, rev);
  assert.equal(S.getState().ops.persist.at, '2026-11-10');
  // revoked: asked again
  await O.persistOnUnlock(mk({ persisted: async () => false, persist: async () => false }), '2026-11-12'); assert.deepEqual(S.getState().ops.persist, { result: 'denied', at: '2026-11-12' });
  // no API at all, no storage object, throwing and rejecting APIs
  assert.equal(await O.requestPersist(undefined), 'unavailable'); assert.equal(await O.requestPersist({}), 'unavailable'); assert.equal(await O.requestPersist({ persist: 5 }), 'unavailable');
  assert.equal(await O.requestPersist({ persist: async () => { throw new Error(MARK); } }), 'error');
  assert.equal(await O.requestPersist({ persist() { throw new Error(MARK); } }), 'error');
  assert.equal(await O.requestPersist({ persisted: async () => { throw new Error('x'); }, persist: async () => true }), 'granted', 'a failing persisted() falls through to asking');
  assert.equal(await O.persistOnUnlock(undefined, '2026-11-13'), 'unavailable'); assert.equal(S.getState().ops.persist.result, 'unavailable');
  // an erroring persist records a code (never the message) and the app carries on
  assert.equal(await O.persistOnUnlock({ persist: async () => { throw new Error(MARK); } }, '2026-11-14'), 'error');
  O._reset();
  assert.ok(S.isUnlocked());
  assert.equal(O.storageText(true), 'Storage: kept by the browser'); assert.equal(O.storageText(false), 'Storage: may be cleared by the browser'); assert.equal(O.storageText(null), 'Storage: may be cleared by the browser');
});
test('B1: estimate returns usage and quota, and null (never a throw) when the API is missing, rejects or answers nonsense', async () => {
  assert.deepEqual(await O.estimate({ estimate: async () => ({ usage: 1536, quota: 1e9 }) }), { usage: 1536, quota: 1e9 });
  assert.deepEqual(await O.estimate({ estimate: async () => ({ usage: 10 }) }), { usage: 10, quota: null });
  assert.equal(await O.estimate(undefined), null); assert.equal(await O.estimate({}), null);
  assert.equal(await O.estimate({ estimate: async () => ({ usage: 'a' }) }), null); assert.equal(await O.estimate({ estimate: async () => null }), null);
  assert.equal(await O.estimate({ estimate: async () => { throw new Error(MARK); } }), null);
  assert.equal(await O.estimate({ estimate() { throw new Error(MARK); } }), null);
  assert.ok(O._pending().every((d) => d.code === 'STORAGE_ESTIMATE_ERROR' && !JSON.stringify(d).includes(MARK)));
  assert.equal(O.bytesText(0), '0 bytes'); assert.equal(O.bytesText(1536), '1.5 KB'); assert.equal(O.bytesText(5 * 1048576), '5.0 MB'); assert.equal(O.bytesText(-1), 'unknown');
  // the UI wraps both calls so a missing storage object cannot break unlock or Settings
  const app = src('src/ui/app.js'); assert.ok(/persistOnUnlock\(navigator\.storage, today\(\)\)\.catch/.test(app)); assert.ok(/navigator\.storage \|\| null/.test(app));
});

// ---------- B2 backup safety ----------
const withOps = (o, set) => { const s = fresh(); Object.assign(s.ops, o); Object.assign(s.settings, set || {}); return s; };
test('B2 reminder: due by days (default 7, range 1 to 60), by more than 200 saves, or never backed up; the latest of backup and sync counts', () => {
  const T = '2026-11-10';
  assert.equal(O.reminder(withOps({ lastBackupAt: '2026-11-04' }), T, 0).due, false, '6 days');
  let r = O.reminder(withOps({ lastBackupAt: '2026-11-03' }), T, 0); assert.deepEqual([r.due, r.why, r.days], [true, 'days', 7]);
  assert.equal(O.reminder(withOps({ lastBackupAt: '2026-11-03', lastSyncAt: '2026-11-08' }), T, 0).due, false, 'a recent sync counts');
  assert.equal(O.reminder(withOps({ lastBackupAt: '2026-11-09', lastSyncAt: '2026-10-01' }), T, 0).due, false, 'a recent backup counts');
  assert.equal(O.reminder(withOps({ lastBackupAt: '2026-11-09' }, { backupReminderDays: 1 }), T, 0).due, true, 'interval 1');
  assert.equal(O.reminder(withOps({ lastBackupAt: '2026-10-11' }, { backupReminderDays: 60 }), T, 0).due, false, '30 days of 60');
  assert.equal(O.reminder(withOps({ lastBackupAt: '2026-09-11' }, { backupReminderDays: 60 }), T, 0).due, true, '60 days of 60');
  // by save count: rev minus the revision at the last backup or sync, more than 200
  assert.equal(O.reminder(withOps({ lastBackupAt: T, safeRev: 10 }), T, 210).due, false); assert.equal(O.savesSince(withOps({ safeRev: 10 }), 210), 200);
  r = O.reminder(withOps({ lastBackupAt: T, safeRev: 10 }), T, 211); assert.deepEqual([r.due, r.why, r.saves], [true, 'saves', 201]);
  // never backed up: due once there is a change, not for an empty vault
  assert.equal(O.reminder(withOps({}), T, 0).due, false); r = O.reminder(withOps({}), T, 1); assert.deepEqual([r.due, r.why], [true, 'never']);
  assert.equal(O.savesSince(withOps({ safeRev: 50 }), 20), 0, 'a restore that lowers the revision never counts negative');
  assert.equal(O.reminder(withOps({ lastBackupAt: '2026-12-01' }), T, 0).due, false, 'a date in the future is not older than the interval');
});
test('B2 reminder: snooze hides it for one day only; a backup or sync resets it; dates across a month and a year end', () => {
  const T = '2026-11-10', s = withOps({ lastBackupAt: '2026-10-01' });
  assert.equal(O.reminder(s, T, 0).due, true);
  O.snooze(s, T); assert.equal(s.ops.snoozeUntil, '2026-11-11');
  let r = O.reminder(s, T, 0); assert.deepEqual([r.due, r.snoozed, r.why], [false, true, 'days']);
  assert.equal(O.reminder(s, '2026-11-11', 0).due, true, 'back the next day');
  const y = withOps({}); O.snooze(y, '2026-12-31'); assert.equal(y.ops.snoozeUntil, '2027-01-01'); O.snooze(y, '2028-02-28'); assert.equal(y.ops.snoozeUntil, '2028-02-29');
  s.ops.saves = 0; O.snooze(s, T); O.markBackup(s, T, 42); assert.deepEqual([s.ops.lastBackupAt, s.ops.backupRev, s.ops.safeRev, s.ops.snoozeUntil], [T, 42, 42, '']);
  assert.equal(O.reminder(s, T, 42).due, false);
  const t = withOps({ lastBackupAt: '2026-09-01', snoozeUntil: '2026-11-11' }); O.markSync(t, T, 77); assert.deepEqual([t.ops.lastSyncAt, t.ops.safeRev, t.ops.snoozeUntil, t.ops.lastBackupAt], [T, 77, '', '2026-09-01']);
  assert.equal(O.daysBetween('2026-12-30', '2027-01-02'), 3); assert.equal(O.addDays('2026-03-08', 1), '2026-03-09');
  assert.doesNotThrow(() => S.validateState(S.defaultState()));
});
test('B2: a real save raises the revision (the save count), a quiet bookkeeping write does not, sync stamps lastSyncAt, restore keeps the device dates', async () => {
  await open();
  assert.equal(O.savesSince(S.getState(), S.getMeta().rev), 0);
  await S.commit((x) => { x.settings.autoLockMin = 20; }); await S.commit((x) => { x.settings.autoLockMin = 21; });
  assert.equal(O.savesSince(S.getState(), S.getMeta().rev), 2);
  await S.commit((x) => { x.settings.autoLockMin = 22; }, { quiet: true });
  assert.equal(O.savesSince(S.getState(), S.getMeta().rev), 2);
  assert.equal(O.reminder(S.getState(), '2026-11-10', S.getMeta().rev).why, 'never');
  // a sync stamps the date and zeroes the count (in-sync result and upload)
  const d = (await import('./_v070.mjs')); const dr = d.drive();
  L.sync._setFetch(dr.fetch); L.sync._setToken(d.TOKEN, 3600);
  await S.commit((x) => { x.settings.sync.clientId = 'abc.apps.googleusercontent.com'; });
  assert.equal((await L.sync.run({})).kind, 'uploaded');
  const today = L.metrics.todayISO();
  assert.equal(S.getState().ops.lastSyncAt, today); assert.equal(O.savesSince(S.getState(), S.getMeta().rev), 0);
  await S.commit((x) => { x.settings.autoLockMin = 25; });
  assert.equal(O.savesSince(S.getState(), S.getMeta().rev), 1);
  assert.equal((await L.sync.run({})).kind, 'uploaded');
  assert.equal(O.savesSince(S.getState(), S.getMeta().rev), 0);
  assert.equal((await L.sync.run({})).kind, 'in-sync'); assert.equal(S.getState().ops.lastSyncAt, today);
  // the two dates are dates only
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(S.getState().ops.lastSyncAt) && S.getState().ops.lastBackupAt === '');
  L.sync._setToken(null, 0); L.sync._setFetch(undefined);
});
test('B2 reminders are offered, never automatic: the banner only opens a dialog or snoozes; the sync notice only sets a notice', () => {
  const app = src('src/ui/app.js');
  const banner = app.slice(app.indexOf('function backupBanner()'), app.indexOf('function fillStorage('));
  assert.ok(/btn\('Export backup', exportDialog/.test(banner) && /btn\('Snooze one day'/.test(banner));
  assert.ok(!/runExport|exportBackup|L\.sync\.run/.test(banner), 'the banner itself exports nothing');
  const dlg = app.slice(app.indexOf('function exportDialog()'), app.indexOf('// Never automatic: the banner'));
  assert.ok(/openDialog\(/.test(dlg) && /passOnly\('rem-pass'/.test(dlg));
  const un = app.slice(app.indexOf('function unsynced()'), app.indexOf('L.ops.install(window);'));
  assert.ok(!/L\.sync\.run|L\.sync\.apply|download\(/.test(un) && /setNotice\('ok', SYNC_NOTE\)/.test(un) && /syncReminder/.test(un));
  assert.ok(/syncReminder: false/.test(src('src/core/store.js')), 'sync reminder is off by default');
});

// ---------- B2 verify a backup file ----------
const adapterJson = (ad) => JSON.stringify([...ad._m.entries()]);
test('B2 verify: a good file shows schema, revision, date and counts against the vault, and writes nothing', async () => {
  realKeys();
  const ad = await open();
  await S.commit((x) => { x.entries.push(L.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2026-11-10', title: 'Lunch', value: 9.5, category: 'Dining' })); x.accounts.push({ id: 'a1', name: 'Main', kind: 'cash', liability: false, archived: false }); });
  const copy = clone(S.getState()); O.markBackup(copy, '2026-11-09', S.getMeta().rev);
  const file = await V.exportBackup('backup passphrase 1', copy);
  await S.commit((x) => { x.entries.push(L.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2026-11-11', title: 'Later', value: 1, category: 'Dining' })); });
  const before = adapterJson(ad), rev = S.getMeta().rev, pend = O._pending().length, live = clone(S.getState());
  const r = await O.verifyBackup('backup passphrase 1', file, S.getState());
  assert.equal(r.ok, true); assert.equal(r.schema, 15); assert.equal(r.sourceSchema, 15); assert.equal(r.madeOn, '2026-11-09'); assert.equal(r.rev, copy.ops.backupRev); assert.ok(r.rev >= 1);
  assert.deepEqual(r.rows.find((x) => x.key === 'entries'), { key: 'entries', label: 'Entries', backup: 1, live: 2 });
  assert.deepEqual(r.rows.find((x) => x.key === 'accounts'), { key: 'accounts', label: 'Accounts', backup: 1, live: 1 });
  assert.equal(r.priv, false); assert.equal(r.livePriv, false);
  // nothing written: storage bytes, revision, live state and the diagnostics queue are untouched
  assert.equal(adapterJson(ad), before); assert.equal(S.getMeta().rev, rev); assert.deepEqual(S.getState(), live); assert.equal(O._pending().length, pend);
  // the verified content is not kept: a second call returns a fresh object and the module holds no reference to it
  assert.notEqual(await O.verifyBackup('backup passphrase 1', file, S.getState()), r);
  // an older-format file (no ops) still verifies and says the date and revision are not recorded
  const st14 = clone(S.getState()); st14.schema = 14; delete st14.ops; delete st14.settings.backupReminderDays; delete st14.settings.syncReminder;
  const salt = V.newSalt(), key = await V.deriveKey('backup passphrase 1', salt);
  const o = await O.verifyBackup('backup passphrase 1', JSON.stringify(await V.makeEnvelope(key, salt, st14)), S.getState());
  assert.equal(o.ok, true); assert.equal(o.sourceSchema, 14); assert.equal(o.madeOn, null); assert.equal(o.rev, null);
});
test('B2 verify: a wrong passphrase, a tampered file, a truncated file, a non-backup and a file from a newer schema are refused with a plain reason and nothing is written', async () => {
  realKeys();
  const ad = await open();
  const file = await V.exportBackup('backup passphrase 1', S.getState());
  const before = adapterJson(ad), live = S.getState();
  const wrong = await O.verifyBackup('another passphrase 2', file, live);
  assert.deepEqual([wrong.ok, wrong.reason], [false, 'BAD_PASSPHRASE_OR_DATA']); assert.match(wrong.message, /did not work/);
  const env = JSON.parse(file), flip = (b64) => { const i = 40; return b64.slice(0, i) + (b64[i] === 'A' ? 'B' : 'A') + b64.slice(i + 1); };
  const tampered = await O.verifyBackup('backup passphrase 1', JSON.stringify(Object.assign({}, env, { ct: flip(env.ct) })), live);
  assert.deepEqual([tampered.ok, tampered.reason], [false, 'BAD_PASSPHRASE_OR_DATA']); assert.match(tampered.message, /changed or damaged/);
  const iv = await O.verifyBackup('backup passphrase 1', JSON.stringify(Object.assign({}, env, { iv: flip(env.iv) })), live); assert.equal(iv.ok, false);
  const kdf = await O.verifyBackup('backup passphrase 1', JSON.stringify(Object.assign({}, env, { kdf: Object.assign({}, env.kdf, { salt: flip(env.kdf.salt) }) })), live); assert.equal(kdf.ok, false);
  assert.equal((await O.verifyBackup('backup passphrase 1', file.slice(0, file.length - 30), live)).reason, 'NOT_BACKUP');
  for (const junk of ['', 'nope', '{}', '[]', JSON.stringify({ v: 1 }), JSON.stringify(Object.assign({}, env, { v: 2 }))]) assert.equal((await O.verifyBackup('backup passphrase 1', junk, live)).reason, 'NOT_BACKUP', junk);
  assert.equal((await O.verifyBackup('', file, live)).reason, 'NO_PASSPHRASE');
  // a newer schema: the contents are not read further, the schema number is reported
  const salt = V.newSalt(), key = await V.deriveKey('backup passphrase 1', salt);
  const newer = await O.verifyBackup('backup passphrase 1', JSON.stringify(await V.makeEnvelope(key, salt, Object.assign(clone(live), { schema: 16, futureField: MARK }))), live);
  assert.deepEqual([newer.ok, newer.reason, newer.schema], [false, 'NEWER_SCHEMA', 16]); assert.match(newer.message, /newer version of LifeOS \(schema 16\)/); assert.ok(!JSON.stringify(newer).includes(MARK));
  // decrypts but is not a vault
  const junk = await O.verifyBackup('backup passphrase 1', JSON.stringify(await V.makeEnvelope(key, salt, { schema: 15, entries: 'x' })), live);
  assert.deepEqual([junk.ok, junk.reason], [false, 'INVALID']);
  assert.equal(adapterJson(ad), before, 'nothing written'); assert.equal(O._pending().length, 0, 'a failed verify records nothing');
  assert.ok(!/L\.store\.commit|L\.store\.replaceState|setNotice\('ok', .*\)\s*;?\s*return commit/.test(src('src/core/ops.js').slice(src('src/core/ops.js').indexOf('async function verifyBackup'))));
});
test('B2 verify: a backup with a private vault reports yes or no only', async () => {
  realKeys();
  await open();
  const live = clone(S.getState());
  const withPriv = Object.assign(clone(live), { priv: undefined }); delete withPriv.priv;
  const r = await O.verifyBackup('backup passphrase 1', await V.exportBackup('backup passphrase 1', live), Object.assign(clone(live), { priv: { x: 1 } }));
  assert.equal(r.ok, true); assert.equal(r.priv, false); assert.equal(r.livePriv, true);
});

// ---------- B7 diagnostics ----------
test('B7: the ring holds at most 200 codes (oldest dropped), inside the encrypted state, in order', async () => {
  const ad = await open();
  for (let i = 0; i < 250; i++) O.record(i % 2 ? 'DECRYPT_FAIL' : 'SYNC_409', i % 2 ? 'lock' : 'sync');
  assert.equal(O._pending().length, 200, 'the queue is capped too');
  await S.commit((x) => { x.settings.autoLockMin = 30; });
  const d = S.getState().ops.diag; assert.equal(d.length, 200); assert.equal(O._pending().length, 0);
  assert.ok(d.every((e) => O.CODES.includes(e.code) && O.AREAS.includes(e.area) && /^\d{4}-\d{2}-\d{2}T/.test(e.at)));
  assert.deepEqual(Object.keys(d[0]).sort(), ['area', 'at', 'code']);
  for (let i = 0; i < 30; i++) await S.commit((x) => { O.push(x.ops, { at: '2026-11-10T10:00:00.000Z', code: 'CSV_REJECT', area: 'csv' }); });
  assert.equal(S.getState().ops.diag.length, 200); assert.equal(S.getState().ops.diag[199].code, 'CSV_REJECT');
  assert.equal(S.getState().ops.diag.filter((e) => e.code === 'CSV_REJECT').length, 30);
  // a stored ring longer than 200 is cut to the newest 200 on load
  const big = clone(fresh()); big.ops.diag = Array.from({ length: 300 }, (_, i) => ({ at: '2026-11-10T10:00:' + String(i % 60).padStart(2, '0') + '.000Z', code: i < 100 ? 'AI_TIMEOUT' : 'AI_HTTP', area: 'ai' }));
  const v = S.validateState(big); assert.equal(v.ops.diag.length, 200); assert.ok(v.ops.diag.every((e) => e.code === 'AI_HTTP'));
  // ciphertext at rest: no code name appears in the stored envelope
  assert.ok(!JSON.stringify(ad._m.get('envelope')).includes('CSV_REJECT'));
  // unknown codes and areas never enter: they become fixed constants
  O.record(MARK, MARK); O.record('SYNC_409', 'not an area'); await S.commit(() => {});
  const last = S.getState().ops.diag.slice(-2); assert.deepEqual(last.map((e) => [e.code, e.area]), [['UNKNOWN_ERROR', 'app'], ['SYNC_409', 'app']]);
  assert.ok(!JSON.stringify(S.getState()).includes(MARK));
});
test('B7: uncaught errors and unhandled rejections become a code by area; message, stack, name, filename and hostile objects are never read or stored', async () => {
  await open();
  const handlers = {}; O.install({ addEventListener: (n, f) => { handlers[n] = f; } });
  assert.deepEqual(Object.keys(handlers).sort(), ['error', 'unhandledrejection']);
  const hostile = new Proxy({}, { get() { throw new Error(MARK + ' trap'); }, ownKeys() { throw new Error(MARK); } });
  const err = Object.assign(new Error(MARK + ' message'), { code: MARK, stack: MARK + ' stack', name: MARK });
  O.setArea('money'); handlers.error({ message: MARK, filename: MARK, error: err, lineno: 1 });
  O.setArea('sync'); handlers.unhandledrejection({ reason: err });
  O.setArea('private'); handlers.error(hostile); handlers.unhandledrejection(hostile);
  O.setArea('not-an-area'); handlers.error({ message: MARK });
  assert.deepEqual(O._pending().map((d) => [d.code, d.area]), [['UNCAUGHT_MONEY', 'money'], ['REJECTION_SYNC', 'sync'], ['UNCAUGHT_PRIVATE', 'private'], ['REJECTION_PRIVATE', 'private'], ['UNCAUGHT_APP', 'app']]);
  await S.commit(() => {});
  const text = JSON.stringify(S.getState().ops) + O.format(S.getState(), { version: '1.3.0', userAgent: 'Mozilla/5.0 ' + MARK + ' Chrome/120' });
  assert.ok(!text.includes(MARK), text);
  // every generated code is a fixed constant of the expected shape
  assert.ok(O.CODES.every((c) => /^[A-Z0-9_]+$/.test(c))); assert.ok(O.CODES.includes('SYNC_409') && O.CODES.includes('DECRYPT_FAIL') && O.CODES.includes('STORAGE_QUOTA') && O.CODES.includes('CSV_REJECT') && O.CODES.includes('AI_TIMEOUT'));
  for (const a of O.AREAS) assert.ok(O.CODES.includes('UNCAUGHT_' + a.toUpperCase()) && O.CODES.includes('REJECTION_' + a.toUpperCase()));
});
test('B7: handled errors map only by a fixed code key or the two fixed passphrase messages; adversarial messages and codes map to nothing', () => {
  const ck = (e) => O.codeFor(e);
  assert.equal(ck(Object.assign(new Error('x'), { code: 'ROLLBACK' })), 'SYNC_ROLLBACK'); assert.equal(ck(Object.assign(new Error('x'), { code: 'RECONNECT' })), 'SYNC_RECONNECT');
  assert.equal(ck(Object.assign(new Error('x'), { code: 'AI_TIMEOUT' })), 'AI_TIMEOUT'); assert.equal(ck({ name: 'QuotaExceededError', message: MARK }), 'STORAGE_QUOTA');
  assert.equal(ck(new Error('BAD_PASSPHRASE_OR_DATA')), 'DECRYPT_FAIL'); assert.equal(ck(new Error('BAD_PRIVATE_PASSPHRASE')), 'PRIV_DECRYPT_FAIL');
  for (const e of [new Error(MARK), Object.assign(new Error(MARK), { code: MARK }), Object.assign(new Error('x'), { code: '__proto__' }), Object.assign(new Error('x'), { code: 'toString' }), null, undefined, 'BAD_PASSPHRASE_OR_DATA', 7,
    new Proxy({}, { get() { throw new Error(MARK); } }), new Error('BAD_PASSPHRASE_OR_DATA ' + MARK)]) assert.equal(ck(e), null);
  O.recordError(new Error(MARK), 'sync'); assert.equal(O._pending().length, 0);
  O.recordError(Object.assign(new Error(MARK), { code: 'TAMPER' }), 'sync'); assert.deepEqual(O._pending().map((d) => d.code), ['SYNC_TAMPER']);
  // ai.js errors carry fixed codes with the same messages as before
  const ai = src('src/core/ai.js'); for (const c of ['AI_TIMEOUT', 'AI_NETWORK', 'AI_HTTP', 'AI_BAD_REPLY']) assert.ok(ai.includes("'" + c + "'"), c);
});
test('B7: Copy diagnostics text holds codes, version, schema and browser family only; Clear empties the ring', async () => {
  await open();
  await S.commit((x) => {
    x.entries.push(L.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2026-11-10', title: MARK + ' lunch', value: 9, category: 'Dining', notes: MARK }));
    x.accounts.push({ id: 'a1', name: MARK + ' acct', kind: 'cash', liability: false, archived: false }); x.settings.business.name = MARK;
  });
  O.record('SYNC_409', 'sync'); O.record('DECRYPT_FAIL', 'lock'); await S.commit(() => {});
  const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 ' + MARK;
  const text = O.format(S.getState(), { version: '1.3.0', userAgent: ua });
  const lines = text.split('\n');
  assert.deepEqual(lines.slice(0, 5), ['LifeOS diagnostics', 'Version: 1.3.0', 'Schema: 15', 'Browser: Chrome', 'Codes: 2']);
  assert.ok(/^\d{4}-\d{2}-\d{2} SYNC_409 sync$/.test(lines[5]) && /^\d{4}-\d{2}-\d{2} DECRYPT_FAIL lock$/.test(lines[6])); assert.equal(lines.length, 7);
  assert.ok(!text.includes(MARK) && !/Mozilla|Linux|537|130\.0/.test(text));
  assert.deepEqual(['Mozilla/5.0 Edg/120.0', 'Mozilla/5.0 Firefox/120.0', 'Mozilla/5.0 (iPhone) AppleWebKit Version/17 Safari/605.1', 'Mozilla/5.0 CriOS/120 Safari/604', 'curl/8', undefined, 'Mozilla/5.0 HeadlessChrome/130.0 Safari/537'].map(O.browserFamily), ['Edge', 'Firefox', 'Safari', 'Chrome', 'Other', 'Other', 'Chrome']);
  assert.equal(O.format(S.getState(), { version: '1.3.0<script>' + MARK, userAgent: '' }).split('\n')[1], 'Version: unknown', 'only a plain version is printed');
  O.record('CSV_REJECT', 'csv');
  await S.commit((x) => { O.clear(x); });
  assert.deepEqual(S.getState().ops.diag, []); assert.equal(O._pending().length, 0);
  assert.equal(O.format(S.getState(), { version: '1.3.0', userAgent: ua }).split('\n')[4], 'Codes: 0');
});
test('B7: a failed save requeues its codes; a quiet write flushes them; locked, nothing is scheduled', async () => {
  await open();
  O.record('STORAGE_QUOTA', 'storage');
  await assert.rejects(S.commit((x) => { x.entries.push({ bad: true }); }));
  assert.deepEqual(O._pending().map((d) => d.code), ['STORAGE_QUOTA'], 'requeued after the failed save'); assert.equal(S.getState().ops.diag.length, 0);
  await S.commit(() => {}, { quiet: true }); assert.deepEqual(S.getState().ops.diag.map((d) => d.code), ['STORAGE_QUOTA']); assert.equal(O._pending().length, 0);
  S.lock(); O.record('DECRYPT_FAIL', 'lock'); assert.equal(O._pending().length, 1, 'kept in memory only, codes only');
});
test('B7 UI wiring: handlers installed, errors recorded by area, spell check rule holds for every new field', () => {
  const app = src('src/ui/app.js');
  assert.ok(app.includes('L.ops.install(window);') && app.includes("L.ops.record('RENDER_ERROR')") && /L\.ops\.recordError\(e\)/.test(app) && app.includes('L.ops.setArea(areaOf())'));
  const sec = app.slice(app.indexOf('function safetySettings('), app.indexOf('// ---------- dashboard ----------'));
  assert.ok(!/innerHTML|createElement\(\s*['"](input|textarea)/.test(sec));
  for (const f of ['rem-days', 'rem-sync', 'vf-file', 'vf-pass', 'diag-text', 'rem-pass']) assert.ok(app.includes("'" + f + "'"), f);
  // every field is built by h(), which sets spellcheck, autocorrect and autocapitalize off (and autocomplete off); passphrase fields are type password
  const fn = app.slice(app.indexOf('  function h(tag, props) {'), app.indexOf('  function labelled('));
  assert.ok(/tag === 'input' \|\| tag === 'textarea'\) && el\.getAttribute\('type'\) !== 'password'/.test(fn));
  assert.ok(/passOnly = function \(id, auto\) \{ return h\('input', \{ type: 'password'/.test(app));
});

// ---------- B3 check-live ----------
const ID = 'cf-id-9f3a1b7c.access', SECRET = 'cf-secret-0123456789abcdef0123456789abcdef';
const goodHeaders = () => new Headers(Object.fromEntries(Object.entries(parseHeadersFile(src('_headers')))));
const goodHtml = () => '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + buildAll(ROOT).csp + '"><title>x</title>';
const mockFetch = (o) => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); if (o.throws) throw o.throws; return { status: o.status ?? 200, headers: o.headers ?? goodHeaders(), text: async () => o.html ?? goodHtml() }; }; f.calls = calls; return f; };
async function live(o, env, argv) {
  const out = [], f = mockFetch(o || {});
  const code = await checkLive(argv || ['https://live.example.test/dist/lifeos'], env === undefined ? { CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET } : env, { fetch: f, out: (t) => out.push(t), root: ROOT });
  return { code, out: out.join('\n'), calls: f.calls };
}
nodeTest('B3 check-live: passes when headers and the page CSP match; the token goes in the two Access headers only, redirects are not followed', async () => {
  const r = await live();
  assert.equal(r.code, 0); assert.match(r.out, /^PASS: 6 headers match/); assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, 'https://live.example.test/dist/lifeos'); assert.equal(r.calls[0].init.redirect, 'manual');
  assert.equal(r.calls[0].init.headers['CF-Access-Client-Id'], ID); assert.equal(r.calls[0].init.headers['CF-Access-Client-Secret'], SECRET);
  assert.ok(!r.out.includes(ID) && !r.out.includes(SECRET));
  // the same with the URL taken from the environment
  const e = await live({}, { CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET, LIFEOS_LIVE_URL: 'https://other.example.test/x' }, []);
  assert.equal(e.code, 0); assert.equal(e.calls[0].url, 'https://other.example.test/x');
  // header names are case-insensitive and whitespace is normalised
  const h = goodHeaders(); h.set('referrer-policy', '  no-referrer '); assert.equal((await live({ headers: h })).code, 0);
});
nodeTest('B3 check-live: each kind of mismatch exits non-zero and says what differs', async () => {
  const h1 = goodHeaders(); h1.set('Strict-Transport-Security', 'max-age=1');
  let r = await live({ headers: h1 }); assert.equal(r.code, 1); assert.match(r.out, /MISMATCH: 1 problem/); assert.match(r.out, /strict-transport-security differs/); assert.match(r.out, /max-age=1/);
  const h2 = goodHeaders(); h2.delete('x-content-type-options'); r = await live({ headers: h2 }); assert.equal(r.code, 1); assert.match(r.out, /Missing header x-content-type-options/);
  const h3 = goodHeaders(); h3.set('content-security-policy', "default-src 'self'"); r = await live({ headers: h3 }); assert.equal(r.code, 1); assert.match(r.out, /content-security-policy differs/);
  r = await live({ html: goodHtml().replace('script-src', 'script-src x') }); assert.equal(r.code, 1); assert.match(r.out, /meta tag differs/);
  r = await live({ html: '<html>no csp</html>' }); assert.equal(r.code, 1); assert.match(r.out, /no CSP meta tag/);
  r = await live({ status: 302, headers: new Headers({ location: 'https://x.cloudflareaccess.com/login' }) }); assert.equal(r.code, 1); assert.match(r.out, /HTTP 302/);
  r = await live({ status: 403 }); assert.equal(r.code, 1); assert.match(r.out, /HTTP 403/);
});
nodeTest('B3 check-live: the token variables are required, read from the environment only, and never printed even when a failure message contains them', async () => {
  for (const env of [{}, { CF_ACCESS_CLIENT_ID: ID }, { CF_ACCESS_CLIENT_SECRET: SECRET }, { CF_ACCESS_CLIENT_ID: '  ', CF_ACCESS_CLIENT_SECRET: SECRET }, undefined === 1 ? 0 : null]) {
    const r = await live({}, env); assert.equal(r.code, 2); assert.equal(r.calls.length, 0, 'no request without a full token'); assert.match(r.out, /CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET/);
  }
  let r = await live({ throws: Object.assign(new Error('boom ' + ID + ' ' + SECRET), { code: 'ECONNRESET ' + SECRET }) });
  assert.equal(r.code, 1); assert.ok(!r.out.includes(ID) && !r.out.includes(SECRET), r.out); assert.match(r.out, /request failed/);
  // header values echoed back by a hostile server are redacted too
  const h = goodHeaders(); h.set('x-echo', SECRET); h.set('strict-transport-security', 'max-age=1; ' + SECRET);
  r = await live({ headers: h }); assert.equal(r.code, 1); assert.ok(!r.out.includes(SECRET) && r.out.includes('[hidden]'));
  // only https, no credentials in the URL, no request otherwise
  for (const u of ['http://live.example.test/', 'ftp://x.test/', 'not a url', 'https://user:pw@live.example.test/']) { r = await live({}, undefined, [u]); assert.equal(r.code, 2, u); assert.equal(r.calls.length, 0); }
  // source rules: only the two variables are read, nothing is written to disk, the environment is never printed
  const s = src('scripts/check-live.mjs').replace(/\/\/.*$/gm, '');
  assert.ok(!/writeFile|appendFile|createWriteStream|console\.|fs\.write/.test(s) && !/(?<!process\.stdout)\.write\(/.test(s), 'nothing is written to disk or the console; output goes through stdout only'); assert.equal((s.match(/process\.env\b/g) || []).length, 1, 'the environment is read in one place'); assert.ok(/run\(process\.argv\.slice\(2\), process\.env, \{\}\)/.test(s));
  assert.deepEqual([...new Set([...s.matchAll(/CF_ACCESS_[A-Z_]+/g)].map((m) => m[0]))].sort(), ['CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']);
  assert.ok(!/(CF_ACCESS_CLIENT_(ID|SECRET)\s*=\s*['"`][^'"`]+['"`])/.test(src('docs/FIRST-RUN.md') + src('docs/RUNBOOK.md')), 'no token value in the docs');
});
nodeTest('B3 check-live: parsing helpers, and the real script exits 2 without a token', () => {
  assert.deepEqual(parseHeadersFile('/*\n  A-B: one\n  C: two: three\n\n/x\n  D: no\n'), { 'a-b': 'one', c: 'two: three' });
  assert.equal(metaCsp('<meta http-equiv="Content-Security-Policy" content="a b; c">'), 'a b; c'); assert.equal(metaCsp('x'), null);
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/check-live.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30000 });
  assert.equal(r.status, 2); assert.match(r.stdout, /Nothing was requested/);
  const f = src('docs/FIRST-RUN.md'); for (const h of ['Storage', 'Backup and verify', 'Google Drive sync', 'real AI call', 'Live header check', 'Diagnostics']) assert.ok(f.includes(h), h);
  assert.ok((f.match(/- \[ \]/g) || []).length >= 14 && (f.match(/_{6,}/g) || []).length >= 14, 'a checklist with places to note results');
  const sy = src('docs/SYNC-SETUP.md'); assert.ok(/## Cloudflare Access/.test(sy) && /redirect URI/.test(sy) && /intercepts/.test(sy));
});
