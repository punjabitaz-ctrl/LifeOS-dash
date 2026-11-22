(function () {
  'use strict';
  // v1.2.0 part B: vault archiving. One encrypted file per year (`lifeos-archive-YYYY.json`), a verified copy, then one commit that removes
  // the year's finished records from the live vault and writes numbers-only yearly summaries that the views read for archived months.
  // Nothing leaves the live vault unless the file was written, decrypted back, and matched by counts and SHA-256, and at least one copy
  // (Drive re-download, or a download the user confirms saving) is verified. A failure at any step leaves the live vault untouched.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const V = () => L.vault, S = () => L.store;
  const MAX_FILE = 64 * 1024 * 1024, KEEP_YEARS = 2, MB = 1048576;
  const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const yr = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? +d.slice(0, 4) : null);
  const bad = (m) => { const e = new Error(m); e.code = 'ARCHIVE'; return e; };
  const NOT_FILE = (y) => bad('That is not a valid LifeOS archive file' + (y ? ' for ' + y : '') + '.');
  const fileName = (y) => 'lifeos-archive-' + y + '.json';
  const M = () => L.metrics;

  // ---- what can be archived ----
  const hasLink = (e) => e.billable && !e.billedInvoiceId;
  function entryYear(e) {
    if (e.domain === 'money') {
      if (e.type === 'expense') return hasLink(e) ? null : yr(e.date);
      if (e.type === 'income') return !e.status || e.status === 'received' || e.status === 'written-off' ? yr(e.date) : null;
      return null;
    }
    if (e.domain === 'assets' && e.type === 'balance') return yr(e.date);
    if (e.domain === 'health' && ['workout', 'sleep', 'weight', 'bodyfat'].includes(e.type)) return yr(e.date);
    // Public mood entries (from before the private vault) are not archived: Wellbeing writes only go to the private vault.
    return null;
  }
  const spanYear = (a) => { const y = yr(a.endDate || a.date); return y === yr(a.date) ? y : null; };
  const DEFS = [
    { name: 'entries', get: (s) => s.entries || [], key: (r) => r.id, year: entryYear },
    { name: 'invoices', get: (s) => s.invoices || [], key: (r) => r.id, year: (r) => (r.status === 'paid' ? Math.max(yr(r.issueDate), yr(r.paidOn)) : r.status === 'void' ? yr(r.issueDate) : null) },
    { name: 'taxPayments', get: (s) => s.taxPayments || [], key: (r) => r.id, year: (r) => Math.max(r.year, yr(r.paidOn)) },
    { name: 'trips', get: (s) => s.trips || [], key: (r) => r.id, year: (r) => yr(r.date) },
    { name: 'contacts', get: (s) => s.contacts || [], key: (r) => r.id, year: (r) => yr(r.date) },
    { name: 'studySessions', get: (s) => s.studySessions || [], key: (r) => r.id, year: (r) => yr(r.date) },
    { name: 'habitLog', get: (s) => s.habitLog || [], key: (r) => r.habitId + '|' + r.date, year: (r) => yr(r.date) },
    { name: 'activities', get: (s) => s.activities || [], key: (r) => r.id, year: (r) => (r.state === 'done' || r.state === 'skipped' ? spanYear(r) : null) },
    { name: 'maintenance', get: (s) => s.maintenance || [], key: (r) => r.id, year: (r) => (r.state === 'done' && r.lastDone ? yr(r.lastDone) : null) },
    { name: 'renewals', get: (s) => s.renewals || [], key: (r) => r.id, year: (r) => (r.state === 'done' ? yr(r.doneOn || r.dueDate) : null) },
    { name: 'reviews', get: (s) => (s.memory && s.memory.reviews) || [], key: (r) => r.id, year: (r) => yr(r.weekOf) },
    { name: 'insights', get: (s) => (s.memory && s.memory.insights) || [], key: (r) => r.id, year: (r) => (r.status === 'approved' || r.status === 'rejected' ? yr(r.period && r.period.to) : null) },
  ];
  const NAMES = DEFS.map((d) => d.name);
  const DEF = Object.fromEntries(DEFS.map((d) => [d.name, d]));
  const setList = (st, name, list) => {
    if (name === 'reviews' || name === 'insights') st.memory[name] = list;
    else st[name] = list;
  };

  // ---- canonical form and SHA-256 ----
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (isObj(v)) return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  async function sha256(text) {
    const d = await L._webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const sorted = (def, list) => list.slice().sort((a, b) => (def.key(a) < def.key(b) ? -1 : def.key(a) > def.key(b) ? 1 : 0));
  const countsOf = (recs) => { const o = {}; for (const n of NAMES) if (recs[n] && recs[n].length) o[n] = recs[n].length; return o; };
  const sameCounts = (a, b) => canon(a) === canon(b);

  // ---- validation of stored index and summaries ----
  function cleanArchives(list) {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > 200) throw new Error('Invalid data: archives');
    const seen = new Set();
    return list.map((x) => {
      if (!isObj(x) || !Number.isInteger(x.year) || x.year < 1900 || x.year > 2200 || seen.has(x.year)) throw new Error('Invalid data: archive entry');
      seen.add(x.year);
      if (typeof x.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(x.sha256)) throw new Error('Invalid data: archive hash');
      if (typeof x.createdAt !== 'string' || x.createdAt.length > 40) throw new Error('Invalid data: archive date');
      if (!isObj(x.counts)) throw new Error('Invalid data: archive counts');
      const counts = {};
      for (const k of Object.keys(x.counts)) {
        if (!NAMES.includes(k) || !Number.isInteger(x.counts[k]) || x.counts[k] < 1 || x.counts[k] > 1e7) throw new Error('Invalid data: archive counts');
        counts[k] = x.counts[k];
      }
      if (!Array.isArray(x.copies) || x.copies.length > 20) throw new Error('Invalid data: archive copies');
      const copies = x.copies.map((c) => {
        if (!isObj(c) || !['drive', 'nas', 'download'].includes(c.where) || typeof c.at !== 'string' || c.at.length > 40 || typeof c.verified !== 'boolean') throw new Error('Invalid data: archive copy');
        return { where: c.where, at: c.at, verified: c.verified };
      });
      return { year: x.year, createdAt: x.createdAt, sha256: x.sha256, counts, copies };
    }).sort((a, b) => a.year - b.year);
  }
  // Numbers only: an object tree whose leaves are finite numbers. Keys are month keys, category names, project ids and fixed labels.
  function numTree(x, depth, budget) {
    if (depth > 6 || --budget.n < 0) throw new Error('Invalid data: summary too large');
    if (typeof x === 'number') { if (!isFinite(x) || Math.abs(x) > 1e15) throw new Error('Invalid data: summary number'); return x; }
    if (Array.isArray(x)) { if (x.length > 8) throw new Error('Invalid data: summary list'); return x.map((v) => { if (typeof v !== 'number' || !isFinite(v) || Math.abs(v) > 1e15) throw new Error('Invalid data: summary number'); return v; }); }
    if (!isObj(x)) throw new Error('Invalid data: summary');
    const o = {};
    for (const k of Object.keys(x)) {
      if (BLOCKED.has(k) || k.length > 100) throw new Error('Invalid data: summary key');
      o[k] = numTree(x[k], depth + 1, budget);
    }
    return o;
  }
  function cleanSummaries(s, archives) {
    if (s === undefined) return {};
    if (!isObj(s)) throw new Error('Invalid data: summaries');
    const years = new Set((archives || []).map((a) => String(a.year))), out = {};
    for (const y of Object.keys(s)) {
      if (!/^\d{4}$/.test(y) || !years.has(y)) throw new Error('Invalid data: summary year');
      const t = s[y];
      if (!isObj(t) || t.v !== 1) throw new Error('Invalid data: summary');
      for (const k of Object.keys(t)) if (!['v', 'money', 'assets', 'revenue', 'health', 'learning', 'activities', 'social'].includes(k)) throw new Error('Invalid data: summary section');
      out[y] = numTree(t, 0, { n: 40000 });
    }
    return out;
  }
  // SEC-85: the private vault keeps its own yearly figures (what its archived records added) inside its encrypted plaintext. Same shape.
  function cleanPrivSummaries(s) {
    if (s === undefined) return undefined;
    if (!isObj(s) || Object.keys(s).length > 200) throw new Error('Invalid data: private summaries');
    const out = {};
    for (const y of Object.keys(s)) {
      if (!/^\d{4}$/.test(y)) throw new Error('Invalid data: summary year');
      const t = s[y];
      if (!isObj(t) || t.v !== 1) throw new Error('Invalid data: summary');
      for (const k of Object.keys(t)) if (!['v', 'money', 'assets', 'revenue', 'health', 'learning', 'activities', 'social'].includes(k)) throw new Error('Invalid data: summary section');
      out[y] = numTree(t, 0, { n: 40000 });
    }
    return out;
  }
  // Leaf-wise a + sign * b over two summary trees (numbers, short number lists, objects).
  function combine(a, b, sign) {
    if (typeof a === 'number' || typeof b === 'number') return (typeof a === 'number' ? a : 0) + sign * (typeof b === 'number' ? b : 0);
    if (Array.isArray(a) || Array.isArray(b)) { const x = a || [], y = b || [], o = []; for (let i = 0; i < Math.max(x.length, y.length); i++) o.push((x[i] || 0) + sign * (y[i] || 0)); return o; }
    const o = {}, A0 = isObj(a) ? a : {}, B0 = isObj(b) ? b : {};
    for (const k of new Set(Object.keys(A0).concat(Object.keys(B0)))) { if (BLOCKED.has(k)) continue; o[k] = combine(A0[k], B0[k], sign); }
    return o;
  }
  function prune(t) {
    if (typeof t === 'number') return t === 0 ? undefined : t;
    if (Array.isArray(t)) return t.some((v) => v !== 0) ? t : undefined;
    const o = {};
    for (const k of Object.keys(t)) { const v = prune(t[k]); if (v !== undefined) o[k] = v; }
    return Object.keys(o).length ? o : undefined;
  }
  // The view's summaries while the private vault is open: public figures plus the private vault's own, for archived years only.
  function addSummaries(pub, priv, archives) {
    const out = Object.assign({}, pub || {}), ys = new Set((archives || []).map((a) => String(a.year)));
    for (const y of Object.keys(priv || {})) if (ys.has(y)) out[y] = Object.assign(combine(out[y] || {}, priv[y], 1), { v: 1 });
    return out;
  }
  const isArchivedYear = (state, y) => !!(state && Array.isArray(state.archives) && state.archives.some((a) => a.year === Number(y)));

  // ---- readers used by the views (additive: archived records are gone from the live lists, so their figures are added back) ----
  const sumOf = (state, y) => (state && state.summaries && state.summaries[y]) || null;
  function monthAdd(state, month) {
    const s = sumOf(state, String(month).slice(0, 4)), m = s && s.money && s.money.months && s.money.months[month];
    return m ? { inc: m.inc || 0, exp: m.exp || 0, cats: m.cats || {}, hasExp: !!m.hasExp } : null;
  }
  const hasExpense = (state, month) => { const a = monthAdd(state, month); return !!(a && a.hasExp); };
  // Net worth as it stood at the end of an archived month (not additive: the balances that made it are archived).
  function netWorthAt(state, asOf) {
    const s = sumOf(state, String(asOf).slice(0, 4));
    if (!s || !s.assets || !s.assets.months) return null;
    const ms = Object.keys(s.assets.months).filter((m) => M().monthEnd(m) <= asOf).sort();
    if (!ms.length) return { assets: 0, liab: 0, count: 0 };
    const m = s.assets.months[ms[ms.length - 1]];
    return { assets: m.assets || 0, liab: m.liab || 0, count: m.count || 0 };
  }
  function revenueMonth(state, month) {
    const s = sumOf(state, String(month).slice(0, 4)), m = s && s.revenue && s.revenue.months && s.revenue.months[month];
    return m || null;
  }
  // Study minutes per week of archived years (the weekly streak reads back through them).
  function weekMinutes(state) {
    const out = new Map();
    for (const y of Object.keys((state && state.summaries) || {})) { const w = state.summaries[y].learning && state.summaries[y].learning.weeks; if (w) for (const k of Object.keys(w)) out.set(k, w[k]); }
    return out;
  }
  // Worth-it ratings of archived activities, month by month, up to a date (the goal averages every rated activity so far).
  function ratingTotals(state, asOf) {
    let n = 0, sum = 0;
    for (const y of Object.keys((state && state.summaries) || {})) {
      const ms = state.summaries[y].activities && state.summaries[y].activities.months;
      if (ms) for (const m of Object.keys(ms)) if (M().monthEnd(m) <= asOf) { n += ms[m].rated || 0; sum += ms[m].ratedSum || 0; }
    }
    return { n, sum };
  }
  const archivedMonths = (state) => { const out = []; for (const y of Object.keys((state && state.summaries) || {})) { const r = state.summaries[y].revenue; if (r && r.months) out.push(...Object.keys(r.months)); } return out; };

  // ---- planning ----
  // Strings found anywhere in a record (ids it points at). Used to keep everything a live record refers to.
  function strings(v, into, depth) {
    if (depth > 8) return;
    if (typeof v === 'string') { into.add(v); return; }
    if (Array.isArray(v)) { for (const x of v) strings(x, into, depth + 1); return; }
    if (isObj(v)) for (const k of Object.keys(v)) strings(v[k], into, depth + 1);
  }
  const MONEY_REFS = {
    activities: (r) => [r.expenseId],
    invoices: (r) => [r.incomeId].concat((Array.isArray(r.lines) ? r.lines : []).map((l) => l && l.expenseId)),
    entries: (r) => [r.billedInvoiceId],
  };
  // SEC-88: Wellbeing check-ins of a year that may move: never the newest one (existence and "this week" checks) and never a daily run
  // that reaches into the next year (the streak).
  function wbMovable(list, year) {
    const by = new Map(list.map((c) => [c.date, c])), keep = new Set();
    let newest = null;
    for (const c of list) if (!newest || c.date > newest.date) newest = c;
    if (newest) keep.add(newest);
    for (const c of list) if (c.date.slice(5) === '12-31' && by.has(M().addDays(c.date, 1))) for (let x = c.date; by.has(x); x = M().addDays(x, -1)) keep.add(by.get(x));
    return list.filter((c) => yr(c.date) === year && !keep.has(c));
  }
  const SKIP_TOP = new Set(['archives', 'summaries', 'audit', 'priv', 'schema', 'sourceSchema']);
  // The records that must stay whatever their date: the newest of each kind (existence checks, "start" values, last-contact dates, moving
  // averages), the balance each account carries forward, and the last of an unbroken daily run that reaches the next year (streaks).
  function anchors(state) {
    const keep = new Set(), asc = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    const E = (state.entries || []).filter((e) => entryYear(e) !== null);
    const newest = (list, n, df) => { df = df || ((r) => r.date); for (const r of list.slice().sort((a, b) => asc(df(b), df(a))).slice(0, n)) keep.add(r); };
    const oldest = (list, n) => { for (const r of list.slice().sort((a, b) => asc(a.date, b.date)).slice(0, n)) keep.add(r); };
    for (const t of ['workout', 'sleep', 'mood']) newest(E.filter((e) => e.type === t), 1);
    for (const t of ['weight', 'bodyfat']) { const l = E.filter((e) => e.type === t); newest(l, 7); oldest(l, 1); }
    newest(E.filter((e) => e.domain === 'money' && e.type === 'expense'), 1);
    newest(E.filter((e) => e.domain === 'money' && e.type === 'income'), 1);
    // Balances: the latest per account (or title) is what later months carry forward; ties all stay.
    const accts = state.accounts || [], byId = new Map(accts.map((a) => [a.id, a])), byName = new Map();
    for (const a of accts) { const k = a.name.trim().toLowerCase(); if (!byName.has(k)) byName.set(k, a); }
    const lastBal = new Map();
    for (const e of E.filter((x) => x.type === 'balance')) {
      const a = (e.accountId && byId.get(e.accountId)) || byName.get(e.title.trim().toLowerCase()) || null, k = a ? 'a:' + a.id : 't:' + e.title.trim().toLowerCase();
      const cur = lastBal.get(k);
      if (!cur || e.date > cur.date) lastBal.set(k, { date: e.date, list: [e] }); else if (e.date === cur.date) cur.list.push(e);
    }
    for (const v of lastBal.values()) for (const e of v.list) keep.add(e);
    // Last contact per person, last session per item, newest of the rest.
    const latestBy = (list, keyFn, df) => {
      df = df || ((r) => r.date);
      const m = new Map();
      for (const r of list) { const k = keyFn(r); if (k === null) continue; const c = m.get(k); if (!c || df(r) > df(c)) m.set(k, r); }
      for (const r of m.values()) keep.add(r);
    };
    latestBy(state.contacts || [], (c) => c.personId || '');
    latestBy(state.studySessions || [], (s) => s.itemId || '');
    newest(state.studySessions || [], 1);
    newest(state.contacts || [], 1);
    const acts = (state.activities || []).filter((a) => a.state === 'done'), endOf = (a) => a.endDate || a.date;
    newest(acts, 1, endOf);
    newest(acts.filter((a) => a.alsoHealth), 1, endOf);
    const byPerson = new Map();
    for (const a of acts) for (const p of a.withPeople || []) { const n = String(p).toLowerCase(), c = byPerson.get(n); if (!c || endOf(a) > endOf(c)) byPerson.set(n, a); }
    for (const a of byPerson.values()) keep.add(a);
    latestBy((state.maintenance || []).filter((m) => m.state === 'done' && m.lastDone), (m) => (m.propertyId || m.vehicleId || '') + '|' + String(m.title).toLowerCase(), (m) => m.lastDone);
    latestBy((state.renewals || []).filter((r) => r.state === 'done'), (r) => String(r.title).toLowerCase(), (r) => r.doneOn || r.dueDate);
    // The last tick of each daily check, and the unbroken run of ticks ending on 31 December when the next day is ticked too.
    const ticks = state.habitLog || [], byHabit = new Map();
    for (const t of ticks) { if (!byHabit.has(t.habitId)) byHabit.set(t.habitId, new Map()); byHabit.get(t.habitId).set(t.date, t); }
    newest(ticks, 1);
    for (const m of byHabit.values()) {
      let last = null; for (const d of m.keys()) if (!last || d > last) last = d;
      if (last) keep.add(m.get(last));
      for (const [d] of m) {
        if (d.slice(5) !== '12-31' || !m.has(M().addDays(d, 1))) continue;
        for (let x = d; m.has(x); x = M().addDays(x, -1)) keep.add(m.get(x));
      }
    }
    // Reviews and approved insights the weekly loop still reads.
    newest(state.memory && state.memory.reviews || [], 8, (r) => r.weekOf);
    newest((state.memory && state.memory.insights || []).filter((x) => x.status === 'approved'), 8, (r) => (r.period && r.period.to) || '');
    return keep;
  }
  // The records of year `year` that may be archived now. `state` may be the merged view (public and private records).
  function plan(state, year, today) {
    const t = today || M().todayISO(), curY = +t.slice(0, 4);
    if (!Number.isInteger(year) || year >= curY - KEEP_YEARS) throw bad('Only years before ' + (curY - KEEP_YEARS) + ' can be archived. The current year and the two before it stay in the vault.');
    const keep = anchors(state);
    const cand = new Map(); // record object -> def
    for (const d of DEFS) for (const r of d.get(state)) if (!keep.has(r) && d.year(r) === year ) cand.set(r, d);
    // Fixed point: whatever a remaining record points at stays, and a kept record's own references stay too.
    const seen = new Set(), scanned = new Set();
    const addRemaining = (r) => { if (!scanned.has(r)) { scanned.add(r); strings(r, seen, 0); } };
    const walk = (v) => { for (const r of v) if (!cand.has(r)) addRemaining(r); };
    for (const k of Object.keys(state)) {
      if (SKIP_TOP.has(k)) continue;
      const v = state[k];
      if (k === 'memory') { for (const n of ['reviews', 'insights', 'lessons']) walk((v && v[n]) || []); continue; }
      if (Array.isArray(v)) walk(v); else if (isObj(v)) strings(v, seen, 0);
    }
    // SEC-84: a one-to-one money link (activity and its expense, invoice and its income or billed expenses, a billed expense and its
    // invoice) never splits: a record whose linked partner stays live stays too, whichever way the link points.
    const liveIds = new Set();
    for (const n of ['entries', 'invoices']) for (const r of DEF[n].get(state)) if (!cand.has(r) && r.id) liveIds.add(r.id);
    for (let changed = true; changed;) {
      changed = false;
      for (const [r, d] of cand) {
        const id = d.name === 'habitLog' ? null : r.id, refs = MONEY_REFS[d.name] ? MONEY_REFS[d.name](r) : [];
        if ((id && seen.has(id)) || refs.some((x) => x && liveIds.has(x))) {
          cand.delete(r); addRemaining(r); changed = true;
          if (id && (d.name === 'entries' || d.name === 'invoices')) liveIds.add(id);
        }
      }
    }
    const recs = {};
    for (const n of NAMES) recs[n] = [];
    const priv = {}; for (const n of NAMES) priv[n] = [];
    const isP = (r) => !!(L.priv && L.priv.isPrivateRecord && L.priv.isPrivateRecord(r));
    for (const [r, d] of cand) (isP(r) ? priv : recs)[d.name].push(r);
    return { year, recs, priv, count: cand.size };
  }

  // ---- summaries (public records only) ----
  function summarise(main, recs, year) {
    const M_ = M();
    const money = { months: {} }, revenue = { months: {} }, assets = { months: {} };
    const health = { months: {} }, learning = { months: {} }, activities = { months: {} }, social = { months: {} };
    const bump = (obj, m, k, v) => { const o = obj.months[m] || (obj.months[m] = {}); o[k] = (o[k] || 0) + v; };
    const counted = (e) => !e.status || e.status === 'received';
    for (const e of recs.entries) {
      const m = e.date.slice(0, 7);
      if (e.domain === 'money') {
        const c = Math.round(Number(e.value) * 100);
        const mm = money.months[m] || (money.months[m] = { inc: 0, exp: 0, hasExp: 0, cats: {} });
        if (e.type === 'income') { if (counted(e)) mm.inc += c; } else { mm.exp += c; mm.hasExp = 1; const k = e.category || 'Uncategorised'; mm.cats[k] = (mm.cats[k] || 0) + c; }
        if (counted(e)) {
          const rm = revenue.months[m] || (revenue.months[m] = {}), k = e.projectId || '', a = rm[k] || (rm[k] = [0, 0, 0]);
          if (e.type === 'income') a[0] += c; else a[1] += c;
          a[2] += 1;
        }
      } else if (e.domain === 'health') {
        if (e.type === 'workout') bump(health, m, 'workouts', 1);
        else if (e.type === 'sleep') { bump(health, m, 'sleepNights', 1); bump(health, m, 'sleepHours100', Math.round(e.value * 100)); }
      }
    }
    for (const s of recs.studySessions) {
      bump(learning, s.date.slice(0, 7), 'minutes', s.minutes); bump(learning, s.date.slice(0, 7), 'sessions', 1);
      const wk = M_.weekStart(s.date); learning.weeks = learning.weeks || {}; learning.weeks[wk] = (learning.weeks[wk] || 0) + s.minutes;
    }
    for (const a of recs.activities) { const m = a.date.slice(0, 7); if (a.state === 'done') { bump(activities, m, 'done', 1); if (typeof a.costCents === 'number') bump(activities, m, 'costCents', a.costCents); if (typeof a.worthIt === 'number') { bump(activities, m, 'rated', 1); bump(activities, m, 'ratedSum', a.worthIt); } } else bump(activities, m, 'skipped', 1); }
    for (const c of recs.contacts) bump(social, c.date.slice(0, 7), 'contacts', 1);
    // Net worth at the end of every month of the year, from the public records as they stand now.
    for (let i = 1; i <= 12; i++) {
      const m = year + '-' + String(i).padStart(2, '0'), d = M_.netWorthDetail(main, M_.monthEnd(m));
      assets.months[m] = { assets: d.assetsCents, liab: d.liabilitiesCents, count: d.count };
    }
    const out = { v: 1, assets };
    for (const [k, v] of [['money', money], ['revenue', revenue], ['health', health], ['learning', learning], ['activities', activities], ['social', social]]) if (Object.keys(v.months).length) out[k] = v;
    return out;
  }

  // ---- the file ----
  const recMap = (recs) => { const o = {}; for (const d of DEFS) if (recs[d.name] && recs[d.name].length) o[d.name] = sorted(d, recs[d.name]); return o; };
  async function build(pl, passphrase, wbCheckins, recoveryKey) {
    const pub = recMap(pl.recs), privRecs = recMap(pl.priv);
    const hasPriv = Object.keys(privRecs).length > 0 || (wbCheckins && wbCheckins.length > 0);
    const inner = { kind: 'lifeos-archive', v: 1, year: pl.year, createdAt: new Date().toISOString(), counts: countsOf(pub), records: pub };
    let privPlain = null;
    if (hasPriv) {
      privPlain = { records: privRecs, checkins: (wbCheckins || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1)) };
      privPlain.sha256 = await sha256(canon({ records: privPlain.records, checkins: privPlain.checkins }));
      privPlain.counts = Object.assign(countsOf(pl.priv), privPlain.checkins.length ? { checkins: privPlain.checkins.length } : {});
      inner.priv = await L.priv.sealBox(privPlain);
    }
    inner.sha256 = await sha256(canon({ records: pub }));
    // v1.8.0: a new data key for the file, wrapped under the passphrase and, when the vault has a recovery key on, under that key too (typed by
    // the owner and checked by the caller), each wrap with its own fresh salt.
    const env = await V().sealEnvelope(await V().newKeyset(passphrase, recoveryKey || null), inner, null, { arch: 1, year: pl.year });
    const text = JSON.stringify(env);
    if (text.length > MAX_FILE) throw bad('The archive for ' + pl.year + ' would be larger than 64 MB, so nothing was archived.');
    return { text, inner, privPlain, name: fileName(pl.year) };
  }
  // Strict parse of an untrusted archive file. Returns the decrypted public part (private box still sealed).
  async function parse(text, passphrase, year) {
    if (typeof text !== 'string' || text.length > MAX_FILE || !text.length) throw NOT_FILE(year);
    let env;
    try { env = JSON.parse(text); } catch (e) { throw NOT_FILE(year); }
    if (!isObj(env) || env.arch !== 1 || !Number.isInteger(env.year) || env.year < 1900 || env.year > 2200) throw NOT_FILE(year);
    if (env.fmt === undefined) for (const k of Object.keys(env)) if (!['v', 'kdf', 'iv', 'ct', 'arch', 'year'].includes(k)) throw NOT_FILE(year);
    if (year !== undefined && env.year !== year) throw NOT_FILE(year);
    try { V().parseEnvelope(env); } catch (e) { throw NOT_FILE(year); } // v2 files are parsed strictly: unknown fields refused
    let inner;
    try { inner = (await V().openEnvelope(env, passphrase)).raw; } catch (e) { throw bad('That passphrase did not work, or the archive file is damaged.'); }
    if (!isObj(inner) || inner.kind !== 'lifeos-archive' || inner.v !== 1 || inner.year !== env.year || !isObj(inner.records) || !isObj(inner.counts)) throw NOT_FILE(year);
    if (typeof inner.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(inner.sha256) || typeof inner.createdAt !== 'string' || inner.createdAt.length > 40) throw NOT_FILE(year);
    const budget = { n: 6e6 };
    (function scan(v, d) { if (d > 14 || --budget.n < 0) throw NOT_FILE(year); if (v && typeof v === 'object') for (const k of Object.keys(v)) { if (BLOCKED.has(k)) throw NOT_FILE(year); scan(v[k], d + 1); } })(inner, 0);
    for (const k of Object.keys(inner.records)) {
      if (!NAMES.includes(k) || !Array.isArray(inner.records[k]) || !inner.records[k].every(isObj)) throw NOT_FILE(year);
      if (inner.records[k].some((r) => DEF[k].year(r) !== env.year && !(k === 'entries' || k === 'habitLog'))) throw NOT_FILE(year);
    }
    for (const r of inner.records.entries || []) if (typeof r.date !== 'string' || yr(r.date) !== env.year) throw NOT_FILE(year);
    for (const r of inner.records.habitLog || []) if (typeof r.date !== 'string' || yr(r.date) !== env.year) throw NOT_FILE(year);
    if (!sameCounts(inner.counts, countsOf(inner.records))) throw NOT_FILE(year);
    if (inner.priv !== undefined && !(isObj(inner.priv) && (isObj(inner.priv.kdf) || Array.isArray(inner.priv.wraps)) && typeof inner.priv.iv === 'string' && typeof inner.priv.ct === 'string')) throw NOT_FILE(year);
    if (await sha256(canon({ records: recMap(inner.records) })) !== inner.sha256) throw bad('The archive file does not match its checksum.');
    return { year: env.year, inner, size: text.length };
  }
  async function openPrivate(parsed, privPass) {
    if (!parsed.inner.priv) return null;
    const p = await L.priv.openBox(parsed.inner.priv, privPass);
    if (!isObj(p) || !isObj(p.records) || !Array.isArray(p.checkins) || typeof p.sha256 !== 'string') throw NOT_FILE(parsed.year);
    for (const k of Object.keys(p.records)) if (!NAMES.includes(k) || !Array.isArray(p.records[k])) throw NOT_FILE(parsed.year);
    if (await sha256(canon({ records: recMap(p.records), checkins: p.checkins })) !== p.sha256) throw bad('The private part of the archive does not match its checksum.');
    return p;
  }
  // Decrypt a file back and compare it with what was meant to be written (counts and SHA-256, public and private).
  async function verify(text, passphrase, pl, built) {
    const parsed = await parse(text, passphrase, pl.year);
    if (!sameCounts(parsed.inner.counts, built.inner.counts) || parsed.inner.sha256 !== built.inner.sha256) throw bad('The archive file did not match the records, so nothing was removed.');
    if (built.privPlain) {
      const p = await openPrivate(parsed);
      if (!p || p.sha256 !== built.privPlain.sha256 || !sameCounts(p.counts, built.privPlain.counts)) throw bad('The private part of the archive file did not match, so nothing was removed.');
    } else if (parsed.inner.priv) throw bad('The archive file did not match the records, so nothing was removed.');
    return true;
  }

  // ---- archiving ----
  function liveView() {
    const st = S().getState();
    return L.priv && L.priv.isOpen() ? L.priv.view(st) : st;
  }
  function privateGate(st) {
    if (L.priv && st.priv && Array.isArray(st.priv.marks) && st.priv.marks.length && !L.priv.isOpen()) {
      throw bad('Open the private vault first. It may hold records of that year, and an archive file has to take them along.');
    }
  }
  // Years that can be archived now (earlier than the current year minus two), with what each would move.
  function archivable(state, today) {
    const t = today || M().todayISO(), curY = +t.slice(0, 4), have = new Set((state.archives || []).map((a) => a.year)), years = new Set();
    for (const d of DEFS) for (const r of d.get(state)) { const y = d.year(r); if (y !== null && y < curY - KEEP_YEARS && !have.has(y)) years.add(y); }
    return [...years].sort((a, b) => a - b);
  }
  const sizeOf = (recs) => { let n = 0; for (const k of Object.keys(recs)) for (const r of recs[k]) n += JSON.stringify(r).length; return n; };
  // The automatic proposal: shown when the encrypted vault passes the size setting or the year before last year's window has just become archivable.
  function propose(state, envBytes, today) {
    const t = today || M().todayISO(), curY = +t.slice(0, 4), mb = (state.settings && state.settings.archiveSuggestMB) || 40;
    const years = archivable(state, t), over = envBytes > mb * MB, fresh = years.includes(curY - KEEP_YEARS - 1);
    if (!years.length || !(over || fresh)) return null;
    const rows = years.map((y) => { const p = plan(state, y, t); return { year: y, records: p.count, freeBytes: Math.round(sizeOf(p.recs) * 4 / 3) }; }).filter((r) => r.records > 0);
    if (!rows.length) return null;
    return { over, fresh, mb, envBytes, years: rows, freeBytes: rows.reduce((a, r) => a + r.freeBytes, 0) };
  }
  async function envelopeBytes() {
    const env = await S()._rawEnvelope();
    return env ? JSON.stringify(env).length : 0;
  }

  const planKey = async (pl, wb) => sha256(canon({ y: pl.year, ids: NAMES.map((n) => [n, sorted(DEF[n], pl.recs[n].concat(pl.priv[n])).map(DEF[n].key)]), wb: (wb || []).map((c) => c.id) }));
  // With a recovery key on, the file must carry it, so the owner types it; it is checked against the vault's own wrap and never stored.
  async function recoveryFor(text) {
    if (!S().hasRecovery()) return null;
    if (typeof text !== 'string' || !text) throw bad('Type your recovery key so the archive file carries it.');
    let ok = false;
    try { ok = await S().recoveryMatches(text); } catch (e) { throw bad('That recovery key has a typo. Check it and try again.'); }
    if (!ok) throw bad('That is not your current recovery key.');
    return text;
  }
  // opts: { year, passphrase, recoveryKey (needed when a recovery key is on), today, drive: bool, nas: bool, download: bool, io: { put(name,text), get(name), nasPut(name,text), nasGet(name), save(name,text), confirmSaved() } }
  // Returns { year, counts, copies }. Throws (leaving the vault untouched) when any step fails or no copy is verified.
  async function archiveYear(opts) {
    const st0 = S().getState(), year = opts.year, today = opts.today || M().todayISO();
    if (isArchivedYear(st0, year)) throw bad(year + ' is already archived. Restore it first to archive it again.');
    if (!(await S().matchesMain(opts.passphrase))) throw bad('That is not your main passphrase.');
    const rk = await recoveryFor(opts.recoveryKey);
    privateGate(st0);
    const openP = L.priv && L.priv.isOpen();
    const view = openP ? L.priv.view(st0) : st0;
    const pl = plan(view, year, today);
    const wb = openP ? wbMovable(L.priv.getWellbeing().checkins || [], year) : [];
    if (!pl.count && !wb.length) throw bad('There is nothing to archive for ' + year + '.');
    const main = openP ? L.priv.mainOnly(view) : view;
    // Public figures from the public records as the main state holds them (no link overlay to a private record); the private vault's
    // own figures (SEC-85) are what the merged view adds on top, kept inside the private vault.
    const mainRecs = {};
    for (const n of NAMES) { const by = new Map(DEF[n].get(main).map((r) => [DEF[n].key(r), r])); mainRecs[n] = pl.recs[n].map((r) => by.get(DEF[n].key(r)) || r); }
    const summary = summarise(main, mainRecs, year);
    let privSummary;
    if (openP) {
      const all = {};
      for (const n of NAMES) all[n] = pl.recs[n].concat(pl.priv[n]);
      const d = prune(combine(summarise(view, all, year), summary, -1));
      if (d) { delete d.v; if (Object.keys(d).length) privSummary = Object.assign({ v: 1 }, d); }
    }
    const key0 = await planKey(pl, wb);
    const built = await build(pl, opts.passphrase, wb, rk);
    await verify(built.text, opts.passphrase, pl, built);
    const copies = [], io = opts.io || {};
    const at = () => new Date().toISOString();
    if (opts.drive) {
      try {
        await io.put(built.name, built.text);
        const back = await io.get(built.name);
        await verify(back, opts.passphrase, pl, built);
        copies.push({ where: 'drive', at: at(), verified: true });
      } catch (e) { if (!opts.download && !opts.nas) throw e; }
    }
    // v2.0.0: a NAS copy counts like a Drive copy: written, downloaded again, decrypted and matched by counts and SHA-256.
    if (opts.nas) {
      try {
        await io.nasPut(built.name, built.text);
        const back = await io.nasGet(built.name);
        await verify(back, opts.passphrase, pl, built);
        copies.push({ where: 'nas', at: at(), verified: true });
      } catch (e) { if (!opts.download && !copies.length) throw e; }
    }
    if (opts.download) {
      io.save(built.name, built.text);
      if (await io.confirmSaved()) copies.push({ where: 'download', at: at(), verified: true });
    }
    if (!copies.length) throw bad('No verified copy of the archive exists, so nothing was removed. Save the file, then confirm it.');
    const entry = { year, createdAt: built.inner.createdAt, sha256: built.inner.sha256, counts: built.inner.counts, copies };
    await L.priv.write(async (work, wbObj) => {
      // Everything is judged again inside the commit: if the vault changed since the file was written, nothing is removed.
      const pl2 = plan(work, year, today);
      const wb2 = wbObj && Array.isArray(wbObj.checkins) ? wbMovable(wbObj.checkins, year) : [];
      const same = canon({ y: pl2.year, ids: NAMES.map((n) => [n, sorted(DEF[n], pl2.recs[n].concat(pl2.priv[n])).map(DEF[n].key)]), wb: wb2.map((c) => c.id) });
      if ((await sha256(same)) !== key0) throw bad('Your data changed while the archive was being made. Nothing was removed. Run it again.');
      const gone = new Set();
      for (const n of NAMES) for (const r of pl2.recs[n].concat(pl2.priv[n])) gone.add(r);
      for (const d of DEFS) { const list = d.get(work); setList(work, d.name, list.filter((r) => !gone.has(r))); }
      if (wbObj && wb2.length) { const ids = new Set(wb2.map((c) => c.id)); wbObj.checkins = wbObj.checkins.filter((c) => !ids.has(c.id)); if (!wbObj.checkins.length) delete wbObj.checkins; }
      work.archives = (work.archives || []).concat([entry]);
      work.summaries = Object.assign({}, work.summaries || {}, { [year]: summary });
      work.audit = (work.audit || []).concat([{ ts: new Date().toISOString(), action: 'archived ' + year }]).slice(-200);
    }, privSummary ? { summaries: { set: { [year]: privSummary } } } : undefined);
    return { year, counts: entry.counts, copies: entry.copies, privateIncluded: !!built.privPlain };
  }

  // ---- open read-only, search, restore ----
  let opened = null;
  function drop() { if (opened) { opened.records = null; opened.priv = null; } opened = null; }
  async function openArchive(text, passphrase, year, privPass) {
    drop();
    const parsed = await parse(text, passphrase, year);
    let priv = null, privNote = parsed.inner.priv ? 'closed' : 'none';
    if (parsed.inner.priv && L.priv && L.priv.isOpen()) {
      try { priv = await openPrivate(parsed, privPass); privNote = 'open'; } catch (e) { if (e.code === 'NEED_PRIVATE_PASSPHRASE') privNote = 'needs-passphrase'; else throw e; }
    }
    opened = { year: parsed.year, createdAt: parsed.inner.createdAt, counts: parsed.inner.counts, records: parsed.inner.records, priv, privNote, raw: text };
    return info();
  }
  const info = () => (opened ? { year: opened.year, createdAt: opened.createdAt, counts: Object.assign({}, opened.counts), privNote: opened.privNote, privateCounts: opened.priv ? Object.assign({}, opened.priv.counts) : null } : null);
  const isOpenArchive = () => !!opened;
  function recordsOf(name) {
    if (!opened) throw bad('No archive is open.');
    const out = (opened.records[name] || []).slice();
    if (opened.priv && opened.priv.records[name]) out.push(...opened.priv.records[name]);
    return out;
  }
  const flat = (r) => { const s = new Set(); strings(r, s, 0); return [...s].join(' ').toLowerCase(); };
  function search(name, q) {
    const list = name === 'checkins' ? (opened && opened.priv ? opened.priv.checkins : []) : recordsOf(name);
    const t = String(q || '').trim().toLowerCase();
    return t ? list.filter((r) => flat(r).includes(t)) : list.slice();
  }
  const sections = () => (opened ? NAMES.filter((n) => recordsOf(n).length).concat(opened.priv && opened.priv.checkins.length ? ['checkins'] : []) : []);
  // A read-only copy of the live state with the open archive's records merged in, for the existing accountant export of that year.
  // SEC-87: without includePrivate it is built from the main state and the file's public records only, and it refuses (as the tax views
  // do for a live year, SEC-76) when the file's private part may hold a business record of the year: always while that part is sealed.
  // With includePrivate (private vault open and the private part opened) every record is in and the copy has no private vault left.
  const BIZ_PRIV = ['entries', 'invoices', 'trips', 'taxPayments'];
  function exportState(includePrivate) {
    if (!opened) throw bad('No archive is open.');
    const openP = !!(L.priv && L.priv.isOpen());
    if (includePrivate && opened.privNote !== 'none' && !(openP && opened.priv)) throw bad('Open the private vault and open the archive again to include its private records.');
    const st = JSON.parse(JSON.stringify(includePrivate && openP ? L.priv.view(S().getState()) : S().getState()));
    const have = {};
    st.archives = (st.archives || []).filter((a) => a.year !== opened.year);
    if (st.summaries) delete st.summaries[opened.year];
    for (const d of DEFS) { have[d.name] = new Set(d.get(st).map(d.key)); }
    const extra = (name) => (opened.records[name] || []).concat(includePrivate && opened.priv && opened.priv.records[name] ? opened.priv.records[name] : []);
    for (const d of DEFS) { const add = extra(d.name).filter((r) => !have[d.name].has(d.key(r))); setList(st, d.name, d.get(st).concat(JSON.parse(JSON.stringify(add)))); }
    if (includePrivate) { delete st.priv; return st; }
    const privBiz = opened.privNote !== 'none' && (!opened.priv || BIZ_PRIV.some((n) => (opened.priv.records[n] || []).some((r) => n !== 'entries' || (r.domain === 'money' && (r.type === 'income' || r.type === 'expense') && (r.scope === 'business' || (!r.scope && r.projectId))))));
    if (privBiz) {
      const m = 'business-' + opened.year;
      if (st.priv && Array.isArray(st.priv.marks)) { if (!st.priv.marks.includes(m)) st.priv.marks.push(m); }
      else throw bad('This archive holds private records of ' + opened.year + ' that cannot be opened here, so an export without them would be incomplete.');
    }
    return st;
  }
  // Restore: records go back into the live vault, deduplicated by id, never overwriting a live record. Needs the main passphrase and
  // (when the file has a private part) the open private vault. The archive's index entry and summary are removed in the same write.
  // SEC-128: fileSecret ({ recovery }, optional) opens a file sealed under an earlier main passphrase with the recovery key it carries;
  // the current main passphrase is still required.
  async function restoreYear(text, passphrase, year, privPass, fileSecret) {
    if (typeof passphrase !== 'string' || !(await S().matchesMain(passphrase))) throw bad('That is not your main passphrase.');
    // SEC-89: with private records hidden, a restored record's link to one of them could not be kept; open the vault first.
    privateGate(S().getState());
    const parsed = await parse(text, fileSecret && typeof fileSecret === 'object' ? { recovery: fileSecret.recovery } : passphrase, year);
    let p = null;
    if (parsed.inner.priv) {
      if (!L.priv || !L.priv.isOpen()) throw bad('Open the private vault first: this archive holds private records.');
      p = await openPrivate(parsed, privPass);
    }
    // Which private records are really new, judged on the merged view (public and private together) before anything is written.
    const view = L.priv && L.priv.isOpen() ? L.priv.view(S().getState()) : S().getState();
    const live = {};
    for (const d of DEFS) live[d.name] = new Set(d.get(view).map(d.key));
    const moveIn = {};
    if (p) for (const d of DEFS) {
      if (!L.priv.COLLECTIONS.includes(d.name)) continue;
      const fresh = new Set((p.records[d.name] || []).map(d.key).filter((k) => !live[d.name].has(k)));
      if (fresh.size) moveIn[d.name] = fresh;
    }
    let added = 0, skipped = 0;
    await L.priv.write(async (work, wbObj) => {
      added = 0; skipped = 0;
      for (const [src, isPriv] of [[parsed.inner.records, false], [p && p.records, true]]) {
        if (!src) continue;
        for (const d of DEFS) {
          const list = d.get(work), have = new Set(list.map(d.key)), add = [];
          for (const r of src[d.name] || []) {
            const k = d.key(r);
            if (have.has(k) || (isPriv && !(moveIn[d.name] && moveIn[d.name].has(k)))) { skipped++; continue; }
            have.add(k); add.push(JSON.parse(JSON.stringify(r))); added++;
          }
          if (add.length) setList(work, d.name, list.concat(add));
        }
      }
      if (p && p.checkins.length && wbObj) {
        const have = new Set((wbObj.checkins || []).map((c) => c.id)), dates = new Set((wbObj.checkins || []).map((c) => c.date)), add = [];
        for (const c of p.checkins) { if (have.has(c.id) || dates.has(c.date)) { skipped++; continue; } add.push(JSON.parse(JSON.stringify(c))); added++; }
        if (add.length) wbObj.checkins = (wbObj.checkins || []).concat(add).sort((a, b) => (a.date < b.date ? -1 : 1));
      }
      work.archives = (work.archives || []).filter((a) => a.year !== parsed.year);
      const s2 = Object.assign({}, work.summaries || {}); delete s2[parsed.year]; work.summaries = s2;
      work.audit = (work.audit || []).concat([{ ts: new Date().toISOString(), action: 'restored ' + parsed.year }]).slice(-200);
    }, L.priv && L.priv.isOpen() ? { moveIn, summaries: { del: [String(parsed.year)] } } : undefined);
    return { year: parsed.year, added, skipped };
  }

  // ---- whether a copy brings archived years back ----
  // Years archived here that `next` (a backup or Drive copy) still holds records of, or has no archive index for.
  function comesBack(cur, next) {
    if (!cur || !next || !Array.isArray(cur.archives) || !cur.archives.length) return [];
    const mine = new Set();
    for (const d of DEFS) for (const r of d.get(cur)) mine.add(d.name + ':' + d.key(r));
    const theirIndex = new Set((next.archives || []).map((a) => a.year)), out = [];
    for (const a of cur.archives) {
      let back = !theirIndex.has(a.year);
      for (const d of DEFS) { if (back) break; for (const r of d.get(next)) if (d.year(r) === a.year && !mine.has(d.name + ':' + d.key(r))) { back = true; break; } }
      if (back) out.push(String(a.year));
    }
    return out;
  }

  L.archive = {
    NAMES, KEEP_YEARS, MAX_FILE, fileName, cleanArchives, cleanSummaries, isArchivedYear, monthAdd, hasExpense, netWorthAt, weekMinutes, ratingTotals, revenueMonth, archivedMonths,
    plan, archivable, propose, envelopeBytes, archiveYear, openArchive, closeArchive: drop, drop, info, isOpenArchive, recordsOf, search, sections, exportState,
    restoreYear, comesBack, parse, canon, sha256, summarise, cleanPrivSummaries, addSummaries,
  };
})();
