// v0.11.0 part B smoke: Wellbeing inside the private vault, and the three part A gaps. Desktop and 390x844. Fails on console errors,
// CSP violations and horizontal scroll. Sets up the vault from the Wellbeing view, moves earlier mood entries in, does a quick check-in and
// a one-section update the same day, checks averages and the streak against hand-computed values, waits out the private timer, moves
// records in and out from their edit dialogs, checks the "New items are private" toggle, locks and unlocks the app, reloads and checks
// persistence. Run `node build.mjs` first. Needs Playwright and Chrome at /usr/bin/google-chrome.
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
const PRIV = 'private vault passphrase one';
const T = { timeout: 30000 };
const problems = [];

// Today is 14 Nov 2026 (the page clock). Sleep 7 h today and 8 h yesterday; one contact today and one 10 days ago; one done social
// activity today; two earlier mood entries from September; an account and a project to move in later.
const SEED = `(async () => {
  const L = globalThis.LifeOS, E = (o) => L.metrics.validateEntry(o);
  await L.store.commit((s) => {
    s.entries.push(E({ id: 'sl1', domain: 'health', type: 'sleep', date: '2026-11-14', title: 'Sleep', value: 7 }), E({ id: 'sl2', domain: 'health', type: 'sleep', date: '2026-11-13', title: 'Sleep', value: 8 }),
      E({ id: 'md1', domain: 'wellbeing', type: 'mood', date: '2026-09-01', title: 'Early log', value: 4, notes: 'first' }), E({ id: 'md2', domain: 'wellbeing', type: 'mood', date: '2026-09-02', title: 'Next log', value: 2 }));
    s.people.push({ id: 'pp', name: 'Sam Friend', cadenceDays: 30, importantDates: [], pipelineIds: [], projectIds: [], facts: [], notes: '', archived: false, createdAt: '2026-08-01T00:00:00.000Z' });
    s.contacts.push({ id: 'ct1', personId: 'pp', date: '2026-11-14', channel: 'call', notes: '' }, { id: 'ct2', personId: 'pp', date: '2026-11-04', channel: 'call', notes: '' });
    s.activities.push({ id: 'ac1', title: 'Park walk', category: 'outing', state: 'done', date: '2026-11-14', place: '', withPeople: [], alsoHealth: false, alsoSocial: true, notes: '' });
    s.accounts.push({ id: 'acc-sav', name: 'Savings', kind: 'cash', liability: false, archived: false });
    s.projects.push({ id: 'pj1', name: 'Alpha', kind: 'venture', status: 'active', nextAction: '', archived: false });
  });
})()`;

