(function () {
  'use strict';
  // Activities (schema 8): outings, events, travel, hobbies, volunteering, networking, classes. Pure functions over state; every
  // mutator runs inside store.commit and changes only what the user tapped. Nothing here is automatic: marking an activity done only
  // OFFERS the linked Money expense, the review only OFFERS done, skipped, reschedule and a rating, and a same-day duplicate of a
  // manual workout or contact is only a notice. Dates are local YYYY-MM-DD strings handled as calendar days (Date.UTC is a day
  // counter only), so a time zone or DST change can never move a window or a week. Money is integer cents. Titles, places, people,
  // categories and notes never leave the vault: the digest holds numbers only.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const V = () => L.validate;
  const H = () => L.home;
  const D = () => L.home.dates;

  const ACTIVITY_CAP = 5000, CATEGORY_CAP = 30, PEOPLE_MAX = 10, NAME_MAX = 100, NOTE_MAX = 200, MAX_CENTS = 1e11, MAX_MIN = 527040, MAX_SPAN = 365;
  const WINDOW_DAYS = 30, RATE_DAYS = 14, OFFER_DAYS = 30, GLANCE_CAP = 200, KIND_MAX = 40;
  const STATES = Object.freeze(['planned', 'done', 'skipped']);
  const STATE_LABEL = Object.freeze({ planned: 'Planned', done: 'Done', skipped: 'Skipped' });
  const DEFAULT_CATEGORIES = Object.freeze(['outing', 'event', 'travel', 'hobby', 'networking', 'volunteering', 'class', 'other']);
  const SECRET_MESSAGE = 'That looks like an ID number or a card number. Do not enter ID numbers, account numbers or passwords here.';

  const list = (state, k) => (state && Array.isArray(state[k]) ? state[k] : []);
  const given = (v) => v !== undefined && v !== null && v !== '';
  const r2 = (x) => Math.round(x * 100) / 100;
  const T = (v, max, name, empty) => H().text(v, max, name, empty);
  const weekStart = (d) => L.metrics.weekStart(d);
  const isDone = (a) => a.state === 'done';
  const spanEnd = (a) => a.endDate || a.date;
  const byDate = (a, b) => a.date.localeCompare(b.date) || String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id));
  const monthOf = (d) => d.slice(0, 7);

  // ---- validation (rebuilds every record from whitelists, with caps) ----
  function cleanCategories(list_) {
    if (list_ === undefined) return DEFAULT_CATEGORIES.slice();
    const seen = new Set();
    return V().arr(list_, CATEGORY_CAP, 'activity categories').map((x) => {
      const v = T(x, 40, 'activity category');
      if (seen.has(v.toLowerCase())) V().fail('duplicate activity category');
      seen.add(v.toLowerCase());
      return v;
    });
  }
  function cleanPeople(v) {
    if (v === undefined) return [];
    const seen = new Set(), out = [];
    for (const n of V().arr(v, PEOPLE_MAX, 'people')) {
      const name = T(n, NAME_MAX, 'person name');
      if (!seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); out.push(name); }
    }
    return out;
  }
  // A link that points at nothing is dropped and the activity kept; a non-text link refuses the state.
  function link(v, ids, name) {
    if (typeof v === 'string' && v) return ids.has(v) ? v : undefined;
    if (given(v)) V().fail(name + ' must be text');
    return undefined;
  }
  // `goals` and `entries` are the already cleaned collections the links point at.
  function cleanActivities(list_, goals, entries) {
    if (list_ === undefined) return [];
    const seen = new Set(), gids = new Set((goals || []).map((g) => g.id)), used = new Set();
    const eids = new Map((entries || []).filter((e) => e.domain === 'money' && e.type === 'expense').map((e) => [e.id, e.date]));
    return V().arr(list_, ACTIVITY_CAP, 'activities').map((x) => {
      const id = H().ident(x, seen, 'activity');
      const o = { id, title: T(x.title, 200, 'activity title'), category: T(x.category, 40, 'activity category'), state: V().oneOf(x.state, STATES, 'activity state') };
      o.date = H().reqDate(x.date, 'activity date');
      const end = H().optDate(x.endDate, 'end date');
      if (end) {
        if (end < o.date) V().fail('end date is before the start date');
        if (D().daysBetween(end, o.date) > MAX_SPAN) V().fail('an activity spans up to ' + MAX_SPAN + ' days');
        if (end > o.date) o.endDate = end;
      }
      const mins = H().optInt(x.minutes, 1, MAX_MIN, 'minutes'); if (mins !== undefined) o.minutes = mins;
      o.place = T(x.place, 200, 'place', true);
      o.withPeople = cleanPeople(x.withPeople);
      const cost = H().optInt(x.costCents, 0, MAX_CENTS, 'cost'); if (cost !== undefined) o.costCents = cost;
      const eid = link(x.expenseId, eids, 'expense link');
      if (eid && !used.has(eid)) { o.expenseId = eid; used.add(eid); } // one expense links to one done activity
      const paid = H().optDate(x.paidOn, 'paid date'); if (paid) o.paidOn = paid;
      // A linked expense means the cost is in Money: it is paid, so it can never also count as committed (audit v0.9.0).
      if (o.expenseId && !o.paidOn) o.paidOn = eids.get(o.expenseId);
      const ret = H().optInt(x.returnCents, 0, MAX_CENTS, 'return'); if (ret !== undefined) o.returnCents = ret;
      const worth = H().optInt(x.worthIt, 1, 5, 'worth-it rating'); if (worth !== undefined) o.worthIt = worth;
      o.alsoHealth = V().bool(x.alsoHealth, 'alsoHealth', false);
      if (o.alsoHealth && given(x.healthKind)) o.healthKind = T(x.healthKind, KIND_MAX, 'health type');
      o.alsoSocial = V().bool(x.alsoSocial, 'alsoSocial', false);
      const gid = link(x.goalId, gids, 'goal link'); if (gid) o.goalId = gid;
      o.notes = T(x.notes, 2000, 'notes', true);
      if (x.createdAt !== undefined && x.createdAt !== null) o.createdAt = V().ts(x.createdAt, 'createdAt');
      return o;
    });
  }

  // ---- legacy: activities/session entries from before schema 8 become done activities ----
  // Each keeps its id, title, date, notes (in full) and createdAt. Only a session past the 5,000 cap stays an entry, visible and
  // deletable under Activities. Nothing is dropped.
  function legacy(entries, newId, cap) {
    const acts = [], gone = new Set(), max = cap || ACTIVITY_CAP;
    for (const e of entries) {
      if (e.domain !== 'activities' || e.type !== 'session' || acts.length >= max) continue;
      const o = { id: typeof e.id === 'string' && e.id && e.id.length <= 100 ? e.id : newId(), title: e.title, category: 'other', state: 'done', date: e.date, place: '', withPeople: [], alsoHealth: false, alsoSocial: false, notes: e.notes || '' };
      if (e.createdAt !== undefined) o.createdAt = e.createdAt;
      acts.push(o); gone.add(e);
    }
    return { activities: acts, entries: entries.filter((e) => !gone.has(e)) };
  }
  const legacyEntries = (state) => list(state, 'entries').filter((e) => e.domain === 'activities').sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  const hasData = (state) => list(state, 'activities').length > 0;
  // Computed numbers drive the tile, digest and series once there are activities or no older entries; until then the older count.
  const current = (state) => hasData(state) || !legacyEntries(state).length;

  // ---- categories ----
  const categories = (state) => (Array.isArray(state && state.activityCategories) ? state.activityCategories : DEFAULT_CATEGORIES.slice());
  // The editable list first, then any other category an activity still carries (its list entry was removed), alphabetically.
  function categoriesInUse(state) {
    const out = categories(state).slice(), seen = new Set(out.map((c) => c.toLowerCase())), extra = new Map();
    for (const a of list(state, 'activities')) if (!seen.has(a.category.toLowerCase()) && !extra.has(a.category.toLowerCase())) extra.set(a.category.toLowerCase(), a.category);
    return out.concat([...extra.values()].sort((a, b) => a.localeCompare(b)));
  }
  const catKey = (c) => String(c).toLowerCase();

  // ---- days, weeks ----
  // Distinct days with a done activity inside [ws, we]; a multi-day activity covers each of its days.
  function activeDaySet(state, ws, we) {
    const days = new Set();
    for (const a of list(state, 'activities')) {
      if (!isDone(a) || a.date > we || spanEnd(a) < ws) continue;
      const end = spanEnd(a) < we ? spanEnd(a) : we;
      for (let d = a.date > ws ? a.date : ws; d <= end; d = D().addDays(d, 1)) days.add(d);
    }
    return days;
  }
  const activeDays = (state, ws, we) => activeDaySet(state, ws, we).size;
  function weekStats(state, ws, asOf) {
    ws = weekStart(ws);
    const we = D().addDays(ws, 6), end = asOf && asOf < we ? asOf : we;
    let done = 0, spendCents = 0, minutes = 0;
    for (const a of list(state, 'activities')) if (isDone(a) && a.date >= ws && a.date <= end) { done++; spendCents += a.costCents || 0; minutes += a.minutes || 0; }
    return { week: ws, days: activeDays(state, ws, end), done, spendCents, minutes };
  }
  const weekValue = (state, we) => activeDays(state, weekStart(we), we);

  // ---- upcoming: planned activities in a rolling 30-day window, grouped today / this week / later ----
  // The window is today through today + 29. An activity that is under way (started, not ended) is "today"; a planned activity whose
  // last day has passed is overdue, not upcoming. Everything is computed from dates; nothing is stored, so items move forward by
  // themselves as the days pass.
  function group(items, today) {
    const ws = weekStart(today), we = D().addDays(ws, 6), winEnd = D().addDays(today, WINDOW_DAYS - 1);
    const out = { today: [], week: [], later: [], windowEnd: winEnd, weekEnd: we, count: 0, committedCents: 0, nextDate: null };
    for (const a of items) {
      const s = a.date, e = a.endDate || a.date;
      if (e < today || s > winEnd) continue;
      (s <= today ? out.today : s <= we ? out.week : out.later).push(a);
      out.count++; if (!a.paid) out.committedCents += a.costCents || 0;
      const eff = s > today ? s : today;
      if (out.nextDate === null || eff < out.nextDate) out.nextDate = eff;
    }
    out.today.sort(byDate); out.week.sort(byDate); out.later.sort(byDate);
    return out;
  }
  const upcoming = (state, today) => group(list(state, 'activities').filter((a) => a.state === 'planned').map((a) => (a.paidOn ? Object.assign({}, a, { paid: true }) : a)), today);
  const overduePlanned = (state, today) => list(state, 'activities').filter((a) => a.state === 'planned' && spanEnd(a) < today).sort(byDate);
  // Committed cost: planned costs inside the 30-day window. Not in Money until the activity is done and the user accepts the expense.
  const committed = (state, today) => upcoming(state, today).committedCents;

  // ---- at a glance: a provider list, so other domains can add upcoming items later without rework ----
  const providers = new Map();
  const PID = /^[a-z][a-z0-9-]{0,30}$/;
  function registerGlanceProvider(p) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !PID.test(p.id)) throw new Error('A provider needs an id of lowercase letters, digits and dashes');
    if (typeof p.label !== 'string' || !p.label.trim() || p.label.length > 40) throw new Error('A provider needs a label of up to 40 characters');
    if (typeof p.items !== 'function') throw new Error('A provider needs an items function');
    if (providers.has(p.id)) throw new Error('A provider with that id is already registered');
    providers.set(p.id, { id: p.id, label: p.label.trim(), items: p.items });
    return () => providers.delete(p.id);
  }
  const unregisterGlanceProvider = (id) => providers.delete(id);
  const glanceProviders = () => [...providers.values()].map((p) => ({ id: p.id, label: p.label }));
  // A provider item is untrusted: {id, title, date, endDate?, costCents?}. Bad items are skipped, a throwing provider is skipped.
  function providerItems(p, state, today) {
    let raw;
    try { raw = p.items(state, today); } catch (e) { return []; }
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const x of raw.slice(0, GLANCE_CAP * 5)) {
      if (out.length >= GLANCE_CAP) break;
      if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !x.id || x.id.length > 100 || typeof x.title !== 'string' || !x.title || x.title.length > 200) continue;
      if (!D().isDate(x.date)) continue;
      const o = { source: p.id, sourceLabel: p.label, id: x.id, title: x.title, date: x.date };
      if (x.endDate !== undefined && x.endDate !== null) { if (!D().isDate(x.endDate) || x.endDate < x.date) continue; if (x.endDate > x.date) o.endDate = x.endDate; }
      if (x.paid === true) o.paid = true;
      if (x.costCents !== undefined && x.costCents !== null) { if (!Number.isInteger(x.costCents) || x.costCents < 0 || x.costCents > MAX_CENTS) continue; o.costCents = x.costCents; }
      out.push(o);
    }
    return out;
  }
  function glance(state, today) {
    if (!D().isDate(today)) throw new Error('Date must be YYYY-MM-DD');
    const items = [];
    for (const p of providers.values()) for (const x of providerItems(p, state, today)) items.push(x);
    const g = group(items, today);
    g.providers = glanceProviders();
    return g;
  }
  registerGlanceProvider({
    id: 'activities', label: 'Activities',
    items: (state) => list(state, 'activities').filter((a) => a.state === 'planned').map((a) => ({ id: a.id, title: a.title, date: a.date, endDate: a.endDate, costCents: a.paidOn ? undefined : a.costCents, paid: !!a.paidOn })),
  });

  // ---- cost and ROI (done activities only; integer cents; a category with nothing to average shows null = "no data", never zero) ----
  const doneList = (state) => list(state, 'activities').filter(isDone);
  const costed = (a) => typeof a.costCents === 'number';
  const costPerActivity = (state) => doneList(state).filter(costed).sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title)).map((a) => ({ id: a.id, title: a.title, date: a.date, category: a.category, costCents: a.costCents }));
  const costMonths = (state) => [...new Set(doneList(state).filter(costed).map((a) => monthOf(a.date)))].sort().reverse();
  // Cost by category for one month (YYYY-MM): [{category, count, cents|null}] plus the total.
  function costByCategory(state, month) {
    if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) throw new Error('Month must be YYYY-MM');
    const sums = new Map();
    for (const a of doneList(state)) if (costed(a) && monthOf(a.date) === month) { const g = sums.get(catKey(a.category)) || { count: 0, cents: 0 }; g.count++; g.cents += a.costCents; sums.set(catKey(a.category), g); }
    let n = 0, c = 0;
    const rows = categoriesInUse(state).map((category) => { const g = sums.get(catKey(category)); if (g) { n += g.count; c += g.cents; } return { category, count: g ? g.count : 0, cents: g ? g.cents : null }; });
    return { month, rows, total: { count: n, cents: n ? c : null } };
  }
  // Cost per hour: only activities with a cost and minutes above zero; cents per hour rounded to a whole cent.
  const perHour = (cents, minutes) => (minutes > 0 ? Math.round(cents * 60 / minutes) : null);
  function costPerHour(state) {
    const items = [], by = new Map();
    let tc = 0, tm = 0, tn = 0;
    for (const a of doneList(state)) {
      if (!costed(a) || !(a.minutes > 0)) continue;
      items.push({ id: a.id, title: a.title, date: a.date, category: a.category, costCents: a.costCents, minutes: a.minutes, centsPerHour: perHour(a.costCents, a.minutes) });
      const g = by.get(catKey(a.category)) || { count: 0, cents: 0, minutes: 0 }; g.count++; g.cents += a.costCents; g.minutes += a.minutes; by.set(catKey(a.category), g);
      tc += a.costCents; tm += a.minutes; tn++;
    }
    const rows = categoriesInUse(state).map((category) => { const g = by.get(catKey(category)); return { category, count: g ? g.count : 0, centsPerHour: g ? perHour(g.cents, g.minutes) : null }; });
    return { items: items.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title)), rows, total: { count: tn, centsPerHour: tn ? perHour(tc, tm) : null } };
  }
  const avgOf = (sum, n) => (n > 0 ? r2(sum / n) : null);
  function avgWorth(state) {
    const by = new Map();
    let ts = 0, tn = 0;
    for (const a of doneList(state)) if (typeof a.worthIt === 'number') { const g = by.get(catKey(a.category)) || { n: 0, sum: 0 }; g.n++; g.sum += a.worthIt; by.set(catKey(a.category), g); ts += a.worthIt; tn++; }
    return { rows: categoriesInUse(state).map((category) => { const g = by.get(catKey(category)); return { category, rated: g ? g.n : 0, avg: g ? avgOf(g.sum, g.n) : null }; }), total: { rated: tn, avg: avgOf(ts, tn) } };
  }
  // Financial return minus cost, only for activities where a return was entered (a missing cost counts as 0).
  function returns(state) {
    const items = [], by = new Map();
    let tr = 0, tc = 0, tn = 0;
    for (const a of doneList(state)) {
      if (typeof a.returnCents !== 'number') continue;
      const c = a.costCents || 0;
      items.push({ id: a.id, title: a.title, date: a.date, category: a.category, returnCents: a.returnCents, costCents: c, netCents: a.returnCents - c });
      const g = by.get(catKey(a.category)) || { count: 0, ret: 0, cost: 0 }; g.count++; g.ret += a.returnCents; g.cost += c; by.set(catKey(a.category), g);
      tr += a.returnCents; tc += c; tn++;
    }
    const rows = categoriesInUse(state).map((category) => { const g = by.get(catKey(category)); return { category, count: g ? g.count : 0, returnCents: g ? g.ret : null, costCents: g ? g.cost : null, netCents: g ? g.ret - g.cost : null }; });
    return { items: items.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title)), rows, total: { count: tn, returnCents: tn ? tr : null, costCents: tn ? tc : null, netCents: tn ? tr - tc : null } };
  }
  const roi = (state, month) => ({ perActivity: costPerActivity(state), byCategory: costByCategory(state, month), perHour: costPerHour(state), worth: avgWorth(state), returns: returns(state) });
  // Spend: done activities' own cost in a date range (the linked Money expense is the same money and is never added on top).
  function spend(state, a, b) {
    let c = 0;
    for (const x of doneList(state)) if (costed(x) && x.date >= a && x.date <= b) c += x.costCents;
    return c;
  }

  // ---- other domains: computed from the activity, no duplicate entry is ever stored ----
  // Done activities tagged for Health, counted as workout sessions on their start date.
  const healthSessions = (state, ws, we) => doneList(state).filter((a) => a.alsoHealth && a.date >= ws && a.date <= we).sort(byDate);
  // Last contact per person (lower-case name) from done, social-tagged activities on or before asOf; a multi-day activity counts up to its last day so far.
  function contacts(state, asOf) {
    const last = new Map();
    for (const a of doneList(state)) {
      if (!a.alsoSocial || a.date > asOf) continue;
      const d = spanEnd(a) < asOf ? spanEnd(a) : asOf;
      for (const name of a.withPeople) { const k = name.toLowerCase(), c = last.get(k); if (!c || d > c.date) last.set(k, { name, date: d, activityId: a.id, title: a.title }); }
    }
    return last;
  }
  // Same-day duplicates of a manual workout or contact: a notice only. Nothing is removed until removeDuplicate is called by a tap.
  function duplicates(state) {
    const out = [], ents = list(state, 'entries');
    for (const a of doneList(state)) {
      if (a.alsoHealth) for (const e of ents) if (e.domain === 'health' && e.type === 'workout' && e.date === a.date) out.push({ kind: 'health', activityId: a.id, entryId: e.id, date: a.date });
      if (a.alsoSocial && a.withPeople.length) {
        const names = new Set(a.withPeople.map((n) => n.toLowerCase()));
        for (const e of ents) if (e.domain === 'social' && e.type === 'contact' && e.date === a.date && names.has(String(e.person).toLowerCase())) out.push({ kind: 'social', activityId: a.id, entryId: e.id, date: a.date });
      }
    }
    return out;
  }
  function removeDuplicate(state, activityId, entryId) {
    const d = duplicates(state).find((x) => x.activityId === activityId && x.entryId === entryId);
    if (!d) throw new Error('That entry is no longer a duplicate of the activity');
    state.entries = state.entries.filter((e) => e.id !== entryId);
  }

  // ---- Money offer: never automatic ----
  // A cost counts in Money at the earlier of: the user confirming it is paid (paidOn, possibly while still planned), or the
  // activity being marked done while still unpaid (dated the activity date). Unpaid planned or skipped cost is only "committed".
  // The offer exists until the one expense is created; nothing is created by itself.
  function expenseOffer(state, id) {
    const a = list(state, 'activities').find((x) => x.id === id);
    if (!a || !(a.costCents > 0) || a.expenseId) return null;
    if (!a.paidOn && !isDone(a)) return null;
    const cats = (state.categories && state.categories.expense) || [];
    const hit = cats.find((c) => c.toLowerCase() === a.category.toLowerCase()) || cats.find((c) => c.toLowerCase() === 'other') || '';
    return { id: a.id, title: a.title, date: a.paidOn || a.date, costCents: a.costCents, category: hit, paid: !!a.paidOn };
  }
  const offers = (state, today) => list(state, 'activities').filter((a) => expenseOffer(state, a.id) && (a.state === 'planned' || a.date >= D().addDays(today, -OFFER_DAYS) || (a.paidOn && a.paidOn >= D().addDays(today, -OFFER_DAYS)))).sort(byDate).map((a) => expenseOffer(state, a.id));
  function createExpense(state, id) {
    const a = find(state, id);
    if (a.expenseId) throw new Error('This activity already has a Money expense');
    const o = expenseOffer(state, id);
    if (!o) throw new Error(a.costCents > 0 ? 'Mark it paid or done before adding its cost to Money' : 'This activity has no cost to add');
    const p = { domain: 'money', type: 'expense', date: o.date, title: o.title, value: o.costCents / 100 };
    if (o.category) p.category = o.category;
    const e = L.metrics.validateEntry(p);
    state.entries = list(state, 'entries').concat([e]);
    a.expenseId = e.id; if (!a.paidOn) a.paidOn = o.date;
    return e;
  }
  // The user confirms payment while the activity is still planned (prepaid tickets, a deposit). Only records paidOn; the expense is then offered.
  function markPaid(state, id, date) {
    const a = find(state, id);
    if (a.state !== 'planned') throw new Error('Only a planned activity can be marked paid');
    if (!(a.costCents > 0)) throw new Error('Enter a cost before marking it paid');
    if (a.paidOn) throw new Error('This activity is already marked paid');
    a.paidOn = dateOf(date, 'Paid date');
    return a;
  }

  // ---- summaries ----
  function headline(state, today, R) {
    const ws = weekStart(today), days = activeDays(state, ws, D().addDays(ws, 6)), up = upcoming(state, today);
    const sub = (up.nextDate ? 'Next planned ' + up.nextDate : 'Nothing planned') + ', ' + L.metrics.fmtMoney(up.committedCents / 100, (state.settings || {}).currency) + ' committed in 30 days';
    return R('Active days this week', String(days), days, sub);
  }
  // Numbers only: never a title, place, person, category or note.
  function digest(state, ws) {
    const we = D().addDays(ws, 6), from = D().addDays(we, 1), n7 = D().addDays(we, 7), n30 = D().addDays(we, 30);
    let done = 0, spendCents = 0, rs = 0, rn = 0, health = 0, social = 0, p7 = 0, p30 = 0, committedCents = 0;
    for (const a of list(state, 'activities')) {
      if (isDone(a) && a.date >= ws && a.date <= we) {
        done++; spendCents += a.costCents || 0; if (typeof a.worthIt === 'number') { rs += a.worthIt; rn++; }
        if (a.alsoHealth) health++; if (a.alsoSocial) social++;
      } else if (a.state === 'planned' && a.date >= from && a.date <= n30) { p30++; if (!a.paidOn) committedCents += a.costCents || 0; if (a.date <= n7) p7++; }
    }
    return { done, planned7: p7, planned30: p30, spendCents, committedCents, avgRating: rn ? r2(rs / rn) : 0, healthTagged: health, socialTagged: social };
  }
  // Weekly review step: past-date planned activities, done activities still to rate, and the Money offers.
  function reviewWeek(state, wk, today) {
    const ws = weekStart(wk), we = D().addDays(ws, 6), now = today && today < we ? today : we;
    const since = D().addDays(now, -RATE_DAYS);
    return {
      asOf: now, stats: weekStats(state, ws, now), pastPlanned: overduePlanned(state, now),
      toRate: doneList(state).filter((a) => typeof a.worthIt !== 'number' && a.date >= since && a.date <= now).sort(byDate),
      offers: offers(state, now),
    };
  }

  // ---- goal metrics: null is "no data yet" ----
  function goalCount(state, asOf) {
    if (!hasData(state)) return null;
    const m = monthOf(asOf);
    return doneList(state).filter((a) => monthOf(a.date) === m && a.date <= asOf).length;
  }
  function goalSpend(state, asOf) {
    const m = monthOf(asOf), c = doneList(state).filter((a) => costed(a) && monthOf(a.date) === m && a.date <= asOf);
    return c.length ? c.reduce((s, a) => s + a.costCents, 0) / 100 : null;
  }
  // Average worth-it rating over every rated done activity up to asOf.
  function goalRating(state, asOf) {
    const r = doneList(state).filter((a) => typeof a.worthIt === 'number' && a.date <= asOf);
    return r.length ? avgOf(r.reduce((s, a) => s + a.worthIt, 0), r.length) : null;
  }

  // ---- mutators (run inside store.commit; nothing here is called automatically) ----
  const find = (state, id) => { const a = list(state, 'activities').find((x) => x.id === id); if (!a) throw new Error('Activity not found'); return a; };
  const checkText = (...fields) => { for (const f of fields) if (L.admin.looksSecret(f)) throw new Error(SECRET_MESSAGE); };
  const dateOf = (v, name) => { if (!D().isDate(v)) throw new Error(name + ' must be a valid date'); return v; };
  function peopleFrom(v) {
    const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\n]/) : [];
    if (!Array.isArray(v) && typeof v !== 'string' && given(v)) throw new Error('People must be text');
    const seen = new Set(), out = [];
    for (const n of raw) {
      if (typeof n !== 'string') throw new Error('People must be text');
      const name = n.replace(/[​-‏‪-‮⁠-⁩﻿]/g, '').trim();
      if (!name) continue;
      if (name.length > NAME_MAX) throw new Error('A name can be up to ' + NAME_MAX + ' characters');
      if (!seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); out.push(name); }
    }
    if (out.length > PEOPLE_MAX) throw new Error('You can list up to ' + PEOPLE_MAX + ' people');
    return out;
  }
  function bool(v, name) { if (typeof v !== 'boolean') throw new Error(name + ' must be true or false'); return v; }
  function toRating(v) {
    const s = String(v).trim();
    if (!/^[1-5]$/.test(s)) throw new Error('The worth-it rating is a whole number from 1 to 5');
    return +s;
  }
  // Fields shared by add and update; returns the cleaned record, or throws without touching state.
  function build(state, base, input) {
    const o = Object.assign({}, base);
    if ('title' in input) { if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('Enter a title.'); o.title = input.title; }
    if ('category' in input) {
      const c = typeof input.category === 'string' ? input.category.trim().toLowerCase() : '';
      const hit = categories(state).find((x) => x.toLowerCase() === c);
      if (!hit) throw new Error('Pick a category from the list');
      o.category = hit;
    }
    if ('date' in input) o.date = dateOf(input.date, 'Date');
    if ('endDate' in input) { if (given(input.endDate)) o.endDate = dateOf(input.endDate, 'End date'); else delete o.endDate; }
    if (o.endDate !== undefined) {
      if (o.endDate < o.date) throw new Error('The end date cannot be before the start date.');
      if (o.endDate === o.date) delete o.endDate;
      else if (D().daysBetween(o.endDate, o.date) > MAX_SPAN) throw new Error('An activity can span up to ' + MAX_SPAN + ' days.');
    }
    if ('minutes' in input) { const m = H().toInt(input.minutes, 1, MAX_MIN, 'Minutes'); if (m === undefined) delete o.minutes; else o.minutes = m; }
    if ('place' in input) { o.place = typeof input.place === 'string' ? input.place : ''; checkText(o.place); }
    if ('people' in input) o.withPeople = peopleFrom(input.people);
    if ('cost' in input) {
      const c = H().toCents(input.cost, 'Cost');
      if (o.expenseId && c !== o.costCents && !(c > 0)) throw new Error('This cost is in Money. To remove it, delete its expense in Money first.');
      if (c === undefined) delete o.costCents; else o.costCents = c;
    }
    if ('returnAmount' in input) { const c = H().toCents(input.returnAmount, 'Return'); if (c === undefined) delete o.returnCents; else o.returnCents = c; }
    if ('worthIt' in input) {
      if (!given(input.worthIt)) delete o.worthIt;
      else { if (o.state !== 'done') throw new Error('Rate an activity once it is done.'); o.worthIt = toRating(input.worthIt); }
    }
    if ('alsoHealth' in input) o.alsoHealth = bool(input.alsoHealth, 'Health tag');
    if ('healthKind' in input) {
      if (!given(input.healthKind)) delete o.healthKind;
      else {
        const k = typeof input.healthKind === 'string' ? input.healthKind.trim().toLowerCase() : '';
        const hit = list(state, 'kinds').find((x) => x.toLowerCase() === k);
        if (!hit) throw new Error('Pick a workout type from the Health list');
        o.healthKind = hit;
      }
    }
    if (!o.alsoHealth) delete o.healthKind;
    if ('alsoSocial' in input) o.alsoSocial = bool(input.alsoSocial, 'Social tag');
    if ('goalId' in input) {
      if (!given(input.goalId)) delete o.goalId;
      else if (!list(state, 'goals').some((g) => g.id === input.goalId)) throw new Error('Goal not found');
      else o.goalId = input.goalId;
    }
    if ('notes' in input) {
      const n = typeof input.notes === 'string' ? input.notes : '';
      // A typed note is a short line (SEC-49 pattern). validateState still accepts 2,000 characters so notes carried over from older entries keep their full text.
      if (n.trim().length > NOTE_MAX) throw new Error('A note can be up to ' + NOTE_MAX + ' characters');
      o.notes = n; checkText(n);
    }
    return o;
  }
  function addActivity(state, input, today) {
    if (!V().isObj(input)) throw new Error('Activity must be an object');
    if (list(state, 'activities').length >= ACTIVITY_CAP) throw new Error('You can keep up to ' + ACTIVITY_CAP + ' activities');
    const t = D().isDate(today) ? today : L.metrics.todayISO(), date = given(input.date) ? dateOf(input.date, 'Date') : t;
    if (given(input.state) && !STATES.includes(input.state)) throw new Error('Unknown state');
    const cats = categories(state);
    if (!cats.length) throw new Error('Add a category first');
    const dflt = cats.find((c) => c.toLowerCase() === 'other') || cats[0];
    const base = { id: L.store.newId(), title: '', category: dflt, state: given(input.state) ? input.state : date >= t ? 'planned' : 'done', date, place: '', withPeople: [], alsoHealth: false, alsoSocial: false, notes: '', createdAt: new Date().toISOString() };
    const clean = cleanActivities([build(state, base, Object.assign({}, input, { title: input.title }))], state.goals, state.entries)[0];
    state.activities = list(state, 'activities').concat([clean]);
    return clean;
  }
  const EDITABLE = ['title', 'category', 'date', 'endDate', 'minutes', 'place', 'people', 'cost', 'returnAmount', 'alsoHealth', 'healthKind', 'alsoSocial', 'goalId', 'notes'];
  function updateActivity(state, id, patch) {
    const a = find(state, id);
    if (!V().isObj(patch)) throw new Error('Nothing to change');
    for (const k of Object.keys(patch)) if (!EDITABLE.includes(k)) throw new Error('That field cannot be changed');
    const clean = cleanActivities([build(state, a, patch)], state.goals, state.entries)[0];
    // A new cost on an activity whose cost is already in Money changes that one expense in the same commit, so the two never
    // disagree and nothing is counted twice. Only an expense that still holds the old amount is changed (audit v0.9.0).
    if (a.expenseId && clean.expenseId === a.expenseId && clean.costCents !== a.costCents) {
      const e = list(state, 'entries').find((x) => x.id === a.expenseId && x.domain === 'money' && x.type === 'expense');
      if (!e || Math.round(e.value * 100) !== a.costCents) throw new Error('The Money expense no longer matches this cost. Delete that expense in Money first to change it.');
      e.value = clean.costCents / 100;
    }
    for (const k of Object.keys(a)) delete a[k];
    Object.assign(a, clean);
    return a;
  }
  // Moving between states is always a tap. Marking done only OFFERS the Money expense (see expenseOffer); it never creates one.
  function setState(state, id, to) {
    const a = find(state, id);
    if (!STATES.includes(to)) throw new Error('Unknown state');
    if (to !== 'done') delete a.worthIt;
    a.state = to;
    return a;
  }
  const markDone = (state, id) => setState(state, id, 'done');
  const markSkipped = (state, id) => setState(state, id, 'skipped');
  // New start date; a multi-day activity keeps its length.
  function reschedule(state, id, date) {
    const a = find(state, id);
    dateOf(date, 'Date');
    if (a.state === 'done') throw new Error('A done activity cannot be rescheduled');
    const len = a.endDate ? D().daysBetween(a.endDate, a.date) : 0;
    a.date = date;
    if (a.endDate) { const e = D().addDays(date, len); if (e > D().MAX_DATE) throw new Error('That date is out of range'); a.endDate = e; }
    a.state = 'planned';
    return a;
  }
  function rate(state, id, value) {
    const a = find(state, id);
    if (!isDone(a)) throw new Error('Rate an activity once it is done.');
    if (!given(value)) delete a.worthIt; else a.worthIt = toRating(value);
    return a;
  }
  // Deleting an activity never deletes its Money expense; the expense is the user's Money record and stays.
  function deleteActivity(state, id) {
    const a = find(state, id);
    state.activities = state.activities.filter((x) => x.id !== id);
    return { keptExpense: !!a.expenseId };
  }
  function addCategory(state, name) {
    const v = typeof name === 'string' ? name.replace(/[​-‏‪-‮⁠-⁩﻿]/g, '').trim() : '';
    if (!v) throw new Error('Enter a category.');
    if (v.length > 40) throw new Error('A category is up to 40 characters.');
    const cats = categories(state);
    if (cats.length >= CATEGORY_CAP) throw new Error('You can keep up to ' + CATEGORY_CAP + ' categories.');
    if (cats.some((c) => c.toLowerCase() === v.toLowerCase())) throw new Error('That category already exists.');
    state.activityCategories = cats.concat([v]);
    return v;
  }
  // Activities in a removed category keep the name.
  function removeCategory(state, name) {
    const cats = categories(state);
    if (!cats.includes(name)) throw new Error('Category not found');
    state.activityCategories = cats.filter((c) => c !== name);
  }

  L.activities = {
    ACTIVITY_CAP, CATEGORY_CAP, PEOPLE_MAX, NOTE_MAX, WINDOW_DAYS, STATES, STATE_LABEL, DEFAULT_CATEGORIES, SECRET_MESSAGE,
    cleanCategories, cleanActivities, legacy, legacyEntries, hasData, current, categories, categoriesInUse,
    activeDaySet, activeDays, weekStats, weekValue, upcoming, overduePlanned, committed,
    registerGlanceProvider, unregisterGlanceProvider, glanceProviders, glance,
    costPerActivity, costMonths, costByCategory, costPerHour, avgWorth, returns, roi, spend,
    healthSessions, contacts, duplicates, removeDuplicate, expenseOffer, offers, createExpense,
    headline, digest, reviewWeek, goalCount, goalSpend, goalRating,
    addActivity, updateActivity, setState, markDone, markSkipped, markPaid, reschedule, rate, deleteActivity, addCategory, removeCategory,
  };
})();
