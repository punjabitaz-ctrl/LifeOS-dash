(function () {
  'use strict';
  var L = globalThis.LifeOS;

  function when(iso) { return iso ? String(iso).replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown'; }
  function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  var NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

  // c is the context app.js passes in: { h, field, btn, openDialog, commit, download, setNotice, render }
  function section(c) {
    var h = c.h, s = L.store.getState(), nas = s.settings.nas || {};
    var card = h('div', { class: 'card', id: 'nas-card' }, h('h2', { text: 'NAS sync (main copy)' }));
    card.appendChild(h('p', { class: 'mut small', text: 'Your NAS keeps the main encrypted copy and Google Drive keeps a second one. Only the encrypted vault is sent. The passphrase and recovery key never leave this device. Sync is manual: nothing runs in the background.' }));
    if (!L.nas || !L.nas.isAvailable(window.location)) {
      card.appendChild(h('p', { class: 'mut', id: 'nas-na', text: 'NAS sync is offered only when this page is served over https from its own address. See docs/NAS-SETUP.md.' }));
      return card;
    }
    var status = h('p', { class: 'small', id: 'nas-status', role: 'status', text: '' });
    var driveStatus = h('p', { class: 'small', id: 'nas-drive-status', role: 'status', text: '' });
    var tokenState = h('p', { class: 'small mut', id: 'nas-token-state' });
    var syncBtn;
    function say(t) { status.textContent = t; }
    function paint() {
      var st = L.store.getState().settings.nas || {};
      tokenState.textContent = st.token ? 'A device token is saved inside the encrypted vault (since ' + (st.tokenAt || 'an earlier day') + '). It is never shown.' : 'No device token yet. Create one, then register it on the NAS service.';
      if (syncBtn) syncBtn.disabled = !st.token;
    }
    function diag(e) { try { if (L.ops && !L.ops.recordError(e, 'sync')) L.ops.record('SYNC_FAIL', 'sync'); } catch (x) { /* diagnostics never block */ } }
    function fail(e) {
      if (e && e.code === 'NEED_PASSPHRASE') { askPass(); return; }
      diag(e);
      say(e && e.message ? String(e.message).slice(0, 300) : 'NAS sync failed.');
      paint();
    }
    function askPass() {
      var p = h('input', { type: 'password', id: 'nas-pass', autocomplete: 'off' });
      c.openDialog({
        title: 'Passphrase of the NAS copy', yes: 'Continue',
        body: [h('p', { class: 'mut', text: 'The NAS copy was made with a different key. Enter the passphrase it was created with. It is used on this device only and is never sent anywhere.' }), c.field('Passphrase', p)],
        onYes: function () { var v = p.value; p.value = ''; return start(v).then(function (opened) { return opened ? false : undefined; }); }
      });
    }
    function finish(r) {
      if (r.kind === 'uploaded') say('Uploaded the encrypted vault to the NAS (revision ' + r.rev + ').');
      else if (r.kind === 'in-sync') say('The NAS copy is already in sync (revision ' + r.rev + ').');
      else if (r.kind === 'downloaded') { c.setNotice('ok', 'Downloaded the NAS copy (revision ' + r.rev + ').'); c.render(); }
      else say('Nothing changed on the NAS.');
      paint();
    }
    // After the NAS step (done, cancelled or failed) the Drive copy is written as well, when Drive is connected.
    function thenDrive() {
      driveStatus.textContent = '';
      if (!L.sync || !L.sync.isConnected() || !L.sync.isAvailable(window.location) || !L.syncUI || !L.syncUI._driveStart) { driveStatus.textContent = 'Google Drive: not connected, so no second copy was written.'; return Promise.resolve(); }
      driveStatus.textContent = 'Google Drive: syncing...';
      return L.syncUI._driveStart('').then(function () {
        var el = document.getElementById('sync-status');
        driveStatus.textContent = 'Google Drive: ' + (el && el.textContent ? el.textContent : 'done.');
      }, function () { driveStatus.textContent = 'Google Drive: the sync did not finish. See the Google Drive card.'; });
    }
    // The Drive step starts after the current NAS dialog has closed, so a Drive dialog is never closed with it (SEC-134).
    function driveLater() { setTimeout(function () { thenDrive(); }, 0); }
    function decide(d) {
      var conflict = d.kind === 'conflict';
      var pick = h('select', { id: 'nas-choice' },
        conflict ? [h('option', { value: 'local', text: 'Keep this device and replace the NAS copy' }), h('option', { value: 'remote', text: 'Use the NAS copy and replace this device' })]
          : [h('option', { value: 'download', text: 'Download the NAS copy' })]);
      var ack = d.dropsWork ? h('input', { type: 'checkbox', id: 'nas-workloss' }) : null;
      c.openDialog({
        title: conflict ? 'Both copies changed' : 'A newer copy is on the NAS', yes: 'Continue',
        body: [
          h('p', { class: 'mut', text: conflict ? 'Nothing is merged. Pick the copy to keep. The other copy is saved to a file first.' : 'This device has no changes since the last sync.' }),
          d.passphraseDiffers ? h('p', { class: 'small', id: 'nas-passdiff', text: 'The NAS copy uses a different passphrase from this device. Using the NAS copy switches this device to that passphrase. Keeping this device uploads it under this device\'s passphrase.' }) : null,
          L.syncUI._sumList(c, 'This device', d.local), L.syncUI._sumList(c, 'NAS', d.remote), c.field('Choice', pick),
          ack ? h('p', { class: 'small', id: 'nas-olderformat', text: L.store.lossWhy(d.dropped, d.remote.schema < 14, 'The NAS copy') + 'Using it removes this device\'s ' + L.store.lossText(L.store.getState(), null, d.dropped || []) + '.' }) : null,
          ack ? h('label', { class: 'row small' }, ack, h('span', { text: 'I understand. Remove this data if I use the NAS copy.' })) : null],
        onYes: function () {
          return L.nas.apply(d, pick.value, {
            allowWorkLoss: !!(ack && ack.checked),
            saveBackup: function (text, name) { c.download(name, text, 'application/json'); return Promise.resolve(); }
          }).then(finish, function (e) { fail(e); }).then(driveLater);
        }
      });
    }
    // SEC-134: the NAS copy is older than the last sync. It is never used; the owner may replace it with this device's copy (saved to a file first).
    function rollbackDialog(pass) {
      c.openDialog({
        title: 'The NAS copy is older than the last sync', yes: 'Replace the NAS copy', danger: true,
        body: [h('p', { class: 'mut', id: 'nas-rollback', text: 'The NAS sent a copy older than the one this device last synced, for example after a restore or a snapshot rollback on the NAS. It was not used and nothing on this device changed. If you did not expect this, check the NAS first. You can replace the NAS copy with this device\'s copy. The NAS copy is saved to a file first.' })],
        onYes: function () {
          return L.nas.replaceOlder({ passphrase: pass, saveBackup: function (text, name) { c.download(name, text, 'application/json'); return Promise.resolve(); } })
            .then(finish, function (e) { fail(e); }).then(driveLater);
        }
      });
    }
    // Resolves true when a dialog took over, false when the NAS step finished. While a NAS dialog is open the Drive step waits (SEC-134):
    // it runs once that dialog's choice is made, so a Drive dialog can never replace the NAS one.
    function start(pass) {
      say('Syncing with the NAS...');
      return L.nas.run({ passphrase: pass }).then(function (r) {
        if (r.kind === 'conflict' || r.kind === 'download-offer') { say('Choose how to continue.'); decide(r); return true; }
        finish(r);
        driveLater();
        return false;
      }, function (e) {
        if (e && e.code === 'WRONG_PASSPHRASE') { diag(e); say(e.message + ' Check the passphrase and try again.'); paint(); throw e; }
        if (e && e.code === 'NEED_PASSPHRASE') { say('Enter the passphrase of the NAS copy.'); driveStatus.textContent = 'Google Drive: waits for the NAS step.'; askPass(); return true; }
        if (e && e.code === 'ROLLBACK') { diag(e); say(e.message); driveStatus.textContent = 'Google Drive: waits for the NAS step.'; paint(); rollbackDialog(pass); return true; }
        fail(e);
        paint();
        // The NAS could not be reached or refused: the Drive copy is still written.
        driveLater();
        return false;
      });
    }

    // ---- device token ----
    function tokenDialog() {
      var name = h('input', { type: 'text', id: 'nas-devname', maxlength: '40', autocomplete: 'off', value: 'this-device' });
      c.openDialog({
        title: 'Create a device token', yes: 'Create',
        body: [h('p', { class: 'mut', text: 'A long random token is made here and kept only inside the encrypted vault. You register it on the NAS service by its hash, so the token itself is never shown or copied.' }),
          c.field('Device name (for you to recognise it on the service)', name)],
        onYes: function () {
          var n = name.value.trim();
          if (!NAME_RE.test(n)) throw new Error('Use 1 to 40 letters, digits, spaces, dots, dashes or underscores for the device name.');
          return L.nas.createToken().then(function (r) { paint(); showRegister(n, r.hash); return false; });
        }
      });
    }
    function showRegister(n, hash) {
      var cmd = 'token register ' + (/\s/.test(n) ? '"' + n + '"' : n) + ' ' + hash;
      var box = h('textarea', { id: 'nas-register', readOnly: true, rows: '3', value: cmd, 'aria-label': 'Registration command' });
      c.openDialog({
        title: 'Register this device on the NAS', yes: 'Done',
        body: [h('p', { class: 'mut', text: 'Run this on the NAS with the service command (docs/NAS-SETUP.md), then press Test connection. It holds only a hash. If you create another token, revoke this device name on the service.' }), box],
        onYes: function () { say('Token created. Register it on the service, then test the connection.'); }
      });
    }
    function pasteDialog() {
      var t = h('input', { type: 'password', id: 'nas-paste', autocomplete: 'off', maxlength: '60' });
      c.openDialog({
        title: 'Use a token from the service', yes: 'Save',
        body: [h('p', { class: 'mut', text: 'Paste a token made by the service\'s token add command. It goes straight into the encrypted vault and is not shown again.' }), c.field('Device token', t)],
        onYes: function () { var v = t.value; t.value = ''; return L.nas.setToken(v).then(function () { paint(); say('Token saved. Test the connection next.'); }); }
      });
    }
    function removeDialog() {
      c.openDialog({
        title: 'Remove the device token?', yes: 'Remove', danger: true,
        body: [h('p', { class: 'mut', text: 'This device stops syncing with the NAS. Revoke the device on the service too. The NAS keeps its copies.' })],
        onYes: function () { return L.nas.removeToken().then(function () { paint(); say('Token removed.'); }); }
      });
    }
    var TEST_TEXT = { NAS_UNREACHABLE: 'Cannot reach the NAS. ' + (L.nas ? L.nas.TAILSCALE : ''), NAS_AUTH: 'The NAS did not accept this device\'s token. Register its hash on the service, or create a new token.', NAS_FAIL: 'The NAS service could not be checked.' };
    function testIt() {
      if (!L.nas.hasToken()) { say('Create a device token first.'); return; }
      say('Testing the NAS. Nothing from your vault is sent.');
      L.nas.test().then(function (r) {
        say(r.ok ? 'The NAS answered and accepted this device\'s token.' : 'Connection failed. Code: ' + r.code + '. ' + (TEST_TEXT[r.code] || ''));
        status.setAttribute('data-code', r.ok ? 'OK' : r.code);
      });
    }
    function historyDialog() {
      say('Reading the NAS history...');
      L.nas.versions().then(function (list) {
        say('');
        var rows = list.length ? list.map(function (v) {
          return h('div', { class: 'row small' },
            h('span', { text: when(v.at) + ', revision ' + v.envRev + ', ' + kb(v.size) }),
            c.btn('Save as file', function () {
              L.nas.getVersion(v.id).then(function (t) { c.download('lifeos-nas-version-' + v.id + '.json', t, 'application/json'); c.setNotice('ok', 'Saved a copy of that version. Restore it from Settings, Restore from a backup file.'); }, fail);
            }, 'sm'));
        }) : [h('p', { class: 'mut', text: 'The NAS holds no copy yet.' })];
        c.openDialog({ title: 'NAS history (last ' + 30 + ' copies)', yes: 'Close', body: [h('p', { class: 'mut small', text: 'Each is an encrypted copy. Save one as a file and restore it with your passphrase.' })].concat(rows), onYes: function () {} });
      }, fail);
    }

    syncBtn = c.btn('Sync now', function () { start('').catch(function () {}); }, 'pri', { id: 'nas-sync-now' });
    card.appendChild(tokenState);
    card.appendChild(h('div', { class: 'row' },
      c.btn('Create device token', tokenDialog, '', { id: 'nas-token-new' }),
      c.btn('Use a token from the service', pasteDialog, '', { id: 'nas-token-paste' }),
      c.btn('Remove token', removeDialog, '', { id: 'nas-token-off' })));
    card.appendChild(h('div', { class: 'row' }, syncBtn,
      c.btn('Test connection', testIt, '', { id: 'nas-test' }),
      c.btn('NAS history', historyDialog, '', { id: 'nas-history' })));
    card.appendChild(status);
    card.appendChild(driveStatus);
    card.appendChild(h('p', { class: 'mut small', text: 'Sync now writes the NAS first, then Google Drive when it is connected. If the NAS cannot be reached you will see "Connect Tailscale and try again".' }));
    paint();
    return card;
  }

  L.nasUI = { section: section };
})();
