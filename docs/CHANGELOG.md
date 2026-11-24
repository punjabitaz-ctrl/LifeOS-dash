# LifeOS changelog

Newest first. One line per change. Versions come from package.json (see docs/RUNBOOK.md); fixes by number are described in docs/SECURITY.md.

## Unreleased
- Weekly review, Job search follow-ups: a follow-up due later this week is no longer labelled "(overdue)"; only a date before today is (`jobs.reviewWeek`).
- Weekly review, "This week vs last week": amounts as currency, rates with "%", counts with grouped digits and their unit, and each change signed (a change in a rate is in points). `metrics.fmtDigest`.
- Podcasts: the platform chip buttons read "Rename" and "Remove" instead of "r" and "x".

## 2.0.0 (schema 20): NAS sync and home model hosts
- config/hosts.json (app, sync, ai-nas, ai-pc) is read by build.mjs into connect-src: exactly the three home https origins are added, nothing user-entered.
- server/: the NAS sync service (Node built-ins only). Ciphertext-only storage, compare-and-swap puts with atomic writes, the last 30 versions with list and restore, archive files, hashed per-device bearer tokens (add, register, revoke), CORS only for the configured app origins, rate limits, logs with codes and sizes only. Dockerfile, compose file, Caddyfile example, docs/NAS-SETUP.md.
- App: the NAS is the primary sync target and Drive the second copy (Sync now writes the NAS, then Drive; status for both; same conflict dialog and rules; manual only). Device tokens are made in Settings and kept only inside the encrypted vault. Archive copies can go to the NAS and count as verified when read back and decrypted. "Connect Tailscale and try again" when a home host cannot be reached.
- AI: providers "NAS model" and "PC model" beside Anthropic, local, manual and none, an optional fallback, Test connection for each; the numbers-only boundary is unchanged. docs/AI-SETUP.md covers Ollama behind Caddy.
- Schema 20 (settings.nas, settings.aiHosts), migrations from 1 and downgrade guards. Decisions in SPEC.md "Amendment (v2.0.0 build)". Tests: server/test/, test/v200.test.mjs, test/v200-hosts.test.mjs, test/v200-ai.test.mjs, test/smoke-nas.mjs, test/smoke-nas-service.mjs.
- Existing tests: schema numbers 19 to 20 and "newer schema" fixtures 20 to 21, one connect-src pattern, and the v1.8.0 older-app emulation (see the build notes in docs/HANDOFF.md).

## 1.8.0 (schema 19): Passphrase recovery
- Envelope v2: each vault (main and private) has a random 256-bit data key, kept only wrapped under the passphrase and, when turned on, a recovery key. v1 files still open and are rewritten as v2 on the next save. An older app opens a v2 file with the passphrase, reads a stub that says "schema 20" and refuses it with its newer-version message.
- Optional recovery keys, separate for the main and the private vault: 256 random bits as grouped base32 with a checksum, shown once, retyped to confirm, never stored. Turn on, replace, turn off and a passphrase change replace the data key. "Use recovery key" on the lock screen and the private unlock sets a new passphrase and a new key. Wrong keys share the unlock attempt delays.
- Backups and archive files carry the recovery wrap when a key is on (the key is typed at export and checked, never stored). Drive copies carry the wraps as stored.
- Recovery sheet (in-app print view, no key by default) and docs/RECOVERY.md.
- First run: the setup checklist prompts for the main recovery key (Turn on now, Later; it stays on the checklist until done or dismissed), creating the private vault prompts for its key, and a "Getting started" view (setup checklist and Settings) with docs/GETTING-STARTED.md lists the first-time steps in order.
- No schema change. Decisions in SPEC.md "Amendment (v1.8.0 build)". Tests: test/v180.test.mjs and test/smoke-recovery.mjs.

