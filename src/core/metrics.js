(function () {
  'use strict';
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});

  const num = (id, label, o) => Object.assign({ id, label, kind: 'number', required: true }, o);
  const sel = (id, label, options) => ({ id, label, kind: 'select', required: false, options, default: options[0] });
  const txt = (id, label) => ({ id, label, kind: 'text', required: true });
  const dt = (id, label) => ({ id, label, kind: 'date', required: true });
  const T = (id, label, fields) => ({ id, label, fields: fields || [] });
  const DOMAINS = [
    { id: 'money', label: 'Money', types: [
      T('income', 'Income', [num('value', 'Amount', { min: 0, max: 1e12 })]),
      T('expense', 'Expense', [num('value', 'Amount', { min: 0, max: 1e12 })])] },
    { id: 'assets', label: 'Assets', types: [T('balance', 'Balance', [num('value', 'Balance (negative for a liability)', { min: -1e12, max: 1e12 })])] },
    { id: 'work', label: 'Work', types: [T('outcome', 'Outcome', [sel('status', 'Status', ['todo', 'done'])])] },
    { id: 'health', label: 'Health', types: [
      T('workout', 'Workout'),
      T('sleep', 'Sleep', [num('value', 'Hours', { min: 0, max: 24 })]),
      T('weight', 'Weight', [num('value', 'Weight', { min: 0, max: 1000 })])] },
    { id: 'activities', label: 'Activities', types: [T('session', 'Session')] },
    { id: 'social', label: 'Social', types: [T('contact', 'Contact', [txt('person', 'Person')])] },
    { id: 'learning', label: 'Learning', types: [
      T('item', 'Item', [sel('status', 'Status', ['active', 'done'])]),
      T('hours', 'Hours', [num('value', 'Hours', { min: 0, max: 1000 })])] },
    { id: 'home', label: 'Home', types: [T('due', 'Due item', [dt('due', 'Due date'), sel('status', 'Status', ['open', 'done'])])] },
    { id: 'goals', label: 'Goals', types: [T('goal', 'Goal', [sel('status', 'Status', ['on-track', 'at-risk', 'off-track', 'done'])])] },
    { id: 'wellbeing', label: 'Wellbeing', types: [T('mood', 'Mood', [num('value', 'Mood (1 to 5)', { min: 1, max: 5 })])] },
  ];
  (function freeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(freeze); } })(DOMAINS);

  // ---- dates ----
  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s) || s < '1900-01-01' || s > '2200-12-31') return false;
    const t = Date.parse(s + 'T00:00:00Z');
    return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
  }
  const ms = (s) => Date.parse(s + 'T00:00:00Z');
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const addDays = (s, n) => iso(ms(s) + n * 864e5);
  const daysBetween = (a, b) => Math.round((ms(a) - ms(b)) / 864e5);
  function weekStart(d) {
    if (!isDate(d)) throw new Error('Invalid date');
    return addDays(d, -((new Date(ms(d)).getUTCDay() + 6) % 7));
  }
  const todayISO = () => new Date().toISOString().slice(0, 10);

  // ---- entries ----
  const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;
  const isEmpty = (v) => v === undefined || v === null || v === '';
  function validateEntry(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Entry must be an object');
    const dom = DOMAINS.find((d) => d.id === p.domain);
    if (!dom) throw new Error('Unknown domain');
    const ty = dom.types.find((t) => t.id === p.type);
    if (!ty) throw new Error('Unknown entry type');
    if (!isDate(p.date)) throw new Error('Date must be a valid date (YYYY-MM-DD)');
    if (typeof p.title !== 'string' || !p.title.trim()) throw new Error('Title is required');
    const title = p.title.trim();
    if (title.length > 200) throw new Error('Title must be 200 characters or fewer');
    let id = p.id;
    if (isEmpty(id)) id = L._webcrypto.randomUUID();
    if (typeof id !== 'string' || !id || id.length > 100) throw new Error('Invalid id');
    const out = { id, domain: dom.id, type: ty.id, date: p.date, title };
    for (const f of ty.fields) {
      const raw = p[f.id];
      if (isEmpty(raw)) {
        if (f.kind === 'select') { out[f.id] = f.default; continue; }
        if (f.required) throw new Error(f.label + ' is required');
        continue;
      }
      if (f.kind === 'number') {
        const v = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.length <= 64 && NUM_RE.test(raw.trim()) ? Number(raw) : NaN);
        if (!isFinite(v) || v < f.min || v > f.max) throw new Error(f.label + ' must be a number between ' + f.min + ' and ' + f.max);
        out[f.id] = v;
      } else if (f.kind === 'text') {
        if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 200) throw new Error(f.label + ' must be 1 to 200 characters');
        out[f.id] = raw.trim();
      } else if (f.kind === 'date') {
        if (!isDate(raw)) throw new Error(f.label + ' must be a valid date');
        out[f.id] = raw;
      } else if (f.kind === 'select') {
        if (!f.options.includes(raw)) throw new Error(f.label + ' must be one of ' + f.options.join(', '));
        out[f.id] = raw;
      }
    }
    if (!isEmpty(p.notes)) {
      if (typeof p.notes !== 'string') throw new Error('Notes must be text');
      const n = p.notes.trim();
      if (n.length > 2000) throw new Error('Notes must be 2000 characters or fewer');
      if (n) out.notes = n;
    }
    const ca = p.createdAt;
    out.createdAt = (typeof ca === 'string' && ca.length <= 40 && ca) || (typeof ca === 'number' && isFinite(ca) && ca) || new Date().toISOString();
    return out;
  }

  // ---- calculations ----
  const r1 = (x) => Math.round(x * 10) / 10;
  const r2 = (x) => Math.round(x * 100) / 100;
  const inR = (e, a, b) => e.date >= a && e.date <= b;
  function savings(ents, a, b) {
    let inc = 0, exp = 0;
    for (const e of ents) if (inR(e, a, b)) { if (e.type === 'income') inc += e.value; else if (e.type === 'expense') exp += e.value; }
    return { inc, exp, rate: inc > 0 ? (inc - exp) / inc : null };
  }
  function netWorth(ents, asOf) {
    const m = new Map();
    for (const e of ents) {
      if (e.type !== 'balance' || e.date > asOf) continue;
      const k = e.title.trim().toLowerCase(), cur = m.get(k);
      if (!cur || e.date >= cur.date) m.set(k, e);
    }
    let total = 0;
    for (const e of m.values()) total += e.value;
    return { total, count: m.size };
  }
  function overdue(ents, asOf, days) {
    const last = new Map();
    for (const e of ents) {
      if (e.type !== 'contact' || e.date > asOf) continue;
      const k = e.person.toLowerCase();
      if (!last.has(k) || e.date > last.get(k)) last.set(k, e.date);
    }
    let n = 0;
    for (const d of last.values()) if (daysBetween(asOf, d) > days) n++;
    return { n, total: last.size };
  }
  function goals(ents, asOf) {
    const m = new Map();
    for (const e of ents) {
      if (e.type !== 'goal' || e.date > asOf) continue;
      const k = e.title.trim().toLowerCase(), cur = m.get(k);
      if (!cur || e.date >= cur.date) m.set(k, e);
    }
    let active = 0, on = 0;
    for (const e of m.values()) if (e.status !== 'done') { active++; if (e.status === 'on-track') on++; }
    return { active, on, share: active ? on / active : null };
  }
  function dueSoon(ents, from, days) {
    const end = addDays(from, days);
    let soon = 0, late = 0;
    for (const e of ents) {
      if (e.type !== 'due' || e.status === 'done') continue;
      if (e.due < from) late++; else if (e.due <= end) soon++;
    }
    return { soon, late };
  }
  const count = (ents, a, b, f) => { let n = 0; for (const e of ents) if (inR(e, a, b) && f(e)) n++; return n; };
  function avgMood(ents, a, b) {
    let s = 0, n = 0;
    for (const e of ents) if (e.type === 'mood' && inR(e, a, b)) { s += e.value; n++; }
    return { n, avg: n ? s / n : null };
  }
  function activeDays(ents, a, b) {
    const s = new Set();
    for (const e of ents) if (e.type === 'session' && inR(e, a, b)) s.add(e.date);
    return s.size;
  }

  const UNITS = { money: '%', work: 'outcomes', health: 'workouts', activities: 'days', social: 'people', learning: 'items', home: 'items', goals: '%', wellbeing: 'score' };
  function weekMetric(state, id, ws, ents) {
    const we = addDays(ws, 6);
    const tg = state.settings.targets;
    switch (id) {
      case 'money': { const s = savings(ents, ws, we); return s.rate === null ? 0 : s.rate * 100; }
      case 'assets': return netWorth(ents, we).total;
      case 'work': return count(ents, ws, we, (e) => e.type === 'outcome' && e.status === 'done');
      case 'health': return count(ents, ws, we, (e) => e.type === 'workout');
      case 'activities': return activeDays(ents, ws, we);
      case 'social': return overdue(ents, we, tg.contactDays).n;
      case 'learning': return count(ents, ws, we, (e) => e.type === 'item' && e.status === 'done');
      case 'home': return dueSoon(ents, we, 30).soon;
      case 'goals': { const g = goals(ents, we); return g.share === null ? 0 : g.share * 100; }
      case 'wellbeing': { const m = avgMood(ents, ws, we); return m.avg === null ? 0 : m.avg; }
    }
    throw new Error('Unknown domain');
  }
  const unitOf = (state, id) => (id === 'assets' ? state.settings.currency : UNITS[id]);
  const byDomain = (state, id) => state.entries.filter((e) => e.domain === id);

  function weeklyDigest(state, weekStartISO) {
    const ws = weekStart(weekStartISO), pw = addDays(ws, -7);
    const domains = {};
    for (const d of DOMAINS) {
      const ents = byDomain(state, d.id);
      domains[d.id] = { now: r2(weekMetric(state, d.id, ws, ents)), prev: r2(weekMetric(state, d.id, pw, ents)), unit: unitOf(state, d.id) };
    }
    return { week: ws, domains };
  }
  function series(state, domainId, n, today) {
    if (!DOMAINS.some((d) => d.id === domainId)) throw new Error('Unknown domain');
    n = Math.max(1, Math.min(104, Math.floor(Number(n)) || 1));
    const cur = weekStart(isDate(today) ? today : todayISO());
    const ents = byDomain(state, domainId), out = [];
    for (let i = n - 1; i >= 0; i--) {
      const ws = addDays(cur, -7 * i);
      out.push({ label: ws, value: r2(weekMetric(state, domainId, ws, ents)) });
    }
    return out;
  }

  function fmtMoney(n, cur) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0 }).format(n); }
    catch (e) { return String(Math.round(n)); }
  }
  function headline(state, id, today) {
    if (!DOMAINS.some((d) => d.id === id)) throw new Error('Unknown domain');
    if (!isDate(today)) throw new Error('today must be YYYY-MM-DD');
    const ents = byDomain(state, id), st = state.settings, tg = st.targets;
    const ws = weekStart(today), we = addDays(ws, 6), mon = today.slice(0, 7);
    const R = (label, display, value, sub) => ({ label, display, value, sub });
    switch (id) {
      case 'money': {
        const s = savings(ents, mon + '-01', mon + '-31');
        const v = s.rate === null ? 0 : r1(s.rate * 100);
        return R('Savings rate this month', s.rate === null ? 'n/a' : v + '%', v,
          fmtMoney(s.inc, st.currency) + ' in, ' + fmtMoney(s.exp, st.currency) + ' out. Target ' + Math.round(tg.savingsRate * 100) + '%');
      }
      case 'assets': {
        const w = netWorth(ents, today);
        return R('Net worth', fmtMoney(w.total, st.currency), w.total, w.count + (w.count === 1 ? ' account' : ' accounts'));
      }
      case 'work': {
        const total = count(ents, ws, we, (e) => e.type === 'outcome');
        const done = count(ents, ws, we, (e) => e.type === 'outcome' && e.status === 'done');
        return R('Outcomes done this week', done + ' of ' + total, done, total ? Math.round(done / total * 100) + '% complete' : 'No outcomes set this week');
      }
      case 'health': {
        const n = count(ents, ws, we, (e) => e.type === 'workout');
        return R('Workouts this week', n + ' of ' + tg.workoutsPerWeek, n, n >= tg.workoutsPerWeek ? 'Target met' : (tg.workoutsPerWeek - n) + ' to go');
      }
      case 'activities': {
        const d = activeDays(ents, ws, we), s = count(ents, ws, we, (e) => e.type === 'session');
        return R('Active days this week', String(d), d, s + (s === 1 ? ' session' : ' sessions'));
      }
      case 'social': {
        const o = overdue(ents, today, tg.contactDays);
        return R('People overdue', String(o.n), o.n, o.total + ' tracked, over ' + tg.contactDays + ' days since contact');
      }
      case 'learning': {
        const n = count(ents, mon + '-01', mon + '-31', (e) => e.type === 'item' && e.status === 'done');
        let h = 0;
        for (const e of ents) if (e.type === 'hours' && e.date.slice(0, 7) === mon) h += e.value;
        return R('Items finished this month', String(n), n, r1(h) + ' hours logged');
      }
      case 'home': {
        const d = dueSoon(ents, today, 30);
        return R('Due within 30 days', String(d.soon), d.soon, d.late ? d.late + ' overdue' : 'Nothing overdue');
      }
      case 'goals': {
        const g = goals(ents, today);
        const v = g.share === null ? 0 : Math.round(g.share * 100);
        return R('Goals on track', g.share === null ? 'n/a' : v + '%', v, g.on + ' of ' + g.active + ' active goals');
      }
      case 'wellbeing': {
        const m = avgMood(ents, addDays(today, -6), today);
        const v = m.avg === null ? 0 : r2(m.avg);
        return R('Mood, 7-day average', m.avg === null ? 'n/a' : v.toFixed(1), v, m.n + (m.n === 1 ? ' entry' : ' entries'));
      }
    }
  }

  L.metrics = { DOMAINS, isDate, addDays, validateEntry, headline, weekStart, weeklyDigest, series, fmtMoney };
  L.DOMAINS = DOMAINS;
})();
