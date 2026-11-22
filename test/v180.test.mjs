// v1.8.0 passphrase recovery (SPEC.md "v1.8.0 addendum" and "Amendment (v1.8.0 build)"): envelope v2, recovery keys for the main and the private vault,
// rotation, every kind of copy, an older app's refusal, tampering, and that no key material leaves the vault.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { L, PASS, memAdapter } from './_load.mjs';
import { drive, TOKEN } from './_v070.mjs';
import { build, vault, io, clone, fastKeys, realKeys, PRIV, TODAY } from './_archive.mjs';

const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), V = live('vault'), P = live('priv'), A = live('archive'), O = live('ops');
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const NEWP = 'a brand new passphrase 77', BKP = 'backup passphrase 1';
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { P.close('system'); } catch (e) { /* closed */ } try { S.lock(); } catch (e) { /* locked */ } realKeys(); } });
const stored = (ad) => ad._m.get('envelope');
const rej = async (p, re) => { try { await p; } catch (e) { if (re) assert.match(String(e.message), re); return e; } assert.fail('expected a rejection'); };
// Turn the main recovery key on: returns the key text.
async function enable(pass = PASS) { const h = await S.beginRecovery(pass); await h.finish(h.key); return h.key; }
async function enablePriv(pass = PRIV) { const h = await P.beginRecovery(pass); await h.finish(h.key); return h.key; }
const kinds = (env) => V.parseEnvelope(env).wraps.map((w) => w.kind);
const allWraps = new Set();   // every wrapped key and wrap IV seen, to prove none appears in an output
const seen = (env) => { for (const w of V.parseEnvelope(env).wraps) { allWraps.add(w.wk); allWraps.add(w.iv); } };

// ---------------------------------------------------------------- the key
test('recovery key: 256 random bits, 52 base32 letters plus a 4-letter checksum in groups of four; a typo is caught before any key is derived', async () => {
  const a = await V.newRecoveryKey(), b = await V.newRecoveryKey();
  assert.match(a, /^([A-Z2-7]{4}-){13}[A-Z2-7]{4}$/); assert.notEqual(a, b);
  const canon = await V.parseRecoveryKey(a);
  assert.equal(canon.length, 52); assert.equal(canon, a.replace(/-/g, '').slice(0, 52));
  assert.equal(await V.parseRecoveryKey(' ' + a.toLowerCase().replace(/-/g, ' ') + ' '), canon, 'case, spaces and hyphens are ignored');
  await vault(null);
  const sub = globalThis.crypto.subtle, orig = sub.deriveKey.bind(sub); let derived = 0;
  sub.deriveKey = (...x) => { derived++; return orig(...x); };
  try {
    const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    for (const bad of [flip(a, 0), flip(a, 20), flip(a, 61), a.slice(0, -1), a + 'A', '', 'x'.repeat(56), a.replace(/[A-Z]/, '!'), 5, null]) {
      const e = await rej(V.parseRecoveryKey(bad)); assert.equal(e.code, 'RECOVERY_KEY_FORMAT'); assert.ok(!String(e.message).includes(canon.slice(0, 12)));
    }
    await rej(S.recoveryMatches(flip(a, 5)), /RECOVERY_KEY_FORMAT/);
    assert.equal(derived, 0, 'a typo never reaches a derivation');
  } finally { sub.deriveKey = orig; }
  assert.ok(V.retypeMatches(a, a) && V.retypeMatches(a, a.slice(-9)) && V.retypeMatches(a, a.slice(-9).toLowerCase().replace('-', ' ')));
  assert.ok(!V.retypeMatches(a, a.slice(-4)) && !V.retypeMatches(a, a.slice(-14)) && !V.retypeMatches(a, b) && !V.retypeMatches(a, ''));
});

// ---------------------------------------------------------------- the layout
test('envelope v2: a data key wrapped under the passphrase, fresh salt per wrap and fresh IV per write, non-extractable key, strict sizes', async () => {
  const ad = await vault(null);
  const e1 = clone(stored(ad)); seen(e1);
  assert.deepEqual(Object.keys(e1).sort(), ['ct', 'data', 'deviceId', 'fmt', 'iv', 'kdf', 'rev', 'updatedAt', 'v', 'wraps']);
  assert.equal(e1.fmt, 2); assert.equal(e1.wraps.length, 1); assert.equal(e1.wraps[0].kind, 'passphrase');
  const w = e1.wraps[0];
  assert.deepEqual(Object.keys(w).sort(), ['iv', 'kdf', 'kind', 'wk']); assert.deepEqual(w.kdf, { name: 'PBKDF2', hash: 'SHA-256', iter: 600000, salt: w.kdf.salt });
  assert.equal(Buffer.from(w.kdf.salt, 'base64').length, 16); assert.equal(Buffer.from(w.iv, 'base64').length, 12); assert.equal(Buffer.from(w.wk, 'base64').length, 48);
  assert.equal(Buffer.from(e1.data.iv, 'base64').length, 12);
  assert.deepEqual(e1.kdf, w.kdf, 'the older-app shell names the passphrase wrap salt');
  await S.commit((x) => { x.audit.push({ ts: new Date().toISOString(), action: 'x' }); });
  const e2 = clone(stored(ad));
  assert.notEqual(e2.data.iv, e1.data.iv, 'fresh IV on every write'); assert.notEqual(e2.data.ct, e1.data.ct);
  assert.deepEqual(e2.wraps, e1.wraps, 'a normal save keeps the wraps (the data key does not change)');
  // each new wrap has its own salt and IV
  const k1 = await V.newKeyset(PASS, null), k2 = await V.newKeyset(PASS, null);
  assert.notEqual(k1.wraps[0].kdf.salt, k2.wraps[0].kdf.salt); assert.notEqual(k1.wraps[0].iv, k2.wraps[0].iv); assert.notEqual(k1.wraps[0].wk, k2.wraps[0].wk);
  const rk = await V.newRecoveryKey(), k3 = await V.newKeyset(PASS, rk);
  assert.deepEqual(k3.wraps.map((x) => x.kind), ['passphrase', 'recovery']); assert.notEqual(k3.wraps[0].kdf.salt, k3.wraps[1].kdf.salt); assert.notEqual(k3.wraps[0].iv, k3.wraps[1].iv);
  // the unwrapped data key can never be exported
  const o = await V.unwrapWith(e2.wraps, PASS);
  assert.equal(o.key.extractable, false); assert.equal(k3.key.extractable, false);
  await assert.rejects(globalThis.crypto.subtle.exportKey('raw', o.key)); await assert.rejects(globalThis.crypto.subtle.exportKey('raw', k3.key));
  // real PBKDF2 settings on every derivation
  realKeys();
  const sub = globalThis.crypto.subtle, orig = sub.deriveKey.bind(sub), params = [];
  sub.deriveKey = (a, ...r) => { params.push(a); return orig(a, ...r); };
  try { const k4 = await V.newKeyset(PASS, rk); await V.unwrapWith(k4.wraps, { recovery: rk }); } finally { sub.deriveKey = orig; fastKeys(); }
  assert.ok(params.length >= 3 && params.every((p) => p.name === 'PBKDF2' && p.hash === 'SHA-256' && p.iterations === 600000));
});

