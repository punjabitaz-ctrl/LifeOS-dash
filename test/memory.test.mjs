import { test } from 'node:test';
import assert from 'node:assert/strict';
import { L, E } from './_load.mjs';
const Mem = L.memory;
const P = { from: '2026-11-09', to: '2026-11-15' };
const mk = () => L.store.defaultState();

test('rulesInsights come from digest deltas, with no titles', () => {
  const s = mk();
  s.entries = [E({ domain: 'health', type: 'workout', title: 'SecretRun' }), E({ domain: 'social', type: 'contact', person: 'Zed Person', date: '2026-08-01' })];
  const r = Mem.rulesInsights(s, '2026-11-09');
  assert.ok(r.some((x) => x.domain === 'health' && /1 this week against a target of 4/.test(x.text)));
  assert.ok(r.some((x) => x.domain === 'social'));
  assert.ok(r.every((x) => x.text.length <= 280 && !/SecretRun|Zed/.test(x.text)));
  assert.deepEqual(Mem.rulesInsights(mk(), '2026-11-09'), []);
});
test('parseResponse accepts strict JSON and a fenced block', () => {
  const j = '[{"domain":"health","text":"Move more."}]';
  assert.deepEqual(Mem.parseResponse(j), [{ domain: 'health', text: 'Move more.' }]);
  assert.deepEqual(Mem.parseResponse('```json\n' + j + '\n```'), [{ domain: 'health', text: 'Move more.' }]);
  assert.deepEqual(Mem.parseResponse('  ```\n' + j + '\n```  '), [{ domain: 'health', text: 'Move more.' }]);
  assert.deepEqual(Mem.parseResponse('[]'), []);
});
test('parseResponse rejects anything else around it', () => {
  const j = '[{"domain":"health","text":"x"}]';
  for (const bad of ['Sure! ' + j, j + ' thanks', 'Here:\n```json\n' + j + '\n```', '```json\n' + j + '\n``` done', 'not json', '', '{"domain":"health","text":"x"}', '[', '"str"', null, 5])
    assert.throws(() => Mem.parseResponse(bad), undefined, String(bad));
});
test('parseResponse rejects bad domains, too many items, long text, wrong shapes', () => {
  assert.throws(() => Mem.parseResponse('[{"domain":"crypto","text":"x"}]'), /domain/);
  assert.throws(() => Mem.parseResponse('[{"domain":"__proto__","text":"x"}]'), /domain/);
  assert.throws(() => Mem.parseResponse(JSON.stringify(Array(6).fill({ domain: 'money', text: 'x' }))), /too many/);
  assert.equal(Mem.parseResponse(JSON.stringify(Array(5).fill({ domain: 'money', text: 'x' }))).length, 5);
  assert.throws(() => Mem.parseResponse(JSON.stringify([{ domain: 'money', text: 'x'.repeat(281) }])), /too long/);
  assert.equal(Mem.parseResponse(JSON.stringify([{ domain: 'money', text: 'x'.repeat(280) }]))[0].text.length, 280);
  assert.throws(() => Mem.parseResponse('[{"domain":"money","text":5}]'));
  assert.throws(() => Mem.parseResponse('[{"domain":"money","text":""}]'));
  assert.throws(() => Mem.parseResponse('[null]'));
  assert.throws(() => Mem.parseResponse('[["money","x"]]'));
});
test('parseResponse keeps HTML as plain text and drops extra fields', () => {
  const r = Mem.parseResponse('[{"domain":"money","text":"<img src=x onerror=alert(1)> <b>hi</b>","status":"approved"}]');
  assert.deepEqual(r, [{ domain: 'money', text: '<img src=x onerror=alert(1)> <b>hi</b>' }]);
});
test('propose only creates proposed insights; decide is the only path to approved', () => {
  const s = mk();
  Mem.propose(s, [{ domain: 'money', text: 'a', status: 'approved' }, { domain: 'health', text: 'b' }], { level: 1, period: P, source: 'ai' });
  assert.equal(s.memory.insights.length, 2);
  assert.ok(s.memory.insights.every((i) => i.status === 'proposed' && i.source === 'ai' && i.level === 1));
  assert.equal(Mem.approved(s).length, 0);
  Mem.propose(s, [{ domain: 'money', text: 'a' }], { level: 1, period: P, source: 'ai' });
  assert.equal(s.memory.insights.length, 2, 'dedupe');
  assert.throws(() => Mem.propose(s, [{ domain: 'x', text: 'a' }], { level: 1, period: P, source: 'ai' }));
  assert.throws(() => Mem.propose(s, [{ domain: 'money', text: 'a' }], { level: 1, period: P, source: 'approved' }));
  assert.throws(() => Mem.propose(s, [{ domain: 'money', text: 'a' }], { level: 4, period: P, source: 'ai' }));
  Mem.decide(s, s.memory.insights[0].id, 'approved');
  assert.equal(Mem.approved(s).length, 1);
  assert.equal(Mem.approved(s, 2).length, 0);
  assert.ok(s.memory.insights[0].decidedAt);
  assert.throws(() => Mem.decide(s, s.memory.insights[1].id, 'maybe'));
  assert.throws(() => Mem.decide(s, 'missing', 'approved'));
  assert.ok(L.store.validateState(s));
});
test('rejection reason creates a lesson, capped at 30', () => {
  const s = mk();
  Mem.propose(s, [{ domain: 'money', text: 'a' }], { level: 1, period: P, source: 'rules' });
  Mem.decide(s, s.memory.insights[0].id, 'rejected');
  assert.equal(s.memory.lessons.length, 0);
  for (let i = 0; i < 35; i++) Mem.decide(s, s.memory.insights[0].id, 'rejected', 'reason ' + i);
  assert.equal(s.memory.lessons.length, 30);
  assert.equal(s.memory.lessons[0].text, 'reason 5');
  assert.equal(s.memory.lessons[29].text, 'reason 34');
  Mem.decide(s, s.memory.insights[0].id, 'rejected', 'y'.repeat(500));
  assert.equal(s.memory.lessons[29].text.length, 280);
  Mem.decide(s, s.memory.insights[0].id, 'approved', 'ignored');
  assert.equal(s.memory.lessons.length, 30);
  assert.ok(L.store.validateState(s));
});
test('buildPrompt sends only digest, approved insights (max 8) and lessons (max 8)', () => {
  const s = mk();
  s.entries = [E({ domain: 'social', type: 'contact', person: 'Zed Personname', title: 'TitleSecret1', notes: 'NoteSecret1' }),
    E({ domain: 'work', type: 'outcome', title: 'TitleSecret2', notes: 'NoteSecret2' })];
  for (let i = 0; i < 12; i++) Mem.propose(s, [{ domain: 'money', text: 'ins' + i }], { level: 1, period: P, source: 'rules' });
  s.memory.insights.forEach((x) => Mem.decide(s, x.id, 'approved'));
  for (let i = 0; i < 12; i++) s.memory.lessons.push({ id: 'l' + i, text: 'less' + i, createdAt: 'x' });
  const { system, user } = Mem.buildPrompt(s, 1, P);
  for (const bad of ['TitleSecret', 'NoteSecret', 'Zed', 'Personname']) assert.ok(!system.includes(bad) && !user.includes(bad), bad);
  assert.match(user, /- money: now/);
  assert.equal((user.match(/- \[money\] ins/g) || []).length, 8);
  assert.ok(user.includes('ins11') && !user.includes('ins3\n'));
  assert.equal((user.match(/- less/g) || []).length, 8);
  assert.match(system, /JSON array/);
});
test('buildPrompt levels 2 and 3 consolidate approved lower-level insights in period', () => {
  const s = mk();
  Mem.propose(s, [{ domain: 'money', text: 'inperiod' }], { level: 1, period: P, source: 'rules' });
  Mem.propose(s, [{ domain: 'money', text: 'outperiod' }], { level: 1, period: { from: '2026-09-07', to: '2026-09-13' }, source: 'rules' });
  Mem.propose(s, [{ domain: 'money', text: 'unapproved' }], { level: 1, period: P, source: 'rules' });
  Mem.decide(s, s.memory.insights[0].id, 'approved'); Mem.decide(s, s.memory.insights[1].id, 'approved');
  const u2 = Mem.buildPrompt(s, 2, { from: '2026-11-01', to: '2026-11-30' }).user;
  assert.ok(u2.includes('inperiod') && !u2.includes('outperiod') && !u2.includes('unapproved'));
  assert.ok(!Mem.buildPrompt(s, 3, { from: '2026-10-01', to: '2026-12-31' }).user.includes('inperiod'));
  assert.throws(() => Mem.buildPrompt(s, 0, P));
  assert.throws(() => Mem.buildPrompt(s, 1, { from: 'x', to: 'y' }));
});
