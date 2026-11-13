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
