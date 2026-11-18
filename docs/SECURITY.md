# LifeOS v0.1 security audit

Date: 2026-11-13. Auditor: independent review (did not write the code).

> SEC-08 to SEC-14 were fixed in v0.2.0 by a different engineer than the auditor; the auditor has not re-reviewed these fixes. Regression tests are in `test/v020.test.mjs`, and `test/smoke.mjs` now also runs at 390x844.

## Scope
`SPEC.md`, `src/core/{vault,store,csv,metrics,memory,ai}.js`, `src/ui/app.js`, `src/ui/shell.html`, `src/ui/styles.css`, `build.mjs`, and the built `dist/lifeos.html`. Checked against the 10 hard rules in SPEC.md plus: crypto use, DOM XSS, CSP, untrusted input (CSV, backup, AI reply), CSV formula injection, AI data leakage, the local provider URL, insight approval paths, auto-lock, CSV import, and backup import/export.

## Method
- Read all files listed above line by line.
- Proved findings with tests where possible. The regex backtracking cost was measured in Node: 1 ms at 1,000 digits, 25 ms at 5,000, 101 ms at 10,000 (quadratic).
- Regression tests: `test/x-security.test.mjs` (12 tests). Extended `test/smoke.mjs` (headless Chromium via Playwright 1.65) with CSV import, CSV export, backup export, wrong-passphrase and correct-passphrase backup import, a check that locking clears the DOM, and auto-lock under Playwright's fake clock.
- Checked the built CSP: recomputed the SHA-256 of the inlined `<script>` and `<style>`, and both match the meta tag. There is exactly one `<script>`, no `unsafe-*`, and no `<!--` or `<script` inside the inlined JS.
- Final results: `node --test test/` passes 66 of 66. `node build.mjs` succeeds. `node test/smoke.mjs` prints SMOKE PASSED with no CSP or console errors.

## Findings

| ID | Severity | Location | Issue | Status |
|---|---|---|---|---|
| SEC-01 | Medium | `csv.js` normNum, `metrics.js` NUM_RE | `\d+\.?\d*` backtracks quadratically on long digit strings. A crafted 5 MB CSV (about 480 cells of 10,000 digits plus one bad character) freezes the tab for about 50 s. A numeric string in a backup had no length limit, so it could hang the tab with no bound. | Fixed: regexes are now linear (`\d+(\.\d*)?`), with length caps of 40 characters (CSV) and 64 characters (entry string). Test SEC-01. |
| SEC-02 | Medium | `app.js` Lock buttons, `lockNow`, `styles.css` `.busy .btn` | The Lock and Lock now buttons went through `act()`, which silently does nothing while another action is running (an AI request can take up to 20 s; key derivation also takes time). CSS also disabled pointer events on buttons while busy. Separately, `lockNow` waited for the audit write with no time limit before it locked. A user could press Lock and walk away while the vault stayed unlocked. | Fixed: the lock buttons call `lockNow` directly and stay clickable while busy. The audit write is raced against a 1 s timeout. Lock requests that arrive together are merged into one. The lock path is covered by smoke; the busy case was verified by reading the code only. |
| SEC-03 | Medium | `vault.js` exportBackup, `app.js` backup import | Export had no size limit (up to 50,000 entries with 2,000-character notes), but the UI refused to import files over 5 MB. A backup over 5 MB (roughly 15,000 typical entries) could be exported but never restored. This is a silent data-loss risk. | Fixed: one limit, `vault.MAX_BACKUP` (64 MiB), is used by export (which refuses to produce a larger file), by `importBackup` and by the UI. Test SEC-03 round-trips a backup of more than 5 MB. |
| SEC-04 | Low | `store.js` lock, commit, changePassphrase, replaceState | `lock()` cleared the module's references but left the state object filled in, so any reference still held elsewhere could reach plaintext. A commit or replaceState racing a lock could refill the dropped object. A changePassphrase racing a lock could put a key back in memory after the lock. | Fixed: lock empties the object, and the racing paths check that the state is unchanged before writing or reinstalling a key. Four tests. |
| SEC-05 | Low | `app.js` auto-lock | Idle detection relied only on `setTimeout` plus a check on return from a hidden tab. Timers can stall during device sleep or heavy throttling. | Fixed: auto-lock now also checks real elapsed time every 10 s and on focus, pageshow and visibility changes. Smoke covers auto-lock with a fake clock; real device sleep was not simulated. |
| SEC-06 | Low | `app.js` CSV mapping | Columns were mapped by header name, so duplicate or empty headers mapped to the wrong column or failed. | Fixed: columns are mapped by index. Test SEC-06. |
| SEC-07 | Low | `app.js` CSV file read | A CSV read that finished after a lock stored the parsed plaintext and showed it again after the next unlock. | Fixed: the result is dropped if the vault is locked, and pending state is reset on unlock. Verified by reading the code. |
| SEC-08 | Low | `ai.js` LOCAL_RE | The local provider can be any port or path on localhost or 127.0.0.1, so the prompt JSON can be POSTed to any local service. The user has to configure this (or import a backup they trust). The request uses a JSON content type (CORS preflight), `credentials:'omit'` and `redirect:'error'`, and CSP limits connections to localhost. | Fixed v0.2.0: local URL must be http://localhost or 127.0.0.1 with an explicit port 1024-65535 and an empty or exact /v1 path (no query, fragment or credentials); Settings shows the exact URL before saving. |
| SEC-09 | Low | `store.validateState` via backup import | Restoring a backup brings back insight statuses, including `approved`, and lessons. A crafted backup (the user must import it and know its passphrase) can therefore plant approved insights that later go into prompts. This is how restore works; no code path approves an insight without a user action. | Fixed v0.2.0: import shows a summary dialog and needs an explicit confirm; a checkbox (on by default) re-queues every approved insight as proposed via `memory.demoteApproved`. |
| SEC-10 | Low | `build.mjs` | `</script` is escaped in the inlined JS but `<!--` is not. There are no occurrences today (verified). | Fixed v0.2.0: build also neutralises `<!--` and `<script` in inlined JS and `</style` in inlined CSS. |
| SEC-11 | Info | `ai.js` complete | The provider's reply is read with `res.json()` with no byte limit; the text is capped at 20,000 characters only after parsing. A misbehaving local model could exhaust memory. | Fixed v0.2.0: the reply is read as a stream with a hard 1 MB cap and aborted beyond it, then parsed. |
| SEC-12 | Info | `app.js` CSV import | The mapping UI offers only date, title, value and notes. Social (person) and home (due) imports therefore reject every row. This is a functional gap, not a security issue. | Fixed v0.2.0: the mapping UI follows the selected type's fields (person, due, status, value) and `csv.toEntries` validates the mapping. |
| SEC-13 | Info | `memory.parseResponse` | Only C0 control characters are stripped, so Unicode bidi controls in AI text are kept. Text is rendered only via `textContent`, so the only effect is visual spoofing inside that text. | Fixed v0.2.0: bidi and zero-width characters are stripped in `parseResponse` and in `validateState` text fields. |
| SEC-14 | Info | settings | A backup can set `autoLockMin` up to 1440, but the settings select offers only 1 to 60. | Fixed v0.2.0: `validateState` clamps `autoLockMin` to 1-60. |

## Hard rules: verified
1. Storage: there is one envelope under one IndexedDB key, and plaintext is never written. There is no localStorage, cookie, URL or `console` use in the shipped code (grep).
2. Crypto: PBKDF2-SHA256 with 600,000 iterations, a 16-byte random salt, AES-GCM-256 and `extractable:false` (tested). A fresh 12-byte IV is used for every encrypt (tested). The passphrase must be at least 12 characters for create, change and backup export. Envelope parsing requires exactly `iter === 600000`, `SHA-256` and a 16-byte salt, so a lowered iteration count is refused for both stored envelopes and backups (tested).
3. CSP: matches the spec, the hashes are correct, and there are no inline handlers or `style=""` attributes.
4. DOM: there is no `innerHTML`-like sink. `h()` sets attributes with `setAttribute` and text with `textContent`. The only `href` is an app-created `blob:` URL, attribute names are always in code, and data-derived attribute values (`aria-label`) are inert.
5. Approval: `memory.decide` is called only from the Approve and Reject click handlers. `propose` always creates `proposed`. See SEC-09 for backup restore.
6. AI privacy: the prompt contains only the numeric digest, at most 8 approved insights and at most 8 lessons, and `max_tokens` is 600. A test confirms that no titles, account names, notes, people's names or the API key appear in level 1, 2 or 3 prompts. AI error messages contain only the HTTP status (an existing test covers this).
7. API key: stored only in the encrypted state; the UI shows only the last 4 characters and never fills the key back into an input.
8. CSV: 5 MB, 20,000 rows, 100 columns and 10,000 characters per cell. Bad rows are counted. Export prefixes `= + - @`, tab, CR and LF in every column with `'` and quotes every field (tested in unit tests and in smoke via a browser download).
9. Untrusted input: CSV, backup and AI replies are type-, length- and whitelist-validated. `__proto__`, `constructor` and `prototype` keys are rejected, and state objects are rebuilt from whitelisted fields.
10. No em dashes in any source file or in `dist/lifeos.html`.

## Residual risks
- Client-side encryption cannot protect against a compromised device, a malicious browser extension, or malicious script running in the page while the vault is unlocked. Any of these can read the decrypted state and capture the passphrase.
- While unlocked, the decrypted data and the API key are in page memory, and the key is visible to any script in the page. JavaScript cannot reliably zero strings, so locking drops references but does not guarantee the memory is erased.
- PBKDF2 is used rather than a memory-hard KDF such as Argon2, so a weak passphrase is open to GPU guessing if the envelope or a backup file leaks. The only defence is the 12-character minimum.
- The Anthropic API key is sent from the browser (`anthropic-dangerous-direct-browser-access`), and the digest goes to a third party when that provider is chosen.
- Wipe deletes the IndexedDB record but does not securely erase the disk.
- A CSP delivered by a meta tag cannot set `frame-ancestors`.

## Not tested
- A real device sleep or resume during auto-lock (only a fake clock was used), and the Lock button while another action is busy (verified by reading the code only).
- Browsers other than headless Chromium; mobile browsers; behaviour when the file is served over http(s) rather than opened as file://.
- Live calls to api.anthropic.com or a real local model (mocked fetch only).
- Memory forensics after lock; IndexedDB behaviour under quota pressure; backups larger than about 8 MB through the UI; CSV files in encodings other than UTF-8.

# v0.3.0 audit

Date: 2026-11-13. Auditor: independent review (did not write the code).

## Scope
The v0.3.0 delta: `src/core/sync.js` and `src/ui/sync-ui.js` (Google Drive sync, OAuth implicit redirect), the schema 1 to 2 migration and the accounts, budgets, recurring and categories code in `store.js`, `metrics.js` and `app.js`, the new SVG charts, and `build.mjs` writing `_headers` for Cloudflare Pages. Also re-checked that SEC-01 to SEC-15 have not regressed (all earlier regression tests still pass; the hard-rule greps below were re-run).

## Method
- Read the files above line by line against SPEC.md and its v0.3.0 addendum.
- Proved each finding with a test that fails on the unfixed code and passes on the fixed code. This was checked by re-applying the original code in a scratch copy: all nine SEC-16 to SEC-24 unit tests in `test/v030.test.mjs` failed there and pass here. SEC-16 was checked the same way in `test/smoke-sync.mjs`.
- New tests: `test/v030.test.mjs` (14 tests: one or more per finding, plus schema 2 sync coverage). `test/smoke-sync.mjs` now enters accounts, a budget and a recurring item through the UI before the first upload, checks them on the downloading device (net worth, budget, recurring still only proposed), checks that locking drops the Google token, and adds a fourth browser context holding a schema 1 vault (written by the test straight into IndexedDB) that downloads the schema 2 remote and keeps it across lock and unlock.
- Known item 1: the default category "Food" was restored to "Groceries". `test/smoke.mjs` no longer scans `document.body.textContent` (which includes the inline script). It now walks every text node in the whole document except those inside `<script>` and `<style>`, plus every attribute value of every element, the document title and all form control values. A positive control runs the same scan while unlocked and must find the data, and the test also asserts that the app script itself contains "Groceries", so excluding script text is required and the check is not vacuous.
- Re-checked: one `<script>`, CSP hashes match, no `innerHTML`-like sinks, no `localStorage`, `console`, `eval` or `style=""` in shipped code; sessionStorage holds only the OAuth nonce; no em dashes in source, tests, docs, `dist/` or `_headers`.
- Final results: `node --test test/` passes 120 of 120. `node build.mjs` succeeds. `test/smoke.mjs` (SMOKE PASSED), `test/smoke-money.mjs` (SMOKE-MONEY PASSED) and `test/smoke-sync.mjs` (smoke-sync OK) all pass with Playwright and system Chrome, with no CSP or console errors.

## Verified without a finding
- OAuth state: 128-bit nonce from `crypto.getRandomValues`, stored only in sessionStorage, read and removed on the first return (single use), compared in constant time, length checked. The fragment is removed with `history.replaceState` before it is parsed, and `sync.js` runs before `app.js` in the single inlined script. The token is checked for format, `token_type`, and scope.
- The token is sent only in the `Authorization` header to `https://www.googleapis.com`, with `credentials:'omit'`, `redirect:'error'` and `referrerPolicy:'no-referrer'`. Unit and smoke tests found it in none of: state, IndexedDB, sessionStorage, localStorage, audit, URL or error messages.
- No open redirect: the auth URL is a constant, `redirect_uri` is the page's own origin and path, and the client ID is checked against a strict pattern both in Settings and in `validateState` (so a backup or remote vault cannot inject query parameters).
- A malicious remote vault cannot be forged without the key (AES-GCM). The outer `rev`/`updatedAt`/`deviceId` must equal the copies inside the ciphertext. A replayed older envelope is rejected as a rollback once this device has synced. Remote JSON is size capped, then parsed by `parseEnvelope` and `validateState` before use.
- Conflict path: nothing is uploaded or replaced until the user chooses, and `apply` refuses without a `saveBackup` callback. The losing local copy is the encrypted envelope, and a test confirms that `importBackup` restores it (including a migrated schema 1 copy).
- Migration: schema 1 balance titles become accounts, every entry is kept, and the migration is persisted by the unlock commit. `validateState` rebuilds accounts, recurring, budgets and categories from whitelisted fields with caps, and rejects `__proto__`/`constructor`/`prototype` keys. Money totals use integer cents. Recurring items are only proposed; `confirmRecurring` is called only from the Confirm button.
- Charts are built with `createElementNS` and numeric attributes. Labels go through `textContent`.
- The AI digest gains only numeric money fields. Existing tests show that account names, category names, entry titles and recurring titles reach neither the digest nor any prompt.
- connect-src adds only `https://www.googleapis.com`. Navigation to accounts.google.com is a top-level redirect, not a fetch.

