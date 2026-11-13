# LifeOS

LifeOS (Living Independent and Free Everyday Operating System) is a single-file, offline, local-first life dashboard. It tracks ten areas (money, assets, work, health and more), builds weekly reviews, and keeps a memory of insights you approve. Vanilla JS, no dependencies.

## Open it

Build, then open `dist/lifeos.html` in a browser (double-click works, it needs no server).

## Tests and build

- `node --test test/` runs the unit and security tests.
- `node build.mjs` writes `dist/lifeos.html`.
- `node test/smoke.mjs` runs a headless browser flow at desktop and 390x844 mobile sizes. It needs Playwright (`npm i --no-save playwright`) and Chrome, and skips itself if they are missing.
- `node test/smoke-money.mjs` runs the Money and Assets flow (accounts, quick add, budget, recurring, lock) at desktop and 390x844 sizes.
- `node test/smoke-sync.mjs` runs Google Drive sync against a mocked Drive; `node test/smoke-work.mjs` runs the Work flow (projects, outcomes, pipeline, older backup restore) at desktop and 390x844 sizes.
- `node build.mjs` also writes `_headers` (Cloudflare Pages) with the same CSP plus frame-ancestors.

## v0.4.0: Work

- Work view: projects with next actions and overdue dates, this week's outcomes with one-tap done, a job, deal and partner pipeline by stage with a 14-day stale flag, and an 8-week trend. Carry-over of unfinished outcomes is only offered, never automatic.
- Vault schema 3, migrated from schema 1 and 2 with no data loss. Older versions refuse a schema 3 vault, and an older-format backup or Drive copy cannot remove projects and pipeline without an explicit tick.

## v0.5.0: Health

- Health view: today card (training cycle status, one-tap daily checks, quick log of workout, weight and sleep), week view with sessions, minutes and mix by workout type, weight and body fat trends with a 7-entry average, weekly rate and progress to target (lb or kg), sleep average, and up to 8 yes/no daily checks with a 7-day rate and streak. A tracker only: no medical advice.
- Vault schema 4, migrated from schema 1 to 3 with no data loss. Older-format backups and Drive copies cannot remove your cycle, daily checks, workout types or body targets without an explicit tick.
- Projects can now be deleted (linked outcomes are kept), and archived projects no longer count toward the 200 cap.
- `node test/smoke-health.mjs` runs the Health and project delete flow at desktop and 390x844 sizes.
- Audited: body metrics never go to the AI provider, unit switches keep targets and do not drift, and dates use the local day everywhere. See the v0.5.0 audit in docs/SECURITY.md.

## v0.6.0: Goals

- Goals view: goals on horizons from weekly to 10 years, a ladder of parents and children, progress computed live from your own numbers (net worth, savings rate, spending, weight, body fat, workouts, sleep, daily checks, outcomes, pipeline wins, or a typed value) and an arithmetic pace (ahead, on track, behind). Achieving, dropping and rolling over are always your tap. The weekly review gains a Goals step and the dashboard a Goals tile.
- Vault schema 5, migrated from schema 1 to 4 with no data loss (old goal entries become goals and keep their full history). CSV import now maps workout type, minutes and effort; daily checks hold up to 100,000 ticks.
- `node test/smoke-goals.mjs` runs the Goals flow. Audited: goal titles, notes and body-metric goals never reach the AI provider. See the v0.6.0 audit in docs/SECURITY.md.

## Security model

- All data lives in one AES-GCM encrypted envelope in IndexedDB; the key comes from your passphrase via PBKDF2 (600,000 iterations) and is never stored.
- A strict CSP allows no inline handlers, no eval and no network except an optional AI provider you configure.
- The AI only proposes insights; nothing becomes approved without your explicit tap, and backup restores can re-queue approved insights for review.
- The model sees only a numeric weekly digest plus a few approved insights and lessons, never raw entries or names.
- All imported data (CSV, backups, AI replies) is validated. Details and findings: [docs/SECURITY.md](docs/SECURITY.md).