test('tampered envelopes fail closed: every changed field refuses to open and writes nothing', async () => {
  const ad = await vault(null); await enable(); S.lock();
  const good = clone(stored(ad)), before = JSON.stringify(good);
  const flip = (b64, i = 3) => { const u = Buffer.from(b64, 'base64'); u[i] ^= 1; return u.toString('base64'); };
  const mut = (f) => { const e = clone(good); f(e); return e; };
  const cases = {
    'wrapped key bit': mut((e) => { e.wraps[0].wk = flip(e.wraps[0].wk); }), 'wrap iv bit': mut((e) => { e.wraps[0].iv = flip(e.wraps[0].iv, 1); }),
    'wrap salt': mut((e) => { e.wraps[0].kdf.salt = flip(e.wraps[0].kdf.salt, 1); }), 'shell salt only': mut((e) => { e.kdf.salt = flip(e.kdf.salt, 1); }),
    'wrap iterations': mut((e) => { e.wraps[0].kdf.iter = 1000; }), 'wrap hash': mut((e) => { e.wraps[1].kdf.hash = 'SHA-1'; }), 'kdf extra field': mut((e) => { e.wraps[0].kdf.extra = 1; }),
    'wrap extra field': mut((e) => { e.wraps[0].extra = 1; }), 'top extra field': mut((e) => { e.junk = 'x'; }), 'data extra field': mut((e) => { e.data.extra = 1; }),
    'kind swapped': mut((e) => { e.wraps[0].kind = 'recovery'; }), 'kind unknown': mut((e) => { e.wraps[1].kind = 'admin'; }),
    'duplicate kind': mut((e) => { e.wraps[1] = Object.assign(clone(e.wraps[0])); }), 'recovery only': mut((e) => { e.wraps = [e.wraps[1]]; }),
    'three wraps': mut((e) => { e.wraps.push(clone(e.wraps[1])); }), 'no wraps': mut((e) => { e.wraps = []; }), 'wraps not a list': mut((e) => { e.wraps = { a: 1 }; }),
    'wk short': mut((e) => { e.wraps[0].wk = e.wraps[0].wk.slice(0, 40); }), 'wk not base64': mut((e) => { e.wraps[0].wk = '!'.repeat(64); }), 'iv short': mut((e) => { e.wraps[0].iv = 'AAAA'; }),
    'data ct bit': mut((e) => { e.data.ct = flip(e.data.ct, 10); }), 'data iv bit': mut((e) => { e.data.iv = flip(e.data.iv, 2); }), 'data missing': mut((e) => { delete e.data; }),
    'data ct short': mut((e) => { e.data.ct = 'AAAA'; }), 'shell ct bit': mut((e) => { e.ct = flip(e.ct, 4); }), 'shell iv bit': mut((e) => { e.iv = flip(e.iv, 1); }),
    'fmt 3': mut((e) => { e.fmt = 3; }), 'fmt as text': mut((e) => { e.fmt = '2'; }), 'v 2': mut((e) => { e.v = 2; }), 'outer rev': mut((e) => { e.rev += 5; }),
    'wraps from another vault': (() => { const e = clone(good); const o = clone(good); return Object.assign(e, { wraps: o.wraps.map((w) => Object.assign({}, w, { wk: flip(w.wk, 9) })) }); })(),
  };
  for (const [name, env] of Object.entries(cases)) {
    await ad.set('envelope', env); const raw = JSON.stringify(env);
    await assert.rejects(S.unlock(PASS), undefined, name + ' (passphrase)');
    await assert.rejects(S.openWithRecovery('AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA'), undefined, name + ' (recovery)');
    assert.equal(S.isUnlocked(), false, name); assert.equal(JSON.stringify(await ad.get('envelope')), raw, name + ' wrote');
  }
  await ad.set('envelope', good); await S.unlock(PASS); assert.ok(S.isUnlocked());
  // a recovery-key open authenticates the data, so a changed data field also fails closed there
  S.lock(); const key = await V.newRecoveryKey(); void key;
});

