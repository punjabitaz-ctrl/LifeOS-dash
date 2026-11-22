// v1.8.0 crypto audit (docs/SECURITY.md "v1.8.0 audit", SEC-127 onward). Each test failed before its fix.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { L, PASS, memAdapter } from './_load.mjs';
import { drive, TOKEN } from './_v070.mjs';
import { build, vault, io, clone, fastKeys, realKeys, PRIV, TODAY } from './_archive.mjs';

const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), V = live('vault'), P = live('priv'), A = live('archive'), O = live('ops');
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const BKP = 'backup passphrase 1', NEWP = 'a brand new passphrase 77';
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { P.close('system'); } catch (e) { /* closed */ } try { S.lock(); } catch (e) { /* locked */ } realKeys(); } });
const rej = async (p, re) => { try { await p; } catch (e) { if (re) assert.match(String(e.message), re); return e; } assert.fail('expected a rejection'); };
async function enable(pass = PASS) { const h = await S.beginRecovery(pass); await h.finish(h.key); return h.key; }

// A v1.7.0 world: the same v1 envelope (its own salt) on two devices and on Drive, each device's sync record naming that salt.
async function v1World() {
  const ad = await vault(null); const d = drive(); L.sync._setFetch(d.fetch); L.sync._setToken(TOKEN, 3600);
  assert.equal((await L.sync.run()).kind, 'uploaded');
  const raw = clone(S.getState()), rev = S.getMeta().rev + 1, salt = V.newSalt(), key = await V.deriveKey(PASS, salt);
  raw.settings.sync.keySalt = Buffer.from(salt).toString('base64'); raw.settings.sync.remoteRev = rev;
  const m = { rev, updatedAt: '2026-11-20T00:00:00.000Z', deviceId: 'device-one' };
  const env1 = Object.assign(await V.makeEnvelope(key, salt, Object.assign(raw, { _meta: m })), m);
  S.lock(); await ad.set('envelope', env1);
  const ad2 = memAdapter(); await ad2.set('envelope', env1); d.put(JSON.stringify(env1));
  return { ad, ad2, d };
}

test('SEC-127 a v1 to v2 upgrade alone is not a local key change: the second device to upgrade gets a download offer, not a conflict', async () => {
  const { ad, ad2 } = await v1World();
  // device one upgrades and syncs: its own upgrade is uploaded
  S._setAdapter(ad); await S.unlock(PASS); await S.commit(() => {});
  assert.equal((await L.sync.run({ passphrase: PASS })).kind, 'uploaded'); S.lock();
  // device two upgrades (unlock writes v2 under its own new data key) and made no change: the Drive copy is offered, never a conflict
  S._setAdapter(ad2); await S.unlock(PASS); await S.commit(() => {});
  const r = await L.sync.run({ passphrase: PASS });
  assert.equal(r.kind, 'download-offer');
  assert.equal((await L.sync.apply(r, 'download')).kind, 'downloaded'); assert.equal((await L.sync.run()).kind, 'in-sync');
  // the record survives a reload before any write: still an offer path, not a conflict
  S.lock(); await S.unlock(PASS); assert.equal(S.getState().settings.sync.keySalt, S.saltId());
});

test('SEC-127 a real local change after an upgrade is still a conflict, and a passphrase change is still a local change', async () => {
  const { ad, ad2 } = await v1World();
  S._setAdapter(ad); await S.unlock(PASS); await S.commit(() => {}); assert.equal((await L.sync.run({ passphrase: PASS })).kind, 'uploaded'); S.lock();
  S._setAdapter(ad2); await S.unlock(PASS); await S.commit((x) => { x.accounts.push({ id: 'b1', name: 'Typed on device two', kind: 'cash', liability: false, archived: false }); });
  assert.equal((await L.sync.run({ passphrase: PASS })).kind, 'conflict'); S.lock();
  S._setAdapter(ad); await S.unlock(PASS); await S.changePassphrase(PASS, NEWP); await S.commit(() => {});
  assert.equal((await L.sync.run({ passphrase: PASS })).kind, 'uploaded');
});

