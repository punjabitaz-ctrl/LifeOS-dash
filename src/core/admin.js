(function () {
  'use strict';
  // Admin (schema 6): renewals, subscriptions, a document index, tax checklist and the 30/60/90 day timeline.
  // Same rules as home.js: pure functions, mutators run inside store.commit, completing a recurring renewal only PROPOSES the next one.
  // The document index is a list of where things are kept, never the documents themselves: obvious secrets are refused.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const V = () => L.validate;
  const H = () => L.home;
  const D = () => L.home.dates;

  const RENEWAL_CAP = 2000, DOC_CAP = 1000, TAX_CAP = 1000;
  const KINDS = Object.freeze(['insurance', 'registration', 'license', 'subscription', 'membership', 'warranty', 'tax', 'legal', 'other']);
  const KIND_LABEL = Object.freeze({ insurance: 'Insurance', registration: 'Registration', license: 'License', subscription: 'Subscription', membership: 'Membership', warranty: 'Warranty', tax: 'Tax', legal: 'Legal', other: 'Other' });
  const CADENCES = Object.freeze(['once', 'monthly', 'annual', 'custom']);
  const CADENCE_LABEL = Object.freeze({ once: 'Once', monthly: 'Monthly', annual: 'Yearly', custom: 'Custom days' });
  const TAX_STATES = Object.freeze(['needed', 'received', 'filed']);
  const MAX_CENTS = 1e11;

  const list = (state, k) => (state && Array.isArray(state[k]) ? state[k] : []);

  // ---- secrets: the document index must never hold an ID number, card number or password ----
  const SECRET_MESSAGE = 'That looks like an ID number or a card number. This index only records where a document is kept. Do not enter ID numbers, account numbers or passwords.';
  function luhn(digits) {
    let sum = 0, alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = digits.charCodeAt(i) - 48;
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n; alt = !alt;
    }
    return sum % 10 === 0;
  }
  const YEAR = /^(19|20|21)\d\d$/;
  // Before matching, fold what a paste can hide a number behind: compatibility forms (full-width digits), any script's decimal
  // digits, invisible format characters (zero-width and bidi), any space (no-break, thin, ideographic) and any dash.
  function digitOf(ch) {
    let cp = ch.codePointAt(0), zero = cp;
    while (zero > 0 && /\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
    return String((cp - zero) % 10);
  }
  function fold(s) {
    return s.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\p{Nd}/gu, (c) => (c >= '0' && c <= '9' ? c : digitOf(c)))
      .replace(/[\p{Zs}\t]/gu, ' ').replace(/\p{Pd}|\u2212/gu, '-');
  }
  // One separator between digit groups: a space, dash or dot, with optional spaces around it ("4111 - 1111", "4111  1111").
  const SEP = '(?: *[-.] *| +)';
  const SSN_RE = new RegExp('(?<!\\d' + SEP + '?)\\d{3}' + SEP + '\\d{2}' + SEP + '\\d{4}(?!' + SEP + '?\\d)');
  const CARD4_RE = new RegExp('(?<!\\d)(\\d{4})' + SEP + '(\\d{4})' + SEP + '(\\d{4})' + SEP + '(\\d{1,7})(?!\\d)', 'g');
  const CARD465_RE = new RegExp('(?<!\\d)(\\d{4})' + SEP + '(\\d{6})' + SEP + '(\\d{4,5})(?!\\d)', 'g');
  // True for: a 9-digit SSN shape (123-45-6789, 123 45 6789, 123.45.6789, 123456789), or a 13 to 19 digit number that passes the
  // Luhn check, either run together or grouped like a card (4-4-4-4, 4-6-5) with spaces, dashes or dots. Years, dates, phone
  // numbers and amounts do not match.
  function looksSecret(s0) {
    if (typeof s0 !== 'string' || !s0) return false;
    const s = fold(s0);
    if (SSN_RE.test(s)) return true;
    if (/(?<![\d.,])\d{9}(?!\d|[.,]\d)/.test(s)) return true;
    for (const m of s.matchAll(/(?<!\d)\d{13,19}(?!\d)/g)) if (luhn(m[0])) return true;
    for (const m of s.matchAll(CARD4_RE)) {
      const digits = m[1] + m[2] + m[3] + m[4];
      if (digits.length >= 13 && digits.length <= 19 && !(YEAR.test(m[1]) && YEAR.test(m[2]) && YEAR.test(m[3]) && YEAR.test(m[4])) && luhn(digits)) return true;
    }
    for (const m of s.matchAll(CARD465_RE)) if (luhn(m[1] + m[2] + m[3])) return true;
    return false;
  }
  const SECRET_MESSAGE_FIELD = 'That looks like an ID number or a card number. Do not enter ID numbers, account numbers or passwords here.';
  const checkNoSecrets = (fields, msg) => { for (const f of fields) if (looksSecret(f)) throw new Error(msg || SECRET_MESSAGE); };

  // ---- validation ----
  const T = (v, max, name, empty) => H().text(v, max, name, empty);
  function cleanRenewals(list_) {
    if (list_ === undefined) return [];
    const seen = new Set();
    return V().arr(list_, RENEWAL_CAP, 'renewals').map((x) => {
      const id = H().ident(x, seen, 'renewal');
      const o = { id, title: T(x.title, 200, 'renewal title'), kind: V().oneOf(x.kind, KINDS, 'renewal kind'), provider: T(x.provider, 200, 'provider', true), dueDate: H().reqDate(x.dueDate, 'due date') };
      Object.assign(o, H().cleanRepeat(x, CADENCES, 'renewal'));
      const amt = H().optInt(x.amount, 0, MAX_CENTS, 'amount'); if (amt !== undefined) o.amount = amt;
      o.autoRenews = V().bool(x.autoRenews, 'autoRenews', false);
      o.state = V().oneOf(x.state, ['open', 'done', 'cancelled'], 'renewal state');
      o.notes = T(x.notes, 2000, 'notes', true);
      const rv = H().optDate(x.reviewedOn, 'reviewed date'); if (rv) o.reviewedOn = rv;
      const dn = H().optDate(x.doneOn, 'done date'); if (dn) o.doneOn = dn;
      if (x.createdAt !== undefined && x.createdAt !== null) o.createdAt = V().ts(x.createdAt, 'createdAt');
      return o;
    });
  }
  function cleanDocuments(list_) {
    if (list_ === undefined) return [];
    const seen = new Set();
    return V().arr(list_, DOC_CAP, 'documents').map((x) => {
      const id = H().ident(x, seen, 'document');
      const o = { id, title: T(x.title, 200, 'document title'), kind: T(x.kind, 60, 'document kind', true), whereKept: T(x.whereKept, 200, 'where kept', true) };
      const ex = H().optDate(x.expires, 'expiry date'); if (ex) o.expires = ex;
      o.notes = T(x.notes, 2000, 'notes', true);
      if (looksSecret(o.title) || looksSecret(o.kind) || looksSecret(o.whereKept) || looksSecret(o.notes)) V().fail('a document entry looks like it holds an ID or card number');
      return o;
    });
  }
  function cleanTaxItems(list_) {
    if (list_ === undefined) return [];
    const seen = new Set();
    return V().arr(list_, TAX_CAP, 'tax items').map((x) => {
      const id = H().ident(x, seen, 'tax item');
      const o = { id, year: V().num(x.year, 1990, 2200, 'tax year', true), title: T(x.title, 200, 'tax item title'), state: V().oneOf(x.state, TAX_STATES, 'tax item state') };
      const dd = H().optDate(x.dueDate, 'due date'); if (dd) o.dueDate = dd;
      o.notes = T(x.notes, 2000, 'notes', true);
      return o;
    });
  }

  // ---- renewals ----
  const keyOf = (r) => r.kind + '|' + r.title.trim().toLowerCase() + '|' + r.provider.trim().toLowerCase();
  const find = (state, id) => { const r = list(state, 'renewals').find((x) => x.id === id); if (!r) throw new Error('Renewal not found'); return r; };
  function addRenewal(state, input, today) {
    if (list(state, 'renewals').length >= RENEWAL_CAP) throw new Error('You can keep up to ' + RENEWAL_CAP + ' renewals');
    if (!input || typeof input.title !== 'string' || !input.title.trim()) throw new Error('Enter a title.');
    if (!D().isDate(input.dueDate)) throw new Error('Enter a valid due date.');
    checkNoSecrets([input.title, input.provider, input.notes], SECRET_MESSAGE_FIELD); // a licence, policy card or payment card number pasted here is refused too
    const o = {
      id: L.store.newId(), title: input.title, kind: input.kind || 'other', provider: input.provider || '', dueDate: input.dueDate,
      cadence: input.cadence || 'once', autoRenews: !!input.autoRenews, state: 'open', notes: input.notes || '',
    };
    if (o.cadence === 'custom') { o.everyDays = H().toInt(input.everyDays, 1, 3650, 'Repeat days'); if (o.everyDays === undefined) throw new Error('Repeat days must be a whole number from 1 to 3650'); }
    const c = H().toCents(input.amount, 'Amount'); if (c !== undefined) o.amount = c;
    if (today && D().isDate(today)) { o.reviewedOn = today; o.createdAt = new Date().toISOString(); }
    const clean = cleanRenewals([o])[0];
    state.renewals = list(state, 'renewals').concat([clean]);
    return clean;
  }
  // Monthly and yearly renewals keep their day of the month: a renewal due on the 31st falls on the 28th in February and goes back to
  // the 31st in March (not the 28th for ever). The day comes from the earlier renewals of the same chain (same kind, title and
  // provider): walking back while each one sat on the last day of its month, the largest day seen is the anchor.
  const lastDay = (d) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).getUTCDate();
  const isLastDay = (d) => +d.slice(8, 10) === lastDay(d);
  function anchorDay(chain, r) {
    if ((r.cadence !== 'monthly' && r.cadence !== 'annual') || !isLastDay(r.dueDate)) return undefined;
    let anchor = +r.dueDate.slice(8, 10);
    const before = (chain || []).filter((x) => x !== r && x.dueDate < r.dueDate).sort((a, b) => b.dueDate.localeCompare(a.dueDate));
    for (const x of before) {
      anchor = Math.max(anchor, +x.dueDate.slice(8, 10));
      if (!isLastDay(x.dueDate)) break;
    }
    return anchor;
  }
  const chainOf = (state, r) => list(state, 'renewals').filter((x) => keyOf(x) === keyOf(r));
  function proposeNext(r, anchor) {
    if (!r || r.cadence === 'once') return null;
    let due = H().nextDate(r.dueDate, r.cadence, r.everyDays);
    if (anchor) due = due.slice(0, 8) + String(Math.min(anchor, lastDay(due))).padStart(2, '0');
    return { fromId: r.id, title: r.title, kind: r.kind, provider: r.provider, cadence: r.cadence, everyDays: r.everyDays, amount: r.amount, autoRenews: r.autoRenews, dueDate: due };
  }
  function pendingRenewals(state) {
    const open = new Set(list(state, 'renewals').filter((r) => r.state === 'open').map(keyOf)), latest = new Map(), chains = new Map();
    for (const r of list(state, 'renewals')) {
      const k = keyOf(r);
      if (!chains.has(k)) chains.set(k, []);
      chains.get(k).push(r);
      if (r.state !== 'done' || r.cadence === 'once') continue;
      const cur = latest.get(k);
      if (!cur || r.dueDate >= cur.dueDate) latest.set(k, r);
    }
    const out = [];
    for (const [k, r] of latest) {
      if (open.has(k)) continue;
      let p = null;
      try { p = proposeNext(r, anchorDay(chains.get(k), r)); } catch (e) { p = null; }
      if (p) out.push(p);
    }
    return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));
  }
  function completeRenewal(state, id, doneOn, today) {
    const r = find(state, id);
    if (r.state !== 'open') throw new Error('That renewal is already closed');
    const d = doneOn || today;
    if (!D().isDate(d)) throw new Error('Date must be a valid date');
    if (today && d > today) throw new Error('The done date cannot be in the future');
    r.state = 'done'; r.doneOn = d;
    return proposeNext(r, anchorDay(chainOf(state, r), r));
  }
  // Creates the proposed next renewal after the user's confirmation.
  function confirmRenewal(state, fromId, dueOverride) {
    const p = pendingRenewals(state).find((x) => x.fromId === fromId);
    if (!p) throw new Error('There is nothing to confirm for that renewal');
    const src = find(state, fromId);
    let due = p.dueDate;
    if (dueOverride) { if (!D().isDate(dueOverride)) throw new Error('Date must be a valid date'); due = dueOverride; }
    if (list(state, 'renewals').length >= RENEWAL_CAP) throw new Error('You can keep up to ' + RENEWAL_CAP + ' renewals');
    const o = { id: L.store.newId(), title: src.title, kind: src.kind, provider: src.provider, dueDate: due, cadence: src.cadence, autoRenews: src.autoRenews, state: 'open', notes: src.notes, createdAt: new Date().toISOString() };
    if (src.everyDays !== undefined) o.everyDays = src.everyDays;
    if (src.amount !== undefined) o.amount = src.amount;
    if (src.reviewedOn) o.reviewedOn = src.reviewedOn;
    const clean = cleanRenewals([o])[0];
    state.renewals.push(clean);
    return clean;
  }
  function stopRenewing(state, id) { const r = find(state, id); r.cadence = 'once'; delete r.everyDays; return r; }
  function cancelRenewal(state, id) { const r = find(state, id); if (r.state !== 'open') throw new Error('That renewal is already closed'); r.state = 'cancelled'; return r; }
  function markReviewed(state, id, today) { const r = find(state, id); if (!D().isDate(today)) throw new Error('today must be YYYY-MM-DD'); r.reviewedOn = today; return r; }
  function deleteRenewal(state, id) { find(state, id); state.renewals = state.renewals.filter((x) => x.id !== id); }

  // ---- subscriptions: monthly and annual run-rate in integer cents ----
  // Annual cost of one subscription from its amount and repeat; null for a one-off or when no amount is given.
  function annualCents(r) {
    if (typeof r.amount !== 'number') return null;
    if (r.cadence === 'monthly') return r.amount * 12;
    if (r.cadence === 'annual') return r.amount;
    if (r.cadence === 'custom') return Math.round(r.amount * 365 / r.everyDays);
    return null;
  }
  function subscriptions(state, today) {
    if (!D().isDate(today)) throw new Error('today must be YYYY-MM-DD');
    const items = list(state, 'renewals').filter((r) => r.kind === 'subscription' && r.state === 'open').map((r) => {
      const a = annualCents(r);
      return {
        id: r.id, title: r.title, provider: r.provider, cadence: r.cadence, amount: r.amount === undefined ? null : r.amount, dueDate: r.dueDate, autoRenews: r.autoRenews,
        annualCents: a, monthlyCents: a === null ? null : Math.round(a / 12), reviewedOn: r.reviewedOn || null,
        stale: !r.reviewedOn || D().addMonths(r.reviewedOn, 12) < today,
      };
    }).sort((a, b) => a.title.localeCompare(b.title));
    const annual = items.reduce((s, x) => s + (x.annualCents || 0), 0);
    return { items, annualCents: annual, monthlyCents: Math.round(annual / 12), staleCount: items.filter((x) => x.stale).length };
  }

  // ---- document index ----
  function addDocument(state, input) {
    if (list(state, 'documents').length >= DOC_CAP) throw new Error('You can keep up to ' + DOC_CAP + ' documents');
    if (!input || typeof input.title !== 'string' || !input.title.trim()) throw new Error('Enter a title.');
    checkNoSecrets([input.title, input.kind, input.whereKept, input.notes]);
    const o = { id: L.store.newId(), title: input.title, kind: input.kind || '', whereKept: input.whereKept || '', notes: input.notes || '' };
    if (input.expires) o.expires = input.expires;
    const clean = cleanDocuments([o])[0];
    state.documents = list(state, 'documents').concat([clean]);
    return clean;
  }
  function deleteDocument(state, id) {
    if (!list(state, 'documents').some((x) => x.id === id)) throw new Error('Document not found');
    state.documents = state.documents.filter((x) => x.id !== id);
  }

  // ---- tax checklist (no tax advice, no computed tax) ----
  function addTaxItem(state, input) {
    if (list(state, 'taxItems').length >= TAX_CAP) throw new Error('You can keep up to ' + TAX_CAP + ' tax items');
    if (!input || typeof input.title !== 'string' || !input.title.trim()) throw new Error('Enter a title.');
    checkNoSecrets([input.title, input.notes], SECRET_MESSAGE_FIELD); // an SSN or card number pasted into a tax note is refused too
    const yr = H().toInt(input.year, 1990, 2200, 'Tax year');
    if (yr === undefined) throw new Error('Enter a tax year.');
    const o = { id: L.store.newId(), year: yr, title: input.title, state: input.state || 'needed', notes: input.notes || '' };
    if (input.dueDate) o.dueDate = input.dueDate;
    const clean = cleanTaxItems([o])[0];
    state.taxItems = list(state, 'taxItems').concat([clean]);
    return clean;
  }
  function setTaxState(state, id, to) {
    const t = list(state, 'taxItems').find((x) => x.id === id);
    if (!t) throw new Error('Tax item not found');
    if (!TAX_STATES.includes(to)) throw new Error('Unknown tax item state');
    t.state = to;
    return t;
  }
  function deleteTaxItem(state, id) {
    if (!list(state, 'taxItems').some((x) => x.id === id)) throw new Error('Tax item not found');
    state.taxItems = state.taxItems.filter((x) => x.id !== id);
  }
  function taxByYear(state) {
    const m = new Map();
    for (const t of list(state, 'taxItems')) { if (!m.has(t.year)) m.set(t.year, []); m.get(t.year).push(t); }
    return [...m.entries()].sort((a, b) => b[0] - a[0]).map(([year, items]) => ({
      year, items: items.slice().sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.title.localeCompare(b.title)),
      needed: items.filter((x) => x.state === 'needed').length, received: items.filter((x) => x.state === 'received').length, filed: items.filter((x) => x.state === 'filed').length,
    }));
  }

  // ---- legacy: home/due entries from before schema 6 become renewals; nothing is dropped ----
  // Title, due date, status, the entry's own date, its notes and its createdAt carry over. When the notes would not fit in
  // 2,000 characters, or past the renewals cap, the original entry is kept as it was and listed under Admin (read only).
  function legacyDue(entries, cap, newId) {
    const renewals = [], gone = new Set();
    const sorted = entries.filter((e) => e.domain === 'home' && e.type === 'due');
    for (const e of sorted) {
      if (renewals.length >= cap) break;
      const notes = 'Imported from a Home due item dated ' + e.date + '.' + (e.notes ? ' ' + e.notes : '');
      if (notes.length > 2000 || typeof e.due !== 'string' || !D().isDate(e.due)) continue;
      const r = { id: typeof e.id === 'string' && e.id && e.id.length <= 100 ? e.id : newId(), title: e.title, kind: 'other', provider: '', dueDate: e.due, cadence: 'once', autoRenews: false, state: e.status === 'done' ? 'done' : 'open', notes };
      if (e.createdAt !== undefined) r.createdAt = e.createdAt;
      renewals.push(r); gone.add(e);
    }
    return { renewals, entries: entries.filter((e) => !gone.has(e)) };
  }
  const legacyEntries = (state) => list(state, 'entries').filter((e) => e.domain === 'home' && e.type === 'due').sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title));

  // ---- everything with a date, for the timeline, the digest, the tile and the goal metric ----
  // `closed` is the date an item stopped counting: null while open, '' when closed with no known date, else the day it closed.
  function dated(state) {
    const out = [];
    for (const r of list(state, 'renewals')) out.push({ src: 'renewal', id: r.id, title: r.title, kind: r.kind, date: r.dueDate, closed: r.state === 'open' ? null : r.state === 'done' && r.doneOn ? r.doneOn : '' });
    for (const t of list(state, 'taxItems')) if (t.dueDate) out.push({ src: 'tax', id: t.id, title: t.title, kind: 'tax ' + t.year, date: t.dueDate, closed: t.state === 'filed' ? '' : null });
    for (const d of list(state, 'documents')) if (d.expires) out.push({ src: 'document', id: d.id, title: d.title, kind: 'expires', date: d.expires, closed: null });
    // Certification expiry is computed from the Learning item, never stored as a renewal.
    if (L.learning) for (const x of L.learning.expiries(state)) out.push({ src: 'learning', id: x.id, title: x.title, kind: 'certification expires', date: x.date, closed: null });
    for (const e of legacyEntries(state)) out.push({ src: 'legacy', id: e.id, title: e.title, kind: 'older due item', date: e.due, closed: e.status === 'done' ? '' : null });
    return out;
  }
  const openOn = (x, d) => x.closed === null || (x.closed !== '' && x.closed > d);
  const order = (a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title);
  const overdueAt = (state, d) => dated(state).filter((x) => x.date < d && openOn(x, d)).sort(order);
  const dueWithin = (state, d, days) => { const end = D().addDays(d, days); return dated(state).filter((x) => x.date >= d && x.date <= end && openOn(x, d)).sort(order); };
  function timeline(state, today) {
    if (!D().isDate(today)) throw new Error('today must be YYYY-MM-DD');
    const e30 = D().addDays(today, 30), e60 = D().addDays(today, 60), e90 = D().addDays(today, 90);
    const open = dated(state).filter((x) => openOn(x, today)).sort(order);
    const t = { overdue: [], d30: [], d60: [], d90: [] };
    for (const x of open) {
      if (x.date < today) t.overdue.push(x);
      else if (x.date <= e30) t.d30.push(x);
      else if (x.date <= e60) t.d60.push(x);
      else if (x.date <= e90) t.d90.push(x);
    }
    return t;
  }
  const hasData = (state) => list(state, 'renewals').length + list(state, 'documents').length + list(state, 'taxItems').length + legacyEntries(state).length + (L.learning ? L.learning.expiries(state).length : 0) > 0;
  function headline(state, today, R) {
    const od = overdueAt(state, today).length, soon = dueWithin(state, today, 30).length;
    return R('Due within 30 days', String(soon), soon, od + ' overdue');
  }
  const weekValue = (state, we) => dueWithin(state, we, 30).length;
  // Counts and totals only: never a title, provider, location or note.
  function digest(state, ws) {
    const we = D().addDays(ws, 6);
    return {
      overdue: overdueAt(state, we).length, dueSoon: dueWithin(state, we, 30).length,
      done: list(state, 'renewals').filter((r) => r.state === 'done' && r.doneOn && r.doneOn >= ws && r.doneOn <= we).length,
      runRateCents: subscriptions(state, we).monthlyCents,
    };
  }
  function reviewWeek(state, ws) {
    const we = D().addDays(ws, 6), nws = D().addDays(ws, 7), nwe = D().addDays(ws, 13), all = dated(state).filter((x) => openOn(x, we));
    return {
      cameDue: all.filter((x) => x.date >= ws && x.date <= we).sort(order),
      overdue: all.filter((x) => x.date < ws).sort(order),
      dueNext: all.filter((x) => x.date >= nws && x.date <= nwe).sort(order),
      proposals: pendingRenewals(state),
    };
  }
  // Linked goal metric: admin items overdue on a date; null when nothing is tracked.
  const overdueValue = (state, asOf) => (hasData(state) ? overdueAt(state, asOf).length : null);

  L.admin = {
    KINDS, KIND_LABEL, CADENCES, CADENCE_LABEL, TAX_STATES, RENEWAL_CAP, DOC_CAP, TAX_CAP, SECRET_MESSAGE, SECRET_MESSAGE_FIELD,
    looksSecret, luhn, checkNoSecrets, anchorDay, cleanRenewals, cleanDocuments, cleanTaxItems, addRenewal, proposeNext, pendingRenewals, completeRenewal, confirmRenewal,
    stopRenewing, cancelRenewal, markReviewed, deleteRenewal, annualCents, subscriptions, addDocument, deleteDocument, addTaxItem, setTaxState, deleteTaxItem, taxByYear,
    legacyDue, legacyEntries, dated, overdueAt, dueWithin, timeline, headline, weekValue, digest, reviewWeek, overdueValue, hasData,
  };
})();
