// Demo dataset for showcase screenshots. Every name, amount, place and date below is invented; nothing comes from a real vault.
// Writes an encrypted LifeOS backup file that the lock screen's "Restore from a backup file" opens with DEMO_PASS.
// Usage: node scripts/demo-seed.mjs [outFile] [today YYYY-MM-DD]
//   outFile defaults to demo/lifeos-demo-backup.json; today defaults to the device's local date (dates are laid out around it).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import '../src/core/vault.js'; import '../src/core/ops.js'; import '../src/core/nav.js'; import '../src/core/setup.js';
import '../src/core/store.js'; import '../src/core/priv.js'; import '../src/core/wellbeing.js'; import '../src/core/csv.js';
import '../src/core/metrics.js'; import '../src/core/home.js'; import '../src/core/admin.js'; import '../src/core/learning.js';
import '../src/core/activities.js'; import '../src/core/social.js'; import '../src/core/revenue.js'; import '../src/core/tax.js';
import '../src/core/business.js'; import '../src/core/clients.js'; import '../src/core/media.js'; import '../src/core/layout.js';
import '../src/core/goals.js'; import '../src/core/memory.js'; import '../src/core/ai.js'; import '../src/core/calendar.js';
import '../src/core/jobs.js'; import '../src/core/search.js'; import '../src/core/sync.js'; import '../src/core/nas.js'; import '../src/core/archive.js';

export const DEMO_PASS = 'demo passphrase 2026';
const L = globalThis.LifeOS;
const out = process.argv[2] || 'demo/lifeos-demo-backup.json';
const TODAY = process.argv[3] || L.metrics.todayISO();
const add = (d, n) => L.metrics.addDays(d, n);
const pad = (n) => String(n).padStart(2, '0');
const month = (k) => L.metrics.addMonths(TODAY.slice(0, 7), k); // k = 0 this month, -1 last month
const ts = (d) => d + 'T12:00:00.000Z';
// A small seeded generator so every run makes the same numbers.
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const jitter = (base, spread) => Math.round((base + (rnd() - 0.5) * 2 * spread) * 100) / 100;

const s = L.store.defaultState();
let n = 0;
const id = (p) => p + '-' + (++n);
const E = (o) => L.metrics.validateEntry(Object.assign({ id: id('e'), createdAt: ts(o.date) }, o));

// ---- settings ----
s.settings.autoLockMin = 60;
s.settings.targets = { workoutsPerWeek: 4, contactDays: 21, savingsRate: 0.25 };
s.settings.learning = { weeklyMinutes: 180 };
s.settings.setup = { dismissed: true, targetsSaved: true };
s.memory.startedOn = add(TODAY, -330);

// ---- accounts and twelve months of money ----
s.accounts.push(
  { id: 'acc-chk', name: 'Everyday checking', kind: 'cash', liability: false, archived: false },
  { id: 'acc-sav', name: 'High-yield savings', kind: 'cash', liability: false, archived: false },
  { id: 'acc-ret', name: 'Retirement fund', kind: 'retirement', liability: false, archived: false },
  { id: 'acc-brk', name: 'Index portfolio', kind: 'investment', liability: false, archived: false },
  { id: 'acc-card', name: 'Travel card', kind: 'credit', liability: true, archived: false },
  { id: 'acc-car', name: 'Car loan', kind: 'loan', liability: true, archived: false });
s.budgets.push({ category: 'Groceries', value: 650 }, { category: 'Dining', value: 300 }, { category: 'Transport', value: 250 }, { category: 'Subscriptions', value: 90 });

// Lines of work: a main job plus a small studio with two client lines and a podcast and website under it.
s.projects.push(
  { id: 'p-job', name: 'Day job: Partner programs', kind: 'job', status: 'active', nextAction: 'Ship the Q1 partner tier plan', nextDate: add(TODAY, 3), archived: false },
  { id: 'p-studio', name: 'Maple & Main Studio', kind: 'venture', status: 'active', nextAction: 'Send December retainer invoices', nextDate: add(TODAY, 2), archived: false, budgetCents: 60000, budgetPeriod: 'month' },
  { id: 'p-cl-a', name: 'Client: Juniper Bakery Co.', kind: 'client', status: 'active', nextAction: 'Holiday menu landing page review', nextDate: add(TODAY, 1), archived: false, parentId: 'p-studio' },
  { id: 'p-cl-b', name: 'Client: Orbit Bicycle Works', kind: 'client', status: 'active', nextAction: 'Draft spring partner kit', nextDate: add(TODAY, 6), archived: false, parentId: 'p-studio' },
  { id: 'p-pod', name: 'Podcast: Side Quest Hours', kind: 'podcast', status: 'active', nextAction: 'Edit episode 14', nextDate: add(TODAY, 4), archived: false, parentId: 'p-studio' },
  { id: 'p-web', name: 'Studio website', kind: 'website', status: 'active', nextAction: 'Add two case studies', nextDate: add(TODAY, 9), archived: false, parentId: 'p-studio' },
  { id: 'p-home', name: 'Kitchen refresh', kind: 'personal', status: 'paused', nextAction: 'Pick a countertop quote', archived: false });

