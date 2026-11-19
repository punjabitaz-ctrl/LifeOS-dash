// v1.6.0 audit (SEC-110 to SEC-115): regression tests for each finding, plus the proofs the audit relied on: compensation and job
// text never reach the AI or any file that leaves the vault, the funnel and weekly definitions match between the tab and the digest,
// the search index holds nothing private after a close (also with a write in flight), followedUpOn is validated and migrated, and the
// UI has no clashing top-level function names (the pctText clash the builder fixed). Markers searched for contain spaces.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L, PASS, memAdapter } from './_load.mjs';
import { fastKeys, realKeys, clone, PRIV } from './_archive.mjs';
import { buildAdversarial, ADV_MARK } from './_adversarial.mjs';

const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), J = view('jobs'), M = view('metrics'), Mem = view('memory'), P = view('priv'), Q = view('search'), O = view('ops'), CAL = view('calendar'), W = view('wellbeing');
const nope = async () => { throw new Error('NO_STORAGE'); };
const NOSTORE = { get: nope, set: nope, del: nope };
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { P.close('system'); } catch (e) { /* closed */ } try { S.lock(); } catch (e) { /* locked */ } S._setAdapter(NOSTORE); realKeys(); } });
const ROOT = new URL('..', import.meta.url);
const src = (f) => readFileSync(new URL(f, ROOT), 'utf8');
const TODAY = '2026-11-14', WK = '2026-11-09';
const job = (o) => Object.assign({ id: 'j' + Math.random().toString(36).slice(2, 8), title: 'Role', org: 'Co', kind: 'job', stage: 'lead', source: '', nextStep: '', updatedAt: '2026-11-01', notes: '' }, o);
const csvOf = (lines) => L.csv.parse(lines.join('\n'));
async function vault(state, o = {}) {
  S._setAdapter(memAdapter()); S.lock(); await S.init(PASS);
  if (state) await S.replaceState(state);
  if (o.priv) await P.setUp(PRIV);
}
// Compensation of the adversarial job in every way a number could be written.
const COMP = [8765432100, 7654321100, 6543211100, 5432111100];
const compForms = () => COMP.flatMap((c) => { const d = Math.floor(c / 100); return [String(c), String(d), d.toLocaleString('en-US'), (c / 100).toFixed(2), String(c / 100)]; });

test('SEC-110: a rejected import row never carries cell text in its reason (a card number in the stage cell included)', async () => {
  await vault(null);
  const card = '4111 1111 1111 1111';
  const pl = await J.planImport(csvOf(['Role,Company,Stage', 'AE,One,' + card, 'AE,Two,Screening call', 'AE,Three,applied']), { map: { role: 0, company: 1, stage: 2 } }, S.getState(), TODAY);
  assert.deepEqual(pl.rejected.map((r) => r.row), [2, 3]);
  for (const r of pl.rejected) { assert.equal(r.reason, 'stage is not one of the stages; map the value below'); }
  const reasons = JSON.stringify(pl.rejected);
  for (const bad of ['4111', 'Screening', 'One', 'Two']) assert.ok(!reasons.includes(bad), bad);
  assert.equal(pl.add.length, 1);
  assert.deepEqual(S.getState().pipeline, [], 'the preview wrote nothing');
});

