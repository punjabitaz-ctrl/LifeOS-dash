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
