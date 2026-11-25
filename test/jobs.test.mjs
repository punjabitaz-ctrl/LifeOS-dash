// v1.6.0 B14: job search. Schema 18 (migrations 1 to 17, a v1.5.0 backup, downgrade guards, validateState for every new field), funnel
// numbers and rates (zero denominators), the weekly view across week, month and year ends, follow-ups in the review, at a glance and the
// calendar file, people links and the one-tap contact log, the tracker CSV import, the private vault while closed and open, and the rule
// that compensation and text never reach a prompt, the digest, an insight, the audit log or an error. Run in three time zones.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L, PASS, memAdapter } from './_load.mjs';
import { fastKeys, realKeys, clone, PRIV } from './_archive.mjs';
import { buildAdversarial, ADV_MARK } from './_adversarial.mjs';

const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), J = view('jobs'), M = view('metrics'), So = view('social'), Mem = view('memory'), P = view('priv'), V = view('vault'), C = view('csv'), Cal = view('calendar'), Ac = view('activities'), O = view('ops');
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { P.close('system'); } catch (e) { /* closed */ } try { S.lock(); } catch (e) { /* locked */ } S._setAdapter(NOSTORE); realKeys(); } });
// Leaves the store as a fresh Node process has it (store.test.mjs asserts that no storage exists at import time).
const nope = async () => { throw new Error('NO_STORAGE'); };
const NOSTORE = { get: nope, set: nope, del: nope };
const TODAY = '2026-11-14', WK = '2026-11-09';
const SHA = 'a'.repeat(64);
const job = (o) => Object.assign({ id: 'j' + Math.random().toString(36).slice(2, 8), title: 'Role', org: 'Co', kind: 'job', stage: 'lead', source: '', nextStep: '', updatedAt: '2026-11-01', notes: '' }, o);
const build = (fn) => { const s = S.defaultState(); fn(s); return S.validateState(clone(s)); };
const withJobs = (items, extra) => build((s) => { s.pipeline.push(...items); if (extra) extra(s); });
async function vault(state, o = {}) {
  S._setAdapter(memAdapter()); S.lock(); await S.init(PASS);
  if (state) await S.replaceState(state);
  if (o.priv) await P.setUp(PRIV);
}
const REAL_DERIVE = (p, salt) => { realKeys(); try { return V.deriveKey(p, salt); } finally { fastKeys(); } };

// ---------------------------------------------------------------- schema 18
test('schema 18: the schema is 18 and package.json is the version source', () => {
  assert.equal(S.SCHEMA, 22); assert.equal(S.defaultState().schema, 22);
  assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, '2.2.0');
});
const OLDFIELDS = { role: 'Account Executive', locationType: 'remote', targetOteCents: 20000000, appliedOn: '2026-11-01', resume: 'v3', followUp: '2026-11-20' };
test('migrations 1 to 17 into 18: the pipeline survives with every old text, and no job field is invented or trusted from an older format', () => {
  const base = S.defaultState();
  base.pipeline.push(job(Object.assign({ id: 'a', title: 'Old job', org: 'Old Co', stage: 'applied', source: 'LinkedIn', nextStep: 'call', notes: 'old note' }, OLDFIELDS)), job({ id: 'b', kind: 'deal', title: 'A deal', stage: 'lead' }));
  for (let n = 1; n <= 17; n++) {
    const o = clone(base); o.schema = n;
    if (n < 2) for (const k of ['accounts', 'recurring', 'budgets', 'categories']) delete o[k];
    if (n < 4) delete o.settings.health;
    if (n < 6) { delete o.settings.home; for (const k of ['properties', 'vehicles', 'maintenance', 'renewals', 'documents', 'taxItems']) delete o[k]; }
    if (n < 7) { delete o.settings.learning; for (const k of ['learningItems', 'studySessions', 'takeaways']) delete o[k]; }
    if (n < 8) delete o.activities;
    if (n < 9) for (const k of ['groups', 'people', 'contacts']) delete o[k];
    if (n < 10) delete o.settings.privAutoLockSec;
    if (n < 12) for (const k of ['payees', 'invoices', 'trips', 'taxPayments', 'taxYears', 'homeOffice', 'taxMap']) delete o[k];
    if (n < 12) delete o.settings.business;
    if (n < 14) { delete o.archives; delete o.summaries; }
    if (n < 15) delete o.ops;
    if (n < 17) { delete o.memory.lastReviewAt; delete o.memory.mutes; delete o.memory.startedOn; }
    delete o.settings.layouts;
    const got = S.validateState(o);
    assert.equal(got.schema, 22); assert.equal(got.sourceSchema, n);
    if (n < 3) { assert.deepEqual(got.pipeline, [], 'schema ' + n + ' carries no pipeline'); continue; }
    assert.equal(got.pipeline.length, 2, 'schema ' + n);
    const a = got.pipeline.find((x) => x.id === 'a');
    assert.deepEqual([a.title, a.org, a.source, a.nextStep, a.notes, a.stage], ['Old job', 'Old Co', 'LinkedIn', 'call', 'old note', 'applied']);
    for (const k of Object.keys(OLDFIELDS)) assert.equal(a[k], undefined, 'schema ' + n + ' must not carry ' + k);
  }
  // at 18 the same fields are kept
  const got = S.validateState(clone(base));
  const a = got.pipeline.find((x) => x.id === 'a');
  for (const [k, v] of Object.entries(OLDFIELDS)) assert.equal(a[k], v, k);
});
test('a v1.5.0 backup (schema 17) imports cleanly into an empty vault and a stored schema 17 vault migrates on unlock', async () => {
  const st = clone(S.defaultState()); st.schema = 17;
  st.pipeline.push(job({ id: 'a', title: 'Backup job', stage: 'interview', notes: 'kept' }));
  const salt = V.newSalt(), key = await REAL_DERIVE('backup passphrase 1', salt);
  const imp = await V.importBackup('backup passphrase 1', JSON.stringify(await V.makeEnvelope(key, salt, S.validateState(Object.assign(clone(st), { schema: 17 })))));
  assert.equal(imp.schema, 22); assert.equal(imp.sourceSchema, 22, 'the backup was written by this validator');
  // a file really written at schema 17 (envelope plaintext with schema 17)
  const raw17 = clone(S.validateState(clone(st))); raw17.schema = 17;
  const k2 = await REAL_DERIVE('backup passphrase 1', salt);
  const imp17 = await V.importBackup('backup passphrase 1', JSON.stringify(await V.makeEnvelope(k2, salt, raw17)));
  assert.equal(imp17.schema, 22); assert.equal(imp17.sourceSchema, 17); assert.equal(imp17.pipeline[0].notes, 'kept'); assert.equal(imp17.pipeline[0].role, undefined);
  await vault(null);
  assert.deepEqual(S.droppedData(S.getState(), imp17), []);
  await S.replaceState(imp17);
  assert.equal(S.getState().schema, 22); assert.equal(S.getState().pipeline.length, 1);
  // stored as schema 17 on disk: unlock migrates, and the first write saves schema 18
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  const env = await S.exportEnvelope(), salt2 = V.parseEnvelope(env).salt;
  const base = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(PASS), 'PBKDF2', false, ['deriveKey']);
  const key2 = await globalThis.crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt2, iterations: 1000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await ad.set('envelope', await V.makeEnvelope(key2, salt2, raw17));
  S.lock();
  const un = await S.unlock(PASS);
  assert.equal(un.schema, 22); assert.equal(un.pipeline.length, 1);
  await S.commit(() => {});
  assert.equal((await (await V.openEnvelope(await ad.get('envelope'), PASS)).raw).schema, 22);
});
test('downgrade guards: an older-format copy names the job details it would drop; a newer schema is refused', async () => {
  const cur = withJobs([job(Object.assign({ id: 'a', stage: 'applied' }, OLDFIELDS))]);
  const older = S.validateState(Object.assign(clone(cur), { schema: 17 }));
  assert.equal(older.pipeline[0].role, undefined);
  assert.deepEqual(S.droppedData(cur, older), ['job search details']);
  assert.match(S.lossText(cur, older), /job search details/);
  for (const k of ['role', 'locationType', 'targetOteCents', 'targetBaseCents', 'offerOteCents', 'offerBaseCents', 'appliedOn', 'resume', 'followUp', 'followedUpOn', 'importKey']) {
    const c = withJobs([job(Object.assign({ id: 'a' }, { [k]: k.endsWith('Cents') ? 1 : k.endsWith('On') || k === 'followUp' ? '2026-11-01' : k === 'locationType' ? 'remote' : k === 'importKey' ? SHA : 'x' }))]);
    assert.deepEqual(S.droppedData(c, S.validateState(Object.assign(clone(c), { schema: 17 }))), ['job search details'], k);
  }
  const lost = withJobs([job({ id: 'a', stage: 'lost', lostReason: 'rejected' })]);
  assert.deepEqual(S.droppedData(lost, S.validateState(Object.assign(clone(lost), { schema: 17 }))), ['job search details'], 'lostReason');
  const plain = withJobs([job({ id: 'a' })]);
  assert.deepEqual(S.droppedData(plain, S.validateState(Object.assign(clone(plain), { schema: 17 }))), [], 'a plain pipeline item loses nothing');
  assert.deepEqual(S.droppedData(cur, S.validateState(clone(cur))), []);
  assert.throws(() => S.validateState(Object.assign(S.defaultState(), { schema: 23 })), /schema/);
  // through a real backup and a sync copy: an older-format file never silently strips the details
  await vault(cur);
  const salt = V.newSalt(), key = await REAL_DERIVE('backup passphrase 1', salt);
  const old17 = Object.assign(clone(cur), { schema: 17 });
  const imp = await V.importBackup('backup passphrase 1', JSON.stringify(await V.makeEnvelope(key, salt, old17)));
  assert.equal(imp.sourceSchema, 17); assert.ok(S.dropsWork(S.getState(), imp));
  await assert.rejects(V.importBackup('backup passphrase 1', JSON.stringify(await V.makeEnvelope(key, salt, Object.assign(clone(cur), { schema: 23 })))), /schema/);
});

