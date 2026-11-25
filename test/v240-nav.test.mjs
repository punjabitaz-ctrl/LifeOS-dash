// Fixes after v2.4.0 (final review, 25 Nov 2026): the phone bottom bar stays on screen, and a wide screen reaches every area.
// The browser smokes (test/smokes.mjs) cover clicks and layout; these check the rules and lists that caused both bugs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L } from './_load.mjs';

const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const css = src('src/ui/styles.css');
const app = src('src/ui/app.js');
const N = L.nav;

test('nav fix: the progress bar rule no longer matches the phone bottom bar', () => {
  // `.bar` set height:8px on <nav class="nav bar"> as well as the progress bars, so the bottom bar's buttons sat below the screen.
  assert.ok(!/(^|[}\s,])\.bar\{/.test(css), 'no bare .bar rule');
  assert.ok(/svg\.bar\{display:block;width:100%;height:8px;margin-top:4px\}/.test(css), 'the progress bar rule is kept for the svg only');
  assert.ok(/h\('svg', \{ class: 'bar'/.test(app), 'progress bars are svg elements');
  for (const m of css.matchAll(/([^{}]*)\{[^}]*\bheight:\s*\d+px/g)) {
    const sels = m[1].split(',').map((x) => x.trim());
    assert.ok(!sels.some((x) => /^\.nav\.bar$|^\.bar$/.test(x)), 'nothing sets a fixed height on the bottom bar: ' + m[1].trim());
  }
});

test('nav fix: wide-screen tabs include the areas that had none, and More holds the rest', () => {
  const tabs = N.TABS.map((x) => x.label);
  for (const w of ['By country', 'Job search', 'Learning', 'Goals', 'Admin', 'Podcasts']) assert.ok(tabs.includes(w), w);
  // the tabs the wide bar had before stay, in the same order
  const before = ['Overview', 'Money', 'Assets', 'Work', 'Health', 'Business', 'AYiN and clients', 'Review', 'Memory', 'Settings'];
  assert.deepEqual(tabs.filter((x) => before.includes(x)), before);
  const keys = N.TABS.concat(N.TABS_MORE).map((x) => x.key);
  assert.equal(new Set(keys).size, keys.length, 'no area twice');
  assert.deepEqual([...keys].sort(), [...N.all()].sort(), 'tabs plus More reach every area the phone reaches');
  for (const k of keys) assert.ok(N.KEYS.has(k), k);
  assert.ok(!/[–—]/.test(JSON.stringify([N.TABS, N.TABS_MORE])));
});

test('nav fix: the wide bar uses the lists, has More, and wraps instead of hiding tabs off the side', () => {
  const nav = app.slice(app.indexOf('function mainNav()'), app.indexOf('function moreSheet('));
  assert.ok(/L\.nav\.TABS\b/.test(nav) && /L\.nav\.TABS_MORE\b/.test(nav), 'wide bar built from L.nav.TABS, More from TABS_MORE');
  assert.ok(/id: 'nav-more'/.test(nav) && /moreSheet\(rest\)/.test(nav), 'a More button on both widths');
  const wide = css.slice(css.indexOf('/* navigation: text tabs under the top bar'));
  const rule = wide.slice(wide.indexOf('.nav{'), wide.indexOf('}', wide.indexOf('.nav{')));
  assert.ok(/flex-wrap:wrap/.test(rule), 'tabs wrap to a second row');
  assert.ok(!/overflow-x:auto/.test(rule) && !/scrollbar-width:none/.test(rule), 'no hidden sideways scroll');
});

test('nav fix: the tour describes both bars and where the key numbers are', () => {
  const g = src('src/ui/guide-ui.js');
  assert.ok(g.includes('near the top of the Overview'));
  assert.ok(g.includes('On a wide screen, the tabs at the top open the main areas.'));
});
