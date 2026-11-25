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

## v0.10.0 addendum: Social
Manual entry, phone first. Schema 9 with tested migrations from 1 to 8 (no data loss; existing `social/contact` entries kept in full, SEC-40 rule; each distinct person name in old entries becomes a person with those entries as their contact log). Downgrade guards extended. Typed notes capped at 200 characters; vault-size guard must hold; extend test/smoke-leaks.mjs to every new free-text field.
- `groups:[{id,name,cadenceDays}]` cap 30 (defaults offered once as suggestions the user picks: family 14, friends 30, professional 60; never auto-added).
- `people:[{id,name,groupId?,cadenceDays? (overrides the group),importantDates:[{label,monthDay 'MM-DD',year?}] (max 5),pipelineIds:[id] (max 10),notes,archived,createdAt}]` cap 1000. Effective cadence = person's own, else group's, else settings contactDays.
- `contacts:[{id,personId,date,channel:'call'|'message'|'in person'|'video'|'email'|'other',notes}]` cap 20000. One-tap "reached out today" per person from the Social view and from the overdue list. Deleting a person asks whether to keep the log unlinked (default) and shows the count; archiving hides them from overdue.
- Last contact = latest of logged contacts and social-tagged activities whose withPeople contains the person's name (case and whitespace insensitive, computed, no duplicate stored). Activities withPeople entry offers existing people as suggestions built with DOM APIs and offers (never automatically) to add an unknown name as a person.
- Views at 390 px: overdue (most overdue first), due within 7 days, by group with contacts per week for 8 weeks, person detail with log and important dates. Tile headline: people overdue; sub line: due this week and contacts this week.
- Important dates: upcoming birthdays and anniversaries within 30 days appear in the Activities at-a-glance card through the existing provider list as a second provider (label and person shown; Feb 29 dates show on Feb 28 in non-leap years).
- Work link: a pipeline item can list people; the pipeline card shows them and their last-contact date; the person detail shows linked pipeline items. Deleting either side unlinks, never deletes the other.
- Weekly review Social step: who became overdue this week, who is due next week, contacts made, with offer-only actions (log contact, snooze 7 days, change cadence, archive).
- Goals: linked metrics "people overdue" (direction down), "contacts per week".
- Privacy is the core risk: people's names, group names, important-date labels, channels typed by the user and notes never reach any prompt, the digest, the audit log, error messages, console, URL or storage outside the vault. The digest gains counts only (people, overdue, due soon, contacts this week, by-group counts keyed by position not name). Adversarial-string tests required. No inference or scoring about relationships and no advice wording: dates and counts only.
- Secrets guard on notes. Dates local; cadence and important-date maths tested across month end, year end, leap day and DST in New York and Auckland.

### v0.10.0 amendment (owner decisions)
- People carry a growing list of important facts, not only dates: `facts:[{id,label,text,addedOn}]` per person, cap 50 per person, label 40 characters, text 200 characters, added and removed one at a time from the person detail (newest first, substring search across people and facts with no RegExp from user input). Important dates stay as specified and remain the only person data shown outside the Social view (at a glance). Facts are subject to the secrets guard, are covered by test/smoke-leaks.mjs, and never reach any prompt, digest, audit entry, error or anything outside the vault. Vault-size guard must hold with facts at caps.
- Professional contacts connect to Work: confirmed as specified (pipeline items list people; both sides show the link). Also allow linking a person to Work projects (`projectIds`, max 10) with the same unlink-never-delete rule, and show the person's last-contact date on the project.

## v0.11.0 addendum, part A: Private vault
One private vault inside the app: a second lock with its own passphrase. Unlocking the app does not open it. Schema 10 with tested migrations from 1 to 9 (no data loss). Older app versions already refuse newer schemas; confirm that holds so an old device can never strip the private vault through sync or backup.

### Storage and crypto
- `state.priv = { v:1, kdf:{name:'PBKDF2',hash:'SHA-256',iter:600000,salt}, iv, ct, rev, marks:[collectionName] }` or absent before setup. `ct` is AES-GCM 256 ciphertext of the inner plaintext under a key derived from the private passphrase (own random 16-byte salt, fresh 12-byte IV per write, key non-extractable). It sits inside the main state, so it is encrypted twice at rest and travels with backup and sync unchanged. validateState treats `priv` structurally (types, base64, sizes, iter exactly 600000, marks whitelisted to known collection names) and never needs the private key. Inner `rev` is bound inside the ciphertext as well; mismatch is rejected.
- Inner plaintext: `{ schema:1, records:{ [collection]:[record] }, links:[{fromCollection,fromId,field,toId}], wellbeing:{} }`, validated with the same per-collection validators and caps as the main state when opened. Private passphrase minimum 12 characters and must differ from the main passphrase (compare by attempting to derive, never by storing either).
- `LifeOS.priv`: `isSetUp(state)`, `async setUp(passphrase)`, `async open(passphrase)` (throws 'BAD_PRIVATE_PASSPHRASE'), `close()`, `isOpen()`, `view(state)` (state-shaped object with private records merged in and link overlays applied; returns the base state untouched when closed), `async commit(fn)` (mutates inner plaintext, re-encrypts, saves through store.commit in one write), `async moveIn(collection,id)`, `async moveOut(collection,id)`, `async changePassphrase(oldP,newP)`, `async destroy()` (typed confirmation in UI), `marks(state)`.
- Key and inner plaintext live in memory only while open. They are dropped on: private auto-lock timer (setting `settings.privAutoLockSec`, default 60, allowed 15 to 1800, user editable), `visibilitychange` hidden, app lock, app auto-lock, wipe, passphrase change of either layer, and before any AI call. After close, no private record, number or text remains in the DOM (re-render) or in any module-level cache.
- Wrong-passphrase attempts: increasing delay in the UI (1 s doubling to 30 s, reset on success); no claim of real brute-force protection.

### Any record can go in
- Every record in every collection (entries, accounts, recurring, budgets, projects, pipeline, goals, maintenance, vehicles, properties, renewals, documents, taxItems, learningItems, studySessions, takeaways, activities, people with their facts and dates, groups, contacts, habits and their ticks, cycle) has "Move to private vault" in its edit dialog when the vault is open, and "Move out" for private records (confirm tap).
- Moving in removes the record from the main state and stores it in the inner plaintext in the same write. References from public records to the moved record are removed from the public record and stored as inner `links` overlays, re-applied by `view` when open, so nothing dangles and nothing is revealed while locked. References from a private record to public records stay on the private record. Records with a one-to-one money link (activity and its expense, SEC-51/52) are moved together or not at all, with a clear prompt. Moving a parent (person, learning item, project, account, property, vehicle, group) offers to move its children too (default yes); children left public keep working unlinked while locked.
- One write path: a helper routes every create, edit and delete to the main state or the inner plaintext by where the record lives, so no form can write a private record into the main state. New records are created public unless the user ticks "Private" (only offered when open).

### Hidden with a marker
- While closed, private records do not exist for any view, total, tile, chart, search, review, goal, at-a-glance item or export. Net worth, spend, counts and every other number are computed from the main state only.
- `priv.marks` lists which collections currently hold private records (names only, no counts). Wherever a number or list could be affected, show a small lock marker with accessible text "Some private items are hidden". No counts, no names, no totals of what is hidden. Marks are updated in the same write as each move.
- While open, views use `LifeOS.priv.view(state)`; private rows show a lock badge.

### Never to the AI, never persisted in the clear
- Prompts, the weekly digest, rules insights, stored review records, stored insights, lessons, the audit log and CSV exports are always computed from the main state only, even while the vault is open. There is no setting to change this. Audit entries for vault actions record the action name only (set up, opened, closed, moved in, moved out) with no collection or record detail.
- Encrypted backup export includes `priv` as is. Restore and sync conflict dialogs say whether each copy contains a private vault (yes or no only) and never drop one silently; restoring a copy without a private vault over one that has it needs the same explicit tick as SEC-27/28.
- Extend test/smoke-leaks.mjs: with records of every collection moved in and the vault closed, adversarial strings from them appear nowhere (DOM, prompts, digest, audit, errors, console, URL, storage, IndexedDB bytes, Drive upload); with it open, they appear in the DOM only.

## v0.11.0 addendum, part B: Wellbeing (inside the private vault)
Built after part A. Wellbeing lives only in the inner plaintext (`wellbeing`), never in the main state.
- Requires the private vault: the Wellbeing view offers setup when none exists and asks for the private passphrase when closed. Existing thin `wellbeing/mood` entries stay where they are until the vault exists, then one offer moves them all in as check-ins (no loss, idempotent).
- `wellbeing.checkins:[{id,date,mood?,mental?,recovery?,connected?,intimacy?,note?}]`, each rating an integer 1 to 5, one check-in per local date (a later update the same day merges by section, never overwrites other sections), note 200 characters, cap 6000. No other detail fields for any area.
- Check-in: opening it asks "Quick update, all areas" or "One section"; quick shows the five ratings on one screen (one tap each, any may be skipped); one section shows only that area. Past dates can be edited.
- Rest and recovery view also shows sleep hours read from Health (not copied). Social engagement view also shows contacts made and social-tagged activities read from Social and Activities (not copied), next to the "connected" rating.
- Views at 390 px: today, then 7-day and 30-day averages and trend lines per area (inline SVG), check-in streak. No interpretation, labels, thresholds, flags, comparisons to norms or advice anywhere: numbers and dates only.
- Dashboard Wellbeing tile: closed shows "Locked" and the lock marker with no numbers; open shows the 7-day mood average and streak.
- Goals: wellbeing metrics (7-day average per area, check-ins per week) are available only to goals that are themselves private; a public goal cannot reference them.
- Wellbeing never appears in the weekly review record, digest, prompts, insights, audit log or CSV export. The weekly review shows a Wellbeing step only while the vault is open, and stores nothing from it.

## v0.12.0 addendum: Command center, first build (revenue tracker and customizable home)
Owner decisions: the command center lives inside LifeOS (same vault and passphrase), not a separate app. This first build covers the revenue tracker and customizable home modules; job search, websites, podcasts, AYiN Advisors and client project tabs come later. Lines of work are Work projects; money is attributed by linking Money income and expense entries to a project. The owner's "Command Center - Revenue Ledger" Google Sheet is a one-time CSV import source. Schema 11 with tested migrations from 1 to 10 (no data loss). Private vault rules (part A) apply to everything new: private projects and their entries are excluded while closed, with markers; the write-routing helper covers every new write path.

