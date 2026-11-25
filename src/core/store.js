(function () {
  'use strict';
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const KEY = 'envelope';
  const ACCOUNT_CAP = 200, RECURRING_CAP = 500, BUDGET_CAP = 100, CATEGORY_CAP = 50, SCHEMA = 24, GOAL_CAP = 300, PROJECT_CAP = 200, PROJECT_TOTAL_CAP = 2000, PIPELINE_CAP = 1000;
  const HABIT_CAP = 8, HABIT_LOG_CAP = 100000, KIND_CAP = 30;
  const RENEWAL_TOTAL_CAP = 2000;
  const ENTRY_CAP = 50000, INSIGHT_CAP = 5000, REVIEW_CAP = 1000, LESSON_CAP = 30, AUDIT_CAP = 200;
  const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
  // Same rule as ai.isLocalUrl (ai.js loads after this file, so call it lazily).
  const BIDI = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
  const strip = (v) => (typeof v === 'string' ? v.replace(BIDI, '') : v);
  // ks: the live key set { key (non-extractable data key), kek (passphrase key-encryption key, seals the older-app stub), wraps } (envelope v2).
  let adapter = null, ks = null, state = null, queue = Promise.resolve(), pendingRecovery = null;
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
  // CR-2: while a merged view (public and private records together) is validated, each layer has already been held to its own cap,
  // so the view may hold up to twice the cap; adds are still refused by the add functions, which count the view.
  let merged = false;
  function arr(v, cap, name) {
    if (!Array.isArray(v)) fail(name + ' must be a list');
    if (v.length > (merged ? cap * 2 : cap)) fail(name + ' has too many items');
    return v;
  }
  function domainIds() { return L.metrics.DOMAINS.map((d) => d.id); }

  function cleanSettings(s, schema) {
    if (!isObj(s)) fail('settings');
    const t = isObj(s.targets) ? s.targets : fail('targets');
    const p = isObj(s.provider) ? s.provider : fail('provider');
    const provider = {
      kind: oneOf(p.kind, ['none', 'anthropic', 'local', 'manual', 'nas', 'pc'], 'provider kind'),
      baseUrl: str(p.baseUrl, 200, 'baseUrl', true),
      model: str(p.model, 100, 'model', true),
      apiKey: str(p.apiKey, 300, 'apiKey', true),
    };
    if (provider.kind === 'local' && provider.baseUrl && !(L.ai && L.ai.isLocalUrl(provider.baseUrl))) fail('local provider must use localhost');
    // v2.0.0: the NAS and PC model hosts are fixed names from the build (config/hosts.json); a stored address is never used, never user-entered.
    if (provider.kind === 'nas' || provider.kind === 'pc') { provider.baseUrl = ''; provider.apiKey = ''; }
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
      // v2.0.0: the NAS sync target (this device's token and bookkeeping) and the AI host choices. Older schemas get the defaults.
      nas: schema >= 20 ? cleanNas(s.nas) : cleanNas(undefined),
      aiHosts: schema >= 20 ? cleanAiHosts(s.aiHosts) : cleanAiHosts(undefined),
      health: schema >= 4 ? cleanHealthSettings(s.health) : { units: 'lb' },
      home: schema >= 6 ? cleanHomeSettings(s.home) : { starterDone: false },
      learning: schema >= 7 ? L.learning.cleanSettings(s.learning) : { weeklyMinutes: 0 },
      privAutoLockSec: schema >= 10 && s.privAutoLockSec !== undefined ? num(s.privAutoLockSec, 15, 1800, 'privAutoLockSec', true) : 60,
      layouts: schema >= 11 ? L.layout.cleanLayouts(s.layouts, schema) : { narrow: [], wide: [] },
      // v1.1.0: business settings. Migrating from an older schema asks the owner to confirm the business or personal scope once.
      business: schema >= 12 ? L.business.cleanSettings(s.business) : L.business.defaultSettings(false),
      // v1.2.0 part B: the vault size (MB) that makes the dashboard propose archiving.
      archiveSuggestMB: schema >= 14 && s.archiveSuggestMB !== undefined ? num(s.archiveSuggestMB, 20, 60, 'archiveSuggestMB', true) : 40,
      // v1.3.0: backup reminder interval (days) and the optional sync reminder.
      ...L.ops.cleanSettings(s, schema),
      // v1.4.0: the setup checklist. A vault from before schema 16 counts as set up (no checklist); a new vault starts with it shown.
      setup: cleanSetup(s.setup, schema),
      // v1.7.0: days without contact before an active client is flagged.
      clients: schema >= 19 ? L.clients.cleanSettings(s.clients) : L.clients.cleanSettings(undefined),
      // v2.1.0: the daily protein target (whole grams, typed by the owner). Older schemas have none.
      food: schema >= 21 ? L.food.cleanSettings(s.food) : {},
      // v2.3.0: the Overview's chosen key numbers and shortcuts. Older schemas get the defaults.
      overview: schema >= 23 ? L.overview.cleanSettings(s.overview) : L.overview.defaultSettings(),
      // v2.4.0: the country list (home country first in meaning, not in order) and the exchange rates the owner typed. Older schemas get
      // the United States as home and Spain on the list, and no rates.
      countries: schema >= 24 ? L.countries.cleanSettings(s.countries) : L.countries.defaultSettings(),
      fx: schema >= 24 ? L.countries.cleanFx(s.fx, s.currency) : [],
    };
  }
  function cleanSetup(x, schema) {
    if (schema < 16 || x === undefined || x === null) return { dismissed: schema < 16, targetsSaved: false };
    if (!isObj(x) || typeof x.dismissed !== 'boolean' || typeof x.targetsSaved !== 'boolean') fail('setup');
    const o = { dismissed: x.dismissed, targetsSaved: x.targetsSaved };
    // tour: true once the first-run tour has started (optional; absent means it has not). Older builds drop it, so it may show once more there.
    if (x.tour !== undefined) { if (typeof x.tour !== 'boolean') fail('setup'); o.tour = x.tour; }
    return o;
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
  const TOKEN_RE = /^lfs_[A-Za-z0-9_-]{43}$/;
  function cleanNas(x) {
    const d = { token: '', tokenAt: '', remoteRev: -1, srev: -1, fp: '', keySalt: '' };
    if (x === undefined) return d;
    if (!isObj(x)) fail('nas');
    const token = x.token === undefined ? '' : str(x.token, 60, 'nas token', true);
    if (token && !TOKEN_RE.test(token)) fail('nas token');
    const at = x.tokenAt === undefined ? '' : str(x.tokenAt, 10, 'nas tokenAt', true);
    if (at && !/^\d{4}-\d{2}-\d{2}$/.test(at)) fail('nas tokenAt');
    const fp = x.fp === undefined ? '' : str(x.fp, 64, 'nas fp', true);
    if (fp && !/^[0-9a-f]{64}$/.test(fp)) fail('nas fp');
    const ks = x.keySalt === undefined ? '' : str(x.keySalt, 24, 'nas keySalt', true);
    if (ks && !/^[A-Za-z0-9+/]{22}==$/.test(ks)) fail('nas keySalt');
    return { token, tokenAt: at, remoteRev: num(x.remoteRev === undefined ? -1 : x.remoteRev, -1, 1e9, 'nas remoteRev', true), srev: num(x.srev === undefined ? -1 : x.srev, -1, 1e9, 'nas srev', true), fp, keySalt: ks };
  }
  function cleanAiHosts(x) {
    const d = { nasModel: '', pcModel: '', fallback: '' };
    if (x === undefined) return d;
    if (!isObj(x)) fail('aiHosts');
    return { nasModel: x.nasModel === undefined ? '' : str(x.nasModel, 100, 'nas model', true).trim(), pcModel: x.pcModel === undefined ? '' : str(x.pcModel, 100, 'pc model', true).trim(), fallback: x.fallback === undefined ? '' : oneOf(x.fallback, ['', 'nas', 'pc'], 'ai fallback') };
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
  const PROJECT_KINDS = ['job', 'venture', 'client', 'personal', 'website', 'podcast'];
  const PIPELINE_KINDS = ['job', 'deal', 'partner'];
  function cleanProjects(list) {
    if (list === undefined) return [];
    const seen = new Set();
    arr(list, PROJECT_TOTAL_CAP, 'projects');
    // Archived projects do not count toward the 200 cap; a separate total cap keeps the list bounded.
    if (list.filter((x) => !(isObj(x) && x.archived === true)).length > (merged ? PROJECT_CAP * 2 : PROJECT_CAP)) fail('projects has too many items');
    const out = list.map((x) => {
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
      if (x.budgetCents !== undefined && x.budgetCents !== null) {
        o.budgetCents = num(x.budgetCents, 0, 1e11, 'project budget', true);
        o.budgetPeriod = oneOf(x.budgetPeriod, ['month', 'project'], 'budget period');
      }
      if (x.parentId !== undefined && x.parentId !== null && x.parentId !== '') o.parentId = str(x.parentId, 100, 'project parent');
      return o;
    });
    // v0.12.0: a line of work may sit under one parent (one level only). A parent that does not exist or is archived is dropped and
    // the project kept; a project that is its own parent, or a parent that itself has a parent, is refused.
    const byId = new Map(out.map((p) => [p.id, p]));
    for (const p of out) {
      if (p.parentId === undefined) continue;
      const par = byId.get(p.parentId);
      if (p.parentId === p.id) fail('a project cannot be its own parent');
      if (!par || par.archived) { delete p.parentId; continue; }
    }
    // CR-2: in a merged view a public parent may have gained its own parent while the private vault was closed; the private child is
    // then detached (kept, unlinked) instead of making the vault impossible to open.
    if (merged) { const deep = out.filter((p) => p.parentId !== undefined && byId.get(p.parentId).parentId !== undefined); for (const p of deep) delete p.parentId; }
    for (const p of out) if (p.parentId !== undefined && byId.get(p.parentId).parentId !== undefined) fail('projects nest one level only');
    return out;
  }
  // v1.6.0 B14: job items (kind 'job') carry optional search fields. Compensation is integer cents. Older formats and other kinds carry none.
  const LOCATION_TYPES = ['remote', 'hybrid', 'on site'], LOST_REASONS = ['no response', 'rejected', 'withdrew', 'role closed', 'other'];
  const COMP_FIELDS = ['targetOteCents', 'targetBaseCents', 'offerOteCents', 'offerBaseCents'], COMP_MAX = 100000000000;
  function cleanJobFields(x, o, t0) {
    const t = (v, max, name) => { if (typeof v !== 'string') fail(name + ' must be text'); return t0(v, max, name); };
    if (x.role !== undefined && x.role !== '') o.role = t(x.role, 200, 'role');
    if (x.locationType !== undefined && x.locationType !== '') o.locationType = oneOf(x.locationType, LOCATION_TYPES, 'location type');
    for (const k of COMP_FIELDS) if (x[k] !== undefined && x[k] !== null) o[k] = num(x[k], 0, COMP_MAX, k, true);
    for (const k of ['appliedOn', 'followUp', 'followedUpOn']) if (x[k] !== undefined && x[k] !== '') o[k] = date(x[k], k);
    if (x.resume !== undefined && x.resume !== '') o.resume = t(x.resume, 60, 'resume version');
    if (x.lostReason !== undefined && x.lostReason !== '') { const r = oneOf(x.lostReason, LOST_REASONS, 'outcome reason'); if (o.stage === 'lost') o.lostReason = r; }
    if (x.importKey !== undefined && x.importKey !== '') { if (typeof x.importKey !== 'string' || !/^[0-9a-f]{64}$/.test(x.importKey)) fail('invalid import key'); o.importKey = x.importKey; }
  }
  function cleanPipeline(list, schema) {
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
      if (o.kind === 'job' && (schema === undefined || schema >= 18)) cleanJobFields(x, o, t);
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
    if (d.jobs !== undefined) {
      if (!isObj(d.jobs)) fail('digest jobs');
      out.jobs = {};
      for (const k of ['applied', 'followUpsDue', 'interviews', 'offers']) out.jobs[k] = num(d.jobs[k], 0, 1e9, 'digest jobs', true);
    }
    if (d.health !== undefined) {
      if (!isObj(d.health)) fail('digest health');
      const x = d.health;
      out.health = {
        sessions: num(x.sessions, 0, 1e6, 'digest health', true), minutes: num(x.minutes, 0, 1e9, 'digest health'), avgSleep: num(x.avgSleep, 0, 24, 'digest health'),
        weightChange: num(x.weightChange, -1e4, 1e4, 'digest health'), habitRate: num(x.habitRate, 0, 100, 'digest health'),
      };
    }
    if (d.food !== undefined) {
      if (!isObj(d.food)) fail('digest food');
      const x = d.food;
      out.food = { meals: num(x.meals, 0, 1e6, 'digest food', true), proteinAvg: num(x.proteinAvg, 0, 1e4, 'digest food', true), proteinDays: num(x.proteinDays, 0, 7, 'digest food', true), forHealthRate: num(x.forHealthRate, 0, 100, 'digest food') };
    }
    if (d.goals !== undefined) {
      if (!isObj(d.goals)) fail('digest goals');
      out.goals = {};
      for (const k of ['active', 'ahead', 'onTrack', 'behind', 'achieved']) out.goals[k] = num(d.goals[k], 0, 1e9, 'digest goals', true);
    }
    if (d.learning !== undefined) {
      if (!isObj(d.learning)) fail('digest learning');
      out.learning = {};
      for (const k of ['minutes', 'sessions', 'days', 'active', 'finished', 'stalled']) out.learning[k] = num(d.learning[k], 0, 1e9, 'digest learning', true);
    }
    if (d.activities !== undefined) {
      if (!isObj(d.activities)) fail('digest activities');
      const x = d.activities, o = {};
      for (const k of ['done', 'planned7', 'planned30', 'healthTagged', 'socialTagged']) o[k] = num(x[k], 0, 1e9, 'digest activities', true);
      for (const k of ['spendCents', 'committedCents']) o[k] = num(x[k], 0, Number.MAX_SAFE_INTEGER, 'digest activities', true);
      o.avgRating = num(x.avgRating, 0, 5, 'digest activities');
      out.activities = o;
    }
    if (d.social !== undefined) {
      if (!isObj(d.social)) fail('digest social');
      const x = d.social, o = {};
      for (const k of ['people', 'overdue', 'dueSoon', 'contactsWeek']) o[k] = num(x[k], 0, 1e9, 'digest social', true);
      o.byGroup = arr(x.byGroup, 30, 'digest social').map((g) => {
        if (!isObj(g)) fail('digest social');
        return { people: num(g.people, 0, 1e9, 'digest social', true), overdue: num(g.overdue, 0, 1e9, 'digest social', true) };
      });
      out.social = o;
    }
    if (d.revenue !== undefined) {
      if (!isObj(d.revenue)) fail('digest revenue');
      const x = d.revenue, o = {};
      for (const k of ['revenueWeekCents', 'expensesWeekCents', 'revenueMonthCents', 'expensesMonthCents', 'expectedNext30Cents']) o[k] = num(x[k], 0, Number.MAX_SAFE_INTEGER, 'digest revenue', true);
      for (const k of ['netWeekCents', 'netMonthCents']) o[k] = num(x[k], -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'digest revenue', true);
      for (const k of ['overdueCount', 'lines']) o[k] = num(x[k], 0, 1e9, 'digest revenue', true);
      out.revenue = o;
    }
    if (d.business !== undefined) {
      if (!isObj(d.business)) fail('digest business');
      const x = d.business, o = {};
      for (const k of ['openInvoices', 'overdueInvoices']) o[k] = num(x[k], 0, 1e9, 'digest business', true);
      o.openInvoiceCents = num(x.openInvoiceCents, 0, Number.MAX_SAFE_INTEGER, 'digest business', true);
      if (x.tax !== undefined) {
        if (!isObj(x.tax)) fail('digest tax');
        o.tax = { profitCents: num(x.tax.profitCents, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'digest tax', true) };
        if (x.tax.estimatedTaxCents !== undefined) o.tax.estimatedTaxCents = num(x.tax.estimatedTaxCents, 0, Number.MAX_SAFE_INTEGER, 'digest tax', true);
        if (x.tax.gapCents !== undefined) o.tax.gapCents = num(x.tax.gapCents, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'digest tax', true);
      }
      out.business = o;
    }
    if (d.media !== undefined) {
      if (!isObj(d.media)) fail('digest media');
      out.media = {};
      for (const k of ['clientsOverdue', 'episodesThisMonth', 'sitesRenewing']) out.media[k] = num(d.media[k], 0, 1e9, 'digest media', true);
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
  function cleanMemory(m, schema) {
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
      // Schema 17 (v1.5.0): the kind of a rules insight, the fixed reason code of a rejection and an optional target change.
      if (schema >= 17) {
        if (x.kind !== undefined) { if (typeof x.kind !== 'string' || !/^[a-z][a-z0-9-]{0,29}$/.test(x.kind)) fail('insight kind'); o.kind = x.kind; }
        if (x.reason !== undefined) o.reason = oneOf(x.reason, L.memory.REASONS, 'rejection reason');
        if (x.target !== undefined) { try { o.target = L.memory.cleanTarget(x.target, true); } catch (e) { fail('insight target'); } }
      }
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
    // Schema 17: the date of the last finished review (older vaults take it from their latest review) and the muted rules kinds.
    let lastReviewAt = '';
    if (schema >= 17 && m.lastReviewAt !== undefined && m.lastReviewAt !== '') lastReviewAt = date(m.lastReviewAt, 'lastReviewAt');
    else if (reviews.length) { const t = new Date(Math.max.apply(null, reviews.map((r) => (typeof r.completedAt === 'number' ? r.completedAt : Date.parse(r.completedAt)))).valueOf()); if (!isNaN(t.getTime())) lastReviewAt = t.toISOString().slice(0, 10); }
    const seenMute = new Set();
    const mutes = schema >= 17 && m.mutes !== undefined ? arr(m.mutes, 500, 'mutes').map((x) => {
      if (!isObj(x)) fail('mute');
      const mo = { domain: oneOf(x.domain, doms, 'mute area'), kind: str(x.kind, 30, 'mute kind'), at: ts(x.at, 'mute time'), active: bool(x.active, 'mute active') };
      if (!/^[a-z][a-z0-9-]{0,29}$/.test(mo.kind)) fail('mute kind');
      if (seenMute.has(mo.domain + '|' + mo.kind)) fail('duplicate mute');
      seenMute.add(mo.domain + '|' + mo.kind);
      return mo;
    }) : [];
    // SEC-102 (v1.5.0 audit): the date the review loop started counting, so a vault that has never finished a review is still shown
    // as due once it is 7 days old. Kept when valid; otherwise (older vaults, or a missing value) the caller derives it.
    const startedOn = schema >= 17 && m.startedOn !== undefined && m.startedOn !== '' ? date(m.startedOn, 'startedOn') : '';
    return { insights, lessons, reviews, lastReviewAt, mutes, startedOn };
  }
  const localToday = () => { const d = new Date(), p2 = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };
  // The earliest dated trace the vault holds (audit log, insights, reviews, backup, sync and storage dates); today when there is none.
  // A trace can only be later than the real creation day, so the age is never overstated.
  function deriveStartedOn(out) {
    const days = [];
    const add = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); if (isFinite(t)) days.push(new Date(t).toISOString().slice(0, 10)); };
    for (const a of out.audit || []) if (a.ts) add(a.ts);
    for (const i of out.memory.insights) add(i.createdAt);
    for (const r of out.memory.reviews) add(r.completedAt);
    const ops = out.ops || {};
    for (const d of [ops.lastBackupAt, ops.lastSyncAt, ops.persist && ops.persist.at]) if (d) add(d);
    const ok = days.filter(isDate).sort();
    const t = localToday();
    return ok.length && ok[0] < t ? ok[0] : t;
  }
  function cleanAudit(a) {
    if (a === undefined) return [];
    if (!Array.isArray(a)) fail('audit');
    return a.slice(-AUDIT_CAP).map((x) => {
      if (!isObj(x)) fail('audit item');
      // CR-4: Settings renders ts as text; a numeric timestamp (older writer or crafted backup) becomes an ISO string.
      const t = ts(x.ts, 'ts');
      return { ts: typeof t === 'number' ? (Math.abs(t) <= 8.64e15 ? new Date(t).toISOString() : '') : t, action: str(x.action, 100, 'action', true) };
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
  // PV-4: anchorDay is kept only while nextDate is a month's last day earlier than the anchor (a clamped date), else dropped.
  function anchorOf(x) {
    const a = x.anchorDay;
    if (!Number.isInteger(a) || a < 1 || a > 31 || x.cadence === 'weekly' || !isDate(x.nextDate)) return {};
    const d = x.nextDate, day = +d.slice(8, 10), last = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).getUTCDate();
    return day === last && a > day ? { anchorDay: a } : {};
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
        household: bool(x.household, 'household', false),
        ...anchorOf(x),
        ...(x.projectId !== undefined && x.projectId !== null && x.projectId !== '' ? { projectId: str(x.projectId, 100, 'recurring project') } : {})
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
  function cleanGoal(x, seen, privOk) {
    if (!isObj(x)) fail('goal');
    const G = L.goals;
    const id = str(x.id, 100, 'goal id');
    if (seen.has(id)) fail('duplicate goal id');
    seen.add(id);
    const metric = oneOf(x.metric, G.METRICS.map((m) => m.id), 'goal metric');
    if (!privOk && L.wellbeing && L.wellbeing.isGoalMetric(metric)) fail('a wellbeing goal metric can only be used by a private goal');
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
    if (x.projectId !== undefined && x.projectId !== null && x.projectId !== '') {
      if (metric !== 'revenueMonth' && metric !== 'netMonth') fail('only revenue goals can be scoped to a line of work');
      o.projectId = str(x.projectId, 100, 'goal line of work');
      if (x.rollup !== undefined) o.rollup = bool(x.rollup, 'goal rollup', false);
    }
    if (x.statusOverride !== undefined && x.statusOverride !== null) o.statusOverride = oneOf(x.statusOverride, ['ahead', 'on-track', 'behind'], 'goal status');
    o.state = oneOf(x.state, ['active', 'achieved', 'dropped'], 'goal state');
    if (x.closedAt !== undefined && x.closedAt !== null) o.closedAt = date(x.closedAt, 'goal closed date');
    o.notes = gtext(x.notes, 2000, 'goal notes', true);
    o.createdAt = ts(x.createdAt, 'goal createdAt');
    return o;
  }
  function cleanGoals(list, privOk) {
    if (list === undefined) return [];
    const seen = new Set();
    const out = arr(list, GOAL_CAP, 'goals').map((x) => cleanGoal(x, seen, privOk === true));
    const byId = new Map(out.map((g) => [g.id, g])), rank = (g) => L.goals.HORIZONS.indexOf(g.horizon);
    for (const g of out) {
      if (g.parentId === undefined) continue;
      const p = byId.get(g.parentId);
      if (!p) { delete g.parentId; continue; } // a dangling link is dropped, the goal is kept
      if (rank(p) <= rank(g)) { if (merged) { delete g.parentId; continue; } fail('a goal parent must be on a longer horizon'); }
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
  // opts.privateGoals: the caller validates a view with private records merged in, so wellbeing goal metrics are allowed (the stored main state never is).
  // opts.merged: the input is a merged view (priv.js); caps and cross-record rules are tolerant (see arr and cleanProjects).
  function validateState(o, opts) {
    const was = merged;
    merged = !!(opts && opts.merged);
    try { return validateStateRaw(o, opts); } finally { merged = was; }
  }
  function validateStateRaw(o, opts) {
    if (!isObj(o)) fail('state must be an object');
    scan(o, 0, { n: 4e6 });
    if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, SCHEMA].includes(o.schema)) fail('unsupported schema');
    if (!L.metrics) fail('metrics module missing');
    const settings = cleanSettings(o.settings, o.schema), entries = cleanEntries(o.entries);
    const out = { schema: SCHEMA, settings, entries };
    if (o.schema === 1) Object.assign(out, { accounts: deriveAccounts(entries), recurring: [], budgets: [], categories: defaultCategories() });
    else Object.assign(out, { accounts: cleanAccounts(o.accounts), recurring: cleanRecurring(o.recurring), budgets: cleanBudgets(o.budgets), categories: cleanCategories(o.categories) });
    // Schema 1 and 2 carry no work data; schema 3 data is whitelisted and capped like everything else.
    out.projects = o.schema >= 3 ? cleanProjects(o.projects) : [];
    out.pipeline = o.schema >= 3 ? cleanPipeline(o.pipeline, o.schema) : [];
    // Schema 4 adds the training cycle, workout types, daily checks and their log; older formats get empty defaults.
    out.cycle = o.schema >= 4 ? cleanCycle(o.cycle) : null;
    out.kinds = o.schema >= 4 ? cleanKinds(o.kinds) : cleanKinds(undefined);
    out.habits = o.schema >= 4 ? cleanHabits(o.habits) : [];
    out.habitLog = o.schema >= 4 ? cleanHabitLog(o.habitLog, out.habits) : [];
    // An outcome may only point at a project that exists; a dangling link is dropped, the outcome is kept.
    const pids = new Set(out.projects.map((p) => p.id));
    // PV-2: while private lines of work exist, a money entry saved with the vault closed may point at one of them (a ledger preview made
    // while the vault was open and imported after it closed). The id is kept, so the line is found again once the vault opens (and the
    // next write moves the link into the private vault); while closed it counts as Unassigned. Merged views drop it as usual.
    const hiddenLines = !(opts && opts.merged) && isObj(o.priv) && Array.isArray(o.priv.marks) && o.priv.marks.includes('projects');
    for (const e of entries) if (e.projectId !== undefined && !pids.has(e.projectId) && !(hiddenLines && e.domain === 'money')) delete e.projectId;
    for (const r of out.recurring) if (r.projectId !== undefined && !pids.has(r.projectId)) delete r.projectId;
    // Schema 5 adds goals; older formats turn their goals/goal entries into goals (nothing is lost).
    if (o.schema >= 5) out.goals = cleanGoals(o.goals, !!(opts && opts.privateGoals));
    else { const m = goalsFromEntries(entries); out.goals = cleanGoals(m.goals); out.entries = m.entries; }
    for (const g of out.goals) if (g.projectId !== undefined && !pids.has(g.projectId)) { delete g.projectId; delete g.rollup; }
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
    // Schema 7 adds Learning (items, study sessions, takeaways). Older formats get empty collections, and their learning/item and
    // learning/hours entries become items and sessions (see learning.legacy; whatever cannot map stays as an entry).
    const Ln = L.learning;
    if (o.schema >= 7) {
      // Schema 22 (v2.2.0): degree and language kinds, the next step and its date, and minutes per week on an item (see cleanItems).
      out.learningItems = Ln.cleanItems(o.learningItems, out.goals, o.schema);
      out.studySessions = Ln.cleanSessions(o.studySessions, out.learningItems);
      out.takeaways = Ln.cleanTakeaways(o.takeaways, out.learningItems);
    } else {
      const m = Ln.legacy(out.entries, newId);
      out.learningItems = Ln.cleanItems(m.items, out.goals);
      out.studySessions = Ln.cleanSessions(m.sessions, out.learningItems);
      out.takeaways = [];
      out.entries = m.entries;
    }
    // Schema 8 adds Activities and their category list. Older formats get an empty list and the default categories, and their
    // activities/session entries become done activities (see activities.legacy; only a session past the cap stays an entry).
    const Ac = L.activities;
    if (o.schema >= 8) {
      out.activityCategories = Ac.cleanCategories(o.activityCategories);
      out.activities = Ac.cleanActivities(o.activities, out.goals, out.entries);
    } else {
      const m = Ac.legacy(out.entries, newId);
      out.activityCategories = Ac.cleanCategories(undefined);
      out.activities = Ac.cleanActivities(m.activities, out.goals, m.entries);
      out.entries = m.entries;
    }
    // Schema 9 adds Social (groups, people, contact log). Older formats get empty collections, and their social/contact entries
    // become people and a contact log (see social.legacy; whatever cannot map stays as an entry). Links to pipeline items and
    // projects that do not exist are dropped and the person is kept.
    const So = L.social;
    if (o.schema >= 9) {
      out.groups = So.cleanGroups(o.groups);
      out.people = So.cleanPeople(o.people, out.groups, out.pipeline, out.projects);
      out.contacts = So.cleanContacts(o.contacts, out.people);
    } else {
      const m = So.legacy(out.entries, newId);
      out.groups = [];
      out.people = So.cleanPeople(m.people, out.groups, out.pipeline, out.projects);
      out.contacts = So.cleanContacts(m.contacts, out.people);
      out.entries = m.entries;
    }
    // Schema 12 adds business records (payees, invoices, trips, estimated payments), the tax-year profiles, the home-office figures and
    // the category to Schedule C line map. Older formats get empty collections, and each money entry takes the scope its line of work implies.
    const Bz = L.business, Tx = L.tax, twelve = o.schema >= 12;
    out.payees = twelve ? Bz.cleanPayees(o.payees) : [];
    out.invoices = twelve ? Bz.cleanInvoices(o.invoices, { merged }) : [];
    out.trips = twelve ? Bz.cleanTrips(o.trips) : [];
    out.taxPayments = twelve ? Tx.cleanPayments(o.taxPayments) : [];
    out.taxYears = twelve ? Tx.cleanTaxYears(o.taxYears) : {};
    out.homeOffice = twelve ? Tx.cleanHomeOffice(o.homeOffice) : {};
    out.taxMap = twelve ? Tx.cleanTaxMap(o.taxMap) : [];
    // No money entry is rewritten by the migration: an entry with no scope takes the one its line of work implies (business.scopeOf),
    // and the owner confirms the counts once (business.confirmScope then fixes each visible entry's scope).
    if (!twelve && !out.entries.some((e) => e.domain === 'money' && (e.type === 'income' || e.type === 'expense'))) out.settings.business.scopeConfirmed = true;
    {
      const payeeIds = new Set(out.payees.map((x) => x.id)), invIds = new Set(out.invoices.map((x) => x.id)), entIds = new Set(out.entries.map((x) => x.id));
      for (const e of out.entries) {
        if (e.payeeId !== undefined && !payeeIds.has(e.payeeId)) delete e.payeeId;
        if (e.billedInvoiceId !== undefined && !invIds.has(e.billedInvoiceId)) delete e.billedInvoiceId;
      }
      for (const i of out.invoices) {
        if (i.projectId !== undefined && !pids.has(i.projectId)) delete i.projectId;
        if (i.incomeId !== undefined && !entIds.has(i.incomeId)) delete i.incomeId;
      }
      for (const t of out.trips) if (t.projectId !== undefined && !pids.has(t.projectId)) delete t.projectId;
    }
    // Schema 19 adds clients (and an optional client link on invoices), shows, episodes, platform numbers, sites and site traffic.
    // Older formats get empty collections. Links to records that no longer exist are dropped; nothing else is.
    {
      const nineteen = o.schema >= 19, Cl = L.clients, Md = L.media;
      out.clients = nineteen ? Cl.cleanClients(o.clients, { projects: out.projects, people: out.people }) : [];
      const rawShows = nineteen && Array.isArray(o.shows) ? o.shows.filter((x) => isObj(x) && typeof x.id === 'string').map((x) => ({ id: x.id })) : [];
      out.sites = nineteen ? Md.cleanSites(o.sites, { projects: out.projects, renewals: out.renewals, shows: rawShows }) : [];
      out.shows = nineteen ? Md.cleanShows(o.shows, { projects: out.projects, sites: out.sites }) : [];
      out.episodes = nineteen ? Md.cleanEpisodes(o.episodes, { shows: out.shows, people: out.people }) : [];
      out.platformStats = nineteen ? Md.cleanStats(o.platformStats, { shows: out.shows, episodes: out.episodes }) : [];
      out.siteTraffic = nineteen ? Md.cleanTraffic(o.siteTraffic, { sites: out.sites }) : [];
      const showIds = new Set(out.shows.map((x) => x.id)), clientIds = new Set(out.clients.map((x) => x.id));
      for (const x of out.sites) if (x.showId !== undefined && !showIds.has(x.showId)) delete x.showId;
      for (const i of out.invoices) if (i.clientId !== undefined && (!nineteen || !clientIds.has(i.clientId))) delete i.clientId;
    }
    // Schema 21 adds saved meals and the meal log (Eating, in Health). Older formats get empty lists; a link to a meal that no longer
    // exists is dropped and the logged row is kept.
    out.meals = o.schema >= 21 ? L.food.cleanMeals(o.meals) : [];
    out.mealLog = o.schema >= 21 ? L.food.cleanLog(o.mealLog, out.meals) : [];
    // Schema 24 (v2.4.0) adds a country and a currency to each account and a country to each Admin tax item (older formats take the
    // home country and the vault currency, which is how they were read before), country tax records and country tax-year profiles.
    out.countryTax = o.schema >= 24 ? L.countries.cleanRecords(o.countryTax) : [];
    out.countryTaxYears = o.schema >= 24 ? L.countries.cleanProfiles(o.countryTaxYears) : [];
    L.countries.fill(out, o, o.schema);
    // Schema 14 adds the archive index and the yearly summaries (numbers only). Older formats have neither.
    out.archives = o.schema >= 14 ? L.archive.cleanArchives(o.archives) : [];
    out.summaries = o.schema >= 14 ? L.archive.cleanSummaries(o.summaries, out.archives) : {};
    // Schema 15 adds the device bookkeeping block: backup and sync dates, the save counter, the storage result and the codes-only diagnostics ring.
    out.ops = L.ops.cleanOps(o.ops, o.schema);
    out.memory = cleanMemory(o.memory, o.schema);
    out.audit = cleanAudit(o.audit);
    if (!out.memory.startedOn) out.memory.startedOn = deriveStartedOn(out);
    // Schema 10 adds the private vault: checked structurally only (types, base64, sizes, iteration count, mark names); the key is never needed.
    if (o.priv !== undefined) {
      if (o.schema < 10) fail('private vault needs schema 10');
      if (!L.priv) fail('private vault module missing');
      try { out.priv = L.priv.cleanBlob(o.priv); } catch (e) { fail(e.message); }
    }
    // The schema the input was written in, so callers can tell an older-format copy (no work data) from a schema 3 one.
    // Not enumerable: it never reaches the stored state, a backup or the fingerprint.
    Object.defineProperty(out, 'sourceSchema', { value: o.schema, enumerable: false });
    return out;
  }
  // Data the live state holds that an older-format copy (`next`, marked by validateState) cannot carry.
  // Schema 3 added projects and pipeline; schema 4 added the training cycle, daily checks, workout types and body targets; schema 5 added goals; schema 6 added Home and Admin collections; schema 7 added Learning; schema 8 added Activities; schema 9 added Social.
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function droppedData(cur, next) {
    const src = next && next.sourceSchema;
    if (!cur || typeof src !== 'number') return [];
    const out = [];
    // A copy without a private vault never replaces one that has it silently (any schema).
    if (cur.priv && !next.priv) out.push('private vault');
    // v1.2.0 part B: a copy that still holds records of an archived year, or has no archive index for it, never replaces silently.
    // SEC-92: named once (an older-format copy has no index, so comesBack already lists every archived year).
    const back = L.archive ? L.archive.comesBack(cur, next) : [];
    if (!back.length && src < 14) for (const a of cur.archives || []) back.push(String(a.year));
    if (back.length) out.push('archived years ' + andList(back));
    if (src < 3) { if ((cur.projects || []).length) out.push('projects'); if ((cur.pipeline || []).length) out.push('pipeline items'); }
    if (src < 5 && (cur.goals || []).length) out.push('goals');
    if (src < 6) {
      for (const [k, n] of [['properties', 'properties'], ['vehicles', 'vehicles'], ['maintenance', 'maintenance items'], ['renewals', 'renewals'], ['documents', 'documents'], ['taxItems', 'tax items']]) if ((cur[k] || []).length) out.push(n);
      if ((cur.recurring || []).some((r) => r.household)) out.push('household bill flags');
    }
    if (src < 7) {
      for (const [k, n] of [['learningItems', 'learning items'], ['studySessions', 'study sessions'], ['takeaways', 'takeaways']]) if ((cur[k] || []).length) out.push(n);
      if (cur.settings && cur.settings.learning && cur.settings.learning.weeklyMinutes > 0) out.push('study target');
    }
    if (src < 8) {
      if ((cur.activities || []).length) out.push('activities');
      if (cur.activityCategories && !sameJson(cur.activityCategories, L.activities.DEFAULT_CATEGORIES)) out.push('activity categories');
    }
    if (src < 9) {
      for (const [k, n] of [['groups', 'social groups'], ['people', 'people'], ['contacts', 'logged contacts']]) if ((cur[k] || []).length) out.push(n);
    }
    if (src < 11) {
      // v0.12.0: lines of work (website and podcast kinds, parents), money linked to them, expected income and dashboard layouts.
      const ps = cur.projects || [], money = (cur.entries || []).filter((e) => e.domain === 'money');
      if (ps.some((p) => p.parentId || p.kind === 'website' || p.kind === 'podcast')) out.push('line of work kinds and parents');
      if (money.some((e) => e.projectId) || (cur.recurring || []).some((r) => r.projectId) || (cur.goals || []).some((g) => g.projectId)) out.push('money linked to lines of work');
      if (money.some((e) => e.status === 'expected' || e.status === 'written-off' || e.dueDate)) out.push('expected income');
      const ls = cur.settings && cur.settings.layouts;
      if (ls && ((ls.narrow || []).length || (ls.wide || []).length)) out.push('dashboard layouts');
    }
    if (src < 12) {
      // v1.1.0: business records, tax profiles, the home-office figures and budgets.
      for (const [k, n] of [['invoices', 'invoices'], ['trips', 'mileage trips'], ['payees', 'payees'], ['taxPayments', 'estimated tax payments'], ['taxMap', 'tax line mappings']]) if ((cur[k] || []).length) out.push(n);
      if (Object.keys(cur.taxYears || {}).length) out.push('tax year profiles');
      if (Object.keys(cur.homeOffice || {}).length) out.push('home-office figures');
      if ((cur.projects || []).some((p) => p.budgetCents !== undefined)) out.push('project budgets');
      const money = (cur.entries || []).filter((e) => e.domain === 'money');
      if (money.some((e) => e.scope === 'business' || e.billable || e.reimbursable || e.billedInvoiceId || e.payeeId || e.contractor || e.cardPaid)) out.push('business expense and income marks');
      const b = cur.settings && cur.settings.business;
      if (b && (b.name || b.address || b.paymentTerms || b.invoiceNext > 1 || b.reserveAccountId || b.pinnedProjectId)) out.push('business settings');
    }
    if (src < 17) {
      // v1.5.0: muted suggestion kinds and rejection reason codes.
      const mem = cur.memory || {};
      if ((mem.mutes || []).some((x) => x.active)) out.push('muted suggestions');
      if ((mem.insights || []).some((i) => i.reason)) out.push('rejection reasons');
      if ((mem.insights || []).some((i) => i.target)) out.push('proposed target changes');
    }
    if (src < 18) {
      // v1.6.0: job search details on pipeline items.
      const JOB = ['role', 'locationType', 'targetOteCents', 'targetBaseCents', 'offerOteCents', 'offerBaseCents', 'appliedOn', 'resume', 'followUp', 'followedUpOn', 'lostReason', 'importKey'];
      if ((cur.pipeline || []).some((x) => JOB.some((k) => x[k] !== undefined))) out.push('job search details');
    }
    if (src < 19) {
      // v1.7.0: clients, shows, episodes, platform numbers, sites and site traffic, the client link on invoices, the contact reminder days.
      for (const [k, n] of [['clients', 'clients'], ['shows', 'shows'], ['episodes', 'episodes'], ['platformStats', 'platform numbers'], ['sites', 'sites'], ['siteTraffic', 'site traffic months']]) if ((cur[k] || []).length) out.push(n);
      if ((cur.invoices || []).some((i) => i.clientId !== undefined)) out.push('client links on invoices');
      const cs = cur.settings && cur.settings.clients;
      if (cs && cs.contactDays !== L.clients.DEFAULT_CONTACT_DAYS) out.push('client contact reminder days');
    }
    if (src < 21) {
      // v2.1.0: saved meals, the meal log and the daily protein target.
      for (const [k, n] of [['meals', 'saved meals'], ['mealLog', 'logged meals']]) if ((cur[k] || []).length) out.push(n);
      const fd = cur.settings && cur.settings.food;
      if (fd && fd.proteinTarget !== undefined) out.push('protein target');
    }
    if (src < 22) {
      // v2.2.0: degree and language learning items, next steps and their dates, and minutes per week on an item.
      const li = cur.learningItems || [];
      if (li.some((i) => i.kind === 'degree' || i.kind === 'language')) out.push('degree and language learning items');
      if (li.some((i) => i.nextAction !== undefined || i.nextDate !== undefined)) out.push('learning next steps');
      if (li.some((i) => i.weeklyMinutes !== undefined)) out.push('minutes per week on learning items');
    }
    if (src < 23) {
      // v2.3.0: the Overview's chosen key numbers and shortcuts (an older version shows its own dashboard instead).
      const ov = cur.settings && cur.settings.overview;
      if (ov && ov.custom === true) out.push('Overview choices');
    }
    if (src < 24) {
      // v2.4.0: countries and currencies on accounts and tax items, country tax records and profiles, the country list and the rates.
      const st = cur.settings || {}, home = st.countries ? st.countries.home : 'US';
      if ((cur.accounts || []).some((a) => (a.country && a.country !== home) || (a.currency && a.currency !== st.currency))) out.push('account countries and currencies');
      for (const [k, n] of [['countryTax', 'country tax records'], ['countryTaxYears', 'country tax profiles']]) if ((cur[k] || []).length) out.push(n);
      if ((cur.taxItems || []).some((t) => t.country && t.country !== home)) out.push('countries on tax checklist items');
      if ((st.fx || []).length) out.push('exchange rates');
      if (st.countries && !sameJson(st.countries, L.countries.defaultSettings())) out.push('country list');
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
  const COUNTED = { properties: 'properties', vehicles: 'vehicles', 'maintenance items': 'maintenance', renewals: 'renewals', documents: 'documents', 'tax items': 'taxItems', 'learning items': 'learningItems', 'study sessions': 'studySessions', takeaways: 'takeaways', activities: 'activities', 'social groups': 'groups', people: 'people', 'logged contacts': 'contacts', invoices: 'invoices', 'mileage trips': 'trips', payees: 'payees', 'estimated tax payments': 'taxPayments', clients: 'clients', shows: 'shows', episodes: 'episodes', 'platform numbers': 'platformStats', sites: 'sites', 'site traffic months': 'siteTraffic', 'saved meals': 'meals', 'logged meals': 'mealLog', 'country tax records': 'countryTax', 'country tax profiles': 'countryTaxYears' };
  function lossText(cur, next, list) {
    return andList((list || droppedData(cur, next)).map((n) => (n === 'projects' ? cur.projects.length + ' projects' : n === 'pipeline items' ? cur.pipeline.length + ' pipeline items' : n === 'daily checks' ? cur.habits.length + ' daily checks' : n === 'goals' ? cur.goals.length + ' goals' : COUNTED[n] ? cur[COUNTED[n]].length + ' ' + n : 'your ' + n)));
  }
  function lossWhy(list, older, what) {
    const l = list || [], arch = l.some((n) => /^archived years /.test(n)), pv = l.includes('private vault');
    return (older ? what + ' is from an older version of LifeOS. ' : '') + (pv ? what + ' has no private vault. ' : '') + (arch ? what + ' still holds years archived here (they would come back into the live vault). ' : '');
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
        nas: { token: '', tokenAt: '', remoteRev: -1, srev: -1, fp: '', keySalt: '' },
        aiHosts: { nasModel: '', pcModel: '', fallback: '' },
        health: { units: 'lb' },
        home: { starterDone: false },
        learning: { weeklyMinutes: 0 },
        privAutoLockSec: 60,
        layouts: { narrow: [], wide: [] },
        business: L.business.defaultSettings(true),
        archiveSuggestMB: 40,
        backupReminderDays: 7, syncReminder: false,
        setup: { dismissed: false, targetsSaved: false },
        clients: { contactDays: 30 },
        food: {},
        overview: { custom: false, metrics: [], shortcuts: [] },
        countries: L.countries.defaultSettings(), fx: [],
      },
      entries: [],
      accounts: [], recurring: [], budgets: [], categories: defaultCategories(),
      projects: [], pipeline: [], goals: [],
      properties: [], vehicles: [], maintenance: [], renewals: [], documents: [], taxItems: [],
      learningItems: [], studySessions: [], takeaways: [],
      activities: [], activityCategories: L.activities.DEFAULT_CATEGORIES.slice(),
      groups: [], people: [], contacts: [],
      payees: [], invoices: [], trips: [], taxPayments: [], taxYears: {}, homeOffice: {}, taxMap: [],
      clients: [], shows: [], episodes: [], platformStats: [], sites: [], siteTraffic: [],
      archives: [], summaries: {}, ops: L.ops.defaultOps(),
      cycle: null, kinds: L.metrics.DEFAULT_KINDS.slice(), habits: [], habitLog: [],
      meals: [], mealLog: [],
      countryTax: [], countryTaxYears: [],
      memory: { insights: [], lessons: [], reviews: [], lastReviewAt: '', mutes: [], startedOn: localToday() },
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
  // Every write is an envelope v2 (a v1 file read earlier is rewritten here, the first time it is saved).
  async function seal(k, clean, rev) {
    if (!deviceId) deviceId = newId();
    const m = { rev, updatedAt: new Date().toISOString(), deviceId };
    const env = await V().sealEnvelope(k, Object.assign({}, clean, { _meta: m }), m);
    return { env, m };
  }

  // ---- lifecycle ----
  const V = () => L.vault;
  const replaceContents = (target, src) => {
    for (const k of Object.keys(target)) delete target[k];
    Object.assign(target, src);
  };
  const serial = (fn) => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };
  const requireUnlocked = () => { if (!state || !ks) throw new Error('LOCKED'); };

  // True when `p` is the main passphrase: tried against the stored envelope, never compared with anything stored.
  async function matchesMain(p) {
    requireUnlocked();
    const env = await getAdapter().get(KEY);
    if (!env) return false;
    return V().verifySecret(env, p);
  }
  const dropPriv = () => { if (L.priv) L.priv.close('system'); };
  async function exists() { return !!(await getAdapter().get(KEY)); }
  async function init(passphrase) {
    V().checkPassphrase(passphrase);
    const a = getAdapter();
    if (await a.get(KEY)) throw new Error('VAULT_EXISTS');
    const k = await V().newKeyset(passphrase, null);
    const st = defaultState();
    const sealed = await seal(k, st, 0);
    await a.set(KEY, sealed.env);
    ks = k; state = st; meta = sealed.m;
    if (L.search) L.search.build();
    return st;
  }
  // SEC-127: a v1 file upgraded to v2 under the same passphrase is the same key as far as sync is concerned. The sync record names the
  // v1 salt; it is carried to the new passphrase wrap salt (in memory now, stored with the next write), so the upgrade alone is never
  // taken for a passphrase change on this device (which would turn another device's ordinary upload into a conflict).
  function carryKeySalt(st, parsed, k) {
    const sy = st && st.settings && st.settings.sync;
    if (sy && sy.keySalt && sy.keySalt === V().passSaltOf(parsed)) sy.keySalt = saltOf(k);
  }
  async function unlock(passphrase) {
    const env = await getAdapter().get(KEY);
    if (!env) throw new Error('NO_VAULT');
    const o = await V().openEnvelope(env, passphrase);
    const st = validateState(o.raw);
    const m = readMeta(env, o.raw);
    // A v1 file opens with the passphrase; its v2 key set (a new random data key wrapped under the passphrase) is made now and written on the next save.
    const k = o.fmt === 2 ? { key: o.key, kek: o.kek, wraps: o.wraps } : await V().newKeyset(passphrase, null);
    if (o.fmt === 1) carryKeySalt(st, o.parsed, k);
    meta = m; deviceId = meta.deviceId || deviceId;
    ks = k; state = st;
    if (L.search) L.search.build(); // v1.6.0: built on unlock, in memory only
    return st;
  }
  function lock() {
    dropPriv();
    if (L.archive) L.archive.drop();
    if (L.search) L.search.drop(); // v1.6.0: the search index lives only while unlocked
    // Empty the live state object too, so any reference still held elsewhere no longer reaches plaintext.
    if (state) { try { replaceContents(state, {}); } catch (e) { /* ignore */ } }
    ks = null; state = null; pendingRecovery = null; meta = { rev: 0, updatedAt: '', deviceId: '' };
  }
  const isUnlocked = () => !!(state && ks);
  function getState() { requireUnlocked(); return state; }

  function commit(fn, opts) {
    return serial(async () => {
      requireUnlocked();
      const st = state, k = ks;
      const snapshot = JSON.parse(JSON.stringify(st));
      let taken = [];
      try {
        await fn(st);
        // v1.3.0: the queued diagnostic codes join the encrypted ring in the same write.
        taken = L.ops.flush(st);
        const clean = validateState(st);
        const sealed = await seal(k, clean, opts && opts.quiet ? meta.rev : meta.rev + 1);
        if (ks !== k) throw new Error('LOCKED');
        await getAdapter().set(KEY, sealed.env);
        if (state !== st) throw new Error('LOCKED');
        meta = sealed.m;
        replaceContents(st, clean);
        if (L.search) L.search.invalidate();
      } catch (e) {
        if (state === st) replaceContents(st, snapshot);
        if (taken.length) L.ops.requeue(taken);
        throw e;
      }
    });
  }
  const wrongPass = () => new Error('BAD_PASSPHRASE_OR_DATA');
  // A new data key, new wraps (fresh salts) and the state sealed under it, in one write. Runs inside the serial queue.
  async function rotateKeys(pass, recoveryText) {
    const st = state;
    const nk = await V().newKeyset(pass, recoveryText || null);
    const sealed = await seal(nk, validateState(st), meta.rev + 1);
    if (state !== st) throw new Error('LOCKED');
    await getAdapter().set(KEY, sealed.env);
    if (state !== st) throw new Error('LOCKED');
    ks = nk; meta = sealed.m;
  }
  const storedWraps = async () => { const p = V().parseEnvelope(await getAdapter().get(KEY)); return p.fmt === 2 ? p.wraps : null; };
  // Passphrase change rotates the data key. With a recovery key on, opts.keepRecovery (the current key, typed) keeps it, or
  // opts.newRecoveryKey (a new key from vault.newRecoveryKey, already shown to and retyped by the owner) replaces it; with neither the change is refused.
  function changePassphrase(oldP, newP, opts) {
    return serial(async () => {
      requireUnlocked();
      const st = state;
      V().checkPassphrase(newP);
      if (st.priv && L.priv && (await L.priv.matches(st.priv, newP))) throw new Error('The main passphrase must be different from the private vault passphrase.');
      const a = getAdapter();
      const env = await a.get(KEY);
      await V().openEnvelope(env, oldP);
      const wraps = await storedWraps();
      let rec = null;
      if (wraps && wraps.some((w) => w.kind === 'recovery')) {
        if (opts && typeof opts.keepRecovery === 'string' && opts.keepRecovery) {
          await V().unwrapWith(wraps, { recovery: opts.keepRecovery }); // a wrong key is BAD_RECOVERY_KEY, a typo RECOVERY_KEY_FORMAT
          rec = opts.keepRecovery;
        } else if (opts && typeof opts.newRecoveryKey === 'string' && opts.newRecoveryKey) { await V().parseRecoveryKey(opts.newRecoveryKey); rec = opts.newRecoveryKey; }
        else { const e = new Error('Type your current recovery key to keep it, or choose a new one.'); e.code = 'RECOVERY_CHOICE'; throw e; }
      }
      await rotateKeys(newP, rec);
      dropPriv();
    });
  }
  // ---- recovery key (v1.8.0) ----
  const retyped = (keyText, typed) => V().retypeMatches(keyText, typed);
  const hasRecovery = () => { requireUnlocked(); return ks.wraps.some((w) => w.kind === 'recovery'); };
  // True when `text` is the current recovery key (a typo is RECOVERY_KEY_FORMAT). Opens nothing.
  async function recoveryMatches(text) {
    requireUnlocked();
    try { await V().unwrapWith(ks.wraps, { recovery: text }); return true; }
    catch (e) { if (e && e.code === 'BAD_RECOVERY_KEY') return false; throw e; }
  }
  // Start turning a recovery key on, or replacing the one in force. Asks for the main passphrase. Resolves to { key, finish(typed), cancel() }:
  // key is the new key text (shown once by the caller); nothing changes until finish(typed) gets the key retyped (all of it, or its last two groups).
  async function beginRecovery(passphrase) {
    requireUnlocked();
    if (!(await matchesMain(passphrase))) throw wrongPass();
    const text = await V().newRecoveryKey(), st0 = state;
    let live = true;
    const handle = {
      key: text,
      cancel() { live = false; },
      finish: (typed) => serial(async () => {
        requireUnlocked();
        if (!live || state !== st0) throw new Error('That recovery key is no longer valid. Start again.');
        if (!retyped(text, typed)) { const e = new Error('That is not the recovery key shown. Check it against the key on screen and try again.'); e.code = 'RECOVERY_RETYPE'; throw e; }
        if (!(await matchesMain(passphrase))) throw wrongPass();
        await rotateKeys(passphrase, text);
        live = false;
      }),
    };
    return handle;
  }
  // Turn the recovery key off (asks for the main passphrase): the data key rotates and the recovery wrap is gone.
  function turnOffRecovery(passphrase) {
    return serial(async () => {
      requireUnlocked();
      if (!(await matchesMain(passphrase))) throw wrongPass();
      await rotateKeys(passphrase, null);
    });
  }
  const RECOVERY_HOLD_MS = 5 * 60 * 1000;
  // Forgot the passphrase: open the vault with the recovery key (nothing is written yet) and resolve to { prepare(newPass), cancel() }.
  // prepare(newPass) resolves to { key, finish(typed) }: a new data key, the new passphrase and a new recovery key; the key used stops working.
  async function openWithRecovery(recoveryText) {
    if (state || ks) throw new Error('VAULT_OPEN');
    const a = getAdapter(), env = await a.get(KEY);
    if (!env) throw new Error('NO_VAULT');
    const o = await V().openEnvelope(env, { recovery: recoveryText });
    const st = validateState(o.raw), m = readMeta(env, o.raw), before = JSON.stringify(env);
    // SEC-129: the decrypted copy waits on the lock screen for a new passphrase only for a limited time; cancel or the limit empties it.
    let live = true;
    const until = Date.now() + RECOVERY_HOLD_MS;
    const drop = () => { live = false; try { replaceContents(st, {}); } catch (e) { /* ignore */ } };
    const timer = setTimeout(drop, RECOVERY_HOLD_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    const gone = () => { if (live && Date.now() > until) drop(); if (!live) throw new Error('That recovery key is no longer valid. Start again.'); };
    return {
      cancel() { clearTimeout(timer); if (live) drop(); }, // after a finished recovery st is the live state: never emptied here
      prepare: async (newPass) => {
        gone();
        V().checkPassphrase(newPass);
        if (st.priv && L.priv && (await L.priv.matches(st.priv, newPass))) throw new Error('The main passphrase must be different from the private vault passphrase.');
        const text = await V().newRecoveryKey();
        return {
          key: text,
          finish: (typed) => serial(async () => {
            gone();
            if (state || ks) throw new Error('That recovery key is no longer valid. Start again.');
            if (!retyped(text, typed)) { const e = new Error('That is not the recovery key shown. Check it against the key on screen and try again.'); e.code = 'RECOVERY_RETYPE'; throw e; }
            if (JSON.stringify(await a.get(KEY)) !== before) throw new Error('The vault changed while you were recovering it. Nothing was written. Start again.');
            deviceId = m.deviceId || deviceId;
            const nk = await V().newKeyset(newPass, text);
            const sealed = await seal(nk, st, m.rev + 1);
            await a.set(KEY, sealed.env);
            ks = nk; state = st; meta = sealed.m; live = false; clearTimeout(timer);
            if (L.search) L.search.build();
            return st;
          }),
        };
      },
    };
  }
  // v1.3.0: dates, counters, the storage result and diagnostics describe this device, so a restored or downloaded copy never replaces them;
  // the reminder settings come from the copy only when it is new enough to carry them.
  function keepLocalOps(target, local, srcSchema) {
    if (local.ops) target.ops = JSON.parse(JSON.stringify(local.ops));
    if (typeof srcSchema === 'number' && srcSchema < 15 && local.settings) {
      target.settings.backupReminderDays = local.settings.backupReminderDays; target.settings.syncReminder = local.settings.syncReminder;
    }
  }
  function replaceState(next, opts) {
    return serial(async () => {
      requireUnlocked();
      const st = state;
      // CR-7: validate first and judge what would be lost from the result. The format marker comes from the caller's earlier
      // validation when present (an older backup already migrated in memory), else from this one, so it can never be missing.
      const clean = validateState(next);
      const src = next && typeof next.sourceSchema === 'number' ? next.sourceSchema : clean.sourceSchema;
      if (typeof src !== 'number') throw new Error('Invalid data: unknown format');
      const probe = Object.defineProperty({ priv: clean.priv, entries: clean.entries, archives: clean.archives, summaries: clean.summaries, invoices: clean.invoices, taxPayments: clean.taxPayments, trips: clean.trips, contacts: clean.contacts, studySessions: clean.studySessions, activities: clean.activities, maintenance: clean.maintenance, renewals: clean.renewals, habitLog: clean.habitLog, memory: clean.memory }, 'sourceSchema', { value: src, enumerable: false });
      if (dropsWork(st, probe) && !(opts && opts.allowWorkLoss === true)) {
        const e = new Error(lossWhy(droppedData(st, probe), src < 14, 'This backup') + 'Restoring it would remove your ' + lossText(st, probe) + '. Nothing was replaced. Tick the box to go ahead.'); e.code = 'OLDER_FORMAT'; throw e;
      }
      dropPriv();
      // A restored backup never brings its own sync bookkeeping: an older remoteRev would weaken the rollback
      // check, and a different OAuth client ID would be swapped in without the user seeing it.
      clean.settings.sync = Object.assign({}, st.settings.sync);
      clean.settings.nas = Object.assign({}, st.settings.nas);
      keepLocalOps(clean, st, src);
      if (src < 20) clean.settings.aiHosts = Object.assign({}, st.settings.aiHosts);
      const sealed = await seal(ks, clean, meta.rev + 1);
      if (state !== st) throw new Error('LOCKED');
      await getAdapter().set(KEY, sealed.env);
      if (state !== st) throw new Error('LOCKED');
      meta = sealed.m;
      replaceContents(st, clean);
      if (L.search) L.search.invalidate();
    });
  }
  // ---- sync support (additive) ----
  const getMeta = () => { requireUnlocked(); return Object.assign({}, meta); };
  // Public identifier of the live key generation: the passphrase wrap's salt in base64 (not secret; it is in every envelope). Every change of
  // passphrase or recovery key makes new wraps with fresh salts, so a change on one device is still seen as a local change.
  const saltOf = (k) => k.wraps.find((w) => w.kind === 'passphrase').kdf.salt;
  const saltId = () => { requireUnlocked(); return saltOf(ks); };
  // Current stored envelope, re-sealed first if it has no rev yet or must reach at least minRev.
  // opts.snapshot(state): an async function run on the live state inside the same serial step, so its result describes exactly the
  // exported content (CR-1); the call then resolves to { env, snap, saltId }.
  function exportEnvelope(minRev, opts) {
    return serial(async () => {
      requireUnlocked();
      const a = getAdapter(), st = state, k = ks;
      let env = await a.get(KEY);
      const want = Math.max(meta.rev, Number.isInteger(minRev) ? minRev : 0);
      if (!env) throw new Error('NO_VAULT');
      // A v1 file is rewritten as v2 here, so every copy that leaves this device carries the wraps.
      if (env.rev === undefined || env.rev < want || env.fmt !== 2) {
        const sealed = await seal(k, validateState(st), want);
        if (state !== st || ks !== k) throw new Error('LOCKED');
        await a.set(KEY, sealed.env);
        meta = sealed.m; env = sealed.env;
      }
      if (opts && typeof opts.snapshot === 'function') {
        const snap = await opts.snapshot(st);
        if (state !== st || ks !== k) throw new Error('LOCKED');
        return { env, snap, saltId: saltOf(k) };
      }
      return env;
    });
  }
  // Open an untrusted remote envelope. Uses the live key when its wraps are exactly ours, else needs the passphrase.
  async function inspectEnvelope(env, passphrase) {
    requireUnlocked();
    const p = V().parseEnvelope(env);
    const same = p.fmt === 2 && JSON.stringify(p.wraps) === JSON.stringify(ks.wraps);
    let o;
    if (same) o = { key: ks.key, kek: ks.kek, wraps: ks.wraps, fmt: 2 };
    else if (typeof passphrase !== 'string' || !passphrase) { const e = new Error('Enter the passphrase of the Drive copy.'); e.code = 'NEED_PASSPHRASE'; throw e; }
    let raw;
    try {
      if (same) { await V().checkShell(p.clean, ks.kek); raw = await V().decrypt(ks.key, p.data); }
      else { o = await V().openEnvelope(env, passphrase); raw = o.raw; }
    } catch (e) { const x = new Error('The Drive copy uses a different passphrase.'); x.code = 'WRONG_PASSPHRASE'; throw x; }
    const m = readMeta(env, raw);
    // A v1 copy opens with the passphrase; its v2 key set is made now and the stored copy is rewritten on the next save.
    const k = o.fmt === 2 ? { key: o.key, kek: o.kek, wraps: o.wraps } : await V().newKeyset(passphrase, null);
    return { meta: m, state: validateState(raw), sourceSchema: raw && raw.schema, ks: k, salt: p.salt, env, sameKey: same };
  }
  // Replace the local vault with an inspected remote one (same passphrase).
  function adoptEnvelope(info) {
    return serial(async () => {
      requireUnlocked();
      const st = state, e = info.env;
      dropPriv();
      // Persist only the known envelope fields, never whatever else the remote JSON carried.
      await getAdapter().set(KEY, V().cleanEnvelope(e));
      if (state !== st) throw new Error('LOCKED');
      ks = info.ks; meta = Object.assign({}, info.meta);
      // SEC-94: like a restore, a downloaded copy never replaces this device's ops (diagnostics, storage result, dates, snooze).
      // The sync bookkeeping write that follows every adopt seals this into the stored envelope.
      const next = JSON.parse(JSON.stringify(info.state));
      keepLocalOps(next, st, info.sourceSchema);
      // v2.0.0: the token and bookkeeping belong to this device; a downloaded copy never replaces them.
      if (st.settings && st.settings.nas) next.settings.nas = JSON.parse(JSON.stringify(st.settings.nas));
      replaceContents(st, next);
      if (L.search) L.search.invalidate();
    });
  }

  // ---- v1.4.0: first-run paths on the lock screen (no vault exists yet) ----
  // Both build the whole vault in memory, check it exactly as a backup restore (validateState) or a Drive download (revision check and
  // validateState, as inspectEnvelope) does, and only then make one write. Any failure before that write leaves nothing stored.
  async function startFrom(passphrase, clean, rev, deviceFrom) {
    const a = getAdapter();
    const k = await V().newKeyset(passphrase, null);
    const sealed = await seal(k, clean, rev);
    if (await a.get(KEY)) throw new Error('VAULT_EXISTS');
    await a.set(KEY, sealed.env);
    ks = k; state = clean; meta = sealed.m;
    if (L.search) L.search.build();
    return clean;
  }
  // Restore a verified backup (the state importBackup returned) as this device's new vault under `passphrase`.
  function createFromBackup(passphrase, backupState) {
    return serial(async () => {
      if (state || ks) throw new Error('VAULT_EXISTS');
      V().checkPassphrase(passphrase);
      const clean = validateState(backupState);
      const src = backupState && typeof backupState.sourceSchema === 'number' ? backupState.sourceSchema : clean.sourceSchema;
      if (typeof src !== 'number') throw new Error('Invalid data: unknown format');
      if (clean.priv && L.priv && (await L.priv.matches(clean.priv, passphrase))) throw new Error('The vault passphrase must be different from the private vault passphrase. Use a backup whose passphrase differs.');
      // Like a restore: the backup brings no sync bookkeeping, no device dates and no diagnostics of its own.
      const fresh = defaultState();
      clean.settings.sync = fresh.settings.sync;
      clean.settings.nas = fresh.settings.nas;
      clean.ops = fresh.ops;
      if (src < 15) { clean.settings.backupReminderDays = fresh.settings.backupReminderDays; clean.settings.syncReminder = fresh.settings.syncReminder; }
      return startFrom(passphrase, validateState(clean), 0);
    });
  }
  // Use a Drive copy (an envelope) as this device's new vault under the same passphrase. Same checks as sync.inspect and adoptEnvelope.
  function installEnvelope(env, passphrase) {
    return serial(async () => {
      if (state || ks) throw new Error('VAULT_EXISTS');
      if (typeof passphrase !== 'string' || !passphrase) { const e = new Error('Enter the passphrase of the Drive copy.'); e.code = 'NEED_PASSPHRASE'; throw e; }
      const parsed = V().parseEnvelope(env);
      let o, raw;
      try { o = await V().openEnvelope(env, passphrase); raw = o.raw; }
      catch (e) { const x = new Error('The Drive copy uses a different passphrase.'); x.code = 'WRONG_PASSPHRASE'; throw x; }
      const m = readMeta(env, raw), st = validateState(raw), a = getAdapter();
      if (await a.get(KEY)) throw new Error('VAULT_EXISTS');
      // Persist only the known envelope fields, never whatever else the remote JSON carried. A v1 copy is stored as it came and rewritten as v2 on the next save.
      await a.set(KEY, V().cleanEnvelope(env));
      ks = o.fmt === 2 ? { key: o.key, kek: o.kek, wraps: o.wraps } : await V().newKeyset(passphrase, null);
      if (o.fmt === 1) carryKeySalt(st, parsed, ks);
      meta = Object.assign({}, m); deviceId = m.deviceId || deviceId;
      const fresh = defaultState();
      st.settings.nas = fresh.settings.nas; // this device registers its own token
      st.ops = fresh.ops; // the device's own dates and diagnostics start empty, as after a restore
      state = st;
      if (L.search) L.search.build();
      return { meta: Object.assign({}, m), state: st, sourceSchema: raw && raw.schema, salt: parsed.salt };
    });
  }
  async function wipe() {
    await serial(async () => { await getAdapter().del(KEY); });
    lock();
  }

  // Validation helpers shared with home.js and admin.js (same rules and messages as the rest of validateState).
  L.validate = { fail, isObj, str, num, date, oneOf, bool, arr, strip, ts, newId };
  L.store = { SCHEMA, RECOVERY_HOLD_MS, _rawEnvelope: () => getAdapter().get(KEY), matchesMain, hasRecovery, recoveryMatches, beginRecovery, turnOffRecovery, openWithRecovery, _setAdapter, exists, init, unlock, lock, isUnlocked, getState, commit, changePassphrase, replaceState, wipe, validateState, newId, defaultState, getMeta, saltId, exportEnvelope, inspectEnvelope, adoptEnvelope, createFromBackup, installEnvelope, dropsWork, droppedData, nameList, lossText, lossWhy, LOCATION_TYPES, LOST_REASONS, COMP_FIELDS, validateGoals: (list, privOk) => cleanGoals(list, privOk === true) };
})();
