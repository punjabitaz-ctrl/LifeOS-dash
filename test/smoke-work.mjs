import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '..', 'dist', 'lifeos.html');
let pw;
try { pw = await import('playwright'); } catch { console.log('SKIPPED: playwright not available (npm i --no-save playwright)'); process.exit(0); }
let browser;
for (const o of [{}, { channel: 'chrome' }, { executablePath: '/usr/bin/google-chrome' }]) {
  try { browser = await pw.chromium.launch(o); break; } catch { /* try next */ }
}
if (!browser) { console.log('SKIPPED: chromium unavailable'); process.exit(0); }

const PASS = 'correct horse battery staple';
// An older-format (schema 2, v0.3.0) backup made with the same core code the app ships (audit SEC-28).
const { L } = await import('./_load.mjs');
const OLD_BACKUP = await (async () => {
  const s = L.store.defaultState(); s.schema = 2; delete s.projects; delete s.pipeline;
  const salt = L.vault.newSalt(), key = await L.vault.deriveKey(PASS, salt);
  return Buffer.from(JSON.stringify(await L.vault.makeEnvelope(key, salt, s)));
})();
const EVIL = '"><img src=x onerror=alert(1)><svg onload=alert(2)>';
const problems = [];
// Hand-computed expectations.
// Outcomes: 3 this week, 2 done -> "2 of 3". Projects: Alpha overdue (2020-01-01), Beta not (2099-01-01) -> 1 overdue.
// Pipeline: Role A lead -> contacted -> applied -> interview (3 taps), Deal B added as contacted then set to lost, Partner C stays lead.
// Final counts: lead 1, interview 1, lost 1, others 0. Open = lead + interview = 2. Nothing stale (all updated today).
const WANT = { done: '2 of 3', overdue: '1', open: '2', stale: '0', counts: { lead: 1, contacted: 0, applied: 0, interview: 1, offer: 0, won: 0, lost: 1 } };