test('SEC-128 a backup file opens with the recovery key it carries: verify and restore on a new device under a new passphrase', async () => {
  await vault(build()); const k = await enable();
  const text = await V.exportBackup(BKP, S.getState(), k); S.lock();
  const r = await O.verifyBackup({ recovery: k }, text, { schema: S.SCHEMA }); assert.equal(r.ok, true, r.message);
  const wrong = await O.verifyBackup({ recovery: await V.newRecoveryKey() }, text, { schema: S.SCHEMA }); assert.equal(wrong.ok, false); assert.equal(wrong.reason, 'BAD_RECOVERY_KEY');
  const typo = await O.verifyBackup({ recovery: 'AAAA' }, text, { schema: S.SCHEMA }); assert.equal(typo.ok, false); assert.equal(typo.reason, 'RECOVERY_KEY_FORMAT');
  assert.ok(!JSON.stringify([wrong, typo]).includes(k.slice(0, 9)));
  const ad = memAdapter(); S._setAdapter(ad);
  await S.createFromBackup(NEWP, await V.importBackup({ recovery: k }, text)); assert.ok(S.isUnlocked()); S.lock(); await S.unlock(NEWP);
  // the lock-screen restore path offers it
  const app = src('src/ui/app.js');
  assert.match(app, /id: 'rs-use-key'/); assert.match(app, /verifyBackup\(secret/);
});

test('SEC-128 an archive file opens and restores with the recovery key it carries after the main passphrase changed', async () => {
  const ad = await vault(build(), { priv: true }); void ad; const k = await enable();
  const box = {};
  await A.archiveYear({ year: 2021, passphrase: PASS, recoveryKey: k, today: TODAY, drive: true, download: true, io: io(box) });
  const f = box.files['lifeos-archive-2021.json'];
  await S.changePassphrase(PASS, NEWP, { keepRecovery: k });
  await rej(A.openArchive(f, NEWP, 2021), /did not work/);
  assert.equal((await A.openArchive(f, { recovery: k }, 2021)).year, 2021); A.close && A.close();
  await rej(A.restoreYear(f, NEWP, 2021, undefined, { recovery: await V.newRecoveryKey() }), /did not work/);
  const r = await A.restoreYear(f, NEWP, 2021, undefined, { recovery: k }); assert.equal(r.year, 2021);
  assert.match(src('src/ui/archive-ui.js'), /id: 'arch-open-key'/);
});

test('SEC-129 a recovery-key open on the lock screen does not hold the decrypted vault: cancel and the time limit drop it', async () => {
  const ad = await vault(build()); const k = await enable(); S.lock(); void ad;
  const o = await S.openWithRecovery(k); o.cancel();
  await rej(o.prepare(NEWP), /no longer valid/);
  const o2 = await S.openWithRecovery(k), p2 = await o2.prepare(NEWP);
  const now = Date.now; Date.now = () => now() + S.RECOVERY_HOLD_MS + 1000;
  try { await rej(p2.finish(p2.key), /no longer valid/); } finally { Date.now = now; }
  assert.equal(S.isUnlocked(), false);
  const o3 = await S.openWithRecovery(k), p3 = await o3.prepare(NEWP); const n0 = (await p3.finish(p3.key)).entries.length; assert.ok(S.isUnlocked());
  o3.cancel(); assert.equal(S.getState().entries.length, n0, 'a cancel after the recovery finished never empties the live vault'); assert.ok(n0 > 0);
});

test('SEC-130 a passphrase change checks the current passphrase before a new recovery key is shown (main and private)', () => {
  const app = src('src/ui/app.js');
  const main = app.slice(app.indexOf("h('h2', { text: 'Change passphrase' })") - 1500, app.indexOf("h('h2', { text: 'Change passphrase' })"));
  assert.ok(main.indexOf('matchesMain(') > -1 && main.indexOf('matchesMain(') < main.indexOf('rcf.opts()'), 'main: the passphrase is checked first');
  const priv = app.slice(app.indexOf("if (rcp.on)"), app.indexOf("if (rcp.on)") + 900);
  assert.ok(priv.indexOf('L.priv.matches(') > -1 && priv.indexOf('L.priv.matches(') < priv.indexOf('rcp.opts()'), 'private: the passphrase is checked first');
});

test('SEC-131 a key included on the recovery sheet is dropped when the sheet is left, for both vaults', () => {
  const ui = src('src/ui/recovery-ui.js'), app = src('src/ui/app.js');
  assert.match(ui, /function dropSheet\(\) \{ sheetKeys = \{ main: '', priv: '' \}; \}/);
  assert.match(app, /view\.kind !== 'recovery'\)\) L\.recoveryUI\.dropSheet\(\)/);
  assert.match(ui, /c\.btn\('Recovery sheet', function \(\) \{ dropSheet\(\);/);
});

test('SEC-132 the docs link to each other with valid relative links, and RECOVERY.md says how to keep a key and what to do if it was seen', () => {
  const gs = src('docs/GETTING-STARTED.md');
  const links = Array.from(gs.matchAll(/\]\(([^)]+)\)/g), (m) => m[1]);
  for (const f of ['FIRST-RUN.md', 'SYNC-SETUP.md', 'AI-SETUP.md', 'RECOVERY.md']) assert.ok(links.includes(f), f);
  for (const l of links) assert.ok(existsSync(new URL('../docs/' + l, import.meta.url)), l);
  const rc = src('docs/RECOVERY.md');
  assert.match(rc, /## How to keep a key/); assert.match(rc, /not as a photo/i); assert.match(rc, /## If a key may have been seen/);
  for (const t of [gs, rc]) assert.ok(!t.includes('—'));
});

