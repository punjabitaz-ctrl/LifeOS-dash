// v0.11.0 part A private vault smoke: desktop and 390x844. Fails on console errors, CSP violations, horizontal scroll.
// Sets up the vault, moves an account, a person and an activity with its expense in, closes it and checks totals, markers and that no
// private text or number is in the page, waits out a short private timer, reopens, moves one out, changes the private passphrase,
// locks and unlocks the app, reloads and confirms persistence. Run `node build.mjs` first. Needs Playwright and Chrome at /usr/bin/google-chrome.
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
const PRIV = 'private vault passphrase one';
const PRIV2 = 'private vault passphrase two';
const T = { timeout: 30000 };
const problems = [];
let SECRETS = ['ZETAPRIV', 'PATPRIV', 'RETREATPRIV', 'EXPPRIV'];
const MARK = 'Some private items are hidden';

// Seed: public Checking 1000, private-to-be Savings 5000; public person Olly, private-to-be Pat (both never contacted, so overdue);
// a public expense 10 and a private-to-be activity with its linked expense 25 (cents 2500, paid).
const SEED = `(async () => {
  const L = globalThis.LifeOS, E = (o) => L.metrics.validateEntry(o);
  await L.store.commit((s) => {
    s.accounts.push({ id: 'acc-pub', name: 'Checking', kind: 'cash', liability: false, archived: false }, { id: 'acc-priv', name: 'ZETAPRIV Savings', kind: 'investment', liability: false, archived: false });
    s.entries.push(
      E({ id: 'bal-pub', domain: 'assets', type: 'balance', date: '2026-11-10', title: 'Checking', value: 1000, accountId: 'acc-pub' }),
      E({ id: 'bal-priv', domain: 'assets', type: 'balance', date: '2026-11-10', title: 'ZETAPRIV Savings', value: 5000, accountId: 'acc-priv' }),
      E({ id: 'exp-pub', domain: 'money', type: 'expense', date: '2026-11-10', title: 'Lunch', value: 10, category: 'Other' }),
      E({ id: 'exp-priv', domain: 'money', type: 'expense', date: '2026-11-12', title: 'EXPPRIV Retreat ticket', value: 25, category: 'Other' }));
    s.activities.push({ id: 'act-priv', title: 'RETREATPRIV Retreat', category: 'travel', state: 'done', date: '2026-11-12', place: '', withPeople: [], costCents: 2500, expenseId: 'exp-priv', paidOn: '2026-11-12', alsoHealth: false, alsoSocial: false, notes: '' });
    const p = (id, name) => ({ id, name, cadenceDays: 7, importantDates: [], pipelineIds: [], projectIds: [], facts: [], notes: '', archived: false, createdAt: '2026-08-01T00:00:00.000Z' });
    s.people.push(p('p-pub', 'Olly Open'), p('p-priv', 'PATPRIV Pat'));
  });
  return [L.metrics.fmtMoney(1000, 'USD'), L.metrics.fmtMoney(6000, 'USD'), L.metrics.fmtMoney(5000, 'USD')];
})()`;

