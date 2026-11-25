// The first-run tour (getting started guide) in src/ui/guide-ui.js: it starts once per vault on the Overview, walks the real
// screens one step at a time, ends on Skip, Escape, Finish and lock, and starts again from Settings and the Getting started page.
// The card is drawn in a minimal stand-in DOM (no browser here); test/smoke-tour.mjs covers clicks and layout in Chrome.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { L, PASS, memAdapter } from './_load.mjs';
import { fastKeys, realKeys } from './_archive.mjs';

const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), O = live('ops'), P = live('priv');
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { P.close('system'); } catch (e) { /* closed */ } try { S.lock(); } catch (e) { /* locked */ } realKeys(); } });

// ---- a stand-in DOM: elements with ids, classes, children and listeners; querySelector finds ids and the selectors a test places ----
class Node0 {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.text = ''; this.parent = null; this.on = {}; this.cls = new Set(); this.isConnected = false; this.focused = 0;
    const self = this; this.classList = { add: (c) => self.cls.add(c), remove: (c) => self.cls.delete(c), contains: (c) => self.cls.has(c) }; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(k, f) { (this.on[k] = this.on[k] || []).push(f); }
  fire(k, e) { (this.on[k] || []).forEach((f) => f(e || { preventDefault() {} })); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; } }
  focus() { this.focused++; doc.activeElement = this; }
  scrollIntoView() { this.scrolled = (this.scrolled || 0) + 1; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  all() { return [this].concat(...this.children.map((c) => c.all())); }
}
const doc = {
  body: new Node0('body'), placed: {}, activeElement: null,
  getElementById(id) { return doc.body.all().find((n) => n.id === id) || null; },
  querySelector(sel) { if (sel.startsWith('#')) return doc.getElementById(sel.slice(1)); return doc.placed[sel] || null; },
  querySelectorAll(sel) { const c = sel.startsWith('.') ? sel.slice(1) : null; return doc.body.all().concat(Object.values(doc.placed)).filter((n, i, a) => a.indexOf(n) === i && c && n.cls.has(c)); },
};
globalThis.document = doc;
function h(tag, props, ...kids) {
  const el = new Node0(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.text = String(v);
    else if (k === 'class') String(v).split(' ').forEach((c) => c && el.cls.add(c));
    else el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k) el.appendChild(typeof k === 'string' ? Object.assign(new Node0('#text'), { text: k }) : k);
  return el;
}
const btn = (text, onclick, cls, extra) => h('button', Object.assign({ type: 'button', class: 'btn' + (cls ? ' ' + cls : ''), onclick, text }, extra || {}));
vm.runInThisContext(src('src/ui/guide-ui.js'));
const G = L.guideUI;

// A tiny app: go() changes the view and renders; render() mirrors app.js (screen in <main>, then afterRender).
function app() {
  const a = { view: { name: 'dashboard' }, dialog: false, gone: [], saves: 0 };
  a.ctx = { h, btn, view: () => a.view, state: () => S.getState(), dialogOpen: () => a.dialog,
    commit: (fn) => { a.saves++; return P.write(fn); },
    go: (name, extra) => { const e = Object.assign({}, extra || {}); delete e.name; a.view = Object.assign({ name }, e); a.gone.push(L.nav.keyOf(a.view)); a.render(); } };
  a.render = () => {
    doc.body.children = doc.body.children.filter((c) => c.id === 'tour');   // the app's own root is redrawn; the tour card is body-level
    doc.placed = {};
    const main = h('main', null, h('h1', { text: 'screen ' + L.nav.keyOf(a.view) }));
    doc.body.appendChild(main); doc.placed['main h1'] = main.children[0];
    for (const sel of ['.ov-head', '.mod[data-mod="kpis"]', '.mod[data-mod="shortcuts"]', '#ov-pick', 'nav.nav']) if (a.view.name === 'dashboard') { const n = h('div', sel.startsWith('#') ? { id: sel.slice(1) } : null); main.appendChild(n); if (!sel.startsWith('#')) doc.placed[sel] = n; }
    if (a.view.name === 'settings') { main.appendChild(h('div', { id: 'sync-card' })); main.appendChild(h('div', { id: 'guide-card' })); }
    G.afterRender(a.ctx);
  };
  return a;
}
const card = () => doc.getElementById('tour');
const press = (id) => { const b = doc.getElementById(id); assert.ok(b, 'button ' + id); assert.ok(!b.attrs.disabled, id + ' is enabled'); b.fire('click'); };
async function freshVault() { S._setAdapter(memAdapter()); S.lock(); await S.init(PASS); G.onLock(); doc.body.children = []; }
const settle = () => new Promise((r) => setTimeout(r, 5));

