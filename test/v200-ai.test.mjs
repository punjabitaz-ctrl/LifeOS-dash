// v2.0.0 part 4: the NAS model and PC model providers (Ollama behind Caddy at the fixed names), the optional fallback, Test connection for each,
// and the numbers-only boundary, which is the same for every provider.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L, PASS } from './_load.mjs';
import { buildAdversarial, ADV_MARK } from './_adversarial.mjs';
import { vault, fastKeys, realKeys, PRIV } from './_archive.mjs';

const live = (k) => new Proxy({}, { get: (_, p) => L[k][p] });
const AI = live('ai'), Mem = live('memory'), S = live('store'), O = live('ops'), P = live('priv');
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const HOSTS = { app: 'a.example.test', sync: 's.example.test', 'ai-nas': 'ai-nas.example.test', 'ai-pc': 'ai-pc.example.test' };
const WK = '2026-11-09', PERIOD = { from: WK, to: '2026-11-15' };
const test = (name, fn) => nodeTest(name, async () => { fastKeys(); O._reset(); AI._setHosts(HOSTS); try { return await fn(); } finally { AI._setHosts(null); try { P.close('system'); } catch (e) { /* closed */ } try { S.lock(); } catch (e) { /* locked */ } realKeys(); } });
const rej = async (p, re) => { try { await p; } catch (e) { if (re) assert.match(String(e.message), re); return e; } assert.fail('expected a rejection'); };
const okBody = (text = '[]') => JSON.stringify({ choices: [{ message: { content: text } }] });
// A fake network: records every request; `route(url)` decides the reply: a function result, 'down' (network error) or a status number.
function net(route) {
  const calls = [];
  const f = async (url, o) => {
    calls.push({ url, o, body: typeof o.body === 'string' ? JSON.parse(o.body) : null });
    const r = route(url, calls.length);
    if (r === 'down') throw new TypeError('fetch failed');
    if (r === 'abort') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const status = typeof r === 'number' ? r : 200, body = typeof r === 'string' ? (r.startsWith('{') && url.includes('anthropic') ? JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }) : r) : okBody();
    return { ok: status < 300, status, headers: { get: () => null }, body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : ((done = true), { done: false, value: new TextEncoder().encode(body) })), cancel: async () => {} }; } } };
  };
  f.calls = calls;
  return f;
}
const PROMPT = { system: 'sys', user: 'user digest' };

