(function () {
  'use strict';
  // v1.8.0: the in-app "Getting started" view. It lists the first-time steps in order and opens the matching screen.
  // It points at the docs by name (docs/FIRST-RUN.md and so on) and does not repeat them. No network.
  // The tour below (first-run guide) keeps one flag in the vault: settings.setup.tour, true once it has started.
  var L = (globalThis.LifeOS = globalThis.LifeOS || {});

  function steps() {
    return [
      { id: 'passphrase', title: 'Choose a passphrase', text: 'The passphrase locks the vault on this device. It is set when the vault is created and can be changed in Settings. It has 12 or more characters.', doc: 'docs/FIRST-RUN.md', go: ['settings', 'Open Settings'] },
      { id: 'recovery', title: 'Turn on the recovery key and fill in the recovery sheet', text: 'A recovery key opens the vault if the passphrase is forgotten. It is shown once. The recovery sheet prints without the key and has boxes to write it by hand.', doc: 'docs/RECOVERY.md', go: ['settings', 'Open Settings'], sheet: true },
      { id: 'backup', title: 'Turn on persistent storage and make the first backup', text: 'Persistent storage asks the browser to keep the vault. A backup is an encrypted file made from Settings, under its own passphrase.', doc: 'docs/FIRST-RUN.md', go: ['settings', 'Open Settings'] },
      { id: 'install', title: 'Install on phone and PC', text: 'The app installs from the browser menu on each device. Each device keeps its own vault until Drive sync joins them.', doc: 'docs/FIRST-RUN.md' },
      { id: 'sync', title: 'Set up Drive sync', text: 'Drive sync stores the sealed vault file in your Google Drive. It is set up in Settings with your own Google client ID.', doc: 'docs/SYNC-SETUP.md', go: ['settings', 'Open Settings'] },
      { id: 'private', title: 'Set up the private vault', text: 'The private vault is a second lock with its own passphrase and its own recovery key. While it is closed, its items are missing everywhere.', doc: 'docs/RECOVERY.md', go: ['private', 'Open the private vault'] },
      { id: 'ai', title: 'Set up your own AI, or use none', text: 'AI is optional. Settings holds the provider choice. With none chosen, nothing leaves the device for AI.', doc: 'docs/AI-SETUP.md', go: ['settings', 'Open Settings'] },
      { id: 'records', title: 'Enter the first records in each area', text: 'Enter records by hand first. Where an area has a CSV import, it is on that area\'s screen.', go: ['v:money', 'Open Money'] },
      { id: 'review', title: 'Do the weekly review', text: 'The weekly review walks through the week and saves a short note.', go: ['review', 'Open the weekly review'] }
    ];
  }

  function view(c) {
    var h = c.h;
    function open(key) { var v = L.nav.viewOf(key); c.go(v.name, v); }
    var list = h('ol', { class: 'guide-steps', id: 'guide-steps' }, steps().map(function (s, i) {
      var row = [h('h2', { text: (i + 1) + '. ' + s.title }), h('p', { text: s.text }), s.doc ? h('p', { class: 'mut small', text: 'More detail: ' + s.doc }) : null];
      var btns = [];
      if (s.go) btns.push(c.btn(s.go[1], function () { open(s.go[0]); }, 'sm', { id: 'guide-open-' + s.id }));
      if (s.sheet) btns.push(c.btn('Recovery sheet', function () { c.go('print', { kind: 'recovery', from: 'guide' }); }, 'sm', { id: 'guide-sheet' }));
      if (btns.length) row.push(h('div', { class: 'row' }, btns));
      return h('li', { class: 'card', 'data-step': s.id }, row);
    }));
    return h('div', { id: 'guide-view' }, c.btn('Back', function () { c.go('dashboard'); }, 'sm back', { id: 'guide-back' }),
      h('h1', { text: 'Getting started' }),
      h('div', { class: 'card', id: 'guide-tour-card' }, h('h2', { text: 'Tour of the app' }),
        h('p', { class: 'mut small', text: 'A short walk through the real screens: where each area is and what it is for.' }),
        c.btn('Take the tour', function () { start(lastCtx); }, 'sm pri', { id: 'guide-tour' })),
      h('p', { class: 'mut', text: 'The steps for a new vault, in order. Each button opens the screen where the step is done.' }), list);
  }
  function open(c) { c.go('print', { kind: 'guide' }); }

  // ---------- the first-run tour (getting started guide) ----------
  // A card fixed above the bottom bar walks through the real screens one step at a time: each step opens its screen and outlines
  // the part it talks about. It starts by itself once per vault (settings.setup.tour, set when it starts), and Settings and the
  // Getting started page start it again. Skip, Escape and locking end it. It never reads or shows a record: copy only.
  // Each step: name, the view key it opens (nav.js), the CSS selectors it outlines (first match wins), title and text.
  var TOUR = Object.freeze([
    { name: 'welcome', key: 'dashboard', at: [], title: 'Welcome to LifeOS',
      text: 'A short tour of where things are. Next opens each screen in turn. Skip any time; to see it again, open Settings and tap Rerun getting started guide.' },
    { name: 'overview', key: 'dashboard', at: ['.ov-head', 'main h1'], title: 'Overview',
      text: 'Your home screen. It opens each time you unlock and puts your numbers, cards and shortcuts in one place.' },
    { name: 'kpis', key: 'dashboard', at: ['.mod[data-mod="kpis"]', '#ov-pick'], title: 'Key numbers',
      text: 'The strip of numbers near the top of the Overview. You pick which ones show.' },
    { name: 'shortcuts', key: 'dashboard', at: ['.mod[data-mod="shortcuts"]', '#ov-pick'], title: 'Shortcuts',
      text: 'One tap to the areas you use most. You pick these too.' },
    { name: 'choose', key: 'dashboard', at: ['#ov-pick'], title: 'Choose what shows',
      text: 'Picks the key numbers, cards and shortcuts on the Overview. Arrange, next to it, moves or hides cards. Quick add logs an entry from here.' },
    { name: 'nav', key: 'dashboard', at: ['#nav-more', 'nav.nav'], title: 'Getting around',
      text: 'On a wide screen, the tabs at the top open the main areas. On a phone, the bar at the bottom opens Overview, Money, Work and Health. More lists every other area and has search.' },
    { name: 'money', key: 'v:money', at: ['main h1'], title: 'Money',
      text: 'Your entries, spending by category and cash flow. Quick add here logs income or spending.' },
    { name: 'assets', key: 'v:assets', at: ['main h1'], title: 'Assets',
      text: 'Your accounts and balances, net worth over 12 months and how it is split.' },
    { name: 'countries', key: 'countries', at: ['#cn-assets', 'main h1'], title: 'By country',
      text: 'Assets and taxes split by country, for example US and Spain, by tax year. Open it from Assets or from More.' },
    { name: 'health', key: 'v:health', at: ['#hl-eat', 'main h1'], title: 'Health and the eating log',
      text: 'Body numbers, workouts, sleep and daily checks. The Eating card logs a saved meal with one tap and adds up protein for the day.' },
    { name: 'learning', key: 'v:learning', at: ['#ln-active', 'main h1'], title: 'Learning',
      text: 'Courses, certifications, degrees, skills and languages, each with a next step, plus what is due in the next 30 days.' },
    { name: 'admin', key: 'v:admin', at: ['#ad-tax', '#ad-timeline', 'main h1'], title: 'Admin and taxes',
      text: 'Renewals, subscriptions, documents and the tax checklist. Tax estimates and the yearly tax profile are under Business, on the Tax tab.' },
    { name: 'review', key: 'review', at: ['main h1'], title: 'Weekly review',
      text: 'Once a week it walks through your numbers and saves a short note. The Overview tells you when one is due.' },
    { name: 'settings', key: 'settings', at: ['main h1'], title: 'Settings',
      text: 'Passphrase, recovery key, backups, currency and targets. The Private button at the top opens your private vault.' },
    { name: 'sync', key: 'settings', at: ['#sync-card', '#drive-card'], title: 'Drive sync',
      text: 'Keeps a sealed copy of the vault in your own Google Drive so your phone and computer stay in step. Set it up on this card.' },
    { name: 'rerun', key: 'settings', at: ['#guide-card'], title: 'That is the tour',
      text: 'Rerun it any time from Getting started here in Settings. Open setup steps lists the first-time setup in order.' }
  ]);
  var tour = { on: false, i: 0, tried: false, shown: -1 };
  var lastCtx = null;
  var seen = function (s) { return !!(s && s.settings && s.settings.setup && s.settings.setup.tour === true); };
  function clearMarks() { Array.prototype.forEach.call(document.querySelectorAll('.tour-on'), function (n) { n.classList.remove('tour-on'); }); }
  function removeCard() {
    var old = document.getElementById('tour');
    if (old) old.remove();
    clearMarks();
    if (document.body && document.body.classList) document.body.classList.remove('touring');
  }
  function target(st) {
    for (var k = 0; k < st.at.length; k++) { var el = document.querySelector(st.at[k]); if (el) return el; }
    return null;
  }
  // Remembered once it starts, so it never starts by itself twice. A failed save only means it may start again next time.
  function markSeen(c) {
    try { var p = c.commit(function (x) { if (x.settings && x.settings.setup) x.settings.setup.tour = true; }); if (p && p.catch) p.catch(function () {}); } catch (e) { /* optional */ }
  }
  // Opens the step's screen (which redraws and paints the card), or paints it on the screen already showing.
  function goStep(c) {
    var st = TOUR[tour.i], v = c.view();
    if (v.name === 'print' || L.nav.keyOf(v) !== st.key) { var nv = L.nav.viewOf(st.key); c.go(nv.name, nv); return; }
    removeCard(); paint(c);
  }
  function start(c) {
    c = c || lastCtx;
    if (!c || !L.store.isUnlocked()) return false;
    tour.on = true; tour.i = 0; tour.tried = true; tour.shown = -1;
    markSeen(c);
    goStep(c);
    return true;
  }
  function stop() { tour.on = false; removeCard(); }
  function end(c, toOverview) {
    stop();
    if (toOverview && c.view().name !== 'dashboard') { c.go('dashboard'); return; }
    var t = document.querySelector('main h1');
    if (t) { t.setAttribute('tabindex', '-1'); t.focus(); }
  }
  function step(c, d) {
    var n = tour.i + d;
    if (n < 0) return;
    if (n >= TOUR.length) { end(c, true); return; }
    tour.i = n; goStep(c);
  }
  function paint(c) {
    var h = c.h, st = TOUR[tour.i], last = tour.i === TOUR.length - 1;
    var card = h('div', { id: 'tour', class: 'tour', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'tour-title', 'aria-describedby': 'tour-text', 'data-tour': st.name },
      h('p', { class: 'mut small', id: 'tour-count', text: 'Getting started, ' + (tour.i + 1) + ' of ' + TOUR.length }),
      h('h2', { id: 'tour-title', text: st.title }),
      h('p', { id: 'tour-text', text: st.text }),
      h('div', { class: 'row' },
        c.btn('Back', function () { step(c, -1); }, 'sm', { id: 'tour-back', disabled: tour.i === 0 ? true : null }),
        c.btn(last ? 'Finish' : 'Next', function () { step(c, 1); }, 'sm pri', { id: 'tour-next' }),
        last ? null : c.btn('Skip tour', function () { end(c, false); }, 'sm', { id: 'tour-skip' })));
    card.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); end(c, false); } });
    document.body.appendChild(card);
    if (document.body.classList) document.body.classList.add('touring');
    var el = target(st);
    if (el) el.classList.add('tour-on');
    // Scroll and focus only when the step changes: a save that redraws the screen mid-step leaves the page and focus where they are.
    if (tour.shown === tour.i) return;
    tour.shown = tour.i;
    // After show() has scrolled to the top: bring the outlined part into view.
    setTimeout(function () { if (el && el.isConnected && el.scrollIntoView) el.scrollIntoView({ block: 'center' }); }, 0);
    var nb = document.getElementById('tour-next');
    if (nb) nb.focus();
  }
  // Called at the end of every unlocked render. c: { h, btn, go, commit, view(), state(), dialogOpen() }.
  function afterRender(c) {
    lastCtx = c;
    removeCard();
    // First run: once per vault, the first time the Overview shows with no dialog open.
    if (!tour.on && !tour.tried && c.view().name === 'dashboard' && !c.dialogOpen()) {
      tour.tried = true;
      if (!seen(c.state())) { tour.on = true; tour.i = 0; tour.shown = -1; markSeen(c); }
    }
    if (tour.on) paint(c);
  }
  // Locking ends the tour and forgets the page's first-run check, so the next unlock checks the vault again.
  function onLock() { stop(); tour.tried = false; lastCtx = null; }

  L.guideUI = { view: view, open: open, steps: steps, TOUR: TOUR, start: start, stop: stop, afterRender: afterRender, onLock: onLock, seen: seen, active: function () { return tour.on ? TOUR[tour.i].name : null; } };
})();
