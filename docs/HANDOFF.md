# LifeOS handoff

Updated 13 Nov 2026. Read this first in any new session, then SPEC.md and docs/SECURITY.md.

## What it is
LifeOS (Living Independent and Free Everyday Operating System): one offline-capable HTML file, vanilla JS, no dependencies. All data sits in one passphrase-encrypted envelope in the browser's IndexedDB. Optional AI (Anthropic key, local model, or copy/paste into Claude) only ever sees weekly numbers. Owner: Taz Abbas. Proprietary licence (see LICENSE).

## Where things are
- Repo: github.com/punjabitaz-ctrl/LifeOS-dash, branch main, push straight to main.
- Live copy: https://lfs-dsh.punjabitaz.workers.dev/dist/lifeos (Cloudflare Worker with static assets, free tier, behind a Cloudflare Access sign-in that stays on). Deploys on push.
- Source: src/core/*.js (vault, store, csv, metrics, memory, ai, sync), src/ui/* (shell, styles, app, sync-ui). `node build.mjs` writes dist/lifeos.html and `_headers`.
- Tests: `node --test test/` and test/smoke*.mjs (Playwright with system Chrome; `npm i --no-save playwright`).
- Spec: SPEC.md, one addendum per version. Audit log: docs/SECURITY.md. Sync setup guide: docs/SYNC-SETUP.md.

## Build state
| Version | Content | State |
|---|---|---|
| 0.1.0 | Ten thin domains, encrypted vault, weekly review memory loop | pushed |
| 0.2.0 | All first-audit findings fixed, CSV mapping, phone-size test | pushed |
| 0.3.0 | Money and Assets deep, Google Drive sync, Cloudflare headers, licence | pushed |
| 0.4.0 | Work: projects, weekly outcomes, pipeline | pushed |
| 0.5.0 | Health: body metrics, workouts, training cycle, sleep, daily checks; project delete | pushed |
| 0.6.0 | Goals: linked metrics, pace, ladder, review step, tile; CSV workout fields; 100,000 tick cap | audited, not yet committed |

Schema: 5 as of v0.6.0. Every schema change needs a tested migration and the downgrade guards (SEC-27/28) extended to the new collections.

## How each build cycle runs
1. Owner picks the next domain and answers scope questions.
2. Orchestrator appends a short addendum to SPEC.md (keep it the contract).
3. One Sonnet worker builds core and UI with tests and a smoke test. Use two workers only when file ownership is cleanly separable.
4. One Opus auditor who did not write the code audits the diff, fixes Critical to Low findings with a regression test each, appends to docs/SECURITY.md.
5. Orchestrator re-runs all tests and smokes itself, checks banned patterns, commits, pushes, sends the built file.
6. Update this file and the owner's memory before starting the next step.
Haiku is used for short, capped research only. Keep prompts lean and cap reply lengths.

## Standing rules from the owner
- Every audit finding is fixed, not accepted, unless it needs a product decision; then ask.
- The AI never has the final say. Insights are proposed; only a user tap approves.
- Nothing auto-posts (recurring items, carry-over): offer, then confirm.
- No em dashes in UI copy. No health advice in the app; numbers only.
- Bring-your-own AI; nothing hard-coded. Token lean.
- Manual entry is the primary input. Phone and PC both matter.
- Ask clarifying questions at every step.

## Never yet run for real
- Google sign-in and Drive (all tests simulate Google).
- A physical phone (tests use desktop Chrome at 390x844).
- A real AI call (simulated providers only).
- The live site's response headers (the Access gate blocks outside checks; `_headers` on a Worker is unconfirmed).

## Owner's to-do
1. Sign in to the live copy, open Settings, confirm the version matches the latest push.
2. First real run on phone and PC: create a vault, enter a week of data, export a backup.
3. At the end of the build: follow docs/SYNC-SETUP.md. Because Cloudflare Access is on, confirm the Google redirect back to the site still lands after sign-in, and add the exact live origin as the authorised origin and redirect URI.
4. Decide whether the repo should go private to match the licence.
5. Have a lawyer review LICENSE before charging anyone.

## Roadmap
1. Goals deep (done in v0.6.0).
2. Home deep (next).
3. Admin deep (Home/Admin is one thin domain today; splitting it needs a migration).
4. Still thin after that: Activities, Social, Learning, Wellbeing.
5. NAS sync to replace Google Drive once the NAS is rebuilt.
6. Possible later: independent re-audit of the whole codebase, real-device test pass, custom domain.

## Open items
- SEC-30 (Info, accepted): carry-over list has no limit.
- Passphrase change on one device: the other device needs the old passphrase once to read the Drive copy.
- Local model (Ollama) may be unreachable from the hosted HTTPS copy in some browsers; untested.

## Current step
v0.6.0 Goals is audited (SEC-40 to SEC-43 fixed, SEC-37 to SEC-39 closed); the orchestrator re-runs tests and smokes, commits and pushes. Next is Home (deep).
