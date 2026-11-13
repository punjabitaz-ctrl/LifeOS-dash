(function () {
  'use strict';
  var L = globalThis.LifeOS;

  function when(iso) { return iso ? String(iso).replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown'; }
  function sumList(c, label, s) {
    return c.h('div', { class: 'small' },
      c.h('strong', { text: label }),
      c.h('div', { class: 'mut', text: 'Revision ' + s.rev + ', saved ' + when(s.updatedAt) + ', ' + s.entries + ' entries' }));
  }

  // c is the context app.js passes in: { h, field, btn, openDialog, commit, download, setNotice, render }
  function section(c) {
    var s = L.store.getState(), sy = s.settings.sync || { clientId: '', remoteRev: -1 };
    var h = c.h;
    var card = h('div', { class: 'card', id: 'sync-card' }, h('h2', { text: 'Google Drive sync' }));
    if (!L.sync.isAvailable(window.location)) {
      card.appendChild(h('p', { class: 'mut', id: 'sync-na', text: 'Sync is only offered when this page is served over https. Only the encrypted vault is ever uploaded.' }));
      return card;
    }
    var status = h('p', { class: 'small', id: 'sync-status', role: 'status', text: '' });
    var cid = h('input', { type: 'text', id: 'sync-cid', value: sy.clientId || '', autocomplete: 'off', maxlength: '200', placeholder: 'xxxx.apps.googleusercontent.com' });
    var connState = h('p', { class: 'small mut', id: 'sync-conn' });
    var syncBtn;
    function paint() {
      var on = L.sync.isConnected();
      connState.textContent = on ? 'Connected to Google until about ' + new Date(L.sync.expiresAt()).toLocaleTimeString() + '. Reconnect each session.'
        : 'Not connected. Sign-in lasts about an hour, so reconnect each session.';
      if (syncBtn) syncBtn.disabled = !on;
    }
    function say(t) { status.textContent = t; }

    function finish(r) {
      if (r.kind === 'uploaded') say('Uploaded the encrypted vault to Drive (revision ' + r.rev + ').');
      else if (r.kind === 'in-sync') say('Already in sync (revision ' + r.rev + ').');
      else if (r.kind === 'downloaded') { c.setNotice('ok', 'Downloaded the Drive copy (revision ' + r.rev + ').'); c.render(); }
      else say('Nothing changed.');
      paint();
    }
    function fail(e) {
      if (e && e.code === 'NEED_PASSPHRASE') { askPass(); return; }
      say(e && e.message ? String(e.message).slice(0, 300) : 'Sync failed.');
      paint();
    }
    function askPass() {
      var p = h('input', { type: 'password', id: 'sync-pass', autocomplete: 'off' });
      c.openDialog({
        title: 'Passphrase of the Drive copy', yes: 'Continue',
        body: [h('p', { class: 'mut', text: 'The Drive copy was made with a different key. Enter the passphrase it was created with. It is used on this device only and is never sent anywhere.' }), c.field('Passphrase', p)],
        onYes: function () { var v = p.value; p.value = ''; return start(v).then(function (opened) { return opened ? false : undefined; }); }
      });
    }
    function decide(d) {
      var conflict = d.kind === 'conflict';
      var pick = h('select', { id: 'sync-choice' },
        conflict ? [h('option', { value: 'local', text: 'Keep this device and replace the Drive copy' }), h('option', { value: 'remote', text: 'Use the Drive copy and replace this device' })]
          : [h('option', { value: 'download', text: 'Download the Drive copy' })]);
      c.openDialog({
        title: conflict ? 'Both copies changed' : 'A newer copy is on Drive', yes: 'Continue',
        body: [
          h('p', { class: 'mut', text: conflict ? 'Nothing is merged. Pick the copy to keep. The other copy is saved to a file first.' : 'This device has no changes since the last sync.' }),
          d.passphraseDiffers ? h('p', { class: 'small', id: 'sync-passdiff', text: 'The Drive copy uses a different passphrase from this device. Using the Drive copy switches this device to that passphrase. Keeping this device uploads it under this device\'s passphrase.' }) : null,
          sumList(c, 'This device', d.local), sumList(c, 'Google Drive', d.remote), c.field('Choice', pick)],
        onYes: function () {
          return L.sync.apply(d, pick.value, {
            saveBackup: function (text, name) { c.download(name, text, 'application/json'); return Promise.resolve(); }
          }).then(finish, function (e) { fail(e); });
        }
      });
    }
    function start(pass) {
      say('Syncing...');
      return L.sync.run({ passphrase: pass }).then(function (r) {
        if (r.kind === 'conflict' || r.kind === 'download-offer') { say('Choose how to continue.'); decide(r); return true; }
        finish(r);
        return false;
      }, function (e) {
        if (e && e.code === 'WRONG_PASSPHRASE') say(e.message + ' Check the passphrase and try again.'); else fail(e);
        paint();
        if (e && e.code === 'WRONG_PASSPHRASE') throw e;
      });
    }

    syncBtn = c.btn('Sync now', function () { start('').catch(function () {}); }, 'pri', { id: 'sync-now' });
    var form = h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        var id;
        try { id = L.sync.validateClientId(cid.value); } catch (x) { say(x.message); return; }
        c.commit(function (x) { x.settings.sync = Object.assign({}, x.settings.sync, { clientId: id }); }, 'sync client id saved')
          .then(function () { say('Client ID saved.'); }, fail);
      }
    }, c.field('Google OAuth client ID', cid, 'From your own Google Cloud project. See docs/SYNC-SETUP.md.'),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn', id: 'sync-save', text: 'Save client ID' })));
    card.appendChild(form);
    card.appendChild(connState);
    card.appendChild(h('div', { class: 'row' },
      c.btn('Connect Google Drive', function () {
        var id = L.store.getState().settings.sync.clientId;
        if (!id) { say('Save your client ID first.'); return; }
        try { window.location.assign(L.sync.begin(id, { loc: window.location, storage: window.sessionStorage })); }
        catch (e) { say(e.message); }
      }, '', { id: 'sync-connect' }),
      syncBtn,
      c.btn('Disconnect', function () { L.sync.disconnect(); say('Disconnected.'); paint(); }, '', { id: 'sync-off' })));
    card.appendChild(status);
    card.appendChild(h('p', { class: 'mut small', text: 'Only the encrypted vault is uploaded, to a hidden app folder in your Drive. Google never sees your data or passphrase. Sync is manual.' }));
    paint();
    return card;
  }

  function afterUnlock(c) {
    var r = L.sync.takeReturn();
    if (r && r.error) {
      c.openDialog({ title: 'Google sign-in', yes: 'OK', body: [c.h('p', { text: r.error })], onYes: function () {} });
      return;
    }
    if (!L.sync.isConnected() || !L.sync.isAvailable(window.location)) return;
    c.openDialog({
      title: 'Sync with Google Drive?', yes: 'Sync now',
      body: [c.h('p', { class: 'mut', text: 'You are connected to Google. Sync the encrypted vault now?' })],
      onYes: function () {
        return L.sync.run({}).then(function (x) {
          if (x.kind === 'conflict' || x.kind === 'download-offer') c.setNotice('ok', 'Open Settings and press Sync now to choose between the copies.');
          else if (x.kind === 'uploaded') c.setNotice('ok', 'Uploaded the encrypted vault to Drive.');
          else c.setNotice('ok', 'Already in sync.');
        }, function (e) {
          if (!e || e.code !== 'NEED_PASSPHRASE') throw e;
          c.setNotice('ok', 'The Drive copy was made by another vault. Open Settings and press Sync now to enter its passphrase.');
        });
      }
    });
  }

  L.syncUI = { section: section, afterUnlock: afterUnlock };
})();
