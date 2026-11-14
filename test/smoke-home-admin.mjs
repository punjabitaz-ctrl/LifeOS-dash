// v0.7.0 Home and Admin smoke: desktop and 390x844. Fails on console errors, CSP violations, horizontal scroll.
// Run `node build.mjs` first. Needs Playwright (`npm i --no-save playwright`) and Chrome at /usr/bin/google-chrome.
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
const T = { timeout: 30000 };
const problems = [];
// Hand-computed expectations. The page clock is Saturday 2026-11-14; its week is 2026-11-09 to 2026-11-15.
// HOME tasks: Clean gutters (every 6 months, due 11-01, overdue), Replace smoke batteries (once, due 11-12, overdue), Fix fence (once, due 11-20),
//   Test sump pump (every 90 days, due 12-14 = day 30, counts as within 30 days), Oil change (Family car, every 180 days, due 11-14 = today, not overdue).
//   Start: overdue 2, due within 30 days 3 (fence, sump, oil).
// Gutters done 11-10 at $120.50: proposal 2026-05-10 + 0 = 6 months after 2026-11-10 = 2027-05-10, nothing created. Overdue 1.
// Oil change done 11-14 at $80, odometer 41,500: proposal 180 days after 11-14 = 2027-05-13 (16 left in Nov, 31 Dec, 31 Jan, 28 Feb, 31 Mar, 30 Apr = 167, +13). Year to date $200.50.
// After confirming gutters: an open task on 2027-05-10. In the review the smoke batteries "came due this week" (1), the fence is due next week (1),
//   the plate registration is overdue from before the week (1). Confirming the oil proposal and finishing the batteries leaves Home at 0 overdue, 2 due in 30 days.
// HOUSEHOLD: Electric $80 monthly and Water $120 yearly flagged: (80 x 12 + 120) / 12 = $90.00 a month. Internet $60 monthly flagged later: $150.00.
// ADMIN renewals: Plate registration 11-01 (overdue), Car insurance 11-20 (day 6), Netflix 12-01 monthly $15.99 (day 17), License 2027-01-05 (day 52),
//   Gym 2027-01-20 yearly $120 (day 67). Document Passport expires 2027-02-01 (day 79). Tax W-2 due 2027-01-31 (day 78), Property tax receipt due 11-10 (overdue, then filed).
//   30 days: Car insurance, Netflix (2); 31 to 60: License (1); 61 to 90: Gym, Passport, W-2 (3); overdue: Plate registration (1).
//   Subscriptions: 1599 x 12 + 12000 = 31188 cents a year = $311.88, 2599 cents a month = $25.99.
// Car insurance done (yearly, due 11-20): next proposed 2027-11-20. Confirmed, it is beyond 90 days. Admin then: 30 days 1 (Netflix), overdue 1.
const SECRET = 'That looks like an ID number or a card number. This index only records where a document is kept. Do not enter ID numbers, account numbers or passwords.';