## Findings

| ID | Severity | Location | Issue | Status |
|---|---|---|---|---|
| SEC-16 | Medium | `app.js` lockNow, wipe | Locking did not drop the Google access token. It stayed in memory (up to about an hour), and after unlock the app offered to sync with it. SPEC requires a memory-only token, and the session should end at lock. | Fixed: lock and wipe call `sync.disconnect()`. Smoke-sync checks that after lock and unlock there is no prompt, Sync now is disabled and the user must reconnect. |
| SEC-17 | Medium | `sync.js` run | Passphrase change. (a) After this device changed its passphrase, sync said "in sync" because only content was compared. The Drive copy stayed under the old (possibly compromised) passphrase indefinitely. (b) If another device then uploaded a newer copy under the old passphrase, it was offered as a plain "newer copy" download. Accepting it silently reverted this device to the old passphrase. | Fixed: the key in use at the last sync is recorded (`settings.sync.keySalt`, the public salt). A local key change counts as a local change: if Drive is unchanged, the copy is re-uploaded under the new key; if Drive also changed, the user gets the conflict path. When the Drive copy uses a different passphrase, the dialog says so and says what each choice does. Three tests. |
| SEC-18 | Low | `build.mjs` headersFor | HSTS carried `includeSubDomains; preload` on a shared `*.pages.dev` host, where preload is not possible and the directives misstate the policy. | Fixed: `max-age=63072000` only. A test checks that the CSP equals the meta tag plus `frame-ancestors 'none'`, that HSTS has no preload or includeSubDomains, and that every header line is under 2000 characters (the CSP line is 356). |
| SEC-19 | Low | `store.js` replaceState (backup restore) | Restoring a backup also restored its `settings.sync`. An older backup lowered `remoteRev`, which weakens the rollback check. A crafted backup could also swap in a different OAuth client ID that the import summary does not show. | Fixed: replaceState keeps this device's sync settings. Test SEC-19. |
| SEC-20 | Low | `sync.js` apply | A download offer (made because the device had no changes) was applied without re-checking. Local edits made between the check and the user's choice were replaced without a backup. | Fixed: apply re-computes the fingerprint and refuses with "Nothing was replaced". Test SEC-20. |
| SEC-21 | Low | `sync.js` load | If sessionStorage threw (for example, storage blocked), the return handler was skipped, so `#access_token=...` stayed in the address bar and in history. | Fixed: the handler always runs. It strips the fragment, then rejects the response because there is no nonce. The test evaluates `sync.js` with a throwing sessionStorage. |
| SEC-22 | Low | `sync.js` api | Drive replies were read with `res.text()`. The 64 MB cap relied on Content-Length, so a chunked reply was buffered in full before the length check. | Fixed: the body is read as a stream with a hard cap, and the request is aborted beyond it. Test SEC-22. |
| SEC-23 | Low | `sync.js` api | Any thrown error with a string `code` was passed through with its own message (shown in the UI). Only errors created by sync.js should pass. | Fixed: own errors are tracked in a WeakSet; anything else becomes a fixed NETWORK or TIMEOUT message. Test SEC-23. |
| SEC-24 | Info | `store.js` adoptEnvelope | The remote envelope object was written to IndexedDB as-is, with any extra fields. In the normal flow the bookkeeping commit re-seals it straight away, so this only mattered if that commit failed. | Hardened: only the known envelope fields are stored. Test SEC-24. |
| SEC-25 | Info | `metrics.js` money sums | An entry value can be up to 1e12 (1e14 cents), so about 91 such entries push a sum past 2^53 and integer-cent maths loses precision. Only absurd values can do this, and they come from the user's own vault. | Accepted: tightening the range would make existing vaults fail validation. |
| SEC-26 | Info | `store.js` deviceId | `deviceId` is informational. After a download, the next unlock can take the other device's ID until the next commit re-seals. No sync decision reads it (verified by grep), so spoofing it has no effect. | Accepted. |

Other change made during the audit (hardening, not a finding): an upload when Drive is unchanged now always carries a `rev` above both the Drive copy and the last synced rev.

## Residual risks
- Hosting: when the app is used from the hosted copy (Cloudflare Pages or GitHub Pages), anyone who compromises the hosting account, the repository or the deploy pipeline can serve altered code. That code would run with full access to the decrypted vault and the passphrase. A file:// copy that the user checked is not exposed to this.
- The Google OAuth client is the user's own, and it is expected to be in testing mode. Google limits testing-mode clients (named test users only, and consent screens that may warn about an unverified app). Behaviour under a verified, published client was not checked.
- Implicit flow: the access token comes back in the URL fragment. It is in the address bar and the current history entry from the redirect until the script runs `replaceState`. Any extension or script that runs before the app can read it. Google discourages the implicit flow. The token is bearer, valid for about an hour, and limited to `drive.appdata`.
- Everything Google-side was simulated: accounts.google.com and the Drive REST API were mocked in unit tests and Playwright route handlers. Nothing was run against real Google. In particular, it is not verified whether Drive v3 honours `If-Match` on media uploads. The version re-read before writing still leaves a small race window, so two devices syncing at the same moment could lose an update.
- A device that has never synced has no rollback floor, so it accepts any validly encrypted older Drive copy as an offer. It is still only applied after the user chooses.
- The losing copy in a conflict is saved through a browser download. The app cannot confirm the file was actually written to disk before it replaces the other copy.
- Two tabs of the app on the same device each hold their own state and overwrite each other's IndexedDB writes. This is not specific to sync.
- The earlier residual risks (compromised device or extension, PBKDF2 rather than a memory-hard KDF, no secure erase) still apply. A meta CSP still cannot set `frame-ancestors`, but `_headers` now does for the hosted copy.

## Not tested
- Real Google OAuth and Drive (see above), and real Cloudflare Pages header handling: `_headers` was checked as a file only, never served.
- Browsers other than Chrome (headless, via Playwright); mobile Safari's handling of the fragment and sessionStorage across the redirect.
- Rendering of the new money and assets charts was not checked for visual correctness beyond what smoke-money asserts.
- Very large vaults near the 64 MB sync cap through the browser (the cap was only exercised in unit tests).

# v0.4.0 audit

Date: 2026-11-13. Auditor: independent review (did not write the code).

## Scope
The uncommitted v0.4.0 delta (`git diff HEAD`): schema 3 (projects, pipeline, `projectId` on outcomes) in `store.js` validateState and the 1/2 to 3 migration, work metrics, carry-over and the work digest in `metrics.js` and `memory.js`, the Work view and trend SVG in `app.js`, the projects and pipeline CSV exports in `csv.js`, and sync, backup and conflict behaviour across schemas. Also re-checked that SEC-01 to SEC-26 have not regressed and that `_headers` matches the built file.

## Method
- Read the delta line by line against SPEC.md and its v0.4.0 addendum.
- Proved findings with tests that fail on the unfixed code: with the two fixes neutralised in a scratch copy, the SEC-27, SEC-28 and SEC-29 tests in `test/v040.test.mjs` and the two tightened tests in `test/work.test.mjs` failed (5 tests); all pass on the fixed code.
- Older app meeting schema 3: the v0.3.0 core files from `git show HEAD` were loaded in a separate Node `vm` context (scratch script, not kept). v0.3.0 `validateState`, `store.unlock` and `vault.importBackup` all refuse a schema 3 vault with "unsupported schema", and the stored envelope was unchanged afterwards. v0.3.0 `sync.run` opens the Drive copy before any upload, so it stops on the same error (read, not run).
- New tests: `test/v040.test.mjs` (8 tests: SEC-27, SEC-28, SEC-29, newer schema refused by sync, backup and unlock, prototype keys and whitelists on work fields, adversarial strings against the digest and level 1 to 3 prompts, CSV formula neutralising in every projects and pipeline column, timing at the caps). `test/smoke-work.mjs` now enters hostile markup as a project and pipeline item and checks that no element or handler reaches the DOM and that there are no CSP errors, and restores an older-format backup through the UI (refused without the tick, restored with it).
- Re-checked: one `<script>`; the script and style hashes in the meta tag, `_headers` and `dist/_headers` match the built file; no `innerHTML`-like sinks, `eval`, `localStorage` or `console` in `src/`; no em dashes in source, tests, docs, `dist/` or `_headers`.
- Final results: `node --test test/` passes 147 of 147. `node build.mjs` succeeds. `test/smoke.mjs` (SMOKE PASSED), `test/smoke-money.mjs` (SMOKE-MONEY PASSED), `test/smoke-sync.mjs` (smoke-sync OK) and `test/smoke-work.mjs` (SMOKE-WORK PASSED) all pass with Playwright and system Chrome.

## Verified without a finding
- Schema handling: schema 1 and 2 migrate to 3 on unlock, backup import and sync (existing tests). Schema 4 or any other value is refused by unlock, backup import and sync, and nothing local or on Drive is written (new test).
- validateState rebuilds projects and pipeline items from whitelisted fields only, with enums for kind, status and stage, text limits (200, notes 2000), real dates, duplicate id checks, caps 200 and 1000, bidi stripping, and `__proto__`/`constructor`/`prototype` keys rejected (new test). The stored work digest accepts only numeric fields under fixed keys.
- Dangling `projectId`: validateState drops a link to a project that does not exist and keeps the outcome. No code path removes a project (the UI only archives, and archived projects keep their links), and sync, backup and conflict always replace projects and entries together, so no reachable path loses a link. Left as is.
- Carry-over is never automatic: `carryOver` is called only from the "Carry over selected" click handler and needs ticked ids (grep, existing and new tests, smoke).
- DOM: all Work view text goes through `textContent` or text nodes. Data reaches attributes only as values of fixed names (`data-*`, `aria-label`, `value`) via `setAttribute`. The trend SVG uses numbers and date labels only.
- CSV: the projects and pipeline exports quote every field and prefix `= + - @`, tab, CR and LF in every column (new test).
- AI digest: the work block is numbers only. Project names, next actions, titles, orgs, sources, next steps, notes and ids, including prompt-injection, markup, number-like and formula strings, reach neither the digest, rules insights nor level 1, 2 or 3 prompts (new test).
- Performance at the caps (200 projects, 1000 pipeline items, 50,000 outcomes): validateState about 0.3 s; work summary, digest, 8-week series, headline and carry-over candidates together well under the 1.5 s test bound (about 0.1 s measured).

## Findings

| ID | Severity | Location | Issue | Status |
|---|---|---|---|---|
| SEC-27 | Medium | `sync.js` run/apply, `sync-ui.js` | A Drive copy written by an older version (schema 1 or 2) is migrated on open, so it looks like a normal copy with no projects or pipeline. Choosing it in a conflict, or accepting a download offer, replaced this device's projects and pipeline. The dialog showed only revision, date and entry count, so the user could not see that work data would go. | Fixed: the decision reports schema and project and pipeline counts for both copies and a `dropsWork` flag. `apply` refuses to use such a copy unless `allowWorkLoss: true` is passed, and the dialog shows a warning and an unticked "I understand" box that sets it. Keeping this device is unaffected. Test SEC-27; the sync dialog change itself was verified by reading only. |
| SEC-28 | Medium | `app.js` backup import, `store.replaceState` | Restoring a v0.3.0 (schema 2) backup removed every project and pipeline item. The summary listed entries and accounts but not work data, and unlike a sync conflict no copy is saved first. | Fixed: `validateState` marks its output with a non-enumerable `sourceSchema` (never stored; `demoteApproved` keeps it). `replaceState` refuses an older-format state when the vault has work data unless `allowWorkLoss: true`. The summary lists projects and pipeline items, and an older backup shows a warning and an unticked box. Test SEC-28 and smoke-work. |
| SEC-29 | Info | `metrics.js` carryOver | Repeating an id in the list created the same outcome more than once. The UI cannot send repeats. | Hardened: ids are de-duplicated. Test SEC-29. |
| SEC-30 | Info | `metrics.js` carryOverCandidates, `app.js` carryCard | The carry-over list has no limit. At the entry cap a synthetic vault produced 4,667 candidates (computed in about 40 ms), all rendered as checkboxes. Only reachable with thousands of unfinished outcomes, for example from CSV import. | Accepted; UI render time at that size was not measured. |
| SEC-31 | Info | `app.js` workScreen | The 200 project cap counts archived projects and there is no project delete, so a user at the cap cannot add projects, although the message says to archive or delete some. Functional, not security. | Fixed in v0.5.0: projects can be deleted after an in-page confirm (linked outcomes are kept and unlinked), archived projects have a Restore and Delete list, and archived projects no longer count toward the 200 cap (a 2,000 total cap bounds the list). Tests in `test/health.test.mjs`. |

## Residual risks
- At the caps, the state can be larger than the 64 MB backup and sync limit (each text field can hold 200 or 2,000 characters, and control characters expand six-fold in JSON; 1,000 pipeline items with 2,000-character notes of control characters alone produce 12 MB of JSON). Export and sync refuse rather than truncate (SEC-03, SEC-22), so the risk is being unable to back up, not silent loss. This predates v0.4.0.
- Once any device writes a schema 3 copy to Drive, v0.3.0 devices refuse it and cannot sync until updated. That is the intended refusal, but the v0.3.0 message only says the Drive file is not a valid vault.
- The conflict losing copy and the older-backup warning rely on the user reading the dialog; a deliberate tick can still remove work data (by design).
- Earlier residual risks (compromised device or extension, hosting compromise, implicit OAuth flow, PBKDF2, no secure erase) still apply.

## Not tested
- The new sync dialog warning and tick box in a browser (smoke-sync does not create an older-format Drive copy); covered by unit tests on `sync.apply` and code reading.
- v0.3.0 sync against a schema 3 Drive copy was read, not run. Older versions were checked only through their core files in Node, not their built UI.
- Rendering and responsiveness of the Work view and the review screen at 1,000 pipeline items or thousands of carry-over candidates; only the maths was timed.
- Real Google Drive, other browsers and mobile Safari (as in earlier audits).

