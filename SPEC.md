# LifeOS v0.1 spec (Living Independent and Free Everyday Operating System)

Single-file, offline, local-first browser app. Vanilla JS, zero dependencies, zero network calls except an optional user-configured AI provider. Mobile-first responsive.

## Layout
```
src/core/vault.js store.js csv.js metrics.js memory.js ai.js   (Worker A)
src/ui/shell.html styles.css app.js                            (Worker B)
build.mjs  -> dist/lifeos.html                                 (Worker A)
test/*.test.mjs  (node --test, Node's global webcrypto)        (Worker A)
test/smoke.mjs   (headless browser smoke, if Playwright exists) (Worker B)
```
No ES modules in shipped code. Every core file is an IIFE that attaches to `globalThis.LifeOS = globalThis.LifeOS || {}` so it runs in both Node (tests import the file for side effects) and the browser. build.mjs inlines styles.css into one `<style>` and all JS (core in the order above, then app.js) into one `<script>` in shell.html, computes SHA-256 hashes of both, and writes the CSP meta tag.

## Hard rules (security and product)
1. All user data lives only inside one encrypted envelope in IndexedDB. Nothing in localStorage, cookies, URLs or console logs.
2. Crypto: WebCrypto only. PBKDF2-HMAC-SHA256, 600000 iterations, random 16-byte salt, key AES-GCM 256, `extractable:false`. Fresh random 12-byte IV on every encrypt. Passphrase minimum 12 characters. Passphrase never stored.
3. CSP meta (built): `default-src 'none'; script-src 'sha256-…'; style-src 'sha256-…'; connect-src https://api.anthropic.com http://localhost:* http://127.0.0.1:*; img-src data:; base-uri 'none'; form-action 'none'`. Therefore: no inline event handlers, no `style=""` attributes in markup (use classes; CSSOM `el.style.x=` and SVG attributes are fine), no eval, no external fonts, images or scripts.
4. DOM: never `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`. Build nodes with a helper `h(tag, props, ...children)` and `textContent`.
5. The AI never has the final say. AI or rules output only creates `proposed` insights. Only an explicit user tap calls `memory.decide`. No code path may set `approved` otherwise.
6. Token lean and private: the model only ever receives the numeric weekly digest, approved insights (max 8) and lessons (max 8). Never raw entries, titles, notes or people's names. `max_tokens` 600.
7. The AI API key is stored only inside the encrypted state and is never rendered back in full (show last 4).
8. CSV: import cap 5 MB and 20000 rows, strict validation, reject bad rows with a count. Export neutralises cells starting with `= + - @`, tab, CR, LF by prefixing `'`, and quotes fields.
9. All imported data (CSV, backup, AI response) is untrusted: validate types, lengths (title 200, notes 2000) and whitelists before it enters state.
10. No em dashes in any UI copy.

## State (schema 1)
```
{ schema:1,
  settings:{ currency:'USD', autoLockMin:15,
    targets:{ workoutsPerWeek:4, contactDays:30, savingsRate:0.2 },
    provider:{ kind:'none'|'anthropic'|'local'|'manual', baseUrl:'', model:'', apiKey:'' } },
  entries:[ { id, domain, type, date:'YYYY-MM-DD', title, value?:number, status?:string, person?:string, due?:'YYYY-MM-DD', notes?:string, createdAt } ],
  memory:{
    insights:[ { id, level:1|2|3, period:{from,to}, domain, text, source:'rules'|'ai', status:'proposed'|'approved'|'rejected', createdAt, decidedAt? } ],
    lessons:[ { id, text, createdAt } ],            // why the user rejected things; max 30
    reviews:[ { id, weekOf, digest, priorities:[string,string,string], completedAt } ] },
  audit:[ { ts, action } ]                          // capped at 200, no data values
}
```
Domains and entry types (`LifeOS.DOMAINS`, exported from metrics.js as `[{id,label,types:[{id,label,fields:[...]}]}]`):