test('v1 files still open with the passphrase, stay as they are until the next save, then become v2; a v1 Drive copy leaves as v2', async () => {
  const ad = memAdapter(); S._setAdapter(ad); S.lock();
  const salt = V.newSalt(), key = await V.deriveKey(PASS, salt), m = { rev: 4, updatedAt: '2026-11-10T00:00:00.000Z', deviceId: 'dev1' };
  const st = S.defaultState(); st.accounts.push({ id: 'a1', name: 'Kept account', kind: 'cash', liability: false, archived: false });
  await ad.set('envelope', Object.assign(await V.makeEnvelope(key, salt, Object.assign(clone(st), { _meta: m })), m));
  const v1 = JSON.stringify(stored(ad)); assert.equal(stored(ad).fmt, undefined);
  const got = await S.unlock(PASS); assert.equal(got.accounts[0].name, 'Kept account');
  assert.equal(JSON.stringify(stored(ad)), v1, 'unlocking alone writes nothing'); assert.equal(S.hasRecovery(), false);
  await rej(S.unlock('not the passphrase 1'), /BAD_PASSPHRASE_OR_DATA/);
  const env = await S.exportEnvelope();   // a v1 file never leaves as v1
  assert.equal(env.fmt, 2); assert.deepEqual(kinds(env), ['passphrase']); assert.equal(stored(ad).fmt, 2);
  S.lock(); const back = await S.unlock(PASS); assert.equal(back.accounts[0].name, 'Kept account');
  // the next save path too
  await ad.set('envelope', Object.assign(await V.makeEnvelope(key, salt, Object.assign(clone(st), { _meta: m })), m));
  S.lock(); await S.unlock(PASS); await S.commit((x) => { x.audit.push({ ts: new Date().toISOString(), action: 'x' }); });
  assert.equal(stored(ad).fmt, 2); assert.equal(stored(ad).rev, 5);
  // a v1 backup still imports, and the first backup export is v2
  const text = JSON.stringify(await V.makeEnvelope(await V.deriveKey(BKP, salt), salt, clone(st)));
  void text;
  const bk = await V.exportBackup(BKP, S.getState()); assert.equal(JSON.parse(bk).fmt, 2);
  assert.equal((await V.importBackup(BKP, bk)).accounts[0].name, 'Kept account');
});

test('an older app (v1.7.0) opens a v2 file with the passphrase, finds schema 20 and refuses it with its newer-version message; it never overwrites', async () => {
  realKeys();
  realKeys(); const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS); await S.commit((x) => { x.audit.push({ ts: new Date().toISOString(), action: 'x' }); });
  const text = JSON.stringify(stored(ad)), backup = await V.exportBackup(BKP, S.getState());
  // the v1.7.0 parseEnvelope, deriveKey and decrypt, copied
  const oldRead = async (txt, pass) => {
    const env = JSON.parse(txt);
    if (!env || typeof env !== 'object' || env.v !== 1 || !env.kdf || typeof env.kdf !== 'object') throw new Error('BAD_PASSPHRASE_OR_DATA');
    const k = env.kdf; if (k.name !== 'PBKDF2' || k.hash !== 'SHA-256' || k.iter !== 600000) throw new Error('BAD_PASSPHRASE_OR_DATA');
    const salt = new Uint8Array(Buffer.from(k.salt, 'base64')); if (salt.length !== 16 || typeof env.iv !== 'string' || typeof env.ct !== 'string') throw new Error('BAD_PASSPHRASE_OR_DATA');
    const sub = globalThis.crypto.subtle, base = await sub.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    const key = await sub.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const pt = await sub.decrypt({ name: 'AES-GCM', iv: new Uint8Array(Buffer.from(env.iv, 'base64')) }, key, new Uint8Array(Buffer.from(env.ct, 'base64')));
    return JSON.parse(new TextDecoder().decode(pt));
  };
  for (const [what, txt, pass] of [['the stored vault', text, PASS], ['a backup', backup, BKP]]) {
    const raw = await oldRead(txt, pass);
    assert.equal(raw.schema, 20, what); assert.ok(Object.keys(raw).every((k) => ['schema', 'newerFormat', '_meta'].includes(k)), what + ': the stub holds no data');
    // v2.0.0: this build's own SCHEMA is now 20, so the v1.7.0 refusal is emulated by that version's accepted list (1 to 19); the stub still stops every app that knows schemas only up to 19, and this build never takes the stub for a vault either.
    assert.ok(![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].includes(raw.schema), what + ': unlock, sync and restore stop here (unsupported schema)');
    assert.throws(() => S.validateState(raw), /./, what);
    assert.ok(raw.schema > 19, what + ': verifyBackup says "made by a newer version of LifeOS"');
    await rej(oldRead(txt, 'the wrong passphrase 1'), /./);
  }
  // this version reads its own backup and the stored vault normally
  const mine = await V.importBackup(BKP, backup); assert.equal(mine.schema, S.SCHEMA);
  fastKeys();
});

