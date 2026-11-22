(function () {
  'use strict';
  // v1.8.0: the in-app "Getting started" view. It lists the first-time steps in order and opens the matching screen.
  // It points at the docs by name (docs/FIRST-RUN.md and so on) and does not repeat them. No network, no stored state.
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
      h('p', { class: 'mut', text: 'The steps for a new vault, in order. Each button opens the screen where the step is done.' }), list);
  }
  function open(c) { c.go('print', { kind: 'guide' }); }

  L.guideUI = { view: view, open: open, steps: steps };
})();
