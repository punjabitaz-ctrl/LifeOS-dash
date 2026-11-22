// v2.0.0 audit (docs/SECURITY.md "v2.0.0 audit"): app-side regression tests against the real service.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { L, PASS, E, memAdapter } from './_load.mjs';
import { vault, clone, fastKeys, realKeys } from './_archive.mjs';
import { loadConfig } from '../server/lib/config.mjs';
import { createApp } from '../server/lib/app.mjs';

const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), N = live('nas'), O = live('ops'), P = live('priv'), V = live('vault');
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const APP = 'https://lifeos.example.test';
const MARK = 'AUDIT "quoted" marker with spaces';
const rej = async (p, re) => { try { await p; } catch (e) { if (re) assert.match(String(e.message) + ' ' + e.code, re); return e; } assert.fail('expected a rejection'); };
let srv = null, dir = null;
async function startService() {
  dir = mkdtempSync(join(tmpdir(), 'lifeos-v200a-'));
  const a = createApp(loadConfig({}, { configDir: join(dir, 'cfg'), dataDir: join(dir, 'data'), appOrigins: [APP], port: 0, writePerMin: 5000, rateLimitPerMin: 50000, log: () => {} }));
  await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
  srv = Object.assign(a, { base: 'http://127.0.0.1:' + a.server.address().port });
  L.nas._setFetch((u, o) => fetch(u, o)); L.nas._setBase(srv.base);
}
async function stopService() {
  L.nas._setFetch(null); L.nas._setBase(null);
  if (srv) { srv.server.closeAllConnections(); await new Promise((r) => srv.server.close(r)); srv = null; }
  if (dir) rmSync(dir, { recursive: true, force: true });
}
const test = (name, fn) => nodeTest(name, async (t) => {
  fastKeys(); O._reset(); await startService();
  try { return await fn(t); } finally { try { P.close('system'); } catch (e) { /* closed */ } try { S.lock(); } catch (e) { /* locked */ } await stopService(); realKeys(); }
});
async function device(name = 'laptop') { const ad = await vault(null); const { hash } = await N.createToken(); srv.tokens.register(name, hash); return ad; }
const tok = () => S.getState().settings.nas.token;
const restoreOn = async (id, expected) => (await fetch(srv.base + '/v1/versions/' + id + '/restore', { method: 'POST', headers: { authorization: 'Bearer ' + tok(), 'x-expected-rev': String(expected) } })).status;

test('SEC-134: after a restore on the NAS every sync was refused for good, and restoring the saved file did not help; replaceOlder saves the NAS copy first, never adopts it, and ends the dead end', async () => {
  // real key derivation here: the backup path always uses it, as on a real device
  realKeys(); S._setAdapter(memAdapter()); S.lock(); await S.init(PASS);
  srv.tokens.register('laptop', (await N.createToken()).hash);
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 1, title: MARK })); }); await N.run();
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 2 })); }); await N.run();
  const list = await N.versions();
  assert.equal(await restoreOn(list[1].id, list[0].id), 200);
  await rej(N.run(), /ROLLBACK/);
  await rej(N.run(), /ROLLBACK/);
  // the guide's old advice: save the NAS version as a file and restore it in the app. The NAS bookkeeping stays, so sync is still refused.
  const file = await N.getVersion(list[1].id);
  const back = await V.importBackup(PASS, file);
  assert.equal(back.entries.length, 1, 'a NAS history file opens as a backup (amendment 3 works)');
  await S.replaceState(back);
  await rej(N.run(), /ROLLBACK/);
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 3 })); });
  const localBefore = clone(S.getState().entries);
  await rej(N.replaceOlder({}), /backup/);
  const saved = [];
  const r = await N.replaceOlder({ saveBackup: async (t, n) => { saved.push([n, t]); } });
  assert.equal(r.kind, 'uploaded');
  assert.equal(saved.length, 1); assert.match(saved[0][0], /^lifeos-nas-copy-\d{4}-\d{2}-\d{2}\.json$/); assert.equal(saved[0][1], file);
  assert.deepEqual(S.getState().entries, localBefore, 'the older copy was never adopted');
  assert.equal((await N.run()).kind, 'in-sync');
  // when the NAS copy is not older, replaceOlder refuses and writes nothing
  const n0 = (await N.versions()).length;
  await rej(N.replaceOlder({ saveBackup: async () => { assert.fail('nothing to save'); } }), /no longer older/);
  assert.equal((await N.versions()).length, n0);
});

test('SEC-134: replaceOlder is a compare-and-swap on the revision it read: a write that lands in between is never overwritten', async () => {
  await device();
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 1 })); }); await N.run();
  await S.commit((x) => { x.entries.push(E({ domain: 'money', type: 'expense', value: 2 })); }); await N.run();
  const list = await N.versions();
  assert.equal(await restoreOn(list[1].id, list[0].id), 200);
  let hit = false;
  L.nas._setFetch(async (u, o) => {
    if (o.method === 'PUT' && !hit) { hit = true; assert.equal(await restoreOn(list[0].id, list[0].id + 1), 200); }
    return fetch(u, o);
  });
  await rej(N.replaceOlder({ saveBackup: async () => {} }), /REMOTE_CHANGED/);
  L.nas._setFetch((u, o) => fetch(u, o));
  assert.equal((await N.versions())[0].envRev, list[0].envRev, 'the other write stays current');
});

nodeTest('SEC-134: the UI offers the replace step on ROLLBACK and starts the Drive step only after a NAS dialog has closed', () => {
  const ui = src('src/ui/nas-ui.js');
  assert.match(ui, /e\.code === 'ROLLBACK'\) \{[^}]*rollbackDialog\(pass\); return true; \}/);
  assert.match(ui, /e\.code === 'NEED_PASSPHRASE'\) \{[^}]*askPass\(\); return true; \}/);
  assert.match(ui, /function driveLater\(\) \{ setTimeout\(function \(\) \{ thenDrive\(\); \}, 0\); \}/);
  assert.ok(!/\.then\(thenDrive\)|return thenDrive\(\)/.test(ui), 'no NAS dialog waits on the Drive step');
  assert.ok(!/—/.test(ui));
});

nodeTest('validateState: prototype keys in the new settings never reach the state or Object.prototype', () => {
  const full = S.defaultState();
  for (const bad of ['{"token":"","__proto__":{"polluted":1}}', '{"__proto__":{"token":"lfs_x"}}']) {
    const o = clone(full); o.settings.nas = JSON.parse(bad);
    let got = null; try { got = S.validateState(o); } catch (e) { assert.match(e.message, /Invalid data/); }
    if (got) { assert.deepEqual(Object.keys(got.settings.nas).sort(), ['fp', 'keySalt', 'remoteRev', 'srev', 'token', 'tokenAt']); assert.equal(got.settings.nas.token, ''); }
  }
  const o = clone(full); o.settings.aiHosts = JSON.parse('{"nasModel":"m","__proto__":{"fallback":"nas"}}');
  let got = null; try { got = S.validateState(o); } catch (e) { assert.match(e.message, /Invalid data/); }
  if (got) assert.equal(got.settings.aiHosts.fallback, '');
  assert.equal(({}).polluted, undefined); assert.equal(({}).fallback, undefined); assert.equal(({}).token, undefined);
});

nodeTest('SEC-135: the v030 CSP check pins exactly the three names in config/hosts.json again', () => {
  const t = src('test/v030.test.mjs');
  assert.ok(!t.includes('( https:\\/\\/[a-z0-9.-]+){3}'), 'the loosened any-three-hosts pattern is gone');
  assert.match(t, /hosts\.json/);
});