| domain | types (fields beyond date/title/notes) | headline |
|---|---|---|
| money | income (value), expense (value) | savings rate this month |
| assets | balance (value; negative = liability; title = account) | net worth (latest balance per account) |
| work | outcome (status todo/done) | outcomes done this week, x of y |
| health | workout, sleep (value hours), weight (value) | workouts this week vs target |
| activities | session | active days this week |
| social | contact (person) | people overdue (last contact older than contactDays) |
| learning | item (status active/done), hours (value) | items finished this month |
| home | due (due, status open/done) | items due within 30 days |
| goals | goal (status on-track/at-risk/off-track/done) | share on track |
| wellbeing | mood (value 1 to 5) | 7-day mood average |

## Core API (Worker A implements, Worker B consumes; do not change signatures)
```
LifeOS.vault
  newSalt() -> Uint8Array(16)
  async deriveKey(passphrase, salt) -> CryptoKey
  async encrypt(key, obj) -> { iv:b64, ct:b64 }
  async decrypt(key, {iv,ct}) -> obj            // throws Error('BAD_PASSPHRASE_OR_DATA')
  async exportBackup(passphrase, state) -> string   // JSON envelope, fresh salt
  async importBackup(passphrase, text) -> state     // validated via store.validateState

LifeOS.store            // envelope {v:1,kdf:{name,hash,iter,salt},iv,ct} under one IndexedDB key
  _setAdapter({get,set,del})                    // tests inject memory adapter
  async exists() -> bool
  async init(passphrase) -> state               // creates default state
  async unlock(passphrase) -> state
  lock()                                        // drops key and state from memory
  isUnlocked() -> bool
  getState() -> state                           // throws if locked
  async commit(fn)                              // fn(state) mutates; then encrypt + save
  async changePassphrase(oldP, newP)
  async replaceState(state)                     // after backup import
  async wipe()
  validateState(obj) -> state                   // throws on anything malformed
  newId() -> string                             // crypto.randomUUID
  defaultState() -> state

LifeOS.metrics          // pure functions; `today` is 'YYYY-MM-DD'
  DOMAINS (also LifeOS.DOMAINS)
  validateEntry(partial) -> entry               // throws Error with a user-readable message
  headline(state, domainId, today) -> { label, display, value, sub }   // display is a string
  weekStart(dateISO) -> 'YYYY-MM-DD' (Monday)
  weeklyDigest(state, weekStartISO) -> { week, domains:{ [id]:{ now:number, prev:number, unit:string } } }
  series(state, domainId, n) -> [{ label, value }]  // last n weeks, for a sparkline

LifeOS.memory
  rulesInsights(state, weekStartISO) -> [{ domain, text }]   // no model, from digest deltas
  buildPrompt(state, level, period) -> { system, user }       // level 1 from digest; 2 from approved level-1 in period; 3 from approved level-2
  parseResponse(text) -> [{ domain, text }]     // strict JSON array, max 5, text <= 280, domain whitelisted; throws otherwise
  propose(state, items, { level, period, source })            // mutator, adds proposed
  decide(state, id, 'approved'|'rejected', reason?)           // mutator; a rejection reason becomes a lesson
  approved(state, level?) -> insights

LifeOS.ai
  validateProvider(p) -> p                      // local baseUrl must be http://localhost or http://127.0.0.1; throws otherwise
  async complete(provider, {system,user}, fetchImpl=fetch) -> string
     anthropic: POST https://api.anthropic.com/v1/messages (x-api-key, anthropic-version 2023-06-01, anthropic-dangerous-direct-browser-access:true)
     local: POST {baseUrl}/chat/completions (OpenAI-compatible, e.g. Ollama http://localhost:11434/v1)
     manual / none: throws Error('MANUAL'); the UI shows the prompt to copy into Claude and a box to paste the reply
     20 s timeout via AbortController; errors never include the key

LifeOS.csv
  parse(text) -> { headers:[], rows:[[...]] }   // RFC 4180, enforces caps
  toEntries(parsed, { domain, type, map:{date,title,value?,notes?} }) -> { entries, rejected:number }
  exportEntries(entries) -> string
```

