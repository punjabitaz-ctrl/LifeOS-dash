(function () {
  'use strict';
  // v0.11.0 part B: Wellbeing. Lives only in the private vault's inner plaintext (`wellbeing.checkins`), never in the main state.
  // Numbers and dates only: no interpretation, labels, thresholds, flags, norms or advice. Sleep, contacts and social-tagged
  // activities are read live from Health, Social and Activities and never copied. Pure functions over a wellbeing object; the
  // callers (priv.commit or priv.write) do the saving.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const CAP = 6000, NOTE_MAX = 200, ID_MAX = 100;
  const AREAS = Object.freeze([
    Object.freeze({ id: 'mood', label: 'Mood' }),
    Object.freeze({ id: 'mental', label: 'Mental state' }),
    Object.freeze({ id: 'recovery', label: 'Rest and recovery' }),
    Object.freeze({ id: 'connected', label: 'Social engagement' }),
    Object.freeze({ id: 'intimacy', label: 'Intimacy' }),
  ]);
  const AREA_IDS = AREAS.map((a) => a.id);
  const FIELDS = AREA_IDS.concat(['note']);
  const SECRET_MESSAGE = 'That looks like an ID number or a card number. Do not enter ID numbers, account numbers or passwords here.';
  const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const D = () => L.metrics;
  const fail = (m) => { const e = new Error(m); e.code = 'WELLBEING_INVALID'; throw e; };
  const isRating = (v) => Number.isInteger(v) && v >= 1 && v <= 5;
  const addDays = (s, n) => D().addDays(s, n);

  // ---- validation of stored data (opening the vault) ----
  function cleanCheckin(x, seen) {
    if (!isObj(x)) fail('check-in');
    for (const k of Object.keys(x)) if (k !== 'id' && k !== 'date' && !FIELDS.includes(k)) fail('check-in has an unknown field');
    if (typeof x.id !== 'string' || !x.id || x.id.length > ID_MAX) fail('check-in id');
    if (seen.ids.has(x.id)) fail('duplicate check-in id');
    if (!D().isDate(x.date)) fail('check-in date');
    if (seen.dates.has(x.date)) fail('two check-ins share a date');
    seen.ids.add(x.id); seen.dates.add(x.date);
    const o = { id: x.id, date: x.date };
    for (const a of AREA_IDS) if (x[a] !== undefined) { if (!isRating(x[a])) fail('check-in rating'); o[a] = x[a]; }
    if (x.note !== undefined) {
      if (typeof x.note !== 'string' || x.note.length > NOTE_MAX) fail('check-in note');
      if (x.note) o.note = x.note;
    }
    if (!AREA_IDS.some((a) => o[a] !== undefined) && o.note === undefined) fail('empty check-in');
    return o;
  }
  // The inner `wellbeing` object: only `checkins` is allowed; absent when empty (so an empty vault has no wellbeing mark).
  function clean(w) {
    if (!isObj(w)) fail('wellbeing data');
    for (const k of Object.keys(w)) { if (BLOCKED.has(k) || k !== 'checkins') fail('wellbeing data has an unknown field'); }
    if (w.checkins === undefined) return {};
    if (!Array.isArray(w.checkins) || w.checkins.length > CAP) fail('wellbeing check-ins');
    const seen = { ids: new Set(), dates: new Set() };
    const list = w.checkins.map((c) => cleanCheckin(c, seen)).sort((a, b) => a.date.localeCompare(b.date));
    return list.length ? { checkins: list } : {};
  }

  // ---- reading ----
  const listOf = (w) => (w && Array.isArray(w.checkins) ? w.checkins : []);
  const byDate = (w, d) => listOf(w).find((c) => c.date === d) || null;
  function ratingsOf(w, area, a, b) {
    const out = [];
    for (const c of listOf(w)) if (c.date >= a && c.date <= b && c[area] !== undefined) out.push(c[area]);
    return out;
  }
  // Mean of the ratings logged in [a, b]; n is how many; avg is null with none. Exact, unrounded.
  function avg(w, area, a, b) {
    if (!AREA_IDS.includes(area)) fail('Unknown area');
    const r = ratingsOf(w, area, a, b);
    return { n: r.length, avg: r.length ? r.reduce((s, v) => s + v, 0) / r.length : null };
  }
  // Per area: today's rating, the 7 and 30 day averages (today included), the 7 days before those, and a 30 day daily series.
  function summary(w, area, today) {
    if (!D().isDate(today)) fail('today must be YYYY-MM-DD');
    const t = byDate(w, today), series = [];
    for (let i = 29; i >= 0; i--) { const d = addDays(today, -i), c = byDate(w, d); series.push({ date: d, value: c && c[area] !== undefined ? c[area] : null }); }
    return {
      area, today: t && t[area] !== undefined ? t[area] : null,
      avg7: avg(w, area, addDays(today, -6), today), avg30: avg(w, area, addDays(today, -29), today), prev7: avg(w, area, addDays(today, -13), addDays(today, -7)),
      series,
    };
  }
  // Consecutive local dates with a check-in, ending today, or ending yesterday when today has none yet.
  function streak(w, today) {
    if (!D().isDate(today)) fail('today must be YYYY-MM-DD');
    const have = new Set(listOf(w).map((c) => c.date));
    let d = have.has(today) ? today : addDays(today, -1), n = 0;
    while (have.has(d)) { n++; d = addDays(d, -1); }
    return n;
  }
  const checkinsInWeek = (w, asOf) => listOf(w).filter((c) => c.date >= addDays(asOf, -6) && c.date <= asOf).length;
  // Goal metric values: null (no data) when there is nothing to average.
  function goalValue(w, metric, asOf) {
    if (metric === 'wbCheckinsPerWeek') return listOf(w).length ? checkinsInWeek(w, asOf) : null;
    const area = AREA_IDS.find((a) => metric === 'wb' + a[0].toUpperCase() + a.slice(1));
    if (!area) fail('Unknown goal metric');
    const v = avg(w, area, addDays(asOf, -6), asOf).avg;
    return v === null ? null : Math.round(v * 100) / 100;
  }
  const GOAL_METRICS = Object.freeze(AREA_IDS.map((a) => 'wb' + a[0].toUpperCase() + a.slice(1)).concat(['wbCheckinsPerWeek']));
  const isGoalMetric = (m) => GOAL_METRICS.includes(m);
  // Live reads from other areas, computed on demand and never stored. `state` is the view (private records merged in while open).
  function live(state, today) {
    const m = D(), a7 = addDays(today, -6), a30 = addDays(today, -29);
    const sleep = (a, b) => m.sleepAvg(state, a, b);
    const soc = (a, b) => (state.activities || []).filter((x) => x.state === 'done' && x.alsoSocial && x.date >= a && x.date <= b).length;
    const contacts = (a, b) => (L.social && L.social.contactsBetween ? L.social.contactsBetween(state, a, b) : 0);
    return {
      sleep: { today: sleep(today, today).avg, avg7: sleep(a7, today), avg30: sleep(a30, today) },
      contacts: { today: contacts(today, today), d7: contacts(a7, today), d30: contacts(a30, today) },
      socialActivities: { today: soc(today, today), d7: soc(a7, today), d30: soc(a30, today) },
    };
  }

  // ---- writing (called with the inner wellbeing object inside priv.commit / priv.write) ----
  function textOf(v) {
    if (typeof v !== 'string') fail('The note must be text.');
    const t = v.trim();
    if (t.length > NOTE_MAX) fail('The note can be up to ' + NOTE_MAX + ' characters.');
    if (L.admin && L.admin.looksSecret(t)) fail(SECRET_MESSAGE);
    return t;
  }
  // Merge one section update (or a quick update of several) into the check-in for input.date. A field that is undefined is left
  // alone, null (or an empty note) removes it, a rating sets it. Other sections of the same day are never touched.
  function save(w, input, newId) {
    if (!isObj(w)) fail('wellbeing data');
    if (!isObj(input)) fail('Check-in must be an object');
    for (const k of Object.keys(input)) if (k !== 'date' && !FIELDS.includes(k)) fail('Unknown check-in field');
    if (!D().isDate(input.date)) fail('The date must be a valid date.');
    const patch = {};
    for (const a of AREA_IDS) {
      const v = input[a];
      if (v === undefined) continue;
      if (v === null) { patch[a] = null; continue; }
      if (!isRating(v)) fail('A rating is a whole number from 1 to 5.');
      patch[a] = v;
    }
    if (input.note !== undefined) { const t = input.note === null ? '' : textOf(input.note); patch.note = t === '' ? null : t; }
    if (!Object.keys(patch).length) fail('Nothing to save. Pick at least one rating or write a note.');
    const list = Array.isArray(w.checkins) ? w.checkins : [];
    let c = list.find((x) => x.date === input.date);
    const isNew = !c;
    if (isNew) {
      if (list.length >= CAP) fail('You can keep up to ' + CAP + ' check-ins.');
      c = { id: typeof newId === 'function' ? newId() : L.store.newId(), date: input.date };
    }
    const next = Object.assign({}, c);
    for (const k of Object.keys(patch)) { if (patch[k] === null) delete next[k]; else next[k] = patch[k]; }
    const has = AREA_IDS.some((a) => next[a] !== undefined) || next.note !== undefined;
    if (!has && isNew) fail('Nothing to save. Pick at least one rating or write a note.');
    // Nothing above failed: only now is the caller's object changed.
    let out = list.filter((x) => x !== c);
    if (has) out.push(next);
    out.sort((a, b) => a.date.localeCompare(b.date));
    if (out.length) w.checkins = out; else delete w.checkins;
    return has ? next : null;
  }

  // ---- earlier thin mood entries (domain wellbeing, type mood) ----
  // An entry moves in only when everything it holds fits exactly: an integer 1 to 5 rating, its title and notes in one note of up
  // to 200 characters that passes the secrets guard, and no clash with a check-in already holding a different mood on that date.
  // Anything else stays where it is, so nothing is lost. Running it again moves nothing new.
  const isOld = (e) => e && e.domain === 'wellbeing' && e.type === 'mood';
  function oldPlan(entries, w) {
    const olds = (entries || []).filter(isOld).slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const move = [], keep = [], day = new Map();
    for (const c of listOf(w)) day.set(c.date, { mood: c.mood, note: c.note });
    for (const e of olds) {
      const text = [e.title, e.notes].filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).join(' - ');
      let ok = isRating(e.value) && D().isDate(e.date) && text.length <= NOTE_MAX && !(L.admin && L.admin.looksSecret(text));
      const cur = day.get(e.date);
      if (ok && cur && ((cur.mood !== undefined && cur.mood !== e.value) || (cur.note !== undefined && text && cur.note !== text))) ok = false;
      if (ok && !listOf(w).some((c) => c.date === e.date) && listOf(w).length + new Set(move.map((m) => m.date)).size >= CAP) ok = false;
      if (ok) { move.push({ id: e.id, date: e.date, mood: e.value, note: text }); day.set(e.date, { mood: e.value, note: text || (cur && cur.note) }); } else keep.push(e.id);
    }
    return { move, keep };
  }
  const pendingOld = (entries, w) => oldPlan(entries, w).move.length;
  const hasOld = (entries) => (entries || []).some(isOld);
  // Inside priv.write(fn): fn(work, wb). Removes the movable entries from work.entries and merges them into wb.
  function moveOld(work, wb, newId) {
    const plan = oldPlan(work.entries, wb), gone = new Set(plan.move.map((m) => m.id));
    for (const m of plan.move) save(wb, { date: m.date, mood: m.mood, note: m.note || undefined }, newId);
    work.entries = work.entries.filter((e) => !gone.has(e.id));
    return { moved: plan.move.length, kept: plan.keep.length };
  }

  L.wellbeing = {
    AREAS, AREA_IDS, CAP, NOTE_MAX, SECRET_MESSAGE, GOAL_METRICS, isGoalMetric, clean, cleanCheckin, listOf, byDate, avg, summary, streak, checkinsInWeek,
    goalValue, live, save, oldPlan, pendingOld, hasOld, moveOld, isRating,
  };
})();
