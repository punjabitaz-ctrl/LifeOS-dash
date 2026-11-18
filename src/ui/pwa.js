(function () {
  'use strict';
  // v1.4.0 B8: install as an app and keep the shell for offline use. Registers the service worker only on https origins; the file:// copy
  // and plain http never register one. A new version waits for the owner's tap: nothing here reloads the page by itself.
  var L = globalThis.LifeOS;
  function eligible(loc, nav) { return !!(loc && loc.protocol === 'https:' && nav && nav.serviceWorker && typeof nav.serviceWorker.register === 'function'); }
  // SEC-98: the browser fetches a manifest without cookies unless crossorigin="use-credentials", even from the same origin; behind the
  // Cloudflare Access sign-in that request would be sent to the sign-in page. (The iPhone home-screen icon is a data: link in the page.)
  function addLinks(doc) {
    [['manifest', 'manifest.webmanifest', 'use-credentials']].forEach(function (x) {
      if (doc.querySelector('link[rel="' + x[0] + '"]')) return;
      var l = doc.createElement('link'); l.setAttribute('rel', x[0]); l.setAttribute('href', x[1]);
      if (x[2]) l.setAttribute('crossorigin', x[2]);
      doc.head.appendChild(l);
    });
  }
  // env: { loc, navigator, document, onUpdate(apply) }. onUpdate runs when a newer version is installed and waiting; apply() asks it to
  // take over and reloads the page once it has. Resolves { registered:boolean }.
  function register(env) {
    var nav = env.navigator;
    if (!eligible(env.loc, nav)) return Promise.resolve({ registered: false });
    var asked = false;
    try { addLinks(env.document); } catch (e) { /* the manifest link is optional */ }
    nav.serviceWorker.addEventListener('controllerchange', function () { if (asked) env.loc.reload(); });
    return nav.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' }).then(function (reg) {
      function ready() {
        env.onUpdate(function () {
          asked = true;
          if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' }); else env.loc.reload();
        });
      }
      function watch(w) { if (!w) return; w.addEventListener('statechange', function () { if (w.state === 'installed' && nav.serviceWorker.controller) ready(); }); }
      if (reg.waiting && nav.serviceWorker.controller) ready();
      reg.addEventListener('updatefound', function () { watch(reg.installing); });
      return { registered: true, reg: reg };
    }, function () { return { registered: false }; });
  }
  L.pwa = { eligible: eligible, register: register, addLinks: addLinks };
})();
