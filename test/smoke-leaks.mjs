// v0.9.0 audit: end-to-end leak smoke across the whole app (desktop and 390x844). A vault with an adversarial marker in every
// free-text field of every domain (test/_adversarial.mjs) is loaded, every screen is opened, the weekly review and both consolidation
// prompts are built in copy/paste mode, an error is provoked, and the app is locked and unlocked. Then no marker may appear in any AI
// prompt, the audit log, an error notice, console output, the URL, sessionStorage, localStorage, cookies or the bytes in IndexedDB,
// and no network request may be made. Run `node build.mjs` first. Needs Playwright and Chrome at /usr/bin/google-chrome.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildAdversarial, ADV_MARK } from './_adversarial.mjs';
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
const SRC = '(' + buildAdversarial.toString() + ')(globalThis.LifeOS)';

async function run(label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const consoleText = [], requests = [], urls = [];
  page.on('console', (m) => { consoleText.push(m.text()); if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => { consoleText.push(e.message); problems.push(label + ' pageerror: ' + e.message); });
  page.on('request', (r) => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) requests.push(r.url()); });
  page.on('framenavigated', (f) => urls.push(f.url()));
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
  const nav = (name) => page.click('.nav button:has-text("' + name + '")');
  const seen = [];
  const grab = async (where) => { seen.push({ where, url: page.url(), s: await page.evaluate(() => JSON.stringify([location.href, document.cookie, Object.assign({}, sessionStorage), Object.assign({}, localStorage)])) }); };
  const prompts = [];
  try {
    await page.clock.install({ time: new Date(2026, 10, 14, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('create vault and load the adversarial vault', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")');
      await page.waitForSelector('.tile', T);
      const n = await page.evaluate('(async () => { const r = ' + SRC + '; await globalThis.LifeOS.store.replaceState(r.state); return r.count; })()');
      if (n < 60) throw new Error('only ' + n + ' markers');
      await nav('Settings'); await nav('Home'); await page.waitForSelector('.tile', T);
      const body = await page.textContent('main');
      if (!body.includes(ADV_MARK)) throw new Error('markers not shown on the dashboard, so the check would prove nothing');
      await grab('dashboard');
    });
    await step('open every domain screen', async () => {
      const ids = await page.$$eval('.tile', (t) => t.map((x) => x.getAttribute('data-domain')));
      if (ids.length !== 11) throw new Error('tiles ' + ids.length);
      for (const id of ids) {
        await nav('Home'); await page.waitForSelector('.tile', T);
        await page.click('.tile[data-domain="' + id + '"]');
        await page.waitForSelector('h1', T);
        await page.waitForTimeout(50);
        await grab(id);
      }
      for (const n of ['Money', 'Assets', 'Work', 'Health']) { await nav(n); await page.waitForTimeout(50); await grab(n); }
    });
    await step('weekly review prompt (copy/paste mode) holds numbers only', async () => {
      await nav('Review'); await page.waitForSelector('h1:has-text("Weekly review")', T);
      await page.click('button:has-text("Suggest with AI")');
      await page.waitForSelector('#ai-prompt', T);
      const p = await page.$eval('#ai-prompt', (t) => t.value);
      if (!/activities detail/.test(p) || !/learning|money/.test(p)) throw new Error('prompt was not built: ' + p.slice(0, 80));
      prompts.push(p); await grab('review');
    });
    await step('consolidation prompts', async () => {
      await page.evaluate(() => globalThis.LifeOS.store.commit((x) => { for (const i of x.memory.insights) if (i.status === 'proposed') globalThis.LifeOS.memory.decide(x, i.id, 'approved'); }));
      for (const b of ['Consolidate month', 'Consolidate quarter']) {
        await nav('Memory'); await page.waitForSelector('h1:has-text("Memory")', T);
        await page.click('button:has-text("' + b + '")');
        await page.waitForSelector('#ai-prompt', T);
        prompts.push(await page.$eval('#ai-prompt', (t) => t.value));
      }
      await grab('memory');
    });
    await step('an error with a marker in the input is reported without the marker', async () => {
      await nav('Home'); await page.waitForSelector('.tile', T); await page.click('.tile[data-domain="activities"]');
      await page.waitForSelector('#act-upcoming', T);
      if (!(await page.locator('#act-add').evaluate((el) => el.open))) await page.click('#act-add > summary');
      await page.fill('#act-title', ADV_MARK + 'typed title'); await page.fill('#act-place', ADV_MARK + 'typed place');
      await page.fill('#act-people', ADV_MARK + 'typed person, ' + 'y'.repeat(120));
      await page.click('#act-add-btn');
      await page.waitForSelector('.notice.err', T);
      const msg = await page.textContent('.notice.err');
      if (msg.includes(ADV_MARK)) throw new Error('error notice echoes input');
      await page.fill('#act-people', ''); await page.fill('#act-notes', ADV_MARK + 'card 4111 1111 1111 1111');
      await page.click('#act-add-btn');
      await page.waitForSelector('.notice.err:has-text("ID number")', T);
      if ((await page.textContent('.notice.err')).includes(ADV_MARK)) throw new Error('secrets notice echoes input');
      await page.fill('#act-notes', ADV_MARK + 'typed note'); await page.click('#act-add-btn');
      await page.waitForSelector('.notice:has-text("Activity added.")', T);
      await page.click('.act-item[data-title^="' + ADV_MARK + '"] .act-edit >> nth=0');
      await page.click('.dialog button:has-text("Save")');
      await page.waitForSelector('.notice:has-text("Activity saved.")', T);
      await grab('activities');
    });
    await step('Social: errors and saves with a marker in the input are reported without the marker', async () => {
      await nav('Home'); await page.waitForSelector('.tile', T); await page.click('.tile[data-domain="social"]');
      await page.waitForSelector('#soc-people-card', T);
      if (!(await page.locator('#soc-add').evaluate((el) => el.open))) await page.click('#soc-add > summary');
      await page.fill('#soc-p-name', ADV_MARK + 'typed person'); await page.fill('#soc-p-notes', ADV_MARK + 'card 4111 1111 1111 1111'); await page.click('#soc-p-add');
      await page.waitForSelector('.notice.err:has-text("ID number")', T);
      if ((await page.textContent('.notice.err')).includes(ADV_MARK)) throw new Error('person secrets notice echoes input');
      await page.fill('#soc-p-notes', ADV_MARK + 'typed person note'); await page.click('#soc-p-add');
      await page.waitForSelector('.notice:has-text("Person added.")', T);
      await page.click('.soc-person-row button >> nth=0');
      await page.waitForSelector('#soc-facts', T);
      await page.fill('#soc-f-label', ADV_MARK + 'label'); await page.fill('#soc-f-text', ADV_MARK + 'card 4111 1111 1111 1111'); await page.click('#soc-f-add');
      await page.waitForSelector('.notice.err:has-text("ID number")', T);
      if ((await page.textContent('.notice.err')).includes(ADV_MARK)) throw new Error('fact secrets notice echoes input');
      const before = await page.locator('.soc-fact').count();
      await page.fill('#soc-f-text', ADV_MARK + 'typed fact'); await page.click('#soc-f-add');
      await page.waitForFunction((n) => document.querySelectorAll('.soc-fact').length === n + 1, before, T);
      await page.fill('#soc-d-label', ADV_MARK + 'date'); await page.fill('#soc-d-date', '2026-11-22'); await page.click('#soc-d-add');
      await page.waitForSelector('.soc-date-item[data-label^="' + ADV_MARK + 'date"]', T);
      await page.fill('#soc-l-note', ADV_MARK + 'typed contact note'); await page.click('#soc-l-add');
      await page.waitForSelector('.notice:has-text("Contact logged.")', T);
      await grab('social person');
    });
    await step('Social (audit v0.10.0): the adversarial person detail, search, Work cards, review and a marked group name', async () => {
      await nav('Home'); await page.waitForSelector('.tile', T);
      const glance = await page.textContent('#dash-glance').catch(() => '');
      if (!glance.includes(ADV_MARK)) throw new Error('the important date with a marker is not on the glance card, so the check proves nothing');
      await page.click('.tile[data-domain="social"]'); await page.waitForSelector('#soc-people-card', T);
      await page.fill('#soc-search', 'LEAK mark'); await page.waitForSelector('.soc-result', T);
      await grab('social search');
      await page.click('.soc-person-row[data-person^="' + ADV_MARK + '"] button'); await page.waitForSelector('#soc-facts .soc-fact', T);
      if (!(await page.textContent('#soc-work')).includes(ADV_MARK)) throw new Error('linked Work items not shown');
      await page.click('.soc-reached'); await page.waitForSelector('.notice:has-text("Contact logged.")', T);
      await grab('social adversarial person');
      await page.click('#soc-back'); await page.waitForSelector('#soc-people-card', T);
      if (!(await page.locator('#soc-groups').evaluate((el) => el.open))) await page.click('#soc-groups > summary');
      await page.fill('#soc-g-name', ADV_MARK + 'typed group'); await page.fill('#soc-g-days', 'x' + ADV_MARK); await page.click('#soc-g-add');
      await page.waitForSelector('.notice.err', T);
      if ((await page.textContent('.notice.err')).includes(ADV_MARK)) throw new Error('group error echoes input');
      await page.fill('#soc-g-days', '12'); await page.click('#soc-g-add'); await page.waitForSelector('.notice:has-text("Group added.")', T);
      await nav('Home'); await page.waitForSelector('.tile', T); await page.click('.tile[data-domain="work"]'); await page.waitForSelector('.wk-person', T);
      await nav('Review'); await page.waitForSelector('#rv-social, #rv-soc-none', T);
      await grab('social work and review');
    });
    await step('lock, unlock and reload', async () => {
      await page.click('.top .lockbtn'); await page.waitForSelector('#pass', T);
      if ((await page.textContent('body')).includes(ADV_MARK)) throw new Error('locked page shows data');
      await grab('locked');
      await page.reload(); await page.waitForSelector('#pass', T);
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
      await grab('unlocked');
    });
    await step('nothing outside the vault holds a marker', async () => {
      const audit = await page.evaluate(() => JSON.stringify(globalThis.LifeOS.store.getState().audit));
      if (!audit.includes('activity add') || !audit.includes('social fact add')) throw new Error('audit log not written: ' + audit.slice(0, 80));
      const idb = await page.evaluate(() => new Promise((res, rej) => {
        const r = indexedDB.open('lifeos');
        r.onsuccess = () => { const db = r.result, out = []; const tx = db.transaction(db.objectStoreNames, 'readonly');
          for (const n of db.objectStoreNames) { const c = tx.objectStore(n).openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { out.push(String(cur.key), JSON.stringify(cur.value)); cur.continue(); } }; }
          tx.oncomplete = () => { db.close(); res(out); }; tx.onerror = rej; };
        r.onerror = rej;
      }));
      if (idb.length < 2) throw new Error('IndexedDB read nothing');
      const env = JSON.parse(idb[1]);
      if (Object.keys(env).sort().join() !== 'ct,deviceId,iv,kdf,rev,updatedAt,v') throw new Error('envelope keys ' + Object.keys(env));
      const where = { prompts: prompts.join('\n'), audit, idb: idb.join('\n'), console: consoleText.join('\n'), storage: JSON.stringify(seen), urls: urls.join('\n') };
      for (const [k, v] of Object.entries(where)) {
        if (v.includes(ADV_MARK) || v.includes('Ignore previous') || v.includes('LEAK key')) throw new Error(k + ' holds a marker: ' + (v.match(/LEAK[^\n]{0,60}/) || [''])[0]);
      }
      if (/181\.4/.test(where.prompts)) throw new Error('weight value in a prompt (SEC-32)');
      if (requests.length) throw new Error('network requests: ' + requests.join(', '));
    });
  } catch { /* recorded in problems */ }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-LEAKS FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-LEAKS PASSED');
