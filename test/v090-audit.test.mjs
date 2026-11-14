// v0.9.0 audit regression tests (SEC-51 onward), a money-integrity sequence test for Activities, and an end-to-end leak check across
// every domain: adversarial strings in every free-text field never reach a prompt, the digest, rules insights, an error, the console,
// the bytes written to storage or the bytes sent to Drive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { L, PASS, E, S, M, V, Mem, TODAY, WK, clone, build, fresh, live } from './_v070.mjs';
import { buildAdversarial, ADV_MARK } from './_adversarial.mjs';

const Ac = live('activities');
const cents = (v) => Math.round(v * 100);
const expenses = (s) => s.entries.filter((e) => e.domain === 'money' && e.type === 'expense');

// SEC-51: once its cost was in Money an activity's cost could not be edited at all, so a typo was stuck until the user found and
// deleted the expense in Money. A new amount now changes that one expense in the same commit.
test('SEC-51: editing the cost of an activity already in Money updates that expense in the same commit, never adds one', async () => {
  await fresh();
  await S.commit((x) => { const a = Ac.addActivity(x, { title: 'Show', category: 'event', date: '2026-11-20', cost: '50' }, TODAY); Ac.markPaid(x, a.id, TODAY); Ac.createExpense(x, a.id); });
  await S.commit((x) => { Ac.updateActivity(x, x.activities[0].id, { cost: '45.10' }); });
  let s = S.getState();
  assert.equal(expenses(s).length, 1);
  assert.equal(s.activities[0].costCents, 4510);
  assert.equal(cents(expenses(s)[0].value), 4510);
  assert.equal(s.activities[0].expenseId, expenses(s)[0].id);
  assert.equal(M.monthView(s, '2026-11').spendCents, 4510);
  assert.equal(Ac.offers(s, TODAY).length, 0, 'nothing is offered again');
  // Clearing the cost while it is in Money is refused and changes nothing.
  for (const cost of ['', '0']) await assert.rejects(S.commit((x) => { Ac.updateActivity(x, x.activities[0].id, { cost }); }), /delete its expense in Money/);
  s = S.getState();
  assert.equal(s.activities[0].costCents, 4510); assert.equal(cents(expenses(s)[0].value), 4510);
  // An expense that no longer holds the activity's amount (only possible in a crafted copy) is never overwritten.
  const c = clone(s); c.entries.find((e) => e.id === c.activities[0].expenseId).value = 12;
  const v = S.validateState(c);
  assert.throws(() => Ac.updateActivity(v, v.activities[0].id, { cost: '99' }), /no longer matches/);
  assert.equal(cents(expenses(v)[0].value), 1200);
});

// SEC-52: an activity linked to an expense but with no paid date (a crafted or hand-edited copy) counted its cost as committed in the
// Activities view, tile, at-a-glance card and digest while the same money was in Money.
test('SEC-52: a linked expense always means paid; its cost is never committed as well as in Money', () => {
  const s = build((x) => {
    const e = E({ domain: 'money', type: 'expense', date: '2026-11-12', value: 50 });
    x.entries.push(e);
    x.activities.push({ id: 'a1', title: 'Gig', category: 'event', state: 'planned', date: '2026-11-20', place: '', withPeople: [], costCents: 5000, expenseId: e.id, alsoHealth: false, alsoSocial: false, notes: '' });
  });
  assert.equal(s.activities[0].paidOn, '2026-11-12');
  assert.equal(Ac.committed(s, TODAY), 0);
  assert.equal(M.weeklyDigest(s, WK).activities.committedCents, 0);
  assert.equal(Ac.glance(s, TODAY).committedCents, 0);
  assert.equal(M.monthView(s, '2026-11').spendCents, 5000);
});

// SEC-53: with no activity rated this week the prompt said "average worth-it rating 0", which reads as the lowest possible score.
test('SEC-53: the prompt says none rated instead of a zero rating', () => {
  const s = build((x) => { x.activities.push({ id: 'a1', title: 'Walk', category: 'outing', state: 'done', date: '2026-11-10', place: '', withPeople: [], alsoHealth: false, alsoSocial: false, notes: '' }); });
  const u = Mem.buildPrompt(s, 1, { from: WK, to: '2026-11-15' }).user;
  assert.match(u, /average worth-it rating none rated/);
  assert.doesNotMatch(u, /worth-it rating 0/);
});

