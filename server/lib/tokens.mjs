// Device tokens: the service keeps only SHA-256 hashes, in a JSON file (mode 0600), written atomically. A presented token is hashed and
// compared against every stored hash with timingSafeEqual, with no early exit, so neither the match nor its position shows in timing.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, statSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { LIMITS } from './config.mjs';

export const TOKEN_RE = /^lfs_[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
export const hashToken = (t) => createHash('sha256').update(String(t), 'utf8').digest('hex');
export const newToken = () => 'lfs_' + randomBytes(32).toString('base64url');

export class Tokens {
  constructor(file, now = () => Date.now()) { this.file = file; this.now = now; this.sig = ''; this.devices = []; }
  _read() {
    if (!existsSync(this.file)) { this.sig = 'none'; this.devices = []; return; }
    const st = statSync(this.file), sig = st.mtimeMs + ':' + st.size;
    if (sig === this.sig) return;
    let j;
    try { j = JSON.parse(readFileSync(this.file, 'utf8')); } catch (e) { throw new Error('tokens.json is not valid JSON'); }
    if (!j || !Array.isArray(j.devices)) throw new Error('tokens.json is malformed');
    this.devices = j.devices.filter((d) => d && typeof d.name === 'string' && HASH_RE.test(d.hash)).map((d) => ({ name: d.name, hash: d.hash, createdAt: String(d.createdAt || '') }));
    this.sig = sig;
  }
  _write(devices) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp-' + randomBytes(6).toString('hex');
    writeFileSync(tmp, JSON.stringify({ v: 1, devices }, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch (e) { /* not supported on every file system */ }
    this.sig = '';
  }
  list() { this._read(); return this.devices.map((d) => ({ name: d.name, createdAt: d.createdAt })); }
  // Register by hash (the app shows the hash; the token itself never has to be copied anywhere).
  register(name, hash) {
    if (!NAME_RE.test(String(name))) throw new Error('Device names are 1 to 40 letters, digits, spaces, dots, dashes or underscores.');
    if (!HASH_RE.test(String(hash))) throw new Error('A token hash is 64 lowercase hex characters (SHA-256).');
    this._read();
    if (this.devices.length >= LIMITS.MAX_DEVICES) throw new Error('Too many devices. Revoke one first.');
    if (this.devices.some((d) => d.name.toLowerCase() === name.toLowerCase())) throw new Error('A device with that name already exists. Revoke it first.');
    if (this.devices.some((d) => d.hash === hash)) throw new Error('That token is already registered.');
    this._write(this.devices.concat([{ name, hash, createdAt: new Date(this.now()).toISOString() }]));
  }
  // Create a token on the service side; the token is returned once and never stored.
  add(name) { const t = newToken(); this.register(name, hashToken(t)); return t; }
  revoke(name) {
    this._read();
    const rest = this.devices.filter((d) => d.name.toLowerCase() !== String(name).toLowerCase());
    if (rest.length === this.devices.length) return false;
    this._write(rest);
    return true;
  }
  // Returns the device name or null. Walks every stored hash.
  check(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    this._read();
    const given = Buffer.from(hashToken(token), 'hex');
    let found = null;
    for (const d of this.devices) if (timingSafeEqual(given, Buffer.from(d.hash, 'hex')) && found === null) found = d.name;
    return found;
  }
}
