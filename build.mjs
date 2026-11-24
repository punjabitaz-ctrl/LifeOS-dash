import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { ICONS, drawIcon, manifestFor, appleIconDataUrl } from './src/icons.mjs';
import { fileURLToPath } from 'node:url';

const CORE = ['vault', 'ops', 'nav', 'setup', 'store', 'priv', 'wellbeing', 'csv', 'metrics', 'food', 'home', 'admin', 'learning', 'activities', 'social', 'revenue', 'tax', 'business', 'clients', 'media', 'layout', 'goals', 'memory', 'ai', 'calendar', 'jobs', 'search'].map((n) => `src/core/${n}.js`);

function read(root, rel) {
  try { return readFileSync(join(root, rel), 'utf8'); }
  catch (e) { throw new Error(`Build failed: cannot read ${rel} (${e.code || e.message})`); }
}
function inline(html, tag, placeholder, text) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*${placeholder.replace(/[*/]/g, '\\$&')}\\s*</${tag}>`, 'g');
  const found = html.match(re);
  if (!found || found.length !== 1) throw new Error(`Build failed: shell.html must contain exactly one <${tag}>${placeholder}</${tag}>`);
  return html.replace(re, () => `<${tag}>${text}</${tag}>`);
}
// B6: package.json is the one version source. It is injected into the app as LifeOS.VERSION and into README.md; HANDOFF.md is checked.
export function versionOf(root = dirname(fileURLToPath(import.meta.url))) {
  let v;
  try { v = JSON.parse(read(root, 'package.json')).version; } catch (e) { throw new Error('Build failed: package.json is not readable JSON'); }
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v)) throw new Error('Build failed: package.json needs a version like 1.2.3');
  return v;
}
const VERSION_MARK = /(<!--version-->)[^<]*(<!--\/version-->)/;
export function syncDocs(root = dirname(fileURLToPath(import.meta.url))) {
  const v = versionOf(root), problems = [];
  const rp = join(root, 'README.md');
  if (existsSync(rp)) {
    const t = readFileSync(rp, 'utf8');
    if (!VERSION_MARK.test(t)) problems.push('README.md has no <!--version--> marker');
    else { const n = t.replace(VERSION_MARK, (m, a, b) => a + v + b); if (n !== t) writeFileSync(rp, n); }
  }
  const hp = join(root, 'docs/HANDOFF.md');
  if (existsSync(hp)) {
    const m = VERSION_MARK.exec(readFileSync(hp, 'utf8'));
    if (!m) problems.push('docs/HANDOFF.md has no <!--version--> marker in its header');
    else if (m[0].replace(/<[^>]*>/g, '') !== v) problems.push('docs/HANDOFF.md header says ' + m[0].replace(/<[^>]*>/g, '') + ' but package.json says ' + v);
  }
  return problems;
}
// v2.0.0: config/hosts.json holds the names (not secrets). Exactly the sync, ai-nas and ai-pc names become https connect-src origins; the app name is
// recorded for the guide and the service's CORS setting only. Nothing user-entered ever reaches the policy. No file means no extra origins.
export const HOST_KEYS = ['app', 'sync', 'ai-nas', 'ai-pc'];
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
export function hostsOf(root = dirname(fileURLToPath(import.meta.url))) {
  const p = join(root, 'config/hosts.json');
  if (!existsSync(p)) return null;
  let j;
  try { j = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw new Error('Build failed: config/hosts.json is not valid JSON'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('Build failed: config/hosts.json must be an object');
  for (const k of Object.keys(j)) if (!HOST_KEYS.includes(k)) throw new Error('Build failed: config/hosts.json has an unknown name: ' + k.slice(0, 40));
  const out = {};
  for (const k of HOST_KEYS) {
    const v = j[k];
    if (typeof v !== 'string' || !HOST_RE.test(v)) throw new Error('Build failed: config/hosts.json needs a plain lowercase host name for "' + k + '" (no scheme, port, path or wildcard)');
    out[k] = v;
  }
  const seen = new Set(['api.anthropic.com', 'www.googleapis.com', 'localhost']);
  for (const k of ['sync', 'ai-nas', 'ai-pc']) { if (seen.has(out[k])) throw new Error('Build failed: config/hosts.json names must be different from each other and from the built-in hosts'); seen.add(out[k]); }
  return out;
}
const sha = (s) => 'sha256-' + createHash('sha256').update(s, 'utf8').digest('base64');

function assemble(root) {
  let html = read(root, 'src/ui/shell.html');
  let css = read(root, 'src/ui/styles.css');
  const optional = (f) => (existsSync(join(root, f)) ? [f] : []);
  const files = [...CORE, ...optional('src/core/sync.js'), ...optional('src/core/nas.js'), ...optional('src/core/archive.js'), 'src/ui/app.js', ...optional('src/ui/sync-ui.js'), ...optional('src/ui/nas-ui.js'), ...optional('src/ui/pwa.js'), ...optional('src/ui/archive-ui.js'), ...optional('src/ui/recovery-ui.js'), ...optional('src/ui/guide-ui.js')];
  const hosts = hostsOf(root);
  const head = `globalThis.LifeOS = globalThis.LifeOS || {};\nglobalThis.LifeOS.VERSION = ${JSON.stringify(versionOf(root))};` + (hosts ? `\nglobalThis.LifeOS.HOSTS = ${JSON.stringify(hosts)};\nObject.defineProperty(globalThis.LifeOS, 'HOSTS', { value: Object.freeze(globalThis.LifeOS.HOSTS), writable: false, configurable: false, enumerable: true });` : '');
  const js = [head].concat(files.map((f) => read(root, f))).join('\n;\n').replace(/<\/script/gi, (m) => '<\\' + m.slice(1)).replace(/<!--/g, '<\\!--').replace(/<script/gi, (m) => '<\\' + m.slice(1));
  // Neutralise </style in CSS: in a CSS escape, \3c is '<', so the text stays inert but the HTML parser never sees the tag.
  css = css.replace(/<\/style/gi, (m) => '\\3c ' + m.slice(1));
  if (!html.includes('__CSP__')) throw new Error('Build failed: shell.html is missing the __CSP__ placeholder');
  const csp = `default-src 'none'; script-src '${sha(js)}'; style-src '${sha(css)}'; connect-src https://api.anthropic.com https://www.googleapis.com${hosts ? ' ' + ['sync', 'ai-nas', 'ai-pc'].map((k) => 'https://' + hosts[k]).join(' ') : ''} http://localhost:* http://127.0.0.1:*; img-src data:; base-uri 'none'; form-action 'none'; manifest-src 'self'; worker-src 'self'`;
  html = html.split('__CSP__').join(csp).split('__VERSION__').join(versionOf(root)).split('__APPLE_ICON__').join(appleIconDataUrl(versionOf(root)));
  html = inline(html, 'style', '/*__CSS__*/', css);
  html = inline(html, 'script', '/*__JS__*/', js);
  return { html, csp };
}

