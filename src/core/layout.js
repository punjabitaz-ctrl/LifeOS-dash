(function () {
  'use strict';
  // v0.12.0: customizable home. A layout is a list of { id, size, hidden } kept per viewport class in settings.layouts
  // ({ narrow, wide }; narrow is a viewport under 720 px). Ids are whitelisted: unknown ids are dropped, modules a saved layout does
  // not mention are appended (visible) at the end, so modules added by later builds appear without breaking saved layouts.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const NARROW_MAX = 720, LIST_CAP = 64;
  const SIZES = Object.freeze(['small', 'wide']);
  const mod = (id, label, sizes, size) => Object.freeze({ id, label, sizes: Object.freeze(sizes), size });
  const TILE_DOMAINS = [['money', 'Money'], ['assets', 'Assets'], ['work', 'Work'], ['health', 'Health'], ['activities', 'Activities'], ['social', 'Social'], ['learning', 'Learning'], ['home', 'Home'], ['admin', 'Admin'], ['goals', 'Goals'], ['wellbeing', 'Wellbeing']];
  // The default order is the order the dashboard had before: at a glance, priorities, the domain tiles; then the revenue modules.
  const MODULES = Object.freeze([
    mod('glance', 'At a glance', ['wide'], 'wide'),
    mod('priorities', 'Priorities', ['small', 'wide'], 'wide'),
  ].concat(
    TILE_DOMAINS.map((d) => mod('tile-' + d[0], d[1], ['small', 'wide'], 'small')),
    [mod('rev-month', 'Revenue this month', ['small', 'wide'], 'small'), mod('rev-net-line', 'Net by line of work', ['wide', 'small'], 'wide'), mod('rev-expected', 'Expected and overdue income', ['small', 'wide'], 'small'),
      // v1.1.0 business modules
      mod('tax-setaside', 'Tax set-aside vs reserve', ['small', 'wide'], 'small'), mod('tax-next', 'Next estimated payment due', ['small', 'wide'], 'small'),
      mod('inv-open', 'Open invoices and aging', ['small', 'wide'], 'small'), mod('budget-pinned', 'Budget vs actual (pinned line)', ['small', 'wide'], 'small'),
      mod('payees-near', '1099 payees near the threshold', ['small', 'wide'], 'small')]
  ));
  const BY_ID = new Map(MODULES.map((m) => [m.id, m]));
  const KEYS = Object.freeze(['narrow', 'wide']);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const fail = (m) => { throw new Error('Invalid data: ' + m); };

  // Saved list to a clean saved list: unknown ids and repeats dropped, size and hidden checked. A size the module does not support
  // becomes the module's own default size.
  function clean(list) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) fail('layout must be a list');
    if (list.length > LIST_CAP) fail('layout has too many items');
    const seen = new Set(), out = [];
    for (const x of list) {
      if (!isObj(x)) fail('layout item');
      if (typeof x.id !== 'string' || x.id.length > 60) fail('layout id');
      if (!SIZES.includes(x.size)) fail('layout size');
      if (typeof x.hidden !== 'boolean') fail('layout hidden');
      const m = BY_ID.get(x.id);
      if (!m || seen.has(x.id)) continue;
      seen.add(x.id);
      out.push({ id: x.id, size: m.sizes.includes(x.size) ? x.size : m.size, hidden: x.hidden });
    }
    return out;
  }
  function cleanLayouts(x) {
    if (x === undefined || x === null) return { narrow: [], wide: [] };
    if (!isObj(x)) fail('layouts');
    return { narrow: clean(x.narrow), wide: clean(x.wide) };
  }
  const defaultList = () => MODULES.map((m) => ({ id: m.id, size: m.size, hidden: false }));
  // The full ordered list to draw: the saved order, then any module the saved list lacks.
  function resolve(saved) {
    let list;
    try { list = clean(saved); } catch (e) { list = []; }
    const have = new Set(list.map((x) => x.id));
    for (const m of MODULES) if (!have.has(m.id)) list.push({ id: m.id, size: m.size, hidden: false });
    return list;
  }
  const which = (width) => (Number(width) < NARROW_MAX ? 'narrow' : 'wide');
  // v1.4.0 B10: on a narrow screen the business and tax modules start hidden and appear once a tax profile exists. This applies only
  // while no layout has been saved for that width: a saved layout always wins. ctx = { state } switches the defaults on.
  const BUSINESS = Object.freeze(['tax-setaside', 'tax-next', 'inv-open', 'budget-pinned', 'payees-near']);
  const hasTaxProfile = (state) => !!state && isObj(state.taxYears) && Object.keys(state.taxYears).length > 0;
  function get(settings, w, ctx) {
    const ls = settings && settings.layouts;
    const saved = ls && Array.isArray(ls[w === 'narrow' ? 'narrow' : 'wide']) ? ls[w === 'narrow' ? 'narrow' : 'wide'] : [];
    const list = resolve(saved);
    if (ctx && w === 'narrow' && saved.length === 0 && !hasTaxProfile(ctx.state)) return list.map((x) => (BUSINESS.includes(x.id) ? Object.assign({}, x, { hidden: true }) : x));
    return list;
  }
  // v1.4.0 B10: true when a module has nothing to show yet, so a narrow screen can draw it as one line.
  const has = (a) => Array.isArray(a) && a.length > 0;
  const entriesOf = (s, d) => (Array.isArray(s.entries) ? s.entries : []).some((e) => e && e.domain === d);
  function isEmpty(s, id) {
    if (!isObj(s)) return false;
    switch (id) {
      case 'tile-money': return !entriesOf(s, 'money') && !has(s.recurring) && !has(s.budgets);
      case 'tile-assets': return !entriesOf(s, 'assets') && !has(s.accounts);
      case 'tile-work': return !entriesOf(s, 'work') && !has(s.projects) && !has(s.pipeline);
      case 'tile-health': return !entriesOf(s, 'health') && !has(s.habits) && !s.cycle && !has(s.activities);
      case 'tile-activities': return !entriesOf(s, 'activities') && !has(s.activities);
      case 'tile-social': return !entriesOf(s, 'social') && !has(s.people) && !has(s.contacts) && !has(s.groups);
      case 'tile-learning': return !entriesOf(s, 'learning') && !has(s.learningItems) && !has(s.studySessions);
      case 'tile-home': return !entriesOf(s, 'home') && !has(s.properties) && !has(s.vehicles) && !has(s.maintenance);
      case 'tile-admin': return !has(s.renewals) && !has(s.documents) && !has(s.taxItems);
      case 'tile-goals': return !entriesOf(s, 'goals') && !has(s.goals);
      case 'rev-month': case 'rev-net-line': case 'rev-expected': return !entriesOf(s, 'money');
      default: return false;
    }
  }
  // Mutator for the settings object inside a commit: stores the full list for one viewport class and touches nothing else.
  function set(settings, w, list) {
    if (!KEYS.includes(w)) throw new Error('Unknown layout');
    if (!isObj(settings.layouts)) settings.layouts = { narrow: [], wide: [] };
    settings.layouts[w] = resolve(list);
    return settings.layouts[w];
  }
  const reset = (settings, w) => {
    if (!KEYS.includes(w)) throw new Error('Unknown layout');
    if (!isObj(settings.layouts)) settings.layouts = { narrow: [], wide: [] };
    settings.layouts[w] = [];
  };
  const idx = (list, id) => list.findIndex((x) => x.id === id);
  function moveTo(list, id, to) {
    const out = list.map((x) => Object.assign({}, x)), i = idx(out, id);
    if (i < 0) return out;
    const t = Math.max(0, Math.min(out.length - 1, Math.floor(Number(to)) || 0));
    const [it] = out.splice(i, 1);
    out.splice(t, 0, it);
    return out;
  }
  const move = (list, id, delta) => { const i = idx(list, id); return i < 0 ? list.map((x) => Object.assign({}, x)) : moveTo(list, id, i + delta); };
  const setHidden = (list, id, hidden) => list.map((x) => Object.assign({}, x, x.id === id ? { hidden: !!hidden } : {}));
  function setSize(list, id, size) {
    const m = BY_ID.get(id);
    if (!m || !m.sizes.includes(size)) return list.map((x) => Object.assign({}, x));
    return list.map((x) => Object.assign({}, x, x.id === id ? { size } : {}));
  }

  L.layout = { BUSINESS, hasTaxProfile, isEmpty, MODULES, SIZES, NARROW_MAX, LIST_CAP, clean, cleanLayouts, defaultList, resolve, which, get, set, reset, move, moveTo, setHidden, setSize, label: (id) => (BY_ID.has(id) ? BY_ID.get(id).label : '') };
})();
