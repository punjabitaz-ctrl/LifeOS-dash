// v1.3.0 independent audit: regression tests for SEC-93 to SEC-97 (docs/SECURITY.md, "v1.3.0 audit").
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { L, PASS, memAdapter } from './_load.mjs';
import { fastKeys, realKeys, clone } from './_archive.mjs';

const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), O = view('ops'), V = view('vault');
const ROOT = new URL('..', import.meta.url).pathname;
const src = (f) => readFileSync(join(ROOT, f), 'utf8');
const MARK = 'AUDIT MARK "q93"';
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { S.lock(); } catch (e) { /* locked */ } realKeys(); } });
const open = async () => { const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS); return ad; };

// ---------- SEC-93: RUNBOOK and FIRST-RUN describe what the app really does ----------
test('SEC-93: the runbook quotes the real refusal message and never sends the owner to a lock-screen action that does not exist', () => {
  const r = src('docs/RUNBOOK.md'), f = src('docs/FIRST-RUN.md'), app = src('src/ui/app.js');
  // the message an older app shows for a newer vault is exactly the one quoted
  assert.throws(() => S.validateState(Object.assign(S.defaultState(), { schema: S.SCHEMA + 1 })), (e) => e.message === 'Invalid data: unsupported schema');
  assert.ok(r.includes('"Invalid data: unsupported schema"'));
  // the lock screen offers no wipe, import or second vault while one exists, so recovery and drills use a separate browser profile
  const lock = app.slice(app.indexOf('  function lockScreen() {'), app.indexOf('  function archCtx() {'));
  assert.ok(lock.length > 500 && !/wipe|importBackup|Import backup/i.test(lock) && /var create = !vaultExists;/.test(lock));
  assert.ok(!/on the lock screen create a throwaway vault/i.test(r));
  assert.match(r, /separate browser profile or another browser/); assert.match(f, /throwaway vault in a separate browser profile/);
  // rollback across a schema: a backup made on the older version is required, a newer one is refused, site data must be cleared first
  assert.match(r, /you need a backup file made on the older version/); assert.match(r, /A backup made on the newer version cannot be restored by the older app/);
  assert.match(r, /clear the site data for the LifeOS address/);
  // no claim that a tag exists only locally, and the dashboard menu path is not asserted
  assert.ok(!/exists in the local clone only/.test(r) && !/Workers, the LifeOS Worker, Deployments/.test(r));
  for (const t of [r, f]) assert.ok(!t.includes('—'));
});

