// v1.5.0 audit: regression tests for SEC-102 to SEC-108 and proofs for the deviations (a) to (e) and the focus items.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { L, PASS, memAdapter } from './_load.mjs';
import { fastKeys, realKeys, clone } from './_archive.mjs';
import { buildAdversarial, ADV_MARK } from './_adversarial.mjs';
import { renew, maint } from './_v070.mjs';

const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), Mem = view('memory'), AI = view('ai'), CAL = view('calendar'), O = view('ops'), P = view('priv'), M = view('metrics');
const ROOT = new URL('..', import.meta.url).pathname;
const src = (f) => readFileSync(join(ROOT, f), 'utf8');
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { S.lock(); } catch (e) { /* locked */ } realKeys(); } });
const fresh = () => S.validateState(S.defaultState());
const WK = '2026-11-09', PERIOD = { from: WK, to: '2026-11-15' };
const PRIVPASS = 'a private passphrase 99';
const localToday = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
const TARGET_LINE = /^- current targets: workoutsPerWeek (\d+(?:\.\d+)?), contactDays (\d+), savingsRate (\d+(?:\.\d+)?), studyMinutes (\d+), backupReminderDays (\d+)$/m;
const targetLine = (st) => { const m = TARGET_LINE.exec(Mem.buildPrompt(st, 1, PERIOD).user); assert.ok(m, 'targets line missing or not numbers only'); return m[0]; };

// ---------------------------------------------------------------- SEC-102 (deviation c): a never-reviewed vault becomes due
test('SEC-102 a new vault records the day the loop started; never reviewed is due from day 7, not day 6', async () => {
  S._setAdapter(memAdapter());
  const st = await S.init(PASS);
  assert.equal(st.memory.startedOn, localToday(), 'set at creation, in the local date');
  assert.equal(st.memory.lastReviewAt, '');
  const plus = (n) => M.addDays(st.memory.startedOn, n);
  assert.equal(Mem.reviewDue(st, plus(6)).due, false);
  const d7 = Mem.reviewDue(st, plus(7));
  assert.deepEqual(d7, { due: true, never: true, days: null, last: '' });
  // it survives a save, a lock and an unlock
  await S.commit((x) => { x.memory.startedOn = '2026-10-01'; });
  S.lock(); const back = await S.unlock(PASS);
  assert.equal(back.memory.startedOn, '2026-10-01'); assert.equal(Mem.reviewDue(back, '2026-11-19').due, true);
  // finishing a review switches to the normal rule
  Mem.markReviewed(back, '2026-11-19'); assert.deepEqual(Mem.reviewDue(back, '2026-11-20'), { due: false, never: false, days: 1, last: '2026-11-19' });
});
test('SEC-102 an older vault with no review takes the earliest dated trace it holds, never a later one; with none, today', () => {
  const old = clone(fresh()); old.schema = 16; delete old.memory.lastReviewAt; delete old.memory.mutes; delete old.memory.startedOn;
  old.audit = [{ ts: '2026-09-03T10:00:00.000Z', action: 'add' }, { ts: '2026-10-01T10:00:00.000Z', action: 'edit' }];
  old.memory.insights.push({ id: 'i1', level: 1, period: PERIOD, domain: 'money', text: 'x', source: 'rules', status: 'proposed', createdAt: '2026-09-10T00:00:00.000Z' });
  old.ops.lastBackupAt = '2026-08-20';
  const got = S.validateState(old);
  assert.equal(got.memory.startedOn, '2026-08-20');
  assert.equal(Mem.reviewDue(got, '2026-11-19').due, true, 'the owner sees the prompt at once after the upgrade');
  const bare = clone(fresh()); bare.schema = 16; delete bare.memory.startedOn; bare.audit = []; bare.ops = O.defaultOps();
  assert.equal(S.validateState(bare).memory.startedOn, localToday());
  // a schema 17 value is kept; an invalid one is refused; an empty one is derived
  const v17 = clone(fresh()); v17.memory.startedOn = '2026-01-02'; assert.equal(S.validateState(v17).memory.startedOn, '2026-01-02');
  v17.memory.startedOn = '2026-02-30'; assert.throws(() => S.validateState(v17), /startedOn/);
  v17.memory.startedOn = 7; assert.throws(() => S.validateState(v17), /startedOn/);
  v17.memory.startedOn = ''; v17.audit = [{ ts: '2026-03-04T00:00:00.000Z', action: 'add' }]; assert.equal(S.validateState(v17).memory.startedOn, '2026-03-04');
});
test('SEC-102 the dashboard card and the unlock notice say plainly that no review was finished yet', () => {
  const app = src('src/ui/app.js');
  assert.match(app, /d\.never \? 'You have not finished a weekly review yet\.'/);
  assert.match(app, /rd\.never \? 'Weekly review due: none finished yet\.'/);
});