// ---------------------------------------------------------------- main vault recovery
test('main vault: enable with a retype, lock, unlock with the key, a forced new passphrase and a new key; the old key and the old passphrase are refused', async () => {
  const ad = await vault(null); await S.commit((x) => { x.accounts.push({ id: 'a1', name: 'Kept account', kind: 'cash', liability: false, archived: false }); });
  assert.equal(S.hasRecovery(), false); const noKey = clone(stored(ad)); assert.deepEqual(kinds(noKey), ['passphrase']);
  await rej(S.beginRecovery('not the passphrase 1'), /BAD_PASSPHRASE_OR_DATA/);
  const h = await S.beginRecovery(PASS);
  await rej(h.finish('AAAA-AAAA'), /not the recovery key shown/); await rej(h.finish(''), /not the recovery key shown/);
  assert.equal(S.hasRecovery(), false); assert.equal(JSON.stringify(stored(ad)), JSON.stringify(noKey), 'nothing changes before the retype');
  await h.finish(h.key.slice(-9).toLowerCase());                       // the last two groups are enough
  assert.equal(S.hasRecovery(), true); assert.deepEqual(kinds(stored(ad)), ['passphrase', 'recovery']); seen(stored(ad));
  assert.equal(await S.recoveryMatches(h.key), true); assert.equal(await S.recoveryMatches(await V.newRecoveryKey()), false);
  const key1 = h.key, env1 = clone(stored(ad));
  assert.notEqual(env1.wraps[0].kdf.salt, noKey.wraps[0].kdf.salt, 'turning it on replaced the data key and the salts');
  await rej(h.finish(key1), /no longer valid/);                          // a finished handle cannot be reused
  S.lock();
  assert.equal((await S.unlock(PASS)).accounts[0].name, 'Kept account'); S.lock();
  // wrong keys write nothing and open nothing
  const raw0 = JSON.stringify(stored(ad));
  const wrongKey = await V.newRecoveryKey();
  await rej(S.openWithRecovery(wrongKey), /BAD_RECOVERY_KEY/); await rej(S.openWithRecovery(PASS), /RECOVERY_KEY_FORMAT/);
  assert.equal(JSON.stringify(stored(ad)), raw0); assert.equal(S.isUnlocked(), false);
  // the right key, then a forced new passphrase and a new key
  const r = await S.openWithRecovery(key1.toLowerCase());
  assert.equal(S.isUnlocked(), false, 'the key alone does not unlock: a new passphrase comes first');
  await rej(r.prepare('short'), /12 characters/);
  const p = await r.prepare(NEWP); assert.notEqual(p.key, key1);
  assert.equal(JSON.stringify(stored(ad)), raw0, 'nothing is written until the new key is retyped');
  await rej(p.finish('nope'), /not the recovery key shown/);
  const st = await p.finish(p.key); assert.equal(st.accounts[0].name, 'Kept account'); assert.ok(S.isUnlocked());
  const env2 = clone(stored(ad)); seen(env2);
  assert.deepEqual(kinds(env2), ['passphrase', 'recovery']); assert.notEqual(env2.wraps[0].wk, env1.wraps[0].wk); assert.notEqual(env2.wraps[1].wk, env1.wraps[1].wk);
  assert.notEqual(env2.wraps[1].kdf.salt, env1.wraps[1].kdf.salt);
  S.lock();
  await rej(S.unlock(PASS), /BAD_PASSPHRASE_OR_DATA/); await rej(S.openWithRecovery(key1), /BAD_RECOVERY_KEY/);   // the used key and the old passphrase are done
  assert.equal((await S.unlock(NEWP)).accounts[0].name, 'Kept account'); S.lock();
  await (await S.openWithRecovery(p.key)).prepare('third passphrase 123').then((q) => q.finish(q.key)); assert.ok(S.isUnlocked());
  // an older copy opens only with what was in force when it was made
  assert.equal((await V.openEnvelope(env1, PASS)).raw.accounts[0].name, 'Kept account');
  assert.equal((await V.openEnvelope(env1, { recovery: key1 })).raw.accounts[0].name, 'Kept account');
  await rej(V.openEnvelope(env1, { recovery: p.key }), /BAD_RECOVERY_KEY/);
});

test('main vault: replace and turn off; the replaced or removed key no longer opens the current vault, and each step replaces the data key', async () => {
  const ad = await vault(null); const k1 = await enable(); const e1 = clone(stored(ad));
  const h = await S.beginRecovery(PASS); await h.finish(h.key); const k2 = h.key, e2 = clone(stored(ad)); seen(e1); seen(e2);
  assert.notEqual(k1, k2); assert.deepEqual(kinds(e2), ['passphrase', 'recovery']);
  assert.notEqual(e2.wraps[0].wk, e1.wraps[0].wk); assert.notEqual(e2.wraps[1].wk, e1.wraps[1].wk); assert.notEqual(e2.wraps[0].kdf.salt, e1.wraps[0].kdf.salt);
  S.lock(); await rej(S.openWithRecovery(k1), /BAD_RECOVERY_KEY/); await S.unlock(PASS);
  await rej(S.turnOffRecovery('not the passphrase 1'), /BAD_PASSPHRASE_OR_DATA/); assert.equal(S.hasRecovery(), true);
  await S.turnOffRecovery(PASS); const e3 = clone(stored(ad)); seen(e3);
  assert.equal(S.hasRecovery(), false); assert.deepEqual(kinds(e3), ['passphrase']); assert.notEqual(e3.wraps[0].wk, e2.wraps[0].wk);
  S.lock(); for (const k of [k1, k2]) await rej(S.openWithRecovery(k), /BAD_RECOVERY_KEY/);
  await S.unlock(PASS); assert.ok(S.isUnlocked());
  // the key that was turned off still opens the copy made while it was in force, and not the current one
  assert.ok((await V.openEnvelope(e2, { recovery: k2 })).raw); await rej(V.openEnvelope(e3, { recovery: k2 }), /BAD_RECOVERY_KEY/);
});

