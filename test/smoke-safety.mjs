// v1.3.0 smoke: "Safe to live in". Desktop and 390x844. Storage status shown, backup banner and snooze, export a backup, verify it (good file, wrong
// passphrase, tampered file; nothing written), the reminder with a short interval, Copy diagnostics (clipboard text holds codes only, no data), the
// optional sync notice on lock, lock and unlock. Fails on console errors, CSP violations and horizontal scroll. Run `node build.mjs` first.
// Needs Playwright (`npm i --no-save playwright`) and Chrome at /usr/bin/google-chrome.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '..', 'dist', 'lifeos.html');
let pw;
try { pw = await import('playwright'); } catch { console.log('SKIPPED: playwright not available (npm i --no-save playwright)'); process.exit(0); }
let browser;
for (const o of [{ executablePath: '/usr/bin/google-chrome' }, { channel: 'chrome' }, {}]) {
  try { browser = await pw.chromium.launch(o); break; } catch { /* try next */ }
}
if (!browser) { console.log('SKIPPED: chromium unavailable'); process.exit(0); }

const PASS = 'correct horse battery staple', BACKUP = 'a backup passphrase 4242';
const MARK = 'SAFETYMARK-q7x3';
const T = { timeout: 15000 };
const problems = [];

async function run(label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true, acceptDownloads: true } : { viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  page.on('request', (r) => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) requests.push(r.url()); });
  await page.addInitScript(() => { try { const w = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = (t) => { window.__copied = String(t); return w(t).catch(() => {}); }; } catch (e) { /* no clipboard */ } });
  async function step(name, fn) { if (process.env.SMOKE_VERBOSE) console.log(label, 'step:', name); try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
  const nav = (name) => page.click('.nav button:has-text("' + name + '")');
  const text = (sel) => page.textContent(sel).then((t) => t.trim());
  const noHScroll = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
  };
  const envelope = () => page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('lifeos');
    r.onsuccess = () => { const db = r.result, tx = db.transaction(db.objectStoreNames, 'readonly'), out = [];
      for (const n of db.objectStoreNames) { const c = tx.objectStore(n).openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { out.push(String(cur.key) + JSON.stringify(cur.value)); cur.continue(); } }; }
      tx.oncomplete = () => { db.close(); res(out.join('|')); }; tx.onerror = rej; };
    r.onerror = rej;
  }));
  const ops = () => page.evaluate(() => JSON.parse(JSON.stringify(globalThis.LifeOS.store.getState().ops)));
  let downloads = 0, backupPath = '';
  page.on('download', () => { downloads++; });
  try {
    await page.clock.install({ time: new Date(2026, 10, 18, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('create the vault; the dashboard shows the backup card and the banner offers a backup (never automatic)', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS); await page.click('button:has-text("Create vault")');
      await page.waitForSelector('.tile', T);
      await page.evaluate((M) => globalThis.LifeOS.store.commit((x) => {
        x.entries.push(globalThis.LifeOS.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2026-11-17', title: M + ' lunch', value: 12.5, category: 'Dining', notes: M }));
        x.accounts.push({ id: 'acc-safety', name: M + ' account', kind: 'cash', liability: false, archived: false });
        x.settings.business.name = M + ' LLC';
      }), MARK);
      await nav('Settings'); await nav('Home'); await page.waitForSelector('#safety-card', T);
      if (!/Last backup: none yet/.test(await text('#safety-backup')) || !/Last sync: none yet/.test(await text('#safety-sync'))) throw new Error('dashboard dates');
      await page.waitForFunction(() => !/checking/.test(document.querySelector('#safety-storage').textContent), null, T);
      if (!/^Storage: (kept by the browser|may be cleared by the browser)$/.test(await text('#safety-storage'))) throw new Error('storage line: ' + await text('#safety-storage'));
      await page.waitForSelector('#backup-banner', T);
      if (!/no backup or sync yet/.test(await text('#backup-banner'))) throw new Error('banner: ' + await text('#backup-banner'));
      await page.waitForTimeout(300);
      if (downloads !== 0) throw new Error('a download started without a tap');
      await noHScroll('dashboard');
    });
    await step('Settings shows the storage status and usage; the result of the persist request is recorded', async () => {
      await nav('Settings'); await page.waitForSelector('#storage-status', T);
      await page.waitForFunction(() => !/checking/.test(document.querySelector('#storage-status').textContent) && document.querySelector('#storage-estimate').textContent.length > 0, null, T);
      const st = await text('#storage-status');
      if (!/^Storage: (kept by the browser|may be cleared by the browser)$/.test(st)) throw new Error('status: ' + st);
      if (/cleared/.test(st) && !/bookmark/.test(await text('#storage-help'))) throw new Error('no help text with the warning');
      if (!/Used on this device|not available/.test(await text('#storage-estimate'))) throw new Error('estimate: ' + await text('#storage-estimate'));
      const o = await ops();
      if (!['granted', 'denied', 'unavailable', 'error'].includes(o.persist.result)) throw new Error('persist result not recorded: ' + JSON.stringify(o.persist));
      await noHScroll('settings');
    });
    await step('export a backup from the banner: nothing happens until the dialog is confirmed; the date is stamped and the banner clears', async () => {
      await nav('Home'); await page.waitForSelector('#banner-export', T);
      await page.click('#banner-export'); await page.waitForSelector('#rem-pass', T);
      await page.fill('#rem-pass', BACKUP); await page.fill('#rem-pass2', BACKUP + 'x');
      await page.click('.dialog button.pri');
      await page.waitForFunction(() => /do not match/.test(document.querySelector('.dialog').textContent), null, T);
      if (downloads !== 0) throw new Error('exported with mismatched passphrases');
      await page.fill('#rem-pass2', BACKUP);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('.dialog button.pri')]);
      backupPath = await dl.path();
      await page.waitForSelector('.notice.ok:has-text("Backup downloaded.")', T);
      await page.waitForSelector('#backup-banner', { state: 'detached', ...T });
      if (!/Last backup: 2026-11-18 \(today\)/.test(await text('#safety-backup'))) throw new Error('date after export: ' + await text('#safety-backup'));
      const o = await ops(); if (o.lastBackupAt !== '2026-11-18' || !(o.backupRev >= 1) || o.safeRev !== o.backupRev) throw new Error('ops after export ' + JSON.stringify(o));
      const raw = readFileSync(backupPath, 'utf8');
      if (raw.includes(MARK) || !/"ct"/.test(raw)) throw new Error('backup file is not ciphertext');
      await noHScroll('dashboard after export');
    });
    await step('verify the backup: schema, revision, date and counts shown; wrong passphrase and a tampered file are refused; nothing is written', async () => {
      await nav('Settings'); await page.waitForSelector('#vf-file', T);
      const before = await envelope(), rev0 = await page.evaluate(() => globalThis.LifeOS.store.getMeta().rev);
      await page.setInputFiles('#vf-file', backupPath); await page.fill('#vf-pass', BACKUP); await page.click('#verify-btn');
      await page.waitForSelector('#verify-ok', T);
      const t = await text('#verify-out');
      if (!/Nothing was written/.test(t) || !/Schema: 15/.test(t) || !/Made on: 2026-11-18/.test(t) || !/Revision: \d+\./.test(t) || !/Private vault in the file: no/.test(t)) throw new Error('verify result: ' + t.slice(0, 300));
      if (!/Entries: 1 in the file, 1 in this vault \(same\)/.test(t)) throw new Error('counts: ' + t.slice(0, 400));
      if ((await text('#verify-out')).includes(MARK)) throw new Error('verify output shows record text');
      if (await page.inputValue('#vf-pass') !== '') throw new Error('passphrase left in the field');
      await noHScroll('verify result');
      // wrong passphrase
      await page.setInputFiles('#vf-file', backupPath); await page.fill('#vf-pass', 'not the passphrase 99'); await page.click('#verify-btn');
      await page.waitForSelector('#verify-fail', T);
      if (!/did not work/.test(await text('#verify-fail'))) throw new Error('wrong passphrase message');
      // tampered file
      const env = JSON.parse(readFileSync(backupPath, 'utf8')); env.ct = env.ct.slice(0, 20) + (env.ct[20] === 'A' ? 'B' : 'A') + env.ct.slice(21);
      await page.setInputFiles('#vf-file', { name: 'lifeos-backup-tampered.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(env)) });
      await page.fill('#vf-pass', BACKUP); await page.click('#verify-btn');
      await page.waitForFunction(() => /changed or damaged/.test((document.querySelector('#verify-fail') || {}).textContent || ''), null, T);
      // a file from a newer schema: re-seal this backup's plaintext with schema 16 in the page, then verify it
      const newer = await page.evaluate(async (pass) => {
        const L = globalThis.LifeOS, st = JSON.parse(JSON.stringify(L.store.getState()));
        st.schema = 16; const salt = L.vault.newSalt(), key = await L.vault.deriveKey(pass, salt);
        return JSON.stringify(await L.vault.makeEnvelope(key, salt, st));
      }, BACKUP);
      await page.setInputFiles('#vf-file', { name: 'lifeos-backup-newer.json', mimeType: 'application/json', buffer: Buffer.from(newer) });
      await page.fill('#vf-pass', BACKUP); await page.click('#verify-btn');
      await page.waitForFunction(() => /newer version of LifeOS \(schema 16\)/.test((document.querySelector('#verify-fail') || {}).textContent || ''), null, T);
      if ((await envelope()) !== before) throw new Error('verify wrote to storage');
      if ((await page.evaluate(() => globalThis.LifeOS.store.getMeta().rev)) !== rev0) throw new Error('verify changed the revision');
      if (downloads !== 1) throw new Error('verify downloaded something');
    });
    await step('reminder: a short interval, an old backup date, the banner appears with Export backup, Snooze one day hides it', async () => {
      await page.fill('#rem-days', '0'); await page.click('#rem-save'); await page.waitForTimeout(300);
      if ((await page.evaluate(() => globalThis.LifeOS.store.getState().settings.backupReminderDays)) !== 7) throw new Error('an interval of 0 was saved');
      await page.fill('#rem-days', '1'); await page.click('#rem-save');
      await page.waitForSelector('.notice.ok:has-text("Reminder settings saved.")', T);
      if ((await page.evaluate(() => globalThis.LifeOS.store.getState().settings.backupReminderDays)) !== 1) throw new Error('interval not saved');
      await page.evaluate(() => globalThis.LifeOS.store.commit((x) => { x.ops.lastBackupAt = '2026-11-15'; }, { quiet: true }));
      await nav('Home'); await page.waitForSelector('#backup-banner', T);
      if (!/last backup or sync was 3 days ago/.test(await text('#backup-banner'))) throw new Error('banner text: ' + await text('#backup-banner'));
      if (!(await page.isVisible('#banner-export')) || !(await page.isVisible('#banner-snooze'))) throw new Error('banner buttons');
      await noHScroll('banner');
      await nav('Settings'); await page.waitForSelector('#backup-banner', T);
      await page.click('#banner-snooze'); await page.waitForSelector('#backup-banner', { state: 'detached', ...T });
      const o = await ops(); if (o.snoozeUntil !== '2026-11-19') throw new Error('snooze ' + o.snoozeUntil);
      await nav('Home'); await page.waitForSelector('#safety-card', T);
      if (await page.$('#backup-banner')) throw new Error('banner back while snoozed');
      await page.waitForTimeout(300);
      if (downloads !== 1) throw new Error('a download started without a tap');
    });
    await step('Copy diagnostics: the clipboard text holds codes, version, schema and browser family only, no data', async () => {
      await page.evaluate((M) => {
        const L = globalThis.LifeOS;
        L.ops.setArea('money');
        window.dispatchEvent(new ErrorEvent('error', { message: M + ' boom', filename: M, error: Object.assign(new Error(M), { stack: M }) }));
        window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason: new Error(M) }));
        L.ops.record('SYNC_409', 'sync'); L.ops.setArea('app');
        return L.store.commit(() => {}, { quiet: true });
      }, MARK);
      await nav('Settings'); await page.waitForSelector('#diag-copy', T);
      await page.waitForFunction(() => /^[1-9]\d* codes? recorded/.test(document.querySelector('#diag-count').textContent), null, T);
      await page.click('#diag-copy'); await page.waitForSelector('.notice.ok:has-text("Diagnostics copied")', T);
      const copied = await page.evaluate(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return window.__copied || ''; } });
      const lines = copied.split('\n');
      if (lines[0] !== 'LifeOS diagnostics' || !/^Version: 1\.3\.0$/.test(lines[1]) || lines[2] !== 'Schema: 15' || lines[3] !== 'Browser: Chrome' || !/^Codes: \d+$/.test(lines[4])) throw new Error('header: ' + lines.slice(0, 5).join(' / '));
      if (!lines.slice(5).some((l) => /UNCAUGHT_MONEY money$/.test(l)) || !lines.slice(5).some((l) => /REJECTION_MONEY money$/.test(l)) || !lines.slice(5).some((l) => /SYNC_409 sync$/.test(l))) throw new Error('codes missing: ' + copied);
      if (lines.slice(5).some((l) => !/^\d{4}-\d{2}-\d{2} [A-Z0-9_]+ [a-z]+$/.test(l))) throw new Error('a line is not a code line: ' + copied);
      if (copied.includes(MARK) || /lunch|account|LLC|Mozilla|HeadlessChrome|file:|\d+\.\d+\.\d+\.\d+/.test(copied)) throw new Error('data in the copied text: ' + copied);
      const ring = JSON.stringify((await ops()).diag);
      if (ring.includes(MARK)) throw new Error('marker in the ring');
      await page.click('#diag-clear'); await page.waitForSelector('.notice.ok:has-text("Diagnostics cleared.")', T);
      if ((await ops()).diag.length !== 0) throw new Error('clear left codes');
      if (!/^0 codes recorded/.test(await text('#diag-count'))) throw new Error('count after clear');
      await noHScroll('diagnostics');
    });
    await step('Remind me to sync: on, with a client ID and changes not on Drive, locking shows a one-line notice and syncs nothing', async () => {
      await nav('Settings'); await page.waitForSelector('#rem-sync', T);
      await page.check('#rem-sync'); await page.click('#rem-save'); await page.waitForSelector('.notice.ok:has-text("Reminder settings saved.")', T);
      await page.evaluate(() => globalThis.LifeOS.store.commit((x) => { x.settings.sync.clientId = 'safety-test.apps.googleusercontent.com'; }, { quiet: true }));
      await page.click('.top .lockbtn'); await page.waitForSelector('#pass', T);
      await page.waitForSelector('.notice:has-text("changes that are not synced to Drive")', T);
      if (requests.length) throw new Error('network requests: ' + requests.join(', '));
    });
    await step('unlock: dates, interval and the storage line persist; the lock screen does not scroll sideways', async () => {
      await noHScroll('lock screen');
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
      await page.waitForSelector('#safety-card', T);
      if (!/Last backup: 2026-11-15 \(3 days ago\)/.test(await text('#safety-backup'))) throw new Error('date after unlock: ' + await text('#safety-backup'));
      await nav('Settings'); await page.waitForSelector('#rem-days', T);
      if ((await page.inputValue('#rem-days')) !== '1' || !(await page.isChecked('#rem-sync'))) throw new Error('reminder settings not kept');
      await page.waitForFunction(() => !/checking/.test(document.querySelector('#storage-status').textContent), null, T);
      const o = await ops(); if (!o.persist.at) throw new Error('persist result not kept: ' + JSON.stringify(o.persist));
      await noHScroll('settings after unlock');
      if (requests.length) throw new Error('network requests: ' + requests.join(', '));
    });
  } catch { /* recorded in problems */ }
  await ctx.close();
}

