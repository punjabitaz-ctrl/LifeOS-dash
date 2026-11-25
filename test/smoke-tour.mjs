// First-run tour smoke (getting started guide): desktop and 390x844. A new vault's first Overview shows the tour; Next walks every
// step onto its real screen with one outlined part; the card never makes the page scroll sideways; Skip ends it, it does not start
// again after a reload and unlock, and Settings > Rerun getting started guide starts it from step 1. Fails on console errors and CSP
// violations. Run `node build.mjs` first. Needs Playwright (`npm i --no-save playwright`) and Chrome at /usr/bin/google-chrome.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { navTo } from './_nav.mjs';
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
const STEPS = 16;
const problems = [];

async function run(label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
  const count = async () => (await page.textContent('#tour-count')).trim();
  const noHScroll = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
  };
  try {
    await page.goto(pathToFileURL(file).href);
    await step('a new vault starts the tour on its first Overview', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")');
      await page.waitForSelector('#tour', T);
      if ((await count()) !== 'Getting started, 1 of ' + STEPS) throw new Error('count: ' + await count());
      if (!(await page.isDisabled('#tour-back'))) throw new Error('Back is on at step 1');
      const f = await page.evaluate(() => document.activeElement && document.activeElement.id);
      if (f !== 'tour-next') throw new Error('focus on ' + f);
      await noHScroll('step 1');
    });
    await step('Next walks every step onto its screen', async () => {
      for (let i = 2; i <= STEPS; i++) {
        await page.click('#tour-next');
        await page.waitForSelector('#tour-count:has-text("' + i + ' of ' + STEPS + '")', T);
        const marks = await page.locator('.tour-on').count();
        if (marks > 1) throw new Error('step ' + i + ' outlines ' + marks + ' parts');
        await noHScroll('step ' + i);
        // the card stays inside the window
        const box = await page.locator('#tour').boundingBox(), vp = page.viewportSize();
        if (!box || box.x < 0 || box.y < 0 || box.x + box.width > vp.width + 1 || box.y + box.height > vp.height + 1) throw new Error('step ' + i + ' card outside the window ' + JSON.stringify(box));
        const name = await page.getAttribute('#tour', 'data-tour');
        if (name === 'countries') await page.waitForSelector('#cn-assets', T);
        if (name === 'health') { await page.waitForSelector('#hl-eat.tour-on', T); }
        if (name === 'learning') await page.waitForSelector('h1:has-text("Learning")', T);
        if (name === 'sync') await page.waitForSelector('#sync-card.tour-on, #drive-card.tour-on', T);
        if (name === 'rerun') await page.waitForSelector('#guide-card.tour-on', T);
      }
      if ((await page.textContent('#tour-next')).trim() !== 'Finish') throw new Error('last button');
      await page.click('#tour-next');
      await page.waitForSelector('#tour', { state: 'detached', timeout: 10000 });
      await page.waitForSelector('h1:has-text("Overview")', T);
    });
    await step('it does not start again after a reload and unlock', async () => {
      await page.reload();
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")');
      await page.waitForSelector('h1:has-text("Overview")', T);
      await page.waitForTimeout(500);
      if (await page.locator('#tour').count()) throw new Error('tour started again');
    });
    await step('Settings reruns it from step 1; Skip and Escape end it', async () => {
      await navTo(page, 'Settings');
      await page.click('#settings-tour');
      await page.waitForSelector('#tour-count:has-text("1 of ' + STEPS + '")', T);
      await page.waitForSelector('h1:has-text("Overview")', T);
      await page.click('#tour-next'); await page.click('#tour-skip');
      await page.waitForSelector('#tour', { state: 'detached', timeout: 10000 });
      await navTo(page, 'Settings'); await page.click('#settings-tour');
      await page.waitForSelector('#tour', T);
      await page.keyboard.press('Escape');
      await page.waitForSelector('#tour', { state: 'detached', timeout: 10000 });
    });
    await step('the Getting started page starts it too, and locking ends it', async () => {
      await navTo(page, 'Settings'); await page.click('#settings-guide');
      await page.waitForSelector('#guide-view', T);
      await page.click('#guide-tour');
      await page.waitForSelector('#tour', T);
      await page.click('.lockbtn');
      await page.waitForSelector('#pass', T);
      if (await page.locator('#tour').count()) throw new Error('tour card left on the lock screen');
    });
  } catch (e) { /* recorded by step() */ } finally { await ctx.close(); }
}

await run('desktop', null);
await run('phone', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-TOUR FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-TOUR PASSED');
