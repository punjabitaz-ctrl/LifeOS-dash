// v1.6.0 Job search smoke: desktop and 390x844. Fails on console errors, CSP violations, horizontal scroll.
// Run `node build.mjs` first. Needs Playwright (`npm i --no-save playwright`) and Chrome at /usr/bin/google-chrome.
import path from 'node:path';
import { navTo } from './_nav.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '..', 'dist', 'lifeos.html');
let pw;
try { pw = await import('playwright'); } catch { console.log('SKIPPED: playwright not available'); process.exit(0); }
let browser;
for (const o of [{ executablePath: '/usr/bin/google-chrome' }, { channel: 'chrome' }, {}]) {
  try { browser = await pw.chromium.launch(o); break; } catch { /* try next */ }
}
if (!browser) { console.log('SKIPPED: chromium unavailable'); process.exit(0); }

const PASS = 'correct horse battery staple';
const PRIV = 'a different private passphrase 9';
const T = { timeout: 30000 };
const problems = [];
// Hand-computed expectations. The page clock is Thursday 2026-11-12 10:00; its week (Monday start) is 2026-11-09 to 2026-11-15.
// Applications added through the form:
//   A "Engineer at Acme"   applied 2026-11-10, follow-up 2026-11-12, source referral
//   B "Writer at Birch"    applied 2026-11-02
//   C "Clerk at Cedar"     stage lead, no dates
//   D "Pilot at Delta"     applied 2026-10-28
// Step 1 (A, B, D applied, C lead): open 4, applied this week 1 (A), follow-ups due 1 (A). Funnel: applied 3, response 0/3 = 0%, interview 0%, offer 0%.
// Step 2 (A to interview, C to contacted, D lost as rejected): applied 3 (A, B, D). Responded A and D = 2/3 = 66.7%. Interviewed A = 1/3 = 33.3%. Offered 0%.
//   Open 3 (A, B, C). Months: 2026-11 has A, B, C (3 items), 2 applied, response 1/2 = 50%, interview 50%, offer 0%; 2026-10 has D, 1 applied, response 100%.
//   This week: applications 1, interviews 1, offers 0, follow-ups due 1.
// Step 3 (person linked to A, one contact logged, then "Followed up"): outreach 1, people contacted 1, follow-ups done 1, follow-ups due 0.
// Step 4 (A to offer): interviews 0, offers 1; interview rate 1/3 = 33.3% (an offer was interviewed), offer rate 33.3%.
// Step 5 (CSV: Analyst at Echo applied 2026-11-11, Designer at Fox lead, Clerk at Gamma with the unknown stage "interviewing" rejected): 2 added, 1 rejected;
//   applied 4 (A, B, D, Echo); responded 2/4 = 50%; interviewed 25%; offered 25%; this week applications 2 (A, Echo); open 5 (A, B, C, Echo, Fox).
//   The same file again: 0 to add, 1 rejected, 2 already imported.
const CSV = ['role,company,stage,applied date,source', 'Analyst,Echo,applied,2026-11-11,job board', 'Designer,Fox,lead,,direct', 'Clerk,Gamma,interviewing,2026-11-10,referral'].join('\n');