// ---------------------------------------------------------------- validateState for every new field
test('validateState: every new job field accepts its good values, refuses the bad ones, and drops what does not belong', () => {
  const ok = (o) => withJobs([job(Object.assign({ id: 'a' }, o))]).pipeline[0];
  const bad = (o, what) => assert.throws(() => withJobs([job(Object.assign({ id: 'a' }, o))]), /Invalid data/, what);
  const all = ok({ stage: 'lost', role: 'AE', locationType: 'on site', targetOteCents: 0, targetBaseCents: 12345, offerOteCents: 99999999999, offerBaseCents: 1, appliedOn: '2026-02-28', resume: 'r'.repeat(60), followUp: '2028-02-29', followedUpOn: '2026-11-10', lostReason: 'role closed', importKey: SHA });
  assert.deepEqual([all.role, all.locationType, all.targetOteCents, all.targetBaseCents, all.offerOteCents, all.offerBaseCents, all.appliedOn, all.followUp, all.followedUpOn, all.lostReason, all.importKey], ['AE', 'on site', 0, 12345, 99999999999, 1, '2026-02-28', '2028-02-29', '2026-11-10', 'role closed', SHA]);
  for (const l of ['remote', 'hybrid', 'on site']) assert.equal(ok({ locationType: l }).locationType, l);
  for (const r of ['no response', 'rejected', 'withdrew', 'role closed', 'other']) assert.equal(ok({ stage: 'lost', lostReason: r }).lostReason, r);
  // empty values are the same as absent
  const empty = ok({ role: '', locationType: '', appliedOn: '', resume: '', followUp: '', followedUpOn: '', lostReason: '', importKey: '' });
  for (const k of ['role', 'locationType', 'appliedOn', 'resume', 'followUp', 'followedUpOn', 'lostReason', 'importKey']) assert.equal(empty[k], undefined, k);
  bad({ role: 'x'.repeat(201) }, 'role length'); bad({ role: 5 }, 'role type');
  bad({ locationType: 'moon' }, 'location'); bad({ locationType: 'Remote' }, 'location case');
  for (const k of ['targetOteCents', 'targetBaseCents', 'offerOteCents', 'offerBaseCents']) for (const v of [-1, 1.5, '5', 100000000001]) bad({ [k]: v }, k + ' ' + String(v));
  for (const v of [NaN, Infinity, -Infinity]) { const raw = S.defaultState(); raw.pipeline.push(job({ id: 'a', targetOteCents: v })); assert.throws(() => S.validateState(raw), /Invalid data/, 'not a number ' + v); }
  assert.equal(ok({ targetOteCents: null }).targetOteCents, undefined, 'null is absent');
  for (const k of ['appliedOn', 'followUp', 'followedUpOn']) for (const v of ['x', '2026-02-30', '2026-13-01', '11/01/2026', 5]) bad({ [k]: v }, k + ' ' + v);
  bad({ resume: 'r'.repeat(61) }, 'resume length'); bad({ resume: 5 }, 'resume type');
  bad({ stage: 'lost', lostReason: 'because' }, 'reason');
  for (const v of ['A'.repeat(64), 'a'.repeat(63), 5, '../x']) bad({ importKey: v }, 'importKey ' + v);
  // a reason only belongs to a lost item; invisible characters are stripped from text
  assert.equal(ok({ stage: 'applied', lostReason: 'rejected' }).lostReason, undefined);
  assert.equal(ok({ role: 'A‮E​' }).role, 'AE');
  // job fields belong to kind job only
  const deal = withJobs([job({ id: 'd', kind: 'deal', role: 'x', targetOteCents: 5, appliedOn: '2026-11-01', followUp: '2026-11-02' })]).pipeline[0];
  for (const k of ['role', 'targetOteCents', 'appliedOn', 'followUp']) assert.equal(deal[k], undefined, 'deal ' + k);
  // the digest block validates too: four whole numbers
  const dg = S.validateState(Object.assign(clone(S.defaultState()), { memory: Object.assign(clone(S.defaultState().memory), { reviews: [{ id: 'r', weekOf: WK, digest: { week: WK, domains: {}, jobs: { applied: 1, followUpsDue: 2, interviews: 3, offers: 4, extra: 9 } }, priorities: ['a', 'b', 'c'], completedAt: '2026-11-14T10:00:00.000Z' }] }) })).memory.reviews[0].digest.jobs;
  assert.deepEqual(dg, { applied: 1, followUpsDue: 2, interviews: 3, offers: 4 });
  assert.throws(() => S.validateState(Object.assign(clone(S.defaultState()), { memory: Object.assign(clone(S.defaultState().memory), { reviews: [{ id: 'r', weekOf: WK, digest: { week: WK, domains: {}, jobs: { applied: -1, followUpsDue: 0, interviews: 0, offers: 0 } }, priorities: ['a', 'b', 'c'], completedAt: '2026-11-14T10:00:00.000Z' }] }) })), /Invalid data/);
});
test('the 1000 item pipeline cap holds with every job field set', () => {
  const items = Array.from({ length: 1000 }, (_, i) => job(Object.assign({ id: 'j' + i, stage: 'applied' }, OLDFIELDS, { notes: 'n'.repeat(2000), title: 't'.repeat(200), org: 'o'.repeat(200) })));
  assert.equal(withJobs(items).pipeline.length, 1000);
  assert.throws(() => withJobs(items.concat([job({ id: 'x' })])), /Invalid data/);
});