async function run(label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  page.on('request', (r) => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) requests.push(r.url()); });
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
  const nav = (name) => page.click('.nav button:has-text("' + name + '")');
  const text = (sel) => page.textContent(sel).then((t) => t.trim());
  const poll = async (get, good, what, tries = 80) => {
    let got;
    for (let i = 0; i < tries; i++) { try { got = await get(); if (good(got)) return got; } catch (e) { got = String(e.message).split('\n')[0]; } await page.waitForTimeout(100); }
    throw new Error(what + ' is ' + JSON.stringify(got));
  };
  const expectText = (sel, want) => poll(() => text(sel), (g) => g === want, sel + ' (expected ' + JSON.stringify(want) + ')');
  const layout = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
  };
  const pageStuff = () => page.evaluate(() => {
    let t = '';
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const n = w.currentNode; if (n.parentElement && !['SCRIPT', 'STYLE'].includes(n.parentElement.tagName)) t += n.nodeValue + '\n'; }
    for (const el of document.querySelectorAll('body *')) { if (['SCRIPT', 'STYLE'].includes(el.tagName)) continue; for (const a of el.attributes) t += a.value + '\n'; if ('value' in el && typeof el.value === 'string') t += el.value + '\n'; }
    return t;
  });
  const dash = async () => { await nav('Home'); await page.waitForSelector('.tile', T); };
  const wellbeing = async () => { await dash(); await page.click('.tile[data-domain="wellbeing"]'); await page.waitForSelector('h1:has-text("Wellbeing")', T); };
  const openVaultHere = async () => { await page.fill('#priv-pass', PRIV); await page.click('#priv-open'); await page.waitForSelector('#priv-bar', T); };
  // The check-in panel asks which kind of update every time; one check-in is made for `date`.
  const checkin = async (date, mode, ratings, note) => {
    await page.click('#wb-open-ck');
    await page.waitForSelector('#wb-quick', T); await page.waitForSelector('#wb-section', T);
    if (date) { await page.fill('#wb-date', date); await page.waitForSelector('#wb-quick', T); }
    if (mode === 'quick') await page.click('#wb-quick'); else { await page.click('#wb-section'); await page.waitForSelector('#wb-area', T); }
    for (const [area, v] of Object.entries(ratings)) {
      if (mode !== 'quick') await page.selectOption('#wb-area', area);
      await page.click('.rate[data-area="' + area + '"][data-v="' + v + '"]');
    }
    if (mode === 'quick' && (await page.locator('.ratingrow').count()) !== 5) throw new Error('quick update does not show five ratings on one screen');
    if (mode !== 'quick' && (await page.locator('.ratingrow').count()) !== 1) throw new Error('one section shows more than its own area');
    if (note) await page.fill('#wb-note', note);
    await page.click('#wb-save');
    await page.waitForSelector('.notice.ok:has-text("Check-in saved.")', T);
    await page.waitForSelector('#wb-open-ck', T);
  };
  try {
    await page.clock.install({ time: new Date(2026, 10, 14, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('create the app vault and seed data', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")');
      await page.waitForSelector('.tile', T);
      await page.evaluate(SEED);
      await nav('Settings'); await dash();
      await expectText('.tile[data-domain="wellbeing"] .tile-value', 'Locked');
      await page.waitForSelector('.tile[data-domain="wellbeing"] [aria-label="Locked"]', T);
      await layout('dashboard');
    });
    await step('set up the private vault from the Wellbeing view', async () => {
      await wellbeing();
      await page.waitForSelector('#priv-setup', T);
      if (await page.locator('.rate').count()) throw new Error('ratings shown before any vault exists');
      await page.fill('#priv-set1', PRIV); await page.fill('#priv-set2', PRIV); await page.click('#priv-setup-btn');
      await page.waitForSelector('#priv-bar', T);
      await page.waitForSelector('#wb-ck', T);
      await layout('wellbeing open');
    });
    await step('earlier mood entries move in once, as check-ins', async () => {
      await page.waitForSelector('#wb-old', T);
      if (!(await text('#wb-old')).includes('2 earlier mood entries')) throw new Error('offer text: ' + (await text('#wb-old')));
      await page.click('#wb-old-move'); await page.waitForSelector('.dialog', T);
      await page.click('.dialog button:has-text("Move in")');
      await page.waitForSelector('.notice.ok:has-text("moved in as check-ins")', T);
      await page.waitForSelector('#wb-old', { state: 'detached', ...T });
      await page.waitForSelector('#wb-recent .wb-row[data-date="2026-09-01"]', T);
      await page.waitForSelector('#wb-recent .wb-row[data-date="2026-09-02"]', T);
      const left = await page.evaluate(() => globalThis.LifeOS.store.getState().entries.filter((e) => e.domain === 'wellbeing').length);
      if (left !== 0) throw new Error('thin entries still in the main state: ' + left);
      await wellbeing();
      if (await page.locator('#wb-old').count()) throw new Error('the offer came back');
    });
    await step('quick update, then a one-section update the same day merges into one check-in', async () => {
      await checkin(null, 'quick', { mood: 4, mental: 3, recovery: 5 }, 'walked');
      await checkin(null, 'section', { connected: 2 }, '');
      const rows = await page.locator('#wb-recent .wb-row[data-date="2026-11-14"]').count();
      if (rows !== 1) throw new Error('expected one check-in for today, found ' + rows);
      const row = await text('#wb-recent .wb-row[data-date="2026-11-14"]');
      for (const w of ['Mood 4', 'Mental state 3', 'Rest and recovery 5', 'Social engagement 2', 'walked']) if (!row.includes(w)) throw new Error('merged row misses ' + w + ': ' + row);
      if (row.includes('Intimacy')) throw new Error('a skipped section was filled in: ' + row);
      // the section update kept the note of the quick one (the note box was prefilled)
      await layout('after check-ins');
    });
    await step('past dates can be edited; averages, previous 7 days and streak match hand-computed values', async () => {
      await checkin('2026-11-13', 'quick', { mood: 2 }, '');
      await checkin('2026-11-12', 'quick', { mood: 5 }, '');
      await checkin('2026-11-08', 'quick', { mood: 2 }, '');
      await checkin('2026-11-07', 'quick', { mood: 3 }, '');
      // an edit of an earlier day: change the 13th from 2 to 2 via its Edit button (opens the same chooser)
      await page.click('#wb-recent .wb-row[data-date="2026-11-13"] .wb-edit');
      await page.waitForSelector('#wb-quick', T); await page.waitForSelector('#wb-section', T);
      if ((await page.inputValue('#wb-date')) !== '2026-11-13') throw new Error('edit did not open the chosen date');
      await page.click('#wb-ck-cancel');
      // mood by day: 14:4 13:2 12:5 8:2 7:3. 7 days = 8th to 14th = (4+2+5+2)/4 = 3.25; 30 days = 5 check-ins = 16/5 = 3.2; days 1st to 7th = 3
      await expectText('#wb-avg7-mood', '3.3 (4)');
      await expectText('#wb-avg30-mood', '3.2 (5)');
      await expectText('#wb-prev7-mood', '3 (1)');
      await expectText('#wb-today-mood', '4');
      await expectText('#wb-avg7-mental', '3 (1)'); await expectText('#wb-avg7-recovery', '5 (1)'); await expectText('#wb-avg7-connected', '2 (1)'); await expectText('#wb-avg7-intimacy', '-');
      await expectText('#wb-streak', '3 days'); await expectText('#wb-week', '4');
      if ((await page.locator('svg[id^="wb-trend-"]').count()) !== 5) throw new Error('one trend line per area expected');
      await dash();
      await expectText('.tile[data-domain="wellbeing"] .tile-value', '3.3');
      if (!(await text('.tile[data-domain="wellbeing"]')).includes('Streak: 3 days')) throw new Error('tile misses the streak: ' + (await text('.tile[data-domain="wellbeing"]')));
      await layout('dashboard open');
    });
    await step('sleep, contacts and social activities are read live, next to the ratings', async () => {
      await wellbeing();
      const sl = await text('#wb-sleep');
      if (!sl.includes('last night 7 h') || !sl.includes('7-day average 7.5 h') || !sl.includes('(2 nights)')) throw new Error('sleep line: ' + sl);
      const so = await text('#wb-social');
      if (!so.includes('today 1, last 7 days 1, last 30 days 2.') || !so.includes('Social-tagged activities, from Activities, read live: today 1, last 7 days 1, last 30 days 1.')) throw new Error('social line: ' + so);
      // nothing copied: the vault holds ratings and notes only
      const stored = await page.evaluate(() => JSON.stringify(globalThis.LifeOS.priv.getWellbeing()));
      if (/sleep|hours|contact/i.test(stored)) throw new Error('copied data in the vault: ' + stored);
      // numbers and dates only: no labels, thresholds, flags or advice
      const body = (await text('main')).replace(/walked/g, '');
      const bad = body.match(/\b(good|great|bad|poor|low|high|healthy|normal|concern|should|try|improve|improving|better|worse|decline|alert|warning|recommend)\b/i);
      if (bad) throw new Error('interpretive word on the Wellbeing screen: ' + bad[0]);
      if (/—/.test(body)) throw new Error('em dash in copy');
      await layout('wellbeing screen');
    });
    await step('review shows a Wellbeing step only while open and stores nothing from it', async () => {
      await nav('Review'); await page.waitForSelector('#rv-wellbeing', T);
      if (!(await text('#rv-wellbeing')).includes('Check-in streak: 3.')) throw new Error('review step: ' + (await text('#rv-wellbeing')));
      await page.fill('#prio1', 'one'); await page.fill('#prio2', 'two'); await page.fill('#prio3', 'three'); await page.click('#finish-review');
      await page.waitForSelector('.notice.ok:has-text("Review finished.")', T);
      const stored = await page.evaluate(() => JSON.stringify(globalThis.LifeOS.store.getState().memory) + JSON.stringify(globalThis.LifeOS.store.getState().audit));
      if (/walked|checkins|Mood 4|recovery/i.test(stored)) throw new Error('wellbeing reached the review record or audit: ' + stored.slice(0, 200));
    });
    await step('goals: a wellbeing metric needs a private goal', async () => {
      await nav('Home'); await page.waitForSelector('.tile', T);
      await page.click('.tile[data-domain="goals"]'); await page.waitForSelector('#goal-form', T);
      if (!(await page.locator('#g-metric option[value="wbMood"]').count())) throw new Error('wellbeing metric not offered while open');
      await page.fill('#g-title', 'Mood goal'); await page.selectOption('#g-metric', 'wbMood'); await page.fill('#g-target', '4');
      await page.click('#g-add');
      await page.waitForSelector('.notice.err:has-text("private goal")', T);
      await page.check('#priv-new');
      await page.waitForSelector('#goal-form .privnew-note', T);
      await page.fill('#g-title', 'Mood goal'); await page.selectOption('#g-metric', 'wbMood'); await page.fill('#g-target', '4');
      await page.click('#g-add');
      await page.waitForSelector('.notice.ok:has-text("Goal added.")', T);
      await page.waitForSelector('.goal[data-goal="Mood goal"] .privbadge', T);
      const inMain = await page.evaluate(() => globalThis.LifeOS.store.getState().goals.length);
      if (inMain !== 0) throw new Error('the private goal is in the main state');
      await page.uncheck('#priv-new');
    });
    await step('the private timer closes the vault; the tile says Locked and the page holds no wellbeing number or note', async () => {
      await page.click('#nav-private'); await page.waitForSelector('#priv-secs', T);
      await page.fill('#priv-secs', '15'); await page.click('#priv-secs-save');
      await page.waitForSelector('.notice:has-text("Saved.")', T);
      await wellbeing();
      await page.waitForSelector('#priv-bar', { state: 'detached', timeout: 40000 });
      await page.waitForSelector('#wb-locked', T);
      const main = await text('main');
      if (/\d/.test(main)) throw new Error('digits on the locked Wellbeing screen: ' + main);
      if (await page.locator('.wb-area, #wb-ck, .rate, #wb-recent').count()) throw new Error('wellbeing content in the page while closed');
      await dash();
      const tile = await text('.tile[data-domain="wellbeing"]');
      if (/\d/.test(tile) || !tile.includes('Locked')) throw new Error('tile while closed: ' + tile);
      await page.waitForSelector('.tile[data-domain="wellbeing"] [aria-label="Locked"]', T);
      const stuff = await pageStuff();
      for (const s of ['walked', 'Mood 4', 'Streak', 'Mood goal', 'Early log']) if (stuff.includes(s)) throw new Error('closed page holds ' + s + ': ' + stuff.slice(Math.max(0, stuff.indexOf(s) - 60), stuff.indexOf(s) + 40).replace(/\n/g, ' ~ '));
      await page.click('.tile[data-domain="goals"]'); await page.waitForSelector('#goal-form', T);
      if ((await page.locator('#g-metric option[value="wbMood"]').count()) || (await page.locator('.goal[data-goal="Mood goal"]').count())) throw new Error('private goal or its metric visible while closed');
      await nav('Review'); await page.waitForSelector('h1:has-text("Weekly review")', T);
      if (await page.locator('#rv-wellbeing').count()) throw new Error('review step shown while closed');
      await layout('closed');
    });
    await step('gap 3 and 2: move a record in and out from its edit dialog; private rows show a lock badge while open', async () => {
      await wellbeing();
      await openVaultHere();
      await nav('Assets'); await page.waitForSelector('.acct[data-account="Savings"]', T);
      if (await page.locator('.acct[data-account="Savings"] .privbadge').count()) throw new Error('badge on a public row');
      await page.click('.acct[data-account="Savings"] button:has-text("Rename")');
      await page.waitForSelector('.dialog .priv-move-btn:has-text("Move to private vault")', T);
      await page.click('.dialog .priv-move-btn');
      await page.waitForSelector('.dialog button:has-text("Move in")', T);
      await page.click('.dialog button:has-text("Move in")');
      await page.waitForSelector('.notice.ok:has-text("Moved to the private vault.")', T);
      await page.waitForSelector('.acct[data-account="Savings"] .privbadge', T);
      // a record without an edit form gets an Options dialog holding the same action
      await nav('Work'); await page.waitForSelector('.proj[data-project="Alpha"]', T);
      await page.click('.proj[data-project="Alpha"] .priv-opt');
      await page.waitForSelector('.dialog .priv-move-btn:has-text("Move to private vault")', T);
      await page.click('.dialog .priv-move-btn'); await page.click('.dialog button:has-text("Move in")');
      await page.waitForSelector('.notice.ok:has-text("Moved to the private vault.")', T);
      await page.waitForSelector('.proj[data-project="Alpha"] .privbadge', T);
      const inMain = await page.evaluate(() => { const s = globalThis.LifeOS.store.getState(); return s.accounts.length + s.projects.length; });
      if (inMain !== 0) throw new Error('moved records are still in the main state');
      await layout('work open');
      // close: gone; reopen and move the account out with a confirm tap
      await page.click('#priv-close'); await page.waitForSelector('#priv-bar', { state: 'detached', ...T });
      await nav('Assets');
      if (await page.locator('.acct[data-account="Savings"]').count()) throw new Error('private account visible while closed');
      await page.click('#nav-private'); await openVaultHere();
      await nav('Assets'); await page.click('.acct[data-account="Savings"] button:has-text("Rename")');
      await page.waitForSelector('.dialog .priv-move-btn:has-text("Move out")', T);
      await page.click('.dialog .priv-move-btn');
      await page.waitForSelector('.dialog button:has-text("Move out")', T);
      await page.click('.dialog button:has-text("Move out")');
      await page.waitForSelector('.notice.ok:has-text("Moved out of the private vault.")', T);
      if (await page.locator('.acct[data-account="Savings"] .privbadge').count()) throw new Error('badge after moving out');
      const back = await page.evaluate(() => globalThis.LifeOS.store.getState().accounts.map((a) => a.name));
      if (back.join() !== 'Savings') throw new Error('account not back in the main state: ' + back);
    });
    await step('gap 1: "New items are private" shows on add forms, applies while open, resets when the vault closes and never applies closed', async () => {
      await nav('Assets'); await page.waitForSelector('#ac-add', T);
      if (await page.locator('.privnew-note').count()) throw new Error('note shown while the toggle is off');
      await page.check('#priv-new');
      await page.waitForSelector('form:has(#ac-add) .privnew-note', T);
      // SEC-69: the training cycle form creates a record too
      await nav('Health'); await page.waitForSelector('form:has(#cy-save) .privnew-note', { state: 'attached', ...T });
      await nav('Assets'); await page.waitForSelector('#ac-add', T);
      await page.fill('#ac-name', 'Newpriv Brokerage').catch(() => {});
      await page.click('#ac-add');
      await page.waitForSelector('.notice.ok', T);
      await page.waitForSelector('.acct[data-account="Newpriv Brokerage"] .privbadge', T);
      const pub = await page.evaluate(() => globalThis.LifeOS.store.getState().accounts.map((a) => a.name).join());
      if (pub.includes('Newpriv')) throw new Error('a new item went to the main state with the toggle on');
      // closing the vault switches it off
      await page.click('#priv-close'); await page.waitForSelector('#priv-bar', { state: 'detached', ...T });
      await page.click('#nav-private'); await openVaultHere();
      if (await page.isChecked('#priv-new')) throw new Error('toggle still on after the vault closed');
      await nav('Assets');
      if (await page.locator('.privnew-note').count()) throw new Error('note shown after reset');
      await page.check('#priv-new');
      await page.click('#priv-close'); await page.waitForSelector('#priv-bar', { state: 'detached', ...T });
      await nav('Assets'); await page.waitForSelector('#ac-add', T);
      if (await page.locator('.privnew-note').count()) throw new Error('note shown while the vault is closed');
      await page.fill('#ac-name', 'Closed Account'); await page.click('#ac-add');
      await page.waitForSelector('.notice.ok', T);
      const pub2 = await page.evaluate(() => globalThis.LifeOS.store.getState().accounts.map((a) => a.name).join());
      if (!pub2.includes('Closed Account')) throw new Error('with the vault closed the new item must be public: ' + pub2);
      await page.click('#nav-private'); await openVaultHere();
      if (await page.isChecked('#priv-new')) throw new Error('toggle came back on');
      await nav('Assets'); await page.waitForSelector('.acct[data-account="Closed Account"]', T);
      if (await page.locator('.acct[data-account="Closed Account"] .privbadge').count()) throw new Error('an item made while closed is private');
      await layout('assets');
    });
    await step('lock and unlock the app, reload: the vault is closed after unlock and the wellbeing data persists', async () => {
      await page.click('.top .lockbtn'); await page.waitForSelector('#pass', T);
      const locked = await pageStuff();
      for (const s of ['walked', 'Mood 4', 'Newpriv', 'Sam Friend']) if (locked.includes(s)) throw new Error('locked page holds ' + s);
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
      if (await page.locator('#priv-bar').count()) throw new Error('vault open after unlock');
      await expectText('.tile[data-domain="wellbeing"] .tile-value', 'Locked');
      await page.reload(); await page.waitForSelector('#pass', T);
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
      await wellbeing(); await page.waitForSelector('#wb-locked', T);
      await openVaultHere();
      await page.waitForSelector('#wb-recent', T);
      await expectText('#wb-avg7-mood', '3.3 (4)'); await expectText('#wb-streak', '3 days');
      const row = await text('#wb-recent .wb-row[data-date="2026-11-14"]');
      if (!row.includes('Social engagement 2') || !row.includes('walked')) throw new Error('merged check-in lost after reload: ' + row);
      await dash();
      await expectText('.tile[data-domain="wellbeing"] .tile-value', '3.3');
      await layout('reloaded');
    });
    if (requests.length) throw new Error('network requests: ' + requests.join(', '));
  } catch { /* recorded in problems */ }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-WELLBEING FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-WELLBEING PASSED');
