(function () {
  'use strict';
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const KEY = 'envelope';
  const ENTRY_CAP = 50000, INSIGHT_CAP = 5000, REVIEW_CAP = 1000, LESSON_CAP = 30, AUDIT_CAP = 200;
  const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
  // Same rule as ai.isLocalUrl (ai.js loads after this file, so call it lazily).
  const BIDI = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
  const strip = (v) => (typeof v === 'string' ? v.replace(BIDI, '') : v);
  let adapter = null, key = null, salt = null, state = null, queue = Promise.resolve();

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

  function cleanSettings(s) {
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
    };
  }
  function cleanEntryText(e) {
    if (!isObj(e)) return e;
    const o = Object.assign({}, e);
    for (const k of ['title', 'notes', 'person', 'status']) if (typeof o[k] === 'string') o[k] = strip(o[k]);
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
  function cleanDigest(d) {
    if (!isObj(d) || !isObj(d.domains)) fail('digest');
    const domains = {};
    for (const id of domainIds()) {
      const x = d.domains[id];
      if (x === undefined) continue;
      if (!isObj(x)) fail('digest domain');
      domains[id] = { now: num(x.now, -1e15, 1e15, 'digest'), prev: num(x.prev, -1e15, 1e15, 'digest'), unit: str(x.unit, 20, 'unit', true) };
    }
    return { week: date(d.week, 'digest week'), domains };
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
  function validateState(o) {
    if (!isObj(o)) fail('state must be an object');
    scan(o, 0, { n: 4e6 });
    if (o.schema !== 1) fail('unsupported schema');
    if (!L.metrics) fail('metrics module missing');
    return { schema: 1, settings: cleanSettings(o.settings), entries: cleanEntries(o.entries), memory: cleanMemory(o.memory), audit: cleanAudit(o.audit) };
  }

  function defaultState() {
    return {
      schema: 1,
      settings: {
        currency: 'USD', autoLockMin: 15,
        targets: { workoutsPerWeek: 4, contactDays: 30, savingsRate: 0.2 },
        provider: { kind: 'none', baseUrl: '', model: '', apiKey: '' },
      },
      entries: [],
      memory: { insights: [], lessons: [], reviews: [] },
      audit: [],
    };
  }
  function newId() {
    const c = L._webcrypto;
    if (!c || !c.randomUUID) throw new Error('WEBCRYPTO_UNAVAILABLE');
    return c.randomUUID();
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
    await a.set(KEY, await V().makeEnvelope(k, sl, st));
    key = k; salt = sl; state = st;
    return st;
  }
  async function unlock(passphrase) {
    const env = await getAdapter().get(KEY);
    if (!env) throw new Error('NO_VAULT');
    const { salt: sl } = V().parseEnvelope(env);
    const k = await V().deriveKey(passphrase, sl);
    const st = validateState(await V().decrypt(k, env));
    key = k; salt = sl; state = st;
    return st;
  }
  function lock() {
    // Empty the live state object too, so any reference still held elsewhere no longer reaches plaintext.
    if (state) { try { replaceContents(state, {}); } catch (e) { /* ignore */ } }
    key = null; salt = null; state = null;
  }
  const isUnlocked = () => !!(state && key);
  function getState() { requireUnlocked(); return state; }

  function commit(fn) {
    return serial(async () => {
      requireUnlocked();
      const st = state, k = key, sl = salt;
      const snapshot = JSON.parse(JSON.stringify(st));
      try {
        await fn(st);
        const clean = validateState(st);
        const env = await V().makeEnvelope(k, sl, clean);
        if (key !== k) throw new Error('LOCKED');
        await getAdapter().set(KEY, env);
        if (state !== st) throw new Error('LOCKED');
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
      const env2 = await V().makeEnvelope(nk, nsl, validateState(st));
      if (state !== st) throw new Error('LOCKED');
      await a.set(KEY, env2);
      if (state !== st) throw new Error('LOCKED');
      key = nk; salt = nsl;
    });
  }
  function replaceState(next) {
    return serial(async () => {
      requireUnlocked();
      const st = state;
      const clean = validateState(next);
      const env = await V().makeEnvelope(key, salt, clean);
      if (state !== st) throw new Error('LOCKED');
      await getAdapter().set(KEY, env);
      if (state !== st) throw new Error('LOCKED');
      replaceContents(st, clean);
    });
  }
  async function wipe() {
    await serial(async () => { await getAdapter().del(KEY); });
    lock();
  }

  L.store = { _setAdapter, exists, init, unlock, lock, isUnlocked, getState, commit, changePassphrase, replaceState, wipe, validateState, newId, defaultState };
})();
