import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '..', 'dist', 'lifeos.html');
let pw;
try { pw = await import('playwright'); } catch { console.log('SKIPPED: playwright not available (npm i --no-save playwright)'); process.exit(0); }
let browser;
for (const o of [{}, { channel: 'chrome' }, { executablePath: '/usr/bin/google-chrome' }]) {
  try { browser = await pw.chromium.launch(o); break; } catch { /* try next */ }
}
if (!browser) { console.log('SKIPPED: chromium unavailable'); process.exit(0); }

const PASS = 'correct horse battery staple';
const usd = (c) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(c / 100);
const pct = (r) => (Math.round(r * 1000) / 10) + '%';
// Hand-computed expectations, all in integer cents.
const ACCT = { checking: 600010, brokerage: 1200050, visa: 125025 };       // checking is updated from 5000.00 to 6000.10
const ASSETS = ACCT.checking + ACCT.brokerage, LIAB = ACCT.visa, NET = ASSETS - LIAB;   // 1800060, 125025, 1675035
const INC = 400000, SPEND0 = 12010 + 4520 + 120000 + 1555;                  // 138085
const RATE0 = (INC - SPEND0) / INC, SPEND1 = SPEND0 + 3000, RATE1 = (INC - SPEND1) / INC;
const problems = [];

