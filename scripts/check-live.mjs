// Live header check (v1.3.0, B3 support). Fetches the live page with a Cloudflare Access service token and compares what comes back with
// the repo: the response headers against `_headers` (the `/*` block) and the page's CSP meta tag against the CSP the build produces.
//
//   CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... node scripts/check-live.mjs [https://live-url]
//
// The token is read from those two environment variables only. It is never printed, never written to a file, and never sent to any other
// origin (redirects are not followed). Exit code: 0 all match, 1 a mismatch or a failed request, 2 the token variables or the URL are missing or unusable.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_URL = 'https://lfs-dsh.punjabitaz.workers.dev/dist/lifeos';

// Headers of the first `/*` block of a Cloudflare `_headers` file: { lower-case name: value }.
export function parseHeadersFile(text) {
  const out = {};
  let inBlock = false;
  for (const raw of String(text).split(/\r?\n/)) {
    if (/^\S/.test(raw)) { inBlock = raw.trim() === '/*'; continue; }
    if (!inBlock) continue;
    const m = /^\s+([A-Za-z][A-Za-z0-9-]*):\s*(.*?)\s*$/.exec(raw);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}
const norm = (v) => String(v).replace(/\s+/g, ' ').trim();
// The CSP carried in the page's meta tag, or null.
export function metaCsp(html) {
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(String(html));
  return m ? m[1] : null;
}

// Pure comparison: returns the list of mismatch lines (empty means pass).
export function compare({ expectedHeaders, builtCsp, status, responseHeaders, html }) {
  const problems = [];
  if (status !== 200) problems.push('The page answered HTTP ' + status + ' instead of 200 (an Access redirect or refusal means the token was not accepted).');
  for (const [name, want] of Object.entries(expectedHeaders)) {
    const got = responseHeaders.get(name);
    if (got === null || got === undefined) problems.push('Missing header ' + name + '.');
    else if (norm(got) !== norm(want)) problems.push('Header ' + name + ' differs.\n  expected: ' + norm(want) + '\n  got:      ' + norm(got));
  }
  const csp = expectedHeaders['content-security-policy'];
  if (csp !== undefined && norm(csp) !== norm(builtCsp + "; frame-ancestors 'none'")) problems.push('The CSP in _headers is not the CSP of the current build (run node build.mjs and commit).');
  const meta = metaCsp(html);
  if (meta === null) problems.push('The page has no CSP meta tag.');
  else if (norm(meta) !== norm(builtCsp)) problems.push('The page CSP meta tag differs from the CSP of the current build (the live copy is not this build).');
  return problems;
}

// io: { fetch, out(text), root }. Returns the exit code. Every line printed passes through redact().
export async function run(argv, env, io) {
  const out = io && io.out ? io.out : (t) => process.stdout.write(t + '\n');
  const doFetch = io && io.fetch ? io.fetch : globalThis.fetch;
  const root = (io && io.root) || ROOT;
  const id = env && typeof env.CF_ACCESS_CLIENT_ID === 'string' ? env.CF_ACCESS_CLIENT_ID.trim() : '';
  const secret = env && typeof env.CF_ACCESS_CLIENT_SECRET === 'string' ? env.CF_ACCESS_CLIENT_SECRET.trim() : '';
  const redact = (t) => { let s = String(t); for (const v of [id, secret]) if (v.length >= 4) s = s.split(v).join('[hidden]'); return s; };
  const say = (t) => out(redact(t));
  if (!id || !secret) { say('Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET in the environment (a Cloudflare Access service token). Nothing was requested.'); return 2; }
  const url = (argv && argv[0]) || (env && env.LIFEOS_LIVE_URL) || DEFAULT_URL;
  let u;
  try { u = new URL(url); } catch (e) { say('That is not a URL. Nothing was requested.'); return 2; }
  if (u.protocol !== 'https:' || u.username || u.password) { say('The live URL must be https and carry no credentials. Nothing was requested.'); return 2; }

  let expectedHeaders, builtCsp;
  try {
    const { buildAll } = await import(pathToFileURL(join(root, 'build.mjs')).href);
    const built = buildAll(root);
    builtCsp = built.csp;
    expectedHeaders = parseHeadersFile(readFileSync(join(root, '_headers'), 'utf8'));
    if (!Object.keys(expectedHeaders).length) throw new Error('no headers');
    if (norm(parseHeadersFile(built.headers)['content-security-policy'] || '') !== norm(expectedHeaders['content-security-policy'] || '')) {
      say('Note: _headers on disk is not what the current build writes (run node build.mjs). Comparing with the file as it is.');
    }
  } catch (e) { say('Could not read _headers or build the CSP here, so nothing was compared.'); return 1; }

  let res, html;
  try {
    // redirect: 'manual' so the token is only ever sent to the one origin given above.
    res = await doFetch(u.href, { method: 'GET', redirect: 'manual', headers: { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret, 'Cache-Control': 'no-cache' } });
    html = res.status === 200 ? await res.text() : '';
  } catch (e) { say('The request failed (' + String((e && (e.code || e.name)) || 'error').replace(/[^A-Za-z0-9_ -]/g, '') + '). Nothing was compared.'); return 1; }

  const problems = compare({ expectedHeaders, builtCsp, status: res.status, responseHeaders: res.headers, html });
  if (!problems.length) { say('PASS: ' + Object.keys(expectedHeaders).length + ' headers match _headers, and the page CSP matches this build. (' + u.origin + ')'); return 0; }
  say('MISMATCH: ' + problems.length + (problems.length === 1 ? ' problem' : ' problems') + ' at ' + u.origin);
  for (const p of problems) say('- ' + p);
  return 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run(process.argv.slice(2), process.env, {}).then((c) => { process.exitCode = c; }, () => { process.stdout.write('The check could not run.\n'); process.exitCode = 1; });
}