async function run(label, viewport) {
  SECRETS = ['ZETAPRIV', 'PATPRIV', 'RETREATPRIV', 'EXPPRIV'];
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  page.on('request', (r) => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) requests.push(r.url()); });
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
  const nav = (name) => page.click('.nav button:has-text("' + name + '")');
  const text = (sel) => page.textContent(sel).then((t) => t.trim());
  const poll = async (get, good, what, tries = 80) => {
    let got;
    for (let i = 0; i < tries; i++) { try { got = await get(); if (good(got)) return got; } catch (e) { got = String(e.message).split('\n')[0]; } await page.waitForTimeout(100); }
    throw new Error(what + ' is ' + JSON.stringify(got));
  };
  const expectText = (sel, want) => poll(() => text(sel), (g) => g === want, sel + ' (expected ' + JSON.stringify(want) + ')');
  const layout = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
  };
  // Every text node, attribute value and form value in the page (script and style excluded).
  const pageStuff = () => page.evaluate(() => {
    let t = '';
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const n = w.currentNode; if (n.parentElement && !['SCRIPT', 'STYLE'].includes(n.parentElement.tagName)) t += n.nodeValue + '\n'; }
    for (const el of document.querySelectorAll('body *')) { if (['SCRIPT', 'STYLE'].includes(el.tagName)) continue; for (const a of el.attributes) t += a.value + '\n'; if ('value' in el && typeof el.value === 'string') t += el.value + '\n'; }
    return t;
  });
  let money;
  const noSecrets = async (where) => {
    const t = await pageStuff();
    for (const s of SECRETS) if (t.includes(s)) throw new Error(where + ': page holds ' + s);
    for (const n of [money[2], money[1]]) if (t.includes(n)) throw new Error(where + ': page holds the private figure ' + n);
  };
  const dash = async () => { await nav('Home'); await page.waitForSelector('.tile', T); };
  const tileVal = (d) => text('.tile[data-domain="' + d + '"] .tile-value');
  const markCount = (sel) => page.locator(sel + ' [aria-label="' + MARK + '"]').count();
  const privScreen = async () => { await page.click('#nav-private'); await page.waitForSelector('h1:has-text("Private vault")', T); };
  const openVault = async (pw2) => { await privScreen(); await page.fill('#priv-pass', pw2); await page.click('#priv-open'); await page.waitForSelector('#priv-bar', T); };
  const moveIn = async (coll, key) => {
    await privScreen();
    await page.selectOption('#priv-coll', coll);
    await page.waitForSelector('.priv-row[data-key="' + key + '"]', T);
    await page.click('.priv-row[data-key="' + key + '"] .priv-move');
    await page.waitForSelector('.dialog', T);
    return page.click('.dialog button:has-text("Move in")');
  };
  try {
    await page.clock.install({ time: new Date(2026, 10, 14, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('create the app vault and seed data', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")');
      await page.waitForSelector('.tile', T);
      money = await page.evaluate(SEED);
      await nav('Settings'); await dash();
      await expectText('.tile[data-domain="assets"] .tile-value', money[1]);
      await expectText('.tile[data-domain="social"] .tile-value', '2');
      if (await markCount('.tile[data-domain="assets"]')) throw new Error('marker shown before any vault exists');
      await layout('dashboard');
    });
    await step('set up the private vault (own passphrase, not the main one)', async () => {
      await privScreen();
      await page.waitForSelector('#priv-setup', T);
      await page.fill('#priv-set1', PASS); await page.fill('#priv-set2', PASS); await page.click('#priv-setup-btn');
      await page.waitForSelector('.notice.err:has-text("different from your main")', T);
      await page.fill('#priv-set1', PRIV); await page.fill('#priv-set2', PRIV + 'x'); await page.click('#priv-setup-btn');
      await page.waitForSelector('.notice.err:has-text("do not match")', T);
      await page.fill('#priv-set1', PRIV); await page.fill('#priv-set2', PRIV); await page.click('#priv-setup-btn');
      await page.waitForSelector('#priv-bar', T);
      await page.fill('#priv-secs', '15'); await page.click('#priv-secs-save');
      await page.waitForSelector('.notice:has-text("Saved.")', T);
      await layout('private screen open');
    });
    await step('move an account, a person and an activity with its expense in', async () => {
      await moveIn('accounts', 'acc-priv');
      await page.waitForSelector('.notice:has-text("Moved to the private vault.")', T);
      await moveIn('people', 'p-priv');
      await page.waitForSelector('.notice:has-text("Moved to the private vault.")', T);
      await privScreen(); await page.selectOption('#priv-coll', 'activities');
      await page.waitForSelector('.priv-row[data-key="act-priv"]', T);
      await page.click('.priv-row[data-key="act-priv"] .priv-move');
      await page.waitForSelector('#priv-pair', T);
      await page.click('.dialog button:has-text("Move in")');
      await page.waitForSelector('.notice:has-text("Moved to the private vault.")', T);
      // the expense went with the activity
      await page.selectOption('#priv-coll', 'entries');
      await page.waitForSelector('.priv-row[data-key="exp-priv"][data-private="1"]', T);
      await page.waitForSelector('.priv-row[data-key="exp-pub"][data-private="0"]', T);
      await layout('moved');
    });
    await step('open: totals include private items and private rows say so', async () => {
      await dash();
      await expectText('.tile[data-domain="assets"] .tile-value', money[1]);
      await expectText('.tile[data-domain="social"] .tile-value', '2');
      if (await markCount('.tile[data-domain="assets"]')) throw new Error('marker shown while open');
      await nav('Assets'); await page.waitForSelector('h1:has-text("Assets")', T);
      if (!(await pageStuff()).includes('ZETAPRIV')) throw new Error('private account not shown while open');
      await layout('assets open');
    });
    await step('close: totals from the main state, lock markers, no private text or number anywhere', async () => {
      await page.click('#priv-close');
      await page.waitForSelector('#priv-bar', { state: 'detached', ...T });
      await dash();
      await expectText('.tile[data-domain="assets"] .tile-value', money[0]);
      await expectText('.tile[data-domain="social"] .tile-value', '1');
      if ((await markCount('.tile[data-domain="assets"]')) !== 1 || (await markCount('.tile[data-domain="social"]')) !== 1) throw new Error('lock markers missing on the tiles');
      if (await markCount('.tile[data-domain="learning"]')) throw new Error('marker on a tile that is not affected');
      await noSecrets('dashboard');
      const ids = await page.$$eval('.tile', (t) => t.map((x) => x.getAttribute('data-domain')));
      for (const id of ids) { await dash(); await page.click('.tile[data-domain="' + id + '"]'); await page.waitForSelector('h1', T); await page.waitForTimeout(60); await noSecrets(id); await layout(id); }
      for (const n of ['Money', 'Assets', 'Work', 'Health', 'Review', 'Memory', 'Settings']) { await nav(n); await page.waitForTimeout(60); await noSecrets(n); await layout(n); }
      await nav('Assets');
      if (!(await page.locator('.lockrow').count())) throw new Error('no marker line on the Assets screen');
      await nav('Review'); await page.click('button:has-text("Suggest with AI")').catch(() => {});
      await page.waitForSelector('#ai-prompt', { timeout: 5000 }).catch(() => {});
      if (await page.locator('#ai-prompt').count()) { const p = await page.$eval('#ai-prompt', (t) => t.value); for (const s of SECRETS) if (p.includes(s)) throw new Error('prompt holds ' + s); }
    });
    await step('wrong passphrase: increasing delay, then the right one opens', async () => {
      await privScreen();
      await page.fill('#priv-pass', 'not the private passphrase'); await page.click('#priv-open');
      await page.waitForSelector('#priv-wait:has-text("Wait")', T);
      if (!(await page.locator('#priv-open').isDisabled())) throw new Error('open button not disabled during the delay');
      await poll(() => page.locator('#priv-open').isDisabled(), (g) => g === false, 'delay ends after about 1 s');
      await page.fill('#priv-pass', 'still not the passphrase'); await page.click('#priv-open');
      await page.waitForSelector('#priv-wait:has-text("Wait")', T);
      const t0 = Date.now();
      // re-rendering (leaving the screen and coming back) does not reset the delay
      await nav('Money'); await privScreen();
      if (!(await page.locator('#priv-open').isDisabled())) throw new Error('the delay was reset by a re-render');
      await poll(() => page.locator('#priv-open').isDisabled(), (g) => g === false, 'delay ends after about 2 s');
      if (Date.now() - t0 < 1200) throw new Error('second delay was not longer than the first');
      await page.fill('#priv-pass', PRIV); await page.click('#priv-open');
      await page.waitForSelector('#priv-bar', T);
    });
    await step('the private timer (15 s) closes the vault by itself and clears the page', async () => {
      await dash();
      await expectText('.tile[data-domain="assets"] .tile-value', money[1]);
      await page.waitForSelector('#priv-bar', { state: 'detached', timeout: 40000 });
      await dash();
      await expectText('.tile[data-domain="assets"] .tile-value', money[0]);
      await noSecrets('after the timer');
    });
    await step('reopen and move the person out; the app shows them while the vault is closed', async () => {
      await openVault(PRIV);
      await privScreen(); await page.selectOption('#priv-coll', 'people');
      await page.waitForSelector('.priv-row[data-key="p-priv"][data-private="1"]', T);
      await page.click('.priv-row[data-key="p-priv"] .priv-move');
      await page.waitForSelector('.dialog', T);
      await page.click('.dialog button:has-text("Move out")');
      await page.waitForSelector('.notice:has-text("Moved out of the private vault.")', T);
      await page.click('#priv-close');
      SECRETS = SECRETS.filter((x) => x !== 'PATPRIV');
      await dash();
      await expectText('.tile[data-domain="social"] .tile-value', '2');
      await page.click('.tile[data-domain="social"]'); await page.waitForSelector('h1:has-text("Social")', T);
      if (!(await pageStuff()).includes('PATPRIV')) throw new Error('moved-out person not shown while closed');
      await dash();
      await expectText('.tile[data-domain="assets"] .tile-value', money[0]);
      if ((await markCount('.tile[data-domain="assets"]')) !== 1) throw new Error('assets marker missing');
      if (await markCount('.tile[data-domain="learning"]')) throw new Error('marker on a tile with nothing hidden');
    });
    await step('change the private passphrase: the vault closes, old fails, new opens', async () => {
      await openVault(PRIV);
      await privScreen();
      await page.fill('#priv-old', PRIV); await page.fill('#priv-new1', PRIV2); await page.fill('#priv-new2', PRIV2); await page.click('#priv-change');
      await page.waitForSelector('.notice:has-text("Private passphrase changed")', T);
      await page.waitForSelector('#priv-bar', { state: 'detached', ...T });
      await page.fill('#priv-pass', PRIV); await page.click('#priv-open');
      await page.waitForSelector('.notice.err:has-text("private passphrase did not work")', T);
      await poll(() => page.locator('#priv-open').isDisabled(), (g) => g === false, 'delay ends');
      await page.fill('#priv-pass', PRIV2); await page.click('#priv-open');
      await page.waitForSelector('#priv-bar', T);
    });
    await step('SEC-62 and SEC-67: confirming a private recurring item makes a private entry; closing drops the notice and the search text', async () => {
      await page.evaluate(() => globalThis.LifeOS.store.commit((s) => { s.recurring.push({ id: 'rec-priv', title: 'Bill priv therapy', value: 150, category: 'Other', type: 'expense', cadence: 'monthly', nextDate: '2026-11-13', active: true }); }));
      await moveIn('recurring', 'rec-priv');
      await page.waitForSelector('.notice:has-text("Moved to the private vault.")', T);
      await privScreen(); await page.fill('#priv-q', 'Bill priv therapy'); await page.click('#priv-search');
      await page.waitForSelector('.priv-row', T);
      await poll(() => page.inputValue('#priv-q'), (g) => g === 'Bill priv therapy', 'search text kept while open');
      await nav('Money'); await page.click('button[aria-label="Confirm Bill priv therapy"]');
      await page.waitForSelector('.notice:has-text("Posted Bill priv therapy.")', T);
      const main = await page.evaluate(() => JSON.stringify(Object.assign({}, globalThis.LifeOS.store.getState(), { priv: 0 })));
      if (main.includes('Bill priv therapy')) throw new Error('the confirmed entry or its source is in the main state');
      await page.click('#priv-close'); await page.waitForSelector('#priv-bar', { state: 'detached', ...T });
      if ((await pageStuff()).includes('Bill priv')) throw new Error('private text left in the page after close (notice or search)');
      await nav('Money'); await page.waitForTimeout(60);
      if ((await pageStuff()).includes('Bill priv')) throw new Error('Money shows private text while closed');
      await openVault(PRIV2); await privScreen();
      if ((await page.inputValue('#priv-q')) !== '') throw new Error('the private search text survived the close');
    });
    await step('lock and unlock the app: the vault is closed after unlock, nothing leaks, data persists', async () => {
      await page.click('.top .lockbtn'); await page.waitForSelector('#pass', T);
      const locked = await pageStuff();
      for (const s of SECRETS.concat(['PATPRIV', 'Olly', 'Checking'])) if (locked.includes(s)) throw new Error('locked page holds ' + s);
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
      if (await page.locator('#priv-bar').count()) throw new Error('vault open after unlock');
      await expectText('.tile[data-domain="assets"] .tile-value', money[0]);
      await noSecrets('after unlock');
      await page.reload(); await page.waitForSelector('#pass', T);
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
      await expectText('.tile[data-domain="assets"] .tile-value', money[0]);
      await openVault(PRIV2);
      await dash();
      await expectText('.tile[data-domain="assets"] .tile-value', money[1]);
      await nav('Assets'); await page.waitForSelector('h1:has-text("Assets")', T);
      if (!(await pageStuff()).includes('ZETAPRIV')) throw new Error('private account missing after reload');
      await layout('reloaded');
    });
    if (requests.length) throw new Error('network requests: ' + requests.join(', '));
  } catch { /* recorded in problems */ }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-PRIV FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-PRIV PASSED');
