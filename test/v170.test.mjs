// v1.7.0 B15 and B16: AYiN and clients, Podcasts, Websites. Schema 19 (migrations 1 to 18, a v1.6.0 backup, downgrade guards, validateState for every new field and
// prototype-pollution keys), the client and media rules, the numbers (never summed across measures, a missing month is no data), the private vault, and the rule that
// no name, title, platform, domain, note or per-client money reaches a prompt, the digest, an insight, consolidation, a target proposal, the calendar file, diagnostics or an error.
// Run in three time zones.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L, PASS, memAdapter } from './_load.mjs';
import { fastKeys, realKeys, clone, PRIV } from './_archive.mjs';
import { buildAdversarial, ADV_MARK, MEDIA_COLLECTIONS, stripJobFields } from './_adversarial.mjs';

const view = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const S = view('store'), M = view('metrics'), Mem = view('memory'), P = view('priv'), V = view('vault'), Cal = view('calendar'), Ac = view('activities'), O = view('ops'), Q = view('search'), Cl = view('clients'), Md = view('media'), A = view('admin');
const NOSTORE = { get: async () => { throw new Error('NO_STORAGE'); }, set: async () => { throw new Error('NO_STORAGE'); }, del: async () => { throw new Error('NO_STORAGE'); } };
const test = (name, fn) => nodeTest(name, async (t) => { fastKeys(); O._reset(); try { return await fn(t); } finally { O._reset(); try { P.close('system'); } catch (e) { /* closed */ } try { S.lock(); } catch (e) { /* locked */ } S._setAdapter(NOSTORE); realKeys(); } });
const TODAY = '2026-11-12', WK = '2026-11-09';
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const build = (fn) => { const s = S.defaultState(); fn(s); return S.validateState(clone(s)); };
async function vault(state, o = {}) {
  S._setAdapter(memAdapter()); S.lock(); await S.init(PASS);
  if (state) await S.replaceState(state);
  if (o.priv) await P.setUp(PRIV);
}
const proj = (id, name, o) => Object.assign({ id, name, kind: 'venture', status: 'active', nextAction: '', archived: false }, o);
const money = (id, type, date, value, projectId, extra) => M.validateEntry(Object.assign({ id, domain: 'money', type, date, title: id, value, projectId, category: type === 'expense' ? 'Other' : undefined }, extra));
const inv = (id, number, dueDate, cents, status, o) => Object.assign({ id, number, issueDate: '2026-10-01', dueDate, lines: [{ description: 'Work', qty: 1, unitCents: cents }], status, notes: '' }, status === 'paid' ? { paidOn: '2026-10-20' } : {}, o);
const person = (id, name) => ({ id, name, importantDates: [], pipelineIds: [], projectIds: [], facts: [], notes: '', archived: false, createdAt: '2026-01-01T00:00:00.000Z' });
const stripMedia = (o) => { for (const c of MEDIA_COLLECTIONS) delete o[c]; for (const i of o.invoices || []) delete i.clientId; if (o.settings) delete o.settings.clients; return o; };

// ---------------------------------------------------------------- schema 19
test('schema 19: the schema, the version and the build order', () => {
  assert.equal(S.SCHEMA, 23); assert.equal(S.defaultState().schema, 23);
  assert.equal(JSON.parse(src('package.json')).version, '2.3.0');
  assert.match(src('build.mjs'), /'business', 'clients', 'media', 'layout'/);
  assert.deepEqual(MEDIA_COLLECTIONS.filter((c) => !Array.isArray(S.defaultState()[c])), []);
  assert.deepEqual(S.defaultState().settings.clients, { contactDays: 30 });
});
test('migrations 1 to 18 into 19: every old text survives, no client, show, episode, number, site or traffic is invented or trusted from an older format', () => {
  const { state } = buildAdversarial(L);
  for (let n = 1; n <= 18; n++) {
    const o = clone(state); o.schema = n;
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
    if (n < 18) stripJobFields(o);
    stripMedia(o); // an older format never held them; here they are present in the input only if a copy was tampered with, so put them back
    for (const c of MEDIA_COLLECTIONS) o[c] = clone(state[c]);
    const got = S.validateState(o);
    assert.equal(got.schema, 23); assert.equal(got.sourceSchema, n);
    for (const c of MEDIA_COLLECTIONS) assert.deepEqual(got[c], [], 'schema ' + n + ' carries no ' + c);
    assert.deepEqual(got.settings.clients, { contactDays: 30 });
    assert.ok((got.invoices || []).every((i) => i.clientId === undefined), 'no client link on an invoice at schema ' + n);
    if (n >= 3) assert.equal(got.pipeline.length, state.pipeline.length, 'the pipeline survives at ' + n);
  }
  const cur = S.validateState(clone(state));
  assert.deepEqual(MEDIA_COLLECTIONS.map((c) => cur[c].length), [1, 1, 1, 1, 1, 1]);
  assert.equal(cur.invoices[0].clientId, 'cl1');
  assert.equal(cur.settings.clients.contactDays, 30);
});
test('a v1.6.0 backup (schema 18) imports cleanly and a stored schema 18 vault migrates on unlock; the first write saves schema 19', async () => {
  const st = clone(S.defaultState()); st.schema = 18; stripMedia(st);
  st.pipeline.push({ id: 'a', title: 'Backup job', org: 'C', kind: 'job', stage: 'interview', source: '', nextStep: '', updatedAt: '2026-11-01', notes: 'kept', role: 'AE' });
  const salt = V.newSalt(); realKeys(); const key = await V.deriveKey('backup passphrase 1', salt); fastKeys();
  const imp = await V.importBackup('backup passphrase 1', JSON.stringify(await V.makeEnvelope(key, salt, st)));
  assert.equal(imp.schema, 23); assert.equal(imp.sourceSchema, 18); assert.equal(imp.pipeline[0].role, 'AE'); assert.deepEqual(imp.clients, []);
  await vault(null);
  assert.deepEqual(S.droppedData(S.getState(), imp), []);
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  const env = await S.exportEnvelope(), salt2 = V.parseEnvelope(env).salt;
  const base = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(PASS), 'PBKDF2', false, ['deriveKey']);
  const key2 = await globalThis.crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt2, iterations: 1000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await ad.set('envelope', await V.makeEnvelope(key2, salt2, st));
  S.lock();
  const un = await S.unlock(PASS);
  assert.equal(un.schema, 23); assert.equal(un.pipeline.length, 1); assert.deepEqual(un.shows, []);
  await S.commit(() => {});
  assert.equal((await (await V.openEnvelope(await ad.get('envelope'), PASS)).raw).schema, 23);
});
test('downgrade guards: an older-format copy names every new detail it would drop; a newer schema is refused', async () => {
  const { state } = buildAdversarial(L);
  const older = S.validateState(Object.assign(clone(state), { schema: 18 }));
  const names = S.droppedData(state, older);
  for (const n of ['clients', 'shows', 'episodes', 'platform numbers', 'sites', 'site traffic months', 'client links on invoices']) assert.ok(names.includes(n), n + ' in ' + names);
  assert.match(S.lossText(state, older), /1 clients/); assert.ok(S.dropsWork(state, older));
  assert.ok(!S.lossText(state, older).includes(ADV_MARK));
  // each new detail alone is named
  const one = (fn) => { const c = build(fn); return S.droppedData(c, S.validateState(Object.assign(clone(c), { schema: 18 }))); };
  assert.deepEqual(one((s) => { s.clients.push({ id: 'c', name: 'N', status: 'active', personIds: [], notes: '' }); }), ['clients']);
  assert.deepEqual(one((s) => { s.sites.push({ id: 's', hostname: 'a.example', kind: 'other', host: '', notes: '' }); }), ['sites']);
  assert.deepEqual(one((s) => { s.settings.clients = { contactDays: 10 }; }), ['client contact reminder days']);
  assert.deepEqual(one((s) => { s.clients.push({ id: 'c', name: 'N', status: 'active', personIds: [], notes: '' }); s.invoices.push(inv('i', '1', '2026-12-01', 100, 'sent', { clientId: 'c' })); }), ['clients', 'client links on invoices']);
  assert.deepEqual(one((s) => { s.invoices.push(inv('i', '1', '2026-12-01', 100, 'sent')); }), [], 'a plain invoice loses nothing');
  assert.deepEqual(S.droppedData(state, S.validateState(clone(state))), []);
  assert.throws(() => S.validateState(Object.assign(S.defaultState(), { schema: 24 })), /schema/);
  await vault(state);
  const salt = V.newSalt(); realKeys(); const key = await V.deriveKey('backup passphrase 1', salt); fastKeys();
  const imp = await V.importBackup('backup passphrase 1', JSON.stringify(await V.makeEnvelope(key, salt, Object.assign(clone(state), { schema: 18 }))));
  assert.equal(imp.sourceSchema, 18); assert.ok(S.dropsWork(S.getState(), imp));
  await assert.rejects(V.importBackup('backup passphrase 1', JSON.stringify(await V.makeEnvelope(key, salt, Object.assign(clone(state), { schema: 24 })))), /schema/);
});