for (let k = -11; k <= 0; k++) {
  const m = month(k), cur = k === 0, lastDay = cur ? +TODAY.slice(8, 10) : 28;
  const day = (d) => m + '-' + pad(Math.min(d, lastDay));
  const inMonth = (d) => d <= lastDay;
  if (inMonth(1)) s.entries.push(E({ domain: 'money', type: 'income', date: day(1), title: 'Salary', value: 2900, category: 'Salary', scope: 'personal', projectId: 'p-job' }));
  if (inMonth(15)) s.entries.push(E({ domain: 'money', type: 'income', date: day(15), title: 'Salary', value: 2900, category: 'Salary', scope: 'personal', projectId: 'p-job' }));
  if (inMonth(3)) s.entries.push(E({ domain: 'money', type: 'expense', date: day(3), title: 'Car payment', value: 410, category: 'Transport', scope: 'personal' }));
  if (inMonth(5)) s.entries.push(E({ domain: 'money', type: 'expense', date: day(5), title: 'Health insurance', value: 286, category: 'Health', scope: 'personal' }));
  if (inMonth(7)) s.entries.push(E({ domain: 'money', type: 'expense', date: day(7), title: 'Phone plan', value: 75, category: 'Utilities', scope: 'personal' }));
  for (const d of [10, 24]) if (inMonth(d)) s.entries.push(E({ domain: 'money', type: 'expense', date: day(d), title: d === 10 ? 'Clothes' : 'Home goods', value: jitter(160, 70), category: 'Shopping', scope: 'personal' }));
  // Studio income grows over the year.
  const grow = 11 + k;
  if (inMonth(8)) s.entries.push(E({ domain: 'money', type: 'income', date: day(8), title: 'Juniper Bakery retainer', value: 1200 + grow * 60, category: 'Business', scope: 'business', projectId: 'p-cl-a' }));
  if (k >= -7 && inMonth(20)) s.entries.push(E({ domain: 'money', type: 'income', date: day(20), title: 'Orbit Bicycle Works sprint', value: jitter(1650 + grow * 90, 200), category: 'Business', scope: 'business', projectId: 'p-cl-b' }));
  if (k >= -5 && inMonth(25)) s.entries.push(E({ domain: 'money', type: 'income', date: day(25), title: 'Podcast sponsor spot', value: 250 + grow * 25, category: 'Business', scope: 'business', projectId: 'p-pod' }));
  if (inMonth(2)) s.entries.push(E({ domain: 'money', type: 'expense', date: day(2), title: 'Rent', value: 2450, category: 'Housing', scope: 'personal' }));
  for (const d of [4, 11, 18, 25]) if (inMonth(d)) s.entries.push(E({ domain: 'money', type: 'expense', date: day(d), title: 'Groceries', value: jitter(142, 30), category: 'Groceries', scope: 'personal' }));
  for (const d of [6, 14, 22]) if (inMonth(d)) s.entries.push(E({ domain: 'money', type: 'expense', date: day(d), title: 'Dinner out', value: jitter(68, 25), category: 'Dining', scope: 'personal' }));
  if (inMonth(9)) s.entries.push(E({ domain: 'money', type: 'expense', date: day(9), title: 'Transit pass', value: 132, category: 'Transport', scope: 'personal' }));
  if (inMonth(12)) s.entries.push(E({ domain: 'money', type: 'expense', date: day(12), title: 'Electric and gas', value: jitter(118, 40), category: 'Utilities', scope: 'personal' }));
  if (inMonth(16)) s.entries.push(E({ domain: 'money', type: 'expense', date: day(16), title: 'Streaming and music', value: 34.98, category: 'Subscriptions', scope: 'personal' }));
  if (inMonth(10)) s.entries.push(E({ domain: 'money', type: 'expense', date: day(10), title: 'Design software', value: 59.99, category: 'Subscriptions', scope: 'business', projectId: 'p-studio' }));
  if (k >= -5 && inMonth(19)) s.entries.push(E({ domain: 'money', type: 'expense', date: day(19), title: 'Podcast hosting', value: 19, category: 'Subscriptions', scope: 'business', projectId: 'p-pod' }));
  if (k >= -5 && inMonth(21)) s.entries.push(E({ domain: 'money', type: 'expense', date: day(21), title: 'Freelance editor', value: 220, category: 'Other', scope: 'business', projectId: 'p-studio' }));
  if (k % 3 === 0 && inMonth(23)) s.entries.push(E({ domain: 'money', type: 'expense', date: day(23), title: 'Weekend trip', value: jitter(420, 120), category: 'Travel', scope: 'personal' }));
  // Month-end balances: steady saving, a growing portfolio, a shrinking car loan.
  const t = k + 11, bd = cur ? TODAY : day(28);
  s.entries.push(E({ domain: 'assets', type: 'balance', date: bd, title: 'Everyday checking', accountId: 'acc-chk', value: jitter(5200 + t * 120, 300) }));
  s.entries.push(E({ domain: 'assets', type: 'balance', date: bd, title: 'High-yield savings', accountId: 'acc-sav', value: 18500 + t * 1150 }));
  s.entries.push(E({ domain: 'assets', type: 'balance', date: bd, title: 'Retirement fund', accountId: 'acc-ret', value: Math.round(84200 * (1 + t * 0.011) + t * 900) }));
  s.entries.push(E({ domain: 'assets', type: 'balance', date: bd, title: 'Index portfolio', accountId: 'acc-brk', value: Math.round(26400 * (1 + t * 0.013 + (t % 4 === 2 ? -0.02 : 0)) + t * 500) }));
  s.entries.push(E({ domain: 'assets', type: 'balance', date: bd, title: 'Travel card', accountId: 'acc-card', value: -jitter(1150, 400) }));
  s.entries.push(E({ domain: 'assets', type: 'balance', date: bd, title: 'Car loan', accountId: 'acc-car', value: -(14800 - t * 410) }));
}
// Expected and overdue studio income.
s.entries.push(E({ domain: 'money', type: 'income', date: add(TODAY, -12), title: 'Orbit Bicycle Works: dealer kit', value: 2400, category: 'Business', scope: 'business', projectId: 'p-cl-b', status: 'expected', dueDate: add(TODAY, -4) }));
s.entries.push(E({ domain: 'money', type: 'income', date: add(TODAY, -2), title: 'Juniper Bakery: holiday campaign', value: 1800, category: 'Business', scope: 'business', projectId: 'p-cl-a', status: 'expected', dueDate: add(TODAY, 12) }));
s.recurring.push(
  { id: 'r-rent', title: 'Rent', value: 2450, category: 'Housing', type: 'expense', cadence: 'monthly', nextDate: month(1) + '-02', active: true, household: true },
  { id: 'r-util', title: 'Electric and gas', value: 120, category: 'Utilities', type: 'expense', cadence: 'monthly', nextDate: month(1) + '-12', active: true, household: true },
  { id: 'r-net', title: 'Home internet', value: 65, category: 'Utilities', type: 'expense', cadence: 'monthly', nextDate: add(TODAY, 5), active: true, household: true },
  { id: 'r-pay', title: 'Salary', value: 2900, category: 'Salary', type: 'income', cadence: 'monthly', nextDate: month(1) + '-01', active: true });

