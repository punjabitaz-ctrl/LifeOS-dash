/* LifeOS service worker (v2.4.0). Built by build.mjs. It keeps only the app shell for offline use: the built page, the manifest and
   the icons. It never touches requests to other origins (the AI provider, Google), never caches a redirect, a non-200 answer or anything
   that does not carry this version's shell marker (so a Cloudflare Access sign-in page is never kept as the app), and it holds no user data. */
'use strict';
var VERSION = '2.4.0';
var PREFIX = 'lifeos-shell-';
var CACHE = PREFIX + VERSION;
var PAGE = 'lifeos';
var FILES = [{"path":"manifest.webmanifest","kind":"manifest"},{"path":"icons/icon-192.png","kind":"icon"},{"path":"icons/icon-512.png","kind":"icon"},{"path":"icons/icon-maskable-512.png","kind":"icon"}];
var BASE = new URL('./', self.location.href);
var ORIGIN = self.location.origin;
function abs(p) { return new URL(p, BASE).href; }
var KINDS = {};
KINDS[abs(PAGE)] = 'page';
KINDS[abs(PAGE + '.html')] = 'page';
FILES.forEach(function (f) { KINDS[abs(f.path)] = f.kind; });

function key(url) { var u = new URL(url); u.search = ''; u.hash = ''; return u.href; }
function contentOk(kind, ct) {
  ct = String(ct || '').toLowerCase();
  if (kind === 'page') return /^text\/html\b/.test(ct);
  if (kind === 'manifest') return /^application\/(manifest\+)?json\b/.test(ct);
  if (kind === 'icon') return /^image\/png\b/.test(ct);
  return false;
}
// True only for a plain 200 from this origin, of the right type, that carries this version's shell marker.
function proveShell(kind, res) {
  if (!res || res.status !== 200 || res.redirected || res.type !== 'basic') return Promise.resolve(false);
  if (!contentOk(kind, res.headers && res.headers.get && res.headers.get('content-type'))) return Promise.resolve(false);
  var c;
  try { c = res.clone(); } catch (e) { return Promise.resolve(false); }
  if (kind === 'icon') {
    return c.arrayBuffer().then(function (b) {
      var u = new Uint8Array(b), t = '';
      for (var i = 0; i < u.length && i < 4096; i++) t += String.fromCharCode(u[i]);
      return u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47 && t.indexOf('lifeos-shell\0' + VERSION) >= 0;
    }).catch(function () { return false; });
  }
  return c.text().then(function (t) {
    if (kind === 'manifest') { try { return JSON.parse(t).lifeos_shell === VERSION; } catch (e) { return false; } }
    return t.indexOf('<meta name="lifeos-shell" content="' + VERSION + '">') >= 0;
  }).catch(function () { return false; });
}
function keep(k, kind, res) {
  return proveShell(kind, res).then(function (ok) {
    if (!ok) return false;
    return caches.open(CACHE).then(function (c) { return c.put(k, res.clone()); }).then(function () { return true; }, function () { return false; });
  });
}

self.addEventListener('install', function (e) {
  // With no older worker running there is nothing to interrupt: take over at once. An update waits for the owner's tap.
  if (!self.registration || !self.registration.active) { try { self.skipWaiting(); } catch (x) { /* ignore */ } }
  e.waitUntil(Promise.all([abs(PAGE)].concat(FILES.map(function (f) { return abs(f.path); })).map(function (k) {
    return fetch(k, { cache: 'reload', credentials: 'same-origin', redirect: 'manual' }).then(function (r) { return keep(k, KINDS[k], r); }).catch(function () { return false; });
  })));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) { return n.indexOf(PREFIX) === 0 && n !== CACHE; }).map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients && self.clients.claim ? self.clients.claim() : null; }));
});
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('fetch', function (e) {
  var req = e.request, u;
  if (!req || req.method !== 'GET') return;
  try { u = new URL(req.url); } catch (x) { return; }
  if (u.origin !== ORIGIN) return;               // never intercept anything off-origin
  var k = key(req.url), kind = KINDS[k];
  if (!kind) return;                             // only the shell
  e.respondWith(fetch(req).then(function (res) {
    return keep(k, kind, res).then(function () { return res; });
  }, function () {
    return caches.open(CACHE).then(function (c) { return c.match(kind === 'page' ? abs(PAGE) : k); }).then(function (hit) { return hit || Response.error(); });
  }));
});
