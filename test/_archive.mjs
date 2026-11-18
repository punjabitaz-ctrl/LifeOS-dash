// Fixtures for the v1.2.0 part B tests: a vault with data across six years and every archivable collection.
import { L, memAdapter, PASS, E } from './_load.mjs';

export const PRIV = 'a private passphrase 99';
export const TODAY = '2026-11-10';
export const ARCH_MARK = 'ARCHIVELEAK';
export const clone = (x) => JSON.parse(JSON.stringify(x));
const pad = (n) => String(n).padStart(2, '0');
// Real PBKDF2 (600000) is exercised in the crypto tests; everywhere else a fast derivation keeps the files quick.
let ORIG = null;
export function fastKeys() {
  if (ORIG) return;
  ORIG = L.vault.deriveKey;
  L.vault.deriveKey = async (pass, salt) => {
    const base = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return globalThis.crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  };
}
export function realKeys() { if (ORIG) { L.vault.deriveKey = ORIG; ORIG = null; } }

export function build(years = [2021, 2022, 2023, 2024, 2025, 2026]) {
  const s = L.store.defaultState();
  s.accounts.push({ id: 'acc1', name: 'Main', kind: 'cash', liability: false, archived: false }, { id: 'acc2', name: 'Card', kind: 'credit', liability: true, archived: false },
    { id: 'acc3', name: 'Old savings', kind: 'investment', liability: false, archived: false });
  s.projects.push({ id: 'p1', name: 'Venture ' + ARCH_MARK, kind: 'venture', status: 'active', nextAction: '', archived: false });
  s.budgets.push({ category: 'Groceries', value: 300 });
  s.habits.push({ id: 'h1', name: 'Walk' });
  s.learningItems.push({ id: 'li1', title: 'Course ' + ARCH_MARK, kind: 'course', provider: 'x', state: 'active', unitLabel: 'unit', totalUnits: 10, doneUnits: 2, notes: '', createdAt: '2026-01-01T00:00:00.000Z' });
  s.groups.push({ id: 'sg1', name: 'Friends', cadenceDays: 30 });
  s.people.push({ id: 'sp1', name: 'Ann ' + ARCH_MARK, groupId: 'sg1', cadenceDays: 30, importantDates: [], pipelineIds: [], projectIds: [] },
    { id: 'sp2', name: 'Old friend', groupId: 'sg1', cadenceDays: 30, importantDates: [], pipelineIds: [], projectIds: [] });
  s.properties.push({ id: 'pp1', name: 'House', kind: 'house', archived: false });
  s.settings.learning = { weeklyMinutes: 60 };
  let n = 0;
  const ent = (o) => E(Object.assign({ id: 'e' + (n++) }, o));
  for (const y of years) {
    for (let m = 1; m <= 12; m++) {
      const mm = y + '-' + pad(m);
      s.entries.push(ent({ domain: 'money', type: 'income', date: mm + '-05', title: 'Pay ' + ARCH_MARK, value: 3000 + (y % 10) * 10 + m + 0.37, category: 'Salary', status: 'received' }));
      s.entries.push(ent({ domain: 'money', type: 'expense', date: mm + '-09', title: 'Food ' + ARCH_MARK, value: 210.5 + m, category: 'Groceries', projectId: m % 2 ? 'p1' : undefined }));
      s.entries.push(ent({ domain: 'money', type: 'expense', date: mm + '-17', title: 'Out ' + ARCH_MARK, value: 40.25 + y % 7, category: 'Dining' }));
      s.entries.push(ent({ domain: 'assets', type: 'balance', date: mm + '-28', title: 'Main', accountId: 'acc1', value: 5000 + (y - 2020) * 1000 + m * 17 }));
      s.entries.push(ent({ domain: 'assets', type: 'balance', date: mm + '-28', title: 'Card', accountId: 'acc2', value: 400 + m * 3 }));
      for (let k = 0; k < 4; k++) s.entries.push(ent({ domain: 'health', type: 'workout', date: mm + '-' + pad(3 + k * 6), title: 'Run ' + ARCH_MARK, kind: 'run', minutes: 30 }));
      s.entries.push(ent({ domain: 'health', type: 'sleep', date: mm + '-11', title: 'Sleep', value: 6.5 + (m % 3) * 0.5 }));
      s.entries.push(ent({ domain: 'health', type: 'weight', date: mm + '-12', title: 'Weight', value: 180 - m * 0.4 }));
      s.entries.push(ent({ domain: 'wellbeing', type: 'mood', date: mm + '-13', title: 'Mood', value: 1 + (m % 5) }));
      s.studySessions.push({ id: 'ss' + y + m, itemId: 'li1', date: mm + '-14', minutes: 30 + m, notes: 'note ' + ARCH_MARK });
      s.contacts.push({ id: 'sc' + y + m, personId: 'sp1', date: mm + '-15', channel: 'call', notes: 'talked ' + ARCH_MARK });
    }
    s.trips.push({ id: 'tr' + y, date: y + '-06-01', from: 'A', to: 'B', miles: 12.3, purpose: 'visit', projectId: 'p1', roundTrip: false });
    s.taxPayments.push({ id: 'tp' + y, year: y, jurisdiction: 'federal', quarter: 2, amountCents: 50000 + y, paidOn: y + '-06-15', confirmation: 'c' });
    s.activities.push({ id: 'ac' + y, title: 'Hike ' + ARCH_MARK, category: s.activityCategories[0], state: 'done', date: y + '-07-04', minutes: 90, place: 'Hill', withPeople: [], costCents: 2500 + y % 100, worthIt: 4 });
    s.activities.push({ id: 'as' + y, title: 'Skipped ' + ARCH_MARK, category: s.activityCategories[0], state: 'skipped', date: y + '-08-04', place: '', withPeople: [] });
    s.maintenance.push({ id: 'mt' + y, title: 'Gutters', area: 'house', cadence: 'annual', vendor: '', notes: '', state: 'done', lastDone: y + '-05-20', cost: 100, propertyId: 'pp1' });
    s.renewals.push({ id: 'rn' + y, title: 'Insurance', kind: 'insurance', provider: 'P', dueDate: y + '-09-01', cadence: 'once', autoRenews: false, state: 'done', doneOn: y + '-09-01', amount: 30, notes: '' });
    s.invoices.push({ id: 'iv' + y, number: 'INV-' + y, projectId: 'p1', issueDate: y + '-03-01', dueDate: y + '-03-31', lines: [{ description: 'Work', qty: 1, unitCents: 100000 }], status: 'paid', paidOn: y + '-03-20', incomeId: 'ein' + y, notes: '' });
    s.entries.push(ent({ id: 'ein' + y, domain: 'money', type: 'income', date: y + '-03-20', title: 'Invoice ' + ARCH_MARK, value: 1000, category: 'Business', status: 'received', projectId: 'p1' }));
  }
  if (years.includes(2021)) {
    s.entries.push(ent({ id: 'exp-open', domain: 'money', type: 'income', date: '2021-12-01', title: 'Expected', value: 500, category: 'Business', status: 'expected' }));
    s.entries.push(ent({ id: 'wo', domain: 'money', type: 'income', date: '2021-11-01', title: 'Lost', value: 77, category: 'Business', status: 'written-off' }));
    s.entries.push(ent({ id: 'bill', domain: 'money', type: 'expense', date: '2021-10-01', title: 'Billable', value: 33, category: 'Other', billable: true }));
    s.entries.push(ent({ id: 'old-bal', domain: 'assets', type: 'balance', date: '2021-04-02', title: 'Old savings', accountId: 'acc3', value: 12345.67 }));
    s.contacts.push({ id: 'old-c', personId: 'sp2', date: '2021-02-02', channel: 'call', notes: '' });
    // an open invoice that points at an income entry of 2021: both stay
    s.entries.push(ent({ id: 'keepinc', domain: 'money', type: 'income', date: '2021-05-05', title: 'Linked', value: 10, category: 'Business', status: 'received' }));
    s.invoices.push({ id: 'ivopen', number: 'OPEN-1', issueDate: '2021-05-01', dueDate: '2021-06-01', lines: [{ description: 'Open', qty: 1, unitCents: 1000 }], status: 'sent', incomeId: 'keepinc', notes: '' });
    // a live activity points at a 2021 expense
    s.entries.push(ent({ id: 'actexp', domain: 'money', type: 'expense', date: '2021-07-04', title: 'Activity cost', value: 25, category: 'Other' }));
    s.activities.push({ id: 'live-done', title: 'Live done', category: s.activityCategories[0], state: 'done', date: '2024-07-04', place: '', withPeople: [], costCents: 2500, expenseId: 'actexp', paidOn: '2021-07-04' });
    s.activities.push({ id: 'live-plan', title: 'Planned', category: s.activityCategories[0], state: 'planned', date: '2021-12-20', place: '', withPeople: [] });
    s.habitLog.push({ habitId: 'h1', date: '2021-03-01' }, { habitId: 'h1', date: '2021-12-30' }, { habitId: 'h1', date: '2021-12-31' }, { habitId: 'h1', date: '2022-01-01' });
  }
  s.memory.reviews = [];
  if (years.includes(2021)) for (let w = 0; w < 12; w++) s.memory.reviews.push({ id: 'rvx' + w, weekOf: '2021-0' + (w < 9 ? w + 1 : 9) + '-0' + (w % 7 + 1), digest: L.metrics.weeklyDigest(s, '2021-01-04'), priorities: ['a', 'b', 'c'], completedAt: '2021-03-08T00:00:00.000Z' });
  for (const y of years) s.memory.reviews.push({ id: 'rv' + y, weekOf: y + '-03-01', digest: L.metrics.weeklyDigest(s, y + '-03-01'), priorities: ['a', 'b', 'c'], completedAt: y + '-03-08T00:00:00.000Z' });
  for (const y of years) s.memory.insights.push({ id: 'in' + y, level: 1, period: { from: y + '-03-01', to: y + '-03-07' }, domain: 'money', text: 'rejected text ' + y, source: 'rules', status: 'rejected', createdAt: 1 });
  return L.store.validateState(s);
}

