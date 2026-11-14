(function () {
  'use strict';
  // v0.11.0 part A: the private vault. A second lock inside the main state (`state.priv`). The inner plaintext holds private
  // records and `links` overlays (references from public records to private ones); the key and the plaintext live in this module
  // only while open. Everything that is not a view, a private write or a move uses the main state alone.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const ITER = 600000, CT_MAX = 40e6, LINK_CAP = 120000, WELL_MAX = 4e6, DEFAULT_SEC = 60;
  const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
  const V = () => L.vault, S = () => L.store;
  // Validating the merged view (public and private records together): private goals may use wellbeing metrics. The stored main state is always validated without this.
  const PRIVATE_OK = Object.freeze({ privateGoals: true });
  // Collections that can hold private records. `refs`: [field, target collection, isArray]. `key` defaults to id.
  const COLL = {
    entries: { refs: [['accountId', 'accounts'], ['projectId', 'projects']] },
    accounts: {}, recurring: {}, budgets: { key: (r) => r.category }, projects: {}, pipeline: {},
    goals: { refs: [['parentId', 'goals']] },
    maintenance: { refs: [['propertyId', 'properties'], ['vehicleId', 'vehicles']] },
    vehicles: {}, properties: {}, renewals: {}, documents: {}, taxItems: {},
    learningItems: { refs: [['goalId', 'goals']] },
    studySessions: { refs: [['itemId', 'learningItems']] },
    takeaways: { refs: [['itemId', 'learningItems']] },
    activities: { refs: [['goalId', 'goals'], ['expenseId', 'entries']] },
    people: { refs: [['groupId', 'groups'], ['pipelineIds', 'pipeline', true], ['projectIds', 'projects', true]] },
    groups: {}, contacts: { refs: [['personId', 'people']] },
    habits: {}, habitLog: { key: (r) => r.habitId + '|' + r.date },
    cycle: { single: true, key: () => 'cycle' },
  };
  const COLLECTIONS = Object.keys(COLL);
  const MARK_NAMES = COLLECTIONS.concat(['wellbeing']);
  const keyOf = (c, r) => (COLL[c].key ? COLL[c].key(r) : r.id);
  const refsOf = (c) => COLL[c].refs || [];
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const listOf = (st, c) => (c === 'cycle' ? (st.cycle ? [st.cycle] : []) : (Array.isArray(st[c]) ? st[c] : []));
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const bad = (m) => { const e = new Error(m); e.code = 'PRIVATE_INVALID'; return e; };

  // ---- module state: only while open ----
  let key = null, saltB64 = '', inner = null, deadline = 0, timer = null, hooked = false, queue = Promise.resolve(), gen = 0;
  const closers = [], viewBase = new WeakMap(), privRecs = new WeakSet();

  // ---- structural validation of the outer blob (needs no key) ----
  const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
  function b64len(s, name, min, max) {
    if (typeof s !== 'string' || s.length % 4 || !B64.test(s)) throw bad('private vault ' + name + ' is not valid base64');
    if (s.length < min || s.length > max) throw bad('private vault ' + name + ' has a bad size');
    return s;
  }
  function cleanBlob(x) {
    if (!isObj(x)) throw bad('private vault must be an object');
    for (const k of Object.keys(x)) if (!['v', 'kdf', 'iv', 'ct', 'rev', 'marks'].includes(k)) throw bad('private vault has an unknown field');
    if (x.v !== 1) throw bad('private vault version');
    const k = x.kdf;
    if (!isObj(k) || k.name !== 'PBKDF2' || k.hash !== 'SHA-256' || k.iter !== ITER) throw bad('private vault key settings');
    for (const f of Object.keys(k)) if (!['name', 'hash', 'iter', 'salt'].includes(f)) throw bad('private vault has an unknown field');
    b64len(k.salt, 'salt', 24, 24);
    b64len(x.iv, 'iv', 16, 16);
    b64len(x.ct, 'data', 24, CT_MAX);
    if (!Number.isInteger(x.rev) || x.rev < 0 || x.rev > 1e9) throw bad('private vault revision');
    if (!Array.isArray(x.marks) || x.marks.length > MARK_NAMES.length) throw bad('private vault marks');
    const seen = new Set();
    for (const m of x.marks) {
      if (typeof m !== 'string' || !MARK_NAMES.includes(m) || BLOCKED.has(m) || seen.has(m)) throw bad('private vault marks');
      seen.add(m);
    }
    return { v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: ITER, salt: k.salt }, iv: x.iv, ct: x.ct, rev: x.rev, marks: MARK_NAMES.filter((m) => seen.has(m)) };
  }

  // ---- inner plaintext ----
  const emptyInner = (rev) => ({ schema: 1, rev, records: {}, links: [], wellbeing: {} });
  function scanKeys(v, depth) {
    if (depth > 12) throw bad('private data is nested too deeply');
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) scanKeys(x, depth + 1); return; }
    for (const k of Object.keys(v)) { if (BLOCKED.has(k)) throw bad('private data has a forbidden key'); scanKeys(v[k], depth + 1); }
  }
  function checkInner(p, rev) {
    if (!isObj(p)) throw bad('private data must be an object');
    for (const k of Object.keys(p)) if (!['schema', 'rev', 'records', 'links', 'wellbeing'].includes(k)) throw bad('private data has an unknown field');
    if (p.schema !== 1) throw bad('private data schema');
    if (rev !== undefined && p.rev !== rev) { const e = new Error('The private vault failed its revision check. It may have been altered.'); e.code = 'PRIVATE_REV'; throw e; }
    if (!Number.isInteger(p.rev) || p.rev < 0 || p.rev > 1e9) throw bad('private data revision');
    if (!isObj(p.records)) throw bad('private records');
    for (const c of Object.keys(p.records)) {
      if (!COLLECTIONS.includes(c)) throw bad('private records name an unknown collection');
      const a = p.records[c];
      if (!Array.isArray(a) || a.length > 60000 || (c === 'cycle' && a.length > 1)) throw bad('private records are malformed');
      for (const r of a) if (!isObj(r)) throw bad('private record');
    }
    if (!Array.isArray(p.links) || p.links.length > LINK_CAP) throw bad('private links');
    for (const l of p.links) {
      if (!isObj(l) || Object.keys(l).length !== 4 || !COLLECTIONS.includes(l.fromCollection)) throw bad('private link');
      const r = refsOf(l.fromCollection).find((x) => x[0] === l.field);
      if (!r || typeof l.fromId !== 'string' || !l.fromId || l.fromId.length > 100 || typeof l.toId !== 'string' || !l.toId || l.toId.length > 100) throw bad('private link');
    }
    if (!isObj(p.wellbeing) || JSON.stringify(p.wellbeing).length > WELL_MAX) throw bad('private wellbeing data');
    scanKeys(p, 0);
    if (L.wellbeing) { try { p.wellbeing = L.wellbeing.clean(p.wellbeing); } catch (e) { throw bad('private wellbeing data is not valid'); } }
    return p;
  }
  const keySets = (st) => { const o = {}; for (const c of COLLECTIONS) o[c] = new Set(listOf(st, c).map((r) => keyOf(c, r))); return o; };
  function marksOf(p) {
    const m = COLLECTIONS.filter((c) => (p.records[c] || []).length > 0);
    if (Object.keys(p.wellbeing || {}).length) m.push('wellbeing');
    return m;
  }

  // ---- merge, overlay, split ----
  // Private records join the public ones. A private record whose key collides with a public one (budget category, habit tick,
  // training cycle) is shadowed: hidden, kept untouched by the next write.
  function merge(base, p) {
    const out = Object.assign({}, base);
    delete out.priv;
    const shadow = {}, privKeys = {};
    for (const c of COLLECTIONS) {
      const pub = listOf(base, c), recs = (p.records && p.records[c]) || [];
      privKeys[c] = new Set(); shadow[c] = [];
      if (!recs.length) { if (c !== 'cycle') out[c] = pub.slice(); continue; }
      const have = new Set(pub.map((r) => keyOf(c, r))), add = [];
      for (const r of recs) {
        const k = keyOf(c, r);
        if (have.has(k)) { shadow[c].push(r); continue; }
        have.add(k); privKeys[c].add(k); add.push(r);
      }
      if (c === 'cycle') out.cycle = add.length ? add[0] : base.cycle;
      else out[c] = pub.concat(add);
    }
    return { out, shadow, privKeys };
  }
  // Re-attach references to private records. cow: copy a record before changing it (the view shares records with the base).
  function overlay(st, links, cow) {
    const idx = {}, copied = {}, ks = {};
    for (const l of links) {
      const c = l.fromCollection;
      if (!idx[c]) { idx[c] = new Map(); st[c].forEach((r, i) => idx[c].set(r.id, i)); copied[c] = new Set(); }
      const i = idx[c].get(l.fromId);
      if (i === undefined) continue;
      const tc = refsOf(c).find((x) => x[0] === l.field)[1];
      if (!ks[tc]) ks[tc] = new Set(listOf(st, tc).map((r) => keyOf(tc, r)));
      if (!ks[tc].has(l.toId)) continue;
      let r = st[c][i];
      if (cow && !copied[c].has(i)) { r = Object.assign({}, r); for (const x of refsOf(c)) if (Array.isArray(r[x[0]])) r[x[0]] = r[x[0]].slice(); st[c][i] = r; copied[c].add(i); }
      if (refsOf(c).find((x) => x[0] === l.field)[2]) { if (!Array.isArray(r[l.field])) r[l.field] = []; if (!r[l.field].includes(l.toId)) r[l.field].push(l.toId); } else r[l.field] = l.toId;
    }
  }
  function split(clean, ctx) {
    const isP = {}, pub = Object.assign({}, clean), records = {}, links = [];
    delete pub.priv;
    const inSet = (c, k) => !!(ctx.moveIn[c] && ctx.moveIn[c].has(k)), outSet = (c, k) => !!(ctx.moveOut[c] && ctx.moveOut[c].has(k));
    for (const c of COLLECTIONS) {
      isP[c] = new Set();
      for (const r of listOf(clean, c)) {
        const k = keyOf(c, r);
        let p = ctx.privKeys[c].has(k) || (!ctx.idsBefore[c].has(k) && ctx.newPrivate);
        if (inSet(c, k)) p = true;
        if (outSet(c, k)) p = false;
        if (p) isP[c].add(k);
      }
    }
    // An activity and its expense move together or not at all; a habit's ticks follow the habit.
    for (const a of listOf(clean, 'activities')) {
      if (!a.expenseId) continue;
      const ap = isP.activities.has(a.id), ep = isP.entries.has(a.expenseId);
      if (ap === ep || !listOf(clean, 'entries').some((e) => e.id === a.expenseId)) continue;
      const out = outSet('activities', a.id) || outSet('entries', a.expenseId);
      const to = !out;
      for (const [c, k] of [['activities', a.id], ['entries', a.expenseId]]) { if (to) isP[c].add(k); else isP[c].delete(k); }
    }
    for (const t of listOf(clean, 'habitLog')) if (isP.habits.has(t.habitId)) isP.habitLog.add(keyOf('habitLog', t));
    // SEC-62: a record created from or under a private record is private too, so no private text reaches the main state through a
    // derived record (a confirmed recurring item, a carried-over outcome, the next maintenance task or renewal, a person added from
    // an activity, a contact or study session logged for a private person or item). New records inherit when the caller names a
    // private source (ctx.from), when the same write changed or removed a private record, or when they reference a private record.
    if (!ctx.newPrivate) {
      const fresh = [];
      for (const c of COLLECTIONS) for (const r of listOf(clean, c)) { const k = keyOf(c, r); if (!ctx.idsBefore[c].has(k) && !isP[c].has(k)) fresh.push([c, k, r]); }
      if (fresh.length) {
        const all = (ctx.from || []).some(([c, k]) => isP[c] && isP[c].has(k)) || (ctx.privChanged && ctx.privChanged());
        let more = true;
        while (more) {
          more = false;
          for (const [c, k, r] of fresh) {
            if (isP[c].has(k)) continue;
            const hit = all || refsOf(c).some(([f, tc, isArr]) => (isArr ? Array.isArray(r[f]) && r[f].some((v) => isP[tc].has(v)) : typeof r[f] === 'string' && isP[tc].has(r[f])));
            if (hit) { isP[c].add(k); more = true; }
          }
        }
        for (const t of listOf(clean, 'habitLog')) if (isP.habits.has(t.habitId)) isP.habitLog.add(keyOf('habitLog', t));
      }
    }
    for (const c of COLLECTIONS) {
      const all = listOf(clean, c), mine = all.filter((r) => isP[c].has(keyOf(c, r))), rest = all.filter((r) => !isP[c].has(keyOf(c, r)));
      const keep = (ctx.shadow[c] || []).filter((r) => !isP[c].has(keyOf(c, r))).map(clone);
      if (c === 'cycle') { pub.cycle = rest.length ? rest[0] : null; }
      else pub[c] = rest;
      if (mine.length || keep.length) records[c] = mine.concat(keep);
    }
    for (const c of COLLECTIONS) {
      for (const r of listOf(pub, c)) {
        for (const [f, tc, isArr] of refsOf(c)) {
          if (!isArr) {
            const v = r[f];
            if (typeof v === 'string' && isP[tc].has(v)) { links.push({ fromCollection: c, fromId: r.id, field: f, toId: v }); delete r[f]; }
          } else if (Array.isArray(r[f])) {
            const keepIds = [];
            for (const v of r[f]) { if (isP[tc].has(v)) links.push({ fromCollection: c, fromId: r.id, field: f, toId: v }); else keepIds.push(v); }
            r[f] = keepIds;
          }
        }
      }
    }
    return { pub, records, links };
  }

  // ---- open / close / timer ----
  const isOpen = () => !!(key && inner);
  const pserial = (fn) => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };
  function scrub(p) {
    if (!p) return;
    try {
      for (const c of Object.keys(p.records || {})) { for (const r of p.records[c]) for (const k of Object.keys(r)) delete r[k]; p.records[c].length = 0; delete p.records[c]; }
      if (Array.isArray(p.links)) p.links.length = 0;
      if (p.wellbeing) for (const k of Object.keys(p.wellbeing)) delete p.wellbeing[k];
    } catch (e) { /* ignore */ }
  }
  // Empty working copies (merged views) after a write, so a pending continuation holds no private text.
  function scrubState(w) {
    if (!w) return;
    try { for (const c of COLLECTIONS) { const a = listOf(w, c); for (const r of a) if (r && typeof r === 'object') for (const x of Object.keys(r)) delete r[x]; } for (const f of Object.keys(w)) delete w[f]; } catch (e) { /* ignore */ }
  }
  function scrubWb(w) { if (w && typeof w === 'object') for (const x of Object.keys(w)) delete w[x]; }
  function auditQuiet(action) {
    try {
      if (!S().isUnlocked()) return;
      S().commit((x) => {
        if (!Array.isArray(x.audit)) x.audit = [];
        x.audit.push({ ts: new Date().toISOString(), action });
        while (x.audit.length > 200) x.audit.shift();
      }, { quiet: true }).catch(() => {});
    } catch (e) { /* ignore */ }
  }
  // why: undefined = the user or the timer (audited); 'system' = lock, wipe, passphrase change, sync replace, AI call (the caller audits).
  function close(why) {
    gen++; // an open or set-up still in flight when any close trigger fires must not leave the vault open (SEC-63)
    clearTimeout(timer); timer = null; deadline = 0;
    const was = isOpen();
    const p = inner;
    key = null; saltB64 = ''; inner = null;
    scrub(p);
    if (!was) return false;
    if (why === undefined) auditQuiet('private vault closed');
    for (const f of closers.slice()) { try { f(why); } catch (e) { /* ignore */ } }
    return true;
  }
  function secs() {
    try { const v = S().getState().settings.privAutoLockSec; return Number.isInteger(v) && v >= 15 && v <= 1800 ? v : DEFAULT_SEC; } catch (e) { return DEFAULT_SEC; }
  }
  function touch() {
    if (!isOpen()) return;
    const ms = secs() * 1000;
    deadline = Date.now() + ms;
    clearTimeout(timer);
    timer = setTimeout(() => { close(); }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function checkExpiry() { if (isOpen() && deadline && Date.now() >= deadline) { close(); return true; } return false; }
  const hidden = () => typeof document !== 'undefined' && !!document.hidden;
  function hook() {
    if (hooked || typeof document === 'undefined' || !document.addEventListener) return;
    hooked = true;
    document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
  }
  const onClose = (f) => { if (typeof f === 'function') closers.push(f); };

  async function sealPlain(p, k, salt) {
    const { iv, ct } = await V().encrypt(k, p);
    if (ct.length > CT_MAX) throw new Error('The private vault would be too large. Move some items out or delete old ones.');
    return { v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: ITER, salt }, iv, ct, rev: p.rev, marks: marksOf(p) };
  }
  const bkey = async (pass, blob) => {
    const salt = Uint8Array.from(atob(blob.kdf.salt), (ch) => ch.charCodeAt(0));
    return V().deriveKey(pass, salt);
  };
  async function decryptBlob(blob, pass) {
    const k = await bkey(pass, blob);
    let p;
    try { p = await V().decrypt(k, blob); } catch (e) { throw new Error('BAD_PRIVATE_PASSPHRASE'); }
    checkInner(p, blob.rev);
    return { k, p };
  }
  // True when `pass` opens the private blob (used to keep the main passphrase different without ever storing either).
  async function matches(blob, pass) {
    try { const k = await bkey(pass, blob); await V().decrypt(k, blob); return true; } catch (e) { return false; }
  }
  const needBase = () => { const st = S().getState(); return st; };
  const isSetUp = (st) => !!(st && st.priv);
  const marks = (st) => (st && st.priv ? st.priv.marks.slice() : []);

  async function setUp(pass) {
    return pserial(async () => {
      const st = needBase(), g0 = gen;
      if (st.priv) throw new Error('The private vault is already set up.');
      V().checkPassphrase(pass);
      if (await S().matchesMain(pass)) throw new Error('The private passphrase must be different from your main passphrase.');
      const salt = V().newSalt();
      const k = await V().deriveKey(pass, salt);
      let sb = '';
      for (const b of salt) sb += String.fromCharCode(b);
      sb = btoa(sb);
      const p = emptyInner(0), blob = await sealPlain(p, k, sb);
      await S().commit((x) => {
        if (x.priv) throw new Error('The private vault is already set up.');
        x.priv = blob;
        if (!Array.isArray(x.audit)) x.audit = [];
        x.audit.push({ ts: new Date().toISOString(), action: 'private vault set up' });
        while (x.audit.length > 200) x.audit.shift();
      });
      // A close trigger (tab hidden, app lock, AI call) during set-up leaves the new vault closed.
      if (gen !== g0 || hidden()) { close('system'); return; }
      close('system'); key = k; saltB64 = sb; inner = p; hook(); touch(); markRecs(p);
    });
  }
  function markRecs(p) { for (const c of Object.keys(p.records)) for (const r of p.records[c]) privRecs.add(r); }
  async function open(pass) {
    return pserial(async () => {
      const st = needBase();
      if (!st.priv) throw new Error('No private vault is set up.');
      if (isOpen()) return true;
      const g0 = gen;
      const { k, p } = await decryptBlob(st.priv, pass);
      if (!S().isUnlocked() || S().getState() !== st) { scrub(p); throw new Error('LOCKED'); }
      // A close trigger fired while the key was being derived (tab hidden, app lock, AI call, Close): stay closed.
      if (gen !== g0 || hidden()) { scrub(p); throw new Error('The private vault closed while it was opening. Open it again.'); }
      const m = merge(st, p);
      try { const w = clone(m.out); overlay(w, p.links, false); S().validateState(w, PRIVATE_OK); } catch (e) { scrub(p); const x = bad('The private vault data is not valid: ' + String(e.message || '').slice(0, 120)); throw x; }
      key = k; saltB64 = st.priv.kdf.salt; inner = p; hook(); touch(); markRecs(p);
      auditQuiet('private vault opened');
      return true;
    });
  }
  async function changePassphrase(oldP, newP) {
    return pserial(async () => {
      const st = needBase();
      if (!st.priv) throw new Error('No private vault is set up.');
      const { p } = await decryptBlob(st.priv, oldP);
      V().checkPassphrase(newP);
      if (await S().matchesMain(newP)) throw new Error('The private passphrase must be different from your main passphrase.');
      const salt = V().newSalt(), k = await V().deriveKey(newP, salt);
      let sb = '';
      for (const b of salt) sb += String.fromCharCode(b);
      sb = btoa(sb);
      const next = clone(p); next.rev = p.rev + 1;
      const blob = await sealPlain(next, k, sb);
      close('system');
      await S().commit((x) => {
        x.priv = blob;
        if (!Array.isArray(x.audit)) x.audit = [];
        x.audit.push({ ts: new Date().toISOString(), action: 'private vault passphrase changed' });
        while (x.audit.length > 200) x.audit.shift();
      });
      scrub(next); scrub(p);
    });
  }
  async function destroy() {
    return pserial(async () => {
      needBase();
      close('system');
      await S().commit((x) => {
        delete x.priv;
        if (!Array.isArray(x.audit)) x.audit = [];
        x.audit.push({ ts: new Date().toISOString(), action: 'private vault destroyed' });
        while (x.audit.length > 200) x.audit.shift();
      });
    });
  }

  // ---- views ----
  function view(st) {
    if (!isOpen() || !st || !st.priv || viewBase.has(st)) return st;
    const m = merge(st, inner);
    overlay(m.out, inner.links, true);
    viewBase.set(m.out, st);
    return m.out;
  }
  const isView = (s) => viewBase.has(s);
  const mainOnly = (s) => (viewBase.has(s) ? viewBase.get(s) : s);
  const isPrivateRecord = (r) => privRecs.has(r);

  // ---- the single write path ----
  // fn mutates a state-shaped working copy (public and private records together, overlays applied). Afterwards every record is
  // routed to the main state or the inner plaintext by where it lives, in one write. Closed: plain store.commit.
  // o: { newPrivate, moveIn:{c:Set}, moveOut:{c:Set}, audit }
  // SEC-65: wellbeing values live only in the private vault. No write may add a wellbeing entry to the main state (earlier thin
  // mood entries already there stay until they are moved in).
  const isWbEntry = (e) => !!e && e.domain === 'wellbeing';
  function noWellbeing(fn) {
    return async (st, wb) => {
      const had = new Set((Array.isArray(st.entries) ? st.entries : []).filter(isWbEntry).map((e) => e.id));
      if (fn) await fn(st, wb);
      if ((Array.isArray(st.entries) ? st.entries : []).some((e) => isWbEntry(e) && !had.has(e.id))) throw new Error('Wellbeing is kept only in the private vault. Use the Wellbeing check-in.');
    };
  }
  function write(fn, o) {
    o = o || {};
    fn = noWellbeing(fn);
    if (!isOpen()) {
      if (o.newPrivate || o.moveIn || o.moveOut) return Promise.reject(new Error('The private vault is closed.'));
      return S().commit(fn);
    }
    return pserial(() => writeRaw(fn, o));
  }
  function writeRaw(fn, o) {
    return (async () => {
      if (!isOpen()) throw new Error('The private vault is closed.');
      const k = key, before = inner, sb = saltB64;
      let next = null, next_wb = null, work = null, wb = null;
      try {
      await S().commit(async (st) => {
        if (!st.priv || st.priv.rev !== before.rev) throw new Error('The private vault changed. Close it and open it again.');
        const m = merge(st, before);
        work = clone(m.out);
        overlay(work, before.links, false);
        const idsBefore = keySets(work);
        wb = clone(before.wellbeing);
        if (fn) await fn(work, wb);
        // Did this write change or remove a private record? (Only asked when it also created records; see split.)
        const privChanged = () => COLLECTIONS.some((c) => {
          if (!m.privKeys[c].size) return false;
          const now = new Map(listOf(work, c).map((r) => [keyOf(c, r), r]));
          for (const r of (before.records[c] || [])) { const kk = keyOf(c, r); if (!m.privKeys[c].has(kk)) continue; const w = now.get(kk); if (!w || JSON.stringify(w) !== JSON.stringify(r)) return true; }
          return false;
        });
        if (L.wellbeing) { try { next_wb = L.wellbeing.clean(wb); } catch (e) { throw bad('private wellbeing data is not valid'); } } else next_wb = wb;
        if (o.audit) { if (!Array.isArray(work.audit)) work.audit = []; work.audit.push({ ts: new Date().toISOString(), action: o.audit }); while (work.audit.length > 200) work.audit.shift(); }
        delete work.priv;
        const clean = S().validateState(work, PRIVATE_OK);
        const sp = split(clean, { privKeys: m.privKeys, shadow: m.shadow, idsBefore, moveIn: o.moveIn || {}, moveOut: o.moveOut || {}, newPrivate: !!o.newPrivate, from: Array.isArray(o.from) ? o.from : [], privChanged });
        next = { schema: 1, rev: before.rev + 1, records: sp.records, links: sp.links, wellbeing: next_wb };
        if (key !== k) throw new Error('The private vault is closed.');
        const blob = await sealPlain(next, k, sb);
        if (key !== k) throw new Error('The private vault is closed.');
        for (const f of Object.keys(st)) delete st[f];
        Object.assign(st, sp.pub, { priv: blob });
      });
      } catch (e) { scrub(next); scrubState(work); scrubWb(wb); throw e; }
      // Success: drop the working copy's references only (its records were copied by validateState, never shared, but the stored state must never be touched here).
      if (work) for (const f of Object.keys(work)) delete work[f];
      scrubWb(wb);
      // SEC-64: the vault closed while the write was being stored. The write is saved (encrypted); only the plaintext is dropped.
      if (key !== k) { scrub(next); return; }
      inner = next; scrub(before); markRecs(next); touch();
    })();
  }
  // Part B and other inner-only changes: fn mutates a copy of the inner plaintext (records, links and wellbeing); one write.
  function commit(fn) {
    if (!isOpen()) return Promise.reject(new Error('The private vault is closed.'));
    return pserial(async () => {
      if (!isOpen()) throw new Error('The private vault is closed.');
      const k = key, before = inner, sb = saltB64;
      const next = clone(before);
      let w = null;
      try {
        await fn(next);
        if (key !== k) throw new Error('The private vault is closed.');
        next.rev = before.rev + 1;
        checkInner(next, next.rev);
        await S().commit(async (st) => {
          if (!st.priv || st.priv.rev !== before.rev) throw new Error('The private vault changed. Close it and open it again.');
          const m = merge(st, next); w = clone(m.out); overlay(w, next.links, false);
          S().validateState(w, PRIVATE_OK);
          if (key !== k) throw new Error('The private vault is closed.');
          const blob = await sealPlain(next, k, sb);
          if (key !== k) throw new Error('The private vault is closed.');
          st.priv = blob;
        });
      } catch (e) { scrub(next); scrubState(w); throw e; }
      scrubState(w);
      // SEC-64: closed while the write was being stored: it is saved (encrypted); only the plaintext is dropped.
      if (key !== k) { scrub(next); return; }
      inner = next; scrub(before); markRecs(next); touch();
    });
  }
  const getWellbeing = () => { if (!isOpen()) throw new Error('The private vault is closed.'); return clone(inner.wellbeing); };

  // ---- moving ----
  const CHILDREN = {
    people: [['contacts', 'personId']],
    learningItems: [['studySessions', 'itemId'], ['takeaways', 'itemId']],
    projects: [['entries', 'projectId']],
    accounts: [['entries', 'accountId']],
    properties: [['maintenance', 'propertyId']],
    vehicles: [['maintenance', 'vehicleId']],
    groups: [['people', 'groupId']],
  };
  // Everything that has to move with (c, id): its pair (activity and expense), a habit's ticks, and with `children` its children.
  function closure(st, c, id, children) {
    if (!COLLECTIONS.includes(c)) throw new Error('Unknown collection');
    // SEC-68: indexes built once per call, so a parent with tens of thousands of children is linear, not quadratic.
    const byKey = {}, byRef = {};
    const rec = (cc, k) => { if (!byKey[cc]) byKey[cc] = new Map(listOf(st, cc).map((r) => [keyOf(cc, r), r])); return byKey[cc].get(k); };
    const refs = (cc, f, v) => {
      const t = cc + '\u0000' + f;
      if (!byRef[t]) { const m = new Map(); for (const r of listOf(st, cc)) { const x = r[f]; if (typeof x === 'string') { if (!m.has(x)) m.set(x, []); m.get(x).push(r); } } byRef[t] = m; }
      return byRef[t].get(v) || [];
    };
    const seen = new Set(), out = [], q = [[c, id]];
    for (let qi = 0; qi < q.length; qi++) {
      const [cc, k] = q[qi], tag = cc + '\u0000' + k;
      if (seen.has(tag)) continue;
      const r0 = rec(cc, k);
      if (!r0) { if (cc === c && k === id) throw new Error('That item no longer exists.'); continue; }
      seen.add(tag); out.push([cc, k]);
      if (cc === 'activities' && r0.expenseId) q.push(['entries', r0.expenseId]);
      if (cc === 'entries') for (const a of refs('activities', 'expenseId', k)) q.push(['activities', a.id]);
      if (cc === 'habits') for (const t of refs('habitLog', 'habitId', k)) q.push(['habitLog', keyOf('habitLog', t)]);
      if (children) for (const [ch, f] of CHILDREN[cc] || []) for (const r of refs(ch, f, k)) if (ch !== 'entries' || (cc === 'accounts' ? r.type === 'balance' : r.type === 'outcome')) q.push([ch, keyOf(ch, r)]);
    }
    return out;
  }
  function childrenOf(st, c, id) {
    const all = closure(st, c, id, true), base = new Set(closure(st, c, id, false).map((x) => x[0] + '\u0000' + x[1]));
    return all.filter((x) => !base.has(x[0] + '\u0000' + x[1])).map((x) => ({ collection: x[0], id: x[1] }));
  }
  const toSets = (list) => { const o = {}; for (const [c, k] of list) (o[c] = o[c] || new Set()).add(k); return o; };
  async function move(dir, c, id, opts) {
    if (!isOpen()) throw new Error('Open the private vault first.');
    const st = view(S().getState()), want = dir === 'in';
    const base = S().getState(), pk = {}, bk = {};
    const inPriv = (cc, k) => { if (!pk[cc]) pk[cc] = new Set((inner.records[cc] || []).map((r) => keyOf(cc, r))); return pk[cc].has(k); };
    const inBase = (cc, k) => { if (!bk[cc]) bk[cc] = new Set(listOf(base, cc).map((r) => keyOf(cc, r))); return bk[cc].has(k); };
    const list = closure(st, c, id, !!(opts && opts.children)).filter(([cc, k]) => {
      const priv = inPriv(cc, k) && !inBase(cc, k);
      return want ? !priv : priv;
    });
    if (!list.length) return 0;
    for (const [cc, k] of list) {
      if (want && inPriv(cc, k)) throw new Error('A private item with the same name already exists.');
      if (want && cc === 'cycle' && inner.records.cycle && inner.records.cycle.length) throw new Error('A training cycle is already in the private vault.');
      if (!want && cc === 'cycle' && S().getState().cycle) throw new Error('A training cycle already exists outside the private vault.');
    }
    await writeRaw(null, { [want ? 'moveIn' : 'moveOut']: toSets(list), audit: want ? 'private vault moved in' : 'private vault moved out' });
    return list.length;
  }
  function isPrivateKey(c, k) {
    if (!isOpen()) return false;
    const base = S().getState();
    return (inner.records[c] || []).some((r) => keyOf(c, r) === k) && !listOf(base, c).some((r) => keyOf(c, r) === k);
  }
  const moveIn = (c, id, opts) => pserial(() => move('in', c, id, opts));
  const moveOut = (c, id, opts) => pserial(() => move('out', c, id, opts));
  // Which collection keys are private right now (open only): for UI badges and routing checks.
  function isPrivate(c, id) { return isPrivateKey(c, id); }

  L.priv = {
    COLLECTIONS, MARK_NAMES, isSetUp, setUp, open, close, isOpen, view, commit, write, moveIn, moveOut, childrenOf, changePassphrase, destroy, marks,
    touch, checkExpiry, onClose, isView, mainOnly, isPrivateRecord, isPrivate, cleanBlob, matches, getWellbeing, secsLeft: () => (isOpen() ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0),
  };
})();
