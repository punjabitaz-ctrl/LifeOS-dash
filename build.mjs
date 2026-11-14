import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = ['vault', 'store', 'csv', 'metrics', 'home', 'admin', 'goals', 'memory', 'ai'].map((n) => `src/core/${n}.js`);

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
const sha = (s) => 'sha256-' + createHash('sha256').update(s, 'utf8').digest('base64');

function assemble(root) {
  let html = read(root, 'src/ui/shell.html');
  let css = read(root, 'src/ui/styles.css');
  const optional = (f) => (existsSync(join(root, f)) ? [f] : []);
  const files = [...CORE, ...optional('src/core/sync.js'), 'src/ui/app.js', ...optional('src/ui/sync-ui.js')];
  const js = files.map((f) => read(root, f)).join('\n;\n').replace(/<\/script/gi, (m) => '<\\' + m.slice(1)).replace(/<!--/g, '<\\!--').replace(/<script/gi, (m) => '<\\' + m.slice(1));
  // Neutralise </style in CSS: in a CSS escape, \3c is '<', so the text stays inert but the HTML parser never sees the tag.
  css = css.replace(/<\/style/gi, (m) => '\\3c ' + m.slice(1));
  if (!html.includes('__CSP__')) throw new Error('Build failed: shell.html is missing the __CSP__ placeholder');
  const csp = `default-src 'none'; script-src '${sha(js)}'; style-src '${sha(css)}'; connect-src https://api.anthropic.com https://www.googleapis.com http://localhost:* http://127.0.0.1:*; img-src data:; base-uri 'none'; form-action 'none'`;
  html = html.split('__CSP__').join(csp);
  html = inline(html, 'style', '/*__CSS__*/', css);
  html = inline(html, 'script', '/*__JS__*/', js);
  return { html, csp };
}

export function build(root = dirname(fileURLToPath(import.meta.url))) { return assemble(root).html; }

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
    ''
  ].join('\n');
}
export function buildAll(root = dirname(fileURLToPath(import.meta.url))) {
  const { html, csp } = assemble(root);
  return { html, headers: headersFor(csp), csp };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const root = dirname(fileURLToPath(import.meta.url));
    const all = buildAll(root), out = all.html;
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist/lifeos.html'), out);
    writeFileSync(join(root, '_headers'), all.headers);
    writeFileSync(join(root, 'dist/_headers'), all.headers);
    process.stdout.write(`Built dist/lifeos.html (${out.length} bytes)\n`);
  } catch (e) { process.stderr.write(e.message + '\n'); process.exit(1); }
}
