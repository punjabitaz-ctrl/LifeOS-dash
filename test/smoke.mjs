import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '..', 'dist', 'lifeos.html');
let pw;
try { pw = await import('playwright'); } catch { console.log('SKIPPED: playwright not available'); process.exit(0); }
let browser;
for (const o of [{}, { channel: 'chrome' }, { executablePath: '/usr/bin/google-chrome' }]) {
  try { browser = await pw.chromium.launch(o); break; } catch { /* try next */ }
}
if (!browser) { console.log('SKIPPED: chromium unavailable'); process.exit(0); }
const problems = [];
async function run(label, viewport) {
const mobile = !!viewport;
const ctx = await browser.newContext({ acceptDownloads: true, ...(viewport ? { viewport, isMobile: true, hasTouch: true } : {}) });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
const PASS = 'correct horse battery staple';
async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n')[0]); throw e; } }
const layout = async (where) => {
  if (!mobile) return;
  const r = await page.evaluate(() => {
    const nav = document.querySelector('.nav'); const b = nav && nav.getBoundingClientRect();
    return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, ih: window.innerHeight, nav: !!b && b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < window.innerHeight && getComputedStyle(nav).visibility !== 'hidden' };
  });
  if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
  if (!r.nav) throw new Error(where + ': nav not visible');
};
try {
  await page.clock.install();
  await page.goto(pathToFileURL(file).href);
  await step('create', async () => {
    await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
    await page.click('button:has-text("Create vault")');
    await page.waitForSelector('.tile', { timeout: 30000 });
    if ((await page.locator('.tile').count()) !== 10) throw new Error('expected 10 tiles');
    await layout('dashboard');
  });
  await step('expense', async () => {
    await page.click('.tile[data-domain="money"]');
    await page.selectOption('#f-type', 'expense');
    await page.fill('#f-title', 'Groceries'); await page.fill('#f-value', '42.5');
    await page.click('button:has-text("Add entry")');
    await page.waitForSelector('.entry:has-text("Groceries")');
    await layout('domain');
  });
  await step('workout', async () => {
    await page.click('.nav button:has-text("Home")');
    await page.click('.tile[data-domain="health"]');
    await page.selectOption('#f-type', 'workout');
    await page.fill('#f-title', 'Run');
    await page.click('button:has-text("Add entry")');
    await page.waitForSelector('.entry:has-text("Run")');
    await page.click('.nav button:has-text("Home")');
    await page.waitForSelector('.tile');
    if ((await page.locator('.tile').count()) !== 10) throw new Error('tiles missing');
  });
  await step('review', async () => {
    await page.click('.nav button:has-text("Review")');
    await page.click('#rules-run');
    await page.waitForSelector('button:has-text("Approve")', { timeout: 10000 });
    await page.click('button:has-text("Approve") >> nth=0');
    await page.waitForSelector('.chip.ok');
    await page.fill('#prio1', 'One'); await page.fill('#prio2', 'Two'); await page.fill('#prio3', 'Three');
    await page.click('#finish-review');
    await page.waitForSelector('.tile');
  });
  await step('review-layout', async () => {
    await page.click('.nav button:has-text("Review")'); await page.waitForSelector('#rules-run'); await layout('review');
    await page.click('.nav button:has-text("Memory")'); await layout('memory');
    await page.click('.nav button:has-text("Home")'); await page.waitForSelector('.tile');
  });
  await step('lock-unlock', async () => {
    await page.click('.top button:has-text("Lock")');
    await page.waitForSelector('#pass');
    if (await page.locator('.tile').count()) throw new Error('data visible while locked');
    await page.fill('#pass', PASS);
    await page.click('button:has-text("Unlock")');
    await page.waitForSelector('.tile', { timeout: 30000 });
    if (!(await page.locator('.card:has-text("One")').count())) throw new Error('priorities not persisted');
    await page.click('.tile[data-domain="money"]');
    await page.waitForSelector('.entry:has-text("Groceries")');
    await page.click('.nav button:has-text("Memory")');
    await page.waitForSelector('.chip.ok');
  });
  const bodyText = () => page.evaluate(() => document.body.innerText);
  // Everything the page renders or holds in the DOM: text nodes and attribute values of every element in the whole
  // document (head included), except the source text of <script>/<style>, which is the app's own code and
  // legitimately contains strings such as default category names. Form control values are checked separately.
  const domSecrets = (secrets) => page.evaluate((secrets) => {
    const skip = (n) => { for (let p = n.parentNode; p; p = p.parentNode) if (p.nodeName === 'SCRIPT' || p.nodeName === 'STYLE') return true; return false; };
    const parts = [];
    const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (!skip(n)) parts.push(n.nodeValue);
    for (const el of document.querySelectorAll('*')) for (const a of el.attributes) parts.push(a.value);
    parts.push(document.title);
    const t = parts.join('\n');
    const vals = [...document.querySelectorAll('input,textarea,select')].map((x) => x.value).filter(Boolean);
    return { hit: secrets.filter((x) => t.includes(x)), vals, tiles: document.querySelectorAll('.tile,.entry,.dialog,.overlay').length, extra: document.body.children.length };
  }, secrets);
  const assertLockedClean = async (secrets) => {
    await page.waitForSelector('#pass');
    const leak = await domSecrets(secrets);
    if (leak.hit.length || leak.vals.length || leak.tiles) throw new Error('DOM not cleared on lock: ' + JSON.stringify(leak));
  };
  await step('csv-import', async () => {
    await page.click('.nav button:has-text("Home")');
    await page.click('.tile[data-domain="money"]');
    const csv = 'Date,Payee,Amount,Notes\r\n2026-11-02,Rent,"1,200.00",monthly\r\n2026-11-03,=HYPERLINK("http://x"),50,\r\nnot-a-date,Bad,1,\r\n2026-11-04,Huge,' + '1'.repeat(5000) + 'x,\r\n';
    await page.setInputFiles('#csv-file', { name: 'bank.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.waitForSelector('#m-date');
    await page.selectOption('#m-type', 'expense');
    await page.waitForSelector('#m-value');
    await page.click('button:has-text("Import rows")');
    await page.waitForSelector('.notice:has-text("Imported 2 rows. Rejected 2.")');
    await page.waitForSelector('.entry:has-text("Rent")');
    await page.waitForSelector('.entry:has-text("=HYPERLINK")');
  });
  await step('csv-export', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export CSV")')]);
    const text = readFileSync(await dl.path(), 'utf8');
    if (!text.includes('"\'=HYPERLINK(""http://x"")"')) throw new Error('formula not neutralised on export');
    if (!text.includes('"Rent"') || !text.includes('"1200"')) throw new Error('export missing rows');
  });
  let backupPath;
  await step('backup-export', async () => {
    await page.click('.nav button:has-text("Settings")');
    await layout('settings');
    if (!/v0\.4\.0/.test(await page.textContent('#app-version'))) throw new Error('version missing');
    await page.selectOption('#p-kind', 'local');
    await page.fill('#p-base', 'http://localhost:11434/v1');
    if (!/sent to: http:\/\/localhost:11434\/v1\/chat\/completions/.test(await page.textContent('#p-url'))) throw new Error('url preview wrong');
    await page.fill('#p-base', 'http://localhost/evil');
    if (!/not allowed/.test(await page.textContent('#p-url'))) throw new Error('bad url not flagged');
    await page.fill('#bk-pass', 'backup passphrase 123'); await page.fill('#bk-pass2', 'backup passphrase 123');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('button:has-text("Export backup")')]);
    backupPath = await dl.path();
    const env = JSON.parse(readFileSync(backupPath, 'utf8'));
    if (env.v !== 1 || env.kdf.iter !== 600000 || !env.ct || JSON.stringify(env).includes('Groceries')) throw new Error('backup is not an encrypted envelope');
    await page.waitForSelector('.notice:has-text("Backup downloaded.")');
    if (await page.inputValue('#bk-pass')) throw new Error('backup passphrase left in input');
  });
  await step('backup-import', async () => {
    await page.click('.nav button:has-text("Home")');
    await page.click('.tile[data-domain="money"]');
    await page.fill('#f-title', 'AfterBackup'); await page.fill('#f-value', '7');
    await page.click('button:has-text("Add entry")');
    await page.waitForSelector('.entry:has-text("AfterBackup")');
    await page.click('.nav button:has-text("Settings")');
    await page.setInputFiles('#bk-file', backupPath);
    await page.fill('#bk-ipass', 'wrong passphrase 123');
    await page.click('button:has-text("Import backup")');
    await page.waitForSelector('.notice:has-text("passphrase did not work")', { timeout: 30000 });
    if (await page.locator('.dialog').count()) throw new Error('dialog shown for a wrong passphrase');
    await page.fill('#bk-ipass', 'backup passphrase 123');
    await page.click('button:has-text("Import backup")');
    await page.waitForSelector('.dialog #bk-summary', { timeout: 30000 });
    const sum = await page.textContent('#bk-summary');
    if (!/Entries: 4/.test(sum) || !/Approved insights: 1/.test(sum) || !/Lessons: 0/.test(sum) || !/API key: not included/.test(sum)) throw new Error('bad summary: ' + sum);
    if (!(await page.isChecked('#bk-rereview'))) throw new Error('re-review not on by default');
    await layout('import dialog');
    await page.click('.dialog button:has-text("Replace")');
    await page.waitForSelector('.notice:has-text("Backup restored.")', { timeout: 30000 });
    await page.click('.nav button:has-text("Home")');
    await page.click('.tile[data-domain="money"]');
    await page.waitForSelector('.entry:has-text("Rent")');
    if (await page.locator('.entry:has-text("AfterBackup")').count()) throw new Error('backup import did not replace state');
    await page.click('.nav button:has-text("Memory")');
    if (await page.locator('.chip.ok').count()) throw new Error('approved insight survived re-review import');
  });
  await step('csv-person-mapping', async () => {
    await page.click('.nav button:has-text("Home")');
    await page.click('.tile[data-domain="social"]');
    await page.setInputFiles('#csv-file', { name: 'c.csv', mimeType: 'text/csv', buffer: Buffer.from('Date,Title,Who\r\n2026-11-02,Lunch,Priya\r\n') });
    await page.waitForSelector('#m-person');
    await page.click('button:has-text("Import rows")');
    await page.waitForSelector('.notice:has-text("Imported 1 rows. Rejected 0.")');
    await page.waitForSelector('.entry:has-text("Lunch")');
    await layout('social csv');
  });
  await step('lock-clears-dom', async () => {
    // Positive control: the same scan must see the data while unlocked, so a clean result after lock means something.
    await page.click('.nav button:has-text("Home")');
    await page.click('.tile[data-domain="money"]');
    await page.waitForSelector('.entry:has-text("Groceries")');
    const before = await domSecrets(['Groceries']);
    if (!before.hit.length || !before.tiles) throw new Error('scan cannot see unlocked data: ' + JSON.stringify(before));
    // And the app code itself carries the default category, so excluding <script> is what the check must do.
    if (!(await page.evaluate(() => [...document.scripts].some((x) => x.text.includes('Groceries'))))) throw new Error('expected Groceries in the app script');
    await page.click('.top button:has-text("Lock")');
    await assertLockedClean(['Groceries', 'Rent', 'HYPERLINK', 'One', 'Two']);
  });
  await step('auto-lock', async () => {
    await page.fill('#pass', PASS);
    await page.click('button:has-text("Unlock")');
    await page.waitForSelector('.tile', { timeout: 30000 });
    await page.click('.nav button:has-text("Settings")');
    await page.selectOption('#t-al', '1');
    await page.click('button:has-text("Save settings")');
    await page.waitForSelector('.notice:has-text("Settings saved.")');
    await page.click('.nav button:has-text("Home")');
    await page.click('.tile[data-domain="money"]');
    await page.waitForSelector('.entry:has-text("Groceries")');
    await page.clock.fastForward('00:30');
    if (!(await page.locator('.entry').count())) throw new Error('locked too early');
    await page.clock.fastForward('00:45');
    await assertLockedClean(['Groceries', 'Rent']);
    if (!/Unlock/.test(await bodyText())) throw new Error('lock screen missing');
  });
} catch { /* recorded */ }
await ctx.close();
}
await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.error('SMOKE FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE PASSED');