// ---------------------------------------------------------------- deviation (a): the targets line
test('deviation (a): the targets line is five numbers only, identical whatever the vault holds (markers, body targets, wellbeing, private items, business with tax refusing)', async () => {
  const base = targetLine(fresh());
  assert.equal(base, '- current targets: workoutsPerWeek 4, contactDays 30, savingsRate 0.2, studyMinutes 0, backupReminderDays 7');
  const adv = buildAdversarial(L).state;
  adv.settings.health = { units: 'kg', weightStart: 191.37, weightTarget: 173.71, bodyFatStart: 29.13, bodyFatTarget: 17.39 };
  L.tax.startDefaultYear(adv, 2026);
  const st = S.validateState(clone(adv));
  assert.equal(targetLine(st), base, 'the line does not change with body targets, wellbeing, markers or business records');
  for (const lv of [1, 2, 3]) {
    const p = Mem.buildPrompt(st, lv, lv === 1 ? PERIOD : lv === 2 ? { from: '2026-11-01', to: '2026-11-30' } : { from: '2026-10-01', to: '2026-12-31' });
    const all = p.system + '\n' + p.user;
    for (const bad of [ADV_MARK, '191.37', '173.71', '29.13', '17.39', 'weightTarget', 'bodyFat', 'weight ', 'mood', 'LEAK key']) assert.ok(!all.includes(bad), bad + ' reached a level ' + lv + ' prompt');
  }
  // private vault: open and closed, with business records private so the year's tax figures refuse while closed
  S._setAdapter(memAdapter()); await S.init(PASS); await S.replaceState(st);
  await P.setUp(PRIVPASS);
  for (const id of ['in2', 'ex2']) await P.moveIn('entries', id);
  const open = targetLine(S.getState());
  P.close('system');
  const closed = Mem.buildPrompt(S.getState(), 1, PERIOD).user;
  assert.equal(open, base); assert.equal(TARGET_LINE.exec(closed)[0], base);
  const dg = M.weeklyDigest(S.getState(), WK);
  assert.equal(dg.business.tax, undefined, 'tax figures refuse while business records are private');
  assert.ok(!/business profit|set-aside|business detail/.test(closed), 'and no business figure reaches the prompt, in the targets line or elsewhere');
  assert.ok(/business profit/.test(Mem.buildPrompt(st, 1, PERIOD).user), 'precondition: before the move the business line was there');
  // targets changed in Settings change the line, and only the numbers
  await S.commit((x) => { x.settings.targets.workoutsPerWeek = 5; x.settings.targets.contactDays = 400; x.settings.targets.savingsRate = 0.125; L.learning.setWeeklyTarget(x, '300'); x.settings.backupReminderDays = 14; });
  assert.equal(targetLine(S.getState()), '- current targets: workoutsPerWeek 5, contactDays 400, savingsRate 0.125, studyMinutes 300, backupReminderDays 14');
});

