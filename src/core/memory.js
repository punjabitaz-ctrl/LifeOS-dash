(function () {
  'use strict';
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const MAX_TEXT = 280, MAX_ITEMS = 5, LESSON_CAP = 30, INSIGHT_CAP = 5000, CTX_MAX = 8;
  // SEC-66 (owner decision): wellbeing never reaches the AI. Prompts, the domain list the model may answer with, rules insights
  // and new proposals leave it out; earlier wellbeing insights stay in the vault but are never sent.
  const NO_AI = new Set(['wellbeing']);
  const domains = () => L.DOMAINS.map((d) => d.id).filter((id) => !NO_AI.has(id)).concat(['overall']);
  // v1.5.0 B12: the fixed rejection reasons. Only these codes (as counts) can reach a prompt; typed text never does (PV-6).
  const REASONS = Object.freeze(['wrong-number', 'not-relevant', 'already-known', 'too-vague', 'other']);
  const REASON_LABEL = Object.freeze({ 'wrong-number': 'wrong number', 'not-relevant': 'not relevant', 'already-known': 'already known', 'too-vague': 'too vague', other: 'other' });
  const KIND_LABEL = Object.freeze({ workouts: 'Workout target', contacts: 'Contact overdue', savings: 'Savings rate', 'net-worth': 'Net worth move', maintenance: 'Maintenance overdue', admin: 'Admin due', goals: 'Goals on track', change: 'Weekly change', sleep: 'Average sleep', 'daily-checks': 'Daily checks', merge: 'Merged entry' });
  const MUTE_AFTER = 3, MUTE_WINDOW_DAYS = 56, REJECT_WINDOW_DAYS = 84, MUTES_CAP = 500, DAY = 86400000;
  const KIND_RE = /^[a-z][a-z0-9-]{0,29}$/;
  // Numeric targets an insight may propose. Ranges are the Settings ranges (contact days 1 to 365 as in the form).
  const TARGETS = Object.freeze({
    workoutsPerWeek: { label: 'Workouts per week', min: 0, max: 21, int: true, get: (s) => s.settings.targets.workoutsPerWeek, set: (s, v) => { s.settings.targets.workoutsPerWeek = v; }, fmt: (v) => String(v) },
    contactDays: { label: 'Days between contacts', min: 1, max: 365, int: true, get: (s) => s.settings.targets.contactDays, set: (s, v) => { s.settings.targets.contactDays = v; }, fmt: (v) => String(v) },
    savingsRate: { label: 'Savings rate target', min: 0, max: 1, int: false, get: (s) => s.settings.targets.savingsRate, set: (s, v) => { s.settings.targets.savingsRate = v; }, fmt: (v) => Math.round(v * 10000) / 100 + '%' },
    studyMinutes: { label: 'Study minutes per week', min: 0, max: 10080, int: true, get: (s) => (s.settings.learning ? s.settings.learning.weeklyMinutes : 0), set: (s, v) => { s.settings.learning = Object.assign({}, s.settings.learning, { weeklyMinutes: v }); }, fmt: (v) => String(v) },
    backupReminderDays: { label: 'Backup reminder (days)', min: 1, max: 60, int: true, get: (s) => s.settings.backupReminderDays, set: (s, v) => { s.settings.backupReminderDays = v; }, fmt: (v) => String(v) },
  });
  // A target change: { key, value } plus applied:true once the owner tapped Apply. Anything outside its range is refused.
  function cleanTarget(t, allowApplied) {
    const bad = () => new Error('Invalid target change');
    if (!t || typeof t !== 'object' || Array.isArray(t)) throw bad();
    const keys = Object.keys(t);
    if (keys.some((k) => k !== 'key' && k !== 'value' && !(allowApplied && k === 'applied'))) throw bad();
    if (typeof t.key !== 'string' || !Object.prototype.hasOwnProperty.call(TARGETS, t.key)) throw bad();
    const d = TARGETS[t.key], v = t.value;
    if (typeof v !== 'number' || !isFinite(v) || v < d.min || v > d.max || (d.int && !Number.isInteger(v))) throw bad();
    const out = { key: t.key, value: d.int ? v : Math.round(v * 10000) / 10000 };
    if (allowApplied && t.applied !== undefined) { if (t.applied !== true) throw bad(); out.applied = true; }
    return out;
  }
  const msOf = (v) => (typeof v === 'number' ? v : Date.parse(v));
  const BIDI = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
  const newId = () => L._webcrypto.randomUUID();

  function checkPeriod(p) {
    if (!p || !L.metrics.isDate(p.from) || !L.metrics.isDate(p.to) || p.from > p.to) throw new Error('Invalid period');
    return { from: p.from, to: p.to };
  }
  function checkLevel(l) { if (l !== 1 && l !== 2 && l !== 3) throw new Error('Invalid level'); return l; }

  // v1.5.0 B12: a kind the owner rejected 3 times within 8 weeks stays out of the rules suggestions until it is unmuted.
  const isMuted = (state, domain, kind) => ((state.memory && state.memory.mutes) || []).some((m) => m.active && m.domain === domain && m.kind === kind);
  function rulesInsights(state, weekStartISO) {
    if (L.priv) state = L.priv.mainOnly(state);
    const dg = L.metrics.weeklyDigest(state, weekStartISO);
    const t = state.settings.targets, cur = state.settings.currency;
    const out = [];
    const money = (v) => L.metrics.fmtMoney(v, cur);
    for (const d of L.DOMAINS) {
      if (!dg.domains[d.id]) continue;
      const { now, prev, unit } = dg.domains[d.id];
      if (now === 0 && prev === 0) continue;
      let text = null, kind = 'change';
      const dir = now > prev ? 'up' : 'down';
      switch (d.id) {
        case 'health':
          kind = 'workouts';
          text = now < t.workoutsPerWeek
            ? 'Workouts: ' + now + ' this week against a target of ' + t.workoutsPerWeek + ' (last week ' + prev + ').'
            : 'Workout target met: ' + now + ' of ' + t.workoutsPerWeek + ' this week.';
          break;
        case 'social':
          kind = 'contacts';
          if (now > 0) text = now + (now === 1 ? ' person is' : ' people are') + ' overdue for contact (more than ' + t.contactDays + ' days).';
          else if (prev > 0) text = 'Nobody is overdue for contact now, down from ' + prev + ' last week.';
          break;
        case 'money':
          kind = 'savings';
          if (now === 0) break;
          text = now < t.savingsRate * 100
            ? 'Savings rate this week was ' + now + '%, below your ' + Math.round(t.savingsRate * 100) + '% target.'
            : 'Savings rate this week was ' + now + '%, at or above your ' + Math.round(t.savingsRate * 100) + '% target.';
          break;
        case 'assets':
          kind = 'net-worth';
          if (now !== prev) text = 'Net worth moved ' + dir + ' from ' + money(prev) + ' to ' + money(now) + '.';
          break;
        case 'home':
          kind = 'maintenance';
          text = 'Maintenance tasks overdue: ' + now + ' (last week ' + prev + ').';
          break;
        case 'admin':
          kind = 'admin';
          text = 'Admin items due within 30 days: ' + now + ' (last week ' + prev + ').';
          break;
        case 'goals':
          kind = 'goals';
          if (now === 0 && prev === 0) break;
          if (now !== prev) text = 'Share of goals on track moved ' + dir + ' from ' + prev + '% to ' + now + '%.';
          break;
        default:
          if (now !== prev) text = d.label + ': ' + now + ' ' + unit + ' this week, ' + dir + ' from ' + prev + '.';
      }
      if (text && !isMuted(state, d.id, kind)) out.push({ domain: d.id, kind, text: text.slice(0, MAX_TEXT) });
    }
    // Health: numeric facts only, never advice.
    const hd = dg.health, ph = L.metrics.healthDigest(state, L.metrics.addDays(dg.week, -7));
    if (hd) {
      const unit = state.settings.health ? state.settings.health.units : 'lb';
      if (hd.avgSleep > 0 && !isMuted(state, 'health', 'sleep')) out.push({ domain: 'health', kind: 'sleep', text: ('Average sleep this week was ' + hd.avgSleep + ' hours' + (ph.avgSleep > 0 ? ' (last week ' + ph.avgSleep + ').' : '.')).slice(0, MAX_TEXT) });
      // PV-9 (owner rule): body metrics never become a stored insight that states a value or a change, so there is no weight rule.
      if ((state.habits || []).length && (hd.habitRate > 0 || ph.habitRate > 0) && !isMuted(state, 'health', 'daily-checks')) out.push({ domain: 'health', kind: 'daily-checks', text: ('Daily checks completed: ' + hd.habitRate + '% this week (last week ' + ph.habitRate + '%).').slice(0, MAX_TEXT) });
    }
    return out;
  }

  // The rules insight that states a weight change. It stays in the vault and is never part of a prompt.
  const BODY_TEXT = /^Weight moved (up|down) /;
  const isBodyInsight = (i) => i.domain === 'health' && i.source === 'rules' && BODY_TEXT.test(i.text);
  function buildPrompt(state, level, period) {
    if (L.priv) state = L.priv.mainOnly(state);
    checkLevel(level);
    const p = checkPeriod(period);
    const mem = state.memory;
    const approvedAll = mem.insights.filter((i) => i.status === 'approved' && !NO_AI.has(i.domain));
    const lines = [];
    let ctx;
    if (level === 1) {
      const dg = L.metrics.weeklyDigest(state, p.from);
      lines.push('Level 1 weekly review. Week of ' + dg.week + '.', 'Digest (this week vs previous week):');
      for (const d of L.DOMAINS) {
        const x = dg.domains[d.id];
        if (!x) continue;
        lines.push('- ' + d.id + ': now ' + x.now + ' ' + x.unit + ', previous ' + x.prev + ' ' + x.unit);
      }
      const w = dg.work;
      if (w) {
        lines.push('- work detail: outcomes done ' + w.done + ' of ' + w.planned + ', active projects ' + w.activeProjects + ', overdue next actions ' + w.overdueNext + ', moved this week ' + w.moved + ', pipeline ' +
          Object.keys(w.pipeline).map((k) => k + ' ' + w.pipeline[k]).join(', '));
      }
      const hh = dg.health;
      // Body metrics (weight change) stay in the vault: they are never sent to a provider.
      if (hh) lines.push('- health detail: sessions ' + hh.sessions + ', minutes ' + hh.minutes + ', average sleep ' + hh.avgSleep + ' hours, daily checks completed ' + hh.habitRate + '%');
      // Goals: counts only, never titles, notes or values; weight and body fat goals are not counted at all (SEC-32).
      const gc = dg.goals;
      if (gc && (gc.active > 0 || gc.achieved > 0)) lines.push('- goals detail: active ' + gc.active + ', ahead ' + gc.ahead + ', on track ' + gc.onTrack + ', behind ' + gc.behind + ', achieved this week ' + gc.achieved);
      // Home and Admin: counts and money totals only, never a title, vendor, provider, name, location or note.
      const hm = dg.home, ad = dg.admin, cur = state.settings.currency, fm = (c) => L.metrics.fmtMoney(c / 100, cur);
      if (hm && (hm.overdue || hm.dueSoon || hm.done || hm.ytdCostCents)) lines.push('- home detail: maintenance overdue ' + hm.overdue + ', due within 30 days ' + hm.dueSoon + ', done this week ' + hm.done + ', year-to-date maintenance cost ' + fm(hm.ytdCostCents));
      if (ad && (ad.overdue || ad.dueSoon || ad.done || ad.runRateCents)) lines.push('- admin detail: overdue ' + ad.overdue + ', due within 30 days ' + ad.dueSoon + ', done this week ' + ad.done + ', subscription run-rate per month ' + fm(ad.runRateCents));
      // Learning: counts and minutes only, never a title, provider, note or takeaway.
      const ln = dg.learning;
      if (ln && (ln.minutes || ln.sessions || ln.days || ln.active || ln.finished || ln.stalled)) lines.push('- learning detail: study minutes ' + ln.minutes + ', sessions ' + ln.sessions + ', days studied ' + ln.days + ', active items ' + ln.active + ', finished this week ' + ln.finished + ', stalled items ' + ln.stalled);
      // Activities: counts, minutes-free numbers and money totals only, never a title, place, person, category or note.
      const ac = dg.activities;
      if (ac && (ac.done || ac.planned7 || ac.planned30 || ac.spendCents || ac.committedCents || ac.avgRating || ac.healthTagged || ac.socialTagged)) lines.push('- activities detail: done this week ' + ac.done + ', planned in the next 7 days ' + ac.planned7 + ', planned in the next 30 days ' + ac.planned30 + ', spend ' + fm(ac.spendCents) + ', committed ' + fm(ac.committedCents) + ', average worth-it rating ' + (ac.avgRating ? ac.avgRating : 'none rated') + ', health-tagged ' + ac.healthTagged + ', social-tagged ' + ac.socialTagged);
      // Social: counts only, never a name, group name, date label, fact, channel or note. Groups are numbered by position.
      const sc = dg.social;
      if (sc && (sc.people || sc.overdue || sc.dueSoon || sc.contactsWeek)) lines.push('- social detail: people ' + sc.people + ', overdue ' + sc.overdue + ', due within 7 days ' + sc.dueSoon + ', contacts this week ' + sc.contactsWeek + (sc.byGroup.length ? ', by group ' + sc.byGroup.map((g, i) => 'group ' + (i + 1) + ': ' + g.people + ' people, ' + g.overdue + ' overdue').join('; ') : ''));
      // Revenue: money totals and counts only, never a line of work name, a description, a category or imported text.
      const rv = dg.revenue;
      if (rv && (rv.revenueWeekCents || rv.expensesWeekCents || rv.revenueMonthCents || rv.expensesMonthCents || rv.expectedNext30Cents || rv.overdueCount)) lines.push('- revenue detail: received this week ' + fm(rv.revenueWeekCents) + ', expenses this week ' + fm(rv.expensesWeekCents) + ', net this week ' + fm(rv.netWeekCents) + ', received this month ' + fm(rv.revenueMonthCents) + ', expenses this month ' + fm(rv.expensesMonthCents) + ', net this month ' + fm(rv.netMonthCents) + ', expected in the next 30 days ' + fm(rv.expectedNext30Cents) + ', overdue expected income ' + rv.overdueCount + ', lines of work ' + rv.lines);
      const bz = dg.business;
      if (bz && (bz.openInvoices || bz.tax)) lines.push('- business detail (numbers only): open invoices ' + bz.openInvoices + ' totalling ' + fm(bz.openInvoiceCents) + ', overdue ' + bz.overdueInvoices + (bz.tax ? ', business profit this year ' + fm(bz.tax.profitCents) + (bz.tax.estimatedTaxCents !== undefined ? ', estimated tax set-aside ' + fm(bz.tax.estimatedTaxCents) : '') + (bz.tax.gapCents !== undefined ? ', set-aside gap ' + fm(bz.tax.gapCents) : '') : ''));
      // v1.5.0 B12: the five numeric targets, so a proposed change can be sized. Numbers only.
      lines.push('- current targets: ' + Object.keys(TARGETS).map((k) => k + ' ' + TARGETS[k].get(state)).join(', '));
      ctx = approvedAll.filter((i) => !isBodyInsight(i)).slice(-CTX_MAX);
      lines.push('Approved insights so far:');
    } else {
      const from = level - 1;
      // PV-8: an insight belongs to the period holding its start, so a week that spans two months is consolidated in the first one.
      ctx = approvedAll.filter((i) => !isBodyInsight(i) && i.level === from && i.period.from >= p.from && i.period.from <= p.to).slice(-CTX_MAX);
      lines.push('Level ' + level + (level === 2 ? ' monthly' : ' quarterly') + ' consolidation for ' + p.from + ' to ' + p.to + '.',
        'Approved level ' + from + ' insights to consolidate:');
    }
    if (!ctx.length) lines.push('- none');
    for (const i of ctx) lines.push('- [' + i.domain + '] ' + i.text);
    // PV-6 (owner rule: numbers only): the reasons typed when rejecting stay on this device. The model only learns how many recent
    // insights were rejected in each area, never the reason text or the rejected wording.
    lines.push('Lessons from earlier rejections (respect these):');
    const rej = mem.insights.filter((i) => i.status === 'rejected' && !NO_AI.has(i.domain)).slice(-30), byDom = new Map();
    for (const i of rej) byDom.set(i.domain, (byDom.get(i.domain) || 0) + 1);
    if (!byDom.size) lines.push('- none');
    else lines.push('- recently rejected insights by area: ' + [...byDom.keys()].sort().map((d) => d + ' ' + byDom.get(d)).join(', ') + '. Propose different kinds of insight in those areas.');
    // v1.5.0 B12 (owner decision): fixed reason categories may reach the AI as counts per area over the last 12 weeks. Typed text never does.
    const rc = rejectionCounts(state, p.to), rcAreas = Object.keys(rc).sort();
    if (rcAreas.length) lines.push('- rejection reasons by area, last 12 weeks (counts): ' + rcAreas.map((d) => d + ': ' + REASONS.filter((r) => rc[d][r]).map((r) => REASON_LABEL[r] + ' ' + rc[d][r]).join(', ')).join('; ') + '.');
    lines.push('Return the JSON array now.');
    const system = 'You are a careful personal reflection assistant. You only see numeric summaries and short approved notes, never raw records. ' +
      'Reply with ONLY a JSON array of at most ' + MAX_ITEMS + ' objects shaped {"domain":string,"text":string}. ' +
      'domain must be one of: ' + domains().join(', ') + '. text is plain text, at most ' + MAX_TEXT + ' characters, specific and grounded in the numbers given. ' +
      'Do not invent data. Do not give medical, legal or financial advice. Follow the lessons. ' +
      'An item may also carry "target":{"key":string,"value":number} to propose one numeric target change; key and allowed value range: ' +
      Object.keys(TARGETS).map((k) => k + ' ' + TARGETS[k].min + ' to ' + TARGETS[k].max + (TARGETS[k].int ? ' (whole number)' : ' (fraction)')).join(', ') + '. Leave target out otherwise.';
    return { system, user: lines.join('\n') };
  }

  function parseResponse(text) {
    if (typeof text !== 'string' || text.length > 20000) throw new Error('AI response is not usable');
    let t = text.trim();
    const m = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(t);
    if (m) t = m[1].trim();
    if (t[0] !== '[') throw new Error('AI response is not a JSON array');
    let a;
    try { a = JSON.parse(t); } catch (e) { throw new Error('AI response is not valid JSON'); }
    if (!Array.isArray(a)) throw new Error('AI response is not a JSON array');
    if (a.length > MAX_ITEMS) throw new Error('AI response has too many items');
    const ok = domains();
    return a.map((x) => {
      if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('AI item is not an object');
      if (typeof x.domain !== 'string' || !ok.includes(x.domain)) throw new Error('AI item has an unknown domain');
      if (typeof x.text !== 'string') throw new Error('AI item text is not text');
      const s = x.text.replace(BIDI, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
      if (!s || s.length > MAX_TEXT) throw new Error('AI item text is empty or too long');
      const o = { domain: x.domain, text: s };
      if (x.target !== undefined) {
        // A value outside its range, an unknown key or an extra field refuses the whole reply, like any other bad item.
        try { o.target = cleanTarget(x.target, false); } catch (e) { throw new Error('The AI reply has an invalid target change (an unknown setting or a value outside its range). Nothing was added.'); }
      }
      return o;
    });
  }

  function propose(state, items, opts) {
    const { level, period, source } = opts || {};
    checkLevel(level);
    const p = checkPeriod(period);
    if (source !== 'rules' && source !== 'ai') throw new Error('Invalid source');
    if (!Array.isArray(items) || items.length > 20) throw new Error('Invalid items');
    const ok = domains();
    const ins = state.memory.insights;
    for (const it of items) {
      if (!it || !ok.includes(it.domain) || typeof it.text !== 'string') throw new Error('Invalid insight');
      const text = it.text.trim();
      if (!text || text.length > MAX_TEXT) throw new Error('Invalid insight text');
      if (it.kind !== undefined && (typeof it.kind !== 'string' || !KIND_RE.test(it.kind))) throw new Error('Invalid insight kind');
      const target = it.target === undefined ? undefined : cleanTarget(it.target, false);
      if (ins.some((x) => x.level === level && x.period.from === p.from && x.domain === it.domain && x.text === text)) continue;
      if (ins.length >= INSIGHT_CAP) throw new Error('Insight limit reached');
      const row = { id: newId(), level, period: { from: p.from, to: p.to }, domain: it.domain, text, source, status: 'proposed', createdAt: new Date().toISOString() };
      if (it.kind !== undefined) row.kind = it.kind;
      if (target) row.target = target;
      ins.push(row);
    }
  }

  // opts: { category, now }. category is one of REASONS (a fixed code, never text); now is a Date or ISO string (tests).
  function decide(state, id, decision, reason, opts) {
    if (decision !== 'approved' && decision !== 'rejected') throw new Error('Invalid decision');
    const ins = state.memory.insights.find((i) => i.id === id);
    if (!ins) throw new Error('Insight not found');
    const o = opts || {}, at = o.now === undefined ? new Date() : new Date(o.now);
    if (isNaN(at.getTime())) throw new Error('Invalid time');
    if (o.category !== undefined && !REASONS.includes(o.category)) throw new Error('Invalid rejection reason');
    ins.status = decision;
    ins.decidedAt = at.toISOString();
    delete ins.reason;
    // Lessons are sent with every prompt, so a reason given for an earlier wellbeing insight is not kept as one (SEC-66).
    if (decision === 'rejected' && typeof reason === 'string' && !NO_AI.has(ins.domain)) {
      const r = reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_TEXT);
      if (r) {
        const ls = state.memory.lessons;
        ls.push({ id: newId(), text: r, createdAt: ins.decidedAt });
        while (ls.length > LESSON_CAP) ls.shift();
      }
    }
    if (decision === 'rejected') {
      if (o.category !== undefined) ins.reason = o.category;
      // SEC-104: a merged entry is an offer made on a tap, not a rules suggestion, so it never mutes (a muted merge would be listed but change nothing).
      if (ins.source === 'rules' && ins.kind && ins.kind !== 'merge') updateMute(state, ins, at);
    }
    return ins;
  }

  // Three rejections of the same rules kind in the same area within 8 weeks (56 days, boundary included) mute it. Rejections made before
  // the last unmute do not count again.
  function updateMute(state, ins, at) {
    const mem = state.memory;
    if (!Array.isArray(mem.mutes)) mem.mutes = [];
    const m = mem.mutes.find((x) => x.domain === ins.domain && x.kind === ins.kind);
    if (m && m.active) return;
    const now = at.getTime(), lo = now - MUTE_WINDOW_DAYS * DAY, since = m ? msOf(m.at) : -Infinity;
    const n = mem.insights.filter((i) => i.status === 'rejected' && i.source === 'rules' && i.domain === ins.domain && i.kind === ins.kind && i.decidedAt !== undefined &&
      msOf(i.decidedAt) >= lo && msOf(i.decidedAt) <= now && msOf(i.decidedAt) > since).length;
    if (n < MUTE_AFTER) return;
    if (m) { m.active = true; m.at = at.toISOString(); }
    else if (mem.mutes.length < MUTES_CAP) mem.mutes.push({ domain: ins.domain, kind: ins.kind, at: at.toISOString(), active: true });
  }
  const mutedList = (state) => ((state.memory && state.memory.mutes) || []).filter((m) => m.active).map((m) => ({ domain: m.domain, kind: m.kind, label: KIND_LABEL[m.kind] || m.kind, at: m.at }));
  // One tap: the kind is proposed again from now on, and its earlier rejections stop counting.
  function unmute(state, domain, kind, opts) {
    const m = ((state.memory && state.memory.mutes) || []).find((x) => x.active && x.domain === domain && x.kind === kind);
    if (!m) throw new Error('That suggestion is not muted');
    const at = opts && opts.now !== undefined ? new Date(opts.now) : new Date();
    if (isNaN(at.getTime())) throw new Error('Invalid time');
    m.active = false; m.at = at.toISOString();
    return m;
  }

  // Counts per area and fixed reason over the 12 weeks up to `to`. Wellbeing is left out (SEC-66). Typed reasons are not read.
  function rejectionCounts(state, to) {
    const lo = new Date(Date.parse(to + 'T00:00:00Z') - REJECT_WINDOW_DAYS * DAY).toISOString().slice(0, 10), out = {};
    for (const i of state.memory.insights) {
      if (i.status !== 'rejected' || !REASONS.includes(i.reason) || NO_AI.has(i.domain) || i.decidedAt === undefined) continue;
      const d = new Date(msOf(i.decidedAt)).toISOString().slice(0, 10);
      if (!(d >= lo)) continue;
      const a = out[i.domain] || (out[i.domain] = {});
      a[i.reason] = (a[i.reason] || 0) + 1;
    }
    return out;
  }

  // ---- B12: numeric target changes, applied only on a tap ----
  function targetPreview(state, id) {
    const ins = state.memory.insights.find((i) => i.id === id);
    if (!ins || !ins.target) throw new Error('That insight has no target change');
    const t = cleanTarget(ins.target, true), d = TARGETS[t.key];
    return { key: t.key, label: d.label, before: d.get(state), after: t.value, beforeText: d.fmt(d.get(state)), afterText: d.fmt(t.value), applied: !!t.applied };
  }
  // Sets the one setting and marks the insight applied. The caller commits it together with the approval, so it is one write.
  function applyTarget(state, id) {
    const ins = state.memory.insights.find((i) => i.id === id);
    if (!ins || !ins.target) throw new Error('That insight has no target change');
    if (ins.status !== 'approved') throw new Error('Approve the insight before applying its target change');
    const t = cleanTarget(ins.target, true);
    if (t.applied) throw new Error('That target change was already applied');
    const d = TARGETS[t.key], before = d.get(state);
    d.set(state, t.value);
    ins.target = { key: t.key, value: t.value, applied: true };
    return { key: t.key, label: d.label, before, after: t.value };
  }

  // ---- B11: review due, streak, consolidation offers ----
  const dayNo = (iso) => { const p = iso.split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]) / DAY; };
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const monthEnd = (y, m) => y + '-' + pad2(m) + '-' + pad2(new Date(Date.UTC(y, m, 0)).getUTCDate());
  function reviewDue(state, today) {
    const last = state.memory.lastReviewAt || '';
    // SEC-102: never reviewed counts from the day the loop started (vault creation; for an older vault its earliest dated trace, else the upgrade day).
    if (!last) {
      const since = state.memory.startedOn || '';
      return { due: !!since && dayNo(today) - dayNo(since) >= 7, never: true, days: null, last: '' };
    }
    const days = Math.max(0, dayNo(today) - dayNo(last));
    return { due: days >= 7, never: false, days, last };
  }
  function markReviewed(state, today) {
    if (!L.metrics.isDate(today)) throw new Error('Invalid date');
    if (!state.memory.lastReviewAt || today > state.memory.lastReviewAt) state.memory.lastReviewAt = today;
  }
  // Consecutive ISO weeks with a finished review, counted back from this week (or from last week while this week has none yet).
  function reviewStreak(state, today) {
    const weeks = new Set(state.memory.reviews.map((r) => L.metrics.weekStart(r.weekOf)));
    let w = L.metrics.weekStart(today), n = 0;
    if (!weeks.has(w)) w = L.metrics.addDays(w, -7);
    while (weeks.has(w)) { n++; w = L.metrics.addDays(w, -7); }
    return n;
  }
  const mergeable = (state) => state.memory.insights.filter((i) => i.status === 'approved' && !NO_AI.has(i.domain) && !isBodyInsight(i));
  // The last month and the last quarter that have ended, with what would be merged. Offers only: nothing is created until a tap.
  function consolidationOffers(state, today) {
    if (!L.metrics.isDate(today)) throw new Error('Invalid date');
    const y = +today.slice(0, 4), m = +today.slice(5, 7), ins = state.memory.insights, all = mergeable(state), out = [];
    const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
    const mp = { from: py + '-' + pad2(pm) + '-01', to: monthEnd(py, pm) };
    const mi = all.filter((i) => i.level === 1 && i.period.from >= mp.from && i.period.from <= mp.to);
    if (mi.length && !ins.some((i) => i.level === 2 && i.period.from === mp.from)) out.push({ level: 2, period: mp, count: mi.length, items: mi.map((i) => ({ domain: i.domain, text: i.text })) });
    const q = Math.floor((m - 1) / 3), pq = q === 0 ? 3 : q - 1, qy = q === 0 ? y - 1 : y;
    const qp = { from: qy + '-' + pad2(pq * 3 + 1) + '-01', to: monthEnd(qy, pq * 3 + 3) };
    const qi = all.filter((i) => i.level === 2 && i.period.from >= qp.from && i.period.from <= qp.to);
    if (qi.length && !ins.some((i) => i.level === 3 && i.period.from === qp.from)) out.push({ level: 3, period: qp, count: qi.length, items: qi.map((i) => ({ domain: i.domain, text: i.text })) });
    return out;
  }
  // Without an AI: one proposed entry that joins the approved insights of the period (their own words, cut at 280 characters).
  function mergeByRules(state, level, period) {
    checkLevel(level);
    if (level === 1) throw new Error('Invalid level');
    const p = checkPeriod(period);
    const src = mergeable(state).filter((i) => i.level === level - 1 && i.period.from >= p.from && i.period.from <= p.to);
    if (!src.length) throw new Error('Nothing approved to merge for that period.');
    let text = src.map((i) => i.text).join(' | ');
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 3) + '...';
    propose(state, [{ domain: 'overall', kind: 'merge', text }], { level, period: p, source: 'rules' });
    return src.length;
  }

  // Pure: returns a deep copy of state with every approved insight set back to proposed (no decidedAt).
  function demoteApproved(state) {
    const out = JSON.parse(JSON.stringify(state));
    for (const i of out.memory.insights) if (i.status === 'approved') { i.status = 'proposed'; delete i.decidedAt; }
    // Keep the format marker from store.validateState so an older-format backup is still recognised after re-queueing.
    if (state && typeof state.sourceSchema === 'number') Object.defineProperty(out, 'sourceSchema', { value: state.sourceSchema, enumerable: false });
    return out;
  }

  function approved(state, level) {
    return state.memory.insights.filter((i) => i.status === 'approved' && (level === undefined || i.level === level));
  }

  L.memory = { REASONS, REASON_LABEL, KIND_LABEL, TARGETS, rulesInsights, buildPrompt, parseResponse, propose, decide, approved, demoteApproved, cleanTarget, isMuted, mutedList, unmute, rejectionCounts, targetPreview, applyTarget, reviewDue, markReviewed, reviewStreak, consolidationOffers, mergeByRules };
})();