// ---- work: weekly outcomes and a deal pipeline ----
const wk = L.metrics.weekStart(TODAY);
const outc = [['Partner tier plan: first draft', 'p-job', 'done', 0], ['Quarterly partner review deck', 'p-job', 'done', 1], ['Onboard two new referral partners', 'p-job', 'todo', 3],
  ['Juniper holiday landing page', 'p-cl-a', 'done', 1], ['Orbit dealer kit: final layout', 'p-cl-b', 'todo', 2], ['Record episode 14', 'p-pod', 'done', 0], ['Publish case study: Juniper', 'p-web', 'todo', 4]];
for (const [title, pid, status, d] of outc) s.entries.push(E({ domain: 'work', type: 'outcome', date: add(wk, d), title, projectId: pid, status }));
for (let w = 1; w <= 6; w++) for (let i = 0; i < 4 + (w % 3); i++) s.entries.push(E({ domain: 'work', type: 'outcome', date: add(wk, -7 * w + i), title: 'Weekly outcome ' + (w * 10 + i), projectId: ['p-job', 'p-cl-a', 'p-cl-b', 'p-pod'][i % 4], status: i < 3 + (w % 2) ? 'done' : 'todo' }));
s.pipeline.push(
  { id: 'pl-1', title: 'Retainer: brand refresh', org: 'Fernhill Dental Group', kind: 'deal', stage: 'contacted', source: 'Referral', nextStep: 'Send scope and two options', nextDate: add(TODAY, 2), updatedAt: add(TODAY, -3), notes: '' },
  { id: 'pl-2', title: 'Spring campaign sprint', org: 'Orbit Bicycle Works', kind: 'deal', stage: 'offer', source: 'Existing client', nextStep: 'Confirm start date', nextDate: add(TODAY, 1), updatedAt: add(TODAY, -1), notes: '' },
  { id: 'pl-3', title: 'Co-marketing partnership', org: 'Tidewater Coffee Roasters', kind: 'partner', stage: 'lead', source: 'Local meetup', nextStep: 'Intro call', nextDate: add(TODAY, 8), updatedAt: add(TODAY, -6), notes: '' },
  { id: 'pl-4', title: 'Podcast sponsorship, Q1', org: 'Brightfold Notebooks', kind: 'deal', stage: 'won', source: 'Inbound', nextStep: '', updatedAt: add(TODAY, -10), notes: '' },
  // Job search: a handful of fictional roles at made-up companies.
  { id: 'pl-j1', title: 'Senior Partner Manager', org: 'Lumenfold Robotics', kind: 'job', stage: 'interview', source: 'Referral', nextStep: 'Panel interview prep', nextDate: add(TODAY, 3), updatedAt: add(TODAY, -2), notes: '', role: 'Senior Partner Manager', locationType: 'hybrid', targetOteCents: 21000000, targetBaseCents: 15000000, appliedOn: add(TODAY, -21), resume: 'Partnerships v4', followUp: add(TODAY, 3) },
  { id: 'pl-j2', title: 'Channel Lead, Spatial Computing', org: 'Northpine XR', kind: 'job', stage: 'applied', source: 'Company site', nextStep: 'Follow up with recruiter', nextDate: add(TODAY, 1), updatedAt: add(TODAY, -8), notes: '', role: 'Channel Lead', locationType: 'remote', targetOteCents: 19500000, appliedOn: add(TODAY, -9), resume: 'Channel v2', followUp: add(TODAY, 1) },
  { id: 'pl-j3', title: 'Head of Alliances', org: 'Cobaltline AI', kind: 'job', stage: 'contacted', source: 'LinkedIn', nextStep: 'Coffee chat with hiring manager', nextDate: add(TODAY, 5), updatedAt: add(TODAY, -4), notes: '', role: 'Head of Alliances', locationType: 'on site', targetOteCents: 26000000, resume: 'Partnerships v4' },
  { id: 'pl-j4', title: 'Partner Enablement Manager', org: 'Quillwave Software', kind: 'job', stage: 'applied', source: 'Job board', nextStep: 'Wait for reply', updatedAt: add(TODAY, -15), notes: '', role: 'Partner Enablement Manager', locationType: 'remote', targetOteCents: 16500000, appliedOn: add(TODAY, -16), resume: 'Enablement v1', followUp: add(TODAY, -2) },
  { id: 'pl-j5', title: 'Ecosystem Partnerships Lead', org: 'Saltmarsh Labs', kind: 'job', stage: 'lost', source: 'Job board', nextStep: '', updatedAt: add(TODAY, -20), notes: '', role: 'Ecosystem Lead', locationType: 'hybrid', appliedOn: add(TODAY, -40), resume: 'Partnerships v3', lostReason: 'role closed' },
  { id: 'pl-j6', title: 'Strategic Partner Director', org: 'Harborlight Systems', kind: 'job', stage: 'lead', source: 'Referral', nextStep: 'Ask for intro', nextDate: add(TODAY, 4), updatedAt: add(TODAY, -1), notes: '', role: 'Partner Director', locationType: 'remote', targetOteCents: 24000000 });