### Lines of work
- Project `kind` gains 'website' and 'podcast'. Projects gain optional `parentId` (one level only, parent must be a non-archived project, no cycles) so client and website lines can roll up under a venture such as AYiN Advisors. Deleting or archiving a parent unlinks children, never deletes them.
- Money income and expense entries and recurring items gain optional `projectId` (unlink on project delete, never delete the entry). Bulk "assign to line of work" on a filtered list of entries, with a confirm showing the count.

### Revenue tracker (a "Revenue" view under Work, also reachable from the home module)
- Income entries gain optional `status:'expected'|'received'` (default received; existing entries are received) and `dueDate`. Expected income is NOT counted in Money actuals, savings rate, budgets or net worth until marked received (one tap, date received defaults to today; never automatic). Received is counted on its received date.
- Per line of work and per parent rollup, for a chosen period (this month, last month, quarter to date, year to date, trailing 12 months, custom): revenue received, expenses, net, margin percent (no data when revenue is zero, never divide by zero), month-by-month table and inline SVG chart for 12 months, recurring monthly revenue from recurring income items, expected income in the next 30, 60 and 90 days, and overdue expected income (due date passed, not received). An "Unassigned" line shows entries with no project. Totals across lines must equal Money totals for the same period exactly (integer cents); test this.
- Goals: linked metrics "revenue per month" and "net per month", each optionally scoped to one line of work or one parent rollup.
- Weekly review gains a Revenue step: received this week, overdue expected income, with offer-only actions (mark received, move due date, write off which sets status to a new 'written-off' value excluded from actuals).

### Ledger CSV import (one-time, reusable)
- Uses the existing CSV parser and caps. A mapping screen lets the user map columns to: date, amount, or separate income and expense amount columns, or an amount plus a type column with user-chosen income and expense values; line of work (matched to existing projects case and whitespace insensitive; unknown names are listed and each is offered as a new project, never created automatically); category; description; status; due date. Date formats: YYYY-MM-DD, MM/DD/YYYY, M/D/YYYY, and DD/MM/YYYY only when the user picks it explicitly (never guessed). Amounts accept currency symbols, thousands separators and parentheses for negatives; parse to integer cents without floating point.
- A preview shows rows to add, rows rejected with reasons, totals by line and type, and duplicates. Nothing is written until the user confirms. Each imported entry stores an `importKey` (SHA-256 of normalised date, amount, type, line name and description); re-importing the same file adds nothing and says so. Secrets guard and 200-character caps apply to description.

### Customizable home (dashboard modules)
- The dashboard becomes a set of modules: every existing tile, the Activities at-a-glance card, priorities, plus new revenue modules (revenue this month, net by line of work this month, expected and overdue income). Users can reorder by drag (pointer events, works with touch and mouse), and also with "Move up" and "Move down" buttons for keyboard and accessibility; show or hide each module; choose size small or wide where the module supports it; reset to default.
- Layout is stored in settings inside the encrypted state as `layouts:{narrow:[...],wide:[...]}` (narrow under 720 px viewport width), each a list of `{id,size,hidden}` with ids whitelisted; unknown ids dropped, missing modules appended hidden-false at the end, so new modules from future builds appear without breaking saved layouts. Saving a layout never writes anything else.
- Private and Wellbeing modules keep their locked behaviour.

### Privacy and AI
- Project names, parent names, descriptions, categories and imported text never reach any prompt, digest, insight, audit entry, error or URL. The digest gains numbers only: revenue received, expenses and net this week and month, expected next 30 days, overdue count, line-of-work count. Private projects and their money excluded per part A. Extend test/smoke-leaks.mjs to every new free-text path, including imported CSV text.
- No advice wording; numbers only.

## v1.0.0 addendum: final complete review (contract changes)
- Hard rule 6, owner's numbers-only rule: lessons (rejection reasons) stay in the vault and are never sent. The prompt carries the numeric digest, approved insights (max 8) and the count of recently rejected insights per area.
- No rules insight states a body metric value or change (the weight rule is removed).
- Ledger import refuses while private entries or lines of work exist and the private vault is closed.
- "New items are private" applies to add forms and add dialogs only; other new records follow SEC-62.
- Recurring items may carry `anchorDay` (1 to 31) while their next date is clamped to a short month's end. Schema stays 11.
- Every input, textarea and form has autocomplete off, except the main passphrase fields.

## v1.1.0 addendum: Business expenses, invoices and tax (NJ single-member LLC)

Owner decisions (15 Nov 2026): AYiN Advisors is a single-member LLC, taxed like a sole proprietor (Schedule C, self-employment tax, federal and NJ quarterly estimates). In scope: project budgets with billable and reimbursable expenses, invoices and receivables, mileage and home-office logs, tax estimates with set-asides and a payment calendar, and 1099-NEC payee tracking. Out of scope: split receipts, payroll, S corp, NJ BAIT (NJ does not allow single-member LLCs or sole proprietors to elect it), and sales tax filing.

This builds on v1.0.0: lines of work are Work projects, income carries `status` expected/received, and the ledger import and customizable home already exist. Schema 12, with tested migrations from 1 to 11 (no data loss), downgrade guards extended, and private vault rules (part A) applied to every new collection and write path. Integer cents throughout.

### Business vs personal
- Money income and expense entries gain `scope:'business'|'personal'`. Existing entries default to personal unless they are linked to a project of kind `venture`, `client`, `website` or `podcast`, which defaults to business. The migration shows the counts, and the user confirms them once.
- Expense categories gain an optional `taxLine`, mapped to Schedule C lines. Defaults: advertising, car and truck (from the mileage log only), contract labor, insurance, legal and professional, office expense, rent, supplies, travel, meals (50%, editable), utilities, software and subscriptions (other expenses), education, bank and payment fees, home office (from the home-office log only). Users can edit the mapping. An unmapped business expense shows as "Unmapped" in tax views and is never dropped.

### Project budgets
- Projects gain optional `budgetCents` with `budgetPeriod:'month'|'project'`. Budget vs actual per project and per parent rollup. Over-budget shows a status color only, never advice wording.
- Expenses gain `billable:bool` and `reimbursable:bool`, plus `billedInvoiceId?`. Unbilled billable expenses are listed per client project, and "Add to invoice" is offered with one tap.

### Invoices and receivables
- `invoices:[{id,number,projectId,issueDate,dueDate,lines:[{description,qty,unitCents,expenseId?}] (max 50),status:'draft'|'sent'|'paid'|'void',paidOn?,incomeId?,notes}]`, cap 5000. Number format is a user setting with an auto-increment counter, and duplicate numbers are refused.
- Marking an invoice sent offers (never automatically) one expected income entry for the total with the due date. Marking it paid offers to mark that income received on `paidOn`. Cash basis: income counts when it is received. One income per invoice; voiding unlinks it and never deletes it.
- Aging: current, 1 to 30, 31 to 60, 61 to 90, and over 90 days past due. These feed the existing overdue-income module.
- Print view: a clean invoice page with business name, address and payment terms from settings. It prints to PDF with the browser. No network calls.

### Mileage and home office
- `trips:[{id,date,from,to,miles (one decimal),purpose,projectId?,roundTrip:bool}]`, cap 10000. The deduction uses the tax-year rate (default 72.5 cents per mile for 2026, editable). Trip text stays in the vault only.
- Home office (simplified method only): `homeOffice:{year:{squareFeet,monthsUsed}}`. The rate and square-foot cap are settings in the tax-year profile (default $5 per square foot, 300 square feet). The result shows on the Schedule C summary as its own line.

### Contractors and 1099-NEC
- Expenses in categories mapped to contract labor (or flagged as `contractor`) carry `payeeId`. `payees:[{id,name,tinOnFile:bool,w9Date?,archived}]`. The tax ID itself is never stored, only whether a W-9 is on file.
- Per payee, the year's total is shown and flagged once it reaches the 1099-NEC threshold in the tax-year profile (default $2,000 for 2026), with a January 31 filing reminder in the Admin timeline. Card payments can be marked so they are excluded from the 1099 total.

### Tax-year profile (user-editable, nothing hard-coded in logic)
- `taxYears:{YYYY:{seRate:0.153, ssWageBase, ssRate:0.124, medicareRate:0.029, addlMedicareRate:0.009, addlMedicareThreshold, seFactor:0.9235, mileageRate, homeOfficeRate, homeOfficeMaxSqFt, nec1099Threshold, federalEffectiveRate, njEffectiveRate, priorYearFederalTax?, priorYearNjTax?, priorYearAgiOver150k:bool, dueDates:{federal:[...4], nj:[...4]}, sourceNote}}`.
- 2026 defaults, each shown with its source note: Social Security wage base $184,500; mileage 72.5 cents; 1099-NEC threshold $2,000; federal and NJ estimate dates Apr 15, Jun 15, Sep 15 and Jan 15 of the next year (moved when a date falls on a weekend or holiday). The effective income tax rates have no default: the user enters them, and until then the views show "set your rate". Each new year copies the last profile, and nothing changes until the user confirms it.

### Tax estimate, set-aside and calendar
- Net business profit = business income received minus deductible business expenses (meals at their percentage), mileage and home office, year to date.
- Self-employment tax is computed exactly: profit times the SE factor; 12.4% up to the wage base and 2.9% on all of it; plus 0.9% above the threshold. Half of SE tax reduces the income tax base.
- Federal and NJ income tax are estimated from the user's effective rates. These are labelled as estimates.
- Set-aside: the recommended reserve to date, compared with an optional "tax reserve" account balance (an existing Money account picked by the user).
- Quarterly payment log per jurisdiction: `taxPayments:[{id,year,jurisdiction:'federal'|'nj',quarter,amountCents,paidOn,confirmation?}]`. Due dates appear in the Admin 30/60/90 timeline and as a home module.
- Safe-harbor targets (shown only when the prior-year figures are entered). Federal: 100% of prior-year tax, or 110% when the prior-year AGI flag is set, compared with 90% of the current estimate. NJ: the smaller of 80% of current-year tax or 100% of prior-year tax. Each target is split into quarterly installments, with paid-to-date vs target.
- Wording rule: "Estimate. Numbers only, not tax advice. Confirm with your accountant." appears on every tax view. No advice wording anywhere.

