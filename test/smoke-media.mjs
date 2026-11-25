// v1.7.0 AYiN and clients, Podcasts and Websites smoke: desktop and 390x844. Fails on console errors, CSP violations, horizontal scroll.
// Run `node build.mjs` first. Needs Playwright (`npm i --no-save playwright`) and Chrome at /usr/bin/google-chrome.
import path from 'node:path';
import { navTo } from './_nav.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { skipTour } from './_tour.mjs';
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
// Hand-computed expectations. The page clock is Thursday 2026-11-12 10:00; its week (Monday start) is 2026-11-09 to 2026-11-15.
// Fixtures (written through the store): the line of work "AYiN Advisory" (venture) with income 2026-11-05 $1,000, 2026-10-20 $500 and 2026-03-01 $250,
//   and one expense 2026-11-06 $200. Invoices: 1001 sent, due 2026-11-01, $800 (overdue); 1002 sent, due 2026-12-01, $300.
// Rollup: month $1,000.00; quarter (Oct to date) $1,500.00; year $1,750.00. Invoices open 2 ($1,100.00), overdue 1 ($800.00).
// Client "Acme Co" (budget $5,000 on that line, both invoices linked): revenue to date $1,750.00 (income on its line); open 2 ($1,100.00); overdue 1 ($800.00);
//   budget $5,000.00, spent $200.00, remaining $4,800.00; after a contact is logged the last contact is today. Clients with an overdue invoice: 1.
// Show "Night Show": five default platforms. Episode 1 "Pilot talk" published, audio release on Spotify 2026-11-03: published 1; months 2026-06 to 2026-10 have no data,
//   2026-11 is 1; 9 days since the last episode (12 Nov minus 3 Nov).
// Numbers: Spotify downloads 120 on 2026-11-05 and 80 on 2026-11-09 = 200 in November (latest 80); YouTube views 1,500 on 2026-10-15 (October 1,500, November no data);
//   YouTube subscribers 40 on 2026-11-01 and 55 on 2026-11-10 (the month shows the latest, 55). A measure is never added to another.
// Site "night.example": domain renewal 2026-12-01 $15, hosting renewal 2027-03-01 $120. Traffic 2026-11 1,234 visits and 2026-09 900 (October no data).
// Digest media numbers for the week: clients with an overdue invoice 1, episodes published this month 1, sites renewing within 30 days 1.