// SEC-54 (Info): the over-64 MB messages for export and sync now name activities among the things to delete.
test('SEC-54: the size messages name activities', async () => {
  const s = S.defaultState();
  s.entries = Array.from({ length: 50000 }, (_, i) => ({ id: 'e' + i, domain: 'work', type: 'outcome', date: '2026-11-10', title: '一'.repeat(200), status: 'todo', notes: '一'.repeat(2000) }));
  await assert.rejects(V.exportBackup(PASS, s), /activities/);
});

// ---- money integrity: random sequences of every action, checked after each step ----
function rng(seed) { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
function check(s, today, where) {
  const ex = new Map(expenses(s).map((e) => [e.id, e]));
  const seen = new Set();
  let committed = 0;
  const winEnd = L.home.dates.addDays(today, 29);
  for (const a of s.activities) {
    if (a.expenseId) {
      assert.ok(ex.has(a.expenseId), where + ': link to a missing expense');
      assert.ok(!seen.has(a.expenseId), where + ': two activities on one expense');
      seen.add(a.expenseId);
      assert.ok(a.paidOn, where + ': linked but not paid');
      assert.equal(cents(ex.get(a.expenseId).value), a.costCents, where + ': expense and cost disagree');
      assert.equal(Ac.expenseOffer(s, a.id), null, where + ': offer on a linked activity');
    }
    if (a.state === 'planned' && !a.paidOn && (a.endDate || a.date) >= today && a.date <= winEnd) committed += a.costCents || 0;
  }
  assert.equal(Ac.committed(s, today), committed, where + ': committed');
  for (const m of new Set(s.entries.map((e) => e.date.slice(0, 7)))) {
    const want = expenses(s).filter((e) => e.date.slice(0, 7) === m).reduce((t, e) => t + cents(e.value), 0);
    assert.equal(M.monthView(s, m).spendCents, want, where + ': Money spend ' + m);
  }
  for (const k of ['spendCents', 'committedCents']) assert.ok(Number.isInteger(M.weeklyDigest(s, WK).activities[k]), where + ': digest ' + k);
}
test('money integrity: plan, mark paid, done, skip, reschedule, edit, delete either side, backup restore and sync pick never double count or lose a cost', async () => {
  const dates = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-14', '2026-11-30', '2026-12-01', '2026-12-31', '2027-01-01'];
  for (let seed = 1; seed <= 25; seed++) {
    const r = rng(seed), pick = (l) => l[Math.floor(r() * l.length)];
    let s = S.validateState(S.defaultState());
    for (let i = 0; i < 70; i++) {
      const acts = s.activities, a = acts.length ? pick(acts) : null, op = Math.floor(r() * 13);
      const before = clone(s);
      try {
        if (op === 0 || !a) Ac.addActivity(s, { title: 'A' + i, category: pick(['outing', 'event', 'travel']), date: pick(dates), cost: pick(['', '0', '12.34', '99.99', '0.01']), state: pick(['planned', 'done', 'skipped']) }, TODAY);
        else if (op === 1) Ac.markPaid(s, a.id, pick(dates));
        else if (op === 2) Ac.createExpense(s, a.id);
        else if (op === 3) Ac.markDone(s, a.id);
        else if (op === 4) Ac.markSkipped(s, a.id);
        else if (op === 5) Ac.reschedule(s, a.id, pick(dates));
        else if (op === 6) Ac.updateActivity(s, a.id, { cost: pick(['', '5', '7.77', '100']), date: pick(dates) });
        else if (op === 7) Ac.deleteActivity(s, a.id);
        else if (op === 8 && a.expenseId) s.entries = s.entries.filter((e) => e.id !== a.expenseId);
        else if (op === 9) Ac.setState(s, a.id, 'planned');
        else if (op === 10) s.entries.push(E({ domain: 'money', type: 'expense', date: pick(dates), value: 3 }));
        else if (op === 11) s = await V.importBackup(PASS, await V.exportBackup(PASS, s));
        else if (op === 12) { const other = S.validateState(clone(s)); s = S.validateState(clone(r() < 0.5 ? other : before)); }
      } catch (e) {
        assert.ok(!/undefined|NaN|TypeError/.test(e.message), 'unexpected error: ' + e.message);
        s = before; // commit rolls back on a throw
      }
      s = S.validateState(clone(s)); // what commit stores
      check(s, TODAY, 'seed ' + seed + ' step ' + i + ' op ' + op);
    }
  }
});
test('crafted copies: two activities on one expense, a link to an income entry, an expense with no activity', () => {
  const s = build((x) => {
    const e = E({ domain: 'money', type: 'expense', date: '2026-11-12', value: 20 }), inc = E({ domain: 'money', type: 'income', date: '2026-11-12', value: 20 });
    x.entries.push(e, inc, E({ domain: 'money', type: 'expense', date: '2026-11-12', value: 7 }));
    const base = { category: 'event', state: 'done', date: '2026-11-10', place: '', withPeople: [], costCents: 2000, alsoHealth: false, alsoSocial: false, notes: '' };
    x.activities.push(Object.assign({ id: 'a1', title: 'One', expenseId: e.id }, base), Object.assign({ id: 'a2', title: 'Two', expenseId: e.id }, base), Object.assign({ id: 'a3', title: 'Three', expenseId: inc.id }, base));
  });
  assert.equal(s.activities.filter((a) => a.expenseId).length, 1);
  assert.equal(M.monthView(s, '2026-11').spendCents, 2700, 'Money counts each expense once');
  check(s, TODAY, 'crafted');
  assert.equal(Ac.offers(s, TODAY).length, 2, 'the two unlinked done activities are offered, never created');
});

// ---- end-to-end leak check across every domain (state built by test/_adversarial.mjs) ----
const MARK = ADV_MARK;
let k = 0;
const m = (extra = '') => MARK + 'x' + (k++) + ' <b>' + extra;
function adversarial() { const r = buildAdversarial(L); nMarks = r.count; return r.state; }
let nMarks = 0;
test('leak check: no free text from any domain reaches a prompt, digest, insight, error, console, storage bytes or Drive', async () => {
  const logged = [];
  const orig = {};
  for (const f of ['log', 'info', 'warn', 'error', 'debug', 'trace']) { orig[f] = console[f]; console[f] = (...a) => { logged.push(a.map(String).join(' ')); }; }
  try {
    const raw = adversarial();
    const s = S.validateState(clone(raw));
    // every marked string made it into the state, so the checks below are meaningful
    const stored = JSON.stringify(s);
    for (let i = 0; i < nMarks; i++) assert.ok(stored.includes(MARK + i + ' '), 'marker ' + i + ' was not stored');
    assert.ok(nMarks >= 60, 'markers: ' + nMarks);
    const out = [];
    // digests, rules insights and prompts at every level, for this week and neighbours (multi-day, month end)
    for (const wk of ['2026-11-02', WK, '2026-11-16', '2026-11-30']) {
      out.push(JSON.stringify(M.weeklyDigest(s, wk)), JSON.stringify(Mem.rulesInsights(s, wk)));
      const p1 = Mem.buildPrompt(s, 1, { from: wk, to: L.home.dates.addDays(wk, 6) });
      out.push(p1.system, p1.user);
    }
    Mem.propose(s, Mem.rulesInsights(s, WK).length ? Mem.rulesInsights(s, WK) : [{ domain: 'money', text: 'Spend rose' }], { level: 1, period: { from: WK, to: '2026-11-15' }, source: 'rules' });
    for (const i of s.memory.insights) Mem.decide(s, i.id, 'approved');
    for (const [lv, per] of [[2, { from: '2026-11-01', to: '2026-11-30' }], [3, { from: '2026-10-01', to: '2026-12-31' }]]) { const p = Mem.buildPrompt(s, lv, per); out.push(p.system, p.user); }
    for (const id of ['money', 'assets', 'work', 'health', 'activities', 'social', 'learning', 'home', 'admin', 'goals', 'wellbeing']) {
      try { const hd = M.headline(s, id, TODAY); out.push(JSON.stringify({ label: hd.label, value: hd.value })); } catch (e) { out.push(e.message); }
    }
    // errors: invalid input carrying markers through every mutator and the validator
    const errs = [];
    const tryErr = (fn) => { try { fn(); } catch (e) { errs.push(String(e && e.message)); } };
    const w = clone(s);
    tryErr(() => Ac.addActivity(w, { title: m('t'), category: m('c'), date: TODAY }, TODAY));
    tryErr(() => Ac.addActivity(w, { title: m('t'), people: [m('p').padEnd(150, 'x')] }, TODAY));
    tryErr(() => Ac.addActivity(w, { title: m('t'), people: Array.from({ length: 11 }, (_, i) => m('p' + i)) }, TODAY));
    tryErr(() => Ac.addActivity(w, { title: m('t'), notes: m('4111 1111 1111 1111') }, TODAY));
    tryErr(() => Ac.addActivity(w, { title: m('t'), place: m('123-45-6789') }, TODAY));
    tryErr(() => Ac.addActivity(w, { title: m('t'), healthKind: m('k'), alsoHealth: true }, TODAY));
    tryErr(() => Ac.addActivity(w, { title: m('t'), date: m('d') }, TODAY));
    tryErr(() => Ac.addActivity(w, { title: m('t'), cost: m('c') }, TODAY));
    tryErr(() => Ac.addActivity(w, { title: m('t'), goalId: m('g') }, TODAY));
    tryErr(() => Ac.updateActivity(w, m('id'), { title: 'x' }));
    tryErr(() => Ac.addCategory(w, m('c').repeat(3)));
    tryErr(() => Ac.removeCategory(w, m('c')));
    tryErr(() => M.validateEntry({ domain: 'money', type: 'expense', date: TODAY, title: m('t'), value: m('v') }));
    tryErr(() => M.validateEntry({ domain: m('d'), type: 'x', date: TODAY, title: m('t') }));
    tryErr(() => L.learning.addSession(w, { minutes: 20, notes: m('n').padEnd(300, 'x') }, TODAY));
    tryErr(() => L.admin.addRenewal(w, { title: m('4111 1111 1111 1111'), kind: 'insurance', dueDate: TODAY }));
    for (const [key, bad] of [['activities', [{ id: m('i'), title: m('t'), category: 'x', state: m('s'), date: TODAY }]], ['entries', [{ id: 'z', domain: m('d'), type: 'x', date: TODAY, title: m('t') }]],
      ['projects', [{ id: 'p', name: m('n'), kind: m('k') }]], ['goals', [{ id: 'g', title: m('t'), horizon: m('h') }]], [m('key'), 1], ['activityCategories', [m('c'), m('c')]]]) {
      tryErr(() => S.validateState(Object.assign(clone(raw), { [key]: bad })));
    }
    tryErr(() => S.validateState(Object.assign(clone(raw), { activities: [Object.assign(clone(raw.activities[0]), { withPeople: [m('p'), 5] })] })));
    assert.ok(errs.length >= 20, 'every bad input threw (' + errs.length + ')');
    out.push(...errs);
    // storage bytes, a backup file and Drive bytes: ciphertext only
    const { ad, d } = await fresh();
    await S.replaceState(clone(s));
    await S.commit((x) => { Ac.updateActivity(x, 'a2', { notes: m('late') }); });
    const env = ad._m.get('envelope');
    assert.deepEqual(Object.keys(typeof env === 'string' ? JSON.parse(env) : env).sort(), ['ct', 'deviceId', 'iv', 'kdf', 'rev', 'updatedAt', 'v']);
    out.push(JSON.stringify(env));
    out.push(await V.exportBackup(PASS, S.getState()));
    const sent = [];
    const f0 = d.fetch;
    L.sync._setFetch(async (url, o) => { sent.push(String(url), JSON.stringify(o && o.headers), String(o && o.body)); return f0(url, o); });
    assert.equal((await L.sync.run()).kind, 'uploaded');
    out.push(...sent, d.file.text, JSON.stringify(S.getState().audit));
    out.push(...logged);
    const all = out.join('\n');
    assert.ok(!all.includes(MARK), 'leaked: ' + (all.match(/LEAK mark \d+[^\n]{0,40}/) || [''])[0]);
    assert.ok(!all.includes('Ignore previous'));
    assert.ok(!all.includes('LEAK key'), 'API key');
    assert.ok(!/181\.4/.test(out.slice(0, 40).join('\n')), 'SEC-32: the weight value is never in a prompt or digest');
    // the decrypted Drive copy holds everything, so nothing was lost on the way
    const back = await V.importBackup(PASS, d.file.text);
    for (let i = 0; i < 10; i++) assert.ok(JSON.stringify(back).includes(MARK + i + ' '));
  } finally { for (const f of Object.keys(orig)) console[f] = orig[f]; }
});