### Year-end accountant package
- One export (CSV plus a print view): Schedule C totals by line, the business income list, the expense list with tax lines, the mileage log, the home-office figures, 1099 payee totals (names, totals and W-9 status, never a tax ID), and quarterly payments. Export goes to a file only, with no network calls.

### Home modules (added to the v1.0.0 layout whitelist)
- Tax set-aside vs reserve, next estimated payment due, open invoices and aging, budget vs actual for one pinned project, and 1099 payees near the threshold.

### Privacy, AI and tests
- Invoice text, payee names, trip text, notes and confirmations never reach prompts, the digest, insights, errors, audit entries or URLs. The digest gains numbers only: business profit to date, estimated tax to date, set-aside gap, open invoice count and total, and overdue count. Extend test/smoke-leaks.mjs to every new free-text path.
- Tests must cover: SE tax at, below and above the wage base and the additional Medicare threshold; a negative profit (no SE tax); meals at 50%; mileage and home-office caps; invoice to income to paid with no double counting; void handling; 1099 threshold edges (just under and exactly at); safe-harbor for both jurisdictions with and without prior-year figures; the schema 11 to 12 migration; and the private vault excluding private projects' invoices, trips and payments.

### v1.1.0 amendment (owner decisions, 16 Nov 2026; overrides the addendum where they differ)
1. Mileage rates are dated periods inside each tax-year profile: `mileageRates:[{from:'YYYY-MM-DD',centsPerMile}]` (cents with one decimal allowed, stored as tenths of a cent or another exact integer form; no floating point in totals). Each trip is priced by the period containing its date. 2026 defaults: 72.5 cents from 2026-01-01 (IRS Notice 2026-10) and 76 cents from 2026-07-01 (IRS Announcement 2026-11), each with its source note. Replaces the single `mileageRate`. Tests: trips on 2026-06-30 and 2026-07-01, a year with one period, a period list out of order (sorted, not refused), an empty list (shows "set your rate", deducts nothing).
2. The 1099-NEC filing reminder uses the same weekend and holiday shift as the estimate dates: for 2026 payments it is 2027-02-01 (January 31, 2027 is a Sunday). The holiday list is part of the profile, editable.
3. Reimbursable and billable expenses are treated gross: the full invoice counts as business income when received, and the expense is deducted on its own tax line. Nothing nets them. The Schedule C summary shows reimbursed totals as an informational line so the accountant can see them.
4. Filing status is a profile field (`filingStatus:'single'|'mfj'|'mfs'|'hoh'`), set to single for the owner. The additional Medicare threshold defaults from it (single and hoh 200000, mfj 250000, mfs 125000 dollars), editable, with a source note.
5. The owner has 1099 contract income this year. All self-employment income is entered as business income on its own line of work (a project of kind `client`), so it flows into net profit and SE tax with everything else. The Schedule C summary and the accountant export show totals per line of work and per parent rollup, so the accountant can decide whether it belongs on the same Schedule C or a separate one; the app makes no such determination. Add an optional profile field `otherSsEarningsCents` (W-2 Social Security wages, default 0) that reduces the room under the Social Security wage base before the 12.4% part is computed. Tests: SE tax with other earnings at, below and above the wage base.
6. If any business record of the selected year (income, expense, invoice, trip, payment, payee, or a project they belong to) is in the private vault and the vault is closed, every tax figure (profit, SE tax, income tax estimates, set-aside, safe harbor, Schedule C summary, export, tax home modules, tax digest numbers) refuses to compute and shows "Open the private vault to see tax figures." with the lock marker. No partial tax numbers anywhere, including the weekly digest (the tax fields are omitted, not zero). Non-tax views keep the normal marker behaviour.
7. The accountant export shows a plain warning before download ("This file is not encrypted. It contains your business records, payee names and mileage log. Store it somewhere safe.") and requires a confirm tap. The print view carries the same line at the top. No network calls.

## v1.2.0 addendum, part A: Activity CSV import
Closes the roadmap item "activity CSV import". Reuses the existing CSV parser, caps and the ledger import pattern (mapping screen, preview, nothing written until confirm, rejected-row reasons, importKey dedupe). Schema 13: activities gain optional `importKey`; tested no-op migration from 1 to 12 so older apps refuse a vault that carries it; downgrade guards unchanged otherwise.
- Mapping targets: date, end date, title (required), category, state, minutes, place, people, cost, paid date, return, worth-it, also health (yes/no), health kind, also social (yes/no), notes. Date formats as in the ledger import (DD/MM only when picked). Money via the existing integer-cents parser. People split on a separator the user picks (; or |), max 10 per row.
- Categories and health kinds matched case and whitespace insensitive; unknown ones listed and offered as new, never created automatically. A row whose state column is missing uses a default state the user picks on the mapping screen (planned, done or skipped); no guessing from the date.
- importKey = SHA-256 of normalised date, title, category and place; re-importing adds nothing and says so.
- Costs: imported rows never create Money expenses on their own. After import, rows with a cost that are done or have a paid date are listed with one "Create linked expenses" offer for the batch (one expense per activity, SEC-51/52 rules, skipping rows already linked). Nothing auto-posts.
- Social: imported people names follow the existing activity rules (ambiguous names credit nobody, SEC-57; unknown names offered as people, never created automatically).
- Private vault: if private activities exist and the vault is closed, the preview adds nothing and says to open the vault (PV-1 pattern). Imports are public unless the user ticks "Import as private" while the vault is open; the "New items are private" toggle does not apply (UI-5).
- Secrets guard and 200-character caps on title, place and notes. Imported text never reaches prompts, digest, insights, audit, errors, console, URL or storage outside the vault; extend test/smoke-leaks.mjs to the import path.
- Activities CSV export already exists or is added with the same columns, formula-neutralised, so an export re-imports to nothing new.

## v1.2.0 addendum, part B: Vault archiving, and spell check off (owner decisions, 17 Nov 2026)
Built after part A, on the same version. Schema 14 with tested migrations from 1 to 13 (no data loss), downgrade guards extended.

### What stays live
- The live vault keeps the current calendar year and the two full years before it. A year Y is archivable when Y is earlier than (current year minus 2).
- Archived: dated records of year Y that are finished (money entries, received or written-off income, paid or void invoices, tax payments, trips, contacts, study sessions, daily-check ticks, done or skipped activities, done maintenance, done renewals, workouts, body metrics, sleep, mood, Wellbeing check-ins, reviews and insights of that year). Never archived: anything open, planned, unpaid or referenced by a live record (accounts, projects, people, groups, goals, items, payees, properties, vehicles, categories, settings), and the tax-year profile.
- Before removal, yearly totals for year Y are written to `summaries:{YYYY:{...}}` (numbers only, per domain: the figures trends, net worth history, goals and the dashboard use). Every view, chart and goal that spans an archived year reads the summary, so trends keep working. Summaries are numbers only and follow the digest privacy rules.

### The archive file
- One encrypted file per year, `lifeos-archive-YYYY.json`: an envelope like a backup, encrypted under the main passphrase with its own fresh salt and IV. Private records of year Y go in an inner blob under the private key; archiving a year that has private records requires the private vault open, otherwise that year is refused with a plain message.
- Archive index in the live state: `archives:[{year, createdAt, sha256, counts, copies:[{where:'drive'|'download', at, verified}]}]`.
- Removal is a three-step, all-or-nothing operation: write the file, verify it (decrypt it back and compare counts and a SHA-256 of the canonical records), then remove the records from the live vault in one commit. Removal requires at least one verified copy: a Drive upload re-downloaded and decrypted, or a downloaded file the user confirms saving. The owner's choice is both copies: Drive and a downloaded copy kept on his NAS (the browser cannot write to the NAS directly; the download is saved there by the user, and the guide says so). When Drive is connected, both are offered by default.
- Open an archive read-only: from Drive or a chosen file, decrypted in memory, shown in an Archive screen per domain with search, and usable for that year's accountant export. Closing it or locking the app drops it from memory. Restore a year into the live vault only with an explicit confirm, deduplicated by id, never overwriting live records.

### When it happens (the vault adjusts, and the user can start it)
- Automatic proposal: whenever the encrypted vault size passes `settings.archiveSuggestMB` (default 40, range 20 to 60) or a new year becomes archivable, the dashboard and the weekly review show which years would move and how much space would be freed. One tap runs it. Nothing is ever removed from the live vault without that tap and a verified copy.
- User-initiated: Settings, Archive: pick any archivable year and run it at any time.
- Size is measured as the encrypted envelope's byte length.

### Sync, backup and safety
- A Drive or backup copy that still holds records of an archived year must not silently bring them back: the restore and sync conflict dialogs say which archived years the other copy still contains, and replacing needs the explicit tick (SEC-27/28 pattern). Archive files never replace the live vault.
- Archive files and summaries never reach prompts, the digest, insights, audit text or errors; audit entries record only "archived YYYY" and "restored YYYY". Extend test/smoke-leaks.mjs to archive files and the Archive screen.

### Spell check off (owner decision, best practice for a private app)
- Every input and textarea app-wide sets `spellcheck="false"`, `autocorrect="off"` and `autocapitalize="off"` (passphrase fields keep their current settings), so browser enhanced spell check never sends typed text to a remote service. A test fails if any new field misses them.
- Final-review fixes PV-6 (rejection reasons stay on the device; only counts reach the AI) and PV-9 (no weight insight) are confirmed as permanent.

## v1.3.0 addendum: Safe to live in (owner decisions, 17 Nov 2026)
Source: docs/review/product-ops.md items B1, B2, B6, B7, B22, with support for the owner's first real run (B3). Built after v1.2.0 is audited and pushed. Schema change only if a new stored field needs it, with the usual tested migrations and downgrade guards.

### B1 Persistent storage
- On first unlock and on every unlock until granted, call `navigator.storage.persist()` and record the result. Settings shows "Storage: kept by the browser" or "Storage: may be cleared by the browser" with what to do (install, bookmark, back up). Show `navigator.storage.estimate()` usage. Never block the app if the API is missing.

### B2 Backup safety
- Record `lastBackupAt` and `lastSyncAt` (dates only) inside the encrypted state. Dashboard module and Settings show both.
- Reminder: when the last backup or successful sync is older than `settings.backupReminderDays` (default 7, range 1 to 60) or more than 200 saves have happened since, show a non-blocking banner with one-tap Export backup. Snooze for one day. Never automatic.
- "Verify a backup file": choose a file, enter its passphrase, decrypt in memory, show schema, revision, date and per-collection counts, compare with the live vault, and discard. Nothing is written.

