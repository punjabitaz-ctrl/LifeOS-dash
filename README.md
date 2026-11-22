# LifeOS

Version <!--version-->1.8.0<!--/version--> (set by package.json; `node build.mjs` writes it here).

LifeOS (Living Independent and Free Everyday Operating System) is a single-file, offline, local-first life dashboard. It tracks eleven areas (money, assets, work, health and more) plus business records and tax estimates, keeps a private vault with its own passphrase (Wellbeing lives there), builds weekly reviews, and keeps a memory of insights you approve. Vanilla JS, no dependencies.

## Open it

Build, then open `dist/lifeos.html` in a browser (double-click works, it needs no server).

## Tests and build

- `node --test test/` runs the unit and security tests.
- `node build.mjs` writes `dist/lifeos.html`.
- `node test/smoke.mjs` runs a headless browser flow at desktop and 390x844 mobile sizes. It needs Playwright (`npm i --no-save playwright`) and Chrome, and skips itself if they are missing.
- `node test/smoke-money.mjs` runs the Money and Assets flow (accounts, quick add, budget, recurring, lock) at desktop and 390x844 sizes.
- `node test/smoke-sync.mjs` runs Google Drive sync against a mocked Drive; `node test/smoke-work.mjs` runs the Work flow (projects, outcomes, pipeline, older backup restore) at desktop and 390x844 sizes.
- `node build.mjs` also writes `_headers` (Cloudflare Pages) with the same CSP plus frame-ancestors.
- `node test/smokes.mjs` (or `npm run smoke`) builds, then runs every browser smoke script (`test/smoke*.mjs`) and the UI review proofs (`test/review-ui.mjs`) one after another.

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

## v0.7.0: Home and Admin

- Home view: maintenance tasks for your home and vehicles (overdue, due in 30 days, cost this year), vehicles with last service and odometer, a one-time seasonal starter checklist you pick from, and household bills taken from Money recurring items you flag (no second list).
- Admin view (new dashboard tile, 11 in all): renewals and subscriptions with monthly and yearly run-rate, a document index of where things are kept (it refuses ID and card numbers), a tax checklist by year, and a 30/60/90 day timeline. Finishing a recurring task or renewal only proposes the next one. The weekly review gains a Home and Admin step.
- Vault schema 6, migrated from schema 1 to 5 with no data loss (old Home due items become renewals with their full text). `node test/smoke-home-admin.mjs` runs the flow. Audited: see the v0.7.0 audit in docs/SECURITY.md.

## Security model

- All data lives in one AES-GCM encrypted envelope in IndexedDB; the key comes from your passphrase via PBKDF2 (600,000 iterations) and is never stored.
- A strict CSP allows no inline handlers, no eval and no network except an optional AI provider you configure.
- The AI only proposes insights; nothing becomes approved without your explicit tap, and backup restores can re-queue approved insights for review.
- The model sees only a numeric weekly digest plus a few approved insights and lessons, never raw entries or names.
- All imported data (CSV, backups, AI replies) is validated. Details and findings: [docs/SECURITY.md](docs/SECURITY.md).

## v0.8.0: Learning

- Learning items (course, book, certification, skill, project, other) with percent or units progress, target dates and pace (the same arithmetic as Goals), study sessions, takeaways with plain substring search, and a weekly study-minutes target with a streak of weeks at target.
- A certification's expiry date shows in the Admin 30/60/90 timeline as a computed row; no renewal is stored. Goals gain study minutes per week, items finished and linked-item progress. The weekly review gains a Learning step with offer-only actions.
- Vault schema 7, migrated from schema 1 to 6 with no data loss (old learning items and whole-minute hours become items and sessions; anything that does not fit stays as a visible, deletable entry). `node test/smoke-learning.mjs` runs the flow.
- A study session note holds up to 200 characters, so Learning at its caps stays under the 64 MB backup and sync limit; a vault that is larger anyway is refused by export and sync with a clear message, never cut. Audited: titles, providers, notes and takeaways never reach the AI provider, the digest or the audit log. See the v0.8.0 audit in docs/SECURITY.md.