export async function vault(state, o = {}) {
  fastKeys();
  const ad = memAdapter(); L.store._setAdapter(ad); L.store.lock(); await L.store.init(PASS);
  if (state) await L.store.replaceState(state);
  if (o.priv) await L.priv.setUp(PRIV);
  return ad;
}
export const io = (box = {}) => ({
  put: async (n, t) => { (box.files = box.files || {})[n] = t; },
  get: async (n) => (box.corrupt ? box.files[n].slice(0, -20) + 'AAAAAAAAAAAAAAAAAAAA' : box.files[n]),
  save: (n, t) => { (box.saved = box.saved || {})[n] = t; },
  confirmSaved: async () => box.confirm !== false,
});

// Every figure the views, charts, net worth history and goals show, as plain numbers. `all` includes the months of archived years.
export function figuresIn(L, today) {
  const pad = (n) => String(n).padStart(2, '0');
  const st = L.store.getState(), M = L.metrics, R = L.revenue, G = L.goals;
  const f = {};
  const months = [];
  for (let y = 2021; y <= 2026; y++) for (let m = 1; m <= 12; m++) months.push(y + '-' + pad(m));
  const live = (mo) => mo >= '2024-01';
  f.monthViews = {}; f.rev = {}; f.revLine = {}; f.revUn = {}; f.goalMoney = {};
  for (const mo of months) {
    if (mo > today.slice(0, 7)) break;
    f.monthViews[mo] = M.monthView(st, mo);
    f.rev[mo] = R.totalsIn(st, { kind: 'all' }, mo + '-01', M.monthEnd(mo));
    f.revLine[mo] = R.totalsIn(st, { kind: 'line', id: 'p1' }, mo + '-01', M.monthEnd(mo));
    f.revUn[mo] = R.totalsIn(st, { kind: 'unassigned' }, mo + '-01', M.monthEnd(mo));
    const asOf = mo === today.slice(0, 7) ? today : M.monthEnd(mo);
    f.goalMoney[mo] = { nw: G.currentValue(st, { metric: 'netWorth' }, asOf), sr: G.currentValue(st, { metric: 'savingsRate' }, asOf), ms: G.currentValue(st, { metric: 'monthlySpend' }, asOf) };
  }
  f.cashflow = M.cashflow(st, 60, today);
  f.nwHistory = M.netWorthHistory(st, 120, today);
  f.nwNow = (({ totalCents, assetsCents, liabilitiesCents, count, byKind }) => ({ totalCents, assetsCents, liabilitiesCents, count, byKind }))(M.netWorthDetail(st, today));
  f.monthly = R.monthly(st, { kind: 'all' }, today.slice(0, 7), 60);
  f.monthlyLine = R.monthly(st, { kind: 'line', id: 'p1' }, today.slice(0, 7), 60);
  for (const [k, from, to] of [['y2021', '2021-01-01', '2021-12-31'], ['q', '2024-04-01', '2024-06-30'], ['span', '2021-07-01', '2022-06-30'], ['all', '2021-01-01', today]]) f['report_' + k] = R.report(st, { from, to });
  f.periods = {};
  for (const k of ['month', 'lastMonth', 'qtd', 'ytd', 't12']) f.periods[k] = R.report(st, R.periodRange(k, today));
  f.headline = {};
  for (const d of M.DOMAINS) f.headline[d.id] = M.headline(st, d.id, today);
  f.series = {};
  for (const d of M.DOMAINS) f.series[d.id] = M.series(st, d.id, 104, today);
  f.digest = M.weeklyDigest(st, M.weekStart(today));
  f.goals = {};
  for (const m of G.METRICS.map((x) => x.id)) {
    if (['manual', 'itemProgress'].includes(m) || G.isWellbeingMetric(m)) continue;
    f.goals[m] = {};
    for (const mo of months) { if (!live(mo) || mo > today.slice(0, 7)) continue; f.goals[m][mo] = G.currentValue(st, { metric: m, id: 'g' }, mo === today.slice(0, 7) ? today : M.monthEnd(mo)); }
  }
  const bm = (t) => { const x = M.bodyMetrics(st, t, today); return { latest: x.latest, avg: x.avg, start: x.start, weeklyRate: x.weeklyRate, progressPct: x.progressPct, toTarget: x.toTarget }; };
  f.body = { weight: bm('weight'), bodyfat: bm('bodyfat') };
  f.habit = (st.habits || []).map((h) => M.habitStats(st, h.id, today));
  f.sleep = (({ avg7, nights7, prevAvg7, delta }) => ({ avg7, nights7, prevAvg7, delta }))(M.sleepSummary(st, today));
  f.study = { streak: L.learning.streak(st, today), week: L.learning.studyWeek(st, M.weekStart(today), today), stalled: L.learning.stalled(st, today), last: L.learning.lastSession(st, 'li1', today) };
  f.peopleGoal = L.social.goalOverdue(st, today);
  f.maint = { overdue: L.home.overdueValue(st, today) };
  f.admin = L.admin.overdueValue(st, today);
  f.goalSummary = G.summary(st, today);
  return JSON.parse(JSON.stringify(f));
}
export const figures = (today) => figuresIn(L, today);