async function run(label, viewport) {
  const mobile = !!viewport;
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n')[0]); throw e; } }
  const noHScroll = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
  };
  const text = (sel) => page.textContent(sel).then((t) => t.trim());
  const expectText = async (sel, want) => { const got = await text(sel); if (got !== want) throw new Error(sel + ' is ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want)); };
  const nav = (name) => page.click('.nav button:has-text("' + name + '")');
  const quick = async (type, amount, cat, note) => {
    await page.click('#quick-add');
    await page.waitForSelector('.dialog #qa-amount');
    if (type === 'income') await page.click('#qa-income');
    await page.fill('#qa-amount', amount);
    if (cat) await page.click('#qa-chips button:has-text("' + cat + '")');
    if (note) await page.fill('#qa-note', note);
    await page.click('.dialog button:has-text("Save")');
    await page.waitForSelector('.dialog', { state: 'detached' });
    await page.waitForSelector('.notice:has-text("saved")');
  };
  const addAccount = async (name, kind, bal) => {
    await page.fill('#ac-name', name); await page.selectOption('#ac-kind', kind); await page.fill('#ac-bal', bal);
    await page.click('#ac-add');
    await page.waitForSelector('.notice:has-text("Account added.")');
    await page.waitForSelector('.acct[data-account="' + name + '"]');
  };
  try {
    await page.goto(pathToFileURL(file).href);
    await step('create', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")');
      await page.waitForSelector('.tile', { timeout: 30000 });
      await noHScroll('dashboard');
    });
    await step('quick-add reachable in one tap', async () => {
      const b = await page.locator('#quick-add').boundingBox();
      const ih = await page.evaluate(() => window.innerHeight);
      if (!b || b.y < 0 || b.y + b.height > ih) throw new Error('quick add not visible without scrolling');
      await page.click('#quick-add');
      await page.waitForSelector('.dialog #qa-amount');
      if (!(await page.locator('#qa-amount').evaluate((e) => e === document.activeElement))) throw new Error('amount not focused');
      const d = await page.locator('.dialog').boundingBox();
      if (d.x < 0 || d.x + d.width > (await page.evaluate(() => window.innerWidth))) throw new Error('dialog overflows');
      await page.click('.dialog button:has-text("Cancel")');
    });
    await step('accounts', async () => {
      await nav('Assets');
      await page.waitForSelector('#ac-name');
      await noHScroll('assets empty');
      await addAccount('Checking', 'cash', '5000.00');
      await addAccount('Brokerage', 'investment', '12000.50');
      await addAccount('Visa', 'credit', '1250.25');
      await noHScroll('assets accounts');
    });
    await step('balance update', async () => {
      await page.selectOption('#bal-acct', { label: 'Checking' });
      await page.fill('#bal-value', '6000.10');
      await page.click('#bal-save');
      await page.waitForSelector('.notice:has-text("Balance saved.")');
      await expectText('#aw-net', usd(NET)); await expectText('#aw-assets', usd(ASSETS)); await expectText('#aw-liab', usd(LIAB));
      if ((await page.locator('svg.chart').count()) !== 1) throw new Error('net worth chart missing');
      if ((await page.locator('svg.alloc rect').count()) !== 2) throw new Error('allocation should have 2 kinds');
      const al = await text('.alloc-row >> nth=0');
      if (!al.includes('Investment') || !al.includes(Math.round(ACCT.brokerage / ASSETS * 1000) / 10 + '%')) throw new Error('allocation row wrong: ' + al);
      await noHScroll('assets');
    });
    await step('quick-add money', async () => {
      await nav('Home');
      await page.waitForSelector('#quick-add');
      await quick('income', '4000', 'Salary');
      await quick('expense', '120.10', 'Groceries');
      await quick('expense', '45.20', 'Groceries');
      await quick('expense', '1200.00', 'Housing', 'Rent');
      await quick('expense', '15.55');
    });
    await step('dashboard tiles', async () => {
      const m = await text('.tile[data-domain="money"] .tile-value');
      if (m !== pct(RATE0)) throw new Error('money tile ' + m + ' expected ' + pct(RATE0));
      const a = await text('.tile[data-domain="assets"] .tile-value');
      const want = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.round(NET / 100));
      if (a !== want) throw new Error('assets tile ' + a + ' expected ' + want);
    });
    await step('month view and budget', async () => {
      await nav('Money');
      await page.waitForSelector('#mv-income');
      await expectText('#mv-income', usd(INC)); await expectText('#mv-spend', usd(SPEND0));
      await expectText('#mv-net', usd(INC - SPEND0)); await expectText('#mv-rate', pct(RATE0));
      await noHScroll('money');
      await page.click('#budgets summary');
      await page.selectOption('#bud-cat', 'Groceries');
      await page.fill('#bud-amount', '150');
      await page.click('button:has-text("Save budget")');
      await page.waitForSelector('.notice:has-text("Budget saved.")');
      const row = await text('.catrow:has-text("Groceries")');
      if (!row.includes(usd(16530) + ' of ' + usd(15000)) || !row.includes('Over budget by ' + usd(1530))) throw new Error('budget row wrong: ' + row);
      if ((await page.locator('svg.chart').count()) !== 1) throw new Error('cash-flow chart missing');
      await noHScroll('money budget');
    });
    await step('recurring proposes, confirm posts', async () => {
      await page.click('#recurring summary');
      await page.fill('#rc-title', 'Gym'); await page.fill('#rc-amount', '30');
      await page.selectOption('#rc-cat', 'Health');
      await page.click('button:has-text("Add recurring")');
      await page.waitForSelector('#due-card:has-text("Gym")');
      await expectText('#mv-spend', usd(SPEND0));          // proposed, never auto-posted
      await nav('Home');
      await page.waitForSelector('#due-review');
      await page.click('#due-review');
      await page.waitForSelector('#due-card');
      await page.click('#due-card button:has-text("Confirm")');
      await page.waitForSelector('.notice:has-text("Posted Gym.")');
      if (await page.locator('#due-card').count()) throw new Error('due card still shown after confirm');
      await expectText('#mv-spend', usd(SPEND1)); await expectText('#mv-net', usd(INC - SPEND1)); await expectText('#mv-rate', pct(RATE1));
      await noHScroll('money after confirm');
    });
    await step('lock and unlock', async () => {
      await page.click('.top button:has-text("Lock")');
      await page.waitForSelector('#pass');
      const t = await page.evaluate(() => document.getElementById('app').textContent);
      if (/Checking|Visa|Gym|Brokerage/.test(t)) throw new Error('data visible while locked');
      await page.fill('#pass', PASS);
      await page.click('button:has-text("Unlock")');
      await page.waitForSelector('.tile', { timeout: 30000 });
      await nav('Money');
      await expectText('#mv-spend', usd(SPEND1)); await expectText('#mv-rate', pct(RATE1));
      await nav('Assets');
      await expectText('#aw-net', usd(NET)); await expectText('#aw-liab', usd(LIAB));
      await page.waitForSelector('.acct[data-account="Visa"]');
      await noHScroll('assets after unlock');
    });
  } catch { /* recorded */ }
  await ctx.close();
}
await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.error('SMOKE-MONEY FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-MONEY PASSED');