## v0.9.0: Activities
- Activities (outing, event, travel, hobby, networking, volunteering, class, other, and your own categories) planned, done or skipped, with optional end date, minutes, place, people, cost, financial return, a 1 to 5 worth-it rating and a linked goal.
- Upcoming: a rolling 30-day window shown as today and this week with the rest one tap away, on the Activities view and a dashboard "At a glance" card built on a provider list so other domains can join later. A dashboard "Add activity" button opens the form.
- Cost is entered once. It reaches Money only when you mark the activity paid or done and tap "Add to Money"; one expense per activity, never automatic, never counted twice. Correcting the cost of an activity already in Money changes that expense in the same save. Unpaid planned cost shows as committed. Tables: cost per activity, cost by category per month, cost per hour, average worth-it rating and return minus cost; "no data" instead of zero.
- An activity tagged Health counts as a workout session and one tagged Social counts as contact with its people, computed and marked "from Activities", with no duplicate entry stored; a same-day manual duplicate gets an offer-only notice. The weekly review gains an Activities step (past-date planned items, ratings, Money offers); Goals gain activities per month, activity spend per month and average worth-it rating.
- Vault schema 8, migrated from schema 1 to 7 with no data loss (old activity sessions become done activities). `node test/smoke-activities.mjs` runs the flow and `node test/smoke-leaks.mjs` checks that no free text from any domain leaves the vault. Audited: titles, places, people, categories and notes never reach the AI provider, the digest, the audit log or an error. See the v0.9.0 audit in docs/SECURITY.md.

## v0.10.0: Social
- Groups with a contact cadence (Family 14, Friends 30 and Professional 60 days are offered as suggestions, added only when tapped), up to 1,000 people with their own cadence, important dates and up to 50 facts each, and a contact log of up to 20,000 entries. Effective cadence is the person's own, else the group's, else the default.
- Views: overdue (most overdue first), due within 7 days, by group with contacts per week for 8 weeks, people search across names and facts, and a person detail with log, dates, facts and Work links. "Reached out today", snooze for 7 days, archive and change cadence are each one tap; nothing happens by itself.
- Last contact is computed from the log and from done, Social-tagged activities that name the person (case, spacing and Unicode form ignored); a name shared by two people counts for neither. An unknown name in an activity can be added as a person on a tap.
- Important dates (label and name only) appear in the dashboard "At a glance" card; Feb 29 shows on Feb 28 in other years. Pipeline items and projects show linked people and their last contact; unlinking never deletes either side.
- The weekly review gains a Social step (offers only); Goals gain people overdue and contacts per week. The AI and digest see counts only, with groups numbered by position.
- Vault schema 9, migrated from schema 1 to 8 with no data loss: each distinct name in old contact entries becomes a person with those entries as the log; an entry that cannot map stays a visible entry. Contact entries added later (for example by CSV import) are offered for conversion, once. `node test/smoke-social.mjs` runs the flow. Audited: names, group names, labels, facts, channels and notes never leave the vault. See the v0.10.0 audit in docs/SECURITY.md.

## v1.8.0: Passphrase recovery
- Optional recovery key for the main vault and a separate one for the private vault (256 random bits, shown once, never stored). Turn on, replace or turn off in Settings and on the private vault screen; "Use recovery key" on each lock screen sets a new passphrase and a new key. See docs/RECOVERY.md.
- Each vault has a random data key wrapped under the passphrase and, when on, the recovery key. Every sealed copy (stored vault, backups, Drive copies, archive files, private boxes) carries the wraps. An older app refuses the new file with its newer-version message.
- Printable recovery sheet (no key unless you tick the box after turning a key on).
- A backup that carries the main recovery key restores on the lock screen with that key (tick the box, then set a new passphrase); the archive Open and Restore dialogs take the main recovery key a file carries.
- The setup checklist prompts for the main key ("Turn on now" or "Later"), creating the private vault prompts for its key, and a Getting started view (checklist and Settings) lists the first-time steps in order. See docs/GETTING-STARTED.md.

## v1.7.0: AYiN and clients, Podcasts, Websites

- Three tabs: AYiN and clients (beside Business; roll-up, clients, invoices per client, contact log and flags), Podcasts (shows, episodes in video, audio and text, guests, numbers typed per platform, cadence) and Websites (domains, hosts, renewals in Admin, monthly traffic typed by hand). Money is in integer cents, measures are never summed together, and a month with nothing typed reads "no data". Any of these records can be private; a show moves with its episodes and numbers. Names, titles, domains, notes and per-client money never reach the AI, the digest, at a glance, the weekly review or the calendar file (counts and generic labels only). Decisions are in SPEC.md, "Amendment (v1.7.0 build)" and "Amendment (v1.7.0 audit)" (each site renewal gets its own numbered generic title, such as "Domain renewal 2"); the audit is in docs/SECURITY.md, "v1.7.0 audit".

