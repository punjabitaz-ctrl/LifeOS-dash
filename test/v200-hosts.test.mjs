// v2.0.0 part 1: config/hosts.json is read by build.mjs into connect-src. Exactly the sync, ai-nas and ai-pc https origins are added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, buildAll, hostsOf } from '../build.mjs';

const shell = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="__CSP__"><style>/*__CSS__*/</style></head><body><script>/*__JS__*/</script></body></html>';
function fixture(hosts) {
  const root = mkdtempSync(join(tmpdir(), 'lifeos-h-'));
  mkdirSync(join(root, 'src/ui'), { recursive: true });
  cpSync(new URL('../src/core', import.meta.url), join(root, 'src/core'), { recursive: true });
  writeFileSync(join(root, 'src/ui/shell.html'), shell);
  writeFileSync(join(root, 'src/ui/styles.css'), 'body{color:red}');
  writeFileSync(join(root, 'src/ui/app.js'), 'var x=1;');
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"9.8.7"}');
  if (hosts !== undefined) { mkdirSync(join(root, 'config')); writeFileSync(join(root, 'config/hosts.json'), typeof hosts === 'string' ? hosts : JSON.stringify(hosts)); }
  return root;
}
const good = { app: 'a.example.test', sync: 's.example.test', 'ai-nas': 'n.example.test', 'ai-pc': 'p.example.test' };
const connect = (html) => /connect-src ([^;]*);/.exec(html)[1].split(' ');

test('the real config holds the spec defaults', () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL('../config/hosts.json', import.meta.url), 'utf8')), {
    app: 'lifeos.tazabbas.com', sync: 'sync.lifeos.tazabbas.com', 'ai-nas': 'ai-nas.lifeos.tazabbas.com', 'ai-pc': 'ai-pc.lifeos.tazabbas.com' });
});
test('the real build lists exactly the three home origins after Anthropic and Google, then the localhost entries; the app name is not in it', () => {
  const { html, csp, headers } = buildAll();
  assert.deepEqual(connect(html), ['https://api.anthropic.com', 'https://www.googleapis.com', 'https://sync.lifeos.tazabbas.com', 'https://ai-nas.lifeos.tazabbas.com', 'https://ai-pc.lifeos.tazabbas.com', 'http://localhost:*', 'http://127.0.0.1:*']);
  assert.ok(!/https:\/\/lifeos\.tazabbas\.com/.test(csp));
  assert.ok(headers.includes(csp));
  assert.ok(html.includes('globalThis.LifeOS.HOSTS = {"app":"lifeos.tazabbas.com"'));
});
test('a changed name is a config change plus a rebuild: the origins follow the file, nothing else', () => {
  const html = build(fixture(good));
  assert.deepEqual(connect(html), ['https://api.anthropic.com', 'https://www.googleapis.com', 'https://s.example.test', 'https://n.example.test', 'https://p.example.test', 'http://localhost:*', 'http://127.0.0.1:*']);
  assert.ok(!html.includes('a.example.test') || html.includes('"app":"a.example.test"'));
});
test('with no config file the policy is the pre-2.0 one (no extra origins)', () => {
  assert.deepEqual(connect(build(fixture())), ['https://api.anthropic.com', 'https://www.googleapis.com', 'http://localhost:*', 'http://127.0.0.1:*']);
});
test('bad names fail the build: scheme, port, path, wildcard, uppercase, spaces, single label, duplicates, unknown or missing keys', () => {
  for (const bad of ['https://s.example.test', 's.example.test:443', 's.example.test/x', '*.example.test', 'S.Example.Test', 's example.test', 'localhost', 's.example.test.', '', 'api.anthropic.com', 'www.googleapis.com', "s.example.test; script-src *"]) {
    assert.throws(() => build(fixture({ ...good, sync: bad })), /hosts\.json/, bad);
  }
  assert.throws(() => build(fixture({ ...good, 'ai-pc': good['ai-nas'] })), /different/);
  assert.throws(() => build(fixture({ ...good, extra: 'x.example.test' })), /unknown name/);
  const { sync, ...missing } = good;
  assert.throws(() => build(fixture(missing)), /"sync"/);
  assert.throws(() => build(fixture('{bad json')), /not valid JSON/);
  assert.throws(() => build(fixture('[]')), /must be an object/);
  assert.throws(() => hostsOf(fixture({ ...good, sync: 5 })), /"sync"/);
});
test('the built page never adds a connect origin from anything at run time (the policy is fixed text)', () => {
  const html = build(fixture(good));
  assert.equal((html.match(/Content-Security-Policy/g) || []).length, 1);
  assert.ok(!/connect-src[^;]*\*[^:]/.test(html.replace(/http:\/\/(localhost|127\.0\.0\.1):\*/g, '')));
});