## v0.5.0 delta (Health, project delete)
- Schema 4 adds `settings.health`, `cycle`, `kinds`, `habits` and `habitLog`, each rebuilt from whitelists with caps in `validateState` (8 habits, 30 workout types, 30,000 ticks, 2,000 projects of which 200 live). Malformed values are rejected; dangling or repeated ticks are dropped; health keys inside an older-format copy are ignored. Schema 5 and above are still refused by unlock, backup import and sync.
- SEC-27/28 extended: `store.droppedData` names what an older-format (schema 1 to 3) backup or Drive copy would remove (projects, pipeline items, training cycle, daily checks, workout types, body targets and units). `replaceState` and `sync.apply` refuse without the explicit tick and the warnings list the collections by name and count only, never values.
- Privacy: the digest `health` block is five numbers (sessions, minutes, average sleep, weight change, habit completion rate). Habit names, workout kinds, titles and notes never reach the digest, rules insights or any prompt; rules insights are numeric facts. Body metrics are not written to the audit log (actions only) and validation errors never echo values.
- Tests: `test/health.test.mjs` and `test/smoke-health.mjs`.
- Not tested: real devices, a v0.4.0 build run against a schema 4 vault (its refusal is by the unsupported-schema check, as for earlier versions), layout beyond 390 px and 1280 px.

# v0.5.0 audit

Independent audit of the uncommitted v0.5.0 delta (`git diff HEAD`), done without the engineer's report.

## Scope
Schema 4 (`settings.health`, `cycle`, `kinds`, `habits`, `habitLog`, workout `kind`/`minutes`/`effort`, `bodyfat` entries), migrations from schema 1 to 3, the SEC-27/28 downgrade guards in sync conflict, sync download and backup restore, `validateState`, project delete (SEC-31), the Health view and its SVG charts, digest, rules insights and prompts, CSV export, date and unit maths, performance at the caps, the build CSP and `_headers`. Regression check of SEC-01 to SEC-31 through the existing suite plus spot checks.

## Method
Read SPEC.md (hard rules and the v0.5.0 addendum), the full diff and the touched modules. Proved each finding with a test that fails on the pre-fix code and passes after (`test/v050-audit.test.mjs`; SEC-33 also with a new smoke step, run against a build of the pre-fix form, where it failed with "92 kg below target 180 kg"). Ran `node --test test/` in the default zone, `TZ=America/New_York` and `TZ=Pacific/Auckland`, `node build.mjs`, and all five smoke scripts with Playwright and system Chrome.

## Verified without a finding
- Edited tests: the diff of `money`, `store`, `v030`, `v040`, `work` tests and `smoke.mjs` changes only schema numbers (3 to 4, "newer" 4 to 5) and the version string. No assertion was removed or loosened.
- Addendum coverage: every item is implemented (project delete with linked count and unlink, archived projects outside the cap, weight and body fat with targets, starts, lb/kg, 7-entry average, 4-week weekly rate and progress; workout type, minutes, effort, week view and mix; cycle function shown on the Health view and the dashboard tile; sleep average and trend; up to 8 daily checks with rate and streak; numeric digest; no advice wording). The weekly rate window is 29 days inclusive (today minus 28).
- Migrations 1, 2 and 3 to 4 keep entries, money and work data and old health entries; schema 5 is refused by unlock, backup import and sync.
- `droppedData` names projects, pipeline items, training cycle, daily checks, workout types and body targets in sync download, conflict and backup restore; the explicit tick is still required (`allowWorkLoss === true` only).
- `validateState` rebuilds every new field from a whitelist with caps (8 habits, 30,000 ticks, 30 types, 200 live of 2,000 projects); `__proto__`, `constructor` and `prototype` keys are refused anywhere by `scan`; errors name fields, never values.
- `deleteProject` removes only the named project and only the `projectId` links to it.
- Audit log entries are fixed action names; body values never reach it, notices or the console (no `console` calls in the app).
- DOM: Health text goes through `textContent`; user strings reach only `data-*`/`aria-label` via `setAttribute`; SVG gets numbers and date digits only; no inline styles, so the CSP holds. `_headers` and `dist/_headers` carry the same hashes as the built meta CSP.
- CSV export quotes and neutralises the new `kind`, `minutes`, `effort` columns.
- Performance at the caps (50,000 health entries, 8 habits, 30,000 ticks): validateState about 0.2 s; body metrics, sleep, week, daily checks, rules insights and all headlines each under 0.05 s.

## Findings

| ID | Severity | Location | Issue | Status |
|---|---|---|---|---|
| SEC-32 | Medium | `memory.js` buildPrompt | The weekly weight change, a body metric, was sent to the AI provider in the level 1 prompt, and an approved "Weight moved ..." rules insight was sent as context at levels 1 to 3. SPEC: body metrics must not appear outside the vault. | Fixed: the prompt health line drops weight change and those rules insights are filtered from prompt context. They stay in the digest and Memory inside the vault. Test SEC-32. |
| SEC-33 | Medium | `app.js` health targets form | Switching units in the form converted the targets, then overwrote them with the old-unit numbers still in the inputs: a 180 lb target became 180 kg. | Fixed: typed values are stored in the units shown, then converted; inputs left as shown are not rewritten. Test SEC-33 and smoke-health "unit switch round trip". |
| SEC-34 | Low | `metrics.js` setWeightUnits, `store.js` cleanHealthSettings | Conversions and validation rounded to 0.1, so each lb/kg round trip could drift entries and targets (180 became 179.9). | Fixed: stored values keep 6 decimals; screens round to 0.1. Two health.test expectations changed to the exact values (99.790321, 90.718474, 90.04). Test SEC-34. |
| SEC-35 | Low | `metrics.js` todayISO, `app.js` dashboard, `sync.js` | The default "today" was the UTC date. Dashboard sparklines (called without a date) and the conflict backup file name used it, so late Sunday evening in New York showed next week. | Fixed: `todayISO` uses the local date and the dashboard passes it. Test SEC-35. |
| SEC-36 | Low | `store.js` cleanEntryText | Workout `kind` on entries kept bidi and zero-width characters that every other entry text field loses. | Fixed. Test SEC-36. |
| SEC-37 | Info | `csv.js` toEntries | CSV import cannot map `kind`, `minutes` or `effort`, so exported workouts lose them on re-import. | Accepted (adding it is a feature). |
| SEC-38 | Info | `store.js` habit log cap | At 30,000 ticks (about 10 years of 8 daily checks) every save fails validation; nothing prunes old ticks. | Open. |
| SEC-39 | Info | test suite | One run in eleven under `TZ=America/New_York` failed `vault.test.mjs` "backup round trip"; not reproduced in ten further runs. All files share one process and `v020.test.mjs` swaps the `LifeOS` modules, a known order sensitivity. | Open. |

## Residual risks
- Weight values still leave the vault when the user exports CSV or an encrypted backup, by design.
- AI replies are model text: the prompt forbids medical advice, but a reply could contain it; it stays a proposal until the user approves it.
- Health data adds to the state size limit described above (SEC-03, SEC-22).

## Not tested
- Real devices, Safari and other browsers; Health view render time at the caps (only the maths was timed).
- DST is covered only through date-string maths and the two time zones above, not with a page clock set across a transition.
- A v0.4.0 build run against a schema 4 vault (refusal is by the unsupported-schema check).

# v0.6.0 audit

Independent audit of the uncommitted v0.6.0 delta (`git diff HEAD`), done without the engineer's report. Date: 2026-11-13.

## Scope
New `src/core/goals.js`; schema 5 in `store.js` (goals whitelist, caps, referential rules, migration of `goals/goal` entries from schema 1 to 4); the downgrade guards for goals in sync conflict, sync download and backup restore; the goals digest, prompt line and rules insights in `metrics.js` and `memory.js`; the Goals view, dashboard tile and weekly review Goals step in `app.js`; CSV import of workout kind, minutes and effort; the habit tick cap raised to 100,000; the edited existing tests; the build CSP and `_headers`. Regression check of SEC-01 to SEC-36 through the existing suite plus spot checks. Added at the orchestrator's request: the intermittent `test/smoke-sync.mjs` failure.

## Method
Read SPEC.md (hard rules and the v0.6.0 addendum), the full diff and the touched modules; probed crafted states in Node (self, two-goal and shorter-horizon parent loops, NaN and Infinity values, extra keys, adversarial titles against errors, digest and prompts). Each finding has a test in `test/v060-audit.test.mjs` that fails on the pre-fix code (checked in a scratch copy with the fixes reverted: 4 of 4 failed) and passes after. Timed the maths in Node and the UI in Chrome (Playwright, 390x844) on a synthetic vault at the caps. Ran `node --test test/` in the default zone, `TZ=America/New_York` and `TZ=Pacific/Auckland`, `node build.mjs`, and all six smoke scripts; `test/vault.test.mjs` 60 times under `TZ=America/New_York` (60 passed) and `test/smoke-sync.mjs` 46 times after its fix (46 passed).

## Verified without a finding
- Edited tests: the diffs of `health`, `money`, `store`, `v030`, `v040`, `work` tests and `smoke.mjs` change only schema numbers (4 to 5, "newer" 5 to 6), the version string and the tick cap value (30,001 to 100,001 in the over-cap case). No assertion was removed or loosened. The `vault.test.mjs` change swaps the marker 'Run' for 'Plain text: run, 5 km!'; spaces, comma, colon and '!' are outside the base64 alphabet, so the check still proves the title is not in the backup text and can no longer match by chance (SEC-39 root cause confirmed by the same reasoning; see SEC-43 for the measured rate of the same bug).
- Addendum: every item is implemented (goal shape and cap 300; eleven linked metrics plus manual, computed live; "no data yet" as null for every metric; direction-aware clamped progress; pace with a 10 point tolerance and user override; achieve, drop and roll-over only from click handlers, with "Target reached" offered; ladder 10y to weekly with unlinked goals apart; parent delete keeps and unlinks children with the count in the confirm; review Goals step with due, pace changes and roll-over offers; dashboard tile; digest counts only; body goals excluded). The three v0.5.0 leftovers (SEC-37, SEC-38, SEC-39) are closed.
- Migrations 1 to 4 into 5 keep all other data; schema 6 is refused by unlock, backup import and sync. `droppedData` names goals with a count for an older-format backup, Drive download and conflict, and the explicit tick is still required.
- `validateState` rebuilds goals from whitelisted fields (enums, 200/2,000 text limits, finite numbers within 1e12, real dates, due not before start, target on the right side, duplicate ids refused, cap 300); `__proto__`, `constructor` and `prototype` keys are refused by `scan`. A dangling parent is dropped; a parent on an equal or shorter horizon (which covers self-parents and every loop) refuses the whole state, and a bounded walk refuses any loop as well, so a crafted backup or Drive copy cannot reach the ladder. Errors name fields, never values.
- No NaN or Infinity: every division is guarded (progress span, elapsed window, shares); a reached zero-width range is 1. Pace uses calendar-day counts on date strings and the local `today`, so results match in all three zones; the start day is 0% elapsed and the due day 100%.
- Privacy: titles and notes (prompt-injection, markup, formula and number-like strings) never reach the digest, rules insights, level 1 to 3 prompts, the audit log or error text. Weight and body fat goals are left out of the digest counts and share, so no pace or progress number about them leaves the vault.
- DOM and CSP: goal text goes through `textContent`; titles reach only `data-goal` and `aria-label` via `setAttribute`; no inline styles; the smoke reports no CSP errors. `_headers`, `dist/_headers` and the meta CSP carry the same hashes; one `<script>`.
- CSV import: `kind` (trimmed text up to 40, bidi stripped), `minutes` (0 to 1,440) and `effort` (integer 1 to 10) go through the strict number pattern and `validateEntry`; bad rows are counted.

## Findings

| ID | Severity | Location | Issue | Status |
|---|---|---|---|---|
| SEC-40 | Medium | `store.js` goalsFromEntries | The schema 5 migration merged all entries with the same goal title into one goal, kept only the latest entry's notes, then deleted every entry: earlier notes, earlier statuses, their dates and the typed title casing were lost. SPEC requires no data loss. | Fixed: the goal's notes hold the full history (date, title as typed, status, notes per entry, in date order). Entries are removed only when that history fits in 2,000 characters; otherwise they are kept, and the Goals view lists kept older goal entries read only (newest 200). Test SEC-40. |
| SEC-41 | Low | `goals.js` tally, reviewGoals; `app.js` Goals view | Every goal recomputed its linked metric with a full scan of the entries. At the caps (300 goals, 50,000 entries) the dashboard goals sparkline took 2.2 s and the tile, digest, rules insights and review step about 0.4 to 0.8 s each, freezing the UI. | Fixed: linked values are shared per metric and date within one pass (`evaluate(..., memo)`); sparkline 0.09 s, tile 0.03 s, digest 0.06 s, review 0.03 s. Same results with and without the memo. Test SEC-41. |
| SEC-42 | Info | `goals.js` rollTarget | Rolling a goal more than 1,000 periods overdue stopped stepping after 1,000 periods and left it still in the past. | Fixed: jumps straight to the period containing today. Test SEC-42. |
| SEC-43 | Info | `test/smoke-sync.mjs` | The intermittent "A connect: uploaded envelope looks wrong" failure is a test bug, not an app race: the check ran a name regex ('Gym', 'Visa' ...) over the whole envelope, including base64 ciphertext, where a short name appears by chance (about 0.5% of encryptions of an empty state, more as it grows). The failure message can only come from that check; a missing upload has its own message, and rev is always written. | Fixed in the test: names are checked outside the base64 fields, `ct`, `iv` and salt must be pure base64, and the upload must decrypt to this device's data. Test SEC-43. |

## Performance at the caps (measured)
Synthetic vault: 50,000 entries, 300 goals (all metrics, half linked to parents), 8 daily checks with 100,000 ticks, 200 accounts, 200 projects, 1,000 pipeline items. State 16.3 MB of JSON, envelope 21.8 MB (the tick log is 6.8 MB of it), under the 64 MB backup and sync limit. In Node: validateState 0.4 to 0.5 s. In Chrome at 390x844 after the fixes: unlock to dashboard 2.0 s including PBKDF2, Goals view 0.24 s (300 goals rendered), Health view 0.6 s, weekly review 0.12 s, one daily check tick or untick (save and re-render) about 1.0 s. No console or CSP errors.

