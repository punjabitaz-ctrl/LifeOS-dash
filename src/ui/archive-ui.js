(function () {
  'use strict';
  // v1.2.0 part B: the Archive screens. Settings card (list, size setting, start an archive, open or restore), the proposal card on the
  // dashboard and the weekly review, and the read-only Archive screen. app.js passes a context: { h, field, btn, openDialog, download,
  // setNotice, render, go, readFile, today, friendly }. Nothing here is removed or written without a tap and the main passphrase.
  var L = globalThis.LifeOS;
  var LABELS = { entries: 'Money, assets, health and mood entries', invoices: 'Invoices', taxPayments: 'Tax payments', trips: 'Mileage trips', contacts: 'Logged contacts', studySessions: 'Study sessions', habitLog: 'Daily check ticks', activities: 'Activities', maintenance: 'Maintenance', renewals: 'Renewals', reviews: 'Weekly reviews', insights: 'Insights', checkins: 'Wellbeing check-ins' };
  var cache = { rev: -1, bytes: 0, busy: false };

  function mb(bytes) { return (Math.round(bytes / 104857.6) / 10) + ' MB'; }
  function when(iso) { return iso ? String(iso).replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown'; }
  function countText(counts) {
    var parts = Object.keys(counts || {}).map(function (k) { return counts[k] + ' ' + (LABELS[k] || k).toLowerCase(); });
    return parts.length ? parts.join(', ') : 'nothing';
  }
  function copiesText(a) {
    var v = a.copies.filter(function (x) { return x.verified; }).map(function (x) { return x.where === 'drive' ? 'Drive (verified)' : 'download (confirmed)'; });
    return v.length ? v.join(' and ') : 'no verified copy';
  }
  function state() { return L.store.getState(); }
  function viewState() { return L.priv.isOpen() ? L.priv.view(state()) : state(); }

  // The vault's encrypted size, refreshed when the revision changes (never on every render).
  function refreshSize(c) {
    var rev = L.store.getMeta().rev;
    if (cache.rev === rev || cache.busy) return;
    cache.busy = true;
    L.archive.envelopeBytes().then(function (n) {
      cache.busy = false; cache.rev = rev;
      if (n !== cache.bytes) { var was = !!proposalOf(); cache.bytes = n; if (was !== !!proposalOf() && L.store.isUnlocked()) c.render(); }
    }, function () { cache.busy = false; });
  }
  // Memoised per revision, size, day and private state: planning walks every record.
  function proposalOf() {
    var key = L.store.getMeta().rev + '|' + cache.bytes + '|' + L.metrics.todayISO() + '|' + L.priv.isOpen();
    if (cache.pKey === key) return cache.pVal;
    var v = null;
    try { v = L.archive.propose(viewState(), cache.bytes, L.metrics.todayISO()); } catch (e) { v = null; }
    cache.pKey = key; cache.pVal = v;
    return v;
  }

  // ---- starting an archive ----
  function startDialog(c, year) {
    var h = c.h, st = state(), pl, gate = '';
    try { pl = L.archive.plan(viewState(), year, c.today()); } catch (e) { c.setNotice('err', c.friendly(e)); return; }
    var counts = {};
    L.archive.NAMES.forEach(function (n) { var k = pl.recs[n].length + pl.priv[n].length; if (k) counts[n] = k; });
    var connected = L.sync && L.sync.isConnected && L.sync.isConnected() && L.sync.isAvailable(window.location);
    var pass = h('input', { type: 'password', id: 'arch-pass', autocomplete: 'current-password' }), rk = L.store.hasRecovery() ? h('input', { type: 'password', id: 'arch-key', autocomplete: 'off' }) : null;
    var dr = h('input', { type: 'checkbox', id: 'arch-drive', checked: connected, disabled: !connected });
    var dl = h('input', { type: 'checkbox', id: 'arch-dl', checked: true });
    var status = h('p', { class: 'small', id: 'arch-status', role: 'status', text: '' });
    var saved = h('div', { class: 'hidden', id: 'arch-saved' });
    var running = false;
    if (st.priv && st.priv.marks && st.priv.marks.length && !L.priv.isOpen()) gate = 'The private vault is set up and closed. Open it first: it may hold records of that year, and the archive file has to take them along.';
    c.openDialog({
      title: 'Archive ' + year, yes: 'Archive ' + year,
      body: [
        h('p', { class: 'mut', text: 'Moves finished records of ' + year + ' out of the live vault into an encrypted file. Open items, planned items, unpaid invoices and anything a live record points at stay. Yearly totals stay in the vault, so charts, net worth history and goals keep their figures.' }),
        h('p', { class: 'small', id: 'arch-counts', text: 'Would move: ' + countText(counts) + '. About ' + mb(Math.round(JSON.stringify(pl.recs).length * 4 / 3)) + ' of the vault.' }),
        gate ? h('p', { class: 'warn small', id: 'arch-gate', text: gate }) : null,
        c.field('Main passphrase', pass, 'The archive file is encrypted with it.'),
        rk ? c.field('Recovery key', rk, 'The archive file carries it, so it opens with the key as well. It is checked and never stored.') : null,
        h('label', { class: 'row small' }, dr, h('span', { text: connected ? 'Keep a copy on Google Drive (checked by downloading it again)' : 'Google Drive is not connected (connect it in Settings to keep a Drive copy too)' })),
        h('label', { class: 'row small' }, dl, h('span', { text: 'Download a copy. Save it on your NAS: the browser cannot write there itself, so you save it and then confirm.' })),
        status, saved],
      onYes: function () {
        if (running) return false;
        if (!dr.checked && !dl.checked) throw new Error('Choose at least one copy to keep.');
        running = true;
        var p = pass.value;
        status.textContent = 'Writing and checking the archive file...';
        var io = {
          put: function (n, t) { return L.sync.putNamed(n, t); },
          get: function (n) { return L.sync.getNamed(n); },
          save: function (n, t) { c.download(n, t, 'application/json'); },
          confirmSaved: function () {
            return new Promise(function (res) {
              saved.setAttribute('class', '');
              saved.replaceChildren(
                h('p', { class: 'small', text: 'The file was downloaded. Move it to your NAS, then confirm. Nothing is removed from the vault until you do.' }),
                c.btn('I saved it', function () { saved.setAttribute('class', 'hidden'); res(true); }, 'pri sm', { id: 'arch-confirm' }),
                c.btn('I did not save it', function () { saved.setAttribute('class', 'hidden'); res(false); }, 'sm', { id: 'arch-noconfirm' }));
            });
          }
        };
        return L.archive.archiveYear({ year: year, passphrase: p, recoveryKey: rk ? rk.value : undefined, today: c.today(), drive: dr.checked && connected, download: dl.checked, io: io }).then(function (r) {
          running = false; pass.value = ''; if (rk) rk.value = '';
          c.setNotice('ok', 'Archived ' + year + ': ' + countText(r.counts) + '. Copies: ' + r.copies.map(function (x) { return x.where; }).join(' and ') + '.');
          c.render();
        }, function (e) { running = false; status.textContent = ''; throw e; });
      }
    });
  }

  // ---- opening and restoring ----
  function sourceDialog(c, year, mode) {
    var h = c.h, pass = h('input', { type: 'password', id: 'arch-open-pass', autocomplete: 'current-password' });
    var file = h('input', { type: 'file', id: 'arch-file', accept: '.json,application/json' });
    var pp = h('input', { type: 'password', id: 'arch-open-priv', autocomplete: 'off' });
    // SEC-128: a file made under an earlier main passphrase opens with the main recovery key it carries (typed here, never stored).
    var rk = h('input', { type: 'password', id: 'arch-open-key', autocomplete: 'off' });
    var connected = L.sync && L.sync.isConnected && L.sync.isConnected();
    var src = h('select', { id: 'arch-src' }, [h('option', { value: 'file', text: 'A file I saved' })].concat(year ? [h('option', { value: 'drive', text: 'Google Drive', disabled: !connected })] : []));
    if (year && connected) src.value = 'drive';
    var restore = mode === 'restore';
    var tick = restore ? h('input', { type: 'checkbox', id: 'arch-restore-ok' }) : null;
    c.openDialog({
      title: (restore ? 'Restore ' : 'Open ') + (year || 'an archive'), yes: restore ? 'Restore' : 'Open',
      body: [
        h('p', { class: 'mut', text: restore ? 'Puts the records of that year back into the live vault. Records already there are never overwritten. The year is then no longer archived here.' : 'Opens the archive read-only. It is decrypted in memory only and dropped when you close it or lock the app.' }),
        c.field('Read from', src), c.field('Archive file', file), c.field('Main passphrase', pass),
        c.field('Main recovery key the file carries (only if the main passphrase changed since the file was made)', rk),
        L.priv.isOpen() ? c.field('Private passphrase used when the file was made (only if you changed it since)', pp) : null,
        tick ? h('label', { class: 'row small' }, tick, h('span', { text: 'I understand. Restore these records into the live vault.' })) : null],
      onYes: function () {
        if (restore && !tick.checked) throw new Error('Tick the box to confirm the restore.');
        var p = pass.value, pv = pp.value, fk = rk.value ? { recovery: rk.value } : undefined;
        rk.value = '';
        var get = src.value === 'drive' && year ? L.sync.getNamed(L.archive.fileName(year)) : c.readFile(file.files && file.files[0], L.archive.MAX_FILE);
        return get.then(function (text) {
          if (restore) return L.archive.restoreYear(text, p, year, pv || undefined, fk).then(function (r) { pass.value = ''; c.setNotice('ok', 'Restored ' + r.year + ': ' + r.added + ' records added, ' + r.skipped + ' already in the vault.'); c.render(); });
          return L.archive.openArchive(text, fk || p, year || undefined, pv || undefined).then(function () { pass.value = ''; c.go('archive'); });
        });
      }
    });
  }

  // ---- Settings card ----
  function section(c) {
    var h = c.h, st = state(), A = L.archive;
    refreshSize(c);
    var card = h('div', { class: 'card', id: 'archive-card' }, h('h2', { text: 'Archive' }),
      h('p', { class: 'mut small', text: 'The vault keeps this year and the two before it. Older years can move into one encrypted file each (lifeos-archive-YYYY.json). Yearly totals stay, so trends keep working. Vault size now: ' + mb(cache.bytes) + '.' }));
    var mbIn = h('input', { type: 'number', id: 'arch-mb', min: '20', max: '60', step: '1', value: String(st.settings.archiveSuggestMB || 40) });
    card.appendChild(h('form', { onsubmit: function (e) {
      e.preventDefault();
      var v = Math.round(Number(mbIn.value));
      if (!(v >= 20 && v <= 60)) { c.setNotice('err', 'Enter a size from 20 to 60 MB.'); return; }
      c.commit(function (x) { x.settings.archiveSuggestMB = v; }, 'archive size setting').then(function () { c.setNotice('ok', 'Saved.'); c.render(); }, function (er) { c.setNotice('err', c.friendly(er)); });
    } }, c.field('Suggest archiving when the vault passes (MB, 20 to 60)', mbIn), h('button', { type: 'submit', class: 'btn sm', id: 'arch-mb-save', text: 'Save' })));
    var years = [];
    try { years = A.archivable(viewState(), c.today()); } catch (e) { years = []; }
    if (years.length) {
      var ys = h('select', { id: 'arch-year' }, years.map(function (y) { return h('option', { value: String(y), text: String(y) }); }));
      card.appendChild(h('div', { class: 'row' }, c.field('Year to archive', ys), c.btn('Archive this year', function () { startDialog(c, Number(ys.value)); }, 'pri', { id: 'arch-run' })));
    } else card.appendChild(h('p', { class: 'mut small', id: 'arch-none', text: 'No year is old enough to archive yet.' }));
    var list = (st.archives || []).slice().sort(function (a, b) { return b.year - a.year; });
    card.appendChild(h('h3', { text: 'Archived years' }));
    if (!list.length) card.appendChild(h('p', { class: 'mut small', text: 'None yet.' }));
    list.forEach(function (a) {
      card.appendChild(h('div', { class: 'row sp', 'data-year': String(a.year) },
        h('div', { class: 'small' }, h('strong', { text: String(a.year) }), h('div', { class: 'mut', text: 'Made ' + when(a.createdAt) + '. ' + countText(a.counts) + '. Copies: ' + copiesText(a) + '.' })),
        h('div', { class: 'row' }, c.btn('Open', function () { sourceDialog(c, a.year, 'open'); }, 'sm', { id: 'arch-open-' + a.year, 'aria-label': 'Open archive ' + a.year }),
          c.btn('Restore', function () { sourceDialog(c, a.year, 'restore'); }, 'sm', { id: 'arch-restore-' + a.year, 'aria-label': 'Restore archive ' + a.year }))));
    });
    card.appendChild(c.btn('Open an archive file', function () { sourceDialog(c, 0, 'open'); }, 'sm', { id: 'arch-open-file' }));
    return card;
  }

  // ---- proposal (dashboard and weekly review) ----
  function proposal(c) {
    if (!L.store.isUnlocked()) return null;
    refreshSize(c);
    var p = proposalOf();
    if (!p) return null;
    var h = c.h;
    return h('div', { class: 'card', id: 'archive-proposal' }, h('h2', { text: 'Archive old years' }),
      h('p', { class: 'small', text: (p.over ? 'The vault is ' + mb(p.envBytes) + ', over your ' + p.mb + ' MB setting. ' : '') + (p.fresh ? 'A new year can now move out of the live vault. ' : '') + 'Archiving ' + p.years.map(function (y) { return y.year; }).join(', ') + ' frees about ' + mb(p.freeBytes) + '. Nothing is removed until you tap and confirm.' }),
      h('div', { class: 'row' }, p.years.map(function (y) { return c.btn('Archive ' + y.year + ' (about ' + mb(y.freeBytes) + ')', function () { startDialog(c, y.year); }, 'sm', { 'data-year': String(y.year) }); })));
  }

  // ---- read-only Archive screen ----
  function rowOf(name, r) {
    var d = r.date || r.issueDate || r.paidOn || r.weekOf || r.lastDone || r.doneOn || (r.period && r.period.to) || '';
    var t = r.title || r.name || r.number || r.purpose || r.text || r.kind || r.habitId || r.channel || r.jurisdiction || '';
    var v = typeof r.value === 'number' ? String(r.value) : typeof r.amountCents === 'number' ? (r.amountCents / 100).toFixed(2) : typeof r.costCents === 'number' ? (r.costCents / 100).toFixed(2) : typeof r.minutes === 'number' ? r.minutes + ' min' : typeof r.cost === 'number' ? String(r.cost) : '';
    if (name === 'checkins') t = 'Check-in';
    return [d, String(t).slice(0, 120), v];
  }
  function screen(c) {
    var h = c.h, A = L.archive, info = A.info();
    if (!info) return h('div', null, h('h1', { text: 'Archive' }), h('p', { class: 'mut', text: 'No archive is open.' }), c.btn('Back to Settings', function () { c.go('settings'); }));
    var q = h('input', { type: 'search', id: 'arch-q', placeholder: 'Search this archive', 'aria-label': 'Search this archive', maxlength: '100' });
    var out = h('div', { id: 'arch-results' });
    function paint() {
      var secs = A.sections(), shown = 0;
      out.replaceChildren();
      secs.forEach(function (n) {
        var rows = A.search(n, q.value);
        if (!rows.length) return;
        shown += rows.length;
        var cut = rows.slice(0, 200);
        out.appendChild(h('h2', { text: (LABELS[n] || n) + ' (' + rows.length + ')' }));
        out.appendChild(h('div', { class: 'tablewrap' }, h('table', { 'data-section': n }, h('thead', null, h('tr', null, ['Date', 'Description', 'Amount or value'].map(function (x) { return h('th', { text: x }); }))),
          h('tbody', null, cut.map(function (r) { return h('tr', null, rowOf(n, r).map(function (x) { return h('td', { text: x }); })); })))));
        if (rows.length > cut.length) out.appendChild(h('p', { class: 'mut small', text: 'Showing 200 of ' + rows.length + '. Search to narrow.' }));
      });
      if (!shown) out.appendChild(h('p', { class: 'mut', id: 'arch-empty', text: q.value ? 'Nothing matches.' : 'This archive is empty.' }));
    }
    q.addEventListener('input', paint);
    paint();
    var incPriv = info.privNote === 'open' && L.priv.isOpen() ? h('input', { type: 'checkbox', id: 'arch-export-priv' }) : null;
    var priv = info.privNote === 'closed' ? 'This archive also holds private records. Open the private vault and open the archive again to see them.' : info.privNote === 'needs-passphrase' ? 'The private part was sealed with an earlier private passphrase. Open it again and enter that passphrase.' : info.privNote === 'open' ? 'Private records are included while the private vault is open.' : '';
    return h('div', { id: 'archive-screen' }, h('h1', { text: 'Archive ' + info.year }),
      h('p', { class: 'warn small', id: 'arch-readonly', text: 'Read-only. Decrypted in memory only; closing it or locking the app drops it.' }),
      h('p', { class: 'mut small', text: 'Made ' + when(info.createdAt) + '. ' + countText(info.counts) + '.' }),
      priv ? h('p', { class: 'small', id: 'arch-privnote', text: priv }) : null,
      h('div', { class: 'row' },
        c.btn('Close archive', function () { A.closeArchive(); c.go('settings'); }, 'pri sm', { id: 'arch-close' }),
        c.btn('Accountant export for ' + info.year, function () {
          try {
            // SEC-87: private records only with the tick (private vault open and the file's private part opened); otherwise the main state.
            var inc = !!(incPriv && incPriv.checked && L.priv.isOpen());
            var pkg = L.tax.exportPackage(A.exportState(inc), info.year, inc);
            if (pkg.blocked) { c.setNotice('err', pkg.message); return; }
            if (inc) pkg.privateIncluded = true;
            c.download('lifeos-accountant-' + info.year + '.csv', L.tax.exportCsv(pkg, function (id) { var p = ((inc ? viewState() : state()).projects || []).filter(function (x) { return x.id === id; })[0]; return p ? p.name : 'No line of work'; }), 'text/csv');
          } catch (e) { c.setNotice('err', c.friendly(e)); }
        }, 'sm', { id: 'arch-export' }),
        incPriv ? h('label', { class: 'row small' }, incPriv, h('span', { text: 'Include private records' })) : null),
      h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', { class: 'lbl', text: 'Search' }), q)),
      out);
  }

  L.archiveUI = { section: section, screen: screen, proposal: proposal, startDialog: startDialog };
})();
