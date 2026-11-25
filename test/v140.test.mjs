// v1.4.0 "Phone first": history, service worker rules, manifest, lock-screen restore paths, setup checklist, dashboard defaults, accessibility rules.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { L, PASS, memAdapter } from './_load.mjs';
import { fastKeys, realKeys, clone } from './_archive.mjs';
import { buildAll, headersFor, swFor, SW_CSP } from '../build.mjs';
import { ICONS } from '../src/icons.mjs';

const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), V = view('vault'), N = view('nav'), SY = view('sync'), LY = view('layout'), SU = view('setup'), P = view('pwa'), O = view('ops');
const ROOT = new URL('..', import.meta.url).pathname;
const src = (f) => readFileSync(join(ROOT, f), 'utf8');
const VERSION = JSON.parse(src('package.json')).version;
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { S.lock(); } catch (e) { /* locked */ } realKeys(); } });
const fresh = () => S.validateState(S.defaultState());
// An envelope with the real key cost (the vault module derives keys with its own copy of the function).
const craft = async (pass, obj) => { realKeys(); try { const salt = V.newSalt(), key = await V.deriveKey(pass, salt); return JSON.stringify(await V.makeEnvelope(key, salt, obj)); } finally { fastKeys(); } };

// ---------- history (B5) ----------
function fakeHistory() {
  const st = [null]; let i = 0, cb = null;
  const fire = () => { if (cb) cb(st[i]); };
  return { get state() { return st[i]; }, pushState(s) { st.splice(i + 1); st.push(s); i++; }, replaceState(s) { st[i] = s; },
    back() { if (i > 0) { i--; fire(); } }, go(n) { const j = Math.max(0, Math.min(st.length - 1, i + n)); if (j !== i) { i = j; fire(); } },
    listen(f) { cb = f; }, stack: st, at: () => i };
}
function harness() {
  const hist = fakeHistory(), env = { view: { name: 'lock' }, unlocked: false, dlg: false, log: [] };
  const nav = N.create({ history: hist, getView: () => env.view, setView: (v) => { env.view = v; env.log.push(v); }, isUnlocked: () => env.unlocked, dialogOpen: () => env.dlg, closeDialog: () => { env.dlg = false; env.log.push('dialog closed'); } });
  hist.listen((s) => nav.onPop(s));
  const now = (f) => f();
  const go = (v) => { env.view = v; nav.push(v); };
  return { hist, env, nav, go, now, unlock() { env.unlocked = true; env.view = { name: 'dashboard' }; nav.start(); }, openDlg() { env.dlg = true; nav.dialogOpened(); }, closeDlg() { env.dlg = false; nav.dialogClosed((f) => f()); } };
}
const NAMEONLY = /^(lock|dialog|dashboard|review|memory|settings|private|archive|business|v:[a-z]+)$/;
test('history: entries hold only a view name; back walks the views; a view key round trips', () => {
  const t = harness(); t.nav.reset(); t.unlock();
  t.go({ name: 'domain', domain: 'money' }); t.go({ name: 'review' }); t.go({ name: 'domain', domain: 'work', revenue: true });
  assert.deepEqual(t.hist.stack, ['dashboard', 'v:money', 'review', 'v:command']);
  for (const s of t.hist.stack) assert.match(s, NAMEONLY);
  t.hist.back(); assert.deepEqual(t.env.view, { name: 'review' });
  t.hist.back(); assert.deepEqual(t.env.view, { name: 'domain', domain: 'money' });
  t.hist.back(); assert.deepEqual(t.env.view, { name: 'dashboard' });
  for (const k of N.all()) assert.equal(N.keyOf(N.viewOf(k)), k, k);
  assert.equal(N.keyOf({ name: 'domain', domain: 'a/../b', id: 'secret-id' }), 'dashboard');
  assert.equal(N.keyOf({ name: 'print', year: 2026 }), 'business');
  t.go({ name: 'domain', domain: 'money', recordId: 'abc', title: 'Private thing' });
  assert.ok(t.hist.stack.every((s) => NAMEONLY.test(s)) && !JSON.stringify(t.hist.stack).includes('abc'));
});
test('history: the same view twice adds one entry; a dialog gets an entry, back closes it, and closing it by hand removes it', () => {
  const t = harness(); t.nav.reset(); t.unlock(); t.go({ name: 'domain', domain: 'money' }); t.go({ name: 'domain', domain: 'money' });
  assert.equal(t.hist.stack.length, 2);
  t.openDlg(); assert.equal(t.hist.state, 'dialog');
  t.hist.back(); assert.ok(t.env.log.includes('dialog closed')); assert.equal(t.hist.state, 'v:money');
  t.env.log.length = 0;
  t.openDlg(); t.closeDlg(); assert.equal(t.hist.state, 'v:money'); assert.equal(t.hist.at(), 1);
  t.hist.back(); assert.deepEqual(t.env.view, { name: 'dashboard' });
});
test('history: a view change made from inside a dialog (the More sheet) takes over the dialog entry; a stale dialog entry is skipped by back', () => {
  const t = harness(); t.nav.reset(); t.unlock(); t.go({ name: 'domain', domain: 'money' });
  t.openDlg(); t.env.dlg = false; t.go({ name: 'settings' });
  assert.deepEqual(t.hist.stack, ['dashboard', 'v:money', 'settings']);
  t.hist.back(); assert.deepEqual(t.env.view, { name: 'domain', domain: 'money' });
  // a dialog entry left behind by a view change that did not take it over
  const u = harness(); u.nav.reset(); u.unlock(); u.hist.pushState('dialog', ''); u.hist.pushState('v:review', ''); u.env.view = { name: 'review' };
  u.hist.back(); assert.equal(u.hist.state, 'dashboard'); assert.deepEqual(u.env.view, { name: 'dashboard' });
});
test('history: locking clears the in-app history; back and forward after a lock change nothing; a reload starts on the lock marker', () => {
  const t = harness(); t.nav.reset(); t.unlock();
  t.go({ name: 'domain', domain: 'money' }); t.go({ name: 'business' }); t.go({ name: 'private' });
  t.env.unlocked = false; t.env.view = { name: 'lock' }; t.env.log.length = 0;
  t.nav.lock();
  assert.equal(t.hist.at(), 0); assert.equal(t.hist.state, 'lock'); assert.equal(t.nav._depth(), 0);
  t.hist.go(1); t.hist.go(1); t.hist.go(1);
  assert.deepEqual(t.env.log, [], 'no view was set while locked');
  assert.ok(t.hist.stack.every((s) => s === null || NAMEONLY.test(s)));
  assert.equal(t.hist.state, 'lock', 'a forward entry visited while locked is re-marked');
  const r = harness(); r.hist.pushState('v:private', ''); r.nav.reset(); assert.equal(r.hist.state, 'lock');
  r.hist.back(); assert.deepEqual(r.env.log, []);
});
test('history: private vault entries are names only and nothing is reachable after lock', () => {
  const t = harness(); t.nav.reset(); t.unlock(); t.go({ name: 'private' });
  assert.equal(t.hist.state, 'private');
  t.env.unlocked = false; t.nav.lock(); t.hist.go(5);
  assert.deepEqual(t.env.log, []);
});
test('navigation lists: five bar items plus More reach all areas; no duplicates; labels are plain', () => {
  assert.deepEqual(N.BAR.map((x) => x.label), ['Overview', 'Money', 'Work', 'Health']);
  const want = ['Assets', 'Command center', 'Business', 'Goals', 'Home and property', 'Admin', 'Learning', 'Activities', 'Social', 'Private vault', 'Wellbeing', 'Review', 'Settings'];
  for (const w of want) assert.ok(N.MORE.some((x) => x.label === w), w);
  const keys = N.all(); assert.equal(new Set(keys).size, keys.length);
  for (const d of N.DOMAINS) assert.ok(keys.includes('v:' + d), d);
  for (const k of ['review', 'memory', 'settings', 'private', 'business']) assert.ok(keys.includes(k), k);
  assert.ok(!/—/.test(JSON.stringify([N.BAR, N.MORE])));
});