## Residual risks
- The 64 MB limit can still be reached at the caps with long text fields (earlier residual risk); 100,000 ticks with 100-character habit ids add about 17 MB of envelope. Export and sync refuse rather than truncate.
- Goal titles and notes leave the vault in encrypted backups and Drive copies only; plaintext goal fields have no CSV export.
- Pace changes in the review compare today with the end of last week using today's manual value, because manual values keep no history.
- Earlier residual risks still apply.

## Not tested
- The kept older goal entries list in a browser (unit test and code reading only); the Goals view and review step render at the caps was timed in Chrome only, not on a phone.
- Real devices, Safari, real Google Drive and real AI providers (as before). DST covered only through date-string maths and the three zones above.
- A v0.5.0 build run against a schema 5 vault (refusal is by the unsupported-schema check, as for earlier versions).

# v0.7.0 audit

Independent audit of the uncommitted v0.7.0 delta (`git diff HEAD` plus untracked files), by an auditor who did not write it. Date: 2026-11-14.

## Scope
New `src/core/home.js` and `src/core/admin.js`; schema 6 in `store.js` (whitelists, caps, references, migration of `home/due` entries from schema 1 to 5, the overflow path); the downgrade guards for every schema 6 collection in sync conflict, sync download and backup restore; the Home and Admin views, Admin tile, review step, household flag on recurring items and the two goal metrics in `app.js`, `goals.js`, `metrics.js` and `memory.js`; the engineer's extra fields (renewal `reviewedOn`, `doneOn`, `createdAt`; maintenance `odometer`; `settings.home.starterDone`); the edited existing tests; the build CSP and `_headers`. Regression check of SEC-01 to SEC-43 through the existing suite plus spot checks.

