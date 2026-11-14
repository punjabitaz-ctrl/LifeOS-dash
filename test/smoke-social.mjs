// v0.10.0 Social smoke: desktop and 390x844. Fails on console errors, CSP violations, horizontal scroll.
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
// Hand-computed expectations. The page clock is Saturday 2026-11-14 (week 2026-11-09 to 2026-11-15).
// GROUPS: Family 14 and Friends 30 (suggested, accepted), Neighbours 21 (custom). PEOPLE: Ann (Family), Ben (Friends, own cadence 10), Cal (Neighbours), Dee (no group, default 30).
// LOG: Ann 11-02, Ben 10-30, Cal 10-20, Dee none.
//   Ann: 12 days, due 11-16, due soon. Ben: 15 days against 10, overdue by 5. Cal: 25 days against 21, overdue by 4. Dee: never contacted, overdue.
//   Overdue 3 (Ben, Cal, Dee), due in 7 days 1 (Ann), contacts this week 0, people 4.
// Dee "Reached out today" (11-14, due 12-14): overdue 2, contacts this week 1.
// Social-tagged done activity "Neighbour BBQ" on 11-12 with "Cal": Cal's last contact moves 10-20 -> 11-12 (2 days, due 12-03): overdue 1 (Ben), soon 1 (Ann), contacts this week 2.
//   By group (8 weeks, oldest first, weeks start 09-21 ... 11-09): Family 1/0 '0 0 0 0 0 0 1 0'; Friends 1/1 '0 0 0 0 0 1 0 0'; Neighbours 1/0 '0 0 0 0 1 0 0 1'; No group 1/0 '0 0 0 0 0 0 0 1'.
// Ann birthday 11-25 shows at a glance (1 item in 30 days).
// REVIEW: contacts made 2 (Dee, Cal), overdue now 1; became overdue this week: Ben (9 days against 10 on 11-08, 15 now) = 1; due next week: Ann (due 11-16) = 1. Snooze Ben: overdue 0; end snooze: 1.
// DELETE Dee (1 logged contact kept, unlinked): people 3, overdue 1, soon 1, contacts this week 1 (Cal), one logged contact without a person.

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
  const expectIncludes = (sel, want) => poll(() => text(sel), (g) => g.includes(want), sel + ' (expected to include ' + JSON.stringify(want) + ')');
  const expectCount = (sel, want) => poll(() => page.locator(sel).count(), (g) => g === want, sel + ' count (expected ' + want + ')');
  const cells = (sel) => page.$$eval(sel + ' td', (c) => c.map((x) => x.textContent.trim()));
  const expectCells = (sel, want) => poll(() => cells(sel), (g) => JSON.stringify(g) === JSON.stringify(want), sel + ' cells (expected ' + JSON.stringify(want) + ')');
  const layout = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, clipped: [...document.querySelectorAll('.nav button')].filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.textContent) }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
    if (r.clipped.length) throw new Error(where + ': nav labels clipped: ' + r.clipped.join(', '));
  };
  const openFold = async (id) => { await page.waitForSelector('#' + id, T); if (!(await page.locator('#' + id).evaluate((el) => el.open))) await page.click('#' + id + ' > summary'); };
  const dash = async () => { await nav('Home'); await page.waitForSelector('.tile', T); };
  const tile = async (value, sub, where) => {
    await dash();
    await expectText('.tile[data-domain="social"] .tile-value', value);
    const t = await text('.tile[data-domain="social"]');
    if (!t.includes(sub)) throw new Error(where + ' social tile: ' + t);
    await layout(where + ' dashboard');
  };
  const noticeIs = (msg) => page.waitForSelector('.notice:has-text("' + msg + '")', T);
  const openSocial = async () => { await dash(); await page.click('.tile[data-domain="social"]'); await page.waitForSelector('h1:has-text("Social")', T); };
  const openPerson = async (name) => { await openSocial(); await page.click('.soc-person-row[data-person="' + name + '"] .soc-details, .soc-person-row[data-person="' + name + '"] button'); await page.waitForSelector('h1:has-text("' + name + '")', T); };
  const stats = async (w, where) => { for (const [id, v] of Object.entries(w)) await expectText('#' + id, v); await layout(where); };
  async function addPerson(f) {
    await openFold('soc-add');
    await page.fill('#soc-p-name', f.name);
    await page.selectOption('#soc-p-group', f.group ? { label: f.group } : '');
    await page.fill('#soc-p-cad', f.cad || '');
    await page.click('#soc-p-add');
    await noticeIs('Person added.');
  }
  async function logContact(name, date) {
    await openPerson(name);
    await page.fill('#soc-l-date', date); await page.selectOption('#soc-l-channel', 'in person'); await page.click('#soc-l-add');
    await noticeIs('Contact logged.');
    await expectCount('.soc-log-item[data-date="' + date + '"]', 1);
  }
  const mainStats = (o, p, w, pe, where) => stats({ 'soc-overdue': o, 'soc-soon': p, 'soc-week': w, 'soc-people': pe }, where);

  try {
    await page.clock.install({ time: new Date(2026, 10, 14, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('create vault; empty Social tile and intro with suggested groups', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")');
      await page.waitForSelector('.tile', T);
      await tile('0', '0 tracked, over 30 days since contact', 'empty');
      await openSocial(); await page.waitForSelector('#soc-intro', T);
      await expectCount('.soc-sug', 3); await expectCount('.soc-group-item', 0);
      await layout('social intro');
    });
    await step('accept two suggested groups and add a custom one', async () => {
      await page.click('.soc-sug[data-name="Family"]'); await noticeIs('Family added.');
      await page.click('.soc-sug[data-name="Friends"]'); await noticeIs('Friends added.');
      await expectCount('.soc-sug', 1);
      await openFold('soc-groups'); await page.fill('#soc-g-name', 'Neighbours'); await page.fill('#soc-g-days', '21'); await page.click('#soc-g-add'); await noticeIs('Group added.');
      await expectIncludes('#soc-groups-intro', 'Family, every 14 days'); await expectIncludes('#soc-groups-intro', 'Friends, every 30 days'); await expectIncludes('#soc-groups-intro', 'Neighbours, every 21 days');
      await layout('social groups');
    });
    await step('add people with and without their own cadence', async () => {
      await addPerson({ name: 'Ann', group: 'Family (14 days)' });
      await addPerson({ name: 'Ben', group: 'Friends (30 days)', cad: '10' });
      await addPerson({ name: 'Cal', group: 'Neighbours (21 days)' });
      await addPerson({ name: 'Dee' });
      await expectCount('.soc-person-row', 4);
      await mainStats('4', '0', '0', '4', 'four people, none contacted');
      await page.fill('#soc-p-name', 'Ann'); await page.click('#soc-p-add');
      await page.waitForSelector('.notice.err:has-text("already")', T);
    });
    await step('log contacts on different dates; overdue, due soon and the tile', async () => {
      await logContact('Ann', '2026-11-02'); await logContact('Ben', '2026-10-30'); await logContact('Cal', '2026-10-20');
      await openSocial();
      await mainStats('3', '1', '0', '4', 'after the log');
      await expectCount('#soc-overdue-list .soc-row', 3); await expectCount('#soc-soon-list .soc-row', 1);
      const order = await page.$$eval('#soc-overdue-list .soc-row', (r) => r.map((x) => x.getAttribute('data-person')));
      if (JSON.stringify(order) !== JSON.stringify(['Dee', 'Ben', 'Cal'])) throw new Error('overdue order ' + order);
      await expectIncludes('#soc-overdue-list .soc-row[data-person="Ben"]', 'overdue by 5 days'); await expectIncludes('#soc-overdue-list .soc-row[data-person="Cal"]', 'overdue by 4 days');
      await expectIncludes('#soc-overdue-list .soc-row[data-person="Dee"]', 'No contact yet'); await expectIncludes('#soc-soon-list .soc-row[data-person="Ann"]', 'due 2026-11-16');
      await tile('3', '1 due in 7 days, 0 contacts this week', 'after the log');
    });
    await step('"Reached out today" from the overdue list', async () => {
      await openSocial();
      await page.click('#soc-overdue-list .soc-row[data-person="Dee"] .soc-reached'); await noticeIs('Contact logged.');
      await mainStats('2', '1', '1', '4', 'Dee reached out');
      await expectCount('#soc-overdue-list .soc-row', 2);
    });
    await step('a social-tagged activity naming a person moves their last contact; suggestions and the add-as-person offer', async () => {
      await openPerson('Cal');
      await expectText('#soc-p-last', 'Last contact 2026-10-20 (25 days ago)');
      await dash(); await page.click('.tile[data-domain="activities"]'); await page.waitForSelector('#act-upcoming', T);
      await openFold('act-add');
      await page.fill('#act-title', 'Neighbour BBQ'); await page.fill('#act-date', '2026-11-12'); await page.press('#act-date', 'Tab'); await page.selectOption('#act-state', 'done');
      await page.fill('#act-people', 'ca');
      await expectCount('#act-people-suggest .people-pick', 1);
      await page.click('#act-people-suggest .people-pick'); if ((await page.inputValue('#act-people')) !== 'Cal') throw new Error('suggestion not applied: ' + (await page.inputValue('#act-people')));
      await page.check('#act-social'); await page.click('#act-add-btn'); await noticeIs('Activity added.');
      await openFold('act-add');
      await page.fill('#act-title', 'Chat with Eve'); await page.fill('#act-date', '2026-11-12'); await page.press('#act-date', 'Tab'); await page.selectOption('#act-state', 'done');
      await page.fill('#act-people', 'Eve'); await page.check('#act-social'); await page.click('#act-add-btn'); await noticeIs('Activity added.');
      await expectCount('.act-item[data-title="Chat with Eve"] .act-addperson', 1);
      await expectCount('.act-item[data-title="Neighbour BBQ"] .act-addperson', 0);
      await openPerson('Cal');
      await expectText('#soc-p-last', 'Last contact 2026-11-12 (2 days ago), from Activities');
      await expectCount('.soc-log-item', 1);
      await openSocial();
      await mainStats('1', '1', '2', '4', 'after the activity');
      await expectCount('.soc-person-row[data-person="Eve"]', 0);
      await tile('1', '1 due in 7 days, 2 contacts this week', 'after the activity');
    });
    await step('by-group table matches the hand-computed numbers', async () => {
      await openSocial();
      await expectCells('#soc-group-table', ['Family (14 d)', '1', '0', '0 0 0 0 0 0 1 0', 'Friends (30 d)', '1', '1', '0 0 0 0 0 1 0 0', 'Neighbours (21 d)', '1', '0', '0 0 0 0 1 0 0 1', 'No group', '1', '0', '0 0 0 0 0 0 0 1']);
      await layout('by group');
    });
    await step('a birthday within 30 days shows at a glance', async () => {
      await openPerson('Ann');
      await page.fill('#soc-d-label', 'Birthday'); await page.fill('#soc-d-date', '2026-11-25'); await page.click('#soc-d-add'); await noticeIs('Date added.');
      await expectCount('.soc-date-item', 1);
      await dash();
      await expectText('#dash-glance-sum', '1 item in the next 30 days.');
      await openFold('dash-glance-later');
      await expectText('#dash-glance .gl-item[data-title="Birthday: Ann"]', 'Birthday: Ann 2026-11-25');
      await layout('glance with birthday');
    });
    await step('facts: add, newest first, search, secrets guard, remove', async () => {
      await openPerson('Ann');
      await page.fill('#soc-f-label', 'Allergy'); await page.fill('#soc-f-text', 'Peanuts'); await page.click('#soc-f-add'); await expectCount('.soc-fact', 1);
      await page.fill('#soc-f-label', 'Kids'); await page.fill('#soc-f-text', 'Mia and Leo'); await page.click('#soc-f-add'); await expectCount('.soc-fact', 2);
      const order = await page.$$eval('.soc-fact', (r) => r.map((x) => x.getAttribute('data-label')));
      if (JSON.stringify(order) !== JSON.stringify(['Kids', 'Allergy'])) throw new Error('fact order ' + order);
      await page.fill('#soc-f-label', 'Card'); await page.fill('#soc-f-text', 'number 4111 1111 1111 1111'); await page.click('#soc-f-add');
      await page.waitForSelector('.notice.err:has-text("ID number")', T); await expectCount('.soc-fact', 2);
      if ((await page.getAttribute('#soc-f-text', 'maxlength')) !== '200' || (await page.getAttribute('#soc-f-label', 'maxlength')) !== '40' || (await page.getAttribute('#soc-l-note', 'maxlength')) !== '200') throw new Error('maxlength');
      await openSocial();
      await page.fill('#soc-search', 'PEANUTS'); await expectCount('#soc-results .soc-result[data-person="Ann"]', 1);
      await page.fill('#soc-search', '.*'); await expectCount('#soc-results .soc-result', 0); await expectIncludes('#soc-results', 'No matches.');
      await page.fill('#soc-search', 'ben'); await expectCount('#soc-results .soc-result[data-person="Ben"]', 1);
      await openPerson('Ann'); await page.click('.soc-fact[data-label="Kids"] .soc-fact-del'); await noticeIs('Fact removed.'); await expectCount('.soc-fact', 1);
      await layout('facts');
    });
    await step('link a person to a pipeline item and a project; unlink from both sides', async () => {
      await nav('Work'); await page.waitForSelector('#pipeline', T);
      await openFold('pl-new'); await page.fill('#pl-title', 'Acme deal'); await page.click('#pl-add'); await noticeIs('Pipeline item added.');
      await openFold('pj-new'); await page.fill('#pj-name', 'Launch'); await page.click('#pj-add'); await noticeIs('Project added.');
      await page.selectOption('.pitem[data-item="Acme deal"] .wk-people select', { label: 'Ben' }); await page.click('.pitem[data-item="Acme deal"] .wk-link');
      await expectIncludes('.pitem[data-item="Acme deal"] .wk-person[data-person="Ben"]', 'last contact 2026-10-30');
      await page.selectOption('.proj[data-project="Launch"] .wk-people select', { label: 'Ben' }); await page.click('.proj[data-project="Launch"] .wk-link');
      await expectIncludes('.proj[data-project="Launch"] .wk-person[data-person="Ben"]', 'last contact 2026-10-30');
      await openPerson('Ben'); await expectCount('.soc-pipe[data-title="Acme deal"]', 1); await expectCount('.soc-proj[data-title="Launch"]', 1);
      await page.click('.soc-unlink-pipe'); await noticeIs('Unlinked. Nothing was deleted.'); await expectCount('.soc-pipe', 0);
      await nav('Work'); await page.waitForSelector('#pipeline', T);
      await expectCount('.pitem[data-item="Acme deal"]', 1); await expectCount('.pitem[data-item="Acme deal"] .wk-person', 0);
      await page.selectOption('.pitem[data-item="Acme deal"] .wk-people select', { label: 'Ben' }); await page.click('.pitem[data-item="Acme deal"] .wk-link'); await expectCount('.pitem[data-item="Acme deal"] .wk-person[data-person="Ben"]', 1);
      await page.click('.pitem[data-item="Acme deal"] .wk-unlink'); await noticeIs('Unlinked. Nothing was deleted.'); await expectCount('.pitem[data-item="Acme deal"] .wk-person', 0);
      await openPerson('Ben'); await expectCount('.soc-pipe', 0); await expectCount('.soc-proj', 1);
      await page.selectOption('#soc-work select >> nth=0', { label: 'Acme deal' }); await page.click('.soc-link-pipeline'); await noticeIs('Linked.'); await expectCount('.soc-pipe[data-title="Acme deal"]', 1);
      await layout('work links');
    });
    await step('weekly review Social step offers; a snooze is one tap', async () => {
      await nav('Review'); await page.waitForSelector('#rv-social', T);
      await expectText('#rv-soc-stats', 'This week: 2 contacts made, 1 overdue now.');
      await expectText('#rv-soc-became-h', 'Became overdue this week (1)'); await expectText('#rv-soc-next-h', 'Due next week (1)');
      await expectCount('#rv-social .soc-row[data-state="overdue"][data-person="Ben"]', 1);
      for (const c of ['.soc-reached', '.soc-snooze', '.soc-cadence', '.soc-archive']) await expectCount('#rv-social .soc-row[data-person="Ben"] ' + c, 1);
      await tile('1', '1 due in 7 days, 2 contacts this week', 'review does not change anything');
      await nav('Review');
      await page.click('#rv-social .soc-row[data-person="Ben"] .soc-snooze'); await noticeIs('Snoozed for 7 days.');
      await expectText('#rv-soc-stats', 'This week: 2 contacts made, 0 overdue now.');
      await layout('review social');
      await tile('0', '1 due in 7 days, 2 contacts this week', 'snoozed');
      await openPerson('Ben'); await page.click('.soc-unsnooze'); await openSocial(); await mainStats('1', '1', '2', '4', 'snooze ended');
    });
    await step('delete a person: the log survives, unlinked', async () => {
      await openPerson('Dee'); await page.click('.soc-del');
      await expectIncludes('#soc-del-count', '1 logged contact.');
      await page.click('.dialog button:has-text("Delete person")'); await noticeIs('Person deleted. Their log is kept.');
      await mainStats('1', '1', '1', '3', 'Dee deleted');
      await expectCount('.soc-person-row[data-person="Dee"]', 0);
      await openFold('soc-unlinked'); await expectCount('.soc-unlinked-item', 1); await expectIncludes('.soc-unlinked-item', '2026-11-14');
      await tile('1', '1 due in 7 days, 1 contact this week', 'Dee deleted');
    });
    const final = async (where) => {
      await tile('1', '1 due in 7 days, 1 contact this week', where);
      await openSocial(); await mainStats('1', '1', '1', '3', where);
      await expectCount('.soc-person-row', 3); await expectCount('#soc-unlinked', 1);
      await openPerson('Ann'); await expectCount('.soc-fact', 1); await expectCount('.soc-date-item', 1);
      await openPerson('Ben'); await expectCount('.soc-pipe[data-title="Acme deal"]', 1); await expectCount('.soc-proj[data-title="Launch"]', 1);
      await dash(); await openFold('dash-glance-later'); await expectCount('#dash-glance .gl-item[data-title="Birthday: Ann"]', 1);
    };
    await step('lock and unlock', async () => {
      await page.click('.top .lockbtn'); await page.waitForSelector('#pass', T);
      for (const secret of ['Peanuts', 'Acme deal', 'Neighbour BBQ', 'Launch']) if ((await page.textContent('body')).includes(secret)) throw new Error('locked page shows ' + secret);
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
      await final('after unlock');
    });
    await step('persistence after reload', async () => {
      await page.reload(); await page.waitForSelector('#pass', T);
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
      await final('after reload');
    });
    await step('settings: version, and no Social text', async () => {
      await nav('Settings'); await page.waitForSelector('#app-version', T);
      await expectText('#app-version', 'LifeOS v0.11.0');
      const t = await text('main'); for (const secret of ['Peanuts', 'Acme deal', 'Neighbour BBQ']) if (t.includes(secret)) throw new Error('settings page shows ' + secret);
      await layout('settings');
    });
    await step('later contact entries (as from a CSV import) convert on one tap, once (audit v0.10.0)', async () => {
      await page.evaluate(() => globalThis.LifeOS.store.commit((x) => { x.entries.push(
        { id: 'csv1', domain: 'social', type: 'contact', date: '2026-11-03', title: 'Lunch', person: ' ann ', notes: '', createdAt: '2026-11-03T00:00:00.000Z' },
        { id: 'csv2', domain: 'social', type: 'contact', date: '2026-11-04', title: 'Call', person: 'Zed', notes: '', createdAt: '2026-11-04T00:00:00.000Z' }); }));
      await openSocial(); await expectIncludes('#soc-convert', '2 older contact entries are not part of the people list yet.');
      await page.click('#soc-convert-btn'); await noticeIs('2 entries converted. Entries that did not fit are kept below.');
      await expectCount('#soc-convert', 0); await expectCount('.soc-person-row', 4); await expectCount('.soc-person-row[data-person="Zed"]', 1);
      const st = await page.evaluate(() => { const s = globalThis.LifeOS.store.getState(); return [s.entries.filter((e) => e.domain === 'social').length, s.contacts.length]; });
      if (st[0] !== 0) throw new Error('entries left ' + st[0]);
      await layout('after convert');
      await expectCount('#soc-ambiguous', 0);
      await page.evaluate(() => globalThis.LifeOS.store.commit((x) => { x.people.push({ id: 'dupzed', name: 'ZED', importantDates: [], pipelineIds: [], projectIds: [], facts: [], notes: '', archived: false }); }));
      await openSocial(); await expectCount('#soc-ambiguous', 1);
    });
  } catch { /* recorded in problems */ }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-SOCIAL FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-SOCIAL PASSED');
