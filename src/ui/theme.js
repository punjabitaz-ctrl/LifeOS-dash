(function () {
  'use strict';
  // The theme switch of the shared design language (docs/DESIGN.md). Auto follows the device; Light or Dark sets data-theme on
  // <html>, which the colour tokens in styles.css answer. The choice is a display setting with no personal content, so it is kept on this
  // device under one key outside the vault: that way the lock screen opens in the chosen theme too. Nothing else is stored here.
  var L = globalThis.LifeOS;
  var KEY = 'lifeos-theme', MODES = ['auto', 'light', 'dark'], LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  var SVGNS = 'http://www.w3.org/2000/svg';
  // One stroke icon per mode: a screen, a sun, a moon.
  var ICON = {
    auto: [['rect', { x: '3', y: '4', width: '18', height: '13', rx: '2' }], ['path', { d: 'M8 21h8' }]],
    light: [['circle', { cx: '12', cy: '12', r: '4' }], ['path', { d: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' }]],
    dark: [['path', { d: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z' }]]
  };
  function ok(v) { return MODES.indexOf(v) >= 0; }
  function read() { try { var v = window.localStorage.getItem(KEY); return ok(v) ? v : 'auto'; } catch (e) { return 'auto'; } }
  var mode = read();
  function apply() {
    var root = document.documentElement;
    if (mode === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode);
  }
  function get() { return mode; }
  function set(v) {
    if (!ok(v)) return mode;
    mode = v; apply();
    try { if (v === 'auto') window.localStorage.removeItem(KEY); else window.localStorage.setItem(KEY, v); } catch (e) { /* private browsing: the choice lasts for this visit */ }
    return mode;
  }
  function icon(m) {
    var s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false'); s.setAttribute('class', 'themeico');
    ICON[m].forEach(function (p) { var e = document.createElementNS(SVGNS, p[0]); Object.keys(p[1]).forEach(function (k) { e.setAttribute(k, p[1][k]); }); s.appendChild(e); });
    return s;
  }
  // The control for the top bar. Wide: three segments (Auto, Light, Dark). Narrow: one button that steps through them.
  function control(narrow) {
    if (narrow) {
      var next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'themebtn'; b.id = 'theme-cycle';
      b.setAttribute('aria-label', 'Theme: ' + LABEL[mode] + '. Switch to ' + LABEL[next]);
      b.appendChild(icon(mode));
      b.addEventListener('click', function () {
        set(next);
        var c = control(true); b.replaceWith(c); c.focus();
      });
      return b;
    }
    var g = document.createElement('div');
    g.className = 'themesw'; g.id = 'theme-switch'; g.setAttribute('role', 'group'); g.setAttribute('aria-label', 'Theme');
    MODES.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button'; b.setAttribute('data-theme-mode', m); b.setAttribute('aria-pressed', String(m === mode));
      b.appendChild(icon(m)); b.appendChild(document.createTextNode(LABEL[m]));
      b.addEventListener('click', function () {
        set(m);
        g.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-theme-mode') === mode)); });
      });
      g.appendChild(b);
    });
    return g;
  }
  apply();
  L.theme = { MODES: MODES, KEY: KEY, get: get, set: set, control: control };
})();
