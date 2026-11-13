import path from 'node:path';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '..', 'dist', 'lifeos.html');
if (!existsSync(file)) { console.error('dist/lifeos.html missing: run node build.mjs first'); process.exit(1); }
let pw;
try { pw = await import('playwright'); } catch { console.log('SKIPPED: playwright not available (npm i --no-save playwright)'); process.exit(0); }
let browser;
for (const o of [{ executablePath: '/usr/bin/google-chrome' }, { channel: 'chrome' }, {}]) {
  try { browser = await pw.chromium.launch(o); break; } catch { /* try next */ }
}
if (!browser) { console.log('SKIPPED: no browser available'); process.exit(0); }

// Test-only static server. The app offers sync on https, plus a hostname exception for localhost/127.0.0.1.
const html = readFileSync(file);
const server = http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;

const TOKEN = 'ya29.SMOKETOKEN_abcdefghijklmnopqrstuvwxyz0123456789';
const PASS = 'correct horse battery staple';
const CID = 'smoke-test-123.apps.googleusercontent.com';
const drive = { file: null, version: 0, etag: '"v0"', writes: 0 };
const problems = [];
let consentMode = 'ok';

async function wire(ctx, label) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,if-match', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', 'access-control-expose-headers': 'etag' };
  await ctx.route('https://accounts.google.com/**', (route) => {
    const u = new URL(route.request().url());
    const sc = u.searchParams.get('scope'), rt = u.searchParams.get('response_type');
    if (sc !== 'https://www.googleapis.com/auth/drive.appdata' || rt !== 'token' || u.searchParams.get('client_id') !== CID) problems.push(label + ' bad auth url ' + u.search);
    const state = consentMode === 'badstate' ? 'forged' : u.searchParams.get('state');
    route.fulfill({ status: 302, headers: { location: u.searchParams.get('redirect_uri') + '#access_token=' + TOKEN + '&token_type=Bearer&expires_in=3599&state=' + state + '&scope=' + encodeURIComponent(sc) } });
  });
  await ctx.route('https://www.googleapis.com/**', async (route) => {
    const rq = route.request(), u = new URL(rq.url()), m = rq.method();
    const send = (status, body, extra) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json', ...(extra || {}) }, body: body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body)) });
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (rq.headers().authorization !== 'Bearer ' + TOKEN) return send(401, {});
    if (u.pathname === '/drive/v3/files') return send(200, { files: drive.file ? [{ id: 'smokefile01', size: String(drive.file.length), version: String(drive.version) }] : [] });
    if (u.pathname === '/drive/v3/files/smokefile01' && u.searchParams.get('alt') === 'media') return send(200, drive.file, { etag: drive.etag });
    if (u.pathname === '/drive/v3/files/smokefile01') return send(200, { id: 'smokefile01', version: String(drive.version) });
    const put = (t) => { drive.file = t; drive.version++; drive.etag = '"v' + drive.version + '"'; drive.writes++; };
    if (m === 'POST') { put(rq.postData().split('Content-Type: application/json\r\n\r\n')[1].split('\r\n--')[0]); return send(200, { id: 'smokefile01' }); }
    if (m === 'PATCH') {
      const im = rq.headers()['if-match'];
      if (im && im !== drive.etag) return send(412, {});
      put(rq.postData()); return send(200, { id: 'smokefile01' });
    }
    return send(500, {});
  });
}
async function newPage(label) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  await wire(ctx, label);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push(label + ' pageerror: ' + e.message));
  return { ctx, page };
}
async function step(label, name, fn) { try { await fn(); } catch (e) { problems.push(label + ' ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' ')); throw e; } }
const T = { timeout: 30000 };
async function create(page) {
  await page.goto(ORIGIN + '/');
  await page.fill('#pass', PASS); await page.fill('#pass2', PASS);
  await page.click('button:has-text("Create vault")');
  await page.waitForSelector('.tile', T);
}
async function addRun(page, title) {
  await page.click('.nav button:has-text("Home")');
  await page.click('.tile[data-domain="health"]');
  await page.selectOption('#f-type', 'workout');
  await page.fill('#f-title', title);
  await page.click('button:has-text("Add entry")');
  await page.waitForSelector('.entry:has-text("' + title + '")');
}
async function settings(page) { await page.click('.nav button:has-text("Settings")'); await page.waitForSelector('#sync-card'); }
async function connect(page) {
  await settings(page);
  await page.fill('#sync-cid', CID);
  await page.click('#sync-save');
  await page.waitForFunction(() => /Client ID saved/.test(document.querySelector('#sync-status').textContent));
  await Promise.all([page.waitForNavigation({ url: ORIGIN + '/' }), page.click('#sync-connect')]);
  await page.waitForSelector('#pass');
  const leak = await page.evaluate(() => ({ hash: location.hash, href: location.href, ss: JSON.stringify(Object.assign({}, sessionStorage)), ls: localStorage.length }));
  if (leak.hash || leak.href.includes('access_token') || leak.href.includes('SMOKETOKEN')) throw new Error('fragment not removed');
  if (leak.ls || leak.ss.includes('SMOKETOKEN')) throw new Error('storage holds data');
  await page.fill('#pass', PASS);
  await page.click('button:has-text("Unlock")');
  await page.waitForSelector('.dialog:has-text("Sync with Google Drive?")', T);
}
// Schema 2 money data, entered through the UI (same selectors as smoke-money.mjs).
async function addMoney(page) {
  await page.click('.nav button:has-text("Assets")');
  for (const [name, kind, bal] of [['Checking', 'cash', '5000.00'], ['Visa', 'credit', '1250.25']]) {
    await page.fill('#ac-name', name); await page.selectOption('#ac-kind', kind); await page.fill('#ac-bal', bal);
    await page.click('#ac-add');
    await page.waitForSelector('.acct[data-account="' + name + '"]');
  }
  await page.click('.nav button:has-text("Money")');
  await page.click('#budgets summary');
  await page.selectOption('#bud-cat', 'Groceries'); await page.fill('#bud-amount', '150');
  await page.click('button:has-text("Save budget")');
  await page.waitForSelector('.notice:has-text("Budget saved.")');
  await page.click('#recurring summary');
  await page.fill('#rc-title', 'Gym'); await page.fill('#rc-amount', '30'); await page.selectOption('#rc-cat', 'Health');
  await page.click('button:has-text("Add recurring")');
  await page.waitForSelector('#due-card:has-text("Gym")');
}
async function expectMoney(page, who) {
  await page.click('.nav button:has-text("Assets")');
  await page.waitForSelector('.acct[data-account="Visa"]', T);
  await page.waitForSelector('.acct[data-account="Checking"]');
  const net = (await page.textContent('#aw-net')).trim();
  if (net !== '$3,749.75') throw new Error(who + ' net worth ' + net);
  await page.click('.nav button:has-text("Money")');
  await page.waitForSelector('#due-card:has-text("Gym")');
  const spend = (await page.textContent('#mv-spend')).trim();
  if (spend !== '$0.00') throw new Error(who + ' recurring was posted without a tap: ' + spend);
  await page.click('#budgets summary');
  const row = await page.textContent('.catrow:has-text("Groceries")');
  if (!row.includes('$150.00')) throw new Error(who + ' budget missing: ' + row);
}
// A vault written by an older build (schema 1, no rev fields), placed in IndexedDB before the app loads it.
async function seedSchema1(page) {
  const { L } = await import('./_load.mjs');
  const salt = L.vault.newSalt(), key = await L.vault.deriveKey(PASS, salt);
  const env = await L.vault.makeEnvelope(key, salt, { schema: 1, settings: { currency: 'USD', autoLockMin: 15, targets: { workoutsPerWeek: 4, contactDays: 30, savingsRate: 0.2 }, provider: { kind: 'none', baseUrl: '', model: '', apiKey: '' } }, entries: [], memory: { insights: [], lessons: [], reviews: [] }, audit: [] });
  await page.goto(ORIGIN + '/');
  await page.evaluate((env) => new Promise((res, rej) => {
    const r = indexedDB.open('lifeos', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite'); t.objectStore('kv').put(env, 'envelope'); t.oncomplete = () => { r.result.close(); res(); }; t.onerror = rej; };
    r.onerror = rej;
  }), env);
  await page.reload();
  await page.waitForSelector('#pass');
  if (await page.locator('#pass2').count()) throw new Error('seeded vault not found');
}
const run = async (page) => {
  await settings(page);
  await page.click('#sync-now');
};

const A = await newPage('A'), B = await newPage('B'), C = await newPage('C'), D = await newPage('D');
try {
  await step('A', 'create+entry', async () => { await create(A.page); await addRun(A.page, 'Run A1'); await addMoney(A.page); });
  await step('A', 'connect', async () => {
    await connect(A.page);
    await A.page.click('.dialog button:has-text("Sync now")');
    await A.page.waitForFunction(() => !document.querySelector('.dialog'), null, T);
    if (!drive.file || drive.writes !== 1) throw new Error('first upload did not happen');
    const env = JSON.parse(drive.file);
    if (typeof env.rev !== 'number' || !env.ct || /Run A1|Checking|Visa|Gym|Groceries/.test(JSON.stringify(env))) throw new Error('uploaded envelope looks wrong');
  });
  await step('B', 'download with same passphrase', async () => {
    await create(B.page);
    await connect(B.page);
    await B.page.click('.dialog button:has-text("Sync now")');
    await B.page.waitForSelector('.notice:has-text("another vault")', T);
    await run(B.page);
    await B.page.waitForSelector('#sync-pass', T);
    await B.page.fill('#sync-pass', 'wrong passphrase here');
    await B.page.click('.dialog button:has-text("Continue")');
    await B.page.waitForSelector('.dialog:has-text("different passphrase")', T);
    await B.page.fill('#sync-pass', PASS);
    await B.page.click('.dialog button:has-text("Continue")');
    await B.page.waitForSelector('.dialog:has-text("A newer copy is on Drive")', T);
    if (drive.writes !== 1) throw new Error('write happened before the user chose');
    await B.page.click('.dialog button:has-text("Continue")');
    await B.page.waitForSelector('.notice:has-text("Downloaded")', T);
    await expectMoney(B.page, 'B');
    // SEC-16: locking drops the Google token. After unlock there is no sync prompt and Sync now is disabled.
    await B.page.click('.top button:has-text("Lock")');
    await B.page.waitForSelector('#pass');
    await B.page.fill('#pass', PASS);
    await B.page.click('button:has-text("Unlock")');
    await B.page.waitForSelector('.tile', T);
    await B.page.waitForTimeout(300);
    if (await B.page.locator('.dialog').count()) throw new Error('sync prompt after lock: token survived the lock');
    await settings(B.page);
    if (!(await B.page.isDisabled('#sync-now'))) throw new Error('still connected after lock');
    if (!/Not connected/.test(await B.page.textContent('#sync-conn'))) throw new Error('connection state wrong after lock');
    await connect(B.page);
    await B.page.click('.dialog button:has-text("Sync now")');
    await B.page.waitForSelector('.notice:has-text("Already in sync")', T);
    await B.page.click('.tile[data-domain="health"]');
    await B.page.waitForSelector('.entry:has-text("Run A1")');
  });
  await step('A+B', 'conflict', async () => {
    await addRun(A.page, 'Run A2');
    await run(A.page);
    await A.page.waitForFunction(() => /Uploaded/.test(document.querySelector('#sync-status').textContent), null, T);
    await addRun(B.page, 'Run B2');
    const w = drive.writes;
    await run(B.page);
    await B.page.waitForSelector('.dialog:has-text("Both copies changed")', T);
    const txt = await B.page.textContent('.dialog');
    if (!/This device/.test(txt) || !/Google Drive/.test(txt) || !/Revision \d+/.test(txt) || !/entries/.test(txt)) throw new Error('summaries missing: ' + txt);
    if (drive.writes !== w) throw new Error('conflict wrote to Drive');
    await B.page.selectOption('#sync-choice', 'remote');
    const [dl] = await Promise.all([B.page.waitForEvent('download'), B.page.click('.dialog button:has-text("Continue")')]);
    if (!/lifeos-local-copy/.test(dl.suggestedFilename())) throw new Error('no local backup download: ' + dl.suggestedFilename());
    await B.page.waitForSelector('.notice:has-text("Downloaded")', T);
    await B.page.click('.nav button:has-text("Home")');
    await B.page.click('.tile[data-domain="health"]');
    await B.page.waitForSelector('.entry:has-text("Run A2")');
    if (await B.page.locator('.entry:has-text("Run B2")').count()) throw new Error('local copy should have been replaced');
  });
  await step('C', 'forged state rejected', async () => {
    await create(C.page);
    consentMode = 'badstate';
    await settings(C.page);
    await C.page.fill('#sync-cid', CID); await C.page.click('#sync-save');
    await C.page.waitForFunction(() => /Client ID saved/.test(document.querySelector('#sync-status').textContent));
    await Promise.all([C.page.waitForNavigation({ url: ORIGIN + '/' }), C.page.click('#sync-connect')]);
    await C.page.waitForSelector('#pass');
    if (await C.page.evaluate(() => location.hash)) throw new Error('fragment kept');
    await C.page.fill('#pass', PASS); await C.page.click('button:has-text("Unlock")');
    await C.page.waitForSelector('.dialog:has-text("could not be verified")', T);
    consentMode = 'ok';
    await C.page.click('.dialog button:has-text("OK")');
    await settings(C.page);
    if (!(await C.page.isDisabled('#sync-now'))) throw new Error('should not be connected');
  });
  await step('D', 'schema 1 device downloads schema 2 remote', async () => {
    await seedSchema1(D.page);
    await D.page.fill('#pass', PASS); await D.page.click('button:has-text("Unlock")');
    await D.page.waitForSelector('.tile', T);
    const w = drive.writes;
    await settings(D.page);
    await D.page.fill('#sync-cid', CID); await D.page.click('#sync-save');
    await D.page.waitForFunction(() => /Client ID saved/.test(document.querySelector('#sync-status').textContent));
    await connect(D.page);
    await D.page.click('.dialog button:has-text("Sync now")');
    await D.page.waitForSelector('.notice:has-text("another vault")', T);
    await run(D.page);
    await D.page.waitForSelector('#sync-pass', T);
    await D.page.fill('#sync-pass', PASS);
    await D.page.click('.dialog button:has-text("Continue")');
    await D.page.waitForSelector('.dialog:has-text("A newer copy is on Drive")', T);
    await D.page.waitForSelector('#sync-passdiff');
    if (drive.writes !== w) throw new Error('D wrote before choosing');
    await D.page.click('.dialog button:has-text("Continue")');
    await D.page.waitForSelector('.notice:has-text("Downloaded")', T);
    await expectMoney(D.page, 'D');
    await D.page.click('.top button:has-text("Lock")');
    await D.page.waitForSelector('#pass');
    await D.page.fill('#pass', PASS); await D.page.click('button:has-text("Unlock")');
    await D.page.waitForSelector('.tile', T);
    await expectMoney(D.page, 'D after unlock');
    if (drive.writes !== w) throw new Error('D wrote to Drive during a download');
  });
} catch (e) { /* recorded by step */ }
await browser.close();
server.close();
if (problems.length) { console.error('SMOKE-SYNC FAILED:\n' + problems.join('\n')); process.exit(1); }
console.log('smoke-sync OK: connect, first upload (schema 2 money data), second context download, token dropped on lock, conflict dialog, forged state rejected, schema 1 device downloads schema 2 remote');
