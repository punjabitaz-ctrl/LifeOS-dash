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

  async function deriveKey(passphrase, salt) {
    if (typeof passphrase !== 'string' || !salt || salt.length !== 16) throw bad();
    const s = sub();
    const base = await s.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return s.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encrypt(key, obj) {
    const iv = C.getRandomValues(new Uint8Array(12));
    const ct = await sub().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  }
  async function decrypt(key, box) {
    try {
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
  function parseEnvelope(env) {
    if (!env || typeof env !== 'object' || env.v !== 1 || !env.kdf || typeof env.kdf !== 'object') throw bad();
    const k = env.kdf;
    if (k.name !== 'PBKDF2' || k.hash !== 'SHA-256' || k.iter !== ITER) throw bad();
    const salt = unb64(k.salt);
    if (salt.length !== 16) throw bad();
    if (typeof env.iv !== 'string' || typeof env.ct !== 'string') throw bad();
    return { salt, iv: env.iv, ct: env.ct };
  }
  async function exportBackup(passphrase, state) {
    checkPassphrase(passphrase);
    const clean = L.store.validateState(L.priv ? L.priv.mainOnly(state) : state);
    const salt = newSalt();
    const key = await deriveKey(passphrase, salt);
    const out = JSON.stringify(await makeEnvelope(key, salt, clean));
    if (out.length > MAX_BACKUP) throw new Error('The backup would be larger than 64 MB, so no file was made. Your data on this device is unchanged. Delete old entries, study sessions, takeaways, activities, logged contacts, facts or long notes, then try again.');
    return out;
  }
  async function importBackup(passphrase, text) {
    if (typeof text !== 'string' || text.length > MAX_BACKUP) throw new Error('Not a LifeOS backup');
    let env;
    try { env = JSON.parse(text); } catch (e) { throw new Error('Not a LifeOS backup'); }
    const { salt } = parseEnvelope(env);
    const key = await deriveKey(passphrase, salt);
    return L.store.validateState(await decrypt(key, env));
  }

  L.vault = { MAX_BACKUP, newSalt, deriveKey, encrypt, decrypt, exportBackup, importBackup, checkPassphrase, makeEnvelope, parseEnvelope };
})();
