(function () {
  'use strict';
  // v1.3.0 "Safe to live in": storage status, backup dates and reminders, backup verification, and local diagnostics.
  // Everything stored lives in state.ops (inside the encrypted state). Diagnostics are fixed code constants only: no message text,
  // no stack, no values, no ids, no names. Nothing here writes by itself except through the store's own commit.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const RING = 200, SAVES_LIMIT = 200, MAX_N = 1e9;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const fail = (m) => { throw new Error('Invalid data: ' + m); };

  // ---- fixed vocabulary ----
  const AREAS = Object.freeze(['app', 'lock', 'dashboard', 'money', 'assets', 'work', 'health', 'goals', 'home', 'admin', 'learning', 'activities', 'social', 'wellbeing', 'business', 'review', 'memory', 'settings', 'private', 'archive', 'sync', 'backup', 'storage', 'csv', 'ai']);
  const BASE_CODES = ['UNKNOWN_ERROR', 'RENDER_ERROR', 'DECRYPT_FAIL', 'PRIV_DECRYPT_FAIL', 'STORAGE_QUOTA', 'STORAGE_PERSIST_ERROR', 'STORAGE_ESTIMATE_ERROR', 'BACKUP_EXPORT_FAIL',
    'SYNC_409', 'SYNC_RECONNECT', 'SYNC_CHANGED', 'SYNC_HTTP', 'SYNC_TOO_LARGE', 'SYNC_ROLLBACK', 'SYNC_TAMPER', 'SYNC_INVALID', 'SYNC_OLDER_FORMAT', 'SYNC_LOCAL_CHANGED', 'SYNC_FAIL',
    'CSV_REJECT', 'AI_TIMEOUT', 'AI_NETWORK', 'AI_HTTP', 'AI_BAD_REPLY', 'AI_FAIL', 'ARCHIVE_FAIL'];
  const CODES = Object.freeze(BASE_CODES.concat(AREAS.map((a) => 'UNCAUGHT_' + a.toUpperCase()), AREAS.map((a) => 'REJECTION_' + a.toUpperCase())));
  const CODE_SET = new Set(CODES), AREA_SET = new Set(AREAS);
  // Library errors carry a fixed `code`; only these exact keys map to a diagnostic code. Anything else maps to nothing.
  const ERR_CODE = Object.freeze({
    ROLLBACK: 'SYNC_ROLLBACK', TAMPER: 'SYNC_TAMPER', REMOTE_INVALID: 'SYNC_INVALID', REMOTE_CHANGED: 'SYNC_CHANGED', RECONNECT: 'SYNC_RECONNECT', HTTP: 'SYNC_HTTP',
    TOO_LARGE: 'SYNC_TOO_LARGE', OLDER_FORMAT: 'SYNC_OLDER_FORMAT', LOCAL_CHANGED: 'SYNC_LOCAL_CHANGED', WRONG_PASSPHRASE: 'DECRYPT_FAIL',
    AI_TIMEOUT: 'AI_TIMEOUT', AI_NETWORK: 'AI_NETWORK', AI_HTTP: 'AI_HTTP', AI_BAD_REPLY: 'AI_BAD_REPLY',
    ARCHIVE: 'ARCHIVE_FAIL', CSV: 'CSV_REJECT' // SEC-95: archive and CSV failures carry these fixed keys
  });
  const PERSIST = Object.freeze(['unknown', 'granted', 'denied', 'unavailable', 'error']);

  // ---- stored shape ----
  const dateOk = (s) => { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(s + 'T00:00:00Z'); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
  const atOk = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(s);
  const defaultOps = () => ({ lastBackupAt: '', backupRev: 0, lastSyncAt: '', safeRev: 0, snoozeUntil: '', persist: { result: 'unknown', at: '' }, diag: [] });
  function intIn(v, lo, hi, what) { if (!Number.isInteger(v) || v < lo || v > hi) fail(what); return v; }
  function optDate(v, what) { if (v === undefined || v === '') return ''; if (!dateOk(v)) fail(what); return v; }
  function cleanDiag(list) {
    if (list === undefined) return [];
    if (!Array.isArray(list)) fail('diagnostics must be a list');
    const out = [];
    for (const d of list) {
      if (!isObj(d) || !atOk(d.at) || typeof d.code !== 'string' || typeof d.area !== 'string') fail('diagnostic entry');
      if (CODE_SET.has(d.code) && AREA_SET.has(d.area)) out.push({ at: d.at, code: d.code, area: d.area });
    }
    return out.slice(-RING);
  }
  function cleanOps(o, schema) {
    if (schema < 15 || o === undefined || o === null) return defaultOps();
    if (!isObj(o)) fail('ops');
    const p = o.persist === undefined ? { result: 'unknown', at: '' } : o.persist;
    if (!isObj(p) || !PERSIST.includes(p.result)) fail('persist result');
    return {
      lastBackupAt: optDate(o.lastBackupAt, 'lastBackupAt'),
      backupRev: o.backupRev === undefined ? 0 : intIn(o.backupRev, 0, MAX_N, 'backupRev'),
      lastSyncAt: optDate(o.lastSyncAt, 'lastSyncAt'),
      safeRev: o.safeRev === undefined ? 0 : intIn(o.safeRev, 0, MAX_N, 'safeRev'),
      snoozeUntil: optDate(o.snoozeUntil, 'snoozeUntil'),
      persist: { result: p.result, at: optDate(p.at, 'persist date') },
      diag: cleanDiag(o.diag)
    };
  }
  function cleanSettings(s, schema) {
    const out = { backupReminderDays: 7, syncReminder: false };
    if (schema < 15) return out;
    if (s && s.backupReminderDays !== undefined) out.backupReminderDays = intIn(s.backupReminderDays, 1, 60, 'backupReminderDays');
    if (s && s.syncReminder !== undefined) { if (typeof s.syncReminder !== 'boolean') fail('syncReminder'); out.syncReminder = s.syncReminder; }
    return out;
  }

  // ---- diagnostics ring ----
  let pending = [], area = 'app', timer = null;
  const nowAt = () => new Date().toISOString();
  function entry(code, a) { return { at: nowAt(), code: CODE_SET.has(code) ? code : 'UNKNOWN_ERROR', area: AREA_SET.has(a) ? a : 'app' }; }
  function setArea(a) { area = AREA_SET.has(a) ? a : 'app'; }
  const getArea = () => area;
  function push(ops, e) { ops.diag.push(e); while (ops.diag.length > RING) ops.diag.shift(); }
  // Queue a code. It reaches the encrypted state on the next save (or the short write scheduled here); it is never written in the clear.
  function record(code, a) {
    pending.push(entry(code, a === undefined ? area : a));
    while (pending.length > RING) pending.shift();
    schedule();
  }
  function schedule() {
    if (timer || !L.store || !L.store.isUnlocked() || typeof setTimeout !== 'function') return;
    timer = setTimeout(() => {
      timer = null;
      if (!pending.length || !L.store.isUnlocked()) return;
      L.store.commit(() => {}, { quiet: true }).catch(() => {}); // a failing write must not record again (no loop)
    }, 1500);
  }
  // Called by the store inside a save: moves queued entries into state.ops.diag and returns them (so a failed save can requeue them).
  function flush(state) {
    if (!pending.length || !state || !isObj(state.ops) || !Array.isArray(state.ops.diag)) return [];
    const taken = pending.splice(0);
    for (const e of taken) push(state.ops, e);
    return taken;
  }
  function requeue(taken) { pending = taken.concat(pending).slice(-RING); }
  // Handled library errors: only an exact fixed `code` key or the two fixed passphrase messages map; message text is never kept.
  function codeFor(e) {
    try {
      if (!e || (typeof e !== 'object' && typeof e !== 'function')) return null;
      if (e.name === 'QuotaExceededError') return 'STORAGE_QUOTA';
      const c = e.code;
      if (typeof c === 'string' && Object.prototype.hasOwnProperty.call(ERR_CODE, c)) return ERR_CODE[c];
      const m = e.message;
      if (m === 'BAD_PASSPHRASE_OR_DATA') return 'DECRYPT_FAIL';
      if (m === 'BAD_PRIVATE_PASSPHRASE') return 'PRIV_DECRYPT_FAIL';
    } catch (x) { /* a hostile error object */ }
    return null;
  }
  function recordError(e, a) { const c = codeFor(e); if (c) record(c, a); return c; }
  // Uncaught errors and unhandled rejections: a code by area and kind, nothing read from the error at all.
  function uncaught(kind, a) { const ar = AREA_SET.has(a) ? a : area; record((kind === 'rejection' ? 'REJECTION_' : 'UNCAUGHT_') + ar.toUpperCase(), ar); }
  function install(win) {
    if (!win || typeof win.addEventListener !== 'function') return;
    win.addEventListener('error', () => uncaught('error'));
    win.addEventListener('unhandledrejection', () => uncaught('rejection'));
  }
  function browserFamily(ua) {
    const u = typeof ua === 'string' ? ua : '';
    if (/\bEdg(e|A|iOS)?\//.test(u)) return 'Edge';
    if (/\bFirefox\/|\bFxiOS\//.test(u)) return 'Firefox';
    if (/(Chrome|Chromium|CriOS)\//.test(u)) return 'Chrome';
    if (/\bSafari\//.test(u)) return 'Safari';
    return 'Other';
  }
  // The copied text: codes (with area and date), app version, schema and browser family. Nothing read from entries or settings.
  function format(state, info) {
    const i = info || {};
    const ring = (state && state.ops && Array.isArray(state.ops.diag) ? state.ops.diag : []).concat(pending).filter((d) => CODE_SET.has(d.code) && AREA_SET.has(d.area) && atOk(d.at));
    const lines = ['LifeOS diagnostics', 'Version: ' + (/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(i.version)) ? String(i.version) : 'unknown'), 'Schema: ' + (Number.isInteger(state && state.schema) ? state.schema : 0), 'Browser: ' + browserFamily(i.userAgent), 'Codes: ' + ring.length];
    for (const d of ring.slice(-RING)) lines.push(d.at.slice(0, 10) + ' ' + d.code + ' ' + d.area);
    return lines.join('\n');
  }
  function clear(state) { pending = []; if (state && isObj(state.ops)) state.ops.diag = []; }
  const _pending = () => pending.slice();
  const _reset = () => { pending = []; area = 'app'; if (timer) { clearTimeout(timer); timer = null; } };

  // ---- B1 persistent storage ----
  // Returns 'granted', 'denied', 'unavailable' or 'error'. Never throws and never blocks when the API is missing or rejects.
  async function requestPersist(storage) {
    try {
      if (!storage || typeof storage.persist !== 'function') return 'unavailable';
      try { if (typeof storage.persisted === 'function' && (await storage.persisted()) === true) return 'granted'; } catch (e) { /* ask anyway */ }
      return (await storage.persist()) === true ? 'granted' : 'denied';
    } catch (e) { return 'error'; }
  }
  // Called after each unlock: asks until granted, and records the result (a write only when it changed).
  async function persistOnUnlock(storage, today) {
    const st = L.store.getState();
    if (st.ops.persist.result === 'granted' && storage && typeof storage.persisted === 'function') {
      try { if ((await storage.persisted()) === true) return 'granted'; } catch (e) { /* fall through and ask */ }
    }
    const r = await requestPersist(storage);
    if (r === 'error') record('STORAGE_PERSIST_ERROR', 'storage');
    if (L.store.isUnlocked() && L.store.getState().ops.persist.result !== r) {
      await L.store.commit((x) => { x.ops.persist = { result: r, at: today }; }, { quiet: true }).catch(() => {});
    }
    return r;
  }
  // { usage, quota } in bytes, or null when the API is missing or rejects.
  async function estimate(storage) {
    try {
      if (!storage || typeof storage.estimate !== 'function') return null;
      const e = await storage.estimate();
      if (!isObj(e) || typeof e.usage !== 'number') return null;
      const usage = e.usage, quota = Number(e.quota);
      if (!isFinite(usage) || usage < 0) return null;
      return { usage, quota: isFinite(quota) && quota > 0 ? quota : null };
    } catch (e) { record('STORAGE_ESTIMATE_ERROR', 'storage'); return null; }
  }
  function bytesText(n) {
    if (!(n >= 0)) return 'unknown';
    const u = ['bytes', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + u[i];
  }
  const storageText = (persisted) => (persisted === true ? 'Storage: kept by the browser' : 'Storage: may be cleared by the browser');

  // ---- B2 backup dates and reminder ----
  const dayNum = (iso) => { const p = iso.split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]) / 86400000; };
  const addDays = (iso, n) => new Date((dayNum(iso) + n) * 86400000).toISOString().slice(0, 10);
  const daysBetween = (a, b) => dayNum(b) - dayNum(a);
  const lastSafe = (ops) => (ops.lastBackupAt > ops.lastSyncAt ? ops.lastBackupAt : ops.lastSyncAt);
  // Saves since the last backup or sync are counted from the vault revision (every counted save raises it by one), so no counter is stored.
  const savesSince = (state, rev) => Math.max(0, (Number.isInteger(rev) ? rev : 0) - state.ops.safeRev);
  // { due, why, days, saves }: why is 'never', 'days' or 'saves'. Snoozed means not due until the snooze date.
  function reminder(state, today, rev) {
    const ops = state.ops, n = state.settings.backupReminderDays, last = lastSafe(ops), saves = savesSince(state, rev);
    const days = last ? Math.max(0, dayNum(today) - dayNum(last)) : null;
    let why = null;
    if (saves > SAVES_LIMIT) why = 'saves';
    else if (last ? days >= n : saves >= 1) why = last ? 'days' : 'never';
    const snoozed = !!ops.snoozeUntil && today < ops.snoozeUntil;
    return { due: !!why && !snoozed, why, days, saves, snoozed };
  }
  const snooze = (state, today) => { state.ops.snoozeUntil = addDays(today, 1); };
  const revOf = (rev) => (Number.isInteger(rev) && rev >= 0 ? rev : 0);
  function markBackup(state, today, rev) { Object.assign(state.ops, { lastBackupAt: today, backupRev: revOf(rev), safeRev: revOf(rev), snoozeUntil: '' }); }
  function markSync(state, today, rev) { Object.assign(state.ops, { lastSyncAt: today, safeRev: revOf(rev), snoozeUntil: '' }); }
  const COUNT_KEYS = [['entries', 'Entries'], ['accounts', 'Accounts'], ['recurring', 'Recurring items'], ['budgets', 'Budgets'], ['projects', 'Projects'], ['pipeline', 'Pipeline items'], ['goals', 'Goals'],
    ['properties', 'Properties'], ['vehicles', 'Vehicles'], ['maintenance', 'Maintenance items'], ['renewals', 'Renewals'], ['documents', 'Documents'], ['taxItems', 'Tax items'],
    ['learningItems', 'Learning items'], ['studySessions', 'Study sessions'], ['takeaways', 'Takeaways'], ['activities', 'Activities'], ['groups', 'Groups'], ['people', 'People'], ['contacts', 'Contacts'],
    ['payees', 'Payees'], ['invoices', 'Invoices'], ['trips', 'Mileage trips'], ['taxPayments', 'Tax payments'], ['habits', 'Daily checks'], ['habitLog', 'Daily check log'], ['archives', 'Archived years']];
  const n = (a) => (Array.isArray(a) ? a.length : 0);

  // ---- verify a backup file: decrypt in memory, compare with the live vault, discard. Writes nothing anywhere. ----
  // Returns { ok:true, schema, sourceSchema, rev, madeOn, priv, rows } or { ok:false, reason, message, schema? }.
  async function verifyBackup(passphrase, text, live) {
    const bad = (reason, message, extra) => Object.assign({ ok: false, reason, message }, extra || {});
    if (typeof text !== 'string' || !text || text.length > L.vault.MAX_BACKUP) return bad('NOT_BACKUP', 'That is not a LifeOS backup file.');
    let env;
    try { env = JSON.parse(text); L.vault.parseEnvelope(env); } catch (e) { return bad('NOT_BACKUP', 'That is not a LifeOS backup file.'); }
    if (typeof passphrase !== 'string' || !passphrase) return bad('NO_PASSPHRASE', 'Enter the backup passphrase.');
    let raw;
    try { raw = await L.vault.readBackupRaw(passphrase, text); }
    catch (e) { return bad('BAD_PASSPHRASE_OR_DATA', 'That passphrase did not work, or the file was changed or damaged.'); }
    const sch = isObj(raw) ? raw.schema : undefined, mine = live && Number.isInteger(live.schema) ? live.schema : L.store.SCHEMA;
    if (Number.isInteger(sch) && sch > mine) return bad('NEWER_SCHEMA', 'This backup was made by a newer version of LifeOS (schema ' + sch + '). This version reads up to schema ' + mine + '. Nothing was read further.', { schema: sch });
    let state;
    try { state = L.store.validateState(raw); } catch (e) { return bad('INVALID', 'The file decrypted but its contents did not pass the checks, so it is not a usable backup.'); }
    const rows = COUNT_KEYS.map(([k, label]) => ({ key: k, label, backup: n(state[k]), live: live ? n(live[k]) : null })).filter((r) => r.backup > 0 || r.live > 0);
    const meta = isObj(raw) && isObj(raw._meta) ? raw._meta : null;
    const rev = state.ops && state.ops.backupRev > 0 ? state.ops.backupRev : (meta && Number.isInteger(meta.rev) ? meta.rev : null);
    const madeOn = state.ops && state.ops.lastBackupAt ? state.ops.lastBackupAt : null;
    return { ok: true, schema: state.schema, sourceSchema: sch, rev, madeOn, priv: !!state.priv, livePriv: !!(live && live.priv), rows };
  }

  L.ops = { RING, SAVES_LIMIT, AREAS, CODES, PERSIST, defaultOps, cleanOps, cleanSettings, cleanDiag, setArea, getArea, record, recordError, codeFor, uncaught, install, flush, requeue, push, format, clear, browserFamily,
    requestPersist, persistOnUnlock, estimate, bytesText, storageText, reminder, savesSince, snooze, markBackup, markSync, addDays, daysBetween, verifyBackup, COUNT_KEYS, _pending, _reset };
})();
