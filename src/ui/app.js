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
    // UI-1: browsers keep form history (autofill) in plaintext outside the vault. Every input, textarea and form is excluded unless the
    // caller sets autocomplete itself (only the main passphrase fields do, for the password manager).
    if (!svg && (tag === 'input' || tag === 'textarea' || tag === 'form') && !el.hasAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
    // v1.2.0: no browser spell check or auto-correct on any typed text (enhanced spell check can send it to a remote service). Passphrase
    // fields (type password) keep their own settings.
    if (!svg && (tag === 'input' || tag === 'textarea') && el.getAttribute('type') !== 'password') {
      el.setAttribute('spellcheck', 'false'); el.setAttribute('autocorrect', 'off'); el.setAttribute('autocapitalize', 'off');
    }
    return el;
  }
  function labelled(el, name) { el.setAttribute('aria-label', name); return el; }
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
    if (m === 'BAD_PRIVATE_PASSPHRASE') return 'That private passphrase did not work.';
    if (m === 'BAD_RECOVERY_KEY') return 'That recovery key did not work.';
    if (m === 'RECOVERY_KEY_FORMAT') return 'That recovery key has a typo or is the wrong length. Check it and try again.';
    if (m === 'LOCKED') return 'LifeOS locked before that finished. Nothing was saved. Unlock and try again.';
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
  var csvPending = null, ledger = null, actImp = null, actImpDone = null, dashEdit = false;
  var ai = null;
  var dlgEl = null, dlgReturn = null;
  var idleTimer = null, lastActive = 0, locking = null;
  var pwaApply = null, narrowMQ = null;
  // v1.4.0 B5: in-app history (view names only). See src/core/nav.js.
  var hist = L.nav.create({
    history: window.history,
    getView: function () { return view; },
    setView: function (v) { show(v.name, Object.assign({}, v, { name: undefined })); },
    isUnlocked: function () { return L.store.isUnlocked(); },
    dialogOpen: function () { return !!dlgEl; },
    closeDialog: function (fromPop) { closeDialog(fromPop); }
  });
  window.addEventListener('popstate', function (e) { hist.onPop(e.state); });

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
    }, function (e) { try { L.ops.recordError(e); } catch (x) { /* diagnostics never block */ } setNotice('err', friendly(e)); }).then(function () {
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
  // Every write goes through the private vault's single routing helper: a record is saved where it lives (main state or private
  // vault); with the vault closed it is a plain commit. New records are public unless "New items are private" is ticked.
  var privNew = false, privFail = { n: 0, until: 0 }, privTimer = null, privPick = { coll: 'accounts', q: '' };
  // v1.8.0: the main lock screen counts wrong passphrases and wrong recovery keys together, with the same delays as the private vault (1 s doubling to 30 s).
  var mainFail = { n: 0, until: 0 }, lockRecover = false;
  function leftOf(f) { return Math.max(0, Math.ceil((f.until - Date.now()) / 1000)); }
  function bumpOf(f) { f.n++; f.until = Date.now() + Math.min(30000, 1000 * Math.pow(2, f.n - 1)); }
  // from: [[collection, key]] the records a new record is made from (SEC-62): if any of them is private, so is the new one.
  // UI-5: the toggle applies only to the add forms and add dialogs that show its note (markAddForms); one-tap actions (a daily check
  // tick, a confirmed recurring item, carry-over, imports) follow their source record instead (SEC-62).
  var addIntent = false;
  function markAddIntent() { addIntent = true; setTimeout(function () { addIntent = false; }, 0); }
  function isAddForm(f) { var b = f && f.querySelector && f.querySelector('button[type=submit]'); return !!(b && ADD_RE.test(b.textContent)); }
  var ADD_RE = /^(Add (?!category|type|date|fact)|Log |Save budget|Save balance|Save cycle)/;
  document.addEventListener('submit', function (e) { if (isAddForm(e.target)) markAddIntent(); }, true);
  function commit(fn, action, from) {
    var o = newPriv() ? { newPrivate: true } : (from && L.priv.isOpen() ? { from: from } : null);
    if (o && o.newPrivate && !addIntent) o = from && L.priv.isOpen() ? { from: from } : null;
    return L.priv.write(function (s) { if (fn) fn(s); if (action) addAudit(s, action); }, o);
  }
  // The "New items are private" toggle only means anything while the vault is open; closed, it is off and ignored.
  function newPriv() { return privNew && L.store.isUnlocked() && L.priv.isOpen(); }
  function privNewNote() {
    return h('p', { class: 'privnew-note small', role: 'status' }, lockIcon('Private', 'lockmark'), ' ', h('span', { class: 'chip ok', text: 'New items are private' }));
  }
  // Show the toggle's state on every add form (and add dialog) while it is on. Idempotent; called after each render and on toggling.
  function markAddForms() {
    var root = document.getElementById('app');
    if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll('.privnew-note'), function (n) { n.remove(); });
    Array.prototype.forEach.call(document.querySelectorAll('.dialog.adds'), function (n) { Array.prototype.forEach.call(n.querySelectorAll('.privnew-note'), function (m) { m.remove(); }); });
    if (!newPriv()) return;
    Array.prototype.forEach.call(root.querySelectorAll('form'), function (f) {
      if (isAddForm(f)) f.insertBefore(privNewNote(), f.firstChild);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.dialog.adds'), function (d) { d.insertBefore(privNewNote(), d.children[1] || null); });
  }
  // The main state alone: prompts, digest, insights, review records, CSV and backups use this, even while the vault is open.
  function mainState() { return L.store.getState(); }
  // What screens show: the main state while the vault is closed, with private records merged in while it is open.
  function st() { var b = L.store.getState(); return L.priv.isOpen() ? L.priv.view(b) : b; }
  var DOMAIN_COLLS = {
    money: ['entries', 'recurring', 'budgets', 'activities'], assets: ['entries', 'accounts'], work: ['entries', 'projects', 'pipeline'],
    health: ['entries', 'habits', 'habitLog', 'cycle', 'activities'], activities: ['activities', 'entries', 'people'],
    social: ['people', 'contacts', 'groups', 'activities'], learning: ['learningItems', 'studySessions', 'takeaways'],
    home: ['properties', 'vehicles', 'maintenance', 'recurring'], admin: ['renewals', 'documents', 'taxItems', 'learningItems', 'recurring', 'business-*'],
    goals: null, wellbeing: ['entries', 'wellbeing']
  };
  // A small lock marker (no counts, no names) wherever a number or list could be affected by hidden private items.
  function lockMark(colls) {
    if (!L.store.isUnlocked() || L.priv.isOpen()) return null;
    var m = L.priv.marks(mainState());
    // 'business-*' stands for any year mark: a year whose tax rows (Admin timeline) are refused while the vault is closed (SEC-82).
    if (!m.length || (colls && !colls.some(function (c) { return c === 'business-*' ? m.some(function (x) { return /^business-\d{4}$/.test(x) || x === 'business'; }) : m.indexOf(c) >= 0; }))) return null;
    return lockIcon('Some private items are hidden', 'lockmark');
  }
  function lockIcon(label, cls) {
    return h('span', { class: cls || 'lockmark', role: 'img', 'aria-label': label, title: label },
      h('svg', { class: 'lockico', viewBox: '0 0 12 14', 'aria-hidden': 'true', focusable: 'false' }, h('rect', { x: '1', y: '6', width: '10', height: '7', rx: '1.5' }), h('path', { d: 'M3 6V4a3 3 0 0 1 6 0v2' })));
  }
  // v1.3.0: the area a diagnostic code is filed under (a fixed list; never a name or a value).
  function areaOf() {
    if (!L.store.isUnlocked() || view.name === 'lock') return 'lock';
    if (view.name === 'domain') return L.ops.AREAS.indexOf(view.domain) >= 0 ? view.domain : 'app';
    var a = { dashboard: 'dashboard', review: 'review', memory: 'memory', settings: 'settings', private: 'private', archive: 'archive', business: 'business', print: 'business', clients: 'business', podcasts: 'business', websites: 'business' }[view.name];
    return a || 'app';
  }
  function show(name, extra) {
    if (name !== 'archive' && L.archive) L.archive.closeArchive();
    var e2 = Object.assign({}, extra || {}); delete e2.name;
    Object.keys(e2).forEach(function (k) { if (e2[k] === undefined) delete e2[k]; });
    view = Object.assign({ name: name }, e2);
    notice = null; csvPending = null; ai = null; ledger = null; actImp = null; jobImp = null; jobImpDone = null;
    render();
    window.scrollTo(0, 0);
    var t = document.querySelector('h1');
    if (t) { t.setAttribute('tabindex', '-1'); t.focus(); }
  }
  function go(name, extra) {
    show(name, extra);
    if (L.store.isUnlocked()) hist.push(view);
  }
  function goKey(key) { var v = L.nav.viewOf(key); go(v.name, v); }

  // ---------- dialog ----------
  function closeDialog(fromPop) {
    var was = !!dlgEl;
    if (dlgEl) { dlgEl.remove(); dlgEl = null; }
    if (dlgReturn && dlgReturn.isConnected) dlgReturn.focus();
    dlgReturn = null;
    if (was && fromPop !== true) hist.dialogClosed();
  }
  function openDialog(o) {
    closeDialog();
    dlgReturn = document.activeElement;
    var err = h('p', { class: 'small', role: 'status', text: '' });
    var yes = o.sheet ? null : btn(o.yes || 'OK', function () {
      if (o.adds) markAddIntent();
      Promise.resolve().then(function () { return o.onYes(); }).then(function (keep) {
        if (keep !== false) closeDialog();
      }, function (e) { try { L.ops.recordError(e); } catch (x) { /* diagnostics never block */ } err.textContent = friendly(e); });
    }, o.danger ? 'bad' : 'pri');
    var box = h('div', { class: 'dialog' + (o.adds ? ' adds' : '') + (o.sheet ? ' sheet' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title },
      h('h2', { text: o.title }), o.body || null, o.sheet ? null : err,
      h('div', { class: 'row' }, yes, btn(o.sheet ? 'Close' : (o.no || 'Cancel'), function () { closeDialog(); })));
    dlgEl = h('div', { class: 'overlay' + (o.sheet ? ' sheetov' : '') }, box);
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
    hist.dialogOpened();
    markAddForms();
    var inp = box.querySelector('input,textarea');
    (inp || yes || box.querySelector('button')).focus();
  }

  // ---------- auto-lock ----------
  // UI-7: the main state holds the setting; no merged view is built per input event, and resets run at most once a second.
  function limitMs() {
    try { return (mainState().settings.autoLockMin || 15) * 60000; } catch (e) { return 900000; }
  }
  var lastReset = 0;
  function resetIdle(force) {
    var now = Date.now();
    if (force !== true && idleTimer && now - lastReset < 1000) return;
    if (L.priv.isOpen()) L.priv.touch();
    clearTimeout(idleTimer); idleTimer = null;
    if (!L.store.isUnlocked() || locking) return;
    lastReset = now; lastActive = now;
    idleTimer = setTimeout(function () { lockNow(); }, limitMs());
  }
  // Wall-clock check: timers can pause during device sleep or background throttling.
  function checkIdle() {
    L.priv.checkExpiry();
    if (L.store.isUnlocked() && !locking && lastActive && Date.now() - lastActive >= limitMs()) lockNow();
  }
  function lockNow() {
    if (locking) return locking;
    clearTimeout(idleTimer); idleTimer = null;
    // The Google token lives only in memory and must not outlive the unlocked session.
    if (L.sync) L.sync.disconnect();
    // Record the lock in the audit log, but never let a slow or stuck write delay the lock itself.
    var p = L.store.isUnlocked() ? Promise.race([commit(null, 'lock').catch(function () {}), new Promise(function (r) { setTimeout(r, 1000); })]) : Promise.resolve();
    // v1.3.0 B22: with "Remind me to sync" on, a one-line notice on the lock screen when this device has changes Drive does not have. Never a sync.
    var remind = unsynced().catch(function () { return false; });
    locking = Promise.all([p, remind]).then(function (r) {
      L.store.lock();
      if (L.recoveryUI) L.recoveryUI.clear(); lockRecover = false;
      privNew = false; goalMemo = new Map(); searchQ = '';
      closeDialog();
      csvPending = null; ledger = null; actImp = null; jobImp = null; jobImpDone = null; actImpDone = null; dashEdit = false; ai = null; notice = r[1] ? { kind: 'ok', text: SYNC_NOTE } : null; lastActive = 0;
      view = { name: 'lock' };
      hist.lock();
      render();
    }).then(function () { locking = null; }, function () { locking = null; });
    return locking;
  }
  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(function (ev) {
    window.addEventListener(ev, resetIdle, { capture: true, passive: true });
  });
  var SYNC_NOTE = 'This device has changes that are not synced to Drive.';
  // True only when the owner turned on "Remind me to sync", Drive sync is set up, and this device differs from the last synced copy.
  function unsynced() {
    try {
      if (!L.store.isUnlocked() || !L.sync) return Promise.resolve(false);
      var m = mainState(), sy = m.settings.sync || {};
      if (!m.settings.syncReminder || !sy.clientId) return Promise.resolve(false);
      return L.sync.fingerprint(m).then(function (fp) { return fp !== sy.fp; });
    } catch (e) { return Promise.resolve(false); }
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { checkIdle(); return; }
    unsynced().then(function (u) { if (u && L.store.isUnlocked()) setNotice('ok', SYNC_NOTE); }, function () {});
  });
  L.ops.install(window);
  window.addEventListener('focus', checkIdle);
  // A page restored from the browser's back-forward cache comes back as it was; if the vault is open, lock it.
  window.addEventListener('pageshow', function (e) { if (e && e.persisted && L.store.isUnlocked()) lockNow(); else checkIdle(); });
  setInterval(checkIdle, 10000);

  // ---------- chrome ----------
  function render() {
    var root = document.getElementById('app');
    clearTimeout(privTimer);
    L.ops.setArea(areaOf());
    // SEC-131: a key included on the recovery sheet lives only while the sheet is on screen.
    if (L.recoveryUI && (view.name !== 'print' || view.kind !== 'recovery')) L.recoveryUI.dropSheet();
    root.replaceChildren();
    noticeEl = h('div', { class: 'notice' + (notice ? ' ' + notice.kind : ''), role: 'status', 'aria-live': 'polite', text: notice ? notice.text : '' });
    if (!L.store.isUnlocked() || view.name === 'lock') { root.appendChild(lockScreen()); return; }
    var s = st();
    var body;
    try {
      body = view.name === 'domain' ? (view.domain === 'money' ? moneyScreen(s) : view.domain === 'assets' ? assetsScreen(s) : view.domain === 'work' ? (view.jobs ? jobsScreen(s) : view.revenue ? revenueScreen(s) : workScreen(s)) : view.domain === 'health' ? healthScreen(s) : view.domain === 'goals' ? goalsScreen(s) : view.domain === 'home' ? homeScreen(s) : view.domain === 'admin' ? adminScreen(s) : view.domain === 'learning' ? learningScreen(s) : view.domain === 'activities' ? activitiesScreen(s) : view.domain === 'social' ? socialScreen(s) : view.domain === 'wellbeing' ? wellbeingScreen(s) : domainScreen(s))
        : view.name === 'review' ? reviewScreen(s)
        : view.name === 'memory' ? memoryScreen(s)
        : view.name === 'settings' ? settingsScreen(s)
        : view.name === 'private' ? privScreen(s)
        : view.name === 'archive' && L.archiveUI ? L.archiveUI.screen(archCtx())
        : view.name === 'business' ? businessScreen(s)
        : view.name === 'clients' ? clientsScreen(s)
        : view.name === 'podcasts' ? podcastsScreen(s)
        : view.name === 'websites' ? websitesScreen(s)
        : view.name === 'print' ? printScreen(s)
        : dashScreen(s);
    } catch (e) { L.ops.record('RENDER_ERROR'); body = h('p', { text: friendly(e) }); }
    var nav = mainNav();
    root.appendChild(h('div', { class: 'app' },
      h('header', { class: 'top' }, h('span', { class: 'brand', text: 'LifeOS' }),
        h('span', { class: 'row' }, isNarrow() ? null : searchBox('hs'), btn(L.priv.isOpen() ? 'Private (open)' : 'Private', function () { go('private'); }, 'sm', { id: 'nav-private', 'aria-current': view.name === 'private' ? 'page' : null }),
          btn('Lock', function () { lockNow(); }, 'sm lockbtn'))),
      nav,
      h('main', { class: 'main' }, noticeEl, updateBanner(), view.name === 'print' ? null : backupBanner(), privBar(), screenMark(), body)));
    markAddForms();
    decorateRows();
  }


  // ---------- navigation (v1.4.0 B5) ----------
  function isNarrow() { try { return !!(narrowMQ ? narrowMQ.matches : window.innerWidth < 820); } catch (e) { return window.innerWidth < 820; } }
  // Under 820 px: the bottom bar (Home, Money, Work, Health, More). Wider: the full bar of earlier versions.
  function mainNav() {
    var key = L.nav.keyOf(view);
    if (isNarrow()) {
      var inBar = L.nav.BAR.some(function (x) { return x.key === key; });
      var btns = L.nav.BAR.map(function (n) {
        return h('button', { type: 'button', class: 'navbtn', text: n.label, 'data-key': n.key, 'aria-current': n.key === key ? 'page' : null, onclick: function () { goKey(n.key); } });
      });
      btns.push(h('button', { type: 'button', class: 'navbtn', id: 'nav-more', text: 'More', 'aria-haspopup': 'dialog', 'aria-current': inBar ? null : 'page', onclick: moreSheet }));
      return h('nav', { class: 'nav bar', 'aria-label': 'Main' }, btns);
    }
    var cur = view.name === 'domain' ? (view.domain === 'money' || view.domain === 'assets' || view.domain === 'work' || view.domain === 'health' ? view.domain : 'dashboard') : view.name;
    return h('nav', { class: 'nav', 'aria-label': 'Main' }, [['dashboard', 'Home'], ['money', 'Money'], ['assets', 'Assets'], ['work', 'Work'], ['health', 'Health'], ['business', 'Business'], ['clients', 'AYiN and clients'], ['review', 'Review'], ['memory', 'Memory'], ['settings', 'Settings']].map(function (n) {
      return h('button', { type: 'button', text: n[1], 'aria-current': n[0] === cur ? 'page' : null, onclick: function () { if (n[0] === 'money' || n[0] === 'assets' || n[0] === 'work' || n[0] === 'health') go('domain', { domain: n[0] }); else go(n[0]); } });
    }));
  }
  function moreSheet() {
    var key = L.nav.keyOf(view);
    openDialog({
      title: 'More', sheet: true,
      body: [searchBox('ms', function () { closeDialog(); }), h('ul', { class: 'sheetlist', id: 'more-list' }, L.nav.MORE.map(function (n) {
        return h('li', null, h('button', { type: 'button', class: 'btn sheetbtn', text: n.label, 'data-key': n.key, 'aria-current': n.key === key ? 'page' : null, onclick: function () { closeDialog(); goKey(n.key); } }));
      }))]
    });
  }
  // A newer version waits for this tap. Reloading locks the app, so while unlocked it asks first.
  function updateBanner() {
    if (!pwaApply) return null;
    return h('div', { class: 'warn', id: 'update-banner', role: 'status' }, h('span', { text: 'New version ready. ' }),
      btn('Reload', function () {
        if (!L.store.isUnlocked()) { pwaApply(); return; }
        openDialog({ title: 'Reload for the new version?', yes: 'Reload', body: [h('p', { class: 'mut', text: 'Reloading locks LifeOS. Anything you are typing and have not saved is lost.' })], onYes: function () { closeDialog(); /* the dialog's history entry is removed first; a history change would cancel the reload */ setTimeout(function () { pwaApply(); }, 250); return false; } });
      }, 'sm', { id: 'update-reload' }));
  }

  // SEC-99: a waiting version adds its banner in place. Redrawing the screen would drop anything typed and not yet saved (a passphrase on
  // the lock screen, an open form). Without a screen yet, the next render shows it.
  function showUpdate() {
    if (document.getElementById('update-banner')) return;
    var host = document.querySelector('main.main') || document.querySelector('.lockwrap'), b = host ? updateBanner() : null;
    if (!b) return;
    var h1 = host.classList.contains('lockwrap') ? host.querySelector('h1') : null;
    host.insertBefore(b, h1 ? h1.nextSibling : host.firstChild);
  }

  // The strip shown while the private vault is open, and the marker line shown while it is closed and something is hidden.
  function privBar() {
    if (!L.priv.isOpen()) return null;
    var tick = h('input', { type: 'checkbox', id: 'priv-new', checked: privNew, onchange: function (e) { privNew = !!e.target.checked; markAddForms(); } });
    return h('div', { class: 'privbar', id: 'priv-bar' }, h('span', { class: 'chip ok', text: 'Private vault open' }),
      h('label', { class: 'row small' }, tick, h('span', { text: 'New items are private' })),
      btn('Close vault', function () { L.priv.close(); }, 'sm', { id: 'priv-close' }));
  }
  function screenMark() {
    var colls = null;
    if (view.name === 'domain') { if (view.domain === 'wellbeing') return null; colls = view.jobs ? ['pipeline', 'people', 'contacts'] : DOMAIN_COLLS[view.domain]; }
    else if (view.name === 'dashboard' || view.name === 'settings' || view.name === 'memory' || view.name === 'private' || view.name === 'business' || view.name === 'print') return null;
    else if (view.name === 'clients' || view.name === 'podcasts' || view.name === 'websites') return null; // these screens place their own lock markers
    var m = lockMark(colls === undefined ? null : colls);
    return m ? h('p', { class: 'small mut lockrow' }, m, ' Some private items are hidden.') : null;
  }
  // SEC-67: nothing typed or shown while open survives the close: the toggle, the private search text and any notice (a notice can
  // name a private record, for example "Posted <title>.").
  L.priv.onClose(function () {
    privNew = false; privPick = { coll: 'accounts', q: '' }; notice = null; goalMemo = new Map(); searchQ = '';
    if (!L.store.isUnlocked() || locking) return;
    closeDialog(); csvPending = null; ledger = null; actImp = null; jobImp = null; jobImpDone = null; actImpDone = null; ai = null;
    view = { name: view.name, domain: view.domain };
    render();
  });

  // ---------- lock screen ----------
  // v1.4.0 B9: with no vault on this device the lock screen offers three ways in: create, restore from a backup file, use the Drive copy.
  var lockPath = 'create', restorePick = null, driveCopy = null, driveCid = '';
  function lockScreen() {
    var create = !vaultExists;
    if (!create) lockPath = 'create';
    var inner;
    if (create && lockPath === 'restore') inner = restorePath();
    else if (create && lockPath === 'drive') inner = drivePath();
    else if (!create && lockRecover && L.recoveryUI) inner = L.recoveryUI.lockPath(recCtx());
    else inner = unlockForm(create);
    var intro = h('p', { class: 'mut', text: create ? (lockPath === 'create' ? 'Your private life dashboard. Everything stays on this device, encrypted.' : 'Bring an existing vault to this device.') : 'Unlock your vault.' });
    var paths = create && lockPath === 'create' ? h('div', { class: 'card lockpaths', id: 'lock-paths' }, h('h2', { text: 'Already have a vault?' }),
      h('div', { class: 'row' },
        btn('Restore from a backup file', function () { lockPath = 'restore'; restorePick = null; notice = null; render(); }, '', { id: 'path-restore' }),
        btn('Use my Google Drive copy', function () { lockPath = 'drive'; notice = null; render(); }, '', { id: 'path-drive' }))) : null;
    return h('div', { class: 'lockwrap' }, h('h1', { text: 'LifeOS' }), intro, noticeEl, updateBanner(), inner, paths);
  }
  function unlockForm(create) {
    var p1 = h('input', { type: 'password', id: 'pass', autocomplete: create ? 'new-password' : 'current-password', required: true, minlength: create ? '12' : null });
    var p2 = create ? h('input', { type: 'password', id: 'pass2', autocomplete: 'new-password', required: true, minlength: '12' }) : null;
    return h('form', {
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
          var wait = leftOf(mainFail);
          if (wait > 0) throw new Error('Wrong passphrase. Wait ' + wait + ' s before trying again.');
          return L.store.unlock(a).then(function (st) { mainFail = { n: 0, until: 0 }; return st; }, function (e) { if (e && e.message === 'BAD_PASSPHRASE_OR_DATA') bumpOf(mainFail); throw e; }).then(function () { return commit(null, 'unlock'); }).then(afterUnlock);
        }).then(function () { p1.value = ''; if (p2) p2.value = ''; });
      }
    },
      field(create ? 'Choose a passphrase (12 characters or more)' : 'Passphrase', p1),
      p2 ? field('Confirm passphrase', p2) : null,
      create ? passNote() : null,
      h('button', { type: 'submit', class: 'btn pri', text: create ? 'Create vault' : 'Unlock' }),
      !create && L.recoveryUI ? L.recoveryUI.lockLink(recCtx()) : null);
  }
  function backLink() { return btn('Back', function () { lockPath = 'create'; restorePick = null; driveCopy = null; notice = null; render(); }, '', { id: 'path-back' }); }
  // After a vault is made from a backup or a Drive copy: record it, then open it like any unlock. A failed audit write never undoes the vault.
  function enterNew(action) {
    vaultExists = true; lockPath = 'create'; restorePick = null; driveCopy = null; driveCid = '';
    return commit(null, action).catch(function () {}).then(afterUnlock);
  }
  function restorePath() {
    var file = h('input', { type: 'file', id: 'rs-file', accept: '.json,application/json' }), pass = passOnly('rs-pass', 'off'), out = h('div', { id: 'rs-out', role: 'status' });
    // SEC-128: a backup made while a main recovery key was on also opens with that key; the restored vault then gets a new passphrase.
    var useKey = h('input', { type: 'checkbox', id: 'rs-use-key' });
    function showPreview(r, text, secret) {
      var byKey = typeof secret === 'object', n1 = byKey ? passOnly('rs-new-pass', 'new-password') : null, n2 = byKey ? passOnly('rs-new-pass2', 'new-password') : null;
      var rows = r.rows.map(function (x) { return h('li', { text: x.label + ': ' + x.backup }); });
      out.replaceChildren(h('div', { id: 'rs-ok' },
        h('p', { class: 'small', text: 'This file passed the same checks as a restore inside the app. Nothing is saved until you confirm.' }),
        h('ul', { class: 'small' },
          h('li', { id: 'rs-schema', text: 'Schema: ' + r.schema + (r.sourceSchema !== r.schema ? ' (file written as schema ' + r.sourceSchema + ')' : '') }),
          h('li', { id: 'rs-date', text: 'Made on: ' + (r.madeOn || 'not recorded in this file') }),
          h('li', { id: 'rs-priv', text: 'Private vault in the file: ' + (r.priv ? 'yes' : 'no') })),
        rows.length ? h('ul', { id: 'rs-rows', class: 'small' }, rows) : h('p', { class: 'mut small', text: 'The file holds no records.' }),
        byKey ? h('p', { class: 'mut small', text: 'The backup opened with the recovery key. Choose a new passphrase for this device\'s vault (12 characters or more). The restored vault starts with no recovery key.' }) : h('p', { class: 'mut small', text: 'The backup passphrase becomes this device\'s vault passphrase. You can change it later in Settings.' }),
        byKey ? field('New passphrase', n1) : null, byKey ? field('Confirm new passphrase', n2) : null,
        h('div', { class: 'row' }, btn('Use this backup as my vault', function () {
          act(function () {
            var np = secret;
            if (byKey) { checkPass(n1.value); if (n1.value !== n2.value) throw new Error('The two passphrases do not match.'); np = n1.value; }
            return L.vault.importBackup(secret, text).then(function (state) { return L.store.createFromBackup(np, state); }).then(function () { secret = null; if (n1) { n1.value = ''; n2.value = ''; } return enterNew('restore from backup'); });
          }).then(function () { restorePick = null; });
        }, 'pri', { id: 'rs-use' }), btn('Cancel', function () { restorePick = null; out.replaceChildren(); }, '', { id: 'rs-cancel' }))));
      setNotice('ok', 'Backup file verified.');
    }
    return h('div', { class: 'card', id: 'restore-card' }, h('h2', { text: 'Restore from a backup file' }),
      h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          var f = file.files && file.files[0];
          if (!f) { setNotice('err', 'Choose a backup file first.'); return; }
          if (!pass.value) { setNotice('err', useKey.checked ? 'Enter the recovery key.' : 'Enter the backup passphrase.'); return; }
          var secret = useKey.checked ? { recovery: pass.value } : pass.value; pass.value = '';
          act(function () {
            return readFile(f, L.vault.MAX_BACKUP).then(function (text) {
              var wait = useKey.checked ? leftOf(mainFail) : 0;
              if (wait > 0) throw new Error('Wrong key or passphrase. Wait ' + wait + ' s before trying again.');
              return L.ops.verifyBackup(secret, text, { schema: L.store.SCHEMA }).then(function (r) {
                out.replaceChildren();
                if (!r.ok) { if (r.reason === 'BAD_RECOVERY_KEY') bumpOf(mainFail); setNotice('err', r.message); return; }
                showPreview(r, text, secret);
              });
            });
          });
        }
      }, field('Backup file (64 MB max)', file), field('Backup passphrase, or the recovery key when the box below is ticked', pass),
        h('label', { class: 'row small' }, useKey, h('span', { text: 'Open with the main recovery key the backup carries' })),
        h('button', { type: 'submit', class: 'btn pri', id: 'rs-check', text: 'Check backup file' })),
      out, h('div', { class: 'row' }, backLink()));
  }
  function drivePath() {
    var card = h('div', { class: 'card', id: 'drive-card' }, h('h2', { text: 'Use my Google Drive copy' }));
    if (!L.sync || !L.sync.isAvailable(window.location)) {
      card.appendChild(h('p', { class: 'mut', id: 'drive-na', text: 'Google Drive is only offered when this page is served over https.' }));
      card.appendChild(h('div', { class: 'row' }, backLink()));
      return card;
    }
    if (!driveCid) driveCid = L.sync.takeClientId(window.sessionStorage);
    if (!L.sync.isConnected()) {
      var cid = h('input', { type: 'text', id: 'dv-cid', maxlength: '200', placeholder: 'xxxx.apps.googleusercontent.com', value: driveCid });
      card.appendChild(h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          try { window.location.assign(L.sync.begin(cid.value, { loc: window.location, storage: window.sessionStorage, keepClientId: true })); }
          catch (x) { setNotice('err', x.message); }
        }
      }, h('p', { class: 'mut small', text: 'Sign in to Google, download the encrypted copy, then unlock it with the passphrase it was made with. See docs/SYNC-SETUP.md for the client ID.' }),
        field('Google OAuth client ID', cid), h('button', { type: 'submit', class: 'btn pri', id: 'dv-connect', text: 'Connect Google Drive' })));
    } else if (!driveCopy) {
      card.appendChild(h('p', { class: 'small', text: 'Connected to Google.' }));
      card.appendChild(btn('Download my Drive copy', function () {
        act(function () { return L.sync.fetchCopy().then(function (c) { driveCopy = c; render(); }); });
      }, 'pri', { id: 'dv-fetch' }));
    } else {
      var pass = passOnly('dv-pass', 'off');
      card.appendChild(h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          var pv = pass.value; pass.value = '';
          if (!pv) { setNotice('err', 'Enter the passphrase of the Drive copy.'); return; }
          act(function () {
            return L.sync.installCopy(driveCopy, pv, driveCid).then(function () { return enterNew('restore from Drive'); });
          });
        }
      }, h('p', { class: 'small', id: 'dv-found', text: 'Found your encrypted copy on Drive.' + (driveCopy.copies > 1 ? ' Drive holds ' + driveCopy.copies + ' LifeOS copies; the newest is used.' : '') }),
        field('Passphrase of the Drive copy', pass), h('button', { type: 'submit', class: 'btn pri', id: 'dv-use', text: 'Open this copy' })));
    }
    card.appendChild(h('div', { class: 'row' }, backLink()));
    return card;
  }
  function archCtx() {
    return { h: h, field: field, btn: btn, openDialog: openDialog, commit: commit, download: download, setNotice: setNotice, render: render, go: go, readFile: readFile, today: today, friendly: friendly };
  }
  // v1.8.0: the recovery screens. main and priv are the wrong-attempt delay counters shared with the unlock forms.
  function recCtx() {
    return { h: h, field: field, btn: btn, openDialog: openDialog, closeDialog: closeDialog, commit: commit, setNotice: setNotice, render: render, go: go, friendly: friendly, act: act,
      passField: function (id) { return passOnly(id, 'off'); },
      lockMode: function (on) { lockRecover = !!on; notice = null; render(); },
      enter: function (action) { return enterNew(action); },
      main: { left: function () { return leftOf(mainFail); }, bad: function () { bumpOf(mainFail); }, ok: function () { mainFail = { n: 0, until: 0 }; } },
      priv: { left: function () { return leftOf(privFail); }, bad: function () { bumpOf(privFail); }, ok: function () { privFail = { n: 0, until: 0 }; } } };
  }
  function syncCtx() {
    return { h: h, field: field, btn: btn, openDialog: openDialog, commit: commit, download: download, setNotice: setNotice, render: render };
  }
  function afterUnlock() {
    notice = null; csvPending = null; ai = null; lockRecover = false;
    resetIdle(true);
    view = { name: 'dashboard' };
    hist.start();
    render();
    if (L.syncUI) L.syncUI.afterUnlock(syncCtx());
    // v1.5.0 B11: one line after unlock when a weekly review is due. The dashboard card has the button; nothing starts by itself.
    try { var rd = L.memory.reviewDue(mainState(), today()); if (rd.due) setNotice('ok', rd.never ? 'Weekly review due: none finished yet.' : 'Weekly review due: the last one was ' + rd.days + ' days ago.'); } catch (e) { /* the notice is optional */ }
    // v1.3.0 B1: ask the browser to keep this storage (until granted); the result is recorded. Never blocks and never throws.
    try { L.ops.persistOnUnlock(navigator.storage, today()).catch(function () {}); } catch (e) { /* the API may be missing */ }
  }
  // ---------- backup safety, storage and diagnostics (v1.3.0) ----------
  function daysAgoText(iso) {
    if (!iso) return 'none yet';
    var n = L.ops.daysBetween(iso, today());
    return iso + (n <= 0 ? ' (today)' : n === 1 ? ' (1 day ago)' : ' (' + n + ' days ago)');
  }
  // One tap from the banner opens this dialog (the backup passphrase is typed each time); nothing is exported until the owner confirms.
  // v1.8.0: with a main recovery key on, the file carries it too, so the owner types it here (checked against the vault's own wrap, never stored).
  function runExport(p1, p2, rkText) {
    checkPass(p1);
    if (p1 !== p2) throw new Error('The backup passphrases do not match.');
    var copy = JSON.parse(JSON.stringify(mainState()));
    L.ops.markBackup(copy, today(), L.store.getMeta().rev);
    var recOn = L.store.hasRecovery();
    if (recOn && !rkText) throw new Error('Type your recovery key so the backup file carries it.');
    var pre = recOn ? L.recoveryUI.attempt(recCtx().main, function () { return L.store.recoveryMatches(rkText).then(function (ok) { if (!ok) throw new Error('BAD_RECOVERY_KEY'); }); }) : Promise.resolve();
    return pre.then(function () { return L.vault.exportBackup(p1, copy, recOn ? rkText : undefined); }).then(function (text) {
      download('lifeos-backup-' + today() + '.json', text, 'application/json');
      return L.store.commit(function (x) { L.ops.markBackup(x, today(), L.store.getMeta().rev); addAudit(x, 'export'); });
    }, function (e) { L.ops.record('BACKUP_EXPORT_FAIL', 'backup'); throw e; });
  }
  function exportDialog() {
    var a = passOnly('rem-pass', 'new-password'), b = passOnly('rem-pass2', 'new-password'), rk = L.store.hasRecovery() ? passOnly('rem-key', 'off') : null;
    openDialog({
      title: 'Export an encrypted backup', yes: 'Export backup',
      body: [field('Backup passphrase (12 characters or more)', a), field('Confirm backup passphrase', b), rk ? field('Recovery key (the backup file carries it)', rk) : null, passNote()],
      onYes: function () { return runExport(a.value, b.value, rk ? rk.value : '').then(function () { a.value = ''; b.value = ''; if (rk) rk.value = ''; setNotice('ok', 'Backup downloaded.'); render(); }); }
    });
  }
  // Never automatic: the banner only offers. Hidden for a day after "Snooze one day".
  function backupBanner() {
    var m, r;
    try { m = mainState(); r = L.ops.reminder(m, today(), L.store.getMeta().rev); } catch (e) { return null; }
    if (!r.due) return null;
    var why = r.why === 'never' ? 'This vault has changes and no backup or sync yet.' : r.why === 'saves' ? 'There have been more than ' + L.ops.SAVES_LIMIT + ' saves since the last backup or sync.' : 'The last backup or sync was ' + r.days + (r.days === 1 ? ' day' : ' days') + ' ago.';
    return h('div', { class: 'warn', id: 'backup-banner', role: 'status' }, h('span', { text: why + ' ' }),
      btn('Export backup', exportDialog, 'sm', { id: 'banner-export' }), ' ',
      btn('Snooze one day', function () { act(function () { return L.store.commit(function (x) { L.ops.snooze(x, today()); }, { quiet: true }).then(function () { render(); }); }); }, 'sm', { id: 'banner-snooze' }));
  }
  function fillStorage(statusEl, helpEl, estEl) {
    var stg = null, rec = 'unknown';
    try { stg = navigator.storage || null; rec = mainState().ops.persist.result; } catch (e) { /* locked or missing */ }
    Promise.resolve().then(function () { return stg && typeof stg.persisted === 'function' ? stg.persisted() : null; }).catch(function () { return null; }).then(function (p) {
      var kept = p === true || (p === null && rec === 'granted');
      statusEl.textContent = L.ops.storageText(kept);
      if (helpEl) helpEl.textContent = kept ? '' : 'Browsers can clear storage like this when space runs low. To lower the risk: bookmark this page, install it if your browser offers that, and export a backup.' + (stg && typeof stg.persist === 'function' ? '' : ' This browser does not offer a way to ask for kept storage.');
    });
    if (estEl) L.ops.estimate(stg).then(function (e) {
      estEl.textContent = e ? 'Used on this device: ' + L.ops.bytesText(e.usage) + (e.quota ? ' of about ' + L.ops.bytesText(e.quota) : '') + '.' : 'Storage use is not available in this browser.';
    });
  }
  function safetyCard(s) {
    var o = s.ops, est = h('p', { class: 'small mut', id: 'safety-estimate', text: '' }), stat = h('p', { class: 'small', id: 'safety-storage', text: 'Storage: checking' });
    fillStorage(stat, null, est);
    return h('div', { class: 'card', id: 'safety-card' }, h('h2', { text: 'Backup and storage' }),
      h('p', { class: 'small', id: 'safety-backup', text: 'Last backup: ' + daysAgoText(o.lastBackupAt) }),
      h('p', { class: 'small', id: 'safety-sync', text: 'Last sync: ' + daysAgoText(o.lastSyncAt) }),
      stat, est, btn('Open backup and storage', function () { go('settings'); }, 'sm', { id: 'safety-open' }));
  }
  function verifyResult(box, r) {
    box.replaceChildren();
    if (!r.ok) { box.appendChild(h('p', { class: 'warn small', id: 'verify-fail', text: r.message })); return; }
    var cur = mainState();
    var rows = r.rows.map(function (x) { return h('li', { class: 'small', text: x.label + ': ' + x.backup + ' in the file, ' + x.live + ' in this vault' + (x.backup === x.live ? ' (same)' : ' (differs)') }); });
    box.appendChild(h('div', { id: 'verify-ok' },
      h('p', { class: 'ok small', text: 'This backup decrypted and passed every check. It was read in memory only. Nothing was written.' }),
      h('ul', { class: 'small' },
        h('li', { id: 'verify-schema', text: 'Schema: ' + r.schema + (r.sourceSchema !== r.schema ? ' (file written as schema ' + r.sourceSchema + ')' : '') + '. This version uses schema ' + cur.schema + '.' }),
        h('li', { id: 'verify-rev', text: 'Revision: ' + (r.rev !== null ? r.rev : 'not recorded in this file') + '. This vault is at revision ' + L.store.getMeta().rev + '.' }),
        h('li', { id: 'verify-date', text: 'Made on: ' + (r.madeOn || 'not recorded in this file') }),
        h('li', { id: 'verify-priv', text: 'Private vault in the file: ' + (r.priv ? 'yes' : 'no') + '. In this vault now: ' + (r.livePriv ? 'yes' : 'no') + '.' })),
      h('p', { class: 'small', text: 'Counts in the file against this vault' }),
      rows.length ? h('ul', { id: 'verify-rows' }, rows) : h('p', { class: 'mut small', text: 'Both are empty.' })));
  }
  function safetySettings(s) {
    var set = s.settings, o = s.ops;
    var stat = h('p', { id: 'storage-status', role: 'status', text: 'Storage: checking' }), help = h('p', { class: 'small mut', id: 'storage-help', text: '' }), est = h('p', { class: 'small', id: 'storage-estimate', text: '' });
    fillStorage(stat, help, est);
    var days = h('input', { type: 'number', id: 'rem-days', min: '1', max: '60', step: '1', value: set.backupReminderDays });
    var syncTick = h('input', { type: 'checkbox', id: 'rem-sync', checked: set.syncReminder });
    var vf = h('input', { type: 'file', id: 'vf-file', accept: '.json,application/json' }), vp = passOnly('vf-pass', 'off'), vout = h('div', { id: 'verify-out', role: 'status' });
    var dtext = h('p', { class: 'small mut', id: 'diag-count', text: '' });
    var paintDiag = function () { var n = (mainState().ops.diag || []).length + L.ops._pending().length; dtext.textContent = n + (n === 1 ? ' code' : ' codes') + ' recorded on this device. Codes only: no text, values, ids or names.'; };
    paintDiag();
    var dbox = h('div', { id: 'diag-fallback' });
    return h('div', { class: 'card', id: 'safety-settings' }, h('h2', { text: 'Storage and backup safety' }),
      stat, help, est,
      h('p', { class: 'small', id: 'set-lastbackup', text: 'Last backup: ' + daysAgoText(o.lastBackupAt) + (o.lastBackupAt && o.backupRev ? ', revision ' + o.backupRev : '') }),
      h('p', { class: 'small', id: 'set-lastsync', text: 'Last sync: ' + daysAgoText(o.lastSyncAt) }),
      h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          act(function () {
            var n = Number(days.value), on = !!syncTick.checked;
            if (!Number.isInteger(n) || n < 1 || n > 60) throw new Error('Enter a whole number of days from 1 to 60.');
            return L.store.commit(function (x) { x.settings.backupReminderDays = n; x.settings.syncReminder = on; addAudit(x, 'reminder settings'); }).then(function () { setNotice('ok', 'Reminder settings saved.'); render(); });
          });
        }
      }, field('Remind me to back up after this many days (1 to 60)', days),
        h('label', { class: 'row small' }, syncTick, h('span', { text: 'Remind me to sync when I lock or leave the tab with changes not on Drive' })),
        h('button', { type: 'submit', class: 'btn', id: 'rem-save', text: 'Save reminder settings' })),
      h('hr'),
      h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          var f = vf.files && vf.files[0];
          if (!f) { setNotice('err', 'Choose a backup file first.'); return; }
          if (!vp.value) { setNotice('err', 'Enter the backup passphrase.'); return; }
          var pv = vp.value; vp.value = ''; // never left in the field, whether it works or not
          act(function () {
            return readFile(f, L.vault.MAX_BACKUP).then(function (text) { return L.ops.verifyBackup(pv, text, mainState()); }).then(function (r) {
              if (!L.store.isUnlocked()) return;
              verifyResult(vout, r);
              if (r.ok) setNotice('ok', 'Backup file verified. Nothing was written.'); else setNotice('err', r.message);
            });
          });
        }
      }, field('Verify a backup file (checked in memory, nothing is written)', vf), field('Backup passphrase', vp),
        h('button', { type: 'submit', class: 'btn', id: 'verify-btn', text: 'Verify backup file' }), vout),
      h('hr'),
      h('h3', { text: 'Diagnostics' }), dtext,
      h('div', { class: 'row' },
        btn('Copy diagnostics', function () {
          var text = L.ops.format(mainState(), { version: L.VERSION, userAgent: navigator.userAgent });
          var p = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'));
          p.then(function () { setNotice('ok', 'Diagnostics copied. They hold codes, the version, the schema and the browser family only.'); }, function () {
            dbox.replaceChildren(h('textarea', { id: 'diag-text', readOnly: true, rows: '8', 'aria-label': 'Diagnostics text', value: text }));
            var ta = dbox.firstChild; ta.focus(); ta.select();
            setNotice('err', 'The browser blocked copying. Select the text below and copy it.');
          });
        }, '', { id: 'diag-copy' }),
        btn('Clear diagnostics', function () { act(function () { return L.store.commit(function (x) { L.ops.clear(x); addAudit(x, 'diagnostics cleared'); }).then(function () { dbox.replaceChildren(); paintDiag(); setNotice('ok', 'Diagnostics cleared.'); }); }); }, '', { id: 'diag-clear' })),
        dbox);
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
    var built = {};
    L.DOMAINS.forEach(function (d) {
      if (d.id === 'wellbeing') { built['tile-wellbeing'] = wellbeingTile(s, d, t); return; }
      var hl, ser;
      try { hl = L.metrics.headline(s, d.id, t); } catch (e) { hl = { label: '', display: '-', sub: '' }; }
      try { ser = L.metrics.series(s, d.id, 8, t); } catch (e) { ser = []; }
      built['tile-' + d.id] = h('button', { type: 'button', class: 'tile', 'data-domain': d.id, onclick: function () { go('domain', { domain: d.id }); } },
        h('span', { class: 'tile-title' }, d.label, ' ', lockMark(DOMAIN_COLLS[d.id])),
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
    var stk = L.memory.reviewStreak(s, t);
    pr.appendChild(h('p', { class: 'mut small', id: 'dash-streak', text: 'Review streak: ' + stk + (stk === 1 ? ' week' : ' weeks') + ' in a row.' }));
    if (!rv || rv.weekOf !== wk) pr.appendChild(btn('Start weekly review', function () { go('review'); }, 'pri'));
    built.priorities = pr;
    built.glance = glanceCard(s, t, 'dash-glance');
    built['rev-month'] = revMonthTile(s, t);
    built['rev-net-line'] = revNetLineCard(s, t);
    built['rev-expected'] = revExpectedTile(s, t);
    built['tax-setaside'] = taxSetAsideMod(s); built['tax-next'] = taxNextMod(s); built['inv-open'] = invOpenMod(s); built['budget-pinned'] = budgetPinnedMod(s); built['payees-near'] = payeesNearMod(s);
    var due = L.metrics.dueRecurring(s, t).length;
    var w = L.layout.which(window.innerWidth), list = L.layout.get(s.settings, w, { state: mainState() });
    var mods = [];
    list.forEach(function (m, i) {
      var el = built[m.id];
      // v1.4.0 B10: on a narrow screen a module with nothing to show is one line (never while editing the layout).
      if (el && w === 'narrow' && !dashEdit && L.layout.isEmpty(s, m.id)) el = emptyLine(m, el);
      if (!dashEdit && (m.hidden || !el)) return;
      mods.push(h('div', { class: 'mod ' + m.size + (m.hidden ? ' modhidden' : ''), 'data-mod': m.id, 'data-size': m.size, 'data-hidden': m.hidden ? 'true' : 'false' },
        dashEdit ? modBar(list, m, i, w) : null,
        h('div', { class: 'modbody', inert: dashEdit ? true : null }, el || h('p', { class: 'mut small', text: L.layout.label(m.id) + ' has nothing to show right now.' }))));
    });
    return h('div', null, h('div', { class: 'row sp' }, h('h1', { text: 'Dashboard' }), h('div', { class: 'row' }, btn('Log study', function () { studyDialog(''); }, 'qa-btn', { id: 'quick-study' }), btn('Add activity', function () { go('domain', { domain: 'activities', open: 'act-add' }); }, 'qa-btn', { id: 'quick-activity' }), btn('Quick add', quickAdd, 'pri qa-btn', { id: 'quick-add' }), btn(dashEdit ? 'Done' : 'Customize', function () { dashEdit = !dashEdit; render(); }, 'qa-btn', { id: 'dash-customize' }))),
      reviewDueCard(mainState(), t),
      setupCard(mainState()),
      L.archiveUI ? L.archiveUI.proposal(archCtx()) : null,
      safetyCard(mainState()),
      due ? h('div', { class: 'warn' }, due + (due === 1 ? ' recurring item is' : ' recurring items are') + ' due. ', btn('Review', function () { go('domain', { domain: 'money' }); }, 'sm', { id: 'due-review' })) : null,
      dashEdit ? h('div', { class: 'card', id: 'dash-edit' }, h('p', { class: 'small', id: 'dash-edit-note', text: 'Editing the layout for ' + (w === 'narrow' ? 'narrow screens (under 720 px wide)' : 'wide screens (720 px and over)') + '. Drag a module or use Move up and Move down. Hidden modules are dimmed.' }),
        btn('Reset to default', function () { act(function () { return commit(function (x) { L.layout.reset(x.settings, w); }).then(function () { setNotice('ok', 'Layout reset.'); render(); }); }); }, 'sm', { id: 'dash-reset' })) : null,
      h('div', { class: 'grid modgrid' + (dashEdit ? ' editing' : ''), id: 'dash-grid', 'data-layout': w }, mods));
  }

  // A module with no data, drawn as one line that opens the same place the full module does.
  // The module itself, drawn on one line (CSS hides its chart and detail lines), so it keeps its text, its ids and its tap target.
  function emptyLine(m, el) {
    el.classList.add('tile-empty');
    return el;
  }
  // v1.4.0 B9: the setup checklist of a new vault. Items tick from the vault's state; Dismiss hides it for good.
  function setupCard(s) {
    if (!L.setup.shown(s)) return null;
    var its = L.setup.items(s, Number(today().slice(0, 4))), done = its.filter(function (x) { return x.done; }).length;
    return h('div', { class: 'card', id: 'setup-card' }, h('h2', { text: 'Setup checklist' }),
      h('p', { class: 'mut small', id: 'setup-count', text: done + ' of ' + its.length + ' done' }),
      h('ul', { class: 'setuplist' }, its.map(function (x) {
        return h('li', { class: 'setupitem', 'data-item': x.id, 'data-done': x.done ? 'true' : 'false' },
          h('span', { class: 'chip' + (x.done ? ' ok' : ''), text: x.done ? 'Done' : 'To do' }), h('span', { text: ' ' + x.label + ' ' }),
          x.done ? null : btn('Open', function () { goKey(x.where); }, 'sm', { 'aria-label': 'Open: ' + x.label }));
      })),
      L.recoveryUI ? L.recoveryUI.setupPrompt(recCtx()) : null,
      L.guideUI ? btn('Getting started', function () { L.guideUI.open(recCtx()); }, 'sm', { id: 'setup-guide' }) : null,
      btn('Dismiss checklist', function () { act(function () { return commit(function (x) { x.settings.setup.dismissed = true; }, 'setup dismissed').then(function () { render(); }); }); }, 'sm', { id: 'setup-dismiss' }));
  }

  // ---------- customizable home (v0.12.0) ----------
  function saveLayout(list, w, focus) {
    return act(function () {
      return commit(function (x) { L.layout.set(x.settings, w, list); }).then(function () {
        render();
        if (focus) { var f = document.querySelector('.mod[data-mod="' + focus.id + '"] ' + focus.sel); if (f && !f.disabled) f.focus(); else { var g = document.querySelector('.mod[data-mod="' + focus.id + '"] .mv-hide'); if (g) g.focus(); } }
      });
    });
  }
  function modBar(list, m, i, w) {
    var label = L.layout.label(m.id), def = L.layout.MODULES.filter(function (x) { return x.id === m.id; })[0];
    // UI-10: dragging is pointer only (mouse or touch); keyboard and screen reader users have Move up and Move down.
    var drag = h('button', { type: 'button', class: 'btn sm drag', text: 'Drag', title: 'Drag with a mouse or finger to reorder', tabindex: '-1', 'aria-hidden': 'true' });
    drag.addEventListener('pointerdown', function (e) { dragModule(e, drag, list, w); });
    return h('div', { class: 'modbar' },
      h('strong', { class: 'modname', text: label }),
      drag,
      btn('Move up', function () { saveLayout(L.layout.move(list, m.id, -1), w, { id: m.id, sel: '.mv-up' }); }, 'sm mv-up', { 'aria-label': 'Move ' + label + ' up', disabled: i === 0 }),
      btn('Move down', function () { saveLayout(L.layout.move(list, m.id, 1), w, { id: m.id, sel: '.mv-down' }); }, 'sm mv-down', { 'aria-label': 'Move ' + label + ' down', disabled: i === list.length - 1 }),
      btn(m.hidden ? 'Show' : 'Hide', function () { saveLayout(L.layout.setHidden(list, m.id, !m.hidden), w, { id: m.id, sel: '.mv-hide' }); }, 'sm mv-hide', { 'aria-label': (m.hidden ? 'Show ' : 'Hide ') + label }),
      def.sizes.length > 1 ? sizeSel(list, m, w, label) : null);
  }
  // UI-2, UI-3: the size select is named for its module and found again by its class after the save re-renders.
  function sizeSel(list, m, w, label) {
    var z = sel(null, [{ v: 'small', t: 'Small' }, { v: 'wide', t: 'Wide' }], m.size, function (e) { saveLayout(L.layout.setSize(list, m.id, e.target.value), w, { id: m.id, sel: '.mv-size' }); });
    z.setAttribute('class', 'mv-size');
    z.setAttribute('aria-label', 'Size of ' + label);
    return z;
  }
  // Pointer-event drag (mouse and touch): the module follows the pointer by moving in the grid; on release the new order is saved.
  function dragModule(e, handle, list, w) {
    if (e.button !== undefined && e.button !== 0) return;
    var wrap = handle.closest('.mod'), grid = wrap.parentNode;
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    var ids = function () { return Array.prototype.map.call(grid.children, function (c) { return c.getAttribute('data-mod'); }); };
    var before = ids().join(',');
    wrap.classList.add('dragging');
    function move(ev) {
      var gr = grid.getBoundingClientRect(), kids = Array.prototype.filter.call(grid.children, function (c) { return c !== wrap; });
      for (var i = 0; i < kids.length; i++) {
        var r = kids[i].getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
          var stacked = r.width > gr.width * 0.9, first = stacked ? ev.clientY < r.top + r.height / 2 : ev.clientX < r.left + r.width / 2;
          grid.insertBefore(wrap, first ? kids[i] : kids[i].nextSibling);
          break;
        }
      }
    }
    function stop() { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel); wrap.classList.remove('dragging'); }
    function up() {
      stop();
      var order = ids();
      if (order.join(',') === before) return;
      var byId = {};
      list.forEach(function (m) { byId[m.id] = m; });
      saveLayout(order.map(function (id) { return byId[id]; }), w, { id: wrap.getAttribute('data-mod'), sel: '.drag' });
    }
    function cancel() { stop(); render(); }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
  }
  function revMonthTile(s, t) {
    var tot = L.revenue.totalsIn(s, { kind: 'all' }, t.slice(0, 7) + '-01', L.metrics.monthEnd(t.slice(0, 7)));
    return h('button', { type: 'button', class: 'rtile', id: 'tile-rev-month', onclick: function () { go('domain', { domain: 'work', revenue: true }); } },
      h('span', { class: 'tile-title' }, 'Revenue this month ', lockMark(['entries', 'projects'])),
      h('span', { class: 'tile-value', id: 'dm-revenue', text: fmtC(s, tot.revenueCents) }),
      h('span', { class: 'tile-sub', text: 'Received income' }),
      h('span', { class: 'tile-sub', id: 'dm-sub', text: 'Expenses ' + fmtC(s, tot.expenseCents) + ', net ' + fmtC(s, tot.netCents) }));
  }
  function revNetLineCard(s, t) {
    var rep = L.revenue.report(s, L.revenue.periodRange('month', t));
    var rows = rep.lines.filter(function (l) { return l.revenueCents || l.expenseCents; }).concat(rep.unassigned.revenueCents || rep.unassigned.expenseCents ? [rep.unassigned] : [])
      .sort(function (a, b) { return b.netCents - a.netCents || a.name.localeCompare(b.name); });
    return h('div', { class: 'card', id: 'card-rev-net-line' }, h('h2', null, 'Net by line of work this month ', lockMark(['entries', 'projects'])),
      rows.length ? rows.slice(0, 8).map(function (l) {
        return h('div', { class: 'row sp item', 'data-line': l.name }, h('span', { text: l.name }), h('span', { class: l.netCents < 0 ? 'bad-t' : '', text: fmtC(s, l.netCents) }));
      }) : h('p', { class: 'mut', text: 'No money recorded this month.' }),
      btn('Open Revenue', function () { go('domain', { domain: 'work', revenue: true }); }, 'sm', { id: 'rev-open-card' }));
  }
  function revExpectedTile(s, t) {
    var ex = L.revenue.expected(s, { kind: 'all' }, t);
    return h('button', { type: 'button', class: 'rtile', id: 'tile-rev-expected', onclick: function () { go('domain', { domain: 'work', revenue: true }); } },
      h('span', { class: 'tile-title' }, 'Expected income ', lockMark(['entries', 'projects'])),
      h('span', { class: 'tile-value', id: 'de-next30', text: fmtC(s, ex.next30Cents) }),
      h('span', { class: 'tile-sub', text: 'Expected in the next 30 days' }),
      h('span', { class: 'tile-sub', id: 'de-overdue', text: ex.overdueCount + ' overdue (' + fmtC(s, ex.overdueCents) + ')' }));
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
      refs.line = sel('f-line', lineOptions(s, '(no line of work)'), '');
      fs.push(field('Line of work (optional)', refs.line));
      refs.scope = sel('f-scope', [{ v: '', t: 'Automatic (by line of work)' }, { v: 'business', t: 'Business' }, { v: 'personal', t: 'Personal' }], '');
      fs.push(field('Business or personal', refs.scope));
      if (tid === 'expense') {
        refs.billable = h('input', { type: 'checkbox', id: 'f-billable' }); refs.reimb = h('input', { type: 'checkbox', id: 'f-reimb' }); refs.card = h('input', { type: 'checkbox', id: 'f-cardpaid' });
        refs.payee = sel('f-payee', [{ v: '', t: '(no payee)' }].concat((s.payees || []).filter(function (x) { return !x.archived; }).map(function (x) { return { v: x.id, t: x.name }; })), '');
        fs.push(h('label', { class: 'field check' }, refs.billable, h('span', { text: 'Billable to a client' })), h('label', { class: 'field check' }, refs.reimb, h('span', { text: 'Reimbursable' })),
          field('Payee (1099 contractor)', refs.payee), h('label', { class: 'field check' }, refs.card, h('span', { text: 'Paid by card (left out of the 1099 total)' })));
      }
      if (tid === 'income') {
        refs.mstatus = sel('f-mstatus', [{ v: 'received', t: 'Received' }, { v: 'expected', t: 'Expected (not counted until received)' }], 'received');
        refs.mdue = h('input', { type: 'date', id: 'f-mdue' });
        fs.push(field('Income status', refs.mstatus), field('Due date (expected income)', refs.mdue));
      }
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
          if (refs.line && refs.line.value) p.projectId = refs.line.value;
          if (refs.mstatus && refs.mstatus.value === 'expected') p.status = 'expected';
          if (refs.scope && refs.scope.value) p.scope = refs.scope.value;
          if (refs.billable && refs.billable.checked) p.billable = true;
          if (refs.reimb && refs.reimb.checked) p.reimbursable = true;
          if (refs.payee && refs.payee.value) p.payeeId = refs.payee.value;
          if (refs.card && refs.card.checked && refs.payee && refs.payee.value) p.cardPaid = true;
          if (refs.mdue && refs.mdue.value) p.dueDate = refs.mdue.value;
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
      if (en.dueDate) meta.push('due ' + en.dueDate);
      if (en.projectId && projName(s, en.projectId)) meta.push(projName(s, en.projectId));
      if (en.person) meta.push(en.person);
      if (en.due) meta.push('due ' + en.due);
      if (en.kind) meta.push(en.kind);
      if (en.minutes !== undefined) meta.push(en.minutes + ' min');
      if (en.effort !== undefined) meta.push('effort ' + en.effort);
      return h('div', ROW({ class: 'entry' }, 'entries', en),
        h('div', null, h('div', { class: 'entry-t', text: en.title }),
          h('div', { class: 'mut small', text: en.date + ' | ' + meta.join(' | ') }),
          en.notes ? h('div', { class: 'small', text: en.notes }) : null),
        h('div', { class: 'row' },
          L.revenue.isExpected(en) ? btn('Mark received', function () { markReceivedDialog({ id: en.id, title: en.title }); }, 'sm pri', { 'aria-label': 'Mark ' + en.title + ' received' }) : null,
          btn('Delete', function () {
            openDialog({
              title: 'Delete this entry?', yes: 'Delete', danger: true,
              body: h('p', { class: 'mut', text: en.title }),
              onYes: function () { return commit(function (x) { x.entries = x.entries.filter(function (z) { return z.id !== en.id; }); }).then(function () { render(); }); }
            });
          }, 'sm bad', { 'aria-label': 'Delete ' + en.title })));
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
        // Exports are computed from the main state only, even while the private vault is open.
        var out = mainState().entries.filter(function (x) { return x.domain === d.id; });
        if (!out.length) throw new Error('No entries to export.');
        download('lifeos-' + d.id + '.csv', L.csv.exportEntries(out), 'text/csv');
        return commit(null, 'export');
      }, 'CSV exported.');
    }), lockMark(DOMAIN_COLLS[d.id])));
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
      title: 'Quick add', yes: 'Save', adds: true,
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
              act(function () { return commit(function (x) { L.metrics.confirmRecurring(x, d.id, today()); }, 'recurring confirm', [['recurring', d.id]]).then(function () { setNotice('ok', 'Posted ' + d.title + '.'); render(); }); });
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
        return h('div', ROW({ class: 'item' }, 'budgets', b), h('span', { text: b.category + ': ' + moneyFmt(L.metrics.cents(b.value), cur) }),
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
    var rLine = sel('rc-line', lineOptions(s, '(no line of work)'), '');
    var recurring = details('recurring', 'Recurring items (' + s.recurring.length + ')', [
      h('p', { class: 'mut small', text: 'These only create a proposal on the due date. You confirm each one.' }),
      s.recurring.map(function (r) {
        return h('div', ROW({ class: 'item' }, 'recurring', r),
          h('div', null, h('div', { class: 'entry-t', text: r.title }),
            h('div', { class: 'mut small', text: (r.type === 'income' ? 'Income ' : 'Expense ') + moneyFmt(L.metrics.cents(r.value), cur) + ' | ' + r.cadence + ' | next ' + r.nextDate + (r.active ? '' : ' | paused') + (r.household ? ' | household' : '') + (r.projectId && projName(s, r.projectId) ? ' | ' + projName(s, r.projectId) : '') })),
          h('div', { class: 'row' },
            btn(r.active ? 'Pause' : 'Resume', function () { act(function () { return commit(function (x) { x.recurring.forEach(function (z) { if (z.id === r.id) z.active = !z.active; }); }, 'recurring toggle').then(function () { view.open = 'recurring'; render(); }); }); }, 'sm', { 'aria-label': (r.active ? 'Pause ' : 'Resume ') + r.title }),
            btn('Delete', function () { act(function () { return commit(function (x) { x.recurring = x.recurring.filter(function (z) { return z.id !== r.id; }); }, 'recurring delete').then(function () { view.open = 'recurring'; render(); }); }); }, 'sm bad', { 'aria-label': 'Delete ' + r.title })));
      }),
      h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          act(function () {
            var item = { id: L.store.newId(), title: rT.value.trim(), value: parseAmount(rA.value), category: rCat.value, type: rType.value, cadence: rCad.value, nextDate: rNext.value, active: true, household: rType.value === 'expense' && rHouse.checked };
            if (rLine.value) item.projectId = rLine.value;
            if (!item.title) throw new Error('Enter a title.');
            return commit(function (x) { x.recurring.push(item); }, 'recurring add').then(function () { view.open = 'recurring'; setNotice('ok', 'Recurring item added.'); render(); });
          });
        }
      }, field('Title', rT), field('Amount', rA), field('Type', rType), field('Category', rCat), field('Repeats', rCad), field('Next date', rNext), field('Line of work (optional)', rLine), h('label', { class: 'field check' }, rHouse, h('span', { text: 'Household bill (expenses only; shown under Home)' })), h('button', { type: 'submit', class: 'btn pri', text: 'Add recurring' })),
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
      budgets, recurring, cats, bulkAssignCard(s),
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
      return h('div', ROW({ class: 'item acct', 'data-account': a.name }, 'accounts', a, true),
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
        title: 'Rename account', yes: 'Save', body: [field('Name', inp), movePrivBtn('accounts', a)],
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
    var tp = null;
    if (i.target) { try { tp = L.memory.targetPreview(mainState(), i.id); } catch (e) { tp = null; } }
    var kids = [
      h('div', { class: 'row' },
        h('span', { class: 'chip', text: domainLabel(i.domain) }),
        h('span', { class: 'chip', text: 'Level ' + i.level }),
        h('span', { class: 'chip', text: i.source === 'ai' ? 'AI' : 'Rules' }),
        i.status !== 'proposed' ? h('span', { class: 'chip ' + (i.status === 'approved' ? 'ok' : 'bad'), text: i.status }) : null,
        i.status === 'rejected' && i.reason ? h('span', { class: 'chip', 'data-reason': i.reason, text: L.memory.REASON_LABEL[i.reason] }) : null,
        i.target && i.target.applied ? h('span', { class: 'chip ok', text: 'Change applied' }) : null),
      h('p', { text: i.text })
    ];
    // v1.5.0 B12: a proposed target change shows before and after; nothing changes until a tap.
    if (tp) kids.push(h('p', { class: 'small target-change', 'data-key': tp.key, text: tp.applied ? 'Target change: ' + tp.label + ' set to ' + tp.afterText + '.' : 'Proposed target change: ' + tp.label + ' from ' + tp.beforeText + ' to ' + tp.afterText + '. Nothing changes until you tap Apply.' }));
    if (withActions && i.status === 'proposed') {
      kids.push(h('div', { class: 'row' },
        tp ? btn('Approve and apply change', function () {
          act(function () { return commit(function (x) { L.memory.decide(x, i.id, 'approved'); L.memory.applyTarget(x, i.id); }, 'target change').then(function () { setNotice('ok', 'Approved. ' + tp.label + ' is now ' + tp.afterText + '.'); render(); }); });
        }, 'pri sm', { id: 'approve-apply' }) : null,
        btn(tp ? 'Approve only' : 'Approve', function () {
          act(function () { return commit(function (x) { L.memory.decide(x, i.id, 'approved'); }).then(render); });
        }, tp ? 'sm' : 'pri sm', tp ? { id: 'approve-only' } : null),
        btn('Reject', function () { rejectDialog(i); }, 'sm')));
    } else if (withActions && i.status === 'approved' && tp && !tp.applied) {
      kids.push(h('div', { class: 'row' }, btn('Apply change', function () {
        act(function () { return commit(function (x) { L.memory.applyTarget(x, i.id); }, 'target change').then(function () { setNotice('ok', tp.label + ' is now ' + tp.afterText + '.'); render(); }); });
      }, 'pri sm', { id: 'apply-change' })));
    }
    return h('div', { class: 'card', 'data-insight': i.id }, kids);
  }
  // v1.5.0 B12: one fixed reason category is required. The typed note stays optional and on this device (PV-6).
  function rejectDialog(i) {
    var why = h('input', { type: 'text', id: 'reject-reason', maxlength: '200' });
    var cat = sel('reject-category', [{ v: '', t: 'Choose a reason' }].concat(L.memory.REASONS.map(function (r) { return { v: r, t: L.memory.REASON_LABEL[r].charAt(0).toUpperCase() + L.memory.REASON_LABEL[r].slice(1) }; })), '');
    openDialog({
      title: 'Reject this insight', yes: 'Reject',
      body: [h('p', { class: 'mut', text: i.text }),
        field('Reason', cat, 'Only this category and how many times it was chosen in each area can reach the AI.'),
        field('Why? (optional, kept as a note on this device)', why, 'Your reason is never sent to the AI.')],
      onYes: function () {
        if (!cat.value) throw new Error('Choose a reason.');
        var r = why.value.trim().slice(0, 200), c = cat.value;
        return commit(function (x) { L.memory.decide(x, i.id, 'rejected', r || undefined, { category: c }); }).then(function () { render(); });
      }
    });
  }
  function runPropose(items, level, period, source) {
    return commit(function (x) { L.memory.propose(x, items, { level: level, period: period, source: source }); });
  }
  function suggestAI(level, period) {
    return act(function () {
      var s = mainState();
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
    var kind = mainState().settings.provider.kind;
    var box = h('div', null,
      h('div', { class: 'row' }, btn(label, function () { suggestAI(level, period); }, 'sm', { id: level === 1 ? 'ai-suggest' : 'ai-suggest-' + level })),
      h('p', { class: 'mut small', text: kind === 'anthropic' ? 'Sends only the numeric digest, your current targets, approved insights and counts of rejected insights to api.anthropic.com.' : kind === 'local' ? 'Sends only the numeric digest, your current targets, approved insights and counts of rejected insights to your local model.' : 'Manual mode: copy the prompt into your own AI chat and paste the reply here.' }));
    if (ai && ai.level === level && ai.period.from === period.from) {
      var ta = h('textarea', { id: 'ai-prompt', readOnly: true, value: ai.prompt, 'aria-label': 'Prompt to copy' });
      var paste = h('textarea', { id: 'ai-paste', 'aria-label': 'Paste the AI reply here', maxlength: '20000' });
      box.appendChild(h('div', { class: 'card' },
        h('p', { class: 'small', text: 'The prompt holds the numeric digest, your current targets, your approved insights and counts of rejected insights (by area and by the reason you chose). No entries, titles, names or typed reasons.' }),
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

  // ---------- weekly loop (v1.5.0) ----------
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function periodLabel(level, p) {
    var y = p.from.slice(0, 4), m = Number(p.from.slice(5, 7));
    return level === 2 ? MONTHS[m - 1] + ' ' + y : 'Q' + (Math.floor((m - 1) / 3) + 1) + ' ' + y;
  }
  // Offers only: each needs a tap, and nothing is created until then. Shows what would be merged.
  function consolidationOffers(s, t) {
    var offers = L.memory.consolidationOffers(mainState(), t);
    if (!offers.length) return null;
    return h('div', { id: 'offers' }, offers.map(function (o) {
      var kind = o.level === 2 ? 'month' : 'quarter', lbl = periodLabel(o.level, o.period);
      return h('div', { class: 'card', id: 'offer-' + kind, 'data-period': o.period.from },
        h('h2', { text: (o.level === 2 ? 'Month' : 'Quarter') + ' ended: ' + lbl }),
        h('p', { class: 'small', text: 'Offer, nothing happens until you tap. ' + o.count + ' approved ' + (o.level === 2 ? 'weekly' : 'monthly') + (o.count === 1 ? ' insight' : ' insights') + ' would be merged into one ' + (o.level === 2 ? 'monthly' : 'quarterly') + ' entry for you to approve:' }),
        h('ul', { class: 'small' }, o.items.map(function (x) { return h('li', { text: domainLabel(x.domain) + ': ' + x.text }); })),
        h('div', { class: 'row' }, btn('Merge into one entry', function () {
          act(function () { return commit(function (x) { L.memory.mergeByRules(x, o.level, o.period); }, 'consolidation offer').then(function () { setNotice('ok', 'One proposed ' + (o.level === 2 ? 'monthly' : 'quarterly') + ' entry was added. Approve or reject it under Memory.'); render(); }); });
        }, 'pri sm', { id: 'offer-merge-' + kind })),
        aiPanel(o.level, o.period, 'Consolidate with AI'));
    }));
  }
  function mutedNote() {
    var n = L.memory.mutedList(mainState()).length;
    if (!n) return null;
    return h('p', { class: 'small', id: 'rv-muted-note', text: n + (n === 1 ? ' kind of suggestion is' : ' kinds of suggestion are') + ' muted. ' }, btn('See muted', function () { go('memory'); }, 'sm', { id: 'rv-muted-link' }));
  }
  function mutedSection(s) {
    var list = L.memory.mutedList(s);
    var out = [h('h2', { text: 'Muted suggestions (' + list.length + ')' }),
      h('p', { class: 'mut small', text: 'A kind of rules suggestion you reject 3 times in the same area within 8 weeks is muted: rules stop proposing it. Unmute brings it back.' })];
    if (!list.length) out.push(h('p', { class: 'mut', id: 'muted-none', text: 'None muted.' }));
    list.forEach(function (m) {
      out.push(h('div', { class: 'card item', 'data-muted': m.domain + ':' + m.kind },
        h('div', null, h('span', { class: 'chip', text: domainLabel(m.domain) }), h('span', { text: ' ' + m.label + ' (muted ' + String(m.at).slice(0, 10) + ')' })),
        btn('Unmute', function () {
          act(function () { return commit(function (x) { L.memory.unmute(x, m.domain, m.kind); }, 'unmute').then(function () { setNotice('ok', 'Unmuted. Rules may propose it again.'); render(); }); });
        }, 'sm', { 'aria-label': 'Unmute ' + m.label + ' in ' + domainLabel(m.domain) })));
    });
    return out;
  }
  // The dashboard card: after 7 days without a finished review. A tap opens the review; nothing starts by itself.
  function reviewDueCard(s, t) {
    var d = L.memory.reviewDue(s, t);
    if (!d.due) return null;
    var n = L.memory.reviewStreak(s, t);
    return h('div', { class: 'warn', id: 'review-due', role: 'status' }, h('span', { text: 'Weekly review due. ' + (d.never ? 'You have not finished a weekly review yet.' : 'The last one was ' + d.days + ' days ago (' + d.last + ').') + ' Review streak: ' + n + (n === 1 ? ' week.' : ' weeks.') + ' ' }),
      btn('Start weekly review', function () { go('review'); }, 'sm pri', { id: 'review-due-start' }));
  }

  // ---------- weekly review ----------
  function reviewScreen(s) {
    var t = today(), wk = L.metrics.weekStart(t);
    var period = { from: wk, to: addDays(wk, 6) };
    var dg = L.metrics.weeklyDigest(mainState(), wk);
    var rows = L.DOMAINS.filter(function (d) { return d.id !== 'wellbeing'; }).map(function (d) {
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
      h('p', { class: 'small', id: 'rv-streak', text: 'Review streak: ' + L.memory.reviewStreak(mainState(), t) + (L.memory.reviewStreak(mainState(), t) === 1 ? ' week' : ' weeks') + ' in a row.' }),
      consolidationOffers(s, t),
      L.archiveUI ? L.archiveUI.proposal(archCtx()) : null,
      h('h2', { text: '1. This week vs last week' }),
      h('div', { class: 'card' }, h('table', null, h('thead', null, h('tr', null, ['Area', 'This week', 'Last week', 'Change'].map(function (x) { return h('th', { text: x }); }))), h('tbody', null, rows))),
      h('h2', { text: '2. Insights' }),
      h('div', { class: 'row' },
        btn(haveRules ? 'Rules suggestions added' : 'Run rules suggestions', function () {
          act(function () {
            var items = L.memory.rulesInsights(mainState(), wk);
            if (!items.length) throw new Error('No rule-based suggestions this week.');
            return runPropose(items, 1, period, 'rules').then(render);
          });
        }, 'pri sm', { id: 'rules-run', disabled: haveRules })),
      aiPanel(1, period, 'Suggest with AI'),
      mutedNote(),
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
      h('h2', { text: '7. Social' }),
      reviewSocialCard(s, wk, t),
      h('h2', { text: '8. Revenue' }),
      reviewRevenueCard(s, wk, t),
      reviewJobsCard(s, wk, t),
      reviewClientsCard(s, t),
      reviewMediaCard(s, wk, t),
      reviewWellbeingStep(t),
      h('h2', { text: (L.priv.isOpen() ? '10' : '9') + '. Your three priorities' }),
      h('form', {
        class: 'card',
        onsubmit: function (e) {
          e.preventDefault();
          act(function () {
            var ps = pri.map(function (p) { return p.value.trim(); });
            if (ps.some(function (p) { return !p; })) throw new Error('Enter all three priorities.');
            var digest = L.metrics.weeklyDigest(mainState(), wk);
            return commit(function (x) {
              x.memory.reviews = x.memory.reviews.filter(function (r) { return r.weekOf !== wk; });
              x.memory.reviews.push({ id: L.store.newId(), weekOf: wk, digest: digest, priorities: ps, completedAt: new Date().toISOString() });
              L.memory.markReviewed(x, today());
            }).then(function () { go('dashboard'); setNotice('ok', 'Review finished.'); });
          });
        }
      }, pri.map(function (p, n) { return field('Priority ' + (n + 1), p); }),
        h('button', { type: 'submit', class: 'btn pri', id: 'finish-review', text: 'Finish review' })));
  }

  // A step shown only while the private vault is open. It reads the vault for the screen and stores nothing: not in the review
  // record, the digest, an insight or the audit log.
  function reviewWellbeingStep(t) {
    if (!L.priv.isOpen()) return null;
    var W = L.wellbeing, wb = L.priv.getWellbeing();
    return h('div', { id: 'rv-wellbeing' }, h('h2', { text: '9. Wellbeing' }),
      h('div', { class: 'card' }, h('p', { class: 'mut small', text: 'Shown only while the private vault is open. Nothing here is saved with the review.' }),
        h('table', null, h('thead', null, h('tr', null, ['Area', 'Today', '7-day average', 'Check-ins'].map(function (x) { return h('th', { text: x }); }))),
          h('tbody', null, W.AREAS.map(function (a) {
            var sm = W.summary(wb, a.id, t);
            return h('tr', { 'data-area': a.id }, h('td', { text: a.label }), h('td', { text: sm.today === null ? '-' : String(sm.today) }), h('td', { text: avgText(sm.avg7.avg) }), h('td', { text: String(sm.avg7.n) }));
          }))),
        h('p', { class: 'small', text: 'Check-in streak: ' + W.streak(wb, t) + '.' }),
        btn('Open Wellbeing', function () { go('domain', { domain: 'wellbeing' }); }, 'sm', { id: 'rv-wb-open' })));
  }

  // ---------- work (v0.4.0) ----------
  var STAGE_LABEL = { lead: 'Lead', contacted: 'Contacted', applied: 'Applied', interview: 'Interview', offer: 'Offer', won: 'Won', lost: 'Lost' };
  var PKIND = [['job', 'Job'], ['venture', 'Venture'], ['client', 'Client'], ['personal', 'Personal'], ['website', 'Website'], ['podcast', 'Podcast']];
  var PLKIND = [['job', 'Job'], ['deal', 'Deal'], ['partner', 'Partner']];
  function projName(s, id) {
    var p = (s.projects || []).filter(function (x) { return x.id === id; })[0];
    return p ? p.name : '';
  }
  // Delete a project after an in-page confirm. Linked outcomes are kept and unlinked.
  function askDeleteProject(s, p) {
    var n = L.metrics.linkedOutcomeCount(s, p.id), k = L.revenue.linkedCounts(s, p.id);
    openDialog({
      title: 'Delete this project?', yes: 'Delete project', danger: true,
      body: [h('p', { class: 'mut', text: p.name }),
        h('p', { class: 'small', id: 'pj-del-info', text: n + (n === 1 ? ' linked outcome is' : ' linked outcomes are') + ' kept and unlinked from this project. The project itself is removed.' }),
        h('p', { class: 'small', id: 'pj-del-money', text: (k.entries - n) + ' linked money ' + (k.entries - n === 1 ? 'entry' : 'entries') + ', ' + k.recurring + ' recurring ' + (k.recurring === 1 ? 'item' : 'items') + ' and ' + k.children + ' ' + (k.children === 1 ? 'line' : 'lines') + ' under it are kept and unlinked. Nothing is deleted with it.' })],
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
          return commit(function (x) { L.metrics.carryOver(x, ids, wk); }, 'outcomes carried over', ids.map(function (i) { return ['entries', i]; })).then(function () { setNotice('ok', 'Carried over ' + ids.length + (ids.length === 1 ? ' outcome.' : ' outcomes.')); afterRender(); });
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
      return h('div', ROW({ class: 'item outcome', 'data-outcome': en.title, 'data-status': en.status }, 'entries', en),
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
    var pParent = sel('pj-parent', parentLineOptions(s, ''), '');
    var pForm = h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var name = pName.value.trim();
          if (!name) throw new Error('Enter a project name.');
          if (live.length >= 200 || projects.length >= 2000) throw new Error('You have reached the 200 project limit. Archive or delete some.');
          var p = { id: L.store.newId(), name: name, kind: pKind.value, status: 'active', nextAction: pNext.value.trim(), archived: false };
          if (pDate.value) p.nextDate = pDate.value;
          if (pParent.value) p.parentId = pParent.value;
          return commit(function (x) { x.projects.push(p); }, 'project add').then(function () { setNotice('ok', 'Project added.'); render(); });
        });
      }
    }, field('Project name', pName), field('Kind', pKind), field('Under (optional parent line of work)', pParent), field('Next action', pNext), field('Next action date (optional)', pDate),
      h('button', { type: 'submit', class: 'btn pri', id: 'pj-add', text: 'Add project' }));
    function setProj(p, fn, action) {
      act(function () { return commit(function (x) { x.projects.forEach(function (z) { if (z.id === p.id) fn(z); }); }, action).then(function () { render(); }); });
    }
    var shownP = live.slice().sort(function (a, b) { return (a.status === 'done') - (b.status === 'done') || a.name.localeCompare(b.name); });
    var pList = shownP.map(function (p) {
      var od = p.status === 'active' && p.nextDate && p.nextDate < t;
      return h('div', ROW({ class: 'item proj', 'data-project': p.name }, 'projects', p),
        h('div', null, h('div', { class: 'entry-t', text: p.name }),
          h('div', { class: 'mut small' }, h('span', { class: 'chip', text: p.kind }), h('span', { class: 'chip', text: p.status }),
            p.parentId && projName(s, p.parentId) ? h('span', { class: 'chip', text: 'under ' + projName(s, p.parentId) }) : null,
            od ? h('span', { class: 'chip bad', text: 'Overdue' }) : null),
          h('div', { class: 'small', text: p.nextAction ? 'Next: ' + p.nextAction + (p.nextDate ? ' (' + p.nextDate + ')' : '') : (p.nextDate ? 'Next date ' + p.nextDate : 'No next action set') }),
          workLinks(s, 'projectIds', p.id, t, p.name)),
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
          btn('Parent', function () { parentDialog(s, p); }, 'sm', { 'aria-label': 'Change the parent line of ' + p.name }),
          btn('Archive', function () { act(function () { return commit(function (x) { L.revenue.archiveProject(x, p.id); }, 'project archive').then(function () { render(); }); }); }, 'sm', { 'aria-label': 'Archive ' + p.name }),
          btn('Delete', function () { askDeleteProject(s, p); }, 'sm bad', { 'aria-label': 'Delete ' + p.name })));
    });
    var archived = projects.filter(function (p) { return p.archived; });
    var aList = archived.map(function (p) {
      return h('div', ROW({ class: 'item aproj' }, 'projects', p), h('div', null, h('div', { class: 'entry-t', text: p.name }), h('div', { class: 'mut small' }, h('span', { class: 'chip', text: p.kind }))),
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
          L.jobs.stamp(it, it.stage, t); // SEC-111: a job added here at applied or later gets its applied date
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
          return h('div', ROW({ class: 'pitem', 'data-item': it.title, 'data-stage': it.stage }, 'pipeline', it),
            h('div', { class: 'entry-t', text: it.title }),
            h('div', { class: 'mut small' }, (it.org ? it.org + ' | ' : '') + it.kind + (it.source ? ' | ' + it.source : '')),
            it.nextStep ? h('div', { class: 'small', text: 'Next: ' + it.nextStep + (it.nextDate ? ' (' + it.nextDate + ')' : '') }) : null,
            h('div', { class: 'small' }, stale ? h('span', { class: 'chip bad', text: 'Stale' }) : null, h('span', { class: 'mut', text: 'Updated ' + it.updatedAt })),
            workLinks(s, 'pipelineIds', it.id, t, it.title),
            h('div', { class: 'row' },
              nxt ? btn('To ' + STAGE_LABEL[nxt], function () { setItem(it, function (z) { z.stage = nxt; L.jobs.stamp(z, nxt, t); }, 'pipeline stage'); }, 'sm pri', { 'aria-label': 'Move ' + it.title + ' to ' + STAGE_LABEL[nxt] }) : null,
              labelled(sel(null, order.map(function (k) { return { v: k, t: STAGE_LABEL[k] }; }), it.stage, function (e) {
                var v = e.target.value; if (v !== it.stage) setItem(it, function (z) { z.stage = v; L.jobs.stamp(z, v, t); }, 'pipeline stage');
              }), 'Stage of ' + it.title),
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
    return h('div', null, btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'), h('div', { class: 'row sp' }, h('h1', { text: 'Work' }), h('span', { class: 'row' }, btn('Job search', function () { go('domain', { domain: 'work', jobs: true }); }, 'pri', { id: 'open-jobs' }), btn('Revenue', function () { go('domain', { domain: 'work', revenue: true }); }, 'pri', { id: 'open-revenue' }))), stats,
      oCard, cc, pCard, lCard, trend,
      details('work-data', 'Entries and CSV', [
        h('div', { class: 'row' },
          btn('Export pipeline CSV', function () { download('lifeos-pipeline.csv', L.csv.exportPipeline(mainState().pipeline || []), 'text/csv'); }, 'sm', { id: 'exp-pipeline' }),
          btn('Export projects CSV', function () { download('lifeos-projects.csv', L.csv.exportProjects(mainState().projects || []), 'text/csv'); }, 'sm', { id: 'exp-projects' }), lockMark(['pipeline', 'projects'])),
        domainScreen(s, { embed: true, noForm: true })]));
  }

  // ---------- job search (v1.6.0 B14) ----------
  // Applications are Work pipeline items of kind job. Everything here is a tap; nothing is automatic. Compensation is shown on this
  // screen only: it never reaches a prompt, the digest, an insight, the audit log, an error or the calendar file.
  var jobImp = null, jobImpDone = null;
  var SRC_LABEL = { referral: 'Referral', recruiter: 'Recruiter', 'job board': 'Job board', direct: 'Direct', network: 'Network', other: 'Other', unknown: 'No source' };
  var LOC_LABEL = { remote: 'Remote', hybrid: 'Hybrid', 'on site': 'On site' };
  var REASON_LABEL = { 'no response': 'No response', rejected: 'Rejected', withdrew: 'Withdrew', 'role closed': 'Role closed', other: 'Other' };
  function jobPct(v) { return v === null ? 'no data' : v + '%'; }
  function dollarsText(c) { return Math.floor(c / 100) + '.' + pad(c % 100); }
  function compText(s, it) {
    var parts = [];
    [['targetOteCents', 'Target OTE'], ['targetBaseCents', 'Target base'], ['offerOteCents', 'Offer OTE'], ['offerBaseCents', 'Offer base']].forEach(function (f) { if (typeof it[f[0]] === 'number') parts.push(f[1] + ' ' + fmtC(s, it[f[0]])); });
    return parts.join(' | ');
  }
  // The add and edit fields in one place. Returns { nodes, read() }; read() gives the input for L.jobs.addJob / updateJob.
  function jobFields(it, idp) {
    var J = L.jobs, i = it || {};
    var inp = function (id, v, max, type) { return h('input', { type: type || 'text', id: idp + id, maxlength: max ? String(max) : null, value: v || '', autocomplete: 'off' }); };
    var role = inp('role', i.role || (it && !i.org ? i.title : ''), 200), org = inp('org', i.org, 200);
    var srcOpts = [{ v: '', t: '(none)' }].concat(J.SOURCES.map(function (x) { return { v: x, t: SRC_LABEL[x] }; }));
    if (i.source && J.SOURCES.indexOf(i.source.toLowerCase()) < 0) srcOpts.push({ v: i.source, t: i.source });
    var src = sel(idp + 'source', srcOpts, i.source || ''), loc = sel(idp + 'loc', [{ v: '', t: '(none)' }].concat(J.LOCATIONS.map(function (x) { return { v: x, t: LOC_LABEL[x] }; })), i.locationType || '');
    var applied = inp('applied', i.appliedOn, 0, 'date'), follow = inp('follow', i.followUp, 0, 'date'), resume = inp('resume', i.resume, 60);
    var tOte = inp('tote', typeof i.targetOteCents === 'number' ? dollarsText(i.targetOteCents) : '', 20), tBase = inp('tbase', typeof i.targetBaseCents === 'number' ? dollarsText(i.targetBaseCents) : '', 20);
    var oOte = inp('oote', typeof i.offerOteCents === 'number' ? dollarsText(i.offerOteCents) : '', 20), oBase = inp('obase', typeof i.offerBaseCents === 'number' ? dollarsText(i.offerBaseCents) : '', 20);
    var next = inp('next', i.nextStep, 200), notes = h('textarea', { id: idp + 'notes', maxlength: '2000' });
    notes.value = i.notes || '';
    var stage = it ? null : sel(idp + 'stage', L.metrics.STAGES.map(function (k) { return { v: k, t: STAGE_LABEL[k] }; }), 'lead');
    return {
      nodes: [field('Role', role), field('Company', org), stage ? field('Stage', stage) : null, field('Location type', loc), field('Source', src), field('Applied date (optional)', applied), field('Next follow-up date (optional)', follow),
        field('Resume version (a label, up to 60 characters)', resume), field('Target OTE in dollars (optional)', tOte), field('Target base in dollars (optional)', tBase), field('Offer OTE in dollars (optional)', oOte), field('Offer base in dollars (optional)', oBase),
        field('Next step', next), field('Notes (optional)', notes)],
      read: function () {
        return { role: role.value, org: org.value, stage: stage ? stage.value : undefined, locationType: loc.value, source: src.value, appliedOn: applied.value, followUp: follow.value, resume: resume.value, targetOte: tOte.value.trim(), targetBase: tBase.value.trim(),
          offerOte: oOte.value.trim(), offerBase: oBase.value.trim(), nextStep: next.value, notes: notes.value, lostReason: it && it.lostReason ? it.lostReason : '' };
      }
    };
  }
  function jobEditDialog(s, it) {
    var f = jobFields(it, 'je-');
    openDialog({ title: 'Edit application', yes: 'Save', body: [h('div', { class: 'form' }, f.nodes), movePrivBtn('pipeline', it)],
      onYes: function () { var input = f.read(), t = today(); return commit(function (x) { L.jobs.updateJob(x, it.id, input, t); }, 'job edit').then(function () { setNotice('ok', 'Application saved.'); render(); }); } });
  }
  // People linked to the application, each with the last contact and a one-tap contact log; link and unlink never delete either side.
  function jobPeople(s, it, t) {
    var A = L.social, ppl = A.peopleForPipeline(s, it.id, t), linked = {}, kids = [];
    ppl.forEach(function (x) {
      linked[x.id] = true;
      kids.push(h('div', { class: 'row wk-person jb-person', 'data-person': x.name }, chipEl(x.name, 'wk-person-name'), h('span', { class: 'mut small', text: x.last ? 'last contact ' + x.last : 'no contact yet' }),
        btn('Log contact', function () { actDo({ run: function (y) { L.jobs.logContact(y, it.id, x.id, t); }, audit: 'job contact' }, 'Contact logged.'); }, 'sm pri jb-log', { 'aria-label': 'Log contact with ' + x.name }),
        btn('Unlink', function () { actDo({ run: function (y) { A.unlinkPipeline(y, x.id, it.id); }, audit: 'person unlink' }, 'Unlinked. Nothing was deleted.'); }, 'sm wk-unlink', { 'aria-label': 'Unlink ' + x.name + ' from ' + it.title })));
    });
    var avail = (s.people || []).filter(function (p) { return !p.archived && !linked[p.id]; });
    if (avail.length) {
      var pick = sel(null, avail.map(function (p) { return { v: p.id, t: p.name }; }), avail[0].id);
      pick.setAttribute('aria-label', 'Person to link to ' + it.title);
      kids.push(h('div', { class: 'row' }, pick, btn('Link person', function () { actDo({ run: function (y) { A.linkPipeline(y, pick.value, it.id); }, audit: 'person link' }, 'Linked.'); }, 'sm wk-link', { 'aria-label': 'Link the chosen person to ' + it.title })));
    }
    return h('div', { class: 'wk-people' }, kids);
  }
  function jobCard(s, it, t) {
    var J = L.jobs, order = L.metrics.STAGES, idx = order.indexOf(it.stage), nxt = idx < 4 ? order[idx + 1] : (idx === 4 ? 'won' : null);
    var stale = L.metrics.isStale(it, t), comp = compText(s, it);
    var setJob = function (fn, action, okMsg) { actDo({ run: function (x) { fn(x); }, audit: action }, okMsg); };
    var meta = [it.org, it.role && it.title !== it.role ? it.role : '', it.locationType ? LOC_LABEL[it.locationType] : '', it.source, it.resume ? 'resume ' + it.resume : ''].filter(Boolean).join(' | ');
    return h('div', ROW({ class: 'pitem jobitem', 'data-item': it.title, 'data-stage': it.stage, 'data-job': it.id }, 'pipeline', it),
      h('div', { class: 'entry-t', text: it.title }),
      meta ? h('div', { class: 'mut small', text: meta }) : null,
      comp ? h('div', { class: 'small jb-comp', text: comp }) : null,
      h('div', { class: 'small' }, it.appliedOn ? h('span', { class: 'mut', text: 'Applied ' + it.appliedOn + ' ' }) : null,
        it.followUp && J.isOpen(it) ? chipEl('Follow up ' + it.followUp, 'jb-follow' + (it.followUp < t ? ' bad' : '')) : null, stale ? chipEl('Stale', 'bad') : null,
        it.stage === 'lost' && it.lostReason ? chipEl(REASON_LABEL[it.lostReason], 'jb-reason') : null),
      it.nextStep ? h('div', { class: 'small', text: 'Next: ' + it.nextStep }) : null,
      jobPeople(s, it, t),
      h('div', { class: 'row' },
        nxt ? btn('To ' + STAGE_LABEL[nxt], function () { setJob(function (x) { J.setStage(x, it.id, nxt, t); }, 'job stage'); }, 'sm pri jb-next', { 'aria-label': 'Move ' + it.title + ' to ' + STAGE_LABEL[nxt] }) : null,
        labelled(sel(null, order.map(function (k) { return { v: k, t: STAGE_LABEL[k] }; }), it.stage, function (e) {
          var v = e.target.value; if (v !== it.stage) setJob(function (x) { J.setStage(x, it.id, v, t); }, 'job stage');
        }), 'Stage of ' + it.title),
        it.stage === 'lost' ? labelled(sel(null, [{ v: '', t: '(no reason)' }].concat(J.REASONS.map(function (r) { return { v: r, t: REASON_LABEL[r] }; })), it.lostReason || '', function (e) {
          var v = e.target.value; setJob(function (x) { var z = x.pipeline.filter(function (p) { return p.id === it.id; })[0]; if (v) z.lostReason = v; else delete z.lostReason; z.updatedAt = t; }, 'job reason');
        }), 'Outcome reason of ' + it.title) : null,
        it.followUp && J.isOpen(it) ? btn('Followed up', function () { setJob(function (x) { J.markFollowedUp(x, it.id, t); }, 'job followed up', 'Follow-up recorded.'); }, 'sm jb-done', { 'aria-label': 'Mark the follow-up for ' + it.title + ' done' }) : null,
        btn('Edit', function () { jobEditDialog(s, it); }, 'sm jb-edit', { 'aria-label': 'Edit ' + it.title }),
        btn('Delete', function () {
          openDialog({ title: 'Delete this application?', yes: 'Delete', danger: true, body: h('p', { class: 'mut', text: it.title }),
            onYes: function () { return commit(function (x) { x.pipeline = x.pipeline.filter(function (z) { return z.id !== it.id; }); }, 'job delete').then(function () { render(); }); } });
        }, 'sm bad', { 'aria-label': 'Delete ' + it.title })));
  }
  function jobsScreen(s) {
    var J = L.jobs, t = today(), wk = L.metrics.weekStart(t), jobs = J.jobsOf(s), f = J.funnel(s), w = J.weekly(s, wk), due = J.followUps(s, t).filter(function (x) { return x.due; });
    var stats = h('div', { class: 'stats' }, stat('Open applications', String(f.open), 'js-open'), stat('Applied this week', String(w.applications), 'js-week-apps'), stat('Follow-ups due today', String(due.length), 'js-due', due.length ? 'bad-t' : ''));
    var funnelCard = h('div', { class: 'card', id: 'js-funnel' }, h('h2', { text: 'Funnel' }),
      h('div', { class: 'stagecounts' }, L.metrics.STAGES.map(function (k) { return h('span', { class: 'chip', 'data-count': k, text: STAGE_LABEL[k] + ' ' + f.counts[k] }); })),
      h('div', { class: 'stats' }, stat('Applied', String(f.applied), 'fn-applied'), stat('Response rate', jobPct(f.responseRate), 'fn-response'), stat('Interview rate', jobPct(f.interviewRate), 'fn-interview'), stat('Offer rate', jobPct(f.offerRate), 'fn-offer')),
      h('p', { class: 'mut small', text: 'Applied means an applied date or the stage applied or later. Response: applied items now at contacted or later, or lost as rejected. Interview and offer rates count items now at that stage or later.' }),
      f.byMonth.length ? h('table', { id: 'js-months' }, h('thead', null, h('tr', null, ['Month', 'Items', 'Applied', 'Response', 'Interview', 'Offer'].map(function (x) { return h('th', { text: x }); }))),
        h('tbody', null, f.byMonth.slice(0, 12).map(function (m) {
          return h('tr', { 'data-month': m.month }, h('td', { text: m.month }), h('td', { text: String(m.items) }), h('td', { text: String(m.applied) }), h('td', { text: jobPct(m.responseRate) }), h('td', { text: jobPct(m.interviewRate) }), h('td', { text: jobPct(m.offerRate) }));
        }))) : null,
      f.sources.length ? h('p', { class: 'small', id: 'js-sources', text: 'By source: ' + f.sources.map(function (x) { return SRC_LABEL[x.source] + ' ' + x.count; }).join(', ') + '.' }) : null);
    var weekCard = h('div', { class: 'card', id: 'js-weekly' }, h('h2', { text: 'This week' }), h('p', { class: 'mut small', text: 'Week of ' + w.week + ' to ' + w.end }),
      h('div', { class: 'stats' }, stat('Applications submitted', String(w.applications), 'jw-apps'), stat('Follow-ups done', String(w.followUpsDone), 'jw-followups'), stat('Outreach (contacts logged)', String(w.outreach), 'jw-outreach'),
        stat('People contacted', String(w.peopleContacted), 'jw-people'), stat('Follow-ups due by the end of the week', String(w.followUpsDue), 'jw-due'), stat('Interviews', String(w.interviews), 'jw-interviews'), stat('Offers', String(w.offers), 'jw-offers')),
      h('p', { class: 'small', id: 'jw-sources', text: w.sources.length ? 'Source of this week\'s applications: ' + w.sources.map(function (x) { return SRC_LABEL[x.source] + ' ' + x.count; }).join(', ') + '.' : 'No applications this week.' }));
    var counts = f.counts, order = L.metrics.STAGES;
    var board = h('div', { class: 'board', id: 'js-board' }, order.filter(function (k) { return counts[k] > 0; }).map(function (k) {
      return h('div', { class: 'stage', 'data-stage': k }, h('h3', { text: STAGE_LABEL[k] + ' (' + counts[k] + ')' }),
        jobs.filter(function (x) { return x.stage === k; }).sort(function (a, b) { return (a.followUp || '9').localeCompare(b.followUp || '9') || a.updatedAt.localeCompare(b.updatedAt) || a.title.localeCompare(b.title); }).map(function (it) { return jobCard(s, it, t); }));
    }));
    var f2 = jobFields(null, 'ja-');
    var form = h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var input = f2.read();
          return commit(function (x) { L.jobs.addJob(x, input, t); }, 'job add').then(function () { setNotice('ok', 'Application added.'); render(); });
        });
      }
    }, f2.nodes, h('button', { type: 'submit', class: 'btn pri', id: 'ja-add', text: 'Add application' }));
    return h('div', null, btn('Back to Work', function () { go('domain', { domain: 'work' }); }, 'sm back'), h('div', { class: 'row sp' }, h('h1', { text: 'Job search' }), btn('Open Revenue', function () { go('domain', { domain: 'work', revenue: true }); }, 'sm', { id: 'js-open-revenue' })),
      h('p', { class: 'mut small', text: 'Your applications are the job items in your Work pipeline. Numbers only; nothing here is sent anywhere.' }),
      stats, weekCard, funnelCard,
      h('div', { class: 'card', id: 'js-apps' }, h('h2', null, 'Applications (' + jobs.length + ') ', lockMark(['pipeline', 'people', 'contacts'])), jobs.length ? board : h('p', { class: 'mut', id: 'js-none', text: 'No applications yet. Add one below or import a tracker CSV.' })),
      details('js-new', 'Add an application', form, !jobs.length),
      jobImportCard(s));
  }
  var JOB_FIELDS = [['role', 'Role column', /role|position|job title|title/i], ['company', 'Company column', /company|employer|org/i], ['stage', 'Stage column', /stage|status/i], ['location', 'Location type column', /location|remote|work type/i],
    ['source', 'Source column', /source|found/i], ['appliedOn', 'Applied date column', /appl.*(date|on)|date.*appl|^applied$/i], ['followUp', 'Follow-up date column', /follow/i], ['resume', 'Resume version column', /resume|cv/i],
    ['lostReason', 'Outcome reason column', /reason|outcome/i], ['notes', 'Notes column', /note|comment/i], ['nextStep', 'Next step column', /next/i], ['targetOte', 'Target OTE column', /target.*ote/i],
    ['targetBase', 'Target base column', /target.*base/i], ['offerOte', 'Offer OTE column', /offer.*ote/i], ['offerBase', 'Offer base column', /offer.*base/i]];
  function jobImpStart(parsed) {
    var hd = parsed.headers, cfg = { fmt: 'auto', dflt: 'applied', asPrivate: false }, used = {};
    JOB_FIELDS.forEach(function (f) { var i = hd.findIndex(function (x, k) { return !used[k] && f[2].test(x); }); cfg[f[0]] = i >= 0 ? String(i) : ''; if (i >= 0) used[i] = true; });
    jobImp = { parsed: parsed, plan: null, cfg: cfg, values: { stage: {}, location: {}, source: {}, lostReason: {} } };
  }
  function jobImpOpts() {
    var c = jobImp.cfg, map = {};
    JOB_FIELDS.forEach(function (f) { map[f[0]] = c[f[0]] === '' || c[f[0]] === undefined ? undefined : Number(c[f[0]]); });
    return { map: map, dateFormat: c.fmt, defaultStage: c.dflt, values: jobImp.values, asPrivate: !!c.asPrivate && L.priv.isOpen() };
  }
  function jobImpRun() { return act(function () { return L.jobs.planImport(jobImp.parsed, jobImpOpts(), st(), today()).then(function (pl) { jobImp.plan = pl; render(); }); }); }
  function jobImportCard(s) {
    var J = L.jobs;
    var card = h('div', { class: 'card', id: 'jobimp-card' }, h('h2', { text: 'Import a tracker CSV' }),
      h('p', { class: 'mut small', text: 'Map the columns, preview, then confirm. Nothing is saved until you confirm, importing the same file again adds nothing, and values LifeOS does not know are listed for you to map, never created.' }));
    if (jobImpDone) card.appendChild(h('p', { class: 'small', id: 'jobimp-done', text: jobImpDone }));
    var pm = L.priv.isOpen() ? [] : L.priv.marks(mainState());
    if (pm.indexOf('pipeline') >= 0) {
      card.appendChild(h('p', { class: 'small', id: 'jobimp-locked' }, lockIcon('Some private items are hidden', 'lockmark'), ' Open the private vault to import applications. Rows already imported may be private, and they can only be recognised while it is open.'));
      return card;
    }
    var fileIn = h('input', { type: 'file', id: 'jobimp-file', accept: '.csv,text/csv' });
    fileIn.addEventListener('change', function () {
      var f = fileIn.files && fileIn.files[0];
      if (!f) return;
      act(function () { return readFile(f).then(function (text) { if (!L.store.isUnlocked()) return; jobImpStart(L.csv.parse(text)); jobImpDone = null; render(); }); });
    });
    card.appendChild(field('CSV file (5 MB max)', fileIn));
    if (!jobImp) return card;
    var c = jobImp.cfg, hd = jobImp.parsed.headers;
    var opts = [{ v: '', t: '(none)' }].concat(hd.map(function (x, i) { return { v: String(i), t: x || ('Column ' + (i + 1)) }; }));
    card.appendChild(h('p', { class: 'mut small', id: 'jobimp-size', text: hd.length + ' columns, ' + jobImp.parsed.rows.length + ' rows. A company or a role column is required.' }));
    JOB_FIELDS.forEach(function (f) { card.appendChild(field(f[1] + ' (optional)', sel('jobimp-' + f[0], opts, c[f[0]], function (e) { c[f[0]] = e.target.value; jobImp.plan = null; render(); }))); });
    card.appendChild(field('Date format', sel('jobimp-datefmt', [{ v: 'auto', t: 'YYYY-MM-DD or MM/DD/YYYY' }, { v: 'dmy', t: 'DD/MM/YYYY (or YYYY-MM-DD)' }], c.fmt, function (e) { c.fmt = e.target.value; jobImp.plan = null; })));
    if (c.stage === '') card.appendChild(field('Stage for every row (no stage column)', sel('jobimp-default', L.metrics.STAGES.map(function (k) { return { v: k, t: STAGE_LABEL[k] }; }), c.dflt, function (e) { c.dflt = e.target.value; jobImp.plan = null; })));
    if (L.priv.isOpen()) card.appendChild(h('label', { class: 'field check' }, h('input', { type: 'checkbox', id: 'jobimp-private', checked: !!c.asPrivate, onchange: function (e) { c.asPrivate = !!e.target.checked; jobImp.plan = null; render(); } }), h('span', { text: 'Import as private' })));
    card.appendChild(h('div', { class: 'row' }, btn('Preview', function () { jobImpRun(); }, 'pri', { id: 'jobimp-preview' }), btn('Cancel', function () { jobImp = null; render(); }, null, { id: 'jobimp-cancel' })));
    var pl = jobImp.plan;
    if (!pl) return card;
    var body = h('div', { id: 'jobimp-result' }, h('p', { id: 'jobimp-summary', text: pl.add.length + ' to add, ' + pl.rejected.length + ' rejected, ' + pl.duplicates + ' already imported.' }),
      h('p', { class: 'small', id: 'jobimp-stages', text: 'By stage: ' + (J.STAGES.filter(function (k) { return pl.byStage[k]; }).map(function (k) { return STAGE_LABEL[k] + ' ' + pl.byStage[k]; }).join(', ') || 'none') + '.' }));
    var targets = { stage: J.STAGES.map(function (k) { return { v: k, t: STAGE_LABEL[k] }; }), location: J.LOCATIONS.map(function (x) { return { v: x, t: LOC_LABEL[x] }; }), source: J.SOURCES.map(function (x) { return { v: x, t: SRC_LABEL[x] }; }), lostReason: J.REASONS.map(function (x) { return { v: x, t: REASON_LABEL[x] }; }) };
    var what = { stage: 'Stage', location: 'Location type', source: 'Source', lostReason: 'Outcome reason' };
    ['stage', 'location', 'source', 'lostReason'].forEach(function (k) {
      if (!pl.unknown[k].length) return;
      body.appendChild(h('p', { class: 'small', id: 'jobimp-unknown-' + k, text: what[k] + ' values LifeOS does not know. ' + (k === 'stage' ? 'Rows with an unmapped stage are rejected.' : 'The field stays empty unless you map the value.') }));
      pl.unknown[k].forEach(function (v, i) {
        var key = String(v).replace(/\s+/g, ' ').trim().toLowerCase().replace(/[_-]/g, ' ');
        var pick = sel('jobimp-map-' + k + '-' + i, [{ v: '', t: '(leave unmapped)' }].concat(targets[k]), jobImp.values[k][key] || '', function (e) { if (e.target.value) jobImp.values[k][key] = e.target.value; else delete jobImp.values[k][key]; jobImpRun(); });
        pick.setAttribute('aria-label', what[k] + ' for "' + v + '"');
        body.appendChild(h('div', { class: 'row' }, h('span', { class: 'small', text: '"' + v + '" is' }), pick));
      });
    });
    if (pl.rejected.length) body.appendChild(h('div', { id: 'jobimp-rejected' }, h('p', { class: 'small', text: 'Rejected rows' }),
      h('ul', null, pl.rejected.slice(0, 25).map(function (r) { return h('li', { class: 'small', text: 'Row ' + r.row + ': ' + r.reason }); })), pl.rejected.length > 25 ? h('p', { class: 'mut small', text: 'And ' + (pl.rejected.length - 25) + ' more.' }) : null));
    if (!pl.add.length && pl.duplicates) body.appendChild(h('p', { class: 'small', id: 'jobimp-nothing', text: 'Nothing new to import: every valid row was already imported.' }));
    body.appendChild(btn(pl.add.length ? 'Import ' + pl.add.length + (pl.add.length === 1 ? ' row' : ' rows') : 'Nothing to import', function () {
      act(function () {
        var res, fn = function (x) { res = J.applyImport(x, pl); addAudit(x, 'job import'); };
        var done = pl.asPrivate ? L.priv.write(fn, { newPrivate: true }) : commit(fn);
        return done.then(function () { jobImp = null; jobImpDone = 'Imported ' + res.added + (res.added === 1 ? ' application.' : ' applications.'); setNotice('ok', 'Imported ' + res.added + (res.added === 1 ? ' application.' : ' applications.')); render(); });
      });
    }, 'pri', { id: 'jobimp-confirm', disabled: !pl.add.length }));
    card.appendChild(body);
    return card;
  }
  // Weekly review: follow-ups due this week or overdue, and the week's job numbers. One tap records a follow-up; nothing changes otherwise.
  function reviewJobsCard(s, wk, t) {
    var J = L.jobs;
    if (!J.hasData(s)) return null;
    var r = J.reviewWeek(s, wk, t), w = r.weekly;
    return h('div', { id: 'rv-jobs' }, h('h2', { text: 'Job search follow-ups' }),
      h('div', { class: 'card' },
        h('p', { class: 'small', id: 'rv-job-stats', text: 'This week: ' + w.applications + (w.applications === 1 ? ' application' : ' applications') + ', ' + w.followUpsDone + (w.followUpsDone === 1 ? ' follow-up' : ' follow-ups') + ' done, ' + w.outreach + (w.outreach === 1 ? ' contact' : ' contacts') + ' logged.' }),
        h('p', { class: 'small', id: 'rv-job-due-h', text: 'Follow-ups due by the end of this week (' + r.due.length + ')' }),
        r.due.length ? h('p', { class: 'mut small', text: 'Nothing changes until you tap it.' }) : null,
        r.due.map(function (x) {
          return h('div', { class: 'item rv-job-row', 'data-title': x.title }, h('div', null, h('span', { class: 'entry-t', text: x.title }), h('span', { class: 'mut small', text: ' ' + x.date + (x.overdue ? ' (overdue)' : '') })),
            btn('Followed up', function () { actDo({ run: function (y) { J.markFollowedUp(y, x.id, t); }, audit: 'job followed up' }, 'Follow-up recorded.'); }, 'sm rv-job-done', { 'aria-label': 'Mark the follow-up for ' + x.title + ' done' }));
        }),
        btn('Open Job search', function () { go('domain', { domain: 'work', jobs: true }); }, 'sm', { id: 'rv-job-open' })));
  }

  // ---------- search across all areas (v1.6.0 B18) ----------
  // The query text lives in this variable and in the input only. It is cleared on lock and when the private vault closes. Typing never
  // touches the history or the address; only tapping a result goes to a view.
  var searchQ = '';
  function focusRecord(label) {
    var main = document.querySelector('main.main');
    if (!main || !label) return;
    var els = main.querySelectorAll('.item, .pitem, .entry, .card, tr, li'), hit = null;
    for (var i = 0; i < els.length && !hit; i++) if (els[i].textContent.indexOf(label) >= 0 && !els[i].querySelector('.item, .pitem, tr, li')) hit = els[i];
    if (!hit) return;
    for (var p = hit.parentElement; p && p !== main; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true;
    Array.prototype.forEach.call(main.querySelectorAll('.search-hit'), function (n) { n.classList.remove('search-hit'); });
    hit.classList.add('search-hit'); hit.setAttribute('tabindex', '-1');
    if (hit.scrollIntoView) hit.scrollIntoView({ block: 'center' });
  }
  function searchBox(idp, onPick) {
    var out = h('div', { class: 'searchres', id: idp + '-results', role: 'region', 'aria-label': 'Search results', 'aria-live': 'polite' });
    var inp = h('input', { type: 'search', id: idp + '-q', class: 'searchq', maxlength: '100', placeholder: 'Search everything', 'aria-label': 'Search everything', value: searchQ });
    function run() {
      searchQ = inp.value;
      out.replaceChildren();
      if (!searchQ.trim()) return;
      var r = L.search.query(searchQ);
      if (!r.total) { out.appendChild(h('p', { class: 'mut small', id: idp + '-none', text: 'Nothing found.' })); return; }
      out.appendChild(h('p', { class: 'mut small', id: idp + '-count', text: r.total + (r.total === 1 ? ' match' : ' matches') + (r.truncated ? ', the first of each area shown' : '') }));
      r.groups.forEach(function (g) {
        out.appendChild(h('h3', { class: 'search-area', 'data-area': g.area, text: g.label + ' (' + g.count + ')' }));
        g.items.forEach(function (x) {
          out.appendChild(h('button', { type: 'button', class: 'btn sm searchhit', 'data-area': g.area, 'data-label': x.label, 'aria-label': g.label + ': ' + x.label, onclick: function () { if (onPick) onPick(); searchQ = ''; goKey(g.key); focusRecord(x.label); } },
            x.priv ? lockIcon('Private item', 'lockmark privbadge') : null, h('span', { text: ' ' + x.label + (x.match ? ' - ' + x.match : '') })));
        });
      });
    }
    inp.addEventListener('input', run);
    if (searchQ) run();
    return h('div', { class: 'searchbox' }, inp, out);
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
      return h('div', ROW({ class: 'item habit', 'data-habit-row': hb.name }, 'habits', hb),
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
        cy ? btn('Clear cycle', function () { act(function () { return commit(function (x) { x.cycle = null; }, 'cycle clear').then(done('Training cycle cleared.')); }); }, '', { id: 'cy-clear' }) : null, cy ? movePrivBtn('cycle', cy) : null, cy && isPrivRec('cycle', cy) ? lockBadge() : null));

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
      body: [field('Title', title), field('Target', target), field('Due date', due), field('Parent goal (a longer horizon)', parent), field('Notes (optional)', notes), movePrivBtn('goals', g)],
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
    return h('div', ROW({ class: 'goal' + (opts.depth ? ' goal-child' : ''), 'data-goal': g.title, 'data-state': g.state }, 'goals', g, active), kids);
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
    var metric = sel('g-metric', L.goals.METRICS.filter(function (m) { return !L.goals.isWellbeingMetric(m.id) || L.priv.isOpen(); }).map(function (m) { return { v: m.id, t: m.label + (L.goals.isWellbeingMetric(m.id) ? ' (private goals only)' : '') }; }), 'manual');
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
    var gLine = sel('g-line', lineOptions(s, '(all money)'), '');
    var gRoll = h('input', { type: 'checkbox', id: 'g-rollup' });
    var scopeBox = h('div', { id: 'g-scope-box', class: 'hidden' }, field('Line of work (optional)', gLine), h('label', { class: 'field check' }, gRoll, h('span', { text: 'Include lines under it (rollup)' })));
    function sync() {
      var man = metric.value === 'manual';
      manualBox.setAttribute('class', man ? '' : 'hidden');
      scopeBox.setAttribute('class', metric.value === 'revenueMonth' || metric.value === 'netMonth' ? '' : 'hidden');
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
          if ((metric.value === 'revenueMonth' || metric.value === 'netMonth') && gLine.value) { p.projectId = gLine.value; p.rollup = !!gRoll.checked; }
          if (L.goals.isWellbeingMetric(metric.value) && !newPriv()) throw new Error('A wellbeing goal metric can only be used by a private goal. Tick "New items are private" first.');
          return commit(function (x) { L.goals.addGoal(x, p, t); }, 'goal add').then(function () { setNotice('ok', 'Goal added.'); render(); });
        });
      }
    }, field('Title', title), field('Horizon', horizon), field('What it measures', metric), field('Direction', dir),
      field('Start value', start, 'Leave blank to start from the current value of a linked metric.'), field('Target', target),
      field('Start date', sdate), field('Due date (blank: end of the period)', due), field('Parent goal (a longer horizon, optional)', parent),
      manualBox, scopeBox, field('Notes (optional)', notes),
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
      return h('div', ROW({ class: 'item g-legacy' }, 'entries', e), h('div', null, h('span', { class: 'entry-t', text: e.title }),
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
    return h('div', ROW({ class: 'item mt-row' + (cls ? ' ' + cls : ''), 'data-title': m.title }, 'maintenance', m),
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
                return commit(function (x) { if (isHome) L.home.confirmNext(x, p.fromId, due.value); else L.admin.confirmRenewal(x, p.fromId, due.value); }, isHome ? 'maintenance next confirmed' : 'renewal next confirmed', [[isHome ? 'maintenance' : 'renewals', p.fromId]])
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
        return h('div', ROW({ class: 'item pr-row' }, 'properties', p), h('div', null, h('span', { class: 'entry-t', text: p.name }), h('span', { class: 'mut small', text: ' ' + PROP_LABEL[p.kind] + (p.archived ? ', archived' : '') })),
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
        return h('div', ROW({ class: 'item vh-row', 'data-name': v.name }, 'vehicles', v),
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
    var pick = others.length ? labelled(sel('hb-pick', others.map(function (r) { return { v: r.id, t: r.title }; }), others[0].id), 'Recurring item to flag as a household bill') : null;
    var billsCard = h('div', { class: 'card', id: 'hm-bills' }, h('h2', { text: 'Household bills' }),
      h('p', { class: 'mut small', text: 'These are your Money recurring items flagged as household. There is no second list. Weekly counts 52 a year, yearly counts once.' }),
      sum.bills.items.length ? sum.bills.items.map(function (b) {
        return h('div', ROW({ class: 'item hb-row', 'data-title': b.title }, 'recurring', b), h('div', null, h('span', { class: 'entry-t', text: b.title }), h('span', { class: 'mut small', text: ' ' + moneyFmt(b.cents, cur) + ' ' + b.cadence + ', ' + moneyFmt(b.monthlyCents, cur) + ' per month' })),
          btn('Remove flag', function () { act(function () { return commit(function (x) { H.setHousehold(x, b.id, false); }, 'household flag off').then(render); }); }, 'sm', { 'aria-label': 'Remove ' + b.title + ' from household bills' }));
      }) : h('p', { class: 'mut', text: 'No household bills flagged yet.' }),
      pick ? h('div', { class: 'row' }, pick, btn('Flag as household', function () { act(function () { return commit(function (x) { H.setHousehold(x, pick.value, true); }, 'household flag on').then(render); }); }, 'sm pri', { id: 'hb-add' })) : h('p', { class: 'mut small', text: 'Add recurring expenses under Money to flag them here.' }));

    var done = (s.maintenance || []).filter(function (m) { return m.state === 'done'; }).sort(function (a, b) { return (b.lastDone || '').localeCompare(a.lastDone || ''); }).slice(0, 50);
    var hist = details('hm-history', 'Recent history (' + done.length + ')', done.length ? done.map(function (m) {
      return h('div', ROW({ class: 'item hist-row' }, 'maintenance', m), h('div', null, h('span', { class: 'entry-t', text: m.title }), h('div', { class: 'mut small', text: 'done ' + m.lastDone + (typeof m.cost === 'number' ? ' | ' + moneyFmt(m.cost, cur) : '') + (m.vendor ? ' | ' + m.vendor : '') })));
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
    return h('div', ROW({ class: 'item rn-row', 'data-title': r.title }, 'renewals', r),
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
        return h('div', ROW({ class: 'item sub-row', 'data-title': x.title }, 'recurring', x),
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
        return h('div', ROW({ class: 'item doc-row', 'data-title': d.title }, 'documents', d),
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
            return h('div', ROW({ class: 'item tx-row', 'data-title': it.title }, 'taxItems', it),
              h('div', null, h('span', { class: 'entry-t' + (it.state === 'filed' ? ' done-t' : ''), text: it.title }), h('div', { class: 'mut small', text: it.state + (it.dueDate ? ' | due ' + it.dueDate : '') })),
              h('div', { class: 'row' },
                labelled(sel('tx-state-' + it.id, A.TAX_STATES.map(function (v) { return { v: v, t: v }; }), it.state, function (e) { var v = e.target.value; act(function () { return commit(function (x) { A.setTaxState(x, it.id, v); }, 'tax item state').then(function () { view.open = 'ad-tax'; render(); }); }); }), 'State of ' + it.title),
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
      return h('div', ROW({ class: 'item g-legacy' }, 'entries', e), h('div', null, h('span', { class: 'entry-t', text: e.title }), h('span', { class: 'mut small', text: ' due ' + e.due + ', ' + (e.status || 'open') + ', entered ' + e.date }), e.notes ? h('p', { class: 'small mut', text: e.notes }) : null),
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
      title: 'Log study time', yes: 'Save', adds: true,
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
      body: [field('Title', title), field('Target date', tdate), field('Exam date', exam), expires ? field('Certification expires', expires) : null, field('Linked goal', goal), movePrivBtn('learningItems', it)],
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
    return h('div', ROW({ class: 'goal ln-item', 'data-title': it.title, 'data-state': it.state }, 'learningItems', it, true), kids);
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
        return h('div', ROW({ class: 'item ln-tk', 'data-title': r.takeaway.text.slice(0, 40) }, 'takeaways', r.takeaway),
          h('div', null, h('div', { class: 'entry-t', text: r.takeaway.text }), h('div', { class: 'mut small', text: r.takeaway.date + (r.itemTitle ? ' | ' + r.itemTitle : '') })),
          btn('Delete', function () { act(function () { return commit(function (x) { Ln.deleteTakeaway(x, r.takeaway.id); }, 'takeaway delete').then(function () { view.open = 'ln-tk'; render(); }); }); }, 'sm bad', { 'aria-label': 'Delete takeaway' }));
      }) : [h('p', { class: 'mut', id: 'ln-no-results', text: qs ? 'No takeaways match.' : 'No takeaways yet.' })]);
    }
    q.addEventListener('input', function () { showResults(); decorateRows(); });
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
      return h('div', ROW({ class: 'item ln-sess', 'data-title': x.date }, 'studySessions', x),
        h('div', null, h('span', { class: 'entry-t', text: x.minutes + ' min' }), h('span', { class: 'mut small', text: ' ' + x.date + (x.itemId && titles.has(x.itemId) ? ' | ' + titles.get(x.itemId) : '') }), x.notes ? h('p', { class: 'small mut', text: x.notes }) : null),
        btn('Delete', function () { act(function () { return commit(function (z) { Ln.deleteSession(z, x.id); }, 'study session delete').then(function () { view.open = 'ln-sessions-card'; render(); }); }); }, 'sm bad', { 'aria-label': 'Delete session of ' + x.minutes + ' minutes on ' + x.date }));
    }) : h('p', { class: 'mut', text: 'No sessions yet.' }), view.open === 'ln-sessions-card');

    // Older learning entries the upgrade could not turn into items or sessions: kept as entered, each deletable after a confirm.
    var legacy = Ln.legacyEntries(s), legacyShown = legacy.slice(0, 200);
    var legacyCard = legacy.length ? details('ln-legacy', 'Older learning entries (' + legacy.length + (legacy.length > legacyShown.length ? ', newest ' + legacyShown.length + ' shown' : '') + ')', [h('p', { class: 'mut small', text: 'Kept exactly as entered.' }), legacyShown.map(function (e) {
      return h('div', ROW({ class: 'item g-legacy' }, 'entries', e), h('div', null, h('span', { class: 'entry-t', text: e.title }), h('span', { class: 'mut small', text: ' ' + e.date + ', ' + (e.type === 'hours' ? e.value + ' hours' : (e.status || '')) }), e.notes ? h('p', { class: 'small mut', text: e.notes }) : null),
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
  function actDo(fn, ok) { act(function () { return commit(fn.run, fn.audit, fn.from).then(function () { if (ok) setNotice('ok', typeof ok === 'function' ? ok() : ok); render(); }); }); }
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
      field('With (optional, names separated by commas, up to ' + A.PEOPLE_MAX + ')', f.people), peopleSuggest(s, f.people, p),
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
  // Existing people offered as suggestions for the people field: a tap adds the name, nothing is added by itself.
  function peopleSuggest(s, input, p) {
    var box = h('div', { class: 'chips people-suggest', id: p + 'people-suggest', role: 'group', 'aria-label': 'People you can add' });
    function refresh() {
      var parts = input.value.split(','), tok = parts[parts.length - 1].trim();
      var names = L.social.suggestNames(st(), tok).filter(function (n) { return parts.slice(0, -1).map(function (x) { return L.social.nameKey(x); }).indexOf(L.social.nameKey(n)) < 0; }).slice(0, 8);
      box.replaceChildren();
      names.forEach(function (n) {
        box.appendChild(h('button', { type: 'button', class: 'chipbtn people-pick', text: n, 'aria-label': 'Add ' + n, onclick: function () { parts.pop(); var head = parts.map(function (x) { return x.trim(); }).filter(Boolean); head.push(n); input.value = head.join(', '); input.focus(); refresh(); } }));
      });
    }
    input.addEventListener('input', refresh);
    refresh();
    return box;
  }
  function editActivityDialog(s, a, t) {
    var form = activityForm(s, a, t, 'ae-');
    openDialog({
      title: 'Edit activity', yes: 'Save', body: [form.nodes, movePrivBtn('activities', a)],
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
    // An unknown name in a Social-tagged activity can be added as a person on a tap; it is never added by itself.
    if (a.alsoSocial) L.social.unknownNames(s, a.withPeople).forEach(function (n) {
      acts.push(btn('Add ' + n + ' as a person', function () { actDo({ run: function (x) { L.social.addPerson(x, { name: n }); }, audit: 'person add', from: [['activities', a.id]] }, 'Person added.'); }, 'sm act-addperson', { 'aria-label': 'Add ' + n + ' as a person' }));
    });
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
    return h('div', ROW({ class: 'goal act-item', 'data-title': a.title, 'data-state': a.state }, 'activities', a, true), kids);
  }
  // A past-date planned activity: done, skipped or a new date, each on a tap.
  function pastRow(s, a, cls) {
    var A = L.activities, nd = h('input', { type: 'date', class: cls + '-date', 'aria-label': 'New date for ' + a.title, value: a.date });
    return h('div', ROW({ class: 'item ' + cls, 'data-title': a.title }, 'activities', a),
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
    var g = L.activities.glance(s, t), now = g.today.concat(g.week), srcs = {};
    now.concat(g.later).forEach(function (x) { srcs[x.source] = true; });
    var many = Object.keys(srcs).length > 1;
    var kids = [h('h2', null, 'At a glance ', lockMark(['activities', 'people', 'entries', 'pipeline', 'clients', 'invoices', 'renewals', 'contacts'])),
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
      return h('div', ROW({ class: 'item g-legacy' }, 'entries', e), h('div', null, h('span', { class: 'entry-t', text: e.title }), h('span', { class: 'mut small', text: ' ' + e.date }), e.notes ? h('p', { class: 'small mut', text: e.notes }) : null),
        btn('Delete', function () {
          openDialog({ title: 'Delete this older entry?', yes: 'Delete', danger: true, body: [h('p', { class: 'mut', text: e.title }), h('p', { class: 'small', text: 'Its title, date and notes are removed from the vault.' })],
            onYes: function () { return commit(function (x) { x.entries = x.entries.filter(function (z) { return z.id !== e.id; }); }, 'older activity entry delete').then(function () { view.open = 'act-legacy'; render(); }); } });
        }, 'sm bad leg-del', { 'aria-label': 'Delete ' + e.title }));
    })], view.open === 'act-legacy') : null;

    return h('div', null, btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'), h('h1', { text: 'Activities' }),
      h('p', { class: 'mut small', text: 'Outings, events, travel, hobbies, volunteering and classes. Nothing is marked done, skipped, rated or added to Money unless you tap it.' }),
      stats, offerCard, dupes, lateCard, upCard, laterCard, addCard, recentCard, roiCard, catCard, actImportCard(s), legacyCard);
  }
  // ---- Activity CSV import (v1.2.0): the ledger import's pattern: map, preview, confirm; imports never create Money expenses ----
  var ACT_FIELDS = [['title', 'Title column', true, /title|name|activity|what/i], ['date', 'Date column', true, /^date$|start/i], ['endDate', 'End date column', false, /end/i], ['state', 'State column (planned, done or skipped)', false, /state|status/i],
    ['category', 'Category column', false, /categor/i], ['minutes', 'Minutes column', false, /minute|duration/i], ['place', 'Place column', false, /place|where|location/i], ['people', 'People column', false, /people|with|who/i],
    ['cost', 'Cost column', false, /^cost|price|spend/i], ['paidOn', 'Paid date column', false, /paid/i], ['returnAmount', 'Return column', false, /return|income/i], ['worthIt', 'Worth-it rating column (1 to 5)', false, /worth|rating/i],
    ['alsoHealth', 'Also Health column (yes or no)', false, /also.?health/i], ['healthKind', 'Health type column', false, /health.?(kind|type)|kind|type/i], ['alsoSocial', 'Also Social column (yes or no)', false, /also.?social/i], ['notes', 'Notes column', false, /note/i]];
  function actImpStart(parsed) {
    var hd = parsed.headers, cfg = { fmt: 'auto', sep: ';', dflt: 'planned', asPrivate: false };
    ACT_FIELDS.forEach(function (f) { var i = hd.findIndex(function (x) { return f[3].test(x); }); cfg[f[0]] = i >= 0 ? String(i) : ''; });
    if (cfg.healthKind && cfg.healthKind === cfg.state) cfg.healthKind = '';
    actImp = { parsed: parsed, plan: null, create: { cat: {}, kind: {}, person: {} }, cfg: cfg };
  }
  function actImpOpts() {
    var c = actImp.cfg, map = {}, pick = function (o) { return Object.keys(actImp.create[o]).filter(function (k) { return actImp.create[o][k]; }); };
    ACT_FIELDS.forEach(function (f) { map[f[0]] = c[f[0]] === '' || c[f[0]] === undefined ? undefined : Number(c[f[0]]); });
    return { map: map, dateFormat: c.fmt, separator: c.sep, defaultState: c.dflt, createCategories: pick('cat'), createKinds: pick('kind'), createPeople: pick('person'), asPrivate: !!c.asPrivate && L.priv.isOpen() };
  }
  function actImpRun() {
    return act(function () { return L.activities.planImport(actImp.parsed, actImpOpts(), st(), today()).then(function (pl) { actImp.plan = pl; render(); }); });
  }
  function actImportCard(s) {
    var A = L.activities, kids = [];
    var card = h('div', { class: 'card', id: 'actimp-card' }, h('h2', { text: 'Import an activities CSV' }),
      h('p', { class: 'mut small', text: 'Map the columns, preview, then confirm. Nothing is saved until you confirm, importing the same file again adds nothing, and no cost goes to Money until you tap.' }),
      h('div', { class: 'row' }, btn('Export CSV', function () { download('lifeos-activities.csv', L.csv.exportActivities(mainState().activities || []), 'text/csv'); }, 'sm', { id: 'exp-activities' }), lockMark(['activities'])));
    // The batch Money offer for the rows just imported: one expense per activity, only on this tap.
    if (actImpDone) {
      var offs = A.importOffers(s, actImpDone.ids);
      if (offs.length) {
        var total = offs.reduce(function (n, o) { return n + o.costCents; }, 0);
        card.appendChild(h('div', { id: 'actimp-offer' }, h('p', { class: 'small', id: 'actimp-offer-text', text: offs.length + (offs.length === 1 ? ' imported activity has' : ' imported activities have') + ' a cost that is done or paid, ' + fmtC(s, total) + ' in all. Nothing is in Money yet.' }),
          btn('Create linked expenses', function () {
            var ids = actImpDone.ids;
            act(function () {
              var res;
              return commit(function (x) { res = A.createExpenses(x, ids); }, 'activity import expenses', ids.map(function (id) { return ['activities', id]; })).then(function () {
                actImpDone = null; setNotice('ok', 'Added ' + res.created + (res.created === 1 ? ' expense' : ' expenses') + ' to Money.' + (res.skipped ? ' Skipped ' + res.skipped + ' already linked or not eligible.' : '')); render();
              });
            });
          }, 'pri', { id: 'actimp-expenses' })));
      }
    }
    // PV-1: with private activities hidden, rows already imported (and moved in) cannot be recognised.
    var pm = L.priv.isOpen() ? [] : L.priv.marks(mainState());
    if (pm.indexOf('activities') >= 0) {
      card.appendChild(h('p', { class: 'small', id: 'actimp-locked' }, lockIcon('Some private items are hidden', 'lockmark'), ' Open the private vault to import activities. Rows already imported may be private, and they can only be recognised while it is open.'));
      return card;
    }
    var fileIn = h('input', { type: 'file', id: 'actimp-file', accept: '.csv,text/csv' });
    fileIn.addEventListener('change', function () {
      var f = fileIn.files && fileIn.files[0];
      if (!f) return;
      act(function () { return readFile(f).then(function (text) { if (!L.store.isUnlocked()) return; actImpStart(L.csv.parse(text)); actImpDone = null; render(); }); });
    });
    card.appendChild(field('CSV file (5 MB max)', fileIn));
    if (!actImp) return card;
    var c = actImp.cfg, hd = actImp.parsed.headers;
    var opts = [{ v: '', t: '(none)' }].concat(hd.map(function (x, i) { return { v: String(i), t: x || ('Column ' + (i + 1)) }; }));
    card.appendChild(h('p', { class: 'mut small', id: 'actimp-size', text: hd.length + ' columns, ' + actImp.parsed.rows.length + ' rows.' }));
    ACT_FIELDS.forEach(function (f) {
      card.appendChild(field(f[1] + (f[2] ? '' : ' (optional)'), sel('actimp-' + f[0], opts, c[f[0]], function (e) { c[f[0]] = e.target.value; actImp.plan = null; render(); })));
    });
    card.appendChild(field('Date format', sel('actimp-datefmt', [{ v: 'auto', t: 'YYYY-MM-DD or MM/DD/YYYY' }, { v: 'dmy', t: 'DD/MM/YYYY (or YYYY-MM-DD)' }], c.fmt, function (e) { c.fmt = e.target.value; actImp.plan = null; })));
    card.appendChild(field('People are separated by', sel('actimp-sep', [{ v: ';', t: 'a semicolon (;)' }, { v: '|', t: 'a vertical bar (|)' }], c.sep, function (e) { c.sep = e.target.value; actImp.plan = null; })));
    if (c.state === '') card.appendChild(field('State for every row (no state column)', sel('actimp-default', [{ v: 'planned', t: 'Planned' }, { v: 'done', t: 'Done' }, { v: 'skipped', t: 'Skipped' }], c.dflt, function (e) { c.dflt = e.target.value; actImp.plan = null; })));
    if (L.priv.isOpen()) card.appendChild(h('label', { class: 'field check' }, h('input', { type: 'checkbox', id: 'actimp-private', checked: !!c.asPrivate, onchange: function (e) { c.asPrivate = !!e.target.checked; actImp.plan = null; render(); } }), h('span', { text: 'Import as private' })));
    if (c.asPrivate && L.priv.isOpen()) card.appendChild(h('p', { class: 'mut small', id: 'actimp-private-note', text: 'Private rows are saved inside the private vault. New categories and health types cannot be created by a private import (they would sit outside it), so rows that name one are rejected and listed below. Add the category or type first, then preview again.' }));
    card.appendChild(h('div', { class: 'row' }, btn('Preview', function () { actImpRun(); }, 'pri', { id: 'actimp-preview' }), btn('Cancel', function () { actImp = null; render(); }, null, { id: 'actimp-cancel' })));
    var pl = actImp.plan;
    if (pl) {
      var body = h('div', { id: 'actimp-result' },
        h('p', { id: 'actimp-summary', text: pl.add.length + ' to add, ' + pl.rejected.length + ' rejected, ' + pl.duplicates + ' already imported.' }),
        h('p', { class: 'small', id: 'actimp-totals', text: 'Planned ' + pl.byState.planned + ', done ' + pl.byState.done + ', skipped ' + pl.byState.skipped + '. Cost in the rows to add: ' + fmtC(s, pl.totals.costCents) + '. Rows that could be added to Money after import: ' + pl.offer.count + '.' }));
      var tick = function (kind, list, label, note) {
        if (!list.length) return;
        body.appendChild(h('p', { class: 'small', id: 'actimp-unknown-' + kind, text: note }));
        list.forEach(function (name, i) {
          var key = kind === 'person' ? L.social.nameKey(name) : L.revenue.normName(name);
          body.appendChild(h('label', { class: 'field check' }, h('input', { type: 'checkbox', id: 'actimp-create-' + kind + '-' + i, checked: !!actImp.create[kind][key], onchange: function (e) { actImp.create[kind][key] = !!e.target.checked; actImpRun(); } }), h('span', { text: label + ' "' + name + '"' })));
        });
      };
      var privOn = !!c.asPrivate && L.priv.isOpen();
      if (privOn && (pl.unknownCategories.length || pl.unknownKinds.length)) body.appendChild(h('p', { class: 'small', id: 'actimp-private-unknown', text: 'Not in your lists, so those rows are rejected: ' + pl.unknownCategories.concat(pl.unknownKinds).join(', ') + '.' }));
      if (!privOn) {
        tick('cat', pl.unknownCategories, 'Create category', 'These categories are not in your list. Rows for categories you do not create take the default category.');
        tick('kind', pl.unknownKinds, 'Create health type', 'These health types are not in your list. Rows for types you do not create are imported with no health type.');
      }
      tick('person', pl.unknownPeople, 'Add as a person', 'These names are not in People. Nothing is added unless you tick it.');
      if (pl.ambiguousPeople.length) body.appendChild(h('p', { class: 'small', id: 'actimp-ambiguous', text: pl.ambiguousPeople.length + (pl.ambiguousPeople.length === 1 ? ' name matches' : ' names match') + ' more than one person, so it credits nobody. Rename one of them in Social.' }));
      if (pl.rejected.length) body.appendChild(h('div', { id: 'actimp-rejected' }, h('p', { class: 'small', text: 'Rejected rows' }),
        h('ul', null, pl.rejected.slice(0, 25).map(function (r) { return h('li', { class: 'small', text: 'Row ' + r.row + ': ' + r.reason }); })),
        pl.rejected.length > 25 ? h('p', { class: 'mut small', text: 'And ' + (pl.rejected.length - 25) + ' more.' }) : null));
      if (!pl.add.length && pl.duplicates) body.appendChild(h('p', { class: 'small', id: 'actimp-nothing', text: 'Nothing new to import: every valid row was already imported.' }));
      body.appendChild(btn(pl.add.length ? 'Import ' + pl.add.length + (pl.add.length === 1 ? ' row' : ' rows') : 'Nothing to import', function () {
        act(function () {
          var res, fn = function (x) { res = A.applyImport(x, pl); addAudit(x, 'activity import'); };
          var done = pl.asPrivate ? L.priv.write(fn, { newPrivate: true }) : commit(fn);
          return done.then(function () {
            actImp = null; actImpDone = { ids: res.ids };
            setNotice('ok', 'Imported ' + res.added + (res.added === 1 ? ' activity' : ' activities') + '.');
            render();
          });
        });
      }, 'pri', { id: 'actimp-confirm', disabled: !pl.add.length }));
      card.appendChild(body);
    }
    return card;
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
    mutedSection(s).forEach(function (x) { out.push(x); });
    out.push(h('h2', { text: 'Lessons from rejections (' + s.memory.lessons.length + ')' }));
    out.push(h('p', { class: 'mut small', id: 'lessons-local', text: 'These reasons stay on this device. They are never sent to the AI.' }));
    if (!s.memory.lessons.length) out.push(h('p', { class: 'mut', text: 'None yet.' }));
    out.push(h('div', null, s.memory.lessons.map(function (l) { return h('div', { class: 'card' }, h('p', { text: l.text })); })));
    return h('div', null, out);
  }

  // ---------- social (v0.10.0) ----------
  // People, a contact log, important dates and facts. Nothing happens by itself: logging a contact, snoozing, changing a cadence,
  // archiving and adding an unknown name as a person are each a tap. Last contact is computed; no duplicate is stored.
  function socLast(r) {
    if (r.never) return 'No contact yet';
    return 'Last contact ' + r.last + ' (' + r.daysSince + (r.daysSince === 1 ? ' day' : ' days') + ' ago)' + (r.source === 'activity' ? ', from Activities' : '');
  }
  function socDue(r) {
    var t = 'every ' + r.cadence + ' days';
    if (r.state === 'overdue' && !r.never) return t + ', overdue by ' + r.overdueDays + (r.overdueDays === 1 ? ' day' : ' days');
    if (r.state === 'overdue') return t;
    if (r.state === 'snoozed') return t + ', snoozed';
    return t + ', due ' + r.dueDate;
  }
  function personById(s, id) { return (s.people || []).filter(function (p) { return p.id === id; })[0]; }
  function groupName(s, p) { var g = p && p.groupId ? (s.groups || []).filter(function (x) { return x.id === p.groupId; })[0] : null; return g ? g.name : ''; }
  function cadenceDialog(s, p) {
    var inp = h('input', { type: 'text', id: 'soc-cad-input', inputmode: 'numeric', maxlength: '4', autocomplete: 'off', value: typeof p.cadenceDays === 'number' ? String(p.cadenceDays) : '' });
    openDialog({
      title: 'Change cadence', yes: 'Save',
      body: [h('p', { class: 'mut small', text: 'Days between contacts for this person. Leave it empty to follow the group, or the default of ' + s.settings.targets.contactDays + ' days.' }), field('Days', inp)],
      onYes: function () { return commit(function (x) { L.social.setCadence(x, p.id, inp.value.trim() === '' ? null : inp.value); }, 'person cadence').then(function () { setNotice('ok', 'Cadence saved.'); render(); }); }
    });
  }
  // One person in a list, with the tap actions. kind: 'overdue' | 'soon' | 'plain'.
  function socRow(s, r, t, acts) {
    var p = personById(s, r.id), g = groupName(s, p), kids = [];
    kids.push(h('div', null, h('span', { class: 'entry-t', text: r.name }), g ? chipEl(g, 'soc-group') : null, h('div', { class: 'mut small', text: socLast(r) + '. ' + socDue(r) })));
    var row = [];
    if (acts.indexOf('reached') >= 0) row.push(btn('Reached out today', function () { actDo({ run: function (x) { L.social.reachedOutToday(x, r.id, t); }, audit: 'social contact' }, 'Contact logged.'); }, 'sm pri soc-reached', { 'aria-label': 'Log contact with ' + r.name + ' today' }));
    if (acts.indexOf('snooze') >= 0) row.push(btn('Snooze 7 days', function () { actDo({ run: function (x) { L.social.snooze(x, r.id, t); }, audit: 'social snooze' }, 'Snoozed for 7 days.'); }, 'sm soc-snooze', { 'aria-label': 'Snooze ' + r.name + ' for 7 days' }));
    if (acts.indexOf('cadence') >= 0) row.push(btn('Change cadence', function () { cadenceDialog(s, p); }, 'sm soc-cadence', { 'aria-label': 'Change cadence for ' + r.name }));
    if (acts.indexOf('archive') >= 0) row.push(btn('Archive', function () { actDo({ run: function (x) { L.social.archivePerson(x, r.id, true); }, audit: 'social archive' }, 'Archived.'); }, 'sm soc-archive', { 'aria-label': 'Archive ' + r.name }));
    if (acts.indexOf('details') >= 0) row.push(btn('Details', function () { go('domain', { domain: 'social', person: r.id }); }, 'sm soc-details', { 'aria-label': 'Details for ' + r.name }));
    kids.push(h('div', { class: 'row' }, row));
    return h('div', ROW({ class: 'item soc-row', 'data-person': r.name, 'data-state': r.state }, 'people', r), kids);
  }
  function workLinks(s, key, id, t, label) {
    var A = L.social, ppl = key === 'pipelineIds' ? A.peopleForPipeline(s, id, t) : A.peopleForProject(s, id, t), linked = {}, kids = [];
    ppl.forEach(function (x) { linked[x.id] = true; });
    ppl.forEach(function (x) {
      kids.push(h('div', { class: 'row wk-person', 'data-person': x.name }, chipEl(x.name, 'wk-person-name'), h('span', { class: 'mut small', text: x.last ? 'last contact ' + x.last : 'no contact yet' }),
        btn('Unlink', function () { actDo({ run: function (y) { (key === 'pipelineIds' ? A.unlinkPipeline : A.unlinkProject)(y, x.id, id); }, audit: 'person unlink' }, 'Unlinked. Nothing was deleted.'); }, 'sm wk-unlink', { 'aria-label': 'Unlink ' + x.name + ' from ' + label })));
    });
    var avail = (s.people || []).filter(function (p) { return !p.archived && !linked[p.id]; });
    if (avail.length) {
      var pick = sel(null, avail.map(function (p) { return { v: p.id, t: p.name }; }), avail[0].id);
      pick.setAttribute('aria-label', 'Person to link to ' + label);
      kids.push(h('div', { class: 'row' }, pick, btn('Link person', function () { actDo({ run: function (y) { (key === 'pipelineIds' ? A.linkPipeline : A.linkProject)(y, pick.value, id); }, audit: 'person link' }, 'Linked.'); }, 'sm wk-link', { 'aria-label': 'Link the chosen person to ' + label })));
    }
    return h('div', { class: 'wk-people' }, kids);
  }
  function askDeletePerson(s, p) {
    var n = L.social.contactsOf(s, p.id).length, box = h('input', { type: 'checkbox', id: 'soc-del-log' });
    openDialog({
      title: 'Delete this person?', yes: 'Delete person', danger: true,
      body: [h('p', { class: 'mut', text: p.name }), h('p', { class: 'small', id: 'soc-del-count', text: n + (n === 1 ? ' logged contact. It is kept' : ' logged contacts. They are kept') + ' without a person unless you tick the box. Linked pipeline items and projects are not deleted.' }),
        h('label', { class: 'field check' }, box, h('span', { text: 'Also delete their logged contacts' }))],
      onYes: function () { var del = box.checked; return commit(function (x) { L.social.deletePerson(x, p.id, { deleteLog: del }); }, 'person delete').then(function () { view.person = null; setNotice('ok', del ? 'Person and their log deleted.' : 'Person deleted. Their log is kept.'); render(); }); }
    });
  }
  // v1.7.0: the episodes a person is a guest on (from Podcasts), newest first. Read only.
  function guestEpisodesCard(s, p) {
    var eps = L.media ? L.media.episodesOfGuest(s, p.id) : [];
    if (!eps.length) return null;
    return h('div', { class: 'card', id: 'soc-episodes' }, h('h2', { text: 'Episodes (' + eps.length + ')' }), eps.map(function (e) {
      return h('div', { class: 'item soc-ep', 'data-title': e.title }, h('div', null, h('span', { class: 'entry-t', text: e.title }), h('span', { class: 'mut small', text: ' ' + mxName(s.shows, e.showId) + (e.recordedOn ? ', recorded ' + e.recordedOn : '') })));
    }));
  }
  function personScreen(s, p) {
    var A = L.social, t = today(), r = A.roster(s, t, { ignoreSnooze: true }).filter(function (x) { return x.id === p.id; })[0];
    if (!r) { var last = A.lastContacts(s, t).get(p.id); r = { id: p.id, name: p.name, cadence: A.cadenceOf(s, p), last: last ? last.date : null, source: last ? last.source : null, never: !last, state: 'archived', daysSince: last ? L.home.dates.daysBetween(t, last.date) : null }; }
    var src = A.cadenceSource(s, p);
    var head = [h('p', { class: 'small', id: 'soc-p-last', text: socLast(r) }),
      h('p', { class: 'small', id: 'soc-p-cad', text: 'Cadence: every ' + r.cadence + ' days (' + (src === 'own' ? 'their own' : src === 'group' ? 'from the group' : 'default') + ')' + (p.snoozedUntil && t < p.snoozedUntil ? '. Snoozed until ' + p.snoozedUntil + '.' : '') + (p.archived ? ' Archived.' : '') }),
      groupName(s, p) ? h('p', { class: 'small', text: 'Group: ' + groupName(s, p) }) : null, p.notes ? h('p', { class: 'small mut', text: p.notes }) : null];
    var top = [];
    if (!p.archived) top.push(btn('Reached out today', function () { actDo({ run: function (x) { A.reachedOutToday(x, p.id, t); }, audit: 'social contact' }, 'Contact logged.'); }, 'sm pri soc-reached'));
    if (!p.archived) top.push(btn('Snooze 7 days', function () { actDo({ run: function (x) { A.snooze(x, p.id, t); }, audit: 'social snooze' }, 'Snoozed for 7 days.'); }, 'sm soc-snooze'));
    if (p.snoozedUntil) top.push(btn('End snooze', function () { actDo({ run: function (x) { A.unsnooze(x, p.id); }, audit: 'social snooze' }); }, 'sm soc-unsnooze'));
    top.push(btn('Change cadence', function () { cadenceDialog(s, p); }, 'sm soc-cadence'));
    top.push(btn(p.archived ? 'Restore' : 'Archive', function () { actDo({ run: function (x) { A.archivePerson(x, p.id, !p.archived); }, audit: 'social archive' }, p.archived ? 'Restored.' : 'Archived.'); }, 'sm soc-archive'));
    top.push(btn('Delete', function () { askDeletePerson(s, p); }, 'sm bad soc-del'));
    // edit
    var en = h('input', { type: 'text', id: 'soc-e-name', maxlength: '100', autocomplete: 'off', value: p.name });
    var eg = sel('soc-e-group', [{ v: '', t: '(no group)' }].concat((s.groups || []).map(function (g) { return { v: g.id, t: g.name }; })), p.groupId || '');
    var ec = h('input', { type: 'text', id: 'soc-e-cad', inputmode: 'numeric', maxlength: '4', autocomplete: 'off', value: typeof p.cadenceDays === 'number' ? String(p.cadenceDays) : '' });
    var enotes = h('textarea', { id: 'soc-e-notes', maxlength: String(A.NOTE_MAX) }, p.notes.length > A.NOTE_MAX ? '' : p.notes);
    var editCard = details('soc-edit', 'Edit', [h('form', { onsubmit: function (e) {
      e.preventDefault();
      act(function () { var patch = { name: en.value, groupId: eg.value, cadenceDays: ec.value.trim() }; if (p.notes.length <= A.NOTE_MAX) patch.notes = enotes.value; return commit(function (x) { A.updatePerson(x, p.id, patch); }, 'person edit').then(function () { setNotice('ok', 'Saved.'); render(); }); });
    } }, field('Name', en), field('Group', eg), field('Own cadence in days (empty follows the group)', ec),
      p.notes.length > A.NOTE_MAX ? h('p', { class: 'mut small', text: 'A longer note carried over from an older entry is kept as it is.' }) : field('Notes (up to ' + A.NOTE_MAX + ' characters)', enotes, 'Do not enter ID numbers, account numbers or passwords.'),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn pri', id: 'soc-e-save', text: 'Save' }), movePrivBtn('people', p)))], view.open === 'soc-edit');
    // log
    var ld = h('input', { type: 'date', id: 'soc-l-date', value: t }), lc = sel('soc-l-channel', A.CHANNELS.map(function (c) { return { v: c, t: c }; }), 'other'), ln = h('input', { type: 'text', id: 'soc-l-note', maxlength: String(A.NOTE_MAX), autocomplete: 'off' });
    var contacts = A.contactsOf(s, p.id), shown = view.logShown || 20;
    var logCard = h('div', { class: 'card', id: 'soc-log' }, h('h2', { text: 'Contact log (' + contacts.length + ')' }),
      h('form', { onsubmit: function (e) { e.preventDefault(); act(function () { return commit(function (x) { A.logContact(x, p.id, { date: ld.value, channel: lc.value, notes: ln.value }, t); }, 'social contact').then(function () { setNotice('ok', 'Contact logged.'); render(); }); }); } },
        field('Date', ld), field('Channel', lc), field('Note (optional, up to ' + A.NOTE_MAX + ' characters)', ln, 'Do not enter ID numbers, account numbers or passwords.'), h('button', { type: 'submit', class: 'btn', id: 'soc-l-add', text: 'Log contact' })),
      contacts.length ? contacts.slice(0, shown).map(function (c) {
        return h('div', ROW({ class: 'item soc-log-item', 'data-date': c.date }, 'contacts', c), h('div', null, h('span', { class: 'entry-t', text: c.date }), h('span', { class: 'mut small', text: ' ' + c.channel }), c.notes ? h('p', { class: 'small mut', text: c.notes }) : null),
          btn('Delete', function () { actDo({ run: function (x) { A.deleteContact(x, c.id); }, audit: 'social contact delete' }, 'Contact deleted.'); }, 'sm bad soc-log-del', { 'aria-label': 'Delete the contact on ' + c.date }));
      }) : h('p', { class: 'mut', text: 'Nothing logged yet.' }),
      contacts.length > shown ? btn('Show more', function () { view.logShown = shown + 20; render(); }, 'sm') : null);
    // important dates
    var dl = h('input', { type: 'text', id: 'soc-d-label', maxlength: '100', autocomplete: 'off' }), dd = h('input', { type: 'date', id: 'soc-d-date' }), dy = h('input', { type: 'checkbox', id: 'soc-d-year' });
    var datesCard = h('div', { class: 'card', id: 'soc-dates' }, h('h2', { text: 'Important dates (' + p.importantDates.length + ' of ' + A.DATES_MAX + ')' }),
      p.importantDates.map(function (d, i) {
        return h('div', { class: 'item soc-date-item', 'data-label': d.label }, h('div', null, h('span', { class: 'entry-t', text: d.label }), h('span', { class: 'mut small', text: ' ' + d.monthDay + (d.year ? ', ' + d.year : '') })),
          btn('Remove', function () { actDo({ run: function (x) { A.removeDate(x, p.id, i); }, audit: 'social date remove' }, 'Date removed.'); }, 'sm bad', { 'aria-label': 'Remove ' + d.label }));
      }),
      p.importantDates.length < A.DATES_MAX ? h('form', { onsubmit: function (e) {
        e.preventDefault();
        act(function () { if (!dd.value) throw new Error('Choose a date.'); return commit(function (x) { A.addDate(x, p.id, { label: dl.value, monthDay: dd.value.slice(5), year: dy.checked ? dd.value.slice(0, 4) : undefined }); }, 'social date add').then(function () { setNotice('ok', 'Date added.'); render(); }); });
      } }, field('Label (for example birthday)', dl), field('Date', dd), h('label', { class: 'field check' }, dy, h('span', { text: 'Remember the year too' })), h('button', { type: 'submit', class: 'btn', id: 'soc-d-add', text: 'Add date' })) : null);
    // facts
    var fl = h('input', { type: 'text', id: 'soc-f-label', maxlength: String(A.FACT_LABEL_MAX), autocomplete: 'off' }), ft = h('input', { type: 'text', id: 'soc-f-text', maxlength: String(A.FACT_TEXT_MAX), autocomplete: 'off' });
    var facts = A.factsOf(p);
    var factsCard = h('div', { class: 'card', id: 'soc-facts' }, h('h2', { text: 'Facts (' + facts.length + ' of ' + A.FACTS_MAX + ')' }),
      h('p', { class: 'mut small', text: 'Stay in this vault. Never shown outside the Social view. Do not enter ID numbers, account numbers or passwords.' }),
      facts.map(function (f) {
        return h('div', { class: 'item soc-fact', 'data-label': f.label }, h('div', null, h('span', { class: 'entry-t', text: f.label }), h('span', { class: 'mut small', text: ' added ' + f.addedOn }), h('p', { class: 'small', text: f.text })),
          btn('Remove', function () { actDo({ run: function (x) { A.removeFact(x, p.id, f.id); }, audit: 'social fact remove' }, 'Fact removed.'); }, 'sm bad soc-fact-del', { 'aria-label': 'Remove the fact ' + f.label }));
      }),
      facts.length < A.FACTS_MAX ? h('form', { onsubmit: function (e) { e.preventDefault(); act(function () { return commit(function (x) { A.addFact(x, p.id, { label: fl.value, text: ft.value }, t); }, 'social fact add').then(function () { setNotice('ok', 'Fact added.'); render(); }); }); } },
        field('Label (up to ' + A.FACT_LABEL_MAX + ' characters)', fl), field('Fact (up to ' + A.FACT_TEXT_MAX + ' characters)', ft), h('button', { type: 'submit', class: 'btn', id: 'soc-f-add', text: 'Add fact' })) : h('p', { class: 'mut small', text: 'This person has the most facts that can be kept. Remove one to add another.' }));
    // work links
    var pipe = (s.pipeline || []).filter(function (x) { return p.pipelineIds.indexOf(x.id) >= 0; }), projs = (s.projects || []).filter(function (x) { return p.projectIds.indexOf(x.id) >= 0; });
    function linkPicker(coll, linkedIds, label, fn, text) {
      var avail = coll.filter(function (x) { return linkedIds.indexOf(x.id) < 0; });
      if (!avail.length) return null;
      var pick = sel(null, avail.map(function (x) { return { v: x.id, t: text(x) }; }), avail[0].id);
      pick.setAttribute('aria-label', 'Choose a ' + label + ' to link');
      return h('div', { class: 'row' }, pick, btn('Link ' + label, function () { actDo({ run: function (x) { fn(x, p.id, pick.value); }, audit: 'person link' }, 'Linked.'); }, 'sm soc-link-' + (label === 'project' ? 'project' : 'pipeline'), { 'aria-label': 'Link the chosen ' + label }));
    }
    var workCard = h('div', { class: 'card', id: 'soc-work' }, h('h2', { text: 'Work links' }),
      h('p', { class: 'mut small', text: 'Unlinking never deletes the pipeline item or the project.' }),
      h('h3', { text: 'Pipeline items (' + pipe.length + ')' }),
      pipe.map(function (x) { return h('div', { class: 'item soc-pipe', 'data-title': x.title }, h('div', null, h('span', { class: 'entry-t', text: x.title }), h('span', { class: 'mut small', text: ' ' + x.stage })), btn('Unlink', function () { actDo({ run: function (y) { A.unlinkPipeline(y, p.id, x.id); }, audit: 'person unlink' }, 'Unlinked. Nothing was deleted.'); }, 'sm soc-unlink-pipe', { 'aria-label': 'Unlink ' + x.title })); }),
      linkPicker(s.pipeline || [], p.pipelineIds, 'pipeline item', A.linkPipeline, function (x) { return x.title; }),
      h('h3', { text: 'Projects (' + projs.length + ')' }),
      projs.map(function (x) { return h('div', { class: 'item soc-proj', 'data-title': x.name }, h('div', null, h('span', { class: 'entry-t', text: x.name })), btn('Unlink', function () { actDo({ run: function (y) { A.unlinkProject(y, p.id, x.id); }, audit: 'person unlink' }, 'Unlinked. Nothing was deleted.'); }, 'sm soc-unlink-proj', { 'aria-label': 'Unlink ' + x.name })); }),
      linkPicker((s.projects || []).filter(function (x) { return !x.archived; }), p.projectIds, 'project', A.linkProject, function (x) { return x.name; }));
    return h('div', null, btn('Back to Social', function () { view.person = null; render(); }, 'sm back', { id: 'soc-back' }), h('h1', { text: p.name }), h('div', { class: 'card', id: 'soc-person' }, head, h('div', { class: 'row' }, top)),
      editCard, logCard, datesCard, factsCard, workCard, guestEpisodesCard(s, p));
  }
  function socialScreen(s) {
    var A = L.social;
    if (view.person) { var pp = personById(s, view.person); if (pp) return personScreen(s, pp); view.person = null; }
    var t = today(), wk = L.metrics.weekStart(t);
    if (!A.current(s)) return socialIntro(s, t);
    var sm = A.summary(s, t), ros = A.roster(s, t);
    var stats = h('div', { class: 'stats' }, stat('People overdue', String(sm.overdue), 'soc-overdue', sm.overdue ? 'bad-t' : ''), stat('Due in 7 days', String(sm.dueSoon), 'soc-soon'), stat('Contacts this week', String(sm.contactsWeek), 'soc-week'), stat('People', String(sm.people), 'soc-people'));
    var od = ros.filter(function (r) { return r.state === 'overdue'; }), soon = ros.filter(function (r) { return r.state === 'soon'; }).sort(function (a, b) { return a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name); });
    var odCard = h('div', { class: 'card', id: 'soc-overdue-list' }, h('h2', { text: 'Overdue (' + od.length + ')' }), od.length ? od.map(function (r) { return socRow(s, r, t, ['reached', 'snooze', 'details']); }) : h('p', { class: 'mut', text: 'Nobody is overdue.' }));
    var soonCard = h('div', { class: 'card', id: 'soc-soon-list' }, h('h2', { text: 'Due within 7 days (' + soon.length + ')' }), soon.length ? soon.map(function (r) { return socRow(s, r, t, ['reached', 'details']); }) : h('p', { class: 'mut', text: 'Nobody is due in the next 7 days.' }));
    var rows = A.byGroup(s, t);
    var groupCard = h('div', { class: 'card', id: 'soc-by-group' }, h('h2', { text: 'By group' }),
      tbl('soc-group-table', ['Group', 'People', 'Overdue', 'Contacts per week, last 8 weeks'], rows.map(function (g) { return { cat: g.name, cells: [g.name + (g.cadenceDays ? ' (' + g.cadenceDays + ' d)' : ''), String(g.people), String(g.overdue), g.weekly.join(' ')] }; })));
    // groups
    var gn = h('input', { type: 'text', id: 'soc-g-name', maxlength: '100', autocomplete: 'off' }), gc = h('input', { type: 'text', id: 'soc-g-days', inputmode: 'numeric', maxlength: '4', autocomplete: 'off', value: '30' });
    var sug = A.suggestions(s);
    var gCard = details('soc-groups', 'Groups (' + (s.groups || []).length + ')', [
      (s.groups || []).map(function (g) {
        return h('div', ROW({ class: 'item soc-group-item', 'data-group': g.name }, 'groups', g), h('div', null, h('span', { class: 'entry-t', text: g.name }), h('span', { class: 'mut small', text: ' every ' + g.cadenceDays + ' days' })),
          h('div', { class: 'row' }, btn('Change days', function () {
            var inp = h('input', { type: 'text', id: 'soc-gd-input', inputmode: 'numeric', maxlength: '4', autocomplete: 'off', value: String(g.cadenceDays) });
            openDialog({ title: 'Days between contacts', yes: 'Save', body: field('Days', inp), onYes: function () { return commit(function (x) { A.updateGroup(x, g.id, { cadenceDays: inp.value }); }, 'social group').then(function () { view.open = 'soc-groups'; render(); }); } });
          }, 'sm', { 'aria-label': 'Change days for ' + g.name }), btn('Delete', function () { view.open = 'soc-groups'; actDo({ run: function (x) { A.deleteGroup(x, g.id); }, audit: 'social group delete' }, 'Group deleted. Its people are kept.'); }, 'sm bad', { 'aria-label': 'Delete group ' + g.name })));
      }),
      sug.length ? h('div', { id: 'soc-suggest' }, h('p', { class: 'mut small', text: 'Suggested groups. Nothing is added until you tap one.' }), h('div', { class: 'row' }, sug.map(function (d) {
        return btn('Add ' + d.name + ' (' + d.cadenceDays + ' days)', function () { view.open = 'soc-groups'; actDo({ run: function (x) { A.addSuggestedGroups(x, [d.name]); }, audit: 'social group add' }, d.name + ' added.'); }, 'sm soc-sug', { 'data-name': d.name });
      }))) : null,
      h('form', { onsubmit: function (e) { e.preventDefault(); act(function () { return commit(function (x) { A.addGroup(x, gn.value, gc.value); }, 'social group add').then(function () { view.open = 'soc-groups'; gn.value = ''; setNotice('ok', 'Group added.'); render(); }); }); } },
        field('New group name', gn), field('Days between contacts', gc), h('button', { type: 'submit', class: 'btn', id: 'soc-g-add', text: 'Add group' }))], view.open === 'soc-groups');
    return h('div', null, btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'), h('h1', { text: 'Social' }),
      h('p', { class: 'mut small', text: 'Dates and counts only. Nothing is logged, snoozed or archived unless you tap it.' }), stats,
      A.ambiguousNames(s) ? h('p', { class: 'small', id: 'soc-ambiguous', text: 'Two or more people share a name, so activities naming it count for none of them. Rename one to fix this.' }) : null, odCard, soonCard, groupCard, gCard, peopleCard(s, t), unlinkedCard(s), olderCard(s));
  }
  function addPersonForm(s, t) {
    var A = L.social;
    var pn = h('input', { type: 'text', id: 'soc-p-name', maxlength: '100', autocomplete: 'off' });
    var pg = sel('soc-p-group', [{ v: '', t: '(no group)' }].concat((s.groups || []).map(function (g) { return { v: g.id, t: g.name + ' (' + g.cadenceDays + ' days)' }; })), '');
    var pc = h('input', { type: 'text', id: 'soc-p-cad', inputmode: 'numeric', maxlength: '4', autocomplete: 'off' });
    var pnotes = h('textarea', { id: 'soc-p-notes', maxlength: String(A.NOTE_MAX) });
    return h('form', { id: 'soc-add-form', onsubmit: function (e) {
      e.preventDefault();
      act(function () {
        var inp = { name: pn.value, groupId: pg.value, cadenceDays: pc.value.trim() };
        if (pnotes.value.trim()) inp.notes = pnotes.value;
        return commit(function (x) { A.addPerson(x, inp); }, 'person add').then(function () { view.open = 'soc-add'; setNotice('ok', 'Person added.'); render(); });
      });
    } }, field('Name', pn), field('Group (optional)', pg), field('Own cadence in days (optional, overrides the group)', pc),
      field('Notes (optional, up to ' + A.NOTE_MAX + ' characters)', pnotes, 'Do not enter ID numbers, account numbers or passwords.'), h('button', { type: 'submit', class: 'btn pri', id: 'soc-p-add', text: 'Add person' }));
  }
  function peopleCard(s, t) {
    var A = L.social, ppl = (s.people || []).filter(function (p) { return !p.archived; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    var arch = (s.people || []).filter(function (p) { return p.archived; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    var results = h('div', { id: 'soc-results' });
    var q = h('input', { type: 'search', id: 'soc-search', maxlength: '100', autocomplete: 'off', 'aria-label': 'Search people and facts' });
    q.addEventListener('input', function () {
      var found = L.social.search(st(), q.value);
      results.replaceChildren();
      if (!q.value.trim()) return;
      if (!found.length) { results.appendChild(h('p', { class: 'mut small', text: 'No matches.' })); return; }
      found.forEach(function (f) {
        var p = personById(st(), f.personId);
        var facts = f.hits.filter(function (x) { return x.kind === 'fact'; }).map(function (x) { var fa = p.facts.filter(function (y) { return y.id === x.id; })[0]; return fa ? fa.label + ': ' + fa.text : ''; });
        results.appendChild(h('div', { class: 'item soc-result', 'data-person': f.name }, h('div', null, h('span', { class: 'entry-t', text: f.name }), facts.length ? h('p', { class: 'small mut', text: facts.join(' | ') }) : null),
          btn('Details', function () { go('domain', { domain: 'social', person: f.personId }); }, 'sm', { 'aria-label': 'Details for ' + f.name })));
      });
    });
    var last = A.lastContacts(s, t);
    return h('div', { id: 'soc-people-card' }, h('div', { class: 'card' }, h('h2', { text: 'People (' + ppl.length + ')' }), field('Search names and facts', q), results,
      ppl.map(function (p) {
        var lc = last.get(p.id);
        return h('div', ROW({ class: 'item soc-person-row', 'data-person': p.name }, 'people', p), h('div', null, h('span', { class: 'entry-t', text: p.name }), groupName(s, p) ? chipEl(groupName(s, p), 'soc-group') : null, h('span', { class: 'mut small', text: ' ' + (lc ? 'last contact ' + lc.date : 'no contact yet') })),
          btn('Details', function () { go('domain', { domain: 'social', person: p.id }); }, 'sm', { 'aria-label': 'Details for ' + p.name }));
      }), ppl.length ? null : h('p', { class: 'mut', text: 'No people yet.' })),
      details('soc-add', 'Add a person', [addPersonForm(s, t)], view.open === 'soc-add' || !ppl.length),
      arch.length ? details('soc-archived', 'Archived (' + arch.length + ')', arch.map(function (p) { return h('div', ROW({ class: 'item soc-arch', 'data-person': p.name }, 'people', p), h('div', null, h('span', { class: 'entry-t', text: p.name })), btn('Details', function () { go('domain', { domain: 'social', person: p.id }); }, 'sm', { 'aria-label': 'Details for ' + p.name })); })) : null);
  }
  function unlinkedCard(s) {
    var un = L.social.unlinkedContacts(s);
    if (!un.length) return null;
    return details('soc-unlinked', 'Logged contacts without a person (' + un.length + ')', [h('p', { class: 'mut small', text: 'Kept when a person was deleted.' }), un.slice(0, 100).map(function (c) {
      return h('div', ROW({ class: 'item soc-unlinked-item' }, 'contacts', c), h('div', null, h('span', { class: 'entry-t', text: c.date }), h('span', { class: 'mut small', text: ' ' + c.channel }), c.notes ? h('p', { class: 'small mut', text: c.notes }) : null),
        btn('Delete', function () { view.open = 'soc-unlinked'; actDo({ run: function (x) { L.social.deleteContact(x, c.id); }, audit: 'social contact delete' }, 'Contact deleted.'); }, 'sm bad', { 'aria-label': 'Delete the contact on ' + c.date }));
    })], view.open === 'soc-unlinked');
  }
  // Older contact entries (and CSV import) stay available as they were; converting them to people is an offer.
  function olderCard(s) {
    // Shown only while at least one entry can convert, so a tap always does something and a second tap has nothing left (audit v0.10.0).
    var n = L.social.current(s) ? L.social.convertible(s) : 0;
    var kids = [];
    if (n) kids.push(h('div', { class: 'card', id: 'soc-convert' }, h('p', { class: 'small', text: n + (n === 1 ? ' older contact entry is' : ' older contact entries are') + ' not part of the people list yet.' }),
      btn('Turn them into people and log', function () { var moved = 0; actDo({ run: function (x) { moved = L.social.convertEntries(x); }, audit: 'social convert' }, function () { return moved + (moved === 1 ? ' entry' : ' entries') + ' converted. Entries that did not fit are kept below.'; }); }, 'sm', { id: 'soc-convert-btn' })));
    kids.push(domainScreen(s, { embed: true, noForm: true }));
    return h('div', { id: 'soc-older' }, kids);
  }
  // No people yet: set up the first one, and the older numbers from entries and activities keep showing.
  function socialIntro(s, t) {
    var A = L.social, kids = [];
    kids.push(h('div', { class: 'card', id: 'soc-intro' }, h('h2', { text: 'People' }), h('p', { class: 'mut small', text: 'Add the people you want to stay in touch with. Until then the older contact entries and activities below still count.' })));
    var sug = A.suggestions(s);
    if (sug.length || (s.groups || []).length) kids.push(h('div', { class: 'card', id: 'soc-groups-intro' }, h('h2', { text: 'Groups (' + (s.groups || []).length + ')' }), (s.groups || []).map(function (g) { return h('p', { class: 'small', text: g.name + ', every ' + g.cadenceDays + ' days' }); }),
      sug.length ? [h('p', { class: 'mut small', id: 'soc-suggest', text: 'Suggested groups. Nothing is added until you tap one.' }), h('div', { class: 'row' }, sug.map(function (d) {
        return btn('Add ' + d.name + ' (' + d.cadenceDays + ' days)', function () { actDo({ run: function (x) { A.addSuggestedGroups(x, [d.name]); }, audit: 'social group add' }, d.name + ' added.'); }, 'sm soc-sug', { 'data-name': d.name });
      }))] : null));
    var gn = h('input', { type: 'text', id: 'soc-g-name', maxlength: '100', autocomplete: 'off' }), gc = h('input', { type: 'text', id: 'soc-g-days', inputmode: 'numeric', maxlength: '4', autocomplete: 'off', value: '30' });
    kids.push(details('soc-groups', 'Add a custom group', [h('form', { onsubmit: function (e) { e.preventDefault(); act(function () { return commit(function (x) { A.addGroup(x, gn.value, gc.value); }, 'social group add').then(function () { view.open = 'soc-groups'; setNotice('ok', 'Group added.'); render(); }); }); } },
      field('Group name', gn), field('Days between contacts', gc), h('button', { type: 'submit', class: 'btn', id: 'soc-g-add', text: 'Add group' }))], view.open === 'soc-groups'));
    kids.push(details('soc-add', 'Add a person', [addPersonForm(s, t)], true));
    return h('div', null, btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'), h('h1', { text: 'Social' }), kids, socialFromActivities(s, t), olderCard(s));
  }
  // Weekly review step: who became overdue this week, who is due next week, contacts made. Offers only.
  function reviewSocialCard(s, wk, t) {
    var A = L.social;
    if (!A.current(s)) return h('p', { class: 'mut', id: 'rv-soc-none', text: 'No people yet. Add some under Social.' });
    var r = A.reviewWeek(s, wk, t);
    return h('div', { class: 'card', id: 'rv-social' },
      h('p', { class: 'small', id: 'rv-soc-stats', text: 'This week: ' + r.contactsMade + (r.contactsMade === 1 ? ' contact' : ' contacts') + ' made, ' + r.overdue + ' overdue now.' }),
      h('p', { class: 'small', id: 'rv-soc-became-h', text: 'Became overdue this week (' + r.became.length + ')' }),
      r.became.length ? h('p', { class: 'mut small', text: 'Nothing changes until you tap it.' }) : null,
      r.became.map(function (x) { return socRow(s, x, t, ['reached', 'snooze', 'cadence', 'archive']); }),
      h('p', { class: 'small', id: 'rv-soc-next-h', text: 'Due next week (' + r.dueNext.length + ')' }),
      r.dueNext.map(function (x) { return socRow(s, x, t, ['reached', 'cadence']); }));
  }

  // ---------- private vault (v0.11.0 part A) ----------
  var PRIV_LABEL = { entries: 'Entries', accounts: 'Accounts', recurring: 'Recurring items', budgets: 'Budgets', projects: 'Projects', pipeline: 'Pipeline', goals: 'Goals',
    maintenance: 'Maintenance', vehicles: 'Vehicles', properties: 'Properties', renewals: 'Renewals', documents: 'Documents', taxItems: 'Tax items', learningItems: 'Learning items',
    studySessions: 'Study sessions', takeaways: 'Takeaways', activities: 'Activities', people: 'People', groups: 'Groups', contacts: 'Logged contacts', habits: 'Daily checks',
    habitLog: 'Daily check ticks', cycle: 'Training cycle', invoices: 'Invoices', trips: 'Mileage trips', payees: 'Payees', taxPayments: 'Tax payments', clients: 'Clients', shows: 'Shows', episodes: 'Episodes', platformStats: 'Platform numbers', sites: 'Sites', siteTraffic: 'Site traffic' };
  function privKey(c, r) { return c === 'cycle' ? 'cycle' : c === 'budgets' ? r.category : c === 'habitLog' ? r.habitId + '|' + r.date : r.id; }
  function privList(s, c) { return c === 'cycle' ? (s.cycle ? [s.cycle] : []) : (s[c] || []); }
  function privText(c, r, s) {
    switch (c) {
      case 'entries': return r.title + ' (' + r.domain + ', ' + r.date + ')';
      case 'accounts': case 'projects': case 'vehicles': case 'properties': case 'groups': case 'people': case 'habits': return r.name;
      case 'budgets': return r.category;
      case 'studySessions': return r.date + ', ' + r.minutes + ' min';
      case 'takeaways': return r.date + ' ' + String(r.text).slice(0, 60);
      case 'contacts': return r.date + ' ' + r.channel + (r.notes ? ' ' + String(r.notes).slice(0, 40) : '');
      case 'habitLog': return r.date + ' ' + ((s.habits || []).filter(function (x) { return x.id === r.habitId; })[0] || { name: 'check' }).name;
      case 'cycle': return 'Training cycle from ' + r.startDate;
      case 'invoices': return 'Invoice ' + r.number;
      case 'trips': return 'Trip ' + r.date + ', ' + r.miles + ' mi';
      case 'sites': return r.hostname;
      case 'platformStats': return 'Number ' + r.date + ' ' + r.measure;
      case 'siteTraffic': return 'Traffic ' + r.month;
      case 'episodes': return r.title;
      case 'taxPayments': return 'Tax payment ' + r.year + ' ' + r.jurisdiction + ' quarter ' + r.quarter;
      default: return r.title || r.name || r.id;
    }
  }


  // Row tagging: while the vault is open a row carries its collection and key; decorateRows() then adds the lock badge and Options.
  function ROW(props, c, r, noOptions) {
    if (!r || !L.priv.isOpen()) return props;
    props['data-pc'] = c; props['data-pk'] = privKey(c, r);
    if (noOptions) props['data-pnoopt'] = '1';
    return props;
  }
  function decorateRows() {
    var root = document.getElementById('app');
    if (!root || !L.store.isUnlocked() || !L.priv.isOpen()) return;
    var s = st();
    Array.prototype.forEach.call(root.querySelectorAll('[data-pc]'), function (el) {
      if (el.getAttribute('data-pdone')) return;
      el.setAttribute('data-pdone', '1');
      var c = el.getAttribute('data-pc'), k = el.getAttribute('data-pk');
      var r = privList(s, c).filter(function (x) { return privKey(c, x) === k; })[0];
      if (!r) return;
      pr(el, c, r, { noOptions: el.getAttribute('data-pnoopt') === '1' });
    });
  }
  // While the vault is open: a lock badge on private rows, and "Move to private vault" / "Move out" wherever a record is edited.
  function isPrivRec(c, r) { return !!r && L.priv.isOpen() && L.priv.isPrivate(c, privKey(c, r)); }
  function lockBadge() { return lockIcon('Private item', 'lockmark privbadge'); }
  function movePrivBtn(c, r) {
    if (!r || !L.priv.isOpen()) return null;
    var isP = isPrivRec(c, r);
    return btn(isP ? 'Move out' : 'Move to private vault', function () { privMoveDialog(st(), c, r, isP ? 'out' : 'in'); }, 'sm priv-move-btn', { 'data-collection': c });
  }
  // Decorate a row: badge when private; an Options button (it opens the item's options dialog) unless the row already has an edit dialog.
  function pr(el, c, r, o) {
    if (!r || !L.priv.isOpen()) return el;
    if (isPrivRec(c, r)) {
      el.classList.add('is-private');
      var t = el.querySelector('.entry-t');
      if (t) t.insertBefore(lockBadge(), t.firstChild); else el.insertBefore(lockBadge(), el.firstChild);
    }
    if (o && o.noOptions) return el;
    var ob = btn('Options', function () { optionsDialog(c, r); }, 'sm priv-opt', { 'aria-label': 'Options for ' + privText(c, r, st()) });
    var last = el.children[el.children.length - 1];
    if (last && last.classList && last.classList.contains('row')) last.appendChild(ob); else el.appendChild(ob);
    return el;
  }
  // For records that have no edit form: a small dialog holding the item's name and the move action.
  function optionsDialog(c, r) {
    var s = st();
    openDialog({ title: 'Options', yes: 'Done', body: [h('p', { class: 'mut', text: privText(c, r, s) }), h('div', { class: 'row' }, movePrivBtn(c, r))], onYes: function () {} });
  }
  function privSetupCard() {
    var p1 = h('input', { type: 'password', id: 'priv-set1', autocomplete: 'new-password', required: true, minlength: '12' });
    var p2 = h('input', { type: 'password', id: 'priv-set2', autocomplete: 'new-password', required: true, minlength: '12' });
    return h('form', { class: 'card', id: 'priv-setup', onsubmit: function (e) {
      e.preventDefault();
      act(function () {
        var a = p1.value;
        checkPass(a);
        if (a !== p2.value) throw new Error('The two passphrases do not match.');
        return L.priv.setUp(a).then(function () { setNotice('ok', 'Private vault set up and open.'); render(); if (L.recoveryUI) L.recoveryUI.privSetupPrompt(recCtx(), a); });
      }).then(function () { p1.value = ''; p2.value = ''; });
    } }, h('h2', { text: 'Set up the private vault' }),
      field('Private passphrase (12 characters or more, different from your main passphrase)', p1), field('Confirm private passphrase', p2),
      h('p', { class: 'warn small', text: 'If you forget this passphrase, the private items cannot be recovered. There is no reset and no backdoor.' }),
      h('button', { type: 'submit', class: 'btn pri', id: 'priv-setup-btn', text: 'Set up private vault' }));
  }
  function privOpenForm() {
    if (L.recoveryUI && L.recoveryUI.privActive()) return L.recoveryUI.privPath(recCtx());
    var p = h('input', { type: 'password', id: 'priv-pass', autocomplete: 'off', required: true });
    var b = h('button', { type: 'submit', class: 'btn pri', id: 'priv-open', text: 'Open private vault' });
    var msg = h('p', { class: 'small', id: 'priv-wait', role: 'status', text: '' });
    function tick() {
      clearTimeout(privTimer);
      var left = Math.ceil((privFail.until - Date.now()) / 1000);
      if (left > 0) { b.disabled = true; msg.textContent = 'Wrong passphrase. Wait ' + left + ' s before trying again.'; privTimer = setTimeout(tick, 250); }
      else { b.disabled = false; msg.textContent = ''; }
    }
    var f = h('form', { onsubmit: function (e) {
      e.preventDefault();
      if (Date.now() < privFail.until) return;
      act(function () {
        var v = p.value;
        return L.priv.open(v).then(function () { privFail = { n: 0, until: 0 }; p.value = ''; setNotice('ok', 'Private vault open.'); render(); }, function (err) {
          if (err && err.message === 'BAD_PRIVATE_PASSPHRASE') { privFail.n++; privFail.until = Date.now() + Math.min(30000, 1000 * Math.pow(2, privFail.n - 1)); }
          p.value = '';
          throw err;
        });
      }).then(tick);
    } }, field('Private passphrase', p), b, msg, L.recoveryUI && L.priv.hasRecovery(mainState()) ? L.recoveryUI.privLink(recCtx()) : null);
    tick();
    return f;
  }
  function privMoveDialog(s, c, r, dir) {
    var key = privKey(c, r), kids = L.priv.childrenOf(s, c, key);
    var pair = (c === 'activities' && r.expenseId) || (c === 'entries' && privList(s, 'activities').some(function (a) { return a.expenseId === key; })) || (c === 'invoices' && r.incomeId) || (c === 'entries' && privList(s, 'invoices').some(function (a) { return a.incomeId === key; }));
    var chk = h('input', { type: 'checkbox', id: 'priv-kids', checked: true });
    openDialog({
      title: dir === 'in' ? 'Move to the private vault?' : 'Move out of the private vault?', yes: dir === 'in' ? 'Move in' : 'Move out',
      body: [h('p', { class: 'mut', text: dir === 'in' ? 'It disappears from every screen, total and export while the vault is closed.' : 'It becomes an ordinary item again, visible with the app unlocked.' }),
        pair ? h('p', { class: 'small', id: 'priv-pair', text: 'An activity and its Money expense, or an invoice and its income entry, always move together.' }) : null,
        c === 'habits' ? h('p', { class: 'small', text: 'Its ticks move with it.' }) : null,
        c === 'shows' || c === 'episodes' || c === 'sites' ? h('p', { class: 'small', id: 'priv-together', text: c === 'shows' ? 'Its episodes and typed numbers always move with it.' : c === 'episodes' ? 'The numbers typed for it always move with it.' : 'Its traffic months always move with it.' }) : null,
        kids.length ? h('label', { class: 'row small' }, chk, h('span', { text: 'Also move ' + kids.length + ' linked ' + (kids.length === 1 ? 'item' : 'items') + ' (default)' })) : null],
      onYes: function () {
        return (dir === 'in' ? L.priv.moveIn : L.priv.moveOut)(c, key, { children: kids.length ? !!chk.checked : false }).then(function () { setNotice('ok', dir === 'in' ? 'Moved to the private vault.' : 'Moved out of the private vault.'); render(); });
      }
    });
  }
  function privMoveCard(s) {
    var colls = L.priv.COLLECTIONS;
    var q = h('input', { type: 'search', id: 'priv-q', value: privPick.q, maxlength: '100', autocomplete: 'off' });
    var cs = sel('priv-coll', colls.map(function (c) { return { v: c, t: PRIV_LABEL[c] }; }), privPick.coll, function (e) { privPick.coll = e.target.value; render(); });
    var c = privPick.coll, needle = privPick.q.trim().toLowerCase();
    var all = privList(s, c).map(function (r) { return { r: r, t: privText(c, r, s), k: privKey(c, r) }; });
    var hit = all.filter(function (x) { return !needle || x.t.toLowerCase().indexOf(needle) >= 0; });
    var rows = hit.slice(0, 50).map(function (x) {
      var isP = L.priv.isPrivate(c, x.k);
      return h('div', { class: 'entry priv-row', 'data-key': x.k, 'data-private': isP ? '1' : '0' },
        h('span', { class: 'entry-t' }, isP ? h('span', { class: 'chip ok' }, 'Private') : null, x.t),
        btn(isP ? 'Move out' : 'Move to private vault', function () { privMoveDialog(s, c, x.r, isP ? 'out' : 'in'); }, 'sm priv-move'));
    });
    return h('div', { class: 'card', id: 'priv-move-card' }, h('h2', { text: 'Move items in or out' }),
      h('p', { class: 'mut small', text: 'Tick "New items are private" above to save new items straight into the vault.' }),
      field('Kind of item', cs),
      h('form', { onsubmit: function (e) { e.preventDefault(); privPick.q = q.value; render(); } }, field('Search', q), h('button', { type: 'submit', class: 'btn sm', id: 'priv-search', text: 'Search' })),
      rows.length ? rows : h('p', { class: 'mut', text: 'Nothing here.' }),
      hit.length > 50 ? h('p', { class: 'mut small', text: 'Showing 50 of ' + hit.length + '. Narrow the search.' }) : null);
  }
  function privScreen(s) {
    var b = mainState(), out = [btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'), h('h1', { text: 'Private vault' }),
      h('p', { class: 'mut', text: 'A second lock inside LifeOS with its own passphrase. Unlocking the app does not open it. While it is closed, private items are missing from every screen, total, search, export and backup view. They never reach an AI prompt, the weekly digest or a CSV, even while it is open.' })];
    if (!L.priv.isSetUp(b)) { out.push(privSetupCard()); return h('div', null, out); }
    var secs = h('input', { type: 'number', id: 'priv-secs', min: '15', max: '1800', step: '1', value: String(b.settings.privAutoLockSec || 60) });
    out.push(h('div', { class: 'card', id: 'priv-status' }, h('h2', { text: L.priv.isOpen() ? 'Open' : 'Closed' }),
      L.priv.isOpen() ? h('p', { class: 'mut', text: 'It closes by itself after ' + (b.settings.privAutoLockSec || 60) + ' seconds without activity, when this tab is hidden, when the app locks, and before any AI request.' }) : privOpenForm(),
      h('form', { onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          var n = Number(secs.value);
          if (!Number.isInteger(n) || n < 15 || n > 1800) throw new Error('Choose a whole number of seconds from 15 to 1800.');
          return commit(function (x) { x.settings.privAutoLockSec = n; }, 'private timer changed').then(render);
        }, 'Saved.');
      } }, field('Close the private vault after this many idle seconds (15 to 1800)', secs), h('button', { type: 'submit', class: 'btn sm', id: 'priv-secs-save', text: 'Save' }))));
    if (L.priv.isOpen()) out.push(privMoveCard(s));
    var o = passOnly('priv-old', 'off'), n1 = passOnly('priv-new1', 'new-password'), n2 = passOnly('priv-new2', 'new-password'), typed = h('input', { type: 'text', id: 'priv-destroy-confirm', autocomplete: 'off' });
    var rcp = L.recoveryUI.changeFields(recCtx(), 'priv', L.priv.hasRecovery(b));
    var chBtn = h('button', { type: 'submit', class: 'btn sm', id: 'priv-change', text: 'Change private passphrase' }), chMsg = h('p', { class: 'small', id: 'priv-change-wait', role: 'status', text: '' });
    function chTick() {
      var left = Math.ceil((privFail.until - Date.now()) / 1000);
      if (left > 0) { chBtn.disabled = true; chMsg.textContent = 'Wrong passphrase. Wait ' + left + ' s before trying again.'; setTimeout(function () { if (chBtn.isConnected) chTick(); }, 250); }
      else { chBtn.disabled = false; chMsg.textContent = ''; }
    }
    chTick();
    out.push(L.recoveryUI.privCard(recCtx(), b));
    out.push(h('div', { class: 'card', id: 'priv-manage' }, h('h2', { text: 'Passphrase and removal' }),
      h('form', { onsubmit: function (e) {
        e.preventDefault();
        if (Date.now() < privFail.until) return;
        act(function () {
          checkPass(n1.value);
          if (n1.value !== n2.value) throw new Error('The two new passphrases do not match.');
          var a = o.value, c = n1.value;
          // UI-6: a wrong current passphrase here counts toward the same wrong-passphrase delay as the open form.
          // v1.8.0: with a private recovery key on, the change also keeps or replaces it (a wrong key counts toward the same delay).
          if (rcp.on) return L.recoveryUI.attempt(recCtx().priv, function () { return L.priv.matches(L.store.getState().priv, a).then(function (ok) { if (!ok) throw new Error('BAD_PRIVATE_PASSPHRASE'); }); }).then(function () { return rcp.opts(); }).then(function (ro) { return L.priv.changePassphrase(a, c, ro); }).then(function () { privFail = { n: 0, until: 0 }; setNotice('ok', 'Private passphrase changed. The vault is closed.'); render(); }, function (err) {
            if (err && (err.message === 'BAD_PRIVATE_PASSPHRASE' || err.message === 'BAD_RECOVERY_KEY')) { privFail.n++; privFail.until = Date.now() + Math.min(30000, 1000 * Math.pow(2, privFail.n - 1)); }
            throw err;
          });
          return L.priv.changePassphrase(a, c).then(function () { privFail = { n: 0, until: 0 }; setNotice('ok', 'Private passphrase changed. The vault is closed.'); render(); }, function (err) {
            if (err && err.message === 'BAD_PRIVATE_PASSPHRASE') { privFail.n++; privFail.until = Date.now() + Math.min(30000, 1000 * Math.pow(2, privFail.n - 1)); }
            throw err;
          });
        }).then(function () { o.value = ''; n1.value = ''; n2.value = ''; chTick(); });
      } }, field('Current private passphrase', o), field('New private passphrase (12 characters or more)', n1), field('Confirm new private passphrase', n2), rcp.nodes,
        chBtn, chMsg),
      h('hr'),
      btn('Destroy the private vault', function () {
        openDialog({ title: 'Destroy the private vault?', yes: 'Destroy it', danger: true,
          body: [h('p', { class: 'mut', text: 'Every private item is permanently deleted. Type DESTROY to confirm. Make a backup first if unsure.' }), field('Confirmation', typed)],
          onYes: function () {
            if (typed.value !== 'DESTROY') throw new Error('Type DESTROY exactly to continue.');
            return L.priv.destroy().then(function () { setNotice('ok', 'Private vault destroyed.'); render(); });
          } });
      }, 'bad', { id: 'priv-destroy' })));
    return h('div', null, out);
  }


  // ---------- wellbeing (v0.11.0 part B): lives only in the private vault; numbers and dates only ----------
  function avgText(v) { return v === null || v === undefined ? '-' : String(Math.round(v * 10) / 10); }
  function wellbeingTile(s, d, t) {
    var open = L.priv.isOpen(), val = 'Locked', lab = '', sub = '';
    if (open) {
      try {
        var w = L.priv.getWellbeing(), a = L.wellbeing.avg(w, 'mood', addDays(t, -6), t).avg;
        val = a === null ? 'n/a' : avgText(a); lab = 'Mood, 7-day average'; sub = 'Streak: ' + L.wellbeing.streak(w, t) + (L.wellbeing.streak(w, t) === 1 ? ' day' : ' days');
      } catch (e) { val = 'n/a'; }
    }
    return h('button', { type: 'button', class: 'tile', 'data-domain': 'wellbeing', 'data-locked': open ? '0' : '1', onclick: function () { go('domain', { domain: 'wellbeing' }); } },
      h('span', { class: 'tile-title' }, d.label, ' ', open ? null : lockIcon('Locked', 'lockmark')),
      h('span', { class: 'tile-value', text: val }), h('span', { class: 'tile-sub', text: lab }), h('span', { class: 'tile-sub', text: sub }));
  }
  function ratingRow(area, label, vals, onTap) {
    var btns = [1, 2, 3, 4, 5].map(function (n) {
      return h('button', { type: 'button', class: 'rate', 'data-area': area, 'data-v': String(n), 'aria-label': label + ' ' + n, 'aria-pressed': vals[area] === n ? 'true' : 'false', text: String(n),
        onclick: function () {
          vals[area] = vals[area] === n ? undefined : n;
          btns.forEach(function (b) { b.setAttribute('aria-pressed', vals[area] === Number(b.getAttribute('data-v')) ? 'true' : 'false'); });
          if (onTap) onTap();
        } });
    });
    return h('div', { class: 'ratingrow', 'data-area': area }, h('span', { class: 'lbl', text: label + ' (1 to 5, optional)' }), h('div', { class: 'row' }, btns));
  }
  function wbTrend(area, label, series) {
    var W = 320, H = 70, P = 10;
    function X(i) { return P + i * (W - 2 * P) / (series.length - 1); }
    function Y(v) { return H - P - (v - 1) / 4 * (H - 2 * P); }
    var g = [h('line', { class: 'axis', x1: '0', y1: String(H - P + 4), x2: String(W), y2: String(H - P + 4) })], run = [];
    function flush() {
      if (run.length > 1) g.push(h('polyline', { class: 'ln-avg', points: run.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') }));
      run = [];
    }
    series.forEach(function (r, i) {
      if (r.value === null) { flush(); return; }
      run.push([X(i), Y(r.value)]);
      g.push(h('circle', { class: 'dot-raw', cx: X(i).toFixed(1), cy: Y(r.value).toFixed(1), r: '2' }));
    });
    flush();
    g.push(h('text', { class: 'tick', x: '2', y: '10', 'text-anchor': 'start' }, '5'));
    g.push(h('text', { class: 'tick', x: '2', y: String(H - 2), 'text-anchor': 'start' }, '1'));
    return h('svg', { class: 'chart', id: 'wb-trend-' + area, viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Trend, last 30 days: ' + label }, g);
  }
  function wbSave(input) {
    return act(function () {
      return L.priv.commit(function (i) { if (!i.wellbeing) i.wellbeing = {}; L.wellbeing.save(i.wellbeing, input); }).then(function () { view.ck = null; setNotice('ok', 'Check-in saved.'); render(); });
    });
  }
  // The check-in panel asks "Quick update, all areas" or "One section" every time it opens.
  function checkinPanel(wb, t) {
    var W = L.wellbeing, ck = view.ck;
    if (!ck) return h('div', { class: 'card', id: 'wb-ck' }, btn('Check in', function () { view.ck = { step: 'choose', date: t }; render(); }, 'pri', { id: 'wb-open-ck' }));
    var dateIn = h('input', { type: 'date', id: 'wb-date', value: ck.date, max: t, required: true, onchange: function (e) { if (e.target.value && e.target.value <= t) { ck.date = e.target.value; render(); } } });
    var dateField = field('Date (past days can be edited)', dateIn);
    var cancel = btn('Cancel', function () { view.ck = null; render(); }, 'sm', { id: 'wb-ck-cancel' });
    if (ck.step === 'choose') {
      return h('div', { class: 'card', id: 'wb-ck' }, h('h2', { text: 'Check in' }), dateField,
        h('div', { class: 'row' }, btn('Quick update, all areas', function () { ck.step = 'quick'; render(); }, 'pri', { id: 'wb-quick' }), btn('One section', function () { ck.step = 'section'; render(); }, '', { id: 'wb-section' }), cancel));
    }
    var cur = W.byDate(wb, ck.date) || {}, vals = {};
    W.AREA_IDS.forEach(function (a) { if (cur[a] !== undefined) vals[a] = cur[a]; });
    var note = h('textarea', { id: 'wb-note', maxlength: String(W.NOTE_MAX), value: cur.note || '', 'aria-label': 'Note' });
    var rows, area = ck.area && W.AREA_IDS.indexOf(ck.area) >= 0 ? ck.area : 'mood';
    if (ck.step === 'quick') rows = W.AREAS.map(function (a) { return ratingRow(a.id, a.label, vals); });
    else {
      var pick = sel('wb-area', W.AREAS.map(function (a) { return { v: a.id, t: a.label }; }), area, function (e) { ck.area = e.target.value; render(); });
      rows = [field('Section', pick), ratingRow(area, (W.AREAS.filter(function (a) { return a.id === area; })[0]).label, vals)];
    }
    return h('form', { class: 'card', id: 'wb-ck', onsubmit: function (e) {
      e.preventDefault();
      var input = { date: ck.date };
      Object.keys(vals).forEach(function (a) { if (vals[a] !== undefined && (ck.step === 'quick' || a === area)) input[a] = vals[a]; });
      input.note = note.value;
      wbSave(input);
    } }, h('h2', { text: ck.step === 'quick' ? 'Quick update, all areas' : 'One section' }), dateField, rows,
      field('Note (optional, up to ' + W.NOTE_MAX + ' characters)', note),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn pri', id: 'wb-save', text: 'Save check-in' }), cancel));
  }
  function wbAreaCard(wb, a, t, s) {
    var W = L.wellbeing, sm = W.summary(wb, a.id, t), live = W.live(s, t), kids = [];
    kids.push(h('h3', { text: a.label }));
    kids.push(h('div', { class: 'stats' },
      stat('Today', sm.today === null ? '-' : String(sm.today), 'wb-today-' + a.id),
      stat('7-day average', avgText(sm.avg7.avg) + (sm.avg7.n ? ' (' + sm.avg7.n + ')' : ''), 'wb-avg7-' + a.id),
      stat('30-day average', avgText(sm.avg30.avg) + (sm.avg30.n ? ' (' + sm.avg30.n + ')' : ''), 'wb-avg30-' + a.id),
      stat('Previous 7 days', avgText(sm.prev7.avg) + (sm.prev7.n ? ' (' + sm.prev7.n + ')' : ''), 'wb-prev7-' + a.id)));
    kids.push(wbTrend(a.id, a.label, sm.series));
    if (a.id === 'recovery') {
      kids.push(h('div', { class: 'sub', id: 'wb-sleep' }, h('p', { class: 'small', text: 'Sleep from Health, read live: last night ' + (live.sleep.today === null ? '-' : live.sleep.today + ' h') + ', 7-day average ' + (live.sleep.avg7.avg === null ? '-' : live.sleep.avg7.avg + ' h') + ' (' + live.sleep.avg7.n + ' nights), 30-day average ' + (live.sleep.avg30.avg === null ? '-' : live.sleep.avg30.avg + ' h') + ' (' + live.sleep.avg30.n + ').' })));
    }
    if (a.id === 'connected') {
      kids.push(h('div', { class: 'sub', id: 'wb-social' }, h('p', { class: 'small', text: 'Contacts made, from Social, read live: today ' + live.contacts.today + ', last 7 days ' + live.contacts.d7 + ', last 30 days ' + live.contacts.d30 + '.' }),
        h('p', { class: 'small', text: 'Social-tagged activities, from Activities, read live: today ' + live.socialActivities.today + ', last 7 days ' + live.socialActivities.d7 + ', last 30 days ' + live.socialActivities.d30 + '.' })));
    }
    return h('div', { class: 'card wb-area', 'data-area': a.id }, kids);
  }
  function wbOldCard(s) {
    var W = L.wellbeing, wb = L.priv.getWellbeing();
    if (!W.hasOld(s.entries)) return null;
    var n = W.pendingOld(s.entries, wb), all = s.entries.filter(function (e) { return e.domain === 'wellbeing' && e.type === 'mood'; }).length;
    if (!n) return h('p', { class: 'small mut', id: 'wb-old-left', text: all + (all === 1 ? ' earlier mood entry cannot move in without losing something, so it stays where it is.' : ' earlier mood entries cannot move in without losing something, so they stay where they are.') });
    return h('div', { class: 'card', id: 'wb-old' }, h('h2', { text: 'Earlier mood entries' }),
      h('p', { class: 'small', text: n + (n === 1 ? ' earlier mood entry can move' : ' earlier mood entries can move') + ' into the vault as check-ins. Nothing is lost: a rating, its date and its text move together.' + (all > n ? ' ' + (all - n) + ' stay where they are because they would lose something.' : '') }),
      btn('Move them in', function () {
        openDialog({ title: 'Move earlier mood entries into the vault?', yes: 'Move in', body: h('p', { class: 'mut', text: 'They leave the main data and become check-ins. They disappear from every screen and export while the vault is closed.' }),
          onYes: function () {
            return L.priv.write(function (work, wbw) { L.wellbeing.moveOld(work, wbw, L.store.newId); }, { audit: 'private vault moved in' }).then(function () { setNotice('ok', 'Earlier mood entries moved in as check-ins.'); render(); });
          } });
      }, 'pri', { id: 'wb-old-move' }));
  }
  function wellbeingScreen(s) {
    var out = [btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'), h('h1', { text: 'Wellbeing' })];
    var b = mainState();
    if (!L.priv.isSetUp(b)) {
      out.push(h('p', { class: 'mut', text: 'Wellbeing is kept only inside the private vault: a second lock with its own passphrase. It never reaches an AI request, the weekly digest, a CSV or a backup readable without that passphrase.' }));
      var legacy = b.entries.filter(function (e) { return e.domain === 'wellbeing'; }).length;
      if (legacy) out.push(h('p', { class: 'small mut', id: 'wb-legacy', text: 'Earlier mood entries stay where they are until the vault exists. Then you can move them in as check-ins.' }));
      out.push(privSetupCard());
      return h('div', null, out);
    }
    if (!L.priv.isOpen()) {
      out.push(h('p', { class: 'mut', id: 'wb-locked', text: 'Locked. Enter the private passphrase to see and add check-ins.' }), h('div', { class: 'card' }, h('h2', { text: 'Open the private vault' }), privOpenForm()));
      return h('div', null, out);
    }
    var W = L.wellbeing, wb = L.priv.getWellbeing(), t = today(), st1 = W.streak(wb, t);
    out.push(h('p', { class: 'mut small', text: 'Numbers and dates only. Stored in the private vault, never in the main data.' }));
    var old = wbOldCard(s);
    if (old) out.push(old);
    out.push(checkinPanel(wb, t));
    out.push(h('div', { class: 'stats' }, stat('Check-in streak', st1 + (st1 === 1 ? ' day' : ' days'), 'wb-streak'), stat('Check-ins this week', String(W.checkinsInWeek(wb, t)), 'wb-week')));
    W.AREAS.forEach(function (a) { out.push(wbAreaCard(wb, a, t, s)); });
    var recent = W.listOf(wb).slice().sort(function (x, y) { return y.date.localeCompare(x.date); }).slice(0, 14);
    out.push(h('h2', { text: 'Recent check-ins' }));
    out.push(h('div', { class: 'card', id: 'wb-recent' }, recent.length ? recent.map(function (c) {
      var parts = W.AREAS.filter(function (a) { return c[a.id] !== undefined; }).map(function (a) { return a.label + ' ' + c[a.id]; });
      return h('div', { class: 'item wb-row', 'data-date': c.date }, h('div', null, h('span', { class: 'entry-t', text: c.date }), h('div', { class: 'mut small', text: parts.join(', ') }), c.note ? h('div', { class: 'small', text: c.note }) : null),
        btn('Edit', function () { view.ck = { step: 'choose', date: c.date }; render(); window.scrollTo(0, 0); }, 'sm wb-edit', { 'aria-label': 'Edit check-in for ' + c.date }));
    }) : h('p', { class: 'mut', text: 'No check-ins yet.' })));
    return h('div', null, out);
  }

  // ---------- settings ----------
  var passOnly = function (id, auto) { return h('input', { type: 'password', id: id, autocomplete: auto || 'off', minlength: '12' }); };
  // v1.5.0 B13: "Test connection" sends a fixed prompt with no user data and shows success or one fixed code.
  var TEST_TEXT = { AI_TIMEOUT: 'The request timed out.', AI_NETWORK: 'The provider could not be reached.', AI_HTTP: 'The provider returned an error. Check the key, the model name and the spend limit.', AI_BAD_REPLY: 'The provider sent a reply that could not be read.', AI_FAIL: 'The test could not run. Check the mode, the key and the model name.' };
  function testConnection(kind, base, model, key, pv, out) {
    if (kind === 'none') { out.textContent = 'Rules only: no AI is set up, so there is no connection to test.'; out.setAttribute('data-code', 'NONE'); return; }
    if (kind === 'manual') { out.textContent = 'Manual mode has no connection to test. Copy the prompt into your own AI chat and paste the reply.'; out.setAttribute('data-code', 'MANUAL'); return; }
    var p;
    try {
      p = L.ai.validateProvider({ kind: kind, baseUrl: kind === 'local' ? base.value.trim() : '', model: model.value.trim(), apiKey: kind === 'anthropic' ? (key.value.trim() || pv.apiKey || '') : '' });
    } catch (e) { out.textContent = 'Connection failed. Code: AI_FAIL. ' + TEST_TEXT.AI_FAIL; return; }
    out.textContent = 'Testing. A fixed message with no data from your vault is being sent.';
    L.ai.testConnection(p).then(function (r) {
      out.textContent = r.ok ? 'Connection works. The provider answered the fixed test message.' : 'Connection failed. Code: ' + r.code + '. ' + TEST_TEXT[r.code];
      out.setAttribute('data-code', r.ok ? 'OK' : r.code);
    });
  }
  // v1.5.0 B17: the calendar file. Two ticks, both off; each shows a plain warning when ticked. Download only.
  function calendarCard() {
    var real = h('input', { type: 'checkbox', id: 'cal-real' }), priv = h('input', { type: 'checkbox', id: 'cal-priv' });
    var open = L.priv.isOpen();
    var warnReal = h('p', { class: 'warn small hidden', id: 'cal-real-warn', role: 'status', text: 'Warning: the calendar file is not encrypted. With this ticked, the titles of your items are written into it, and any calendar app or provider you add it to can read them.' });
    var warnPriv = h('p', { class: 'warn small hidden', id: 'cal-priv-warn', role: 'status', text: 'Warning: items from the private vault would be written into a file that is not encrypted, outside the vault lock.' });
    real.addEventListener('change', function () { warnReal.classList.toggle('hidden', !real.checked); });
    priv.addEventListener('change', function () { warnPriv.classList.toggle('hidden', !priv.checked); });
    return h('div', { class: 'card', id: 'calendar-card' }, h('h2', { text: 'Calendar file' }),
      h('p', { class: 'mut small', text: 'Dated items in the next 12 months as a file you add to your own calendar app: renewals, maintenance, estimated tax payments, invoice due dates, goal due dates, exams and certification expiries, planned activities and important dates. Built on this device and downloaded; nothing is sent anywhere. Titles are generic by default, for example "LifeOS: renewal due". Importing the file again updates the same events.' }),
      h('label', { class: 'field check' }, real, ' Include real titles'), warnReal,
      open ? h('label', { class: 'field check' }, priv, ' Include private items') : h('p', { class: 'mut small', text: 'Private items are left out. Open the private vault to offer them.' }), open ? warnPriv : null,
      h('div', { class: 'row' }, btn('Download calendar file', function () {
        act(function () {
          var r = L.calendar.build(L.store.getState(), { today: today(), realTitles: real.checked, includePrivate: open && priv.checked });
          download(L.calendar.filename(today()), r.text, 'text/calendar');
          return commit(null, 'calendar export').then(function () { setNotice('ok', 'Calendar file downloaded with ' + r.count + (r.count === 1 ? ' event.' : ' events.')); });
        });
      }, 'pri', { id: 'cal-download' })));
  }
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
    var testOut = h('p', { class: 'small', id: 'p-test-out', role: 'status', text: '' });
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
        btn('Test connection', function () { testConnection(kind, base, model, key, pv, testOut); }, '', { id: 'p-test' }),
        pv.apiKey ? btn('Remove saved key', function () {
          act(function () { return commit(function (x) { x.settings.provider.apiKey = ''; }, 'provider change').then(function () { setNotice('ok', 'Key removed.'); render(); }); });
        }) : null),
      testOut);
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
          return commit(function (x) { x.settings.targets = { workoutsPerWeek: w, contactDays: c, savingsRate: r / 100 }; x.settings.currency = cu; x.settings.setup.targetsSaved = true; x.settings.autoLockMin = m; L.learning.setWeeklyTarget(x, study.value); }).then(function () { resetIdle(true); setNotice('ok', 'Settings saved.'); });
        });
      }
    }, h('h2', { text: 'Targets and preferences' }), field('Workouts per week', wpw), field('Days between contacts', cd), field('Savings rate target (%)', sr), field('Study minutes per week (0 for none)', study), field('Currency code', cur), field('Auto-lock after idle', al),
      h('button', { type: 'submit', class: 'btn pri', text: 'Save settings' })));

    // passphrase
    var o = passOnly('pp-old', 'current-password'), n1 = passOnly('pp-new', 'new-password'), n2 = passOnly('pp-new2', 'new-password');
    var rcf = L.recoveryUI.changeFields(recCtx(), 'main', L.store.hasRecovery());
    out.push(h('form', {
      class: 'card',
      onsubmit: function (e) {
        e.preventDefault();
        act(function () {
          checkPass(n1.value);
          if (n1.value !== n2.value) throw new Error('The new passphrases do not match.');
          // SEC-130: the current passphrase is checked before a new recovery key is shown, so a key is never written down for a change that fails.
          return (rcf.on ? L.recoveryUI.attempt(recCtx().main, function () { return L.store.matchesMain(o.value).then(function (ok) { if (!ok) throw new Error('BAD_PASSPHRASE_OR_DATA'); }); }) : Promise.resolve()).then(function () { return rcf.opts(); }).then(function (ro) {
            return L.recoveryUI.attempt(recCtx().main, function () { return L.store.changePassphrase(o.value, n1.value, ro); });
          }).then(function () { return commit(null, 'passphrase change'); }).then(function () { setNotice('ok', 'Passphrase changed.'); render(); });
        }).then(function () { o.value = ''; n1.value = ''; n2.value = ''; });
      }
    }, h('h2', { text: 'Change passphrase' }), field('Current passphrase', o), field('New passphrase (12 characters or more)', n1), field('Confirm new passphrase', n2), rcf.nodes, passNote(),
      h('button', { type: 'submit', class: 'btn', text: 'Change passphrase' })));
    out.push(L.recoveryUI.mainCard(recCtx()));
    if (L.guideUI) out.push(h('div', { class: 'card', id: 'guide-card' }, h('h2', { text: 'Getting started' }), h('p', { class: 'mut small', text: 'The first-time steps in order.' }), btn('Open Getting started', function () { L.guideUI.open(recCtx()); }, 'sm', { id: 'settings-guide' })));

    // storage, reminders, verify and diagnostics (v1.3.0)
    out.push(safetySettings(mainState()));
    out.push(calendarCard());

    // backup
    var bp = passOnly('bk-pass', 'new-password'), bp2 = passOnly('bk-pass2', 'new-password'), bpk = L.store.hasRecovery() ? passOnly('bk-key', 'off') : null;
    var bf = h('input', { type: 'file', id: 'bk-file', accept: '.json,application/json' });
    var ip = passOnly('bk-ipass', 'current-password');
    out.push(h('div', { class: 'card' }, h('h2', { text: 'Encrypted backup' }),
      h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          act(function () {
            return Promise.resolve().then(function () { return runExport(bp.value, bp2.value, bpk ? bpk.value : ''); }).then(function () { setNotice('ok', 'Backup downloaded.'); });
          }).then(function () { bp.value = ''; bp2.value = ''; if (bpk) bpk.value = ''; });
        }
      }, field('Backup passphrase (12 characters or more)', bp), field('Confirm backup passphrase', bp2), bpk ? field('Recovery key (the backup file carries it)', bpk) : null, passNote(),
        h('button', { type: 'submit', class: 'btn', text: 'Export backup' })),
      h('hr'),
      h('form', {
        onsubmit: function (e) {
          e.preventDefault();
          var f = bf.files && bf.files[0];
          if (!f) { setNotice('err', 'Choose a backup file first.'); return; }
          if (f.size > L.vault.MAX_BACKUP) { setNotice('err', 'That file is larger than 64 MB.'); return; }
          if (!ip.value) { setNotice('err', 'Enter the backup passphrase.'); return; }
          var ipv = ip.value;
          ip.value = ''; // UI-9: never left in the field, whether the passphrase works or not
          act(function () {
            return readFile(f, L.vault.MAX_BACKUP).then(function (text) { return L.vault.importBackup(ipv, text); }).then(function (state) {
              if (!L.store.isUnlocked()) return;
              var ins = state.memory.insights, pv2 = state.settings.provider;
              var nAppr = ins.filter(function (i) { return i.status === 'approved'; }).length;
              var rr = h('input', { type: 'checkbox', id: 'bk-rereview', checked: true });
              var cur = mainState(), older = L.store.dropsWork(cur, state);
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
                    h('li', { id: 'bk-priv', text: 'Private vault in this backup: ' + (state.priv ? 'yes' : 'no') + '. In this vault now: ' + (cur.priv ? 'yes' : 'no') + '.' }),
                    h('li', { text: 'Approved insights: ' + nAppr }),
                    h('li', { text: 'Lessons: ' + state.memory.lessons.length }),
                    h('li', { text: 'Provider settings: ' + (pv2.kind === 'none' ? 'none' : 'included (' + pv2.kind + ')') }),
                    h('li', { text: 'API key: ' + (pv2.apiKey ? 'included' : 'not included') })),
                  h('label', { class: 'row small' }, rr, h('span', { text: 'Re-review insights (restore every approved insight as proposed)' })),
                  older ? h('p', { class: 'small', id: 'bk-older', text: L.store.lossWhy(L.store.droppedData(cur, state), state.sourceSchema < 14, 'This backup') + 'Restoring it removes your ' + L.store.lossText(cur, state) + '.' }) : null,
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

    out.push(h('p', { class: 'mut small', id: 'app-version', text: 'LifeOS v' + L.VERSION }));

    if (L.syncUI) out.push(L.syncUI.section(syncCtx()));
    if (L.archiveUI) out.push(L.archiveUI.section(archCtx()));

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
                clearTimeout(idleTimer); idleTimer = null;
                vaultExists = false; view = { name: 'lock' }; notice = { kind: 'ok', text: 'All data wiped.' }; hist.lock();
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

  // ---------- lines of work and revenue (v0.12.0) ----------
  function liveLines(s) { return (s.projects || []).filter(function (p) { return !p.archived; }).sort(function (a, b) { return a.name.localeCompare(b.name); }); }
  function lineOptions(s, none) {
    return [{ v: '', t: none }].concat(liveLines(s).map(function (p) { return { v: p.id, t: p.name + (p.parentId && projName(s, p.parentId) ? ' (under ' + projName(s, p.parentId) + ')' : '') }; }));
  }
  function parentLineOptions(s, selfId) {
    return [{ v: '', t: '(no parent)' }].concat(liveLines(s).filter(function (p) { return !p.parentId && p.id !== selfId; }).map(function (p) { return { v: p.id, t: p.name }; }));
  }
  function parentDialog(s, p) {
    var hasKids = (s.projects || []).some(function (x) { return x.parentId === p.id; });
    var pick = sel('pj-parent-pick', hasKids ? [{ v: '', t: '(no parent)' }] : parentLineOptions(s, p.id), p.parentId || '');
    openDialog({
      title: 'Parent line of work', yes: 'Save',
      body: [hasKids ? h('p', { class: 'small', text: 'This line has lines under it, so it cannot have a parent (one level only).' }) : null, field('Under', pick)],
      onYes: function () { return commit(function (x) { L.revenue.setParent(x, p.id, pick.value); }, 'project parent').then(function () { render(); }); }
    });
  }
  function markReceivedDialog(item) {
    var d = h('input', { type: 'date', id: 'rcv-date', value: today(), required: true });
    openDialog({
      title: 'Mark as received', yes: 'Mark received',
      body: [h('p', { class: 'mut', text: item.title }), field('Date received', d), h('p', { class: 'small', text: 'It is counted in Money on the date you pick.' })],
      onYes: function () { return commit(function (x) { L.revenue.markReceived(x, item.id, d.value); }, 'income received').then(function () { setNotice('ok', 'Marked received.'); render(); }); }
    });
  }
  function moveDueDialog(item) {
    var d = h('input', { type: 'date', id: 'due-date', value: item.due, required: true });
    openDialog({
      title: 'Move the due date', yes: 'Save',
      body: [h('p', { class: 'mut', text: item.title }), field('New due date', d)],
      onYes: function () { return commit(function (x) { L.revenue.moveDue(x, item.id, d.value); }, 'income due moved').then(function () { setNotice('ok', 'Due date moved.'); render(); }); }
    });
  }
  function writeOffDialog(item) {
    openDialog({
      title: 'Write off this income?', yes: 'Write off', danger: true,
      body: [h('p', { class: 'mut', text: item.title }), h('p', { class: 'small', text: 'It stays in your records as written off and is not counted anywhere.' })],
      onYes: function () { return commit(function (x) { L.revenue.writeOff(x, item.id); }, 'income written off').then(function () { setNotice('ok', 'Written off.'); render(); }); }
    });
  }
  // One expected-income row with the offer-only actions.
  function expectedRow(s, x, acts) {
    var ln = x.projectId ? projName(s, x.projectId) : '';
    return h('div', ROW({ class: 'item exp-row', 'data-exp': x.title }, 'entries', { id: x.id }),
      h('div', null, h('div', { class: 'entry-t', text: x.title }), h('div', { class: 'mut small', text: 'Due ' + x.due + ' | ' + fmtC(s, x.cents) + (ln ? ' | ' + ln : '') })),
      h('div', { class: 'row' },
        acts.indexOf('received') >= 0 ? btn('Mark received', function () { markReceivedDialog(x); }, 'sm pri', { 'aria-label': 'Mark ' + x.title + ' received' }) : null,
        acts.indexOf('move') >= 0 ? btn('Move due date', function () { moveDueDialog(x); }, 'sm', { 'aria-label': 'Move the due date of ' + x.title }) : null,
        acts.indexOf('writeoff') >= 0 ? btn('Write off', function () { writeOffDialog(x); }, 'sm bad', { 'aria-label': 'Write off ' + x.title }) : null));
  }
  function reviewRevenueCard(s, wk, t) {
    var r = L.revenue.reviewWeek(s, wk, t);
    return h('div', { class: 'card', id: 'rv-revenue' },
      h('p', { class: 'small', id: 'rv-rev-received', text: 'Received this week: ' + fmtC(s, r.receivedCents) + '.' }),
      h('p', { class: 'small', id: 'rv-rev-overdue-h', text: 'Overdue expected income (' + r.overdue.length + ', ' + fmtC(s, r.overdueCents) + ')' }),
      r.overdue.length ? h('p', { class: 'mut small', text: 'Nothing changes until you tap it.' }) : null,
      r.overdue.map(function (x) { return expectedRow(s, x, ['received', 'move', 'writeoff']); }),
      lockMark(['entries']));
  }
  function bulkAssignCard(s) {
    var typ = sel('ba-type', [{ v: 'any', t: 'Income and expenses' }, { v: 'income', t: 'Income only' }, { v: 'expense', t: 'Expenses only' }], 'any');
    var from = h('input', { type: 'date', id: 'ba-from' }), to = h('input', { type: 'date', id: 'ba-to' });
    var text = h('input', { type: 'text', id: 'ba-text', maxlength: '200', autocomplete: 'off' });
    var cur = sel('ba-cur', [{ v: 'any', t: 'Any line of work' }, { v: 'none', t: 'Unassigned only' }].concat(lineOptions(s, '').slice(1)), 'any');
    var target = sel('ba-target', lineOptions(s, '(remove the line of work)'), '');
    var count = h('p', { class: 'small', id: 'ba-count', role: 'status', text: '' });
    function matches() { return L.revenue.filterEntries(st(), { type: typ.value, from: from.value || undefined, to: to.value || undefined, text: text.value, line: cur.value }); }
    return details('bulk-assign', 'Assign entries to a line of work', [
      h('p', { class: 'mut small', text: 'Filter the entries, then assign them all to one line of work. You confirm the count first.' }),
      field('Type', typ), field('From date (optional)', from), field('To date (optional)', to), field('Title contains (optional)', text), field('Currently on', cur), field('Assign to', target),
      h('div', { class: 'row' },
        btn('Count matches', function () { var n = matches().length; count.textContent = n + (n === 1 ? ' entry matches.' : ' entries match.'); }, 'sm', { id: 'ba-preview' }),
        btn('Assign...', function () {
          var list = matches(), n = list.length;
          if (!n) { count.textContent = 'No entries match.'; return; }
          var dest = target.value ? projName(st(), target.value) : '';
          openDialog({
            title: 'Assign ' + n + (n === 1 ? ' entry?' : ' entries?'), yes: 'Assign',
            body: [h('p', { class: 'mut', id: 'ba-confirm-count', text: n + (n === 1 ? ' entry' : ' entries') + ' will ' + (target.value ? 'be assigned to the chosen line of work.' : 'lose their line of work.') })],
            onYes: function () {
              var ids = list.map(function (e) { return e.id; });
              return commit(function (x) { L.revenue.assignLine(x, ids, target.value || null); }, 'entries assigned').then(function () { view.open = 'bulk-assign'; setNotice('ok', 'Assigned ' + n + (n === 1 ? ' entry.' : ' entries.')); render(); });
            }
          });
          void dest;
        }, 'sm pri', { id: 'ba-assign' })),
      count], view.open === 'bulk-assign');
  }

  function scopeFrom(s, v) {
    if (!v || v === 'all') return { kind: 'all' };
    if (v === 'unassigned') return { kind: 'unassigned' };
    var i = v.indexOf(':'), k = v.slice(0, i), id = v.slice(i + 1);
    return (k === 'line' || k === 'rollup') && (s.projects || []).some(function (p) { return p.id === id; }) ? { kind: k, id: id } : { kind: 'all' };
  }
  function scopeKey(sc) { return sc.kind === 'line' || sc.kind === 'rollup' ? sc.kind + ':' + sc.id : sc.kind; }
  function scopeName(s, sc) { return sc.kind === 'all' ? 'All money' : sc.kind === 'unassigned' ? 'Unassigned' : projName(s, sc.id) + (sc.kind === 'rollup' ? ' (with lines under it)' : ''); }
  function revRow(s, l, kind, sc) {
    var sel0 = scopeKey(sc) === kind;
    return h('tr', { 'data-line': l.name, 'data-kind': kind.split(':')[0], 'aria-selected': sel0 ? 'true' : null },
      h('td', { class: 'c-name', text: l.name }), h('td', { class: 'c-rev', text: fmtC(s, l.revenueCents) }), h('td', { class: 'c-exp', text: fmtC(s, l.expenseCents) }),
      h('td', { class: 'c-net', text: fmtC(s, l.netCents) }), h('td', { class: 'c-margin', text: L.revenue.marginText(l.marginBp) }),
      h('td', null, btn('Details', function () { view.sel = kind; render(); }, 'sm', { 'aria-label': 'Show details for ' + l.name })));
  }
  function revTable(id, rows) {
    return h('div', { class: 'tablewrap' }, h('table', { id: id },
      h('thead', null, h('tr', null, ['Line of work', 'Revenue', 'Expenses', 'Net', 'Margin', ''].map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, rows)));
  }
  function revenueScreen(s) {
    var t = today(), R = L.revenue, cur = s.settings.currency;
    var per = view.period || 'month', custom = { from: view.cfrom || t.slice(0, 7) + '-01', to: view.cto || t }, range, rerr = '';
    try { range = R.periodRange(per, t, custom); } catch (e) { rerr = friendly(e); range = R.periodRange('month', t); }
    var rep = R.report(s, range), sc = scopeFrom(s, view.sel);
    var perSel = sel('rv-period', R.PERIODS.map(function (p) { return { v: p[0], t: p[1] }; }), per, function (e) { view.period = e.target.value; render(); });
    var cf = h('input', { type: 'date', id: 'rv-from', value: custom.from, onchange: function (e) { view.cfrom = e.target.value; render(); } });
    var ct = h('input', { type: 'date', id: 'rv-to', value: custom.to, onchange: function (e) { view.cto = e.target.value; render(); } });
    var tot = rep.total;
    var shown = rep.lines.filter(function (l) { return !l.archived || l.revenueCents || l.expenseCents; });
    var lineRows = shown.map(function (l) { return revRow(s, l, 'line:' + l.id, sc); });
    lineRows.push(revRow(s, rep.unassigned, 'unassigned', sc));
    var totalRow = h('tr', { 'data-total': 'true' }, h('td', { class: 'c-name', text: 'Total' }), h('td', { class: 'c-rev', text: fmtC(s, tot.revenueCents) }), h('td', { class: 'c-exp', text: fmtC(s, tot.expenseCents) }),
      h('td', { class: 'c-net', text: fmtC(s, tot.netCents) }), h('td', { class: 'c-margin', text: R.marginText(tot.marginBp) }), h('td', null, btn('Details', function () { view.sel = 'all'; render(); }, 'sm', { 'aria-label': 'Show details for all money' })));
    lineRows.push(totalRow);
    var rollRows = rep.rollups.map(function (r) { return revRow(s, r, 'rollup:' + r.id, sc); });
    // detail for the chosen scope
    var d = R.totalsIn(s, sc, range.from, range.to), ex = R.expected(s, sc, t), mrows = R.monthly(s, sc, t.slice(0, 7), 12);
    var detail = h('div', { class: 'card', id: 'rev-detail', 'data-scope': scopeKey(sc) },
      h('h2', { text: scopeName(s, sc) }),
      h('div', { class: 'stats' }, stat('Revenue received', fmtC(s, d.revenueCents), 'rd-revenue'), stat('Expenses', fmtC(s, d.expenseCents), 'rd-expenses'), stat('Net', fmtC(s, d.netCents), 'rd-net'), stat('Margin', R.marginText(d.marginBp), 'rd-margin')),
      h('div', { class: 'stats' }, stat('Recurring monthly revenue', fmtC(s, R.recurringMonthlyCents(s, sc)), 'rd-recurring'),
        stat('Expected, next 30 days', fmtC(s, ex.next30Cents), 'rd-n30'), stat('Expected, next 60 days', fmtC(s, ex.next60Cents), 'rd-n60'), stat('Expected, next 90 days', fmtC(s, ex.next90Cents), 'rd-n90')),
      h('div', { class: 'stats' }, stat('Overdue expected income', fmtC(s, ex.overdueCents), 'rd-overdue', ex.overdueCount ? 'bad-t' : ''), stat('Overdue items', String(ex.overdueCount), 'rd-overdue-n')),
      h('h3', { text: 'Last 12 months' }),
      cashflowChart(mrows.map(function (r) { return { month: r.month, incomeCents: r.revenueCents, spendCents: r.expenseCents }; }), cur),
      h('div', { class: 'legend small' }, h('span', { class: 'sw sw-in' }), ' Revenue ', h('span', { class: 'sw sw-out' }), ' Expenses'),
      h('div', { class: 'tablewrap' }, h('table', { id: 'rev-months' },
        h('thead', null, h('tr', null, ['Month', 'Revenue', 'Expenses', 'Net', 'Margin'].map(function (x) { return h('th', { text: x }); }))),
        h('tbody', null, mrows.map(function (r) {
          return h('tr', { 'data-month': r.month }, h('td', { text: monthLabel(r.month) }), h('td', { class: 'c-rev', text: fmtC(s, r.revenueCents) }), h('td', { class: 'c-exp', text: fmtC(s, r.expenseCents) }), h('td', { class: 'c-net', text: fmtC(s, r.netCents) }), h('td', { class: 'c-margin', text: R.marginText(r.marginBp) }));
        })))));
    var items = ex.overdue.concat(ex.upcoming);
    var expCard = h('div', { class: 'card', id: 'rev-expected' }, h('h2', { text: 'Expected income' }),
      h('p', { class: 'mut small', text: 'Expected income is not counted in Money until you mark it received.' }),
      items.length ? items.map(function (x) { return expectedRow(s, x, ['received', 'move', 'writeoff']); }) : h('p', { class: 'mut', text: 'No expected income' + (sc.kind === 'all' ? '.' : ' for this line.') }));
    return h('div', null,
      btn('Back to Work', function () { go('domain', { domain: 'work' }); }, 'sm back'),
      h('div', { class: 'row sp' }, h('h1', { text: 'Revenue' }), lockMark(['entries', 'projects', 'recurring'])),
      h('div', { class: 'card' }, field('Period', perSel), per === 'custom' ? h('div', { class: 'row' }, field('From', cf), field('To', ct)) : null,
        rerr ? h('p', { class: 'small bad-t', role: 'alert', text: rerr }) : null,
        h('p', { class: 'mut small', id: 'rv-range', text: range.from + ' to ' + range.to + '. Only received income is counted.' })),
      h('div', { class: 'stats' }, stat('Revenue received', fmtC(s, tot.revenueCents), 'rv-revenue'), stat('Expenses', fmtC(s, tot.expenseCents), 'rv-expenses'), stat('Net', fmtC(s, tot.netCents), 'rv-net'), stat('Margin', R.marginText(tot.marginBp), 'rv-margin')),
      h('div', { class: 'card' }, h('h2', { text: 'By line of work' }), revTable('rev-lines', lineRows)),
      rollRows.length ? h('div', { class: 'card' }, h('h2', { text: 'Parent rollups' }), h('p', { class: 'mut small', text: 'A parent plus every line under it.' }), revTable('rev-rollups', rollRows)) : null,
      detail, expCard, ledgerCard(s));
  }

  // ---- ledger CSV import ----
  var LEDGER_MODES = [{ v: 'signed', t: 'One amount column (negative or in brackets is an expense)' }, { v: 'split', t: 'Separate income and expense columns' }, { v: 'typed', t: 'An amount column and a type column' }];
  function ledgerGuess(hd, re) { var i = hd.findIndex(function (x) { return re.test(x); }); return i >= 0 ? String(i) : ''; }
  function ledgerStart(parsed) {
    var hd = parsed.headers, g = function (re) { return ledgerGuess(hd, re); };
    ledger = { parsed: parsed, plan: null, create: {}, cfg: { mode: 'signed', date: g(/date/i), amount: g(/amount|total|value/i), income: g(/income|revenue|credit/i), expense: g(/expense|cost|debit/i), type: g(/^type$|kind/i), incomeVal: 'Income', expenseVal: 'Expense',
      line: g(/line|project|client|venture|site|show/i), category: g(/categor/i), description: g(/desc|memo|title|name|note/i), status: g(/status/i), due: g(/due/i), fmt: 'auto' } };
  }
  function ledgerOpts() {
    var c = ledger.cfg, map = {}, num = function (v) { return v === '' || v === undefined ? undefined : Number(v); };
    map.date = num(c.date); map.line = num(c.line); map.category = num(c.category); map.description = num(c.description); map.status = num(c.status); map.due = num(c.due);
    if (c.mode === 'split') { map.income = num(c.income); map.expense = num(c.expense); } else { map.amount = num(c.amount); if (c.mode === 'typed') map.type = num(c.type); }
    var create = Object.keys(ledger.create).filter(function (k) { return ledger.create[k]; });
    return { map: map, dateFormat: c.fmt, typeValues: { income: c.incomeVal, expense: c.expenseVal }, create: create };
  }
  function ledgerRun() {
    return act(function () {
      return L.revenue.plan(ledger.parsed, ledgerOpts(), st(), today()).then(function (pl) { ledger.plan = pl; render(); });
    });
  }
  function ledgerCard(s) {
    var card = h('div', { class: 'card', id: 'ledger-card' }, h('h2', { text: 'Import a ledger CSV' }),
      h('p', { class: 'mut small', text: 'Map the columns, preview, then confirm. Nothing is saved until you confirm, and importing the same file again adds nothing.' }));
    // PV-1: with private entries or lines of work hidden, rows already imported (and moved in) cannot be recognised.
    var pm = L.priv.isOpen() ? [] : L.priv.marks(mainState());
    if (pm.indexOf('entries') >= 0 || pm.indexOf('projects') >= 0) {
      card.appendChild(h('p', { class: 'small', id: 'ledger-locked' }, lockIcon('Some private items are hidden', 'lockmark'), ' Open the private vault to import a ledger. Rows already imported may be private, and they can only be recognised while it is open.'));
      return card;
    }
    var fileIn = h('input', { type: 'file', id: 'ledger-file', accept: '.csv,text/csv' });
    fileIn.addEventListener('change', function () {
      var f = fileIn.files && fileIn.files[0];
      if (!f) return;
      act(function () { return readFile(f).then(function (text) { if (!L.store.isUnlocked()) return; ledgerStart(L.csv.parse(text)); render(); }); });
    });
    card.appendChild(field('CSV file (5 MB max)', fileIn));
    if (!ledger) return card;
    var c = ledger.cfg, hd = ledger.parsed.headers;
    var opts = [{ v: '', t: '(none)' }].concat(hd.map(function (x, i) { return { v: String(i), t: x || ('Column ' + (i + 1)) }; }));
    var pick = function (key, id, label, req) {
      return field(label + (req ? '' : ' (optional)'), sel(id, opts, c[key], function (e) { c[key] = e.target.value; ledger.plan = null; render(); }));
    };
    var txt = function (key, id, label) {
      return field(label, h('input', { type: 'text', id: id, maxlength: '60', value: c[key], onchange: function (e) { c[key] = e.target.value; ledger.plan = null; } }));
    };
    card.appendChild(h('p', { class: 'mut small', id: 'ledger-size', text: hd.length + ' columns, ' + ledger.parsed.rows.length + ' rows.' }));
    card.appendChild(pick('date', 'ledger-date', 'Date column', true));
    card.appendChild(field('Date format', sel('ledger-datefmt', [{ v: 'auto', t: 'YYYY-MM-DD or MM/DD/YYYY' }, { v: 'dmy', t: 'DD/MM/YYYY (or YYYY-MM-DD)' }], c.fmt, function (e) { c.fmt = e.target.value; ledger.plan = null; })));
    card.appendChild(field('Amounts are', sel('ledger-mode', LEDGER_MODES, c.mode, function (e) { c.mode = e.target.value; ledger.plan = null; render(); })));
    if (c.mode === 'split') { card.appendChild(pick('income', 'ledger-income', 'Income column', true)); card.appendChild(pick('expense', 'ledger-expense', 'Expense column', true)); }
    else card.appendChild(pick('amount', 'ledger-amount', 'Amount column', true));
    if (c.mode === 'typed') { card.appendChild(pick('type', 'ledger-type', 'Type column', true)); card.appendChild(txt('incomeVal', 'ledger-income-val', 'Type value that means income')); card.appendChild(txt('expenseVal', 'ledger-expense-val', 'Type value that means expense')); }
    card.appendChild(pick('line', 'ledger-line', 'Line of work column'));
    card.appendChild(pick('category', 'ledger-category', 'Category column'));
    card.appendChild(pick('description', 'ledger-description', 'Description column'));
    card.appendChild(pick('status', 'ledger-status', 'Status column (received, expected or written-off)'));
    card.appendChild(pick('due', 'ledger-due', 'Due date column'));
    card.appendChild(h('div', { class: 'row' }, btn('Preview', function () { ledgerRun(); }, 'pri', { id: 'ledger-preview' }), btn('Cancel', function () { ledger = null; render(); }, null, { id: 'ledger-cancel' })));
    var pl = ledger.plan;
    if (pl) {
      var body = h('div', { id: 'ledger-result' },
        h('p', { id: 'ledger-summary', text: pl.add.length + ' to add, ' + pl.rejected.length + ' rejected, ' + pl.duplicates + ' already imported.' }),
        h('p', { class: 'small', id: 'ledger-totals', text: 'Income ' + fmtC(s, pl.totals.incomeCents) + ', expenses ' + fmtC(s, pl.totals.expenseCents) + ' in the rows to add.' }));
      if (pl.byLine.length) body.appendChild(h('div', { class: 'tablewrap' }, h('table', { id: 'ledger-lines' },
        h('thead', null, h('tr', null, ['Line of work', 'Rows', 'Income', 'Expenses'].map(function (x) { return h('th', { text: x }); }))),
        h('tbody', null, pl.byLine.map(function (g) { return h('tr', { 'data-line': g.line }, h('td', { text: g.line }), h('td', { text: String(g.count) }), h('td', { text: fmtC(s, g.incomeCents) }), h('td', { text: fmtC(s, g.expenseCents) })); })))));
      if (pl.unknownLines.length) {
        body.appendChild(h('p', { class: 'small', id: 'ledger-unknown-h', text: 'These line names are not lines of work yet. Rows for lines you do not create are imported as Unassigned.' }));
        pl.unknownLines.forEach(function (name, i) {
          var key = L.revenue.normName(name);
          body.appendChild(h('label', { class: 'field check' }, h('input', { type: 'checkbox', id: 'ledger-create-' + i, checked: !!ledger.create[key], onchange: function (e) { ledger.create[key] = !!e.target.checked; ledgerRun(); } }), h('span', { text: 'Create "' + name + '" as a new line of work' })));
        });
      }
      if (pl.rejected.length) body.appendChild(h('div', { id: 'ledger-rejected' }, h('p', { class: 'small', text: 'Rejected rows' }),
        h('ul', null, pl.rejected.slice(0, 25).map(function (r) { return h('li', { class: 'small', text: 'Row ' + r.row + ': ' + r.reason }); })),
        pl.rejected.length > 25 ? h('p', { class: 'mut small', text: 'And ' + (pl.rejected.length - 25) + ' more.' }) : null));
      if (!pl.add.length && pl.duplicates) body.appendChild(h('p', { class: 'small', id: 'ledger-nothing', text: 'Nothing new to import: every valid row was already imported.' }));
      body.appendChild(btn(pl.add.length ? 'Import ' + pl.add.length + (pl.add.length === 1 ? ' row' : ' rows') : 'Nothing to import', function () {
        act(function () {
          var res;
          return commit(function (x) { res = L.revenue.applyPlan(x, pl); }, 'ledger import').then(function () {
            ledger = null;
            setNotice('ok', 'Imported ' + res.added + (res.added === 1 ? ' entry' : ' entries') + (res.linesCreated ? ' and created ' + res.linesCreated + (res.linesCreated === 1 ? ' line of work.' : ' lines of work.') : '.'));
            render();
          });
        });
      }, 'pri', { id: 'ledger-confirm', disabled: !pl.add.length }));
      card.appendChild(body);
    }
    return card;
  }

  // ---------- business, invoices and tax (v1.1.0) ----------
  // Every tax view carries the same estimate line (L.tax.NOTICE). While the private vault is closed and holds a business record of the
  // year, no tax figure is computed or shown (L.tax.compute refuses; the views show the lock marker and the refusal sentence).
  var BZ_TABS = [['tax', 'Tax'], ['entries', 'Entries'], ['invoices', 'Invoices'], ['mileage', 'Mileage'], ['payees', 'Payees'], ['budgets', 'Budgets'], ['settings', 'Settings'], ['export', 'Export']];
  function bzYear() { return view.year || Number(today().slice(0, 4)); }
  function cents$(v, o) { return Math.round(parseAmount(v, o) * 100); }
  function optCents$(v) { return String(v == null ? '' : v).trim() === '' ? null : cents$(v, { zero: true }); }
  function dollarText(c) { return c === null || c === undefined ? '' : (c / 100).toFixed(2); }
  function pctText(r) { return r === null || r === undefined ? '' : String(Math.round(r * 1e6) / 1e4); }
  function pctToRate(v, optional) {
    v = String(v == null ? '' : v).trim().replace(/%$/, '');
    if (v === '' && optional) return null;
    if (!/^\d{1,3}(\.\d{1,4})?$/.test(v) || Number(v) > 100) throw new Error('Enter a percentage like 22.5.');
    return Math.round(Number(v) * 1e4) / 1e6;
  }
  function taxNotice() { return h('p', { class: 'small tax-notice', text: L.tax.NOTICE }); }
  function lockedTax() { return h('p', { class: 'warn small tax-blocked', role: 'status' }, lockIcon('Some private items are hidden', 'lockmark'), ' ', L.tax.BLOCK_MESSAGE); }
  function bzYearNav() {
    var y = bzYear();
    return h('div', { class: 'row sp' }, btn('Previous year', function () { view.year = y - 1; render(); }, 'sm', { id: 'bz-year-prev' }), h('strong', { id: 'bz-year', text: String(y) }), btn('Next year', function () { view.year = y + 1; render(); }, 'sm', { id: 'bz-year-next' }));
  }
  function bzGo(tab, extra) { view = Object.assign({ name: 'business', tab: tab, year: view.year }, extra || {}); notice = null; render(); }
  function bzAct(fn, ok, audit) { return act(function () { return commit(fn, audit).then(function () { render(); }); }, ok); }
  function bzLineName(s, id) { return id ? (projName(s, id) || 'Unknown line') : 'No line of work'; }
  function bzMoney(s, c) { return c === null || c === undefined ? '-' : fmtC(s, c); }

  function businessScreen(s) {
    var tab = view.tab || 'tax';
    var tabs = h('div', { class: 'chips bz-tabs', role: 'group', 'aria-label': 'Business sections' }, BZ_TABS.map(function (x) {
      return h('button', { type: 'button', class: 'chipbtn', id: 'bz-tab-' + x[0], 'aria-pressed': x[0] === tab ? 'true' : 'false', text: x[1], onclick: function () { bzGo(x[0]); } });
    }));
    var fn = { tax: bzTax, entries: bzEntries, invoices: bzInvoices, mileage: bzMileage, payees: bzPayees, budgets: bzBudgets, settings: bzSettings, 'export': bzExport }[tab] || bzTax;
    return h('div', { id: 'business' },
      btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'),
      h('div', { class: 'row sp' }, h('h1', { text: 'Business' }), lockMark(['entries', 'projects', 'invoices', 'trips', 'payees', 'taxPayments'])),
      mediaLinks(), bzScopeBanner(s), tabs, fn(s));
  }
  // The migration to schema 12 leaves every entry as it is; the owner confirms the business and personal counts once.
  function bzScopeBanner(s) {
    if (s.settings.business.scopeConfirmed) return null;
    var c = L.business.scopeCounts(s);
    return h('div', { class: 'card', id: 'bz-scope-banner' }, h('h2', { text: 'Confirm business and personal entries' }),
      h('p', { class: 'small', id: 'bz-scope-counts', text: 'Money entries marked business: ' + c.business + '. Marked personal: ' + c.personal + '. An entry on a venture, client, website or podcast line of work is business; everything else is personal. Change any entry under Entries.' }),
      btn('Confirm these', function () { bzAct(function (x) { L.business.confirmScope(x); }, 'Confirmed.', 'scope confirmed'); }, 'pri', { id: 'bz-scope-confirm' }));
  }

  // ---- Tax ----
  function bzTax(s) {
    var y = bzYear(), t = L.tax.compute(s, y), out = [bzYearNav(), taxNotice()];
    if (t.blocked) { out.push(lockedTax()); return out; }
    var p = L.tax.profileOf(s, y);
    if (!p) out.push(bzNoProfile(s, y));
    var rate = function (c) { return c === null || c === undefined ? 'set your rate' : fmtC(s, c); };
    out.push(h('div', { class: 'card', id: 'tx-card' }, h('h2', { text: 'Business profit, ' + y }),
      h('div', { class: 'stats' }, stat('Business income received', fmtC(s, t.incomeCents), 'tx-income'), stat('Deductible expenses', fmtC(s, t.expenseCents), 'tx-expenses'), stat('Mileage deduction', fmtC(s, t.mileageCents), 'tx-mileage'), stat('Home office', fmtC(s, t.homeOfficeCents), 'tx-home')),
      h('div', { class: 'stats' }, stat('Net business profit', fmtC(s, t.profitCents), 'tx-profit')),
      t.homeOfficeLimited ? h('p', { class: 'small', id: 'tx-home-limited', text: 'Home office limited to ' + fmtC(s, t.homeOfficeCents) + ' of ' + fmtC(s, t.homeOfficeFullCents) + ': it cannot exceed business income less other business expenses.' }) : null,
      t.unratedTrips ? h('p', { class: 'small', id: 'tx-unrated', text: t.unratedTrips + ' trip' + (t.unratedTrips === 1 ? ' has' : 's have') + ' no mileage rate for its date: set your rate. They deduct nothing.' }) : null,
      t.unmapped.count ? h('p', { class: 'small', id: 'tx-unmapped', text: 'Unmapped: ' + t.unmapped.count + ' business expense' + (t.unmapped.count === 1 ? '' : 's') + ' totalling ' + fmtC(s, t.unmapped.cents) + ' have no tax line. They are counted in full. Map their categories under Settings.' }) : null));
    if (p) {
      var se = t.se;
      out.push(h('div', { class: 'card', id: 'tx-est' }, h('h2', { text: 'Estimated tax, ' + y }),
        h('div', { class: 'stats' }, stat('Self-employment tax', fmtC(s, se.totalCents), 'tx-se'), stat('Social Security part', fmtC(s, se.ssCents), 'tx-ss'), stat('Medicare part', fmtC(s, se.medicareCents), 'tx-medicare'), stat('Additional Medicare', fmtC(s, se.addlCents), 'tx-addl')),
        h('div', { class: 'stats' }, stat('Half of SE tax, Social Security and Medicare parts only (reduces the federal income tax base)', fmtC(s, se.deductionCents), 'tx-half'), stat('Federal income tax base', fmtC(s, t.incomeBaseCents), 'tx-base'), stat('Federal income tax', rate(t.federalTaxCents), 'tx-fed'), stat('NJ income tax base (no SE deduction)', fmtC(s, t.njBaseCents), 'tx-nj-base'), stat('NJ income tax', rate(t.njTaxCents), 'tx-nj')),
        se.belowMinimum ? h('p', { class: 'small', id: 'tx-se-min', text: 'Net earnings are under ' + fmtC(s, p.seMinNetEarningsCents) + ': no self-employment tax.' }) : null,
        h('div', { class: 'stats' }, stat('Set aside to date', rate(t.setAsideCents), 'tx-setaside'), stat('Reserve account balance', t.reserveHidden ? 'hidden while the private vault is closed' : t.reserveCents === null ? 'no reserve account chosen' : fmtC(s, t.reserveCents), 'tx-reserve'),
          stat('Set-aside gap', t.setAsideCents === null ? 'set your rate' : t.reserveHidden ? 'hidden while the private vault is closed' : t.gapCents === null ? 'no reserve account chosen' : fmtC(s, t.gapCents), 'tx-gap')),
        h('div', { class: 'stats' }, stat('Federal paid', fmtC(s, t.payments.federal), 'tx-paid-fed'), stat('NJ paid', fmtC(s, t.payments.nj), 'tx-paid-nj'))));
      out.push(bzSafeCard(s, t), bzPaymentsCard(s, y, t));
    }
    out.push(bzScheduleC(s, t));
    if (p) out.push(bzProfileForm(s, y, p));
    return out;
  }
  function bzNoProfile(s, y) {
    var prop = null;
    try { prop = L.tax.proposeYear(s, y); } catch (e) { prop = null; }
    var def = L.tax.defaultProfile(y);
    return h('div', { class: 'card', id: 'tx-noprofile' }, h('h2', { text: 'No ' + y + ' tax profile yet' }),
      h('p', { class: 'small', text: 'Rates, thresholds, dates and holidays live in a profile for the year. Nothing is estimated until you start one. Effective income tax rates are yours to enter; until then the views say "set your rate".' }),
      def ? btn('Start the ' + y + ' defaults', function () { bzAct(function (x) { L.tax.startDefaultYear(x, y); }, 'Profile started. Check each figure and enter your rates.', 'tax profile started'); }, 'pri', { id: 'pf-start' }) : null,
      prop ? h('div', null, h('p', { class: 'small', id: 'pf-offer', text: 'Copy the ' + (L.tax.years(s).filter(function (v) { return v < y; }).pop()) + ' profile forward? It is offered, not applied: dates move one year and nothing else changes until you edit it.' }),
        btn('Copy the earlier profile', function () { bzAct(function (x) { L.tax.applyNewYear(x, y); }, 'Profile copied. Check every figure.', 'tax profile copied'); }, 'pri', { id: 'pf-copy' })) : null);
  }
  function bzSafeCard(s, t) {
    var sh = t.safeHarbor, rows = [];
    function add(name, x) {
      if (!x) return;
      rows.push({ cells: [name, fmtC(s, x.priorBasedCents), x.currentBasedCents === null ? 'set your rate' : fmtC(s, x.currentBasedCents), fmtC(s, x.targetCents)].concat(x.installments.map(function (c) { return fmtC(s, c); }), [fmtC(s, x.paidCents), fmtC(s, x.remainingCents)]) });
    }
    add('Federal', sh.federal); add('NJ', sh.nj);
    if (!rows.length) return h('div', { class: 'card', id: 'tx-safe' }, h('h2', { text: 'Safe-harbor targets' }), h('p', { class: 'mut small', text: 'Shown once you enter last year\'s federal or NJ tax in the profile below.' }));
    return h('div', { class: 'card', id: 'tx-safe' }, h('h2', { text: 'Safe-harbor targets' }), tbl('safe-table', ['', 'Prior year basis', 'Current year basis', 'Target', 'Q1', 'Q2', 'Q3', 'Q4', 'Paid', 'Remaining'], rows));
  }
  function bzPaymentsCard(s, y, t) {
    var jur = sel('pay-juris', [{ v: 'federal', t: 'Federal' }, { v: 'nj', t: 'NJ' }], 'federal');
    var q = sel('pay-q', [1, 2, 3, 4].map(function (n) { return { v: String(n), t: 'Quarter ' + n }; }), '1');
    var amt = h('input', { type: 'text', id: 'pay-amount', inputmode: 'decimal', maxlength: '14' });
    var on = h('input', { type: 'date', id: 'pay-date', value: today(), required: true });
    var conf = h('input', { type: 'text', id: 'pay-conf', maxlength: '100' });
    var due = [];
    ['federal', 'nj'].forEach(function (j) { t.due[j].forEach(function (d) { due.push({ cells: [j === 'nj' ? 'NJ' : 'Federal', 'Quarter ' + d.quarter, d.nominal === d.date ? d.date : d.date + ' (moved from ' + d.nominal + ')', fmtC(s, t.payments.byQuarter[j][d.quarter - 1])] }); }); });
    due.push({ cells: ['1099-NEC filing', '', t.due.nec1099.nominal === t.due.nec1099.date ? t.due.nec1099.date : t.due.nec1099.date + ' (moved from ' + t.due.nec1099.nominal + ')', ''] });
    var list = (s.taxPayments || []).filter(function (p) { return p.year === y; }).sort(function (a, b) { return a.paidOn.localeCompare(b.paidOn); });
    return h('div', { class: 'card', id: 'tx-pay' }, h('h2', { text: 'Estimated payments and due dates' }),
      tbl('due-table', ['For', 'Quarter', 'Due', 'Paid so far'], due),
      list.map(function (p) {
        return h('div', ROW({ class: 'item' }, 'taxPayments', p), h('div', null, h('div', { class: 'entry-t', text: (p.jurisdiction === 'nj' ? 'NJ' : 'Federal') + ' quarter ' + p.quarter + ': ' + fmtC(s, p.amountCents) }), h('div', { class: 'mut small', text: 'Paid ' + p.paidOn + (p.confirmation ? ' | ' + p.confirmation : '') })),
          btn('Delete', function () { bzAct(function (x) { L.tax.deletePayment(x, p.id); }, 'Payment removed.', 'tax payment delete'); }, 'sm bad', { 'aria-label': 'Delete payment of ' + fmtC(s, p.amountCents) }));
      }),
      h('form', { onsubmit: function (e) {
        e.preventDefault();
        bzAct(function (x) { L.tax.addPayment(x, { year: y, jurisdiction: jur.value, quarter: Number(q.value), amountCents: cents$(amt.value), paidOn: on.value, confirmation: conf.value.trim() }); }, 'Payment logged.', 'tax payment add');
      } }, field('For', jur), field('Quarter', q), field('Amount', amt), field('Paid on', on), field('Confirmation (optional)', conf), h('button', { type: 'submit', class: 'btn pri', text: 'Log payment' })));
  }
  function bzScheduleC(s, t) {
    var rows = [{ cells: ['Gross receipts', '1', fmtC(s, t.incomeCents)] }];
    t.lines.forEach(function (l) { rows.push({ cat: l.id, cells: [l.label, l.sc, fmtC(s, l.cents)] }); });
    rows.push({ cat: 'unmapped', cells: ['Unmapped expenses', '', fmtC(s, t.unmapped.cents)] },
      { cat: 'total', cells: ['Total deductions', '', fmtC(s, t.expenseCents + t.mileageCents + t.homeOfficeCents)] }, { cat: 'profit', cells: ['Net profit', '31', fmtC(s, t.profitCents)] },
      { cat: 'reimbursed', cells: ['Reimbursed expenses (information only, already counted in full)', '', fmtC(s, t.reimbursedCents)] });
    var lw = t.byLineOfWork, lr = function (r) { return { cells: [bzLineName(s, r.projectId), fmtC(s, r.incomeCents), fmtC(s, r.expenseCents), fmtC(s, r.mileageCents), fmtC(s, r.homeOfficeCents), fmtC(s, r.netCents)] }; };
    var heads = ['Line of work', 'Income', 'Expenses', 'Mileage', 'Home office', 'Net'];
    return h('div', { class: 'card', id: 'tx-sc' }, h('h2', { text: 'Schedule C summary, ' + t.year }),
      tbl('sc-table', ['Line', 'Schedule C', 'Amount'], rows),
      h('h3', { text: 'By line of work' }), h('p', { class: 'mut small', text: 'Each line of work is shown on its own so your accountant can decide whether it belongs on the same Schedule C. The app makes no such decision.' }),
      tbl('sc-lines', heads, lw.lines.map(lr)),
      lw.rollups.length ? [h('h3', { text: 'By parent rollup' }), tbl('sc-rollups', heads, lw.rollups.map(lr))] : null);
  }
  var PF_PCT = [['federalEffectiveRate', 'Federal effective income tax rate (%)', true], ['njEffectiveRate', 'NJ effective income tax rate (%)', true], ['ssRate', 'Social Security rate (%)'], ['medicareRate', 'Medicare rate (%)'], ['addlMedicareRate', 'Additional Medicare rate (%)'], ['seFactor', 'Share of profit subject to SE tax (%)']];
  var PF_USD = [['ssWageBase', 'Social Security wage base ($)'], ['otherSsEarningsCents', 'W-2 wages already counted for Social Security and Medicare ($)'], ['seMinNetEarningsCents', 'No SE tax when net earnings are under ($)'], ['addlMedicareThreshold', 'Additional Medicare threshold ($)'], ['homeOfficeRate', 'Home office rate ($ per square foot)'], ['nec1099Threshold', '1099-NEC threshold ($)'], ['priorYearFederalTax', 'Prior-year federal tax ($, optional)', true], ['priorYearNjTax', 'Prior-year NJ tax ($, optional)', true]];
  var PF_INT = [['homeOfficeMaxSqFt', 'Home office square-foot cap'], ['mealsPct', 'Meals deductible (%)'], ['seDeductionPct', 'Share of SE tax that reduces the income tax base (%)']];
  var PF_SAFE = [['federalCurrentPct', 'Safe harbor, federal: share of current-year estimate (%)'], ['federalPriorPct', 'Safe harbor, federal: share of prior-year tax (%)'], ['federalPriorHighPct', 'Safe harbor, federal: share of prior-year tax with the AGI flag (%)'], ['njCurrentPct', 'Safe harbor, NJ: share of current-year tax (%)'], ['njPriorPct', 'Safe harbor, NJ: share of prior-year tax (%)']];
  function bzProfileForm(s, y, p) {
    var f = {};
    f.fs = sel('pf-filing', L.tax.FILING.map(function (k) { return { v: k, t: L.tax.FILING_LABEL[k] }; }), p.filingStatus, function (e) {
      var old = L.tax.THRESHOLD_BY_STATUS[p.filingStatus];
      if (cents$(f.addlMedicareThreshold.value, { zero: true }) === old || true) f.addlMedicareThreshold.value = dollarText(L.tax.THRESHOLD_BY_STATUS[e.target.value]);
    });
    var inputs = [field('Filing status', f.fs)];
    function box(k, label, val, opt) { f[k] = h('input', { type: 'text', id: 'pf-' + k, value: val, maxlength: '20', inputmode: 'decimal' }); inputs.push(field(label, f[k])); }
    PF_PCT.forEach(function (x) { box(x[0], x[1], pctText(p[x[0]])); });
    PF_USD.forEach(function (x) { box(x[0], x[1], dollarText(p[x[0]])); });
    PF_INT.forEach(function (x) { box(x[0], x[1], String(p[x[0]])); });
    PF_SAFE.forEach(function (x) { box(x[0], x[1], String(p.safeHarbor[x[0]])); });
    f.agi = h('input', { type: 'checkbox', id: 'pf-priorYearAgiOver150k', checked: p.priorYearAgiOver150k });
    inputs.push(h('label', { class: 'field check' }, f.agi, h('span', { text: 'Use the higher prior-year percentage (prior-year AGI flag)' })));
    f.nec = h('input', { type: 'date', id: 'pf-nec1099Due', value: p.nec1099Due }); inputs.push(field('1099-NEC filing date before any weekend or holiday move', f.nec));
    f.fd = p.dueDates.federal.map(function (d, i) { return h('input', { type: 'date', id: 'pf-fed' + (i + 1), value: d }); });
    f.nd = p.dueDates.nj.map(function (d, i) { return h('input', { type: 'date', id: 'pf-nj' + (i + 1), value: d }); });
    f.fd.forEach(function (n, i) { inputs.push(field('Federal estimate date, quarter ' + (i + 1), n)); });
    f.nd.forEach(function (n, i) { inputs.push(field('NJ estimate date, quarter ' + (i + 1), n)); });
    f.hol = h('textarea', { id: 'pf-holidays', rows: '4', maxlength: '2000' }); f.hol.value = p.holidays.join('\n');
    f.mil = h('textarea', { id: 'pf-mileage', rows: '3', maxlength: '2000' }); f.mil.value = p.mileageRates.map(function (r) { return r.from + ', ' + r.centsPerMile + (r.note ? ', ' + r.note : ''); }).join('\n');
    f.note = h('textarea', { id: 'pf-note', rows: '3', maxlength: '1200' }); f.note.value = p.sourceNote;
    inputs.push(field('Holidays (one date per line; a due date on one moves to the next business day)', f.hol), field('Mileage rates (one per line: start date, cents per mile, note)', f.mil), field('Source note', f.note));
    return details('pf-card', 'Tax profile for ' + y + ' (rates, thresholds, dates)', [
      h('p', { class: 'mut small', id: 'pf-source', text: p.sourceNote }),
      h('form', { id: 'pf-form', onsubmit: function (e) {
        e.preventDefault();
        bzAct(function (x) {
          var o = { filingStatus: f.fs.value, safeHarbor: {}, dueDates: { federal: f.fd.map(function (n) { return n.value; }), nj: f.nd.map(function (n) { return n.value; }) } };
          PF_PCT.forEach(function (k) { o[k[0]] = pctToRate(f[k[0]].value, k[2]); });
          o.seRate = Math.round((Math.round(o.ssRate * 1e6) + Math.round(o.medicareRate * 1e6))) / 1e6;
          PF_USD.forEach(function (k) { o[k[0]] = k[2] ? optCents$(f[k[0]].value) : cents$(f[k[0]].value, { zero: true }); });
          PF_INT.forEach(function (k) { o[k[0]] = intIn(f[k[0]].value, 0, 100000, k[1]); });
          PF_SAFE.forEach(function (k) { o.safeHarbor[k[0]] = intIn(f[k[0]].value, 0, 1000, k[1]); });
          o.priorYearAgiOver150k = !!f.agi.checked; o.nec1099Due = f.nec.value;
          o.holidays = f.hol.value.split(/\s+/).filter(Boolean);
          o.mileageRates = f.mil.value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
            var q = l.split(','); if (q.length < 2) throw new Error('A mileage rate line needs a start date and cents per mile.');
            var r = { from: q[0].trim(), centsPerMile: Number(q[1].trim()) }; if (q.slice(2).join(',').trim()) r.note = q.slice(2).join(',').trim(); return r;
          });
          o.sourceNote = f.note.value;
          L.tax.setProfile(x, y, o);
        }, 'Profile saved.', 'tax profile saved');
      } }, inputs, h('button', { type: 'submit', class: 'btn pri', id: 'pf-save', text: 'Save profile' }))], view.open === 'pf');
  }

  // ---- Entries: business or personal, billable, reimbursable, payee ----
  function bzEntries(s) {
    var y = bzYear(), biz = L.business.isBiz(s), ents = s.entries.filter(function (e) { return e.domain === 'money' && (e.type === 'income' || e.type === 'expense') && e.date.slice(0, 4) === String(y); })
      .sort(function (a, b) { return b.date.localeCompare(a.date); });
    var shown = view.shown || 40, payees = (s.payees || []).filter(function (x) { return !x.archived; });
    var rows = ents.slice(0, shown).map(function (e) {
      var isB = biz(e), kids = [];
      kids.push(btn(isB ? 'Make personal' : 'Make business', function () { bzAct(function (x) { L.business.setScope(x, [e.id], isB ? 'personal' : 'business'); }, 'Updated.', 'entry scope'); }, 'sm', { 'aria-label': (isB ? 'Make personal: ' : 'Make business: ') + e.title }));
      if (e.type === 'expense') {
        kids.push(btn(e.billable ? 'Billable: on' : 'Billable: off', function () { bzAct(function (x) { x.entries.forEach(function (z) { if (z.id === e.id) { if (z.billedInvoiceId && z.billable) throw new Error('It is already on an invoice.'); if (z.billable) delete z.billable; else z.billable = true; } }); }, 'Updated.', 'entry billable'); }, 'sm', { 'aria-pressed': e.billable ? 'true' : 'false', 'aria-label': 'Toggle billable: ' + e.title }));
        kids.push(btn(e.reimbursable ? 'Reimbursable: on' : 'Reimbursable: off', function () { bzAct(function (x) { x.entries.forEach(function (z) { if (z.id === e.id) { if (z.reimbursable) delete z.reimbursable; else z.reimbursable = true; } }); }, 'Updated.', 'entry reimbursable'); }, 'sm', { 'aria-pressed': e.reimbursable ? 'true' : 'false', 'aria-label': 'Toggle reimbursable: ' + e.title }));
        var ps = sel(null, [{ v: '', t: '(no payee)' }].concat(payees.map(function (x) { return { v: x.id, t: x.name }; })), e.payeeId || '', function (ev) { var v = ev.target.value; bzAct(function (x) { L.business.assignPayee(x, e.id, v); }, 'Updated.', 'entry payee'); });
        ps.setAttribute('aria-label', 'Payee for ' + e.title); ps.setAttribute('name', 'payee-' + e.id);
        kids.push(ps);
        if (e.payeeId) kids.push(btn(e.cardPaid ? 'Card payment: on' : 'Card payment: off', function () { bzAct(function (x) { L.business.assignPayee(x, e.id, e.payeeId, { cardPaid: !e.cardPaid }); }, 'Updated.', 'entry card paid'); }, 'sm', { 'aria-pressed': e.cardPaid ? 'true' : 'false', 'aria-label': 'Toggle card payment: ' + e.title }));
      }
      var line = L.tax.lineFor(s, e.category);
      return h('div', ROW({ class: 'item', 'data-scope': isB ? 'business' : 'personal' }, 'entries', e), h('div', null, h('div', { class: 'entry-t', text: e.title }),
        h('div', { class: 'mut small', text: e.date + ' | ' + (e.type === 'income' ? 'Income ' : 'Expense ') + fmtC(s, L.metrics.cents(e.value)) + ' | ' + (isB ? 'Business' : 'Personal') + (e.type === 'expense' && isB ? ' | ' + (line ? L.tax.lineById(line).label : 'Unmapped') : '') + (e.status ? ' | ' + e.status : '') })),
        h('div', { class: 'row' }, kids));
    });
    return [bzYearNav(), h('div', { class: 'card', id: 'bz-entries' }, h('h2', { text: 'Money entries, ' + y }), h('p', { class: 'mut small', text: 'Business entries count toward the tax figures. Income counts when it is received. Billable and reimbursable expenses are shown gross: the invoice counts as income when received and the expense is deducted on its own line.' }),
      rows.length ? rows : h('p', { class: 'mut', text: 'No money entries this year.' }), ents.length > shown ? btn('Show more', function () { view.shown = shown + 40; render(); }) : null)];
  }

  // ---- Invoices ----
  function bzInvoices(s) {
    if (view.invoiceId) { var inv = (s.invoices || []).filter(function (x) { return x.id === view.invoiceId; })[0]; if (inv) return bzInvoiceDetail(s, inv); }
    var t = today(), ag = L.business.aging(s, t), tot = L.business.invoiceTotal;
    var aging = h('div', { class: 'card', id: 'inv-aging' }, h('h2', { text: 'Receivables' }), h('div', { class: 'stats' }, stat('Open invoices', String(ag.openCount), 'inv-open-n'), stat('Open total', fmtC(s, ag.openCents), 'inv-open-total'), stat('Overdue', String(ag.overdueCount), 'inv-overdue-n', ag.overdueCount ? 'bad-t' : ''), stat('Overdue total', fmtC(s, ag.overdueCents), 'inv-overdue-total')),
      tbl('inv-aging-table', ['Age past due', 'Invoices', 'Total'], L.business.BUCKETS.map(function (b) { return { cat: b[0], cells: [b[1], String(ag.buckets[b[0]].count), fmtC(s, ag.buckets[b[0]].cents)] }; })));
    var line = sel('iv-line', lineOptions(s, '(no line of work)'), ''), issue = h('input', { type: 'date', id: 'iv-issue', value: t, required: true }), due = h('input', { type: 'date', id: 'iv-due', value: addDays(t, 30), required: true });
    var num = h('input', { type: 'text', id: 'iv-number', maxlength: '40', placeholder: 'Next number: ' + safeNext(s, t) }), notes = h('input', { type: 'text', id: 'iv-notes', maxlength: '200' });
    var ld = h('input', { type: 'text', id: 'iv-desc', maxlength: '200' }), lq = h('input', { type: 'text', id: 'iv-qty', value: '1', inputmode: 'decimal', maxlength: '9' }), lu = h('input', { type: 'text', id: 'iv-unit', inputmode: 'decimal', maxlength: '14' });
    var form = h('form', { id: 'iv-form', onsubmit: function (e) {
      e.preventDefault();
      var made = null;
      act(function () {
        var lines = [];
        if (ld.value.trim()) lines.push({ description: ld.value.trim(), qty: Number(lq.value), unitCents: cents$(lu.value, { zero: true }) });
        return commit(function (x) { made = L.business.createInvoice(x, { projectId: line.value || undefined, issueDate: issue.value, dueDate: due.value, number: num.value.trim(), lines: lines, notes: notes.value.trim() }); }, 'invoice add').then(function () { setNotice('ok', 'Invoice added as a draft.'); bzGo('invoices', { invoiceId: made.id }); });
      });
    } }, field('Line of work (client)', line), field('Issue date', issue), field('Due date', due), field('Invoice number (blank uses your format)', num), field('First line description (optional)', ld), field('Quantity', lq), field('Unit price', lu), field('Notes (optional)', notes), h('button', { type: 'submit', class: 'btn pri', text: 'Add invoice' }));
    var list = (s.invoices || []).slice().sort(function (a, b) { return b.issueDate.localeCompare(a.issueDate) || b.number.localeCompare(a.number); });
    var rows = list.map(function (i) {
      return h('div', ROW({ class: 'item', 'data-invoice': i.number }, 'invoices', i), h('div', null, h('div', { class: 'entry-t', text: i.number + ' | ' + fmtC(s, tot(i)) }),
        h('div', { class: 'mut small' }, bzLineName(s, i.projectId) + ' | issued ' + i.issueDate + ' | due ' + i.dueDate + ' | ', chipEl(i.status, i.status === 'paid' ? 'ok' : i.status === 'sent' && i.dueDate < t ? 'bad' : ''))),
        h('div', { class: 'row' }, btn('Open', function () { bzGo('invoices', { invoiceId: i.id }); }, 'sm', { 'aria-label': 'Open invoice ' + i.number })));
    });
    return [aging, h('div', { class: 'card' }, h('h2', { text: 'New invoice' }), form), h('div', { class: 'card', id: 'inv-list' }, h('h2', { text: 'Invoices (' + list.length + ')' }), rows.length ? rows : h('p', { class: 'mut', text: 'No invoices yet.' }))];
  }
  function safeNext(s, t) { try { return L.business.nextNumber(s, t).number; } catch (e) { return ''; } }
  function bzInvoiceDetail(s, inv) {
    var total = L.business.invoiceTotal(inv), t = today(), draft = inv.status === 'draft';
    var income = inv.incomeId ? s.entries.filter(function (e) { return e.id === inv.incomeId; })[0] : null;
    var lineRows = inv.lines.map(function (l, i) {
      return h('div', { class: 'item' }, h('div', null, h('div', { class: 'entry-t', text: l.description }), h('div', { class: 'mut small', text: l.qty + ' x ' + fmtC(s, l.unitCents) + ' = ' + fmtC(s, L.business.lineTotal(l)) })),
        draft ? btn('Remove line', function () { bzAct(function (x) { var v = x.invoices.filter(function (z) { return z.id === inv.id; })[0]; var ls = v.lines.slice(); ls.splice(i, 1); L.business.editDraft(x, inv.id, { lines: ls }); }, 'Line removed.', 'invoice line remove'); }, 'sm bad', { 'aria-label': 'Remove line ' + l.description }) : null);
    });
    var ld = h('input', { type: 'text', id: 'il-desc', maxlength: '200' }), lq = h('input', { type: 'text', id: 'il-qty', value: '1', inputmode: 'decimal', maxlength: '9' }), lu = h('input', { type: 'text', id: 'il-unit', inputmode: 'decimal', maxlength: '14' });
    var addLine = draft ? h('form', { id: 'il-form', onsubmit: function (e) {
      e.preventDefault();
      bzAct(function (x) { var v = x.invoices.filter(function (z) { return z.id === inv.id; })[0]; L.business.editDraft(x, inv.id, { lines: v.lines.concat([{ description: ld.value.trim(), qty: Number(lq.value), unitCents: cents$(lu.value, { zero: true }) }]) }); }, 'Line added.', 'invoice line add');
    } }, field('Description', ld), field('Quantity', lq), field('Unit price', lu), h('button', { type: 'submit', class: 'btn', text: 'Add line' })) : null;
    var avail = draft ? L.business.unbilled(s, inv.projectId || null) : [];
    var bill = draft ? h('div', { class: 'card', id: 'inv-billable' }, h('h3', { text: 'Unbilled billable expenses' }), avail.length ? avail.map(function (e) {
      return h('div', { class: 'item' }, h('div', null, h('div', { class: 'entry-t', text: e.title }), h('div', { class: 'mut small', text: e.date + ' | ' + fmtC(s, L.metrics.cents(e.value)) })),
        btn('Add to invoice', function () { bzAct(function (x) { L.business.addBillable(x, inv.id, e.id); }, 'Added. The expense keeps its own deduction.', 'invoice expense add'); }, 'sm', { 'aria-label': 'Add ' + e.title + ' to invoice' }));
    }) : h('p', { class: 'mut small', text: 'None for this line of work.' })) : null;
    var acts = [];
    if (draft) acts.push(btn('Mark sent', function () { bzAct(function (x) { L.business.markSent(x, inv.id); }, 'Marked sent.', 'invoice sent'); }, 'pri', { id: 'inv-sent' }));
    if (inv.status === 'sent' || draft) acts.push(btn('Mark paid', function () { markPaidDialog(inv); }, inv.status === 'sent' ? 'pri' : '', { id: 'inv-paid' }));
    if (inv.status === 'draft' || inv.status === 'sent') acts.push(btn('Void', function () { openDialog({ title: 'Void invoice ' + inv.number + '?', yes: 'Void', danger: true, body: h('p', { class: 'mut', text: 'Its income entry is unlinked, never deleted. Billed expenses become unbilled again.' }), onYes: function () { return commit(function (x) { L.business.voidInvoice(x, inv.id); }, 'invoice void').then(render); } }); }, 'bad', { id: 'inv-void' }));
    if (inv.status === 'draft' || inv.status === 'void') acts.push(btn('Delete', function () { openDialog({ title: 'Delete invoice ' + inv.number + '?', yes: 'Delete', danger: true, body: h('p', { class: 'mut', text: 'Billed expenses become unbilled again.' }), onYes: function () { return commit(function (x) { L.business.deleteInvoice(x, inv.id); }, 'invoice delete').then(function () { bzGo('invoices'); }); } }); }, 'bad', { id: 'inv-delete' }));
    acts.push(btn('Print view', function () { go('print', { kind: 'invoice', id: inv.id, from: 'invoices' }); }, '', { id: 'inv-print' }));
    // offers: nothing posts without a tap
    var offers = [];
    if (inv.status === 'sent' && !income && total > 0) offers.push(h('div', { class: 'card', id: 'inv-offer-income' }, h('p', { class: 'small', text: 'Offer: create one expected income entry of ' + fmtC(s, total) + ' due ' + inv.dueDate + '. It is not counted until it is received.' }),
      btn('Create expected income', function () { bzAct(function (x) { L.business.createExpectedIncome(x, inv.id); }, 'Expected income created.', 'invoice expected income'); }, 'pri', { id: 'inv-make-income' })));
    if (inv.status === 'paid' && !(income && income.type === 'income' && (!income.status || income.status === 'received')) && total > 0) offers.push(h('div', { class: 'card', id: 'inv-offer-received' }, h('p', { class: 'small', text: 'Offer: count ' + fmtC(s, total) + ' as business income received on ' + inv.paidOn + '. Income counts once, when it is received.' }),
      btn('Mark income received', function () { bzAct(function (x) { L.business.settleIncome(x, inv.id); }, 'Income counted.', 'invoice income received'); }, 'pri', { id: 'inv-settle' })));
    return h('div', { id: 'inv-detail', 'data-status': inv.status },
      btn('Back to invoices', function () { bzGo('invoices'); }, 'sm back'),
      h('div', { class: 'card' }, h('h2', { text: 'Invoice ' + inv.number }), h('p', { class: 'mut small', text: bzLineName(s, inv.projectId) + ' | issued ' + inv.issueDate + ' | due ' + inv.dueDate + (inv.paidOn ? ' | paid ' + inv.paidOn : '') }),
        h('div', { class: 'row' }, chipEl(inv.status, inv.status === 'paid' ? 'ok' : ''), h('strong', { id: 'inv-total', text: fmtC(s, total) })),
        inv.incomeId ? h('p', { class: 'mut small', id: 'inv-income-note', text: income ? 'Linked income entry: ' + (income.status || 'received') + '.' : 'The linked income entry no longer exists.' }) : null,
        lineRows.length ? lineRows : h('p', { class: 'mut', text: 'No lines yet.' }), addLine, h('div', { class: 'row' }, acts)),
      offers, bill);
  }
  function markPaidDialog(inv) {
    var d = h('input', { type: 'date', id: 'ip-date', value: today(), required: true });
    openDialog({ title: 'Mark invoice ' + inv.number + ' paid', yes: 'Mark paid', body: field('Date paid', d), onYes: function () { return commit(function (x) { L.business.markPaid(x, inv.id, d.value); }, 'invoice paid').then(render); } });
  }

  // ---- Mileage and home office ----
  function bzMileage(s) {
    var y = bzYear(), t = L.tax.compute(s, y), p = L.tax.profileOf(s, y);
    if (t.blocked) return [bzYearNav(), taxNotice(), lockedTax()];
    var trips = (s.trips || []).filter(function (x) { return x.date.slice(0, 4) === String(y); }).sort(function (a, b) { return b.date.localeCompare(a.date); });
    var d = h('input', { type: 'date', id: 'tr-date', value: today(), required: true }), from = h('input', { type: 'text', id: 'tr-from', maxlength: '120' }), to = h('input', { type: 'text', id: 'tr-to', maxlength: '120' });
    var mi = h('input', { type: 'text', id: 'tr-miles', inputmode: 'decimal', maxlength: '8' }), rt = h('input', { type: 'checkbox', id: 'tr-round' }), why = h('input', { type: 'text', id: 'tr-purpose', maxlength: '200' }), ln = sel('tr-line', lineOptions(s, '(no line of work)'), '');
    var rows = trips.map(function (x) {
      var c = p ? L.tax.tripCents(p, x) : null;
      return h('div', ROW({ class: 'item' }, 'trips', x), h('div', null, h('div', { class: 'entry-t', text: x.date + ': ' + x.miles + ' mi' + (x.roundTrip ? ' (round trip)' : '') }), h('div', { class: 'mut small', text: (x.from || '-') + ' to ' + (x.to || '-') + (x.purpose ? ' | ' + x.purpose : '') + ' | ' + (c === null ? 'no mileage rate: set your rate' : fmtC(s, c)) })),
        btn('Delete', function () { bzAct(function (z) { L.business.deleteTrip(z, x.id); }, 'Trip removed.', 'trip delete'); }, 'sm bad', { 'aria-label': 'Delete trip on ' + x.date }));
    });
    var ho = (s.homeOffice || {})[String(y)] || { squareFeet: 0, monthsUsed: 0 };
    var sq = h('input', { type: 'text', id: 'ho-sqft', inputmode: 'numeric', value: String(ho.squareFeet), maxlength: '6' }), mo = h('input', { type: 'text', id: 'ho-months', inputmode: 'numeric', value: String(ho.monthsUsed), maxlength: '2' });
    return [bzYearNav(), taxNotice(),
      h('div', { class: 'card', id: 'mi-card' }, h('h2', { text: 'Mileage log, ' + y }), h('div', { class: 'stats' }, stat('Trips', String(t.tripCount), 'mi-count'), stat('Mileage deduction', fmtC(s, t.mileageCents), 'mi-total')),
        !p ? h('p', { class: 'small', id: 'mi-norate', text: 'Start the ' + y + ' tax profile to price trips: set your rate.' }) : (!p.mileageRates.length ? h('p', { class: 'small', id: 'mi-norate', text: 'The profile has no mileage rate: set your rate. Trips deduct nothing until then.' }) : null),
        h('p', { class: 'mut small', text: 'Trip text stays in the vault only. Each trip is priced by the rate period that contains its date.' }),
        rows.length ? rows : h('p', { class: 'mut', text: 'No trips this year.' }),
        h('form', { id: 'tr-form', onsubmit: function (e) {
          e.preventDefault();
          bzAct(function (x) { L.business.addTrip(x, { date: d.value, from: from.value.trim(), to: to.value.trim(), miles: mi.value, purpose: why.value.trim(), projectId: ln.value || undefined, roundTrip: rt.checked }); }, 'Trip logged.', 'trip add');
        } }, field('Date', d), field('From', from), field('To', to), field('Miles (one decimal)', mi), h('label', { class: 'field check' }, rt, h('span', { text: 'Round trip (counts the miles twice)' })), field('Purpose', why), field('Line of work (optional)', ln), h('button', { type: 'submit', class: 'btn pri', text: 'Log trip' }))),
      h('div', { class: 'card', id: 'ho-card' }, h('h2', { text: 'Home office, simplified method, ' + y }),
        p ? h('p', { class: 'mut small', text: 'Rate ' + fmtC(s, p.homeOfficeRate) + ' per square foot, up to ' + p.homeOfficeMaxSqFt + ' square feet, from the profile.' }) : h('p', { class: 'small', text: 'Start the ' + y + ' tax profile for the rate and the square-foot cap.' }),
        h('div', { class: 'stats' }, stat('Home office deduction', fmtC(s, t.homeOfficeCents), 'ho-result')),
        h('form', { id: 'ho-form', onsubmit: function (e) {
          e.preventDefault();
          bzAct(function (x) { L.business.setHomeOffice(x, y, { squareFeet: intIn(sq.value, 0, 100000, 'Square feet'), monthsUsed: intIn(mo.value, 0, 12, 'Months used') }); }, 'Home office saved.', 'home office saved');
        } }, field('Square feet used for business', sq), field('Months used (0 to 12)', mo), h('button', { type: 'submit', class: 'btn pri', id: 'ho-save', text: 'Save home office' })))];
  }

  // ---- Payees (1099-NEC) ----
  function bzPayees(s) {
    var y = bzYear(), pt = L.tax.payeeTotals(s, y);
    var out = [bzYearNav(), taxNotice()];
    if (pt.blocked) { out.push(lockedTax()); return out; }
    var nm = h('input', { type: 'text', id: 'pe-name', maxlength: '120' }), w9 = h('input', { type: 'checkbox', id: 'pe-w9' }), w9d = h('input', { type: 'date', id: 'pe-w9date' });
    var byId = {}; pt.rows.forEach(function (r) { byId[r.payeeId] = r; });
    var rows = (s.payees || []).filter(function (x) { return !x.archived; }).map(function (x) {
      var r = byId[x.id] || { totalCents: 0, cardCents: 0, reaches: false };
      return h('div', ROW({ class: 'item', 'data-payee-total': String(r.totalCents) }, 'payees', x), h('div', null, h('div', { class: 'entry-t', text: x.name }),
        h('div', { class: 'mut small' }, 'Year total ' + fmtC(s, r.totalCents) + (r.cardCents ? ' (card payments ' + fmtC(s, r.cardCents) + ' excluded)' : '') + ' | W-9 ' + (x.tinOnFile ? (x.w9Date || 'on file') : 'not on file') + ' ', r.reaches ? chipEl('At or over the threshold', 'bad') : null)),
        h('div', { class: 'row' }, btn(x.tinOnFile ? 'W-9: on file' : 'W-9: not on file', function () { bzAct(function (z) { L.business.updatePayee(z, x.id, { tinOnFile: !x.tinOnFile }); }, 'Updated.', 'payee w9'); }, 'sm', { 'aria-pressed': x.tinOnFile ? 'true' : 'false', 'aria-label': 'Toggle W-9 for ' + x.name }),
          btn('Delete', function () { openDialog({ title: 'Delete ' + x.name + '?', yes: 'Delete', danger: true, body: h('p', { class: 'mut', text: 'Their expenses are kept and unlinked.' }), onYes: function () { return commit(function (z) { L.business.deletePayee(z, x.id); }, 'payee delete').then(render); } }); }, 'sm bad', { 'aria-label': 'Delete payee ' + x.name })));
    });
    out.push(h('div', { class: 'card', id: 'pe-card' }, h('h2', { text: '1099-NEC payees, ' + y }),
      pt.hasProfile ? h('p', { class: 'small', id: 'pe-threshold', text: 'Threshold ' + fmtC(s, pt.thresholdCents) + '. Filing reminder ' + pt.due.date + (pt.due.date !== pt.due.nominal ? ' (moved from ' + pt.due.nominal + ')' : '') + '.' }) : h('p', { class: 'small', text: 'Start the ' + y + ' tax profile for the threshold.' }),
      h('p', { class: 'mut small', text: 'A payee\'s tax ID is never stored, only whether a W-9 is on file. Pay with a card? Mark the expense as a card payment so it is left out of the 1099 total.' }),
      rows.length ? rows : h('p', { class: 'mut', text: 'No payees yet.' }),
      h('form', { id: 'pe-form', onsubmit: function (e) {
        e.preventDefault();
        bzAct(function (x) { L.business.addPayee(x, { name: nm.value, tinOnFile: w9.checked, w9Date: w9d.value || undefined }); }, 'Payee added.', 'payee add');
      } }, field('Name', nm), h('label', { class: 'field check' }, w9, h('span', { text: 'A W-9 is on file' })), field('W-9 date (optional)', w9d), h('button', { type: 'submit', class: 'btn pri', text: 'Add payee' }))));
    return out;
  }

  // ---- Budgets ----
  function bzBudgets(s) {
    var t = today(), lines = liveLines(s), cur = s.settings.currency;
    var ln = sel('bd-line', lineOptions(s, '(choose a line)'), ''), amt = h('input', { type: 'text', id: 'bd-amount', inputmode: 'decimal', maxlength: '14' }), per = sel('bd-period', [{ v: 'month', t: 'Per month' }, { v: 'project', t: 'For the project' }], 'month');
    var stateText = function (b) { return b.budgetCents === null ? 'no budget' : fmtC(s, b.actualCents) + ' of ' + fmtC(s, b.budgetCents) + (b.period === 'month' ? ' this month' : ' to date'); };
    var rows = lines.filter(function (p) { return p.budgetCents !== undefined; }).map(function (p) {
      var b = L.business.budgetFor(s, p.id, t);
      return h('div', ROW({ class: 'item', 'data-budget-status': b.status }, 'projects', p), h('div', null, h('div', { class: 'entry-t', text: p.name }), h('div', { class: 'small ' + (b.status === 'over' ? 'bad-t' : 'mut'), text: stateText(b) })), btn('Remove budget', function () { bzAct(function (x) { L.business.setBudget(x, p.id, 0); }, 'Budget removed.', 'budget remove'); }, 'sm', { 'aria-label': 'Remove budget for ' + p.name }));
    });
    var roll = lines.filter(function (p) { return !p.parentId && (s.projects || []).some(function (k) { return k.parentId === p.id; }); }).map(function (p) {
      var b = L.business.budgetRollup(s, p.id, t);
      return h('div', { class: 'item', 'data-rollup': p.id, 'data-budget-status': b.status }, h('div', null, h('div', { class: 'entry-t', text: p.name + ' (with the lines under it)' }), h('div', { class: 'small ' + (b.status === 'over' ? 'bad-t' : 'mut'), text: stateText(b) })));
    });
    var un = lines.map(function (p) { return { p: p, items: L.business.unbilled(s, p.id) }; }).filter(function (x) { return x.items.length; });
    var drafts = (s.invoices || []).filter(function (i) { return i.status === 'draft'; });
    return [h('div', { class: 'card', id: 'bd-card' }, h('h2', { text: 'Project budgets' }), h('p', { class: 'mut small', text: 'Actual is the line\'s expenses: this month for a monthly budget, all time for a project budget. Over budget changes the colour only.' }),
      rows.length ? rows : h('p', { class: 'mut', text: 'No budgets yet.' }), roll.length ? [h('h3', { text: 'Parent rollups' }), roll] : null,
      h('form', { id: 'bd-form', onsubmit: function (e) { e.preventDefault(); bzAct(function (x) { if (!ln.value) throw new Error('Choose a line of work.'); L.business.setBudget(x, ln.value, cents$(amt.value, { zero: true }), per.value); }, 'Budget saved.', 'budget set'); } },
        field('Line of work', ln), field('Budget (0 removes it)', amt), field('Period', per), h('button', { type: 'submit', class: 'btn pri', text: 'Save line budget' }))),
      h('div', { class: 'card', id: 'bd-unbilled' }, h('h2', { text: 'Unbilled billable expenses' }), un.length ? un.map(function (x) {
        var ds = drafts.filter(function (i) { return !i.projectId || i.projectId === x.p.id; });
        return h('div', null, h('h3', { text: x.p.name }), x.items.map(function (e) {
          var pick = sel(null, ds.map(function (i) { return { v: i.id, t: i.number }; }), ds.length ? ds[0].id : '');
          pick.setAttribute('aria-label', 'Draft invoice for ' + e.title); pick.setAttribute('name', 'bd-draft-' + e.id);
          return h('div', { class: 'item' }, h('div', null, h('div', { class: 'entry-t', text: e.title }), h('div', { class: 'mut small', text: e.date + ' | ' + fmtC(s, L.metrics.cents(e.value)) })),
            ds.length ? h('div', { class: 'row' }, pick, btn('Add to invoice', function () { bzAct(function (z) { L.business.addBillable(z, pick.value, e.id); }, 'Added to the invoice.', 'invoice expense add'); }, 'sm', { 'aria-label': 'Add ' + e.title + ' to the chosen invoice' })) : h('span', { class: 'mut small', text: 'Add a draft invoice first.' }));
        }));
      }) : h('p', { class: 'mut', text: 'Nothing waiting to be billed.' }))];
  }

  // ---- Settings: business details, invoice numbers, reserve account, pinned line, tax line map ----
  function bzSettings(s) {
    var b = s.settings.business;
    var nm = h('input', { type: 'text', id: 'bs-name', value: b.name, maxlength: '120' }), ad = h('textarea', { id: 'bs-address', rows: '3', maxlength: '300' }), tm = h('textarea', { id: 'bs-terms', rows: '2', maxlength: '300' });
    ad.value = b.address; tm.value = b.paymentTerms;
    var fm = h('input', { type: 'text', id: 'bs-format', value: b.invoiceFormat, maxlength: '40' }), nx = h('input', { type: 'text', id: 'bs-next', value: String(b.invoiceNext), inputmode: 'numeric', maxlength: '10' });
    var accts = (s.accounts || []).filter(function (a) { return !a.archived && !a.liability; });
    var rs = sel('bs-reserve', [{ v: '', t: '(none)' }].concat(accts.map(function (a) { return { v: a.id, t: a.name }; })), b.reserveAccountId || '');
    var pn = sel('bs-pinned', lineOptions(s, '(none)'), b.pinnedProjectId || '');
    var cats = (s.categories.expense || []), lineOpts = [{ v: '', t: '(default by name)' }].concat(L.tax.MAPPABLE.map(function (id) { return { v: id, t: L.tax.lineById(id).label }; }));
    var missing = L.tax.DEFAULT_CATEGORY_LINES.filter(function (x) { return !cats.some(function (c) { return c.toLowerCase() === x[0].toLowerCase(); }); });
    var maps = cats.map(function (c) {
      var cur = (s.taxMap || []).filter(function (x) { return x.category.toLowerCase() === c.toLowerCase(); })[0];
      var ls = sel(null, lineOpts, cur ? cur.line : '', function (e) { var v = e.target.value; bzAct(function (x) { L.tax.setLineMap(x, c, v); }, 'Mapping saved.', 'tax line map'); });
      ls.setAttribute('aria-label', 'Tax line for ' + c); ls.setAttribute('name', 'map-' + c);
      var eff = L.tax.lineFor(s, c);
      return h('div', { class: 'item' }, h('div', null, h('div', { class: 'entry-t', text: c }), h('div', { class: 'mut small', text: eff ? 'Schedule C: ' + L.tax.lineById(eff).label : 'Unmapped in tax views' })), ls);
    });
    return [h('div', { class: 'card', id: 'bs-card' }, h('h2', { text: 'Business details and invoices' }),
      h('form', { id: 'bs-form', onsubmit: function (e) {
        e.preventDefault();
        bzAct(function (x) { L.business.saveSettings(x, { name: nm.value, address: ad.value, paymentTerms: tm.value, invoiceFormat: fm.value, invoiceNext: intIn(nx.value, 1, 1e9, 'Next invoice number'), reserveAccountId: rs.value, pinnedProjectId: pn.value }); }, 'Saved.', 'business settings');
      } }, field('Business name', nm), field('Address', ad), field('Payment terms', tm), field('Invoice number format ({YYYY}, {YY}, {NNNN} for the counter)', fm), field('Next counter', nx),
        field('Tax reserve account', rs), field('Pinned line of work (dashboard budget module)', pn), h('button', { type: 'submit', class: 'btn pri', id: 'bs-save', text: 'Save business settings' }))),
      h('div', { class: 'card', id: 'bs-map' }, h('h2', { text: 'Expense categories and Schedule C lines' }),
        h('p', { class: 'mut small', text: 'Car and truck and the home office come from their logs only. A business expense whose category has no line shows as Unmapped in tax views and is still counted.' }),
        missing.length ? btn('Add the business categories', function () { bzAct(function (x) { missing.forEach(function (m) { if (x.categories.expense.length < 50) x.categories.expense.push(m[0]); }); }, 'Categories added.', 'business categories'); }, '', { id: 'bs-addcats' }) : null,
        maps)];
  }

  // ---- Export ----
  // SEC-78: private records stay out of the file unless "Include private records" is ticked (default off, offered only while the vault is open).
  function bzExport(s) {
    var y = bzYear(), inc = !!view.exPriv && L.priv.isOpen(), pkg = L.tax.exportPackage(s, y, inc), out = [bzYearNav(), taxNotice()];
    var tick = L.priv.isOpen() ? h('label', { class: 'field check' }, h('input', { type: 'checkbox', id: 'ex-private', checked: inc, onchange: function (e) { view.exPriv = e.target.checked; render(); } }), h('span', { text: 'Include private records' })) : null;
    if (pkg.blocked) { out.push(tick, pkg.leftOut ? h('p', { class: 'warn small', id: 'ex-left-out', role: 'status' }, lockIcon('Some private items are hidden', 'lockmark'), ' ', pkg.message) : lockedTax()); return out; }
    out.push(h('div', { class: 'card', id: 'ex-card' }, h('h2', { text: 'Year-end accountant package, ' + y }),
      h('p', { class: 'warn small', id: 'ex-warning', text: L.tax.EXPORT_WARNING }), tick,
      h('p', { class: 'small', id: 'ex-private-note', text: pkg.privateIncluded ? 'Private records are included in this file.' : 'Private records are not included. No business record of this year is private, so the totals are complete.' }),
      h('p', { class: 'mut small', text: pkg.income.length + ' income entries, ' + pkg.expenses.length + ' expenses, ' + pkg.trips.length + ' trips, ' + pkg.payees.length + ' payees, ' + pkg.payments.length + ' payments. The file goes to your device only. Nothing is sent anywhere.' }),
      h('div', { class: 'row' }, btn('Download CSV', function () {
        openDialog({ title: 'Download an unencrypted file?', yes: 'Download', body: h('p', { id: 'ex-confirm-text', text: L.tax.EXPORT_WARNING }), onYes: function () {
          var again = L.tax.exportPackage(st(), y, inc && L.priv.isOpen());
          if (again.blocked) throw new Error(again.message || L.tax.BLOCK_MESSAGE);
          download('lifeos-accountant-' + y + '.csv', L.tax.exportCsv(again, function (id) { return id ? projName(st(), id) : 'No line of work'; }), 'text/csv');
        } });
      }, 'pri', { id: 'ex-download' }), btn('Open print view', function () { go('print', { kind: 'tax', year: y, from: 'export', includePrivate: inc }); }, '', { id: 'ex-print' }))));
    return out;
  }

  // ---- print views (no network; the browser prints to PDF) ----
  function printScreen(s) {
    if (view.kind === 'recovery' && L.recoveryUI) return L.recoveryUI.sheet(recCtx(), view);
    if (view.kind === 'guide' && L.guideUI) return L.guideUI.view(recCtx());
    var back = btn('Back', function () { if (view.kind === 'invoice') bzGo('invoices', { invoiceId: view.id }); else bzGo('export', { year: view.year }); }, 'sm back noprint', { id: 'pv-back' });
    var pbtn = btn('Print', function () { window.print(); }, 'pri noprint', { id: 'pv-print' });
    if (view.kind === 'invoice') {
      var inv = (s.invoices || []).filter(function (x) { return x.id === view.id; })[0];
      if (!inv) return h('div', null, back, h('p', { text: 'That invoice no longer exists.' }));
      var b = s.settings.business, total = L.business.invoiceTotal(inv);
      return h('div', { class: 'printview', id: 'print-invoice' }, h('div', { class: 'row noprint' }, back, pbtn),
        h('h1', { text: 'Invoice ' + inv.number }), h('p', { class: 'pv-from' }, h('strong', { text: b.name || 'Your business' }), h('br'), b.address),
        h('p', { text: 'Bill to: ' + (inv.projectId ? bzLineName(s, inv.projectId) : '') }), h('p', { text: 'Issued ' + inv.issueDate + '. Due ' + inv.dueDate + '.' + (inv.paidOn ? ' Paid ' + inv.paidOn + '.' : '') }),
        tbl('pv-lines', ['Description', 'Quantity', 'Unit price', 'Amount'], inv.lines.map(function (l) { return { cells: [l.description, String(l.qty), fmtC(s, l.unitCents), fmtC(s, L.business.lineTotal(l))] }; })),
        h('p', null, h('strong', { id: 'pv-total', text: 'Total ' + fmtC(s, total) })), b.paymentTerms ? h('p', { text: 'Payment terms: ' + b.paymentTerms }) : null, inv.notes ? h('p', { text: inv.notes }) : null);
    }
    var y = view.year || bzYear(), pkg = L.tax.exportPackage(s, y, !!view.includePrivate && L.priv.isOpen());
    if (pkg.blocked) return h('div', { class: 'printview' }, h('div', { class: 'row noprint' }, back), taxNotice(), pkg.leftOut ? h('p', { class: 'warn small', role: 'status', text: pkg.message }) : lockedTax());
    var t = pkg.summary, rows = [{ cells: ['Gross receipts', fmtC(s, t.incomeCents)] }].concat(t.lines.map(function (l) { return { cells: [l.label, fmtC(s, l.cents)] }; }), [{ cells: ['Unmapped expenses', fmtC(s, t.unmapped.cents)] }, { cells: ['Net profit', fmtC(s, t.profitCents)] }, { cells: ['Reimbursed expenses (information only)', fmtC(s, t.reimbursedCents)] }]);
    return h('div', { class: 'printview', id: 'print-tax' }, h('p', { class: 'warn small', id: 'pv-warning', text: L.tax.EXPORT_WARNING }), h('div', { class: 'row noprint' }, back, pbtn), h('h1', { text: 'Accountant package, ' + y }), taxNotice(), h('p', { class: 'small', id: 'pv-private', text: pkg.privateIncluded ? 'Private records are included.' : 'Private records are not included (none of this year).' }),
      h('h2', { text: 'Schedule C summary' }), tbl('pv-sc', ['Line', 'Amount'], rows),
      h('h2', { text: 'By line of work' }), tbl('pv-lw', ['Line of work', 'Income', 'Expenses', 'Mileage', 'Home office', 'Net'], t.byLineOfWork.lines.concat(t.byLineOfWork.rollups).map(function (r) { return { cells: [bzLineName(s, r.projectId) + (t.byLineOfWork.rollups.indexOf(r) >= 0 ? ' (rollup)' : ''), fmtC(s, r.incomeCents), fmtC(s, r.expenseCents), fmtC(s, r.mileageCents), fmtC(s, r.homeOfficeCents), fmtC(s, r.netCents)] }; })),
      h('h2', { text: '1099-NEC payees' }), tbl('pv-payees', ['Payee', 'Total', 'Card payments', 'W-9'], pkg.payees.map(function (x) { return { cells: [x.name, fmtC(s, x.totalCents), fmtC(s, x.cardCents), x.w9] }; })),
      h('h2', { text: 'Mileage log' }), tbl('pv-trips', ['Date', 'From', 'To', 'Miles', 'Purpose', 'Deduction'], pkg.trips.map(function (x) { return { cells: [x.date, x.from, x.to, String(x.miles), x.purpose, x.cents === null ? 'no rate' : fmtC(s, x.cents)] }; })),
      h('h2', { text: 'Estimated payments' }), tbl('pv-pay', ['For', 'Quarter', 'Amount', 'Paid on'], pkg.payments.map(function (x) { return { cells: [x.jurisdiction === 'nj' ? 'NJ' : 'Federal', String(x.quarter), fmtC(s, x.amountCents), x.paidOn] }; })));
  }

  // ---- dashboard modules ----
  function bzModLock(title) { return h('div', { class: 'card' }, h('h2', { text: title }), lockedTax()); }
  function taxSetAsideMod(s) {
    var y = Number(today().slice(0, 4)), t = L.tax.compute(s, y);
    if (t.blocked) return bzModLock('Tax set-aside');
    if (!t.hasProfile) return h('div', { class: 'card', id: 'mod-taxset' }, h('h2', { text: 'Tax set-aside' }), h('p', { class: 'mut small', text: 'No ' + y + ' tax profile yet.' }), btn('Open Business', function () { go('business'); }, 'sm'));
    return h('div', { class: 'card', id: 'mod-taxset' }, h('h2', { text: 'Tax set-aside' }),
      h('div', { class: 'stats' }, stat('Set aside to date', t.setAsideCents === null ? 'set your rate' : fmtC(s, t.setAsideCents), 'mod-setaside'), stat('Reserve', t.reserveHidden ? 'hidden while the private vault is closed' : t.reserveCents === null ? 'no reserve account' : fmtC(s, t.reserveCents), 'mod-reserve'), stat('Gap', t.gapCents === null ? '-' : fmtC(s, t.gapCents), 'mod-gap')), taxNotice());
  }
  function taxNextMod(s) {
    var t = today(), best = null, blockedAny = false;
    L.tax.years(s).forEach(function (y) {
      var c = L.tax.compute(s, y);
      if (c.blocked) { if (y >= Number(t.slice(0, 4)) - 1) blockedAny = true; return; }
      ['federal', 'nj'].forEach(function (j) { c.due[j].forEach(function (d) { if (d.date >= t && c.payments.byQuarter[j][d.quarter - 1] === 0 && (!best || d.date < best.date)) best = { date: d.date, j: j, q: d.quarter, y: y }; }); });
    });
    // SEC-81: a refused year could hold an earlier unpaid date, so the module refuses rather than show a later one as "next".
    if (blockedAny) return bzModLock('Next estimated payment');
    return h('div', { class: 'card', id: 'mod-taxnext' }, h('h2', { text: 'Next estimated payment' }), best ? h('p', { id: 'mod-taxnext-date', text: best.date + ': ' + (best.j === 'nj' ? 'NJ' : 'Federal') + ' quarter ' + best.q + ' of ' + best.y }) : h('p', { class: 'mut small', text: 'No unpaid estimate dates ahead.' }), taxNotice());
  }
  function invOpenMod(s) {
    var ag = L.business.aging(s, today());
    return h('div', { class: 'card', id: 'mod-inv' }, h('h2', null, 'Open invoices ', lockMark(['invoices'])), h('div', { class: 'stats' }, stat('Open', String(ag.openCount), 'mod-inv-n'), stat('Total', fmtC(s, ag.openCents), 'mod-inv-total'), stat('Overdue', String(ag.overdueCount), 'mod-inv-overdue')),
      L.business.BUCKETS.map(function (b) { return h('p', { class: 'mut small', text: b[1] + ': ' + ag.buckets[b[0]].count + ' (' + fmtC(s, ag.buckets[b[0]].cents) + ')' }); }), btn('Open invoices', function () { bzGo('invoices'); }, 'sm'));
  }
  function budgetPinnedMod(s) {
    var id = s.settings.business.pinnedProjectId, p = id ? (s.projects || []).filter(function (x) { return x.id === id; })[0] : null;
    if (!p) return h('div', { class: 'card', id: 'mod-budget' }, h('h2', null, 'Budget vs actual ', lockMark(['projects'])), h('p', { class: 'mut small', text: 'Pin a line of work under Business, Settings.' }));
    var b = L.business.budgetFor(s, p.id, today());
    return h('div', { class: 'card', id: 'mod-budget', 'data-budget-status': b.status }, h('h2', null, 'Budget: ' + p.name + ' ', lockMark(['entries', 'projects'])), b.budgetCents === null ? h('p', { class: 'mut small', text: 'No budget set.' }) : h('p', { class: b.status === 'over' ? 'bad-t' : '', text: fmtC(s, b.actualCents) + ' of ' + fmtC(s, b.budgetCents) + (b.period === 'month' ? ' this month' : ' to date') }));
  }
  function payeesNearMod(s) {
    var y = Number(today().slice(0, 4)), pt = L.tax.payeeTotals(s, y);
    if (pt.blocked) return bzModLock('1099 payees');
    var nm = {}; (s.payees || []).forEach(function (x) { nm[x.id] = x.name; });
    return h('div', { class: 'card', id: 'mod-payees' }, h('h2', { text: '1099 payees, ' + y }), pt.hasProfile ? null : h('p', { class: 'mut small', text: 'No ' + y + ' tax profile yet.' }),
      pt.rows.slice(0, 5).map(function (r) { return h('p', { class: r.reaches ? 'bad-t small' : 'small', text: nm[r.payeeId] + ': ' + fmtC(s, r.totalCents) + (pt.hasProfile ? ' of ' + fmtC(s, pt.thresholdCents) : '') }); }), pt.rows.length ? null : h('p', { class: 'mut small', text: 'No payees with payments this year.' }));
  }

  // ---------- boot ----------
  // ---------- AYiN and clients, Podcasts and Websites (v1.7.0) ----------
  // Manual entry first. Every write goes through commit/actDo (so private routing applies), every text goes in with textContent, and every
  // figure that is not known reads "no data". Numbers of different measures are never added together on any screen here.
  var CL_STATUS = { active: 'Active', paused: 'Paused', past: 'Past' };
  var EP_STATUS_LABEL = { idea: 'Idea', booked: 'Booked', recorded: 'Recorded', edited: 'Edited', published: 'Published' };
  var MEASURE_LABEL = { views: 'Views', downloads: 'Downloads', listens: 'Listens', reads: 'Reads', subscribers: 'Subscribers', followers: 'Followers' };
  var FORMAT_LABEL = { video: 'Video', audio: 'Audio', text: 'Text' };
  var PURPOSE_LABEL = { business: 'Business', show: 'Show', personal: 'Personal', other: 'Other' };
  function mxInp(id, v, max, type, extra) {
    return h('input', Object.assign({ type: type || 'text', id: id, maxlength: max ? String(max) : null, value: v === undefined || v === null ? '' : String(v), autocomplete: 'off' }, extra || {}));
  }
  function mxNum(n) { return n === null || n === undefined ? 'no data' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function mxMoney(s, c) { return c === null || c === undefined ? 'no data' : fmtC(s, c); }
  // SEC-119: the line already chosen stays in the list even when archived, so saving the form never drops it unasked.
  function mxLineOpts(s, cur) { return [{ v: '', t: '(none)' }].concat((s.projects || []).filter(function (p) { return !p.archived || p.id === cur; }).map(function (p) { return { v: p.id, t: p.name + (p.archived ? ' (archived)' : '') }; })); }
  function mxName(list, id, key) { var x = (list || []).filter(function (r) { return r.id === id; })[0]; return x ? x[key || 'name'] : ''; }
  function mxTa(id, v, max) { var t = h('textarea', { id: id, maxlength: String(max || 2000) }); t.value = v || ''; return t; }
  function mxAct(run, audit, ok, extra) { actDo({ run: run, audit: audit, from: extra }, ok); }

  // ---- AYiN and clients ----
  function clientFields(s, c, idp) {
    var name = mxInp(idp + 'name', c && c.name, 200), status = sel(idp + 'status', Object.keys(CL_STATUS).map(function (k) { return { v: k, t: CL_STATUS[k] }; }), c ? c.status : 'active');
    var line = sel(idp + 'line', mxLineOpts(s, c && c.projectId), (c && c.projectId) || ''), budget = mxInp(idp + 'budget', c && typeof c.budgetCents === 'number' ? dollarsText(c.budgetCents) : '', 20), notes = mxTa(idp + 'notes', c && c.notes);
    return { nodes: [field('Name', name), field('Status', status), field('Line of work (optional)', line), field('Budget in dollars (optional)', budget), field('Notes (optional)', notes, 'Do not enter ID numbers, account numbers or passwords.')],
      read: function () { return { name: name.value, status: status.value, projectId: line.value, budget: budget.value.trim(), notes: notes.value }; } };
  }
  function clientEditDialog(s, c) {
    var f = clientFields(s, c, 'ce-');
    openDialog({ title: 'Edit client', yes: 'Save', body: [h('div', { class: 'form' }, f.nodes), movePrivBtn('clients', c)],
      onYes: function () { var input = f.read(); return commit(function (x) { L.clients.updateClient(x, c.id, input); }, 'client edit').then(function () { setNotice('ok', 'Client saved.'); render(); }); } });
  }
  function clientPeople(s, c, t) {
    var kids = [], linked = {};
    (c.personIds || []).forEach(function (pid) {
      var p = (s.people || []).filter(function (x) { return x.id === pid; })[0];
      if (!p) return;
      linked[pid] = true;
      kids.push(h('div', { class: 'row cl-person', 'data-person': p.name }, chipEl(p.name, 'cl-person-name'),
        btn('Log contact', function () { mxAct(function (y) { L.clients.logContact(y, c.id, pid, t); }, 'client contact', 'Contact logged.'); }, 'sm pri cl-log', { 'aria-label': 'Log contact with ' + p.name }),
        btn('Unlink', function () { mxAct(function (y) { L.clients.unlinkPerson(y, c.id, pid); }, 'client person unlink', 'Unlinked. Nothing was deleted.'); }, 'sm cl-unlink', { 'aria-label': 'Unlink ' + p.name + ' from ' + c.name })));
    });
    var avail = (s.people || []).filter(function (p) { return !p.archived && !linked[p.id]; });
    if (avail.length) {
      var pick = sel(null, avail.map(function (p) { return { v: p.id, t: p.name }; }), avail[0].id);
      pick.setAttribute('aria-label', 'Person to link to ' + c.name);
      kids.push(h('div', { class: 'row' }, pick, btn('Link person', function () { mxAct(function (y) { L.clients.linkPerson(y, c.id, pick.value); }, 'client person link', 'Linked.'); }, 'sm cl-link', { 'aria-label': 'Link the chosen person to ' + c.name })));
    }
    return h('div', { class: 'cl-people' }, kids);
  }
  function clientInvoices(s, c) {
    var mine = (s.invoices || []).filter(function (i) { return i.clientId === c.id; }), free = (s.invoices || []).filter(function (i) { return !i.clientId && i.status !== 'void'; }), kids = [];
    mine.forEach(function (i) {
      kids.push(h('div', { class: 'row small cl-inv', 'data-number': i.number }, h('span', { text: 'Invoice ' + i.number + ', ' + i.status + ', ' + fmtC(s, L.business.invoiceTotal(i)) }),
        btn('Unlink', function () { mxAct(function (y) { L.clients.setInvoiceClient(y, i.id, ''); }, 'client invoice unlink', 'Unlinked. The invoice is unchanged.'); }, 'sm cl-inv-unlink', { 'aria-label': 'Unlink invoice ' + i.number + ' from ' + c.name })));
    });
    if (free.length) {
      var pick = sel(null, free.map(function (i) { return { v: i.id, t: 'Invoice ' + i.number + ' (' + i.status + ')' }; }), free[0].id);
      pick.setAttribute('aria-label', 'Invoice to link to ' + c.name);
      kids.push(h('div', { class: 'row' }, pick, btn('Link invoice', function () { mxAct(function (y) { L.clients.setInvoiceClient(y, pick.value, c.id); }, 'client invoice link', 'Invoice linked.'); }, 'sm cl-inv-link', { 'aria-label': 'Link the chosen invoice to ' + c.name })));
    }
    return h('div', { class: 'cl-invoices' }, kids);
  }
  function clientCard(s, c, t) {
    var C = L.clients, st = C.clientStats(s, c, t), fl = C.flags(s, c, t, st), line = mxName(s.projects, c.projectId);
    var rev = st.revenueCents === null ? 'no data' : fmtC(s, st.revenueCents) + (st.basis === 'line' ? ' (income on its line of work)' : ' (paid invoices)');
    var bud = st.budget ? 'Budget ' + fmtC(s, st.budget.budgetCents) + ', spent ' + mxMoney(s, st.budget.actualCents) + (st.budget.remainingCents === null ? ' (choose a line of work to count spending)' : ', remaining ' + fmtC(s, st.budget.remainingCents)) : 'No budget set';
    return h('div', ROW({ class: 'card cl-card', 'data-client': c.name, 'data-status': c.status }, 'clients', c),
      h('div', { class: 'row sp' }, h('h3', { class: 'entry-t', text: c.name }), h('span', { class: 'row' }, chipEl(CL_STATUS[c.status], 'cl-status'), line ? chipEl(line, 'cl-line') : null,
        fl.overdueInvoice ? chipEl('Overdue invoice', 'bad cl-flag-inv') : null, fl.noContact ? chipEl('No recent contact', 'bad cl-flag-contact') : null)),
      h('div', { class: 'stats' }, stat('Revenue to date', rev, null), stat('Open invoices', st.openCount + ' (' + fmtC(s, st.openCents) + ')', null), stat('Overdue invoices', st.overdueCount + ' (' + fmtC(s, st.overdueCents) + ')', null, st.overdueCount ? 'bad-t' : ''),
        stat('Last contact', st.lastContact ? st.lastContact + ' (' + st.daysSinceContact + (st.daysSinceContact === 1 ? ' day ago)' : ' days ago)') : 'no contact yet', null)),
      h('p', { class: 'small cl-budget', text: bud }), st.partial ? h('p', { class: 'mut small', text: 'Some of this covers archived years only in part.' }) : null,
      c.notes ? h('p', { class: 'small mut', text: c.notes }) : null,
      clientPeople(s, c, t), clientInvoices(s, c),
      h('div', { class: 'row' }, btn('Edit', function () { clientEditDialog(s, c); }, 'sm cl-edit', { 'aria-label': 'Edit ' + c.name }),
        btn('Delete', function () {
          openDialog({ title: 'Delete this client?', yes: 'Delete', danger: true, body: [h('p', { class: 'mut', text: c.name }), h('p', { class: 'small', text: 'Its invoices, people and line of work are kept; only the links to this client are removed.' })],
            onYes: function () { return commit(function (x) { L.clients.deleteClient(x, c.id); }, 'client delete').then(function () { render(); }); } });
        }, 'sm bad cl-del', { 'aria-label': 'Delete ' + c.name })));
  }
  function clientsRollupCard(s, t) {
    var C = L.clients, r = C.rollup(s, t), y = Number(t.slice(0, 4)), tx = L.tax.compute(s, y);
    var tbody = r.lines.map(function (l) { return { cat: l.name, cells: [l.name, fmtC(s, l.month.revenueCents), fmtC(s, l.quarter.revenueCents), fmtC(s, l.year.revenueCents)] }; });
    var taxBlock = tx.blocked ? lockedTax() : !tx.hasProfile ? h('p', { class: 'mut small', id: 'cl-tax-none', text: 'No ' + y + ' tax profile yet. Open Business to start one.' })
      : h('div', null, h('div', { class: 'stats' }, stat('Tax set-aside to date', tx.setAsideCents === null ? 'set your rate' : fmtC(s, tx.setAsideCents), 'cl-setaside')), taxNotice());
    return h('div', { class: 'card', id: 'cl-rollup' }, h('h2', null, 'AYiN Advisors ', lockMark(['entries', 'projects', 'invoices'])),
      h('p', { class: 'mut small', text: 'The business lines of work you already track. Revenue is counted income; nothing is re-entered here.' }),
      h('div', { class: 'stats' }, stat('Revenue this month', fmtC(s, r.totals.month.revenueCents), 'cl-rev-month'), stat('Revenue this quarter', fmtC(s, r.totals.quarter.revenueCents), 'cl-rev-quarter'), stat('Revenue this year', fmtC(s, r.totals.year.revenueCents), 'cl-rev-year')),
      h('div', { class: 'stats' }, stat('Invoices open', r.invoices.openCount + ' (' + fmtC(s, r.invoices.openCents) + ')', 'cl-inv-open'), stat('Invoices overdue', r.invoices.overdueCount + ' (' + fmtC(s, r.invoices.overdueCents) + ')', 'cl-inv-overdue', r.invoices.overdueCount ? 'bad-t' : '')),
      r.partial ? h('p', { class: 'mut small', id: 'cl-partial', text: 'Some totals cover archived years only in part.' }) : null,
      r.lines.length ? tbl('cl-lines', ['Line of work', 'Month', 'Quarter', 'Year'], tbody) : h('p', { class: 'mut', id: 'cl-nolines', text: 'No business lines of work yet. Add one under Work, then open Revenue.' }),
      r.budgets.length ? [h('h3', { text: 'Budget against spending' }), tbl('cl-budgets', ['Line of work', 'Budget', 'Spent', 'Remaining'], r.budgets.map(function (b) { return { cat: b.name, cells: [b.name, fmtC(s, b.budgetCents), fmtC(s, b.actualCents), fmtC(s, b.remainingCents)] }; }))] : null,
      h('h3', { text: 'Tax set-aside' }), taxBlock,
      h('div', { class: 'row' }, btn('Open Revenue', function () { go('domain', { domain: 'work', revenue: true }); }, 'sm', { id: 'cl-open-revenue' }), btn('Open Business', function () { go('business'); }, 'sm', { id: 'cl-open-business' })));
  }
  // Entry points on desktop (the phone reaches the same screens from the More sheet).
  function mediaLinks() {
    return h('div', { class: 'row media-links' }, btn('AYiN and clients', function () { go('clients'); }, 'sm', { id: 'go-clients' }), btn('Podcasts', function () { go('podcasts'); }, 'sm', { id: 'go-podcasts' }), btn('Websites', function () { go('websites'); }, 'sm', { id: 'go-websites' }));
  }
  function clientsScreen(s) {
    var C = L.clients, t = today(), clients = (s.clients || []).slice().sort(function (a, b) { return (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || a.name.localeCompare(b.name); }), n = C.counts(s, t);
    var days = mxInp('cl-days', C.contactDaysOf(s), 4, 'text', { inputmode: 'numeric' });
    var daysForm = h('form', { class: 'row', onsubmit: function (e) { e.preventDefault(); actDo({ run: function (x) { C.setContactDays(x, days.value); }, audit: 'client reminder days' }, 'Saved.'); } },
      field('Days without contact before an active client is flagged', days), h('button', { type: 'submit', class: 'btn', id: 'cl-days-save', text: 'Save days' }));
    var f2 = clientFields(s, null, 'ca-');
    var form = h('form', { onsubmit: function (e) { e.preventDefault(); act(function () { var input = f2.read(); return commit(function (x) { C.addClient(x, input, t); }, 'client add').then(function () { setNotice('ok', 'Client added.'); render(); }); }); } },
      f2.nodes, h('button', { type: 'submit', class: 'btn pri', id: 'ca-add', text: 'Add client' }));
    return h('div', { id: 'clients' }, btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'), h('div', { class: 'row sp' }, h('h1', { text: 'AYiN and clients' }), lockMark(['clients', 'people', 'contacts', 'invoices'])),
      mediaLinks(), h('p', { class: 'mut small', text: 'Numbers come from your existing records. Client names, notes and money stay in this vault.' }),
      clientsRollupCard(s, t),
      h('div', { class: 'card', id: 'cl-flags' }, h('h2', null, 'Needs attention ', lockMark(['clients', 'invoices', 'people', 'contacts'])), h('div', { class: 'stats' }, stat('Clients with an overdue invoice', String(n.overdueInvoices), 'cl-n-overdue', n.overdueInvoices ? 'bad-t' : ''), stat('Clients with no recent contact', String(n.noContact), 'cl-n-contact', n.noContact ? 'bad-t' : '')), daysForm),
      h('div', { class: 'card', id: 'cl-list' }, h('h2', null, 'Clients (' + clients.length + ') ', lockMark(['clients', 'invoices', 'entries', 'projects', 'people', 'contacts'])), clients.length ? clients.map(function (c) { return clientCard(s, c, t); }) : h('p', { class: 'mut', id: 'cl-none', text: 'No clients yet. Add one below.' })),
      details('cl-new', 'Add a client', form, !clients.length));
  }
  // Weekly review: counts only, never a name or an amount. Shown once any client exists.
  function reviewClientsCard(s, t) {
    var C = L.clients;
    if (!C.hasData(s)) return null;
    var n = C.counts(s, t);
    return h('div', { id: 'rv-clients' }, h('h2', null, 'Clients ', lockMark(['clients', 'invoices', 'people', 'contacts'])),
      h('div', { class: 'card' }, h('p', { class: 'small', id: 'rv-cl-stats', text: 'Clients with an overdue invoice: ' + n.overdueInvoices + '. Clients with no recent contact: ' + n.noContact + '.' }),
        btn('Open AYiN and clients', function () { go('clients'); }, 'sm', { id: 'rv-cl-open' })));
  }
  // ---- Podcasts ----
  function guestPicker(s, chosen, idp) {
    // SEC-120: the chosen guests are always listed (so saving keeps them), then up to 200 others.
    var isIn = function (p) { return (chosen || []).indexOf(p.id) >= 0; };
    var boxes = [], people = (s.people || []).filter(isIn).concat((s.people || []).filter(function (p) { return !p.archived && !isIn(p); }).slice(0, 200));
    people.forEach(function (p, i) {
      var cb = h('input', { type: 'checkbox', id: idp + 'g' + i, checked: (chosen || []).indexOf(p.id) >= 0, 'data-id': p.id });
      boxes.push(h('label', { class: 'row small' }, cb, h('span', { text: p.name })));
    });
    return { node: boxes.length ? h('div', { class: 'guest-pick', role: 'group', 'aria-label': 'Guests' }, boxes) : h('p', { class: 'mut small', text: 'No people in Social yet.' }),
      read: function () { return boxes.map(function (b) { return b.querySelector('input'); }).filter(function (i) { return i.checked; }).map(function (i) { return i.getAttribute('data-id'); }); } };
  }
  function showFields(s, sh, idp) {
    var name = mxInp(idp + 'name', sh && sh.name, 200), site = sel(idp + 'site', [{ v: '', t: '(none)' }].concat((s.sites || []).map(function (x) { return { v: x.id, t: x.hostname }; })), (sh && sh.siteId) || '');
    var line = sel(idp + 'line', mxLineOpts(s, sh && sh.projectId), (sh && sh.projectId) || ''), notes = mxTa(idp + 'notes', sh && sh.notes);
    return { nodes: [field('Show name', name), field('Website (a site from Websites, optional)', site), field('Line of work for costs and revenue (optional)', line), field('Notes (optional)', notes)],
      read: function () { return { name: name.value, siteId: site.value, projectId: line.value, notes: notes.value }; } };
  }
  function showEditDialog(s, sh) {
    var f = showFields(s, sh, 'se-');
    openDialog({ title: 'Edit show', yes: 'Save', body: [h('div', { class: 'form' }, f.nodes), movePrivBtn('shows', sh)],
      onYes: function () { var input = f.read(); return commit(function (x) { L.media.updateShow(x, sh.id, input); }, 'show edit').then(function () { setNotice('ok', 'Show saved.'); render(); }); } });
  }
  function episodeFields(s, e, show, idp) {
    var title = mxInp(idp + 'title', e && e.title, 200), num = mxInp(idp + 'num', e && e.number !== undefined ? e.number : '', 6, 'text', { inputmode: 'numeric' });
    var status = sel(idp + 'status', L.media.EP_STATUS.map(function (k) { return { v: k, t: EP_STATUS_LABEL[k] }; }), e ? e.status : 'idea'), rec = mxInp(idp + 'rec', e && e.recordedOn, 0, 'date'), notes = mxTa(idp + 'notes', e && e.notes);
    var gp = guestPicker(s, e ? e.guestIds : [], idp);
    return { nodes: [field('Title', title), field('Episode number (optional)', num), field('Status', status), field('Record date (optional)', rec), field('Guests (from Social)', gp.node), field('Notes (optional)', notes)],
      read: function () { return { showId: show.id, title: title.value, number: num.value.trim(), status: status.value, recordedOn: rec.value, guestIds: gp.read(), notes: notes.value }; } };
  }
  function episodeEditDialog(s, e, show) {
    var f = episodeFields(s, e, show, 'ee-');
    openDialog({ title: 'Edit episode', yes: 'Save', body: [h('div', { class: 'form' }, f.nodes), movePrivBtn('episodes', e)],
      onYes: function () { var input = f.read(); return commit(function (x) { L.media.updateEpisode(x, e.id, input); }, 'episode edit').then(function () { setNotice('ok', 'Episode saved.'); render(); }); } });
  }
  function episodeCard(s, e, show) {
    var M = L.media, guests = (e.guestIds || []).map(function (id) { return mxName(s.people, id); }).filter(Boolean), nums = M.episodeStats(s, e.id);
    var pf = function (id) { return mxName(show.platforms, id); };
    var rel = e.pubs.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
    var fmt = sel(null, M.FORMATS.map(function (k) { return { v: k, t: FORMAT_LABEL[k] }; }), 'audio'), plat = sel(null, show.platforms.map(function (p) { return { v: p.id, t: p.name }; }), show.platforms.length ? show.platforms[0].id : '');
    var dt = mxInp(null, '', 0, 'date');
    fmt.setAttribute('aria-label', 'Format for ' + e.title); plat.setAttribute('aria-label', 'Platform for ' + e.title); dt.setAttribute('aria-label', 'Publish date for ' + e.title);
    return h('div', ROW({ class: 'item pc-episode', 'data-title': e.title, 'data-status': e.status }, 'episodes', e),
      h('div', null, h('span', { class: 'entry-t', text: (e.number !== undefined ? '#' + e.number + ' ' : '') + e.title }), chipEl(EP_STATUS_LABEL[e.status], 'pc-ep-status'), e.recordedOn ? h('span', { class: 'mut small', text: ' recorded ' + e.recordedOn }) : null),
      guests.length ? h('div', { class: 'small', text: 'Guests: ' + guests.join(', ') }) : null,
      e.notes ? h('div', { class: 'small mut', text: e.notes }) : null,
      rel.length ? h('div', { class: 'chips pc-releases' }, rel.map(function (p) {
        return h('span', { class: 'chip', 'data-format': p.format }, FORMAT_LABEL[p.format] + ' on ' + pf(p.platformId) + ' ' + p.date, h('button', { type: 'button', class: 'x', text: 'x', 'aria-label': 'Remove the ' + FORMAT_LABEL[p.format] + ' release on ' + pf(p.platformId) + ' for ' + e.title,
          onclick: function () { mxAct(function (x) { M.setRelease(x, e.id, p.format, p.platformId, ''); }, 'episode release remove', 'Release date removed.'); } }));
      })) : null,
      nums.length ? h('div', { class: 'small pc-ep-numbers', text: 'Latest numbers: ' + nums.map(function (n) { return n.platform + ' ' + MEASURE_LABEL[n.measure].toLowerCase() + ' ' + mxNum(n.value); }).join('; ') }) : null,
      show.platforms.length ? h('div', { class: 'row' }, fmt, plat, dt, btn('Set release date', function () { mxAct(function (x) { M.setRelease(x, e.id, fmt.value, plat.value, dt.value); }, 'episode release', 'Release date saved.'); }, 'sm pc-rel-set', { 'aria-label': 'Set the release date for ' + e.title })) : null,
      h('div', { class: 'row' }, btn('Edit', function () { episodeEditDialog(s, e, show); }, 'sm pc-ep-edit', { 'aria-label': 'Edit ' + e.title }),
        btn('Delete', function () {
          openDialog({ title: 'Delete this episode?', yes: 'Delete', danger: true, body: [h('p', { class: 'mut', text: e.title }), h('p', { class: 'small', text: 'The numbers typed for this episode are deleted with it.' })],
            onYes: function () { return commit(function (x) { M.deleteEpisode(x, e.id); }, 'episode delete').then(function () { render(); }); } });
        }, 'sm bad pc-ep-del', { 'aria-label': 'Delete ' + e.title })));
  }
  function platformTables(s, sh, t) {
    var M = L.media, sum = M.platformSummary(s, sh.id, t.slice(0, 7), 6), out = [];
    sum.forEach(function (p, i) {
      if (!p.rows.length) { out.push(h('p', { class: 'mut small pc-nonum', 'data-platform': p.name, text: p.name + ': no numbers typed yet.' })); return; }
      var heads = ['Measure', 'Latest'].concat(p.rows[0].months.map(function (m) { return monthLabel(m.month); }));
      out.push(h('h4', { text: p.name }), tbl('pn-' + sh.id.slice(0, 8) + '-' + i, heads, p.rows.map(function (r) {
        return { cat: r.measure, cells: [MEASURE_LABEL[r.measure], mxNum(r.latest.value) + ' (' + r.latest.date + ')'].concat(r.months.map(function (m) { return mxNum(m.value); })) };
      })));
    });
    return out;
  }
  function statForm(s, sh, t) {
    var M = L.media, k = sh.id.slice(0, 8);
    if (!sh.platforms.length) return h('p', { class: 'mut small', text: 'Add a platform to type numbers.' });
    var plat = sel('sn-plat-' + k, sh.platforms.map(function (p) { return { v: p.id, t: p.name }; }), sh.platforms[0].id), me = sel('sn-measure-' + k, M.MEASURES.map(function (m) { return { v: m, t: MEASURE_LABEL[m] }; }), 'views');
    var val = mxInp('sn-value-' + k, '', 14, 'text', { inputmode: 'numeric' }), dt = mxInp('sn-date-' + k, t, 0, 'date');
    var eps = sel('sn-ep-' + k, [{ v: '', t: '(whole platform)' }].concat((s.episodes || []).filter(function (e) { return e.showId === sh.id; }).map(function (e) { return { v: e.id, t: e.title }; })), '');
    return h('form', { class: 'sn-form', id: 'sn-form-' + k, onsubmit: function (e) { e.preventDefault(); act(function () {
      var input = { showId: sh.id, platformId: plat.value, measure: me.value, value: val.value, date: dt.value, episodeId: eps.value };
      return commit(function (x) { M.addStat(x, input, t); }, 'platform number add').then(function () { setNotice('ok', 'Number saved.'); render(); }); }); } },
      field('Platform', plat), field('Measure', me), field('Number', val, 'Whole numbers, as shown by the platform. Typing the same date, measure and episode again replaces it.'), field('Date', dt), field('Episode (optional)', eps),
      h('button', { type: 'submit', class: 'btn pri sn-add', text: 'Add number' }));
  }
  function recentStats(s, sh) {
    var xs = (s.platformStats || []).filter(function (x) { return x.showId === sh.id; }).sort(function (a, b) { return b.date.localeCompare(a.date) || b.id.localeCompare(a.id); }).slice(0, 8);
    if (!xs.length) return null;
    return details('sn-recent-' + sh.id.slice(0, 8), 'Numbers you typed (newest ' + xs.length + ')', xs.map(function (x) {
      return h('div', ROW({ class: 'item sn-row', 'data-measure': x.measure }, 'platformStats', x), h('div', null, h('span', { class: 'entry-t', text: mxName(sh.platforms, x.platformId) + ' ' + MEASURE_LABEL[x.measure].toLowerCase() + ' ' + mxNum(x.value) }), h('span', { class: 'mut small', text: ' ' + x.date })),
        btn('Delete', function () { mxAct(function (y) { L.media.deleteStat(y, x.id); }, 'platform number delete', 'Number deleted.'); }, 'sm bad sn-del', { 'aria-label': 'Delete the number for ' + MEASURE_LABEL[x.measure].toLowerCase() + ' on ' + x.date }));
    }), false);
  }
  function showCard(s, sh, t) {
    var M = L.media, cad = M.cadence(s, sh.id, t, 6), money = M.showMoney(s, sh, t), eps = (s.episodes || []).filter(function (e) { return e.showId === sh.id; }).sort(function (a, b) { return (b.number || 0) - (a.number || 0) || b.title.localeCompare(a.title); });
    var site = mxName(s.sites, sh.siteId, 'hostname'), line = mxName(s.projects, sh.projectId), np = mxInp('pl-new-' + sh.id.slice(0, 8), '', 60);
    var plats = h('div', { class: 'chips pc-platforms' }, sh.platforms.map(function (p) {
      return h('span', { class: 'chip pc-platform', 'data-platform': p.name }, p.name,
        h('button', { type: 'button', class: 'x pc-pl-rename', text: 'r', 'aria-label': 'Rename platform ' + p.name, onclick: function () {
          var nm = mxInp('pl-rename', p.name, 60);
          openDialog({ title: 'Rename platform', yes: 'Save', body: field('Platform name', nm), onYes: function () { return commit(function (x) { M.renamePlatform(x, sh.id, p.id, nm.value); }, 'platform rename').then(function () { render(); }); } });
        } }),
        h('button', { type: 'button', class: 'x pc-pl-remove', text: 'x', 'aria-label': 'Remove platform ' + p.name, onclick: function () {
          openDialog({ title: 'Remove this platform?', yes: 'Remove', danger: true, body: [h('p', { class: 'mut', text: p.name }), h('p', { class: 'small', text: 'The release dates and numbers typed for it are removed too.' })],
            onYes: function () { return commit(function (x) { M.removePlatform(x, sh.id, p.id); }, 'platform remove').then(function () { render(); }); } });
        } }));
    }));
    var ef = episodeFields(s, null, sh, 'ea-' + sh.id.slice(0, 8) + '-');
    var epForm = h('form', { onsubmit: function (e) { e.preventDefault(); act(function () { var input = ef.read(); return commit(function (x) { M.addEpisode(x, input); }, 'episode add').then(function () { setNotice('ok', 'Episode added.'); render(); }); }); } },
      ef.nodes, h('button', { type: 'submit', class: 'btn pri pc-ep-add', text: 'Add episode' }));
    return h('div', ROW({ class: 'card pc-show', 'data-show': sh.name }, 'shows', sh),
      h('div', { class: 'row sp' }, h('h2', { class: 'entry-t', text: sh.name }), h('span', { class: 'row' }, site ? chipEl(site, 'pc-site') : null, line ? chipEl(line, 'pc-line') : null,
        btn('Edit', function () { showEditDialog(s, sh); }, 'sm pc-edit', { 'aria-label': 'Edit ' + sh.name }),
        btn('Delete', function () {
          openDialog({ title: 'Delete this show?', yes: 'Delete', danger: true, body: [h('p', { class: 'mut', text: sh.name }), h('p', { class: 'small', text: 'Its episodes and typed numbers are deleted. Its website and line of work are kept.' })],
            onYes: function () { return commit(function (x) { M.deleteShow(x, sh.id); }, 'show delete').then(function () { render(); }); } });
        }, 'sm bad pc-del', { 'aria-label': 'Delete ' + sh.name }))),
      sh.notes ? h('p', { class: 'small mut', text: sh.notes }) : null,
      h('div', { class: 'stats' }, stat('Episodes published', String(cad.published), null), stat('Days since the last episode', cad.gapDays === null ? 'no data' : String(cad.gapDays), 'pc-gap-' + sh.id.slice(0, 8))),
      cad.published ? tbl('pc-cad-' + sh.id.slice(0, 8), ['Month', 'Episodes published'], cad.perMonth.map(function (m) { return { cat: m.month, cells: [monthLabel(m.month), m.count === null ? 'no data' : String(m.count)] }; })) : h('p', { class: 'mut small', text: 'No published episodes with a release date yet.' }),
      h('h3', null, 'Platforms ', lockMark(['shows', 'platformStats'])), plats,
      h('form', { class: 'row', onsubmit: function (e) { e.preventDefault(); actDo({ run: function (x) { M.addPlatform(x, sh.id, np.value); }, audit: 'platform add' }, 'Platform added.'); } }, field('Add a platform', np), h('button', { type: 'submit', class: 'btn', text: 'Add platform' })),
      h('h3', null, 'Platform numbers ', lockMark(['platformStats', 'episodes'])), h('p', { class: 'mut small', text: 'Typed by you. A measure is never added to another measure; a month with nothing typed reads no data. Views, downloads, listens and reads add up within a month; subscribers and followers show the latest of the month.' }),
      platformTables(s, sh, t), statForm(s, sh, t), recentStats(s, sh),
      h('h3', null, 'Costs and revenue ', lockMark(['entries', 'projects'])),
      money ? [h('div', { class: 'stats' }, stat('Revenue this year', fmtC(s, money.ytd.revenueCents), null), stat('Costs this year', fmtC(s, money.ytd.expenseCents), null), stat('Net this year', fmtC(s, money.ytd.netCents), null)),
        h('div', { class: 'stats' }, stat('Revenue to date', fmtC(s, money.all.revenueCents), null), stat('Costs to date', fmtC(s, money.all.expenseCents), null), stat('Net to date', fmtC(s, money.all.netCents), null)),
        h('p', { class: 'mut small', text: 'From the line of work ' + line + '. Costs count once paid.' }), money.partial ? h('p', { class: 'mut small', text: 'Some of this covers archived years only in part.' }) : null]
        : h('p', { class: 'mut small', text: 'Choose a line of work for this show to see its costs and revenue.' }),
      h('h3', { text: 'Episodes (' + eps.length + ')' }), eps.length ? eps.map(function (e) { return episodeCard(s, e, sh); }) : h('p', { class: 'mut', text: 'No episodes yet.' }),
      details('pc-newep-' + sh.id.slice(0, 8), 'Add an episode', epForm, !eps.length));
  }
  function podcastsScreen(s) {
    var M = L.media, t = today(), shows = (s.shows || []).slice().sort(function (a, b) { return a.name.localeCompare(b.name); }), f = showFields(s, null, 'sa-');
    var form = h('form', { onsubmit: function (e) { e.preventDefault(); act(function () { var input = f.read(); return commit(function (x) { M.addShow(x, input); }, 'show add').then(function () { setNotice('ok', 'Show added with the default platforms.'); render(); }); }); } },
      f.nodes, h('p', { class: 'mut small', text: 'A new show starts with these platforms, which you can rename, remove or add to: ' + M.DEFAULT_PLATFORMS.join(', ') + '.' }), h('button', { type: 'submit', class: 'btn pri', id: 'sa-add', text: 'Add show' }));
    return h('div', { id: 'podcasts' }, btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'), h('div', { class: 'row sp' }, h('h1', { text: 'Podcasts' }), lockMark(['shows', 'episodes', 'platformStats', 'people'])),
      mediaLinks(), h('p', { class: 'mut small', text: 'Shows, episodes and the numbers you type per platform. Titles, platform names and numbers stay in this vault.' }),
      shows.length ? shows.map(function (sh) { return showCard(s, sh, t); }) : h('p', { class: 'mut', id: 'pc-none', text: 'No shows yet. Add one below.' }),
      details('pc-new', 'Add a show', form, !shows.length));
  }
  // Weekly review: numbers only.
  function reviewMediaCard(s, wk, t) {
    var M = L.media;
    if (!M.hasShows(s) && !M.hasSites(s)) return null;
    var d = M.digest(s, wk);
    return h('div', { id: 'rv-media' }, h('h2', null, 'Shows and sites ', lockMark(['shows', 'episodes', 'sites', 'renewals'])),
      h('div', { class: 'card' }, h('p', { class: 'small', id: 'rv-media-stats', text: 'Episodes published this month: ' + d.episodesThisMonth + '. Sites with a renewal in the next 30 days: ' + d.sitesRenewing + '.' }),
        h('div', { class: 'row' }, M.hasShows(s) ? btn('Open Podcasts', function () { go('podcasts'); }, 'sm', { id: 'rv-media-pod' }) : null, M.hasSites(s) ? btn('Open Websites', function () { go('websites'); }, 'sm', { id: 'rv-media-web' }) : null)));
  }
  // ---- Websites ----
  function siteFields(s, x, idp) {
    var dom = mxInp(idp + 'domain', x && x.hostname, 253), purpose = sel(idp + 'purpose', L.media.PURPOSES.map(function (k) { return { v: k, t: PURPOSE_LABEL[k] }; }), x ? x.kind : 'business');
    var line = sel(idp + 'line', mxLineOpts(s, x && x.projectId), (x && x.projectId) || ''), show = sel(idp + 'show', [{ v: '', t: '(none)' }].concat((s.shows || []).map(function (p) { return { v: p.id, t: p.name }; })), (x && x.showId) || '');
    var host = mxInp(idp + 'host', x && x.host, 200), notes = mxTa(idp + 'notes', x && x.notes);
    var ren = function (which) { var r = x ? L.media.renewalsOf(s, x).filter(function (q) { return q.which === which; })[0] : null; return r || { date: '', amountCents: null }; };
    var d = ren('domain'), hs = ren('hosting');
    var dDate = mxInp(idp + 'ddate', d.date, 0, 'date'), dCost = mxInp(idp + 'dcost', typeof d.amountCents === 'number' ? dollarsText(d.amountCents) : '', 20), hDate = mxInp(idp + 'hdate', hs.date, 0, 'date'), hCost = mxInp(idp + 'hcost', typeof hs.amountCents === 'number' ? dollarsText(hs.amountCents) : '', 20);
    return { nodes: [field('Domain', dom), field('Purpose', purpose), field('Line of work (optional)', line), field('Show (optional)', show), field('Hosting provider', host),
      field('Domain renewal date (optional)', dDate, 'Creates a renewal in Admin, so it reaches at a glance and the calendar file.'), field('Domain renewal cost in dollars (optional)', dCost), field('Hosting renewal date (optional)', hDate), field('Hosting renewal cost in dollars (optional)', hCost), field('Notes (optional)', notes, 'Do not enter ID numbers, account numbers or passwords.')],
    read: function () { return { domain: dom.value, purpose: purpose.value, projectId: line.value, showId: show.value, host: host.value, notes: notes.value, domainRenewOn: dDate.value, domainCost: dCost.value.trim(), hostRenewOn: hDate.value, hostCost: hCost.value.trim() }; } };
  }
  function siteEditDialog(s, x, t) {
    var f = siteFields(s, x, 'we-');
    openDialog({ title: 'Edit site', yes: 'Save', body: [h('div', { class: 'form' }, f.nodes), movePrivBtn('sites', x)],
      onYes: function () { var input = f.read(); return commit(function (y) { L.media.updateSite(y, x.id, input, t); }, 'site edit').then(function () { setNotice('ok', 'Site saved.'); render(); }); } });
  }
  function siteRenewLinks(s, x) {
    var M = L.media, rows = [];
    [['domain', 'Domain'], ['hosting', 'Hosting']].forEach(function (w) {
      var cur = x[w[0] === 'domain' ? 'domainRenewalId' : 'hostingRenewalId'], opts = [{ v: '', t: '(none)' }].concat((s.renewals || []).map(function (r) { return { v: r.id, t: r.title + ' (' + r.dueDate + ')' }; }));
      var pick = sel(null, opts, cur || '');
      pick.setAttribute('aria-label', w[1] + ' renewal for ' + x.hostname);
      rows.push(h('div', { class: 'row small' }, h('span', { text: w[1] + ' renewal: ' }), pick, btn('Save link', function () { mxAct(function (y) { M.linkRenewal(y, x.id, w[0], pick.value); }, 'site renewal link', 'Renewal link saved. Neither record was deleted.'); }, 'sm ws-link-' + w[0], { 'aria-label': 'Save the ' + w[0] + ' renewal link for ' + x.hostname })));
    });
    return rows;
  }
  function trafficBlock(s, x, t) {
    var M = L.media, k = x.id.slice(0, 8), months = M.trafficMonths(s, x.id, t.slice(0, 7), 12);
    var mo = mxInp('wt-month-' + k, t.slice(0, 7), 7, 'month'), vis = mxInp('wt-visits-' + k, '', 14, 'text', { inputmode: 'numeric' }), vr = mxInp('wt-visitors-' + k, '', 14, 'text', { inputmode: 'numeric' });
    var form = h('form', { class: 'wt-form', id: 'wt-form-' + k, onsubmit: function (e) { e.preventDefault(); act(function () {
      var input = { siteId: x.id, month: mo.value, visits: vis.value, visitors: vr.value };
      return commit(function (y) { M.addTraffic(y, input); }, 'site traffic add').then(function () { setNotice('ok', 'Traffic saved.'); render(); }); }); } },
      field('Month', mo), field('Visits', vis), field('Visitors (optional)', vr), h('button', { type: 'submit', class: 'btn pri wt-add', text: 'Add traffic' }));
    var rows = months.map(function (m) { return { cat: m.month, cells: [monthLabel(m.month), mxNum(m.visits), mxNum(m.visitors)] }; });
    var saved = (s.siteTraffic || []).filter(function (r) { return r.siteId === x.id; }).sort(function (a, b) { return b.month.localeCompare(a.month); }).slice(0, 6);
    return [h('h4', { text: 'Monthly traffic' }), tbl('wt-' + k, ['Month', 'Visits', 'Visitors'], rows), form,
      saved.length ? details('wt-saved-' + k, 'Months you typed (newest ' + saved.length + ')', saved.map(function (r) {
        return h('div', ROW({ class: 'item wt-row', 'data-month': r.month }, 'siteTraffic', r), h('div', null, h('span', { class: 'entry-t', text: monthLabel(r.month) + ': ' + mxNum(r.visits) + ' visits' })),
          btn('Delete', function () { mxAct(function (y) { M.deleteTraffic(y, r.id); }, 'site traffic delete', 'Traffic month deleted.'); }, 'sm bad wt-del', { 'aria-label': 'Delete the traffic for ' + monthLabel(r.month) }));
      }), false) : null];
  }
  function siteCard(s, x, t) {
    var M = L.media, ren = M.renewalsOf(s, x), line = mxName(s.projects, x.projectId), show = mxName(s.shows, x.showId);
    return h('div', ROW({ class: 'card ws-site', 'data-site': x.hostname }, 'sites', x),
      h('div', { class: 'row sp' }, h('h2', { class: 'entry-t', text: x.hostname }), h('span', { class: 'row' }, chipEl(PURPOSE_LABEL[x.kind], 'ws-purpose'), line ? chipEl(line, 'ws-line') : null, show ? chipEl(show, 'ws-show') : null,
        btn('Edit', function () { siteEditDialog(s, x, t); }, 'sm ws-edit', { 'aria-label': 'Edit ' + x.hostname }),
        btn('Delete', function () {
          openDialog({ title: 'Delete this site?', yes: 'Delete', danger: true, body: [h('p', { class: 'mut', text: x.hostname }), h('p', { class: 'small', text: 'Its typed traffic is deleted. Its renewals stay in Admin.' })],
            onYes: function () { return commit(function (y) { M.deleteSite(y, x.id); }, 'site delete').then(function () { render(); }); } });
        }, 'sm bad ws-del', { 'aria-label': 'Delete ' + x.hostname }))),
      x.host ? h('p', { class: 'small', text: 'Hosting: ' + x.host }) : null, x.notes ? h('p', { class: 'small mut', text: x.notes }) : null,
      ren.length ? h('div', { class: 'ws-renewals' }, ren.map(function (r) { return h('p', { class: 'small ws-renewal', 'data-which': r.which, text: (r.which === 'domain' ? 'Domain' : 'Hosting') + ' renews ' + r.date + (r.amountCents !== null ? ', ' + fmtC(s, r.amountCents) : '') + (r.state === 'open' ? '' : ' (' + r.state + ')') }); }),
        btn('Open Admin', function () { go('domain', { domain: 'admin' }); }, 'sm', { 'aria-label': 'Open Admin renewals' })) : h('p', { class: 'mut small', text: 'No renewal dates yet.' }),
      siteRenewLinks(s, x), trafficBlock(s, x, t));
  }
  function websitesScreen(s) {
    var M = L.media, t = today(), sites = (s.sites || []).slice().sort(function (a, b) { return a.hostname.localeCompare(b.hostname); }), f = siteFields(s, null, 'wa-');
    var form = h('form', { onsubmit: function (e) { e.preventDefault(); act(function () { var input = f.read(); return commit(function (x) { M.addSite(x, input, t); }, 'site add').then(function () { setNotice('ok', 'Site added.'); render(); }); }); } },
      f.nodes, h('button', { type: 'submit', class: 'btn pri', id: 'wa-add', text: 'Add site' }));
    return h('div', { id: 'websites' }, btn('Back to dashboard', function () { go('dashboard'); }, 'sm back'), h('div', { class: 'row sp' }, h('h1', { text: 'Websites' }), lockMark(['sites', 'siteTraffic', 'renewals', 'shows'])),
      mediaLinks(), h('p', { class: 'mut small', text: 'Your sites, their renewals and the monthly traffic you type in. Domains, hosts and notes stay in this vault. A renewal made here is an Admin renewal with a generic title.' }),
      sites.length ? sites.map(function (x) { return siteCard(s, x, t); }) : h('p', { class: 'mut', id: 'ws-none', text: 'No sites yet. Add one below.' }),
      details('ws-new', 'Add a site', form, !sites.length));
  }

  function boot() {
    if (L.clients) L.clients.registerGlance();
    // CR-9: frame-ancestors only exists in the HTTP header (Cloudflare); on any other host or file:// the page must refuse to run framed.
    var framed = true;
    try { framed = window.top !== window.self; } catch (e) { framed = true; }
    if (framed) { var root = document.getElementById('app'); if (root) root.replaceChildren(h('p', { class: 'notice err', text: 'LifeOS cannot run inside a frame. Open it in its own tab.' })); return; }
    var p = Promise.resolve();
    if (!globalThis.crypto || !globalThis.crypto.subtle) notice = { kind: 'err', text: 'This browser does not support the required encryption features.' };
    else p = L.store.exists().then(function (x) { vaultExists = !!x; }, function () { notice = { kind: 'err', text: 'Storage is unavailable in this browser.' }; });
    p.then(function () {
      view = { name: 'lock' }; hist.reset();
      // Back from Google sign-in on a device with no vault: open the Drive path (the token is already in memory).
      if (!vaultExists && L.sync && L.sync.isConnected()) lockPath = 'drive';
      var ret = !vaultExists && L.sync ? L.sync.takeReturn() : null;
      if (ret && ret.error) { notice = { kind: 'err', text: ret.error }; if (!vaultExists) lockPath = 'drive'; }
      render();
      // v1.4.0 B8: https only; a new version shows a prompt and never reloads by itself.
      if (L.pwa) L.pwa.register({ loc: window.location, navigator: navigator, document: document, onUpdate: function (apply) { pwaApply = apply; showUpdate(); } });
    });
    // The bottom bar and the full desktop bar differ; redraw when the window crosses the breakpoint.
    try {
      narrowMQ = window.matchMedia('(max-width: 819px)');
      var onMQ = function () { if (!locking && !dlgEl) render(); };
      if (narrowMQ.addEventListener) narrowMQ.addEventListener('change', onMQ); else if (narrowMQ.addListener) narrowMQ.addListener(onMQ);
    } catch (e) { narrowMQ = null; }
  }
  boot();
})();
