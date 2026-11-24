(function () {
  'use strict';
  // v1.6.0 B14: job search. Applications are the Work pipeline items of kind 'job'; this module holds the rules on top of them: the
  // add and edit checks, stage moves, follow-ups, funnel and weekly numbers, links to Social people, the CSV import and the numbers the
  // digest may carry. Nothing here is automatic: every write is a function a user tap calls inside a commit.
  // Compensation (OTE and base, target and offer, integer cents) is shown only to the owner. It is never part of the digest, a prompt,
  // an insight, the audit log, an error, a calendar file or a diagnostic. Funnel rates are null ("no data") when the denominator is zero.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const SOURCES = Object.freeze(['referral', 'recruiter', 'job board', 'direct', 'network']);
  const LOCATIONS = Object.freeze(['remote', 'hybrid', 'on site']);
  const REASONS = Object.freeze(['no response', 'rejected', 'withdrew', 'role closed', 'other']);
  const STAGES = Object.freeze(['lead', 'contacted', 'applied', 'interview', 'offer', 'won', 'lost']);
  const OPEN = Object.freeze(['lead', 'contacted', 'applied', 'interview', 'offer']);
  const COMP = Object.freeze(['targetOteCents', 'targetBaseCents', 'offerOteCents', 'offerBaseCents']);
  const CAP = 1000, NOTES_MAX = 2000, TEXT_MAX = 200, RESUME_MAX = 60;
  const SECRET_MESSAGE = 'That looks like an ID number or a card number. Do not enter ID numbers, account numbers or passwords here.';
  const BIDI = /[؜​-‏‪-‮⁠-⁩﻿]/g;
  const M = () => L.metrics;
  const given = (v) => v !== undefined && v !== null && v !== '';
  const list = (state, k) => (state && Array.isArray(state[k]) ? state[k] : []);
  const isJob = (x) => !!x && x.kind === 'job';
  const jobsOf = (state) => list(state, 'pipeline').filter(isJob);
  const isOpen = (x) => OPEN.includes(x.stage);
  // Same folding as names elsewhere: invisible characters out, whitespace collapsed, case folded.
  const norm = (s) => String(s == null ? '' : s).replace(BIDI, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const pct = (n, d) => (d > 0 ? Math.round((n * 1000) / d) / 10 : null);

  // ---- classification (one definition, used by every number below) ----
  // Applied: an applied date is set, or the item is at applied, interview, offer or won.
  const isApplied = (x) => isJob(x) && (!!x.appliedOn || ['applied', 'interview', 'offer', 'won'].includes(x.stage));
  // Responded: an applied item that is now at contacted or later (interview, offer, won), or was lost with the reason "rejected".
  const responded = (x) => isApplied(x) && (['contacted', 'interview', 'offer', 'won'].includes(x.stage) || (x.stage === 'lost' && x.lostReason === 'rejected'));
  const interviewed = (x) => isApplied(x) && ['interview', 'offer', 'won'].includes(x.stage);
  const offered = (x) => isApplied(x) && ['offer', 'won'].includes(x.stage);
  const sourceOf = (x) => { const k = norm(x.source); return !k ? 'unknown' : SOURCES.includes(k) ? k : 'other'; };
  const monthOf = (x) => (x.appliedOn || x.updatedAt).slice(0, 7);

  // ---- funnel: counts per stage now and per month, and the three rates ----
  function rates(items) {
    const a = items.filter(isApplied).length, r = items.filter(responded).length, i = items.filter(interviewed).length, o = items.filter(offered).length;
    return { applied: a, responded: r, interviews: i, offers: o, responseRate: pct(r, a), interviewRate: pct(i, a), offerRate: pct(o, a) };
  }
  function funnel(state) {
    const items = jobsOf(state), counts = {};
    for (const s of STAGES) counts[s] = 0;
    for (const x of items) counts[x.stage]++;
    const months = new Map();
    for (const x of items) { const k = monthOf(x); if (!months.has(k)) months.set(k, []); months.get(k).push(x); }
    const byMonth = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, xs]) => {
      const c = {}; for (const s of STAGES) c[s] = xs.filter((x) => x.stage === s).length;
      return Object.assign({ month, items: xs.length, counts: c }, rates(xs));
    });
    const bySource = new Map();
    for (const x of items) bySource.set(sourceOf(x), (bySource.get(sourceOf(x)) || 0) + 1);
    return Object.assign({ total: items.length, open: items.filter(isOpen).length, counts, byMonth, sources: [...bySource.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)) }, rates(items));
  }

  // ---- follow-ups ----
  // Open items with a follow-up date, soonest first. due: on or before `asOf`.
  function followUps(state, asOf) {
    return jobsOf(state).filter((x) => isOpen(x) && x.followUp).map((x) => ({ id: x.id, title: x.title, org: x.org || '', date: x.followUp, overdue: x.followUp < asOf, due: x.followUp <= asOf }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  }
  const followUpsDueBy = (state, d) => jobsOf(state).filter((x) => isOpen(x) && x.followUp && x.followUp <= d);

  // ---- people: Social people linked to job items through the existing pipeline links ----
  function peopleOf(state, id, asOf) { return L.social ? L.social.peopleForPipeline(state, id, M().isDate(asOf) ? asOf : M().todayISO()) : []; }
  function linkedPersonIds(state) {
    const ids = new Set(jobsOf(state).map((x) => x.id)), out = new Set();
    for (const p of list(state, 'people')) if (!p.archived && (p.pipelineIds || []).some((i) => ids.has(i))) out.add(p.id);
    return out;
  }

  // ---- weekly view (Monday start, same as every other weekly number) ----
  function weekly(state, wk) {
    const ws = M().weekStart(wk), we = M().addDays(ws, 6), jobs = jobsOf(state), inW = (d) => !!d && d >= ws && d <= we;
    const people = linkedPersonIds(state), contacts = list(state, 'contacts').filter((c) => c.personId && people.has(c.personId) && inW(c.date));
    const apps = jobs.filter((x) => inW(x.appliedOn)), bySource = new Map();
    for (const x of apps) bySource.set(sourceOf(x), (bySource.get(sourceOf(x)) || 0) + 1);
    return {
      week: ws, end: we, applications: apps.length, followUpsDone: jobs.filter((x) => inW(x.followedUpOn)).length,
      outreach: contacts.length, peopleContacted: new Set(contacts.map((c) => c.personId)).size,
      followUpsDue: followUpsDueBy(state, we).length, interviews: jobs.filter((x) => x.stage === 'interview').length, offers: jobs.filter((x) => x.stage === 'offer').length,
      sources: [...bySource.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
    };
  }
  // The only job numbers the digest carries. Callers pass the main state (the digest never sees private records).
  function digest(state, wk) {
    const w = weekly(state, wk);
    return { applied: w.applications, followUpsDue: w.followUpsDue, interviews: w.interviews, offers: w.offers };
  }
  const hasData = (state) => jobsOf(state).length > 0;
  function reviewWeek(state, wk, today) {
    const w = weekly(state, wk), asOf = M().isDate(today) ? today : w.end;
    // Due by the week's end, but overdue only when the date is before today: a follow-up later this week is not late yet.
    const due = followUps(state, w.end).filter((x) => x.due).map((x) => Object.assign(x, { overdue: x.date < asOf }));
    return { weekly: w, due, asOf };
  }

  // ---- add and edit ----
  const fail = (m) => { throw new Error(m); };
  function text(v, max, name, req) {
    const s = String(v == null ? '' : v).replace(BIDI, '').replace(/\s+/g, ' ').trim();
    if (req && !s) fail('Enter the ' + name + '.');
    if (s.length > max) fail('The ' + name + ' can be up to ' + max + ' characters.');
    if (L.admin && L.admin.looksSecret(s)) fail(SECRET_MESSAGE);
    return s;
  }
  function dateIn(v, name) { if (!M().isDate(v)) fail('The ' + name + ' must be a valid date.'); return v; }
  // Dollars as typed ("175,000" or "$175000.50") to integer cents; never floating point.
  function centsIn(v, name) {
    const c = L.revenue.parseCents(String(v));
    if (c === null || c < 0 || c > 100000000000) fail('The ' + name + ' must be an amount from 0 to 1,000,000,000.');
    return c;
  }
  const titleOf = (role, org) => (role && org ? role + ' at ' + org : role || org).slice(0, 200);
  // input: { role, org, locationType, source, appliedOn, resume, followUp, nextStep, notes, lostReason, targetOte, targetBase, offerOte, offerBase }
  // (the four amounts in dollars as typed). Returns the checked fields for the item; empty values clear a field.
  function fieldsIn(input) {
    if (!input || typeof input !== 'object') fail('Application must be an object');
    const o = {};
    o.role = text(input.role, TEXT_MAX, 'role');
    o.org = text(input.org, TEXT_MAX, 'company');
    if (!o.role && !o.org) fail('Enter the role or the company.');
    o.source = text(input.source, TEXT_MAX, 'source');
    o.nextStep = text(input.nextStep, TEXT_MAX, 'next step');
    o.notes = text(input.notes, NOTES_MAX, 'notes');
    o.resume = text(input.resume, RESUME_MAX, 'resume version');
    if (given(input.locationType)) { if (!LOCATIONS.includes(input.locationType)) fail('Pick a location type from the list.'); o.locationType = input.locationType; } else o.locationType = '';
    if (given(input.lostReason)) { if (!REASONS.includes(input.lostReason)) fail('Pick an outcome reason from the list.'); o.lostReason = input.lostReason; } else o.lostReason = '';
    o.appliedOn = given(input.appliedOn) ? dateIn(input.appliedOn, 'applied date') : '';
    o.followUp = given(input.followUp) ? dateIn(input.followUp, 'follow-up date') : '';
    for (const [k, f] of [['targetOte', 'targetOteCents'], ['targetBase', 'targetBaseCents'], ['offerOte', 'offerOteCents'], ['offerBase', 'offerBaseCents']]) o[f] = given(input[k]) ? centsIn(input[k], k.replace(/([A-Z])/g, ' $1').toLowerCase()) : null;
    return o;
  }
  const OPTIONAL = ['role', 'locationType', 'resume', 'appliedOn', 'followUp', 'lostReason'].concat(COMP);
  function apply(item, f) {
    item.org = f.org; item.source = f.source; item.nextStep = f.nextStep; item.notes = f.notes;
    item.title = titleOf(f.role, f.org);
    for (const k of OPTIONAL) { if (f[k] === '' || f[k] === null || f[k] === undefined) delete item[k]; else item[k] = f[k]; }
    if (item.stage !== 'lost') delete item.lostReason;
  }
  function addJob(state, input, today) {
    if (list(state, 'pipeline').length >= CAP) fail('You can keep up to ' + CAP + ' pipeline items.');
    const f = fieldsIn(input), stage = given(input.stage) ? input.stage : 'lead';
    if (!STAGES.includes(stage)) fail('Pick a stage from the list.');
    const t = M().isDate(today) ? today : M().todayISO();
    const item = { id: L.store.newId(), kind: 'job', stage, updatedAt: t };
    apply(item, f);
    if (!item.appliedOn && ['applied', 'interview', 'offer', 'won'].includes(stage)) item.appliedOn = t;
    state.pipeline = list(state, 'pipeline').concat([item]);
    return item;
  }
  const find = (state, id) => { const x = list(state, 'pipeline').find((p) => p.id === id); if (!x) fail('Application not found'); if (!isJob(x)) fail('That item is not a job application.'); return x; };
  function updateJob(state, id, input, today) {
    const x = find(state, id), f = fieldsIn(input);
    apply(x, f);
    x.updatedAt = M().isDate(today) ? today : M().todayISO();
    return x;
  }
  // A stage move. Moving to applied sets the applied date when there is none; leaving lost drops the reason. `reason` only applies to lost.
  function setStage(state, id, stage, today, reason) {
    const x = find(state, id);
    if (!STAGES.includes(stage)) fail('Pick a stage from the list.');
    if (stage === 'lost' && given(reason) && !REASONS.includes(reason)) fail('Pick an outcome reason from the list.');
    stamp(x, stage, today);
    if (stage === 'lost' && given(reason)) x.lostReason = reason;
    return x;
  }
  // SEC-111: the one stage rule for a job item, also used by the Work board and its add form (a job moved or added there at applied or
  // later gets its applied date, so it counts in "applications this week" and the digest exactly as from the Job search tab).
  function stamp(x, stage, today) {
    if (!isJob(x) || !STAGES.includes(stage)) return x;
    const t = M().isDate(today) ? today : M().todayISO();
    x.stage = stage; x.updatedAt = t;
    if (['applied', 'interview', 'offer', 'won'].includes(stage) && !x.appliedOn) x.appliedOn = t;
    if (stage !== 'lost') delete x.lostReason;
    return x;
  }
  // "Followed up": records today as the follow-up done and clears the date, or sets the next one when given.
  function markFollowedUp(state, id, today, nextDate) {
    const x = find(state, id), t = M().isDate(today) ? today : M().todayISO();
    x.followedUpOn = t; x.updatedAt = t;
    if (given(nextDate)) x.followUp = dateIn(nextDate, 'next follow-up date'); else delete x.followUp;
    return x;
  }
  // One-tap contact log for a person linked to this application. The person must already be linked; nothing is linked here.
  function logContact(state, id, personId, today, channel) {
    const x = find(state, id), p = list(state, 'people').find((q) => q.id === personId);
    if (!p || !(p.pipelineIds || []).includes(x.id)) fail('That person is not linked to this application.');
    const t = M().isDate(today) ? today : M().todayISO();
    const c = L.social.logContact(state, personId, { date: t, channel: given(channel) ? channel : 'other' }, t);
    x.updatedAt = t;
    return c;
  }

  // ---- CSV import (the ledger import pattern: map, preview, importKey dedupe, unknown values offered, never created) ----
  const TARGETS = Object.freeze(['role', 'company', 'stage', 'location', 'source', 'appliedOn', 'followUp', 'resume', 'lostReason', 'notes', 'nextStep', 'targetOte', 'targetBase', 'offerOte', 'offerBase']);
  const ENUM = { stage: STAGES, location: LOCATIONS, source: SOURCES, lostReason: REASONS };
  const key = (v) => norm(v).replace(/[_-]/g, ' ');
  const importKey = (company, role, appliedOn, occurrence) => L.revenue.sha256Hex([norm(company), norm(role), appliedOn || ''].concat(occurrence > 0 ? [String(occurrence)] : []).join('\u001f'));
  // opts: { map:{target:columnIndex}, dateFormat:'auto'|'dmy', defaultStage, values:{stage|location|source|lostReason:{value:target}}, asPrivate }
  // Unknown stage values reject their rows until the user maps them; unknown location, source and reason values leave that field empty
  // until mapped. Every unknown value is listed in `unknown`, and nothing is created from it.
  async function planImport(parsed, opts, state, today) {
    if (!parsed || !Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) fail('Nothing to import');
    if (!opts || typeof opts.map !== 'object' || !opts.map) fail('Column mapping required');
    const map = {}, nh = parsed.headers.length;
    for (const k of TARGETS) { const v = opts.map[k]; if (v === undefined || v === null || v === '') continue; if (!Number.isInteger(v) || v < 0 || v >= nh) fail('Column not found for ' + k); map[k] = v; }
    if (map.company === undefined && map.role === undefined) fail('Choose the company or the role column.');
    const fmt = opts.dateFormat === 'dmy' ? 'dmy' : 'auto', rv = L.revenue;
    const dflt = given(opts.defaultStage) ? opts.defaultStage : 'applied';
    if (!STAGES.includes(dflt)) fail('Pick a stage from the list.');
    const empty = (extra) => Object.assign({ rows: parsed.rows.length, add: [], rejected: [], duplicates: 0, byStage: {}, unknown: { stage: [], location: [], source: [], lostReason: [] }, empty: true }, extra);
    // PV-1: the main state alone cannot tell which rows were already imported and then moved into the private vault.
    const pm = state.priv && Array.isArray(state.priv.marks) ? state.priv.marks : [];
    if (pm.includes('pipeline')) return empty({ blocked: 'private' });
    const vmap = {};
    for (const f of Object.keys(ENUM)) { vmap[f] = new Map(); const src = (opts.values && opts.values[f]) || {}; for (const k of Object.keys(src)) { if (ENUM[f].includes(src[k])) vmap[f].set(key(k), src[k]); } }
    const resolve = (f, raw) => { const k = key(raw); if (!k) return { v: '' }; const direct = ENUM[f].find((e) => e === k); if (direct) return { v: direct }; if (vmap[f].has(k)) return { v: vmap[f].get(k) }; return { v: '', unknown: raw }; };
    const have = new Set();
    for (const x of list(state, 'pipeline')) if (x.importKey) have.add(x.importKey);
    const seenInFile = new Map(), unknown = { stage: new Map(), location: new Map(), source: new Map(), lostReason: new Map() };
    const add = [], rejected = [], byStage = {};
    let duplicates = 0;
    for (let i = 0; i < parsed.rows.length; i++) {
      const r = parsed.rows[i], rowNo = i + 2, reject = (why) => rejected.push({ row: rowNo, reason: why });
      if (!Array.isArray(r) || r.length !== nh) { reject('wrong number of columns'); continue; }
      const cell = (k) => (map[k] === undefined ? '' : rv.tidy(r[map[k]]));
      const company = cell('company'), role = cell('role');
      if (!company && !role) { reject('company and role are both empty'); continue; }
      if (company.length > TEXT_MAX || role.length > TEXT_MAX) { reject('company or role is longer than ' + TEXT_MAX + ' characters'); continue; }
      const notes = cell('notes'), resume = cell('resume'), nextStep = cell('nextStep');
      if (notes.length > NOTES_MAX) { reject('notes are longer than ' + NOTES_MAX + ' characters'); continue; }
      if (resume.length > RESUME_MAX) { reject('resume version is longer than ' + RESUME_MAX + ' characters'); continue; }
      if (nextStep.length > TEXT_MAX) { reject('next step is longer than ' + TEXT_MAX + ' characters'); continue; }
      if (L.admin && [company, role, notes, resume, nextStep, cell('source')].some((x) => L.admin.looksSecretText(x))) { reject('looks like an ID or card number'); continue; }
      let stage = dflt;
      if (map.stage !== undefined) {
        const s = resolve('stage', cell('stage'));
        if (s.unknown !== undefined) { if (!unknown.stage.has(key(s.unknown))) unknown.stage.set(key(s.unknown), s.unknown); reject('stage is not one of the stages; map the value below'); continue; } // SEC-110: no cell text in a reason
        if (s.v) stage = s.v;
      }
      const o = { id: '', kind: 'job', stage };
      const dates = {};
      let bad = false;
      for (const [k, label] of [['appliedOn', 'applied date'], ['followUp', 'follow-up date']]) {
        const raw = cell(k);
        if (!raw) continue;
        const d = rv.parseDate(raw, fmt);
        if (!d) { reject(label + ' is not a valid ' + (fmt === 'dmy' ? 'DD/MM/YYYY or YYYY-MM-DD' : 'YYYY-MM-DD or MM/DD/YYYY') + ' date'); bad = true; break; }
        dates[k] = d;
      }
      if (bad) continue;
      const comp = {};
      for (const [k, f] of [['targetOte', 'targetOteCents'], ['targetBase', 'targetBaseCents'], ['offerOte', 'offerOteCents'], ['offerBase', 'offerBaseCents']]) {
        const raw = cell(k);
        if (!raw) continue;
        const c = rv.parseCents(raw);
        if (c === null || c < 0 || c > 100000000000) { reject(k.replace(/([A-Z])/g, ' $1').toLowerCase() + ' is not an amount'); bad = true; break; }
        comp[f] = c;
      }
      if (bad) continue;
      const enums = {};
      for (const [col, f] of [['location', 'locationType'], ['source', 'source'], ['lostReason', 'lostReason']]) {
        if (map[col] === undefined || (col === 'lostReason' && stage !== 'lost')) continue;
        const x = resolve(col, cell(col));
        if (x.unknown !== undefined && !unknown[col].has(key(x.unknown))) unknown[col].set(key(x.unknown), x.unknown);
        if (x.v) enums[f] = x.v;
      }
      const base = [norm(company), norm(role), dates.appliedOn || ''].join('\u001f'), occ = seenInFile.get(base) || 0;
      seenInFile.set(base, occ + 1);
      const ik = await importKey(company, role, dates.appliedOn || '', occ);
      if (have.has(ik)) { duplicates++; continue; }
      Object.assign(o, { title: titleOf(role, company), org: company, source: enums.source || '', nextStep, notes, updatedAt: M().isDate(today) ? today : M().todayISO(), importKey: ik });
      if (role) o.role = role;
      if (resume) o.resume = resume;
      if (enums.locationType) o.locationType = enums.locationType;
      if (dates.appliedOn) o.appliedOn = dates.appliedOn;
      else if (['applied', 'interview', 'offer', 'won'].includes(stage)) o.appliedOn = o.updatedAt;
      if (dates.followUp) o.followUp = dates.followUp;
      if (stage === 'lost' && enums.lostReason) o.lostReason = enums.lostReason;
      Object.assign(o, comp);
      add.push(o);
      byStage[stage] = (byStage[stage] || 0) + 1;
    }
    const target = opts.asPrivate && L.priv && L.priv.isPrivateRecord ? list(state, 'pipeline').filter((x) => L.priv.isPrivateRecord(x)).length : list(state, 'pipeline').length;
    if (target + add.length > CAP) fail('This import would pass the ' + CAP + ' pipeline item limit.');
    return {
      rows: parsed.rows.length, add, rejected, duplicates, byStage, empty: add.length === 0, asPrivate: !!opts.asPrivate,
      unknown: { stage: [...unknown.stage.values()], location: [...unknown.location.values()], source: [...unknown.source.values()], lostReason: [...unknown.lostReason.values()] },
    };
  }
  function applyImport(state, pl) {
    if (!pl || !Array.isArray(pl.add)) fail('Nothing to import');
    if (pl.blocked) return { added: 0, ids: [] };
    const pm = state.priv && Array.isArray(state.priv.marks) ? state.priv.marks : [];
    if (pm.includes('pipeline')) fail('Open the private vault to import applications.');
    const ids = [], out = list(state, 'pipeline').slice();
    for (const x of pl.add) { const rec = Object.assign({}, x, { id: L.store.newId() }); out.push(rec); ids.push(rec.id); }
    state.pipeline = out;
    return { added: ids.length, ids };
  }
  function exportRows(items) { return items.filter(isJob); }

  // ---- at a glance: follow-ups in the next 30 days (an overdue one shows today) ----
  function registerGlance() {
    if (!L.activities || !L.activities.registerGlanceProvider) return;
    try {
      L.activities.registerGlanceProvider({
        id: 'job-followups', label: 'Job follow-ups',
        items: (state, today) => followUps(state, today).map((x) => ({ id: x.id, title: (x.overdue ? 'Follow up (overdue): ' : 'Follow up: ') + x.title, date: x.overdue ? today : x.date })),
      });
    } catch (e) { /* already registered */ }
  }
  registerGlance();

  L.jobs = {
    SOURCES, LOCATIONS, REASONS, STAGES, OPEN, COMP, CAP, TARGETS, isJob, jobsOf, isOpen, isApplied, responded, interviewed, offered, sourceOf, funnel, followUps, followUpsDueBy, peopleOf, weekly, digest, hasData, reviewWeek,
    fieldsIn, addJob, updateJob, setStage, stamp, markFollowedUp, logContact, planImport, applyImport, importKey, exportRows, titleOf,
  };
})();
