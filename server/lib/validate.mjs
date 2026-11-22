// The service reads only the outer fields of an envelope. It never decrypts and never needs a key. Anything it stores is rebuilt from
// the known fields, so nothing else a client sends is kept. Mirrors the app's envelope shape (v1 and v2) without importing it.
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const V1_KEYS = ['v', 'kdf', 'iv', 'ct', 'rev', 'updatedAt', 'deviceId'];
const V2_KEYS = ['v', 'kdf', 'iv', 'ct', 'fmt', 'wraps', 'data', 'rev', 'updatedAt', 'deviceId', 'arch', 'year'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (m) => { const e = new Error(m); e.code = 'INVALID'; return e; };

// A small tree of scalars (kdf parameters, wraps): depth and string length bounded.
function plain(x, depth) {
  if (depth > 4) throw bad('nesting');
  if (typeof x === 'string') { if (x.length > 4096) throw bad('string'); return x; }
  if (typeof x === 'number') { if (!Number.isFinite(x)) throw bad('number'); return x; }
  if (typeof x === 'boolean') return x;
  if (Array.isArray(x)) { if (x.length > 4) throw bad('list'); return x.map((v) => plain(v, depth + 1)); }
  if (isObj(x)) {
    const keys = Object.keys(x);
    if (keys.length > 16) throw bad('object');
    const o = {};
    for (const k of keys) { if (k === '__proto__' || k.length > 40) throw bad('key'); o[k] = plain(x[k], depth + 1); }
    return o;
  }
  throw bad('value');
}
const b64 = (s, max) => { if (typeof s !== 'string' || !s || s.length > max || !B64.test(s)) throw bad('encoding'); return s; };

// opts.archiveYear: an integer when the file is an archive (arch must be 1 and year must match).
export function cleanEnvelope(text, opts = {}) {
  let o;
  try { o = JSON.parse(text); } catch (e) { throw bad('json'); }
  if (!isObj(o) || o.v !== 1 || !isObj(o.kdf)) throw bad('shape');
  const fmt2 = o.fmt !== undefined;
  if (fmt2 && o.fmt !== 2) throw bad('format');
  for (const k of Object.keys(o)) if (!(fmt2 ? V2_KEYS : V1_KEYS).includes(k) && !(opts.archiveYear !== undefined && (k === 'arch' || k === 'year'))) throw bad('field');
  const maxCt = 128 * 1024 * 1024;
  const out = { v: 1, kdf: plain(o.kdf, 0), iv: b64(o.iv, 64), ct: b64(o.ct, maxCt) };
  if (fmt2) {
    out.fmt = 2;
    if (!Array.isArray(o.wraps) || o.wraps.length < 1 || o.wraps.length > 2) throw bad('wraps');
    out.wraps = plain(o.wraps, 0);
    if (!isObj(o.data)) throw bad('data');
    for (const k of Object.keys(o.data)) if (k !== 'iv' && k !== 'ct') throw bad('data');
    out.data = { iv: b64(o.data.iv, 64), ct: b64(o.data.ct, maxCt) };
  }
  if (o.updatedAt !== undefined) { if (typeof o.updatedAt !== 'string' || o.updatedAt.length > 40) throw bad('date'); out.updatedAt = o.updatedAt; }
  if (o.deviceId !== undefined) { if (typeof o.deviceId !== 'string' || o.deviceId.length > 100) throw bad('device'); out.deviceId = o.deviceId; }
  if (o.arch !== undefined) out.arch = o.arch;
  if (o.year !== undefined) out.year = o.year;
  if (opts.archiveYear !== undefined) {
    if (out.arch !== 1 || out.year !== opts.archiveYear) throw bad('archive');
  } else {
    if (out.arch !== undefined || out.year !== undefined) throw bad('archive field on a vault');
    // The revision is how the app notices a rollback; a vault without one is refused.
    if (!Number.isInteger(o.rev) || o.rev < 0 || o.rev > 1e9) throw bad('rev');
    out.rev = o.rev;
  }
  return { env: out, rev: Number.isInteger(o.rev) ? o.rev : null };
}
export const ARCHIVE_NAME = /^lifeos-archive-(\d{4})\.json$/;
