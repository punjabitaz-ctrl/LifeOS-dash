(function () {
  'use strict';
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
  const API = 'https://www.googleapis.com';
  const FILE_NAME = 'lifeos-vault.json';
  const MAX_REMOTE = 64 * 1024 * 1024, TIMEOUT_MS = 30000;
  const NONCE_KEY = 'lifeos.oauth.state';
  const ID_RE = /^[A-Za-z0-9_-]{5,200}$/;
  let token = null, tokenExp = 0, fetchImpl = null, returned = null;

  // Errors carry a stable code and a fixed message. Nothing from a response, URL or header is ever copied in.
  // Only errors made here (tracked in OWN) pass through api() with their message; any other error is replaced.
  const OWN = new WeakSet();
  function err(code, message) { const e = new Error(message); e.code = code; OWN.add(e); return e; }
  const getFetch = () => {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!f) throw err('NO_FETCH', 'This browser cannot reach Google Drive.');
    return f;
  };
  function _setFetch(f) { fetchImpl = typeof f === 'function' ? f : null; }
  function _setToken(t, ttlSec) { token = t || null; tokenExp = t ? Date.now() + (ttlSec || 3600) * 1000 : 0; }
  const isConnected = () => !!token && Date.now() < tokenExp;
  function disconnect() { token = null; tokenExp = 0; }
  const expiresAt = () => (isConnected() ? tokenExp : 0);

  // ---- OAuth (implicit token flow, full-page redirect) ----
  function isAvailable(loc) {
    if (!loc) return false;
    if (loc.protocol === 'https:') return true;
    // Test-only exception: a local dev server on http://localhost or http://127.0.0.1.
    return loc.protocol === 'http:' && (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1');
  }
  function validateClientId(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,150}\.apps\.googleusercontent\.com$/.test(id.trim())) {
      throw err('BAD_CLIENT_ID', 'That does not look like a Google OAuth client ID (it ends with .apps.googleusercontent.com).');
    }
    return id.trim();
  }
  function newNonce() {
    const b = L._webcrypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  function buildAuthUrl(clientId, redirectUri, nonce) {
    const u = new URL(AUTH_URL);
    u.searchParams.set('client_id', validateClientId(clientId));
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'token');
    u.searchParams.set('scope', SCOPE);
    u.searchParams.set('state', nonce);
    u.searchParams.set('include_granted_scopes', 'false');
    return u.toString();
  }
  function begin(clientId, env) {
    if (!isAvailable(env.loc)) throw err('NOT_HTTPS', 'Google Drive sync needs this page to be served over https.');
    const nonce = newNonce();
    env.storage.setItem(NONCE_KEY, nonce);
    return buildAuthUrl(clientId, env.loc.origin + env.loc.pathname, nonce);
  }
  // Returns null when the fragment is not an OAuth response. Throws a coded error when it is one but cannot be trusted.
  function parseFragment(hash, expectedNonce) {
    const raw = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
    if (!raw) return null;
    const p = new URLSearchParams(raw);
    if (!p.has('access_token') && !p.has('error')) return null;
    const st = p.get('state');
    if (!expectedNonce || !st || st.length !== expectedNonce.length) throw err('STATE', 'The Google sign-in response could not be verified. Try connecting again.');
    let diff = 0;
    for (let i = 0; i < st.length; i++) diff |= st.charCodeAt(i) ^ expectedNonce.charCodeAt(i);
    if (diff) throw err('STATE', 'The Google sign-in response could not be verified. Try connecting again.');
    if (p.has('error')) throw err('DENIED', 'Google sign-in was cancelled or refused.');
    const t = p.get('access_token') || '';
    if (!/^[A-Za-z0-9._~+/=-]{20,2048}$/.test(t) || String(p.get('token_type') || '').toLowerCase() !== 'bearer') {
      throw err('BAD_TOKEN', 'Google returned an unexpected sign-in response.');
    }
    const sc = p.get('scope');
    if (sc && sc.split(/\s+/).indexOf(SCOPE) < 0) throw err('BAD_SCOPE', 'Google did not grant the Drive app-data permission.');
    const ttl = Math.min(86400, Math.max(60, parseInt(p.get('expires_in'), 10) || 3600));
    return { token: t, expiresIn: ttl };
  }
  // Runs at load, before anything else: take the token, then strip the fragment from the address bar.
  function consumeReturn(loc, storage, hist) {
    const hash = loc && loc.hash;
    if (!hash || !/(^#|&)(access_token|error)=/.test(hash)) return;
    let nonce = null;
    try { hist.replaceState(null, '', loc.pathname + loc.search); } catch (e) { /* ignore */ }
    try { if (storage) { nonce = storage.getItem(NONCE_KEY); storage.removeItem(NONCE_KEY); } } catch (e) { /* ignore */ }
    try {
      const r = parseFragment(hash, nonce);
      if (r) { _setToken(r.token, r.expiresIn); returned = { connected: true }; }
    } catch (e) { returned = { error: e.message }; }
  }
  function takeReturn() { const r = returned; returned = null; return r; }
  if (typeof location !== 'undefined' && typeof history !== 'undefined') {
    let ss = null;
    try { ss = sessionStorage; } catch (e) { /* unavailable */ }
    // Always run, even without sessionStorage, so a token fragment is stripped (and then rejected for lack of a nonce).
    consumeReturn(location, ss, history);
  }

  // ---- Drive REST ----
  // Read the body with a hard cap, even when Content-Length is missing (chunked); abort beyond it.
  async function readCapped(res, ctl) {
    if (!res.body || typeof res.body.getReader !== 'function') {
      const t = await res.text();
      if (t.length > MAX_REMOTE) throw err('TOO_LARGE', 'The Drive copy is larger than 64 MB, so it was rejected.');
      return t;
    }
    const rd = res.body.getReader(), parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      n += value.byteLength;
      if (n > MAX_REMOTE) { try { ctl.abort(); rd.cancel(); } catch (e) { /* ignore */ } throw err('TOO_LARGE', 'The Drive copy is larger than 64 MB, so it was rejected.'); }
      parts.push(value);
    }
    const all = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.byteLength; }
    return new TextDecoder().decode(all);
  }
  async function api(url, o) {
    o = o || {};
    if (!isConnected()) { token = null; throw err('RECONNECT', 'Google sign-in has expired. Reconnect to continue.'); }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res, text = '';
    try {
      res = await getFetch()(url, {
        method: o.method || 'GET', body: o.body, signal: ctl.signal,
        headers: Object.assign({ Authorization: 'Bearer ' + token }, o.headers || {}),
        credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      const len = res.headers && res.headers.get && Number(res.headers.get('content-length'));
      if (len > MAX_REMOTE) throw err('TOO_LARGE', 'The Drive copy is larger than 64 MB, so it was rejected.');
      if (res.status !== 401 && res.status !== 412 && res.status !== 404) text = await readCapped(res, ctl);
    } catch (e) {
      if (OWN.has(e)) throw e;
      throw err(ctl.signal.aborted ? 'TIMEOUT' : 'NETWORK', ctl.signal.aborted ? 'Google Drive did not answer in time.' : 'Could not reach Google Drive.');
    } finally { clearTimeout(timer); }
    if (text.length > MAX_REMOTE) throw err('TOO_LARGE', 'The Drive copy is larger than 64 MB, so it was rejected.');
    if (res.status === 401) { token = null; tokenExp = 0; throw err('RECONNECT', 'Google sign-in has expired. Reconnect to continue.'); }
    if (res.status === 412) throw err('REMOTE_CHANGED', 'The Drive copy changed while syncing. Nothing was overwritten. Run sync again.');
    if (res.status === 404) return { status: 404, text: '', etag: '' };
    if (!res.ok) throw err('HTTP', 'Google Drive returned an error (HTTP ' + (Number(res.status) || 0) + ').');
    return { status: res.status, text, etag: (res.headers && res.headers.get && res.headers.get('etag')) || '' };
  }
  function json(text) {
    try { const v = JSON.parse(text); if (v && typeof v === 'object') return v; } catch (e) { /* fall through */ }
    throw err('REMOTE_INVALID', 'Google Drive sent an unexpected reply.');
  }
  async function findFile() {
    const q = encodeURIComponent("name='" + FILE_NAME + "' and trashed=false");
    const r = await api(API + '/drive/v3/files?spaces=appDataFolder&q=' + q + '&orderBy=modifiedTime%20desc&pageSize=10&fields=' + encodeURIComponent('files(id,size,version)'));
    const files = json(r.text).files;
    if (!Array.isArray(files) || !files.length) return null;
    const f = files[0];
    if (!f || typeof f.id !== 'string' || !ID_RE.test(f.id)) throw err('REMOTE_INVALID', 'Google Drive sent an unexpected reply.');
    const size = f.size === undefined ? 0 : Number(f.size);
    if (!isFinite(size) || size < 0) throw err('REMOTE_INVALID', 'Google Drive sent an unexpected reply.');
    if (size > MAX_REMOTE) throw err('TOO_LARGE', 'The Drive copy is larger than 64 MB, so it was rejected.');
    return { id: f.id, version: f.version === undefined ? '' : String(f.version).slice(0, 40) };
  }
  async function download(file) {
    const r = await api(API + '/drive/v3/files/' + file.id + '?alt=media');
    if (r.status === 404) throw err('REMOTE_CHANGED', 'The Drive copy changed while syncing. Nothing was overwritten. Run sync again.');
    return r;
  }
  async function upload(file, text, etag) {
    if (text.length > MAX_REMOTE) throw err('TOO_LARGE', 'The vault is larger than 64 MB and cannot be synced.');
    if (!file) {
      const b = 'lifeos' + newNonce();
      const body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] }) + '\r\n--' + b +
        '\r\nContent-Type: application/json\r\n\r\n' + text + '\r\n--' + b + '--';
      const r = await api(API + '/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body, headers: { 'Content-Type': 'multipart/related; boundary=' + b } });
      const id = json(r.text).id;
      if (typeof id !== 'string' || !ID_RE.test(id)) throw err('REMOTE_INVALID', 'Google Drive sent an unexpected reply.');
      return id;
    }
    // Re-read the file version right before writing, and also send the etag when Drive gave us one.
    const cur = await api(API + '/drive/v3/files/' + file.id + '?fields=id,version');
    if (cur.status === 404 || String(json(cur.text).version === undefined ? '' : json(cur.text).version) !== file.version) {
      throw err('REMOTE_CHANGED', 'The Drive copy changed while syncing. Nothing was overwritten. Run sync again.');
    }
    const headers = { 'Content-Type': 'application/json' };
    if (etag) headers['If-Match'] = etag;
    const r = await api(API + '/upload/drive/v3/files/' + file.id + '?uploadType=media&fields=id', { method: 'PATCH', body: text, headers });
    if (r.status === 404) throw err('REMOTE_CHANGED', 'The Drive copy changed while syncing. Nothing was overwritten. Run sync again.');
    return file.id;
  }

  // ---- change detection ----
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }
  // Fingerprint of the content that counts as "changed": everything except the audit log and sync bookkeeping.
  async function fingerprint(state) {
    const s = JSON.parse(JSON.stringify(state));
    delete s.audit;
    if (s.settings) delete s.settings.sync;
    const d = await L._webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(s)));
    return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
  }
  const count = (a) => (Array.isArray(a) ? a.length : 0);
  const summary = (meta, state, schema) => ({ rev: meta.rev, updatedAt: meta.updatedAt, entries: count(state.entries), projects: count(state.projects), pipeline: count(state.pipeline), schema });

  async function inspect(text, passphrase) {
    let envObj;
    try { envObj = JSON.parse(text); } catch (e) { throw err('REMOTE_INVALID', 'The Drive file is not a valid LifeOS vault.'); }
    try { return await L.store.inspectEnvelope(envObj, passphrase); }
    catch (e) {
      if (e && (e.code === 'NEED_PASSPHRASE' || e.code === 'WRONG_PASSPHRASE')) throw e;
      const m = String((e && e.message) || '');
      if (m.indexOf('Vault revision check') === 0) throw err('TAMPER', 'The Drive copy failed its revision check (the outer and inner revision numbers disagree). It was rejected.');
      throw err('REMOTE_INVALID', 'The Drive file is not a valid LifeOS vault.');
    }
  }

  async function bookkeeping(clientId, remoteRev, fileId, action) {
    const S = L.store;
    const fp = await fingerprint(S.getState());
    await S.commit((x) => {
      x.settings.sync = { clientId, remoteRev, fp, fileId, keySalt: S.saltId() };
      if (!Array.isArray(x.audit)) x.audit = [];
      x.audit.push({ ts: new Date().toISOString(), action });
      while (x.audit.length > 200) x.audit.shift();
    }, { quiet: true });
  }
  const hide = (o, ctx) => { Object.defineProperty(o, '_ctx', { value: ctx, enumerable: false }); return o; };

  // Compare local and Drive. Uploads when safe; otherwise returns a decision request and writes nothing.
  async function run(opts) {
    opts = opts || {};
    const S = L.store;
    const cur = S.getState();
    const sy = cur.settings.sync;
    const clientId = sy.clientId;
    const file = await findFile();
    const fp = await fingerprint(cur);
    if (!file) {
      const env = await S.exportEnvelope();
      const id = await upload(null, JSON.stringify(env), '');
      await bookkeeping(clientId, env.rev, id, 'sync: uploaded to Drive');
      return { kind: 'uploaded', rev: env.rev };
    }
    const dl = await download(file);
    const info = await inspect(dl.text, opts.passphrase);
    const rr = info.meta.rev;
    if (rr < sy.remoteRev) throw err('ROLLBACK', 'The Drive copy is older than the last sync. It was rejected as a possible rollback and nothing changed.');
    const base = sy.fp || (await fingerprint(S.validateState(S.defaultState())));
    // A different passphrase on Drive (salt differs) counts as a local change: after a passphrase change the Drive copy
    // must be re-uploaded under the new key, and a newer Drive copy under the old key must never be adopted silently.
    // keySalt records the key in use at the last sync, which tells "this device changed its passphrase" apart from
    // "another device did". Without a record, an unchanged Drive copy under another key can only mean a local change.
    const keyDiffers = !info.sameKey, remoteChanged = rr > sy.remoteRev;
    const localKeyChanged = keyDiffers && (!remoteChanged || (!!sy.keySalt && sy.keySalt !== S.saltId()));
    const localChanged = fp !== base || localKeyChanged;
    if (!remoteChanged && !localChanged) return { kind: 'in-sync', rev: rr };
    if (!remoteChanged) {
      const env = await S.exportEnvelope(Math.max(rr, sy.remoteRev) + 1);
      const id = await upload(file, JSON.stringify(env), dl.etag);
      await bookkeeping(clientId, env.rev, id, 'sync: uploaded to Drive');
      return { kind: 'uploaded', rev: env.rev };
    }
    const lm = S.getMeta();
    // An older-format Drive copy (schema 1 or 2) has no projects or pipeline: using it would drop this device's work data.
    const dropsWork = S.dropsWork(cur, { sourceSchema: info.sourceSchema });
    return hide({
      kind: localChanged ? 'conflict' : 'download-offer',
      local: summary(lm, cur, cur.schema), remote: summary(info.meta, info.state, info.sourceSchema), passphraseDiffers: keyDiffers, dropsWork,
    }, { file, dl, info, clientId, fp, dropsWork });
  }

  // choice: 'download' (offer), or 'remote' | 'local' | 'cancel' (conflict). Conflict resolutions first save the losing copy via saveBackup(text, name).
  async function apply(decision, choice, opts) {
    opts = opts || {};
    const ctx = decision && decision._ctx;
    if (!ctx) throw err('BAD_DECISION', 'Nothing to apply.');
    const S = L.store;
    const stamp = new Date().toISOString().slice(0, 10);
    if (choice === 'cancel' || choice === 'skip') return { kind: 'cancelled' };
    const wantsRemote = (decision.kind === 'download-offer' && choice === 'download') || (decision.kind === 'conflict' && choice === 'remote');
    const wantsLocal = decision.kind === 'conflict' && choice === 'local';
    if (!wantsRemote && !wantsLocal) throw err('BAD_CHOICE', 'Unknown choice.');
    if (wantsRemote && ctx.dropsWork && opts.allowWorkLoss !== true) {
      throw err('OLDER_FORMAT', 'The Drive copy is from an older version and has no projects or pipeline. Nothing was replaced.');
    }
    // The offer was made because this device had no changes. If it changed since, do not replace it.
    if (decision.kind === 'download-offer' && (await fingerprint(S.getState())) !== ctx.fp) {
      throw err('LOCAL_CHANGED', 'This device changed after the Drive copy was checked. Nothing was replaced. Run sync again.');
    }
    if (decision.kind === 'conflict') {
      if (typeof opts.saveBackup !== 'function') throw err('NEED_BACKUP', 'A backup of the losing copy is required first.');
      if (wantsRemote) await opts.saveBackup(JSON.stringify(await S.exportEnvelope()), 'lifeos-local-copy-' + stamp + '.json');
      else await opts.saveBackup(ctx.dl.text, 'lifeos-drive-copy-' + stamp + '.json');
    }
    if (wantsRemote) {
      await S.adoptEnvelope(ctx.info);
      await bookkeeping(ctx.clientId, ctx.info.meta.rev, ctx.file.id, 'sync: downloaded from Drive');
      return { kind: 'downloaded', rev: ctx.info.meta.rev };
    }
    const env = await S.exportEnvelope(ctx.info.meta.rev + 1);
    const id = await upload(ctx.file, JSON.stringify(env), ctx.dl.etag);
    await bookkeeping(ctx.clientId, env.rev, id, 'sync: uploaded to Drive');
    return { kind: 'uploaded', rev: env.rev };
  }

  L.sync = {
    SCOPE, FILE_NAME, MAX_REMOTE, isAvailable, validateClientId, buildAuthUrl, begin, parseFragment, consumeReturn, takeReturn,
    isConnected, expiresAt, disconnect, run, apply, fingerprint, _setFetch, _setToken,
  };
})();
