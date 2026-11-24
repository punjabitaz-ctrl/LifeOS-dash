// Demo build: dist/lifeos.html plus a small opener that, on a browser with no vault yet, restores the fictional demo backup
// (scripts/demo-seed.mjs) and then opens it with the demo passphrase. For showcase screenshots and a public demo only.
// Never use this file for real data: its passphrase is printed in this script.
// Usage: node scripts/demo-build.mjs [backupFile] [outFile]
//   backupFile defaults to demo/lifeos-demo-backup.json, outFile to demo/lifeos-demo.html.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backup = process.argv[2] || path.join(root, 'demo/lifeos-demo-backup.json');
const out = process.argv[3] || path.join(root, 'demo/lifeos-demo.html');
const PASS = 'demo passphrase 2026';
const sha = (s) => 'sha256-' + createHash('sha256').update(s, 'utf8').digest('base64');

const data = readFileSync(backup, 'utf8');
JSON.parse(data); // must be a backup file (JSON)
const opener = `
;
(function () {
  var L = globalThis.LifeOS, PASS = ${JSON.stringify(PASS)}, DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};
  L.DEMO = true;
  // First visit: restore the demo backup as this browser's vault, then show the normal lock screen.
  var exists = L.store.exists;
  L.store.exists = function () {
    return exists.apply(L.store, arguments).then(function (x) {
      if (x) return x;
      return L.vault.importBackup(PASS, DATA).then(function (st) { return L.store.createFromBackup(PASS, st); }).then(function () { L.store.lock(); return true; });
    });
  };
  // The lock screen opens itself with the demo passphrase.
  var last = 0;
  function open() {
    var p = document.getElementById('pass');
    if (!p || document.getElementById('pass2') || p.value || Date.now() - last < 4000) return;
    last = Date.now(); p.value = PASS;
    var f = p.form; if (f) { if (f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event('submit', { cancelable: true })); }
  }
  new MutationObserver(open).observe(document.documentElement, { childList: true, subtree: true });
})();
`;
let html = build(root);
const m = html.match(/<script>([\s\S]*?)<\/script>/g);
if (!m || m.length !== 1) throw new Error('Demo build failed: expected exactly one inline script');
const js = m[0].slice('<script>'.length, -'</script>'.length);
if (!html.includes(sha(js))) throw new Error('Demo build failed: the script hash is not in the policy');
// The opener must run before app.js boots, so it goes in front of app.js's own text inside the bundle.
const appJs = readFileSync(path.join(root, 'src/ui/app.js'), 'utf8').replace(/<\/script/gi, (x) => '<\\' + x.slice(1)).replace(/<!--/g, '<\\!--').replace(/<script/gi, (x) => '<\\' + x.slice(1));
const at = js.indexOf(appJs);
if (at < 0) throw new Error('Demo build failed: app.js not found in the bundle');
const js2 = js.slice(0, at) + opener.replace(/<\/script/gi, '<\\/script') + '\n;\n' + js.slice(at);
html = html.replace(m[0], () => '<script>' + js2 + '</script>').split(sha(js)).join(sha(js2));
html = html.replace(/<title>[^<]*<\/title>/, '<title>LifeOS demo</title>');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, html);
console.log('Demo build written: ' + path.relative(root, out) + ' (' + Math.round(html.length / 1024) + ' KB)');
