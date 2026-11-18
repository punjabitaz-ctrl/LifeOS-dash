# LifeOS product and operations review

Reviewer: product manager and site-reliability reviewer, first look. Date: 17 Nov 2026 (UTC). Tree reviewed: working tree at v1.2.0-a (part B, vault archiving, being edited by another engineer) and committed HEAD 6a8309e (v1.1.0). No existing file was changed; builds and runs used copies in /tmp.

Labels: **[V]** verified in code or by running it; **[D]** taken from repo docs, not re-proved; **[U]** could not verify; **[O]** opinion.

## 1. Inventory: asked vs built

| # | Requirement (owner) | Status | What exists | What is missing |
|---|---|---|---|---|
| R1 | One pane of glass for every part of an operating adult life | Partly met | 11 dashboard tiles (money, assets, work, health, activities, social, learning, home, admin, goals, wellbeing) plus Business, Revenue, Private, Review, Memory, Settings [V, tour] | Command center tabs (R14); no cross-domain search [V: only Learning, Social and Private have search fields]; no reminders outside the open app |
| R2 | Built iteratively by a team (orchestrator, Opus managers and auditors, Sonnet workers, Haiku researchers) | Met | Build cycle in docs/HANDOFF.md, one SPEC addendum and one audit per version [D] | v1.2.0-a not yet audited [D] |
| R3 | Memory system with recursive and continual learning | Partly met | Levels 1 (weekly), 2 (month), 3 (quarter) in src/core/memory.js; level 2 and 3 consolidate approved lower-level insights [V] | Consolidation runs only from two buttons on the Memory screen, never prompted [V]; since v1.0.0 (PV-6) rejection reasons stay on the device and the prompt gets only rejected counts per area [V, memory.js line 137], so the loop no longer learns why; approved insights do not change targets, rules or the review; no link to the owner's Claude memory |
| R4 | Fully self-contained; runs on Claude, an API key or local models | Partly met | Providers none, manual copy and paste (for Claude), Anthropic API (default model claude-haiku-4-5), local OpenAI-compatible [V, ai.js] | Local model limited to http://localhost or 127.0.0.1 by validation and CSP [V], so a model on the NAS or another LAN box cannot be used; no real AI call ever made [D]; localhost from the hosted HTTPS copy untested [D] |
| R5 | Fully secure, every build audited | Met to v1.1.0 | SEC-01 to SEC-83, CR, PV and UI findings fixed with regression tests [D]; strict hash CSP, no network except AI and Drive [V, build.mjs] | v1.2.0-a and part B audit pending; live response headers never checked (Access blocks outside checks) [D] |
| R6 | Token lean | Met | Numeric digest, max 8 approved insights, max_tokens 600 [V, ai.js, memory.js] | None |
| R7 | Usable on phone and PC | Partly met | Responsive layout, bottom nav under 820 px, all smokes at 390x844 [V] | Never run on a real phone [D]; no PWA (R16); back button leaves the app [V]; 7 of 14 areas only reachable from dashboard tiles [V]; see section 3 |
| R8 | Manual entry first | Met | Forms on every screen, Quick add dialog, CSV imports optional [V] | None |
| R9 | Nothing auto-posts; the AI never has the final say | Met | Hard rule 5; offers with confirm for recurring, carry-over, invoices, activity costs [D, SPEC]; rules and AI only create `proposed` [V, memory.js] | None found |
| R10 | Google Drive sync now | Partly met | Manual sync to Drive app-data folder, conflict dialogs, downgrade guards [V, sync.js, sync-ui.js] | Never run against real Google [D]; 13-step setup; token about 1 hour, memory only; reconnect each session [D, SYNC-SETUP] |
| R11 | NAS sync after the NAS rebuild | Not met | Roadmap item 4 [D] | All; needs a reachable HTTPS endpoint and a CSP change [V: connect-src lists only Anthropic, googleapis, localhost] |
| R12 | Cloudflare security and CDN, free tier | Partly met | Live on a Worker behind Cloudflare Access [D]; `_headers` generated [V] | No Worker or deploy config in the repo [V: no wrangler file, no CI], so deploy settings live only in the dashboard [U]; whether a Worker honours `_headers` is unconfirmed [D] |
| R13 | Proprietary licence, others would pay | Met (draft) | LICENSE: all rights reserved, paid written licence for others [V] | Lawyer review and repo-private decision are open owner to-dos [D]; no licence key or second-user mode (not needed yet) [O] |
| R14 | Command center tabs: job search, websites, podcasts, AYiN Advisors, clients | Not met (first build only) | Lines of work with kinds website and podcast, one-level parents, revenue tracker, expected income, invoices and tax for the LLC [V] | Every tab. Job pipeline exists only as Work pipeline items (job, deal, partner) [D] |
| R15 | AYiN Advisors single-member LLC support | Met (pending owner setup) | Business screen: invoices, mileage, 1099 payees, Schedule C summary, SE tax, federal and NJ estimates [V, tour] | Owner tax profile not entered; every 2026 default unverified against sources [D] |
| R16 | Offline use | Partly met | file:// copy runs with no server [D, README] | Hosted copy has no service worker or manifest [V], so on a phone it needs the network and an Access session on every load |

