// v2.3.0 Overview smoke: desktop and 390x844, light and dark. The Overview opens with the default key numbers and shortcuts; a tap on
// either opens its area; the picker adds, removes and orders key numbers, hides a card and pins a shortcut; choices survive a reload;
// Back to the defaults restores them. Fails on console errors, CSP violations, horizontal scroll.
// Run `node build.mjs` first. Needs Playwright (`npm i --no-save playwright`) and Chrome at /usr/bin/google-chrome.
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
const DEFAULT_K = ['money', 'assets', 'rev-month', 'work', 'health', 'learning', 'goals', 'upcoming'];
const DEFAULT_S = ['v:money', 'v:work', 'v:jobs', 'v:health', 'v:learning', 'v:goals', 'review'];

async function run(label, viewport, scheme) {
  const ctx = await browser.newContext(Object.assign({ colorScheme: scheme }, viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }));
  const page = await ctx.newPage(); await skipTour(page);
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
  const poll = async (get, good, what) => {
    let got;
    for (let i = 0; i < 80; i++) { try { got = await get(); if (good(got)) return got; } catch (e) { got = String(e.message).split('\n')[0]; } await page.waitForTimeout(100); }
    throw new Error(what + ' is ' + JSON.stringify(got));
  };
  const kpis = () => page.$$eval('#ov-kpis .kpi', (els) => els.map((e) => e.getAttribute('data-kpi')));
  const shorts = () => page.$$eval('#ov-shortcuts .shortcut', (els) => els.map((e) => e.getAttribute('data-key')));
  const expectList = (get, want, what) => poll(get, (g) => g.join() === want.join(), what + ' (expected ' + want.join() + ')');
  const noHScroll = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
  };
  const home = async () => { await navTo(page, 'Overview'); await page.waitForSelector('#ov-kpis', T); };
  const unlock = async () => { await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('#ov-kpis', T); };
  const ok = (msg) => page.waitForSelector('.notice:has-text("' + msg + '")', T);

  try {
    await page.clock.install({ time: new Date(2026, 10, 25, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('a new vault opens on the Overview with the default key numbers and shortcuts', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")');
      await page.waitForSelector('#ov-kpis', T);
      if ((await page.textContent('h1')).trim() !== 'Overview') throw new Error('heading: ' + await page.textContent('h1'));
      await expectList(kpis, DEFAULT_K, 'key numbers');
      await expectList(shorts, DEFAULT_S, 'shortcuts');
      const v = (await page.textContent('#ov-kpis .kpi[data-kpi="assets"] .kpi-value')).trim();
      if (v !== '$0') throw new Error('empty net worth shows ' + v);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      if ((scheme === 'dark') !== /rgb\(11, 16, 32\)/.test(bg)) throw new Error(scheme + ' background is ' + bg);
      await noHScroll('overview');
    });
    await step('a key number and a shortcut each open their area', async () => {
      await page.click('#ov-kpis .kpi[data-kpi="learning"]'); await page.waitForSelector('#ln-active', T);
      await home();
      await page.click('#ov-shortcuts .shortcut[data-key="v:jobs"]');
      await poll(() => page.textContent('h1'), (g) => /Job/.test(g), 'heading after the Job search shortcut');
      await home();
    });
    await step('the picker adds, removes and orders key numbers, hides a card and pins a shortcut', async () => {
      await page.click('#ov-pick'); await page.waitForSelector('.dialog #ovp-kpis', T);
      await page.uncheck('#ovp-k-assets');
      await page.check('#ovp-k-streak');
      await page.click('#ovp-kpis [data-up="streak"]'); await page.click('#ovp-kpis [data-up="streak"]');
      await page.uncheck('#ovp-c-glance');
      await page.click('.dialog details:has(#ovp-shortcuts) > summary');
      await page.check('#ovp-s-settings');
      await noHScroll('picker');
      await page.click('.dialog button:has-text("Save")'); await ok('Overview saved.');
      await page.waitForSelector('.dialog', { state: 'detached', timeout: 30000 });
      const want = ['money', 'rev-month', 'work', 'health', 'learning', 'streak', 'goals', 'upcoming'];
      await expectList(kpis, want, 'key numbers after the picker');
      await expectList(shorts, DEFAULT_S.concat('settings'), 'shortcuts after the picker');
      if (await page.locator('.mod[data-mod="glance"]').count()) throw new Error('the hidden card still shows');
      await page.reload(); await unlock();
      await expectList(kpis, want, 'key numbers after a reload');
      await expectList(shorts, DEFAULT_S.concat('settings'), 'shortcuts after a reload');
      await noHScroll('overview after choices');
    });
    await step('Edit on the strip opens the same picker; Back to the defaults restores everything', async () => {
      await page.click('#ov-kpis-edit'); await page.waitForSelector('.dialog #ovp-defaults', T);
      await page.click('#ovp-defaults');
      await page.click('.dialog button:has-text("Save")'); await ok('Overview saved.');
      await page.waitForSelector('.dialog', { state: 'detached', timeout: 30000 });
      await expectList(kpis, DEFAULT_K, 'key numbers after the defaults');
      await expectList(shorts, DEFAULT_S, 'shortcuts after the defaults');
      await page.waitForSelector('.mod[data-mod="glance"]', T);
    });
  } catch { /* recorded in problems */ }
  await ctx.close();
}

await run('desktop light', null, 'light');
await run('mobile dark', { width: 390, height: 844 }, 'dark');
await browser.close();
if (problems.length) { console.log('SMOKE-OVERVIEW FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-OVERVIEW PASSED');
