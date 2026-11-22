# Passphrase recovery

LifeOS v1.8.0 adds an optional recovery key for the main vault and a separate one for the private vault.

## What a recovery key is

A recovery key is 256 random bits written as 14 groups of 4 letters and digits (the last group is a checksum, so a typo is caught before anything is tried). It is made on the device, shown once, and checked by asking you to type it again (all of it, or its last two groups).

LifeOS does not store the key. It is not saved on the device, in Drive, in a backup, in diagnostics, in the history or in the address bar, and the app never copies it to the clipboard.

## What each key opens

- The main recovery key opens the main vault only.
- The private recovery key opens the private vault only.
- Neither key opens the other vault. Neither is a passphrase for the other vault.

## How it works

Each vault has a random data key. The data key is wrapped (encrypted) under the passphrase, and, when a recovery key is on, under the recovery key too. The file holds the wraps. Opening with either one gives the same data key. The data key cannot be exported from the browser once it is open.

## Turn it on, replace it, turn it off

In Settings, "Recovery key (main vault)", and on the private vault screen, "Recovery key (private vault)". Each action asks for the passphrase and replaces the data key. A replaced or removed key stops opening the current vault.

A passphrase change replaces the data key as well. With a recovery key on, it asks for the current key (to keep it) or makes a new one.

## How to keep a key

On paper, offline. Not as a photo, a scan, a screenshot or a note in the cloud or a password manager that syncs. The recovery sheet (Settings, "Recovery sheet") has boxes to write it by hand.

## If a key may have been seen

Replace it in Settings (the old key stops opening the current vault). Then export a fresh backup and delete old backups, Drive copies and archive files: a copy made earlier still opens with the key that was in force when it was made.

## Use a key when the passphrase is forgotten

On the lock screen choose "Use recovery key", type the key, then set a new passphrase. A new recovery key is shown and must be typed again. The key that was used stops working. The private vault has the same path on its own screen.

Wrong recovery keys wait the same delays as wrong passphrases: 1 second, doubling up to 30 seconds.

## Copies

Every sealed copy carries the wraps: the stored vault, backups, Drive copies, archive files and private archive boxes. A Drive copy is the stored file as it is. A backup or an archive file is sealed under its own passphrase; when a recovery key is on, the key is typed at export so the file also opens with it. The key is checked against the vault and not kept.

A copy made before a key was replaced or turned off still opens with what was in force when it was made.

To use a key on a copy: on the lock screen, "Restore from a backup file" has a box to open the backup with the main recovery key it carries; the restored vault then gets a new passphrase and starts with no recovery key. The archive Open and Restore dialogs have a field for the main recovery key a file carries, for a file made under an earlier main passphrase. A Drive copy at the sync prompt opens with its passphrase only.

## Older versions

A v1.7.0 app opens a v1.8.0 file with the passphrase, sees a newer format and refuses it with its newer-version message. It does not overwrite the file. A v1.7.0 file opens in v1.8.0 and is written in the new format on the next save.

## The recovery sheet

Settings has a printable recovery sheet. It prints without the key and has 14 boxes to write it by hand. After a key is turned on, a box offers to include that key on the sheet; it is off unless ticked. Printers and print queues may keep a copy of what they print.

## If both are lost

If the passphrase and the recovery key are both lost, the data cannot be recovered by anyone.
