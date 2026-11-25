// v2.3.0 (SPEC.md "v2.3.0 addendum: Overview and visual refresh"): the Overview (the screen that was called Dashboard) gains a Key
// numbers strip and a Shortcuts row the owner picks, stored in settings.overview; schema 23 with clean migrations and a downgrade guard;
// a brighter look with light and dark tokens that keep WCAG AA contrast.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L, PASS, memAdapter } from './_load.mjs';
import { fastKeys, realKeys, clone } from './_archive.mjs';

const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), O = view('ops'), Ov = view('overview'), Lay = view('layout'), N = view('nav');
const NOSTORE = { get: async () => { throw new Error('NO_STORAGE'); }, set: async () => { throw new Error('NO_STORAGE'); }, del: async () => { throw new Error('NO_STORAGE'); } };
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { S.lock(); } catch (e) { /* locked */ } S._setAdapter(NOSTORE); realKeys(); } });
const TODAY = '2026-11-25';
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
async function vault(state) { S._setAdapter(memAdapter()); S.lock(); await S.init(PASS); if (state) await S.replaceState(state); }

test('defaults: eight key numbers and seven shortcuts until the owner chooses; every default is a known id', () => {
  const s = S.defaultState();
  assert.deepEqual(s.settings.overview, { custom: false, metrics: [], shortcuts: [] });
  assert.deepEqual(Ov.metrics(s.settings), [...Ov.DEFAULT_METRICS]);
  assert.deepEqual(Ov.shortcuts(s.settings), [...Ov.DEFAULT_SHORTCUTS]);
  const ids = Ov.METRICS.map((m) => m.id), keys = Ov.shortcutKeys();
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const id of Ov.DEFAULT_METRICS) assert.ok(ids.includes(id), id);
  for (const k of Ov.DEFAULT_SHORTCUTS) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes('dashboard'), 'the Overview is not a shortcut to itself');
  assert.ok(!ids.some((id) => /wellbeing|priv/.test(id)), 'wellbeing has no key number on the Overview');
  for (const k of keys) assert.ok(Ov.shortcutLabel(k), 'label for ' + k);
  // A chosen empty list stays empty: choosing nothing is a choice.
  const t = S.defaultState(); Ov.save(t.settings, [], []);
  assert.deepEqual([Ov.metrics(t.settings), Ov.shortcuts(t.settings)], [[], []]);
  Ov.reset(t.settings); assert.deepEqual(Ov.metrics(t.settings), [...Ov.DEFAULT_METRICS]);
});

test('cleanSettings: whitelisted ids only, repeats dropped, capped at 12, strict on shape, never free text', () => {
  assert.deepEqual(Ov.cleanSettings(undefined), Ov.defaultSettings());
  const many = Ov.METRICS.map((m) => m.id);
  const c = Ov.cleanSettings({ custom: true, metrics: ['money', 'money', 'nope', 'Free text <b>', ...many], shortcuts: ['v:money', 'https://evil.example', 'v:money', 'dashboard', 'review'] });
  assert.equal(c.metrics.length, Ov.CAP);
  assert.deepEqual(c.metrics.slice(0, 2), ['money', 'assets']);
  assert.deepEqual(c.shortcuts, ['v:money', 'review']);
  assert.ok(!JSON.stringify(c).includes('evil') && !JSON.stringify(c).includes('Free'));
  const bads = [5, 'x', [], { custom: 'yes', metrics: [], shortcuts: [] }, { metrics: [], shortcuts: [] }, { custom: true, metrics: 'money', shortcuts: [] },
    { custom: true, metrics: [5], shortcuts: [] }, { custom: true, metrics: ['x'.repeat(41)], shortcuts: [] }, { custom: true, metrics: Array(49).fill('money'), shortcuts: [] },
    { custom: true, metrics: [], shortcuts: null }];
  for (const b of bads) assert.throws(() => Ov.cleanSettings(b), /Invalid data/, JSON.stringify(b).slice(0, 60));
  // Unknown fields are not kept.
  assert.deepEqual(Object.keys(Ov.cleanSettings({ custom: false, metrics: [], shortcuts: [], note: 'x' })).sort(), ['custom', 'metrics', 'shortcuts']);
});