// ---------------------------------------------------------------- deviation (b) and target proposals
test('deviation (b) and SEC-108: one invalid target refuses the whole reply with a plain message, and nothing is stored', () => {
  const st = fresh(), before = JSON.stringify(st);
  const reply = JSON.stringify([{ domain: 'health', text: 'Fine item.' }, { domain: 'health', text: 'Bad item.', target: { key: 'workoutsPerWeek', value: 22 } }]);
  let err; try { Mem.propose(st, Mem.parseResponse(reply), { level: 1, period: PERIOD, source: 'ai' }); } catch (e) { err = e; }
  assert.ok(err); assert.match(err.message, /invalid target change/); assert.match(err.message, /Nothing was added\./);
  assert.equal(JSON.stringify(st), before, 'nothing partial was applied');
});
test('target proposals: prototype and unknown keys, own __proto__ fields, odd values and nested shapes are refused; nothing applies without a tap', () => {
  const bad = [
    '{"key":"__proto__","value":1}', '{"key":"constructor","value":1}', '{"key":"hasOwnProperty","value":1}', '{"key":"valueOf","value":1}',
    '{"key":"workoutsPerWeek","value":4,"__proto__":{"applied":true}}', '{"__proto__":{"key":"workoutsPerWeek"},"value":4}',
    '{"key":"workoutsPerWeek","value":4,"applied":true}', '{"key":"contactDays","value":0}', '{"key":"contactDays","value":366}', '{"key":"savingsRate","value":1.01}',
    '{"key":"savingsRate","value":-0.01}', '{"key":"studyMinutes","value":10081}', '{"key":"backupReminderDays","value":61}', '{"key":"backupReminderDays","value":7.5}',
    '{"key":"workoutsPerWeek","value":"4"}', '{"key":"workoutsPerWeek","value":null}', '{"key":"workoutsPerWeek","value":[4]}', '{"key":"workoutsPerWeek","value":1e400}',
    '[{"key":"workoutsPerWeek","value":4}]', 'null', '"workoutsPerWeek"', '{"key":"settings.targets.workoutsPerWeek","value":4}', '{"key":"WorkoutsPerWeek","value":4}',
  ];
  for (const t of bad) assert.throws(() => Mem.parseResponse('[{"domain":"health","text":"x","target":' + t + '}]'), /invalid target change/, t);
  // a valid proposal stores a proposed insight and changes no setting; apply refuses until approved, and twice
  const st = fresh(), set0 = JSON.stringify(st.settings);
  Mem.propose(st, Mem.parseResponse('[{"domain":"health","text":"<img src=x onerror=alert(1)>","target":{"key":"savingsRate","value":0.25}}]'), { level: 1, period: PERIOD, source: 'ai' });
  const ins = st.memory.insights[0];
  assert.equal(ins.status, 'proposed'); assert.equal(JSON.stringify(st.settings), set0);
  assert.throws(() => Mem.applyTarget(st, ins.id), /Approve/);
  Mem.decide(st, ins.id, 'rejected', undefined, { category: 'other' }); assert.throws(() => Mem.applyTarget(st, ins.id), /Approve/);
  assert.equal(JSON.stringify(st.settings), set0);
  ins.status = 'approved'; ins.target.key = 'autoLockMin'; assert.throws(() => Mem.applyTarget(st, ins.id), /Invalid target/, 'a tampered key is checked again at apply');
  ins.target.key = 'savingsRate'; ins.target.value = 5; assert.throws(() => Mem.applyTarget(st, ins.id), /Invalid target/, 'a tampered value is checked again at apply');
  ins.target.value = 0.25; Mem.applyTarget(st, ins.id); assert.equal(st.settings.targets.savingsRate, 0.25);
  assert.throws(() => Mem.applyTarget(st, ins.id), /already applied/);
  // insight text and target labels reach the screen only through text nodes
  const app = src('src/ui/app.js'), card = app.slice(app.indexOf('function insightCard'), app.indexOf('function rejectDialog'));
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(card));
  assert.match(card, /h\('p', \{ text: i\.text \}\)/);
});

// ---------------------------------------------------------------- deviation (d): contactDays
test('deviation (d): contact days above 365 (allowed by the store up to 3650 since v0.1) migrate to schema 17 unchanged; only AI proposals are held to 1 to 365', () => {
  for (const n of [366, 400, 3650]) {
    const old = clone(fresh()); old.schema = 16; delete old.memory.lastReviewAt; delete old.memory.mutes; delete old.memory.startedOn; old.settings.targets.contactDays = n;
    const got = S.validateState(old);
    assert.equal(got.settings.targets.contactDays, n, 'kept as it was');
    assert.equal(S.validateState(clone(got)).settings.targets.contactDays, n, 'and again at schema 17');
    assert.match(Mem.buildPrompt(got, 1, PERIOD).user, new RegExp('contactDays ' + n + ','));
  }
  assert.throws(() => Mem.parseResponse('[{"domain":"social","text":"x","target":{"key":"contactDays","value":400}}]'), /invalid target change/);
  const st = fresh(); st.settings.targets.contactDays = 400;
  Mem.propose(st, Mem.parseResponse('[{"domain":"social","text":"x","target":{"key":"contactDays","value":30}}]'), { level: 1, period: PERIOD, source: 'ai' });
  const p = Mem.targetPreview(st, st.memory.insights[0].id); assert.deepEqual([p.before, p.after], [400, 30]);
});

