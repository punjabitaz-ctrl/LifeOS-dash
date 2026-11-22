// v1.0.0 final review: regression tests for the CR, PV and UI findings beyond the reviewers' own proof tests
// (test/review-crypto.test.mjs, test/review-privacy.test.mjs, test/review-ui.mjs). See "Final complete review (v1.0.0)" in docs/SECURITY.md.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { L, memAdapter, PASS, E } from './_load.mjs';
import { drive, TOKEN, clone, asSchema } from './_v070.mjs';

const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = live('store'), P = live('priv'), V = live('vault'), M = live('metrics'), Mem = live('memory'), C = live('csv'), R = live('revenue'), Ad = live('admin');
const PRIV = 'v100 private passphrase', NEWPASS = 'a brand new main passphrase';
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const ui = src('src/ui/app.js');
const fastDerive = async (pass, salt) => {
  const base = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};
async function fresh() {
  try { P.close('system'); } catch (e) { /* ignore */ }
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  const d = drive(); L.sync._setFetch(d.fetch); L.sync._setToken(TOKEN, 3600);
  return { ad, d };
}

describe('v1.0.0 final review regressions', () => {
  let ORIG = null;
  before(() => { ORIG = L.vault.deriveKey; L.vault.deriveKey = fastDerive; });
  after(() => { L.vault.deriveKey = ORIG; try { P.close('system'); } catch (e) { /* ignore */ } });

  test('CR-1: an edit saved while a download is adopted is still a local change afterwards', async () => {
    const { d } = await fresh();
    await L.sync.run();
    // Another device uploads; this device has no changes, so it gets a download offer.
    const env = JSON.parse(d.file.text), salt = V.parseEnvelope(env).salt, key = await V.deriveKey(PASS, salt), raw = await V.decrypt(key, env);
    raw.entries.push(E({ id: 'remote-1', domain: 'money', type: 'expense', value: 4 }));
    const m = { rev: env.rev + 1, updatedAt: '2026-11-14T00:00:00.000Z', deviceId: 'other' }; raw._meta = m;
    d.put(JSON.stringify(Object.assign(await V.makeEnvelope(key, salt, raw), m)));
    const dec = await L.sync.run();
    assert.equal(dec.kind, 'download-offer');
    // The adopt is queued behind an edit that lands first: the edit is lost by the adopt (the offer said "no changes"), but any edit
    // after the adopt must count as a local change, so the bookkeeping fingerprint is the adopted state, not the live one.
    const r = await L.sync.apply(dec, 'download');
    assert.equal(r.kind, 'downloaded');
    await S.commit((s) => { s.entries.push(E({ id: 'after-adopt', domain: 'money', type: 'expense', value: 5 })); });
    assert.equal((await L.sync.run()).kind, 'uploaded');
    const back = await S.inspectEnvelope(JSON.parse(d.file.text));
    assert.ok(back.state.entries.some((e) => e.id === 'after-adopt') && back.state.entries.some((e) => e.id === 'remote-1'));
  });

  test('CR-5: the file this device synced with wins over a newer duplicate, a duplicate is reported, and no second file is created', async () => {
    const { d } = await fresh();
    await L.sync.run();
    const mine = d.file;
    const inner = d.fetch;
    // A second LifeOS file (another device's first upload) appears and is listed first (newest).
    d.fetch = async (url, o) => {
      const u = new URL(url);
      if (u.pathname === '/drive/v3/files') return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ files: [{ id: 'otherfile99', size: '10', version: '1' }, { id: mine.id, size: String(d.file.text.length), version: String(d.version) }] }) };
      return inner(url, o);
    };
    L.sync._setFetch(d.fetch);
    const r = await L.sync.run();
    assert.equal(r.kind, 'in-sync');
    assert.equal(r.copies, 2);
    // First sync: a file appears between the listing and the upload, so nothing is created.
    const { d: d2 } = await fresh();
    let lists = 0; const in2 = d2.fetch;
    d2.fetch = async (url, o) => {
      const u = new URL(url);
      if (u.pathname === '/drive/v3/files' && ++lists === 2) return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ files: [{ id: 'racefile77', size: '10', version: '1' }] }) };
      return in2(url, o);
    };
    L.sync._setFetch(d2.fetch);
    await assert.rejects(L.sync.run(), (e) => e.code === 'REMOTE_CHANGED');
    assert.equal(d2.writes, 0);
    assert.ok(/This device uses the one it synced with last/.test(src('src/ui/sync-ui.js')));
  });

  test('CR-6: a main passphrase change between the check and the choice refuses the download', async () => {
    const { d } = await fresh();
    await L.sync.run();
    const env = JSON.parse(d.file.text), salt = V.parseEnvelope(env).salt, key = await V.deriveKey(PASS, salt), raw = await V.decrypt(key, env);
    raw.entries.push(E({ domain: 'money', type: 'expense', value: 4 }));
    const m = { rev: env.rev + 1, updatedAt: '2026-11-14T00:00:00.000Z', deviceId: 'other' }; raw._meta = m;
    d.put(JSON.stringify(Object.assign(await V.makeEnvelope(key, salt, raw), m)));
    const dec = await L.sync.run();
    assert.equal(dec.kind, 'download-offer');
    await S.changePassphrase(PASS, NEWPASS);
    const before = S.saltId();
    await assert.rejects(L.sync.apply(dec, 'download'), (e) => e.code === 'LOCAL_CHANGED');
    assert.equal(S.saltId(), before, 'the old key was not put back');
  });

  test('CR-2: an over-cap merged view opens, its adds are refused, and every cap is tolerant only for merged views', async () => {
    await fresh();
    await P.setUp(PRIV);
    await P.write((s) => { for (let i = 0; i < 3; i++) M.addHabit(s, 'Private ' + i); }, { newPrivate: true });
    P.close();
    await S.commit((s) => { for (let i = 0; i < 8; i++) M.addHabit(s, 'Public ' + i); });
    await P.open(PRIV);
    const v = P.view(S.getState());
    assert.equal(v.habits.length, 11);
    await assert.rejects(P.write((s) => { M.addHabit(s, 'One more'); }), /up to 8/);
    // An ordinary write while open still works and keeps every habit.
    await P.write((s) => { s.settings.currency = 'EUR'; });
    assert.equal(P.view(S.getState()).habits.length, 11);
    P.close('system');
    // The stored main state is never tolerant.
    const raw = S.defaultState(); for (let i = 0; i < 9; i++) raw.habits.push({ id: 'h' + i, name: 'H' + i });
    assert.throws(() => S.validateState(clone(raw)), /too many/);
    assert.doesNotThrow(() => S.validateState(clone(raw), { merged: true }));
    // A goal whose parent is not on a longer horizon: refused in the main state, detached in a merged view.
    const g = (o) => Object.assign({ title: 'G', horizon: 'quarterly', domain: 'goals', metric: 'manual', direction: 'up', startValue: 0, targetValue: 10, startDate: '2026-10-01', dueDate: '2026-12-31', state: 'active', notes: '', createdAt: '2026-10-01' }, o);
    const gs = S.defaultState(); gs.goals.push(g({ id: 'a' }), g({ id: 'b', parentId: 'a' }));
    assert.throws(() => S.validateState(clone(gs)), /longer horizon/);
    assert.equal(S.validateState(clone(gs), { merged: true }).goals.find((x) => x.id === 'b').parentId, undefined);
  });

  test('CR-3: a private passphrase change that keeps losing the race gives up without writing', async () => {
    await fresh();
    await P.setUp(PRIV);
    await P.write((s) => { s.entries.push(E({ id: 'k1', domain: 'money', type: 'expense', value: 1 })); }, { newPrivate: true });
    const a = clone(S.getState());
    await P.write((s) => { s.entries.push(E({ id: 'k2', domain: 'money', type: 'expense', value: 2 })); }, { newPrivate: true });
    const b = clone(S.getState());
    const realDerive = L.vault.deriveKey;
    let flip = 0;
    // Every key derivation is followed by a restore landing, so the stored private vault changes before each commit.
    L.vault.deriveKey = async (p, s) => { const k = await realDerive(p, s); await S.replaceState(flip++ % 2 ? a : b); return k; };
    try { await assert.rejects(P.changePassphrase(PRIV, 'other private pass 55'), /changed while the passphrase was being changed/); }
    finally { L.vault.deriveKey = realDerive; }
    await P.open(PRIV); // the old passphrase still opens it
    P.close('system');
  });

  test('CR-7: replaceState judges an unmarked older copy from its own validation and refuses the loss', async () => {
    await fresh();
    await S.commit((s) => { s.projects.push({ id: 'p1', name: 'Keep me', kind: 'job', status: 'active', nextAction: '' }); });
    const old = asSchema(2, S.defaultState());
    await assert.rejects(S.replaceState(old), (e) => e.code === 'OLDER_FORMAT');
    assert.equal(S.getState().projects.length, 1);
  });

  test('CR-8: no source file contains a sequence the build would have to escape', () => {
    const files = ['src/core', 'src/ui'].flatMap((d) => readdirSync(new URL('../' + d, import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => d + '/' + f));
    for (const f of files) assert.ok(!/<\/?script|<!--/i.test(src(f)), f);
  });

  test('CR-9: the page refuses to run inside a frame', () => {
    assert.ok(/framed = window\.top !== window\.self/.test(ui) && /cannot run inside a frame/.test(ui));
  });

  test('CR-10: the Arabic letter mark (U+061C) is stripped like the other bidi controls', () => {
    const s = S.defaultState();
    s.projects.push({ id: 'p', name: 'A؜b', kind: 'job', status: 'active', nextAction: '' });
    assert.equal(S.validateState(clone(s)).projects[0].name, 'Ab');
  });

  test('PV-1: the ledger card refuses while private entries or lines are hidden; an open vault previews normally', async () => {
    await fresh();
    await P.setUp(PRIV);
    await P.write((s) => { s.projects.push({ id: 'pp', name: 'Hidden line', kind: 'client', status: 'active', nextAction: '', archived: false }); }, { newPrivate: true });
    const csv = 'Date,Amount,Line\n2026-11-02,10.00,Hidden line\n';
    const open = await R.plan(C.parse(csv), { map: { date: 0, amount: 1, line: 2 } }, P.view(S.getState()), '2026-11-10');
    assert.equal(open.add.length, 1); assert.equal(open.add[0].entry.projectId, 'pp'); assert.equal(open.blocked, undefined);
    P.close('system');
    const shut = await R.plan(C.parse(csv), { map: { date: 0, amount: 1, line: 2 } }, S.getState(), '2026-11-10');
    assert.equal(shut.blocked, 'private'); assert.equal(shut.add.length, 0); assert.deepEqual(shut.unknownLines, []);
    assert.deepEqual(R.applyPlan(S.getState(), shut), { added: 0, linesCreated: 0 });
    assert.ok(/id: 'ledger-locked'/.test(ui) && /Open the private vault to import a ledger/.test(ui));
  });

  test('PV-2: a kept link to a hidden line counts as Unassigned while closed and moves into the vault on the next write', async () => {
    await fresh();
    await S.commit((x) => { x.projects.push({ id: 'pA', name: 'Client A', kind: 'client', status: 'active', nextAction: '', archived: false }); });
    await P.setUp(PRIV);
    await P.moveIn('projects', 'pA', { children: true });
    P.close();
    await S.commit((x) => { x.entries.push(E({ id: 'e1', domain: 'money', type: 'income', date: '2026-11-03', value: 5, projectId: 'pA' })); });
    const closed = R.report(S.getState(), { from: '2026-11-01', to: '2026-11-30' });
    assert.equal(closed.total.revenueCents, 500);
    assert.equal(closed.unassigned.revenueCents, 500);
    // Without private lines a dangling link is still dropped.
    const plain = S.defaultState(); plain.entries.push(E({ domain: 'money', type: 'income', value: 1, projectId: 'gone' }));
    assert.equal(S.validateState(clone(plain)).entries[0].projectId, undefined);
    await P.open(PRIV);
    await P.write((x) => { x.settings.currency = 'USD'; });
    const pub = S.getState().entries.find((e) => e.id === 'e1');
    assert.equal(pub.projectId, undefined, 'the link now lives in the private vault');
    assert.equal(P.view(S.getState()).entries.find((e) => e.id === 'e1').projectId, 'pA');
    P.close('system');
  });

  test('PV-3: money CSV values keep two decimals at most and only real thousands groups', () => {
    const p = C.parse('date,title,value\n2026-11-02,A,"1,234.50"\n2026-11-02,B,12.345\n2026-11-02,C,"12,50"\n2026-11-02,D,1234\n');
    const r = C.toEntries(p, { domain: 'money', type: 'expense', map: { date: 'date', title: 'title', value: 'value' } });
    assert.deepEqual(r.entries.map((e) => e.value), [1234.5, 1234]); assert.equal(r.rejected, 2);
    const h = C.toEntries(C.parse('date,title,value\n2026-11-02,W,187.29\n2026-11-02,X,"187,3"\n'), { domain: 'health', type: 'weight', map: { date: 'date', title: 'title', value: 'value' } });
    assert.deepEqual(h.entries.map((e) => e.value), [187.29]); assert.equal(h.rejected, 1);
  });

  test('PV-4: skip keeps the anchor too, yearly Feb 29 comes back in a leap year, and an edited date resets it', () => {
    const s = S.defaultState();
    s.recurring.push({ id: 'r', title: 'Rent', value: 1, category: '', type: 'expense', cadence: 'monthly', nextDate: '2026-01-31', active: true },
      { id: 'y', title: 'Leap', value: 1, category: '', type: 'expense', cadence: 'yearly', nextDate: '2028-02-29', active: true });
    let st = S.validateState(clone(s));
    M.skipRecurring(st, 'r', '2030-01-01'); st = S.validateState(clone(st));
    assert.equal(st.recurring[0].nextDate, '2026-02-28'); assert.equal(st.recurring[0].anchorDay, 31);
    M.skipRecurring(st, 'r', '2030-01-01'); assert.equal(st.recurring[0].nextDate, '2026-03-31'); assert.equal(st.recurring[0].anchorDay, undefined);
    const ys = []; for (let i = 0; i < 4; i++) { ys.push(M.confirmRecurring(st, 'y', '2033-01-01').date); st = S.validateState(clone(st)); }
    assert.deepEqual(ys, ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28']);
    assert.equal(st.recurring[1].nextDate, '2032-02-29');
    // The user moves the date to the 15th: the stale anchor is dropped on save.
    const e = clone(st); e.recurring[0].nextDate = '2026-02-28'; e.recurring[0].anchorDay = 31;
    const moved = clone(e); moved.recurring[0].nextDate = '2026-03-15';
    assert.equal(S.validateState(moved).recurring[0].anchorDay, undefined);
    assert.equal(S.validateState(e).recurring[0].anchorDay, 31);
  });

  test('PV-5 and PV-10: separators fold, the ledger is lenient about bare 9-digit numbers only, everything else stays strict', () => {
    for (const x of ['tax id 123_45_6789', '4111,1111,1111,1111', 'SSN 123456789 for the form']) { assert.ok(Ad.looksSecret(x), x); assert.ok(Ad.looksSecretText(x), x); }
    for (const x of ['INV-202611042', 'Order 100234567', 'po_123456789']) { assert.ok(Ad.looksSecret(x), 'strict elsewhere: ' + x); assert.ok(!Ad.looksSecretText(x), 'lenient in the ledger: ' + x); }
    for (const x of ['$1,234,567.89', 'Paid 1,234.56 on 11/04/2026', '2026/11/04', 'Items 12, 34, 56']) assert.ok(!Ad.looksSecret(x), x);
  });

  test('PV-6: lessons stay on this device; the prompt carries only counts of rejected insights by area', () => {
    const st = S.validateState(clone(S.defaultState()));
    Mem.propose(st, [{ domain: 'money', text: 'Savings rate this week was 10%.' }, { domain: 'work', text: 'Done 3 of 5.' }], { level: 1, period: { from: '2026-11-09', to: '2026-11-15' }, source: 'rules' });
    Mem.decide(st, st.memory.insights[0].id, 'rejected', 'my landlord "Pat Example" ignores this');
    Mem.decide(st, st.memory.insights[1].id, 'rejected');
    assert.equal(st.memory.lessons.length, 1, 'the reason is still kept locally');
    for (const lv of [1, 2, 3]) {
      const p = Mem.buildPrompt(st, lv, lv === 1 ? { from: '2026-11-09', to: '2026-11-15' } : { from: '2026-10-01', to: '2026-12-31' });
      assert.ok(!p.user.includes('Pat Example') && !p.user.includes('landlord') && !p.user.includes('Savings rate'), p.user);
      assert.match(p.user, /recently rejected insights by area: money 1, work 1\./);
    }
    assert.ok(/Your reason is never sent to the AI/.test(ui) && /They are never sent to the AI/.test(ui));
    assert.ok(!/helps future suggestions/.test(ui) && !/The prompt has numbers only/.test(ui));
  });

  test('PV-7: category and due date round trip through a Money CSV; an unknown status is rejected', () => {
    const ents = [E({ domain: 'money', type: 'income', date: '2026-11-03', title: 'Invoice', value: 100, status: 'expected', dueDate: '2026-12-01', category: 'Business' }),
      E({ domain: 'money', type: 'income', date: '2026-11-04', title: 'Paid', value: 50 })];
    const p = C.parse(C.exportEntries(ents) + '"x","money","income","2026-11-05","Odd","5","maybe","","","","","","","","","",""\r\n');
    const r = C.toEntries(p, { domain: 'money', type: 'income', map: { date: 'date', title: 'title', value: 'value', status: 'status', category: 'category', dueDate: 'dueDate' } });
    assert.equal(r.rejected, 1);
    assert.deepEqual(r.entries.map((e) => [e.status, e.dueDate, e.category]), [['expected', '2026-12-01', 'Business'], [undefined, undefined, undefined]]);
    assert.throws(() => C.toEntries(p, { domain: 'money', type: 'expense', map: { date: 'date', title: 'title', value: 'value', status: 'status' } }), /no status field/);
  });

  test('PV-8 and PV-9: a boundary week goes to the month it starts in, never both; no rules insight names a body metric', () => {
    const st = S.validateState(clone(S.defaultState()));
    Mem.propose(st, [{ domain: 'money', text: 'Boundary 271.' }], { level: 1, period: { from: '2026-10-26', to: '2026-11-01' }, source: 'rules' });
    Mem.decide(st, st.memory.insights[0].id, 'approved');
    assert.ok(Mem.buildPrompt(st, 2, { from: '2026-10-01', to: '2026-10-31' }).user.includes('Boundary 271'));
    assert.ok(!Mem.buildPrompt(st, 2, { from: '2026-11-01', to: '2026-11-30' }).user.includes('Boundary 271'));
    assert.ok(!/Weight moved/.test(src('src/core/memory.js').replace(/const BODY_TEXT[^\n]*/, '')), 'the weight rule is gone (only the legacy filter remains)');
  });

  test('UI fixes present in the source: autocomplete default, labels, focus, memo reset, add intent, backoff, idle, copy, password fields, inert', () => {
    assert.ok(/tag === 'input' \|\| tag === 'textarea' \|\| tag === 'form'\) && !el\.hasAttribute\('autocomplete'\)\) el\.setAttribute\('autocomplete', 'off'\)/.test(ui), 'UI-1');
    assert.ok(/'Size of ' \+ label/.test(ui) && /'Stage of ' \+ it\.title/.test(ui) && /'State of ' \+ it\.title/.test(ui) && /'Recurring item to flag as a household bill'/.test(ui), 'UI-2');
    assert.ok(/z\.setAttribute\('class', 'mv-size'\)/.test(ui), 'UI-3');
    assert.ok(/notice = null; goalMemo = new Map\(\);/.test(ui) && /privNew = false; goalMemo = new Map\(\);/.test(ui), 'UI-4');
    assert.ok(/if \(o && o\.newPrivate && !addIntent\)/.test(ui) && /if \(o\.adds\) markAddIntent\(\);/.test(ui), 'UI-5');
    assert.ok(/UI-6/.test(ui) && /changePassphrase\(a, c\)\.then\(function \(\) \{ privFail = \{ n: 0, until: 0 \}/.test(ui), 'UI-6');
    assert.ok(/return \(mainState\(\)\.settings\.autoLockMin/.test(ui) && /now - lastReset < 1000/.test(ui), 'UI-7');
    assert.ok(!/\(recommended\)/.test(ui), 'UI-8');
    assert.ok(/m === 'LOCKED'\) return/.test(ui) && /\.then\(function \(\) \{ p1\.value = ''; p2\.value = ''; \}\)/.test(ui) && /ip\.value = ''; \/\/ UI-9/.test(ui), 'UI-9');
    assert.ok(/inert: dashEdit \? true : null/.test(ui) && /tabindex: '-1', 'aria-hidden': 'true'/.test(ui), 'UI-10');
  });

  test('version 1.0.0: shown in the app, and nothing compares app version strings (schema and rev decide in sync, backup and migration)', () => {
    assert.equal(JSON.parse(src('package.json')).version, '1.7.0');
    assert.ok(ui.includes("text: 'LifeOS v' + L.VERSION"));
    for (const f of ['src/core/store.js', 'src/core/sync.js', 'src/core/vault.js', 'src/core/priv.js']) assert.ok(!/['"]v?(1\.0\.0|0\.12\.0)['"]|appVersion/.test(src(f)), f);
    // The envelope and the backup carry the schema number and revision only, never an app version.
    const s = S.defaultState();
    assert.equal(s.schema, 19);
    assert.ok(!('version' in s) && !('appVersion' in s));
  });
});
