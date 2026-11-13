(function () {
  'use strict';
  var L = globalThis.LifeOS;
  var MAX_FILE = 5 * 1024 * 1024;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var SVGTAGS = { svg: 1, polyline: 1, circle: 1, line: 1, path: 1 };
  var PROPS = { checked: 1, disabled: 1, readOnly: 1, selected: 1 };
  var STATUS = {
    'work:outcome': ['todo', 'done'],
    'learning:item': ['active', 'done'],
    'home:due': ['open', 'done'],
    'goals:goal': ['on-track', 'at-risk', 'off-track', 'done']
  };

  // ---------- helpers ----------
  function add(el, kids) {
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k == null || k === false) continue;
      if (Array.isArray(k)) add(el, k);
      else if (k instanceof Node) el.appendChild(k);
      else el.appendChild(document.createTextNode(String(k)));
    }
  }
  function h(tag, props) {
    var kids = Array.prototype.slice.call(arguments, 2);
    var svg = !!SVGTAGS[tag];
    var el = svg ? document.createElementNS(SVGNS, tag) : document.createElement(tag);
    var val;
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k.slice(0, 2) === 'on' && typeof v === 'function') { el.addEventListener(k.slice(2), v); return; }
        if (k === 'text') { el.textContent = String(v); return; }
        if (k === 'value' && !svg) { val = String(v); return; }
        if (!svg && PROPS[k]) { el[k] = !!v; return; }
        el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    add(el, kids);
    if (val !== undefined) el.value = val;
    return el;
  }
  function field(label, input, hint) {
    return h('label', { class: 'field' }, h('span', { class: 'lbl', text: label }), input, hint ? h('span', { class: 'hint', text: hint }) : null);
  }
  function btn(text, onclick, cls, extra) {
    return h('button', Object.assign({ type: 'button', class: 'btn' + (cls ? ' ' + cls : ''), onclick: onclick, text: text }, extra || {}));
  }
  function sel(id, opts, cur, onchange) {
    return h('select', { id: id, onchange: onchange }, opts.map(function (o) {
      return h('option', { value: o.v, text: o.t, selected: o.v === cur });
    }));
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(iso, n) {
    var p = iso.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function monthPeriod(iso) {
    var p = iso.split('-').map(Number);
    var last = new Date(Date.UTC(p[0], p[1], 0)).getUTCDate();
    return { from: p[0] + '-' + pad(p[1]) + '-01', to: p[0] + '-' + pad(p[1]) + '-' + pad(last) };
  }
  function quarterPeriod(iso) {
    var p = iso.split('-').map(Number);
    var q = Math.floor((p[1] - 1) / 3);
    var m1 = q * 3 + 1, m3 = q * 3 + 3;
    var last = new Date(Date.UTC(p[0], m3, 0)).getUTCDate();
    return { from: p[0] + '-' + pad(m1) + '-01', to: p[0] + '-' + pad(m3) + '-' + pad(last) };
  }
  function friendly(e) {
    var m = e && e.message ? String(e.message) : '';
    if (m === 'BAD_PASSPHRASE_OR_DATA') return 'That passphrase did not work, or the data is damaged.';
    if (!m) return 'Something went wrong.';
    return m.slice(0, 300);
  }
  function domainLabel(id) {
    var d = L.DOMAINS.find(function (x) { return x.id === id; });
    return d ? d.label : id;
  }
  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = h('a', { href: url, download: name, class: 'hidden' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }
  function readFile(file, max) {
    if (!file) return Promise.reject(new Error('Choose a file first.'));
    if (file.size > (max || MAX_FILE)) return Promise.reject(new Error('That file is larger than ' + Math.round((max || MAX_FILE) / 1048576) + ' MB.'));
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result)); };
      r.onerror = function () { rej(new Error('Could not read that file.')); };
      r.readAsText(file);
    });
  }
  function copyText(ta) {
    ta.focus(); ta.select();
    var p = (navigator.clipboard && navigator.clipboard.writeText) ? navigator.clipboard.writeText(ta.value) : Promise.reject();
    return p.catch(function () { if (!document.execCommand || !document.execCommand('copy')) throw new Error('Copy failed. Select the text and copy it manually.'); });
  }
  function checkPass(p) {
    if (typeof p !== 'string' || p.length < 12) throw new Error('Passphrase must be at least 12 characters.');
  }
  function passNote() {
    return h('p', { class: 'warn small', text: 'Your data is encrypted with this passphrase. If you forget it, your data cannot be recovered. There is no reset and no backdoor.' });
  }

  // ---------- state ----------
  var view = { name: 'lock' };
  var vaultExists = false;
  var notice = null, noticeEl = null;
  var busy = false;
  var csvPending = null;
  var ai = null;
  var dlgEl = null, dlgReturn = null;
  var idleTimer = null, lastActive = 0, locking = null;

  function setNotice(kind, text) {
    notice = text ? { kind: kind, text: text } : null;
    if (noticeEl) {
      noticeEl.textContent = text || '';
      noticeEl.setAttribute('class', 'notice' + (notice ? ' ' + kind : ''));
      if (text && noticeEl.scrollIntoView) noticeEl.scrollIntoView({ block: 'nearest' });
    }
  }
  function act(fn, okMsg) {
    if (busy) return Promise.resolve();
    busy = true;
    var root = document.getElementById('app');
    root.classList.add('busy');
    root.setAttribute('aria-busy', 'true');
    return Promise.resolve().then(fn).then(function () {
      if (okMsg) setNotice('ok', okMsg);
    }, function (e) { setNotice('err', friendly(e)); }).then(function () {
      busy = false;
      root.classList.remove('busy');
      root.removeAttribute('aria-busy');
    });
  }
  function addAudit(s, action) {
    if (!Array.isArray(s.audit)) s.audit = [];
    s.audit.push({ ts: new Date().toISOString(), action: action });
    while (s.audit.length > 200) s.audit.shift();
  }
  function commit(fn, action) {
    return L.store.commit(function (s) { if (fn) fn(s); if (action) addAudit(s, action); });
  }
  function st() { return L.store.getState(); }
  function go(name, extra) {
    view = Object.assign({ name: name }, extra || {});
    notice = null; csvPending = null; ai = null;
    render();
    window.scrollTo(0, 0);
    var t = document.querySelector('h1');
    if (t) { t.setAttribute('tabindex', '-1'); t.focus(); }
  }

  // ---------- dialog ----------
  function closeDialog() {
    if (dlgEl) { dlgEl.remove(); dlgEl = null; }
    if (dlgReturn && dlgReturn.isConnected) dlgReturn.focus();
    dlgReturn = null;
  }
  function openDialog(o) {
    closeDialog();
    dlgReturn = document.activeElement;
    var err = h('p', { class: 'small', role: 'status', text: '' });
    var yes = btn(o.yes || 'OK', function () {
      Promise.resolve().then(function () { return o.onYes(); }).then(function (keep) {
        if (keep !== false) closeDialog();
      }, function (e) { err.textContent = friendly(e); });
    }, o.danger ? 'bad' : 'pri');
    var box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title },
      h('h2', { text: o.title }), o.body || null, err,
      h('div', { class: 'row' }, yes, btn('Cancel', closeDialog)));
    dlgEl = h('div', { class: 'overlay' }, box);
    dlgEl.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeDialog(); return; }
      if (e.key === 'Tab') {
        var f = box.querySelectorAll('button,input,select,textarea');
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    document.body.appendChild(dlgEl);
    var inp = box.querySelector('input,textarea');
    (inp || yes).focus();
  }

  // ---------- auto-lock ----------
  function limitMs() {
    try { return (st().settings.autoLockMin || 15) * 60000; } catch (e) { return 900000; }
  }
  function resetIdle() {
    clearTimeout(idleTimer);
    if (!L.store.isUnlocked() || locking) return;
    lastActive = Date.now();
    idleTimer = setTimeout(function () { lockNow(); }, limitMs());
  }
  // Wall-clock check: timers can pause during device sleep or background throttling.
  function checkIdle() {
    if (L.store.isUnlocked() && !locking && lastActive && Date.now() - lastActive >= limitMs()) lockNow();
  }
  function lockNow() {
    if (locking) return locking;
    clearTimeout(idleTimer);
    // Record the lock in the audit log, but never let a slow or stuck write delay the lock itself.
    var p = L.store.isUnlocked() ? Promise.race([commit(null, 'lock').catch(function () {}), new Promise(function (r) { setTimeout(r, 1000); })]) : Promise.resolve();
    locking = p.then(function () {
      L.store.lock();
      closeDialog();
      csvPending = null; ai = null; notice = null; lastActive = 0;
      view = { name: 'lock' };
      render();
    }).then(function () { locking = null; }, function () { locking = null; });
    return locking;
  }
  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(function (ev) {
    window.addEventListener(ev, resetIdle, { capture: true, passive: true });
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) checkIdle(); });
  window.addEventListener('focus', checkIdle);
  window.addEventListener('pageshow', checkIdle);
  setInterval(checkIdle, 10000);

  // ---------- chrome ----------
  function render() {
    var root = document.getElementById('app');
    root.replaceChildren();
    noticeEl = h('div', { class: 'notice' + (notice ? ' ' + notice.kind : ''), role: 'status', 'aria-live': 'polite', text: notice ? notice.text : '' });
    if (!L.store.isUnlocked() || view.name === 'lock') { root.appendChild(lockScreen()); return; }
    var s = st();
    var body;
    try {
      body = view.name === 'domain' ? domainScreen(s)
        : view.name === 'review' ? reviewScreen(s)
        : view.name === 'memory' ? memoryScreen(s)
        : view.name === 'settings' ? settingsScreen(s)
        : dashScreen(s);
    } catch (e) { body = h('p', { text: friendly(e) }); }
    var cur = view.name === 'domain' ? 'dashboard' : view.name;
    var nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, [['dashboard', 'Home'], ['review', 'Review'], ['memory', 'Memory'], ['settings', 'Settings']].map(function (n) {
      return h('button', { type: 'button', text: n[1], 'aria-current': n[0] === cur ? 'page' : null, onclick: function () { go(n[0]); } });
    }));
    root.appendChild(h('div', { class: 'app' },
      h('header', { class: 'top' }, h('span', { class: 'brand', text: 'LifeOS' }), btn('Lock', function () { lockNow(); }, 'sm lockbtn')),
      nav,
      h('main', { class: 'main' }, noticeEl, body)));
  }

  // ---------- lock screen ----------
  function lockScreen() {
    var create = !vaultExists;
    var p1 = h('input', { type: 'password', id: 'pass', autocomplete: create ? 'new-password' : 'current-password', required: true, minlength: create ? '12' : null });
    var p2 = create ? h('input', { type: 'password', id: 'pass2', autocomplete: 'new-password', required: true, minlength: '12' }) : null;
    var form = h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var a = p1.value, b = p2 ? p2.value : '';
          if (create) {
            checkPass(a);
            if (a !== b) throw new Error('The two passphrases do not match.');
            return L.store.init(a).then(function () { vaultExists = true; return commit(null, 'create'); }).then(afterUnlock);
          }
          if (!a) throw new Error('Enter your passphrase.');
          return L.store.unlock(a).then(function () { return commit(null, 'unlock'); }).then(afterUnlock);
        }).then(function () { p1.value = ''; if (p2) p2.value = ''; });
      }
    },
      field(create ? 'Choose a passphrase (12 characters or more)' : 'Passphrase', p1),
      p2 ? field('Confirm passphrase', p2) : null,
      create ? passNote() : null,
      h('button', { type: 'submit', class: 'btn pri', text: create ? 'Create vault' : 'Unlock' }));
    return h('div', { class: 'lockwrap' },
      h('h1', { text: 'LifeOS' }),
      h('p', { class: 'mut', text: create ? 'Your private life dashboard. Everything stays on this device, encrypted.' : 'Unlock your vault.' }),
      noticeEl, form);
  }
  function afterUnlock() {
    notice = null; csvPending = null; ai = null;
    resetIdle();
    view = { name: 'dashboard' };
    render();
  }

  // ---------- dashboard ----------
  function spark(series) {
    var vals = (series || []).map(function (p) { return Number(p.value) || 0; });
    if (vals.length < 2) vals = [0, 0];
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), rng = max - min || 1;
    var W = 100, H = 28, P = 3;
    var pts = vals.map(function (v, i) {
      var x = P + (i * (W - 2 * P)) / (vals.length - 1);
      var y = max === min ? H / 2 : H - P - ((v - min) / rng) * (H - 2 * P);
      return [x.toFixed(1), y.toFixed(1)];
    });
    var last = pts[pts.length - 1];
    return h('svg', { class: 'spark', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' },
      h('polyline', { points: pts.map(function (p) { return p.join(','); }).join(' ') }),
      h('circle', { cx: last[0], cy: last[1], r: '2' }));
  }
  function dashScreen(s) {
    var t = today(), wk = L.metrics.weekStart(t);
    var tiles = L.DOMAINS.map(function (d) {
      var hl, ser;
      try { hl = L.metrics.headline(s, d.id, t); } catch (e) { hl = { label: '', display: '-', sub: '' }; }
      try { ser = L.metrics.series(s, d.id, 8); } catch (e) { ser = []; }
      return h('button', { type: 'button', class: 'tile', 'data-domain': d.id, onclick: function () { go('domain', { domain: d.id }); } },
        h('span', { class: 'tile-title', text: d.label }),
        h('span', { class: 'tile-value', text: hl.display }),
        h('span', { class: 'tile-sub', text: hl.label }),
        h('span', { class: 'tile-sub', text: hl.sub }),
        spark(ser));
    });
    var rv = s.memory.reviews.filter(function (r) { return r.weekOf === wk; })[0] || s.memory.reviews[s.memory.reviews.length - 1];
    var pr = h('div', { class: 'card' },
      h('h2', { text: rv && rv.weekOf === wk ? 'This week\'s priorities' : 'Priorities' }));
    if (rv) {
      pr.appendChild(h('ol', null, rv.priorities.map(function (p) { return h('li', { text: p }); })));
      if (rv.weekOf !== wk) pr.appendChild(h('p', { class: 'mut small', text: 'From the week of ' + rv.weekOf + '.' }));
    } else pr.appendChild(h('p', { class: 'mut', text: 'No priorities yet. Run your weekly review to set three.' }));
    if (!rv || rv.weekOf !== wk) pr.appendChild(btn('Start weekly review', function () { go('review'); }, 'pri'));
    return h('div', null, h('h1', { text: 'Dashboard' }), pr, h('div', { class: 'grid' }, tiles));
  }

  // ---------- domain ----------
  function fieldNames(t) {
    return (t.fields || []).map(function (f) { return typeof f === 'string' ? f : (f.id || f.name || f.key); });
  }
  function domainScreen(s) {
    var d = L.DOMAINS.find(function (x) { return x.id === view.domain; });
    if (!d) return h('p', { text: 'Unknown area.' });
    var tid = view.type && d.types.some(function (t) { return t.id === view.type; }) ? view.type : d.types[0].id;
    var type = d.types.filter(function (t) { return t.id === tid; })[0];
    var names = fieldNames(type);
    var skey = d.id + ':' + type.id;
    var refs = {};
    var typeSel = d.types.length > 1 ? field('Type', sel('f-type', d.types.map(function (t) { return { v: t.id, t: t.label }; }), tid, function (e) { view.type = e.target.value; render(); })) : null;
    refs.date = h('input', { type: 'date', id: 'f-date', value: today(), required: true });
    refs.title = h('input', { type: 'text', id: 'f-title', maxlength: '200', required: true });
    var fs = [typeSel, field('Date', refs.date), field('Title', refs.title)];
    if (names.indexOf('value') >= 0) {
      if (d.id === 'wellbeing') refs.value = sel('f-value', [1, 2, 3, 4, 5].map(function (n) { return { v: String(n), t: String(n) }; }), '3');
      else refs.value = h('input', { type: 'number', id: 'f-value', step: 'any', inputmode: 'decimal' });
      fs.push(field('Value', refs.value));
    }
    if (STATUS[skey] || names.indexOf('status') >= 0) {
      var so = STATUS[skey] || ['open', 'done'];
      refs.status = sel('f-status', so.map(function (x) { return { v: x, t: x }; }), so[0]);
      fs.push(field('Status', refs.status));
    }
    if (names.indexOf('person') >= 0) { refs.person = h('input', { type: 'text', id: 'f-person', maxlength: '200' }); fs.push(field('Person', refs.person)); }
    if (names.indexOf('due') >= 0) { refs.due = h('input', { type: 'date', id: 'f-due' }); fs.push(field('Due date', refs.due)); }
    refs.notes = h('textarea', { id: 'f-notes', maxlength: '2000' });
    fs.push(field('Notes (optional)', refs.notes));
    var form = h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var p = { domain: d.id, type: type.id, date: refs.date.value, title: refs.title.value.trim() };
          if (refs.value && refs.value.value !== '') p.value = Number(refs.value.value);
          if (refs.status) p.status = refs.status.value;
          if (refs.person && refs.person.value.trim()) p.person = refs.person.value.trim();
          if (refs.due && refs.due.value) p.due = refs.due.value;
          if (refs.notes.value.trim()) p.notes = refs.notes.value.trim();
          var en = L.metrics.validateEntry(p);
          en.id = en.id || L.store.newId();
          en.createdAt = en.createdAt || new Date().toISOString();
          return commit(function (x) { x.entries.push(en); }).then(function () { setNotice('ok', 'Entry added.'); render(); });
        });
      }
    }, fs, h('button', { type: 'submit', class: 'btn pri', text: 'Add entry' }));

    var list = s.entries.filter(function (x) { return x.domain === d.id; }).sort(function (a, b) {
      return b.date.localeCompare(a.date) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
    var shown = view.shown || 50;
    var tl = {}; d.types.forEach(function (t) { tl[t.id] = t.label; });
    var rows = list.slice(0, shown).map(function (en) {
      var meta = [tl[en.type] || en.type];
      if (en.value !== undefined) meta.push(String(en.value));
      if (en.status) meta.push(en.status);
      if (en.person) meta.push(en.person);
      if (en.due) meta.push('due ' + en.due);
      return h('div', { class: 'entry' },
        h('div', null, h('div', { class: 'entry-t', text: en.title }),
          h('div', { class: 'mut small', text: en.date + ' | ' + meta.join(' | ') }),
          en.notes ? h('div', { class: 'small', text: en.notes }) : null),
        btn('Delete', function () {
          openDialog({
            title: 'Delete this entry?', yes: 'Delete', danger: true,
            body: h('p', { class: 'mut', text: en.title }),
            onYes: function () { return commit(function (x) { x.entries = x.entries.filter(function (z) { return z.id !== en.id; }); }).then(function () { render(); }); }
          });
        }, 'sm bad', { 'aria-label': 'Delete ' + en.title }));
    });
    var out = h('div', null,
      btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'),
      h('h1', { text: d.label }),
      h('div', { class: 'card' }, h('h2', { text: 'Add entry' }), form),
      h('h2', { text: 'Entries (' + list.length + ')' }),
      h('div', { class: 'card' }, rows.length ? rows : h('p', { class: 'mut', text: 'Nothing here yet.' })),
      list.length > shown ? btn('Show more', function () { view.shown = shown + 50; render(); }) : null,
      h('h2', { text: 'CSV' }),
      csvCard(d, s, list));
    return out;
  }
  function csvCard(d, s, list) {
    var card = h('div', { class: 'card' });
    var fileIn = h('input', { type: 'file', id: 'csv-file', accept: '.csv,text/csv' });
    fileIn.addEventListener('change', function () {
      var f = fileIn.files && fileIn.files[0];
      if (!f) return;
      act(function () {
        return readFile(f).then(function (text) {
          if (!L.store.isUnlocked()) return;
          var parsed = L.csv.parse(text);
          csvPending = { parsed: parsed, domain: d.id };
          render();
        });
      });
    });
    card.appendChild(field('Import a CSV file (5 MB max)', fileIn));
    if (csvPending && csvPending.domain === d.id) {
      var hd = csvPending.parsed.headers;
      var tid = csvPending.type || d.types[0].id;
      var type = d.types.filter(function (t) { return t.id === tid; })[0];
      var names = fieldNames(type);
      var opts = [{ v: '', t: '(none)' }].concat(hd.map(function (x, i) { return { v: String(i), t: x || ('Column ' + (i + 1)) }; }));
      var guess = function (re) { var i = hd.findIndex(function (x) { return re.test(x); }); return i >= 0 ? String(i) : ''; };
      var m = {
        date: sel('m-date', opts, guess(/date/i)),
        title: sel('m-title', opts, guess(/title|name|desc|memo|payee/i)),
        notes: sel('m-notes', opts, guess(/note/i))
      };
      var extra = { value: [/value|amount|total|hours/i, 'Value column'], person: [/person|contact|who/i, 'Person column'], due: [/due/i, 'Due date column'], status: [/status|state/i, 'Status column'] };
      var extraOrder = ['value', 'person', 'due', 'status'].filter(function (k) { return names.indexOf(k) >= 0; });
      extraOrder.forEach(function (k) { m[k] = sel('m-' + k, opts, guess(extra[k][0])); });
      card.appendChild(h('p', { class: 'mut small', text: hd.length + ' columns, ' + csvPending.parsed.rows.length + ' rows.' }));
      if (d.types.length > 1) card.appendChild(field('Import as', sel('m-type', d.types.map(function (t) { return { v: t.id, t: t.label }; }), tid, function (e) { csvPending.type = e.target.value; render(); })));
      card.appendChild(field('Date column', m.date));
      card.appendChild(field('Title column', m.title));
      extraOrder.forEach(function (k) { card.appendChild(field(extra[k][1], m[k])); });
      card.appendChild(field('Notes column', m.notes));
      card.appendChild(h('div', { class: 'row' },
        btn('Import rows', function () {
          act(function () {
            var map = {};
            ['date', 'title', 'notes'].concat(extraOrder).forEach(function (k) {
              if (m[k] && m[k].value !== '') map[k] = Number(m[k].value);
            });
            if (map.date === undefined || map.title === undefined) throw new Error('Choose the date and title columns.');
            var r = L.csv.toEntries(csvPending.parsed, { domain: d.id, type: tid, map: map });
            var now = new Date().toISOString();
            var ens = r.entries.map(function (en) { en.id = en.id || L.store.newId(); en.createdAt = en.createdAt || now; return en; });
            return commit(function (x) { ens.forEach(function (en) { x.entries.push(en); }); }, 'import').then(function () {
              csvPending = null;
              setNotice('ok', 'Imported ' + ens.length + ' rows. Rejected ' + r.rejected + '.');
              render();
            });
          });
        }, 'pri'),
        btn('Cancel', function () { csvPending = null; render(); })));
    }
    card.appendChild(h('div', { class: 'row' }, btn('Export CSV', function () {
      act(function () {
        if (!list.length) throw new Error('No entries to export.');
        download('lifeos-' + d.id + '.csv', L.csv.exportEntries(list), 'text/csv');
        return commit(null, 'export');
      }, 'CSV exported.');
    })));
    return card;
  }

  // ---------- insights and AI ----------
  function insightCard(i, withActions) {
    var kids = [
      h('div', { class: 'row' },
        h('span', { class: 'chip', text: domainLabel(i.domain) }),
        h('span', { class: 'chip', text: 'Level ' + i.level }),
        h('span', { class: 'chip', text: i.source === 'ai' ? 'AI' : 'Rules' }),
        i.status !== 'proposed' ? h('span', { class: 'chip ' + (i.status === 'approved' ? 'ok' : 'bad'), text: i.status }) : null),
      h('p', { text: i.text })
    ];
    if (withActions && i.status === 'proposed') {
      kids.push(h('div', { class: 'row' },
        btn('Approve', function () {
          act(function () { return commit(function (x) { L.memory.decide(x, i.id, 'approved'); }).then(render); });
        }, 'pri sm'),
        btn('Reject', function () { rejectDialog(i); }, 'sm')));
    }
    return h('div', { class: 'card' }, kids);
  }
  function rejectDialog(i) {
    var why = h('input', { type: 'text', id: 'reject-reason', maxlength: '200' });
    openDialog({
      title: 'Reject this insight', yes: 'Reject',
      body: [h('p', { class: 'mut', text: i.text }), field('Why? (optional, helps future suggestions)', why)],
      onYes: function () {
        var r = why.value.trim().slice(0, 200);
        return commit(function (x) { L.memory.decide(x, i.id, 'rejected', r || undefined); }).then(function () { render(); });
      }
    });
  }
  function runPropose(items, level, period, source) {
    return commit(function (x) { L.memory.propose(x, items, { level: level, period: period, source: source }); });
  }
  function suggestAI(level, period) {
    return act(function () {
      var s = st();
      var kind = s.settings.provider.kind;
      var pr = L.memory.buildPrompt(s, level, period);
      if (kind === 'none' || kind === 'manual') {
        ai = { level: level, period: period, prompt: pr.system + '\n\n' + pr.user };
        render();
        return;
      }
      return L.ai.complete(s.settings.provider, pr).then(function (text) {
        return runPropose(L.memory.parseResponse(text), level, period, 'ai');
      }).then(function () { setNotice('ok', 'Suggestions added for your review.'); render(); }, function (e) {
        if (e && e.message === 'MANUAL') { ai = { level: level, period: period, prompt: pr.system + '\n\n' + pr.user }; render(); return; }
        throw e;
      });
    });
  }
  function aiPanel(level, period, label) {
    var kind = st().settings.provider.kind;
    var box = h('div', null,
      h('div', { class: 'row' }, btn(label, function () { suggestAI(level, period); }, 'sm', { id: 'ai-suggest' })),
      h('p', { class: 'mut small', text: kind === 'anthropic' ? 'Sends only the numeric digest, approved insights and lessons to api.anthropic.com.' : kind === 'local' ? 'Sends only the numeric digest, approved insights and lessons to your local model.' : 'Manual mode: copy the prompt into your own AI chat and paste the reply here.' }));
    if (ai && ai.level === level && ai.period.from === period.from) {
      var ta = h('textarea', { id: 'ai-prompt', readOnly: true, value: ai.prompt, 'aria-label': 'Prompt to copy' });
      var paste = h('textarea', { id: 'ai-paste', 'aria-label': 'Paste the AI reply here', maxlength: '20000' });
      box.appendChild(h('div', { class: 'card' },
        h('p', { class: 'small', text: 'The prompt has numbers only, no entries, titles or names.' }),
        ta,
        h('div', { class: 'row' }, btn('Copy', function () { copyText(ta).then(function () { setNotice('ok', 'Copied.'); }, function (e) { setNotice('err', friendly(e)); }); }, 'sm')),
        field('Paste the reply (a JSON list)', paste),
        h('div', { class: 'row' },
          btn('Add suggestions', function () {
            act(function () {
              var items = L.memory.parseResponse(paste.value);
              return runPropose(items, level, period, 'ai').then(function () { ai = null; setNotice('ok', 'Suggestions added for your review.'); render(); });
            });
          }, 'pri sm'),
          btn('Close', function () { ai = null; render(); }, 'sm'))));
    }
    return box;
  }

  // ---------- weekly review ----------
  function reviewScreen(s) {
    var t = today(), wk = L.metrics.weekStart(t);
    var period = { from: wk, to: addDays(wk, 6) };
    var dg = L.metrics.weeklyDigest(s, wk);
    var rows = L.DOMAINS.map(function (d) {
      var x = (dg.domains && dg.domains[d.id]) || { now: 0, prev: 0, unit: '' };
      var dl = Math.round((x.now - x.prev) * 100) / 100;
      return h('tr', null, h('td', { text: d.label }), h('td', { text: String(Math.round(x.now * 100) / 100) + ' ' + x.unit }),
        h('td', { text: String(Math.round(x.prev * 100) / 100) }), h('td', { text: (dl > 0 ? '+' : '') + dl }));
    });
    var mine = s.memory.insights.filter(function (i) { return i.level === 1 && i.period && i.period.from === wk; });
    var haveRules = mine.some(function (i) { return i.source === 'rules'; });
    var rv = s.memory.reviews.filter(function (r) { return r.weekOf === wk; })[0];
    var pri = [0, 1, 2].map(function (n) {
      return h('input', { type: 'text', maxlength: '200', id: 'prio' + (n + 1), value: rv ? rv.priorities[n] : '', required: true });
    });
    return h('div', null, h('h1', { text: 'Weekly review' }),
      h('p', { class: 'mut', text: 'Week of ' + wk }),
      h('h2', { text: '1. This week vs last week' }),
      h('div', { class: 'card' }, h('table', null, h('thead', null, h('tr', null, ['Area', 'This week', 'Last week', 'Change'].map(function (x) { return h('th', { text: x }); }))), h('tbody', null, rows))),
      h('h2', { text: '2. Insights' }),
      h('div', { class: 'row' },
        btn(haveRules ? 'Rules suggestions added' : 'Run rules suggestions', function () {
          act(function () {
            var items = L.memory.rulesInsights(st(), wk);
            if (!items.length) throw new Error('No rule-based suggestions this week.');
            return runPropose(items, 1, period, 'rules').then(render);
          });
        }, 'pri sm', { id: 'rules-run', disabled: haveRules })),
      aiPanel(1, period, 'Suggest with AI'),
      mine.length ? mine.map(function (i) { return insightCard(i, true); }) : h('p', { class: 'mut', text: 'No insights yet this week.' }),
      h('h2', { text: '3. Your three priorities' }),
      h('form', {
        class: 'card',
        onsubmit: function (e) {
          e.preventDefault();
          act(function () {
            var ps = pri.map(function (p) { return p.value.trim(); });
            if (ps.some(function (p) { return !p; })) throw new Error('Enter all three priorities.');
            var digest = L.metrics.weeklyDigest(st(), wk);
            return commit(function (x) {
              x.memory.reviews = x.memory.reviews.filter(function (r) { return r.weekOf !== wk; });
              x.memory.reviews.push({ id: L.store.newId(), weekOf: wk, digest: digest, priorities: ps, completedAt: new Date().toISOString() });
            }).then(function () { go('dashboard'); setNotice('ok', 'Review finished.'); });
          });
        }
      }, pri.map(function (p, n) { return field('Priority ' + (n + 1), p); }),
        h('button', { type: 'submit', class: 'btn pri', id: 'finish-review', text: 'Finish review' })));
  }

  // ---------- memory ----------
  function memoryScreen(s) {
    var t = today(), mp = monthPeriod(t), qp = quarterPeriod(t);
    var out = [h('h1', { text: 'Memory' }),
      h('p', { class: 'mut', text: 'Only insights you approve are kept and used. Nothing is approved automatically.' }),
      h('h2', { text: 'Consolidate' }),
      aiPanel(2, mp, 'Consolidate month'),
      aiPanel(3, qp, 'Consolidate quarter')];
    var prop = s.memory.insights.filter(function (i) { return i.status === 'proposed' && i.level > 1; });
    if (prop.length) { out.push(h('h2', { text: 'Waiting for your decision' })); prop.forEach(function (i) { out.push(insightCard(i, true)); }); }
    [1, 2, 3].forEach(function (lv) {
      var a = L.memory.approved(s, lv);
      out.push(h('h2', { text: ['Weekly', 'Monthly', 'Quarterly'][lv - 1] + ' insights (' + a.length + ')' }));
      if (!a.length) out.push(h('p', { class: 'mut', text: 'None yet.' }));
      a.forEach(function (i) { out.push(insightCard(i, false)); });
    });
    out.push(h('h2', { text: 'Lessons from rejections (' + s.memory.lessons.length + ')' }));
    if (!s.memory.lessons.length) out.push(h('p', { class: 'mut', text: 'None yet.' }));
    out.push(h('div', null, s.memory.lessons.map(function (l) { return h('div', { class: 'card' }, h('p', { text: l.text })); })));
    return h('div', null, out);
  }

  // ---------- settings ----------
  var passOnly = function (id, auto) { return h('input', { type: 'password', id: id, autocomplete: auto || 'off', minlength: '12' }); };
  function settingsScreen(s) {
    var set = s.settings, pv = set.provider;
    var kind = view.kind || pv.kind;
    var out = [h('h1', { text: 'Settings' })];

    // provider
    var base = h('input', { type: 'text', id: 'p-base', value: pv.baseUrl || 'http://localhost:11434/v1', autocomplete: 'off' });
    var urlShow = h('p', { class: 'mut small', id: 'p-url' });
    var showUrl = function () {
      try { urlShow.textContent = 'Requests will be sent to: ' + L.ai.validateProvider({ kind: 'local', baseUrl: base.value.trim(), model: 'x' }).baseUrl + '/chat/completions'; }
      catch (e) { urlShow.textContent = 'This URL is not allowed. Use http://localhost:PORT/v1 or http://127.0.0.1:PORT/v1 with a port from 1024 to 65535.'; }
    };
    base.addEventListener('input', showUrl);
    showUrl();
    var model = h('input', { type: 'text', id: 'p-model', value: pv.model || '', autocomplete: 'off', maxlength: '100' });
    var key = h('input', { type: 'password', id: 'p-key', autocomplete: 'off', placeholder: pv.apiKey ? 'Leave blank to keep the saved key' : 'Paste API key' });
    var provCard = h('form', {
      class: 'card',
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var p = { kind: kind, baseUrl: kind === 'local' ? base.value.trim() : '', model: (kind === 'anthropic' || kind === 'local') ? model.value.trim() : '', apiKey: kind === 'anthropic' ? (key.value.trim() || pv.apiKey || '') : '' };
          p = L.ai.validateProvider(p);
          return commit(function (x) { x.settings.provider = p; }, 'provider change').then(function () { key.value = ''; view.kind = null; setNotice('ok', 'Provider saved.'); render(); });
        });
      }
    },
      h('h2', { text: 'AI provider' }),
      field('Mode', sel('p-kind', [{ v: 'none', t: 'None (rules only)' }, { v: 'manual', t: 'Manual copy and paste' }, { v: 'anthropic', t: 'Anthropic API' }, { v: 'local', t: 'Local model (OpenAI compatible)' }], kind, function (e) { view.kind = e.target.value; render(); })),
      kind === 'anthropic' ? [field('Model', model), field('API key', key, pv.apiKey ? 'Saved key ends in ' + pv.apiKey.slice(-4) : 'No key saved'),
        h('p', { class: 'mut small', text: 'The key is stored only inside your encrypted vault. Requests go straight from this page to api.anthropic.com.' })] : null,
      kind === 'local' ? [field('Base URL (localhost only)', base), urlShow, field('Model', model)] : null,
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn pri', text: 'Save provider' }),
        pv.apiKey ? btn('Remove saved key', function () {
          act(function () { return commit(function (x) { x.settings.provider.apiKey = ''; }, 'provider change').then(function () { setNotice('ok', 'Key removed.'); render(); }); });
        }) : null));
    out.push(provCard);

    // targets
    var tg = set.targets;
    var wpw = h('input', { type: 'number', id: 't-wpw', min: '0', max: '21', step: '1', value: tg.workoutsPerWeek });
    var cd = h('input', { type: 'number', id: 't-cd', min: '1', max: '365', step: '1', value: tg.contactDays });
    var sr = h('input', { type: 'number', id: 't-sr', min: '0', max: '100', step: '1', value: Math.round(tg.savingsRate * 100) });
    var cur = h('input', { type: 'text', id: 't-cur', maxlength: '3', value: set.currency });
    var al = sel('t-al', [1, 5, 15, 30, 60].map(function (n) { return { v: String(n), t: n + ' min' }; }), String(set.autoLockMin));
    out.push(h('form', {
      class: 'card',
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var w = parseInt(wpw.value, 10), c = parseInt(cd.value, 10), r = Number(sr.value), cu = cur.value.trim().toUpperCase();
          if (!(w >= 0 && w <= 21)) throw new Error('Workouts per week must be 0 to 21.');
          if (!(c >= 1 && c <= 365)) throw new Error('Contact days must be 1 to 365.');
          if (!(r >= 0 && r <= 100)) throw new Error('Savings rate must be 0 to 100.');
          if (!/^[A-Z]{3}$/.test(cu)) throw new Error('Currency must be a three letter code.');
          var m = Number(al.value);
          return commit(function (x) { x.settings.targets = { workoutsPerWeek: w, contactDays: c, savingsRate: r / 100 }; x.settings.currency = cu; x.settings.autoLockMin = m; }).then(function () { resetIdle(); setNotice('ok', 'Settings saved.'); });
        });
      }
    }, h('h2', { text: 'Targets and preferences' }), field('Workouts per week', wpw), field('Days between contacts', cd), field('Savings rate target (%)', sr), field('Currency code', cur), field('Auto-lock after idle', al),
      h('button', { type: 'submit', class: 'btn pri', text: 'Save settings' })));

    // passphrase
    var o = passOnly('pp-old', 'current-password'), n1 = passOnly('pp-new', 'new-password'), n2 = passOnly('pp-new2', 'new-password');
    out.push(h('form', {
      class: 'card',
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          checkPass(n1.value);
          if (n1.value !== n2.value) throw new Error('The new passphrases do not match.');
          return L.store.changePassphrase(o.value, n1.value).then(function () { return commit(null, 'passphrase change'); }).then(function () { setNotice('ok', 'Passphrase changed.'); });
        }).then(function () { o.value = ''; n1.value = ''; n2.value = ''; });
      }
    }, h('h2', { text: 'Change passphrase' }), field('Current passphrase', o), field('New passphrase (12 characters or more)', n1), field('Confirm new passphrase', n2), passNote(),
      h('button', { type: 'submit', class: 'btn', text: 'Change passphrase' })));

    // backup
    var bp = passOnly('bk-pass', 'new-password'), bp2 = passOnly('bk-pass2', 'new-password');
    var bf = h('input', { type: 'file', id: 'bk-file', accept: '.json,application/json' });
    var ip = passOnly('bk-ipass', 'current-password');
    out.push(h('div', { class: 'card' }, h('h2', { text: 'Encrypted backup' }),
      h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          act(function () {
            checkPass(bp.value);
            if (bp.value !== bp2.value) throw new Error('The backup passphrases do not match.');
            return L.vault.exportBackup(bp.value, st()).then(function (text) {
              download('lifeos-backup-' + today() + '.json', text, 'application/json');
              return commit(null, 'export');
            }).then(function () { setNotice('ok', 'Backup downloaded.'); });
          }).then(function () { bp.value = ''; bp2.value = ''; });
        }
      }, field('Backup passphrase (12 characters or more)', bp), field('Confirm backup passphrase', bp2), passNote(),
        h('button', { type: 'submit', class: 'btn', text: 'Export backup' })),
      h('hr'),
      h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          var f = bf.files && bf.files[0];
          if (!f) { setNotice('err', 'Choose a backup file first.'); return; }
          if (f.size > L.vault.MAX_BACKUP) { setNotice('err', 'That file is larger than 64 MB.'); return; }
          if (!ip.value) { setNotice('err', 'Enter the backup passphrase.'); return; }
          act(function () {
            return readFile(f, L.vault.MAX_BACKUP).then(function (text) { return L.vault.importBackup(ip.value, text); }).then(function (state) {
              ip.value = '';
              if (!L.store.isUnlocked()) return;
              var ins = state.memory.insights, pv2 = state.settings.provider;
              var nAppr = ins.filter(function (i) { return i.status === 'approved'; }).length;
              var rr = h('input', { type: 'checkbox', id: 'bk-rereview', checked: true });
              openDialog({
                title: 'Replace all data with this backup?', yes: 'Replace', danger: true,
                body: [
                  h('ul', { class: 'small', id: 'bk-summary' },
                    h('li', { text: 'Entries: ' + state.entries.length }),
                    h('li', { text: 'Approved insights: ' + nAppr }),
                    h('li', { text: 'Lessons: ' + state.memory.lessons.length }),
                    h('li', { text: 'Provider settings: ' + (pv2.kind === 'none' ? 'none' : 'included (' + pv2.kind + ')') }),
                    h('li', { text: 'API key: ' + (pv2.apiKey ? 'included' : 'not included') })),
                  h('label', { class: 'row small' }, rr, h('span', { text: 'Re-review insights (restore every approved insight as proposed)' })),
                  h('p', { class: 'mut', text: 'This replaces everything in this vault with the backup. It cannot be undone.' })],
                onYes: function () {
                  var next = rr.checked ? L.memory.demoteApproved(state) : state;
                  return L.store.replaceState(next).then(function () { return commit(null, 'import'); }).then(function () { setNotice('ok', 'Backup restored.'); render(); });
                }
              });
            });
          });
        }
      }, field('Restore from a backup file (64 MB max)', bf), field('Backup passphrase', ip),
        h('button', { type: 'submit', class: 'btn', text: 'Import backup' }))));

    out.push(h('p', { class: 'mut small', id: 'app-version', text: 'LifeOS v0.2.0' }));

    // session
    var typed = h('input', { type: 'text', id: 'wipe-confirm', autocomplete: 'off' });
    out.push(h('div', { class: 'card' }, h('h2', { text: 'Session and data' }),
      h('div', { class: 'row' },
        btn('Lock now', function () { lockNow(); }, 'lockbtn'),
        btn('Wipe all data', function () {
          openDialog({
            title: 'Wipe all data?', yes: 'Wipe everything', danger: true,
            body: [h('p', { class: 'mut', text: 'This permanently deletes the vault from this device. Type WIPE to confirm.' }), field('Confirmation', typed)],
            onYes: function () {
              if (typed.value !== 'WIPE') throw new Error('Type WIPE exactly to continue.');
              return commit(null, 'wipe').catch(function () {}).then(function () { return L.store.wipe(); }).then(function () {
                try { L.store.lock(); } catch (e) { /* already locked */ }
                clearTimeout(idleTimer);
                vaultExists = false; view = { name: 'lock' }; notice = { kind: 'ok', text: 'All data wiped.' };
                setTimeout(render, 0);
              });
            }
          });
        }, 'bad', { id: 'wipe-btn' }))));

    // audit
    var au = (s.audit || []).slice(-10).reverse();
    out.push(h('div', { class: 'card' }, h('h2', { text: 'Recent activity' }),
      au.length ? au.map(function (a) { return h('div', { class: 'small mut', text: a.ts.replace('T', ' ').slice(0, 19) + ' ' + a.action }); }) : h('p', { class: 'mut', text: 'Nothing yet.' })));
    return h('div', null, out);
  }

  // ---------- boot ----------
  function boot() {
    var p = Promise.resolve();
    if (!globalThis.crypto || !globalThis.crypto.subtle) notice = { kind: 'err', text: 'This browser does not support the required encryption features.' };
    else p = L.store.exists().then(function (x) { vaultExists = !!x; }, function () { notice = { kind: 'err', text: 'Storage is unavailable in this browser.' }; });
    p.then(function () { view = { name: 'lock' }; render(); });
  }
  boot();
})();