// ---------- service worker (B8) ----------
const all = buildAll(ROOT);
function res(body, o = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const r = { status: o.status === undefined ? 200 : o.status, type: o.type || 'basic', redirected: !!o.redirected, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (o.ct === undefined ? 'text/html; charset=utf-8' : o.ct) : null) },
    text: async () => buf.toString('utf8'), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), _id: Math.random() };
  r.clone = () => r;
  return r;
}
function loadSW(opts = {}) {
  const handlers = {}, store = new Map(), calls = { skip: 0, claim: 0, fetch: [] };
  const caches = {
    open: async (n) => { if (!store.has(n)) store.set(n, new Map()); const m = store.get(n); return { put: async (k, v) => { m.set(k, v); }, match: async (k) => m.get(k) }; },
    keys: async () => [...store.keys()], delete: async (n) => store.delete(n)
  };
  const self = { location: { href: 'https://live.test/dist/sw.js', origin: 'https://live.test' }, registration: { active: opts.active || null },
    addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting: () => { calls.skip++; }, clients: { claim: async () => { calls.claim++; } } };
  const net = opts.net || (async () => { throw new Error('offline'); });
  const ctx = vm.createContext({ self, caches, URL, Response, Uint8Array, String, JSON, Promise, fetch: async (u, o) => { calls.fetch.push([typeof u === 'string' ? u : u.url, o]); return net(typeof u === 'string' ? u : u.url, o); } });
  vm.runInContext(swFor(ROOT), ctx);
  const fire = async (type, ev) => { let p; ev.waitUntil = (x) => { p = x; }; ev.respondWith = (x) => { p = x; ev._responded = true; }; handlers[type](ev); await p; return ev; };
  const fetchEv = async (url, method = 'GET') => { const ev = { request: { url, method } }; let out; ev.respondWith = (x) => { out = x; ev._responded = true; }; handlers.fetch(ev); return { ev, res: out ? await out : undefined }; };
  return { handlers, store, calls, fire, fetchEv, cache: () => store.get('lifeos-shell-' + VERSION) || new Map() };
}
const PAGE = 'https://live.test/dist/lifeos', MAN = 'https://live.test/dist/manifest.webmanifest', ICON = 'https://live.test/dist/icons/icon-192.png';
const goodNet = async (u) => (u.split('?')[0] === PAGE || u === PAGE + '.html' ? res(all.html) : u === MAN ? res(all.manifest, { ct: 'application/manifest+json' }) : u.endsWith('.png') ? res(all.icons[0].data, { ct: 'image/png' }) : res('nope', { status: 404 }));
test('service worker: carries the one version and no placeholders', () => {
  const code = swFor(ROOT);
  assert.ok(code.includes("var VERSION = '" + VERSION + "';") && !/__[A-Z]+__/.test(code));
  assert.equal(all.sw, code); assert.ok(all.html.includes('<meta name="lifeos-shell" content="' + VERSION + '">'));
  assert.equal(JSON.parse(all.manifest).lifeos_shell, VERSION);
  for (const i of all.icons) assert.ok(i.data.includes('lifeos-shell\0' + VERSION));
});
test('service worker: caches a proven shell, one request at a time, and serves it when the network is gone', async () => {
  const w = loadSW({ net: goodNet });
  for (const u of [PAGE, MAN, ICON]) { const r = await w.fetchEv(u); assert.ok(r.ev._responded && r.res.status === 200); }
  assert.deepEqual([...w.cache().keys()].sort(), [ICON, MAN, PAGE].sort());
  const off = loadSW({ net: async () => { throw new Error('offline'); } });
  off.store.set('lifeos-shell-' + VERSION, new Map(w.cache()));
  const hit = await off.fetchEv(PAGE); assert.equal(hit.res.status, 200);
  const alias = await off.fetchEv(PAGE + '.html'); assert.equal(alias.res.status, 200, 'the .html address falls back to the cached shell');
  const miss = await off.fetchEv(ICON.replace('192', '512')); assert.equal(miss.res.type, 'error');
  const none = loadSW(); const nothing = await none.fetchEv(PAGE); assert.equal(nothing.res.type, 'error');
});
test('service worker: never intercepts off-origin, non-GET or non-shell requests', async () => {
  const w = loadSW({ net: goodNet });
  for (const u of ['https://api.anthropic.com/v1/messages', 'https://www.googleapis.com/drive/v3/files', 'https://live.test.evil.example/dist/lifeos', 'http://live.test/dist/lifeos', 'https://live.test/dist/other.js', 'https://live.test/dist/sw.js', 'https://live.test/api/data']) {
    const r = await w.fetchEv(u); assert.equal(r.ev._responded, undefined, u);
  }
  assert.equal((await w.fetchEv(PAGE, 'POST')).ev._responded, undefined);
  assert.equal(w.calls.fetch.length, 0); assert.equal(w.cache().size, 0);
  const q = await w.fetchEv(PAGE + '?x=1'); assert.ok(q.ev._responded); assert.ok(w.cache().has(PAGE), 'the query is dropped from the key');
});
test('service worker: never caches a redirect, a non-200, an Access page, another type or an unmarked or older shell', async () => {
  const cases = {
    redirect: res('', { status: 302 }), redirected: res(all.html, { redirected: true }), opaqueredirect: res('', { status: 0, type: 'opaqueredirect' }), cors: res(all.html, { type: 'cors' }),
    notFound: res('x', { status: 404 }), serverError: res(all.html, { status: 500 }), partial: res(all.html, { status: 206 }),
    access: res('<html><title>Sign in</title><form action="https://team.cloudflareaccess.com/cdn-cgi/access/login">Cloudflare Access</form></html>'),
    json: res(all.html, { ct: 'application/json' }), noType: res(all.html, { ct: '' }),
    older: res(all.html.replace('content="' + VERSION + '"', 'content="0.0.1"')), newer: res(all.html.replace('content="' + VERSION + '"', 'content="99.0.0"')),
    marker: res('<p>just <meta name="lifeos-shell"> text</p>')
  };
  for (const [name, r] of Object.entries(cases)) {
    const w = loadSW({ net: async () => r });
    const out = await w.fetchEv(PAGE);
    assert.equal(out.res, r, name + ' is passed through unchanged');
    assert.equal(w.cache().size, 0, name + ' was cached');
  }
  const man = loadSW({ net: async () => res(JSON.stringify({ name: 'x' }), { ct: 'application/manifest+json' }) }); await man.fetchEv(MAN); assert.equal(man.cache().size, 0);
  const man2 = loadSW({ net: async () => res(all.manifest, { ct: 'text/html' }) }); await man2.fetchEv(MAN); assert.equal(man2.cache().size, 0);
  const ic = loadSW({ net: async () => res(Buffer.from('not a png'), { ct: 'image/png' }) }); await ic.fetchEv(ICON); assert.equal(ic.cache().size, 0);
  const ic2 = loadSW({ net: async () => res(all.icons[0].data.toString('latin1').replace(VERSION, '0.0.1'), { ct: 'image/png' }) }); await ic2.fetchEv(ICON); assert.equal(ic2.cache().size, 0);
  const ic3 = loadSW({ net: async () => res(all.icons[0].data, { ct: 'text/html' }) }); await ic3.fetchEv(ICON); assert.equal(ic3.cache().size, 0);
  // a bad answer after a good one never replaces the good copy
  const w = loadSW({ net: goodNet }); await w.fetchEv(PAGE); const kept = w.cache().get(PAGE);
  w.fetchEv; const w2 = loadSW({ net: async () => cases.access }); w2.store.set('lifeos-shell-' + VERSION, new Map([[PAGE, kept]])); await w2.fetchEv(PAGE);
  assert.equal(w2.cache().get(PAGE), kept);
});
test('service worker: install precaches only proven shell files, takes over only when there is no older worker, and an update waits', async () => {
  const w = loadSW({ net: goodNet }); await w.fire('install', {});
  assert.deepEqual(w.calls.fetch.map((c) => c[0]).sort(), [PAGE, MAN, ...ICONS.map((i) => 'https://live.test/dist/' + i.path)].sort());
  assert.ok(w.calls.fetch.every((c) => c[1].redirect === 'manual' && c[1].credentials === 'same-origin'));
  assert.equal(w.cache().size, 5); assert.equal(w.calls.skip, 1);
  const bad = loadSW({ net: async () => res('<html>Access</html>') }); await bad.fire('install', {}); assert.equal(bad.cache().size, 0);
  const off = loadSW(); await off.fire('install', {}); assert.equal(off.cache().size, 0, 'an offline install does not fail');
  const upd = loadSW({ net: goodNet, active: {} }); await upd.fire('install', {}); assert.equal(upd.calls.skip, 0, 'an update never takes over by itself');
  upd.handlers.message({ data: { type: 'SKIP_WAITING' } }); assert.equal(upd.calls.skip, 1);
  upd.handlers.message({ data: { type: 'other' } }); upd.handlers.message({}); assert.equal(upd.calls.skip, 1);
});
test('service worker: activate removes other versions of its own cache only and claims the page', async () => {
  const w = loadSW(); w.store.set('lifeos-shell-0.0.1', new Map()); w.store.set('lifeos-shell-' + VERSION, new Map()); w.store.set('someone-else', new Map());
  await w.fire('activate', {});
  assert.deepEqual([...w.store.keys()].sort(), ['lifeos-shell-' + VERSION, 'someone-else'].sort()); assert.equal(w.calls.claim, 1);
});
test('service worker source: no reload call, no user data, no inline eval', () => {
  const s = src('src/sw.js');
  assert.ok(!/\.reload\(|navigate\(|indexedDB|localStorage|eval\(|importScripts|new Function/.test(s));
});

// ---------- registration and update prompt ----------
function fakeEnv(protocol, controller) {
  const sw = { controller: controller ? {} : null, regs: [], listeners: {}, register(u, o) { this.regs.push([u, o]); return Promise.resolve(reg); }, addEventListener(t, f) { this.listeners[t] = f; } };
  const reg = { waiting: null, installing: null, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } };
  const links = [], doc = { head: { appendChild: (l) => links.push(l) }, querySelector: () => null, createElement: () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }) };
  const loc = { protocol, reloads: 0, reload() { this.reloads++; } };
  const env = { loc, navigator: { serviceWorker: sw }, document: doc, onUpdate: (f) => { env.apply = f; env.prompts = (env.prompts || 0) + 1; } };
  return { env, sw, reg, links };
}
test('registration: https only; the manifest link is added there; a new version prompts and reloads only after the tap', async () => {
  for (const proto of ['file:', 'http:']) { const f = fakeEnv(proto); assert.deepEqual(await P.register(f.env), { registered: false }); assert.equal(f.sw.regs.length, 0); assert.equal(f.links.length, 0); }
  assert.equal(P.eligible({ protocol: 'https:' }, {}), false);
  const f = fakeEnv('https:', true); const r = await P.register(f.env);
  assert.equal(r.registered, true); assert.deepEqual(f.sw.regs[0], ['sw.js', { scope: './', updateViaCache: 'none' }]);
  // v1.4.0 audit (SEC-98): the manifest is fetched with credentials (Cloudflare Access); the iPhone icon is a data: link in the page itself
  assert.deepEqual(f.links.map((l) => l.attrs.rel), ['manifest'], 'no same-origin icon link: the page policy allows only data images'); assert.equal(f.links[0].attrs.crossorigin, 'use-credentials');
  const w = { state: 'installing', listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; } };
  f.reg.installing = w; f.reg.listeners.updatefound(); w.state = 'installed'; w.listeners.statechange();
  assert.equal(f.env.prompts, 1); assert.equal(f.env.loc.reloads, 0);
  f.sw.listeners.controllerchange(); assert.equal(f.env.loc.reloads, 0, 'a controller change before the tap never reloads');
  let posted = null; f.reg.waiting = { postMessage: (m) => { posted = m; } };
  f.env.apply(); assert.deepEqual(posted, { type: 'SKIP_WAITING' }); assert.equal(f.env.loc.reloads, 0);
  f.sw.listeners.controllerchange(); assert.equal(f.env.loc.reloads, 1);
  const first = fakeEnv('https:', false); await P.register(first.env);
  const w2 = { state: 'installed', listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; } };
  first.reg.installing = w2; first.reg.listeners.updatefound(); w2.listeners.statechange(); assert.equal(first.env.prompts, undefined, 'the first install is not an update');
  const rej = fakeEnv('https:', true); rej.sw.register = () => Promise.reject(new Error('blocked')); assert.deepEqual(await P.register(rej.env), { registered: false });
});
test('app: the update prompt never reloads by itself and asks first while unlocked', () => {
  const app = src('src/ui/app.js'), pwa = src('src/ui/pwa.js');
  assert.ok(!/location\.reload|\.reload\(/.test(app));
  assert.ok(/Reloading locks LifeOS/.test(app) && /function updateBanner/.test(app));
  assert.ok(/if \(asked\) env\.loc\.reload/.test(pwa));
});

// ---------- manifest, icons, CSP and headers ----------
test('manifest: valid, under the live path, with PNG icons that are real files carrying the shell marker', () => {
  const m = JSON.parse(all.manifest);
  assert.equal(m.name, 'LifeOS'); assert.equal(m.short_name, 'LifeOS'); assert.equal(m.display, 'standalone');
  assert.ok(m.start_url.startsWith('./') && m.scope === './' && !/^[a-z]+:/i.test(m.start_url));
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i); assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
  const sizes = m.icons.map((i) => i.sizes + ':' + i.purpose); assert.deepEqual(sizes, ['192x192:any', '512x512:any', '512x512:maskable']);
  for (const i of m.icons) assert.ok(i.type === 'image/png' && !/^[a-z]+:|^\//i.test(i.src));
  for (const ic of all.icons) {
    const b = ic.data; assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const want = ICONS.find((x) => x.path === ic.path).size; assert.equal(b.readUInt32BE(16), want); assert.equal(b.readUInt32BE(20), want);
    assert.equal(b.subarray(b.length - 12, b.length - 8).readUInt32BE(0), 0); assert.equal(b.subarray(b.length - 8, b.length - 4).toString('latin1'), 'IEND');
  }
  assert.equal(all.icons.length, 3); assert.ok(!/https?:\/\//.test(src('src/icons.mjs')));
});
test('icons: the maskable icon is opaque to the edge and the others keep a transparent corner', () => {
  const { inflateSync } = require_zlib(); const px = (png) => { const idat = []; let o = 8; while (o < png.length) { const n = png.readUInt32BE(o), t = png.subarray(o + 4, o + 8).toString('latin1'); if (t === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + n)); o += 12 + n; } return inflateSync(Buffer.concat(idat)); };
  const alphaAt = (png, size, x, y) => px(png)[y * (size * 4 + 1) + 1 + x * 4 + 3];
  const mask = all.icons[2].data, any = all.icons[0].data;
  assert.equal(alphaAt(mask, 512, 0, 0), 255); assert.equal(alphaAt(any, 192, 0, 0), 0); assert.equal(alphaAt(any, 192, 96, 96) > 0, true);
});
import { createRequire } from 'node:module';
function require_zlib() { return createRequire(import.meta.url)('node:zlib'); }
test('CSP and headers: exactly manifest-src and worker-src are added; the service worker file has its own strict headers', () => {
  const csp = all.csp.split('; ');
  assert.ok(csp.includes("manifest-src 'self'") && csp.includes("worker-src 'self'"));
  const dirs = csp.map((d) => d.split(' ')[0]);
  assert.deepEqual(dirs, ['default-src', 'script-src', 'style-src', 'connect-src', 'img-src', 'base-uri', 'form-action', 'manifest-src', 'worker-src']);
  assert.ok(all.html.includes('content="' + all.csp + '"'));
  const h = headersFor(all.csp);
  assert.ok(h.includes('/dist/sw.js') && h.includes('! Content-Security-Policy') && h.includes(SW_CSP) && /Cache-Control: no-cache/.test(h.split('/dist/sw.js')[1]));
  assert.ok(!/unsafe-|\*\s/.test(SW_CSP.replace(/connect-src 'self'/, '')));
  assert.equal(src('_headers'), all.headers); assert.equal(src('dist/_headers'), all.headers);
  assert.equal(src('dist/sw.js'), all.sw); assert.equal(src('dist/manifest.webmanifest'), all.manifest);
});

// ---------- lock-screen restore paths (B9) ----------
async function backupOf(mutate, pass = 'backup passphrase one') {
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  if (mutate) await S.commit(mutate);
  const file = await V.exportBackup(pass, S.getState()); S.lock(); return file;
}
const mk = (n) => ({ id: 'a' + n, name: 'Account ' + n, kind: 'cash', liability: false });
test('restore on the lock screen: verify, then one write; the restored vault opens with the backup passphrase and keeps its data', async () => {
  const file = await backupOf((x) => { x.accounts.push(mk(1)); x.settings.currency = 'EUR'; });
  const ad = memAdapter(); S._setAdapter(ad); S.lock();
  const v = await O.verifyBackup('backup passphrase one', file, { schema: S.SCHEMA }); assert.equal(v.ok, true); assert.equal(ad._m.size, 0, 'verify writes nothing');
  const state = await V.importBackup('backup passphrase one', file); await S.createFromBackup('backup passphrase one', state);
  assert.ok(S.isUnlocked()); assert.equal(S.getState().accounts.length, 1); assert.equal(S.getState().settings.currency, 'EUR');
  assert.equal(S.getState().ops.lastBackupAt, '', 'device dates start empty'); assert.equal(S.getState().settings.sync.clientId, '');
  S.lock(); const again = await S.unlock('backup passphrase one'); assert.equal(again.accounts.length, 1);
  assert.ok(!JSON.stringify([...ad._m.values()]).includes('Account 1'));
});
test('restore on the lock screen: every failure leaves no vault, no key and nothing stored', async () => {
  const file = await backupOf((x) => { x.accounts.push(mk(1)); });
  const check = async (f) => { const ad = memAdapter(); S._setAdapter(ad); S.lock(); await assert.rejects(f()); assert.equal(ad._m.size, 0); assert.equal(S.isUnlocked(), false); assert.equal(await S.exists(), false); };
  await check(() => V.importBackup('wrong passphrase!!', file).then((s) => S.createFromBackup('wrong passphrase!!', s)));
  await check(async () => { const e = JSON.parse(file); e.ct = e.ct.slice(0, -8) + 'AAAAAAAA'; const s = await V.importBackup('backup passphrase one', JSON.stringify(e)); return S.createFromBackup('backup passphrase one', s); });
  await check(() => V.importBackup('backup passphrase one', '{"not":"a backup"}'));
  await check(() => V.importBackup('backup passphrase one', 'x'.repeat(10)));
  await check(async () => S.createFromBackup('backup passphrase one', { schema: 3, entries: 'nope' }));
  await check(async () => S.createFromBackup('short', await V.importBackup('backup passphrase one', file)));
  await check(async () => S.createFromBackup('backup passphrase one', { ...clone(fresh()), schema: 99 }));
  const newer = await craft('backup passphrase one', Object.assign(clone(fresh()), { schema: 25 }));
  const v = await O.verifyBackup('backup passphrase one', newer, { schema: S.SCHEMA }); assert.equal(v.ok, false); assert.equal(v.reason, 'NEWER_SCHEMA');
  await check(() => V.importBackup('backup passphrase one', newer));
});
test('restore on the lock screen: refuses to replace an existing vault, and a write failure leaves nothing', async () => {
  const file = await backupOf((x) => { x.accounts.push(mk(2)); });
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS); const before = JSON.stringify([...ad._m.values()]);
  await assert.rejects(S.createFromBackup('backup passphrase one', await V.importBackup('backup passphrase one', file)), /VAULT_EXISTS/);
  assert.equal(JSON.stringify([...ad._m.values()]), before);
  S.lock(); const bad = memAdapter(); bad.set = async () => { throw new Error('disk full'); }; S._setAdapter(bad);
  await assert.rejects(S.createFromBackup('backup passphrase one', await V.importBackup('backup passphrase one', file)), /disk full/);
  assert.equal(S.isUnlocked(), false); assert.equal(bad._m.size, 0);
});
test('restore on the lock screen: a backup whose passphrase equals its private vault passphrase is refused', async () => {
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS); await L.priv.setUp('private passphrase 1'); await S.commit((x) => { x.accounts.push(mk(3)); });
  const file = await V.exportBackup('private passphrase 1', S.getState()); S.lock();
  const ad2 = memAdapter(); S._setAdapter(ad2);
  await assert.rejects(S.createFromBackup('private passphrase 1', await V.importBackup('private passphrase 1', file)), /different from the private vault/);
  assert.equal(ad2._m.size, 0);
  await S.createFromBackup('backup passphrase two', await V.importBackup('private passphrase 1', file)); assert.ok(S.getState().priv);
});
function driveFake(files) {
  const calls = [];
  const f = async (url, o) => {
    calls.push(url); assert.equal(o.credentials, 'omit'); assert.equal(o.redirect, 'error');
    const body = (t, st = 200) => ({ status: st, ok: st < 300, headers: { get: (k) => (k === 'content-length' ? String(t.length) : k === 'etag' ? 'e1' : null) }, text: async () => t });
    if (url.includes('/drive/v3/files?')) return body(JSON.stringify({ files: files.map((x, i) => ({ id: 'file' + i + 'abcdef', size: String(x.length), version: '1' })) }));
    if (url.includes('alt=media')) return body(files[Number(/file(\d)/.exec(url)[1])]);
    return body('{}', 404);
  };
  return { f, calls };
}
async function driveCopy(mutate) { const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS); await S.commit(mutate); const env = JSON.stringify(ad._m.get('envelope')); S.lock(); return env; }
test('Drive copy on the lock screen: same download and inspect checks as sync; the vault opens with the same passphrase; bookkeeping is recorded', async () => {
  const env = await driveCopy((x) => { x.accounts.push(mk(4)); });
  const d = driveFake([env]); SY._setFetch(d.f); SY._setToken('t'.repeat(30), 3600);
  const ad = memAdapter(); S._setAdapter(ad); S.lock();
  const copy = await SY.fetchCopy(); assert.equal(S.isUnlocked(), false); assert.equal(ad._m.size, 0, 'downloading stores nothing');
  await assert.rejects(SY.installCopy(copy, 'not the passphrase', 'abc123.apps.googleusercontent.com'), (e) => e.code === 'WRONG_PASSPHRASE');
  assert.equal(ad._m.size, 0); assert.equal(S.isUnlocked(), false);
  await assert.rejects(SY.installCopy(copy, '', ''), (e) => e.code === 'NEED_PASSPHRASE'); assert.equal(ad._m.size, 0);
  const r = await SY.installCopy(copy, PASS, 'abc123.apps.googleusercontent.com'); assert.equal(r.kind, 'downloaded');
  assert.equal(S.getState().accounts.length, 1); assert.equal(S.getState().settings.sync.clientId, 'abc123.apps.googleusercontent.com'); assert.equal(S.getState().settings.sync.fileId, 'file0abcdef');
  assert.ok(S.getState().ops.lastSyncAt); await assert.rejects(SY.installCopy(copy, PASS, ''), (e) => e.code === 'VAULT_EXISTS');
  SY._setFetch(null); SY._setToken(null);
});
test('Drive copy on the lock screen: tampered, malformed, missing and oversized copies are refused and leave nothing', async () => {
  const env = await driveCopy((x) => { x.accounts.push(mk(5)); });
  const run = async (files, pass, want) => {
    SY._setFetch(driveFake(files).f); SY._setToken('t'.repeat(30), 3600); const ad = memAdapter(); S._setAdapter(ad); S.lock();
    await assert.rejects(async () => { const c = await SY.fetchCopy(); await SY.installCopy(c, pass, ''); }, (e) => e.code === want, want);
    assert.equal(ad._m.size, 0); assert.equal(S.isUnlocked(), false);
  };
  const t = JSON.parse(env); const tamper = Object.assign({}, t, { rev: (t.rev || 0) + 5 });
  await run([JSON.stringify(tamper)], PASS, 'TAMPER');
  await run(['not json'], PASS, 'REMOTE_INVALID'); await run([JSON.stringify({ v: 2 })], PASS, 'REMOTE_INVALID'); await run([], PASS, 'NOT_FOUND');
  const newer = await (async () => { const salt = V.newSalt(), key = await V.deriveKey(PASS, salt); return JSON.stringify(await V.makeEnvelope(key, salt, Object.assign(clone(fresh()), { schema: 25 }))); })();
  await run([newer], PASS, 'REMOTE_INVALID');
  SY._setToken(null); SY._setFetch(driveFake([env]).f); await assert.rejects(SY.fetchCopy(), (e) => e.code === 'RECONNECT');
  SY._setFetch(null);
});
test('Drive sign-in on the lock screen keeps the client ID only in session storage and only when asked; the token is never stored', () => {
  const mem = { d: {}, setItem(k, v) { this.d[k] = v; }, getItem(k) { return this.d[k] === undefined ? null : this.d[k]; }, removeItem(k) { delete this.d[k]; } };
  const loc = { protocol: 'https:', origin: 'https://live.test', pathname: '/dist/lifeos' };
  SY.begin('abc123.apps.googleusercontent.com', { loc, storage: mem }); assert.deepEqual(Object.keys(mem.d), ['lifeos.oauth.state']);
  SY.begin('abc123.apps.googleusercontent.com', { loc, storage: mem, keepClientId: true });
  assert.equal(SY.takeClientId(mem), 'abc123.apps.googleusercontent.com'); assert.equal(SY.takeClientId(mem), '');
  mem.setItem('lifeos.oauth.client', '<script>'); assert.equal(SY.takeClientId(mem), '');
  assert.throws(() => SY.begin('bad', { loc, storage: mem, keepClientId: true })); assert.ok(!JSON.stringify(mem.d).includes('access_token'));
});
test('lock screen source: restore and Drive paths exist only while no vault exists, and nothing is shown from private data', () => {
  const a = src('src/ui/app.js'); const lock = a.slice(a.indexOf('  function lockScreen() {'), a.indexOf('  function archCtx() {'));
  assert.ok(/create && lockPath === 'restore'/.test(lock) && /create && lockPath === 'drive'/.test(lock) && /if \(!create\) lockPath = 'create';/.test(lock));
  assert.ok(/L\.ops\.verifyBackup/.test(lock) && /L\.vault\.importBackup/.test(lock) && /L\.store\.createFromBackup/.test(lock) && /L\.sync\.fetchCopy/.test(lock) && /L\.sync\.installCopy/.test(lock));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(a));
});

