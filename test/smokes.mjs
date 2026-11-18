// Runs the browser smoke set one after another: every test/smoke*.mjs plus test/review-ui.mjs (the UI review proofs, kept as a
// regression script since v1.0.0). Builds first. Exit code 1 if any script fails. Usage: `node test/smokes.mjs` (or `npm run smoke`).
// v1.3.0: every script has a time limit (default 420 s; `--timeout=SECONDS` or LIFEOS_SMOKE_TIMEOUT_S). A script that hits it fails with "TIMEOUT"
// instead of stalling the run, and any script slower than 90 s is listed at the end (`--slow=SECONDS` or LIFEOS_SMOKE_SLOW_S).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
// `--dir=PATH` runs the smoke*.mjs scripts of another folder without building (used by the test of the time limit itself).
const dirArg = process.argv.find((x) => x.startsWith('--dir='));
const dir = dirArg ? path.resolve(dirArg.slice(6)) : here;
if (!dirArg) { const b = spawnSync(process.execPath, ['build.mjs'], { cwd: root, stdio: 'inherit' }); if (b.status !== 0) process.exit(1); }
const scripts = readdirSync(dir).filter((f) => /^smoke.*\.mjs$/.test(f) && f !== 'smokes.mjs').sort().concat(dirArg ? [] : ['review-ui.mjs']);
const arg = (n, env, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); const v = Number(a ? a.split('=')[1] : process.env[env]); return Number.isFinite(v) && v > 0 ? v : d; };
const LIMIT_S = arg('timeout', 'LIFEOS_SMOKE_TIMEOUT_S', 420), SLOW_S = arg('slow', 'LIFEOS_SMOKE_SLOW_S', 90);
const failed = [], slow = [];
for (const f of scripts) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, f)], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: LIMIT_S * 1000, killSignal: 'SIGKILL' });
  const secs = Math.round((Date.now() - t0) / 1000), timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  if (secs >= SLOW_S) slow.push(f + ' (' + secs + ' s)');
  const last = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-1)[0] || '';
  console.log((r.status === 0 ? 'ok   ' : 'FAIL ') + f + ' (' + secs + ' s) ' + (timedOut ? 'TIMEOUT after ' + LIMIT_S + ' s' : last.slice(0, 160)));
  if (r.status !== 0) { failed.push(f); console.log(((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-15).join('\n')); }
}
if (slow.length) console.log('SLOW (over ' + SLOW_S + ' s): ' + slow.join(', '));
console.log(failed.length ? 'SMOKES: ' + failed.length + ' of ' + scripts.length + ' failed: ' + failed.join(', ') : 'SMOKES: all ' + scripts.length + ' passed');
process.exit(failed.length ? 1 : 0);
