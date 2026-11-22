// v1.7.0 audit (SEC-117 to SEC-126): regression tests for the findings fixed in the audit of the AYiN and clients, Podcasts and Websites build.
// UI-only findings (SEC-119, SEC-120, SEC-122) are proved in test/smoke-media.mjs; SEC-126 in test/smoke-leaks.mjs and test/v170.test.mjs.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L, PASS, memAdapter } from './_load.mjs';
import { fastKeys, realKeys, clone, PRIV } from './_archive.mjs';
import { buildAdversarial, ADV_MARK } from './_adversarial.mjs';

const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), P = view('priv'), O = view('ops'), Q = view('search'), Cl = view('clients'), Md = view('media'), A = view('admin'), Cal = view('calendar'), M = view('metrics');
const NOSTORE = { get: async () => { throw new Error('NO_STORAGE'); }, set: async () => { throw new Error('NO_STORAGE'); }, del: async () => { throw new Error('NO_STORAGE'); } };
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { P.close('system'); } catch (e) { /* closed */ } try { S.lock(); } catch (e) { /* locked */ } S._setAdapter(NOSTORE); realKeys(); } });
const TODAY = '2026-11-12';
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
async function vault(state, o = {}) {
  S._setAdapter(memAdapter()); S.lock(); await S.init(PASS);
  if (state) await S.replaceState(state);
  if (o.priv) { await P.setUp(PRIV); await P.open(PRIV); }
}

test('SEC-117: each site renewal is its own Admin chain with a generic title, so completing one site\'s renewal proposes its next while another site\'s is open', () => {
  const s = S.defaultState();
  const a = Md.addSite(s, { domain: 'alpha "one".example', host: 'Same Host', domainRenewOn: '2026-11-20', domainCost: '15', hostRenewOn: '2027-01-10', hostCost: '100' }, TODAY);
  const b = Md.addSite(s, { domain: 'beta \'two\'.example', host: 'Same Host', domainRenewOn: '2026-12-20', domainCost: '15', hostRenewOn: '2027-02-10', hostCost: '100' }, TODAY);
  const titles = s.renewals.map((r) => r.title);
  assert.deepEqual(titles, ['Domain renewal', 'Hosting renewal', 'Domain renewal 2', 'Hosting renewal 2']);
  for (const t of titles) assert.ok(!/alpha|beta|example/i.test(t), 'no domain in a renewal title');
  assert.equal(S.validateState(clone(s)).renewals.length, 4);
  // site A's domain renewal done while B's is open: A's next is proposed
  assert.ok(A.completeRenewal(s, a.domainRenewalId, TODAY, TODAY));
  assert.deepEqual(A.pendingRenewals(s).map((p) => p.fromId), [a.domainRenewalId]);
  A.completeRenewal(s, a.hostingRenewalId, TODAY, TODAY);
  assert.deepEqual(A.pendingRenewals(s).map((p) => p.fromId).sort(), [a.domainRenewalId, a.hostingRenewalId].sort(), 'same host, still separate chains');
  // a third site takes the next free number; a deleted site's renewals stay in Admin and keep their numbers
  Md.deleteSite(s, b.id);
  const c = Md.addSite(s, { domain: 'gamma.example', domainRenewOn: '2027-03-01' }, TODAY);
  assert.equal(s.renewals.find((r) => r.id === c.domainRenewalId).title, 'Domain renewal 3');
  // neither calendar mode carries a domain
  const v = S.validateState(clone(s));
  for (const real of [false, true]) { const t = Cal.build(v, { today: TODAY, realTitles: real }).text; assert.ok(!/alpha|beta|gamma|example|Same Host/.test(t)); }
});

