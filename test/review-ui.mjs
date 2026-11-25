// UI review proofs (v0.12.0). May fail: each failure is a finding. Run `node build.mjs` first.
// Needs Playwright and Chrome at /usr/bin/google-chrome. python3 is used to read Chrome's autofill database.
//  P1 (UI-1) typed titles and priorities are saved in plaintext in Chrome's autofill database when served over http(s).
//  P2 (UI-2) form controls with no accessible name (dashboard Customize size select, pipeline stage select, tax state select,
//     household bill pick), checked at desktop and 390 px.
//  P3 (UI-3) after changing a module's size in Customize, focus lands on Hide instead of the size select.
//  P4 390 px horizontal overflow on the new v0.12.0 screens (dashboard edit mode, Work, Revenue, Home, Admin).
//  P5 (UI-5) "New items are private" silently applies to one-tap writes that show no privacy note.
import path from 'node:path';
import { navTo } from './_nav.mjs';
import http from 'node:http';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { skipTour } from './_tour.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '..', 'dist', 'lifeos.html');
let pw;
try { pw = await import('playwright'); } catch { console.log('SKIPPED: playwright not available'); process.exit(0); }
const EXE = '/usr/bin/google-chrome';
const PASS = 'correct horse battery staple';
const problems = [];
const note = (m) => { problems.push(m); console.log('FINDING ' + m); };

async function create(page) {
  await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
  await page.click('button:has-text("Create vault")');
  await page.waitForSelector('.tile', { timeout: 30000 });
}

// ---- P1: autofill persistence ----
async function p1() {
  const html = readFileSync(file);
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/';
  const prof = mkdtempSync(path.join(tmpdir(), 'lifeos-af-'));
  try {
    const ctx = await pw.chromium.launchPersistentContext(prof, { executablePath: EXE, headless: true });
    const page = await ctx.newPage(); await skipTour(page);
    await page.goto(url);
    await create(page);
    await page.click('.tile[data-domain="money"]');
    await page.fill('#f-title', 'AFSECRET title'); await page.fill('#f-value', '5');
    await page.click('button:has-text("Add entry")');
    await page.waitForSelector('.entry:has-text("AFSECRET")');
    await navTo(page, 'Review');
    for (const i of [1, 2, 3]) await page.fill('#prio' + i, 'AFPRIO' + i);
    await page.click('#finish-review');
    await page.waitForSelector('.tile');
    await page.waitForTimeout(1500);
    await ctx.close();
    const rows = execFileSync('python3', ['-I', '-c', 'import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);print(json.dumps(list(c.execute("select name,value from autofill"))))', path.join(prof, 'Default', 'Web Data')]).toString();
    const got = JSON.parse(rows);
    console.log('autofill rows:', JSON.stringify(got));
    if (got.some((r) => /AFSECRET|AFPRIO/.test(r[1]))) note('UI-1 typed vault text stored in plaintext in Chrome autofill: ' + got.map((r) => r[0] + '=' + r[1]).join(', '));
  } finally { srv.close(); rmSync(prof, { recursive: true, force: true }); }
}

