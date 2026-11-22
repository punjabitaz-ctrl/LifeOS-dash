(function () {
  'use strict';
  // v1.7.0 B15: the AYiN Advisors and clients tab. A rollup of the business lines of work (the existing revenue lines) and a client
  // record that links to Social people (contacts), a line of work, existing business invoices and an optional budget in integer cents.
  // Nothing is re-entered: revenue, invoices, budgets and contacts are read from the records that already exist.
  // Client names, people, notes and per-client money stay in the vault: only counts leave it (the digest, the at-a-glance generic labels
  // and the weekly review carry numbers only). Every figure that cannot be known is null ("no data"), never 0 and never NaN.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const STATUSES = Object.freeze(['active', 'paused', 'past']);
  const CAP = 500, NAME_MAX = 200, NOTES_MAX = 2000, PEOPLE_MAX = 50, MAX_CENTS = 100000000000;
  const DEFAULT_CONTACT_DAYS = 30, MAX_CONTACT_DAYS = 3650, MIN_DATE = '1900-01-01';
  const BIDI = /[؜​-‏‪-‮⁠-⁩﻿]/g;
  const V = () => L.validate, M = () => L.metrics;
  const list = (state, k) => (state && Array.isArray(state[k]) ? state[k] : []);
  const given = (v) => v !== undefined && v !== null && v !== '';
  const fail = (m) => { throw new Error(m); };
  const clean1 = (s) => String(s == null ? '' : s).replace(BIDI, '').replace(/\s+/g, ' ').trim();

  // ---- settings (schema 19): how many days without contact before an active client is flagged ----
  function cleanSettings(x) {
    if (x === undefined || x === null) return { contactDays: DEFAULT_CONTACT_DAYS };
    if (!V().isObj(x)) V().fail('clients settings');
    return { contactDays: x.contactDays === undefined ? DEFAULT_CONTACT_DAYS : V().num(x.contactDays, 1, MAX_CONTACT_DAYS, 'contact days', true) };
  }
  const contactDaysOf = (state) => { const c = state && state.settings && state.settings.clients; return c && Number.isInteger(c.contactDays) ? c.contactDays : DEFAULT_CONTACT_DAYS; };
  function setContactDays(state, days) {
    const n = Number(String(days).trim());
    if (!/^\d{1,4}$/.test(String(days).trim()) || n < 1 || n > MAX_CONTACT_DAYS) fail('Days without contact must be a whole number from 1 to ' + MAX_CONTACT_DAYS + '.');
    state.settings.clients = { contactDays: n };
    return n;
  }

  // ---- validation (rebuilds every record from whitelists, with caps; dangling links are dropped, nothing else is) ----
  // ctx: { projects, people } cleaned lists to check links against.
  function cleanClients(l, ctx) {
    if (l === undefined || l === null) return [];
    const seen = new Set(), pids = new Set(((ctx && ctx.projects) || []).map((p) => p.id)), ppl = new Set(((ctx && ctx.people) || []).map((p) => p.id));
    return V().arr(l, CAP, 'clients').map((x) => {
      if (!V().isObj(x)) V().fail('client');
      const id = V().str(x.id, 100, 'client id');
      if (seen.has(id)) V().fail('duplicate client id');
      seen.add(id);
      const o = { id, name: V().str(V().strip(V().str(x.name, NAME_MAX, 'client name', true)).trim(), NAME_MAX, 'client name'), status: V().oneOf(x.status === undefined ? 'active' : x.status, STATUSES, 'client status') };
      if (given(x.projectId)) { const p = V().str(x.projectId, 100, 'client line of work'); if (pids.has(p)) o.projectId = p; }
      if (x.budgetCents !== undefined && x.budgetCents !== null) o.budgetCents = V().num(x.budgetCents, 0, MAX_CENTS, 'client budget', true);
      const pl = x.personIds === undefined ? [] : V().arr(x.personIds, PEOPLE_MAX, 'client people');
      o.personIds = [...new Set(pl.map((p) => V().str(p, 100, 'client person')))].filter((p) => ppl.has(p));
      o.notes = V().str(V().strip(V().str(x.notes === undefined ? '' : x.notes, NOTES_MAX, 'client notes', true)), NOTES_MAX, 'client notes', true);
      if (given(x.createdOn)) o.createdOn = V().date(x.createdOn, 'client created date');
      return o;
    });
  }

  // ---- add and edit ----
  function text(v, max, name, req) {
    const s = clean1(v);
    if (req && !s) fail('Enter the ' + name + '.');
    if (s.length > max) fail('The ' + name + ' can be up to ' + max + ' characters.');
    if (L.admin && L.admin.looksSecret(s)) fail('That looks like an ID number or a card number. Do not enter ID numbers, account numbers or passwords here.');
    return s;
  }
  function notesText(v) {
    const s = String(v == null ? '' : v).replace(BIDI, '').trim();
    if (s.length > NOTES_MAX) fail('The notes can be up to ' + NOTES_MAX + ' characters.');
    if (L.admin && L.admin.looksSecret(s)) fail('That looks like an ID number or a card number. Do not enter ID numbers, account numbers or passwords here.');
    return s;
  }
  function centsIn(v) {
    const c = L.revenue.parseCents(String(v));
    if (c === null || c < 0 || c > MAX_CENTS) fail('The budget must be an amount from 0 to 1,000,000,000.');
    return c;
  }
  // input: { name, status, projectId, notes, budget (dollars as typed; empty clears) }
  function fieldsIn(state, input) {
    if (!V().isObj(input)) fail('Client must be an object');
    const o = { name: text(input.name, NAME_MAX, 'client name', true), notes: notesText(input.notes) };
    const status = given(input.status) ? input.status : 'active';
    if (!STATUSES.includes(status)) fail('Pick a status from the list.');
    o.status = status;
    if (given(input.projectId)) { if (!list(state, 'projects').some((p) => p.id === input.projectId)) fail('Pick a line of work from the list.'); o.projectId = input.projectId; }
    if (given(input.budget)) o.budgetCents = centsIn(input.budget);
    return o;
  }
  function addClient(state, input, today) {
    if (list(state, 'clients').length >= CAP) fail('You can keep up to ' + CAP + ' clients.');
    const f = fieldsIn(state, input), c = { id: L.store.newId(), name: f.name, status: f.status, personIds: [], notes: f.notes };
    if (f.projectId) c.projectId = f.projectId;
    if (f.budgetCents !== undefined) c.budgetCents = f.budgetCents;
    if (M().isDate(today)) c.createdOn = today;
    state.clients = list(state, 'clients').concat([c]);
    return c;
  }
  const find = (state, id) => { const c = list(state, 'clients').find((x) => x.id === id); if (!c) fail('Client not found'); return c; };
  function updateClient(state, id, input) {
    const c = find(state, id), f = fieldsIn(state, input);
    c.name = f.name; c.status = f.status; c.notes = f.notes;
    if (f.projectId) c.projectId = f.projectId; else delete c.projectId;
    if (f.budgetCents !== undefined) c.budgetCents = f.budgetCents; else delete c.budgetCents;
    return c;
  }
  // Deleting a client unlinks its invoices; no invoice, person or line of work is deleted.
  function deleteClient(state, id) {
    find(state, id);
    state.clients = state.clients.filter((c) => c.id !== id);
    for (const i of list(state, 'invoices')) if (i.clientId === id) delete i.clientId;
  }
  function linkPerson(state, id, personId) {
    const c = find(state, id);
    if (!list(state, 'people').some((p) => p.id === personId)) fail('Person not found');
    if (c.personIds.includes(personId)) return c;
    if (c.personIds.length >= PEOPLE_MAX) fail('A client can link up to ' + PEOPLE_MAX + ' people.');
    c.personIds = c.personIds.concat([personId]);
    return c;
  }
  function unlinkPerson(state, id, personId) { const c = find(state, id); c.personIds = c.personIds.filter((p) => p !== personId); return c; }
  // An invoice belongs to at most one client; '' clears it.
  function setInvoiceClient(state, invoiceId, clientId) {
    const inv = list(state, 'invoices').find((i) => i.id === invoiceId);
    if (!inv) fail('Invoice not found');
    if (given(clientId)) { find(state, clientId); inv.clientId = clientId; } else delete inv.clientId;
    return inv;
  }
  // One-tap contact log for a person linked to this client (the person is chosen by id, never by typed name).
  function logContact(state, id, personId, today, channel) {
    const c = find(state, id);
    if (!c.personIds.includes(personId)) fail('That person is not linked to this client.');
    return L.social.logContact(state, personId, { date: M().isDate(today) ? today : M().todayISO(), channel: given(channel) ? channel : 'other' }, today);
  }

  // ---- numbers ----
  const days = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5);
  const invTotal = (i) => L.business.invoiceTotal(i);
  function lastContact(state, c) {
    const ids = new Set(c.personIds || []);
    let best = null;
    for (const k of list(state, 'contacts')) if (k.personId && ids.has(k.personId) && (best === null || k.date > best)) best = k.date;
    return best;
  }
  // One client: revenue to date (the line of work's counted income; with no line, paid invoices linked to the client), open and overdue
  // invoices, budget vs actual (actual = counted expenses on the line of work; null with no line or no budget) and last contact.
  function clientStats(state, c, today) {
    const inv = list(state, 'invoices').filter((i) => i.clientId === c.id);
    let open = 0, openCents = 0, overdue = 0, overdueCents = 0, paidCents = 0, paid = 0;
    for (const i of inv) {
      if (i.status === 'sent') { const t = invTotal(i); open++; openCents += t; if (i.dueDate < today) { overdue++; overdueCents += t; } }
      else if (i.status === 'paid') { paid++; paidCents += invTotal(i); }
    }
    let revenueCents = null, basis = 'none', actualCents = null, partial = false;
    if (c.projectId && list(state, 'projects').some((p) => p.id === c.projectId)) {
      const t = L.revenue.totalsIn(state, { kind: 'line', id: c.projectId }, MIN_DATE, today);
      revenueCents = t.revenueCents; actualCents = t.expenseCents; basis = 'line'; partial = !!t.archivedPartial;
    } else if (paid > 0) { revenueCents = paidCents; basis = 'invoices'; partial = list(state, 'archives').length > 0; } // SEC-124: archived paid invoices are not live
    const lc = lastContact(state, c);
    const budget = typeof c.budgetCents === 'number' ? { budgetCents: c.budgetCents, actualCents, remainingCents: actualCents === null ? null : c.budgetCents - actualCents, over: actualCents === null ? null : actualCents > c.budgetCents } : null;
    return { id: c.id, revenueCents, basis, partial, openCount: open, openCents, overdueCount: overdue, overdueCents, budget, lastContact: lc, daysSinceContact: lc ? days(today, lc) : null };
  }
  // Flags: an overdue invoice; no contact for the set number of days (measured from the created date when never contacted).
  function flags(state, c, today, st) {
    const s = st || clientStats(state, c, today), n = contactDaysOf(state), ref = s.lastContact || c.createdOn || null;
    return { overdueInvoice: s.overdueCount > 0, noContact: c.status === 'active' && !!ref && days(today, ref) > n };
  }
  function counts(state, today) {
    const o = { clients: list(state, 'clients').length, overdueInvoices: 0, noContact: 0 };
    for (const c of list(state, 'clients')) { const f = flags(state, c, today); if (f.overdueInvoice) o.overdueInvoices++; if (f.noContact) o.noContact++; }
    return o;
  }
  const hasData = (state) => list(state, 'clients').length > 0;

  // ---- the business rollup over the existing lines of work ----
  const isBizLine = (state, p) => !!L.business && L.business.isBusinessLine(state, p.id);
  function rollup(state, today) {
    const m = L.revenue.periodRange, periods = { month: m('month', today), quarter: m('qtd', today), year: m('ytd', today) };
    const lines = list(state, 'projects').filter((p) => !p.archived && isBizLine(state, p));
    const out = { lines: [], totals: {}, partial: false, invoices: null, budgets: [] };
    for (const k of Object.keys(periods)) out.totals[k] = { revenueCents: 0, expenseCents: 0 };
    for (const p of lines) {
      const row = { id: p.id, name: p.name, kind: p.kind };
      for (const k of Object.keys(periods)) {
        const t = L.revenue.totalsIn(state, { kind: 'line', id: p.id }, periods[k].from, periods[k].to);
        row[k] = { revenueCents: t.revenueCents, expenseCents: t.expenseCents };
        out.totals[k].revenueCents += t.revenueCents; out.totals[k].expenseCents += t.expenseCents;
        if (t.archivedPartial) out.partial = true;
      }
      out.lines.push(row);
      const b = L.business.budgetFor(state, p.id, today);
      if (b && b.budgetCents !== null) out.budgets.push({ id: p.id, name: p.name, budgetCents: b.budgetCents, actualCents: b.actualCents, remainingCents: b.remainingCents, status: b.status, period: b.period });
    }
    out.invoices = L.business.aging(state, today);
    return out;
  }

  // ---- digest and generic labels (numbers only) ----
  const digest = (state, ws) => counts(state, M().addDays(ws, 6)).overdueInvoices;
  function registerGlance() {
    if (!L.activities || !L.activities.registerGlanceProvider) return;
    try {
      L.activities.registerGlanceProvider({
        id: 'client-flags', label: 'Clients',
        items: (state, today) => {
          const n = counts(state, today), out = [];
          if (n.overdueInvoices) out.push({ id: 'client-overdue-invoices', title: 'Clients with an overdue invoice: ' + n.overdueInvoices, date: today });
          if (n.noContact) out.push({ id: 'client-no-contact', title: 'Clients with no recent contact: ' + n.noContact, date: today });
          return out;
        },
      });
    } catch (e) { /* already registered */ }
  }
  // Registered by the app at start (the provider list otherwise stays as the earlier tests expect); the call is safe to repeat.

  L.clients = {
    STATUSES, CAP, DEFAULT_CONTACT_DAYS, MAX_CONTACT_DAYS, cleanSettings, contactDaysOf, setContactDays, cleanClients, fieldsIn, addClient, updateClient, deleteClient, linkPerson, unlinkPerson,
    setInvoiceClient, logContact, registerGlance, lastContact, clientStats, flags, counts, hasData, rollup, digest,
  };
})();
