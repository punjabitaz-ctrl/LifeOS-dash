// v1.0.0 smoke (final review): UI-1 Chrome autofill keeps nothing typed into the app (served over http with a real profile, many
// forms and dialogs submitted, the profile's autofill table must stay empty) and every input, textarea and form on every screen says
// autocomplete off (only the main passphrase fields name a password purpose); CR-9 the page refuses to run in a frame; PV-1 the
// ledger card refuses while private entries or lines are hidden; UI-6 a wrong current passphrase in "Change private passphrase" is
// delayed like the open form; UI-10 Customize makes module bodies inert and the Drag handle is pointer only. Run `node build.mjs` first.
import path from 'node:path';
import { navTo } from './_nav.mjs';
import http from 'node:http';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skipTour } from './_tour.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '..', 'dist', 'lifeos.html');
let pw;
try { pw = await import('playwright'); } catch { console.log('SKIPPED: playwright not available'); process.exit(0); }
const EXE = '/usr/bin/google-chrome';
const PASS = 'correct horse battery staple', PRIV = 'private vault passphrase one';
const problems = [];
const T = { timeout: 30000 };

const html = readFileSync(file);
const srv = http.createServer((q, r) => {
  if (q.url === '/frame') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>f</title><iframe id="f" src="/app" width="400" height="300"></iframe>'); return; }
  r.writeHead(200, { 'content-type': 'text/html' }); r.end(html);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + srv.address().port;
const prof = mkdtempSync(path.join(tmpdir(), 'lifeos-v100-'));
let ctx;
try { ctx = await pw.chromium.launchPersistentContext(prof, { executablePath: EXE, headless: true }); } catch { console.log('SKIPPED: chrome unavailable'); srv.close(); process.exit(0); }
const page = await ctx.newPage(); await skipTour(page);
page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push('console: ' + m.text()); });
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
async function step(name, fn) { if (process.env.SMOKE_VERBOSE) console.log('step', name); try { await fn(); } catch (e) { problems.push(name + ': ' + String(e.message).split('\n').slice(0, 6).join(' | ')); } }
const nav = (n) => navTo(page, n);
// Every input, textarea and form must carry autocomplete off; the main passphrase fields may name a password purpose instead.
const auditAutocomplete = (where) => page.evaluate((w) => {
  const bad = [];
  for (const el of document.querySelectorAll('input,textarea,form')) {
    const a = el.getAttribute('autocomplete');
    const pw = el.type === 'password' && /^(new-password|current-password|off)$/.test(a || '');
    if (a !== 'off' && !pw) bad.push(w + ': ' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' autocomplete=' + a);
  }
  return bad;
}, where);
const seen = [];
const audit = async (where) => { for (const b of await auditAutocomplete(where)) seen.push(b); };

