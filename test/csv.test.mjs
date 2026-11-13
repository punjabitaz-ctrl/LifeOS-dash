import { test } from 'node:test';
import assert from 'node:assert/strict';
import { L } from './_load.mjs';
const C = L.csv;

test('parse basics, CRLF, BOM, blank lines', () => {
  const p = C.parse('﻿date,title\r\n2026-01-01,a\r\n\r\n2026-01-02,b');
  assert.deepEqual(p.headers, ['date', 'title']);
  assert.deepEqual(p.rows, [['2026-01-01', 'a'], ['2026-01-02', 'b']]);
});
test('parse quotes, escaped quotes, commas and embedded newlines', () => {
  const p = C.parse('a,b\n"x, ""y""","line1\nline2"\n"",z\n');
  assert.deepEqual(p.rows, [['x, "y"', 'line1\nline2'], ['', 'z']]);
});
test('parse rejects unterminated quote, empty input, caps', () => {
  assert.throws(() => C.parse('a,b\n"x,1'), /unterminated/);
  assert.throws(() => C.parse(''), /empty/);
  assert.throws(() => C.parse('a'.repeat(5 * 1024 * 1024 + 1)), /5 MB/);
  assert.throws(() => C.parse('a\n' + '1\n'.repeat(20001)), /20000/);
  assert.equal(C.parse('a\n' + '1\n'.repeat(20000)).rows.length, 20000);
  assert.throws(() => C.parse(Array(101).fill('h').join(',') + '\n1'), /columns/);
  assert.throws(() => C.parse('a\n' + 'x'.repeat(10001)), /too long/);
});
test('toEntries maps, validates and counts rejects', () => {
  const p = C.parse('Date,What,Amt,Memo\n2026-01-05,Pay,"1,200.50",ok\n03/04/2026,Gift,$10,\nbad,Row,5,\n2026-01-06,,5,\n2026-01-07,NaN,abc,\n2026-01-08,Short\n');
  const r = C.toEntries(p, { domain: 'money', type: 'income', map: { date: 'Date', title: 'What', value: 'Amt', notes: 'Memo' } });
  assert.equal(r.entries.length, 2);
  assert.equal(r.rejected, 4);
  assert.equal(r.entries[0].value, 1200.5);
  assert.equal(r.entries[1].date, '2026-03-04');
  assert.throws(() => C.toEntries(p, { domain: 'nope', type: 'x', map: {} }));
  assert.throws(() => C.toEntries(p, { domain: 'money', type: 'income', map: { date: 'Missing', title: 'What' } }));
});
test('export neutralises formulas and quotes fields', () => {
  const e = L.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2026-01-01', title: '=HYPERLINK("x")', value: 5, notes: '+1\nline "q"' });
  const e2 = L.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2026-01-01', title: '@cmd', value: 5 });
  const e3 = L.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2026-01-01', title: '-2+3', value: 5 });
  const out = C.exportEntries([e, e2, e3]);
  assert.ok(out.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(out.includes(`"'@cmd"`));
  assert.ok(out.includes(`"'-2+3"`));
  assert.ok(out.includes(`"'+1\nline ""q"""`));
  assert.ok(out.startsWith('"id","domain"'));
  for (const f of ['\t', '\r', '\n']) assert.ok(C.exportEntries([{ title: f + 'x' }]).includes(`"'${f}x"`));
});
test('export then import round trip', () => {
  const e = L.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2026-01-01', title: '=SUM(A1)', value: 5, notes: 'a,b\n"c"' });
  const p = C.parse(C.exportEntries([e]));
  const r = C.toEntries(p, { domain: 'money', type: 'expense', map: { date: 'date', title: 'title', value: 'value', notes: 'notes' } });
  assert.equal(r.rejected, 0);
  assert.equal(r.entries[0].title, '=SUM(A1)');
  assert.equal(r.entries[0].notes, 'a,b\n"c"');
});
