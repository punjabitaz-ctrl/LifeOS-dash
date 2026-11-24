(function () {
  'use strict';
  // v2.1.0: Eating, inside Health. Saved meals are fixed portions with one protein number each; the meal log is one tap per meal and
  // copies the protein, so editing a saved meal never rewrites a past day. "Ate for health?" is the owner's own yes or no per meal.
  // A tracker, not advice: no target is ever suggested and no figure is called good or bad. Every figure that cannot be known is null
  // ("no data"), never 0 and never NaN. Meal names stay in the vault: the digest carries numbers only, and those numbers are not sent
  // to any AI provider (memory.js leaves them out of the prompt, like body metrics).
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const SLOTS = Object.freeze(['breakfast', 'lunch', 'dinner', 'snack', 'any']);
  const SLOT_LABEL = Object.freeze({ breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack', any: 'Any time' });
  const MEAL_CAP = 50, LOG_CAP = 20000, NAME_MAX = 60, PROTEIN_MAX = 300, TARGET_MAX = 1000;
  const BIDI = /[؜​-‏‪-‮⁠-⁩﻿]/g;
  const V = () => L.validate, M = () => L.metrics;
  const list = (state, k) => (state && Array.isArray(state[k]) ? state[k] : []);
  const fail = (m) => { throw new Error(m); };
  const given = (v) => v !== undefined && v !== null && v !== '';
  const clean1 = (s) => String(s == null ? '' : s).replace(BIDI, '').replace(/\s+/g, ' ').trim();

  // ---- validation (schema 21): rebuilt from whitelists with caps; a link to a meal that no longer exists is dropped, the row is kept ----
  function cleanSettings(x) {
    if (x === undefined || x === null) return {};
    if (!V().isObj(x)) V().fail('food settings');
    const o = {};
    if (x.proteinTarget !== undefined && x.proteinTarget !== null) o.proteinTarget = V().num(x.proteinTarget, 1, TARGET_MAX, 'protein target', true);
    return o;
  }
  function cleanMeals(l) {
    if (l === undefined || l === null) return [];
    const seen = new Set();
    return V().arr(l, MEAL_CAP, 'saved meals').map((x) => {
      if (!V().isObj(x)) V().fail('saved meal');
      const id = V().str(x.id, 100, 'meal id');
      if (seen.has(id)) V().fail('duplicate meal id');
      seen.add(id);
      return {
        id,
        name: V().str(V().strip(V().str(x.name, NAME_MAX, 'meal name')).trim(), NAME_MAX, 'meal name'),
        protein: V().num(x.protein, 0, PROTEIN_MAX, 'meal protein', true),
        slot: V().oneOf(x.slot === undefined ? 'any' : x.slot, SLOTS, 'meal slot'),
      };
    });
  }
  function cleanLog(l, meals) {
    if (l === undefined || l === null) return [];
    const ids = new Set((meals || []).map((m) => m.id)), seen = new Set();
    return V().arr(l, LOG_CAP, 'meal log').map((x) => {
      if (!V().isObj(x)) V().fail('logged meal');
      const id = V().str(x.id, 100, 'logged meal id');
      if (seen.has(id)) V().fail('duplicate logged meal id');
      seen.add(id);
      const o = { id, date: V().date(x.date, 'logged meal date'), protein: V().num(x.protein, 0, PROTEIN_MAX, 'logged meal protein', true) };
      if (given(x.mealId)) { const m = V().str(x.mealId, 100, 'logged meal link'); if (ids.has(m)) o.mealId = m; }
      if (x.forHealth !== undefined && x.forHealth !== null) o.forHealth = V().bool(x.forHealth, 'ate for health');
      // A one-off row has no meal; a row whose meal was deleted has neither (it reads "Removed meal").
      if (x.oneOff === true) { if (o.mealId) V().fail('a one-off row has no meal'); o.oneOff = true; }
      else if (x.oneOff !== undefined) V().fail('one-off must be true or absent');
      return o;
    });
  }

  // ---- input parsing (typed by the owner) ----
  function wholeIn(v, min, max, what) {
    const s = String(v == null ? '' : v).trim();
    if (!/^\d{1,4}$/.test(s) || Number(s) < min || Number(s) > max) fail(what + ' must be a whole number from ' + min + ' to ' + max + '.');
    return Number(s);
  }
  function nameIn(v) {
    const s = clean1(v);
    if (!s) fail('Enter a name for the meal.');
    if (s.length > NAME_MAX) fail('A meal name can be up to ' + NAME_MAX + ' characters.');
    if (L.admin && L.admin.looksSecret && L.admin.looksSecret(s)) fail('That looks like an ID number or a card number. Do not enter ID numbers, account numbers or passwords here.');
    return s;
  }
  const dayIn = (d) => { if (!M().isDate(d)) fail('Choose a day.'); return d; };
  const ensure = (state) => { if (!Array.isArray(state.meals)) state.meals = []; if (!Array.isArray(state.mealLog)) state.mealLog = []; };

  // ---- saved meals ----
  // input: { name, protein (grams as typed), slot }
  function addMeal(state, input) {
    ensure(state);
    if (!V().isObj(input)) fail('Meal must be an object');
    if (state.meals.length >= MEAL_CAP) fail('You can keep up to ' + MEAL_CAP + ' saved meals.');
    const slot = given(input.slot) ? input.slot : 'any';
    if (!SLOTS.includes(slot)) fail('Pick when you usually eat it from the list.');
    const m = { id: V().newId(), name: nameIn(input.name), protein: wholeIn(input.protein, 0, PROTEIN_MAX, 'Protein (g)'), slot };
    state.meals.push(m);
    return m.id;
  }
  function updateMeal(state, id, input) {
    ensure(state);
    const m = state.meals.find((x) => x.id === id);
    if (!m) fail('That meal no longer exists.');
    if (!V().isObj(input)) fail('Meal must be an object');
    const slot = given(input.slot) ? input.slot : m.slot;
    if (!SLOTS.includes(slot)) fail('Pick when you usually eat it from the list.');
    const name = nameIn(input.name), protein = wholeIn(input.protein, 0, PROTEIN_MAX, 'Protein (g)');
    m.name = name; m.protein = protein; m.slot = slot;
  }
  // The meal goes; every logged row keeps its day and protein and loses only the link.
  function deleteMeal(state, id) {
    ensure(state);
    if (!state.meals.some((x) => x.id === id)) fail('That meal no longer exists.');
    state.meals = state.meals.filter((x) => x.id !== id);
    for (const r of state.mealLog) if (r.mealId === id) delete r.mealId;
  }
  // Breakfast first, then lunch, dinner, snack and any time; the owner's order within a slot.
  function mealsBySlot(state) {
    const ms = list(state, 'meals');
    return SLOTS.map((s) => ({ slot: s, label: SLOT_LABEL[s], meals: ms.filter((m) => m.slot === s) })).filter((g) => g.meals.length);
  }

  // ---- the log ----
  function logMeal(state, mealId, day) {
    ensure(state);
    const m = state.meals.find((x) => x.id === mealId);
    if (!m) fail('That meal no longer exists.');
    if (state.mealLog.length >= LOG_CAP) fail('The meal log is full (' + LOG_CAP + ' rows).');
    const r = { id: V().newId(), date: dayIn(day), protein: m.protein, mealId: m.id };
    state.mealLog.push(r);
    return r.id;
  }
  function logOneOff(state, protein, day) {
    ensure(state);
    if (state.mealLog.length >= LOG_CAP) fail('The meal log is full (' + LOG_CAP + ' rows).');
    const r = { id: V().newId(), date: dayIn(day), protein: wholeIn(protein, 0, PROTEIN_MAX, 'Protein (g)'), oneOff: true };
    state.mealLog.push(r);
    return r.id;
  }
  // v: true, false, or null to clear the answer.
  function setForHealth(state, id, v) {
    ensure(state);
    const r = state.mealLog.find((x) => x.id === id);
    if (!r) fail('That logged meal no longer exists.');
    if (v === null) delete r.forHealth;
    else if (v === true || v === false) r.forHealth = v;
    else fail('Answer yes or no.');
  }
  function removeLog(state, id) {
    ensure(state);
    if (!state.mealLog.some((x) => x.id === id)) fail('That logged meal no longer exists.');
    state.mealLog = state.mealLog.filter((x) => x.id !== id);
  }
  function setProteinTarget(state, v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) { state.settings.food = {}; return null; }
    const n = wholeIn(s, 1, TARGET_MAX, 'Daily protein target (g)');
    state.settings.food = { proteinTarget: n };
    return n;
  }
  const targetOf = (state) => { const f = state && state.settings && state.settings.food; return f && Number.isInteger(f.proteinTarget) ? f.proteinTarget : null; };

  // ---- figures ----
  const mealName = (state, r) => { if (r.oneOff) return 'One-off'; if (!r.mealId) return 'Removed meal'; const m = list(state, 'meals').find((x) => x.id === r.mealId); return m ? m.name : 'Removed meal'; };
  function day(state, d) {
    const rows = list(state, 'mealLog').filter((r) => r.date === d);
    const protein = rows.reduce((a, r) => a + r.protein, 0), target = targetOf(state);
    return { date: d, rows, meals: rows.length, protein, target, left: target === null ? null : Math.max(0, target - protein), share: target === null ? null : Math.min(1, protein / target) };
  }
  // Monday to Sunday from ws. Days with no meal logged are left out of the average (not counted as zero).
  function week(state, ws) {
    const target = targetOf(state), days = [];
    for (let i = 0; i < 7; i++) { const d = M().addDays(ws, i); const x = day(state, d); days.push({ date: d, meals: x.meals, protein: x.protein }); }
    const logged = days.filter((x) => x.meals > 0), rows = list(state, 'mealLog').filter((r) => r.date >= ws && r.date <= M().addDays(ws, 6));
    const answered = rows.filter((r) => r.forHealth === true || r.forHealth === false), yes = answered.filter((r) => r.forHealth === true).length;
    return {
      days, target,
      meals: rows.length,
      loggedDays: logged.length,
      proteinAvg: logged.length ? Math.round(logged.reduce((a, x) => a + x.protein, 0) / logged.length) : null,
      proteinDays: target === null ? null : days.filter((x) => x.meals > 0 && x.protein >= target).length,
      answered: answered.length, forHealth: yes,
      forHealthRate: answered.length ? Math.round((yes / answered.length) * 1000) / 10 : null,
    };
  }
  // Numbers only, for the weekly digest. 0 stands for "none" here, as in the other digest blocks.
  function digest(state, ws) {
    const w = week(state, ws);
    return { meals: w.meals, proteinAvg: w.proteinAvg === null ? 0 : w.proteinAvg, proteinDays: w.proteinDays === null ? 0 : w.proteinDays, forHealthRate: w.forHealthRate === null ? 0 : w.forHealthRate };
  }

  L.food = {
    SLOTS, SLOT_LABEL, MEAL_CAP, LOG_CAP, NAME_MAX, PROTEIN_MAX, TARGET_MAX,
    cleanSettings, cleanMeals, cleanLog, addMeal, updateMeal, deleteMeal, mealsBySlot, logMeal, logOneOff, setForHealth, removeLog,
    setProteinTarget, targetOf, mealName, day, week, digest,
  };
})();
