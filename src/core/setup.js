(function () {
  'use strict';
  // v1.4.0 B9: the setup checklist. Every item is worked out from the vault's real state; nothing ticks from a tap alone.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const DEFAULT_TARGETS = Object.freeze({ workoutsPerWeek: 4, contactDays: 30, savingsRate: 0.2 });
  const n = (a) => (Array.isArray(a) ? a.length : 0);
  // `where` is a navigation key (see nav.js); the checklist only links to the screen where the item gets done.
  function items(s, year) {
    const set = (s && s.settings) || {}, tg = set.targets || {}, ops = (s && s.ops) || {};
    const targetsDone = !!(set.setup && set.setup.targetsSaved) || (typeof set.currency === 'string' && set.currency !== 'USD') ||
      tg.workoutsPerWeek !== DEFAULT_TARGETS.workoutsPerWeek || tg.contactDays !== DEFAULT_TARGETS.contactDays || tg.savingsRate !== DEFAULT_TARGETS.savingsRate;
    return [
      { id: 'targets', label: 'Set your currency and targets', done: targetsDone, where: 'settings' },
      { id: 'accounts', label: 'Add your accounts', done: n(s && s.accounts) > 0, where: 'v:assets' },
      { id: 'lines', label: 'Add your lines of work', done: n(s && s.projects) > 0, where: 'v:work' },
      { id: 'tax', label: 'Set the ' + (year || new Date().getFullYear()) + ' tax profile', done: !!(s && s.taxYears && typeof s.taxYears === 'object' && Object.keys(s.taxYears).length > 0), where: 'business' },
      { id: 'backup', label: 'Connect Drive or export a first backup', done: !!(ops.lastBackupAt || ops.lastSyncAt), where: 'settings' },
      { id: 'storage', label: 'Confirm storage is kept by the browser', done: !!(ops.persist && ops.persist.result === 'granted'), where: 'settings' }
    ];
  }
  const shown = (s) => !!(s && s.settings && s.settings.setup && s.settings.setup.dismissed === false);
  const allDone = (s, year) => items(s, year).every((x) => x.done);
  L.setup = { DEFAULT_TARGETS, items, shown, allDone };
})();
