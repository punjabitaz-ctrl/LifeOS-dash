// v1.8.0 passphrase recovery smoke: desktop and 390x844. Fails on console errors, CSP violations, horizontal scroll, network requests.
// Checklist prompt (Later, then Turn on now), main key shown once and retyped, getting started view, lock, wrong key delay, unlock with the key,
// forced new passphrase and new key, old key refused; replace; turn off; the same for the private vault (prompt at creation, use, replace, off).
// The key is never in the URL, in storage or in the page once its dialog is closed. Run `node build.mjs` first.
import path from 'node:path';
import { navTo } from './_nav.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '..', 'dist', 'lifeos.html');
let pw;
try { pw = await import('playwright'); } catch { console.log('SKIPPED: playwright not available'); process.exit(0); }
let browser;
for (const o of [{ executablePath: '/usr/bin/google-chrome' }, { channel: 'chrome' }, {}]) {
  try { browser = await pw[process.env.LIFEOS_SMOKE_BROWSER || 'chromium'].launch(o); break; } catch { /* try next */ }
}
if (!browser) { console.log('SKIPPED: ' + (process.env.LIFEOS_SMOKE_BROWSER || 'chromium') + ' unavailable (not installed); this is not a pass'); process.exit(0); }

const PASS = 'correct horse battery staple', PASS2 = 'second main passphrase 22', PASS3 = 'third main passphrase 333';
const PRIV = 'private vault passphrase one', PRIV2 = 'private vault passphrase two';
const T = { timeout: 30000 };
const problems = [];

