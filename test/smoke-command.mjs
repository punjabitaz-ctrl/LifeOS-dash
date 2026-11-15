// v0.12.0 smoke: command center. Lines of work, revenue per line / rollup / Unassigned against hand-computed values and the Money totals,
// expected income, ledger CSV import (preview, import, re-import is a no-op), customizable home (drag and Move buttons, hide, per width),
// a line moved into the private vault, lock and unlock. Desktop and 390x844. Run `node build.mjs` first.
import path from 'node:path';
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

const PASS = 'correct horse battery staple', PRIV = 'a separate private passphrase 77';
const T = { timeout: 15000 };
const problems = [];
const MARK = 'Some private items are hidden';
// The ledger the test writes: mixed date formats, brackets, a thousands separator, an unknown line (Newsletter), one bad row.
const CSV = ['Date,Line,Category,Description,Amount', '2026-11-10,Client Co,Business,Consulting,"$1,000.00"', '11/11/2026,website,Hosting,Hosting fee,(19.99)', '2026-11-12,,Other,Coffee,(5.50)', '11/13/2026,Newsletter,Business,Sponsor,200.00', '2026-13-45,Podcast,,Bad date,5'].join('\n');
// Hand-computed (cents). Entries added by form: Client Co +2000 -300, expected 1500 due 11-20; Website +400 -50.25, expected 500 due 11-10 (overdue);
// Podcast +99.99 -40; Unassigned +25. CSV adds: Client Co +1000, Website -19.99, Unassigned -5.50 and +200 (Newsletter is not created).
const BEFORE = { client: [300000, 30000], web: [40000, 7024], pod: [9999, 4000], un: [22500, 550], ayin: [340000 + 40000 - 40000, 0] };
const WANT = {
  client: { rev: 300000, exp: 30000 }, web: { rev: 40000, exp: 7024 }, pod: { rev: 9999, exp: 4000 }, un: { rev: 22500, exp: 550 },
  rollup: { rev: 340000, exp: 37024 }, total: { rev: 372499, exp: 41574 }
};
void BEFORE;

