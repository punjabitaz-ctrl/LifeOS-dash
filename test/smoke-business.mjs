// v1.1.0 smoke: business expenses, invoices and tax (desktop and 390x844). The scope migration, a 2026 profile with effective rates,
// business income on two lines (one a 1099 client line), expenses on several tax lines including meals, a billable expense added to an
// invoice that is sent and paid with the income counted once, trips either side of the mileage rate change, the home office, a payee over
// the 1099 threshold, a quarterly payment, every tax figure checked against hand-computed values, the print view and the export (with the
// unencrypted-file warning and its confirm), then the 1099 line moved into the private vault: closed, every tax figure refuses; lock and
// unlock, open again, and the same figures return. Fails on console errors, CSP violations, network requests or horizontal scroll.
// Run `node build.mjs` first. Needs Playwright and Chrome at /usr/bin/google-chrome.
import path from 'node:path';
import { navTo } from './_nav.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '..', 'dist', 'lifeos.html');
let pw;
try { pw = await import('playwright'); } catch { console.log('SKIPPED: playwright not available (npm i --no-save playwright)'); process.exit(0); }
let browser;
for (const o of [{ executablePath: '/usr/bin/google-chrome' }, { channel: 'chrome' }, {}]) {
  try { browser = await pw.chromium.launch(o); break; } catch { /* try next */ }
}
if (!browser) { console.log('SKIPPED: chromium unavailable'); process.exit(0); }

const PASS = 'correct horse battery staple', PRIV = 'a private passphrase 99';
const T = { timeout: 30000 };
const NOTICE = 'Estimate. Numbers only, not tax advice. Confirm with your accountant.';
const BLOCK = 'Open the private vault to see tax figures.';
const WARNING = 'This file is not encrypted. It contains your business records, payee names and mileage log. Store it somewhere safe.';
const usd = (c) => (c < 0 ? '-' : '') + '$' + (Math.floor(Math.abs(c) / 100)).toLocaleString('en-US') + '.' + String(Math.abs(c) % 100).padStart(2, '0');
const problems = [];

// Hand-computed expectations (cents). Income: seeded Acme 500.00 + Acme 6,000.00 + Podcast 4,000.00 = 10,500.00, plus the invoice
// 1,500.00 + 80.00 billable = 1,580.00 once received: 12,080.00. Expenses: supplies 1,000.00; meals 100.01 at 50% = 50.005 -> 50.01;
// advertising 250.00; travel 80.00; contract labor 2,500.00: 3,880.01. Mileage: 100 mi on 2026-06-30 at 72.5 = 72.50 and 100 mi on
// 2026-07-01 at 76 = 76.00: 148.50. Home office 300 sq ft x $5 x 12/12 = 1,500.00. Profit = 12,080.00 - 3,880.01 - 148.50 - 1,500.00 = 6,551.49.
// SE: net earnings 655,149 x 0.9235 = 605,030.1 -> 605,030; Social Security 75,023.7 -> 75,024; Medicare 17,545.9 -> 17,546; total 92,570;
// half 46,285; income tax base 608,864; federal 22% = 133,950.1 -> 133,950; NJ 5% of the profit (no half-SE deduction in NJ, SEC-75)
// 655,149 x 0.05 = 32,757.45 -> 32,757; set aside 92,570 + 133,950 + 32,757 = 259,277.
// Safe harbor (prior-year federal 5,000.00): 90% of (92,570 + 133,950) = 203,868.0 is below 100% of 5,000.00, so the target is 203,868, 50,967 a quarter.
const W = {
  income: 1208000, income0: 1050000, expenses: 388001, mileage: 14850, home: 150000, profit: 655149, se: 92570, ss: 75024, med: 17546, half: 46285, base: 608864,
  fed: 133950, nj: 32757, setaside: 259277, paidFed: 100000, q: 50967,
  lines: { supplies: 100000, meals: 5001, advertising: 25000, travel: 8000, contract: 250000, car: 14850, homeOffice: 150000 },
};
const TAXIDS = { 'tx-income': W.income, 'tx-expenses': W.expenses, 'tx-mileage': W.mileage, 'tx-home': W.home, 'tx-profit': W.profit, 'tx-se': W.se, 'tx-ss': W.ss, 'tx-medicare': W.med, 'tx-addl': 0, 'tx-half': W.half, 'tx-base': W.base, 'tx-fed': W.fed, 'tx-nj': W.nj, 'tx-setaside': W.setaside, 'tx-paid-fed': W.paidFed, 'tx-paid-nj': 0 };

