// v1.4.0 audit regressions (SEC-98 onward). See docs/SECURITY.md "v1.4.0 audit".
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { L, PASS, memAdapter } from './_load.mjs';
import { fastKeys, realKeys, clone } from './_archive.mjs';
import { buildAll, swFor } from '../build.mjs';
import { APPLE_ICON, appleIconDataUrl } from '../src/icons.mjs';

const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), V = view('vault'), SY = view('sync'), P = view('pwa'), O = view('ops');
const ROOT = new URL('..', import.meta.url).pathname;
const src = (f) => readFileSync(join(ROOT, f), 'utf8');
const VERSION = JSON.parse(src('package.json')).version;
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { S.lock(); } catch (e) { /* locked */ } realKeys(); } });
const all = buildAll(ROOT);
const { inflateSync } = createRequire(import.meta.url)('node:zlib');

function fakeEnv(protocol) {
  const sw = { controller: {}, regs: [], register(u, o) { this.regs.push([u, o]); return Promise.resolve(reg); }, addEventListener() {} };
  const reg = { waiting: null, installing: null, addEventListener() {} };
  const links = [], doc = { head: { appendChild: (l) => links.push(l) }, querySelector: () => null, createElement: () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }) };
  return { env: { loc: { protocol, reload() {} }, navigator: { serviceWorker: sw }, document: doc, onUpdate() {} }, links };
}

// ---------- SEC-98: the manifest is fetched with the Access cookie; the iPhone icon is a data: link ----------
test('SEC-98: on https the manifest link asks for credentials; file and http add nothing; no same-origin icon link', async () => {
  for (const proto of ['file:', 'http:']) { const f = fakeEnv(proto); await P.register(f.env); assert.equal(f.links.length, 0); }
  const f = fakeEnv('https:'); await P.register(f.env);
  assert.deepEqual(f.links.map((l) => l.attrs), [{ rel: 'manifest', href: 'manifest.webmanifest', crossorigin: 'use-credentials' }]);
});
test('SEC-98 (apple-touch-icon): the page carries a 180 px opaque PNG as a data: link, inside the unchanged img-src data: policy', () => {
  const links = all.html.match(/<link rel="apple-touch-icon" href="([^"]+)">/g) || []; assert.equal(links.length, 1);
  const href = /href="([^"]+)"/.exec(links[0])[1]; assert.equal(href, appleIconDataUrl(VERSION));
  assert.ok(href.startsWith('data:image/png;base64,') && href.length < 4000);
  assert.ok(all.html.indexOf(links[0]) < all.html.indexOf('<style>'), 'in the head, before the inlined style');
  const b = Buffer.from(href.slice('data:image/png;base64,'.length), 'base64');
  assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); assert.equal(b.readUInt32BE(16), APPLE_ICON.size); assert.equal(b.readUInt32BE(20), 180);
  const idat = []; let o = 8; while (o < b.length) { const n = b.readUInt32BE(o), t = b.subarray(o + 4, o + 8).toString('latin1'); if (t === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + n)); o += 12 + n; }
  const px = inflateSync(Buffer.concat(idat)), alpha = (x, y) => px[y * (180 * 4 + 1) + 1 + x * 4 + 3];
  for (const [x, y] of [[0, 0], [179, 0], [0, 179], [179, 179], [90, 90]]) assert.equal(alpha(x, y), 255, 'opaque at ' + x + ',' + y);
  // the policy is not loosened: images stay data: only, and the directives are the v1.4.0 list plus the design language's font-src data: (built-in typefaces)
  const dirs = all.csp.split('; '); assert.equal(dirs.find((d) => d.startsWith('img-src')), 'img-src data:');
  assert.deepEqual(dirs.map((d) => d.split(' ')[0]), ['default-src', 'script-src', 'style-src', 'connect-src', 'font-src', 'img-src', 'base-uri', 'form-action', 'manifest-src', 'worker-src']);
  assert.ok(!JSON.parse(all.manifest).icons.some((i) => /apple|data:/.test(i.src)) && !/apple/.test(swFor(ROOT)));
  assert.ok(!src('src/ui/shell.html').includes('base64') && src('src/ui/shell.html').includes('href="__APPLE_ICON__"'));
});