test('SEC-118: confirming the next renewal in Admin moves the site link to it; the Websites numbers and the site form follow the open renewal', () => {
  const s = S.defaultState();
  const a = Md.addSite(s, { domain: 'a.example', domainRenewOn: '2026-11-20', domainCost: '15' }, TODAY);
  const old = a.domainRenewalId;
  A.completeRenewal(s, old, TODAY, TODAY);
  const next = A.confirmRenewal(s, old);
  assert.equal(s.sites[0].domainRenewalId, next.id);
  assert.deepEqual(Md.renewalsOf(s, s.sites[0]).map((r) => [r.date, r.state]), [['2027-11-20', 'open']]);
  assert.equal(Md.sitesRenewing(s, '2027-11-01', 30).length, 1, 'the digest number sees the open renewal');
  Md.updateSite(s, a.id, { domain: 'a.example', domainRenewOn: '2027-11-25', domainCost: '16' }, TODAY);
  assert.equal(s.renewals.find((r) => r.id === old).dueDate, '2026-11-20', 'the completed renewal is history and is not edited');
  assert.deepEqual([next.dueDate, next.amount], ['2027-11-25', 1600]);
  // a renewal confirmed for something else leaves the site alone
  const other = A.addRenewal(s, { title: 'Insurance', kind: 'insurance', dueDate: '2026-11-15', cadence: 'annual' }, TODAY);
  A.completeRenewal(s, other.id, TODAY, TODAY); A.confirmRenewal(s, other.id);
  assert.equal(s.sites[0].domainRenewalId, next.id);
  assert.equal(S.validateState(clone(s)).sites[0].domainRenewalId, next.id);
});

test('SEC-121: an episode, a platform number or a traffic month cannot move out alone while its show or site stays private; plain message, nothing written', async () => {
  const { state } = buildAdversarial(L);
  await vault(state, { priv: true });
  await P.moveIn('shows', 'sh1'); await P.moveIn('sites', 'st1');
  const before = JSON.stringify(S.getState());
  for (const [c, id, word] of [['episodes', 'ep1', 'show'], ['platformStats', 'ps1', 'show'], ['siteTraffic', 'tf1', 'site']]) {
    await assert.rejects(P.moveOut(c, id), (e) => { assert.match(e.message, new RegExp('^Its ' + word + ' is in the private vault\\. Move the ' + word + ' out instead')); assert.ok(!e.message.includes(ADV_MARK) && !/Invalid data/.test(e.message)); return true; });
  }
  assert.equal(JSON.stringify(S.getState()), before, 'nothing was written');
  assert.match(src('src/ui/app.js'), /id: 'priv-together', text: c === 'shows' \? 'Its episodes and typed numbers always move with it\.'/, 'the move dialog says what moves together');
  // moving the parent out takes them with it
  await P.moveOut('shows', 'sh1'); await P.moveOut('sites', 'st1');
  const m = S.getState();
  assert.deepEqual([m.shows.length, m.episodes.length, m.platformStats.length, m.sites.length, m.siteTraffic.length], [1, 1, 1, 1, 1]);
  // with the parent public, a child still moves in and out alone
  await P.moveIn('episodes', 'ep1'); await P.moveOut('episodes', 'ep1');
  assert.equal(S.getState().episodes.length, 1);
  assert.doesNotThrow(() => S.validateState(clone(S.getState())));
});

test('SEC-123: a platform\'s latest number is the latest platform-level one when any exists; episode numbers stay on the episode', () => {
  const s = S.defaultState();
  const sh = Md.addShow(s, { name: 'S' }), pf = sh.platforms[0].id;
  const ep = Md.addEpisode(s, { showId: sh.id, title: 'E' });
  Md.addStat(s, { showId: sh.id, platformId: pf, measure: 'downloads', value: '10000', date: '2026-11-01' }, TODAY);
  Md.addStat(s, { showId: sh.id, platformId: pf, measure: 'downloads', value: '300', date: '2026-11-05', episodeId: ep.id }, TODAY);
  const row = Md.platformSummary(s, sh.id, '2026-11', 2)[0].rows[0];
  assert.deepEqual(row.latest, { date: '2026-11-01', value: 10000 });
  assert.deepEqual(row.months.map((m) => m.value), [null, 10000], 'a month with nothing typed is null; the month prefers the platform number');
  assert.deepEqual(Md.episodeStats(s, ep.id).map((x) => x.value), [300]);
  // only episode numbers typed: the latest is the newest episode number
  const s2 = S.defaultState(), sh2 = Md.addShow(s2, { name: 'S' }), e2 = Md.addEpisode(s2, { showId: sh2.id, title: 'E' });
  Md.addStat(s2, { showId: sh2.id, platformId: sh2.platforms[0].id, measure: 'views', value: '7', date: '2026-11-03', episodeId: e2.id }, TODAY);
  assert.deepEqual(Md.platformSummary(s2, sh2.id, '2026-11', 1)[0].rows[0].latest, { date: '2026-11-03', value: 7 });
});