// ---------------------------------------------------------------- deviation (e) and SEC-104: the rules-only merge
test('deviation (e): offers write nothing; the rules merge stores one proposed entry like an AI consolidation and nothing else', () => {
  const st = fresh();
  for (const [i, d] of [['a', 'money'], ['b', 'work'], ['c', 'health']]) st.memory.insights.push({ id: i, level: 1, period: { from: '2026-10-05', to: '2026-10-11' }, domain: d, text: 'Approved ' + i, source: 'rules', status: 'approved', createdAt: '2026-10-11T10:00:00.000Z', decidedAt: '2026-10-11T11:00:00.000Z' });
  const snap = JSON.stringify(st);
  const offers = Mem.consolidationOffers(st, '2026-11-18');
  assert.equal(JSON.stringify(st), snap, 'an offer changes nothing');
  assert.equal(offers.length, 1); assert.equal(offers[0].count, 3);
  const viaAI = clone(st);
  Mem.propose(viaAI, Mem.parseResponse('[{"domain":"overall","text":"Merged by the AI."}]'), { level: 2, period: offers[0].period, source: 'ai' });
  assert.equal(Mem.mergeByRules(st, 2, offers[0].period), 3);
  const before = JSON.parse(snap), added = st.memory.insights.filter((i) => !before.memory.insights.some((b) => b.id === i.id));
  assert.equal(added.length, 1);
  const m = added[0], a = viaAI.memory.insights[viaAI.memory.insights.length - 1];
  assert.deepEqual(Object.keys(m).sort(), Object.keys(a).concat(['kind']).sort(), 'the same fields as an AI consolidation plus its kind');
  assert.deepEqual([m.status, m.source, m.level, m.domain, m.kind, m.text], ['proposed', 'rules', 2, 'overall', 'merge', 'Approved a | Approved b | Approved c']);
  const strip = (s) => { const c = clone(s); c.memory.insights = c.memory.insights.filter((i) => before.memory.insights.some((b) => b.id === i.id)); return JSON.stringify(c); };
  assert.equal(strip(st), snap, 'nothing else changed: no setting, lesson, review, mute or approval');
  assert.equal(Mem.consolidationOffers(st, '2026-11-18').length, 0, 'the offer ends once the entry exists');
});
test('SEC-104 rejecting merged entries never mutes anything (a muted merge would be listed but change nothing)', () => {
  const st = fresh();
  for (const n of [1, 2, 3, 4]) {
    Mem.propose(st, [{ domain: 'overall', kind: 'merge', text: 'Merged ' + n }], { level: 2, period: { from: '2026-0' + n + '-01', to: '2026-0' + n + '-28' }, source: 'rules' });
    Mem.decide(st, st.memory.insights[st.memory.insights.length - 1].id, 'rejected', undefined, { category: 'too-vague', now: '2026-11-1' + n + 'T10:00:00Z' });
  }
  assert.deepEqual(Mem.mutedList(st), []);
  // rules kinds still mute at exactly three
  for (const n of [1, 2, 3]) {
    Mem.propose(st, [{ domain: 'home', kind: 'maintenance', text: 'M ' + n }], { level: 1, period: PERIOD, source: 'rules' });
    Mem.decide(st, st.memory.insights[st.memory.insights.length - 1].id, 'rejected', undefined, { category: 'not-relevant', now: '2026-11-1' + n + 'T10:00:00Z' });
    assert.equal(Mem.isMuted(st, 'home', 'maintenance'), n === 3);
  }
});