## 2. Operational readiness

| Area | Finding | Evidence | Rating |
|---|---|---|---|
| Deploy | Push to main deploys the Worker [D]. dist/lifeos.html and dist/_headers are committed [V: git ls-files], so what is live is whatever was built locally and committed. No CI, no wrangler config, no build check on the server [V]. | HANDOFF, repo | Weak |
| Rollback | Revert and push works for code. Across a schema bump it does not: older apps refuse newer schema vaults by design [D, README], so rolling back v1.2.0 (schema 13 or 14) locks the owner out of current data until he rolls forward or restores an older backup and loses newer entries. No rollback runbook. | README, SPEC | Gap |
| Versioning | Version lives in three places: package.json, a literal `'LifeOS v1.2.0-a'` in src/ui/app.js line 3711, and a literal in test/v100-review.test.mjs line 274 [V]. Nothing compares versions at runtime; sync and restore decide by schema [D]. | code | Weak |
| Release tags | Only one tag exists locally, v1.0.0 at 3e0fd18 [V]. Remote has no tags at all [V: `git ls-remote --tags origin` returns none]; consistent with the reported failed tag push through the proxy. v1.1.0 (pushed, on remote main 6a8309e) is untagged [V]. | git | Gap |
| Owner updates live copy | Reload after a push; `_headers` sets no-cache on html [V], whether the Worker applies it [U]. Settings shows the version (#app-version) [V]. An open tab keeps old code until reload; no "new version" notice. | code | OK |
| Backup and restore | Encrypted backup export and import in Settings [V]; older-backup restore covered by smoke-work [D]; 64 MB cap refuses rather than cuts [D]. No last-backup date, no reminder, no "verify this backup" action [V: no such field in code]. Owner has never run a backup or a restore [D, to-do 2]. No restore drill documented. | code, HANDOFF | Gap, see B2 |
| Keys and passphrases | PBKDF2 600,000, key never stored [D]. Forgotten main passphrase loses everything; forgotten private passphrase loses the private vault on every device and backup [V, lock screen note, README]. Main passphrase fields allow a password manager (autocomplete new-password and current-password) [V]. No recovery sheet procedure, no passphrase hint, no recovery key. Passphrase change needs the old passphrase once on other devices [D]. | app.js 117, 365 | Risk accepted by design; process missing |
| Drive sync friction | 13 manual Google Cloud steps; testing-mode authorisation may expire after 7 days; token about 1 hour, reconnect every session; Cloudflare Access redirect not covered in SYNC-SETUP (only a HANDOFF to-do) [D]. A second device must first create a throwaway vault, then sync [D, step 13]; the lock screen offers only Create or Unlock, no "restore from backup or Drive" [V, lockScreen]. | SYNC-SETUP, app.js 363 | High friction |
| Monitoring and errors | None server-side, by design. In app: errors go to a polite live-region notice, mapped by `friendly()` and cut to 300 characters [V]; a render error shows a paragraph in place of the screen [V]. No window error or unhandledrejection handler [V: grep], no stored error log. The audit log (200 entries, action names only) shows under Settings, Recent activity [V]. A privacy-safe diagnostics path does not exist yet. | app.js 79, 305 | Gap, see B9 |
| Browser support | Tested in Chrome only (desktop and emulated 390x844) [D, V]. Safari, Firefox and Chrome on Android never run [D]. | SECURITY | Gap |
| Storage eviction | `navigator.storage.persist()` is never called [V: grep]; `persisted()` returns false in Chrome over localhost [V, tour]. The whole vault is one IndexedDB value [V, store.js]. Best-effort storage can be evicted under storage pressure, and Safari's documented policy clears script-written storage for sites not used for 7 days [O, WebKit policy, not tested here]. With Drive unproven, eviction is total loss. | store.js, tour | Blocker for phone use |
| Offline and PWA | No manifest, no icons, no apple-touch-icon, no service worker [V: shell.html, tour]. CSP `default-src 'none'` would also block a manifest and a worker until manifest-src and worker-src are added [V, build.mjs]. Home-screen install gives at best a bookmark [O]. | shell.html | Gap |
| Performance at caps | Measured in audits: unlock to dashboard 1.0 to 3.2 s at caps on 390x844 Chrome; each save 0.7 to 2.0 s because every write re-encrypts the whole vault; several domains at caps pass 64 MB, after which export and sync refuse [D]. Built file 960,663 bytes (working tree) and 887,548 (HEAD) [V]. Archiving (part B) is the planned fix. Empty vault: create to dashboard about 0.3 s here [V]. | SECURITY, build | OK until archiving lands |
| Test suite runtime | `node --test test/`: 601 of 601 pass on the in-progress tree, 101 s wall [V]. Smokes: see the note below the table. `test/smokes.mjs` runs each script with `spawnSync` and no timeout [V], so one hung script stalls the whole gate. | runs | Weak |
| Flake history | SEC-43 (v0.6.0): intermittent smoke-sync failure, a test bug, fixed [D]. This review: smoke-command took 287 s to pass when given 420 s, against 6 to 58 s for every other smoke [V]. With 240 s and 150 s limits it was cut off (once silent, once "Target page, context or browser has been closed"), which looks like a hang to anyone with a shorter patience [V]. Why it is slow is not isolated [U]. | runs | Watch: slow, not failing |
| Documentation | HANDOFF says "Updated 16 Nov" and "Schema: 12" while the tree is at schema 13 with 14 planned [V]. README sections run out of order (1.1.0, 1.0.0, 0.12.0, 0.11.0) and say nothing of v1.2.0-a; README calls `_headers` Cloudflare Pages, the host is a Worker [V]. Missing: deploy and rollback runbook, new-device guide, backup and restore drill, passphrase recovery sheet, owner user guide, changelog. | docs | Gap |

Smoke results this review [V]: all 18 scripts passed on a copy of the in-progress tree, about 10 minutes in all; see the appendix.

## 3. Product review (owner-facing)

**First run [V, tour].** The lock screen shows one line ("Your private life dashboard. Everything stays on this device, encrypted."), two passphrase fields and the no-recovery warning. Nothing explains the private vault, backups or Drive, and there is no path for a second device or a restore. Create lands on the dashboard.

**Onboarding [V].** None. The dashboard shows 11 tiles of "n/a", "0 of 4" and "$0", then nine revenue and business modules, two of which say "No 2026 tax profile yet". The owner's first real task (tax profile, to-do 00) sits under Business, Tax with no pointer. [O] A setup checklist would carry most of the owner to-do list into the product.

**Empty states [V].** Domain screens are good: Social offers Family, Friends and Professional groups, each added only on a tap, and explains that older entries still count. The dashboard is the weak one: empty, it is 4,046 px tall at 390x844 (about 4.8 screens) and 1,831 px on desktop. Customize can hide modules, but the default shows everything.

**Navigation on a phone [V].** Bottom nav has 9 buttons (Home, Money, Assets, Work, Health, Business, Review, Memory, Settings) at 11.2 px text, 34 to 53 px wide (Work is 34). Goals, Home (house), Admin, Learning, Activities, Social and Wellbeing are reachable only by scrolling the dashboard to their tile; Social sits about 1,400 px down. Views do not use the history API: the browser or Android back button leaves the app (Playwright goBack went to about:blank), and because the key is only in memory, returning means unlocking again. "Home" means the dashboard in the nav and house maintenance on a tile. Memory, used monthly at most, takes a primary slot. [O] Navigation is the largest daily-use problem on a phone.

**Data entry speed [V].** Quick add from the dashboard: one tap, then type (expense or income), amount, category, date (prefilled), optional note, Save. That is fast. Health has one-tap daily checks. Full screens are long: Money 2,814 px with 29 inputs, Health 3,328 px with 32 inputs at 390x844. Every save re-encrypts the vault (about 1 s near caps [D]).

**Weekly review loop [V].** One page, 9 steps: digest table, insights (Run rules suggestions, Suggest with AI, or manual copy and paste), Goals, Home and Admin, Learning, Activities, Social, Revenue, three priorities. Gaps: no "review due" or last-review date anywhere on the dashboard; month and quarter consolidation are never proposed; digest units read oddly ("0 %" for Money, "0 USD" for Assets). The AI sees numbers only, so with manual entry its suggestions can only restate deltas [O].

**Confusing [V unless noted].** Two meanings of Home; Private and Lock buttons side by side in the header; Memory uses "Level" language; business modules shown before any business setup; the private vault's "New items are private" switch adds a mode the owner must remember [O].

**Missing for daily use.** Reminders (nothing tells the owner a renewal, estimate or review is due unless the app is open) [V]; a calendar export of dated items [V: none]; global search [V]; phone install and persistent storage [V]; a backup nudge [V]; the command center tabs where his active work happens (job search, podcast launch, AYiN clients) [V].

**Accessibility [V, partial].** Good: every input on the dashboard has a label (0 unlabelled), `:focus-visible` outline, focus moves to the h1 on navigation, a polite live region for notices, `aria-current` on nav, Move up and Move down as the keyboard path for drag, dark mode via prefers-color-scheme. Weak: 11.2 px nav text and nav targets under 44 px wide. Not checked: screen readers (VoiceOver, TalkBack), chart text alternatives, colour contrast [U].

**Where value is weakest [O].** (1) Phone access cost: Access sign-in, passphrase, no install, back button re-locks, hourly Drive token. If logging on the phone is slow, data stays thin and every downstream view (goals, review, AI) is empty. (2) The memory loop: numbers-only prompts plus counts-only rejections give the AI little to learn from, and nothing makes the owner come back weekly. (3) The command center: revenue and tax are built, but job search, podcast and client work, the things he is doing now, have no home.

## 4. Prioritised build list

Size: S under a day of build plus audit, M a cycle, L more than a cycle. **Blocker** = blocks real daily use [O].

| ID | Title | Why it matters | Size | Risk | Depends on | Owner decision |
|---|---|---|---|---|---|---|
| B1 **Blocker** | Request persistent storage | Eviction of the single IndexedDB value is total loss while Drive is unproven | S | Low | None | No |
| B2 **Blocker** | Backup safety: last backup and last sync dates, nudge after N days or edits, "Verify a backup file" (decrypt, compare counts) | Only copy is in the browser; owner has never backed up | S | Low | None | Nudge interval (suggest 7 days) |
| B3 **Blocker** | First real run: phone and PC, real Drive through Access, one real AI call, live header check (curl with an Access service token) | Nothing has run for real; sync and headers are assumptions | M (owner time) | Medium | Owner | Who holds the Access service token |
| B4 **Blocker** | Finish and audit v1.2.0 (part A audit, part B archiving in build) | Unaudited code is live-bound; vault can pass 64 MB | L | Medium (schema 14) | In build | Already decided (17 Nov) |
| B5 **Blocker** | Phone navigation: history entries per view so back stays in the app, a "More" sheet listing all 14 areas, 14 px nav text | Back button exits and re-locks; half the areas hidden | M | Low | None | Which 5 areas get the bottom bar |
| B6 | Release engineering: one version source injected by build, tag every release, push tags from a working path, CHANGELOG, deploy and rollback runbook with the schema rule, Worker config in the repo, per-script smoke timeout | Rollback across schema is a lockout; no tags on remote | S to M | Low | None | Where tags are pushed from if the proxy keeps failing |
| B7 | Local diagnostics: error codes only (no text, no values), capped, inside the encrypted state, "Copy diagnostics" in Settings | No way to report a failure without leaking data | S | Low (leak test must cover it) | None | Confirm codes-only |
| B8 | PWA: manifest, icons, service worker for the app shell, update prompt; CSP adds manifest-src and worker-src | Home-screen install and offline on phone | M to L | Medium: a stale cached app meeting a newer schema; Access sessions and SW fetches | B5, B6 | Hosted PWA through Access, or a separate offline copy |
| B9 | First-run setup checklist and a second-device path ("Restore from backup" and "Use my Drive copy" on the lock screen) | Removes the throwaway-vault step; carries the owner to-do list into the app | M | Low | B2 | None |
| B10 | Dashboard defaults: phone layout hides business modules until a tax profile exists; collapse empty modules | 4.8 empty screens on first open | S | Low | None | Default module set |
| B11 | Weekly loop: review due marker and last review date on the dashboard; propose month and quarter consolidation when a period closes; fix digest units | Without a pull, the loop does not run | S to M | Low | None | Review day |
| B12 | Memory loop, continual learning: fixed rejection reason codes (for example not useful, wrong, already known) sent as counts per code; approved insights can propose target changes (offer only) | R3 is only partly met since PV-6 | M | Medium (privacy boundary) | B11 | Allow coded reasons to reach the AI; PV-6 stays for free text |
| B13 | "Runs on Claude" and local models: real Anthropic test, documented Ollama origin setting, optional LAN or NAS model host | R4 partly met; NAS model blocked by validation and CSP | M | Medium (widens connect-src) | B3; NAS for LAN host | Allow one named LAN HTTPS host |
| B14 | Command center: Job search tab (applications, stages, follow-ups, links to Social people and Work pipeline) | Active now; pipeline items are too thin | L | Low | B4 | Scope and fields |
| B15 | Command center: AYiN Advisors and client projects tab (client list, engagements, invoices, budgets in one place) | Business data exists but is spread over Work and Business | M to L | Low | B14 pattern | Scope |
| B16 | Command center: Podcasts tab (episodes, cadence, guests from Social, costs) and Websites tab (sites, renewals from Admin, costs) | Owner roadmap | M each | Low | B14 pattern | Order and scope |
| B17 | Calendar export (.ics download) of dated items: renewals, tax dates, maintenance, review day | Reminders without push or a server | S to M | Medium (titles leave the vault into a calendar) | None | Titles or generic labels in the file |
| B18 | Global search across open domains (private only while open) | Daily lookup | M | Medium (leak tests) | None | No |
| B19 | Accessibility pass: 44 px targets, screen reader run on iOS and Android, chart text alternatives, contrast check | Phone use and quality bar | S to M | Low | B5 | No |
| B20 | Browser coverage: Playwright WebKit and Firefox smokes; real Safari on iPhone | Only Chrome tested | M | Low | B1, B8 | No |
| B21 | Passphrase recovery process: printed recovery sheet guide; optional recovery key | Forgotten passphrase is total loss | S (guide), M (key) | High for the key (second secret) | None | Whether to offer a recovery key at all |
| B22 | Drive friction: SYNC-SETUP section for Access redirect, sync reminder on lock or tab hide | Setup and daily sync are manual | S | Low | B3 | No |
| B23 | NAS sync | Owner requirement after NAS rebuild | L | High (new transport, CSP, CORS, HTTPS on LAN) | NAS rebuild, B13 decisions | Protocol and endpoint |
| B24 | Incremental encryption (per-collection envelopes) | 1 to 2 s saves at caps | L | High (crypto format, migration) | B4 | Only if archiving is not enough |
| B25 | Legal: lawyer review of LICENSE; repo visibility | Licence says others pay; source may be public | S (owner) | Low | None | Make the repo private |
| B26 | Custom domain | Roadmap "possible later" | S | Low (redirect URIs change) | B22 | Yes |

## 5. Suggested release sequence

| Release | Scope | Exit criteria |
|---|---|---|
| v1.2.0 (finish, in build) | B4: part B archiving and spell check off, audit of parts A and B; tag v1.1.0 and v1.2.0 | All unit tests pass in three zones; every smoke passes twice under a per-script timeout; audit findings fixed; both tags visible on the remote |
| v1.3.0 "Safe to live in" | B1, B2, B6, B7, B22; owner does B3 alongside | `persisted()` true on phone and PC; a backup restored on a second device; one real Drive sync each way through Access; live headers match `_headers`; runbook and CHANGELOG in docs; leak smoke covers diagnostics |
| v1.4.0 "Phone first" | B5, B9, B10, B19, B20, then B8 if the owner chooses the hosted PWA | Back button stays in the app; every area two taps from anywhere; new device restores without a throwaway vault; WebKit smoke passes; installed icon opens the app on the owner's phone |
| v1.5.0 "Weekly loop" | B11, B12, B13, B17 | Owner completes four weekly reviews in a row; month consolidation proposed without a button hunt; one real Claude API run and one manual Claude run produce approved insights; calendar file imports on the phone |
| v1.6.0 "Command center: job search" | B14, B18 | Owner tracks live applications in LifeOS for two weeks and drops any outside tracker |
| v1.7.0 "Command center: AYiN and media" | B15, B16 | Every client, site and podcast line has a tab with revenue, costs and next actions |
| v2.0.0 "NAS" | B23, B13 LAN host, B24 only if saves stay slow, B26 if wanted | Sync to the NAS both ways with conflict dialogs; Drive optional; full audit |

Owner decisions needed before v1.3.0: nudge interval (B2), Access service token holder (B3), codes-only diagnostics (B7). Before v1.4.0: bottom-bar areas (B5), hosted PWA or offline copy (B8). Before v1.5.0: coded rejection reasons to the AI (B12), LAN model host (B13), calendar file wording (B17).

## Appendix: smoke run in this review

Copy of the working tree at v1.2.0-a, 17 Nov 2026, Playwright with Chrome, one script at a time with a 420 s limit each [V].

| Script | Seconds | Result |
|---|---|---|
| smoke-activities | 22 | passed |
| smoke-activity-import | 9 | passed |
| smoke-business | 18 | passed |
| smoke-command | 287 | passed (slow) |
| smoke-goals | 10 | passed |
| smoke-health | 12 | passed |
| smoke-home-admin | 16 | passed |
| smoke-leaks | 43 | passed |
| smoke-learning | 17 | passed |
| smoke-money | 7 | passed |
| smoke-priv | 58 | passed |
| smoke-social | 19 | passed |
| smoke-sync | 12 | passed |
| smoke-v100 | 8 | passed |
| smoke-wellbeing | 46 | passed |
| smoke-work | 7 | passed |
| smoke | 9 | passed |
| review-ui | 6 | no findings |

Unit tests on the same copy: 601 of 601 passed in 101 s (default zone only) [V].
