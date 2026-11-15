# LifeOS handoff

Updated 15 Nov 2026. Read this first in any new session, then SPEC.md and docs/SECURITY.md.

## What it is
LifeOS (Living Independent and Free Everyday Operating System): one offline-capable HTML file, vanilla JS, no dependencies. All data sits in one passphrase-encrypted envelope in the browser's IndexedDB. Optional AI (Anthropic key, local model, or copy/paste into Claude) only ever sees weekly numbers. Owner: Taz Abbas. Proprietary licence (see LICENSE).

## Where things are
- Repo: github.com/punjabitaz-ctrl/LifeOS-dash, branch main, push straight to main.
- Live copy: https://lfs-dsh.punjabitaz.workers.dev/dist/lifeos (Cloudflare Worker with static assets, free tier, behind a Cloudflare Access sign-in that stays on). Deploys on push.
- Source: src/core/*.js (vault, store, priv, wellbeing, csv, metrics, home, admin, learning, activities, social, goals, memory, ai, sync), src/ui/* (shell, styles, app, sync-ui). `node build.mjs` writes dist/lifeos.html and `_headers`.
- Tests: `node --test test/` and `node test/smokes.mjs` (every test/smoke*.mjs plus test/review-ui.mjs) (test/smoke-leaks.mjs, the leak test in test/v090-audit.test.mjs and the Social error test in test/v0100-audit.test.mjs check that no free text from any domain leaves the vault) (Playwright with system Chrome; `npm i --no-save playwright`).
- Spec: SPEC.md, one addendum per version. Audit log: docs/SECURITY.md. Sync setup guide: docs/SYNC-SETUP.md.

## Build state
| Version | Content | State |
|---|---|---|
| 0.1.0 | Ten thin domains, encrypted vault, weekly review memory loop | pushed |
| 0.2.0 | All first-audit findings fixed, CSV mapping, phone-size test | pushed |
| 0.3.0 | Money and Assets deep, Google Drive sync, Cloudflare headers, licence | pushed |
| 0.4.0 | Work: projects, weekly outcomes, pipeline | pushed |
| 0.5.0 | Health: body metrics, workouts, training cycle, sleep, daily checks; project delete | pushed |
| 0.6.0 | Goals: linked metrics, pace, ladder, review step, tile; CSV workout fields; 100,000 tick cap | audited, committed |
| 0.7.0 | Home and Admin, schema 6: Home (properties, vehicles, maintenance, household bills) and Admin (renewals, subscriptions, document index, tax checklist, 30/60/90 timeline); Admin tile | audited (SEC-44 to SEC-48 fixed), committed |
| 0.8.0 | Learning, schema 7: items, study sessions, takeaways, weekly study target, certification expiry in the Admin timeline, three goal metrics, review step, dashboard Log study button; src/core/learning.js | audited (SEC-49 Low and SEC-50 Info fixed), committed |
| 0.9.0 | Activities, schema 8: planned/done/skipped activities, 30-day upcoming and At a glance provider list, cost and ROI tables, paid-while-planned amendment (paidOn), Health and Social computed from activities, review step, three goal metrics; src/core/activities.js | audited (SEC-51 to SEC-53 Low, SEC-54 Info fixed; SEC-55, SEC-56 Info documented), committed |
| 0.10.0 | Social, schema 9: groups, people, contact log, important dates (at a glance), facts, Work links (pipeline items and projects), review step, two goal metrics, snooze; src/core/social.js | audited (SEC-57 Medium, SEC-58 to SEC-60 Low, SEC-61 Info fixed), committed |
| 0.11.0 | Private vault and Wellbeing, schema 10: a second lock with its own passphrase inside the encrypted state (src/core/priv.js), moves of any record, lock markers and badges, "New items are private"; Wellbeing check-ins only inside it (src/core/wellbeing.js), kept away from the AI | audited (SEC-62 and SEC-66 Medium, SEC-63 to SEC-65 and SEC-67 to SEC-69 Low, SEC-70 Info fixed), not committed |
| 0.12.0 | Command center, first build, schema 11: lines of work (kinds, parents), revenue tracker and expected income (src/core/revenue.js), ledger CSV import, customizable home (src/core/layout.js); reviewed in the final complete review, released as 1.0.0 |
| 1.0.0 | Final complete review: three independent reviewers (crypto, privacy, UI), 30 findings (CR-1 to CR-10, PV-1 to PV-10, UI-1 to UI-10) all fixed with regression tests; schema stays 11 | tests and smokes pass, not committed |

Schema: 11 as of v0.12.0 and v1.0.0 (10 at v0.11.0). Every schema change needs a tested migration and the downgrade guards (SEC-27/28) extended to the new collections.

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
0. Confirm two owner-rule fixes from the final review: rejection reasons never go to the AI (only counts per area, PV-6), and the weight rules insight is removed (PV-9). Optional: decide whether to turn off spell check in text fields (Chrome's enhanced spell check sends typed text to Google when the user has turned it on).
1. Sign in to the live copy, open Settings, confirm the version matches the latest push.
2. First real run on phone and PC: create a vault, enter a week of data, export a backup.
3. At the end of the build: follow docs/SYNC-SETUP.md. Because Cloudflare Access is on, confirm the Google redirect back to the site still lands after sign-in, and add the exact live origin as the authorised origin and redirect URI.
4. Decide whether the repo should go private to match the licence.
5. Have a lawyer review LICENSE before charging anyone.

## Roadmap
Done: Goals (0.6.0), Home and Admin (0.7.0), Learning (0.8.0), Activities (0.9.0), Social (0.10.0), private vault and Wellbeing (0.11.0), command center first build (0.12.0), final complete review (1.0.0).
1. Recommended first: a real run on phone and PC (owner's to-do 2); nothing has run on a real device yet.
2. Activity CSV import.
3. Vault archiving (with several domains at their caps the vault passes 64 MB; export and sync refuse rather than cut).
4. NAS sync to replace Google Drive.
5. Command center tabs: job search, websites, podcasts, AYiN Advisors and client projects.
6. Possible later: custom domain.

## Open items
- SEC-30 (Info, accepted): carry-over list has no limit.
- Passphrase change on one device: the other device needs the old passphrase once to read the Drive copy.
- Local model (Ollama) may be unreachable from the hosted HTTPS copy in some browsers; untested.

## Current step
v1.0.0 final complete review is done (see "Final complete review (v1.0.0)" in docs/SECURITY.md and the three reports in docs/review/). All 30 findings are fixed in source: High CR-1, PV-1, UI-1; Medium CR-2, PV-2, PV-3, PV-6; Low and Info the rest. The reviewers' proof tests pass and stay as regression tests, plus test/v100-review.test.mjs and test/smoke-v100.mjs. `node --test test/` passes 496 of 496 in the default zone, New York and Auckland; `node test/smokes.mjs` (16 scripts) passed twice. Version 1.0.0 in package.json and the app. Not committed or pushed. Next: the orchestrator re-runs tests and smokes, commits and pushes v0.11.0, v0.12.0 and v1.0.0, then the owner's real-device run. A forgotten private passphrase destroys the private data everywhere; say so to the owner before first use.
