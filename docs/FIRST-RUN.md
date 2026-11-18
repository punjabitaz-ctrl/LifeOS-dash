# First real run: checklist

Fill this in during your first real run on your phone and your PC. Nothing here is automatic. Write results in the Result lines; leave a line empty if a step was not done. Nothing in this file should hold a passphrase, a token or a client secret.

Date of run: ____________  Device (phone): ____________  Browser: ____________  Device (PC): ____________  Browser: ____________  Version shown in Settings: ____________

## 1. Storage
- [ ] Unlock on the phone, open Settings, Storage and backup safety. Status reads "kept by the browser" or "may be cleared by the browser".
  - Result (phone): ____________
- [ ] Same on the PC.
  - Result (PC): ____________
- [ ] If it says "may be cleared", note what you did (bookmark, install, use the page again, back up) and the status afterwards.
  - Notes: ____________

## 2. Backup and verify on a second device
- [ ] On the first device: Settings, Export backup. Note the file name and the revision shown under Last backup.
  - Result: ____________
- [ ] Move the file to the second device (a cable, a share or your NAS; not through a service that reads files you do not control).
- [ ] On the second device: Settings, Verify a backup file, enter the backup passphrase. The schema, revision, date and counts show.
  - Result: ____________
- [ ] Optional restore drill on a throwaway vault in a separate browser profile on the second device (Import backup replaces the vault it runs in, and the lock screen cannot make a second vault): Import backup, check the counts match.
  - Result: ____________
- [ ] Reminder: the banner shows after the number of days you set. Try 1 day once, then set it back to 7.
  - Result: ____________

## 3. Google Drive sync, one in each direction (docs/SYNC-SETUP.md)
- [ ] Authorised origin and redirect URI added for the live address; after an Access sign-in, Connect Google Drive lands back in LifeOS.
  - Result: ____________
- [ ] Sync now on device A uploads.
  - Result: ____________
- [ ] Sync now on device B downloads (it asks for the Drive copy passphrase if the key differs).
  - Result: ____________
- [ ] Change something on B, Sync now, then Sync now on A shows the change.
  - Result: ____________

## 4. One real AI call in each mode
- [ ] Manual mode: copy the prompt into your own AI chat, paste the reply, proposals appear.
  - Result: ____________
- [ ] API mode (own key): one call; proposals appear; the key shows only its last 4 characters.
  - Result: ____________

## 5. Live header check
- [ ] Create a Cloudflare Access service token for this check (Zero Trust, Access, Service Auth) and add a policy that allows it on the LifeOS application. Keep the token out of the repo and out of chat.
- [ ] Run: `CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... node scripts/check-live.mjs`
  - Output (PASS or the mismatches): ____________
- [ ] Cloudflare dashboard settings recorded (Worker name, repository and branch, build command, assets directory, Access application and policy):
  - Notes: ____________

## 6. Diagnostics
- [ ] Settings, Copy diagnostics, paste it somewhere you can read it. It holds codes, version, schema and browser family only.
  - Result: ____________

## Anything else
____________

New device (v1.4.0): on the lock screen of a device with no vault choose Restore from a backup file (pick the file, enter its passphrase, check the counts, then confirm) or Use my Google Drive copy (client ID, sign in, download, enter the passphrase). Neither needs a throwaway vault.
