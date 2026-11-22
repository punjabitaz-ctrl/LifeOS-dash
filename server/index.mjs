#!/usr/bin/env node
// LifeOS sync service. Usage:
//   node server/index.mjs                         run the service
//   node server/index.mjs token add <device>      make a token for a device (printed once, stored only as a hash)
//   node server/index.mjs token register <device> <sha256-hex>   register a token by its hash (what the app shows)
//   node server/index.mjs token revoke <device>   stop a device's token working at once
//   node server/index.mjs token list              device names and dates (never hashes or tokens)
import { loadConfig } from './lib/config.mjs';
import { createApp } from './lib/app.mjs';
import { Tokens } from './lib/tokens.mjs';
import { fileURLToPath } from 'node:url';

export async function cli(argv, env = process.env, out = (s) => process.stdout.write(s + '\n')) {
  if (argv[0] === 'token') {
    const cfg = loadConfig(env, { appOrigins: ['https://example.invalid'] });
    const t = new Tokens(cfg.tokensFile);
    const [, sub, name, arg] = argv;
    if (sub === 'add' && name) { out('Token for ' + name + ' (shown once, copy it now): ' + t.add(name)); return 0; }
    if (sub === 'register' && name && arg) { t.register(name, arg); out('Registered ' + name + '.'); return 0; }
    if (sub === 'revoke' && name) { const ok = t.revoke(name); out(ok ? 'Revoked ' + name + '.' : 'No device called ' + name + '.'); return ok ? 0 : 1; }
    if (sub === 'list') { for (const d of t.list()) out(d.name + '  ' + d.createdAt); return 0; }
    out('Usage: token add <device> | register <device> <sha256-hex> | revoke <device> | list');
    return 2;
  }
  const cfg = loadConfig(env);
  const { server } = createApp(cfg);
  await new Promise((r) => server.listen(cfg.port, cfg.host, r));
  out('lifeos-sync listening on ' + cfg.host + ':' + server.address().port);
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  return new Promise(() => {});
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write('Error: ' + e.message + '\n'); process.exit(1); });
}