## v1.6.0: Job search and search across everything

- Job search tab (Work, or More): applications are the Work pipeline items of kind job, with role, company, location type, compensation target and offer (OTE and base, integer cents, shown only on this screen), source, applied date, resume version label, follow-up date and an outcome reason when lost. Funnel counts and rates ("no data" at a zero denominator), a weekly view, people from Social with a one-tap contact log, follow-ups in the weekly review, at a glance and the calendar file (generic title by default), and a tracker CSV import (map, preview, confirm; nothing created from unknown values). The rate and weekly definitions are in SPEC.md, "Amendment (v1.6.0 audit)".
- Search box in the desktop header and the More sheet over every area: plain case- and accent-insensitive substring matching, an index kept only in memory while unlocked, private and Wellbeing text only while the private vault is open, dropped on lock and on private close.
- The digest gains four numbers only (applications this week, follow-ups due, interviews, offers). Company names, roles, people, notes, resume labels and compensation never leave the vault.
- `node test/smoke-jobs.mjs` runs the flow.
- Audited 19 Nov 2026: SEC-110 to SEC-114 (Low) fixed with regression tests (test/v160-audit.test.mjs and a smoke-jobs step), SEC-115 and SEC-116 (Info) documented, see docs/SECURITY.md "v1.6.0 audit". The unit run peaks at about 3.5 GB with two files at a time; run the three time zones one after another, never together (see docs/HANDOFF.md).

## v1.5.0: Weekly loop

- A "Weekly review due" card on the dashboard after 7 days (and one line after unlock), a review streak, and offers to consolidate the last month or quarter with what would be merged. Nothing starts by itself.
- Rejecting an insight asks for one reason (wrong number, not relevant, already known, too vague, other). The AI may receive counts per reason and area over 12 weeks, never typed text. A kind of rules suggestion rejected 3 times in an area within 8 weeks is muted (listed under Memory, one-tap unmute). Insights can propose a target change inside the Settings ranges; it applies only when you tap Apply.
- Settings: Test connection (a fixed message with no vault data; success or a fixed code) and a calendar file (.ics) of dated items for the next 12 months with generic titles by default; real titles and private items only with their own ticks and warnings. See docs/AI-SETUP.md. Vault schema 17.
- `node test/smoke-loop.mjs` runs the flow.
- Audited 19 Nov 2026: SEC-102 to SEC-108 fixed with regression tests (test/v150-audit.test.mjs and a smoke-loop step), see docs/SECURITY.md "v1.5.0 audit". A vault that has never finished a review now shows the due card once it is 7 days old; docs/AI-SETUP.md no longer claims lessons are sent or that the local file copy works with Ollama.

## v1.4.0: Phone first

- Under 820 px a bottom bar (Home, Money, Work, Health, More); More lists every other area, so each area is two taps away. Back moves between views and closes dialogs; history entries hold only a view name; locking clears them and a reload returns to the lock screen.
- A device with no vault offers three paths on the lock screen: create a vault, restore from a backup file, or use the Google Drive copy. A new vault shows a setup checklist that ticks itself from the vault's real state. Vault schema 16.
- Install the hosted copy as an app (https only; the file copy works as before):
  - iPhone: open the live address in Safari, tap Share, then Add to Home Screen.
  - Android: open the live address in Chrome, open the menu, then Install app (or Add to Home screen).
  - Sign in to Cloudflare Access first; the manifest is fetched with that sign-in. Neither install has been tried on a real phone yet.
  - Updates: a "New version ready" notice with a Reload button appears after a deploy. Reloading locks LifeOS, so it asks first while unlocked; nothing reloads by itself. The service worker keeps only the page, the manifest and the icons; your data never goes in its cache. Details in docs/RUNBOOK.md.
- `node test/smoke-phone.mjs` runs the phone flow, the service worker over a local https server and the accessibility checks. `LIFEOS_SMOKE_BROWSER=webkit` or `firefox` runs the core smokes in those browsers; if the browser is not installed the script prints SKIPPED and the runner lists it as skipped, never as passed.
- Audited 18 Nov 2026: SEC-98 to SEC-101 fixed with regression tests (test/v140-audit.test.mjs), see docs/SECURITY.md "v1.4.0 audit".