// ---------------------------------------------------------------- validateState for every new field
const goodShow = () => ({ id: 'sh', name: 'Show', platforms: [{ id: 'pf', name: 'YouTube' }, { id: 'pg', name: 'Spotify' }], notes: '' });
test('validateState: every new field accepts good values, refuses bad ones, drops dangling links, and never keeps a pollution key', () => {
  const withAll = (fn) => build((s) => { s.projects.push(proj('p1', 'Line')); s.people.push(person('pe', 'Pat')); s.renewals.push({ id: 'rn', title: 'R', kind: 'other', provider: '', dueDate: '2026-12-01', cadence: 'once', autoRenews: false, state: 'open', notes: '' }); fn(s); });
  const ok = withAll((s) => {
    s.sites.push({ id: 'st', hostname: 'a.example', kind: 'show', projectId: 'p1', showId: 'sh', host: 'H', domainRenewalId: 'rn', hostingRenewalId: 'gone', notes: 'n' });
    s.shows.push(Object.assign(goodShow(), { siteId: 'st', projectId: 'p1' }));
    s.episodes.push({ id: 'ep', showId: 'sh', title: 'E', number: 3, status: 'edited', recordedOn: '2026-11-01', guestIds: ['pe', 'gone', 'pe'], pubs: [{ format: 'video', platformId: 'pf', date: '2026-11-02' }, { format: 'audio', platformId: 'nope', date: '2026-11-02' }, { format: 'video', platformId: 'pf', date: '2026-11-03' }], notes: '' });
    s.platformStats.push({ id: 'ps', showId: 'sh', platformId: 'pf', date: '2026-11-02', measure: 'views', value: 5, episodeId: 'ep' }, { id: 'pt', showId: 'sh', platformId: 'gone', date: '2026-11-02', measure: 'views', value: 5 });
    s.siteTraffic.push({ id: 'tf', siteId: 'st', month: '2026-11', visits: 10, visitors: 4 }, { id: 'tg', siteId: 'gone', month: '2026-11', visits: 1 });
    s.clients.push({ id: 'cl', name: 'C', status: 'paused', projectId: 'p1', budgetCents: 0, personIds: ['pe', 'gone'], notes: 'x', createdOn: '2026-01-01' }, { id: 'cm', name: 'D', status: 'past', projectId: 'gone', personIds: [], notes: '' });
    s.invoices.push(inv('iv', '7', '2026-12-01', 100, 'sent', { clientId: 'cl' }), inv('iw', '8', '2026-12-01', 100, 'sent', { clientId: 'gone' }));
  });
  assert.equal(ok.sites[0].domainRenewalId, 'rn'); assert.equal(ok.sites[0].hostingRenewalId, undefined); assert.equal(ok.sites[0].showId, 'sh');
  assert.deepEqual(ok.episodes[0].guestIds, ['pe']); assert.deepEqual(ok.episodes[0].pubs.map((p) => p.date), ['2026-11-02'], 'an unknown platform and a repeated format and platform are dropped');
  assert.equal(ok.platformStats.length, 1); assert.equal(ok.siteTraffic.length, 1);
  assert.deepEqual(ok.clients.map((c) => [c.projectId, c.personIds.length, c.budgetCents]), [['p1', 1, 0], [undefined, 0, undefined]]);
  assert.deepEqual(ok.invoices.map((i) => i.clientId), ['cl', undefined]);
  const bad = (fn, what) => assert.throws(() => withAll(fn), /Invalid data/, what);
  bad((s) => s.clients.push({ id: 'c', name: '', status: 'active', personIds: [], notes: '' }), 'empty name');
  bad((s) => s.clients.push({ id: 'c', name: 'x', status: 'gone', personIds: [], notes: '' }), 'status');
  bad((s) => s.clients.push({ id: 'c', name: 'x', status: 'active', budgetCents: -1, personIds: [], notes: '' }), 'budget');
  bad((s) => s.clients.push({ id: 'c', name: 'x', status: 'active', budgetCents: 1.5, personIds: [], notes: '' }), 'budget cents');
  bad((s) => s.clients.push({ id: 'c', name: 'x'.repeat(201), status: 'active', personIds: [], notes: '' }), 'name length');
  bad((s) => s.clients.push({ id: 'c', name: 'x', status: 'active', personIds: [], notes: 'n'.repeat(2001) }), 'notes length');
  bad((s) => s.clients.push({ id: 'c', name: 'x', status: 'active', personIds: [], notes: '', createdOn: '2026-13-01' }), 'date');
  bad((s) => s.clients.push({ id: 'c', name: 'x', status: 'active', personIds: [], notes: '' }, { id: 'c', name: 'y', status: 'active', personIds: [], notes: '' }), 'duplicate id');
  bad((s) => s.shows.push(Object.assign(goodShow(), { platforms: [{ id: 'a', name: 'x' }, { id: 'a', name: 'y' }] })), 'duplicate platform id');
  bad((s) => s.shows.push(Object.assign(goodShow(), { platforms: Array.from({ length: 21 }, (_, i) => ({ id: 'p' + i, name: 'n' })) })), 'too many platforms');
  bad((s) => { s.shows.push(goodShow()); s.episodes.push({ id: 'e', showId: 'sh', title: 'T', status: 'live', guestIds: [], pubs: [], notes: '' }); }, 'episode status');
  bad((s) => { s.shows.push(goodShow()); s.episodes.push({ id: 'e', showId: 'sh', title: 'T', status: 'idea', number: -1, guestIds: [], pubs: [], notes: '' }); }, 'episode number');
  bad((s) => { s.shows.push(goodShow()); s.episodes.push({ id: 'e', showId: 'sh', title: 'T', status: 'idea', guestIds: [], pubs: [{ format: 'film', platformId: 'pf', date: '2026-01-01' }], notes: '' }); }, 'release format');
  bad((s) => { s.shows.push(goodShow()); s.platformStats.push({ id: 'p', showId: 'sh', platformId: 'pf', date: '2026-01-01', measure: 'likes', value: 1 }); }, 'measure');
  bad((s) => { s.shows.push(goodShow()); s.platformStats.push({ id: 'p', showId: 'sh', platformId: 'pf', date: '2026-01-01', measure: 'views', value: 1.5 }); }, 'fraction');
  bad((s) => { s.shows.push(goodShow()); s.platformStats.push({ id: 'p', showId: 'sh', platformId: 'pf', date: '2026-01-01', measure: 'views', value: -1 }); }, 'negative number');
  bad((s) => { s.shows.push(goodShow()); s.platformStats.push({ id: 'p', showId: 'sh', platformId: 'pf', date: '2026-01-01', measure: 'views', value: 1e13 }); }, 'number too large');
  bad((s) => s.sites.push({ id: 's', hostname: 'a', kind: 'blog', host: '', notes: '' }), 'purpose');
  bad((s) => s.sites.push({ id: 's', hostname: '', kind: 'show', host: '', notes: '' }), 'empty domain');
  bad((s) => s.sites.push({ id: 's', hostname: 'x'.repeat(254), kind: 'show', host: '', notes: '' }), 'domain length');
  bad((s) => { s.sites.push({ id: 's', hostname: 'a', kind: 'show', host: '', notes: '' }); s.siteTraffic.push({ id: 't', siteId: 's', month: '2026-13', visits: 1 }); }, 'month');
  bad((s) => { s.sites.push({ id: 's', hostname: 'a', kind: 'show', host: '', notes: '' }); s.siteTraffic.push({ id: 't', siteId: 's', month: '2026-01', visits: 1 }, { id: 'u', siteId: 's', month: '2026-01', visits: 2 }); }, 'duplicate month');
  bad((s) => { s.sites.push({ id: 's', hostname: 'a', kind: 'show', host: '', notes: '' }); s.siteTraffic.push({ id: 't', siteId: 's', month: '2026-01', visits: -2 }); }, 'visits');
  bad((s) => { s.settings.clients = { contactDays: 0 }; }, 'contact days low');
  bad((s) => { s.settings.clients = { contactDays: 4000 }; }, 'contact days high');
  // prototype pollution: a forbidden key anywhere in a new record is refused, and no prototype is changed
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    for (const coll of MEDIA_COLLECTIONS) {
      const raw = JSON.stringify(Object.assign(clone(S.defaultState()), { [coll]: [] })).replace(new RegExp('"' + coll + '":\\[\\]'), '"' + coll + '":[{"id":"x","' + key + '":{"polluted":1}}]');
      assert.throws(() => S.validateState(JSON.parse(raw)), /Invalid data/, coll + ' ' + key);
    }
    const nested = JSON.stringify(Object.assign(clone(S.defaultState()), { shows: [] })).replace('"shows":[]', '"shows":[{"id":"x","name":"n","platforms":[{"id":"p","name":"n","' + key + '":1}],"notes":""}]');
    assert.throws(() => S.validateState(JSON.parse(nested)), /Invalid data/, 'nested ' + key);
  }
  assert.equal({}.polluted, undefined);
  // the caps
  assert.equal(Cl.CAP, 500); assert.equal(Md.SHOW_CAP, 50); assert.equal(Md.EP_CAP, 5000); assert.equal(Md.STAT_CAP, 20000); assert.equal(Md.SITE_CAP, 100); assert.equal(Md.TRAFFIC_CAP, 6000);
  assert.throws(() => build((s) => { for (let i = 0; i <= 500; i++) s.clients.push({ id: 'c' + i, name: 'n', status: 'active', personIds: [], notes: '' }); }), /too many/);
});
test('the digest check accepts the media numbers and refuses anything else', () => {
  const d = M.weeklyDigest(S.validateState(S.defaultState()), WK);
  assert.deepEqual(d.media, { clientsOverdue: 0, episodesThisMonth: 0, sitesRenewing: 0 });
  const rv = (media) => S.validateState(Object.assign(S.defaultState(), { memory: Object.assign(S.defaultState().memory, { reviews: [{ id: 'r', weekOf: WK, digest: Object.assign(clone(d), { media }), priorities: ['a', 'b', 'c'], completedAt: '2026-11-14T10:00:00.000Z' }] }) })).memory.reviews[0].digest;
  assert.deepEqual(rv({ clientsOverdue: 2, episodesThisMonth: 3, sitesRenewing: 1, extra: ADV_MARK }).media, { clientsOverdue: 2, episodesThisMonth: 3, sitesRenewing: 1 });
  assert.throws(() => rv({ clientsOverdue: -1, episodesThisMonth: 0, sitesRenewing: 0 }), /Invalid data/);
  assert.throws(() => rv({ clientsOverdue: 'x', episodesThisMonth: 0, sitesRenewing: 0 }), /Invalid data/);
});