async function run(label, viewport) {
  const size = viewport || { width: 1280, height: 900 };
  const other = viewport ? { width: 1280, height: 900 } : { width: 390, height: 844 };
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: size });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  page.on('request', (r) => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) requests.push(r.url()); });
  async function step(name, fn) { if (process.env.SMOKE_VERBOSE) console.log(label, 'step:', name); try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); if (process.env.SMOKE_VERBOSE) console.log(problems[problems.length - 1]); throw e; } }
  const nav = (name) => page.click('.nav button:has-text("' + name + '")');
  const text = (sel) => page.textContent(sel).then((t) => t.trim());
  const poll = async (get, good, what, tries = 60) => {
    let got;
    for (let i = 0; i < tries; i++) { try { got = await get(); if (good(got)) return got; } catch (e) { got = String(e.message).split('\n')[0]; } await page.waitForTimeout(100); }
    throw new Error(what + ' is ' + JSON.stringify(got));
  };
  const noHScroll = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
  };
  const cents = (t) => { const neg = /[-(]/.test(t); const n = Math.round(parseFloat(t.replace(/[^0-9.]/g, '')) * 100); return neg ? -n : n; };
  const expectCents = (sel, want) => poll(() => text(sel).then(cents), (g) => g === want, sel + ' (expected ' + want + ')');
  const row = (table, name) => '#' + table + ' tr[data-line="' + name + '"]';
  const rowCents = (table, name, col) => expectRow(table, name, col);
  async function expectRow(table, name, col, want) {
    const sel = row(table, name) + ' .' + col;
    if (want === undefined) return poll(() => text(sel).then(cents), () => true, sel);
    return expectCents(sel, want);
  }
  void rowCents;
  const checkLine = async (name, v) => { await expectRow('rev-lines', name, 'c-rev', v.rev); await expectRow('rev-lines', name, 'c-exp', v.exp); await expectRow('rev-lines', name, 'c-net', v.rev - v.exp); };
  const addProject = async (name, kind, parent) => {
    if (!(await page.locator('#pj-name').isVisible())) await page.click('#pj-new summary');
    await page.fill('#pj-name', name); await page.selectOption('#pj-kind', kind);
    if (parent) await page.selectOption('#pj-parent', { label: parent });
    await page.click('#pj-add');
    await page.waitForSelector('.proj[data-project="' + name + '"]', T);
  };
  const addMoney = async (type, title, value, date, line, expected, due) => {
    await nav('Money'); await page.waitForSelector('#f-type', T);
    await page.selectOption('#f-type', type);
    await page.fill('#f-date', date); await page.fill('#f-title', title); await page.fill('#f-value', String(value));
    if (line) await page.selectOption('#f-line', { label: line === 'Podcast' ? line : line + ' (under AYiN Advisors)' });
    if (expected) { await page.selectOption('#f-mstatus', 'expected'); await page.fill('#f-mdue', due); }
    await page.click('button:has-text("Add entry")');
    await page.waitForSelector('.entry[data-key] .entry-t:has-text("' + title + '")', T).catch(() => page.waitForSelector('.entry-t:has-text("' + title + '")', T));
  };
  const revenue = async () => {
    await nav('Work'); await page.waitForSelector('#open-revenue', T); await page.click('#open-revenue');
    await page.waitForSelector('#rev-lines', T);
  };
  const moneyMonth = () => page.evaluate(() => { const m = globalThis.LifeOS.metrics.monthView(globalThis.LifeOS.priv.isOpen() ? globalThis.LifeOS.priv.view(globalThis.LifeOS.store.getState()) : globalThis.LifeOS.store.getState(), '2026-11'); return { inc: m.incomeCents, exp: m.spendCents }; });
  const order = () => page.$$eval('#dash-grid .mod', (els) => els.map((e) => e.getAttribute('data-mod')));
  const dash = async () => { await nav('Home'); await page.waitForSelector('#dash-grid', T); };
  const unlock = async () => { await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('#dash-grid, .tile', T); };
  const defaultOrder = ['glance', 'priorities', 'tile-money', 'tile-assets', 'tile-work', 'tile-health', 'tile-activities', 'tile-social', 'tile-learning', 'tile-home', 'tile-admin', 'tile-goals', 'tile-wellbeing', 'rev-month', 'rev-net-line', 'rev-expected'];
  try {
    await page.clock.install({ time: new Date(2026, 10, 14, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('create the vault', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")');
      await page.waitForSelector('#dash-grid', T);
      await noHScroll('dashboard');
    });
    await step('AYiN Advisors venture with a client and a website under it, plus a podcast', async () => {
      await nav('Work'); await page.waitForSelector('#pj-new', T);
      await addProject('AYiN Advisors', 'venture');
      await addProject('Client Co', 'client', 'AYiN Advisors');
      await addProject('Website', 'website', 'AYiN Advisors');
      await addProject('Podcast', 'podcast');
      const chip = await text('.proj[data-project="Website"] .chip:has-text("under")');
      if (chip !== 'under AYiN Advisors') throw new Error('parent chip is ' + chip);
      await noHScroll('work');
    });
    await step('received and expected income and expenses on each line', async () => {
      await addMoney('income', 'Client fee', 2000, '2026-11-03', 'Client Co');
      await addMoney('expense', 'Client costs', 300, '2026-11-04', 'Client Co');
      await addMoney('income', 'Invoice 7', 1500, '2026-11-01', 'Client Co', true, '2026-11-20');
      await addMoney('income', 'Site sale', 400, '2026-11-05', 'Website');
      await addMoney('expense', 'Site tools', 50.25, '2026-11-06', 'Website');
      await addMoney('income', 'Invoice 8', 500, '2026-11-01', 'Website', true, '2026-11-10');
      await addMoney('income', 'Sponsor', 99.99, '2026-11-07', 'Podcast');
      await addMoney('expense', 'Mic', 40, '2026-11-08', 'Podcast');
      await addMoney('income', 'Gift', 25, '2026-11-02', '');
      await noHScroll('money');
      const m = await moneyMonth();
      if (m.inc !== 200000 + 40000 + 9999 + 2500 || m.exp !== 30000 + 5025 + 4000) throw new Error('Money month is ' + JSON.stringify(m) + ' (expected income must not count)');
    });
    await step('import a ledger CSV: preview writes nothing, confirm, then re-import adds nothing', async () => {
      await revenue();
      const before = await page.evaluate(() => globalThis.LifeOS.store.getState().entries.length);
      await page.setInputFiles('#ledger-file', { name: 'ledger.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
      await page.waitForSelector('#ledger-preview', T);
      await page.click('#ledger-preview');
      await page.waitForSelector('#ledger-summary', T);
      const sum = await text('#ledger-summary');
      if (sum !== '4 to add, 1 rejected, 0 already imported.') throw new Error('summary is ' + sum);
      if (!(await text('#ledger-rejected')).includes('Row 6')) throw new Error('rejected row not listed');
      if (!(await text('#ledger-unknown-h')).includes('not lines of work yet')) throw new Error('unknown line not offered');
      if (await page.locator('#ledger-create-0').isChecked()) throw new Error('an unknown line must not be pre-ticked');
      if (cents(await text('#ledger-totals')) !== 120000) throw new Error('totals ' + await text('#ledger-totals'));
      if ((await page.evaluate(() => globalThis.LifeOS.store.getState().entries.length)) !== before) throw new Error('the preview wrote entries');
      if ((await page.evaluate(() => globalThis.LifeOS.store.getState().projects.length)) !== 4) throw new Error('the preview created a line');
      await noHScroll('ledger preview');
      await page.click('#ledger-confirm');
      await page.waitForSelector('.notice:has-text("Imported 4 entries.")', T);
      if ((await page.evaluate(() => globalThis.LifeOS.store.getState().projects.length)) !== 4) throw new Error('a line was created without being asked');
      const after = await page.evaluate(() => globalThis.LifeOS.store.getState().entries.length);
      if (after !== before + 4) throw new Error('entries ' + before + ' -> ' + after);
      await page.setInputFiles('#ledger-file', { name: 'ledger.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
      await page.waitForSelector('#ledger-preview', T); await page.click('#ledger-preview');
      await poll(() => text('#ledger-summary'), (g) => g === '0 to add, 1 rejected, 4 already imported.', 'second preview');
      if (!(await page.locator('#ledger-confirm').isDisabled())) throw new Error('re-import must have nothing to confirm');
      await page.click('#ledger-cancel');
      if ((await page.evaluate(() => globalThis.LifeOS.store.getState().entries.length)) !== after) throw new Error('re-import added entries');
    });
    await step('Revenue view: per line, rollup and Unassigned equal the hand-computed values and the Money totals', async () => {
      await checkLine('Client Co', WANT.client); await checkLine('Website', WANT.web); await checkLine('Podcast', WANT.pod); await checkLine('Unassigned', WANT.un);
      await expectRow('rev-rollups', 'AYiN Advisors', 'c-rev', WANT.rollup.rev); await expectRow('rev-rollups', 'AYiN Advisors', 'c-exp', WANT.rollup.exp);
      await expectCents('#rev-lines tr[data-total] .c-rev', WANT.total.rev); await expectCents('#rev-lines tr[data-total] .c-exp', WANT.total.exp);
      await expectCents('#rv-revenue', WANT.total.rev); await expectCents('#rv-net', WANT.total.rev - WANT.total.exp);
      const m = await moneyMonth();
      if (m.inc !== WANT.total.rev || m.exp !== WANT.total.exp) throw new Error('Money totals ' + JSON.stringify(m) + ' differ from the Revenue total');
      const margin = await text(row('rev-lines', 'Client Co') + ' .c-margin');
      if (margin !== '90.00%') throw new Error('Client Co margin ' + margin);
      await page.click(row('rev-lines', 'Client Co') + ' button:has-text("Details")');
      await expectCents('#rd-revenue', 300000); await expectCents('#rd-expenses', 30000);
      await expectCents('#rd-n30', 150000);
      await page.selectOption('#rv-period', 'ytd');
      await expectCents('#rev-lines tr[data-total] .c-rev', WANT.total.rev);
      await page.selectOption('#rv-period', 'month');
      await noHScroll('revenue');
    });
    await step('mark expected income received; Revenue and Money both move, overdue clears', async () => {
      await dash();
      await poll(() => text('#de-overdue'), (g) => g.startsWith('1 overdue'), 'overdue before');
      await expectCents('#de-next30', 150000);
      await nav('Money'); await page.waitForSelector('.entry-t:has-text("Invoice 8")', T);
      await page.click('button[aria-label="Mark Invoice 8 received"]');
      await page.waitForSelector('#rcv-date', T);
      await page.click('.dialog button:has-text("Mark received")');
      await page.waitForSelector('.notice:has-text("Marked received.")', T);
      await revenue();
      await checkLine('Website', { rev: 90000, exp: 7024 });
      await expectCents('#rev-lines tr[data-total] .c-rev', WANT.total.rev + 50000);
      const m = await moneyMonth();
      if (m.inc !== WANT.total.rev + 50000) throw new Error('Money income ' + m.inc);
      await dash();
      await poll(() => text('#de-overdue'), (g) => g.startsWith('0 overdue'), 'overdue after');
      await expectCents('#dm-revenue', WANT.total.rev + 50000);
    });
    await step('home layout: Move buttons, drag, hide; persists after reload; the other width stays separate', async () => {
      await dash();
      const o0 = await order();
      if (o0.join() !== defaultOrder.join()) throw new Error('default order ' + o0.join());
      await page.click('#dash-customize');
      await page.waitForSelector('.modbar', T);
      for (let i = 0; i < 2; i++) { await page.click('.mod[data-mod="rev-month"] .mv-up'); await page.waitForTimeout(150); }
      const o1 = await order();
      if (o1.indexOf('rev-month') !== defaultOrder.indexOf('rev-month') - 2) throw new Error('Move up: ' + o1.join());
      await page.click('.mod[data-mod="tile-health"] .mv-down'); await page.waitForTimeout(150);
      await page.click('.mod[data-mod="tile-admin"] .mv-hide');
      await page.waitForSelector('.mod[data-mod="tile-admin"][data-hidden="true"]', T);
      // drag Revenue expected above Net by line with the pointer
      await page.locator('.mod[data-mod="rev-expected"] .drag').scrollIntoViewIfNeeded();
      const h = await page.locator('.mod[data-mod="rev-expected"] .drag').boundingBox();
      const tgt = await page.locator('.mod[data-mod="rev-net-line"]').boundingBox();
      if (!tgt || tgt.y < 0) throw new Error('drag target not on screen');
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(tgt.x + 30, tgt.y + 8, { steps: 12 });
      await page.mouse.up();
      await poll(() => order(), (g) => g.indexOf('rev-expected') < g.indexOf('rev-net-line'), 'drag moved the module up');
      await noHScroll('customizing');
      await page.click('#dash-customize');
      const saved = await order();
      if (saved.includes('tile-admin')) throw new Error('hidden module is still shown');
      const stored = await page.evaluate(() => JSON.stringify(globalThis.LifeOS.store.getState().settings.layouts));
      const key = viewport ? 'narrow' : 'wide', otherKey = viewport ? 'wide' : 'narrow';
      const lay = JSON.parse(stored);
      if (!lay[key].length || lay[otherKey].length) throw new Error('layouts not kept per width: ' + stored.slice(0, 120));
      // reload at the same width
      await page.reload(); await unlock(); await dash();
      if ((await order()).join() !== saved.join()) throw new Error('layout lost on reload');
      // the other width has its own (default) layout
      await page.setViewportSize(other); await page.reload(); await unlock(); await dash();
      if ((await order()).join() !== defaultOrder.join()) throw new Error('other width does not start from the default: ' + (await order()).join());
      await page.click('#dash-customize'); await page.click('.mod[data-mod="tile-goals"] .mv-hide');
      await page.waitForSelector('.mod[data-mod="tile-goals"][data-hidden="true"]', T);
      await page.click('#dash-customize');
      const o2 = await order();
      if (o2.includes('tile-goals') || !o2.includes('tile-admin')) throw new Error('other width layout wrong: ' + o2.join());
      await noHScroll('other width');
      await page.setViewportSize(size); await page.reload(); await unlock(); await dash();
      if ((await order()).join() !== saved.join()) throw new Error('the first width changed after editing the other: ' + (await order()).join());
      // reset to default
      await page.click('#dash-customize'); await page.click('#dash-reset'); await page.waitForSelector('.notice:has-text("Layout reset.")', T);
      await page.click('#dash-customize');
      if ((await order()).join() !== defaultOrder.join()) throw new Error('reset did not restore the default');
    });
    await step('move Client Co into the private vault: its money disappears with a marker while closed', async () => {
      const id = await page.evaluate(() => globalThis.LifeOS.store.getState().projects.find((p) => p.name === 'Client Co').id);
      await page.click('#nav-private'); await page.waitForSelector('#priv-setup', T);
      await page.fill('#priv-set1', PRIV); await page.fill('#priv-set2', PRIV); await page.click('#priv-setup-btn');
      await page.waitForSelector('#priv-bar', T);
      await page.selectOption('#priv-coll', 'projects');
      await page.waitForSelector('.priv-row[data-key="' + id + '"]', T);
      await page.click('.priv-row[data-key="' + id + '"] .priv-move');
      await page.waitForSelector('.dialog', T);
      await page.click('.dialog button:has-text("Move in")');
      await page.waitForSelector('.notice:has-text("Moved to the private vault.")', T);
      await revenue();
      await checkLine('Client Co', WANT.client);
      await page.click('#nav-private'); await page.click('#priv-close');
      await revenue();
      if (await page.locator(row('rev-lines', 'Client Co')).count()) throw new Error('private line still listed while closed');
      if (!(await page.locator('#rev-lines').evaluate((el) => !!el.closest('main').querySelector('[aria-label="' + 'Some private items are hidden' + '"]')))) throw new Error('no marker while closed');
      const rev = WANT.total.rev + 50000 - WANT.client.rev, exp = WANT.total.exp - WANT.client.exp;
      await expectCents('#rev-lines tr[data-total] .c-rev', rev); await expectCents('#rev-lines tr[data-total] .c-exp', exp);
      await expectRow('rev-rollups', 'AYiN Advisors', 'c-rev', 90000);
      const m = await moneyMonth();
      if (m.inc !== rev || m.exp !== exp) throw new Error('Money totals ' + JSON.stringify(m) + ' while closed');
      const body = await page.evaluate(() => document.body.innerText);
      if (body.includes('Client Co') || body.includes('Invoice 7')) throw new Error('private text on the page while closed');
      await noHScroll('revenue closed');
    });
    await step('lock and unlock: still private, still persisted; opening the vault brings it back', async () => {
      await page.click('button.lockbtn'); await page.waitForSelector('#pass', T);
      await unlock();
      await revenue();
      if (await page.locator(row('rev-lines', 'Client Co')).count()) throw new Error('private line visible after unlock');
      await expectCents('#rev-lines tr[data-total] .c-rev', WANT.total.rev + 50000 - WANT.client.rev);
      await dash();
      if ((await order()).join() !== defaultOrder.join()) throw new Error('layout changed across lock');
      await page.click('#nav-private'); await page.fill('#priv-pass', PRIV); await page.click('#priv-open'); await page.waitForSelector('#priv-bar', T);
      await revenue();
      await checkLine('Client Co', WANT.client);
      await expectCents('#rev-lines tr[data-total] .c-rev', WANT.total.rev + 50000);
    });
    if (requests.length) throw new Error('network requests were made: ' + requests.slice(0, 3).join(', '));
  } catch (e) { if (!problems.length) problems.push(label + ': ' + e.message); }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-COMMAND FAILED'); for (const p of problems) console.log(p); process.exit(1); }
console.log('SMOKE-COMMAND PASSED');
