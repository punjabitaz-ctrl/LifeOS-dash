// v0.6.0 Goals smoke: desktop and 390x844. Fails on console errors, CSP violations, horizontal scroll.
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
// Hand-computed expectations (checked with an independent day count, not with the app). The page clock is Thursday 2026-11-12;
// its week is 2026-11-09 to 2026-11-15.
// Accounts: Checking 6000 + Savings 4000 - Card 1000 owed = net worth 9000.
// A  "Grow net worth": 5 year, start 5000 target 25000, 2026-05-12 to 2031-05-12 (1826 days, 184 elapsed = 10.1%).
//    progress (9000-5000)/20000 = 20%; 20 - 10.08 = +9.9 points, inside the 10 point tolerance, so on track.
// B  "Save 10k this year": annual, child of A, manual 0 to 10000, now 4000 = 40%; 2026-01-01 to 2026-12-31 (364 days, 315 elapsed = 86.5%): behind.
// C  "Train four times": weekly, workouts per week 0 to 4, 2026-11-09 to 2026-11-15; three workouts this week = 75%; 3 of 6 days = 50%: ahead.
// D  "Read 12 books": annual manual 0 to 12 on the same dates as B; typed 4 (33.3%, behind), then 10 = 83.3% against 86.5%: on track.
// Tile with all four: 3 of 4 on track or ahead = 75%, 1 behind, next due 2026-11-15 (C).
// After deleting A: B survives unlinked; 3 active, B behind, C ahead, D on track = 2 of 3 = 67%, still 1 behind, next due 2026-11-15.
// Review: C is due this week (1) and unfinished (offer to roll, 1); no pace changes (C started this week; B and D stay in their bands).
// After rolling C into the next period: 2026-11-16 to 2026-11-22; 0% elapsed so still ahead; the tile's next due is 2026-11-22.
const WANT = {
  A: { progress: '20%', pace: 'On track: 20% done, 10.1% of the time elapsed', now: 'Start $5,000, now $9,000, target $25,000. 2026-05-12 to 2031-05-12.', status: 'On track' },
  B: { progress: '40%', pace: 'Behind: 40% done, 86.5% of the time elapsed', status: 'Behind' },
  C: { progress: '75%', pace: 'Ahead: 75% done, 50% of the time elapsed', status: 'Ahead' },
  D0: { progress: '33.3%', pace: 'Behind: 33.3% done, 86.5% of the time elapsed' },
  D: { progress: '83.3%', pace: 'On track: 83.3% done, 86.5% of the time elapsed' },
  tile: { value: '75%', sub: '1 behind, next due 2026-11-15' },
  tile2: { value: '67%', sub: '1 behind, next due 2026-11-15' },
  tile3: { value: '67%', sub: '1 behind, next due 2026-11-22' },
};