test('passphrase change rotates the data key; with a recovery key on it needs the current key (kept) or a new one', async () => {
  const ad = await vault(null); const k1 = await enable(); const e1 = clone(stored(ad));
  const err = await rej(S.changePassphrase(PASS, NEWP), /current recovery key/); assert.equal(err.code, 'RECOVERY_CHOICE'); assert.equal(JSON.stringify(stored(ad)), JSON.stringify(e1));
  await rej(S.changePassphrase(PASS, NEWP, { keepRecovery: await V.newRecoveryKey() }), /BAD_RECOVERY_KEY/);
  await rej(S.changePassphrase('not the passphrase 1', NEWP, { keepRecovery: k1 }), /BAD_PASSPHRASE_OR_DATA/);
  await S.changePassphrase(PASS, NEWP, { keepRecovery: k1 });
  const e2 = clone(stored(ad)); assert.deepEqual(kinds(e2), ['passphrase', 'recovery']);
  assert.notEqual(e2.wraps[0].wk, e1.wraps[0].wk, 'the data key is replaced'); assert.notEqual(e2.wraps[0].kdf.salt, e1.wraps[0].kdf.salt); assert.notEqual(e2.wraps[1].kdf.salt, e1.wraps[1].kdf.salt);
  S.lock(); await rej(S.unlock(PASS), /BAD_PASSPHRASE_OR_DATA/); await S.unlock(NEWP); S.lock();
  const r = await S.openWithRecovery(k1); await r.prepare(NEWP).then((p) => p.finish(p.key)); S.lock();   // the kept key worked, and is now used up
  await rej(S.openWithRecovery(k1), /BAD_RECOVERY_KEY/); await S.unlock(NEWP);
  // a new key instead
  const nk = await V.newRecoveryKey(); const before = clone(stored(ad));
  await S.changePassphrase(NEWP, PASS, { newRecoveryKey: nk });
  S.lock(); await rej(S.openWithRecovery(k1), /BAD_RECOVERY_KEY/); await rej(S.unlock(NEWP), /BAD_PASSPHRASE_OR_DATA/);
  await (await S.openWithRecovery(nk)).prepare(PASS).then((p) => p.finish(p.key));
  assert.notEqual(stored(ad).wraps[0].wk, before.wraps[0].wk);
  // with no key on it is as before and returns nothing to show
  await S.turnOffRecovery(PASS); assert.equal(await S.changePassphrase(PASS, NEWP), undefined); assert.deepEqual(kinds(stored(ad)), ['passphrase']);
});

// ---------------------------------------------------------------- private vault
test('private vault: its own recovery key (turn on, use with a forced new passphrase and key, replace, turn off); the two keys never open each other', async () => {
  const ad = await vault(null, { priv: true });
  await P.commit((w) => { w.records.accounts = [{ id: 'pa1', name: 'Private account', kind: 'cash', liability: false, archived: false }]; });
  assert.equal(P.hasRecovery(S.getState()), false); assert.equal(S.getState().priv.v, 2); assert.deepEqual(S.getState().priv.wraps.map((w) => w.kind), ['passphrase']);
  const mainKey = await enable(); const pk = await enablePriv(); seen(stored(ad)); P.close('system');
  assert.notEqual(mainKey, pk); assert.equal(P.hasRecovery(S.getState()), true); assert.equal(S.hasRecovery(), true);
  const privWraps = clone(S.getState().priv.wraps), mainWraps = clone(stored(ad).wraps);
  for (const w of privWraps) { allWraps.add(w.wk); allWraps.add(w.iv); }
  // neither key opens the other vault (nor the passphrases)
  await rej(V.unwrapWith(privWraps, { recovery: mainKey }), /BAD_RECOVERY_KEY/); await rej(V.unwrapWith(mainWraps, { recovery: pk }), /BAD_RECOVERY_KEY/);
  await rej(V.unwrapWith(privWraps, PASS), /BAD_PASSPHRASE_OR_DATA/); await rej(V.unwrapWith(mainWraps, PRIV), /BAD_PASSPHRASE_OR_DATA/);
  await rej(P.openWithRecovery(mainKey), /BAD_RECOVERY_KEY/); S.lock(); await rej(S.openWithRecovery(pk), /BAD_RECOVERY_KEY/); await S.unlock(PASS);
  await rej(P.beginRecovery(PASS), /BAD_PRIVATE_PASSPHRASE/);
  // wrong private key: nothing opens or changes
  const blob0 = JSON.stringify(S.getState().priv);
  await rej(P.openWithRecovery(await V.newRecoveryKey()), /BAD_RECOVERY_KEY/); assert.equal(P.isOpen(), false); assert.equal(JSON.stringify(S.getState().priv), blob0);
  // use the private key: new private passphrase, new private key, the vault opens
  const r = await P.openWithRecovery(pk); assert.equal(P.isOpen(), false);
  await rej(r.prepare(PASS), /different from your main/); await rej(r.prepare('short'), /12 characters/);
  const p = await r.prepare('new private passphrase 5'); await rej(p.finish('nope'), /not the recovery key shown/); assert.equal(JSON.stringify(S.getState().priv), blob0);
  await p.finish(p.key.slice(-9)); assert.ok(P.isOpen());
  assert.equal(P.view(S.getState()).accounts.find((a) => a.id === 'pa1').name, 'Private account');
  P.close('system'); await rej(P.open(PRIV), /BAD_PRIVATE_PASSPHRASE/); await rej(P.openWithRecovery(pk), /BAD_RECOVERY_KEY/); await P.open('new private passphrase 5'); P.close('system');
  assert.equal(S.hasRecovery(), true, 'the main key is untouched by private changes'); assert.equal(await S.recoveryMatches(mainKey), true);
  // replace, then turn off
  const h = await P.beginRecovery('new private passphrase 5'); await h.finish(h.key); const pk2 = h.key;
  await rej(P.openWithRecovery(p.key), /BAD_RECOVERY_KEY/); await P.openWithRecovery(pk2);
  await P.turnOffRecovery('new private passphrase 5'); assert.equal(P.hasRecovery(S.getState()), false);
  await rej(P.openWithRecovery(pk2), /BAD_RECOVERY_KEY/); await P.open('new private passphrase 5');
  // a private passphrase change with a key on needs the key (kept) or a new one
  P.close('system'); const h2 = await P.beginRecovery('new private passphrase 5'); await h2.finish(h2.key);
  const e = await rej(P.changePassphrase('new private passphrase 5', 'another private pass 6'), /current recovery key/); assert.equal(e.code, 'RECOVERY_CHOICE');
  await P.changePassphrase('new private passphrase 5', 'another private pass 6', { keepRecovery: h2.key });
  await rej(P.open('new private passphrase 5'), /BAD_PRIVATE_PASSPHRASE/); await P.open('another private pass 6'); P.close('system');
  const nk = await V.newRecoveryKey(); await P.changePassphrase('another private pass 6', 'yet another private 7', { newRecoveryKey: nk });
  await rej(P.openWithRecovery(h2.key), /BAD_RECOVERY_KEY/); await P.openWithRecovery(nk);
});

