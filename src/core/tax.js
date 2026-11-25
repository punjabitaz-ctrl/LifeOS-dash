(function () {
  'use strict';
  // v1.1.0: tax estimates for a single-member LLC taxed like a sole proprietor (Schedule C, self-employment tax, federal and NJ
  // estimates). Pure functions over state; nothing here posts anything. Every rate, threshold, date and holiday comes from the
  // tax-year profile in state.taxYears; the only numbers in this file are the 2026 profile DEFAULTS and the Schedule C line list.
  // Money is integer cents. Rates are held as parts per million (exact integers) and every product is a BigInt, so there is no
  // floating point in any figure.
  // ROUNDING RULE (one rule everywhere): a figure is the exact rational result rounded to a whole cent, half away from zero, at the
  // moment it is produced, and later figures use the rounded value. Meals are rounded per entry, mileage per trip, the home office
  // once, SE tax in its three parts (Social Security, Medicare, additional Medicare), income tax estimates once each, installments
  // by splitting the target into four with the remainder cents going to the earliest quarters.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const V = () => L.validate;

  const NOTICE = 'Estimate. Numbers only, not tax advice. Confirm with your accountant.';
  const BLOCK_MESSAGE = 'Open the private vault to see tax figures.';
  const PAYMENT_CAP = 2000, YEAR_CAP = 30, MAP_CAP = 100, MAX_CENTS = 1e13;
  const FILING = Object.freeze(['single', 'mfj', 'mfs', 'hoh']);
  const FILING_LABEL = Object.freeze({ single: 'Single', mfj: 'Married filing jointly', mfs: 'Married filing separately', hoh: 'Head of household' });
  const JURISDICTIONS = Object.freeze(['federal', 'nj']);

  // Schedule C lines. `car` and `homeOffice` are filled from the mileage and home-office logs only (no category can map to them).
  const LINES = Object.freeze([
    { id: 'advertising', label: 'Advertising', sc: '8', cat: 'Advertising' },
    { id: 'car', label: 'Car and truck (mileage log)', sc: '9', log: true },
    { id: 'contract', label: 'Contract labor', sc: '11', cat: 'Contract labor' },
    { id: 'insurance', label: 'Insurance', sc: '15', cat: 'Insurance' },
    { id: 'legal', label: 'Legal and professional services', sc: '17', cat: 'Legal and professional' },
    { id: 'office', label: 'Office expense', sc: '18', cat: 'Office expense' },
    { id: 'rent', label: 'Rent or lease', sc: '20', cat: 'Rent' },
    { id: 'supplies', label: 'Supplies', sc: '22', cat: 'Supplies' },
    { id: 'travel', label: 'Travel', sc: '24a', cat: 'Travel' },
    { id: 'meals', label: 'Meals', sc: '24b', cat: 'Meals', pct: true },
    { id: 'utilities', label: 'Utilities', sc: '25', cat: 'Utilities' },
    { id: 'other', label: 'Other expenses', sc: '27a', cat: 'Software and subscriptions' },
    { id: 'homeOffice', label: 'Home office (home-office log)', sc: '30', log: true },
  ]);
  const LINE_IDS = LINES.map((x) => x.id);
  const MAPPABLE = LINES.filter((x) => !x.log).map((x) => x.id);
  // Category names offered as business categories; each maps to its line by name (case insensitive) until the user maps it otherwise.
  const DEFAULT_CATEGORY_LINES = Object.freeze([
    ['Advertising', 'advertising'], ['Contract labor', 'contract'], ['Insurance', 'insurance'], ['Legal and professional', 'legal'],
    ['Office expense', 'office'], ['Rent', 'rent'], ['Supplies', 'supplies'], ['Travel', 'travel'], ['Meals', 'meals'], ['Utilities', 'utilities'],
    ['Software and subscriptions', 'other'], ['Education', 'other'], ['Bank and payment fees', 'other'],
  ]);
  const lineById = (id) => LINES.find((x) => x.id === id);

  // ---- exact arithmetic ----
  function mulDiv(a, b, d) {
    if (![a, b, d].every(Number.isSafeInteger) || d === 0) throw new Error('Invalid amount');
    let n = BigInt(a) * BigInt(b), dd = BigInt(d);
    const neg = n !== 0n && (n < 0n) !== (dd < 0n);
    if (n < 0n) n = -n;
    if (dd < 0n) dd = -dd;
    const q = (2n * n + dd) / (2n * dd);
    return Number(neg ? -q : q);
  }
  const ppm = (r) => Math.round(r * 1e6);
  const centsOf = (v) => Math.round(Number(v) * 100);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const isDate = (s) => L.home.dates.isDate(s);
  const addDays = (s, n) => L.home.dates.addDays(s, n);
  const yearOfDate = (d) => Number(String(d).slice(0, 4));
  const weekday = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))).getUTCDay();

  // ---- 2026 profile defaults (the only place tax numbers live besides tests) ----
  const THRESHOLD_BY_STATUS = Object.freeze({ single: 20000000, hoh: 20000000, mfj: 25000000, mfs: 12500000 });
  // SEC-73: no SE tax when net earnings from self-employment are under $400 (IRS Schedule SE instructions; Internal Revenue Code
  // section 6017). A profile value, so a later year can change it.
  const SE_MIN_DEFAULT = 40000;
  const SE_MIN_NOTE = 'No self-employment tax when net earnings from self-employment are under $400 (Schedule SE instructions).';
  const THRESHOLD_NOTE = 'Additional Medicare Tax threshold by filing status (single and head of household $200,000, married filing jointly $250,000, married filing separately $125,000).';
  const DEFAULT_HOLIDAYS_2026 = Object.freeze(['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15']);
  function defaultProfile(year) {
    if (year !== 2026) return null;
    return {
      filingStatus: 'single',
      seRate: 0.153, ssRate: 0.124, medicareRate: 0.029, addlMedicareRate: 0.009, seFactor: 0.9235,
      ssWageBase: 18450000, otherSsEarningsCents: 0, seMinNetEarningsCents: SE_MIN_DEFAULT,
      addlMedicareThreshold: THRESHOLD_BY_STATUS.single,
      mileageRates: [
        { from: '2026-01-01', centsPerMile: 72.5, note: 'IRS Notice 2026-10' },
        { from: '2026-07-01', centsPerMile: 76, note: 'IRS Announcement 2026-11' },
      ],
      homeOfficeRate: 500, homeOfficeMaxSqFt: 300,
      nec1099Threshold: 200000, nec1099Due: '2027-01-31',
      mealsPct: 50, seDeductionPct: 50,
      safeHarbor: { federalCurrentPct: 90, federalPriorPct: 100, federalPriorHighPct: 110, njCurrentPct: 80, njPriorPct: 100 },
      federalEffectiveRate: null, njEffectiveRate: null,
      priorYearFederalTax: null, priorYearNjTax: null, priorYearAgiOver150k: false,
      dueDates: { federal: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'], nj: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'] },
      holidays: DEFAULT_HOLIDAYS_2026.slice(),
      sourceNote: '2026 defaults: Social Security wage base $184,500; mileage 72.5 cents from 2026-01-01 (IRS Notice 2026-10) and 76 cents from 2026-07-01 (IRS Announcement 2026-11); 1099-NEC threshold $2,000; estimate dates April 15, June 15, September 15 and January 15, moved past weekends and listed holidays. ' + THRESHOLD_NOTE + ' ' + SE_MIN_NOTE + ' Effective income tax rates are yours to enter.',
    };
  }

  // ---- profile validation (whitelist; every field typed and ranged) ----
  const rate = (v, name) => {
    const n = V().num(v, 0, 1, name);
    if (Math.round(n * 1e6) / 1e6 !== n) V().fail(name + ' has too many decimals');
    return n;
  };
  const optRate = (v, name) => (v === undefined || v === null || v === '' ? null : rate(v, name));
  const cents = (v, name, max) => V().num(v, 0, max || MAX_CENTS, name, true);
  const optCents = (v, name) => (v === undefined || v === null || v === '' ? null : cents(v, name));
  const reqDate = (v, name) => { const d = V().date(v, name); if (!isDate(d)) V().fail(name + ' is out of range'); return d; };
  function cleanMileageRates(list) {
    if (!Array.isArray(list)) V().fail('mileage rates must be a list');
    if (list.length > 24) V().fail('mileage rates has too many items');
    const seen = new Set(), out = list.map((x) => {
      if (!V().isObj(x)) V().fail('mileage rate');
      const from = reqDate(x.from, 'mileage rate start');
      if (seen.has(from)) V().fail('two mileage rates start on the same date');
      seen.add(from);
      const c = V().num(x.centsPerMile, 0, 1000, 'cents per mile');
      if (Math.round(c * 10) / 10 !== c) V().fail('cents per mile allows one decimal');
      const o = { from, centsPerMile: c };
      if (x.note !== undefined && x.note !== '') o.note = V().str(V().strip(String(x.note)).trim(), 200, 'mileage rate note', true);
      return o;
    });
    return out.sort((a, b) => a.from.localeCompare(b.from));
  }
  function cleanDates4(l, name) {
    if (!Array.isArray(l) || l.length !== 4) V().fail(name + ' needs four dates');
    return l.map((d) => reqDate(d, name));
  }
  const SAFE_KEYS = Object.freeze(['federalCurrentPct', 'federalPriorPct', 'federalPriorHighPct', 'njCurrentPct', 'njPriorPct']);
  function cleanSafe(x) {
    if (!V().isObj(x)) V().fail('safe harbor');
    const o = {};
    for (const k of SAFE_KEYS) o[k] = V().num(x[k], 0, 1000, 'safe harbor ' + k, true);
    return o;
  }
  function cleanProfile(x) {
    if (!V().isObj(x)) V().fail('tax year profile');
    const st = V().oneOf(x.filingStatus === undefined ? 'single' : x.filingStatus, FILING, 'filing status');
    const o = {
      filingStatus: st,
      seRate: rate(x.seRate, 'seRate'), ssRate: rate(x.ssRate, 'ssRate'), medicareRate: rate(x.medicareRate, 'medicareRate'), addlMedicareRate: rate(x.addlMedicareRate, 'addlMedicareRate'),
      seFactor: rate(x.seFactor, 'seFactor'),
      ssWageBase: cents(x.ssWageBase, 'ssWageBase'), otherSsEarningsCents: x.otherSsEarningsCents === undefined ? 0 : cents(x.otherSsEarningsCents, 'otherSsEarningsCents'),
      seMinNetEarningsCents: x.seMinNetEarningsCents === undefined || x.seMinNetEarningsCents === null ? SE_MIN_DEFAULT : cents(x.seMinNetEarningsCents, 'seMinNetEarningsCents'),
      addlMedicareThreshold: x.addlMedicareThreshold === undefined || x.addlMedicareThreshold === null ? THRESHOLD_BY_STATUS[st] : cents(x.addlMedicareThreshold, 'addlMedicareThreshold'),
      mileageRates: cleanMileageRates(x.mileageRates === undefined ? [] : x.mileageRates),
      homeOfficeRate: cents(x.homeOfficeRate, 'homeOfficeRate', 1e7), homeOfficeMaxSqFt: V().num(x.homeOfficeMaxSqFt, 0, 100000, 'homeOfficeMaxSqFt', true),
      nec1099Threshold: cents(x.nec1099Threshold, 'nec1099Threshold'), nec1099Due: reqDate(x.nec1099Due, 'nec1099Due'),
      mealsPct: V().num(x.mealsPct, 0, 100, 'mealsPct', true),
      seDeductionPct: V().num(x.seDeductionPct, 0, 100, 'seDeductionPct', true),
      safeHarbor: cleanSafe(x.safeHarbor),
      federalEffectiveRate: optRate(x.federalEffectiveRate, 'federalEffectiveRate'), njEffectiveRate: optRate(x.njEffectiveRate, 'njEffectiveRate'),
      priorYearFederalTax: optCents(x.priorYearFederalTax, 'priorYearFederalTax'), priorYearNjTax: optCents(x.priorYearNjTax, 'priorYearNjTax'),
      priorYearAgiOver150k: V().bool(x.priorYearAgiOver150k, 'priorYearAgiOver150k', false),
    };
    if (ppm(o.seRate) !== ppm(o.ssRate) + ppm(o.medicareRate)) V().fail('seRate must equal ssRate plus medicareRate');
    if (!V().isObj(x.dueDates)) V().fail('due dates');
    o.dueDates = { federal: cleanDates4(x.dueDates.federal, 'federal due dates'), nj: cleanDates4(x.dueDates.nj, 'NJ due dates') };
    const hs = x.holidays === undefined ? [] : x.holidays;
    if (!Array.isArray(hs) || hs.length > 80) V().fail('holidays');
    o.holidays = Array.from(new Set(hs.map((d) => reqDate(d, 'holiday')))).sort();
    o.sourceNote = V().str(V().strip(x.sourceNote === undefined ? '' : String(x.sourceNote)).trim(), 1200, 'source note', true);
    return o;
  }
  function cleanTaxYears(m) {
    if (m === undefined || m === null) return {};
    if (!V().isObj(m)) V().fail('tax years');
    const keys = Object.keys(m);
    if (keys.length > YEAR_CAP) V().fail('tax years has too many items');
    const out = {};
    for (const k of keys.sort()) {
      if (!/^\d{4}$/.test(k) || +k < 1990 || +k > 2200) V().fail('tax year');
      out[k] = cleanProfile(m[k]);
    }
    return out;
  }
  function cleanHomeOffice(m) {
    if (m === undefined || m === null) return {};
    if (!V().isObj(m)) V().fail('home office');
    const keys = Object.keys(m);
    if (keys.length > YEAR_CAP) V().fail('home office has too many items');
    const out = {};
    for (const k of keys.sort()) {
      if (!/^\d{4}$/.test(k) || +k < 1990 || +k > 2200) V().fail('home office year');
      const x = m[k];
      if (!V().isObj(x)) V().fail('home office');
      out[k] = { squareFeet: V().num(x.squareFeet, 0, 100000, 'square feet', true), monthsUsed: V().num(x.monthsUsed, 0, 12, 'months used', true) };
    }
    return out;
  }
  function cleanTaxMap(list) {
    if (list === undefined || list === null) return [];
    const seen = new Set();
    return V().arr(list, MAP_CAP, 'tax line map').map((x) => {
      if (!V().isObj(x)) V().fail('tax line map item');
      const category = V().str(V().strip(x.category).trim(), 40, 'tax line category');
      if (seen.has(category.toLowerCase())) V().fail('duplicate tax line category');
      seen.add(category.toLowerCase());
      return { category, line: V().oneOf(x.line, MAPPABLE, 'tax line') };
    });
  }
  function cleanPayments(list) {
    if (list === undefined || list === null) return [];
    const seen = new Set();
    return V().arr(list, PAYMENT_CAP, 'tax payments').map((x) => {
      if (!V().isObj(x)) V().fail('tax payment');
      const id = V().str(x.id, 100, 'tax payment id');
      if (seen.has(id)) V().fail('duplicate tax payment id');
      seen.add(id);
      const o = {
        id, year: V().num(x.year, 1990, 2200, 'payment year', true), jurisdiction: V().oneOf(x.jurisdiction, JURISDICTIONS, 'jurisdiction'),
        quarter: V().num(x.quarter, 1, 4, 'quarter', true), amountCents: V().num(x.amountCents, 1, MAX_CENTS, 'payment amount', true), paidOn: reqDate(x.paidOn, 'paid on'),
      };
      if (x.confirmation !== undefined && x.confirmation !== '') o.confirmation = V().str(V().strip(String(x.confirmation)).trim(), 100, 'confirmation', true);
      return o;
    });
  }

  // ---- profile access ----
  const profileOf = (state, year) => (state && state.taxYears && state.taxYears[String(year)]) || null;
  const years = (state) => Object.keys((state && state.taxYears) || {}).map(Number).sort((a, b) => a - b);

  // ---- private vault refusal (amendment item 6) ----
  // A closed private vault that holds a business record of the year, or a private record that a public business record of the year
  // belongs to, makes every tax figure refuse: its marks say so with 'business-YYYY' (see priv.bizMarks, SEC-76). 'business' (any year)
  // comes only from older copies. A view (vault open) has every record, so nothing is hidden. The digest always passes the main state,
  // so it refuses whenever such records exist.
  function blocked(state, year) {
    if (!state) return false;
    // v1.2.0 part B: the year's entries, invoices, trips and payments are in its archive file; the figures come from opening it.
    if (L.archive && L.archive.isArchivedYear(state, year)) return true;
    if (L.priv && L.priv.isView && L.priv.isView(state)) return false;
    const m = state.priv && Array.isArray(state.priv.marks) ? state.priv.marks : [];
    if (m.includes('business') || m.includes('business-' + year)) return true;
    // SEC-83: a public money entry may keep the id of a private line of work while closed (PV-2). Its scope could come from that line,
    // so its year refuses too.
    if (!m.includes('projects')) return false;
    const pids = new Set((state.projects || []).map((p) => p.id)), ys = String(year);
    return (state.entries || []).some((e) => isMoney(e) && e.projectId && !pids.has(e.projectId) && e.date.slice(0, 4) === ys);
  }
  const ARCHIVED_MESSAGE = 'This tax year is archived. Open its archive (Settings, Archive) to see it or to make the accountant export.';
  const refusal = (year, state) => ({ blocked: true, year, message: state && L.archive && L.archive.isArchivedYear(state, year) ? ARCHIVED_MESSAGE : BLOCK_MESSAGE, notice: NOTICE });

  // ---- due dates ----
  function shiftDue(nominal, holidays) {
    const hs = new Set(holidays || []);
    let d = nominal;
    for (let i = 0; i < 40; i++) { const w = weekday(d); if (w !== 0 && w !== 6 && !hs.has(d)) return d; d = addDays(d, 1); }
    return d;
  }
  function dueDates(profile) {
    const mk = (l) => l.map((n, i) => ({ quarter: i + 1, nominal: n, date: shiftDue(n, profile.holidays) }));
    return { federal: mk(profile.dueDates.federal), nj: mk(profile.dueDates.nj), nec1099: { nominal: profile.nec1099Due, date: shiftDue(profile.nec1099Due, profile.holidays) } };
  }

  // ---- tax line mapping ----
  function lineFor(state, category) {
    if (!category) return null;
    const k = String(category).trim().toLowerCase();
    const m = (state.taxMap || []).find((x) => x.category.toLowerCase() === k);
    if (m) return m.line;
    const d = DEFAULT_CATEGORY_LINES.find((x) => x[0].toLowerCase() === k);
    return d ? d[1] : null;
  }

  // ---- mileage and home office ----
  function rateFor(profile, date) {
    let r = null;
    for (const x of profile.mileageRates) if (x.from <= date) r = x;
    return r;
  }
  // Deduction for one trip in cents: miles (one decimal, doubled for a round trip) times the rate in force on the trip date.
  // Miles in tenths times cents per mile in tenths, over 100, rounded half away from zero. null when no rate covers the date.
  function tripCents(profile, trip) {
    const r = rateFor(profile, trip.date);
    if (!r) return null;
    const tenthsMiles = Math.round(trip.miles * 10) * (trip.roundTrip ? 2 : 1);
    return mulDiv(tenthsMiles, Math.round(r.centsPerMile * 10), 100);
  }
  function homeOfficeCents(profile, ho) {
    if (!ho || !ho.squareFeet || !ho.monthsUsed) return 0;
    return mulDiv(Math.min(ho.squareFeet, profile.homeOfficeMaxSqFt) * profile.homeOfficeRate, ho.monthsUsed, 12);
  }

  // ---- self-employment tax ----
  // Net earnings = profit x seFactor. None at all when profit is not positive or net earnings are under the profile minimum ($400).
  // Social Security: ssRate on the lesser of net earnings and the room left under the wage base after other (W-2) earnings.
  // Medicare: medicareRate on all net earnings. Additional Medicare: addlMedicareRate on net earnings above the filing-status threshold
  // reduced by the W-2 wages already counted (floored at 0); SEC-72.
  // SEC-71: the deduction for half of SE tax covers the Social Security and Medicare parts only. Additional Medicare Tax is not part of
  // it and is not deductible.
  function seTax(profile, profitCents) {
    const room = Math.max(0, profile.ssWageBase - profile.otherSsEarningsCents);
    const z = { netEarningsCents: 0, ssCents: 0, medicareCents: 0, addlCents: 0, totalCents: 0, deductionCents: 0, ssRoomCents: room, addlThresholdCents: 0, belowMinimum: false };
    if (!(profitCents > 0)) return z;
    const net = mulDiv(profitCents, ppm(profile.seFactor), 1e6);
    const min = profile.seMinNetEarningsCents === undefined ? SE_MIN_DEFAULT : profile.seMinNetEarningsCents;
    if (net < min) return Object.assign(z, { netEarningsCents: net, belowMinimum: true });
    const ssBase = Math.min(net, room);
    const ss = mulDiv(ssBase, ppm(profile.ssRate), 1e6), med = mulDiv(net, ppm(profile.medicareRate), 1e6);
    const threshold = Math.max(0, profile.addlMedicareThreshold - profile.otherSsEarningsCents);
    const addl = mulDiv(Math.max(0, net - threshold), ppm(profile.addlMedicareRate), 1e6);
    const total = ss + med + addl;
    return { netEarningsCents: net, ssCents: ss, medicareCents: med, addlCents: addl, totalCents: total, deductionCents: mulDiv(ss + med, profile.seDeductionPct, 100), ssRoomCents: room, addlThresholdCents: threshold, belowMinimum: false };
  }

  // ---- the year's business figures ----
  const isMoney = (e) => e.domain === 'money' && (e.type === 'income' || e.type === 'expense');
  const bizTest = (state) => { const b = L.business.isBiz(state); return (e) => isMoney(e) && b(e); };
  const counted = (e) => e.type === 'expense' || !e.status || e.status === 'received';
  function collect(state, year) {
    const profile = profileOf(state, year), ys = String(year);
    const biz = bizTest(state), rows = (state.entries || []).filter((e) => biz(e) && e.date.slice(0, 4) === ys);
    const income = [], expense = [];
    for (const e of rows) {
      if (e.type === 'income') { if (counted(e)) income.push({ e, cents: centsOf(e.value) }); continue; }
      const line = lineFor(state, e.category), pct = line === 'meals' && profile ? profile.mealsPct : 100, gross = centsOf(e.value);
      expense.push({ e, line, grossCents: gross, cents: pct === 100 ? gross : mulDiv(gross, pct, 100) });
    }
    const trips = (state.trips || []).filter((t) => t.date.slice(0, 4) === ys).map((t) => ({ t, cents: profile ? tripCents(profile, t) : null }));
    return { profile, income, expense, trips };
  }

  function compute(state, year) {
    if (blocked(state, year)) return refusal(year, state);
    const profile = profileOf(state, year);
    const c = collect(state, year);
    const incomeCents = sum(c.income.map((x) => x.cents));
    const byLine = {};
    for (const l of LINES) byLine[l.id] = { id: l.id, label: l.label, sc: l.sc, cents: 0, grossCents: 0, count: 0 };
    const unmapped = { cents: 0, grossCents: 0, count: 0 };
    for (const x of c.expense) {
      const b = x.line ? byLine[x.line] : unmapped;
      b.cents += x.cents; b.grossCents += x.grossCents; b.count++;
    }
    const unrated = c.trips.filter((x) => x.cents === null).length;
    const mileageCents = sum(c.trips.map((x) => x.cents || 0));
    byLine.car.cents = mileageCents; byLine.car.count = c.trips.length;
    const ho = (state.homeOffice || {})[String(year)];
    const expenseCents = sum(c.expense.map((x) => x.cents));
    // SEC-74: the simplified home-office deduction cannot exceed the business's gross income less its other business expenses (it can
    // never create or increase a loss, and the simplified method has no carryover).
    const homeFull = profile ? homeOfficeCents(profile, ho) : 0;
    const homeCents = Math.min(homeFull, Math.max(0, incomeCents - expenseCents - mileageCents));
    byLine.homeOffice.cents = homeCents; byLine.homeOffice.count = homeCents ? 1 : 0;
    const profitCents = incomeCents - expenseCents - mileageCents - homeCents;
    // Reimbursed totals are informational only: reimbursable expenses billed on a paid invoice. Nothing is netted.
    const paid = new Set((state.invoices || []).filter((i) => i.status === 'paid').map((i) => i.id));
    const reimbursedCents = sum(c.expense.filter((x) => x.e.reimbursable && x.e.billedInvoiceId && paid.has(x.e.billedInvoiceId)).map((x) => x.grossCents));
    const out = { blocked: false, year, notice: NOTICE, hasProfile: !!profile, incomeCents, expenseCents, mileageCents, homeOfficeCents: homeCents, homeOfficeFullCents: homeFull, homeOfficeLimited: homeCents < homeFull, profitCents, unmapped, lines: LINES.map((l) => byLine[l.id]), reimbursedCents, unratedTrips: unrated, tripCount: c.trips.length };
    out.byLineOfWork = lineBreakdown(state, c, year, profile, homeCents);
    if (!profile) return out;
    out.se = seTax(profile, profitCents);
    const base = Math.max(0, profitCents - out.se.deductionCents);
    out.incomeBaseCents = base;
    out.federalTaxCents = profile.federalEffectiveRate === null ? null : mulDiv(base, ppm(profile.federalEffectiveRate), 1e6);
    // SEC-75: NJ does not allow the federal deduction for half of SE tax; its base is the business profit itself (floored at 0).
    out.njBaseCents = Math.max(0, profitCents);
    out.njTaxCents = profile.njEffectiveRate === null ? null : mulDiv(out.njBaseCents, ppm(profile.njEffectiveRate), 1e6);
    out.needRates = profile.federalEffectiveRate === null || profile.njEffectiveRate === null;
    out.setAsideCents = out.needRates ? null : out.se.totalCents + out.federalTaxCents + out.njTaxCents;
    // SEC-77: a private account or balance entry may be (or belong to) the reserve; while closed the reserve is hidden, never guessed.
    out.reserveHidden = reserveHidden(state);
    const reserve = out.reserveHidden ? null : reserveBalance(state);
    out.reserveCents = reserve;
    out.gapCents = out.setAsideCents === null || reserve === null ? null : out.setAsideCents - reserve;
    out.payments = paymentTotals(state, year);
    out.safeHarbor = safeHarbor(state, year, out);
    out.due = dueDates(profile);
    return out;
  }
  function reserveHidden(state) {
    if (!state || (L.priv && L.priv.isView && L.priv.isView(state))) return false;
    const id = state.settings && state.settings.business && state.settings.business.reserveAccountId;
    const m = state.priv && Array.isArray(state.priv.marks) ? state.priv.marks : [];
    return !!id && (m.includes('business-reserve') || m.includes('business'));
  }
  function reserveBalance(state) {
    const id = state.settings && state.settings.business && state.settings.business.reserveAccountId;
    if (!id) return null;
    const a = (state.accounts || []).find((x) => x.id === id);
    if (!a) return null;
    // latest balance entry of the account (a liability account shows its balance as typed)
    let best = null;
    for (const e of state.entries || []) if (e.type === 'balance' && e.accountId === id && (!best || e.date >= best.date)) best = e;
    return best ? centsOf(best.value) : null;
  }
  function paymentTotals(state, year) {
    const o = { federal: 0, nj: 0, byQuarter: { federal: [0, 0, 0, 0], nj: [0, 0, 0, 0] } };
    for (const p of state.taxPayments || []) if (p.year === year) { o[p.jurisdiction] += p.amountCents; o.byQuarter[p.jurisdiction][p.quarter - 1] += p.amountCents; }
    return o;
  }
  // Split a target into four installments; the remainder cents go to the earliest quarters, so the four always add up exactly.
  function installments(target) {
    const q = Math.floor(target / 4), r = target - q * 4;
    return [0, 1, 2, 3].map((i) => q + (i < r ? 1 : 0));
  }
  // Safe-harbor targets, shown only when the prior-year figure of that jurisdiction is entered.
  // Federal: 100% of prior-year tax (110% when the prior-year AGI flag is set), compared with 90% of the current estimate (income tax
  // plus SE tax). NJ: the smaller of 80% of the current-year tax or 100% of prior-year tax. The target is the smaller figure of the
  // two that are known; with no rate entered the current-year side is "set your rate" and the target is the prior-year side.
  function safeHarbor(state, year, c) {
    const p = profileOf(state, year), out = { federal: null, nj: null };
    if (!p) return out;
    if (p.priorYearFederalTax !== null) {
      const sh = p.safeHarbor;
      const prior = mulDiv(p.priorYearFederalTax, p.priorYearAgiOver150k ? sh.federalPriorHighPct : sh.federalPriorPct, 100);
      const cur = c.federalTaxCents === null ? null : mulDiv(c.se.totalCents + c.federalTaxCents, sh.federalCurrentPct, 100);
      const target = cur === null ? prior : Math.min(prior, cur);
      out.federal = { priorBasedCents: prior, currentBasedCents: cur, targetCents: target, installments: installments(target), paidCents: c.payments.federal, remainingCents: Math.max(0, target - c.payments.federal) };
    }
    if (p.priorYearNjTax !== null) {
      const sh = p.safeHarbor;
      const prior = mulDiv(p.priorYearNjTax, sh.njPriorPct, 100);
      const cur = c.njTaxCents === null ? null : mulDiv(c.njTaxCents, sh.njCurrentPct, 100);
      const target = cur === null ? prior : Math.min(prior, cur);
      out.nj = { priorBasedCents: prior, currentBasedCents: cur, targetCents: target, installments: installments(target), paidCents: c.payments.nj, remainingCents: Math.max(0, target - c.payments.nj) };
    }
    return out;
  }

  // ---- Schedule C per line of work (and per parent rollup) ----
  // Rows: every line of work with business money or trips in the year, then Unassigned (no line, plus the home office). Parent rows
  // are rollups of the lines under them. Each total column adds up exactly to the year's totals.
  function lineBreakdown(state, c, year, profile, homeCents) {
    const rows = new Map();
    const row = (id) => { if (!rows.has(id)) rows.set(id, { projectId: id, incomeCents: 0, expenseCents: 0, mileageCents: 0, homeOfficeCents: 0 }); return rows.get(id); };
    const known = new Set((state.projects || []).map((p) => p.id));
    const key = (pid) => (pid && known.has(pid) ? pid : null);
    for (const x of c.income) row(key(x.e.projectId)).incomeCents += x.cents;
    for (const x of c.expense) row(key(x.e.projectId)).expenseCents += x.cents;
    for (const x of c.trips) row(key(x.t.projectId)).mileageCents += x.cents || 0;
    if (homeCents) row(null).homeOfficeCents += homeCents;
    const lines = [...rows.values()].map((r) => Object.assign(r, { netCents: r.incomeCents - r.expenseCents - r.mileageCents - r.homeOfficeCents }));
    const byId = new Map((state.projects || []).map((p) => [p.id, p]));
    const rollups = [];
    for (const p of state.projects || []) {
      if (p.parentId) continue;
      const kids = lines.filter((r) => r.projectId && byId.get(r.projectId).parentId === p.id), own = lines.find((r) => r.projectId === p.id);
      if (!kids.length) continue;
      const all = (own ? [own] : []).concat(kids), tot = (k) => sum(all.map((r) => r[k]));
      rollups.push({ projectId: p.id, incomeCents: tot('incomeCents'), expenseCents: tot('expenseCents'), mileageCents: tot('mileageCents'), homeOfficeCents: 0, netCents: tot('netCents') });
    }
    const order = (r) => (r.projectId ? (byId.get(r.projectId).name || '') : '￿');
    return { lines: lines.sort((a, b) => order(a).localeCompare(order(b))), rollups: rollups.sort((a, b) => order(a).localeCompare(order(b))) };
  }

  // ---- 1099-NEC payees ----
  // Totals per payee for the year from business contractor expenses (cardPaid expenses are excluded from the 1099 total).
  function payeeTotals(state, year) {
    if (blocked(state, year)) return refusal(year, state);
    const p = profileOf(state, year), ys = String(year), tot = new Map(), card = new Map(), biz = bizTest(state);
    for (const e of state.entries || []) {
      if (!biz(e) || e.type !== 'expense' || !e.payeeId || e.date.slice(0, 4) !== ys) continue;
      const m = e.cardPaid ? card : tot;
      m.set(e.payeeId, (m.get(e.payeeId) || 0) + centsOf(e.value));
    }
    const ids = new Set([...tot.keys(), ...card.keys()]);
    const rows = (state.payees || []).filter((x) => ids.has(x.id)).map((x) => {
      const t = tot.get(x.id) || 0;
      return { payeeId: x.id, totalCents: t, cardCents: card.get(x.id) || 0, reaches: p ? t >= p.nec1099Threshold : false, nearCents: p ? p.nec1099Threshold - t : null, tinOnFile: x.tinOnFile, w9Date: x.w9Date || null };
    }).sort((a, b) => b.totalCents - a.totalCents);
    return { blocked: false, year, hasProfile: !!p, thresholdCents: p ? p.nec1099Threshold : null, rows, due: p ? dueDates(p).nec1099 : null, notice: NOTICE };
  }

  // ---- Admin timeline rows and digest numbers ----
  // Estimated payment dates and the 1099-NEC reminder; omitted for a year the vault refuses (no partial answers).
  function timelineRows(state) {
    const out = [];
    for (const y of years(state)) {
      if (blocked(state, y)) continue;
      const p = profileOf(state, y), d = dueDates(p), paid = paymentTotals(state, y);
      for (const j of JURISDICTIONS) for (const q of d[j]) {
        out.push({ src: 'taxpay', id: 'taxpay:' + j + ':' + y + ':' + q.quarter, title: (j === 'nj' ? 'NJ' : 'Federal') + ' estimated tax, quarter ' + q.quarter + ' of ' + y, kind: 'estimated tax', date: q.date, closed: paid.byQuarter[j][q.quarter - 1] > 0 ? '' : null });
      }
      const pt = payeeTotals(state, y);
      if (!pt.blocked && pt.rows.some((r) => r.reaches)) out.push({ src: 'taxpay', id: 'nec1099:' + y, title: '1099-NEC filing for ' + y, kind: '1099-NEC', date: pt.due.date, closed: null });
    }
    return out;
  }
  // Digest numbers (the only tax numbers that ever leave this module toward a prompt): business profit to date, estimated tax to
  // date, set-aside gap. null when there is no profile for the year or the private vault hides business records.
  function digest(state, ws) {
    const year = yearOfDate(L.metrics.addDays(ws, 6));
    if (blocked(state, year) || !profileOf(state, year)) return null;
    const c = compute(state, year);
    const o = { profitCents: c.profitCents };
    if (c.setAsideCents !== null) o.estimatedTaxCents = c.setAsideCents;
    if (c.gapCents !== null) o.gapCents = c.gapCents;
    return o;
  }

  // ---- new year: offered, never applied ----
  // A proposal copied from the latest profile before `year`, with dates moved one year per year step. Nothing is stored; the user
  // confirms it (applyNewYear) and can edit afterwards.
  function shiftYearStr(d, n) { return String(+d.slice(0, 4) + n).padStart(4, '0') + d.slice(4); }
  function proposeYear(state, year) {
    const ys = years(state).filter((y) => y < year);
    if (!ys.length) return null;
    const from = ys[ys.length - 1], src = profileOf(state, from), n = year - from, p = JSON.parse(JSON.stringify(src));
    p.dueDates.federal = p.dueDates.federal.map((d) => shiftYearStr(d, n)); p.dueDates.nj = p.dueDates.nj.map((d) => shiftYearStr(d, n));
    p.nec1099Due = shiftYearStr(p.nec1099Due, n);
    p.mileageRates = p.mileageRates.map((r) => Object.assign({}, r, { from: shiftYearStr(r.from, n) }));
    p.holidays = p.holidays.map((d) => shiftYearStr(d, n));
    p.priorYearFederalTax = null; p.priorYearNjTax = null;
    p.sourceNote = 'Copied from ' + from + '. Dates moved forward by calendar year; check every rate, threshold, holiday and mileage rate before you rely on this year.';
    return cleanProfile(p);
  }
  function applyNewYear(state, year) {
    if (profileOf(state, year)) throw new Error('That year already has a profile');
    const p = proposeYear(state, year) || (defaultProfile(year) ? cleanProfile(defaultProfile(year)) : null);
    if (!p) throw new Error('There is no earlier profile to copy');
    if (!state.taxYears) state.taxYears = {};
    if (Object.keys(state.taxYears).length >= YEAR_CAP) throw new Error('You can keep up to ' + YEAR_CAP + ' tax years');
    state.taxYears[String(year)] = p;
    return p;
  }

  // ---- mutators (run inside a commit; each follows one user tap) ----
  function setProfile(state, year, input) {
    if (!Number.isInteger(year) || year < 1990 || year > 2200) throw new Error('Enter a tax year.');
    const p = cleanProfile(input);
    if (!state.taxYears) state.taxYears = {};
    if (!profileOf(state, year) && Object.keys(state.taxYears).length >= YEAR_CAP) throw new Error('You can keep up to ' + YEAR_CAP + ' tax years');
    state.taxYears[String(year)] = p;
    return p;
  }
  function startDefaultYear(state, year) {
    const d = defaultProfile(year);
    if (!d) throw new Error('There are no built-in defaults for ' + year);
    return setProfile(state, year, d);
  }
  function setLineMap(state, category, line) {
    const k = String(category || '').trim();
    if (!k) throw new Error('Choose a category.');
    if (line !== '' && line !== null && !MAPPABLE.includes(line)) throw new Error(line === 'car' || line === 'homeOffice' ? 'That line is filled from its log only.' : 'Unknown tax line.');
    const rest = (state.taxMap || []).filter((x) => x.category.toLowerCase() !== k.toLowerCase());
    if (line) rest.push({ category: k, line });
    state.taxMap = cleanTaxMap(rest);
  }
  function addPayment(state, input) {
    if ((state.taxPayments || []).length >= PAYMENT_CAP) throw new Error('You can keep up to ' + PAYMENT_CAP + ' payments');
    if (!input || typeof input !== 'object') throw new Error('Enter a payment.');
    if (L.admin) L.admin.checkNoSecrets([input.confirmation], 'That looks like an ID number or a card number. Do not enter ID numbers, account numbers or passwords here.');
    const o = { id: L.store.newId(), year: input.year, jurisdiction: input.jurisdiction, quarter: input.quarter, amountCents: input.amountCents, paidOn: input.paidOn };
    if (input.confirmation) o.confirmation = input.confirmation;
    const clean = cleanPayments([o])[0];
    state.taxPayments = (state.taxPayments || []).concat([clean]);
    return clean;
  }
  function deletePayment(state, id) {
    if (!(state.taxPayments || []).some((x) => x.id === id)) throw new Error('Payment not found');
    state.taxPayments = state.taxPayments.filter((x) => x.id !== id);
  }

  // ---- accountant package ----
  const DANGER = /^[=+\-@\t\r\n]/, PLAIN_NUM = /^-?\d+(\.\d+)?$/;
  function csvCell(v) {
    let s = v === undefined || v === null ? '' : String(v);
    if (DANGER.test(s) && !PLAIN_NUM.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  const money = (c) => (c === null || c === undefined ? '' : (c < 0 ? '-' : '') + Math.floor(Math.abs(c) / 100) + '.' + String(Math.abs(c) % 100).padStart(2, '0'));
  // Plain-data package (also the print view's source). Refuses like every tax figure; carries payee names, never a tax ID.
  function accountantPackage(state, year) {
    if (blocked(state, year)) return refusal(year, state);
    const profile = profileOf(state, year);
    const c = collect(state, year), t = compute(state, year), ys = String(year);
    const projName = (id) => { const p = (state.projects || []).find((x) => x.id === id); return p ? p.name : ''; };
    const payeeName = (id) => { const p = (state.payees || []).find((x) => x.id === id); return p ? p.name : ''; };
    const pt = payeeTotals(state, year);
    return {
      blocked: false, year, notice: NOTICE, hasProfile: !!profile, summary: t,
      income: c.income.map((x) => ({ date: x.e.date, title: x.e.title, line: projName(x.e.projectId), cents: x.cents })).sort((a, b) => a.date.localeCompare(b.date)),
      expenses: c.expense.map((x) => ({ date: x.e.date, title: x.e.title, category: x.e.category || '', taxLine: x.line ? lineById(x.line).label : 'Unmapped', grossCents: x.grossCents, deductibleCents: x.cents, line: projName(x.e.projectId), payee: payeeName(x.e.payeeId), reimbursable: !!x.e.reimbursable })).sort((a, b) => a.date.localeCompare(b.date)),
      trips: c.trips.map((x) => ({ date: x.t.date, from: x.t.from, to: x.t.to, miles: x.t.miles, roundTrip: !!x.t.roundTrip, purpose: x.t.purpose, line: projName(x.t.projectId), cents: x.cents })).sort((a, b) => a.date.localeCompare(b.date)),
      homeOffice: (state.homeOffice || {})[ys] || null,
      payees: pt.rows.map((r) => ({ name: payeeName(r.payeeId), totalCents: r.totalCents, cardCents: r.cardCents, reaches: r.reaches, w9: r.tinOnFile ? (r.w9Date || 'on file') : 'not on file' })),
      payments: (state.taxPayments || []).filter((p) => p.year === year).map((p) => ({ jurisdiction: p.jurisdiction, quarter: p.quarter, amountCents: p.amountCents, paidOn: p.paidOn, confirmation: p.confirmation || '' })),
    };
  }
  // SEC-78 (deviation b): the accountant export leaves private records out unless the user ticks "Include private records" (offered only
  // while the vault is open). Left out, the totals would be incomplete whenever a business record of the year is private, so the export
  // refuses and says why; it never produces a Schedule C total that silently excludes private income.
  const LEFT_OUT_MESSAGE = 'Private business records of this year are left out, so the totals would be incomplete. Tick "Include private records" or move them out of the private vault.';
  function exportPackage(state, year, includePrivate) {
    const isView = !!(L.priv && L.priv.isView && L.priv.isView(state));
    if (includePrivate) {
      if (!isView && blocked(state, year)) return refusal(year, state);
      const pkg = accountantPackage(state, year);
      if (!pkg.blocked) pkg.privateIncluded = isView;
      return pkg;
    }
    const main = isView ? L.priv.mainOnly(state) : state;
    if (blocked(main, year)) return isView && !(L.archive && L.archive.isArchivedYear(main, year)) ? Object.assign(refusal(year), { leftOut: true, message: LEFT_OUT_MESSAGE }) : refusal(year, main);
    const pkg = accountantPackage(main, year);
    if (!pkg.blocked) pkg.privateIncluded = false;
    return pkg;
  }
  function exportCsv(pkg, lineName) {
    if (pkg.blocked) throw new Error(pkg.message || BLOCK_MESSAGE);
    const out = [], row = (a) => out.push(a.map(csvCell).join(','));
    const sec = (title, head, rows) => { if (out.length) out.push(''); row([title]); row(head); for (const r of rows) row(r); };
    const s = pkg.summary;
    row([NOTICE]); row(['Tax year', pkg.year]);
    row(['Private records', pkg.privateIncluded ? 'included' : 'not included (no private business record of this year)']);
    sec('Schedule C summary', ['Line', 'Schedule C line', 'Amount'], [['Gross receipts', '1', money(s.incomeCents)]].concat(
      s.lines.map((l) => [l.label, l.sc, money(l.cents)]), [['Unmapped expenses', '', money(s.unmapped.cents)], ['Total deductions', '', money(s.expenseCents + s.mileageCents + s.homeOfficeCents)], ['Net profit', '31', money(s.profitCents)], ['Reimbursed expenses (information only, already counted gross)', '', money(s.reimbursedCents)]]));
    sec('By line of work', ['Line of work', 'Income', 'Expenses', 'Mileage', 'Home office', 'Net'], s.byLineOfWork.lines.map((r) => [lineName(r.projectId), money(r.incomeCents), money(r.expenseCents), money(r.mileageCents), money(r.homeOfficeCents), money(r.netCents)]));
    sec('By parent rollup', ['Parent line of work', 'Income', 'Expenses', 'Mileage', 'Home office', 'Net'], s.byLineOfWork.rollups.map((r) => [lineName(r.projectId), money(r.incomeCents), money(r.expenseCents), money(r.mileageCents), money(r.homeOfficeCents), money(r.netCents)]));
    sec('Business income', ['Date', 'Description', 'Line of work', 'Amount'], pkg.income.map((x) => [x.date, x.title, x.line, money(x.cents)]));
    sec('Business expenses', ['Date', 'Description', 'Category', 'Tax line', 'Paid', 'Deductible', 'Line of work', 'Payee', 'Reimbursable'], pkg.expenses.map((x) => [x.date, x.title, x.category, x.taxLine, money(x.grossCents), money(x.deductibleCents), x.line, x.payee, x.reimbursable ? 'yes' : '']));
    sec('Mileage log', ['Date', 'From', 'To', 'Miles', 'Round trip', 'Purpose', 'Line of work', 'Deduction'], pkg.trips.map((x) => [x.date, x.from, x.to, x.miles, x.roundTrip ? 'yes' : '', x.purpose, x.line, x.cents === null ? 'no rate' : money(x.cents)]));
    sec('Home office (simplified method)', ['Square feet', 'Months used', 'Deduction'], pkg.homeOffice ? [[pkg.homeOffice.squareFeet, pkg.homeOffice.monthsUsed, money(s.homeOfficeCents)]] : []);
    sec('1099-NEC payees', ['Payee', 'Total (excluding card payments)', 'Card payments', 'At or over threshold', 'W-9'], pkg.payees.map((x) => [x.name, money(x.totalCents), money(x.cardCents), x.reaches ? 'yes' : '', x.w9]));
    sec('Estimated tax payments', ['Jurisdiction', 'Quarter', 'Amount', 'Paid on', 'Confirmation'], pkg.payments.map((x) => [x.jurisdiction === 'nj' ? 'NJ' : 'Federal', x.quarter, money(x.amountCents), x.paidOn, x.confirmation]));
    return out.join('\r\n') + '\r\n';
  }
  const EXPORT_WARNING = 'This file is not encrypted. It contains your business records, payee names and mileage log. Store it somewhere safe.';

  L.tax = {
    NOTICE, BLOCK_MESSAGE, EXPORT_WARNING, FILING, FILING_LABEL, JURISDICTIONS, LINES, LINE_IDS, MAPPABLE, DEFAULT_CATEGORY_LINES, THRESHOLD_BY_STATUS, THRESHOLD_NOTE,
    SE_MIN_DEFAULT, SE_MIN_NOTE, mulDiv, ppm, defaultProfile, cleanProfile, cleanTaxYears, cleanHomeOffice, cleanTaxMap, cleanPayments, profileOf, years, blocked, refusal,
    shiftDue, dueDates, lineFor, rateFor, tripCents, homeOfficeCents, seTax, compute, installments, safeHarbor, payeeTotals, timelineRows, digest,
    proposeYear, applyNewYear, setProfile, startDefaultYear, setLineMap, addPayment, deletePayment, accountantPackage, exportPackage, LEFT_OUT_MESSAGE, exportCsv, money,
    bizTest, centsOf, lineById, paymentTotals,
  };
})();