export function build(root = dirname(fileURLToPath(import.meta.url))) { return assemble(root).html; }

export const SW_CSP = "default-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const PAGE_PATH = 'lifeos';
// Cloudflare Pages `_headers`: same CSP as the meta tag, plus what a meta tag cannot carry (frame-ancestors, HSTS, ...).
export function headersFor(csp) {
  return [
    '/*',
    `  Content-Security-Policy: ${csp}; frame-ancestors 'none'`,
    '  Strict-Transport-Security: max-age=63072000',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()',
    '  Cross-Origin-Opener-Policy: same-origin',
    '',
    '/',
    '  Cache-Control: no-cache',
    '',
    '/*.html',
    '  Cache-Control: no-cache',
    '',
    // v1.4.0: the service worker script runs under its own policy (it must fetch the shell from its own origin; the page policy would block that).
    '/dist/sw.js',
    '  ! Content-Security-Policy',
    `  Content-Security-Policy: ${SW_CSP}`,
    '  Cache-Control: no-cache',
    '  Content-Type: text/javascript; charset=utf-8',
    ''
  ].join('\n');
}
// v1.4.0 B8: the service worker (one file), the manifest and the icons, all stamped with the one version.
export function swFor(root = dirname(fileURLToPath(import.meta.url))) {
  const files = [{ path: 'manifest.webmanifest', kind: 'manifest' }].concat(ICONS.map((i) => ({ path: i.path, kind: 'icon' })));
  return read(root, 'src/sw.js').split('__VERSION__').join(versionOf(root)).split('__PAGE__').join(PAGE_PATH).split('__FILES__').join(JSON.stringify(files));
}
export function buildAll(root = dirname(fileURLToPath(import.meta.url))) {
  const { html, csp } = assemble(root);
  const v = versionOf(root);
  return { html, headers: headersFor(csp), csp, sw: swFor(root), manifest: JSON.stringify(manifestFor(v), null, 2) + '\n', icons: ICONS.map((i) => ({ path: i.path, data: drawIcon(i.size, i.maskable, v) })) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const root = dirname(fileURLToPath(import.meta.url));
    const problems = syncDocs(root);
    if (problems.length) throw new Error('Build failed: ' + problems.join('; '));
    const all = buildAll(root), out = all.html;
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist/lifeos.html'), out);
    writeFileSync(join(root, '_headers'), all.headers);
    writeFileSync(join(root, 'dist/_headers'), all.headers);
    writeFileSync(join(root, 'dist/sw.js'), all.sw);
    writeFileSync(join(root, 'dist/manifest.webmanifest'), all.manifest);
    mkdirSync(join(root, 'dist/icons'), { recursive: true });
    for (const i of all.icons) writeFileSync(join(root, 'dist', i.path), i.data);
    process.stdout.write(`Built dist/lifeos.html (${out.length} bytes)\n`);
  } catch (e) { process.stderr.write(e.message + '\n'); process.exit(1); }
}