async function run(label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true, acceptDownloads: true } : { viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) requests.push(r.url()); });
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
  const text = (sel) => page.textContent(sel).then((t) => t.trim());
  const eq = async (sel, want) => { const got = await text(sel); if (got !== want) throw new Error(sel + ' is ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want)); };
  const noHScroll = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
  };
  const autofillOff = async (where) => {
    const n = await page.evaluate(() => document.querySelectorAll('input:not([autocomplete=off]),textarea:not([autocomplete=off]),form:not([autocomplete=off])').length);
    if (n) throw new Error(where + ': ' + n + ' fields without autocomplete off');
  };
  const nav = (name) => navTo(page, name);
  const tab = async (t) => { await nav('Business'); await page.click('#bz-tab-' + t); await page.waitForSelector('#bz-tab-' + t + '[aria-pressed="true"]', T); await page.waitForTimeout(30); await noHScroll('business ' + t); await autofillOff('business ' + t); };
  const notice = (t) => page.waitForSelector('.notice:has-text("' + t + '")', T);
  const addEntry = async (type, title, value, o) => {
    await nav('Money'); await page.waitForSelector('#f-title', T);
    await page.selectOption('#f-type', type);
    await page.fill('#f-title', title); await page.fill('#f-value', String(value));
    if (o && o.cat) await page.selectOption('#f-cat', o.cat);
    if (o && o.line) await page.selectOption('#f-line', { label: o.line });
    if (o && o.scope) await page.selectOption('#f-scope', o.scope);
    if (o && o.billable) await page.check('#f-billable');
    if (o && o.payee) await page.selectOption('#f-payee', { label: o.payee });
    await page.click('button[type=submit]:has-text("Add entry")'); await notice('Entry added.');
  };
  const rowsOf = (sel) => page.$$eval(sel + ' tbody tr', (rs) => rs.map((r) => Array.from(r.children).map((c) => c.textContent.trim())));
  const checkFigures = async (where) => {
    for (const [id, c] of Object.entries(TAXIDS)) await eq('#' + id, usd(c));
    await eq('#tx-reserve', 'no reserve account chosen');
    const notices = await page.$$eval('#business .tax-notice', (n) => n.map((x) => x.textContent.trim()));
    if (!notices.length || notices.some((x) => x !== NOTICE)) throw new Error(where + ': notice wrong ' + JSON.stringify(notices));
  };
  try {
    await page.clock.install({ time: new Date(2026, 10, 14, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('create the vault and load a schema 11 copy (the scope migration)', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")'); await page.waitForSelector('.tile', T);
      await page.evaluate(`(async () => {
        const L = globalThis.LifeOS, s = L.store.defaultState();
        s.schema = 11; delete s.settings.business; for (const k of ['payees', 'invoices', 'trips', 'taxPayments', 'taxYears', 'homeOffice', 'taxMap']) delete s[k];
        s.projects.push({ id: 'acme', name: 'Acme', kind: 'client', status: 'active', nextAction: '', archived: false }, { id: 'pod', name: 'Podcast', kind: 'podcast', status: 'active', nextAction: '', archived: false }, { id: 'job', name: 'Day job', kind: 'job', status: 'active', nextAction: '', archived: false });
        s.entries.push(L.metrics.validateEntry({ id: 'm1', domain: 'money', type: 'income', date: '2026-01-15', title: 'Seed Acme income', value: 500, projectId: 'acme' }),
          L.metrics.validateEntry({ id: 'm2', domain: 'money', type: 'income', date: '2026-02-01', title: 'Pay', value: 3000, projectId: 'job' }),
          L.metrics.validateEntry({ id: 'm3', domain: 'money', type: 'expense', date: '2026-02-02', title: 'Groceries', value: 100 }));
        await L.store.replaceState(s);
      })()`);
      await tab('tax');
      await eq('#bz-scope-counts', 'Money entries marked business: 1. Marked personal: 2. An entry on a venture, client, website or podcast line of work is business; everything else is personal. Change any entry under Entries.');
      await page.click('#bz-scope-confirm'); await page.waitForSelector('#bz-scope-banner', { state: 'detached', ...T });
      const sc = await page.evaluate(() => globalThis.LifeOS.store.getState().entries.map((e) => e.id + ':' + e.scope).join());
      if (sc !== 'm1:business,m2:personal,m3:personal') throw new Error('scopes ' + sc);
    });
    await step('business categories and a payee', async () => {
      await tab('settings'); await page.click('#bs-addcats'); await notice('Categories added.');
      await page.fill('#bs-name', 'Smoke Biz LLC'); await page.click('#bs-save'); await notice('Saved.');
      await tab('payees'); await page.fill('#pe-name', 'Dana Design'); await page.click('button:has-text("Add payee")'); await notice('Payee added.');
      await page.fill('#pe-name', '123-45-6789'); await page.click('button:has-text("Add payee")');
      await page.waitForSelector('.notice.err', T);
      if ((await page.textContent('.notice')).includes('123-45')) throw new Error('the refusal echoes the ID');
      if ((await page.$$('#pe-card .item')).length !== 1) throw new Error('an SSN-shaped payee was added');
    });
    await step('business income on two lines and expenses on several tax lines', async () => {
      await addEntry('income', 'Acme retainer', 6000, { line: 'Acme' });
      await addEntry('income', 'Podcast sponsor', 4000, { line: 'Podcast' });
      await addEntry('expense', 'Printer paper', 1000, { cat: 'Supplies', line: 'Podcast' });
      await addEntry('expense', 'Client lunch', 100.01, { cat: 'Meals', line: 'Acme' });
      await addEntry('expense', 'Ad campaign', 250, { cat: 'Advertising', scope: 'business' });
      await addEntry('expense', 'Billable travel', 80, { cat: 'Travel', line: 'Acme', billable: true });
      await addEntry('expense', 'Design work', 2500, { cat: 'Contract labor', scope: 'business', payee: 'Dana Design' });
      await tab('tax'); await eq('#tx-income', usd(W.income0));
    });
    await step('an invoice: a billable expense added, sent, paid, and the income counted once', async () => {
      await tab('invoices');
      await page.selectOption('#iv-line', { label: 'Acme' }); await page.fill('#iv-desc', 'Consulting'); await page.fill('#iv-qty', '10'); await page.fill('#iv-unit', '150');
      await page.click('button:has-text("Add invoice")'); await page.waitForSelector('#inv-detail[data-status="draft"]', T);
      await page.click('#inv-billable button:has-text("Add to invoice")'); await notice('Added.');
      await eq('#inv-total', usd(158000));
      await page.click('#inv-sent'); await page.waitForSelector('#inv-detail[data-status="sent"]', T);
      if ((await page.evaluate(() => globalThis.LifeOS.store.getState().entries.filter((e) => /^Invoice /.test(e.title)).length)) !== 0) throw new Error('sending created income');
      await page.click('#inv-make-income'); await notice('Expected income created.');
      await tab('tax'); await eq('#tx-income', usd(W.income0));
      await tab('invoices'); await page.click('#inv-list .item button:has-text("Open")'); await page.waitForSelector('#inv-detail', T);
      await page.click('#inv-paid'); await page.click('.dialog button:has-text("Mark paid")'); await page.waitForSelector('#inv-detail[data-status="paid"]', T);
      await tab('tax'); await eq('#tx-income', usd(W.income0));
      await tab('invoices'); await page.click('#inv-list .item button:has-text("Open")'); await page.click('#inv-settle'); await notice('Income counted.');
      const inv = await page.evaluate(() => globalThis.LifeOS.store.getState().entries.filter((e) => /^Invoice /.test(e.title)).map((e) => [e.status || 'received', e.value]));
      if (JSON.stringify(inv) !== '[["received",1580]]') throw new Error('invoice income ' + JSON.stringify(inv));
      await tab('tax'); await eq('#tx-income', usd(W.income));
    });
    await step('trips either side of the rate change, and the home office', async () => {
      await tab('mileage');
      for (const [i, d] of ['2026-06-30', '2026-07-01'].entries()) {
        await page.fill('#tr-date', d); await page.fill('#tr-from', 'Office'); await page.fill('#tr-to', 'Client'); await page.fill('#tr-miles', '100'); await page.fill('#tr-purpose', 'Visit');
        await page.click('button:has-text("Log trip")'); await page.waitForFunction((n) => document.querySelector('#mi-count') && document.querySelector('#mi-count').textContent.trim() === n, String(i + 1), T);
      }
      await eq('#mi-count', '2');
      if (!(await text('#mi-norate')).includes('Start the 2026 tax profile')) throw new Error('no-profile hint missing');
      await page.fill('#ho-sqft', '300'); await page.fill('#ho-months', '12'); await page.click('#ho-save'); await notice('Home office saved.');
    });
    await step('the 2026 profile with effective rates and a prior-year figure; a quarterly payment', async () => {
      await tab('tax'); await page.click('#pf-start'); await notice('Profile started.');
      await eq('#tx-fed', 'set your rate'); await eq('#tx-nj', 'set your rate'); await eq('#tx-setaside', 'set your rate');
      await page.click('#pf-card > summary');
      await page.fill('#pf-federalEffectiveRate', '22'); await page.fill('#pf-njEffectiveRate', '5'); await page.fill('#pf-priorYearFederalTax', '5000');
      await page.click('#pf-save'); await notice('Profile saved.');
      await page.selectOption('#pay-juris', 'federal'); await page.selectOption('#pay-q', '2'); await page.fill('#pay-amount', '1000'); await page.fill('#pay-date', '2026-06-10');
      await page.click('button:has-text("Log payment")'); await notice('Payment logged.');
    });
    await step('every tax figure matches the hand-computed values', async () => {
      await tab('tax'); await checkFigures('tax');
      const sh = await rowsOf('#safe-table');
      if (JSON.stringify(sh[0].slice(0, 1).concat(sh[0].slice(3))) !== JSON.stringify(['Federal', usd(203868), usd(W.q), usd(W.q), usd(W.q), usd(W.q), usd(W.paidFed), usd(203868 - W.paidFed)])) throw new Error('safe harbor ' + JSON.stringify(sh));
      const sc = Object.fromEntries((await rowsOf('#sc-table')).map((r) => [r[0], r[2]]));
      const want = { 'Gross receipts': W.income, Supplies: W.lines.supplies, Meals: W.lines.meals, Advertising: W.lines.advertising, Travel: W.lines.travel, 'Contract labor': W.lines.contract, 'Car and truck (mileage log)': W.lines.car, 'Home office (home-office log)': W.lines.homeOffice, 'Unmapped expenses': 0, 'Total deductions': W.expenses + W.mileage + W.home, 'Net profit': W.profit };
      for (const [k, c] of Object.entries(want)) if (sc[k] !== usd(c)) throw new Error('Schedule C ' + k + ' is ' + sc[k] + ', expected ' + usd(c));
      const lw = (await rowsOf('#sc-lines')).map((r) => r.join('|'));
      const wl = [['Acme', 808000, 13001, 0, 0, 794999], ['Podcast', 400000, 100000, 0, 0, 300000], ['No line of work', 0, 275000, 14850, 150000, -439850]].map((r) => [r[0]].concat(r.slice(1).map(usd)).join('|'));
      if (JSON.stringify(lw) !== JSON.stringify(wl)) throw new Error('by line of work ' + JSON.stringify(lw));
      const due = (await rowsOf('#due-table')).map((r) => r.join('|'));
      if (!due.includes('Federal|Quarter 2|2026-06-15|' + usd(W.paidFed)) || !due.includes('1099-NEC filing||2027-02-01 (moved from 2027-01-31)|')) throw new Error('due dates ' + JSON.stringify(due));
      await tab('payees');
      const pt = await page.getAttribute('#pe-card .item', 'data-payee-total');
      if (pt !== '250000') throw new Error('payee total ' + pt);
      if (!(await text('#pe-card .item')).includes('At or over the threshold')) throw new Error('payee not flagged over the 1099 threshold');
      await tab('mileage'); await eq('#mi-total', usd(W.mileage)); await eq('#ho-result', usd(W.home));
      await nav('Home'); await page.waitForSelector('#mod-taxset', T);
      await eq('#mod-setaside', usd(W.setaside)); await eq('#mod-inv-n', '0'); await noHScroll('dashboard');
    });
    await step('the print view and the export (with the unencrypted-file warning and a confirm)', async () => {
      await tab('export'); await eq('#ex-warning', WARNING);
      await page.click('#ex-print'); await page.waitForSelector('#print-tax', T);
      await eq('#pv-warning', WARNING);
      const first = await page.$eval('#print-tax', (n) => n.firstElementChild.id); if (first !== 'pv-warning') throw new Error('the warning is not at the top');
      const notes = await page.$$eval('#print-tax .tax-notice', (n) => n.map((x) => x.textContent.trim())); if (!notes.length || notes.some((x) => x !== NOTICE)) throw new Error('print notice ' + JSON.stringify(notes));
      const pv = Object.fromEntries((await rowsOf('#pv-sc')).map((r) => [r[0], r[1]]));
      if (pv['Net profit'] !== usd(W.profit) || pv['Gross receipts'] !== usd(W.income)) throw new Error('print figures ' + JSON.stringify(pv));
      await noHScroll('print view'); await page.click('#pv-back'); await page.waitForSelector('#ex-download', T);
      await page.click('#ex-download'); await page.waitForSelector('#ex-confirm-text', T); await eq('#ex-confirm-text', WARNING);
      const [dl] = await Promise.all([page.waitForEvent('download', T), page.click('.dialog button:has-text("Download")')]);
      const csv = readFileSync(await dl.path(), 'utf8');
      for (const w of [NOTICE, '"Net profit","31","' + (W.profit / 100).toFixed(2) + '"', '"Gross receipts","1","' + (W.income / 100).toFixed(2) + '"', 'Dana Design', '"Meals","24b","50.01"']) if (!csv.includes(w)) throw new Error('export lacks ' + w);
      await tab('invoices'); await page.click('#inv-list .item button:has-text("Open")'); await page.click('#inv-print'); await page.waitForSelector('#print-invoice', T);
      if (!(await text('#print-invoice')).includes('Smoke Biz LLC') || (await text('#pv-total')) !== 'Total ' + usd(158000)) throw new Error('invoice print view');
      await noHScroll('invoice print');
    });
    await step('the 1099 client line moved into the private vault and closed: every tax figure refuses', async () => {
      await nav('Home'); await page.click('#nav-private'); await page.waitForSelector('#priv-set1', T);
      await page.fill('#priv-set1', PRIV); await page.fill('#priv-set2', PRIV); await page.click('#priv-setup-btn'); await page.waitForSelector('#priv-bar', T);
      await page.waitForSelector('#priv-rk-prompt', { timeout: 30000 }); await page.click('.dialog button:has-text("Later")');   // v1.8.0: the private recovery key prompt
      await page.selectOption('#priv-coll', 'projects');
      await page.click('.priv-row:has-text("Acme") button:has-text("Move to private vault")'); await page.click('.dialog button:has-text("Move in")');
      await page.waitForSelector('.notice:has-text("Moved to the private vault.")', T);
      await page.click('#priv-close'); await page.waitForSelector('#priv-bar', { state: 'detached', ...T });
      for (const t of ['tax', 'mileage', 'payees', 'export']) {
        await tab(t);
        await eq('#business .tax-blocked', BLOCK);
        if (!(await page.$('#business .tax-blocked .lockmark'))) throw new Error(t + ': no lock marker');
        for (const id of Object.keys(TAXIDS).concat(['tx-card', 'sc-table', 'ex-download', 'mi-total', 'ho-result'])) if (await page.$('#' + id)) throw new Error(t + ': ' + id + ' shown while closed');
        if ((await page.$$eval('#business .tax-notice', (n) => n.map((x) => x.textContent.trim()))).some((x) => x !== NOTICE)) throw new Error('notice');
      }
      await nav('Home'); await page.waitForSelector('#dash-grid', T);
      if (await page.$('#mod-setaside')) throw new Error('the dashboard still shows the set-aside');
      if (!(await page.textContent('#dash-grid')).includes(BLOCK)) throw new Error('the dashboard modules do not refuse');
      const dg = await page.evaluate(() => JSON.stringify(globalThis.LifeOS.metrics.weeklyDigest(globalThis.LifeOS.store.getState(), '2026-11-09').business || null));
      if (/"tax"|profitCents|estimatedTaxCents|gapCents/.test(dg)) throw new Error('the digest carries tax fields: ' + dg);
    });
    await step('lock and unlock, still refused; open the vault and the figures return; reload keeps them', async () => {
      await page.click('.top .lockbtn'); await page.waitForSelector('#pass', T);
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
      await tab('tax'); await eq('#business .tax-blocked', BLOCK);
      await page.click('#nav-private'); await page.fill('#priv-pass', PRIV); await page.click('#priv-open'); await page.waitForSelector('#priv-bar', T);
      await tab('tax'); await checkFigures('after unlock');
      // SEC-78: with the vault open the export leaves private records out by default, and refuses because the totals would be incomplete
      await tab('export'); await page.waitForSelector('#ex-private', T);
      if (await page.isChecked('#ex-private')) throw new Error('include private records is ticked by default');
      await page.waitForSelector('#ex-left-out', T); if (await page.$('#ex-download')) throw new Error('export offered with private records left out');
      await page.click('#ex-private'); await page.waitForSelector('#ex-download', T);
      if (!(await page.textContent('#ex-private-note')).includes('included')) throw new Error('the export does not say private records are included');
      await page.click('#ex-print'); await page.waitForSelector('#print-tax', T);
      if (!(await page.textContent('#print-tax')).includes('Acme')) throw new Error('ticked print view lacks the private line of work');
      await page.click('#pv-back'); await page.waitForSelector('#ex-left-out', T);
      await page.reload(); await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
      await tab('tax'); await eq('#business .tax-blocked', BLOCK);
      await page.click('#nav-private'); await page.fill('#priv-pass', PRIV); await page.click('#priv-open'); await page.waitForSelector('#priv-bar', T);
      await tab('tax'); await checkFigures('after reload');
      const st = await page.evaluate(() => { const s = globalThis.LifeOS.store.getState(); return [s.settings.business.scopeConfirmed, s.trips.length, s.taxPayments.length, Object.keys(s.taxYears).join(), s.homeOffice['2026'].monthsUsed].join(); });
      if (st !== 'true,2,1,2026,12') throw new Error('persisted state ' + st);
      if (requests.length) throw new Error('network requests: ' + requests.join(', '));
    });
  } catch (e) { if (!problems.some((p) => p.includes(String(e.message).split('\n')[0]))) problems.push(label + ' ' + e.message); }
  await ctx.close();
}
await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-BUSINESS FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-BUSINESS PASSED');