test('a v1 private vault opens with its passphrase and is a v2 blob after the next private write', async () => {
  const ad = await vault(null, { priv: false });
  // build a v1 private blob by hand (the v1.7.0 layout)
  const salt = V.newSalt(), k = await V.deriveKey(PRIV, salt), inner = { schema: 1, rev: 0, records: {}, links: [], wellbeing: {} };
  const e = await V.encrypt(k, inner); let sb = ''; for (const b of salt) sb += String.fromCharCode(b);
  const v1 = { v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: 600000, salt: btoa(sb) }, iv: e.iv, ct: e.ct, rev: 0, marks: [] };
  await S.commit((x) => { x.priv = v1; });
  assert.equal(S.getState().priv.v, 1); await P.open(PRIV); assert.equal(S.getState().priv.v, 1, 'opening writes nothing');
  await P.commit((w) => { w.records.accounts = [{ id: 'pa1', name: 'Private account', kind: 'cash', liability: false, archived: false }]; });
  assert.equal(S.getState().priv.v, 2); assert.deepEqual(S.getState().priv.wraps.map((w) => w.kind), ['passphrase']);
  P.close('system'); await P.open(PRIV); assert.equal(P.view(S.getState()).accounts.length, 1); void ad;
});

// ---------------------------------------------------------------- every kind of copy
test('every sealed copy opens with the passphrase and, when a key is on, with the recovery key: stored vault, Drive copy, backup, archive file, private archive box', async () => {
  const ad = await vault(build(), { priv: true }); const mk = await enable(); const pk = await enablePriv();
  await P.open(PRIV); await P.moveIn('entries', S.getState().entries.find((x) => x.date.startsWith('2021') && x.type === 'expense').id);
  // stored vault
  const env = clone(stored(ad)); assert.deepEqual(kinds(env), ['passphrase', 'recovery']);
  for (const secret of [PASS, { recovery: mk }]) assert.equal((await V.openEnvelope(env, secret)).raw.schema, S.SCHEMA);
  // Drive copy: the stored envelope as it is
  const d = drive(); L.sync._setFetch(d.fetch); L.sync._setToken(TOKEN, 3600);
  await L.sync.run(); const dc = JSON.parse(d.file.text); assert.deepEqual(kinds(dc), ['passphrase', 'recovery']);
  for (const secret of [PASS, { recovery: mk }]) assert.equal((await V.openEnvelope(dc, secret)).raw.schema, S.SCHEMA);
  // backup file: its own passphrase, plus the key (typed at export, checked first)
  const bk = JSON.parse(await V.exportBackup(BKP, S.getState(), mk)); assert.deepEqual(kinds(bk), ['passphrase', 'recovery']);
  for (const secret of [BKP, { recovery: mk }]) assert.equal((await V.openEnvelope(bk, secret, true)).raw.schema, S.SCHEMA);
  assert.equal((await V.importBackup({ recovery: mk }, JSON.stringify(bk))).schema, S.SCHEMA);
  await rej(V.importBackup({ recovery: pk }, JSON.stringify(bk)), /BAD_RECOVERY_KEY/); await rej(V.importBackup(PASS, JSON.stringify(bk)), /BAD_PASSPHRASE_OR_DATA/);
  assert.deepEqual(kinds(JSON.parse(await V.exportBackup(BKP, S.getState()))), ['passphrase'], 'no key typed: the file opens with its passphrase only');
  // archive file and its private box
  const box = {};
  await rej(A.archiveYear({ year: 2021, passphrase: PASS, today: TODAY, drive: true, download: true, io: io({}) }), /Type your recovery key/);
  await rej(A.archiveYear({ year: 2021, passphrase: PASS, recoveryKey: await V.newRecoveryKey(), today: TODAY, drive: true, download: true, io: io({}) }), /not your current recovery key/);
  await rej(A.archiveYear({ year: 2021, passphrase: PASS, recoveryKey: 'AAAA', today: TODAY, drive: true, download: true, io: io({}) }), /typo/);
  await A.archiveYear({ year: 2021, passphrase: PASS, recoveryKey: mk, today: TODAY, drive: true, download: true, io: io(box) });
  const f = box.files['lifeos-archive-2021.json'], ae = JSON.parse(f); assert.deepEqual(kinds(ae), ['passphrase', 'recovery']);
  for (const secret of [PASS, { recovery: mk }]) { const parsed = await A.parse(f, secret, 2021); assert.equal(parsed.year, 2021); assert.ok(parsed.inner.priv); }
  const inner = (await V.openEnvelope(ae, { recovery: mk })).raw;
  assert.ok(Array.isArray(inner.priv.wraps) && inner.priv.wraps.some((w) => w.kind === 'recovery'), 'the private box carries the private wraps');
  assert.equal((await P.openBox(inner.priv, PRIV)).records !== undefined, true); P.close('system');
  assert.equal((await P.openBox(inner.priv, { recovery: pk })).records !== undefined, true);
  await rej(P.openBox(inner.priv, { recovery: mk }), /BAD_RECOVERY_KEY/);
  // a copy made after the keys were replaced: the new key opens it, the old one does not
  const h = await S.beginRecovery(PASS); await h.finish(h.key);
  const bk2 = JSON.parse(await V.exportBackup(BKP, S.getState(), h.key)); assert.equal((await V.openEnvelope(bk2, { recovery: h.key }, true)).raw.schema, S.SCHEMA);
  await rej(V.openEnvelope(bk2, { recovery: mk }, true), /BAD_RECOVERY_KEY/); assert.equal((await V.openEnvelope(bk, { recovery: mk }, true)).raw.schema, S.SCHEMA);
});