// SEC-93 audit spot check, kept as a regression: with navigator.storage missing, or with every method rejecting or throwing, the app still
// unlocks, says "may be cleared", records 'unavailable' or 'error' inside the vault only, and the copied error text never enters the ring.
async function storageApis(mode) {
  const label = 'storage-' + mode;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  await page.addInitScript(([mode, M]) => {
    const fake = mode === 'missing' ? undefined : {
      persist: () => Promise.reject(new Error(M + ' persist')),
      persisted: () => { throw new Error(M + ' persisted'); },
      estimate: () => Promise.reject(new Error(M + ' estimate'))
    };
    Object.defineProperty(Navigator.prototype, 'storage', { get: () => fake, configurable: true });
  }, [mode, MARK]);
  try {
    await page.goto(pathToFileURL(file).href);
    await page.fill('#pass', PASS); await page.fill('#pass2', PASS); await page.click('button:has-text("Create vault")');
    await page.waitForSelector('#safety-card', T);
    await page.waitForFunction(() => !/checking/.test(document.querySelector('#safety-storage').textContent), null, T);
    if ((await page.textContent('#safety-storage')).trim() !== 'Storage: may be cleared by the browser') throw new Error('dashboard storage line');
    await page.click('.nav button:has-text("Settings")'); await page.waitForSelector('#storage-status', T);
    await page.waitForFunction(() => !/checking/.test(document.querySelector('#storage-status').textContent) && document.querySelector('#storage-estimate').textContent.length > 0, null, T);
    if ((await page.textContent('#storage-status')).trim() !== 'Storage: may be cleared by the browser') throw new Error('settings status');
    if (!/not available/.test(await page.textContent('#storage-estimate'))) throw new Error('estimate line');
    const help = await page.textContent('#storage-help');
    if (!/bookmark/.test(help) || (mode === 'missing') !== /does not offer/.test(help)) throw new Error('help: ' + help);
    await page.waitForFunction((want) => globalThis.LifeOS.store.getState().ops.persist.result === want, mode === 'missing' ? 'unavailable' : 'error', T);
    await page.evaluate(() => globalThis.LifeOS.store.commit(() => {}, { quiet: true }));
    const st = await page.evaluate(() => ({ ops: JSON.stringify(globalThis.LifeOS.store.getState().ops), ls: localStorage.length, ss: sessionStorage.length, main: document.querySelector('main').textContent }));
    if (st.ls || st.ss) throw new Error('something was stored outside the vault');
    if (st.ops.includes('SAFETYMARK') || st.main.includes('SAFETYMARK')) throw new Error('an API error text was kept or shown');
    if (mode === 'reject' && !/STORAGE_PERSIST_ERROR/.test(st.ops)) throw new Error('the failed request left no code');
  } catch (e) { problems.push(label + ': ' + String(e.message).split('\n')[0]); }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await storageApis('missing');
await storageApis('reject');
await browser.close();
if (problems.length) { console.log('SMOKE-SAFETY FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-SAFETY PASSED');
