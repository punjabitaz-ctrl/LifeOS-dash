(function () {
  'use strict';
  // v1.5.0 B17: a calendar file (.ics) of dated items in the next 12 months. Built locally from the vault state and handed to a download;
  // no network, no feed. Event UIDs are a hash of the item kind and id, so importing the file again updates rather than duplicates.
  // Titles are generic by kind unless the owner ticks "Include real titles". Notes, amounts, places and people are never written
  // in either mode. Private-vault items are left out unless the vault is open and the owner ticks "Include private items".
  // No user text can reach the iCalendar structure: text values are escaped (backslash, semicolon, comma, line breaks), other control
  // characters become spaces, and every ID and hash that appears is generated here from fixed characters.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const DAYS = 365, FOLD = 75;
  const GENERIC = Object.freeze({
    renewal: 'LifeOS: renewal due', maintenance: 'LifeOS: maintenance due', taxpay: 'LifeOS: tax payment due', filing: 'LifeOS: tax filing due', invoice: 'LifeOS: invoice due', goal: 'LifeOS: goal due',
    exam: 'LifeOS: exam', followup: 'LifeOS: follow-up due', cert: 'LifeOS: certification expires', activity: 'LifeOS: planned activity', date: 'LifeOS: important date',
  });
  const KINDS = Object.freeze(Object.keys(GENERIC));
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
  const addDays = (iso, n) => { const p = iso.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10); };
  const list = (state, k) => (state && Array.isArray(state[k]) ? state[k] : []);

  // Two 53-bit hashes (different seeds) give a fixed-length hex id from any text, so an id with odd characters never reaches the file.
  function cyrb53(str, seed) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  }
  const uidOf = (kind, id) => 'lifeos-' + cyrb53(kind + '|' + id, 1) + cyrb53(kind + '|' + id, 2) + '@lifeos.local';

  // TEXT value escaping (RFC 5545 3.3.11): backslash, semicolon and comma get a backslash; every kind of line break becomes the two
  // characters \n; other control characters become spaces. Nothing typed can start a new line in the file.
  function escape(v) {
    const parts = String(v).split(/\r\n|\r|\n|\u2028|\u2029/);
    return parts.map((p) => p.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')).join('\\n');
  }
  const utf8 = (cp) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);
  // Folding (RFC 5545 3.1): lines of at most 75 octets; a continuation starts with one space, which counts. Never splits a character.
  function fold(line) {
    const out = [];
    let cur = '', bytes = 0, limit = FOLD;
    for (const ch of line) {
      const n = utf8(ch.codePointAt(0));
      if (bytes + n > limit) { out.push(cur); cur = ' '; bytes = 1; limit = FOLD; }
      cur += ch; bytes += n;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  const ymd = (iso) => iso.replace(/-/g, '');
  const stampOf = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

  // Collect { kind, id, date, endDate?, real } rows inside [today, end].
  function collect(src, today) {
    const end = addDays(today, DAYS), rows = [];
    const add = (kind, id, date, real, endDate) => {
      if (!isDate(date) || date < today || date > end || typeof id !== 'string') return;
      const r = { kind, id, date, real: typeof real === 'string' ? real : '' };
      if (endDate && isDate(endDate) && endDate > date) r.endDate = endDate;
      rows.push(r);
    };
    // Renewals, estimated tax payments (and the 1099-NEC filing) and certification expiries come from the Admin timeline rows (open ones only).
    if (L.admin) for (const x of L.admin.dated(src)) {
      if (x.closed !== null) continue;
      if (x.src === 'renewal') add('renewal', x.id, x.date, x.title);
      else if (x.src === 'learning') add('cert', x.id, x.date, x.title);
      else if (x.src === 'taxpay') add(String(x.id).indexOf('nec1099:') === 0 ? 'filing' : 'taxpay', x.id, x.date, x.title);
    }
    for (const m of list(src, 'maintenance')) if (m.state === 'open' && m.nextDue) add('maintenance', m.id, m.nextDue, m.title);
    for (const i of list(src, 'invoices')) if (i.status === 'sent' && i.dueDate) add('invoice', i.id, i.dueDate, 'Invoice ' + i.number);
    for (const g of list(src, 'goals')) if (g.state === 'active' && g.dueDate) add('goal', g.id, g.dueDate, g.title);
    if (L.learning) for (const x of L.learning.upcomingExams(src, today)) add('exam', x.id, x.date, x.title);
    for (const a of list(src, 'activities')) if (a.state === 'planned') add('activity', a.id, a.date, a.title, a.endDate);
    // v1.6.0: follow-up dates of open job applications. The generic label names nothing; real titles are the owner's opt-in.
    if (L.jobs) for (const x of L.jobs.followUps(src, today)) add('followup', x.id, x.date, x.title);
    if (L.social) for (const x of L.social.importantDates(src, today, DAYS + 1)) add('date', x.id, x.date, x.label + ': ' + x.person);
    return rows;
  }

  // build(state, opts): opts { today:'YYYY-MM-DD' (local date), realTitles:false, includePrivate:false, stamp: Date (tests) }.
  // Returns { text, count, realTitles, privateIncluded }.
  function build(state, opts) {
    const o = opts || {};
    if (!isDate(o.today)) throw new Error('Today must be a date');
    const realTitles = o.realTitles === true;
    const base = L.priv ? L.priv.mainOnly(state) : state;
    let src = base;
    if (o.includePrivate === true && L.priv && L.priv.isOpen()) src = L.priv.view(base);
    const privateIncluded = src !== base;
    const stamp = stampOf(o.stamp instanceof Date && !isNaN(o.stamp.getTime()) ? o.stamp : new Date());
    const rows = collect(src, o.today).map((r) => Object.assign(r, { uid: uidOf(r.kind, r.id) }));
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.uid.localeCompare(b.uid));
    // The same UID twice (two rows for one record) would make a calendar merge them: keep the first.
    const seen = new Set(), uniq = rows.filter((r) => (seen.has(r.uid) ? false : (seen.add(r.uid), true)));
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LifeOS//Calendar file//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:LifeOS'];
    for (const r of uniq) {
      const title = realTitles && r.real ? 'LifeOS: ' + r.real : GENERIC[r.kind];
      lines.push('BEGIN:VEVENT', 'UID:' + r.uid, 'DTSTAMP:' + stamp, 'DTSTART;VALUE=DATE:' + ymd(r.date), 'DTEND;VALUE=DATE:' + ymd(addDays(r.endDate || r.date, 1)),
        'SUMMARY:' + escape(title), 'TRANSP:TRANSPARENT', 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return { text: lines.map(fold).join('\r\n') + '\r\n', count: uniq.length, realTitles, privateIncluded };
  }
  const filename = (today) => 'lifeos-calendar-' + today + '.ics';

  L.calendar = { DAYS, GENERIC, KINDS, build, filename, escape, fold, uidOf };
})();