// ---------- setup checklist (B9) ----------
test('setup checklist: a new vault shows it with nothing ticked; each item ticks only from real state', async () => {
  const s = fresh(); assert.equal(SU.shown(s), true); assert.ok(SU.items(s, 2026).every((x) => !x.done)); assert.equal(SU.items(s, 2026).length, 6);
  assert.equal(SU.items(s, 2026)[3].label, 'Set the 2026 tax profile');
  const on = (f) => { const t = clone(s); f(t); return SU.items(t, 2026); };
  const done = (items) => items.filter((x) => x.done).map((x) => x.id);
  assert.deepEqual(done(on((t) => { t.settings.currency = 'EUR'; })), ['targets']);
  assert.deepEqual(done(on((t) => { t.settings.targets.contactDays = 14; })), ['targets']);
  assert.deepEqual(done(on((t) => { t.settings.setup.targetsSaved = true; })), ['targets']);
  assert.deepEqual(done(on((t) => { t.accounts.push(mk(6)); })), ['accounts']);
  assert.deepEqual(done(on((t) => { t.projects.push({ id: 'p1', name: 'Line' }); })), ['lines']);
  assert.deepEqual(done(on((t) => { t.taxYears['2026'] = { year: 2026 }; })), ['tax']);
  assert.deepEqual(done(on((t) => { t.ops.lastBackupAt = '2026-11-18'; })), ['backup']);
  assert.deepEqual(done(on((t) => { t.ops.lastSyncAt = '2026-11-18'; })), ['backup']);
  assert.deepEqual(done(on((t) => { t.ops.persist = { result: 'granted', at: '2026-11-18' }; })), ['storage']);
  assert.deepEqual(done(on((t) => { t.ops.persist = { result: 'denied', at: '2026-11-18' }; })), []);
  // a tap on Dismiss changes nothing about the items
  assert.deepEqual(done(on((t) => { t.settings.setup.dismissed = true; })), []);
  const t = clone(s); t.settings.setup.dismissed = true; assert.equal(SU.shown(t), false);
  assert.equal(SU.allDone(s, 2026), false);
});
test('setup checklist: real saves tick it through the store; export marks the backup; an older vault never shows it', async () => {
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  assert.equal(SU.shown(S.getState()), true);
  await S.commit((x) => { x.accounts.push(mk(7)); x.settings.setup.targetsSaved = true; x.settings.setup.dismissed = true; });
  const st = S.getState(); assert.deepEqual([SU.shown(st), SU.items(st, 2026).filter((i) => i.done).map((i) => i.id)], [false, ['targets', 'accounts']]);
  S.lock(); await S.unlock(PASS); assert.equal(S.getState().settings.setup.dismissed, true);
  const old = clone(fresh()); old.schema = 15; delete old.settings.setup; const got = S.validateState(old);
  assert.deepEqual(got.settings.setup, { dismissed: true, targetsSaved: false }); assert.equal(got.schema, 24);
  const bad = clone(fresh()); bad.settings.setup = { dismissed: 'yes', targetsSaved: false }; assert.throws(() => S.validateState(bad), /setup/);
  const keys = clone(fresh()); keys.settings.setup = { dismissed: false, targetsSaved: false, extra: 1 }; assert.deepEqual(S.validateState(keys).settings.setup, { dismissed: false, targetsSaved: false });
  assert.deepEqual(S.defaultState().settings.setup, { dismissed: false, targetsSaved: false });
});
test('setup checklist: dismissal does not make the sync fingerprint see a local change', async () => {
  const a = clone(fresh()), b = clone(fresh()); b.settings.setup.dismissed = true;
  assert.equal(await SY.fingerprint(a), await SY.fingerprint(b));
});

