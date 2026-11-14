// v0.9.0 Activities smoke: desktop and 390x844. Fails on console errors, CSP violations, horizontal scroll.
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
// Hand-computed expectations. The page clock is Saturday 2026-11-14 (week 2026-11-09 to 2026-11-15). Window: 2026-11-14 to 2026-12-13.
// PLANNED: Sunday market 11-15 (this week, no cost), Museum visit 11-16 ($20), Concert 11-24 ($80), Weekend trip 12-09 to 12-11 ($300, 25 days out).
//   Collapsed view shows 1 item (this week); the 30-day view shows 4. Committed 20 + 80 + 300 = $400.
// DONE: Kayak day (outing, 11-13, 120 min, $60, return $100, Health cardio, Social with Sam and Alex, rated 4), Pottery class (class, 11-05, 90 min, $30, rated 5),
//   Free meetup (networking, 11-03, 60 min, no cost, rated 3). Offers: Kayak and Pottery; only Kayak is accepted, so Money = $60.00.
//   Cost by category, November: outing $60.00 (1), class $30.00 (1), networking no data, total $90.00 (2). Cost per hour: outing 6000*60/120 = $30.00,
//   class 3000*60/90 = $20.00, total 9000*60/210 = 2571 cents = $25.71. Worth-it: outing 4, class 5, networking 3, total 4.00. Return minus cost: outing $100 - $60 = $40.
//   Health: 1 session of 4, 120 minutes. Social: Sam and Alex last contact 2026-11-13, 2 tracked, 0 overdue.
// REVIEW: three past-date planned items (11-10 Book club, 11-11 Gym tour, 11-12 Old talk): Book club done then rated 5, Gym tour rescheduled to 11-18, Old talk skipped.
//   This week: 2 done on 2 days (Kayak, Book club), $60.00 spent.
// AMENDMENT (Prepaid show 11-20 $25, Pay at door 11-20 $15, Deposit trip 11-25 $40; committed before them $400, after adding $480):
//   Prepaid: Mark paid (committed $455, Money still $60), accept (Money $85), then Done offers nothing more. Pay at door: Done (committed $440), offer, accept (Money $100).
//   Deposit trip: Mark paid, accept (Money $140), Skip keeps the expense. Committed ends at $400. Money = 60 + 25 + 15 + 40 = $140.00.
// Deleting the Kayak expense in Money: Money $80.00, the activity survives unlinked, its own spend stays $60.00.

