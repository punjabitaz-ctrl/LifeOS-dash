// v2.1.0 Eating smoke: desktop and 390x844. Fails on console errors, CSP violations, horizontal scroll, or any figure that differs from
// the hand-computed one. Run `node build.mjs` first. Needs Playwright (`npm i --no-save playwright`) and Chrome at /usr/bin/google-chrome.
import path from 'node:path';
import { navTo } from './_nav.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { skipTour } from './_tour.mjs';
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
// Hand-computed. The page clock is Thursday 2026-11-12, so the week is 2026-11-09 to 2026-11-15.
// Saved meals: EGGS 24 g (breakfast), BOWL 45 g (lunch; its name holds markup that must stay text). Target 100 g.
// 11-12: EGGS 24 + BOWL 45 + one-off 20 = 89 g, 3 meals; EGGS yes, BOWL no.
// 11-10: BOWL 45 + BOWL 45 + EGGS 24 = 114 g, 3 meals; the first BOWL yes.
// Week: two logged days, (89 + 114) / 2 = 101.5, shown rounded as 102 g; 1 of 7 days at or over 100; 6 meals; 2 yes of 3 answered = 66.7%.
// Editing EGGS to 30 g leaves both days as they were; deleting EGGS leaves its rows as "Removed meal" with their protein.
const EGGS = '3 eggs and toast', BOWL = 'Chicken bowl <b>x</b> & "rice"';
const WANT = {
  empty: { avg: 'no data', days: 'Set a target', meals: '0', fh: 'no data' },
  today: '89 g protein of 100 g, 3 meals today',
  other: '114 g protein of 100 g, 3 meals on 2026-11-10',
  week: { avg: '102 g', days: '1 of 7', meals: '6', fh: '66.7% of 3 answered' },
};

