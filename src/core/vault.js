(function () {
  'use strict';
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const C = globalThis.crypto || (typeof require === 'function' ? require('node:crypto').webcrypto : undefined);
  L._webcrypto = C;
  const sub = () => { if (!C || !C.subtle) throw new Error('WEBCRYPTO_UNAVAILABLE'); return C.subtle; };
  const ITER = 600000, MIN_PASS = 12, MAX_BACKUP = 64 * 1024 * 1024;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const bad = () => new Error('BAD_PASSPHRASE_OR_DATA');

  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(s) {
    if (typeof s !== 'string' || s.length > 3e8 || s.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw bad();
    let bin;
    try { bin = atob(s); } catch (e) { throw bad(); }
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function checkPassphrase(p) {
    if (typeof p !== 'string' || p.length < MIN_PASS) throw new Error('Passphrase must be at least 12 characters');
  }
  function newSalt() { return C.getRandomValues(new Uint8Array(16)); }

  // The usages let a real passphrase key also wrap and unwrap a data key (envelope v2). Callers that replace deriveKey with a key
  // that has only encrypt and decrypt usages still work: wrapping then falls back to encrypt and decrypt of the same bytes.
  async function deriveKey(passphrase, salt) {
    if (typeof passphrase !== 'string' || !salt || salt.length !== 16) throw bad();
    const s = sub();
    const base = await s.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return s.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
  }
  async function encrypt(key, obj) {
    const iv = C.getRandomValues(new Uint8Array(12));
    const ct = await sub().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  }
  // A v2 envelope opened with its passphrase key (the same key a v1 file used): the data key is unwrapped from the passphrase wrap, then the data is
  // decrypted. Nothing here lowers the bar: the passphrase key is still the only way in. Plain boxes decrypt as before.
  async function decrypt(key, box) {
    try {
      if (box && typeof box === 'object' && box.fmt === 2) {
        const p = parseEnvelope(box);
        return await decrypt(await unwrapData(p.wraps.find((w) => w.kind === 'passphrase'), key), p.data);
      }
      const iv = unb64(box && box.iv);
      if (iv.length !== 12) throw bad();
      const pt = await sub().decrypt({ name: 'AES-GCM', iv }, key, unb64(box.ct));
      return JSON.parse(dec.decode(pt));
    } catch (e) { throw bad(); }
  }
  async function makeEnvelope(key, salt, obj) {
    const { iv, ct } = await encrypt(key, obj);
    return { v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: ITER, salt: b64(salt) }, iv, ct };
  }

  // ---------------------------------------------------------------- envelope v2 (v1.8.0): a random data key, wrapped
  // Layout: { v:1, kdf, iv, ct,  fmt:2, wraps:[{kind,kdf,iv,wk}], data:{iv,ct}, [rev,updatedAt,deviceId], [arch,year] }.
  // The first four fields are the v1 shape, sealed under the passphrase key around a tiny stub that holds no data, so an older app
  // that opens the file with the passphrase reads "schema 20" and refuses it with its newer-version message instead of crashing or
  // overwriting. The real data is data.ct under the random data key; the wraps hold that key under the passphrase and, when the owner
  // turned it on, under the recovery key. One wrap per kind. The data key is only ever a non-extractable CryptoKey after unwrap.
  const KINDS = ['passphrase', 'recovery'];
  const STUB_SCHEMA = 20;
  const WRAP_KEYS = ['kind', 'kdf', 'iv', 'wk'], KDF_KEYS = ['name', 'hash', 'iter', 'salt'];
  const ENV2_KEYS = ['v', 'kdf', 'iv', 'ct', 'fmt', 'wraps', 'data', 'rev', 'updatedAt', 'deviceId', 'arch', 'year'];
  const DATA_CT_MAX = 3e8;
  const aad = (kind) => enc.encode('lifeos-wrap-v2:' + kind);
  const onlyKeys = (o, allowed) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) throw bad(); };
  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const b64Len = (s, n) => { const u = unb64(s); if (u.length !== n) throw bad(); return s; };
  function cleanKdf(k) {
    if (!isObj(k)) throw bad();
    onlyKeys(k, KDF_KEYS);
    if (k.name !== 'PBKDF2' || k.hash !== 'SHA-256' || k.iter !== ITER) throw bad();
    b64Len(k.salt, 16);
    return { name: 'PBKDF2', hash: 'SHA-256', iter: ITER, salt: k.salt };
  }
  function cleanWraps(list) {
    if (!Array.isArray(list) || list.length < 1 || list.length > 2) throw bad();
    const out = [], seen = new Set();
    for (const w of list) {
      if (!isObj(w)) throw bad();
      onlyKeys(w, WRAP_KEYS);
      if (!KINDS.includes(w.kind) || seen.has(w.kind)) throw bad();
      seen.add(w.kind);
      out.push({ kind: w.kind, kdf: cleanKdf(w.kdf), iv: b64Len(w.iv, 12), wk: b64Len(w.wk, 48) });
    }
    if (!seen.has('passphrase')) throw bad();
    out.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
    return out;
  }
  function cleanBox(x, minCt) {
    if (!isObj(x)) throw bad();
    onlyKeys(x, ['iv', 'ct']);
    b64Len(x.iv, 12);
    if (typeof x.ct !== 'string' || x.ct.length < minCt || x.ct.length > DATA_CT_MAX) throw bad();
    unb64(x.ct);
    return { iv: x.iv, ct: x.ct };
  }
  // Returns { fmt:1, salt, iv, ct } for a v1 envelope (as before) or { fmt:2, salt (of the passphrase wrap), wraps, iv, ct, data, clean } for v2.
  // v2 is strict: unknown fields are refused, one wrap per kind, sizes and the shell checked. Any doubt throws the one generic error.
  function parseEnvelope(env) {
    if (!env || typeof env !== 'object' || env.v !== 1 || !env.kdf || typeof env.kdf !== 'object') throw bad();
    if (env.fmt === undefined) {
      const k = env.kdf;
      if (k.name !== 'PBKDF2' || k.hash !== 'SHA-256' || k.iter !== ITER) throw bad();
      const salt = unb64(k.salt);
      if (salt.length !== 16) throw bad();
      if (typeof env.iv !== 'string' || typeof env.ct !== 'string') throw bad();
      return { fmt: 1, salt, iv: env.iv, ct: env.ct };
    }
    if (env.fmt !== 2 || Array.isArray(env)) throw bad();
    onlyKeys(env, ENV2_KEYS);
    const shell = cleanKdf(env.kdf), wraps = cleanWraps(env.wraps);
    const pw = wraps.find((w) => w.kind === 'passphrase');
    if (shell.salt !== pw.kdf.salt) throw bad();
    b64Len(env.iv, 12);
    if (typeof env.ct !== 'string' || env.ct.length < 24 || env.ct.length > 2048) throw bad();
    unb64(env.ct);
    const data = cleanBox(env.data, 24);
    const clean = { v: 1, kdf: shell, iv: env.iv, ct: env.ct, fmt: 2, wraps, data };
    for (const k of ['rev', 'updatedAt', 'deviceId', 'arch', 'year']) if (env[k] !== undefined) clean[k] = env[k];
    return { fmt: 2, salt: unb64(shell.salt), wraps, iv: data.iv, ct: data.ct, data, clean };
  }
  // The same canonical copy parseEnvelope validates, for persisting or sending: only known fields, whatever else a remote file carried is dropped.
  function cleanEnvelope(env) {
    const p = parseEnvelope(env);
    if (p.fmt === 2) return JSON.parse(JSON.stringify(p.clean));
    const out = { v: 1, kdf: { name: env.kdf.name, hash: env.kdf.hash, iter: env.kdf.iter, salt: env.kdf.salt }, iv: env.iv, ct: env.ct };
    for (const k of ['rev', 'updatedAt', 'deviceId']) if (env[k] !== undefined) out[k] = env[k];
    return out;
  }
  // Public identifier of the passphrase key generation: the passphrase wrap's salt (a v1 envelope: its salt). Not secret.
  const passSaltOf = (parsed) => b64(parsed.salt);

  // ---- recovery key: 256 random bits as base32 (RFC 4648 letters, no padding) plus a 4-letter checksum, in groups of four ----
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function toB32(bytes) {
    let bits = 0, val = 0, out = '';
    for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits > 0) out += B32[(val << (5 - bits)) & 31];
    return out;
  }
  function fromB32(s) {
    let bits = 0, val = 0; const out = [];
    for (const ch of s) { const i = B32.indexOf(ch); if (i < 0) return null; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
    return new Uint8Array(out);
  }
  async function checksum(body) {
    const d = new Uint8Array(await sub().digest('SHA-256', enc.encode('lifeos-recovery-check:' + body)));
    return toB32(d.subarray(0, 3)).slice(0, 4);
  }
  const group = (s) => s.match(/.{1,4}/g).join('-');
  const RK_ERR = () => { const e = new Error('RECOVERY_KEY_FORMAT'); e.code = 'RECOVERY_KEY_FORMAT'; return e; };
  // Canonical form of typed text: letters upper-cased, spaces and hyphens removed. Returns the 52 key letters, or throws RECOVERY_KEY_FORMAT
  // (a typo caught by the checksum, a wrong length or a letter outside the alphabet). The error never carries any of the text.
  async function parseRecoveryKey(text) {
    if (typeof text !== 'string' || text.length > 200) throw RK_ERR();
    const t = text.toUpperCase().replace(/[\s-]/g, '');
    if (t.length !== 56 || !/^[A-Z2-7]+$/.test(t)) throw RK_ERR();
    const body = t.slice(0, 52), chk = t.slice(52), bytes = fromB32(body);
    if (!bytes || bytes.length !== 32 || toB32(bytes) !== body || (await checksum(body)) !== chk) throw RK_ERR();
    return body;
  }
  // The retype check: the whole key, or its last two groups (8 letters, the last four being the checksum). Case, spaces and hyphens ignored.
  function retypeMatches(keyText, typed) {
    if (typeof keyText !== 'string' || typeof typed !== 'string' || typed.length > 200) return false;
    const a = keyText.toUpperCase().replace(/[\s-]/g, ''), b = typed.toUpperCase().replace(/[\s-]/g, '');
    const eq = (x, y) => { if (x.length !== y.length) return false; let d = 0; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i); return d === 0; };
    return a.length === 56 && (eq(a, b) || eq(a.slice(-8), b));
  }
  async function newRecoveryKey() {
    const raw = C.getRandomValues(new Uint8Array(32)), body = toB32(raw);
    raw.fill(0);
    return group(body + (await checksum(body)));
  }
  // The key-encryption key for a recovery wrap: the same KDF and parameters as the passphrase, over the 52 key letters.
  const DK = (p, s) => L.vault.deriveKey(p, s); // through the exported name, so a caller may substitute it (tests use a cheaper key)
  const recoveryKek = async (canon, salt, real) => (real ? deriveKey : DK)(canon, salt);

  // ---- wrap and unwrap the data key ----
  const canWrap = (kek) => !!kek && Array.isArray(kek.usages) && kek.usages.includes('wrapKey') && kek.usages.includes('unwrapKey');
  async function wrapNew(dataKey, kek, kind, salt) {
    const iv = C.getRandomValues(new Uint8Array(12)), params = { name: 'AES-GCM', iv, additionalData: aad(kind) };
    let wk;
    if (canWrap(kek)) wk = new Uint8Array(await sub().wrapKey('raw', dataKey, kek, params));
    else { // a key without wrap usages: the same bytes through encrypt (identical result), the raw copy is cleared at once
      const raw = new Uint8Array(await sub().exportKey('raw', dataKey));
      try { wk = new Uint8Array(await sub().encrypt(params, kek, raw)); } finally { raw.fill(0); }
    }
    return { kind, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: ITER, salt: b64(salt) }, iv: b64(iv), wk: b64(wk) };
  }
  // The non-extractable data key from one wrap and its key-encryption key. Any failure is the one generic error.
  async function unwrapData(wrap, kek) {
    try {
      const iv = unb64(wrap.iv), wk = unb64(wrap.wk), params = { name: 'AES-GCM', iv, additionalData: aad(wrap.kind) };
      if (canWrap(kek)) return await sub().unwrapKey('raw', wk, kek, params, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      const raw = new Uint8Array(await sub().decrypt(params, kek, wk));
      try { return await sub().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); } finally { raw.fill(0); }
    } catch (e) { throw bad(); }
  }
  // A new random data key for one vault, wrapped under the passphrase and (recoveryText, optional) the recovery key, each with its own fresh salt.
  // Returns { key, kek, wraps }: key is the non-extractable data key, kek the passphrase key-encryption key (held while unlocked, it seals the stub).
  // real: use this module's own derivation (backup files do, as before v1.8.0) instead of the exported one.
  async function newKeyset(passphrase, recoveryText, real) {
    checkPassphrase(passphrase);
    const canon = recoveryText ? await parseRecoveryKey(recoveryText) : null;
    const gen = await sub().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const ps = newSalt(), kek = await (real ? deriveKey : DK)(passphrase, ps);
    const wraps = [await wrapNew(gen, kek, 'passphrase', ps)];
    if (canon) { const rs = newSalt(); wraps.push(await wrapNew(gen, await recoveryKek(canon, rs, real), 'recovery', rs)); }
    const key = await unwrapData(wraps[0], kek);
    return { key, kek, wraps };
  }
  // Open the data key from a parsed v2 envelope's (or private blob's) wraps with a secret: a passphrase string, or { recovery: text }.
  // Returns { key, kek (passphrase only), kind }. A wrong secret is BAD_PASSPHRASE_OR_DATA, or BAD_RECOVERY_KEY for a recovery secret.
  async function unwrapWith(wraps, secret, real) {
    if (isObj(secret) && secret.recovery !== undefined) {
      const canon = await parseRecoveryKey(secret.recovery);
      const w = wraps.find((x) => x.kind === 'recovery');
      const fail = () => { const e = new Error('BAD_RECOVERY_KEY'); e.code = 'BAD_RECOVERY_KEY'; return e; };
      if (!w) throw fail();
      try { return { key: await unwrapData(w, await recoveryKek(canon, unb64(w.kdf.salt), real)), kek: null, kind: 'recovery' }; } catch (e) { throw fail(); }
    }
    if (typeof secret !== 'string' || !secret) throw bad();
    const w = wraps.find((x) => x.kind === 'passphrase');
    const kek = await (real ? deriveKey : DK)(secret, unb64(w.kdf.salt));
    return { key: await unwrapData(w, kek), kek, kind: 'passphrase' };
  }
  // The older-app stub must open under the passphrase key and say what it should, so a changed shell is refused when the passphrase opens the
  // file. (The revision binding is checked on the real data by the store.) A recovery-key open has no passphrase key and cannot check the stub;
  // the data itself is still authenticated.
  async function checkShell(env, kek) {
    const stub = await decrypt(kek, { iv: env.iv, ct: env.ct });
    if (!isObj(stub) || stub.schema !== STUB_SCHEMA || stub.newerFormat !== true) throw bad();
  }
  // Seal an object as a v2 envelope. meta: optional { rev, updatedAt, deviceId } written outside and mirrored in the stub; extra: arch and year for archive files.
  async function sealEnvelope(ks, obj, meta, extra) {
    const data = await encrypt(ks.key, obj);
    const stub = { schema: STUB_SCHEMA, newerFormat: true };
    if (meta) stub._meta = { rev: meta.rev, updatedAt: meta.updatedAt, deviceId: meta.deviceId };
    const shell = await encrypt(ks.kek, stub), pw = ks.wraps.find((w) => w.kind === 'passphrase');
    return Object.assign({ v: 1, kdf: JSON.parse(JSON.stringify(pw.kdf)), iv: shell.iv, ct: shell.ct, fmt: 2, wraps: JSON.parse(JSON.stringify(ks.wraps)), data }, meta || {}, extra || {});
  }
  // Open any envelope (v1 or v2) with a secret. Returns { raw, fmt, key, kek, wraps, kind, parsed }; for a v1 file key is the v1 key, kek and wraps are null.
  // real: open with this module's own derivation (backup files), as before v1.8.0; the other callers go through the exported one.
  async function openEnvelope(env, secret, real) {
    const parsed = parseEnvelope(env);
    if (parsed.fmt === 1) {
      if (isObj(secret)) throw bad();
      const key = await (real ? deriveKey : DK)(secret, parsed.salt);
      return { raw: await L.vault.decrypt(key, env), fmt: 1, key, kek: null, wraps: null, kind: 'passphrase', parsed };
    }
    const o = await unwrapWith(parsed.wraps, secret, real);
    if (o.kek) await checkShell(parsed.clean, o.kek);
    return { raw: await L.vault.decrypt(o.key, parsed.data), fmt: 2, key: o.key, kek: o.kek, wraps: parsed.wraps, kind: o.kind, parsed };
  }
  // True when the secret opens the file (a v2 file: only the wrap is opened, the data is not decrypted).
  async function verifySecret(env, secret) {
    try {
      const parsed = parseEnvelope(env);
      if (parsed.fmt === 1) { if (isObj(secret)) return false; await decrypt(await DK(secret, parsed.salt), env); return true; }
      const o = await unwrapWith(parsed.wraps, secret);
      if (o.kek) await checkShell(parsed.clean, o.kek);
      return true;
    } catch (e) { return false; }
  }
  // A backup file: a new data key under the backup passphrase, and (when recoveryText is given and valid) under that recovery key too.
  async function exportBackup(passphrase, state, recoveryText) {
    checkPassphrase(passphrase);
    const clean = L.store.validateState(L.priv ? L.priv.mainOnly(state) : state);
    const ks = await newKeyset(passphrase, recoveryText || null, true);
    const out = JSON.stringify(await sealEnvelope(ks, clean));
    if (out.length > MAX_BACKUP) throw new Error('The backup would be larger than 64 MB, so no file was made. Your data on this device is unchanged. Delete old entries, study sessions, takeaways, activities, logged contacts, facts or long notes, then try again.');
    return out;
  }
  // Decrypts a backup file and returns the raw plaintext object, unvalidated (importBackup validates it; verifying a file reads it only).
  async function readBackupRaw(secret, text) {
    if (typeof text !== 'string' || text.length > MAX_BACKUP) throw new Error('Not a LifeOS backup');
    let env;
    try { env = JSON.parse(text); } catch (e) { throw new Error('Not a LifeOS backup'); }
    return (await openEnvelope(env, secret, true)).raw;
  }
  async function importBackup(secret, text) {
    return L.store.validateState(await readBackupRaw(secret, text));
  }

  L.vault = { MAX_BACKUP, ITER, STUB_SCHEMA, newSalt, deriveKey, encrypt, decrypt, exportBackup, importBackup, readBackupRaw, checkPassphrase, makeEnvelope, parseEnvelope, cleanEnvelope, passSaltOf,
    newRecoveryKey, parseRecoveryKey, retypeMatches, newKeyset, unwrapWith, checkShell, wrapNew, unwrapData, cleanWraps, sealEnvelope, openEnvelope, verifySecret, recoveryKek, b64, unb64 };
})();
