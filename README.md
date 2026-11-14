# LifeOS

LifeOS (Living Independent and Free Everyday Operating System) is a single-file, offline, local-first life dashboard. It tracks eleven areas (money, assets, work, health and more), builds weekly reviews, and keeps a memory of insights you approve. Vanilla JS, no dependencies.

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
