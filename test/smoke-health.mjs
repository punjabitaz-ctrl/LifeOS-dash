// v0.5.0 Health + project delete smoke: desktop and 390x844. Fails on console errors, CSP violations, horizontal scroll.
// Run `node build.mjs` first. Needs Playwright (`npm i --no-save playwright`) and Chrome at /usr/bin/google-chrome.
import path from 'node:path';
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
const T = { timeout: 30000 };
const problems = [];
// Hand-computed expectations. The page clock is fixed at Thursday 2026-11-12, so the week is 2026-11-09 to 2026-11-15 (ISO week 46).
// Weights (lb): 10-01 200, 10-15 198, 10-29 196, 11-05 195, 11-12 194. Start 200, target 180.
//   latest 194; 7-entry average (200+198+196+195+194)/5 = 196.6; change per week over 28 days (from 10-15): (194-198)/28*7 = -1;
//   progress (200-194)/(200-180) = 30%; 194 is 14 above the target.
// Body fat: 10-01 25, 11-12 23. Start 25, target 18. latest 23, average 24, no 4-week rate (one point in the window), progress 2/7 = 28.6%.
// Cycle: start 11-02, 14-day sprints, 2 per cycle, 7 rest days, alternate heavy/light starting heavy. 11-12 is day 11 of sprint 1;
//   week index floor(10/7) = 1 so light; 28 training days minus 10 elapsed = rest starts in 18 days.
// Workouts this week: strength 45 (11-09), kettlebell 30 (11-10), strength 60 (11-11), cardio 20 (11-12): 4 sessions, 155 minutes,
//   strength 2 sessions 105 min. Target 4, so the tile reads "4 of 4" and "Target met". Cycle week 2 (11-09 is 7 days after the start).
// Sleep: 11-10 7, 11-11 8, 11-12 6 in the last 7 days -> 7 h over 3 nights; the 5 h on 11-02 is the previous 7 days -> +2 h.
// Daily checks: two habits, one ticked today: 1 of 7 days = 14.3%, 1-day streak; overall 1/14 = 7.1%.
const WANT = {
  cycle: 'Sprint 1 of 2, day 11 of 14, light week. Rest starts in 18 days.',
  weight: { latest: '194 lb', avg: '196.6 lb', rate: '-1 lb', progress: '30%', togo: '14 lb above target 180 lb.' },
  fat: { latest: '23 %', avg: '24 %', rate: 'n/a', progress: '28.6%' },
  week: { sessions: '4 of 4', minutes: '155', weeknum: '46', cycleweek: '2', strength: '2 sessions, 105 min' },
  sleep: { avg: '7 h', n: '3', delta: '+2 h' },
  habit: { row: '1 of 7 days (14.3%)', streak: '1-day streak', overall: '7-day completion: 7.1%' },
  tile: { value: '4 of 4', sub: 'Target met. Sprint 1 of 2, day 11 of 14, light week' },
};

