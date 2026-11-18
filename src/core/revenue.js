(function () {
  'use strict';
  // v0.12.0: lines of work and the revenue tracker. Pure functions over a state-shaped object plus a few mutators that run inside a
  // commit. Money is integer cents everywhere: amounts are parsed from text without floating point, and every total is a sum of
  // integers. Dates are local YYYY-MM-DD strings and all day maths is calendar maths (no clock, no time zone).
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const M = () => L.metrics;
  const STATUSES = Object.freeze(['expected', 'received', 'written-off']);
  const KEY_RE = /^[0-9a-f]{64}$/;
  const ENTRY_CAP = 50000, LIVE_PROJECT_CAP = 200, PROJECT_TOTAL_CAP = 2000;
  const BIDI = /[؜​-‏‪-‮⁠-⁩﻿]/g;

  const isMoney = (e) => !!e && e.domain === 'money' && (e.type === 'income' || e.type === 'expense');
  // Counted in Money actuals: expenses, and income that is received (or has no status, which means received).
  const isCounted = (e) => isMoney(e) && (e.type === 'expense' || !e.status || e.status === 'received');
  const isExpected = (e) => !!e && e.domain === 'money' && e.type === 'income' && e.status === 'expected';
  const cents = (v) => Math.round(Number(v) * 100);
  const dueOf = (e) => e.dueDate || e.date;
  const normName = (s) => String(s == null ? '' : s).replace(BIDI, '').replace(/\s+/g, ' ').trim().toLowerCase();

  // Integer rounding of a/b to the nearest, halves away from zero, exact for any size (BigInt).
  function divRound(a, b) {
    if (!b) return null;
    let n = BigInt(a), d = BigInt(b), neg = false;
    if (n < 0n) { n = -n; neg = !neg; }
    if (d < 0n) { d = -d; neg = !neg; }
    const q = (2n * n + d) / (2n * d);
    return Number(neg ? -q : q);
  }
  // Margin in basis points (1234 = 12.34%), or null when there is no revenue (never a divide by zero).
  const marginBp = (rev, net) => (rev > 0 ? divRound(net * 10000, rev) : null);
  const marginText = (bp) => (bp === null || bp === undefined ? 'no data' : (bp < 0 ? '-' : '') + Math.floor(Math.abs(bp) / 100) + '.' + String(Math.abs(bp) % 100).padStart(2, '0') + '%');

  // ---- lines of work ----
  function index(state) {
    const projects = Array.isArray(state.projects) ? state.projects : [];
    const byId = new Map(projects.map((p) => [p.id, p]));
    const kids = new Map();
    for (const p of projects) if (p.parentId && byId.has(p.parentId)) { if (!kids.has(p.parentId)) kids.set(p.parentId, []); kids.get(p.parentId).push(p); }
    return { projects, byId, kids, state };
  }
  // scope: {kind:'all'} | {kind:'line', id} | {kind:'rollup', id} (the line and its children) | {kind:'unassigned'}
  function pred(ix, scope) {
    if (!scope || scope.kind === 'all') return () => true;
    if (scope.kind === 'unassigned') return (x) => !x.projectId || !ix.byId.has(x.projectId);
    const ids = new Set([scope.id]);
    if (scope.kind === 'rollup') for (const c of ix.kids.get(scope.id) || []) ids.add(c.id);
    return (x) => !!x.projectId && ids.has(x.projectId);
  }
  const scopeOf = (projectId, rollup) => (projectId ? { kind: rollup ? 'rollup' : 'line', id: projectId } : { kind: 'all' });

  // ---- periods ----
  function periodRange(kind, today, custom) {
    const m = M();
    if (!m.isDate(today)) throw new Error('today must be YYYY-MM-DD');
    const mo = today.slice(0, 7);
    switch (kind) {
      case 'month': return { from: mo + '-01', to: m.monthEnd(mo) };
      case 'lastMonth': { const p = m.addMonths(mo, -1); return { from: p + '-01', to: m.monthEnd(p) }; }
      case 'qtd': { const q = Math.floor((+today.slice(5, 7) - 1) / 3) * 3 + 1; return { from: today.slice(0, 5) + String(q).padStart(2, '0') + '-01', to: today }; }
      case 'ytd': return { from: today.slice(0, 4) + '-01-01', to: today };
      case 't12': return { from: m.addMonths(mo, -11) + '-01', to: today };
      case 'custom': {
        if (!custom || !m.isDate(custom.from) || !m.isDate(custom.to)) throw new Error('Enter a start and an end date.');
        if (custom.to < custom.from) throw new Error('The end date is before the start date.');
        return { from: custom.from, to: custom.to };
      }
    }
    throw new Error('Unknown period');
  }
  const PERIODS = Object.freeze([['month', 'This month'], ['lastMonth', 'Last month'], ['qtd', 'Quarter to date'], ['ytd', 'Year to date'], ['t12', 'Trailing 12 months'], ['custom', 'Custom']]);

  // ---- totals ----
  const zero = () => ({ revenueCents: 0, expenseCents: 0 });
  const fin = (o) => Object.assign(o, { netCents: o.revenueCents - o.expenseCents, marginBp: marginBp(o.revenueCents, o.revenueCents - o.expenseCents) });
  // v1.2.0 part B: figures of archived entries come back from the yearly summaries, month by month. `add(projectId|'', rev, exp, n)` is called for
  // each archived month inside [from, to] (a project that no longer exists counts as Unassigned, like a live entry). A range that cuts an
  // archived month in two cannot be split, so that month is left out and `partial` says so.
  function archivedInto(ix, from, to, add, scopePred) {
    const A = L.archive, out = { partial: false };
    if (!A) return out;
    const m = M();
    for (const mo of A.archivedMonths(ix.state)) {
      const first = mo + '-01', last = m.monthEnd(mo);
      if (last < from || first > to) continue;
      if (first < from || last > to) { out.partial = true; continue; }
      const rm = A.revenueMonth(ix.state, mo);
      for (const k of Object.keys(rm)) {
        const pid = k && ix.byId.has(k) ? k : '';
        if (scopePred && !scopePred({ projectId: pid || undefined })) continue;
        add(pid, rm[k][0], rm[k][1], rm[k][2]);
      }
    }
    return out;
  }
  // One pass over the entries: per line, per rollup, unassigned and the grand total. The grand total is the sum of the lines plus
  // Unassigned, so it equals the Money totals for the same dates exactly.
  function report(state, period) {
    const ix = index(state), { from, to } = period;
    const own = new Map(), un = zero();
    for (const e of state.entries) {
      if (!isCounted(e) || e.date < from || e.date > to) continue;
      const c = cents(e.value), has = e.projectId && ix.byId.has(e.projectId);
      let o = un;
      if (has) { o = own.get(e.projectId); if (!o) { o = zero(); own.set(e.projectId, o); } }
      if (e.type === 'income') o.revenueCents += c; else o.expenseCents += c;
    }
    const part = archivedInto(ix, from, to, (pid, rev, exp) => { const o = pid ? (own.get(pid) || (own.set(pid, zero()), own.get(pid))) : un; o.revenueCents += rev; o.expenseCents += exp; });
    const total = zero();
    const lines = ix.projects.map((p) => {
      const o = Object.assign(zero(), own.get(p.id) || {});
      total.revenueCents += o.revenueCents; total.expenseCents += o.expenseCents;
      return fin({ id: p.id, name: p.name, kind: p.kind, parentId: p.parentId || null, archived: !!p.archived, revenueCents: o.revenueCents, expenseCents: o.expenseCents });
    });
    total.revenueCents += un.revenueCents; total.expenseCents += un.expenseCents;
    const byId = new Map(lines.map((x) => [x.id, x]));
    const rollups = [];
    for (const [pid, ch] of ix.kids) {
      const p = byId.get(pid), r = { id: pid, name: p.name, kind: p.kind, archived: p.archived, childIds: ch.map((c) => c.id), revenueCents: p.revenueCents, expenseCents: p.expenseCents };
      for (const c of ch) { const l = byId.get(c.id); r.revenueCents += l.revenueCents; r.expenseCents += l.expenseCents; }
      rollups.push(fin(r));
    }
    return Object.assign({ from, to, lines, rollups, unassigned: fin(Object.assign({ id: null, name: 'Unassigned' }, un)), total: fin(total) }, part.partial ? { archivedPartial: true } : {});
  }
  // Month by month for one scope, ending at endMonth (YYYY-MM), n months (default 12).
  function monthly(state, scope, endMonth, n) {
    const m = M();
    n = Math.max(1, Math.min(60, Math.floor(Number(n)) || 12));
    if (typeof endMonth !== 'string' || !/^\d{4}-\d{2}$/.test(endMonth) || !m.isDate(endMonth + '-01')) throw new Error('Month must be YYYY-MM');
    const ix = index(state), p = pred(ix, scope), map = new Map(), out = [];
    for (let i = n - 1; i >= 0; i--) { const mo = m.addMonths(endMonth, -i), o = { month: mo, revenueCents: 0, expenseCents: 0 }; map.set(mo, o); out.push(o); }
    for (const e of state.entries) {
      if (!isCounted(e) || !p(e)) continue;
      const o = map.get(e.date.slice(0, 7));
      if (!o) continue;
      if (e.type === 'income') o.revenueCents += cents(e.value); else o.expenseCents += cents(e.value);
    }
    if (L.archive) for (const mo of map.keys()) {
      const rm = L.archive.revenueMonth(state, mo);
      if (!rm) continue;
      for (const k of Object.keys(rm)) { const pid = k && ix.byId.has(k) ? k : undefined; if (!p({ projectId: pid })) continue; map.get(mo).revenueCents += rm[k][0]; map.get(mo).expenseCents += rm[k][1]; }
    }
    return out.map(fin);
  }
  // Recurring monthly revenue: active recurring income items, each turned into a monthly amount (weekly x 52 / 12, yearly / 12).
  function recurringMonthlyCents(state, scope) {
    const ix = index(state), p = pred(ix, scope);
    let sum = 0;
    for (const r of state.recurring || []) {
      if (!r.active || r.type !== 'income' || !p(r)) continue;
      const c = cents(r.value);
      sum += r.cadence === 'weekly' ? divRound(c * 52, 12) : r.cadence === 'yearly' ? divRound(c, 12) : c;
    }
    return sum;
  }
  // Expected income: windows are cumulative (next 30 days is inside next 60); overdue means the due date has passed.
  function expected(state, scope, today) {
    const m = M();
    if (!m.isDate(today)) throw new Error('today must be YYYY-MM-DD');
    const ix = index(state), p = pred(ix, scope), d30 = m.addDays(today, 30), d60 = m.addDays(today, 60), d90 = m.addDays(today, 90);
    const o = { next30Cents: 0, next60Cents: 0, next90Cents: 0, overdueCents: 0, overdueCount: 0, overdue: [], upcoming: [] };
    for (const e of state.entries) {
      if (!isExpected(e) || !p(e)) continue;
      const due = dueOf(e), c = cents(e.value), item = { id: e.id, title: e.title, cents: c, due, projectId: e.projectId || null };
      if (due < today) { o.overdueCents += c; o.overdueCount++; o.overdue.push(item); continue; }
      if (due <= d90) o.upcoming.push(item);
      if (due <= d30) o.next30Cents += c;
      if (due <= d60) o.next60Cents += c;
      if (due <= d90) o.next90Cents += c;
    }
    const by = (a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title);
    o.overdue.sort(by); o.upcoming.sort(by);
    return o;
  }
  function totalsIn(state, scope, from, to) {
    const ix = index(state), p = pred(ix, scope), o = zero();
    let n = 0;
    for (const e of state.entries) {
      if (!isCounted(e) || e.date < from || e.date > to || !p(e)) continue;
      n++;
      if (e.type === 'income') o.revenueCents += cents(e.value); else o.expenseCents += cents(e.value);
    }
    const part = archivedInto(ix, from, to, (pid, rev, exp, k) => { o.revenueCents += rev; o.expenseCents += exp; n += k; }, p);
    return Object.assign(fin(o), { count: n }, part.partial ? { archivedPartial: true } : {});
  }

  // ---- digest (numbers only; main state only, the caller passes it) ----
  function digest(state, ws) {
    const m = M(), we = m.addDays(ws, 6), mo = we.slice(0, 7), all = { kind: 'all' };
    const wk = totalsIn(state, all, ws, we), mn = totalsIn(state, all, mo + '-01', m.monthEnd(mo)), ex = expected(state, all, we);
    return {
      revenueWeekCents: wk.revenueCents, expensesWeekCents: wk.expenseCents, netWeekCents: wk.netCents,
      revenueMonthCents: mn.revenueCents, expensesMonthCents: mn.expenseCents, netMonthCents: mn.netCents,
      expectedNext30Cents: ex.next30Cents, overdueCount: ex.overdueCount,
      lines: (state.projects || []).filter((p) => !p.archived).length,
    };
  }
  // Goal metric (dollars): revenue or net received in the month of asOf for one line or rollup; null (no data yet) with no money in it.
  function goalValue(state, metric, projectId, rollup, asOf) {
    const m = M(), mo = asOf.slice(0, 7), t = totalsIn(state, scopeOf(projectId, rollup), mo + '-01', m.monthEnd(mo));
    if (!t.count) return null;
    return (metric === 'revenueMonth' ? t.revenueCents : t.netCents) / 100;
  }

  // ---- weekly review: received this week, overdue expected; actions are offered, never run here ----
  function reviewWeek(state, wk, today) {
    const m = M(), ws = m.weekStart(wk), we = m.addDays(ws, 6);
    const t = totalsIn(state, { kind: 'all' }, ws, we);
    const ex = expected(state, { kind: 'all' }, today && m.isDate(today) ? today : we);
    return { week: ws, receivedCents: t.revenueCents, overdue: ex.overdue, overdueCents: ex.overdueCents };
  }

  // ---- mutators (run inside a commit; each follows one user tap) ----
  const findExpected = (state, id) => {
    const e = state.entries.find((x) => x.id === id);
    if (!e) throw new Error('Entry not found');
    if (!isExpected(e)) throw new Error('That income is not marked expected');
    return e;
  };
  function markReceived(state, id, onDate) {
    const e = findExpected(state, id);
    if (!M().isDate(onDate)) throw new Error('Date received must be a date');
    e.status = 'received'; e.date = onDate;
    return e;
  }
  function moveDue(state, id, due) {
    const e = findExpected(state, id);
    if (!M().isDate(due)) throw new Error('Due date must be a date');
    e.dueDate = due;
    return e;
  }
  function writeOff(state, id) {
    const e = findExpected(state, id);
    e.status = 'written-off';
    return e;
  }
  // Entries (income and expense) matching a filter: { type, from, to, text, line: 'any' | 'none' | projectId }.
  function filterEntries(state, f) {
    f = f || {};
    const ix = index(state), q = normName(f.text);
    return state.entries.filter((e) => {
      if (!isMoney(e)) return false;
      if (f.type && f.type !== 'any' && e.type !== f.type) return false;
      if (f.from && e.date < f.from) return false;
      if (f.to && e.date > f.to) return false;
      if (q && !normName(e.title).includes(q)) return false;
      const has = e.projectId && ix.byId.has(e.projectId);
      if (f.line === 'none' && has) return false;
      if (f.line && f.line !== 'any' && f.line !== 'none' && e.projectId !== f.line) return false;
      return true;
    });
  }
  // Bulk assign: set (or with null clear) the line of work on the given entries. Returns how many changed.
  function assignLine(state, ids, projectId) {
    if (!Array.isArray(ids)) throw new Error('Nothing to assign');
    if (projectId) {
      const p = (state.projects || []).find((x) => x.id === projectId);
      if (!p) throw new Error('Line of work not found');
      if (p.archived) throw new Error('That line of work is archived');
    }
    const set = new Set(ids);
    let n = 0;
    for (const e of state.entries) {
      if (!set.has(e.id) || !isMoney(e)) continue;
      if (projectId) { if (e.projectId !== projectId) { e.projectId = projectId; n++; } } else if (e.projectId) { delete e.projectId; n++; }
    }
    return n;
  }
  // What deleting or archiving a project touches (for the confirm text).
  function linkedCounts(state, id) {
    return {
      entries: state.entries.filter((e) => e.projectId === id).length,
      recurring: (state.recurring || []).filter((r) => r.projectId === id).length,
      children: (state.projects || []).filter((p) => p.parentId === id).length,
      goals: (state.goals || []).filter((g) => g.projectId === id).length,
    };
  }
  function unlinkChildren(state, id) {
    let n = 0;
    for (const p of state.projects || []) if (p.parentId === id) { delete p.parentId; n++; }
    return n;
  }
  // Deleting a project unlinks everything that pointed at it (entries, recurring items, goal scopes, children); nothing is deleted with it.
  function unlinkProject(state, id) {
    const o = { entries: 0, recurring: 0, children: 0, goals: 0 };
    for (const e of state.entries) if (e.projectId === id) { delete e.projectId; o.entries++; }
    for (const r of state.recurring || []) if (r.projectId === id) { delete r.projectId; o.recurring++; }
    for (const g of state.goals || []) if (g.projectId === id) { delete g.projectId; delete g.rollup; o.goals++; }
    o.children = unlinkChildren(state, id);
    return o;
  }
  // Archiving a parent unlinks its children; money entries keep their link so history stays attributed.
  function archiveProject(state, id) {
    const p = (state.projects || []).find((x) => x.id === id);
    if (!p) throw new Error('Project not found');
    p.archived = true;
    return unlinkChildren(state, id);
  }
  // One level only: the parent must exist, not be archived, not be this project, not itself have a parent; this project must have no children.
  function setParent(state, id, parentId) {
    const ps = state.projects || [], p = ps.find((x) => x.id === id);
    if (!p) throw new Error('Project not found');
    if (!parentId) { delete p.parentId; return p; }
    const par = ps.find((x) => x.id === parentId);
    if (!par) throw new Error('Parent not found');
    if (parentId === id) throw new Error('A line cannot be its own parent');
    if (par.archived) throw new Error('The parent cannot be archived');
    if (par.parentId) throw new Error('Lines nest one level only');
    if (ps.some((x) => x.parentId === id)) throw new Error('This line already has lines under it, so it cannot have a parent');
    p.parentId = parentId;
    return p;
  }

  // ---- ledger CSV import ----
  // Amount text to integer cents with no floating point. Accepts currency symbols, thousands separators (1,234.56), a sign, and
  // parentheses for negatives. Returns null when the text is not an amount.
  function parseCents(raw) {
    if (typeof raw !== 'string') return null;
    let s = raw.replace(BIDI, '').replace(/[\s ]/g, '');
    if (!s || s.length > 40) return null;
    let neg = false;
    const par = /^\((.*)\)$/.exec(s);
    if (par) { neg = true; s = par[1]; }
    let sign = '';
    if (s[0] === '-' || s[0] === '+') { sign = s[0]; s = s.slice(1); }
    s = s.replace(/^[$€£¥]/, '');
    if (!sign && (s[0] === '-' || s[0] === '+')) { sign = s[0]; s = s.slice(1); }
    if (par && sign) return null;
    if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$|^\.\d{1,2}$/.test(s)) return null;
    s = s.replace(/,/g, '');
    const dot = s.indexOf('.'), ip = dot < 0 ? s : s.slice(0, dot), fp = dot < 0 ? '' : s.slice(dot + 1);
    if (ip.length > 12) return null;
    const c = (ip ? Number(ip) : 0) * 100 + Number((fp + '00').slice(0, 2));
    return neg || sign === '-' ? -c : c;
  }
  // Date text to YYYY-MM-DD. YYYY-MM-DD and M/D/YYYY always; D/M/YYYY only when fmt is 'dmy' (the user picked it; never guessed).
  function parseDate(raw, fmt) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    let y, mo, d, m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) { y = m[1]; mo = m[2]; d = m[3]; } else {
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
      if (!m) return null;
      y = m[3];
      if (fmt === 'dmy') { d = m[1]; mo = m[2]; } else { mo = m[1]; d = m[2]; }
      mo = mo.padStart(2, '0'); d = d.padStart(2, '0');
    }
    const out = y + '-' + mo + '-' + d;
    return M().isDate(out) ? out : null;
  }
  async function sha256Hex(text) {
    const buf = await L._webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    let h = '';
    for (const b of new Uint8Array(buf)) h += b.toString(16).padStart(2, '0');
    return h;
  }
  // importKey: SHA-256 of normalised date, amount (cents), type, line name and description. A row repeated within one file gets its
  // occurrence number added from the second copy on, so two identical purchases on one day both import and a re-import adds nothing.
  const importKey = (date, amountCents, type, line, desc, occurrence) =>
    sha256Hex([date, String(amountCents), type, normName(line), normName(desc)].concat(occurrence > 0 ? [String(occurrence)] : []).join('\u001f'));

  const tidy = (v) => String(v == null ? '' : v).replace(BIDI, '').replace(/^'(?=[=+\-@\t\r\n])/, '').replace(/\s+/g, ' ').trim();
  function statusOf(raw) {
    const s = normName(raw).replace(/[ _]/g, '-');
    if (!s) return '';
    if (s === 'received' || s === 'paid') return 'received';
    if (s === 'expected' || s === 'pending' || s === 'invoiced') return 'expected';
    if (s === 'written-off' || s === 'writtenoff') return 'written-off';
    return null;
  }
  const SECRET_MSG = 'looks like an ID or card number';
  // Preview of a ledger import. Writes nothing. opts: { map:{date, amount, income, expense, type, line, category, description, status, due}
  // (column indexes), dateFormat:'auto'|'dmy', typeValues:{income, expense} (text in the type column), create:[line names to create] }.
  async function plan(parsed, opts, state, today) {
    const m = M();
    if (!parsed || !Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) throw new Error('Nothing to import');
    if (!opts || typeof opts.map !== 'object' || !opts.map) throw new Error('Column mapping required');
    const map = {}, nh = parsed.headers.length;
    for (const k of ['date', 'amount', 'income', 'expense', 'type', 'line', 'category', 'description', 'status', 'due']) {
      const v = opts.map[k];
      if (v === undefined || v === null || v === '') continue;
      if (!Number.isInteger(v) || v < 0 || v >= nh) throw new Error('Column not found for ' + k);
      map[k] = v;
    }
    const fmt = opts.dateFormat === 'dmy' ? 'dmy' : 'auto';
    if (map.date === undefined) throw new Error('Choose the date column.');
    const split = map.income !== undefined || map.expense !== undefined, typed = !split && map.type !== undefined;
    if (split && map.amount !== undefined) throw new Error('Use either an amount column or separate income and expense columns, not both.');
    if (!split && map.amount === undefined) throw new Error('Choose the amount column, or the income and expense columns.');
    const tv = opts.typeValues || {};
    if (typed && (!normName(tv.income) || !normName(tv.expense) || normName(tv.income) === normName(tv.expense))) throw new Error('Say which type values mean income and expense.');
    // PV-1: the main state alone cannot tell which rows were already imported and then moved into the private vault, nor which line
    // names belong to private lines of work. While private entries or lines are hidden, the preview refuses (writes and adds nothing).
    const pm = state.priv && Array.isArray(state.priv.marks) ? state.priv.marks : [];
    if (pm.includes('entries') || pm.includes('projects')) {
      return { rows: parsed.rows.length, add: [], rejected: [], duplicates: 0, totals: { incomeCents: 0, expenseCents: 0 }, byLine: [], unknownLines: [], newLines: [], empty: true, blocked: 'private' };
    }
    const ix = index(state), live = ix.projects.filter((p) => !p.archived);
    const byName = new Map();
    for (const p of live) { const k = normName(p.name); if (!byName.has(k)) byName.set(k, p); }
    const have = new Set();
    for (const e of state.entries) if (e.importKey) have.add(e.importKey);
    const create = new Set((opts.create || []).map(normName));
    const seenInFile = new Map(), unknown = new Map(), newLines = new Map();
    const add = [], rejected = [], byLine = new Map();
    let duplicates = 0;
    const totals = { incomeCents: 0, expenseCents: 0 };
    for (let i = 0; i < parsed.rows.length; i++) {
      const r = parsed.rows[i], rowNo = i + 2;
      const reject = (why) => rejected.push({ row: rowNo, reason: why });
      if (!Array.isArray(r) || r.length !== nh) { reject('wrong number of columns'); continue; }
      const cell = (k) => (map[k] === undefined ? '' : tidy(r[map[k]]));
      const date = parseDate(cell('date'), fmt);
      if (!date) { reject(fmt === 'dmy' ? 'date is not a valid DD/MM/YYYY or YYYY-MM-DD date' : 'date is not a valid YYYY-MM-DD or MM/DD/YYYY date'); continue; }
      let type, c;
      if (split) {
        const inc = cell('income'), exp = cell('expense');
        const ci = inc ? parseCents(inc) : 0, ce = exp ? parseCents(exp) : 0;
        if (ci === null || ce === null) { reject('amount is not a number'); continue; }
        if (ci < 0 || ce < 0) { reject('amount is negative in an income or expense column'); continue; }
        if (ci > 0 && ce > 0) { reject('both income and expense have an amount'); continue; }
        if (ci === 0 && ce === 0) { reject('amount is zero or empty'); continue; }
        type = ci > 0 ? 'income' : 'expense'; c = ci > 0 ? ci : ce;
      } else {
        const a = parseCents(cell('amount'));
        if (a === null) { reject('amount is not a number'); continue; }
        if (a === 0) { reject('amount is zero'); continue; }
        if (typed) {
          const t = normName(cell('type'));
          if (t === normName(tv.income)) type = 'income'; else if (t === normName(tv.expense)) type = 'expense';
          else { reject('type is not one of the chosen income or expense values'); continue; }
          if (a < 0) { reject('amount is negative with a type column'); continue; }
          c = a;
        } else { type = a > 0 ? 'income' : 'expense'; c = Math.abs(a); }
      }
      if (c > 100000000000000) { reject('amount is too large'); continue; }
      const desc = cell('description'), cat = cell('category'), lineRaw = cell('line');
      if (desc.length > 200) { reject('description is longer than 200 characters'); continue; }
      if (cat.length > 40) { reject('category is longer than 40 characters'); continue; }
      if (lineRaw.length > 200) { reject('line of work is longer than 200 characters'); continue; }
      if (L.admin && [desc, cat, lineRaw].some((x) => L.admin.looksSecretText(x))) { reject(SECRET_MSG); continue; }
      let status = statusOf(cell('status')), dueDate = '';
      if (status === null) { reject('status is not received, expected or written-off'); continue; }
      if (type === 'expense' && status && status !== 'received') { reject('only income can be expected or written off'); continue; }
      if (type === 'income' && cell('due')) {
        dueDate = parseDate(cell('due'), fmt);
        if (!dueDate) { reject('due date is not a valid date'); continue; }
      }
      const nk = normName(lineRaw);
      let proj = null, newLine = '';
      if (nk) {
        proj = byName.get(nk) || null;
        if (!proj) { if (!unknown.has(nk)) unknown.set(nk, lineRaw); if (create.has(nk)) { newLine = nk; if (!newLines.has(nk)) newLines.set(nk, lineRaw); } }
      }
      const base = [date, c, type, nk, normName(desc)].join('\u001f'), occ = seenInFile.get(base) || 0;
      seenInFile.set(base, occ + 1);
      const key = await importKey(date, c, type, lineRaw, desc, occ);
      if (have.has(key)) { duplicates++; continue; }
      const p = { domain: 'money', type, date, title: desc || cat || (type === 'income' ? 'Income' : 'Expense'), value: c / 100, importKey: key };
      if (cat) p.category = cat;
      if (type === 'income' && status && status !== 'received') p.status = status;
      if (type === 'income' && dueDate) p.dueDate = dueDate;
      if (proj) p.projectId = proj.id;
      let entry;
      try { entry = m.validateEntry(p); } catch (e) { reject(String(e.message || 'invalid row').slice(0, 120)); continue; }
      add.push({ entry, newLine });
      const label = proj ? proj.name : newLine ? newLines.get(newLine) : 'Unassigned';
      const g = byLine.get(label) || { line: label, incomeCents: 0, expenseCents: 0, count: 0 };
      if (type === 'income') { g.incomeCents += c; totals.incomeCents += c; } else { g.expenseCents += c; totals.expenseCents += c; }
      g.count++; byLine.set(label, g);
    }
    if (state.entries.length + add.length > ENTRY_CAP) throw new Error('This import would pass the ' + ENTRY_CAP + ' entry limit.');
    if (live.length + newLines.size > LIVE_PROJECT_CAP || ix.projects.length + newLines.size > PROJECT_TOTAL_CAP) throw new Error('Creating these lines of work would pass the project limit.');
    return {
      rows: parsed.rows.length, add, rejected, duplicates, totals, byLine: [...byLine.values()].sort((a, b) => a.line.localeCompare(b.line)),
      unknownLines: [...unknown.values()], newLines: [...newLines.values()],
      empty: add.length === 0,
    };
  }
  // Apply a confirmed plan inside a commit. New lines (only those the user ticked) are created first.
  function applyPlan(state, pl, now) {
    if (!pl || !Array.isArray(pl.add)) throw new Error('Nothing to import');
    if (pl.blocked) return { added: 0, linesCreated: 0 };
    const created = new Map();
    for (const name of pl.newLines || []) {
      const p = { id: L.store.newId(), name, kind: 'client', status: 'active', nextAction: '', archived: false };
      state.projects.push(p); created.set(normName(name), p.id);
    }
    const stamp = now || new Date().toISOString();
    let n = 0;
    for (const a of pl.add) {
      const e = Object.assign({}, a.entry);
      if (a.newLine) e.projectId = created.get(a.newLine);
      e.createdAt = stamp;
      state.entries.push(M().validateEntry(e));
      n++;
    }
    return { added: n, linesCreated: created.size };
  }

  L.revenue = {
    STATUSES, PERIODS, KEY_RE, isMoney, isCounted, isExpected, dueOf, divRound, marginBp, marginText, normName, index, scopeOf, periodRange, report, monthly,
    recurringMonthlyCents, expected, totalsIn, digest, goalValue, reviewWeek, markReceived, moveDue, writeOff, filterEntries, assignLine, linkedCounts,
    unlinkProject, archiveProject, setParent, parseCents, parseDate, importKey, plan, applyPlan, tidy, sha256Hex,
  };
})();
