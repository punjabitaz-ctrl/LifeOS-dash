// v2.4.0: the By country screen, the Assets screen and the Admin tax checklist render from real state in a minimal stand-in DOM
// (no browser here). It catches a missing helper or a wrong field name, and checks what the owner reads: amounts in their own
// currency, no combined total without a rate, and the rate once typed. The browser smokes (test/smokes.mjs) cover clicks and layout.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { L, PASS, memAdapter, E } from './_load.mjs';
import { fastKeys, realKeys } from './_archive.mjs';

const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), O = view('ops'), C = view('countries'), P = view('priv');
const NOSTORE = { get: async () => { throw new Error('NO_STORAGE'); }, set: async () => { throw new Error('NO_STORAGE'); }, del: async () => { throw new Error('NO_STORAGE'); } };

// ---- a stand-in DOM: just enough for h(), add() and the screens' own calls ----
class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.own = ''; this.value = ''; this.classList = { add() {}, remove() {}, contains: () => false, toggle() {} }; this.style = {}; }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.children.push(typeof c === 'string' ? new FakeText(c) : c); }
  replaceChildren(...cs) { this.children = []; this.append(...cs); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener() {} removeEventListener() {} focus() {} remove() {}
  querySelector() { return null; } querySelectorAll() { return []; }
  set textContent(t) { this.own = t; this.children = []; }
  get textContent() { return this.own + this.children.map((c) => c.textContent).join(''); }
  find(pred) { if (pred(this)) return this; for (const c of this.children) { const f = c.find && c.find(pred); if (f) return f; } return null; }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this.own = t; } }
const doc = {
  createElement: (t) => new FakeNode(t), createElementNS: (ns, t) => new FakeNode(t), createTextNode: (t) => new FakeText(t),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: new FakeNode('body'), documentElement: new FakeNode('html'),
};
let UI = null;
function loadUI() {
  if (UI) return UI;
  globalThis.document = doc; globalThis.Node = FakeNode;
  globalThis.window = { addEventListener() {}, location: { hash: '', href: 'https://x/', protocol: 'https:' }, history: { pushState() {}, replaceState() {}, state: null }, matchMedia: () => ({ matches: false }), scrollTo() {}, top: null, self: null };
  globalThis.window.top = globalThis.window; globalThis.window.self = globalThis.window;
  const code = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const tail = '  boot();\n})();';
  assert.ok(code.trimEnd().endsWith(tail.trim()), 'app.js ends with boot()');
  const at = code.lastIndexOf('  boot();');
  // app.js starts an idle check with setInterval; unref it so the test process can end.
  const realSI = globalThis.setInterval;
  globalThis.setInterval = (f, ms) => { const id = realSI(f, ms); if (id && id.unref) id.unref(); return id; };
  try {
    vm.runInThisContext(code.slice(0, at) + '  globalThis.__lifeosUI = { countriesScreen: countriesScreen, assetsScreen: assetsScreen, adminScreen: adminScreen, setView: function (v) { view = v; } };\n})();');
  } finally { globalThis.setInterval = realSI; }
  UI = globalThis.__lifeosUI;
  return UI;
}
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { P.close(); } catch (e) { /* closed */ } try { S.lock(); } catch (e) { /* locked */ } S._setAdapter(NOSTORE); realKeys(); } });
async function vault(state) { S._setAdapter(memAdapter()); S.lock(); await S.init(PASS); if (state) await S.replaceState(state); }
function world() {
  const s = S.defaultState(), d = new Date(), today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'), year = d.getFullYear();
  s.accounts.push(
    { id: 'us1', name: 'Checking', kind: 'cash', liability: false, archived: false, country: 'US', currency: 'USD' },
    { id: 'es1', name: 'Banco', kind: 'cash', liability: false, archived: false, country: 'ES', currency: 'EUR' });
  s.entries.push(
    E({ domain: 'assets', type: 'balance', date: today, title: 'Checking', value: 10000, accountId: 'us1' }),
    E({ domain: 'assets', type: 'balance', date: today, title: 'Banco', value: 5000, accountId: 'es1' }));
  const v = S.validateState(s);
  C.addRecord(v, { country: 'ES', year, kind: 'paid', title: 'IRPF quarterly', amount: '1200', currency: 'EUR', date: today });
  C.setProfile(v, 'ES', year, { residency: 'resident', days: '190', filingDue: '', note: '' });
  v.taxItems.push({ id: 't1', year, title: 'Modelo 100', state: 'needed', dueDate: '', country: 'ES' });
  return S.validateState(v);
}
const text = (n) => n.textContent;

test('By country, all countries: each country in its own currency, and no combined total until a rate is typed', async () => {
  const ui = loadUI(); await vault(world());
  ui.setView({ name: 'countries' });
  let out = ui.countriesScreen(S.getState());
  const t = text(out);
  assert.match(t, /Taxes and assets by country/);
  assert.match(t, /United States/); assert.match(t, /Spain/);
  assert.ok(t.includes('$10,000.00'), t.slice(0, 400)); assert.ok(t.includes('€5,000.00'));
  assert.match(t, /No combined total in USD yet: enter an exchange rate for EUR below\./);
  assert.match(t, /LifeOS never looks rates up/); assert.match(t, /Not tax advice/);
  assert.equal(out.getAttribute('data-view'), 'all');
  await S.commit((x) => { C.setRate(x, 'EUR', '1.08', '2026-11-20'); }, 'exchange rate');
  out = ui.countriesScreen(S.getState());
  assert.match(text(out), /Combined in USD: \$15,400\.00\. At your rate: 1 EUR = 1\.08 USD \(2026-11-20\)\./);
});

test('By country, Spain: accounts, the tax-year profile, tax amounts and the checklist count; no US estimates', async () => {
  const ui = loadUI(); await vault(world());
  ui.setView({ name: 'countries', country: 'ES' });
  const out = ui.countriesScreen(S.getState()), t = text(out);
  assert.equal(out.getAttribute('data-view'), 'ES');
  assert.match(t, /Accounts in Spain \(1\)/); assert.match(t, /Banco/);
  assert.match(t, /Residency: Tax resident\./); assert.match(t, /Days in Spain: 190\./);
  assert.match(t, /IRPF quarterly/); assert.ok(t.includes('€1,200.00'));
  assert.match(t, /1 of 1 item is not done yet\./);
  assert.ok(!/Estimated federal and NJ/.test(t), 'no US estimates under Spain');
  ui.setView({ name: 'countries', country: 'US' });
  assert.match(text(ui.countriesScreen(S.getState())), /Estimated federal and NJ payments logged/);
});

test('Assets: a balance in euros shows in euros, is left out of the totals and says so; Admin offers a country for tax items', async () => {
  const ui = loadUI(); await vault(world());
  ui.setView({ name: 'domain', domain: 'assets' });
  const a = ui.assetsScreen(S.getState()), t = text(a);
  assert.ok(t.includes('€5,000.00'), 'the euro balance in euros');
  assert.match(t, /1 account in EUR is not in these totals\. Enter an exchange rate to include it\./);
  assert.ok(a.find((n) => n.id === 'aw-by-country'));
  assert.ok(a.find((n) => n.id === 'ac-country') && a.find((n) => n.id === 'ac-currency'));
  ui.setView({ name: 'domain', domain: 'admin' });
  const ad = ui.adminScreen(S.getState());
  assert.ok(ad.find((n) => n.id === 'tx-country'));
  assert.match(text(ad), /needed \| Spain/);
});