async function run(label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
  const nav = (name) => page.click('.nav button:has-text("' + name + '")');
  const text = (sel) => page.textContent(sel).then((t) => t.trim());
  const poll = async (get, good, what) => {
    let got;
    for (let i = 0; i < 80; i++) { try { got = await get(); if (good(got)) return got; } catch (e) { got = String(e.message).split('\n')[0]; } await page.waitForTimeout(100); }
    throw new Error(what + ' is ' + JSON.stringify(got));
  };
  const expectText = (sel, want) => poll(() => text(sel), (g) => g === want, sel + ' (expected ' + JSON.stringify(want) + ')');
  const expectCount = (sel, want) => poll(() => page.locator(sel).count(), (g) => g === want, sel + ' count (expected ' + want + ')');
  const expectVisible = (sel, want) => poll(() => page.locator(sel + ':visible').count(), (g) => g === want, sel + ' visible count (expected ' + want + ')');
  const cells = (sel) => page.$$eval(sel + ' td', (c) => c.map((x) => x.textContent.trim()));
  const expectCells = (sel, want) => poll(() => cells(sel), (g) => JSON.stringify(g) === JSON.stringify(want), sel + ' cells (expected ' + JSON.stringify(want) + ')');
  const layout = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, clipped: [...document.querySelectorAll('.nav button')].filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.textContent) }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
    if (r.clipped.length) throw new Error(where + ': nav labels clipped: ' + r.clipped.join(', '));
  };
  const openFold = async (id) => { await page.waitForSelector('#' + id, T); if (!(await page.locator('#' + id).evaluate((el) => el.open))) await page.click('#' + id + ' > summary'); };
  const dash = async () => { await nav('Home'); await page.waitForSelector('.tile', T); };
  const tile = async (id, value, sub, where) => {
    await dash();
    await expectText('.tile[data-domain="' + id + '"] .tile-value', value);
    const t = await text('.tile[data-domain="' + id + '"]');
    if (!t.includes(sub)) throw new Error(where + ' ' + id + ' tile: ' + t);
    await expectCount('.tile', 11);
    await layout(where + ' dashboard');
  };
  const openAct = async () => { await dash(); await page.click('.tile[data-domain="activities"]'); await page.waitForSelector('#act-upcoming', T); };
  const openMoney = async () => { await nav('Money'); await page.waitForSelector('#mv-spend', T); };
  const spend = (v) => async () => { await openMoney(); await expectText('#mv-spend', v); };
  const stats = async (w, where) => { for (const [id, v] of Object.entries(w)) await expectText('#' + id, v); await layout(where); };
  const item = (t) => '.act-item[data-title="' + t + '"]';
  const noticeIs = (msg) => page.waitForSelector('.notice:has-text("' + msg + '")', T);
  async function addAct(f) {
    await openFold('act-add');
    await page.fill('#act-title', f.title); await page.selectOption('#act-category', f.cat);
    await page.fill('#act-date', f.date); await page.press('#act-date', 'Tab');
    await page.selectOption('#act-state', f.state);
    for (const [id, v] of [['end', f.end], ['minutes', f.min], ['place', f.place], ['people', f.people], ['cost', f.cost], ['return', f.ret]]) await page.fill('#act-' + id, v || '');
    await page.selectOption('#act-worth', f.worth || '');
    for (const [id, on] of [['health', f.health], ['social', f.social]]) { if (on) await page.check('#act-' + id); else await page.uncheck('#act-' + id); }
    if (f.kind) await page.selectOption('#act-kind', f.kind);
    await page.click('#act-add-btn');
    await noticeIs('Activity added.');
    await page.waitForSelector(item(f.title) + ', .act-past[data-title="' + f.title + '"]', { state: 'attached', timeout: 30000 });
  }
  const committed = (v) => expectText('#act-committed', v);
  const offerCount = (n) => (n ? expectCount('#act-offers .act-offer', n) : expectCount('#act-offers', 0));

  try {
    await page.clock.install({ time: new Date(2026, 10, 14, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('create vault; empty Activities tile and At a glance card', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")');
      await page.waitForSelector('.tile', T);
      await tile('activities', '0', 'Nothing planned, $0 committed in 30 days', 'empty');
      await expectText('#dash-glance-sum', 'Nothing planned in the next 30 days.');
    });
    await step('plan activities 2, 10 and 25 days out plus one this week; collapsed week view and expanded 30-day view', async () => {
      await openAct();
      await addAct({ title: 'Sunday market', cat: 'event', date: '2026-11-15', state: 'planned' });
      await addAct({ title: 'Museum visit', cat: 'outing', date: '2026-11-16', state: 'planned', cost: '20' });
      await addAct({ title: 'Concert', cat: 'event', date: '2026-11-24', state: 'planned', cost: '80' });
      await addAct({ title: 'Weekend trip', cat: 'travel', date: '2026-12-09', end: '2026-12-11', state: 'planned', cost: '300' });
      await committed('$400.00');
      await expectCount('#act-upcoming .act-item', 1); await expectText('#act-later > summary', 'Rest of the next 30 days (3)');
      await expectVisible('#act-later .act-item', 0);
      await page.click('#act-later > summary'); await expectVisible('#act-later .act-item', 3);
      await layout('activities planned');
      await tile('activities', '0', 'Next planned 2026-11-15, $400 committed in 30 days', 'planned');
      await expectText('#dash-glance-sum', '4 items in the next 30 days.');
      await expectVisible('#dash-glance .gl-item', 1); await expectText('#dash-glance .gl-item', 'Sunday market 2026-11-15');
      await page.click('#dash-glance-later > summary'); await expectVisible('#dash-glance .gl-item', 4);
      await layout('dashboard glance open');
      await spend('$0.00')();
    });
    await step('add done activities: Kayak day with cost, minutes, people, Health and Social; Pottery class; Free meetup', async () => {
      await openAct();
      await addAct({ title: 'Kayak day', cat: 'outing', date: '2026-11-13', state: 'done', min: '120', place: 'Lake', people: 'Sam, Alex', cost: '60', ret: '100', health: true, kind: 'cardio', social: true });
      await addAct({ title: 'Pottery class', cat: 'class', date: '2026-11-05', state: 'done', min: '90', cost: '30', worth: '5' });
      await addAct({ title: 'Free meetup', cat: 'networking', date: '2026-11-03', state: 'done', min: '60', worth: '3' });
      await expectText('#act-offers h2', 'Add to Money? (2)');
      await spend('$0.00')();
      await layout('money before offers');
    });
    await step('accept the offered expense; Money, Health and Social numbers; rate it', async () => {
      await openAct();
      await page.click('.act-offer[data-title="Kayak day"] .act-offer-add'); await noticeIs('Added to Money.');
      await expectText('#act-offers h2', 'Add to Money? (1)');
      await spend('$60.00')();
      await nav('Health'); await page.waitForSelector('#hl-sessions', T);
      await expectText('#hl-sessions', '1 of 4'); await expectText('#hl-minutes', '120');
      await expectCount('#hl-from-act .hl-act', 1); await expectCount('#hl-from-act .act-from', 1);
      await tile('social', '0', '2 tracked, over 30 days since contact', 'social');
      await page.click('.tile[data-domain="social"]'); await page.waitForSelector('#soc-from-act', T);
      await expectCount('#soc-from-act .soc-act', 2); await expectCount('#soc-from-act .act-from', 2);
      if (!(await text('#soc-from-act .soc-act[data-person="Sam"]')).includes('last contact 2026-11-13')) throw new Error('Sam last contact');
      await layout('social from activities');
      await openAct();
      await page.click(item('Kayak day') + ' .act-rate[data-n="4"]');
      await poll(() => page.getAttribute(item('Kayak day') + ' .act-rate[data-n="4"]', 'aria-pressed'), (g) => g === 'true', 'Kayak rating pressed');
      await stats({ 'act-days': '1', 'act-done-count': '1', 'act-spend': '$60.00', 'act-committed': '$400.00' }, 'activities stats');
      await expectText(item('Kayak day') + ' .act-linked', 'In Money');
    });
    await step('a manual workout the same day shows a notice that only offers removal', async () => {
      await nav('Health'); await page.waitForSelector('#hl-sessions', T);
      await openFold('hl-q-workout'); await page.fill('#qw-date', '2026-11-13'); await page.click('#qw-add'); await noticeIs('Workout logged.');
      await expectText('#hl-sessions', '2 of 4'); await expectCount('.hl-dupe', 1);
      await page.click('.hl-dupe .hl-dupe-keep'); await expectCount('.hl-dupe', 0); await expectText('#hl-sessions', '2 of 4');
      await nav('Home'); await nav('Health'); await expectCount('.hl-dupe', 1);
      await page.click('.hl-dupe .hl-dupe-remove'); await expectCount('.hl-dupe', 0); await expectText('#hl-sessions', '1 of 4'); await expectText('#hl-minutes', '120');
    });
    await step('ROI tables against hand-computed values', async () => {
      await openAct(); await openFold('act-roi');
      await expectCount('#roi-per-activity tbody tr', 2); await expectCells('#roi-per-activity tr[data-cat="Kayak day"]', ['Kayak day', '2026-11-13', '$60.00']);
      await expectCells('#roi-by-cat tr[data-cat="outing"]', ['outing', '1', '$60.00']); await expectCells('#roi-by-cat tr[data-cat="class"]', ['class', '1', '$30.00']);
      await expectCells('#roi-by-cat tr[data-cat="networking"]', ['networking', '0', 'no data']); await expectCells('#roi-by-cat tr[data-cat="(total)"]', ['Total', '2', '$90.00']);
      await expectCells('#roi-per-hour tr[data-cat="outing"]', ['outing', '1', '$30.00']); await expectCells('#roi-per-hour tr[data-cat="class"]', ['class', '1', '$20.00']);
      await expectCells('#roi-per-hour tr[data-cat="networking"]', ['networking', '0', 'no data']); await expectCells('#roi-per-hour tr[data-cat="(total)"]', ['All', '2', '$25.71']);
      await expectCells('#roi-worth tr[data-cat="outing"]', ['outing', '1', '4.00 of 5']); await expectCells('#roi-worth tr[data-cat="class"]', ['class', '1', '5.00 of 5']);
      await expectCells('#roi-worth tr[data-cat="networking"]', ['networking', '1', '3.00 of 5']); await expectCells('#roi-worth tr[data-cat="hobby"]', ['hobby', '0', 'no data']); await expectCells('#roi-worth tr[data-cat="(total)"]', ['All', '3', '4.00 of 5']);
      await expectCells('#roi-returns tr[data-cat="outing"]', ['outing', '$100.00', '$60.00', '$40.00']); await expectCells('#roi-returns tr[data-cat="class"]', ['class', 'no data', 'no data', 'no data']);
      await expectCells('#roi-returns tr[data-cat="(total)"]', ['All', '$100.00', '$60.00', '$40.00']);
      await layout('roi tables');
    });
    await step('weekly review Activities step on past-date planned items: done, reschedule, skipped, rating (all on taps)', async () => {
      await openAct();
      await addAct({ title: 'Book club', cat: 'other', date: '2026-11-10', state: 'planned' });
      await addAct({ title: 'Gym tour', cat: 'hobby', date: '2026-11-11', state: 'planned' });
      await addAct({ title: 'Old talk', cat: 'networking', date: '2026-11-12', state: 'planned' });
      await expectText('#act-overdue h2', 'Planned, date passed (3)');
      await nav('Review'); await page.waitForSelector('#rv-activities', T);
      await expectText('#rv-act-past-h', 'Planned, date passed (3)'); await expectText('#rv-act-rate-h', 'Worth it? Done in the last 14 days, not rated (0)');
      await page.click('.rv-act[data-title="Book club"] .rv-act-done');
      await expectText('#rv-act-past-h', 'Planned, date passed (2)'); await expectText('#rv-act-rate-h', 'Worth it? Done in the last 14 days, not rated (1)');
      await page.click('.rv-act-rate[data-title="Book club"] .act-rate[data-n="5"]');
      await expectText('#rv-act-rate-h', 'Worth it? Done in the last 14 days, not rated (0)');
      await page.fill('.rv-act[data-title="Gym tour"] .rv-act-date', '2026-11-18'); await page.click('.rv-act[data-title="Gym tour"] .rv-act-rs');
      await expectText('#rv-act-past-h', 'Planned, date passed (1)');
      await page.click('.rv-act[data-title="Old talk"] .rv-act-skip');
      await expectText('#rv-act-past-h', 'Planned, date passed (0)');
      await expectText('#rv-act-stats', 'This week: 2 activities done on 2 days, $60.00 spent.');
      await expectText('#rv-act-offers-h', 'Add to Money? (1)');
      await layout('review activities');
      await spend('$60.00')();
      await openAct();
      await openFold('act-later');
      if ((await text(item('Gym tour'))).indexOf('2026-11-18') < 0) throw new Error('Gym tour not rescheduled');
    });
    await step('amendment: paid while planned, done unpaid, done after paid, skipped after paid', async () => {
      await openAct();
      await addAct({ title: 'Prepaid show', cat: 'event', date: '2026-11-20', state: 'planned', cost: '25' });
      await addAct({ title: 'Pay at door', cat: 'other', date: '2026-11-20', state: 'planned', cost: '15' });
      await addAct({ title: 'Deposit trip', cat: 'travel', date: '2026-11-25', state: 'planned', cost: '40' });
      await committed('$480.00');
      // paid while planned
      await openFold('act-later');
      await page.click(item('Prepaid show') + ' .act-paid-btn'); await noticeIs('Marked paid.');
      await committed('$455.00'); await expectText(item('Prepaid show') + ' .act-money-line', 'paid $25.00 on 2026-11-14'); await expectCount(item('Prepaid show') + ' .act-paid', 1);
      await spend('$60.00')();
      await openAct(); await expectCount('#act-offers .act-offer[data-title="Prepaid show"]', 1);
      await page.click('.act-offer[data-title="Prepaid show"] .act-offer-add'); await expectCount('#act-offers .act-offer[data-title="Prepaid show"]', 0);
      await spend('$85.00')();
      // done while unpaid
      await openAct(); await openFold('act-later');
      await page.click(item('Pay at door') + ' .act-done'); await committed('$440.00');
      await expectCount('#act-offers .act-offer[data-title="Pay at door"]', 1);
      if (!(await text('.act-offer[data-title="Pay at door"]')).includes('2026-11-20, $15.00')) throw new Error('offer date and amount: ' + await text('.act-offer[data-title="Pay at door"]'));
      await spend('$85.00')();
      await openAct(); await page.click('.act-offer[data-title="Pay at door"] .act-offer-add'); await expectCount('#act-offers .act-offer[data-title="Pay at door"]', 0);
      await spend('$100.00')();
      // done after paid offers nothing more
      await openAct(); await openFold('act-later');
      await page.click(item('Prepaid show') + ' .act-done');
      await expectText(item('Prepaid show') + ' .act-state', 'Done'); await expectCount('#act-offers .act-offer[data-title="Prepaid show"]', 0); await expectCount(item('Prepaid show') + ' .act-money', 0);
      await spend('$100.00')();
      // skipped after paid keeps the expense
      await openAct(); await openFold('act-later');
      await page.click(item('Deposit trip') + ' .act-paid-btn'); await noticeIs('Marked paid.');
      await page.click('.act-offer[data-title="Deposit trip"] .act-offer-add'); await expectCount('#act-offers .act-offer[data-title="Deposit trip"]', 0);
      await spend('$140.00')();
      await openAct(); await openFold('act-later');
      await page.click(item('Deposit trip') + ' .act-skip'); await noticeIs('Marked skipped. Its Money expense is kept.');
      await expectText(item('Deposit trip') + ' .act-state', 'Skipped'); await expectCount(item('Deposit trip') + ' .act-linked', 1);
      await committed('$400.00'); await expectCount('#act-offers .act-offer', 1);
      await spend('$140.00')();
      await layout('amendment');
    });
    await step('delete the expense in Money: the activity survives, unlinked, and is not double counted', async () => {
      await openMoney();
      await page.click('button[aria-label="Delete Kayak day"]'); await page.click('.dialog button:has-text("Delete")');
      await expectText('#mv-spend', '$80.00');
      await openAct();
      await expectCount(item('Kayak day'), 1); await expectCount(item('Kayak day') + ' .act-linked', 0);
      await expectText('#act-offers h2', 'Add to Money? (2)');
      await stats({ 'act-spend': '$60.00' }, 'after expense delete');
    });
    const final = async (where) => {
      await spend('$80.00')();
      await tile('activities', '2', 'Next planned 2026-11-15, $400 committed in 30 days', where);
      await expectText('#dash-glance-sum', '5 items in the next 30 days.'); await expectVisible('#dash-glance .gl-item', 1);
      await openAct();
      await stats({ 'act-days': '2', 'act-done-count': '2', 'act-spend': '$60.00', 'act-committed': '$400.00' }, where);
      await expectCount(item('Kayak day'), 1); await expectCount(item('Pottery class'), 1); await expectCount(item('Deposit trip') + ' .act-linked', 1);
      await nav('Health'); await expectText('#hl-sessions', '1 of 4');
    };
    await step('lock and unlock', async () => {
      await page.click('.top .lockbtn');
      await page.waitForSelector('#pass', T);
      if (await page.locator('.tile').count()) throw new Error('data visible while locked');
      const body = await page.textContent('body');
      for (const secret of ['Kayak day', 'Pottery class', 'Museum visit', 'Deposit trip']) if (body.includes(secret)) throw new Error('locked page shows ' + secret);
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
    await step('settings: version, and no activity text', async () => {
      await nav('Settings');
      await page.waitForSelector('#app-version', T);
      await expectText('#app-version', 'LifeOS v0.10.0');
      const t = await text('main');
      for (const secret of ['Kayak day', 'Pottery class', 'Museum visit']) if (t.includes(secret)) throw new Error('settings page shows ' + secret);
      await layout('settings');
    });
    await step('a card number in notes or place is refused; the note field holds 200 characters', async () => {
      await openAct(); await openFold('act-add');
      if ((await page.getAttribute('#act-notes', 'maxlength')) !== '200') throw new Error('note maxlength');
      await page.fill('#act-title', 'Card test'); await page.fill('#act-notes', 'paid with 4111 1111 1111 1111'); await page.click('#act-add-btn');
      await page.waitForSelector('.notice.err:has-text("ID number")', T);
      await page.fill('#act-notes', ''); await page.fill('#act-place', '123-45-6789'); await page.click('#act-add-btn');
      await page.waitForSelector('.notice.err:has-text("ID number")', T);
      await expectCount(item('Card test'), 0);
    });
    await step('categories can be added and removed, and an older entry the upgrade kept is deletable', async () => {
      await openAct(); await openFold('act-cats');
      await page.fill('#act-newcat', 'Gaming'); await page.click('#act-cat-add'); await expectCount('.act-cat[data-cat="Gaming"]', 1);
      await openFold('act-cats'); await page.click('.act-cat[data-cat="Gaming"] .x'); await expectCount('.act-cat[data-cat="Gaming"]', 0);
      await page.evaluate(() => globalThis.LifeOS.store.commit((x) => { x.entries.push(globalThis.LifeOS.metrics.validateEntry({ domain: 'activities', type: 'session', date: '2026-11-10', title: 'Kept old session' })); }));
      await openAct(); await openFold('act-legacy');
      await expectCount('#act-legacy .g-legacy', 1);
      await page.click('#act-legacy .leg-del'); await page.click('.dialog button:has-text("Delete")');
      await expectCount('#act-legacy', 0);
      await layout('activities after legacy delete');
    });
    // SEC-51 (v0.9.0 audit): a cost already in Money can be corrected; the one linked expense changes with it, nothing is added.
    await step('SEC-51: correcting the cost of an activity already in Money changes that expense', async () => {
      await openAct();
      await page.click(item('Deposit trip') + ' .act-edit');
      if (await page.locator('#ae-cost').isDisabled()) throw new Error('cost field is locked');
      await page.fill('#ae-cost', '41.50'); await page.click('.dialog button:has-text("Save")');
      await noticeIs('Activity saved.');
      await expectCount(item('Deposit trip') + ' .act-linked', 1);
      await spend('$81.50')();
      await openAct(); await page.click(item('Deposit trip') + ' .act-edit');
      await page.fill('#ae-cost', ''); await page.click('.dialog button:has-text("Save")');
      await page.waitForSelector('.dialog p:has-text("delete its expense in Money")', T);
      await page.click('.dialog button:has-text("Cancel")');
      await spend('$81.50')();
    });
  } catch { /* recorded in problems */ }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-ACTIVITIES FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-ACTIVITIES PASSED');