// ---------- dashboard defaults (B10) ----------
test('dashboard defaults: narrow hides business modules until a tax profile exists; wide and saved layouts are untouched', () => {
  const s = fresh(), hid = (list) => list.filter((m) => m.hidden).map((m) => m.id).sort();
  assert.deepEqual(hid(LY.get(s.settings, 'narrow', { state: s })), [...LY.BUSINESS].sort());
  assert.deepEqual(hid(LY.get(s.settings, 'narrow')), [], 'without a context the old behaviour');
  assert.deepEqual(hid(LY.get(s.settings, 'wide', { state: s })), []);
  const withTax = clone(s); withTax.taxYears['2026'] = { year: 2026 };
  assert.deepEqual(hid(LY.get(withTax.settings, 'narrow', { state: withTax })), []);
  const saved = clone(s); saved.settings.layouts.narrow = LY.defaultList();
  assert.deepEqual(hid(LY.get(saved.settings, 'narrow', { state: saved })), [], 'a saved layout wins');
  const sv2 = clone(s); sv2.settings.layouts.narrow = LY.setHidden(LY.defaultList(), 'tile-goals', true);
  assert.deepEqual(hid(LY.get(sv2.settings, 'narrow', { state: sv2 })), ['tile-goals']);
  const withTax2 = clone(withTax); withTax2.settings.layouts.narrow = LY.setHidden(LY.defaultList(), 'tax-next', true);
  assert.deepEqual(hid(LY.get(withTax2.settings, 'narrow', { state: withTax2 })), ['tax-next'], 'the user can still hide them');
  const r = clone(s); r.settings.layouts.narrow = LY.defaultList(); LY.reset(r.settings, 'narrow'); assert.deepEqual(hid(LY.get(r.settings, 'narrow', { state: r })), [...LY.BUSINESS].sort());
  assert.ok(LY.BUSINESS.every((id) => LY.MODULES.some((m) => m.id === id)));
});
test('dashboard defaults: modules with no data are empty, and each turns full as soon as it has data', () => {
  const s = fresh(); const tiles = LY.MODULES.map((m) => m.id).filter((id) => /^tile-/.test(id) && id !== 'tile-wellbeing');
  for (const id of tiles.concat(['rev-month', 'rev-net-line', 'rev-expected'])) assert.equal(LY.isEmpty(s, id), true, id);
  assert.equal(LY.isEmpty(s, 'tile-wellbeing'), false); assert.equal(LY.isEmpty(s, 'glance'), false); assert.equal(LY.isEmpty(null, 'tile-money'), false);
  const add = { 'tile-money': (t) => t.budgets.push({}), 'tile-assets': (t) => t.accounts.push(mk(8)), 'tile-work': (t) => t.projects.push({}), 'tile-health': (t) => t.habits.push({}),
    'tile-activities': (t) => t.activities.push({}), 'tile-social': (t) => t.people.push({}), 'tile-learning': (t) => t.learningItems.push({}), 'tile-home': (t) => t.properties.push({}),
    'tile-admin': (t) => t.renewals.push({}), 'tile-goals': (t) => t.goals.push({}), 'rev-month': (t) => t.entries.push({ domain: 'money' }) };
  for (const [id, f] of Object.entries(add)) { const t = clone(s); f(t); assert.equal(LY.isEmpty(t, id), false, id); }
  const t = clone(s); t.entries.push({ domain: 'money' }); assert.equal(LY.isEmpty(t, 'rev-expected'), false); assert.equal(LY.isEmpty(t, 'tile-money'), false);
});

