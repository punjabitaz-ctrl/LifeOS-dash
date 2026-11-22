// Service configuration: a JSON file in the config directory, overridable by environment variables. No secrets live here (tokens are
// stored only as SHA-256 hashes in a separate file). Node built-ins only.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const LIMITS = Object.freeze({
  MAX_VAULT: 64 * 1024 * 1024, // the app's own cap for a synced copy
  MAX_ARCHIVE: 64 * 1024 * 1024,
  MAX_ARCHIVES: 200,
  KEEP_VERSIONS: 30,
  MAX_DEVICES: 20,
});
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/;

export function parseOrigins(list) {
  const out = [];
  for (const o of list) {
    const s = String(o).trim().replace(/\/+$/, '');
    if (!s) continue;
    if (!ORIGIN_RE.test(s) || s.includes('*')) throw new Error('Bad app origin in the configuration: ' + s.slice(0, 80));
    out.push(s.toLowerCase());
  }
  return out;
}

export function loadConfig(env = process.env, overrides = {}) {
  const configDir = resolve(overrides.configDir || env.LIFEOS_CONFIG_DIR || './config');
  let file = {};
  const p = join(configDir, 'config.json');
  if (existsSync(p)) {
    try { file = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw new Error('config.json is not valid JSON'); }
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('config.json must be an object');
  }
  const origins = overrides.appOrigins || (env.LIFEOS_APP_ORIGINS ? env.LIFEOS_APP_ORIGINS.split(',') : file.appOrigins) || [];
  const num = (v, d, lo, hi) => { const n = Number(v === undefined || v === '' ? d : v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error('Bad number in the configuration'); return n; };
  const cfg = {
    configDir,
    tokensFile: join(configDir, 'tokens.json'),
    dataDir: resolve(overrides.dataDir || env.LIFEOS_DATA_DIR || file.dataDir || './data'),
    appOrigins: parseOrigins(origins),
    host: overrides.host || env.LIFEOS_HOST || file.host || '127.0.0.1',
    port: num(overrides.port ?? env.LIFEOS_PORT ?? file.port, 8787, 0, 65535),
    // Behind Caddy on the same machine the client address arrives in X-Forwarded-For; only then is it trusted for rate limits.
    trustProxy: overrides.trustProxy ?? (env.LIFEOS_TRUST_PROXY ? env.LIFEOS_TRUST_PROXY === '1' : file.trustProxy === true),
    rateLimitPerMin: num(overrides.rateLimitPerMin ?? file.rateLimitPerMin, 240, 1, 100000),
    authFailPerMin: num(overrides.authFailPerMin ?? file.authFailPerMin, 10, 1, 1000),
    writePerMin: num(overrides.writePerMin ?? file.writePerMin, 60, 1, 10000),
    maxVault: num(overrides.maxVault ?? file.maxVault, LIMITS.MAX_VAULT, 1024, LIMITS.MAX_VAULT),
    maxArchive: num(overrides.maxArchive ?? file.maxArchive, LIMITS.MAX_ARCHIVE, 1024, LIMITS.MAX_ARCHIVE),
    // SEC-137: bodies buffered at the same time (each up to 64 MB). The app sends one at a time.
    maxUploads: num(overrides.maxUploads ?? file.maxUploads, 2, 1, 16),
    log: overrides.log || ((line) => process.stdout.write(line + '\n')),
    now: overrides.now || (() => Date.now()),
  };
  if (!cfg.appOrigins.length) throw new Error('Set at least one app origin (appOrigins in config.json or LIFEOS_APP_ORIGINS).');
  return cfg;
}
