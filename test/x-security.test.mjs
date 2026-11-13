// Regression tests for docs/SECURITY.md findings. Named x-* so it registers after store.test.mjs,
// which asserts that no storage adapter exists yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { L, memAdapter, PASS, E } from './_load.mjs';

const S = L.store;
const fresh = async () => { S.lock(); S._setAdapter(memAdapter()); await S.init(PASS); };

test('SEC-01 CSV number parsing is linear: 5 MB of long digit cells imports quickly', () => {
  const cell = '1'.repeat(9990) + 'x';
  const rows = ['date,title,value'];
  for (let i = 0; i < 480; i++) rows.push('2026-11-02,t' + i + ',' + cell);
  const parsed = L.csv.parse(rows.join('\n'));
  const t = Date.now();
  const r = L.csv.toEntries(parsed, { domain: 'money', type: 'expense', map: { date: 'date', title: 'title', value: 'value' } });
  assert.equal(r.entries.length, 0);
  assert.equal(r.rejected, 480);
  assert.ok(Date.now() - t < 2000, 'took ' + (Date.now() - t) + ' ms');
});

test('SEC-01 validateEntry rejects huge numeric strings quickly', () => {
  const t = Date.now();
  assert.throws(() => L.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2026-11-02', title: 'x', value: '9'.repeat(200000) + 'x' }));
  assert.throws(() => L.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2026-11-02', title: 'x', value: '9'.repeat(30000) }));
  assert.ok(Date.now() - t < 500);
  assert.equal(L.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2026-11-02', title: 'x', value: '12.5' }).value, 12.5);
  assert.equal(L.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2026-11-02', title: 'x', value: '1e3' }).value, 1000);
});

test('SEC-03 backups larger than the old 5 MB UI cap round trip; oversized text is refused', async () => {
  const st = S.defaultState();
  for (let i = 0; i < 4000; i++) st.entries.push(E({ domain: 'money', type: 'expense', value: i, notes: 'n'.repeat(1500) }));
  const text = await L.vault.exportBackup(PASS, st);
  assert.ok(text.length > 5 * 1024 * 1024 && text.length < L.vault.MAX_BACKUP);
  const back = await L.vault.importBackup(PASS, text);
  assert.equal(back.entries.length, 4000);
  assert.equal(L.vault.MAX_BACKUP, 64 * 1024 * 1024);
  await assert.rejects(L.vault.importBackup(PASS, ' '.repeat(L.vault.MAX_BACKUP + 1)), /Not a LifeOS backup/);
});

test('SEC-04 lock empties the live state object so held references lose plaintext', async () => {
  await fresh();
  await S.commit((s) => { s.entries.push(E({ domain: 'work', type: 'outcome', title: 'SecretTitle' })); });
  const ref = S.getState();
  S.lock();
  assert.equal(Object.keys(ref).length, 0);
  assert.ok(!JSON.stringify(ref).includes('SecretTitle'));
  assert.throws(() => S.getState(), /LOCKED/);
});

test('SEC-04 a commit racing a lock does not repopulate the dropped state', async () => {
  await fresh();
  const ref = S.getState();
  const p = S.commit((s) => { s.entries.push(E({ domain: 'work', type: 'outcome', title: 'RaceTitle' })); });
  S.lock();
  await assert.rejects(p, /LOCKED/);
  assert.equal(Object.keys(ref).length, 0);
  assert.equal(S.isUnlocked(), false);
});

test('SEC-04 changePassphrase racing a lock leaves no key behind and keeps the old passphrase', async () => {
  await fresh();
  const p = S.changePassphrase(PASS, 'another long passphrase');
  S.lock();
  await assert.rejects(p, /LOCKED/);
  assert.equal(S.isUnlocked(), false);
  await S.unlock(PASS);
  assert.ok(S.isUnlocked());
});

test('SEC-04 replaceState racing a lock does not touch the dropped state', async () => {
  await fresh();
  const ref = S.getState();
  const p = S.replaceState(S.defaultState());
  S.lock();
  await assert.rejects(p, /LOCKED/);
  assert.equal(Object.keys(ref).length, 0);
});

test('crypto: stored envelope with a lowered iteration count or short salt is refused', async () => {
  const ad = memAdapter();
  S.lock(); S._setAdapter(ad);
  await S.init(PASS);
  S.lock();
  const good = JSON.parse(JSON.stringify(ad._m.get('envelope')));
  for (const mut of [(e) => { e.kdf.iter = 1000; }, (e) => { e.kdf.iter = '600000'; }, (e) => { e.kdf.hash = 'SHA-1'; }, (e) => { e.kdf.salt = 'AAAA'; }, (e) => { e.iv = 'AAAA'; }]) {
    const env = JSON.parse(JSON.stringify(good)); mut(env); ad._m.set('envelope', env);
    await assert.rejects(S.unlock(PASS), /BAD_PASSPHRASE_OR_DATA/);
    assert.equal(S.isUnlocked(), false);
  }
  ad._m.set('envelope', good);
  await S.unlock(PASS);
});

test('AI prompt never contains the API key, account titles, notes or names', () => {
  const s = S.defaultState();
  s.settings.provider = { kind: 'anthropic', baseUrl: '', model: '', apiKey: 'sk-ant-SECRETKEY1234' };
  s.entries = [
    E({ domain: 'assets', type: 'balance', title: 'AcctSecret', value: 5, date: '2026-11-03' }),
    E({ domain: 'assets', type: 'balance', title: 'AcctSecret', value: 9, date: '2026-11-10' }),
    E({ domain: 'social', type: 'contact', person: 'Pat Secretname', title: 'TitleSecret', notes: 'NoteSecret' }),
  ];
  L.memory.propose(s, L.memory.rulesInsights(s, '2026-11-09'), { level: 1, period: { from: '2026-11-09', to: '2026-11-15' }, source: 'rules' });
  s.memory.insights.forEach((x) => L.memory.decide(s, x.id, 'approved'));
  for (const lvl of [1, 2, 3]) {
    const { system, user } = L.memory.buildPrompt(s, lvl, lvl === 1 ? { from: '2026-11-09', to: '2026-11-15' } : { from: '2026-10-01', to: '2026-12-31' });
    for (const bad of ['SECRETKEY', 'sk-ant', 'AcctSecret', 'Secretname', 'TitleSecret', 'NoteSecret']) assert.ok(!(system + user).includes(bad), bad);
  }
});

test('SEC-06 CSV mapping by column index handles duplicate and empty headers', () => {
  const parsed = L.csv.parse('Date,,Amount,Amount\n2026-11-02,Rent,1,1200\n');
  const r = L.csv.toEntries(parsed, { domain: 'money', type: 'expense', map: { date: 0, title: 1, value: 3 } });
  assert.equal(r.rejected, 0);
  assert.equal(r.entries[0].title, 'Rent');
  assert.equal(r.entries[0].value, 1200);
});

test('CSV export neutralises every formula trigger in every column', () => {
  const bad = ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx', '\nx'];
  const ents = bad.map((t) => ({ id: t, domain: 'work', type: 'outcome', date: '2026-11-02', title: t, notes: t, person: t }));
  const out = L.csv.exportEntries(ents);
  for (const t of bad) assert.ok(out.includes('"\'' + t.replace(/"/g, '""') + '"'), JSON.stringify(t));
  assert.ok(!/(^|,)"[=+\-@\t\r\n]/m.test(out));
});
