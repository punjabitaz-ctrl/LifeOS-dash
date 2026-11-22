// v1.2.0 Activity CSV import smoke: desktop and 390x844. A CSV written here (mixed date formats, an unknown category, cost rows, two bad rows)
// is mapped, previewed and imported; the batch Money offer is accepted; Activities, Money and Social are checked against hand-computed
// numbers; a re-import adds nothing; lock, reload, unlock and everything persists. Fails on console errors, CSP violations and horizontal scroll.
// Run `node build.mjs` first. Needs Playwright (`npm i --no-save playwright`) and Chrome at /usr/bin/google-chrome.
import path from 'node:path';
import { navTo } from './_nav.mjs';
import os from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
// The page clock is Saturday 2026-11-14 (week 2026-11-09 to 2026-11-15, 30-day window 2026-11-14 to 2026-12-13). Dates are picked as DD/MM/YYYY.
// FILE (7 rows):
//   Kayak day        13/11/2026 done, outing, 120 min, $60.00, Sam;Alex, Social, rated 4          -> done this week, Money offer
//   Pottery class    05/11/2026 done, class, 90 min, $30.00, Health (cardio), rated 5               -> Money offer
//   Free meetup      2026-11-03 done, networking, 60 min, no cost, rated 3
//   Whale watch      20/11/2026 planned, category "Whale tour" (unknown, not created -> other), $80.00, not paid -> committed, no offer
//   Prepaid show     22/11/2026 planned, event, $25.50, paid 02/11/2026                              -> paid, so not committed; Money offer dated 2026-11-02
//   Bad date         31/02/2026                                                                     -> rejected
//   a card number as the title                                                                     -> rejected
// Preview: 5 to add (2 planned, 3 done), 2 rejected, 0 already imported. Cost in the rows: 60 + 30 + 80 + 25.50 = $195.50. Offer: Kayak, Pottery, Prepaid = 3 rows, $115.50.
// Before the tap Money spend (November) is $0.00; after it 60 + 30 + 25.50 = $115.50. Activities: 1 active day this week (Kayak 11-13), 1 done, $60.00 spent,
// committed $80.00 (Whale watch only; Prepaid is paid). Social (Sam and Alex added as people from the import): 0 overdue, 2 contacts this week, last contact 2026-11-13.
// Cost by category in November: outing $60.00 (1), class $30.00 (1), networking no data, total $90.00 (2).
const CSV = [
  'Title,Date,End date,State,Category,Minutes,Place,People,Cost,Paid date,Return,Worth it,Also health,Health type,Also social,Notes',
  'Kayak day,13/11/2026,,done,Outing,120,Lake,Sam;Alex,$60.00,,,4,no,,yes,Sunny',
  'Pottery class,05/11/2026,,done,class,90,Studio,,$30.00,,,5,yes,Cardio,no,',
  'Free meetup,2026-11-03,,done,networking,60,,,,,,3,no,,no,',
  'Whale watch,20/11/2026,,planned,Whale tour,,Pier,,$80.00,,,,no,,no,',
  'Prepaid show,22/11/2026,,planned,event,,,,25.50,02/11/2026,,,no,,no,',
  'Bad date,31/02/2026,,done,,,,,,,,,no,,no,',
  '4111 1111 1111 1111,2026-11-04,,done,,,,,,,,,no,,no,',
].join('\n');
const dir = mkdtempSync(path.join(os.tmpdir(), 'lifeos-actimp-'));
const csvPath = path.join(dir, 'activities.csv');
writeFileSync(csvPath, CSV);