async function run(label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
  const nav = (name) => page.click('.nav button:has-text("' + name + '")');
  const text = (sel) => page.textContent(sel).then((t) => t.trim());
  const expectText = async (sel, want) => { const got = await text(sel); if (got !== want) throw new Error(sel + ' is ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want)); };
  const expectCount = async (sel, want) => { const got = await page.locator(sel).count(); if (got !== want) throw new Error(sel + ' count is ' + got + ', expected ' + want); };
  const layout = async (where) => {
    const r = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, iw: window.innerWidth,
      clipped: [...document.querySelectorAll('.nav button')].filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.textContent),
    }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
    if (r.clipped.length) throw new Error(where + ': nav labels clipped: ' + r.clipped.join(', '));
  };
  const openFold = async (id) => { await page.waitForSelector('#' + id, T); if (!(await page.locator('#' + id).evaluate((el) => el.open))) await page.click('#' + id + ' > summary'); };
  const ok = (msg) => page.waitForSelector('.notice:has-text("' + msg + '")', T);
  const dash = async () => { await nav('Home'); await page.waitForSelector('.tile', T); };
  const tile = async (id, value, sub, where) => {
    await dash();
    await expectText('.tile[data-domain="' + id + '"] .tile-value', value);
    const t = await text('.tile[data-domain="' + id + '"]');
    if (!t.includes(sub)) throw new Error(where + ' ' + id + ' tile: ' + t);
    await expectCount('.tile', 11);
    await layout(where + ' dashboard');
  };
  const openHome = async () => { await dash(); await page.click('.tile[data-domain="home"]'); await page.waitForSelector('#hm-overdue', T); };
  const openAdmin = async () => { await dash(); await page.click('.tile[data-domain="admin"]'); await page.waitForSelector('#ad-timeline', T); };
  const homeStats = async (w, where) => {
    for (const [id, v] of Object.entries(w)) await expectText('#' + id, v);
    await layout(where);
  };
  async function addTask(f) {
    await openFold('hm-add');
    await page.fill('#mt-title', f.title);
    if (f.area) await page.fill('#mt-area', f.area);
    if (f.veh) await page.selectOption('#mt-veh', { label: f.veh });
    if (f.cadence) await page.selectOption('#mt-cadence', f.cadence);
    if (f.every) await page.fill('#mt-every', f.every);
    await page.fill('#mt-due', f.due);
    await page.click('#mt-add');
    await ok('Task added.');
    await page.waitForSelector('.mt-row[data-title="' + f.title + '"]', T);
  }
  async function markDone(title, f) {
    await page.click('.mt-row[data-title="' + title + '"] .mt-done');
    await page.waitForSelector('.dialog #md-date', T);
    if (f.date) await page.fill('#md-date', f.date);
    if (f.cost) await page.fill('#md-cost', f.cost);
    if (f.odo) await page.fill('#md-odo', f.odo);
    await layout('done dialog');
    await page.click('.dialog button:has-text("Mark done")');
    await ok('Marked done.');
  }
  async function addRenewal(f) {
    await openFold('ad-renewals');
    await page.fill('#rn-title', f.title); await page.selectOption('#rn-kind', f.kind); await page.fill('#rn-due', f.due); await page.selectOption('#rn-cadence', f.cadence);
    if (f.provider) await page.fill('#rn-provider', f.provider);
    if (f.amount) await page.fill('#rn-amount', f.amount);
    await page.click('#rn-add');
    await ok('Renewal added.');
    await page.waitForSelector('.rn-row[data-title="' + f.title + '"]', T);
  }
  async function addRecurring(f) {
    await openFold('recurring');
    await page.fill('#rc-title', f.title); await page.fill('#rc-amount', f.amount); await page.selectOption('#rc-cadence', f.cadence);
    if (f.household) await page.check('#rc-household');
    await page.click('button:has-text("Add recurring")');
    await ok('Recurring item added.');
  }
  const timeline = async (w, where) => {
    for (const [id, n] of Object.entries(w)) await expectText('#' + id + ' h3', ({ 'ad-tl-overdue': 'Overdue', 'ad-tl-30': 'Within 30 days', 'ad-tl-60': '31 to 60 days', 'ad-tl-90': '61 to 90 days' })[id] + ' (' + n + ')');
    await layout(where);
  };

  try {
    await page.clock.install({ time: new Date(2026, 10, 14, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('create vault, 11 tiles, empty tiles', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")');
      await page.waitForSelector('.tile', T);
      await tile('home', '0', '0 due in 30 days', 'empty');
      await tile('admin', '0', '0 overdue', 'empty');
    });
    await step('empty Home view: starter checklist is offered but nothing is added', async () => {
      await openHome();
      await page.waitForSelector('#hm-starter', T);
      await expectCount('.mt-row', 0);
      await homeStats({ 'hm-overdue': '0', 'hm-due30': '0', 'hm-ytd': '$0.00', 'hm-bills-total': '$0.00' }, 'home empty');
    });
    await step('starter checklist: pick one, it is added once and not offered again', async () => {
      await page.check('input[data-starter="hvac-filter"]');
      await page.click('#hm-starter-go');
      await ok('Added 1 task.');
      await page.waitForSelector('#hm-later .mt-row[data-title="Replace HVAC filter"]', T);
      await expectCount('#hm-starter', 0); await expectCount('.mt-row', 1);
      if (!(await text('#hm-later')).includes('due 2027-01-01')) throw new Error('starter task date: ' + await text('#hm-later'));
    });
    await step('add a property and a vehicle', async () => {
      await openFold('hm-props');
      await page.fill('#pr-name', 'Main house'); await page.click('#pr-add'); await ok('Property added.');
      await openFold('hm-vehicles');
      await page.fill('#vh-name', 'Family car'); await page.fill('#vh-year', '2019'); await page.fill('#vh-odo', '41000'); await page.click('#vh-add'); await ok('Vehicle added.');
      await page.waitForSelector('.vh-row[data-name="Family car"]', T);
      await expectCount('#mt-prop', 0); // one property: no picker
      await layout('home property and vehicle');
    });
    await step('recurring and one-off maintenance', async () => {
      await addTask({ title: 'Clean gutters', area: 'Exterior', cadence: 'semiannual', due: '2026-11-01' });
      await addTask({ title: 'Replace smoke batteries', due: '2026-11-12' });
      await addTask({ title: 'Fix fence', due: '2026-11-20' });
      await addTask({ title: 'Test sump pump', cadence: 'custom', every: '90', due: '2026-12-14' });
      await addTask({ title: 'Oil change', veh: 'Family car', cadence: 'custom', every: '180', due: '2026-11-14' });
      await homeStats({ 'hm-overdue': '2', 'hm-due30': '3' }, 'home five tasks');
      await expectCount('#hm-overdue-list .mt-row', 2); await expectCount('#hm-due30-list .mt-row', 3); await expectCount('#hm-later .mt-row', 1);
    });
    await step('mark gutters done: the next one is only proposed', async () => {
      await markDone('Clean gutters', { date: '2026-11-10', cost: '120.50' });
      await page.waitForSelector('#hm-proposals .prop-row[data-title="Clean gutters"]', T);
      const v = await page.inputValue('#hm-proposals .prop-row[data-title="Clean gutters"] .prop-date');
      if (v !== '2027-05-10') throw new Error('proposed date ' + v);
      await expectCount('.mt-row[data-title="Clean gutters"]', 0); // nothing was created
      await homeStats({ 'hm-overdue': '1', 'hm-due30': '3', 'hm-ytd': '$120.50' }, 'home after gutters');
    });
    await step('mark the oil change done with an odometer reading', async () => {
      await markDone('Oil change', { cost: '80', odo: '41500' });
      const v = await page.inputValue('#hm-proposals .prop-row[data-title="Oil change"] .prop-date');
      if (v !== '2027-05-13') throw new Error('oil proposal ' + v);
      await homeStats({ 'hm-ytd': '$200.50', 'hm-due30': '2' }, 'home after oil');
      await openFold('hm-vehicles');
      const t = await text('.vh-row[data-name="Family car"]');
      if (!t.includes('41500 mi') || !t.includes('last service 2026-11-14 at 41500 mi')) throw new Error('vehicle row: ' + t);
    });
    await step('confirm the gutters proposal: exactly one open task is created', async () => {
      await page.click('#hm-proposals .prop-row[data-title="Clean gutters"] .prop-confirm');
      await ok('Created the next one.');
      await page.waitForSelector('#hm-later .mt-row[data-title="Clean gutters"]', T);
      await expectCount('.mt-row[data-title="Clean gutters"]', 1); await expectCount('#hm-proposals .prop-row[data-title="Clean gutters"]', 0);
      if (!(await text('#hm-later .mt-row[data-title="Clean gutters"]')).includes('due 2027-05-10')) throw new Error('confirmed date');
      await expectCount('#hm-proposals .prop-row', 1);
      await layout('home proposals');
    });
    await step('household bills from flagged recurring items on Money', async () => {
      await nav('Money'); await page.waitForSelector('#recurring', T);
      await addRecurring({ title: 'Electric', amount: '80', cadence: 'monthly', household: true });
      await addRecurring({ title: 'Water', amount: '120', cadence: 'yearly', household: true });
      await addRecurring({ title: 'Internet', amount: '60', cadence: 'monthly' });
      if (!(await text('#recurring')).includes('Electric')) throw new Error('recurring list');
      await openHome();
      await expectText('#hm-bills-total', '$90.00');
      await expectCount('.hb-row', 2);
      await page.selectOption('#hb-pick', { label: 'Internet' }); await page.click('#hb-add');
      await page.waitForSelector('.hb-row[data-title="Internet"]', T);
      await expectText('#hm-bills-total', '$150.00');
      await layout('home bills');
      await nav('Money'); await page.waitForSelector('#recurring', T); await openFold('recurring');
      const t = await text('#recurring');
      if ((t.match(/household/g) || []).length < 3) throw new Error('flags not shown on Money: ' + t);
    });
    await step('Home tile', () => tile('home', '1', '2 due in 30 days', 'home'));
    await step('Admin: renewals and a subscription', async () => {
      await openAdmin();
      await addRenewal({ title: 'Plate registration', kind: 'registration', due: '2026-11-01', cadence: 'annual' });
      await addRenewal({ title: 'Car insurance', kind: 'insurance', provider: 'Acme Mutual', due: '2026-11-20', cadence: 'annual', amount: '1200' });
      await addRenewal({ title: 'Netflix', kind: 'subscription', due: '2026-12-01', cadence: 'monthly', amount: '15.99' });
      await addRenewal({ title: 'License', kind: 'license', due: '2027-01-05', cadence: 'once' });
      await addRenewal({ title: 'Gym', kind: 'subscription', due: '2027-01-20', cadence: 'annual', amount: '120' });
      await expectText('#ad-sub-month', '$25.99'); await expectText('#ad-sub-year', '$311.88');
      await expectText('#ad-sub-stale', '0 subscriptions have not been reviewed in 12 months.');
      if (!(await text('.sub-row[data-title="Netflix"]')).includes('$15.99 per month, $191.88 per year')) throw new Error('netflix row');
      await layout('admin renewals');
    });
    await step('document index: card-like and SSN-like values are refused, ordinary ones are kept', async () => {
      await openFold('ad-docs');
      await expectText('#doc-warning', 'This is an index of where documents are kept, not a place to store them. Do not enter ID numbers, account numbers or passwords.');
      await page.fill('#doc-title', 'Passport'); await page.fill('#doc-kind', 'ID'); await page.fill('#doc-where', '4111 1111 1111 1111'); await page.fill('#doc-expires', '2027-02-01');
      await page.click('#doc-add');
      await page.waitForSelector('.notice.err', T);
      await expectText('.notice.err', SECRET);
      await expectCount('.doc-row', 0);
      await page.fill('#doc-where', 'Blue folder, top drawer'); await page.fill('#doc-notes', 'ID 123-45-6789');
      await page.click('#doc-add');
      await page.waitForSelector('.notice.err:has-text("ID number")', T);
      await expectCount('.doc-row', 0);
      await page.fill('#doc-notes', 'Renewed 2016 2026');
      await page.click('#doc-add');
      await ok('Document added to the index.');
      await page.waitForSelector('.doc-row[data-title="Passport"]', T);
      await expectCount('.doc-row', 1);
      await layout('admin documents');
    });
    await step('tax checklist', async () => {
      await openFold('ad-tax');
      for (const [title, due] of [['W-2 from employer', '2027-01-31'], ['Property tax receipt', '2026-11-10'], ['1099 interest', '']]) {
        await page.fill('#tx-title', title); await page.fill('#tx-due', due);
        await page.click('#tx-add'); await ok('Tax item added.');
        await page.waitForSelector('.tx-row[data-title="' + title + '"]', T);
        await openFold('ad-tax');
      }
      await expectText('.tx-year[data-year="2025"] h3', '2025 (3 needed, 0 received, 0 filed)');
      await timeline({ 'ad-tl-overdue': 2, 'ad-tl-30': 2, 'ad-tl-60': 1, 'ad-tl-90': 3 }, 'admin tax before filing');
      await page.selectOption('.tx-row[data-title="Property tax receipt"] select', 'filed');
      await page.waitForSelector('.tx-year[data-year="2025"] h3:has-text("1 filed")', T);
      await expectText('.tx-year[data-year="2025"] h3', '2025 (2 needed, 0 received, 1 filed)');
    });
    await step('Admin timeline, stats and tile by hand', async () => {
      await timeline({ 'ad-tl-overdue': 1, 'ad-tl-30': 2, 'ad-tl-60': 1, 'ad-tl-90': 3 }, 'admin timeline');
      await expectText('#ad-due30', '2'); await expectText('#ad-overdue', '1');
      if (!(await text('#ad-tl-overdue')).includes('Plate registration')) throw new Error('overdue item');
      if (!(await text('#ad-tl-90')).includes('Passport') || !(await text('#ad-tl-90')).includes('W-2 from employer') || !(await text('#ad-tl-90')).includes('Gym')) throw new Error('90 day items');
      await tile('admin', '2', '1 overdue', 'admin');
    });
    await step('complete Car insurance: the next one is proposed, then confirmed', async () => {
      await openAdmin(); await openFold('ad-renewals');
      await page.click('.rn-row[data-title="Car insurance"] .rn-done');
      await page.waitForSelector('.dialog #rd-date', T);
      await page.click('.dialog button:has-text("Mark done")');
      await ok('Marked done.');
      await page.waitForSelector('#ad-proposals .prop-row[data-title="Car insurance"]', T);
      if ((await page.inputValue('#ad-proposals .prop-date')) !== '2027-11-20') throw new Error('renewal proposal');
      await expectCount('.rn-row[data-title="Car insurance"]', 0);
      await expectText('#ad-due30', '1');
      await page.click('#ad-proposals .prop-confirm');
      await ok('Created the next one.');
      await openFold('ad-renewals');
      await page.waitForSelector('.rn-row[data-title="Car insurance"]', T);
      await expectCount('.rn-row[data-title="Car insurance"]', 1); await expectCount('#ad-proposals .prop-row', 0);
      await timeline({ 'ad-tl-overdue': 1, 'ad-tl-30': 1, 'ad-tl-60': 1, 'ad-tl-90': 3 }, 'admin after insurance');
      await tile('admin', '1', '1 overdue', 'admin after insurance');
    });
    await step('weekly review Home and Admin step', async () => {
      await nav('Review');
      await page.waitForSelector('#rv-homeadmin', T);
      await expectText('#rv-ha-came-h', 'Came due this week (1)');
      await expectText('#rv-ha-overdue-h', 'Still overdue (1)');
      await expectText('#rv-ha-next-h', 'Due next week (1)');
      if (!(await text('#rv-homeadmin')).includes('Replace smoke batteries')) throw new Error('came due item');
      if (!(await text('#rv-homeadmin')).includes('Plate registration')) throw new Error('overdue item');
      if (!(await text('#rv-homeadmin')).includes('Fix fence')) throw new Error('next week item');
      await layout('review home admin');
      // The oil proposal is confirmed in the review; the batteries are finished there.
      await page.click('#rv-homeadmin .prop-row[data-title="Oil change"] .prop-confirm');
      await ok('Created the next one.');
      await page.waitForSelector('#rv-homeadmin');
      await expectCount('#rv-homeadmin .prop-row', 0);
      await page.click('#rv-homeadmin .mt-row[data-title="Replace smoke batteries"] .mt-done');
      await page.waitForSelector('.dialog #md-date', T);
      await page.click('.dialog button:has-text("Mark done")');
      await ok('Marked done.');
      await page.waitForSelector('#rv-ha-came-h:has-text("Came due this week (0)")', T);
      for (let i = 1; i <= 3; i++) await page.fill('#prio' + i, 'Priority ' + i);
      await page.click('#finish-review');
      await ok('Review finished.');
    });
    const final = async (where) => {
      await tile('home', '0', '2 due in 30 days', where);
      await openHome();
      await homeStats({ 'hm-overdue': '0', 'hm-due30': '2', 'hm-ytd': '$200.50', 'hm-bills-total': '$150.00' }, where + ' home');
      await expectCount('#hm-proposals', 0); await expectCount('#hm-starter', 0);
      await expectCount('#hm-later .mt-row[data-title="Oil change"]', 1); await expectCount('#hm-later .mt-row[data-title="Clean gutters"]', 1);
      await openFold('hm-vehicles');
      if (!(await text('.vh-row[data-name="Family car"]')).includes('41500 mi')) throw new Error('vehicle persisted');
      await tile('admin', '1', '1 overdue', where);
      await openAdmin();
      await expectText('#ad-sub-month', '$25.99'); await expectText('#ad-sub-year', '$311.88');
      await timeline({ 'ad-tl-overdue': 1, 'ad-tl-30': 1, 'ad-tl-60': 1, 'ad-tl-90': 3 }, where + ' admin');
      await openFold('ad-docs'); await expectCount('.doc-row', 1);
      await openFold('ad-tax'); await expectText('.tx-year[data-year="2025"] h3', '2025 (2 needed, 0 received, 1 filed)');
    };
    await step('lock and unlock', async () => {
      await page.click('.top .lockbtn');
      await page.waitForSelector('#pass', T);
      if (await page.locator('.tile').count()) throw new Error('data visible while locked');
      const body = await page.evaluate(() => document.getElementById('app').textContent);
      for (const s of ['Main house', 'Family car', 'Acme Mutual', 'Netflix', 'Passport', 'Clean gutters']) if (body.includes(s)) throw new Error('locked page shows ' + s);
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")');
      await page.waitForSelector('.tile', T);
      await final('after unlock');
    });
    await step('persistence after reload', async () => {
      await page.reload();
      await page.waitForSelector('#pass', T);
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")');
      await page.waitForSelector('.tile', T);
      await final('after reload');
    });
    await step('settings: version, and the audit log holds no titles', async () => {
      await nav('Settings');
      await page.waitForSelector('#app-version', T);
      await expectText('#app-version', 'LifeOS v0.8.0');
      const t = await text('main');
      for (const secret of ['Main house', 'Family car', 'Clean gutters', 'Acme Mutual', 'Netflix', 'Passport', 'Plate registration', 'W-2 from employer', 'Electric']) if (t.includes(secret)) throw new Error('settings page shows ' + secret);
      await layout('settings');
    });
    await step('SEC-45: a card number in renewal notes is refused', async () => {
      await openAdmin(); await openFold('ad-renewals');
      await page.fill('#rn-title', 'Card test'); await page.fill('#rn-due', '2027-03-01'); await page.fill('#rn-notes', 'paid with 4111 1111 1111 1111');
      await page.click('#rn-add');
      await page.waitForSelector('.notice.err:has-text("ID number")', T);
      await expectCount('.rn-row[data-title="Card test"]', 0);
      await page.fill('#rn-notes', '');
    });
    await step('SEC-48: older due items kept by the upgrade can be deleted', async () => {
      // An older due item the upgrade kept (its notes were too long to fit with the import note).
      await page.evaluate(async () => {
        const L = globalThis.LifeOS;
        const e = L.metrics.validateEntry({ domain: 'home', type: 'due', date: '2026-01-05', title: 'Old boiler check', due: '2026-10-01', status: 'open', notes: 'n'.repeat(1990) });
        e.createdAt = new Date().toISOString();
        await L.store.commit((x) => { x.entries.push(e); });
      });
      await tile('admin', '1', '2 overdue', 'with an older item');
      await openAdmin(); await openFold('ad-legacy');
      await expectCount('#ad-legacy .g-legacy', 1);
      await page.click('#ad-legacy .leg-del');
      await page.click('.dialog button:has-text("Delete")');
      await page.waitForSelector('#ad-legacy', { state: 'detached', timeout: 30000 });
      await tile('admin', '1', '1 overdue', 'after deleting the older item');
    });
  } catch { /* recorded in problems */ }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-HOME-ADMIN FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-HOME-ADMIN PASSED');