// ---- social ----
s.groups.push({ id: 'g-fam', name: 'Family', cadenceDays: 14 }, { id: 'g-fr', name: 'Close friends', cadenceDays: 21 }, { id: 'g-net', name: 'Network', cadenceDays: 45 });
const P = (pid, name, groupId, extra) => Object.assign({ id: pid, name, groupId, importantDates: [], pipelineIds: [], projectIds: [], facts: [], notes: '', archived: false, addedOn: add(TODAY, -300) }, extra);
s.people.push(
  P('sp-1', 'Avery Chen', 'g-fam', { importantDates: [{ label: 'Birthday', monthDay: add(TODAY, 6).slice(5), year: 1988 }] }),
  P('sp-2', 'Sam Okafor', 'g-fr', {}),
  P('sp-3', 'Priya Nandakumar', 'g-fr', { importantDates: [{ label: 'Wedding anniversary', monthDay: add(TODAY, 19).slice(5) }] }),
  P('sp-4', 'Marco Delgado', 'g-net', { pipelineIds: ['pl-j1'] }),
  P('sp-5', 'Lena Fischer', 'g-net', { projectIds: ['p-cl-b'] }),
  P('sp-6', 'Jordan Blake', 'g-fam', {}),
  P('sp-7', 'Noor Haddad', 'g-fr', {}),
  P('sp-8', 'Theo Marsh', 'g-net', { projectIds: ['p-pod'] }));