// ---------------------------------------------------------------- clients
const clientState = () => build((s) => {
  s.projects.push(proj('p1', 'AYiN Advisory'), proj('p2', 'Podcast line', { kind: 'podcast' }), proj('p3', 'Personal', { kind: 'personal' }));
  s.entries.push(money('i1', 'income', '2026-11-05', 1000, 'p1'), money('i2', 'income', '2026-10-20', 500, 'p1'), money('i3', 'income', '2026-03-01', 250, 'p1'), money('x1', 'expense', '2026-11-06', 200, 'p1'),
    money('i4', 'income', '2026-11-07', 70, 'p2'), money('i5', 'income', '2026-11-07', 9999, 'p3'));
  s.invoices.push(inv('iv1', '1001', '2026-11-01', 80000, 'sent', { projectId: 'p1' }), inv('iv2', '1002', '2026-12-01', 30000, 'sent', { projectId: 'p1' }), inv('iv3', '1003', '2026-10-30', 12345, 'paid', { projectId: 'p1' }), inv('iv4', '1004', '2026-10-01', 1, 'void'));
  s.people.push(person('pa', 'Pat'), person('pb', 'Bo'));
  s.contacts.push({ id: 'k1', personId: 'pa', date: '2026-10-20', channel: 'call', notes: '' }, { id: 'k2', personId: 'pb', date: '2026-11-01', channel: 'email', notes: '' });
});
test('rollup: revenue this month, quarter and year over the business lines only; invoices open and overdue; budget against spending', () => {
  const s = clientState(), r = Cl.rollup(s, TODAY);
  assert.deepEqual(r.lines.map((l) => l.name).sort(), ['AYiN Advisory', 'Podcast line'], 'a personal line is not a business line');
  assert.deepEqual([r.totals.month.revenueCents, r.totals.quarter.revenueCents, r.totals.year.revenueCents], [107000, 157000, 182000]);
  assert.deepEqual([r.totals.month.expenseCents, r.totals.year.expenseCents], [20000, 20000]);
  assert.deepEqual([r.invoices.openCount, r.invoices.openCents, r.invoices.overdueCount, r.invoices.overdueCents], [2, 110000, 1, 80000]);
  assert.equal(r.partial, false);
  const b = build((x) => { x.projects.push(proj('p1', 'L', { budgetCents: 100000, budgetPeriod: 'project' })); x.entries.push(money('x', 'expense', '2026-11-06', 250, 'p1')); });
  assert.deepEqual(Cl.rollup(b, TODAY).budgets.map((x) => [x.budgetCents, x.actualCents, x.remainingCents, x.status]), [[100000, 25000, 75000, 'ok']]);
  assert.deepEqual(Cl.rollup(S.validateState(S.defaultState()), TODAY).lines, [], 'no lines of work: no rows, no NaN');
  assert.equal(Cl.rollup(S.validateState(S.defaultState()), TODAY).totals.year.revenueCents, 0);
});
test('a client: revenue to date, open and overdue invoices, budget against spending, last contact, and the flags', () => {
  const s = clientState();
  Cl.addClient(s, { name: 'Acme', status: 'active', projectId: 'p1', budget: '5,000', notes: 'n' }, '2026-09-01');
  const c = s.clients[0];
  assert.deepEqual([c.budgetCents, c.createdOn, c.personIds], [500000, '2026-09-01', []]);
  Cl.setInvoiceClient(s, 'iv1', c.id); Cl.setInvoiceClient(s, 'iv2', c.id); Cl.setInvoiceClient(s, 'iv3', c.id); Cl.linkPerson(s, c.id, 'pa'); Cl.linkPerson(s, c.id, 'pb'); Cl.linkPerson(s, c.id, 'pa');
  assert.deepEqual(c.personIds, ['pa', 'pb']);
  const st = Cl.clientStats(s, c, TODAY);
  assert.deepEqual([st.revenueCents, st.basis, st.openCount, st.openCents, st.overdueCount, st.overdueCents], [175000, 'line', 2, 110000, 1, 80000]);
  assert.deepEqual(st.budget, { budgetCents: 500000, actualCents: 20000, remainingCents: 480000, over: false });
  assert.deepEqual([st.lastContact, st.daysSinceContact], ['2026-11-01', 11], 'the latest contact with any linked person');
  assert.deepEqual(Cl.flags(s, c, TODAY, st), { overdueInvoice: true, noContact: false });
  assert.deepEqual(Cl.flags(s, c, '2026-12-05'), { overdueInvoice: true, noContact: true }, 'past the default 30 days');
  Cl.setContactDays(s, '5'); assert.equal(Cl.contactDaysOf(s), 5);
  assert.equal(Cl.flags(s, c, TODAY).noContact, true);
  for (const bad of ['0', '3651', 'x', '1.5', '-2', '']) assert.throws(() => Cl.setContactDays(s, bad), /whole number/);
  assert.deepEqual(Cl.counts(s, TODAY), { clients: 1, overdueInvoices: 1, noContact: 1 });
  // a paused or past client is never flagged for contact; a client never contacted is measured from its created date
  c.status = 'paused'; assert.equal(Cl.flags(s, c, TODAY).noContact, false); c.status = 'active';
  const n = Cl.addClient(s, { name: 'New', status: 'active' }, TODAY);
  assert.deepEqual(Cl.clientStats(s, n, TODAY), Object.assign(Cl.clientStats(s, n, TODAY), { revenueCents: null, basis: 'none', budget: null, lastContact: null, daysSinceContact: null }));
  assert.equal(Cl.flags(s, n, TODAY).noContact, false); assert.equal(Cl.flags(s, n, '2026-12-20').noContact, true);
  // with no line of work, revenue comes from paid invoices; spending has no data
  const b = Cl.addClient(s, { name: 'NoLine', status: 'active', budget: '100' }, TODAY); Cl.setInvoiceClient(s, 'iv4', b.id);
  const sb = Cl.clientStats(s, b, TODAY);
  assert.deepEqual([sb.revenueCents, sb.basis, sb.budget.actualCents, sb.budget.remainingCents, sb.budget.over], [null, 'none', null, null, null], 'a void invoice earns nothing; no line, no spending figure');
  s.invoices.find((i) => i.id === 'iv4').status = 'paid'; s.invoices.find((i) => i.id === 'iv4').paidOn = '2026-10-20';
  assert.deepEqual([Cl.clientStats(s, b, TODAY).revenueCents, Cl.clientStats(s, b, TODAY).basis], [1, 'invoices']);
  // log contact: only a linked person, by id; unlink and delete never remove an invoice or a person
  assert.throws(() => Cl.logContact(s, n.id, 'pa', TODAY), /not linked/);
  Cl.logContact(s, c.id, 'pa', TODAY); assert.equal(Cl.lastContact(s, c), TODAY);
  Cl.unlinkPerson(s, c.id, 'pa'); assert.deepEqual(c.personIds, ['pb']);
  Cl.deleteClient(s, c.id);
  assert.deepEqual([s.clients.length, s.invoices.length, s.people.length, s.invoices.filter((i) => i.clientId === c.id).length], [2, 4, 2, 0]);
  assert.throws(() => Cl.updateClient(s, c.id, { name: 'x' }), /not found/);
});
test('client input checks: names, status, line of work, budget and ID-number refusals; errors never echo what was typed', () => {
  const s = clientState();
  for (const input of [{ name: '' }, { name: ADV_MARK + 'x'.repeat(300) }, { name: 'ok', status: ADV_MARK }, { name: 'ok', projectId: ADV_MARK }, { name: 'ok', budget: ADV_MARK + 'abc' }, { name: 'ok', budget: '-5' }, { name: 'ok', notes: 'n'.repeat(2001) }, { name: 'SSN 123-45-6789' }, { name: 'ok', notes: '4111 1111 1111 1111' }]) {
    assert.throws(() => Cl.addClient(s, input, TODAY), (e) => !e.message.includes(ADV_MARK) && !e.message.includes('4111') && !e.message.includes('123-45'));
  }
  assert.equal(s.clients.length, 0);
  const c = Cl.addClient(s, { name: '  Spaced   Name  ', budget: '' }, TODAY);
  assert.equal(c.name, 'Spaced Name'); assert.equal(c.budgetCents, undefined);
  assert.throws(() => Cl.setInvoiceClient(s, 'iv1', 'missing'), /not found/); assert.throws(() => Cl.setInvoiceClient(s, 'missing', c.id), /not found/);
  assert.throws(() => Cl.linkPerson(s, c.id, 'missing'), /not found/);
  const t = clone(s); t.clients = Array.from({ length: 500 }, (_, i) => ({ id: 'c' + i, name: 'n', status: 'active', personIds: [], notes: '' }));
  assert.throws(() => Cl.addClient(t, { name: 'one more' }, TODAY), /up to 500/);
});

