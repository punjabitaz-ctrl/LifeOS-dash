(function () {
  'use strict';
  // Goals (schema 5). Pure functions over state: progress and pace are derived live from the other domains, never stored.
  // Every mutator takes the state inside store.commit and only changes a goal's lifecycle (achieved, dropped, rolled over)
  // when called, which only happens after an explicit user tap.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const M = () => L.metrics;

  const HORIZONS = Object.freeze(['weekly', 'monthly', 'quarterly', 'annual', '3y', '5y', '10y']);
  const HORIZON_LABEL = Object.freeze({ weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual', '3y': '3 year', '5y': '5 year', '10y': '10 year' });
  const TOLERANCE = 0.1; // pace: within 10 points of the elapsed share of the time window is "on track"
  const mk = (id, label, domain, unit) => Object.freeze({ id, label, domain, unit });
  const METRICS = Object.freeze([
    mk('manual', 'Manual (type the current value)', null, 'number'),
    mk('netWorth', 'Net worth', 'assets', 'currency'),
    mk('savingsRate', 'Savings rate (this month)', 'money', 'percent'),
    mk('monthlySpend', 'Spending (this month)', 'money', 'currency'),
    mk('weight', 'Weight', 'health', 'weight'),
    mk('bodyFat', 'Body fat %', 'health', 'percent'),
    mk('workoutsPerWeek', 'Workouts per week', 'health', 'count'),
    mk('avgSleep', 'Average sleep (7 days)', 'health', 'hours'),
    mk('habitRate', 'Daily checks completed (7 days)', 'health', 'percent'),
    mk('outcomesPerWeek', 'Outcomes done per week', 'work', 'count'),
    mk('pipelineWon', 'Pipeline items won', 'work', 'count'),
  ]);
  // Body metrics are sensitive (SEC-32): goals on them never reach a digest, prompt or rules insight.
  const BODY = Object.freeze(['weight', 'bodyFat']);
  const PACE_LABEL = Object.freeze({ ahead: 'Ahead', 'on-track': 'On track', behind: 'Behind', 'no-data': 'No data yet' });

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const r1 = (x) => Math.round(x * 10) / 10;
  const r2 = (x) => Math.round(x * 100) / 100;
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const pd = (s) => [+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)];
  // Calendar-day arithmetic on date strings. Date.UTC is used only as a day counter, never to read a local time.
  const dayNo = (s) => { const p = pd(s); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 864e5); };
  const daysBetween = (a, b) => dayNo(a) - dayNo(b);
  const monthOf = (d) => d.slice(0, 7);
  const rank = (h) => HORIZONS.indexOf(h);
  const metricDef = (id) => METRICS.find((m) => m.id === id) || null;
  const isBody = (g) => BODY.includes(g.metric);
  const goalsOf = (state) => (state && Array.isArray(state.goals) ? state.goals : []);

  // ---- linked metrics: the live number, or null for "no data yet" (never zero) ----
  // `memo` (optional Map) shares linked values within one pass: a linked value depends only on the metric and the date,
  // so 300 goals on the same few metrics cost a handful of scans instead of one scan of every entry per goal.
  function currentValue(state, goal, asOf, memo) {
    const m = M();
    if (goal.metric === 'manual') return typeof goal.manualValue === 'number' ? goal.manualValue : null;
    if (!m.isDate(asOf)) throw new Error('Date must be YYYY-MM-DD');
    if (memo) {
      const k = goal.metric + '|' + asOf;
      if (!memo.has(k)) memo.set(k, linkedValue(state, goal.metric, asOf));
      return memo.get(k);
    }
    return linkedValue(state, goal.metric, asOf);
  }
  function linkedValue(state, metric, asOf) {
    const m = M();
    const ents = state.entries;
    switch (metric) {
      case 'netWorth': { const d = m.netWorthDetail(state, asOf); return d.count ? d.total : null; }
      case 'savingsRate': { const v = m.monthView(state, monthOf(asOf)); return v.savingsRate === null ? null : r2(v.savingsRate * 100); }
      case 'monthlySpend': {
        const mo = monthOf(asOf);
        if (!ents.some((e) => e.type === 'expense' && monthOf(e.date) === mo)) return null;
        return m.monthView(state, mo).spend;
      }
      case 'weight': case 'bodyFat': {
        const s = m.bodySeries(state, metric === 'weight' ? 'weight' : 'bodyfat', asOf);
        return s.length ? s[s.length - 1].value : null;
      }
      case 'workoutsPerWeek':
        if (!ents.some((e) => e.type === 'workout' && e.date <= asOf)) return null;
        return m.workoutWeek(state, m.weekStart(asOf)).sessions;
      case 'avgSleep': return m.sleepAvg(state, m.addDays(asOf, -6), asOf).avg;
      case 'habitRate':
        if (!(state.habits || []).length || !(state.habitLog || []).length) return null;
        return m.habitRate(state, m.addDays(asOf, -6), asOf);
      case 'outcomesPerWeek':
        if (!ents.some((e) => e.type === 'outcome' && e.date <= asOf)) return null;
        return m.weekOutcomes(state, m.weekStart(asOf)).filter((e) => e.status === 'done').length;
      case 'pipelineWon':
        if (!(state.pipeline || []).length) return null;
        return state.pipeline.filter((x) => x.stage === 'won' && x.updatedAt <= asOf).length;
    }
    throw new Error('Unknown goal metric');
  }

  // Progress 0 to 1, direction aware. A zero-width (or backwards) start-to-target range is 1 once the target is met, else 0.
  function progressOf(goal, cur) {
    if (cur === null || cur === undefined) return null;
    const up = goal.direction === 'up';
    const span = up ? goal.targetValue - goal.startValue : goal.startValue - goal.targetValue;
    if (!(span > 0)) return (up ? cur >= goal.targetValue : cur <= goal.targetValue) ? 1 : 0;
    return clamp01((up ? cur - goal.startValue : goal.startValue - cur) / span);
  }
  // Share of the start-to-due window that has elapsed on asOf, 0 to 1. A one-day window is 0 before it and 1 from its due date.
  function elapsedShare(goal, asOf) {
    const total = daysBetween(goal.dueDate, goal.startDate);
    if (total <= 0) return asOf >= goal.dueDate ? 1 : 0;
    return clamp01(daysBetween(asOf, goal.startDate) / total);
  }
  // Pace is arithmetic: progress minus elapsed share, in points, compared with the 10 point tolerance.
  function paceOf(progress, elapsed) {
    if (progress === null) return 'no-data';
    const d = Math.round((progress - elapsed) * 1e6) / 1e6;
    return d > TOLERANCE ? 'ahead' : d < -TOLERANCE ? 'behind' : 'on-track';
  }
  function evaluate(state, goal, asOf, memo) {
    const cur = currentValue(state, goal, asOf, memo), progress = progressOf(goal, cur), elapsed = elapsedShare(goal, asOf), pace = paceOf(progress, elapsed);
    const up = goal.direction === 'up';
    return { current: cur, progress, elapsed, pace, status: goal.statusOverride || pace, overridden: !!goal.statusOverride, reached: cur !== null && (up ? cur >= goal.targetValue : cur <= goal.targetValue) };
  }

  // ---- display ----
  function fmtValue(state, goal, v) {
    if (v === null || v === undefined) return 'no data yet';
    switch ((metricDef(goal.metric) || {}).unit) {
      case 'currency': return M().fmtMoney(v, state.settings.currency);
      case 'percent': return r1(v) + '%';
      case 'weight': return r1(v) + ' ' + ((state.settings.health || {}).units || 'lb');
      case 'hours': return r2(v) + ' h';
      default: return String(r2(v));
    }
  }
  const pct = (p) => (p === null ? 'no data yet' : Math.round(p * 1000) / 10 + '%');

  // ---- summaries ----
  const activeGoals = (state) => goalsOf(state).filter((g) => g.state === 'active');
  function tally(state, list, asOf) {
    const c = { active: list.length, ahead: 0, onTrack: 0, behind: 0, noData: 0 }, memo = new Map();
    for (const g of list) {
      const s = evaluate(state, g, asOf, memo).status;
      if (s === 'ahead') c.ahead++; else if (s === 'on-track') c.onTrack++; else if (s === 'behind') c.behind++; else c.noData++;
    }
    return c;
  }
  // Dashboard tile: share of active goals that are on track or ahead; sub line has the behind count and the next due date.
  function summary(state, today) {
    const act = activeGoals(state), c = tally(state, act, today);
    const due = act.map((g) => g.dueDate).filter((d) => d >= today).sort()[0] || null;
    return Object.assign(c, { share: c.active ? (c.ahead + c.onTrack) / c.active : null, nextDue: due });
  }
  // Digest numbers (counts only), as of the end of the week. Weight and body fat goals are left out entirely.
  function publicActive(state, asOf) { return activeGoals(state).filter((g) => !isBody(g) && g.startDate <= asOf); }
  function digestCounts(state, ws) {
    const we = M().addDays(ws, 6), c = tally(state, publicActive(state, we), we);
    const achieved = goalsOf(state).filter((g) => g.state === 'achieved' && !isBody(g) && g.closedAt && g.closedAt >= ws && g.closedAt <= we).length;
    return { active: c.active, ahead: c.ahead, onTrack: c.onTrack, behind: c.behind, achieved };
  }
  // Share (0 to 100) of public active goals on track or ahead on a date; 0 when there are none (like the other digest numbers).
  function weekShare(state, asOf) {
    const list = publicActive(state, asOf), c = tally(state, list, asOf);
    return c.active ? (c.ahead + c.onTrack) / c.active * 100 : 0;
  }

  // ---- cascade ----
  const childrenOf = (state, id) => goalsOf(state).filter((g) => g.parentId === id);
  // Ladder from the longest horizon down. Nodes are goals that are not dropped; roots have no parent (or a dropped one) and
  // at least one child; goals with neither parent nor children are listed separately as `unlinked`.
  function ladder(state) {
    const live = goalsOf(state).filter((g) => g.state !== 'dropped'), ids = new Set(live.map((g) => g.id));
    const kids = new Map();
    for (const g of live) if (g.parentId !== undefined && ids.has(g.parentId)) { if (!kids.has(g.parentId)) kids.set(g.parentId, []); kids.get(g.parentId).push(g); }
    const order = (a, b) => rank(b.horizon) - rank(a.horizon) || a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title);
    const node = (g) => ({ goal: g, children: (kids.get(g.id) || []).sort(order).map(node) });
    const roots = [], unlinked = [];
    for (const g of live.slice().sort(order)) {
      const linkedUp = g.parentId !== undefined && ids.has(g.parentId);
      if (linkedUp) continue;
      if (kids.has(g.id)) roots.push(node(g)); else unlinked.push(g);
    }
    return { roots, unlinked, dropped: goalsOf(state).filter((g) => g.state === 'dropped') };
  }

  // ---- periods ----
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  function monthEnd(m) { const y = +m.slice(0, 4), mo = +m.slice(5, 7); return m + '-' + pad(new Date(Date.UTC(y, mo, 0)).getUTCDate()); }
  function quarterEnd(d) { const y = +d.slice(0, 4), q = Math.floor((+d.slice(5, 7) - 1) / 3); return monthEnd(pad(y, 4) + '-' + pad(q * 3 + 3)); }
  function addYears(d, n) {
    const p = pd(d), y = p[0] + n, last = new Date(Date.UTC(y, p[1], 0)).getUTCDate();
    return pad(y, 4) + '-' + pad(p[1]) + '-' + pad(Math.min(p[2], last));
  }
  // Default due date: the end of the calendar week, month or quarter; the same day N years on for annual, 3, 5 and 10 year goals.
  function defaultDue(horizon, start) {
    const m = M();
    switch (horizon) {
      case 'weekly': return m.addDays(m.weekStart(start), 6);
      case 'monthly': return monthEnd(monthOf(start));
      case 'quarterly': return quarterEnd(start);
      case 'annual': return addYears(start, 1);
      case '3y': return addYears(start, 3);
      case '5y': return addYears(start, 5);
      case '10y': return addYears(start, 10);
    }
    throw new Error('Unknown horizon');
  }
  // The period after the one containing `d`: [start, end]. Only weekly and monthly goals roll over.
  function nextPeriod(horizon, d) {
    const m = M();
    if (horizon === 'weekly') { const s = m.addDays(m.weekStart(d), 7); return { start: s, end: m.addDays(s, 6) }; }
    if (horizon === 'monthly') { const mo = m.addMonths(monthOf(d), 1); return { start: mo + '-01', end: monthEnd(mo) }; }
    throw new Error('Only weekly and monthly goals roll over');
  }

  // ---- weekly review: goals due this week, pace changes since last week, roll-over offers ----
  function reviewGoals(state, wk, today) {
    const m = M(), ws = m.weekStart(wk), we = m.addDays(ws, 6), act = activeGoals(state);
    const now = today && today < we ? today : we, before = m.addDays(ws, -1);
    const due = act.filter((g) => g.dueDate >= ws && g.dueDate <= we).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));
    const overdue = act.filter((g) => g.dueDate < ws).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));
    const changes = [], memo = new Map();
    for (const g of act) {
      if (g.startDate > before || g.startDate > now) continue;
      const from = evaluate(state, g, before, memo).status, to = evaluate(state, g, now, memo).status;
      if (from !== to) changes.push({ id: g.id, title: g.title, from, to });
    }
    const roll = act.filter((g) => (g.horizon === 'weekly' || g.horizon === 'monthly') && g.dueDate <= we);
    return { week: ws, due, overdue, changes, roll };
  }
  // The period a rolled goal moves into: the one after its due date, advanced past any period already over on `today`.
  function rollTarget(g, today) {
    const p = nextPeriod(g.horizon, g.dueDate);
    if (!today || p.end >= today) return p;
    // Already over: jump straight to the period containing today (no stepping loop, so any age of goal lands correctly).
    const m = M(), s = g.horizon === 'weekly' ? m.weekStart(today) : monthOf(today) + '-01';
    return { start: s, end: g.horizon === 'weekly' ? m.addDays(s, 6) : monthEnd(monthOf(today)) };
  }

  // ---- mutators (run inside store.commit; nothing here is ever called automatically) ----
  const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
  function toNum(v, label) {
    if (v === undefined || v === null || v === '') return undefined;
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim().length <= 40 && NUM_RE.test(v.trim()) ? Number(v) : NaN);
    if (!isFinite(n) || Math.abs(n) > 1e12) throw new Error(label + ' must be a number');
    return n;
  }
  const find = (state, id) => { const g = goalsOf(state).find((x) => x.id === id); if (!g) throw new Error('Goal not found'); return g; };
  function checkShape(g) {
    if (typeof g.title !== 'string' || !g.title.trim()) throw new Error('Give the goal a title');
    if (g.title.trim().length > 200) throw new Error('Title must be 200 characters or fewer');
    if (g.dueDate < g.startDate) throw new Error('The due date is before the start date');
    if (g.direction === 'up' ? g.targetValue < g.startValue : g.targetValue > g.startValue) throw new Error(g.direction === 'up' ? 'For a goal that goes up, the target must not be below the start value' : 'For a goal that goes down, the target must not be above the start value');
  }
  function checkParent(list, g) {
    if (g.parentId === undefined) return;
    const p = list.find((x) => x.id === g.parentId);
    if (!p) throw new Error('Parent goal not found');
    if (rank(p.horizon) <= rank(g.horizon)) throw new Error('A parent goal must be on a longer horizon than its child');
  }
  function addGoal(state, input, today) {
    if (!isObj(input)) throw new Error('Goal must be an object');
    const m = M(), t = m.isDate(today) ? today : m.todayISO();
    if (!Array.isArray(state.goals)) state.goals = [];
    if (state.goals.length >= 300) throw new Error('You can keep up to 300 goals. Delete some first.');
    const def = metricDef(input.metric === undefined ? 'manual' : input.metric);
    if (!def) throw new Error('Unknown goal metric');
    if (!HORIZONS.includes(input.horizon)) throw new Error('Choose a horizon');
    const start = input.startDate || t;
    if (!m.isDate(start)) throw new Error('Start date must be a date');
    const due = input.dueDate || defaultDue(input.horizon, start);
    if (!m.isDate(due)) throw new Error('Due date must be a date');
    const g = {
      id: L._webcrypto.randomUUID(), title: typeof input.title === 'string' ? input.title.trim() : '', horizon: input.horizon,
      domain: def.domain || (input.domain === undefined ? 'goals' : input.domain), metric: def.id, direction: input.direction === undefined ? 'up' : input.direction,
      startValue: toNum(input.startValue, 'Start value'), targetValue: toNum(input.targetValue, 'Target'),
      startDate: start, dueDate: due, state: 'active', notes: typeof input.notes === 'string' ? input.notes.trim() : '', createdAt: new Date().toISOString(),
    };
    if (g.targetValue === undefined) throw new Error('Enter a target');
    if (g.direction !== 'up' && g.direction !== 'down') throw new Error('Direction must be up or down');
    const mv = toNum(input.manualValue, 'Current value');
    if (mv !== undefined) g.manualValue = mv;
    if (input.parentId) g.parentId = input.parentId;
    if (g.startValue === undefined) {
      // A manual goal starts from its typed current value, else from 0; a linked goal starts from its current number.
      const cur = def.id === 'manual' ? (mv === undefined ? 0 : mv) : currentValue(state, g, t);
      if (cur === null) throw new Error('Enter a start value; there is no data yet to start from');
      g.startValue = cur;
    }
    checkShape(g);
    checkParent(state.goals.concat([g]), g);
    L.store.validateGoals(state.goals.concat([g]));
    state.goals.push(g);
    return g;
  }
  const EDITABLE = ['title', 'horizon', 'direction', 'startValue', 'targetValue', 'startDate', 'dueDate', 'parentId', 'notes', 'manualValue', 'statusOverride', 'domain'];
  function updateGoal(state, id, patch) {
    const g = find(state, id);
    if (!isObj(patch)) throw new Error('Nothing to change');
    const n = Object.assign({}, g);
    for (const k of Object.keys(patch)) {
      if (!EDITABLE.includes(k)) throw new Error('That field cannot be changed');
      const v = patch[k];
      if (k === 'startValue' || k === 'targetValue') { const x = toNum(v, k === 'startValue' ? 'Start value' : 'Target'); if (x === undefined) throw new Error('Enter a number'); n[k] = x; }
      else if (k === 'manualValue') { const x = toNum(v, 'Current value'); if (x === undefined) delete n.manualValue; else n.manualValue = x; }
      else if (k === 'parentId' || k === 'statusOverride') { if (v === null || v === undefined || v === '') delete n[k]; else n[k] = v; }
      else if (k === 'domain') { if (g.metric === 'manual') n.domain = v; }
      else n[k] = typeof v === 'string' && k !== 'horizon' && k !== 'direction' ? v.trim() : v;
    }
    if (n.manualValue !== undefined && n.metric !== 'manual') delete n.manualValue;
    checkShape(n);
    const list = state.goals.map((x) => (x.id === id ? n : x));
    checkParent(list, n);
    for (const c of list.filter((x) => x.parentId === id)) checkParent(list, c);
    L.store.validateGoals(list);
    for (const k of Object.keys(g)) delete g[k];
    Object.assign(g, n);
    return g;
  }
  function setManualValue(state, id, v) {
    const g = find(state, id);
    if (g.metric !== 'manual') throw new Error('Only manual goals take a typed value');
    const x = toNum(v, 'Current value');
    if (x === undefined) throw new Error('Enter a number');
    g.manualValue = x;
    return g;
  }
  function setOverride(state, id, status) {
    const g = find(state, id);
    if (status === null || status === undefined || status === '') { delete g.statusOverride; return g; }
    if (!['ahead', 'on-track', 'behind'].includes(status)) throw new Error('Status must be ahead, on track or behind');
    g.statusOverride = status;
    return g;
  }
  function close(state, id, today, to) {
    const g = find(state, id);
    if (g.state !== 'active') throw new Error('Only an active goal can be ' + to);
    const t = M().isDate(today) ? today : M().todayISO();
    g.state = to; g.closedAt = t;
    return g;
  }
  const achieveGoal = (state, id, today) => close(state, id, today, 'achieved');
  const dropGoal = (state, id, today) => close(state, id, today, 'dropped');
  function reopenGoal(state, id) {
    const g = find(state, id);
    if (g.state === 'active') throw new Error('That goal is already active');
    g.state = 'active'; delete g.closedAt;
    return g;
  }
  // Deletes a goal; its children are kept and unlinked. Returns how many were unlinked.
  function deleteGoal(state, id) {
    find(state, id);
    let n = 0;
    for (const g of state.goals) if (g.parentId === id) { delete g.parentId; n++; }
    state.goals = state.goals.filter((g) => g.id !== id);
    return n;
  }
  // Moves a weekly or monthly goal into its next period (same goal, new window). Only the user's tap calls this.
  function rollOver(state, id, today) {
    const g = find(state, id);
    if (g.state !== 'active') throw new Error('Only an active goal can be rolled over');
    if (g.horizon !== 'weekly' && g.horizon !== 'monthly') throw new Error('Only weekly and monthly goals roll over');
    const t = M().isDate(today) ? today : M().todayISO(), p = rollTarget(g, t);
    g.startDate = p.start; g.dueDate = p.end;
    return g;
  }

  L.goals = {
    HORIZONS, HORIZON_LABEL, METRICS, BODY, PACE_LABEL, TOLERANCE, metricDef, isBody, currentValue, progressOf, elapsedShare, paceOf, evaluate,
    fmtValue, pct, summary, digestCounts, weekShare, publicActive, childrenOf, ladder, defaultDue, nextPeriod, rollTarget, reviewGoals,
    addGoal, updateGoal, setManualValue, setOverride, achieveGoal, dropGoal, reopenGoal, deleteGoal, rollOver,
  };
})();
