// v1.4.0 smoke: "Phone first". 390x844 and desktop, in Chrome, plus WebKit and Firefox when LIFEOS_SMOKE_BROWSER=webkit|firefox.
// Bottom bar and More reach every area in two taps, back stays in the app and closes dialogs, lock then back reveals nothing, restore from a
// backup file on the lock screen (and its failures), the setup checklist, dashboard defaults, accessibility rules (names, labels, 44 px targets),
// and the service worker over a local https server: installed after one visit, loads offline, never caches an Access page, shows a reload prompt
// for a new version and never reloads by itself. Fails on console errors, CSP violations and horizontal scroll.
// Needs Playwright (`npm i --no-save playwright`), Chrome at /usr/bin/google-chrome and openssl. Run `node build.mjs` first.
import path from 'node:path';
import https from 'node:https';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { navTo } from './_nav.mjs';
import { buildAdversarial, ADV_MARK } from './_adversarial.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '..', 'dist');
let pw;
try { pw = await import('playwright'); } catch { console.log('SKIPPED: playwright not available (npm i --no-save playwright)'); process.exit(0); }
const which = process.env.LIFEOS_SMOKE_BROWSER || 'chromium';
let browser;
// The local https server uses a self-signed certificate; Chrome also needs the flag for the service worker script fetch.
const launchers = which === 'chromium' ? [{ executablePath: '/usr/bin/google-chrome', args: ['--ignore-certificate-errors'] }, { channel: 'chrome', args: ['--ignore-certificate-errors'] }, { args: ['--ignore-certificate-errors'] }] : [{}];
for (const o of launchers) { try { browser = await pw[which].launch(o); break; } catch { /* try next */ } }
if (!browser) { console.log('SKIPPED: ' + which + ' unavailable (not installed); this is not a pass'); process.exit(0); }

const PASS = 'correct horse battery staple', BACKUP = 'a backup passphrase 4242', MARK = 'PHONEMARK-k4m9', PRIVMARK = 'PRIV "cache" mark 51';
const T = { timeout: 15000 };
const problems = [];
const version = JSON.parse(readFileSync(path.resolve(here, '..', 'package.json'), 'utf8')).version;
const { SW_CSP } = await import('../build.mjs');
const csp = /content="([^"]+)"/.exec(readFileSync(path.join(dist, 'lifeos.html'), 'utf8').match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)[0])[1] + "; frame-ancestors 'none'";

