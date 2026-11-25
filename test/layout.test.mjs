// v0.12.0: customizable home layouts. Whitelisted ids, per viewport class, restore, append of new modules, reset, validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { L, memAdapter, PASS } from './_load.mjs';
import { clone } from './_v070.mjs';

const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), Y = live('layout');
const IDS = () => Y.MODULES.map((m) => m.id);
const item = (id, size, hidden) => ({ id, size: size || 'small', hidden: !!hidden });
const withLayouts = (lay) => { const s = S.defaultState(); s.settings.layouts = lay; return s; };

test('modules: the old dashboard order first, then the revenue modules; default list shows everything', () => {
  const ids = IDS();
  assert.equal(ids.length, 23); assert.equal(new Set(ids).size, 23);
  // v2.3.0: the Overview's key numbers and shortcuts come first
  assert.deepEqual(ids.slice(0, 5), ['kpis', 'shortcuts', 'glance', 'priorities', 'tile-money']);
  assert.deepEqual(ids.slice(-8), ['rev-month', 'rev-net-line', 'rev-expected', 'tax-setaside', 'tax-next', 'inv-open', 'budget-pinned', 'payees-near']);
  const d = Y.defaultList();
  assert.deepEqual(d.map((x) => x.id), ids); assert.ok(d.every((x) => x.hidden === false));
  assert.equal(Y.which(719), 'narrow'); assert.equal(Y.which(720), 'wide'); assert.equal(Y.which(390), 'narrow'); assert.equal(Y.which(1280), 'wide');
  assert.equal(Y.label('rev-month'), 'Revenue this month'); assert.equal(Y.label('nope'), '');
  assert.ok(Object.isFrozen(Y.MODULES));
});

test('save and restore, narrow and wide independently', () => {
  const settings = clone(S.defaultState().settings);
  let n = Y.get(settings, 'narrow'), w = Y.get(settings, 'wide');
  assert.deepEqual(n, Y.defaultList()); assert.deepEqual(w, Y.defaultList());
  n = Y.move(n, 'rev-month', -3); n = Y.setHidden(n, 'tile-admin', true);
  w = Y.moveTo(w, 'tile-goals', 0); w = Y.setSize(w, 'tile-money', 'wide');
  Y.set(settings, 'narrow', n); Y.set(settings, 'wide', w);
  const st = S.validateState(Object.assign(clone(S.defaultState()), { settings }));
  const n2 = Y.get(st.settings, 'narrow'), w2 = Y.get(st.settings, 'wide');
  assert.deepEqual(n2, n); assert.deepEqual(w2, w);
  assert.equal(n2.findIndex((x) => x.id === 'rev-month'), IDS().indexOf('rev-month') - 3);
  assert.equal(n2.find((x) => x.id === 'tile-admin').hidden, true); assert.equal(w2.find((x) => x.id === 'tile-admin').hidden, false);
  assert.equal(w2[0].id, 'tile-goals'); assert.equal(n2[0].id, 'kpis');
  assert.equal(w2.find((x) => x.id === 'tile-money').size, 'wide'); assert.equal(n2.find((x) => x.id === 'tile-money').size, 'small');
  // a layout round trips through the encrypted store untouched
  assert.deepEqual(S.validateState(clone(st)).settings.layouts, st.settings.layouts);
});

test('unknown ids and repeats are dropped, new modules are appended visible, bad sizes fall back to the module size', () => {
  const saved = [item('tile-money'), item('ghost'), item('tile-money', 'wide', true), item('priorities', 'wide', true), item('glance', 'small'), item('rev-month', 'wide')];
  const c = Y.clean(saved);
  assert.deepEqual(c.map((x) => x.id), ['tile-money', 'priorities', 'glance', 'rev-month']);
  assert.equal(c[2].size, 'wide', 'glance supports wide only'); assert.equal(c[3].size, 'wide'); assert.equal(c[1].hidden, true);
  const r = Y.resolve(c);
  assert.equal(r.length, 23); assert.deepEqual(r.slice(0, 4).map((x) => x.id), ['tile-money', 'priorities', 'glance', 'rev-month']);
  assert.ok(r.slice(4).every((x) => x.hidden === false)); assert.deepEqual(r.slice(4).map((x) => x.id), IDS().filter((id) => !['tile-money', 'priorities', 'glance', 'rev-month'].includes(id)));
  // a layout saved by an older build that knew fewer modules gets the new ones at the end
  const old = Y.defaultList().slice(0, 13);
  assert.deepEqual(Y.resolve(old).slice(13).map((x) => x.id), IDS().slice(13));
  // a hostile saved list resolves to the default instead of throwing
  assert.deepEqual(Y.resolve('x'), Y.defaultList()); assert.deepEqual(Y.resolve([{ id: 5 }]), Y.defaultList()); assert.deepEqual(Y.resolve(null), Y.defaultList());
  const s = { layouts: { narrow: 'bad', wide: [item('rev-expected')] } };
  assert.deepEqual(Y.get(s, 'narrow'), Y.defaultList()); assert.equal(Y.get(s, 'wide')[0].id, 'rev-expected');
  assert.deepEqual(Y.get(undefined, 'wide'), Y.defaultList());
});

