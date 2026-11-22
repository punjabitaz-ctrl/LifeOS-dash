# NAS setup (v2.0.0)

Your NAS keeps the main encrypted copy of the vault and your archive files. Google Drive stays as the second copy. The service stores only ciphertext. It never receives your passphrase, recovery key or any readable data. You reach it over Tailscale, so it answers only on your tailnet.

Names below are the defaults in `config/hosts.json`. Change a name there, rebuild (`node build.mjs`), and use the new name everywhere in this guide.

| Role | Default name | Where it runs |
|---|---|---|
| App | `lifeos.tazabbas.com` | Cloudflare Worker behind Access (as today) |
| Sync service | `sync.lifeos.tazabbas.com` | NAS |
| Small model | `ai-nas.lifeos.tazabbas.com` | NAS (see docs/AI-SETUP.md) |
| Stronger model | `ai-pc.lifeos.tazabbas.com` | PC (see docs/AI-SETUP.md) |

## 1. What you need
- TrueNAS with the Apps feature (menu names differ between TrueNAS versions; follow the same steps in yours).
- Tailscale running on the NAS, your phone, laptop and desktop, all on one tailnet.
- Your Cloudflare account for `tazabbas.com`, and a Cloudflare API token limited to "Edit zone DNS" for that one zone. Keep the token on the NAS only: never in this repository, the app or a chat.

## 2. A dataset
Create a dataset for the service, for example `POOL/lifeos`, with two folders: `data` (ciphertext) and `config` (token hashes). Give the app user write access to both. Include `data` in your snapshots and backups: it holds the last 30 copies of the vault and your archive files.

## 3. Build and run the service as a custom app
The service is `server/` in this repository: Node built-ins only, nothing to install.

1. Copy the repository (or just `server/`) to the NAS and build the image from the repository root: `docker build -f server/Dockerfile -t lifeos-sync:2.0.0 .`
2. In Apps, install a custom app by YAML and paste `server/compose.yaml`. Replace the two `/mnt/POOL/lifeos/...` paths with your dataset paths. Set `LIFEOS_APP_ORIGINS` to the app address (`https://lifeos.tazabbas.com`). While you still use the workers.dev copy, add it comma separated (for example `https://lifeos.tazabbas.com,https://your-name.workers.dev`); remove it when you retire that address. CORS allows only the origins listed here.
3. The service listens on plain http on the NAS. The compose file publishes it on `127.0.0.1:8787` only, for Caddy on the same machine. Do not publish it to the internet and open no router ports.

Settings are environment variables (or `config/config.json` in the config folder): `LIFEOS_APP_ORIGINS`, `LIFEOS_DATA_DIR`, `LIFEOS_CONFIG_DIR`, `LIFEOS_PORT`, `LIFEOS_HOST`, `LIFEOS_TRUST_PROXY=1` (behind Caddy, so rate limits use the real client address). Limits: 64 MB per vault copy or archive file, 2 uploads read at a time (`maxUploads` in config.json, at most 16), 30 vault versions kept, 200 archive files, 20 devices, rate limits per client.

## 4. Tailscale and DNS
1. In the Tailscale admin page note the NAS's Tailscale address (it starts with 100.). Do not write it in this repository.
2. In Cloudflare DNS add an A record for `sync.lifeos` (and `ai-nas.lifeos`) pointing at that address. Set it to DNS only (grey cloud), never proxied. The name then resolves for anyone, but the address works only on your tailnet.
3. Add no port forwards on the router.

## 5. Caddy (TLS)
Caddy gets a Let's Encrypt certificate through the Cloudflare DNS challenge, so the NAS needs no open port.
1. Run Caddy on the NAS with the Cloudflare DNS module (for example an image built with `xcaddy build --with github.com/caddy-dns/cloudflare`).
2. Put the Cloudflare token in Caddy's environment as `CLOUDFLARE_API_TOKEN` (the app's environment settings, not a file in the repository).
3. Use `server/Caddyfile.example` as the Caddyfile. It reads the token from the environment and proxies `sync.lifeos.tazabbas.com` to `127.0.0.1:8787`.
4. On a device with Tailscale connected, open `https://sync.lifeos.tazabbas.com/v1/health`. Seeing `{"code":"AUTH"}` means TLS and the route work and the token check is waiting for a token.

## 6. The first device token
Tokens are made in the app and kept only inside the encrypted vault. The service registers a token by its hash.
1. In LifeOS, Settings, NAS sync: Create device token. Give the device a name (for example `laptop`). The app shows one line: `token register laptop <hash>`.
2. On the NAS run the service command with that line. In the container: `docker exec -it <container> node index.mjs token register laptop <hash>`. (In a plain checkout: `node server/index.mjs token register laptop <hash>`.)
3. Press Test connection in the app. Then Sync now: the vault is written to the NAS and, when Google Drive is connected, to Drive.
4. Repeat on each device with its own name. Other commands: `token list` (names and dates only), `token revoke <name>` (works on the next request, no restart), and `token add <name>` which makes a token on the service and prints it once (paste it in the app with "Use a token from the service").
Each device has its own token, so you can revoke one lost phone without touching the others. A token is never shown in the app, never in a URL, and the service stores only its hash.

## 7. Day to day
- Sync is manual. Settings, NAS sync, Sync now writes the NAS first, then Google Drive. Both statuses show. If both copies changed you see the same "Both copies changed" choice as before; the copy you do not keep is saved to a file first.
- "NAS history" lists the last 30 copies; save one as a file and restore it with Settings, Restore from a backup file (it opens with the passphrase that was in force when it was made). Restoring on the service (`POST /v1/versions/<id>/restore`) exists for repairs. After such a restore, or after rolling the dataset back to a snapshot, the NAS holds a copy older than the one your devices last synced. The app never uses that copy: Sync now says it is older and offers "Replace the NAS copy", which saves the NAS copy to a file first and then uploads this device's copy. Do that only if you expected the older copy (check the NAS first if you did not).
- Archiving can keep a NAS copy: it is written, read back, decrypted and matched before anything leaves the vault.
- If a home name cannot be reached the app says "Connect Tailscale and try again". Check that Tailscale is connected on that device.

## 8. Moving the vault to the new app address
Browser storage belongs to one address, so the vault does not follow you to `lifeos.tazabbas.com` by itself. Either way, the old address keeps working until you retire it.
- Backup and restore: on the old address, Settings, export an encrypted backup. On the new address, on the lock screen, restore from that backup with its passphrase (a recovery key works too). Then create a NAS token for the new address and sync.
- Or Google Drive: add the new origin to your Google OAuth client (authorised origin and redirect URI, docs/SYNC-SETUP.md), connect Drive on the new address and use the Drive copy as the first vault on the lock screen.
A restored or downloaded copy never brings another device's NAS token: each browser creates its own.

## 9. What the service sees and keeps
- It reads only the outer fields of an envelope (format, revision, sizes) and never decrypts. It rebuilds what it stores from the known fields, so nothing else a client sends is kept.
- Logs hold the method, a fixed route label, the status code and byte counts: no address, path value, token, header or content.
- CORS answers only the configured app origins. Every route needs a device token. Failed tokens are rate limited.
- Keep the dataset on the NAS only; it is useless without your passphrase or recovery key, but it is still your whole vault.
