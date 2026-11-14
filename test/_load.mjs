import '../src/core/vault.js';
import '../src/core/store.js';
import '../src/core/csv.js';
import '../src/core/metrics.js';
import '../src/core/home.js';
import '../src/core/admin.js';
import '../src/core/goals.js';
import '../src/core/memory.js';
import '../src/core/ai.js';
import '../src/core/sync.js';
export const L = globalThis.LifeOS;
export function memAdapter() {
  const m = new Map();
  return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); }, del: async (k) => { m.delete(k); }, _m: m };
}
export const PASS = 'correct horse battery';
let n = 0;
export const E = (o) => L.metrics.validateEntry(Object.assign({ date: '2026-11-10', title: 't' + (n++) }, o));
