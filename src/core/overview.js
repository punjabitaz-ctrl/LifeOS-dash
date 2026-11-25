(function () {
  'use strict';
  // v2.3.0: the Overview, a single pane of glass. The owner picks which key numbers and which shortcuts sit at the top of the Overview
  // (the screen that was called Dashboard). Choices live in settings.overview = { custom, metrics, shortcuts }: while custom is false the
  // defaults apply, so a later build can improve the defaults for anyone who never changed them. Ids are whitelisted; unknown ids and
  // repeats are dropped, so a choice saved by a newer build never breaks an older list. Wellbeing has no key number: it stays inside the
  // private vault and never appears on the Overview strip.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const CAP = 12;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const fail = (m) => { throw new Error('Invalid data: ' + m); };
  const m = (id, label, key) => Object.freeze({ id, label, key });
  // Each key number: id, the area name shown above it, and the view key a tap opens.
  const METRICS = Object.freeze([
    m('money', 'Money', 'v:money'), m('assets', 'Assets', 'v:assets'), m('work', 'Work', 'v:work'), m('health', 'Health', 'v:health'),
    m('activities', 'Activities', 'v:activities'), m('social', 'Social', 'v:social'), m('learning', 'Learning', 'v:learning'),
    m('home', 'Home and property', 'v:home'), m('admin', 'Admin', 'v:admin'), m('goals', 'Goals', 'v:goals'),
    m('rev-month', 'Revenue', 'v:command'), m('net-month', 'Net income', 'v:command'), m('expected-30', 'Expected income', 'v:command'),
    m('jobs-week', 'Job search', 'v:jobs'), m('upcoming', 'Next 30 days', 'v:activities'), m('streak', 'Weekly review', 'review'),
  ]);
  const BY_ID = new Map(METRICS.map((x) => [x.id, x]));
  const HEADLINE = new Set(['money', 'assets', 'work', 'health', 'activities', 'social', 'learning', 'home', 'admin', 'goals']);
  // Shortcuts: every area of the app except the Overview itself, in the More sheet's order after the bar's.
  const shortcutKeys = () => (L.nav ? L.nav.BAR.concat(L.nav.MORE).map((x) => x.key).filter((k) => k !== 'dashboard') : []);
  const shortcutLabel = (k) => { const x = L.nav ? L.nav.BAR.concat(L.nav.MORE).find((y) => y.key === k) : null; return x ? x.label : ''; };
  const DEFAULT_METRICS = Object.freeze(['money', 'assets', 'rev-month', 'work', 'health', 'learning', 'goals', 'upcoming']);
  const DEFAULT_SHORTCUTS = Object.freeze(['v:money', 'v:work', 'v:jobs', 'v:health', 'v:learning', 'v:goals', 'review']);
  const defaultSettings = () => ({ custom: false, metrics: [], shortcuts: [] });

  function cleanList(list, ok, what) {
    if (!Array.isArray(list)) fail(what + ' must be a list');
    if (list.length > CAP * 4) fail(what + ' has too many items');
    const seen = new Set(), out = [];
    for (const x of list) {
      if (typeof x !== 'string' || x.length > 40) fail(what + ' item');
      if (!ok(x) || seen.has(x)) continue;
      seen.add(x); out.push(x);
      if (out.length >= CAP) break;
    }
    return out;
  }
  const okMetric = (x) => BY_ID.has(x), okShortcut = (x) => shortcutKeys().includes(x);
  // Saved settings to clean settings. Missing (an older vault) gives the defaults.
  function cleanSettings(x) {
    if (x === undefined || x === null) return defaultSettings();
    if (!isObj(x)) fail('overview');
    if (typeof x.custom !== 'boolean') fail('overview custom');
    return { custom: x.custom, metrics: cleanList(x.metrics, okMetric, 'overview metrics'), shortcuts: cleanList(x.shortcuts, okShortcut, 'overview shortcuts') };
  }
  const cur = (settings) => (settings && isObj(settings.overview) && settings.overview.custom === true ? settings.overview : null);
  const metrics = (settings) => { const c = cur(settings); return c ? cleanList(c.metrics, okMetric, 'overview metrics') : DEFAULT_METRICS.slice(); };
  const shortcuts = (settings) => { const c = cur(settings); return c ? cleanList(c.shortcuts, okShortcut, 'overview shortcuts') : DEFAULT_SHORTCUTS.slice(); };
  // Mutators for the settings object inside a commit. Saving either list stores both, so the other keeps what was on screen.
  function save(settings, ms, ss) {
    settings.overview = { custom: true, metrics: cleanList(ms, okMetric, 'overview metrics'), shortcuts: cleanList(ss, okShortcut, 'overview shortcuts') };
    return settings.overview;
  }
  const reset = (settings) => { settings.overview = defaultSettings(); return settings.overview; };
  // List helpers for the picker (pure; return new lists).
  function toggle(list, id, on) {
    const out = list.filter((x) => x !== id);
    if (on) { if (out.length >= CAP) return list.slice(); out.push(id); }
    return out;
  }
  function move(list, id, delta) {
    const out = list.slice(), i = out.indexOf(id);
    if (i < 0) return out;
    const t = Math.max(0, Math.min(out.length - 1, i + Math.trunc(Number(delta) || 0)));
    out.splice(i, 1); out.splice(t, 0, id);
    return out;
  }

  // One key number for the strip: { id, area, label, display, sub, key }. A number that cannot be worked out shows a dash instead of
  // breaking the Overview. state is what the screen shows (private records merged in while the private vault is open).
  function value(state, id, today) {
    const d = BY_ID.get(id);
    if (!d) throw new Error('Unknown key number');
    const M = L.metrics, cur = state.settings.currency, money = (c) => M.fmtMoney(c / 100, cur);
    const R = (label, display, sub) => ({ id, area: d.label, label, display, sub: sub || '', key: d.key });
    try {
      if (HEADLINE.has(id)) { const x = M.headline(state, id, today); return R(x.label, x.display, x.sub); }
      switch (id) {
        case 'rev-month': case 'net-month': {
          const t = L.revenue.totalsIn(state, { kind: 'all' }, today.slice(0, 7) + '-01', M.monthEnd(today.slice(0, 7)));
          return id === 'rev-month' ? R('Received this month', money(t.revenueCents), 'Expenses ' + money(t.expenseCents))
            : R('Net this month', money(t.netCents), money(t.revenueCents) + ' in, ' + money(t.expenseCents) + ' out');
        }
        case 'expected-30': {
          const x = L.revenue.expected(state, { kind: 'all' }, today);
          return R('Expected in the next 30 days', money(x.next30Cents), x.overdueCount + ' overdue (' + money(x.overdueCents) + ')');
        }
        case 'jobs-week': {
          const w = L.jobs.weekly(state, today);
          return R('Applications this week', String(w.applications), w.interviews + (w.interviews === 1 ? ' interview, ' : ' interviews, ') + w.followUpsDue + ' follow-ups due');
        }
        case 'upcoming': {
          const g = L.activities.glance(state, today);
          return R('Items in the next 30 days', String(g.count), g.today.length + ' today, ' + g.week.length + ' this week');
        }
        case 'streak': {
          const n = L.memory.reviewStreak(state, today);
          return R('Review streak', n + (n === 1 ? ' week' : ' weeks'), 'Weeks in a row with a review');
        }
      }
    } catch (e) { /* fall through to the dash */ }
    return R(d.label, '-', '');
  }

  L.overview = {
    CAP, METRICS, DEFAULT_METRICS, DEFAULT_SHORTCUTS, shortcutKeys, shortcutLabel, defaultSettings, cleanSettings, metrics, shortcuts, save, reset, toggle, move, value,
    label: (id) => (BY_ID.has(id) ? BY_ID.get(id).label : ''),
  };
})();