### B6 Release engineering
- One version source: package.json; build.mjs injects it into the app, README and the HANDOFF header check; a test fails if any other version string disagrees.
- Tags: add a GitHub Actions workflow that, on push to main, creates tag `v<version>` from package.json if it does not exist (uses the default GITHUB_TOKEN with contents write; no secrets added). Backfill tags v1.0.0, v1.1.0 and v1.2.0 on their commits through the same workflow's manual trigger.
- docs/CHANGELOG.md from v0.1.0 to now, newest first, one line per change.
- docs/RUNBOOK.md: how the live copy deploys (Cloudflare builds from main), how to roll back (redeploy an earlier commit in Cloudflare), the schema rule (an older app refuses a newer vault, so roll back the code only to a version with the same schema, or restore a backup made on that version first), how to verify a release (version in Settings, header check), and what to do if the vault will not open. Do NOT add a wrangler or Worker config file: deployment is configured in the Cloudflare dashboard and a config file could change it; document the settings to record instead.
- test/smokes.mjs gets a per-script timeout (default 420 s) and reports slow scripts; investigate and fix why smoke-command takes about 287 s.

### B7 Local diagnostics (codes only)
- A capped ring of the last 200 diagnostics `{at, code, area}` inside the encrypted state. Codes are fixed constants (for example SYNC_409, DECRYPT_FAIL, STORAGE_QUOTA, CSV_REJECT, AI_TIMEOUT); no message text, no values, no ids, no names. Uncaught errors map to a code by area, never to their message.
- Settings: "Copy diagnostics" copies the codes, app version, schema and browser family only. "Clear diagnostics". Leak smoke must prove no marker string can reach the diagnostics ring or the copied text.

### B22 Drive setup and sync habits
- docs/SYNC-SETUP.md gains a Cloudflare Access section: add the live origin and redirect URI, confirm the redirect lands back after an Access session, and what to do if Access intercepts it.
- Optional "Remind me to sync" on lock and on tab hide when there are unsynced changes (one-line notice, never automatic).

### B3 support: first real run and live header check
- scripts/check-live.mjs: fetches the live URL with a Cloudflare Access service token read from the environment variables CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (never stored in the repo, never logged), and compares the response headers with `_headers` and the built CSP. Prints pass or each mismatch. The owner runs it; tests cover it with a mocked fetch.
- docs/FIRST-RUN.md: a checklist for the owner's first real run on phone and PC (persist check, backup and verify on a second device, one Drive sync each way, one real AI call in manual and API modes, the header check), with a place to note results.

## v1.4.0 addendum: Phone first (owner decisions, 18 Nov 2026)
Source: docs/review/product-ops.md items B5, B8, B9, B10, B19, B20. Schema change only if a new stored field needs it, with tested migrations and downgrade guards.

### B5 Phone navigation
- Bottom bar on narrow screens (under 820 px): Home (dashboard), Money, Work, Health, More. Labels at least 14 px, touch targets at least 44 by 44 px, the current area marked for sight and for screen readers (aria-current).
- More opens a sheet listing every other area (Assets, Command center, Business, Goals, Home and property, Admin, Learning, Activities, Social, Private vault, Wellbeing, Review, Settings), each one tap. Every area is reachable in two taps from anywhere.
- History: each view change pushes a history entry holding only the view name (never data, ids or names); the back button moves within the app; dialogs close on back. Back from the dashboard behaves as the browser normally does. Locking clears the in-app history so back cannot reveal a view after lock. Nothing in the URL beyond a view name; a reload always returns to the lock screen.

### B8 Install the hosted copy as an app
- Add a web app manifest (name LifeOS, short name LifeOS, start_url and scope under the live path, display standalone, theme and background colours from the app, PNG icons at 192 and 512 px and a maskable icon, generated in the repo, no external assets).
- Add a service worker (one separate file, built by build.mjs) that caches only the app shell (the built HTML, the manifest and the icons) for offline use. It never caches or intercepts requests to the AI provider, Google, or anything off-origin; it never caches a non-200 response, a redirect, or any response that is not the app shell (so a Cloudflare Access sign-in page can never be cached as the app). Strategy: network first for the shell with the cache as the offline fallback; a new shell version shows a "New version ready, reload" prompt (never an automatic reload while unlocked).
- Registration only on https origins; the file:// copy keeps working without it. CSP and `_headers` add exactly `manifest-src 'self'` and `worker-src 'self'`; the service worker file gets its own strict headers. User data stays only in the encrypted IndexedDB vault, never in the service worker cache.
- docs/RUNBOOK.md and the knowledge guide gain install steps for iPhone (Safari, Share, Add to Home Screen) and Android (Chrome, Install app), and how updates arrive.

### B9 First-run setup and second device
- Lock screen offers three paths: Create a new vault; Restore from a backup file (pick file, passphrase, verify counts, then become the live vault); Use my Google Drive copy (connect, download, unlock with the same passphrase). No throwaway vault is ever needed.
- After a new vault is created, a dismissible Setup checklist on the dashboard: set currency and targets, add accounts, add lines of work, set the 2026 tax profile, connect Drive or export a first backup, confirm storage is kept. Items tick themselves from real state, never from a tap alone.

### B10 Dashboard defaults
- On narrow screens, modules with no data collapse to a one-line empty state; business and tax modules stay hidden until a tax profile exists, then appear (the user can still hide them). The user's saved layout always wins over defaults.

### B19 Accessibility
- Every interactive element has an accessible name; touch targets at least 44 px; visible focus; dialogs trap focus and return it; every chart has a text alternative (summary of its values); colour is never the only signal; contrast meets WCAG AA in light and dark. An automated check in a smoke (axe-like rules implemented in the test, no new dependency) fails on missing names, missing labels and targets under 44 px in the bottom bar and More sheet.

### B20 Browser coverage
- Run the core smokes (smoke, smoke-money, smoke-priv, smoke-leaks, smoke-safety and the new phone smoke) on Playwright WebKit and Firefox as well as Chrome. If those browsers cannot be installed in the build environment, say so plainly, keep the scripts ready, and note it in HANDOFF; never report them as passed.

## v1.5.0 addendum: Weekly loop (19 Nov 2026)
Source: docs/review/product-ops.md items B11, B12, B13, B17. The owner said "continue" without answering three questions, so the orchestrator applied its stated recommendations; each is reversible in a later build. Schema 17 with tested migrations from 1 to 16 and downgrade guards.

### B11 Review prompts and consolidation offers
- Track `lastReviewAt` (date). When 7 or more days have passed, the dashboard shows a "Weekly review due" card and the lock screen after unlock shows a one-line notice; one tap opens the review. Never automatic.
- On the first review after a month or quarter ends, offer (never automatic) to consolidate that period's approved insights into a monthly or quarterly memory entry, showing what would be merged. Show a review streak (consecutive weeks reviewed).

### B12 Continual learning (decision: reason categories may reach the AI, typed text never)
- Rejecting an insight asks for one reason category from a fixed list: wrong number, not relevant, already known, too vague, other. Typed reasons stay optional and on the device only (PV-6 stands).
- The AI prompt may include counts of rejections per category per area over the last 12 weeks, numbers only.
- Rules learn: when the same insight kind in the same area is rejected 3 times within 8 weeks, rules stop proposing it and the Memory screen lists it as muted with a one-tap unmute. Muting is shown, never silent.
- Insights may propose a numeric target change (workouts per week, study minutes, savings rate, contact days, backup reminder days) within the existing validated ranges. Approving shows before and after and applies it in one commit only on the user's tap; AI-proposed values outside the range are rejected.

### B13 Real AI runs (decision: LAN model host deferred to v2.0.0)
- docs/AI-SETUP.md: Anthropic API key setup with a spend limit and the model setting, manual mode with Claude (copy prompt, paste reply), and a local model on the same machine (Ollama, including allowing the live origin through its allowed-origins setting). Add a "Test connection" button that sends a fixed prompt containing no user data and reports success or a coded error (B7 codes).
- A model host elsewhere on the home network is deferred to v2.0.0 with NAS sync: the hosted copy is https, so browsers block plain-http LAN calls as mixed content, and the fixed Content Security Policy cannot list a user-entered address without loosening it. The NAS build will add an https host with a fixed name.

### B17 Calendar file (decision: generic labels by default, real titles optional)
- Export an .ics file of dated items in the next 12 months: renewals, maintenance, estimated tax payments, invoice due dates, goal due dates, exams and certification expiries, planned activities, and important dates. Default titles are generic by kind ("LifeOS: renewal due", "LifeOS: tax payment due"), with no names, amounts, places or notes. An "Include real titles" tick, off by default, shows a plain warning that the file is unencrypted and the calendar provider will see the titles.
- Private-vault items are excluded unless the vault is open and the user ticks "Include private items". Download only, no network, no subscription feed. Stable event UIDs so re-importing updates rather than duplicates.

### Privacy
- No new free text reaches prompts; leak smoke covers reason categories, muted kinds, target proposals and the calendar file in both label modes.

## v1.6.0 addendum: Job search tab and search across everything (19 Nov 2026)
Source: docs/review/product-ops.md B14 and B18, with the job search scope the owner approved on 17 Nov 2026 ("the Work pipeline's job items with stages, contacts from Social and follow-up dates"). Schema 18 with tested migrations from 1 to 17 and downgrade guards. Also fix the root cause of the test/smoke-home-admin.mjs flake (about 1 run in 3), never by loosening its checks.

