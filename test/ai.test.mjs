import { test } from 'node:test';
import assert from 'node:assert/strict';
import { L } from './_load.mjs';
const A = L.ai;
const KEY = 'sk-ant-SECRETKEY1234';
const prompt = { system: 'sys', user: 'usr' };
const R = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const ok = (body) => async () => R(body);

test('validateProvider accepts localhost only for local', () => {
  assert.equal(A.validateProvider({ kind: 'local', baseUrl: 'http://localhost:11434/v1/', model: 'llama3' }).baseUrl, 'http://localhost:11434/v1');
  assert.ok(A.validateProvider({ kind: 'local', baseUrl: 'http://127.0.0.1:8080', model: 'm' }));
  for (const u of ['http://evil.com', 'https://localhost:11434', 'http://localhost.evil.com', 'http://localhost@evil.com', 'http://127.0.0.1.evil.com/v1',
    'http://localhost:11434@evil.com', 'http://192.168.1.5:11434', 'http://[::1]:11434', 'file:///etc/passwd', '', 'localhost:11434', 'http://localhost/ v1'])
    assert.throws(() => A.validateProvider({ kind: 'local', baseUrl: u, model: 'm' }), /localhost/, u);
  assert.throws(() => A.validateProvider({ kind: 'local', baseUrl: 'http://localhost:11434/v1', model: '' }), /Model/);
  assert.throws(() => A.validateProvider({ kind: 'weird' }));
  assert.throws(() => A.validateProvider(null));
  assert.equal(A.validateProvider({ kind: 'anthropic', apiKey: KEY }).model.length > 0, true);
  assert.equal(A.validateProvider({ kind: 'manual' }).kind, 'manual');
});
test('manual and none throw MANUAL', async () => {
  for (const kind of ['manual', 'none']) await assert.rejects(A.complete({ kind }, prompt, async () => assert.fail('no fetch')), { message: 'MANUAL' });
});
test('complete anthropic: request shape and parsing', async () => {
  let seen;
  const f = async (url, o) => { seen = { url, o }; return R({ content: [{ type: 'text', text: 'he' }, { type: 'tool_use' }, { type: 'text', text: 'llo' }] }); };
  assert.equal(await A.complete({ kind: 'anthropic', apiKey: KEY, model: 'claude-x' }, prompt, f), 'hello');
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.o.method, 'POST');
  assert.equal(seen.o.headers['x-api-key'], KEY);
  assert.equal(seen.o.headers['anthropic-version'], '2023-06-01');
  assert.equal(seen.o.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.ok(seen.o.signal);
  const b = JSON.parse(seen.o.body);
  assert.equal(b.max_tokens, 600); assert.equal(b.model, 'claude-x'); assert.equal(b.system, 'sys'); assert.deepEqual(b.messages, [{ role: 'user', content: 'usr' }]);
  assert.ok(!seen.url.includes(KEY));
});
test('complete local: request shape and parsing', async () => {
  let seen;
  const f = async (url, o) => { seen = { url, o }; return R({ choices: [{ message: { content: 'local reply' } }] }); };
  assert.equal(await A.complete({ kind: 'local', baseUrl: 'http://localhost:11434/v1', model: 'llama3' }, prompt, f), 'local reply');
  assert.equal(seen.url, 'http://localhost:11434/v1/chat/completions');
  const b = JSON.parse(seen.o.body);
  assert.equal(b.max_tokens, 600);
  assert.deepEqual(b.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }]);
  assert.equal(seen.o.headers['x-api-key'], undefined);
});
test('errors never contain the key', async () => {
  const p = { kind: 'anthropic', apiKey: KEY, model: 'm' };
  const cases = [
    async () => { throw new Error('network down ' + KEY); },
    async () => { const e = new Error('aborted ' + KEY); e.name = 'AbortError'; throw e; },
    async () => R({ error: 'bad key ' + KEY }, 401),
    async () => R('not json ' + KEY),
    ok({ content: 'nope' + KEY }), ok({}), ok(null),
    async () => R({ content: [{ type: 'text', text: 'x'.repeat(30000) }] }),
  ];
  for (const f of cases) {
    await assert.rejects(A.complete(p, prompt, f), (e) => { assert.ok(!String(e.message).includes(KEY)); assert.ok(!String(e.stack).includes(KEY)); return true; });
  }
  await assert.rejects(A.complete({ kind: 'anthropic', apiKey: '', model: 'm' }, prompt, ok({})), /missing/);
  await assert.rejects(A.complete({ kind: 'anthropic', apiKey: 'bad key\n', model: 'm' }, prompt, ok({})), (e) => !e.message.includes('bad key'));
  await assert.rejects(A.complete({ kind: 'local', baseUrl: 'http://evil.com', model: 'm' }, prompt, async () => assert.fail('no fetch')), /localhost/);
});
test('timeout aborts the request', async () => {
  const f = (url, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => { const e = new Error('x'); e.name = 'AbortError'; rej(e); }));
  const realST = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { assert.equal(ms, 20000); return realST(fn, 5); };
  try { await assert.rejects(A.complete({ kind: 'anthropic', apiKey: KEY, model: 'm' }, prompt, f), /timed out/); }
  finally { globalThis.setTimeout = realST; }
});
