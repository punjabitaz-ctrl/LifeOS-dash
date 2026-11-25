// v1.2.0 part B smoke: vault archiving end to end (desktop and 390x844). A vault with data across six years (public and private records)
// is seeded; the proposal is checked; the oldest year is archived with a mocked Drive and a download; the live vault shrinks while every
// dashboard, trend, net worth and goal figure stays the same; the archive is opened read-only and searched; the year is restored with
// nothing duplicated; lock, unlock and reload confirm persistence. Fails on console errors, CSP violations or horizontal scroll.
// Run `node build.mjs` first. Needs Playwright and Chrome at /usr/bin/google-chrome.
import path from 'node:path';
import { navTo } from './_nav.mjs';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { L, memAdapter } from './_load.mjs';
import { build, figuresIn, realKeys, clone } from './_archive.mjs';
import { skipTour } from './_tour.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '..', 'dist', 'lifeos.html');
if (!existsSync(file)) { console.error('dist/lifeos.html missing: run node build.mjs first'); process.exit(1); }
let pw;
try { pw = await import('playwright'); } catch { console.log('SKIPPED: playwright not available (npm i --no-save playwright)'); process.exit(0); }
let browser;
for (const o of [{ executablePath: '/usr/bin/google-chrome' }, { channel: 'chrome' }, {}]) {
  try { browser = await pw.chromium.launch(o); break; } catch { /* try next */ }
}
if (!browser) { console.log('SKIPPED: no browser available'); process.exit(0); }

const html = readFileSync(file);
const server = http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;
const TOKEN = 'ya29.SMOKETOKEN_abcdefghijklmnopqrstuvwxyz0123456789';
const PASS = 'correct horse battery staple', PRIVPASS = 'a private vault passphrase 7';
const CID = 'smoke-test-123.apps.googleusercontent.com';
const T = { timeout: 30000 };
const problems = [];
const PRIVMARK = 'PRIVATEARCHIVEITEM';

// ---- the seeded vault, made once with the real key derivation, written into IndexedDB before the app loads ----
async function seed() {
  realKeys();
  const ad = memAdapter(); L.store._setAdapter(ad); L.store.lock(); await L.store.init(PASS);
  const s = build();
  s.settings.sync.clientId = CID;
  s.goals.push({ id: 'gnw', title: 'Net worth goal', horizon: 'monthly', domain: 'assets', metric: 'netWorth', direction: 'up', startValue: 0, targetValue: 900000, startDate: '2026-11-01', dueDate: '2026-11-30', state: 'active', notes: '', createdAt: '2026-10-01T00:00:00.000Z' },
    { id: 'gsr', title: 'Savings goal', horizon: 'monthly', domain: 'money', metric: 'savingsRate', direction: 'up', startValue: 0, targetValue: 50, startDate: '2026-11-01', dueDate: '2026-11-30', state: 'active', notes: '', createdAt: '2026-10-01T00:00:00.000Z' });
  s.entries.push(L.metrics.validateEntry({ id: 'priv-exp', domain: 'money', type: 'expense', date: '2021-08-08', title: PRIVMARK + ' expense', value: 77.25, category: 'Dining' }));
  await L.store.replaceState(L.store.validateState(s));
  await L.priv.setUp(PRIVPASS);
  await L.priv.moveIn('entries', 'priv-exp');
  await L.priv.commit(async (inner) => { inner.wellbeing = { checkins: [{ id: 'wb21', date: '2021-02-03', mood: 4, note: PRIVMARK + ' note' }, { id: 'wb26', date: '2026-02-03', mood: 3 }] }; });
  L.priv.close();
  await new Promise((r) => setTimeout(r, 200));
  const env = await ad.get('envelope');
  const count = L.store.getState().entries.length;
  L.store.lock();
  return { env, count };
}
const SEED = await seed();

