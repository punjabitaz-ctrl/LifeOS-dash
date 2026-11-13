import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from '../build.mjs';

const shell = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="__CSP__"><style>/*__CSS__*/</style></head><body><script>/*__JS__*/</script></body></html>';
function fixture(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lifeos-'));
  mkdirSync(join(root, 'src/ui'), { recursive: true });
  cpSync(new URL('../src/core', import.meta.url), join(root, 'src/core'), { recursive: true });
  writeFileSync(join(root, 'src/ui/shell.html'), over.shell ?? shell);
  if (!over.noCss) writeFileSync(join(root, 'src/ui/styles.css'), 'body{color:red}');
  writeFileSync(join(root, 'src/ui/app.js'), 'var x="</script><b>$&";');
  return root;
}
const h = (s) => 'sha256-' + createHash('sha256').update(s).digest('base64');

test('build inlines, escapes </script and writes matching hashes', () => {
  const html = build(fixture());
  const js = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const css = /<style>([\s\S]*)<\/style>/.exec(html)[1];
  assert.equal(css, 'body{color:red}');
  assert.ok(!js.includes('</script') && js.includes('<\\/script><b>$&'));
  assert.ok(js.indexOf('L.vault =') < js.indexOf('L.store =') && js.indexOf('L.store =') < js.indexOf('L.csv =') && js.indexOf('L.ai =') < js.indexOf('var x='));
  assert.ok(html.includes(`script-src '${h(js)}'`));
  assert.ok(html.includes(`style-src '${h(css)}'`));
  assert.ok(html.includes(`default-src 'none'`) && html.includes(`connect-src https://api.anthropic.com http://localhost:* http://127.0.0.1:*`));
  assert.ok(html.includes(`img-src data:; base-uri 'none'; form-action 'none'`));
  assert.ok(!html.includes('__CSP__') && !html.includes('__JS__') && !html.includes('__CSS__'));
});
test('build fails clearly on missing files and placeholders', () => {
  assert.throws(() => build(fixture({ noCss: true })), /styles\.css/);
  assert.throws(() => build(fixture({ shell: shell.replace('/*__JS__*/', '') })), /__JS__/);
  assert.throws(() => build(fixture({ shell: shell.replace('__CSP__', 'x') })), /__CSP__/);
  assert.throws(() => build(join(tmpdir(), 'does-not-exist-lifeos')), /cannot read/);
});