test('SEC-111: a job moved or added on the Work board at applied or later gets its applied date and counts in the week and the digest', () => {
  const s = S.validateState(S.defaultState());
  // the Work add form: an item of kind job at "applied", stamped as the UI now does
  const added = { id: 'w1', title: 'Board add', org: 'Acme', kind: 'job', stage: 'applied', source: '', nextStep: '', updatedAt: TODAY, notes: '' };
  J.stamp(added, added.stage, TODAY); s.pipeline.push(added);
  // the Work board: a lead moved to applied, then to lost and back (the reason goes when it leaves lost)
  const moved = job({ id: 'w2', stage: 'lead' }); s.pipeline.push(moved);
  J.stamp(moved, 'applied', TODAY);
  assert.equal(moved.appliedOn, TODAY); assert.equal(added.appliedOn, TODAY);
  J.stamp(moved, 'lost', '2026-11-15'); moved.lostReason = 'rejected'; J.stamp(moved, 'interview', '2026-11-15');
  assert.equal(moved.lostReason, undefined); assert.equal(moved.appliedOn, TODAY, 'the applied date is set once');
  // a deal is never touched
  const deal = { id: 'd1', kind: 'deal', stage: 'lead', title: 'x', updatedAt: '2026-11-01' };
  J.stamp(deal, 'applied', TODAY); assert.deepEqual(deal, { id: 'd1', kind: 'deal', stage: 'lead', title: 'x', updatedAt: '2026-11-01' });
  const v = S.validateState(clone(s));
  assert.equal(J.weekly(v, WK).applications, 2);
  assert.equal(M.weeklyDigest(v, WK).jobs.applied, 2);
  // the UI uses the shared rule on the Work board and its add form
  const app = src('src/ui/app.js');
  assert.match(app, /setItem\(it, function \(z\) \{ z\.stage = nxt; L\.jobs\.stamp\(z, nxt, t\); \}/);
  assert.match(app, /setItem\(it, function \(z\) \{ z\.stage = v; L\.jobs\.stamp\(z, v, t\); \}/);
  assert.match(app, /L\.jobs\.stamp\(it, it\.stage, t\); \/\/ SEC-111/);
});

test('SEC-112: the two follow-up numbers on the Job search screen have different labels that say what they count', () => {
  const app = src('src/ui/app.js');
  assert.match(app, /stat\('Follow-ups due today', String\(due\.length\), 'js-due'/);
  assert.match(app, /stat\('Follow-ups due by the end of the week', String\(w\.followUpsDue\), 'jw-due'\)/);
  assert.ok(!/stat\('Follow-ups due', /.test(app));
});

test('SEC-113: SPEC.md records the funnel and weekly definitions, followedUpOn and the review step as an amendment', () => {
  const spec = src('SPEC.md'), add = spec.slice(spec.indexOf('## v1.6.0 addendum'));
  const am = add.slice(add.indexOf('### Amendment'));
  assert.ok(am.length > 200, 'an amendment section exists');
  for (const want of ['Applied:', 'Response rate', 'Interview rate', 'Offer rate', 'no data', 'followedUpOn', 'Job search follow-ups', 'interviews', 'offers', 'Follow-ups due today', 'by the end of the week']) assert.ok(am.includes(want), want);
});

test('SEC-114: compensation, role, resume label, company, people, source and notes never reach the AI or a file that leaves the vault', async () => {
  const { state } = buildAdversarial(L);
  const pl2 = state.pipeline.find((x) => x.id === 'pl2');
  assert.ok(pl2.role.includes(ADV_MARK) && pl2.resume.includes(ADV_MARK), 'the fixture marks the role and the resume label');
  assert.deepEqual([pl2.targetOteCents, pl2.targetBaseCents, pl2.offerOteCents, pl2.offerBaseCents], COMP);
  // one more job at offer with a follow-up today, so offers, interviews and follow-up numbers are non-zero
  state.pipeline.push(job({ id: 'pl3', title: ADV_MARK + 'offer title', org: ADV_MARK + 'offer co', role: ADV_MARK + 'offer role', stage: 'offer', appliedOn: '2026-11-03', followUp: TODAY, offerOteCents: 8765432100, resume: ADV_MARK + 'r2', notes: ADV_MARK + 'n2' }));
  const s = S.validateState(clone(state));
  const out = [];
  for (const wk of ['2026-11-02', WK, '2026-11-16']) {
    out.push(JSON.stringify(M.weeklyDigest(s, wk)), JSON.stringify(Mem.rulesInsights(s, wk)));
    for (const [lv, per] of [[1, { from: wk, to: L.home.dates.addDays(wk, 6) }], [2, { from: '2026-11-01', to: '2026-11-30' }], [3, { from: '2026-10-01', to: '2026-12-31' }]]) { const p = Mem.buildPrompt(s, lv, per); out.push(p.system, p.user); }
  }
  // consolidation: approve level 1 rules insights, then the offers and the rules-only merge
  const ins = Mem.rulesInsights(s, WK);
  Mem.propose(s, ins.length ? ins : [{ domain: 'work', text: 'Pipeline moved' }], { level: 1, period: { from: WK, to: '2026-11-15' }, source: 'rules' });
  for (const i of s.memory.insights) Mem.decide(s, i.id, 'approved');
  out.push(JSON.stringify(Mem.consolidationOffers(s, '2026-12-02')));
  Mem.mergeByRules(s, 2, { from: '2026-11-01', to: '2026-11-30' });
  out.push(JSON.stringify(s.memory.insights));
  // a target proposal and its preview
  Mem.propose(s, [{ domain: 'social', text: 'Contact more often', target: { key: 'contactDays', value: 10 } }], { level: 1, period: { from: WK, to: '2026-11-15' }, source: 'ai' });
  out.push(JSON.stringify(Mem.targetPreview(s, s.memory.insights[s.memory.insights.length - 1].id)));
  // the calendar file, generic by default
  const cal = CAL.build(s, { today: '2026-11-10', stamp: new Date('2026-11-10T00:00:00Z') });
  assert.ok(cal.text.includes('LifeOS: follow-up due'), 'the follow-ups are in the file');
  out.push(cal.text);
  // diagnostics after job errors raised with marked input
  const w = clone(s);
  for (const input of [{ role: ADV_MARK + 'x'.repeat(300) }, { role: 'ok', targetOte: ADV_MARK + '87654321' }, { role: 'ok', offerBase: '-5' }, { role: 'ok', resume: ADV_MARK.repeat(10) }, { role: 'ok', followUp: ADV_MARK }]) {
    try { J.addJob(w, input, TODAY); assert.fail('accepted'); } catch (e) { out.push(e.message); O.recordError(e, 'work'); }
  }
  try { J.setStage(w, 'pl2', ADV_MARK); } catch (e) { out.push(e.message); }
  try { S.validateState(Object.assign(clone(state), { pipeline: [Object.assign(clone(pl2), { targetOteCents: -1 })] })); } catch (e) { out.push(e.message); }
  try { S.validateState(Object.assign(clone(state), { pipeline: [Object.assign(clone(pl2), { resume: ADV_MARK.repeat(9) })] })); } catch (e) { out.push(e.message); }
  out.push(O.format(s, { version: '1.6.0', userAgent: 'Chrome' }));
  const all = out.join('\n');
  assert.ok(!all.includes(ADV_MARK), 'no marker');
  const flat = all.replace(/[ ,.$]/g, '');
  for (const f of compForms()) assert.ok(!all.includes(f) && !flat.includes(f.replace(/[ ,.$]/g, '')), 'compensation ' + f);
  assert.match(all, /job search detail \(numbers only\): applications this week 1, follow-ups due 2, interviews 0, offers 1/);
  // the private vault: a private application with the calendar's private items on and real titles off adds only a generic line
  await vault(clone(s), { priv: true });
  await P.open(PRIV); await P.moveIn('pipeline', 'pl3');
  const v = P.view(S.getState());
  const calP = CAL.build(v, { today: '2026-11-10', includePrivate: true, stamp: new Date('2026-11-10T00:00:00Z') });
  const p1 = Mem.buildPrompt(v, 1, { from: WK, to: '2026-11-15' });
  const both = calP.text + p1.system + p1.user + JSON.stringify(M.weeklyDigest(v, WK));
  assert.ok(!both.includes(ADV_MARK));
  for (const f of compForms()) assert.ok(!both.replace(/[ ,.$]/g, '').includes(f.replace(/[ ,.$]/g, '')), 'compensation ' + f);
});

test('funnel and weekly numbers: the digest equals the tab\'s weekly view in every week, and every zero denominator is null', () => {
  const s = S.validateState(Object.assign(S.defaultState(), { pipeline: [
    job({ id: 'a', stage: 'applied', appliedOn: '2026-11-10', followUp: '2026-11-13' }), job({ id: 'b', stage: 'interview', appliedOn: '2026-11-03' }),
    job({ id: 'c', stage: 'offer', appliedOn: '2026-10-28', followUp: '2026-11-20' }), job({ id: 'd', stage: 'lost', appliedOn: '2026-11-11', lostReason: 'rejected' }),
    job({ id: 'e', stage: 'lead' }), job({ id: 'f', stage: 'lost', lostReason: 'no response' }),
  ] }));
  for (const wk of ['2026-10-26', '2026-11-02', WK, '2026-11-16']) {
    const w = J.weekly(s, wk), d = M.weeklyDigest(s, wk).jobs;
    assert.deepEqual(d, { applied: w.applications, followUpsDue: w.followUpsDue, interviews: w.interviews, offers: w.offers }, wk);
  }
  const f = J.funnel(s);
  // applied: a, b, c, d (f was lost from lead with no applied date); responded: b, c, d (rejected); interviewed: b, c; offered: c
  assert.deepEqual([f.applied, f.responded, f.interviews, f.offers, f.responseRate, f.interviewRate, f.offerRate], [4, 3, 2, 1, 75, 50, 25]);
  const z = J.funnel(S.validateState(Object.assign(S.defaultState(), { pipeline: [job({ id: 'l', stage: 'lead' })] })));
  assert.deepEqual([z.responseRate, z.interviewRate, z.offerRate], [null, null, null]);
  for (const m of z.byMonth) assert.deepEqual([m.responseRate, m.interviewRate, m.offerRate], [null, null, null]);
});

test('followedUpOn: validated as a date, kept at schema 18, dropped from older formats, and named by the downgrade guard', () => {
  const base = Object.assign(S.defaultState(), { pipeline: [job({ id: 'x', stage: 'applied', appliedOn: '2026-11-01', followedUpOn: '2026-11-05' })] });
  assert.equal(S.validateState(clone(base)).pipeline[0].followedUpOn, '2026-11-05');
  for (const bad of ['2026-02-30', '05/11/2026', 20261105, ADV_MARK]) assert.throws(() => S.validateState(Object.assign(clone(base), { pipeline: [Object.assign(clone(base.pipeline[0]), { followedUpOn: bad })] })), (e) => !String(e.message).includes(ADV_MARK));
  const old = Object.assign(clone(base), { schema: 17 });
  assert.equal(S.validateState(old).pipeline[0].followedUpOn, undefined);
  const cur = S.validateState(clone(base));
  // only followedUpOn set: the guard still names the job details an older copy would drop
  const only = S.validateState(Object.assign(S.defaultState(), { pipeline: [job({ id: 'y', stage: 'lead', followedUpOn: '2026-11-05' })] }));
  assert.deepEqual(Object.keys(only.pipeline[0]).filter((k) => ['followedUpOn', 'appliedOn', 'role', 'followUp'].includes(k)), ['followedUpOn']);
  assert.deepEqual(S.droppedData(only, S.validateState(Object.assign(clone(only), { schema: 17 }))), ['job search details']);
  assert.deepEqual(S.droppedData(cur, S.validateState(Object.assign(clone(cur), { schema: 17 }))), ['job search details']);
});

test('search: nothing private stays findable after a close, also when the close lands during a private write in flight', async () => {
  await vault((() => { const s = S.defaultState(); s.pipeline.push(job({ id: 'pj', title: 'Hidden role', notes: 'quiet heron note' })); return S.validateState(s); })(), { priv: true });
  await P.open(PRIV); await P.moveIn('pipeline', 'pj');
  await P.commit((i) => { W.save(i.wellbeing, { date: '2026-11-10', mood: 3, note: 'violet kestrel feeling' }); });
  assert.equal(Q.query('quiet heron').total, 1); assert.equal(Q.query('violet kestrel').total, 1);
  // a private write in flight, then the close before it lands
  const pending = P.write((x) => { x.pipeline.forEach((p) => { if (p.id === 'pj') p.notes = 'quiet heron note edited'; }); }).catch(() => {});
  P.close();
  for (const q of ['quiet heron', 'violet kestrel', 'hidden role']) assert.equal(Q.query(q).total, 0, q);
  await pending;
  for (const q of ['quiet heron', 'violet kestrel', 'hidden role', 'edited']) assert.equal(Q.query(q).total, 0, q + ' after the write settled');
  assert.equal(Q.hasPrivate(), false);
  // the stored envelope never holds the index or a search term in plain text
  const env = JSON.stringify(await S._rawEnvelope());
  for (const q of ['quiet heron', 'violet kestrel']) assert.ok(!env.includes(q));
});

test('search: no RegExp is built from what is typed, and typing never touches the history or the address', () => {
  const s = src('src/core/search.js');
  assert.ok(!/new RegExp|RegExp\(/.test(s));
  const app = src('src/ui/app.js'), body = app.slice(app.indexOf('function searchBox('), app.indexOf('// ---------- health (v0.5.0)'));
  assert.ok(body.length > 500);
  assert.ok(!/RegExp|history\.|location\.|pushState|replaceState|localStorage|sessionStorage|fetch\(/.test(body), 'searchBox');
  const run = body.slice(body.indexOf('function run()'), body.indexOf("inp.addEventListener('input', run)"));
  assert.ok(!/goKey|go\(/.test(run.replace(/onclick: function \(\) \{[^}]*\}/g, '')), 'only a tap on a result navigates');
});

test('SEC-115 (Info): no two top-level functions in a UI or core file share a name (a later declaration silently replaces the first)', () => {
  const dupes = (text) => { const seen = new Set(), out = []; for (const m of text.matchAll(/^ {2}function ([A-Za-z0-9_$]+)\s*\(/gm)) { if (seen.has(m[1])) out.push(m[1]); seen.add(m[1]); } return out; };
  // the checker catches the clash the builder hit: a job-tab pctText declared before the tax pctText
  assert.deepEqual(dupes("  function pctText(v) { return v === null ? 'no data' : v + '%'; }\n  function x() {}\n  function pctText(r) { return ''; }\n"), ['pctText']);
  const files = ['src/ui/app.js', 'src/ui/sync-ui.js', 'src/ui/archive-ui.js', 'src/ui/pwa.js'].concat(['jobs', 'search', 'store', 'metrics', 'memory', 'priv', 'social', 'calendar', 'revenue', 'activities'].map((f) => 'src/core/' + f + '.js'));
  for (const f of files) assert.deepEqual(dupes(src(f)), [], f);
  // the job rates use their own formatter, which says "no data", and the tax rate boxes keep theirs
  const app = src('src/ui/app.js');
  assert.match(app, /function jobPct\(v\) \{ return v === null \? 'no data' : v \+ '%'; \}/);
  assert.equal((app.match(/^ {2}function pctText\(/gm) || []).length, 1);
});