const drive = { files: {}, log: [], n: 0 };
async function wire(ctx, label) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,if-match', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', 'access-control-expose-headers': 'etag' };
  await ctx.route('https://accounts.google.com/**', (route) => {
    const u = new URL(route.request().url());
    route.fulfill({ status: 302, headers: { location: u.searchParams.get('redirect_uri') + '#access_token=' + TOKEN + '&token_type=Bearer&expires_in=3599&state=' + u.searchParams.get('state') + '&scope=' + encodeURIComponent('https://www.googleapis.com/auth/drive.appdata') } });
  });
  await ctx.route('https://www.googleapis.com/**', async (route) => {
    const rq = route.request(), u = new URL(rq.url()), m = rq.method();
    const send = (status, body, extra) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json', ...(extra || {}) }, body: body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body)) });
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (rq.headers().authorization !== 'Bearer ' + TOKEN) return send(401, {});
    if (u.pathname === '/drive/v3/files') {
      const q = decodeURIComponent(u.searchParams.get('q') || ''), name = (q.match(/name='([^']+)'/) || [])[1];
      drive.log.push('list ' + name);
      const f = drive.files[name];
      return send(200, { files: f ? [{ id: f.id, size: String(f.text.length), version: String(f.version) }] : [] });
    }
    const id = (u.pathname.match(/\/files\/([^/?]+)/) || [])[1];
    const byId = Object.values(drive.files).find((f) => f.id === id);
    if (m === 'GET' && u.searchParams.get('alt') === 'media') { drive.log.push('get ' + id); return byId ? send(200, byId.text) : send(404, {}); }
    if (m === 'POST') {
      const body = rq.postData(), meta = JSON.parse(body.split('Content-Type: application/json; charset=UTF-8\r\n\r\n')[1].split('\r\n--')[0]);
      const text = body.split('Content-Type: application/json\r\n\r\n')[1].split('\r\n--')[0];
      drive.files[meta.name] = { id: 'arch' + (++drive.n) + 'abcdef', text, version: 1 };
      drive.log.push('create ' + meta.name);
      return send(200, { id: drive.files[meta.name].id });
    }
    if (m === 'PATCH' && byId) { byId.text = rq.postData(); byId.version++; drive.log.push('patch ' + id); return send(200, { id }); }
    return send(500, {});
  });
}
async function newPage(label, viewport) {
  const ctx = await browser.newContext(Object.assign({ acceptDownloads: true }, viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }));
  await wire(ctx, label);
  const page = await ctx.newPage(); await skipTour(page);
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  await page.clock.install({ time: new Date(2026, 10, 14, 10, 0, 0) });
  return { ctx, page };
}
// The same figures the unit tests compare, computed inside the page from the real app state.
const figFn = new Function('today', 'const L = globalThis.LifeOS; return (' + figuresIn.toString() + ')(L, today);');