async function run(label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
  const nav = (name) => navTo(page, name);
  const text = (sel) => page.textContent(sel).then((t) => t.trim());
  const expectText = async (sel, want) => { const got = await text(sel); if (got !== want) throw new Error(sel + ' is ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want)); };
  const expectAll = async (want) => { for (const [sel, v] of Object.entries(want)) await expectText(sel, v); };
  const layout = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
  };
  const jobs = async () => { await nav('Work'); await page.waitForSelector('#open-jobs', T); await page.click('#open-jobs'); await page.waitForSelector('#js-open', T); };
  const J = (title) => '.jobitem[data-item="' + title + '"]';
  async function addJob(f) {
    await page.evaluate(() => { const d = document.querySelector('#js-new'); if (d) d.open = true; });
    await page.fill('#ja-role', f.role); await page.fill('#ja-org', f.org); await page.selectOption('#ja-stage', f.stage);
    if (f.source) await page.selectOption('#ja-source', f.source);
    if (f.applied) await page.fill('#ja-applied', f.applied);
    if (f.follow) await page.fill('#ja-follow', f.follow);
    await page.click('#ja-add'); await page.waitForSelector('.notice.ok:has-text("Application added")', T);
    await page.waitForSelector(J(f.role + ' at ' + f.org), T);
  }
  // The search box: in the header on desktop, in the More sheet on the phone.
  async function search(q) {
    const narrow = !(await page.locator('#hs-q').count());
    if (narrow) { await page.click('#nav-more'); await page.waitForSelector('#ms-q', T); }
    const pre = narrow ? 'ms' : 'hs';
    await page.fill('#' + pre + '-q', q);
    await page.waitForSelector('#' + pre + '-results .searchhit, #' + pre + '-none', T);
    const out = { hits: await page.$$eval('#' + pre + '-results .searchhit', (b) => b.map((x) => x.getAttribute('data-area') + ':' + x.getAttribute('data-label'))), priv: await page.locator('#' + pre + '-results .privbadge').count(), pre };
    if (narrow) { await page.keyboard.press('Escape'); await page.waitForSelector('#ms-q', { state: 'detached', ...T }).catch(async () => { await page.click('.dialog button:has-text("Close")'); }); }
    else await page.fill('#hs-q', '');
    return out;
  }
  try {
    await page.clock.install({ time: new Date(2026, 10, 12, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('create the vault; with no applications every rate says no data', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS); await page.click('button:has-text("Create vault")');
      await page.waitForSelector('.tile', T);
      await jobs();
      await expectAll({ '#js-open': '0', '#js-week-apps': '0', '#js-due': '0', '#fn-applied': '0', '#fn-response': 'no data', '#fn-interview': 'no data', '#fn-offer': 'no data', '#jw-apps': '0' });
      await layout('jobs, empty');
    });
    await step('a person and a Money entry for the search, added through the screens and the store', async () => {
      await nav('Home'); await page.waitForSelector('.tile', T); await page.click('.tile[data-domain="social"]'); await page.waitForSelector('#soc-p-name', T);
      await page.fill('#soc-p-name', 'Pat Recruiter'); await page.click('#soc-p-add'); await page.waitForSelector('.notice.ok', T);
      await page.evaluate(() => { const L = globalThis.LifeOS; return L.store.commit((x) => { x.entries.push(L.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2026-11-12', title: 'Zebra groceries', value: 12 })); }, { quiet: true }); });
    });
    await step('add four applications; the numbers equal the hand-computed ones', async () => {
      await jobs();
      await addJob({ role: 'Engineer', org: 'Acme', stage: 'applied', source: 'referral', applied: '2026-11-10', follow: '2026-11-12' });
      await addJob({ role: 'Writer', org: 'Birch', stage: 'applied', applied: '2026-11-02' });
      await addJob({ role: 'Clerk', org: 'Cedar', stage: 'lead' });
      await addJob({ role: 'Pilot', org: 'Delta', stage: 'applied', applied: '2026-10-28' });
      await expectAll({ '#js-open': '4', '#js-week-apps': '1', '#js-due': '1', '#fn-applied': '3', '#fn-response': '0%', '#fn-interview': '0%', '#fn-offer': '0%', '#jw-apps': '1', '#jw-due': '1' });
      await layout('jobs, four added');
    });
    await step('move stages: interview, contacted, lost as rejected', async () => {
      await page.click(J('Engineer at Acme') + ' .jb-next'); await page.waitForSelector(J('Engineer at Acme') + '[data-stage="interview"]', T);
      await page.click(J('Clerk at Cedar') + ' .jb-next'); await page.waitForSelector(J('Clerk at Cedar') + '[data-stage="contacted"]', T);
      await page.getByLabel('Stage of Pilot at Delta', { exact: true }).selectOption('lost'); await page.waitForSelector(J('Pilot at Delta') + '[data-stage="lost"]', T);
      await page.getByLabel('Outcome reason of Pilot at Delta', { exact: true }).selectOption('rejected'); await page.waitForSelector(J('Pilot at Delta') + ' .jb-reason', T);
      await expectAll({ '#js-open': '3', '#fn-applied': '3', '#fn-response': '66.7%', '#fn-interview': '33.3%', '#fn-offer': '0%', '#jw-apps': '1', '#jw-interviews': '1', '#jw-offers': '0', '#jw-due': '1' });
      await expectAll({ '#js-months tr[data-month="2026-11"] td:nth-child(2)': '3', '#js-months tr[data-month="2026-11"] td:nth-child(3)': '2', '#js-months tr[data-month="2026-11"] td:nth-child(4)': '50%',
        '#js-months tr[data-month="2026-11"] td:nth-child(5)': '50%', '#js-months tr[data-month="2026-11"] td:nth-child(6)': '0%', '#js-months tr[data-month="2026-10"] td:nth-child(3)': '1', '#js-months tr[data-month="2026-10"] td:nth-child(4)': '100%' });
      await layout('jobs, moved');
    });
    await step('link a person, log a contact, mark the follow-up done', async () => {
      await page.getByLabel('Link the chosen person to Engineer at Acme', { exact: true }).click();
      await page.waitForSelector(J('Engineer at Acme') + ' .jb-person[data-person="Pat Recruiter"]', T);
      await page.click(J('Engineer at Acme') + ' .jb-log'); await page.waitForSelector('.notice.ok:has-text("Contact logged")', T);
      await expectAll({ '#jw-outreach': '1', '#jw-people': '1', '#jw-followups': '0', '#jw-due': '1' });
      await page.click(J('Engineer at Acme') + ' .jb-done'); await page.waitForSelector('.notice.ok:has-text("Follow-up recorded")', T);
      await expectAll({ '#jw-followups': '1', '#jw-due': '0', '#js-due': '0', '#jw-outreach': '1' });
    });
    await step('move to offer', async () => {
      await page.click(J('Engineer at Acme') + ' .jb-next'); await page.waitForSelector(J('Engineer at Acme') + '[data-stage="offer"]', T);
      await expectAll({ '#jw-interviews': '0', '#jw-offers': '1', '#fn-interview': '33.3%', '#fn-offer': '33.3%', '#fn-response': '66.7%' });
    });
    await step('import a small tracker CSV; a second import adds nothing', async () => {
      await page.setInputFiles('#jobimp-file', { name: 'jobs.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
      await page.waitForSelector('#jobimp-preview', T); await page.click('#jobimp-preview'); await page.waitForSelector('#jobimp-summary', T);
      await expectText('#jobimp-summary', '2 to add, 1 rejected, 0 already imported.');
      await page.click('#jobimp-confirm'); await page.waitForSelector('#jobimp-done', T);
      await expectAll({ '#js-open': '5', '#fn-applied': '4', '#fn-response': '50%', '#fn-interview': '25%', '#fn-offer': '25%', '#jw-apps': '2' });
      await page.setInputFiles('#jobimp-file', { name: 'jobs.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
      await page.waitForSelector('#jobimp-preview', T); await page.click('#jobimp-preview'); await page.waitForSelector('#jobimp-summary', T);
      await expectText('#jobimp-summary', '0 to add, 1 rejected, 2 already imported.');
      await layout('jobs, imported');
    });
    await step('search across Job search, Social and Money', async () => {
      const a = await search('acme'); if (a.hits.join() !== 'jobs:Engineer at Acme') throw new Error('acme: ' + a.hits);
      const b = await search('PAT recruiter'); if (!b.hits.some((x) => x.startsWith('social:'))) throw new Error('person: ' + b.hits);
      const c = await search('zebra'); if (!c.hits.some((x) => x.startsWith('money:'))) throw new Error('money: ' + c.hits);
      const d = await search('qqqqzzzz'); if (d.hits.length) throw new Error('a nonsense query found ' + d.hits);
    });
    await step('a private application: found with the vault open, never with it closed', async () => {
      await page.click('#nav-private'); await page.waitForSelector('#priv-setup', T);
      await page.fill('#priv-set1', PRIV); await page.fill('#priv-set2', PRIV); await page.click('#priv-setup-btn'); await page.waitForSelector('#priv-bar', T);
      await jobs();
      await page.click(J('Designer at Fox') + ' .jb-edit'); await page.waitForSelector('.priv-move-btn', T); await page.click('.priv-move-btn');
      await page.click('.dialog button:has-text("Move in")'); await page.waitForSelector('.notice:has-text("Moved to the private vault.")', T);
      const open = await search('fox');
      if (open.hits.join() !== 'jobs:Designer at Fox' || open.priv !== 1) throw new Error('open: ' + open.hits + ' priv ' + open.priv);
      await expectText('#js-open', '5');
      await page.click('#priv-close'); await page.waitForSelector('#priv-bar', { state: 'detached', ...T });
      const closed = await search('fox'); if (closed.hits.length) throw new Error('closed vault still finds: ' + closed.hits);
      await jobs();
      if ((await page.textContent('main')).includes('Fox')) throw new Error('the private application shows with the vault closed');
      await expectAll({ '#js-open': '4', '#fn-applied': '4' });
      const still = await search('acme'); if (still.hits.length !== 1) throw new Error('public search broke after close: ' + still.hits);
    });
    await step('lock and unlock: the screen holds nothing, the search works again', async () => {
      await page.click('.top .lockbtn'); await page.waitForSelector('#pass', T);
      const body = await page.textContent('body');
      for (const s of ['Acme', 'Birch', 'Fox', 'Pat Recruiter', 'Zebra']) if (body.includes(s)) throw new Error('the locked page shows ' + s);
      if (await page.locator('#hs-q, #ms-q').count()) throw new Error('the search box is on the lock screen');
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
      const a = await search('birch'); if (a.hits.join() !== 'jobs:Writer at Birch') throw new Error('after unlock: ' + a.hits);
      const f = await search('fox'); if (f.hits.length) throw new Error('private item found after unlock with the vault closed');
      await jobs();
      await expectAll({ '#js-open': '4', '#fn-applied': '4', '#fn-response': '50%', '#jw-apps': '2' });
      await layout('jobs, after unlock');
    });
    await step('v1.6.0 audit: the two follow-up numbers have their own labels (SEC-112); a job added and moved on the Work board counts this week (SEC-111)', async () => {
      const lbl = async (id) => page.$eval('#' + id, (e) => e.previousElementSibling.textContent);
      if ((await lbl('js-due')) !== 'Follow-ups due today') throw new Error('js-due label: ' + (await lbl('js-due')));
      if ((await lbl('jw-due')) !== 'Follow-ups due by the end of the week') throw new Error('jw-due label: ' + (await lbl('jw-due')));
      await nav('Work'); await page.waitForSelector('#pl-title', { state: 'attached', ...T });
      const openForm = async () => { if (!(await page.$eval('#pl-new', (d) => d.open))) await page.click('#pl-new > summary'); await page.waitForSelector('#pl-title', T); };
      await openForm();
      await page.fill('#pl-title', 'Board role'); await page.fill('#pl-org', 'Gamma'); await page.selectOption('#pl-kind', 'job'); await page.selectOption('#pl-stage', 'applied');
      await page.click('#pl-add'); await page.waitForSelector('.notice.ok:has-text("Pipeline item added")', T);
      await page.waitForSelector('#board .pitem[data-item="Board role"]', T); await openForm();
      await page.fill('#pl-title', 'Board lead'); await page.fill('#pl-org', 'Hotel'); await page.selectOption('#pl-kind', 'job'); await page.selectOption('#pl-stage', 'contacted');
      await page.click('#pl-add'); await page.waitForSelector('#board .pitem[data-item="Board lead"]', T);
      await page.click('#board .pitem[data-item="Board lead"] button:has-text("To Applied")');
      await page.waitForSelector('#board .pitem[data-item="Board lead"][data-stage="applied"]', T);
      await jobs();
      await expectAll({ '#js-week-apps': '4', '#jw-apps': '4', '#fn-applied': '6' });
      await layout('jobs, after Work board adds');
    });
  } catch { /* recorded in problems */ }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-JOBS FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-JOBS PASSED');
