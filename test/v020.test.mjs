import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { L } from './_load.mjs';
import { build } from '../build.mjs';

const prompt = { system: 's', user: 'u' };
const lp = (baseUrl) => ({ kind: 'local', baseUrl, model: 'm' });

test('SEC-08 local URL: port 1024-65535 required, path empty or /v1 only', () => {
  for (const u of ['http://localhost:11434', 'http://localhost:11434/v1', 'http://127.0.0.1:1024/v1', 'http://127.0.0.1:65535'])
    assert.ok(L.ai.validateProvider(lp(u)), u);
  for (const u of ['http://localhost', 'http://localhost/v1', 'http://localhost:80/v1', 'http://localhost:1023', 'http://localhost:65536', 'http://localhost:099999',
    'http://localhost:01234', 'http://localhost:11434/v2', 'http://localhost:11434/admin', 'http://localhost:11434/v1/x', 'http://localhost:11434/v1?a=1', 'http://localhost:11434/v1#f',
    'http://user:pw@localhost:11434/v1', 'http://localhost:11434?x', 'http://localhost:11434/../v1', 'https://localhost:11434'])
    assert.throws(() => L.ai.validateProvider(lp(u)), /localhost/, u);
  const st = L.store.defaultState();
  st.settings.provider = { kind: 'local', baseUrl: 'http://localhost:11434/admin', model: 'm', apiKey: '' };
  assert.throws(() => L.store.validateState(st));
});

test('SEC-09 demoteApproved is pure and restores approved as proposed', () => {
  const st = L.store.defaultState();
  const mk = (status) => ({ id: status + Math.random(), level: 1, period: { from: '2026-11-02', to: '2026-11-08' }, domain: 'money', text: 't', source: 'ai', status, createdAt: 1, decidedAt: 2 });
  st.memory.insights.push(mk('approved'), mk('rejected'), mk('proposed'), mk('approved'));
  const snap = JSON.stringify(st);
  const out = L.memory.demoteApproved(st);
  assert.equal(JSON.stringify(st), snap);
  assert.deepEqual(out.memory.insights.map((i) => i.status), ['proposed', 'rejected', 'proposed', 'proposed']);
  assert.equal(L.memory.approved(out).length, 0);
  assert.equal(out.memory.insights[0].decidedAt, undefined);
  assert.equal(out.memory.insights[1].decidedAt, 2);
  assert.ok(L.store.validateState(out));
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lifeos-'));
  mkdirSync(join(root, 'src/ui'), { recursive: true });
  cpSync(new URL('../src/core', import.meta.url), join(root, 'src/core'), { recursive: true });
  writeFileSync(join(root, 'src/ui/shell.html'), '<html><head><meta content="__CSP__"><style>/*__CSS__*/</style></head><body><script>/*__JS__*/</script></body></html>');
  writeFileSync(join(root, 'src/ui/styles.css'), 'a{}/* </style><b> </STYLE */');
  writeFileSync(join(root, 'src/ui/app.js'), 'var a="<!-- x <script>y <SCRIPT> </script>";');
  return root;
}
test('SEC-10 build neutralises <!--, <script and </style', () => {
  const html = build(fixture());
  const js = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const css = /<style>([\s\S]*)<\/style>/.exec(html)[1];
  assert.ok(!/<!--/.test(js) && !/<script/i.test(js) && !/<\/script/i.test(js));
  assert.equal(new Function(js + ';return a')(), '<!-- x <script>y <SCRIPT> </script>');
  assert.ok(!/<\/style/i.test(css));
  assert.equal((html.match(/<script/gi) || []).length, 1);
  assert.equal((html.match(/<style/gi) || []).length, 1);
  const real = build();
  const rjs = /<script>([\s\S]*)<\/script>/.exec(real)[1];
  assert.ok(!/<!--|<script|<\/script/i.test(rjs));
});

function streamOf(chunks, onCancel) {
  let i = 0;
  return new Response(new ReadableStream({ pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]); else c.close(); }, cancel: onCancel }));
}
test('SEC-11 reply body is capped at 1 MB and aborted', async () => {
  const p = { kind: 'anthropic', apiKey: 'k', model: 'm' };
  let aborted = false, cancelled = false, pulled = 0;
  const big = new Uint8Array(300 * 1024).fill(97);
  const f = async (u, o) => {
    o.signal.addEventListener('abort', () => { aborted = true; });
    return new Response(new ReadableStream({ pull(c) { pulled++; c.enqueue(big); }, cancel() { cancelled = true; } }));
  };
  await assert.rejects(L.ai.complete(p, prompt, f), /too large/);
  assert.ok(aborted && cancelled);
  assert.ok(pulled <= 6, 'stopped reading shortly after the cap: ' + pulled);
  // content-length shortcut
  const h = async () => new Response('{}', { headers: { 'content-length': '2000000' } });
  await assert.rejects(L.ai.complete(p, prompt, h), /too large/);
  // exactly under the cap still parses, multi-chunk
  const body = new TextEncoder().encode(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }));
  assert.equal(await L.ai.complete(p, prompt, async () => streamOf([body.slice(0, 5), body.slice(5)])), 'ok');
});