## v1.3.0: Safe to live in

- Settings shows whether the browser keeps the storage, the last backup and sync dates, a reminder interval, "Verify a backup file" (read in memory, nothing written) and codes-only diagnostics ("Copy diagnostics" holds codes, version, schema and browser family). A banner offers Export backup after the interval; it never acts by itself. Vault schema 15.
- `package.json` is the one version source; `.github/workflows/tag-release.yml` tags each release. See docs/CHANGELOG.md, docs/RUNBOOK.md and docs/FIRST-RUN.md. `node scripts/check-live.mjs` compares the live headers with `_headers` (token from the environment only).
- `node test/smoke-safety.mjs` runs the flow; `node test/smokes.mjs` now stops any script after 420 s (`--timeout=SECONDS`).
- Audited 18 Nov 2026: SEC-93 to SEC-97 fixed with regression tests (test/v130-audit.test.mjs), see docs/SECURITY.md "v1.3.0 audit". A downloaded Drive copy now keeps this device's backup dates and diagnostics; failed syncs, archive errors and refused CSV files leave a code; the tag workflow is pinned and tags only commits on main with their package.json version; the runbook's rollback steps match what the app allows.

## v1.2.0: Activity CSV import, vault archiving, spell check off

- Activity CSV import (schema 13): map the columns, preview, confirm. Unknown categories, health types and people are listed and offered, never created on their own; importing the same file again adds nothing. Imported rows never create Money expenses; one "Create linked expenses" tap adds one expense per eligible activity. "Import as private" (vault open) keeps the rows in the private vault; rows naming a category or health type not yet in your lists are rejected there, with a reason. Activities CSV export uses the same columns.
- Vault archiving (schema 14): the vault keeps this year and the two before it. Settings, Archive moves the finished records of an older year into one encrypted file (`lifeos-archive-YYYY.json`, main passphrase, private records under the private key), checked by decrypting it back, with a verified Drive copy and/or a download you confirm saving (for example to your NAS). Open items, unpaid invoices, linked money pairs and anything a live record points at stay. Yearly totals stay in the vault (private ones inside the private vault), so every chart, net worth history, goal, revenue figure and budget keeps its numbers. The dashboard and weekly review propose archiving when the vault passes your size setting (20 to 60 MB, default 40) or a new year becomes old enough; nothing moves without your tap. Open an archive read-only (search, accountant export for that year) or restore it; older backups and Drive copies that still hold an archived year need an explicit tick.
- Spell check, auto-correct and auto-capitalise are off on every field except passphrases, so enhanced spell check never sends typed text anywhere.
- `node test/smoke-activity-import.mjs` and `node test/smoke-archive.mjs` run the flows. Audited: see the v1.2.0 audit in docs/SECURITY.md (SEC-84 to SEC-92).

## v1.1.0: Business expenses, invoices and tax (NJ single-member LLC)

- Business screen (tabs: Tax, Entries, Invoices, Mileage, Payees, Budgets, Settings, Export). Money income and expenses are business or personal; existing entries take the scope their line of work implies and you confirm the counts once.
- Invoices with your own number format, aging (current, 1 to 30, 31 to 60, 61 to 90, over 90 days), billable and reimbursable expenses added with one tap, and a print view (print to PDF in the browser). Sent and paid only offer the matching income entry; income counts once, when received.
- Mileage log priced by dated rate periods, the simplified home-office deduction (limited to business income less other expenses), 1099-NEC payee totals (a tax ID is never stored, only whether a W-9 is on file), project budgets with parent rollups.
- Tax-year profile (every rate, threshold, date and holiday is yours to edit): Schedule C summary per line and per line of work, self-employment tax (with the $400 floor and your W-2 wages), federal and NJ estimates from effective rates you enter, set-aside against a reserve account, safe-harbor targets in four installments, a payment log and due dates moved past weekends and holidays.
- Every figure is an estimate. Numbers only, not tax advice. Confirm with your accountant.
- While the private vault is closed and holds a business record of a year, every tax figure for that year refuses ("Open the private vault to see tax figures."). The accountant export leaves private records out unless you tick "Include private records", and refuses rather than produce incomplete totals.
- Vault schema 12, migrated from schema 1 to 11 with no data loss. `node test/smoke-business.mjs` runs the flow. Audited: see "v1.1.0 audit" in docs/SECURITY.md.

## v1.0.0: Final complete review

