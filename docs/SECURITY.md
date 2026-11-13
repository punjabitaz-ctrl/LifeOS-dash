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
