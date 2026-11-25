# LifeOS changelog

Newest first. One line per change. Versions come from package.json (see docs/RUNBOOK.md); fixes by number are described in docs/SECURITY.md.

## Unreleased

### Navigation fixes after the final review (25 Nov 2026)
- Phone: the bottom bar stays on screen. The progress bar rule (`.bar`, 8px tall) also matched the bottom bar (`nav.nav.bar`), so its buttons sat below the screen; the rule now targets `svg.bar` only.
- Wide screens: the tabs now include By country, Job search, Learning, Goals, Admin and Podcasts, which could only be reached by search or shortcuts, and a More button lists every other area. The tabs wrap to a second row instead of scrolling sideways out of sight. The phone keeps its bar of Overview, Money, Work and Health plus More.
- Tour: the "Key numbers" and "Getting around" steps describe what is on screen. No schema change, no version bump. Tests: test/v240-nav.test.mjs.

### First-run tour (getting started guide)
- A 16-step tour starts once per vault on the first Overview and walks the real screens: Overview, key numbers, shortcuts, choose what shows, getting around, Money, Assets, By country, Health and eating, Learning, Admin and taxes, weekly review, Settings, Drive sync. Back, Next, Skip tour, Escape; locking ends it.
- Rerun it any time from Settings, Getting started, "Rerun getting started guide". One optional vault flag (`settings.setup.tour`), no schema change, no records read, no network call. Details in docs/TOUR.md. Tests: test/tour.test.mjs, test/smoke-tour.mjs.

### Shared design language v1.1 (same look as Resume Engine and ChannelVu)
- New look from tazabbas.com and ayinadvisors.com (docs/DESIGN.md): a navy top bar with a gold ring mark and a serif wordmark, a warm white page with a faint gold wash, white cards, serif page titles (Cormorant Garamond), Hanken Grotesk for everything else, gold main buttons with navy text, blue for links, focus and selection, green for good news, a colour per area on the key numbers, and a gold underline on the current tab. The indigo gradient is gone.
- Theme switch in the top bar: Auto (follows the device), Light, Dark; one button that steps through them on phones. The choice is kept on the device under one key (`lifeos-theme`), outside the vault, because it holds no personal data and the lock screen should open in the same theme.
- The Overview opens on a navy welcome band with the title, the date and the quick actions.
- The two typefaces are built into the page (SIL OFL, src/fonts); the CSP adds `font-src data:` only. The browser bar colour and the app icons turn navy.
- No feature, screen, data field or schema changed. Tests: test/design.test.mjs; existing CSP directive lists gain font-src, and the dark-token test reads the switch-aware selector.

## 2.4.0 (schema 24): Taxes and assets by country
- New "By country" screen (under More, and a button on Assets): chips for All countries, United States and Spain, and a tax year picker. All countries shows assets, amounts owed and net worth per country, and paid, owed, refunds, checklist and residency per country for the year. One country shows its accounts, its tax-year details, its tax amounts and its checklist count.
- Every account now has a country and a currency, set when it is added and changed with Edit (it was Rename). A balance is entered and shown in the account's own currency. Tax checklist items in Admin get a country.
- Money in another currency is never added to dollars without a rate the owner types (one unit in the vault currency, with its date). Until then the Assets totals leave that account out and say so, and By country shows each currency side by side with "No combined total yet". LifeOS never looks rates up.
- Tax amounts per country and year (tax paid, tax owed, refund; title, amount, currency, date, notes) and a tax-year profile per country (residency as the owner states it, days in the country, filing date, a note). These are the owner's own numbers: there are no Spanish tax rules or rates. The US estimated payments already logged under Business show under the United States.
- More countries can be added (two-letter code, name, currency) and removed when nothing uses them; the home country stays. Tax IDs and ID numbers (SSN, EIN, Spanish NIE and DNI) are refused in every new text field. Search finds country tax amounts and notes. Tax amounts and tax years can be moved to the private vault.
- Schema 24 with migrations from 1: every existing account and tax item becomes United States and USD, which is how they were read before, so nothing changes until the owner adds something in another country. Downgrade guards name account countries and currencies, country tax records and profiles, checklist countries, exchange rates and the country list. Decisions in SPEC.md "v2.4.0 addendum: Taxes and assets by country". Tests: test/v240.test.mjs, test/v240-render.test.mjs.
- Existing tests: schema numbers 23 to 24, "newer schema" fixtures 24 to 25, version strings 2.3.0 to 2.4.0, the `[1..22, SCHEMA]` patterns, settings keys (adds `countries`, `fx`), build order, the private vault fixtures and move-control map, the search fixture (now schema 24, with a By country area).

