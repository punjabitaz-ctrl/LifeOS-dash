# LifeOS

LifeOS (Living Independent and Free Everyday Operating System) is a single-file, offline, local-first life dashboard. It tracks ten areas (money, assets, work, health and more), builds weekly reviews, and keeps a memory of insights you approve. Vanilla JS, no dependencies.

## Open it

Build, then open `dist/lifeos.html` in a browser (double-click works, it needs no server).

## Tests and build

- `node --test test/` runs the unit and security tests.
- `node build.mjs` writes `dist/lifeos.html`.
- `node test/smoke.mjs` runs a headless browser flow at desktop and 390x844 mobile sizes. It needs Playwright (`npm i --no-save playwright`) and Chrome, and skips itself if they are missing.

## Security model

- All data lives in one AES-GCM encrypted envelope in IndexedDB; the key comes from your passphrase via PBKDF2 (600,000 iterations) and is never stored.
- A strict CSP allows no inline handlers, no eval and no network except an optional AI provider you configure.
- The AI only proposes insights; nothing becomes approved without your explicit tap, and backup restores can re-queue approved insights for review.
- The model sees only a numeric weekly digest plus a few approved insights and lessons, never raw entries or names.
- All imported data (CSV, backups, AI replies) is validated. Details and findings: [docs/SECURITY.md](docs/SECURITY.md).
