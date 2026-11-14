(function () {
  'use strict';
  // Learning (schema 7): learning items, study sessions, takeaways and a weekly study target. Pure functions over state; every
  // mutator runs inside store.commit and changes only what the user tapped. Review actions (pause, drop, new target date) are
  // only offered, never taken. Dates are local YYYY-MM-DD strings handled as calendar days, so a time zone or DST change can
  // never move a week. Titles, providers, notes and takeaways never leave the vault: the digest holds numbers only.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const V = () => L.validate;
  const H = () => L.home;
  const D = () => L.home.dates;

  const ITEM_CAP = 1000, SESSION_CAP = 20000, TAKEAWAY_CAP = 5000;
  const MAX_SESSION_MIN = 1440, SESSION_NOTE_MAX = 200, MAX_WEEK_MIN = 10080, MAX_UNITS = 1e6, TAKEAWAY_MAX = 1000, STALL_DAYS = 14, SEARCH_MAX = 100;
  const KINDS = Object.freeze(['course', 'book', 'certification', 'skill', 'project', 'other']);
  const KIND_LABEL = Object.freeze({ course: 'Course', book: 'Book', certification: 'Certification', skill: 'Skill', project: 'Project', other: 'Other' });
  const STATES = Object.freeze(['planned', 'active', 'paused', 'done', 'dropped']);
  const STATE_LABEL = Object.freeze({ planned: 'Planned', active: 'Active', paused: 'Paused', done: 'Done', dropped: 'Dropped' });
  const SECRET_MESSAGE = 'That looks like an ID number or a card number. Do not enter ID numbers, account numbers or passwords here.';

  const list = (state, k) => (state && Array.isArray(state[k]) ? state[k] : []);
  const T = (v, max, name, empty) => H().text(v, max, name, empty);
  const r2 = (x) => Math.round(x * 100) / 100;
  const given = (v) => v !== undefined && v !== null && v !== '';
  const weekStart = (d) => L.metrics.weekStart(d);

  // ---- validation (rebuilds every record from whitelists, with caps) ----
  function cleanSettings(x) {
    if (x === undefined) return { weeklyMinutes: 0 };
    if (!V().isObj(x)) V().fail('learning settings');
    return { weeklyMinutes: x.weeklyMinutes === undefined ? 0 : V().num(x.weeklyMinutes, 0, MAX_WEEK_MIN, 'weekly study minutes', true) };
  }
  // A goal link that points at nothing is dropped and the item kept; a non-text link refuses the state.
  function cleanItems(list_, goals) {
    if (list_ === undefined) return [];
    const seen = new Set(), gids = new Set((goals || []).map((g) => g.id));
    return V().arr(list_, ITEM_CAP, 'learning items').map((x) => {
      const id = H().ident(x, seen, 'learning item');
      const o = { id, title: T(x.title, 200, 'item title'), kind: V().oneOf(x.kind, KINDS, 'item kind'), provider: T(x.provider, 200, 'provider', true), state: V().oneOf(x.state, STATES, 'item state') };
      const hasPct = given(x.progressPct), hasTot = given(x.totalUnits), hasDone = given(x.doneUnits);
      if (hasPct && (hasTot || hasDone)) V().fail('progress is a percent or units, not both');
      if (hasPct) o.progressPct = r2(V().num(x.progressPct, 0, 100, 'progress'));
      else if (hasTot || hasDone) {
        if (!hasTot) V().fail('units need a total');
        o.totalUnits = V().num(x.totalUnits, 0, MAX_UNITS, 'total units', true);
        o.doneUnits = hasDone ? V().num(x.doneUnits, 0, MAX_UNITS, 'done units', true) : 0;
        if (o.doneUnits > o.totalUnits) V().fail('done units are more than the total');
        o.unitLabel = T(x.unitLabel, 30, 'unit label', true);
      }
      for (const [k, name] of [['startDate', 'start date'], ['targetDate', 'target date'], ['finishedDate', 'finished date'], ['examDate', 'exam date'], ['expiresOn', 'expiry date']]) {
        const d = H().optDate(x[k], name); if (d) o[k] = d;
      }
      if (typeof x.goalId === 'string' && x.goalId) { if (gids.has(x.goalId)) o.goalId = x.goalId; }
      else if (given(x.goalId)) V().fail('goal link must be text');
      o.notes = T(x.notes, 2000, 'notes', true);
      if (x.createdAt !== undefined && x.createdAt !== null) o.createdAt = V().ts(x.createdAt, 'createdAt');
      return o;
    });
  }
  function itemLink(x, ids) {
    if (typeof x.itemId === 'string' && x.itemId) return ids.has(x.itemId) ? x.itemId : undefined;
    if (given(x.itemId)) V().fail('item link must be text');
    return undefined;
  }
  function cleanSessions(list_, items) {
    if (list_ === undefined) return [];
    const seen = new Set(), ids = new Set((items || []).map((i) => i.id));
    return V().arr(list_, SESSION_CAP, 'study sessions').map((x) => {
      const id = H().ident(x, seen, 'study session'), o = { id }, link = itemLink(x, ids);
      if (link) o.itemId = link;
      o.date = H().reqDate(x.date, 'session date');
      o.minutes = V().num(x.minutes, 1, MAX_SESSION_MIN, 'session minutes', true);
      o.notes = T(x.notes, 2000, 'notes', true);
      return o;
    });
  }
  function cleanTakeaways(list_, items) {
    if (list_ === undefined) return [];
    const seen = new Set(), ids = new Set((items || []).map((i) => i.id));
    return V().arr(list_, TAKEAWAY_CAP, 'takeaways').map((x) => {
      const id = H().ident(x, seen, 'takeaway'), o = { id }, link = itemLink(x, ids);
      if (link) o.itemId = link;
      o.date = H().reqDate(x.date, 'takeaway date');
      o.text = T(x.text, TAKEAWAY_MAX, 'takeaway');
      return o;
    });
  }

  // ---- progress and pace ----
  // Percent 0 to 100, or null when nothing is set. A zero total has no progress to show (never a divide by zero, never NaN).
  function progressOf(item) {
    if (!item) return null;
    if (typeof item.progressPct === 'number') return Math.max(0, Math.min(100, item.progressPct));
    if (typeof item.totalUnits === 'number' && item.totalUnits > 0) return Math.max(0, Math.min(100, (item.doneUnits || 0) / item.totalUnits * 100));
    return null;
  }
  // Same arithmetic as Goals pace: progress minus the elapsed share of startDate to targetDate, 10 point tolerance.
  function paceOf(item, asOf) {
    const p = progressOf(item);
    if (p === null || !item.startDate || !item.targetDate) return 'no-data';
    return L.goals.paceOf(p / 100, L.goals.elapsedShare({ startDate: item.startDate, dueDate: item.targetDate }, asOf));
  }
  const fmtProgress = (item) => { const p = progressOf(item); return p === null ? 'no progress set' : (Math.round(p * 10) / 10) + '%'; };
  const unitsText = (item) => (typeof item.totalUnits === 'number' && item.totalUnits > 0 ? item.doneUnits + ' of ' + item.totalUnits + (item.unitLabel ? ' ' + item.unitLabel : '') : '');

  // ---- weeks ----
  // ISO 8601 week of a date: {year, week}; the week belongs to the year that holds its Thursday.
  function weekInfo(d) {
    const ws = weekStart(d), thu = D().addDays(ws, 3);
    return { year: +thu.slice(0, 4), week: Math.floor(D().daysBetween(thu, thu.slice(0, 4) + '-01-01') / 7) + 1 };
  }
  const target = (state) => (state && state.settings && state.settings.learning && state.settings.learning.weeklyMinutes) || 0;
  function studyWeek(state, ws, asOf) {
    ws = weekStart(ws);
    const we = D().addDays(ws, 6), end = asOf && asOf < we ? asOf : we, days = new Set();
    let minutes = 0, sessions = 0;
    for (const s of list(state, 'studySessions')) if (s.date >= ws && s.date <= end) { minutes += s.minutes; sessions++; days.add(s.date); }
    const tg = target(state);
    return { week: ws, minutes, sessions, days: days.size, target: tg, met: tg > 0 ? minutes >= tg : null };
  }
  // Weeks in a row that met the target, counting back from this week. The week in progress counts once met and never breaks a run.
  function streak(state, today) {
    const tg = target(state);
    if (!(tg > 0)) return 0;
    const byWeek = new Map();
    for (const s of list(state, 'studySessions')) if (s.date <= today) { const k = weekStart(s.date); byWeek.set(k, (byWeek.get(k) || 0) + s.minutes); }
    let ws = weekStart(today), n = 0;
    if ((byWeek.get(ws) || 0) >= tg) n = 1;
    ws = D().addDays(ws, -7);
    for (let i = 0; i < 1040 && (byWeek.get(ws) || 0) >= tg; i++) { n++; ws = D().addDays(ws, -7); }
    return n;
  }

  // ---- items ----
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  const activeItems = (state) => list(state, 'learningItems').filter((i) => i.state === 'active').sort((a, b) => (a.targetDate || '9999').localeCompare(b.targetDate || '9999') || byTitle(a, b));
  function lastSession(state, id, asOf) {
    let last = '';
    for (const s of list(state, 'studySessions')) if (s.itemId === id && s.date <= asOf && s.date > last) last = s.date;
    return last;
  }
  // Active items with no session in 14 days: the last session, else the start date; an item with neither counts. A numeric fact.
  function stalled(state, asOf) {
    const latest = new Map();
    for (const s of list(state, 'studySessions')) if (s.itemId && s.date <= asOf && s.date > (latest.get(s.itemId) || '')) latest.set(s.itemId, s.date);
    return activeItems(state).filter((i) => {
      const anchor = latest.get(i.id) || i.startDate || '';
      if (i.startDate && i.startDate > asOf && !latest.get(i.id)) return false;
      return !anchor || D().daysBetween(asOf, anchor) >= STALL_DAYS;
    });
  }
  function upcomingExams(state, today) {
    return list(state, 'learningItems').filter((i) => i.examDate && i.examDate >= today && i.state !== 'dropped' && i.state !== 'done')
      .map((i) => ({ id: i.id, title: i.title, date: i.examDate, days: D().daysBetween(i.examDate, today) }))
      .sort((a, b) => a.date.localeCompare(b.date) || byTitle(a, b));
  }
  const recentlyFinished = (state, n) => list(state, 'learningItems').filter((i) => i.state === 'done').sort((a, b) => (b.finishedDate || '').localeCompare(a.finishedDate || '') || byTitle(a, b)).slice(0, n || 5);
  const finishedBy = (state, asOf) => list(state, 'learningItems').filter((i) => i.state === 'done' && i.finishedDate && i.finishedDate <= asOf).length;
  // Certification expiry as a computed Admin timeline row (admin.dated reads this; nothing is stored twice).
  const expiries = (state) => list(state, 'learningItems').filter((i) => i.kind === 'certification' && i.expiresOn && i.state !== 'dropped').map((i) => ({ id: i.id, title: i.title, date: i.expiresOn }));
  // Linked goal metric: mean progress of the items that point at this goal and have a progress set; null when there are none.
  function goalProgress(state, goalId) {
    const ps = list(state, 'learningItems').filter((i) => i.goalId === goalId && i.state !== 'dropped').map(progressOf).filter((p) => p !== null);
    return ps.length ? r2(ps.reduce((a, b) => a + b, 0) / ps.length) : null;
  }
  const hasData = (state) => list(state, 'learningItems').length + list(state, 'studySessions').length + list(state, 'takeaways').length > 0 || target(state) > 0;
  // Study minutes drive the tile, digest and series once there is Learning data or no older learning entries; until then the older count of finished items.
  const current = (state) => hasData(state) || !list(state, 'entries').some((e) => e.domain === 'learning');
  const legacyEntries = (state) => list(state, 'entries').filter((e) => e.domain === 'learning').sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  const linkedCount = (state, id) => ({ sessions: list(state, 'studySessions').filter((s) => s.itemId === id).length, takeaways: list(state, 'takeaways').filter((t) => t.itemId === id).length });

  // ---- summaries ----
  function summary(state, today) {
    const w = studyWeek(state, today, today), ex = upcomingExams(state, today);
    return { week: w, streak: streak(state, today), active: activeItems(state).length, stalled: stalled(state, today), nextExam: ex[0] || null, exams: ex };
  }
  function headline(state, today, R) {
    const s = summary(state, today), w = s.week;
    const sub = s.active + (s.active === 1 ? ' active item' : ' active items') + ', ' + (s.nextExam ? 'next exam ' + s.nextExam.date : 'no exam dated');
    return R('Study minutes this week', w.target > 0 ? w.minutes + ' of ' + w.target : String(w.minutes), w.minutes, sub);
  }
  const weekValue = (state, we) => studyWeek(state, we, we).minutes;
  // Numbers only: never a title, provider, note or takeaway.
  function digest(state, ws) {
    const we = D().addDays(ws, 6), w = studyWeek(state, ws);
    return { minutes: w.minutes, sessions: w.sessions, days: w.days, active: activeItems(state).length, finished: list(state, 'learningItems').filter((i) => i.state === 'done' && i.finishedDate && i.finishedDate >= ws && i.finishedDate <= we).length, stalled: stalled(state, we).length };
  }
  function reviewWeek(state, wk, today) {
    const ws = weekStart(wk), we = D().addDays(ws, 6), now = today && today < we ? today : we, w = studyWeek(state, ws, now);
    const per = new Map();
    for (const s of list(state, 'studySessions')) if (s.itemId && s.date >= ws && s.date <= now) per.set(s.itemId, (per.get(s.itemId) || 0) + s.minutes);
    const moved = list(state, 'learningItems').filter((i) => per.has(i.id) || (i.state === 'done' && i.finishedDate && i.finishedDate >= ws && i.finishedDate <= now))
      .map((i) => ({ item: i, minutes: per.get(i.id) || 0 })).sort((a, b) => b.minutes - a.minutes || byTitle(a.item, b.item));
    return { week: w, moved, stalled: stalled(state, now), exams: upcomingExams(state, now).filter((e) => e.days <= 28), asOf: now };
  }

  // ---- search: plain substring, never a RegExp built from what was typed ----
  function search(state, q) {
    if (typeof q !== 'string') return [];
    const needle = q.trim().toLowerCase();
    if (!needle || needle.length > SEARCH_MAX) return [];
    const titles = new Map(list(state, 'learningItems').map((i) => [i.id, i.title]));
    return list(state, 'takeaways').filter((t) => t.text.toLowerCase().includes(needle))
      .sort((a, b) => b.date.localeCompare(a.date) || a.text.localeCompare(b.text)).map((t) => ({ takeaway: t, itemTitle: t.itemId ? titles.get(t.itemId) || '' : '' }));
  }

  // ---- mutators (run inside store.commit; nothing here is called automatically) ----
  const checkText = (...fields) => { for (const f of fields) if (L.admin.looksSecret(f)) throw new Error(SECRET_MESSAGE); };
  const findItem = (state, id) => { const i = list(state, 'learningItems').find((x) => x.id === id); if (!i) throw new Error('Learning item not found'); return i; };
  const PCT_RE = /^\d{1,3}(\.\d{1,2})?$/;
  function toPct(v) {
    if (!given(v)) return undefined;
    const s = String(v).trim().replace(/%$/, '');
    if (!PCT_RE.test(s) || +s > 100) throw new Error('Progress must be a percent from 0 to 100');
    return +s;
  }
  function toUnits(v, name) {
    if (!given(v)) return undefined;
    const s = String(v).trim();
    if (!/^\d{1,7}$/.test(s) || +s > MAX_UNITS) throw new Error(name + ' must be a whole number from 0 to ' + MAX_UNITS);
    return +s;
  }
  const dateOrNone = (v, name) => { if (!given(v)) return undefined; if (!D().isDate(v)) throw new Error(name + ' must be a valid date'); return v; };
  // Fields shared by add and update; returns the cleaned record, or throws without touching state.
  function build(state, base, input) {
    const o = Object.assign({}, base);
    if ('title' in input) { if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('Enter a title.'); o.title = input.title; }
    if (input.kind !== undefined) o.kind = input.kind;
    if ('provider' in input) o.provider = input.provider || '';
    if ('notes' in input) { o.notes = input.notes || ''; checkText(o.notes); }
    for (const [k, name] of [['startDate', 'Start date'], ['targetDate', 'Target date'], ['examDate', 'Exam date'], ['expiresOn', 'Expiry date']]) {
      if (k in input) { const d = dateOrNone(input[k], name); if (d) o[k] = d; else delete o[k]; }
    }
    if ('goalId' in input) {
      if (!given(input.goalId)) delete o.goalId;
      else if (!list(state, 'goals').some((g) => g.id === input.goalId)) throw new Error('Goal not found');
      else o.goalId = input.goalId;
    }
    const pct = 'progressPct' in input ? toPct(input.progressPct) : undefined;
    const tot = 'totalUnits' in input ? toUnits(input.totalUnits, 'Total') : undefined, dn = 'doneUnits' in input ? toUnits(input.doneUnits, 'Done') : undefined;
    if (pct !== undefined && (tot !== undefined || dn !== undefined)) throw new Error('Enter a percent or units done, not both.');
    if (pct !== undefined) { o.progressPct = pct; delete o.totalUnits; delete o.doneUnits; delete o.unitLabel; }
    else if (tot !== undefined || dn !== undefined) {
      if (tot !== undefined) o.totalUnits = tot;
      if (o.totalUnits === undefined) throw new Error('Enter the total before the units done.');
      o.doneUnits = dn !== undefined ? dn : (o.doneUnits || 0);
      if (o.doneUnits > o.totalUnits) throw new Error('Units done cannot be more than the total.');
      delete o.progressPct;
    }
    if ('unitLabel' in input && o.totalUnits !== undefined) o.unitLabel = input.unitLabel || '';
    if (('progressPct' in input && !given(input.progressPct)) && ('totalUnits' in input && !given(input.totalUnits)) && !given(input.doneUnits)) { delete o.progressPct; delete o.totalUnits; delete o.doneUnits; delete o.unitLabel; }
    return o;
  }
  function addItem(state, input, today) {
    if (!V().isObj(input)) throw new Error('Item must be an object');
    if (list(state, 'learningItems').length >= ITEM_CAP) throw new Error('You can keep up to ' + ITEM_CAP + ' learning items');
    const t = D().isDate(today) ? today : L.metrics.todayISO();
    const base = { id: L.store.newId(), title: '', kind: KINDS.includes(input.kind) ? input.kind : 'course', provider: '', state: STATES.includes(input.state) ? input.state : 'active', startDate: t, notes: '', createdAt: new Date().toISOString() };
    if (input.kind !== undefined && !KINDS.includes(input.kind)) throw new Error('Unknown kind');
    if (input.state !== undefined && !STATES.includes(input.state)) throw new Error('Unknown state');
    const o = build(state, base, Object.assign({ title: input.title }, input));
    if (o.state === 'done') o.finishedDate = t;
    const clean = cleanItems([o], state.goals)[0];
    state.learningItems = list(state, 'learningItems').concat([clean]);
    return clean;
  }
  const EDITABLE = ['title', 'kind', 'provider', 'notes', 'startDate', 'targetDate', 'examDate', 'expiresOn', 'goalId', 'progressPct', 'totalUnits', 'doneUnits', 'unitLabel'];
  function updateItem(state, id, patch) {
    const i = findItem(state, id);
    if (!V().isObj(patch)) throw new Error('Nothing to change');
    for (const k of Object.keys(patch)) if (!EDITABLE.includes(k)) throw new Error('That field cannot be changed');
    if ('kind' in patch && !KINDS.includes(patch.kind)) throw new Error('Unknown kind');
    const clean = cleanItems([build(state, i, patch)], state.goals)[0];
    for (const k of Object.keys(i)) delete i[k];
    Object.assign(i, clean);
    return i;
  }
  // Moving between states is always a tap: done records the finish date, reopening clears it.
  function setState(state, id, to, today) {
    const i = findItem(state, id);
    if (!STATES.includes(to)) throw new Error('Unknown state');
    const t = D().isDate(today) ? today : L.metrics.todayISO();
    i.state = to;
    if (to === 'done') i.finishedDate = i.finishedDate || t; else delete i.finishedDate;
    return i;
  }
  const pauseItem = (state, id) => setState(state, id, 'paused');
  const dropItem = (state, id) => setState(state, id, 'dropped');
  function setTargetDate(state, id, date) {
    if (!D().isDate(date)) throw new Error('Target date must be a valid date');
    const i = findItem(state, id);
    i.targetDate = date;
    return i;
  }
  // Deleting an item keeps its sessions and takeaways and unlinks them. Returns how many of each.
  function deleteItem(state, id) {
    findItem(state, id);
    const n = linkedCount(state, id);
    for (const s of list(state, 'studySessions')) if (s.itemId === id) delete s.itemId;
    for (const t of list(state, 'takeaways')) if (t.itemId === id) delete t.itemId;
    state.learningItems = state.learningItems.filter((x) => x.id !== id);
    return n;
  }
  function addSession(state, input, today) {
    if (!V().isObj(input)) throw new Error('Session must be an object');
    if (list(state, 'studySessions').length >= SESSION_CAP) throw new Error('You can keep up to ' + SESSION_CAP + ' study sessions');
    const t = D().isDate(today) ? today : L.metrics.todayISO(), date = given(input.date) ? input.date : t;
    if (!D().isDate(date)) throw new Error('Date must be a valid date');
    const s = String(given(input.minutes) ? input.minutes : '').trim();
    if (!/^\d{1,4}$/.test(s) || +s < 1 || +s > MAX_SESSION_MIN) throw new Error('Minutes must be a whole number from 1 to ' + MAX_SESSION_MIN);
    const o = { id: L.store.newId(), date, minutes: +s, notes: typeof input.notes === 'string' ? input.notes : '' };
    // A typed session note is a short line (SEC-49): 20,000 sessions of 2,000 characters alone would pass the 64 MB backup and sync
    // limit. validateState still accepts 2,000 characters so notes carried over from older hours entries keep their full text.
    if (o.notes.trim().length > SESSION_NOTE_MAX) throw new Error('A session note can be up to ' + SESSION_NOTE_MAX + ' characters');
    if (given(input.itemId)) { findItem(state, input.itemId); o.itemId = input.itemId; }
    checkText(o.notes);
    const clean = cleanSessions([o], state.learningItems)[0];
    state.studySessions = list(state, 'studySessions').concat([clean]);
    return clean;
  }
  function deleteSession(state, id) {
    if (!list(state, 'studySessions').some((x) => x.id === id)) throw new Error('Session not found');
    state.studySessions = state.studySessions.filter((x) => x.id !== id);
  }
  function addTakeaway(state, input, today) {
    if (!V().isObj(input)) throw new Error('Takeaway must be an object');
    if (list(state, 'takeaways').length >= TAKEAWAY_CAP) throw new Error('You can keep up to ' + TAKEAWAY_CAP + ' takeaways');
    const t = D().isDate(today) ? today : L.metrics.todayISO(), date = given(input.date) ? input.date : t;
    if (!D().isDate(date)) throw new Error('Date must be a valid date');
    if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('Enter what you learned.');
    if (input.text.trim().length > TAKEAWAY_MAX) throw new Error('A takeaway can be up to ' + TAKEAWAY_MAX + ' characters');
    checkText(input.text);
    const o = { id: L.store.newId(), date, text: input.text };
    if (given(input.itemId)) { findItem(state, input.itemId); o.itemId = input.itemId; }
    const clean = cleanTakeaways([o], state.learningItems)[0];
    state.takeaways = list(state, 'takeaways').concat([clean]);
    return clean;
  }
  function deleteTakeaway(state, id) {
    if (!list(state, 'takeaways').some((x) => x.id === id)) throw new Error('Takeaway not found');
    state.takeaways = state.takeaways.filter((x) => x.id !== id);
  }
  function setWeeklyTarget(state, v) {
    const s = String(given(v) ? v : '0').trim();
    if (!/^\d{1,5}$/.test(s) || +s > MAX_WEEK_MIN) throw new Error('Study minutes per week must be a whole number from 0 to ' + MAX_WEEK_MIN);
    if (!state.settings) throw new Error('No settings');
    state.settings.learning = { weeklyMinutes: +s };
    return +s;
  }

  // ---- legacy: learning/item and learning/hours entries from before schema 7 become items and sessions ----
  // An item entry keeps its title, status, date, notes and createdAt (the date and notes are written into the item's notes). An
  // hours entry becomes a session when it is an exact whole number of minutes from 1 to 1440; its title, hours and notes go into
  // the session's notes. Anything that does not fit (notes over 2,000 characters, a fractional minute, past a cap) keeps its
  // original entry, which stays visible and deletable under Learning. Nothing is dropped.
  function legacy(entries, newId, caps) {
    const items = [], sessions = [], gone = new Set(), ic = (caps && caps.items) || ITEM_CAP, sc = (caps && caps.sessions) || SESSION_CAP;
    for (const e of entries) {
      if (e.domain !== 'learning') continue;
      const id = typeof e.id === 'string' && e.id && e.id.length <= 100 ? e.id : newId();
      if (e.type === 'item') {
        if (items.length >= ic) continue;
        const notes = 'Imported from a Learning item dated ' + e.date + '.' + (e.notes ? ' ' + e.notes : '');
        if (notes.length > 2000) continue;
        const done = e.status === 'done', o = { id, title: e.title, kind: 'other', provider: '', state: done ? 'done' : 'active', notes };
        if (done) o.finishedDate = e.date; else o.startDate = e.date;
        if (e.createdAt !== undefined) o.createdAt = e.createdAt;
        items.push(o); gone.add(e);
      } else if (e.type === 'hours') {
        if (sessions.length >= sc || typeof e.value !== 'number') continue;
        const m = e.value * 60, min = Math.round(m);
        if (Math.abs(m - min) > 1e-6 || min < 1 || min > MAX_SESSION_MIN) continue;
        const notes = 'Imported from Learning hours "' + e.title + '" (' + e.value + ' hours).' + (e.notes ? ' ' + e.notes : '');
        if (notes.length > 2000) continue;
        sessions.push({ id, date: e.date, minutes: min, notes }); gone.add(e);
      }
    }
    return { items, sessions, entries: entries.filter((e) => !gone.has(e)) };
  }

  L.learning = {
    ITEM_CAP, SESSION_CAP, TAKEAWAY_CAP, SESSION_NOTE_MAX, STALL_DAYS, KINDS, KIND_LABEL, STATES, STATE_LABEL, SECRET_MESSAGE,
    cleanSettings, cleanItems, cleanSessions, cleanTakeaways, progressOf, paceOf, fmtProgress, unitsText, weekInfo, studyWeek, streak, activeItems, lastSession, stalled,
    upcomingExams, recentlyFinished, finishedBy, expiries, goalProgress, hasData, current, legacyEntries, linkedCount, summary, headline, weekValue, digest, reviewWeek, search,
    addItem, updateItem, setState, pauseItem, dropItem, setTargetDate, deleteItem, addSession, deleteSession, addTakeaway, deleteTakeaway, setWeeklyTarget, legacy, target,
  };
})();