test('the tour covers every area the owner named, in order, and each step opens a real screen', () => {
  const names = G.TOUR.map((x) => x.name);
  assert.deepEqual(names, ['welcome', 'overview', 'kpis', 'shortcuts', 'choose', 'nav', 'money', 'assets', 'countries', 'health', 'learning', 'admin', 'review', 'settings', 'sync', 'rerun']);
  for (const x of G.TOUR) {
    assert.ok(L.nav.KEYS.has(x.key), x.name + ' opens a known screen');
    assert.ok(Array.isArray(x.at) && x.title && x.text && x.text.length <= 220, x.name + ' is short');
    assert.ok(!/—|–/.test(x.title + x.text), 'no dashes in ' + x.name);
  }
  const by = Object.fromEntries(G.TOUR.map((x) => [x.name, x]));
  assert.equal(by.countries.key, 'countries'); assert.equal(by.health.key, 'v:health'); assert.ok(by.health.at.includes('#hl-eat'), 'points at the eating log');
  assert.equal(by.learning.key, 'v:learning'); assert.equal(by.admin.key, 'v:admin'); assert.ok(by.sync.at.includes('#sync-card'));
  assert.ok(by.rerun.at.includes('#guide-card') && /Rerun|Getting started/.test(by.rerun.text), 'ends where it can be rerun');
  assert.ok(/Rerun getting started guide/.test(by.welcome.text), 'the first step says how to see it again');
  // the setup steps page keeps its nine steps (test/v180), and the tour does not add to them
  assert.equal(G.steps().length, 9);
  const g = src('src/ui/guide-ui.js').replace(/\/\/.*$/gm, '');
  assert.equal([...g.matchAll(/id: '([a-z]+)', title/g)].length, 9);
  assert.ok(!/innerHTML|localStorage|sessionStorage|eval\(|fetch\(/.test(g), 'no markup strings, browser storage or network');
});

test('first run: starts by itself once per vault on the Overview, remembers it in the vault, and walks every screen to the end', async () => {
  await freshVault();
  assert.equal(G.seen(S.getState()), false);
  const a = app(); a.render();
  assert.ok(card(), 'the card shows on the first Overview');
  assert.equal(G.active(), 'welcome');
  assert.match(doc.getElementById('tour-count').textContent, /1 of 16/);
  assert.equal(card().attrs.role, 'dialog'); assert.equal(card().attrs['aria-modal'], 'false');
  assert.ok(doc.getElementById('tour-back').attrs.disabled, 'Back is off on the first step');
  assert.equal(doc.activeElement && doc.activeElement.id, 'tour-next', 'focus on Next');
  // a redraw on the same step (a save elsewhere on the screen) keeps focus where the owner put it
  const elsewhere = h('input'); elsewhere.focus(); a.render();
  assert.equal(doc.activeElement, elsewhere, 'no focus jump on a redraw');
  await settle();
  assert.equal(G.seen(S.getState()), true, 'stored in the vault as soon as it starts');
  assert.equal(S.getState().settings.setup.tour, true);
  // walk it
  for (let i = 1; i < G.TOUR.length; i++) {
    press('tour-next');
    const st = G.TOUR[i];
    assert.equal(G.active(), st.name);
    assert.equal(L.nav.keyOf(a.view), st.key, st.name + ' is on its screen');
    assert.equal(doc.body.children.filter((c) => c.id === 'tour').length, 1, 'one card at a time');
    const marked = [...new Set(doc.body.all().concat(Object.values(doc.placed)))].filter((n) => n.cls.has('tour-on'));
    assert.ok(marked.length <= 1, 'at most one outline at ' + st.name + ': ' + marked.length);
    if (st.name === 'kpis') assert.ok(doc.placed['.mod[data-mod="kpis"]'].cls.has('tour-on'));
    if (st.name === 'sync') assert.ok(doc.getElementById('sync-card').cls.has('tour-on'));
  }
  assert.equal(doc.getElementById('tour-next').textContent, 'Finish');
  assert.equal(doc.getElementById('tour-skip'), null, 'no Skip on the last step');
  press('tour-back'); assert.equal(G.active(), 'sync');
  press('tour-next'); press('tour-next');
  assert.equal(G.active(), null); assert.equal(card(), null);
  assert.equal(a.view.name, 'dashboard', 'Finish goes back to the Overview');
  // it never starts by itself again, on this page or after a lock and unlock
  a.render(); assert.equal(card(), null);
  G.onLock(); a.render(); assert.equal(card(), null);
});

test('Skip and Escape end it where you are; locking ends it; a dialog on the first Overview waits for the next one', async () => {
  await freshVault();
  const a = app();
  a.dialog = true; a.render();
  assert.equal(card(), null, 'never over an open dialog');
  a.dialog = false; a.render();
  assert.ok(card());
  press('tour-next'); press('tour-next');
  press('tour-skip');
  assert.equal(card(), null); assert.equal(G.active(), null); assert.equal(a.view.name, 'dashboard');
  // rerun from Settings: starts at step 1 even though it was seen
  a.view = { name: 'settings' }; a.render(); assert.equal(card(), null);
  assert.equal(G.start(a.ctx), true);
  assert.equal(G.active(), 'welcome'); assert.equal(a.view.name, 'dashboard', 'opens the Overview first');
  press('tour-next'); press('tour-next'); press('tour-next'); press('tour-next'); press('tour-next'); press('tour-next');
  assert.equal(G.active(), 'money'); assert.deepEqual(a.view, { name: 'domain', domain: 'money' });
  card().fire('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(card(), null); assert.equal(a.view.domain, 'money', 'Escape leaves you on the screen you reached');
  // lock mid-tour
  G.start(a.ctx); assert.ok(card());
  G.onLock(); assert.equal(card(), null); assert.equal(G.active(), null);
  S.lock(); assert.equal(G.start(a.ctx), false, 'never starts while locked');
});

test('a missing target (a hidden card) only drops the outline; the step still shows and moves on', async () => {
  await freshVault();
  const a = app();
  a.render(); await settle();
  // hide the Key numbers card: the step falls back to the next selector
  press('tour-next'); press('tour-next');
  assert.equal(G.active(), 'kpis');
  delete doc.placed['.mod[data-mod="kpis"]'];
  G.afterRender(a.ctx);
  assert.ok(card()); assert.equal(G.active(), 'kpis');
  assert.ok(doc.getElementById('ov-pick').cls.has('tour-on'), 'falls back to Choose what shows');
  press('tour-skip');
});

test('the vault keeps the flag: true or false only, absent on new and older vaults, and nothing else changes', async () => {
  await freshVault();
  const s = S.defaultState();
  assert.deepEqual(s.settings.setup, { dismissed: false, targetsSaved: false }, 'a new vault has not seen it');
  await S.commit((x) => { x.settings.setup.tour = true; });
  assert.equal(S.getState().settings.setup.tour, true);
  S.lock(); await S.unlock(PASS);
  assert.equal(S.getState().settings.setup.tour, true, 'kept across a lock');
  await assert.rejects(S.commit((x) => { x.settings.setup.tour = 'yes'; }));
  assert.equal(S.getState().settings.setup.tour, true);
  await S.commit((x) => { x.settings.setup.tour = false; });
  assert.equal(S.getState().settings.setup.tour, false);
  await S.commit((x) => { delete x.settings.setup.tour; });
  assert.equal('tour' in S.getState().settings.setup, false);
  assert.equal(S.getState().schema, 24, 'no schema change');
});

test('wiring: every render ends with the tour, the lock screen ends it, and Settings and the Getting started page start it again', () => {
  const app = src('src/ui/app.js'), css = src('src/ui/styles.css'), g = src('src/ui/guide-ui.js'), dist = src('dist/lifeos.html');
  assert.match(app, /decorateRows\(\);\n.*\n\s+if \(L\.guideUI\) L\.guideUI\.afterRender\(tourCtx\(\)\);\n  \}/);
  assert.match(app, /view\.name === 'lock'\) \{ if \(L\.guideUI\) L\.guideUI\.onLock\(\); root\.appendChild\(lockScreen\(\)\); return; \}/);
  assert.match(app, /btn\('Rerun getting started guide', function \(\) \{ L\.guideUI\.start\(tourCtx\(\)\); \}, 'sm pri', \{ id: 'settings-tour' \}\)/);
  assert.match(app, /id: 'settings-guide'/, 'the setup steps page is still one tap from Settings');
  assert.match(g, /btn\('Take the tour', function \(\) \{ start\(lastCtx\); \}, 'sm pri', \{ id: 'guide-tour' \}\)/);
  assert.match(css, /\n\.tour\{position:fixed;/); assert.match(css, /\n\.tour-on\{outline:/);
  assert.ok(css.indexOf('.tour{') > css.indexOf('.dialog.sheet{'), 'placed with the other overlays');
  assert.ok(!/\.tour[^{]*\{[^}]*#[0-9a-f]{3,6}/i.test(css), 'colours come from the theme variables');
  for (const t of ['Rerun getting started guide', 'Take the tour', 'Getting started, ', '.tour-on{']) assert.ok(dist.includes(t), 'built file has ' + t);
});