const contactPlan = [['sp-1', 3, 'call'], ['sp-1', 17, 'in person'], ['sp-2', 9, 'message'], ['sp-3', 30, 'video'], ['sp-4', 6, 'email'], ['sp-5', 2, 'video'], ['sp-6', 25, 'call'], ['sp-7', 4, 'in person'], ['sp-8', 60, 'email'], ['sp-2', 1, 'in person']];
for (const [pid, ago, channel] of contactPlan) s.contacts.push({ id: id('sc'), personId: pid, date: add(TODAY, -ago), channel, notes: '' });

// ---- clients, podcast and website ----
s.clients.push(
  { id: 'cl-a', name: 'Juniper Bakery Co.', status: 'active', projectId: 'p-cl-a', budgetCents: 180000, personIds: [], notes: '', createdOn: add(TODAY, -320) },
  { id: 'cl-b', name: 'Orbit Bicycle Works', status: 'active', projectId: 'p-cl-b', budgetCents: 250000, personIds: ['sp-5'], notes: '', createdOn: add(TODAY, -210) },
  { id: 'cl-c', name: 'Willow Street Florist', status: 'past', personIds: [], notes: '', createdOn: add(TODAY, -400) });
s.renewals.push({ id: 'rn-dom', title: 'Domain: sidequesthours.example', kind: 'subscription', provider: 'Registrar', dueDate: add(TODAY, 44), cadence: 'annual', autoRenews: true, state: 'open', amount: 18, notes: '' });
s.sites.push(
  { id: 'st-studio', hostname: 'mapleandmain.example', kind: 'business', projectId: 'p-web', host: 'Static host', notes: '' },
  { id: 'st-pod', hostname: 'sidequesthours.example', kind: 'show', projectId: 'p-pod', showId: 'sh-1', host: 'Static host', domainRenewalId: 'rn-dom', notes: '' });
s.shows.push({ id: 'sh-1', name: 'Side Quest Hours', siteId: 'st-pod', projectId: 'p-pod', platforms: [{ id: 'pf-yt', name: 'Video channel' }, { id: 'pf-au', name: 'Audio feed' }], notes: '' });
const epTitles = ['Why side projects stall', 'Pricing your first retainer', 'Building in public, honestly', 'The 5 a.m. myth', 'Saying no to good work', 'Tools we quit this year', 'From hobby to invoice', 'Partnerships for tiny teams', 'Burnout and the weekly review', 'Notes apps, ranked', 'Our first sponsor', 'Hiring a freelancer', 'Year one numbers', 'Planning next year', 'Holiday mailbag'];
epTitles.forEach((title, i) => {
  const num = i + 1, rec = add(TODAY, -7 * (14 - i) - 3);
  const status = num <= 13 ? 'published' : num === 14 ? 'recorded' : 'booked';
  const ep = { id: 'ep-' + num, showId: 'sh-1', title, number: num, status, guestIds: num % 4 === 0 ? ['sp-8'] : [], pubs: [], notes: '' };
  if (status !== 'booked') ep.recordedOn = rec;
  if (status === 'published') ep.pubs = [{ format: 'video', platformId: 'pf-yt', date: add(rec, 4) }, { format: 'audio', platformId: 'pf-au', date: add(rec, 4) }];
  s.episodes.push(ep);
  if (status === 'published') {
    s.platformStats.push({ id: id('ps'), showId: 'sh-1', platformId: 'pf-yt', date: add(rec, 11), measure: 'views', value: Math.round(180 + num * 95 + rnd() * 120), episodeId: ep.id });
    s.platformStats.push({ id: id('ps'), showId: 'sh-1', platformId: 'pf-au', date: add(rec, 11), measure: 'downloads', value: Math.round(140 + num * 70 + rnd() * 90), episodeId: ep.id });
  }
});
for (let k = -5; k <= 0; k++) s.platformStats.push({ id: id('ps'), showId: 'sh-1', platformId: 'pf-yt', date: k === 0 ? TODAY : month(k) + '-28', measure: 'subscribers', value: 310 + (k + 5) * 85 });
for (let k = -5; k <= 0; k++) {
  s.siteTraffic.push({ id: id('tf'), siteId: 'st-studio', month: month(k), visits: 820 + (k + 5) * 140, visitors: 610 + (k + 5) * 100 });
  s.siteTraffic.push({ id: id('tf'), siteId: 'st-pod', month: month(k), visits: 450 + (k + 5) * 210, visitors: 330 + (k + 5) * 160 });
}