// ---------------------------------------------------------------- add, edit, stage, follow-up
test('add and edit: title from role and company, compensation in integer cents without floating point, dates, enums, caps and the secrets guard', () => {
  const s = S.defaultState();
  const it = J.addJob(s, { role: 'Account Executive', org: 'Acme', locationType: 'hybrid', source: 'referral', targetOte: '$175,000', targetBase: '120000.50', offerOte: '0.29', offerBase: '1,234.5', resume: 'v3', followUp: '2026-11-20', notes: 'n', stage: 'applied' }, TODAY);
  assert.deepEqual([it.title, it.org, it.role, it.stage, it.kind, it.updatedAt, it.appliedOn], ['Account Executive at Acme', 'Acme', 'Account Executive', 'applied', 'job', TODAY, TODAY]);
  assert.deepEqual([it.targetOteCents, it.targetBaseCents, it.offerOteCents, it.offerBaseCents], [17500000, 12000050, 29, 123450]);
  for (const k of ['targetOteCents', 'targetBaseCents', 'offerOteCents', 'offerBaseCents']) assert.ok(Number.isInteger(it[k]));
  S.validateState(clone(Object.assign(s, { schema: 18 })));
  assert.equal(J.addJob(s, { role: 'Only role' }, TODAY).title, 'Only role');
  assert.equal(J.addJob(s, { org: 'Only company' }, TODAY).title, 'Only company');
  assert.throws(() => J.addJob(s, {}, TODAY), /role or the company/);
  assert.throws(() => J.addJob(s, { role: 'x', stage: 'nope' }, TODAY), /stage/);
  for (const v of ['-5', 'abc', '1e5', '1.234.5', '2000000000']) assert.throws(() => J.addJob(s, { role: 'x', targetOte: v }, TODAY), /amount/, v);
  assert.throws(() => J.addJob(s, { role: 'x', appliedOn: '2026-02-30' }, TODAY), /applied date/);
  assert.throws(() => J.addJob(s, { role: 'x', followUp: 'tomorrow' }, TODAY), /follow-up date/);
  assert.throws(() => J.addJob(s, { role: 'x', locationType: 'moon' }, TODAY), /location/);
  assert.throws(() => J.addJob(s, { role: 'x', lostReason: 'moon' }, TODAY), /reason/);
  assert.throws(() => J.addJob(s, { role: 'x'.repeat(201) }, TODAY), /200/);
  assert.throws(() => J.addJob(s, { role: 'x', resume: 'r'.repeat(61) }, TODAY), /60/);
  assert.throws(() => J.addJob(s, { role: 'x', notes: 'n'.repeat(2001) }, TODAY), /2000/);
  // the secrets guard refuses a card number in any text field and never echoes it
  for (const f of ['role', 'org', 'notes', 'resume', 'nextStep', 'source']) {
    try { J.addJob(s, { role: 'ok', [f]: 'card 4111 1111 1111 1111' }, TODAY); assert.fail('accepted ' + f); } catch (e) { assert.ok(!/4111/.test(e.message), f + ' error echoes the text'); assert.match(e.message, /ID number or a card number/); }
  }
  // edit: empty values clear a field; the reason goes when the item is not lost; the title follows the role and company
  const e = J.updateJob(s, it.id, { role: 'Senior AE', org: 'Acme', locationType: '', source: 'direct', targetOte: '', targetBase: '1', offerOte: '', offerBase: '', resume: '', followUp: '', appliedOn: '2026-11-02', nextStep: 'x', notes: '', lostReason: 'rejected' }, '2026-11-15');
  assert.deepEqual([e.title, e.locationType, e.targetOteCents, e.targetBaseCents, e.offerOteCents, e.resume, e.followUp, e.appliedOn, e.lostReason, e.updatedAt], ['Senior AE at Acme', undefined, undefined, 100, undefined, undefined, undefined, '2026-11-02', undefined, '2026-11-15']);
  assert.throws(() => J.updateJob(s, 'missing', { role: 'x' }, TODAY), /not found/);
  const deal = { id: 'd', title: 'D', org: '', kind: 'deal', stage: 'lead', source: '', nextStep: '', updatedAt: TODAY, notes: '' }; s.pipeline.push(deal);
  assert.throws(() => J.updateJob(s, 'd', { role: 'x' }, TODAY), /not a job/);
  // the cap counts every pipeline item
  const full = S.defaultState(); full.pipeline = Array.from({ length: 1000 }, (_, i) => job({ id: 'j' + i }));
  assert.throws(() => J.addJob(full, { role: 'x' }, TODAY), /1000/);
});
test('stage moves: applied sets the applied date once, lost takes a reason from the list, leaving lost drops it; a follow-up is recorded on a tap', () => {
  const s = S.defaultState();
  const it = J.addJob(s, { role: 'AE', org: 'Co', followUp: '2026-11-12' }, '2026-11-01');
  J.setStage(s, it.id, 'contacted', '2026-11-02'); assert.equal(it.appliedOn, undefined); assert.equal(it.updatedAt, '2026-11-02');
  J.setStage(s, it.id, 'applied', '2026-11-03'); assert.equal(it.appliedOn, '2026-11-03');
  J.setStage(s, it.id, 'interview', '2026-11-09'); assert.equal(it.appliedOn, '2026-11-03', 'kept');
  J.setStage(s, it.id, 'lost', '2026-11-10', 'rejected'); assert.equal(it.lostReason, 'rejected');
  assert.throws(() => J.setStage(s, it.id, 'lost', '2026-11-10', 'moon'), /reason/);
  assert.throws(() => J.setStage(s, it.id, 'nowhere', '2026-11-10'), /stage/);
  J.setStage(s, it.id, 'lead', '2026-11-11'); assert.equal(it.lostReason, undefined);
  const r = J.markFollowedUp(s, it.id, '2026-11-12'); assert.deepEqual([r.followedUpOn, r.followUp], ['2026-11-12', undefined]);
  J.markFollowedUp(s, it.id, '2026-11-13', '2026-11-20'); assert.deepEqual([it.followedUpOn, it.followUp], ['2026-11-13', '2026-11-20']);
  assert.throws(() => J.markFollowedUp(s, it.id, '2026-11-13', 'soon'), /date/);
  S.validateState(clone(Object.assign(s, { schema: 18 })));
});