### B14 Command center: Job search tab
- Built on existing data: pipeline items of kind `job` are the applications. They gain optional fields: role title, company (an org name, already present), location type (remote, hybrid, on site), compensation target and offer in integer cents (OTE and base as separate optional numbers), source (referral, recruiter, job board, direct, network), applied date, resume version label (free text, 60 characters, for matching against the separate Resume Engine app; no integration), next follow-up date, and outcome reason when lost (fixed list: no response, rejected, withdrew, role closed, other).
- Stages stay the existing pipeline stages. The tab shows a board on desktop and a stage-grouped list on phones, one-tap stage moves, and a weekly view with outreach and follow-ups done, applications submitted, people contacted (from Social contacts linked to job items) and source of each lead, matching the weekly view the owner asked for in the Resume Engine plan.
- People link to job items through the existing pipeline links (v0.10.0); the item shows each person's last contact and offers "log contact" in one tap. Follow-ups due appear in the weekly review and at a glance (as a new provider) and in the calendar file (generic label "LifeOS: follow-up due" by default).
- Funnel numbers: count per stage now and per month, response rate (contacted or later divided by applied), interview rate, offer rate; "no data" where a denominator is zero. Numbers only, no advice wording.
- The digest gains numbers only: applications this week, follow-ups due, interviews scheduled, offers. Company names, role titles, people, compensation and notes never reach prompts, digest, insights, audit, errors or URL. Compensation is excluded from the AI entirely. Private-vault rules apply to job items and their links.
- CSV import for job items reusing the ledger import pattern (mapping, preview, importKey dedupe, unknown values offered not created), so the owner's existing tracker spreadsheets can be brought in.

### B18 Search across all areas
- One search box (in the More sheet and the desktop header) over titles, names, notes and facts in every collection of the main state; private-vault records only while the vault is open, and Wellbeing notes only while open. Plain case- and accent-insensitive substring matching, never a RegExp from user input. Results grouped by area, each one tap to the record. Fast at the caps (index built in memory on unlock, dropped on lock and on private-vault close, never persisted, never sent anywhere). Typing in search never writes to history or the URL.

### Amendment (v1.6.0 audit, 19 Nov 2026): job numbers, followedUpOn and the review step
The addendum left the rates ambiguous; the builder's definitions are kept and recorded here as the contract (SEC-113). One definition serves the tab, the weekly review and the digest.
- Applied: a job item with an applied date, or at the stage applied, interview, offer or won. A job moved or added at applied or later (on the Job search tab or the Work board) gets today as its applied date if it has none (SEC-111).
- Response rate: applied items now at contacted, interview, offer or won, or lost with the reason "rejected" (a rejection is a response), divided by applied items. Interview rate: applied items now at interview, offer or won, divided by applied items. Offer rate: applied items now at offer or won, divided by applied items. Rates are current-stage counts, so an item lost after an interview no longer counts as interviewed. Each rate is "no data" (null) when no item is applied, also per month; never 0 and never NaN. Months group items by applied date, else by last update.
- Weekly view (Monday to Sunday): applications submitted (applied date in the week), follow-ups done (`followedUpOn` in the week), outreach (contacts logged in the week with people linked to any job item), people contacted (distinct people among them), sources of the week's applications, follow-ups due by the end of the week (open items with a follow-up date on or before Sunday, overdue included), interviews (items now at interview) and offers (items now at offer).
- The digest's four numbers are exactly the weekly view's applications, follow-ups due by the end of the week, interviews and offers, from the main state only (never private items, even while the private vault is open). The Job search screen labels its two follow-up numbers "Follow-ups due today" (today or overdue) and "Follow-ups due by the end of the week" (SEC-112).
- `followedUpOn` (optional, YYYY-MM-DD, job items only, schema 18): the date the owner last tapped "Followed up". Validated as a date; older formats never carry it; the downgrade guard names it with the other "job search details".
- Weekly review: a "Job search follow-ups" step without a number, shown only when job items exist (so the numbered steps keep their numbers), listing follow-ups due by the end of the week with a one-tap "Followed up" and the week's applications, follow-ups done and contacts logged.
- Import: a rejected row's reason never quotes a cell (SEC-110); unknown values are listed separately for mapping.

## v1.7.0 addendum: Command center for AYiN and media (19 Nov 2026)
Source: docs/review/product-ops.md B15 and B16, with the scope the owner approved on 17 Nov 2026 and his podcast decisions on 19 Nov 2026. Schema 19 with tested migrations from 1 to 18 and downgrade guards that name the new details. Manual entry first: nothing about the owner's businesses, shows or sites is seeded in code; only generic platform names are offered as defaults. Reuse existing data (business records, revenue lines, invoices, Social people and links, Admin renewals, calendar file, glance providers, search index) instead of duplicating it.

### B15 Command center: AYiN Advisors and clients tab
- A rollup of the business's lines of work (the existing revenue lines): revenue this month, quarter and year, invoices open and overdue, budget vs actual where a budget is set, and the tax set-aside figure the Business tab already computes, shown with its existing estimate wording. Numbers come from the existing records; nothing is re-entered.
- Clients: a client record (name, status active, paused or past, optional line of work, notes) links to Social people as contacts, to projects (existing pipeline or project items), to invoices (existing business invoices gain an optional client link) and to an optional budget in integer cents. Each client shows revenue to date, open and overdue invoices, budget vs actual, and last contact (the latest logged contact with any linked person). One-tap "log contact" follows the SEC-57/58 name rules.
- Clients with an overdue invoice or no contact in a user-set number of days (default 30) appear at a glance and in the weekly review, numbers and generic labels only.

### B16 Podcasts tab
- Shows: the owner adds each show (name, website link to a Websites tab site, optional line of work for revenue and costs). Each show has its own platform list. Defaults offered when a show is created: YouTube, Spotify, Apple Podcasts, YouTube Podcasts and the show's website; the owner can rename, remove or add platforms.
- Episodes: title, number, status (idea, booked, recorded, edited, published), record date, guests (Social people), notes, and per format (video, audio, text) a publish date per platform. Guests show the episode on their Social record.
- Platform numbers, per platform: the owner types a number with a date, a platform and a measure (views, downloads, listens, reads, subscribers or followers), optionally tied to one episode. The tab shows each platform's latest and monthly totals and each episode's numbers by platform. Numbers are never summed across different measures and never estimated; a missing month is shown as no data, not 0. Cadence: episodes published per month and the gap since the last one.
- Costs and revenue come from the show's line of work (existing business expenses and revenue), so ROI follows the existing rule: costs count once paid.

### B16 Websites tab
- Each site: domain, purpose (business, show, personal, other), optional line of work and show link, hosting provider name, and domain and hosting renewal dates and costs that create or link Admin renewals (so they reach at a glance and the calendar file with the existing generic labels). Monthly traffic is typed in per site (visits and optionally visitors), shown by month with no data for gaps.

### Shared rules
- Placement: Podcasts and Websites join the More sheet; the AYiN and clients tab sits beside Business. Search covers clients, shows, episodes and sites.
- AI and privacy: client names, people, show and episode titles, platform names, domains, notes and money per client never reach prompts, digest, insights, audit, errors or the URL. The digest gains numbers only: clients with overdue invoices, episodes published this month, sites with a renewal in the next 30 days. Private-vault rules apply to every new record and link; totals that skip locked private records show the lock marker. Wellbeing is untouched.
- Imports: none in this release.
- All new inputs follow the spell check rule; integer cents for money; no advice wording; no em dashes; mobile layout holds at 390 px.


## Amendment (v1.7.0 build)
Where the addendum was ambiguous the safer reading was taken.
- Client revenue: income on the client's line of work when one is set, else paid invoices linked to the client. A client budget "actual" is counted expenses on that line; with no line it reads "no data".
- No-contact flag: days since the latest contact with any linked person, measured from the client's created date when never contacted; only active clients are flagged. The limit is `settings.clients.contactDays` (default 30, 1 to 3650).
- At a glance and the weekly review show counts with generic labels ("Clients with an overdue invoice: N"); the glance provider registers when the app starts. The digest gains `media: {clientsOverdue, episodesThisMonth, sitesRenewing}` and nothing else. Diagnostics areas reuse 'business', so no ops codes change.
- Platform monthly totals: flow measures add within a month, preferring platform-level numbers over episode-tied ones (no double count); point measures (subscribers, followers) show the latest of the month; a month with nothing typed is null ("no data"). Cadence months before the first published episode are "no data".
- Sites are stored as `hostname` and `kind` (search skips the field names domain and purpose); the forms still say domain and purpose. Site renewals are created in Admin with generic titles ("Domain renewal", "Hosting renewal"), so a domain never reaches the calendar file; updating the site form updates the linked renewal date and amount. Deleting a site leaves its renewals; deleting a show deletes its episodes and numbers.
- Private moves are mandatory together: a show with its episodes and numbers, an episode with its numbers, a site with its traffic; an invoice's client link and a show's site link are dropped while the target is private and return with it.
- Search indexes each record's text, including the platform names inside a show (found under that show; corrected by the audit, SEC-125). Placement: desktop navigation gains "AYiN and clients"; Podcasts and Websites are in the More sheet and reached by buttons on the Business and AYiN screens.

## Amendment (v1.7.0 audit, 21 Nov 2026)
The builder's amendment is kept, with these corrections and definitions (docs/SECURITY.md "v1.7.0 audit").
- Site renewals (SEC-117, SEC-118): each site renewal is its own Admin chain. Titles stay generic and never hold a domain: the first free of "Domain renewal", "Domain renewal 2", "Domain renewal 3" and so on (the same for "Hosting renewal"), counted over the renewals in the vault with the same kind and provider. When Admin confirms the next renewal of a completed one, a site linked to the completed one is linked to the new one, so the site form edits the open renewal and the numbers follow it.
- Digest windows: the three numbers use the end of the week, like the job numbers: clients with an overdue invoice as of the end of the week, episodes published in the month of the end of the week, and sites with an open renewal due on or before 30 days after the end of the week (an overdue open renewal counts).
- Search (SEC-125): the builder's note that platform names are not searched was wrong; the index takes each record's text, so platform names are found under their show, with the v1.6.0 lifetime rules (private ones only while the vault is open, dropped on close and lock, never persisted, never a pattern).
- Platform latest (SEC-123): the latest number shown for a platform and measure is the latest platform-level number when any exists, else the latest episode number, matching the monthly preference.
- Client revenue from paid invoices (SEC-124): once any year is archived, archived paid invoices are no longer live, so the figure carries the "archived years only in part" note.
- Moves out (SEC-121): an episode or a platform number cannot move out alone while its show stays private, nor a traffic month while its site does; the app says "Move the show out instead" (or the site), and moving the parent out takes them with it. The move dialog for a show, an episode or a site says what always moves with it.
- Forms keep what is already chosen (SEC-119, SEC-120): a line of work stays in the form's list even when archived (marked "(archived)"), and an episode's chosen guests are always listed in the guest picker (up to 200 other people are offered), so saving a form never drops a link unasked.