// ---- health: training, sleep, body, daily checks ----
s.cycle = { startDate: add(wk, -21), sprintDays: 7, sprintsPerCycle: 4, restDays: 3, alternateHeavyLight: true, firstWeek: 'heavy' };
const kinds = ['strength', 'kettlebell', 'cardio', 'mobility', 'bodyweight'];
for (let d = 84; d >= 0; d--) {
  const date = add(TODAY, -d), dow = new Date(date + 'T00:00:00Z').getUTCDay();
  if ([1, 2, 4, 6].includes(dow) && !(d % 17 === 5)) s.entries.push(E({ domain: 'health', type: 'workout', date, title: ['Push day', 'Kettlebell circuit', 'Zone 2 ride', 'Mobility flow', 'Pull day'][d % 5], kind: kinds[d % 5], minutes: 35 + (d % 4) * 10, effort: 5 + (d % 4) }));
  if (d <= 60) s.entries.push(E({ domain: 'health', type: 'sleep', date, title: 'Sleep', value: Math.round((6.9 + ((d * 7) % 11) / 10 - 0.4) * 10) / 10 }));
  if (d % 7 === 0) s.entries.push(E({ domain: 'health', type: 'weight', date, title: 'Weight', value: Math.round((186.4 - (84 - d) * 0.07) * 10) / 10 }));
  if (d % 28 === 0) s.entries.push(E({ domain: 'health', type: 'bodyfat', date, title: 'Body fat', value: Math.round((21.5 - (84 - d) * 0.025) * 10) / 10 }));
}
s.habits.push({ id: 'h-walk', name: '8k steps' }, { id: 'h-water', name: 'Water goal' }, { id: 'h-read', name: 'Read 20 minutes' }, { id: 'h-screens', name: 'No screens after 10' });
for (let d = 13; d >= 0; d--) for (const [i, h] of s.habits.entries()) if ((d + i * 3) % 5 !== 0) s.habitLog.push({ habitId: h.id, date: add(TODAY, -d) });

// ---- learning ----
s.learningItems.push(
  { id: 'li-1', title: 'Intro to machine learning', kind: 'course', provider: 'Online course', state: 'active', unitLabel: 'lesson', totalUnits: 24, doneUnits: 15, notes: '', createdAt: ts(add(TODAY, -70)) },
  { id: 'li-2', title: 'The Partnership Playbook', kind: 'book', provider: 'Library', state: 'active', unitLabel: 'chapter', totalUnits: 12, doneUnits: 8, notes: '', createdAt: ts(add(TODAY, -40)) },
  { id: 'li-3', title: 'Cloud practitioner certification', kind: 'certification', provider: 'Exam board', state: 'planned', unitLabel: 'module', totalUnits: 6, doneUnits: 0, notes: '', createdAt: ts(add(TODAY, -10)) },
  { id: 'li-4', title: 'Spanish, conversational', kind: 'skill', provider: 'Language app', state: 'active', unitLabel: 'unit', totalUnits: 40, doneUnits: 11, notes: '', createdAt: ts(add(TODAY, -120)) },
  { id: 'li-5', title: 'Storytelling for podcasters', kind: 'course', provider: 'Workshop', state: 'done', unitLabel: 'session', totalUnits: 4, doneUnits: 4, notes: '', createdAt: ts(add(TODAY, -150)) });