test('SEC-124: a client whose revenue comes from paid invoices is marked partial once years are archived (archived invoices are not live)', () => {
  const s = S.defaultState();
  const c = Cl.addClient(s, { name: 'C' }, TODAY);
  s.invoices.push({ id: 'i1', number: '1', issueDate: '2026-10-01', dueDate: '2026-10-15', lines: [{ description: 'W', qty: 1, unitCents: 5000 }], status: 'paid', paidOn: '2026-10-10', notes: '', clientId: c.id });
  let st = Cl.clientStats(s, c, TODAY);
  assert.deepEqual([st.basis, st.revenueCents, st.partial], ['invoices', 5000, false]);
  s.archives = [{ year: 2024 }];
  st = Cl.clientStats(s, c, TODAY);
  assert.deepEqual([st.basis, st.revenueCents, st.partial], ['invoices', 5000, true]);
  assert.match(src('src/ui/app.js'), /st\.partial \? h\('p', \{ class: 'mut small', text: 'Some of this covers archived years only in part\.' \}\)/);
});

test('SEC-125: search finds platform names under their show; private clients, shows, episodes and sites are searchable only while the vault is open and dropped on close and lock', async () => {
  const { state } = buildAdversarial(L);
  await vault(state, { priv: true });
  const pf = state.shows[0].platforms[1].name;
  const hit = (q) => Q.query(q).groups.flatMap((g) => g.items.map((i) => g.area + ':' + i.coll + ':' + i.id));
  assert.deepEqual(hit(pf), ['podcasts:shows:sh1']);
  for (const [c, id] of [['clients', 'cl1'], ['shows', 'sh1'], ['sites', 'st1']]) await P.moveIn(c, id);
  const needles = [state.clients[0].name, state.shows[0].name, state.episodes[0].title, state.sites[0].hostname, pf];
  for (const n of needles) assert.equal(hit(n).length, 1, 'found while open: ' + n.slice(0, 30));
  assert.ok(Q.query(state.clients[0].name).groups[0].items[0].priv);
  P.close('test');
  for (const n of needles) assert.deepEqual(hit(n), [], 'gone after close');
  await P.open(PRIV);
  assert.equal(hit(state.sites[0].hostname).length, 1);
  S.lock();
  assert.equal(Q.isBuilt(), false); assert.deepEqual(Q.query(state.sites[0].hostname).groups, []);
  // what is typed is literal text, never a pattern
  await S.unlock(PASS);
  assert.deepEqual(hit('domain "x" .*'), []); assert.doesNotThrow(() => Q.query('(['));
});

test('SEC-125: SPEC.md records the audit amendment (search depth, the digest windows, renewal titles and moves out)', () => {
  const spec = src('SPEC.md'), at = spec.indexOf('Amendment (v1.7.0 audit');
  assert.ok(at > 0);
  const a = spec.slice(at);
  for (const w of ['platform names', 'end of the week', 'Domain renewal 2', 'Move the show out', 'archived']) assert.ok(a.includes(w), w);
  assert.ok(!/Search indexes top-level text only, so platform names are not searched/.test(spec));
  assert.ok(!/\u2014/.test(a));
  assert.ok(M.weeklyDigest(S.validateState(S.defaultState()), '2026-11-09').media);
});
