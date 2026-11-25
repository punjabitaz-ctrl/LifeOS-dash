// v2.0.0 smoke: the NAS in the real page. The real service runs in this process on localhost; the page is served over http on 127.0.0.1
// (the app's localhost exception) and points at the service through the test hook. The home model hosts are intercepted at the network layer.
import path from 'node:path';
import http from 'node:http';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { navTo } from './_nav.mjs';
import { loadConfig } from '../server/lib/config.mjs';
import { createApp } from '../server/lib/app.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '..', 'dist', 'lifeos.html');
if (!existsSync(file)) { console.error('dist/lifeos.html missing: run node build.mjs first'); process.exit(1); }
let pw;
try { pw = await import('playwright'); } catch { console.log('SKIPPED: playwright not available (npm i --no-save playwright)'); process.exit(0); }
let browser;
for (const o of [{ executablePath: '/usr/bin/google-chrome' }, { channel: 'chrome' }, {}]) { try { browser = await pw.chromium.launch(o); break; } catch { /* try next */ } }
if (!browser) { console.log('SKIPPED: no browser available'); process.exit(0); }

const html = readFileSync(file);
const web = http.createServer((req, res) => { if (req.url.split('?')[0] === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); } else { res.writeHead(404); res.end(); } });
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const ORIGIN = 'http://127.0.0.1:' + web.address().port;
const dir = mkdtempSync(path.join(tmpdir(), 'lifeos-smoke-nas-'));
const svc = createApp(loadConfig({}, { configDir: path.join(dir, 'cfg'), dataDir: path.join(dir, 'data'), appOrigins: [ORIGIN], port: 0, log: () => {} }));
await new Promise((r) => svc.server.listen(0, '127.0.0.1', r));
const SVC = 'http://127.0.0.1:' + svc.server.address().port;