for (let d = 27; d >= 0; d--) if (d % 2 === 0 || d % 5 === 0) s.studySessions.push({ id: id('ss'), itemId: ['li-1', 'li-2', 'li-4'][d % 3], date: add(TODAY, -d), minutes: 25 + (d % 4) * 10, notes: '' });
s.takeaways.push({ id: 'tk-1', itemId: 'li-2', date: add(TODAY, -5), text: 'Pick partners by shared customers first, not by logo size.', createdAt: ts(add(TODAY, -5)) },
  { id: 'tk-2', itemId: 'li-1', date: add(TODAY, -2), text: 'Start with a simple baseline before trying a bigger model.', createdAt: ts(add(TODAY, -2)) });

// ---- activities ----
const acts = [['Trail hike at Ridgeback Park', 'outing', 'done', -16, 180, 0, 5, ['sp-2']], ['Pottery night', 'class', 'done', -9, 120, 4500, 4, ['sp-7']], ['Founders breakfast', 'networking', 'done', -6, 90, 1800, 4, []],
  ['Food bank shift', 'volunteering', 'done', -1, 150, 0, 5, ['sp-1']], ['Jazz in the square', 'event', 'skipped', -8, 0, 0, 0, []], ['Weekend in the mountains', 'travel', 'planned', 11, 0, 38000, 0, ['sp-6']],
  ['Board game night', 'hobby', 'planned', 4, 0, 0, 0, ['sp-2', 'sp-7']], ['Design meetup', 'networking', 'planned', 9, 0, 1500, 0, []], ['Climbing gym intro', 'class', 'done', -24, 90, 3200, 3, []]];
for (const [title, category, state, d, minutes, costCents, worthIt, withPeople] of acts) {
  const a = { id: id('ac'), title, category, state, date: add(TODAY, d), place: '', withPeople, notes: '', createdAt: ts(add(TODAY, Math.min(d, 0) - 5)) };
  if (minutes) a.minutes = minutes; if (costCents) a.costCents = costCents; if (worthIt) a.worthIt = worthIt;
  s.activities.push(a);
}

// ---- home and admin ----
s.properties.push({ id: 'pp-1', name: 'Apartment, 4B', kind: 'rental', archived: false });
s.vehicles.push({ id: 'v-1', name: 'Hatchback', year: 2021, odometer: 38420, odometerUnit: 'mi', archived: false });
s.maintenance.push(
  { id: 'mt-1', title: 'Replace HVAC filter', area: 'Heating', cadence: 'quarterly', state: 'open', nextDue: add(TODAY, -3), lastDone: add(TODAY, -95), cost: 2400, propertyId: 'pp-1', vendor: '', notes: '' },
  { id: 'mt-2', title: 'Test smoke detectors', area: 'Safety', cadence: 'semiannual', state: 'open', nextDue: add(TODAY, 9), propertyId: 'pp-1', vendor: '', notes: '' },
  { id: 'mt-3', title: 'Oil change', area: 'Engine', cadence: 'custom', everyDays: 180, state: 'open', nextDue: add(TODAY, 21), cost: 6900, vehicleId: 'v-1', vendor: 'Corner Garage', notes: '' },
  { id: 'mt-4', title: 'Winter tires on', area: 'Tires', cadence: 'annual', state: 'done', lastDone: add(TODAY, -12), cost: 8000, vehicleId: 'v-1', vendor: 'Corner Garage', notes: '' });
s.renewals.push(
  { id: 'rn-1', title: 'Renters insurance', kind: 'insurance', provider: 'Insurer', dueDate: add(TODAY, 18), cadence: 'annual', autoRenews: false, state: 'open', amount: 186, notes: '' },
  { id: 'rn-2', title: 'Car registration', kind: 'registration', provider: 'State DMV', dueDate: add(TODAY, 52), cadence: 'annual', autoRenews: false, state: 'open', amount: 92, notes: '' },
  { id: 'rn-3', title: 'Gym membership', kind: 'membership', provider: 'Neighborhood gym', dueDate: add(TODAY, 7), cadence: 'monthly', autoRenews: true, state: 'open', amount: 49, notes: '' },
  { id: 'rn-4', title: 'Passport', kind: 'license', provider: 'Passport office', dueDate: add(TODAY, 420), cadence: 'once', autoRenews: false, state: 'open', notes: '' });
s.documents.push(
  { id: 'doc-1', title: 'Lease agreement', kind: 'legal', whereKept: 'Blue folder, desk drawer', expires: add(TODAY, 160), notes: '' },
  { id: 'doc-2', title: 'Car title', kind: 'registration', whereKept: 'Fire safe', notes: '' },
  { id: 'doc-3', title: 'Laptop warranty', kind: 'warranty', whereKept: 'Email archive', expires: add(TODAY, 75), notes: '' });

