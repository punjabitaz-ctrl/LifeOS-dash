# Google Drive sync setup

You do this once. It uses your own Google Cloud project, so no one else holds your credentials.

1. Go to https://console.cloud.google.com and sign in with the Google account whose Drive will hold the vault.
2. Create a project (for example "LifeOS sync") from the project picker at the top.
3. Open APIs and Services, then Library. Search for "Google Drive API" and press Enable.
4. Open APIs and Services, then OAuth consent screen. Choose "External", fill in an app name (for example "LifeOS") and your email address for support and developer contact, and save.
5. On the Scopes step, add nothing. LifeOS asks for the Drive app-data scope at sign-in.
6. On the Test users step, add your own Google account as the only test user. Leave the publishing status on "Testing". Do not publish the app.
7. Open APIs and Services, then Credentials. Press Create credentials, then OAuth client ID, and choose application type "Web application".
8. Under Authorised JavaScript origins, add the origin of the site that serves LifeOS, for example `https://lifeos.example.com` (no trailing slash, no path).
9. Under Authorised redirect URIs, add the full address of the LifeOS page, for example `https://lifeos.example.com/`. It must match exactly, including the trailing slash if there is one.
10. Create the client and copy the Client ID (it ends in `.apps.googleusercontent.com`). You do not need the client secret and LifeOS never asks for it.
11. Open LifeOS over https, unlock, go to Settings, then Google Drive sync. Paste the Client ID and press Save client ID.
12. Press Connect Google Drive, approve the consent screen (Google warns the app is unverified because it is in testing mode, which is expected for your own project), then unlock again when you return.
13. Press Sync now. The first sync uploads your encrypted vault. On a second device, create or unlock a vault, paste the same Client ID, connect, and press Sync now. You will be asked for the passphrase of the Drive copy once.

## Limits, stated plainly

- The Google sign-in token lasts about an hour and is kept in memory only. Reconnect each session (after closing the tab or after it expires).
- Sync is manual. Nothing syncs in the background. LifeOS offers to sync after you unlock if you are connected, and you can press Sync now any time.
- Google stores only the encrypted vault, in a hidden app folder of your Drive that other apps cannot see. It never sees your data or your passphrase. If you lose the passphrase, neither you nor Google can recover the data.
- If both devices changed, LifeOS never merges. You pick one copy, and the other is saved to a file first.
- While the app is in testing mode, Google may expire its authorisation after seven days. Reconnect if sign-in fails.
- If you change your passphrase on one device, the Drive copy still uses the old one until you sync again, and other devices need the old passphrase once to read it.
- Sync is only offered over https (plus localhost for testing).