async function run(label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
  const nav = (name) => navTo(page, name);
  const text = (sel) => page.textContent(sel).then((t) => t.trim());
  const poll = async (get, good, what) => {
    let got;
    for (let i = 0; i < 80; i++) { try { got = await get(); if (good(got)) return got; } catch (e) { got = String(e.message).split('\n')[0]; } await page.waitForTimeout(100); }
    throw new Error(what + ' is ' + JSON.stringify(got));
  };
  const expectText = (sel, want) => poll(() => text(sel), (g) => g === want, sel + ' (expected ' + JSON.stringify(want) + ')');
  const expectCount = (sel, want) => poll(() => page.locator(sel).count(), (g) => g === want, sel + ' count (expected ' + want + ')');
  const layout = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, clipped: [...document.querySelectorAll('.nav button')].filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.textContent) }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
    if (r.clipped.length) throw new Error(where + ': nav labels clipped: ' + r.clipped.join(', '));
  };
  const dash = async () => { await nav('Home'); await page.waitForSelector('.tile', T); };
  const openAct = async () => { await dash(); await page.click('.tile[data-domain="activities"]'); await page.waitForSelector('#act-upcoming', T); };
  const tile = async (id, value, sub, where) => {
    await dash();
    await expectText('.tile[data-domain="' + id + '"] .tile-value', value);
    const t = await text('.tile[data-domain="' + id + '"]');
    if (!t.includes(sub)) throw new Error(where + ' ' + id + ' tile: ' + t);
    await layout(where + ' dashboard');
  };
  const actStats = async (w, where) => { await openAct(); for (const [id, v] of Object.entries(w)) await expectText('#' + id, v); await layout(where); };
  const spend = async (v, where) => { await nav('Money'); await page.waitForSelector('#mv-spend', T); await expectText('#mv-spend', v); await layout(where); };
  const noticeIs = (msg) => page.waitForSelector('.notice:has-text("' + msg + '")', T);
  const expenses = () => page.evaluate(() => globalThis.LifeOS.store.getState().entries.filter((e) => e.domain === 'money' && e.type === 'expense').map((e) => e.title + '|' + e.date + '|' + Math.round(e.value * 100)).sort());
  const acts = () => page.evaluate(() => globalThis.LifeOS.store.getState().activities.length);
  const pickFile = async () => { await page.setInputFiles('#actimp-file', csvPath); await page.waitForSelector('#actimp-preview', T); };
  const allNums = async (where) => {
    await actStats({ 'act-days': '1', 'act-done-count': '1', 'act-spend': '$60.00', 'act-committed': '$80.00' }, where + ' activities');
    await tile('activities', '1', 'Next planned 2026-11-20, $80 committed in 30 days', where);
    await spend('$115.50', where + ' money');
    await tile('social', '0', '0 due in 7 days, 2 contacts this week', where);
    await page.click('.tile[data-domain="social"]'); await page.waitForSelector('.soc-person-row', T);
    await expectCount('.soc-person-row', 2);
    for (const n of ['Sam', 'Alex']) if (!(await text('.soc-person-row[data-person="' + n + '"]')).includes('last contact 2026-11-13')) throw new Error(n + ' last contact');
    const top = await text('main'); if (!top.includes('People overdue0Due in 7 days0Contacts this week2People2')) throw new Error('social numbers: ' + top.slice(0, 200));
    await layout(where + ' social');
  };

  try {
    await page.clock.install({ time: new Date(2026, 10, 14, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('create vault; the import card is on Activities and the export button is there', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")'); await page.waitForSelector('.tile', T);
      await openAct();
      await page.waitForSelector('#actimp-card', T); await page.waitForSelector('#exp-activities', T);
      if (!/LifeOS v1\.7\.0/.test(await (async () => { await nav('Settings'); await page.waitForSelector('#app-version', T); return text('#app-version'); })())) throw new Error('version');
      await openAct();
    });
    await step('map the file, pick DD/MM, preview: 5 to add, 2 rejected with reasons, an unknown category offered, the offer counted', async () => {
      await pickFile();
      await expectText('#actimp-size', '16 columns, 7 rows.');
      // the guesses mapped every column by header
      const want = { title: '0', date: '1', endDate: '2', state: '3', category: '4', minutes: '5', place: '6', people: '7', cost: '8', paidOn: '9', returnAmount: '10', worthIt: '11', alsoHealth: '12', healthKind: '13', alsoSocial: '14', notes: '15' };
      for (const [k, v] of Object.entries(want)) { const got = await page.$eval('#actimp-' + k, (el) => el.value); if (got !== v) throw new Error('column guess for ' + k + ': ' + got); }
      await page.selectOption('#actimp-datefmt', 'dmy');
      await page.click('#actimp-preview'); await page.waitForSelector('#actimp-summary', T);
      await expectText('#actimp-summary', '5 to add, 2 rejected, 0 already imported.');
      await expectText('#actimp-totals', 'Planned 2, done 3, skipped 0. Cost in the rows to add: $195.50. Rows that could be added to Money after import: 3.');
      const rej = await text('#actimp-rejected');
      if (!rej.includes('Row 7: date is not a valid DD/MM/YYYY or YYYY-MM-DD date') || !rej.includes('Row 8: looks like an ID or card number') || rej.includes('4111')) throw new Error('rejected rows: ' + rej);
      if (!(await text('#actimp-unknown-cat')).includes('not in your list')) throw new Error('unknown category not offered');
      if ((await text('#actimp-create-cat-0 + span, label:has(#actimp-create-cat-0)')) .indexOf('Whale tour') < 0) throw new Error('Whale tour not listed');
      if (await page.locator('#actimp-create-cat-0').isChecked()) throw new Error('the unknown category is ticked by itself');
      for (const n of ['Sam', 'Alex']) if (!(await text('#actimp-unknown-person + label, #actimp-result')).includes(n)) throw new Error(n + ' not offered as a person');
      if (await page.locator('#actimp-private').count()) throw new Error('Import as private is shown while the vault has no private vault open');
      await layout('preview');
      if ((await acts()) !== 0) throw new Error('the preview wrote something');
    });
    await step('tick Sam and Alex as people, confirm: nothing reaches Money, the category list is unchanged, the offer is listed', async () => {
      for (const i of [0, 1]) {
        await page.check('#actimp-create-person-' + i);
        await page.waitForFunction((n) => document.querySelector('#actimp-create-person-' + n) && document.querySelector('#actimp-create-person-' + n).checked, i, T);
        await page.waitForTimeout(150);
      }
      await page.click('#actimp-confirm'); await noticeIs('Imported 5 activities.');
      if ((await acts()) !== 5) throw new Error('activities ' + await acts());
      if ((await expenses()).length !== 0) throw new Error('the import created expenses');
      const st = await page.evaluate(() => { const s = globalThis.LifeOS.store.getState(); return { cats: s.activityCategories.length, people: s.people.map((p) => p.name).sort(), whale: s.activities.find((a) => a.title === 'Whale watch').category, audit: s.audit.map((a) => a.action) }; });
      if (st.cats !== 8 || st.whale !== 'other' || st.people.join() !== 'Alex,Sam' || !st.audit.includes('activity import')) throw new Error('state ' + JSON.stringify(st));
      await expectText('#actimp-offer-text', '3 imported activities have a cost that is done or paid, $115.50 in all. Nothing is in Money yet.');
      await spend('$0.00', 'before the tap');
      await actStats({ 'act-days': '1', 'act-done-count': '1', 'act-spend': '$60.00', 'act-committed': '$80.00' }, 'imported');
    });
    await step('accept the batch offer: exactly one expense per eligible row, dated as the rules say; a second tap is not offered', async () => {
      await openAct();
      await page.click('#actimp-expenses'); await noticeIs('Added 3 expenses to Money.');
      const ex = await expenses();
      const want = ['Kayak day|2026-11-13|6000', 'Pottery class|2026-11-05|3000', 'Prepaid show|2026-11-02|2550'].sort();
      if (JSON.stringify(ex) !== JSON.stringify(want)) throw new Error('expenses ' + JSON.stringify(ex));
      await expectCount('#actimp-expenses', 0);
      await allNums('after the offer');
    });
    await step('cost by category (hand-computed): outing $60.00 (1), class $30.00 (1), networking no data, total $90.00 (2)', async () => {
      await openAct();
      const rows = await page.$$eval('#roi-by-cat tbody tr', (r) => r.map((x) => [...x.querySelectorAll('td')].map((c) => c.textContent.trim())));
      const by = Object.fromEntries(rows.map((r) => [r[0], r.slice(1)]));
      const ok = (k, a, b) => { if (!by[k] || by[k][0] !== a || by[k][1] !== b) throw new Error(k + ' ' + JSON.stringify(by[k])); };
      ok('outing', '1', '$60.00'); ok('class', '1', '$30.00'); ok('Total', '2', '$90.00');
      if (by.networking && by.networking[1] !== 'no data') throw new Error('networking ' + JSON.stringify(by.networking));
    });
    await step('re-import the same file: nothing is added, it says so, and no second expense appears', async () => {
      await openAct(); await pickFile();
      await page.selectOption('#actimp-datefmt', 'dmy');
      await page.click('#actimp-preview'); await page.waitForSelector('#actimp-summary', T);
      await expectText('#actimp-summary', '0 to add, 2 rejected, 5 already imported.');
      await page.waitForSelector('#actimp-nothing', T);
      if (!(await page.locator('#actimp-confirm').isDisabled())) throw new Error('the confirm button is enabled with nothing to add');
      await expectText('#actimp-confirm', 'Nothing to import');
      await page.click('#actimp-cancel');
      if ((await acts()) !== 5 || (await expenses()).length !== 3) throw new Error('something was added');
      await layout('re-import');
    });
    await step('export the activities, then import that export: nothing new', async () => {
      await openAct();
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#exp-activities')]);
      const out = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
      if (!out.startsWith('"title","date","end date","state"') || out.split('\r\n').length !== 7) throw new Error('export: ' + out.slice(0, 120));
      const p2 = path.join(dir, 'export.csv'); writeFileSync(p2, out);
      await page.setInputFiles('#actimp-file', p2); await page.waitForSelector('#actimp-preview', T);
      await page.click('#actimp-preview'); await page.waitForSelector('#actimp-summary', T);
      await expectText('#actimp-summary', '0 to add, 0 rejected, 5 already imported.');
      await page.click('#actimp-cancel');
    });
    await step('lock, reload, unlock: every number is the same', async () => {
      await page.click('.top .lockbtn'); await page.waitForSelector('#pass', T);
      await page.reload(); await page.waitForSelector('#pass', T);
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
      if ((await acts()) !== 5 || (await expenses()).length !== 3) throw new Error('data changed after unlock');
      await allNums('after unlock');
      await openAct(); await pickFile(); await page.selectOption('#actimp-datefmt', 'dmy'); await page.click('#actimp-preview');
      await expectText('#actimp-summary', '0 to add, 2 rejected, 5 already imported.');
    });
  } catch { /* recorded in problems */ }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-ACTIVITY-IMPORT FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-ACTIVITY-IMPORT PASSED');