// ---------- SEC-94: a downloaded Drive copy keeps this device's ops ----------
test('SEC-94: adopting a Drive copy keeps this device diagnostics, storage result, dates and snooze, and an older copy keeps the reminder settings', async () => {
  await open();
  await S.commit((x) => { O.markBackup(x, '2026-11-12', 4); x.ops.persist = { result: 'granted', at: '2026-11-12' }; x.ops.snoozeUntil = '2026-11-13'; x.settings.backupReminderDays = 21; x.settings.syncReminder = true; });
  O.record('SYNC_409', 'sync'); await S.commit(() => {}, { quiet: true });
  const mine = clone(S.getState().ops), base = clone(S.getState());
  for (const schema of [15, 14]) {
    const remote = clone(base);
    remote.ops = { lastBackupAt: '2020-01-01', backupRev: 1, lastSyncAt: '2020-01-02', safeRev: 1, snoozeUntil: '2020-01-03', persist: { result: 'denied', at: '2020-01-01' }, diag: [{ at: '2020-01-01T00:00:00.000Z', code: 'AI_HTTP', area: 'ai' }] };
    remote.settings.backupReminderDays = 3; remote.settings.syncReminder = false;
    remote.entries.push(L.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2026-11-10', title: 'From the other device', value: 2, category: 'Dining' }));
    if (schema === 14) { remote.schema = 14; delete remote.ops; delete remote.settings.backupReminderDays; delete remote.settings.syncReminder; }
    const m = { rev: 40, updatedAt: '2026-11-14T00:00:00.000Z', deviceId: 'other' };
    const salt = V.newSalt(), key = await V.deriveKey(PASS, salt);
    const env = Object.assign(await V.makeEnvelope(key, salt, Object.assign(remote, { _meta: m })), m);
    const info = await S.inspectEnvelope(env, PASS), before = clone(S.getState().settings);
    await S.adoptEnvelope(info);
    const st = S.getState();
    assert.equal(st.entries.filter((e) => e.title === 'From the other device').length, 1, 'the content did come from the Drive copy');
    assert.deepEqual(st.ops, mine, 'schema ' + schema + ': ops stay this device\'s');
    assert.equal(st.settings.backupReminderDays, schema === 15 ? 3 : before.backupReminderDays); assert.equal(st.settings.syncReminder, schema === 15 ? false : before.syncReminder);
    if (schema === 15) { await S.commit((x) => { x.settings.backupReminderDays = 21; x.settings.syncReminder = true; }); }
    // the next write (the sync bookkeeping in real use) seals the kept ops
    await S.commit(() => {}, { quiet: true });
    assert.deepEqual(S.getState().ops, mine);
  }
});

// ---------- SEC-95: handled sync, archive and CSV failures reach diagnostics as fixed codes ----------
test('SEC-95: CSV refusals, archive failures and sync failures leave a fixed code; the message never does', () => {
  let e; try { L.csv.parse('a\n"' + MARK.replace(/"/g, '')); } catch (x) { e = x; }
  assert.ok(e && e.code === 'CSV'); assert.equal(O.codeFor(e), 'CSV_REJECT');
  try { L.csv.parse(7); } catch (x) { assert.equal(O.codeFor(x), 'CSV_REJECT'); }
  assert.deepEqual(L.csv.parse('a,b\n1,2'), { headers: ['a', 'b'], rows: [['1', '2']] }, 'parse still returns its result');
  assert.equal(O.codeFor(Object.assign(new Error(MARK), { code: 'ARCHIVE' })), 'ARCHIVE_FAIL');
  O.recordError(e, 'csv'); O.recordError(Object.assign(new Error(MARK), { code: 'HTTP' }), 'sync');
  assert.deepEqual(O._pending().map((d) => [d.code, d.area]), [['CSV_REJECT', 'csv'], ['SYNC_HTTP', 'sync']]);
  assert.ok(!JSON.stringify(O._pending()).includes('q93'));
  // UI wiring: the sync panel records every failure (a known code, else SYNC_FAIL) and dialogs record their errors like act() does
  const su = src('src/ui/sync-ui.js'), app = src('src/ui/app.js');
  assert.ok(/function diag\(e\) \{ try \{ if \(L\.ops && !L\.ops\.recordError\(e, 'sync'\)\) L\.ops\.record\('SYNC_FAIL', 'sync'\);/.test(su));
  assert.ok(/function fail\(e\) \{\n\s+if \(e && e\.code === 'NEED_PASSPHRASE'\) \{ askPass\(\); return; \}\n\s+diag\(e\);/.test(su));
  assert.ok(su.includes("if (e && e.code === 'WRONG_PASSPHRASE') { diag(e);"));
  assert.ok(app.includes('}, function (e) { try { L.ops.recordError(e); } catch (x) { /* diagnostics never block */ } err.textContent = friendly(e); });'));
  for (const c of ['SYNC_FAIL', 'ARCHIVE_FAIL', 'CSV_REJECT']) assert.ok(O.CODES.includes(c));
});

// ---------- SEC-96: the tag workflow, run for real against a local origin ----------
function runScript() {
  const y = src('.github/workflows/tag-release.yml');
  const lines = y.split('\n'), i = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  assert.ok(i > 0);
  const out = [];
  for (const l of lines.slice(i + 1)) { if (l.trim() && !l.startsWith('          ')) break; out.push(l.slice(10)); }
  return out.join('\n');
}
nodeTest('SEC-96: every action is pinned to a commit hash; inputs reach the script through env only', () => {
  const y = src('.github/workflows/tag-release.yml');
  const uses = [...y.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 1); for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, u);
  const script = runScript();
  assert.ok(!/\$\{\{/.test(script), 'no expression is interpolated into the script');
  assert.match(y, /INPUT_VERSION: \$\{\{ github\.event\.inputs\.version \}\}/); assert.match(y, /INPUT_COMMIT: \$\{\{ github\.event\.inputs\.commit \}\}/);
});
nodeTest('SEC-96: the workflow script tags from package.json only, refuses a mismatched or injected version, commits off main and short hashes, and never moves a tag', () => {
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }) }).trim();
  const base = mkdtempSync(join(tmpdir(), 'lifeos-wf-')), origin = join(base, 'origin.git'), work = join(base, 'work'), clone2 = join(base, 'clone');
  g(base, 'init', '-q', '--bare', '-b', 'main', origin); g(base, 'init', '-q', '-b', 'main', work);
  const commit = (v, msg) => { writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'x', version: v })); g(work, 'add', '.'); g(work, 'commit', '-q', '--allow-empty', '-m', msg); return g(work, 'rev-parse', 'HEAD'); };
  const c1 = commit('1.0.0', 'one'), c2 = commit('1.1.0', 'two');
  g(work, 'checkout', '-q', '-b', 'side'); const side = commit('7.7.7', 'side'); g(work, 'checkout', '-q', 'main');
  g(work, 'remote', 'add', 'origin', origin); g(work, 'push', '-q', 'origin', 'main', 'side');
  g(base, 'clone', '-q', origin, clone2);
  const script = join(base, 'run.sh'); writeFileSync(script, runScript());
  const pwned = join(base, 'pwned');
  const run = (env) => spawnSync('bash', ['-e', script], { cwd: clone2, encoding: 'utf8', env: Object.assign({ PATH: process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: '1' }, env) });
  const tags = () => g(origin, 'for-each-ref', '--format=%(refname:short) %(*objectname)', 'refs/tags').split('\n').filter(Boolean).sort();
  // push to main: the tag comes from package.json of that commit
  let r = run({ GITHUB_SHA: c2, INPUT_VERSION: '', INPUT_COMMIT: '' }); assert.equal(r.status, 0, r.stdout + r.stderr); assert.deepEqual(tags(), ['v1.1.0 ' + c2]);
  // a later commit with the same version never moves the existing tag
  const c3 = commit('1.1.0', 'three'); g(work, 'push', '-q', 'origin', 'main'); g(clone2, 'fetch', '-q', 'origin');
  r = run({ GITHUB_SHA: c3 }); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /already exists/); assert.deepEqual(tags(), ['v1.1.0 ' + c2]);
  // manual backfill with the matching version
  r = run({ GITHUB_SHA: c3, INPUT_VERSION: '1.0.0', INPUT_COMMIT: c1 }); assert.equal(r.status, 0, r.stdout + r.stderr); assert.deepEqual(tags(), ['v1.0.0 ' + c1, 'v1.1.0 ' + c2]);
  // refused, nothing tagged: a version box that is not package.json on that commit, an injection attempt, a commit off main, a short or hostile hash
  const refuse = (env, re) => { const x = run(Object.assign({ GITHUB_SHA: c3 }, env)); assert.notEqual(x.status, 0, JSON.stringify(env)); if (re) assert.match(x.stdout + x.stderr, re); assert.deepEqual(tags(), ['v1.0.0 ' + c1, 'v1.1.0 ' + c2]); };
  refuse({ INPUT_VERSION: '9.9.9', INPUT_COMMIT: c1 }, /does not match package\.json/);
  refuse({ INPUT_VERSION: '1.0.0"; touch "' + pwned + '"; echo "', INPUT_COMMIT: c1 }, /does not match/);
  refuse({ INPUT_VERSION: '7.7.7', INPUT_COMMIT: side }, /not on main/);
  refuse({ INPUT_VERSION: '', INPUT_COMMIT: c1.slice(0, 7) }, /full 40-character hash/);
  refuse({ INPUT_VERSION: '', INPUT_COMMIT: '$(touch ' + pwned + ')' }, /full 40-character hash/);
  assert.ok(!existsSync(pwned), 'no input was executed');
});

// ---------- audit confirmation kept as a regression: the backup card and banner cannot be hidden through the layout ----------
nodeTest('audit: the backup card is outside the layout modules, unknown layout ids are dropped, and the banner shows on every screen but print', () => {
  const ids = L.layout.MODULES.map((m) => m.id);
  assert.ok(!ids.some((i) => /safety|backup/.test(i)));
  for (const id of ['safety-card', 'safety', 'backup', '__proto__', MARK]) assert.deepEqual(L.layout.clean([{ id, size: 'small', hidden: true }]), []);
  const app = src('src/ui/app.js');
  const dash = app.slice(app.indexOf('    var mods = [];'), app.indexOf('  // ---------- customizable home (v0.12.0) ----------'));
  assert.ok(/\n\s+safetyCard\(mainState\(\)\),\n/.test(dash), 'drawn as a fixed card');
  assert.ok(dash.indexOf('safetyCard(') > dash.indexOf('list.forEach(') + 200 && !/built\[['"]safety/.test(app));
  assert.ok(app.includes("view.name === 'print' ? null : backupBanner()"));
});
