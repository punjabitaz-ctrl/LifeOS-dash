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
      T('workout', 'Workout', [
        { id: 'kind', label: 'Type', kind: 'text', required: false, max: 40 },
        num('minutes', 'Minutes', { min: 0, max: 1440, required: false }),
        num('effort', 'Effort (1 to 10)', { min: 1, max: 10, int: true, required: false })]),
      T('sleep', 'Sleep', [num('value', 'Hours', { min: 0, max: 24 })]),
      T('weight', 'Weight', [num('value', 'Weight', { min: 0, max: 1000 })]),
      T('bodyfat', 'Body fat', [num('value', 'Body fat %', { min: 0, max: 100 })])] },
    { id: 'activities', label: 'Activities', types: [T('session', 'Session')] },
    { id: 'social', label: 'Social', types: [T('contact', 'Contact', [txt('person', 'Person')])] },
    { id: 'learning', label: 'Learning', types: [
      T('item', 'Item', [sel('status', 'Status', ['active', 'done'])]),
      T('hours', 'Hours', [num('value', 'Hours', { min: 0, max: 1000 })])] },
    { id: 'home', label: 'Home', types: [T('due', 'Due item', [dt('due', 'Due date'), sel('status', 'Status', ['open', 'done'])])] },
    // Admin (schema 6) keeps its data in state.renewals, documents and taxItems; it has no typed entries of its own.
    { id: 'admin', label: 'Admin', types: [] },
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
  // Dates are local calendar days: use the device's local date, never the UTC one.
  const todayISO = () => { const d = new Date(); return String(d.getFullYear()).padStart(4, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

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
        if (!isFinite(v) || v < f.min || v > f.max || (f.int && !Number.isInteger(v))) throw new Error(f.label + ' must be a number between ' + f.min + ' and ' + f.max);
        out[f.id] = v;
      } else if (f.kind === 'text') {
        const mx = f.max || 200;
        if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > mx) throw new Error(f.label + ' must be 1 to ' + mx + ' characters');
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
    if (dom.id === 'money' && !isEmpty(p.category)) {
      if (typeof p.category !== 'string' || !p.category.trim() || p.category.trim().length > 40) throw new Error('Category must be 1 to 40 characters');
      out.category = p.category.trim();
    }
    if (ty.id === 'balance' && !isEmpty(p.accountId)) {
      if (typeof p.accountId !== 'string' || !p.accountId || p.accountId.length > 100) throw new Error('Invalid account');
      out.accountId = p.accountId;
    }
    if (ty.id === 'outcome' && !isEmpty(p.projectId)) {
      if (typeof p.projectId !== 'string' || !p.projectId || p.projectId.length > 100) throw new Error('Invalid project');
      out.projectId = p.projectId;
    }
    const ca = p.createdAt;
    out.createdAt = (typeof ca === 'string' && ca.length <= 40 && ca) || (typeof ca === 'number' && isFinite(ca) && ca) || new Date().toISOString();
    return out;
  }

  // ---- calculations ----
  const r1 = (x) => Math.round(x * 10) / 10;
  const r2 = (x) => Math.round(x * 100) / 100;
  const inR = (e, a, b) => e.date >= a && e.date <= b;
  // ---- money maths: integer cents only ----
  const cents = (v) => Math.round(Number(v) * 100);
  const dollars = (c) => c / 100;
  const LIAB_KINDS = ['credit', 'loan', 'mortgage'];
  const ACCOUNT_KINDS = ['cash', 'investment', 'retirement', 'property', 'vehicle', 'other', 'credit', 'loan', 'mortgage'];
  const DEFAULT_CATEGORIES = {
    expense: ['Housing', 'Groceries', 'Dining', 'Transport', 'Utilities', 'Health', 'Shopping', 'Travel', 'Subscriptions', 'Other'],
    income: ['Salary', 'Business', 'Interest', 'Gift', 'Other']
  };
  const UNCAT = 'Uncategorised';
  const monthOf = (d) => d.slice(0, 7);
  const monthEnd = (m) => { const y = +m.slice(0, 4), mo = +m.slice(5, 7); return m + '-' + String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0'); };
  const addMonths = (m, k) => { const t = (+m.slice(0, 4)) * 12 + (+m.slice(5, 7) - 1) + k; return String(Math.floor(t / 12)).padStart(4, '0') + '-' + String(t % 12 + 1).padStart(2, '0'); };
  function sumMoney(ents, a, b) {
    let inc = 0, exp = 0;
    for (const e of ents) if (inR(e, a, b)) { if (e.type === 'income') inc += cents(e.value); else if (e.type === 'expense') exp += cents(e.value); }
    return { incC: inc, expC: exp };
  }
  function savings(ents, a, b) {
    const m = sumMoney(ents, a, b);
    return { inc: dollars(m.incC), exp: dollars(m.expC), rate: m.incC > 0 ? (m.incC - m.expC) / m.incC : null };
  }

  // Latest balance per account (non-archived), liabilities subtracted. Balance entries without a usable accountId
  // fall back to the account with the same name, then to an implicit account keyed by title (schema 1 behaviour).
  function netWorthDetail(state, asOf) {
    const accts = state.accounts || [];
    const byId = new Map(accts.map((x) => [x.id, x]));
    const byName = new Map();
    for (const x of accts) { const k = x.name.trim().toLowerCase(); if (!byName.has(k)) byName.set(k, x); }
    const latest = new Map();
    for (const e of state.entries) {
      if (e.type !== 'balance' || e.date > asOf) continue;
      let a = e.accountId ? byId.get(e.accountId) : null;
      if (!a) a = byName.get(e.title.trim().toLowerCase()) || null;
      const k = a ? 'a:' + a.id : 't:' + e.title.trim().toLowerCase();
      const cur = latest.get(k);
      if (!cur || e.date >= cur.e.date) latest.set(k, { e, a });
    }
    let assetsC = 0, liabC = 0, count = 0;
    const kinds = new Map(), rows = [];
    for (const { e, a } of latest.values()) {
      if (a && a.archived) continue;
      const v = cents(e.value);
      const liab = a ? a.liability : v < 0;
      const signed = a ? (a.liability ? -Math.abs(v) : v) : v;
      const kind = a ? a.kind : (v < 0 ? 'credit' : 'other');
      count++;
      if (liab) liabC += Math.abs(signed); else { assetsC += signed; if (signed > 0) kinds.set(kind, (kinds.get(kind) || 0) + signed); }
      rows.push({ id: a ? a.id : null, name: a ? a.name : e.title, kind, liability: liab, cents: signed, date: e.date });
    }
    const pos = [...kinds.values()].reduce((x, y) => x + y, 0);
    const byKind = [...kinds.entries()].map(([kind, c]) => ({ kind, cents: c, share: pos ? c / pos : 0 })).sort((x, y) => y.cents - x.cents);
    const totalC = assetsC - liabC;
    return { totalCents: totalC, assetsCents: assetsC, liabilitiesCents: liabC, total: dollars(totalC), assets: dollars(assetsC), liabilities: dollars(liabC), count, byKind, rows };
  }
  function netWorthHistory(state, n, today) {
    n = Math.max(1, Math.min(120, Math.floor(Number(n)) || 12));
    const t = isDate(today) ? today : todayISO(), cur = monthOf(t), out = [];
    for (let i = n - 1; i >= 0; i--) {
      const m = addMonths(cur, -i), asOf = i === 0 ? t : monthEnd(m);
      const d = netWorthDetail(state, asOf);
      out.push({ month: m, total: d.total, assets: d.assets, liabilities: d.liabilities, totalCents: d.totalCents, assetsCents: d.assetsCents, liabilitiesCents: d.liabilitiesCents });
    }
    return out;
  }
  function monthView(state, month) {
    if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month) || !isDate(month + '-01')) throw new Error('Month must be YYYY-MM');
    const ents = byDomain(state, 'money').filter((e) => monthOf(e.date) === month);
    let inc = 0, exp = 0;
    const spent = new Map();
    for (const e of ents) {
      const c = cents(e.value);
      if (e.type === 'income') inc += c;
      else if (e.type === 'expense') { exp += c; const k = e.category || UNCAT; spent.set(k, (spent.get(k) || 0) + c); }
    }
    const budgets = new Map((state.budgets || []).map((x) => [x.category, cents(x.value)]));
    const names = new Set([...spent.keys(), ...budgets.keys()]);
    let budgetC = 0, budgetedSpentC = 0;
    const rows = [...names].map((category) => {
      const sp = spent.get(category) || 0, bd = budgets.has(category) ? budgets.get(category) : null;
      if (bd !== null) { budgetC += bd; budgetedSpentC += sp; }
      return { category, spentCents: sp, budgetCents: bd, remainingCents: bd === null ? null : bd - sp, over: bd !== null && sp > bd };
    }).sort((x, y) => y.spentCents - x.spentCents || x.category.localeCompare(y.category));
    return {
      month, incomeCents: inc, spendCents: exp, netCents: inc - exp, income: dollars(inc), spend: dollars(exp), net: dollars(inc - exp),
      savingsRate: inc > 0 ? (inc - exp) / inc : null, categories: rows, budgetCents: budgetC, budgetedSpentCents: budgetedSpentC
    };
  }
  function cashflow(state, n, today) {
    n = Math.max(1, Math.min(60, Math.floor(Number(n)) || 6));
    const cur = monthOf(isDate(today) ? today : todayISO()), out = [];
    for (let i = n - 1; i >= 0; i--) {
      const v = monthView(state, addMonths(cur, -i));
      out.push({ month: v.month, incomeCents: v.incomeCents, spendCents: v.spendCents, netCents: v.netCents });
    }
    return out;
  }

  // ---- recurring: proposes only; the user confirms each item ----
  function advanceDate(d, cadence) {
    if (!isDate(d)) throw new Error('Invalid date');
    if (cadence === 'weekly') return addDays(d, 7);
    const y = +d.slice(0, 4), m = +d.slice(5, 7) - 1, day = +d.slice(8, 10);
    const t = y * 12 + m + (cadence === 'yearly' ? 12 : 1);
    const ny = Math.floor(t / 12), nm = t % 12;
    const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return String(ny).padStart(4, '0') + '-' + String(nm + 1).padStart(2, '0') + '-' + String(Math.min(day, last)).padStart(2, '0');
  }
  function dueRecurring(state, today) {
    if (!isDate(today)) throw new Error('today must be YYYY-MM-DD');
    return (state.recurring || []).filter((r) => r.active && r.nextDate <= today)
      .map((r) => ({ id: r.id, title: r.title, value: r.value, category: r.category, type: r.type, date: r.nextDate }))
      .sort((x, y) => x.date.localeCompare(y.date) || x.title.localeCompare(y.title));
  }
  function findDue(state, id, today) {
    const r = (state.recurring || []).find((x) => x.id === id);
    if (!r) throw new Error('Recurring item not found');
    if (!r.active || r.nextDate > today) throw new Error('That item is not due yet');
    return r;
  }
  function confirmRecurring(state, id, today) {
    const r = findDue(state, id, today);
    const e = validateEntry({ domain: 'money', type: r.type, date: r.nextDate, title: r.title, value: r.value, category: r.category || undefined, notes: 'Recurring' });
    state.entries.push(e);
    r.nextDate = advanceDate(r.nextDate, r.cadence);
    return e;
  }
  function skipRecurring(state, id, today) {
    const r = findDue(state, id, today);
    r.nextDate = advanceDate(r.nextDate, r.cadence);
  }
  // Last contact per person: manual contact entries, plus (when `state` is given) done social-tagged activities with that person. Computed, never stored twice.
  function overdue(ents, asOf, days, state) {
    const last = new Map();
    for (const e of ents) {
      if (e.type !== 'contact' || e.date > asOf) continue;
      const k = e.person.toLowerCase();
      if (!last.has(k) || e.date > last.get(k)) last.set(k, e.date);
    }
    if (state && L.activities) for (const [k, c] of L.activities.contacts(state, asOf)) if (!last.has(k) || c.date > last.get(k)) last.set(k, c.date);
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


  // ---- work: projects, outcomes, pipeline (schema 3) ----
  const STAGES = ['lead', 'contacted', 'applied', 'interview', 'offer', 'won', 'lost'];
  const OPEN_STAGES = ['lead', 'contacted', 'applied', 'interview', 'offer'];
  const STALE_DAYS = 14, CARRY_DAYS = 28;
  const outcomes = (state) => state.entries.filter((e) => e.domain === 'work' && e.type === 'outcome');
  const liveProjects = (state) => (state.projects || []).filter((p) => !p.archived);
  const isOverdue = (p, asOf) => p.status === 'active' && !p.archived && !!p.nextDate && p.nextDate < asOf;
  function overdueProjects(state, asOf) {
    if (!isDate(asOf)) throw new Error('today must be YYYY-MM-DD');
    return (state.projects || []).filter((p) => isOverdue(p, asOf)).sort((a, b) => a.nextDate.localeCompare(b.nextDate) || a.name.localeCompare(b.name));
  }
  function isStale(item, asOf) {
    if (!item || !OPEN_STAGES.includes(item.stage)) return false;
    return daysBetween(asOf, item.updatedAt) >= STALE_DAYS;
  }
  function pipelineCounts(state) {
    const c = {};
    for (const k of STAGES) c[k] = 0;
    for (const x of state.pipeline || []) c[x.stage]++;
    return c;
  }
  const openPipeline = (state) => (state.pipeline || []).filter((x) => OPEN_STAGES.includes(x.stage));
  function weekOutcomes(state, ws) {
    const we = addDays(ws, 6);
    return outcomes(state).filter((e) => inR(e, ws, we)).sort((a, b) => (a.status === b.status ? 0 : a.status === 'todo' ? -1 : 1) || a.date.localeCompare(b.date) || String(a.createdAt).localeCompare(String(b.createdAt)));
  }
  const ckey = (e) => e.title.trim().toLowerCase() + '|' + (e.projectId || '');
  // Unfinished outcomes from earlier weeks that this week does not yet have. Offered to the user; nothing is created here.
  function carryOverCandidates(state, weekStartISO) {
    const ws = weekStart(weekStartISO), from = addDays(ws, -CARRY_DAYS), we = addDays(ws, 6);
    const latest = new Map(), have = new Set();
    for (const e of outcomes(state)) {
      if (inR(e, ws, we)) have.add(ckey(e));
      if (e.date >= ws) continue;
      const k = ckey(e), cur = latest.get(k);
      if (!cur || e.date >= cur.date) latest.set(k, e);
    }
    return [...latest.values()].filter((e) => e.status === 'todo' && e.date >= from && !have.has(ckey(e)))
      .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  }
  // Mutator: copies the chosen candidates into the new week as todo. Only called after an explicit user choice.
  function carryOver(state, ids, weekStartISO) {
    const ws = weekStart(weekStartISO);
    if (!Array.isArray(ids)) throw new Error('Choose outcomes to carry over');
    const cands = carryOverCandidates(state, ws), made = [];
    for (const id of new Set(ids)) {
      const c = cands.find((x) => x.id === id);
      if (!c) throw new Error('That outcome cannot be carried over');
      const p = { domain: 'work', type: 'outcome', date: ws, title: c.title, status: 'todo', notes: c.notes };
      if (c.projectId) p.projectId = c.projectId;
      const e = validateEntry(p);
      state.entries.push(e); made.push(e);
    }
    return made;
  }
  function workSummary(state, today) {
    if (!isDate(today)) throw new Error('today must be YYYY-MM-DD');
    const ws = weekStart(today), wk = weekOutcomes(state, ws);
    const done = wk.filter((e) => e.status === 'done').length;
    const open = openPipeline(state);
    return {
      done, total: wk.length, overdue: overdueProjects(state, today).length, activeProjects: liveProjects(state).filter((p) => p.status === 'active').length,
      openPipeline: open.length, stale: open.filter((x) => isStale(x, today)).length, counts: pipelineCounts(state),
    };
  }
  function workDigest(state, ws) {
    const we = addDays(ws, 6), wk = weekOutcomes(state, ws);
    return {
      done: wk.filter((e) => e.status === 'done').length, planned: wk.length,
      activeProjects: liveProjects(state).filter((p) => p.status === 'active').length,
      overdueNext: overdueProjects(state, we).length, pipeline: pipelineCounts(state),
      moved: (state.pipeline || []).filter((x) => inR({ date: x.updatedAt }, ws, we)).length,
    };
  }

  // ---- health: body metrics, workouts, cycle, sleep, habits (schema 4) ----
  const LB_PER_KG = 2.20462262185;
  const DEFAULT_KINDS = ['strength', 'kettlebell', 'mace and clubs', 'bodyweight', 'cardio', 'HIIT', 'mobility', 'carries'];
  const HABIT_CAP = 8, HABIT_LOG_CAP = 100000;
  const healthSettings = (state) => (state.settings && state.settings.health) || { units: 'lb' };
  const hEntries = (state, type) => state.entries.filter((e) => e.domain === 'health' && e.type === type)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt).localeCompare(String(b.createdAt)));
  function convertWeight(v, from, to) {
    if (!['lb', 'kg'].includes(from) || !['lb', 'kg'].includes(to)) throw new Error('Units must be lb or kg');
    if (from === to) return v;
    return r1(from === 'lb' ? v / LB_PER_KG : v * LB_PER_KG);
  }
  // Mean of the last n values at each position (the window is shorter at the start).
  function movingAverage(values, n) {
    n = n || 7;
    return values.map((_, i) => { const w = values.slice(Math.max(0, i - n + 1), i + 1); return r2(w.reduce((a, b) => a + b, 0) / w.length); });
  }
  function bodySeries(state, type, today) {
    if (type !== 'weight' && type !== 'bodyfat') throw new Error('Unknown body metric');
    const pts = hEntries(state, type).filter((e) => !today || e.date <= today).map((e) => ({ date: e.date, value: e.value }));
    const avg = movingAverage(pts.map((p) => p.value), 7);
    return pts.map((p, i) => ({ date: p.date, value: p.value, avg: avg[i] }));
  }
  // latest, 7-entry average, change per week over the last 28 days (first to last entry in that window), progress to target.
  function bodyMetrics(state, type, today) {
    if (!isDate(today)) throw new Error('today must be YYYY-MM-DD');
    const hs = healthSettings(state), w = type === 'weight';
    const unit = w ? hs.units : '%', start = hs[w ? 'weightStart' : 'bodyFatStart'], target = hs[w ? 'weightTarget' : 'bodyFatTarget'];
    const series = bodySeries(state, type, today);
    const out = { unit, count: series.length, latest: null, latestDate: null, avg: null, start: start === undefined ? null : start, target: target === undefined ? null : target, weeklyRate: null, progressPct: null, toTarget: null, series };
    if (!series.length) return out;
    const last = series[series.length - 1];
    out.latest = last.value; out.latestDate = last.date; out.avg = last.avg;
    if (out.start === null) out.start = series[0].value;
    const win = series.filter((p) => p.date >= addDays(today, -28));
    if (win.length >= 2) {
      const span = daysBetween(win[win.length - 1].date, win[0].date);
      if (span > 0) out.weeklyRate = r2((win[win.length - 1].value - win[0].value) / span * 7);
    }
    if (out.target !== null) {
      out.toTarget = r1(out.target - last.value);
      if (out.start !== out.target) out.progressPct = r1(Math.max(0, Math.min(1, (out.start - last.value) / (out.start - out.target))) * 100);
    }
    return out;
  }
  function isoWeek(d) {
    if (!isDate(d)) throw new Error('Invalid date');
    const thu = addDays(d, 3 - ((new Date(ms(d)).getUTCDay() + 6) % 7));
    return Math.floor(daysBetween(thu, thu.slice(0, 4) + '-01-01') / 7) + 1;
  }
  // 1-based week number counted from the cycle start date (0 before the start).
  function weekNumber(d, startDate) {
    if (!isDate(d) || !isDate(startDate)) throw new Error('Invalid date');
    const n = daysBetween(d, startDate);
    return n < 0 ? 0 : Math.floor(n / 7) + 1;
  }
  function workoutWeek(state, ws) {
    ws = weekStart(ws);
    const we = addDays(ws, 6), cy = state.cycle || null;
    // Done Health-tagged activities count as sessions and minutes too (computed here; no workout entry is stored for them).
    const wk = hEntries(state, 'workout').filter((e) => inR(e, ws, we)).concat(L.activities ? L.activities.healthSessions(state, ws, we) : []);
    const mix = new Map();
    let minutes = 0;
    for (const e of wk) {
      minutes += e.minutes || 0;
      const k = e.kind || e.healthKind || 'untyped', g = mix.get(k) || { kind: k, count: 0, minutes: 0 };
      g.count++; g.minutes += e.minutes || 0; mix.set(k, g);
    }
    return {
      weekStart: ws, isoWeek: isoWeek(ws), cycleWeek: cy ? weekNumber(ws, cy.startDate) : null,
      sessions: wk.length, target: state.settings.targets.workoutsPerWeek, minutes,
      mix: [...mix.values()].sort((a, b) => b.count - a.count || b.minutes - a.minutes || a.kind.localeCompare(b.kind)),
    };
  }
  // Training cycle: sprintsPerCycle sprints of sprintDays back to back, then restDays of rest, repeating.
  // Heavy/light alternates weekly, counted from the start of each cycle (continuing across sprints, restarting after rest).
  function trainingCycle(cycle, d) {
    if (!cycle || !isDate(cycle.startDate) || !isDate(d)) throw new Error('Invalid cycle or date');
    const sd = cycle.sprintDays, spc = cycle.sprintsPerCycle, rd = cycle.restDays;
    const base = { sprintDays: sd, sprintsPerCycle: spc, restDays: rd };
    const n = daysBetween(d, cycle.startDate);
    if (n < 0) return Object.assign(base, { phase: 'before', daysToStart: -n, sprint: 0, dayInSprint: 0, cycleNumber: 0, week: null, daysToRest: null });
    const training = sd * spc, len = training + rd, c = Math.floor(n / len), k = n % len;
    const o = Object.assign(base, { cycleNumber: c + 1 });
    if (k >= training) return Object.assign(o, { phase: 'rest', sprint: 0, dayInSprint: 0, restDay: k - training + 1, week: null, daysToRest: 0, daysToTraining: len - k });
    let week = null;
    if (cycle.alternateHeavyLight) week = ((Math.floor(k / 7) % 2 === 0) === (cycle.firstWeek === 'heavy')) ? 'heavy' : 'light';
    return Object.assign(o, { phase: 'sprint', sprint: Math.floor(k / sd) + 1, dayInSprint: k % sd + 1, week, daysToRest: rd > 0 ? training - k : null });
  }
  function cycleLabel(c) {
    if (!c) return '';
    if (c.phase === 'before') return 'Cycle starts in ' + c.daysToStart + (c.daysToStart === 1 ? ' day' : ' days');
    if (c.phase === 'rest') return 'Rest period, day ' + c.restDay + ' of ' + c.restDays;
    return 'Sprint ' + c.sprint + ' of ' + c.sprintsPerCycle + ', day ' + c.dayInSprint + ' of ' + c.sprintDays + (c.week ? ', ' + c.week + ' week' : '');
  }
  function sleepAvg(state, a, b) {
    let s = 0, n = 0;
    for (const e of hEntries(state, 'sleep')) if (inR(e, a, b)) { s += e.value; n++; }
    return { n, avg: n ? r2(s / n) : null };
  }
  function sleepSummary(state, today) {
    if (!isDate(today)) throw new Error('today must be YYYY-MM-DD');
    const cur = sleepAvg(state, addDays(today, -6), today), prev = sleepAvg(state, addDays(today, -13), addDays(today, -7));
    const series = [];
    for (let i = 13; i >= 0; i--) { const d = addDays(today, -i), a = sleepAvg(state, d, d); series.push({ date: d, value: a.avg }); }
    return { avg7: cur.avg, nights7: cur.n, prevAvg7: prev.avg, delta: cur.avg !== null && prev.avg !== null ? r2(cur.avg - prev.avg) : null, series };
  }
  // ---- daily checks ----
  const habitDates = (state, id) => new Set((state.habitLog || []).filter((x) => x.habitId === id).map((x) => x.date));
  function habitStats(state, id, today) {
    if (!isDate(today)) throw new Error('today must be YYYY-MM-DD');
    const ds = habitDates(state, id);
    let c7 = 0;
    for (let i = 0; i < 7; i++) if (ds.has(addDays(today, -i))) c7++;
    // The streak counts back from today, or from yesterday while today is not ticked yet.
    let d = ds.has(today) ? today : addDays(today, -1), streak = 0;
    while (ds.has(d) && streak < 100000) { streak++; d = addDays(d, -1); }
    return { checks7: c7, rate7: r1(c7 / 7 * 100), streak, doneToday: ds.has(today) };
  }
  function habitRate(state, a, b) {
    const hs = state.habits || [], days = daysBetween(b, a) + 1;
    if (!hs.length || days < 1) return 0;
    const ids = new Set(hs.map((x) => x.id));
    let n = 0;
    for (const x of state.habitLog || []) if (ids.has(x.habitId) && inR({ date: x.date }, a, b)) n++;
    return r1(n / (hs.length * days) * 100);
  }
  function addHabit(state, name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) throw new Error('Habit name must be 1 to 60 characters');
    if (state.habits.length >= HABIT_CAP) throw new Error('You can keep up to ' + HABIT_CAP + ' daily checks');
    const h = { id: L._webcrypto.randomUUID(), name: name.trim() };
    state.habits.push(h);
    return h;
  }
  function deleteHabit(state, id) {
    if (!state.habits.some((x) => x.id === id)) throw new Error('Habit not found');
    state.habits = state.habits.filter((x) => x.id !== id);
    state.habitLog = state.habitLog.filter((x) => x.habitId !== id);
  }
  // Ticks or unticks one habit on one day; returns true when it is now ticked.
  function toggleHabit(state, id, d) {
    if (!isDate(d)) throw new Error('Invalid date');
    if (!state.habits.some((x) => x.id === id)) throw new Error('Habit not found');
    const n = state.habitLog.length;
    state.habitLog = state.habitLog.filter((x) => !(x.habitId === id && x.date === d));
    if (state.habitLog.length < n) return false;
    // The store caps the log at 100000 ticks (34 years of 8 daily checks); say so plainly instead of failing the save.
    if (n >= HABIT_LOG_CAP) throw new Error('The daily check history is full (' + HABIT_LOG_CAP + ' ticks). Delete a daily check you no longer use.');
    state.habitLog.push({ habitId: id, date: d });
    return true;
  }
  function weightChange(state, ws, we) {
    const all = hEntries(state, 'weight'), cur = all.filter((e) => e.date <= we).pop();
    if (!cur) return 0;
    const base = all.filter((e) => e.date < ws).pop() || all.find((e) => inR(e, ws, we));
    return !base || base === cur ? 0 : r1(cur.value - base.value);
  }
  function healthDigest(state, ws) {
    const we = addDays(ws, 6), wk = workoutWeek(state, ws), sl = sleepAvg(state, ws, we);
    return { sessions: wk.sessions, minutes: wk.minutes, avgSleep: sl.avg === null ? 0 : sl.avg, weightChange: weightChange(state, ws, we), habitRate: habitRate(state, ws, we) };
  }
  // Mutators for the unit setting and project delete.
  function setWeightUnits(state, units) {
    const hs = state.settings.health, from = hs.units;
    if (units !== 'lb' && units !== 'kg') throw new Error('Units must be lb or kg');
    if (units === from) return;
    // Stored values keep 6 decimals so switching back and forth does not drift; screens round to 0.1.
    const conv = (v) => Math.round((from === 'lb' ? v / LB_PER_KG : v * LB_PER_KG) * 1e6) / 1e6;
    for (const e of state.entries) if (e.domain === 'health' && e.type === 'weight') e.value = conv(e.value);
    for (const k of ['weightStart', 'weightTarget']) if (hs[k] !== undefined) hs[k] = conv(hs[k]);
    // Weight goals hold numbers in the same units, so they convert too.
    for (const g of state.goals || []) if (g.metric === 'weight') for (const k of ['startValue', 'targetValue', 'manualValue']) if (typeof g[k] === 'number') g[k] = conv(g[k]);
    hs.units = units;
  }
  const linkedOutcomeCount = (state, id) => outcomes(state).filter((e) => e.projectId === id).length;
  // Deletes a project; its outcomes are kept and unlinked. Returns how many were unlinked.
  function deleteProject(state, id) {
    if (!(state.projects || []).some((p) => p.id === id)) throw new Error('Project not found');
    let n = 0;
    for (const e of state.entries) if (e.projectId === id) { delete e.projectId; n++; }
    state.projects = state.projects.filter((p) => p.id !== id);
    return n;
  }

  const UNITS = { money: '%', work: 'outcomes', health: 'workouts', activities: 'days', social: 'people', learning: 'items', home: 'tasks', admin: 'items', goals: '%', wellbeing: 'score' };
  function weekMetric(state, id, ws, ents) {
    const we = addDays(ws, 6);
    const tg = state.settings.targets;
    switch (id) {
      case 'money': { const s = savings(ents, ws, we); return s.rate === null ? 0 : s.rate * 100; }
      case 'assets': return netWorthDetail(state, we).total;
      case 'work': return count(ents, ws, we, (e) => e.type === 'outcome' && e.status === 'done');
      case 'health': return workoutWeek(state, ws).sessions;
      case 'activities': return L.activities.current(state) ? L.activities.weekValue(state, we) : activeDays(ents, ws, we);
      case 'social': return overdue(ents, we, tg.contactDays, state).n;
      // Study minutes once any Learning data exists (schema 7); the older count of finished items before that.
      case 'learning': return L.learning.current(state) ? L.learning.weekValue(state, we) : count(ents, ws, we, (e) => e.type === 'item' && e.status === 'done');
      case 'home': return L.home.weekValue(state, we);
      case 'admin': return L.admin.weekValue(state, we);
      case 'goals': {
        // Schema 5 goals when there are any (weight and body fat goals left out); the old goal entries otherwise.
        if ((state.goals || []).length) return L.goals.weekShare(state, we);
        const g = goals(ents, we); return g.share === null ? 0 : g.share * 100;
      }
      case 'wellbeing': { const m = avgMood(ents, ws, we); return m.avg === null ? 0 : m.avg; }
    }
    throw new Error('Unknown domain');
  }
  const unitOf = (state, id) => (id === 'assets' ? state.settings.currency : id === 'learning' && L.learning.current(state) ? 'minutes' : UNITS[id]);
  const byDomain = (state, id) => state.entries.filter((e) => e.domain === id);

  function weeklyDigest(state, weekStartISO) {
    const ws = weekStart(weekStartISO), pw = addDays(ws, -7);
    const domains = {};
    for (const d of DOMAINS) {
      const ents = byDomain(state, d.id);
      domains[d.id] = { now: r2(weekMetric(state, d.id, ws, ents)), prev: r2(weekMetric(state, d.id, pw, ents)), unit: unitOf(state, d.id) };
    }
    const we = addDays(ws, 6), wm = sumMoney(byDomain(state, 'money'), ws, we), nw = netWorthDetail(state, we);
    const mv = monthView(state, monthOf(we));
    const money = { income: dollars(wm.incC), spend: dollars(wm.expC), budgetUsedPct: mv.budgetCents > 0 ? r1(mv.budgetedSpentCents * 100 / mv.budgetCents) : 0, netWorth: nw.total, liabilities: nw.liabilities };
    return { week: ws, domains, money, work: workDigest(state, ws), health: healthDigest(state, ws), activities: L.activities.digest(state, ws), goals: L.goals.digestCounts(state, ws), home: L.home.digest(state, ws), admin: L.admin.digest(state, ws), learning: L.learning.digest(state, ws) };
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
        const w = netWorthDetail(state, today);
        return R('Net worth', fmtMoney(w.total, st.currency), w.total, w.count + (w.count === 1 ? ' account' : ' accounts'));
      }
      case 'work': {
        const total = count(ents, ws, we, (e) => e.type === 'outcome');
        const done = count(ents, ws, we, (e) => e.type === 'outcome' && e.status === 'done');
        const w = workSummary(state, today);
        return R('Outcomes done this week', done + ' of ' + total, done, w.overdue + ' overdue next ' + (w.overdue === 1 ? 'action' : 'actions') + ', ' + w.openPipeline + ' open in pipeline');
      }
      case 'health': {
        const n = workoutWeek(state, ws).sessions;
        const base = n >= tg.workoutsPerWeek ? 'Target met' : (tg.workoutsPerWeek - n) + ' to go';
        const cl = state.cycle ? cycleLabel(trainingCycle(state.cycle, today)) : '';
        return R('Workouts this week', n + ' of ' + tg.workoutsPerWeek, n, cl ? base + '. ' + cl : base);
      }
      case 'activities': {
        if (L.activities.current(state)) return L.activities.headline(state, today, R);
        const d = activeDays(ents, ws, we), s = count(ents, ws, we, (e) => e.type === 'session');
        return R('Active days this week', String(d), d, s + (s === 1 ? ' session' : ' sessions'));
      }
      case 'social': {
        const o = overdue(ents, today, tg.contactDays, state);
        return R('People overdue', String(o.n), o.n, o.total + ' tracked, over ' + tg.contactDays + ' days since contact');
      }
      case 'learning': {
        if (L.learning.current(state)) return L.learning.headline(state, today, R);
        const n = count(ents, mon + '-01', mon + '-31', (e) => e.type === 'item' && e.status === 'done');
        let h = 0;
        for (const e of ents) if (e.type === 'hours' && e.date.slice(0, 7) === mon) h += e.value;
        return R('Items finished this month', String(n), n, r1(h) + ' hours logged');
      }
      case 'home': return L.home.headline(state, today, R);
      case 'admin': return L.admin.headline(state, today, R);
      case 'goals': {
        if ((state.goals || []).length || !ents.length) { // legacy goal entries only show while there are no goals and some entries
          const g = L.goals.summary(state, today), v = g.share === null ? 0 : Math.round(g.share * 100);
          const sub = g.active ? g.behind + ' behind, ' + (g.nextDue ? 'next due ' + g.nextDue : 'nothing due') : 'No active goals';
          return R('Goals on track', g.share === null ? 'n/a' : v + '%', v, sub);
        }
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

  L.metrics = { todayISO, DEFAULT_KINDS, HABIT_CAP, convertWeight, movingAverage, bodySeries, bodyMetrics, isoWeek, weekNumber, workoutWeek, trainingCycle, cycleLabel, sleepAvg, sleepSummary, habitStats, habitRate, addHabit, deleteHabit, toggleHabit, healthDigest, setWeightUnits, linkedOutcomeCount, deleteProject, liveProjects, STAGES, OPEN_STAGES, STALE_DAYS, overdueProjects, isStale, pipelineCounts, openPipeline, weekOutcomes, carryOverCandidates, carryOver, workSummary, DOMAINS, isDate, addDays, validateEntry, headline, weekStart, weeklyDigest, series, fmtMoney, cents, ACCOUNT_KINDS, LIAB_KINDS, DEFAULT_CATEGORIES, UNCAT, addMonths, monthEnd, advanceDate, netWorthDetail, netWorthHistory, monthView, cashflow, dueRecurring, confirmRecurring, skipRecurring };
  L.DOMAINS = DOMAINS;
})();
