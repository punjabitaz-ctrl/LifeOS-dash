// v1.5.0 smoke: "Weekly loop". Desktop and 390x844. The review due card (not at 6 days, shown at 7), a review run from the card, three insights of one
// kind rejected with the required reason category until the kind is muted, the Memory list and unmute, an AI reply with a target change (an
// out-of-range value is refused; a valid one shows before and after and applies only on its tap), Test connection against a mocked provider (fixed
// prompt, coded error, success), the calendar file in both label modes (generic and real titles; structure, escaping, folding, stable UIDs), and
// lock and unlock with the due notice. Fails on console errors, CSP violations and horizontal scroll. Run `node build.mjs` first.
// Needs Playwright (`npm i --no-save playwright`) and Chrome at /usr/bin/google-chrome.
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
  try { browser = await pw[process.env.LIFEOS_SMOKE_BROWSER || 'chromium'].launch(o); break; } catch { /* try next */ }
}
if (!browser) { console.log('SKIPPED: ' + (process.env.LIFEOS_SMOKE_BROWSER || 'chromium') + ' unavailable (not installed); this is not a pass'); process.exit(0); }

const PASS = 'correct horse battery staple';
const MARK = 'LOOPMARK';
const KEY = 'sk-ant-LOOPKEY1234';
const T = { timeout: 15000 };
const problems = [];

// A small iCalendar reader: unfold, check line endings and widths, split into events. Throws on anything malformed.
function readIcs(text) {
  const bad = (m) => { throw new Error('calendar file: ' + m); };
  if (!text.endsWith('\r\n')) bad('does not end with CRLF');
  if (/[^\r]\n/.test(text) || /\r(?!\n)/.test(text)) bad('a line break is not CRLF');
  const phys = text.slice(0, -2).split('\r\n');
  for (const l of phys) if (Buffer.byteLength(l, 'utf8') > 75) bad('a physical line is over 75 octets');
  const lines = [];
  for (const l of phys) { if (l[0] === ' ') { if (!lines.length) bad('fold with no line'); lines[lines.length - 1] += l.slice(1); } else lines.push(l); }
  if (lines[0] !== 'BEGIN:VCALENDAR' || lines[1] !== 'VERSION:2.0' || lines[lines.length - 1] !== 'END:VCALENDAR') bad('header or footer');
  const events = []; let cur = null;
  for (const l of lines.slice(1, -1)) {
    if (l === 'BEGIN:VEVENT') { if (cur) bad('nested event'); cur = {}; continue; }
    if (l === 'END:VEVENT') { if (!cur) bad('stray END:VEVENT'); events.push(cur); cur = null; continue; }
    const m = /^([A-Z][A-Z0-9-]*)((?:;[A-Z]+=[A-Z]+)*):(.*)$/.exec(l);
    if (!m) bad('bad line ' + l.slice(0, 40));
    if (cur) { if (m[1] in cur) bad('repeated ' + m[1]); cur[m[1]] = m[3]; }
  }
  if (cur) bad('unclosed event');
  return events;
}
const unesc = (v) => v.replace(/\\([\\;,nN])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));

