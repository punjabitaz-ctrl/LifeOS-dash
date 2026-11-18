(function () {
  'use strict';
  // v1.4.0 B5: in-app history. An entry holds one string: a view name ('v:money') or the marker 'dialog' or 'lock'. Never data, ids or names.
  // The browser's back button then moves between views, closes the open dialog, and never reaches a view while the app is locked.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const DOMAINS = ['money', 'assets', 'work', 'health', 'goals', 'home', 'admin', 'learning', 'activities', 'social', 'wellbeing'];
  const NAMES = ['dashboard', 'review', 'memory', 'settings', 'private', 'archive', 'business'];
  // The phone bottom bar, and every other area (the More sheet). Each entry is { key, label }; a key is a view key.
  const BAR = Object.freeze([['dashboard', 'Home'], ['v:money', 'Money'], ['v:work', 'Work'], ['v:health', 'Health']].map(([key, label]) => Object.freeze({ key: key === 'dashboard' ? 'dashboard' : key, label })));
  const MORE = Object.freeze([['v:assets', 'Assets'], ['v:command', 'Command center'], ['business', 'Business'], ['v:goals', 'Goals'], ['v:home', 'Home and property'], ['v:admin', 'Admin'],
    ['v:learning', 'Learning'], ['v:activities', 'Activities'], ['v:social', 'Social'], ['private', 'Private vault'], ['v:wellbeing', 'Wellbeing'], ['review', 'Review'], ['memory', 'Memory'], ['settings', 'Settings']]
    .map(([key, label]) => Object.freeze({ key, label })));
  const KEYS = new Set(['dashboard', 'v:command'].concat(NAMES, DOMAINS.map((d) => 'v:' + d)));
  // A view object ({ name, domain, revenue }) to its key, and back. Anything unknown maps to the dashboard.
  function keyOf(view) {
    if (!view || typeof view !== 'object') return 'dashboard';
    if (view.name === 'domain') return view.domain === 'work' && view.revenue ? 'v:command' : (DOMAINS.includes(view.domain) ? 'v:' + view.domain : 'dashboard');
    if (view.name === 'print') return 'business';
    return NAMES.includes(view.name) ? view.name : 'dashboard';
  }
  function viewOf(key) {
    if (key === 'v:command') return { name: 'domain', domain: 'work', revenue: true };
    if (typeof key === 'string' && key.startsWith('v:') && DOMAINS.includes(key.slice(2))) return { name: 'domain', domain: key.slice(2) };
    return NAMES.includes(key) ? { name: key } : { name: 'dashboard' };
  }
  const entryOk = (x) => x === 'lock' || x === 'dialog' || KEYS.has(x);
  const all = () => BAR.concat(MORE).map((x) => x.key);

  // env: { history, getView(), setView(view), isUnlocked(), dialogOpen(), closeDialog(), onShow() }. Nothing here reads or stores user data.
  function create(env) {
    const hist = env.history;
    let depth = 0, dlgEntry = false, ignore = 0;
    const top = () => hist.state;
    function base(key) { try { hist.replaceState(key, ''); } catch (e) { /* history may be unavailable */ } depth = 0; dlgEntry = false; }
    function start() { base(keyOf(env.getView())); }            // after unlock: the current entry becomes the dashboard base
    function reset() { base('lock'); }                          // at load: whatever an earlier session left, this entry is the lock screen
    function push(view) {
      const k = keyOf(view);
      // A view change made from inside a dialog (the More sheet, an action that moves on) takes over the dialog's entry.
      if (top() === 'dialog') { dlgEntry = false; try { hist.replaceState(k, ''); } catch (e) { /* ignore */ } return; }
      dlgEntry = false;
      if (top() === k) return;
      try { hist.pushState(k, ''); depth++; } catch (e) { /* ignore */ }
    }
    function dialogOpened() {
      if (dlgEntry && top() === 'dialog') return;
      try { hist.pushState('dialog', ''); depth++; dlgEntry = true; } catch (e) { /* ignore */ }
    }
    // A dialog closed by the app (Cancel, OK, a view change): remove its entry unless another dialog opens straight away.
    function dialogClosed(defer) {
      (defer || ((f) => setTimeout(f, 0)))(() => {
        if (env.dialogOpen() || !dlgEntry || top() !== 'dialog') return;
        dlgEntry = false; depth = Math.max(0, depth - 1); ignore++;
        try { hist.back(); } catch (e) { ignore = Math.max(0, ignore - 1); }
      });
    }
    // Locking: the app goes back to its first entry and marks it as the lock screen. Entries ahead of it hold only names and are ignored while locked.
    function lock() {
      const n = depth;
      depth = 0; dlgEntry = false;
      if (n > 0) { ignore++; try { hist.go(-n); } catch (e) { ignore = Math.max(0, ignore - 1); } }
      try { hist.replaceState('lock', ''); } catch (e) { /* ignore */ }
    }
    function onPop(state) {
      if (ignore > 0) { ignore--; if (!env.isUnlocked()) { try { hist.replaceState('lock', ''); } catch (e) { /* ignore */ } } return 'ignored'; }
      if (!env.isUnlocked()) { try { hist.replaceState('lock', ''); } catch (e) { /* ignore */ } return 'locked'; }
      if (state === 'dialog') {
        // back onto a dialog entry: a dialog that is open belongs to this entry; none open means a stale entry, so keep going back.
        if (env.dialogOpen()) return 'kept';
        dlgEntry = false; depth = Math.max(0, depth - 1); try { hist.back(); } catch (e) { /* ignore */ }
        return 'skipped';
      }
      if (env.dialogOpen()) { dlgEntry = false; depth = Math.max(0, depth - 1); env.closeDialog(true); return 'dialog-closed'; }
      depth = Math.max(0, depth - 1);
      if (!entryOk(state) || state === 'lock') return 'unknown';
      env.setView(viewOf(state));
      return 'view';
    }
    return { start, reset, push, dialogOpened, dialogClosed, lock, onPop, _depth: () => depth };
  }
  L.nav = { DOMAINS, BAR, MORE, KEYS, keyOf, viewOf, entryOk, all, create };
})();
