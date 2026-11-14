(function () {
  'use strict';
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const MAX_BYTES = 5 * 1024 * 1024, MAX_ROWS = 20000, MAX_COLS = 100, MAX_CELL = 10000;
  const DANGER = /^[=+\-@\t\r\n]/;

  function parse(text) {
    if (typeof text !== 'string') throw new Error('CSV must be text');
    if (text.length > MAX_BYTES || (text.length * 3 > MAX_BYTES && new TextEncoder().encode(text).length > MAX_BYTES))
      throw new Error('CSV is larger than 5 MB');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [], cell = '', inQ = false, quoted = false;
    const endCell = () => {
      if (cell.length > MAX_CELL) throw new Error('A CSV cell is too long');
      row.push(cell); cell = ''; quoted = false;
      if (row.length > MAX_COLS) throw new Error('CSV has too many columns');
    };
    const endRow = () => {
      const blank = row.length === 0 && cell === '' && !quoted;
      if (!blank) { endCell(); rows.push(row); if (rows.length > MAX_ROWS + 1) throw new Error('CSV has more than 20000 rows'); }
      row = [];
    };
    const n = text.length;
    for (let i = 0; i < n; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
        else cell += c;
      } else if (c === '"' && cell === '' && !quoted) { inQ = true; quoted = true; }
      else if (c === ',') endCell();
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); }
      else cell += c;
      if (cell.length > MAX_CELL) throw new Error('A CSV cell is too long');
    }
    if (inQ) throw new Error('CSV has an unterminated quote');
    if (cell !== '' || row.length || quoted) endRow();
    if (!rows.length) throw new Error('CSV is empty');
    return { headers: rows[0].map((h) => h.trim()), rows: rows.slice(1) };
  }

  const unneutralise = (s) => (/^'[=+\-@\t\r\n]/.test(s) ? s.slice(1) : s);
  function normDate(s) {
    s = s.trim();
    let m = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/.exec(s);
    if (m) return m[1];
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
    return s;
  }
  function normNum(s) {
    const t = s.replace(/[\s,$€£]/g, '');
    if (t.length > 40 || !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return NaN;
    return Number(t);
  }
  const EXTRA = ['status', 'person', 'due', 'kind'];
  const NUMERIC = ['value', 'minutes', 'effort'];

  function toEntries(parsed, opts) {
    if (!parsed || !Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) throw new Error('Nothing to import');
    const { domain, type, map } = opts || {};
    const dom = L.DOMAINS.find((d) => d.id === domain);
    if (!dom || !dom.types.some((t) => t.id === type)) throw new Error('Unknown domain or type');
    // SEC-65: wellbeing lives only in the private vault, so it is never imported into the main state.
    if (domain === 'wellbeing') throw new Error('Wellbeing is kept only in the private vault and cannot be imported.');
    if (!map || typeof map !== 'object') throw new Error('Column mapping required');
    const tfields = dom.types.find((t) => t.id === type).fields;
    // Only fields the selected type has may be mapped; its required fields must be mapped.
    for (const k of NUMERIC.concat(EXTRA)) {
      const given = !(map[k] === undefined || map[k] === null || map[k] === '');
      const f = tfields.find((x) => x.id === k);
      if (given && !f) throw new Error('This type has no ' + k + ' field');
      if (!given && f && f.required) throw new Error(f.label + ' column is required');
    }
    const idx = {};
    for (const k of ['date', 'title', 'notes'].concat(NUMERIC, EXTRA)) {
      const m = map[k];
      if (m === undefined || m === null || m === '') continue;
      const i = typeof m === 'number' ? m : parsed.headers.indexOf(m);
      if (!Number.isInteger(i) || i < 0 || i >= parsed.headers.length) throw new Error('Column not found for ' + k);
      idx[k] = i;
    }
    if (idx.date === undefined || idx.title === undefined) throw new Error('Date and title columns are required');
    const entries = [];
    let rejected = 0;
    for (const r of parsed.rows) {
      if (!Array.isArray(r) || r.length !== parsed.headers.length) { rejected++; continue; }
      const cell = (k) => (idx[k] === undefined ? '' : unneutralise(String(r[idx[k]])));
      try {
        const p = { domain, type, date: normDate(cell('date')), title: cell('title') };
        for (const k of NUMERIC) {
          if (idx[k] === undefined || cell(k).trim() === '') continue;
          p[k] = normNum(cell(k));
          if (Number.isNaN(p[k])) throw new Error('bad number');
        }
        if (idx.notes !== undefined) p.notes = cell('notes');
        for (const k of EXTRA) {
          if (idx[k] === undefined) continue;
          p[k] = k === 'status' ? cell(k).trim().toLowerCase() : k === 'kind' ? cell(k).trim() : cell(k);
        }
        entries.push(L.metrics.validateEntry(p));
      } catch (e) { rejected++; }
    }
    return { entries, rejected };
  }

  function toCsv(cols, rows) {
    const q = (v) => {
      let s = v === undefined || v === null ? '' : String(v);
      if (DANGER.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const lines = [cols.map(q).join(',')];
    // CSV exports never carry private records, even if a caller hands them over.
    for (const e of rows || []) if (!(L.priv && L.priv.isPrivateRecord(e))) lines.push(cols.map((c) => q(e[c])).join(','));
    return lines.join('\r\n') + '\r\n';
  }
  const exportEntries = (entries) => toCsv(['id', 'domain', 'type', 'date', 'title', 'value', 'status', 'person', 'due', 'notes', 'createdAt', 'kind', 'minutes', 'effort', 'projectId'], entries);
  const exportPipeline = (items) => toCsv(['id', 'title', 'org', 'kind', 'stage', 'source', 'nextStep', 'nextDate', 'updatedAt', 'notes'], items);
  const exportProjects = (items) => toCsv(['id', 'name', 'kind', 'status', 'nextAction', 'nextDate', 'archived'], items);

  L.csv = { parse, toEntries, exportEntries, exportPipeline, exportProjects };
})();
