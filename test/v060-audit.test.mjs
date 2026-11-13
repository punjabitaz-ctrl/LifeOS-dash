// v0.6.0 audit regressions (SEC-40 onward). Pure functions only: no storage adapter is installed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L, E } from './_load.mjs';
await import('../build.mjs');
const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), M = live('metrics'), G = live('goals');
const clone = (x) => JSON.parse(JSON.stringify(x));
const TODAY = '2026-11-12', WK = '2026-11-09';
const GE = (date, title, status, notes) => E(Object.assign({ domain: 'goals', type: 'goal', date, title, status }, notes ? { notes } : {}));
const asSchema4 = (s) => { const o = clone(s); o.schema = 4; delete o.goals; return o; };
const goal = (o) => Object.assign({ id: 'g-' + Math.random().toString(36).slice(2), title: 'G', horizon: 'quarterly', domain: 'goals', metric: 'manual', direction: 'up', startValue: 0, targetValue: 100,
  startDate: '2026-10-01', dueDate: '2026-12-31', state: 'active', notes: '', createdAt: '2026-10-01T00:00:00.000Z' }, o);

test('SEC-40 migrating old goal entries keeps every entry\'s date, title, status and notes', () => {
  const s = S.defaultState();
  s.entries.push(GE('2026-08-20', 'Read more', 'at-risk', 'first note'), GE('2026-09-10', 'READ more', 'off-track', 'middle note'),
    GE('2026-11-01', 'read MORE', 'on-track', 'latest note'), E({ domain: 'health', type: 'sleep', date: TODAY, title: 's', value: 7 }));
  const got = S.validateState(asSchema4(s));
  assert.equal(got.goals.length, 1);
  const n = got.goals[0].notes;
  for (const part of ['first note', 'middle note', 'latest note', 'at-risk', 'off-track', 'on-track', '2026-08-20', '2026-09-10', '2026-11-01', 'Read more', 'READ more', 'read MORE']) assert.ok(n.includes(part), 'kept: ' + part);
  assert.ok(n.indexOf('first note') < n.indexOf('middle note') && n.indexOf('middle note') < n.indexOf('latest note'), 'in date order');
  assert.equal(got.entries.length, 1, 'converted entries removed only because the goal holds all of them');
  assert.deepEqual(S.validateState(clone(got)).goals, got.goals, 'stable on a second pass');
  // A history longer than one goal's notes keeps its entries instead of cutting them.
  const big = S.defaultState();
  for (let i = 0; i < 3; i++) big.entries.push(GE('2026-0' + (i + 1) + '-01', 'Long', 'on-track', String(i).repeat(900)));
  const g2 = S.validateState(asSchema4(big));
  assert.equal(g2.goals.length, 1); assert.equal(g2.entries.length, 3, 'entries kept');
  assert.ok(g2.goals[0].notes.length <= 2000 && /kept in the older goal entries/.test(g2.goals[0].notes));
  // The Goals view lists kept entries (read only, through textContent).
  const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  assert.match(app, /function legacyGoalEntries\(s\)/); assert.match(app, /legacyGoalEntries\(s\)\);/);
});

test('SEC-41 goal summaries scan each linked metric once per date, not once per goal', () => {
  const s = S.defaultState();
  for (let i = 0; i < 400; i++) s.entries.push(E({ domain: 'health', type: 'weight', date: M.addDays(TODAY, -i), title: 'w', value: 200 - i / 10 }));
  for (let i = 0; i < 300; i++) s.goals.push(goal({ id: 'g' + i, metric: i % 2 ? 'weight' : 'netWorth', domain: i % 2 ? 'health' : 'assets', direction: 'down', startValue: 300, targetValue: 100, startDate: '2026-01-01' }));
  const st = S.validateState(clone(s));
  const orig = L.metrics.bodySeries, origNw = L.metrics.netWorthDetail;
  let calls = 0;
  L.metrics.bodySeries = function () { calls++; return orig.apply(this, arguments); };
  L.metrics.netWorthDetail = function () { calls++; return origNw.apply(this, arguments); };
  try {
    calls = 0; G.summary(st, TODAY); assert.ok(calls <= 2, 'summary: ' + calls + ' scans');
    calls = 0; G.reviewGoals(st, WK, TODAY); assert.ok(calls <= 4, 'review: ' + calls + ' scans');
    calls = 0; G.digestCounts(st, WK); assert.ok(calls <= 2, 'digest: ' + calls + ' scans');
    calls = 0; const memo = new Map(); for (const g of st.goals) G.evaluate(st, g, TODAY, memo); assert.ok(calls <= 2, 'one render pass: ' + calls + ' scans');
  } finally { L.metrics.bodySeries = orig; L.metrics.netWorthDetail = origNw; }
  // Same answers with and without the memo.
  const memo = new Map();
  for (const g of st.goals) assert.deepEqual(G.evaluate(st, g, TODAY, memo), G.evaluate(st, g, TODAY));
  const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  assert.match(app, /L\.goals\.evaluate\(s, g, t, goalMemo\)/);
});

test('SEC-42 rolling a long-overdue goal lands in the period containing today, however old', () => {
  for (const [h, due, want] of [['weekly', '1990-01-07', { start: WK, end: '2026-11-15' }], ['monthly', '1950-01-31', { start: '2026-11-01', end: '2026-11-30' }],
    ['weekly', '2026-11-01', { start: WK, end: '2026-11-15' }], ['weekly', '2026-11-15', { start: '2026-11-16', end: '2026-11-22' }], ['monthly', '2026-10-31', { start: '2026-11-01', end: '2026-11-30' }]]) {
    const st = S.validateState(clone(Object.assign(S.defaultState(), { goals: [goal({ id: 'r', horizon: h, startDate: '1940-01-01', dueDate: due })] })));
    G.rollOver(st, 'r', TODAY);
    assert.deepEqual({ start: st.goals[0].startDate, end: st.goals[0].dueDate }, want, h + ' due ' + due);
  }
});

test('SEC-43 smoke-sync checks plaintext outside the base64 fields and decrypts the upload, not a regex over ciphertext', () => {
  const t = readFileSync(new URL('./smoke-sync.mjs', import.meta.url), 'utf8');
  assert.ok(!/MARKS\.test\(JSON\.stringify\(env\)\)\) throw/.test(t) && !/\|Groceries\/\.test\(JSON\.stringify\(env\)\)/.test(t), 'no name regex over the whole envelope');
  assert.match(t, /delete outer\.ct/); assert.match(t, /importBackup\(PASS, drive\.file\)/);
  // Why: short names occur by chance in base64 of random bytes.
  const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let hits = 0;
  for (let i = 0; i < 4000; i++) { const r = new Uint8Array(1500); L._webcrypto.getRandomValues(r); let s = ''; for (const b of r) s += b64[b & 63]; if (s.includes('Gym')) hits++; }
  assert.ok(hits > 0, 'a 3-letter name appears by chance in random base64 (' + hits + ' of 4000)');
});