## v1.8.0 addendum: Passphrase recovery (owner decisions, 21 Nov 2026)
Source: docs/review/product-ops.md B21. Owner decisions: both a printable recovery guide and an optional recovery key; one recovery key opens the main vault and a separate recovery key opens the private vault; each key can be replaced in Settings. This changes the encryption layout, so it gets a dedicated crypto audit (docs/review/crypto.md is the baseline). WebCrypto only, no new dependencies.

### Key layout (envelope v2)
- Each vault (main and private) gets a random 256-bit AES-GCM data key, non-extractable once unwrapped. The data key encrypts the state exactly as today (fresh 12-byte IV per write). It is stored only wrapped (AES-KW or AES-GCM wrap, fresh salt and IV per wrap) under one or two key-encryption keys: one from the passphrase (PBKDF2-HMAC-SHA256, 600,000 iterations, 16-byte salt, as today) and, when the owner turns it on, one from the recovery key (same KDF and parameters, its own salt).
- Envelope v2 holds the ciphertext and a list of wraps, each with its kind (passphrase or recovery), KDF parameters and wrapped key; strict parsing (unknown fields refused, at most one wrap per kind, sizes checked). v1 envelopes still open with the passphrase and are rewritten as v2 on the next save. An older app shown a v2 envelope refuses it with a clear "made by a newer LifeOS" message, never a crash or a silent overwrite.
- Everything sealed today under the passphrase key carries the same wraps: the stored vault, backup files, Drive copies, archive files and the private vault's archive boxes, so a recovery key opens every copy made while it was in force. Drive sync conflict rules keep their meaning (a passphrase or key change on one device is still detected as a local change).

### Recovery key
- Off by default; offered in Settings and on the setup checklist, separately for the main vault and (while it exists) the private vault. Turning one on asks for that vault's passphrase.
- The key is 256 random bits shown once as grouped base32 text with a short checksum so typos are caught before any decryption; the owner must retype it (or its last two groups) before it is enabled. It is never stored, logged, synced, put in diagnostics, history, the URL, the clipboard automatically, or anywhere the AI can reach.
- Forgot passphrase: the lock screen (and the private vault unlock) offers "Use recovery key". After a successful unlock the owner must set a new passphrase, and the app rotates the data key and issues a new recovery key for that vault (the used one stops working), because a used key may have been seen.
- Replace key (Settings, asks for the passphrase): rotates the data key, re-encrypts, and wraps it under the passphrase and a new recovery key; the old key stops working for the current vault. Turn off: asks for the passphrase and removes the recovery wrap.
- Passphrase change: rotates the data key; the owner either types the current recovery key to keep it or gets a new one. With no recovery key on, behaviour is as today.
- The app says plainly, at enable, replace and turn off: backup files, Drive copies and archive files made earlier still open with the key or passphrase that was in force when they were made; export a fresh backup and delete old ones if a key was exposed.
- Wrong recovery keys count toward the same unlock attempt delays as wrong passphrases.

### Printable recovery guide
- docs/RECOVERY.md and an in-app print view (Settings, "Recovery sheet") explaining what each key opens, how to store it (paper, offline, never a photo or cloud note), what to do if a key or the passphrase is lost or exposed, and that losing both the passphrase and the recovery key means the data cannot be recovered by anyone.
- The sheet prints without the key by default, with boxes to write it by hand; including the key on the printout is an explicit choice with a warning that printers and print queues may keep copies.

### Rules
- Schema 20 only if state changes (for example a recovery-on flag or date per vault), with tested migrations from 1 to 19 and downgrade guards; the envelope version is separate from the schema.
- Tests prove: each kind of copy opens with the passphrase and, when on, with the recovery key; replaced or turned-off keys no longer open the current vault; the private recovery key never opens the main vault and the main key never opens the private vault; v1 to v2 upgrade on save; older-app refusal; tampered wraps and envelopes fail closed; no key material in any output, error or diagnostic; attempt delays apply.
- Spell check rules (recovery key fields like passphrase fields), no advice wording, no em dashes, 390 px layout.

### Owner decisions (21 Nov 2026, later the same day)
- The setup checklist prompts for the main vault recovery key at first run (a clear step with "Turn on now" and "Later"; "Later" keeps it on the checklist until done or dismissed), and prompts for the private recovery key when the private vault is first created.
- A getting started guide for first-time setup: docs/GETTING-STARTED.md plus an in-app "Getting started" view reachable from the setup checklist and Settings. It walks through, in order: choosing a passphrase, turning on the recovery key and filling in the recovery sheet, persistent storage and the first backup, installing on phone and PC, Drive sync setup, the private vault, bring-your-own-AI setup (or none), entering the first records per area (manual entry first, CSV imports where they exist), and the weekly review. Plain steps, no advice wording; it links to the existing docs (FIRST-RUN.md, SYNC-SETUP.md, AI-SETUP.md, RECOVERY.md) rather than repeating them.

## Amendment (v1.8.0 build)
Where the addendum was ambiguous the safer reading was taken.
1. Layout: the main file stays `v:1` and adds `fmt:2`, `wraps` and `data`. Its `kdf`/`iv`/`ct` shell holds a stub `{schema:20,newerFormat:true}` sealed under the passphrase key, so a v1.7.0 app opens it and refuses it with its newer-version message. The private blob is `v:2`; v1 blobs still open.
2. A wrap is AES-GCM wrapKey (raw) of the data key under the key-encryption key, with AAD "lifeos-wrap-v2:" plus the kind. Where a caller-supplied key lacks wrap usages (tests that replace deriveKey) the raw bytes are encrypted and zeroed instead.
3. Every wrap-set change (turn on, replace, turn off, use, passphrase change, v1 upgrade) makes a new data key and fresh salts.
4. Backups and archive files get a fresh data key under their own passphrase (the data key cannot be exported). They carry the recovery wrap only when the owner types the current key at export; it is checked against the vault's wrap, never stored, and required while a key is on.
5. Drive copies are the stored envelope as it is.
6. A restored backup starts with no main recovery key.
7. No schema 20: whether a key is on is read from the wraps. Schema stays 19.
8. The main lock screen gained the same attempt delays as the private one (1 s doubling to 30 s), shared by wrong passphrases and wrong recovery keys.
9. The stub shell is checked only when a passphrase opens the file.
10. The recovery sheet includes a key only when the owner ticks a box right after the key is shown.
11. A passphrase change with a key on needs the current key (kept) or a new one (shown and retyped); otherwise error RECOVERY_CHOICE.
12. The retype accepts the whole key or its last two groups.
13. The setup checklist shows the main key as a prompt row ("Turn on now", "Later"), not a counted item. "Later" is not saved; the row returns after a reload until the key is on or the checklist is dismissed.
14. A Drive copy at the sync prompt opens with the passphrase only.
15. Changing a private key closes the private vault; the owner opens it again.
16. The private vault's creation prompt holds the new passphrase in memory only until the dialog closes.
17. The Getting started view is a print-kind view (`kind: 'guide'`), so navigation names are unchanged. It names the docs by file name and has no links.

## Amendment (v1.8.0 audit)
1. A v1 file upgraded to v2 under the same passphrase keeps its sync meaning: the sync record's key salt moves to the new passphrase wrap salt, so the upgrade alone is never a local key change (SEC-127).
2. The recovery key a copy carries can be used in the app: the lock-screen restore has a box to open a backup with the main recovery key (the restored vault gets a new passphrase and no recovery key), and the archive Open and Restore dialogs take the main recovery key a file carries; Restore still needs the current main passphrase. A wrong key on the restore path counts toward the main delays (SEC-128).
3. After "Use recovery key" on the lock screen, the decrypted copy waits at most 5 minutes for the new passphrase; Back, Cancel and the limit empty it (SEC-129).
4. A passphrase change with a recovery key on checks the current passphrase before a new key is shown (SEC-130).
5. A key included on the recovery sheet is dropped as soon as another screen is drawn (SEC-131).

## v2.0.0 addendum: NAS (owner decisions, 22 Nov 2026)
Source: docs/review/product-ops.md B23, B13 (LAN host), B24, B26. Owner decisions: the NAS runs TrueNAS; he reaches home over Tailscale when away; LifeOS moves to a subdomain of tazabbas.com; local AI runs the smallest practical model on the NAS and a stronger model on his primary PC (RTX 5070); Google Drive stays as the second, backup copy. Full security audit, focused on the new transport, the sync service and the CSP change.

### Network and names (one config file, not secrets)
- All names live in one build-time file (config/hosts.json) read by build.mjs into the CSP; changing a name is a config change plus a rebuild. Defaults: app `lifeos.tazabbas.com` (Cloudflare Worker behind Access, as today), sync `sync.lifeos.tazabbas.com` and small model `ai-nas.lifeos.tazabbas.com` (both on the NAS), stronger model `ai-pc.lifeos.tazabbas.com` (the PC).
- The three home names resolve in Cloudflare DNS (DNS only, never proxied) to Tailscale addresses, so they answer only on his tailnet, at home and away. TLS by Caddy on the NAS and on the PC with a Let's Encrypt certificate through the Cloudflare DNS challenge; the Cloudflare API token for that lives only on those machines, never in the repo, the app or chat. No ports opened on the router.
- CSP connect-src gains exactly those three https origins, nothing user-entered. Each home service allows CORS only from the app origin.
- Moving the app to the new origin moves browser storage: the guide covers carrying the vault across by backup and restore or by a Drive sync, and Drive's OAuth client gains the new origin. The workers.dev address keeps working until he retires it.

### NAS sync service (B23)
- A small service in this repo (Node built-ins only, no dependencies), shipped as a container for a TrueNAS custom app with a compose file and a setup guide. It stores only ciphertext envelopes (main vault and archive files) on a dataset he picks; it never receives a passphrase, recovery key or plaintext.
- API: get the current envelope and its revision; put with the expected revision (compare-and-swap; a mismatch returns the current revision and the app shows the existing conflict dialog); list, put and get archive files; keep the last 30 envelope versions and offer a restore of one. Size caps match the app's; strict validation; constant-time token check; rate limits; logs hold codes and sizes only, never content.
- Auth on top of the tailnet: a long random sync token per device, created in Settings, kept inside the encrypted vault (never in plain browser storage), registered on the service by its hash; revocable per device.
- In the app: NAS becomes the primary sync target with Drive as the second copy. Sync now writes to the NAS first, then Drive; status shows both; archiving's verified-copy rule accepts a NAS copy re-downloaded and decrypted. Sync stays manual (no background sync), conflict rules unchanged.

