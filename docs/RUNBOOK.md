# LifeOS runbook

For the owner and any engineer. Plain steps; nothing here needs a secret in the repo.

## Version and release
- The only version source is `package.json`. `node build.mjs` injects it into the app (Settings shows "LifeOS v<version>") and into README.md, and fails if the version line in the header of docs/HANDOFF.md disagrees. A test fails if any other version string in the repo disagrees.
- To release: change `version` in package.json, run `node build.mjs`, update docs/HANDOFF.md (header version) and docs/CHANGELOG.md, run `node --test test/` and `node test/smokes.mjs`, commit and push to main.
- Tags: the workflow `.github/workflows/tag-release.yml` runs on every push to main and creates the tag `v<version>` from package.json if it does not exist. It uses only the built-in GITHUB_TOKEN with `contents: write`; no secret is added.

### Backfill tags v1.0.0, v1.1.0 and v1.2.0
Do this once, after the workflow file is on main. In GitHub: Actions, then "tag-release", then "Run workflow" on branch main. Fill the two boxes exactly as below, one run per tag. The hashes come from `git log`.

| Tag | version box | commit box |
|---|---|---|
| v1.0.0 | `1.0.0` | `3e0fd18c8b9e95feb81b8d465c18855e48ec3c05` |
| v1.1.0 | `1.1.0` | `3592f5e54fa87756d9c109eec1791768957dd34e` |
| v1.2.0 | `1.2.0` | `90be56637fc58077acc7dd636a354c12d2878db3` |

Or with the GitHub CLI, from any folder:
```
gh workflow run tag-release.yml -f version=1.0.0 -f commit=3e0fd18c8b9e95feb81b8d465c18855e48ec3c05
gh workflow run tag-release.yml -f version=1.1.0 -f commit=3592f5e54fa87756d9c109eec1791768957dd34e
gh workflow run tag-release.yml -f version=1.2.0 -f commit=90be56637fc58077acc7dd636a354c12d2878db3
```
A run for a tag that already exists ends with "Tag ... already exists" and changes nothing; an existing tag is never moved. The commit must be the full 40-character hash of a commit on main, and the version box must equal the version in package.json on that commit, or the run stops without tagging. A v1.0.0 tag may exist in a local clone without being on GitHub; the run creates it on GitHub if it is missing there.

## How the live copy deploys
- The live copy is a Cloudflare Worker with static assets (free tier) behind a Cloudflare Access sign-in (as recorded in docs/HANDOFF.md). Cloudflare builds and deploys from the `main` branch on every push. The built files `dist/lifeos.html`, `dist/_headers` and `_headers` are committed; if the build command in the dashboard is empty, what is live is what `node build.mjs` wrote before the commit. None of the dashboard settings are in this repo, so confirm them in the dashboard rather than from this file.
- There is no wrangler or Worker config file in the repo, on purpose: the deployment is set in the Cloudflare dashboard, and a config file could change it. Record these dashboard settings in docs/FIRST-RUN.md the first time you look at them: the Worker name, the connected repository and branch, the build command (if any), the assets directory, and the Access application and policy.
- Live address: https://lfs-dsh.punjabitaz.workers.dev/dist/lifeos

## Verify a release
1. Open the live copy after the deploy finishes, sign in, unlock, open Settings. The line at the bottom of the first card group says "LifeOS v<version>"; it must match package.json.
2. Run the header check from a trusted machine, with an Access service token set in the environment (never in a file in the repo):
   `CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... node scripts/check-live.mjs`
   It prints PASS, or each header that differs from `_headers`, and exits non-zero on a mismatch.
3. Confirm the tag exists on GitHub (Code, Tags).

## Roll back
- Redeploy an earlier commit from the Cloudflare dashboard (open the Worker's deployments and roll back to an earlier one; the exact menu names are in the dashboard, not in this repo), or revert the commit on main and push.
- The schema rule: an older app refuses a vault written by a newer schema, by design, so it can never strip data. Roll the code back only to a version with the same schema as your current vault. Schemas by version: 1.3.0 is 15; 1.2.0 is 14; 1.1.0 is 12; 1.0.0 is 11. Check docs/CHANGELOG.md.
- What an older app does with a newer vault: unlocking shows "Invalid data: unsupported schema" and nothing opens. The lock screen offers no way to wipe or replace a vault, and Wipe in Settings needs an unlocked vault, so on that device the older app cannot use its browser storage until the site data is cleared. A newer-schema backup file or Drive copy is refused the same way.
- To go back across a schema change anyway: you need a backup file made on the older version (the same schema as the version you roll back to). A backup made on the newer version cannot be restored by the older app. Before rolling back, export a backup on the newer version too and keep it, so you can roll forward later without loss. Then, on each device: roll back, clear the site data for the LifeOS address in the browser settings (this erases the vault on that device, so be sure the backups exist first), create a new vault, and use Settings, Import backup with the older backup. Everything entered after that older backup was made is not in the older app. Drive sync from a device still on the newer schema is refused by the older app. When unsure, roll forward instead.
- After any rollback, open Settings and confirm the version line.

## Install as an app and updates
- Sign in to Cloudflare Access in that browser first. The page fetches its manifest with that sign-in (crossorigin use-credentials); without it the install would get the sign-in page instead.
- iPhone: open the live address in Safari, tap Share, then Add to Home Screen. The home-screen icon is carried inside the page (a data: link, so the page policy stays images from data: only). Not yet tried on a real iPhone.
- Android: open the live address in Chrome, then the menu and Install app (or Add to Home screen). Not yet tried on a real phone.
- The service worker (dist/sw.js) keeps only the app shell (the page, the manifest and the icons) so the app opens offline. Your data stays only in the encrypted vault in the browser; nothing private is ever in that cache. It registers on https only.
- If the Access sign-in has expired, opening the app online shows the sign-in page (the worker passes it through and never keeps it); offline it opens the kept copy of the page.
- Updates: the worker asks the network first. When a new version is deployed, a "New version ready" notice with a Reload button appears. Reloading locks the app, so it asks first while unlocked. Nothing reloads by itself.
- If an install or an update looks stuck: close the app fully and open it again, or clear the site data for the LifeOS address after exporting a backup.
- Cloudflare headers: `_headers` gives dist/sw.js its own policy (it removes the page policy for that one file and allows fetches to its own origin). Confirm with scripts/check-live.mjs and by opening the live address once with developer tools.

## If the vault will not open
1. Check the passphrase for typing errors, caps lock and keyboard layout. The same passphrase must be used on every device unless it was changed on one of them.
2. "The data may be damaged" with the right passphrase: do not wipe. Close the tab, reopen the page and try again; try another browser profile on the same device only to read, never to write.
3. If unlocking shows "Invalid data: unsupported schema", the vault was written by a newer version than the one deployed. Open the newest deployed version (see the schema rule above); do not clear the site data.
4. Restore from the newest backup file. The lock screen has no import and no wipe while a vault exists, so do this in a separate browser profile or another browser (its storage is separate): create a throwaway vault there, then Settings, Import backup, enter the backup passphrase. Use Settings, "Verify a backup file" first to check a backup without writing anything.
5. Drive copy: with sync set up, in that separate profile create a throwaway vault, connect, and Sync now; you will be asked for the Drive copy's passphrase.
6. A forgotten passphrase cannot be recovered. A forgotten private vault passphrase loses the private vault on every device and backup.