// ---- P2, P3, P4 ----
const SEED = `(async () => {
  const L = globalThis.LifeOS, E = (o) => L.metrics.validateEntry(o);
  const t = new Date(); const pad = (n) => (n < 10 ? '0' : '') + n; const today = t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
  await L.store.commit((s) => {
    s.pipeline.push({ id: 'pl1', title: 'Pipe item', org: 'Org', kind: 'job', stage: 'lead', source: '', nextStep: '', updatedAt: today, notes: '' });
    s.recurring.push({ id: 'rc1', title: 'Power bill', value: 80, category: '', type: 'expense', cadence: 'monthly', nextDate: '2099-01-01', active: true, household: false });
    s.projects.push({ id: 'pj1', name: 'A very long line of work name for layout checks', kind: 'venture', status: 'active', nextAction: '', archived: false });
    s.entries.push(E({ id: 'in1', domain: 'money', type: 'income', date: today, title: 'Invoice 1', value: 1234567.89, projectId: 'pj1' }));
    L.admin.addTaxItem(s, { year: '2025', title: 'W-2 form', dueDate: '' });
  });
})()`;
async function unlabeled(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('input:not([type=hidden]),select,textarea')) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const named = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label') || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) || el.title;
      if (!named) out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '[' + (el.className || '') + '] in ' + ((el.closest('[id]') || {}).id || '?') + ' options=' + Array.from(el.options || []).slice(0, 3).map((o) => o.text).join('/'));
    }
    return out;
  });
}
async function overflow(page, where) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  if (r.sw > r.iw) note('390px overflow on ' + where + ' (' + r.sw + ' > ' + r.iw + ')');
}
async function p234(browser, label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : {});
  const page = await ctx.newPage(); await skipTour(page);
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) note(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => note(label + ' pageerror: ' + e.message));
  await page.goto(pathToFileURL(file).href);
  await create(page);
  await page.evaluate(SEED);
  await navTo(page, 'Work'); // re-render with the seed
  const found = new Set();
  const scan = async (where) => { for (const u of await unlabeled(page)) found.add(where + ': ' + u); if (viewport) await overflow(page, where); };
  await navTo(page, 'Overview');
  await page.click('#dash-customize');
  await page.waitForSelector('#dash-edit');
  await scan('dashboard (Customize)');
  // P3: change the first module's size with the keyboard path and see where focus lands
  const sizeSel = page.locator('.mod[data-mod="priorities"] .modbar select');
  await sizeSel.selectOption('small');
  await page.waitForSelector('.mod[data-mod="priorities"][data-size="small"]');
  const focused = await page.evaluate(() => { const a = document.activeElement; return a ? a.tagName + '.' + a.className + ' ' + (a.textContent || '') : 'none'; });
  if (!/^SELECT/.test(focused)) note(label + ' UI-3 focus after size change is on ' + focused.trim() + ', not the size select');
  await page.click('#dash-customize');
  await navTo(page, 'Work');
  await page.waitForSelector('#pipeline');
  await scan('Work');
  await page.click('#open-revenue');
  await page.waitForSelector('#rev-lines');
  await scan('Revenue');
  await navTo(page, 'Overview');
  await page.click('.tile[data-domain="home"]');
  await page.waitForSelector('#hm-bills');
  await scan('Overview');
  await navTo(page, 'Overview');
  await page.click('.tile[data-domain="admin"]');
  await page.click('#ad-tax summary').catch(() => {});
  await scan('Admin');
  for (const f of found) note(label + ' UI-2 unlabeled control: ' + f);
  await ctx.close();
}

// ---- P5 (UI-5): with "New items are private" on, a tap on a PUBLIC daily check stores the tick in the private vault, although no
// "New items are private" note is shown on the chip; after closing, the public habit shows as not done today.
async function p5(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage(); await skipTour(page);
  await page.goto(pathToFileURL(file).href);
  await create(page);
  await page.evaluate(`(async () => { await LifeOS.store.commit((s) => { LifeOS.metrics.addHabit(s, 'Stretch'); }); })()`);
  await page.click('#nav-private');
  await page.fill('#priv-set1', 'private vault passphrase one'); await page.fill('#priv-set2', 'private vault passphrase one');
  await page.click('#priv-setup-btn');
  await page.waitForSelector('#priv-rk-prompt', { timeout: 30000 }); await page.click('.dialog button:has-text("Later")');   // v1.8.0: the private recovery key prompt
  await page.waitForSelector('#priv-bar', { timeout: 30000 });
  await page.check('#priv-new');
  await navTo(page, 'Health');
  const chip = page.locator('#hl-habits button[data-habit="Stretch"]');
  const noteOnChip = await page.locator('#hl-habits .privnew-note, #hl-cycle + .privnew-note').count();
  await chip.click();
  await page.waitForSelector('#hl-habits button[data-habit="Stretch"][aria-pressed=true]');
  await page.click('#priv-close');
  await page.waitForSelector('#hl-habits');
  const pressed = await page.getAttribute('#hl-habits button[data-habit="Stretch"]', 'aria-pressed');
  const marks = await page.evaluate(() => LifeOS.priv.marks(LifeOS.store.getState()));
  if (pressed === 'false' && marks.includes('habitLog')) note('UI-5 tick on a public daily check went into the private vault (marks: ' + marks.join(',') + '); privacy note on the chips group: ' + (noteOnChip ? 'yes' : 'no'));
  await ctx.close();
}

try { await p1(); } catch (e) { note('P1 could not run: ' + String(e.message).split('\n')[0]); }
let browser;
try { browser = await pw.chromium.launch({ executablePath: EXE }); } catch { console.log('SKIPPED: chrome unavailable'); process.exit(0); }
try { await p5(browser); } catch (e) { note('P5 run error: ' + String(e.message).split('\n')[0]); }
try {
  await p234(browser, 'desktop', null);
  await p234(browser, 'phone', { width: 390, height: 844 });
} catch (e) { note('run error: ' + String(e.message).split('\n')[0]); }
await browser.close();
if (problems.length) { console.log('REVIEW-UI: ' + problems.length + ' finding(s)'); process.exit(1); }
console.log('REVIEW-UI: no findings');
