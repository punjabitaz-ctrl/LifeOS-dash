// v2.1.0 audit (docs/SECURITY.md "v2.1.0 audit", SEC-140 and SEC-141): regression tests for the findings fixed in the audit of the Eating build.
// Full review after v2.1.0 (docs/SECURITY.md "Full review", SEC-142): the home host names cannot be swapped after load.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L, PASS, memAdapter } from './_load.mjs';
import { fastKeys, realKeys, clone, PRIV } from './_archive.mjs';
import { buildAdversarial, ADV_MARK } from './_adversarial.mjs';
import { buildAll } from '../build.mjs';

const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), P = view('priv'), F = view('food');
const NOSTORE = { get: async () => { throw new Error('NO_STORAGE'); }, set: async () => { throw new Error('NO_STORAGE'); }, del: async () => { throw new Error('NO_STORAGE'); } };
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); try { return await fn(t); } finally { try { P.close('system'); } catch (e) { /* closed */ } try { S.lock(); } catch (e) { /* locked */ } S._setAdapter(NOSTORE); realKeys(); } });
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('SEC-140: a logged meal cannot move out alone while its saved meal stays private; plain message, nothing written; the meal takes its rows out with it', async () => {
  const { state } = buildAdversarial(L);
  S._setAdapter(memAdapter()); S.lock(); await S.init(PASS); await S.replaceState(state);
  await P.setUp(PRIV); await P.open(PRIV);
  assert.equal(await P.moveIn('meals', 'ml1'), 2, 'the meal and its one linked row');
  const before = JSON.stringify(S.getState());
  await assert.rejects(P.moveOut('mealLog', 'mg1'), (e) => {
    assert.match(e.message, /^Its saved meal is in the private vault\. Move the saved meal out instead/);
    assert.ok(!e.message.includes(ADV_MARK) && !/Invalid data/.test(e.message));
    return true;
  });
  assert.equal(JSON.stringify(S.getState()), before, 'nothing was written');
  // the one-off row has no meal and moves in and out alone
  assert.equal(await P.moveIn('mealLog', 'mg2'), 1); assert.equal(await P.moveOut('mealLog', 'mg2'), 1);
  // moving the meal out takes its row with it, and the link survives a close
  assert.equal(await P.moveOut('meals', 'ml1'), 2);
  P.close('test');
  const m = S.getState();
  assert.deepEqual(m.mealLog.map((r) => [r.id, r.mealId || null]).sort(), [['mg1', 'ml1'], ['mg2', null]]);
  assert.equal(F.mealName(m, m.mealLog.find((r) => r.id === 'mg1')), state.meals[0].name);
  // with the meal public, a row still moves in and out alone
  await P.open(PRIV);
  assert.equal(await P.moveIn('mealLog', 'mg1'), 1); assert.equal(await P.moveOut('mealLog', 'mg1'), 1);
  assert.doesNotThrow(() => S.validateState(clone(S.getState())));
});

test('SEC-141: the day picked on the Eating card is memory only and is reset on lock, so the next unlock shows and logs to today', () => {
  const ui = src('src/ui/app.js');
  const lock = ui.slice(ui.indexOf('function lockNow()'), ui.indexOf("view = { name: 'lock' };", ui.indexOf('function lockNow()')));
  assert.ok(/eatDay = '';/.test(lock), 'reset in lockNow');
  assert.ok(/var eatDay = '';/.test(ui) && !/localStorage|sessionStorage/.test(ui.slice(ui.indexOf('var eatDay'), ui.indexOf('function editMealDialog'))), 'never stored');
});

test('SEC-140/141: SPEC.md records the audit amendment, without em dashes', () => {
  const spec = src('SPEC.md'), at = spec.indexOf('Amendment (v2.1.0 audit');
  assert.ok(at > 0);
  const a = spec.slice(at);
  for (const w of ['Move the saved meal out', 'reset on lock']) assert.ok(a.includes(w), w);
  assert.ok(!/—/.test(spec.slice(spec.indexOf('## v2.1.0 addendum'))));
});

test('SEC-142: the AI test hook keeps only the two fixed host names, copied and frozen; a caller cannot add or change one later', () => {
  const AI = L.ai, h = { 'ai-nas': 'n.example.test', 'ai-pc': 'p.example.test', sync: 'evil.example.test', extra: 'x.example.test' };
  try {
    AI._setHosts(h);
    assert.equal(AI.hostFor('nas'), 'n.example.test');
    assert.equal(AI.hostFor('pc'), 'p.example.test');
    h['ai-nas'] = 'evil.example.test';
    assert.equal(AI.hostFor('nas'), 'n.example.test', 'a later change to the caller object does not reach the hook');
    AI._setHosts({ 'ai-nas': 'Bad Host!', 'ai-pc': 'p.example.test' });
    assert.equal(AI.hostFor('nas'), '', 'a malformed name is not taken');
    assert.equal(AI.hostFor('pc'), 'p.example.test');
  } finally { AI._setHosts(null); }
});

test('SEC-142: the built page freezes LifeOS.HOSTS, so page code cannot point sync or AI at another name after load', () => {
  const { html } = buildAll();
  const js = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)[1], head = js.split('\n;\n')[0];
  const g = {};
  new Function('globalThis', head)(g);
  assert.ok(Object.isFrozen(g.LifeOS.HOSTS));
  assert.throws(() => { 'use strict'; g.LifeOS.HOSTS = { sync: 'evil.example.test' }; }, TypeError);
  assert.throws(() => { 'use strict'; g.LifeOS.HOSTS.sync = 'evil.example.test'; }, TypeError);
  assert.equal(g.LifeOS.HOSTS.sync, 'sync.lifeos.tazabbas.com');
});
