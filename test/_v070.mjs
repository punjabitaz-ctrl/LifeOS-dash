// Shared helpers for the v0.7.0 tests (home.test.mjs, admin.test.mjs). Not a test file.
import { L, memAdapter, PASS, E } from './_load.mjs';
// store.test.mjs asserts that no storage adapter exists yet, and v020.test.mjs replaces L.store and friends with the built bundle.
// Register after them (the build import is slow) and resolve modules on every use, like goals.test.mjs does.
await import('../build.mjs');
export const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
export const S = live('store'), M = live('metrics'), V = live('vault'), Mem = live('memory'), G = live('goals'), Hm = live('home'), Ad = live('admin');
export { L, memAdapter, PASS, E };
export const TODAY = '2026-11-14';          // a Saturday; its week starts 2026-11-09
export const WK = '2026-11-09';
export const clone = (x) => JSON.parse(JSON.stringify(x));
export const build = (fn) => { const s = S.defaultState(); fn(s); return S.validateState(clone(s)); };

const NEW4 = ['cycle', 'kinds', 'habits', 'habitLog'];
const NEW6 = ['properties', 'vehicles', 'maintenance', 'renewals', 'documents', 'taxItems'];
// What a vault written by an older version looks like: the new keys do not exist at all.
export function asSchema(n, s) {
  const o = clone(s); o.schema = n;
  if (n < 6) { for (const k of NEW6) delete o[k]; delete o.settings.home; for (const r of o.recurring || []) delete r.household; }
  if (n < 5) delete o.goals;
  if (n < 4) { for (const k of NEW4) delete o[k]; delete o.settings.health; }
  if (n < 3) { delete o.projects; delete o.pipeline; }
  if (n < 2) { for (const k of ['accounts', 'recurring', 'budgets', 'categories']) delete o[k]; }
  return o;
}
export const TOKEN = 'ya29.SECRETTOKENVALUE_v070_abcdefghij';
export function drive() {
  const d = { file: null, version: 1, etag: '"e1"', writes: 0 };
  const res = (status, body, headers = {}) => ({ status, ok: status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  d.put = (text) => { d.file = { id: 'file12345', text }; d.version++; d.etag = '"e' + d.version + '"'; };
  d.fetch = async (url, o) => {
    const u = new URL(url);
    if (u.pathname === '/drive/v3/files') return res(200, { files: d.file ? [{ id: d.file.id, size: String(d.file.text.length), version: String(d.version) }] : [] });
    if (u.searchParams.get('alt') === 'media') return res(200, d.file.text, { etag: d.etag });
    if (u.pathname.startsWith('/drive/v3/files/')) return res(200, { id: d.file.id, version: String(d.version) });
    d.writes++;
    if (o.method === 'POST') { d.put(o.body.split('Content-Type: application/json\r\n\r\n')[1].split('\r\n--')[0]); return res(200, { id: 'file12345' }); }
    if (o.method === 'PATCH') { d.put(o.body); return res(200, { id: 'file12345' }); }
    return res(500, 'x');
  };
  return d;
}
export async function fresh() {
  const ad = memAdapter(); S._setAdapter(ad); S.lock(); await S.init(PASS);
  const d = drive(); L.sync._setFetch(d.fetch); L.sync._setToken(TOKEN, 3600);
  return { ad, d };
}
export async function putRemote(d, content, bump) {
  const env1 = JSON.parse(d.file.text);
  const salt = V.parseEnvelope(env1).salt, key = await V.deriveKey(PASS, salt);
  const raw = await V.decrypt(key, env1);
  const m = { rev: env1.rev + bump, updatedAt: '2026-11-12T00:00:00.000Z', deviceId: 'other-device' };
  d.put(JSON.stringify(Object.assign(await V.makeEnvelope(key, salt, Object.assign(content, { settings: raw.settings, _meta: m })), m)));
}
// Record builders (valid by themselves).
let n = 0;
export const prop = (o) => Object.assign({ id: 'pr-' + (n++), name: 'Main house', kind: 'house', archived: false }, o);
export const veh = (o) => Object.assign({ id: 'vh-' + (n++), name: 'Family car', odometerUnit: 'mi', archived: false }, o);
export const maint = (o) => Object.assign({ id: 'mt-' + (n++), title: 'Task ' + n, area: '', cadence: 'once', vendor: '', notes: '', state: 'open' }, o);
export const renew = (o) => Object.assign({ id: 'rn-' + (n++), title: 'Renewal ' + n, kind: 'insurance', provider: '', dueDate: '2026-12-01', cadence: 'once', autoRenews: false, state: 'open', notes: '' }, o);
export const doc = (o) => Object.assign({ id: 'dc-' + (n++), title: 'Doc ' + n, kind: '', whereKept: '', notes: '' }, o);
export const tax = (o) => Object.assign({ id: 'tx-' + (n++), year: 2025, title: 'Item ' + n, state: 'needed', notes: '' }, o);
export const COLLECTIONS = { properties: prop, vehicles: veh, maintenance: maint, renewals: renew, documents: doc, taxItems: tax };