// ---- a local https server shaped like the live copy: /dist/lifeos is the page, /dist/lifeos.html redirects to it, sw.js has its own policy ----
const tmp = mkdtempSync(path.join(tmpdir(), 'lifeos-phone-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
const srv = { mode: 'normal', swVersion: version, hits: [] };
const server = https.createServer({ key: readFileSync(path.join(tmp, 'k.pem')), cert: readFileSync(path.join(tmp, 'c.pem')) }, (req, res) => {
  const u = req.url.split('?')[0]; srv.hits.push(u);
  const send = (code, type, body, extra) => { res.writeHead(code, Object.assign({ 'Content-Type': type, 'Content-Security-Policy': csp, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }, extra || {})); res.end(body); };
  if (u === '/dist/lifeos') {
    if (srv.mode === 'access') return send(200, 'text/html; charset=utf-8', '<html><title>Sign in</title><body>Cloudflare Access sign in</body></html>');
    return send(200, 'text/html; charset=utf-8', readFileSync(path.join(dist, 'lifeos.html')));
  }
  if (u === '/dist/lifeos.html') return send(302, 'text/plain', '', { Location: '/dist/lifeos' });
  if (u === '/dist/sw.js') return send(200, 'text/javascript; charset=utf-8', readFileSync(path.join(dist, 'sw.js'), 'utf8').replace("var VERSION = '" + version + "';", "var VERSION = '" + srv.swVersion + "';"), { 'Content-Security-Policy': SW_CSP });
  if (u === '/dist/manifest.webmanifest') return send(200, 'application/manifest+json', readFileSync(path.join(dist, 'manifest.webmanifest')));
  if (/^\/dist\/icons\/[\w-]+\.png$/.test(u)) { try { return send(200, 'image/png', readFileSync(path.join(dist, u.slice(6)))); } catch { /* fall through */ } }
  return send(404, 'text/plain', 'not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = 'https://localhost:' + server.address().port.toString();
const SITE = ORIGIN.replace('localhost', '127.0.0.1') + '/dist/lifeos';
let backupFile = '';

// ---- axe-like rules run in the page: accessible names, labels, visible targets ----
const a11y = (scope) => scope.evaluate(() => {
  const bad = [], vis = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[inert]'); };
  const nameOf = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    return (el.getAttribute('aria-label') || '').trim() || (lb && lb.split(/\s+/).map((i) => (document.getElementById(i) || {}).textContent || '').join(' ').trim()) ||
      (el.labels ? [...el.labels].map((l) => l.textContent).join(' ').trim() : '') || (el.tagName === 'INPUT' && /button|submit/.test(el.type) ? el.value : el.textContent.trim()) || (el.getAttribute('title') || '').trim();
  };
  for (const el of document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox]')) { if (vis(el) && !nameOf(el)) bad.push('no accessible name: <' + el.tagName.toLowerCase() + '> #' + el.id + ' .' + el.className); }
  for (const d of document.querySelectorAll('[role=dialog]')) { if (!(d.getAttribute('aria-label') || d.getAttribute('aria-labelledby'))) bad.push('dialog without a name'); if (d.getAttribute('aria-modal') !== 'true') bad.push('dialog is not modal'); }
  for (const s of document.querySelectorAll('svg')) { if (vis(s) && !s.closest('[aria-hidden=true]') && !s.getAttribute('role') && !s.getAttribute('aria-label')) bad.push('svg without a text alternative: .' + (s.getAttribute('class') || '')); }
  for (const el of document.querySelectorAll('.nav button, #more-list button')) { const r = el.getBoundingClientRect(); if (vis(el) && (r.width < 44 || r.height < 44)) bad.push('target under 44 px: ' + el.textContent + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
  return bad;
});
const noHScroll = async (page, where) => { const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })); if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')'); };

async function makePage(ctx, label) {
  const page = await ctx.newPage(); page.setDefaultTimeout(15000);
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  return page;
}
const step = (label) => async (name, fn) => { if (process.env.SMOKE_VERBOSE) console.log(label, 'step:', name); try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); } };
const histState = (page) => page.evaluate(() => history.state);
const unlockWith = async (page) => { await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.nav', T); };
const createVault = async (page) => { await page.fill('#pass', PASS); await page.fill('#pass2', PASS); await page.click('button:has-text("Create vault")'); await page.waitForSelector('.nav', T); await page.waitForSelector('#setup-card', T); };

async function run(label, viewport) {
  const mobile = !!viewport;
  const ctx = await browser.newContext(Object.assign({ ignoreHTTPSErrors: true, acceptDownloads: true }, mobile ? { viewport, isMobile: which !== 'firefox', hasTouch: which !== 'firefox' } : { viewport: { width: 1280, height: 900 } }));
  const s = step(label), page = await makePage(ctx, label);
  try {
    await page.goto(SITE);
    await s('lock screen offers the three paths and nothing else is stored', async () => {
      await page.waitForSelector('#pass2', T);
      for (const id of ['#pass', '#path-restore', '#path-drive']) await page.waitForSelector(id, T);
      if (await page.locator('.nav').count()) throw new Error('navigation shown on the lock screen');
      if ((await histState(page)) !== 'lock') throw new Error('history state on load is ' + (await histState(page)));
      await noHScroll(page, 'lock');
      const bad = await a11y(page); if (bad.length) throw new Error(bad.join('; '));
    });
    await s('restore and Drive paths open and go back without leaving a trace', async () => {
      await page.click('#path-restore'); await page.waitForSelector('#rs-file', T); const b1 = await a11y(page); if (b1.length) throw new Error(b1.join('; '));
      await page.click('#path-back'); await page.click('#path-drive'); await page.waitForSelector('#dv-cid', T); await page.click('#path-back'); await page.waitForSelector('#pass2', T);
      if (await page.evaluate(() => globalThis.LifeOS.store.exists())) throw new Error('a vault exists');
    });
    await s('create: the setup checklist shows, nothing ticked; the real state ticks it', async () => {
      await createVault(page);
      if ((await page.textContent('#setup-count')).trim() !== '0 of 6 done') throw new Error('count ' + (await page.textContent('#setup-count')));
      if (await page.locator('.setupitem[data-done="true"]').count()) throw new Error('an item is ticked on a new vault');
      await page.evaluate((M) => globalThis.LifeOS.store.commit((x) => { x.accounts.push({ id: 'acc-ph', name: M + ' account', kind: 'cash', liability: false, archived: false }); x.settings.currency = 'EUR'; }), MARK);
      await navTo(page, 'Money'); await navTo(page, 'Home'); await page.waitForSelector('#setup-card', T);
      const done = await page.locator('.setupitem[data-done="true"]').evaluateAll((l) => l.map((e) => e.getAttribute('data-item')));
      if (done.sort().join() !== 'accounts,targets') throw new Error('ticked: ' + done.join());
      await page.click('.setupitem[data-item="storage"] button'); await page.waitForSelector('h1', T);
      if (!/settings/.test(String(await histState(page)))) throw new Error('Open did not go to Settings: ' + (await histState(page)));
      await navTo(page, 'Home');
    });
    await s('dashboard defaults: ' + (mobile ? 'empty modules are one line and business modules stay hidden' : 'wide screens keep every module'), async () => {
      await page.waitForSelector('#dash-grid', T);
      const has = (m) => page.locator('.mod[data-mod="' + m + '"]').count();
      if (mobile) {
        if ((await has('tax-next')) || (await has('inv-open'))) throw new Error('business modules shown before a tax profile');
        if (!(await page.locator('.tile.tile-empty[data-domain="goals"]').count())) throw new Error('goals is not a one-line empty state');
        if (await page.locator('.tile-empty[data-domain="assets"]').count()) throw new Error('assets has an account and is still collapsed');
        await page.evaluate(() => globalThis.LifeOS.store.commit((x) => { x.taxYears['2026'] = globalThis.LifeOS.tax.defaultProfile ? globalThis.LifeOS.tax.defaultProfile(2026) : { year: 2026 }; }).catch(() => {}));
      } else if (!(await has('tax-next'))) throw new Error('wide dashboard lacks the tax module');
      await noHScroll(page, 'dashboard');
    });
    if (mobile) {
      await s('bottom bar: five items, labels at least 14 px, targets at least 44 px, current area marked', async () => {
        const info = await page.evaluate(() => [...document.querySelectorAll('.nav.bar button')].map((b) => ({ t: b.textContent, fs: parseFloat(getComputedStyle(b).fontSize), w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height, cur: b.getAttribute('aria-current') })));
        if (info.map((x) => x.t).join() !== 'Home,Money,Work,Health,More') throw new Error('bar: ' + info.map((x) => x.t));
        for (const x of info) if (x.fs < 14 || x.w < 44 || x.h < 44) throw new Error(x.t + ' ' + x.fs + 'px ' + Math.round(x.w) + 'x' + Math.round(x.h));
        if (info[0].cur !== 'page') throw new Error('Home is not marked current');
        await page.click('#nav-more'); await page.waitForSelector('#more-list', T);
        const bad = await a11y(page); if (bad.length) throw new Error(bad.join('; '));
        const n = await page.locator('#more-list button').count(); if (n !== 15) throw new Error('More lists ' + n + ' areas');
        await page.keyboard.press('Escape'); await page.waitForSelector('#more-list', { state: 'detached', timeout: 5000 });
      });
      // v1.4.0 audit: the checker itself must fail on a missing name, a missing label and a target under 44 px, or its passes prove nothing
      await s('the accessibility checker fails on a nameless button, an unlabelled input and a small bar target', async () => {
        await page.evaluate(() => {
          const add = (parent, tag, attrs) => { const e = document.createElement(tag); Object.assign(e, attrs); e.setAttribute('data-a11y-probe', '1'); parent.appendChild(e); return e; };
          add(document.querySelector('main'), 'button', { type: 'button' });
          add(document.querySelector('main'), 'input', { type: 'text' });
          const tiny = add(document.querySelector('.nav'), 'button', { type: 'button', textContent: 'x' }); tiny.style.cssText = 'min-width:0;min-height:0;width:20px;height:20px;padding:0;flex:none';
        });
        const bad = await a11y(page);
        await page.evaluate(() => document.querySelectorAll('[data-a11y-probe]').forEach((e) => e.remove()));
        const want = [/no accessible name: <button>/, /no accessible name: <input>/, /target under 44 px: x 20x20/];
        for (const re of want) if (!bad.some((x) => re.test(x))) throw new Error('the checker missed ' + re + ': ' + bad.join('; '));
        if ((await a11y(page)).length) throw new Error('probes left behind');
      });
      await s('every area is two taps from anywhere, and the history entry holds only a view name', async () => {
        const KEYS = await page.evaluate(() => globalThis.LifeOS.nav.MORE.map((m) => [m.label, m.key]));
        for (const start of ['Home', 'Settings']) {
          for (const [label, key] of KEYS) {
            await navTo(page, start); await page.click('#nav-more'); await page.click('#more-list button[data-key="' + key + '"]');
            await page.waitForSelector('h1', T);
            const st = await histState(page); if (st !== key) throw new Error(label + ' from ' + start + ': history state ' + st + ' (want ' + key + ')');
            if (await page.locator('#more-list').count()) throw new Error('the sheet stayed open');
            const cur = await page.getAttribute('#nav-more', 'aria-current'); if (cur !== 'page') throw new Error(label + ': More is not marked current');
            if (!(await page.textContent('h1')).trim()) throw new Error(label + ': no heading');
          }
        }
        if (await page.evaluate(() => location.hash + location.search)) throw new Error('the address carries more than the page');
      });
      await s('back stays in the app, steps through views and closes dialogs', async () => {
        await navTo(page, 'Home'); await navTo(page, 'Money'); await navTo(page, 'Work'); await navTo(page, 'Review');
        await page.goBack(); if ((await histState(page)) !== 'v:work') throw new Error('back from Review: ' + (await histState(page)));
        await page.goBack(); if ((await histState(page)) !== 'v:money') throw new Error('back from Work: ' + (await histState(page)));
        if (!(await page.locator('.nav').count())) throw new Error('the app was left');
        await navTo(page, 'Home'); await page.click('#quick-add'); await page.waitForSelector('[role=dialog]', T);
        if ((await histState(page)) !== 'dialog') throw new Error('dialog has no entry');
        const bad = await a11y(page); if (bad.length) throw new Error(bad.join('; '));
        await page.goBack(); await page.waitForSelector('[role=dialog]', { state: 'detached', timeout: 5000 });
        if ((await histState(page)) !== 'dashboard') throw new Error('after closing: ' + (await histState(page)));
        await page.click('#quick-add'); await page.waitForSelector('[role=dialog]', T); await page.click('[role=dialog] button:has-text("Cancel")');
        await page.waitForSelector('[role=dialog]', { state: 'detached', timeout: 5000 }); await page.waitForTimeout(100);
        if ((await histState(page)) !== 'dashboard') throw new Error('Cancel left a dialog entry: ' + (await histState(page)));
        await page.goBack().catch(() => {}); // from the dashboard back behaves as the browser does
      });
      await s('the whole dashboard passes the name and label rules', async () => {
        await page.goto(SITE); await unlockWith(page); await page.waitForSelector('#dash-grid', T);
        const bad = await a11y(page); if (bad.length) throw new Error(bad.join('; '));
        await navTo(page, 'Settings'); await page.waitForSelector('#app-version', T); const b2 = await a11y(page); if (b2.length) throw new Error('settings: ' + b2.join('; '));
      });
    }
    await s('export a backup for the restore steps', async () => {
      if (!mobile) return;
      backupFile = await page.evaluate(([p]) => globalThis.LifeOS.vault.exportBackup(p, globalThis.LifeOS.store.getState()), [BACKUP]);
      writeFileSync(path.join(tmp, 'backup.json'), backupFile);
    });
    await s('lock, then back and forward reveal nothing; a reload returns to the lock screen', async () => {
      await navTo(page, 'Money'); await navTo(page, 'Home');
      await page.click('.lockbtn'); await page.waitForSelector('#pass', T);
      if ((await histState(page)) !== 'lock') throw new Error('state after lock: ' + (await histState(page)));
      for (const dir of ['goBack', 'goForward', 'goBack']) {
        await page[dir]().catch(() => {}); await page.waitForTimeout(150);
        const url = page.url();
        if (url.startsWith('https://127.0.0.1') && (await page.locator('.nav, #dash-grid, .tile').count())) throw new Error('an area was reachable after lock via ' + dir);
        const body = await page.textContent('body').catch(() => ''); if (body.includes(MARK)) throw new Error('data visible after lock via ' + dir);
      }
      await page.goto(SITE); await page.waitForSelector('#pass', T);
      await unlockWith(page); await page.reload(); await page.waitForSelector('#pass', T);
      if (await page.locator('.nav').count()) throw new Error('a reload did not return to the lock screen');
    });
    await s('restore from a backup file on the lock screen', async () => {
      if (!backupFile) throw new Error('no backup file was made');
      const ctx2 = await browser.newContext(Object.assign({ ignoreHTTPSErrors: true }, mobile ? { viewport, isMobile: which !== 'firefox', hasTouch: which !== 'firefox' } : { viewport: { width: 1280, height: 900 } }));
      const p2 = await makePage(ctx2, label + ' restore');
      try {
        await p2.goto(SITE); await p2.waitForSelector('#path-restore', T); await p2.click('#path-restore');
        // failures first: nothing is stored and the lock screen stays
        await p2.setInputFiles('#rs-file', path.join(tmp, 'backup.json')); await p2.fill('#rs-pass', 'not the right passphrase'); await p2.click('#rs-check');
        await p2.waitForSelector('.notice.err', T); if (await p2.locator('#rs-ok').count()) throw new Error('a wrong passphrase was accepted');
        writeFileSync(path.join(tmp, 'bad.json'), backupFile.replace(/"ct":"(.{12})/, '"ct":"AAAAAAAAAAAA'));
        await p2.setInputFiles('#rs-file', path.join(tmp, 'bad.json')); await p2.fill('#rs-pass', BACKUP); await p2.click('#rs-check');
        await p2.waitForSelector('.notice.err', T); if (await p2.locator('#rs-ok').count()) throw new Error('a damaged file was accepted');
        writeFileSync(path.join(tmp, 'junk.json'), '{"hello":1}'); await p2.setInputFiles('#rs-file', path.join(tmp, 'junk.json')); await p2.fill('#rs-pass', BACKUP); await p2.click('#rs-check');
        await p2.waitForSelector('.notice.err', T);
        if (await p2.evaluate(() => globalThis.LifeOS.store.exists())) throw new Error('a failed restore left a vault');
        // success: verify counts, then it becomes the live vault
        await p2.setInputFiles('#rs-file', path.join(tmp, 'backup.json')); await p2.fill('#rs-pass', BACKUP); await p2.click('#rs-check'); await p2.waitForSelector('#rs-ok', T);
        if (await p2.evaluate(() => globalThis.LifeOS.store.exists())) throw new Error('verifying wrote a vault');
        if (!/Accounts: 1/.test(await p2.textContent('#rs-rows'))) throw new Error('counts: ' + (await p2.textContent('#rs-rows')));
        if (await p2.inputValue('#rs-pass')) throw new Error('the passphrase stayed in its field');
        await p2.click('#rs-use'); await p2.waitForSelector('.nav', T); await p2.waitForSelector('#dash-grid', T);
        const st = await p2.evaluate(() => { const s = globalThis.LifeOS.store.getState(); return [s.accounts.length, s.settings.currency, s.ops.lastBackupAt]; });
        if (st[0] !== 1 || st[1] !== 'EUR') throw new Error('restored state ' + JSON.stringify(st));
        if ((await histState(p2)) !== 'dashboard') throw new Error('history after restore ' + (await histState(p2)));
        await noHScroll(p2, 'restored dashboard');
        await p2.reload(); await p2.waitForSelector('#pass', T); await p2.fill('#pass', BACKUP); await p2.click('button:has-text("Unlock")'); await p2.waitForSelector('.nav', T);
        if (await p2.locator('#path-restore').count()) throw new Error('restore offered beside an existing vault');
      } finally { await ctx2.close(); }
    });
  } catch (e) { problems.push(label + ' fatal: ' + e.message); }
  await ctx.close();
}

// ---- the service worker: one visit, then offline; an Access page is never kept; a new version waits for the tap ----
async function pwa() {
  const label = 'pwa', s = step(label);
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
  const page = await makePage(ctx, label);
  try {
    if (which !== 'chromium') { await s('service worker steps run in Chrome only here', async () => {}); return; }
    await page.goto(SITE); await page.waitForSelector('#pass2', T);
    await s('registers on https, links the manifest, caches the shell', async () => {
      await page.evaluate(() => Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('the service worker did not register')), 12000))]));
      await page.waitForFunction(() => navigator.serviceWorker.controller, null, T);
      if (!(await page.locator('link[rel="manifest"]').count())) throw new Error('no manifest link');
      await page.waitForFunction((v) => caches.has('lifeos-shell-' + v), version, T);
      const keys = await page.evaluate((v) => caches.open('lifeos-shell-' + v).then((c) => c.keys()).then((k) => k.map((r) => new URL(r.url).pathname)), version);
      const want = ['/dist/lifeos', '/dist/manifest.webmanifest', '/dist/icons/icon-192.png', '/dist/icons/icon-512.png', '/dist/icons/icon-maskable-512.png'];
      // SEC-98: the manifest is fetched with credentials (Cloudflare Access); the iPhone icon is a data: link (no policy error, checked by the console listener)
      if ((await page.getAttribute('link[rel="manifest"]', 'crossorigin')) !== 'use-credentials') throw new Error('the manifest link does not ask for credentials');
      if (!/^data:image\/png;base64,/.test(await page.getAttribute('link[rel="apple-touch-icon"]', 'href'))) throw new Error('no data: apple-touch-icon link');
      if (keys.sort().join() !== want.sort().join()) throw new Error('cached: ' + keys.join());
      const m = await page.evaluate(() => fetch('/dist/manifest.webmanifest').then((r) => r.json())); if (m.name !== 'LifeOS') throw new Error('manifest');
      if (await page.evaluate(() => caches.keys().then((k) => k.length)) !== 1) throw new Error('more than one cache');
    });
    await s('after one visit the app loads offline and unlocks', async () => {
      await ctx.setOffline(true); await page.reload(); await page.waitForSelector('#pass2', T);
      await createVault(page); await ctx.setOffline(false);
    });
    await s('online reload goes through the worker and returns the page', async () => {
      await page.reload(); await page.waitForSelector('#pass', T); await unlockWith(page);
    });
    await s('no user data reaches Cache Storage: markers in every domain and the private vault, every area opened, reloaded', async () => {
      const SRC = '(' + buildAdversarial.toString() + ')(globalThis.LifeOS)';
      const n = await page.evaluate('(async () => { const r = ' + SRC + '; await globalThis.LifeOS.store.replaceState(r.state); return r.count; })()');
      if (n < 60) throw new Error('only ' + n + ' markers');
      await page.evaluate(async (M) => {
        const L = globalThis.LifeOS;
        await L.store.commit((x) => { x.entries.push(L.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2026-11-10', title: M + ' title', value: 3, category: 'Dining', notes: M + ' note' })); });
        await L.priv.setUp('a private "cache" passphrase 7');
        const e = L.store.getState().entries.find((x) => x.title === M + ' title'); await L.priv.moveIn('entries', e.id);
      }, PRIVMARK);
      const keys = await page.evaluate(() => globalThis.LifeOS.nav.all());
      for (const k of keys) { await page.evaluate((key) => { const b = document.querySelector('.nav [data-key="' + key + '"]'); if (b) b.click(); }, k); if (!(await page.locator('.nav [data-key="' + k + '"]').count())) { await page.click('#nav-more'); await page.click('#more-list button[data-key="' + k + '"]'); } await page.waitForSelector('h1', T); }
      await navTo(page, 'Money'); if (!(await page.textContent('main')).includes(PRIVMARK)) throw new Error('the private marker is not shown, so the check would prove less');
      await navTo(page, 'Home'); if (!(await page.textContent('main')).includes(ADV_MARK)) throw new Error('markers not shown on the dashboard');
      await page.reload(); await page.waitForSelector('#pass', T); await unlockWith(page);
      const dump = await page.evaluate(async () => {
        const out = [];
        for (const name of await caches.keys()) {
          const c = await caches.open(name);
          for (const req of await c.keys()) {
            const r = await c.match(req), b = new Uint8Array(await r.arrayBuffer()); let t = '';
            for (let i = 0; i < b.length; i++) t += String.fromCharCode(b[i]);
            out.push({ name, url: req.url, headers: [...r.headers.entries()], body: t });
          }
        }
        return out;
      });
      const text = JSON.stringify(dump);
      if (!dump.length || !text.includes('name=\\"lifeos-shell\\"')) throw new Error('nothing cached, so the check would prove nothing');
      for (const m of [ADV_MARK, PRIVMARK, PASS]) if (text.includes(m)) throw new Error('Cache Storage holds user data: ' + m);
      const paths = dump.map((d) => new URL(d.url).pathname).sort().join();
      if (paths !== ['/dist/lifeos', '/dist/manifest.webmanifest', '/dist/icons/icon-192.png', '/dist/icons/icon-512.png', '/dist/icons/icon-maskable-512.png'].sort().join()) throw new Error('cache keys: ' + paths);
    });
    await s('an Access sign-in page is shown but never cached, and the cached shell survives', async () => {
      srv.mode = 'access'; await page.evaluate(() => globalThis.LifeOS.store.lock && 0);
      const r = await page.evaluate(() => fetch('/dist/lifeos', { cache: 'no-store' }).then((x) => x.text())); if (!/Cloudflare Access/.test(r)) throw new Error('the Access page was not passed through');
      const cached = await page.evaluate((v) => caches.open('lifeos-shell-' + v).then((c) => c.match('/dist/lifeos')).then((x) => x.text()), version);
      // the stand-in Access page is told apart by its title (the app's own source may mention Cloudflare Access in comments)
      if (/<title>Sign in<\/title>/.test(cached) || !cached.includes('name="lifeos-shell" content="' + version + '"')) throw new Error('the cache holds a page that is not the app');
      srv.mode = 'normal';
    });
    await s('a new version shows a prompt, never reloads by itself, and reloads after the tap', async () => {
      await page.evaluate(() => { window.__still = 'same page'; });
      // SEC-99: something typed and not saved survives the prompt (the screen is not redrawn)
      await navTo(page, 'Settings'); await page.waitForSelector('#t-cur', T); await page.fill('#t-cur', 'JPY');
      await page.evaluate(() => { document.querySelector('#t-cur').__probe = 'same element'; });
      srv.swVersion = version + '1';
      await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
      await page.waitForSelector('#update-banner', T);
      if ((await page.inputValue('#t-cur')) !== 'JPY' || (await page.evaluate(() => document.querySelector('#t-cur').__probe)) !== 'same element') throw new Error('the update prompt redrew the screen and dropped typed text');
      await page.waitForTimeout(1500);
      if ((await page.evaluate(() => window.__still)) !== 'same page') throw new Error('the page reloaded by itself');
      if (!(await page.locator('.nav').count())) throw new Error('the app locked by itself');
      await page.click('#update-reload'); await page.waitForSelector('[role=dialog]', T); await page.click('[role=dialog] button:has-text("Reload")');
      await page.waitForFunction(() => window.__still === undefined, null, T); await page.waitForSelector('#pass', T);
      srv.swVersion = version;
    });
  } catch (e) { problems.push(label + ' fatal: ' + e.message); }
  await ctx.close();
}

const only = process.env.LIFEOS_PHONE_ONLY;
if (only !== 'pwa') { await run('mobile', { width: 390, height: 844 }); await run('desktop', null); }
await pwa();
// the file:// copy keeps working without a service worker or manifest link
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await makePage(ctx, 'file');
  try {
    await page.goto(pathToFileURL(path.join(dist, 'lifeos.html')).href); await page.waitForSelector('#pass2', T);
    if (await page.locator('link[rel="manifest"]').count()) problems.push('file: a manifest link was added');
    if (await page.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller))) problems.push('file: a service worker controls the page');
  } catch (e) { problems.push('file fatal: ' + e.message); }
  await ctx.close();
}
await browser.close(); server.close();
if (problems.length) { console.log('SMOKE FAILED (' + which + ')\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE PASSED (' + which + ')');
