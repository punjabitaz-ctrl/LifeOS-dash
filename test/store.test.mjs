import { test } from 'node:test';
import assert from 'node:assert/strict';
import { L, memAdapter, PASS } from './_load.mjs';

const S = L.store;
test('no IndexedDB adapter is created at import time in Node', async () => {
  await assert.rejects(S.exists(), { message: 'NO_STORAGE' });
});
test('init / lock / unlock / commit / changePassphrase', async () => {
  const ad = memAdapter(); S._setAdapter(ad);
  assert.equal(await S.exists(), false);
  await assert.rejects(S.init('short'), /12 characters/);
  const st = await S.init(PASS);
  assert.equal(st.schema, 6);
  assert.ok(S.isUnlocked());
  await assert.rejects(S.init(PASS), { message: 'VAULT_EXISTS' });
  const env = ad._m.get('envelope');
  assert.equal(env.v, 1); assert.equal(env.kdf.iter, 600000);

  const iv1 = env.iv;
  await S.commit((s) => { s.entries.push(L.metrics.validateEntry({ domain: 'health', type: 'workout', date: '2026-11-10', title: 'SecretRun' })); });
  assert.notEqual(ad._m.get('envelope').iv, iv1);
  assert.ok(!JSON.stringify(ad._m.get('envelope')).includes('SecretRun'));
  assert.equal(S.getState().entries.length, 1);

  await assert.rejects(S.commit((s) => { s.entries[0].date = 'garbage'; }));
  assert.equal(S.getState().entries[0].date, '2026-11-10', 'rolled back');

  S.lock();
  assert.equal(S.isUnlocked(), false);
  assert.throws(() => S.getState(), { message: 'LOCKED' });
  await assert.rejects(S.commit(() => {}), { message: 'LOCKED' });
  await assert.rejects(S.unlock('wrong passphrase!!'), { message: 'BAD_PASSPHRASE_OR_DATA' });
  assert.equal(S.isUnlocked(), false);
  const again = await S.unlock(PASS);
  assert.equal(again.entries[0].title, 'SecretRun');

  await assert.rejects(S.changePassphrase('wrong passphrase!!', 'new passphrase 123'), { message: 'BAD_PASSPHRASE_OR_DATA' });
  await assert.rejects(S.changePassphrase(PASS, 'short'), /12 characters/);
  const oldSalt = ad._m.get('envelope').kdf.salt;
  await S.changePassphrase(PASS, 'new passphrase 123');
  assert.notEqual(ad._m.get('envelope').kdf.salt, oldSalt);
  S.lock();
  await assert.rejects(S.unlock(PASS));
  assert.equal((await S.unlock('new passphrase 123')).entries.length, 1);

  const next = S.defaultState(); next.settings.currency = 'EUR';
  await S.replaceState(next);
  S.lock();
  assert.equal((await S.unlock('new passphrase 123')).settings.currency, 'EUR');

  await S.wipe();
  assert.equal(await S.exists(), false);
  assert.equal(S.isUnlocked(), false);
});
test('newId and defaultState', () => {
  assert.match(S.newId(), /^[0-9a-f-]{36}$/);
  assert.notEqual(S.newId(), S.newId());
  assert.deepEqual(S.validateState(S.defaultState()), S.defaultState());
});

const good = () => S.defaultState();
test('validateState rejects malformed input', () => {
  for (const bad of [null, 5, 'x', [], {}, { schema: 2 }]) assert.throws(() => S.validateState(bad));
  let s = good(); s.entries = 'no'; assert.throws(() => S.validateState(s));
  s = good(); s.settings.currency = 'dollars'; assert.throws(() => S.validateState(s));
  s = good(); s.settings.provider.kind = 'evil'; assert.throws(() => S.validateState(s));
  s = good(); s.settings.provider = { kind: 'local', baseUrl: 'http://evil.com', model: '', apiKey: '' }; assert.throws(() => S.validateState(s));
  s = good(); s.settings.targets.savingsRate = 7; assert.throws(() => S.validateState(s));
  s = good(); s.entries = [{ domain: 'money', type: 'income', date: '2026-13-40', title: 'x', value: 1 }]; assert.throws(() => S.validateState(s));
  s = good(); s.memory.insights = [{ id: 'a', level: 9, period: { from: '2026-01-01', to: '2026-01-07' }, domain: 'money', text: 't', source: 'ai', status: 'approved', createdAt: 'x' }];
  assert.throws(() => S.validateState(s));
});
test('validateState rejects oversized input', () => {
  let s = good(); s.entries = [{ domain: 'work', type: 'outcome', date: '2026-11-10', title: 'x'.repeat(201) }]; assert.throws(() => S.validateState(s));
  s = good(); s.entries = [{ domain: 'work', type: 'outcome', date: '2026-11-10', title: 'x', notes: 'n'.repeat(2001) }]; assert.throws(() => S.validateState(s));
  s = good(); s.entries = new Array(50001).fill(0); assert.throws(() => S.validateState(s), /too many/);
  s = good(); s.memory.lessons = Array.from({ length: 31 }, (_, i) => ({ id: 'i' + i, text: 't', createdAt: 'x' })); assert.throws(() => S.validateState(s));
  s = good(); s.audit = Array.from({ length: 300 }, (_, i) => ({ ts: 'x', action: 'a' + i }));
  const v = S.validateState(s); assert.equal(v.audit.length, 200); assert.equal(v.audit[199].action, 'a299');
});
test('validateState accepts 50000 entries', () => {
  const s = good();
  s.entries = Array.from({ length: 50000 }, (_, i) => ({ id: 'e' + i, domain: 'activities', type: 'session', date: '2026-11-10', title: 'x' }));
  assert.equal(S.validateState(s).entries.length, 50000);
});
test('validateState rejects prototype pollution keys', () => {
  const a = JSON.parse('{"schema":1,"__proto__":{"polluted":1}}');
  assert.throws(() => S.validateState(a), /forbidden/);
  const s = good(); s.settings.constructor = { prototype: {} }; assert.throws(() => S.validateState(s), /forbidden/);
  const t = JSON.parse(JSON.stringify(good())); t.entries = [JSON.parse('{"domain":"work","type":"outcome","date":"2026-11-10","title":"x","__proto__":{"x":1}}')];
  assert.throws(() => S.validateState(t), /forbidden/);
  assert.equal({}.polluted, undefined);
});
test('validateState rebuilds a clean object from whitelisted fields', () => {
  const s = good(); s.extra = 'x'; s.settings.hack = 1; s.settings.provider.apiKey = 'k';
  s.entries = [{ id: 'e1', domain: 'work', type: 'outcome', date: '2026-11-10', title: ' Ship ', status: 'done', evil: 'x', value: 5, createdAt: 'c' }];
  const v = S.validateState(s);
  assert.notEqual(v, s); assert.notEqual(v.entries[0], s.entries[0]);
  assert.equal(v.extra, undefined); assert.equal(v.settings.hack, undefined);
  assert.deepEqual(v.entries[0], { id: 'e1', domain: 'work', type: 'outcome', date: '2026-11-10', title: 'Ship', status: 'done', createdAt: 'c' });
  s.entries.push(s.entries[0]);
  assert.throws(() => S.validateState(s), /duplicate/);
});
