(function () {
  'use strict';
  // Home (schema 6): properties, vehicles, maintenance, household bills. Pure functions over state; every mutator runs inside
  // store.commit and only changes what the user tapped. Nothing here creates a recurring item on its own: finishing a recurring
  // task only PROPOSES the next one (pendingProposals), which the user confirms. Dates are local YYYY-MM-DD strings handled as
  // calendar days (Date.UTC is a day counter only), so a time zone or a DST change can never move a due date.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const V = () => L.validate;

  const PROPERTY_CAP = 20, VEHICLE_CAP = 20, MAINT_CAP = 2000;
  const PROPERTY_KINDS = Object.freeze(['house', 'condo', 'rental', 'land', 'other']);
  const CADENCES = Object.freeze(['once', 'monthly', 'quarterly', 'semiannual', 'annual', 'custom']);
  const CADENCE_LABEL = Object.freeze({ once: 'Once', monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Every 6 months', annual: 'Yearly', custom: 'Custom days' });
  const MONTHS = Object.freeze({ monthly: 1, quarterly: 3, semiannual: 6, annual: 12 });
  const MAX_CENTS = 1e11, MAX_ODO = 1e7, MAX_DAYS = 3650;
  const MIN_DATE = '1900-01-01', MAX_DATE = '2200-12-31';

  // ---- calendar-day arithmetic (no local time anywhere) ----
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  const parts = (s) => [+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)];
  const dayNo = (s) => { const p = parts(s); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 864e5); };
  const fromDayNo = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
  const isDate = (s) => {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s) || s < MIN_DATE || s > MAX_DATE) return false;
    const p = parts(s), t = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return t.getUTCFullYear() === p[0] && t.getUTCMonth() === p[1] - 1 && t.getUTCDate() === p[2];
  };
  const addDays = (s, n) => fromDayNo(dayNo(s) + n);
  const daysBetween = (a, b) => dayNo(a) - dayNo(b);
  // Add whole months; a day that does not exist in the target month moves to that month's last day (31 Jan + 1 month = 28 or 29 Feb).
  function addMonths(s, k) {
    const p = parts(s), t = p[0] * 12 + (p[1] - 1) + k, y = Math.floor(t / 12), m = t % 12;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return pad(y, 4) + '-' + pad(m + 1) + '-' + pad(Math.min(p[2], last));
  }
  // The date a recurring item comes round again after `from`; null for a one-off.
  function nextDate(from, cadence, everyDays) {
    if (!isDate(from)) throw new Error('Date must be YYYY-MM-DD');
    let r;
    if (cadence === 'once') return null;
    if (MONTHS[cadence]) r = addMonths(from, MONTHS[cadence]);
    else if (cadence === 'custom') {
      if (!Number.isInteger(everyDays) || everyDays < 1 || everyDays > MAX_DAYS) throw new Error('Enter a repeat of 1 to ' + MAX_DAYS + ' days');
      r = addDays(from, everyDays);
    } else throw new Error('Unknown repeat');
    if (r > MAX_DATE) throw new Error('That date is out of range');
    return r;
  }
  const yearOf = (d) => d.slice(0, 4);

  // ---- validation (rebuilds every record from whitelists, with caps) ----
  const text = (v, max, name, empty) => {
    if (v === undefined) v = '';
    if (typeof v !== 'string') V().fail(name + ' must be text');
    return V().str(V().strip(v).trim(), max, name, empty);
  };
  const optDate = (v, name) => { if (v === undefined || v === null || v === '') return undefined; const d = V().date(v, name); if (!isDate(d)) V().fail(name + ' is out of range'); return d; };
  const reqDate = (v, name) => { const d = V().date(v, name); if (!isDate(d)) V().fail(name + ' is out of range'); return d; };
  const optInt = (v, lo, hi, name) => (v === undefined || v === null || v === '' ? undefined : V().num(v, lo, hi, name, true));
  const ident = (x, seen, name) => {
    if (!V().isObj(x)) V().fail(name);
    const id = V().str(x.id, 100, name + ' id');
    if (seen.has(id)) V().fail('duplicate ' + name + ' id');
    seen.add(id);
    return id;
  };
  function cleanProperties(list) {
    if (list === undefined) return [];
    const seen = new Set();
    return V().arr(list, PROPERTY_CAP, 'properties').map((x) => {
      const id = ident(x, seen, 'property');
      return { id, name: text(x.name, 200, 'property name'), kind: V().oneOf(x.kind, PROPERTY_KINDS, 'property kind'), archived: V().bool(x.archived, 'archived', false) };
    });
  }
  function cleanVehicles(list) {
    if (list === undefined) return [];
    const seen = new Set();
    return V().arr(list, VEHICLE_CAP, 'vehicles').map((x) => {
      const id = ident(x, seen, 'vehicle');
      const o = { id, name: text(x.name, 200, 'vehicle name') };
      const yr = optInt(x.year, 1900, 2200, 'vehicle year'); if (yr !== undefined) o.year = yr;
      const od = optInt(x.odometer, 0, MAX_ODO, 'odometer'); if (od !== undefined) o.odometer = od;
      o.odometerUnit = x.odometerUnit === undefined ? 'mi' : V().oneOf(x.odometerUnit, ['mi', 'km'], 'odometer unit');
      o.archived = V().bool(x.archived, 'archived', false);
      return o;
    });
  }
  // `every` handling shared with admin: custom needs 1 to 3650 days, other cadences carry no day count.
  function cleanRepeat(x, cadences, name) {
    const cadence = V().oneOf(x.cadence, cadences, name + ' repeat');
    if (cadence !== 'custom') return { cadence };
    if (x.everyDays === undefined || x.everyDays === null || x.everyDays === '') V().fail('repeat days are required for a custom repeat');
    return { cadence, everyDays: V().num(x.everyDays, 1, MAX_DAYS, 'repeat days', true) };
  }
  // A property or vehicle link that points at nothing is dropped; the record itself is kept.
  function cleanMaintenance(list, properties, vehicles) {
    if (list === undefined) return [];
    const seen = new Set(), pids = new Set((properties || []).map((p) => p.id)), vids = new Set((vehicles || []).map((v) => v.id));
    return V().arr(list, MAINT_CAP, 'maintenance').map((x) => {
      const id = ident(x, seen, 'maintenance item');
      const o = { id };
      if (typeof x.propertyId === 'string' && pids.has(x.propertyId)) o.propertyId = x.propertyId;
      else if (x.propertyId !== undefined && x.propertyId !== null && typeof x.propertyId !== 'string') V().fail('property link must be text');
      if (typeof x.vehicleId === 'string' && vids.has(x.vehicleId)) o.vehicleId = x.vehicleId;
      else if (x.vehicleId !== undefined && x.vehicleId !== null && typeof x.vehicleId !== 'string') V().fail('vehicle link must be text');
      o.title = text(x.title, 200, 'maintenance title');
      o.area = text(x.area, 60, 'area', true);
      Object.assign(o, cleanRepeat(x, CADENCES, 'maintenance'));
      const ld = optDate(x.lastDone, 'last done'); if (ld) o.lastDone = ld;
      const nd = optDate(x.nextDue, 'next due'); if (nd) o.nextDue = nd;
      const cost = optInt(x.cost, 0, MAX_CENTS, 'cost'); if (cost !== undefined) o.cost = cost;
      const odo = optInt(x.odometer, 0, MAX_ODO, 'odometer'); if (odo !== undefined) o.odometer = odo;
      o.vendor = text(x.vendor, 200, 'vendor', true);
      o.notes = text(x.notes, 2000, 'notes', true);
      o.state = V().oneOf(x.state, ['open', 'done', 'skipped'], 'maintenance state');
      return o;
    });
  }

  // ---- lists ----
  const list = (state, k) => (state && Array.isArray(state[k]) ? state[k] : []);
  const liveProps = (state) => list(state, 'properties').filter((p) => !p.archived);
  const liveVehicles = (state) => list(state, 'vehicles').filter((v) => !v.archived);
  const byDue = (a, b) => (a.nextDue || '').localeCompare(b.nextDue || '') || a.title.localeCompare(b.title);
  // Was the item still open on date D? A task finished after D counts as open on D, so past weeks keep their numbers.
  const openOn = (m, d) => m.state === 'open' || (m.state === 'done' && !!m.lastDone && m.lastDone > d);
  const overdueAt = (state, d) => list(state, 'maintenance').filter((m) => !!m.nextDue && m.nextDue < d && openOn(m, d)).sort(byDue);
  const dueWithin = (state, d, days) => { const end = addDays(d, days); return list(state, 'maintenance').filter((m) => !!m.nextDue && m.nextDue >= d && m.nextDue <= end && openOn(m, d)).sort(byDue); };
  const ytdCost = (state, today) => {
    const from = yearOf(today) + '-01-01';
    return list(state, 'maintenance').filter((m) => m.state === 'done' && m.lastDone && m.lastDone >= from && m.lastDone <= today && typeof m.cost === 'number').reduce((a, m) => a + m.cost, 0);
  };

  // ---- completion: records the date and cost and PROPOSES the next one ----
  const keyOf = (m) => (m.propertyId || '') + '|' + (m.vehicleId || '') + '|' + m.title.trim().toLowerCase();
  function proposeNext(item) {
    if (!item || item.cadence === 'once' || !item.lastDone) return null;
    return { fromId: item.id, title: item.title, area: item.area, cadence: item.cadence, everyDays: item.everyDays, propertyId: item.propertyId, vehicleId: item.vehicleId, vendor: item.vendor, nextDue: nextDate(item.lastDone, item.cadence, item.everyDays) };
  }
  // Finished recurring tasks that have no open successor yet: the latest finished item of each task, offered for confirmation.
  function pendingProposals(state) {
    const open = new Set(list(state, 'maintenance').filter((m) => m.state === 'open').map(keyOf)), latest = new Map();
    for (const m of list(state, 'maintenance')) {
      if (m.state !== 'done' || m.cadence === 'once' || !m.lastDone) continue;
      const k = keyOf(m), cur = latest.get(k);
      if (!cur || m.lastDone >= cur.lastDone) latest.set(k, m);
    }
    const out = [];
    for (const [k, m] of latest) {
      if (open.has(k)) continue;
      let p = null;
      try { p = proposeNext(m); } catch (e) { p = null; }
      if (p) out.push(p);
    }
    return out.sort((a, b) => a.nextDue.localeCompare(b.nextDue) || a.title.localeCompare(b.title));
  }
  const find = (state, id) => { const m = list(state, 'maintenance').find((x) => x.id === id); if (!m) throw new Error('Maintenance item not found'); return m; };
  const NUM_RE = /^\d+(\.\d{1,2})?$/;
  // Dollars typed by the user to integer cents; blank is "none".
  function toCents(v, name) {
    if (v === undefined || v === null || v === '') return undefined;
    const s = typeof v === 'number' ? String(v) : String(v).trim().replace(/^\$/, '').replace(/,/g, '');
    if (!NUM_RE.test(s)) throw new Error((name || 'Amount') + ' must be a positive amount such as 120 or 59.99');
    const c = Math.round(Number(s) * 100);
    if (c > MAX_CENTS) throw new Error((name || 'Amount') + ' is too large');
    return c;
  }
  function toInt(v, lo, hi, name) {
    if (v === undefined || v === null || v === '') return undefined;
    const s = String(v).trim();
    if (!/^\d{1,9}$/.test(s) || +s < lo || +s > hi) throw new Error(name + ' must be a whole number from ' + lo + ' to ' + hi);
    return +s;
  }
  function addMaintenance(state, input) {
    const m = list(state, 'maintenance');
    if (m.length >= MAINT_CAP) throw new Error('You can keep up to ' + MAINT_CAP + ' maintenance items');
    const o = {
      id: L.store.newId(), title: input.title, area: input.area || '', cadence: input.cadence || 'once', vendor: input.vendor || '', notes: input.notes || '', state: 'open',
    };
    if (typeof o.title !== 'string' || !o.title.trim()) throw new Error('Enter a title.');
    if (input.propertyId) { if (!list(state, 'properties').some((p) => p.id === input.propertyId)) throw new Error('Property not found'); o.propertyId = input.propertyId; }
    if (input.vehicleId) { if (!list(state, 'vehicles').some((v) => v.id === input.vehicleId)) throw new Error('Vehicle not found'); o.vehicleId = input.vehicleId; }
    if (o.cadence === 'custom') { o.everyDays = toInt(input.everyDays, 1, MAX_DAYS, 'Repeat days'); if (o.everyDays === undefined) throw new Error('Repeat days must be a whole number from 1 to ' + MAX_DAYS); }
    if (input.nextDue) o.nextDue = input.nextDue;
    if (input.lastDone) o.lastDone = input.lastDone;
    const c = toCents(input.cost, 'Cost'); if (c !== undefined) o.cost = c;
    const od = toInt(input.odometer, 0, MAX_ODO, 'Odometer'); if (od !== undefined) o.odometer = od;
    const clean = cleanMaintenance([o], state.properties, state.vehicles)[0];
    if (o.cadence !== 'once' && !clean.nextDue && !clean.lastDone) throw new Error('A repeating task needs a next due date.');
    m.push(clean);
    state.maintenance = m;
    return clean;
  }
  // Marks an open item done on `doneDate` (never in the future relative to `today` when given). Returns the proposal, if any.
  function completeMaintenance(state, id, input, today) {
    const m = find(state, id);
    if (m.state !== 'open') throw new Error('That task is already closed');
    const d = (input && input.doneDate) || today;
    if (!isDate(d)) throw new Error('Date must be a valid date');
    if (today && d > today) throw new Error('The done date cannot be in the future');
    const c = toCents(input && input.cost, 'Cost'), od = toInt(input && input.odometer, 0, MAX_ODO, 'Odometer'); // validate everything before changing anything
    m.lastDone = d; m.state = 'done';
    if (c !== undefined) m.cost = c;
    if (od !== undefined) {
      m.odometer = od;
      const v = m.vehicleId && list(state, 'vehicles').find((x) => x.id === m.vehicleId);
      if (v && (v.odometer === undefined || od > v.odometer)) v.odometer = od;
    }
    return proposeNext(m);
  }
  // Creates the proposed next task after the user's confirmation. `nextDue` lets the user adjust the date first.
  function confirmNext(state, fromId, nextDueOverride) {
    const p = pendingProposals(state).find((x) => x.fromId === fromId);
    if (!p) throw new Error('There is nothing to confirm for that task');
    const src = find(state, fromId);
    let due = p.nextDue;
    if (nextDueOverride) { if (!isDate(nextDueOverride)) throw new Error('Date must be a valid date'); due = nextDueOverride; }
    if (list(state, 'maintenance').length >= MAINT_CAP) throw new Error('You can keep up to ' + MAINT_CAP + ' maintenance items');
    const o = { id: L.store.newId(), title: src.title, area: src.area, cadence: src.cadence, vendor: src.vendor, notes: src.notes, state: 'open', nextDue: due, lastDone: src.lastDone };
    if (src.everyDays !== undefined) o.everyDays = src.everyDays;
    if (src.propertyId) o.propertyId = src.propertyId;
    if (src.vehicleId) o.vehicleId = src.vehicleId;
    const clean = cleanMaintenance([o], state.properties, state.vehicles)[0];
    state.maintenance.push(clean);
    return clean;
  }
  // The user does not want this task to repeat: it becomes a one-off record and the proposal goes away.
  function stopRepeating(state, fromId) {
    const m = find(state, fromId);
    m.cadence = 'once'; delete m.everyDays;
    return m;
  }
  function skipMaintenance(state, id) { const m = find(state, id); if (m.state !== 'open') throw new Error('That task is already closed'); m.state = 'skipped'; return m; }
  function deleteMaintenance(state, id) { find(state, id); state.maintenance = state.maintenance.filter((x) => x.id !== id); }

  // ---- properties and vehicles ----
  function addProperty(state, input) {
    if (list(state, 'properties').length >= PROPERTY_CAP) throw new Error('You can keep up to ' + PROPERTY_CAP + ' properties');
    const o = cleanProperties([{ id: L.store.newId(), name: input.name, kind: input.kind || 'house', archived: false }])[0];
    state.properties = list(state, 'properties').concat([o]);
    return o;
  }
  function addVehicle(state, input) {
    if (list(state, 'vehicles').length >= VEHICLE_CAP) throw new Error('You can keep up to ' + VEHICLE_CAP + ' vehicles');
    const raw = { id: L.store.newId(), name: input.name, odometerUnit: input.odometerUnit || 'mi', archived: false };
    const yr = toInt(input.year, 1900, 2200, 'Year'); if (yr !== undefined) raw.year = yr;
    const od = toInt(input.odometer, 0, MAX_ODO, 'Odometer'); if (od !== undefined) raw.odometer = od;
    const o = cleanVehicles([raw])[0];
    state.vehicles = list(state, 'vehicles').concat([o]);
    return o;
  }
  // Deleting a property or vehicle keeps its maintenance items and unlinks them. Returns how many were unlinked.
  function deleteProperty(state, id) {
    if (!list(state, 'properties').some((p) => p.id === id)) throw new Error('Property not found');
    let n = 0;
    for (const m of list(state, 'maintenance')) if (m.propertyId === id) { delete m.propertyId; n++; }
    state.properties = state.properties.filter((p) => p.id !== id);
    return n;
  }
  function deleteVehicle(state, id) {
    if (!list(state, 'vehicles').some((v) => v.id === id)) throw new Error('Vehicle not found');
    let n = 0;
    for (const m of list(state, 'maintenance')) if (m.vehicleId === id) { delete m.vehicleId; n++; }
    state.vehicles = state.vehicles.filter((v) => v.id !== id);
    return n;
  }
  const linkedCount = (state, k, id) => list(state, 'maintenance').filter((m) => m[k] === id).length;
  function setArchived(state, coll, id, flag) {
    const x = list(state, coll).find((y) => y.id === id);
    if (!x) throw new Error('Not found');
    x.archived = !!flag;
  }
  function setOdometer(state, id, value) {
    const v = list(state, 'vehicles').find((x) => x.id === id);
    if (!v) throw new Error('Vehicle not found');
    const od = toInt(value, 0, MAX_ODO, 'Odometer');
    if (od === undefined) delete v.odometer; else v.odometer = od;
  }
  // Latest finished service per vehicle (by date, then odometer).
  function vehicleSummary(state) {
    return liveVehicles(state).map((v) => {
      const done = list(state, 'maintenance').filter((m) => m.vehicleId === v.id && m.state === 'done' && m.lastDone).sort((a, b) => b.lastDone.localeCompare(a.lastDone) || (b.odometer || 0) - (a.odometer || 0));
      const last = done[0] || null;
      return { id: v.id, name: v.name, year: v.year, odometer: v.odometer, unit: v.odometerUnit, services: done.length, last: last ? { date: last.lastDone, odometer: last.odometer, title: last.title } : null };
    });
  }

  // ---- household bills: Money recurring items carrying a `household` flag (no second store) ----
  // Monthly equivalent in integer cents: weekly x 52 / 12, yearly / 12, summed exactly then rounded once.
  function householdBills(state) {
    const items = list(state, 'recurring').filter((r) => r.household && r.active && r.type === 'expense');
    let twelfths = 0;
    const rows = items.map((r) => {
      const c = Math.round(r.value * 100), f = r.cadence === 'weekly' ? 52 : r.cadence === 'monthly' ? 12 : 1;
      twelfths += c * f;
      return { id: r.id, title: r.title, cadence: r.cadence, cents: c, monthlyCents: Math.round(c * f / 12), nextDate: r.nextDate };
    }).sort((a, b) => a.title.localeCompare(b.title));
    return { items: rows, totalMonthlyCents: Math.round(twelfths / 12) };
  }
  function setHousehold(state, recurringId, flag) {
    const r = list(state, 'recurring').find((x) => x.id === recurringId);
    if (!r) throw new Error('Recurring item not found');
    r.household = !!flag;
    return r;
  }

  // ---- seasonal starter checklist: suggestions only, offered once, nothing is added until the user picks ----
  const STARTER = Object.freeze([
    { id: 'smoke-batteries', title: 'Test smoke and CO alarms', area: 'Safety', cadence: 'semiannual', month: 3 },
    { id: 'hvac-filter', title: 'Replace HVAC filter', area: 'Heating and cooling', cadence: 'quarterly', month: 1 },
    { id: 'gutters-fall', title: 'Clean gutters', area: 'Exterior', cadence: 'semiannual', month: 10 },
    { id: 'furnace', title: 'Furnace service', area: 'Heating and cooling', cadence: 'annual', month: 9 },
    { id: 'ac-service', title: 'Air conditioner service', area: 'Heating and cooling', cadence: 'annual', month: 4 },
    { id: 'water-heater', title: 'Flush water heater', area: 'Plumbing', cadence: 'annual', month: 6 },
    { id: 'dryer-vent', title: 'Clean dryer vent', area: 'Appliances', cadence: 'annual', month: 5 },
    { id: 'chimney', title: 'Chimney inspection', area: 'Exterior', cadence: 'annual', month: 9 },
    { id: 'faucets', title: 'Shut off outdoor faucets', area: 'Plumbing', cadence: 'annual', month: 10 },
    { id: 'roof', title: 'Roof check', area: 'Exterior', cadence: 'annual', month: 4 },
    { id: 'sump', title: 'Test sump pump', area: 'Plumbing', cadence: 'semiannual', month: 3 },
    { id: 'deck', title: 'Seal or stain deck', area: 'Exterior', cadence: 'annual', month: 5 },
  ]);
  // The first first-of-month in the item's month on or after `today`.
  function starterDue(month, today) {
    const y = +today.slice(0, 4), t = y + '-' + pad(month) + '-01';
    return t >= today ? t : (y + 1) + '-' + pad(month) + '-01';
  }
  const starterOffer = (state) => (state && state.settings && state.settings.home && state.settings.home.starterDone ? [] : STARTER.slice());
  function addStarter(state, ids, today) {
    if (!Array.isArray(ids)) throw new Error('Choose the tasks to add');
    if (!isDate(today)) throw new Error('today must be YYYY-MM-DD');
    const picked = [...new Set(ids)].map((id) => STARTER.find((x) => x.id === id) || null);
    if (picked.some((x) => !x)) throw new Error('Unknown checklist item');
    const live = liveProps(state), made = [];
    for (const s of picked) {
      made.push(addMaintenance(state, { title: s.title, area: s.area, cadence: s.cadence, nextDue: starterDue(s.month, today), propertyId: live.length === 1 ? live[0].id : undefined }));
    }
    state.settings.home = { starterDone: true };
    return made;
  }
  function dismissStarter(state) { state.settings.home = { starterDone: true }; }

  // ---- summaries ----
  function summary(state, today) {
    if (!isDate(today)) throw new Error('today must be YYYY-MM-DD');
    const bills = householdBills(state);
    return {
      overdue: overdueAt(state, today), due30: dueWithin(state, today, 30), ytdCostCents: ytdCost(state, today),
      vehicles: vehicleSummary(state), bills, proposals: pendingProposals(state), starter: starterOffer(state),
      hasData: hasData(state),
    };
  }
  const hasData = (state) => list(state, 'properties').length + list(state, 'vehicles').length + list(state, 'maintenance').length > 0;
  // Old home/due entries that the schema 6 upgrade kept (see admin.legacyDue) still count until the user deletes them.
  const legacyOpen = (state) => list(state, 'entries').filter((e) => e.domain === 'home' && e.type === 'due' && e.status !== 'done');
  function legacyCounts(state, from, days) {
    const end = addDays(from, days);
    let soon = 0, late = 0;
    for (const e of legacyOpen(state)) { if (e.due < from) late++; else if (e.due <= end) soon++; }
    return { soon, late };
  }
  function headline(state, today, R, fmt) {
    if (!hasData(state) && legacyOpen(state).length) { // only old due entries: the old tile
      const d = legacyCounts(state, today, 30);
      return R('Due within 30 days', String(d.soon), d.soon, d.late ? d.late + ' overdue' : 'Nothing overdue');
    }
    const od = overdueAt(state, today).length, soon = dueWithin(state, today, 30).length;
    return R('Tasks overdue', String(od), od, soon + ' due in 30 days');
  }
  // Number for the week ending `we` (digest and sparkline): maintenance tasks overdue on that day.
  function weekValue(state, we) {
    if (!hasData(state) && legacyOpen(state).length) return legacyCounts(state, we, 30).soon;
    return overdueAt(state, we).length;
  }
  // Counts and totals only: never a title, vendor, area, note or name.
  function digest(state, ws) {
    const we = addDays(ws, 6);
    return {
      overdue: overdueAt(state, we).length, dueSoon: dueWithin(state, we, 30).length,
      done: list(state, 'maintenance').filter((m) => m.state === 'done' && m.lastDone && m.lastDone >= ws && m.lastDone <= we).length,
      ytdCostCents: ytdCost(state, we),
    };
  }
  // Weekly review step: what came due in the week, what is due the week after, and finished tasks awaiting a decision.
  function reviewWeek(state, ws) {
    const we = addDays(ws, 6), nws = addDays(ws, 7), nwe = addDays(ws, 13), ms = list(state, 'maintenance');
    return {
      cameDue: ms.filter((m) => m.state === 'open' && m.nextDue && m.nextDue >= ws && m.nextDue <= we).sort(byDue),
      overdue: ms.filter((m) => m.state === 'open' && m.nextDue && m.nextDue < ws).sort(byDue),
      dueNext: ms.filter((m) => m.state === 'open' && m.nextDue && m.nextDue >= nws && m.nextDue <= nwe).sort(byDue),
      proposals: pendingProposals(state),
    };
  }
  // Linked goal metric: tasks overdue on a date; null when there are no maintenance items at all.
  const overdueValue = (state, asOf) => (list(state, 'maintenance').length ? overdueAt(state, asOf).length : null);

  L.home = {
    PROPERTY_KINDS, CADENCES, CADENCE_LABEL, STARTER, PROPERTY_CAP, VEHICLE_CAP, MAINT_CAP,
    dates: { isDate, addDays, addMonths, daysBetween, dayNo, fromDayNo, MAX_DATE },
    nextDate, cleanProperties, cleanVehicles, cleanMaintenance, cleanRepeat, text, optDate, reqDate, optInt, ident, toCents, toInt,
    liveProps, liveVehicles, overdueAt, dueWithin, ytdCost, proposeNext, pendingProposals, addMaintenance, completeMaintenance, confirmNext, stopRepeating,
    skipMaintenance, deleteMaintenance, addProperty, addVehicle, deleteProperty, deleteVehicle, linkedCount, setArchived, setOdometer, vehicleSummary,
    householdBills, setHousehold, starterOffer, starterDue, addStarter, dismissStarter, summary, headline, weekValue, digest, reviewWeek, overdueValue, hasData,
  };
})();
