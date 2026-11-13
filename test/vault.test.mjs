import { test } from 'node:test';
import assert from 'node:assert/strict';
import { L, PASS } from './_load.mjs';

const salt = L.vault.newSalt();
const key = await L.vault.deriveKey(PASS, salt);

test('salt is 16 random bytes', () => {
  assert.equal(salt.length, 16);
  assert.notDeepEqual([...L.vault.newSalt()], [...salt]);
});
test('encrypt/decrypt round trip', async () => {
  const obj = { a: 1, b: ['x', { c: true }], u: 'héllo' };
  assert.deepEqual(await L.vault.decrypt(key, await L.vault.encrypt(key, obj)), obj);
});
test('key is non-extractable', async () => {
  assert.equal(key.extractable, false);
  await assert.rejects(globalThis.crypto.subtle.exportKey('raw', key));
});
test('wrong passphrase fails', async () => {
  const box = await L.vault.encrypt(key, { a: 1 });
  const other = await L.vault.deriveKey('another passphrase!', salt);
  await assert.rejects(L.vault.decrypt(other, box), { message: 'BAD_PASSPHRASE_OR_DATA' });
});
test('IV differs per encrypt', async () => {
  const a = await L.vault.encrypt(key, { a: 1 }), b = await L.vault.encrypt(key, { a: 1 });
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
  assert.equal(Buffer.from(a.iv, 'base64').length, 12);
});
test('tampered ciphertext fails', async () => {
  const box = await L.vault.encrypt(key, { a: 1 });
  const raw = Buffer.from(box.ct, 'base64'); raw[0] ^= 1;
  await assert.rejects(L.vault.decrypt(key, { iv: box.iv, ct: raw.toString('base64') }), { message: 'BAD_PASSPHRASE_OR_DATA' });
  await assert.rejects(L.vault.decrypt(key, { iv: 'AAAA', ct: box.ct }), { message: 'BAD_PASSPHRASE_OR_DATA' });
  await assert.rejects(L.vault.decrypt(key, null), { message: 'BAD_PASSPHRASE_OR_DATA' });
});
test('backup round trip, fresh salt per export, wrong passphrase fails', async () => {
  const st = L.store.defaultState();
  // Flake root cause: this used to look for the title 'Run' in the backup text. The text is base64 of random
  // ciphertext, so any three letters turn up by chance (about 0.5% of runs, seen as a rare failure). The marker
  // below contains spaces and punctuation, which are outside the base64 alphabet and so can never appear by chance.
  const MARK = 'Plain text: run, 5 km!';
  st.entries.push(L.metrics.validateEntry({ domain: 'health', type: 'workout', date: '2026-11-10', title: MARK }));
  const a = await L.vault.exportBackup(PASS, st), b = await L.vault.exportBackup(PASS, st);
  assert.notEqual(JSON.parse(a).kdf.salt, JSON.parse(b).kdf.salt);
  assert.equal(JSON.parse(a).kdf.iter, 600000);
  assert.ok(!a.includes(MARK) && !a.includes('Plain text'));
  assert.deepEqual(await L.vault.importBackup(PASS, a), st);
  await assert.rejects(L.vault.importBackup('wrong passphrase!!', a), { message: 'BAD_PASSPHRASE_OR_DATA' });
  await assert.rejects(L.vault.importBackup(PASS, 'not json'));
  const env = JSON.parse(a); env.kdf.iter = 1;
  await assert.rejects(L.vault.importBackup(PASS, JSON.stringify(env)));
});
test('backup export rejects short passphrase', async () => {
  await assert.rejects(L.vault.exportBackup('short', L.store.defaultState()), /12 characters/);
});
