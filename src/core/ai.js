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

  function validateProvider(p) {
    if (!p || typeof p !== 'object') throw new Error('Provider required');
    const kind = p.kind;
    if (!['none', 'anthropic', 'local', 'manual'].includes(kind)) throw new Error('Unknown provider');
    const s = (v, max, n) => { if (v === undefined || v === null) return ''; if (typeof v !== 'string' || v.length > max) throw new Error(n + ' is invalid'); return v.trim(); };
    const out = { kind, baseUrl: s(p.baseUrl, 200, 'Base URL'), model: s(p.model, 100, 'Model'), apiKey: s(p.apiKey, 300, 'API key') };
    if (out.apiKey && !/^[\x21-\x7e]+$/.test(out.apiKey)) throw new Error('API key contains invalid characters');
    if (kind === 'local') {
      out.baseUrl = out.baseUrl.replace(/\/+$/, '');
      if (!isLocalUrl(out.baseUrl)) throw new Error('Local provider must be http://localhost or http://127.0.0.1 with a port from 1024 to 65535 and a path of nothing or /v1');
      if (!out.model) throw new Error('Model name is required for a local provider');
    }
    if (kind === 'anthropic') { out.baseUrl = ''; if (!out.model) out.model = DEFAULT_MODEL; }
    return out;
  }

  // Reads the body as a stream and aborts as soon as more than MAX_BODY bytes arrive.
  async function readCapped(res, ctl) {
    const tooBig = () => new Error('The AI provider reply was too large');
    const cl = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('content-length')) : NaN;
    if (cl > MAX_BODY) { ctl.abort(); throw tooBig(); }
    if (!res.body || typeof res.body.getReader !== 'function') throw new Error('The AI provider sent an unreadable reply');
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
      throw new Error(ctl.signal.aborted ? 'The AI request timed out' : 'The AI provider sent an unreadable reply');
    }
    const buf = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(buf);
  }

  async function complete(provider, prompt, fetchImpl) {
    // The private vault is always closed before any AI call.
    if (L.priv) L.priv.close('system');
    const p = validateProvider(provider);
    if (p.kind === 'none' || p.kind === 'manual') throw new Error('MANUAL');
    if (!prompt || typeof prompt.system !== 'string' || typeof prompt.user !== 'string') throw new Error('Invalid prompt');
    if (p.kind === 'anthropic' && !p.apiKey) throw new Error('API key is missing');
    const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let url, headers, body;
    if (p.kind === 'anthropic') {
      url = 'https://api.anthropic.com/v1/messages';
      headers = { 'content-type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
      body = { model: p.model, max_tokens: 600, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] };
    } else {
      url = p.baseUrl + '/chat/completions';
      headers = { 'content-type': 'application/json' };
      if (p.apiKey) headers.authorization = 'Bearer ' + p.apiKey;
      body = { model: p.model, max_tokens: 600, stream: false, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }] };
    }
    let res;
    try {
      res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    } catch (e) {
      clearTimeout(timer);
      throw new Error(e && e.name === 'AbortError' ? 'The AI request timed out' : 'Could not reach the AI provider');
    }
    try {
      if (!res || !res.ok) throw new Error('The AI provider returned an error' + (res && res.status ? ' (HTTP ' + res.status + ')' : ''));
      let j;
      const raw = await readCapped(res, ctl);
      try { j = JSON.parse(raw); } catch (e) { throw new Error('The AI provider sent an unreadable reply'); }
      let text;
      if (p.kind === 'anthropic') {
        text = Array.isArray(j && j.content) ? j.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('') : undefined;
      } else {
        const c = j && j.choices && j.choices[0] && j.choices[0].message;
        text = c && c.content;
      }
      if (typeof text !== 'string' || !text || text.length > MAX_OUT) throw new Error('The AI provider sent an unexpected reply');
      return text;
    } finally { clearTimeout(timer); }
  }

  L.ai = { validateProvider, complete, isLocalUrl };
})();