## 1.7.0 (schema 19): AYiN and clients, Podcasts, Websites
- AYiN and clients tab (beside Business): a roll-up of the business lines (revenue this month, quarter and year, open and overdue invoices, budget against spending), and clients with status, line of work, budget, people from Social, invoices linked to a client, a one-tap contact log, and two flags (an overdue invoice, no contact for N days, default 30, set in Settings).
- Podcasts tab: shows with their own platform list (YouTube, Spotify, Apple Podcasts, YouTube Podcasts and Website offered), episodes in video, audio and text with a release date per format and platform, guests from Social (an Episodes card on the person), numbers typed per platform, monthly platform tables (a month with nothing typed shows "no data"; measures are never added together), release cadence, and the show's money from its line of work.
- Websites tab: sites with domain, host, purpose, linked show and line of work, domain and hosting renewals created in Admin with generic titles, and monthly traffic typed by hand.
- Private vault: clients, shows, episodes, platform numbers, sites and traffic can be private; a show moves with its episodes and numbers, a site with its traffic. Search, at a glance, the weekly review and the calendar file carry generic labels and counts only. The digest gains three numbers (clients with an overdue invoice, episodes this month, sites renewing).
- Schema 19 with migrations from 1 to 18 and downgrade guards. Decisions recorded in SPEC.md "Amendment (v1.7.0 build)". Tests: test/v170.test.mjs and test/smoke-media.mjs.

## 1.6.0 (schema 18): Job search and search across everything
- Job search tab (Work, or More): applications are the Work pipeline items of kind job, with role, company, location type, compensation target and offer (OTE and base, integer cents), source, applied date, resume version label, follow-up date and an outcome reason when lost. Board on desktop, stage list on phones, one-tap stage moves, funnel counts and rates ("no data" at a zero denominator), a weekly view, people from Social linked to an application with a one-tap contact log, follow-ups in the weekly review, at a glance and the calendar file (generic title by default), and a tracker CSV import (map, preview, no duplicates, unknown values offered).
- The digest gains four numbers (applications this week, follow-ups due, interviews, offers). Company names, roles, people, notes and compensation never leave the vault.
- Search box in the More sheet and the desktop header over every area; the index is built in memory on unlock, includes private and Wellbeing text only while the private vault is open, and is dropped on lock and on private close. Never stored, never sent.
- Test fix: smoke-home-admin waited on a notice whose text did not change between adds.

## 1.5.0 (schema 17): Weekly loop
- Weekly review due card on the dashboard after 7 days (a one-line notice after unlock), a review streak, and offers to consolidate the last month or quarter with what would be merged. Nothing starts by itself.
- Rejecting an insight asks for one fixed reason (wrong number, not relevant, already known, too vague, other). Counts per reason and area over 12 weeks may reach the AI; typed notes never do. A kind of rules suggestion rejected 3 times in the same area within 8 weeks is muted, listed under Memory with one-tap unmute.
- Insights may propose a numeric target change inside the Settings ranges; approving shows before and after and applies it only on the Apply tap.
- Settings: Test connection (fixed message, no vault data, coded errors) and a calendar file (.ics) of dated items in the next 12 months, generic titles by default. docs/AI-SETUP.md.

## 1.4.0 (schema 16): Phone first
- Phone navigation: a bottom bar (Home, Money, Work, Health, More) under 820 px and a More sheet that lists every other area, so each area is two taps away. In-app history holds only a view name; back moves between views and closes dialogs; locking clears the history and a reload returns to the lock screen.
- Install as an app: manifest, PNG icons drawn in the repo and one service worker (https only) that keeps only the app shell for offline use and shows a reload prompt for a new version.
- Lock screen paths for a new device: create a vault, restore from a backup file, or use the Google Drive copy. Setup checklist on the dashboard (state-driven, dismissible; schema 16 stores the dismissal).
- Dashboard defaults on narrow screens: empty modules are one line; business and tax modules start hidden until a tax profile exists. A saved layout wins.
- Accessibility checks and 44 px targets for small buttons on narrow screens; browser smokes for WebKit and Firefox are ready.