## 2.3.0 (schema 23): Overview and a brighter look
- The Dashboard becomes the Overview, one screen for everything: a Key numbers card (up to 12 numbers the owner picks from 16, such as savings rate, net worth, revenue this month, net this month, expected income, workouts, learning, goals, applications this week, the next 30 days and the review streak) and a Shortcuts card (up to 12 areas, one tap each) sit above the existing cards. A tap on a number opens its area. Wellbeing has no key number; it stays in the private vault.
- "Choose what shows" opens one dialog for the key numbers (tick, untick, move up and down), the cards on this screen width (show or hide) and the shortcuts, with "Back to the defaults". Nothing is saved until Save. "Customize" is now "Arrange" (order and size, unchanged).
- The bottom bar and the top bar call the screen Overview (it was Home, easily confused with Home and property); "Back to dashboard" buttons read "Back to overview".
- New look: bright, modern SaaS style. Indigo accent with a soft gradient brand mark, a light blue-grey page, white cards with soft layered shadows and larger radius, pill navigation, tinted key number cards, hover lift on tiles, clearer buttons and inputs, a frosted sticky header. Dark mode follows the system with the same structure. No feature was removed and no screen changed its layout beyond the Overview.
- Schema 23 (`settings.overview` = custom flag, key number ids, shortcut keys; ids whitelisted, 12 each at most) with migrations from 1 and a downgrade guard ("Overview choices"). A layout saved before schema 23 gets Key numbers and Shortcuts at the top, where a new vault has them. The digest and the AI boundary are unchanged. Decisions in SPEC.md "v2.3.0 addendum: Overview and visual refresh". Tests: test/v230.test.mjs and test/smoke-overview.mjs.
- Existing tests: schema numbers 22 to 23, "newer schema" fixtures 23 to 24, version strings 2.2.0 to 2.3.0, the `[1..22, SCHEMA]` patterns, 21 to 23 dashboard modules, nav('Home') to nav('Overview') in the smokes.

## 2.2.0 (schema 22): Learning goals
- Learning gains two kinds, Degree and Language, beside Certification, Skill, Course, Book, Project and Other. Certifications, degrees and languages offer an exam date; only certifications an expiry date. Edit can change an item's kind and provider.
- Each item can carry a next step (up to 200 characters) with an optional date, set from a "Next step" button, and its own minutes per week; each active row shows this week's minutes on it.
- "Due in the next 30 days" card on the Learning screen: target dates and next steps of active and planned items, overdue first. Kind filter chips on the active list when more than one kind is active.
- The Learning tile sub line adds overdue and due counts only when there are some. The weekly review lists the same dates. At a glance gains a Learning provider (target dates, next steps and exams within 30 days).
- Schema 22 (degree and language kinds; `nextAction`, `nextDate`, `weeklyMinutes` on learning items) with migrations from 1 and downgrade guards. The digest and the AI boundary are unchanged. Decisions in SPEC.md "v2.2.0 addendum: Learning goals". Tests: test/v220.test.mjs and a new step in test/smoke-learning.mjs.
- Existing tests: schema numbers 21 to 22, "newer schema" fixtures 22 to 23, version strings 2.1.0 to 2.2.0, the `[1..21, SCHEMA]` patterns.

## 2.1.0 (schema 21): Eating in Health
- Health gains an Eating card: saved meals (fixed portions with one protein number, up to 50, grouped by breakfast, lunch, dinner, snack and any time), one tap logs a meal for the chosen day and copies its protein, a one-off meal by protein only, an optional "Ate for health?" yes or no per meal, and the day's protein against an optional target the owner sets (never suggested).
- "Eating this week": average protein per logged day, days at or over the target, meals logged and the ate-for-health share; a week with nothing logged reads "no data". Search finds saved meal names.
- Saved meals and logged meals can move to the private vault (a meal moves with its logged rows). Meal names never leave the vault; the weekly digest gains four numbers (meals, average protein, days at target, ate-for-health share) and they are not sent to any AI provider.
- Weekly review, Job search follow-ups: a follow-up due later this week is no longer labelled "(overdue)"; only a date before today is (`jobs.reviewWeek`).
- Weekly review, "This week vs last week": amounts as currency, rates with "%", counts with grouped digits and their unit (singular for one), and each change signed (a change in a rate is in points). `metrics.fmtDigest`.
- Podcasts: the platform chip buttons read "Rename" and "Remove", and the release chip button "Remove", instead of "r" and "x".
- Schema 21 (meals, mealLog, settings.food) with migrations from 1 and downgrade guards. Decisions in SPEC.md "v2.1.0 addendum: Eating". Tests: test/v210.test.mjs.
- Existing tests: schema numbers 20 to 21, "newer schema" fixtures 21 to 22, version strings 2.0.0 to 2.1.0.
- Security: audit SEC-140 (a logged meal can no longer seem to leave the private vault while its meal stays private) and SEC-141 (the picked Eating day resets on lock); full review SEC-142 (the home host names are frozen after load). Tests: test/v210-audit.test.mjs.

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