test('audit proofs (real keys): wraps are bound to their kind, cannot be spliced between copies or vaults, the stub is not a wrap, and unwrapped data keys are non-extractable', async () => {
  realKeys();
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS); await P.setUp(PRIV); P.close('system');
  const k = await enable(); const env = clone(ad._m.get('envelope'));
  const o = await V.openEnvelope(env, PASS); assert.equal(o.key.extractable, false); assert.deepEqual(o.key.usages.sort(), ['decrypt', 'encrypt']);
  assert.equal((await V.openEnvelope(env, { recovery: k })).key.extractable, false);
  // kind relabelled: the AAD names the kind, so the passphrase wrap does not open as a recovery wrap or the other way round
  const relabel = clone(env); relabel.wraps = [Object.assign({}, env.wraps[1], { kind: 'passphrase', kdf: env.wraps[0].kdf }), Object.assign({}, env.wraps[0], { kind: 'recovery', kdf: env.wraps[1].kdf })];
  await rej(V.openEnvelope(relabel, PASS), /BAD_PASSPHRASE_OR_DATA/);
  // a recovery wrap from a backup made with the same key, spliced into the stored vault: a different data key, refused
  const bk = JSON.parse(await V.exportBackup(BKP, S.getState(), k));
  const spliced = clone(env); spliced.wraps[1] = bk.wraps[1];
  await rej(V.openEnvelope(spliced, { recovery: k }), /BAD_PASSPHRASE_OR_DATA/); // the wrap opens (same key text) but it holds the backup data key, so the data refuses
  // the main recovery wrap spliced into the private blob does not open it, with either key
  const st = S.getState(), blob = clone(st.priv);
  await assert.rejects(P.openWithRecovery(k), /BAD_RECOVERY_KEY/);
  const pb = Object.assign(clone(blob), { wraps: [blob.wraps[0], env.wraps[1]] });
  await rej(V.unwrapWith(pb.wraps, { recovery: k }).then((x) => V.decrypt(x.key, pb)), /BAD_PASSPHRASE_OR_DATA/);
  // the older-app stub (no AAD) cannot stand in for a wrap, and a wrap cannot stand in for the stub
  const stubAsWrap = clone(env); stubAsWrap.wraps[0] = Object.assign({}, env.wraps[0], { iv: env.iv, wk: Buffer.from(env.ct, 'base64').subarray(0, 48).toString('base64') });
  await rej(V.openEnvelope(stubAsWrap, PASS), /BAD_PASSPHRASE_OR_DATA/);
  const wrapAsStub = clone(env); wrapAsStub.iv = env.wraps[0].iv; wrapAsStub.ct = env.wraps[0].wk;
  await rej(V.openEnvelope(wrapAsStub, PASS), /BAD_PASSPHRASE_OR_DATA/);
  // every wrap and every write uses its own salt and IV
  const all = [env, bk, JSON.parse(await V.exportBackup(BKP, S.getState(), k))];
  const salts = all.flatMap((e) => e.wraps.map((w) => w.kdf.salt)), ivs = all.flatMap((e) => e.wraps.map((w) => w.iv).concat([e.iv, e.data.iv]));
  assert.equal(new Set(salts).size, salts.length); assert.equal(new Set(ivs).size, ivs.length);
  assert.ok(!ad._m.get('envelope').wraps.some((w) => blob.wraps.some((x) => x.kdf.salt === w.kdf.salt)), 'main and private wraps never share a salt');
  fastKeys();
});