// ---------------------------------------------------------------- podcasts
const mediaState = () => {
  const s = S.defaultState();
  s.projects.push(proj('p1', 'Show line', { kind: 'podcast' })); s.people.push(person('pa', 'Pat'), person('pb', 'Bo'));
  s.entries.push(money('i1', 'income', '2026-11-05', 300, 'p1'), money('x1', 'expense', '2026-11-06', 120, 'p1'), money('x2', 'expense', '2026-02-06', 30, 'p1'), money('e1', 'income', '2026-12-01', 999, 'p1', { status: 'expected', dueDate: '2026-12-01' }));
  return S.validateState(clone(s));
};
test('shows: the default platforms are offered, each show has its own list, and platform changes cascade to dates and numbers', () => {
  const s = mediaState(), sh = Md.addShow(s, { name: 'Night', projectId: 'p1' }), sh2 = Md.addShow(s, { name: 'Day', defaults: false });
  assert.deepEqual(sh.platforms.map((p) => p.name), ['YouTube', 'Spotify', 'Apple Podcasts', 'YouTube Podcasts', 'Website']); assert.deepEqual(sh2.platforms, []);
  assert.deepEqual(Md.DEFAULT_PLATFORMS, ['YouTube', 'Spotify', 'Apple Podcasts', 'YouTube Podcasts', 'Website']);
  const yt = sh.platforms[0], sp = sh.platforms[1];
  Md.renamePlatform(s, sh.id, yt.id, 'YT main'); assert.equal(sh.platforms[0].name, 'YT main');
  assert.throws(() => Md.renamePlatform(s, sh.id, yt.id, 'spotify'), /already/); assert.throws(() => Md.addPlatform(s, sh.id, 'SPOTIFY'), /already/);
  const np = Md.addPlatform(s, sh.id, 'Newsletter'); assert.equal(sh.platforms.length, 6);
  const ep = Md.addEpisode(s, { showId: sh.id, title: 'One', status: 'published', number: '1', guestIds: ['pa'] });
  Md.setRelease(s, ep.id, 'audio', sp.id, '2026-11-03'); Md.setRelease(s, ep.id, 'video', yt.id, '2026-11-04');
  Md.addStat(s, { showId: sh.id, platformId: sp.id, measure: 'downloads', value: '10', date: '2026-11-05', episodeId: ep.id }, TODAY); Md.addStat(s, { showId: sh.id, platformId: yt.id, measure: 'views', value: '20', date: '2026-11-05' }, TODAY);
  Md.removePlatform(s, sh.id, sp.id);
  assert.deepEqual(ep.pubs.map((p) => p.platformId), [yt.id]); assert.deepEqual(s.platformStats.map((x) => x.platformId), [yt.id]);
  assert.doesNotThrow(() => S.validateState(clone(s)));
  Md.deleteEpisode(s, ep.id); assert.equal(s.episodes.length, 0);
  Md.deleteShow(s, sh.id); assert.deepEqual([s.shows.length, s.platformStats.length], [1, 0]);
  assert.throws(() => Md.addShow(s, { name: '' }), /Enter the show name/);
  assert.throws(() => Md.addShow(s, { name: 'x', siteId: 'missing' }), /not found/);
  assert.throws(() => Md.addPlatform(s, sh2.id, ''), /Enter/);
  void np;
});
test('episodes: statuses, numbers, guests from Social, a release date per format and platform, and the Social side', () => {
  const s = mediaState(), sh = Md.addShow(s, { name: 'Night' }), sp = sh.platforms[1];
  const e = Md.addEpisode(s, { showId: sh.id, title: 'Pilot', number: '12', status: 'recorded', recordedOn: '2026-11-01', guestIds: ['pa', 'pb', 'pa'] });
  assert.deepEqual([e.number, e.status, e.guestIds], [12, 'recorded', ['pa', 'pb']]);
  assert.deepEqual(Md.EP_STATUS, ['idea', 'booked', 'recorded', 'edited', 'published']); assert.deepEqual(Md.FORMATS, ['video', 'audio', 'text']);
  Md.setRelease(s, e.id, 'text', sp.id, '2026-11-09'); Md.setRelease(s, e.id, 'text', sp.id, '2026-11-10');
  assert.deepEqual(e.pubs, [{ format: 'text', platformId: sp.id, date: '2026-11-10' }], 'the same format and platform replaces');
  assert.equal(Md.publishedOn(e), null, 'not published yet');
  Md.updateEpisode(s, e.id, { title: 'Pilot', status: 'published', guestIds: ['pb'] });
  assert.equal(Md.publishedOn(e), '2026-11-10'); assert.deepEqual(e.guestIds, ['pb']); assert.equal(e.number, undefined);
  assert.deepEqual(Md.episodesOfGuest(s, 'pb').map((x) => x.title), ['Pilot']); assert.deepEqual(Md.episodesOfGuest(s, 'pa'), []);
  Md.setRelease(s, e.id, 'text', sp.id, ''); assert.deepEqual(e.pubs, []);
  for (const bad of [{ title: '' }, { title: 'x', status: ADV_MARK }, { title: 'x', number: ADV_MARK }, { title: 'x', number: '-1' }, { title: 'x', recordedOn: ADV_MARK }, { title: 'x', guestIds: ['nobody'] }, { title: ADV_MARK + 'x'.repeat(300) }]) {
    assert.throws(() => Md.addEpisode(s, Object.assign({ showId: sh.id }, bad)), (err) => !err.message.includes(ADV_MARK));
  }
  assert.throws(() => Md.setRelease(s, e.id, 'film', sp.id, '2026-11-01'), /format/); assert.throws(() => Md.setRelease(s, e.id, 'text', 'nope', '2026-11-01'), /Platform/); assert.throws(() => Md.setRelease(s, e.id, 'text', sp.id, 'x'), /valid date/);
});
test('platform numbers: latest and monthly per platform; measures never added; a missing month is no data; flow measures add, point measures show the latest', () => {
  const s = mediaState(), sh = Md.addShow(s, { name: 'Night' }), [yt, sp] = sh.platforms, ep = Md.addEpisode(s, { showId: sh.id, title: 'E' }), ep2 = Md.addEpisode(s, { showId: sh.id, title: 'F' });
  const add = (platform, measure, value, date, episodeId) => Md.addStat(s, { showId: sh.id, platformId: platform.id, measure, value, date, episodeId }, TODAY);
  add(sp, 'downloads', 120, '2026-11-05'); add(sp, 'downloads', 80, '2026-11-09'); add(sp, 'views', 7, '2026-11-09'); add(yt, 'views', 1500, '2026-10-15');
  add(yt, 'subscribers', 40, '2026-11-01'); add(yt, 'subscribers', 55, '2026-11-10');
  const sum = Md.platformSummary(s, sh.id, '2026-11', 6), by = (p, m) => sum.find((x) => x.platformId === p.id).rows.find((r) => r.measure === m);
  assert.deepEqual(by(sp, 'downloads').months.map((m) => m.value), [null, null, null, null, null, 200]); assert.deepEqual(by(sp, 'downloads').latest, { date: '2026-11-09', value: 80 });
  assert.deepEqual(by(sp, 'views').months.map((m) => m.value), [null, null, null, null, null, 7], 'a different measure stays its own row');
  assert.deepEqual(by(yt, 'views').months.map((m) => m.value), [null, null, null, null, 1500, null]);
  assert.deepEqual(by(yt, 'subscribers').months.map((m) => m.value), [null, null, null, null, null, 55], 'a point measure shows the latest of the month');
  assert.equal(by(yt, 'downloads'), undefined, 'a measure never typed has no row');
  assert.deepEqual(sum.map((x) => x.rows.length), [2, 2, 0, 0, 0]);
  assert.ok(sum.every((p) => p.rows.every((r) => r.months.every((m) => m.value === null || (Number.isInteger(m.value) && m.value >= 0)))), 'no NaN and no fractions');
  // the same date, measure and episode again replaces; a platform-level number is preferred over episode numbers in a month, else the episode numbers add
  add(sp, 'downloads', 100, '2026-11-09'); assert.equal(s.platformStats.filter((x) => x.measure === 'downloads').length, 2);
  add(sp, 'listens', 30, '2026-11-02', ep.id); add(sp, 'listens', 20, '2026-11-03', ep2.id);
  assert.equal(Md.platformSummary(s, sh.id, '2026-11', 1)[1].rows.find((r) => r.measure === 'listens').months[0].value, 50, 'episode numbers add when there is no platform-level number');
  add(sp, 'listens', 500, '2026-11-04');
  assert.equal(Md.platformSummary(s, sh.id, '2026-11', 1)[1].rows.find((r) => r.measure === 'listens').months[0].value, 500, 'the platform-level number is not added to the episodes');
  assert.deepEqual(Md.episodeStats(s, ep.id), [{ platformId: sp.id, platform: 'Spotify', measure: 'listens', value: 30, date: '2026-11-02' }]);
  assert.throws(() => add(sp, 'likes', 1, '2026-11-01'), /measure/); assert.throws(() => add(sp, 'views', '1.5', '2026-11-01'), /whole number/); assert.throws(() => add(sp, 'views', '-3', '2026-11-01'), /whole number/);
  assert.throws(() => add(sp, 'views', ADV_MARK, '2026-11-01'), (e) => !e.message.includes(ADV_MARK));
  assert.throws(() => Md.addStat(s, { showId: sh.id, platformId: 'nope', measure: 'views', value: 1 }, TODAY), /platform/);
  const other = Md.addShow(s, { name: 'Other' }); assert.throws(() => Md.addStat(s, { showId: other.id, platformId: other.platforms[0].id, measure: 'views', value: 1, episodeId: ep.id }, TODAY), /another show/);
  Md.deleteStat(s, s.platformStats[0].id); assert.doesNotThrow(() => S.validateState(clone(s)));
  const empty = Md.platformSummary(S.validateState(Object.assign(clone(s), { platformStats: [] })), sh.id, '2026-11', 6);
  assert.ok(empty.every((p) => p.rows.length === 0), 'no numbers: no rows, never zeros');
});
test('cadence: episodes published per month (no data before the first), the gap since the last, and costs and revenue from the line of work', () => {
  const s = mediaState(), sh = Md.addShow(s, { name: 'Night', projectId: 'p1' }), sp = sh.platforms[1];
  const ep = (title, status, date) => { const e = Md.addEpisode(s, { showId: sh.id, title, status }); if (date) Md.setRelease(s, e.id, 'audio', sp.id, date); return e; };
  ep('a', 'published', '2026-09-03'); ep('b', 'published', '2026-09-20'); ep('c', 'published', '2026-11-03'); ep('d', 'recorded', '2026-11-08'); ep('e', 'published', null);
  const c = Md.cadence(s, sh.id, TODAY, 6);
  assert.deepEqual(c.perMonth.map((m) => [m.month, m.count]), [['2026-06', null], ['2026-07', null], ['2026-08', null], ['2026-09', 2], ['2026-10', 0], ['2026-11', 1]], 'a month before the first is no data; later months count');
  assert.deepEqual([c.published, c.last, c.gapDays], [3, '2026-11-03', 9], 'an unpublished episode and one with no date do not count');
  assert.deepEqual(Md.cadence(S.validateState(S.defaultState()), 'none', TODAY, 6).perMonth.map((m) => m.count), [null, null, null, null, null, null]);
  assert.equal(Md.cadence(S.validateState(S.defaultState()), 'none', TODAY, 6).gapDays, null);
  const m = Md.showMoney(s, sh, TODAY);
  assert.deepEqual(m.ytd, { revenueCents: 30000, expenseCents: 15000, netCents: 15000 }, 'expected income is not counted');
  assert.deepEqual(m.all, { revenueCents: 30000, expenseCents: 15000, netCents: 15000 });
  assert.equal(Md.showMoney(s, Md.addShow(s, { name: 'No line' }), TODAY), null);
  assert.deepEqual(Md.digest(s, WK), { episodesThisMonth: 1, sitesRenewing: 0 });
});