async function run(label, viewport) {
  const mobile = !!viewport;
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n')[0]); throw e; } }
  const nav = (name) => page.click('.nav button:has-text("' + name + '")');
  const text = (sel) => page.textContent(sel).then((t) => t.trim());
  const expectText = async (sel, want) => { const got = await text(sel); if (got !== want) throw new Error(sel + ' is ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want)); };
  const layout = async (where) => {
    const r = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, iw: window.innerWidth,
      clipped: [...document.querySelectorAll('.nav button')].filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.textContent),
    }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
    if (r.clipped.length) throw new Error(where + ': nav labels clipped: ' + r.clipped.join(', '));
  };
  const openFold = async (id) => { if (!(await page.locator('#' + id).evaluate((el) => el.open))) await page.click('#' + id + ' > summary'); };
  const entries = () => page.locator('.entry').count();
  async function waitEntries(n) { await page.waitForFunction((k) => document.querySelectorAll('.entry').length === k, n, T); }
  let count = 0;

  async function checkHealth(where) {
    await nav('Health');
    await page.waitForSelector('#hl-today', T);
    await expectText('#hl-cycle', WANT.cycle);
    for (const [k, v] of Object.entries(WANT.weight)) await expectText('#hl-weight-' + k, v);
    for (const [k, v] of Object.entries(WANT.fat)) await expectText('#hl-fat-' + k, v);
    await expectText('#hl-sessions', WANT.week.sessions); await expectText('#hl-minutes', WANT.week.minutes);
    await expectText('#hl-weeknum', WANT.week.weeknum); await expectText('#hl-cycleweek', WANT.week.cycleweek);
    if (!(await text('.catrow[data-kind="strength"]')).includes(WANT.week.strength)) throw new Error('strength mix row: ' + await text('.catrow[data-kind="strength"]'));
    await expectText('#hl-sleep-avg', WANT.sleep.avg); await expectText('#hl-sleep-n', WANT.sleep.n); await expectText('#hl-sleep-delta', WANT.sleep.delta);
    await expectText('.habit[data-habit-row="Protein target"] .hb-rate', WANT.habit.row);
    await expectText('.habit[data-habit-row="Protein target"] .hb-streak', WANT.habit.streak);
    await expectText('#hl-habit-rate', WANT.habit.overall);
    if ((await page.getAttribute('#hl-habits [data-habit="Protein target"]', 'aria-pressed')) !== 'true') throw new Error('ticked habit not pressed');
    if ((await page.getAttribute('#hl-habits [data-habit="Mobility done"]', 'aria-pressed')) !== 'false') throw new Error('unticked habit pressed');
    for (const id of ['hl-weight-chart', 'hl-fat-chart', 'hl-sleep-chart']) if (!(await page.locator('#' + id).count())) throw new Error('chart missing: ' + id);
    await layout(where + ' health');
  }
  async function checkTile(where) {
    await nav('Home');
    await page.waitForSelector('.tile', T);
    await expectText('.tile[data-domain="health"] .tile-value', WANT.tile.value);
    if (!(await text('.tile[data-domain="health"]')).includes(WANT.tile.sub)) throw new Error('tile text: ' + await text('.tile[data-domain="health"]'));
    if ((await page.locator('.tile').count()) !== 10) throw new Error('expected 10 tiles');
    await layout(where + ' dashboard');
  }

  try {
    await page.clock.install({ time: new Date(2026, 10, 12, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('create vault', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")');
      await page.waitForSelector('.tile', T);
      await layout('dashboard');
    });
    await step('targets and cycle', async () => {
      await nav('Health');
      await page.waitForSelector('#hl-today', T);
      await layout('health empty');
      await openFold('hl-setup');
      await page.selectOption('#hs-units', 'lb');
      await page.fill('#hs-wstart', '200'); await page.fill('#hs-wtarget', '180');
      await page.fill('#hs-fstart', '25'); await page.fill('#hs-ftarget', '18'); await page.fill('#hs-wpw', '4');
      await page.click('#hs-save');
      await page.waitForSelector('.notice:has-text("Targets saved.")', T);
      await openFold('hl-setup');
      await page.fill('#cy-start', '2026-11-02'); await page.fill('#cy-sprint', '14'); await page.fill('#cy-count', '2'); await page.fill('#cy-rest', '7');
      await page.check('#cy-alt'); await page.selectOption('#cy-first', 'heavy');
      await page.click('#cy-save');
      await page.waitForSelector('.notice:has-text("Training cycle saved.")', T);
      await expectText('#hl-cycle', WANT.cycle);
      await layout('health cycle');
    });
    await step('log weights', async () => {
      for (const [d, w, f] of [['2026-10-01', '200', '25'], ['2026-10-15', '198', ''], ['2026-10-29', '196', ''], ['2026-11-05', '195', ''], ['2026-11-12', '194', '23']]) {
        await openFold('hl-q-body');
        await page.fill('#qb-date', d); await page.fill('#qb-weight', w); await page.fill('#qb-fat', f);
        await page.click('#qb-add');
        count += f ? 2 : 1;
        await waitEntries(count);
      }
    });
    await step('log workouts', async () => {
      for (const [d, kind, min, eff] of [['2026-11-09', 'strength', '45', '8'], ['2026-11-10', 'kettlebell', '30', ''], ['2026-11-11', 'strength', '60', '6'], ['2026-11-12', 'cardio', '20', '']]) {
        await openFold('hl-q-workout');
        await page.selectOption('#qw-kind', kind); await page.fill('#qw-min', min); await page.selectOption('#qw-effort', eff); await page.fill('#qw-date', d);
        await page.click('#qw-add');
        await waitEntries(++count);
      }
    });
    await step('log sleep', async () => {
      for (const [d, h] of [['2026-11-02', '5'], ['2026-11-10', '7'], ['2026-11-11', '8'], ['2026-11-12', '6']]) {
        await openFold('hl-q-sleep');
        await page.fill('#qs-date', d); await page.fill('#qs-hours', h);
        await page.click('#qs-add');
        await waitEntries(++count);
      }
    });
    await step('daily checks', async () => {
      for (const n of ['Protein target', 'Mobility done']) {
        await page.fill('#hb-name', n); await page.click('#hb-add');
        await page.waitForSelector('.habit[data-habit-row="' + n + '"]', T);
      }
      await page.click('#hl-habits [data-habit="Protein target"]');
      await page.waitForSelector('#hl-habits [data-habit="Protein target"][aria-pressed="true"]', T);
    });
    await step('health view values', () => checkHealth('after logging'));
    await step('dashboard tile', () => checkTile('after logging'));
    await step('audit log holds no body data', async () => {
      await nav('Settings');
      await page.waitForSelector('#app-version', T);
      const t = await text('main');
      if (!/entry add/.test(t)) throw new Error('activity not listed');
      for (const secret of ['194', '196.6', 'Protein', 'Mobility', 'strength']) if (t.includes(secret)) throw new Error('settings page shows ' + secret);
      await layout('settings');
    });
    await step('project delete keeps the linked outcome', async () => {
      await nav('Work');
      await page.waitForSelector('#wk-done', T);
      await openFold('pj-new');
      await page.fill('#pj-name', 'Doomed'); await page.click('#pj-add');
      await page.waitForSelector('.proj[data-project="Doomed"]', T);
      await page.fill('#oc-title', 'Keep me'); await page.selectOption('#oc-proj', { label: 'Doomed' }); await page.click('#oc-add');
      await page.waitForSelector('.outcome[data-outcome="Keep me"] .chip:has-text("Doomed")', T);
      await page.click('.proj[data-project="Doomed"] button:has-text("Delete")');
      await page.waitForSelector('.dialog #pj-del-info', T);
      await expectText('#pj-del-info', '1 linked outcome is kept and unlinked from this project. The project itself is removed.');
      await layout('delete dialog');
      await page.click('.dialog button:has-text("Delete project")');
      await page.waitForSelector('.notice:has-text("Project deleted.")', T);
      if (await page.locator('.proj[data-project="Doomed"]').count()) throw new Error('project still listed');
      await page.waitForSelector('.outcome[data-outcome="Keep me"]', T);
      if (await page.locator('.outcome[data-outcome="Keep me"] .chip').count()) throw new Error('outcome still shows a project');
      await expectText('#wk-done', '0 of 1');
      await layout('work after delete');
    });
    await step('lock and unlock', async () => {
      await page.click('.top .lockbtn');
      await page.waitForSelector('#pass', T);
      if (await page.locator('.tile').count()) throw new Error('data visible while locked');
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")');
      await page.waitForSelector('.tile', T);
      await checkTile('after unlock');
      await checkHealth('after unlock');
    });
    await step('persistence after reload', async () => {
      await page.reload();
      await page.waitForSelector('#pass', T);
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")');
      await page.waitForSelector('.tile', T);
      await checkTile('after reload');
      await checkHealth('after reload');
      await nav('Work');
      await page.waitForSelector('.outcome[data-outcome="Keep me"]', T);
      if (await page.locator('.proj[data-project="Doomed"]').count()) throw new Error('deleted project came back');
    });
    // SEC-33/34: switching units with the form otherwise untouched converts the targets too, and switching back restores every value.
    await step('unit switch round trip', async () => {
      await nav('Health');
      await page.waitForSelector('#hl-today', T);
      await openFold('hl-setup');
      await page.selectOption('#hs-units', 'kg');
      await page.click('#hs-save');
      await page.waitForSelector('.notice:has-text("Targets saved.")', T);
      await expectText('#hl-weight-latest', '88 kg');
      await expectText('#hl-weight-togo', '6.4 kg above target 81.6 kg.');
      await expectText('#hl-weight-progress', '30%');
      if ((await page.inputValue('#hs-wtarget')) !== '81.6') throw new Error('target input shows ' + await page.inputValue('#hs-wtarget'));
      await layout('health kg');
      for (let i = 0; i < 3; i++) {
        for (const u of ['lb', 'kg']) {
          await openFold('hl-setup');
          await page.selectOption('#hs-units', u);
          await page.click('#hs-save');
          await page.waitForFunction((x) => document.querySelector('#hl-weight-latest') && document.querySelector('#hl-weight-latest').textContent.trim().endsWith(x), u, T);
        }
      }
      await openFold('hl-setup');
      await page.selectOption('#hs-units', 'lb');
      await page.click('#hs-save');
      await page.waitForFunction(() => /lb$/.test(document.querySelector('#hl-weight-latest').textContent.trim()), null, T);
      await checkHealth('after unit round trips');
    });
  } catch { /* recorded in problems */ }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-HEALTH FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-HEALTH PASSED');