async function run(label, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true, acceptDownloads: true } : { viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  page.on('request', (r) => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) requests.push(r.url()); });
  async function step(name, fn) { if (process.env.SMOKE_VERBOSE) console.log(label, 'step:', name); try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); throw e; } }
  const nav = (name) => navTo(page, name);
  const noHScroll = async (where) => {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (r.sw > r.iw) throw new Error(where + ': page scrolls horizontally (' + r.sw + ' > ' + r.iw + ')');
  };
  const state = (fn, arg) => page.evaluate(fn, arg);
  const home = async () => { await nav('Overview'); await page.waitForSelector('.tile', T); };
  const rejectWith = async (cardText, code, typed) => {
    const card = '.card[data-insight]:has-text("' + cardText + '")';
    await page.click(card + ' button:has-text("Reject")');
    await page.waitForSelector('#reject-category', T);
    await page.selectOption('#reject-category', code);
    if (typed) await page.fill('#reject-reason', typed);
    await page.click('.dialog button:has-text("Reject")');
    await page.waitForSelector('.dialog', { state: 'detached', ...T });
  };
  const calFile = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#cal-download')]);
    await page.waitForSelector('.notice:has-text("Calendar file downloaded")', T);
    return readFileSync(await dl.path(), 'utf8');
  };
  try {
    await page.clock.install({ time: new Date(2026, 10, 18, 10, 0, 0) }); // Wednesday 18 Nov 2026, week of 2026-11-16
    await page.goto(pathToFileURL(file).href);
    await step('create the vault and seed dated items, a workout and a review date six days ago', async () => {
      await page.fill('#pass', PASS); await page.fill('#pass2', PASS); await page.click('button:has-text("Create vault")');
      await page.waitForSelector('.tile', T);
      await state((M) => globalThis.LifeOS.store.commit((x) => {
        const L = globalThis.LifeOS;
        x.memory.lastReviewAt = '2026-11-12';
        x.entries.push(L.metrics.validateEntry({ id: 'wk1', domain: 'health', type: 'workout', date: '2026-11-17', title: M + ' run', value: 1 }));
        x.renewals.push({ id: 'rn-loop', title: M + ' renewal; plan, A\\B END:VEVENT ' + 'é'.repeat(60), kind: 'insurance', provider: M + ' provider', dueDate: '2026-12-01', cadence: 'once', autoRenews: false, state: 'open', notes: M + ' note' });
        x.maintenance.push({ id: 'mt-loop', title: M + ' gutters', area: '', cadence: 'once', vendor: M + ' vendor', notes: '', state: 'open', nextDue: '2026-11-20' });
        x.activities.push({ id: 'ac-loop', title: M + ' trip', category: 'outing', state: 'planned', date: '2026-11-25', endDate: '2026-11-27', place: M + ' place', withPeople: [], alsoHealth: false, alsoSocial: false, notes: '', costCents: 12345 });
      }), MARK);
      await nav('Settings'); await home();
    });
    await step('review due card: not at 6 days, shown at 7 days, one tap opens the review', async () => {
      if (await page.locator('#review-due').count()) throw new Error('the card is shown at 6 days');
      await state(() => globalThis.LifeOS.store.commit((x) => { x.memory.lastReviewAt = '2026-11-11'; }));
      await nav('Settings'); await home();
      await page.waitForSelector('#review-due', T);
      const t = await page.textContent('#review-due');
      if (!/Weekly review due/.test(t) || !/7 days ago/.test(t) || !/2026-11-11/.test(t)) throw new Error('card text: ' + t);
      if (!/Review streak: 0 weeks/.test(await page.textContent('#dash-streak'))) throw new Error('streak line: ' + await page.textContent('#dash-streak'));
      await noHScroll('dashboard');
      await page.click('#review-due-start'); await page.waitForSelector('h1:has-text("Weekly review")', T);
      if (!/Review streak: 0 weeks in a row/.test(await page.textContent('#rv-streak'))) throw new Error('review streak line');
      await noHScroll('review');
    });
    await step('rules suggestions; rejecting needs a reason category; three rejections of one kind mute it, and it is shown', async () => {
      await page.click('#rules-run');
      await page.waitForSelector('.card[data-insight]:has-text("Workouts: 1 this week")', T);
      await state(() => globalThis.LifeOS.store.commit((x) => {
        for (const n of [2, 3]) globalThis.LifeOS.memory.propose(x, [{ domain: 'health', kind: 'workouts', text: 'Workouts: ' + n + ' this week against a target of 4 (last week 0). Extra ' + n }], { level: 1, period: { from: '2026-11-16', to: '2026-11-22' }, source: 'rules' });
      }));
      await nav('Settings'); await nav('Review'); await page.waitForSelector('.card[data-insight]:has-text("Extra 3")', T);
      // a reason category is required
      await page.click('.card[data-insight]:has-text("Workouts: 1 this week") button:has-text("Reject")');
      await page.waitForSelector('#reject-category', T);
      await page.click('.dialog button:has-text("Reject")');
      await page.waitForFunction(() => /Choose a reason/.test(document.querySelector('.dialog').textContent), null, T);
      if ((await state(() => globalThis.LifeOS.store.getState().memory.insights.filter((i) => i.status === 'rejected').length)) !== 0) throw new Error('rejected with no category');
      const opts = await page.$$eval('#reject-category option', (o) => o.map((x) => x.value));
      if (opts.join() !== ',wrong-number,not-relevant,already-known,too-vague,other') throw new Error('categories: ' + opts.join());
      await page.keyboard.press('Escape');
      await page.waitForSelector('.dialog', { state: 'detached', ...T });
      await rejectWith('Workouts: 1 this week', 'wrong-number', MARK + ' typed reason stays here');
      await rejectWith('Extra 2', 'too-vague');
      if ((await state(() => globalThis.LifeOS.memory.mutedList(globalThis.LifeOS.store.getState()).length)) !== 0) throw new Error('muted after two rejections');
      if (await page.locator('#rv-muted-note').count()) throw new Error('the muted note is shown after two rejections');
      await rejectWith('Extra 3', 'not-relevant');
      await page.waitForSelector('#rv-muted-note', T);
      if (!/1 kind of suggestion is muted/.test(await page.textContent('#rv-muted-note'))) throw new Error('muted note: ' + await page.textContent('#rv-muted-note'));
      const chips = await page.$$eval('.chip[data-reason]', (c) => c.map((x) => x.getAttribute('data-reason')).sort().join());
      if (chips !== 'not-relevant,too-vague,wrong-number') throw new Error('reason chips: ' + chips);
      const st = await state(() => { const s = globalThis.LifeOS.store.getState(); return { lessons: s.memory.lessons.map((l) => l.text), muted: globalThis.LifeOS.memory.mutedList(s).map((m) => m.domain + ':' + m.kind), rules: globalThis.LifeOS.memory.rulesInsights(s, '2026-11-16').map((i) => i.kind) }; });
      if (st.muted.join() !== 'health:workouts' || st.rules.includes('workouts')) throw new Error('mute state: ' + JSON.stringify(st));
      if (st.lessons.length !== 1 || !st.lessons[0].includes(MARK)) throw new Error('the typed reason was not kept on the device');
      await noHScroll('review after rejections');
    });
    await step('Memory lists the muted kind with a one-tap unmute; unmuting brings it back', async () => {
      await nav('Memory'); await page.waitForSelector('[data-muted="health:workouts"]', T);
      if (!/Workout target/.test(await page.textContent('[data-muted="health:workouts"]'))) throw new Error('muted label');
      await noHScroll('memory');
      await page.click('[data-muted="health:workouts"] button:has-text("Unmute")');
      await page.waitForSelector('.notice:has-text("Unmuted")', T);
      await page.waitForSelector('#muted-none', T);
      if (!(await state(() => globalThis.LifeOS.memory.rulesInsights(globalThis.LifeOS.store.getState(), '2026-11-16').some((i) => i.kind === 'workouts')))) throw new Error('the kind is not proposed again after the unmute');
      if (await state(() => globalThis.LifeOS.store.getState().memory.mutes.some((m) => m.active))) throw new Error('a mute is still active');
    });
    await step('prompt: reason counts per area, no typed text; an out-of-range target is refused; a valid one applies only on its tap and shows before and after', async () => {
      await nav('Review'); await page.waitForSelector('h1:has-text("Weekly review")', T);
      await page.click('button:has-text("Suggest with AI")'); await page.waitForSelector('#ai-prompt', T);
      const p = await page.$eval('#ai-prompt', (t) => t.value);
      if (!/- rejection reasons by area, last 12 weeks \(counts\): health: wrong number 1, not relevant 1, too vague 1\./.test(p)) throw new Error('reason counts missing: ' + p.slice(-400));
      if (!/- current targets: workoutsPerWeek 4,/.test(p)) throw new Error('targets line missing');
      if (p.includes(MARK) || p.includes('typed reason')) throw new Error('typed text reached the prompt (PV-6)');
      const before = await state(() => globalThis.LifeOS.store.getState().memory.insights.length);
      await page.fill('#ai-paste', JSON.stringify([{ domain: 'health', text: 'Workouts could rise.', target: { key: 'workoutsPerWeek', value: 99 } }]));
      await page.click('button:has-text("Add suggestions")');
      await page.waitForSelector('.notice.err:has-text("invalid target change")', T);
      if ((await state(() => globalThis.LifeOS.store.getState().memory.insights.length)) !== before) throw new Error('an out-of-range target was stored');
      await page.fill('#ai-paste', JSON.stringify([{ domain: 'health', text: 'Workouts have run above the target.', target: { key: 'workoutsPerWeek', value: 5 } }]));
      await page.click('button:has-text("Add suggestions")');
      await page.waitForSelector('.card[data-insight]:has-text("Workouts have run above the target.") .target-change', T);
      const tc = await page.textContent('.target-change');
      if (!/Workouts per week from 4 to 5\. Nothing changes until you tap Apply/.test(tc)) throw new Error('before and after: ' + tc);
      if ((await state(() => globalThis.LifeOS.store.getState().settings.targets.workoutsPerWeek)) !== 4) throw new Error('proposing changed the target');
      await page.click('#approve-apply');
      await page.waitForSelector('.notice:has-text("Workouts per week is now 5")', T);
      const after = await state(() => { const s = globalThis.LifeOS.store.getState(); const i = s.memory.insights.find((x) => x.target); return [s.settings.targets.workoutsPerWeek, i.status, i.target.applied === true]; });
      if (after.join() !== '5,approved,true') throw new Error('after apply: ' + after);
      await page.waitForSelector('.card[data-insight]:has-text("Workouts have run above the target.") :text("Change applied")', T);
      await nav('Settings'); await page.waitForSelector('#t-wpw', T);
      if ((await page.inputValue('#t-wpw')) !== '5') throw new Error('Settings does not show the new target');
      await noHScroll('settings');
    });
    await step('Test connection: manual mode has nothing to test; a mocked provider gets only the fixed prompt; errors show a fixed code', async () => {
      await page.click('#p-test');
      // SEC-105: the provider here is "None (rules only)", so the message says so (it said "Manual mode" before the audit).
      if (!/Rules only: no AI is set up, so there is no connection to test/.test(await page.textContent('#p-test-out'))) throw new Error('rules-only message: ' + await page.textContent('#p-test-out'));
      await state(() => globalThis.LifeOS.store.commit((x) => { x.settings.provider = { kind: 'manual', baseUrl: '', model: '', apiKey: '' }; }));
      await nav('Overview'); await nav('Settings'); await page.waitForSelector('#p-test', T); await page.click('#p-test');
      if (!/Manual mode has no connection to test/.test(await page.textContent('#p-test-out'))) throw new Error('manual mode message: ' + await page.textContent('#p-test-out'));
      await state((k) => globalThis.LifeOS.store.commit((x) => { x.settings.provider = { kind: 'anthropic', baseUrl: '', model: 'claude-haiku-4-5', apiKey: k }; }), KEY);
      await nav('Overview'); await nav('Settings'); await page.waitForSelector('#p-test', T);
      const bodies = []; let mode = 'bad';
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
      await page.route('https://api.anthropic.com/**', (route) => {
        const req = route.request();
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        bodies.push({ body: req.postData(), key: req.headers()['x-api-key'] });
        return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'application/json' }, cors), body: mode === 'bad' ? 'not json at all' : JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }) });
      });
      await page.click('#p-test');
      await page.waitForFunction(() => /Code: AI_BAD_REPLY/.test(document.querySelector('#p-test-out').textContent), null, T);
      mode = 'ok';
      await page.click('#p-test');
      await page.waitForFunction(() => /Connection works/.test(document.querySelector('#p-test-out').textContent), null, T);
      if (bodies.length !== 2) throw new Error('requests: ' + bodies.length);
      for (const b of bodies) {
        const j = JSON.parse(b.body);
        if (j.system !== 'Connection test. Reply with the single word OK.' || j.messages.length !== 1 || j.messages[0].content !== 'Reply with OK.' || b.key !== KEY) throw new Error('request body: ' + b.body);
        if (b.body.includes(MARK) || b.body.includes(KEY)) throw new Error('user data or the key is in the request body');
      }
      const ring = await state(() => JSON.stringify(globalThis.LifeOS.store.getState().ops.diag.concat(globalThis.LifeOS.ops._pending())));
      if (!/AI_BAD_REPLY/.test(ring) || /not json/.test(ring)) throw new Error('diagnostics: ' + ring.slice(0, 200));
      await page.unroute('https://api.anthropic.com/**');
      await state(() => globalThis.LifeOS.store.commit((x) => { x.settings.provider = { kind: 'none', baseUrl: '', model: '', apiKey: '' }; }));
    });
    await step('calendar file: generic by default, real titles only with the tick and a warning; both valid, escaped, folded, with the same stable UIDs', async () => {
      await nav('Overview'); await nav('Settings'); await page.waitForSelector('#cal-download', T);
      if (await page.locator('#cal-priv').count()) throw new Error('the private tick is offered while the vault is closed');
      if ((await page.isChecked('#cal-real')) || !(await page.isHidden('#cal-real-warn'))) throw new Error('real titles are on or the warning shows by default');
      const generic = await calFile();
      const gev = readIcs(generic);
      if (gev.length < 3) throw new Error('events in the generic file: ' + gev.length);
      if (generic.includes(MARK) || /renewal; plan|gutters|vendor|provider|12345|place/.test(generic)) throw new Error('the generic file holds item text');
      const gt = gev.map((e) => unesc(e.SUMMARY));
      for (const want of ['LifeOS: renewal due', 'LifeOS: maintenance due', 'LifeOS: planned activity']) if (!gt.includes(want)) throw new Error('generic title missing: ' + want);
      const trip = gev.find((e) => unesc(e.SUMMARY) === 'LifeOS: planned activity');
      if (trip.DTSTART !== '20261125' || trip.DTEND !== '20261128') throw new Error('all-day dates: ' + trip.DTSTART + ' ' + trip.DTEND);
      if (!gev.every((e) => /^lifeos-[0-9a-f]{28}@lifeos\.local$/.test(e.UID) && /^\d{8}T\d{6}Z$/.test(e.DTSTAMP))) throw new Error('UID or stamp format');
      await page.check('#cal-real');
      await page.waitForSelector('#cal-real-warn:not(.hidden)', T);
      if (!/not encrypted/.test(await page.textContent('#cal-real-warn'))) throw new Error('warning text');
      await noHScroll('settings calendar');
      const real = await calFile();
      const rev = readIcs(real);
      if (rev.length !== gev.length) throw new Error('event counts differ: ' + gev.length + ' and ' + rev.length);
      if (rev.map((e) => e.UID).sort().join() !== gev.map((e) => e.UID).sort().join()) throw new Error('UIDs are not stable between the two files');
      const rt = rev.map((e) => unesc(e.SUMMARY));
      const want = 'LifeOS: ' + MARK + ' renewal; plan, A\\B END:VEVENT ' + 'é'.repeat(60);
      if (!rt.includes(want)) throw new Error('the escaped title did not round trip: ' + rt.join(' | ').slice(0, 300));
      if (!rt.includes('LifeOS: ' + MARK + ' gutters') || !rt.includes('LifeOS: ' + MARK + ' trip')) throw new Error('real titles missing');
      if (!real.replace(/\r\n /g, '').includes('LifeOS: ' + MARK + ' renewal\\; plan\\, A\\\\B END:VEVENT ')) throw new Error('semicolon, comma and backslash are not escaped in the file');
      for (const never of [MARK + ' note', MARK + ' place', MARK + ' provider', MARK + ' vendor', '12345', '123.45']) if (real.replace(/\r\n /g, '').includes(never)) throw new Error('the real-title file holds ' + never);
      if (real.split('\r\nEND:VEVENT').length - 1 !== rev.length) throw new Error('END:VEVENT count');
      const audit = await state(() => globalThis.LifeOS.store.getState().audit.map((a) => a.action));
      if (!audit.includes('calendar export') || JSON.stringify(audit).includes('LOOP')) throw new Error('audit: ' + audit.slice(-3));
    });
    await step('v1.5.0 audit: never reviewed is due from day 7 (SEC-102); rules-only Test connection text (SEC-105); the month offer lists items as text, ids stay unique (SEC-106), and AI text never becomes markup', async () => {
      await state(() => globalThis.LifeOS.store.commit((x) => { x.memory.lastReviewAt = ''; x.memory.startedOn = '2026-11-12'; }));
      await nav('Settings'); await home();
      if (await page.locator('#review-due').count()) throw new Error('never reviewed: the card is shown at 6 days');
      await state(() => globalThis.LifeOS.store.commit((x) => { x.memory.startedOn = '2026-11-11'; }));
      await nav('Settings'); await home();
      await page.waitForSelector('#review-due', T);
      if (!/You have not finished a weekly review yet/.test(await page.textContent('#review-due'))) throw new Error('never-reviewed card: ' + await page.textContent('#review-due'));
      await nav('Settings'); await page.waitForSelector('#p-test', T); await page.click('#p-test');
      if (!/Rules only: no AI is set up/.test(await page.textContent('#p-test-out'))) throw new Error('rules-only text: ' + await page.textContent('#p-test-out'));
      const HTML = '<img src=x onerror="window.__xss=1"> ' + MARK + ' october';
      await state((t) => globalThis.LifeOS.store.commit((x) => {
        for (const d of ['money', 'work']) x.memory.insights.push({ id: 'oct-' + d, level: 1, period: { from: '2026-10-05', to: '2026-10-11' }, domain: d, text: t + ' ' + d, source: 'ai', status: 'approved', createdAt: '2026-10-11T10:00:00.000Z', decidedAt: '2026-10-11T11:00:00.000Z' });
      }), HTML);
      await nav('Review'); await page.waitForSelector('#offer-month', T);
      const dup = await page.evaluate(() => { const seen = {}, d = []; for (const e of document.querySelectorAll('[id]')) { if (seen[e.id]) d.push(e.id); seen[e.id] = 1; } return d; });
      if (dup.length) throw new Error('duplicate ids on the review screen: ' + dup.join(', '));
      if (!(await page.textContent('#offer-month')).includes('<img src=x')) throw new Error('the offer does not list the items as text');
      if (await page.locator('#offers img, .card[data-insight] img').count()) throw new Error('insight text became markup');
      const n0 = await state(() => globalThis.LifeOS.store.getState().memory.insights.length);
      await page.click('#offer-merge-month'); await page.waitForSelector('.notice:has-text("One proposed monthly entry")', T);
      const m = await state(() => { const s = globalThis.LifeOS.store.getState(); return [s.memory.insights.length, s.memory.insights.filter((i) => i.level === 2 && i.status === 'proposed' && i.kind === 'merge').length]; });
      if (m[0] !== n0 + 1 || m[1] !== 1) throw new Error('merge stored ' + m);
      if (await page.locator('#offer-month').count()) throw new Error('the offer is still shown after merging');
      if (await page.evaluate(() => window.__xss)) throw new Error('script ran from insight text');
    });
    await step('lock and unlock: the due notice and card return; nothing was sent anywhere', async () => {
      await state(() => globalThis.LifeOS.store.commit((x) => { x.memory.lastReviewAt = '2026-11-02'; }));
      await page.click('.top .lockbtn'); await page.waitForSelector('#pass', T);
      if ((await page.textContent('body')).includes(MARK)) throw new Error('the locked page shows data');
      await page.fill('#pass', PASS); await page.click('button:has-text("Unlock")'); await page.waitForSelector('.tile', T);
      await page.waitForSelector('.notice:has-text("Weekly review due")', T);
      await page.waitForSelector('#review-due', T);
      if (!/16 days ago/.test(await page.textContent('#review-due'))) throw new Error('due card: ' + await page.textContent('#review-due'));
      await noHScroll('dashboard after unlock');
      const bad = requests.filter((u) => !/^https:\/\/api\.anthropic\.com\//.test(u));
      if (bad.length) throw new Error('requests: ' + bad.join(', '));
    });
  } catch { /* recorded in problems */ }
  await ctx.close();
}

await run('desktop');
await run('mobile', { width: 390, height: 844 });
await browser.close();
if (problems.length) { console.log('SMOKE-LOOP FAILED\n' + problems.join('\n')); process.exit(1); }
console.log('SMOKE-LOOP PASSED');