// ---------------------------------------------------------------- websites
test('sites: Admin renewals are created with generic titles, updated, linked and left in Admin on delete; monthly traffic reads no data for a gap', () => {
  const s = mediaState(), sh = Md.addShow(s, { name: 'Night' });
  const x = Md.addSite(s, { domain: 'night.example', purpose: 'show', host: 'Hostly', showId: sh.id, projectId: 'p1', domainRenewOn: '2026-12-01', domainCost: '15', hostRenewOn: '2027-03-01', hostCost: '120.50' }, TODAY);
  assert.deepEqual([x.hostname, x.kind, x.host], ['night.example', 'show', 'Hostly']);
  const rs = Md.renewalsOf(s, x);
  assert.deepEqual(rs.map((r) => [r.which, r.date, r.amountCents, r.state]), [['domain', '2026-12-01', 1500, 'open'], ['hosting', '2027-03-01', 12050, 'open']]);
  assert.deepEqual(s.renewals.filter((r) => [x.domainRenewalId, x.hostingRenewalId].includes(r.id)).map((r) => [r.title, r.kind, r.cadence, r.provider]), [['Domain renewal', 'registration', 'annual', ''], ['Hosting renewal', 'subscription', 'annual', 'Hostly']]);
  assert.ok(!JSON.stringify(s.renewals).includes('night.example'), 'the domain is not copied into Admin');
  const before = s.renewals.length;
  Md.updateSite(s, x.id, { domain: 'night.example', purpose: 'show', host: 'Hostly', domainRenewOn: '2026-12-10', domainCost: '20' }, TODAY);
  assert.equal(s.renewals.length, before, 'an update changes the linked renewal, it adds none'); assert.deepEqual(Md.renewalsOf(s, x)[0], { which: 'domain', id: x.domainRenewalId, date: '2026-12-10', amountCents: 2000, state: 'open' });
  assert.deepEqual([x.showId, x.projectId], [undefined, undefined], 'an edit that leaves them empty clears them');
  assert.deepEqual(Md.sitesRenewing(s, TODAY, 30).map((q) => q.id), [x.id]); assert.deepEqual(Md.sitesRenewing(s, TODAY, 5), []);
  assert.deepEqual(Md.digest(s, WK), { episodesThisMonth: 0, sitesRenewing: 1 });
  A.completeRenewal && void 0; s.renewals.find((r) => r.id === x.domainRenewalId).state = 'done';
  assert.deepEqual(Md.digest(s, WK).sitesRenewing, 0, 'a closed renewal is not upcoming');
  // link an existing Admin renewal; unlinking and deleting never delete a renewal
  const own = A.addRenewal(s, { title: 'Own', dueDate: '2026-11-20', kind: 'other' }, TODAY);
  Md.linkRenewal(s, x.id, 'hosting', own.id); assert.equal(x.hostingRenewalId, own.id); Md.linkRenewal(s, x.id, 'hosting', ''); assert.equal(x.hostingRenewalId, undefined);
  assert.throws(() => Md.linkRenewal(s, x.id, 'hosting', 'nope'), /not found/); assert.throws(() => Md.linkRenewal(s, x.id, 'other', own.id), /domain or hosting/);
  const n = s.renewals.length;
  Md.deleteSite(s, x.id); assert.equal(s.renewals.length, n); assert.deepEqual([s.sites.length, s.siteTraffic.length], [0, 0]);
  assert.throws(() => Md.addSite(s, { domain: '' }, TODAY), /Enter the domain/); assert.throws(() => Md.addSite(s, { domain: 'a', purpose: ADV_MARK }, TODAY), (e) => !e.message.includes(ADV_MARK));
  assert.throws(() => Md.addSite(s, { domain: 'a', domainRenewOn: ADV_MARK }, TODAY), (e) => !e.message.includes(ADV_MARK)); assert.throws(() => Md.addSite(s, { domain: 'a', domainCost: '-1' }, TODAY), /cost/);
  assert.throws(() => Md.addSite(s, { domain: 'SSN 123-45-6789' }, TODAY), (e) => !e.message.includes('123-45'));
});
test('traffic: typed per site and month, the same month replaces, a gap is no data (never 0 or NaN), visitors are optional', () => {
  const s = mediaState(), x = Md.addSite(s, { domain: 'a.example', purpose: 'business' }, TODAY);
  Md.addTraffic(s, { siteId: x.id, month: '2026-11', visits: '1,234', visitors: '900' }); Md.addTraffic(s, { siteId: x.id, month: '2026-09', visits: '55' }); Md.addTraffic(s, { siteId: x.id, month: '2026-11', visits: '2000' });
  assert.equal(s.siteTraffic.length, 2);
  const m = Md.trafficMonths(s, x.id, '2026-11', 4);
  assert.deepEqual(m.map((r) => [r.month, r.visits, r.visitors]), [['2026-08', null, null], ['2026-09', 55, null], ['2026-10', null, null], ['2026-11', 2000, null]]);
  assert.ok(m.every((r) => r.visits === null || Number.isInteger(r.visits)));
  assert.deepEqual(Md.trafficMonths(S.validateState(S.defaultState()), 'none', '2026-11', 3).map((r) => r.visits), [null, null, null]);
  for (const bad of [{ month: '2026-13', visits: '1' }, { month: ADV_MARK, visits: '1' }, { month: '2026-11', visits: '-1' }, { month: '2026-11', visits: '1.5' }, { month: '2026-11', visits: ADV_MARK }, { month: '2026-11', visits: '1', visitors: 'x' }]) assert.throws(() => Md.addTraffic(s, Object.assign({ siteId: x.id }, bad)), (e) => !e.message.includes(ADV_MARK));
  Md.deleteTraffic(s, s.siteTraffic[0].id); assert.equal(s.siteTraffic.length, 1);
  assert.doesNotThrow(() => S.validateState(clone(s)));
});

