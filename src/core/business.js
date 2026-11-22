(function () {
  'use strict';
  // v1.1.0: business records: scope defaults, settings, invoices and receivables, mileage trips, home office, payees (1099-NEC) and
  // project budgets. Pure functions over state; every mutator runs inside a commit and does one thing a user tapped. Nothing posts on
  // its own: an invoice never creates income until the user taps it. Money is integer cents; an invoice line total is
  // round(quantity x unit price) half away from zero (quantity has two decimals, held as hundredths), see tax.mulDiv.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const V = () => L.validate;
  const T = () => L.tax;

  const INVOICE_CAP = 5000, TRIP_CAP = 10000, PAYEE_CAP = 1000, LINE_CAP = 50, MAX_CENTS = 1e11;
  const BUSINESS_KINDS = Object.freeze(['venture', 'client', 'website', 'podcast']);
  const INVOICE_STATES = Object.freeze(['draft', 'sent', 'paid', 'void']);
  const BUDGET_PERIODS = Object.freeze(['month', 'project']);
  const BUCKETS = Object.freeze([['current', 'Current'], ['d1_30', '1 to 30 days'], ['d31_60', '31 to 60 days'], ['d61_90', '61 to 90 days'], ['over90', 'Over 90 days']]);
  const DEFAULT_FORMAT = 'INV-{NNNN}';
  const days = (a, b) => L.home.dates.daysBetween(a, b);
  const isDate = (s) => L.home.dates.isDate(s);
  const list = (st, k) => (st && Array.isArray(st[k]) ? st[k] : []);
  const centsOf = (v) => Math.round(Number(v) * 100);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const text = (v, max, name, empty) => L.home.text(v, max, name, empty);
  const reqDate = (v, name) => { const d = V().date(v, name); if (!isDate(d)) V().fail(name + ' is out of range'); return d; };
  const noSecrets = (fields, msg) => { if (L.admin) L.admin.checkNoSecrets(fields, msg || L.admin.SECRET_MESSAGE_FIELD); };
  const noTaxId = (fields) => { for (const f of fields) if (L.admin.looksTaxId(f)) throw new Error(L.admin.TAXID_MESSAGE); };
  // SEC-79: invoice fields and the business details printed on invoices refuse an EIN shape (12-3456789) as well as the SSN and card
  // shapes the general guard catches. A tax ID is never stored anywhere in LifeOS.
  const noIds = (fields) => { noSecrets(fields); noTaxId(fields.filter((f) => typeof f === 'string')); };

  // ---- scope: business or personal ----
  const isBusinessLine = (state, projectId) => {
    const p = projectId ? list(state, 'projects').find((x) => x.id === projectId) : null;
    return !!p && BUSINESS_KINDS.includes(p.kind);
  };
  const defaultScope = (state, projectId) => (isBusinessLine(state, projectId) ? 'business' : 'personal');
  const moneyEntries = (state) => list(state, 'entries').filter((e) => e.domain === 'money' && (e.type === 'income' || e.type === 'expense'));
  // An entry with no scope takes the one its line of work implies (business kinds are business); the migration to schema 12 leaves
  // every entry as it is and the owner confirms the counts once. Confirming fixes each visible entry's scope.
  const scopeOf = (state, e) => e.scope || defaultScope(state, e.projectId);
  const isBiz = (state) => { const ids = new Set(list(state, 'projects').filter((p) => BUSINESS_KINDS.includes(p.kind)).map((p) => p.id)); return (e) => (e.scope ? e.scope === 'business' : !!e.projectId && ids.has(e.projectId)); };
  const scopeCounts = (state) => {
    const b = isBiz(state), m = moneyEntries(state), n = m.filter(b).length;
    return { business: n, personal: m.length - n };
  };
  function confirmScope(state) {
    const b = isBiz(state);
    for (const e of moneyEntries(state)) if (!e.scope) e.scope = b(e) ? 'business' : 'personal';
    state.settings.business.scopeConfirmed = true;
  }
  function setScope(state, ids, scope) {
    if (scope !== 'business' && scope !== 'personal') throw new Error('Scope must be business or personal');
    const set = new Set(ids), b = isBiz(state);
    let n = 0;
    for (const e of moneyEntries(state)) if (set.has(e.id)) { if ((b(e) ? 'business' : 'personal') !== scope) n++; e.scope = scope; }
    return n;
  }

  // ---- settings ----
  const defaultSettings = (scopeConfirmed) => ({ name: '', address: '', paymentTerms: '', invoiceFormat: DEFAULT_FORMAT, invoiceNext: 1, scopeConfirmed: scopeConfirmed !== false });
  function cleanFormat(f) {
    const s = V().str(V().strip(f).trim(), 40, 'invoice number format');
    if (!/\{N+\}/.test(s)) V().fail('invoice number format needs a counter such as {NNNN}');
    if (s.replace(/\{(N+|YYYY|YY)\}/g, '').match(/[{}]/)) V().fail('invoice number format has an unknown token');
    return s;
  }
  function cleanSettings(x) {
    if (x === undefined || x === null) return defaultSettings(true);
    if (!V().isObj(x)) V().fail('business settings');
    const o = {
      name: text(x.name, 120, 'business name', true), address: text(x.address, 300, 'business address', true), paymentTerms: text(x.paymentTerms, 300, 'payment terms', true),
      invoiceFormat: x.invoiceFormat === undefined ? DEFAULT_FORMAT : cleanFormat(x.invoiceFormat),
      invoiceNext: V().num(x.invoiceNext === undefined ? 1 : x.invoiceNext, 1, 1e9, 'invoice counter', true),
      scopeConfirmed: V().bool(x.scopeConfirmed, 'scopeConfirmed', true),
    };
    for (const k of ['reserveAccountId', 'pinnedProjectId']) if (x[k] !== undefined && x[k] !== null && x[k] !== '') o[k] = V().str(x[k], 100, k);
    return o;
  }
  function saveSettings(state, input) {
    const cur = state.settings.business, o = Object.assign({}, cur);
    for (const k of ['name', 'address', 'paymentTerms']) if (input[k] !== undefined) o[k] = input[k];
    noIds([o.name, o.address, o.paymentTerms]);
    for (const k of ['invoiceFormat', 'invoiceNext']) if (input[k] !== undefined) o[k] = input[k];
    for (const k of ['reserveAccountId', 'pinnedProjectId']) if (input[k] !== undefined) { if (input[k]) o[k] = input[k]; else delete o[k]; }
    state.settings.business = cleanSettings(o);
    return state.settings.business;
  }

  // ---- payees (1099-NEC). The tax ID itself is never stored, only whether a W-9 is on file ----
  function cleanPayees(l) {
    if (l === undefined || l === null) return [];
    const seen = new Set();
    return V().arr(l, PAYEE_CAP, 'payees').map((x) => {
      if (!V().isObj(x)) V().fail('payee');
      const id = V().str(x.id, 100, 'payee id');
      if (seen.has(id)) V().fail('duplicate payee id');
      seen.add(id);
      const o = { id, name: text(x.name, 120, 'payee name'), tinOnFile: V().bool(x.tinOnFile, 'tinOnFile', false) };
      if (x.w9Date !== undefined && x.w9Date !== null && x.w9Date !== '') o.w9Date = reqDate(x.w9Date, 'W-9 date');
      o.archived = V().bool(x.archived, 'archived', false);
      return o;
    });
  }
  function addPayee(state, input) {
    if (list(state, 'payees').length >= PAYEE_CAP) throw new Error('You can keep up to ' + PAYEE_CAP + ' payees');
    if (!input || typeof input.name !== 'string' || !input.name.trim()) throw new Error('Enter a name.');
    noTaxId([input.name]);
    const o = { id: L.store.newId(), name: input.name, tinOnFile: !!input.tinOnFile, archived: false };
    if (input.w9Date) o.w9Date = input.w9Date;
    const clean = cleanPayees([o])[0];
    state.payees = list(state, 'payees').concat([clean]);
    return clean;
  }
  function updatePayee(state, id, patch) {
    const p = list(state, 'payees').find((x) => x.id === id);
    if (!p) throw new Error('Payee not found');
    const o = Object.assign({}, p);
    if (patch.name !== undefined) { noTaxId([patch.name]); o.name = patch.name; }
    if (patch.tinOnFile !== undefined) o.tinOnFile = !!patch.tinOnFile;
    if (patch.w9Date !== undefined) { if (patch.w9Date) o.w9Date = patch.w9Date; else delete o.w9Date; }
    if (patch.archived !== undefined) o.archived = !!patch.archived;
    const clean = cleanPayees([o])[0];
    state.payees = state.payees.map((x) => (x.id === id ? clean : x));
    return clean;
  }
  // Deleting a payee unlinks its expenses (never deletes them).
  function deletePayee(state, id) {
    if (!list(state, 'payees').some((x) => x.id === id)) throw new Error('Payee not found');
    let n = 0;
    for (const e of list(state, 'entries')) if (e.payeeId === id) { delete e.payeeId; n++; }
    state.payees = state.payees.filter((x) => x.id !== id);
    return n;
  }
  function assignPayee(state, entryId, payeeId, opts) {
    const e = list(state, 'entries').find((x) => x.id === entryId);
    if (!e || e.type !== 'expense') throw new Error('Choose an expense.');
    if (payeeId && !list(state, 'payees').some((x) => x.id === payeeId)) throw new Error('Payee not found');
    if (payeeId) e.payeeId = payeeId; else delete e.payeeId;
    if (opts && opts.cardPaid !== undefined) { if (opts.cardPaid) e.cardPaid = true; else delete e.cardPaid; }
    return e;
  }

  // ---- invoices ----
  const qtyH = (q) => Math.round(q * 100);
  const lineTotal = (ln) => T().mulDiv(qtyH(ln.qty), ln.unitCents, 100);
  const invoiceTotal = (inv) => sum(inv.lines.map(lineTotal));
  function cleanInvoices(l, opts) {
    if (l === undefined || l === null) return [];
    const seen = new Set(), nums = new Set(), merged = !!(opts && opts.merged);
    return V().arr(l, INVOICE_CAP, 'invoices').map((x) => {
      if (!V().isObj(x)) V().fail('invoice');
      const id = V().str(x.id, 100, 'invoice id');
      if (seen.has(id)) V().fail('duplicate invoice id');
      seen.add(id);
      const number = text(x.number, 40, 'invoice number');
      const nk = number.toLowerCase();
      if (!merged && nums.has(nk)) V().fail('duplicate invoice number');
      nums.add(nk);
      const o = { id, number };
      if (x.projectId !== undefined && x.projectId !== null && x.projectId !== '') o.projectId = V().str(x.projectId, 100, 'invoice line of work');
      if (x.clientId !== undefined && x.clientId !== null && x.clientId !== '') o.clientId = V().str(x.clientId, 100, 'invoice client');
      o.issueDate = reqDate(x.issueDate, 'issue date'); o.dueDate = reqDate(x.dueDate, 'due date');
      if (o.dueDate < o.issueDate) V().fail('due date is before the issue date');
      if (!Array.isArray(x.lines)) V().fail('invoice lines must be a list');
      if (x.lines.length > LINE_CAP) V().fail('invoice has too many lines');
      o.lines = x.lines.map((ln) => {
        if (!V().isObj(ln)) V().fail('invoice line');
        const q = V().num(ln.qty, 0.01, 1e6, 'quantity');
        if (Math.round(q * 100) / 100 !== q) V().fail('quantity allows two decimals');
        const r = { description: text(ln.description, 200, 'line description'), qty: q, unitCents: V().num(ln.unitCents, 0, MAX_CENTS, 'unit price', true) };
        if (ln.expenseId !== undefined && ln.expenseId !== null && ln.expenseId !== '') r.expenseId = V().str(ln.expenseId, 100, 'line expense');
        return r;
      });
      if (invoiceTotal(o) > MAX_CENTS) V().fail('invoice total too large');
      o.status = V().oneOf(x.status, INVOICE_STATES, 'invoice status');
      if (o.status === 'paid') o.paidOn = reqDate(x.paidOn, 'paid on'); else if (x.paidOn !== undefined && x.paidOn !== null && x.paidOn !== '') V().fail('only a paid invoice has a paid date');
      if (x.incomeId !== undefined && x.incomeId !== null && x.incomeId !== '') o.incomeId = V().str(x.incomeId, 100, 'invoice income');
      o.notes = text(x.notes, 2000, 'invoice notes', true);
      return o;
    });
  }
  const findInvoice = (state, id) => {
    const i = list(state, 'invoices').find((x) => x.id === id);
    if (!i) throw new Error('Invoice not found');
    return i;
  };
  const numberTaken = (state, n) => list(state, 'invoices').some((i) => i.number.toLowerCase() === String(n).trim().toLowerCase());
  // {YYYY} year of the issue date, {YY} its last two digits, {N...} the counter padded to that many digits.
  function formatNumber(fmt, n, issueDate) {
    return fmt.replace(/\{(N+|YYYY|YY)\}/g, (m, t) => (t === 'YYYY' ? issueDate.slice(0, 4) : t === 'YY' ? issueDate.slice(2, 4) : String(n).padStart(t.length, '0')));
  }
  // SEC-80: one set of taken numbers per call (linear), not a scan of every invoice per candidate number.
  function nextNumber(state, issueDate) {
    const b = state.settings.business, taken = new Set(list(state, 'invoices').map((i) => i.number.toLowerCase()));
    let n = b.invoiceNext;
    for (let i = 0; i < 100000; i++, n++) { const s = formatNumber(b.invoiceFormat, n, issueDate); if (!taken.has(s.trim().toLowerCase())) return { number: s, counter: n }; }
    throw new Error('Could not find a free invoice number');
  }
  function checkLines(lines) {
    noIds((lines || []).map((l) => l && l.description));
  }
  // A new draft. With no number given the next one from the user's format is used and the counter moves on; a typed number is
  // used as is. A duplicate number is refused either way.
  function createInvoice(state, input) {
    if (list(state, 'invoices').length >= INVOICE_CAP) throw new Error('You can keep up to ' + INVOICE_CAP + ' invoices');
    if (!input || typeof input !== 'object') throw new Error('Enter an invoice.');
    noIds([input.notes, input.number]); checkLines(input.lines);
    const issue = input.issueDate;
    if (!isDate(issue)) throw new Error('Enter the issue date.');
    let number = typeof input.number === 'string' ? input.number.trim() : '', counter = null;
    if (!number) { const nx = nextNumber(state, issue); number = nx.number; counter = nx.counter; }
    else if (numberTaken(state, number)) throw new Error('That invoice number is already used.');
    const o = { id: L.store.newId(), number, issueDate: issue, dueDate: input.dueDate, lines: (input.lines || []).slice(), status: 'draft', notes: input.notes || '' };
    if (input.projectId) o.projectId = input.projectId;
    const clean = cleanInvoices([o])[0];
    state.invoices = list(state, 'invoices').concat([clean]);
    if (counter !== null) state.settings.business.invoiceNext = counter + 1;
    return clean;
  }
  function editDraft(state, id, patch) {
    const inv = findInvoice(state, id);
    if (inv.status !== 'draft') throw new Error('Only a draft can be edited.');
    noIds([patch.notes, patch.number]); if (patch.lines) checkLines(patch.lines);
    const o = Object.assign({}, inv);
    for (const k of ['issueDate', 'dueDate', 'notes', 'lines']) if (patch[k] !== undefined) o[k] = patch[k];
    if (patch.projectId !== undefined) { if (patch.projectId) o.projectId = patch.projectId; else delete o.projectId; }
    if (patch.number !== undefined) {
      const n = String(patch.number).trim();
      if (!n) throw new Error('Enter an invoice number.');
      if (n.toLowerCase() !== inv.number.toLowerCase() && numberTaken(state, n)) throw new Error('That invoice number is already used.');
      o.number = n;
    }
    // lines that left the draft free their expenses again
    const keep = new Set((o.lines || []).map((l) => l.expenseId).filter(Boolean));
    for (const l of inv.lines) if (l.expenseId && !keep.has(l.expenseId)) unbill(state, l.expenseId, id);
    const clean = cleanInvoices([o])[0];
    state.invoices = state.invoices.map((x) => (x.id === id ? clean : x));
    return clean;
  }
  function unbill(state, expenseId, invoiceId) {
    const e = list(state, 'entries').find((x) => x.id === expenseId);
    if (e && e.billedInvoiceId === invoiceId) delete e.billedInvoiceId;
  }
  // Unbilled billable expenses of a client line, newest first (never netted: they stay deductions on their own tax lines).
  function unbilled(state, projectId) {
    return list(state, 'entries').filter((e) => e.domain === 'money' && e.type === 'expense' && e.billable && !e.billedInvoiceId && (!projectId || e.projectId === projectId)).sort((a, b) => b.date.localeCompare(a.date));
  }
  // "Add to invoice": one tap per expense. Gross treatment: the invoice line carries the full amount and the expense keeps its deduction.
  function addBillable(state, invoiceId, expenseId) {
    const inv = findInvoice(state, invoiceId);
    if (inv.status !== 'draft') throw new Error('Expenses can only be added to a draft invoice.');
    const e = list(state, 'entries').find((x) => x.id === expenseId);
    if (!e || e.type !== 'expense') throw new Error('Expense not found');
    if (!e.billable) throw new Error('That expense is not marked billable.');
    if (e.billedInvoiceId) throw new Error('That expense is already on an invoice.');
    if (inv.lines.length >= LINE_CAP) throw new Error('An invoice has up to ' + LINE_CAP + ' lines');
    if (inv.projectId && e.projectId && e.projectId !== inv.projectId) throw new Error('That expense belongs to another line of work.');
    inv.lines.push({ description: e.title.slice(0, 200), qty: 1, unitCents: centsOf(e.value), expenseId: e.id });
    e.billedInvoiceId = inv.id;
    return inv;
  }
  function markSent(state, id) {
    const inv = findInvoice(state, id);
    if (inv.status !== 'draft') throw new Error('Only a draft can be marked sent.');
    if (!inv.lines.length) throw new Error('Add at least one line first.');
    inv.status = 'sent';
    return inv;
  }
  // Offered after "sent": one expected income entry for the total, due on the invoice due date. One income per invoice.
  function createExpectedIncome(state, id) {
    const inv = findInvoice(state, id);
    if (inv.status !== 'sent') throw new Error('Only a sent invoice can have expected income.');
    const cur = inv.incomeId && list(state, 'entries').find((e) => e.id === inv.incomeId);
    if (cur) throw new Error('This invoice already has an income entry.');
    const total = invoiceTotal(inv);
    if (total <= 0) throw new Error('The invoice total must be more than zero.');
    const e = L.metrics.validateEntry({ domain: 'money', type: 'income', date: inv.issueDate, title: 'Invoice ' + inv.number, value: total / 100, status: 'expected', dueDate: inv.dueDate, projectId: inv.projectId || undefined, scope: 'business' });
    e.id = L.store.newId();
    state.entries.push(e);
    inv.incomeId = e.id;
    return e;
  }
  function markPaid(state, id, paidOn) {
    const inv = findInvoice(state, id);
    if (inv.status !== 'sent' && inv.status !== 'draft') throw new Error('Only a draft or sent invoice can be marked paid.');
    if (!isDate(paidOn)) throw new Error('Enter the date paid.');
    inv.status = 'paid'; inv.paidOn = paidOn;
    return inv;
  }
  // Offered after "paid": the linked expected income becomes received on the paid date (counted once, when received). With no usable
  // linked income, one received income entry is created. An income already received is never touched or duplicated.
  function settleIncome(state, id) {
    const inv = findInvoice(state, id);
    if (inv.status !== 'paid') throw new Error('Mark the invoice paid first.');
    const cur = inv.incomeId ? list(state, 'entries').find((e) => e.id === inv.incomeId) : null;
    if (cur && cur.type === 'income' && (!cur.status || cur.status === 'received')) throw new Error('This invoice\'s income is already counted.');
    if (cur && cur.status === 'expected') { cur.status = 'received'; cur.date = inv.paidOn; return cur; }
    const total = invoiceTotal(inv);
    if (total <= 0) throw new Error('The invoice total must be more than zero.');
    const e = L.metrics.validateEntry({ domain: 'money', type: 'income', date: inv.paidOn, title: 'Invoice ' + inv.number, value: total / 100, projectId: inv.projectId || undefined, scope: 'business' });
    e.id = L.store.newId();
    state.entries.push(e);
    inv.incomeId = e.id;
    return e;
  }
  // Void: the invoice keeps its record, loses its link to the income entry (which is never deleted) and frees its billed expenses.
  function voidInvoice(state, id) {
    const inv = findInvoice(state, id);
    if (inv.status === 'void') throw new Error('Already void.');
    if (inv.status === 'paid') throw new Error('A paid invoice cannot be voided.');
    delete inv.incomeId;
    for (const l of inv.lines) if (l.expenseId) unbill(state, l.expenseId, id);
    inv.status = 'void';
    return inv;
  }
  function deleteInvoice(state, id) {
    const inv = findInvoice(state, id);
    if (inv.status === 'sent' || inv.status === 'paid') throw new Error('Void a sent invoice instead of deleting it.');
    for (const l of inv.lines) if (l.expenseId) unbill(state, l.expenseId, id);
    state.invoices = state.invoices.filter((x) => x.id !== id);
  }
  // Aging of open (sent) invoices on a date: current, 1 to 30, 31 to 60, 61 to 90 and over 90 days past the due date.
  const bucketOf = (past) => (past <= 0 ? 'current' : past <= 30 ? 'd1_30' : past <= 60 ? 'd31_60' : past <= 90 ? 'd61_90' : 'over90');
  function aging(state, today) {
    const out = { buckets: {}, openCount: 0, openCents: 0, overdueCount: 0, overdueCents: 0 };
    for (const [k] of BUCKETS) out.buckets[k] = { count: 0, cents: 0 };
    for (const i of list(state, 'invoices')) {
      if (i.status !== 'sent') continue;
      const c = invoiceTotal(i), b = out.buckets[bucketOf(days(today, i.dueDate))];
      b.count++; b.cents += c; out.openCount++; out.openCents += c;
      if (i.dueDate < today) { out.overdueCount++; out.overdueCents += c; }
    }
    return out;
  }
  // ---- trips ----
  function cleanTrips(l, projects) {
    if (l === undefined || l === null) return [];
    const seen = new Set();
    return V().arr(l, TRIP_CAP, 'trips').map((x) => {
      if (!V().isObj(x)) V().fail('trip');
      const id = V().str(x.id, 100, 'trip id');
      if (seen.has(id)) V().fail('duplicate trip id');
      seen.add(id);
      const m = V().num(x.miles, 0.1, 9999.9, 'miles');
      if (Math.round(m * 10) / 10 !== m) V().fail('miles allows one decimal');
      const o = { id, date: reqDate(x.date, 'trip date'), from: text(x.from, 120, 'trip from', true), to: text(x.to, 120, 'trip to', true), miles: m, purpose: text(x.purpose, 200, 'trip purpose', true) };
      if (x.projectId !== undefined && x.projectId !== null && x.projectId !== '') o.projectId = V().str(x.projectId, 100, 'trip line of work');
      o.roundTrip = V().bool(x.roundTrip, 'roundTrip', false);
      return o;
    });
  }
  function addTrip(state, input) {
    if (list(state, 'trips').length >= TRIP_CAP) throw new Error('You can keep up to ' + TRIP_CAP + ' trips');
    if (!input || typeof input !== 'object') throw new Error('Enter a trip.');
    noSecrets([input.from, input.to, input.purpose]);
    const m = typeof input.miles === 'string' ? Number(input.miles.trim()) : input.miles;
    const o = { id: L.store.newId(), date: input.date, from: input.from || '', to: input.to || '', miles: m, purpose: input.purpose || '', roundTrip: !!input.roundTrip };
    if (input.projectId) o.projectId = input.projectId;
    const clean = cleanTrips([o])[0];
    state.trips = list(state, 'trips').concat([clean]);
    return clean;
  }
  function deleteTrip(state, id) {
    if (!list(state, 'trips').some((x) => x.id === id)) throw new Error('Trip not found');
    state.trips = state.trips.filter((x) => x.id !== id);
  }
  function setHomeOffice(state, year, input) {
    const x = T().cleanHomeOffice({ [String(year)]: input })[String(year)];
    if (!state.homeOffice) state.homeOffice = {};
    state.homeOffice[String(year)] = x;
    return x;
  }

  // ---- project budgets ----
  function setBudget(state, projectId, cents, period) {
    const p = list(state, 'projects').find((x) => x.id === projectId);
    if (!p) throw new Error('Line of work not found');
    if (!cents) { delete p.budgetCents; delete p.budgetPeriod; return p; }
    if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_CENTS) throw new Error('Enter a budget amount.');
    if (!BUDGET_PERIODS.includes(period)) throw new Error('Choose a month or project budget.');
    p.budgetCents = cents; p.budgetPeriod = period;
    return p;
  }
  // Budget vs actual for one project. Actual = the project's expenses (all of them, business or personal): this month for a monthly
  // budget, all time for a project budget. status is a colour class only: none, ok or over.
  function budgetFor(state, projectId, today, ids) {
    const p = list(state, 'projects').find((x) => x.id === projectId);
    if (!p) return null;
    const set = new Set(ids || [projectId]), mo = today.slice(0, 7);
    return budgetRow(state, p, p.budgetCents === undefined ? null : p.budgetCents, p.budgetPeriod || null, set, mo);
  }
  function budgetRow(state, p, budget, period, set, mo) {
    let actual = 0;
    for (const e of list(state, 'entries')) if (e.domain === 'money' && e.type === 'expense' && e.projectId && set.has(e.projectId) && (period !== 'month' || e.date.slice(0, 7) === mo)) actual += centsOf(e.value);
    // SEC-86: a project budget counts all time, so the expenses of archived years come back from the yearly summaries.
    if (period !== 'month' && L.archive) for (const m of L.archive.archivedMonths(state)) { const rm = L.archive.revenueMonth(state, m); for (const k of Object.keys(rm || {})) if (k && set.has(k)) actual += rm[k][1]; }
    return { projectId: p.id, budgetCents: budget, period, actualCents: actual, remainingCents: budget === null ? null : budget - actual, status: budget === null ? 'none' : actual > budget ? 'over' : 'ok' };
  }
  // A parent's rollup counts its own and its children's expenses against the parent's budget; with none, against the children's
  // budgets added together when they all share one period (otherwise there is no rollup budget).
  function budgetRollup(state, parentId, today) {
    const ps = list(state, 'projects'), par = ps.find((x) => x.id === parentId);
    if (!par) return null;
    const kids = ps.filter((x) => x.parentId === parentId), set = new Set([parentId].concat(kids.map((k) => k.id))), mo = today.slice(0, 7);
    if (par.budgetCents !== undefined) return budgetRow(state, par, par.budgetCents, par.budgetPeriod, set, mo);
    const withB = kids.filter((k) => k.budgetCents !== undefined), periods = new Set(withB.map((k) => k.budgetPeriod));
    if (!withB.length || periods.size !== 1) return budgetRow(state, par, null, null, set, mo);
    return budgetRow(state, par, sum(withB.map((k) => k.budgetCents)), withB[0].budgetPeriod, set, mo);
  }

  // ---- digest: open invoice numbers (the tax numbers come from tax.digest) ----
  function digest(state, ws) {
    const we = L.metrics.addDays(ws, 6), a = aging(state, we);
    const o = { openInvoices: a.openCount, openInvoiceCents: a.openCents, overdueInvoices: a.overdueCount };
    const t = T().digest(state, ws);
    if (t) o.tax = t;
    return o;
  }

  L.business = {
    BUSINESS_KINDS, INVOICE_STATES, BUDGET_PERIODS, BUCKETS, DEFAULT_FORMAT, INVOICE_CAP, TRIP_CAP, PAYEE_CAP, LINE_CAP,
    isBusinessLine, defaultScope, scopeOf, isBiz, scopeCounts, confirmScope, setScope, defaultSettings, cleanSettings, saveSettings,
    cleanPayees, addPayee, updatePayee, deletePayee, assignPayee,
    lineTotal, invoiceTotal, cleanInvoices, formatNumber, nextNumber, createInvoice, editDraft, unbilled, addBillable, markSent, createExpectedIncome, markPaid, settleIncome, voidInvoice, deleteInvoice, aging, bucketOf,
    cleanTrips, addTrip, deleteTrip, setHomeOffice, setBudget, budgetFor, budgetRollup, digest,
  };
})();