// ---------------------------------------------------------------- PV-6 with categories, over the adversarial vault
test('PV-6 with categories: marked typed reasons in every area never reach any prompt; only fixed category words and counts do', () => {
  const st = buildAdversarial(L).state;
  const areas = L.DOMAINS.map((d) => d.id).filter((d) => d !== 'wellbeing').concat(['overall']);
  areas.forEach((d, k) => {
    Mem.propose(st, [{ domain: d, text: 'Proposal ' + k }], { level: 1, period: PERIOD, source: 'ai' });
    const i = st.memory.insights[st.memory.insights.length - 1];
    Mem.decide(st, i.id, 'rejected', ADV_MARK + ' "typed reason" ' + k + ' 4111 1111 1111 1111', { category: Mem.REASONS[k % Mem.REASONS.length], now: '2026-11-12T10:00:00Z' });
  });
  assert.throws(() => Mem.decide(st, st.memory.insights[0].id, 'rejected', 'x', { category: 'typed text' }), /Invalid rejection reason/);
  const s2 = S.validateState(clone(st));
  for (const lv of [1, 2, 3]) {
    const p = Mem.buildPrompt(s2, lv, lv === 1 ? PERIOD : lv === 2 ? { from: '2026-11-01', to: '2026-11-30' } : { from: '2026-10-01', to: '2026-12-31' });
    const all = p.system + '\n' + p.user;
    for (const bad of [ADV_MARK, 'typed reason', '4111', 'Proposal ']) assert.ok(!all.includes(bad), bad);
    const line = all.split('\n').find((l) => l.startsWith('- rejection reasons by area'));
    assert.ok(line);
    const body = line.replace('- rejection reasons by area, last 12 weeks (counts): ', '').replace(/\.$/, '');
    for (const part of body.split('; ')) assert.match(part, /^[a-z]+: ((wrong number|not relevant|already known|too vague|other) \d+(, )?)+$/, part);
  }
});