## Learning loop (recursive, continual)
- Level 1 weekly: rules always propose; AI optionally proposes from the digest. User approves or rejects each.
- Level 2 monthly: consolidates approved level-1 insights of the month. Level 3 quarterly: consolidates approved level-2. Each stores its period so it can be regenerated.
- Rejection reasons are stored as lessons and included in every later prompt, so proposals adapt to the user.

## UI (Worker B)
Screens: Lock (create or unlock), Dashboard (10 tiles: headline, sub line, sparkline; plus this week's 3 priorities), Domain (entries list newest first, add form generated from DOMAINS fields, delete with confirm, CSV import with column mapping, CSV export), Weekly Review (1 digest now vs last week, 2 proposed insights with Approve / Reject + reason, buttons "Suggest with AI" and manual copy/paste mode, 3 set three priorities, finish), Memory (approved insights by level, lessons, "Consolidate month" and "Consolidate quarter"), Settings (provider, targets, currency, auto-lock, change passphrase, export/import encrypted backup, lock now, wipe with typed confirmation).
Auto-lock after `autoLockMin` idle minutes and on `visibilitychange` hidden for longer than that. Use `confirm`-free in-page dialogs. Accessible labels, keyboard usable, respects prefers-color-scheme.

## v0.3.0 addendum
Hosting: served over HTTPS (Cloudflare Pages / GitHub Pages) as well as file://. build.mjs also writes `_headers` at the repo root (Cloudflare Pages format, path `/*`) carrying the same CSP as the meta tag plus `frame-ancestors 'none'`, and HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` denying camera, microphone, geolocation, payment, `Cross-Origin-Opener-Policy: same-origin`, `Cache-Control: no-cache` for html.

### Money and Assets (owner: Money worker; owns app.js, styles.css, build.mjs, metrics.js, store.js)
Manual entry first; the user will type everything. Schema 2 with a tested migration from schema 1 (never lose data; migration runs on unlock and on backup import).
- `accounts:[{id,name,kind:'cash'|'investment'|'retirement'|'property'|'vehicle'|'other'|'credit'|'loan'|'mortgage',liability:bool,archived}]`. Balance entries reference `accountId`. Net worth = sum of latest balance per non-archived account, liabilities subtracted. Net worth history by month, assets vs liabilities split, allocation by kind.
- Money: categories (default list, user editable), expense/income entries carry `category`; `recurring:[{id,title,value,category,type,cadence:'weekly'|'monthly'|'yearly',nextDate,active}]` which only PROPOSES due items the user confirms with one tap (nothing auto-posted); monthly budget per category; month view with income, spend, savings rate, spend by category vs budget, cash-flow trend for 6 months.
- Fast add: one-screen quick entry (amount, category chips, date defaulting to today) reachable in one tap from the dashboard on a phone.
- Charts are inline SVG built with DOM APIs. Money maths in integer cents.
- weeklyDigest gains numeric money/assets fields only (no names).

### Google Drive sync (owner: Sync worker; owns src/core/sync.js, src/ui/sync-ui.js, test/sync*.mjs, test/smoke-sync.mjs)
- No Google script is loaded. OAuth 2.0 implicit token flow by full-page redirect to accounts.google.com with the user's own OAuth client ID (entered in Settings, stored in state), scope `https://www.googleapis.com/auth/drive.appdata` only, random `state` nonce checked on return (the nonce is the only thing allowed in sessionStorage), token read from the URL fragment then the fragment removed with history.replaceState before anything else runs. Token held in memory only, never in state, storage, logs or errors. Only offered when location.protocol is https:.
- Only the already-encrypted envelope is uploaded, to one file `lifeos-vault.json` in appDataFolder. Google never sees plaintext or the passphrase.
- Envelope gains `rev` (integer, +1 per commit) and `updatedAt`, `deviceId` outside the ciphertext, and the same three inside the ciphertext; mismatch between outer and inner = reject (anti-rollback/tamper signal).
- Sync is explicit ("Sync now") plus an optional prompt after unlock. Rules: remote missing -> upload. Remote rev > local and local unchanged since last sync -> offer download (needs the same passphrase; a different passphrase is reported plainly). Both changed -> never merge silently: show both summaries (rev, date, entry count) and let the user pick, keeping the losing copy as a downloadable encrypted backup first. Use Drive `If-Match`/etag or a re-read before write to avoid lost updates.
- Remote data is untrusted: size cap 64 MB, parseEnvelope + validateState before it replaces anything.
- CSP connect-src adds `https://www.googleapis.com` only. fetch with credentials omit, redirect error, 30 s timeout.
- Sync worker may make only small additive edits to app.js (a Settings section hook and a post-unlock hook), store.js (rev fields) and build.mjs (include files, connect-src); coordinate by keeping edits minimal and re-reading the file before each edit because the Money worker edits the same files.

## v0.4.0 addendum: Work
Manual entry, phone first. Schema 3 with a tested migration from 1 and 2 (no data loss; existing `work/outcome` entries keep working).
- `projects:[{id,name,kind:'job'|'venture'|'client'|'personal',status:'active'|'paused'|'done',nextAction,nextDate?,archived}]`. Cap 200.
- Weekly outcomes: existing `work/outcome` entries gain optional `projectId`; the Work view shows this week's top 3 with one-tap done, carry-over of unfinished outcomes offered (never automatic) at weekly review.
- `pipeline:[{id,title,org,kind:'job'|'deal'|'partner',stage:'lead'|'contacted'|'applied'|'interview'|'offer'|'won'|'lost',source,nextStep,nextDate?,updatedAt,notes}]`. Cap 1000. Board grouped by stage (list on phones), stage change in one tap, stale flag when no update for 14 days.
- Work view: projects with next action and overdue next dates, this week's outcomes, pipeline counts by stage, 8-week outcomes-completed trend (inline SVG).
- Dashboard Work tile: outcomes done x of y, with sub line showing overdue next actions and open pipeline count.
- weeklyDigest gains numeric work fields only (outcomes done/planned, active projects, overdue next actions, pipeline counts by stage, moved this week). Never project names, org names, titles or notes.
- validateState whitelists and caps every new field; sync, backup import and CSV export must handle schema 3; a schema 2 device meeting a schema 3 remote must migrate, and a schema 3 vault must never be downgraded.

## v0.5.0 addendum: Health, and project delete
Manual entry, phone first. Schema 4 with tested migrations from 1, 2 and 3 (no data loss; existing health entries keep working). The schema-downgrade guards from SEC-27/28 must cover schema 4 data (name the new collections in the warnings).
- Project delete (SEC-31): delete a project with an in-page confirm showing how many outcomes are linked; linked outcomes are kept and unlinked. Archived projects no longer count toward the cap.
- Body metrics: weight and body fat % entries with user-set targets and start values in settings (units lb or kg), trend chart with 7-entry moving average, progress to target, rate of change per week over the last 4 weeks.
- Workouts: entry gains `kind` from a user-editable list (defaults: strength, kettlebell, mace and clubs, bodyweight, cardio, HIIT, mobility, carries), `minutes`, optional `effort` 1 to 10, notes. Week view: sessions vs `workoutsPerWeek` target, minutes, mix by kind.
- Training cycle (optional): `cycle:{startDate, sprintDays, sprintsPerCycle, restDays, alternateHeavyLight:bool, firstWeek:'heavy'|'light'}`. Pure function returns sprint number, day in sprint, heavy or light week, or rest period, and days to next rest; shown on the Health view and dashboard tile sub line.
- Sleep: hours entries, 7-day average, trend.
- Daily checks: up to 8 user-defined yes/no habits (for example protein target hit, mobility done), one-tap today, 7-day completion rate, current streak.
- Health view at 390 px: today card (cycle status, one-tap habit checks, quick log workout/weight/sleep), then trends. Inline SVG charts.
- weeklyDigest gains numeric health fields only (sessions, minutes, average sleep, weight change, habit completion rate). Never habit names, notes or workout kinds typed by the user. Body metrics are sensitive: they must not appear in the audit log, error messages or anything outside the vault.
- This is a tracker, not medical advice: no health recommendations or diagnoses in UI copy or in rules-generated insights (rules may state numeric facts only).

## v0.6.0 addendum: Goals, and v0.5.0 leftovers
Manual entry, phone first. Schema 5 with tested migrations from 1 to 4 (no data loss; existing `goals/goal` entries become goals with horizon 'quarterly', metric 'manual'). Downgrade guards extended to schema 5 collections.
- Leftovers to fix first: (a) CSV import for health workouts must map kind, minutes and effort; (b) the daily-check tick store must not stop saving at 30,000 ticks: compact old ticks into per-month counts or raise the cap safely with a tested path; (c) find the root cause of the intermittent failure in test/vault.test.mjs (about 1 run in 11; run it 60 times in a loop) and fix the cause, not the test.
- `goals:[{id,title,horizon:'weekly'|'monthly'|'quarterly'|'annual'|'3y'|'5y'|'10y',domain,metric,direction:'up'|'down',startValue,targetValue,startDate,dueDate,parentId?,manualValue?,statusOverride?,state:'active'|'achieved'|'dropped',notes,createdAt}]`. Cap 300.
- Linked metrics, computed live from existing data by pure functions (no stored copies): net worth, savings rate (month), monthly spend, weight, body fat %, workouts per week, average sleep, daily-check completion rate, work outcomes done per week, pipeline items won, plus `manual` where the user types the current value. A metric with no data shows "no data yet", never zero.
- Progress = (current - start) / (target - start), clamped 0 to 1, direction aware. Pace status derived, not stored: ahead / on track / behind by comparing progress with elapsed share of startDate to dueDate (tolerance 10 points); the user can override status, and achieving or dropping a goal is always a user tap (never automatic; offer when the target is reached).
- Cascade: a goal may have a parent on a longer horizon; the Goals view shows the ladder 10y, 5y, 3y, annual, quarterly, monthly, weekly, with children under parents and unlinked goals listed separately. Deleting a parent keeps children and unlinks them (confirm dialog shows the count). No cycles; a parent must be on a strictly longer horizon.
- Weekly review gains a Goals step: goals due this period, pace changes since last week, and an offer (never automatic) to roll an unfinished weekly or monthly goal into the next period.
- Dashboard Goals tile: share of active goals on track or ahead; sub line: behind count and next due date.
- Privacy: goal titles and notes never reach a prompt, the digest or the audit log. The digest gains counts only (active, ahead, on track, behind, achieved this week). Goals whose metric is weight or body fat are excluded from every prompt and from rules insights text that would reveal the value (SEC-32 applies).
- No advice wording; pace labels are arithmetic facts.

## v0.7.0 addendum: Home and Admin (one cycle)
Manual entry, phone first. Schema 6 with tested migrations from 1 to 5 (no data loss). The thin `home` domain splits into `home` and `admin`: existing `home/due` entries are kept and shown under Admin as renewals (their text, dates and status preserved in full; if a field cannot map, keep the original entry visible rather than dropping anything, as in SEC-40). Downgrade guards extended to every schema 6 collection. Dashboard gains an Admin tile (11 tiles); nav stays usable at 390 px.

### Home
- `properties:[{id,name,kind:'house'|'condo'|'rental'|'land'|'other',archived}]` cap 20. The UI is built for one property but the data model allows several; with one property, no picker is shown.
- `maintenance:[{id,propertyId?,vehicleId?,title,area,cadence:'once'|'monthly'|'quarterly'|'semiannual'|'annual'|'custom',everyDays?,lastDone?,nextDue?,cost?,vendor,notes,state:'open'|'done'|'skipped'}]` cap 2000. Marking done records the date and cost and, for recurring tasks, proposes the next due date for one-tap confirmation (never auto-created). Seasonal starter checklist offered once as suggestions the user picks from (never auto-added).
- `vehicles:[{id,name,year?,odometer?,odometerUnit:'mi'|'km',archived}]` cap 20, with service history as maintenance items linked by vehicleId and optional odometer reading.
- Household bills: reuse Money recurring items via a `household` flag rather than a second store; Home view lists them with monthly total in integer cents. No duplicate data.
- Home view: overdue and due-in-30-days maintenance, year-to-date maintenance cost, vehicles with last service, household bills total. Tile headline: tasks overdue; sub line: due in 30 days.

### Admin
- `renewals:[{id,title,kind:'insurance'|'registration'|'license'|'subscription'|'membership'|'warranty'|'tax'|'legal'|'other',provider,dueDate,cadence:'once'|'monthly'|'annual'|'custom',everyDays?,amount?,autoRenews:bool,state:'open'|'done'|'cancelled',notes}]` cap 2000. Completing a recurring renewal proposes the next one for confirmation. Subscriptions view shows monthly and annual run-rate in integer cents and flags those not reviewed in 12 months (a numeric fact, no advice wording).
- `documents:[{id,title,kind,whereKept,expires?,notes}]` cap 1000. This is an index of where documents live, NOT a document store: no file uploads, and the form must state plainly not to enter ID numbers, account numbers or passwords. Validation rejects obvious secrets patterns in these fields with a clear message (for example 9-digit SSN shapes, 13 to 19 digit card numbers passing a Luhn check).
- Tax checklist: `taxItems:[{id,year,title,state:'needed'|'received'|'filed',dueDate?,notes}]` cap 1000, grouped by tax year; no tax advice, no computed tax.
- Admin view: timeline of what is due in the next 30, 60 and 90 days across renewals, tax items and document expiries; overdue first. Tile headline: items due within 30 days; sub line: overdue count.

### Cross-cutting
- Weekly review gains a Home and Admin step listing what came due this week and what is due next week, with the propose-then-confirm actions.
- Goals: add linked metrics "maintenance tasks overdue" and "admin items overdue" (direction down).
- weeklyDigest gains counts and totals only (overdue, due soon, done this week, YTD maintenance cost, subscription run-rate). Never titles, providers, vendors, vehicle or property names, document locations or notes; adversarial-string tests required.
- All dates local YYYY-MM-DD; due maths tested in New York and Auckland time zones and across DST and month ends (monthly cadence from the 31st).
- No advice wording anywhere (no legal, tax, insurance or financial recommendations); state numeric and date facts only.

## v0.8.0 addendum: Learning
Manual entry, phone first. Schema 7 with tested migrations from 1 to 6 (no data loss; existing `learning/item` and `learning/hours` entries are kept in full, following the SEC-40 rule: if anything cannot map, keep the original visible and deletable, never drop it). Downgrade guards extended to schema 7 collections.
- `learningItems:[{id,title,kind:'course'|'book'|'certification'|'skill'|'project'|'other',provider,state:'planned'|'active'|'paused'|'done'|'dropped',progressPct?,totalUnits?,doneUnits?,unitLabel?,startDate?,targetDate?,finishedDate?,examDate?,expiresOn?,goalId?,notes,createdAt}]` cap 1000. Progress is either typed percent or doneUnits/totalUnits (chapters, modules, lessons), never both; no divide by zero.
- `studySessions:[{id,itemId?,date,minutes,notes}]` cap 20000; quick log in one tap from the Learning view and the dashboard quick-add. Deleting an item keeps its sessions and unlinks them (confirm shows the count).
- Settings target: study minutes per week. Week view: minutes vs target, sessions, days studied, current streak of weeks meeting the target.
- Certifications: exam date countdown; `expiresOn` shows in the Admin 30/60/90 timeline as a computed row (no duplicate renewal record is created).
- Takeaways: `takeaways:[{id,itemId?,date,text}]` cap 5000, short notes of what was learned, searchable by plain substring inside the unlocked app.
- Learning view at 390 px: active items with progress bars and target dates (behind / on pace by the same arithmetic as Goals pace), this week's study time, upcoming exams, recently finished. Tile headline: study minutes this week vs target; sub line: active items and next exam date.
- Goals: new linked metrics "study minutes per week", "learning items finished" and a per-item progress metric via `goalId`.
- Weekly review gains a Learning step: minutes vs target, items that moved, items with no session in 14 days (a numeric fact), with offer-only actions (pause, drop, set new target date).
- weeklyDigest gains numbers only (minutes, sessions, days studied, active count, finished this week, stalled count). Never titles, providers, takeaway text or notes; adversarial-string tests required. Takeaways never reach any prompt.
- The secrets-pattern guard (SEC-44/45) applies to typed notes and takeaway text.
- No advice wording; arithmetic and date facts only.

## v0.9.0 addendum: Activities
Scope: every activity that involves engaging the world at large (outings, events, travel, hobbies, volunteering, networking, classes attended in person). Manual entry, phone first. Schema 8 with tested migrations from 1 to 7 (no data loss; existing `activities/session` entries kept in full, SEC-40 rule). Downgrade guards extended. Typed free text capped at 200 characters for notes (SEC-49 pattern); the whole-vault size guard must still hold.
- `activities:[{id,title,category,state:'planned'|'done'|'skipped',date,endDate?,minutes?,place,withPeople:[string] (max 10),costCents?,expenseId?,returnCents?,worthIt? (1 to 5),alsoHealth:bool,healthKind?,alsoSocial:bool,goalId?,notes,createdAt}]` cap 5000. Categories are a user-editable list (defaults: outing, event, travel, hobby, networking, volunteering, class, other), cap 30.
- Upcoming: planned activities in a rolling 30-day window. The Activities view and a dashboard "At a glance" card show today and this week by default with the rest of the 30 days collapsed behind one tap; items move forward automatically as dates approach (computed, nothing stored). At a glance is Activities-only for now, but build it on a provider list so other domains can be added later without rework.
- Cost and ROI: cost is entered once. Marking an activity done with a cost offers (one tap, never automatic) to create the linked Money expense; `expenseId` links them, deleting either side unlinks and never deletes the other, and totals never double count. A planned activity's cost shows as "committed" in the Activities view and is not counted in Money until done. Views: cost per activity, cost by category per month, cost per hour, average worth-it rating by category, financial return minus cost where a return was entered. Integer cents; categories with no rating or no cost show "no data", never zero. No advice wording: numbers only.
- Multi-domain: `alsoHealth` counts the activity toward weekly workout sessions and minutes (computed in Health metrics from the activity, no duplicate workout entry; `healthKind` from the workout kinds list). `alsoSocial` updates last-contact dates for each name in `withPeople` (computed in Social metrics, no duplicate contact entry). Health and Social views show these with an "from Activities" marker. No double counting if the user also logged a workout or contact manually on the same day: both show, and a one-line notice offers to remove the manual duplicate (offer only).
- Past-date planned activities: the weekly review Activities step lists them and offers done, skipped or reschedule (never automatic), then asks for the worth-it rating on those marked done.
- Activities view at 390 px: at a glance, upcoming, recent, then the cost and rating tables. Tile headline: active days this week; sub line: next planned activity date and committed cost in the next 30 days.
- Goals: linked metrics "activities per month", "activity spend per month" (direction down), "average worth-it rating".
- weeklyDigest gains numbers only (done, planned next 7 and 30 days, spend, committed, average rating, health-tagged and social-tagged counts). Never titles, places, people's names, categories typed by the user or notes; adversarial-string tests required. People's names never reach any prompt, audit entry or error.
- Secrets guard (SEC-44/45) on typed notes and place. Dates local YYYY-MM-DD; multi-day activities via endDate; window maths tested across month and year end, DST, New York and Auckland.

### v0.9.0 amendment (owner decision, overrides the cost rule above)
A cost counts in Money at the earlier of: (a) the user confirming the activity is paid for, which can happen while it is still planned (prepaid tickets, deposits), or (b) the activity being marked done with payment still required. Add `paidOn?` (local date) to activities. A planned activity has a one-tap "Mark paid" that offers the linked expense dated `paidOn`; marking done when not yet paid and cost > 0 offers the expense dated the activity date. Unpaid planned cost stays "committed" and out of Money. Paid planned cost shows as "paid" in Activities and is in Money. Never automatic, never double counted (one expense per activity; if already paid, marking done offers nothing more). Skipping a paid activity keeps the expense and says so. Tests must cover each path.