// ---------------------------------------------------------------- funnel
const FUNNEL = () => [
  job({ id: 'A', stage: 'applied', appliedOn: '2026-10-05', updatedAt: '2026-10-05', source: 'Referral' }),
  job({ id: 'B', stage: 'contacted', appliedOn: '2026-10-10', updatedAt: '2026-10-11', source: 'recruiter' }),
  job({ id: 'C', stage: 'interview', appliedOn: '2026-10-20', updatedAt: '2026-10-25', source: 'job board' }),
  job({ id: 'D', stage: 'offer', appliedOn: '2026-11-02', updatedAt: '2026-11-08', source: 'referral' }),
  job({ id: 'E', stage: 'won', appliedOn: '2026-11-03', updatedAt: '2026-11-09', source: 'LinkedIn' }),
  job({ id: 'F', stage: 'lost', lostReason: 'rejected', appliedOn: '2026-11-04', updatedAt: '2026-11-05' }),
  job({ id: 'G', stage: 'lost', lostReason: 'no response', appliedOn: '2026-11-05', updatedAt: '2026-11-06' }),
  job({ id: 'H', stage: 'lead', updatedAt: '2026-11-09' }),
  job({ id: 'I', stage: 'contacted', updatedAt: '2026-09-30' }),
  job({ id: 'K', kind: 'deal', stage: 'applied', appliedOn: '2026-11-01', updatedAt: '2026-11-01' }),
];
test('funnel: counts per stage now and per month, response, interview and offer rates, hand computed', () => {
  const f = J.funnel(withJobs(FUNNEL()));
  assert.equal(f.total, 9); assert.equal(f.open, 6);
  assert.deepEqual(f.counts, { lead: 1, contacted: 2, applied: 1, interview: 1, offer: 1, won: 1, lost: 2 });
  // applied: A B C D E F G = 7 (H and I have no applied date and are not past applied; the deal is not a job)
  // responded: B C D E F = 5 (A waits, G got no response); interviews C D E = 3; offers D E = 2
  assert.deepEqual([f.applied, f.responded, f.interviews, f.offers], [7, 5, 3, 2]);
  assert.deepEqual([f.responseRate, f.interviewRate, f.offerRate], [71.4, 42.9, 28.6]);
  assert.deepEqual(f.byMonth.map((m) => m.month), ['2026-11', '2026-10', '2026-09']);
  const nov = f.byMonth[0], oct = f.byMonth[1], sep = f.byMonth[2];
  assert.deepEqual([nov.items, nov.applied, nov.responded, nov.interviews, nov.offers, nov.responseRate, nov.interviewRate, nov.offerRate], [5, 4, 3, 2, 2, 75, 50, 50]);
  assert.deepEqual(nov.counts, { lead: 1, contacted: 0, applied: 0, interview: 0, offer: 1, won: 1, lost: 2 });
  assert.deepEqual([oct.items, oct.applied, oct.responded, oct.interviews, oct.offers, oct.responseRate, oct.interviewRate, oct.offerRate], [3, 3, 2, 1, 0, 66.7, 33.3, 0]);
  assert.deepEqual([sep.items, sep.applied, sep.responseRate, sep.interviewRate, sep.offerRate], [1, 0, null, null, null], 'a month with nothing applied has no rates');
  assert.deepEqual(f.sources, [{ source: 'referral', count: 2 }, { source: 'other', count: 1 }, { source: 'job board', count: 1 }, { source: 'recruiter', count: 1 }, { source: 'unknown', count: 4 }].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)), 'source of each lead; free text outside the list is other');
});
test('funnel: "no data" (null) at every zero denominator, never zero and never NaN', () => {
  for (const st of [S.defaultState(), withJobs([]), withJobs([job({ id: 'a', stage: 'lead' }), job({ id: 'b', stage: 'contacted' })]), withJobs([job({ id: 'd', kind: 'deal', stage: 'won', appliedOn: '2026-11-01' })])]) {
    const f = J.funnel(st);
    assert.deepEqual([f.applied, f.responseRate, f.interviewRate, f.offerRate], [0, null, null, null]);
    for (const m of f.byMonth) assert.deepEqual([m.responseRate, m.interviewRate, m.offerRate], [null, null, null]);
  }
  // applied with nobody responding: the rates are a real 0, not "no data"
  const f = J.funnel(withJobs([job({ id: 'a', stage: 'applied', appliedOn: '2026-11-01' })]));
  assert.deepEqual([f.applied, f.responseRate, f.interviewRate, f.offerRate], [1, 0, 0, 0]);
  assert.deepEqual(J.funnel(S.defaultState()).byMonth, []);
});
test('classification: applied, responded, interviewed, offered and source on single items', () => {
  const x = (o) => job(o);
  assert.ok(J.isApplied(x({ stage: 'applied' })) && J.isApplied(x({ stage: 'lost', appliedOn: '2026-11-01' })) && !J.isApplied(x({ stage: 'lost' })) && !J.isApplied(x({ kind: 'deal', stage: 'applied' })));
  assert.ok(J.responded(x({ stage: 'contacted', appliedOn: '2026-11-01' })) && !J.responded(x({ stage: 'contacted' })) && J.responded(x({ stage: 'lost', appliedOn: '2026-11-01', lostReason: 'rejected' })) && !J.responded(x({ stage: 'lost', appliedOn: '2026-11-01', lostReason: 'withdrew' })));
  assert.ok(J.interviewed(x({ stage: 'won' })) && !J.interviewed(x({ stage: 'applied' })) && J.offered(x({ stage: 'offer' })) && !J.offered(x({ stage: 'interview' })));
  assert.deepEqual(['Referral', ' JOB   board ', 'Glassdoor', '', undefined].map((s) => J.sourceOf({ source: s })), ['referral', 'job board', 'other', 'unknown', 'unknown']);
});

// ---------------------------------------------------------------- weekly view
const person = (id, name, o) => Object.assign({ id, name, importantDates: [], pipelineIds: [], projectIds: [], facts: [], notes: '', archived: false, createdAt: '2026-01-01T00:00:00.000Z' }, o);
const contact = (id, personId, date) => ({ id, personId, date, channel: 'call', notes: '' });
test('weekly view: applications, follow-ups done and due, outreach, people contacted, interviews, offers and sources, hand computed', () => {
  const st = withJobs([
    job({ id: 'a', stage: 'applied', appliedOn: '2026-11-09', source: 'referral', followUp: '2026-11-12', updatedAt: '2026-11-09' }),
    job({ id: 'b', stage: 'interview', appliedOn: '2026-11-15', source: 'referral', followedUpOn: '2026-11-10', followUp: '2026-11-08' }),
    job({ id: 'c', stage: 'offer', appliedOn: '2026-11-08', source: 'recruiter', followedUpOn: '2026-11-16', followUp: '2026-11-16' }),
    job({ id: 'd', stage: 'applied', appliedOn: '2026-11-16', followUp: '2026-11-15' }),
    job({ id: 'e', stage: 'lost', appliedOn: '2026-11-11', followUp: '2026-11-10', lostReason: 'no response' }),
    job({ id: 'f', kind: 'deal', stage: 'applied', appliedOn: '2026-11-10' }),
  ], (s) => {
    s.people.push(person('p1', 'Ann', { pipelineIds: ['a', 'b'] }), person('p2', 'Bo', { pipelineIds: ['d'] }), person('p3', 'Cy', { pipelineIds: ['f'] }), person('p4', 'Di', { pipelineIds: ['a'], archived: true }), person('p5', 'Ed'));
    s.contacts.push(contact('c1', 'p1', '2026-11-09'), contact('c2', 'p1', '2026-11-15'), contact('c3', 'p1', '2026-11-16'), contact('c4', 'p1', '2026-11-08'), contact('c5', 'p2', '2026-11-12'), contact('c6', 'p3', '2026-11-12'), contact('c7', 'p4', '2026-11-12'), contact('c8', 'p5', '2026-11-12'));
  });
  const w = J.weekly(st, '2026-11-12');
  assert.deepEqual([w.week, w.end], [WK, '2026-11-15']);
  // applications in 11-09..11-15: a (09 Monday), b (15 Sunday) and e (11); c (08) and d (16) are outside; f is a deal
  assert.equal(w.applications, 3);
  assert.equal(w.followUpsDone, 1, 'b on the 10th; c on the 16th is next week');
  assert.equal(w.outreach, 3, 'c1 and c2 and c5 by linked people; c3 and c4 outside the week, c6 deal, c7 archived, c8 unlinked');
  assert.equal(w.peopleContacted, 2);
  // due by the end of the week: open items only: a (12), b (11-08 overdue), d (15) = 3; c (16) is later, e is closed
  assert.equal(w.followUpsDue, 3);
  assert.deepEqual([w.interviews, w.offers], [1, 1]);
  assert.deepEqual(w.sources, [{ source: 'referral', count: 2 }, { source: 'unknown', count: 1 }]);
  // any day of the week gives the same week
  for (const d of ['2026-11-09', '2026-11-13', '2026-11-15']) assert.deepEqual(J.weekly(st, d), w, d);
  assert.deepEqual(J.digest(st, '2026-11-12'), { applied: 3, followUpsDue: 3, interviews: 1, offers: 1 });
});
test('weekly view across a month end and a year end: the week is Monday to Sunday and the boundaries are exact', () => {
  const at = (date) => job({ id: 'x' + date, stage: 'applied', appliedOn: date, followedUpOn: date, updatedAt: date });
  // Monday 2026-12-28 to Sunday 2027-01-03 crosses the year end; Monday 2026-11-30 to Sunday 2026-12-06 crosses a month end; 2028-02-28 to 2028-03-05 holds a leap day
  const cases = [
    ['2026-12-31', '2026-12-28', '2027-01-03', ['2026-12-27', '2026-12-28', '2026-12-31', '2027-01-01', '2027-01-03', '2027-01-04'], 4],
    ['2026-11-29', '2026-11-23', '2026-11-29', ['2026-11-22', '2026-11-23', '2026-11-29', '2026-11-30'], 2],
    ['2026-12-01', '2026-11-30', '2026-12-06', ['2026-11-29', '2026-11-30', '2026-12-06', '2026-12-07'], 2],
    ['2028-03-01', '2028-02-28', '2028-03-05', ['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-05', '2028-03-06'], 3],
    ['2027-01-01', '2026-12-28', '2027-01-03', ['2026-12-27', '2027-01-03'], 1],
  ];
  for (const [day, ws, we, dates, n] of cases) {
    const w = J.weekly(withJobs(dates.map(at)), day);
    assert.deepEqual([w.week, w.end, w.applications, w.followUpsDone], [ws, we, n, n], day);
  }
  // the weekly numbers do not depend on the machine's time zone: the same input gives the same output (the suite runs in three zones)
  const st = withJobs(['2026-12-28', '2027-01-03'].map(at));
  assert.equal(J.weekly(st, '2026-12-30').applications, 2);
  // the default "today" used by add and stage moves is the local calendar date
  const s = S.defaultState(), d = new Date(), local = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  assert.equal(J.addJob(s, { role: 'x', stage: 'applied' }).updatedAt, local); assert.equal(s.pipeline[0].appliedOn, local);
  // a follow-up date is compared as a plain date: due on its own day, not the day before
  const f = withJobs([job({ id: 'f', stage: 'applied', followUp: '2026-12-31' })]);
  assert.deepEqual([J.followUps(f, '2026-12-30')[0].due, J.followUps(f, '2026-12-31')[0].due, J.followUps(f, '2026-12-31')[0].overdue, J.followUps(f, '2027-01-01')[0].overdue], [false, true, false, true]);
});