async function run(label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  page.on('request', (r) => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) requests.push(r.url()); });
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
  const nav = (name) => navTo(page, name);
  const sleep = (ms) => page.waitForTimeout(ms);
  const layout = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
  };
  const pageText = () => page.evaluate(() => {
    let t = '';
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) t += w.currentNode.nodeValue + '\n';
    for (const el of document.querySelectorAll('body *')) { for (const a of el.attributes) t += a.value + '\n'; if ('value' in el && typeof el.value === 'string') t += el.value + '\n'; }
    return t + location.href + '\n' + JSON.stringify(Object.assign({}, sessionStorage)) + '\n' + document.cookie;
  });
  const canon = (k) => k.replace(/-/g, '');
  const noKey = async (where, keys) => { const t = await pageText(); for (const k of keys) if (t.includes(k) || t.includes(canon(k)) || t.includes(k.slice(-9))) throw new Error(where + ': page holds a recovery key'); };
  const errNotice = (re) => page.waitForSelector('.notice.err, .dialog p[role="status"]', T).then(() => page.waitForFunction((s) => { const n = [...document.querySelectorAll('.notice.err, .dialog p[role="status"]')].map((e) => e.textContent).join(' '); return new RegExp(s).test(n); }, re, T));
  const newKey = () => page.evaluate(() => globalThis.LifeOS.vault.newRecoveryKey());
  // The shown-once dialog: returns the key, retypes it, confirms. A wrong retype is refused first.
  async function confirmKey() {
    await page.waitForSelector('#rk-shown', T);
    const key = (await page.textContent('#rk-shown')).trim();
    if (!/^([A-Z2-7]{4}-){13}[A-Z2-7]{4}$/.test(key)) throw new Error('key format: ' + key);
    await page.fill('#rk-key-retype', 'AAAA-AAAA'); await page.click('.dialog button:has-text("I have written it down")');
    await errNotice('not the recovery key shown');
    await page.fill('#rk-key-retype', key.slice(-9).toLowerCase()); await page.click('.dialog button:has-text("I have written it down")');
    await page.waitForFunction(() => !document.querySelector('#rk-shown'), null, T);
    return key;
  }
  const closeDialogs = async () => { await sleep(300); while (await page.locator('.dialog').count()) { await page.click('.dialog button:has-text("Cancel"), .dialog button:has-text("Close")'); await sleep(150); } };
  const lock = async () => { await page.click('.lockbtn'); await page.waitForSelector('#pass', T); };
  // A wrong key is refused, then the next one waits.
  async function wrongKeyDelay(sel, btn, link) {
    if (link) await page.click(link);
    await page.fill(sel, await newKey()); await page.click(btn);
    await errNotice('did not work|not match|Wrong|wrong');
    await page.fill(sel, await newKey()); await page.click(btn);
    await errNotice('Wait \\d+ s');
  }
  const settingsTop = async () => { await nav('Settings'); await page.waitForSelector('#rk-main-card', T); };
  let key1, key2, key3, pkey1, pkey2, pkey3;
  try {
    await page.goto(pathToFileURL(file).href);
    await step('create the vault; the checklist prompts for the recovery key; Later keeps it on the checklist', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")');
      await page.waitForSelector('#setup-card', T);
      await page.waitForSelector('#setup-rk-now', T); await page.waitForSelector('#setup-rk-later', T);
      await page.click('#setup-rk-later');
      await page.waitForSelector('#setup-recovery-open', T);
      if (await page.locator('#setup-rk-now').count()) throw new Error('prompt still open after Later');
      if (!(await page.locator('#setup-card').count())) throw new Error('checklist gone after Later');
      await layout('checklist, later');
      await page.click('#setup-recovery-open'); await page.waitForSelector('#setup-rk-now', T);
    });
    await step('getting started view opens from the checklist and from Settings', async () => {
      await page.click('#setup-guide'); await page.waitForSelector('#guide-view', T);
      if ((await page.locator('#guide-steps > li').count()) !== 9) throw new Error('guide steps');
      const t = await page.textContent('#guide-view');
      for (const d of ['FIRST-RUN.md', 'SYNC-SETUP.md', 'AI-SETUP.md', 'RECOVERY.md']) if (!t.includes(d)) throw new Error('guide misses ' + d);
      await layout('guide');
      await page.click('#guide-open-recovery'); await page.waitForSelector('#rk-main-card', T);
      await page.click('#settings-guide'); await page.waitForSelector('#guide-view', T);
      await page.click('#guide-back'); await page.waitForSelector('#setup-card', T);
    });
    await step('turn it on from the checklist: key shown once, retype, then gone from the page and the URL', async () => {
      await page.fill('#setup-rk-pass', 'not the passphrase 1'); await page.click('#setup-rk-now');
      await errNotice('did not work|Wrong|wrong|passphrase');
      await sleep(1300); await page.fill('#setup-rk-pass', PASS); await page.click('#setup-rk-now');
      key1 = await confirmKey();
      await closeDialogs();
      await page.waitForSelector('#setup-recovery[data-done="true"]', T);
      await noKey('after the dialog closed', [key1]); await layout('after key');
    });
    await step('lock; wrong recovery key then a delay; the right key forces a new passphrase and a new key; the old key is refused', async () => {
      await lock(); await wrongKeyDelay('#rk-enter-key', '#rk-continue', '#use-recovery'); await layout('lock recovery');
      await sleep(2200);
      await page.fill('#rk-enter-key', key1.toLowerCase()); await page.click('#rk-continue');
      await page.waitForSelector('#rk-new-pass', T);
      await page.fill('#rk-new-pass', PASS2); await page.fill('#rk-new-pass2', PASS2 + 'x'); await page.click('#rk-setpass');
      await errNotice('do not match');
      await page.fill('#rk-new-pass2', PASS2); await page.click('#rk-setpass');
      key2 = await confirmKey();
      await page.waitForSelector('.tile', T); await closeDialogs();
      if (key2 === key1) throw new Error('same key');
      await noKey('after recovery unlock', [key1, key2]);
      await lock(); await page.click('#use-recovery'); await page.fill('#rk-enter-key', key1); await page.click('#rk-continue');
      await errNotice('did not work|not match|Wrong|wrong');
      await page.click('#rk-back'); await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")');
      await errNotice('did not work|Wrong|wrong|passphrase');
      await sleep(1200); await page.fill('#pass', PASS2); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
    });
    await step('replace the key: the new one is shown, the older one no longer opens the vault', async () => {
      await settingsTop();
      await page.fill('#rk-main-pass', PASS2); await page.click('#rk-main-on');
      key3 = await confirmKey(); await closeDialogs();
      await noKey('after replace', [key1, key2, key3]);
      await lock(); await page.click('#use-recovery'); await page.fill('#rk-enter-key', key2); await page.click('#rk-continue');
      await errNotice('did not work|not match|Wrong|wrong');
      await page.click('#rk-back'); await sleep(1200); await page.fill('#pass', PASS2); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
    });
    await step('SEC-130 and SEC-128: a wrong current passphrase shows no new key; a backup carrying the key restores on a new device under a new passphrase', async () => {
      await settingsTop();
      await page.fill('#pp-old', 'not the passphrase 1234'); await page.fill('#pp-new', PASS3); await page.fill('#pp-new2', PASS3);
      await page.check('#rk-new-key'); await page.click('button:has-text("Change passphrase")');
      await errNotice('did not work|Wrong|wrong');
      if (await page.locator('#rk-shown').count()) throw new Error('a new key was shown for a change that cannot succeed');
      await page.uncheck('#rk-new-key'); await sleep(1200);
      const text = await page.evaluate((k) => globalThis.LifeOS.vault.exportBackup('backup passphrase 55', globalThis.LifeOS.store.getState(), k), key3);
      const ctx2 = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
      const p2 = await ctx2.newPage();
      p2.on('pageerror', (e) => problems.push(label + ' restore pageerror: ' + e.message));
      try {
        await p2.goto(pathToFileURL(file).href); await p2.click('#path-restore');
        const f = { name: 'lifeos-backup.json', mimeType: 'application/json', buffer: Buffer.from(text) };
        await p2.setInputFiles('#rs-file', f); await p2.check('#rs-use-key'); await p2.fill('#rs-pass', key2); await p2.click('#rs-check');
        await p2.waitForFunction(() => /did not work/.test((document.querySelector('.notice') || {}).textContent || ''), null, T);
        await p2.waitForTimeout(1200);
        await p2.setInputFiles('#rs-file', f); await p2.fill('#rs-pass', key3.toLowerCase()); await p2.click('#rs-check'); await p2.waitForSelector('#rs-ok', T);
        await p2.fill('#rs-new-pass', PASS3); await p2.fill('#rs-new-pass2', PASS3); await p2.click('#rs-use'); await p2.waitForSelector('.tile', T);
        const r = await p2.evaluate(() => globalThis.LifeOS.store.hasRecovery()); if (r) throw new Error('a restored vault starts with no recovery key');
        await p2.click('.lockbtn'); await p2.waitForSelector('#pass', T); await p2.fill('#pass', PASS3); await p2.click('button:has-text("Unlock")'); await p2.waitForSelector('.tile', T);
      } finally { await ctx2.close(); }
    });
    await step('turn it off: the key stops working and the card says it is off', async () => {
      await settingsTop();
      await page.fill('#rk-main-pass', PASS2); await page.click('#rk-main-off');
      await page.click('.dialog button:has-text("Turn it off")');
      await page.waitForFunction(() => /^Off\./.test((document.querySelector('#rk-main-status') || {}).textContent || ''), null, T);
      await lock(); await page.click('#use-recovery'); await page.fill('#rk-enter-key', key3); await page.click('#rk-continue');
      await errNotice('did not work|not match|Wrong|wrong');
      await page.click('#rk-back'); await sleep(1200); await page.fill('#pass', PASS2); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
    });
    await step('private vault: the creation prompt (Turn on now), shown once and retyped', async () => {
      await page.click('#nav-private'); await page.waitForSelector('#priv-setup', T);
      await page.fill('#priv-set1', PRIV); await page.fill('#priv-set2', PRIV); await page.click('#priv-setup-btn');
      await page.waitForSelector('#priv-rk-prompt', T);
      await page.click('.dialog button:has-text("Turn on now")');
      pkey1 = await confirmKey(); await closeDialogs();
      await page.waitForSelector('#priv-pass', T);   // changing the key closes the private vault
      if (pkey1 === key3) throw new Error('same key for both vaults');
      await noKey('private key shown', [pkey1, key1, key2, key3]); await layout('private closed');
    });
    await step('private vault: close, wrong key and the delay, use the key for a new passphrase and key; the old key is refused', async () => {
      await wrongKeyDelay('#rk-priv-enter-key', '#rk-priv-continue', '#use-priv-recovery'); await layout('private recovery');
      await sleep(2200);
      await page.fill('#rk-priv-enter-key', key1); await page.click('#rk-priv-continue');
      await errNotice('did not work|not match|Wrong|wrong');   // the main key does not open the private vault
      await sleep(4200);
      await page.fill('#rk-priv-enter-key', pkey1); await page.click('#rk-priv-continue');
      await page.waitForSelector('#rk-priv-new-pass', T);
      await page.fill('#rk-priv-new-pass', PASS2); await page.fill('#rk-priv-new-pass2', PASS2); await page.click('#rk-priv-setpass');
      await errNotice('different from your main');
      await page.fill('#rk-priv-new-pass', PRIV2); await page.fill('#rk-priv-new-pass2', PRIV2); await page.click('#rk-priv-setpass');
      pkey2 = await confirmKey(); await closeDialogs();
      await page.waitForSelector('#priv-bar', T);
      await noKey('after private use', [pkey1, pkey2, key3]);
      await page.click('#priv-close'); await page.waitForSelector('#priv-pass', T);
      await page.click('#use-priv-recovery'); await page.fill('#rk-priv-enter-key', pkey1); await page.click('#rk-priv-continue');
      await errNotice('did not work|not match|Wrong|wrong');
      await page.click('#rk-priv-back'); await sleep(2200);
      await page.fill('#priv-pass', PRIV2); await page.click('#priv-open'); await page.waitForSelector('#priv-bar', T);
    });
    await step('private vault: replace, then turn off', async () => {
      await page.fill('#rk-priv-pass', PRIV2); await page.click('#rk-priv-on');
      pkey3 = await confirmKey(); await closeDialogs();
      await page.fill('#rk-priv-pass', PRIV2); await page.click('#rk-priv-off');
      await page.click('.dialog button:has-text("Turn it off")');
      await page.waitForFunction(() => /^Off\./.test((document.querySelector('#rk-priv-status') || document.querySelector('#rk-priv-card') || {}).textContent || ''), null, T);
      await page.waitForSelector('#priv-pass', T);
      if (await page.locator('#use-priv-recovery').count()) throw new Error('recovery link shown with no private key on');
      await noKey('end', [pkey1, pkey2, pkey3, key1, key2, key3]); await layout('end');
    });
    if (requests.length) throw new Error('network requests: ' + requests.join(', '));
  } catch (e) { if (!problems.length) problems.push(label + ' ' + e.message); }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-RECOVERY FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-RECOVERY PASSED');
