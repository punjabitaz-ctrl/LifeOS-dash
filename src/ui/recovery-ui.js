(function () {
  'use strict';
  // v1.8.0: passphrase recovery screens. Settings card for the main vault, a card for the private vault, the "Use recovery key" paths on the lock
  // screen and the private unlock, the shown-once key dialog (retype to confirm) and the printable recovery sheet. app.js passes a context:
  // { h, field, btn, openDialog, closeDialog, commit, setNotice, render, go, friendly, passField, act, enter, main, priv, store }.
  // main and priv are { left(), bad(), ok() }: the same wrong-attempt delay counters the unlock forms use, so a wrong key counts like a wrong passphrase.
  // A recovery key is shown once, never stored, never put on the clipboard by this code, and only in the sheet when the owner chooses it.
  var L = globalThis.LifeOS;
  var KEEP = 'Backup files, Drive copies and archive files made earlier still open with the key or passphrase that was in force when they were made. Export a fresh backup and delete old ones if a key was exposed.';
  var sheetKeys = { main: '', priv: '' };
  var lk = { step: 'key', open: null };
  var pk = { step: 'key', open: null };

  function wrong(e) { var m = e && e.message; return m === 'BAD_PASSPHRASE_OR_DATA' || m === 'BAD_PRIVATE_PASSPHRASE' || m === 'BAD_RECOVERY_KEY'; }
  // One attempt with a secret: refused during the wait, counted when wrong, reset when right.
  function attempt(f, run) {
    var left = f.left();
    if (left > 0) return Promise.reject(new Error('Wrong key or passphrase. Wait ' + left + ' s before trying again.'));
    return run().then(function (r) { f.ok(); return r; }, function (e) { if (wrong(e)) f.bad(); throw e; });
  }
  function dropSheet() { sheetKeys = { main: '', priv: '' }; }
  // SEC-129: leaving a recovery path also empties what the opened handle holds.
  function clear() { dropSheet(); if (lk.open) lk.open.cancel(); if (pk.open) pk.open.cancel(); lk = { step: 'key', open: null }; pk = { step: 'key', open: null }; }

  // ---- the key, shown once ----
  // handle: { key, finish(typed) }. After the owner retypes the key (all of it, or its last two groups) finish runs and onDone follows.
  // opts: { onDone(), noAfter: true skips the sheet offer (the key is not live yet) }.
  function showKey(c, handle, scope, title, opts) {
    opts = opts || {};
    var h = c.h, typed = c.passField('rk-key-retype');
    c.openDialog({
      title: title, yes: 'I have written it down',
      body: [
        h('p', { class: 'warn small', id: 'rk-once', text: 'This key is shown once. LifeOS does not store it, so it cannot be shown again. Write it down by hand and keep the paper offline.' }),
        h('p', { class: 'recovery-key', id: 'rk-shown', text: handle.key }),
        h('p', { class: 'mut small', text: 'It opens only the ' + (scope === 'priv' ? 'private' : 'main') + ' vault. The recovery key is not saved on this device, in Drive, in a backup or anywhere LifeOS can read it.' }),
        c.field('Type the key again to confirm (all of it, or its last two groups)', typed),
        h('p', { class: 'mut small', text: KEEP })],
      onYes: function () {
        return handle.finish(typed.value).then(function () {
          typed.value = '';
          sheetKeys[scope] = '';
          if (!opts.noAfter) afterOn(c, handle.key, scope);
          handle.key = '';
          if (opts.onDone) opts.onDone();
        });
      }
    });
  }
  // After the key is on: a dialog that offers the printable sheet. The key is on the sheet only when this box is ticked.
  function afterOn(c, key, scope) {
    var h = c.h, inc = h('input', { type: 'checkbox', id: 'rk-include' });
    setTimeout(function () {
      c.openDialog({
        title: 'Recovery key is on', yes: 'Open the sheet',
        body: [h('p', { class: 'mut', text: 'The recovery sheet explains what each key opens and how to keep it. It prints without the key and has boxes to write it by hand.' }),
          h('label', { class: 'row small' }, inc, h('span', { text: 'Include this key on the printed sheet' })),
          h('p', { class: 'warn small', text: 'Printers and print queues may keep a copy of what they print. Leave this unticked to write the key by hand.' })],
        onYes: function () { sheetKeys[scope] = inc.checked ? key : ''; c.go('print', { kind: 'recovery', from: 'settings' }); }
      });
    }, 0);
    c.setNotice('ok', 'Recovery key is on.');
  }

  // ---- Settings: main vault ----
  function mainCard(c) {
    var h = c.h, on = L.store.hasRecovery(), pass = c.passField('rk-main-pass');
    function begin() {
      return c.act(function () {
        return attempt(c.main, function () { return L.store.beginRecovery(pass.value); }).then(function (handle) {
          pass.value = '';
          showKey(c, handle, 'main', on ? 'Replace the recovery key' : 'Your recovery key', { onDone: function () { c.render(); } });
        });
      });
    }
    function off() {
      c.openDialog({
        title: 'Turn off the recovery key?', yes: 'Turn it off', danger: true,
        body: [h('p', { class: 'mut', text: 'The recovery wrap is removed and the data key is replaced. The old key stops opening this vault. ' + KEEP })],
        onYes: function () {
          return attempt(c.main, function () { return L.store.turnOffRecovery(pass.value); }).then(function () { pass.value = ''; return c.commit(null, 'recovery key off'); }).then(function () { c.setNotice('ok', 'Recovery key is off.'); c.render(); });
        }
      });
    }
    return h('div', { class: 'card', id: 'rk-main-card' }, h('h2', { text: 'Recovery key (main vault)' }),
      h('p', { class: 'small', id: 'rk-main-status', text: on ? 'On. A recovery key can open the main vault if the passphrase is forgotten.' : 'Off. If you forget the passphrase, the data cannot be recovered.' }),
      h('p', { class: 'mut small', text: 'A recovery key is 256 random bits you write down. It opens only the main vault. Turning it on, replacing it or turning it off asks for your passphrase and replaces the data key. ' + KEEP }),
      c.field('Passphrase', pass),
      h('div', { class: 'row' }, c.btn(on ? 'Replace recovery key' : 'Turn on recovery key', begin, 'sm', { id: 'rk-main-on' }),
        on ? c.btn('Turn off recovery key', off, 'sm', { id: 'rk-main-off' }) : null,
        c.btn('Recovery sheet', function () { dropSheet(); c.go('print', { kind: 'recovery', from: 'settings' }); }, 'sm', { id: 'rk-sheet' })));
  }

  // ---- private vault card ----
  function privCard(c, s) {
    var h = c.h, on = L.priv.hasRecovery(s), pass = c.passField('rk-priv-pass');
    function begin() {
      return c.act(function () {
        return attempt(c.priv, function () { return L.priv.beginRecovery(pass.value); }).then(function (handle) {
          pass.value = '';
          showKey(c, handle, 'priv', on ? 'Replace the private recovery key' : 'Your private recovery key', { onDone: function () { c.render(); } });
        });
      });
    }
    function off() {
      c.openDialog({
        title: 'Turn off the private recovery key?', yes: 'Turn it off', danger: true,
        body: [h('p', { class: 'mut', text: 'The recovery wrap is removed and the private data key is replaced. The vault closes. ' + KEEP })],
        onYes: function () {
          return attempt(c.priv, function () { return L.priv.turnOffRecovery(pass.value); }).then(function () { pass.value = ''; c.setNotice('ok', 'Private recovery key is off. The vault is closed.'); c.render(); });
        }
      });
    }
    return h('div', { class: 'card', id: 'rk-priv-card' }, h('h2', { text: 'Recovery key (private vault)' }),
      h('p', { class: 'small', id: 'rk-priv-status', text: on ? 'On. A separate recovery key can open the private vault if its passphrase is forgotten.' : 'Off. If you forget the private passphrase, the private items cannot be recovered.' }),
      h('p', { class: 'mut small', text: 'This key is separate from the main one: it opens only the private vault, and the main key does not open it. ' + KEEP }),
      c.field('Private passphrase', pass),
      h('div', { class: 'row' }, c.btn(on ? 'Replace private recovery key' : 'Turn on private recovery key', begin, 'sm', { id: 'rk-priv-on' }),
        on ? c.btn('Turn off private recovery key', off, 'sm', { id: 'rk-priv-off' }) : null));
  }

  // ---- passphrase change: what to do with a key that is on ----
  // Returns { nodes, opts() }: opts() resolves to the options for changePassphrase (the typed key to keep, or a new key already shown and retyped).
  function changeFields(c, scope, on) {
    var h = c.h;
    if (!on) return { on: false, nodes: [], opts: function () { return Promise.resolve(null); } };
    var keep = c.passField('rk-keep-key'), fresh = h('input', { type: 'checkbox', id: 'rk-new-key' });
    return {
      on: true,
      nodes: [h('p', { class: 'small', text: 'A recovery key is on. Type the current key to keep it, or tick the box to get a new one. The data key is replaced either way.' }),
        c.field('Current recovery key (to keep it)', keep),
        h('label', { class: 'row small' }, fresh, h('span', { text: 'Make a new recovery key instead' }))],
      opts: function () {
        if (!fresh.checked) { var k = keep.value; keep.value = ''; return Promise.resolve({ keepRecovery: k }); }
        return L.vault.newRecoveryKey().then(function (text) {
          return new Promise(function (res, rej) {
            var chk = null;
            var handle = { key: text, finish: function (typed) { if (!L.vault.retypeMatches(text, typed)) { var e = new Error('That is not the recovery key shown. Check it against the key on screen and try again.'); e.code = 'RECOVERY_RETYPE'; return Promise.reject(e); } clearInterval(chk); res({ newRecoveryKey: text }); return Promise.resolve(); } };
            showKey(c, handle, scope, 'Your new recovery key', { noAfter: true });
            // closing the dialog without confirming cancels the change
            chk = setInterval(function () { if (!document.querySelector('.dialog')) { clearInterval(chk); rej(new Error('The change was cancelled. Nothing was changed.')); } }, 300);
          });
        });
      }
    };
  }

  // ---- lock screen: Use recovery key (main) ----
  function lockLink(c) {
    return c.btn('Use recovery key', function () { lk = { step: 'key', open: null }; c.lockMode(true); }, 'sm', { id: 'use-recovery' });
  }
  function lockPath(c) {
    var h = c.h;
    function back() { clear(); c.lockMode(false); }
    if (lk.step === 'key') {
      var k = c.passField('rk-enter-key');
      return h('form', { class: 'card', id: 'rk-lock-card', onsubmit: function (e) {
        e.preventDefault();
        c.act(function () {
          return attempt(c.main, function () { return L.store.openWithRecovery(k.value); }).then(function (o) { k.value = ''; lk.open = o; lk.step = 'pass'; c.render(); });
        });
      } }, h('h2', { text: 'Use recovery key' }), h('p', { class: 'mut small', text: 'Enter the recovery key of the main vault. Next you set a new passphrase and get a new recovery key; the key you used stops working.' }),
        c.field('Recovery key', k), h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn pri', id: 'rk-continue', text: 'Continue' }), c.btn('Back', back, '', { id: 'rk-back' })));
    }
    var p1 = c.passField('rk-new-pass'), p2 = c.passField('rk-new-pass2');
    return h('form', { class: 'card', id: 'rk-lock-card', onsubmit: function (e) {
      e.preventDefault();
      c.act(function () {
        if (p1.value.length < 12) throw new Error('Passphrase must be at least 12 characters.');
        if (p1.value !== p2.value) throw new Error('The two passphrases do not match.');
        return lk.open.prepare(p1.value).then(function (prep) {
          p1.value = ''; p2.value = '';
          showKey(c, { key: prep.key, finish: function (t) { return prep.finish(t); } }, 'main', 'Your new recovery key', { onDone: function () { clear(); c.lockMode(false); c.enter('unlock with recovery key'); } });
        });
      });
    } }, h('h2', { text: 'Set a new passphrase' }), h('p', { class: 'mut small', text: 'The recovery key worked. Choose a new passphrase (12 characters or more). A new recovery key is shown next.' }),
      c.field('New passphrase', p1), c.field('Confirm new passphrase', p2), h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn pri', id: 'rk-setpass', text: 'Continue' }), c.btn('Cancel', function () { if (lk.open) lk.open.cancel(); back(); }, '', { id: 'rk-cancel' })));
  }
  // ---- private unlock: Use recovery key ----
  function privLink(c) {
    return c.btn('Use private recovery key', function () { pk = { step: 'key', open: null, prep: null, show: true }; c.render(); }, 'sm', { id: 'use-priv-recovery' });
  }
  function privPath(c) {
    var h = c.h;
    if (pk.step === 'key') {
      var k = c.passField('rk-priv-enter-key');
      return h('form', { class: 'card', id: 'rk-priv-lock', onsubmit: function (e) {
        e.preventDefault();
        c.act(function () {
          return attempt(c.priv, function () { return L.priv.openWithRecovery(k.value); }).then(function (o) { k.value = ''; pk.open = o; pk.step = 'pass'; c.render(); });
        });
      } }, h('h3', { text: 'Use private recovery key' }), c.field('Private recovery key', k),
        h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn pri', id: 'rk-priv-continue', text: 'Continue' }), c.btn('Back', function () { pk = { step: 'key', open: null }; c.render(); }, '', { id: 'rk-priv-back' })));
    }
    var p1 = c.passField('rk-priv-new-pass'), p2 = c.passField('rk-priv-new-pass2');
    return h('form', { class: 'card', id: 'rk-priv-lock', onsubmit: function (e) {
      e.preventDefault();
      c.act(function () {
        if (p1.value.length < 12) throw new Error('Passphrase must be at least 12 characters.');
        if (p1.value !== p2.value) throw new Error('The two passphrases do not match.');
        return pk.open.prepare(p1.value).then(function (prep) {
          p1.value = ''; p2.value = '';
          showKey(c, { key: prep.key, finish: function (t) { return prep.finish(t); } }, 'priv', 'Your new private recovery key', { onDone: function () { pk = { step: 'key', open: null }; c.setNotice('ok', 'Private vault open with its new passphrase.'); c.render(); } });
        });
      });
    } }, h('h3', { text: 'Set a new private passphrase' }), c.field('New private passphrase', p1), c.field('Confirm new private passphrase', p2),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn pri', id: 'rk-priv-setpass', text: 'Continue' }), c.btn('Cancel', function () { if (pk.open) pk.open.cancel(); pk = { step: 'key', open: null }; c.render(); }, '', { id: 'rk-priv-cancel' })));
  }
  function privActive() { return !!pk.show; }

  // ---- the printable sheet ----
  function sheet(c, view) {
    var h = c.h, s = L.store.getState(), hasPriv = L.priv.isSetUp(s);
    function boxes(key) {
      var groups = key ? key.split('-') : [];
      var out = [];
      for (var i = 0; i < 14; i++) out.push(h('span', { class: 'rk-box', text: groups[i] || '' }));
      return h('p', { class: 'rk-boxes' }, out);
    }
    function part(scope, title, on) {
      return h('div', { class: 'rk-part', id: 'rk-sheet-' + scope },
        h('h2', { text: title }),
        h('p', { text: on ? 'A recovery key is on for this vault.' : 'No recovery key is on for this vault.' }),
        h('p', { class: 'small', text: 'Write the key here, 14 groups of 4 letters or digits:' }), boxes(sheetKeys[scope]));
    }
    var back = c.btn('Back', function () { sheetKeys = { main: '', priv: '' }; c.go('settings'); }, 'sm back noprint', { id: 'pv-back' });
    var pbtn = c.btn('Print', function () { window.print(); }, 'pri noprint', { id: 'pv-print' });
    var anyKey = !!(sheetKeys.main || sheetKeys.priv);
    return h('div', { class: 'printview', id: 'print-recovery' }, h('div', { class: 'row noprint' }, back, pbtn),
      h('h1', { text: 'LifeOS recovery sheet' }),
      anyKey ? h('p', { class: 'warn small', id: 'rk-sheet-warn', text: 'This sheet includes a recovery key. Printers and print queues may keep a copy. Store the paper offline.' }) : h('p', { class: 'small noprint', id: 'rk-sheet-nokey', text: 'This sheet has no key on it. Write the key in the boxes by hand.' }),
      part('main', 'Main vault', L.store.hasRecovery()),
      hasPriv ? part('priv', 'Private vault', L.priv.hasRecovery(s)) : null,
      h('h2', { text: 'What each key opens' }),
      h('p', { text: 'The main recovery key opens the main vault only. The private recovery key opens the private vault only. Neither opens the other, and neither is stored by LifeOS.' }),
      h('h2', { text: 'How to keep a key' }),
      h('p', { text: 'On paper, offline. Not as a photo, a scan or a note in the cloud.' }),
      h('h2', { text: 'If a key or the passphrase is lost' }),
      h('p', { text: 'Passphrase known, key lost: in Settings, replace the key or turn it off. Passphrase lost, key known: on the lock screen choose "Use recovery key", then set a new passphrase; a new key is shown and the old one stops working.' }),
      h('h2', { text: 'If a key may have been seen' }),
      h('p', { text: 'Replace it in Settings. Export a fresh backup and delete old backups, Drive copies and archive files: ' + KEEP }),
      h('h2', { text: 'If both are lost' }),
      h('p', { text: 'If the passphrase and the recovery key are both lost, the data cannot be recovered by anyone.' }));
  }

  // ---- first-run prompts ----
  var later = false;
  // The setup checklist row for the main key: "Turn on now" asks for the passphrase and shows the key; "Later" folds it to one line and keeps it on the checklist.
  function setupPrompt(c) {
    var h = c.h;
    if (L.store.hasRecovery()) return h('p', { class: 'small', id: 'setup-recovery', 'data-done': 'true' }, h('span', { class: 'chip ok', text: 'Done' }), h('span', { text: ' Recovery key for the main vault is on.' }));
    var pass = c.passField('setup-rk-pass');
    function now() {
      return c.act(function () {
        return attempt(c.main, function () { return L.store.beginRecovery(pass.value); }).then(function (handle) {
          pass.value = '';
          showKey(c, handle, 'main', 'Your recovery key', { onDone: function () { later = false; c.render(); } });
        });
      });
    }
    if (later) return h('p', { class: 'small', id: 'setup-recovery', 'data-done': 'false' }, h('span', { class: 'chip', text: 'To do' }), h('span', { text: ' Recovery key for the main vault. ' }), c.btn('Turn on now', function () { later = false; c.render(); }, 'sm', { id: 'setup-recovery-open', 'aria-label': 'Open: turn on a recovery key' }));
    return h('div', { class: 'card', id: 'setup-recovery', 'data-done': 'false' }, h('h3', { text: 'Recovery key for the main vault' }),
      h('p', { class: 'mut small', text: 'If the passphrase is forgotten the data cannot be recovered. A recovery key you write down opens the main vault. It is shown once and is not stored.' }),
      c.field('Passphrase', pass),
      h('div', { class: 'row' }, c.btn('Turn on now', now, 'sm pri', { id: 'setup-rk-now' }), c.btn('Later', function () { later = true; c.render(); }, 'sm', { id: 'setup-rk-later' })));
  }
  // Right after the private vault is created (it is open, and the passphrase just typed is passed in and not kept).
  function privSetupPrompt(c, passphrase) {
    var h = c.h, pw = passphrase;
    setTimeout(function () {
      c.openDialog({
        title: 'Recovery key for the private vault?', yes: 'Turn on now', no: 'Later',
        body: [h('p', { class: 'mut', id: 'priv-rk-prompt', text: 'A private recovery key opens only the private vault if its passphrase is forgotten. It is shown once and is not stored. It can also be turned on later from the private vault screen.' })],
        onYes: function () {
          return attempt(c.priv, function () { return L.priv.beginRecovery(pw); }).then(function (handle) {
            pw = '';
            c.closeDialog();
            showKey(c, handle, 'priv', 'Your private recovery key', { onDone: function () { c.render(); } });
            return false;
          });
        }
      });
    }, 0);
  }

  L.recoveryUI = { mainCard: mainCard, privCard: privCard, changeFields: changeFields, lockLink: lockLink, lockPath: lockPath, privLink: privLink, privPath: privPath, privActive: privActive, sheet: sheet, dropSheet: dropSheet, setupPrompt: setupPrompt, privSetupPrompt: privSetupPrompt, clear: clear, attempt: attempt };
})();