const PASS = 'correct horse battery staple';
const MARK = 'NASLEAK marker "quoted" with spaces';
const problems = [], requests = [];
const T = { timeout: 30000 };
const ctx = await browser.newContext({ acceptDownloads: true });
const aiSeen = [];
for (const host of ['ai-nas.lifeos.tazabbas.com', 'ai-pc.lifeos.tazabbas.com']) {
  await ctx.route('https://' + host + '/**', async (route) => {
    const rq = route.request(), cors = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (rq.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    aiSeen.push({ host, url: rq.url(), body: rq.postData() });
    if (host.startsWith('ai-pc') && ctx._pcDown) return route.abort('connectionrefused');
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) });
  });
}
const page = await ctx.newPage();
page.on('console', (m) => { if ((m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION/.test(m.text())) || /content security policy|refused to/i.test(m.text())) problems.push('console: ' + m.text()); });
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('request', (r) => requests.push({ url: r.url(), headers: r.headers(), body: r.postData() }));
async function step(name, fn) { try { await fn(); } catch (e) { problems.push(name + ': ' + String(e.message).split('\n').slice(0, 3).join(' ')); throw e; } }
const text = (sel) => page.textContent(sel);
let token = '';
try {
  await step('create the vault', async () => {
    await page.goto(ORIGIN + '/');
    await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
    await page.click('button:has-text("Create vault")');
    await page.waitForSelector('.tile', T);
    await page.evaluate((b) => globalThis.LifeOS.nas._setBase(b), SVC);
  });
  await step('the NAS card comes first, Drive is the second copy, Sync now waits for a token', async () => {
    await navTo(page, 'Settings'); await page.waitForSelector('#nas-card', T);
    const order = await page.$$eval('#nas-card, #sync-card', (n) => n.map((x) => x.id));
    if (order.join() !== 'nas-card,sync-card') throw new Error('order ' + order.join());
    if (!/second copy/.test(await text('#sync-card h2'))) throw new Error('Drive card title');
    if (!(await page.isDisabled('#nas-sync-now'))) throw new Error('Sync now should wait for a token');
  });
  await step('create a device token: only a hash is shown, and the service registers it', async () => {
    await page.click('#nas-token-new'); await page.waitForSelector('#nas-devname', T);
    await page.fill('#nas-devname', 'bad/name'); await page.click('.dialog button.pri');
    await page.waitForSelector('.dialog:has-text("device name")', T);
    await page.fill('#nas-devname', 'smoke-laptop'); await page.click('.dialog button.pri');
    await page.waitForSelector('#nas-register', T);
    const cmd = await page.inputValue('#nas-register');
    const m = /^token register smoke-laptop ([0-9a-f]{64})$/.exec(cmd);
    if (!m) throw new Error('command: ' + cmd);
    token = await page.evaluate(() => globalThis.LifeOS.store.getState().settings.nas.token);
    if (!/^lfs_/.test(token) || cmd.includes(token) || (await page.content()).includes(token)) throw new Error('the token is visible');
    svc.tokens.register('smoke-laptop', m[1]);
    await page.click('.dialog button.pri');
    await page.waitForSelector('.dialog', { state: 'detached', ...T });
    if (await page.isDisabled('#nas-sync-now')) throw new Error('Sync now should be on');
  });
  await step('Test connection reaches the service with the token', async () => {
    await page.click('#nas-test');
    await page.waitForFunction(() => /accepted this device/.test(document.querySelector('#nas-status').textContent), null, T);
  });
  await step('Sync now writes the NAS (and says Drive is not connected); only ciphertext is on the service', async () => {
    await page.evaluate((t) => globalThis.LifeOS.store.commit((x) => { x.entries.push(globalThis.LifeOS.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2026-11-10', title: t, value: 5, notes: t })); }), MARK);
    await navTo(page, 'Settings'); await page.waitForSelector('#nas-card', T);
    await page.click('#nas-sync-now');
    await page.waitForFunction(() => /Uploaded the encrypted vault to the NAS/.test(document.querySelector('#nas-status').textContent), null, T);
    await page.waitForFunction(() => /not connected/.test(document.querySelector('#nas-drive-status').textContent), null, T);
    const files = readdirSync(path.join(dir, 'data', 'vault')).map((f) => readFileSync(path.join(dir, 'data', 'vault', f), 'utf8')).join('');
    if (!files.length || files.includes('NASLEAK marker') || files.includes(PASS) || files.includes(token)) throw new Error('the service holds more than ciphertext');
    await page.click('#nas-sync-now');
    await page.waitForFunction(() => /already in sync/.test(document.querySelector('#nas-status').textContent), null, T);
  });
  await step('NAS history lists the copy', async () => {
    await page.click('#nas-history'); await page.waitForSelector('.dialog:has-text("NAS history")', T);
    if (!/revision/.test(await text('.dialog'))) throw new Error('no version row');
    await page.keyboard.press('Escape');
  });
  await step('archive 2021 to the NAS: the copy is read back, decrypted and counted as verified', async () => {
    await page.evaluate(() => globalThis.LifeOS.store.commit((x) => { x.entries.push(globalThis.LifeOS.metrics.validateEntry({ domain: 'money', type: 'expense', date: '2021-03-01', title: 'Old lunch', value: 5 })); }));
    await navTo(page, 'Overview'); await navTo(page, 'Settings'); await page.waitForSelector('#arch-year', T);
    await page.selectOption('#arch-year', '2021'); await page.click('#arch-run'); await page.waitForSelector('#arch-pass', T);
    if (!(await page.locator('#arch-nas').isChecked()) || (await page.isDisabled('#arch-nas'))) throw new Error('the NAS copy should be offered and on');
    await page.locator('#arch-dl').uncheck();
    await page.fill('#arch-pass', PASS); await page.click('.dialog button.pri');
    await page.waitForSelector('.notice:has-text("Archived 2021")', T);
    if (!/nas/.test(await text('.notice'))) throw new Error('copies: ' + await text('.notice'));
    if (!existsSync(path.join(dir, 'data', 'archives', 'lifeos-archive-2021.json'))) throw new Error('no archive on the service');
    const arch = await page.evaluate(() => globalThis.LifeOS.store.getState().archives.map((a) => a.copies.map((c) => c.where + ':' + c.verified).join()));
    if (arch[0] !== 'nas:true') throw new Error('archive copies ' + arch);
    if (readFileSync(path.join(dir, 'data', 'archives', 'lifeos-archive-2021.json'), 'utf8').includes('Old lunch')) throw new Error('archive not sealed');
  });
  await step('AI: NAS model and PC model, Test connection for each, fallback, plain message when unreachable', async () => {
    await navTo(page, 'Settings'); await page.waitForSelector('#p-kind', T);
    await page.selectOption('#p-kind', 'nas'); await page.waitForSelector('#p-nas-model', T);
    await page.fill('#p-nas-model', 'small-model'); await page.fill('#p-pc-model', 'big-model');
    await page.click('#p-test'); await page.waitForFunction(() => /Connection works/.test(document.querySelector('#p-test-out').textContent), null, T);
    await page.click('#p-nas-test'); await page.waitForFunction(() => /Connection works/.test(document.querySelector('#p-nas-out').textContent), null, T);
    await page.click('#p-pc-test'); await page.waitForFunction(() => /Connection works/.test(document.querySelector('#p-pc-out').textContent), null, T);
    const hosts = aiSeen.map((a) => a.host);
    if (!hosts.includes('ai-nas.lifeos.tazabbas.com') || !hosts.includes('ai-pc.lifeos.tazabbas.com')) throw new Error('hosts ' + hosts);
    for (const a of aiSeen) { if (!a.url.endsWith('/v1/chat/completions') || /NASLEAK marker|Old lunch|correct horse/.test(a.body || '')) throw new Error('bad request ' + a.url + (a.body || '').slice(0, 80)); const b = JSON.parse(a.body); if (b.messages[1].content !== 'Reply with OK.') throw new Error('not the fixed test prompt'); }
    ctx._pcDown = true;
    await page.click('#p-pc-test'); await page.waitForFunction(() => /Connect Tailscale and try again/.test(document.querySelector('#p-pc-out').textContent), null, T);
    if (!/AI_NETWORK/.test(await text('#p-pc-out'))) throw new Error('code missing');
    await page.selectOption('#p-kind', 'pc'); await page.waitForSelector('#p-pc-model', T);
    await page.fill('#p-nas-model', 'small-model'); await page.fill('#p-pc-model', 'big-model'); await page.selectOption('#p-fallback', 'nas');
    await page.click('button:has-text("Save provider")');
    await page.waitForSelector('.notice:has-text("Provider saved")', T);
    const st = await page.evaluate(() => { const s = globalThis.LifeOS.store.getState().settings; return [s.provider.kind, s.provider.model, s.provider.baseUrl, s.aiHosts.fallback, s.aiHosts.nasModel, s.aiHosts.pcModel].join('|'); });
    if (st !== 'pc|big-model||nas|small-model|big-model') throw new Error('saved ' + st);
    // a host cannot be its own fallback
    await page.selectOption('#p-fallback', 'pc'); await page.click('button:has-text("Save provider")');
    await page.waitForSelector('.notice:has-text("different host")', T);
  });
  await step('SEC-134: after a restore on the NAS, Sync offers to replace the older copy (saved to a file first); the Drive step waits for that choice', async () => {
    await navTo(page, 'Overview'); await navTo(page, 'Settings'); await page.waitForSelector('#nas-card', T);
    await page.click('#nas-sync-now');
    await page.waitForFunction(() => /Uploaded|already in sync/.test(document.querySelector('#nas-status').textContent), null, T);
    const H = { authorization: 'Bearer ' + token };
    const vs = (await (await fetch(SVC + '/v1/versions', { headers: H })).json()).versions;
    if (vs.length < 2) throw new Error('need two versions, have ' + vs.length);
    const rs = await fetch(SVC + '/v1/versions/' + vs[vs.length - 1].id + '/restore', { method: 'POST', headers: { ...H, 'x-expected-rev': String(vs[0].id) } });
    if (rs.status !== 200) throw new Error('restore ' + rs.status);
    await page.click('#nas-sync-now');
    await page.waitForSelector('#nas-rollback', T);
    if (!/waits for the NAS step/.test(await text('#nas-drive-status'))) throw new Error('the Drive step did not wait: ' + await text('#nas-drive-status'));
    const dl = page.waitForEvent('download', T);
    await page.click('.dialog button.bad');
    const d = await dl;
    if (!/^lifeos-nas-copy-\d{4}-\d{2}-\d{2}\.json$/.test(d.suggestedFilename())) throw new Error('file ' + d.suggestedFilename());
    await page.waitForFunction(() => /Uploaded the encrypted vault to the NAS/.test(document.querySelector('#nas-status').textContent), null, T);
    await page.waitForFunction(() => /not connected/.test(document.querySelector('#nas-drive-status').textContent), null, T);
    await page.click('#nas-sync-now');
    await page.waitForFunction(() => /already in sync/.test(document.querySelector('#nas-status').textContent), null, T);
  });
  await step('the service is switched off: the page says "Connect Tailscale and try again", and no raw network text appears', async () => {
    svc.server.closeAllConnections(); await new Promise((r) => svc.server.close(r));
    await navTo(page, 'Overview'); await navTo(page, 'Settings'); await page.waitForSelector('#nas-card', T);
    await page.click('#nas-sync-now');
    await page.waitForFunction(() => /Connect Tailscale and try again/.test(document.querySelector('#nas-status').textContent), null, T);
    const t = await text('#nas-status');
    if (/fetch|ECONN|ERR_|Failed/i.test(t)) throw new Error('raw network text: ' + t);
    await page.click('#nas-test');
    await page.waitForFunction(() => /NAS_UNREACHABLE/.test(document.querySelector('#nas-status').textContent), null, T);
  });
  await step('the token appears nowhere outside the Authorization header to the service: not in the DOM, URL, storage, console or any other request', async () => {
    const leak = await page.evaluate((tk) => ({ ls: localStorage.length, ss: JSON.stringify(Object.assign({}, sessionStorage)).includes(tk), href: location.href.includes(tk), dom: document.documentElement.outerHTML.includes(tk) || document.body.innerText.includes(tk) }), token);
    if (leak.ls || leak.ss || leak.href || leak.dom) throw new Error('token leak ' + JSON.stringify(leak));
    const raw = await page.evaluate(() => new Promise((res, rej) => { const r = indexedDB.open('lifeos', 1); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('envelope'); g.onsuccess = () => { r.result.close(); res(JSON.stringify(g.result)); }; g.onerror = rej; }; r.onerror = rej; }));
    if (raw.includes(token) || raw.includes(PASS) || raw.includes('NASLEAK marker')) throw new Error('stored bytes hold plaintext');
    for (const r of requests) {
      const auth = r.headers.authorization || '';
      if (auth && !r.url.startsWith(SVC)) throw new Error('an Authorization header left for ' + r.url.slice(0, 40));
      if (r.url.includes(token) || (r.body || '').includes(token) || (!r.url.startsWith(SVC) && JSON.stringify(r.headers).includes(token))) throw new Error('token in a request');
      if (r.url.startsWith(SVC) && /NASLEAK marker|Old lunch|correct horse/.test(r.body || '')) throw new Error('plaintext sent to the service');
    }
    if (!requests.some((r) => r.url.startsWith(SVC + '/v1/vault') && r.method !== 'OPTIONS')) throw new Error('no service request seen, so the check proves nothing');
  });
} catch (e) { /* recorded in problems */ }
await browser.close();
web.close(); try { svc.server.close(); } catch (e) { /* already closed */ }
rmSync(dir, { recursive: true, force: true });
if (problems.length) { console.error('FAIL smoke-nas\n' + problems.join('\n')); process.exit(1); }
console.log('smoke-nas ok');