try {
  await page.goto(base + '/app');
  await audit('lock screen');
  await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
  await page.click('button:has-text("Create vault")');
  await page.waitForSelector('.tile', T);

  await step('UI-1 submit many forms and dialogs with marked text', async () => {
    await nav('Money'); await page.waitForSelector('#f-title', T);
    await page.fill('#f-title', 'AFX money title'); await page.fill('#f-value', '5');
    await page.click('button:has-text("Add entry")');
    await page.waitForSelector('.entry-t:has-text("AFX money title")', T);
    await audit('Money');
    await page.click('#quick-add-money'); await page.waitForSelector('.dialog #qa-amount', T);
    await page.fill('#qa-amount', '3'); await page.fill('#qa-note', 'AFX quick note');
    await page.click('.dialog button:has-text("Save")');
    await page.waitForSelector('.dialog', { state: 'detached', timeout: 15000 });
    await page.waitForFunction(() => LifeOS.store.getState().entries.length === 2 && !document.getElementById('app').classList.contains('busy'), null, T);
    await nav('Work'); await page.waitForSelector('#oc-title', T);
        await page.fill('#oc-title', 'AFX outcome'); await page.press('#oc-title', 'Enter');
    await page.waitForFunction(() => LifeOS.store.getState().entries.some((e) => e.title === 'AFX outcome') && !document.getElementById('app').classList.contains('busy'), null, T);
        await page.fill('#pj-name', 'AFX project'); await page.press('#pj-name', 'Enter');
    await page.waitForFunction(() => LifeOS.store.getState().projects.some((p) => p.name === 'AFX project'), null, T);
    await audit('Work');
    await nav('Health'); await page.waitForSelector('#hb-name', T); await audit('Health');
    await nav('Assets'); await audit('Assets');
    await nav('Settings'); await audit('Settings');
    await nav('Memory'); await audit('Memory');
    await nav('Review'); await page.waitForSelector('#prio1', T);
    for (const i of [1, 2, 3]) await page.fill('#prio' + i, 'AFX priority ' + i);
    await audit('Review');
    await page.click('#finish-review');
    await page.waitForSelector('.tile', T);
    for (const d of ['goals', 'home', 'admin', 'learning', 'activities', 'social']) {
      await nav('Overview'); await page.click('.tile[data-domain="' + d + '"]'); await page.waitForTimeout(200); await audit(d);
    }
  });

  await step('UI-10 Customize: module bodies are inert, Drag is pointer only', async () => {
    await nav('Overview'); await page.click('#dash-customize'); await page.waitForSelector('#dash-edit', T);
    const r = await page.evaluate(() => ({
      inert: Array.from(document.querySelectorAll('.modbody')).every((b) => b.inert),
      drag: Array.from(document.querySelectorAll('.drag')).every((b) => b.tabIndex === -1 && b.getAttribute('aria-hidden') === 'true'),
      size: Array.from(document.querySelectorAll('.modbar select')).every((x) => x.classList.contains('mv-size') && /^Size of /.test(x.getAttribute('aria-label') || '')),
    }));
    if (!r.inert || !r.drag || !r.size) throw new Error(JSON.stringify(r));
    await audit('Customize');
    await page.click('#dash-customize');
  });

  await step('PV-1 ledger refuses while private lines are hidden; UI-6 change-passphrase delay', async () => {
    await page.click('#nav-private');
    await page.fill('#priv-set1', PRIV); await page.fill('#priv-set2', PRIV);
    await page.click('#priv-setup-btn');
    await page.waitForSelector('#priv-rk-prompt', { timeout: 30000 }); await page.click('.dialog button:has-text("Later")');   // v1.8.0: the private recovery key prompt
    await page.waitForSelector('#priv-bar', T);
    await audit('Private (open)');
    await page.evaluate(() => LifeOS.priv.write((s) => { s.projects.push({ id: 'hid1', name: 'Hidden line', kind: 'client', status: 'active', nextAction: '', archived: false }); }, { newPrivate: true }));
    await page.click('#priv-close');
    await nav('Work'); await page.click('#open-revenue'); await page.waitForSelector('#ledger-card', T);
    if (!(await page.locator('#ledger-locked').count()) || (await page.locator('#ledger-file').count())) throw new Error('ledger card did not refuse while closed');
    await page.click('#nav-private'); await page.waitForSelector('#priv-old', T);
    await page.fill('#priv-old', 'not the private passphrase'); await page.fill('#priv-new1', 'another private one 22'); await page.fill('#priv-new2', 'another private one 22');
    await page.click('#priv-change');
    await page.waitForSelector('#priv-change-wait:has-text("Wait")', T);
    if (!(await page.locator('#priv-change').isDisabled())) throw new Error('change button not disabled during the delay');
    if ((await page.inputValue('#priv-old')) !== '' || (await page.inputValue('#priv-new1')) !== '') throw new Error('UI-9 passphrase fields not cleared after a failure');
    await audit('Private (closed)');
  });

  await step('CR-9 framed page refuses to run', async () => {
    const fp = await ctx.newPage(); await skipTour(fp);
    await fp.goto(base + '/frame');
    const fr = fp.frameLocator('#f');
    await fr.locator('text=cannot run inside a frame').waitFor(T);
    if (await fr.locator('#pass').count()) throw new Error('the lock screen rendered inside a frame');
    await fp.close();
  });

  await page.waitForTimeout(1500);
  await ctx.close();
  await step('UI-1 Chrome autofill table holds nothing', async () => {
    const rows = JSON.parse(execFileSync('python3', ['-I', '-c', 'import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);print(json.dumps(list(c.execute("select name,value from autofill"))))', path.join(prof, 'Default', 'Web Data')]).toString());
    if (rows.length) throw new Error('autofill rows: ' + JSON.stringify(rows));
  });
  for (const b of seen) problems.push('UI-1 ' + b);
} finally { srv.close(); rmSync(prof, { recursive: true, force: true }); }
if (problems.length) { console.log('SMOKE-V100 FAILED'); for (const p of problems) console.log(' - ' + p); process.exit(1); }
console.log('SMOKE-V100 PASSED');