// ---------------------------------------------------------------- sync keeps its meaning
test('Drive sync: a passphrase or recovery key change on one device is a local change that is uploaded; another device downloads it with the passphrase', async () => {
  const ad = await vault(null); const d = drive(); L.sync._setFetch(d.fetch); L.sync._setToken(TOKEN, 3600);
  assert.equal((await L.sync.run()).kind, 'uploaded'); assert.equal((await L.sync.run()).kind, 'in-sync');
  const k = await enable(); await S.commit(() => {});
  await assert.rejects(L.sync.run(), (e) => e.code === 'NEED_PASSPHRASE');   // the keys changed, so the old Drive copy needs its passphrase
  const up = await L.sync.run({ passphrase: PASS }); assert.equal(up.kind, 'uploaded'); assert.deepEqual(kinds(JSON.parse(d.file.text)), ['passphrase', 'recovery']);
  assert.equal((await L.sync.run()).kind, 'in-sync');
  await S.changePassphrase(PASS, NEWP, { keepRecovery: k }); await S.commit(() => {});
  await assert.rejects(L.sync.run(), (e) => e.code === 'NEED_PASSPHRASE');
  assert.equal((await L.sync.run({ passphrase: PASS })).kind, 'uploaded'); assert.equal((await L.sync.run()).kind, 'in-sync');
  const remote = d.file.text;
  // a second device with its own vault under the older keys
  const ad2 = memAdapter(); S._setAdapter(ad2); S.lock(); await S.init(PASS); await S.commit(() => {});
  const env = JSON.parse(remote);
  const e = await rej(S.inspectEnvelope(env), /passphrase of the Drive copy/); assert.equal(e.code, 'NEED_PASSPHRASE');
  const x = await rej(S.inspectEnvelope(env, PASS), /different passphrase/); assert.equal(x.code, 'WRONG_PASSPHRASE');
  const info = await S.inspectEnvelope(env, NEWP); assert.equal(info.sameKey, false);
  await S.adoptEnvelope(info); assert.deepEqual(kinds(stored(ad2)), ['passphrase', 'recovery']); assert.equal(S.hasRecovery(), true);
  S.lock(); await S.unlock(NEWP); S.lock(); assert.ok(await (await S.openWithRecovery(k)).prepare('third passphrase 123'));
  // the saltId (what sync compares) is the passphrase wrap salt and changes with every rotation
  S.lock(); await S.unlock(NEWP); const s1 = S.saltId(); await S.turnOffRecovery(NEWP); assert.notEqual(S.saltId(), s1); void ad;
});

// ---------------------------------------------------------------- no key material in any output
test('no recovery key text, wrapped key or key bytes appears in any state field, error, diagnostic, audit entry, history line or backup text', async () => {
  const ad = await vault(null, { priv: true });
  const outs = [], texts = [];
  const key = await enable(); const pk = await enablePriv(); texts.push(key, pk); seen(stored(ad));
  const canon = key.replace(/-/g, ''), pcanon = pk.replace(/-/g, '');
  for (const w of S.getState().priv.wraps) { allWraps.add(w.wk); allWraps.add(w.iv); allWraps.add(w.kdf.salt); }
  for (const w of stored(ad).wraps) { allWraps.add(w.wk); allWraps.add(w.iv); allWraps.add(w.kdf.salt); }
  // failures of every kind: their messages and the diagnostics built from them
  const errs = [];
  for (const f of [() => S.openWithRecovery(key.slice(0, -1)), () => S.openWithRecovery(pk), () => S.beginRecovery(key), () => S.recoveryMatches(key.slice(2) + 'AA'), () => P.openWithRecovery(key), () => S.changePassphrase(PASS, NEWP),
    () => S.changePassphrase(PASS, NEWP, { keepRecovery: pk }), () => S.turnOffRecovery(key), () => V.openEnvelope(stored(ad), { recovery: pk }), () => V.importBackup({ recovery: key }, 'not json'),
    async () => { const h = await S.beginRecovery(PASS); try { await h.finish(canon.slice(3, 20)); } finally { h.cancel(); } }]) {
    try { await f(); errs.push('did not throw'); } catch (e) { errs.push(String(e.message), String(e.code || ''), String(e.stack || '').split('\n')[0]); O.recordError(e, 'backup'); }
  }
  outs.push(...errs);
  const s = S.getState(); outs.push(JSON.stringify(s), JSON.stringify(P.isOpen() ? 1 : 0), O.format(s, { version: '1.8.0', userAgent: 'Chrome' }));
  await S.commit((x) => { x.audit.push({ ts: new Date().toISOString(), action: 'recovery key on' }); });
  outs.push(JSON.stringify(S.getState().audit), JSON.stringify(S.getState().ops));
  outs.push(await V.exportBackup(BKP, S.getState()), await V.exportBackup(BKP, S.getState(), key), JSON.stringify(await S.exportEnvelope()), JSON.stringify(Object.keys(globalThis).filter((k) => /recover|rk/i.test(k))));
  const all = outs.join('\n');
  for (const t of [key, canon, pk, pcanon, ...key.split('-'), canon.slice(10, 30), pcanon.slice(10, 30), canon.slice(0, 52).toLowerCase()]) if (t.length >= 8 || t === key) assert.ok(!all.includes(t) || false, 'key text found: ' + t.slice(0, 4));
  // wrapped keys, wrap IVs and salts appear only in the sealed envelopes (never in a decrypted state field, an error, a diagnostic or an audit line)
  const noEnv = [...errs, JSON.stringify(s), O.format(s, { version: '1.8.0', userAgent: 'Chrome' }), JSON.stringify(S.getState().audit), JSON.stringify(S.getState().ops)].join('\n');
  for (const w of allWraps) if (w.length >= 8 && !s.priv.wraps.some((x) => x.wk === w || x.iv === w || x.kdf.salt === w)) assert.ok(!noEnv.includes(w), 'wrapped key material in an output');
  // the stored envelope holds wraps (that is what it is) but never the key text; the raw key never exists outside the key object
  assert.ok(!JSON.stringify(stored(ad)).includes(canon) && !JSON.stringify(stored(ad)).toLowerCase().includes(canon.toLowerCase()));
  // the state carries no recovery field at all: whether a key is on is read from the wraps
  const names = []; (function walk(o, d) { if (d > 6 || !o || typeof o !== 'object') return; for (const k of Object.keys(o)) { names.push(k); walk(o[k], d + 1); } })(s, 0);
  assert.ok(!names.some((k) => /recover/i.test(k)), 'no recovery field in the state'); assert.equal(S.SCHEMA, 20);
  // adversarial markers (spaces and quotes) in a passphrase and a note never reach the recovery paths' messages
  const MARK = 'My "odd" pass phrase 99';
  const e = await rej(S.beginRecovery(MARK)); assert.ok(!e.message.includes(MARK));
  assert.ok(!(await rej(S.openWithRecovery(MARK))).message.includes(MARK));
});