// ---------------------------------------------------------------- privacy: nothing typed leaves the vault
const NUMS = ['9876543210', '98765432', '7654321987', '8765432198', '6543219876', '98,765,432', '7,654,321,987', '8,765,432,198'];
test('no client, person, show, episode, platform, domain, host, note or per-client money reaches the digest, any prompt, an insight, consolidation, a target proposal, the calendar file, diagnostics or an error', async () => {
  const { state } = buildAdversarial(L);
  assert.ok(state.clients[0].name.includes(ADV_MARK) && state.sites[0].hostname.includes(ADV_MARK) && state.shows[0].platforms[0].name.includes(ADV_MARK) && state.episodes[0].title.includes(ADV_MARK));
  state.invoices[0].dueDate = '2026-11-01';
  const dg = M.weeklyDigest(state, WK);
  assert.deepEqual(dg.media, { clientsOverdue: 1, episodesThisMonth: 1, sitesRenewing: 1 }, 'numbers only');
  assert.deepEqual(Object.keys(dg.media).sort(), ['clientsOverdue', 'episodesThisMonth', 'sitesRenewing']);
  const out = [JSON.stringify(dg)];
  for (const [lvl, period] of [[1, { from: WK, to: '2026-11-15' }], [2, { from: '2026-11-01', to: '2026-11-30' }], [3, { from: '2026-10-01', to: '2026-12-31' }]]) { const p = Mem.buildPrompt(state, lvl, period); out.push(p.system, p.user); }
  assert.match(Mem.buildPrompt(state, 1, { from: WK, to: '2026-11-15' }).user, /clients and media detail \(numbers only\): clients with an overdue invoice 1, episodes published this month 1, sites with a renewal in the next 30 days 1/);
  const s = clone(state);
  const ins = Mem.rulesInsights(s, WK); out.push(JSON.stringify(ins));
  Mem.propose(s, ins.length ? ins : [{ domain: 'work', text: 'Pipeline moved' }], { level: 1, period: { from: WK, to: '2026-11-15' }, source: 'rules' });
  out.push(JSON.stringify(s.memory.insights), JSON.stringify(Mem.consolidationOffers(s, '2026-12-02')));
  try { Mem.mergeByRules(s, 2, { from: '2026-11-01', to: '2026-11-30' }); } catch (e) { /* nothing approved to merge */ } out.push(JSON.stringify(s.memory.insights));
  Mem.propose(s, [{ domain: 'social', text: 'Contact more often', target: { key: 'contactDays', value: 10 } }], { level: 1, period: { from: WK, to: '2026-11-15' }, source: 'ai' });
  out.push(JSON.stringify(Mem.targetPreview(s, s.memory.insights[s.memory.insights.length - 1].id)));
  const cal = Cal.build(s, { today: TODAY, stamp: new Date('2026-11-10T00:00:00Z') }); out.push(cal.text);
  assert.ok(cal.text.includes('LifeOS: renewal due'), 'the site renewal is in the file with the generic label');
  out.push(Cal.build(s, { today: TODAY, realTitles: true, stamp: new Date('2026-11-10T00:00:00Z') }).text);
  // errors raised with marked input, recorded in diagnostics
  const w = clone(state);
  const tries = [() => Cl.addClient(w, { name: ADV_MARK + 'x'.repeat(300) }, TODAY), () => Cl.addClient(w, { name: 'ok', budget: ADV_MARK }, TODAY), () => Cl.addClient(w, { name: 'ok', status: ADV_MARK }, TODAY),
    () => Md.addShow(w, { name: ADV_MARK + 'x'.repeat(300) }), () => Md.addEpisode(w, { showId: 'sh1', title: 'ok', status: ADV_MARK }), () => Md.addPlatform(w, 'sh1', ADV_MARK.repeat(10)),
    () => Md.addStat(w, { showId: 'sh1', platformId: 'pf1', measure: ADV_MARK, value: 1 }, TODAY), () => Md.addStat(w, { showId: 'sh1', platformId: 'pf1', measure: 'views', value: ADV_MARK }, TODAY),
    () => Md.addSite(w, { domain: ADV_MARK + 'x'.repeat(300) }, TODAY), () => Md.addTraffic(w, { siteId: 'st1', month: ADV_MARK, visits: 1 }), () => Md.addTraffic(w, { siteId: 'st1', month: '2026-11', visits: ADV_MARK }),
    () => S.validateState(Object.assign(clone(state), { clients: [Object.assign(clone(state.clients[0]), { name: ADV_MARK + 'x'.repeat(300) })] })), () => S.validateState(Object.assign(clone(state), { sites: [Object.assign(clone(state.sites[0]), { kind: ADV_MARK })] })),
    () => S.validateState(Object.assign(clone(state), { platformStats: [Object.assign(clone(state.platformStats[0]), { measure: ADV_MARK })] }))];
  for (const f of tries) { try { f(); assert.fail('accepted'); } catch (e) { out.push(e.message); O.recordError(e, 'business'); } }
  out.push(O.format(s, { version: '1.7.0', userAgent: 'Chrome' }));
  const all = out.join('\n');
  const texts = []; const grab = (v) => { if (typeof v === 'string') { if (v.length > 3 && /[a-z]/i.test(v) && !/^\d{4}-\d{2}/.test(v) && !['active', 'paused', 'past', 'show', 'business', 'video', 'audio', 'published', 'views', 'downloads'].includes(v)) texts.push(v); } else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { if (k !== 'id' && !/Id$/.test(k)) grab(x); }); };
  for (const c of MEDIA_COLLECTIONS) grab(state[c]);
  assert.ok(texts.length > 8 && texts.some((x) => x.includes(ADV_MARK)));
  const errs = out.slice(out.length - tries.length - 1, out.length - 1).join('\n');
  assert.ok(!errs.includes(ADV_MARK), 'errors never echo typed text');
  for (const x of texts) assert.ok(!all.includes(x), 'leaked: ' + x.slice(0, 40));
  const flat = all.replace(/[ ,.$]/g, '');
  for (const n of NUMS) assert.ok(!all.includes(n) && !flat.includes(n.replace(/[ ,.$]/g, '')), 'number ' + n);
  for (const w2 of ['Acme', 'YouTube', 'Spotify']) assert.ok(!all.includes(w2), w2);
});
test('with the vault open a private client, show or site is still absent from the digest, prompts and the calendar file', async () => {
  const { state } = buildAdversarial(L);
  await vault(state, { priv: true });
  await P.open(PRIV);
  for (const [c, id] of [['clients', 'cl1'], ['shows', 'sh1'], ['sites', 'st1']]) await P.moveIn(c, id);
  const v = P.view(S.getState());
  assert.equal(v.clients.length, 1); assert.equal(v.episodes.length, 1, 'the show moved with its episodes'); assert.equal(v.platformStats.length, 1); assert.equal(v.siteTraffic.length, 1);
  assert.deepEqual(M.weeklyDigest(v, WK).media, { clientsOverdue: 0, episodesThisMonth: 0, sitesRenewing: 0 }, 'the digest uses the main state alone (the site renewal in Admin is public)');
  const p = Mem.buildPrompt(v, 1, { from: WK, to: '2026-11-15' });
  assert.ok(!(p.system + p.user).includes(ADV_MARK));
  const cal = Cal.build(v, { today: TODAY, realTitles: true });
  for (const x of [state.clients[0].name, state.sites[0].hostname, state.shows[0].name, state.episodes[0].title]) assert.ok(!cal.text.includes(x) && !(p.system + p.user).includes(x));
  P.close('test');
  const main = S.getState();
  for (const c of MEDIA_COLLECTIONS) assert.equal(main[c].length, 0, c + ' is empty in the main state');
  assert.ok(main.priv.marks.includes('clients') && main.priv.marks.includes('shows') && main.priv.marks.includes('episodes') && main.priv.marks.includes('platformStats') && main.priv.marks.includes('sites') && main.priv.marks.includes('siteTraffic'));
  // SEC-126: the moved records' own text is nowhere in the main state (other adversarial records stay public, so the marker alone proves nothing)
  const mainText = JSON.stringify(Object.assign({}, main, { priv: 0 }));
  for (const x of [state.clients[0].name, state.clients[0].notes, state.shows[0].name, state.shows[0].notes, state.shows[0].platforms[0].name, state.episodes[0].title, state.episodes[0].notes, state.sites[0].hostname, state.sites[0].host, state.sites[0].notes]) assert.ok(!mainText.includes(x), 'main holds ' + x.slice(0, 30));
  assert.doesNotThrow(() => S.validateState(clone(main)));
  assert.equal(main.invoices[0].clientId, undefined, 'the public invoice holds no link to the private client');
  // the totals that skip private records are what the closed view shows; the lock marker is drawn from the marks
  assert.deepEqual(Cl.counts(main, TODAY), { clients: 0, overdueInvoices: 0, noContact: 0 });
  await P.open(PRIV);
  const back = P.view(S.getState());
  assert.equal(back.invoices[0].clientId, 'cl1', 'the link comes back with the vault open');
  assert.deepEqual(Cl.counts(back, TODAY).clients, 1);
  P.close('test');
});
test('private moves keep parents and children together: a show with its episodes and numbers, an episode with its numbers, a site with its traffic', async () => {
  const { state } = buildAdversarial(L);
  await vault(state, { priv: true }); await P.open(PRIV);
  await P.moveIn('episodes', 'ep1');
  assert.deepEqual([S.getState().episodes.length, S.getState().platformStats.length, S.getState().shows.length], [0, 0, 1], 'an episode takes the numbers typed for it');
  await P.moveOut('episodes', 'ep1');
  assert.equal(S.getState().episodes.length, 1);
  await P.moveIn('sites', 'st1'); assert.deepEqual([S.getState().sites.length, S.getState().siteTraffic.length, S.getState().shows[0].siteId], [0, 0, undefined]);
  assert.doesNotThrow(() => S.validateState(clone(S.getState())));
  await P.moveOut('sites', 'st1'); assert.equal(S.getState().shows[0].siteId, 'st1', 'the link returns');
  await P.moveIn('platformStats', 'ps1'); assert.equal(S.getState().platformStats.length, 0); assert.equal(S.getState().episodes.length, 1);
  await P.moveOut('platformStats', 'ps1');
  P.close('test');
  assert.deepEqual(S.getState().priv.marks, []);
});

