// Ciphertext-only storage. Each write of the vault is one file `v<srev>-r<envelope rev>-t<ms>.json` made by writing a temp file in the
// same directory, syncing it, and renaming it into place (atomic). The newest file is the current copy; the newest KEEP_VERSIONS are kept.
// All writes run one after another in this process, so the compare-and-swap on the service revision (srev) has no race.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, openSync, fsyncSync, closeSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LIMITS } from './config.mjs';

const VFILE = /^v(\d{10})-r(\d{1,10})-t(\d{13})\.json$/;
const pad = (n) => String(n).padStart(10, '0');

export class Storage {
  constructor(dataDir, now = () => Date.now()) {
    this.vaultDir = join(dataDir, 'vault'); this.archDir = join(dataDir, 'archives'); this.now = now; this.queue = Promise.resolve();
    mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 }); mkdirSync(this.archDir, { recursive: true, mode: 0o700 });
    for (const d of [this.vaultDir, this.archDir]) for (const f of readdirSync(d)) if (f.startsWith('.tmp-')) { try { unlinkSync(join(d, f)); } catch (e) { /* ignore */ } }
  }
  serial(fn) { const r = this.queue.then(fn, fn); this.queue = r.catch(() => {}); return r; }
  versions() {
    const out = [];
    for (const f of readdirSync(this.vaultDir)) {
      const m = VFILE.exec(f);
      if (m) { let size = 0; try { size = statSync(join(this.vaultDir, f)).size; } catch (e) { continue; } out.push({ id: Number(m[1]), envRev: Number(m[2]), at: new Date(Number(m[3])).toISOString(), size, file: f }); }
    }
    return out.sort((a, b) => b.id - a.id);
  }
  current() { const v = this.versions(); return v.length ? v[0] : null; }
  readVersion(id) { const v = this.versions().find((x) => x.id === id); return v ? { meta: v, text: readFileSync(join(this.vaultDir, v.file), 'utf8') } : null; }
  _atomic(dir, name, write) {
    const tmp = join(dir, '.tmp-' + randomBytes(8).toString('hex'));
    write(tmp);
    const fd = openSync(tmp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, join(dir, name));
  }
  _prune() { for (const v of this.versions().slice(LIMITS.KEEP_VERSIONS)) { try { unlinkSync(join(this.vaultDir, v.file)); } catch (e) { /* ignore */ } } }
  // expected: a non-negative integer srev, or 'none'. Returns { ok:true, rev } or { ok:false, rev: current srev or null }.
  putVault(text, envRev, expected) {
    return this.serial(() => {
      const cur = this.current(), curId = cur ? cur.id : null;
      if (expected === 'none' ? curId !== null : curId !== expected) return { ok: false, rev: curId };
      const id = (curId === null ? -1 : curId) + 1;
      this._atomic(this.vaultDir, 'v' + pad(id) + '-r' + envRev + '-t' + String(this.now()).padStart(13, '0') + '.json', (tmp) => writeFileSync(tmp, text, { mode: 0o600 }));
      this._prune();
      return { ok: true, rev: id };
    });
  }
  // The chosen old version becomes the current copy under a new srev (its own envelope is untouched, so it stays decryptable).
  restore(versionId, expected) {
    return this.serial(() => {
      const cur = this.current(), curId = cur ? cur.id : null;
      if (curId === null || curId !== expected) return { ok: false, rev: curId, missing: false };
      const v = this.versions().find((x) => x.id === versionId);
      if (!v) return { ok: false, rev: curId, missing: true };
      const id = curId + 1;
      this._atomic(this.vaultDir, 'v' + pad(id) + '-r' + v.envRev + '-t' + String(this.now()).padStart(13, '0') + '.json', (tmp) => copyFileSync(join(this.vaultDir, v.file), tmp));
      this._prune();
      return { ok: true, rev: id };
    });
  }
  archives() {
    const out = [];
    for (const f of readdirSync(this.archDir)) {
      if (!/^lifeos-archive-\d{4}\.json$/.test(f)) continue;
      const st = statSync(join(this.archDir, f)); out.push({ name: f, size: st.size, at: new Date(st.mtimeMs).toISOString() });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }
  putArchive(name, text) {
    return this.serial(() => {
      const exists = existsSync(join(this.archDir, name));
      if (!exists && this.archives().length >= LIMITS.MAX_ARCHIVES) return { ok: false, full: true };
      this._atomic(this.archDir, name, (tmp) => writeFileSync(tmp, text, { mode: 0o600 }));
      return { ok: true };
    });
  }
  readArchive(name) { const p = join(this.archDir, name); return existsSync(p) ? readFileSync(p, 'utf8') : null; }
}
