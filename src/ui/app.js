(function () {
  'use strict';
  var L = globalThis.LifeOS;
  var MAX_FILE = 5 * 1024 * 1024;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var SVGTAGS = { svg: 1, polyline: 1, circle: 1, line: 1, path: 1, rect: 1, text: 1, g: 1 };
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
    // The Google token lives only in memory and must not outlive the unlocked session.
    if (L.sync) L.sync.disconnect();
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
      body = view.name === 'domain' ? (view.domain === 'money' ? moneyScreen(s) : view.domain === 'assets' ? assetsScreen(s) : view.domain === 'work' ? workScreen(s) : view.domain === 'health' ? healthScreen(s) : view.domain === 'goals' ? goalsScreen(s) : view.domain === 'home' ? homeScreen(s) : view.domain === 'admin' ? adminScreen(s) : view.domain === 'learning' ? learningScreen(s) : view.domain === 'activities' ? activitiesScreen(s) : domainScreen(s))
        : view.name === 'review' ? reviewScreen(s)
        : view.name === 'memory' ? memoryScreen(s)
        : view.name === 'settings' ? settingsScreen(s)
        : dashScreen(s);
    } catch (e) { body = h('p', { text: friendly(e) }); }
    var cur = view.name === 'domain' ? (view.domain === 'money' || view.domain === 'assets' || view.domain === 'work' || view.domain === 'health' ? view.domain : 'dashboard') : view.name;
    var nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, [['dashboard', 'Home'], ['money', 'Money'], ['assets', 'Assets'], ['work', 'Work'], ['health', 'Health'], ['review', 'Review'], ['memory', 'Memory'], ['settings', 'Settings']].map(function (n) {
      return h('button', { type: 'button', text: n[1], 'aria-current': n[0] === cur ? 'page' : null, onclick: function () { if (n[0] === 'money' || n[0] === 'assets' || n[0] === 'work' || n[0] === 'health') go('domain', { domain: n[0] }); else go(n[0]); } });
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
  function syncCtx() {
    return { h: h, field: field, btn: btn, openDialog: openDialog, commit: commit, download: download, setNotice: setNotice, render: render };
  }
  function afterUnlock() {
    notice = null; csvPending = null; ai = null;
    resetIdle();
    view = { name: 'dashboard' };
    render();
    if (L.syncUI) L.syncUI.afterUnlock(syncCtx());
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
      try { ser = L.metrics.series(s, d.id, 8, t); } catch (e) { ser = []; }
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
    var due = L.metrics.dueRecurring(s, t).length;
    return h('div', null, h('div', { class: 'row sp' }, h('h1', { text: 'Dashboard' }), h('div', { class: 'row' }, btn('Log study', function () { studyDialog(''); }, 'qa-btn', { id: 'quick-study' }), btn('Add activity', function () { go('domain', { domain: 'activities', open: 'act-add' }); }, 'qa-btn', { id: 'quick-activity' }), btn('Quick add', quickAdd, 'pri qa-btn', { id: 'quick-add' }))),
      due ? h('div', { class: 'warn' }, due + (due === 1 ? ' recurring item is' : ' recurring items are') + ' due. ', btn('Review', function () { go('domain', { domain: 'money' }); }, 'sm', { id: 'due-review' })) : null,
      glanceCard(s, t, 'dash-glance'), pr, h('div', { class: 'grid' }, tiles));
  }

  // ---------- domain ----------
  function fieldNames(t) {
    return (t.fields || []).map(function (f) { return typeof f === 'string' ? f : (f.id || f.name || f.key); });
  }
  function domainScreen(s, opts) {
    opts = opts || {};
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
    if (d.id === 'money') {
      refs.category = h('select', { id: 'f-cat' }, [h('option', { value: '', text: '(none)' })].concat(catList(s, tid).map(function (c) { return h('option', { value: c, text: c }); })));
      fs.push(field('Category (optional)', refs.category));
    }
    if (STATUS[skey] || names.indexOf('status') >= 0) {
      var so = STATUS[skey] || ['open', 'done'];
      refs.status = sel('f-status', so.map(function (x) { return { v: x, t: x }; }), so[0]);
      fs.push(field('Status', refs.status));
    }
    if (names.indexOf('person') >= 0) { refs.person = h('input', { type: 'text', id: 'f-person', maxlength: '200' }); fs.push(field('Person', refs.person)); }
    if (names.indexOf('due') >= 0) { refs.due = h('input', { type: 'date', id: 'f-due' }); fs.push(field('Due date', refs.due)); }
    if (names.indexOf('kind') >= 0) { refs.kind = sel('f-kind', [{ v: '', t: '(none)' }].concat((s.kinds || []).map(function (k) { return { v: k, t: k }; })), ''); fs.push(field('Type (optional)', refs.kind)); }
    if (names.indexOf('minutes') >= 0) { refs.minutes = h('input', { type: 'number', id: 'f-minutes', min: '0', max: '1440', step: '1', inputmode: 'numeric' }); fs.push(field('Minutes (optional)', refs.minutes)); }
    if (names.indexOf('effort') >= 0) { refs.effort = sel('f-effort', [{ v: '', t: '(none)' }].concat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (n) { return { v: String(n), t: String(n) }; })), ''); fs.push(field('Effort 1 to 10 (optional)', refs.effort)); }
    refs.notes = h('textarea', { id: 'f-notes', maxlength: '2000' });
    fs.push(field('Notes (optional)', refs.notes));
    var form = h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var p = { domain: d.id, type: type.id, date: refs.date.value, title: refs.title.value.trim() };
          if (refs.value && refs.value.value !== '') p.value = Number(refs.value.value);
          if (refs.status) p.status = refs.status.value;
          if (refs.category && refs.category.value) p.category = refs.category.value;
          if (refs.person && refs.person.value.trim()) p.person = refs.person.value.trim();
          if (refs.due && refs.due.value) p.due = refs.due.value;
          if (refs.kind && refs.kind.value) p.kind = refs.kind.value;
          if (refs.minutes && refs.minutes.value !== '') p.minutes = Number(refs.minutes.value);
          if (refs.effort && refs.effort.value) p.effort = Number(refs.effort.value);
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
      if (en.value !== undefined) meta.push(en.type === 'weight' ? fmt1(en.value) : String(en.value));
      if (en.category) meta.push(en.category);
      if (en.status) meta.push(en.status);
      if (en.person) meta.push(en.person);
      if (en.due) meta.push('due ' + en.due);
      if (en.kind) meta.push(en.kind);
      if (en.minutes !== undefined) meta.push(en.minutes + ' min');
      if (en.effort !== undefined) meta.push('effort ' + en.effort);
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
      opts.embed ? null : btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'),
      opts.embed ? null : h('h1', { text: d.label }),
      opts.noForm ? null : h('div', { class: 'card' }, h('h2', { text: 'Add entry' }), form),
      d.id === 'social' && !opts.embed ? socialFromActivities(s, today()) : null,
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
      var extra = { value: [/value|amount|total|hours/i, 'Value column'], person: [/person|contact|who/i, 'Person column'], due: [/due/i, 'Due date column'], status: [/status|state/i, 'Status column'],
        kind: [/kind|type|exercise|activity/i, 'Workout type column'], minutes: [/minute|min|duration/i, 'Minutes column'], effort: [/effort|rpe|intensity/i, 'Effort column'] };
      var extraOrder = ['value', 'person', 'due', 'status', 'kind', 'minutes', 'effort'].filter(function (k) { return names.indexOf(k) >= 0; });
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

  // ---------- money and assets ----------
  var KIND_LABEL = { cash: 'Cash', investment: 'Investment', retirement: 'Retirement', property: 'Property', vehicle: 'Vehicle', other: 'Other', credit: 'Credit card', loan: 'Loan', mortgage: 'Mortgage' };
  function moneyFmt(c, cur) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(c / 100); }
    catch (e) { return (c / 100).toFixed(2); }
  }
  function pctFmt(r) { return r === null ? 'n/a' : (Math.round(r * 1000) / 10) + '%'; }
  function parseAmount(v, o) {
    o = o || {};
    var t = String(v == null ? '' : v).trim().replace(/^\$/, '');
    if (!(o.neg ? /^-?\d{1,10}(\.\d{1,2})?$/ : /^\d{1,10}(\.\d{1,2})?$/).test(t)) throw new Error('Enter an amount like 12.50.');
    var n = Number(t);
    if (!o.zero && n <= 0) throw new Error('The amount must be more than zero.');
    return n;
  }
  function monthLabel(m) {
    var names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return names[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4);
  }
  function catList(s, type) { return (s.categories && s.categories[type]) || L.metrics.DEFAULT_CATEGORIES[type]; }
  function stat(label, text, id, cls) {
    return h('div', { class: 'stat' }, h('span', { class: 'lbl', text: label }), h('span', { class: 'stat-v' + (cls ? ' ' + cls : ''), id: id, text: text }));
  }
  function addEntry(p) {
    var en = L.metrics.validateEntry(p);
    en.id = en.id || L.store.newId();
    en.createdAt = en.createdAt || new Date().toISOString();
    return commit(function (x) { x.entries.push(en); }, 'entry add');
  }

  // Quick add: amount, category chips, date, on a single screen opened from the dashboard.
  function quickAdd() {
    var s = st(), type = 'expense', cat = '';
    var amount = h('input', { type: 'text', id: 'qa-amount', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', maxlength: '14', 'aria-label': 'Amount' });
    var dateIn = h('input', { type: 'date', id: 'qa-date', value: today(), required: true, 'aria-label': 'Date' });
    var note = h('input', { type: 'text', id: 'qa-note', maxlength: '200', autocomplete: 'off', 'aria-label': 'Note (optional)' });
    var chips = h('div', { class: 'chips', id: 'qa-chips', role: 'group', 'aria-label': 'Category' });
    var tEx = btn('Expense', function () { setType('expense'); }, 'seg', { id: 'qa-expense' });
    var tIn = btn('Income', function () { setType('income'); }, 'seg', { id: 'qa-income' });
    function paint() {
      tEx.setAttribute('aria-pressed', type === 'expense' ? 'true' : 'false');
      tIn.setAttribute('aria-pressed', type === 'income' ? 'true' : 'false');
      chips.replaceChildren.apply(chips, catList(s, type).map(function (c) {
        return h('button', { type: 'button', class: 'chipbtn', 'aria-pressed': c === cat ? 'true' : 'false', text: c, onclick: function () { cat = cat === c ? '' : c; paint(); } });
      }));
    }
    function setType(t) { type = t; cat = ''; paint(); }
    paint();
    openDialog({
      title: 'Quick add', yes: 'Save',
      body: [h('div', { class: 'row' }, tEx, tIn), field('Amount', amount), h('span', { class: 'lbl', text: 'Category' }), chips, field('Date', dateIn), field('Note (optional)', note)],
      onYes: function () {
        var v = parseAmount(amount.value);
        var title = note.value.trim() || cat || (type === 'income' ? 'Income' : 'Expense');
        var p = { domain: 'money', type: type, date: dateIn.value, title: title, value: v };
        if (cat) p.category = cat;
        return addEntry(p).then(function () { setNotice('ok', (type === 'income' ? 'Income' : 'Expense') + ' saved.'); render(); });
      }
    });
  }

  function svgBar(pct, cls) {
    return h('svg', { class: 'bar', viewBox: '0 0 100 6', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' },
      h('rect', { class: 'bar-bg', x: '0', y: '0', width: '100', height: '6', rx: '3' }),
      h('rect', { class: cls, x: '0', y: '0', width: String(Math.max(0, Math.min(100, pct))), height: '6', rx: '3' }));
  }
  function cashflowChart(rows, cur) {
    var W = 360, H = 150, base = 118, top = 12, max = 1;
    rows.forEach(function (r) { max = Math.max(max, r.incomeCents, r.spendCents); });
    var step = (W - 20) / rows.length, bw = Math.min(22, step / 2 - 3);
    var kids = [h('line', { class: 'axis', x1: '8', y1: String(base), x2: String(W - 8), y2: String(base) })];
    rows.forEach(function (r, i) {
      var x = 10 + i * step + step / 2 - bw - 1;
      var hi = Math.round((r.incomeCents / max) * (base - top)), hs = Math.round((r.spendCents / max) * (base - top));
      kids.push(h('rect', { class: 'bar-in', x: String(x), y: String(base - hi), width: String(bw), height: String(hi) }));
      kids.push(h('rect', { class: 'bar-out', x: String(x + bw + 2), y: String(base - hs), width: String(bw), height: String(hs) }));
      kids.push(h('text', { class: 'tick', x: String(x + bw + 1), y: '136', 'text-anchor': 'middle', text: monthLabel(r.month).slice(0, 3) }));
    });
    return h('svg', { class: 'chart', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Income and spending for the last ' + rows.length + ' months' }, kids);
  }
  function netWorthChart(hist) {
    var W = 360, H = 150, L0 = 8, R0 = 8, T0 = 14, B0 = 122;
    var min = 0, max = 1;
    hist.forEach(function (p) { min = Math.min(min, p.totalCents, p.assetsCents); max = Math.max(max, p.totalCents, p.assetsCents, p.liabilitiesCents); });
    var rng = max - min || 1;
    var X = function (i) { return L0 + (hist.length < 2 ? 0 : (i * (W - L0 - R0)) / (hist.length - 1)); };
    var Y = function (c) { return T0 + (1 - (c - min) / rng) * (B0 - T0); };
    var line = function (key, cls) {
      return h('polyline', { class: cls, points: hist.map(function (p, i) { return X(i).toFixed(1) + ',' + Y(p[key]).toFixed(1); }).join(' ') });
    };
    var last = hist[hist.length - 1];
    return h('svg', { class: 'chart', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Net worth, assets and liabilities by month' },
      h('line', { class: 'axis', x1: String(L0), y1: String(Y(0).toFixed(1)), x2: String(W - R0), y2: String(Y(0).toFixed(1)) }),
      line('assetsCents', 'ln-assets'), line('liabilitiesCents', 'ln-liab'), line('totalCents', 'ln-net'),
      h('circle', { class: 'dot-net', cx: String(X(hist.length - 1).toFixed(1)), cy: String(Y(last.totalCents).toFixed(1)), r: '3.5' }),
      h('text', { class: 'tick', x: String(L0), y: '142', 'text-anchor': 'start', text: monthLabel(hist[0].month) }),
      h('text', { class: 'tick', x: String(W - R0), y: '142', 'text-anchor': 'end', text: monthLabel(last.month) }));
  }
  function details(id, title, kids, open) {
    return h('details', { class: 'card fold', id: id, open: open || null }, h('summary', { text: title }), kids);
  }

  function dueCard(s, afterRender) {
    var due = L.metrics.dueRecurring(s, today());
    if (!due.length) return null;
    var cur = s.settings.currency;
    return h('div', { class: 'card due', id: 'due-card' },
      h('h2', { text: 'Recurring items due (' + due.length + ')' }),
      h('p', { class: 'mut small', text: 'Nothing is posted until you confirm it.' }),
      due.map(function (d) {
        return h('div', { class: 'item' },
          h('div', null, h('div', { class: 'entry-t', text: d.title }),
            h('div', { class: 'mut small', text: d.date + ' | ' + (d.type === 'income' ? 'Income ' : 'Expense ') + moneyFmt(L.metrics.cents(d.value), cur) + (d.category ? ' | ' + d.category : '') })),
          h('div', { class: 'row' },
            btn('Confirm', function () {
              act(function () { return commit(function (x) { L.metrics.confirmRecurring(x, d.id, today()); }, 'recurring confirm').then(function () { setNotice('ok', 'Posted ' + d.title + '.'); render(); }); });
            }, 'pri sm', { 'aria-label': 'Confirm ' + d.title }),
            btn('Skip', function () {
              act(function () { return commit(function (x) { L.metrics.skipRecurring(x, d.id, today()); }, 'recurring skip').then(function () { render(); }); });
            }, 'sm', { 'aria-label': 'Skip ' + d.title })));
      }));
  }

  function moneyScreen(s) {
    var cur = s.settings.currency, t = today();
    var month = view.month || t.slice(0, 7);
    var v = L.metrics.monthView(s, month);
    var target = s.settings.targets.savingsRate;
    var rows = v.categories.map(function (c) {
      var pct = c.budgetCents ? (c.spentCents * 100) / c.budgetCents : 0;
      return h('div', { class: 'catrow' },
        h('div', { class: 'row sp' }, h('span', { text: c.category }),
          h('span', { class: c.over ? 'bad-t' : 'mut', text: moneyFmt(c.spentCents, cur) + (c.budgetCents === null ? '' : ' of ' + moneyFmt(c.budgetCents, cur)) })),
        c.budgetCents ? svgBar(pct, c.over ? 'bar-over' : 'bar-fill') : null,
        c.over ? h('div', { class: 'small bad-t', text: 'Over budget by ' + moneyFmt(-c.remainingCents, cur) }) : null);
    });
    var cf = L.metrics.cashflow(s, 6, t);

    // budgets
    var bCat = sel('bud-cat', catList(s, 'expense').map(function (c) { return { v: c, t: c }; }), catList(s, 'expense')[0]);
    var bAmt = h('input', { type: 'text', id: 'bud-amount', inputmode: 'decimal', autocomplete: 'off', maxlength: '14' });
    var budgets = details('budgets', 'Monthly budgets (' + s.budgets.length + ')', [
      s.budgets.map(function (b) {
        return h('div', { class: 'item' }, h('span', { text: b.category + ': ' + moneyFmt(L.metrics.cents(b.value), cur) }),
          btn('Remove', function () { act(function () { return commit(function (x) { x.budgets = x.budgets.filter(function (z) { return z.category !== b.category; }); }, 'budget remove').then(render); }); }, 'sm', { 'aria-label': 'Remove budget for ' + b.category }));
      }),
      h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          act(function () {
            var val = parseAmount(bAmt.value, { zero: true }), c = bCat.value;
            return commit(function (x) {
              x.budgets = x.budgets.filter(function (z) { return z.category !== c; });
              if (val > 0) x.budgets.push({ category: c, value: val });
            }, 'budget set').then(function () { view.open = 'budgets'; setNotice('ok', val > 0 ? 'Budget saved.' : 'Budget removed.'); render(); });
          });
        }
      }, field('Category', bCat), field('Monthly budget (0 removes it)', bAmt), h('button', { type: 'submit', class: 'btn pri', text: 'Save budget' })),
    ], view.open === 'budgets');

    // recurring
    var rT = h('input', { type: 'text', id: 'rc-title', maxlength: '200', autocomplete: 'off' });
    var rA = h('input', { type: 'text', id: 'rc-amount', inputmode: 'decimal', autocomplete: 'off', maxlength: '14' });
    var rType = sel('rc-type', [{ v: 'expense', t: 'Expense' }, { v: 'income', t: 'Income' }], 'expense', function () { fillCats(); });
    var rCat = h('select', { id: 'rc-cat' });
    function fillCats() {
      rCat.replaceChildren.apply(rCat, [h('option', { value: '', text: '(none)' })].concat(catList(s, rType.value).map(function (c) { return h('option', { value: c, text: c }); })));
    }
    fillCats();
    var rCad = sel('rc-cadence', [{ v: 'weekly', t: 'Weekly' }, { v: 'monthly', t: 'Monthly' }, { v: 'yearly', t: 'Yearly' }], 'monthly');
    var rNext = h('input', { type: 'date', id: 'rc-next', value: t, required: true });
    var rHouse = h('input', { type: 'checkbox', id: 'rc-household' });
    var recurring = details('recurring', 'Recurring items (' + s.recurring.length + ')', [
      h('p', { class: 'mut small', text: 'These only create a proposal on the due date. You confirm each one.' }),
      s.recurring.map(function (r) {
        return h('div', { class: 'item' },
          h('div', null, h('div', { class: 'entry-t', text: r.title }),
            h('div', { class: 'mut small', text: (r.type === 'income' ? 'Income ' : 'Expense ') + moneyFmt(L.metrics.cents(r.value), cur) + ' | ' + r.cadence + ' | next ' + r.nextDate + (r.active ? '' : ' | paused') + (r.household ? ' | household' : '') })),
          h('div', { class: 'row' },
            btn(r.active ? 'Pause' : 'Resume', function () { act(function () { return commit(function (x) { x.recurring.forEach(function (z) { if (z.id === r.id) z.active = !z.active; }); }, 'recurring toggle').then(function () { view.open = 'recurring'; render(); }); }); }, 'sm', { 'aria-label': (r.active ? 'Pause ' : 'Resume ') + r.title }),
            btn('Delete', function () { act(function () { return commit(function (x) { x.recurring = x.recurring.filter(function (z) { return z.id !== r.id; }); }, 'recurring delete').then(function () { view.open = 'recurring'; render(); }); }); }, 'sm bad', { 'aria-label': 'Delete ' + r.title })));
      }),
      h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          act(function () {
            var item = { id: L.store.newId(), title: rT.value.trim(), value: parseAmount(rA.value), category: rCat.value, type: rType.value, cadence: rCad.value, nextDate: rNext.value, active: true, household: rType.value === 'expense' && rHouse.checked };
            if (!item.title) throw new Error('Enter a title.');
            return commit(function (x) { x.recurring.push(item); }, 'recurring add').then(function () { view.open = 'recurring'; setNotice('ok', 'Recurring item added.'); render(); });
          });
        }
      }, field('Title', rT), field('Amount', rA), field('Type', rType), field('Category', rCat), field('Repeats', rCad), field('Next date', rNext), h('label', { class: 'field check' }, rHouse, h('span', { text: 'Household bill (expenses only; shown under Home)' })), h('button', { type: 'submit', class: 'btn pri', text: 'Add recurring' })),
    ], view.open === 'recurring');

    // categories
    var cName = h('input', { type: 'text', id: 'cat-name', maxlength: '40', autocomplete: 'off' });
    var cType = sel('cat-type', [{ v: 'expense', t: 'Expense' }, { v: 'income', t: 'Income' }], 'expense');
    var cats = details('categories', 'Categories', [
      ['expense', 'income'].map(function (ty) {
        return h('div', null, h('span', { class: 'lbl', text: (ty === 'expense' ? 'Expense' : 'Income') + ' categories' }),
          h('div', { class: 'chips' }, catList(s, ty).map(function (c) {
            return h('span', { class: 'chip' }, c, ' ', h('button', { type: 'button', class: 'x', text: 'x', 'aria-label': 'Remove category ' + c, onclick: function () {
              act(function () { return commit(function (z) { z.categories[ty] = z.categories[ty].filter(function (q) { return q !== c; }); }, 'category remove').then(function () { view.open = 'categories'; render(); }); });
            } }));
          })));
      }),
      h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          act(function () {
            var name = cName.value.trim(), ty = cType.value;
            if (!name || name.length > 40) throw new Error('Category names are 1 to 40 characters.');
            if (catList(s, ty).some(function (q) { return q.toLowerCase() === name.toLowerCase(); })) throw new Error('That category already exists.');
            return commit(function (x) { x.categories[ty].push(name); }, 'category add').then(function () { view.open = 'categories'; render(); });
          });
        }
      }, field('New category', cName), field('For', cType), h('button', { type: 'submit', class: 'btn', text: 'Add category' })),
    ], view.open === 'categories');

    var navMonth = function (k) { return btn(k < 0 ? 'Previous month' : 'Next month', function () { view.month = L.metrics.addMonths(month, k); render(); }, 'sm', { id: k < 0 ? 'mv-prev' : 'mv-next' }); };
    return h('div', null,
      btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'),
      h('div', { class: 'row sp' }, h('h1', { text: 'Money' }), btn('Quick add', quickAdd, 'pri', { id: 'quick-add-money' })),
      h('div', { class: 'row sp' }, navMonth(-1), h('strong', { id: 'mv-month', text: monthLabel(month) }), navMonth(1)),
      h('div', { class: 'stats' },
        stat('Income', moneyFmt(v.incomeCents, cur), 'mv-income'),
        stat('Spend', moneyFmt(v.spendCents, cur), 'mv-spend'),
        stat('Net', moneyFmt(v.netCents, cur), 'mv-net'),
        stat('Savings rate', pctFmt(v.savingsRate), 'mv-rate')),
      h('p', { class: 'mut small', text: 'Savings rate target: ' + Math.round(target * 100) + '%' }),
      dueCard(s),
      h('div', { class: 'card' }, h('h2', { text: 'Spending by category' }),
        rows.length ? rows : h('p', { class: 'mut', text: 'No spending this month.' })),
      h('div', { class: 'card' }, h('h2', { text: 'Cash flow, 6 months' }), cashflowChart(cf, cur),
        h('div', { class: 'legend small' }, h('span', { class: 'sw sw-in' }), ' Income ', h('span', { class: 'sw sw-out' }), ' Spend'),
        h('div', { class: 'tablewrap' }, h('table', null,
          h('thead', null, h('tr', null, ['Month', 'Income', 'Spend', 'Net'].map(function (x) { return h('th', { text: x }); }))),
          h('tbody', null, cf.map(function (r) {
            return h('tr', null, h('td', { text: monthLabel(r.month) }), h('td', { text: moneyFmt(r.incomeCents, cur) }), h('td', { text: moneyFmt(r.spendCents, cur) }), h('td', { text: moneyFmt(r.netCents, cur) }));
          }))))),
      budgets, recurring, cats,
      h('h2', { text: 'All entries' }),
      domainScreen(s, { embed: true }));
  }

  function assetsScreen(s) {
    var cur = s.settings.currency, t = today();
    var nw = L.metrics.netWorthDetail(s, t), hist = L.metrics.netWorthHistory(s, 12, t);
    var accts = s.accounts;
    var active = accts.filter(function (a) { return !a.archived; }), archived = accts.filter(function (a) { return a.archived; });
    var latest = {};
    nw.rows.forEach(function (r) { if (r.id) latest[r.id] = r; });
    var bAcct = sel('bal-acct', active.map(function (a) { return { v: a.id, t: a.name }; }), view.acct || (active[0] && active[0].id));
    var bVal = h('input', { type: 'text', id: 'bal-value', inputmode: 'decimal', autocomplete: 'off', maxlength: '16' });
    var bDate = h('input', { type: 'date', id: 'bal-date', value: t, required: true });
    var balForm = h('form', {
      class: 'card',
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var a = accts.filter(function (z) { return z.id === bAcct.value; })[0];
          if (!a) throw new Error('Add an account first.');
          var v = parseAmount(bVal.value, { neg: !a.liability, zero: true });
          return addEntry({ domain: 'assets', type: 'balance', date: bDate.value, title: a.name, value: v, accountId: a.id }).then(function () { setNotice('ok', 'Balance saved.'); render(); });
        });
      }
    }, h('h2', { text: 'Update a balance' }), active.length ? [field('Account', bAcct), field('Balance (the amount owed, for a liability)', bVal), field('As of', bDate), h('button', { type: 'submit', class: 'btn pri', id: 'bal-save', text: 'Save balance' })] : h('p', { class: 'mut', text: 'Add an account below first.' }));

    function acctRow(a) {
      var r = latest[a.id];
      return h('div', { class: 'item acct', 'data-account': a.name },
        h('div', null, h('div', { class: 'entry-t', text: a.name }),
          h('div', { class: 'mut small' }, h('span', { class: 'chip' + (a.liability ? ' bad' : ''), text: KIND_LABEL[a.kind] + (a.liability ? ' (owed)' : '') }),
            r ? moneyFmt(Math.abs(r.cents), cur) + ' as of ' + r.date : 'No balance yet')),
        h('div', { class: 'row' },
          a.archived ? null : btn('Update', function () { view.acct = a.id; render(); var i = document.getElementById('bal-value'); if (i) i.focus(); }, 'sm', { 'aria-label': 'Update balance for ' + a.name }),
          btn('Rename', function () { renameDialog(a); }, 'sm', { 'aria-label': 'Rename ' + a.name }),
          btn(a.archived ? 'Restore' : 'Archive', function () {
            act(function () { return commit(function (x) { x.accounts.forEach(function (z) { if (z.id === a.id) z.archived = !z.archived; }); }, 'account archive').then(render); });
          }, 'sm', { 'aria-label': (a.archived ? 'Restore ' : 'Archive ') + a.name })));
    }
    function renameDialog(a) {
      var inp = h('input', { type: 'text', id: 'ac-rename', maxlength: '200', value: a.name, autocomplete: 'off' });
      openDialog({
        title: 'Rename account', yes: 'Save', body: field('Name', inp),
        onYes: function () {
          var n = inp.value.trim();
          if (!n) throw new Error('Enter a name.');
          if (accts.some(function (z) { return z.id !== a.id && z.name.toLowerCase() === n.toLowerCase(); })) throw new Error('You already have an account with that name.');
          return commit(function (x) { x.accounts.forEach(function (z) { if (z.id === a.id) z.name = n; }); }, 'account rename').then(function () { render(); });
        }
      });
    }

    var aName = h('input', { type: 'text', id: 'ac-name', maxlength: '200', autocomplete: 'off' });
    var aKind = sel('ac-kind', L.metrics.ACCOUNT_KINDS.map(function (k) { return { v: k, t: KIND_LABEL[k] }; }), 'cash');
    var aLiab = h('input', { type: 'checkbox', id: 'ac-liab' });
    var aBal = h('input', { type: 'text', id: 'ac-bal', inputmode: 'decimal', autocomplete: 'off', maxlength: '16' });
    var aDate = h('input', { type: 'date', id: 'ac-date', value: t, required: true });
    var addForm = h('form', {
      class: 'card',
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var name = aName.value.trim(), kind = aKind.value;
          if (!name) throw new Error('Enter an account name.');
          if (accts.some(function (z) { return z.name.toLowerCase() === name.toLowerCase(); })) throw new Error('You already have an account with that name.');
          var liab = L.metrics.LIAB_KINDS.indexOf(kind) >= 0 || aLiab.checked;
          var opening = aBal.value.trim() === '' ? null : parseAmount(aBal.value, { neg: !liab, zero: true });
          var acct = { id: L.store.newId(), name: name, kind: kind, liability: liab, archived: false };
          var en = opening === null ? null : L.metrics.validateEntry({ domain: 'assets', type: 'balance', date: aDate.value, title: name, value: opening, accountId: acct.id });
          if (en) { en.id = en.id || L.store.newId(); en.createdAt = en.createdAt || new Date().toISOString(); }
          return commit(function (x) { x.accounts.push(acct); if (en) x.entries.push(en); }, 'account add').then(function () { setNotice('ok', 'Account added.'); render(); });
        });
      }
    }, h('h2', { text: 'Add an account' }), field('Name', aName), field('Kind', aKind),
      h('label', { class: 'field check' }, aLiab, h('span', { text: 'Treat as a liability (credit cards, loans and mortgages always are)' })),
      field('Current balance (the amount owed, for a liability)', aBal), field('As of', aDate),
      h('button', { type: 'submit', class: 'btn pri', id: 'ac-add', text: 'Add account' }));

    var alloc = nw.byKind.length ? h('div', null,
      h('svg', { class: 'alloc', viewBox: '0 0 100 10', preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Asset allocation by kind' },
        (function () {
          var x = 0;
          return nw.byKind.map(function (k, i) {
            var w = k.share * 100, r = h('rect', { class: 'k' + (i % 9), x: String(x), y: '0', width: String(w), height: '10' });
            x += w; return r;
          });
        })()),
      h('div', { class: 'legend' }, nw.byKind.map(function (k, i) {
        return h('div', { class: 'row sp alloc-row' }, h('span', null, h('span', { class: 'sw k' + (i % 9) }), ' ' + KIND_LABEL[k.kind]),
          h('span', { text: Math.round(k.share * 1000) / 10 + '% | ' + moneyFmt(k.cents, cur) }));
      }))) : h('p', { class: 'mut', text: 'No assets yet.' });

    return h('div', null,
      btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'),
      h('h1', { text: 'Assets' }),
      h('div', { class: 'stats' },
        stat('Net worth', moneyFmt(nw.totalCents, cur), 'aw-net'),
        stat('Assets', moneyFmt(nw.assetsCents, cur), 'aw-assets'),
        stat('Liabilities', moneyFmt(nw.liabilitiesCents, cur), 'aw-liab')),
      h('div', { class: 'card' }, h('h2', { text: 'Net worth, 12 months' }), netWorthChart(hist),
        h('div', { class: 'legend small' }, h('span', { class: 'sw sw-net' }), ' Net worth ', h('span', { class: 'sw sw-assets' }), ' Assets ', h('span', { class: 'sw sw-liab' }), ' Liabilities'),
        h('div', { class: 'tablewrap' }, h('table', null,
          h('thead', null, h('tr', null, ['Month', 'Assets', 'Liabilities', 'Net worth'].map(function (x) { return h('th', { text: x }); }))),
          h('tbody', null, hist.slice(-6).map(function (r) {
            return h('tr', null, h('td', { text: monthLabel(r.month) }), h('td', { text: moneyFmt(r.assetsCents, cur) }), h('td', { text: moneyFmt(r.liabilitiesCents, cur) }), h('td', { text: moneyFmt(r.totalCents, cur) }));
          }))))),
      h('div', { class: 'card' }, h('h2', { text: 'Allocation' }), alloc),
      h('h2', { text: 'Accounts (' + active.length + ')' }),
      h('div', { class: 'card' }, active.length ? active.map(acctRow) : h('p', { class: 'mut', text: 'No accounts yet.' })),
      balForm, addForm,
      archived.length ? details('archived', 'Archived accounts (' + archived.length + ')', archived.map(acctRow), view.open === 'archived') : null,
      h('h2', { text: 'Balance history' }),
      domainScreen(s, { embed: true, noForm: true }));
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
      carryCard(s, wk, render),
      h('h2', { text: '3. Goals' }),
      reviewGoalsCard(s, wk, t),
      h('h2', { text: '4. Home and Admin' }),
      reviewHomeAdminCard(s, wk),
      h('h2', { text: '5. Learning' }),
      reviewLearningCard(s, wk, t),
      h('h2', { text: '6. Activities' }),
      reviewActivitiesCard(s, wk, t),
      h('h2', { text: '7. Your three priorities' }),
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

  // ---------- work (v0.4.0) ----------
  var STAGE_LABEL = { lead: 'Lead', contacted: 'Contacted', applied: 'Applied', interview: 'Interview', offer: 'Offer', won: 'Won', lost: 'Lost' };
  var PKIND = [['job', 'Job'], ['venture', 'Venture'], ['client', 'Client'], ['personal', 'Personal']];
  var PLKIND = [['job', 'Job'], ['deal', 'Deal'], ['partner', 'Partner']];
  function projName(s, id) {
    var p = (s.projects || []).filter(function (x) { return x.id === id; })[0];
    return p ? p.name : '';
  }
  // Delete a project after an in-page confirm. Linked outcomes are kept and unlinked.
  function askDeleteProject(s, p) {
    var n = L.metrics.linkedOutcomeCount(s, p.id);
    openDialog({
      title: 'Delete this project?', yes: 'Delete project', danger: true,
      body: [h('p', { class: 'mut', text: p.name }),
        h('p', { class: 'small', id: 'pj-del-info', text: n + (n === 1 ? ' linked outcome is' : ' linked outcomes are') + ' kept and unlinked from this project. The project itself is removed.' })],
      onYes: function () { return commit(function (x) { L.metrics.deleteProject(x, p.id); }, 'project delete').then(function () { setNotice('ok', 'Project deleted.'); render(); }); }
    });
  }
  function carryCard(s, wk, afterRender) {
    var cands = L.metrics.carryOverCandidates(s, wk);
    if (!cands.length) return null;
    var boxes = cands.map(function (c) {
      var cb = h('input', { type: 'checkbox', 'data-carry': c.id });
      return h('label', { class: 'field check' }, cb, h('span', { text: c.title + (c.projectId && projName(s, c.projectId) ? ' (' + projName(s, c.projectId) + ')' : '') + ' | from ' + c.date }));
    });
    return h('div', { class: 'card', id: 'carry-card' },
      h('h2', { text: 'Unfinished from earlier weeks (' + cands.length + ')' }),
      h('p', { class: 'mut small', text: 'Nothing is carried over until you choose it.' }),
      boxes,
      btn('Carry over selected', function () {
        act(function () {
          var ids = [];
          boxes.forEach(function (b) { var i = b.querySelector('input'); if (i.checked) ids.push(i.getAttribute('data-carry')); });
          if (!ids.length) throw new Error('Tick at least one outcome to carry over.');
          return commit(function (x) { L.metrics.carryOver(x, ids, wk); }, 'outcomes carried over').then(function () { setNotice('ok', 'Carried over ' + ids.length + (ids.length === 1 ? ' outcome.' : ' outcomes.')); afterRender(); });
        });
      }, 'sm pri', { id: 'carry-go' }));
  }
  function trendChart(rows) {
    var W = 320, H = 110, B = 18, max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));
    var bw = W / rows.length;
    var g = [h('line', { class: 'axis', x1: '0', y1: String(H - B), x2: String(W), y2: String(H - B) })];
    rows.forEach(function (r, i) {
      var ht = Math.round((r.value / max) * (H - B - 14));
      g.push(h('rect', { class: 'k0', x: String(i * bw + 6), y: String(H - B - ht), width: String(bw - 12), height: String(ht) }));
      g.push(h('text', { class: 'tick', x: String(i * bw + bw / 2), y: String(H - B - ht - 3), 'text-anchor': 'middle' }, String(r.value)));
      g.push(h('text', { class: 'tick', x: String(i * bw + bw / 2), y: String(H - 4), 'text-anchor': 'middle' }, r.label.slice(5)));
    });
    return h('svg', { class: 'chart', id: 'work-trend', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Outcomes completed per week, last 8 weeks' }, g);
  }
  function workScreen(s) {
    var t = today(), wk = L.metrics.weekStart(t), sum = L.metrics.workSummary(s, t);
    var projects = s.projects || [], pipeline = s.pipeline || [];
    var live = projects.filter(function (p) { return !p.archived; });
    var stats = h('div', { class: 'stats' },
      stat('Outcomes done', sum.done + ' of ' + sum.total, 'wk-done'),
      stat('Overdue next actions', String(sum.overdue), 'wk-overdue', sum.overdue ? 'bad-t' : ''),
      stat('Open in pipeline', String(sum.openPipeline), 'wk-open'),
      stat('Stale (14 days)', String(sum.stale), 'wk-stale', sum.stale ? 'bad-t' : ''));

    // outcomes
    var oTitle = h('input', { type: 'text', id: 'oc-title', maxlength: '200', autocomplete: 'off' });
    var oProj = sel('oc-proj', [{ v: '', t: '(no project)' }].concat(live.map(function (p) { return { v: p.id, t: p.name }; })), '');
    var oForm = h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var p = { domain: 'work', type: 'outcome', date: t, title: oTitle.value.trim(), status: 'todo' };
          if (oProj.value) p.projectId = oProj.value;
          return addEntry(p).then(function () { setNotice('ok', 'Outcome added.'); render(); });
        });
      }
    }, field('Outcome for this week', oTitle), field('Project (optional)', oProj),
      h('button', { type: 'submit', class: 'btn pri', id: 'oc-add', text: 'Add outcome' }));
    var wkList = L.metrics.weekOutcomes(s, wk);
    var oList = wkList.map(function (en) {
      var done = en.status === 'done', pn = en.projectId ? projName(s, en.projectId) : '';
      return h('div', { class: 'item outcome', 'data-outcome': en.title, 'data-status': en.status },
        h('div', null, h('div', { class: 'entry-t' + (done ? ' done-t' : ''), text: en.title }),
          pn ? h('div', { class: 'mut small' }, h('span', { class: 'chip', text: pn })) : null),
        btn(done ? 'Reopen' : 'Mark done', function () {
          act(function () {
            return commit(function (x) { x.entries.forEach(function (z) { if (z.id === en.id) z.status = done ? 'todo' : 'done'; }); }, 'outcome ' + (done ? 'reopen' : 'done')).then(function () { render(); });
          });
        }, 'sm' + (done ? '' : ' pri'), { 'aria-label': (done ? 'Reopen ' : 'Mark done ') + en.title }));
    });
    var oCard = h('div', { class: 'card', id: 'outcomes' }, h('h2', { text: 'This week\'s outcomes' }),
      h('p', { class: 'mut small', text: 'Pick the three that matter most.' }),
      oList.length ? oList : h('p', { class: 'mut', text: 'No outcomes yet this week.' }), oForm);

    // projects
    var pName = h('input', { type: 'text', id: 'pj-name', maxlength: '200', autocomplete: 'off' });
    var pKind = sel('pj-kind', PKIND.map(function (k) { return { v: k[0], t: k[1] }; }), 'job');
    var pNext = h('input', { type: 'text', id: 'pj-next', maxlength: '200', autocomplete: 'off' });
    var pDate = h('input', { type: 'date', id: 'pj-date' });
    var pForm = h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var name = pName.value.trim();
          if (!name) throw new Error('Enter a project name.');
          if (live.length >= 200 || projects.length >= 2000) throw new Error('You have reached the 200 project limit. Archive or delete some.');
          var p = { id: L.store.newId(), name: name, kind: pKind.value, status: 'active', nextAction: pNext.value.trim(), archived: false };
          if (pDate.value) p.nextDate = pDate.value;
          return commit(function (x) { x.projects.push(p); }, 'project add').then(function () { setNotice('ok', 'Project added.'); render(); });
        });
      }
    }, field('Project name', pName), field('Kind', pKind), field('Next action', pNext), field('Next action date (optional)', pDate),
      h('button', { type: 'submit', class: 'btn pri', id: 'pj-add', text: 'Add project' }));
    function setProj(p, fn, action) {
      act(function () { return commit(function (x) { x.projects.forEach(function (z) { if (z.id === p.id) fn(z); }); }, action).then(function () { render(); }); });
    }
    var shownP = live.slice().sort(function (a, b) { return (a.status === 'done') - (b.status === 'done') || a.name.localeCompare(b.name); });
    var pList = shownP.map(function (p) {
      var od = p.status === 'active' && p.nextDate && p.nextDate < t;
      return h('div', { class: 'item proj', 'data-project': p.name },
        h('div', null, h('div', { class: 'entry-t', text: p.name }),
          h('div', { class: 'mut small' }, h('span', { class: 'chip', text: p.kind }), h('span', { class: 'chip', text: p.status }),
            od ? h('span', { class: 'chip bad', text: 'Overdue' }) : null),
          h('div', { class: 'small', text: p.nextAction ? 'Next: ' + p.nextAction + (p.nextDate ? ' (' + p.nextDate + ')' : '') : (p.nextDate ? 'Next date ' + p.nextDate : 'No next action set') })),
        h('div', { class: 'row' },
          btn('Update next', function () {
            var a = h('input', { type: 'text', id: 'ed-next', maxlength: '200', value: p.nextAction || '' });
            var d = h('input', { type: 'date', id: 'ed-date', value: p.nextDate || '' });
            openDialog({
              title: 'Next action', yes: 'Save', body: h('div', null, field('Next action', a), field('Date (optional)', d)),
              onYes: function () {
                return commit(function (x) { x.projects.forEach(function (z) { if (z.id === p.id) { z.nextAction = a.value.trim(); if (d.value) z.nextDate = d.value; else delete z.nextDate; } }); }, 'project next').then(function () { render(); });
              }
            });
          }, 'sm', { 'aria-label': 'Update next action for ' + p.name }),
          p.status === 'active' ? btn('Pause', function () { setProj(p, function (z) { z.status = 'paused'; }, 'project pause'); }, 'sm', { 'aria-label': 'Pause ' + p.name }) : btn('Resume', function () { setProj(p, function (z) { z.status = 'active'; }, 'project resume'); }, 'sm', { 'aria-label': 'Resume ' + p.name }),
          p.status !== 'done' ? btn('Done', function () { setProj(p, function (z) { z.status = 'done'; }, 'project done'); }, 'sm', { 'aria-label': 'Finish ' + p.name }) : null,
          btn('Archive', function () { setProj(p, function (z) { z.archived = true; }, 'project archive'); }, 'sm', { 'aria-label': 'Archive ' + p.name }),
          btn('Delete', function () { askDeleteProject(s, p); }, 'sm bad', { 'aria-label': 'Delete ' + p.name })));
    });
    var archived = projects.filter(function (p) { return p.archived; });
    var aList = archived.map(function (p) {
      return h('div', { class: 'item aproj' }, h('div', null, h('div', { class: 'entry-t', text: p.name }), h('div', { class: 'mut small' }, h('span', { class: 'chip', text: p.kind }))),
        h('div', { class: 'row' },
          btn('Restore', function () {
            if (live.length >= 200) { setNotice('err', 'You have reached the 200 project limit. Archive or delete some first.'); return; }
            setProj(p, function (z) { z.archived = false; }, 'project restore');
          }, 'sm', { 'aria-label': 'Restore ' + p.name }),
          btn('Delete', function () { askDeleteProject(s, p); }, 'sm bad', { 'aria-label': 'Delete archived ' + p.name })));
    });
    var pCard = h('div', { class: 'card', id: 'projects' }, h('h2', { text: 'Projects (' + live.length + ')' }),
      pList.length ? pList : h('p', { class: 'mut', text: 'No projects yet.' }),
      details('pj-new', 'Add a project', pForm, !pList.length),
      archived.length ? details('pj-archived', 'Archived projects (' + archived.length + ')', aList) : null);

    // pipeline
    var lTitle = h('input', { type: 'text', id: 'pl-title', maxlength: '200', autocomplete: 'off' });
    var lOrg = h('input', { type: 'text', id: 'pl-org', maxlength: '200', autocomplete: 'off' });
    var lKind = sel('pl-kind', PLKIND.map(function (k) { return { v: k[0], t: k[1] }; }), 'job');
    var lStage = sel('pl-stage', L.metrics.STAGES.map(function (k) { return { v: k, t: STAGE_LABEL[k] }; }), 'lead');
    var lSource = h('input', { type: 'text', id: 'pl-source', maxlength: '200', autocomplete: 'off' });
    var lNext = h('input', { type: 'text', id: 'pl-next', maxlength: '200', autocomplete: 'off' });
    var lDate = h('input', { type: 'date', id: 'pl-date' });
    var lNotes = h('textarea', { id: 'pl-notes', maxlength: '2000' });
    var lForm = h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var title = lTitle.value.trim();
          if (!title) throw new Error('Enter a title.');
          if (pipeline.length >= 1000) throw new Error('You have reached the 1000 item limit. Delete some.');
          var it = { id: L.store.newId(), title: title, org: lOrg.value.trim(), kind: lKind.value, stage: lStage.value, source: lSource.value.trim(), nextStep: lNext.value.trim(), updatedAt: t, notes: lNotes.value.trim() };
          if (lDate.value) it.nextDate = lDate.value;
          return commit(function (x) { x.pipeline.push(it); }, 'pipeline add').then(function () { setNotice('ok', 'Pipeline item added.'); render(); });
        });
      }
    }, field('Title (role, deal or partner)', lTitle), field('Organisation', lOrg), field('Kind', lKind), field('Stage', lStage),
      field('Source', lSource), field('Next step', lNext), field('Next step date (optional)', lDate), field('Notes (optional)', lNotes),
      h('button', { type: 'submit', class: 'btn pri', id: 'pl-add', text: 'Add to pipeline' }));
    function setItem(it, fn, action) {
      act(function () { return commit(function (x) { x.pipeline.forEach(function (z) { if (z.id === it.id) { fn(z); z.updatedAt = t; } }); }, action).then(function () { render(); }); });
    }
    var counts = L.metrics.pipelineCounts(s);
    var strip = h('div', { class: 'stagecounts' }, L.metrics.STAGES.map(function (k) {
      return h('span', { class: 'chip', 'data-count': k, text: STAGE_LABEL[k] + ' ' + counts[k] });
    }));
    var order = L.metrics.STAGES;
    var board = h('div', { class: 'board', id: 'board' }, order.filter(function (k) { return counts[k] > 0; }).map(function (k) {
      return h('div', { class: 'stage', 'data-stage': k },
        h('h3', { text: STAGE_LABEL[k] + ' (' + counts[k] + ')' }),
        pipeline.filter(function (x) { return x.stage === k; }).sort(function (a, b) { return a.updatedAt.localeCompare(b.updatedAt); }).map(function (it) {
          var stale = L.metrics.isStale(it, t), idx = order.indexOf(it.stage), nxt = idx < 4 ? order[idx + 1] : (idx === 4 ? 'won' : null);
          return h('div', { class: 'pitem', 'data-item': it.title, 'data-stage': it.stage },
            h('div', { class: 'entry-t', text: it.title }),
            h('div', { class: 'mut small' }, (it.org ? it.org + ' | ' : '') + it.kind + (it.source ? ' | ' + it.source : '')),
            it.nextStep ? h('div', { class: 'small', text: 'Next: ' + it.nextStep + (it.nextDate ? ' (' + it.nextDate + ')' : '') }) : null,
            h('div', { class: 'small' }, stale ? h('span', { class: 'chip bad', text: 'Stale' }) : null, h('span', { class: 'mut', text: 'Updated ' + it.updatedAt })),
            h('div', { class: 'row' },
              nxt ? btn('To ' + STAGE_LABEL[nxt], function () { setItem(it, function (z) { z.stage = nxt; }, 'pipeline stage'); }, 'sm pri', { 'aria-label': 'Move ' + it.title + ' to ' + STAGE_LABEL[nxt] }) : null,
              sel(null, order.map(function (k) { return { v: k, t: STAGE_LABEL[k] }; }), it.stage, function (e) {
                var v = e.target.value; if (v !== it.stage) setItem(it, function (z) { z.stage = v; }, 'pipeline stage');
              }),
              stale ? btn('Touched today', function () { setItem(it, function () {}, 'pipeline touch'); }, 'sm', { 'aria-label': 'Mark ' + it.title + ' updated today' }) : null,
              btn('Delete', function () {
                openDialog({ title: 'Delete this item?', yes: 'Delete', danger: true, body: h('p', { class: 'mut', text: it.title }),
                  onYes: function () { return commit(function (x) { x.pipeline = x.pipeline.filter(function (z) { return z.id !== it.id; }); }, 'pipeline delete').then(function () { render(); }); } });
              }, 'sm bad', { 'aria-label': 'Delete ' + it.title })));
        }));
    }));
    var lCard = h('div', { class: 'card', id: 'pipeline' }, h('h2', { text: 'Pipeline (' + pipeline.length + ')' }), strip,
      pipeline.length ? board : h('p', { class: 'mut', text: 'Nothing in the pipeline yet.' }),
      details('pl-new', 'Add to pipeline', lForm, !pipeline.length));

    var trend = h('div', { class: 'card' }, h('h2', { text: 'Outcomes completed, last 8 weeks' }), trendChart(L.metrics.series(s, 'work', 8, t)));
    var cc = carryCard(s, wk, render);
    return h('div', null, btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'), h('h1', { text: 'Work' }), stats,
      oCard, cc, pCard, lCard, trend,
      details('work-data', 'Entries and CSV', [
        h('div', { class: 'row' },
          btn('Export pipeline CSV', function () { download('lifeos-pipeline.csv', L.csv.exportPipeline(pipeline), 'text/csv'); }, 'sm', { id: 'exp-pipeline' }),
          btn('Export projects CSV', function () { download('lifeos-projects.csv', L.csv.exportProjects(projects), 'text/csv'); }, 'sm', { id: 'exp-projects' })),
        domainScreen(s, { embed: true, noForm: true })]));
  }

  // ---------- health (v0.5.0) ----------
  function fmt1(n) { return String(Math.round(n * 10) / 10); }
  function signed(n) { return (n > 0 ? '+' : '') + fmt1(n); }
  function numOrNull(v) {
    v = String(v == null ? '' : v).trim();
    if (v === '') return null;
    var n = Number(v);
    if (!isFinite(n)) throw new Error('Enter a number.');
    return n;
  }
  function intIn(v, lo, hi, label) {
    var n = parseInt(v, 10);
    if (!(n >= lo && n <= hi)) throw new Error(label + ' must be ' + lo + ' to ' + hi + '.');
    return n;
  }
  function entryFor(p) {
    var en = L.metrics.validateEntry(p);
    en.id = en.id || L.store.newId();
    en.createdAt = en.createdAt || new Date().toISOString();
    return en;
  }
  function lineChart(id, label, pts, target) {
    var W = 320, H = 130, P = 14, rows = pts.slice(-60);
    var vals = rows.map(function (r) { return r.value; }).concat(rows.map(function (r) { return r.avg; }));
    if (target != null) vals.push(target);
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), rng = max - min || 1;
    function X(i) { return rows.length < 2 ? W / 2 : P + i * (W - 2 * P) / (rows.length - 1); }
    function Y(v) { return H - P - (v - min) / rng * (H - 2 * P); }
    function pts2(key) { return rows.map(function (r, i) { return X(i).toFixed(1) + ',' + Y(r[key]).toFixed(1); }).join(' '); }
    var g = [h('line', { class: 'axis', x1: '0', y1: String(H - P + 4), x2: String(W), y2: String(H - P + 4) })];
    if (target != null) g.push(h('line', { class: 'ln-target', x1: String(P), y1: Y(target).toFixed(1), x2: String(W - P), y2: Y(target).toFixed(1) }));
    g.push(h('polyline', { class: 'ln-raw', points: pts2('value') }));
    rows.forEach(function (r, i) { g.push(h('circle', { class: 'dot-raw', cx: X(i).toFixed(1), cy: Y(r.value).toFixed(1), r: '2' })); });
    g.push(h('polyline', { class: 'ln-avg', points: pts2('avg') }));
    g.push(h('text', { class: 'tick', x: '2', y: '10', 'text-anchor': 'start' }, fmt1(max)));
    g.push(h('text', { class: 'tick', x: '2', y: String(H - 2), 'text-anchor': 'start' }, fmt1(min)));
    return h('svg', { class: 'chart', id: id, viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': label }, g);
  }
  function sleepChart(series) {
    var W = 320, H = 110, B = 16, max = Math.max.apply(null, series.map(function (r) { return r.value || 0; }).concat([8]));
    var bw = W / series.length, g = [h('line', { class: 'axis', x1: '0', y1: String(H - B), x2: String(W), y2: String(H - B) })];
    series.forEach(function (r, i) {
      if (r.value !== null) {
        var ht = Math.round(r.value / max * (H - B - 12));
        g.push(h('rect', { class: 'k1', x: String(i * bw + 3), y: String(H - B - ht), width: String(bw - 6), height: String(ht) }));
      }
      if (i % 2 === 0) g.push(h('text', { class: 'tick', x: String(i * bw + bw / 2), y: String(H - 3), 'text-anchor': 'middle' }, r.date.slice(8)));
    });
    return h('svg', { class: 'chart', id: 'hl-sleep-chart', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Hours slept per night, last 14 nights' }, g);
  }
  function mixRows(mix, sessions) {
    return mix.map(function (m) {
      return h('div', { class: 'catrow', 'data-kind': m.kind },
        h('div', { class: 'row sp small' }, h('span', { text: m.kind }), h('span', { class: 'mut', text: m.count + (m.count === 1 ? ' session' : ' sessions') + (m.minutes ? ', ' + m.minutes + ' min' : '') })),
        h('svg', { class: 'bar', viewBox: '0 0 100 8', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' },
          h('rect', { class: 'bar-bg', x: '0', y: '0', width: '100', height: '8' }),
          h('rect', { class: 'bar-fill', x: '0', y: '0', width: String(Math.round(m.count / Math.max(1, sessions) * 100)), height: '8' })));
    });
  }
  function bodyBlock(m, label, idp, unitLabel) {
    var none = !m.count;
    return h('div', { class: 'sub' },
      h('h3', { text: label }),
      h('div', { class: 'stats' },
        stat('Latest', none ? 'No entries' : fmt1(m.latest) + ' ' + unitLabel, idp + '-latest'),
        stat('7-entry average', none ? 'n/a' : fmt1(m.avg) + ' ' + unitLabel, idp + '-avg'),
        stat('Change per week (4 weeks)', m.weeklyRate === null ? 'n/a' : signed(m.weeklyRate) + ' ' + unitLabel, idp + '-rate'),
        stat('Progress to target', m.target === null ? 'No target set' : (m.progressPct === null ? 'n/a' : fmt1(m.progressPct) + '%'), idp + '-progress')),
      m.target !== null && !none ? h('p', { class: 'mut small', id: idp + '-togo', text: (m.toTarget === 0 ? 'At target ' : fmt1(Math.abs(m.toTarget)) + ' ' + unitLabel + (m.toTarget < 0 ? ' above' : ' below') + ' target ') + fmt1(m.target) + ' ' + unitLabel + '.' }) : null,
      none ? h('p', { class: 'mut', text: 'Log an entry to see the trend.' }) : lineChart(idp + '-chart', label + ' trend with 7-entry average', m.series, m.target));
  }
  function healthScreen(s) {
    var t = today(), wk = L.metrics.weekStart(t), M = L.metrics, hs = s.settings.health || { units: 'lb' }, unit = hs.units;
    var cyc = s.cycle ? M.trainingCycle(s.cycle, t) : null, ww = M.workoutWeek(s, wk);
    var wm = M.bodyMetrics(s, 'weight', t), bf = M.bodyMetrics(s, 'bodyfat', t), sl = M.sleepSummary(s, t);
    var habits = s.habits || [], kinds = s.kinds || [];
    function done(msg) { return function () { setNotice('ok', msg); render(); }; }

    // today card
    var cycTxt = !cyc ? 'No training cycle set. Add one under Targets, cycle and workout types.'
      : M.cycleLabel(cyc) + (cyc.phase === 'sprint' && cyc.daysToRest !== null ? '. Rest starts in ' + cyc.daysToRest + (cyc.daysToRest === 1 ? ' day' : ' days') + '.' : (cyc.phase === 'rest' ? '. Training resumes in ' + cyc.daysToTraining + (cyc.daysToTraining === 1 ? ' day' : ' days') + '.' : '.'));
    var chips = habits.length ? h('div', { class: 'chips', id: 'hl-habits', role: 'group', 'aria-label': 'Daily checks for today' }, habits.map(function (hb) {
      var on = M.habitStats(s, hb.id, t).doneToday;
      return h('button', { type: 'button', class: 'chipbtn', 'data-habit': hb.name, 'aria-pressed': on ? 'true' : 'false', text: hb.name, onclick: function () {
        act(function () { return commit(function (x) { M.toggleHabit(x, hb.id, t); }, 'daily check').then(function () { render(); }); });
      } });
    })) : h('p', { class: 'mut small', text: 'No daily checks yet. Add up to 8 under Daily checks below.' });

    var qwKind = sel('qw-kind', [{ v: '', t: '(none)' }].concat(kinds.map(function (k) { return { v: k, t: k }; })), '');
    var qwMin = h('input', { type: 'number', id: 'qw-min', min: '0', max: '1440', step: '1', inputmode: 'numeric' });
    var qwEff = sel('qw-effort', [{ v: '', t: '(none)' }].concat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (n) { return { v: String(n), t: String(n) }; })), '');
    var qwDate = h('input', { type: 'date', id: 'qw-date', value: t, required: true });
    var qwNote = h('input', { type: 'text', id: 'qw-note', maxlength: '200', autocomplete: 'off' });
    var fWork = h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var p = { domain: 'health', type: 'workout', date: qwDate.value, title: qwKind.value || 'Workout' };
          if (qwKind.value) p.kind = qwKind.value;
          if (qwMin.value !== '') p.minutes = Number(qwMin.value);
          if (qwEff.value) p.effort = Number(qwEff.value);
          if (qwNote.value.trim()) p.notes = qwNote.value.trim();
          var en = entryFor(p);
          return commit(function (x) { x.entries.push(en); }, 'entry add').then(done('Workout logged.'));
        });
      }
    }, field('Type', qwKind), field('Minutes', qwMin), field('Effort 1 to 10 (optional)', qwEff), field('Date', qwDate), field('Notes (optional)', qwNote),
      h('button', { type: 'submit', class: 'btn pri', id: 'qw-add', text: 'Log workout' }));

    var qbW = h('input', { type: 'text', id: 'qb-weight', inputmode: 'decimal', autocomplete: 'off', maxlength: '8' });
    var qbF = h('input', { type: 'text', id: 'qb-fat', inputmode: 'decimal', autocomplete: 'off', maxlength: '6' });
    var qbDate = h('input', { type: 'date', id: 'qb-date', value: t, required: true });
    var fBody = h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var w = qbW.value.trim(), f = qbF.value.trim(), list = [];
          if (!w && !f) throw new Error('Enter a weight or a body fat percentage.');
          if (w) list.push(entryFor({ domain: 'health', type: 'weight', date: qbDate.value, title: 'Weight', value: w }));
          if (f) list.push(entryFor({ domain: 'health', type: 'bodyfat', date: qbDate.value, title: 'Body fat', value: f }));
          return commit(function (x) { list.forEach(function (en) { x.entries.push(en); }); }, 'entry add').then(done('Body metrics logged.'));
        });
      }
    }, field('Weight (' + unit + ')', qbW), field('Body fat % (optional)', qbF), field('Date', qbDate),
      h('button', { type: 'submit', class: 'btn pri', id: 'qb-add', text: 'Log weight' }));

    var qsH = h('input', { type: 'text', id: 'qs-hours', inputmode: 'decimal', autocomplete: 'off', maxlength: '5' });
    var qsDate = h('input', { type: 'date', id: 'qs-date', value: t, required: true });
    var fSleep = h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var en = entryFor({ domain: 'health', type: 'sleep', date: qsDate.value, title: 'Sleep', value: qsH.value.trim() });
          return commit(function (x) { x.entries.push(en); }, 'entry add').then(done('Sleep logged.'));
        });
      }
    }, field('Hours slept', qsH), field('Date (the morning you woke)', qsDate), h('button', { type: 'submit', class: 'btn pri', id: 'qs-add', text: 'Log sleep' }));

    var todayCard = h('div', { class: 'card', id: 'hl-today' }, h('h2', { text: 'Today' }),
      h('p', { id: 'hl-cycle', text: cycTxt }), chips,
      details('hl-q-workout', 'Log a workout', fWork, false), details('hl-q-body', 'Log weight or body fat', fBody, false), details('hl-q-sleep', 'Log sleep', fSleep, false));

    // week card
    var wkCard = h('div', { class: 'card', id: 'hl-week' }, h('h2', { text: 'This week' }),
      h('div', { class: 'stats' },
        stat('Sessions', ww.sessions + ' of ' + ww.target, 'hl-sessions'),
        stat('Minutes', String(ww.minutes), 'hl-minutes'),
        stat('Week number', String(ww.isoWeek), 'hl-weeknum'),
        stat('Cycle week', ww.cycleWeek === null ? 'n/a' : (ww.cycleWeek === 0 ? 'Not started' : String(ww.cycleWeek)), 'hl-cycleweek')),
      ww.mix.length ? mixRows(ww.mix, ww.sessions) : h('p', { class: 'mut', text: 'No workouts logged this week.' }),
      healthFromActivities(s, wk));

    // body
    var bodyCard = h('div', { class: 'card', id: 'hl-body' }, h('h2', { text: 'Body' }),
      bodyBlock(wm, 'Weight', 'hl-weight', unit), bf.count ? bodyBlock(bf, 'Body fat', 'hl-fat', '%') : null);

    // sleep
    var sleepCard = h('div', { class: 'card', id: 'hl-sleep' }, h('h2', { text: 'Sleep' }),
      h('div', { class: 'stats' },
        stat('7-day average', sl.avg7 === null ? 'n/a' : fmt1(sl.avg7) + ' h', 'hl-sleep-avg'),
        stat('Nights logged (7 days)', String(sl.nights7), 'hl-sleep-n'),
        stat('Change from previous 7 days', sl.delta === null ? 'n/a' : signed(sl.delta) + ' h', 'hl-sleep-delta')),
      sleepChart(sl.series));

    // daily checks
    var hName = h('input', { type: 'text', id: 'hb-name', maxlength: '60', autocomplete: 'off' });
    var hRows = habits.map(function (hb) {
      var st2 = M.habitStats(s, hb.id, t);
      return h('div', { class: 'item habit', 'data-habit-row': hb.name },
        h('div', null, h('div', { class: 'entry-t', text: hb.name }),
          h('div', { class: 'mut small' }, h('span', { class: 'hb-rate', text: st2.checks7 + ' of 7 days (' + fmt1(st2.rate7) + '%)' }), ' | ', h('span', { class: 'hb-streak', text: st2.streak + '-day streak' }))),
        btn('Delete', function () {
          openDialog({ title: 'Delete this daily check?', yes: 'Delete', danger: true, body: h('p', { class: 'mut', text: hb.name + ' and its history will be removed.' }),
            onYes: function () { return commit(function (x) { M.deleteHabit(x, hb.id); }, 'daily check delete').then(function () { render(); }); } });
        }, 'sm bad', { 'aria-label': 'Delete daily check ' + hb.name }));
    });
    var overall = habits.length ? M.habitRate(s, L.metrics.addDays(t, -6), t) : null;
    var habitCard = h('div', { class: 'card', id: 'hl-habit-card' }, h('h2', { text: 'Daily checks (' + habits.length + ' of 8)' }),
      overall === null ? null : h('p', { class: 'small', id: 'hl-habit-rate', text: '7-day completion: ' + fmt1(overall) + '%' }),
      hRows.length ? hRows : h('p', { class: 'mut', text: 'Yes or no habits you tick once a day, for example protein target hit or mobility done.' }),
      h('form', {
        class: 'row',
        onsubmit: function (e) {
          e.preventDefault();
          act(function () {
            var n = hName.value.trim();
            if (!n) throw new Error('Enter a name for the daily check.');
            if (habits.length >= 8) throw new Error('You can keep up to 8 daily checks.');
            return commit(function (x) { M.addHabit(x, n); }, 'daily check add').then(done('Daily check added.'));
          });
        }
      }, field('New daily check', hName), h('button', { type: 'submit', class: 'btn', id: 'hb-add', text: 'Add daily check', disabled: habits.length >= 8 })));

    // targets, cycle, kinds
    var hsUnits = sel('hs-units', [{ v: 'lb', t: 'Pounds (lb)' }, { v: 'kg', t: 'Kilograms (kg)' }], unit);
    // Inputs show stored values to 0.1; an input left as shown keeps the stored value, so a save never rounds it.
    var inum = function (id, v) { var shown = v === undefined ? '' : fmt1(v); var el = h('input', { type: 'text', id: id, inputmode: 'decimal', autocomplete: 'off', maxlength: '8', value: shown }); el.dataset.shown = shown; return el; };
    var hsWs = inum('hs-wstart', hs.weightStart), hsWt = inum('hs-wtarget', hs.weightTarget), hsFs = inum('hs-fstart', hs.bodyFatStart), hsFt = inum('hs-ftarget', hs.bodyFatTarget);
    var hsWpw = h('input', { type: 'number', id: 'hs-wpw', min: '0', max: '21', step: '1', value: s.settings.targets.workoutsPerWeek });
    var fTargets = h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var ins = { weightStart: hsWs, weightTarget: hsWt, bodyFatStart: hsFs, bodyFatTarget: hsFt }, vals = {};
          Object.keys(ins).forEach(function (k) { if (ins[k].value.trim() !== ins[k].dataset.shown) vals[k] = numOrNull(ins[k].value); });
          var wpw = intIn(hsWpw.value, 0, 21, 'Workouts per week'), u = hsUnits.value;
          return commit(function (x) {
            // Values are typed in the units shown on the form, so store them first, then convert everything to the new units.
            Object.keys(vals).forEach(function (k) { if (vals[k] === null) delete x.settings.health[k]; else x.settings.health[k] = vals[k]; });
            M.setWeightUnits(x, u);
            x.settings.targets.workoutsPerWeek = wpw;
          }, 'health settings').then(done('Targets saved.'));
        });
      }
    }, h('h3', { text: 'Body targets' }), field('Weight units', hsUnits), field('Start weight (' + unit + ', optional)', hsWs), field('Target weight (' + unit + ')', hsWt),
      field('Start body fat % (optional)', hsFs), field('Target body fat %', hsFt), field('Workouts per week target', hsWpw),
      h('button', { type: 'submit', class: 'btn pri', id: 'hs-save', text: 'Save targets' }));

    var cy = s.cycle;
    var cyStart = h('input', { type: 'date', id: 'cy-start', value: cy ? cy.startDate : t });
    var cySprint = h('input', { type: 'number', id: 'cy-sprint', min: '1', max: '365', step: '1', value: cy ? cy.sprintDays : 28 });
    var cyCount = h('input', { type: 'number', id: 'cy-count', min: '1', max: '52', step: '1', value: cy ? cy.sprintsPerCycle : 3 });
    var cyRest = h('input', { type: 'number', id: 'cy-rest', min: '0', max: '90', step: '1', value: cy ? cy.restDays : 7 });
    var cyAlt = h('input', { type: 'checkbox', id: 'cy-alt', checked: cy ? cy.alternateHeavyLight : true });
    var cyFirst = sel('cy-first', [{ v: 'heavy', t: 'Heavy' }, { v: 'light', t: 'Light' }], cy ? cy.firstWeek : 'heavy');
    var fCycle = h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          if (!cyStart.value) throw new Error('Choose a start date.');
          var c = { startDate: cyStart.value, sprintDays: intIn(cySprint.value, 1, 365, 'Sprint days'), sprintsPerCycle: intIn(cyCount.value, 1, 52, 'Sprints per cycle'), restDays: intIn(cyRest.value, 0, 90, 'Rest days'), alternateHeavyLight: cyAlt.checked, firstWeek: cyFirst.value };
          return commit(function (x) { x.cycle = c; }, 'cycle set').then(done('Training cycle saved.'));
        });
      }
    }, h('h3', { text: 'Training cycle (optional)' }), field('Start date', cyStart), field('Days per sprint', cySprint), field('Sprints per cycle', cyCount), field('Rest days after the last sprint', cyRest),
      h('label', { class: 'field check' }, cyAlt, h('span', { text: 'Alternate heavy and light weeks' })), field('First week is', cyFirst),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn pri', id: 'cy-save', text: 'Save cycle' }),
        cy ? btn('Clear cycle', function () { act(function () { return commit(function (x) { x.cycle = null; }, 'cycle clear').then(done('Training cycle cleared.')); }); }, '', { id: 'cy-clear' }) : null));

    var kName = h('input', { type: 'text', id: 'kd-name', maxlength: '40', autocomplete: 'off' });
    var fKinds = h('div', null, h('h3', { text: 'Workout types' }),
      h('div', { class: 'chips', id: 'kd-list' }, kinds.map(function (k) {
        return h('span', { class: 'chip' }, k, h('button', { type: 'button', class: 'x', 'aria-label': 'Remove type ' + k, text: 'x', onclick: function () {
          act(function () { return commit(function (x) { x.kinds = x.kinds.filter(function (z) { return z !== k; }); }, 'workout types').then(done('Type removed.')); });
        } }));
      })),
      h('form', {
        class: 'row',
        onsubmit: function (e) {
          e.preventDefault();
          act(function () {
            var n = kName.value.trim();
            if (!n) throw new Error('Enter a workout type.');
            if (n.length > 40) throw new Error('A workout type is up to 40 characters.');
            if (kinds.length >= 30) throw new Error('You can keep up to 30 workout types.');
            if (kinds.some(function (k) { return k.toLowerCase() === n.toLowerCase(); })) throw new Error('That workout type already exists.');
            return commit(function (x) { x.kinds.push(n); }, 'workout types').then(done('Type added.'));
          });
        }
      }, field('New type', kName), h('button', { type: 'submit', class: 'btn', id: 'kd-add', text: 'Add type' })));
    var setup = details('hl-setup', 'Targets, cycle and workout types', [fTargets, h('hr'), fCycle, h('hr'), fKinds], false);

    return h('div', null, btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'), h('h1', { text: 'Health' }),
      h('p', { class: 'mut small', text: 'A tracker for your own numbers. It gives no medical advice.' }),
      todayCard, wkCard, bodyCard, sleepCard, habitCard, setup,
      h('h2', { text: 'All health entries' }),
      domainScreen(s, { embed: true }));
  }

  // ---------- goals (v0.6.0) ----------
  var STATUS_CHIP = { ahead: 'ok', 'on-track': 'ok', behind: 'bad', 'no-data': '' };
  var goalMemo = new Map(); // linked values for one render pass; reset at the start of each goals screen and review step
  function goalTitle(s, id) {
    var g = (s.goals || []).filter(function (x) { return x.id === id; })[0];
    return g ? g.title : '';
  }
  function paceText(s, g, ev) {
    if (ev.progress === null) return 'No data yet';
    return L.goals.PACE_LABEL[ev.pace] + ': ' + L.goals.pct(ev.progress) + ' done, ' + L.goals.pct(ev.elapsed) + ' of the time elapsed';
  }
  function parentOptions(s, horizon, selfId, cur) {
    var rank = L.goals.HORIZONS.indexOf(horizon);
    var list = (s.goals || []).filter(function (g) { return g.state !== 'dropped' && g.id !== selfId && L.goals.HORIZONS.indexOf(g.horizon) > rank; });
    return [{ v: '', t: '(no parent)' }].concat(list.map(function (g) { return { v: g.id, t: g.title + ' (' + L.goals.HORIZON_LABEL[g.horizon] + ')' }; }));
  }
  function askDeleteGoal(s, g) {
    var n = L.goals.childrenOf(s, g.id).length;
    openDialog({
      title: 'Delete this goal?', yes: 'Delete goal', danger: true,
      body: [h('p', { class: 'mut', text: g.title }),
        h('p', { class: 'small', id: 'goal-del-info', text: n + (n === 1 ? ' child goal is' : ' child goals are') + ' kept and unlinked from this goal. The goal itself is removed.' })],
      onYes: function () { return commit(function (x) { L.goals.deleteGoal(x, g.id); }, 'goal delete').then(function () { setNotice('ok', 'Goal deleted.'); render(); }); }
    });
  }
  function editGoalDialog(s, g) {
    var title = h('input', { type: 'text', id: 'ge-title', maxlength: '200', value: g.title });
    var target = h('input', { type: 'text', id: 'ge-target', inputmode: 'decimal', maxlength: '20', value: String(g.targetValue) });
    var due = h('input', { type: 'date', id: 'ge-due', value: g.dueDate });
    var parent = sel('ge-parent', parentOptions(s, g.horizon, g.id), g.parentId || '');
    var notes = h('textarea', { id: 'ge-notes', maxlength: '2000', value: g.notes || '' });
    openDialog({
      title: 'Edit goal', yes: 'Save',
      body: [field('Title', title), field('Target', target), field('Due date', due), field('Parent goal (a longer horizon)', parent), field('Notes (optional)', notes)],
      onYes: function () {
        return commit(function (x) { L.goals.updateGoal(x, g.id, { title: title.value, targetValue: target.value, dueDate: due.value, parentId: parent.value || null, notes: notes.value }); }, 'goal edit').then(function () { setNotice('ok', 'Goal saved.'); render(); });
      }
    });
  }
  function goalItem(s, g, t, opts) {
    opts = opts || {};
    var ev = L.goals.evaluate(s, g, t, goalMemo), active = g.state === 'active';
    var chips = [h('span', { class: 'chip', text: L.goals.HORIZON_LABEL[g.horizon] }), h('span', { class: 'chip', text: (L.goals.metricDef(g.metric) || {}).label || g.metric })];
    if (active) chips.push(h('span', { class: 'chip g-status ' + STATUS_CHIP[ev.status], text: L.goals.PACE_LABEL[ev.status] + (ev.overridden ? ' (set by you)' : '') }));
    else chips.push(h('span', { class: 'chip ' + (g.state === 'achieved' ? 'ok' : 'bad'), text: g.state }));
    var kids = [
      h('div', { class: 'row sp' }, h('strong', { class: 'entry-t', text: g.title }), h('span', null, chips)),
      h('p', { class: 'small g-now', text: 'Start ' + L.goals.fmtValue(s, g, g.startValue) + ', now ' + L.goals.fmtValue(s, g, ev.current) + ', target ' + L.goals.fmtValue(s, g, g.targetValue) + '. ' + g.startDate + ' to ' + g.dueDate + '.' })
    ];
    if (active) {
      kids.push(h('p', { class: 'small g-progress', text: ev.progress === null ? 'No data yet' : Math.round(ev.progress * 1000) / 10 + '%' }));
      kids.push(svgBar(ev.progress === null ? 0 : Math.round(ev.progress * 100), ev.status === 'behind' ? 'bar-over' : 'bar-fill'));
      kids.push(h('p', { class: 'small mut g-pace', text: paceText(s, g, ev) }));
      if (ev.reached) kids.push(h('p', { class: 'small g-reached', text: 'Target reached. Mark this goal achieved when you are ready.' }));
      if (g.metric === 'manual') {
        var cur = h('input', { type: 'text', class: 'g-manual', inputmode: 'decimal', maxlength: '20', 'aria-label': 'Current value for ' + g.title, value: g.manualValue === undefined ? '' : String(g.manualValue) });
        kids.push(h('div', { class: 'row' }, cur, btn('Update value', function () {
          act(function () { return commit(function (x) { L.goals.setManualValue(x, g.id, cur.value); }, 'goal value').then(function () { setNotice('ok', 'Value updated.'); render(); }); });
        }, 'sm g-setval')));
      }
      var ov = sel(null, [{ v: '', t: 'Pace from the numbers' }, { v: 'ahead', t: 'Mark ahead' }, { v: 'on-track', t: 'Mark on track' }, { v: 'behind', t: 'Mark behind' }], g.statusOverride || '', function (e) {
        var v = e.target.value;
        act(function () { return commit(function (x) { L.goals.setOverride(x, g.id, v || null); }, 'goal status').then(function () { render(); }); });
      });
      ov.setAttribute('aria-label', 'Status for ' + g.title);
      ov.setAttribute('class', 'g-override');
      kids.push(h('div', { class: 'row' }, ov));
      var acts = [
        btn('Mark achieved', function () { act(function () { return commit(function (x) { L.goals.achieveGoal(x, g.id, t); }, 'goal achieved').then(function () { setNotice('ok', 'Goal marked achieved.'); render(); }); }); }, 'sm g-achieve' + (ev.reached ? ' pri' : '')),
        btn('Edit', function () { editGoalDialog(s, g); }, 'sm g-edit'),
        btn('Drop', function () { act(function () { return commit(function (x) { L.goals.dropGoal(x, g.id, t); }, 'goal dropped').then(function () { setNotice('ok', 'Goal dropped.'); render(); }); }); }, 'sm g-drop')
      ];
      if ((g.horizon === 'weekly' || g.horizon === 'monthly') && g.dueDate < t) acts.push(btn('Roll into next period', function () { rollGoal(g, t); }, 'sm g-roll'));
      acts.push(btn('Delete', function () { askDeleteGoal(s, g); }, 'sm bad g-delete'));
      kids.push(h('div', { class: 'row' }, acts));
    } else {
      kids.push(h('div', { class: 'row' },
        btn('Reopen', function () { act(function () { return commit(function (x) { L.goals.reopenGoal(x, g.id); }, 'goal reopened').then(function () { render(); }); }); }, 'sm g-reopen'),
        btn('Delete', function () { askDeleteGoal(s, g); }, 'sm bad g-delete')));
    }
    return h('div', { class: 'goal' + (opts.depth ? ' goal-child' : ''), 'data-goal': g.title, 'data-state': g.state }, kids);
  }
  function rollGoal(g, t) {
    act(function () { return commit(function (x) { L.goals.rollOver(x, g.id, t); }, 'goal rolled over').then(function () { setNotice('ok', 'Goal moved into its next period.'); render(); }); });
  }
  function goalTree(s, node, t, depth) {
    return h('div', { class: 'gnode' }, goalItem(s, node.goal, t, { depth: depth }),
      node.children.length ? h('div', { class: 'gkids' }, node.children.map(function (c) { return goalTree(s, c, t, depth + 1); })) : null);
  }
  function goalForm(s, t) {
    var title = h('input', { type: 'text', id: 'g-title', maxlength: '200', autocomplete: 'off', required: true });
    var horizon = sel('g-horizon', L.goals.HORIZONS.map(function (x) { return { v: x, t: L.goals.HORIZON_LABEL[x] }; }), 'quarterly');
    var metric = sel('g-metric', L.goals.METRICS.map(function (m) { return { v: m.id, t: m.label }; }), 'manual');
    var dir = sel('g-dir', [{ v: 'up', t: 'Goes up' }, { v: 'down', t: 'Goes down' }], 'up');
    var start = h('input', { type: 'text', id: 'g-start', inputmode: 'decimal', maxlength: '20', autocomplete: 'off' });
    var target = h('input', { type: 'text', id: 'g-target', inputmode: 'decimal', maxlength: '20', autocomplete: 'off', required: true });
    var sdate = h('input', { type: 'date', id: 'g-sdate', value: t, required: true });
    var due = h('input', { type: 'date', id: 'g-due' });
    var parent = sel('g-parent', parentOptions(s, 'quarterly'), '');
    var domain = sel('g-domain', L.DOMAINS.map(function (d) { return { v: d.id, t: d.label }; }), 'goals');
    var curIn = h('input', { type: 'text', id: 'g-cur', inputmode: 'decimal', maxlength: '20', autocomplete: 'off' });
    var notes = h('textarea', { id: 'g-notes', maxlength: '2000' });
    var manualBox = h('div', { id: 'g-manual-box' }, field('Area (manual goals only)', domain), field('Current value (optional)', curIn));
    function sync() {
      var man = metric.value === 'manual';
      manualBox.setAttribute('class', man ? '' : 'hidden');
      parent.replaceChildren.apply(parent, parentOptions(s, horizon.value).map(function (o) { return h('option', { value: o.v, text: o.t }); }));
    }
    horizon.addEventListener('change', sync);
    metric.addEventListener('change', sync);
    return h('form', {
      id: 'goal-form',
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var p = { title: title.value, horizon: horizon.value, metric: metric.value, direction: dir.value, startValue: start.value, targetValue: target.value, startDate: sdate.value, dueDate: due.value || undefined, parentId: parent.value || undefined, notes: notes.value };
          if (metric.value === 'manual') { p.domain = domain.value; p.manualValue = curIn.value; }
          return commit(function (x) { L.goals.addGoal(x, p, t); }, 'goal add').then(function () { setNotice('ok', 'Goal added.'); render(); });
        });
      }
    }, field('Title', title), field('Horizon', horizon), field('What it measures', metric), field('Direction', dir),
      field('Start value', start, 'Leave blank to start from the current value of a linked metric.'), field('Target', target),
      field('Start date', sdate), field('Due date (blank: end of the period)', due), field('Parent goal (a longer horizon, optional)', parent),
      manualBox, field('Notes (optional)', notes),
      h('button', { type: 'submit', class: 'btn pri', id: 'g-add', text: 'Add goal' }));
  }
  function goalsScreen(s) {
    goalMemo = new Map();
    var t = today(), G = L.goals, sum = G.summary(s, t), lad = G.ladder(s);
    var closed = (s.goals || []).filter(function (g) { return g.state !== 'active'; });
    var stats = h('div', { class: 'stats' },
      stat('Active goals', String(sum.active), 'gl-active'),
      stat('On track or ahead', sum.share === null ? 'n/a' : Math.round(sum.share * 100) + '%', 'gl-share'),
      stat('Behind', String(sum.behind), 'gl-behind', sum.behind ? 'bad-t' : ''),
      stat('Next due', sum.nextDue || 'none', 'gl-next'));
    var ladderCard = h('div', { class: 'card', id: 'goal-ladder' }, h('h2', { text: 'Ladder' }),
      lad.roots.length ? lad.roots.map(function (n) { return goalTree(s, n, t, 0); }) : h('p', { class: 'mut', text: 'No goals are linked yet. Pick a parent on a longer horizon when you add or edit a goal.' }));
    var unl = h('div', { class: 'card', id: 'goal-unlinked' }, h('h2', { text: 'Not linked (' + lad.unlinked.length + ')' }),
      lad.unlinked.length ? lad.unlinked.map(function (g) { return goalItem(s, g, t); }) : h('p', { class: 'mut', text: 'Nothing here.' }));
    return h('div', null, btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'), h('h1', { text: 'Goals' }),
      h('p', { class: 'mut small', text: 'Progress comes from your own numbers and pace is arithmetic. Nothing is marked achieved, dropped or rolled over unless you tap it.' }),
      stats, ladderCard, unl,
      details('goal-add', 'Add a goal', goalForm(s, t), !(s.goals || []).length),
      closed.length ? details('goal-closed', 'Achieved and dropped (' + closed.length + ')', closed.map(function (g) { return goalItem(s, g, t); }), false) : null,
      legacyGoalEntries(s));
  }
  // Goal entries from before v0.6.0 that the upgrade kept (a history too long for one goal's notes, or titles beyond the cap). Read only.
  function legacyGoalEntries(s) {
    var old = s.entries.filter(function (e) { return e.domain === 'goals' && e.type === 'goal'; })
      .sort(function (a, b) { return b.date.localeCompare(a.date); });
    if (!old.length) return null;
    var shown = old.slice(0, 200);
    return details('goal-legacy', 'Older goal entries (' + old.length + (old.length > shown.length ? ', newest ' + shown.length + ' shown' : '') + ')', shown.map(function (e) {
      return h('div', { class: 'item g-legacy' }, h('div', null, h('span', { class: 'entry-t', text: e.title }),
        h('span', { class: 'mut small', text: ' ' + e.date + ', ' + (e.status || '') }), e.notes ? h('p', { class: 'small mut', text: e.notes }) : null));
    }), false);
  }
  // Weekly review step: goals due this week, pace changes since last week, and roll-over offers (never automatic).
  function reviewGoalsCard(s, wk, t) {
    goalMemo = new Map();
    var G = L.goals, r = G.reviewGoals(s, wk, t);
    if (!(s.goals || []).some(function (g) { return g.state === 'active'; })) return h('p', { class: 'mut', id: 'rv-goals-none', text: 'No active goals. Add some under Goals.' });
    var line = function (g, extra) { return h('div', { class: 'item rv-goal', 'data-goal': g.title }, h('div', null, h('span', { class: 'entry-t', text: g.title }), h('span', { class: 'mut small', text: ' ' + extra }))); };
    var kids = [];
    kids.push(h('p', { class: 'small', id: 'rv-goals-due-h', text: 'Due this week (' + r.due.length + ')' }));
    r.due.forEach(function (g) { kids.push(line(g, 'due ' + g.dueDate + '. ' + paceText(s, g, G.evaluate(s, g, t, goalMemo)))); });
    if (r.overdue.length) {
      kids.push(h('p', { class: 'small', id: 'rv-goals-overdue-h', text: 'Past due and still active (' + r.overdue.length + ')' }));
      r.overdue.forEach(function (g) { kids.push(line(g, 'was due ' + g.dueDate)); });
    }
    kids.push(h('p', { class: 'small', id: 'rv-goals-changes-h', text: 'Pace changes since last week (' + r.changes.length + ')' }));
    r.changes.forEach(function (c) { kids.push(h('div', { class: 'item rv-change', 'data-goal': c.title }, h('div', null, h('span', { class: 'entry-t', text: c.title }), h('span', { class: 'mut small', text: ' ' + G.PACE_LABEL[c.from] + ' to ' + G.PACE_LABEL[c.to] })))); });
    if (r.roll.length) {
      kids.push(h('p', { class: 'small', id: 'rv-goals-roll-h', text: 'Unfinished weekly and monthly goals (' + r.roll.length + ')' }));
      kids.push(h('p', { class: 'mut small', text: 'Nothing is rolled over until you tap it.' }));
      r.roll.forEach(function (g) {
        kids.push(h('div', { class: 'item rv-roll', 'data-goal': g.title }, h('div', null, h('span', { class: 'entry-t', text: g.title }), h('span', { class: 'mut small', text: ' ' + G.HORIZON_LABEL[g.horizon] + ', due ' + g.dueDate })),
          btn('Roll into next period', function () { rollGoal(g, t); }, 'sm rv-roll-btn')));
      });
    }
    return h('div', { class: 'card', id: 'rv-goals' }, kids);
  }

  // ---------- home and admin (v0.7.0) ----------
  // Nothing here creates a recurring item by itself: finishing a recurring task or renewal shows a proposal that needs a tap.
  var CAD_OPTS = function (map, order) { return order.map(function (k) { return { v: k, t: map[k] }; }); };
  var PROP_LABEL = { house: 'House', condo: 'Condo', rental: 'Rental', land: 'Land', other: 'Other' };
  function homeName(s, m) {
    var parts = [];
    var live = L.home.liveProps(s);
    if (m.propertyId && live.length > 1) { var p = (s.properties || []).filter(function (x) { return x.id === m.propertyId; })[0]; if (p) parts.push(p.name); }
    if (m.vehicleId) { var v = (s.vehicles || []).filter(function (x) { return x.id === m.vehicleId; })[0]; if (v) parts.push(v.name); }
    return parts.join(', ');
  }
  function dateField(id, label, val, req) { return field(label, h('input', { type: 'date', id: id, value: val || '', required: req ? true : null })); }
  function markDoneDialog(s, m) {
    var d = h('input', { type: 'date', id: 'md-date', value: today() });
    var cost = h('input', { type: 'text', id: 'md-cost', inputmode: 'decimal', autocomplete: 'off', maxlength: '14' });
    var odo = m.vehicleId ? h('input', { type: 'text', id: 'md-odo', inputmode: 'numeric', autocomplete: 'off', maxlength: '9' }) : null;
    openDialog({
      title: 'Mark this task done', yes: 'Mark done',
      body: [h('p', { class: 'mut', text: m.title }), field('Date done', d), field('Cost (optional)', cost), odo ? field('Odometer reading (optional)', odo) : null,
        m.cadence !== 'once' ? h('p', { class: 'small', text: 'The next one is only proposed. You confirm it before anything is created.' }) : null],
      onYes: function () {
        var prop;
        return commit(function (x) { prop = L.home.completeMaintenance(x, m.id, { doneDate: d.value, cost: cost.value, odometer: odo ? odo.value : '' }, today()); }, 'maintenance done').then(function () {
          setNotice('ok', prop ? 'Marked done. The next one is proposed below.' : 'Marked done.'); render();
        });
      }
    });
  }
  function maintRow(s, m, cls) {
    var sub = [];
    if (m.nextDue) sub.push('due ' + m.nextDue);
    if (m.cadence !== 'once') sub.push(L.home.CADENCE_LABEL[m.cadence] + (m.everyDays ? ' ' + m.everyDays + ' days' : ''));
    if (m.area) sub.push(m.area);
    var nm = homeName(s, m); if (nm) sub.push(nm);
    return h('div', { class: 'item mt-row' + (cls ? ' ' + cls : ''), 'data-title': m.title },
      h('div', null, h('div', { class: 'entry-t', text: m.title }), h('div', { class: 'mut small', text: sub.join(' | ') })),
      h('div', { class: 'row' },
        btn('Done', function () { markDoneDialog(s, m); }, 'sm pri mt-done', { 'aria-label': 'Mark ' + m.title + ' done' }),
        btn('Skip', function () { act(function () { return commit(function (x) { L.home.skipMaintenance(x, m.id); }, 'maintenance skip').then(render); }); }, 'sm', { 'aria-label': 'Skip ' + m.title }),
        btn('Delete', function () { act(function () { return commit(function (x) { L.home.deleteMaintenance(x, m.id); }, 'maintenance delete').then(render); }); }, 'sm bad', { 'aria-label': 'Delete ' + m.title })));
  }
  function proposalsCard(s, items, kind) {
    if (!items.length) return null;
    var isHome = kind === 'home';
    return h('div', { class: 'card', id: isHome ? 'hm-proposals' : 'ad-proposals' },
      h('h2', { text: 'Proposed next ' + (isHome ? 'tasks' : 'renewals') + ' (' + items.length + ')' }),
      h('p', { class: 'mut small', text: 'Nothing is created until you confirm it.' }),
      items.map(function (p) {
        var due = h('input', { type: 'date', value: isHome ? p.nextDue : p.dueDate, 'aria-label': 'Next date for ' + p.title, class: 'prop-date' });
        return h('div', { class: 'item prop-row', 'data-title': p.title },
          h('div', null, h('div', { class: 'entry-t', text: p.title }), h('div', { class: 'mut small', text: 'Next due ' + (isHome ? p.nextDue : p.dueDate) })),
          h('div', { class: 'row' }, due,
            btn('Confirm', function () {
              act(function () {
                return commit(function (x) { if (isHome) L.home.confirmNext(x, p.fromId, due.value); else L.admin.confirmRenewal(x, p.fromId, due.value); }, isHome ? 'maintenance next confirmed' : 'renewal next confirmed')
                  .then(function () { setNotice('ok', 'Created the next one.'); render(); });
              });
            }, 'sm pri prop-confirm', { 'aria-label': 'Confirm next ' + p.title }),
            btn('Stop repeating', function () {
              act(function () { return commit(function (x) { if (isHome) L.home.stopRepeating(x, p.fromId); else L.admin.stopRenewing(x, p.fromId); }, 'stop repeating').then(render); });
            }, 'sm prop-stop', { 'aria-label': 'Stop repeating ' + p.title })));
      }));
  }
  function homeScreen(s) {
    var t = today(), H = L.home, cur = s.settings.currency, sum = H.summary(s, t);
    var live = H.liveProps(s), vehicles = H.liveVehicles(s);
    var stats = h('div', { class: 'stats' },
      stat('Tasks overdue', String(sum.overdue.length), 'hm-overdue', sum.overdue.length ? 'bad-t' : ''),
      stat('Due in 30 days', String(sum.due30.length), 'hm-due30'),
      stat('Maintenance cost this year', moneyFmt(sum.ytdCostCents, cur), 'hm-ytd'),
      stat('Household bills per month', moneyFmt(sum.bills.totalMonthlyCents, cur), 'hm-bills-total'));

    // starter checklist (offered once; nothing is added until the user ticks and taps)
    var starter = null;
    if (sum.starter.length) {
      var boxes = sum.starter.map(function (x) {
        return h('label', { class: 'field check' }, h('input', { type: 'checkbox', 'data-starter': x.id }), h('span', { text: x.title + ' (' + H.CADENCE_LABEL[x.cadence].toLowerCase() + ')' }));
      });
      starter = h('div', { class: 'card', id: 'hm-starter' }, h('h2', { text: 'Seasonal checklist' }),
        h('p', { class: 'mut small', text: 'A starting list. Nothing is added unless you tick it. This is offered once.' }), boxes,
        h('div', { class: 'row' },
          btn('Add ticked tasks', function () {
            act(function () {
              var ids = [];
              boxes.forEach(function (b) { var i = b.querySelector('input'); if (i.checked) ids.push(i.getAttribute('data-starter')); });
              if (!ids.length) throw new Error('Tick at least one task, or choose No thanks.');
              return commit(function (x) { H.addStarter(x, ids, t); }, 'starter checklist').then(function () { setNotice('ok', 'Added ' + ids.length + (ids.length === 1 ? ' task.' : ' tasks.')); render(); });
            });
          }, 'sm pri', { id: 'hm-starter-go' }),
          btn('No thanks', function () { act(function () { return commit(function (x) { H.dismissStarter(x); }, 'starter dismissed').then(render); }); }, 'sm', { id: 'hm-starter-skip' })));
    }

    var overdueCard = h('div', { class: 'card', id: 'hm-overdue-list' }, h('h2', { text: 'Overdue (' + sum.overdue.length + ')' }),
      sum.overdue.length ? sum.overdue.map(function (m) { return maintRow(s, m); }) : h('p', { class: 'mut', text: 'Nothing overdue.' }));
    var dueCard2 = h('div', { class: 'card', id: 'hm-due30-list' }, h('h2', { text: 'Due in the next 30 days (' + sum.due30.length + ')' }),
      sum.due30.length ? sum.due30.map(function (m) { return maintRow(s, m); }) : h('p', { class: 'mut', text: 'Nothing due in the next 30 days.' }));

    var shown = {};
    sum.overdue.concat(sum.due30).forEach(function (m) { shown[m.id] = true; });
    var later = (s.maintenance || []).filter(function (m) { return m.state === 'open' && !shown[m.id]; }).sort(function (a, b) { return (a.nextDue || '9999').localeCompare(b.nextDue || '9999') || a.title.localeCompare(b.title); });
    var laterCard = h('div', { class: 'card', id: 'hm-later' }, h('h2', { text: 'Later and undated (' + later.length + ')' }),
      later.length ? later.map(function (m) { return maintRow(s, m); }) : h('p', { class: 'mut', text: 'Nothing else is scheduled.' }));

    // add a task
    var mT = h('input', { type: 'text', id: 'mt-title', maxlength: '200', autocomplete: 'off' });
    var mArea = h('input', { type: 'text', id: 'mt-area', maxlength: '60', autocomplete: 'off' });
    var mProp = live.length > 1 ? sel('mt-prop', [{ v: '', t: '(none)' }].concat(live.map(function (p) { return { v: p.id, t: p.name }; })), '') : null;
    var mVeh = vehicles.length ? sel('mt-veh', [{ v: '', t: '(none)' }].concat(vehicles.map(function (v) { return { v: v.id, t: v.name }; })), '') : null;
    var mCad = sel('mt-cadence', CAD_OPTS(H.CADENCE_LABEL, H.CADENCES), 'once');
    var mEvery = h('input', { type: 'text', id: 'mt-every', inputmode: 'numeric', maxlength: '4', autocomplete: 'off' });
    var mDue = h('input', { type: 'date', id: 'mt-due' });
    var mVendor = h('input', { type: 'text', id: 'mt-vendor', maxlength: '200', autocomplete: 'off' });
    var mNotes = h('textarea', { id: 'mt-notes', maxlength: '2000' });
    var addForm = details('hm-add', 'Add a task', [h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var input = { title: mT.value, area: mArea.value, cadence: mCad.value, everyDays: mEvery.value, nextDue: mDue.value, vendor: mVendor.value, notes: mNotes.value,
            propertyId: mProp ? mProp.value : (live.length === 1 ? live[0].id : ''), vehicleId: mVeh ? mVeh.value : '' };
          return commit(function (x) { H.addMaintenance(x, input); }, 'maintenance add').then(function () { view.open = 'hm-add'; setNotice('ok', 'Task added.'); render(); });
        });
      }
    }, field('Task', mT), field('Area (optional)', mArea), mProp ? field('Property', mProp) : null, mVeh ? field('Vehicle (optional)', mVeh) : null,
      field('Repeats', mCad), field('Days between (custom repeat only)', mEvery), field('Next due date', mDue), field('Vendor (optional)', mVendor), field('Notes (optional)', mNotes),
      h('button', { type: 'submit', class: 'btn pri', id: 'mt-add', text: 'Add task' }))], view.open === 'hm-add' || (!(s.maintenance || []).length && !sum.starter.length));

    // properties
    var pName = h('input', { type: 'text', id: 'pr-name', maxlength: '200', autocomplete: 'off' });
    var pKind = sel('pr-kind', CAD_OPTS(PROP_LABEL, H.PROPERTY_KINDS), 'house');
    var props = details('hm-props', 'Properties (' + (s.properties || []).length + ')', [
      (s.properties || []).map(function (p) {
        return h('div', { class: 'item pr-row' }, h('div', null, h('span', { class: 'entry-t', text: p.name }), h('span', { class: 'mut small', text: ' ' + PROP_LABEL[p.kind] + (p.archived ? ', archived' : '') })),
          h('div', { class: 'row' },
            btn(p.archived ? 'Restore' : 'Archive', function () { act(function () { return commit(function (x) { H.setArchived(x, 'properties', p.id, !p.archived); }, 'property archive').then(function () { view.open = 'hm-props'; render(); }); }); }, 'sm'),
            btn('Delete', function () {
              var n = H.linkedCount(s, 'propertyId', p.id);
              openDialog({ title: 'Delete this property?', yes: 'Delete property', danger: true,
                body: [h('p', { class: 'mut', text: p.name }), h('p', { class: 'small', text: n + (n === 1 ? ' task is' : ' tasks are') + ' kept and unlinked from this property.' })],
                onYes: function () { return commit(function (x) { H.deleteProperty(x, p.id); }, 'property delete').then(function () { view.open = 'hm-props'; render(); }); } });
            }, 'sm bad', { 'aria-label': 'Delete ' + p.name })));
      }),
      h('form', { onsubmit: function (e) { e.preventDefault(); act(function () { return commit(function (x) { H.addProperty(x, { name: pName.value, kind: pKind.value }); }, 'property add').then(function () { view.open = 'hm-props'; setNotice('ok', 'Property added.'); render(); }); }); } },
        field('Name', pName), field('Kind', pKind), h('button', { type: 'submit', class: 'btn pri', id: 'pr-add', text: 'Add property' }))],
      view.open === 'hm-props' || !(s.properties || []).length);

    // vehicles
    var vName = h('input', { type: 'text', id: 'vh-name', maxlength: '200', autocomplete: 'off' });
    var vYear = h('input', { type: 'text', id: 'vh-year', inputmode: 'numeric', maxlength: '4', autocomplete: 'off' });
    var vOdo = h('input', { type: 'text', id: 'vh-odo', inputmode: 'numeric', maxlength: '9', autocomplete: 'off' });
    var vUnit = sel('vh-unit', [{ v: 'mi', t: 'Miles' }, { v: 'km', t: 'Kilometres' }], 'mi');
    var vehCard = details('hm-vehicles', 'Vehicles (' + (s.vehicles || []).length + ')', [
      sum.vehicles.map(function (v) {
        return h('div', { class: 'item vh-row', 'data-name': v.name },
          h('div', null, h('span', { class: 'entry-t', text: v.name + (v.year ? ' (' + v.year + ')' : '') }),
            h('div', { class: 'mut small', text: (v.odometer !== undefined ? v.odometer + ' ' + v.unit : 'no odometer reading') + ' | ' + (v.last ? 'last service ' + v.last.date + (v.last.odometer !== undefined ? ' at ' + v.last.odometer + ' ' + v.unit : '') : 'no service recorded') })),
          btn('Delete', function () {
            var n = H.linkedCount(s, 'vehicleId', v.id);
            openDialog({ title: 'Delete this vehicle?', yes: 'Delete vehicle', danger: true,
              body: [h('p', { class: 'mut', text: v.name }), h('p', { class: 'small', text: n + (n === 1 ? ' service record is' : ' service records are') + ' kept and unlinked from this vehicle.' })],
              onYes: function () { return commit(function (x) { H.deleteVehicle(x, v.id); }, 'vehicle delete').then(function () { view.open = 'hm-vehicles'; render(); }); } });
          }, 'sm bad', { 'aria-label': 'Delete ' + v.name }));
      }),
      h('form', { onsubmit: function (e) { e.preventDefault(); act(function () { return commit(function (x) { H.addVehicle(x, { name: vName.value, year: vYear.value, odometer: vOdo.value, odometerUnit: vUnit.value }); }, 'vehicle add').then(function () { view.open = 'hm-vehicles'; setNotice('ok', 'Vehicle added.'); render(); }); }); } },
        field('Name', vName), field('Year (optional)', vYear), field('Odometer (optional)', vOdo), field('Unit', vUnit), h('button', { type: 'submit', class: 'btn pri', id: 'vh-add', text: 'Add vehicle' }))],
      view.open === 'hm-vehicles' || !(s.vehicles || []).length);

    // household bills: Money recurring items with a household flag
    var others = (s.recurring || []).filter(function (r) { return !r.household && r.type === 'expense'; });
    var pick = others.length ? sel('hb-pick', others.map(function (r) { return { v: r.id, t: r.title }; }), others[0].id) : null;
    var billsCard = h('div', { class: 'card', id: 'hm-bills' }, h('h2', { text: 'Household bills' }),
      h('p', { class: 'mut small', text: 'These are your Money recurring items flagged as household. There is no second list. Weekly counts 52 a year, yearly counts once.' }),
      sum.bills.items.length ? sum.bills.items.map(function (b) {
        return h('div', { class: 'item hb-row', 'data-title': b.title }, h('div', null, h('span', { class: 'entry-t', text: b.title }), h('span', { class: 'mut small', text: ' ' + moneyFmt(b.cents, cur) + ' ' + b.cadence + ', ' + moneyFmt(b.monthlyCents, cur) + ' per month' })),
          btn('Remove flag', function () { act(function () { return commit(function (x) { H.setHousehold(x, b.id, false); }, 'household flag off').then(render); }); }, 'sm', { 'aria-label': 'Remove ' + b.title + ' from household bills' }));
      }) : h('p', { class: 'mut', text: 'No household bills flagged yet.' }),
      pick ? h('div', { class: 'row' }, pick, btn('Flag as household', function () { act(function () { return commit(function (x) { H.setHousehold(x, pick.value, true); }, 'household flag on').then(render); }); }, 'sm pri', { id: 'hb-add' })) : h('p', { class: 'mut small', text: 'Add recurring expenses under Money to flag them here.' }));

    var done = (s.maintenance || []).filter(function (m) { return m.state === 'done'; }).sort(function (a, b) { return (b.lastDone || '').localeCompare(a.lastDone || ''); }).slice(0, 50);
    var hist = details('hm-history', 'Recent history (' + done.length + ')', done.length ? done.map(function (m) {
      return h('div', { class: 'item hist-row' }, h('div', null, h('span', { class: 'entry-t', text: m.title }), h('div', { class: 'mut small', text: 'done ' + m.lastDone + (typeof m.cost === 'number' ? ' | ' + moneyFmt(m.cost, cur) : '') + (m.vendor ? ' | ' + m.vendor : '') })));
    }) : h('p', { class: 'mut', text: 'Nothing finished yet.' }), false);

    return h('div', null, btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'), h('h1', { text: 'Home' }),
      h('p', { class: 'mut small', text: 'Dates and costs are your own numbers. Nothing repeats unless you confirm it.' }),
      stats, proposalsCard(s, sum.proposals, 'home'), starter, overdueCard, dueCard2, laterCard, addForm, billsCard,
      h('div', { class: 'card', id: 'hm-vehicle-card' }, h('h2', { text: 'Vehicles' }),
        sum.vehicles.length ? sum.vehicles.map(function (v) { return h('p', { class: 'small vh-sum' }, v.name + ': ' + (v.last ? 'last service ' + v.last.date : 'no service recorded')); }) : h('p', { class: 'mut', text: 'No vehicles yet.' })),
      vehCard, props, hist);
  }

  function renewalRow(s, r) {
    var cur = s.settings.currency;
    var sub = [L.admin.KIND_LABEL[r.kind], 'due ' + r.dueDate];
    if (r.cadence !== 'once') sub.push(L.admin.CADENCE_LABEL[r.cadence] + (r.everyDays ? ' ' + r.everyDays + ' days' : ''));
    if (typeof r.amount === 'number') sub.push(moneyFmt(r.amount, cur));
    if (r.provider) sub.push(r.provider);
    if (r.autoRenews) sub.push('auto renews');
    return h('div', { class: 'item rn-row', 'data-title': r.title },
      h('div', null, h('div', { class: 'entry-t', text: r.title }), h('div', { class: 'mut small', text: sub.join(' | ') })),
      h('div', { class: 'row' },
        btn('Done', function () {
          var d = h('input', { type: 'date', id: 'rd-date', value: today() });
          openDialog({ title: 'Mark this renewal done', yes: 'Mark done',
            body: [h('p', { class: 'mut', text: r.title }), field('Date done', d), r.cadence !== 'once' ? h('p', { class: 'small', text: 'The next one is only proposed. You confirm it before anything is created.' }) : null],
            onYes: function () { var p; return commit(function (x) { p = L.admin.completeRenewal(x, r.id, d.value, today()); }, 'renewal done').then(function () { setNotice('ok', p ? 'Marked done. The next one is proposed.' : 'Marked done.'); render(); }); } });
        }, 'sm pri rn-done', { 'aria-label': 'Mark ' + r.title + ' done' }),
        btn('Cancel it', function () { act(function () { return commit(function (x) { L.admin.cancelRenewal(x, r.id); }, 'renewal cancel').then(render); }); }, 'sm', { 'aria-label': 'Mark ' + r.title + ' cancelled' }),
        btn('Delete', function () { act(function () { return commit(function (x) { L.admin.deleteRenewal(x, r.id); }, 'renewal delete').then(render); }); }, 'sm bad', { 'aria-label': 'Delete ' + r.title })));
  }
  function tlItem(x) {
    return h('div', { class: 'item tl-row', 'data-title': x.title }, h('div', null, h('span', { class: 'entry-t', text: x.title }), h('span', { class: 'mut small', text: ' ' + x.date + ' | ' + (x.kind in L.admin.KIND_LABEL ? L.admin.KIND_LABEL[x.kind] : x.kind) })));
  }
  function adminScreen(s) {
    var t = today(), A = L.admin, cur = s.settings.currency, tl = A.timeline(s, t), subs = A.subscriptions(s, t);
    var stats = h('div', { class: 'stats' },
      stat('Due in 30 days', String(tl.d30.length), 'ad-due30'),
      stat('Overdue', String(tl.overdue.length), 'ad-overdue', tl.overdue.length ? 'bad-t' : ''),
      stat('Subscriptions per month', moneyFmt(subs.monthlyCents, cur), 'ad-sub-month'),
      stat('Subscriptions per year', moneyFmt(subs.annualCents, cur), 'ad-sub-year'));
    var group = function (id, title, items) {
      return h('div', { id: id }, h('h3', { text: title + ' (' + items.length + ')' }), items.length ? items.map(tlItem) : h('p', { class: 'mut small', text: 'Nothing.' }));
    };
    var tlCard = h('div', { class: 'card', id: 'ad-timeline' }, h('h2', { text: 'Timeline' }),
      h('p', { class: 'mut small', text: 'Renewals, tax items with a due date, document expiries and certification expiries. Overdue first.' }),
      group('ad-tl-overdue', 'Overdue', tl.overdue), group('ad-tl-30', 'Within 30 days', tl.d30), group('ad-tl-60', '31 to 60 days', tl.d60), group('ad-tl-90', '61 to 90 days', tl.d90));

    var open = (s.renewals || []).filter(function (r) { return r.state === 'open'; }).sort(function (a, b) { return a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title); });
    var rT = h('input', { type: 'text', id: 'rn-title', maxlength: '200', autocomplete: 'off' });
    var rKind = sel('rn-kind', CAD_OPTS(A.KIND_LABEL, A.KINDS), 'insurance');
    var rProv = h('input', { type: 'text', id: 'rn-provider', maxlength: '200', autocomplete: 'off' });
    var rDue = h('input', { type: 'date', id: 'rn-due', required: true });
    var rCad = sel('rn-cadence', CAD_OPTS(A.CADENCE_LABEL, A.CADENCES), 'annual');
    var rEvery = h('input', { type: 'text', id: 'rn-every', inputmode: 'numeric', maxlength: '4', autocomplete: 'off' });
    var rAmt = h('input', { type: 'text', id: 'rn-amount', inputmode: 'decimal', autocomplete: 'off', maxlength: '14' });
    var rAuto = h('input', { type: 'checkbox', id: 'rn-auto' });
    var rNotes = h('textarea', { id: 'rn-notes', maxlength: '2000' });
    var renewals = details('ad-renewals', 'Renewals (' + open.length + ' open)', [
      open.length ? open.map(function (r) { return renewalRow(s, r); }) : h('p', { class: 'mut', text: 'No open renewals.' }),
      h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          act(function () {
            var input = { title: rT.value, kind: rKind.value, provider: rProv.value, dueDate: rDue.value, cadence: rCad.value, everyDays: rEvery.value, amount: rAmt.value, autoRenews: rAuto.checked, notes: rNotes.value };
            return commit(function (x) { A.addRenewal(x, input, t); }, 'renewal add').then(function () { view.open = 'ad-renewals'; setNotice('ok', 'Renewal added.'); render(); });
          });
        }
      }, h('h3', { text: 'Add a renewal or subscription' }), field('Title', rT), field('Kind', rKind), field('Provider (optional)', rProv), field('Due date', rDue), field('Repeats', rCad),
        field('Days between (custom repeat only)', rEvery), field('Amount per payment (optional)', rAmt), h('label', { class: 'field check' }, rAuto, h('span', { text: 'Renews automatically' })),
        field('Notes (optional)', rNotes, 'Do not enter ID numbers, account numbers or passwords.'), h('button', { type: 'submit', class: 'btn pri', id: 'rn-add', text: 'Add renewal' }))], view.open === 'ad-renewals' || !(s.renewals || []).length);

    var subCard = h('div', { class: 'card', id: 'ad-subs' }, h('h2', { text: 'Subscriptions (' + subs.items.length + ')' }),
      h('p', { class: 'mut small', text: 'Per month and per year from the amounts you entered. A flag means no review recorded in the last 12 months.' }),
      subs.items.length ? subs.items.map(function (x) {
        return h('div', { class: 'item sub-row', 'data-title': x.title },
          h('div', null, h('span', { class: 'entry-t', text: x.title }),
            h('div', { class: 'mut small', text: (x.monthlyCents === null ? 'no amount' : moneyFmt(x.monthlyCents, cur) + ' per month, ' + moneyFmt(x.annualCents, cur) + ' per year') + ' | ' + (x.reviewedOn ? 'reviewed ' + x.reviewedOn : 'never reviewed') }),
            x.stale ? h('span', { class: 'chip bad sub-stale', text: 'Not reviewed in 12 months' }) : null),
          btn('Mark reviewed', function () { act(function () { return commit(function (z) { A.markReviewed(z, x.id, t); }, 'subscription reviewed').then(render); }); }, 'sm', { 'aria-label': 'Mark ' + x.title + ' reviewed' }));
      }) : h('p', { class: 'mut', text: 'No subscriptions yet. Add a renewal with the kind Subscription.' }),
      h('p', { class: 'small', id: 'ad-sub-stale', text: subs.staleCount + (subs.staleCount === 1 ? ' subscription has' : ' subscriptions have') + ' not been reviewed in 12 months.' }));

    // documents (an index, not a store)
    var dT = h('input', { type: 'text', id: 'doc-title', maxlength: '200', autocomplete: 'off' });
    var dKind = h('input', { type: 'text', id: 'doc-kind', maxlength: '60', autocomplete: 'off' });
    var dWhere = h('input', { type: 'text', id: 'doc-where', maxlength: '200', autocomplete: 'off' });
    var dExp = h('input', { type: 'date', id: 'doc-expires' });
    var dNotes = h('textarea', { id: 'doc-notes', maxlength: '2000' });
    var docs = (s.documents || []).slice().sort(function (a, b) { return a.title.localeCompare(b.title); });
    var docCard = details('ad-docs', 'Document index (' + docs.length + ')', [
      h('p', { class: 'warn', id: 'doc-warning', text: 'This is an index of where documents are kept, not a place to store them. Do not enter ID numbers, account numbers or passwords.' }),
      docs.map(function (d) {
        return h('div', { class: 'item doc-row', 'data-title': d.title },
          h('div', null, h('div', { class: 'entry-t', text: d.title }), h('div', { class: 'mut small', text: [d.kind, d.whereKept ? 'kept: ' + d.whereKept : '', d.expires ? 'expires ' + d.expires : ''].filter(Boolean).join(' | ') })),
          btn('Delete', function () { act(function () { return commit(function (x) { A.deleteDocument(x, d.id); }, 'document delete').then(function () { view.open = 'ad-docs'; render(); }); }); }, 'sm bad', { 'aria-label': 'Delete ' + d.title }));
      }),
      h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          act(function () {
            var input = { title: dT.value, kind: dKind.value, whereKept: dWhere.value, expires: dExp.value, notes: dNotes.value };
            return commit(function (x) { A.addDocument(x, input); }, 'document add').then(function () { view.open = 'ad-docs'; setNotice('ok', 'Document added to the index.'); render(); });
          });
        }
      }, field('Title', dT), field('Kind (optional)', dKind), field('Where it is kept', dWhere), field('Expires (optional)', dExp), field('Notes (optional)', dNotes),
        h('button', { type: 'submit', class: 'btn pri', id: 'doc-add', text: 'Add to index' }))], view.open === 'ad-docs' || !docs.length);

    // tax checklist
    var xYear = h('input', { type: 'text', id: 'tx-year', inputmode: 'numeric', maxlength: '4', autocomplete: 'off', value: String(Number(t.slice(0, 4)) - 1) });
    var xT = h('input', { type: 'text', id: 'tx-title', maxlength: '200', autocomplete: 'off' });
    var xDue = h('input', { type: 'date', id: 'tx-due' });
    var years = A.taxByYear(s);
    var taxCard = details('ad-tax', 'Tax checklist (' + (s.taxItems || []).length + ')', [
      h('p', { class: 'mut small', text: 'A checklist of items by tax year. It records what you need, have received or have filed. It does not compute anything.' }),
      years.map(function (y) {
        return h('div', { class: 'tx-year', 'data-year': String(y.year) }, h('h3', { text: y.year + ' (' + y.needed + ' needed, ' + y.received + ' received, ' + y.filed + ' filed)' }),
          y.items.map(function (it) {
            return h('div', { class: 'item tx-row', 'data-title': it.title },
              h('div', null, h('span', { class: 'entry-t' + (it.state === 'filed' ? ' done-t' : ''), text: it.title }), h('div', { class: 'mut small', text: it.state + (it.dueDate ? ' | due ' + it.dueDate : '') })),
              h('div', { class: 'row' },
                sel('tx-state-' + it.id, A.TAX_STATES.map(function (v) { return { v: v, t: v }; }), it.state, function (e) { var v = e.target.value; act(function () { return commit(function (x) { A.setTaxState(x, it.id, v); }, 'tax item state').then(function () { view.open = 'ad-tax'; render(); }); }); }),
                btn('Delete', function () { act(function () { return commit(function (x) { A.deleteTaxItem(x, it.id); }, 'tax item delete').then(function () { view.open = 'ad-tax'; render(); }); }); }, 'sm bad', { 'aria-label': 'Delete ' + it.title })));
          }));
      }),
      h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          act(function () {
            var input = { year: xYear.value, title: xT.value, dueDate: xDue.value };
            return commit(function (x) { A.addTaxItem(x, input); }, 'tax item add').then(function () { view.open = 'ad-tax'; setNotice('ok', 'Tax item added.'); render(); });
          });
        }
      }, field('Tax year', xYear), field('Item', xT, 'Do not enter ID numbers, account numbers or passwords.'), field('Due date (optional)', xDue), h('button', { type: 'submit', class: 'btn pri', id: 'tx-add', text: 'Add tax item' }))], view.open === 'ad-tax' || !(s.taxItems || []).length);

    // Older home/due entries the upgrade could not turn into renewals (notes too long, or past the cap). They count in the timeline,
    // so each can be deleted after a confirm; the list shows the 200 soonest.
    var legacy = A.legacyEntries(s), legacyShown = legacy.slice(0, 200);
    var legacyCard = legacy.length ? details('ad-legacy', 'Older due items (' + legacy.length + (legacy.length > legacyShown.length ? ', soonest ' + legacyShown.length + ' shown' : '') + ')', [h('p', { class: 'mut small', text: 'Kept exactly as entered. They count in the timeline until you delete them.' }), legacyShown.map(function (e) {
      return h('div', { class: 'item g-legacy' }, h('div', null, h('span', { class: 'entry-t', text: e.title }), h('span', { class: 'mut small', text: ' due ' + e.due + ', ' + (e.status || 'open') + ', entered ' + e.date }), e.notes ? h('p', { class: 'small mut', text: e.notes }) : null),
        btn('Delete', function () {
          openDialog({ title: 'Delete this older due item?', yes: 'Delete', danger: true, body: [h('p', { class: 'mut', text: e.title }), h('p', { class: 'small', text: 'Its title, dates and notes are removed from the vault.' })],
            onYes: function () { return commit(function (x) { x.entries = x.entries.filter(function (z) { return z.id !== e.id; }); }, 'older due item delete').then(function () { view.open = 'ad-legacy'; render(); }); } });
        }, 'sm bad leg-del', { 'aria-label': 'Delete ' + e.title }));
    })], view.open === 'ad-legacy') : null;

    return h('div', null, btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'), h('h1', { text: 'Admin' }),
      h('p', { class: 'mut small', text: 'Dates and amounts are your own numbers. Nothing repeats unless you confirm it.' }),
      stats, tlCard, proposalsCard(s, A.pendingRenewals(s), 'admin'), subCard, renewals, docCard, taxCard, legacyCard);
  }
  // Weekly review step: what came due this week, what is overdue, what is due next week, and proposals waiting for a tap.
  function reviewHomeAdminCard(s, wk) {
    var Hm = L.home.reviewWeek(s, wk), Ad = L.admin.reviewWeek(s, wk);
    var line = function (title, date, extra) { return h('div', { class: 'item rv-ha', 'data-title': title }, h('div', null, h('span', { class: 'entry-t', text: title }), h('span', { class: 'mut small', text: ' ' + date + (extra ? ' | ' + extra : '') }))); };
    var kids = [];
    kids.push(h('p', { class: 'small', id: 'rv-ha-came-h', text: 'Came due this week (' + (Hm.cameDue.length + Ad.cameDue.length) + ')' }));
    Hm.cameDue.forEach(function (m) { kids.push(maintRow(s, m, 'rv-ha rv-maint')); });
    Ad.cameDue.forEach(function (x) { kids.push(line(x.title, x.date, x.kind)); });
    if (Hm.overdue.length || Ad.overdue.length) {
      kids.push(h('p', { class: 'small', id: 'rv-ha-overdue-h', text: 'Still overdue (' + (Hm.overdue.length + Ad.overdue.length) + ')' }));
      Hm.overdue.forEach(function (m) { kids.push(maintRow(s, m, 'rv-ha rv-maint')); });
      Ad.overdue.forEach(function (x) { kids.push(line(x.title, x.date, x.kind)); });
    }
    kids.push(h('p', { class: 'small', id: 'rv-ha-next-h', text: 'Due next week (' + (Hm.dueNext.length + Ad.dueNext.length) + ')' }));
    Hm.dueNext.forEach(function (m) { kids.push(line(m.title, m.nextDue, 'Home')); });
    Ad.dueNext.forEach(function (x) { kids.push(line(x.title, x.date, x.kind)); });
    var pr = [proposalsCard(s, Hm.proposals, 'home'), proposalsCard(s, Ad.proposals, 'admin')];
    return h('div', { class: 'card', id: 'rv-homeadmin' }, kids, pr);
  }

  // ---------- learning (v0.8.0) ----------
  // Review actions (pause, drop, new target date) are offered and only taken on a tap.
  function itemOptions(s, none) {
    var live = (s.learningItems || []).filter(function (i) { return i.state !== 'dropped'; }).sort(function (a, b) { return a.title.localeCompare(b.title); });
    return [{ v: '', t: none || '(none)' }].concat(live.map(function (i) { return { v: i.id, t: i.title }; }));
  }
  function goalOptions(s) {
    return [{ v: '', t: '(none)' }].concat((s.goals || []).filter(function (g) { return g.state === 'active'; }).map(function (g) { return { v: g.id, t: g.title }; }));
  }
  // One tap logs a session: choose an item, tap a minutes chip, save. A typed number works too.
  function studyDialog(itemId) {
    var s = st(), mins = '';
    var item = sel('sd-item', itemOptions(s), itemId || '');
    var custom = h('input', { type: 'text', id: 'sd-min', inputmode: 'numeric', maxlength: '4', autocomplete: 'off', 'aria-label': 'Minutes' });
    var dateIn = h('input', { type: 'date', id: 'sd-date', value: today(), required: true, 'aria-label': 'Date' });
    var note = h('input', { type: 'text', id: 'sd-note', maxlength: String(L.learning.SESSION_NOTE_MAX), autocomplete: 'off', 'aria-label': 'Note (optional)' });
    var chips = h('div', { class: 'chips', id: 'sd-chips', role: 'group', 'aria-label': 'Minutes' });
    function paint() {
      chips.replaceChildren.apply(chips, [15, 30, 45, 60].map(function (n) {
        return h('button', { type: 'button', class: 'chipbtn', 'aria-pressed': String(n) === mins ? 'true' : 'false', text: String(n), onclick: function () { mins = String(n); custom.value = String(n); paint(); } });
      }));
    }
    custom.addEventListener('input', function () { mins = custom.value.trim(); paint(); });
    paint();
    openDialog({
      title: 'Log study time', yes: 'Save',
      body: [field('Item (optional)', item), h('span', { class: 'lbl', text: 'Minutes' }), chips, field('Or type minutes', custom), field('Date', dateIn), field('Note (optional)', note)],
      onYes: function () {
        return commit(function (x) { L.learning.addSession(x, { itemId: item.value, date: dateIn.value, minutes: custom.value, notes: note.value }, today()); }, 'study session add')
          .then(function () { setNotice('ok', 'Study time logged.'); render(); });
      }
    });
  }
  function progressDialog(s, it) {
    var pct = h('input', { type: 'text', id: 'pd-pct', inputmode: 'decimal', maxlength: '6', autocomplete: 'off', value: typeof it.progressPct === 'number' ? String(it.progressPct) : '' });
    var done = h('input', { type: 'text', id: 'pd-done', inputmode: 'numeric', maxlength: '7', autocomplete: 'off', value: typeof it.doneUnits === 'number' ? String(it.doneUnits) : '' });
    var total = h('input', { type: 'text', id: 'pd-total', inputmode: 'numeric', maxlength: '7', autocomplete: 'off', value: typeof it.totalUnits === 'number' ? String(it.totalUnits) : '' });
    var unit = h('input', { type: 'text', id: 'pd-unit', maxlength: '30', autocomplete: 'off', value: it.unitLabel || '' });
    openDialog({
      title: 'Update progress', yes: 'Save',
      body: [h('p', { class: 'mut', text: it.title }), h('p', { class: 'small', text: 'Enter a percent, or units done out of a total. Not both. Leave all blank to clear.' }),
        field('Percent done', pct), field('Units done', done), field('Total units', total), field('Unit name (for example chapters)', unit)],
      onYes: function () {
        var patch = pct.value.trim() ? { progressPct: pct.value } : { progressPct: '', totalUnits: total.value, doneUnits: done.value, unitLabel: unit.value };
        return commit(function (x) { L.learning.updateItem(x, it.id, patch); }, 'learning progress').then(function () { setNotice('ok', 'Progress saved.'); render(); });
      }
    });
  }
  function editItemDialog(s, it) {
    var title = h('input', { type: 'text', id: 'ei-title', maxlength: '200', autocomplete: 'off', value: it.title });
    var tdate = h('input', { type: 'date', id: 'ei-target', value: it.targetDate || '' });
    var exam = h('input', { type: 'date', id: 'ei-exam', value: it.examDate || '' });
    var expires = it.kind === 'certification' ? h('input', { type: 'date', id: 'ei-expires', value: it.expiresOn || '' }) : null;
    var goal = sel('ei-goal', goalOptions(s), it.goalId || '');
    openDialog({
      title: 'Edit item', yes: 'Save',
      body: [field('Title', title), field('Target date', tdate), field('Exam date', exam), expires ? field('Certification expires', expires) : null, field('Linked goal', goal)],
      onYes: function () {
        var patch = { title: title.value, targetDate: tdate.value, examDate: exam.value, goalId: goal.value };
        if (expires) patch.expiresOn = expires.value;
        return commit(function (x) { L.learning.updateItem(x, it.id, patch); }, 'learning edit').then(function () { setNotice('ok', 'Item saved.'); render(); });
      }
    });
  }
  function askDeleteItem(s, it) {
    var n = L.learning.linkedCount(s, it.id);
    openDialog({
      title: 'Delete this item?', yes: 'Delete', danger: true,
      body: [h('p', { class: 'mut', text: it.title }), h('p', { class: 'small', id: 'ln-del-count', text: n.sessions + (n.sessions === 1 ? ' study session' : ' study sessions') + ' and ' + n.takeaways + (n.takeaways === 1 ? ' takeaway are' : ' takeaways are') + ' kept and unlinked.' })],
      onYes: function () { return commit(function (x) { L.learning.deleteItem(x, it.id); }, 'learning item delete').then(function () { setNotice('ok', 'Item deleted. Its sessions and takeaways are kept.'); render(); }); }
    });
  }
  function itemRow(s, it, t) {
    var Ln = L.learning, pace = it.state === 'active' ? Ln.paceOf(it, t) : 'no-data', p = Ln.progressOf(it);
    var sub = [Ln.KIND_LABEL[it.kind]];
    if (it.provider) sub.push(it.provider);
    if (it.targetDate) sub.push('target ' + it.targetDate);
    if (it.examDate) { var dd = L.home.dates.daysBetween(it.examDate, t); sub.push('exam ' + it.examDate + (dd > 0 ? ' (in ' + dd + (dd === 1 ? ' day)' : ' days)') : dd === 0 ? ' (today)' : '')); }
    if (it.expiresOn) sub.push('expires ' + it.expiresOn);
    var chips = [h('span', { class: 'chip ln-state', text: Ln.STATE_LABEL[it.state] })];
    if (pace !== 'no-data') chips.push(h('span', { class: 'chip ln-pace ' + STATUS_CHIP[pace], text: L.goals.PACE_LABEL[pace] }));
    var kids = [h('div', { class: 'row sp' }, h('strong', { class: 'entry-t', text: it.title }), h('span', null, chips)),
      h('p', { class: 'mut small', text: sub.join(' | ') }),
      h('p', { class: 'small ln-progress', text: Ln.fmtProgress(it) + (Ln.unitsText(it) ? ' (' + Ln.unitsText(it) + ')' : '') })];
    if (p !== null) kids.push(svgBar(Math.round(p), pace === 'behind' ? 'bar-over' : 'bar-fill'));
    var acts = [];
    if (it.state === 'active' || it.state === 'planned') acts.push(btn('Log time', function () { studyDialog(it.id); }, 'sm pri ln-logitem', { 'aria-label': 'Log time for ' + it.title }));
    acts.push(btn('Progress', function () { progressDialog(s, it); }, 'sm ln-progbtn', { 'aria-label': 'Update progress for ' + it.title }));
    if (it.state !== 'done') acts.push(btn('Mark done', function () { act(function () { return commit(function (x) { Ln.setState(x, it.id, 'done', t); }, 'learning done').then(function () { setNotice('ok', 'Marked done.'); render(); }); }); }, 'sm ln-done', { 'aria-label': 'Mark ' + it.title + ' done' }));
    if (it.state === 'active') acts.push(btn('Pause', function () { act(function () { return commit(function (x) { Ln.pauseItem(x, it.id); }, 'learning pause').then(render); }); }, 'sm', { 'aria-label': 'Pause ' + it.title }));
    if (it.state === 'paused' || it.state === 'planned' || it.state === 'done' || it.state === 'dropped') acts.push(btn(it.state === 'planned' ? 'Start' : 'Reopen', function () { act(function () { return commit(function (x) { Ln.setState(x, it.id, 'active', t); }, 'learning reopen').then(render); }); }, 'sm', { 'aria-label': 'Make ' + it.title + ' active' }));
    if (it.state !== 'dropped') acts.push(btn('Drop', function () { act(function () { return commit(function (x) { Ln.dropItem(x, it.id); }, 'learning drop').then(render); }); }, 'sm', { 'aria-label': 'Drop ' + it.title }));
    acts.push(btn('Edit', function () { editItemDialog(s, it); }, 'sm', { 'aria-label': 'Edit ' + it.title }));
    acts.push(btn('Delete', function () { askDeleteItem(s, it); }, 'sm bad ln-delete', { 'aria-label': 'Delete ' + it.title }));
    kids.push(h('div', { class: 'row' }, acts));
    return h('div', { class: 'goal ln-item', 'data-title': it.title, 'data-state': it.state }, kids);
  }
  function learningScreen(s) {
    var t = today(), Ln = L.learning, sum = Ln.summary(s, t), w = sum.week, info = Ln.weekInfo(t);
    var stats = h('div', { class: 'stats' },
      stat('Study minutes this week', w.target > 0 ? w.minutes + ' of ' + w.target : String(w.minutes), 'ln-minutes'),
      stat('Sessions this week', String(w.sessions), 'ln-sessions'),
      stat('Days studied this week', String(w.days), 'ln-days'),
      stat('Weeks in a row at target', w.target > 0 ? String(sum.streak) : 'n/a', 'ln-streak'));
    var tg = h('input', { type: 'text', id: 'ln-target', inputmode: 'numeric', maxlength: '5', autocomplete: 'off', value: w.target ? String(w.target) : '' });
    var targetCard = h('form', {
      class: 'card', id: 'ln-target-card',
      onsubmit: function (e) {
        e.preventDefault();
        act(function () { return commit(function (x) { L.learning.setWeeklyTarget(x, tg.value); }, 'study target').then(function () { setNotice('ok', 'Study target saved.'); render(); }); });
      }
    }, h('h2', { text: 'Week ' + info.week + ' of ' + info.year }),
      h('p', { class: 'mut small', id: 'ln-week', text: w.week + ' to ' + L.metrics.addDays(w.week, 6) + (w.target > 0 ? '. ' + (w.met ? 'Target met.' : (w.target - w.minutes) + ' minutes to the target.') : '. No weekly target set.') }),
      field('Study minutes per week (0 for none)', tg),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn pri', id: 'ln-target-save', text: 'Save target' }), btn('Log study time', function () { studyDialog(''); }, '', { id: 'ln-log' })));

    var active = Ln.activeItems(s);
    var activeCard = h('div', { class: 'card', id: 'ln-active' }, h('h2', { text: 'Active (' + active.length + ')' }),
      sum.stalled.length ? h('p', { class: 'small', id: 'ln-stalled', text: sum.stalled.length + (sum.stalled.length === 1 ? ' active item has' : ' active items have') + ' no session in ' + Ln.STALL_DAYS + ' days.' }) : null,
      active.length ? active.map(function (i) { return itemRow(s, i, t); }) : h('p', { class: 'mut', text: 'Nothing active. Add an item below.' }));
    var exams = sum.exams;
    var examCard = h('div', { class: 'card', id: 'ln-exams' }, h('h2', { text: 'Upcoming exams (' + exams.length + ')' }),
      exams.length ? exams.map(function (x) { return h('div', { class: 'item ln-exam', 'data-title': x.title }, h('div', null, h('span', { class: 'entry-t', text: x.title }), h('span', { class: 'mut small', text: ' ' + x.date + ', ' + (x.days === 0 ? 'today' : 'in ' + x.days + (x.days === 1 ? ' day' : ' days')) }))); }) : h('p', { class: 'mut', text: 'No exam dates ahead.' }));
    var fin = Ln.recentlyFinished(s, 5);
    var finCard = h('div', { class: 'card', id: 'ln-finished' }, h('h2', { text: 'Recently finished (' + fin.length + ')' }),
      fin.length ? fin.map(function (i) { return h('div', { class: 'item ln-fin', 'data-title': i.title }, h('div', null, h('span', { class: 'entry-t', text: i.title }), h('span', { class: 'mut small', text: ' ' + (i.finishedDate || '') })), btn('Reopen', function () { act(function () { return commit(function (x) { Ln.setState(x, i.id, 'active', t); }, 'learning reopen').then(render); }); }, 'sm', { 'aria-label': 'Reopen ' + i.title })); }) : h('p', { class: 'mut', text: 'Nothing finished yet.' }));
    var others = (s.learningItems || []).filter(function (i) { return i.state === 'planned' || i.state === 'paused' || i.state === 'dropped'; }).sort(function (a, b) { return a.title.localeCompare(b.title); });
    var otherCard = others.length ? details('ln-other', 'Planned, paused and dropped (' + others.length + ')', others.map(function (i) { return itemRow(s, i, t); }), view.open === 'ln-other') : null;

    // add an item
    var f = {
      title: h('input', { type: 'text', id: 'ln-title', maxlength: '200', autocomplete: 'off', required: true }),
      kind: sel('ln-kind', L.learning.KINDS.map(function (k) { return { v: k, t: Ln.KIND_LABEL[k] }; }), 'course'),
      provider: h('input', { type: 'text', id: 'ln-provider', maxlength: '200', autocomplete: 'off' }),
      pct: h('input', { type: 'text', id: 'ln-pct', inputmode: 'decimal', maxlength: '6', autocomplete: 'off' }),
      total: h('input', { type: 'text', id: 'ln-total', inputmode: 'numeric', maxlength: '7', autocomplete: 'off' }),
      done: h('input', { type: 'text', id: 'ln-done-units', inputmode: 'numeric', maxlength: '7', autocomplete: 'off' }),
      unit: h('input', { type: 'text', id: 'ln-unit', maxlength: '30', autocomplete: 'off' }),
      start: h('input', { type: 'date', id: 'ln-start', value: t }),
      target: h('input', { type: 'date', id: 'ln-tdate' }),
      exam: h('input', { type: 'date', id: 'ln-exam' }),
      expires: h('input', { type: 'date', id: 'ln-expires' }),
      goal: sel('ln-goal', goalOptions(s), ''),
      notes: h('textarea', { id: 'ln-notes', maxlength: '2000' })
    };
    var certBox = h('div', { id: 'ln-cert-box', class: 'hidden' }, field('Exam date (optional)', f.exam), field('Certification expires (optional)', f.expires));
    f.kind.addEventListener('change', function () { certBox.setAttribute('class', f.kind.value === 'certification' ? '' : 'hidden'); });
    var addForm = details('ln-add', 'Add a learning item', [h('form', {
      id: 'ln-form',
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var input = { title: f.title.value, kind: f.kind.value, provider: f.provider.value, progressPct: f.pct.value, totalUnits: f.total.value, doneUnits: f.done.value, unitLabel: f.unit.value,
            startDate: f.start.value, targetDate: f.target.value, goalId: f.goal.value, notes: f.notes.value };
          if (f.kind.value === 'certification') { input.examDate = f.exam.value; input.expiresOn = f.expires.value; }
          return commit(function (x) { L.learning.addItem(x, input, t); }, 'learning item add').then(function () { view.open = 'ln-add'; setNotice('ok', 'Item added.'); render(); });
        });
      }
    }, field('Title', f.title), field('Kind', f.kind), field('Provider (optional)', f.provider),
      h('p', { class: 'mut small', text: 'Progress is a percent or units done out of a total, not both.' }),
      field('Percent done (optional)', f.pct), field('Total units (optional)', f.total), field('Units done', f.done), field('Unit name (for example chapters)', f.unit),
      field('Start date', f.start), field('Target date (optional)', f.target), certBox, field('Linked goal (optional)', f.goal),
      field('Notes (optional)', f.notes, 'Do not enter ID numbers, account numbers or passwords.'),
      h('button', { type: 'submit', class: 'btn pri', id: 'ln-add-btn', text: 'Add item' }))], view.open === 'ln-add' || !(s.learningItems || []).length);

    // takeaways with plain substring search
    var tkItem = sel('ln-tk-item', itemOptions(s), '');
    var tkText = h('textarea', { id: 'ln-tk-text', maxlength: '1000' });
    var q = h('input', { type: 'text', id: 'ln-search', maxlength: '100', autocomplete: 'off', 'aria-label': 'Search takeaways' });
    var results = h('div', { id: 'ln-results' });
    function showResults() {
      var qs = q.value.trim(), found = Ln.search(s, qs), shown = qs ? found : (s.takeaways || []).slice().sort(function (a, b) { return b.date.localeCompare(a.date); }).slice(0, 10).map(function (x) { return { takeaway: x, itemTitle: x.itemId ? ((s.learningItems || []).filter(function (i) { return i.id === x.itemId; })[0] || {}).title || '' : '' }; });
      results.replaceChildren.apply(results, shown.length ? shown.slice(0, 50).map(function (r) {
        return h('div', { class: 'item ln-tk', 'data-title': r.takeaway.text.slice(0, 40) },
          h('div', null, h('div', { class: 'entry-t', text: r.takeaway.text }), h('div', { class: 'mut small', text: r.takeaway.date + (r.itemTitle ? ' | ' + r.itemTitle : '') })),
          btn('Delete', function () { act(function () { return commit(function (x) { Ln.deleteTakeaway(x, r.takeaway.id); }, 'takeaway delete').then(function () { view.open = 'ln-tk'; render(); }); }); }, 'sm bad', { 'aria-label': 'Delete takeaway' }));
      }) : [h('p', { class: 'mut', id: 'ln-no-results', text: qs ? 'No takeaways match.' : 'No takeaways yet.' })]);
    }
    q.addEventListener('input', showResults);
    showResults();
    var tkCard = details('ln-tk', 'Takeaways (' + (s.takeaways || []).length + ')', [
      h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          act(function () { return commit(function (x) { L.learning.addTakeaway(x, { itemId: tkItem.value, text: tkText.value }, t); }, 'takeaway add').then(function () { view.open = 'ln-tk'; setNotice('ok', 'Takeaway added.'); render(); }); });
        }
      }, field('Item (optional)', tkItem), field('What did you learn?', tkText, 'Do not enter ID numbers, account numbers or passwords.'), h('button', { type: 'submit', class: 'btn pri', id: 'ln-tk-add', text: 'Add takeaway' })),
      field('Search takeaways', q, 'Matches the exact text you type.'), results], view.open === 'ln-tk' || !(s.takeaways || []).length);

    // recent sessions
    var titles = new Map(); (s.learningItems || []).forEach(function (i) { titles.set(i.id, i.title); });
    var recent = (s.studySessions || []).slice().sort(function (a, b) { return b.date.localeCompare(a.date); }).slice(0, 10);
    var sessCard = details('ln-sessions-card', 'Recent sessions (' + (s.studySessions || []).length + ')', recent.length ? recent.map(function (x) {
      return h('div', { class: 'item ln-sess', 'data-title': x.date },
        h('div', null, h('span', { class: 'entry-t', text: x.minutes + ' min' }), h('span', { class: 'mut small', text: ' ' + x.date + (x.itemId && titles.has(x.itemId) ? ' | ' + titles.get(x.itemId) : '') }), x.notes ? h('p', { class: 'small mut', text: x.notes }) : null),
        btn('Delete', function () { act(function () { return commit(function (z) { Ln.deleteSession(z, x.id); }, 'study session delete').then(function () { view.open = 'ln-sessions-card'; render(); }); }); }, 'sm bad', { 'aria-label': 'Delete session of ' + x.minutes + ' minutes on ' + x.date }));
    }) : h('p', { class: 'mut', text: 'No sessions yet.' }), view.open === 'ln-sessions-card');

    // Older learning entries the upgrade could not turn into items or sessions: kept as entered, each deletable after a confirm.
    var legacy = Ln.legacyEntries(s), legacyShown = legacy.slice(0, 200);
    var legacyCard = legacy.length ? details('ln-legacy', 'Older learning entries (' + legacy.length + (legacy.length > legacyShown.length ? ', newest ' + legacyShown.length + ' shown' : '') + ')', [h('p', { class: 'mut small', text: 'Kept exactly as entered.' }), legacyShown.map(function (e) {
      return h('div', { class: 'item g-legacy' }, h('div', null, h('span', { class: 'entry-t', text: e.title }), h('span', { class: 'mut small', text: ' ' + e.date + ', ' + (e.type === 'hours' ? e.value + ' hours' : (e.status || '')) }), e.notes ? h('p', { class: 'small mut', text: e.notes }) : null),
        btn('Delete', function () {
          openDialog({ title: 'Delete this older entry?', yes: 'Delete', danger: true, body: [h('p', { class: 'mut', text: e.title }), h('p', { class: 'small', text: 'Its title, date and notes are removed from the vault.' })],
            onYes: function () { return commit(function (x) { x.entries = x.entries.filter(function (z) { return z.id !== e.id; }); }, 'older learning entry delete').then(function () { view.open = 'ln-legacy'; render(); }); } });
        }, 'sm bad leg-del', { 'aria-label': 'Delete ' + e.title }));
    })], view.open === 'ln-legacy') : null;

    return h('div', null, btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'), h('h1', { text: 'Learning' }),
      h('p', { class: 'mut small', text: 'Minutes, progress and pace come from your own numbers. Nothing is paused, dropped or finished unless you tap it.' }),
      stats, targetCard, activeCard, examCard, finCard, otherCard, addForm, tkCard, sessCard, legacyCard);
  }
  // Weekly review step: minutes vs target, items that moved, items with no session in 14 days. Actions are offered; a tap takes them.
  function reviewLearningCard(s, wk, t) {
    var Ln = L.learning, r = Ln.reviewWeek(s, wk, t), w = r.week;
    if (!Ln.hasData(s)) return h('p', { class: 'mut', id: 'rv-ln-none', text: 'No learning data yet. Add items under Learning.' });
    var kids = [];
    kids.push(h('p', { class: 'small', id: 'rv-ln-minutes', text: 'Study minutes: ' + w.minutes + (w.target > 0 ? ' of ' + w.target : ' (no weekly target set)') + '. ' + w.sessions + (w.sessions === 1 ? ' session' : ' sessions') + ' on ' + w.days + (w.days === 1 ? ' day.' : ' days.') }));
    kids.push(h('p', { class: 'small', id: 'rv-ln-moved-h', text: 'Items that moved (' + r.moved.length + ')' }));
    r.moved.forEach(function (m) { kids.push(h('div', { class: 'item rv-ln-moved', 'data-title': m.item.title }, h('div', null, h('span', { class: 'entry-t', text: m.item.title }), h('span', { class: 'mut small', text: ' ' + m.minutes + ' min' + (m.item.state === 'done' ? ', finished' : '') })))); });
    kids.push(h('p', { class: 'small', id: 'rv-ln-stalled-h', text: 'No session in ' + Ln.STALL_DAYS + ' days (' + r.stalled.length + ')' }));
    if (r.stalled.length) kids.push(h('p', { class: 'mut small', text: 'Nothing changes until you tap it.' }));
    r.stalled.forEach(function (i) {
      var nd = h('input', { type: 'date', class: 'rv-ln-date', 'aria-label': 'New target date for ' + i.title, value: i.targetDate || '' });
      kids.push(h('div', { class: 'item rv-ln-stalled', 'data-title': i.title }, h('div', null, h('span', { class: 'entry-t', text: i.title }), h('span', { class: 'mut small', text: ' last session ' + (Ln.lastSession(s, i.id, r.asOf) || 'none') })),
        h('div', { class: 'row' }, nd,
          btn('Set target date', function () { act(function () { return commit(function (x) { Ln.setTargetDate(x, i.id, nd.value); }, 'learning target date').then(function () { setNotice('ok', 'Target date set.'); render(); }); }); }, 'sm rv-ln-date-btn', { 'aria-label': 'Set target date for ' + i.title }),
          btn('Pause', function () { act(function () { return commit(function (x) { Ln.pauseItem(x, i.id); }, 'learning pause').then(render); }); }, 'sm rv-ln-pause', { 'aria-label': 'Pause ' + i.title }),
          btn('Drop', function () { act(function () { return commit(function (x) { Ln.dropItem(x, i.id); }, 'learning drop').then(render); }); }, 'sm rv-ln-drop', { 'aria-label': 'Drop ' + i.title }))));
    });
    if (r.exams.length) {
      kids.push(h('p', { class: 'small', id: 'rv-ln-exams-h', text: 'Exams in the next 28 days (' + r.exams.length + ')' }));
      r.exams.forEach(function (x) { kids.push(h('div', { class: 'item', 'data-title': x.title }, h('div', null, h('span', { class: 'entry-t', text: x.title }), h('span', { class: 'mut small', text: ' ' + x.date + ', in ' + x.days + (x.days === 1 ? ' day' : ' days') })))); });
    }
    return h('div', { class: 'card', id: 'rv-learning' }, kids);
  }

  // ---------- activities (v0.9.0) ----------
  // Nothing here happens by itself: Done, Skipped, Reschedule, a rating, the Money expense and removing a manual duplicate are each offered and taken on a tap.
  function fmtC(s, c) { return moneyFmt(c, s.settings.currency); }
  function dateRange(a) { return a.endDate ? a.date + ' to ' + a.endDate : a.date; }
  function chipEl(text, cls) { return h('span', { class: 'chip' + (cls ? ' ' + cls : ''), text: text }); }
  function tbl(id, heads, rows) {
    return h('div', { class: 'tablewrap' }, h('table', { id: id },
      h('thead', null, h('tr', null, heads.map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, rows.map(function (r) { return h('tr', { 'data-cat': r.cat || null }, r.cells.map(function (c) { return h('td', { text: c }); })); }))));
  }
  function actDo(fn, ok) { act(function () { return commit(fn.run, fn.audit).then(function () { if (ok) setNotice('ok', ok); render(); }); }); }
  function ratingChips(a) {
    return h('div', { class: 'chips act-rate-row', role: 'group', 'aria-label': 'Worth it rating for ' + a.title }, [1, 2, 3, 4, 5].map(function (n) {
      return h('button', { type: 'button', class: 'chipbtn act-rate', 'data-n': String(n), 'aria-pressed': a.worthIt === n ? 'true' : 'false', text: String(n), 'aria-label': 'Rate ' + n + ' for ' + a.title,
        onclick: function () { actDo({ run: function (x) { L.activities.rate(x, a.id, n); }, audit: 'activity rate' }, 'Rating saved.'); } });
    }));
  }
  function moneyOfferBtn(s, a) {
    var o = L.activities.expenseOffer(s, a.id);
    if (!o) return null;
    return btn('Add ' + fmtC(s, o.costCents) + ' to Money', function () { actDo({ run: function (x) { L.activities.createExpense(x, a.id); }, audit: 'activity expense' }, 'Added to Money.'); }, 'sm pri act-money', { 'aria-label': 'Add the cost of ' + a.title + ' to Money as an expense' });
  }
  function askDeleteActivity(s, a) {
    openDialog({
      title: 'Delete this activity?', yes: 'Delete', danger: true,
      body: [h('p', { class: 'mut', text: a.title }), h('p', { class: 'small', text: a.expenseId ? 'Its Money expense is kept.' : 'Nothing in Money changes.' })],
      onYes: function () { return commit(function (x) { L.activities.deleteActivity(x, a.id); }, 'activity delete').then(function () { setNotice('ok', 'Activity deleted.'); render(); }); }
    });
  }
  // The same fields for adding (inline) and editing (dialog). read() gives the input the core expects.
  function activityForm(s, a, t, p) {
    var A = L.activities, edit = !!a, cats = A.categories(s).slice();
    if (edit && cats.indexOf(a.category) < 0) cats.push(a.category);
    var f = {};
    f.title = h('input', { type: 'text', id: p + 'title', maxlength: '200', autocomplete: 'off', required: true, value: edit ? a.title : '' });
    f.category = sel(p + 'category', cats.map(function (c) { return { v: c, t: c }; }), edit ? a.category : (cats.indexOf('other') >= 0 ? 'other' : cats[0]));
    f.date = h('input', { type: 'date', id: p + 'date', value: edit ? a.date : t, required: true });
    f.end = h('input', { type: 'date', id: p + 'end', value: edit && a.endDate ? a.endDate : '' });
    f.minutes = h('input', { type: 'text', id: p + 'minutes', inputmode: 'numeric', maxlength: '6', autocomplete: 'off', value: edit && a.minutes ? String(a.minutes) : '' });
    f.place = h('input', { type: 'text', id: p + 'place', maxlength: '200', autocomplete: 'off', value: edit ? a.place : '' });
    f.people = h('input', { type: 'text', id: p + 'people', maxlength: '1100', autocomplete: 'off', value: edit ? a.withPeople.join(', ') : '' });
    f.cost = h('input', { type: 'text', id: p + 'cost', inputmode: 'decimal', maxlength: '14', autocomplete: 'off', value: edit && typeof a.costCents === 'number' ? (a.costCents / 100).toFixed(2) : '' });
    f.ret = h('input', { type: 'text', id: p + 'return', inputmode: 'decimal', maxlength: '14', autocomplete: 'off', value: edit && typeof a.returnCents === 'number' ? (a.returnCents / 100).toFixed(2) : '' });
    f.health = h('input', { type: 'checkbox', id: p + 'health', checked: edit && a.alsoHealth });
    f.kind = sel(p + 'kind', [{ v: '', t: '(none)' }].concat((s.kinds || []).map(function (k) { return { v: k, t: k }; })), edit && a.healthKind ? a.healthKind : '');
    f.social = h('input', { type: 'checkbox', id: p + 'social', checked: edit && a.alsoSocial });
    f.goal = sel(p + 'goal', goalOptions(s), edit && a.goalId ? a.goalId : '');
    var long = edit && a.notes.length > A.NOTE_MAX;
    f.notes = long ? null : h('textarea', { id: p + 'notes', maxlength: String(A.NOTE_MAX) }, edit ? a.notes : '');
    if (!edit) {
      f.state = sel(p + 'state', [{ v: 'planned', t: 'Planned' }, { v: 'done', t: 'Done' }], date2state(t, t));
      f.worth = sel(p + 'worth', [{ v: '', t: '(not rated)' }].concat([1, 2, 3, 4, 5].map(function (n) { return { v: String(n), t: String(n) }; })), '');
      f.date.addEventListener('change', function () { if (f.date.value) f.state.value = date2state(f.date.value, t); });
    }
    function date2state(d, now) { return d < now ? 'done' : 'planned'; }
    var nodes = [field('Title', f.title), field('Category', f.category), edit ? null : field('State', f.state), field('Date', f.date), field('End date (optional, for a multi-day activity)', f.end),
      field('Minutes (optional)', f.minutes), field('Place (optional)', f.place, 'Do not enter ID numbers, account numbers or passwords.'),
      field('With (optional, names separated by commas, up to ' + A.PEOPLE_MAX + ')', f.people),
      field('Cost in dollars (optional)', f.cost, edit && a.expenseId ? 'In Money. A new amount here also changes that Money expense.' : 'Entered once. Marking it done offers to add it to Money.'),
      field('Financial return in dollars (optional)', f.ret),
      edit ? null : field('Worth it, 1 to 5 (once done)', f.worth),
      h('label', { class: 'field check' }, f.health, h('span', { text: 'Also count in Health as a workout' })), field('Health type (optional)', f.kind),
      h('label', { class: 'field check' }, f.social, h('span', { text: 'Also count in Social as contact with these people' })),
      field('Linked goal (optional)', f.goal),
      f.notes ? field('Notes (optional, up to ' + A.NOTE_MAX + ' characters)', f.notes, 'Do not enter ID numbers, account numbers or passwords.') : h('p', { class: 'mut small', text: 'Notes carried over from an older entry are kept as they are.' })];
    function read() {
      var o = { title: f.title.value, category: f.category.value, date: f.date.value, endDate: f.end.value, minutes: f.minutes.value, place: f.place.value, people: f.people.value,
        returnAmount: f.ret.value, alsoHealth: f.health.checked, healthKind: f.kind.value, alsoSocial: f.social.checked, goalId: f.goal.value };
      o.cost = f.cost.value;
      if (f.notes) o.notes = f.notes.value;
      if (!edit) { o.state = f.state.value; if (f.worth.value) o.worthIt = f.worth.value; }
      return o;
    }
    return { nodes: nodes, read: read, f: f };
  }
  function editActivityDialog(s, a, t) {
    var form = activityForm(s, a, t, 'ae-');
    openDialog({
      title: 'Edit activity', yes: 'Save', body: form.nodes,
      onYes: function () { var p = form.read(); return commit(function (x) { L.activities.updateActivity(x, a.id, p); }, 'activity edit').then(function () { setNotice('ok', 'Activity saved.'); render(); }); }
    });
  }
  function actRow(s, a, t) {
    var A = L.activities, sub = [dateRange(a), a.category];
    if (a.minutes) sub.push(a.minutes + ' min');
    if (a.place) sub.push(a.place);
    if (a.withPeople.length) sub.push('with ' + a.withPeople.join(', '));
    var money = [];
    if (typeof a.costCents === 'number') money.push(a.paidOn ? 'paid ' + fmtC(s, a.costCents) + ' on ' + a.paidOn : (a.state === 'planned' ? 'committed ' : a.state === 'done' ? 'cost ' : 'cost not spent ') + fmtC(s, a.costCents));
    if (a.state === 'done' && typeof a.returnCents === 'number') money.push('return ' + fmtC(s, a.returnCents));
    if (a.state === 'done' && typeof a.worthIt === 'number') money.push('worth it ' + a.worthIt + ' of 5');
    var chips = [chipEl(A.STATE_LABEL[a.state], 'act-state')];
    if (a.alsoHealth) chips.push(chipEl('Health', 'act-tag'));
    if (a.alsoSocial) chips.push(chipEl('Social', 'act-tag'));
    if (a.paidOn) chips.push(chipEl('Paid', 'act-paid'));
    if (a.expenseId) chips.push(chipEl('In Money', 'act-linked'));
    var kids = [h('div', { class: 'row sp' }, h('strong', { class: 'entry-t', text: a.title }), h('span', null, chips)), h('p', { class: 'mut small', text: sub.join(' | ') })];
    if (money.length) kids.push(h('p', { class: 'small act-money-line', text: money.join(' | ') }));
    if (a.notes) kids.push(h('p', { class: 'small mut', text: a.notes }));
    var acts = [];
    if (a.state === 'planned') {
      acts.push(btn('Done', function () { actDo({ run: function (x) { A.markDone(x, a.id); }, audit: 'activity done' }, 'Marked done.'); }, 'sm pri act-done', { 'aria-label': 'Mark ' + a.title + ' done' }));
      acts.push(btn('Skip', function () { actDo({ run: function (x) { A.markSkipped(x, a.id); }, audit: 'activity skipped' }, a.expenseId ? 'Marked skipped. Its Money expense is kept.' : 'Marked skipped.'); }, 'sm act-skip', { 'aria-label': 'Skip ' + a.title }));
    }
    if (a.state === 'planned' && a.costCents > 0 && !a.paidOn) acts.push(btn('Mark paid', function () { actDo({ run: function (x) { A.markPaid(x, a.id, t); }, audit: 'activity paid' }, 'Marked paid. You can add it to Money.'); }, 'sm act-paid-btn', { 'aria-label': 'Mark ' + a.title + ' paid' }));
    var mo = moneyOfferBtn(s, a); if (mo) acts.push(mo);
    if (a.state === 'skipped' || a.state === 'done') acts.push(btn(a.state === 'done' ? 'Back to planned' : 'Reopen', function () { actDo({ run: function (x) { A.setState(x, a.id, 'planned'); }, audit: 'activity reopen' }); }, 'sm act-reopen', { 'aria-label': 'Make ' + a.title + ' planned again' }));
    acts.push(btn('Edit', function () { editActivityDialog(s, a, t); }, 'sm act-edit', { 'aria-label': 'Edit ' + a.title }));
    acts.push(btn('Delete', function () { askDeleteActivity(s, a); }, 'sm bad act-del', { 'aria-label': 'Delete ' + a.title }));
    if (a.state === 'done') kids.push(h('div', { class: 'row' }, h('span', { class: 'mut small', text: 'Worth it?' }), ratingChips(a)));
    kids.push(h('div', { class: 'row' }, acts));
    return h('div', { class: 'goal act-item', 'data-title': a.title, 'data-state': a.state }, kids);
  }
  // A past-date planned activity: done, skipped or a new date, each on a tap.
  function pastRow(s, a, cls) {
    var A = L.activities, nd = h('input', { type: 'date', class: cls + '-date', 'aria-label': 'New date for ' + a.title, value: a.date });
    return h('div', { class: 'item ' + cls, 'data-title': a.title },
      h('div', null, h('span', { class: 'entry-t', text: a.title }), h('span', { class: 'mut small', text: ' ' + dateRange(a) + (typeof a.costCents === 'number' ? ', ' + fmtC(s, a.costCents) : '') + (a.paidOn ? ' (paid)' : '') })),
      h('div', { class: 'row' }, nd,
        btn('Reschedule', function () { actDo({ run: function (x) { A.reschedule(x, a.id, nd.value); }, audit: 'activity reschedule' }, 'Rescheduled.'); }, 'sm ' + cls + '-rs', { 'aria-label': 'Reschedule ' + a.title }),
        btn('Done', function () { actDo({ run: function (x) { A.markDone(x, a.id); }, audit: 'activity done' }, 'Marked done.'); }, 'sm ' + cls + '-done', { 'aria-label': 'Mark ' + a.title + ' done' }),
        btn('Skipped', function () { actDo({ run: function (x) { A.markSkipped(x, a.id); }, audit: 'activity skipped' }, a.expenseId ? 'Marked skipped. Its Money expense is kept.' : 'Marked skipped.'); }, 'sm ' + cls + '-skip', { 'aria-label': 'Mark ' + a.title + ' skipped' })));
  }
  function glanceItem(s, x, many) {
    var line = dateRange(x) + (typeof x.costCents === 'number' && x.costCents > 0 ? ' | ' + fmtC(s, x.costCents) + ' committed' : '') + (x.paid ? ' | paid' : '');
    return h('div', { class: 'item gl-item', 'data-title': x.title, 'data-source': x.source },
      h('div', null, h('span', { class: 'entry-t', text: x.title }), h('span', { class: 'mut small', text: ' ' + line }), many ? chipEl(x.sourceLabel, 'gl-src') : null));
  }
  // The at-a-glance card: today and this week, the rest of the 30 days behind one tap. It reads the provider list, so other domains can add upcoming items.
  function glanceCard(s, t, id) {
    var g = L.activities.glance(s, t), many = g.providers.length > 1, now = g.today.concat(g.week);
    var kids = [h('h2', { text: 'At a glance' }),
      h('p', { class: 'mut small', id: id + '-sum', text: g.count ? g.count + (g.count === 1 ? ' item' : ' items') + ' in the next 30 days.' : 'Nothing planned in the next 30 days.' })];
    if (g.today.length) kids.push(h('h3', { text: 'Today' }), g.today.map(function (x) { return glanceItem(s, x, many); }));
    if (g.week.length) kids.push(h('h3', { text: 'This week' }), g.week.map(function (x) { return glanceItem(s, x, many); }));
    if (!now.length && g.count) kids.push(h('p', { class: 'mut small', text: 'Nothing today or this week.' }));
    if (g.later.length) kids.push(h('details', { class: 'fold-in', id: id + '-later', open: view.open === id + '-later' || null }, h('summary', { text: 'Rest of the next 30 days (' + g.later.length + ')' }), g.later.map(function (x) { return glanceItem(s, x, many); })));
    return h('div', { class: 'card', id: id }, kids);
  }
  function dupNotices(s, kind, cls) {
    var A = L.activities, byId = new Map((s.activities || []).map(function (a) { return [a.id, a]; })), ents = new Map(s.entries.map(function (e) { return [e.id, e]; }));
    return A.duplicates(s).filter(function (d) { return d.kind === kind && !(view.keep && view.keep[d.activityId + d.entryId]); }).map(function (d) {
      var a = byId.get(d.activityId), e = ents.get(d.entryId);
      return h('div', { class: 'warn ' + cls, 'data-title': a.title },
        h('p', { class: 'small', text: 'The ' + (kind === 'health' ? 'workout' : 'contact') + ' you logged on ' + d.date + ' is also counted from the activity "' + a.title + '". Both show. Remove your manual entry?' }),
        h('div', { class: 'row' },
          btn('Remove manual entry', function () { actDo({ run: function (x) { A.removeDuplicate(x, d.activityId, d.entryId); }, audit: 'activity duplicate removed' }, 'Manual entry removed.'); }, 'sm ' + cls + '-remove', { 'aria-label': 'Remove the manual ' + (e ? e.title : '') + ' entry' }),
          btn('Keep both', function () { view.keep = view.keep || {}; view.keep[d.activityId + d.entryId] = true; render(); }, 'sm ' + cls + '-keep')));
    });
  }
  // Health view: sessions from Activities this week, marked.
  function healthFromActivities(s, wk) {
    var A = L.activities, rows = A.healthSessions(s, wk, addDays(wk, 6)), dup = dupNotices(s, 'health', 'hl-dupe');
    if (!rows.length && !dup.length) return null;
    return h('div', { class: 'sub', id: 'hl-from-act' }, h('h3', { text: 'From Activities' }),
      rows.map(function (a) { return h('div', { class: 'item hl-act', 'data-title': a.title }, h('div', null, h('span', { class: 'entry-t', text: a.title }), h('span', { class: 'mut small', text: ' ' + a.date + (a.minutes ? ', ' + a.minutes + ' min' : '') + (a.healthKind ? ', ' + a.healthKind : '') }), chipEl('from Activities', 'act-from'))); }), dup);
  }
  // Social view: last contact from Activities, marked.
  function socialFromActivities(s, t) {
    var c = Array.from(L.activities.contacts(s, t).values()).sort(function (a, b) { return b.date.localeCompare(a.date) || a.name.localeCompare(b.name); }), dup = dupNotices(s, 'social', 'soc-dupe');
    if (!c.length && !dup.length) return null;
    return h('div', { class: 'card', id: 'soc-from-act' }, h('h2', { text: 'From Activities' }),
      h('p', { class: 'mut small', text: 'Last contact counted from done activities that are tagged Social. No contact entry is stored for them.' }),
      c.map(function (x) { return h('div', { class: 'item soc-act', 'data-person': x.name }, h('div', null, h('span', { class: 'entry-t', text: x.name }), h('span', { class: 'mut small', text: ' last contact ' + x.date + ', ' + x.title }), chipEl('from Activities', 'act-from'))); }), dup);
  }

  function activitiesScreen(s) {
    var A = L.activities, t = today(), wk = L.metrics.weekStart(t), ws = A.weekStats(s, wk, t), up = A.upcoming(s, t);
    var stats = h('div', { class: 'stats' },
      stat('Active days this week', String(ws.days), 'act-days'), stat('Done this week', String(ws.done), 'act-done-count'),
      stat('Spent this week', fmtC(s, ws.spendCents), 'act-spend'), stat('Committed, next 30 days', fmtC(s, up.committedCents), 'act-committed'));

    var offers = A.offers(s, t);
    var offerCard = offers.length ? h('div', { class: 'card', id: 'act-offers' }, h('h2', { text: 'Add to Money? (' + offers.length + ')' }),
      h('p', { class: 'mut small', text: 'A cost reaches Money when you mark it paid or done and add it here. Nothing is added by itself.' }),
      offers.map(function (o) {
        return h('div', { class: 'item act-offer', 'data-title': o.title },
          h('div', null, h('span', { class: 'entry-t', text: o.title }), h('span', { class: 'mut small', text: ' ' + o.date + ', ' + fmtC(s, o.costCents) + (o.category ? ', category ' + o.category : '') })),
          btn('Add to Money', function () { actDo({ run: function (x) { A.createExpense(x, o.id); }, audit: 'activity expense' }, 'Added to Money.'); }, 'sm pri act-offer-add', { 'aria-label': 'Add ' + o.title + ' to Money as an expense' }));
      })) : null;
    var dupes = [].concat(dupNotices(s, 'health', 'act-dupe'), dupNotices(s, 'social', 'act-dupe'));

    var late = A.overduePlanned(s, t);
    var lateCard = late.length ? h('div', { class: 'card', id: 'act-overdue' }, h('h2', { text: 'Planned, date passed (' + late.length + ')' }),
      h('p', { class: 'mut small', text: 'Nothing changes until you tap it.' }), late.map(function (a) { return pastRow(s, a, 'act-past'); })) : null;

    var upCard = h('div', { class: 'card', id: 'act-upcoming' }, h('h2', { text: 'Upcoming (' + up.count + ' in 30 days)' }),
      up.today.length ? [h('h3', { text: 'Today' }), up.today.map(function (a) { return actRow(s, a, t); })] : null,
      up.week.length ? [h('h3', { text: 'This week' }), up.week.map(function (a) { return actRow(s, a, t); })] : null,
      !up.today.length && !up.week.length ? h('p', { class: 'mut', text: up.count ? 'Nothing today or this week.' : 'Nothing planned in the next 30 days.' }) : null);
    var laterCard = up.later.length ? details('act-later', 'Rest of the next 30 days (' + up.later.length + ')', up.later.map(function (a) { return actRow(s, a, t); }), view.open === 'act-later') : null;

    var form = activityForm(s, null, t, 'act-');
    var addCard = details('act-add', 'Add an activity', [h('form', {
      id: 'act-form',
      onsubmit: function (e) {
        e.preventDefault();
        act(function () { var p = form.read(); return commit(function (x) { A.addActivity(x, p, t); }, 'activity add').then(function () { view.open = 'act-add'; setNotice('ok', 'Activity added.'); render(); }); });
      }
    }, form.nodes, h('button', { type: 'submit', class: 'btn pri', id: 'act-add-btn', text: 'Add activity' }))], view.open === 'act-add' || !(s.activities || []).length);

    var recent = (s.activities || []).filter(function (a) { return a.state !== 'planned'; }).sort(function (a, b) { return b.date.localeCompare(a.date) || a.title.localeCompare(b.title); });
    var shown = view.actShown || 20;
    var recentCard = h('div', { class: 'card', id: 'act-recent' }, h('h2', { text: 'Recent (' + recent.length + ')' }),
      recent.length ? recent.slice(0, shown).map(function (a) { return actRow(s, a, t); }) : h('p', { class: 'mut', text: 'Nothing done yet.' }),
      recent.length > shown ? btn('Show more', function () { view.actShown = shown + 20; render(); }, 'sm') : null);

    // cost and ratings: numbers only, "no data" where there is nothing to average
    var months = A.costMonths(s), cur = t.slice(0, 7);
    if (months.indexOf(cur) < 0) months.unshift(cur);
    months.sort().reverse();
    var month = view.month && months.indexOf(view.month) >= 0 ? view.month : cur;
    var r = A.roi(s, month), C = function (c) { return c === null ? 'no data' : fmtC(s, c); };
    var monthSel = sel('act-month', months.map(function (m) { return { v: m, t: monthLabel(m) }; }), month, function (e) { view.month = e.target.value; view.open = 'act-roi'; render(); });
    var roiCard = details('act-roi', 'Cost and ratings', [
      h('p', { class: 'mut small', text: 'Done activities only. The cost is entered once; a linked Money expense is the same money and is not added again.' }),
      h('h3', { text: 'Cost per activity' }),
      r.perActivity.length ? tbl('roi-per-activity', ['Activity', 'Date', 'Cost'], r.perActivity.slice(0, 20).map(function (x) { return { cat: x.title, cells: [x.title, x.date, fmtC(s, x.costCents)] }; })) : h('p', { class: 'mut', id: 'roi-per-activity-none', text: 'no data' }),
      h('h3', { text: 'Cost by category per month' }), field('Month', monthSel),
      tbl('roi-by-cat', ['Category', 'Activities', 'Cost'], r.byCategory.rows.map(function (x) { return { cat: x.category, cells: [x.category, String(x.count), C(x.cents)] }; }).concat([{ cat: '(total)', cells: ['Total', String(r.byCategory.total.count), C(r.byCategory.total.cents)] }])),
      h('h3', { text: 'Cost per hour' }),
      tbl('roi-per-hour', ['Category', 'Activities', 'Per hour'], r.perHour.rows.map(function (x) { return { cat: x.category, cells: [x.category, String(x.count), C(x.centsPerHour)] }; }).concat([{ cat: '(total)', cells: ['All', String(r.perHour.total.count), C(r.perHour.total.centsPerHour)] }])),
      h('h3', { text: 'Average worth-it rating' }),
      tbl('roi-worth', ['Category', 'Rated', 'Average'], r.worth.rows.map(function (x) { return { cat: x.category, cells: [x.category, String(x.rated), x.avg === null ? 'no data' : x.avg.toFixed(2) + ' of 5'] }; }).concat([{ cat: '(total)', cells: ['All', String(r.worth.total.rated), r.worth.total.avg === null ? 'no data' : r.worth.total.avg.toFixed(2) + ' of 5'] }])),
      h('h3', { text: 'Financial return minus cost' }),
      tbl('roi-returns', ['Category', 'Return', 'Cost', 'Net'], r.returns.rows.map(function (x) { return { cat: x.category, cells: [x.category, C(x.returnCents), C(x.costCents), C(x.netCents)] }; }).concat([{ cat: '(total)', cells: ['All', C(r.returns.total.returnCents), C(r.returns.total.costCents), C(r.returns.total.netCents)] }]))
    ], view.open === 'act-roi');

    // categories
    var newCat = h('input', { type: 'text', id: 'act-newcat', maxlength: '40', autocomplete: 'off', 'aria-label': 'New category' });
    var catCard = details('act-cats', 'Categories (' + A.categories(s).length + ')', [
      h('div', { class: 'chips' }, A.categories(s).map(function (c) {
        return h('span', { class: 'chip act-cat', 'data-cat': c }, c, h('button', { type: 'button', class: 'x', 'aria-label': 'Remove category ' + c, text: 'x', onclick: function () { actDo({ run: function (x) { A.removeCategory(x, c); }, audit: 'activity categories' }); view.open = 'act-cats'; } }));
      })),
      h('form', { onsubmit: function (e) { e.preventDefault(); view.open = 'act-cats'; actDo({ run: function (x) { A.addCategory(x, newCat.value); }, audit: 'activity categories' }, 'Category added.'); } },
        field('Add a category', newCat), h('button', { type: 'submit', class: 'btn', id: 'act-cat-add', text: 'Add category' }))], view.open === 'act-cats');

    var legacy = A.legacyEntries(s), legacyShown = legacy.slice(0, 200);
    var legacyCard = legacy.length ? details('act-legacy', 'Older activity entries (' + legacy.length + (legacy.length > legacyShown.length ? ', newest ' + legacyShown.length + ' shown' : '') + ')', [h('p', { class: 'mut small', text: 'Kept exactly as entered.' }), legacyShown.map(function (e) {
      return h('div', { class: 'item g-legacy' }, h('div', null, h('span', { class: 'entry-t', text: e.title }), h('span', { class: 'mut small', text: ' ' + e.date }), e.notes ? h('p', { class: 'small mut', text: e.notes }) : null),
        btn('Delete', function () {
          openDialog({ title: 'Delete this older entry?', yes: 'Delete', danger: true, body: [h('p', { class: 'mut', text: e.title }), h('p', { class: 'small', text: 'Its title, date and notes are removed from the vault.' })],
            onYes: function () { return commit(function (x) { x.entries = x.entries.filter(function (z) { return z.id !== e.id; }); }, 'older activity entry delete').then(function () { view.open = 'act-legacy'; render(); }); } });
        }, 'sm bad leg-del', { 'aria-label': 'Delete ' + e.title }));
    })], view.open === 'act-legacy') : null;

    return h('div', null, btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'), h('h1', { text: 'Activities' }),
      h('p', { class: 'mut small', text: 'Outings, events, travel, hobbies, volunteering and classes. Nothing is marked done, skipped, rated or added to Money unless you tap it.' }),
      stats, offerCard, dupes, lateCard, upCard, laterCard, addCard, recentCard, roiCard, catCard, legacyCard);
  }
  // Weekly review step: past-date planned activities (done, skipped or reschedule), then the worth-it rating, then the Money offers. A tap takes each action.
  function reviewActivitiesCard(s, wk, t) {
    var A = L.activities;
    if (!A.hasData(s)) return h('p', { class: 'mut', id: 'rv-act-none', text: 'No activities yet. Add some under Activities.' });
    var r = A.reviewWeek(s, wk, t), w = r.stats, kids = [];
    kids.push(h('p', { class: 'small', id: 'rv-act-stats', text: 'This week: ' + w.done + (w.done === 1 ? ' activity' : ' activities') + ' done on ' + w.days + (w.days === 1 ? ' day' : ' days') + ', ' + fmtC(s, w.spendCents) + ' spent.' }));
    kids.push(h('p', { class: 'small', id: 'rv-act-past-h', text: 'Planned, date passed (' + r.pastPlanned.length + ')' }));
    if (r.pastPlanned.length) kids.push(h('p', { class: 'mut small', text: 'Nothing changes until you tap it.' }));
    r.pastPlanned.forEach(function (a) { kids.push(pastRow(s, a, 'rv-act')); });
    kids.push(h('p', { class: 'small', id: 'rv-act-rate-h', text: 'Worth it? Done in the last 14 days, not rated (' + r.toRate.length + ')' }));
    r.toRate.forEach(function (a) { kids.push(h('div', { class: 'item rv-act-rate', 'data-title': a.title }, h('div', null, h('span', { class: 'entry-t', text: a.title }), h('span', { class: 'mut small', text: ' ' + a.date })), ratingChips(a))); });
    if (r.offers.length) {
      kids.push(h('p', { class: 'small', id: 'rv-act-offers-h', text: 'Add to Money? (' + r.offers.length + ')' }));
      r.offers.forEach(function (o) {
        kids.push(h('div', { class: 'item rv-act-offer', 'data-title': o.title }, h('div', null, h('span', { class: 'entry-t', text: o.title }), h('span', { class: 'mut small', text: ' ' + o.date + ', ' + fmtC(s, o.costCents) })),
          btn('Add to Money', function () { actDo({ run: function (x) { A.createExpense(x, o.id); }, audit: 'activity expense' }, 'Added to Money.'); }, 'sm pri rv-act-money', { 'aria-label': 'Add ' + o.title + ' to Money as an expense' })));
      });
    }
    return h('div', { class: 'card', id: 'rv-activities' }, kids);
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
    var study = h('input', { type: 'text', id: 't-study', inputmode: 'numeric', maxlength: '5', autocomplete: 'off', value: String((set.learning && set.learning.weeklyMinutes) || 0) });
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
          return commit(function (x) { x.settings.targets = { workoutsPerWeek: w, contactDays: c, savingsRate: r / 100 }; x.settings.currency = cu; x.settings.autoLockMin = m; L.learning.setWeeklyTarget(x, study.value); }).then(function () { resetIdle(); setNotice('ok', 'Settings saved.'); });
        });
      }
    }, h('h2', { text: 'Targets and preferences' }), field('Workouts per week', wpw), field('Days between contacts', cd), field('Savings rate target (%)', sr), field('Study minutes per week (0 for none)', study), field('Currency code', cur), field('Auto-lock after idle', al),
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
              var cur = st(), older = L.store.dropsWork(cur, state);
              var ack = older ? h('input', { type: 'checkbox', id: 'bk-workloss' }) : null;
              openDialog({
                title: 'Replace all data with this backup?', yes: 'Replace', danger: true,
                body: [
                  h('ul', { class: 'small', id: 'bk-summary' },
                    h('li', { text: 'Entries: ' + state.entries.length }),
                    h('li', { text: 'Accounts: ' + (state.accounts || []).length }),
                    h('li', { text: 'Projects: ' + (state.projects || []).length + ', pipeline items: ' + (state.pipeline || []).length }),
                    h('li', { text: 'Goals: ' + (state.goals || []).length }),
                    h('li', { text: 'Home: ' + (state.properties || []).length + ' properties, ' + (state.vehicles || []).length + ' vehicles, ' + (state.maintenance || []).length + ' maintenance items' }),
                    h('li', { text: 'Admin: ' + (state.renewals || []).length + ' renewals, ' + (state.documents || []).length + ' documents, ' + (state.taxItems || []).length + ' tax items' }),
                    h('li', { text: 'Daily checks: ' + (state.habits || []).length + ', training cycle: ' + (state.cycle ? 'set' : 'not set') }),
                    h('li', { text: 'Approved insights: ' + nAppr }),
                    h('li', { text: 'Lessons: ' + state.memory.lessons.length }),
                    h('li', { text: 'Provider settings: ' + (pv2.kind === 'none' ? 'none' : 'included (' + pv2.kind + ')') }),
                    h('li', { text: 'API key: ' + (pv2.apiKey ? 'included' : 'not included') })),
                  h('label', { class: 'row small' }, rr, h('span', { text: 'Re-review insights (restore every approved insight as proposed)' })),
                  older ? h('p', { class: 'small', id: 'bk-older', text: 'This backup is from an older LifeOS version. Restoring it removes your ' + L.store.lossText(cur, state) + '.' }) : null,
                  older ? h('label', { class: 'row small' }, ack, h('span', { text: 'I understand. Remove this data.' })) : null,
                  h('p', { class: 'mut', text: 'This replaces everything in this vault with the backup. It cannot be undone.' })],
                onYes: function () {
                  var next = rr.checked ? L.memory.demoteApproved(state) : state;
                  return L.store.replaceState(next, { allowWorkLoss: !!(ack && ack.checked) }).then(function () { return commit(null, 'import'); }).then(function () { setNotice('ok', 'Backup restored.'); render(); });
                }
              });
            });
          });
        }
      }, field('Restore from a backup file (64 MB max)', bf), field('Backup passphrase', ip),
        h('button', { type: 'submit', class: 'btn', text: 'Import backup' }))));

    out.push(h('p', { class: 'mut small', id: 'app-version', text: 'LifeOS v0.9.0' }));

    if (L.syncUI) out.push(L.syncUI.section(syncCtx()));

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
              if (L.sync) L.sync.disconnect();
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
