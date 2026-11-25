# The first-run tour (getting started guide)

Added on 25 Nov 2026, after v2.4.0. No schema change. Code: `src/ui/guide-ui.js` (the tour sits beside the setup steps page), two hooks in `src/ui/app.js`, one optional flag in `src/core/store.js`, styles after `.dialog.sheet` in `src/ui/styles.css`.

## What the owner sees
- The first time a vault opens on the Overview, with no dialog open, a card appears above the bottom bar (bottom right on a wide screen): "Getting started, 1 of 16", a title, two or three sentences, and Back, Next and Skip tour.
- Next opens each step's real screen and outlines the part it talks about. The screen behind the card stays usable.
- Steps, in order: Welcome; Overview; Key numbers; Shortcuts; Choose what shows (with Arrange and Quick add); Getting around (bar and More); Money; Assets; By country; Health and the eating log; Learning; Admin and taxes (tax estimates under Business, Tax); Weekly review; Settings; Drive sync; and a last step on the Getting started card in Settings, where it can be rerun.
- Finish returns to the Overview. Skip tour and Escape end it on the screen reached. Locking ends it.
- To see it again: Settings, Getting started, "Rerun getting started guide". The Getting started page (Open setup steps) also has "Take the tour".

## Rules
- It starts by itself once per vault. `settings.setup.tour` is set to true when it starts (by itself or from Settings), so it never starts by itself twice, on any device the vault syncs to. Absent means not yet. Only true or false is accepted.
- Older builds drop the flag when they save, so after a save from an older build the tour may start once more.
- Copy only: it never reads or shows a record, stores nothing else and makes no network call.
- A target that is not on screen (a hidden card) only drops the outline; the step still shows.
- Focus moves to Next and the outlined part scrolls into view only when the step changes, so a redraw mid-step does not move the page.

## Tests
- `test/tour.test.mjs`: the steps and their screens, first run, walking every step, Skip, Escape, lock, rerun, a missing target, the stored flag, the wiring and the built file.
- `test/smoke-tour.mjs`: the same in Chrome at desktop and 390x844 size. Every other smoke calls `skipTour(page)` from `test/_tour.mjs`, which presses Skip tour whenever the card is up before an action.
