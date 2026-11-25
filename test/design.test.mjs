// The shared design language v1.1 (docs/DESIGN.md), the same look as Resume Engine and ChannelVu: gold main buttons with navy text, a
// navy top bar, blue for links and focus, a colour per area, the two typefaces built into the page, and an Auto, Light and Dark switch
// that keeps one display setting on the device and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildAll, darkTheme, FONTS } from '../build.mjs';

const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const css = src('src/ui/styles.css');
const lum = (hex) => { const h = hex.length === 4 ? '#' + [...hex.slice(1)].map((c) => c + c).join('') : hex; const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const vars = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):(#[0-9a-f]{3,6})\b/gi)].map((m) => [m[1], m[2]]));

test('design: the main button is gold with navy text and the top bar is navy, readable in light and dark', () => {
  const start = css.indexOf('/* Shared design language v1.1');
  assert.ok(start > 0, 'the design block is in styles.css');
  const block = css.slice(start);
  const light = vars(block.slice(0, block.indexOf('}'))), darkAt = block.indexOf(':root:not([data-theme=light]){'), dark = vars(block.slice(darkAt, block.indexOf('}', darkAt)));
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    assert.ok(ratio(t['act-fg'], t.act) >= 4.5, name + ' button text on gold ' + ratio(t['act-fg'], t.act).toFixed(2));
    assert.ok(ratio(t['act-fg'], t['act-hover']) >= 4.5, name + ' button text on hover gold');
    assert.ok(ratio(t['band-fg'], t.band) >= 4.5 && ratio(t['band-mut'], t.band) >= 4.5, name + ' top bar text');
  }
  assert.ok(/\.btn\.pri,\.btn\.pri:hover\{background:var\(--act\);color:var\(--act-fg\)/.test(block), 'primary button uses the gold action token');
  assert.ok(/\.top\{background:var\(--band\)/.test(block), 'navy top bar');
  assert.ok(/\.nav button\[aria-current=page\]\{[^}]*box-shadow:inset 0 -2px 0 var\(--act\)/.test(block), 'gold underline on the current tab');
  assert.ok(!/linear-gradient\(135deg/.test(block), 'the old indigo gradient is gone');
});

test('design: every dark block is written for the device and the switch, and the build repeats them for data-theme=dark', () => {
  const media = [...css.matchAll(/@media \(prefers-color-scheme:dark\)\{([^{]*)\{/g)].map((m) => m[1]);
  assert.ok(media.length >= 3);
  for (const sel of media) assert.equal(sel, ':root:not([data-theme=light])', 'a dark block that Light could not turn off: ' + sel);
  const extra = darkTheme(css);
  assert.ok(extra.startsWith('\n:root[data-theme=dark]{color-scheme:dark;'));
  const d = vars(extra);
  for (const k of ['bg', 'card', 'fg', 'acc', 'act', 'band', 'k0', 't0']) assert.ok(d[k], 'dark ' + k + ' repeated for the switch');
  assert.ok(/:root\[data-theme=light\]\{color-scheme:light\}/.test(css));
  const html = buildAll(new URL('..', import.meta.url).pathname).html;
  assert.ok(html.includes(':root[data-theme=dark]{color-scheme:dark;'));
});

test('design: the two typefaces are built in as data: fonts under font-src data:, and nothing loads from another site', () => {
  const all = buildAll(new URL('..', import.meta.url).pathname);
  assert.equal(FONTS.length, 2);
  for (const [name] of FONTS) assert.ok(all.html.includes('@font-face{font-family:"' + name + '"'), name);
  assert.ok(/src:url\(data:font\/woff2;base64,/.test(all.html));
  assert.ok(!/fonts\.googleapis|fonts\.gstatic|@import/.test(all.html));
  assert.ok(all.csp.split('; ').includes('font-src data:'));
  for (const f of ['OFL-hanken-grotesk.txt', 'OFL-cormorant-garamond.txt']) assert.ok(src('src/fonts/' + f).includes('SIL OPEN FONT LICENSE'), f);
});

function themeEnv(stored) {
  const store = new Map(stored == null ? [] : [['lifeos-theme', stored]]), attrs = new Map(), writes = [];
  const el = (tag) => ({ tag, attrs: {}, kids: [], className: '', id: '', type: '', setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; }, appendChild(c) { this.kids.push(c); return c; }, addEventListener(e, f) { this['on' + e] = f; }, querySelectorAll() { return this.kids.filter((k) => k.tag === 'button'); }, replaceWith(n) { this.replaced = n; }, focus() {} });
  const document = { documentElement: { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) }, createElement: el, createElementNS: (_, t) => el(t), createTextNode: (t) => ({ text: t }) };
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { writes.push([k, v]); store.set(k, v); }, removeItem: (k) => { writes.push([k, null]); store.delete(k); } };
  const ctx = { globalThis: null, window: { localStorage }, document, LifeOS: {} };
  ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(src('src/ui/theme.js'), ctx);
  return { T: ctx.LifeOS.theme, attrs, store, writes };
}

test('design: the theme switch starts on Auto, sets data-theme for Light and Dark, and keeps only its one key on the device', () => {
  let e = themeEnv(null);
  assert.equal(e.T.get(), 'auto'); assert.equal(e.attrs.has('data-theme'), false);
  e.T.set('dark'); assert.equal(e.attrs.get('data-theme'), 'dark'); assert.deepEqual(e.writes, [['lifeos-theme', 'dark']]);
  e.T.set('light'); assert.equal(e.attrs.get('data-theme'), 'light');
  e.T.set('auto'); assert.equal(e.attrs.has('data-theme'), false); assert.equal(e.store.size, 0, 'Auto leaves nothing behind');
  e.T.set('<img src=x>'); assert.equal(e.T.get(), 'auto', 'only the three modes');
  assert.ok(e.writes.every(([k, v]) => k === 'lifeos-theme' && (v === null || v === 'light' || v === 'dark')));
  e = themeEnv('dark'); assert.equal(e.attrs.get('data-theme'), 'dark', 'applied before the first screen');
  e = themeEnv('purple'); assert.equal(e.T.get(), 'auto', 'a stored value it does not know is ignored');
  // wide: three pressed-state buttons in a labelled group; narrow: one button that names the next mode
  e = themeEnv('light');
  const g = e.T.control(false);
  assert.equal(g.attrs.role, 'group'); assert.equal(g.attrs['aria-label'], 'Theme');
  assert.deepEqual(g.kids.map((b) => [b.attrs['data-theme-mode'], b.attrs['aria-pressed']]), [['auto', 'false'], ['light', 'true'], ['dark', 'false']]);
  g.kids[2].onclick(); assert.equal(e.T.get(), 'dark'); assert.deepEqual(g.kids.map((b) => b.attrs['aria-pressed']), ['false', 'false', 'true']);
  const b = e.T.control(true);
  assert.equal(b.attrs['aria-label'], 'Theme: Dark. Switch to Auto'); b.onclick(); assert.equal(e.T.get(), 'auto');
  const t = src('src/ui/theme.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|sessionStorage|indexedDB|fetch\(|—/.test(t));
  assert.ok(src('src/ui/app.js').includes("L.theme ? L.theme.control(isNarrow()) : null"), 'the switch is in the top bar');
});

test('design: the Overview opens on the navy welcome band, and motion still respects reduced motion', () => {
  const a = src('src/ui/app.js');
  assert.ok(a.includes("class: 'row sp pagehead ov-hero'"));
  assert.ok(/\.ov-hero\{[^}]*background:var\(--band\)/.test(css));
  assert.ok(/@media \(prefers-reduced-motion:reduce\)\{[^\n]*\.kpi:hover\{transform:none\}/.test(css));
});