async function run(label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage(); await skipTour(page);
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  page.on('dialog', (d) => { problems.push(label + ' unexpected native dialog: ' + d.type()); d.dismiss(); });
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n')[0]); throw e; } }
  const text = (sel) => page.textContent(sel).then((t) => t.trim());
  const expectText = async (sel, want) => { await page.waitForFunction(([s, w]) => { const el = document.querySelector(s); return el && el.textContent.trim() === w; }, [sel, want], { timeout: 10000 }).catch(async () => { throw new Error(sel + ' is ' + JSON.stringify(await text(sel).catch(() => null)) + ', expected ' + JSON.stringify(want)); }); };
  const layout = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
  };
  const openFold = async (id) => { if (!(await page.locator('#' + id).evaluate((el) => el.open))) await page.click('#' + id + ' > summary'); };
  const rows = () => page.locator('#eat-rows .eat-row').count();
  const waitRows = (n) => page.waitForFunction((k) => document.querySelectorAll('#eat-rows .eat-row').length === k, n, T);
  const tap = (name) => page.locator('.eat-log').filter({ hasText: name + ' (' }).first().click();
  const row = (name, i) => page.locator('.eat-row').filter({ has: page.locator('.entry-t', { hasText: name }) }).nth(i || 0);

  try {
    await page.clock.install({ time: new Date(2026, 10, 12, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('create vault', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")');
      await page.waitForSelector('.tile', T);
    });
    await step('empty eating', async () => {
      await navTo(page, 'Health');
      await page.waitForSelector('#hl-eat', T);
      await page.waitForSelector('#eat-no-meals', T); await page.waitForSelector('#eat-no-target', T); await page.waitForSelector('#eat-none', T);
      for (const [k, v] of Object.entries(WANT.empty)) await expectText('#eat-' + k, v);
      // the Eating card comes right after Today
      const order = await page.evaluate(() => [...document.querySelectorAll('.card[id]')].map((c) => c.id));
      if (order.indexOf('hl-eat') !== order.indexOf('hl-today') + 1) throw new Error('Eating is not right after Today: ' + order.join(','));
      await layout('eating empty');
    });
    await step('saved meals and target', async () => {
      // a bad protein number is refused with a plain message and nothing is saved
      await openFold('hl-meals');
      await page.fill('#ml-name', EGGS); await page.fill('#ml-protein', '2.5'); await page.click('#ml-add');
      await page.waitForSelector('.notice:has-text("Protein (g) must be a whole number from 0 to 300.")', T);
      if (await page.locator('.meal').count()) throw new Error('a meal was saved with a bad number');
      for (const [n, p, s] of [[EGGS, '24', 'breakfast'], [BOWL, '45', 'lunch']]) {
        await openFold('hl-meals');
        await page.fill('#ml-name', n); await page.fill('#ml-protein', p); await page.selectOption('#ml-slot', s);
        await page.click('#ml-add');
        await page.waitForSelector('.notice:has-text("Meal saved.")', T);
      }
      await page.waitForFunction(() => document.querySelectorAll('.meal').length === 2, null, T);
      if (await page.locator('#hl-eat b').count()) throw new Error('markup in a meal name was rendered as HTML');
      const groups = await page.locator('.eat-slot h3').allTextContents();
      if (groups.join('|') !== 'Breakfast|Lunch') throw new Error('slot groups: ' + groups.join('|'));
      await openFold('hl-meals');
      await page.fill('#eat-target', '100'); await page.click('#eat-target-save');
      await page.waitForSelector('.notice:has-text("Target saved.")', T);
      await expectText('#eat-days', '0 of 7');
      if (await page.locator('#eat-no-target').count()) throw new Error('the no-target line stayed');
    });
    await step('log today', async () => {
      await tap(EGGS); await waitRows(1);
      await tap(BOWL); await waitRows(2);
      await page.fill('#eat-one-p', '20'); await page.click('#eat-one-add'); await waitRows(3);
      await expectText('#eat-total', WANT.today);
      if (!(await page.locator('.eat-row .entry-t', { hasText: 'One-off' }).count())) throw new Error('one-off row missing');
      await row(EGGS).locator('.eat-yes').click();
      await page.waitForFunction(() => [...document.querySelectorAll('.eat-yes[aria-pressed="true"]')].length === 1, null, T);
      await row(BOWL).locator('.eat-no').click();
      await page.waitForFunction(() => [...document.querySelectorAll('.eat-no[aria-pressed="true"]')].length === 1, null, T);
      await layout('eating today');
    });
    await step('log another day', async () => {
      await page.fill('#eat-day', '2026-11-10');
      await page.waitForSelector('#eat-none', T);
      await tap(BOWL); await waitRows(1); await tap(BOWL); await waitRows(2); await tap(EGGS); await waitRows(3);
      await expectText('#eat-total', WANT.other);
      await row(BOWL, 0).locator('.eat-yes').click();
      await page.waitForFunction(() => [...document.querySelectorAll('.eat-yes[aria-pressed="true"]')].length === 1, null, T);
      for (const [k, v] of Object.entries(WANT.week)) await expectText('#eat-' + k, v);
      if ((await page.locator('#hl-eat-week .eat-day').count()) !== 7) throw new Error('the week does not list 7 days');
    });
    await step('a mistaken row is removed', async () => {
      await page.fill('#eat-one-p', '50'); await page.click('#eat-one-add'); await waitRows(4);
      await row('One-off').getByRole('button', { name: 'Remove One-off' }).click();
      await waitRows(3);
      await expectText('#eat-total', WANT.other);
    });
    await step('edit and delete a saved meal keep past days', async () => {
      await openFold('hl-meals');
      await page.click('[aria-label="Edit meal ' + EGGS + '"]');
      await page.fill('#me-protein', '30');
      await page.click('.dialog button:has-text("Save")');
      await page.waitForSelector('.notice:has-text("Meal saved.")', T);
      await expectText('#eat-total', WANT.other);
      await openFold('hl-meals');
      await page.click('[aria-label="Edit meal ' + EGGS + '"]');
      await page.click('#me-del');
      await page.click('.dialog button:has-text("Delete")');
      await page.waitForSelector('.notice:has-text("Meal deleted.")', T);
      await expectText('#eat-total', WANT.other);
      if (!(await page.locator('.eat-row .entry-t', { hasText: 'Removed meal' }).count())) throw new Error('the deleted meal row does not read Removed meal');
      for (const [k, v] of Object.entries(WANT.week)) await expectText('#eat-' + k, v);
      if (await page.locator('.eat-log', { hasText: EGGS }).count()) throw new Error('the deleted meal still has a log button');
      await layout('eating after delete');
    });
    await step('today again, and the state survives a lock', async () => {
      await page.fill('#eat-day', '2026-11-12');
      await expectText('#eat-total', WANT.today);
      await page.evaluate(() => globalThis.LifeOS.store.lock());
      await page.reload();
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")');
      await page.waitForSelector('.tile', T);
      await navTo(page, 'Health');
      await expectText('#eat-total', WANT.today);
      for (const [k, v] of Object.entries(WANT.week)) await expectText('#eat-' + k, v);
      const raw = await page.evaluate(() => JSON.stringify(globalThis.LifeOS.metrics.weeklyDigest(globalThis.LifeOS.store.getState(), '2026-11-09').food));
      if (raw !== JSON.stringify({ meals: 6, proteinAvg: 102, proteinDays: 1, forHealthRate: 66.7 })) throw new Error('digest food: ' + raw);
      if (await page.evaluate(() => (document.cookie || '') + JSON.stringify(localStorage) + JSON.stringify(sessionStorage) + location.href).then((s) => /eggs|Chicken/.test(s))) throw new Error('a meal name left the vault');
      await layout('eating reload');
    });
  } catch (e) { /* recorded in problems */ }
  await ctx.close();
}

await run('desktop');
await run('phone', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('FAIL\n' + problems.join('\n')); process.exit(1); }
console.log('smoke-eat ok: desktop and 390x844');