async function run(label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n')[0]); throw e; } }
  const noHScroll = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
  };
  const text = (sel) => page.textContent(sel).then((t) => t.trim());
  const expectText = async (sel, want) => { const got = await text(sel); if (got !== want) throw new Error(sel + ' is ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want)); };
  const nav = (name) => page.click('.nav button:has-text("' + name + '")');
  const addProject = async (name, kind, next, date) => {
    if (!(await page.locator('#pj-name').isVisible())) await page.click('#pj-new summary');
    await page.fill('#pj-name', name); await page.selectOption('#pj-kind', kind); await page.fill('#pj-next', next); await page.fill('#pj-date', date);
    await page.click('#pj-add');
    await page.waitForSelector('.notice:has-text("Project added.")');
    await page.waitForSelector('.proj[data-project="' + name + '"]');
  };
  const addOutcome = async (title, projLabel) => {
    await page.fill('#oc-title', title);
    if (projLabel) await page.selectOption('#oc-proj', { label: projLabel });
    await page.click('#oc-add');
    await page.waitForSelector('.notice:has-text("Outcome added.")');
    await page.waitForSelector('.outcome[data-outcome="' + title + '"]');
  };
  const done = async (title) => {
    await page.click('.outcome[data-outcome="' + title + '"] button:has-text("Mark done")');
    await page.waitForSelector('.outcome[data-outcome="' + title + '"][data-status="done"]');
  };
  const addItem = async (title, org, kind, stage) => {
    if (!(await page.locator('#pl-title').isVisible())) await page.click('#pl-new summary');
    await page.fill('#pl-title', title); await page.fill('#pl-org', org); await page.selectOption('#pl-kind', kind); await page.selectOption('#pl-stage', stage);
    await page.click('#pl-add');
    await page.waitForSelector('.notice:has-text("Pipeline item added.")');
    await page.waitForSelector('.pitem[data-item="' + title + '"]');
  };
  const checkWork = async (where) => {
    await expectText('#wk-done', WANT.done); await expectText('#wk-overdue', WANT.overdue);
    await expectText('#wk-open', WANT.open); await expectText('#wk-stale', WANT.stale);
    const labels = { lead: 'Lead', contacted: 'Contacted', applied: 'Applied', interview: 'Interview', offer: 'Offer', won: 'Won', lost: 'Lost' };
    for (const k of Object.keys(WANT.counts)) await expectText('[data-count="' + k + '"]', labels[k] + ' ' + WANT.counts[k]);
    for (const [t, st] of [['Role A', 'interview'], ['Deal B', 'lost'], ['Partner C', 'lead']]) {
      if ((await page.locator('.stage[data-stage="' + st + '"] .pitem[data-item="' + t + '"]').count()) !== 1) throw new Error(t + ' not in ' + st);
    }
    if ((await page.locator('.outcome[data-status="done"]').count()) !== 2) throw new Error('two outcomes should be done');
    const chip = await text('.outcome[data-outcome="Ship demo"] .chip');
    if (chip !== 'Alpha') throw new Error('outcome not linked to Alpha: ' + chip);
    if (!(await text('.proj[data-project="Alpha"]')).includes('Overdue')) throw new Error('Alpha should be overdue');
    if ((await page.locator('.proj[data-project="Beta"] .chip.bad').count()) !== 0) throw new Error('Beta should not be overdue');
    if ((await page.locator('#work-trend rect').count()) !== 8) throw new Error('trend should have 8 bars');
    const ts = await page.locator('#work-trend text').allTextContents();
    if (ts[14] !== '2') throw new Error('this week bar should be 2, got ' + ts[14]);
    if (ts.slice(0, 14).some((x, i) => i % 2 === 0 && x !== '0')) throw new Error('earlier weeks should be 0');
    await noHScroll(where);
  };
  try {
    await page.goto(pathToFileURL(file).href);
    await step('create', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")');
      await page.waitForSelector('.tile', { timeout: 30000 });
      await noHScroll('dashboard');
    });
    await step('empty work tile', async () => {
      await expectText('.tile[data-domain="work"] .tile-value', '0 of 0');
    });
    await step('projects', async () => {
      await nav('Work');
      await page.waitForSelector('#pj-name');
      await noHScroll('work empty');
      await addProject('Alpha', 'venture', 'Call supplier', '2020-01-01');
      await addProject('Beta', 'client', 'Send quote', '2099-01-01');
      await noHScroll('projects');
    });
    await step('outcomes', async () => {
      await addOutcome('Ship demo', 'Alpha');
      await addOutcome('Write memo');
      await addOutcome('Review plan');
      await done('Ship demo'); await done('Write memo');
      await expectText('#wk-done', WANT.done);
      await noHScroll('outcomes');
    });
    await step('pipeline', async () => {
      await addItem('Role A', 'Acme', 'job', 'lead');
      await addItem('Deal B', 'Bravo', 'deal', 'contacted');
      await addItem('Partner C', 'Charlie', 'partner', 'lead');
      for (const next of ['Contacted', 'Applied', 'Interview']) {
        await page.click('.pitem[data-item="Role A"] button:has-text("To ' + next + '")');
        await page.waitForSelector('.pitem[data-item="Role A"][data-stage="' + next.toLowerCase() + '"]');
      }
      await page.selectOption('.pitem[data-item="Deal B"] select', 'lost');
      await page.waitForSelector('.pitem[data-item="Deal B"][data-stage="lost"]');
      await checkWork('work filled');
    });
    await step('dashboard tile', async () => {
      await nav('Home');
      await page.waitForSelector('.tile');
      await expectText('.tile[data-domain="work"] .tile-value', WANT.done);
      const sub = await text('.tile[data-domain="work"] .tile-sub >> nth=1');
      if (sub !== '1 overdue next action, 2 open in pipeline') throw new Error('tile sub: ' + sub);
      await noHScroll('dashboard filled');
      await page.click('.tile[data-domain="work"]');
      await page.waitForSelector('#wk-done');
    });
    await step('review shows no automatic carry-over', async () => {
      await nav('Review');
      await page.waitForSelector('#rules-run');
      if (await page.locator('#carry-card').count()) throw new Error('carry-over card without earlier unfinished outcomes');
      await noHScroll('review');
    });
    await step('lock and unlock', async () => {
      await page.click('.top button:has-text("Lock")');
      await page.waitForSelector('#pass');
      const t = await page.evaluate(() => document.getElementById('app').textContent);
      if (/Alpha|Role A|Ship demo|Acme/.test(t)) throw new Error('work data visible while locked');
      await page.fill('#pass', PASS);
      await page.click('button:has-text("Unlock")');
      await page.waitForSelector('.tile', { timeout: 30000 });
      await expectText('.tile[data-domain="work"] .tile-value', WANT.done);
      await nav('Work');
      await page.waitForSelector('#wk-done');
      await checkWork('work after unlock');
    });
    if (label === 'desktop') await step('hostile text stays text', async () => {
      await nav('Work');
      await page.waitForSelector('#wk-done');
      await page.click('#pj-new summary');
      await page.fill('#pj-name', EVIL); await page.fill('#pj-next', EVIL); await page.fill('#pj-date', '2099-01-01');
      await page.click('#pj-add');
      await page.waitForSelector('.notice:has-text("Project added.")');
      if ((await page.evaluate((v) => [...document.querySelectorAll('.proj')].filter((e) => e.getAttribute('data-project') === v).length, EVIL)) !== 1) throw new Error('hostile project missing');
      if (!(await page.locator('#pl-title').isVisible())) await page.click('#pl-new summary');
      await page.fill('#pl-title', EVIL); await page.fill('#pl-org', EVIL); await page.fill('#pl-source', EVIL); await page.fill('#pl-next', EVIL); await page.fill('#pl-notes', EVIL);
      await page.click('#pl-add');
      await page.waitForSelector('.notice:has-text("Pipeline item added.")');
      if (await page.locator('#app img, #app [onerror], #app [onload], #app svg:not(#work-trend):not(.chart):not(.spark)').count()) throw new Error('markup from data reached the DOM');
      if (!(await page.textContent('#pipeline')).includes(EVIL)) throw new Error('hostile title not shown as text');
    });
    if (label === 'desktop') await step('older backup needs an explicit choice', async () => {
      await nav('Settings');
      await page.setInputFiles('#bk-file', { name: 'old.json', mimeType: 'application/json', buffer: OLD_BACKUP });
      await page.fill('#bk-ipass', PASS);
      await page.click('button:has-text("Import backup")');
      await page.waitForSelector('.dialog #bk-older', { timeout: 30000 });
      if (!/Projects: 0, pipeline items: 0/.test(await page.textContent('#bk-summary'))) throw new Error('summary lacks work counts');
      if (!/removes your 3 projects and 4 pipeline items/.test(await page.textContent('#bk-older'))) throw new Error('warning text: ' + await page.textContent('#bk-older'));
      await page.click('.dialog button:has-text("Replace")');
      await page.waitForSelector('.dialog p[role=status]:has-text("older version")', { timeout: 30000 });
      await page.click('.dialog button:has-text("Cancel")');
      await nav('Work');
      await page.waitForSelector('.proj[data-project="Alpha"]');
      await nav('Settings');
      await page.setInputFiles('#bk-file', { name: 'old.json', mimeType: 'application/json', buffer: OLD_BACKUP });
      await page.fill('#bk-ipass', PASS);
      await page.click('button:has-text("Import backup")');
      await page.waitForSelector('.dialog #bk-workloss', { timeout: 30000 });
      await page.check('#bk-workloss');
      await page.click('.dialog button:has-text("Replace")');
      await page.waitForSelector('.notice:has-text("Backup restored.")', { timeout: 30000 });
      await nav('Work');
      await page.waitForSelector('#wk-done');
      if (await page.locator('.proj').count()) throw new Error('projects should be gone after the chosen restore');
    });
  } catch { /* recorded */ }
  await ctx.close();
}
await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.error('SMOKE-WORK FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-WORK PASSED');
