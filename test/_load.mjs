import '../src/core/vault.js';
import '../src/core/ops.js';
import '../src/core/nav.js';
import '../src/core/setup.js';
import '../src/core/store.js';
import '../src/core/priv.js';
import '../src/core/wellbeing.js';
import '../src/core/csv.js';
import '../src/core/metrics.js';
import '../src/core/food.js';
import '../src/core/home.js';
import '../src/core/admin.js';
import '../src/core/learning.js';
import '../src/core/activities.js';
import '../src/core/social.js';
import '../src/core/revenue.js';
import '../src/core/tax.js';
import '../src/core/business.js';
import '../src/core/clients.js';
import '../src/core/media.js';
import '../src/core/layout.js';
import '../src/core/overview.js';
import '../src/core/goals.js';
import '../src/core/memory.js';
import '../src/core/ai.js';
import '../src/core/calendar.js';
import '../src/core/jobs.js';
import '../src/core/search.js';
import '../src/core/sync.js';
import '../src/core/nas.js';
import '../src/core/archive.js';
export const L = globalThis.LifeOS;
export function memAdapter() {
  const m = new Map();
  return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); }, del: async (k) => { m.delete(k); }, _m: m };
}
export const PASS = 'correct horse battery';
// v1.8.0 (envelope v2): an envelope sealed under the same data key and wraps as `env` (a copy written by this same key set), with outer fields `meta`.
export async function resealLike(env, obj, meta) {
  const V = L.vault, p = V.parseEnvelope(env), o = await V.unwrapWith(p.wraps, PASS);
  return V.sealEnvelope({ key: o.key, kek: o.kek, wraps: p.wraps }, obj, meta);
}
let n = 0;
export const E = (o) => L.metrics.validateEntry(Object.assign({ date: '2026-11-10', title: 't' + (n++) }, o));
import '../src/ui/pwa.js';