test('toggle and move: pure, capped, clamped at the ends', () => {
  const a = ['money', 'work'];
  assert.deepEqual(Ov.toggle(a, 'health', true), ['money', 'work', 'health']);
  assert.deepEqual(a, ['money', 'work'], 'the input list is not changed');
  assert.deepEqual(Ov.toggle(a, 'money', false), ['work']);
  assert.deepEqual(Ov.toggle(a, 'money', true), ['work', 'money']);
  const full = Ov.METRICS.slice(0, Ov.CAP).map((m) => m.id);
  assert.deepEqual(Ov.toggle(full, 'streak', true), full, 'the thirteenth is refused');
  assert.deepEqual(Ov.move(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b']);
  assert.deepEqual(Ov.move(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(Ov.move(['a', 'b', 'c'], 'a', 9), ['b', 'c', 'a']);
  assert.deepEqual(Ov.move(['a', 'b'], 'z', 1), ['a', 'b']);
});

test('value: every key number works on an empty vault, opens its own area, and a failure shows a dash instead of breaking', () => {
  const s = S.validateState(clone(S.defaultState()));
  const viewKeys = N.BAR.concat(N.MORE).map((x) => x.key);
  for (const m of Ov.METRICS) {
    const v = Ov.value(s, m.id, TODAY);
    assert.equal(v.id, m.id); assert.equal(v.area, m.label);
    assert.ok(typeof v.display === 'string' && v.display.length && v.display !== '-', m.id + ' ' + v.display);
    assert.ok(v.label && typeof v.sub === 'string', m.id);
    assert.ok(viewKeys.includes(v.key), m.id + ' opens ' + v.key);
  }
  assert.equal(Ov.value(s, 'streak', TODAY).display, '0 weeks');
  assert.throws(() => Ov.value(s, 'nope', TODAY), /Unknown key number/);
  const real = L.revenue.totalsIn;
  try {
    L.revenue.totalsIn = () => { throw new Error('boom'); };
    const v = Ov.value(s, 'rev-month', TODAY);
    assert.deepEqual([v.display, v.sub, v.key], ['-', '', 'v:command']);
  } finally { L.revenue.totalsIn = real; }
});

test('layout: Key numbers and Shortcuts lead the default order; an older saved layout gets them at the top once', () => {
  assert.deepEqual(Lay.MODULES.slice(0, 2).map((m) => m.id), ['kpis', 'shortcuts']);
  const old = [{ id: 'priorities', size: 'wide', hidden: false }, { id: 'glance', size: 'wide', hidden: true }];
  const lifted = Lay.cleanLayouts({ narrow: old, wide: [] }, 22);
  assert.deepEqual(lifted.narrow.map((x) => x.id), ['kpis', 'shortcuts', 'priorities', 'glance']);
  assert.deepEqual(lifted.wide, [], 'an unsaved width stays unsaved and follows the default');
  assert.equal(lifted.narrow[3].hidden, true, 'hidden modules stay hidden');
  // In the current format nothing is moved: a module moved to the bottom stays there.
  const mine = [{ id: 'priorities', size: 'wide', hidden: false }, { id: 'kpis', size: 'wide', hidden: false }];
  assert.deepEqual(Lay.cleanLayouts({ narrow: mine, wide: [] }, 23).narrow.map((x) => x.id), ['priorities', 'kpis']);
});

test('schema 23: older vaults migrate with the default Overview and lifted layouts; a newer one is refused', async () => {
  assert.equal(S.SCHEMA, 23);
  for (const n of [1, 11, 21, 22]) {
    const o = clone(S.defaultState()); o.schema = n; delete o.settings.overview;
    if (n === 1) { for (const k of ['accounts', 'recurring', 'budgets', 'categories']) delete o[k]; }
    if (n < 21) { delete o.meals; delete o.mealLog; delete o.settings.food; }
    if (n >= 11) o.settings.layouts = { narrow: [{ id: 'priorities', size: 'wide', hidden: false }], wide: [] };
    const v = S.validateState(o);
    assert.equal(v.schema, 23, 'from ' + n);
    assert.deepEqual(v.settings.overview, Ov.defaultSettings());
    if (n >= 11) assert.deepEqual(v.settings.layouts.narrow.map((x) => x.id), ['kpis', 'shortcuts', 'priorities']);
  }
  // An older format cannot carry overview choices: they are dropped, not trusted.
  const o22 = clone(S.defaultState()); o22.schema = 22; o22.settings.overview = { custom: true, metrics: ['streak'], shortcuts: [] };
  assert.deepEqual(S.validateState(o22).settings.overview, Ov.defaultSettings());
  // Strict in the current format.
  const bad = clone(S.defaultState()); bad.settings.overview = { custom: 1, metrics: [], shortcuts: [] };
  assert.throws(() => S.validateState(bad), /Invalid data/);
  const newer = clone(S.defaultState()); newer.schema = 24;
  assert.throws(() => S.validateState(newer), /schema/);
});

test('downgrade guard names Overview choices only when the owner made some', () => {
  const s = S.defaultState(); Ov.save(s.settings, ['streak', 'money'], ['review']);
  const cur = S.validateState(clone(s));
  const older = clone(cur); older.schema = 22; delete older.settings.overview;
  assert.ok(S.droppedData(cur, S.validateState(older)).includes('Overview choices'));
  const plain = S.validateState(clone(S.defaultState())), po = clone(plain); po.schema = 22;
  assert.ok(!S.droppedData(plain, S.validateState(po)).includes('Overview choices'));
  assert.ok(src('src/core/store.js').includes('if (src < 23)'));
});

test('choices persist through a commit, a lock and an unlock, and a backup round trip', async () => {
  await vault();
  await S.commit((x) => { Ov.save(x.settings, ['jobs-week', 'money'], ['v:jobs', 'settings']); Lay.set(x.settings, 'wide', Lay.move(Lay.get(x.settings, 'wide'), 'kpis', 3)); });
  S.lock(); await S.unlock(PASS);
  const st = S.getState();
  assert.deepEqual(Ov.metrics(st.settings), ['jobs-week', 'money']);
  assert.deepEqual(Ov.shortcuts(st.settings), ['v:jobs', 'settings']);
  assert.equal(Lay.get(st.settings, 'wide')[3].id, 'kpis', 'the moved strip stays where it was put');
  realKeys();
  const back = await L.vault.importBackup(PASS, await L.vault.exportBackup(PASS, st));
  assert.deepEqual(back.settings.overview, st.settings.overview);
});

test('the screen: named Overview, with the strip, the shortcuts, the picker and its controls', () => {
  const app = src('src/ui/app.js');
  assert.equal(N.BAR[0].label, 'Overview');
  for (const id of ['ov-kpis', 'ov-kpis-edit', 'ov-shortcuts', 'ov-sc-edit', 'ov-pick', 'ovp-kpis', 'ovp-cards', 'ovp-shortcuts', 'ovp-defaults', 'dash-customize']) assert.ok(app.includes("'" + id + "'") || app.includes("'#" + id) || app.includes(id), id);
  for (const t of ['Choose what shows on your Overview', 'Key numbers', 'Shortcuts', 'Back to the defaults', 'Overview saved.', 'Back to overview']) assert.ok(app.includes(t), t);
  assert.ok(!app.includes('Back to dashboard'), 'old wording is gone');
  assert.ok(app.includes('L.overview.save(') && app.includes('L.layout.set('), 'the picker saves both in one commit');
  const ov = src('src/core/overview.js');
  for (const f of [app.slice(app.indexOf('function kpiStrip'), app.indexOf('function emptyLine')), ov]) assert.ok(!/\u2014/.test(f), 'no em dashes in Overview copy');
});

test('the look: brighter tokens keep AA contrast in light and dark, and motion respects reduced motion', () => {
  const css = src('src/ui/styles.css');
  const six = (h) => (h.length === 4 ? '#' + [...h.slice(1)].map((c) => c + c).join('') : h);
  const tok = (block) => Object.fromEntries([...block.slice(0, block.indexOf('}')).matchAll(/--([a-z0-9-]+):(#[0-9a-f]{6}|#[0-9a-f]{3})\b/gi)].map((m) => [m[1], six(m[2])]));
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const light = tok(css.split('\n')[0]), dark = tok(css.slice(css.indexOf(':root{', css.indexOf('prefers-color-scheme: dark'))));
  for (const t of [light, dark]) {
    for (const k of ['fg', 'mut', 'acc', 'ok', 'warn', 'bad']) { assert.ok(ratio(t[k], t.card) >= 4.5, k + ' on card ' + ratio(t[k], t.card).toFixed(2)); assert.ok(ratio(t[k], t.bg) >= 4.5, k + ' on bg'); }
    assert.ok(ratio(t['acc-fg'], t.acc) >= 4.5, 'button text');
  }
  assert.ok(css.includes('prefers-reduced-motion'));
  assert.ok(css.includes('.kpis') && css.includes('.shortcut'));
});
