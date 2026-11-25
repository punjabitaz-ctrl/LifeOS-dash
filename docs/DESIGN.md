# Shared design language, v1.1

One look, feel and flow for Resume Engine, ChannelVu and the LifeOS dashboard. The values live in `tokens.css`; each app keeps its own copy in its own format (plain CSS, Tailwind theme, single-file build), so change them here first and then in each app.

**What changed in v1.1 (Taz, Nov 25):** gold is the main button in both themes, because it is easier to find in light and dark. Every app gets an Auto, Light and Dark switch. More life: a navy top bar, a navy welcome card on the Overview with a faint gold glow, a colour per section, icon tiles and small trend lines on the key numbers.

## Where it comes from

- **tazabbas.com and ayinadvisors.com:** navy (#061325, #0d2742), warm paper (#faf7f0), gold (#c6a15c), Cormorant Garamond for titles and Hanken Grotesk for everything else, navy bands, quiet hairlines, generous space.
- **Modern SaaS tools (Linear, Stripe, Vercel, Notion):** white cards on a light canvas, one main action colour, numbers set in tabular figures, almost no borders, nothing that moves unless you touched it.
- **What each app asked for:** ChannelVu "blue and white as primary with green accents"; LifeOS "bright and modern 2026 SaaS"; Resume Engine "lighter, closer to the two sites".

## Palette

| Role | Light | Dark | Job |
|---|---|---|---|
| Band | #0d2742 navy | #04101f | Top bar and the Overview welcome card, navy in both themes |
| Ink | #061325 | #f3efe6 | Text |
| Canvas | #f8f7f3 with a faint gold wash at the top | #071425 | Page |
| Surface | #ffffff | #0d1e33 | Cards and dialogs |
| Action | #c6a15c gold, navy text | #ddbd7e, navy text | The one main button per screen, the current tab underline, the mark |
| Accent | #1f55d6 blue | #7aa2ff | Links, focus rings, selection, the first chart series. Never the main button |
| Good news | #0e7a4f text, #1fae76 fill | #5fd39e | Positive chips and deltas |
| Warning, danger | #8a5a12, #b3261e | #f0c060, #ff9a91 | Status chips, always with a word |
| Area colours | blue, gold, green, violet, coral, teal | lighter versions | One per section: its tab dot, icon tile and chart line |

Navy reads, gold acts, blue points, green says good. Navy on gold is 7.7:1 (light) and 10.3:1 (dark); every text pair meets 4.5:1 and input borders meet 3:1. Area colours are decoration only and never carry meaning alone.

## Theme switch

- Three choices in the top bar: **Auto** (follow the device, the default), **Light**, **Dark**. A segmented control with a sun, moon and screen icon; the chosen one is filled gold.
- The choice sets `data-theme="light"` or `"dark"` on `<html>`, or removes it for Auto. `tokens.css` handles all three, so no component is designed twice.
- Kept per device in local storage under the key `theme`. It is a display setting, not personal data. Set it before the first paint so the page never flashes the wrong theme.
- On phones the labels drop and only the icons show; each button keeps an accessible name.

## Type

- **Hanken Grotesk** for all interface text. Weights 400, 500 and 600 only.
- **Cormorant Garamond** for the page title (32px, 600), the Overview greeting (40px, with the name in gold italic) and the app wordmark only.
- Scale: 12 caption and table head, 13 label, chip and nav, 15 body, 17 card title, 20 section title, 28 key number (sans, 600, tabular figures), 32 page title, 40 greeting.
- Sentence case everywhere. No all-caps labels, no letter-spaced eyebrows, no em dashes.
- Fonts ship inside each app (SIL Open Font License); nothing loads from another site.

## Space and shape

- 4px steps: 4, 8, 12, 16, 20, 24, 32, 48.
- Card padding 20 (phone 16). Gap between cards 16. Gap between sections 32.
- Radius 8 for buttons and inputs, 14 for cards and dialogs, pill for chips and the theme switch.
- One soft shadow on cards (`--shadow-1`); a deeper one (`--shadow-2`) for things that float and for a hovered key number, which also lifts 1px.
- Content width caps at 1200px.

## Components

- **Top bar.** Navy band, 60px. Gold ring mark and serif wordmark on the left; search, the theme switch and the account on the right.
- **Section tabs.** White strip under the top bar. Each tab has its area colour dot; the current tab is ink, 600, with a 2px gold underline and `aria-current`. On phones, a bottom bar of four or five sections plus More, with a gold bar over the current one.
- **Welcome card (Overview only).** Navy band, radius 14, a soft gold glow and a thin gold ring in the top right. Date in muted text, the greeting in serif, one sentence on what needs attention, and on the right a quiet Customize and the gold primary button.
- **Buttons.** Primary: gold fill, navy text, 40px tall (44 on phones), darker gold on hover. Secondary: surface fill with a `--line-strong` border. Quiet: text only, muted. Danger: red text, red fill only inside a confirm dialog. Label is a verb, sentence case.
- **Cards.** Surface, 1px hairline, radius 14, `--shadow-1`. Title 17/600 in sans, an optional one-line description in muted text, a blue "View all" link on the right when there is more.
- **Key numbers.** An icon tile tinted in the area colour, the label beside it, the value 28/600 tabular, then a status chip and a small trend line in the area colour. Four to a row on desktop, two on phones (trend line hidden on phones).
- **Inputs.** Label above in 13/500. 40px tall, radius 8, `--line-strong` border. Focus: blue border plus a 3px `--accent-soft` halo. Hints in 12 muted under the field.
- **Tables.** No vertical lines. Hairline between rows, a sunken rounded header row in 12/600 muted, an initials avatar in the area colour where a row is a person or client, numbers right-aligned in tabular figures, row hover `--surface-2`.
- **Chips and status.** Pill, 12.5/600, soft tint with the matching ink and a small dot, plus a word ("Paid", "Overdue"). Never colour alone.
- **Charts.** Rounded bars, hairline gridlines, the current period in gold and earlier periods in the area colour, a small legend under the chart, an `aria-label` that says what the chart shows.
- **Empty states.** An icon tile, one sentence that says what goes here and one gold button that adds the first one.
- **Dialogs.** Radius 14, `--shadow-2`, title in sans 20/600, primary action bottom right, Cancel as secondary.

## Flow rules

1. **Same shell everywhere.** Navy top bar, section tabs, then the page. The page starts with the same header: the title in serif, one line of description, and on the right at most one gold button with secondary actions beside it as quiet buttons.
2. **One gold button per screen.** If two things feel primary, one of them is secondary.
3. **Overview first.** Each app opens on a single pane: the welcome card, key numbers, then the few cards that need attention, everything else one tap away.
4. **Show less, reveal on demand.** Long forms fold into sections, rare settings sit behind "More options", help text sits under a field only when the field is not obvious.
5. **Whitespace instead of lines.** Group with space first; add a hairline only where space is not enough. No card inside a card.
6. **Say status in words.** Colour supports the word, never replaces it.
7. **Nothing moves on its own.** Transitions are 180ms and only answer a touch; `prefers-reduced-motion` turns them off.
8. **The person picks the theme.** Auto by default, Light and Dark one tap away, remembered on that device.

## Per app

- **Resume Engine:** keeps its cream, navy and gold, including gold buttons; gains the navy top bar, the theme switch and a dark theme.
- **ChannelVu:** its blue (#0b5fe0) moves to the shared #1f55d6 for links and selection, green stays for good news, the main button turns gold, neutrals warm up a step, Inter gives way to Hanken Grotesk, page titles take the serif, the top bar turns navy, and Import, Shopify mapping and Settings move to the right end of the tabs.
- **LifeOS:** the indigo-to-violet gradient goes; the main button turns gold, links and focus turn blue, the violet brand square becomes the gold mark, the top bar turns navy, weights drop from 800 to 600, uppercase tile labels become sentence case, and the Overview gains the welcome card.

## In LifeOS

- Tokens: the first two lines of `src/ui/styles.css` (the names the tests check: `--bg`, `--card`, `--fg`, `--mut`, `--line`, `--acc`, `--ok`, `--warn`, `--bad`) and the block that starts `/* Shared design language v1.1`. LifeOS names: `--act` is the gold action, `--acc` the blue accent, `--band` the navy band, `--t0` to `--t5` the area colours.
- Dark blocks are written once, as `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){...}}`; `build.mjs` (`darkTheme`) repeats their tokens under `:root[data-theme=dark]` for the switch.
- Theme switch: `src/ui/theme.js`, loaded before `app.js`. It keeps one value (`light` or `dark`; nothing for Auto) under the key `lifeos-theme` in local storage, so the lock screen opens in the chosen theme. No personal data is stored there.
- Fonts: `src/fonts` (SIL OFL), built into the page as data: fonts; the CSP gains `font-src data:` and nothing else.
- Tests: `test/design.test.mjs`.