async function run(label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage(); await skipTour(page);
  const narrow = !!viewport;
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
  const text = (sel) => page.textContent(sel).then((t) => t.trim());
  const expectText = async (sel, want) => { const got = await text(sel); if (got !== want) throw new Error(sel + ' is ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want)); };
  const expectAll = async (want) => { for (const [sel, v] of Object.entries(want)) await expectText(sel, v); };
  const layout = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
  };
  // AYiN and clients are in the bar (desktop) or the More sheet (phone); Podcasts and Websites are in the More sheet, and on desktop one tap from Business.
  const clients = async () => { await navTo(page, 'AYiN and clients'); await page.waitForSelector('#cl-rollup', T); };
  const media = async (name, id) => {
    if (narrow) await navTo(page, name); else { await navTo(page, 'Business'); await page.waitForSelector('#go-' + id, T); await page.click('#go-' + id); }
    await page.waitForSelector('#' + id, T);
  };
  const row = (platform, measure) => page.evaluate(([p, m]) => {
    const h4 = [...document.querySelectorAll('#podcasts h4')].find((x) => x.textContent === p);
    const tr = h4 && h4.nextElementSibling && h4.nextElementSibling.querySelector('tr[data-cat="' + m + '"]');
    return tr ? [...tr.children].map((c) => c.textContent) : null;
  }, [platform, measure]);
  const expectRow = async (platform, measure, want) => {
    const got = await row(platform, measure);
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(platform + ' ' + measure + ' row is ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want));
  };
  let typed = 0;
  async function addNumber(platform, measure, value, date) {
    const f = page.locator('.sn-form');
    await f.locator('select').nth(0).selectOption({ label: platform }); await f.locator('select').nth(1).selectOption(measure);
    await f.locator('input[type=text]').first().fill(String(value)); await f.locator('input[type=date]').fill(date);
    await f.locator('.sn-add').click(); typed++;
    await page.waitForFunction((n) => document.querySelectorAll('.sn-row').length === n, typed, T);
  }
  async function search(q) {
    const isNarrow = !(await page.locator('#hs-q').count());
    if (isNarrow) { await page.click('#nav-more'); await page.waitForSelector('#ms-q', T); }
    const pre = isNarrow ? 'ms' : 'hs';
    await page.fill('#' + pre + '-q', q);
    await page.waitForSelector('#' + pre + '-results .searchhit, #' + pre + '-none', T);
    const hits = await page.$$eval('#' + pre + '-results .searchhit', (b) => b.map((x) => x.getAttribute('data-area') + ':' + x.getAttribute('data-label')));
    if (isNarrow) { await page.keyboard.press('Escape'); await page.waitForSelector('#ms-q', { state: 'detached', ...T }).catch(async () => { await page.click('.dialog button:has-text("Close")'); }); }
    else await page.fill('#hs-q', '');
    return hits;
  }
  try {
    await page.clock.install({ time: new Date(2026, 10, 12, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('create the vault; the three screens start empty', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS); await page.click('button:has-text("Create vault")');
      await page.waitForSelector('.tile', T);
      await clients();
      await expectAll({ '#cl-rev-month': '$0.00', '#cl-rev-year': '$0.00', '#cl-n-overdue': '0', '#cl-none': 'No clients yet. Add one below.' });
      await layout('clients, empty');
      await media('Podcasts', 'podcasts'); await expectText('#pc-none', 'No shows yet. Add one below.'); await layout('podcasts, empty');
      await media('Websites', 'websites'); await expectText('#ws-none', 'No sites yet. Add one below.'); await layout('websites, empty');
    });
    await step('fixtures: a line of work with income and an expense, two invoices, a person', async () => {
      await page.evaluate(() => {
        const L = globalThis.LifeOS, E = (o) => L.metrics.validateEntry(o);
        return L.store.commit((x) => {
          x.projects.push({ id: 'pj1', name: 'AYiN Advisory', kind: 'venture', status: 'active', nextAction: '', archived: false });
          x.entries.push(E({ id: 'i1', domain: 'money', type: 'income', date: '2026-11-05', title: 'Fee A', value: 1000, projectId: 'pj1' }), E({ id: 'i2', domain: 'money', type: 'income', date: '2026-10-20', title: 'Fee B', value: 500, projectId: 'pj1' }),
            E({ id: 'i3', domain: 'money', type: 'income', date: '2026-03-01', title: 'Fee C', value: 250, projectId: 'pj1' }), E({ id: 'x1', domain: 'money', type: 'expense', date: '2026-11-06', title: 'Tools', value: 200, category: 'Other', projectId: 'pj1' }));
          x.invoices.push({ id: 'iv1', number: '1001', projectId: 'pj1', issueDate: '2026-10-15', dueDate: '2026-11-01', lines: [{ description: 'Work', qty: 1, unitCents: 80000 }], status: 'sent', notes: '' },
            { id: 'iv2', number: '1002', projectId: 'pj1', issueDate: '2026-11-10', dueDate: '2026-12-01', lines: [{ description: 'Work', qty: 1, unitCents: 30000 }], status: 'sent', notes: '' });
          L.social.addPerson(x, { name: 'Pat Client' });
        }, { quiet: true });
      });
    });
    await step('the rollup equals the hand-computed figures', async () => {
      await clients();
      await expectAll({ '#cl-rev-month': '$1,000.00', '#cl-rev-quarter': '$1,500.00', '#cl-rev-year': '$1,750.00', '#cl-inv-open': '2 ($1,100.00)', '#cl-inv-overdue': '1 ($800.00)' });
      await layout('clients, rollup');
    });
    await step('add a client, link two invoices and a person, log a contact', async () => {
      await page.evaluate(() => { const d = document.querySelector('#cl-new'); if (d) d.open = true; });
      await page.fill('#ca-name', 'Acme Co'); await page.selectOption('#ca-line', 'pj1'); await page.fill('#ca-budget', '5000');
      await page.click('#ca-add'); await page.waitForSelector('.notice.ok:has-text("Client added")', T);
      const C = '.cl-card[data-client="Acme Co"]';
      await page.waitForSelector(C, T);
      await page.getByLabel('Link the chosen invoice to Acme Co', { exact: true }).click(); await page.waitForSelector(C + ' .cl-inv[data-number="1001"]', T);
      await page.getByLabel('Link the chosen invoice to Acme Co', { exact: true }).click(); await page.waitForSelector(C + ' .cl-inv[data-number="1002"]', T);
      await page.getByLabel('Link the chosen person to Acme Co', { exact: true }).click(); await page.waitForSelector(C + ' .cl-person[data-person="Pat Client"]', T);
      const before = await text(C);
      for (const want of ['$1,750.00 (income on its line of work)', '2 ($1,100.00)', '1 ($800.00)', 'no contact yet', 'Budget $5,000.00, spent $200.00, remaining $4,800.00', 'Overdue invoice']) if (!before.includes(want)) throw new Error('client card lacks ' + want + ': ' + before);
      await page.click(C + ' .cl-log'); await page.waitForSelector('.notice.ok:has-text("Contact logged")', T);
      const after = await text(C);
      if (!after.includes('2026-11-12 (0 days ago)')) throw new Error('last contact: ' + after);
      await expectText('#cl-n-overdue', '1'); await expectText('#cl-n-contact', '0');
      await layout('clients, one client');
    });
    await step('a show with the default platforms and an episode', async () => {
      await media('Podcasts', 'podcasts');
      await page.fill('#sa-name', 'Night Show'); await page.selectOption('#sa-line', 'pj1');
      await page.click('#sa-add'); await page.waitForSelector('.notice.ok:has-text("Show added")', T);
      const names = await page.$$eval('.pc-platform', (c) => c.map((x) => x.getAttribute('data-platform')));
      if (names.join() !== 'YouTube,Spotify,Apple Podcasts,YouTube Podcasts,Website') throw new Error('default platforms: ' + names);
      await page.fill('input[id^="ea-"][id$="-title"]', 'Pilot talk'); await page.fill('input[id^="ea-"][id$="-num"]', '1'); await page.selectOption('select[id^="ea-"][id$="-status"]', 'published');
      await page.check('input[id^="ea-"][id$="-g0"]');
      await page.click('.pc-ep-add'); await page.waitForSelector('.pc-episode[data-title="Pilot talk"]', T);
      const E = '.pc-episode[data-title="Pilot talk"]';
      await page.locator(E + ' .row select').nth(0).selectOption('audio'); await page.locator(E + ' .row select').nth(1).selectOption({ label: 'Spotify' });
      await page.fill(E + ' .row input[type=date]', '2026-11-03'); await page.click(E + ' .pc-rel-set'); await page.waitForSelector(E + ' .pc-releases .chip[data-format="audio"]', T);
      if (!(await text(E)).includes('Guests: Pat Client')) throw new Error('guest missing');
      await expectText('[id^="pc-gap-"]', '9');
      await expectText('table[id^="pc-cad-"] tr[data-cat="2026-11"] td:nth-child(2)', '1');
      await expectText('table[id^="pc-cad-"] tr[data-cat="2026-10"] td:nth-child(2)', 'no data');
      await layout('podcasts, one episode');
    });
    await step('platform numbers: latest and monthly, a missing month is no data, measures stay apart', async () => {
      await addNumber('Spotify', 'downloads', 120, '2026-11-05'); await addNumber('Spotify', 'downloads', 80, '2026-11-09');
      await addNumber('YouTube', 'views', 1500, '2026-10-15');
      await addNumber('YouTube', 'subscribers', 40, '2026-11-01'); await addNumber('YouTube', 'subscribers', 55, '2026-11-10');
      const nd = 'no data';
      await expectRow('Spotify', 'downloads', ['Downloads', '80 (2026-11-09)', nd, nd, nd, nd, nd, '200']);
      await expectRow('YouTube', 'views', ['Views', '1,500 (2026-10-15)', nd, nd, nd, nd, '1,500', nd]);
      await expectRow('YouTube', 'subscribers', ['Subscribers', '55 (2026-11-10)', nd, nd, nd, nd, nd, '55']);
      if (await row('Spotify', 'views')) throw new Error('a measure nobody typed has a row');
      await layout('podcasts, numbers');
    });
    await step('a site with renewals and traffic', async () => {
      await media('Websites', 'websites');
      await page.fill('#wa-domain', 'night.example'); await page.selectOption('#wa-purpose', 'show'); await page.fill('#wa-host', 'Hostly');
      await page.fill('#wa-ddate', '2026-12-01'); await page.fill('#wa-dcost', '15'); await page.fill('#wa-hdate', '2027-03-01'); await page.fill('#wa-hcost', '120');
      await page.click('#wa-add'); await page.waitForSelector('.notice.ok:has-text("Site added")', T);
      await page.waitForSelector('.ws-site[data-site="night.example"]', T);
      await expectText('.ws-renewal[data-which="domain"]', 'Domain renews 2026-12-01, $15.00');
      await expectText('.ws-renewal[data-which="hosting"]', 'Hosting renews 2027-03-01, $120.00');
      const w = page.locator('.wt-form');
      await w.locator('input[type=month]').fill('2026-11'); await w.locator('input[type=text]').first().fill('1234'); await w.locator('.wt-add').click(); await page.waitForFunction(() => document.querySelectorAll('.wt-row').length === 1, null, T);
      await w.locator('input[type=month]').fill('2026-09'); await w.locator('input[type=text]').first().fill('900'); await w.locator('.wt-add').click(); await page.waitForFunction(() => document.querySelectorAll('.wt-row').length === 2, null, T);
      await expectAll({ 'table[id^="wt-"] tr[data-cat="2026-11"] td:nth-child(2)': '1,234', 'table[id^="wt-"] tr[data-cat="2026-10"] td:nth-child(2)': 'no data', 'table[id^="wt-"] tr[data-cat="2026-09"] td:nth-child(2)': '900' });
      await layout('websites, one site');
    });
    await step('the digest carries three numbers; the calendar file holds generic labels only; search finds the new records', async () => {
      const r = await page.evaluate(() => { const L = globalThis.LifeOS, s = L.store.getState(); return { media: L.metrics.weeklyDigest(s, '2026-11-09').media, ics: L.calendar.build(s, { today: '2026-11-12' }).text, icsReal: L.calendar.build(s, { today: '2026-11-12', realTitles: true }).text, digest: JSON.stringify(L.metrics.weeklyDigest(s, '2026-11-09')) }; });
      if (JSON.stringify(r.media) !== JSON.stringify({ clientsOverdue: 1, episodesThisMonth: 1, sitesRenewing: 1 })) throw new Error('media digest ' + JSON.stringify(r.media));
      if ((r.ics.match(/LifeOS: renewal due/g) || []).length < 2) throw new Error('the two renewals are not in the calendar file generic: ' + r.ics.slice(0, 400));
      if (!r.icsReal.includes('LifeOS: Domain renewal')) throw new Error('the real-title file lacks the generic site renewal title');
      for (const bad of ['night.example', 'Hostly', 'Acme', 'Night Show', 'Pilot talk', 'Spotify']) { if (r.ics.includes(bad) || r.icsReal.includes(bad) || r.digest.includes(bad)) throw new Error('a name reached the calendar file or digest: ' + bad); }
      const a = await search('acme'); if (a.join() !== 'clients:Acme Co') throw new Error('acme: ' + a);
      const n = await search('night'); if (n.sort().join() !== 'podcasts:Night Show,websites:night.example') throw new Error('night: ' + n);
      const p = await search('pilot'); if (p.join() !== 'podcasts:Pilot talk') throw new Error('pilot: ' + p);
    });
    await step('at a glance and the weekly review carry generic labels and numbers; the guest sees the episode on the Social record', async () => {
      await navTo(page, 'Overview'); await page.waitForSelector('#dash-glance', T);
      const g = await text('#dash-glance');
      if (!g.includes('Clients with an overdue invoice: 1')) throw new Error('glance: ' + g);
      if (g.includes('Acme')) throw new Error('a client name is at a glance');
      await navTo(page, 'Review'); await page.waitForSelector('#rv-clients', T);
      await expectText('#rv-cl-stats', 'Clients with an overdue invoice: 1. Clients with no recent contact: 0.');
      await expectText('#rv-media-stats', 'Episodes published this month: 1. Sites with a renewal in the next 30 days: 1.');
      await navTo(page, 'Overview'); await page.waitForSelector('.tile', T); await page.click('.tile[data-domain="social"]'); await page.waitForSelector('.soc-person-row[data-person="Pat Client"]', { state: 'attached', ...T });
      await page.evaluate(() => { for (const d of document.querySelectorAll('details')) d.open = true; });
      await page.click('.soc-person-row[data-person="Pat Client"] button'); await page.waitForSelector('#soc-episodes', T);
      if (!(await text('#soc-episodes')).includes('Pilot talk')) throw new Error('the guest episode is not on the person page');
      await layout('social person');
    });
    await step('lock and unlock: the locked page shows nothing from these screens', async () => {
      await page.click('.top .lockbtn'); await page.waitForSelector('#pass', T);
      const body = await page.textContent('body');
      for (const s of ['Acme', 'Night Show', 'night.example', 'Pilot talk', 'Pat Client']) if (body.includes(s)) throw new Error('the locked page shows ' + s);
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
      await clients(); await expectAll({ '#cl-rev-year': '$1,750.00', '#cl-n-overdue': '1' });
      await layout('clients, after unlock');
    });
    await step('v1.7.0 audit (SEC-119, SEC-120): saving a form keeps an archived line of work and a guest past the first 200 people', async () => {
      const ids = await page.evaluate(() => {
        const L = globalThis.LifeOS;
        let out = null;
        return L.store.commit((x) => {
          for (let i = 1; i <= 205; i++) L.social.addPerson(x, { name: 'Guest ' + String(i).padStart(3, '0') });
          const last = x.people[x.people.length - 1].id, ep = x.episodes[0];
          ep.guestIds = ep.guestIds.concat([last]);
          x.projects.find((p) => p.id === 'pj1').archived = true;
          out = { last, ep: ep.id };
        }, { quiet: true }).then(() => out);
      });
      await media('Podcasts', 'podcasts');
      await page.click('.pc-episode[data-title="Pilot talk"] .pc-ep-edit'); await page.click('.dialog button:has-text("Save")'); await page.waitForSelector('.notice.ok:has-text("Episode saved")', T);
      await page.click('.pc-show[data-show="Night Show"] .pc-edit'); await page.click('.dialog button:has-text("Save")'); await page.waitForSelector('.notice.ok:has-text("Show saved")', T);
      await clients();
      await page.click('.cl-card[data-client="Acme Co"] .cl-edit'); await page.click('.dialog button:has-text("Save")'); await page.waitForSelector('.notice.ok:has-text("Client saved")', T);
      const st = await page.evaluate((o) => { const s = globalThis.LifeOS.store.getState(); return { guests: s.episodes.find((e) => e.id === o.ep).guestIds, show: s.shows[0].projectId, client: s.clients[0].projectId }; }, ids);
      if (!st.guests.includes(ids.last) || st.guests.length !== 2) throw new Error('the episode lost a guest on save: ' + JSON.stringify(st.guests));
      if (st.show !== 'pj1' || st.client !== 'pj1') throw new Error('a form dropped the archived line of work: ' + JSON.stringify(st));
      await page.evaluate(() => globalThis.LifeOS.store.commit((x) => { x.projects.find((p) => p.id === 'pj1').archived = false; }, { quiet: true }));
    });
    await step('v1.7.0 audit (SEC-122): with an expense, a contact and a renewal in the closed private vault, the totals that skip them show the lock marker', async () => {
      await page.evaluate(async () => {
        const L = globalThis.LifeOS, P = L.priv, s = L.store.getState();
        await P.setUp('a private passphrase 99');
        if (!P.isOpen()) await P.open('a private passphrase 99');
        await P.moveIn('entries', 'x1'); await P.moveIn('contacts', s.contacts[0].id); await P.moveIn('renewals', s.sites[0].hostingRenewalId);
        P.close('test');
      });
      await clients();
      for (const sel of ['#cl-list h2 .lockmark', '#cl-flags h2 .lockmark']) await page.waitForSelector(sel, T);
      await media('Podcasts', 'podcasts');
      if (!(await page.locator('.pc-show h3:has-text("Costs and revenue") .lockmark').count())) throw new Error('show costs and revenue have no lock marker');
      await media('Websites', 'websites'); await page.waitForSelector('#websites h1 + .lockmark, #websites .lockmark', T);
      await navTo(page, 'Review'); await page.waitForSelector('#rv-clients h2 .lockmark', T); await page.waitForSelector('#rv-media h2 .lockmark', T);
      await navTo(page, 'Overview'); await page.waitForSelector('#dash-glance', T);
      if (!(await page.locator('#dash-glance h2 .lockmark').count())) throw new Error('at a glance has no lock marker with a private contact');
      await layout('review with markers');
    });
  } catch { /* recorded in problems */ }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-MEDIA FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-MEDIA PASSED');
