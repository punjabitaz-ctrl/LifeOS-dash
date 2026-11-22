(function () {
  'use strict';
  // v1.7.0 B16: Podcasts and Websites. Shows (each with its own platform list), episodes (idea to published, guests from Social, a publish
  // date per format and platform), numbers the owner types per platform, and sites (domain, hosting, renewals that become Admin renewals,
  // monthly traffic). Manual entry first: nothing is seeded except generic platform names offered when a show is created.
  // Rules that hold everywhere below:
  // - Numbers are never summed across different measures and never estimated. A month with no number is null ("no data"), never 0 or NaN.
  // - Show names, episode titles, platform names, domains, hosts, people and notes stay in the vault; only counts reach the digest.
  // - Renewals made for a site get generic titles, so not even the calendar file's "real titles" option can carry a domain.
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  const DEFAULT_PLATFORMS = Object.freeze(['YouTube', 'Spotify', 'Apple Podcasts', 'YouTube Podcasts', 'Website']);
  const MEASURES = Object.freeze(['views', 'downloads', 'listens', 'reads', 'subscribers', 'followers']);
  const POINT_MEASURES = Object.freeze(['subscribers', 'followers']); // a level at a moment: the month shows the latest, never a sum
  const FORMATS = Object.freeze(['video', 'audio', 'text']);
  const EP_STATUS = Object.freeze(['idea', 'booked', 'recorded', 'edited', 'published']);
  const PURPOSES = Object.freeze(['business', 'show', 'personal', 'other']);
  const SHOW_CAP = 50, EP_CAP = 5000, STAT_CAP = 20000, SITE_CAP = 100, TRAFFIC_CAP = 6000, PLATFORM_CAP = 20, GUEST_CAP = 20, PUB_CAP = 60;
  const NAME_MAX = 200, NOTES_MAX = 2000, DOMAIN_MAX = 253, MAX_NUM = 1e12, MAX_CENTS = 100000000000;
  const BIDI = /[؜​-‏‪-‮⁠-⁩﻿]/g;
  const V = () => L.validate, M = () => L.metrics;
  const list = (state, k) => (state && Array.isArray(state[k]) ? state[k] : []);
  const given = (v) => v !== undefined && v !== null && v !== '';
  const fail = (m) => { throw new Error(m); };
  const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) && s >= '1900-01' && s <= '2200-12';

  // ---- validation ----
  const idList = (v, max, name, keep) => [...new Set(V().arr(v === undefined ? [] : v, max, name).map((x) => V().str(x, 100, name)))].filter((x) => !keep || keep.has(x));
  const link = (v, keep, name) => { if (!given(v)) return undefined; const s = V().str(v, 100, name); return keep.has(s) ? s : undefined; };
  const txt = (v, max, name, empty) => V().str(V().strip(V().str(v === undefined ? '' : v, max, name, true)).trim(), max, name, empty);
  const ident = (x, seen, name) => { if (!V().isObj(x)) V().fail(name); const id = V().str(x.id, 100, name + ' id'); if (seen.has(id)) V().fail('duplicate ' + name + ' id'); seen.add(id); return id; };
  const optInt = (v, hi, name) => (v === undefined || v === null || v === '' ? undefined : V().num(v, 0, hi, name, true));

  function cleanPlatforms(v) {
    const seen = new Set(), names = new Set();
    return V().arr(v === undefined ? [] : v, PLATFORM_CAP, 'platforms').map((p) => {
      if (!V().isObj(p)) V().fail('platform');
      const id = V().str(p.id, 100, 'platform id');
      if (seen.has(id)) V().fail('duplicate platform id');
      seen.add(id);
      const name = txt(p.name, 60, 'platform name');
      names.add(name);
      return { id, name };
    });
  }
  // ctx: { projects, people, sites, shows, episodes } cleaned lists to check links against.
  function cleanShows(l, ctx) {
    if (l === undefined || l === null) return [];
    const seen = new Set(), pr = new Set(((ctx && ctx.projects) || []).map((p) => p.id)), sites = new Set(((ctx && ctx.sites) || []).map((p) => p.id));
    return V().arr(l, SHOW_CAP, 'shows').map((x) => {
      const o = { id: ident(x, seen, 'show'), name: txt(x.name, NAME_MAX, 'show name') };
      const s = link(x.siteId, sites, 'show site'); if (s) o.siteId = s;
      const p = link(x.projectId, pr, 'show line of work'); if (p) o.projectId = p;
      o.platforms = cleanPlatforms(x.platforms);
      o.notes = txt(x.notes, NOTES_MAX, 'show notes', true);
      return o;
    });
  }
  function cleanEpisodes(l, ctx) {
    if (l === undefined || l === null) return [];
    const seen = new Set(), shows = new Map(((ctx && ctx.shows) || []).map((s) => [s.id, s])), ppl = new Set(((ctx && ctx.people) || []).map((p) => p.id));
    const out = [];
    for (const x of V().arr(l, EP_CAP, 'episodes')) {
      const id = ident(x, seen, 'episode'), showId = V().str(x.showId, 100, 'episode show');
      const show = shows.get(showId);
      if (!show) continue; // an episode of a show that is gone has nowhere to live
      const o = { id, showId, title: txt(x.title, NAME_MAX, 'episode title'), status: V().oneOf(x.status === undefined ? 'idea' : x.status, EP_STATUS, 'episode status') };
      const n = optInt(x.number, 100000, 'episode number'); if (n !== undefined) o.number = n;
      if (given(x.recordedOn)) o.recordedOn = V().date(x.recordedOn, 'record date');
      o.guestIds = idList(x.guestIds, GUEST_CAP, 'episode guests', ppl);
      const pids = new Set(show.platforms.map((p) => p.id)), pseen = new Set();
      o.pubs = V().arr(x.pubs === undefined ? [] : x.pubs, PUB_CAP, 'episode releases').map((p) => {
        if (!V().isObj(p)) V().fail('episode release');
        return { format: V().oneOf(p.format, FORMATS, 'release format'), platformId: V().str(p.platformId, 100, 'release platform'), date: V().date(p.date, 'release date') };
      }).filter((p) => { const k = p.format + '|' + p.platformId; if (!pids.has(p.platformId) || pseen.has(k)) return false; pseen.add(k); return true; });
      o.notes = txt(x.notes, NOTES_MAX, 'episode notes', true);
      out.push(o);
    }
    return out;
  }
  function cleanStats(l, ctx) {
    if (l === undefined || l === null) return [];
    const seen = new Set(), shows = new Map(((ctx && ctx.shows) || []).map((s) => [s.id, s])), eps = new Map(((ctx && ctx.episodes) || []).map((e) => [e.id, e]));
    const out = [];
    for (const x of V().arr(l, STAT_CAP, 'platform numbers')) {
      const id = ident(x, seen, 'platform number'), showId = V().str(x.showId, 100, 'number show'), platformId = V().str(x.platformId, 100, 'number platform');
      const show = shows.get(showId);
      const o = { id, showId, platformId, date: V().date(x.date, 'number date'), measure: V().oneOf(x.measure, MEASURES, 'number measure'), value: V().num(x.value, 0, MAX_NUM, 'number value', true) };
      if (!show || !show.platforms.some((p) => p.id === platformId)) continue;
      if (given(x.episodeId)) { const e = eps.get(V().str(x.episodeId, 100, 'number episode')); if (e && e.showId === showId) o.episodeId = e.id; }
      out.push(o);
    }
    return out;
  }
  function cleanSites(l, ctx) {
    if (l === undefined || l === null) return [];
    const seen = new Set(), pr = new Set(((ctx && ctx.projects) || []).map((p) => p.id)), ren = new Set(((ctx && ctx.renewals) || []).map((p) => p.id)), shows = new Set(((ctx && ctx.shows) || []).map((s) => s.id));
    return V().arr(l, SITE_CAP, 'sites').map((x) => {
      const o = { id: ident(x, seen, 'site'), hostname: txt(x.hostname, DOMAIN_MAX, 'domain'), kind: V().oneOf(x.kind === undefined ? 'business' : x.kind, PURPOSES, 'site purpose') };
      const p = link(x.projectId, pr, 'site line of work'); if (p) o.projectId = p;
      const sh = link(x.showId, shows, 'site show'); if (sh) o.showId = sh;
      o.host = txt(x.host, NAME_MAX, 'hosting provider', true);
      const d = link(x.domainRenewalId, ren, 'site domain renewal'); if (d) o.domainRenewalId = d;
      const h = link(x.hostingRenewalId, ren, 'site hosting renewal'); if (h) o.hostingRenewalId = h;
      o.notes = txt(x.notes, NOTES_MAX, 'site notes', true);
      return o;
    });
  }
  function cleanTraffic(l, ctx) {
    if (l === undefined || l === null) return [];
    const seen = new Set(), keys = new Set(), sites = new Set(((ctx && ctx.sites) || []).map((s) => s.id)), out = [];
    for (const x of V().arr(l, TRAFFIC_CAP, 'site traffic')) {
      const id = ident(x, seen, 'traffic'), siteId = V().str(x.siteId, 100, 'traffic site');
      if (!sites.has(siteId)) continue;
      if (typeof x.month !== 'string' || !isMonth(x.month)) V().fail('traffic month');
      const k = siteId + '|' + x.month; if (keys.has(k)) V().fail('duplicate traffic month');
      keys.add(k);
      const o = { id, siteId, month: x.month, visits: V().num(x.visits, 0, MAX_NUM, 'visits', true) };
      const v = optInt(x.visitors, MAX_NUM, 'visitors'); if (v !== undefined) o.visitors = v;
      out.push(o);
    }
    return out;
  }

  // ---- input checks for the add and edit functions ----
  function text(v, max, name, req) {
    const s = String(v == null ? '' : v).replace(BIDI, '').replace(/\s+/g, ' ').trim();
    if (req && !s) fail('Enter the ' + name + '.');
    if (s.length > max) fail('The ' + name + ' can be up to ' + max + ' characters.');
    if (L.admin && L.admin.looksSecret(s)) fail('That looks like an ID number or a card number. Do not enter ID numbers, account numbers or passwords here.');
    return s;
  }
  function notesText(v) {
    const s = String(v == null ? '' : v).replace(BIDI, '').trim();
    if (s.length > NOTES_MAX) fail('The notes can be up to ' + NOTES_MAX + ' characters.');
    if (L.admin && L.admin.looksSecret(s)) fail('That looks like an ID number or a card number. Do not enter ID numbers, account numbers or passwords here.');
    return s;
  }
  function countIn(v, name, hi) {
    const s = String(v == null ? '' : v).trim().replace(/,/g, '');
    if (!/^\d{1,13}$/.test(s) || Number(s) > (hi || MAX_NUM)) fail('The ' + name + ' must be a whole number from 0 to ' + (hi || MAX_NUM).toLocaleString('en-US') + '.');
    return Number(s);
  }
  const dateIn = (v, name) => { if (!M().isDate(v)) fail('The ' + name + ' must be a valid date.'); return v; };
  const find = (state, coll, id, what) => { const r = list(state, coll).find((x) => x.id === id); if (!r) fail(what + ' not found'); return r; };
  const newId = () => L.store.newId();
  const capCheck = (state, k, cap, what) => { if (list(state, k).length >= cap) fail('You can keep up to ' + cap + ' ' + what + '.'); };

  // ---- shows ----
  // input: { name, siteId, projectId, notes, defaults (true: offer the default platform list) }
  function addShow(state, input) {
    capCheck(state, 'shows', SHOW_CAP, 'shows');
    if (!V().isObj(input)) fail('Show must be an object');
    const o = { id: newId(), name: text(input.name, NAME_MAX, 'show name', true), platforms: input.defaults === false ? [] : DEFAULT_PLATFORMS.map((n) => ({ id: newId(), name: n })), notes: notesText(input.notes) };
    if (given(input.siteId)) { find(state, 'sites', input.siteId, 'Site'); o.siteId = input.siteId; }
    if (given(input.projectId)) { find(state, 'projects', input.projectId, 'Line of work'); o.projectId = input.projectId; }
    state.shows = list(state, 'shows').concat([o]);
    return o;
  }
  function updateShow(state, id, input) {
    const s = find(state, 'shows', id, 'Show');
    s.name = text(input.name, NAME_MAX, 'show name', true); s.notes = notesText(input.notes);
    if (given(input.siteId)) { find(state, 'sites', input.siteId, 'Site'); s.siteId = input.siteId; } else delete s.siteId;
    if (given(input.projectId)) { find(state, 'projects', input.projectId, 'Line of work'); s.projectId = input.projectId; } else delete s.projectId;
    return s;
  }
  // Deleting a show deletes its episodes and numbers (the UI says so); sites and lines of work are never touched.
  function deleteShow(state, id) {
    find(state, 'shows', id, 'Show');
    state.shows = state.shows.filter((s) => s.id !== id);
    state.episodes = list(state, 'episodes').filter((e) => e.showId !== id);
    state.platformStats = list(state, 'platformStats').filter((x) => x.showId !== id);
    for (const s of list(state, 'sites')) if (s.showId === id) delete s.showId;
  }
  function addPlatform(state, showId, name) {
    const s = find(state, 'shows', showId, 'Show'), n = text(name, 60, 'platform name', true);
    if (s.platforms.length >= PLATFORM_CAP) fail('A show can have up to ' + PLATFORM_CAP + ' platforms.');
    if (s.platforms.some((p) => p.name.toLowerCase() === n.toLowerCase())) fail('That platform is already on this show.');
    const p = { id: newId(), name: n };
    s.platforms = s.platforms.concat([p]);
    return p;
  }
  function renamePlatform(state, showId, platformId, name) {
    const s = find(state, 'shows', showId, 'Show'), p = s.platforms.find((x) => x.id === platformId), n = text(name, 60, 'platform name', true);
    if (!p) fail('Platform not found');
    if (s.platforms.some((x) => x.id !== platformId && x.name.toLowerCase() === n.toLowerCase())) fail('That platform is already on this show.');
    p.name = n;
    return p;
  }
  // Removing a platform removes the release dates and numbers entered for it.
  function removePlatform(state, showId, platformId) {
    const s = find(state, 'shows', showId, 'Show');
    if (!s.platforms.some((p) => p.id === platformId)) fail('Platform not found');
    s.platforms = s.platforms.filter((p) => p.id !== platformId);
    for (const e of list(state, 'episodes')) if (e.showId === showId) e.pubs = e.pubs.filter((p) => p.platformId !== platformId);
    state.platformStats = list(state, 'platformStats').filter((x) => !(x.showId === showId && x.platformId === platformId));
  }

  // ---- episodes ----
  // input: { showId, title, number, status, recordedOn, guestIds, notes }
  function episodeFields(state, input, show) {
    if (!V().isObj(input)) fail('Episode must be an object');
    const o = { title: text(input.title, NAME_MAX, 'episode title', true), notes: notesText(input.notes) };
    const st = given(input.status) ? input.status : 'idea';
    if (!EP_STATUS.includes(st)) fail('Pick a status from the list.');
    o.status = st;
    if (given(input.number)) o.number = countIn(input.number, 'episode number', 100000);
    if (given(input.recordedOn)) o.recordedOn = dateIn(input.recordedOn, 'record date');
    const g = [...new Set(Array.isArray(input.guestIds) ? input.guestIds : [])];
    if (g.length > GUEST_CAP) fail('An episode can have up to ' + GUEST_CAP + ' guests.');
    for (const id of g) if (!list(state, 'people').some((p) => p.id === id)) fail('Guest not found');
    o.guestIds = g;
    return o;
  }
  function addEpisode(state, input) {
    capCheck(state, 'episodes', EP_CAP, 'episodes');
    const show = find(state, 'shows', input && input.showId, 'Show'), f = episodeFields(state, input, show);
    const e = Object.assign({ id: newId(), showId: show.id, pubs: [] }, f);
    state.episodes = list(state, 'episodes').concat([e]);
    return e;
  }
  function updateEpisode(state, id, input) {
    const e = find(state, 'episodes', id, 'Episode'), f = episodeFields(state, input, null);
    e.title = f.title; e.notes = f.notes; e.status = f.status; e.guestIds = f.guestIds;
    if (f.number !== undefined) e.number = f.number; else delete e.number;
    if (f.recordedOn) e.recordedOn = f.recordedOn; else delete e.recordedOn;
    return e;
  }
  function deleteEpisode(state, id) {
    find(state, 'episodes', id, 'Episode');
    state.episodes = state.episodes.filter((e) => e.id !== id);
    state.platformStats = list(state, 'platformStats').filter((x) => x.episodeId !== id);
  }
  // A publish date for one format on one platform; an empty date removes it. Setting a date never changes the status by itself.
  function setRelease(state, episodeId, format, platformId, date) {
    const e = find(state, 'episodes', episodeId, 'Episode'), show = find(state, 'shows', e.showId, 'Show');
    if (!FORMATS.includes(format)) fail('Pick a format from the list.');
    if (!show.platforms.some((p) => p.id === platformId)) fail('Platform not found');
    const rest = e.pubs.filter((p) => !(p.format === format && p.platformId === platformId));
    if (given(date)) { if (rest.length >= PUB_CAP) fail('An episode can have up to ' + PUB_CAP + ' release dates.'); rest.push({ format, platformId, date: dateIn(date, 'release date') }); }
    e.pubs = rest;
    return e;
  }
  const publishedOn = (e) => (e.status === 'published' && e.pubs.length ? e.pubs.map((p) => p.date).sort()[0] : null);

  // ---- platform numbers: typed in, one per platform, measure, date and (optionally) episode; typing the same again replaces it ----
  // input: { showId, platformId, measure, value, date, episodeId }
  function addStat(state, input, today) {
    if (!V().isObj(input)) fail('Number must be an object');
    const show = find(state, 'shows', input.showId, 'Show');
    if (!show.platforms.some((p) => p.id === input.platformId)) fail('Pick a platform from the list.');
    if (!MEASURES.includes(input.measure)) fail('Pick a measure from the list.');
    const o = { showId: show.id, platformId: input.platformId, measure: input.measure, value: countIn(input.value, 'number'), date: given(input.date) ? dateIn(input.date, 'date') : (M().isDate(today) ? today : M().todayISO()) };
    if (given(input.episodeId)) { const e = find(state, 'episodes', input.episodeId, 'Episode'); if (e.showId !== show.id) fail('That episode is on another show.'); o.episodeId = e.id; }
    const same = (x) => x.showId === o.showId && x.platformId === o.platformId && x.measure === o.measure && x.date === o.date && (x.episodeId || '') === (o.episodeId || '');
    const rest = list(state, 'platformStats').filter((x) => !same(x));
    if (rest.length >= STAT_CAP) fail('You can keep up to ' + STAT_CAP + ' platform numbers.');
    const rec = Object.assign({ id: newId() }, o);
    state.platformStats = rest.concat([rec]);
    return rec;
  }
  function deleteStat(state, id) { find(state, 'platformStats', id, 'Number'); state.platformStats = state.platformStats.filter((x) => x.id !== id); }
  const monthsBack = (end, n) => { const out = []; for (let i = n - 1; i >= 0; i--) out.push(M().addMonths(end, -i)); return out; };
  // Per platform and measure: the latest number, and the last `n` months. A flow measure (views, downloads, listens, reads) adds up the
  // month's platform-level numbers (those not tied to one episode); with none that month it adds the episode numbers. A point measure
  // (subscribers, followers) shows the latest of the month. A month with nothing typed is null. Measures are never added together.
  function platformSummary(state, showId, endMonth, n) {
    const show = find(state, 'shows', showId, 'Show'), months = monthsBack(isMonth(endMonth) ? endMonth : M().todayISO().slice(0, 7), Math.max(1, Math.min(24, n || 6)));
    const stats = list(state, 'platformStats').filter((x) => x.showId === showId), out = [];
    for (const p of show.platforms) {
      const rows = [];
      for (const measure of MEASURES) {
        const xs = stats.filter((x) => x.platformId === p.id && x.measure === measure);
        if (!xs.length) continue;
        // SEC-123: the latest is a platform-level number when one exists (the same preference as the monthly totals); an episode's own
        // number is the platform's latest only when nothing was typed for the whole platform.
        const whole = xs.filter((x) => !x.episodeId), latest = (whole.length ? whole : xs).slice().sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))[0];
        const byMonth = months.map((month) => {
          const inM = xs.filter((x) => x.date.slice(0, 7) === month);
          if (!inM.length) return { month, value: null };
          if (POINT_MEASURES.includes(measure)) return { month, value: inM.slice().sort((a, b) => b.date.localeCompare(a.date))[0].value };
          const plat = inM.filter((x) => !x.episodeId), pick = plat.length ? plat : inM;
          return { month, value: pick.reduce((s, x) => s + x.value, 0) };
        });
        rows.push({ measure, latest: { date: latest.date, value: latest.value }, months: byMonth });
      }
      out.push({ platformId: p.id, name: p.name, rows });
    }
    return out;
  }
  // One episode's numbers by platform and measure: the latest typed for each, never added across measures or platforms.
  function episodeStats(state, episodeId) {
    const e = find(state, 'episodes', episodeId, 'Episode'), show = list(state, 'shows').find((s) => s.id === e.showId), out = [];
    if (!show) return out;
    for (const p of show.platforms) for (const measure of MEASURES) {
      const xs = list(state, 'platformStats').filter((x) => x.episodeId === episodeId && x.platformId === p.id && x.measure === measure);
      if (!xs.length) continue;
      const l = xs.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))[0];
      out.push({ platformId: p.id, platform: p.name, measure, value: l.value, date: l.date });
    }
    return out;
  }
  // Cadence: episodes published per month (a month before the first published one is "no data"; later months count, so 0 is a real
  // count there), and the days since the last one (null with none).
  function cadence(state, showId, today, n) {
    const eps = list(state, 'episodes').filter((e) => (showId ? e.showId === showId : true)), dates = eps.map(publishedOn).filter(Boolean).sort();
    const months = monthsBack(today.slice(0, 7), Math.max(1, Math.min(24, n || 6))), first = dates.length ? dates[0].slice(0, 7) : null;
    const perMonth = months.map((month) => ({ month, count: first === null || month < first ? null : dates.filter((d) => d.slice(0, 7) === month).length }));
    const past = dates.filter((d) => d <= today), last = past.length ? past[past.length - 1] : null;
    return { perMonth, published: dates.length, last, gapDays: last ? Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(last + 'T00:00:00Z')) / 864e5) : null };
  }
  // Costs and revenue come from the show's line of work (existing records); null with no line. Costs count once paid (expected income
  // and unpaid items are not counted, the existing rule). Never estimated.
  function showMoney(state, show, today) {
    if (!show.projectId || !list(state, 'projects').some((p) => p.id === show.projectId)) return null;
    const scope = { kind: 'line', id: show.projectId }, ytd = L.revenue.periodRange('ytd', today), all = L.revenue.totalsIn(state, scope, '1900-01-01', today), y = L.revenue.totalsIn(state, scope, ytd.from, ytd.to);
    return { ytd: { revenueCents: y.revenueCents, expenseCents: y.expenseCents, netCents: y.netCents }, all: { revenueCents: all.revenueCents, expenseCents: all.expenseCents, netCents: all.netCents }, partial: !!(all.archivedPartial || y.archivedPartial) };
  }
  // The Social side: episodes a person appears on, newest first.
  const episodesOfGuest = (state, personId) => list(state, 'episodes').filter((e) => e.guestIds.includes(personId)).sort((a, b) => (b.recordedOn || '').localeCompare(a.recordedOn || '') || a.title.localeCompare(b.title));

  // ---- sites ----
  // input: { domain, purpose, projectId, showId, host, notes, domainRenewOn, domainCost, hostRenewOn, hostCost } (dollars as typed)
  function siteFields(state, input) {
    if (!V().isObj(input)) fail('Site must be an object');
    const purpose = given(input.purpose) ? input.purpose : 'business'; // stored as `kind` (a fixed list value, so search leaves it out)
    if (!PURPOSES.includes(purpose)) fail('Pick a purpose from the list.');
    const o = { hostname: text(input.domain, DOMAIN_MAX, 'domain', true), kind: purpose, host: text(input.host, NAME_MAX, 'hosting provider'), notes: notesText(input.notes) };
    if (given(input.projectId)) { find(state, 'projects', input.projectId, 'Line of work'); o.projectId = input.projectId; }
    if (given(input.showId)) { find(state, 'shows', input.showId, 'Show'); o.showId = input.showId; }
    for (const [d, c, n] of [['domainRenewOn', 'domainCost', 'domain renewal date'], ['hostRenewOn', 'hostCost', 'hosting renewal date']]) {
      if (given(input[d])) o[d] = dateIn(input[d], n);
      if (given(input[c])) { const cents = L.revenue.parseCents(String(input[c])); if (cents === null || cents < 0 || cents > MAX_CENTS) fail('The cost must be an amount from 0 to 1,000,000,000.'); o[c] = cents; }
    }
    return o;
  }
  // Creates (or updates) the Admin renewal behind a site date. Its title is generic on purpose; its provider is the hosting provider.
  // SEC-117: Admin chains renewals by kind, title and provider, so every site's renewal needs its own chain. The title stays generic (no
  // domain): "Domain renewal", then "Domain renewal 2" and so on, the first one no renewal in the vault uses with that kind and provider.
  const chainKey = (kind, title, provider) => kind + '|' + String(title).trim().toLowerCase() + '|' + String(provider || '').trim().toLowerCase();
  function freeTitle(state, base, kind, provider) {
    const used = new Set(list(state, 'renewals').map((r) => chainKey(r.kind, r.title, r.provider)));
    for (let n = 1; n <= 10000; n++) { const t = n === 1 ? base : base + ' ' + n; if (!used.has(chainKey(kind, t, provider))) return t; }
    return base;
  }
  function syncRenewal(state, site, which, date, cents, today) {
    const idKey = which === 'domain' ? 'domainRenewalId' : 'hostingRenewalId', base = which === 'domain' ? 'Domain renewal' : 'Hosting renewal';
    const cur = site[idKey] ? list(state, 'renewals').find((r) => r.id === site[idKey]) : null;
    if (!date) return;
    if (cur) { cur.dueDate = date; if (cents !== undefined) cur.amount = cents; return; }
    const kind = which === 'domain' ? 'registration' : 'subscription', provider = which === 'hosting' ? site.host : '';
    const r = L.admin.addRenewal(state, { title: freeTitle(state, base, kind, provider), kind, provider, dueDate: date, cadence: 'annual', amount: cents === undefined ? undefined : (cents / 100).toFixed(2) }, today);
    site[idKey] = r.id;
  }
  function addSite(state, input, today) {
    capCheck(state, 'sites', SITE_CAP, 'sites');
    const f = siteFields(state, input), s = { id: newId(), hostname: f.hostname, kind: f.kind, host: f.host, notes: f.notes };
    if (f.projectId) s.projectId = f.projectId;
    if (f.showId) s.showId = f.showId;
    syncRenewal(state, s, 'domain', f.domainRenewOn, f.domainCost, today);
    syncRenewal(state, s, 'hosting', f.hostRenewOn, f.hostCost, today);
    state.sites = list(state, 'sites').concat([s]);
    return s;
  }
  function updateSite(state, id, input, today) {
    const s = find(state, 'sites', id, 'Site'), f = siteFields(state, input);
    s.hostname = f.hostname; s.kind = f.kind; s.host = f.host; s.notes = f.notes;
    if (f.projectId) s.projectId = f.projectId; else delete s.projectId;
    if (f.showId) s.showId = f.showId; else delete s.showId;
    syncRenewal(state, s, 'domain', f.domainRenewOn, f.domainCost, today);
    syncRenewal(state, s, 'hosting', f.hostRenewOn, f.hostCost, today);
    return s;
  }
  // Link an existing Admin renewal to a site's domain or hosting; '' unlinks. Neither side is deleted.
  function linkRenewal(state, siteId, which, renewalId) {
    const s = find(state, 'sites', siteId, 'Site'), k = which === 'domain' ? 'domainRenewalId' : which === 'hosting' ? 'hostingRenewalId' : null;
    if (!k) fail('Pick domain or hosting.');
    if (given(renewalId)) { find(state, 'renewals', renewalId, 'Renewal'); s[k] = renewalId; } else delete s[k];
    return s;
  }
  // Deleting a site deletes its traffic numbers; its Admin renewals stay (they are Admin's records).
  function deleteSite(state, id) {
    find(state, 'sites', id, 'Site');
    state.sites = state.sites.filter((s) => s.id !== id);
    state.siteTraffic = list(state, 'siteTraffic').filter((t) => t.siteId !== id);
    for (const sh of list(state, 'shows')) if (sh.siteId === id) delete sh.siteId;
  }
  // input: { siteId, month 'YYYY-MM', visits, visitors } ; the same month again replaces it
  function addTraffic(state, input) {
    if (!V().isObj(input)) fail('Traffic must be an object');
    const s = find(state, 'sites', input.siteId, 'Site');
    if (!isMonth(input.month)) fail('Pick a month.');
    const o = { id: newId(), siteId: s.id, month: input.month, visits: countIn(input.visits, 'visits') };
    if (given(input.visitors)) o.visitors = countIn(input.visitors, 'visitors');
    const rest = list(state, 'siteTraffic').filter((t) => !(t.siteId === s.id && t.month === o.month));
    if (rest.length >= TRAFFIC_CAP) fail('You can keep up to ' + TRAFFIC_CAP + ' traffic months.');
    state.siteTraffic = rest.concat([o]);
    return o;
  }
  function deleteTraffic(state, id) { find(state, 'siteTraffic', id, 'Traffic month'); state.siteTraffic = state.siteTraffic.filter((t) => t.id !== id); }
  // The last n months ending at endMonth: visits and visitors, null ("no data") for a month nothing was typed.
  function trafficMonths(state, siteId, endMonth, n) {
    const xs = list(state, 'siteTraffic').filter((t) => t.siteId === siteId), months = monthsBack(isMonth(endMonth) ? endMonth : M().todayISO().slice(0, 7), Math.max(1, Math.min(36, n || 12)));
    return months.map((month) => { const t = xs.find((x) => x.month === month); return t ? { id: t.id, month, visits: t.visits, visitors: typeof t.visitors === 'number' ? t.visitors : null } : { id: null, month, visits: null, visitors: null }; });
  }
  // The open renewals behind a site, soonest first.
  function renewalsOf(state, site) {
    const out = [];
    for (const [k, id] of [['domain', site.domainRenewalId], ['hosting', site.hostingRenewalId]]) {
      const r = id ? list(state, 'renewals').find((x) => x.id === id) : null;
      if (r) out.push({ which: k, id: r.id, date: r.dueDate, amountCents: typeof r.amount === 'number' ? r.amount : null, state: r.state });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }
  // Sites with an open renewal due from today to `days` days ahead (an overdue open renewal counts too: it still needs attention).
  function sitesRenewing(state, today, days) {
    const end = M().addDays(today, days === undefined ? 30 : days);
    return list(state, 'sites').filter((s) => renewalsOf(state, s).some((r) => r.state === 'open' && r.date <= end));
  }

  // ---- digest: numbers only (the caller passes the main state) ----
  function digest(state, ws) {
    const we = M().addDays(ws, 6), mo = we.slice(0, 7);
    return { episodesThisMonth: list(state, 'episodes').filter((e) => { const d = publishedOn(e); return !!d && d.slice(0, 7) === mo; }).length, sitesRenewing: sitesRenewing(state, we, 30).length };
  }
  const hasShows = (state) => list(state, 'shows').length > 0;
  const hasSites = (state) => list(state, 'sites').length > 0;

  L.media = {
    DEFAULT_PLATFORMS, MEASURES, POINT_MEASURES, FORMATS, EP_STATUS, PURPOSES, SHOW_CAP, EP_CAP, STAT_CAP, SITE_CAP, TRAFFIC_CAP, PLATFORM_CAP, isMonth,
    cleanShows, cleanEpisodes, cleanStats, cleanSites, cleanTraffic,
    addShow, updateShow, deleteShow, addPlatform, renamePlatform, removePlatform, addEpisode, updateEpisode, deleteEpisode, setRelease, publishedOn,
    addStat, deleteStat, platformSummary, episodeStats, cadence, showMoney, episodesOfGuest,
    addSite, updateSite, linkRenewal, deleteSite, addTraffic, deleteTraffic, trafficMonths, renewalsOf, sitesRenewing, digest, hasShows, hasSites,
  };
})();