### Local AI hosts (B13)
- Ollama on the NAS for the smallest practical model and on the PC for a stronger one, each behind Caddy at its fixed name, with Ollama's allowed origins set to the app origin only. The setup guide names the models after a check of current options at build time; no model is bundled.
- In AI settings: choose NAS model, PC model, Anthropic, manual or none; an optional fallback (for example PC, then NAS when the PC is off). The numbers-only boundary is unchanged for every provider; Test connection works for each.

### Only if needed
- B24 faster saves (per-area encryption) only if saves stay slow at his real data size after the first real run.
- B26 custom domain is covered by the move above.

### Rules
- Schema bump only if state changes (sync targets, device tokens, AI host choice), with migrations from 1 and downgrade guards. Tests prove: compare-and-swap and conflicts, version history and restore, token checks and revocation, no plaintext or key material ever sent to or stored by the service, CORS limited to the app origin, CSP lists only the configured names, AI boundary unchanged for the new hosts, archive copies verified from the NAS. The service gets its own unit tests and a smoke that runs it locally in the build workspace.

### Owner confirmation (22 Nov 2026)
- Tailscale runs on his phone, laptop and desktop and will run on the NAS; the home names are reached only with Tailscale connected, and the app says so plainly when a home host cannot be reached ("Connect Tailscale and try again"), never a raw network error. Build now, before the NAS rebuild: the service is tested locally in the build workspace; the TrueNAS install is a guide he follows later.

## Amendment (v2.0.0 build)
Where the addendum was ambiguous the safer reading was taken.
1. Config: `config/hosts.json` holds `app`, `sync`, `ai-nas` and `ai-pc` (plain lowercase host names, validated; scheme, port, path, wildcard, duplicates and unknown keys fail the build). build.mjs adds exactly `https://` plus the sync, ai-nas and ai-pc names to connect-src, after Google and before the localhost entries, and injects `LifeOS.HOSTS`. `app` is not in the policy (the page is its own origin); it documents the service's CORS setting. A missing file adds nothing. The workers.dev copy is the same built file, so it keeps working; its origin must be added to the service's `appOrigins` while it is in use.
2. Two revisions: the service numbers every stored copy with its own revision (`srev`, the `X-Rev` header and `X-Expected-Rev`) so compare-and-swap and restore work without decrypting. The envelope's own `rev` stays the app's rollback and tamper check. The first write expects `none`.
3. Restore on the service makes the chosen old copy current under a new `srev`; the envelope is untouched. The app does not call it: a restored copy is older than the last sync, so the app refuses it as a rollback. The app's "NAS history" saves a version as a file, restored through the existing restore from a backup file.
4. Tokens: created in the browser (`lfs_` plus 43 URL-safe characters), kept only inside the encrypted state (`settings.nas.token`), registered on the service by SHA-256 hash. The app never displays the token (it shows the registration line with the hash). A token made by the service's `token add` can be pasted once. Changing a token keeps the NAS bookkeeping (what this device last synced).
5. A sealed copy (NAS, Drive, backup) carries the token inside the ciphertext like any setting, but a copy that is adopted, restored or installed never replaces this device's `settings.nas` (a new vault from a backup or Drive copy starts with none). The sync fingerprint ignores `settings.nas`.
6. Sync now in the NAS card writes the NAS first, then Drive when connected (its status is mirrored under the NAS status); the Drive card keeps its own button for Drive alone. There is no sync prompt at unlock for the NAS (manual only). Setting up a brand new device straight from the NAS on the lock screen is not built (the token lives inside the vault); use a backup or Drive.
7. A failed or unreachable NAS does not stop the Drive step. Home names that cannot be reached give "Cannot reach the NAS. Connect Tailscale and try again." (AI: "Could not reach the NAS model. Connect Tailscale and try again.") with fixed codes (SYNC_NAS_UNREACHABLE, SYNC_NAS_AUTH, AI_NETWORK).
8. Schema 20: `settings.nas` (token, tokenAt, remoteRev, srev, fp, keySalt), `settings.aiHosts` (nasModel, pcModel, fallback), provider kinds `nas` and `pc` (address and key never kept), archive copy kind `nas`. Migrations from 1 to 19 give empty values. An older backup restored here keeps this device's `nas` and, below schema 20, its `aiHosts`. The v1.8.0 envelope stub keeps schema number 20 (files already written); apps up to v1.7.0 refuse it as newer, and this build never takes it for a vault.
9. AI hosts: the model of each home host is in `settings.aiHosts`; `provider.model` mirrors the active one. The fallback applies to any provider except none and manual, only when the first call could not reach its host or timed out (never after any reply), never to the same host, and only with that host's model name set. Home hosts get a 90 second limit. Test connection tests exactly the chosen host with the fixed message and never falls back.
10. Archive copies: a NAS copy is written, downloaded again, decrypted and matched like a Drive copy and is recorded as `nas`. If another copy is verified, a failed NAS copy does not stop the archive; with no other copy it does.
11. Service: strict outer-field validation (known envelope keys only, base64 strings, integer `rev` for the vault, `arch` 1 and a matching `year` for archive files), rebuilt before storing; vault copies kept as files named by `srev`, envelope revision and time, written by temp file, sync and rename; CORS from a configured list of origins (default one); rate limits (general, failed tokens, writes) per client, using X-Forwarded-For only when `trustProxy` is on; logs hold the method, a fixed route label, status and byte counts only. Tokens are checked by hash against every stored hash with `timingSafeEqual`; revocation is read from the file on the next request.
12. Test hooks `nas._setBase` and `ai._setHosts` accept only localhost addresses and a fixed-name table; nothing in the UI reaches them.

## Amendment (v2.0.0 audit)
1. After ROLLBACK on the NAS (its copy is older than the last sync, for example after a restore on the service or a snapshot rollback), the owner may choose "Replace the NAS copy": the NAS copy is checked again, never adopted, saved to a file first, and replaced by this device's copy with compare-and-swap on the service revision just read (SEC-134). The Drive step of Sync now starts only after a NAS dialog has closed.
2. The service reads at most `maxUploads` bodies at a time (default 2), answers 503 BUSY beyond that, and with `trustProxy` keys rate limits on the last X-Forwarded-For entry (SEC-136, SEC-137).

## v2.1.0 addendum: Eating (owner request, 24 Nov 2026)
The owner asked for one place for activity, exercise and eating on phone and PC, and chose to add eating to Health rather than build another app. The owner's own framing: fixed portions instead of counting macros, a daily protein target the owner sets, eggs as the usual breakfast, a base batch-cooked once or twice a week and finished fresh, little time to cook, and the real question being whether a meal was eaten for health or for fullness. Schema 21 with tested migrations from 1 to 20 and the downgrade guards (SEC-27/28) extended to the new data.