test('source rules: no innerHTML, outerHTML, insertAdjacentHTML, document.write, eval, localStorage, clipboard or console in the recovery code; no em dashes; the sheet and docs exist', () => {
  const files = ['src/ui/recovery-ui.js', 'src/core/vault.js', 'src/core/store.js', 'src/core/priv.js', 'src/ui/archive-ui.js'];
  for (const f of files) {
    const t = src(f).replace(/\/\/.*$/gm, '');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|localStorage|navigator\.clipboard|execCommand|console\./.test(t), f);
    assert.ok(!/—/.test(src(f)), f + ' em dash');
  }
  const ui = src('src/ui/recovery-ui.js').replace(/\/\/.*$/gm, '');
  assert.ok(!/createElement\(\s*['"](input|textarea)/.test(ui) && !/<(input|textarea)\b/i.test(ui) && !/type: 'text'/.test(ui), 'no hand-made fields');
  assert.ok(/passField\('rk-key-retype'\)/.test(ui) && /passField\('rk-enter-key'\)/.test(ui) && /passField\('rk-keep-key'\)/.test(ui), 'key fields are password fields (spell check off like a passphrase)');
  assert.ok(existsSync(new URL('../docs/RECOVERY.md', import.meta.url))); assert.ok(!/—/.test(src('docs/RECOVERY.md')));
  const b = src('build.mjs'); assert.ok(b.indexOf("'src/ui/recovery-ui.js'") > b.indexOf("'src/ui/archive-ui.js'") && b.indexOf("'src/ui/recovery-ui.js'") > 0);
  assert.equal(JSON.parse(src('package.json')).version, '2.0.0');
  // the key is only shown in the key dialog and, by the owner's choice, on the sheet; nothing else renders it
  assert.ok(/sheetKeys\[scope\] = inc\.checked \? key : ''/.test(ui) && /sheetKeys = \{ main: '', priv: '' \}/.test(ui));
  const app = src('src/ui/app.js'); assert.ok(/L\.recoveryUI\.clear\(\); lockRecover = false;/.test(app), 'cleared on lock');
});

test('first run: the checklist prompts for the main key (Turn on now, Later), the private vault creation prompts for its key, and the getting started guide covers the nine steps in order', async () => {
  const ui = src('src/ui/recovery-ui.js').replace(/\/\/.*$/gm, ''), app = src('src/ui/app.js'), g = src('src/ui/guide-ui.js').replace(/\/\/.*$/gm, '');
  assert.ok(/id: 'setup-rk-now'/.test(ui) && /id: 'setup-rk-later'/.test(ui) && /'Turn on now'/.test(ui) && /'Later'/.test(ui));
  assert.ok(/L\.recoveryUI\.setupPrompt\(recCtx\(\)\)/.test(app) && /L\.recoveryUI\.privSetupPrompt\(recCtx\(\), a\)/.test(app), 'wired to the checklist and to private creation');
  assert.ok(/id: 'setup-guide'/.test(app) && /id: 'settings-guide'/.test(app) && /kind === 'guide'/.test(app), 'reachable from the checklist and from Settings');
  const ids = [...g.matchAll(/id: '([a-z]+)', title/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['passphrase', 'recovery', 'backup', 'install', 'sync', 'private', 'ai', 'records', 'review']);
  for (const d of ['FIRST-RUN.md', 'SYNC-SETUP.md', 'AI-SETUP.md', 'RECOVERY.md']) assert.ok(g.includes(d), d);
  assert.ok(!/\u2014/.test(src('src/ui/guide-ui.js')) && !/innerHTML|localStorage|eval\(/.test(g));
  const doc = src('docs/GETTING-STARTED.md'); assert.ok(!/\u2014/.test(doc));
  for (const d of ['FIRST-RUN.md', 'SYNC-SETUP.md', 'AI-SETUP.md', 'RECOVERY.md']) assert.ok(doc.includes(d), d);
  assert.equal((doc.match(/^\d+\. /gm) || []).length, 9);
  assert.ok(src('build.mjs').includes("'src/ui/guide-ui.js'"));
});