- Three independent reviews (crypto and sync, privacy and the AI boundary, the UI in Chrome) found 30 issues; all are fixed, with their proof tests kept as regression tests. See "Final complete review (v1.0.0)" in docs/SECURITY.md.
- Typed text is no longer kept in the browser's autofill history: every input, textarea and form says autocomplete off.
- An edit saved while a Drive upload is in progress is no longer marked as synced. A private vault no longer refuses to open after public changes made while it was closed.
- A ledger import waits until the private vault is open when private entries or lines of work exist, so nothing is imported twice.
- The AI never receives the reason you typed when rejecting an insight, only how many insights were rejected in each area. No rules insight states a body metric.
- CSV import rejects a decimal comma instead of reading it 100 times too large; Money CSV export and import keep status, due date and category. Monthly items due on the 31st come back to the 31st.
- "New items are private" applies to add forms and add dialogs only; one-tap actions follow the record they come from.
- The page refuses to run inside a frame. Schema stays 11, so v0.12.0 and v1.0.0 copies open in each other.

## v0.12.0: Command center, first build

- Lines of work: projects gain the kinds Website and Podcast and an optional parent (one level). Money income and expenses, recurring items and revenue goals can be linked to a line.
- Revenue view (Work, Revenue): per line, rollup and Unassigned totals for this month, last month, quarter to date, year to date, trailing 12 months or a custom range, with margin, 12-month table, recurring monthly revenue and expected income (next 30, 60, 90 days, overdue). Expected and written-off income never count in Money, savings rate, budgets or net worth until marked received.
- Ledger CSV import: pick the columns, preview (nothing is written), confirm. Importing the same file again adds nothing. Unknown line names are offered, never created silently.
- Customizable home: reorder (drag or Move up and Move down), hide, resize and reset modules, saved separately for narrow (under 720 px) and wide screens.
- Schema 11, migrated from schema 1 to 10 with no data loss. `node test/smoke-command.mjs` runs the flow.

## v0.11.0: Private vault and Wellbeing
- A private vault inside the app: a second lock with its own passphrase (12 characters or more, different from the main one), its own salt and key (PBKDF2 600,000, AES-GCM 256), stored encrypted inside the main encrypted state. Unlocking the app does not open it. It closes by itself after a set idle time (default 60 seconds, 15 to 1800), when the tab is hidden, when the app locks, on a passphrase change and before any AI request. Wrong passphrases add a growing wait (1 s doubling to 30 s).
- Any record can be moved in or out from its edit dialog, its row's Options, or the Private screen. Moving keeps references working (overlays restored on open), moves an activity and its Money expense together, and offers to take a parent's children along. "New items are private" saves new items straight into the vault while it is open; it resets when the vault closes and a note shows on every add form while it is on. Records made from a private record (a confirmed recurring item, a carried-over outcome, the next maintenance task or renewal, a contact or study session under a private person or item) are private too.
- While closed, private items are missing from every screen, total, chart, search, review, goal and export, and a lock marker ("Some private items are hidden") shows where numbers could be affected, with no counts or names. While open, private rows show a lock badge. Prompts, the digest, rules insights, review records, the audit log and CSV exports always use the main data only, even while open.
- Wellbeing lives only inside the private vault: one check-in per day (mood, mental state, rest and recovery, social engagement, intimacy, each 1 to 5 and skippable, plus a 200-character note), quick or one section at a time, past days editable. The view shows today, 7 and 30 day averages, the previous 7 days, 30-day trend lines and the streak, plus sleep from Health and contacts and social activities read live. Numbers and dates only: no labels, thresholds or advice. Wellbeing never reaches the AI, the digest, prompts, insights, the audit log or a CSV; earlier mood entries can be moved in once as check-ins, and any that cannot move without loss stay where they are with a plain notice and are never sent to the AI.
- Backups and Drive sync carry the private vault unchanged; restore and sync dialogs say whether each copy has one and need an explicit tick before a copy without it replaces one with it. Older app versions refuse schema 10, so they cannot strip it. If you forget the private passphrase, everything in the private vault is lost on every device and in every backup: there is no reset.
- Vault schema 10, migrated from schema 1 to 9 with no data loss. `node test/smoke-priv.mjs` and `node test/smoke-wellbeing.mjs` run the flows; `node test/smoke-leaks.mjs` checks that nothing private leaves the vault. See the v0.11.0 audit in docs/SECURITY.md.