### Saved meals (fixed portions)
- `meals:[{id, name, protein, slot}]`, cap 50. `name` 1 to 60 characters (the owner's own words, for example "3 eggs and toast"), `protein` whole grams 0 to 300 for one portion as the owner defines it, `slot` one of breakfast, lunch, dinner, snack, any. Add, edit and delete in a "Saved meals" section. No calories, carbs, fat or food database: one number per meal.
- Deleting a saved meal keeps every logged meal and its protein (history never changes); those log rows read "Removed meal".

### Meal log (one tap)
- `mealLog:[{id, date, protein, mealId?, oneOff?, forHealth?}]`, cap 20000. Logging a saved meal is one tap on its button and copies its protein into the row, so editing a saved meal later never rewrites past days. A "One-off" row (`oneOff:true`, never with a `mealId`) takes a protein number only (eating out, something new); it has no name and no free text.
- `forHealth` is optional true or false: the owner's own answer to "Ate for health?" for that meal, tapped Yes or No on the row. Unanswered rows count in neither direction.
- A day picker (default today) chooses which day the taps log to and which day is shown. Remove deletes one row.

### Protein target
- `settings.food = { proteinTarget? }`: whole grams per day, 1 to 1000, typed by the owner (empty clears). The app never suggests or computes a target and never says whether a number is good or bad; with no target set, target figures read "Set a target".

### Views (Health screen, phone first)
- "Eating" card right after Today: the day's protein total against the target with a bar, saved-meal buttons (breakfast first, then lunch, dinner, snack, any), the One-off form, the day's rows with Yes or No for "Ate for health?" and Remove.
- "Eating this week" (Monday to Sunday, like workouts): average protein per logged day (days with no meal logged are left out, not counted as zero), days at or over the target (x of 7, or "Set a target"), meals logged, and the share of answered meals marked "Ate for health"; a 7-day row of bars. Every figure with no data reads "no data", never zero.
- Search finds saved meal names (Health area).

### Privacy and AI
- Meals and the meal log live only inside the encrypted vault and sync and back up with it like everything else; they stay live when a year is archived. A saved meal can move into the private vault and its log rows follow it (like a daily check and its ticks); a row logged for a private meal is private.
- `weeklyDigest` gains `food:{meals, proteinAvg, proteinDays, forHealthRate}`, numbers only. Owner rule for this build: like body metrics, these numbers are not sent to any AI provider (the prompt line is left out); they stay in the stored review inside the vault. Meal names never reach the digest, a prompt, the audit log, an error message, diagnostics or the calendar file.
- Tracker, not advice: no recommendation, judgement or diagnosis in UI copy; labels state numbers and the owner's own answers only. No em dashes.

## Amendment (v2.1.0 build)
1. A row's kind is explicit: a one-off row carries `oneOff:true` (never with a `mealId`), so a row whose saved meal was deleted (neither field) reads "Removed meal" and a one-off reads "One-off". `oneOff` must be `true` or absent.
2. A logged row whose `mealId` names no saved meal (for example in a file edited by hand) keeps its day and protein and loses only the link, like a deleted meal.
3. The weekly digest stores `food` with "none" as 0, like the other digest blocks; the Health screen shows "no data" instead.
4. The day picked on the Eating card is held in memory only; picking today again, or locking, returns it to today.
5. No meal data in the archive: the meal log stays live when a year is archived (cap 20000 rows, about ten years at five meals a day).

## Amendment (v2.1.0 audit)
1. A logged meal cannot move out of the private vault alone while its saved meal stays private: "Its saved meal is in the private vault. Move the saved meal out instead; it takes this with it." Nothing is written (SEC-140).
2. The day picked on the Eating card is reset on lock (SEC-141).

## Amendment (full review after v2.1.0)
1. `LifeOS.HOSTS` is frozen and read-only in the built page, and the test hook `ai._setHosts` keeps a frozen copy of only `ai-nas` and `ai-pc` (SEC-142). This is how v2.0.0 item 12 is now met.

## v2.2.0 addendum: Learning goals (owner request, 25 Nov 2026)
The owner asked for a learning tab "if it doesn't exist yet" to stay on top of learning goals, whether a certification, a degree, skills or a language. Learning has existed since v0.8.0, so this build extends it rather than adding a second tab. Schema 22 with tested migrations from 1 to 21 and the downgrade guards (SEC-27/28) extended to the new data.

### Kinds
- `kind` gains `degree` and `language`, so the list is course, book, certification, degree, skill, language, project, other. A file written before schema 22 is read with the older six kinds only.
- Certifications, degrees and languages offer an exam date on the add form; only certifications offer an expiry date (the Admin timeline row is unchanged). Any kind can be changed later in Edit.

### Per item (all optional, absent when empty)
- `nextAction`: the next step, one line of up to 200 characters, the owner's own words. The secrets guard (SEC-44/45) applies.
- `nextDate`: the date the owner wants the next step done by.
- `weeklyMinutes`: the owner's own minutes per week for this item, whole minutes 1 to 10080 (0 or empty is none). It sits beside the overall weekly study target and is not added to it.
- A "Next step" button on active, planned and paused items sets the step and its date in one dialog; both blank clears them. Each active row shows this week's minutes on the item, against its own minutes per week when set.
- A file written before schema 22 never carries these fields, even if they are present in it.

### Due in the next 30 days
- Target dates and next-step dates of active and planned items that fall today or in the 29 days after it, plus any such date already past (overdue). Exams keep their own card. Paused, done and dropped items are left out.
- Learning screen: a "Due in the next 30 days" card above the active items, overdue first. Nothing changes until the owner taps it.
- Kind filter: when active items span more than one kind, chips (All and one per kind with its count) filter the active list; the choice is held in memory for the visit only.
- Tile sub line adds "N overdue" and "M due in 30 days" only when they are above zero, so a vault without dates reads as before.
- Weekly review, Learning step: lists the same dates, overdue marked; shown only, nothing is offered or changed.
- At a glance: a "Learning" provider (registered by the app at start) lists target dates, next steps and exams within 30 days; an overdue date shows under today.

### Privacy and AI
- The new fields move with their item into and out of the private vault; with the vault closed, a private item's dates are not shown anywhere. Search finds next steps (Learning area).
- The weekly digest is unchanged: numbers only, no titles, next steps, providers or kinds, and nothing new reaches an AI provider.
- No advice wording; dates and the owner's own numbers only. No em dashes.

## v2.3.0 addendum: Overview and visual refresh (owner request, 25 Nov 2026)
The owner asked for a visual style update and "an overview screen that shows you all the important metrics/cards/tabs that the user has selected for a single pane of glass overview", in a "bright, and modern 2026 design style for a SaaS application". The Dashboard was already a customizable grid (v0.12.0), so it becomes the Overview rather than a second screen. Schema 23 with tested migrations from 1 to 22 and the downgrade guards (SEC-27/28) extended.

### Overview
- The first screen, the first nav item and every "Back to" button are named Overview (the phone bar said Home, which clashed with Home and property). The page header shows the date and a "Choose what shows" button; Customize is renamed Arrange (same behaviour).
- Two new modules lead the default order on both widths: Key numbers and Shortcuts. Both can be moved, hidden and shown like any other module.
- Key numbers: up to 12 picked from 16 (the ten area headline numbers, revenue received and net this month, expected income in the next 30 days, job applications this week, items in the next 30 days, the weekly review streak). Wellbeing has none. Each shows the area, the number, its label and one line of detail; a tap opens its area. A number that cannot be worked out shows a dash and never breaks the screen.
- Shortcuts: up to 12 of the app's areas (every nav item except the Overview itself), one tap each.
- Defaults (until the owner saves a choice): Money, Assets, Revenue, Work, Health, Learning, Goals, Next 30 days; shortcuts Money, Work, Job search, Health, Learning, Goals, Review.
- One picker ("Choose what shows on your Overview", also opened by Edit on either strip): tick and order key numbers (Up and Down buttons, keyboard reachable), show or hide each card for the current screen width, tick shortcuts, and Back to the defaults. Nothing is saved until Save; one commit stores the choices and the layout for that width.

### Data
- `settings.overview = { custom, metrics, shortcuts }`. `custom` false means the defaults apply. Lists hold whitelisted ids only (no free text), repeats and unknown ids are dropped, at most 12 kept, more than 48 in a file is refused.
- From a file before schema 23: `overview` is the default, and a saved layout gets Key numbers and Shortcuts at its top once. In schema 23 nothing is moved again.
- Downgrade guard: a pre-23 copy over a vault with saved Overview choices names "Overview choices" before replacing.

### Look
- Brighter light theme (cool off-white background, white cards, indigo accent with a violet gradient on primary buttons and the brand mark), softer shadows, larger radii, Inter where installed with system fonts as fallback (nothing is downloaded), a frosted top bar and phone bar, pill nav, tinted notices and chips. Dark theme follows the same tokens.
- Text, muted text, accent and status colours keep WCAG AA (4.5:1) on cards and background in both themes (tested). Hover lift and transitions are off under prefers-reduced-motion. The app icons and theme colour follow the new accent.
- No em dashes; no advice wording.

## v2.4.0 addendum: Taxes and assets by country (owner request, 25 Nov 2026)
The owner asked for "a section within taxes and assets that allows me to view by country eg: US and Spain". Defaults chosen in the build where the request left room are marked (default).

### Where it lives
- A "By country" screen, reached from More (right after Assets) and from a "By country" button on Assets (default). Tax checklist items stay in Admin; US estimated payments stay in Business. By country reads both and links to them.
- Chips: All countries, then each country on the list (and any country code a record uses that is no longer on the list, shown by its code). A tax year picker (next year back to four years ago, plus any year with records).
- All countries: a table of assets, owed and net worth per country with an All countries row, and a table of tax paid, owed, refunds, checklist (open of total) and residency per country for the year.
- One country: net worth per currency, its accounts, its tax-year details, its tax amounts with add, edit and delete, the US estimated payments for the home country, and its checklist count with a link to Admin.
- A "Countries and exchange rates" section: the list (code, name, currency; the home country cannot be removed; a country still used cannot be removed), a form to add one, and one rate row per currency in use.

### Data
- `settings.countries = { home, list: [{ code, name, currency }] }`: codes are two capital letters, currencies three, names up to 60 characters; 20 countries at most; the home country must be on the list. Default: United States (USD) and Spain (EUR), home United States (default).
- `settings.fx = [{ currency, rate, asOf }]`: the value of one unit in the vault currency, above 0 and up to 1,000,000, up to six decimals, with the date the owner gives; never the vault currency itself; 20 at most. Nothing is fetched.
- Accounts gain `country` and `currency`; tax checklist items gain `country`.
- `countryTax`: `{ id, country, year, kind: paid | owed | refund, title (1 to 200), amountCents (whole cents, 0 to 10^13), currency, date?, notes (up to 1000) }`, 2000 at most.
- `countryTaxYears`: `{ country, year, residency: unsure | resident | nonresident, days? (0 to 366), filingDue?, note (up to 1000) }`, one per country and year, 400 at most. All fields empty removes it.
- Text that looks like a tax ID or an ID number (the existing SSN and EIN check, plus a Spanish NIE or DNI) is refused in titles, notes and country names.

### Money across currencies
- A balance is in its account's currency. Net worth and every total on Assets and the Overview stay in the vault currency: a balance in another currency is converted only with the owner's rate, exactly (whole cents, integer arithmetic, halves away from zero), and left out of the totals, with a line that says which accounts and currencies, while there is no rate.
- By country shows every amount in its own currency, side by side, and a combined total in the vault currency only when every currency in it has a rate, with the rates used and their dates.
- No tax rules, rates or estimates are added for any country. The tax amounts and the residency are the owner's own entries. "Not tax advice."

### Migration and safety
- Schema 24. From any older schema every account and tax item becomes the home country and the vault currency (US and USD), the list is the default and there are no rates, records or profiles: totals read exactly as before. Fields an older copy cannot hold are dropped, not trusted.
- Downgrade guard: an older copy over a vault with any of the new data names "account countries and currencies", "country tax records", "country tax profiles", "countries on tax checklist items", "exchange rates" and "country list" before replacing.
- Private vault: country tax amounts and tax years can be moved in and out; an account keeps its country and currency through a move. The screen shows the lock mark when private items are hidden.
- Search: a By country area for tax amount titles and notes and tax-year notes. Codes, currencies and residency are not indexed. Nothing new reaches the weekly digest, an AI prompt, the audit log, diagnostics (counts only) or a URL.

## Addendum: shared design language v1.1 (owner request, 25 Nov 2026)

Owner: "I want the look, feel and flow of all the projects we are working on - Resume Engine, ChannelVu and LifeOS Dashboard to share a design language", with tazabbas.com and ayinadvisors.com as references and "not too cluttered"; then "keep gold buttons", "offer a toggle for dark/light mode". The spec is docs/DESIGN.md. This replaces the v2.3.0 "Look" section; the Overview, its data and every other screen are unchanged.

- Colours: navy band (#0d2742) for the top bar and the Overview welcome band, warm white page, white cards, gold (#c6a15c, #ddbd7e in dark) for the one main button with navy text, blue (#1f55d6) for links, focus, selection and pressed chips, green for good news, six area colours for the key numbers. AA contrast is tested for text, the gold button and the top bar in both themes.
- Type: Hanken Grotesk for text and Cormorant Garamond for page titles and the wordmark, both SIL OFL and built into the page as data: fonts. The CSP gains `font-src data:` and nothing else; no request leaves the page for a font.
- Theme: Auto (device), Light or Dark from a switch in the top bar. The choice is the only thing LifeOS keeps outside the vault on purpose: one key, `lifeos-theme`, holding `light` or `dark` (removed for Auto), so the lock screen opens in the chosen theme. It carries no personal data and is not synced or backed up.
- No em dashes; no advice wording.