// ---- goals ----
const G = (o) => Object.assign({ id: id('g'), horizon: 'quarterly', domain: 'goals', direction: 'up', state: 'active', notes: '', startDate: add(TODAY, -54), dueDate: add(TODAY, 37), createdAt: ts(add(TODAY, -54)) }, o);
s.goals.push(
  G({ title: 'Grow studio revenue to $5k a month', domain: 'work', metric: 'revenueMonth', startValue: 2800, targetValue: 5000 }),
  G({ title: 'Train four times a week', domain: 'health', metric: 'workoutsPerWeek', startValue: 2, targetValue: 4 }),
  G({ title: 'Reach 180 lb', domain: 'health', metric: 'weight', direction: 'down', startValue: 184, targetValue: 180 }),
  G({ title: 'Emergency fund: $35k saved', domain: 'goals', metric: 'manual', startValue: 22000, targetValue: 35000, manualValue: 31150 }),
  G({ title: 'Study three hours a week', domain: 'learning', metric: 'studyMinutes', startValue: 60, targetValue: 180 }),
  G({ title: 'Land a partnerships role in AI or XR', horizon: 'annual', domain: 'work', metric: 'manual', startValue: 0, targetValue: 1, manualValue: 0, dueDate: add(TODAY, 120) }));

// ---- studio invoices ----
s.invoices.push(
  { id: 'iv-1', number: 'MM-2026-031', projectId: 'p-cl-b', clientId: 'cl-b', issueDate: add(TODAY, -12), dueDate: add(TODAY, -4), lines: [{ description: 'Dealer kit design and layout', qty: 1, unitCents: 240000 }], status: 'sent', notes: '' },
  { id: 'iv-2', number: 'MM-2026-032', projectId: 'p-cl-a', clientId: 'cl-a', issueDate: add(TODAY, -2), dueDate: add(TODAY, 12), lines: [{ description: 'Holiday campaign landing page', qty: 1, unitCents: 150000 }, { description: 'Social graphics, set of 6', qty: 6, unitCents: 5000 }], status: 'sent', notes: '' });

// ---- home screen: hide the tax modules (no tax profile in the demo) ----
const hide = new Set(['tax-setaside', 'tax-next', 'payees-near', 'budget-pinned']);
// Domain tiles first so the overview is what a visitor sees, then the money modules, then priorities and at a glance.
const order = ['tile-money', 'tile-assets', 'tile-work', 'tile-health', 'tile-goals', 'tile-activities', 'tile-social', 'tile-learning', 'tile-home', 'tile-admin', 'tile-wellbeing',
  'rev-month', 'rev-expected', 'inv-open', 'rev-net-line', 'priorities', 'glance'];
const byId = new Map(L.layout.MODULES.map((m) => [m.id, m]));
const rest = L.layout.MODULES.filter((m) => !order.includes(m.id)).map((m) => m.id);
for (const k of ['narrow', 'wide']) s.settings.layouts[k] = order.concat(rest).map((mid) => ({ id: mid, size: byId.get(mid).size, hidden: hide.has(mid) }));

// ---- four finished weekly reviews, the latest one last weekend ----
const prio = [['Send the Orbit dealer kit', 'Two workouts before Thursday', 'Call Avery about the trip'], ['Finish the partner tier plan draft', 'Record episode 14', 'Book the mountain cabin'],
  ['Follow up with Northpine XR', 'Ship the Juniper landing page', 'Three study sessions'], ['Send December invoices', 'Prep the Lumenfold panel', 'Plan the holiday mailbag episode']];
for (let w = 4; w >= 1; w--) {
  const weekOf = add(wk, -7 * w), done = add(weekOf, 6);
  s.memory.reviews.push({ id: id('rv'), weekOf, digest: L.metrics.weeklyDigest(s, weekOf), priorities: prio[4 - w], completedAt: ts(done) });
}
s.memory.lastReviewAt = add(wk, -1);

const clean = L.store.validateState(JSON.parse(JSON.stringify(s)));
const text = await L.vault.exportBackup(DEMO_PASS, clean);
mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
writeFileSync(out, text);
console.log('Demo backup written: ' + out + ' (' + clean.entries.length + ' entries, today ' + TODAY + '). Passphrase: ' + DEMO_PASS);
