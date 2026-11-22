(function () {
  'use strict';
  const L = (globalThis.LifeOS = globalThis.LifeOS || {});
  // http://localhost or http://127.0.0.1, explicit port 1024-65535, path empty or exactly /v1. No query, fragment or credentials.
  const LOCAL_RE = /^http:\/\/(?:localhost|127\.0\.0\.1):([1-9]\d{3,4})(?:\/v1)?$/;
  const MAX_BODY = 1024 * 1024;
  function isLocalUrl(u) {
    if (typeof u !== 'string') return false;
    const m = LOCAL_RE.exec(u);
    return !!m && Number(m[1]) >= 1024 && Number(m[1]) <= 65535;
  }
  const DEFAULT_MODEL = 'claude-haiku-4-5';
  const MAX_OUT = 20000;

  // v2.0.0: the NAS and PC model hosts are the fixed names the build put in LifeOS.HOSTS (config/hosts.json). Nothing user-entered forms the address.
  const HOME_KEY = { nas: 'ai-nas', pc: 'ai-pc' };
  const HOME_NAME = { nas: 'NAS model', pc: 'PC model' };
  const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,99}$/;
  let hostsOverride = null;
  function _setHosts(h) { hostsOverride = h && typeof h === 'object' ? h : null; }
  function hostFor(kind) {
    const h = hostsOverride || L.HOSTS;
    const name = h && typeof h === 'object' ? h[HOME_KEY[kind]] : '';
    return typeof name === 'string' && /^[a-z0-9.-]{3,253}$/.test(name) ? name : '';
  }
  const isHome = (k) => k === 'nas' || k === 'pc';
  function validateProvider(p) {
    if (!p || typeof p !== 'object') throw new Error('Provider required');
    const kind = p.kind;
    if (!['none', 'anthropic', 'local', 'manual', 'nas', 'pc'].includes(kind)) throw new Error('Unknown provider');
    const s = (v, max, n) => { if (v === undefined || v === null) return ''; if (typeof v !== 'string' || v.length > max) throw new Error(n + ' is invalid'); return v.trim(); };
    const out = { kind, baseUrl: s(p.baseUrl, 200, 'Base URL'), model: s(p.model, 100, 'Model'), apiKey: s(p.apiKey, 300, 'API key') };
    if (out.apiKey && !/^[\x21-\x7e]+$/.test(out.apiKey)) throw new Error('API key contains invalid characters');
    if (kind === 'local') {
      out.baseUrl = out.baseUrl.replace(/\/+$/, '');
      if (!isLocalUrl(out.baseUrl)) throw new Error('Local provider must be http://localhost or http://127.0.0.1 with a port from 1024 to 65535 and a path of nothing or /v1');
      if (!out.model) throw new Error('Model name is required for a local provider');
    }
    if (kind === 'anthropic') { out.baseUrl = ''; if (!out.model) out.model = DEFAULT_MODEL; }
    if (isHome(kind)) {
      out.baseUrl = ''; out.apiKey = '';
      if (!out.model) throw new Error('Model name is required for the ' + HOME_NAME[kind]);
      if (!MODEL_RE.test(out.model)) throw new Error('Model name is invalid');
    }
    return out;
  }

  // Reads the body as a stream and aborts as soon as more than MAX_BODY bytes arrive.
  async function readCapped(res, ctl) {
    const tooBig = () => coded(new Error('The AI provider reply was too large'), 'AI_BAD_REPLY');
    const cl = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('content-length')) : NaN;
    if (cl > MAX_BODY) { ctl.abort(); throw tooBig(); }
    if (!res.body || typeof res.body.getReader !== 'function') throw coded(new Error('The AI provider sent an unreadable reply'), 'AI_BAD_REPLY');
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY) {
          ctl.abort();
          try { await reader.cancel(); } catch (e) { /* ignore */ }
          throw tooBig();
        }
        chunks.push(value);
      }
    } catch (e) {
      if (e && e.message === tooBig().message) throw e;
      throw ctl.signal.aborted ? coded(new Error('The AI request timed out'), 'AI_TIMEOUT') : coded(new Error('The AI provider sent an unreadable reply'), 'AI_BAD_REPLY');
    }
    const buf = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(buf);
  }

  // v1.3.0: a fixed code on each failure, so diagnostics can name it without keeping any text.
  const coded = (e, code) => { e.code = code; return e; };
  // opts: { hosts: settings.aiHosts (models of the two home hosts and the optional fallback), report: an object that receives { kind } of the host that answered }.
  // The fallback is tried only when the first host could not be reached or timed out, never after an answer or an error reply. The prompt is the same object.
  async function complete(provider, prompt, fetchImpl, opts) {
    // The private vault is always closed before any AI call.
    if (L.priv) L.priv.close('system');
    const p = validateProvider(provider);
    if (p.kind === 'none' || p.kind === 'manual') throw new Error('MANUAL');
    if (!prompt || typeof prompt.system !== 'string' || typeof prompt.user !== 'string') throw new Error('Invalid prompt');
    try {
      const text = await completeOne(p, prompt, fetchImpl);
      if (opts && opts.report) opts.report.kind = p.kind;
      return text;
    } catch (e) {
      const h = opts && opts.hosts, fb = h && (h.fallback === 'nas' || h.fallback === 'pc') ? h.fallback : '';
      const model = fb ? (fb === 'nas' ? h.nasModel : h.pcModel) : '';
      if (!fb || fb === p.kind || !(e && (e.code === 'AI_NETWORK' || e.code === 'AI_TIMEOUT')) || !model) throw e;
      const q = validateProvider({ kind: fb, model });
      const text = await completeOne(q, prompt, fetchImpl);
      if (opts && opts.report) opts.report.kind = q.kind;
      return text;
    }
  }
  async function completeOne(p, prompt, fetchImpl) {
    if (p.kind === 'anthropic' && !p.apiKey) throw new Error('API key is missing');
    const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    const ctl = new AbortController();
    let timer = setTimeout(() => ctl.abort(), 20000);
    // A small model that has to load can take a while; the home hosts get a longer limit than the cloud.
    if (isHome(p.kind)) { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), 90000); }
    let url, headers, body;
    if (p.kind === 'anthropic') {
      url = 'https://api.anthropic.com/v1/messages';
      headers = { 'content-type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
      body = { model: p.model, max_tokens: 600, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] };
    } else {
      if (isHome(p.kind)) {
        const host = hostFor(p.kind);
        if (!host) { clearTimeout(timer); throw coded(new Error('The ' + HOME_NAME[p.kind] + ' host is not set in this build'), 'AI_FAIL'); }
        url = 'https://' + host + '/v1/chat/completions';
      } else url = p.baseUrl + '/chat/completions';
      headers = { 'content-type': 'application/json' };
      if (p.apiKey) headers.authorization = 'Bearer ' + p.apiKey;
      body = { model: p.model, max_tokens: 600, stream: false, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }] };
    }
    let res;
    try {
      res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    } catch (e) {
      clearTimeout(timer);
      throw coded(new Error(e && e.name === 'AbortError' ? 'The AI request timed out' : isHome(p.kind) ? 'Could not reach the ' + HOME_NAME[p.kind] + '. Connect Tailscale and try again.' : 'Could not reach the AI provider'), e && e.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_NETWORK');
    }
    try {
      if (!res || !res.ok) throw coded(new Error('The AI provider returned an error' + (res && res.status ? ' (HTTP ' + res.status + ')' : '')), 'AI_HTTP');
      let j;
      const raw = await readCapped(res, ctl);
      try { j = JSON.parse(raw); } catch (e) { throw coded(new Error('The AI provider sent an unreadable reply'), 'AI_BAD_REPLY'); }
      let text;
      if (p.kind === 'anthropic') {
        text = Array.isArray(j && j.content) ? j.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('') : undefined;
      } else {
        const c = j && j.choices && j.choices[0] && j.choices[0].message;
        text = c && c.content;
      }
      if (typeof text !== 'string' || !text || text.length > MAX_OUT) throw coded(new Error('The AI provider sent an unexpected reply'), 'AI_BAD_REPLY');
      return text;
    } finally { clearTimeout(timer); }
  }

  // v1.5.0 B13: "Test connection". The prompt is fixed text: no digest, no insight, no setting, nothing from the vault. The result is
  // success or one fixed code (the B7 codes AI_TIMEOUT, AI_NETWORK, AI_HTTP, AI_BAD_REPLY, AI_FAIL); error text is never returned or kept.
  const TEST_PROMPT = Object.freeze({ system: 'Connection test. Reply with the single word OK.', user: 'Reply with OK.' });
  const TEST_CODES = new Set(['AI_TIMEOUT', 'AI_NETWORK', 'AI_HTTP', 'AI_BAD_REPLY', 'AI_FAIL']);
  async function testConnection(provider, fetchImpl) {
    try {
      // No fallback in a test: it checks exactly the host that was chosen.
      await complete(provider, { system: TEST_PROMPT.system, user: TEST_PROMPT.user }, fetchImpl);
      return { ok: true, code: null };
    } catch (e) {
      let code = null;
      try { code = L.ops && L.ops.codeFor ? L.ops.codeFor(e) : null; } catch (x) { /* a hostile error object */ }
      if (!TEST_CODES.has(code)) code = 'AI_FAIL';
      if (L.ops && L.ops.record) L.ops.record(code, 'ai');
      return { ok: false, code };
    }
  }

  L.ai = { validateProvider, complete, isLocalUrl, testConnection, TEST_PROMPT, hostFor, _setHosts };
})();