const parsed = (headers, rows) => ({ headers, rows });
test('SEC-12 csv.toEntries maps person, due and status with validation', () => {
  const social = L.csv.toEntries(parsed(['d', 't', 'who'], [['2026-11-01', 'Coffee', 'Sam'], ['2026-11-02', 'Call', '']]), { domain: 'social', type: 'contact', map: { date: 0, title: 1, person: 2 } });
  assert.equal(social.entries.length, 1); assert.equal(social.entries[0].person, 'Sam'); assert.equal(social.rejected, 1);
  const home = L.csv.toEntries(parsed(['d', 't', 'due', 's'], [['2026-11-01', 'Gutters', '2026-12-01', 'Done'], ['2026-11-01', 'Bad', 'soon', 'open'], ['2026-11-01', 'Odd', '2026-12-02', 'maybe'], ['2026-11-01', 'Dflt', '2026-12-03', '']]),
    { domain: 'home', type: 'due', map: { date: 0, title: 1, due: 2, status: 3 } });
  assert.deepEqual(home.entries.map((e) => [e.title, e.due, e.status]), [['Gutters', '2026-12-01', 'done'], ['Dflt', '2026-12-03', 'open']]);
  assert.equal(home.rejected, 2);
  const work = L.csv.toEntries(parsed(['d', 't', 's'], [['2026-11-01', 'x', 'done']]), { domain: 'work', type: 'outcome', map: { date: 0, title: 1, status: 2 } });
  assert.equal(work.entries[0].status, 'done');
  assert.throws(() => L.csv.toEntries(parsed(['d', 't'], []), { domain: 'social', type: 'contact', map: { date: 0, title: 1 } }), /Person column is required/);
  assert.throws(() => L.csv.toEntries(parsed(['d', 't', 'p'], []), { domain: 'money', type: 'expense', map: { date: 0, title: 1, value: 2, person: 2 } }), /no person field/);
  assert.throws(() => L.csv.toEntries(parsed(['d', 't', 'p'], []), { domain: 'activities', type: 'session', map: { date: 0, title: 1, status: 2 } }), /no status field/);
});

const BIDI = '​‌‍‎‏‪‫‬‭‮⁠⁦⁩﻿';
test('SEC-13 bidi and zero-width characters are stripped', () => {
  const out = L.memory.parseResponse(JSON.stringify([{ domain: 'money', text: 'a' + BIDI + 'b‮c' }]));
  assert.equal(out[0].text, 'abc');
  const st = L.store.defaultState();
  st.entries.push({ id: 'e1', domain: 'money', type: 'expense', date: '2026-11-01', title: 'T' + BIDI + 'x', value: 1, notes: 'n' + BIDI });
  st.memory.insights.push({ id: 'i1', level: 1, period: { from: '2026-11-02', to: '2026-11-08' }, domain: 'money', text: 'p‮q', source: 'ai', status: 'proposed', createdAt: 1 });
  st.memory.lessons.push({ id: 'l1', text: 'l' + BIDI + 'm', createdAt: 1 });
  st.memory.reviews.push({ id: 'r1', weekOf: '2026-11-02', digest: { week: '2026-11-02', domains: {} }, priorities: ['a⁦b', '', ''], completedAt: 1 });
  const v = L.store.validateState(st);
  assert.equal(v.entries[0].title, 'Tx'); assert.equal(v.entries[0].notes, 'n');
  assert.equal(v.memory.insights[0].text, 'pq'); assert.equal(v.memory.lessons[0].text, 'lm'); assert.equal(v.memory.reviews[0].priorities[0], 'ab');
});

test('SEC-14 autoLockMin is clamped to 1-60', () => {
  for (const [inp, want] of [[1440, 60], [61, 60], [60, 60], [15, 15], [1, 1]]) {
    const st = L.store.defaultState(); st.settings.autoLockMin = inp;
    assert.equal(L.store.validateState(st).settings.autoLockMin, want);
  }
  const st = L.store.defaultState(); st.settings.autoLockMin = 0;
  assert.throws(() => L.store.validateState(st));
});
