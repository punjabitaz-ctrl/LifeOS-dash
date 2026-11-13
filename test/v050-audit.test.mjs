// v0.5.0 audit regressions (SEC-32 onward). Pure functions only: no storage adapter is installed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L, E } from './_load.mjs';
await import('../build.mjs');
const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), M = live('metrics'), Mem = live('memory');
const WK = '2026-11-09';
const clone = (x) => JSON.parse(JSON.stringify(x));
const W = (date, value) => E({ domain: 'health', type: 'weight', date, title: 'Weight', value });

test('SEC-32 weight change never reaches a prompt, also not through an approved rules insight', () => {
  const s = S.validateState(clone(Object.assign(S.defaultState(), { entries: [W('2026-11-02', 200), W('2026-11-12', 195.5)] })));
  const ins = Mem.rulesInsights(s, WK);
  assert.ok(ins.some((i) => i.text === 'Weight moved down 4.5 lb this week.'), 'the insight still exists in the vault');
  Mem.propose(s, ins, { level: 1, period: { from: WK, to: '2026-11-15' }, source: 'rules' });
  for (const i of s.memory.insights) Mem.decide(s, i.id, 'approved');
  assert.ok(s.memory.insights.some((i) => /Weight moved/.test(i.text) && i.status === 'approved'));
  const ps = [Mem.buildPrompt(s, 1, { from: WK, to: '2026-11-15' }), Mem.buildPrompt(s, 2, { from: '2026-11-01', to: '2026-11-30' }), Mem.buildPrompt(s, 3, { from: '2026-10-01', to: '2026-12-31' })];
  // Level 2 and 3 consolidate level 1 and 2 insights; make a level 2 copy too.
  s.memory.insights.push({ id: 'l2', level: 2, period: { from: '2026-11-01', to: '2026-11-30' }, domain: 'health', text: 'Weight moved down 4.5 lb this week.', source: 'rules', status: 'approved', createdAt: 1 });
  ps.push(Mem.buildPrompt(s, 3, { from: '2026-10-01', to: '2026-12-31' }));
  for (const p of ps) { assert.ok(!/weight|195|4\.5/i.test(p.user), p.user); }
  assert.match(ps[0].user, /Workouts|health detail|Approved insights/);
});

test('SEC-34 a lb/kg round trip does not drift, through validateState as on every commit', () => {
  let s = S.validateState(clone(Object.assign(S.defaultState(), { entries: [W('2026-11-12', 180)] })));
  s.settings.health.weightTarget = 165.5; s.settings.health.weightStart = 201.3;
  for (let i = 0; i < 25; i++) {
    M.setWeightUnits(s, 'kg'); s = S.validateState(clone(s));
    M.setWeightUnits(s, 'lb'); s = S.validateState(clone(s));
  }
  const r1 = (x) => Math.round(x * 10) / 10;
  assert.equal(r1(s.entries[0].value), 180); assert.equal(r1(s.settings.health.weightTarget), 165.5); assert.equal(r1(s.settings.health.weightStart), 201.3);
  assert.ok(Math.abs(s.entries[0].value - 180) < 1e-4);
  M.setWeightUnits(s, 'kg');
  assert.equal(r1(s.entries[0].value), 81.6); assert.equal(r1(M.bodyMetrics(s, 'weight', '2026-11-12').target), 75.1);
});

test('SEC-33 the targets form stores typed values in the shown units before converting, and leaves untouched inputs alone', () => {
  const src = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const i = src.indexOf("}, 'health settings')"), body = src.slice(src.lastIndexOf('return commit(function (x) {', i), i);
  assert.ok(body.indexOf('x.settings.health[k] = vals[k]') >= 0 && body.indexOf('x.settings.health[k] = vals[k]') < body.indexOf('M.setWeightUnits(x, u)'), 'values are applied before the unit switch');
  assert.match(src, /if \(ins\[k\]\.value\.trim\(\) !== ins\[k\]\.dataset\.shown\) vals\[k\]/);
  // The same order on the model: 180 lb target, switch to kg with the form unchanged gives about 81.6 kg, not 180 kg.
  const s = S.validateState(clone(S.defaultState()));
  s.settings.health.weightTarget = 180; M.setWeightUnits(s, 'kg');
  assert.equal(Math.round(s.settings.health.weightTarget * 10) / 10, 81.6);
});

test('SEC-35 the default "today" is the local calendar date, not the UTC one', () => {
  const RealDate = globalThis.Date, tz = process.env.TZ;
  // 2026-11-15 23:30 in New York is already Monday 2026-11-16 in UTC.
  process.env.TZ = 'America/New_York';
  const fixed = RealDate.parse('2026-11-16T04:30:00Z');
  class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } }
  globalThis.Date = FakeDate;
  try {
    const ny = new RealDate(fixed);
    if (ny.getDate() !== 15) return; // the platform ignores a runtime TZ change: nothing to prove here
    assert.equal(M.todayISO(), '2026-11-15');
    const s = S.validateState(clone(S.defaultState()));
    const ser = M.series(s, 'health', 2);
    assert.equal(JSON.stringify(ser), JSON.stringify(M.series(s, 'health', 2, '2026-11-15')), 'series without a date uses the local week');
  } finally { globalThis.Date = RealDate; if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
  const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  assert.ok(!/metrics\.(series|netWorthHistory|cashflow)\([^)]*\b8\)/.test(app) && /metrics\.series\(s, d\.id, 8, t\)/.test(app), 'dashboard passes the local date');
  assert.ok(!/toISOString\(\)\.slice\(0, 10\)/.test(readFileSync(new URL('../src/core/sync.js', import.meta.url), 'utf8')), 'backup file names use the local date');
});

test('SEC-36 workout types on entries lose bidi and zero-width characters like other entry text', () => {
  const s = Object.assign(S.defaultState(), { entries: [E({ domain: 'health', type: 'workout', date: '2026-11-10', title: 'W', kind: 'str‮ength​' })] });
  assert.equal(S.validateState(clone(s)).entries[0].kind, 'strength');
});
