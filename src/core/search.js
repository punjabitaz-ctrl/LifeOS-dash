(function () {
  'use strict';
  // v1.6.0 B18: search across every area. One in-memory index of the text the owner typed (titles, names, notes, facts) in each
  // collection. It is built when the vault unlocks, includes private-vault records and Wellbeing notes only while the private vault is
  // open, and is dropped on lock and on private-vault close. It is never written anywhere (no storage, no history, no URL, no network,
  // no diagnostic) and never reaches a prompt. Matching is plain substring matching on folded text: case and accents are ignored and no
  // RegExp is ever built from what the user types.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const BIDI = /[؜​-‏‪-‮⁠-⁩﻿]/g;
  const MARKS = /[̀-ͯ]/g;
  const PER_AREA = 20, TOTAL_CAP = 200, MAX_QUERY = 100, LABEL_MAX = 120, SNIP_MAX = 90;
  // Folding: compatibility-normalise (full-width and composed forms), drop invisible characters, drop accents, fold case, collapse whitespace.
  const fold = (s) => String(s == null ? '' : s).normalize('NFKC').replace(BIDI, '').normalize('NFD').replace(MARKS, '').toLowerCase().replace(/\s+/g, ' ').trim();

  // area key -> [label, view key]. The view key is a navigation key (nav.js).
  const AREAS = Object.freeze({
    money: ['Money', 'v:money'], assets: ['Assets', 'v:assets'], work: ['Work', 'v:work'], jobs: ['Job search', 'v:jobs'], health: ['Health', 'v:health'], goals: ['Goals', 'v:goals'],
    home: ['Home and property', 'v:home'], admin: ['Admin', 'v:admin'], learning: ['Learning', 'v:learning'], activities: ['Activities', 'v:activities'], social: ['Social', 'v:social'],
    business: ['Business', 'business'], wellbeing: ['Wellbeing', 'v:wellbeing'],
  });
  const ORDER = Object.keys(AREAS);
  const COLL_AREA = {
    accounts: 'assets', recurring: 'money', budgets: 'money', projects: 'work', pipeline: 'work', goals: 'goals', maintenance: 'home', vehicles: 'home', properties: 'home', renewals: 'admin',
    documents: 'admin', taxItems: 'admin', learningItems: 'learning', studySessions: 'learning', takeaways: 'learning', activities: 'activities', people: 'social', groups: 'social', contacts: 'social',
    habits: 'health', invoices: 'business', trips: 'business', payees: 'business', taxPayments: 'business',
  };
  const ENTRY_AREA = { money: 'money', assets: 'assets', work: 'work', health: 'health', goals: 'goals', home: 'home', admin: 'admin', learning: 'learning', activities: 'activities', social: 'social', wellbeing: 'wellbeing' };
  // Fields that hold a fixed list value, an id, a key or a date are not typed text: they are left out of the index.
  const SKIP = new Set(['id', 'importKey', 'createdAt', 'updatedAt', 'kind', 'type', 'state', 'status', 'stage', 'cadence', 'channel', 'scope', 'unit', 'locationType', 'lostReason', 'domain', 'monthDay', 'repeat', 'severity']);
  const LABELS = ['title', 'name', 'text', 'label', 'role', 'org', 'category', 'number', 'nextAction', 'provider', 'notes'];
  const DATEISH = /^\d{4}-\d{2}(-\d{2})?(T[\d:.]+Z?)?$/;
  let index = null;

  function collect(rec, out, depth) {
    if (depth > 2 || rec === null || typeof rec !== 'object') return;
    if (Array.isArray(rec)) { for (const v of rec.slice(0, 100)) { if (typeof v === 'string') addText(v, out); else collect(v, out, depth + 1); } return; }
    for (const k of Object.keys(rec)) {
      if (SKIP.has(k) || /Ids?$/.test(k)) continue;
      const v = rec[k];
      if (typeof v === 'string') addText(v, out);
      else if (v && typeof v === 'object') collect(v, out, depth + 1);
    }
  }
  function addText(v, out) {
    if (!v || v.length > 20000 || DATEISH.test(v)) return;
    const f = fold(v);
    if (f) out.push({ raw: v, f });
  }
  function labelOf(rec) {
    for (const k of LABELS) if (typeof rec[k] === 'string' && rec[k].trim()) return (k === 'number' ? 'Invoice ' : '') + rec[k].trim().slice(0, LABEL_MAX);
    return '';
  }
  function docOf(area, coll, rec, isPriv) {
    const fields = [];
    collect(rec, fields, 0);
    if (!fields.length) return null;
    return { area, coll, id: typeof rec.id === 'string' ? rec.id : '', label: labelOf(rec) || fields[0].raw.slice(0, LABEL_MAX), fields, priv: !!isPriv };
  }
  const listOf = (s, k) => (s && Array.isArray(s[k]) ? s[k] : []);

  // Builds from the live state: the main state alone while the private vault is closed; the merged view (private records included) and
  // the Wellbeing notes while it is open.
  function build() {
    if (!L.store || !L.store.isUnlocked()) { drop(); return null; }
    const main = L.store.getState(), open = !!(L.priv && L.priv.isOpen()), src = open ? L.priv.view(main) : main, docs = [];
    const isPriv = (r) => open && L.priv.isPrivateRecord(r);
    for (const e of listOf(src, 'entries')) {
      if (e.domain === 'wellbeing' && !open) continue;
      const d = docOf(ENTRY_AREA[e.domain] || 'work', 'entries', e, isPriv(e));
      if (d) docs.push(d);
    }
    for (const c of Object.keys(COLL_AREA)) {
      for (const r of listOf(src, c)) {
        const area = c === 'pipeline' && r.kind === 'job' ? 'jobs' : COLL_AREA[c];
        const d = docOf(area, c, r, isPriv(r));
        if (d) docs.push(d);
      }
    }
    if (open && L.priv.getWellbeing) {
      let wb = null;
      try { wb = L.priv.getWellbeing(); } catch (e) { wb = null; }
      for (const c of (wb && Array.isArray(wb.checkins) ? wb.checkins : [])) {
        if (typeof c.note !== 'string' || !c.note) continue;
        const f = fold(c.note);
        if (f) docs.push({ area: 'wellbeing', coll: 'wellbeing', id: c.id, label: 'Check-in ' + c.date, fields: [{ raw: c.note, f }], priv: true });
      }
    }
    index = { docs, priv: open, stale: false };
    return index;
  }
  const drop = () => { index = null; };
  const invalidate = () => { if (index) index.stale = true; };
  const isBuilt = () => !!index;
  const hasPrivate = () => !!(index && index.priv);

  // query(q): { q, total, truncated, groups:[{ area, label, key, count, items:[{ id, coll, label, match, priv }] }] }
  function query(q) {
    const needle = fold(typeof q === 'string' ? q.slice(0, MAX_QUERY) : '');
    const out = { q: needle, total: 0, truncated: false, groups: [] };
    if (!L.store || !L.store.isUnlocked()) { drop(); return out; }
    if (!needle) return out;
    if (!index || index.stale || index.priv !== !!(L.priv && L.priv.isOpen())) build();
    const by = new Map();
    for (const d of index.docs) {
      let hit = -1;
      for (let i = 0; i < d.fields.length; i++) if (d.fields[i].f.indexOf(needle) >= 0) { hit = i; break; }
      if (hit < 0) continue;
      out.total++;
      let g = by.get(d.area);
      if (!g) { g = { area: d.area, label: AREAS[d.area][0], key: AREAS[d.area][1], count: 0, items: [] }; by.set(d.area, g); }
      g.count++;
      if (g.items.length < PER_AREA && out.total <= TOTAL_CAP * 5) {
        const raw = d.fields[hit].raw;
        g.items.push({ id: d.id, coll: d.coll, label: d.label, match: raw === d.label ? '' : raw.replace(/\s+/g, ' ').slice(0, SNIP_MAX), priv: d.priv });
      }
    }
    out.groups = ORDER.filter((a) => by.has(a)).map((a) => by.get(a));
    out.truncated = out.groups.some((g) => g.count > g.items.length);
    return out;
  }
  // The private vault closing drops everything (a private record must not stay findable); the next search rebuilds from the main state.
  if (L.priv && typeof L.priv.onClose === 'function') L.priv.onClose(() => { drop(); });

  L.search = { AREAS, ORDER, PER_AREA, fold, build, drop, invalidate, isBuilt, hasPrivate, query };
})();