async function run(label, viewport) {
  const { ctx, page } = await newPage(label, viewport);
  const mobile = !!viewport;
  const nav = (name) => navTo(page, name);
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
  const assertFields = async (where) => {
    const badFields = await page.$$eval('input, textarea', (els) => els.filter((e) => e.getAttribute('type') !== 'password' && !(e.getAttribute('spellcheck') === 'false' && e.getAttribute('autocorrect') === 'off' && e.getAttribute('autocapitalize') === 'off')).map((e) => e.id || e.tagName));
    if (badFields.length) throw new Error(where + ': fields without spell check off: ' + badFields.join(', '));
  };
  const assertNoScroll = async (where) => {
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    if (w[0] > w[1] + 1) throw new Error(where + ': horizontal scroll ' + w[0] + ' > ' + w[1]);
  };
  const unlock = async () => { await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T); };
  const idb = () => page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('lifeos');
    r.onsuccess = () => { const db = r.result, tx = db.transaction('kv', 'readonly'), g = tx.objectStore('kv').get('envelope'); g.onsuccess = () => { db.close(); res(g.result ? (g.result.data || g.result).ct.length : 0); }; g.onerror = rej; };
    r.onerror = rej;
  }));
  const stat = () => page.evaluate(() => { const s = globalThis.LifeOS.store.getState(); return { entries: s.entries.length, ids: new Set(s.entries.map((e) => e.id)).size, archives: s.archives.map((a) => a.year), sessions: s.studySessions.length, contacts: s.contacts.length, priv: s.entries.some((e) => e.id === 'priv-exp') }; });
  // What the screens show: dashboard tiles, the money month walked back to 2021, net worth and the goals.
  async function screens() {
    const out = {};
    await nav('Overview'); await page.waitForSelector('.tile', T);
    out.tiles = await page.$$eval('.tile', (t) => t.map((x) => x.textContent));
    await page.click('.tile[data-domain="goals"]'); await page.waitForSelector('h1', T);
    out.goals = await page.textContent('main');
    await nav('Assets'); await page.waitForSelector('#aw-net', T);
    out.assets = await page.textContent('main');
    await nav('Money'); await page.waitForSelector('#mv-month', T);
    out.months = [];
    for (let i = 0; i < 68; i++) {
      out.months.push(await page.evaluate(() => ({ m: document.querySelector('#mv-month').textContent, i: document.querySelector('#mv-income').textContent, s: document.querySelector('#mv-spend').textContent, n: document.querySelector('#mv-net').textContent, r: document.querySelector('#mv-rate').textContent, c: Array.from(document.querySelectorAll('.catrow')).map((x) => x.textContent), cf: Array.from(document.querySelectorAll('table tbody tr')).slice(0, 6).map((x) => x.textContent) })));
      await page.click('#mv-prev');
    }
    out.fig = await page.evaluate(figFn, '2026-11-14');
    return out;
  }
  // The balance-history entry count is the very thing archiving shrinks, so it is not a figure. The "Some private items are hidden" notice is
  // compared as is (v1.2.0 audit, SEC-85): archived private figures still count, so it must stay exactly where it was.
  const same = (a, b, what) => { const strip = (v) => JSON.parse(JSON.stringify(v).replace(/Entries \(\d+\)/g, 'Entries (n)')); a = strip(a); b = strip(b); for (const k of Object.keys(a)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) { const x = JSON.stringify(a[k]), y = JSON.stringify(b[k]); let i = 0; while (i < x.length && x[i] === y[i]) i++; throw new Error(what + ': "' + k + '" changed at ' + i + ': ' + x.slice(Math.max(0, i - 60), i + 100) + ' -> ' + y.slice(Math.max(0, i - 60), i + 100)); } };
  const openPrivate = async () => { await page.click('#nav-private'); await page.waitForSelector('#priv-pass', T); await page.fill('#priv-pass', PRIVPASS); await page.click('#priv-open'); await page.waitForSelector('#priv-bar', T); };
  const closePrivate = async () => { await page.click('#priv-close'); await page.waitForSelector('#priv-bar', { state: 'detached', ...T }); };
  let before, shot, downloaded, sizeBefore;
  try {
    await step('seed the vault and unlock', async () => {
      await page.goto(ORIGIN + '/');
      await page.evaluate((env) => new Promise((res, rej) => {
        const r = indexedDB.open('lifeos', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite'); t.objectStore('kv').put(env, 'envelope'); t.oncomplete = () => { r.result.close(); res(); }; t.onerror = rej; };
        r.onerror = rej;
      }), SEED.env);
      await page.reload(); await page.waitForSelector('#pass', T);
      await unlock();
      await assertFields('dashboard'); await assertNoScroll('dashboard');
      // v1.2.0 audit: every screen and tile, not only the archive screens, carries spell check off on every field
      const tiles = await page.$$eval('.tile', (t) => t.map((x) => x.getAttribute('data-domain')));
      for (const id of tiles) { await nav('Overview'); await page.waitForSelector('.tile', T); await page.click('.tile[data-domain="' + id + '"]'); await page.waitForSelector('h1', T); await assertFields('tile ' + id); }
      for (const n of ['Money', 'Assets', 'Work', 'Health', 'Review', 'Memory', 'Settings', 'Business']) { await nav(n); await page.waitForSelector('h1', T); await assertFields(n); }
      await nav('Business'); for (const t of ['entries', 'invoices', 'mileage', 'payees', 'budgets', 'settings', 'export']) { await page.click('#bz-tab-' + t); await page.waitForSelector('#bz-tab-' + t + '[aria-pressed="true"]', T); await assertFields('business ' + t); }
      await page.click('#nav-private'); await page.waitForSelector('#priv-pass', T); await assertFields('private vault');
      await nav('Overview'); await page.waitForSelector('.tile', T);
    });
    await step('the proposal names the years and removes nothing', async () => {
      await page.waitForSelector('#archive-proposal', T);
      const t = await page.textContent('#archive-proposal');
      if (!/Archive 2021/.test(t) || !/Nothing is removed until you tap/.test(t)) throw new Error('proposal text: ' + t);
      if (!/2021, 2022, 2023/.test(t)) throw new Error('years: ' + t);
      const s = await stat();
      if (s.entries !== SEED.count - 1 - 0 && s.entries < 100) throw new Error('entries ' + s.entries);
      if (s.archives.length) throw new Error('archived without a tap');
      await assertNoScroll('proposal');
      await nav('Review'); await page.waitForSelector('#archive-proposal', T);
      await assertFields('review'); await assertNoScroll('review');
    });
    await step('connect Drive (mock), snapshot the figures before', async () => {
      await nav('Settings'); await page.waitForSelector('#archive-card', T);
      await assertFields('settings'); await assertNoScroll('settings');
      await page.fill('#sync-cid', CID); await page.click('#sync-save');
      await page.waitForFunction(() => /Client ID saved/.test(document.querySelector('#sync-status').textContent), null, T);
      await Promise.all([page.waitForNavigation({ url: ORIGIN + '/' }), page.click('#sync-connect')]);
      await page.waitForSelector('#pass', T); await unlock();
      await page.waitForSelector('.dialog:has-text("Sync with Google Drive?")', T); await page.keyboard.press('Escape');
      before = await screens();
      if (before.months.length < 60 || before.fig.monthViews['2021-05'] === undefined) throw new Error('before snapshot is thin');
      sizeBefore = await idb();
      if (!before.tiles.some((x) => /Locked|\$/.test(x))) throw new Error('tiles: ' + before.tiles.join('|'));
    });
    await step('archive 2021 with Drive and a download (private records included)', async () => {
      await openPrivate();
      await nav('Settings'); await page.waitForSelector('#archive-card', T);
      await page.selectOption('#arch-year', '2021');
      await page.click('#arch-run'); await page.waitForSelector('#arch-pass', T);
      await assertFields('archive dialog'); await assertNoScroll('archive dialog');
      if (!(await page.locator('#arch-drive').isChecked()) || !(await page.locator('#arch-dl').isChecked())) throw new Error('both copies should be offered by default when Drive is connected');
      await page.fill('#arch-pass', 'not the passphrase at all');
      await page.click('.dialog button.pri'); await page.waitForFunction(() => /not your main passphrase/.test(document.querySelector('.dialog').textContent), null, T);
      if ((await stat()).archives.length) throw new Error('archived with a wrong passphrase');
      await page.fill('#arch-pass', PASS);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('.dialog button.pri')]);
      downloaded = readFileSync(await dl.path(), 'utf8');
      await page.waitForSelector('#arch-confirm', T);
      const mid = await stat();
      if (mid.archives.length || mid.entries !== SEED.count) throw new Error('records left the vault before the copy was confirmed');
      await page.click('#arch-confirm');
      await page.waitForSelector('.notice:has-text("Archived 2021")', T);
      if (!/lifeos-archive-2021\.json/.test(dl.suggestedFilename())) throw new Error('file name ' + dl.suggestedFilename());
      const log = drive.log.join(' > ');
      if (!/list lifeos-archive-2021\.json > create lifeos-archive-2021\.json > list lifeos-archive-2021\.json > get /.test(log)) throw new Error('Drive was not written and read back: ' + log);
      if (drive.files['lifeos-archive-2021.json'].text !== downloaded) throw new Error('the Drive file and the download differ');
      if (downloaded.includes(PRIVMARK) || downloaded.includes('Food')) throw new Error('the archive file is not ciphertext');
      await closePrivate();
    });
    await step('the live vault shrank and every figure is unchanged', async () => {
      const s = await stat(), sizeAfter = await idb();
      if (s.entries >= SEED.count - 100 || !s.archives.includes(2021)) throw new Error('entries ' + s.entries + ' archives ' + s.archives);
      if (!(sizeAfter < sizeBefore)) throw new Error('the encrypted vault did not shrink: ' + sizeBefore + ' -> ' + sizeAfter);
      shot = await screens();
      same(before, shot, 'after archiving');
    });
    await step('lock, reload and unlock: the archive and the smaller vault persist', async () => {
      await page.click('.top .lockbtn'); await page.waitForSelector('#pass', T);
      await page.reload(); await page.waitForSelector('#pass', T); await unlock();
      await page.waitForFunction(() => globalThis.LifeOS.store.getState().archives.length === 1, null, T);
      const s = await stat();
      if (s.entries >= SEED.count - 100 || s.priv) throw new Error('state after reload: ' + JSON.stringify(s));
      await nav('Settings'); await page.waitForSelector('[data-year="2021"]', T);
      if (!/2021/.test(await page.textContent('#archive-card')) || !/Drive \(verified\) and download \(confirmed\)/.test(await page.textContent('#archive-card'))) throw new Error('archive list: ' + (await page.textContent('#archive-card')).slice(0, 300));
      await assertFields('settings archive list'); await assertNoScroll('settings archive list');
      same(shot, await screens(), 'after reload');
    });
    await step('open the archive read-only and search it; private records only while the vault is open', async () => {
      await nav('Settings'); await page.click('#arch-open-2021'); await page.waitForSelector('#arch-file', T);
      await page.selectOption('#arch-src', 'file');
      await page.setInputFiles('#arch-file', { name: 'lifeos-archive-2021.json', mimeType: 'application/json', buffer: Buffer.from(downloaded) });
      await page.fill('#arch-open-pass', PASS); await page.click('.dialog button.pri');
      await page.waitForSelector('#archive-screen', T);
      await assertFields('archive screen'); await assertNoScroll('archive screen');
      if (!(await page.textContent('#arch-readonly')).includes('Read-only')) throw new Error('not marked read-only');
      if (!/Open the private vault/.test(await page.textContent('#arch-privnote'))) throw new Error('private note while closed');
      if ((await page.textContent('#archive-screen')).includes(PRIVMARK)) throw new Error('private records shown while the vault is closed');
      await page.fill('#arch-q', 'Food ARCHIVELEAK'); await page.waitForSelector('#arch-results table[data-section="entries"]', T);
      const rows = await page.locator('#arch-results table[data-section="entries"] tbody tr').count();
      if (rows < 1) throw new Error('search found nothing');
      await page.fill('#arch-q', 'zzzznomatch'); await page.waitForSelector('#arch-empty', T);
      if ((await stat()).entries >= SEED.count - 100) throw new Error('opening an archive changed the vault');
      await page.click('#arch-close'); await page.waitForSelector('#archive-card', T);
      await openPrivate();
      await nav('Settings'); await page.click('#arch-open-2021'); await page.waitForSelector('#arch-file', T);
      await page.selectOption('#arch-src', 'file');
      await page.setInputFiles('#arch-file', { name: 'lifeos-archive-2021.json', mimeType: 'application/json', buffer: Buffer.from(downloaded) });
      await page.fill('#arch-open-pass', PASS); await page.click('.dialog button.pri'); await page.waitForSelector('#archive-screen', T);
      await page.fill('#arch-q', PRIVMARK); await page.waitForSelector('#arch-results table[data-section="entries"]', T);
      await page.fill('#arch-q', 'note'); await page.waitForSelector('#arch-results table[data-section="checkins"]', T);
      if (!(await page.evaluate(() => globalThis.LifeOS.archive.isOpenArchive()))) throw new Error('archive not open');
      await page.click('#arch-close');
      if (await page.evaluate(() => globalThis.LifeOS.archive.isOpenArchive())) throw new Error('archive still in memory after closing');
      await closePrivate();
    });
    await step('restore the year: nothing duplicates, private records go back to the private vault, the figures come back', async () => {
      await openPrivate();
      await nav('Settings'); await page.click('#arch-restore-2021'); await page.waitForSelector('#arch-file', T);
      await page.selectOption('#arch-src', 'file');
      await page.setInputFiles('#arch-file', { name: 'lifeos-archive-2021.json', mimeType: 'application/json', buffer: Buffer.from(downloaded) });
      await page.fill('#arch-open-pass', PASS);
      await assertFields('restore dialog');
      await page.click('.dialog button.pri'); await page.waitForFunction(() => /Tick the box/.test(document.querySelector('.dialog').textContent), null, T);
      await page.check('#arch-restore-ok'); await page.click('.dialog button.pri');
      await page.waitForSelector('.notice:has-text("Restored 2021")', T);
      const s = await stat();
      if (s.entries !== SEED.count || s.ids !== s.entries) throw new Error('after restore: ' + JSON.stringify(s) + ' seed ' + SEED.count);
      if (s.archives.length || s.priv) throw new Error('archive index or a private record in the public state: ' + JSON.stringify(s));
      const inner = await page.evaluate(() => globalThis.LifeOS.priv.view(globalThis.LifeOS.store.getState()).entries.some((e) => e.id === 'priv-exp'));
      if (!inner) throw new Error('the private record did not come back');
      await closePrivate();
      const back = await screens();
      same(before, back, 'after restoring');
      await nav('Settings'); await page.waitForSelector('#arch-none, #arch-year', T);
      await assertFields('settings after restore'); await assertNoScroll('settings after restore');
    });
    await step('lock and unlock once more; the restored vault persists', async () => {
      await page.click('.top .lockbtn'); await page.waitForSelector('#pass', T);
      await page.reload(); await page.waitForSelector('#pass', T); await unlock();
      const s = await stat();
      if (s.entries !== SEED.count || s.archives.length) throw new Error('state: ' + JSON.stringify(s));
    });
  } catch { /* recorded in problems */ }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
server.close();
if (problems.length) { console.log('SMOKE-ARCHIVE FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-ARCHIVE PASSED');
process.exit(0);
