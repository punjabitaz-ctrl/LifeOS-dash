(function () {
  'use strict';
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const KEY = 'envelope';
  const ACCOUNT_CAP = 200, RECURRING_CAP = 500, BUDGET_CAP = 100, CATEGORY_CAP = 50, SCHEMA = 6, GOAL_CAP = 300, PROJECT_CAP = 200, PROJECT_TOTAL_CAP = 2000, PIPELINE_CAP = 1000;
  const HABIT_CAP = 8, HABIT_LOG_CAP = 100000, KIND_CAP = 30;
  const RENEWAL_TOTAL_CAP = 2000;
  const ENTRY_CAP = 50000, INSIGHT_CAP = 5000, REVIEW_CAP = 1000, LESSON_CAP = 30, AUDIT_CAP = 200;
  const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
  // Same rule as ai.isLocalUrl (ai.js loads after this file, so call it lazily).
  const BIDI = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
  const strip = (v) => (typeof v === 'string' ? v.replace(BIDI, '') : v);
  let adapter = null, key = null, salt = null, state = null, queue = Promise.resolve();
  // Sync metadata (rev etc.) travels outside AND inside the ciphertext; a mismatch means tampering. Missing = rev 0.
  let meta = { rev: 0, updatedAt: '', deviceId: '' }, deviceId = '';

  function idbAdapter() {
    const open = () => new Promise((res, rej) => {
      const r = indexedDB.open('lifeos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(new Error('STORAGE_ERROR'));
    });
    const tx = async (mode, fn) => {
      const db = await open();
      try {
        return await new Promise((res, rej) => {
          const t = db.transaction('kv', mode);
          const rq = fn(t.objectStore('kv'));
          t.oncomplete = () => res(rq && rq.result);
          t.onerror = t.onabort = () => rej(new Error('STORAGE_ERROR'));
        });
      } finally { db.close(); }
    };
    return {
      get: (k) => tx('readonly', (s) => s.get(k)),
      set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
      del: (k) => tx('readwrite', (s) => s.delete(k)),
    };
  }
  function getAdapter() {
    if (!adapter) {
      if (typeof indexedDB === 'undefined') throw new Error('NO_STORAGE');
      adapter = idbAdapter();
    }
    return adapter;
  }
  function _setAdapter(a) {
    if (!a || typeof a.get !== 'function' || typeof a.set !== 'function' || typeof a.del !== 'function') throw new Error('Bad adapter');
    adapter = a;
  }

  // ---- validation ----
  const fail = (m) => { throw new Error('Invalid data: ' + m); };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  function scan(v, depth, budget) {
    if (depth > 12) fail('nesting too deep');
    if (v === null || typeof v !== 'object') return;
    if (--budget.n < 0) fail('too large');
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) scan(v[i], depth + 1, budget); return; }
    for (const k of Object.keys(v)) {
      if (BLOCKED.has(k)) fail('forbidden key');
      scan(v[k], depth + 1, budget);
    }
  }
  function str(v, max, name, allowEmpty) {
    if (typeof v !== 'string') fail(name + ' must be text');
    if (v.length > max) fail(name + ' too long');
    if (!allowEmpty && v.length === 0) fail(name + ' is empty');
    return v;
  }
  function num(v, min, max, name, int) {
    if (typeof v !== 'number' || !isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) fail(name + ' out of range');
    return v;
  }
  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const t = Date.parse(s + 'T00:00:00Z');
    return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
  }
  const date = (v, name) => { if (!isDate(v)) fail(name + ' must be a date'); return v; };
  function ts(v, name) {
    if (typeof v === 'number' && isFinite(v)) return v;
    return str(v, 40, name);
  }
  function oneOf(v, list, name) { if (!list.includes(v)) fail(name + ' not allowed'); return v; }
  function arr(v, cap, name) {
    if (!Array.isArray(v)) fail(name + ' must be a list');
    if (v.length > cap) fail(name + ' has too many items');
    return v;
  }
  function domainIds() { return L.metrics.DOMAINS.map((d) => d.id); }

  function cleanSettings(s, schema) {
    if (!isObj(s)) fail('settings');
    const t = isObj(s.targets) ? s.targets : fail('targets');
    const p = isObj(s.provider) ? s.provider : fail('provider');
    const provider = {
      kind: oneOf(p.kind, ['none', 'anthropic', 'local', 'manual'], 'provider kind'),
      baseUrl: str(p.baseUrl, 200, 'baseUrl', true),
      model: str(p.model, 100, 'model', true),
      apiKey: str(p.apiKey, 300, 'apiKey', true),
    };
    if (provider.kind === 'local' && provider.baseUrl && !(L.ai && L.ai.isLocalUrl(provider.baseUrl))) fail('local provider must use localhost');
    if (typeof s.currency !== 'string' || !/^[A-Z]{3}$/.test(s.currency)) fail('currency');
    return {
      currency: s.currency,
      autoLockMin: Math.min(60, Math.max(1, num(s.autoLockMin, 1, 1440, 'autoLockMin', true))),
      targets: {
        workoutsPerWeek: num(t.workoutsPerWeek, 0, 21, 'workoutsPerWeek'),
        contactDays: num(t.contactDays, 1, 3650, 'contactDays', true),
        savingsRate: num(t.savingsRate, 0, 1, 'savingsRate'),
      },
      provider,
      sync: cleanSync(s.sync),
      health: schema >= 4 ? cleanHealthSettings(s.health) : { units: 'lb' },
      home: schema >= 6 ? cleanHomeSettings(s.home) : { starterDone: false },
    };
  }
  // 6 decimals, like converted weights, so a unit switch round trip does not drift.
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  function cleanHealthSettings(x) {
    if (x === undefined) return { units: 'lb' };
    if (!isObj(x)) fail('health settings');
    const o = { units: oneOf(x.units, ['lb', 'kg'], 'units') };
    for (const k of ['weightStart', 'weightTarget']) if (x[k] !== undefined && x[k] !== null) o[k] = r6(num(x[k], 1, 1000, k));
    for (const k of ['bodyFatStart', 'bodyFatTarget']) if (x[k] !== undefined && x[k] !== null) o[k] = r6(num(x[k], 1, 100, k));
    return o;
  }
  function cleanHomeSettings(x) {
    if (x === undefined) return { starterDone: false };
    if (!isObj(x)) fail('home settings');
    return { starterDone: bool(x.starterDone, 'starterDone', false) };
  }
  function cleanCycle(x) {
    if (x === undefined || x === null) return null;
    if (!isObj(x)) fail('cycle');
    return {
      startDate: date(x.startDate, 'cycle start'),
      sprintDays: num(x.sprintDays, 1, 365, 'sprintDays', true),
      sprintsPerCycle: num(x.sprintsPerCycle, 1, 52, 'sprintsPerCycle', true),
      restDays: num(x.restDays, 0, 90, 'restDays', true),
      alternateHeavyLight: bool(x.alternateHeavyLight, 'alternateHeavyLight'),
      firstWeek: oneOf(x.firstWeek, ['heavy', 'light'], 'firstWeek'),
    };
  }
  const clean = (v) => (typeof v === 'string' ? strip(v).trim() : v);
  function cleanKinds(list) {
    if (list === undefined) return L.metrics.DEFAULT_KINDS.slice();
    const seen = new Set();
    return arr(list, KIND_CAP, 'workout types').map((x) => {
      const v = str(clean(x), 40, 'workout type');
      if (seen.has(v.toLowerCase())) fail('duplicate workout type');
      seen.add(v.toLowerCase());
      return v;
    });
  }
  function cleanHabits(list) {
    if (list === undefined) return [];
    const seen = new Set();
    return arr(list, HABIT_CAP, 'daily checks').map((x) => {
      if (!isObj(x)) fail('daily check');
      const id = str(x.id, 100, 'habit id');
      if (seen.has(id)) fail('duplicate habit id');
      seen.add(id);
      return { id, name: str(clean(x.name), 60, 'habit name') };
    });
  }
  // A tick for a habit that no longer exists is dropped; repeats collapse to one.
  function cleanHabitLog(list, habits) {
    if (list === undefined) return [];
    const ids = new Set(habits.map((h) => h.id)), seen = new Set(), out = [];
    for (const x of arr(list, HABIT_LOG_CAP, 'habit log')) {
      if (!isObj(x)) fail('habit tick');
      const id = str(x.habitId, 100, 'habit id'), d = date(x.date, 'habit date'), k = id + '|' + d;
      if (!ids.has(id) || seen.has(k)) continue;
      seen.add(k); out.push({ habitId: id, date: d });
    }
    return out;
  }
  function cleanSync(x) {
    const d = { clientId: '', remoteRev: -1, fp: '', fileId: '', keySalt: '' };
    if (x === undefined) return d;
    if (!isObj(x)) fail('sync');
    const cid = str(x.clientId, 200, 'clientId', true);
    if (cid && !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(cid)) fail('clientId');
    const fp = str(x.fp, 64, 'fp', true), fid = str(x.fileId, 200, 'fileId', true);
    if (fp && !/^[0-9a-f]{64}$/.test(fp)) fail('fp');
    if (fid && !/^[A-Za-z0-9_-]{5,200}$/.test(fid)) fail('fileId');
    const ks = x.keySalt === undefined ? '' : str(x.keySalt, 24, 'keySalt', true);
    if (ks && !/^[A-Za-z0-9+/]{22}==$/.test(ks)) fail('keySalt');
    return { clientId: cid, remoteRev: num(x.remoteRev === undefined ? -1 : x.remoteRev, -1, 1e9, 'remoteRev', true), fp, fileId: fid, keySalt: ks };
  }
  function cleanEntryText(e) {
    if (!isObj(e)) return e;
    const o = Object.assign({}, e);
    for (const k of ['title', 'notes', 'person', 'status', 'category', 'kind']) if (typeof o[k] === 'string') o[k] = strip(o[k]);
    return o;
  }
  function cleanEntries(list) {
    arr(list, ENTRY_CAP, 'entries');
    const seen = new Set(), out = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      let e;
      try { e = L.metrics.validateEntry(cleanEntryText(list[i])); } catch (err) { fail('entry ' + (i + 1) + ': ' + err.message); }
      if (seen.has(e.id)) fail('duplicate entry id');
      seen.add(e.id);
      out[i] = e;
    }
    return out;
  }
  const STAGES = ['lead', 'contacted', 'applied', 'interview', 'offer', 'won', 'lost'];
  const PROJECT_KINDS = ['job', 'venture', 'client', 'personal'];
  const PIPELINE_KINDS = ['job', 'deal', 'partner'];
  function cleanProjects(list) {
    if (list === undefined) return [];
    const seen = new Set();
    arr(list, PROJECT_TOTAL_CAP, 'projects');
    // Archived projects do not count toward the 200 cap; a separate total cap keeps the list bounded.
    if (list.filter((x) => !(isObj(x) && x.archived === true)).length > PROJECT_CAP) fail('projects has too many items');
    return list.map((x) => {
      if (!isObj(x)) fail('project');
      const id = str(x.id, 100, 'project id');
      if (seen.has(id)) fail('duplicate project id');
      seen.add(id);
      const o = {
        id, name: str(strip(x.name).trim(), 200, 'project name'),
        kind: oneOf(x.kind, PROJECT_KINDS, 'project kind'),
        status: oneOf(x.status, ['active', 'paused', 'done'], 'project status'),
        nextAction: str(strip(x.nextAction === undefined ? '' : x.nextAction).trim(), 200, 'next action', true),
      };
      if (x.nextDate !== undefined && x.nextDate !== '') o.nextDate = date(x.nextDate, 'nextDate');
      o.archived = bool(x.archived, 'archived', false);
      return o;
    });
  }
  function cleanPipeline(list) {
    if (list === undefined) return [];
    const seen = new Set();
    return arr(list, PIPELINE_CAP, 'pipeline').map((x) => {
      if (!isObj(x)) fail('pipeline item');
      const id = str(x.id, 100, 'pipeline id');
      if (seen.has(id)) fail('duplicate pipeline id');
      seen.add(id);
      const t = (v, max, name, empty) => str(strip(v === undefined ? '' : v).trim(), max, name, empty);
      const o = {
        id, title: t(x.title, 200, 'pipeline title'), org: t(x.org, 200, 'org', true),
        kind: oneOf(x.kind, PIPELINE_KINDS, 'pipeline kind'), stage: oneOf(x.stage, STAGES, 'stage'),
        source: t(x.source, 200, 'source', true), nextStep: t(x.nextStep, 200, 'next step', true),
      };
      if (x.nextDate !== undefined && x.nextDate !== '') o.nextDate = date(x.nextDate, 'nextDate');
      o.updatedAt = date(x.updatedAt, 'updatedAt');
      o.notes = t(x.notes, 2000, 'notes', true);
      return o;
    });
  }
  function cleanDigest(d) {
    if (!isObj(d) || !isObj(d.domains)) fail('digest');
    const domains = {};
    for (const id of domainIds()) {
      const x = d.domains[id];
      if (x === undefined) continue;
      if (!isObj(x)) fail('digest domain');
      domains[id] = { now: num(x.now, -1e15, 1e15, 'digest'), prev: num(x.prev, -1e15, 1e15, 'digest'), unit: str(x.unit, 20, 'unit', true) };
    }
    const out = { week: date(d.week, 'digest week'), domains };
    if (d.money !== undefined) {
      if (!isObj(d.money)) fail('digest money');
      out.money = {};
      for (const k of ['income', 'spend', 'budgetUsedPct', 'netWorth', 'liabilities']) out.money[k] = num(d.money[k], -1e15, 1e15, 'digest money');
    }
    if (d.work !== undefined) {
      if (!isObj(d.work) || !isObj(d.work.pipeline)) fail('digest work');
      const w = {};
      for (const k of ['done', 'planned', 'activeProjects', 'overdueNext', 'moved']) w[k] = num(d.work[k], 0, 1e9, 'digest work', true);
      w.pipeline = {};
      for (const k of STAGES) w.pipeline[k] = num(d.work.pipeline[k], 0, 1e9, 'digest work', true);
      out.work = w;
    }
    if (d.health !== undefined) {
      if (!isObj(d.health)) fail('digest health');
      const x = d.health;
      out.health = {
        sessions: num(x.sessions, 0, 1e6, 'digest health', true), minutes: num(x.minutes, 0, 1e9, 'digest health'), avgSleep: num(x.avgSleep, 0, 24, 'digest health'),
        weightChange: num(x.weightChange, -1e4, 1e4, 'digest health'), habitRate: num(x.habitRate, 0, 100, 'digest health'),
      };
    }
    if (d.goals !== undefined) {
      if (!isObj(d.goals)) fail('digest goals');
      out.goals = {};
      for (const k of ['active', 'ahead', 'onTrack', 'behind', 'achieved']) out.goals[k] = num(d.goals[k], 0, 1e9, 'digest goals', true);
    }
    for (const k of ['home', 'admin']) {
      if (d[k] === undefined) continue;
      if (!isObj(d[k])) fail('digest ' + k);
      const x = d[k], o = {};
      for (const f of ['overdue', 'dueSoon', 'done']) o[f] = num(x[f], 0, 1e9, 'digest ' + k, true);
      const money = k === 'home' ? 'ytdCostCents' : 'runRateCents';
      o[money] = num(x[money], 0, Number.MAX_SAFE_INTEGER, 'digest ' + k, true); // 2,000 items at the per-item cap exceed 1e14
      out[k] = o;
    }
    return out;
  }
  function cleanMemory(m) {
    if (!isObj(m)) fail('memory');
    const doms = domainIds().concat(['overall']);
    const insights = arr(m.insights, INSIGHT_CAP, 'insights').map((x) => {
      if (!isObj(x) || !isObj(x.period)) fail('insight');
      const o = {
        id: str(x.id, 100, 'id'),
        level: oneOf(x.level, [1, 2, 3], 'level'),
        period: { from: date(x.period.from, 'period'), to: date(x.period.to, 'period') },
        domain: oneOf(x.domain, doms, 'domain'),
        text: str(strip(x.text), 280, 'text'),
        source: oneOf(x.source, ['rules', 'ai'], 'source'),
        status: oneOf(x.status, ['proposed', 'approved', 'rejected'], 'status'),
        createdAt: ts(x.createdAt, 'createdAt'),
      };
      if (x.decidedAt !== undefined) o.decidedAt = ts(x.decidedAt, 'decidedAt');
      return o;
    });
    const lessons = arr(m.lessons, LESSON_CAP, 'lessons').map((x) => {
      if (!isObj(x)) fail('lesson');
      return { id: str(x.id, 100, 'id'), text: str(strip(x.text), 280, 'lesson'), createdAt: ts(x.createdAt, 'createdAt') };
    });
    const reviews = arr(m.reviews, REVIEW_CAP, 'reviews').map((x) => {
      if (!isObj(x)) fail('review');
      return {
        id: str(x.id, 100, 'id'),
        weekOf: date(x.weekOf, 'weekOf'),
        digest: cleanDigest(x.digest),
        priorities: arr(x.priorities, 3, 'priorities').map((p) => str(strip(p), 200, 'priority', true)),
        completedAt: ts(x.completedAt, 'completedAt'),
      };
    });
    return { insights, lessons, reviews };
  }
  function cleanAudit(a) {
    if (a === undefined) return [];
    if (!Array.isArray(a)) fail('audit');
    return a.slice(-AUDIT_CAP).map((x) => {
      if (!isObj(x)) fail('audit item');
      return { ts: ts(x.ts, 'ts'), action: str(x.action, 100, 'action', true) };
    });
  }
  // ---- schema 2: accounts, recurring, budgets, categories ----
  const ACCOUNT_KINDS = ['cash', 'investment', 'retirement', 'property', 'vehicle', 'other', 'credit', 'loan', 'mortgage'];
  const LIAB_KINDS = ['credit', 'loan', 'mortgage'];
  const bool = (v, name, dflt) => { if (v === undefined && dflt !== undefined) return dflt; if (typeof v !== 'boolean') fail(name + ' must be true or false'); return v; };
  const money2 = (v, min, max, name) => Math.round(num(v, min, max, name) * 100) / 100;
  function cleanAccounts(list) {
    if (list === undefined) return [];
    const seen = new Set();
    return arr(list, ACCOUNT_CAP, 'accounts').map((x) => {
      if (!isObj(x)) fail('account');
      const id = str(x.id, 100, 'account id');
      if (seen.has(id)) fail('duplicate account id');
      seen.add(id);
      const kind = oneOf(x.kind, ACCOUNT_KINDS, 'account kind');
      const name = str(strip(x.name).trim(), 200, 'account name');
      return { id, name, kind, liability: LIAB_KINDS.includes(kind) ? true : bool(x.liability, 'liability'), archived: bool(x.archived, 'archived', false) };
    });
  }
  function cleanRecurring(list) {
    if (list === undefined) return [];
    const seen = new Set();
    return arr(list, RECURRING_CAP, 'recurring').map((x) => {
      if (!isObj(x)) fail('recurring item');
      const id = str(x.id, 100, 'recurring id');
      if (seen.has(id)) fail('duplicate recurring id');
      seen.add(id);
      return {
        id, title: str(strip(x.title).trim(), 200, 'recurring title'), value: money2(x.value, 0.01, 1e9, 'recurring value'),
        category: str(strip(x.category).trim(), 40, 'recurring category', true), type: oneOf(x.type, ['income', 'expense'], 'recurring type'),
        cadence: oneOf(x.cadence, ['weekly', 'monthly', 'yearly'], 'cadence'), nextDate: date(x.nextDate, 'nextDate'), active: bool(x.active, 'active'),
        household: bool(x.household, 'household', false)
      };
    });
  }
  function cleanBudgets(list) {
    if (list === undefined) return [];
    const seen = new Set();
    return arr(list, BUDGET_CAP, 'budgets').map((x) => {
      if (!isObj(x)) fail('budget');
      const category = str(strip(x.category).trim(), 40, 'budget category');
      if (seen.has(category)) fail('duplicate budget category');
      seen.add(category);
      return { category, value: money2(x.value, 0, 1e9, 'budget value') };
    });
  }
  function cleanCategories(c) {
    if (c === undefined) return defaultCategories();
    if (!isObj(c)) fail('categories');
    const one = (list, name) => {
      const seen = new Set();
      return arr(list, CATEGORY_CAP, name).map((x) => {
        const v = str(strip(x).trim(), 40, name);
        if (seen.has(v.toLowerCase())) fail('duplicate category');
        seen.add(v.toLowerCase());
        return v;
      });
    };
    return { expense: one(c.expense, 'expense categories'), income: one(c.income, 'income categories') };
  }
  function defaultCategories() {
    const d = L.metrics.DEFAULT_CATEGORIES;
    return { expense: d.expense.slice(), income: d.income.slice() };
  }
  // Schema 1 to 2: each distinct balance title becomes an account, and its entries point at it. Nothing is dropped.
  function deriveAccounts(entries) {
    const byTitle = new Map(), order = [];
    for (const e of entries) {
      if (e.type !== 'balance') continue;
      const k = e.title.trim().toLowerCase();
      let g = byTitle.get(k);
      if (!g) { g = { name: e.title.trim(), latest: e, list: [] }; byTitle.set(k, g); order.push(g); }
      g.list.push(e);
      if (e.date >= g.latest.date) g.latest = e;
    }
    const accounts = [];
    for (const g of order.slice(0, ACCOUNT_CAP)) {
      const liability = g.latest.value < 0;
      const a = { id: newId(), name: g.name, kind: liability ? 'credit' : 'other', liability, archived: false };
      accounts.push(a);
      for (const e of g.list) e.accountId = a.id;
    }
    return accounts;
  }

  // ---- schema 5: goals ----
  const gtext = (v, max, name, empty) => { if (v === undefined) v = ''; if (typeof v !== 'string') fail(name + ' must be text'); return str(strip(v).trim(), max, name, empty); };
  function cleanGoal(x, seen) {
    if (!isObj(x)) fail('goal');
    const G = L.goals;
    const id = str(x.id, 100, 'goal id');
    if (seen.has(id)) fail('duplicate goal id');
    seen.add(id);
    const metric = oneOf(x.metric, G.METRICS.map((m) => m.id), 'goal metric');
    const mdom = G.METRICS.find((m) => m.id === metric).domain;
    const o = {
      id, title: gtext(x.title, 200, 'goal title'),
      horizon: oneOf(x.horizon, G.HORIZONS, 'goal horizon'),
      domain: mdom || oneOf(x.domain, domainIds(), 'goal domain'),
      metric, direction: oneOf(x.direction, ['up', 'down'], 'goal direction'),
      startValue: num(x.startValue, -1e12, 1e12, 'goal start value'), targetValue: num(x.targetValue, -1e12, 1e12, 'goal target value'),
      startDate: date(x.startDate, 'goal start date'), dueDate: date(x.dueDate, 'goal due date'),
    };
    if (o.dueDate < o.startDate) fail('goal due date is before its start date');
    if (o.direction === 'up' ? o.targetValue < o.startValue : o.targetValue > o.startValue) fail('goal target is on the wrong side of its start value');
    if (x.parentId !== undefined && x.parentId !== null && x.parentId !== '') o.parentId = str(x.parentId, 100, 'goal parent');
    if (x.manualValue !== undefined && x.manualValue !== null) o.manualValue = num(x.manualValue, -1e12, 1e12, 'goal current value');
    if (x.statusOverride !== undefined && x.statusOverride !== null) o.statusOverride = oneOf(x.statusOverride, ['ahead', 'on-track', 'behind'], 'goal status');
    o.state = oneOf(x.state, ['active', 'achieved', 'dropped'], 'goal state');
    if (x.closedAt !== undefined && x.closedAt !== null) o.closedAt = date(x.closedAt, 'goal closed date');
    o.notes = gtext(x.notes, 2000, 'goal notes', true);
    o.createdAt = ts(x.createdAt, 'goal createdAt');
    return o;
  }
  function cleanGoals(list) {
    if (list === undefined) return [];
    const seen = new Set();
    const out = arr(list, GOAL_CAP, 'goals').map((x) => cleanGoal(x, seen));
    const byId = new Map(out.map((g) => [g.id, g])), rank = (g) => L.goals.HORIZONS.indexOf(g.horizon);
    for (const g of out) {
      if (g.parentId === undefined) continue;
      const p = byId.get(g.parentId);
      if (!p) { delete g.parentId; continue; } // a dangling link is dropped, the goal is kept
      if (rank(p) <= rank(g)) fail('a goal parent must be on a longer horizon');
    }
    for (const g of out) { // belt and braces: strictly longer parents cannot loop, but never trust a loop-free claim
      let c = g, n = 0;
      while (c && c.parentId !== undefined) { c = byId.get(c.parentId); if (++n > out.length) fail('goals form a cycle'); }
    }
    return out;
  }
  // Schema 1 to 4 to 5: every distinct goal title in the old goals/goal entries becomes one goal (latest status wins).
  // The goal's notes carry the whole history of that title (each entry's date, title as typed, status and notes), so the
  // converted entries can be removed without losing anything. A title whose history does not fit in 2,000 characters, and
  // titles beyond the cap, keep their entries (listed under Goals as older goal entries).
  function quarterEnd(d) {
    const y = +d.slice(0, 4), q = Math.floor((+d.slice(5, 7) - 1) / 3), last = new Date(Date.UTC(y, q * 3 + 3, 0)).getUTCDate();
    return String(y).padStart(4, '0') + '-' + String(q * 3 + 3).padStart(2, '0') + '-' + String(last).padStart(2, '0');
  }
  const NOTES_MAX = 2000;
  function goalsFromEntries(entries) {
    const groups = new Map(), order = [];
    for (const e of entries) {
      if (e.domain !== 'goals' || e.type !== 'goal') continue;
      const k = e.title.trim().toLowerCase();
      let g = groups.get(k);
      if (!g) { g = { first: e, latest: e, list: [] }; groups.set(k, g); order.push(g); }
      g.list.push(e);
      if (e.date < g.first.date) g.first = e;
      if (e.date >= g.latest.date) g.latest = e;
    }
    const goals = [], gone = new Set();
    for (const g of order.slice(0, GOAL_CAP)) {
      const e = g.latest, st = e.status || 'on-track';
      const hist = g.list.slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt).localeCompare(String(b.createdAt)))
        .map((x) => 'Imported ' + x.date + ' "' + x.title + '": ' + (x.status || 'on-track') + '.' + (x.notes ? ' ' + x.notes : ''));
      let notes = hist.join('\n');
      const fits = notes.length <= NOTES_MAX;
      if (!fits) notes = ('Imported status: ' + st + ' (' + e.date + '). The full history is kept in the older goal entries.').slice(0, NOTES_MAX);
      const o = {
        id: newId(), title: e.title, horizon: 'quarterly', domain: 'goals', metric: 'manual', direction: 'up', startValue: 0, targetValue: 100,
        startDate: g.first.date, dueDate: quarterEnd(g.first.date), state: st === 'done' ? 'achieved' : 'active', notes, createdAt: g.first.createdAt,
      };
      if (st === 'done') { o.manualValue = 100; o.closedAt = e.date; }
      else o.statusOverride = st === 'on-track' ? 'on-track' : 'behind';
      goals.push(o);
      if (fits) for (const x of g.list) gone.add(x.id);
    }
    return { goals, entries: entries.filter((e) => !gone.has(e.id)) };
  }
  function validateState(o) {
    if (!isObj(o)) fail('state must be an object');
    scan(o, 0, { n: 4e6 });
    if (![1, 2, 3, 4, 5, SCHEMA].includes(o.schema)) fail('unsupported schema');
    if (!L.metrics) fail('metrics module missing');
    const settings = cleanSettings(o.settings, o.schema), entries = cleanEntries(o.entries);
    const out = { schema: SCHEMA, settings, entries };
    if (o.schema === 1) Object.assign(out, { accounts: deriveAccounts(entries), recurring: [], budgets: [], categories: defaultCategories() });
    else Object.assign(out, { accounts: cleanAccounts(o.accounts), recurring: cleanRecurring(o.recurring), budgets: cleanBudgets(o.budgets), categories: cleanCategories(o.categories) });
    // Schema 1 and 2 carry no work data; schema 3 data is whitelisted and capped like everything else.
    out.projects = o.schema >= 3 ? cleanProjects(o.projects) : [];
    out.pipeline = o.schema >= 3 ? cleanPipeline(o.pipeline) : [];
    // Schema 4 adds the training cycle, workout types, daily checks and their log; older formats get empty defaults.
    out.cycle = o.schema >= 4 ? cleanCycle(o.cycle) : null;
    out.kinds = o.schema >= 4 ? cleanKinds(o.kinds) : cleanKinds(undefined);
    out.habits = o.schema >= 4 ? cleanHabits(o.habits) : [];
    out.habitLog = o.schema >= 4 ? cleanHabitLog(o.habitLog, out.habits) : [];
    // An outcome may only point at a project that exists; a dangling link is dropped, the outcome is kept.
    const pids = new Set(out.projects.map((p) => p.id));
    for (const e of entries) if (e.projectId !== undefined && !pids.has(e.projectId)) delete e.projectId;
    // Schema 5 adds goals; older formats turn their goals/goal entries into goals (nothing is lost).
    if (o.schema >= 5) out.goals = cleanGoals(o.goals);
    else { const m = goalsFromEntries(entries); out.goals = cleanGoals(m.goals); out.entries = m.entries; }
    // Schema 6 adds Home (properties, vehicles, maintenance) and Admin (renewals, documents, tax items). Older formats get
    // empty collections, and their home/due entries become renewals (see admin.legacyDue; nothing is dropped).
    const six = o.schema >= 6, H = L.home, A = L.admin;
    out.properties = six ? H.cleanProperties(o.properties) : [];
    out.vehicles = six ? H.cleanVehicles(o.vehicles) : [];
    out.maintenance = six ? H.cleanMaintenance(o.maintenance, out.properties, out.vehicles) : [];
    if (six) out.renewals = A.cleanRenewals(o.renewals);
    else { const m = A.legacyDue(out.entries, RENEWAL_TOTAL_CAP, newId); out.renewals = A.cleanRenewals(m.renewals); out.entries = m.entries; }
    out.documents = six ? A.cleanDocuments(o.documents) : [];
    out.taxItems = six ? A.cleanTaxItems(o.taxItems) : [];
    out.memory = cleanMemory(o.memory);
    out.audit = cleanAudit(o.audit);
    // The schema the input was written in, so callers can tell an older-format copy (no work data) from a schema 3 one.
    // Not enumerable: it never reaches the stored state, a backup or the fingerprint.
    Object.defineProperty(out, 'sourceSchema', { value: o.schema, enumerable: false });
    return out;
  }
  // Data the live state holds that an older-format copy (`next`, marked by validateState) cannot carry.
  // Schema 3 added projects and pipeline; schema 4 added the training cycle, daily checks, workout types and body targets; schema 5 added goals; schema 6 added Home and Admin collections.
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function droppedData(cur, next) {
    const src = next && next.sourceSchema;
    if (!cur || typeof src !== 'number') return [];
    const out = [];
    if (src < 3) { if ((cur.projects || []).length) out.push('projects'); if ((cur.pipeline || []).length) out.push('pipeline items'); }
    if (src < 5 && (cur.goals || []).length) out.push('goals');
    if (src < 6) {
      for (const [k, n] of [['properties', 'properties'], ['vehicles', 'vehicles'], ['maintenance', 'maintenance items'], ['renewals', 'renewals'], ['documents', 'documents'], ['taxItems', 'tax items']]) if ((cur[k] || []).length) out.push(n);
      if ((cur.recurring || []).some((r) => r.household)) out.push('household bill flags');
    }
    if (src < 4) {
      if (cur.cycle) out.push('training cycle');
      if ((cur.habits || []).length) out.push('daily checks');
      if (cur.kinds && !sameJson(cur.kinds, L.metrics.DEFAULT_KINDS)) out.push('workout types');
      const hs = cur.settings && cur.settings.health;
      if (hs && !sameJson(hs, { units: 'lb' })) out.push('body targets and units');
    }
    return out;
  }
  const dropsWork = (cur, next) => droppedData(cur, next).length > 0;
  const andList = (l) => (l.length > 1 ? l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1] : l.join(''));
  // Plain-language list for warnings, with counts: "3 projects and 4 pipeline items". Names only, never values.
  const COUNTED = { properties: 'properties', vehicles: 'vehicles', 'maintenance items': 'maintenance', renewals: 'renewals', documents: 'documents', 'tax items': 'taxItems' };
  function lossText(cur, next) {
    return andList(droppedData(cur, next).map((n) => (n === 'projects' ? cur.projects.length + ' projects' : n === 'pipeline items' ? cur.pipeline.length + ' pipeline items' : n === 'daily checks' ? cur.habits.length + ' daily checks' : n === 'goals' ? cur.goals.length + ' goals' : COUNTED[n] ? cur[COUNTED[n]].length + ' ' + n : 'your ' + n)));
  }
  const nameList = (l) => (l.length > 1 ? l.slice(0, -1).join(', ') + ' or ' + l[l.length - 1] : l.join(''));

  function defaultState() {
    return {
      schema: SCHEMA,
      settings: {
        currency: 'USD', autoLockMin: 15,
        targets: { workoutsPerWeek: 4, contactDays: 30, savingsRate: 0.2 },
        provider: { kind: 'none', baseUrl: '', model: '', apiKey: '' },
        sync: { clientId: '', remoteRev: -1, fp: '', fileId: '', keySalt: '' },
        health: { units: 'lb' },
        home: { starterDone: false },
      },
      entries: [],
      accounts: [], recurring: [], budgets: [], categories: defaultCategories(),
      projects: [], pipeline: [], goals: [],
      properties: [], vehicles: [], maintenance: [], renewals: [], documents: [], taxItems: [],
      cycle: null, kinds: L.metrics.DEFAULT_KINDS.slice(), habits: [], habitLog: [],
      memory: { insights: [], lessons: [], reviews: [] },
      audit: [],
    };
  }
  function newId() {
    const c = L._webcrypto;
    if (!c || !c.randomUUID) throw new Error('WEBCRYPTO_UNAVAILABLE');
    return c.randomUUID();
  }

  // ---- revision metadata (used by sync.js) ----
  const tamper = () => new Error('Vault revision check failed. The data may have been altered.');
  function readMeta(env, raw) {
    const inner = raw && raw._meta;
    if (env.rev === undefined && inner === undefined) return { rev: 0, updatedAt: '', deviceId: '' };
    if (!isObj(inner) || env.rev !== inner.rev || env.updatedAt !== inner.updatedAt || env.deviceId !== inner.deviceId) throw tamper();
    if (!Number.isInteger(env.rev) || env.rev < 0 || env.rev > 1e9 || typeof env.updatedAt !== 'string' || env.updatedAt.length > 40 ||
      typeof env.deviceId !== 'string' || env.deviceId.length > 64) throw tamper();
    return { rev: env.rev, updatedAt: env.updatedAt, deviceId: env.deviceId };
  }
  async function seal(k, sl, clean, rev) {
    if (!deviceId) deviceId = newId();
    const m = { rev, updatedAt: new Date().toISOString(), deviceId };
    const env = await V().makeEnvelope(k, sl, Object.assign({}, clean, { _meta: m }));
    return { env: Object.assign(env, m), m };
  }

  // ---- lifecycle ----
  const V = () => L.vault;
  const replaceContents = (target, src) => {
    for (const k of Object.keys(target)) delete target[k];
    Object.assign(target, src);
  };
  const serial = (fn) => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };
  const requireUnlocked = () => { if (!state || !key) throw new Error('LOCKED'); };

  async function exists() { return !!(await getAdapter().get(KEY)); }
  async function init(passphrase) {
    V().checkPassphrase(passphrase);
    const a = getAdapter();
    if (await a.get(KEY)) throw new Error('VAULT_EXISTS');
    const sl = V().newSalt();
    const k = await V().deriveKey(passphrase, sl);
    const st = defaultState();
    const sealed = await seal(k, sl, st, 0);
    await a.set(KEY, sealed.env);
    key = k; salt = sl; state = st; meta = sealed.m;
    return st;
  }
  async function unlock(passphrase) {
    const env = await getAdapter().get(KEY);
    if (!env) throw new Error('NO_VAULT');
    const { salt: sl } = V().parseEnvelope(env);
    const k = await V().deriveKey(passphrase, sl);
    const raw = await V().decrypt(k, env);
    const st = validateState(raw);
    meta = readMeta(env, raw); deviceId = meta.deviceId || deviceId;
    key = k; salt = sl; state = st;
    return st;
  }
  function lock() {
    // Empty the live state object too, so any reference still held elsewhere no longer reaches plaintext.
    if (state) { try { replaceContents(state, {}); } catch (e) { /* ignore */ } }
    key = null; salt = null; state = null; meta = { rev: 0, updatedAt: '', deviceId: '' };
  }
  const isUnlocked = () => !!(state && key);
  function getState() { requireUnlocked(); return state; }

  function commit(fn, opts) {
    return serial(async () => {
      requireUnlocked();
      const st = state, k = key, sl = salt;
      const snapshot = JSON.parse(JSON.stringify(st));
      try {
        await fn(st);
        const clean = validateState(st);
        const sealed = await seal(k, sl, clean, opts && opts.quiet ? meta.rev : meta.rev + 1);
        if (key !== k) throw new Error('LOCKED');
        await getAdapter().set(KEY, sealed.env);
        if (state !== st) throw new Error('LOCKED');
        meta = sealed.m;
        replaceContents(st, clean);
      } catch (e) {
        if (state === st) replaceContents(st, snapshot);
        throw e;
      }
    });
  }
  function changePassphrase(oldP, newP) {
    return serial(async () => {
      requireUnlocked();
      const st = state;
      V().checkPassphrase(newP);
      const a = getAdapter();
      const env = await a.get(KEY);
      const { salt: sl } = V().parseEnvelope(env);
      await V().decrypt(await V().deriveKey(oldP, sl), env);
      const nsl = V().newSalt();
      const nk = await V().deriveKey(newP, nsl);
      const sealed = await seal(nk, nsl, validateState(st), meta.rev + 1);
      if (state !== st) throw new Error('LOCKED');
      await a.set(KEY, sealed.env);
      if (state !== st) throw new Error('LOCKED');
      key = nk; salt = nsl; meta = sealed.m;
    });
  }
  function replaceState(next, opts) {
    return serial(async () => {
      requireUnlocked();
      const st = state;
      if (dropsWork(st, next) && !(opts && opts.allowWorkLoss === true)) {
        const e = new Error('This backup is from an older version and has no ' + nameList(droppedData(st, next)) + '. Nothing was replaced.'); e.code = 'OLDER_FORMAT'; throw e;
      }
      const clean = validateState(next);
      // A restored backup never brings its own sync bookkeeping: an older remoteRev would weaken the rollback
      // check, and a different OAuth client ID would be swapped in without the user seeing it.
      clean.settings.sync = Object.assign({}, st.settings.sync);
      const sealed = await seal(key, salt, clean, meta.rev + 1);
      if (state !== st) throw new Error('LOCKED');
      await getAdapter().set(KEY, sealed.env);
      if (state !== st) throw new Error('LOCKED');
      meta = sealed.m;
      replaceContents(st, clean);
    });
  }
  // ---- sync support (additive) ----
  const getMeta = () => { requireUnlocked(); return Object.assign({}, meta); };
  // Public identifier of the live key: its salt in base64 (the salt is not secret; it is in every envelope).
  const saltId = () => { requireUnlocked(); return btoa(String.fromCharCode.apply(null, salt)); };
  // Current stored envelope, re-sealed first if it has no rev yet or must reach at least minRev.
  function exportEnvelope(minRev) {
    return serial(async () => {
      requireUnlocked();
      const a = getAdapter(), st = state, k = key, sl = salt;
      let env = await a.get(KEY);
      const want = Math.max(meta.rev, Number.isInteger(minRev) ? minRev : 0);
      if (!env) throw new Error('NO_VAULT');
      if (env.rev === undefined || env.rev < want) {
        const sealed = await seal(k, sl, validateState(st), want);
        if (state !== st || key !== k) throw new Error('LOCKED');
        await a.set(KEY, sealed.env);
        meta = sealed.m; env = sealed.env;
      }
      return env;
    });
  }
  // Open an untrusted remote envelope. Uses the live key when the salt matches, else needs the passphrase.
  async function inspectEnvelope(env, passphrase) {
    requireUnlocked();
    const { salt: sl } = V().parseEnvelope(env);
    let k;
    if (sl.length === salt.length && sl.every((b, i) => b === salt[i])) k = key;
    else {
      if (typeof passphrase !== 'string' || !passphrase) { const e = new Error('Enter the passphrase of the Drive copy.'); e.code = 'NEED_PASSPHRASE'; throw e; }
      k = await V().deriveKey(passphrase, sl);
    }
    let raw;
    try { raw = await V().decrypt(k, env); }
    catch (e) { const x = new Error('The Drive copy uses a different passphrase.'); x.code = 'WRONG_PASSPHRASE'; throw x; }
    const m = readMeta(env, raw);
    return { meta: m, state: validateState(raw), sourceSchema: raw && raw.schema, key: k, salt: sl, env, sameKey: k === key };
  }
  // Replace the local vault with an inspected remote one (same passphrase).
  function adoptEnvelope(info) {
    return serial(async () => {
      requireUnlocked();
      const st = state, e = info.env;
      // Persist only the known envelope fields, never whatever else the remote JSON carried.
      const env = { v: e.v, kdf: { name: e.kdf.name, hash: e.kdf.hash, iter: e.kdf.iter, salt: e.kdf.salt }, iv: e.iv, ct: e.ct };
      if (e.rev !== undefined) Object.assign(env, { rev: e.rev, updatedAt: e.updatedAt, deviceId: e.deviceId });
      await getAdapter().set(KEY, env);
      if (state !== st) throw new Error('LOCKED');
      key = info.key; salt = info.salt; meta = Object.assign({}, info.meta);
      replaceContents(st, info.state);
    });
  }
  async function wipe() {
    await serial(async () => { await getAdapter().del(KEY); });
    lock();
  }

  // Validation helpers shared with home.js and admin.js (same rules and messages as the rest of validateState).
  L.validate = { fail, isObj, str, num, date, oneOf, bool, arr, strip, ts, newId };
  L.store = { _setAdapter, exists, init, unlock, lock, isUnlocked, getState, commit, changePassphrase, replaceState, wipe, validateState, newId, defaultState, getMeta, saltId, exportEnvelope, inspectEnvelope, adoptEnvelope, dropsWork, droppedData, nameList, lossText, validateGoals: cleanGoals };
})();
