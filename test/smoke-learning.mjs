// v0.8.0 Learning smoke: desktop and 390x844. Fails on console errors, CSP violations, horizontal scroll.
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
// Hand-computed expectations. The page clock is Saturday 2026-11-14; its week is 2026-11-09 to 2026-11-15 (ISO week 46 of 2026). Target 150 minutes a week.
// ITEMS: Rust course (course, 2 of 8 modules = 25%, 2026-11-01 to 2026-12-01: 13 of 30 days = 43.3% elapsed, 25 - 43.3 = -18.3 points: Behind).
//   Systems book (book, 60%, 2026-10-15 to 2026-12-15: 30 of 61 days = 49.2% elapsed, +10.8 points: Ahead).
//   Cloud cert (certification, started 11-10, exam 2026-12-05 = 21 days away, expires 2026-12-10 = 26 days away: Admin "within 30 days").
//   Old topic (skill, started 2026-10-01, never studied: 44 days, stalled).
// SESSIONS: last week 150 min (11-05, no item). This week: Rust 45 (11-10), Rust 60 (11-12), Systems book 30 (11-13) = 135 on 3 days; then 15 (11-14) = 150 on 4 days, 4 sessions.
//   Streak: last week met (150 >= 150), this week 135 does not break it (1); this week met at 150 (2).
// TAKEAWAYS: two; "o.e" matches nothing (a dot is a dot), "owner" matches one.
// GOALS (2026-11-01 to 2026-12-31, 13 of 60 days = 21.7% elapsed): linked item progress = Systems book 60% (Ahead); study minutes 150 of 300 = 50% (Ahead);
//   items finished 1 of 2 = 50% once Old topic is marked done.
// Rust course deleted: its 2 sessions and 1 takeaway are kept, 5 sessions in all, minutes still 150.