// ---------- SEC-99: a waiting version never redraws the screen ----------
test('SEC-99: the update prompt is added in place, so a typed passphrase or an unsaved form is kept', () => {
  const a = src('src/ui/app.js');
  const cb = /onUpdate: function \(apply\) \{([^}]*)\}/.exec(a); assert.ok(cb, 'onUpdate callback');
  assert.ok(!/render\(/.test(cb[1]) && /showUpdate\(\)/.test(cb[1]));
  const fn = a.slice(a.indexOf('  function showUpdate() {'), a.indexOf('  // The strip shown while the private vault is open'));
  assert.ok(fn.length > 100 && !/render\(/.test(fn) && /insertBefore/.test(fn));
});

// ---------- lock-screen paths against a vault that is already on disk (locked) ----------
const mk = (n) => ({ id: 'a' + n, name: 'Account "q' + n + '" x', kind: 'cash', liability: false });
async function lockedVault(mutate) { const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS); if (mutate) await S.commit(mutate); S.lock(); return ad; }
test('lock-screen restore and Drive install refuse a vault that exists on disk while locked, and change no byte', async () => {
  const other = await lockedVault((x) => { x.accounts.push(mk(1)); });
  const remoteEnv = clone(other._m.get('envelope'));
  const backup = await (async () => { S._setAdapter(other); await S.unlock(PASS); const f = await V.exportBackup('backup passphrase one', S.getState()); S.lock(); return f; })();
  const ad = await lockedVault((x) => { x.accounts.push(mk(2)); });
  const before = JSON.stringify([...ad._m.entries()]);
  assert.equal(S.isUnlocked(), false); assert.equal(await S.exists(), true);
  await assert.rejects(S.createFromBackup('backup passphrase one', await V.importBackup('backup passphrase one', backup)), /VAULT_EXISTS/);
  assert.equal(S.isUnlocked(), false); assert.equal(JSON.stringify([...ad._m.entries()]), before);
  await assert.rejects(S.installEnvelope(remoteEnv, PASS), /VAULT_EXISTS/);
  assert.equal(S.isUnlocked(), false); assert.equal(JSON.stringify([...ad._m.entries()]), before);
  await assert.rejects(SY.installCopy({ _ctx: { env: remoteEnv, file: { id: 'file0abcdef' } } }, PASS, ''), (e) => e.code === 'VAULT_EXISTS');
  assert.equal(JSON.stringify([...ad._m.entries()]), before);
  // the vault on disk still opens with its own passphrase and holds its own data
  const st = await S.unlock(PASS); assert.deepEqual(st.accounts.map((x) => x.id), ['a2']);
});
test('a stale shell meeting a newer vault: unlock refuses with the schema message and writes nothing; no path replaces it', async () => {
  const ad = memAdapter(); S._setAdapter(ad); S.lock();
  realKeys(); let env; try { const salt = V.newSalt(), key = await V.deriveKey(PASS, salt); env = await V.makeEnvelope(key, salt, Object.assign(clone(S.defaultState()), { schema: S.SCHEMA + 1, futureField: 'a "newer" field' })); } finally { fastKeys(); }
  await ad.set('envelope', env); const before = JSON.stringify([...ad._m.entries()]);
  realKeys(); try { await assert.rejects(S.unlock(PASS), /unsupported schema/); } finally { fastKeys(); }
  assert.equal(S.isUnlocked(), false); assert.equal(JSON.stringify([...ad._m.entries()]), before);
  await assert.rejects(S.createFromBackup('backup passphrase one', S.validateState(S.defaultState())), /VAULT_EXISTS/);
  assert.equal(JSON.stringify([...ad._m.entries()]), before);
});

// ---------- settings.setup is outside the sync fingerprint, and nothing else is ----------
test('sync fingerprint: a setup-only change is ignored, but a real change made with it is still seen', async () => {
  const base = S.validateState(S.defaultState()), f0 = await SY.fingerprint(base);
  const a = clone(base); a.settings.setup = { dismissed: true, targetsSaved: true }; assert.equal(await SY.fingerprint(a), f0);
  const b = clone(a); b.settings.currency = 'EUR'; assert.notEqual(await SY.fingerprint(b), f0);
  const c = clone(base); c.settings.targets.workoutsPerWeek = 5; assert.notEqual(await SY.fingerprint(c), f0);
  const d = clone(base); d.accounts.push(mk(3)); assert.notEqual(await SY.fingerprint(d), f0);
  const s = src('src/core/sync.js'); assert.ok(/delete s\.settings\.sync; delete s\.settings\.setup; \}/.test(s));
});

// ---------- B20: a skipped smoke is never counted as passed ----------
test('B20: the smoke runner lists a skipped script as SKIP and never reports it as passed; core smokes name the missing browser', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeos-skip-'));
  writeFileSync(join(dir, 'smoke-a-ok.mjs'), "console.log('A PASSED');");
  writeFileSync(join(dir, 'smoke-b-skip.mjs'), "console.log('SKIPPED: webkit unavailable (not installed); this is not a pass');");
  const r = spawnSync(process.execPath, [join(ROOT, 'test/smokes.mjs'), '--dir=' + dir], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0); assert.match(r.stdout, /ok   smoke-a-ok\.mjs/); assert.match(r.stdout, /SKIP smoke-b-skip\.mjs/);
  assert.match(r.stdout, /SKIPPED, NOT PASSED: smoke-b-skip\.mjs/); assert.match(r.stdout, /SMOKES: 1 of 2 passed, 1 skipped/); assert.ok(!/all 2 passed/.test(r.stdout));
  for (const f of ['smoke', 'smoke-money', 'smoke-priv', 'smoke-leaks', 'smoke-safety']) {
    const s = src('test/' + f + '.mjs');
    assert.ok(/pw\[process\.env\.LIFEOS_SMOKE_BROWSER \|\| 'chromium'\]/.test(s) && /\(process\.env\.LIFEOS_SMOKE_BROWSER \|\| 'chromium'\) \+ ' unavailable \(not installed\); this is not a pass'/.test(s), f);
  }
  assert.match(src('docs/HANDOFF.md'), /WebKit and Firefox[^.]*not[^.]*(run|installed)/i);
});