// ---------- accessibility rules (B19) ----------
const css = src('src/ui/styles.css');
function vars(block) { const o = {}; for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{3,6})/gi)) o[m[1]] = m[2]; return o; }
const lum = (hex) => { const h = hex.length === 4 ? '#' + [...hex.slice(1)].map((c) => c + c).join('') : hex; const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
test('accessibility: text colours meet WCAG AA contrast in light and dark', () => {
  const light = vars(css.split('\n')[0]), darkBlock = /prefers-color-scheme:dark\)\{:root\{([^}]*)\}/.exec(css)[1], dark = Object.assign({}, light, vars(darkBlock));
  for (const [name, v] of [['light', light], ['dark', dark]]) {
    for (const [fg, bg] of [['fg', 'bg'], ['fg', 'card'], ['mut', 'bg'], ['mut', 'card'], ['acc', 'card'], ['acc', 'bg'], ['acc-fg', 'acc'], ['ok', 'card'], ['warn', 'card'], ['bad', 'card']]) {
      const r = ratio(v[fg], v[bg]); assert.ok(r >= 4.5, name + ' ' + fg + ' on ' + bg + ' is ' + r.toFixed(2));
    }
  }
});
test('accessibility: bottom bar text is at least 14 px, targets at least 44 px, focus is visible, current area is marked beyond colour', () => {
  assert.ok(/\.nav button\{font-size:\.9rem;padding:12px 2px;min-height:56px\}/.test(css));
  assert.ok(/\.nav\.bar button\{min-width:44px;min-height:56px\}/.test(css) && /\.sheetbtn\{[^}]*min-height:48px/.test(css) && /@media \(max-width:819px\)\{\.btn\.sm\{min-height:44px\}\}/.test(css));
  assert.ok(/:focus-visible\{outline:3px/.test(css));
  assert.ok(/\.nav\.bar button\[aria-current=page\]\{[^}]*box-shadow:inset 0 3px 0/.test(css) && /\.nav button\[aria-current=page\]\{[^}]*font-weight:700/.test(css));
  const a = src('src/ui/app.js'); assert.ok(/'aria-current': n\.key === key \? 'page' : null/.test(a) && /'aria-label': 'Main'/.test(a) && /role: 'dialog', 'aria-modal': 'true', 'aria-label': o\.title/.test(a));
  assert.ok(/e\.key === 'Escape'/.test(a) && /e\.key === 'Tab'/.test(a) && /dlgReturn\.focus\(\)/.test(a));
});
test('accessibility: every chart builder gives an accessible name or is marked decorative beside text', () => {
  const a = src('src/ui/app.js'); const svgs = [...a.matchAll(/h\('svg', \{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(svgs.length > 5);
  for (const p of svgs) assert.ok(/role: 'img'|aria-hidden/.test(p) || /aria-label|labelled/.test(p), p.slice(0, 80));
});
test('copy: no em dashes in the new UI copy and docs', () => {
  const files = ['src/ui/pwa.js', 'src/core/nav.js', 'src/core/setup.js', 'docs/CHANGELOG.md'];
  for (const f of files) assert.ok(!/—/.test(src(f)), f);
  const a = src('src/ui/app.js'); const seg = a.slice(a.indexOf('// v1.4.0 B9: with no vault'), a.indexOf('function archCtx()')) + a.slice(a.indexOf('// ---------- navigation (v1.4.0 B5)'), a.indexOf('// The strip shown while'));
  assert.ok(!/—/.test(seg));
});
test('new inputs follow the autofill and spell check rules through the shared builder', () => {
  const a = src('src/ui/app.js'); assert.ok(/setAttribute\('autocomplete', 'off'\)/.test(a) && /setAttribute\('spellcheck', 'false'\)/.test(a));
  const lock = a.slice(a.indexOf('  function restorePath() {'), a.indexOf('  function archCtx() {'));
  assert.ok(!/document\.createElement\('input'\)/.test(lock) && /passOnly\('rs-pass', 'off'\)/.test(lock) && /passOnly\('dv-pass', 'off'\)/.test(lock));
});