// ---------------------------------------------------------------- search, glance, copy
test('search covers clients, shows, episodes, platforms and sites; fixed values and ids are left out', async () => {
  const { state } = buildAdversarial(L);
  await vault(state);
  const hit = (q) => Q.query(q).groups.map((g) => g.area + ':' + g.items.map((i) => i.coll).sort().join('+'));
  assert.deepEqual(hit('client name'), ['clients:clients']);
  assert.deepEqual(hit('show name'), ['podcasts:shows']); assert.deepEqual(hit('episode title'), ['podcasts:episodes']); assert.deepEqual(hit('domain "x"'), ['websites:sites']);
  assert.deepEqual(Q.query('downloads').total, 0, 'a measure is a fixed value'); assert.deepEqual(Q.query('published').groups.filter((g) => g.area === 'podcasts'), [], 'a status is a fixed value');
  assert.equal(Q.AREAS.clients[1], 'clients'); assert.equal(Q.AREAS.podcasts[1], 'podcasts'); assert.equal(Q.AREAS.websites[1], 'websites');
  Q.drop();
});
test('at a glance: generic labels and counts only; navigation: the three screens are in the More sheet and resolve both ways', () => {
  const { state } = buildAdversarial(L); state.invoices[0].dueDate = '2026-11-01';
  const before = Ac.glanceProviders().map((p) => p.id);
  Cl.registerGlance(); Cl.registerGlance();
  assert.deepEqual(Ac.glanceProviders().map((p) => p.id), before.includes('client-flags') ? before : before.concat(['client-flags']));
  const g = Ac.glance(state, TODAY);
  assert.ok(JSON.stringify(g).includes('Clients with an overdue invoice: 1'));
  for (const x of [state.clients[0].name, state.sites[0].hostname, state.shows[0].name, state.episodes[0].title]) assert.ok(!JSON.stringify(g).includes(x));
  Ac.unregisterGlanceProvider('client-flags');
  const N = L.nav;
  for (const [label, key] of [['AYiN and clients', 'clients'], ['Podcasts', 'podcasts'], ['Websites', 'websites']]) {
    assert.ok(N.MORE.some((x) => x.label === label && x.key === key), label);
    assert.deepEqual(N.viewOf(key), { name: key }); assert.equal(N.keyOf({ name: key }), key); assert.ok(N.entryOk(key));
  }
  assert.ok(N.MORE.findIndex((x) => x.key === 'clients') === N.MORE.findIndex((x) => x.key === 'business') + 1, 'beside Business');
});
test('banned patterns: no em dash, no advice wording and no unsafe DOM call in the new code, and every new input comes from the one helper that turns spell check off', () => {
  const files = ['src/core/clients.js', 'src/core/media.js'];
  for (const f of files) {
    const t = src(f);
    assert.ok(!/\u2014/.test(t), f + ' em dash');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|localStorage/.test(t), f);
  }
  const ui = src('src/ui/app.js'), start = ui.indexOf('// ---------- AYiN and clients, Podcasts and Websites (v1.7.0)'), block = ui.slice(start, ui.indexOf('function boot()'));
  assert.ok(start > 0 && block.length > 5000);
  assert.ok(!/\u2014/.test(block)); assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|localStorage/.test(block));
  assert.ok(!/\b(should|recommend|you ought|we suggest|advice)\b/i.test(block.replace(/\/\/[^\n]*/g, '')), 'no advice wording in the copy');
  assert.ok(!/createElement\('(input|textarea)'\)/.test(block), 'inputs are made by h(), which sets spellcheck, autocorrect and autocapitalize off');
  const h = ui.slice(ui.indexOf('function h(tag, props)'), ui.indexOf('function labelled'));
  assert.ok(/spellcheck', 'false'/.test(h) && /autocorrect', 'off'/.test(h) && /autocapitalize', 'off'/.test(h));
  assert.match(src('docs/CHANGELOG.md'), /^## 1\.7\.0 \(schema 19\)/m);
});

