// v2.0.0 smoke: start the real service as a separate process (the way the container runs it), register a token with the CLI,
// and walk the whole API over http on localhost. No browser needed. Usage: node test/smoke-nas-service.mjs
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'lifeos-nas-smoke-'));
const APP = 'https://lifeos.example.test';
const env = { ...process.env, LIFEOS_CONFIG_DIR: join(dir, 'config'), LIFEOS_DATA_DIR: join(dir, 'data'), LIFEOS_APP_ORIGINS: APP, LIFEOS_PORT: '0', LIFEOS_HOST: '127.0.0.1' };
const cli = spawnSync(process.execPath, ['server/index.mjs', 'token', 'add', 'smoke'], { env, encoding: 'utf8' });
assert.equal(cli.status, 0, cli.stderr);
const token = /lfs_[A-Za-z0-9_-]{43}/.exec(cli.stdout)[0];
const child = spawn(process.execPath, ['server/index.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
const port = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('service did not start: ' + out)), 10000);
  const iv = setInterval(() => { const m = /listening on 127\.0\.0\.1:(\d+)/.exec(out); if (m) { clearInterval(iv); clearTimeout(t); res(Number(m[1])); } }, 50);
});
const base = 'http://127.0.0.1:' + port, H = { authorization: 'Bearer ' + token };
const envl = (rev) => JSON.stringify({ v: 1, fmt: 2, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: 600000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }, iv: 'AAAAAAAAAAAAAAAA', ct: 'QUJDREVGR0hJSktMTU5PUA==', wraps: [{ kind: 'passphrase' }], data: { iv: 'AAAAAAAAAAAAAAAA', ct: 'QUJDREVGR0hJSktMTU5PUA==' }, rev });
try {
  assert.equal((await fetch(base + '/v1/health')).status, 401);
  assert.equal((await fetch(base + '/v1/health', { headers: H })).status, 200);
  assert.equal((await fetch(base + '/v1/vault', { headers: H })).status, 404);
  let r = await fetch(base + '/v1/vault', { method: 'PUT', headers: { ...H, 'content-type': 'application/json', 'x-expected-rev': 'none' }, body: envl(1) });
  assert.equal(r.status, 200);
  r = await fetch(base + '/v1/vault', { method: 'PUT', headers: { ...H, 'content-type': 'application/json', 'x-expected-rev': 'none' }, body: envl(2) });
  assert.equal(r.status, 409);
  r = await fetch(base + '/v1/vault', { method: 'PUT', headers: { ...H, 'content-type': 'application/json', 'x-expected-rev': '0' }, body: envl(2) });
  assert.equal((await r.json()).rev, 1);
  const vs = (await (await fetch(base + '/v1/versions', { headers: H })).json()).versions;
  assert.equal(vs.length, 2);
  r = await fetch(base + '/v1/versions/' + vs[1].id + '/restore', { method: 'POST', headers: { ...H, 'x-expected-rev': '1' } });
  assert.equal((await r.json()).rev, 2);
  assert.equal(JSON.parse(await (await fetch(base + '/v1/vault', { headers: H })).text()).rev, 1);
  r = await fetch(base + '/v1/vault', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' } });
  assert.equal(r.status, 403);
  r = await fetch(base + '/v1/vault', { method: 'OPTIONS', headers: { origin: APP, 'access-control-request-method': 'PUT' } });
  assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), APP);
  // revoke through the CLI while the service runs: the very next request is refused
  assert.equal(spawnSync(process.execPath, ['server/index.mjs', 'token', 'revoke', 'smoke'], { env }).status, 0);
  assert.equal((await fetch(base + '/v1/health', { headers: H })).status, 401);
  assert.ok(!out.includes(token) && !/lifeos\.example/.test(out), 'the log holds no token or origin');
  assert.ok(readdirSync(join(dir, 'data', 'vault')).length === 3);
  assert.ok(!readFileSync(join(dir, 'config', 'tokens.json'), 'utf8').includes(token));
  console.log('smoke-nas-service ok');
} finally { child.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); }
