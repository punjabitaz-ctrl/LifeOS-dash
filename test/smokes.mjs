// Runs the browser smoke set one after another: every test/smoke*.mjs plus test/review-ui.mjs (the UI review proofs, kept as a
// regression script since v1.0.0). Builds first. Exit code 1 if any script fails. Usage: `node test/smokes.mjs` (or `npm run smoke`).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const b = spawnSync(process.execPath, ['build.mjs'], { cwd: root, stdio: 'inherit' });
if (b.status !== 0) process.exit(1);
const scripts = readdirSync(here).filter((f) => /^smoke.*\.mjs$/.test(f) && f !== 'smokes.mjs').sort().concat(['review-ui.mjs']);
const failed = [];
for (const f of scripts) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, f)], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const last = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-1)[0] || '';
  console.log((r.status === 0 ? 'ok   ' : 'FAIL ') + f + ' (' + Math.round((Date.now() - t0) / 1000) + ' s) ' + last.slice(0, 160));
  if (r.status !== 0) { failed.push(f); console.log(((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-15).join('\n')); }
}
console.log(failed.length ? 'SMOKES: ' + failed.length + ' of ' + scripts.length + ' failed: ' + failed.join(', ') : 'SMOKES: all ' + scripts.length + ' passed');
process.exit(failed.length ? 1 : 0);