## Method
Read SPEC.md (hard rules and the v0.7.0 addendum), HANDOFF.md, the full diff and both new modules. Probed crafted states and inputs in Node (prototype keys, object-typed links, extra fields, negative and huge repeat days and odometers, duplicate ids, secrets with hidden separators and non-ASCII digits, cap-sized costs). Each finding has a regression test that fails on the pre-fix code and passes after: SEC-44 to SEC-47 in `test/v070-audit.test.mjs` (4 of 4 failed against the original modules in a scratch copy), SEC-45 and SEC-48 in `test/smoke-home-admin.mjs` (both steps failed against the engineer's build). Timed the maths in Node and the UI in Chrome (Playwright, 390x844) at the new caps. Ran `node --test test/` in the default zone, `TZ=America/New_York` and `TZ=Pacific/Auckland`, `node build.mjs`, and all seven smoke scripts twice.

## Verified without a finding
- Edited tests change only schema numbers (5 to 6, "newer" 6 to 7), the version string and the tile count (10 to 11); `_load.mjs` adds the two new modules. No assertion was removed or loosened.
- Addendum: every item is implemented (shapes and caps 20/20/2,000/2,000/1,000/1,000; one property means no picker; completion records date, cost and odometer and only proposes the next date; confirm, adjust or stop repeating are taps; the starter checklist is offered until added or dismissed and adds only ticked items; household bills are flagged Money recurring items with a monthly total in integer cents and no second store; Home and Admin views, tiles and headlines as specified; subscription run-rate and the 12 month flag as numbers only; the document index states plainly not to enter ID numbers, account numbers or passwords; tax checklist grouped by year with no computation; 30/60/90 timeline overdue first; review step; both goal metrics with "no data yet"; digest counts and totals only).
- Migration 1 to 5 into 6: each `home/due` entry becomes a renewal keeping id, title, due date, status, createdAt, and its entry date and notes in full in the notes. When that would not fit 2,000 characters, the due date is outside 1900 to 2200, or the 2,000 renewal cap is reached, the entry is kept unchanged and listed under Admin (see SEC-48). All other collections are untouched.
- Downgrade guards: `droppedData` names properties, vehicles, maintenance items, renewals, documents, tax items (with counts) and household bill flags for an older backup, Drive download and conflict; the explicit tick is still required. Schema 7 is refused.
- `validateState` rebuilds every new record from whitelisted fields with enums, text limits (200, 60, 2,000), integer cents up to 1e11, odometer up to 1e7, real dates 1900 to 2200, repeat days 1 to 3,650 required only for custom, duplicate ids refused; extra fields (including in `settings.home`) are dropped and `__proto__`, `constructor` and `prototype` keys are refused. A `propertyId` or `vehicleId` that points at nothing is dropped and the record kept; a non-string link refuses the state.
- Next-due maths: calendar-day arithmetic on date strings only, so results are identical in all three zones and across DST; month ends clamp (31 Jan + 1 month = 28 or 29 Feb), leap days and year ends are correct; custom 0, negative, fractional or huge values throw before any loop (there are no loops).
- Privacy: titles, providers, vendors, areas, vehicle and property names, document locations and notes never reach the digest, rules insights, level 1 to 3 prompts, the audit log (constant action names) or error text (field names only). No advice wording in the new UI copy.
- DOM and CSP: all new text goes through `textContent`; user strings reach only `data-title`, `data-name` and `aria-label` via `setAttribute`; no inline styles or handlers. `_headers`, `dist/_headers` and the meta CSP carry the same hashes.
- CSV: there is no CSV export or import for the new collections, so there is no new formula-injection surface.

## Findings

| ID | Severity | Location | Issue | Status |
|---|---|---|---|---|
| SEC-44 | Low | `admin.js` looksSecret | The secrets guard on the document index matched only ASCII digits separated by a single space or dash. A card number grouped with dots, double spaces, mixed separators, no-break or thin spaces, en dashes, soft hyphens or word joiners, or typed in full-width or other-script digits, was accepted; so was an SSN written 123.45.6789 or 123 - 45 - 6789. | Fixed: the text is folded first (NFKC, every script's decimal digits to ASCII, invisible format characters removed, every space and dash unified) and groups may be split by a space, dash or dot with optional spaces. Years, dates, phone numbers, amounts, IP addresses and ISBNs still pass. Test SEC-44. |
| SEC-45 | Low | `admin.js` addRenewal, addTaxItem; `app.js` | Renewal title, provider and notes and tax item title and notes took card and ID numbers without a word, though a licence, policy card or payment card number is a natural paste there. | Fixed: the same guard runs when these are typed, with a message that fits the field, and both forms carry the plain warning. It is not applied in `validateState`, so an older `home/due` note holding such a number still migrates and a vault can never be locked out by it. Test SEC-45 and a smoke step. |
| SEC-46 | Low | `store.js` cleanDigest | The stored review digest capped the maintenance cost and subscription run-rate at 1e14 cents, but 2,000 items at the per-item cap reach 2e14 (cost) and about 6e15 (run-rate). At that point every weekly review failed to save with "digest home out of range". | Fixed: those two totals are checked against `Number.MAX_SAFE_INTEGER`. Test SEC-46. |
| SEC-47 | Low | `admin.js` proposeNext, pendingRenewals | A monthly renewal due on the 31st was proposed for 28 February, then 28 March, and stayed on the 28th for ever; a yearly renewal on 29 February moved to the 28th permanently. | Fixed: the day of the month is taken from the earlier renewals of the same chain while they sat on a month end, so 31 Jan, 28 Feb, 31 Mar, 30 Apr, 31 May; 29 Feb 2028, 28 Feb 2029 to 2031, 29 Feb 2032. A date the user moved stays where they put it. Maintenance counts from the done date, so it is unaffected. Test SEC-47. |
| SEC-48 | Low | `app.js` Admin view | `home/due` entries the upgrade had to keep counted in the Admin tile, timeline and "admin items overdue" goal metric for ever, but the Admin list was read only and the old Home entry screen is gone, so they could not be removed. The list also rendered every kept entry. | Fixed: each kept entry has a Delete with a confirm; the list shows the 200 soonest with the total. Smoke step SEC-48. |

## Performance at the caps (measured)
Synthetic vault with only the new collections at their caps and every text field full (20 properties, 20 vehicles, 2,000 maintenance items, 2,000 renewals, 1,000 documents, 1,000 tax items). ASCII text: 14.7 MB of JSON, 19.6 MB envelope. Three-byte characters throughout: 40.6 MB of JSON, 54.2 MB envelope, close to the 64 MB limit on its own. In Node: validateState 0.13 s (0.26 s), Home summary 15 ms, Admin timeline 5 ms, digest 10 ms, review steps 5 to 11 ms; save 0.34 s (0.95 s) and unlock 0.37 s (0.97 s) with an in-memory storage adapter. In Chrome at 390x844 (ASCII, then three-byte): unlock to dashboard 1.4 s (2.7 s) including PBKDF2, Home view 0.5 s (0.5 s), Admin view 0.8 s (1.0 s) including the dashboard, weekly review 0.7 s (0.7 s), one save 0.5 s (1.3 s). No console or CSP errors.

## Residual risks
- The 64 MB limit: the new collections alone reach 54 MB of envelope with multibyte text at the caps; added to the existing caps the state can exceed it. Export and sync refuse rather than truncate (earlier residual risk, now closer).
- The secrets guard is a pattern check: an ID or account number that is not 9 digits or a Luhn-valid 13 to 19 digit number (passport, most account and policy numbers, an EIN shape) is not caught, and the guard does not run on other free-text fields (maintenance notes, entries). The documents guard also runs in `validateState`, so a later tightening of the pattern would need care to avoid refusing an existing vault.
- Subscription annual totals above 2^53 cents (only with absurd amounts) lose precision in display.
- Expired documents count as overdue until deleted; a skipped recurring task proposes again from its last done item. Both are product behaviour, not security.
- Earlier residual risks still apply.

## Not tested
- Real devices, Safari, real Google Drive and real AI providers (as before). DST covered only through date-string maths and the three zones above.
- The UI at the caps on a phone (Chrome desktop at 390x844 only); with the other domains at their caps at the same time.
- A v0.6.0 build against a schema 6 vault (refusal is by the unsupported-schema check, as for earlier versions).

## v0.8.0 Learning (engineer's notes, each claim checked in the v0.8.0 audit below)
- `validateState` rebuilds items, sessions and takeaways from whitelists with caps (1,000, 20,000, 5,000); a dangling `itemId` or `goalId` is dropped and the record kept; a non-text link refuses the state. Schema downgrade guards (SEC-27/28) name learning items, study sessions, takeaways and the study target.
- Secrets guard (admin.looksSecret) runs when notes, session notes and takeaways are typed, not in `validateState`, so an older note holding such a number still migrates (as SEC-45).
- Digest, rules insights and prompts carry minutes and counts only; takeaways, titles, providers and notes never leave the vault. Search is `String.includes` on lowercased text; no RegExp is built from input.
- Migration: `learning/item` and `learning/hours` entries become items and sessions with their full text in the notes; entries that do not fit (notes over 2,000 characters, fractional or out-of-range minutes, past a cap) stay as entries and are deletable under Learning.

## v0.8.0 audit

### Scope
The uncommitted v0.8.0 delta (`git diff HEAD` plus `src/core/learning.js`, `test/learning.test.mjs`, `test/smoke-learning.mjs`): schema 7 and its migration from 1 to 6, `validateState` for the three new collections and the study target, downgrade guards, progress, pace, week, streak and stalled maths, item delete, the computed certification row in the Admin timeline, goal metrics, takeaway search, the digest, rules insights and prompts, the secrets guard, the Learning view, review step, dashboard "Log study" button and Settings study target, `_headers` against the built CSP, and vault size and speed at the new caps. SEC-01 to SEC-48 were checked for regressions through the existing tests (all pass) and by reading the touched code. The engineer's README, HANDOFF and SECURITY notes were checked against the code; every claim in the engineer's notes above was confirmed.

### Method
Read SPEC.md (hard rules and the v0.8.0 addendum), HANDOFF.md, this file, the full diff and the new module. Confirmed that the changes to existing tests touch only schema and version numbers. Probed crafted states in Node (non-number and out-of-range progress, units and target, percent and units together, done units over the total, object-typed links, dangling links, extra keys, legacy entries at the size limits and with fractional hours), the SEC-44 bypass set on every typed Learning text field, ISO weeks across year end, and timing at the caps. Built Learning at its caps (1,000 items, 20,000 sessions, 5,000 takeaways, every text field full) with ASCII and with three-byte characters and measured JSON, envelope, validation, encryption, maths and export in Node, then the UI in Chrome at 390x844. SEC-49 has regression tests in `test/v080-audit.test.mjs` (two of them failed against the engineer's code in a scratch copy) and a smoke step in `test/smoke-learning.mjs`. Ran `node --test test/` in the default zone, `TZ=America/New_York` and `TZ=Pacific/Auckland`, `node build.mjs`, and all eight smoke scripts twice.

### Findings
| ID | Severity | Where | Finding | Status |
|---|---|---|---|---|
| SEC-49 | Low | `learning.js` addSession, `app.js` study dialog, `vault.js` exportBackup, `sync.js` upload | A typed study session note could hold 2,000 characters, so the 20,000 sessions alone came to 40 MB of text. Learning at its caps measured 47.2 MB of JSON and a 63.0 MB envelope with ASCII text, and 137.6 MB of JSON and a 183.5 MB envelope with three-byte characters: Learning by itself could pass the 64 MB backup and sync limit. Export and sync already refused rather than truncated, but the export message said only "Delete old entries", which does not help when the size is in Learning, and the sync message did not say that nothing was uploaded. | Fixed: a typed session note is limited to 200 characters (the field and `addSession`); `validateState` still accepts 2,000 so notes carried over from older hours entries keep their full text. Learning at the typed caps now measures 12.9 MB of JSON and a 17.2 MB envelope (ASCII) and 34.6 MB and 46.1 MB (three-byte). Export and sync now say that no file was made or nothing was uploaded, that the data on this device is unchanged, and what to delete. Tests SEC-49 (three) and a smoke step. |
| SEC-50 | Info | `app.js` Learning view, recent sessions | The item titles for recent sessions were looked up in a plain object, so an item whose id is `__proto__` (possible only in a crafted backup or Drive copy) showed "[object Object]" as its title. No prototype was changed. | Fixed: a `Map` is used. No test (Info). |

Also changed (no finding): the Admin timeline caption now names certification expiries. Checked and found sound: migration (every old `learning/item` and whole-minute `learning/hours` entry becomes an item or session with its title, status, dates and notes kept; the rest stays as an entry, listed under Learning and deletable after a confirm, now covered by a smoke step); downgrade guards name and count learning items, study sessions, takeaways and the study target in sync download, sync conflict and backup restore; validation whitelists and caps, with dangling `itemId` and `goalId` dropped and non-text links refused; percent and units exclusive, zero totals give "no progress set", never NaN or Infinity; ISO weeks, streaks and stalled items across year end and in the three zones; item delete keeps and unlinks sessions and takeaways, goal delete unlinks items; the certification row is computed from the item and cannot be stored or duplicated; search is `String.includes` with no RegExp from input; titles, providers, notes and takeaways stay out of the digest, rules insights, prompts, audit entries and error messages; review actions are offered and only taken on a tap; no `innerHTML` or other HTML sink in the new view; Learning has no CSV import or export, so there is no new CSV injection surface; `_headers` and `dist/_headers` match the hash in the built page. The tile and digest fall back to the older count only while there is no Learning data (no item, session, takeaway or study target); a new test shows that once there is any, kept older entries never change the minutes, unit, series or insight text.

### Performance at the caps (measured)
Learning only, at its caps with every typed field full, after the fix: ASCII 12.9 MB of JSON, 17.2 MB envelope; three-byte 34.6 MB of JSON, 46.1 MB envelope. In Node: `validateState` 0.15 s, encryption 0.25 s (0.65 s three-byte), Learning summary 52 to 67 ms, weekly digest 6 to 10 ms, review step 3 to 5 ms, takeaway search 2 to 12 ms over 5,000 takeaways, Admin timeline under 1 ms. In Chrome at 390x844 with 19,999 sessions (ASCII, then three-byte): unlock to dashboard 1.0 s (2.3 s) including PBKDF2, Learning view 0.35 s (0.34 s), one search keystroke 0.04 s, logging a session (save and re-render) 0.9 s (1.4 s), weekly review 0.5 s (0.3 s), Admin view 0.2 s. No console or CSP errors. At 20,000 sessions the dialog refuses a new one with the cap message.

### Residual risks
- The whole vault can still pass 64 MB when several domains are at their caps (Home and Admin alone reached 54 MB with three-byte text in the v0.7.0 audit, entries can hold far more, and session notes carried over from older entries may be 2,000 characters). Export and sync refuse with a clear message and nothing is cut, but such a vault cannot be backed up or synced until data is deleted.
- An expired certification counts as an overdue Admin item (tile, timeline and "admin items overdue" goal) until its expiry date is changed or the item is dropped, as expired documents do.
- Older learning hours that are not whole minutes stay as entries and are not counted in study minutes once Learning data exists; they are listed under Learning.
- The secrets guard is a pattern check on typed notes and takeaways only; item titles, providers and unit names are not checked. Earlier residual risks still apply.

### Not tested
- Real devices, Safari, real Google Drive and real AI providers (as before). DST covered through date-string maths and the three zones above.
- The Learning view on a phone at the caps (Chrome desktop at 390x844 only), and all domains at their caps at the same time.
- A v0.7.0 build against a schema 7 vault (refusal is by the unsupported-schema check, as for earlier versions).

## v0.9.0 audit

### Scope
The uncommitted v0.9.0 delta (`git diff HEAD` plus `src/core/activities.js`, `test/activities.test.mjs`, `test/smoke-activities.mjs`): schema 8 and its migration from 1 to 7, downgrade guards, `validateState` for activities and the category list (whitelists, caps, prototype keys, `expenseId` and `goalId` references), the 30-day window, weeks and multi-day activities, the cost and Money paths including the paid-while-planned amendment, ROI tables, Health and Social computed from activities, the review step, goal metrics, the digest and prompts, the secrets guard and note cap, the Activities view, at-a-glance card and dashboard button, `_headers` against the built CSP, and size and speed at the caps. The engineer's additions outside the spec were each checked: the "Planned, date passed" card (same offer-only Done, Skipped and Reschedule as the review; correct), the "Add activity" quick button (opens the Activities form; correct), cost not editable once linked (a trap: SEC-51), average worth-it over every rated activity (SEC-56) and digest planned counts from the end of the digest week (SEC-55). At the owner's request this audit also added an end-to-end leak check across the whole app, not only Activities. SEC-01 to SEC-50 were checked for regressions through the existing tests (all pass) and spot checks: CSP hash in `_headers`, `dist/_headers` and the page; no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or `style=""` in the new code; envelope fields outside the ciphertext; the API key never in a prompt; no em dashes.

### Method
Read SPEC.md (hard rules, the v0.9.0 addendum and the amendment), HANDOFF.md, this file, the full diff and the new module; confirmed the changes to existing tests touch only schema and version numbers (one existing assertion that pinned the old locked-cost behaviour was replaced by the SEC-51 contract, which is stricter). Probed crafted states in Node. Each finding has a regression test in `test/v090-audit.test.mjs`; SEC-51 to SEC-53 were each shown to fail against the engineer's code and pass after the fix, and SEC-51 also has a smoke step in `test/smoke-activities.mjs`. Added:
- A money-integrity test: 25 seeded random sequences of 70 steps each of add (planned, done or skipped, with and without cost), mark paid, add to Money, done, skip, back to planned, reschedule, edit cost and date, delete the activity, delete the expense, a manual expense, backup export and import, and a sync-style whole-state pick, across month end and year end. After every step the stored state is checked: every link points at an existing expense, no expense has two activities, linked means paid, the expense equals the activity cost, no offer on a linked activity, committed equals the unpaid planned costs in the window, Money spend per month equals the expense entries in integer cents, and digest totals are integers. Plus crafted copies with two activities on one expense, a link to an income entry and an expense with no activity.
- An end-to-end leak check across every domain (`test/_adversarial.mjs` puts a marker holding spaces, HTML and a formula prefix in every free-text field of every collection: entries, accounts, categories, recurring items, projects, pipeline, goals, workout types, daily checks, properties, vehicles, maintenance, renewals, documents, tax items, learning items, sessions, takeaways, activities with places, people and categories, and a marked API key). In Node (`v090-audit.test.mjs`): digests, rules insights and level 1, 2 and 3 prompts for four weeks, tile headlines, more than 20 errors from mutators and the validator fed marked input, all console output, the IndexedDB envelope bytes, a backup file, every URL, header and body sent to the simulated Drive, and the audit log. In Chrome (`test/smoke-leaks.mjs`, desktop and 390x844): every domain screen opened, the weekly review and both consolidation prompts built in copy/paste mode, an error and a secrets refusal provoked with marked input, an add and an edit saved, lock, reload and unlock; then no marker in the prompts, audit log, error notices, console, every URL, sessionStorage, localStorage, cookies or the raw IndexedDB records, and no network request. Lessons and approved insight text reach prompts by design and were left out. Both checks were shown to catch a deliberately planted leak.
- Ran `node --test test/` in the default zone, `TZ=America/New_York` and `TZ=Pacific/Auckland` (320 of 320 each), `node build.mjs`, and all ten smoke scripts twice (all passed).

### Findings
| ID | Severity | Where | Finding | Status |
|---|---|---|---|---|
| SEC-51 | Low | `activities.js` build, updateActivity; `app.js` edit dialog | Once its cost was in Money an activity's cost field was locked. A typo could only be fixed by finding and deleting the expense in Money, editing, then adding it again; until then the wrong amount stayed in Money. | Fixed: a new amount changes the one linked expense in the same commit, so they never disagree and nothing is added. Clearing the cost while it is in Money is refused with a message to delete the expense first, and an expense that no longer holds the old amount (a crafted copy) is never overwritten. Test SEC-51 and a smoke step. |
| SEC-52 | Low | `activities.js` cleanActivities | An activity linked to an expense but with no paid date (possible only in a crafted or hand-edited copy) counted as committed in the view, tile, at-a-glance card and digest while the same money was in Money. | Fixed: validation sets the paid date from the linked expense, so a linked cost is never also committed. Test SEC-52. |
| SEC-53 | Low | `memory.js` buildPrompt | With nothing rated that week the prompt said "average worth-it rating 0", which a model reads as the lowest possible score. | Fixed: the prompt says "none rated". Test SEC-53. |
| SEC-54 | Info | `vault.js` exportBackup, `sync.js` upload | The over-64 MB messages listed entries, study sessions and takeaways but not activities. | Fixed: they name activities. Test SEC-54. |
| SEC-55 | Info | `activities.js` digest | Planned counts run from the day after the digest week, so a review done mid-week leaves planned items in the rest of that week out of both counts (they appear as done or past-date planned later). | Kept: the stored digest stays reproducible for a past week. Documented. |
| SEC-56 | Info | `activities.js` avgWorth, goalRating | The "All" row and the "average worth-it rating" goal metric average every rated activity ever, so a short goal moves slowly. | Kept: the spec gives no period; documented. |

No Critical, High or Medium finding. Checked and found sound: migration 1 to 7 into 8 (every `activities/session` entry becomes a done activity with id, title, date, notes and createdAt; past the cap it stays a visible, deletable entry); downgrade guards name and count activities and the category list in sync download, sync conflict and backup restore; validation refuses prototype keys, wrong types and over-cap lists, drops dangling or reused `expenseId` and dangling `goalId`, refuses an end date before the start date and spans over 365 days; window and week maths are calendar-day string maths (month end, year end, DST, three zones); reschedule keeps a multi-day length; Health counts a tagged done activity once on its start date and Social uses its people, both computed, never stored, and a skipped or planned one counts nothing; the duplicate notice only removes a manual entry on a tap; ROI tables never divide by zero and show "no data", never NaN, Infinity or zero; no advice wording; titles, places, people and notes are set with `textContent` or attributes only; Activities has no CSV import or export, and a created expense is exported through the existing neutralised Money CSV.

### Size and performance at the caps (measured)
Activities only, 5,000 activities with every field full (200-character title and place, ten 100-character names, 30 categories of 40 characters): with typed 200-character notes, ASCII 9.2 MB of JSON and a 12.2 MB backup, three-byte 24.7 MB and 32.9 MB. With 2,000-character notes (only from migrated sessions or a crafted copy): ASCII 17.7 MB and 23.7 MB; three-byte 50.4 MB of JSON, and the backup is refused with the over-64 MB message and nothing changes. In Node: `validateState` 0.05 to 0.10 s, backup 0.3 to 1.3 s, ROI tables 12 to 20 ms, digest, upcoming, review and three tiles together 94 to 176 ms. In Chrome at 390x844 with 5,000 activities (ASCII, then three-byte): unlock to dashboard 0.7 s (1.9 s) including PBKDF2, Activities view 0.75 s (0.88 s), adding an activity 1.3 s (1.7 s), Mark done 1.1 s (1.9 s), dashboard 0.14 s (0.19 s), weekly review 0.55 s (0.71 s), Health 0.11 s. No console or CSP errors.

### Residual risks
- The whole vault can pass 64 MB when several domains are at their caps (Activities alone reaches 33 MB with three-byte text, Learning 46 MB). Export and sync refuse with a clear message and nothing is cut, but such a vault cannot be backed up or synced until data is deleted; an archiving design is needed.
- Editing a Money expense amount in Money is not possible (delete only), so the activity side is the only place to correct a linked cost; deleting the expense leaves the activity marked paid and re-offers it while planned or for 30 days after.
- An activity's own spend figures (view, digest, goal) use the activity cost whether or not it was added to Money; Money totals use only expenses. They are separate figures by design and neither adds the other.
- The secrets guard is a pattern check on typed notes and place only. Earlier residual risks still apply.

### Not tested
- Real devices, Safari, real Google Drive and real AI providers (as before). DST covered through date-string maths and the three zones.
- All domains at their caps at the same time, and the Activities view on a phone at the caps (Chrome desktop at 390x844 only).
- The leak smoke does not exercise a live Drive upload in the browser (it needs https and Google); Drive bytes are checked in Node against the simulated Drive.

## v0.10.0 audit

### Scope
The uncommitted v0.10.0 delta (`git diff HEAD` plus `src/core/social.js`, `test/social.test.mjs`, `test/smoke-social.mjs`): schema 9 and its migration from 1 to 8, downgrade guards for groups, people and contacts in sync conflict, sync download and backup restore, `validateState` for the three collections (whitelists, caps, prototype keys, `groupId`, `personId`, `pipelineIds` and `projectIds` references), name matching for last contact, cadence precedence, overdue, due soon, snooze and important dates, delete and unlink, default groups, the review step, goal metrics, the digest and prompts, the at-a-glance second provider, Work pipeline and project cards, search, the secrets guard and caps, vault size and speed at the caps, the 0.10.0 version string, DOM sinks and CSP in the new views, and `_headers` against the built CSP. Engineer additions checked: `snoozedUntil` (a tap, 7 days, cleared by archive and End snooze; correct), "Add as a person" on activities (a tap per unknown name, never automatic; correct), the "offer to convert leftover contact entries" (SEC-59), and the provider-list edits in `test/activities.test.mjs` (only the expected provider list and counts grew by the new provider, and the schema number moved to 9; the "other entries untouched" count now excludes the social entry, which the migration turns into a person and which `test/social.test.mjs` checks in full; extended, not weakened). SEC-01 to SEC-56 were checked for regressions through the existing tests (all pass) and spot checks: CSP hash identical in `_headers`, `dist/_headers` and the page; no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or `style=""` anywhere in `src`; no RegExp built from user input; no em dashes; envelope fields outside the ciphertext unchanged.

### Method
Read SPEC.md (hard rules, the v0.10.0 addendum and amendment), HANDOFF.md, this file, the full diff and the new module. Probed crafted states in Node; each finding below was shown on the engineer's code by a probe before the fix and has a regression test in `test/v0100-audit.test.mjs`. Extended `test/smoke-leaks.mjs` (opens the adversarial person's detail, searches, logs a contact, opens the Work cards and the review, provokes an error with a marked group name and saves a marked group, and checks the marked important date reaches the glance card so the check proves something); a planted leak of a group name into sessionStorage was caught, then removed. Added a conversion step to `test/smoke-social.mjs`. Ran `node --test test/` in the default zone, `TZ=America/New_York` and `TZ=Pacific/Auckland` (359 of 359 each), `node build.mjs`, and all eleven smoke scripts twice.

Migration verdict: the addendum is met. `validateState` converts every older vault on read (schema 1 to 8): each distinct name (case, spacing, invisible characters and, after SEC-58, Unicode form ignored) becomes one person and their entries become the log with title and notes in full; an entry that cannot map (title plus notes over 2,000 characters, past a cap) stays a visible, deletable entry. The engineer's "offer to convert" is not the migration; it covers social contact entries that arrive later (CSV import into Social still writes entries). After SEC-59 it converts each entry exactly once, never drops or duplicates, is idempotent, refuses to guess on a shared name and is shown only while something can convert; re-validating a migrated vault changes nothing.

### Findings
| ID | Severity | Where | Finding | Status |
|---|---|---|---|---|
| SEC-57 | Medium | `social.js` nameIndex, lastContacts, eventDates, convertEntries | Two people whose names share a key (possible from a crafted or older backup, a remote vault, the migration, or Unicode forms before SEC-58) both received every Social-tagged activity naming them, and the conversion merged entries into whichever came last: a contact attributed to the wrong person by guessing. | Fixed: a shared name is ambiguous and is attributed to nobody; its entries stay entries; the Social view shows a line asking to rename one (smoke step). Exact matching only, so "Al" never matches "Alice". Test SEC-57. |
| SEC-58 | Low | `social.js` nameKey | Names were not Unicode-normalised: "José" typed composed and decomposed (or in full-width letters) did not match, and both could be added as separate people. | Fixed: NFKC before case folding, in matching, duplicate checks, the migration and search. Test SEC-58. |
| SEC-59 | Low | `social.js` convertEntries; `app.js` olderCard | The conversion offer reused the entry id as the contact id without checking, so a clash made the save fail and the offer unusable; it was also shown while nothing could convert (a tap that did nothing) and created a person with no log for an entry that could not move. | Fixed: a fresh id on a clash, a person only when a contact moves, a `convertible` count that drives the offer, and a notice with the number converted. Idempotent. Tests SEC-59 (two) and a smoke step. |
| SEC-60 | Low | `social.js` provider | The at-a-glance card showed "(36)" years beside the label and name, beyond the addendum (label and person only outside Social). | Fixed: label and name only; the year stays in the person detail. Test SEC-60. |
| SEC-61 | Info | `vault.js` exportBackup, `sync.js` upload | The over-64 MB messages did not name logged contacts or facts. | Fixed. Test SEC-61. |

No Critical or High finding. Checked and found sound: the digest holds counts only and `byGroup` is an array by group position; prompts, rules insights, goal digest counts, headlines, the audit log (fixed action names), thrown errors and console carry no name, group name, label, fact, channel or note, including for people and groups named `__proto__`, `constructor`, `toString`; the glance item shows label and name on screen only and does not feed the Activities digest; pipeline and project cards show names on screen only; people, facts and contacts are never in a CSV export (social entries go through the existing neutralised export, on a tap); Drive receives ciphertext only; nothing is put in the URL or sessionStorage; validation drops dangling `groupId`, `pipelineIds` and `projectIds` and unlinks `personId` while keeping the record; deleting a pipeline item or project unlinks through validation and never deletes the person; delete person keeps the log unlinked by default; defaults are offered; review actions are offers; secrets guard and 200-character caps on typed notes, facts and date labels; search is substring with `indexOf`. Version: nothing in the code compares app version strings (sync, backup and migration compare integer schema numbers), and 0.10.0 shows whole in Settings and the build.

### Size and performance at the caps (measured)
Social only, 30 groups, 1,000 people each with 5 dates, 50 facts and a 200-character note, and 20,000 contacts with 200-character notes. ASCII: 23.6 MB of JSON, 31.5 MB backup. Three-byte: 55.7 MB of JSON; the backup is refused whole with the over-64 MB message and nothing is cut (test SEC-61). In Node: `validateState` 0.28 s (0.52 s), backup 0.5 s (1.4 s to refuse), summary 12 to 18 ms, by-group 18 ms, digest and review 19 to 34 ms, two searches 56 to 117 ms. In Chrome at 390x844 (ASCII, then three-byte): unlock to dashboard 1.7 s (3.2 s) including PBKDF2, Social view 0.27 s (0.24 s), person detail 0.10 s (0.09 s), a save (snooze) 0.74 s (2.0 s), search 0.40 s (0.38 s), dashboard 0.17 s (0.14 s), review 0.10 s (0.12 s). No console or CSP errors.

### Residual risks
- Social alone at its caps in three-byte text passes 64 MB, so such a vault cannot be backed up or synced until data is deleted (refused, never cut). With several domains near their caps this comes sooner; the archiving design is still open.
- Matching is exact on the normalised name: a nickname or a typo in an activity does not count as contact, and a name shared by two people counts for neither until one is renamed.
- The at-a-glance list shows at most 200 items per provider.
- The secrets guard is a pattern check; names and group names are not checked. Earlier residual risks still apply.

### Not tested
- Real devices, Safari, real Google Drive and real AI providers (as before).
- All domains at their caps at the same time.
- A live Drive upload in the browser (Drive bytes are checked in Node against the simulated Drive).

## v0.11.0 audit

### Scope
The uncommitted v0.11.0 delta (`git diff HEAD` plus the untracked `src/core/priv.js`, `src/core/wellbeing.js`, `test/priv.test.mjs`, `test/wellbeing.test.mjs`, `test/smoke-priv.mjs`, `test/smoke-wellbeing.mjs`): schema 10 and its migration from 1 to 9, the private vault (inner crypto, `cleanBlob`, inner validation, merge, overlays, split, the single write path, moves and the move manager, edit-dialog and Options moves, close triggers, the private timer, wrong-passphrase delay, lock markers and badges, the "New items are private" toggle), Wellbeing (storage, check-in merge, averages, streak, live reads, old mood entries, goal metrics, tile, review step, UI copy), main-state-only outputs (prompts, digest, rules insights, stored insights, lessons, review records, audit log, CSV, backup, Drive upload), backup and sync dialogs, size guards, DOM sinks and CSP in the new views, `_headers` against the built CSP, and speed at the caps. SEC-01 to SEC-61 were checked for regressions through the existing tests (all pass) and spot checks: CSP hashes identical in the page, `_headers` and `dist/_headers`; no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or `style=""` in the built page or `src/ui`; no em dashes in the new copy.

### Method
Read SPEC.md (hard rules and both v0.11.0 addendum parts), HANDOFF.md, this file, the diff and both new modules. Every finding was shown failing on the engineer's code before the fix: the core ones by running `test/v0110-audit.test.mjs` against the engineer's `priv.js` (SEC-62 to SEC-65 and SEC-68 fail, SEC-66 by the old digest test), SEC-67 by running the new `test/smoke-priv.mjs` step against the unfixed app (fails on both viewports). Races were driven in Node by gating key derivation, the inner encryption, the main envelope write and a check-in callback, and firing each close trigger in between. Ran `node --test test/` in the default zone, `TZ=America/New_York` and `TZ=Pacific/Auckland`, `node build.mjs`, and all thirteen smoke scripts twice.

### Findings
| ID | Severity | Where | Finding | Status |
|---|---|---|---|---|
| SEC-62 | Medium | `priv.js` split; `app.js` commit call sites | A record made from or under a private record was saved public, so private text reached the main state through ordinary flows: confirming a private recurring item posted a public entry with its title; carry-over copied a private outcome's title and notes; confirming the next maintenance task or renewal copied a private one; "Add as a person" from a private activity; a contact, study session or balance logged for a private person, item or account became a public orphan with its note. All of it was visible while the vault was closed and in every backup readable with the main passphrase. | Fixed: a new record is private when the caller names a private source (`write(fn, { from })`, passed at each call site), when it references a private record, or when the same write changed or removed a private record. Public sources still give public records. This goes beyond the addendum's "new records are public unless ticked"; the owner may confirm. Test SEC-62 and a smoke step. |
| SEC-63 | Low | `priv.js` open, setUp | A close trigger that fired while the key was being derived (tab hidden, AI call, Close) was lost: the open finished afterwards and the vault stayed open, for example while the tab was hidden. | Fixed: a close counter and a hidden-tab check; an open raced by a close is refused, a set-up raced by one leaves the vault set up but closed. Test SEC-63. |
| SEC-64 | Low | `priv.js` write, commit | When the vault closed while the encrypted envelope was being stored, the write was saved but reported as failed ("LOCKED"); a retry duplicated new records. Working copies holding private text were not emptied on failure. | Fixed: the call resolves (the write is saved, the plaintext dropped); a close before the save refuses the write in both layers; working copies are emptied; the message is "The private vault is closed." Test SEC-64. |
| SEC-65 | Low | `priv.js` write; `csv.js` toEntries | Nothing in the core stopped a wellbeing value entering the main state: any write could add a wellbeing entry and CSV import accepted the wellbeing domain (no screen reached either). | Fixed: every write through the routing helper refuses a new wellbeing entry (open or closed); CSV import refuses the domain. Older entries still move in. Test SEC-65. |
| SEC-66 | Medium | `metrics.js` weeklyDigest; `memory.js`; `app.js` review | Owner decision (a spec change, not a weakening): wellbeing is kept away from the AI by default. The digest still carried `domains.wellbeing` (the average of old mood entries), rules insights said "Average mood ...", approved wellbeing insights were sent as context, the model could answer with the wellbeing domain, and a rejection reason on a wellbeing insight became a lesson sent with every prompt. | Fixed: none of these carry wellbeing any more; the review table drops the row; the test that fixed the old shape now asserts absence. Old mood entries that cannot move in stay in the main data with a plain notice on the Wellbeing screen and are never sent to the AI. Tests SEC-66 and `metrics.test.mjs`. |
| SEC-67 | Low | `app.js` onClose | A notice and the Private screen's search text survived a close: "Posted <private title>." stayed on screen after the timer closed the vault, and the search text stayed in a module variable. | Fixed: both are cleared on every close. Smoke step (fails on the unfixed app). |
| SEC-68 | Low | `priv.js` closure, move | Collecting a parent's children was quadratic: the move dialog took 6 s and moving an account with 25,000 balance entries took 36 s, with the page frozen. | Fixed: indexes built once per call; 68 ms and 3.8 s at a 38.6 MB vault. Test SEC-68. |
| SEC-69 | Low | `app.js` markAddForms | "Save cycle" creates the training cycle, which the toggle makes private, but its form did not show the "New items are private" note. | Fixed. Static test and smoke step. |
| SEC-70 | Info | `test/priv.test.mjs` | The older-app check ran the current source with the schema number edited in a VM, which proves little about the shipped v0.10.0. | Strengthened: a new test loads the real v0.10.0 core from git commit 8bf2325 in a VM and shows it refuses to unlock a schema 10 vault (storage untouched), refuses a v0.11.0 backup, and on sync (with and without its own changes) cannot read the Drive copy and uploads nothing, leaving it byte for byte. It skips only if git history is missing. |

No Critical or High finding. Checked and found sound: inner crypto (own 16-byte salt, fresh 12-byte IV per write, PBKDF2 exactly 600,000, AES-GCM 256, non-extractable key, rev inside and outside, private passphrase at least 12 and different from the main one, compared by deriving); crafted blobs (iteration downgrade, oversize, bad base64, short IV or salt, unknown fields, tampered ciphertext, swapped rev, marks with unknown names, duplicates or `__proto__`) are refused without losing the main state; inner data is validated on open; every close trigger (timer 60 s default, 15 to 1800, wall-clock check, hidden tab, lock and auto-lock, wipe, either passphrase change, restore and sync adoption, before every AI call) drops the key and plaintext and empties held records; no module-level cache, chart cache, search index or undo buffer exists; moves are one write and atomic; the activity and expense pair moves together; overlays restore exactly; the toggle resets on close and is refused while closed; markers carry no counts or names; backup and sync carry `priv` unchanged with yes or no in both dialogs and the explicit tick; the whole-vault size guard holds with the private vault at its cap; public goals cannot use wellbeing metrics (also from a crafted backup); one check-in per date merging by section; the Wellbeing copy has no labels, thresholds or advice; the wrong-passphrase delay is module-level and survives re-rendering (smoke step); `settings` is a whitelist of numbers, enums, patterned ids and the AI provider fields the user types, so the leak smoke's exclusion of it is safe (test).

### Race verdict
A close racing an in-flight open, set-up, move, routed write or check-in never leaves the vault open, never half-applies a move, and leaves no plaintext in the module afterwards: closed before the inner encryption finishes, the write is refused and both layers are unchanged; closed during the envelope write, the write is saved encrypted and the plaintext dropped; a queued write that runs after a close is refused, never applied as public.

### Leak check
`test/smoke-leaks.mjs` (a record of every collection moved in, adversarial strings) passed both runs: with the vault closed the markers appear nowhere (DOM, prompts, digest, audit, errors, console, URL, storage, IndexedDB bytes, backup, Drive upload); open, only in the DOM.

### Speed at the caps (measured, Node)
50,000 entries (25,000 private) with 150-character titles and 300-character notes, 6,000 check-ins with 200-character notes: 38.6 MB main vault JSON, 23.1 MB private ciphertext. Open (real PBKDF2, decrypt, validate) 1.3 s; close 0.18 s; view for a render 43 ms; move one entry in 2.2 s, out 1.6 s; move dialog count for 25,000 children 68 ms; move an account with 25,000 children 3.8 s; check-in save 1.8 s; a routed public edit 1.6 s (a plain edit with the vault closed costs the same, as both re-encrypt the whole vault); Wellbeing numbers 59 ms.

### Residual risks
- A forgotten private passphrase destroys the private data everywhere: on every device, in every backup and on Drive. There is no reset and no recovery.
- The wrong-passphrase delay is in the page only; anyone with the main passphrase and a copy of the vault can try private passphrases offline at PBKDF2 speed.
- While closed, the lock markers reveal which kinds of record are private (names of collections), and the audit log shows when actions happened (action names only).
- Category, workout type and activity category lists stay in the main data by design; a category created for private use is visible.
- An old review record saved before v0.11.0 may still hold a wellbeing digest number; it is never sent to the AI.
- Every write re-encrypts the whole vault, so at the caps a save takes about 2 s.

### Not tested
- Real devices, Safari, real Google Drive and real AI providers.
- The private vault with every collection at its cap at once (the private ciphertext cap of 40 MB was exercised in Node by the existing size test).
- Timer behaviour under real device sleep (the wall-clock check is tested with a faked clock).

## Final complete review (v1.0.0)

### Scope
The whole codebase at v0.12.0 (uncommitted on top of v0.11.0): src/core (vault, store, priv, sync, csv, metrics, memory, ai, revenue, layout and every domain module), src/ui (app, sync-ui, styles, shell), build.mjs, `_headers` and dist/lifeos.html. Released as v1.0.0 with the fixes below. Schema stays 11; no migration was needed.

### Method
Three independent reviewers who never saw the code before wrote one report each with proof tests that failed on the v0.12.0 code: crypto, storage, backup, sync and the private vault (docs/review/crypto.md, test/review-crypto.test.mjs, CR-1 to CR-10); AI boundary, privacy and data integrity (docs/review/privacy.md, test/review-privacy.test.mjs, PV-1 to PV-10); the UI layer in Chrome (docs/review/ui.md, test/review-ui.mjs, UI-1 to UI-10). The engineer closing the review checked each finding against the source before fixing it, fixed it in source, and kept the proof tests as regression tests (their assertions were not loosened). Further regression tests: test/v100-review.test.mjs (19 tests) and test/smoke-v100.mjs (autofill with a real Chrome profile over http, autocomplete on every input, textarea and form of every screen, frame refusal, ledger refusal while private lines are hidden, the change-passphrase delay, Customize inert bodies). test/review-ui.mjs now runs with the smoke set (`node test/smokes.mjs`, also `npm run smoke`).

Harness changes, not assertion changes: the two review test files ran their fast key derivation, storage adapter and vault close for every test in the shared process that test/index.js uses, which broke 42 other tests. Their tests now sit in a describe block with the same hooks, registered after the other files' first tests. Four existing assertions encoded behaviour the owner's rules now forbid and were changed to assert the stricter rule: lesson text in prompts (test/memory.test.mjs, PV-6), the weight rules insight (test/health.test.mjs, test/v050-audit.test.mjs, and the precondition in review-privacy test 1, PV-9). The SEC-32 test now injects a stored legacy weight insight so the prompt exclusion is still exercised.

### Findings
| ID | Severity | Status |
|---|---|---|
| CR-1 | High | Fixed. The sync fingerprint and key salt are captured inside the store's serial step that exports the envelope (or from the adopted copy before adopting), so an edit saved during an upload stays a local change and later becomes a conflict, never a silent download. |
| CR-2 | Medium | Fixed. Validating a merged view (open, every private write) allows each cap up to twice its value (each layer is already held to its own cap) and detaches, instead of refusing, a private line under a public line that gained a parent, or a goal whose parent horizon no longer fits. Add functions still count the view, so adds stay refused. The stored main state stays strict. |
| CR-3 | Low | Fixed. The private passphrase change commits only if the stored private vault is the one it decrypted; otherwise it decrypts the newer one and retries (up to 4 times, then refuses with nothing written). |
| CR-4 | Low | Fixed. A numeric audit timestamp is stored as an ISO string. |
| CR-5 | Low | Fixed. The file this device synced with wins when Drive lists it; Drive is listed again right before a first upload and nothing is created if a file appeared; more than one LifeOS file is reported in Settings. |
| CR-6 | Info | Fixed. Applying a sync decision is refused if the main key changed since the check. |
| CR-7 | Info | Fixed. replaceState validates first and judges data loss from the result; the format marker can no longer be missing. |
| CR-8 | Info | Fixed as suggested by the reviewer: a test fails if any source file contains `<script`, `</script` or `<!--`, so the build's escaping never touches real code. |
| CR-9 | Info | Fixed. The page refuses to run inside a frame on any host (the header only exists on Cloudflare). Trusted Types was not added. |
| CR-10 | Info | Fixed. U+061C is stripped with the other bidi controls (store, memory, social, revenue). |
| PV-1 | High | Fixed. While private entries or lines of work are hidden, a ledger preview adds nothing and the card says to open the private vault. |
| PV-2 | Medium | Fixed. A money entry saved while closed may keep the id of a private line of work (only while private lines exist); it counts as Unassigned while closed, is found again on open, and the next private write moves the link into the vault. The ledger preview is also dropped from the screen on every close. |
| PV-3 | Medium | Fixed. CSV numbers accept commas only in groups of three; money values allow two decimals at most; anything else is a rejected row. |
| PV-4 | Low | Fixed. Recurring items keep an anchor day while a date is clamped to a short month, so the 31st and Feb 29 come back. |
| PV-5 | Low | Fixed. Slash, underscore and comma are separators, and a run of separators counts as one. |
| PV-6 | Medium | Fixed per the owner's numbers-only rule. Rejection reasons are kept on this device only; prompts carry the count of recently rejected insights per area, never reason text or rejected wording. UI copy says so. |
| PV-7 | Low | Fixed. Money CSV export writes category and due date; income import maps status (received, expected, written-off), due date and category. |
| PV-8 | Low | Fixed. A weekly insight belongs to the month holding its start. |
| PV-9 | Low | Fixed per the owner rule given to the reviewer (body metrics never reach a value-revealing insight): the weight rules insight was removed. Older stored ones stay excluded from prompts by their text. Owner may confirm. |
| PV-10 | Low | Fixed for the ledger import only: there, a bare 9-digit number counts as an SSN only with an SSN cue. Every other field (document index, renewals, tax items, notes) keeps the strict rule, which existing tests require. |
| UI-1 | High | Fixed. Every input, textarea and form gets autocomplete off unless it sets its own value (only the main passphrase fields, for the password manager). Confirmed in Chrome: after submitting money, outcome, project, review priority, quick add and private vault forms over http with a persistent profile, the profile's autofill table is empty; with the fix removed the same smoke finds four rows. Nothing stored means nothing can be offered back. |
| UI-2 | Low | Fixed. The size, pipeline stage, household bill and tax state selects have names. |
| UI-3 | Low | Fixed. Focus returns to the size select. |
| UI-4 | Low | Fixed. The goal memo is emptied on every private close and on lock. |
| UI-5 | Low | Fixed. "New items are private" applies only to the add forms and add dialogs that show its note; one-tap actions and imports follow their source record (SEC-62). |
| UI-6 | Low | Fixed. A wrong current passphrase in "Change private passphrase" shares the open form's growing delay and disables the button. |
| UI-7 | Low | Fixed. The idle timer reads the main state and resets at most once a second. |
| UI-8 | Info | Fixed. "(default)". |
| UI-9 | Info | Fixed. Private set-up, private change and backup import fields are cleared on failure too; LOCKED has a sentence. |
| UI-10 | Info | Fixed. Module bodies are inert in Customize; Drag is hidden from keyboard and screen readers (Move up and Move down remain). |

Counts: fixed 30 of 30 (High 3, Medium 4, Low 15, Info 8). Disputed: none. Needs an owner decision: none blocking; PV-9 and PV-6 follow owner rules and may be confirmed.

### Re-checks
SEC-01 to SEC-70 through the existing tests (all pass), the leak smoke (all collections moved in, closed and open), private-vault close races (test/priv.test.mjs, test/v0110-audit.test.mjs) and money totals (review-privacy tests 4 and 5, test/revenue.test.mjs). Version 1.0.0 in package.json and the app; nothing compares app version strings: sync, backup and migration decide by schema number and revision, which v1.0.0 leaves at schema 11, so v0.12.0 and v1.0.0 copies are interchangeable (the new recurring anchor day is ignored by v0.12.0).

### Residual risks
- A forgotten private passphrase destroys the private data everywhere. A forgotten main passphrase destroys everything.
- Anyone with the main passphrase and a copy can try private passphrases offline at PBKDF2 speed; the delay is in the page only.
- While closed, lock markers show which kinds of records are private, and a public money entry may hold the id (never the name or any number) of a private line of work (PV-2).
- If two devices each created a Drive file before v1.0.0, each keeps its own file; Settings says so, but merging needs the user (export from one, restore on the other).
- Chrome's enhanced spell check, if the user turned it on, sends typed text to Google; the app does not disable spell check.
- Every write re-encrypts the whole vault (about 2 s at the caps). The vault can pass 64 MB with several domains at their caps; export and sync refuse rather than cut.
- JS cannot zero memory: passphrases and decrypted copies live until garbage collection.

### Never tested for real
Google sign-in and Drive (all tests mock Google, including whether Drive honours If-Match), a physical phone (tests use desktop Chrome at 390x844), a real AI call (simulated providers only), and the live site's response headers (Cloudflare Access blocks outside checks). Autofill was checked in desktop Chrome only, not Safari, Firefox or Chrome on Android.

## v1.1.0 audit

Date: 2026-11-16. Auditor: independent review (did not write the code).

### Scope
The uncommitted v1.1.0 delta (`git diff HEAD` plus untracked files): `src/core/tax.js`, `src/core/business.js`, schema 12 in `src/core/store.js`, the business marks and pair rules in `src/core/priv.js`, the timeline rows in `src/core/admin.js`, the five home modules in `src/core/layout.js`, the digest and prompt fields in `src/core/metrics.js` and `src/core/memory.js`, the Business screen and both print views in `src/ui/app.js`, `src/ui/styles.css`, and the tests. Checked against the hard rules, the v0.11.0 private vault rules, the v1.1.0 addendum and the v1.1.0 amendment (which overrides it).

### Method
- Read the delta line by line, then proved each finding with a test before fixing it. Regression tests: `test/v110-audit.test.mjs` (28 tests, every expected figure hand-computed in the comment beside it). Builder tests whose expected values encoded a finding were corrected to the hand-computed figures (`test/tax.test.mjs`, `test/smoke-business.mjs`: NJ estimate and set-aside, SEC-75); no assertion was removed or loosened.
- Extended `test/smoke-leaks.mjs`: with every record moved into the private vault, closed and open, every Business tab and the tax print view are swept; closed, the tax, mileage, payee and export tabs must refuse with the lock marker and the digest must carry no tax field. Extended `test/smoke-business.mjs` with the export tick (SEC-78).
- Tax proofs by test with hand-computed values: SE tax at, below and above the wage base with and without W-2 wages, the $400 floor (just under and exactly at), the half-SE deduction, the additional Medicare threshold by filing status less W-2 wages, mileage on 2026-06-30 and 2026-07-01, round trips, an out-of-order and an empty rate list, meals at 50% and 80%, the home-office square-foot cap, months and income limit, gross reimbursables, invoice to expected to received with no double counting, void, an invoice with no line of work, 1099-NEC just under and exactly at the threshold with card payments left out, weekend and holiday shifts (2027-02-01 for the 2026 1099 date), federal safe harbor (100% and 110% of prior year against 90% of current), NJ safe harbor (lesser of 80% of current or 100% of prior), and installments (2,000 seeded targets: no cent lost or created, remainder to the earliest quarters).
- Grepped the source for tax numbers: rates, thresholds, the wage base, mileage rates, the 1099 threshold and date, the $400 floor, meals and safe-harbor percentages and holidays live only in the 2026 profile defaults (`tax.defaultProfile`, `THRESHOLD_BY_STATUS`, `DEFAULT_HOLIDAYS_2026`); logic reads the profile.
- Grepped the delta for DOM sinks, inline styles, eval, network calls, console, storage and URL use, and em dashes: none. Every new input, textarea and form gets autocomplete off from `h()`; the business smoke checks it on every tab.
- Re-checks: SEC-01 to SEC-70 and CR, PV and UI findings through the existing tests and smokes (all pass).

### Findings

| ID | Severity | Location | Issue | Status |
|---|---|---|---|---|
| SEC-71 | High (tax) | `tax.seTax` | The deduction for half of SE tax included the 0.9% Additional Medicare Tax. That tax is not part of SE tax for the deduction and is not deductible. At $300,000 profit (single) the deduction was 1,580,295 cents instead of 1,545,623, understating federal tax. | Fixed: the deduction is half of the Social Security and Medicare parts only. Test SEC-71. |
| SEC-72 | Medium (tax) | `tax.seTax` | Additional Medicare used the full filing-status threshold even when W-2 wages were entered, so with $150,000 of wages and $100,000 profit it showed 0 instead of 38,115 cents. | Fixed: the threshold is reduced by the W-2 wages already counted (the profile's `otherSsEarningsCents`, relabelled "W-2 wages already counted for Social Security and Medicare"), floored at 0. Test SEC-72. |
| SEC-73 | Medium (tax) | `tax.seTax`, profile | No $400 floor: any positive profit produced SE tax. | Fixed: new profile field `seMinNetEarningsCents` (default 40000, in the source note, editable in the profile form; older profiles get the default). Net earnings under it give no SE tax. Tests at 39,988 and exactly 40,000 cents. |
| SEC-74 | Medium (tax) | `tax.compute` | The simplified home-office deduction could create or increase a loss. It is limited to business income less the other business expenses and has no carryover. | Fixed: the deduction is capped at that figure (floored at 0); the Tax view says when it is limited, and the by-line table uses the limited figure. |
| SEC-75 | Low (tax) | `tax.compute` | The NJ estimate used the federal base (profit less half of SE tax). NJ allows no deduction for SE tax (it does not follow federal adjustments), so the NJ estimate was too low. | Fixed: the NJ base is the profit, floored at 0, shown as its own figure. Owner's accountant to confirm. |
| SEC-76 | Medium | `priv.bizMarks`, `tax.blocked` (deviation a) | Any private payee or business line of work set a wildcard mark that refused every year, and any link overlay did too. The mark list was capped at 40 extra names, so private business records spread over more than 39 years would make the whole state fail validation on the next load. | Fixed: a year is marked exactly when a business record of that year is private, or a public record of that year points at a private line of work, payee, invoice or parent line. While closed, a public money entry, trip or invoice that is new, changes year or changes line marks its years whenever hidden links exist (never under-refuses). Unscoped private entries with a line still count as business (can only over-refuse). Cap raised to 400 year marks. Tests both directions. |
| SEC-77 | Low | `tax.compute` reserve | A reserve account or its balance entries kept private gave a wrong reserve balance and set-aside gap while closed. | Fixed: mark `business-reserve`; the reserve and gap show "hidden while the private vault is closed". |
| SEC-78 | Medium | Export tab, tax print view (deviation b) | With the vault open the accountant export and print view included private records with no explicit choice. | Fixed: "Include private records" tick, default off, offered only while open. Off, the export uses the main state and refuses with a plain reason when a business record of the year is private, so no Schedule C total silently excludes private income; the file and print view say whether private records are included. |
| SEC-79 | Low | `business` invoice and settings guards | Invoice numbers had no secrets guard, and invoice lines, notes and the business details accepted an EIN shape (12-3456789). | Fixed: SSN, card and EIN shapes are refused in invoice numbers, lines and notes, business name, address and terms, and payee names. |
| SEC-80 | Low (performance) | `business.nextNumber` | Each candidate number scanned every invoice; at 5,000 invoices this ran on every Invoices render. | Fixed: one set per call. Caps test: 5,000 invoices of 50 lines, 10,000 trips and 50,000 entries validate and compute in about 0.9 s in Node. |
| SEC-81 | Low | "Next estimated payment" module | When a current or previous year refused, the module still showed a later year's date as "next". | Fixed: it refuses with the lock marker. |
| SEC-82 | Low | Admin timeline, open invoices and budget modules | No lock marker where private records change the numbers (tax rows omitted for a refused year, private invoices, private entries of the pinned line). | Fixed: markers added. |
| SEC-83 | Medium | `tax.blocked` | A public money entry may keep the id of a private line of work while closed (PV-2). Unscoped, it counted as personal, so the year's figures were partial without a refusal. | Fixed: such an entry refuses its year. |

Counts: 13 findings, all fixed with regression tests (High 1, Medium 6, Low 6). Tax-correctness findings: SEC-71 to SEC-75.

### Deviation verdicts
- (a) Wildcard refusal: wrong (over-refused, and missed SEC-83); fixed as SEC-76 and SEC-83.
- (b) Export including private records: wrong; fixed as SEC-78.
- (c) Derived scope instead of rewriting: acceptable. The migration writes nothing, the Business screen shows the counts and asks once, nothing is lost, and the counts are identical after a backup round trip, after validation of a synced copy and with the vault open; older apps refuse schema 12 and the downgrade guards list business marks and records. Residual: an entry left on "Automatic" follows its line's kind if the kind changes later; confirming while closed leaves private entries unscoped (treated as business by the marks).
- (d) homeOffice and taxYears in the main state: acceptable. homeOffice holds two integers per year; unknown fields are dropped. taxYears holds numbers, dates and two free-text fields (source note, 1,200 characters; mileage rate notes, 200), control characters stripped, inside the encrypted main state, never in the digest, prompt, audit or errors (tested). Caps: 30 years, 80 holidays, 24 rate periods; prototype keys refused.
- (e) Optional invoice line of work: acceptable. Line totals, aging and expected income do not depend on it; income without a line shows as Unassigned (tested).

### Leak check
`test/smoke-leaks.mjs` passes at desktop and 390x844: the adversarial marker in every new free-text field (invoice number, lines and notes, payee name, trip text, payment confirmation, business details, billable expense) never reaches a prompt, the digest, the audit log, an error, the console, the URL, storage, the IndexedDB bytes, a backup or a Drive upload; with records of every collection in the private vault and the vault closed, it is absent from every screen including every Business tab, the tax views refuse with the marker and the digest has no tax fields; open, it shows in the DOM only.

### Residual risks
- Every figure is an estimate: income tax uses effective rates the owner enters, figures are year to date and not annualised, and the safe-harbor targets use those year-to-date figures. The owner's accountant must confirm every number before any payment or filing.
- The 2026 defaults (Social Security wage base $184,500, mileage 72.5 cents from 2026-01-01 and 76 cents from 2026-07-01 with their IRS notice numbers, the 1099-NEC threshold $2,000, the holiday list) were taken from the builder's spec and were not independently verified by this audit. The owner should check each against its source.
- The W-2 field is used for both Social Security room and the Additional Medicare threshold. If W-2 Social Security wages (box 3) and Medicare wages (box 5) differ, the figure is approximate.
- The home office uses months used over 12 as an approximation of the monthly average of allowable square feet.
- 1099-NEC flags use the payee total only; exemptions (for example corporations) are the accountant's call.
- While the vault is closed, the mark list names the years that hold private business records (no counts, no names) to anyone with the main passphrase.

### Final results
`node --test test/` passes 580 of 580 in the default zone, TZ=America/New_York and TZ=Pacific/Auckland. `node build.mjs` succeeds. `node test/smokes.mjs` (17 scripts) passed twice in a row (Playwright with Chrome at /usr/bin/google-chrome).

### Not tested
Printing to PDF on a real printer driver, a physical phone, a real accountant reading the CSV, and tax figures against an actual filed return.

## v1.2.0 audit

Date: 2026-11-17. Auditor: independent review (did not write the code).

### Scope
The uncommitted v1.2.0 delta (`git diff HEAD` plus untracked files): part A, Activity CSV import (`activities.planImport/applyImport/importOffers/createExpenses`, `csv.exportActivities`, schema 13 `importKey`, the import card in `src/ui/app.js`); part B, vault archiving (`src/core/archive.js`, `src/ui/archive-ui.js`, schema 14 `archives` and `summaries`, the summary readers in metrics, revenue, goals, learning, activities and tax, `sync.putNamed/getNamed`, `priv.sealBox/openBox`, the downgrade guards in `store.droppedData`) and spell check off in `h()`. Checked against the hard rules, the private vault rules (v0.11.0), the sync rules, the v1.2.0 addendum parts A and B, SEC-01 to SEC-83, the CR, PV and UI series and docs/review/product-ops.md.

### Method
- Read the delta, then proved each finding with a failing test before fixing it. Regression tests: `test/v120-audit.test.mjs` (11 tests). One builder test encoded SEC-90 (a private import saved a row with an unknown category under the default one); it now expects the rejection, with the same rows then imported after the category is left blank. No assertion was removed or loosened.
- Failure injection (proof, `test/v120-audit.test.mjs`): `archiveYear` was made to fail at the write (envelope), the verify (decrypt returns one record fewer), the Drive upload, the Drive re-download (throws, or returns a valid archive of the same year from another vault), with Drive failing and the download not confirmed, and at the commit (storage refuses). After each, the live state, its revision and the stored envelope bytes were identical; the next run then succeeded in exactly one commit.
- Figures: the builder's comparison (every money month, revenue range and period, net worth history, cashflow, headlines, series, digest, goals, body metrics, streaks) was rerun with private records of the archived year (expenses, income, a balance, workouts, sleep, study sessions, a contact, an activity) while the vault is open and while it is closed, after a restore, and for business budgets and the accountant export.
- Crafted archive files: the builder's envelope tests were kept (iteration downgrade, tampered ciphertext and IV, swapped year, oversize, prototype keys, wrong kind, counts, hash, records of another year, backup and archive swapped) and extended with a tampered private part, a private part under a foreign salt, and no private key; the live data was unchanged after each.
- Leaks: `test/smoke-leaks.mjs` gained a private-vault archive step (records of every archived kind and a Wellbeing check-in in the private vault, archived through the screen with the vault open; the file, index, summaries, audit, marks, notices, prompts, digest, backup, Drive upload, storage, URL and IndexedDB bytes hold no marker; the Archive screen shows private records only while open). Markers contain spaces (`LEAK mark `), so base64 cannot match them by chance.
- Spell check: `test/smoke-archive.mjs` now checks the three attributes on every field of every tile, nav screen, Business tab and the private vault screen, not only the Archive screens; the source test in `test/archive.test.mjs` forbids any other way to make a field.
- The builder's smoke comparison excluded the "Some private items are hidden" notice and the "Entries (n)" heading. The notice exclusion hid SEC-85 (the closed views dropped the marker while the open view lost the private figures); it is removed and the comparison passes with the notice. "Entries (n)" is the record count of the domain entry list (the balance history on Assets), which archiving is meant to shrink; it hides no figure and stays excluded.
- Performance (Node, near caps: 49,900 entries with 300-character notes, 2,100 daily ticks): proposal 0.4 s, archiving one year 1.6 s (4.8 MB file), opening an archive 0.14 s, four searches 0.03 s, export copy 0.11 s.
- smoke-command runtime diagnosed (product-ops review, 287 s): `addMoney` in the test waits for `.entry[data-key] ...` (an element that exists only on the private vault screen) with a 15 s timeout before its fallback selector, nine times per viewport (about 135 s each). A test defect, not a product bug, so it was not changed.
- Re-checks: SEC-01 to SEC-83 and the CR, PV and UI fixes through the existing tests and smokes (all pass); spot checks of DOM sinks, inline styles, console, storage and URL use and em dashes in the delta: none.

### Findings

| ID | Severity | Location | Issue | Status |
|---|---|---|---|---|
| SEC-84 | Medium (data integrity) | `archive.plan` | A one-to-one money link could split across a year boundary: an activity done on 30 Dec with its expense paid on 3 Jan, or an invoice paid in December whose income entry is dated January, archived one half and left the other live. A later restore dropped the dangling link, so the "Add to Money" offer could create a second expense. | Fixed: a candidate whose linked partner stays live (activity expense, invoice income and billed expenses, a billed expense's invoice) stays too. Test SEC-84. |
| SEC-85 | High (archived figures) | `archive.archiveYear`, `priv` | Summaries held public records only. With the vault open, every figure of an archived year lost the private records' share (money months, categories, net worth history, revenue, goals); closed, the "Some private items are hidden" marker disappeared from views whose numbers still left private figures out. | Fixed: the private share (merged view minus public, numbers only) is stored inside the private vault's encrypted plaintext (`summaries`, validated as numbers only) in the same write, added to the view's summaries while open (never written to the main state), removed on restore, and the closed views keep their marker. Test SEC-85: open and closed figures identical after archiving and after restoring. |
| SEC-86 | Low (business view) | `business.budgetRow` | A project budget (all time) lost the archived years' expenses, so "actual" fell after archiving. | Fixed: it adds the archived months' project expenses from the summaries. Test SEC-86. |
| SEC-87 | Medium | `archive.exportState`, Archive screen | The accountant export of an opened archive was built from the merged view while the vault was open, so private records (live and archived) went into an export made without the "Include private records" tick (SEC-78 regression); closed, a year with private business records produced incomplete totals instead of the SEC-76 refusal. | Fixed: without the tick the copy is the main state plus the file's public records, and it refuses when the file's private part holds a business record (always while that part is sealed); "Include private records" is offered while the vault is open. Test SEC-87: the export matches the one made before archiving, refused or with the tick. |
| SEC-88 | Low | `archive.archiveYear` (Wellbeing) | Wellbeing check-ins had no anchors: archiving could remove the newest check-in (the check-ins-per-week goal turned from 0 to "no data") and break a daily run crossing into the next year. | Fixed: the newest check-in and a run ending 31 December that continues stay live. Test SEC-88. |
| SEC-89 | Low | `archive.restoreYear` | Restore ran with the private vault closed while it held records, so a restored record's link to a record moved in since then was dropped by validation. | Fixed: restore needs the vault open whenever it holds private records, like archiving. Test SEC-89. |
| SEC-90 | Low (data) | `activities.planImport` | A private import cannot create categories or health types; rows naming one were saved under the default category or without their type, with only a generic note. | Fixed: such rows are rejected with a reason (never echoing the cell) and the names are listed; nothing is saved without them. Test SEC-90; smoke-leaks checks the rejection on screen. |
| SEC-91 | Info | `csv.exportActivities` | The private-record filter in `toCsv` sees mapped copies, so it could not exclude a private activity if a caller passed the open view (the UI passes the main state). | Fixed: filtered before mapping. Test SEC-91. |
| SEC-92 | Low (UI) | `store.droppedData`, backup and sync dialogs, refusals | An older copy listed the archived years twice; the dialogs said "has no private vault" when the reason was archived years, and the refusal said the copy "has no archived years". | Fixed: listed once; the warning names each reason ("still holds years archived here (they would come back into the live vault)"); the refusal names what would be lost. Test SEC-92. |

Counts: 9 findings, all fixed with regression tests (High 1, Medium 2, Low 5, Info 1). Archiving findings: SEC-84, SEC-85, SEC-86, SEC-87, SEC-88, SEC-89, SEC-92.

### Verified as specified (no finding)
- Nothing leaves the live vault unless the file was written, decrypted back and matched by counts and SHA-256 (public and private parts), a verified copy exists (Drive re-download decrypted, or a download the user confirms), and the plan is unchanged inside the single commit.
- Nothing open, planned, unpaid, unbilled or referenced by a live record is archived (the fixed point over every id a remaining record holds, with the private link overlays applied while open; archiving refuses while the vault is closed and holds records). Accounts, projects, people, groups, goals, items, payees, properties, vehicles, categories, settings and tax profiles are never candidates. Learning sessions and contacts keep their newest per item and person.
- Archive files: own fresh salt and IV, 600,000 iterations, the main passphrase; the private part under the private key with a fresh IV. Archive and backup files are not interchangeable.
- Restore deduplicates by id and key, never overwrites, re-validates through `validateState`, and returns every figure.
- Older copies: sync download, sync conflict, backup restore and a schema 13 (v1.2.0-a) copy holding an archived year need the explicit tick; older apps refuse schema 14, so the index cannot be dropped by an older version.
- The proposal only offers; the size is the stored encrypted envelope; `archiveSuggestMB` is an integer from 20 to 60.
- Audit entries are "archived YYYY" and "restored YYYY" only; the Archive screen uses `h()` and `textContent`, no inline style, and is dropped on navigation and lock.
- Part A: one expense per activity on a tap, closed-vault refusal (PV-1), import as private only by its own tick (UI-5), ambiguous names credit nobody (SEC-57), the secrets guard and 200-character caps on title, place and notes, rejected reasons without cell text, and export then re-import adds nothing (formula-neutralised cells included).

### Residual risks
- A money pair whose halves fall in an already archived year and a later one stays live for good (never lost); restoring and archiving again moves it.
- A restore can be refused with "duplicate invoice number" if a new invoice took an archived invoice's number (typed or after the counter was reset); nothing is lost, and the owner renames one.
- The proposal's "frees about" figure counts public records only; with private records the real saving is larger.
- With private figures kept, the closed views show the lock marker in the domains whose archived years hold private figures for as long as those years stay archived, and the activity import asks for the vault to be opened.
- Planning walks every record; at caps the proposal is recomputed once per save (about 0.4 s in Node, slower on a phone).
- The baseline smoke run had one failure in smoke-home-admin (mobile, waiting for "Recurring item added."); it passed on every rerun, so it is recorded as a flake, not diagnosed.

### Not tested
Google Drive for real (all Drive calls are mocked), a physical phone, saving an archive to the NAS, archive files above about 5 MB in a browser, and Safari or Firefox.

### Final results
See "Final results (v1.2.0)" below.