// ---------------------------------------------------------------- performance at the caps
test('performance at the caps: 500 clients, 50 shows, 5000 episodes, 20000 numbers, 100 sites and 6000 traffic months validate and summarise quickly', () => {
  const t0 = Date.now();
  const st = build((s) => {
    s.projects.push(proj('p1', 'L')); s.people.push(person('pa', 'Pat'));
    for (let i = 0; i < 500; i++) s.clients.push({ id: 'c' + i, name: 'Client ' + i, status: i % 3 ? 'active' : 'paused', projectId: 'p1', budgetCents: 1000 * i, personIds: ['pa'], notes: '', createdOn: '2026-01-01' });
    for (let i = 0; i < 100; i++) s.sites.push({ id: 's' + i, hostname: 'site' + i + '.example', kind: 'other', host: '', notes: '' });
    for (let i = 0; i < 50; i++) s.shows.push({ id: 'sh' + i, name: 'Show ' + i, siteId: 's' + i, platforms: [{ id: 'a' + i, name: 'A' }, { id: 'b' + i, name: 'B' }], notes: '' });
    for (let i = 0; i < 5000; i++) s.episodes.push({ id: 'e' + i, showId: 'sh' + (i % 50), title: 'Ep ' + i, status: 'published', guestIds: ['pa'], pubs: [{ format: 'audio', platformId: 'a' + (i % 50), date: '2026-' + String(1 + (i % 11)).padStart(2, '0') + '-10' }], notes: '' });
    for (let i = 0; i < 20000; i++) s.platformStats.push({ id: 'n' + i, showId: 'sh' + (i % 50), platformId: 'a' + (i % 50), date: '2026-' + String(1 + (i % 11)).padStart(2, '0') + '-' + String(1 + (i % 27)).padStart(2, '0'), measure: Md.MEASURES[i % 6], value: i });
    for (let i = 0; i < 6000; i++) s.siteTraffic.push({ id: 't' + i, siteId: 's' + (i % 100), month: String(2000 + Math.floor(i / 100) % 60 + 0) + '-' + String(1 + (i % 12)).padStart(2, '0'), visits: i });
  });
  const tv = Date.now() - t0, t1 = Date.now();
  const r = Cl.rollup(st, TODAY), cn = Cl.counts(st, TODAY), d = Md.digest(st, WK);
  for (let i = 0; i < 50; i++) { Md.platformSummary(st, 'sh' + i, '2026-11', 6); Md.cadence(st, 'sh' + i, TODAY, 6); }
  const tc = Date.now() - t1;
  assert.equal(st.clients.length, 500); assert.ok(r.totals.year.revenueCents >= 0 && cn.clients === 500 && d.episodesThisMonth >= 0);
  assert.ok(tv < 8000, 'validate ' + tv + ' ms'); assert.ok(tc < 4000, 'numbers ' + tc + ' ms');
});