// ---------------------------------------------------------------- follow-ups in review, at a glance, calendar
test('follow-ups: in the weekly review, only a date before today is overdue, not one later this week', () => {
  const st = withJobs([
    job({ id: 'y', title: 'Yesterday role', stage: 'applied', followUp: '2026-11-13' }),
    job({ id: 't', title: 'Today role', stage: 'applied', followUp: TODAY }),
    job({ id: 'l', title: 'Later role', stage: 'applied', followUp: '2026-11-15' }),
  ]);
  // Mid-week (today 11-12): 11-13, 11-14 and 11-15 are all still to come.
  assert.deepEqual(J.reviewWeek(st, WK, '2026-11-12').due.map((x) => [x.id, x.overdue]), [['y', false], ['t', false], ['l', false]]);
  // On 11-14: yesterday's is overdue, today's and Sunday's are not.
  assert.deepEqual(J.reviewWeek(st, WK, TODAY).due.map((x) => [x.id, x.overdue]), [['y', true], ['t', false], ['l', false]]);
  // Without a valid today the week's end is the reference, as before.
  assert.deepEqual(J.reviewWeek(st, WK).due.map((x) => [x.id, x.overdue]), [['y', true], ['t', true], ['l', false]]);
});

test('follow-ups: the review lists those due by the end of the week, at a glance shows the next 30 days, the calendar file uses a generic title', () => {
  const st = withJobs([
    job({ id: 'a', title: 'Alpha role at Alpha Corp', stage: 'applied', followUp: '2026-11-10' }),
    job({ id: 'b', title: 'Beta role', stage: 'interview', followUp: '2026-11-15' }),
    job({ id: 'c', title: 'Gamma role', stage: 'lead', followUp: '2026-11-20' }),
    job({ id: 'd', title: 'Delta role', stage: 'won', followUp: '2026-11-16' }),
    job({ id: 'e', title: 'Epsilon role', stage: 'applied', followUp: '2026-12-30' }),
    job({ id: 'f', title: 'Zeta role', stage: 'applied', followUp: '2027-01-01' }),
    job({ id: 'g', kind: 'deal', title: 'Deal', stage: 'applied', followUp: '2026-11-16' }),
  ]);
  const r = J.reviewWeek(st, WK, TODAY);
  assert.deepEqual(r.due.map((x) => [x.id, x.overdue]), [['a', true], ['b', false]]);
  assert.equal(r.weekly.followUpsDue, 2);
  assert.equal(J.followUps(st, TODAY).length, 5);
  // at a glance: a provider; an overdue one shows today, labelled
  const g = Ac.glance(st, TODAY), mine = [...g.today, ...g.week, ...g.later].filter((x) => x.source === 'job-followups');
  assert.deepEqual(mine.map((x) => [x.id, x.date, x.title]), [['a', TODAY, 'Follow up (overdue): Alpha role at Alpha Corp'], ['b', '2026-11-15', 'Follow up: Beta role'], ['c', '2026-11-20', 'Follow up: Gamma role'], ['e', '2026-12-30', 'Follow up: Epsilon role']].filter((x) => x[1] <= '2026-12-14'));
  assert.ok(Ac.glanceProviders().some((p) => p.id === 'job-followups' && p.label === 'Job follow-ups'));
  // calendar: generic by default, real titles only on the tick; closed items of other kinds and finished applications are not in it
  const ics = Cal.build(st, { today: TODAY, stamp: new Date('2026-11-14T10:00:00Z') });
  assert.equal((ics.text.match(/SUMMARY:LifeOS: follow-up due/g) || []).length, 4);
  for (const t of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Deal']) assert.ok(!ics.text.includes(t), t + ' in the generic file');
  assert.ok(ics.text.includes('DTSTART;VALUE=DATE:20261115') && ics.text.includes('DTSTART;VALUE=DATE:20261230') && !ics.text.includes('DTSTART;VALUE=DATE:20261110'), 'overdue dates are not put in the past');
  const real = Cal.build(st, { today: TODAY, realTitles: true, stamp: new Date('2026-11-14T10:00:00Z') });
  assert.ok(real.text.includes('SUMMARY:LifeOS: Beta role'));
  assert.equal(Cal.build(st, { today: TODAY, stamp: new Date('2026-11-14T10:00:00Z') }).text, ics.text, 'stable: the same file again');
  assert.ok(Cal.KINDS.includes('followup'));
  // UIDs are stable and differ per application
  const uids = ics.text.match(/UID:[^\r]+/g); assert.equal(new Set(uids).size, uids.length);
});

// ---------------------------------------------------------------- people links, one-tap contact log
test('people: linked through the existing pipeline links, last contact shown, one-tap log; unlinking and deleting never delete the other side', () => {
  const s = S.defaultState();
  const it = J.addJob(s, { role: 'AE', org: 'Co', stage: 'applied' }, '2026-11-01');
  const ann = So.addPerson(s, { name: 'Ann Recruiter' }), bo = So.addPerson(s, { name: 'Bo Other' });
  assert.throws(() => J.logContact(s, it.id, ann.id, TODAY), /not linked/);
  So.linkPipeline(s, ann.id, it.id);
  assert.deepEqual(J.peopleOf(s, it.id, TODAY), [{ id: ann.id, name: 'Ann Recruiter', last: null }]);
  const c = J.logContact(s, it.id, ann.id, '2026-11-12');
  assert.deepEqual([c.personId, c.date, c.channel], [ann.id, '2026-11-12', 'other']);
  assert.equal(it.updatedAt, '2026-11-12');
  assert.equal(J.logContact(s, it.id, ann.id, '2026-11-13', 'call').channel, 'call');
  assert.throws(() => J.logContact(s, it.id, ann.id, '2026-11-13', 'carrier pigeon'), /channel/);
  assert.deepEqual(J.peopleOf(s, it.id, '2026-11-14')[0], { id: ann.id, name: 'Ann Recruiter', last: '2026-11-13' });
  assert.throws(() => J.logContact(s, 'missing', ann.id, TODAY), /not found/);
  assert.throws(() => J.logContact(s, it.id, bo.id, TODAY), /not linked/);
  assert.equal(J.weekly(s, '2026-11-12').outreach, 2);
  // the Work pipeline's own linking still shows the person on the item (v0.10.0) and unlinking keeps both
  So.unlinkPipeline(s, ann.id, it.id);
  assert.equal(s.people.length, 2); assert.equal(s.pipeline.length, 1); assert.equal(s.contacts.length, 2);
  // deleting the application unlinks the person on the next validation and keeps the person and the log
  So.linkPipeline(s, ann.id, it.id);
  s.pipeline = [];
  const got = S.validateState(clone(Object.assign(s, { schema: 18 })));
  assert.deepEqual(got.people.find((p) => p.id === ann.id).pipelineIds, []); assert.equal(got.contacts.length, 2);
});

// ---------------------------------------------------------------- CSV import
const csvOf = (rows) => C.parse(rows.join('\n'));
const MAP = { role: 'role', company: 'company', stage: 'stage', location: 'location', source: 'source', appliedOn: 'applied', followUp: 'follow up', resume: 'resume', lostReason: 'reason', notes: 'notes', nextStep: 'next', targetOte: 'target ote', targetBase: 'target base', offerOte: 'offer ote', offerBase: 'offer base' };
const mapOf = (p) => { const m = {}; p.headers.forEach((h, i) => { for (const [k, v] of Object.entries(MAP)) if (v === h.toLowerCase()) m[k] = i; }); return m; };
const HEAD = 'Role,Company,Stage,Location,Source,Applied,Follow up,Resume,Reason,Notes,Next,Target OTE,Target base,Offer OTE,Offer base';
const plan = (rows, o, st) => { const p = csvOf(rows); return J.planImport(p, Object.assign({ map: mapOf(p) }, o || {}), st || S.getState(), TODAY); };
const importIn = async (rows, o) => { const pl = await plan(rows, o); await S.commit((x) => { J.applyImport(x, pl); }); return pl; };
const ROWS = [HEAD,
  'Account Executive,Acme,applied,remote,referral,2026-10-05,2026-11-20,v3,,Great team,call,"$175,000.50",120000,,',
  'Sales Lead,Beta Inc,interview,Hybrid,Recruiter,11/02/2026,,v2,,,,,,,',
  'Partner Manager,Gamma LLC,lost,on-site,Job Board,2026-09-01,,v1,rejected,,,,,,"90,000"',
];
test('CSV import: map, preview and confirm; nothing is written until confirmed; every field lands with the right type; cents are exact', async () => {
  await vault(null);
  const pl = await plan(ROWS);
  assert.deepEqual([pl.rows, pl.add.length, pl.rejected.length, pl.duplicates, pl.empty], [3, 3, 0, 0, false]);
  assert.deepEqual(pl.byStage, { applied: 1, interview: 1, lost: 1 });
  assert.equal(S.getState().pipeline.length, 0, 'a preview writes nothing');
  const a = pl.add[0];
  assert.deepEqual([a.title, a.org, a.role, a.stage, a.locationType, a.source, a.appliedOn, a.followUp, a.resume, a.notes, a.nextStep, a.targetOteCents, a.targetBaseCents], ['Account Executive at Acme', 'Acme', 'Account Executive', 'applied', 'remote', 'referral', '2026-10-05', '2026-11-20', 'v3', 'Great team', 'call', 17500050, 12000000]);
  assert.match(a.importKey, /^[0-9a-f]{64}$/);
  assert.deepEqual([pl.add[1].stage, pl.add[1].appliedOn, pl.add[1].locationType, pl.add[1].source], ['interview', '2026-11-02', 'hybrid', 'recruiter'], 'MM/DD/YYYY, any case');
  assert.deepEqual([pl.add[2].stage, pl.add[2].lostReason, pl.add[2].locationType, pl.add[2].source, pl.add[2].offerBaseCents], ['lost', 'rejected', 'on site', 'job board', 9000000]);
  const res = await importIn(ROWS);
  assert.equal(S.getState().pipeline.length, 3);
  assert.ok(S.getState().pipeline.every((x) => x.kind === 'job' && /^[0-9a-z]+/.test(x.id) && x.updatedAt === TODAY));
  // the same file again adds nothing and says so
  const again = await plan(ROWS);
  assert.deepEqual([again.add.length, again.duplicates, again.empty], [0, 3, true]);
  // a row repeated inside one file imports twice and a re-import still adds nothing
  const twice = [HEAD, 'Dup,Delta,applied,,,2026-11-01,,,,,,,,,', 'Dup,Delta,applied,,,2026-11-01,,,,,,,,,'];
  assert.equal((await plan(twice)).add.length, 2);
  await importIn(twice); assert.equal(S.getState().pipeline.length, 5);
  assert.deepEqual([(await plan(twice)).add.length, (await plan(twice)).duplicates], [0, 2]);
  assert.ok(res);
});
test('CSV import: unknown stage, location, source and reason values are offered and never created; mapped values are used; rows with an unmapped stage are rejected', async () => {
  await vault(null);
  const rows = [HEAD, 'AE,One,Screening,Space,Glassdoor,2026-11-01,,,Ghosted,,,,,,', 'AE,Two,screening,,,2026-11-02,,,,,,,,,', 'AE,Three,applied,,,2026-11-03,,,,,,,,,'];
  const pl = await plan(rows);
  assert.deepEqual(pl.unknown, { stage: ['Screening'], location: [], source: [], lostReason: [] }, 'one entry per distinct value; row one is rejected before its other values are read');
  assert.deepEqual(pl.rejected.map((r) => r.row), [2, 3]); assert.match(pl.rejected[0].reason, /stage is not one of the stages/); assert.ok(!/Screening/i.test(JSON.stringify(pl.rejected)), 'SEC-110: no cell text in a reason');
  assert.equal(pl.add.length, 1);
  const pl2 = await plan(rows, { values: { stage: { screening: 'interview' }, location: { space: 'remote' } } });
  assert.deepEqual(pl2.rejected, []); assert.equal(pl2.add.length, 3);
  assert.deepEqual(pl2.unknown, { stage: [], location: [], source: ['Glassdoor'], lostReason: [] });
  assert.deepEqual([pl2.add[0].stage, pl2.add[0].locationType, pl2.add[0].source, pl2.add[0].lostReason], ['interview', 'remote', '', undefined], 'an unknown source stays empty until mapped; a reason applies only to a lost item');
  const pl3 = await plan(rows, { values: { stage: { screening: 'lost' }, source: { glassdoor: 'job board' }, lostReason: { ghosted: 'no response' } } });
  assert.deepEqual([pl3.add[0].stage, pl3.add[0].source, pl3.add[0].lostReason], ['lost', 'job board', 'no response']);
  // a mapping to something that is not on the list is ignored, never created
  const pl4 = await plan(rows, { values: { stage: { screening: 'phone screen' } } });
  assert.deepEqual(pl4.unknown.stage, ['Screening']); assert.equal(pl4.add.length, 1);
  await importIn(rows, { values: { stage: { screening: 'interview' } } });
  assert.ok(S.getState().pipeline.every((x) => ['interview', 'applied'].includes(x.stage)));
  assert.equal(S.getState().projects.length, 0); assert.equal(S.getState().people.length, 0);
});
test('CSV import: rejected rows say why, the stage default applies without a stage column, dates need an explicit DD/MM/YYYY choice, secrets and caps are enforced', async () => {
  await vault(null);
  const rows = [HEAD,
    ',,applied,,,,,,,,,,,,', 'AE,Co,applied,,,2026-02-30,,,,,,,,,', 'AE,Co,applied,,,,not a date,,,,,,,,', 'AE,Co,applied,,,,,,,,,abc,,,', 'AE,Co,applied,,,,,,,,,-5,,,',
    'AE,' + 'C'.repeat(201) + ',applied,,,,,,,,,,,,', 'AE,Co,applied,,,,,' + 'r'.repeat(61) + ',,,,,,,', 'AE,Co,applied,,,,,,,card 4111 1111 1111 1111,,,,,', 'AE,Co,applied,,,,,,,' + 'n'.repeat(2001) + ',,,,,', 'short,row',
    'Ok,Fine,applied,,,13/11/2026,,,,,,,,,'];
  const pl = await plan(rows);
  assert.deepEqual(pl.rejected.map((r) => r.row), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.match(pl.rejected[0].reason, /both empty/); assert.match(pl.rejected[1].reason, /applied date/); assert.match(pl.rejected[2].reason, /follow-up date/); assert.match(pl.rejected[3].reason, /not an amount/);
  assert.match(pl.rejected[5].reason, /200/); assert.match(pl.rejected[6].reason, /60/); assert.match(pl.rejected[7].reason, /ID or card/); assert.match(pl.rejected[8].reason, /2000/); assert.match(pl.rejected[9].reason, /columns/);
  assert.ok(!JSON.stringify(pl.rejected).includes('4111'), 'a rejection never repeats the text');
  const dmy = await plan([HEAD, rows[rows.length - 1]], { dateFormat: 'dmy' });
  assert.deepEqual([dmy.add.length, dmy.add[0].appliedOn], [1, '2026-11-13']);
  // no stage column: every row takes the chosen stage (applied by default) and an applied stage gets the applied date
  const p = csvOf(['Role,Company', 'AE,Co']);
  const noStage = await J.planImport(p, { map: { role: 0, company: 1 } }, S.getState(), TODAY);
  assert.deepEqual([noStage.add[0].stage, noStage.add[0].appliedOn], ['applied', TODAY]);
  const lead = await J.planImport(p, { map: { role: 0, company: 1 }, defaultStage: 'lead' }, S.getState(), TODAY);
  assert.deepEqual([lead.add[0].stage, lead.add[0].appliedOn], ['lead', undefined]);
  await assert.rejects(J.planImport(p, { map: { role: 0, company: 1 }, defaultStage: 'nowhere' }, S.getState(), TODAY), /stage/);
  await assert.rejects(J.planImport(p, { map: { stage: 0 } }, S.getState(), TODAY), /company or the role/);
  await assert.rejects(J.planImport(p, { map: { role: 9 } }, S.getState(), TODAY), /Column not found/);
  await assert.rejects(J.planImport(p, {}, S.getState(), TODAY), /mapping/);
  await assert.rejects(J.planImport(null, { map: {} }, S.getState(), TODAY), /Nothing to import/);
  // caps: the 1000 item limit counts what is already there
  const big = S.defaultState(); big.pipeline = Array.from({ length: 999 }, (_, i) => job({ id: 'j' + i }));
  await assert.rejects(J.planImport(csvOf(['Role,Company', 'A,B', 'C,D']), { map: { role: 0, company: 1 } }, big, TODAY), /1000/);
  // formula cells are tidied (a leading quote that neutralised an export is removed) and the importKey ignores case and spacing
  const k1 = await plan(['Role,Company', "'=SUM(1),Acme  Corp"]);
  assert.equal(k1.add[0].role, '=SUM(1)');
  assert.equal(await J.importKey('Acme  Corp', 'AE', '2026-11-01', 0), await J.importKey('acme corp', ' ae ', '2026-11-01', 0));
  assert.notEqual(await J.importKey('a', 'b', '2026-11-01', 0), await J.importKey('a', 'b', '2026-11-01', 1));
});
test('CSV import and the private vault: closed with private applications it refuses, open it sees every application and can import as private', async () => {
  const cur = withJobs([job({ id: 'pub', title: 'Public one', org: 'PubCo', stage: 'applied' })]);
  await vault(cur, { priv: true });
  await P.open(PRIV);
  await P.moveIn('pipeline', 'pub');
  assert.deepEqual(S.getState().pipeline, [], 'the main state holds nothing');
  const privMark = P.marks(S.getState());
  assert.ok(privMark.includes('pipeline'));
  P.close('test');
  const blocked = await J.planImport(csvOf(['Role,Company', 'AE,PubCo']), { map: { role: 0, company: 1 } }, S.getState(), TODAY);
  assert.equal(blocked.blocked, 'private'); assert.deepEqual([blocked.add.length, blocked.empty], [0, true]);
  assert.deepEqual(J.applyImport(S.getState(), blocked), { added: 0, ids: [] });
  assert.throws(() => J.applyImport(S.getState(), { add: [{}] }), /Open the private vault/);
  // open: the preview works against the merged view and recognises a private application already imported
  await P.open(PRIV);
  const rows = ['Role,Company,Applied', 'Account Exec,PrivCo,2026-11-01', 'Sales,OtherCo,2026-11-02'];
  const pl = await J.planImport(csvOf(rows), { map: { role: 0, company: 1, appliedOn: 2 }, asPrivate: true }, P.view(S.getState()), TODAY);
  assert.equal(pl.add.length, 2); assert.equal(pl.asPrivate, true);
  await P.write((x) => { J.applyImport(x, pl); }, { newPrivate: true });
  assert.equal(S.getState().pipeline.length, 0, 'imported as private: nothing in the main state');
  assert.equal(P.view(S.getState()).pipeline.length, 3);
  const again = await J.planImport(csvOf(rows), { map: { role: 0, company: 1, appliedOn: 2 }, asPrivate: true }, P.view(S.getState()), TODAY);
  assert.deepEqual([again.add.length, again.duplicates], [0, 2], 'private rows already imported are recognised while open');
  // a public import while open lands in the main state
  const pub = await J.planImport(csvOf(['Role,Company', 'Public AE,PublicCo']), { map: { role: 0, company: 1 } }, P.view(S.getState()), TODAY);
  await P.write((x) => { J.applyImport(x, pub); }); // no newPrivate: stays public
  assert.deepEqual(S.getState().pipeline.map((x) => x.org), ['PublicCo']);
  P.close('test');
});

// ---------------------------------------------------------------- the private vault: numbers and lists
test('private applications are excluded from every number, list and file while the vault is closed, and included while it is open', async () => {
  const st = withJobs([
    job({ id: 'pub', title: 'Public role', stage: 'applied', appliedOn: '2026-11-10', followUp: '2026-11-15', updatedAt: '2026-11-10' }),
    job({ id: 'prv', title: 'Private role', stage: 'offer', appliedOn: '2026-11-10', followUp: '2026-11-15', updatedAt: '2026-11-10' }),
  ]);
  await vault(st, { priv: true });
  await P.open(PRIV);
  await P.moveIn('pipeline', 'prv');
  const open = P.view(S.getState());
  assert.equal(J.jobsOf(open).length, 2); assert.equal(J.weekly(open, WK).offers, 1);
  assert.deepEqual(Ac.glance(open, TODAY).week.filter((x) => x.source === 'job-followups').map((x) => x.id).sort(), ['prv', 'pub']);
  P.close('test');
  const main = S.getState();
  assert.equal(J.jobsOf(main).length, 1); assert.deepEqual(J.digest(main, WK), { applied: 1, followUpsDue: 1, interviews: 0, offers: 0 });
  assert.equal(J.funnel(main).total, 1);
  assert.deepEqual(Ac.glance(main, TODAY).week.filter((x) => x.source === 'job-followups').map((x) => x.id), ['pub']);
  assert.ok(!Cal.build(main, { today: TODAY, realTitles: true }).text.includes('Private role'));
  // even with the vault open, the digest, the review record and the calendar default use the main state alone
  await P.open(PRIV);
  assert.deepEqual(M.weeklyDigest(P.view(S.getState()), WK).jobs, { applied: 1, followUpsDue: 1, interviews: 0, offers: 0 });
  assert.ok(!Cal.build(P.view(S.getState()), { today: TODAY, realTitles: true }).text.includes('Private role'));
  assert.ok(Cal.build(P.view(S.getState()), { today: TODAY, realTitles: true, includePrivate: true }).text.includes('LifeOS: Private role'));
  // a private person linked to a public application keeps the link private (the link overlay), and the closed view shows no link
  P.close('test');
});

// ---------------------------------------------------------------- AI: compensation and text never leave the vault
const NUMS = ['8765432100', '7654321100', '6543211100', '5432111100', '87654321', '76543211', '65432111', '54321111', '87,654,321', '76,543,211', '6543211', '5432111'];
test('the digest gains four numbers; no company, role, person, note, source, resume or compensation is in the digest, any prompt, an insight, the audit log or an error', async () => {
  const { state } = buildAdversarial(L);
  const pl2 = state.pipeline.find((x) => x.id === 'pl2');
  assert.equal(pl2.targetOteCents, 8765432100); assert.ok(pl2.notes.includes(ADV_MARK));
  const dg = M.weeklyDigest(state, WK);
  assert.deepEqual(Object.keys(dg.jobs).sort(), ['applied', 'followUpsDue', 'interviews', 'offers']);
  assert.deepEqual(dg.jobs, { applied: 1, followUpsDue: 1, interviews: 0, offers: 0 });
  const seen = [JSON.stringify(dg)];
  for (const [lvl, period] of [[1, { from: WK, to: '2026-11-15' }], [2, { from: '2026-11-01', to: '2026-11-30' }], [3, { from: '2026-10-01', to: '2026-12-31' }]]) { const p = Mem.buildPrompt(state, lvl, period); seen.push(p.system, p.user); }
  const p1 = Mem.buildPrompt(state, 1, { from: WK, to: '2026-11-15' });
  assert.match(p1.user, /job search detail \(numbers only\): applications this week 1, follow-ups due 1, interviews 0, offers 0/);
  seen.push(JSON.stringify(Mem.rulesInsights(state, WK)), JSON.stringify(Mem.buildPrompt(state, 1, { from: WK, to: '2026-11-15' })));
  const all = seen.join('\n');
  assert.ok(!all.includes(ADV_MARK), 'no marker text anywhere in what the AI or the digest sees');
  for (const n of NUMS) assert.ok(!all.includes(n), 'compensation ' + n);
  for (const w of ['Role plain', 'hybrid', 'resume version']) assert.ok(!all.toLowerCase().includes(w.toLowerCase()), w);
  // errors raised by the job functions never carry what was typed
  const s = S.defaultState();
  for (const input of [{ role: ADV_MARK + 'x'.repeat(300) }, { role: 'ok', targetOte: ADV_MARK + 'abc' }, { role: 'ok', locationType: ADV_MARK }, { role: 'ok', appliedOn: ADV_MARK }, { role: 'ok', resume: ADV_MARK.repeat(10) }]) {
    try { J.addJob(s, input, TODAY); assert.fail('accepted'); } catch (e) { assert.ok(!e.message.includes(ADV_MARK), 'error echoes input: ' + e.message); }
  }
  try { S.validateState(Object.assign(clone(state), { pipeline: [Object.assign({}, pl2, { role: ADV_MARK + 'x'.repeat(300) })] })); assert.fail('accepted'); } catch (e) { assert.ok(!e.message.includes(ADV_MARK)); }
  // the job functions never write the audit log or the diagnostics ring
  const st = S.defaultState(); const before = JSON.stringify([st.audit, st.ops.diag]);
  const it = J.addJob(st, { role: ADV_MARK, org: 'C', stage: 'applied' }, TODAY); J.setStage(st, it.id, 'lost', TODAY, 'rejected'); J.markFollowedUp(st, it.id, TODAY);
  assert.equal(JSON.stringify([st.audit, st.ops.diag]), before);
  // a stored review keeps the four numbers only
  const rv = S.validateState(Object.assign(clone(state), { memory: Object.assign(clone(state.memory), { reviews: [{ id: 'r1', weekOf: WK, digest: dg, priorities: ['a', 'b', 'c'], completedAt: '2026-11-14T10:00:00.000Z' }] }) })).memory.reviews[0].digest;
  assert.deepEqual(rv.jobs, dg.jobs);
  assert.ok(!JSON.stringify(rv).includes(ADV_MARK));
});
test('the digest sends nothing about jobs when there are none (the prompt has no job line)', () => {
  const p = Mem.buildPrompt(S.validateState(S.defaultState()), 1, { from: WK, to: '2026-11-15' });
  assert.ok(!/job search/.test(p.user));
  assert.deepEqual(M.weeklyDigest(S.validateState(S.defaultState()), WK).jobs, { applied: 0, followUpsDue: 0, interviews: 0, offers: 0 });
});
test('with the vault open a private application is still absent from the prompt and the digest', async () => {
  const st = withJobs([job({ id: 'prv', title: 'PRIVTITLE', org: 'PRIVCO', stage: 'offer', appliedOn: '2026-11-10', targetOteCents: 9999999900 })]);
  await vault(st, { priv: true });
  await P.open(PRIV); await P.moveIn('pipeline', 'prv');
  const v = P.view(S.getState());
  const p = Mem.buildPrompt(v, 1, { from: WK, to: '2026-11-15' });
  assert.ok(!/PRIV|99999999/.test(p.system + p.user));
  assert.deepEqual(M.weeklyDigest(v, WK).jobs, { applied: 0, followUpsDue: 0, interviews: 0, offers: 0 });
});

// ---------------------------------------------------------------- performance at the caps
test('performance at the caps: 1000 applications with people and contacts at their caps validate, summarise and import quickly', async () => {
  const items = Array.from({ length: 1000 }, (_, i) => job(Object.assign({ id: 'j' + i, stage: ['lead', 'contacted', 'applied', 'interview', 'offer', 'won', 'lost'][i % 7], appliedOn: '2026-' + String(1 + (i % 11)).padStart(2, '0') + '-' + String(1 + (i % 27)).padStart(2, '0'), followUp: '2026-11-' + String(1 + (i % 28)).padStart(2, '0'), source: ['referral', 'recruiter', 'x', '', 'direct'][i % 5], updatedAt: '2026-11-01' }, OLDFIELDS, { appliedOn: '2026-' + String(1 + (i % 11)).padStart(2, '0') + '-' + String(1 + (i % 27)).padStart(2, '0'), followUp: '2026-11-' + String(1 + (i % 28)).padStart(2, '0') })));
  const t0 = Date.now();
  const st = withJobs(items, (s) => {
    for (let i = 0; i < 1000; i++) s.people.push(person('p' + i, 'Person ' + i, { pipelineIds: ['j' + i, 'j' + ((i + 1) % 1000)] }));
    for (let i = 0; i < 20000; i++) s.contacts.push(contact('c' + i, 'p' + (i % 1000), '2026-11-' + String(1 + (i % 28)).padStart(2, '0')));
  });
  const tv = Date.now() - t0, t1 = Date.now();
  const f = J.funnel(st), w = J.weekly(st, WK), d = J.digest(st, WK), fu = J.followUps(st, TODAY), r = J.reviewWeek(st, WK, TODAY), g = Ac.glance(st, TODAY), ics = Cal.build(st, { today: TODAY });
  const tc = Date.now() - t1;
  assert.equal(f.total, 1000); assert.ok(w.outreach > 0 && d.applied >= 0 && fu.length > 0 && r.due.length > 0 && g.count >= 0 && ics.count > 0);
  for (const p of J.peopleOf(st, 'j5', TODAY)) assert.ok(p.name);
  assert.ok(tv < 8000, 'validate ' + tv + ' ms'); assert.ok(tc < 3000, 'numbers ' + tc + ' ms');
  // a 1000 row import previews in a few seconds
  const rows = ['Role,Company,Applied'].concat(Array.from({ length: 1000 }, (_, i) => 'Role ' + i + ',Co ' + i + ',2026-10-' + String(1 + (i % 28)).padStart(2, '0')));
  const t2 = Date.now(); const pl = await J.planImport(csvOf(rows), { map: { role: 0, company: 1, appliedOn: 2 } }, S.defaultState(), TODAY);
  assert.equal(pl.add.length, 1000); assert.ok(Date.now() - t2 < 8000, 'import preview ' + (Date.now() - t2) + ' ms');
});