async function run(label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
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
  const G = (title) => '.goal[data-goal="' + title + '"]';
  const goalIs = async (title, w) => {
    await page.waitForSelector(G(title), T);
    await expectText(G(title) + ' .g-progress', w.progress); await expectText(G(title) + ' .g-pace', w.pace);
    if (w.now) await expectText(G(title) + ' .g-now', w.now);
    if (w.status) await expectText(G(title) + ' .g-status', w.status);
  };
  async function addGoal(f) {
    await page.waitForSelector('#goal-add', T);
    await openFold('goal-add');
    await page.fill('#g-title', f.title); await page.selectOption('#g-horizon', f.horizon); await page.selectOption('#g-metric', f.metric);
    if (f.dir) await page.selectOption('#g-dir', f.dir);
    if (f.parent) await page.selectOption('#g-parent', { label: f.parent });
    if (f.start !== undefined) await page.fill('#g-start', f.start);
    await page.fill('#g-target', f.target); await page.fill('#g-sdate', f.sdate);
    if (f.due) await page.fill('#g-due', f.due);
    if (f.cur !== undefined) await page.fill('#g-cur', f.cur);
    await page.click('#g-add');
    await page.waitForSelector('.notice:has-text("Goal added.")', T);
    await page.waitForSelector(G(f.title), T);
  }
  async function checkTile(where, want) {
    await nav('Home');
    await page.waitForSelector('.tile', T);
    await expectText('.tile[data-domain="goals"] .tile-value', want.value);
    const t = await text('.tile[data-domain="goals"]');
    if (!t.includes(want.sub)) throw new Error(where + ' goals tile: ' + t);
    if ((await page.locator('.tile').count()) !== 11) throw new Error('expected 11 tiles');
    await layout(where + ' dashboard');
  }
  const openGoals = async () => { await nav('Home'); await page.click('.tile[data-domain="goals"]'); await page.waitForSelector('#goal-ladder', T); };

  try {
    await page.clock.install({ time: new Date(2026, 10, 12, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('create vault', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")');
      await page.waitForSelector('.tile', T);
      await layout('dashboard');
    });
    await step('empty goals view and tile', async () => {
      await page.click('.tile[data-domain="goals"]');
      await page.waitForSelector('#goal-ladder', T);
      await expectText('#gl-active', '0'); await expectText('#gl-share', 'n/a');
      await layout('goals empty');
    });
    await step('account balances', async () => {
      await nav('Assets');
      await page.waitForSelector('#ac-name', T);
      for (const [name, kind, bal] of [['Checking', 'cash', '6000'], ['Savings', 'cash', '4000'], ['Card', 'credit', '1000']]) {
        await page.fill('#ac-name', name); await page.selectOption('#ac-kind', kind); await page.fill('#ac-bal', bal);
        await page.click('#ac-add');
        await page.waitForSelector('.acct[data-account="' + name + '"]', T);
      }
      await expectText('#aw-net', '$9,000.00');
    });
    await step('three workouts this week', async () => {
      await nav('Health');
      await page.waitForSelector('#hl-today', T);
      let n = 0;
      for (const d of ['2026-11-09', '2026-11-10', '2026-11-11']) {
        await openFold('hl-q-workout');
        await page.fill('#qw-date', d); await page.click('#qw-add');
        // The screen re-renders after each save; wait for the new count before touching the form again.
        await page.waitForFunction((k) => document.querySelector('#hl-sessions') && document.querySelector('#hl-sessions').textContent.trim() === k + ' of 4', ++n, T);
      }
      await expectText('#hl-sessions', '3 of 4');
    });
    await step('net worth goal (5 years)', async () => {
      await openGoals();
      await addGoal({ title: 'Grow net worth', horizon: '5y', metric: 'netWorth', start: '5000', target: '25000', sdate: '2026-05-12' });
      await goalIs('Grow net worth', WANT.A);
      await layout('goals one');
    });
    await step('child annual goal', async () => {
      await addGoal({ title: 'Save 10k this year', horizon: 'annual', metric: 'manual', parent: 'Grow net worth (5 year)', start: '0', target: '10000', sdate: '2026-01-01', due: '2026-12-31', cur: '4000' });
      await goalIs('Save 10k this year', WANT.B);
      await page.waitForSelector('#goal-ladder .gkids ' + G('Save 10k this year'), T);
      await layout('goals ladder');
    });
    await step('weekly workouts goal', async () => {
      await addGoal({ title: 'Train four times', horizon: 'weekly', metric: 'workoutsPerWeek', start: '0', target: '4', sdate: '2026-11-09' });
      await goalIs('Train four times', WANT.C);
      await page.waitForSelector('#goal-unlinked ' + G('Train four times'), T);
    });
    await step('manual goal, then update its value', async () => {
      await addGoal({ title: 'Read 12 books', horizon: 'annual', metric: 'manual', start: '0', target: '12', sdate: '2026-01-01', due: '2026-12-31', cur: '4' });
      await goalIs('Read 12 books', WANT.D0);
      await page.fill(G('Read 12 books') + ' .g-manual', '10');
      await page.click(G('Read 12 books') + ' .g-setval');
      await page.waitForSelector('.notice:has-text("Value updated.")', T);
      await goalIs('Read 12 books', WANT.D);
      await expectText('#gl-active', '4');
      await layout('goals four');
    });
    await step('nothing is achieved or dropped by itself', async () => {
      for (const t of ['Grow net worth', 'Save 10k this year', 'Train four times', 'Read 12 books']) {
        if ((await page.getAttribute(G(t), 'data-state')) !== 'active') throw new Error(t + ' is not active');
      }
      if (await page.locator('.g-reached').count()) throw new Error('no goal has reached its target');
    });
    await step('dashboard tile', () => checkTile('four goals', WANT.tile));
    await step('delete the parent; the child survives unlinked', async () => {
      await openGoals();
      await page.click(G('Grow net worth') + ' .g-delete');
      await page.waitForSelector('.dialog #goal-del-info', T);
      await expectText('#goal-del-info', '1 child goal is kept and unlinked from this goal. The goal itself is removed.');
      await layout('goal delete dialog');
      await page.click('.dialog button:has-text("Delete goal")');
      await page.waitForSelector('.notice:has-text("Goal deleted.")', T);
      if (await page.locator(G('Grow net worth')).count()) throw new Error('parent still listed');
      await page.waitForSelector('#goal-unlinked ' + G('Save 10k this year'), T);
      await goalIs('Save 10k this year', WANT.B);
      if (await page.locator('#goal-ladder .gkids').count()) throw new Error('ladder still shows a child');
      await expectText('#gl-active', '3');
      await layout('goals after delete');
    });
    await step('dashboard tile after delete', () => checkTile('after delete', WANT.tile2));
    await step('weekly review goals step', async () => {
      await nav('Review');
      await page.waitForSelector('#rv-goals', T);
      await expectText('#rv-goals-due-h', 'Due this week (1)');
      await expectText('#rv-goals-changes-h', 'Pace changes since last week (0)');
      await expectText('#rv-goals-roll-h', 'Unfinished weekly and monthly goals (1)');
      if (!(await text('#rv-goals .rv-roll')).includes('Train four times')) throw new Error('roll offer missing');
      await layout('review goals');
      // Nothing is rolled until the tap.
      await openGoals();
      await expectText(G('Train four times') + ' .g-now', 'Start 0, now 3, target 4. 2026-11-09 to 2026-11-15.');
      await nav('Review');
      await page.waitForSelector('#rv-goals', T);
      await page.click('#rv-goals .rv-roll-btn');
      await page.waitForSelector('.notice:has-text("Goal moved into its next period.")', T);
      await page.waitForSelector('#rv-goals-due-h:has-text("Due this week (0)")', T);
      if (await page.locator('#rv-goals-roll-h').count()) throw new Error('roll offer still shown');
      for (let i = 1; i <= 3; i++) await page.fill('#prio' + i, 'Priority ' + i);
      await page.click('#finish-review');
      await page.waitForSelector('.notice:has-text("Review finished.")', T);
    });
    await step('rolled goal and tile', async () => {
      await openGoals();
      await expectText(G('Train four times') + ' .g-now', 'Start 0, now 3, target 4. 2026-11-16 to 2026-11-22.');
      await expectText(G('Train four times') + ' .g-pace', 'Ahead: 75% done, 0% of the time elapsed');
      await checkTile('after roll', WANT.tile3);
    });
    await step('achieving is a user tap', async () => {
      await openGoals();
      await page.click(G('Read 12 books') + ' .g-achieve');
      await page.waitForSelector('.notice:has-text("Goal marked achieved.")', T);
      await openFold('goal-closed');
      await page.waitForSelector('#goal-closed ' + G('Read 12 books') + '[data-state="achieved"]', T);
      await expectText('#gl-active', '2');
      await page.click('#goal-closed ' + G('Read 12 books') + ' .g-reopen');
      await page.waitForSelector('#goal-unlinked ' + G('Read 12 books') + '[data-state="active"]', T);
      await expectText('#gl-active', '3');
    });
    const final = async (where) => {
      await openGoals();
      await goalIs('Save 10k this year', WANT.B);
      await goalIs('Read 12 books', WANT.D);
      await expectText(G('Train four times') + ' .g-now', 'Start 0, now 3, target 4. 2026-11-16 to 2026-11-22.');
      if (await page.locator(G('Grow net worth')).count()) throw new Error('deleted goal came back');
      await expectText('#gl-active', '3');
      await checkTile(where, WANT.tile3);
    };
    await step('lock and unlock', async () => {
      await page.click('.top .lockbtn');
      await page.waitForSelector('#pass', T);
      if (await page.locator('.tile').count()) throw new Error('data visible while locked');
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")');
      await page.waitForSelector('.tile', T);
      await final('after unlock');
    });
    await step('persistence after reload', async () => {
      await page.reload();
      await page.waitForSelector('#pass', T);
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")');
      await page.waitForSelector('.tile', T);
      await final('after reload');
    });
    await step('settings: version and audit log hold no goal text', async () => {
      await nav('Settings');
      await page.waitForSelector('#app-version', T);
      await expectText('#app-version', 'LifeOS v0.10.0');
      const t = await text('main');
      for (const secret of ['Grow net worth', 'Save 10k', 'Train four', 'Read 12']) if (t.includes(secret)) throw new Error('settings page shows ' + secret);
      await layout('settings');
    });
  } catch { /* recorded in problems */ }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-GOALS FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-GOALS PASSED');
