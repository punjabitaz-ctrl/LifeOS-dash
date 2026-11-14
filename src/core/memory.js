(function () {
  'use strict';
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const MAX_TEXT = 280, MAX_ITEMS = 5, LESSON_CAP = 30, INSIGHT_CAP = 5000, CTX_MAX = 8;
  // SEC-66 (owner decision): wellbeing never reaches the AI. Prompts, the domain list the model may answer with, rules insights
  // and new proposals leave it out; earlier wellbeing insights stay in the vault but are never sent.
  const NO_AI = new Set(['wellbeing']);
  const domains = () => L.DOMAINS.map((d) => d.id).filter((id) => !NO_AI.has(id)).concat(['overall']);
  const BIDI = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
  const newId = () => L._webcrypto.randomUUID();

  function checkPeriod(p) {
    if (!p || !L.metrics.isDate(p.from) || !L.metrics.isDate(p.to) || p.from > p.to) throw new Error('Invalid period');
    return { from: p.from, to: p.to };
  }
  function checkLevel(l) { if (l !== 1 && l !== 2 && l !== 3) throw new Error('Invalid level'); return l; }

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
      let text = null;
      const dir = now > prev ? 'up' : 'down';
      switch (d.id) {
        case 'health':
          text = now < t.workoutsPerWeek
            ? 'Workouts: ' + now + ' this week against a target of ' + t.workoutsPerWeek + ' (last week ' + prev + ').'
            : 'Workout target met: ' + now + ' of ' + t.workoutsPerWeek + ' this week.';
          break;
        case 'social':
          if (now > 0) text = now + (now === 1 ? ' person is' : ' people are') + ' overdue for contact (more than ' + t.contactDays + ' days).';
          else if (prev > 0) text = 'Nobody is overdue for contact now, down from ' + prev + ' last week.';
          break;
        case 'money':
          if (now === 0) break;
          text = now < t.savingsRate * 100
            ? 'Savings rate this week was ' + now + '%, below your ' + Math.round(t.savingsRate * 100) + '% target.'
            : 'Savings rate this week was ' + now + '%, at or above your ' + Math.round(t.savingsRate * 100) + '% target.';
          break;
        case 'assets':
          if (now !== prev) text = 'Net worth moved ' + dir + ' from ' + money(prev) + ' to ' + money(now) + '.';
          break;
        case 'home':
          text = 'Maintenance tasks overdue: ' + now + ' (last week ' + prev + ').';
          break;
        case 'admin':
          text = 'Admin items due within 30 days: ' + now + ' (last week ' + prev + ').';
          break;
        case 'goals':
          if (now === 0 && prev === 0) break;
          if (now !== prev) text = 'Share of goals on track moved ' + dir + ' from ' + prev + '% to ' + now + '%.';
          break;
        default:
          if (now !== prev) text = d.label + ': ' + now + ' ' + unit + ' this week, ' + dir + ' from ' + prev + '.';
      }
      if (text) out.push({ domain: d.id, text: text.slice(0, MAX_TEXT) });
    }
    // Health: numeric facts only, never advice.
    const hd = dg.health, ph = L.metrics.healthDigest(state, L.metrics.addDays(dg.week, -7));
    if (hd) {
      const unit = state.settings.health ? state.settings.health.units : 'lb';
      if (hd.avgSleep > 0) out.push({ domain: 'health', text: ('Average sleep this week was ' + hd.avgSleep + ' hours' + (ph.avgSleep > 0 ? ' (last week ' + ph.avgSleep + ').' : '.')).slice(0, MAX_TEXT) });
      if (hd.weightChange !== 0) out.push({ domain: 'health', text: ('Weight moved ' + (hd.weightChange < 0 ? 'down ' : 'up ') + Math.abs(hd.weightChange) + ' ' + unit + ' this week.').slice(0, MAX_TEXT) });
      if ((state.habits || []).length && (hd.habitRate > 0 || ph.habitRate > 0)) out.push({ domain: 'health', text: ('Daily checks completed: ' + hd.habitRate + '% this week (last week ' + ph.habitRate + '%).').slice(0, MAX_TEXT) });
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
      ctx = approvedAll.filter((i) => !isBodyInsight(i)).slice(-CTX_MAX);
      lines.push('Approved insights so far:');
    } else {
      const from = level - 1;
      ctx = approvedAll.filter((i) => !isBodyInsight(i) && i.level === from && i.period.from >= p.from && i.period.to <= p.to).slice(-CTX_MAX);
      lines.push('Level ' + level + (level === 2 ? ' monthly' : ' quarterly') + ' consolidation for ' + p.from + ' to ' + p.to + '.',
        'Approved level ' + from + ' insights to consolidate:');
    }
    if (!ctx.length) lines.push('- none');
    for (const i of ctx) lines.push('- [' + i.domain + '] ' + i.text);
    lines.push('Lessons from earlier rejections (respect these):');
    const ls = mem.lessons.slice(-CTX_MAX);
    if (!ls.length) lines.push('- none');
    for (const l of ls) lines.push('- ' + l.text);
    lines.push('Return the JSON array now.');
    const system = 'You are a careful personal reflection assistant. You only see numeric summaries and short approved notes, never raw records. ' +
      'Reply with ONLY a JSON array of at most ' + MAX_ITEMS + ' objects shaped {"domain":string,"text":string}. ' +
      'domain must be one of: ' + domains().join(', ') + '. text is plain text, at most ' + MAX_TEXT + ' characters, specific and grounded in the numbers given. ' +
      'Do not invent data. Do not give medical, legal or financial advice. Follow the lessons.';
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
      return { domain: x.domain, text: s };
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
      if (ins.some((x) => x.level === level && x.period.from === p.from && x.domain === it.domain && x.text === text)) continue;
      if (ins.length >= INSIGHT_CAP) throw new Error('Insight limit reached');
      ins.push({ id: newId(), level, period: { from: p.from, to: p.to }, domain: it.domain, text, source, status: 'proposed', createdAt: new Date().toISOString() });
    }
  }

  function decide(state, id, decision, reason) {
    if (decision !== 'approved' && decision !== 'rejected') throw new Error('Invalid decision');
    const ins = state.memory.insights.find((i) => i.id === id);
    if (!ins) throw new Error('Insight not found');
    ins.status = decision;
    ins.decidedAt = new Date().toISOString();
    // Lessons are sent with every prompt, so a reason given for an earlier wellbeing insight is not kept as one (SEC-66).
    if (decision === 'rejected' && typeof reason === 'string' && !NO_AI.has(ins.domain)) {
      const r = reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_TEXT);
      if (r) {
        const ls = state.memory.lessons;
        ls.push({ id: newId(), text: r, createdAt: ins.decidedAt });
        while (ls.length > LESSON_CAP) ls.shift();
      }
    }
    return ins;
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

  L.memory = { rulesInsights, buildPrompt, parseResponse, propose, decide, approved, demoteApproved };
})();
