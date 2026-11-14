(function () {
  'use strict';
  // Social (schema 9): groups, people, a contact log, important dates and facts. Pure functions over state; every mutator runs
  // inside store.commit and changes only what the user tapped. Nothing here is automatic: snoozing, archiving, changing a
  // cadence and logging a contact are each a tap, and the review step only OFFERS them. Last contact is COMPUTED from the log and
  // from done, social-tagged activities whose withPeople names the person (case and whitespace insensitive); no duplicate contact
  // is ever stored. Dates are local YYYY-MM-DD strings handled as calendar days. Names, group names, date labels, fact labels and
  // text, channels and notes never leave the vault: the digest holds counts only and the by-group counts are keyed by position.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const V = () => L.validate;
  const H = () => L.home;
  const D = () => L.home.dates;

  const PEOPLE_CAP = 1000, GROUP_CAP = 30, CONTACT_CAP = 20000, DATES_MAX = 5, LINKS_MAX = 10, FACTS_MAX = 50;
  const NAME_MAX = 200, TYPED_NAME_MAX = 100, NOTE_MAX = 200, NOTE_STORED_MAX = 2000, LABEL_MAX = 100, FACT_LABEL_MAX = 40, FACT_TEXT_MAX = 200;
  const MAX_CADENCE = 3650, SOON_DAYS = 7, GLANCE_DAYS = 30, SNOOZE_DAYS = 7, WEEKS = 8;
  const CHANNELS = Object.freeze(['call', 'message', 'in person', 'video', 'email', 'other']);
  const DEFAULT_GROUPS = Object.freeze([{ name: 'Family', cadenceDays: 14 }, { name: 'Friends', cadenceDays: 30 }, { name: 'Professional', cadenceDays: 60 }]);
  const SECRET_MESSAGE = 'That looks like an ID number or a card number. Do not enter ID numbers, account numbers or passwords here.';
  const BIDI = /[​-‏‪-‮⁠-⁩﻿]/g;
  const MD = /^(\d{2})-(\d{2})$/;
  const DIM = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  const list = (state, k) => (state && Array.isArray(state[k]) ? state[k] : []);
  const given = (v) => v !== undefined && v !== null && v !== '';
  const T = (v, max, name, empty) => H().text(v, max, name, empty);
  const weekStart = (d) => L.metrics.weekStart(d);
  // Name key: Unicode compatibility-normalised (NFKC, so a composed and a decomposed accent, or full-width letters, are the same name;
  // audit v0.10.0), invisible characters removed, any run of whitespace is one space, case folded.
  const nameKey = (s) => String(s).normalize('NFKC').replace(BIDI, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const cleanName = (s) => String(s).replace(BIDI, '').replace(/\s+/g, ' ').trim();
  const checkText = (...fields) => { for (const f of fields) if (L.admin.looksSecret(f)) throw new Error(SECRET_MESSAGE); };

  // ---- validation (rebuilds every record from whitelists, with caps) ----
  function cleanGroups(list_) {
    if (list_ === undefined) return [];
    const seen = new Set();
    return V().arr(list_, GROUP_CAP, 'groups').map((x) => {
      const id = H().ident(x, seen, 'group');
      return { id, name: T(x.name, 100, 'group name'), cadenceDays: V().num(x.cadenceDays, 1, MAX_CADENCE, 'group cadence', true) };
    });
  }
  function link(v, ids, name) {
    if (typeof v === 'string' && v) return ids.has(v) ? v : undefined;
    if (given(v)) V().fail(name + ' must be text');
    return undefined;
  }
  function cleanLinks(v, ids, name) {
    if (v === undefined) return [];
    const seen = new Set(), out = [];
    for (const x of V().arr(v, LINKS_MAX, name)) {
      if (typeof x !== 'string') V().fail(name + ' must be text');
      if (ids.has(x) && !seen.has(x)) { seen.add(x); out.push(x); }
    }
    return out;
  }
  function cleanDates(v) {
    if (v === undefined) return [];
    return V().arr(v, DATES_MAX, 'important dates').map((x) => {
      if (!V().isObj(x)) V().fail('important date');
      const m = typeof x.monthDay === 'string' ? MD.exec(x.monthDay) : null;
      if (!m || +m[1] < 1 || +m[1] > 12 || +m[2] < 1 || +m[2] > DIM[+m[1] - 1]) V().fail('important date must be MM-DD');
      const o = { label: T(x.label, LABEL_MAX, 'date label'), monthDay: x.monthDay };
      if (given(x.year)) o.year = V().num(x.year, 1900, 2200, 'year', true);
      return o;
    });
  }
  function cleanFacts(v) {
    if (v === undefined) return [];
    const seen = new Set();
    return V().arr(v, FACTS_MAX, 'facts').map((x) => {
      const id = H().ident(x, seen, 'fact');
      return { id, label: T(x.label, FACT_LABEL_MAX, 'fact label'), text: T(x.text, FACT_TEXT_MAX, 'fact text'), addedOn: H().reqDate(x.addedOn, 'fact date') };
    });
  }
  // `pipeline` and `projects` are the already cleaned collections the links point at. A link to nothing is dropped; the person is kept.
  function cleanPeople(list_, groups, pipeline, projects) {
    if (list_ === undefined) return [];
    const seen = new Set(), gids = new Set((groups || []).map((g) => g.id)), pids = new Set((pipeline || []).map((p) => p.id)), jids = new Set((projects || []).map((p) => p.id));
    return V().arr(list_, PEOPLE_CAP, 'people').map((x) => {
      const id = H().ident(x, seen, 'person');
      const o = { id, name: T(x.name, NAME_MAX, 'person name') };
      const gid = link(x.groupId, gids, 'group link'); if (gid) o.groupId = gid;
      const cad = H().optInt(x.cadenceDays, 1, MAX_CADENCE, 'cadence'); if (cad !== undefined) o.cadenceDays = cad;
      o.importantDates = cleanDates(x.importantDates);
      o.pipelineIds = cleanLinks(x.pipelineIds, pids, 'pipeline links');
      o.projectIds = cleanLinks(x.projectIds, jids, 'project links');
      o.facts = cleanFacts(x.facts);
      o.notes = T(x.notes, NOTE_STORED_MAX, 'notes', true);
      const snz = H().optDate(x.snoozedUntil, 'snooze date'); if (snz) o.snoozedUntil = snz;
      o.archived = V().bool(x.archived, 'archived', false);
      if (x.createdAt !== undefined && x.createdAt !== null) o.createdAt = V().ts(x.createdAt, 'createdAt');
      return o;
    });
  }
  // A contact whose person is gone is kept, unlinked (it has no personId). Nothing is dropped.
  function cleanContacts(list_, people) {
    if (list_ === undefined) return [];
    const seen = new Set(), ids = new Set((people || []).map((p) => p.id));
    return V().arr(list_, CONTACT_CAP, 'contacts').map((x) => {
      const id = H().ident(x, seen, 'contact');
      const o = { id };
      const pid = link(x.personId, ids, 'person link'); if (pid) o.personId = pid;
      o.date = H().reqDate(x.date, 'contact date');
      o.channel = V().oneOf(x.channel, CHANNELS, 'channel');
      o.notes = T(x.notes, NOTE_STORED_MAX, 'notes', true);
      return o;
    });
  }

  // ---- legacy: social/contact entries from before schema 9 become people and a contact log ----
  // Each distinct name (case, spacing and invisible characters ignored) becomes one person, named as first typed. Every entry
  // keeps its id and date, and its title and notes are written into the contact's notes. An entry that cannot map (notes over 2,000
  // characters, a date outside the supported range, past a cap) stays an entry, visible and deletable under Social. Nothing is dropped.
  function legacy(entries, newId, caps) {
    const people = [], contacts = [], gone = new Set(), byKey = new Map();
    const pc = (caps && caps.people) || PEOPLE_CAP, cc = (caps && caps.contacts) || CONTACT_CAP;
    for (const e of entries) {
      if (e.domain !== 'social' || e.type !== 'contact' || typeof e.person !== 'string') continue;
      const key = nameKey(e.person), name = cleanName(e.person);
      if (!key || name.length > NAME_MAX) continue;
      let p = byKey.get(key);
      if (!p) {
        if (people.length >= pc) continue;
        p = { id: newId(), name, importantDates: [], pipelineIds: [], projectIds: [], facts: [], notes: '', archived: false };
        if (e.createdAt !== undefined) p.createdAt = e.createdAt;
        byKey.set(key, p); people.push(p);
      }
      const notes = e.title + (e.notes ? '. ' + e.notes : '');
      if (contacts.length >= cc || !D().isDate(e.date) || notes.length > NOTE_STORED_MAX) continue;
      contacts.push({ id: typeof e.id === 'string' && e.id && e.id.length <= 100 ? e.id : newId(), personId: p.id, date: e.date, channel: 'other', notes });
      gone.add(e);
    }
    return { people, contacts, entries: entries.filter((e) => !gone.has(e)) };
  }
  const legacyEntries = (state) => list(state, 'entries').filter((e) => e.domain === 'social').sort((a, b) => b.date.localeCompare(a.date) || String(a.title).localeCompare(String(b.title)));
  const hasPeople = (state) => list(state, 'people').length > 0;
  // New computed numbers drive the tile, digest and series once there are people; until then the older entry-based numbers.
  const current = hasPeople;
  // Offer (never automatic): turn social/contact entries that arrived after the migration (CSV import into Social) into people and
  // log. Merges into an existing person by name; a name shared by two people is ambiguous and its entries stay entries. Each entry
  // becomes exactly one contact (a fresh id if its id is already a contact's) and leaves the entry list in the same commit, so
  // re-running converts nothing twice; whatever cannot map stays a visible entry (audit v0.10.0). `dry` counts without changing.
  function convertEntries(state, dry) {
    const ents = list(state, 'entries');
    const people = dry ? list(state, 'people').slice() : list(state, 'people'), contacts = dry ? list(state, 'contacts').slice() : list(state, 'contacts');
    const byKey = new Map(), amb = new Set(), ids = new Set(contacts.map((c) => c.id));
    for (const p of people) { const k = nameKey(p.name); if (byKey.has(k)) amb.add(k); else byKey.set(k, p); }
    let moved = 0;
    const gone = new Set();
    for (const e of ents) {
      if (e.domain !== 'social' || e.type !== 'contact' || typeof e.person !== 'string') continue;
      const key = nameKey(e.person), name = cleanName(e.person);
      if (!key || amb.has(key) || name.length > NAME_MAX) continue;
      const notes = e.title + (e.notes ? '. ' + e.notes : '');
      if (contacts.length >= CONTACT_CAP || !D().isDate(e.date) || notes.length > NOTE_STORED_MAX) continue;
      let p = byKey.get(key);
      if (!p) {
        if (people.length >= PEOPLE_CAP) continue;
        p = { id: dry ? 'dry-' + people.length : L.store.newId(), name, importantDates: [], pipelineIds: [], projectIds: [], facts: [], notes: '', archived: false };
        if (e.createdAt !== undefined) p.createdAt = e.createdAt;
        byKey.set(key, p); people.push(p);
      }
      const id = typeof e.id === 'string' && e.id && e.id.length <= 100 && !ids.has(e.id) ? e.id : dry ? 'dry-c' + contacts.length : L.store.newId();
      ids.add(id);
      contacts.push({ id, personId: p.id, date: e.date, channel: 'other', notes });
      gone.add(e); moved++;
    }
    if (dry) return moved;
    state.people = people; state.contacts = contacts;
    state.entries = ents.filter((e) => !gone.has(e));
    return moved;
  }
  // How many entries the offer would convert now; the offer is shown only when this is above zero.
  const convertible = (state) => convertEntries(state, true);

  // ---- last contact, cadence, overdue ----
  const peopleOf = (state) => list(state, 'people');
  const groupOf = (state, p) => (p.groupId ? list(state, 'groups').find((g) => g.id === p.groupId) || null : null);
  const cadenceOf = (state, p) => {
    if (typeof p.cadenceDays === 'number') return p.cadenceDays;
    const g = groupOf(state, p);
    if (g) return g.cadenceDays;
    return ((state.settings || {}).targets || {}).contactDays || 30;
  };
  // 'own' | 'group' | 'default': where the effective cadence comes from.
  const cadenceSource = (state, p) => (typeof p.cadenceDays === 'number' ? 'own' : groupOf(state, p) ? 'group' : 'default');
  // Name key to person id. A key shared by two or more people (possible only in a crafted or older copy, since adding a person
  // refuses a name already in the list) is ambiguous and maps to nobody: a contact is never attributed by guessing (audit v0.10.0).
  function nameIndex(state) {
    const m = new Map(), dup = new Set();
    for (const p of peopleOf(state)) { const k = nameKey(p.name); if (m.has(k)) dup.add(k); else m.set(k, p.id); }
    for (const k of dup) m.delete(k);
    return m;
  }
  const ambiguousNames = (state) => { const seen = new Set(), dup = new Set(); for (const p of peopleOf(state)) { const k = nameKey(p.name); if (seen.has(k)) dup.add(k); seen.add(k); } return dup.size; };
  // Last contact on or before asOf per person id: {date, source:'log'|'activity'}. Computed; nothing is stored.
  function lastContacts(state, asOf) {
    const last = new Map();
    const put = (id, date, source) => { const c = last.get(id); if (!c || date > c.date) last.set(id, { date, source }); };
    for (const c of list(state, 'contacts')) if (c.personId && c.date <= asOf) put(c.personId, c.date, 'log');
    const idx = nameIndex(state);
    for (const a of list(state, 'activities')) {
      if (a.state !== 'done' || !a.alsoSocial || a.date > asOf) continue;
      const end = a.endDate || a.date, d = end < asOf ? end : asOf;
      for (const n of a.withPeople || []) { const id = idx.get(nameKey(n)); if (id) put(id, d, 'activity'); }
    }
    return last;
  }
  // Contact events per person id (distinct dates): logged contacts, and done social-tagged activities on their start date.
  // The same person on the same day counts once, so a manual entry beside an activity never counts twice.
  function eventDates(state) {
    const ev = new Map();
    const put = (id, d) => { let s = ev.get(id); if (!s) { s = new Set(); ev.set(id, s); } s.add(d); };
    for (const c of list(state, 'contacts')) if (c.personId) put(c.personId, c.date);
    const idx = nameIndex(state);
    for (const a of list(state, 'activities')) {
      if (a.state !== 'done' || !a.alsoSocial) continue;
      for (const n of a.withPeople || []) { const id = idx.get(nameKey(n)); if (id) put(id, a.date); }
    }
    return ev;
  }
  function countIn(set, a, b) { let n = 0; if (set) for (const d of set) if (d >= a && d <= b) n++; return n; }
  const snoozed = (p, asOf) => !!p.snoozedUntil && asOf < p.snoozedUntil;
  // Status of one person as of a day. state: 'archived' | 'snoozed' | 'overdue' | 'soon' | 'ok'; never = no contact yet (counts as overdue).
  function statusOf(state, p, asOf, last, opts) {
    const cad = cadenceOf(state, p), lc = last ? last.get(p.id) : null;
    const o = { id: p.id, name: p.name, cadence: cad, last: lc ? lc.date : null, source: lc ? lc.source : null, never: !lc, daysSince: null, overdueDays: null, dueDate: null, state: 'ok' };
    if (lc) { o.daysSince = D().daysBetween(asOf, lc.date); o.dueDate = D().addDays(lc.date, cad); o.overdueDays = o.daysSince - cad; }
    if (p.archived) o.state = 'archived';
    else if (!(opts && opts.ignoreSnooze) && snoozed(p, asOf)) o.state = 'snoozed';
    else if (!lc || o.daysSince > cad) o.state = 'overdue';
    else if (D().daysBetween(o.dueDate, asOf) <= SOON_DAYS) o.state = 'soon';
    return o;
  }
  // Everyone not archived with a status, most overdue first (never contacted first, then by name).
  function roster(state, asOf, opts) {
    if (!D().isDate(asOf)) throw new Error('Date must be YYYY-MM-DD');
    const last = lastContacts(state, asOf);
    return peopleOf(state).filter((p) => !p.archived).map((p) => statusOf(state, p, asOf, last, opts)).sort(byUrgency);
  }
  function byUrgency(a, b) {
    const ra = a.never ? Infinity : a.overdueDays, rb = b.never ? Infinity : b.overdueDays;
    if (ra !== rb) return ra > rb ? -1 : 1;
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  }
  const overdueList = (state, asOf) => roster(state, asOf).filter((r) => r.state === 'overdue');
  // Due within 7 days (today included), not overdue, soonest first.
  const dueSoonList = (state, asOf) => roster(state, asOf).filter((r) => r.state === 'soon').sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
  function contactsBetween(state, a, b) {
    let n = 0;
    const live = new Set(peopleOf(state).filter((p) => !p.archived).map((p) => p.id));
    for (const [id, set] of eventDates(state)) if (live.has(id)) n += countIn(set, a, b);
    return n;
  }
  const contactsThisWeek = (state, asOf) => contactsBetween(state, weekStart(asOf), asOf);
  function summary(state, asOf) {
    const r = roster(state, asOf);
    return { people: r.length, overdue: r.filter((x) => x.state === 'overdue').length, dueSoon: r.filter((x) => x.state === 'soon').length, contactsWeek: contactsThisWeek(state, asOf) };
  }
  // By group (positions follow the groups list, ungrouped last): people, overdue and contacts per week for 8 weeks (oldest first).
  function byGroup(state, asOf) {
    const r = roster(state, asOf), ev = eventDates(state), ws = weekStart(asOf);
    const gs = list(state, 'groups'), byId = new Map(r.map((x) => [x.id, x]));
    const mk = (g) => ({ groupId: g ? g.id : null, name: g ? g.name : 'No group', cadenceDays: g ? g.cadenceDays : null, people: 0, overdue: 0, weekly: new Array(WEEKS).fill(0) });
    const rows = gs.map(mk), none = mk(null), index = new Map(gs.map((g, i) => [g.id, rows[i]]));
    for (const p of peopleOf(state)) {
      if (p.archived) continue;
      const row = (p.groupId && index.get(p.groupId)) || none, st = byId.get(p.id);
      row.people++; if (st && st.state === 'overdue') row.overdue++;
      for (let i = 0; i < WEEKS; i++) { const a = D().addDays(ws, -7 * (WEEKS - 1 - i)); row.weekly[i] += countIn(ev.get(p.id), a, i === WEEKS - 1 ? asOf : D().addDays(a, 6)); }
    }
    return rows.concat(none.people ? [none] : []);
  }
  function headline(state, today, R) {
    const s = summary(state, today);
    return R('People overdue', String(s.overdue), s.overdue, s.dueSoon + ' due in 7 days, ' + s.contactsWeek + (s.contactsWeek === 1 ? ' contact' : ' contacts') + ' this week');
  }
  const weekValue = (state, we) => summary(state, we).overdue;
  // Numbers only: never a name, group name, label, fact or note. byGroup follows the groups list by position.
  function digest(state, ws) {
    const we = D().addDays(ws, 6), s = summary(state, we);
    const groups = list(state, 'groups'), r = roster(state, we), per = groups.map(() => ({ people: 0, overdue: 0 }));
    const pos = new Map(groups.map((g, i) => [g.id, i])), byId = new Map(peopleOf(state).map((p) => [p.id, p]));
    for (const x of r) { const p = byId.get(x.id), i = p && p.groupId ? pos.get(p.groupId) : undefined; if (i !== undefined) { per[i].people++; if (x.state === 'overdue') per[i].overdue++; } }
    return { people: s.people, overdue: s.overdue, dueSoon: s.dueSoon, contactsWeek: contactsBetween(state, ws, we), byGroup: per };
  }
  // Weekly review step: who became overdue this week, who is due next week, contacts made. Offers only.
  function reviewWeek(state, wk, today) {
    const ws = weekStart(wk), we = D().addDays(ws, 6), now = today && today < we ? today : we;
    const before = D().addDays(ws, -1), prev = new Map(roster(state, before, { ignoreSnooze: true }).map((x) => [x.id, x]));
    const cur = roster(state, now);
    const became = cur.filter((x) => x.state === 'overdue' && !x.never && prev.has(x.id) && prev.get(x.id).state !== 'overdue');
    const dueNext = cur.filter((x) => (x.state === 'soon' || x.state === 'ok') && x.dueDate && x.dueDate <= D().addDays(we, 7)).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
    return { asOf: now, became, dueNext, contactsMade: contactsBetween(state, ws, now), overdue: cur.filter((x) => x.state === 'overdue').length };
  }
  // Goal metrics: null is "no data yet".
  function goalOverdue(state, asOf) { return hasPeople(state) ? summary(state, asOf).overdue : null; }
  function goalContacts(state, asOf) {
    if (!hasPeople(state)) return null;
    if (!list(state, 'contacts').length && !Array.from(eventDates(state).values()).some((s) => s.size)) return null;
    return contactsThisWeek(state, asOf);
  }

  // ---- important dates in the at-a-glance provider ----
  // Next occurrence of MM-DD on or after `from`; Feb 29 falls on Feb 28 in a non-leap year.
  function occurrence(monthDay, from) {
    const y = +from.slice(0, 4), m = +monthDay.slice(0, 2), d = +monthDay.slice(3, 5);
    const at = (yy) => { const leap = (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0; const dd = m === 2 && d === 29 && !leap ? 28 : d; return String(yy).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(dd).padStart(2, '0'); };
    const a = at(y);
    return a >= from ? a : at(y + 1);
  }
  function importantDates(state, today, days) {
    const out = [], end = D().addDays(today, (days || GLANCE_DAYS) - 1);
    for (const p of peopleOf(state)) {
      if (p.archived) continue;
      p.importantDates.forEach((x, i) => {
        const date = occurrence(x.monthDay, today);
        if (date > end || !D().isDate(date)) return;
        const n = typeof x.year === 'number' ? +date.slice(0, 4) - x.year : null;
        out.push({ id: p.id + ':' + i + ':' + date, personId: p.id, person: p.name, label: x.label, date, years: n !== null && n > 0 ? n : null });
      });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.person.localeCompare(b.person) || a.label.localeCompare(b.label));
  }
  function registerProvider() {
    if (!L.activities || !L.activities.registerGlanceProvider) return;
    try {
      L.activities.registerGlanceProvider({
        id: 'important-dates', label: 'Important dates',
        // Only the label and the person's name are shown (addendum); the years count stays in the person detail (audit v0.10.0).
        items: (state, today) => importantDates(state, today).map((x) => ({ id: x.id, title: (x.label + ': ' + x.person).slice(0, 200), date: x.date })),
      });
    } catch (e) { /* already registered */ }
  }
  registerProvider();

  // ---- search: plain substring over people and their facts (no RegExp is ever built from typed text) ----
  function search(state, q) {
    const needle = nameKey(typeof q === 'string' ? q : '');
    if (!needle) return [];
    const out = [];
    for (const p of peopleOf(state)) {
      const hits = [];
      if (nameKey(p.name).indexOf(needle) >= 0) hits.push({ kind: 'name' });
      if (nameKey(p.notes).indexOf(needle) >= 0) hits.push({ kind: 'notes' });
      for (const d of p.importantDates) if (nameKey(d.label).indexOf(needle) >= 0) hits.push({ kind: 'date', label: d.label });
      for (const f of p.facts) if (nameKey(f.label).indexOf(needle) >= 0 || nameKey(f.text).indexOf(needle) >= 0) hits.push({ kind: 'fact', id: f.id });
      if (hits.length) out.push({ personId: p.id, name: p.name, hits });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.personId.localeCompare(b.personId)).slice(0, 200);
  }

  // ---- mutators (run inside store.commit; nothing here is called automatically) ----
  const find = (state, id) => { const p = peopleOf(state).find((x) => x.id === id); if (!p) throw new Error('Person not found'); return p; };
  const findGroup = (state, id) => { const g = list(state, 'groups').find((x) => x.id === id); if (!g) throw new Error('Group not found'); return g; };
  const dateOf = (v, name) => { if (!D().isDate(v)) throw new Error(name + ' must be a valid date'); return v; };
  function cadenceIn(v, name) {
    const s = String(v).trim();
    if (!/^\d{1,4}$/.test(s) || +s < 1 || +s > MAX_CADENCE) throw new Error(name + ' must be a whole number of days from 1 to ' + MAX_CADENCE);
    return +s;
  }
  function typedName(v, max, what) {
    const n = typeof v === 'string' ? cleanName(v) : '';
    if (!n) throw new Error('Enter ' + what + '.');
    if (n.length > max) throw new Error('That is too long. Use up to ' + max + ' characters.');
    return n;
  }
  function typedNote(v) {
    const n = typeof v === 'string' ? v : '';
    // A typed note is a short line (SEC-49 pattern). validateState still accepts 2,000 so notes carried over from older entries keep their text.
    if (n.trim().length > NOTE_MAX) throw new Error('A note can be up to ' + NOTE_MAX + ' characters');
    checkText(n);
    return n.trim();
  }
  function addGroup(state, name, cadence) {
    const n = typedName(name, 100, 'a group name');
    if (list(state, 'groups').length >= GROUP_CAP) throw new Error('You can keep up to ' + GROUP_CAP + ' groups.');
    if (list(state, 'groups').some((g) => nameKey(g.name) === nameKey(n))) throw new Error('That group already exists.');
    const g = { id: L.store.newId(), name: n, cadenceDays: cadenceIn(cadence, 'The group cadence') };
    state.groups = list(state, 'groups').concat([g]);
    return g;
  }
  // Defaults are offered once as suggestions; only the names the user picks are added, each on a tap.
  const suggestions = (state) => DEFAULT_GROUPS.filter((d) => !list(state, 'groups').some((g) => nameKey(g.name) === nameKey(d.name)));
  function addSuggestedGroups(state, names) {
    const picks = Array.isArray(names) ? names : [];
    const out = [];
    for (const n of picks) {
      const d = DEFAULT_GROUPS.find((x) => x.name === n);
      if (!d) throw new Error('Unknown suggestion');
      out.push(addGroup(state, d.name, d.cadenceDays));
    }
    return out;
  }
  function updateGroup(state, id, patch) {
    const g = findGroup(state, id);
    if (!V().isObj(patch)) throw new Error('Nothing to change');
    if ('name' in patch) {
      const n = typedName(patch.name, 100, 'a group name');
      if (list(state, 'groups').some((x) => x.id !== id && nameKey(x.name) === nameKey(n))) throw new Error('That group already exists.');
      g.name = n;
    }
    if ('cadenceDays' in patch) g.cadenceDays = cadenceIn(patch.cadenceDays, 'The group cadence');
    return g;
  }
  // People in a deleted group keep everything and become ungrouped.
  function deleteGroup(state, id) {
    findGroup(state, id);
    let n = 0;
    for (const p of peopleOf(state)) if (p.groupId === id) { delete p.groupId; n++; }
    state.groups = state.groups.filter((g) => g.id !== id);
    return n;
  }
  function datesIn(v) {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error('Important dates must be a list');
    if (v.length > DATES_MAX) throw new Error('You can keep up to ' + DATES_MAX + ' important dates per person.');
    return v.map(dateIn);
  }
  function dateIn(x) {
    if (!V().isObj(x)) throw new Error('Important date must be an object');
    const label = typedName(x.label, LABEL_MAX, 'a label');
    checkText(label);
    const md = typeof x.monthDay === 'string' ? MD.exec(x.monthDay.trim()) : null;
    if (!md || +md[1] < 1 || +md[1] > 12 || +md[2] < 1 || +md[2] > DIM[+md[1] - 1]) throw new Error('Enter the date as month and day.');
    const o = { label, monthDay: md[0] };
    if (given(x.year)) { const y = H().toInt(x.year, 1900, 2200, 'Year'); if (y !== undefined) o.year = y; }
    return o;
  }
  function addPerson(state, input) {
    if (!V().isObj(input)) throw new Error('Person must be an object');
    if (peopleOf(state).length >= PEOPLE_CAP) throw new Error('You can keep up to ' + PEOPLE_CAP + ' people.');
    const name = typedName(input.name, TYPED_NAME_MAX, 'a name');
    if (peopleOf(state).some((p) => nameKey(p.name) === nameKey(name))) throw new Error('That person is already in your list.');
    const p = { id: L.store.newId(), name, importantDates: [], pipelineIds: [], projectIds: [], facts: [], notes: '', archived: false, createdAt: new Date().toISOString() };
    if (given(input.groupId)) { findGroup(state, input.groupId); p.groupId = input.groupId; }
    if (given(input.cadenceDays)) p.cadenceDays = cadenceIn(input.cadenceDays, 'The cadence');
    if ('importantDates' in input) p.importantDates = datesIn(input.importantDates);
    if ('notes' in input) p.notes = typedNote(input.notes);
    state.people = peopleOf(state).concat([p]);
    return p;
  }
  const EDITABLE = ['name', 'groupId', 'cadenceDays', 'notes'];
  function updatePerson(state, id, patch) {
    const p = find(state, id);
    if (!V().isObj(patch)) throw new Error('Nothing to change');
    for (const k of Object.keys(patch)) if (!EDITABLE.includes(k)) throw new Error('That field cannot be changed');
    if ('name' in patch) {
      const n = typedName(patch.name, TYPED_NAME_MAX, 'a name');
      if (peopleOf(state).some((x) => x.id !== id && nameKey(x.name) === nameKey(n))) throw new Error('That person is already in your list.');
      p.name = n;
    }
    if ('groupId' in patch) { if (given(patch.groupId)) { findGroup(state, patch.groupId); p.groupId = patch.groupId; } else delete p.groupId; }
    if ('cadenceDays' in patch) { if (given(patch.cadenceDays)) p.cadenceDays = cadenceIn(patch.cadenceDays, 'The cadence'); else delete p.cadenceDays; }
    if ('notes' in patch) p.notes = typedNote(patch.notes);
    return p;
  }
  // The person's own cadence, or null to follow the group (or the default).
  const setCadence = (state, id, days) => updatePerson(state, id, { cadenceDays: days === null ? '' : days });
  function archivePerson(state, id, on) { const p = find(state, id); p.archived = on !== false; if (p.archived) delete p.snoozedUntil; return p; }
  // Snooze hides the person from overdue and due soon for 7 days from `today`; a tap, never automatic.
  function snooze(state, id, today) {
    const p = find(state, id);
    p.snoozedUntil = D().addDays(dateOf(today, 'Date'), SNOOZE_DAYS);
    return p;
  }
  function unsnooze(state, id) { const p = find(state, id); delete p.snoozedUntil; return p; }
  function logContact(state, personId, input, today) {
    find(state, personId);
    const i = V().isObj(input) ? input : {};
    if (list(state, 'contacts').length >= CONTACT_CAP) throw new Error('You can keep up to ' + CONTACT_CAP + ' logged contacts.');
    const date = given(i.date) ? dateOf(i.date, 'Date') : D().isDate(today) ? today : L.metrics.todayISO();
    const channel = given(i.channel) ? i.channel : 'other';
    if (!CHANNELS.includes(channel)) throw new Error('Pick a channel from the list');
    const c = { id: L.store.newId(), personId, date, channel, notes: given(i.notes) ? typedNote(i.notes) : '' };
    state.contacts = list(state, 'contacts').concat([c]);
    return c;
  }
  const reachedOutToday = (state, personId, today) => logContact(state, personId, { date: today }, today);
  function deleteContact(state, id) {
    if (!list(state, 'contacts').some((c) => c.id === id)) throw new Error('Contact not found');
    state.contacts = state.contacts.filter((c) => c.id !== id);
  }
  const contactsOf = (state, id) => list(state, 'contacts').filter((c) => c.personId === id).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const unlinkedContacts = (state) => list(state, 'contacts').filter((c) => !c.personId).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  // The log is kept and unlinked unless deleteLog is true (default is keep). Returns the number of log entries affected.
  function deletePerson(state, id, opts) {
    find(state, id);
    const mine = list(state, 'contacts').filter((c) => c.personId === id), del = !!(opts && opts.deleteLog === true);
    if (del) state.contacts = state.contacts.filter((c) => c.personId !== id);
    else for (const c of mine) delete c.personId;
    state.people = state.people.filter((p) => p.id !== id);
    return { count: mine.length, deletedLog: del };
  }
  function addDate(state, id, input) {
    const p = find(state, id);
    if (p.importantDates.length >= DATES_MAX) throw new Error('You can keep up to ' + DATES_MAX + ' important dates per person.');
    p.importantDates.push(dateIn(input));
    return p;
  }
  function removeDate(state, id, index) {
    const p = find(state, id);
    if (!Number.isInteger(index) || index < 0 || index >= p.importantDates.length) throw new Error('Date not found');
    p.importantDates.splice(index, 1);
  }
  // ---- facts: one at a time, newest first, 50 per person ----
  function addFact(state, id, input, today) {
    const p = find(state, id);
    if (!V().isObj(input)) throw new Error('Fact must be an object');
    if (p.facts.length >= FACTS_MAX) throw new Error('You can keep up to ' + FACTS_MAX + ' facts per person.');
    const label = typedName(input.label, FACT_LABEL_MAX, 'a label'), text = typedName(input.text, FACT_TEXT_MAX, 'the fact');
    checkText(label, text);
    const f = { id: L.store.newId(), label, text, addedOn: D().isDate(today) ? today : L.metrics.todayISO() };
    p.facts.push(f);
    return f;
  }
  function removeFact(state, id, factId) {
    const p = find(state, id);
    if (!p.facts.some((f) => f.id === factId)) throw new Error('Fact not found');
    p.facts = p.facts.filter((f) => f.id !== factId);
  }
  const factsOf = (p) => (p.facts || []).slice().reverse().sort((a, b) => b.addedOn.localeCompare(a.addedOn));
  // ---- links to Work: unlink never deletes either side ----
  function linkTo(state, id, key, coll, targetId, what) {
    const p = find(state, id);
    if (!list(state, coll).some((x) => x.id === targetId)) throw new Error(what + ' not found');
    if (p[key].includes(targetId)) return p;
    if (p[key].length >= LINKS_MAX) throw new Error('A person can link to up to ' + LINKS_MAX + ' ' + what.toLowerCase() + ' items.');
    p[key].push(targetId);
    return p;
  }
  function unlinkFrom(state, id, key, targetId) { const p = find(state, id); p[key] = p[key].filter((x) => x !== targetId); return p; }
  const linkPipeline = (state, id, pipelineId) => linkTo(state, id, 'pipelineIds', 'pipeline', pipelineId, 'Pipeline item');
  const unlinkPipeline = (state, id, pipelineId) => unlinkFrom(state, id, 'pipelineIds', pipelineId);
  const linkProject = (state, id, projectId) => linkTo(state, id, 'projectIds', 'projects', projectId, 'Project');
  const unlinkProject = (state, id, projectId) => unlinkFrom(state, id, 'projectIds', projectId);
  // Both directions, for the Work cards: people linked to a pipeline item or project, with their last contact date.
  function linkedPeople(state, key, targetId, asOf) {
    const last = lastContacts(state, D().isDate(asOf) ? asOf : L.metrics.todayISO());
    return peopleOf(state).filter((p) => p[key].includes(targetId)).map((p) => ({ id: p.id, name: p.name, last: last.has(p.id) ? last.get(p.id).date : null })).sort((a, b) => a.name.localeCompare(b.name));
  }
  const peopleForPipeline = (state, pid, asOf) => linkedPeople(state, 'pipelineIds', pid, asOf);
  const peopleForProject = (state, pid, asOf) => linkedPeople(state, 'projectIds', pid, asOf);
  // Names offered as suggestions for an activity's withPeople, and the unknown names that could be added (an offer, never automatic).
  const suggestNames = (state, q) => { const k = nameKey(q || ''); return peopleOf(state).filter((p) => !p.archived && (!k || nameKey(p.name).indexOf(k) >= 0)).map((p) => p.name).sort((a, b) => a.localeCompare(b)).slice(0, 20); };
  function unknownNames(state, names) {
    const known = new Set(peopleOf(state).map((p) => nameKey(p.name))), seen = new Set(), out = [];
    for (const n of names || []) { const k = nameKey(n), c = cleanName(n); if (k && !known.has(k) && !seen.has(k) && c.length <= TYPED_NAME_MAX) { seen.add(k); out.push(c); } }
    return out;
  }

  L.social = {
    PEOPLE_CAP, GROUP_CAP, CONTACT_CAP, DATES_MAX, LINKS_MAX, FACTS_MAX, NOTE_MAX, FACT_LABEL_MAX, FACT_TEXT_MAX, SOON_DAYS, SNOOZE_DAYS, WEEKS, CHANNELS, DEFAULT_GROUPS, SECRET_MESSAGE,
    nameKey, ambiguousNames, convertible, cleanGroups, cleanPeople, cleanContacts, cleanDates, cleanFacts, legacy, legacyEntries, hasPeople, current, convertEntries,
    cadenceOf, cadenceSource, lastContacts, roster, overdueList, dueSoonList, contactsBetween, contactsThisWeek, summary, byGroup, headline, weekValue, digest, reviewWeek, goalOverdue, goalContacts,
    occurrence, importantDates, search, suggestions,
    addGroup, addSuggestedGroups, updateGroup, deleteGroup, addPerson, updatePerson, setCadence, archivePerson, snooze, unsnooze, logContact, reachedOutToday, deleteContact, contactsOf, unlinkedContacts, deletePerson,
    addDate, removeDate, addFact, removeFact, factsOf, linkPipeline, unlinkPipeline, linkProject, unlinkProject, peopleForPipeline, peopleForProject, suggestNames, unknownNames,
  };
})();