test('reset to default clears only the chosen width; set refuses unknown widths and keeps the other layout', () => {
  const settings = clone(S.defaultState().settings);
  Y.set(settings, 'narrow', Y.move(Y.defaultList(), 'glance', 2)); Y.set(settings, 'wide', Y.setHidden(Y.defaultList(), 'glance', true));
  Y.reset(settings, 'narrow');
  assert.deepEqual(settings.layouts.narrow, []); assert.deepEqual(Y.get(settings, 'narrow'), Y.defaultList());
  assert.equal(Y.get(settings, 'wide').find((x) => x.id === 'glance').hidden, true);
  assert.throws(() => Y.set(settings, 'tablet', []), /Unknown layout/); assert.throws(() => Y.reset(settings, '__proto__'), /Unknown layout/);
  const bare = {}; Y.set(bare, 'wide', []); assert.deepEqual(Object.keys(bare.layouts).sort(), ['narrow', 'wide']);
  // move helpers do not mutate their input and clamp
  const l = Y.defaultList(), before = JSON.stringify(l);
  Y.move(l, 'glance', 5); Y.moveTo(l, 'glance', 99); Y.setHidden(l, 'glance', true); Y.setSize(l, 'glance', 'small');
  assert.equal(JSON.stringify(l), before);
  assert.equal(Y.moveTo(l, 'glance', 99).at(-1).id, 'glance'); assert.equal(Y.moveTo(l, 'tile-admin', -4)[0].id, 'tile-admin');
  assert.equal(Y.move(l, 'kpis', -1)[0].id, 'kpis'); assert.equal(Y.moveTo(l, 'nope', 0).length, 23);
  assert.equal(Y.setSize(l, 'glance', 'small').find((x) => x.id === 'glance').size, 'wide', 'a size the module lacks is ignored');
  assert.equal(Y.setSize(l, 'tile-money', 'wide').find((x) => x.id === 'tile-money').size, 'wide');
});

test('validateState: layout ids whitelisted, sizes and flags checked, cap enforced, nothing but known keys stored', () => {
  const ok = S.validateState(withLayouts({ narrow: [item('tile-money'), item('ghost'), item('tile-money')], wide: [] }));
  assert.deepEqual(ok.settings.layouts.narrow, [item('tile-money')]);
  const extra = S.validateState(withLayouts({ narrow: [Object.assign(item('tile-money'), { evil: '<img>' })], wide: [], other: [item('glance')] }));
  assert.deepEqual(Object.keys(extra.settings.layouts).sort(), ['narrow', 'wide']); assert.deepEqual(Object.keys(extra.settings.layouts.narrow[0]).sort(), ['hidden', 'id', 'size']);
  for (const bad of [{ narrow: 'x', wide: [] }, { narrow: [5], wide: [] }, { narrow: [item('tile-money', 'huge')], wide: [] }, { narrow: [{ id: 'tile-money', size: 'small', hidden: 'no' }], wide: [] }, { narrow: [{ id: 5, size: 'small', hidden: false }], wide: [] }, { narrow: [{ id: 'x'.repeat(61), size: 'small', hidden: false }], wide: [] }, 'x', []]) assert.throws(() => S.validateState(withLayouts(bad)), /Invalid data/, JSON.stringify(bad));
  const many = Array.from({ length: 65 }, (_, i) => item('ghost' + i));
  assert.throws(() => S.validateState(withLayouts({ narrow: many, wide: [] })), /too many/);
  assert.equal(S.validateState(withLayouts({ narrow: many.slice(0, 64), wide: [] })).settings.layouts.narrow.length, 0);
  assert.equal(S.validateState(withLayouts(undefined)).settings.layouts.narrow.length, 0);
  // the layout cannot carry text into the app: only ids from the whitelist survive
  assert.ok(!JSON.stringify(S.validateState(withLayouts({ narrow: [item('<img src=x>')], wide: [] })).settings).includes('<img'));
});

test('a schema 10 file with layouts has them ignored; a stored layout survives lock and unlock', async () => {
  const old = withLayouts({ narrow: [item('glance', 'wide', true)], wide: [] }); old.schema = 10;
  assert.deepEqual(S.validateState(old).settings.layouts, { narrow: [], wide: [] });
  S._setAdapter(memAdapter()); S.lock(); await S.init(PASS);
  await S.commit((s) => { Y.set(s.settings, 'narrow', Y.setHidden(Y.defaultList(), 'tile-admin', true)); });
  S.lock(); const st = await S.unlock(PASS);
  assert.equal(Y.get(st.settings, 'narrow').find((x) => x.id === 'tile-admin').hidden, true);
  assert.equal(Y.get(st.settings, 'wide').find((x) => x.id === 'tile-admin').hidden, false);
});
