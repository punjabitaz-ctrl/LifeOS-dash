(function () {
  'use strict';
  // v2.4.0: taxes and assets by country. Each account carries the country it sits in and the currency its balances are in; tax records,
  // tax-year profiles of a country and Admin tax checklist items carry a country too. The country list (US and Spain to start, more
  // addable) and the exchange rates live in settings.countries and settings.fx.
  // HONEST MONEY: a balance is always shown in its own currency. A total across currencies is only made when the owner has typed the
  // rate for every currency in it; LifeOS never looks a rate up and never guesses one. An amount without a rate is left out of a
  // combined total and named as left out. No tax rule or rate of any country is built in: a country's tax profile holds only what the
  // owner types (residency, days, a filing date, a note), and its tax records are amounts the owner enters.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const V = () => L.validate;
  const COUNTRY_CAP = 20, FX_CAP = 20, RECORD_CAP = 2000, PROFILE_CAP = 400, MAX_CENTS = 1e13;
  const CODE_RE = /^[A-Z]{2}$/, CUR_RE = /^[A-Z]{3}$/;
  const RECORD_KINDS = Object.freeze(['paid', 'owed', 'refund']);
  const RECORD_KIND_LABEL = Object.freeze({ paid: 'Tax paid', owed: 'Tax owed', refund: 'Refund' });
  const RESIDENCY = Object.freeze(['unsure', 'resident', 'nonresident']);
  const RESIDENCY_LABEL = Object.freeze({ unsure: 'Not set', resident: 'Tax resident', nonresident: 'Not a tax resident' });
  const DEFAULT_LIST = Object.freeze([
    Object.freeze({ code: 'US', name: 'United States', currency: 'USD' }),
    Object.freeze({ code: 'ES', name: 'Spain', currency: 'EUR' }),
  ]);
  const defaultSettings = () => ({ home: 'US', list: DEFAULT_LIST.map((x) => Object.assign({}, x)) });
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && L.home.dates.isDate(s);
  const TEXT = (v, max, name, empty) => V().str(V().strip(v === undefined ? '' : String(v)).trim(), max, name, empty);
  // A Spanish NIE (X1234567L) or DNI/NIF (12345678Z) is a government ID: refused like an SSN or EIN.
  const ES_ID = /(?<![A-Z0-9])[XYZ][- ]?\d{7}[- ]?[A-Z](?![A-Z0-9])|(?<![A-Z0-9])\d{8}[- ]?[A-Z](?![A-Z0-9])/i;
  const ID_MESSAGE = 'That looks like a tax ID or an ID number. LifeOS never stores tax IDs or ID numbers.';
  function checkText(fields) {
    for (const f of fields) if (typeof f === 'string' && f && ((L.admin && L.admin.looksTaxId(f)) || ES_ID.test(f))) throw new Error(ID_MESSAGE);
  }

  // ---- settings ----
  function cleanSettings(x) {
    if (x === undefined || x === null) return defaultSettings();
    if (!V().isObj(x)) V().fail('countries');
    const seen = new Set();
    const list = V().arr(x.list, COUNTRY_CAP, 'countries').map((c) => {
      if (!V().isObj(c)) V().fail('country');
      if (typeof c.code !== 'string' || !CODE_RE.test(c.code)) V().fail('country code');
      if (seen.has(c.code)) V().fail('duplicate country');
      seen.add(c.code);
      if (typeof c.currency !== 'string' || !CUR_RE.test(c.currency)) V().fail('country currency');
      return { code: c.code, name: TEXT(c.name, 60, 'country name'), currency: c.currency };
    });
    if (!list.length) V().fail('countries needs at least one country');
    if (typeof x.home !== 'string' || !seen.has(x.home)) V().fail('home country');
    return { home: x.home, list };
  }
  // fx: [{ currency, rate, asOf }], rate = how many units of the home currency (settings.currency) one unit of `currency` is worth.
  function cleanFx(list, home) {
    if (list === undefined || list === null) return [];
    const seen = new Set();
    return V().arr(list, FX_CAP, 'exchange rates').map((r) => {
      if (!V().isObj(r)) V().fail('exchange rate');
      if (typeof r.currency !== 'string' || !CUR_RE.test(r.currency) || r.currency === home) V().fail('exchange rate currency');
      if (seen.has(r.currency)) V().fail('duplicate exchange rate');
      seen.add(r.currency);
      const rate = V().num(r.rate, 0.000001, 1e6, 'exchange rate');
      if (Math.round(rate * 1e6) / 1e6 !== rate) V().fail('exchange rate allows six decimals');
      if (!isDate(r.asOf)) V().fail('exchange rate date');
      return { currency: r.currency, rate, asOf: r.asOf };
    });
  }

  // ---- records ----
  const optCode = (v, name) => { if (typeof v !== 'string' || !CODE_RE.test(v)) V().fail(name); return v; };
  function cleanRecords(list) {
    if (list === undefined) return [];
    const seen = new Set();
    return V().arr(list, RECORD_CAP, 'country tax records').map((x) => {
      if (!V().isObj(x)) V().fail('country tax record');
      const id = V().str(x.id, 100, 'country tax record id');
      if (seen.has(id)) V().fail('duplicate country tax record id');
      seen.add(id);
      if (typeof x.currency !== 'string' || !CUR_RE.test(x.currency)) V().fail('country tax record currency');
      const o = {
        id, country: optCode(x.country, 'country tax record country'), year: V().num(x.year, 1990, 2200, 'country tax record year', true),
        kind: V().oneOf(x.kind, RECORD_KINDS, 'country tax record kind'), title: TEXT(x.title, 200, 'country tax record title'),
        amountCents: V().num(x.amountCents, 0, MAX_CENTS, 'country tax record amount', true), currency: x.currency,
      };
      if (x.date !== undefined && x.date !== '' && x.date !== null) { if (!isDate(x.date)) V().fail('country tax record date'); o.date = x.date; }
      o.notes = TEXT(x.notes, 1000, 'country tax record notes', true);
      return o;
    });
  }
  function cleanProfiles(list) {
    if (list === undefined) return [];
    const seen = new Set();
    return V().arr(list, PROFILE_CAP, 'country tax profiles').map((x) => {
      if (!V().isObj(x)) V().fail('country tax profile');
      const country = optCode(x.country, 'country tax profile country'), year = V().num(x.year, 1990, 2200, 'country tax profile year', true);
      const k = country + '|' + year;
      if (seen.has(k)) V().fail('duplicate country tax profile');
      seen.add(k);
      const o = { country, year, residency: V().oneOf(x.residency === undefined ? 'unsure' : x.residency, RESIDENCY, 'residency') };
      if (x.days !== undefined && x.days !== null && x.days !== '') o.days = V().num(x.days, 0, 366, 'days in the country', true);
      if (x.filingDue !== undefined && x.filingDue !== null && x.filingDue !== '') { if (!isDate(x.filingDue)) V().fail('filing date'); o.filingDue = x.filingDue; }
      o.note = TEXT(x.note, 1000, 'country tax profile note', true);
      return o;
    });
  }

  // ---- migration and filling (store.validateState calls this after accounts, tax items and settings are clean) ----
  // Accounts and tax items written before schema 24 carry no country or currency: they take the home country and the vault currency,
  // which is exactly how they were read before (nothing changes for them). In schema 24 a missing field gets the same default.
  function fill(out, raw, schema) {
    const home = out.settings.countries.home, cur = out.settings.currency;
    const rawAcc = new Map(), rawTax = new Map();
    if (schema >= 24) {
      for (const a of Array.isArray(raw.accounts) ? raw.accounts : []) if (V().isObj(a) && typeof a.id === 'string') rawAcc.set(a.id, a);
      for (const t of Array.isArray(raw.taxItems) ? raw.taxItems : []) if (V().isObj(t) && typeof t.id === 'string') rawTax.set(t.id, t);
    }
    for (const a of out.accounts) {
      const r = rawAcc.get(a.id) || {};
      a.country = r.country === undefined ? home : optCode(r.country, 'account country');
      if (r.currency !== undefined && (typeof r.currency !== 'string' || !CUR_RE.test(r.currency))) V().fail('account currency');
      a.currency = r.currency === undefined ? cur : r.currency;
    }
    for (const t of out.taxItems) {
      const r = rawTax.get(t.id) || {};
      t.country = r.country === undefined ? home : optCode(r.country, 'tax item country');
    }
  }

  // ---- lookups ----
  const list = (settings) => (settings && settings.countries && Array.isArray(settings.countries.list) ? settings.countries.list : DEFAULT_LIST);
  const homeOf = (settings) => (settings && settings.countries && settings.countries.home) || 'US';
  const find = (settings, code) => list(settings).find((c) => c.code === code) || null;
  const nameOf = (settings, code) => { const c = find(settings, code); return c ? c.name : code; };
  const currencyOf = (settings, code) => { const c = find(settings, code); return c ? c.currency : (settings && settings.currency) || 'USD'; };
  const accountCountry = (state, a) => (a && a.country) || homeOf(state.settings);
  const accountCurrency = (state, a) => (a && a.currency) || state.settings.currency;
  // Every country the owner should see: the list, then any code a record uses that is not on it (shown by its code).
  function inUse(state) {
    const out = list(state.settings).map((c) => c.code), add = (c) => { if (c && !out.includes(c)) out.push(c); };
    for (const a of state.accounts || []) add(a.country);
    for (const r of state.countryTax || []) add(r.country);
    for (const p of state.countryTaxYears || []) add(p.country);
    for (const t of state.taxItems || []) add(t.country);
    return out;
  }
  function rateOf(settings, currency) {
    if (currency === settings.currency) return 1;
    const r = (settings.fx || []).find((x) => x.currency === currency);
    return r ? r.rate : null;
  }
  // Exact: cents times the rate (held as parts per million), rounded half away from zero to a whole cent. null when no rate is entered.
  function toHome(settings, cents, currency) {
    if (currency === settings.currency) return cents;
    const r = rateOf(settings, currency);
    if (r === null) return null;
    let n = BigInt(Math.round(cents)) * BigInt(Math.round(r * 1e6));
    const neg = n < 0n; if (neg) n = -n;
    const q = (2n * n + 1000000n) / 2000000n;
    // SEC-143: a result past the exact integer range is never shown as a number (it is treated like a missing rate).
    if (q > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(neg ? -q : q);
  }

  // ---- figures ----
  // Per-currency sums: [{ currency, assets, liabilities, net }] in cents, the home currency first, then by code.
  function bucket(map, currency) { let b = map.get(currency); if (!b) { b = { currency, assets: 0, liabilities: 0, net: 0, count: 0 }; map.set(currency, b); } return b; }
  const sorted = (map, home) => [...map.values()].sort((a, b) => (a.currency === home ? -1 : b.currency === home ? 1 : a.currency.localeCompare(b.currency)));
  // A combined total in the home currency, made only when every currency in it has a rate. missing lists the currencies without one.
  function combine(settings, buckets, fields) {
    const missing = [], out = {};
    for (const f of fields) out[f] = 0;
    for (const b of buckets) {
      if (b.currency !== settings.currency && rateOf(settings, b.currency) === null) { if (!missing.includes(b.currency)) missing.push(b.currency); continue; }
      const conv = fields.map((f) => toHome(settings, b[f], b.currency));
      if (conv.some((v) => v === null)) { if (!missing.includes(b.currency)) missing.push(b.currency); continue; }
      fields.forEach((f, i) => { out[f] += conv[i]; });
    }
    for (const f of fields) if (!Number.isSafeInteger(out[f])) return { ok: false, missing, tooLarge: true, currency: settings.currency };
    return missing.length ? { ok: false, missing, currency: settings.currency } : Object.assign({ ok: true, missing: [], currency: settings.currency }, out);
  }
  // Assets by country as of a date: each active account's latest balance, in its own currency (rows come from metrics.netWorthDetail).
  function assets(state, asOf) {
    const nw = L.metrics.netWorthDetail(state, asOf), byId = new Map((state.accounts || []).map((a) => [a.id, a]));
    const countries = new Map();
    for (const r of nw.rows.concat(nw.unconverted || [])) {
      const a = r.id ? byId.get(r.id) : null, code = accountCountry(state, a), cur = r.currency || accountCurrency(state, a), cents = r.nativeCents === undefined ? r.cents : r.nativeCents;
      let c = countries.get(code);
      if (!c) { c = { code, accounts: [], byCurrency: new Map() }; countries.set(code, c); }
      c.accounts.push({ id: r.id, name: r.name, kind: r.kind, liability: r.liability, cents, currency: cur, date: r.date });
      const b = bucket(c.byCurrency, cur);
      b.count++;
      if (r.liability) b.liabilities += Math.abs(cents); else b.assets += cents;
      b.net = b.assets - b.liabilities;
    }
    const home = state.settings.currency, out = [];
    for (const code of inUse(state)) {
      const c = countries.get(code) || { code, accounts: [], byCurrency: new Map() };
      const totals = sorted(c.byCurrency, home);
      out.push({ code, name: nameOf(state.settings, code), accounts: c.accounts, totals, combined: combine(state.settings, totals, ['assets', 'liabilities', 'net']) });
    }
    const all = new Map();
    for (const c of out) for (const b of c.totals) { const x = bucket(all, b.currency); x.assets += b.assets; x.liabilities += b.liabilities; x.net += b.net; x.count += b.count; }
    const allTotals = sorted(all, home);
    return { countries: out, totals: allTotals, combined: combine(state.settings, allTotals, ['assets', 'liabilities', 'net']) };
  }
  // Taxes by country for a year: the owner's records (paid, owed, refunds per currency), the country's profile, its open checklist
  // items, and for the home country the estimated federal and NJ payments already logged under Business (unless the tax figures of
  // that year are refused while the private vault is closed).
  function taxes(state, year) {
    const home = homeOf(state.settings), out = [];
    for (const code of inUse(state)) {
      const recs = (state.countryTax || []).filter((r) => r.country === code && r.year === year);
      const map = new Map();
      for (const r of recs) { let b = map.get(r.currency); if (!b) { b = { currency: r.currency, paid: 0, owed: 0, refund: 0 }; map.set(r.currency, b); } b[r.kind] += r.amountCents; }
      const totals = [...map.values()].sort((a, b) => (a.currency === state.settings.currency ? -1 : b.currency === state.settings.currency ? 1 : a.currency.localeCompare(b.currency)));
      const profile = (state.countryTaxYears || []).find((p) => p.country === code && p.year === year) || null;
      const items = (state.taxItems || []).filter((t) => (t.country || home) === code && t.year === year);
      const o = { code, name: nameOf(state.settings, code), records: recs, totals, profile, openItems: items.filter((t) => t.state !== 'filed').length, items: items.length, combined: combine(state.settings, totals, ['paid', 'owed', 'refund']) };
      if (code === home && L.tax) {
        if (L.tax.blocked(state, year)) o.estimates = { blocked: true };
        else { const p = L.tax.paymentTotals(state, year); o.estimates = { blocked: false, federal: p.federal, nj: p.nj, currency: state.settings.currency }; }
      }
      out.push(o);
    }
    return out;
  }

  // ---- mutators (inside a commit) ----
  function addCountry(state, input) {
    const s = state.settings, l = list(s);
    const code = String(input && input.code || '').trim().toUpperCase(), name = String(input && input.name || '').trim(), currency = String(input && input.currency || '').trim().toUpperCase();
    if (!CODE_RE.test(code)) throw new Error('Enter a two-letter country code, for example PT.');
    if (!name) throw new Error('Enter the country name.');
    if (!CUR_RE.test(currency)) throw new Error('Enter a three-letter currency code, for example EUR.');
    if (l.some((c) => c.code === code)) throw new Error('That country is already on the list.');
    if (l.length >= COUNTRY_CAP) throw new Error('You can keep up to ' + COUNTRY_CAP + ' countries.');
    checkText([name]);
    s.countries = cleanSettings({ home: homeOf(s), list: l.concat([{ code, name, currency }]) });
    return code;
  }
  function usedBy(state, code) {
    return (state.accounts || []).some((a) => a.country === code) || (state.countryTax || []).some((r) => r.country === code) ||
      (state.countryTaxYears || []).some((p) => p.country === code) || (state.taxItems || []).some((t) => t.country === code);
  }
  function removeCountry(state, code) {
    const s = state.settings;
    if (code === homeOf(s)) throw new Error('Your home country stays on the list.');
    if (!find(s, code)) throw new Error('Country not found.');
    if (usedBy(state, code)) throw new Error('Accounts or tax records still use this country. Move or delete them first.');
    s.countries = cleanSettings({ home: homeOf(s), list: list(s).filter((c) => c.code !== code) });
  }
  // rate: the owner's typed number (one unit of `currency` in the home currency); empty clears it.
  function setRate(state, currency, rate, asOf) {
    const s = state.settings, cur = String(currency || '').toUpperCase();
    if (!CUR_RE.test(cur) || cur === s.currency) throw new Error('Pick a currency other than ' + s.currency + '.');
    const rest = (s.fx || []).filter((x) => x.currency !== cur);
    if (rate === '' || rate === null || rate === undefined) { s.fx = rest; return null; }
    const n = typeof rate === 'number' ? rate : Number(String(rate).trim().replace(/,/g, ''));
    if (!Number.isFinite(n) || n <= 0 || n > 1e6) throw new Error('Enter the rate as a number above 0, for example 1.08.');
    if (Math.round(n * 1e6) / 1e6 !== n) throw new Error('A rate allows up to six decimals.');
    if (!isDate(asOf)) throw new Error('Enter the date the rate is from.');
    if (rest.length >= FX_CAP) throw new Error('You can keep up to ' + FX_CAP + ' exchange rates.');
    s.fx = cleanFx(rest.concat([{ currency: cur, rate: n, asOf }]), s.currency);
    return s.fx.find((x) => x.currency === cur);
  }
  function parseCents(v, name) {
    const t = String(v === undefined || v === null ? '' : v).trim().replace(/[,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(t)) throw new Error('Enter ' + name + ' as a number, for example 1250.00.');
    const c = Math.round(Number(t) * 100);
    if (!Number.isSafeInteger(c) || c > MAX_CENTS) throw new Error(name.charAt(0).toUpperCase() + name.slice(1) + ' is too large.');
    return c;
  }
  function recordFrom(state, input, id) {
    const code = String(input.country || ''), year = Number(input.year);
    if (!CODE_RE.test(code)) throw new Error('Pick a country.');
    if (!find(state.settings, code) && !(state.countryTax || []).some((r) => r.id === id && r.country === code)) throw new Error('Add this country to your list first.');
    if (!Number.isInteger(year) || year < 1990 || year > 2200) throw new Error('Enter a tax year.');
    const title = String(input.title || '').trim(), notes = String(input.notes || '').trim();
    if (!title) throw new Error('Enter what this is, for example "Income tax return".');
    checkText([title, notes]);
    const currency = String(input.currency || currencyOf(state.settings, code)).toUpperCase();
    const o = { id, country: code, year, kind: input.kind, title, amountCents: parseCents(input.amount, 'the amount'), currency, notes };
    if (input.date) o.date = input.date;
    return cleanRecords([o])[0];
  }
  function addRecord(state, input) {
    if ((state.countryTax || []).length >= RECORD_CAP) throw new Error('You can keep up to ' + RECORD_CAP + ' tax records.');
    const r = recordFrom(state, input, L.store.newId());
    state.countryTax = (state.countryTax || []).concat([r]);
    return r;
  }
  function editRecord(state, id, input) {
    const i = (state.countryTax || []).findIndex((x) => x.id === id);
    if (i < 0) throw new Error('Tax record not found.');
    state.countryTax[i] = recordFrom(state, input, id);
    return state.countryTax[i];
  }
  function deleteRecord(state, id) {
    if (!(state.countryTax || []).some((x) => x.id === id)) throw new Error('Tax record not found.');
    state.countryTax = state.countryTax.filter((x) => x.id !== id);
  }
  // One profile per country and year; every field the owner's own. All fields empty removes it.
  function setProfile(state, code, year, input) {
    if (!CODE_RE.test(String(code))) throw new Error('Pick a country.');
    if (!find(state.settings, code) && !(state.countryTaxYears || []).some((p) => p.country === code)) throw new Error('Add this country to your list first.');
    if (!Number.isInteger(year) || year < 1990 || year > 2200) throw new Error('Enter a tax year.');
    const rest = (state.countryTaxYears || []).filter((p) => !(p.country === code && p.year === year));
    const note = String(input.note || '').trim(), days = String(input.days === undefined || input.days === null ? '' : input.days).trim();
    checkText([note]);
    if (days !== '' && (!/^\d{1,3}$/.test(days) || Number(days) > 366)) throw new Error('Enter days as a whole number from 0 to 366.');
    const empty = (input.residency || 'unsure') === 'unsure' && days === '' && !input.filingDue && !note;
    if (empty) { state.countryTaxYears = rest; return null; }
    if (rest.length >= PROFILE_CAP) throw new Error('You can keep up to ' + PROFILE_CAP + ' country tax profiles.');
    const p = cleanProfiles([{ country: code, year, residency: input.residency || 'unsure', days: days === '' ? undefined : Number(days), filingDue: input.filingDue || undefined, note }])[0];
    state.countryTaxYears = rest.concat([p]);
    return p;
  }

  L.countries = {
    COUNTRY_CAP, FX_CAP, RECORD_CAP, PROFILE_CAP, RECORD_KINDS, RECORD_KIND_LABEL, RESIDENCY, RESIDENCY_LABEL, DEFAULT_LIST, ID_MESSAGE,
    defaultSettings, cleanSettings, cleanFx, cleanRecords, cleanProfiles, fill, list, homeOf, find, nameOf, currencyOf, accountCountry, accountCurrency,
    inUse, rateOf, toHome, combine, assets, taxes, addCountry, removeCountry, usedBy, setRate, addRecord, editRecord, deleteRecord, setProfile, checkText,
  };
})();
