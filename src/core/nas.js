(function () {
  'use strict';
  // v2.0.0: the NAS sync target. Same rules as Drive sync (manual only, nothing merged, a backup of the losing copy first, rollback and
  // tamper checks, no silent adoption of a copy under another key), against the owner's own service (server/). The service sees only the
  // sealed envelope (ciphertext and its outer fields): no passphrase, recovery key, plaintext or key material is ever sent.
  // The device token lives only inside the encrypted state (settings.nas.token). It is sent only as a bearer header, never in a URL,
  // storage, error, diagnostic or log.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const MAX_REMOTE = 64 * 1024 * 1024, TIMEOUT_MS = 30000;
  const TOKEN_RE = /^lfs_[A-Za-z0-9_-]{43}$/;
  const ARCHIVE_RE = /^lifeos-archive-\d{4}\.json$/;
  const TAILSCALE = 'Connect Tailscale and try again.';
  const OWN = new WeakSet();
  const err = (code, message) => { const e = new Error(message); e.code = code; OWN.add(e); return e; };
  let fetchImpl = null, baseOverride = null;
  const getFetch = () => {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!f) throw err('NO_FETCH', 'This browser cannot reach the NAS.');
    return f;
  };
  function _setFetch(f) { fetchImpl = typeof f === 'function' ? f : null; }
  // Test hook: the address is fixed by the build (LifeOS.HOSTS.sync). Tests may point it at http://localhost or http://127.0.0.1 only.
  function _setBase(u) { baseOverride = typeof u === 'string' && /^http:\/\/(localhost|127\.0\.0\.1):\d{4,5}$/.test(u) ? u : null; }
  const hostName = () => { const h = L.HOSTS; return h && typeof h.sync === 'string' && /^[a-z0-9.-]{3,253}$/.test(h.sync) ? h.sync : ''; };
  const base = () => baseOverride || (hostName() ? 'https://' + hostName() : '');
  const isConfigured = () => !!base();
  // The page must be https (or localhost for tests): the service answers CORS only for the app's own https origin.
  function isAvailable(loc) {
    if (!loc || !isConfigured()) return false;
    return loc.protocol === 'https:' || (loc.protocol === 'http:' && (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1'));
  }

  // ---- the device token ----
  const hex = (u8) => Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('');
  const b64url = (u8) => btoa(String.fromCharCode.apply(null, u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const makeToken = () => 'lfs_' + b64url(L._webcrypto.getRandomValues(new Uint8Array(32)));
  async function tokenHash(token) {
    return hex(new Uint8Array(await L._webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)))));
  }
  const nasOf = () => (L.store.getState().settings.nas) || {};
  const hasToken = () => !!nasOf().token;
  // The token names this device to the service; it is not sync state, so the bookkeeping (what this device last synced) is kept when it changes.
  // Creates a token, keeps it inside the encrypted vault, and returns only its hash (what the service registers). The token itself is never shown.
  async function createToken() {
    const t = makeToken();
    await L.store.commit((x) => {
      x.settings.nas = Object.assign({}, x.settings.nas, { token: t, tokenAt: L.metrics.todayISO() });
      if (!Array.isArray(x.audit)) x.audit = [];
      x.audit.push({ ts: new Date().toISOString(), action: 'nas token created' });
      while (x.audit.length > 200) x.audit.shift();
    }, { quiet: true });
    return { hash: await tokenHash(t) };
  }
  // A token made by the service's own `token add` can be pasted once; it goes straight into the encrypted vault.
  async function setToken(text) {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!TOKEN_RE.test(t)) throw err('BAD_TOKEN', 'That is not a LifeOS device token (it starts with lfs_).');
    await L.store.commit((x) => {
      x.settings.nas = Object.assign({}, x.settings.nas, { token: t, tokenAt: L.metrics.todayISO() });
      if (!Array.isArray(x.audit)) x.audit = [];
      x.audit.push({ ts: new Date().toISOString(), action: 'nas token saved' });
    }, { quiet: true });
    return { hash: await tokenHash(t) };
  }
  async function currentHash() { const t = nasOf().token; return t ? tokenHash(t) : ''; }
  async function removeToken() {
    await L.store.commit((x) => {
      x.settings.nas = Object.assign({}, x.settings.nas, { token: '', tokenAt: '' });
      if (!Array.isArray(x.audit)) x.audit = [];
      x.audit.push({ ts: new Date().toISOString(), action: 'nas token removed' });
    }, { quiet: true });
  }

  // ---- transport ----
  async function readCapped(res, ctl) {
    const tooBig = () => err('TOO_LARGE', 'The NAS copy is larger than 64 MB, so it was rejected.');
    if (!res.body || typeof res.body.getReader !== 'function') { const t = await res.text(); if (t.length > MAX_REMOTE) throw tooBig(); return t; }
    const rd = res.body.getReader(), parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      n += value.byteLength;
      if (n > MAX_REMOTE) { try { ctl.abort(); rd.cancel(); } catch (e) { /* ignore */ } throw tooBig(); }
      parts.push(value);
    }
    const all = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.byteLength; }
    return new TextDecoder().decode(all);
  }
  // Every failure is a fixed code and a fixed message; nothing from a response, URL or header is copied in.
  async function api(method, path, o) {
    o = o || {};
    const token = nasOf().token;
    if (!isConfigured()) throw err('NAS_UNREACHABLE', 'The NAS address is not set in this build.');
    if (!token) throw err('NAS_AUTH', 'No device token yet. Create one in Settings and register it on the NAS service.');
    const headers = { Authorization: 'Bearer ' + token };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.expected !== undefined) headers['X-Expected-Rev'] = String(o.expected);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res, text = '';
    try {
      res = await getFetch()(base() + path, { method, body: o.body, headers, signal: ctl.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', mode: 'cors' });
      const len = res.headers && res.headers.get && Number(res.headers.get('content-length'));
      if (len > MAX_REMOTE) throw err('TOO_LARGE', 'The NAS copy is larger than 64 MB, so it was rejected.');
      text = await readCapped(res, ctl);
    } catch (e) {
      if (OWN.has(e)) throw e;
      throw err('NAS_UNREACHABLE', 'Cannot reach the NAS. ' + TAILSCALE);
    } finally { clearTimeout(timer); }
    const st = Number(res.status) || 0;
    const rev = res.headers && res.headers.get ? res.headers.get('x-rev') : null;
    if (st === 401) throw err('NAS_AUTH', 'The NAS did not accept this device\'s token. Create a new token in Settings and register it on the service.');
    if (st === 404) return { status: 404, text: '', rev: null };
    if (st === 409) { let cur = null; try { const j = JSON.parse(text); if (Number.isInteger(j.rev)) cur = j.rev; } catch (e) { /* fixed message below */ } return { status: 409, text: '', rev: cur }; }
    if (st === 413) throw err('TOO_LARGE', 'The NAS service refused the copy as too large. Nothing was uploaded.');
    if (st === 422) throw err('REMOTE_INVALID', 'The NAS service did not accept the file format. Nothing was uploaded.');
    if (st === 429) throw err('HTTP', 'The NAS service is limiting requests. Wait a minute and try again.');
    if (st < 200 || st >= 300) throw err('HTTP', 'The NAS service returned an error (HTTP ' + st + ').');
    return { status: st, text, rev: rev !== null && /^\d{1,10}$/.test(rev) ? Number(rev) : null };
  }
  const json = (text) => { try { const v = JSON.parse(text); if (v && typeof v === 'object') return v; } catch (e) { /* fall through */ } throw err('REMOTE_INVALID', 'The NAS service sent an unexpected reply.'); };
  const changed = () => err('REMOTE_CHANGED', 'The NAS copy changed while syncing. Nothing was overwritten. Run sync again.');

  // Reaching the service with this device's token (Test connection). Success or one fixed code.
  async function test() {
    try { const r = await api('GET', '/v1/health'); json(r.text); return { ok: true, code: null }; }
    catch (e) {
      const code = e && e.code === 'NAS_AUTH' ? 'NAS_AUTH' : e && e.code === 'NAS_UNREACHABLE' ? 'NAS_UNREACHABLE' : 'NAS_FAIL';
      if (L.ops && L.ops.record && code !== 'NAS_FAIL') L.ops.recordError(e, 'sync'); else if (L.ops && L.ops.record) L.ops.record('SYNC_FAIL', 'sync');
      return { ok: false, code, message: e && OWN.has(e) ? e.message : 'The NAS service could not be checked.' };
    }
  }
  async function getVault() {
    const r = await api('GET', '/v1/vault');
    if (r.status === 404) return null;
    if (r.rev === null) throw err('REMOTE_INVALID', 'The NAS service sent an unexpected reply.');
    return { text: r.text, rev: r.rev };
  }
  async function putVault(text, expected) {
    if (text.length > MAX_REMOTE) throw err('TOO_LARGE', 'The vault is larger than 64 MB, so nothing was uploaded. Your data on this device is unchanged. Delete old entries, study sessions, takeaways, activities, logged contacts, facts or long notes, then sync again.');
    const r = await api('PUT', '/v1/vault', { body: text, expected });
    if (r.status === 409) throw changed();
    const j = json(r.text);
    if (!Number.isInteger(j.rev)) throw err('REMOTE_INVALID', 'The NAS service sent an unexpected reply.');
    return j.rev;
  }

  // ---- archive files ----
  async function putNamed(name, text) {
    if (!ARCHIVE_RE.test(name)) throw err('BAD_NAME', 'That is not an archive file name.');
    if (text.length > MAX_REMOTE) throw err('TOO_LARGE', 'The archive is larger than 64 MB, so nothing was uploaded.');
    await api('PUT', '/v1/archives/' + name, { body: text });
    return true;
  }
  async function getNamed(name) {
    if (!ARCHIVE_RE.test(name)) throw err('BAD_NAME', 'That is not an archive file name.');
    const r = await api('GET', '/v1/archives/' + name);
    if (r.status === 404) throw err('NOT_FOUND', 'That archive is not on the NAS.');
    return r.text;
  }

  // ---- history kept by the service (the last 30 copies) ----
  async function versions() {
    const j = json((await api('GET', '/v1/versions')).text);
    if (!Array.isArray(j.versions)) throw err('REMOTE_INVALID', 'The NAS service sent an unexpected reply.');
    return j.versions.slice(0, 30).map((v) => {
      if (!v || !Number.isInteger(v.id) || !Number.isInteger(v.envRev) || typeof v.at !== 'string' || !Number.isInteger(v.size)) throw err('REMOTE_INVALID', 'The NAS service sent an unexpected reply.');
      return { id: v.id, envRev: v.envRev, at: v.at.slice(0, 40), size: v.size };
    });
  }
  async function getVersion(id) {
    if (!Number.isInteger(id) || id < 0) throw err('BAD_NAME', 'That is not a version number.');
    const r = await api('GET', '/v1/versions/' + id);
    if (r.status === 404) throw err('NOT_FOUND', 'That version is no longer on the NAS.');
    return r.text;
  }

  // ---- sync: the same comparison as Drive ----
  async function inspect(text, passphrase) {
    let envObj;
    try { envObj = JSON.parse(text); } catch (e) { throw err('REMOTE_INVALID', 'The NAS file is not a valid LifeOS vault.'); }
    try { return await L.store.inspectEnvelope(envObj, passphrase); }
    catch (e) {
      if (e && e.code === 'NEED_PASSPHRASE') throw err2('NEED_PASSPHRASE', 'Enter the passphrase of the NAS copy.');
      if (e && e.code === 'WRONG_PASSPHRASE') throw err2('WRONG_PASSPHRASE', 'The NAS copy uses a different passphrase.');
      if (String((e && e.message) || '').indexOf('Vault revision check') === 0) throw err('TAMPER', 'The NAS copy failed its revision check (the outer and inner revision numbers disagree). It was rejected.');
      throw err('REMOTE_INVALID', 'The NAS file is not a valid LifeOS vault.');
    }
  }
  const err2 = (code, message) => { const e = new Error(message); e.code = code; return e; };
  async function bookkeeping(remoteRev, srev, action, fp, keySalt) {
    const S = L.store;
    await S.commit((x) => {
      x.settings.nas = Object.assign({}, x.settings.nas, { remoteRev, srev, fp, keySalt });
      if (L.ops && x.ops) L.ops.markSync(x, L.metrics.todayISO(), S.getMeta().rev);
      if (!Array.isArray(x.audit)) x.audit = [];
      x.audit.push({ ts: new Date().toISOString(), action });
      while (x.audit.length > 200) x.audit.shift();
    }, { quiet: true });
  }
  const SH = () => L.sync._shared;

  async function run(opts) {
    opts = opts || {};
    const S = L.store, sh = SH();
    const cur = S.getState();
    const sy = cur.settings.nas;
    const g = await getVault();
    const fp = await sh.fingerprint(cur);
    if (!g) {
      const ex = await sh.exportSnap();
      const srev = await putVault(JSON.stringify(ex.env), 'none');
      await bookkeeping(ex.env.rev, srev, 'sync: uploaded to NAS', ex.snap, ex.saltId);
      return { kind: 'uploaded', rev: ex.env.rev, target: 'nas' };
    }
    const info = await inspect(g.text, opts.passphrase);
    const rr = info.meta.rev;
    if (rr < sy.remoteRev) throw err('ROLLBACK', 'The NAS copy is older than the last sync. It was rejected as a possible rollback and nothing changed.');
    const base0 = sy.fp || (await sh.fingerprint(S.validateState(S.defaultState())));
    const keyDiffers = !info.sameKey, remoteChanged = rr > sy.remoteRev;
    const localKeyChanged = keyDiffers && (!remoteChanged || (!!sy.keySalt && sy.keySalt !== S.saltId()));
    const localChanged = fp !== base0 || localKeyChanged;
    if (!remoteChanged && !localChanged) {
      await S.commit((x) => { if (L.ops && x.ops) L.ops.markSync(x, L.metrics.todayISO(), S.getMeta().rev); }, { quiet: true });
      return { kind: 'in-sync', rev: rr, target: 'nas' };
    }
    if (!remoteChanged) {
      const ex = await sh.exportSnap(Math.max(rr, sy.remoteRev) + 1);
      const srev = await putVault(JSON.stringify(ex.env), g.rev);
      await bookkeeping(ex.env.rev, srev, 'sync: uploaded to NAS', ex.snap, ex.saltId);
      return { kind: 'uploaded', rev: ex.env.rev, target: 'nas' };
    }
    const lm = S.getMeta();
    const dropped = S.droppedData(cur, Object.defineProperty(Object.assign({}, info.state), 'sourceSchema', { value: info.sourceSchema, enumerable: false })), dropsWork = dropped.length > 0;
    return sh.hide({
      kind: localChanged ? 'conflict' : 'download-offer', target: 'nas',
      local: sh.summary(lm, cur, cur.schema), remote: sh.summary(info.meta, info.state, info.sourceSchema), passphraseDiffers: keyDiffers, dropsWork, dropped,
    }, { g, info, fp, saltId: S.saltId(), dropsWork, dropped });
  }

  async function apply(decision, choice, opts) {
    opts = opts || {};
    const ctx = decision && decision._ctx;
    if (!ctx) throw err('BAD_DECISION', 'Nothing to apply.');
    const S = L.store, sh = SH();
    const stamp = L.metrics.todayISO();
    if (choice === 'cancel' || choice === 'skip') return { kind: 'cancelled', target: 'nas' };
    const wantsRemote = (decision.kind === 'download-offer' && choice === 'download') || (decision.kind === 'conflict' && choice === 'remote');
    const wantsLocal = decision.kind === 'conflict' && choice === 'local';
    if (!wantsRemote && !wantsLocal) throw err('BAD_CHOICE', 'Unknown choice.');
    if (wantsRemote && ctx.dropsWork && opts.allowWorkLoss !== true) {
      throw err('OLDER_FORMAT', S.lossWhy(ctx.dropped || [], ctx.info.sourceSchema < 14, 'The NAS copy') + 'Using it would remove this device\'s ' + S.lossText(S.getState(), null, ctx.dropped || []) + '. Nothing was replaced. Tick the box to go ahead.');
    }
    if (S.saltId() !== ctx.saltId) throw err('LOCAL_CHANGED', 'This device changed after the NAS copy was checked. Nothing was replaced. Run sync again.');
    if (decision.kind === 'download-offer' && (await sh.fingerprint(S.getState())) !== ctx.fp) {
      throw err('LOCAL_CHANGED', 'This device changed after the NAS copy was checked. Nothing was replaced. Run sync again.');
    }
    if (decision.kind === 'conflict') {
      if (typeof opts.saveBackup !== 'function') throw err('NEED_BACKUP', 'A backup of the losing copy is required first.');
      if (wantsRemote) await opts.saveBackup(JSON.stringify(await S.exportEnvelope()), 'lifeos-local-copy-' + stamp + '.json');
      else await opts.saveBackup(ctx.g.text, 'lifeos-nas-copy-' + stamp + '.json');
    }
    if (wantsRemote) {
      const afp = await sh.fingerprint(ctx.info.state);
      await S.adoptEnvelope(ctx.info);
      await bookkeeping(ctx.info.meta.rev, ctx.g.rev, 'sync: downloaded from NAS', afp, S.saltId());
      return { kind: 'downloaded', rev: ctx.info.meta.rev, target: 'nas' };
    }
    const ex = await sh.exportSnap(ctx.info.meta.rev + 1);
    const srev = await putVault(JSON.stringify(ex.env), ctx.g.rev);
    await bookkeeping(ex.env.rev, srev, 'sync: uploaded to NAS', ex.snap, ex.saltId);
    return { kind: 'uploaded', rev: ex.env.rev, target: 'nas' };
  }

  // SEC-134: after ROLLBACK (the NAS copy is older than the one this device last synced, for example after a restore on the service or a
  // snapshot rollback of the dataset) sync would refuse forever. The owner may then replace the NAS copy with this device's copy. The older
  // copy is checked again, never adopted, and saved to a file first; the write is a compare-and-swap on the service revision just read.
  async function replaceOlder(opts) {
    opts = opts || {};
    if (typeof opts.saveBackup !== 'function') throw err('NEED_BACKUP', 'A backup of the NAS copy is required first.');
    const S = L.store, sh = SH(), sy = S.getState().settings.nas;
    const g = await getVault();
    if (!g) throw err('BAD_DECISION', 'The NAS holds no copy now. Run sync again.');
    const info = await inspect(g.text, opts.passphrase);
    const rr = info.meta.rev;
    if (!(rr < sy.remoteRev)) throw err('BAD_DECISION', 'The NAS copy is no longer older than the last sync. Nothing was replaced. Run sync again.');
    await opts.saveBackup(g.text, 'lifeos-nas-copy-' + L.metrics.todayISO() + '.json');
    const ex = await sh.exportSnap(Math.max(rr, sy.remoteRev) + 1);
    const srev = await putVault(JSON.stringify(ex.env), g.rev);
    await bookkeeping(ex.env.rev, srev, 'sync: replaced an older NAS copy', ex.snap, ex.saltId);
    return { kind: 'uploaded', rev: ex.env.rev, target: 'nas' };
  }

  L.nas = {
    TAILSCALE, isAvailable, isConfigured, makeToken, tokenHash, createToken, setToken, removeToken, hasToken, currentHash, test, run, apply, replaceOlder,
    putNamed, getNamed, versions, getVersion, _setFetch, _setBase,
  };
})();