async function run(label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  async function step(name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
  const nav = (name) => page.click('.nav button:has-text("' + name + '")');
  const text = (sel) => page.textContent(sel).then((t) => t.trim());
  // Notices stay on screen between saves, so a check right after a click polls until the screen has re-rendered.
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
  const openLearning = async () => { await dash(); await page.click('.tile[data-domain="learning"]'); await page.waitForSelector('#ln-active', T); };
  const openAdmin = async () => { await dash(); await page.click('.tile[data-domain="admin"]'); await page.waitForSelector('#ad-timeline', T); };
  const openGoals = async () => { await dash(); await page.click('.tile[data-domain="goals"]'); await page.waitForSelector('#goal-ladder', T); };
  const stats = async (w, where) => { for (const [id, v] of Object.entries(w)) await expectText('#' + id, v); await layout(where); };
  const row = (t) => '.ln-item[data-title="' + t + '"]';
  async function addItem(f) {
    await openFold('ln-add');
    await page.fill('#ln-title', f.title); await page.selectOption('#ln-kind', f.kind);
    if (f.pct) await page.fill('#ln-pct', f.pct);
    if (f.total) { await page.fill('#ln-total', f.total); await page.fill('#ln-done-units', f.done); await page.fill('#ln-unit', f.unit); }
    await page.fill('#ln-start', f.start);
    if (f.target) await page.fill('#ln-tdate', f.target);
    if (f.exam) await page.fill('#ln-exam', f.exam);
    if (f.expires) await page.fill('#ln-expires', f.expires);
    await page.click('#ln-add-btn');
    await ok('Item added.');
    await page.waitForSelector(row(f.title), T);
  }
  async function saveDialog(msg) { await layout('dialog'); await page.click('.dialog button:has-text("Save")'); await ok(msg); await page.waitForSelector('.dialog', { state: 'detached', timeout: 30000 }); }
  async function logItem(title, date, mins) {
    await page.click(row(title) + ' .ln-logitem');
    await page.waitForSelector('.dialog #sd-date', T);
    await page.fill('#sd-date', date); await page.fill('#sd-min', mins);
    await saveDialog('Study time logged.');
  }
  async function quickLog(date, mins, chip) {
    await dash(); await page.click('#quick-study');
    await page.waitForSelector('.dialog #sd-date', T);
    await page.fill('#sd-date', date);
    if (chip) await page.click('#sd-chips .chipbtn:has-text("' + chip + '")'); else await page.fill('#sd-min', mins);
    await saveDialog('Study time logged.');
  }
  async function addGoal(f) {
    await openGoals();
    await openFold('goal-add');
    await page.fill('#g-title', f.title); await page.selectOption('#g-horizon', 'quarterly'); await page.selectOption('#g-metric', f.metric);
    await page.fill('#g-start', '0'); await page.fill('#g-target', f.target); await page.fill('#g-sdate', '2026-11-01'); await page.fill('#g-due', '2026-12-31');
    await page.click('#g-add');
    await ok('Goal added.');
    await page.waitForSelector('.goal[data-goal="' + f.title + '"]', T);
  }
  const goalIs = async (title, now, progress, pace) => {
    const g = '.goal[data-goal="' + title + '"]';
    await expectText(g + ' .g-now', now); await expectText(g + ' .g-progress', progress); await expectText(g + ' .g-status', pace);
  };
  const WEEK = { 'ln-minutes': '0 of 150', 'ln-sessions': '0', 'ln-days': '0', 'ln-streak': '0' };

  try {
    await page.clock.install({ time: new Date(2026, 10, 14, 10, 0, 0) });
    await page.goto(pathToFileURL(file).href);
    await step('create vault and empty Learning tile', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
      await page.click('button:has-text("Create vault")');
      await page.waitForSelector('.tile', T);
      await tile('learning', '0', '0 active items, no exam dated', 'empty');
    });
    await step('empty Learning view; set a weekly study target', async () => {
      await openLearning();
      await expectText('#ln-week', '2026-11-09 to 2026-11-15. No weekly target set.');
      await stats({ 'ln-minutes': '0', 'ln-sessions': '0', 'ln-days': '0', 'ln-streak': 'n/a' }, 'learning empty');
      await page.fill('#ln-target', '150'); await page.click('#ln-target-save'); await ok('Study target saved.');
      await stats(WEEK, 'learning target');
      await expectText('#ln-week', '2026-11-09 to 2026-11-15. 150 minutes to the target.');
      if (!(await text('#ln-target-card h2')).includes('Week 46 of 2026')) throw new Error('week number: ' + await text('#ln-target-card h2'));
    });
    await step('add a course with units, a book with percent, a certification and an old skill', async () => {
      await addItem({ title: 'Rust course', kind: 'course', total: '8', done: '2', unit: 'modules', start: '2026-11-01', target: '2026-12-01' });
      await addItem({ title: 'Systems book', kind: 'book', pct: '60', start: '2026-10-15', target: '2026-12-15' });
      await page.selectOption('#ln-kind', 'certification');
      await addItem({ title: 'Cloud cert', kind: 'certification', start: '2026-11-10', exam: '2026-12-05', expires: '2026-12-10' });
      await addItem({ title: 'Old topic', kind: 'skill', start: '2026-10-01' });
      await expectText(row('Rust course') + ' .ln-progress', '25% (2 of 8 modules)'); await expectText(row('Rust course') + ' .ln-pace', 'Behind');
      await expectText(row('Systems book') + ' .ln-progress', '60%'); await expectText(row('Systems book') + ' .ln-pace', 'Ahead');
      await expectText(row('Cloud cert') + ' .ln-progress', 'no progress set'); await expectCount(row('Cloud cert') + ' .ln-pace', 0);
      if (!(await text(row('Cloud cert'))).includes('exam 2026-12-05 (in 21 days)')) throw new Error('exam countdown: ' + await text(row('Cloud cert')));
      await expectText('#ln-exams h2', 'Upcoming exams (1)');
      await layout('learning items');
    });
    await step('log sessions: last week, then this week, with the streak and week numbers', async () => {
      await quickLog('2026-11-05', '150');
      await openLearning(); await stats({ 'ln-minutes': '0 of 150', 'ln-sessions': '0', 'ln-days': '0', 'ln-streak': '1' }, 'last week met');
      await logItem('Rust course', '2026-11-10', '45');
      await logItem('Rust course', '2026-11-12', '60');
      await page.click(row('Systems book') + ' .ln-logitem'); await page.waitForSelector('.dialog #sd-date', T);
      await page.fill('#sd-date', '2026-11-13'); await page.click('#sd-chips .chipbtn:has-text("30")');
      if ((await page.inputValue('#sd-min')) !== '30') throw new Error('chip did not fill minutes');
      await saveDialog('Study time logged.');
      await stats({ 'ln-minutes': '135 of 150', 'ln-sessions': '3', 'ln-days': '3', 'ln-streak': '1' }, 'learning 135');
      await expectText('#ln-week', '2026-11-09 to 2026-11-15. 15 minutes to the target.');
      await quickLog('2026-11-14', '', '15');
      await openLearning();
      await stats({ 'ln-minutes': '150 of 150', 'ln-sessions': '4', 'ln-days': '4', 'ln-streak': '2' }, 'learning 150');
      await expectText('#ln-week', '2026-11-09 to 2026-11-15. Target met.');
      await tile('learning', '150 of 150', '4 active items, next exam 2026-12-05', 'after sessions');
    });
    await step('takeaways: add two and search by plain substring', async () => {
      await openLearning(); await openFold('ln-tk');
      await page.selectOption('#ln-tk-item', { label: 'Rust course' }); await page.fill('#ln-tk-text', 'Ownership means one owner at a time'); await page.click('#ln-tk-add'); await ok('Takeaway added.');
      await openFold('ln-tk');
      await page.fill('#ln-tk-text', 'Borrowing is a reference not a copy'); await page.click('#ln-tk-add'); await ok('Takeaway added.');
      await openFold('ln-tk');
      await expectCount('.ln-tk', 2);
      await page.fill('#ln-search', 'owner'); await expectCount('.ln-tk', 1);
      if (!(await text('.ln-tk')).includes('Ownership means one owner at a time')) throw new Error('search result: ' + await text('.ln-tk'));
      await page.fill('#ln-search', 'o.e'); await expectCount('.ln-tk', 0); await expectText('#ln-no-results', 'No takeaways match.');
      await page.fill('#ln-search', '('); await expectCount('.ln-tk', 0);
      await page.fill('#ln-search', 'BORROWING'); await expectCount('.ln-tk', 1);
      await page.fill('#ln-search', ''); await expectCount('.ln-tk', 2);
      await layout('takeaways');
    });
    await step('Admin timeline shows the certification expiry with no renewal stored', async () => {
      await tile('admin', '1', '0 overdue', 'with a certification');
      await openAdmin();
      await expectText('#ad-tl-30 h3', 'Within 30 days (1)');
      const r = await text('#ad-tl-30 .tl-row[data-title="Cloud cert"]');
      if (!r.includes('2026-12-10') || !r.includes('certification expires')) throw new Error('timeline row: ' + r);
      await openFold('ad-renewals'); await expectCount('.rn-row', 0);
      await layout('admin timeline');
    });
    await step('link an item to a goal; goal progress matches the hand-computed values', async () => {
      await openGoals(); await openFold('goal-add');
      await addGoal({ title: 'Finish the book', metric: 'itemProgress', target: '100' });
      await expectText('.goal[data-goal="Finish the book"] .g-progress', 'No data yet');
      await openLearning();
      await page.click(row('Systems book') + ' button:has-text("Edit")'); await page.waitForSelector('.dialog #ei-goal', T);
      await page.selectOption('#ei-goal', { label: 'Finish the book' });
      await saveDialog('Item saved.');
      await addGoal({ title: 'Study 300 a week', metric: 'studyMinutes', target: '300' });
      await goalIs('Finish the book', 'Start 0%, now 60%, target 100%. 2026-11-01 to 2026-12-31.', '60%', 'Ahead');
      await goalIs('Study 300 a week', 'Start 0, now 150, target 300. 2026-11-01 to 2026-12-31.', '50%', 'Ahead');
      await layout('goals');
    });
    await step('weekly review Learning step lists numbers and offers actions without taking them', async () => {
      await nav('Review'); await page.waitForSelector('#rv-learning', T);
      await expectText('#rv-ln-minutes', 'Study minutes: 150 of 150. 4 sessions on 4 days.');
      await expectCount('.rv-ln-moved', 2);
      await expectText('#rv-ln-stalled-h', 'No session in 14 days (1)'); await expectCount('.rv-ln-stalled', 1);
      await expectText('#rv-ln-exams-h', 'Exams in the next 28 days (1)');
      if (!(await text('.rv-ln-stalled')).includes('Old topic')) throw new Error('stalled: ' + await text('.rv-ln-stalled'));
      await layout('review learning');
      await openLearning();
      if ((await page.getAttribute(row('Old topic'), 'data-state')) !== 'active') throw new Error('the review changed an item by itself');
      await expectText('#ln-stalled', '1 active item has no session in 14 days.');
      await nav('Review'); await page.waitForSelector('#rv-learning', T);
      await page.click('.rv-ln-stalled .rv-ln-pause'); await page.waitForSelector('.rv-ln-stalled', { state: 'detached', timeout: 30000 });
      await tile('learning', '150 of 150', '3 active items, next exam 2026-12-05', 'after pause');
    });
    await step('mark a paused item done; items finished goal', async () => {
      await openLearning(); await openFold('ln-other');
      await page.click(row('Old topic') + ' .ln-done'); await ok('Marked done.');
      await page.waitForSelector('#ln-finished .ln-fin[data-title="Old topic"]', T);
      await addGoal({ title: 'Finish 2 items', metric: 'learningFinished', target: '2' });
      await goalIs('Finish 2 items', 'Start 0, now 1, target 2. 2026-11-01 to 2026-12-31.', '50%', 'Ahead');
    });
    await step('delete an item: its sessions and takeaway are kept', async () => {
      await openLearning();
      await page.click(row('Rust course') + ' .ln-delete'); await page.waitForSelector('#ln-del-count', T);
      await expectText('#ln-del-count', '2 study sessions and 1 takeaway are kept and unlinked.');
      await layout('delete dialog');
      await page.click('.dialog button:has-text("Delete")'); await ok('Item deleted.');
      await expectCount(row('Rust course'), 0);
      await stats({ 'ln-minutes': '150 of 150', 'ln-sessions': '4', 'ln-days': '4', 'ln-streak': '2' }, 'after delete');
      await expectText('#ln-sessions-card > summary', 'Recent sessions (5)');
      await openFold('ln-sessions-card'); await expectCount('.ln-sess', 5);
      await openFold('ln-tk'); await page.fill('#ln-search', 'owner'); await expectCount('.ln-tk', 1);
      await tile('learning', '150 of 150', '2 active items, next exam 2026-12-05', 'after delete');
    });
    const final = async (where) => {
      await tile('learning', '150 of 150', '2 active items, next exam 2026-12-05', where);
      await openLearning();
      await stats({ 'ln-minutes': '150 of 150', 'ln-sessions': '4', 'ln-days': '4', 'ln-streak': '2' }, where);
      await expectCount('#ln-active .ln-item', 2); await expectCount(row('Systems book'), 1); await expectCount(row('Cloud cert'), 1);
      await expectText(row('Systems book') + ' .ln-progress', '60%');
      await expectText('#ln-sessions-card > summary', 'Recent sessions (5)');
      await openFold('ln-tk'); await expectCount('.ln-tk', 2);
      await openAdmin(); await expectText('#ad-tl-30 h3', 'Within 30 days (1)');
      await openGoals();
      await goalIs('Finish the book', 'Start 0%, now 60%, target 100%. 2026-11-01 to 2026-12-31.', '60%', 'Ahead');
    };
    await step('lock and unlock', async () => {
      await page.click('.top .lockbtn');
      await page.waitForSelector('#pass', T);
      if (await page.locator('.tile').count()) throw new Error('data visible while locked');
      const body = await page.textContent('body');
      for (const secret of ['Rust course', 'Systems book', 'Cloud cert', 'Ownership means']) if (body.includes(secret)) throw new Error('locked page shows ' + secret);
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
    await step('settings: version, study target, and no learning text', async () => {
      await nav('Settings');
      await page.waitForSelector('#app-version', T);
      await expectText('#app-version', 'LifeOS v0.10.0');
      if ((await page.inputValue('#t-study')) !== '150') throw new Error('study target in settings');
      const t = await text('main');
      for (const secret of ['Rust course', 'Systems book', 'Cloud cert', 'Old topic', 'Ownership means', 'Borrowing is']) if (t.includes(secret)) throw new Error('settings page shows ' + secret);
      await layout('settings');
    });
    await step('a card number in notes is refused', async () => {
      await openLearning(); await openFold('ln-add');
      await page.fill('#ln-title', 'Card test'); await page.fill('#ln-notes', 'paid with 4111 1111 1111 1111'); await page.click('#ln-add-btn');
      await page.waitForSelector('.notice.err:has-text("ID number")', T);
      await expectCount(row('Card test'), 0);
    });
    // Audit (SEC-49): the session note field holds 200 characters at most.
    await step('session note is capped at 200 characters', async () => {
      await dash(); await page.click('#quick-study');
      await page.waitForSelector('.dialog #sd-note', T);
      if ((await page.getAttribute('#sd-note', 'maxlength')) !== '200') throw new Error('session note maxlength');
      await page.click('.dialog button:has-text("Cancel")');
      await page.waitForSelector('.dialog', { state: 'detached', timeout: 30000 });
    });
    // Audit: an older learning entry the upgrade could not convert stays visible under Learning and can be deleted after a confirm.
    await step('kept older learning entry is visible and deletable', async () => {
      await page.evaluate(() => globalThis.LifeOS.store.commit((x) => { x.entries.push(globalThis.LifeOS.metrics.validateEntry({ domain: 'learning', type: 'hours', date: '2026-11-10', title: 'Kept fractional hours', value: 1.333 })); }));
      await openLearning(); await openFold('ln-legacy');
      await expectCount('#ln-legacy .g-legacy', 1);
      if (!(await text('#ln-legacy')).includes('Kept fractional hours')) throw new Error('kept entry text');
      await page.click('#ln-legacy .leg-del'); await page.click('.dialog button:has-text("Delete")');
      await expectCount('#ln-legacy', 0);
      await layout('learning after legacy delete');
    });
  } catch { /* recorded in problems */ }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-LEARNING FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-LEARNING PASSED');