// ---------------------------------------------------------------- Test connection
test('SEC-105 Test connection: a hostile error (marker message, throwing getters) gives a fixed code; nothing of it is kept; none and manual send nothing', async () => {
  const p = AI.validateProvider({ kind: 'anthropic', baseUrl: '', model: 'claude-haiku-4-5', apiKey: 'sk-ant-test-0000' });
  const seen = [];
  const hostile = async (url, init) => { seen.push(init.body); const e = new Error(ADV_MARK + ' boom'); Object.defineProperty(e, 'code', { get() { throw new Error(ADV_MARK); } }); throw e; };
  const r = await AI.testConnection(p, hostile);
  assert.equal(r.ok, false); assert.ok(['AI_TIMEOUT', 'AI_NETWORK', 'AI_HTTP', 'AI_BAD_REPLY', 'AI_FAIL'].includes(r.code));
  assert.ok(!JSON.stringify(r).includes('LEAK') && !JSON.stringify(O._pending()).includes('LEAK'));
  assert.equal(seen.length, 1);
  const body = JSON.parse(seen[0]);
  assert.equal(body.system, AI.TEST_PROMPT.system); assert.deepEqual(body.messages, [{ role: 'user', content: AI.TEST_PROMPT.user }]);
  const app = src('src/ui/app.js'), fn = app.slice(app.indexOf('function testConnection('), app.indexOf('function calendarCard'));
  assert.match(fn, /kind === 'none'\) \{ out\.textContent = 'Rules only: no AI is set up, so there is no connection to test\.'/);
  assert.match(fn, /kind === 'manual'\) \{ out\.textContent = 'Manual mode has no connection to test\./);
  assert.ok(fn.indexOf("kind === 'none'") < fn.indexOf('L.ai.testConnection'), 'returns before any call');
});

// ---------------------------------------------------------------- SEC-106: unique ids with offers on the review screen
test('SEC-106 the review screen and its consolidation offers give each AI button its own id', () => {
  const app = src('src/ui/app.js');
  assert.match(app, /id: level === 1 \? 'ai-suggest' : 'ai-suggest-' \+ level/);
  assert.ok(!/\{ id: 'ai-suggest' \}/.test(app));
});

// ---------------------------------------------------------------- SEC-107: downgrade guard
test('SEC-107 an older-format copy names proposed target changes it would drop', () => {
  const cur = fresh();
  Mem.propose(cur, Mem.parseResponse('[{"domain":"health","text":"x","target":{"key":"workoutsPerWeek","value":5}}]'), { level: 1, period: PERIOD, source: 'ai' });
  const older = S.validateState(Object.assign(clone(fresh()), { schema: 16 }));
  assert.deepEqual(S.droppedData(cur, older), ['proposed target changes']);
  assert.deepEqual(S.droppedData(cur, S.validateState(clone(cur))), []);
  assert.deepEqual(S.droppedData(fresh(), older), []);
});

// ---------------------------------------------------------------- schema 17 from every older schema
test('schema 17 migration from every schema 1 to 16 gives the new memory fields with valid values', () => {
  for (let n = 1; n <= 16; n++) {
    const s = clone(fresh()); s.schema = n; delete s.memory.lastReviewAt; delete s.memory.mutes; delete s.memory.startedOn;
    s.memory.mutes = [{ domain: 'money', kind: 'savings', at: '2026-11-01T00:00:00.000Z', active: true }];
    s.memory.insights.push({ id: 'q', level: 1, period: PERIOD, domain: 'money', text: 't', source: 'rules', status: 'rejected', createdAt: '2026-11-01T00:00:00.000Z', decidedAt: '2026-11-02T00:00:00.000Z', kind: 'savings', reason: 'other' });
    const got = S.validateState(s);
    assert.equal(got.schema, 17); assert.equal(got.sourceSchema, n);
    assert.deepEqual(got.memory.mutes, [], 'mutes from an older format are not trusted');
    assert.equal(got.memory.insights[0].reason, undefined); assert.equal(got.memory.insights[0].kind, undefined);
    assert.equal(got.memory.lastReviewAt, '');
    assert.equal(got.memory.startedOn, '2026-11-01', 'from the oldest trace');
  }
});

// ---------------------------------------------------------------- AI-SETUP.md accuracy (SEC-103)
test('SEC-103 docs/AI-SETUP.md matches the code: no lessons sent, codes, timeout, default model, local URL rule; no em dashes', () => {
  const doc = src('docs/AI-SETUP.md'), ai = src('src/core/ai.js');
  assert.ok(!/up to 8 lessons/.test(doc), 'lessons are never sent (PV-6)');
  assert.match(doc, /never sent/);
  for (const c of ['AI_TIMEOUT', 'AI_NETWORK', 'AI_HTTP', 'AI_BAD_REPLY', 'AI_FAIL']) { assert.ok(doc.includes(c)); assert.ok(ai.includes("'" + c + "'")); }
  assert.match(doc, /20 seconds/); assert.match(ai, /setTimeout\(\(\) => ctl\.abort\(\), 20000\)/);
  assert.match(doc, /claude-haiku-4-5/); assert.match(ai, /DEFAULT_MODEL = 'claude-haiku-4-5'/);
  assert.ok(AI.isLocalUrl('http://localhost:11434/v1') && AI.isLocalUrl('http://127.0.0.1:11434/v1') && !AI.isLocalUrl('http://192.168.1.5:11434/v1'));
  assert.match(doc, /Reply with OK\./); assert.equal(AI.TEST_PROMPT.user, 'Reply with OK.');
  assert.ok(!/open the local file copy of LifeOS \(file:\/\/\) instead/.test(doc), 'no untested workaround stated as working');
  assert.ok(!/\u2014/.test(doc));
  // the in-app prompt notes name the targets that are now sent
  assert.match(src('src/ui/app.js'), /The prompt holds the numeric digest, your current targets,/);
});

// ---------------------------------------------------------------- calendar: fuzzed titles in real-title mode, UIDs, generic mode
const ALPHA = [',', ';', '\\', '\r', '\n', '\r\n', '\u2028', '\u2029', '\u0085', '\t', '\u0000', '\u001b', ':', 'END:VEVENT', 'BEGIN:VCALENDAR', 'SUMMARY:x', 'é', '中', '\u{1F600}', 'a', ' ', '"', '\\n', 'DTSTART;VALUE=DATE:20260101'];
function rand(seed) { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; }
function readIcs(text) {
  assert.ok(text.endsWith('\r\n')); assert.ok(!/[^\r]\n/.test(text) && !/\r(?!\n)/.test(text));
  const phys = text.slice(0, -2).split('\r\n');
  for (const l of phys) assert.ok(Buffer.byteLength(l, 'utf8') <= 75, 'line over 75 octets');
  for (let k = 1; k < phys.length; k++) if (phys[k][0] === ' ') assert.ok(!/[\uD800-\uDBFF]$/.test(phys[k - 1]), 'a surrogate pair was split');
  const lines = []; for (const l of phys) { if (l[0] === ' ') lines[lines.length - 1] += l.slice(1); else lines.push(l); }
  const ev = []; let cur = null;
  for (const l of lines.slice(1, -1)) {
    if (l === 'BEGIN:VEVENT') { assert.equal(cur, null); cur = {}; continue; }
    if (l === 'END:VEVENT') { ev.push(cur); cur = null; continue; }
    const m = /^(VERSION|PRODID|CALSCALE|METHOD|X-WR-CALNAME|UID|DTSTAMP|DTSTART;VALUE=DATE|DTEND;VALUE=DATE|SUMMARY|TRANSP):(.*)$/.exec(l); assert.ok(m, 'unexpected line ' + JSON.stringify(l.slice(0, 40)));
    if (cur) { assert.ok(!(m[1] in cur)); cur[m[1]] = m[2]; }
  }
  assert.equal(lines.filter((l) => l === 'BEGIN:VCALENDAR').length, 1);
  return ev;
}
const unesc = (v) => v.replace(/\\([\\;,nN])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
test('calendar: 300 fuzzed titles in real-title mode never change the structure, fold within 75 octets, and round trip after escaping', () => {
  const r = rand(1505), st = S.defaultState(), want = new Map();
  for (let k = 0; k < 300; k++) {
    let t = ''; const n = 1 + Math.floor(r() * 40); for (let j = 0; j < n; j++) t += ALPHA[Math.floor(r() * ALPHA.length)];
    t = t.slice(0, 200);
    st.renewals.push(renew({ id: 'f' + k, title: t, dueDate: M.addDays('2026-11-15', k % 300) }));
    want.set(L.calendar.uidOf('renewal', 'f' + k), 'LifeOS: ' + t);
  }
  let v; try { v = S.validateState(clone(st)); } catch (e) { v = null; }
  const use = v || st; // titles the store would refuse are still fed straight to the builder
  const out = CAL.build(use, { today: '2026-11-14', realTitles: true, stamp: new Date('2026-11-14T00:00:00Z') });
  const ev = readIcs(out.text);
  assert.equal(ev.length, 300);
  const norm = (s) => s.split(/\r\n|\r|\n|\u2028|\u2029/).map((p) => p.replace(/[\u0000-\u001f\u007f]/g, ' ')).join('\n');
  for (const e of ev) {
    assert.match(e.UID, /^lifeos-[0-9a-f]{28}@lifeos\.local$/);
    const src0 = use.renewals.find((x) => L.calendar.uidOf('renewal', x.id) === e.UID);
    assert.equal(unesc(e.SUMMARY), norm('LifeOS: ' + src0.title));
  }
});
test('calendar: UIDs carry no id or name; generic mode over the adversarial vault holds only fixed titles and dates', () => {
  const st = buildAdversarial(L).state;
  st.renewals.push(renew({ id: 'Sam Example renewal 4111', title: 'x', dueDate: '2026-12-01' }));
  st.maintenance.push(maint({ id: 'mt-sam', title: 'y', nextDue: '2026-12-02' }));
  const out = CAL.build(st, { today: '2026-11-10', stamp: new Date('2026-11-10T00:00:00Z') });
  const ev = readIcs(out.text);
  assert.ok(ev.length >= 5);
  const generic = new Set(Object.values(L.calendar.GENERIC));
  for (const e of ev) {
    assert.ok(generic.has(unesc(e.SUMMARY)), e.SUMMARY);
    assert.match(e.UID, /^lifeos-[0-9a-f]{28}@lifeos\.local$/);
    assert.match(e['DTSTART;VALUE=DATE'], /^\d{8}$/); assert.match(e['DTEND;VALUE=DATE'], /^\d{8}$/);
  }
  for (const bad of ['LEAK', 'Sam', '4111', 'mt-sam', 'acc1', 'rn1', 'iv1', 'sp1', '$', 'USD']) assert.ok(!out.text.includes(bad), bad);
  // only digits that belong to dates, stamps and hashes: strip those lines and no digit is left
  const rest = out.text.split('\r\n').filter((l) => !/^(UID|DTSTAMP|DTSTART;VALUE=DATE|DTEND;VALUE=DATE|VERSION):/.test(l)).join('\n');
  assert.ok(!/\d/.test(rest), 'an amount or number outside a date: ' + (rest.match(/.{0,20}\d.{0,20}/) || [''])[0]);
});