## 1.3.0 (schema 15): Safe to live in
- Storage: asks the browser to keep the vault on each unlock until granted, records the result, and shows "kept by the browser" or "may be cleared by the browser" with the storage in use. A missing or refusing API never blocks the app.
- Backups: last backup and last sync dates are kept inside the encrypted state and shown on the dashboard and in Settings; a non-blocking banner offers Export backup after the chosen number of days (default 7, 1 to 60) or more than 200 saves, with Snooze one day. Never automatic.
- Verify a backup file: decrypts in memory, shows schema, revision, date and per-collection counts against the vault, writes nothing.
- Optional "Remind me to sync" notice on lock and when the tab is hidden, only when changes are not on Drive. Never a sync.
- Diagnostics: a ring of the last 200 fixed codes inside the encrypted state; uncaught errors and unhandled rejections map to a code by area and never keep message text, stack, values, ids or names. Copy diagnostics and Clear diagnostics in Settings.
- Release engineering: package.json is the one version source (injected into the app and README, checked in HANDOFF, enforced by a test); tag workflow; this changelog; docs/RUNBOOK.md; per-script smoke timeout.
- scripts/check-live.mjs (live header check with an Access service token from the environment) and docs/FIRST-RUN.md.
- Fixed: test/smoke-command.mjs waited 15 s nine times per screen size for a selector that never matched (about 287 s in all); it now takes well under a minute.
- Docs: Cloudflare Access section in docs/SYNC-SETUP.md.

## 1.2.0 (schema 14)
- Vault archiving: one verified, encrypted file per archivable year, yearly summaries keep every figure, archive screen, restore by year (SEC-84 to SEC-92).
- Activity CSV import (schema 13): map, preview, confirm, import as private, batch Money offer.
- Spell check, auto-correct and auto-capitalize are off on every field except passphrases.
- Audit fixes SEC-84 to SEC-92.

## 1.1.0 (schema 12)
- Business expenses, invoices and aging, mileage with dated rates, home office, 1099-NEC payees, project budgets, NJ single-member LLC tax profile, self-employment tax, federal and NJ estimates, safe harbor, accountant export and print views, five home modules.
- Audit fixes SEC-71 to SEC-83.

## 1.0.0 (schema 11)
- Command center: lines of work, revenue tracker, expected income, ledger CSV import, customizable home.
- Final complete review by three independent reviewers; 30 findings fixed (CR-1 to CR-10, PV-1 to PV-10, UI-1 to UI-10).

## 0.11.0 (schema 10)
- Private vault with its own passphrase inside the encrypted state; Wellbeing check-ins only inside it.
- Audit fixes SEC-62 to SEC-70.

## 0.10.0 (schema 9)
- Social: groups, people, contact log, important dates, facts, links to Work. Audit fixes SEC-57 to SEC-61.

## 0.9.0 (schema 8)
- Activities: planned, done and skipped, cost and ROI, provider list, whole-app leak check. Audit fixes SEC-51 to SEC-54.

## 0.8.0 (schema 7)
- Learning: items, study sessions, takeaways, weekly study target, certification expiry in the Admin timeline. Audit fixes SEC-49 and SEC-50.

## 0.7.0 (schema 6)
- Home (properties, vehicles, maintenance, household bills) and Admin (renewals, subscriptions, document index, tax checklist, 30/60/90 timeline). Audit fixes SEC-44 to SEC-48.

## 0.6.0 (schema 5)
- Goals with linked metrics, horizons and a ladder; CSV workout fields. Audit fixes SEC-40 to SEC-43.

## 0.5.0 (schema 4)
- Health: body metrics, workouts, training cycle, sleep, daily checks; project delete. Audit fixes SEC-32 to SEC-36.

## 0.4.0 (schema 3)
- Work: projects, weekly outcomes, pipeline. Audit fixes SEC-27 to SEC-29.

## 0.3.0 (schema 2)
- Money and Assets in depth, Google Drive sync, Cloudflare headers, proprietary licence.

## 0.2.0
- All first-audit findings fixed, CSV column mapping, phone-size smoke test. Pages entry point added.

## 0.1.0 (schema 1)
- Ten thin domains, encrypted vault, weekly review memory loop.