test('the NAS and PC providers need a model name; the address and key are never kept; the model name is checked; the old kinds behave as before', () => {
  for (const k of ['nas', 'pc']) {
    const p = AI.validateProvider({ kind: k, baseUrl: 'https://evil.example', model: ' llama3.2:3b ', apiKey: 'sk-secret' });
    assert.deepEqual(p, { kind: k, baseUrl: '', model: 'llama3.2:3b', apiKey: '' });
    assert.throws(() => AI.validateProvider({ kind: k }), /Model name is required/);
    for (const bad of ['has space', '-lead', 'x'.repeat(101), 'a;b', 'a"b', "a'b", '../x', 'a\nb']) assert.throws(() => AI.validateProvider({ kind: k, model: bad }), /Model name is invalid|is invalid/, bad);
    assert.equal(AI.validateProvider({ kind: k, model: 'hf.co/org/model:Q4_K_M' }).model, 'hf.co/org/model:Q4_K_M');
  }
  assert.throws(() => AI.validateProvider({ kind: 'cloud' }), /Unknown provider/);
  assert.equal(AI.validateProvider({ kind: 'anthropic' }).model, 'claude-haiku-4-5');
  assert.throws(() => AI.validateProvider({ kind: 'local', baseUrl: 'https://x.example/v1', model: 'm' }), /Local provider must be/);
});
test('the request goes to the fixed name from the build, https, /v1/chat/completions, no key, credentials omitted, nothing user-entered', async () => {
  for (const [k, host] of [['nas', 'ai-nas.example.test'], ['pc', 'ai-pc.example.test']]) {
    const f = net(() => okBody('hello'));
    const text = await AI.complete({ kind: k, baseUrl: 'http://localhost:11434/v1', model: 'm1', apiKey: 'sk-x' }, PROMPT, f);
    assert.equal(text, 'hello'); assert.equal(f.calls.length, 1);
    const c = f.calls[0];
    assert.equal(c.url, 'https://' + host + '/v1/chat/completions');
    assert.deepEqual(Object.keys(c.o.headers), ['content-type']); assert.equal(c.o.credentials, 'omit'); assert.equal(c.o.redirect, 'error'); assert.equal(c.o.referrerPolicy, 'no-referrer');
    assert.deepEqual(c.body, { model: 'm1', max_tokens: 600, stream: false, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'user digest' }] });
  }
  // a build without the names refuses with a fixed message and sends nothing
  AI._setHosts(null); const saved = L.HOSTS; L.HOSTS = undefined;
  const f = net(() => okBody());
  const e = await rej(AI.complete({ kind: 'nas', model: 'm' }, PROMPT, f), /not set in this build/); assert.equal(e.code, 'AI_FAIL'); assert.equal(f.calls.length, 0);
  L.HOSTS = saved;
});
test('the app source forms no model address from settings or typed text, and names no home host itself', () => {
  const app = src('src/ui/app.js') + src('src/core/store.js') + src('src/ui/nas-ui.js');
  assert.ok(!/ai-nas|ai-pc|tazabbas/.test(app));
  const ai = src('src/core/ai.js');
  assert.ok(/'https:\/\/' \+ host \+ '\/v1\/chat\/completions'/.test(ai) && !/baseUrl \+ .*home/i.test(ai));
});
test('an unreachable host says "Connect Tailscale and try again" and keeps no network text; a timeout is a timeout; an error reply is an error reply', async () => {
  let e = await rej(AI.complete({ kind: 'pc', model: 'm' }, PROMPT, net(() => 'down')), /Connect Tailscale and try again\./);
  assert.equal(e.code, 'AI_NETWORK'); assert.match(e.message, /PC model/); assert.ok(!/fetch failed/.test(e.message));
  e = await rej(AI.complete({ kind: 'nas', model: 'm' }, PROMPT, net(() => 'down')), /NAS model/); assert.equal(e.code, 'AI_NETWORK');
  e = await rej(AI.complete({ kind: 'nas', model: 'm' }, PROMPT, net(() => 'abort'))); assert.equal(e.code, 'AI_TIMEOUT');
  e = await rej(AI.complete({ kind: 'nas', model: 'm' }, PROMPT, net(() => 500)), /HTTP 500/); assert.equal(e.code, 'AI_HTTP');
  e = await rej(AI.complete({ kind: 'nas', model: 'm' }, PROMPT, net(() => 'not json'))); assert.equal(e.code, 'AI_BAD_REPLY');
  // other providers keep their wording
  e = await rej(AI.complete({ kind: 'local', baseUrl: 'http://localhost:11434/v1', model: 'm' }, PROMPT, net(() => 'down')), /Could not reach the AI provider/); assert.ok(!/Tailscale/.test(e.message));
});
test('fallback: used only when the first host cannot be reached or times out, never after an answer or an error reply, never to itself, never without its model', async () => {
  const hosts = { nasModel: 'small', pcModel: 'big', fallback: 'nas' };
  const used = {};
  let f = net((u) => (u.includes('ai-pc') ? 'down' : okBody('from nas')));
  assert.equal(await AI.complete({ kind: 'pc', model: 'big' }, PROMPT, f, { hosts, report: used }), 'from nas');
  assert.deepEqual(f.calls.map((c) => c.url.split('/')[2]), ['ai-pc.example.test', 'ai-nas.example.test']); assert.equal(used.kind, 'nas'); assert.equal(f.calls[1].body.model, 'small');
  assert.deepEqual(f.calls[0].body.messages, f.calls[1].body.messages, 'the same prompt goes to both');
  f = net((u) => (u.includes('ai-pc') ? 'abort' : okBody('t'))); assert.equal(await AI.complete({ kind: 'pc', model: 'big' }, PROMPT, f, { hosts }), 't'); assert.equal(f.calls.length, 2);
  f = net((u) => (u.includes('ai-pc') ? 500 : okBody())); await rej(AI.complete({ kind: 'pc', model: 'big' }, PROMPT, f, { hosts })); assert.equal(f.calls.length, 1, 'an error reply is not a reason to ask another host');
  f = net(() => 'not json'); await rej(AI.complete({ kind: 'pc', model: 'big' }, PROMPT, f, { hosts })); assert.equal(f.calls.length, 1);
  f = net(() => 'down'); await rej(AI.complete({ kind: 'nas', model: 'small' }, PROMPT, f, { hosts })); assert.equal(f.calls.length, 1, 'a host is not its own fallback');
  f = net(() => 'down'); await rej(AI.complete({ kind: 'pc', model: 'big' }, PROMPT, f, { hosts: { nasModel: '', pcModel: 'big', fallback: 'nas' } })); assert.equal(f.calls.length, 1, 'no model name for the fallback');
  f = net(() => 'down'); await rej(AI.complete({ kind: 'pc', model: 'big' }, PROMPT, f, { hosts: { nasModel: 'small', fallback: '' } })); assert.equal(f.calls.length, 1);
  f = net(() => 'down'); const e = await rej(AI.complete({ kind: 'pc', model: 'big' }, PROMPT, f, { hosts })); assert.equal(f.calls.length, 2); assert.equal(e.code, 'AI_NETWORK');
  // Anthropic can fall back to a home host too; manual and none never call anything
  f = net((u) => (u.includes('anthropic') ? 'down' : okBody('home'))); assert.equal(await AI.complete({ kind: 'anthropic', apiKey: 'sk-k', model: 'claude-haiku-4-5' }, PROMPT, f, { hosts: { nasModel: 'small', fallback: 'nas' } }), 'home');
  f = net(() => okBody()); for (const k of ['none', 'manual']) await rej(AI.complete({ kind: k }, PROMPT, f, { hosts }), /MANUAL/); assert.equal(f.calls.length, 0);
});
test('Test connection works for each host: a fixed message with nothing from the vault, success or one fixed code, no fallback, diagnostics hold the code only', async () => {
  for (const k of ['nas', 'pc']) {
    let f = net(() => okBody('OK'));
    assert.deepEqual(await AI.testConnection({ kind: k, model: 'm' }, f), { ok: true, code: null });
    assert.equal(f.calls[0].body.messages[0].content, AI.TEST_PROMPT.system); assert.equal(f.calls[0].body.messages[1].content, AI.TEST_PROMPT.user);
    assert.ok(f.calls[0].url.includes(k === 'nas' ? 'ai-nas' : 'ai-pc'));
    f = net(() => 'down'); assert.deepEqual(await AI.testConnection({ kind: k, model: 'm' }, f), { ok: false, code: 'AI_NETWORK' }); assert.equal(f.calls.length, 1);
    f = net(() => 404); assert.deepEqual(await AI.testConnection({ kind: k, model: 'm' }, f), { ok: false, code: 'AI_HTTP' });
    f = net(() => 'abort'); assert.deepEqual(await AI.testConnection({ kind: k, model: 'm' }, f), { ok: false, code: 'AI_TIMEOUT' });
  }
  assert.deepEqual(await AI.testConnection({ kind: 'nas', model: '' }, net(() => okBody())), { ok: false, code: 'AI_FAIL' });
});
test('the numbers-only boundary is unchanged: with adversarial text in every domain, what each provider receives is exactly the prompt, with no marker, no entry, name or note', async () => {
  const { state } = buildAdversarial(L);
  await vault(state, { priv: true });
  await P.open(PRIV);
  const view = P.view(S.getState());
  const prompt = Mem.buildPrompt(view, 1, PERIOD);
  const bodies = [];
  for (const provider of [{ kind: 'nas', model: 'm' }, { kind: 'pc', model: 'm' }, { kind: 'anthropic', apiKey: 'sk-k', model: 'claude-haiku-4-5' }, { kind: 'local', baseUrl: 'http://localhost:11434/v1', model: 'm' }]) {
    const f = net((u) => (u.includes('anthropic') ? JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }) : okBody()));
    await AI.complete(provider, prompt, f);
    bodies.push(JSON.stringify(f.calls[0].body));
    assert.equal(P.isOpen(), false, 'the private vault is closed before any call');
    await P.open(PRIV);
  }
  // fallback sends the same text again, nothing else
  const g = net((u) => (u.includes('ai-pc') ? 'down' : okBody())); await AI.complete({ kind: 'pc', model: 'm' }, prompt, g, { hosts: { nasModel: 'n', fallback: 'nas' } });
  bodies.push(JSON.stringify(g.calls[1].body));
  for (const b of bodies) {
    assert.ok(!b.includes(ADV_MARK) && !/LEAK|onerror|=cmd/.test(b), 'adversarial text reached a provider');
    const o = JSON.parse(b); assert.deepEqual(Object.keys(o).sort(), o.system ? ['max_tokens', 'messages', 'model', 'system'].sort() : ['max_tokens', 'messages', 'model', 'stream'].sort());
    assert.equal(o.max_tokens, 600);
  }
  const home = JSON.parse(bodies[0]).messages;
  assert.deepEqual(home, [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }]);
  // and the prompt itself is the same text for every provider (it never depends on the host)
  assert.deepEqual(JSON.parse(bodies[1]).messages, home); assert.equal(JSON.parse(bodies[4]).messages[1].content, prompt.user);
  void PASS;
});
test('a stored provider kind of nas or pc is accepted by the state check; the host choices are settings, so the AI call reads them and nothing else from the vault', async () => {
  await vault(null);
  await S.commit((x) => { x.settings.provider = { kind: 'pc', baseUrl: '', model: 'big', apiKey: '' }; x.settings.aiHosts = { nasModel: 'small', pcModel: 'big', fallback: 'nas' }; });
  assert.equal(S.getState().settings.provider.kind, 'pc');
  const s = S.getState();
  const f = net((u) => (u.includes('ai-pc') ? 'down' : okBody('[]')));
  const text = await AI.complete(s.settings.provider, Mem.buildPrompt(s, 1, PERIOD), f, { hosts: s.settings.aiHosts });
  assert.equal(text, '[]'); assert.equal(f.calls.length, 2);
});
