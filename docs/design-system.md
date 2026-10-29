# pitwall design system

pitwall's design system is inspired by Hookdeck's UX. It's pitwall's own design system, not Hookdeck's, and it uses no Hookdeck logos, illustrations or other artwork.

- **Status:** applied in M3, merged into `main` on 2026-10-23 ([PR #51](https://github.com/leggetter/pitwall/pull/51)). The tokens, type, radii, edges, focus ring, theme switch and icons are in the web UI (W20), and so is the shell: the header, the three columns, the repo list and the filters (W21), then the two-line session rows, the badges, the connection badge, the Finished section and the Sort setting (W23), then the session view: its column and overlay, the divider, its header and actions menu, the menu component, the tabs, the footer and `?session=` (W22), then buttons' disabled and busy states, the spinner, inline alerts, the page alerts and the app strip, the message box, key caps and inline confirmations (W24), then tooltips, toasts, the dialog and the New session dialog on it, copy buttons and command chips, and timestamps on one clock (W25), then the single-key shortcuts, the keyboard shortcuts dialog with their off switch, the filter field's `/` key cap and the header's keyboard button (W26), then the conversation: speaker lines with their times, folded tool calls, Load earlier and Jump to latest (W27), then the waiting, empty and error states: skeletons and the long-wait line before the first snapshot, `EmptyState` for every empty state, the session view's waiting and unlisted states, and the conversation's errors with Try again (W28), then the terminal: its bar on `Badge`, `KeyCaps` and `Button`, the screen's font and colours from the tokens and its edge, F6 to leave it, its notices as inline alerts, and the conversation's place kept across the Terminal tab (W29), then the fixes from the integrated branch's review (W31), then sessions under the repos they worked in: distinct counts, the root's group, line 2's start label and the session view's worked-in line (W34), then hiding a repo or directory from the repo list: the session list header's Hide from repo list and the Hidden section at the list's foot (W35), then markdown in the session view: Claude's messages and other sessions' as pitwall's own elements, and your prompts as typed (W36), then links in code: bare URLs in code blocks and inline code open as links (W37), then each session in one group, the one it started in, with the repos it worked in in the session view and the filter, which replaces W34's listing under those repos, its start label and its distinct counts (W39), then roots as tabs: with two or more roots, a tab per root in the header, each narrowing the columns to its root, with its own place, and a need-you badge on the tabs that aren't open (W38), then Shift+Enter in the terminal: a line feed, a new line in Claude Code's prompt (W41), then the page notices: No token and Token rejected say how to bring a tab back, and an interactive session's actions menu has Stop session, off, saying how `/bg` makes it possible (W40), then View preferences: a header menu to group sessions by Main repo, the default, Where it started, or Every repo it worked in, which the page applies to the snapshot itself, and a menu's radio group (W42), then a draft kept through a reload, and its warning (W44), the relay alert worded by its cause (W43), the terminal's steady cursor (W45), messages to pitwall-relay in the conversation and the footer's status line (W46), the session view's notes on what to do (W47), the page notices' two ways back with a fixed token (W51), the relay's quiet retry, the repeated alert and Delivered after a retry (W52), and questions asked in a dialog (W49), then starred sessions: a star toggle on each row and in the session view, the repo list's Starred view, and `s` (W53), then links that ask first: a link in a message whose text isn't its own address asks before it opens, naming its host, and a URL with a username or password before its host is text (W55), then running background sessions opening on the Terminal tab, which attaches, a wait before attaching when stepping onto one, and View preferences' Open running background sessions on (W54), then Preferences: a dialog with a section for each area a setting affects and a radio group for each setting, in place of the View preferences menu, with the terminal's keyboard setting, and the radio group (W59), then Preferences at 624 px, without the single-key shortcuts and the theme, which have controls of their own (W62); and in M3.1, a session started from New session selected once it's listed: its root tab, its group and its view, or a toast with Open when that would take over what you're in the middle of (W63), then ended interactive sessions: muted in their group's Finished section, labelled Ended, those older than 7 days behind Show older, and the session view's Resume in background and Copy command (W67), then Needs you from each session's context: the index's `needsYou` decides Needs you, its counts, the sort and the solid badges, with Waiting for your prompt after a restart you asked for, a background job's own line on its row, and a blocked job that needs nothing shown as idle (W69), then Open in an editor: the session view's actions menu has Open in VS Code and Open in Cursor, one for each editor pitwall's server found, with a toast for the result (W72), then sub-agents in the session view: its Sub-agents tab, a sub-agent's transcript, the conversation naming them by description, and the row's running count (W77); and after M3.1, End session for a running interactive session: in its actions menu, in Stop session's place, with its inline confirmation, the stronger warning for one that's working, and a toast (W90); and in M4, your open pull requests: the repo list's Pull requests item and its badge, the PR list with its repo headings, collapsed and remembered, and Show older, the PR view in the session view's place, Refresh, each source state, the session row's PR badge and the session view's PR links (W95), then Refresh at most once a minute (W100), and the PRs that ask your review or mention you: their badges, the PR list's chips Yours, Review requested and Mentioned, their empty states and the PR view's sentence (W101), then a row is a piece of work: session rows carry the PRs they own, a PR no session owns is a row under its repo, cloned or not, Needs you and Finished follow a session's open PRs, Has PR among the chips, the Pull requests view of every row with an open PR in place of the PR list, and the session view's Pull requests tab (W106); then the working line at the end of the conversation: Working, the time since the turn began and its step, or what it waits on you for and where to answer, fetched every 2 s while it works, and announced once each (W102). W21 to W29 rebuilt the components to the shapes and layouts in sections 3 and 4. [Mapping from the CSS before M3](#215-mapping-from-the-css-before-m3) records how M2's styles moved onto the tokens.
- **Scope:** the web UI in `web/`. The CLI's terminal output isn't covered.
- **Living reference:** the `#uikit` gallery. Run `npm run dev` and open `http://127.0.0.1:4517/#uikit`.
  - It renders every component the web UI has today, in every state. Its toolbar has the app's own [theme switch](#theme-switch), so it shows and stores the theme the app uses. Components in section 4 that aren't built yet join it as they're built.
  - It uses the real components from `web/src/components/` with made-up fixtures and stubs (`web/src/uikit/`). It doesn't need the token, and makes no API or WebSocket calls.
  - It's in dev builds only: `npm run dev` builds in Vite's development mode, and `npm run build` leaves the gallery out, which `web/src/uikit/build.test.tsx` checks.
  - A specimen put into its state by using it, such as a menu opened or a tooltip hovered, has a scenario that does that once it's on screen (`web/src/uikit/kit.tsx`). Each of its steps waits up to 3 s of looking for what it brought about. A wait between two looks longer than a long task's 50 ms counts as 50 ms: the page was busy elsewhere, such as rendering the other specimens, or the machine was, so nothing looked (W71). A scenario that doesn't finish says so on its specimen, and `web/src/uikit/route.test.tsx` fails, naming the specimen.
  - **Every M3 PR adds the components and states it introduces to the gallery.** Where this doc and the gallery disagree, fix whichever is wrong in the same PR.
- **How to read it:** every rule is written so it can be built from this doc alone. Values are exact. Where a value is a choice rather than a requirement, the reason is given.

## Contents

1. [Principles](#1-principles)
2. [Tokens](#2-tokens)
3. [Layout shell](#3-layout-shell)
4. [Components](#4-components)
5. [Content](#5-content)
6. [Accessibility and keyboard](#6-accessibility-and-keyboard)
7. [Open questions](#7-open-questions)

---

## 1. Principles

- **Dense.** A 14 px body, tight rows, one line where one line will do. The point is to scan every session at once.
- **Live.** The list updates in place and shows freshness quietly. Nothing moves under the reader while they're reading it.
- **Calm.** Neutral surfaces and one accent colour. Motion only explains a change; it never decorates.
- **Exceptions only.** Loud colour is for what needs you. Healthy and idle states stay quiet.
- **Accessible.** WCAG 2.2 AA: 4.5:1 for text, 3:1 for control edges and indicators, full keyboard use, real semantics, and reduced motion respected.

---

## 2. Tokens

### 2.1 How tokens work

- **One file:** `web/src/tokens.css`, imported before any other CSS. Every colour, size and duration in the UI comes from a `--pw-*` custom property. Component CSS never uses a raw hex value or pixel size that has a token.
- **Named by role, not by colour:** `--pw-surface`, `--pw-text-muted`, `--pw-danger-tint`. A component says what a colour is for, and the theme decides what it looks like.
- **Three groups:**
  - **Structure:** type, space, radii, sizes, layers, motion. The same in light and dark.
  - **Colour and elevation:** one set for light, one for dark.
  - **State aliases:** pitwall's session states (`--pw-state-busy-bg` and so on), defined in terms of the tone tokens, so the restyle can change a state's look in one place.
- **Tones:** five tones (neutral, info, success, warning, danger), each with six tokens:

| Token | Use |
|---|---|
| `--pw-<tone>-fg` | Text or a dot in that tone, on a neutral surface |
| `--pw-<tone>-solid` | A filled badge or button |
| `--pw-on-<tone>-solid` | Text on that fill |
| `--pw-<tone>-tint` | A tinted container: subtle badge, alert, row tint |
| `--pw-<tone>-tint-fg` | Text in that tone, on that tint |
| `--pw-<tone>-border` | The 1 px edge of a tinted container (decorative) |

- **Where colours may go:**
  - `-fg` tokens sit only on the neutral surfaces: `--pw-bg`, `--pw-surface`, `--pw-surface-muted`, `--pw-surface-sunken`, `--pw-surface-hover`, `--pw-surface-hover-bg`, `--pw-surface-overlay` and `--pw-selected`. On a tinted container, use that tint's `-tint-fg` instead.
  - `--pw-surface-strong` is a fill for pressed and active states. Only `--pw-text`, `--pw-text-muted` and `--pw-text-subtle` go on it.

### 2.2 Themes and switching

- **Modes:** System (the default), Light and Dark. The choice is stored in `localStorage` under `pitwall.theme.v1`, as `system`, `light` or `dark`, next to pitwall's other `pitwall.*.v1` keys.
- **The resolved mode lives on `<html>`:** `data-theme="light"` or `data-theme="dark"`. CSS only ever reads the resolved mode. System is resolved in JavaScript with `matchMedia('(prefers-color-scheme: dark)')`, and the app listens for its `change` event while System is chosen.
- **Pre-paint script:** `web/public/theme-init.js`, loaded with a plain blocking `<script src="/theme-init.js"></script>` in `<head>`, before the stylesheet.
  - It reads the stored choice, resolves System, and sets `data-theme`, so the first paint is already in the right mode.
  - It must be a same-origin file, because the CSP (`default-src 'self'`, set in `src/server/security.ts`) blocks inline scripts.
  - It must not throw when `localStorage` is blocked: wrap the read in `try`, and fall back to System.
  - In a browser with no `matchMedia`, System leaves `data-theme` unset, so the fallback below follows the system.
- **After the first paint,** `web/src/theme.ts` keeps `data-theme` right: it applies a new choice, and follows the system's `change` event while System is chosen. One store holds the choice, so every switch on the page shows the same one. `main.tsx` starts it with the app, so a page with no switch, such as the token notice, still follows the system. `web/src/theme.test.tsx` runs `theme-init.js` against the same cases and checks the two agree.
- **Without JavaScript,** or if the script fails, no `data-theme` is set. Then `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { … } }` applies the dark block.
  - That block is a copy of the `:root[data-theme='dark']` block. Keep the copy generated, or add a unit test that parses `tokens.css` and checks the two blocks are identical.
- **`color-scheme`:** set to `light` or `dark` in each block, so native controls and scrollbars match. Keep `<meta name="color-scheme" content="light dark">` in `web/index.html`.
- **The switch:** a three-option theme control in the header (see [Theme switch](#theme-switch)). Changing it writes the key, updates `data-theme`, and takes effect without a reload.
- **The terminal stays dark** in both modes for now (see [Terminal](#terminal)).

### 2.3 Colour roles

| Token | Light | Dark | Use |
|---|---|---|---|
| `--pw-bg` | `#FAFAF8` | `#141412` | The page: the header and the repo list |
| `--pw-surface` | `#FFFFFF` | `#191917` | The session list and its rows, the session view, inputs, cards |
| `--pw-surface-muted` | `#FAFAFA` | `#1D1D1B` | The session view's footer band, code blocks |
| `--pw-surface-sunken` | `#F5F5F5` | `#222220` | Skeleton bars, key caps, disabled fields, the user's messages |
| `--pw-surface-strong` | `#EBEBEB` | `#353533` | Pressed and active fills only |
| `--pw-surface-hover` | `#F5F5F5` | `#272725` | Hover on something that sits on `--pw-surface` |
| `--pw-surface-hover-bg` | `#EBEBEB` | `#222220` | Hover on something that sits on `--pw-bg` |
| `--pw-surface-overlay` | `#FFFFFF` | `#1D1D1B` | Dialogs, menus, tooltips, toasts |
| `--pw-selected` | `#E5ECFA` | `#001B52` | The open session's row, pressed filter chips |
| `--pw-selected-border` | `#0044CC` | `#668FE0` | The 1 px ring around a selected item; a checked checkbox's fill (see [Inputs](#inputs-textareas-and-selects)) |
| `--pw-highlight` | `#FFEB99` | `#665200` | Filter matches inside text |
| `--pw-backdrop` | `rgb(0 0 0 / 0.1)` | `rgb(0 0 0 / 0.5)` | Behind a dialog |
| `--pw-text` | `#141412` | `#F5F5F5` | Body text, names, titles |
| `--pw-text-muted` | `#52504A` | `#CCCCCC` | Secondary text: titles after a name, previews, help text |
| `--pw-text-subtle` | `#6A6860` | `#9D9D9D` | Tertiary text: times, paths, placeholders, kind |
| `--pw-text-disabled` | `#A3A093` | `#525252` | Disabled controls only (exempt from contrast, see [2.5](#25-contrast)) |
| `--pw-text-inverse` | `#FFFFFF` | `#141412` | Text on `--pw-text` (the app strip) |
| `--pw-border` | `#EBEBEB` | `#2C2C2A` | Dividers between rows and sections (decorative) |
| `--pw-border-strong` | `#E0E0E0` | `#3E3E3D` | Card edges where a divider isn't enough (decorative) |
| `--pw-border-dashed` | `#CCCCCC` | `#3A3A38` | Dashed outlines: not-running badges, placeholders |
| `--pw-border-control` | `#8C897E` | `#6E6E6C` | The edge of outline buttons, chips, the theme switch |
| `--pw-border-input` | `#8C897E` | `#6E6E6C` | The edge of text fields, textareas and selects |
| `--pw-accent` | `#0044CC` | `#0044CC` | Primary button fill. Not a checkbox's fill: dark `--pw-accent` is 2.26:1 on `--pw-surface`, under the 3:1 a state indicator needs |
| `--pw-accent-hover` | `#0036A3` | `#3369D6` | Primary button hover; the primary button's ring |
| `--pw-on-accent` | `#FFFFFF` | `#FFFFFF` | Text on the accent |
| `--pw-link` | `#0044CC` | `#668FE0` | Links and link buttons |
| `--pw-focus` | `#3369D6` | `#668FE0` | The focus ring |
| `--pw-warning-indicator` | `#997A00` | `#CCA300` | The left bar of a row that needs you |

### 2.4 Tone tokens

| Tone | Token | Light | Dark |
|---|---|---|---|
| **neutral** | fg / solid / on-solid | `#52504A` / `#F5F5F5` / `#141412` | `#CCCCCC` / `#222220` / `#F5F5F5` |
| | tint / tint-fg / border | `#F5F5F5` / `#141412` / `#EBEBEB` | `#222220` / `#F5F5F5` / `#2C2C2A` |
| **info** | fg / solid / on-solid | `#0044CC` / `#0044CC` / `#FFFFFF` | `#668FE0` / `#0044CC` / `#FFFFFF` |
| | tint / tint-fg / border | `#E5ECFA` / `#0044CC` / `#CCDAF5` | `#001B52` / `#99B4EB` / `#0036A3` |
| **success** | fg / solid / on-solid | `#007A3D` / `#008040` / `#FFFFFF` | `#66B38C` / `#006633` / `#F5F5F5` |
| | tint / tint-fg / border | `#E5F2EC` / `#006633` / `#CCE6D9` | `#00331A` / `#99CCB3` / `#006633` |
| **warning** | fg / solid / on-solid | `#665200` / `#FFCC00` / `#141412` | `#FFE066` / `#CCA300` / `#141412` |
| | tint / tint-fg / border | `#FFF5CC` / `#332900` / `#FFE066` | `#332900` / `#FFE066` / `#665200` |
| **danger** | fg / solid / on-solid | `#CC2314` / `#CC2314` / `#FFFFFF` | `#E07B72` / `#A31C10` / `#F5F5F5` |
| | tint / tint-fg / border | `#FAE9E7` / `#CC2314` / `#F5D3D0` | `#520E08` / `#EBA7A1` / `#7A150C` |

Code and terminal colours:

| Token | Light | Dark |
|---|---|---|
| `--pw-code-boolean` / `-string` / `-number` / `-null` | `#0036A3` / `#006633` / `#665200` / `#A31C10` | `#668FE0` / `#66B38C` / `#FFE066` / `#E07B72` |
| `--pw-term-bg` / `-fg` / `-cursor` | `#141412` / `#F5F5F5` / `#F5F5F5` | same |
| `--pw-term-selection` | `rgb(102 143 224 / 0.35)` | same |
| `--pw-term-red` / `-green` / `-yellow` / `-blue` | `#E07B72` / `#66B38C` / `#FFE066` / `#668FE0` | same |

### 2.5 Contrast

WCAG 2.x contrast ratios for the values above, checked by `web/src/contrast.test.tsx`, which reads `tokens.css`.

- **Ratio shown:** the *worst* case across every background the token is allowed on (see [2.1](#21-how-tokens-work)), with that background in brackets.
- **"Every surface and tint":** `--pw-bg`, `--pw-surface`, `--pw-surface-muted`, `--pw-surface-sunken`, `--pw-surface-strong`, both hovers, `--pw-surface-overlay`, `--pw-selected`, and all five `-tint` tokens. The overlay has the same value as `--pw-surface` in light and `--pw-surface-muted` in dark, so it changes no ratio below.
- **"Neutral surfaces":** the same list without `--pw-surface-strong` and the tints.

| Pair | Light | Dark | Needs |
|---|---|---|---|
| `--pw-text` on every surface and tint | 15.47 (hover-bg) | 11.27 (strong) | 4.5:1 |
| `--pw-text-muted` on every surface and tint | 6.76 (hover-bg) | 7.65 (strong) | 4.5:1 |
| `--pw-text-subtle` on every surface and tint | 4.68 (hover-bg) | 4.53 (strong) | 4.5:1 |
| `--pw-link` on neutral surfaces | 6.53 (hover-bg) | 4.68 (hover) | 4.5:1 |
| `--pw-neutral-fg` on neutral surfaces | 6.76 (hover-bg) | 9.32 (hover) | 4.5:1 |
| `--pw-info-fg` on neutral surfaces | 6.53 (hover-bg) | 4.68 (hover) | 4.5:1 |
| `--pw-success-fg` on neutral surfaces | 4.57 (hover-bg) | 5.98 (hover) | 4.5:1 |
| `--pw-warning-fg` on neutral surfaces | 6.36 (hover-bg) | 11.48 (hover) | 4.5:1 |
| `--pw-danger-fg` on neutral surfaces | 4.61 (hover-bg) | 5.16 (hover) | 4.5:1 |
| `--pw-neutral-tint-fg` on `--pw-neutral-tint` | 16.92 | 14.62 | 4.5:1 |
| `--pw-info-tint-fg` on `--pw-info-tint` | 6.56 | 7.89 | 4.5:1 |
| `--pw-success-tint-fg` on `--pw-success-tint` | 6.19 | 7.82 | 4.5:1 |
| `--pw-warning-tint-fg` on `--pw-warning-tint` | 13.16 | 11.05 | 4.5:1 |
| `--pw-danger-tint-fg` on `--pw-danger-tint` | 4.68 | 7.42 | 4.5:1 |
| `--pw-on-neutral-solid` on `--pw-neutral-solid` | 16.92 | 14.62 | 4.5:1 |
| `--pw-on-info-solid` on `--pw-info-solid` | 7.78 | 7.78 | 4.5:1 |
| `--pw-on-success-solid` on `--pw-success-solid` | 5.05 | 6.53 | 4.5:1 |
| `--pw-on-warning-solid` on `--pw-warning-solid` | 12.20 | 7.73 | 4.5:1 |
| `--pw-on-danger-solid` on `--pw-danger-solid` | 5.50 | 7.05 | 4.5:1 |
| `--pw-on-accent` on `--pw-accent` and `--pw-accent-hover` | 7.78 (accent) | 5.08 (accent hover) | 4.5:1 |
| `--pw-text` on `--pw-highlight` | 15.45 | 6.95 | 4.5:1 |
| `--pw-info-tint-fg` on `--pw-selected` (a pressed filter chip's label, and a chosen option's "Your answer" and check) | 6.56 | 7.89 | 4.5:1 |
| `--pw-text-inverse` on `--pw-text` (the app strip) | 18.44 | 16.92 | 4.5:1 |
| `--pw-code-boolean` on surface and muted | 9.78 (muted) | 5.28 (muted) | 4.5:1 |
| `--pw-code-string` on surface and muted | 6.82 (muted) | 6.75 (muted) | 4.5:1 |
| `--pw-code-number` on surface and muted | 7.26 (muted) | 12.95 (muted) | 4.5:1 |
| `--pw-code-null` on surface and muted | 7.37 (muted) | 5.83 (muted) | 4.5:1 |
| `--pw-term-fg` on `--pw-term-bg` | 16.92 | 16.92 | 4.5:1 |
| `--pw-term-red` / `-green` / `-yellow` / `-blue` on `--pw-term-bg` | 6.36 / 7.37 / 14.15 / 5.77 | same | 4.5:1 |
| `--pw-term-cursor` on `--pw-term-bg` | 16.92 | 16.92 | 3:1 |
| `--pw-border-control` on surface, bg, muted and sunken | 3.21 (sunken) | 3.12 (sunken) | 3:1 |
| `--pw-border-input` on surface, bg, muted and sunken | 3.21 (sunken) | 3.12 (sunken) | 3:1 |
| `--pw-focus` on surface, bg, muted, sunken, both hovers and selected | 4.26 (hover-bg) | 4.68 (hover) | 3:1 |
| `--pw-focus` on the five tints (a control's ring inside an inline alert, and a focused alert's inset ring) | 4.29 (info tint) | 4.41 (success tint) | 3:1 |
| `--pw-selected-border` on neutral surfaces (the selected ring, and a checked checkbox's fill) | 6.53 (hover-bg) | 4.68 (hover) | 3:1 |
| `--pw-warning-indicator` on surface, bg, muted, hover and selected (the bar of a row that needs you, as it is, hovered or open) | 3.45 (selected) | 6.28 (hover) | 3:1 |
| `--pw-danger-fg` on `--pw-surface-muted` (the left bar of the Stop and Remove confirmations; `--pw-danger-solid` was 2.20:1 in dark) | 5.27 | 5.83 | 3:1 |

- **The one exemption:** `--pw-text-disabled` is 2.62:1 (light) and 2.25:1 (dark) on `--pw-surface`. WCAG 1.4.3 exempts text in inactive controls. Use it only on controls that are `aria-disabled`, never for content.
- **Decorative only:** `--pw-border`, `--pw-border-strong`, `--pw-border-dashed` and the tone `-border` tokens are below 3:1. They may never be the only thing that shows where a control is or what state it's in.
- **Translucent:** `--pw-backdrop` and `--pw-term-selection` aren't checked. Nothing is drawn on the backdrop, and xterm.js draws selected text in its own colours.
- **The test also checks** each state alias against the background its components pair it with, and fails when a colour token is neither checked nor listed as exempt, decorative or translucent.
- **Ghost buttons** have no edge until hovered. That's allowed: their label or icon identifies them, and WCAG 1.4.11 applies to an edge only when there is one.
- **When adding a colour,** check it against every background it may sit on, in both modes, and add it to this table.

### 2.6 The token file

This is the content of `web/src/tokens.css`, apart from comments. The no-JavaScript dark fallback is described, not repeated (see [2.2](#22-themes-and-switching)). `web/src/tokens.test.tsx` fails if the file and this block differ.

```css
/* pitwall design system tokens. Import before any other CSS. See docs/design-system.md. */

/* 1. Structure: the same in light and dark */
:root {
  --pw-font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --pw-font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;

  --pw-text-xs: 0.75rem;   --pw-leading-xs: 1.25rem;  /* 12/20 */
  --pw-text-s: 0.8125rem;  --pw-leading-s: 1.25rem;   /* 13/20 */
  --pw-text-m: 0.875rem;   --pw-leading-m: 1.25rem;   /* 14/20, the body */
  --pw-text-l: 1rem;       --pw-leading-l: 1.5rem;    /* 16/24 */
  --pw-text-xl: 1.25rem;   --pw-leading-xl: 1.75rem;  /* 20/28 */
  --pw-weight-regular: 400;
  --pw-weight-medium: 500;
  --pw-weight-bold: 600;

  --pw-space-0-5: 2px;  --pw-space-1: 4px;   --pw-space-1-5: 6px; --pw-space-2: 8px;
  --pw-space-2-5: 10px; --pw-space-3: 12px;  --pw-space-4: 16px;  --pw-space-5: 20px;
  --pw-space-6: 24px;   --pw-space-8: 32px;  --pw-space-10: 40px; --pw-space-12: 48px;

  --pw-radius-xs: 2px;
  --pw-radius-sm: 4px;
  --pw-radius-md: 6px;
  --pw-radius-lg: 8px;
  --pw-radius-full: 999px;

  --pw-control-sm: 24px;
  --pw-control-md: 28px;
  --pw-control-lg: 32px;
  --pw-badge-h: 20px;
  --pw-dot: 8px;
  --pw-icon-sm: 16px;
  --pw-icon-lg: 24px;
  --pw-header-h: 52px;
  --pw-strip-h: 32px;

  --pw-sidebar-w: 240px;
  --pw-list-min-w: 360px;
  --pw-panel-w: 760px;
  --pw-panel-min-w: 560px;
  --pw-dialog-sm: 408px;
  --pw-dialog-md: 624px;
  --pw-dialog-lg: 840px;
  --pw-tooltip-max-w: 344px;
  --pw-toast-w: 360px;
  --pw-menu-min-w: 192px;

  --pw-z-sticky: 10;
  --pw-z-panel: 20;
  --pw-z-dropdown: 30;
  --pw-z-backdrop: 40;
  --pw-z-dialog: 41;
  --pw-z-tooltip: 60;
  --pw-z-toast: 70;

  --pw-duration-fast: 150ms;
  --pw-duration-base: 220ms;
  --pw-ease-standard: ease;
  --pw-ease-out: cubic-bezier(0.2, 0, 0, 1);
  --pw-delay-tooltip: 300ms;  /* read by JavaScript */
  --pw-delay-spinner: 500ms;  /* read by JavaScript */
  --pw-delay-long: 10s;       /* read by JavaScript */
  --pw-delay-attach: 500ms;   /* read by JavaScript */
  --pw-toast-timeout: 4s;     /* read by JavaScript */
  --pw-toast-action-timeout: 10s; /* read by JavaScript */
  --pw-copied-timeout: 2s;    /* read by JavaScript */
}

/* 2. Light, the default */
:root {
  color-scheme: light;

  --pw-bg: #FAFAF8;
  --pw-surface: #FFFFFF;
  --pw-surface-muted: #FAFAFA;
  --pw-surface-sunken: #F5F5F5;
  --pw-surface-strong: #EBEBEB;
  --pw-surface-hover: #F5F5F5;
  --pw-surface-hover-bg: #EBEBEB;
  --pw-surface-overlay: #FFFFFF;
  --pw-selected: #E5ECFA;
  --pw-selected-border: #0044CC;
  --pw-highlight: #FFEB99;
  --pw-backdrop: rgb(0 0 0 / 0.1);

  --pw-text: #141412;
  --pw-text-muted: #52504A;
  --pw-text-subtle: #6A6860;
  --pw-text-disabled: #A3A093;
  --pw-text-inverse: #FFFFFF;

  --pw-border: #EBEBEB;
  --pw-border-strong: #E0E0E0;
  --pw-border-dashed: #CCCCCC;
  --pw-border-control: #8C897E;
  --pw-border-input: #8C897E;

  --pw-accent: #0044CC;
  --pw-accent-hover: #0036A3;
  --pw-on-accent: #FFFFFF;
  --pw-link: #0044CC;
  --pw-focus: #3369D6;
  --pw-warning-indicator: #997A00;

  --pw-neutral-fg: #52504A; --pw-neutral-solid: #F5F5F5; --pw-on-neutral-solid: #141412;
  --pw-neutral-tint: #F5F5F5; --pw-neutral-tint-fg: #141412; --pw-neutral-border: #EBEBEB;
  --pw-info-fg: #0044CC; --pw-info-solid: #0044CC; --pw-on-info-solid: #FFFFFF;
  --pw-info-tint: #E5ECFA; --pw-info-tint-fg: #0044CC; --pw-info-border: #CCDAF5;
  --pw-success-fg: #007A3D; --pw-success-solid: #008040; --pw-on-success-solid: #FFFFFF;
  --pw-success-tint: #E5F2EC; --pw-success-tint-fg: #006633; --pw-success-border: #CCE6D9;
  --pw-warning-fg: #665200; --pw-warning-solid: #FFCC00; --pw-on-warning-solid: #141412;
  --pw-warning-tint: #FFF5CC; --pw-warning-tint-fg: #332900; --pw-warning-border: #FFE066;
  --pw-danger-fg: #CC2314; --pw-danger-solid: #CC2314; --pw-on-danger-solid: #FFFFFF;
  --pw-danger-tint: #FAE9E7; --pw-danger-tint-fg: #CC2314; --pw-danger-border: #F5D3D0;

  --pw-code-boolean: #0036A3; --pw-code-string: #006633; --pw-code-number: #665200; --pw-code-null: #A31C10;

  /* The terminal is dark in both modes for now. */
  --pw-term-bg: #141412; --pw-term-fg: #F5F5F5; --pw-term-cursor: #F5F5F5;
  --pw-term-selection: rgb(102 143 224 / 0.35);
  --pw-term-red: #E07B72; --pw-term-green: #66B38C; --pw-term-yellow: #FFE066; --pw-term-blue: #668FE0;

  /* Elevation. Edges are rings (box-shadow), so they take no layout space. */
  --pw-shadow-1: 0 0 0 1px rgb(0 0 0 / 0.04), 0 2px 4px rgb(0 0 0 / 0.08), 0 4px 8px rgb(0 0 0 / 0.08);
  --pw-shadow-2: 0 0 0 1px rgb(0 0 0 / 0.04), 0 4px 8px rgb(0 0 0 / 0.08), 0 8px 16px rgb(0 0 0 / 0.08);
  --pw-shadow-3: 0 0 0 1px rgb(0 0 0 / 0.04), 0 8px 16px rgb(0 0 0 / 0.08), 0 16px 32px rgb(0 0 0 / 0.08);
  --pw-shadow-control: 0 0 0 1px var(--pw-border-control), 0 1px 2px rgb(0 0 0 / 0.04);
  --pw-shadow-input: 0 0 0 1px var(--pw-border-input), inset 0 1px 2px rgb(0 0 0 / 0.04);
  --pw-shadow-input-error: 0 0 0 1px var(--pw-danger-fg), inset 0 1px 2px rgb(0 0 0 / 0.04);
  --pw-shadow-accent: 0 0 0 1px var(--pw-accent-hover), 0 1px 2px rgb(0 0 0 / 0.08);
  --pw-shadow-overlay: var(--pw-shadow-3);
  --pw-ring-focus: 0 0 0 2px var(--pw-surface), 0 0 0 4px var(--pw-focus);
  --pw-ring-focus-inset: inset 0 0 0 2px var(--pw-focus);
  --pw-ring-selected: inset 0 0 0 1px var(--pw-selected-border);
}

/* 3. Dark. Also copied into @media (prefers-color-scheme: dark) { :root:not([data-theme]) { … } } */
:root[data-theme='dark'] {
  color-scheme: dark;

  --pw-bg: #141412;
  --pw-surface: #191917;
  --pw-surface-muted: #1D1D1B;
  --pw-surface-sunken: #222220;
  --pw-surface-strong: #353533;
  --pw-surface-hover: #272725;
  --pw-surface-hover-bg: #222220;
  --pw-surface-overlay: #1D1D1B;
  --pw-selected: #001B52;
  --pw-selected-border: #668FE0;
  --pw-highlight: #665200;
  --pw-backdrop: rgb(0 0 0 / 0.5);

  --pw-text: #F5F5F5;
  --pw-text-muted: #CCCCCC;
  --pw-text-subtle: #9D9D9D;
  --pw-text-disabled: #525252;
  --pw-text-inverse: #141412;

  --pw-border: #2C2C2A;
  --pw-border-strong: #3E3E3D;
  --pw-border-dashed: #3A3A38;
  --pw-border-control: #6E6E6C;
  --pw-border-input: #6E6E6C;

  --pw-accent: #0044CC;
  --pw-accent-hover: #3369D6;
  --pw-on-accent: #FFFFFF;
  --pw-link: #668FE0;
  --pw-focus: #668FE0;
  --pw-warning-indicator: #CCA300;

  --pw-neutral-fg: #CCCCCC; --pw-neutral-solid: #222220; --pw-on-neutral-solid: #F5F5F5;
  --pw-neutral-tint: #222220; --pw-neutral-tint-fg: #F5F5F5; --pw-neutral-border: #2C2C2A;
  --pw-info-fg: #668FE0; --pw-info-solid: #0044CC; --pw-on-info-solid: #FFFFFF;
  --pw-info-tint: #001B52; --pw-info-tint-fg: #99B4EB; --pw-info-border: #0036A3;
  --pw-success-fg: #66B38C; --pw-success-solid: #006633; --pw-on-success-solid: #F5F5F5;
  --pw-success-tint: #00331A; --pw-success-tint-fg: #99CCB3; --pw-success-border: #006633;
  --pw-warning-fg: #FFE066; --pw-warning-solid: #CCA300; --pw-on-warning-solid: #141412;
  --pw-warning-tint: #332900; --pw-warning-tint-fg: #FFE066; --pw-warning-border: #665200;
  --pw-danger-fg: #E07B72; --pw-danger-solid: #A31C10; --pw-on-danger-solid: #F5F5F5;
  --pw-danger-tint: #520E08; --pw-danger-tint-fg: #EBA7A1; --pw-danger-border: #7A150C;

  --pw-code-boolean: #668FE0; --pw-code-string: #66B38C; --pw-code-number: #FFE066; --pw-code-null: #E07B72;

  /* Dark lifts with a faint top highlight and a light ring, because drop shadows don't read on near-black. */
  --pw-shadow-1: 0 -1px 0 rgb(255 255 255 / 0.04), 0 0 0 1px rgb(255 255 255 / 0.12), 0 2px 4px rgb(0 0 0 / 0.32), 0 4px 8px rgb(0 0 0 / 0.32);
  --pw-shadow-2: 0 -1px 0 rgb(255 255 255 / 0.04), 0 0 0 1px rgb(255 255 255 / 0.12), 0 4px 8px rgb(0 0 0 / 0.32), 0 8px 16px rgb(0 0 0 / 0.32);
  --pw-shadow-3: 0 -1px 0 rgb(255 255 255 / 0.04), 0 0 0 1px rgb(255 255 255 / 0.12), 0 8px 16px rgb(0 0 0 / 0.32), 0 16px 32px rgb(0 0 0 / 0.32);
  --pw-shadow-control: 0 0 0 1px var(--pw-border-control), 0 2px 4px rgb(0 0 0 / 0.16);
  --pw-shadow-input: 0 0 0 1px var(--pw-border-input), inset 0 2px 4px rgb(0 0 0 / 0.24);
  --pw-shadow-input-error: 0 0 0 1px var(--pw-danger-fg), inset 0 2px 4px rgb(0 0 0 / 0.24);
  --pw-shadow-accent: inset 0 1px 0 rgb(255 255 255 / 0.24), 0 0 0 1px var(--pw-accent-hover), 0 2px 4px rgb(0 0 0 / 0.16);
}

/* 4. pitwall's session states, as tone aliases */
:root {
  --pw-state-attention-bg: var(--pw-warning-solid);   /* "needs you": the only solid badge */
  --pw-state-attention-fg: var(--pw-on-warning-solid);
  --pw-state-attention-bar: var(--pw-warning-indicator);
  --pw-state-asked-bg: var(--pw-warning-tint);
  --pw-state-asked-fg: var(--pw-warning-tint-fg);
  --pw-state-asked-border: var(--pw-warning-border);
  --pw-state-busy-bg: var(--pw-info-tint);
  --pw-state-busy-fg: var(--pw-info-tint-fg);
  --pw-state-busy-border: var(--pw-info-border);
  --pw-state-idle-bg: var(--pw-neutral-tint);
  --pw-state-idle-fg: var(--pw-neutral-tint-fg);
  --pw-state-idle-border: var(--pw-neutral-border);
  --pw-state-done-bg: var(--pw-success-tint);
  --pw-state-done-fg: var(--pw-success-tint-fg);
  --pw-state-done-border: var(--pw-success-border);
  --pw-state-failed-bg: var(--pw-danger-tint);
  --pw-state-failed-fg: var(--pw-danger-tint-fg);
  --pw-state-failed-border: var(--pw-danger-border);
  --pw-state-offline-fg: var(--pw-text-subtle);
  --pw-state-offline-border: var(--pw-border-dashed);
}

/* 5. Reduced motion */
@media (prefers-reduced-motion: reduce) {
  :root {
    --pw-duration-fast: 0ms;
    --pw-duration-base: 0ms;
  }
}
```

- **Shadows resolve on `:root`:** the `var()` references inside the shadow tokens use the theme's values. If a subtree ever overrides `--pw-surface`, redeclare `--pw-ring-focus` there too.
- **JavaScript reads the delays** with `getComputedStyle(document.documentElement).getPropertyValue('--pw-delay-tooltip')` and parses `ms` or `s`.

### 2.7 Type

- **Families:** Inter for the UI, JetBrains Mono for paths, IDs, commands, code and the terminal. Both are self-hosted (see [2.14](#214-fonts-and-icons)).
- **Base:** `body { font: var(--pw-text-m)/var(--pw-leading-m) var(--pw-font-sans); }`, antialiased (`-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale`). Keep the browser's 16 px root, so rem sizes follow the user's font setting.
- **Line heights** are on a 4 px grid (20 / 24 / 28), so mixed sizes still align in a row.

| Role | Size / line height | Weight | Font | Used for |
|---|---|---|---|---|
| Body | m 14/20 | 400 | sans | Conversation text, alerts, previews |
| Row and group name | m 14/20 | 500 | sans | Session names, group titles, tab labels, buttons |
| Panel and dialog title | l 16/24 | 600 | sans | The session view's name, dialog titles, empty-state titles |
| Wordmark | l 16/24 | 600 | sans | "pitwall" in the header |
| Meta | s 13/20 | 400 | sans | Times, counts, notes, help text, tooltips |
| Label | xs 12/20 | 500 | sans | Field labels, badges, chips, conversation speaker labels |
| Path and ID | xs 12/20 | 400 | mono | cwd, session IDs, the attach command |
| Code | s 13/20 | 400 | mono | Commands in text, tool calls, code blocks |

- **No capitals for emphasis:** labels are sentence case at normal letter spacing, not uppercase with tracking.
- **Numbers that update or align** (counts, times, character counts) use `font-variant-numeric: tabular-nums`.
- **Fields, code and the terminal turn ligatures off** (`font-variant-ligatures: none`), so `//`, `->` and `!=` show as typed.
- **Inline `code`** in text: mono s, `--pw-surface-sunken` fill, `--pw-radius-sm`, padding `0 4px`, colour `--pw-text`.
- **Weights:** 400, 500 and 600 only.

### 2.8 Space

- **4 px grid:** use the `--pw-space-*` steps. Half steps (2, 6, 10 px) only inside small components.
- **Recurring values:**

| Where | Value |
|---|---|
| Page and column gutters | 16 px |
| Row padding | 8 px 16 px |
| Repo list item padding | 6 px 8 px |
| Session view header, tabs and footer, horizontal | 16 px |
| Dialog body | 16 px; header and footer 12 px 16 px |
| Icon to label | 6 px in buttons; 8 px in menu items and alerts |
| Gap between buttons in a group | 8 px; 12 px between a dialog's footer buttons |
| Between fields in a form | 16 px |
| Label to field | 4 px |

### 2.9 Radii

| Token | Value | Used for |
|---|---|---|
| `--pw-radius-xs` | 2 px | Key caps |
| `--pw-radius-sm` | 4 px | Badges, filter chips, skeleton bars, inline code, menu items |
| `--pw-radius-md` | 6 px | Buttons, inputs, cards, rows that stand alone, alerts, tooltips, toasts, menus |
| `--pw-radius-lg` | 8 px | Dialogs, the overlay session view, tab hover fills |
| `--pw-radius-full` | 999 px | Status dots, the theme switch, avatars if any |

- **Badges are rectangles,** not pills.
- **Nested elements** use the outer radius minus the gap between them.

### 2.10 Elevation, edges and focus

| Token | Used for |
|---|---|
| `--pw-shadow-control` | Outline buttons, chips, the theme switch's selected thumb, key caps |
| `--pw-shadow-input` / `-input-error` | Text fields, textareas, selects |
| `--pw-shadow-accent` | Primary buttons |
| `--pw-shadow-1` | Tooltips, the row preview |
| `--pw-shadow-2` | Menus |
| `--pw-shadow-3`, `--pw-shadow-overlay` | Dialogs, toasts, the session view when it overlays the list |
| `--pw-ring-focus` | Keyboard focus, on top of the element's own shadow |
| `--pw-ring-focus-inset` | Keyboard focus on a full-width control inside a container that clips its content, such as the Finished toggle, where the outer ring would be cut off; a box that scrolls inside itself (`ScrollBox`); and a link in a code block, whose box clips the outer ring on the code's first line |
| `--pw-ring-selected` | The open row and pressed chips (inset, so nothing moves) |

- **Edges are rings:** controls are outlined with `box-shadow: 0 0 0 1px …`, not `border`, so they line up with elements that have no edge. Dividers between rows and sections are a real `1px solid var(--pw-border)`.
- **Focus:** `:focus-visible { box-shadow: <own shadow>, var(--pw-ring-focus); outline: 2px solid transparent; }`.
  - The ring is a 2 px gap in the surface colour and a 2 px ring in `--pw-focus`.
  - The transparent outline becomes visible in Windows forced-colours mode, where shadows are dropped. What else a shadow draws is drawn again there in system colours: see [6.1](#61-rules), rule 17.
  - Inside a card with `overflow: hidden`, a full-width control uses `--pw-ring-focus-inset` and `outline-offset: -2px` instead, so neither is clipped. The 2 px ring sits on the control's own fill, so there's no gap; `--pw-focus` is at least 3:1 on every surface it's drawn on (2.5).
  - Never remove focus styles without that replacement.
- **No other shadows,** and only one elevation per element.

### 2.11 Layers

`--pw-z-*` keeps this order: sticky headers 10, the overlay session view 20, menus 30, dialog backdrop 40, dialog and the repo drawer 41, tooltips 60, toasts 70. (Popovers had 50; nothing used it, and it went in W31.) Don't add a z-index outside this scale.

### 2.12 Breakpoints and widths

CSS custom properties don't work in media queries, so these are constants. Use them as written.

| Name | Query | What changes |
|---|---|---|
| **three columns** | `(min-width: 1200px)` | The session view is the third column. Below it, the view overlays the session list, below the header, and the list is inert while it's open |
| **overlay clears the sidebar** | `(min-width: 1000px)`, from `layout.ts` | Below it, in the sidebar layout, the view over the list reaches into the repo list, which is inert while it's open too. 1,000 px is `--pw-sidebar-w` plus `--pw-panel-w` |
| **sidebar** | `(min-width: 900px)` | The repo list sits beside the session list. Below it, the repo list is a drawer opened from the header |
| **compact** | `(max-width: 600px)` | The header's right side wraps under the wordmark (and the root tabs, which by then are usually under it too); the session list's header wraps; the overlay session view is full width, with Back; toasts are full width |
| **short** | `(max-height: 760px)` | The session view's footer padding tightens and the latest reply shows two lines, not three |
| **low** | `(max-height: 480px)` | The page scrolls as a whole, header and all, so the lists keep their room on a phone held sideways or at 200 % zoom on a laptop. The session view, as the third column or over the list, sticks to the top of the window, one window tall |

- **The shell follows the app's width, not the window's:**
  - `web/src/layout.ts` measures `.app` and sets `data-layout` on it to `three-columns`, `sidebar` or `drawer`, from the three columns and sidebar rows above. The CSS reads `data-layout`, so the columns and the components that change with them (the session view's semantics, the drawer) can't disagree. It also says when the view over the list reaches into the repo list (the 1,000 px row), for which of them is inert.
  - It also says whether the app is compact (600 px or narrower), for the session view's markup: Back to sessions takes Close's place there. It changes state only at a breakpoint, so resizing doesn't re-render the app at every pixel.
  - The compact rule is a container query: `.app` is `container: pitwall / inline-size`, and the header uses `@container pitwall (max-width: 600px)`.
  - The app spans the window, so this is the window's width. In the `#uikit` gallery, a frame of a set width gets that width's layout, so each layout can be shown at any window width. The gallery's stages are `pitwall` containers too.
  - A gallery frame wider than its stage is laid out at its own width and scaled down to fit, whole, rather than cut off at the stage's edge (W34). So `layout.ts` reads the layout width (`offsetWidth`) when a transform on an ancestor scales the app, and the width on screen otherwise.
  - The other rows here are still media queries: they belong to components that only ever fill the window.

- **Fixed widths:**
  - Repo list: `--pw-sidebar-w` (240 px).
  - Session list: at least `--pw-list-min-w` (360 px).
  - Session view: `--pw-panel-w` (760 px) by default, at least `--pw-panel-min-w` (560 px, about 80 terminal columns), at most the window less the repo list and 360 px. At 1,200 px that's 600 px.
    - The third column is `auto` in the grid, and takes its pane's width. The pane is 760 px, or the width the divider set, with `max-width: calc(100cqw - var(--pw-sidebar-w) - var(--pw-list-min-w))`, so a narrower window shows less without losing the setting.
  - Dialogs: 408, 624 (the default) or 840 px; from 900 px, [Preferences](#preferences)' 624 px is at most the window less 480 px, so it never covers the repo list. Tooltips: at most 344 px. Toasts: 360 px. Menus: at least 192 px.
- **Reflow:** the UI works at 320 px wide and at 200 % zoom. Only the terminal, and code blocks and tables in messages, may scroll sideways, each in its own box (see [Markdown in messages](#markdown-in-messages)).

### 2.13 Motion

| What | Duration | Easing |
|---|---|---|
| Hover, colour and chevron rotation | `--pw-duration-fast` 150 ms | `--pw-ease-standard` |
| Toast in and out (fade and scale from 0.96) | `--pw-duration-base` 220 ms | `--pw-ease-out` |
| Overlay session view in (slide 16 px and fade), when it opens; not when the window crosses 1,200 px, or ↑/↓ moves it to another session | `--pw-duration-base` 220 ms | `--pw-ease-out` |
| Jump to latest (scroll to the newest entry) | The browser's smooth scroll (`behavior: 'smooth'`) | The browser's |
| Spinner turn | 0.8 s per turn, linear | |
| Skeleton pulse (opacity 1 → 0.6 → 1) | 1.5 s, starting as the skeletons appear, after 0.5 s | ease-in-out |

- **Delays as design:**
  - Spinners, skeletons and waiting status lines ("Loading the conversation…") wait `--pw-delay-spinner` (500 ms) before appearing, so fast loads never flash.
  - After `--pw-delay-long` (10 s), a waiting state adds a line saying what's taking long (see [Skeletons and spinners](#skeletons-and-spinners)).
  - Tooltips open after `--pw-delay-tooltip` (300 ms) and close at once; moving to a neighbouring control with a tooltip opens its tooltip at once (while one is open, or within the delay of one closing).
  - A running background session's view opened by stepping, with `j`, `k`, ↑ or ↓, waits `--pw-delay-attach` (500 ms) before its terminal attaches, so a session only passed through is never attached (W54). The wait counts from when the view opened, and moving on, choosing Conversation or closing the view ends it with nothing attached. 500 ms is longer than the gap between presses when `j` is tapped a few times a second, or repeats while held, and short enough that resting on a session doesn't feel like waiting. A keyboard's first repeat can come later than that, so holding `j` down may attach the first session it reaches, until the repeats move on and detach it; attaching a running session changes nothing in it. It matches `--pw-delay-spinner`, but it's a token of its own, since it decides an action, not a spinner.
  - Toasts stay for `--pw-toast-timeout` (4 s), and toasts with an action for `--pw-toast-action-timeout` (10 s; see [Toasts](#toasts)).
  - A copy button's `copied` icon stays for `--pw-copied-timeout` (2 s).
  - JavaScript reads these tokens from the element they apply to (`web/src/timing.ts`), so a part of the page can set its own. The `#uikit` gallery sets the toasts' two timeouts and the copied icon's to an hour on a specimen's stage, so a toast or a copied icon stays for its screenshots, and sets `--pw-delay-spinner` to 0 (and `--pw-delay-long` to 0 or an hour) on a waiting state's, so its skeletons and long-wait line show at once, and `--pw-delay-attach` to an hour on the session view stepped onto, so it stays waiting.
- **Reduced motion** (`prefers-reduced-motion: reduce`): the durations drop to 0, skeletons stop pulsing, the spinner slows to 2 s per turn (it still shows something is happening), and scrolling to the latest message jumps rather than animating. The conversation's working line, which can show for minutes, has a steady status dot in its spinner's place instead, so nothing spins (W102).
- **Nothing loops** except spinners and skeletons, and nothing pulses to get attention. The terminal's cursor doesn't blink (4: Terminal).

### 2.14 Fonts and icons

- **Fonts,** self-hosted as woff2, because the CSP blocks font CDNs:
  - Inter 400, 500 and 600; JetBrains Mono 400 and 500. Latin and Latin Extended subsets.
  - Bundled from the `@fontsource/inter` and `@fontsource/jetbrains-mono` packages, exact devDependencies. Vite copies the woff2 files into `dist/web/assets/` with hashed names, so they're same-origin, which the CSP's `default-src 'self'` allows.
  - Declared in `web/src/fonts.css`, imported from the web entry after `tokens.css`: one `@font-face` per weight and subset, woff2 only, with `font-display: swap` and the package's own `unicode-range`. A browser downloads a file only when text on the page uses that family, weight and subset.
  - **No preload.** The hashed file names would need a build step to reach `web/index.html`, and pitwall is served from localhost, where a preload saves almost nothing: the stylesheet that names the files arrives at once, and `swap` shows the fallback font until they load.
  - **Licence files:** both are SIL OFL 1.1, reproduced in full in the root `THIRD_PARTY_NOTICES.md`. The web build copies that file into `dist/web` as `THIRD_PARTY_NOTICES.txt`, so the licences ship with the font files.
- **Icons:** Material Symbols Rounded, bundled as SVG path data, never as a font or from a CDN.
  - Style: fill 0, weight 400, grade 0. Each size draws its own optical size, which sets the stroke weight for that size: 16 px draws the 20 px design (there's no 16 px one), and 24 px draws the 24 px design.
    - **Two exceptions, `starred` and `not-needed-on`** (W53, W88). `starred` is the same glyph as `star`, at fill 1, the filled style Material Symbols draws for a toggle that's on. A star toggle reads by its fill everywhere people star things, and no fill 0 glyph draws a filled star. `scripts/extract-icons.ts` takes the style with the glyph (`['star', 'fill1']`), and fetches `star_fill1_20px.svg` and `_24px.svg` from the same commit. `not-needed-on` is `snooze` at fill 1 in the same way, for the [Not needed now](#not-needed-now) toggle while it's on.
    - The 48 px design, the only one in the `@material-symbols/svg-400` package, is too thin at 16 px: about 1.0 px strokes, against 1.2 px for the 20 px design.
  - Vendor only the glyphs pitwall uses, from a pinned upstream commit at least 14 days old, as the repo's dependency rule asks. Keep the path data in `web/src/icons/paths.ts`, one path per size, keyed by the semantic names below.
    - Today's source is `google/material-design-icons` at commit `737e3324305806514d7909874fa1818ae1808232` (2026-10-02): `symbols/web/<glyph>/materialsymbolsrounded/<glyph>_20px.svg` and `_24px.svg`, or `<glyph>_fill1_20px.svg` and `_24px.svg` for the filled style. Nothing is installed.
    - `scripts/extract-icons.ts` prints a curl config for exactly those files and the licence, then regenerates `paths.ts` from the fetched copies, reading them as data. Its header comment has the steps.
  - Render them through one `Icon` component, `web/src/components/Icon.tsx`: `<svg viewBox="0 -960 960 960" width height fill="currentColor" aria-hidden="true" focusable="false">`, with `size` 16 (the default) or 24, which picks that size's path.
  - **Licence files:** Apache 2.0. The licence text is at `web/src/icons/LICENSE` and in `THIRD_PARTY_NOTICES.md`. The repository has no `NOTICE` file at that commit.
  - The CSP allows inline SVG; no `img-src` change is needed.
- **Semantic icon names:** components ask for a meaning, not a glyph, so a glyph changes in one place.

| Name | Glyph | Used for |
|---|---|---|
| `close` | close | Closing the session view, dialogs, toasts |
| `expand` | chevron_right | The Finished, Hidden and tool-call toggles, rotated 90° when open |
| `select` | keyboard_arrow_down (formerly expand_more) | The chevron in selects |
| `more` | more_horiz | The session view's actions menu |
| `menu` | menu | The header's Repos button, which opens the repo list drawer below 900 px |
| `search` | search | The filter field |
| `clear` | cancel | The filter field's Clear text, which clears its text |
| `clear-filters` | filter_alt_off | The filter bar's [Clear filters](#filter-chips) (W91), which clears the text and the chips: a funnel struck through, Material Symbols' own glyph for filters off. Not `clear`, since the field's own Clear text, which clears the text alone, can be beside it |
| `add` | add | New session |
| `copy` / `copied` | content_copy / check | Copy buttons |
| `terminal` | terminal | The Terminal tab, attach |
| `conversation` | forum | The Conversation tab |
| `send` | send | The message box |
| `stop` | stop_circle | Stop session, and End session for an interactive session (W90) |
| `remove` | delete | Remove session |
| `restart` | restart_alt | Restart and attach |
| `retry` | refresh | Try again, attach again |
| `info` / `success` / `warning` / `error` | info / check_circle / warning / error | Alerts and toasts |
| `repo` / `directory` | graph_1 / folder | Group kind. graph_1 is a branch, which reads as git at 16 px; account_tree read as a hierarchy. `repo` is the session view's Pull requests tab's icon too (W106), as there's no PR glyph in the set |
| `sort` | sort | The session list's Sort menu button (W106's review) |
| `external` | open_in_new | Links that leave pitwall, and the actions menu's Open in VS Code and Open in Cursor (W72), which open an app outside it; and a repo that isn't cloned, in the repo list and its heading (W106): it's on GitHub, not here |
| `latest` | arrow_downward | Jump to latest |
| `back` | arrow_back | Back to the list on narrow windows, and Back to sub-agents from a sub-agent's transcript (W77) |
| `keyboard` | keyboard | The header's keyboard shortcuts button, which opens the shortcuts dialog |
| `hide` / `show` | visibility_off / visibility | The session list header's Hide from repo list and Show in repo list, and each hidden group's Unhide (W35). Each draws what the button does |
| `preferences` | tune | The header's [Preferences](#preferences) button (W42, W59) |
| `checked` | check | The chosen option in a menu's radio group (W42). The same glyph as `copied`, for another meaning |
| `star` / `starred` | star / star at fill 1 | A session's [star toggle](#starred-sessions), off and on (W53): outlined while it isn't starred, filled while it is |
| `not-needed` / `not-needed-on` | snooze / snooze at fill 1 | A session's [Not needed now](#not-needed-now) toggle, off and on (W88), as the star's two states are, and the actions menu's Mark not needed now. Snooze is "not now"; it comes back by itself |
| `undo` | undo | The actions menu's Put back in Needs you (W88), which undoes Mark not needed now |
| `subagents` | account_tree | The session view's [Sub-agents tab](#sub-agents) (W77): a session and the sub-agents it started, some started by another. A hierarchy is what it means here, where it read wrongly for a repo |
| `attach` | attach_file | New session's Attach files, and its drop target (W82; see [Dialogs](#dialogs)) |
| `image` / `pdf` / `file` | image / picture_as_pdf / description | The type of a file in New session's list (W82): an image that has no thumbnail yet, a PDF, and text |
| `theme-system` / `theme-light` / `theme-dark` | computer / light_mode / dark_mode | The theme switch |

### 2.15 Mapping from the CSS before M3

_A record of W18's rename ([#23](https://github.com/leggetter/pitwall/pull/23)). No `web/src/*.css` file uses the old variables any more. "Today" below means before M3, and the cells that say "for now" or "until" describe what W20 then did._

The first restyle PR renames today's custom properties (in `web/src/styles.css`, `relay.css`, `actions.css` and `components/Terminal.css`) and the colours hard-coded in `components/Terminal.css` and `xterm.ts`. It keeps **today's values**, so nothing changes on screen.

- **Splits:** where one variable plays two roles, define both new tokens with today's value, and point each use at the role it plays.
- **State aliases:** where two of today's values will become one role, the state aliases hold today's values until the restyle points them at the tone tokens. Today's values differ between light and dark, so until then the aliases sit in the light and dark blocks rather than in section 4 of the token file.

| Today | Today's value, light / dark | New token |
|---|---|---|
| `--bg` | `#f4f5f7` / `#0e1115` | `--pw-bg` |
| `--surface` | `#ffffff` / `#161a20` | `--pw-surface` (and `--pw-surface-overlay` for the dialog); `--pw-on-accent` for the primary button's text; `--pw-state-asked-bg` for the "asked you" badge |
| `--surface-raised` | `#f0f2f5` / `#1e232b` | `--pw-surface-muted` for group headers; `--pw-surface-sunken` for the other fills (user messages, code chips); `--pw-surface-hover` for hovers |
| `--border` | `#d8dce2` / `#2b323c` | `--pw-border` |
| `--border-strong` | `#b9c0c9` / `#3d4552` | `--pw-border-input` on fields; `--pw-border-control` on buttons and the dialog edge; `--pw-border-strong` on the session view's edge |
| `--text` | `#1b1f24` / `#e6e9ee` | `--pw-text` |
| `--text-muted` | `#555d67` / `#9ca5b1` | `--pw-text-muted` |
| `--focus` | `#1f5fd6` / `#7ea8ff` | `--pw-focus` on outlines; `--pw-accent` on the primary button; `--pw-link` on link buttons; `--pw-selected-border` for the open row's bar |
| `--attention` | `#f59e0b` / `#fbbf24` | `--pw-state-attention-bg` (badges) and `--pw-state-attention-bar` (row bar); `--pw-state-asked-border` for the "asked you" badge's edge |
| `--attention-text` | `#2b1d00` / `#1c1300` | `--pw-state-attention-fg` |
| `--attention-row` | `#fff6e5` / `#2a2008` | `--pw-state-attention-row`, removed in W23 when rows that need you lost their tint |
| `--attention-strong` | `#9a5800` / `#fcc94a` | `--pw-warning-fg` (also the "Asked:" label, the checkbox accent and the line for a relay message that's held or uncertain); `--pw-state-asked-fg` for the "asked you" badge's text |
| `--busy-bg`, `--busy-text` | `#dbe8fe`, `#1d3f99` / `#18294a`, `#a9c7ff` | `--pw-state-busy-bg`, `--pw-state-busy-fg` |
| `--idle-bg`, `--idle-text` | `#eceef1`, `#474f59` / `#232932`, `#b7bfc9` | `--pw-state-idle-bg`, `--pw-state-idle-fg` |
| `--done-bg`, `--done-text` | `#dcf5e4`, `#165c32` / `#12301e`, `#8ee6ac` | `--pw-state-done-bg`, `--pw-state-done-fg` |
| `--failed-bg`, `--failed-text` | `#fde2e2`, `#921c1c` / `#3b1717`, `#ffaaaa` | `--pw-state-failed-bg`, `--pw-state-failed-fg` |
| `--offline-text` | `#5a626c` / `#9ca5b1` | `--pw-state-offline-fg` |
| `--offline-border` | `#9aa1ab` / `#535c69` | `--pw-state-offline-border` |
| `--live`, `--pending`, `--broken` | `#16833d`, `#b26b00`, `#c42b2b` / `#4ade80`, `#fbbf24`, `#f87171` | `--pw-live`, `--pw-pending`, `--pw-broken`, removed in W31: the connection badge and the terminal's bar use `Badge`'s tones, so nothing used them |
| `--warning-bg`, `--warning-border` | `#fff3cd`, `#d9a400` / `#33280a`, `#a37b00` | `--pw-warning-tint`, `--pw-warning-border` |
| `--error-bg`, `--error-border` | `#fde2e2`, `#d14343` / `#3b1717`, `#b84040` | `--pw-danger-tint`, `--pw-danger-border` |
| `--radius` | `8px` | `--pw-radius-lg` for now; the restyle moves cards, rows and buttons to `--pw-radius-md` |
| `--radius-pill` | `999px` | `--pw-radius-full` for now; the restyle moves badges to `--pw-radius-sm` |
| `--font-sans`, `--font-mono` | system stacks | `--pw-font-sans`, `--pw-font-mono` (today's stacks until the fonts are applied) |
| `#0e1115` in `Terminal.css`; `#0e1115`, `#e6e9ee` in `xterm.ts` | | `--pw-term-bg`, `--pw-term-fg`, `--pw-term-cursor` (xterm reads them with `getComputedStyle`) |
| `rgb(0 0 0 / 0.35)` dialog backdrop | | `--pw-backdrop` |
| `0 12px 32px rgb(0 0 0 / 0.25)` dialog shadow | | `--pw-shadow-3` |
| `-8px 0 24px rgb(0 0 0 / 0.18)` session view shadow | | `--pw-shadow-overlay` |
| `color-scheme: light dark` on `:root` | | `color-scheme: light` in the light block and `dark` in the dark blocks, which comes to the same thing while the system decides |
| `body { font-size: 15px }` | | Stays until the type change, then `--pw-text-m` (14 px) |

- **Type sizes, when the theme was applied (W20):** each of today's sizes moved to one of the two scale steps either side of it, or stayed on its step when it was exact (`1rem` is l, `1.25rem` is xl). Between two steps, the element's role in [2.7](#27-type) chose: `0.95rem` session names became m, `0.8rem` badges xs, `0.85rem` meta text s. Weight 700 became 600, the heaviest bundled. Components take their roles' exact sizes as they're rebuilt.

---

## 3. Layout shell

Three columns, left to right: where to look (the repo list), what's there (the session list), and one session (the session view). Choosing in one column fills the next. Phil asked for this layout on 2026-10-20, in place of one long list of grouped cards, where every row showed its last reply and nine sessions that needed him filled several screens.

```
┌─ app strip, 32 px, only while the relay is off ───────────────────────────────────────────┐
├─ header, 52 px ───────────────────────────────────────────────────────────────────────────┤
│ pitwall  ~/git                                 [+ New session]  ● Live  7s ago  ◐  ⚙  ⌨   │
├─ repo list, 240 px ─┬─ session list (≥ 360 px) ─────────────┬┬─ session view ─────────────┤
│ Needs you       [2] │ ⑂ pitwall      4 sessions [2 need you] ││ name · title     ★  ⋯  ✕  │
│ All sessions     12 │ [Filter sessions                    /] ││ badge · kind · 5m · cwd   │
│ Starred           2 │ [Interactive] [Background]             │├ Conversation | Terminal ──┤
│ ─────────────────── │                                   ⇅    ││ body (scrolls)            │
│ ▢ ~/git           3 │────────────────────────────────────────││                           │
│ ⑂ pitwall       [2] │▌name · title           [waiting] 1m  ★ ││                           │
│ ⑂ api-server      4 │  Asked: Which queue should failed…     ││                           │
│ ▢ scratch         1 │ name · title                [busy] 6s  ││                           │
│                     │ Finished (3)  ›                        │├ footer: message box ──────┤
└─────────────────────┴────────────────────────────────────────┴┴───────────────────────────┘
```

- **With two or more roots,** the header's root is a tab per root, and the three columns are the open tab's: see [Root tabs](#root-tabs).
- **The page doesn't scroll.** The app is `height: 100dvh`, a grid of the strip, the header and the columns. The repo list, the session list's rows and the session view's body each scroll on their own. The header, the session list's header, and the session view's header, tabs and footer stay put.
- **Full width.** No centred max-width column. The session list takes whatever the other two columns leave.
- **The list is for scanning; the session view is for reading.** A row is two lines at most. A session's replies, its relay exchanges, its attach command and the message box are in the session view, one click away.

### Header

- **Size and fill:** 52 px tall, `--pw-bg`, a bottom `--pw-border`, 16 px gutters.
- **Left:**
  - Below the sidebar breakpoint (900 px), a ghost md `menu` icon button, "Repos", that opens the [repo list](#repo-list) as a drawer.
  - The wordmark "pitwall" (l 16/24, 600).
  - With one root, the root: path type, `--pw-text-subtle`, home shortened to `~`, middle ellipsis, the full path in a tooltip, exactly as before there were tabs.
  - With two or more, a tab per root in its place: see [Root tabs](#root-tabs).
- **Right, 12 px apart:** New session (primary, md, `add` icon, with `n` in its tooltip); the connection badge; "updated 7s ago" (meta, `--pw-text-subtle`, tabular, a [timestamp](#timestamps) with the absolute time in its tooltip); the theme switch; [Preferences](#preferences) (ghost md `preferences` [icon button](#icon-buttons), "Preferences", with `aria-haspopup="dialog"`), which opens the Preferences dialog (W59); the keyboard shortcuts button (ghost md `keyboard` icon button, "Keyboard shortcuts", with `?` in its tooltip), which opens the [keyboard shortcuts dialog](#keyboard-shortcuts-dialog).
  - The shortcuts button is there from the first render, before the first snapshot, and stays while the single-key shortcuts are off, so they can be turned back on. Preferences is there from the first render too.
  - New session says its key in `aria-keyshortcuts="n"` while the single-key shortcuts are on. The shortcuts button has none: ARIA 1.2 wants the keys as pressed, modifiers and all, and `?` is Shift and a key that differs by keyboard layout (`/` on a US one), so no value is right everywhere. Its tooltip's key cap and the dialog's map say it.
- **Compact (≤ 600 px):** the right side wraps under the wordmark, and the header grows to fit.

### Root tabs

Phil runs pitwall over two folders of repos and wants both in one window (W38). One pitwall watching several roots, with a tab per root, was chosen over two pitwalls, which double the polling, scanning and relays, and over one page showing other pitwalls, which would need each one's token and a looser CSP. There's no All roots tab: a several-root pitwall without tabs was that view.

- **When:** two or more roots. With one, the header is as above, with no tabs, and the URL names no root.
- **The tabs:** one per root, in the order pitwall was given them, after the wordmark, in a [tablist](#tabs) named "Roots". Each is labelled with its root's path, home as `~`, with the full path in a tooltip that describes the tab. They use the root tabs' look in [Tabs](#tabs).
- **What the open tab narrows to its root:** the repo list (Needs you, All sessions and their counts, the groups, and the Hidden section and its badge), the session list and its summary, the filter, `j` and `k`, and the New session dialog's directories (see [Dialogs](#dialogs)). The columns are the open tab's `role="tabpanel"`, named by its tab.
  - **Which root is a group's:** the index's, never the page's. A group's `SessionGroup.root` is the root the index put it under, the longest configured root that holds its directory (`matchRoot()` in `src/index/roots.ts`). A group the page builds for a repo with none in the snapshot (W42, see [Repo list](#repo-list)) sits under that repo's `WorkedIn.root`, which the index sets the same way. So with one root inside another, the inner root's sessions are in its tab alone, and the outer root's tab never lists them.
  - A tab's Needs you and All sessions are the sessions its groups list, in the [Group sessions by](#preferences) mode, each once. In Main repo and Where it started each session is in one group, and so in one tab, and the tabs' counts add up to every root's; Main repo can move a session started in a root itself to its main repo under another root, and so to that root's tab (Phil, 2026-10-21). In Every repo it worked in, a session is in the tab of each root it's listed under, so the tabs' counts can add up to more.
- **What stays the whole page's:** the header's other controls, the page alerts, the app strip, the toasts, the Sort setting, the single-key shortcuts setting, the session view's width, and the document title's count.
- **The badge:** a tab that isn't open carries a solid warning need-you [badge](#badges) after its label, 6 px from it, whenever any session under its root needs you, counting each session once, though in Every repo it worked in one may be in several of the root's groups, as the Hidden section's badge counts. A session marked [not needed now](#not-needed-now) isn't counted (W88). It's in the tab's name ("~/work, 2 need you"), so nothing that needs you is out of sight in a tab that isn't open. The open tab has none: its repo list's Needs you says the same, just below, and the document title counts every root's.
- **Each tab keeps its own place:** its selection, its open session and its filter, for the page's life. Switching back shows them again.
  - The open session views of the tabs that aren't open stay mounted, `hidden`, so switching never detaches an attached terminal (D9's limit of four counts across tabs), never drops a message box's draft, and never stops a send, or a Stop or Remove, in flight; its result shows when the tab is back. A hidden view has no `id`, so rows' `aria-controls` name only the one shown, and Escape isn't its. Its conversation keeps the reader's place, as behind the Terminal tab.
  - A session started from a tab that's been left by the time it's listed switches back to that tab, and opens there, with its group selected (W63; see [Dialogs](#dialogs), the New session dialog's Started). The tab you were in keeps its place. Not when the view open in either tab has something to keep: then a toast says it's listed, with Open.
- **The URL:** the selection's `&root=<root>` names the open tab, for the views as well as a group: `?view=all&root=/Users/example/work`. Switching pushes one history entry, with the tab's selection and open session; the back button switches back.
  - A URL to a group or session in another root opens its tab: a group by its root, or, without one, by the first group with its key; `?session=` with no selection by the group it selects ([Repo list](#repo-list)). A URL with a root pitwall doesn't watch, or none, opens the stored tab, or the first, and is replaced to match.
  - A root with no sessions keeps its tab, with the usual "No Claude Code sessions under *root*" empty state.
- **Storage:** the open tab, as its root's path alone, in `localStorage` as `pitwall.root-tab.v1`, for a URL with no selection, such as the one the CLI opens. Missing, throwing or empty storage, or a root pitwall no longer watches, opens the first root's tab, as `pitwall.view.v1` falls back (W38).
- **The page title** names the open tab's root after the count: "(3) pitwall · ~/work". The count is every root's, each session once, so the browser's tab shows what needs you anywhere.
- **Focus:** opening a tab leaves focus on it. When the back button switches tabs with focus in what that hides, the last tab's session view, or with focus dropped to the page, it goes to the open tab. Everything else, F6, `/`, `n`, `?` and `j`/`k`, works as before, in the open tab.
- **Widths:** with tabs, the header wraps whenever its line has no room, at any width, not only at 600 px and narrower. First the right side goes under the wordmark and the tabs; then the tabs go under the wordmark, and wrap among themselves; only a tab wider than a whole line is cut, in the middle, its last segment kept. So at 320 px, and 200 % zoom, every tab and every badge is in sight, and nothing scrolls sideways. A select or a menu of roots would hide the badges of the roots not chosen, and a tab strip that scrolls would hide the tabs past its edge, so neither keeps what needs you in sight; and labels stay whole as long as they can, since cut paths such as `~/wo…/git` and `~/pe…/git` are harder to tell apart. One line holds at 52 px, with 12 px above and below.

### Repo list

- **Fill and size:** `--pw-bg`, `--pw-sidebar-w` (240 px) wide, a right `1px solid var(--pw-border)`, padding 8 px. It scrolls on its own.
- **Landmark:** `<nav aria-label="Repos">`, holding a `<ul>` of the views, an `<hr>` divider, then a `<ul>` of [repo list items](#repo-list-items) for each root's groups, then, while any group is hidden, another `<hr>` and the [Hidden section](#hidden-groups).
  - With two or more roots, it's the open [root tab](#root-tabs)'s: that root's groups and hidden groups alone, under no heading, since the tab names the root.
- **Contents, top to bottom:**
  1. The views: "Needs you", every session that needs you under the root (the open tab's, with several), except those marked [not needed now](#not-needed-now) (W88), "All sessions", "Starred", the [starred sessions](#starred-sessions) under the root (W53), and, once the server has sent a list and unless pull requests are off, "Pull requests", every row with an open PR under the root, with how many need you through one (W95, W106, see [Pull requests](#pull-requests)).
  2. A 1 px `--pw-border` divider, 8 px above and below.
  3. Every group: a git repo, or a directory that isn't in one, and, for pull requests no session owns, a cloned repo with no session listed, or a repo that isn't cloned (W106).
  4. While any group is hidden, the same divider, then the [Hidden section](#hidden-groups): "Hidden (*n*)", collapsed by default, listing the hidden groups.
- **Starred** (Phil, 2026-10-22, W53: "it would be good to be able to pin or star sessions. they then live under a pinned/starred group. Then you can easily switch between those you are actively working on."): the sessions starred with the star toggle on their rows or in their views, under the root, wherever they're grouped. See [Starred sessions](#starred-sessions).
  - It's always there, starred or not, so the list never jumps as the first star comes or the last goes, and its empty state says how to star.
- **Hiding a group** (Phil, 2026-10-21, W35): any group, a git repo or a directory, the root's own included, can be hidden from the list with the session list header's Hide from repo list (see [Session list](#session-list)), and shown again there or from the Hidden section. The views can't be.
  - It takes out only that group's item. Its sessions still show in the group, Needs you, All sessions and Starred, with line 2 naming their group as before; the views' counts, the other groups' counts, the document title's and the session view's "Started in … · worked in …" line don't change.
  - It's by the group's root and key, so a group the page builds for a repo hides like any other and stays hidden in every [Group sessions by](#preferences) mode. In a mode that doesn't list it, the Hidden section shows it with "No sessions".
  - It's kept for each root, so two pitwalls watching different roots keep separate lists: see [Hidden groups](#hidden-groups) for the key and what it holds.
  - Rather than an age limit: on Phil's try-out a long-running session was listed under a repo it last worked in weeks earlier, which the grouping rule had read correctly.
- **Grouping, as [Group sessions by](#preferences) says** (W42, Phil, 2026-10-21): the snapshot lists each session in the group it started in (W39), and the page groups it again for the mode chosen in the header. Switching is instant and asks the server nothing.
  - **Where a session started:** a repo for a session started in it, its worktrees and subdirectories included; a directory below a root that isn't in a repo for one started there; the root's own directory for one started in the root itself.
  - **The repos a session worked in** beyond where it started are those it changed or whose tool calls touched it at least 5% of the time, its sub-agents' included (`SessionSummary.workedIn`, W34, spike 004). The [session view](#session-view-header-tabs-and-footer)'s line 3 names them in every mode, and the [filter](#search) finds a session by them.
  - **Main repo, the default:** a session started in a root itself that worked in repos is listed under one of them, its main repo: the one with the most changes, ties broken by tool calls, then the newest touch, then the path. It may be under another root, and so in that root's [tab](#root-tabs). A session started in a root itself that worked in no repo stays in the root's own group, and every other session stays where it started, whatever it worked in. Each session is in one group. A root that is itself a repo is a repo like any other: its sessions stay.
  - **Where it started:** the snapshot's groups as they are, each session under the group it started in alone (W39, Phil, 2026-10-21: "The problem is duplication"). The root's own directory lists every session started in the root itself.
  - **Every repo it worked in:** W34's listing. Each session is under the group it started in and under every repo it worked in, except that the root's own directory lists only the sessions started in the root that worked in no repo. A group lists each of its sessions once, so a session is in several groups, and the counts can overlap (see [Repo list items](#repo-list-items)).
  - **A repo with no group in the snapshot,** one that sessions only worked in, gets an item when the mode lists a session under it: a git repo, from the session's `WorkedIn`, its key, label and root. In Where it started it has none.
  - **A group with no sessions in the mode goes,** the root's own included, as any empty group does. So does one whose only sessions are [ended sessions](#ended-sessions) older than `ENDED_SHOWN_DAYS`, until Show older is on (W67).
  - **Why three:** Where it started replaced W34's listing after Phil's try-out, where 12 of 20 sessions were in more than one group. Main repo came next: a long session started in the root that did nearly all its work in one repo belonged under that repo, not the root.
- **Pull requests in the groups** (W106; Phil, 2026-10-29: PRs "should be treated as sessions are, under their repos"): a session's open PRs are listed with it, where the session is listed. A PR no session owns is a row of its own under the group the server placed it in (`PullRequestSummary.place`), and counts as a row wherever its group does. See [Pull requests](#pull-requests).
  - **A cloned repo** with no session listed gets an item, as a repo that sessions only worked in does: a git repo, with the place's key, label and root.
  - **A repo that isn't cloned,** whose GitHub owner the root claims, gets an item of its own under that root, `owner/name` as GitHub spells it, listed only while it has PR rows. The `external` icon in place of `repo` says it isn't here, and ", not cloned" follows its label, visually hidden, and in its tooltip, which shows whether or not the label is cut. Its key is `github.com/<owner>/<name>`, never a path. It has no Hide from repo list, and isn't stored as the last selection (`pitwall.view.v1`): a private repo's name stays out of `localStorage` (D14).
  - **No root claims it:** not listed. The Pull requests view says how many are hidden.
- **Group order:** alphanumeric by label, so the column never moves as sessions change (Phil, 2026-10-20).
  - Case-insensitive, with numbers compared as numbers, so `repo-2` comes before `repo-10` (`Intl.Collator` with `numeric: true`).
  - Within each root, the root's own directory comes first, then the rest.
  - A group whose sessions have all finished keeps its place, with its label muted. New groups appear in their place, and removed ones leave it.
- **The root's own directory** is labelled with its path (`~/git`) rather than its last segment, so it doesn't read as a repo called "git", and is first among its root's groups.
- **Below the sidebar breakpoint (900 px): a drawer.**
  - It slides in from the left with the same content, `--pw-sidebar-w` wide (or the window, if that's narrower), opened from the header's `menu` button.
  - `--pw-surface`, `--pw-shadow-overlay`, at `--pw-z-dialog` over a `--pw-backdrop` at `--pw-z-backdrop`, and `role="dialog"` with `aria-modal="true"`, like a dialog.
  - Choosing an item closes it. Escape, or a click on the backdrop, closes it and returns focus to the menu button.
- **The selection is in the URL:** `?view=needs-you`, `?view=all`, `?view=starred`, `?view=prs` (W95), or `?repo=<key>`, a not-cloned repo's `github.com/<owner>/<name>` (W106).
  - The group's key, plus `&root=<root>` when pitwall watches more than one root, since a worktree's group can share its main repo's key under another root. With more than one, the views name their root too, which is the open [root tab](#root-tabs). Stable across reloads, and readable: `/`, `~`, `:`, `@` and `,` aren't escaped. Never the token.
  - Other parameters, such as `?session=`, are kept as the selection changes.
  - Choosing pushes a history entry; `popstate` makes the columns match the URL.
  - A URL with no selection uses the last one, saved in `localStorage` as `pitwall.view.v1`, or All sessions the first time, and replaces the URL to match. With root tabs, the stored tab, `pitwall.root-tab.v1`, picks the tab, and the stored selection is used when it's that tab's.
  - Loading `?session=` with no selection selects the group the session is listed under in the chosen [Group sessions by](#preferences) mode: in Every repo it worked in, the group it started in, or, for one started in a root itself that worked in repos, its main repo. That group's root picks the [tab](#root-tabs).
  - A session started from New session selects the same group, its home group, once it's listed (W63). It has worked in no repo yet, so that's where it started: a repo, a directory, or the root's own directory, in every mode. See [Dialogs](#dialogs), the New session dialog's Started.
  - A hidden group is selected as any other, from a link, the URL or its entry in the Hidden section, and its sessions show as usual.
  - A selected group that leaves the list stays selected, with the "No sessions in *group* now" empty state (see [Empty states](#empty-states)). That includes a saved selection in `pitwall.view.v1` whose group has since emptied, the root's own directory included, once no session is listed under it in the mode.
  - Switching [Group sessions by](#preferences) is the exception: a selected group the new mode doesn't list gives way to All sessions in the same root tab, with a toast that says so.

### Session list

- **With Pull requests selected** (W95, W106), the column lists every row with an open PR, with the Pull requests view's own filters, notices and foot: see [Pull requests](#pull-requests).
- **A row is a piece of work** (W106): a session's, with the open PRs it owns, or a PR's that no session owns ([PR rows](#pull-requests)). The summary, its counts and the views count rows, and "sessions" is still the word for them (Phil, 2026-10-29).
- **Fill:** `--pw-surface`. Its header stays put; its rows scroll.
- **Page alerts** come first, above the header, full column width, with 12 px 16 px 0 around them and 12 px between them (see [App strip and page alerts](#app-strip-and-page-alerts)). They take at most half the column; past that, they scroll inside themselves, so the header and some rows always show. While they do, their box is a Tab stop, a region named "Alerts" with the inset focus ring, since Safari and Firefox scroll a box from the keyboard only once it has focus (`ScrollBox`, W31).
- **Header** (padding 12 px 16 px, a bottom `--pw-border`):
  - **Line 1:**
    - The selection's name, as the column's `<h2>` (l 16/24, 600).
      - A group shows its kind icon and label. With two or more roots, the open [root tab](#root-tabs) says which root it's under, so the heading doesn't (until W38, it added "in *root*").
      - The views show "Needs you", "All sessions" or "Starred".
    - At the right, the summary: "4 sessions", or "2 of 4 sessions" while the filter hides some, then a solid warning "2 need you" badge, or " · Nothing needs you" in meta text. The counts are the selection's; Needs you never counts a finished session, or one marked [not needed now](#not-needed-now) (W88).
      - **The count keeps its filtered width** (W75): it's right-aligned in the room "4 of 4 sessions" takes, its widest filtered form in tabular numbers, held by an unseen `::before` drawn from its `data-room`, with empty alternative text (`content: attr(data-room) / ''`) so a screen reader reads the count alone. So turning a filter on can't wrap line 1 and move the filters and rows below it. Before, a heading that just fitted beside "18 sessions" wrapped when it became "13 of 18 sessions", at any width, and everything below dropped a line. Now such a heading has the summary on a line of its own, filtered or not.
    - **For a group** (W35), after the summary, 8 px from it: Hide from repo list, a ghost sm `hide` [icon button](#icon-buttons) named by its tooltip. For a hidden group it's Show in repo list, with the `show` icon, in the same place. sm is 24 px, the line's height, so the header is as tall for a group as for a view.
      - The summary and the button sit together at the right, and wrap together onto the next line when the heading needs the room.
      - Either one acts at once, with a [toast](#toasts) saying where the group went: "Hid *group*. It's under Hidden, at the foot of the repo list." or "Unhid *group*. It's back in the repo list." (for one with no sessions in the snapshot, "… once it has sessions."). It's one click because it's easy to undo, and the toast and the Hidden section say where the group is.
      - It's the same button with its other name, so focus stays on it. Hiding keeps the group selected, and opens the Hidden section on its entry, scrolled into view in the repo list.
      - A selected group that has left the snapshot and isn't hidden has no button: there's no item to hide. One that's hidden has Show in repo list; once that's pressed the button goes, and focus goes to the heading.
      - The views have none.
    - No summary where it would only repeat the empty state below it (W31): over no sessions at all ("0 sessions · Nothing needs you" above "No Claude Code sessions under *roots*"), over Needs you with nothing in it ("Nothing needs you" above "Nothing needs you right now"), and over Starred with nothing in it (W53). The filter's no-match state keeps it, since "0 of 4 sessions" says what the filter hides.
  - **Line 2,** 8 px below, and the lines after it: the filters, then the sort setting, together in the filters' `role="search"` form, 8 px between lines. Turning a filter on or off, a chip or text in the field, moves nothing in them, at any width, and doesn't change how many lines they take; with line 1's count keeping its filtered width, the rows below stay put too (W75; Phil, 2026-10-27: "selecting a filter changes the alignment/rows"). Where they wrap depends on the width alone.
    - The [filter field](#search), on a line of its own, the column's full width, so its placeholder shows whole.
    - Then the [filter chips](#filter-chips), each as wide off as on, and Clear filters after them, a ghost sm [icon button](#icon-buttons) (W91), which keeps its room while no filter is on.
    - Then, at the right, the sort setting: Sort, a ghost sm [menu button](#menus) with the `sort` icon (W106's review), 12 px after Clear filters' room, whose menu is a radio group, "Sort by", of Urgency, Recent and Name, the chosen one checked (`SortMenu.tsx`). Since W106 there are three chips: Interactive 97 px, Background 105 and Has PR 77, which with Clear filters and their gaps take 327 px, and Sort 24, so their line needs about 363 px, a session list about 395 px wide (measured, W106; 385 and 417 px with W91's two chips and the 131 px select):
      - **A session list about 395 px wide or more** (440 px at a 1,440 px window, and 900 px windows): Sort shares the chips' line, at its right. 2 lines.
      - **Narrower** (360 px at a 1,200 px window, and 375 px): Sort has a line of its own after the chips', at the right. 3 lines.
      - **Why Sort is a menu button** (W106's review): with Has PR, the chips and the 131 px select didn't fit 1,440 px's 408 px bar, which went from W91's 2 lines to 3. The 24 px button gives the line back, as W91's icon did for Clear filters. What it gives up: the visible "Sort" label and the order shown at rest; its name, "Sort", is its tooltip and `aria-label`, and its menu shows the chosen order, checked. Its keys are the [Menus](#menus) pattern's: Enter, Space or ↓ opens it on the chosen order, the arrows, Home and End move, Enter chooses, and focus goes back to the button.
      - Clear filters wraps under the chips, in their group, only in a session list narrower than about 359 px: at 320 px, the narrowest pitwall reflows to (6.1, rule 12), the bar is 288 px, so there it's 4 lines (computed from the widths above; the app check has no 320 px window for the bar).
      - The app check counts the bar's lines at each of its windows, filtered and not (`scripts/appcheck/parts/lists.ts`).
    - **Why Clear filters is an icon** (W91; Phil, 2026-10-28). W75's text button was 88 px, and its room cost the bar a line where the chips and Sort fit together without it: at 1,440 px Sort had a line of its own, 3 lines, not 2, and at 320 px the room wrapped under the chips, 4 lines, not 3. The 24 px icon costs no window a line. It's an icon at every width, not only where the text would cost a line:
      - **One look:** a control that turned from words into an icon as the window or the session view's divider changed would be two controls to learn, and to find again.
      - **No break point to keep:** where the text costs a line depends on the session list's width, which the window and the divider set, and on how wide the chips, Sort and the words are, which the font, the text size and forced colours change. A container query would have to guess at all of them.
      - **What it gives up:** the visible words. Its name is its tooltip and its `aria-label`, as every icon button's is, and its glyph is Material Symbols' funnel struck through, filter_alt_off (`clear-filters`, 2.14). The [empty state](#empty-states) for a filter that matches nothing keeps its outline "Clear filters" text button, where there's room for the words.
    - **Why Clear filters keeps its room** (measured at 375 px, W75): appearing, the text button pushed Sort onto the next line; going, it brought it back. The icon (W91) would do that only in a session list about 385 to 417 px wide, where Sort fits beside the chips but not beside the chips and Clear filters; but the session list's width changes with the window and the divider, so the room is still kept. With it, Sort is always on the line it stays on. Clear filters can't go to a line of its own after Sort either: Sort would have to come before it on the page, out of the keyboard order.
    - **What it costs:** with no filter on, the bar is a line taller than before W75, when the field shared its line where it could: 64 px, not 28, at a 900 px window, and 96 px, not 64, at 375 and 1,200 px. At 1,440 px it's 64 px, as it was before W75, where W75's text button made it 96 (W91). With a filter on it's as tall as it was before W75 at 375, 900 and 1,200 px. At 320 px it's 3 lines, filtered or not, where W75's text button made it 4.
    - **Forced colours** (6.1, rule 17): a chip's border takes 1 px off its padding, or 2 px pressed, and off it still shares the check's 20 px between its sides, so it's as wide off as on there too.
- **Rows:** [session rows](#session-rows) in a `<ul>`, in the order the sort setting picks (Phil, 2026-10-20):
  - **Urgency,** the default: the sessions that need you first, whatever the reason (W69), then busy, then most recently active, with stale sessions after those. This is the index's order; the web UI sorts every list itself, in each order. A session marked [not needed now](#not-needed-now) sorts as one that doesn't need you, by its status (W88).
  - **Recent:** most recently active first.
  - **Name:** alphanumeric by name, as the repo list sorts its groups. It never moves as sessions change.
  - The setting applies to every selection, and is saved in `localStorage` as `pitwall.sort.v1`. Finished sections use it too, except that Urgency orders finished sessions by activity alone.
  - **A group:** its unfinished sessions and its PR rows (W106), then its [Finished section](#finished-section), which holds its finished background sessions and its [ended sessions](#ended-sessions) alike, but not one that owns an open PR, which isn't finished work.
  - **Needs you:** every row that needs you, from every group, each once, though in Every repo it worked in a session may be in several groups: a session that needs you, except for what's marked [not needed now](#not-needed-now) (W88), or that owns an open PR that needs attention, and a PR row whose PR does (W106). There's no Finished section, because finished work never needs you. A row marked not needed now here leaves at once, unless a PR it owns still needs you.
  - **All sessions:** every unfinished session from every group, each once, and every PR row, then one Finished section for all of them.
  - **Starred** (W53): the starred sessions among All sessions', each once, with no PR rows, which can't be starred, then a Finished section for the finished ones, collapsed by default and remembered as `view:starred`, as All sessions' is as `view:all`. Line 2 starts with the group's label, as in the other views. A row unstarred here leaves at once (see [Starred sessions](#starred-sessions)).
  - With two or more roots, "every group" is the open [root tab](#root-tabs)'s.
  - The summary's counts, and the document title's, count each session once. A group's summary is the sessions listed under it in the [Group sessions by](#preferences) mode, as its repo list item says.
- **Live updates:** each snapshot updates rows in place. If it would reorder rows (under Urgency or Recent) while the pointer is over the list or focus is inside it, keep the current order until both have left, then apply it.
  - Added and removed rows apply at once: a new row goes in after the row it follows in the new order, or first. A session that leaves the selected group, as one does when it's no longer listed, leaves at once too. A scan that finds the repos a session worked in moves it only as [Group sessions by](#preferences) says: never in Where it started; in Main repo a session started in a root itself goes to its main repo; in Every repo it worked in a session is added under each repo.
  - A focused row that leaves takes focus with it, so focus goes to the row that took its place, or the one before it when it was last, or the list's heading when none is left, never to the page.
  - The Finished section is held the same way.
  - A sort or selection the reader chooses applies at once, whatever the pointer and focus.
  - Nothing in the list is a live region, so none of this is announced.
- **Empty and loading states** fill the rows' area: the skeleton rows before the first snapshot (see [Skeletons and spinners](#skeletons-and-spinners)), and otherwise an [empty state](#empty-states), centred both ways in what's left of the column.

### Session view

- **One view, wherever it sits.** The view is rendered in the third column's pane in every layout. Below 1,200 px the pane is `display: contents` and the view is fixed over the list from inside it. So crossing 1,200 px with a session open changes how the view sits, not the view: it keeps its conversation, its scroll and its terminal, attached or not.
- **From 1,200 px: the third column.**
  - A pane on `--pw-surface`, full height under the header, separated from the session list by the divider, which draws the line between them.
  - The session list stays interactive and keeps its scroll position.
  - With nothing open, the column stays and shows the "Select a session" empty state, so the layout doesn't jump. While a `?session=` from the URL waits for the first snapshot, the column shows the view's waiting state (below).
- **Below 1,200 px: over the session list.**
  - At the right edge of the columns, in their grid row, so it starts below the header, and the app strip while that shows, whatever their height: `width: min(var(--pw-panel-w), 100%)` of the app's width, `--pw-shadow-overlay`, `--pw-z-panel`, sliding in from the right when it opens. The header is never under it, so New session, the connection badge, "updated", the theme switch and the keyboard shortcuts button are always there (coordinator, W31).
  - **What it covers is `inert` while it's open,** so nothing hidden can take focus or a click: the session list always, and the repo list beside it below 1,000 px (`--pw-sidebar-w` plus `--pw-panel-w`), where the view reaches into it. From 1,000 to 1,199 px the repo list is clear of it and stays usable, and so does the repo drawer, which opens over it from the header. A list it covers only in part is inert too: its controls at the right, such as the chips and Sort, are under the view.
  - `j` and `k` still change the session it shows, as ↑ and ↓ in its header do. Close, Back, Escape and `/` close it, and the list is usable again.
  - Focus in what it comes to cover, as when the window narrows past 1,200 px or the back button opens it, moves to its heading before the browser would drop it on the page.
  - It's a non-modal dialog with no backdrop (6.1, item 7): the header, and a repo list it doesn't reach, stay usable beside it.
  - At ≤ 600 px it's full width, with a "Back to sessions" ghost button (`back` icon) at the start of its header in place of the close icon.
  - On a short window (the low row in 2.12), it sticks to the top of the window, one window tall, as the third column does.
- **Divider** (three columns only, with or without a session open):
  - A 24 px hit area (WCAG 2.5.8) along the view's left edge, with a 1 px `--pw-border` line at the edge; on hover, focus or while dragging the line becomes 2 px `--pw-focus`, which is the focus indicator, so there's no ring. The hit area is 16 px over the view's gutter, which has nothing in it, and 8 px over the list's edge: its rows' padding and the outer 8 px of its scrollbar. So it covers none of the view's content, which starts after the gutter (W31).
  - `role="separator"`, `aria-orientation="vertical"`, `aria-valuenow` (the view's width in px, as shown), `aria-valuemin`, `aria-valuemax`, `aria-label="Resize the session view"`, `tabindex="0"`.
  - Drag to resize, within the widths in [2.12](#212-breakpoints-and-widths). ← and → move it 16 px (← widens the view, since the divider is its left edge), Home and End jump to the minimum and maximum, and a double-click resets to 760 px, or the maximum if that's less.
  - **Without dragging** (WCAG 2.5.7): the actions menu's Make view wider and Make view narrower move it 80 px, and Reset view width goes back to 760 px or the maximum. Each is `aria-disabled` when it can't, with why in its tooltip. They change the same width as the divider, through one store (`createPanelWidthStore()` in `panelWidth.ts`), and are in three columns only.
  - Save the width in `localStorage` as `pitwall.panel-width.v1`: on each key, on a double-click, on each of the menu's width items, and when a drag ends. A value that isn't a whole number of px from 560 up reads as 760.
- **A pull request's view** (W95) takes the session view's place, frame and layout, from `?pr=`: the third column shows one thing, a session or a PR, and opening either takes the other's place in one history entry. With Pull requests selected and nothing open, the column says "Select a session or pull request" (W106). See [Pull requests](#pull-requests).
- **The open session is in the URL:** `?session=<sessionId>`, after the selection.
  - Opening a session pushes a history entry, and opening the one that's open adds none; moving with ↑/↓ replaces it; closing pushes one without the parameter.
  - `popstate` makes the view match the URL.
  - **Waiting:** loading a URL with a `?session=` before the first snapshot opens the view in its waiting state, in the column or over the list as the layout says: Close (or Back to sessions) in the header, and after `--pw-delay-spinner` skeleton bars for line 1 (the name, 40 %) and line 2 (70 %), `aria-hidden`, with a visually hidden `role="status"` "Loading the session"; after `--pw-delay-long`, the same long-wait line as the session list's, centred in the body. Its `<h2>` is visually hidden text, "Session", which names the region. The first snapshot replaces it with the session, or with the unlisted state.
  - **Unlisted:** loading a URL with a session that isn't in the snapshot, and wasn't while the page was open, opens the view with an [empty state](#empty-states) centred in its body: the `info` icon, "This session isn't listed under these roots" as its title, which is the view's `<h2>` and names the region, and the sentence "pitwall lists no session with the id `<id>` under *roots*; it may have been removed, or run outside these roots." The header has only Close (or Back to sessions). The id is cut at 120 characters, and the id and roots are text. A session that leaves the snapshot while it's open, or that the back button returns to after it left, shows what it showed last instead, with the "no longer listed" alert.
  - Opening from the URL or the back button sends and changes nothing, and takes no focus. A running background session's view opens on its Terminal tab, which attaches, as a click on its row would have it, but its terminal takes no focus, after a reload too: nothing in the page asked for it, so the terminal's bar says how to type to it (W54, W57, see [Session view: header, tabs and footer](#session-view-header-tabs-and-footer)).
  - Never put the token in the query string. `web/src/token.ts` takes it out of the fragment before anything else reads the URL.
- **Inside:** a sticky header, the tabs, the scrolling body and a sticky footer (see [Session view](#session-view-header-tabs-and-footer)).

### App strip and page alerts

- **App strip:** a 32 px strip above the header for a state that affects the whole app and outlasts a dismissed alert. Today that's one: the relay is off until restart, which the snapshot's `relayOff` says. See [Alerts and banners](#alerts-and-banners).
  - Below 1,200 px the session view over the list starts below the header, which is below the strip, so both show in every layout.
- **Page alerts:** inline alerts at the top of the session list column, above its header, full column width: the poll failed, a server error, the relay alert and "Lost the connection". "Started *name*" is a [toast](#toasts).

---

## 4. Components

Each component lists its anatomy, sizes, states and tokens. "Hover" means `@media (hover: hover)`; on touch screens, anything revealed on hover is always visible.

### Buttons

| Variant | Fill | Edge | Text and icon | Hover | Use |
|---|---|---|---|---|---|
| **Primary** | `--pw-accent` | `--pw-shadow-accent` | `--pw-on-accent` | fill `--pw-accent-hover` | The one main action in a region: New session, Start session, Send |
| **Outline** | `--pw-surface` | `--pw-shadow-control` | `--pw-text`, icon `--pw-text-muted` | fill `--pw-surface-hover` | Secondary actions: Cancel, Try again, Clear filters |
| **Ghost** | none | none | `--pw-text-muted`, icon `--pw-text-muted` | fill `--pw-surface-hover` (`--pw-surface-hover-bg` when it sits on `--pw-bg`, 2.3), text `--pw-text`, edge `--pw-shadow-control` | Toolbar and header actions, icon buttons, Dismiss |
| **Danger** | `--pw-danger-solid` | none | `--pw-on-danger-solid` | 8 % darker (`filter: brightness(0.92)`) | Confirming a destructive action: Stop session, Remove session, End session |

| Size | Height | Padding | Text |
|---|---|---|---|
| sm | 24 px | 2 px 8 px | s 13/20, 500 |
| md (default) | 28 px | 4 px 8 px | m 14/20, 500 |
| lg | 32 px | 6 px 12 px | m 14/20, 500 |

- **Anatomy:** an optional 16 px leading icon, 6 px before the label; `--pw-radius-md`; `white-space: nowrap`.
- **Pressed:** `--pw-surface-strong` fill (outline and ghost), or `--pw-accent-hover` (primary).
- **Focus:** `--pw-ring-focus` added to the variant's shadow.
- **Component:** `Button` (`web/src/components/Button.tsx`), with `variant`, `size`, `icon`, `disabled`, `busy` and `busyLabel`. Every button with a disabled or busy state uses it, and so do the header's New session and the session view's Back to sessions (W31). Icon-only buttons, such as Close, Repos and the keyboard button, are [icon buttons](#icon-buttons), which `Button` doesn't draw.
- **Disabled:**
  - Uses `aria-disabled="true"`, not `disabled`, so it stays focusable, Tab reaches it, and its tooltip can say why. Activation does nothing: the click handler ignores the click that Enter and Space bring too, and a submit button doesn't submit its form.
  - Text and icon `--pw-text-disabled`; fill `--pw-surface-sunken` (primary, outline and danger), or none (ghost).
  - The edge stays `--pw-shadow-control` (none for ghost); the cursor is `not-allowed`; hover and press change nothing, and the focus ring still shows.
- **Busy:**
  - A spinner replaces the icon (or comes before the label), the label changes to the progressive verb ("Starting…"), and `aria-busy="true"` is set.
  - The button keeps its width (set `min-width` to the idle width), and repeat clicks are ignored.
  - It keeps its variant's look, even where it's `aria-disabled` too, as Send is while sending: the spinner and the label say it's busy. The spinner takes the button's text colour.
- **One primary per region:** the header, a dialog's footer, the session view's footer.
- **Labels:** a verb or verb plus object, sentence case (see [Content](#5-content)).

### Icon buttons

- **Sizes:** square: sm 24 px (4 px padding), md 28 px (6 px), lg 32 px (8 px). The icon is 16 px, or 24 px in lg when it stands alone.
- **Variants:** ghost by default; outline when it stands alone outside a toolbar. The filter bar's Clear filters, beside the outlined chips, is ghost (see [Filter chips](#filter-chips)).
- **Names:** always an `aria-label`, plus a tooltip with the same text and its shortcut as key caps. The icon is `aria-hidden`.
- **Toggles** (such as a theme option) also set `aria-pressed`.
- **Target size:** 24 × 24 px at least (WCAG 2.5.8), so there's no icon button below sm.

### Inputs, textareas and selects

- **Field:** height 32 px (`--pw-control-lg`), padding 6 px 12 px, m 14/20 text, `--pw-text` on `--pw-surface`, `--pw-shadow-input`, `--pw-radius-md`, no `border`.
- **Placeholder:** `--pw-text-subtle`, at full opacity (the browser's default is fainter). Placeholders are examples, never the only label.
- **Focus:** `--pw-shadow-input`, `--pw-ring-focus`.
- **Invalid:**
  - `--pw-shadow-input-error`, `aria-invalid="true"`, and an error message below in `--pw-danger-fg`, meta size, linked with `aria-describedby`.
  - Errors show after the first submit, then follow the typing.
  - On submit, focus moves to the first invalid field.
- **Disabled:** `--pw-surface-sunken` fill, `--pw-text-disabled` text, the same edge.
- **Label:** above the field, label style (xs 12/20, 500), 4 px gap.
  - Optional fields add "optional" after the label in `--pw-text-subtle`, 400 weight. Required fields aren't marked: most fields are required.
- **Help text:** below the field, meta size, `--pw-text-muted`, linked with `aria-describedby`.
- **Paths and model names** use the mono path style; the field turns ligatures off.
- **Textarea:** the same box, padding 6 px 12 px.
  - In dialogs: resizable vertically, at least 6 rows.
  - In the message box: auto-grows from one line to eight, then scrolls; no resize handle.
- **Select:** native `<select>` in the same box, with a 16 px `select` icon at the right in `--pw-text-muted` (`appearance: none`), 8 px from the edge; the text has 32 px of padding on the right to clear it.
- **Checkbox:** the native `<input type="checkbox">`, 16 px, with `accent-color: var(--pw-selected-border)`, a label after it 6 px away, and the label clickable.
  - The fill is at least 3:1 on every neutral surface in both themes (2.5).
  - The browser draws the check and the unchecked edge in its own colours. Measured in Chrome: a white check on the light fill and a `#3B3B3B` check on the dark one (3.50:1), and an unchecked edge of `#767676` on white (4.54:1) and `#858585` on `--pw-surface` dark (4.77:1).
- **Radio group** (W59): `RadioGroup` (`web/src/components/RadioGroup.tsx`), for a setting with a few choices, as [Preferences](#preferences) has them.
  - A `<fieldset>`, named by its `<legend>` in label type (xs 12/20, 500), 8 px above the options. An optional hint for the whole group comes under the legend, as help text, linked to the fieldset with `aria-describedby`; no group has one since W62 took out the single-key shortcuts' group, the one that did.
  - The options, 8 px apart, each the native `<input type="radio">`, 16 px and round, with `accent-color: var(--pw-selected-border)` as the checkbox has; its label (m 14/20, 500) 6 px after it, clickable; and its one line saying what it does under the label, indented to it, in meta type and `--pw-text-muted`, linked with `aria-describedby`.
  - The browser draws the dot and the unchecked ring in its own colours, as it does the checkbox's check and edge, from the same fill. The ring hasn't been measured on its own.
  - The radios share a name of their own (`useId()`), so two groups never join, and the browser makes each group one Tab stop, its checked radio, with ↑ ↓ ← → moving to the previous or next option and choosing it. A choice applies at once: nothing submits. The focus ring is round: a 16 px `--pw-radius-full` box around the radio draws it, since Chrome draws a native radio's own ring square, whatever its radius.

### Search

- **The filter field:** height 28 px, the whole width of a line it has to itself (see [Session list](#session-list)). A 16 px `search` icon at 8 px from the left in `--pw-text-subtle`; text padding-left 32 px, and padding-right 32 px once there's text. A placeholder too long for the field ends in an ellipsis.
- **Right side:** a `/` key cap while it's empty and unfocused, 4 px from the right edge and centred, while the single-key shortcuts are on; a ghost sm `clear` icon button, "Clear text", 2 px from the right edge, once there's text. Before W91's review it was "Clear filter", one letter from the filter bar's Clear filters, which shows beside it. Clearing with it keeps focus in the field. The browser's own clear button is hidden.
  - The key cap is a hint, `aria-hidden`, and clicks go through it to the field. The field says the same in `aria-keyshortcuts="/"`, only while the shortcuts are on.
  - While the shortcuts are on, the text keeps 32 px clear on the right, focused or not, so the placeholder doesn't move when the key cap goes.
- **Behaviour:**
  - Filters as you type (pitwall filters in memory); no Enter needed.
  - Escape in the field clears it if it has text, otherwise leaves the field. Escape that clears stops there (it calls `preventDefault()`); Escape that leaves the field goes on to close the session view, as in the [keyboard map](#62-keyboard-map).
  - Matches are highlighted in session names, titles and the group labels that start a row's line 2: each match is a `<mark>` with `--pw-highlight` fill and `--pw-text` text, whatever the colour of the text around it, since that's the pair 2.5 checks. Matching is case-insensitive, on the trimmed text. The filter also matches a session's directory and the labels of the repos it worked in (`SessionSummary.workedIn`, W39), which the row doesn't show, so a session that matches only by those has no highlight.
  - **A repo's name finds every session that worked there:** typed in All sessions, it lists the sessions started in the repo and those started elsewhere that worked in it, a repo with no group of its own included. That's how to see all of a repo's work, whatever [Group sessions by](#preferences) lists under it.
  - It filters the session list's selection: one group, Needs you or All sessions. The repo list's counts don't change.
- **Accessibility:** inside `role="search"`; a visually hidden label "Filter sessions"; placeholder "Filter by session, title, repo or directory".

### Combobox

A text field with a list of suggestions that narrows as you type (W70; Phil, 2026-10-27: "Having to enter from /Users is difficult UX."). The WAI-ARIA APG's [editable combobox with list autocomplete](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-autocomplete-list/): what's typed stays as typed, and the list only offers. The [New session dialog](#dialogs)'s "Another directory under a root…" uses it; anything that later needs one builds on it.

- **Component:** `Combobox` (`web/src/components/Combobox.tsx`), with the value, the options to show (already narrowed, best first), `onInput`, `onAccept`, status lines and an announcement. The caller narrows; the component draws the field and the list and handles the keys. The directory list's narrowing is `web/src/directories.ts`.
- **Anatomy:**
  - **The field:** a [text field](#inputs-textareas-and-selects), in the mono path style when it takes paths, with its label, help text and problem as any field has them.
  - **The popup:** 4 px under the field, as wide as it, over what follows (`--pw-z-dropdown`): a [menu](#menus) panel's look, `--pw-surface-overlay`, `--pw-shadow-2`, `--pw-radius-md`, padding 4 px.
  - **The listbox:** its options, scrolling past about seven (`7.5 × --pw-control-lg`). Each option is 32 px tall at least, padding 6 px 8 px, `--pw-radius-sm`, in the field's type (mono s 13/20, ligatures off, for paths), cut in the middle when there isn't room (`MiddleEllipsis`, 5: Labels). A quiet marker at its end, xs 12/20 in `--pw-text-subtle`, such as "repo".
  - **Status lines:** after the options, divided from them by 1 px `--pw-border`, in meta type and `--pw-text-muted`, padding 4 px 8 px: loading, how many there are, none match, not every one listed. With no options, they're all the popup shows.
- **States:**
  - **Closed:** the field alone. It opens as a choice reveals the field and focus moves into it, on a click in the field, on typing, and on ↓ or ↑.
  - **Open:** the options and the status lines. With neither, the popup stays shut and `aria-expanded` is false.
  - **Highlighted option:** the menu items' keyboard highlight, a `--pw-surface-hover` fill with `--pw-ring-focus-inset`, since focus stays in the field and a fill alone is under 3:1. Hover gives the fill alone. Forced colours: a 2 px `Highlight` outline, and the popup a 1 px `CanvasText` outline, as a menu has.
  - **Loading:** a status line with a spinner, "Loading directories…".
  - **Busy:** while the dialog's action runs, the field is read-only and `aria-disabled`, and the popup shuts.
  - **Invalid:** the field's own invalid state and problem, as any field's.
- **Keys** (focus stays in the field throughout):
  - ↓ opens the list on the first option, or moves to the next, wrapping; ↑ opens it on the last, or moves to the previous, wrapping. Alt + ↓ opens it without highlighting; Alt + ↑ closes it.
  - Enter accepts the highlighted option and closes the list. It never submits the form, with or without one highlighted; ⌘/Ctrl + Enter is left to the form, so it still starts the session.
  - Escape closes an open list, and goes no further, so the dialog stays open. With the list shut, it goes on as before, closing the dialog.
  - Tab and Shift + Tab leave without accepting, and close the list.
  - ← → Home End move the caret and take the highlight off the options.
  - While an input method is composing, every key is its own (`isComposing`, or Safari's keyCode 229 after `compositionend`), so ↓ picks its candidates and Enter confirms them without choosing an option.
- **Pointer:** a click on an option accepts it and focus stays in the field (the press is `preventDefault()`ed, so the field never blurs). A press anywhere outside closes the list, and so does focus moving to another control in its form, as when a submit puts focus on a field with a problem. Focus leaving the page, as when you switch windows, leaves it as it was, as a menu does.
- **ARIA:** the field is `role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, `aria-controls` its listbox, and, while one is highlighted, `aria-activedescendant` that option. The listbox is `role="listbox"`, named ("Directories"); each option `role="option"`, `aria-selected` on the highlighted one, its marker after a visually hidden comma, so it's heard as "~/code/outpost, repo".
- **The count is announced** in a visually hidden `role="status"` (`aria-live="polite"`) region, 500 ms after the list last changed (`ANNOUNCE_DELAY_MS`), so typing isn't talked over at every key: "12 directories.", "50 of 312 directories. Keep typing to narrow them.", "No directories match.", and " Not every directory is listed." after it when that's so. It's emptied as the list closes.
- **Text:** option labels are text, through `plainText()`, never markup.
- **Moving focus on a choice:** choosing "Another directory under a root…" moves focus into the field it reveals. That's a change of focus on a select's change, which WCAG 3.2.2 asks to be expected: the option is the select's last, and ends in "…", which says it opens more choices (5: Casing and style).

**The directory combobox** (New session's "Another directory under a root…"):

- **The list:** `GET /api/directories` (`DIRECTORIES_PATH`), once per opening of the dialog, the first time the choice is made. The server walks each root three levels down, directories only: no symlinks, nothing hidden, no `node_modules`, no names with control or bidi characters or with whitespace at either end, which can't be told apart on screen, nothing it can't read, and no folder swapped for a symlink while it walks. At most two file calls run at once, for all the roots, and no new walk starts while one that hung is still out, so a hung network folder can't take the threads the index reads with. A folder with a `.git` entry is a repo. Typing makes no requests.
- **Options:** the open [root tab](#root-tabs)'s directories, or every root's without tabs, each as the root shortened to `~` and the path under it, such as `~/code/outpost`, with "repo" on repos. A directory under an inner root is that root's tab's, not the outer one's (W38).
- **Matching:** case-insensitive, and on NFC, so a name stored decomposed matches the same text typed composed. Every whitespace-separated term must be in the path under the root, or in the whole shortened path when the text starts with `~` or `/`. Text starting with `/` also matches the absolute path, so a pasted path finds its option.
- **Ranking,** on the last term, from its last `/`: the last segment equal to it, then the last segment starting with it, then any segment starting with it, then the rest; ties go to the shallower, then alphabetically, ignoring case. At most 50 show.
- **The value:** a chosen option shows as its shortened path, and the request sends its absolute path, the root, `/`, then the path, for as long as the field shows exactly that label; edited at all, even by a space, it's typed text. Typed text works as before: an absolute path as it is, and a `~/` path whose start is a root's shortened form under that root, so a directory deeper than three levels, or one the list stopped short of, can still be typed. The dialog's checks and the server's still apply.
- **Placeholder:** the first offered root shortened, then `/…`: "~/code/…".
- **Wording:**
  - Loading: "Loading directories…"
  - Many: "50 of 312. Keep typing to narrow them."
  - None match: "No directories match. A typed path still works."
  - None to list: "No directories to list. You can type a path."
  - Cut short (`truncated`, at 5,000 directories or 2 seconds): "Not every directory is listed. You can type a path."
  - Couldn't list them: a field hint under "Under *roots*.", linked to the field: "Couldn't list the directories. Type a path." The list stays shut and the field takes a typed path.
  - A `~` path under no root: "Use a directory under ~/code."; a relative path: "Use an absolute path, or one that starts with ~/."

### Filter chips

- **Size:** 24 px tall, label style (xs 12/20, 500), `--pw-radius-sm`, an optional count after the label in tabular numbers.
  - **As wide off as on** (W75), so pressing one moves nothing after it: on, padding 0 8 px, with the check before the label; off, padding 0 18 px, the check's 20 px (16 px and its 4 px gap) shared between the sides, so the label is centred. The label moves 10 px within its chip as the check comes and goes; the chip's box doesn't.
- **Off:** `--pw-surface`, `--pw-shadow-control`, text `--pw-text-muted`. Hover: `--pw-surface-hover`, text `--pw-text`.
- **On:** `--pw-selected`, `--pw-ring-selected` in place of the control edge, text `--pw-info-tint-fg`, and a 16 px `copied` (check) icon before the label, 4 px from it.
- **Focus:** `--pw-ring-focus` added to the chip's edge or ring.
- **Semantics:** `<button aria-pressed>`, in a group with `aria-label="Filters"`, 8 px apart. The check icon is `aria-hidden`, so a chip's name is its label.
- **The chips:** "Interactive" and "Background", which combine as OR, so either one alone narrows the list and both together show every session, and "Has PR" (W106), which keeps the rows with an open PR, the sessions that own one and the PR rows, in any list. Has PR narrows what the kind chips show, so Interactive and Has PR is the interactive sessions with an open PR. A kind chip keeps PR rows out: a PR no session owns is no session of either kind. Has PR is there only while there's a list of pull requests (`prListState()`'s 'list'): not before the server sends one, nor while the first fetch runs, nor with pull requests off (`--no-prs`) or `gh` missing, not logged in or failing with no list, when it would only empty the list.
  - **The Pull requests view's** (W101, W106): "Yours", "Review requested" and "Mentioned", how a PR is yours (`PullRequestRelation`), in place of the session list's, which combine as OR too, so none on is All. A PR row passes by its PR's relation, a session's row by any PR it owns. `FilterChips` takes them as its `options` and `labels`. Their Clear filters is on the header's last line, before Refresh, not after them: see [Pull requests](#pull-requests).
  - "Needs you" is a view in the [repo list](#repo-list), replacing today's "Needs attention only" checkbox, and finished sessions have their own [section](#finished-section), so neither is a chip.
  - **Clear filters** appears after the chips, inside their group so it wraps with them, when any chip is on or the field has text. It clears the text and the chips, and puts focus in the field, since the button itself goes away.
    - **A ghost sm [icon button](#icon-buttons) at every width** (W91): 24 px square, the `clear-filters` icon, named "Clear filters" by its tooltip, which is its `aria-label` (`Tooltip`'s `label` relation). That name is distinct from the field's Clear text, which shows beside it while there's text. Its tooltip opens on hover and on keyboard focus, as every icon button's does. Tab reaches it after the chips, and Enter or Space presses it. Why an icon, and not only where the words cost a line, is in [Session list](#session-list).
    - It isn't the field's Clear text, the `clear` icon inside the field, which clears the text alone and keeps focus in the field.
    - **Ghost, not outline** (W91's review), though an icon button is outline where it stands alone outside a toolbar ([Icon buttons](#icon-buttons)). Outlined, it had the off chip's fill, edge and 24 px height, 8 px after the last chip, so it read as a third chip with no label: a toggle's look, on the action that clears the toggles. Ghost keeps it apart from them, and it takes the control edge on hover, as every ghost button does. It sits in the filter bar's row of controls, with the chips and Sort, which counts as a toolbar for that rule.
  - While no filter is on, its room is kept (W75): an unseen copy in its place, a `<span>` with the button's classes and icon, `visibility: hidden` and `aria-hidden="true"`, so it's no button, takes no focus, has no name and says nothing to a screen reader. So what comes after it, such as the session list's Sort, never moves as the button comes and goes.

### Tabs

A row of tabs that switches what's below them: the session view's Conversation, Terminal, [Sub-agents](#sub-agents) and Pull requests (W106) (see [Session view: header, tabs and footer](#session-view-header-tabs-and-footer)), and the header's [root tabs](#root-tabs) (W38). One pattern, `web/src/tabs.ts`, with a look for each place.

- **ARIA:** `role="tablist"`, named (`aria-label`); each tab a `<button role="tab">` with `aria-selected` and `aria-controls`; the panel `role="tabpanel"` with `aria-labelledby` the open tab. The root tabs all control one panel, the columns, which the open tab names.
- **Keys:** the tablist is one Tab stop, the open tab's (roving `tabindex`). ← and → move focus to the previous and next tab, wrapping at the ends; Home and End to the first and last. A key with ⌘, Ctrl, Alt or Shift is left alone, so Alt + ← still goes back.
- **Opening is manual,** never on focus: Enter, Space or a click opens the focused tab, and focus stays on it. Opening Terminal attaches, and opening a root tab changes all three columns and adds a history entry, neither of which an arrow key should do.
- **What a tab carries:** its label, then, where it has one, a badge or a dot, whose meaning is in the tab's name as visually hidden text (", attached", ", 2 need you"), or a count in brackets, which is part of the label ("Sub-agents (6)", W77).
- **The session view's look:** 28 px tall, padding 4 px 8 px, m 14/20, 500, a 16 px icon; inactive `--pw-text-muted` with a `--pw-surface-hover` fill on hover; open `--pw-text` with a 2 px `--pw-text` underline on the row's bottom edge.
  - **On a narrow row** (W77; the tab row is a container, `session-tabs`): from 440 px down the tabs drop their icons, so Conversation, Terminal and "Sub-agents (6)" fit at 375 px, whatever the session; the labels name them. From 360 px down their padding is 4 px each side; and in a window 360 px or narrower the row's own padding is 12 px and, as a last resort, as at 320 px with a long count, the row scrolls sideways, its scrollbar hidden, rather than the page, and since it clips, a tab's focus ring is inset there. Focus moving along the tabs scrolls the focused one into view.
- **The root tabs' look:** path type, as the root was (xs 12/20, mono, ligatures off), at least 28 px tall (`--pw-control-md`), padding 4 px 8 px, `--pw-radius-md`, 4 px apart, wrapping. Inactive: `--pw-text-muted`, no fill; hover `--pw-surface-hover-bg`, on the header's `--pw-bg`, with `--pw-text`. Open: the selected repo list item's look, `--pw-selected` with `--pw-ring-selected`, `--pw-text` at 500. An underline would sit on no shared edge once the tabs wrap. Focus: `--pw-ring-focus`, with the ring when open. The need-you badge keeps the badges' own type and is never cut; the label gives way first, with a middle ellipsis.

### Badges

- **Shape:** 20 px tall, min-width 20 px, padding 0 6 px, `--pw-radius-sm`, label style (xs 12/20, 500), tabular numbers, `white-space: nowrap`.
- **Optional leading element:** a 16 px icon, or an 8 px status dot, with 4 px gap.

| Style | Fill | Edge | Text |
|---|---|---|---|
| **Solid** | `--pw-<tone>-solid` | none | `--pw-on-<tone>-solid` |
| **Subtle** | `--pw-<tone>-tint` | `inset 0 0 0 1px var(--pw-<tone>-border)` | `--pw-<tone>-tint-fg` |
| **Outline** | none | `outline: 1px dashed var(--pw-border-dashed); outline-offset: -1px` (badges aren't focusable, so the outline is free) | `--pw-text-subtle` |

- **Solid is for "needs you" only.** Everything else is subtle or outline.
- **Status badges take their look from the state aliases** (`--pw-state-*`, 2.6), the rest from the tone tokens, so a state's look changes in one place.
- **In a row,** a status badge too long for its line ends in an ellipsis (see [Session rows](#session-rows)); its full text is still in the DOM.

- **Needs you comes from the index** (`SessionSummary.needsYou`, W69): a session needs you for one of `NeedsYou`'s reasons, judged from its context: the first four rows below show its five reasons, and a session has one at most, the first that holds. Claude Code's `state: 'blocked'` alone isn't one.
- **And from its pull requests** (W106): a session's row needs you too while an open PR it owns needs attention (`prNeedsAttention()`), and a PR row while its PR does. That adds no status badge: the session's own stays as its state says, its PR badge is subtle danger, and line 2 says why ([Session rows](#session-rows)). It counts wherever Needs you counts, its badges, the root tabs' and the page title.

| Session state | Label | Style |
|---|---|---|
| A prompt on screen (`needsYou` 'prompt') | "Waiting: *reason*" | solid warning |
| A background job whose own line says what it needs ('claude-code'), or blocked with a job file pitwall couldn't read ('blocked') | "Blocked", and ": *reason*" when Claude Code gives `waitingFor`. The job's line is on the row's line 2 | solid warning |
| Resumed, or restarted after you confirmed it, in this run of pitwall, with no prompt since ('restarted') | "Waiting for your prompt" | solid warning |
| Its last turn asked you ('asked') | "Asked you" | subtle warning |
| Any of the four above, marked [not needed now](#not-needed-now) for what it needs (W88) | As above, and "Not needed now" after it in the session view | outline, as a stale Blocked is: solid is for needing you |
| Blocked, and nothing needs you, as a resumed session's "send a prompt to start" once pitwall has restarted | As its process is: no badge in the list and "Idle" in the session view, or "Busy", or "Not running" | as those rows |
| Blocked and stale | "Blocked: *reason*", plus a "Stale" badge | outline, plus subtle neutral |
| Failed | "Failed" | subtle danger |
| Done | "Done" | subtle success |
| Stopped | "Stopped" | subtle neutral |
| Ended: an interactive session whose process has exited (W67) | "Ended" | subtle neutral, as Stopped: it has no status or state of its own |
| Process not running | "Not running" | outline |
| Busy / working | "Busy" / "Working", with an 8 px dot in `--pw-info-tint-fg`, the badge's text colour (2.1) | subtle info |
| Idle | No badge in the list; "Idle" in the session view | subtle neutral, in the session view only. Needs-you is unaffected: it comes from the index's `needsYou`, never from the badge |
| Unknown | "Unknown" | subtle neutral |
| Finished, and it asked you | "Asked you", with a tooltip saying it isn't counted: "… It has finished, so …", or for an ended session "… It has ended, so it isn't counted as needing you." | outline |

- **A sub-agent's state** (W77, [Sub-agents](#sub-agents)), from `SubagentState`, with the session states' looks: "Running", as Working is, subtle info with its dot; "Done", subtle success; "Failed", subtle danger; "Stopped", subtle neutral; and no badge when its state is unknown, rather than one that says so.
- **Other badges:**
  - **Pull requests** (W95, W106): a PR's state badges, Review requested and Mentioned among them (W101), and the session row's "#51 CI failing" badge: see [Pull requests](#pull-requests). The Pull requests item's count is a need-you count, solid warning, since W106: PRs count in Needs you.
  - **Counts:** subtle neutral ("4", "2 of 5").
  - **Needs-you counts:** solid warning ("2 need you").
  - **Errors in folded tool calls:** subtle danger: "1 error" or "3 errors" on a fold's toggle, and "error" on each failed call.
- **Stale** carries its explanation in a tooltip, on hover (`Badge`'s `hint`): "Blocked with no activity for more than 7 days, whether or not its process is running. Usually waiting on a question that no longer matters." A badge isn't focusable, so in a row that tooltip is hover-only; the session view shows Stale, and a finished session's Asked you, with an info button after each whose name and tooltip are the explanation, so the keyboard and screen readers reach it (W31).

### Status dot

- **Shape:** 8 px circle, `--pw-radius-full`, in a tone's `-fg` colour on a neutral surface, or the tint's `-tint-fg` inside a subtle badge, as 2.1 asks (3:1 or better against what it sits on, 2.5).
- **Use:** inside badges, in the connection badge, and in the conversation's working line in its spinner's place under reduced motion, in `--pw-info-fg` (W102). Never the only sign of a state: a text label always goes with it. It doesn't animate.

### Connection badge

`role="status"`, in the header:

| Connection | Badge |
|---|---|
| Connecting | subtle neutral "Connecting…", with a spinner |
| Live | subtle success "Live", with a dot |
| Reconnecting | subtle warning "Reconnecting…", with a spinner |
| Token rejected | subtle danger "Token rejected" |

The spinner is the [`Spinner`](#skeletons-and-spinners) component, with no spinner of its own, and it and the dot take the badge's text colour. The badge sits in the element that's `role="status"`, so a change is announced.

### Session rows

- **Container:** an `<li>` in the session list's `<ul>`, padding 8 px 16 px, a 1 px `--pw-border` line between rows, `--pw-surface`.
- **Two lines,** 2 px apart:
  1. **Identity:**
     - The name (m 14/20, 500, `--pw-text`), then " · " and the title (m 14/20, 400, `--pw-text-muted`), on one line with an ellipsis. The full title and where it came from are in a tooltip; a title whose source isn't known has one only when it's cut. The name has the session's id and start time in a tooltip.
     - These tooltips, and those below, open on hover only: in a row, only the name's button and the toggles are focusable, and the tooltip on its heading doesn't open for the button's focus. The toggles' own tooltips, their names, open on focus too, as every icon button's does. The full title and line 2 are in the DOM, so screen readers have them, and the session view shows them all.
     - Then, at the right, while the session owns an open pull request (W106), its [PR badge](#pull-requests), "#51" in its state's colour, and "+2" for more (W95), then the status badge(s) and the relative time (meta, `--pw-text-subtle`, tabular). The badges sit just before the time, whose slot is fixed and right-aligned (see [Timestamps](#timestamps)), so they line up down the list and stay put as the time ticks.
     - Last, the [star toggle](#starred-sessions) (W53): a ghost sm icon button, filled and always shown while the session is starred, outlined and shown only on the row's hover and focus otherwise, and always on a touch screen. Its slot is kept on every row, so nothing moves as it shows, and its negative block margins keep line 1 20 px tall. It's after the time, which is where the eye already goes down the list, and outside the name's button, so pressing it never opens the session.
     - **Line 1 never wraps.** The title gives way first, then the name, then the status badge, which leaves the name and the time at least 10em. "Stale" and a finished session's "Asked you" are short and stay whole. The " · " is drawn with the title (CSS `::before`, not read out), so it goes when the title has.
  2. **What it wants or did last,** on one line with an ellipsis, when the transcript is readable:
     - "Needs: *line*", a background job's own line on what it needs, while that's why it needs you (`needsYou` 'claude-code', W69), as plain text, the same look as Asked. It's from the job's file, not the transcript, so it shows whatever the transcript's state; or
     - "Asked: *excerpt*" (meta, the label in `--pw-warning-fg` 500, the excerpt in `--pw-text`); or
     - "You: *last prompt*" (meta, `--pw-text-muted`).
     - **Why a PR it owns needs you** (W106), in place of those, while that PR needs attention and the session doesn't need you itself: "CI is failing on #51", "#51 has merge conflicts", "Changes are requested on #51" or "Your review is requested on #51", in `--pw-text`, as an Asked excerpt is (`prReason()`). One that needs you itself shows what it needs, and the PR badge says the rest.
     - The full text is in a tooltip when it's cut short.
     - **Sub-agents running** (W77): while the snapshot's `subagentsRunning` is set, the line ends with "· 2 sub-agents running", or "· 1 sub-agent running", in `--pw-text-subtle`, as the group's label is: quiet, never a badge. The "·" is drawn only when something comes before it, and is `aria-hidden`, as the label's is. What it wants or did last gives way first, with its ellipsis; the count is never cut (`flex: none`). Nothing when none runs, so most rows are as they were. A session with no question, prompt or label shows the count alone.
       - **Why line 2, not line 1:** line 1 is the session's identity, then the badges and the time in its fixed slot, which line up down the list, with a give-way order of its own (the title, then the name, then the status badge). A count there would push the badges and the time out of line on some rows, and add a fourth thing to give way. Line 2 says what the session wants or is doing, and sub-agents running are what it's doing; it already gives way at its end, so the count can sit there whole, and rows stay two lines.
     - **The [Not needed now](#not-needed-now) toggle, last,** while the session needs you or is marked not needed now (W88): a ghost sm icon button, filled and always shown while it's marked, outlined and shown only on the row's hover and focus otherwise, and always on a touch screen, as the star is. Its icon is under the star's. What's before it gives way first, with its ellipsis, the sub-agents count included. Its negative block margins keep line 2 20 px tall, and a row that needs you with nothing else to say on line 2 has one for it.
       - **Why line 2, not line 1:** line 1 is the session's identity, then the badges and the time in their fixed slot. A slot there, before the badges, took room from the name on every row that needs you: at 1,440 px, `pitwall-test-docs` became `pitwall-test-d…` beside "Waiting: permission prompt". After the time it would have pushed the badges and the time out of line on the rows that have it. Line 2 already gives way at its end, and says what the session needs, which is what the toggle is about.
     - **"Not needed now"** (W88), while the session is marked so: in `--pw-text-subtle`, as the group's label is, after it and " · ", and before what it needs or asked, which is in `--pw-text-muted`, its label too, with no tone colour: it doesn't need you now. First, so it shows when what follows is cut.
     - In Needs you and All sessions, the line starts with the group's label (meta, `--pw-text-subtle`; the root's own directory as its path) and " · ": the group the session is listed under in the [Group sessions by](#preferences) mode, its home group. In Every repo it worked in, which lists it under several, that's the group it started in, or, for one started in a root itself that worked in repos, its main repo (W42). A session with neither a question nor a prompt shows only the label there, and no line 2 in a group.
     - In a group's own list, the line has no label: the heading names the group. W34's "started in" label went with W39, and Every repo it worked in doesn't bring it back: the session view's line 3 says where a session started and the repos it worked in.
- **Not in the row:** the last reply, the relay exchange, the cwd, the attach command and a Message button. They're in the session view: the conversation, the message box, the header and the actions menu. A row stays two lines however long the session's replies are.
- **Opening:** the name is a `<button>` with `aria-controls="session-view"`, `aria-current="true"` when its session is open, and `data-open-session`. The session view has `id="session-view"`.
  - **Tab stops in a row:** the name's button, then the star toggle; on a row that needs you or is marked not needed now, then the Not needed now toggle, on line 2 (W88). ↓ and ↑ move between names; `j` and `k` from either toggle start at its row.
  - A click anywhere on the row that isn't a control (and isn't the end of a text selection) opens the session too. Keyboard users use the button.
  - **Focus:** the name's ellipsis would clip its button's ring, so the row shows `--pw-ring-focus-inset` while the button has focus, on top of the bar when there is one. The button keeps the transparent outline, inset, for forced colours.
- **States:**

| State | Fill | Marker |
|---|---|---|
| Default | `--pw-surface` | |
| Hover | `--pw-surface-hover` | |
| Open, hovered or not | `--pw-selected` | `--pw-ring-selected` |
| Needs you | `--pw-surface` | `inset 3px 0 0 var(--pw-state-attention-bar)` |
| Needs you and open | `--pw-selected` | both the ring and the left bar |
| Finished, ended sessions included (W67), unless it owns an open PR (W106) | `--pw-surface` | the name at 400 weight in `--pw-text-muted`, and the "Asked:" label and excerpt in `--pw-text-muted` too |
| Marked [not needed now](#not-needed-now) (W88) | `--pw-surface` | no bar; the status badge outlined, "Not needed now" on line 2, and the "Asked:" or "Needs:" label and its text in `--pw-text-muted` |

- **Needs you has no row tint,** only the bar and the badge. On 2026-10-20, nine of Phil's fifteen sessions needed him, and tinting every one of them turned most of the list yellow. The Needs you view collects them instead.
- **Transcript notes:** "Transcript not found" or "Transcript unreadable", meta, `--pw-text-subtle`, in place of what line 2 would say, after the group label in Needs you and All sessions.
- **Height:** never fixed; rows grow with zoom and text spacing.

### Repo list items

- **Item:** a link, `<a href="?repo=…">` (or `?view=…`), in the repo list's `<ul>`, with `aria-current="page"` when it's the selection. The page handles the click, with no reload.
  - At least 32 px tall, padding 6 px 8 px, `--pw-radius-md`, 8 px gaps. It grows with zoom and text spacing.
  - Left to right:
    1. A group's kind icon (`repo` or `directory`, 16 px, `--pw-text-subtle`). The three views have no icon.
    2. The label (m 14/20, 400), on one line with a middle ellipsis; the full label is in a tooltip when the ellipsis cuts it, on hover and on focus. Then a visually hidden ", git repo" or ", directory", after the label so the link's name starts with what it shows.
    3. At the right, one count, each with a visually hidden noun so it reads as "2 need you" or "4 sessions":
       - a solid warning badge with how many need you, when any do;
       - otherwise, how many sessions there are (meta, `--pw-text-subtle`, tabular): its rows, each session once and each PR row (W106).
       - A group's counts are the sessions listed under it, each once, in the [Group sessions by](#preferences) mode. In Main repo and Where it started each session is in one group, so the groups' counts under a root add up to that root's sessions, every root's to All sessions', and the groups' badges to Needs you's, hidden groups' included.
       - In Every repo it worked in, a session counts in each group it's under, so the groups' counts can add up to more than All sessions', and their badges to more than Needs you's. All sessions and Needs you still count each session once, and so do the root tabs' badges.
       - Needs you shows its badge, or nothing when nothing needs you.
       - All sessions always shows how many sessions there are, as in the layout above: the badge would only repeat Needs you's, just above it.
       - **Not needed now** (W88): a session marked [not needed now](#not-needed-now) is in none of the need-you badges, Needs you's, Starred's, the groups' and the Hidden section's, unless a PR it owns needs you (W106), and the groups still count it among their sessions.
       - **Through a PR** (W106): every need-you badge counts a session that needs you through an open PR it owns, and a PR row that needs you, each once. Pull requests' badge counts those alone, the rows with an open PR that need you through one, in solid warning as the others are; otherwise how many rows have an open PR.
       - Starred counts as a group does (W53): the badge while any starred session needs you, which says, as Needs you's can't, that one you're working on does; otherwise how many are starred; and nothing while none is, as Needs you shows nothing while nothing needs you. It counts each session once, and only those under the root.
       - Before the first snapshot, the three views show no count.
- **States:**
  - Hover: `--pw-surface-hover-bg` in the sidebar, which is on `--pw-bg`, and `--pw-surface-hover` in the drawer, which is a surface (2.3).
  - Selected: `--pw-selected` with `--pw-ring-selected`, and the label at 500 in `--pw-text`.
  - A group whose sessions have all finished: the label in `--pw-text-muted`.
- **Keyboard:** the list is one Tab stop (roving `tabindex`). ↓ and ↑ move between items, Home and End jump to the ends, and Enter selects. They keep to the views and the listed groups: the [Hidden section](#hidden-groups)'s controls are Tab stops of their own.
- **A focused item that leaves the list,** as a group does when it leaves the snapshot, hands focus to the item that took its place, or the one before it when it was last, never to the page.

### Hidden groups

The groups hidden from the [repo list](#repo-list) (W35), at its foot, after the groups and a divider, while any is hidden. It's absent while none is.

- **The disclosure:** a `<button aria-expanded aria-controls>`, "Hidden (*n*)", *n* being how many groups are hidden under the roots pitwall watches.
  - A repo list item's box: full width, at least 32 px tall, padding 6 px 8 px, `--pw-radius-md`; the Finished toggle's type: meta (s 13/20), 500, `--pw-text-muted`, tabular; the `expand` icon before the label, 6 px from it, rotating 90° when open. Hover: `--pw-surface-hover-bg` in the sidebar and `--pw-surface-hover` in the drawer, text `--pw-text`. Focus: `--pw-ring-focus`, which the list's 8 px padding has room for.
  - It carries the solid warning need-you badge at the right whenever any session in a hidden group needs you, open or closed, with the hidden noun ("2 need you"), so nothing that needs you is out of sight. It counts each session once, though in Every repo it worked in one may be in several hidden groups.
  - Collapsed by default. Its own Tab stop, outside the list's one; Enter or Space toggles it, and focus stays on it.
- **Opened,** it lists each hidden group, in the list's order: with two or more roots, the open [root tab](#root-tabs)'s alone, and its count and badge are theirs. Each entry is a row, 4 px between its two controls:
  1. A link, `<a href="?repo=…">`, that selects the group, so its sessions show in the session list as usual: a [repo list item](#repo-list-items), with its kind's icon, label, hidden kind and its count or need-you badge as the list shows them, but its label in `--pw-text-muted` (`--pw-text` and 500 while it's the selection, which it marks with `aria-current="page"` and the selected look). In the drawer, choosing it closes the drawer, as any item does.
  2. Unhide: a ghost sm `show` icon button, named "Unhide *group*" by its tooltip, so each one says which group it shows again. An icon, not a text button, because the sidebar is 240 px and a text label would leave the group's label a few characters.
  - Both are Tab stops; ↓ and ↑ don't reach them.
- **A hidden group that's in no snapshot,** such as one whose sessions have all gone, or a repo that sessions only worked in, in a [Group sessions by](#preferences) mode that lists no session under it (W39, W42), is still listed, until it's unhidden: its link shows "No sessions" (meta, `--pw-text-subtle`) under its label, in place of a count, so the label keeps the item's width. Selected, it has the "No sessions in *group* now" empty state, and the header offers Show in repo list.
- **Unhide** puts the group back in its place in the list, with a toast (see [Session list](#session-list) for both toasts). Focus goes to its item, which becomes the list's Tab stop. A group with no sessions has no item, so focus goes to the next entry's Unhide, or the one before, or, once none is left and the section has gone, the list's Tab stop.
- **Storage:** `localStorage`, one key per root, `pitwall.hidden.v1:<root>`, where `<root>` is the group's `SessionGroup.root`, as the snapshot gives it (Phil). Its value: `{"v":1,"open":false,"groups":[{"key":"/Users/example/code/old-repo","label":"old-repo","kind":"git"}]}`.
  - `groups` holds each hidden group's key, its absolute path, with its label and kind, so it can be listed while it's absent from the snapshot. Paths and labels only: no session's name, title or prompt. `open` is whether the section is open.
  - A pitwall watching several roots reads each root's key, and writes a group to its own root's. Opening or closing the section writes `open` to each root with something hidden, and hiding a group opens it; the section starts open when any root with something hidden says so.
  - Not pruned: unlike `pitwall.finished.v1`, an entry stays until it's unhidden, even while its group is absent.
  - When storage is missing or throws, nothing starts hidden, hiding still works for the page's life, and nothing throws. A value that isn't this shape, or another version, hides nothing.
  - Storage is per origin too, so a pitwall on a fallback port starts with nothing hidden; a fixed `--port` keeps the list.
- **Below 900 px** it's in the drawer with the rest of the list, and the drawer's Tab trap goes through its controls, skipping them while it's closed. Below 1,200 px the session view over the list makes it inert with the rest of the repo list where it reaches it, below 1,000 px (see [Session view](#session-view)).

### Starred sessions

Sessions you star (W53), from their rows or their views, listed together in the repo list's Starred view, so you can switch between the ones you're working on (Phil, 2026-10-22). "Starred", not "pinned": "pinned tab" already means a browser tab that keeps its token (D7). Starring is a viewer's preference, so it's kept in the browser, as hidden groups are, and the server knows nothing of it.

- **The star toggle:** `StarButton` (`web/src/components/StarButton.tsx`), a ghost [icon button](#icon-buttons) with `aria-pressed`, `false` or `true`: `star` (outlined) while it's off, `starred` (the same glyph filled, 2.14) while it's on, in the button's text colour, as any ghost icon button. The fill and `aria-pressed` say the state, never colour alone.
  - **Its name** is its tooltip, "Star *session*", the session's name as its row shows it, as text. The name stays the same in both states and the pressed state says which, so a screen reader hears "Star pitwall-test-app, toggle button, pressed" and voice control finds it by one name.
  - **On a row:** sm, at the end of line 1, after the time: see [Session rows](#session-rows).
  - **In the session view:** md, in line 1, before the actions menu: see [Session view](#session-view-header-tabs-and-footer).
  - **It never selects or opens a session.** The row's click opens the session only off its controls, and the selection and the URL stay as they are. It never closes or changes an open view either.
  - Starring needs no confirmation and no toast: one press undoes it, and the toggle shows the result where it was pressed.
- **The view:** [Starred](#repo-list), after Needs you and All sessions, `?view=starred` (with `&root=` when there are several roots), stored in `pitwall.view.v1` like any selection. It lists the starred sessions under the open [root tab](#root-tabs), sorted by the Sort setting, filtered by the filter, with `j` and `k` through them, as [Session list](#session-list) says, and its [empty state](#empty-states) when none is starred there.
  - **Finished sessions** follow the Finished section's rule: a starred finished session is in Starred's own Finished section, collapsed by default and remembered as `view:starred` in `pitwall.finished.v1`.
  - **Unstarring in Starred** takes the row out at once, as it's no longer starred; focus goes to the next row's star toggle, so Space can unstar it too (see [6.1](#61-rules), item 8). A session open in the view stays open, with its toggle off, and can be starred again there.
- **The key:** `s` stars or unstars the open session, while the single-key shortcuts are on ([6.2](#62-keyboard-map)), with a toast, "Starred *session*." or "Unstarred *session*.", since focus isn't on the toggle. It doesn't repeat as it's held. Nothing with no session open.
- **Storage:** `localStorage`, one key, `pitwall.starred.v1`, holding `{"v":1,"ids":["00000000-0000-4000-8000-000000000001"]}`: each starred session's id, oldest star first. Ids only: never a session's name, title or prompt.
  - **Shared across roots and tabs** on the origin: session ids are unique, and each root tab's Starred lists only the sessions under its root, so one key serves them all.
  - **Never pruned** because a session is missing from a snapshot: a failed poll can empty the list, and a star should outlast it. It stays until it's unstarred.
  - **At most 100 ids:** starring a 101st drops the oldest star. A hundred is five times the 20 sessions of Phil's try-out (W39), so the cap should only ever drop stars on sessions long gone, and at about 40 bytes an id the key stays near 4 KB.
  - **Other tabs:** a star made or cleared in another of pitwall's tabs arrives with the window's `storage` event, and the stars are read again; never written back, so two tabs can't echo a change.
  - **Read with validation:** a value that isn't version 1's shape stars nothing, an entry that isn't a string of 1 to 256 characters is skipped, and an id listed twice counts once. When storage is missing or throws, nothing starts starred, starring still works for the page's life, and nothing throws.
  - Storage is per origin too, so a pitwall on a fallback port starts with nothing starred; a fixed `--port` keeps the stars.
- **Known limit:** the star is keyed on `sessionId`, as drafts are. If Claude Code ever gave a running session a new id, its star wouldn't follow it.

### Not needed now

A session in Needs you that's really waiting on someone else can be marked not needed now (W88; Phil, 2026-10-28). Claude Code's `blocked` state, and a job's own line on what it needs, can mean waiting on another person or an event. Phil's case was a background session that had posted a request-changes review and was waiting for the author's fix before it re-ran a check and tore down what it had started; he read it as done. Until a triage tells the two apart (M6 in `PLAN.md`), this is the manual way, and it undoes itself.

- **What it leaves:** everything `needsAttention()` drives.
  - **Not what its PRs need** (W106): a mark is for what the session needs. While an open PR it owns needs attention, its row still needs you, through the PR: it stays in Needs you and its counts, with its bar, and line 2 says "Not needed now" then why the PR needs you, "#612 has merge conflicts", in `--pw-text`, not muted, since it still holds. The mark's toast says so: "Marked *session* not needed now. It stays in Needs you while #612 needs you." A row that needs you only through a PR has no toggle: there's nothing of the session's to mark.
  - Needs you, and the repo list's need-you badges: Needs you's, Starred's, each group's and the Hidden section's.
  - The session list's "*n* need you", the root tabs' badges and the document title's count.
  - The Urgency sort, where it ranks by its status, as a session that doesn't need you does.
  - It stays in All sessions, Starred and its groups, and their counts of sessions still count it.
- **When it comes back:** as soon as a snapshot says it needs something else: `needsYou`'s reason or text, `askedYou`'s excerpt, or `waitingFor`. It's back in Needs you by itself, with its solid badge and its bar, and nothing announces it, as nothing announces a session that comes to need you.
  - A mark is for what the session needed when it was made, never for the session itself. A new question, a new line from Claude Code, a prompt on screen or a new reason brings it back.
  - **Not `status` or `state`** (the review of #90). The index reads `status` only as `waiting`, which is the 'prompt' reason, and `waitingFor` says which prompt; a plugin's monitor keeps it at `busy` anyway (spikes 005 and 007). And a job waiting on someone else that checks again on a loop cycles blocked, working, blocked, twice in 4 minutes in the review's live sample, which would take its mark away each time. The 'blocked' reason needs `state: 'blocked'`, so a real change of state still shows as a new reason.
  - A change the page never sees, made and undone between two polls, doesn't.
- **The toggle:** `NotNeededButton` (`web/src/components/NotNeededButton.tsx`), a ghost sm [icon button](#icon-buttons) with `aria-pressed`, on the row of every session that needs you or is marked not needed now: in Needs you, All sessions, Starred and its groups. `not-needed` (snooze, outlined) while it's off, `not-needed-on` (the same glyph filled) while it's on, in the button's text colour, as the [star toggle](#starred-sessions) is.
  - **Its name** is its tooltip, "Mark *session* not needed now", the session's name as its row shows it, as text, the same in both states, so a screen reader hears "Mark pitwall-test-app not needed now, toggle button, pressed".
  - **Where:** at the end of line 2, under the star (see [Session rows](#session-rows)). Shown while it's on; otherwise on the row's hover and focus, and always on a touch screen.
  - **It never selects or opens the session,** and never closes or changes an open view, as the star doesn't.
- **A marked row** in All sessions, Starred and its groups: no bar; its status badge keeps its text, outlined, as a stale Blocked does, since solid is for needing you; line 2 says "Not needed now", quietly, before what it needs, which is muted; and its toggle is pressed. Pressing it again takes the mark away.
- **In Needs you,** a row marked not needed now leaves at once, as a row unstarred in Starred does. Focus goes to the Not needed now toggle of the row that took its place, so Space marks the next too, or the one before it when it was last, or the session list's heading when none is left, over "Nothing needs you right now".
- **The session view:** while the session is marked, line 2 has the outlined badge and "Not needed now" after it. Its actions menu has Mark not needed now (`not-needed`) while it needs you, and Put back in Needs you (`undo`) while it's marked, after the copies, with a separator, while it's listed (see [Session view](#session-view-header-tabs-and-footer)).
- **Toasts** (see [Toasts](#toasts)):
  - **A mark,** from a row or the menu, is a success toast with Undo: "Marked *session* not needed now. It comes back to Needs you when what it needs changes." The session has left Needs you, which may not be in sight, and the counts have changed.
  - **Undo** takes the mark away. It's a toast action, so it goes after `--pw-toast-action-timeout` (10 s), and it's never the only way: the row's toggle, in All sessions or its group, and the view's Put back in Needs you are the lasting ones. With focus in the toast, Undo puts it on the session's toggle, back in the list, or on the session list's heading when the list doesn't show it (the view's, while the view covers the list).
  - **Put back in Needs you,** from the menu, which has closed: "Put *session* back in Needs you." From the row's toggle there's no toast, since the toggle shows it where it was pressed, as the star does; the mark's toast goes then, with nothing left to undo.
  - Each toast is about its session, so a later one replaces an earlier one about the same session.
- **No shortcut** for now: it's on the row, and two presses from the view's header.
- **Storage:** `localStorage`, one key, `pitwall.not-needed.v1`, holding `{"v":1,"entries":[{"id":"00000000-0000-4000-8000-000000000001","hash":"a1b2c3d4e5f60718"}]}`: each marked session's id, and a hash of what it needed, oldest mark first.
  - **Never the text:** the hash is a 64-bit FNV-1a of those four fields, as 16 hex digits (`needHash()` in `web/src/notNeeded.ts`). It says whether what the session needs has changed, not what it was. No name, title, prompt or question is stored.
  - **Shared across roots and tabs** on the origin, as the stars are.
  - **An entry goes once a snapshot lists its session needing something else,** whether or not it still needs you: the mark has done its job. Never because a session is missing from a snapshot, as with stars.
  - **At most 200 entries:** marking a 201st drops the oldest mark. Marks go by themselves, so most are short-lived; at about 80 bytes an entry, the key stays near 16 KB.
  - **Other tabs:** a mark made or taken away in another of pitwall's tabs arrives with the window's `storage` event, and the marks are read again; never written back, so two tabs can't echo a change.
  - **Read with validation:** a value that isn't version 1's shape marks nothing, an entry that isn't an id of 1 to 256 characters and a 16-digit hash is skipped, and an id listed twice keeps its last mark. When storage is missing or throws, nothing starts marked, marking still works for the page's life, and nothing throws.
  - Storage is per origin too, so a pitwall on a fallback port starts with nothing marked.
- **Known limit:** the mark is keyed on `sessionId`, as stars and drafts are.

### Finished section

- **Toggle row:** at the bottom of the session list, a `<button aria-expanded aria-controls>` "Finished (*n*)", plus " · *n* asked you" when any did.
  - Padding 6 px 16 px, meta size, 500, `--pw-text-muted`, a top `--pw-border`, hover `--pw-surface-hover`, and the `expand` icon, rotating 90° when open.
  - Collapsed by default, and remembered for each selection in `localStorage` (`pitwall.finished.v1`).
- **Groups no longer collapse.** The repo list is the overview that collapsed groups used to give, so `pitwall.groups.v1` is no longer read or written.
- **What's in it:** the selection's finished background sessions and its [ended sessions](#ended-sessions), sorted together: by activity alone under Urgency, as the Sort setting says otherwise.
  - **Not one that owns an open PR** (W106; Phil, 2026-10-29: an open PR is work that isn't finished): it's listed with the rest, its badge still saying Ended, Done or Stopped, not muted, until the PR closes, and then it's here.
- **Show older** (W67), after the rows, while the selection has ended sessions older than `ENDED_SHOWN_DAYS` (7 days) that the filters would show: a row of its own, with a row's padding and its top `--pw-border`, holding an outline sm [button](#buttons), as Load earlier is, then a meta line in `--pw-text-subtle`, 8 px after it, that describes it (`aria-describedby`) and wraps under it when there's no room beside it.
  - **The button:** "Show *n* older sessions" ("Show 1 older session"), *n* being how many the selection has that the filters show; once they're shown, "Hide older sessions". It's the same button with its other name, so focus stays on it. The line: "Ended more than 7 days ago".
  - **One switch for the page** (coordinator, W67), not one for each section: on, the older ended sessions are listed in every selection, root tab and count; off, in none. It's off at each load, and isn't stored, so nothing about it reaches `localStorage` (D14).
  - **Shown,** they're listed among the section's rows, by the Sort setting, after the newer ones under Urgency and Recent, since they're older.
  - **Turning it on** opens the selection's Finished section, which remembers that as a press of its toggle would, so the sessions it lists are in sight.
  - **A section with only older ones,** in a selection that has other sessions, is there for Show older: "Finished (0)", with the button inside it.
  - **Inside the section,** so it's hidden while the section is collapsed, as the rows are, and `j` and `k` never reach it.
- **When the selection would be empty without them,** the [empty state](#empty-states) has Show older as an outline action: all of a root's sessions, a group's, Starred's or what the filter finds may be older ended ones. Its button goes with the empty state, so focus goes to the Finished section's button, Hide older now, or else to the session list's heading.

### Ended sessions

An interactive session whose Claude Code process has exited, as when its terminal closed or the Mac restarted (W67; Phil, 2026-10-27; spike 006). Claude Code stops listing it, so pitwall finds it from its transcript and lists it with `ended` set, `finished` too, kind interactive, and no process, status or state (`SessionSummary.ended`). It can be resumed, in the background or in a terminal.

- **Where:** in its group's [Finished section](#finished-section), muted, last, as a finished background session is, and so in All sessions' and Starred's Finished sections too. One that owns an open PR (W106) is listed with the rest instead, not muted, with Ended as its badge, and stays in the window however long ago it ended, until the PR closes; its view offers Resume in background as any ended session's does (D17). **Never in Needs you,** and never in a need-you count, even when its last message asked you something (`needsAttention()`): its row has the outlined Asked you then, with "It has ended, so it isn't counted as needing you." in its tooltip.
- **The row:** a [session row](#session-rows), the finished look, with the "Ended" [badge](#badges) where a finished session has Done, Stopped or Failed, and its last activity's time. Line 2 is what it was last asked, as any row's. The filter matches it as any other session, and the Interactive chip keeps it.
- **How far back:** the server lists those whose last activity is at most `ENDED_LISTED_DAYS` (30) old, at most `ENDED_LISTED_MAX` (100). The page shows those from the last `ENDED_SHOWN_DAYS` (7), measured from the snapshot's `generatedAt`, so what's hidden changes only with a snapshot. Older ones are left out of the snapshot's groups before anything groups or counts them: every list, every count, the repo list's items and badges, the root tabs' badges and the New session dialog's directories leave them out, and a group whose only sessions they are isn't in the repo list, until Show older is on (see [Finished section](#finished-section)).
  - **The session view** finds a session among all of them, so one that's hidden still shows in a view that's open when Show older is turned off, or that a URL names, without the no-longer-listed alert.
- **Stars:** one can be starred like any other. Resumed, it keeps its star, since its `sessionId` doesn't change.
- **Its view:** see [Session view: header, tabs and footer](#session-view-header-tabs-and-footer): the Conversation tab alone, Ended where the status goes, and in the footer Resume in background and Copy command, or Resume in background alone when its directory's path has a `'` or `\` (W87).

### Pull requests

Your open pull requests on github.com (M4, W95; Phil, 2026-10-16), and since W101 the open ones that ask your review, of you or of a team you're on, or that mention you (Phil, 2026-10-29). The server fetches them with `gh`, three searches, one call each, every 3 minutes and on Refresh, places each one under a root, and sends each list as a `'prs'` message (`PullRequestList` in `src/shared/protocol.ts`); the page keeps the latest (`connection.ts`). Read-only: pitwall changes nothing on GitHub.

**A row is a piece of work** (the M4 redesign, W106; Phil, 2026-10-29: "a session now becomes a little more than just a Claude session. It becomes an active piece of work"): a Claude session, an open PR, or both. W95's separate PR list, a heading per repo, didn't work in Phil's first try-out, and this replaces it. The UI keeps the word "sessions". What the page composes, from the snapshot and the list, is `web/src/work.ts`'s, pure and tested.

- **Which session owns a PR** (`prOwner()`, W104): of every session in the snapshot, finished and ended ones included, whatever the window or the root tab, the one that acted on it last: opened it, pushed its branch, or was linked to it by Claude Code; one given it in a prompt owns it only when no session acted on it; a mention never does. Another session acting later takes it over. The PR closing ends it.
- **A session's PRs are listed with it** (Phil: "the session leads"), wherever the session is listed under Group sessions by, never again under the PR's repo: its row's badge, its line 2 while a PR needs you, and its view's links and Pull requests tab.
- **A PR no session owns is a row of its own** ([PR rows](#pr-rows)), placed by the server (`PullRequestSummary.place`, W105):
  - **'cloned':** under the group whose root and key are the place's, as the repo list lists it; built, as a git repo with the place's label, when no session is listed there.
  - **'not-cloned':** under a group of its own, `owner/name` as GitHub spells it, under the root that claims the owner (`RootOwners`), listed only while it has PR rows, marked as not cloned (see [Repo list](#repo-list)).
  - **'unclaimed',** or no place, as from a server that doesn't place PRs: not listed, only counted, in the Pull requests view's hidden line.
  - **Older:** a PR row last updated more than `PRS_SHOWN_DAYS` (90) days before the list's `fetchedAt` is left out of every list and count, so a forgotten PR doesn't sit in Needs you. The Pull requests view's Show older lists them among its own rows, and nothing counts them. A PR a session owns is never left out: the session is the work.
- **Needs you** (Phil: "yes"): a session's row needs you when the session does or when a PR it owns needs attention (`prNeedsAttention()`: your own with failing checks, conflicts or changes requested, and those that ask your review); a PR row when its PR does. Both count wherever Needs you counts: Needs you itself, the repo list's badges, the session list's summary, the root tabs' badges and the page title. A mention never counts, and neither do another author's failing checks or conflicts, which are theirs to fix. [Not needed now](#not-needed-now) is for what the session needs, never its PRs.
- **Finished:** a finished or ended session that owns an open PR isn't finished work (Phil, 2026-10-29), so it's listed with the rest until the PR closes, its badge still saying Ended, Done or Stopped, and Finished holds only finished sessions with no open PR. Opening it opens the session view, which offers Resume in background for an ended one (D17).
- **Components:** `PrRow` (`PrRow.tsx`); the Pull requests view's `PrListFilters`, `PrNotices`, `PrListFoot`, `OlderPrs`, `HiddenPrs`, `PrRefreshButton`, `RefreshAction` and `prSourceBody()` (`PrList.tsx`), on `SessionList`, with `FilterChips` and `ClearFilters` (`Filters.tsx`); `PrView`, `UnlistedPrView` and `WaitingPrView` (`PrView.tsx`) and `PrDetails` (`PrDetails.tsx`); `PrStateBadges`, `SessionPrBadgeView` and `SessionPrLinks` (`PrBadges.tsx`); `SessionPrsPanel` (`SessionPrs.tsx`). Styled in `PullRequests.css` on the session list's, rows' and view's own rules.
- **Text:** titles, check names and branches are text, through `plainText()`, never markup, and titles and branches are in `<bdi>`, so a right-to-left title can't reorder what's around it. Repo labels are GitHub's spelling (`repoLabel`).
- **How each is yours** (W101, `PullRequestSummary.relation`): you opened it; your review is requested, of you by name or of a team you're on (`reviewRequest`, with the team's `org/slug` when it's the only one asked); or it mentions you, and it isn't yours and doesn't ask your review. A PR is one of the three, the first that holds in that order. Closed and merged ones are never fetched, so one leaves at the next fetch after it closes. A review asked of you leaves once you've reviewed it, as GitHub documents for a requested person; one asked of a team likely leaves once a member reviews on its behalf, which GitHub doesn't document. GitHub's search index lags a review, so pitwall also leaves out a PR whose own review requests no longer name you or a team.

**Linking sessions to PRs** (coordinator's call, 2026-10-28; `PrLinkKind`): the index finds each session's links without knowing which PRs are open (`SessionSummary.prLinks`), and the page matches them against the list (`prLinkMatches()`), so a link to a PR that isn't one of your open ones shows nothing.

- **Strong:** opened (the session created it), pushed (it pushed the PR's head branch, in the head's repo), linked (Claude Code's own `pr-link`, W104) and prompted (you gave it the PR's URL). Only these can make a session a PR's owner, and they list the PR in its view's Pull requests tab and the session in the PR view's Sessions.
- **Mentioned:** Claude named the PR's URL in a reply. Only the PR view lists these, apart, under Mentioned in. A session with a strong link isn't listed there too.
- **A weaker link, or a PR another session has taken over,** gives the session no badge: its view's Pull requests tab lists it under Also worked on, and the PR view under Sessions.
- Finished and [ended](#ended-sessions) sessions count, and show muted while they're finished work, as their rows are.

#### PR rows

`PrRow`, among the session rows, sorted with them ([Session list](#session-list)): a session row's box, padding, hover, open and focus states, and two lines (D12):

1. **Identity:** "#57" in `--pw-text-muted` 400, tabular, then the title, in `<bdi>`, m 14/20 500, together in an `<h3>` holding the button that opens it (`data-open-pr`, `aria-controls="pr-view"`, `aria-current` while it's open), with "#57 *title*" in a hover tooltip when it's cut; then its [state badges](#state-badges), Review requested or Mentioned first on a PR that isn't yours (W101); then when it was updated, "2h ago", in the time's fixed slot, as a session row has its last activity there, so the badges line up down the list; then the slot where a session row has its star, kept for W107's actions, New session and Clone and start. The title gives way first; then the badges, each with an ellipsis.
2. **Its group's label** in the views that list every group, as a session row's line 2 starts, " · ", then why it needs you while it does (`prReason()`, in `--pw-text`): "Your review is requested", "CI is failing", "It has merge conflicts", "Changes are requested"; or else how it's yours: "Yours", "Mentions you". Then, quiet in `--pw-text-subtle` and never cut, " · No session listed", true whether no session worked on it or the one that did is no longer listed, as an ended one isn't after 30 days, or " · Not cloned" for a repo with no clone under the root. What comes before the end gives way, with an ellipsis.

- **Needs you:** while its PR needs attention it has a session row's bar, and counts in Needs you; never one that only the Pull requests view's Show older lists.
- **Opening:** a click anywhere on the row that isn't a control, or its button, opens the PR view in the third column, as `?pr=`; ↑ and ↓ on its button, and `j` and `k`, step through the rows, sessions' and PRs' alike.
- **Not on a PR row:** a star, Not needed now, and its branch, which the filter matches and the PR view shows. Starred never lists one.

#### The session row's PR badge

`SessionPrBadgeView`, before the row's status badge: the most urgent open PR the session owns (needs attention first, then the newest updated), "#51", then "+2", 4 px apart, when it owns more (W106).

- **Just the number, in its state's colour:** subtle danger while that PR needs attention, subtle neutral otherwise. Its state, "CI failing", "conflicts", "changes requested" or "review requested", is in its hidden text and its tooltip, and line 2 says it while the PR needs you and the session doesn't itself: "CI is failing on #51". #109's review: with the state on line 1 too, "#57 CI f…" cut the name to "Fix a fla…" beside a status badge in a 440 px list, the default at 1,440 px.
- **Before the status badge,** not after it: the status badges sit against the time's fixed slot so they line up down the list, which the app check measures, and a badge after them would push them out of line on the rows that have one.
- A hover-only tooltip names each PR it owns, "example/demo-app #51: Add a made-up health route (checks failing)", one a line.
- Not a control of its own: the row's one button is still the name's, and the session view has each PR. Visually hidden text reads "Pull request #51, CI failing, needs attention, and 2 more".
- On every row that owns an open PR, finished and ended ones included, in every selection. A session only linked to one, or whose PR another session took over, has none.

#### State badges

`prStateBadges()`: how it's yours, on a PR you didn't open (W101), then highlighted, then quieter.

| State | Label | Style |
|---|---|---|
| Your review is requested | "Review requested", with a hover tooltip, "Your review is requested through example/reviewers.", for a team's | subtle warning, as Asked you is: it waits on you, and it needs attention |
| It mentions you | "Mentioned" | subtle neutral: it never needs attention |
| Checks failing | "Checks failing" | subtle danger |
| Merge conflicts | "Conflicts" | subtle danger |
| Changes requested | "Changes requested" | subtle warning |
| Draft | "Draft" | outline, as Not running: not yet in play |
| Approved | "Approved" | subtle success |
| Checks pending | "Checks pending" | subtle neutral |

- Passing checks, a clean merge, a review still required and a mergeability GitHub is still working out have no badge: healthy and unknown states stay quiet. The PR view says each.
- **On a PR that isn't yours,** failing checks, conflicts and changes requested keep their looks, since they say what state it's in, but they're its author's to fix, so they don't make it need attention: it sorts, counts and badges a row by its review request alone.

#### The repo list's item

See [Repo list](#repo-list):

- "Pull requests", the fourth view, under Starred, once the server has sent a list, and never while pull requests are off (`--no-prs`). A pitwall from before M4 sends none, so it has no item.
- **With pull requests off and Pull requests selected,** as `pitwall.view.v1` can have it from an earlier run, All sessions in the same root tab takes its place, replacing the history entry, since there's no item to show selected. A `?pr=` stays, and its view says pull requests are off.
- **The badge** (W106): how many of the root tab's rows with an open PR need you through one, a session through a PR it owns and a PR row through its PR, in solid warning with "need you" as visually hidden text, as Starred's badge counts the starred sessions that need you: they're all in Needs you. Otherwise how many rows have an open PR, in meta text; nothing before the first fetch, or with none. Until W106 it counted PRs in subtle danger, since PRs didn't count in Needs you.
- With root tabs it's in every tab's list, and counts that tab's rows. Its selection names the tab, as the other views do (`?view=prs&root=…`).

#### The Pull requests view

`?view=prs`: the [session list](#session-list), `main.session-list.pr-list`, showing every row with an open PR across the root tab's groups, the sessions that own one and the PR rows, each once, under its group as the other views list it, with no Finished section, since a session that owns an open PR is never finished work (Phil, 2026-10-29: "The Pull requests item stays for now"). It's always in Urgency's order, as W95's list was, so it has no Sort.

- **Header,** the session list's:
  - Line 1: the `<h2>` "Pull requests", then the summary: "10 sessions", or "2 of 10 sessions" while a filter hides some, then the solid "4 need you" badge or " · Nothing needs you", as every view has them.
  - Line 2: the [filter field](#search), the line's whole width: label "Filter pull requests", placeholder "Filter by session, title, repo or number", with its `/` key cap and Clear text. It matches a session as the session list's field does, and by the PRs it owns, and a PR row by its group's label, its title, its repo, its number as "#57" and its head branch, case-insensitively, on the trimmed text.
  - Line 3 (W101): the [filter chips](#filter-chips) "Yours", "Review requested" and "Mentioned", in place of the session list's, in a group named "Filters", which combine as OR: none on is All, one narrows the rows to the PRs of its kind, and all three show every row. A PR row passes by its PR's relation, a session's by any PR it owns. The chips apply before the text, and the summary says "2 of 10 sessions" while they hide some. They're the page's, none on at each load, never stored, as the text is. The three take 320 px, so they share a line from a 375 px window up and wrap below.
  - Line 4: "Updated 2m ago", a [timestamp](#timestamps) of the list's `fetchedAt`, meta in `--pw-text-subtle`, at the left, and at the right Clear filters, while the text or a chip is on, then Refresh, so neither moves as the time ticks.
    - **Clear filters** is the session list's ghost sm `clear-filters` icon button, named by its tooltip: it clears the text and the chips and puts focus in the field. It's here rather than after the chips: the chips and its 24 px take 352 px, which a 360 px list (a 1,200 px window) or a 375 px window doesn't have, so its room kept after them would be a line with nothing on it. Here it needs no room. With no fetch that worked yet: "Fetching from GitHub…" while one runs, as before the first, and "Not fetched yet" once one has failed, as when `gh` is missing or not logged in, where the empty state below says why.
  - With pull requests off there's no line 4; with no list yet, or no row with an open PR, no summary, field or chips.
- **Notices over the rows:** a fetch that failed after one worked, and a search that failed while the others worked (W101), as inline alerts (States, below).
- **Rows:** session rows and [PR rows](#pr-rows), in Urgency's order: those that need you first, whatever the reason, a PR's included, then busy sessions, then by activity, a PR row by when it was updated.
- **The foot,** after the rows, each a row of its own with a top `--pw-border`:
  - **Show older** (`OlderPrs`): the PR rows last updated more than `PRS_SHOWN_DAYS` (90) days before the list's `fetchedAt`, which no session owns, are left out of every list and count: an outline sm button, "Show 2 older pull requests", then "Updated more than 90 days ago" in meta, which describes it. On, they're rows of this view alone (`olderPrRows()`), under their groups' labels, in the summary's count of sessions but in no need-you count, with no bar, and nowhere else: not in Needs you, the repo list, another view or the page title (#109's review, since it can only be turned off from here). It's "Hide older pull requests" then, the same button, which keeps focus. One switch for the page, off at each load, never stored.
  - **The hidden line** (`HiddenPrs`, W106): "2 pull requests are hidden: no root claims other-org or third-org.", meta in `--pw-text-muted`, the owners each once, the first three and "and 2 more", then a link, "How to show them", to the README's Configuration section (`CONFIGURATION_URL`, `https://github.com/leggetter/pitwall#configuration`, which W103 writes), in a new tab with `rel="noopener noreferrer"`. Only while some are hidden.
  - **GitHub found more than `PRS_MAX` (200) for one of its searches:** a quiet line, "GitHub found more than 200 pull requests for one of its searches, so the 200 of them updated most recently are listed." (`truncated`). Each search keeps its own 200, so a list holds at most 600 (`PRS_LIST_MAX`).
- **Live updates:** a fetch, or a snapshot, updates the rows in place, and the order holds while the pointer is over the list or focus is inside it, as the session list's does.
- **Storage:** W95's collapsed repo headings, `pitwall.pr-repos.v1`, went with its headings. The page no longer reads or writes the key; one left in a browser from before is harmless.

**States** of the Pull requests view's body (`prListState()`, `prSourceBody()`):

| State | What shows |
|---|---|
| Before the first fetch, or no list yet | Three skeleton rows after `--pw-delay-spinner`, a hidden "Loading pull requests" status, and after `--pw-delay-long` "Still waiting for `gh`…". Refresh is busy |
| Off (`--no-prs`), for the moment before All sessions takes its place, and in the gallery | Empty state: `info`, "Pull requests are off", "pitwall was started with `--no-prs`, so it doesn't run `gh`. Start it without `--no-prs` to list your open pull requests here.", outline "Show all sessions" |
| gh missing, no list | Empty state: `warning`, "gh isn't installed", "pitwall lists them with GitHub's CLI, `gh`, which isn't on its `PATH`. Install it from cli.github.com, run `gh auth login`, then Refresh.", outline "Refresh" |
| gh not logged in, no list | Empty state: `warning`, "gh isn't logged in to GitHub", "pitwall lists them with `gh`. Run `gh auth login` in a terminal, then Refresh.", outline "Refresh" |
| Any other failure, no list | Empty state: `error`, "Couldn't list your pull requests", the server's words as `Detail`, then "Refresh to try again.", outline "Refresh" |
| A failure after a list | The last list, under a warning inline alert, `role="status"`: "Couldn't refresh your pull requests", what failed, then "This list is from 2h ago.", the time a timestamp. Warning, not danger: what's shown is kept ([Errors](#errors)) |
| A search failed while another worked (W101's review) | The list, each failed search's PRs its last good ones, under a warning inline alert, `role="status"`: "Couldn't refresh part of your pull requests", then a line for each failed search, "The pull requests that ask your review are from 2h ago.", or "… aren't listed." for one that has never worked, then what failed, as `Detail` (`PullRequestList.searches`, `SEARCH_NAMES`). Each search is its own call, so one that fails or is slow, past GitHub's 10 s, leaves the others |
| No row with an open PR | Empty state: `success`, "No open pull requests", "Pull requests you open, that ask your review or that mention you on github.com show here, with the sessions that worked on them.", then the foot's Show older and hidden line, when there are any |
| One chip on, and its search has never worked (W101's review) | Empty state: `warning`, "Couldn't list the pull requests that mention you", what failed as `Detail`, then "Refresh to try again.", outline "Clear filters" and "Refresh" |
| One chip on, and none of its kind (W101) | Empty state: `success`, and outline "Clear filters", which clears the chips and the text and puts focus in the field. Yours: "No open pull requests of yours", "Pull requests you open on github.com show here, with the sessions that worked on them." Review requested: "No reviews requested", "Open pull requests that ask your review, or a team's you're on, show here. One asked of you leaves once you've reviewed it." Mentioned: "No mentions", "Open pull requests that mention you show here, when they aren't yours and don't ask your review." |
| The filter matches nothing | Empty state: `search`, "No sessions match", "Nothing in Pull requests matches "*text*".", or with a chip on, "… "*text*" with these filters.", or with two or three chips on and no text, "Nothing in Pull requests matches these filters."; outline "Clear filter", or "Clear filters" with a chip on, which puts focus in the field |

**Refresh** (`PrRefreshButton`, `prRefresh.ts`): a ghost sm `retry` [icon button](#icon-buttons), "Refresh pull requests", at the right of the header's last line, and an outline "Refresh" in the failure states' empty states.

- It POSTs `PRS_REFRESH_PATH` with the apiKey, as every state-changing request is sent. The list arrives as `'prs'` messages, refreshing then fetched.
- **Busy** while the request is out or the list says `refreshing`, a poll's fetch included: the [spinner](#skeletons-and-spinners) in the icon's place, `aria-busy`, `aria-disabled`, and "Fetching your pull requests from GitHub…" as its tooltip, which describes it.
- **Off for a minute after a refresh** (`PRS_REFRESH_MIN_MS`, the server's own limit; 15 s until W100, Phil, 2026-10-29: "Every 15 seconds seems a bit excessive"): `aria-disabled`, with "pitwall fetches your pull requests at most once a minute, so Refresh is off for a moment." as its describing tooltip. Its name stays "Refresh pull requests".
- **A 429** (a fetch, a poll's or another tab's, started less than a minute ago): an info [toast](#toasts), "pitwall checked GitHub moments ago. Refresh again in 42 seconds.", from its `Retry-After`, and off until then. Nothing failed, so it isn't an error. It says checked, not fetched: that fetch may have failed, as when `gh` isn't logged in.
- **A 409** (pull requests off): an info toast, "Pull requests are off: pitwall was started with --no-prs, so it doesn't run gh."
- **Anything else:** an error toast, "Couldn't refresh your pull requests (HTTP 502). Try again in a moment.", and Refresh is on again at once.

**The PR view** (`PrView`, `?pr=<owner>/<name>/<number>`), in the [session view](#session-view)'s frame, place and layout: the third column from 1,200 px, over the list below it, `id="pr-view"`.

- **One thing at a time:** the third column shows a session or a PR. Opening a PR takes the place of the open session, and opening a session the place of the open PR, each in one pushed history entry (`?session=` and `?pr=` never both; with both in a typed URL, the session shows). Neither changes the selection, as opening a session never has: a PR's view opens over any list, from a PR row or a session's link, and a session's view from the PR's Sessions. Back and forward go between them.
- **Header,** the session view's:
  - Line 1: the title, l 16/24 600, in `<bdi>`, wrapping, where a session's name gives way: it's what the view is about, and at 375 px Back leaves it a few words. Then Open on GitHub, a ghost md `external` icon link, Copy link, a ghost md [copy button](#copy), and Close. At ≤ 600 px "Back to pull requests" in Close's place, or "Back to sessions" over the session list. The heading takes focus when the view opens from a row or a link.
  - **Open on GitHub** is an `<a>` to the PR's own page, `target="_blank"` and `rel="noopener noreferrer"`, and only for `https://github.com/<owner>/<name>/pull/<n>` with its own repo and number (`githubPrUrl()`): the server keeps only such PRs and the page checks again. Without one, there's neither it nor Copy link.
  - Line 2: "example/demo-app #51", meta in `--pw-text-muted` 500, then its state badges.
  - Line 3, for a PR you didn't open (W101, `prRelationText()`): how it's yours, m 14/20 in `--pw-text`: "Your review is requested.", "Your review is requested through example/reviewers." for the one team asked, "Your review is requested through a team you're on." when pitwall can't say which, or "You're mentioned in it.". None for one of yours.
  - Once a list fetched since doesn't have it, as for a merged or closed PR, a neutral alert: "It's no longer among your open pull requests, so it may have been merged or closed. This is what it showed last." Not while the first fetch after a restart runs, whose list has no PRs yet. With pull requests off since, "Pull requests are off: pitwall was started with --no-prs, so it doesn't run gh. This is what it showed last."; with the latest fetch failed and no list, "pitwall couldn't list your pull requests just now, so this is what it showed last." (`PrMissing`).
- **Body:** Details, then Sessions, then Mentioned in, each an `<h3>` (m 14/20 600) over its part, 24 px apart.
  - **Details** (`PrDetails`, which the session view's Pull requests tab shows too), a `<dl>`, the term in a 6em column in meta `--pw-text-subtle`, the value in m `--pw-text`, wrapping:
    - Checks: "Failing" in `--pw-danger-fg` 500, then each failing check's name in `<bdi>`, a list named "Failing checks", then "+3 more" from `failingCount`; or "Passing", "Pending", "No checks".
    - Review: "Approved", "Changes requested", "Review required", or "No review required" when GitHub reports no decision.
    - Merge: "No conflicts", "Conflicts with its base branch" in the danger text, or "Checking for conflicts: GitHub works it out after a push, so the next fetch usually knows." for `unknown`.
    - Draft: "Draft" or "Ready for review".
    - Branch: its head branch, in mono, and ", from *owner/fork*" for a PR from a fork.
    - Opened and Updated: timestamps, the absolute time in their tooltips.
  - **Sessions:** the strongly linked sessions, the one that owns it first (W106), then running ones, then finished ones, muted, each by its newest link. Each line: the session's name, in `<bdi>`, a link button that opens its view; its [status badge](#badges), outlined while marked [not needed now](#not-needed-now); "Active 5m ago"; and why it's linked: "Opened it", "Pushed its branch", "Linked by Claude Code", "Given it in a prompt", then " · Its session" on the owner's. With none, "No session has opened it, pushed its branch or been given its link in a prompt, as far as pitwall can tell."
  - **Mentioned in:** the same for sessions Claude named it in, "Named it in a reply". Only when there are any.
- **Waiting:** a `?pr=` before the first list: the view with Close, skeletons after `--pw-delay-spinner`, a hidden "Loading the pull request" status, and "Still waiting for `gh`…" after `--pw-delay-long`.
- **Unlisted:** a `?pr=` that isn't in the list: an [empty state](#empty-states), `info`, "This pull request isn't listed" as the view's heading, and "`example/demo-app #999` isn't among your open pull requests on github.com. It may have been merged or closed, or opened by someone else."; with pull requests off, or no list, it says that instead.
- **Keys:** as the session view's: Escape closes it, ↑ and ↓ in its header show the previous or next row in the list, a session's or a PR's, and `j` and `k` too ([6.2](#62-keyboard-map)). Closed, focus goes back to its row, or the list's heading.
- **Opened from** a PR row, a session's header link or its Pull requests tab, or `?pr=`.

**The session view's PR links** (`SessionPrLinks`): a line of the header under where it worked, while the session owns an open PR (W106): "Pull requests" in meta `--pw-text-subtle`, then each one it owns, most urgent first, as "#51", a [link button](#buttons) named "Pull request example/demo-app #51" with the title in its describing tooltip, then its highlighted state badges. It wraps; nothing is cut. Each opens its PR view in the session view's place.

**The session view's Pull requests tab** (`SessionPrsPanel`, W106), after [Sub-agents](#sub-agents), once the session owns an open PR or is strongly linked to one, as "Pull requests (3)", every PR it lists; it stays once shown, as Sub-agents does (see [Session view: header, tabs and footer](#session-view-header-tabs-and-footer)). Its panel, the session view's body, a Tab stop that scrolls:

- **"Its pull requests":** each open PR it owns, most urgent first, as the PR view says it: "#612" and its title, a link button that opens its PR view in the session view's place, with Open on GitHub, a ghost sm `external` icon link, at the right; its repo and number and state badges; how it's yours, when you didn't open it; then [`PrDetails`](#pull-requests): the checks with the failing ones named, the review, whether it merges, draft, its branch, and when it was opened and updated.
- **"Also worked on":** the open PRs it's strongly linked to that another session owns, after "It worked on these too, but another session acted on each one, so each is listed with that session.", each the same, with "Listed with *session*." under its badges.
- **None open,** as once its last PR closes: an empty state, "No open pull requests", "The pull requests this session worked on have closed, or aren't among yours on github.com any more."
- **The footer stays** on this tab, unlike on Sub-agents: the message box is the session's, and a PR's state is often what you'd write to it about.

### Session view: header, tabs and footer

**Header** (sticky, `--pw-surface`, a bottom `--pw-border`, padding 12 px 16 px):

1. **Line 1:**
   - The name (l 16/24, 600), then " · " and the title (l 16/24, 400, `--pw-text-muted`), on one line: the title gives way first, then the name, each with an ellipsis, and the full title is in a tooltip when it's cut. The " · " is drawn with the title (`::before`, not read out), so it goes when the title has; screen readers get it from visually hidden text.
   - At the right: the [star toggle](#starred-sessions) (md, ghost, W53), then the `more` icon button (md, ghost) opening the actions menu, then the `close` icon button ("Close", Escape in its tooltip). At ≤ 600 px, "Back to sessions" at the start replaces Close.
     - The star is a button of its own, not an item in the actions menu, so whether the session is starred shows at a glance and one press changes it, as on its row. Its tooltip has `s`'s key cap, and it says `aria-keyshortcuts="s"`, while the single-key shortcuts are on.
   - The heading is the region's label (`aria-labelledby`) and takes focus when the view is opened from a row (`tabindex="-1"`, no visible ring on the heading itself).
   - A copy's result is a [toast](#toasts): "Copied", or "Couldn't copy; the text is selected" as an error toast. When the copied text isn't on screen (the session ID, the attach command), a refusal also shows it, selected, below line 2, "Session ID: *id*" in code style, until the next copy.
2. **Line 2, 8 px gaps, wrapping:**
   - The status badge. While the session is marked [not needed now](#not-needed-now), it's outlined, with "Not needed now" after it, meta in `--pw-text-subtle`, as the row has it (W88).
   - Then the row's other badges: "Asked you" (outline) for a finished session that asked, and "Stale" (subtle neutral), each followed by an info button (`InfoTip`) whose name and tooltip are its explanation, the row's hover-only hint.
   - The kind as meta text in `--pw-text-subtle` ("Interactive" or "Background"). An interactive session adds an info button (`InfoTip`), so Tab reaches it: its name and its tooltip are "Typing /bg in its terminal moves it to the background, so pitwall can attach to it and stop it." An [ended](#ended-sessions) one has none: it has no terminal to type /bg in (W67).
   - "Active 5m ago" (meta, `--pw-text-subtle`, a [timestamp](#timestamps), the absolute time in its tooltip).
   - The cwd (path type, `--pw-text-subtle`, middle ellipsis, the full path, home and all, in a tooltip) with a [copy button](#copy), "Copy path". It takes the rest of the line, or a line of its own below 16em.
   - When the directory no longer exists (`cwdMissing`): "Directory no longer exists" (meta, `--pw-text-muted`), its own item so it wraps rather than squeezing the path, with "The working directory no longer exists, for example after a worktree was removed." in a tooltip.
   - **Under line 2, where to answer while it waits on you** (W47): a line of its own while a running session has the solid Waiting or Blocked badge: a prompt on screen, or a background job whose own line says what it needs, or that's blocked with a job file pitwall couldn't read (`needsYou`, W69). Not for Waiting for your prompt, which has nothing to answer, nor for a blocked job that needs nothing of you, which shows Idle. The status badge already says it's waiting and on what, `waitingFor` as Claude Code gives it, as text, so the line says only where (`waitingNote()`). A question dialog open in a terminal seems not to be in the transcript until it's answered (seen on one session, not yet confirmed), so the badge and this line may be all pitwall can show of it. The same look and reading as the line below, and above it when both apply.
     - **Interactive:** "Answer it in its terminal: pitwall can't, and a message sent below waits until you do."
     - **Background:** "Answer it in its Terminal tab, which attaches to it." No button opens the tab from here, as for the footer's note: selecting the tab is what attaches (D9). None where the Terminal tab is off.
     - **No line** once it's no longer listed, or isn't running.
   - **Under line 2, what to do about a directory that has gone** (W47): a line of its own, visible rather than in a tooltip, saying why the session is still listed and what ends it or takes it off the list, by kind and state (`cwdMissingNote()`). Meta text in `--pw-text-muted`, with `/exit` as inline code (2.7). It's a plain `<p>`: no live region, no id, and nothing is named or described by it, so a screen reader reads it once, in place, after "Directory no longer exists". Line 2 itself is as it was.
     - **Interactive, and running:** "It's still running in its terminal, so it's listed. End session, in the actions menu, ends it, as `/exit` there does." End session ends it though its directory has gone, since its process is still running (W90).
     - **Background, and running** (it has a process, whatever its state, stale and idle ones included): "It's still running, so it's listed. Stop session, in the actions menu, ends it."
     - **Background, and not running:** finished (done, stopped or failed), its process gone before it finished, or its state unknown: "It isn't running. Remove session, in the actions menu, takes it off the list."
     - **No line** for an interactive session that isn't running, which neither pitwall nor a terminal can act on (Claude Code has only been seen listing interactive sessions with a process, spike 001), or for a session that's no longer listed, whose menu has no Stop or Remove and whose alert (item 4) says why.
3. **Where it worked** (W34, W39), once its scan finds repos beyond where it started: "Started in *start* · worked in *repo*, *repo*", meta in `--pw-text-subtle`, the labels in `--pw-text-muted` 500, newest touch first. *start* is the group it started in, from the snapshot, whichever group [Group sessions by](#preferences) lists it under, as the repo list labels it (the root's own directory as its path). The line is the same in every mode. Each *repo* is a repo the session worked in, by its label (`WorkedIn.label`), whether or not it has a group: a repo that sessions only worked in has none, and is named all the same. A repo that is itself a root shows the root's path, as the repo list does. It wraps; nothing in it is cut. The " · " is drawn, and screen readers hear ", and" instead. Then an info button (`InfoTip`) whose name and tooltip are the rule and where to look: "A repo counts when the session changed it, or when at least 5% of its tool calls touched it, its sub-agents' included. Group sessions by, in Preferences, sets which of these repos list the session; to find every session that worked in a repo, type its name in the filter on All sessions." A session that worked in no other repo, or hasn't been scanned yet, has no line 3.
   - The names are text, never markup and never links: selecting one does nothing, beyond selecting its text. A repo here may have no group to go to, and the [filter](#search) is what finds the sessions that worked in one.
4. **Its pull requests** (W95, W106), while it owns any open one: "Pull requests", then each, "#51", a link button that opens its PR view, with its highlighted states. Those it's linked to and doesn't own are in the Pull requests tab. See [Pull requests](#pull-requests).
5. **When the session has left the snapshot:** an inline neutral alert, `role="status"`: "This session is no longer listed, so this is what it showed last."

**Actions menu** (`more`, "Session actions", a [menu](#menus)): Copy session ID (`copy`), Copy attach command (`terminal`); then, while the session needs you and is listed, a separator and Mark not needed now (`not-needed`), or Put back in Needs you (`undo`) once it's marked (W88, see [Not needed now](#not-needed-now)); then, with an editor found, a separator and Open in VS Code and Open in Cursor (`external`); then, in three columns, a separator and Make view wider, Make view narrower and Reset view width (no icons; see the [divider](#session-view)); then a separator, then Stop session (`stop`) and Remove session (`remove`, in danger text) for a background session, or End session (`stop`) for a running interactive one (W90).

- **Copy session ID** copies the full session id. **Copy attach command** copies `claude attach <shortId>`, and is there only for a background session whose short id passes `attachCommand()`'s shell-safety check.
- **Open in VS Code and Open in Cursor** (W72; Phil, 2026-10-23, option A) open the session's own directory in that editor. A browser can't tell what's installed, or start an app, so pitwall's server does both (`src/server/editors.ts`): it looks for each editor once, as it starts, and the page GETs `EDITORS_PATH` once, after it has authenticated (`web/src/editors.ts`).
  - **One item per editor found,** in the server's order, VS Code then Cursor, after the copies and a separator. With none found, or the list not had, neither shows, and there's no separator for them: the menu is as it was. The labels are the server's: "Open in VS Code", "Open in Cursor".
  - **Only while it can work:** for any kind of session, interactive, background or [ended](#ended-sessions), since an ended one's directory may still be there; not while its directory has gone (`cwdMissing`), and not once it's no longer listed, since the server opens only a listed session's directory.
  - **Choosing one** POSTs `openInEditorPath(sessionId)` with `{ editor }` alone, with the apiKey, as Stop and Remove send theirs. The page never sends a path: the server opens that session's `cwd` from the snapshot, as the realpath it has just checked is under a root. The menu closes, and focus goes back to its button. While the request is out, both items are `aria-disabled`, with "Wait for the editor to open." in their tooltip, so a second press sends nothing.
  - **The result is a [toast](#toasts),** from the app's stack, so it arrives when the view has gone meanwhile too. Opened: a success toast, "Opened *name*'s directory in Cursor." Not opened: an error toast, "Couldn't open *name*'s directory in Cursor. *the server's reason*", its reason as text, such as "Cursor didn't open. If it has moved, restart pitwall so it looks again.", when the app has moved since pitwall looked, or "Its directory, *path*, no longer exists.", or, with none, "Couldn't open *name*'s directory in Cursor (HTTP 502)."
  - **At most 10 opens a minute** (W87), of any session in either editor, as well as the 4 commands at once it shares with stop, remove and resume: past it, a 429, and the error toast has the server's reason, "pitwall opens at most 10 directories in an editor every 60 seconds. Try again in 42s.", or, with none, its `Retry-After`, as a refused resume has it: "Couldn't open *name*'s directory in Cursor (HTTP 429). Try again in 2 seconds." The items are on again once the answer is in.
  - **No shortcut** for now: it's a menu item, two presses from the view's header.
- **Stop session and Remove session** are for background sessions that are still listed. Each opens its [inline confirmation](#inline-confirmation). Stop is `aria-disabled` while the session isn't running, and both are while one of them is in progress, with the reason in a tooltip.
- **An ended session's menu** (W67): Copy session ID; Copy resume command (`terminal`), the footer's Copy command, named here beside Copy session ID as Copy attach command is; the editors found (W72); the width items in three columns; then a separator and Resume in background (`restart`), the footer's own, `aria-disabled` while a resume is out ("Wait for the current action to finish.") or waiting to be listed ("It has resumed. It shows as a background session once pitwall lists it."). No Stop session and no Remove session: there's no process to stop, and `claude rm` is for background sessions. One whose directory has gone has Copy session ID and the width items alone, and once it's no longer listed, Resume goes, as Stop does, and so do the editors. One whose directory's path has a `'` or `\` has no Copy resume command, as the footer has no Copy command (W87).
- **An interactive session's menu** (W90, replacing W40's Stop session that was always off): Copy session ID, the editors found (W72), the width items in three columns, then a separator and End session (`stop`), in Stop session's icon and place, so the menu reads the same for both kinds. Not in danger text: like Stop, it ends a process whose conversation is kept. It's `aria-disabled` while the session isn't running ("It isn't running, so there's nothing to end.") and while another action is out ("Wait for the current action to finish."). It opens End's [inline confirmation](#inline-confirmation). There's no Remove session, which is `claude rm`'s, for background sessions only. Once the session has ended, End session goes and Resume in background takes its place ([ended sessions](#ended-sessions)); once it's no longer listed, End session goes too.
  - **What End session does** (spike 005, D22): pitwall's server sends the session's Claude Code process SIGTERM, never SIGKILL, so its terminal goes back to the shell. It ends only an idle session, by its transcript: one that's working gets the stronger warning first. The page never sends a pid; the server takes it from a fresh `claude agents` and checks it's still that process just before the signal.
  - **Afterwards** the session leaves `claude agents` at once, and the next snapshot lists it as [ended](#ended-sessions), with Ended where its status goes and Resume in background in its footer.

**Tabs** (a row under the header, sticky, padding 0 16 px, a bottom `--pw-border`, 40 px tall):

- **Tab:** 28 px tall, padding 4 px 8 px, m 14/20, 500, a 16 px icon before the label.
  - Inactive: `--pw-text-muted`; hover fill `--pw-surface-hover`, `--pw-radius-lg`.
  - Active: `--pw-text`, with a 2 px `--pw-text` underline on the row's bottom edge, over the border.
- **"Conversation"** (`conversation`), **"Terminal"** (`terminal`), once the session is known to have sub-agents, **"Sub-agents (*n*)"** (`subagents`, W77; see [Sub-agents](#sub-agents)), and once it owns an open PR or is strongly linked to one, **"Pull requests (*n*)"** (`repo`, W106; see [Pull requests](#pull-requests)), last.
  - **Pull requests** stays once it shows, as Sub-agents does, so the tab row never loses a tab under you: a PR that closes leaves its panel saying none is open, and its count goes. The footer stays on it: the message box is the session's. With four tabs the row is wider: at 375 px, where the three fit without their icons, the fourth can need the row's sideways scroll, W77's last resort.
  - An interactive session's Terminal tab is `aria-disabled`, with a tooltip that describes the tab (`aria-describedby`), so it's in the DOM before it shows: "An interactive session can't be attached here. Type /bg in its terminal to move it to the background, then attach to it here." So is a background session's when the app can't attach, or once it's no longer listed. Activating a disabled tab does nothing.
  - While attached, the Terminal tab shows an 8 px `--pw-success-fg` dot after its label, and a visually hidden ", attached".
  - **An [ended session](#ended-sessions) has the Conversation tab alone** (W67): there's no process to attach to, so no Terminal tab, rather than one that's off. Its tablist is still there, one tab in it, so the tab row doesn't move when it's resumed and Terminal joins it. One with sub-agents has Sub-agents after Conversation.
  - **Sub-agents is last,** after Terminal, for every kind of session, finished and ended ones included, but only once the session is known to have at least one, so most views keep two tabs. Once it shows, it stays for the view's life: the tab row never loses a tab under you. Its count is how many the list has, with "+" when the oldest were left out ("Sub-agents (200+)"), and none until the list arrives.
- **ARIA and keys:** the [Tabs](#tabs) pattern, with `aria-label="Session view"`. Opening is manual, never on focus, because opening Terminal attaches. ← and → reach Sub-agents too, when it's there.
- **Switching** from Terminal to Conversation, or to Sub-agents, detaches, as Detach does. Opening Terminal attaches; for a session that isn't running it first shows the restart confirmation, which the server asks for when the socket opens (D9).
  - Detach, Back to the conversation and the restart's Cancel go back to Conversation, with focus on the Terminal tab. F6 in the terminal moves focus to the Terminal tab too, but leaves the terminal open and attached.
  - Back on Conversation, the conversation is where it was left: at the bottom if it was there, with what arrived meanwhile; otherwise at the same place, with what arrived counted on the "Jump to latest" bar. Its panel is `hidden` behind the Terminal tab, which leaves it no size and lets the browser drop its scroll position, so nothing counts as the reader moving while it's hidden, and it's put back before it's painted.
- **The tab it opens on** (W54; Phil, 2026-10-22: a background session "defaults to the conversation view when I select the session even though I can't do anything in it"; 2026-10-23, the coordinator's recommendation). A background session takes input only in its terminal (D3), so:
  - **A running background session** (`kind` background, `alive`) opens on its Terminal tab, which attaches: from a click or Enter on its row, a `?session=`, the back button or a reload. That's [Preferences](#preferences)' Open running background sessions on, Terminal by default. Its conversation loads behind the Conversation tab, as it does behind an open Terminal tab, and the footer's note is there once you choose Conversation.
  - **Everything else opens on Conversation:** an interactive session, an [ended](#ended-sessions) one included; a background session that isn't running, finished or with its process gone, since attaching restarts it, which the Terminal tab asks first, so it waits for you to open the tab; a session whose Terminal tab is off, once it's no longer listed or where pitwall can't attach; and every session while Preferences says Conversation.
  - **Resumed from its view** (W67): an ended session resumed with Resume in background is listed again, within a poll or so, under the same id, as a running background session. Its view, still open, then opens its Terminal tab once, as the view of a running background session opens (Terminal, unless Preferences says Conversation), and attaches. That's so whichever comes first, the server's answer or the snapshot that lists it as running: the press counts from when it's made until the resume fails or the button stops waiting, and opening the tab uses it up, so a root tab opened again later (W38) never opens it a second time. Its terminal takes no focus (W57): the press asked to resume, not to type, and the attach comes seconds after it. Resume in background goes with the footer, so focus it had goes to the Terminal tab, and the terminal's bar says how to type to the session.
  - **Decided once,** as the view is first shown (`SessionView.tsx`). A view kept hidden for a root tab that isn't open (W38), such as one for a session started there, decides when that tab is opened, so nothing attaches unseen. After that the tab you choose is yours: the view never switches it for you, whether the session stops or starts running or starts waiting on you, or Preferences changes. A new choice there is for the views that open after it.
  - **Stepping onto one** with `j`, `k`, ↑ or ↓ opens its view on the Terminal tab, with "Attaching…" in the terminal's bar, but the terminal waits `--pw-delay-attach` (500 ms, 2.13) from when the view opened before it attaches, so a session only passed through is never attached. Moving on, choosing Conversation or closing the view during the wait ends it, with nothing attached; the next view's wait starts afresh. A click or Enter on a row isn't a step, and attaches at once.
  - **Focus: the terminal takes the keyboard only when you ask for it** (W57; W48's second pass, H1; the coordinator's decision, 2026-10-23). Why: before W57 the terminal took focus as it attached whenever focus was nowhere, which is the state after a load. So after a reload onto a session waiting on a permission prompt, the next Enter approved the dialog's highlighted option, `/`, a name and Enter sent a slash command, and `j` and `k` typed into its prompt, with nothing done in the page.
    - **Asked for:** right after a click or Enter in this page on the session's row, on the Terminal tab, on Attach again, or on Restart and attach. Focus goes where that puts it, the heading from a row, the tab itself (which takes it, as Safari doesn't give a clicked button focus), then into the terminal as it attaches. The gesture is the attach's that follows it, spent once, and lasts 5 s (`GESTURE_MS` in `focusGesture.ts`), long enough for the terminal to wait for its font and attach, short enough that a slow attach can't take focus long after.
    - **Only while focus is still in the view,** on what was pressed, or nowhere because that has gone, as Attach again goes once the attach starts. If focus has gone outside the view meanwhile, into the filter say, it stays there, so what's typed there never reaches the session.
    - **Never by itself:** a view opened from the URL, a reload, a tab the browser restores, back or forward, a root tab's switch, a session started from New session (which opens once it's listed, seconds later), or a step with `j`, `k`, ↑ or ↓ attaches as above, but its terminal leaves focus where it is. A step leaves it on the row or the heading, so the next `j`, `k`, ↑ or ↓ is still a step. The terminal's bar then says "Click the terminal, or Tab to it, to type to the session" ([Terminal](#terminal)), and a click on the screen, or Tab to it, focuses it as always.
    - **A setting** (Phil, 2026-10-23: "make that a config option in preferences"), in `localStorage` as `pitwall.terminal-focus.v1` (`terminalFocus.ts`): `after-open`, the default, is the rule above; `never` means the terminal never takes the keyboard by itself, so you click it or Tab to it, and the bar's hint says so. There's no "always", which is what W48's second pass found unsafe. A value it doesn't know, or storage that throws, reads as `after-open`. The view reads it each time a terminal attaches. Its control is The terminal takes the keyboard, in [Preferences](#preferences)' Session view section (W59).
    - Escape and F6 in the terminal are as before.
  - **The limit** (D9): each attach counts toward the four, as before. In a root tab only the open view's terminal is attached, since opening the next session detaches the last, and views kept for other root tabs keep theirs. A fifth is as it was: on its Terminal tab, the terminal's danger notice "4 sessions are already attached; detach one first.", with Attach again and Back to the conversation.

**Body:** scrolls; padding 12 px 16 px 24 px; `overscroll-behavior: contain`. It holds the [conversation](#conversation) or the [terminal](#terminal), each in its `role="tabpanel"`. The conversation's panel is a Tab stop (`tabindex="0"`, `--pw-ring-focus-inset`), so it can be scrolled from the keyboard.

**Footer** (sticky, `--pw-surface-muted`, a top `--pw-border`, padding 12 px 16 px, 8 px 16 px on short windows):

- At most half the view's height; past that, it scrolls inside itself.
- **Not on the Sub-agents tab** (W77): there's no message box for a sub-agent, and the session's own would read as one under a sub-agent's transcript. The footer stays in the page, `hidden`, so a draft, a send in flight and Escape's and `j`/`k`'s rules about a draft carry on, and it's back as it was on Conversation.
- Interactive sessions: the [message box](#message-box).
- A session that can't be messaged: a meta note, "It isn't running, so it can't be messaged."
- **Background sessions** (W47; D2, D3): where an interactive session has its message box, a meta note (`--pw-text-muted`, s 13/20, a plain `<p>`) saying that it takes messages in its terminal.
  - Running: "To message it, type in its Terminal tab, which attaches to it."
  - Not running, finished or not: "To message it, open its Terminal tab, which asks before restarting it." (A session that's still starting, in its first 20 seconds with no process, gets "still starting" from the tab instead.)
  - **No button** opens the Terminal tab from the note: selecting the tab is what attaches, and attaching restarts a session that isn't running, after asking (D9), so the tab stays the one deliberate way in.
  - Only on the Conversation tab: on the Terminal tab, which it's about, the terminal has the room. So a running one, which opens on its Terminal tab (W54), shows it once you choose Conversation, or when Preferences says Conversation. Not where the Terminal tab is off: once the session is no longer listed, or where pitwall can't attach.
- **[Ended sessions](#ended-sessions)** (W67; `EndedSession.tsx`): where an interactive session has its message box, the meta note "It ended when its Claude Code process exited. Resume it here in the background, or copy the command that resumes it in a terminal.", then a refused resume's alert, then, 8 px apart at the right, wrapping, outline md Copy command (`copy`) and primary md Resume in background (`restart`): secondary then primary, as a dialog's footer has them, and the footer's one primary.
  - **Copy command** copies `cd '<cwd>' && claude --resume <sessionId>`, with the directory always in single quotes, so it pastes as one command into Warp, Cursor's terminal, zsh, bash or fish (`resumeCommand()`). It's a [copy](#copy) like the actions menu's: "Copied", or, refused, the command under line 2, selected, as "Resume command: …". There's none, by the [commands to copy](#copy) rule, for a directory whose path has a `'` or `\` (W87), a control character (C0, DEL or C1) or a bidi control (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), which could make what's shown, when the clipboard refuses, read differently from what's copied, or for an id that isn't letters, digits, `_` and `-`.
  - **No command to copy** (W87): the note is then "It ended when its Claude Code process exited. Resume it here in the background; its directory's path has a ' or \, which shells don't all read the same way, so there's no command to copy.", its `'` and `\` in code style, and Resume in background stands alone at the right. It covers the trust command too, which such a path has none of either. The server lists no ended session with a control or bidi character in its directory, or an id that isn't a UUID, so the path's `'` or `\` is the only reason one has none.
  - **Resume in background** POSTs `resumePath(sessionId)` with the apiKey and no prompt, as Stop and Remove send theirs, and Claude Code resumes it with `claude --resume <id> --bg` in its own directory (spike 006). While the request is out the button is busy and `aria-disabled`, "Resuming…", and `j`, `k`, ↑ and ↓ wait for it, as for Stop and Remove. Resumed, a [toast](#toasts) says "Resumed *name* in the background.", and the button stays busy until the snapshot lists the session as running, or for 15 s (three default polls), after which it's Resume in background again. Once the snapshot lists it as running, before the server's answer or after, the view opens its Terminal tab, as above; a listing after those 15 s doesn't, as the press no longer counts.
  - **Focus in the footer as it goes,** as when the snapshot lists the session as running while Resume in background has focus, or the session leaves the list, goes to the Terminal tab, or the view's heading where there's none, never to the page.
  - **Refused,** an inline [alert](#alerts-and-banners), `role="alert"`, above the buttons, which keep focus: danger "Couldn't resume the session." then the server's or Claude Code's reason in code style, whatever the status: 404, 409 (such as "It's running again, in a terminal or in the background, so pitwall didn't resume it: that would start a copy."), 422 (Claude Code's "Workspace not trusted. …" line), 429, 502 and 504 alike. pitwall's own sentence stands alone when there's no reason: "Couldn't resume the session (HTTP 502).", "Couldn't resume the session (HTTP 429). Try again in 2 seconds." by its `Retry-After`, or "Couldn't resume the session." with no answer at all. With a command to run (`hint`), as New session's trust failure has it: "pitwall never trusts a directory for you. Run this in a terminal, accept Claude Code's trust prompt, then resume it again:" and the command in a [command chip](#copy), its copy button named "Copy trust command", since the footer's Copy command is the resume command's. For a directory whose path has a `'` or `\` the server sends no command (W87), so the alert has Claude Code's line alone, with no chip: the footer's note already says why there's none.
  - **A copy instead** (`copyShortId`; spike 006, finding 5): the session was open in another Claude Code process after all, so Claude Code started a copy under a new id. A warning alert, titled "Claude Code started a copy instead", whose body is the server's message alone, as text: it's pitwall's own sentence, and already names the copy and what to do about it ("It was open in another Claude Code process after all, so Claude Code started a copy as *short id* instead. The copy is listed as a background session with no name, which you can stop and remove."). A sentence of the footer's own before it would say the same thing twice.
    - **And a toast,** an error one, which stays until it's dismissed: "Couldn't resume *name*. *the server's message*", as when the view has gone. The copy keeps running whatever the footer does, and the next snapshot most likely lists the original as running in its terminal, since the server polls soon before it answers, which takes the footer and its warning away; the snapshot may even come first. The toast is what announces it, so the footer's warning has no role, and a screen reader hears it once.
  - **The view gone meanwhile:** the result still arrives, as a toast naming the session, as Stop and Remove's do: "Resumed *name* in the background.", or an error toast, "Couldn't resume *name*. *reason*", the copy's included, or "Couldn't resume *name* (HTTP 502).".
  - **Its directory gone** (`cwdMissing`): the note alone, "It ended when its Claude Code process exited, and its directory no longer exists, so it can't be resumed.", with nothing to press. Claude Code finds a session's transcript by the directory it runs in.
  - **A draft the tab kept** (W44) keeps its message box above the note, with the note that says it can't be sent, until it's cleared, as for any session that stops running.
  - Once it's no longer listed: no footer, as below.
- Sessions that are no longer listed: no footer. The header's alert says why.
- **A draft is never lost to the session going** (W31): when the session stops running, or leaves the list, while the message box has a draft, the box stays, with the draft in it, still editable, so it can be copied. A meta note above it says why it can't be sent, linked to the textarea: "It isn't running any more, so this can't be sent. Your text stays here until you clear it." or "It's no longer listed, so this can't be sent. …", and Send is `aria-disabled`, its tooltip saying the same. Escape and the shortcuts still keep it (6.2). Cleared, the note or no footer takes its place, as above. A draft the tab kept (W44, [message box](#message-box)) keeps the footer the same way, in a view opened again after its session left the list.

### Message box

The composer in the session view's footer, for interactive sessions. Messages go through pitwall's relay.

- **Region:** a `<section>` named by a visually hidden heading "Message this session".
- **Order, top to bottom:**
  1. **The latest exchange:** "Message from pitwall · 5m ago: *status*" (meta, `--pw-text-muted`; the status in `--pw-warning-fg` while waiting, `--pw-danger-fg` if it failed, with no band behind it). Below it, the reply (body, after "Reply:" in `--pw-text-muted`, 500, so it isn't read as the message pitwall sent), at most three lines (two on short windows), scrolling past that. While it scrolls, it's a Tab stop, a region named "Reply", as the page alerts are (`ScrollBox`).
     - **Show the reply once:** when the conversation already shows it, the footer shows only the status line, which then says so: "Message from pitwall · 5m ago: *status*. It replied, and the reply is in the conversation." The added sentence is in the line's own `--pw-text-muted`, after the status and its tone (`relay.ts`, `replyInConversation()`). Only the reply pitwall's relay received counts (`RelayExchange.reply`), and the conversation shows it when:
       - the entries on screen include a message to pitwall's relay (`to-pitwall`, see [Conversation](#conversation)) timed at or after the send whose text is the reply's, whitespace collapsed, or starts with it when the relay cut its copy at 2 KiB, so the conversation shows at least as much as the footer would. An entry the server cut shorter than that, past its page's budget, doesn't count, and the footer keeps its copy (W48's G1). The text is what says it's the reply pitwall received: the address alone doesn't, since any local session can take the relay's name (W48). One with no time doesn't count, since it isn't known to be since the send; or,
       - as before W46, one of Claude's entries since the send has the reply's text, whitespace collapsed: the whole entry, or, for a reply of 40 characters or more, part of one.
     - **Until then,** the reply shows here as it did: before the conversation's first page arrives, when its message to pitwall is something else, and when the session replied in a way its conversation doesn't show as a message to pitwall. It's still the relay's copy, `RelayExchange.reply`, plain text, at most 2 KiB.
     - **Why** (Phil, 2026-10-22, W46): a reply in the footer was three lines of plain text in a corner, cut at 2 KiB partway through, while the conversation showed only a folded `SendMessage` call beside the session's own "so I sent it both flows". In the conversation it's whole, as markdown, where and when the session wrote it.
     - **Later, if the try-out asks for it:** a link or button on the status line that scrolls the conversation to the reply. Not built.
  2. **The result of the last send,** as an inline alert. The text is the relay's status sentence, then the server's detail in code style. `role="status"` for delivered, `role="alert"` otherwise.

     | Result | Tone | Text |
     |---|---|---|
     | Delivered | success | "Delivered. It's in the session's inbox: …" |
     | Held for approval | warning | "Held for approval in that session's own terminal. …" |
     | May have arrived (the relay's `uncertain`) | warning | "May have reached the session. Check its conversation before sending again." |
     | Refused | danger | "Refused: that session's settings don't accept messages from other sessions." |
     | Not sent (the relay's `failed`) | danger | "Not sent." |
     | pitwall didn't answer, or answered with a server error (5xx) or a success with no result | warning | "pitwall didn't answer, so it may have reached the session. Check its conversation before sending again.", or "pitwall answered with an error (HTTP 502), so …" |
     | pitwall refused the request (any other status), before the relay ran | danger | "Not sent: pitwall refused the request (HTTP 403)." |

     - **Only what pitwall knows** (5: Errors): with no answer, or a server error, the message may have gone, so it's the uncertain wording and tone rather than danger, which would invite a resend, and each resend is another turn on that session's model.
     - **Delivered on one more try** (W52): when pitwall's gate stopped the relay's first copy because its text alone differed, and pitwall's second try went through, Delivered has the server's detail too, in code style, as the other results do: "pitwall's gate stopped the relay's first copy of your message, because it didn't match, so pitwall tried once more, on a new relay, and the second copy went through. The first time, …", then where that copy first differed, by line and character code. Still success and `role="status"`. So a retry is never silent, though it raises no page alert (below).
     - **A send pitwall never heard the end of, after a reload** (W44): when the page reloaded, or the view closed, while a send was out, the draft comes back with a warning inline alert in this place: "pitwall started sending this *5m ago*, but the page reloaded or the view closed before it had an answer, so it may have reached the session. Check its conversation before sending again." After an uncertain answer (the relay's `uncertain`, or pitwall's own no answer, server error or unexplained success) and then a reload: "pitwall tried to send this *5m ago* and couldn't tell whether it reached the session. Check its conversation before sending again."
       - The time is when the send went out, a [timestamp](#timestamps).
       - No role, since it was there when the box appeared ([Alerts and banners](#alerts-and-banners)). It's linked to the textarea with `aria-describedby`, first, so it's heard before a resend.
       - It goes once the draft is edited or sent. Send is as it is for any draft: there's no resend action, and nothing sends by itself.
  3. **The text row:** the textarea (auto-growing, one to eight lines), then the primary md "Send" button (`send` icon), aligned to the textarea's bottom.
  4. **The help line** (meta, `--pw-text-subtle`), linked to the textarea with `aria-describedby`:
     - Left: "⌘ ↵ to send" as key caps (Ctrl on other platforms), then an info button (`InfoTip`) whose name and tooltip are the limits note ("Starts a turn on that session's model. The session sees it as a message from another session, not from you, so it can't approve prompts.").
     - Right: the character count of what will be sent, shown only from 80 % of the limit ("6,554 / 8,192"), in `--pw-danger-fg` with "*n* characters over the *limit* limit" ("1 character over the 8,192 limit") once over it, when it's also linked to the textarea.
- **Behaviour:**
  - ⌘/Ctrl + Enter sends; Enter adds a line. Send is `aria-disabled` while empty, over the limit or sending.
  - Its tooltip, which describes it, says why it's off: "Type a message to send it.", "Shorten it by *n* characters to send it: the limit is 8,192.", or "Messages can't be sent from here." While it's sending, its busy label says so instead.
  - While sending: the busy state ("Sending…"), and the textarea is read-only.
  - After a send, focus stays in the textarea, or comes back to it from Send, unless it was moved somewhere else while the message was out. The draft clears when the message was delivered, held or refused; it stays when it wasn't sent or may not have been.
  - **A draft survives a reload in this tab** (W44, `web/src/drafts.ts`). Each conversation has its own, kept in the tab's `sessionStorage` under `pitwall.draft.v1:<sessionId>`. The box starts with it after a reload, or when its session is opened again later in the tab, and one session's draft never shows in another's box.
    - **Written as it's typed,** in the same event, so a reload straight after a keystroke keeps it. Removed when the box empties, and by the rule above: delivered, held or refused. Kept when it wasn't sent or may not have been.
    - **The value:** `{"v":1,"text":"…"}`. A send adds `"send":{"at":"<ISO time>","state":"out"}` as it goes, until its answer; an answer that couldn't tell leaves `"state":"uncertain"`. Either one brings the warning above.
    - **`sessionStorage`, not `localStorage`** (Phil, 2026-10-22): a draft lasts as long as the tab, as the token does, through reloads and pitwall restarts. It isn't on disk once the tab has gone, and two tabs never overwrite each other's. It's never pruned for a session missing from a snapshot, since a failed poll can empty the list.
    - **It's session content:** the text goes nowhere but that key. Never a log, a URL, or any request but Send's.
    - **Storage that fails** (blocked, a private window, over its quota): the box works from memory, as before, with no notice. Without `sessionStorage` the token doesn't survive a reload either (D7), so the page already says more than a notice would. A write that fails removes what was stored, so a reload never brings back an older copy than the one on screen.
  - Escape with a draft does nothing, wherever focus is in the view, so a draft is never lost to the shortcut that closes the view. A kept draft counts from the moment the box appears, for Escape and every shortcut that waits for a draft (6.2).
  - A draft stays when its session stops running or leaves the list, with a note saying why it can't be sent (see the footer, above). A kept draft comes back with that note when it happened meanwhile.
  - Rows have no Message button: the message box is always at the foot of an interactive session's view.

### Conversation

- **Component:** `Conversation.tsx` (`web/src/components/`): `useConversation()`, which loads, merges and follows the pages, and `ConversationPanel`, the Conversation tab's panel, which is the session view's scrolling body (`.session-view-body`, `role="tabpanel"`). The pages are merged and the rows built in `web/src/conversation.ts`.
- **List:** an `<ol>`, oldest at the top, 12 px between entries. It opens scrolled to the newest entry.
- **Speaker line** on each text entry (yours, Claude's, Claude's to pitwall's relay, another session's, and a question Claude asked in its dialog): label style (xs 12/20, 500, `--pw-text-muted`): "You", "Claude", "To pitwall-relay", "From *name*" (the sender's name as written, as text; "From another session" when there's none), or "Claude asked", then " · 11:06" in `--pw-text-subtle`, 2 px above the text. The time is a [timestamp](#timestamps) with `format="time"`: always visible, not only on hover, with the full date and time in its tooltip. An entry with no time, or one that isn't a time, has the name alone. Notices and tool calls have no speaker line.

| Entry | Look |
|---|---|
| Your message | `--pw-surface-sunken` fill, `--pw-radius-md`, padding 8 px 12 px, body text |
| Claude | No fill, body text |
| From another session | `--pw-surface-sunken` fill, `--pw-radius-md`, `inset 3px 0 0 var(--pw-info-fg)`, padding 8 px 12 px, body text |
| To pitwall-relay | `--pw-surface-sunken` fill, `--pw-radius-md`, `inset -3px 0 0 var(--pw-info-fg)` (the end edge), padding 8 px 12 px, body text |
| Claude asked | No fill of its own; its options as boxes, the chosen ones in the selected look (below) |
| Tool calls | Folded (below) |
| Notice | Meta (s 13/20), `--pw-text-muted` |
| Cut short | A trailing "Cut short." in meta, `--pw-text-subtle`, after the text of an entry whose `truncated` is set |

- **Text:** body, `overflow-wrap: anywhere`, never HTML. Your messages and notices are plain text, `white-space: pre-wrap`, so a prompt shows as typed, its indents and blank lines kept and its markdown not read. Claude's messages, its messages to pitwall and other sessions' are markdown, which the server flags (`markdown`), shown as pitwall's own elements (see [Markdown in messages](#markdown-in-messages)). The speaker line wraps anywhere too, for a long sender name.
- **Messages to pitwall** (W46, Phil, 2026-10-22): a message the session sent pitwall's relay with `SendMessage`, usually its reply to a message from pitwall, is shown in full, as the markdown the session wrote, in the call's place and at its time, as its own entry, "To pitwall-relay". It's never folded with the tool calls around it, and ends their run.
  - **Which calls:** the server decides (`src/index/conversation.ts`, `to-pitwall` entries in `protocol.ts`). A call is to pitwall when its `to` is the relay's name exactly (`RELAY_NAME`, trimmed), or a `uds:` socket address that a message from the relay's name came from earlier in the same transcript, on any page. Every other call stays a tool call: one to a sub-agent, to another session's name or socket, one whose result was an error or said `success: false`, and one with no message.
  - **A call with no result is shown as sent** (W48's G2): one being sent, but also one that was interrupted, or whose result is on a newer page past the 64 results a page's cursor carries. It shows as "To pitwall-relay", in full, though it may never have reached anyone. That's kept, since a call almost always gets its result within a second, and one whose result later says it failed turns back into a tool call.
  - **Any message, not only replies:** a session can write to the relay unprompted, and that shows the same way (coordinator's call, W46).
  - **The name, not a claim** (W48): any local session can take the name `pitwall-relay`, and a reply to its socket matches the same rule. So the speaker line names whom the call addressed, "To pitwall-relay", as a message from another session names its sender, and never says pitwall received it. The web UI's name for the relay (`web/src/relayName.ts`) is checked against the server's by a test. The message box goes further: it hides the relay's copy of a reply only for a message whose text is that reply (see [Message box](#message-box)).
  - **The look:** as distinct from Claude's text as a message from another session, with the same fill and the same inset, on the other edge: a message from another session has it on its start edge, where it came in, and one to pitwall on its end edge, where it went out. Both say who in their speaker line, so the edge is never the only sign (6.1). In forced colours, where the inset goes, the speaker line still says it.
- **Sub-agents named by their description** (W77): an entry about one of the session's sub-agents (`ConversationEntry.subagent`, set by the index) names it by its description, plain text, rather than its id.
  - **Its report,** a message from it: "From sub-agent: *description*" on the speaker line, in place of "From *agent id*". The look is a message from another session's.
  - **The call that started it,** an Agent call: its tool line reads "Agent: *description*"; **a message to it,** a SendMessage call: "SendMessage to *description*". Both stay tool calls, folded with the calls around them.
  - **The description is a link** that opens its transcript in the [Sub-agents tab](#sub-agents): a link-styled button (`.link-button`, `--pw-link`, underlined), in the line's own type, whose name is the description and whose tooltip, which describes it, is "Open its transcript in the Sub-agents tab". On a tool line, which clips what's drawn past it, its focus ring is inset, and the line has no tooltip of its own, cut or not, so only the link's opens. It goes to the tab and that transcript, with focus on its heading; Back there returns to the list, with focus on its row.
  - **In a sub-agent's own transcript** the same holds for the sub-agents it started, and its 'user' entries are what started or messaged it, never your prompt: "From the session", or "From sub-agent: *description*" for one another sub-agent started, a link to that one, or "From the session or a sub-agent" when the list doesn't say (the contract's `subagentConversationPath()`).
- **Questions asked in a dialog** (W49, Phil, 2026-10-22): a question Claude Code asked in its dialog in the terminal (its `AskUserQuestion` tool) shows, once answered, as its questions, their options and the answers, in the call's place and at its time, as its own entry, "Claude asked". It's never folded with the tool calls around it, and ends their run.
  - **Only once answered:** Claude Code writes the call to the transcript only once the dialog is answered (seen on one session, 2026-10-22), so a dialog that's still open has no entry. The note under the session view's header says where to answer it (W47).
  - **Which calls:** the server decides (`src/index/conversation.ts`, `question` entries and `AskedQuestion` in `protocol.ts`). A call whose input has a list of questions, each a question with a list of options with labels, is a question entry; any other input stays a tool call. The answers come from the result's structured record (`toolUseResult`), found by each question's text, and never from the result's prose. When the call and its result fall on two pages, the newer page's cursor carries where the result's line is, and the older page reads that one line again.
  - **Each question,** in order, 4 px between its parts: its header, if it has one, in label style (xs 12/20, 500, `--pw-text-muted`); the question in body text at 500; "You could choose more than one." in meta (s 13/20, `--pw-text-muted`) for a multi-select; then its options, a list named by the question (`aria-labelledby`). With two or more questions, they're a list too, 12 px apart; one question isn't a list of one.
  - **Each option** is a box: padding 6 px 8 px, `--pw-radius-md`, a decorative 1 px `--pw-border` inset, 4 px apart. A 16 px place for the check comes first, 8 px from the text, so every label lines up; then the label in body text, and its description under it in meta, `--pw-text-muted`.
  - **Your answer:** an option the answer names by its label is chosen: the selected look (`--pw-selected` with `--pw-ring-selected`, as the open row and the selected repo item have it), the label at 500, the `checked` icon in its place, and "Your answer" after the label, 8 px from it, in label style, `--pw-info-tint-fg` (6.56:1 and 7.89:1 on `--pw-selected`, the pressed chip's pair). The words say it, so the look is never the only sign (6.1), and a screen reader reads "*label*, Your answer", the comma visually hidden. A multi-select answer chooses each option it names, when it's nothing but labels joined by a comma, a newline or a semicolon: how Claude Code joins them isn't known, so nothing else is guessed at. An answer that holds a label two or more options share, alone or in a multi-select answer, chooses nothing, since it can't say which of them was chosen (W58).
  - **Typed in place of an option:** an answer that names no option, or names a label two or more options share, is shown as it was typed, after the options, in a box like your message's (`--pw-surface-sunken`, `--pw-radius-md`, padding 8 px 12 px): "Your answer" in label style, then the answer in body text, `white-space: pre-wrap`.
  - **Notes** typed with an answer follow in the same box, "Your notes".
  - **Not answered:** a dialog whose result was an error, as a dismissed one's is, marks nothing and says "Not answered." once, after its questions, in meta, `--pw-text-muted`.
  - **Answers not in the transcript:** a dialog with none of its answers there, or with no result yet, says "No answer in the transcript." once after its questions ("No answers…" for several); one with some, under each question without one. That's all pitwall knows.
  - **Plain text everywhere:** questions, headers, labels, descriptions, answers and notes are text, never markdown or HTML, and wrap anywhere, as written. "Cut short." follows an entry the server cut to the contract's limits.
  - **In forced colours,** where the fill and the ring go, a chosen option has a 2 px `Highlight` border instead, and "Your answer" still says it.
- **Folded tool calls:**
  - Consecutive tool calls fold into one row: an `expand` toggle button "*n* tool calls" (code style, `--pw-text-muted`, `--pw-text` on hover with the `--pw-surface-hover` fill, `--pw-radius-sm`, 24 px tall), plus a subtle danger "*n* error(s)" badge inside it when any failed. Its chevron turns 90° when open. It sits 6 px into the gutter, so the chevron lines up with the text around it.
  - It's a real `<button>` with `aria-expanded`, and `aria-controls` naming the `<ol>` of its calls, which is always in the DOM and `hidden` while closed. With errors, its name is "*n* tool calls, *n* error(s)" (`aria-label`), which starts with its visible label.
  - Expanded, each call is one line of code text (mono s 13/20, `--pw-text-muted`) with an ellipsis and its own subtle danger "error" badge, lined up with the toggle's label, 4 px apart. The full text is in a [tooltip](#tooltips) when it's cut (`onlyIfCut`); the lines aren't focusable, so it opens on hover, and the whole line is in the DOM for screen readers and find in page.
  - A single tool call isn't folded: it's one such line, with no toggle.
  - Every fold starts closed, and stays open or closed across refreshes and "Load earlier" while it has a call it had: a newer call joining the newest fold leaves it open, and so do older calls joining a fold at its start. The calls are known by `entryKey()`, so a call that gets its result is the same call.
- **Loading earlier:** an outline sm "Load earlier" button centred at the top, 12 px above the list ("Loading earlier…" with its spinner while busy, and repeat clicks ignored). The scroll position holds when older entries arrive: what the reader was looking at stays where it was. If it fails, its alert takes the button's place (below).
- **Following new entries:**
  - At the bottom (within 24 px), new entries keep it at the bottom.
  - Behind the Terminal tab, entries keep arriving and following works the same; the place is kept for when Conversation opens again (see [Session view](#session-view-header-tabs-and-footer)).
  - Scrolled up, the place is kept, and a "Jump to latest" bar appears, sticky at the bottom of the body, 8 px from the footer (or the view's foot, when there's no footer): `--pw-info-tint`, `--pw-info-tint-fg` text, `inset 0 0 0 1px var(--pw-info-border)` (`--pw-info-fg` on hover), the `latest` icon 6 px before "*n* new · Jump to latest" (m 14/20, 500), centred, full width, at least 32 px tall, `--pw-radius-md`, `--pw-z-sticky`. It's a button.
    - *n* counts the entries that arrived while scrolled up; a message that grew, or a tool call that got its result, isn't new.
    - The sticky box has no height, so the bar covers the entries behind it rather than taking room, and nothing moves when it goes.
    - It goes when the reader reaches the bottom by any means: the bar, scrolling, the keyboard, or a fold closing above. If it had focus, focus moves to the conversation's panel first, so the keyboard carries on from there.
  - **More than a page at once:** a refresh whose newest page shares no entry with what's shown, because more arrived than a page holds, replaces what's shown only when the reader is at the bottom, and follows it. Scrolled up, what's shown and the place both stay, and the newest page waits behind the bar, counted as at least what it holds: "*n*+ new · Jump to latest", announced as "*n*+ new". Later refreshes join it. The bar, or reaching the end of what's shown, puts it in place of what's shown, at the bottom, and Load earlier goes on from there; what lay between is behind Load earlier.
  - The bar scrolls to the bottom smoothly; the positions it passes through don't count as the reader scrolling up, until it reaches the bottom, or 1.5 s have passed, whichever is first; the reader's own wheel, touch, press or key ends that at once. Under reduced motion, jumping to latest doesn't animate.
  - **Announced** politely by a visually hidden `role="status"` in the panel, which is always there: "*n* new", once for each batch that adds to the count, never once per entry and never the entries' text. Nothing is announced while the reader is at the bottom, where the entries come into view as they arrive, or when the count clears.
- **The working line** (W102; Phil, 2026-10-29: "In the conversation view, I can't see any feedback to suggest the agent is working"). At the end of the Conversation tab, after the newest entry and 12 px below it, before a refresh's alert, while the session works or waits on you: `WorkingLine.tsx`, from `web/src/working.ts`. Not in a sub-agent's transcript.
  - **When:** while the status badge is Busy or Working, unless the newest page says its turn has ended (`ConversationPage.turnEnded`, from Claude Code's `turn_duration` mark, spike 007, finding 4), since a plugin's monitor can keep Claude Code's status at busy with no turn running (finding 6). A turn runs again from any of Claude's lines, a thinking block's alone included, a tool's result, a prompt, or a message or task notification that arrives, which Claude Code starts a turn for, so a turn a task notification began shows the line before Claude's first visible line, a median 4 s later (W102's review). Or while it waits on you: the solid Waiting or Blocked badge, from the snapshot's status and Needs you reasons (W69). It goes as the turn ends, and never shows for a session that isn't running, has [ended](#ended-sessions), or is no longer listed. Only once the first page is in.
  - **Its look:** a 16 px column for what shows it, then two lines. Line 1 in body text, 500, `--pw-text`; line 2 meta (s 13/20), `--pw-text-muted`.
  - **Working:** the [spinner](#skeletons-and-spinners) in `--pw-info-fg`, or under reduced motion an 8 px [status dot](#status-dot) in its place, so nothing spins (2.13). Then "Working · 2m 14s", the time since the turn began in `--pw-text-subtle`, 400, tabular numbers, ticking each second on the page's one clock ([Timestamps](#timestamps)): "45s", "2m 14s", "1h 5m". Line 2 is the step, on one line with an ellipsis, the whole of it in a [tooltip](#tooltips) when it's cut (`onlyIfCut`), at most 120 characters.
  - **When the turn began:** at the entry that began it: the newest `user`, `cross-session` or `notice` entry before Claude's own entries at the end, skipping what the server marks `midTurn`: what arrived mid-turn (W99), a prompt typed while Claude worked, a message, a sub-agent's report or a task notification, and a compaction or Claude Code's own error. So a prompt typed mid-turn doesn't restart it, and a task notification or a slash command that began a turn does. When that entry is further back than the entries shown, the time counts from the oldest one, as at least that long, in whole minutes with a "+": "12m+". With no time on that entry, there's no time: "Working".
  - **The step,** from the entries shown, since the turn began: the newest tool call with no result yet (no `toolError`), by the line the conversation shows for it, the server's summary: "Running Bash: npm test"; "Editing src/app.ts", "Writing …" and "Reading …", for Edit, MultiEdit, NotebookEdit, Write and Read, its path from the session's directory when it's inside it, otherwise with home as `~`; "Waiting for 2 sub-agents" for Agent or Task calls, counting each one still out ("1 sub-agent"); "Calling *server* *tool*" for an MCP tool (`mcp__server__tool`). With none: "Thinking". A call from an earlier turn that never got its result, as an interrupted one, doesn't count. It's plain text, a call's input the conversation already shows, capped; nothing of it is stored (D14).
  - **Waiting on you:** the `warning` icon in `--pw-warning-fg`, then "Waiting for you: permission prompt", with Claude Code's `waitingFor` as written, or "Waiting for you" without one, and no time. Line 2 says where to answer, as the header's note does ([Session view](#session-view-header-tabs-and-footer)): "Answer it in its terminal." for an interactive session, "Answer it in its Terminal tab." for a background one, and nothing where its Terminal tab is off.
  - **Fresher while it works:** while the line works and the Conversation tab is shown, the newest page is fetched every 2 s (`WORKING_POLL_MS`), as well as when the activity time moves. A poll waits 2 s from the last answer and never starts while a fetch of the newest page is out; a move of the activity time can still fetch beside one, as before, and only the latest answer counts. Not behind the Terminal or Sub-agents tab, in a root tab that isn't open, while the browser tab is hidden (it goes again as the tab is shown), once the newest page says the turn has ended, or once the view closes. The snapshot's own poll is as it was. Why 2 s: nothing is written to the transcript during a long tool call or a long think, so a step was up to 5 s old, and the time ticks by itself. The server reads a page backwards from the end of the transcript, never the whole file: on the 12 largest of 311 transcripts on the Mac it was measured on (40 to 172 MiB, 2026-10-29), 0.5 to 5.8 MiB and 2 to 25 ms a page, and a listing of the session's `subagents/` folder for their names, at most 0.6 ms for the largest there (144 files). So a view of a working session costs it at most about 1.3% of a core (25 ms every 2 s), and mostly under 0.2%.
  - **Following:** the line comes and goes, and a waiting line can wrap, without a new entry: at the bottom, the conversation stays at the bottom; scrolled up, nothing moves.
  - **Announced** by a second visually hidden `role="status"` in the panel, always there, after the count's: "Claude is working" as a turn starts, "Finished" as it ends, or the waiting text, such as "Waiting for you: permission prompt. Answer it in its terminal.", once each. Never at a tick of the time, which is `aria-hidden`, or a change of step, never for the state the view opened in, as when `j` or `k` steps onto a working session, never before the first page has said whether its turn has ended, and not when the session leaves the list. A screen reader reads the line itself, "Working" and the step, in place.
- **States** (`ConversationPanel`; see [Empty states](#empty-states) and [Errors](#errors)):
  - **Status lines,** in one `role="status"` region that's always in the panel, so what it comes to say is announced: "Loading the conversation…", after `--pw-delay-spinner`, then "Still waiting for the transcript…" under it after `--pw-delay-long`; "Nothing to show yet."; "No transcript for this session."; and "The conversation can't be loaded here." where there's no API client.
  - **Failures** are inline alerts with Try again (outline sm, `retry` icon; busy, "Trying again…", while its request is out, the alert staying until it works). Danger when nothing is shown, warning when what's shown is kept, `role="alert"` either way. When Try again works and its alert goes, focus on it moves to the panel. When it fails again, even the same way, its alert is replaced by a new one, so it's announced again, and focus on its Try again moves to the new one's (W31). A refresh that goes on failing the same way by itself, as the activity moves, leaves its alert as it is, so it isn't announced at every poll.
    - The first page: "Couldn't load the conversation." at the top, danger. A failed read is never "Nothing to show yet.".
    - Load earlier: "Couldn't load earlier messages.", warning, in the button's place until it works.
    - A refresh, the newest page fetched again when the session's activity moves: the entries stay, and "Couldn't refresh the conversation, so it may be out of date." goes at the end, below the list, warning, followed at the bottom as new entries are. The next refresh that works, or Try again, clears it.
    - Each has the server's reason after pitwall's sentence when its body gave one (`{ "error": … }`), in code style, as text; or else, when the server answered, the HTTP status before the full stop ("Couldn't load the conversation (HTTP 500)."). Today's conversation route sends a status alone.
    - **Busy is not a failure yet:** the route reads at most four pages at once, server-wide, and answers 429 with `Retry-After` past that, as fast `j` or `k` through the list can reach. A page that gets one is asked for once more after that wait (1 s without one, at most 5 s), and only a second 429 is a failure. Closing the view stops the wait (W31).
  - **Notices,** neutral inline alerts, `role="status"`:
    - "The transcript changed, so this starts again from its newest messages.": Load earlier's cursor was stale (410), so the newest page replaces the entries. The notice is at the top, above Load earlier, and the view stays at the top, where the reader was, rather than jumping to the newest entry. It stays while the entries it starts are shown, across refreshes and Load earlier, and goes when the newest page replaces them again.
    - "The transcript is no longer available, so this is what it showed last.": a refresh found no transcript (404) with entries on screen. They stay, and the notice goes at the end.

### Sub-agents

The session view's Sub-agents tab (W77; Phil, 2026-10-23 and 2026-10-27; the coordinator's calls in `PLAN.md`, "M3.1 - After M3", item 4): the sub-agents a session started, as one list, and each one's transcript, read-only. `Subagents.tsx` (`web/src/components/`), with `useSubagents()`, `SubagentsPanel` and the list's rows; the list is fetched and checked in `web/src/subagents.ts`. The list stays out of the snapshot (D15): the snapshot carries only `subagentsRunning`, for the [row](#session-rows).

- **When the list is asked for** (`subagentsPath()`):
  - **Once as the view opens,** after its conversation's first page has come back, so the two never wait on each other for the server's four reads at once, and a view only passed through with `j` or `k` asks nothing more. It's what says whether the tab shows. Or first when the tab is opened, as from a link.
  - **Again when the tab is opened,** and, while it's open and the session has `subagentsRunning`, at each of the index's polls (a snapshot's or a heartbeat's `generatedAt`), so a running one's state and times keep up; once more when the running count changes, so the tab's count does; and once for a sub-agent the conversation names that the list hasn't got, as one started since. Never while the session isn't listed. A view kept hidden for a root tab (W38) asks as it opens and when the count changes, but not at each poll.
  - **One request at a time:** asked again while one is out, as at a poll when the route is slower than the polls, it asks once more when that one answers, however often it was asked meanwhile. So each answer lands, and the tab never holds more than one of the server's four reads.
  - **A 429** is asked again once, after `Retry-After`, as a conversation page is. **A 404**, which a server without the route answers too, or any other failure, never shows the tab by itself, so it fails soft; on a tab shown for another reason, it's the failure below.
- **When the tab shows:** once the session is known to have at least one: the list has some, `subagentsRunning` is set, or an entry in the conversation names one. Then it stays (see [Session view: header, tabs and footer](#session-view-header-tabs-and-footer)).
- **The panel** is the tab's `role="tabpanel"`, named by the tab, and holds the list or one sub-agent's transcript. It's kept, `hidden`, behind the other tabs, so a transcript and its place are there when you come back.
- **The list:** one flat `<ul>` (named "Sub-agents"), running ones first, then the newest started first, as the server sends them. The page keeps the server's order, and only moves a running one that arrives after the rest up to the others, so the tab always opens on what's running. The rows run to the body's edges, as the session list's do, a 1 px `--pw-border` line between them and under the last; the body scrolls.
- **A row** (`li.subagent`): padding 8 px 16 px, `--pw-surface`, `--pw-surface-hover` on hover, and a click anywhere on it that isn't a control (or the end of a text selection) opens its transcript, as a session row's does.
  1. **Line 1:** the description, plain text (m 14/20, 500, `--pw-text`, one line with an ellipsis, the whole of it in a tooltip when it's cut), which is the row's `<button>`; then, at the right, its state [badge](#badges) and when it was last active, a relative [timestamp](#timestamps) in the row's fixed slot (`.activity`, `min-width: 7ch`, right-aligned), so the badges and times line up down the list and stay put as they tick. The description gives way first.
  2. **Line 2,** meta (s 13/20, `--pw-text-muted`), wrapping: its type ("general-purpose", "Explore") when recorded, its tool calls ("No tool calls", "1 tool call", "14 tool calls"), and "Started *5m ago*", a timestamp in `--pw-text-subtle`, " · " between them in `--pw-text-subtle`.
  3. **A nested one** (`startedBy`): "Started by *description*", meta in `--pw-text-subtle`, the description in `--pw-text-muted` 500, one line with an ellipsis and the whole of it in a tooltip when it's cut; "Started by another sub-agent" when the one that started it isn't listed.
  - **Its button's name is the whole description,** and the rest of the row describes it (`aria-describedby`): its state, "active *5m ago*", its type, tool calls and start, and what started it. Each " · " is `aria-hidden`, with a visually hidden ", " beside it, so a screen reader pauses there.
  - **Focus:** the description's ellipsis would clip its button's ring, so the row shows `--pw-ring-focus-inset` while the button has focus, as a session row does.
- **Keys:** the list is one Tab stop (roving `tabindex`), the first row's, or the row last focused. ↓ and ↑ move between rows, stopping at the ends, and Home and End jump to them, as the repo list's do; Enter or Space opens one. `j` and `k` still change session.
- **Its states** (see [Empty states](#empty-states) and [Errors](#errors)):
  - **Loading:** "Loading the sub-agents…" in the body's `role="status"`, after `--pw-delay-spinner`, then "Still waiting for the sub-agents' transcripts…" under it after `--pw-delay-long`. The tab has no count yet.
  - **Failed:** "Couldn't load the sub-agents." at the top, a danger inline alert, `role="alert"`, with Try again (busy, "Trying again…", while it's out; the alert stays until the list arrives), and the HTTP status or the server's reason after pitwall's sentence. A Try again that fails again is a new alert, announced again.
  - **A refresh that failed:** the list stays, with "Couldn't refresh the sub-agents (HTTP 502), so they may be out of date." above it, warning, with Try again; the next one that works clears it.
  - **None:** the empty state, `subagents` icon, "No sub-agents", "Sub-agents this session starts show here, with their state and transcripts." It's rare, since the tab shows only once there's one, as when the snapshot counted running ones that the list then didn't have.
  - **Cut short** (`truncated`): after the rows, a neutral inline alert with no role, there from the start: "This session has more than 200 sub-agents, so the oldest are left out." (`SUBAGENTS_MAX`).
  - **With no rows,** the body is the panel's Tab stop (`tabindex="0"`), so its status, alert or empty state can be reached and read.
- **A sub-agent's transcript,** opened from its row or a link: the panel holds it in place of the list, keyed by the sub-agent, so another starts afresh.
  - **Its bar,** which stays while the conversation scrolls below it: padding 8 px 16 px 12 px, a bottom `--pw-border`. First a ghost sm "Back to sub-agents" (`back` icon), its padding given back so its icon lines up with the heading, and, at the right, its state badge and "Active *5m ago*"; then its description as the `<h3>` (m 14/20, 600, wrapping, nothing cut), which takes focus as it opens, with no ring of its own; then line 2's meta, with "Started by *description*" for a nested one. Its state and the rest come from the list, so they fill in once it arrives.
  - **Its conversation** is the [conversation](#conversation)'s own panel, `role="region"` named by the heading, from `subagentConversationPath()`: its entries, folds, Load earlier, Jump to latest, its states and its notices, read-only. It fetches its newest page again as the sub-agent's last activity moves, which the list, asked for at each poll while any run, keeps up. The first activity time the list brings isn't a move: a transcript opened from a link before the list arrived has already asked for its newest page. "No transcript for this sub-agent." where it has none.
  - **No message box:** a sub-agent can't be messaged from here, and the footer is hidden on this tab.
- **Focus never drops to the page** (6.1, item 8):
  - Opening a row, or a link from the conversation, puts it on the transcript's heading, even for the one already open.
  - Back returns to the list with focus on that sub-agent's row, which becomes the list's Tab stop, or the first row, or the list itself.
  - A refresh that moves or takes away what had focus, a row React moved or an alert that went with its Try again, puts it back on that row, the one that took its place, the one before, Try again on a new alert, the first row, or the list.
  - Opening the tab with a click puts focus on it, as Safari doesn't give a clicked button focus and the footer, which may have had it, goes with this tab.
- **Not now:** stopping a sub-agent, messaging one, and its own sub-agents as a tree. The list is flat, with "Started by" on the nested ones.

### Markdown in messages

- **Component:** `Markdown` (`web/src/components/Markdown.tsx`), on the tree that `web/src/markdown.ts` parses, inside the entry's text (`.entry-text.entry-markdown`). It's for Claude's messages, its messages to pitwall (W46) and other sessions' only, which the server sends as written with `markdown` set (W36). Your messages, notices, tool calls, questions asked in a dialog and their answers (W49), the relayed reply in the message box and every other text stay plain text.
- **Never HTML:** every piece of text is a React text node; nothing is parsed as HTML or set with `innerHTML`, and `web/src/html.test.tsx` fails on any way of doing so in the web UI. Nothing is loaded: an image is its alt text. Anything the parser doesn't read shows as the literal text it is.
- **Blocks,** 8 px apart (`--pw-space-2`), 12 px above a heading, 4 px inside a list item and 2 px between items:

| Markdown | Shown as | Look |
|---|---|---|
| Paragraph | `<p>`, each single newline a line break (`<br>`), as Claude's terminal shows them | Body (m 14/20) |
| ATX heading, `#` to `######` | Styled text, a `<p>`, not `h1` to `h6` (below) | 600: `#` and `##` l 16/24, `###` to `######` m 14/20 |
| Fenced code, ``` or ~~~ | A box: a bar with the info string's first word as the language and a Copy button, then the code as written, in a `<pre>`, its bare URLs links (below) | `--pw-surface-muted`, a 1 px `--pw-border` border, `--pw-radius-md`; the language label style (xs 12/20, 500) in `--pw-text-muted`, cut with an ellipsis; the code in code style (mono s 13/20, ligatures off, tabs at 4), padding 0 12 px 8 px, scrolling sideways in its own box. No syntax highlighting |
| Bullet and ordered lists, nested | `<ul>` and `<ol>` with its `start` | 24 px indent; disc, circle, then square bullets; markers in `--pw-text-muted` |
| Block quote, nested | `<blockquote>` | A 3 px `--pw-border-strong` border at the start, 12 px in, `--pw-text-muted` |
| Thematic break, `---`, `***` or `___` | `<hr>` | A 1 px `--pw-border-strong` line |
| GFM table | `<table>` with header cells as `th scope="col"`, and each column's alignment as a class | Body; 1 px `--pw-border-strong` cell borders, padding 4 px 8 px, header cells 600 on `--pw-surface-muted`; cells wrap at spaces only, so a table too wide scrolls sideways in its own box |

- **Inline:** bold (`<strong>`, 600, the heaviest weight pitwall loads), italic (`<em>`; Inter's italic isn't bundled, so the browser slants it), both, `~~strikethrough~~` (`<del>`), code spans of any backtick-run length (inline code, 2.7, with a line height of 1, so JetBrains Mono's taller ascent doesn't stretch its line off the 4 px grid), and backslash escapes.
- **Links:** only absolute `http:` and `https:` URLs with no username or password, from `[text](url)`, `<url>` and bare URLs, become links, as the browser parses them (`new URL()`), so an internationalised host is in punycode. Each opens in a new tab with `rel="noopener noreferrer"`, in `--pw-link`, underlined 2 px below the text (2 px thick on hover). Its [tooltip](#tooltips), on hover and on focus, and its description, is the full URL it opens, since its text can say anything (as `links.ts` does for the terminal). Any other link (`javascript:`, `data:`, `mailto:`, a relative path, a username or password before the host) shows as the text it was written as, its target included.
  - **A username or password before the host** (W55, W48's F6): `https://github.com@evil.example/x` goes to evil.example, with github.com only its username, so it names one site while it goes to another. It's never a link: in `[text](url)`, `<url>`, a bare URL and code alike it's the text it was written as, and an image of one is its alt text. An `@` in the path, as in `https://example.com/@name`, is no username.
  - **Links that ask first** (W55, W48's F6; Phil, 2026-10-23): a link whose text isn't its own address asks before it opens, since its text can name one site while it goes somewhere else, and one quick click would open it. A bare URL and an autolink are their own address, so they open on one click, in text and in code, as before, unless their host is punycode (below).
    - **The same address** (`isOwnAddress()`, `web/src/markdown.ts`): the link's text, through its formatting and code, without the spaces and C0 controls at either end that the browser's parser drops too, and with no space, tab or line break inside, read as a URL: as written when it starts with `http:` or `https:`, or else with the link's own scheme and `//` before it, so `[example.com/docs](https://example.com/docs)` is the scheme left off. Parsed, that's the link's URL apart from one `/` at the end of the path, or an empty `?` or `#`. The parser already makes the case of the scheme and host, a host and its punycode, a default port, `.` and `..` segments and percent-encoding the same.
    - **Not the same, so it asks:** words, as in `[the pull request](https://github.com/example/app/pull/51)`; another URL, as in `[https://github.com/example/app/pull/51](https://example.com/pull/51)`; the other scheme (`http:` text on an `https:` link); another path, query, fragment or port; `www.` added or left off; an image's alt text.
    - **A look-alike host asks, whatever the text** (W58): a link also asks when any label of its host starts with `xn--`, in any case (`hasPunycodeLabel()`, `web/src/markdown.ts`), so as a bare URL, an autolink, `[same](same)`, inline code and a code block alike. Its text can show an internationalised name that looks like another: `https://gіthub.com/example/repo/pull/51`, with a Cyrillic і, reads as github.com and goes to `xn--gthub-n2e.com`. The question names that punycode host. A host in ASCII opens on one click as before, and so does `xn--` anywhere else: inside a label, or in the path, query or fragment.
    - **The question:** an [inline confirmation](#inline-confirmation) straight after the paragraph, heading, table or code block the link is in, at the message's width, since a line of text can't hold one: "Open this link to *host*?", then "Its text doesn't show where it goes:" and the full address in code style, then Cancel and Open link. The host and the address are the browser's parse, as the tooltip's are, so an internationalised host is in punycode: "Open this link to xn--exmple-cua.com?". One question at a time in a block: another link's replaces it.
    - **What asks:** a click, Enter and a middle click, with or without a modifier. The browser's own context menu doesn't: it's the browser's, and its Open Link in New Tab is a choice made after the link's tooltip has shown the address.
    - **The link itself doesn't change:** its look, its name, its tooltip and description, and its `href`, `target` and `rel`. Nothing shows that it asks until it does.
    - **Open link** opens it as the link would, in a new tab with no opener or referrer (`window.open` with `noopener,noreferrer`, inside the click, so the browser allows it).
  - A bare URL can't follow a letter or a digit. It runs to a space, `<`, `>`, `"` or a backtick, none of which a URL holds as written (a URL has them percent-encoded), and leaves out trailing punctuation, `'` included, and a `)`, `]` or `}` it didn't open (W37). So the URL in an HTML attribute (`href="https://example.com/docs">`), in JSON (`{"url":"https://example.com/a"}` or `{'url': 'https://example.com/a'}`) or in backticks in a draft links to just the URL, and `https://example.com/users/{id}` stays whole. GFM allows only a space, `*`, `_`, `~` or `(` before one; a quote or a bracket is allowed here too.
  - Links don't nest: one inside a link, such as a linked badge's image, gives only its text, and code inside a link's text stays plain code.
  - **In code** (W37): bare URLs in a code block or in inline code are links too, under the same rule, so a draft or a command Claude puts in code can be opened from it, as a terminal makes a URL clickable wherever it is. Code is literal, as in CommonMark and GitHub, so only bare URLs: markdown's own link syntax in code, `[text](url)`, `<url>` and `![alt](url)`, stays the text it is, and so does any other scheme. The code's text doesn't change: the links are its own characters, its whitespace, line breaks and language label are as they were, and it still scrolls sideways in its own box.
    - **Look:** the code's mono face and size, in `--pw-link`, underlined as every link is. The underline is what tells them apart from the code around them: `--pw-link` is only 2.37:1 (light) and 2.93:1 (dark) against the code's `--pw-text`, short of the 3:1 that colour alone would need (WCAG 1.4.1; 6.1, rule 2). On the code's fill they're 7.46:1 on `--pw-surface-muted`, 7.14:1 on inline code's `--pw-surface-sunken` and 7.78:1 on `--pw-surface` in another session's message or a message to pitwall, in light; 5.28, 4.99 and 5.51:1 in dark. These are neutral surfaces, so the 2.5 row for `--pw-link` covers them.
    - **Focus:** a link in a code block takes the inset ring, `--pw-ring-focus-inset` with the outline at `-2px`, as the box itself does: the box clips what's drawn past it, and the code's first line has no padding above it, so the outer ring would lose its top there. A link in inline code has the outer ring, as a link in text does.
    - **Tab order:** a code block's Copy button, then the box while it scrolls, then each link in the code, in its order. That's the order they're in, so nothing is reordered, and the box keeps its own stop, so the code can still be scrolled from the keyboard where it has no link. Focus on a link the box doesn't show scrolls the box to it, never the page.
- **Images** are never loaded: an image is its alt text, linked under the link rule, or its URL as written when it has no alt text.
- **Shown as text:** raw HTML, entities, reference links and footnotes, setext headings, indented code, a single `~`, and task-list markers (`[ ]`, `[x]`). A bare URL in any of them is still a link, as in any text: in raw HTML's `<a href="https://example.com">`, the link is pitwall's own, to the URL alone.
- **In another session's message, and a message to pitwall,** whose boxes are `--pw-surface-sunken`, code blocks and inline code are on `--pw-surface`, so they stand out from it.
- **Headings are styled text:** the page's outline is pitwall's own (6.1, rule 6): one `h1`, the lists' `h2`s, the rows' `h3`s and the session view's `h2`. A message's headings as `h1` to `h6` would sit in that outline among the session list's rows, as many and as deep as a session wrote them.
- **Scrolling sideways:** a code block's `<pre>` and a table's box scroll on their own, with `overscroll-behavior-x: contain`, and the page and the conversation never do (2.12). While one scrolls, it's a Tab stop, a region named "Code, *language*" (or "Code") or "Table", with the inset focus ring (`ScrollBox`, as the page alerts are).
- **Copy:** a ghost sm `copy` icon button named "Copy code", through `copy.ts`, with its "Copied" toast, or the code selected and an error toast when the clipboard refuses (see [Copy](#copy)). It copies the code exactly as written, links in it or not. A link's tooltip is rendered into `document.body`, outside the code, so code selected and copied by hand holds none of its text either.
- **A message cut short** (`truncated`): a fence that never closes runs to the end as code, then "Cut short." follows, as for any entry.
- **Bounded:** the parser only ever moves forward, as CommonMark's reference parsers do, so its time grows with the text's length; lists and quotes nest at most 8 deep, emphasis and links 16, and a table has at most 64 columns, past which the syntax is text. 32 KiB of hostile input parses within a frame (`web/src/markdown.test.tsx`). A message whose markdown would take more than 5,000 elements (`MAX_ELEMENTS`; 32 KiB of dense everyday markdown takes about 4,000) shows as the text it was written in, `white-space: pre-wrap`, then "Shown as written: too much formatting to show." in meta, `--pw-text-subtle`. Links in code count as links do, four each with their tooltips, so a message that's one code block shows 1,247 of them at most, and 32 KiB of code packed with URLs shows as written. In headless Chrome, 32 KiB of hostile input then blocks the page for at most about 30 ms, as 32 KiB of dense everyday markdown does, most of it laying out the text (W36's app check); a code block of 1,247 links, the most a message can show, does too (W37's).
- **Memoised** on its text, so a conversation that re-renders as entries arrive doesn't parse or draw a message again. Links in code are found once, as the message is parsed, not as it's drawn.

### Alerts and banners

**Inline alert** (the default; inside panes, dialogs and the footer):

- **Box:** padding 12 px, `--pw-radius-md`, `--pw-<tone>-tint` fill, `inset 0 0 0 1px var(--pw-<tone>-border)`.
- **Icon:** 16 px, in `--pw-<tone>-tint-fg`, top-aligned in a 20 px line box: `info` (neutral, info), `success`, `warning`, `error` (danger).
- **Text:** an optional title (m 14/20, 500, `--pw-text`), then the body (m 14/20, 400, `--pw-text`), 8 px after the icon.
  - Detail that comes from Claude Code or the server (such as the relay's "Latest:" text) is in code style, inside `plainText`.
- **Component:** `Alert` (`web/src/components/Alert.tsx`), with `tone`, `title`, `role`, `actions` and `onDismiss`.
- **Actions:** outline sm buttons at the right; they wrap under the text when the app, or the session list column the alert is in, is 600 px wide or narrower.
- **Roles:** `role="alert"` for warning and danger alerts that appear after an action or arrive live; `role="status"` for the rest. An alert that is there on page load has neither: for the page alerts, that's one in the first snapshot, until what it says changes or it goes.
- **Dismiss:** ghost sm "Dismiss". Its `--pw-text-muted` passes on every tint (2.5); a link button wouldn't, since `--pw-link` belongs on neutral surfaces. A dismissed alert stays dismissed until its content changes (a new time or count brings it back). Focus goes to the session list's heading, since the button has gone.

| Alert | Tone | Title | Body |
|---|---|---|---|
| The poll failed | warning | "Couldn't list sessions" | "`claude agents --json --all` failed on the latest poll: *error*" |
| Server error | danger | | The error, with Dismiss |
| Connection lost | neutral | | "Lost the connection to pitwall. Reconnecting; this list may be out of date." |
| Relay may have sent a message you didn't ask for (`cause: 'unrequested'`, `blocked: false`) | danger | "pitwall's relay may have sent a message you didn't ask for" | "That usually means another session messaged the relay. Check your sessions' conversations for a message from pitwall-relay.", then "Messaging is off until you restart pitwall." only while the snapshot's `relayOff` is set, then the count since start, "Latest: *detail*", with Dismiss |
| Relay blocked one (`'unrequested'`, `blocked: true`) | warning | "pitwall blocked a message you didn't ask for" | "Its relay tried to send it, and pitwall's gate stopped it, so nothing was sent. That usually means another session messaged the relay.", then the same structure |
| Relay may have sent a changed copy of your message (`'changed'`, `blocked: false`) | danger | "pitwall's relay may have sent a changed copy of your message" | "pitwall's gate may not have stopped it. Check the conversation of the session you messaged for a message from pitwall-relay.", then the same structure |
| Relay blocked a changed copy (`'changed'`, `blocked: true`) | warning | "pitwall blocked a changed copy of your message" | "Its relay's copy differed from what you sent in more than its text, so pitwall stopped it, and nothing was sent.", then the same structure. Only for a copy that differed in more than its text: see below |
| Relay may have repeated a send of your message (`'repeated'`, `blocked: false`) | danger | "pitwall's relay may have repeated a send of your message" | "After pitwall's gate stopped its relay's copy of your message, the relay tried again in the same turn, and the gate may not have stopped it. Check your sessions' conversations for a message from pitwall-relay.", then the same structure |
| Relay blocked a repeated send (`'repeated'`, `blocked: true`) | warning | "pitwall blocked a repeated send of your message" | "After pitwall's gate stopped its relay's copy of your message, the relay tried again in the same turn. The gate stopped that too, so the repeat wasn't sent.", then the same structure |

- **Which one:** the relay alert's `cause` (W43, W52). `unrequested` is a `SendMessage` call with no request of pitwall's behind it, which usually means another session messaged the relay. `changed` is the call for one of your messages, which didn't match it: one the gate didn't stop or pitwall couldn't confirm it stopped, or one the gate blocked, or pitwall stopped before it ran, that differed in more than its text, such as one to another session, asking for idle notices or with a field pitwall doesn't check. `repeated` is a second call in the turn in which the gate blocked the call for one of your messages: the relay trying it again (W48's F8). The changed blocked summary says "pitwall stopped it", since the gate, or pitwall stopping the relay before the call ran, stops one. Only `unrequested` mentions another session.
- **No alert for an unchecked call that matched:** when your own message, exactly as you sent it, ran without pitwall's gate checking it, nothing unrequested or changed was sent. pitwall stops using the relay, and the app strip says messaging is off and why, with no Details, since there's no alert to show.
- **What's tried once more, and what alerts** (W52, W48's F3):
  - **Only the text differs:** no alert. pitwall tries once more, on a new relay, outside whatever may have primed the old one, and the message's own result, in the message box, says so: Delivered with the detail above, or Not sent with where each copy first differed. Nor does one pitwall stopped before it ran raise one.
    - **Why no alert:** the relay's model drops or changes text in long copies, so an alert there would be routine. The coordinator's live check saw a first copy of a 6,000-character message drop 447 characters, including 5 line breaks, at line 34; the second arrived exactly (W52).
  - **More than the text differs** (another session, idle notices, a field pitwall doesn't check): the `changed`, blocked alert, and no second try. A peer that talked the relay into sending elsewhere would otherwise go unseen.
- **One count** of every relay alert, whatever its cause: "Once since pitwall started", "3 times since pitwall started".
- **Never a message's text:** the title and summary are fixed, and "Latest:" is pitwall's own words. Where a copy differed is a line and character codes, such as "first at line 33: U+0107 became U+0063", never the characters.
- **"May have sent", not "sent":** pitwall sees a call its gate didn't block only afterwards, so it can't say the message arrived (5: Errors). Some of those only restart the relay, so the alert says messaging is off only when `relayOff` does.

**App strip** (one at a time):

- **Component:** `AppStrip` (`web/src/components/AppStrip.tsx`).
- **Box:** 32 px tall, full width above the header, `--pw-text` fill, `--pw-text-inverse` text (18.4:1 in light, 16.9:1 in dark), meta size; a 16 px `warning` icon in the text colour; a link button in `--pw-text-inverse` with an underline. The strip inverts with the theme, so it never uses a tone colour.
  - One line: a sentence too long for it ends in an ellipsis, with the whole sentence in a tooltip when it's cut, and Details stays on screen.
- **Use:** only while the snapshot's `relayOff` is set, which pitwall sets once it has stopped using its relay for the rest of the run. Never inferred from a relay alert: some alerts only restart the relay. "Messaging is off until you restart pitwall: *reason*", where the reason is pitwall's own words ("its gate didn't check a SendMessage call."), then "Details", which reopens the relay alert and takes focus to it. Below 1,200 px with a session open, the alert is under the view, so Details closes the view first, as `/` does; while the message box has a draft, which closing would lose, it does nothing. It stays after the alert is dismissed and can't itself be dismissed. Details isn't there when there's no relay alert to show.

### Inline confirmation

For a destructive or surprising action in the session view, without a dialog.

- **Component:** `InlineConfirm` (`web/src/components/InlineConfirm.tsx`).
- **Box:** for Stop, Remove and End, directly under the header (above the tabs), with 8 px 16 px around it. For the restart, at the top of the Terminal tab's panel, under its bar, since that tab's attach is what waits for it. For a link that asks (W55), in the conversation, straight after the paragraph, heading or table the link is in, 8 px below it, as the next block would be (see [Markdown in messages](#markdown-in-messages)), in `--pw-text` even inside a quote. `--pw-surface-muted` fill, `inset 0 0 0 1px var(--pw-border-strong)`, a left bar `inset 3px 0 0 var(--pw-danger-fg)` (or `--pw-warning-indicator` for the restart and a link), each at least 3:1 on the fill (2.5), `--pw-radius-md`, padding 12 px.
- **Content:** a question as the title (m 14/20, 500), the consequence (meta, `--pw-text-muted`), then the buttons at the right, wrapping under the text when there's no room: outline sm "Cancel", then the sm confirm button with its action's icon (`stop`, `remove`, `restart`, `external`), 8 px apart. A literal value in the consequence, such as a link's address, is in code style, and wraps anywhere.

| Action | Question | Consequence | Confirm button |
|---|---|---|---|
| Stop | "Stop this session?" | "Its conversation is kept. Attaching to it later asks before restarting it." | danger "Stop session" |
| Remove | "Remove this session?" | "It leaves the list. Claude Code keeps a worktree that has unpushed commits." | danger "Remove session" |
| End (W90) | "End this session?" | "*name*'s Claude Code process ends, and its terminal goes back to the shell. Any reply in progress is lost. Its conversation is kept, so you can resume it afterwards." With sub-agents running, by the snapshot, "Any reply in progress is lost, and its 2 running sub-agents are stopped." | danger "End session" |
| End, once the server says it's working | "It's still working. End this session anyway?" | What runs, by the server's check just then: "Its turn is still running: a reply being written is lost, and its commands are stopped.", or "pitwall can't tell from its transcript whether its turn has ended, so a reply being written may be lost, and its commands stopped.", then "2 sub-agents are running, and they end with it." when they are, or "pitwall can't tell whether its sub-agents are running; any that are end with it." when it couldn't read them, then "You can still resume it afterwards." | danger "End session anyway" |
| Attach to a session that isn't running | "Restart and attach?" | "This session has finished, or its process has exited. Attaching restarts it." | primary "Restart and attach" |
| Open a link whose text isn't its address (W55) | "Open this link to *host*?" | "Its text doesn't show where it goes:" then the full address, in code style | primary "Open link" |

- **Focus:** Cancel takes focus when the confirmation opens.
  - Escape cancels it, without closing the view, wherever focus is in the page. A link's question, which sits in the scrolling conversation and may be out of sight, cancels on Escape only while focus is in it; elsewhere, Escape does what it would have.
  - On cancel, focus goes back to whatever opened it (the actions menu button, the Terminal tab, or the link), without opening that control's tooltip (`focusQuietly`).
- **Semantics:** `role="group"` with `aria-labelledby` (the question) and `aria-describedby` (the consequence). For the restart and a link's question, which interrupt opening a tab or a link, and End's stronger warning, which interrupts End session, `role="alertdialog"`, so the question and the consequence are read as Cancel takes focus.
- **End's session name** is in its own `<bdi>`, inline, so a right-to-left name, or the directional marks W87 keeps in names, can't reorder the sentence around it (W90's review). `plainText()` is as it was.
- **End's stronger warning** (W90; spike 005's guard): End session sends nothing but the session's id at first. When the server finds the session working, its turn running, a prompt on screen, its transcript unable to say, sub-agents running, or sub-agents it couldn't read, it answers 409 with what runs and signals nothing. The confirmation then becomes the stronger warning in place, as a new confirmation, so Cancel takes focus afresh. Only its End session anyway sends `whileWorking`. Cancel or Escape on it ends nothing, and focus goes back to the menu button; End session asks the first question again next time.
- **When End's session ends some other way** while its question is open, as with `/exit` in its terminal, the question goes, since there's nothing left to end, and focus it had goes back to the menu button.
- **Busy:** the confirmation stays while its action runs, and the confirm button shows the busy state ("Stopping…", "Removing…", "Ending…", "Restarting…"). End stays busy while the server checks the session, signals it and waits up to 5 s for it to exit. Cancel is `aria-disabled`, and Escape does nothing, since the request is already out; the view stays open. The restart stays busy until the attach has started or failed. A link's question is never busy: Open link opens the tab at once.
- **Result:** the confirmation goes, and focus goes back to the actions menu's button; Remove closes the view instead. A link's question goes as Open link opens the tab, and focus goes back to the link.
  - Stopped: a [toast](#toasts), "Stopped. Its conversation is kept."
  - Removed: a toast, "Removed *name*", as the view closes.
  - Ended (W90): a success toast, "Ended *name*. Its terminal is back at the shell." When its process hadn't exited by the server's answer, an info toast instead: "Sent *name* the signal to end. It hadn't exited after 5 seconds, so it may still be finishing."
  - Refused: an inline danger alert, `role="alert"`: "Couldn't stop the session." (or remove, or end), then Claude Code's message, or for End the server's reason, in code style. A 429 with no reason of its own says when to try again: "Couldn't end the session (HTTP 429). Try again in 3 seconds."
  - **When the view has gone** while the request was out (Close, Back, `/` or the browser's back button), the result still arrives, from the app's toasts, which outlive the view, and names the session, since nothing on screen says which it was: "Stopped *name*. Its conversation is kept.", "Removed *name*", "Ended *name*. Its terminal is back at the shell.", or an error toast, "Couldn't stop *name*. *Claude Code's message*" (or remove, or end), its message as text, or "Couldn't stop *name* (HTTP 502)." when the server gave no reason. An End the server refused because the session is working is an error toast too, since nothing happened: "Didn't end *name*: it's still working. Open it to end it anyway."
  - `j`, `k`, ↑ and ↓ do nothing while the action runs, as they do for a draft, so they never move the view away from it.
  - A restart that fails ends the attach, whose notice says why, and Attach again takes focus.
- **No type-to-confirm.** pitwall's destructive actions are recoverable or guarded by Claude Code.

### Dialogs

- **Component:** `Dialog` (`web/src/components/Dialog.tsx`), with `title`, `subtitle`, `size`, `busy`, `dirty`, `footerMeta`, `actions` and `onSubmit`, which makes the body and footer a form. The New session dialog, the keyboard shortcuts dialog and the [Preferences](#preferences) dialog are built on it.
- **Backdrop:** `--pw-backdrop`, `--pw-z-backdrop`, centring the card with 48 px top and 16 px side margins.
- **Card:** `--pw-surface-overlay`, `--pw-shadow-3`, `--pw-radius-lg`, `--pw-dialog-md` (624 px) wide, or `-sm` or `-lg`, never wider than the window less its margins, at most `calc(100dvh - 96px)` tall, `--pw-z-dialog`.
- **Sections,** divided by 1 px `--pw-border`. The header and footer are plain elements, not `<header>` and `<footer>`, which outside a sectioning element would be the page's banner and contentinfo landmarks:
  - **Header:** padding 12 px 16 px; the title (l 16/24, 600); a ghost md `close` icon button at the right, "Close", with Esc's key cap in its tooltip; an optional meta subtitle in `--pw-text-muted`, which describes the dialog (`aria-describedby`).
  - **Body:** padding 16 px, scrolls, fields 16 px apart.
  - **Footer:** padding 12 px 16 px; optional meta text at the left, in `--pw-text-subtle`; at the right, outline "Cancel" then the primary action, 12 px apart. A dialog with nothing to submit, such as the keyboard shortcuts dialog, has no footer: it has neither `actions` nor `footerMeta`.
- **Behaviour:**
  - `role="dialog"`, `aria-modal="true"`, `aria-labelledby` (the title).
  - Focus moves to the first field on open, Tab and Shift + Tab are trapped inside, and focus returns to the opener on close, without opening the opener's tooltip (`focusQuietly`), which would take the next Escape: one more Escape then goes on to what's behind, such as the session view.
    - A [radio group](#inputs-textareas-and-selects) is one field, its checked radio, as the browser's Tab has it (W59): the dialog opens on the first group's choice, and the trap counts the last group's choice as the last stop, not its last radio.
  - Focus is back on the opener in the commit that removes the dialog, however it closes, including New session's once its request answers (W83). After such a close, React runs a passive effect's clean-up a task later, so focus would be on the page in between. Only the web tests, in happy-dom, have shown that gap; Chrome 155 had focus back already.
  - Escape closes it, except while submitting (and it doesn't also close the session view behind).
  - A click on the backdrop closes it only when nothing has been typed. A press that starts in the card and ends on the backdrop, as when selecting text, isn't a click on it, and a press on the backdrop doesn't take focus out of the dialog.
- **Busy:** the primary button's busy state; the other controls are `aria-disabled`, Close included, and the text fields are read-only. Escape and the backdrop do nothing.
- **Failure:** an inline danger alert, `role="alert"`, at the end of the body, above the footer.

**New session dialog:**

- **Fields:**
  - Directory: a select of the groups' directories, plus "Another directory under a root…", which reveals the [directory combobox](#combobox), with focus in it and its list open, narrowing the directories under the roots as you type (W70). Help text: "Under *roots*.", linked to both.
    - With [root tabs](#root-tabs), the open tab's root alone: its groups' directories, then its root, and "Under *root*.". A typed directory must be in that tab, under its root and under no other root inside it, where the index would list the session: "Use a directory under ~/work. ~/personal has its own tab." (W38).
  - Name: optional, placeholder "Claude Code names it from the prompt".
  - Model: optional; a select of Default, the aliases, and "Other…", which reveals a mono field.
  - First prompt: a textarea, 6 rows, which takes files too: see [Files for the first prompt](#files-for-the-first-prompt) below (W82).
- **Problems** show after the first submit, then follow the typing; a submit, or ⌘/Ctrl + Enter, puts focus on the first field with one. Each is linked to its field with `aria-describedby`, and the field is `aria-invalid`.
- **Intro:** the subtitle: "Starts a background session with `claude --bg`, which you can open from the list."
- **Footer:** "⌘ ↵ to start" as key caps (Ctrl on other platforms) at the left; "Cancel" and "Start session" ("Starting…" while busy) at the right. ⌘/Ctrl + Enter submits from any field. Start session is `aria-disabled` while a file is uploading or has failed, saying why in its tooltip (below).
- **Failure:** "Couldn't start the session." then the server's message in code style; or pitwall's own sentence, such as "Couldn't start the session (HTTP 500)."
- **Trust failure:** the same alert, then "pitwall never trusts a directory for you. Run this in a terminal, accept Claude Code's trust prompt, then start the session again:", with the command in a [command chip](#copy) and its copy button, "Copy command". For a directory whose path has a `'` or `\` the server sends no command (W87): after Claude Code's line, in place of the sentence before the chip, pitwall's own "pitwall never trusts a directory for you, and there's no command to copy for this one: its path has a ' or \, which shells don't all read the same way.", as text, its `'` and `\` in code style, with no chip. Only for a 422, Claude Code's trust failure, with no `hint`.
- **Started:** the dialog closes, and a toast says "Started *name*. Its view opens when it shows up in the list."
  - **Once it's listed** (Phil, 2026-10-23, W63: "when creating a new session, it should be automatically selected - the repo/directory and the session."), on a later poll, the page selects all three: its [root tab](#root-tabs), when there are several and it isn't the open one; its group in the repo list, the one it's listed under in the viewer's [Group sessions by](#preferences), which is its home group, as `?session=` selects it (see [Repo list](#repo-list)); and its view, with its row marked as the open one. From Needs you, All sessions, Starred or another group alike.
  - **History:** one entry, pushed, with the selection, `&root=` and `?session=`, as opening a row pushes one, so the back button goes back to where you were: the selection, the tab and the session you had open.
  - **Focus** stays where it is, as when a view opens from the URL, so a started session never takes it from what you're doing: on New session, say, where the dialog gave it back. Its terminal takes none either (W57; [Session view](#session-view-header-tabs-and-footer)). The exception is when the switch takes away or hides what had focus, such as a row the new group doesn't list, or focus was on the page, as after the no-sessions empty state's New session, whose button goes as the session is listed: then the view's heading takes it, which is in sight in every layout (6.1, item 8).
  - **Not over what you're in the middle of.** It doesn't switch while the view open in this tab, or the one open in the session's tab, which it would replace, has a draft, a Stop or Remove running, a Stop or Remove confirmation open, or the terminal's restart prompt; nor while you're typing in the columns, in the filter, the message box or the terminal. A dialog open over the page doesn't stop it, since the switch happens behind it. Then the toast that said it started is replaced by an info toast: "*name* is listed now. It didn't open, so you keep your place.", with Open (see [Toasts](#toasts)). Open selects the session's tab, group and view as the switch would have, in one pushed entry, and focus goes to the view's heading, as from a row; a draft it replaces is kept, as any draft is (W44). The toast goes by itself after 10 s, paused while it's hovered or focused, or when Open is used or it's dismissed, and at once when the session is opened another way, from its row say, which stays the lasting way in.

#### Files for the first prompt

(W82, from spike 008; Phil, 2026-10-27: "It should be possible to drop items/attachments, paste items, into the opening session prompt.") The New session dialog's first prompt takes files: images, PDFs and any text file, code, configuration and logs included, which the server keeps in a private folder of its own (`ATTACHMENTS_PATH`, W79) and names in the prompt as `@` mentions, so Claude Code attaches them to the first turn. `web/src/attachments.ts` checks and uploads them; `web/src/components/Attachments.tsx` draws the list and the drop target.

- **Three ways in:**
  - **Drop** files on the prompt. While files are dragged over the page, the drop target covers the prompt; a drop anywhere else does nothing, rather than the browser opening the file in pitwall's place, and the pointer says so (`dropEffect: none`).
  - **Paste** files or an image into the prompt, such as a screenshot. A paste with text in it is text: it pastes as text and attaches nothing, as a copy from a spreadsheet or a document does, which carries a picture of its cells too. Some text still attaches the files:
    - each line a file's own name, or a path ending in it, as a copied file carries;
    - one URL alone, as a browser's Copy Image may carry the image's;
    - Word's object replacement character alone, as it copies an image by itself;
    - whitespace, unless it comes with rich text (HTML or RTF), as a blank spreadsheet cell does: then it's text.
  - **Attach files:** an outline sm [button](#buttons) with the `attach` icon, under the list, before the hint, with a native `<input type="file" multiple>` behind it, hidden and out of the Tab order. It's the way in from the keyboard and for a screen reader, since dragging is for a pointer. It has no `accept`: a system picker filtering by type would hide source files with no type of their own, such as a Go file, and the check below says why anything is refused.
- **What it takes** (the contract's, repeated so a file is refused before it's sent; the server is the authority):
  - **The type** (`attachmentType()`): one of `ATTACHMENT_TYPES` (PNG, JPEG, GIF, WebP, PDF, plain text, Markdown, CSV and JSON) as the browser gives it; any other text as `text/plain`, a `text/*` type such as `text/x-python` or `text/html`, or a text-like `application/*` one such as YAML, XML, TOML, JavaScript or a shell script; then the type its extension stands for, as for a CSV Windows types as Excel's. Refused: images pitwall doesn't take, such as HEIC or SVG, audio, video, and binary formats such as archives, executables, office documents and fonts, by type or extension. Anything else, such as a Go file, a `Makefile` or a log with no type, goes as `text/plain`, and so does a `.ts` file, which the browser types as video (`video/mp2t`): the server checks it's UTF-8 with no NUL, and its 415 decides.
  - **The rest:** not empty; at most `ATTACHMENT_MAX_BYTES` (10 MB) each; at most `ATTACHMENTS_MAX_PER_SESSION` (10) in all, refused files not counted; and a name the server takes, checked as it checks it: no `/`, `\`, control or bidi character, then, without the characters that show as nothing, NFC-normalised and trimmed, not blank and at most 200 characters.
  - A refused file is listed with why, and the others go on.
- **Uploading:** each file uploads as it's added, through the app's `ApiClient` (`upload()`, which sends the apiKey), as its bytes with its type and its name, URL-encoded, in `X-Pitwall-Filename`. At most two at once; the rest wait. A 400, 413 or 415 is the server refusing the file itself, so it's refused, with the server's reason. A 503 is a pitwall that keeps no attachments on this machine, such as one whose home folder's path an `@` mention can't carry: refused too, saying the session can still start without them. Anything else, such as a 408 for an upload that sent nothing for 30 s or took over 2 minutes, a 429, a 500 or no answer, has failed, and Try again may fix it. There's no upload progress, since `fetch` has none for a request's body: a row says Uploading… with a spinner, which on localhost is a moment.
- **Layout,** in the first prompt's field, 4 px apart: the prompt; its problem; the list; then the Attach files row, the button and, after it, the hint in help text, wrapping under it where there's no room; then the files' problem.
- **The drop target:** over the prompt, as big as it, `--pw-selected` with a 2 px dashed `--pw-selected-border` edge inside it, and solid while the files are over the prompt; the `attach` icon and "Drop files to attach them" in m 14/20, 500, `--pw-info-tint-fg`, centred. It's `aria-hidden` and takes no pointer events, so the drop lands on the prompt. Forced colours: a 2 px dashed `Highlight` outline, solid while over it.
- **The list:** `<ul>` named "Attached files", 4 px between rows. It's focusable from script alone (`tabindex="-1"`), so a submit with a file on its way can put focus there, described by the problem.
- **A row:** padding 4 px, `--pw-surface`, `--pw-radius-md`, a 1 px `--pw-border` edge, or `--pw-danger-border` for a failed or refused file (decorative: the words say the state; forced colours draw a 1 px `CanvasText` border).
  - **The tile,** 32 px, `--pw-surface-sunken`, `--pw-radius-sm`: an image's thumbnail, its middle square, cover-fitted, or the type's icon in `--pw-text-muted`: `image`, `pdf` or `file`. Decorative, `aria-hidden`.
  - **The name,** m 14/20, as text (`plainText()`), without the characters that show as nothing (Unicode's Default_Ignorable_Code_Point, such as a zero-width space, a variation selector, a tag character or the Hangul filler, W87), NFC-normalised and trimmed, as the server keeps it, and sent so (`cleanName()`). A name the list has already is numbered before its extension, "image (2).png", as two pasted screenshots both arrive as "image.png", so each Remove is named apart; a blank one reads "Unnamed file". Cut in the middle when there isn't room, with its extension and the 6 characters before it kept (`fileNameParts()` in `web/src/format.ts`), so screenshots whose names start alike can be told apart; each part keeps its spaces (`white-space: pre`).
  - **The meta line,** s 13/20, `--pw-text-muted`: its size, in 1,024s ("512 B", "4.2 KB", "244 KB", "1.5 MB"), then " · Uploading…" with a 12 px spinner, or " · Waiting…". A size over the limit is rounded up, so a byte over never reads as the limit.
  - **Why it isn't attached,** for a failed or refused file, s 13/20 in `--pw-danger-fg`, with the server's reason in code style (`Detail`).
  - **At the right,** 4 px apart: Try again (outline sm, `retry` icon) on a failed file, then Remove, a ghost sm `close` [icon button](#icon-buttons) named, and tooltipped, "Remove *name*", and described by the row's meta line and problem.
- **States:**

| State | Meta line | Problem | Actions |
|---|---|---|---|
| Waiting | "244 KB · Waiting…" | | Remove |
| Uploading | "244 KB · Uploading…", with a spinner | | Remove, which aborts the upload |
| Uploaded | "244 KB" | | Remove, which asks the server to remove it |
| Failed | "244 KB" | "Couldn't upload it." then the server's reason, as for a 408 (an upload that stalled), a 429 or a 500; or "Couldn't upload it (HTTP 500)." | Try again, Remove |
| Refused | "244 KB" | "Couldn't attach it." then why, below, as for pitwall's own checks, a 400, 413 or 415, or a 503 | Remove |

- **Why a file is refused:**
  - The type: "Couldn't attach it. Only PNG, JPEG, GIF and WebP images, PDFs and text files can be attached." The image types are named, since HEIC and SVG are images too.
  - An empty file: "Couldn't attach it. It's empty."
  - The size: "Couldn't attach it. It's 12.3 MB, over the 10 MB limit."
  - The count: "Couldn't attach it. A first prompt takes at most 10 files."
  - The name: "Couldn't attach it. Its name is over 200 characters. Rename the file, then attach it again.", "Couldn't attach it. Its name has a /, \ or control character in it. Rename the file, then attach it again." or "Couldn't attach it. Its name is blank. Rename the file, then attach it again."
  - The server's refusal: "Couldn't attach it." then its reason, such as bytes that contradict the type.
  - No attachments on this machine (503): "Couldn't attach it. Files can't be attached on this machine. You can still start the session without them." then the server's reason.
- **The hint:** "Or drop or paste them into the prompt: images, PDFs and text files, code included, up to 10 MB each.", linked to Attach files with `aria-describedby`.
- **Announced:** two visually hidden `role="status"` regions in the field, there from the start, say what each file came to, and what Remove did: "Attached diagram.png.", "Couldn't attach report.docx. Only PNG, JPEG, GIF and WebP images, PDFs and text files can be attached.", "Couldn't upload notes.txt. *reason*", "Removed notes.txt.". Files refused together are said together. The two take turns, the latest sentence in one and the other emptied, so the same sentence said twice is read twice.
- **Focus:** Remove puts focus on the Remove of the row that takes its place, the next one, or, with none after it, on Attach files. Try again takes its own button away, so focus goes to that row's Remove.
- **Start session** sends the uploaded files' ids, in the list's order, as `SpawnRequest.attachments`. While a file is waiting, uploading or has failed, it's `aria-disabled`, with why as its tooltip and description: "Wait for the file to upload, or remove it." ("Wait for the 3 files to upload, or remove them."), or, first, since an upload finishes by itself, "A file didn't upload. Try it again, or remove it." ("2 files didn't upload. Try them again, or remove them."). ⌘/Ctrl + Enter, which has no tooltip, checks the fields as a submit does: the same sentence shows as the files' problem, under the Attach files row, describing the list, which takes focus when it's the first problem. Focus goes to the list, not a row's Remove, which a second Enter would press. A refused file holds nothing up.
- **Busy:** while Start session is busy, Attach files, Try again and Remove are `aria-disabled`, and a drop or a paste attaches nothing.
- **Removing an upload:** Remove of a file the server has kept asks it to remove it (`DELETE attachmentPath(id)`), freeing its place among the 30 unused uploads it holds. Closing the dialog without starting aborts the uploads still on their way and asks the same for every file it kept; once the session has started with them, they're the session's, and closing asks nothing. Both are best effort, and their answers aren't shown: the server removes an upload no spawn used after an hour anyway, and one whose upload was aborted after it arrived, whose id the page never learned, goes then too.
- **Thumbnails** are drawn on a canvas, 64 px square from the image's middle, and kept as a `data:` URL, since the CSP's `img-src` allows `data:` and not `blob:`. Nothing is kept once the dialog closes.
- **Dirty:** with a file added, a click on the backdrop leaves the dialog open, as with something typed.

### Menus

- **Component:** `MenuButton` (`web/src/components/Menu.tsx`), which takes the button's icon and name, its size, md by default or sm, and a list of items, separators and radio groups. The session view's actions menu uses it, and so does the session list's Sort (W106's review), an sm button whose menu is one radio group. Its radio groups were View preferences' (W42, W54) until that became the [Preferences](#preferences) dialog (W59), and Sort's is the one in the app now.
- **Panel:** `--pw-surface-overlay`, `--pw-shadow-2`, `--pw-radius-md`, padding 4 px, min-width `--pw-menu-min-w` (192 px), `--pw-z-dropdown`. It opens 4 px below the button, aligned to its end edge, and flips up when the button is on screen and there's no room below but there is above. When aligning to the button's end would cut it off at the window's start edge, as for a button near the start of a narrow window, it moves in to 8 px from that edge.
  - With room on neither side, as on a short window, it opens below, as tall as the window leaves less 8 px (96 px at the least), and scrolls inside itself, so every item can be reached and seen (W54, for View preferences' two groups, about 440 px tall, more than a 375 px window of 540 px left below the wrapped header).
  - A menu whose radio options have lines saying what they do is as wide as its content up to 20rem, and never wider than the app leaves, 16 px each side (`100cqw`), so the lines wrap and nothing scrolls sideways at 320 px.
- **Items:** 32 px tall, padding 6 px 8 px, `--pw-radius-sm`, m 14/20, a 16 px icon in `--pw-text-muted` 8 px before the label. An item with no icon of its own, in a menu whose other items have them, keeps an icon's room, so the labels line up.
  - Hover and keyboard highlight: `--pw-surface-hover`. Keyboard focus also shows `--pw-ring-focus-inset`, since the panel's 4 px padding would clip the outer ring, and a hover fill alone is under 3:1.
  - Danger items: `--pw-danger-fg` text and icon; highlighted, a `--pw-danger-tint` fill with `--pw-danger-tint-fg` text and icon, the pair 2.5 checks.
  - Disabled items: `aria-disabled`, `--pw-text-disabled`, no highlight on hover, the reason in a [tooltip](#tooltips), on hover and when the arrows reach the item, which it describes (`aria-describedby`). The arrows still reach them, and activating one does nothing and keeps the menu open.
- **Separator:** `role="separator"`, 1 px `--pw-border`, 4 px above and below.
- **Radio group** (W42): a `role="group"` named by its title, which shows above its options in label type (s 13/20, 500, `--pw-text-muted`, padding 6 px 8 px 4 px) and is `aria-hidden`, so it's heard once, as the group's name. Each option is a `role="menuitemradio"` item, `aria-checked`, named by its label (`aria-labelledby`) and, when it has one, described by its line (`aria-describedby`, s 13/20, `--pw-text-muted`, under the label, wrapping). The chosen option has a 16 px `checked` mark in the icon's place and its label at 500; the others keep the icon's room. Items and options highlight alike, and the arrows go through both.
- **Semantics:** a `<button aria-haspopup="menu" aria-expanded aria-controls>` (ghost md icon button, or sm for Sort, `aria-label` and the same tooltip) opening `role="menu"`, named like the button, with `role="menuitem"` items, each `tabindex="-1"`.
  - Opening, by a click, Enter or Space, focuses the chosen option of a radio group, or else the first item, without scrolling the page. The button's tooltip closes as the menu opens.
  - ↑/↓ move, wrapping at the ends; Home and End jump; Enter or Space activates; Escape and Tab close. ↑/↓ on the closed button don't open it, so the session view's header can use them.
  - Focus returns to the button on close, without opening its tooltip, which would only be one more thing for the next Escape. An item runs after that, so one that opens something, such as a confirmation, can move focus on from there. Choosing a radio option closes the menu the same way, then calls its change, only when the choice changed. Tab goes on from the button to the next control.
  - A press outside closes it, leaving focus where the press puts it. Escape is handled in the menu, so nothing behind it closes too, and it closes a disabled item's tooltip with the menu.
  - A [single-key shortcut](#62-keyboard-map) that moves focus elsewhere closes it first (`closeMenus()`), putting focus back on its button as Escape would, so a dialog the shortcut opens gives focus back there. One with nowhere to go, such as `j` on the last session, leaves it open.

### Preferences

The header's dialog of settings, a section for each area they affect (W59; Phil, 2026-10-23: "I think the preferences pane should be a dialog with sections covering the area that's being configured."). It replaced W42's View preferences, a header menu (Phil, 2026-10-21: "some sort of view preferences?") that had grown to two radio groups, about 440 px tall, and no longer fitted a short window (W54). It holds only settings that have no control of their own (W62; Phil, 2026-10-23: "I don't think we should duplicate settings that already have their own standalone buttons, such as the keyboard shortcuts and the light/dark preference."): the single-key shortcuts are the [keyboard shortcuts dialog](#keyboard-shortcuts-dialog)'s off switch, and the theme is the header's [theme switch](#theme-switch), which W59 had repeated here as Keyboard and Appearance sections. Sort stays in the [session list](#session-list)'s header and the view's width on the [divider](#session-view): both are view controls, used where they act.

- **Where:** in the [header](#header)'s right side, after the theme switch and before the keyboard shortcuts button, from the first render. At 600 px and narrower it wraps with the rest of the right side.
- **The button:** a ghost md `preferences` (tune) [icon button](#icon-buttons), named "Preferences" by its tooltip and `aria-label`, with `aria-haspopup="dialog"`. It has no key of its own.
- **The dialog:** `PreferencesDialog` (`web/src/components/Preferences.tsx`), a [dialog](#dialogs) with `size="md"` (`--pw-dialog-md`, 624 px), titled "Preferences", with the subtitle "Each change applies at once, and this browser remembers it." and no footer.
  - **Width** (W62; Phil, 2026-10-23: "The preferences dialog should definitely be wider. A lot of the text is running onto a second or third line when it really isn't needed."): of the three dialog widths, 624 px is the smallest that puts every option's line on one line but one. Measured in Chrome, the longest that fits, Every repo it worked in's line, is about 434 px, so the card needs at least 488 px: the body's padding, the radio and its gap take 54 px. When you open it's line, two sentences of about 733 px, takes two: one line would need the 840 px card, which makes a long line to read and covers the repo list below 1,320 px. At 1,200 and 1,440 px one of the seven lines wraps, where six did at 408 px, and the subtitle fits on one line too.
  - **Never over the repo list:** from 900 px, where the repo list is a column, the card is at most the window less `--pw-sidebar-w` on each side, `min(var(--pw-dialog-md), 100%, 100vw - 2 * var(--pw-sidebar-w))`: 420 px at 900 px, and 624 px from 1,104 px. Below 900 px, where the repo list is a drawer, it's the window less its 16 px margins, up to 624 px. A media query, the sidebar row's in [2.12](#212-breakpoints-and-widths), as for other components that fill the window.
  - **No Save button:** each choice applies as it's made, as the menu's did, and the page behind shows it at once: the backdrop is translucent, and from 900 px the card leaves the repo list in sight beside it, so a new grouping shows as it's chosen. Every setting is cheap to change back, and a Save would add a step and a way to lose a choice. The cost: the arrows choose as they move, so stepping through Group sessions by regroups at each step, and can replace the selection on the way (see Switching, below).
  - **Sections,** in the page's order, left to right. Each is a `<section>` named by its `<h3>` (m 14/20, 600), after a 1 px `--pw-border` line and 16 px, with 12 px to its first setting and 16 px between its settings:
    - **Repo list:** Group sessions by. Named for the repo list, whose groups, counts and root tabs' badges it decides, rather than the session list, which only shows the group selected there.
    - **Session view:** Open running background sessions on, then The terminal takes the keyboard (W57).
  - **Settings:** each a [radio group](#inputs-textareas-and-selects), its legend the setting's name, each option with one line saying what it does.
  - **No pointer** to where the single-key shortcuts and the theme are set: their controls, the theme switch and the keyboard shortcuts button, sit either side of Preferences in the header.
- **Group sessions by** (W42), three:
  - **Main repo,** the default: "A session started in a root goes under the repo it changed most."
  - **Where it started:** "Each session stays under the repo or directory it started in."
  - **Every repo it worked in:** "A session shows under every repo it worked in, so counts can overlap."
  - What each mode lists where is in [Repo list](#repo-list), and its counts in [Repo list items](#repo-list-items).
- **Open running background sessions on** (W54), whose legend reads on into each option, "… on Terminal", the tabs' own names:
  - **Terminal,** the default: "The session attaches as its view opens, so its terminal is ready to use." It says the terminal is ready, not that it takes the keyboard, which is the next setting's (W57); until W59 it ended "so you can type to it".
  - **Conversation:** "The session attaches only once you open its Terminal tab."
  - It's about running sessions alone: a finished one opens on Conversation either way, since attaching restarts it. What each opens on, and when, is in [Session view: header, tabs and footer](#session-view-header-tabs-and-footer).
- **The terminal takes the keyboard** (W57), whose legend reads on into each option, "… when you open it", W57's words:
  - **When you open it,** the default: "Right after you open the session or its Terminal tab with a click or Enter. Never after a reload, the back button or j and k."
  - **Never:** "Click the terminal, or Tab to it, to type to the session."
  - The rule, and why there's no "always", are in [Session view: header, tabs and footer](#session-view-header-tabs-and-footer). The Dashboard holds the one value, which the dialog sets and the views read at each attach.
- **Keyboard and mouse:**
  - A click, Enter or Space on the button opens it, with focus on Group sessions by's choice, the dialog's first field.
  - Each radio group is one Tab stop, its choice. Tab and Shift + Tab go from group to group, then Close, and round, never out of the dialog. Within a group ↑ and ↓ (or ← and →) choose the previous or next option, as the browser's radios do, and the choice applies at once. A click on an option or its label chooses it too.
  - Escape, Close, or a click on the backdrop closes it, with focus back on the button and its tooltip shut. While it's open, the single-key shortcuts do nothing, as with any dialog.
- **Short windows:** the card is at most the window less 96 px tall, and its body scrolls under its header: at 375 × 540 the body shows the Repo list section and Session view's heading, about half of what it holds, and Tab and the arrows scroll each choice into view.
- **Instant:** the page groups the snapshot itself (`web/src/groupBy.ts`), so a switch asks the server nothing, and each snapshot that follows is grouped the same way. The server still lists each session where it started, and names the root each worked-in repo sits under (`WorkedIn.root`), so the page can build a group for a repo the snapshot has none for.
- **What every mode keeps:** Needs you and All sessions list each session once, each row naming the group it's listed under; the filter, which finds a session by any repo it worked in; the session view's line 3; Sort; hidden groups, by key; the [root tabs](#root-tabs), each showing its root's groups in the mode, its badge counting each session once; and a `?session=` link, which selects the group the session is listed under.
- **Switching Group sessions by:**
  - The selected group stays selected when the new mode lists it, as a repo does in every mode.
  - When it doesn't, as a group the page built for Main repo doesn't in Where it started, All sessions in the same root tab is selected instead, replacing the URL's history entry rather than pushing one, and a [toast](#toasts), above the dialog, says so: "Selected All sessions: *group* has no sessions when grouped by *mode*." (for example "… grouped by where it started.").
  - Another root tab's selection that the new mode doesn't list is replaced the same way, without a toast, for when that tab is back.
  - Focus stays on the choice in the dialog, never the page, and goes back to the Preferences button when the dialog closes. An open session view stays open, on the same session, whichever group or tab it moves to.
- **The session view's settings** change no open view's tab: Open running background sessions on is for the views that open after the choice. The terminal takes the keyboard applies from the next attach, as the view reads it then.
- **Storage:** unchanged by W59 and W62. Each setting keeps its own key and its own reading of a bad value, and a choice that can't be stored lasts until the page reloads.
  - Group sessions by: `pitwall.group-by.v1`, holding the mode alone, `main-repo`, `where-started` or `every-repo`. Missing or throwing storage, or any other value, gives Main repo, as `pitwall.finished.v1` falls back.
  - Open running background sessions on: `pitwall.background-tab.v1`, `terminal` or `conversation` (`web/src/backgroundTab.ts`); anything else gives Terminal.
  - The terminal takes the keyboard: `pitwall.terminal-focus.v1`, `after-open` or `never` (`web/src/terminalFocus.ts`); anything else gives `after-open`.
  - Storage is per origin, so a pitwall on a fallback port starts with every default.

### Toasts

- **Component:** `ToastProvider` and `useToast()` (`web/src/components/Toast.tsx`). The Dashboard keeps the stack inside the app, from its first render.
- **Placement:** a stack at the bottom right, 24 px from the edges (16 px and full width when the app is 600 px wide or narrower), newest at the bottom, 12 px apart, at most three (the oldest goes first), `--pw-z-toast`. Only the toasts take the pointer, not the stack around them.
- **Card:** `--pw-surface-overlay`, `--pw-shadow-3`, `--pw-radius-md`, `--pw-toast-w` wide, padding 8 px.
  - A 28 px icon tile (`--pw-<tone>-tint` with `inset 0 0 0 1px var(--pw-<tone>-border)`, `--pw-radius-sm`, a 16 px icon in `--pw-<tone>-tint-fg`): `success`, `info`, or `error` on the danger tokens.
  - The message (m 14/20, 500), 12 px after the tile, as text.
  - A ghost sm `close` button, named "Dismiss" by its tooltip. Focus it had goes to the next toast's Dismiss, or the one before, or the session list's heading (the view's, while the view covers the list).
- **Timing:**
  - Success and info toasts dismiss after `--pw-toast-timeout` (4 s), or after `--pw-toast-action-timeout` (10 s) with an action, below. The time stops while the pointer is over the stack or focus is inside it, and goes on from where it was.
  - Error toasts stay until dismissed.
  - The same message again replaces the toast that says it, so it's announced again without stacking. So does a toast with the same key, about the same thing, whatever it says: "*name* is listed now." replaces "Started *name*." (W63).
- **An action** (W63): at most one, an outline sm [button](#buttons) between the message and Dismiss, labelled with its verb, such as Open, and described by the message (`aria-describedby`), which says what it acts on. Using it takes the toast away, and the action says where focus goes. Today there are two: Open, on a started session that didn't open because you were in the middle of something (see [Dialogs](#dialogs), the New session dialog's Started), and Undo, on a session marked [not needed now](#not-needed-now) (W88). Each is optional, never a decision: the session's row opens it too, and its row's toggle, or its view's Put back in Needs you, undoes the mark.
  - **It goes by itself, after 10 s** (coordinator, W63's review). That's long enough to read the toast, look up from the draft you were writing and reach Open with the pointer, which the 4 s of a toast with nothing to press isn't; and it stops while the toast is hovered or has focus, so moving to it, or Tabbing to it, keeps it. A toast that stayed until it was dismissed would sit over what you were in the middle of: from 1,200 px the session view's Send, and at 600 px and narrower its whole footer.
  - **The time limit keeps you from nothing** (WCAG 2.2.1, Timing Adjustable): an action is only ever a shortcut. Open's lasting way in is the session's row, listed under its group and in All sessions in its tab for as long as the session is listed, which opens it as Open does. So nothing is lost when the toast goes, and there's no time limit to adjust. This rests on the row, not on 2.2.1's essential exception, which is for a limit that can't be lifted without spoiling the activity.
- **Live region:** the stack is an `aria-live="polite"` region that always exists in the DOM, so a toast's text arrives in a region that was already there and is announced; error toasts use `role="alert"`.
- **Use them for** results the user isn't looking at: "Copied", "Couldn't copy; the text is selected" (an error), "Stopped. Its conversation is kept.", "Started *name*. Its view opens when it shows up in the list.", "*name* is listed now. It didn't open, so you keep your place." (info, with Open), "Removed *name*", a Stop or Remove's result, a refusal included, when its view has gone (see [Inline confirmation](#inline-confirmation)), "Ended *name*. Its terminal is back at the shell." and "Sent *name* the signal to end. It hadn't exited after 5 seconds, so it may still be finishing." (info) after End session, and its result when its view has gone (W90), "Resumed *name* in the background." for an [ended session](#ended-sessions) Claude Code resumed, and a refused resume's result when its view has gone (W67), "Opened *name*'s directory in *editor*." and "Couldn't open *name*'s directory in *editor*. *reason*" (an error) after Open in an editor (W72), hiding a group from the repo list or showing it again, saying where it went (see [Session list](#session-list)), a switch of [Group sessions by](#preferences) that selects All sessions in place of a group the new mode doesn't list, and "Marked *name* not needed now. It comes back to Needs you when what it needs changes." (with Undo) and "Put *name* back in Needs you." (W88, see [Not needed now](#not-needed-now)), and Refresh's answers in the Pull requests view: "pitwall checked GitHub moments ago. Refresh again in 12 seconds." (info), "Pull requests are off: …" (info) and "Couldn't refresh your pull requests (HTTP 502). Try again in a moment." (an error) (W95, see [Pull requests](#pull-requests)).
- **Don't use them for** form errors, the relay's delivery result, or anything that needs a decision. Those stay inline.

### Tooltips

- **Component:** `Tooltip` (`web/src/components/Tooltip.tsx`), around its trigger, the one child, which takes its handlers and ARIA. `InfoTip` is an info button with one.
- **Card:** `--pw-surface-overlay`, `--pw-shadow-1`, `--pw-radius-md`, padding 6 px 8 px, meta size (13/20), `--pw-text`, at most 344 px wide, `--pw-z-tooltip`, 6 px from its trigger. Line breaks in its text are kept.
  - It sits above the trigger by default, centred on it and kept 8 px inside the window, and flips below when there's no room above.
  - It's rendered into `document.body`, fixed to the window, so no scrolling pane, overflow or stacking context cuts it off, and it follows its trigger as anything scrolls.
  - Key caps go at the end, 8 px after the text.
  - While the single-key shortcuts are off, a single character key's caps, such as `n` or `?`, are left out. Esc, F6, ↵, the arrows and ⌘ combinations still show. New session's tooltip would then only repeat its label, so it has none.
- **Opens** on hover after `--pw-delay-tooltip`, or at once when another is open or has just closed, and on keyboard focus (`:focus-visible`) at once. Not on a click's focus, nor when focus is put back on the trigger as something closes (`focusQuietly`). Touch doesn't hover, so a tap doesn't open it.
- **Closes** on Escape, blur, pointer leave and a press on its trigger, at once. It stays while the pointer is over the tooltip itself (WCAG 1.4.13): the card's hit area reaches back over the 6 px gap.
  - Escape is the nearest layer (6.2): it closes the tooltip and goes no further. Inside a menu, Escape closes the menu and its tooltip together; inside the terminal, the terminal gets it.
- **Semantics:**
  - For an icon button, the tooltip is the trigger's `aria-label`, so its name and its tooltip match, and the tooltip itself is hidden from assistive technology.
  - Otherwise the trigger's `aria-describedby` points at the tooltip, which is always in the DOM, hidden while closed, so the description is there before it shows. A disabled control says why this way: Send, the Terminal tab, a menu item.
  - On an element that's never focusable, such as a badge, a title or a time, it's linked to nothing and opens on hover only.
- **Replace `title` attributes** with this component. On an element that's never focusable it can only repeat what's in the DOM, such as a title cut short, or explain a label, such as Stale. A tooltip that only repeats text shows only when that text is cut short. No `title` is left in the components, and `titles.test.tsx` and the `#uikit` gallery's test check that none comes back.
- **Info buttons** (`InfoTip`): a ghost sm `info` icon button, so Tab reaches it, named by its explanation, which is its tooltip. A click or a tap pins it open, since touch screens can't hover; a second click, a press elsewhere, blur or Escape hides it.
- **Never the only place** for essential information; touch users can't hover.

### Skeletons and spinners

- **Component:** `web/src/components/Waiting.tsx`: `useWaiting()`, which says when `--pw-delay-spinner` and `--pw-delay-long` have passed, read from the element the waiting state is in, the skeletons, and `WaitingStatus`.
- **Skeleton bar:** 12 px tall, `--pw-surface-sunken`, `--pw-radius-sm`, pulsing (2.13). On `--pw-bg`, the sidebar's fill, `--pw-surface-strong` instead, since a sunken bar barely shows there.
- **Skeleton row:** a [session row](#session-rows)'s box and height: padding 8 px 16 px, a 1 px `--pw-border` line between rows, and two 20 px lines 2 px apart, each with a bar centred in it: identity 40 % and preview 70 % of the width, for the row's two lines.
- **Skeleton item:** a [repo list item](#repo-list-items)'s box and height (32 px, padding 6 px 8 px), with one bar for the label, at 70 %, 50 %, 80 % and 45 % for the four.
- **On first connect,** before the first snapshot: below the repo list's two views and their divider, four skeleton items; in the session list, three skeleton rows. Both are `aria-hidden="true"`, and a visually hidden `role="status"` in the rows' area says "Loading sessions". The session view's waiting state has its own (see [Session view](#session-view)).
- **Spinner:** `Spinner` (`web/src/components/Spinner.tsx`), a 12 px (inline) or 16 px (in a button) ring: a 2 px conic gradient from transparent to `--pw-info-fg`, or to the text colour of the badge or button it's in (2.1; `--pw-info-fg` on a primary button's accent fill would barely show), turning 0.8 s per turn. It's `aria-hidden`; the busy element carries `aria-busy` or a status message. The conversation's working line shows it while a session works, with a steady status dot in its place under reduced motion (W102; see [Conversation](#conversation)).
- **Waiting:** both wait `--pw-delay-spinner` (500 ms) before showing. After `--pw-delay-long` (10 s), add a meta line saying what's slow, a status line under the skeletons:
  - before the first snapshot, "Still waiting for `claude agents`…", since the server sends it after the index's first poll; or "Still trying to reach pitwall…" once the connection has dropped (Reconnecting). The session list and the session view's waiting state say the same;
  - loading the conversation, "Still waiting for the transcript…".
- **The status** is a `role="status"` region that's there from the start, empty, so what it comes to say is announced, and a fast answer announces nothing: the visually hidden label ("Loading sessions") after `--pw-delay-spinner`, then the long-wait line after `--pw-delay-long`.
- **Long waits for pitwall's own work** (connecting, loading the conversation) use a status line, not an overlay: meta (s 13/20), `--pw-text-muted`, centred, 12 px above and below, `role="status"`.

### Empty states

- **Component:** `EmptyState` (`web/src/components/EmptyState.tsx`), with `icon`, `title`, `sentence`, `actions` and, for the session view's unlisted state, `heading`, which makes the title the region's `<h2>`. Otherwise the title is a paragraph, so the outline in [6.1](#61-rules) is unchanged.
- **Anatomy:** centred in its pane, both ways, at most `--pw-dialog-sm` (408 px, a small dialog's width) wide, with at least 24 px 16 px around it; text centred and wrapping anywhere.
  1. A 24 px icon in `--pw-text-subtle`, `aria-hidden`.
  2. The title (l 16/24, 600), 8 px below.
  3. One sentence (m 14/20, `--pw-text-muted`), 4 px below.
  4. One action, on `Button`, 16 px below; two, 8 px apart and wrapping, where the table gives two.
- **No illustrations.**
- **Names, roots and filter text** are text, never markup (6.1 rule 16).
- **Focus after an action,** since the action's button goes with the empty state: Clear filters and Search all sessions put it in the filter field; Show all sessions on the session list's heading. Unstarring the last row in Starred puts it on the heading too. New session opens its dialog, which returns focus to it; once the session it started is listed, the empty state goes and its button with it, so focus moves to the new session view's heading.

| Where | Icon | Title | Sentence | Action |
|---|---|---|---|---|
| No sessions under the roots | `terminal` | "No Claude Code sessions under *roots*" | "Start one here, or start Claude Code in any terminal under these directories and it appears here." | primary "New session" (`add`), which opens the New session dialog |
| The filter matches nothing | `search` | "No sessions match" | "Nothing in *selection* matches "*text*" with these filters." Without a chip on, it ends at "*text*"; with no text, "Nothing in *selection* matches these filters." | outline "Clear filters", which clears the text and the chips; in a group with text in the field, outline "Search all sessions" too, which selects All sessions and keeps the text |
| A selected group has left the snapshot | `directory` | "No sessions in *group* now" | "Its sessions are no longer listed under these roots." In Where it started a root's own group lists every session started in the root (W39), so it empties only when they've gone. | outline "Show all sessions", which selects All sessions |
| A selected root's own group the [Group sessions by](#preferences) mode empties | `directory` | "No sessions in *group* now" | "Its sessions are listed under the repos they changed most, as Preferences groups them." In Every repo it worked in, "… the repos they worked in, …". The snapshot still has the group: every session started there worked in repos (W42). | outline "Show all sessions" |
| Needs you, and nothing does | `success` | "Nothing needs you right now" | "Sessions that are waiting for you, or asked you something, show here." | outline "Show all sessions" |
| Starred, and nothing under the root is (W53) | `star` | "No starred sessions" | "Star a session from its row or its view to keep it here." Also when the starred sessions are none of the snapshot's, as after they've been removed | outline "Show all sessions", where the rows and their stars are |
| Any of the above with older [ended sessions](#ended-sessions) behind Show older that it would list (W67): all of a root's sessions, a group's, Starred's or what the filter finds | as the state | as the state | as the state | its actions, then outline "Show *n* older sessions", which turns Show older on and opens the Finished section, with focus on its Hide older sessions |
| The session view column, nothing open | `conversation` | "Select a session" | "Its conversation, terminal and actions open here." | none |
| The same, with Pull requests selected (W95, W106) | `info` | "Select a session or pull request" | "A session's conversation and terminal, or a pull request's checks, review and sessions, open here." | none |
| The Pull requests view's states (W95, W106) | | | See [Pull requests](#pull-requests), States | |
| The session view, unlisted (see [Session view](#session-view)) | `info` | "This session isn't listed under these roots", the view's heading | "pitwall lists no session with the id `<id>` under *roots*; it may have been removed, or run outside these roots." | none; Close is in the header |
| Conversation, nothing yet | | | "Nothing to show yet." (status line) | none |
| Sub-agents, none (W77), for a tab shown while its list came back empty | `subagents` | "No sub-agents" | "Sub-agents this session starts show here, with their state and transcripts." | none |
| A sub-agent's transcript, none | | | "No transcript for this sub-agent." (status line) | none |
| No transcript | | | "No transcript for this session." (status line) | none |

### Page notices

What shows in place of the dashboard when the tab can't connect (W40).

- **Component:** `Notice` (`web/src/components/Notice.tsx`), with `lead` and `detail`. `NoTokenNotice` and `TokenRejectedNotice` are built on it.
- **Anatomy:** a `<main>`, at most 560 px wide, 15 % of the window down, with 16 px side padding, on `--pw-bg`:
  1. The wordmark, the page's `<h1>`.
  2. The lead: one sentence saying what happened, l 16/24, `--pw-text`.
  3. The detail, 4 px below: what to do, m 14/20, `--pw-text-muted`. Literal values, such as `PITWALL_TOKEN`, are inline code (2.7).
- **Everything is text** (6.1 rule 16). No focus is moved: each notice is the whole page, with nothing to press.

| Notice | Lead | Detail |
|---|---|---|
| No token: opened without one, or a browser restart lost it | "This tab has no token for pitwall." | "In this tab, open the link pitwall printed when it started, or, if `PITWALL_TOKEN` is set, add `#token=` and that token to the address. On a single-user machine, a fixed `PITWALL_TOKEN` keeps a pinned tab working when pitwall restarts." |
| Token rejected: the WebSocket closed with 4401 | "pitwall rejected this tab's token." | "Unless `PITWALL_TOKEN` is set, each run of pitwall has its own token, so this usually follows a restart. In this tab, open the link pitwall printed when it started, or, if `PITWALL_TOKEN` is set, add `#token=` and that token to the address." |

- **Both ways back, always** (W51): the page can't tell before it authenticates whether this run's token is per run or fixed, so each notice gives the way for each. The rejected notice leaves out the pinned-tab sentence, since its first sentence already names `PITWALL_TOKEN`.
- **The link** is the URL the CLI prints when it starts, with a per-run token in its fragment, which the page takes out of the address bar ([Session view](#session-view)). Pasted into the tab, it connects it, whether the browser loads the page again or only changes its fragment (`token.ts` reads a new fragment either way). With a fixed token, the CLI prints the address alone; `#token=` and the token, added to it by hand, connect the tab the same way.
- **A fixed token:** with `PITWALL_TOKEN` set, every run that uses it has the same token, so a tab that holds it reconnects by itself after a restart, on the same port. The CLI and `npm run dev` say at start that the token is fixed, and to use this only on a single-user machine or for development. Neither ever prints it (W51): it would outlive the run in scrollback, logs and agents' transcripts.
- **The connection badge's** Token rejected state shows only in the gallery: in the app, the notice replaces the page.

### Key caps

- **Component:** `KeyCaps` (`web/src/components/KeyCaps.tsx`), which takes the keys and their text alternative.
- **Shape:** a `<kbd>`, 20 px tall, min-width 20 px, padding 0 5 px, `--pw-radius-xs`, label style (xs 12/20, 500), `--pw-text-muted` on `--pw-surface`, `--pw-shadow-control`, plus `inset 0 -1px 0 var(--pw-border-strong)`.
- **Combinations:** keys in a combination are 2 px apart, with no "+" between them.
- **Platform:** ⌘ on macOS, "Ctrl" elsewhere (from `navigator.userAgentData?.platform ?? navigator.platform`); ↵ for Enter, ↑ ↓ ← → for the arrows, "Esc" for Escape.
- **Screen readers:** inside tooltips and help lines, give the combination a text alternative ("Command Enter") with a visually hidden span.

### Copy

- **Every copy goes through `copy.ts`:** `useCopy()` writes to the clipboard `ClipboardContext` gives, the browser's by default, and the `#uikit` gallery gives a stub.
- **Copy buttons:** `CopyButton` (`web/src/components/CopyButton.tsx`), a ghost sm icon button (`copy`), named by its tooltip with what it copies ("Copy attach command", "Copy session ID", "Copy path", "Copy command", "Copy trust command" on a refused resume's command, and "Copy code" on a code block in a message).
  - After a successful copy, the icon becomes `copied` for `--pw-copied-timeout` (2 s) and a "Copied" toast appears.
  - If the clipboard refuses, select the text on screen and show "Couldn't copy; the text is selected" as the button's tooltip, which then describes it, until the next copy, and in an error toast.
  - The actions menu's Copy session ID, Copy attach command and Copy resume command, and an ended session's Copy command in its footer (W67), give the same toasts. Their text isn't on screen, so a refusal shows it under the session view's line 2, selected.
- **Commands to copy** (W87, from W85's security review): a command pitwall builds for you to paste into a shell puts a path in single quotes, and isn't offered at all for a path with a `'` or `\`, or a control or bidi character. Inside single quotes zsh and bash take every character as it is, but fish reads `\'` as a quote and `\\` as one backslash, so POSIX's `'\''` would end fish's word early and run the rest of the path as a command there. Without those two, single-quoted text is one word in all of them. Where a command would have been, the page says there's none and why. It applies to Copy command and Copy resume command (`resumeCommand()`) and to spawn and resume's trust command (`shellQuote()`); Copy attach command takes a short id of letters, digits, `_` and `-` only, and Copy session ID and Copy path copy text, not a command.
- **Command chips:** `CopyCommand`: code style, `--pw-surface-sunken`, `--pw-radius-sm`, padding 0 6 px, `user-select: all`, with a middle ellipsis and the full command in a tooltip when it's cut. A copy button follows.
- **Write inside the click handler** (Safari rejects a deferred write), and fall back to selecting the text.

### Timestamps

- **Component:** `Timestamp` (`web/src/components/Timestamp.tsx`).
- **Relative, in rows and meta:** "just now" under 5 s, then "42s ago", "5m ago", "3h ago" (under 48 hours), "2d ago".
  - Meta size, `--pw-text-subtle`, tabular, in `<time datetime>`, with the absolute time in a tooltip, on hover: times aren't focusable.
- **The header's "updated 7s ago"** counts in seconds below a minute, so it visibly ticks.
- **A fixed slot beside other content** (Phil, 2026-10-27: "the space for the timing should be fixed so the label doesn't move left/right"): a relative time on a line with other content, a row's line 1 or the header's, sits in a slot sized for its widest short form, with the time right-aligned in it, so what's beside it stays put between rows and as it ticks. A row's slot is `min-width: 7ch`, for "59m ago" (about 6.7ch in Inter; "just now", "47h ago" and "30d ago" are narrower), and the header's `13.5ch`, for "updated 59m ago". A rare longer one, such as "120d ago", grows its slot rather than being cut. A time inside a sentence, or the session view's "Active 5m ago" on its wrapping line 2, has no slot.
- **Absolute:** the user's locale, with seconds: "20 Oct 2026, 11:06:14". In the conversation's speaker line, only the time of day, in the user's locale ("11:06", or "11:06 AM"), with the full instant in the `datetime` and the absolute date and time in its tooltip (`format="time"`). It never changes, so it doesn't subscribe to the clock.
- **Updates:** relative times update every second from one shared clock (`web/src/clock.ts`): one interval for the page, running only while a time is on screen. Each timestamp re-renders itself on the tick, so nothing else does. They're never in a live region.

### Terminal

The Terminal tab's panel, for background sessions: xterm.js over `claude attach`. `SessionTerminal` (`web/src/components/Terminal.tsx`) draws the bar, the notices and the screen; `web/src/xterm.ts` makes the terminal.

- **Bar** (36 px, padding 4 px 0, 8 px gaps). When the panel is too narrow for the badge and the buttons, the buttons go to a line of their own, still at the right; the hint's text wraps before that happens.
  - A status [badge](#badges) (`Badge`), inside a `role="status"` region so each change is announced, as the connection badge's is: "Attaching…" (subtle neutral, spinner), "Attached" (subtle success, dot), "Detached" (subtle neutral), "Not running" (outline, while the restart confirmation asks).
  - A meta hint, an F6 [key cap](#key-caps) then "to leave the terminal", in `--pw-text-subtle`. It stays after the attach ends, since the screen still takes every key. It describes xterm.js's textarea, which is what has focus in the terminal (`aria-describedby`, set once xterm.js has opened), so a screen reader there hears how to leave.
    - Shift+↵ isn't in it: a second key would crowd the bar at 375 px. The [shortcuts dialog](#keyboard-shortcuts-dialog) lists it (W41).
  - **How to type to it** (W57): while the terminal is attached and the screen doesn't have focus, as after a reload, a step or F6, the hint is "Click the terminal, or Tab to it, to type to the session" instead, in the same style. "Tab to it" rather than "press Tab", since one Tab from the page doesn't get there. While attaching, and once the attach has ended, it's F6's, so a terminal about to take focus doesn't flash it, and an ended one doesn't invite typing.
    - **One place for both** (`.attach-hints`): the two share a grid cell, the one that doesn't apply `visibility: hidden` but keeping its room, so the bar is the same size whichever shows and focus moving in or out of the screen never resizes the session's terminal. The cell takes the room between the badge and the buttons, and its text wraps there rather than pushing them down: at 375 px the bar is 48 px tall, two lines of hint beside the badge and Detach; from 900 px it's one line, 36 px. Checked at 375, 900, 1,200 and 1,440 px in both themes.
    - **Screen readers:** it's plain text, never a live region, so opening a view announces only the badge's status, as before. It's read in place, and while the terminal is attached it describes the Terminal tab (`aria-describedby`), so a screen reader on the tab, after F6 say, hears how to get back in.
  - At the right, on `Button`: ghost sm "Attach again" (`retry`) once it has ended, then ghost sm "Detach", which reads "Back to the conversation" once it has ended. Both of those go back to Conversation (see [Session view](#session-view-header-tabs-and-footer)).
- **Focus:** once attached, the terminal takes focus only right after you asked for it in this page, with a click or Enter on the session's row, the Terminal tab, Attach again or Restart and attach, within 5 s, and only while focus is still in the session view (W57); with the setting on `never`, not even then. Opened from the URL, a reload, back or forward, a root tab or a step, it leaves focus where it is, and the bar says how to type to it. A terminal the view opened on by stepping (`j`, `k`, ↑, ↓) waits `--pw-delay-attach` before it attaches, saying "Attaching…"; Attach again, and a confirmed restart, attach at once (see [Session view](#session-view-header-tabs-and-footer)).
- **Screen:** fills the rest of the panel; `--pw-term-bg`, `--pw-radius-md`, padding 6 px, and a 1 px `--pw-border-strong` ring outside it (`box-shadow: 0 0 0 1px`). In the dark theme `--pw-term-bg` is the page's own `--pw-bg`, a shade darker than the view's `--pw-surface`, and the ring is what sets the screen apart; in the light theme the fill does. The ring is decorative (2.5), and ligatures are off (2.7).
  - xterm options: `fontFamily` from `--pw-font-mono`, `fontSize` 13, `fontWeightBold` 500, `cursorBlink` false and `cursorStyle` block (see the cursor, below), `scrollback` 5000, `theme` built from the `--pw-term-*` tokens (background, foreground, cursor, selectionBackground, red, green, yellow, blue; xterm's defaults for the rest), and links limited to http and https (`links.ts`, which asks first, naming the whole URL). Each is read with `getComputedStyle` when a terminal is created, and a token that isn't set is left to xterm's default. Nothing in the terminal's code names a colour or a font family; `web/src/xterm.test.tsx` checks.
  - **The font:** xterm.js measures its cells as it opens, so the terminal opens only once JetBrains Mono's 400 and 500 faces have loaded (`document.fonts.load()` with `--pw-font-mono`), or after 3 s, whichever is first. Otherwise its cells would be sized for the fallback font. A font that arrives after the 3 s makes it measure them again: its `fontFamily` is set to the same list with a trailing space, since xterm.js measures only when that string changes; then it fits the panel and sends the session the new size (W31).
  - **Bold** is drawn with the 500 face (`fontWeightBold: 500`), the heaviest one bundled (2.14). Asking for 700, xterm.js's default, would have the browser synthesise a heavier face from the 500 one.
  - **The cursor is steady** (W45), whatever the program sends: a steady cursor is less distracting, and WCAG 2.2.2 asks that blinking can be stopped. xterm.js 6.0.0 turns the blink on for DECSCUSR 1, 3 and 5 (`CSI Ps SP q`, and any odd value above 6), and for DECSET 12 (`CSI ? 12 h`), so `keepCursorSteady()` (`web/src/xterm.ts`) holds both off with xterm.js's public parser hooks.
    - DECSCUSR keeps the shape it asks for, block, underline or bar, without the blink; 0 puts the block back, and a value it doesn't define changes nothing.
    - DECSET 12 is turned off again before the cursor is drawn, and the other modes in the same sequence, such as 25 in `CSI ? 12 ; 25 h`, still apply.
    - A full or soft reset (RIS, DECSTR) puts the block back.
    - Unchanged: its colour (`--pw-term-cursor`), the outline it has while the terminal doesn't have focus, and focus itself.
  - **The fit** (W74): the fit add-on keeps it sized to the panel, as many whole rows and columns as fit inside the 6 px padding, with the scrollbar's 14 px track kept clear at the right. The session is sent that size on attach and on every resize.
    - xterm.js opens in a box of its own, `.attach-terminal-fit`, which fills the screen's content box and has no padding. The padding, ring, radius and fill stay on `.attach-terminal`.
    - Why: the add-on takes its parent's computed height and width as the room it has, less only the terminal element's own padding, and the page's border-box sizing counts the parent's padding in them. Opened in `.attach-terminal` itself, it took 12 px more height and width than there was room for.
    - What that did: at 12 of every 17 panel heights (a row is 17 px) the last row, Claude Code's pinned footer, ran into the bottom padding, by up to 12 px, and at 6 of them it was cut off, by up to 6 px. At every width the last column ran under the scrollbar's track, by up to 12 px, and the track covers it once there's scrollback.
    - The app check's terminal part checks the last row and column at every window, and at five shorter heights.
- **Dark in both themes** for now, because Claude Code's interface is usually set to its dark theme and a light terminal behind it could be unreadable.
  - If it follows the page theme later, rebuild `theme` from the tokens on every theme change.
- **Keys:**
  - Every key goes to the terminal, Escape included (it interrupts Claude), so Escape never closes the view from here.
  - F6 moves focus out, to the Terminal tab, so the terminal isn't a keyboard trap (WCAG 2.1.2). The terminal stays open and attached, and the key never reaches the session: the screen takes it before xterm.js does. F6 with a modifier goes to the terminal like any other key.
  - Claude Code's documentation binds nothing to F6, or to any function key: its keybindings page names none among the keys a binding can use, and the interactive mode, terminal configuration, agent view (which covers `claude attach`), fullscreen and accessibility pages mention none (checked 2026-10-21). If that changes, pick another key and update this doc, 6.2 and the shortcuts dialog.
  - Shift+↵: a new line in Claude Code's prompt. Shift+Enter with no other modifier sends a line feed (`\n`, which is Ctrl+J) and nothing else: the screen takes it before xterm.js does, as it takes F6 (W41).
    - Why: xterm.js sends a carriage return for Enter with or without Shift, and that submits. Claude Code's terminal docs give Ctrl+J for a line break without submitting: "Both work in every terminal with no setup" (code.claude.com/docs/en/terminal-config, "Enter multiline prompts", read 2026-10-21).
    - Held down, it repeats as Enter does: a line feed for each keydown, the repeats included.
    - Unchanged: Enter's carriage return; Shift+Enter with Ctrl, Alt or ⌘, which goes to xterm.js like any other key; and every key while an input method composes (`isComposing`, or keyCode 229, which Safari gives the key that ends a composition), which xterm.js handles.
- **Notices** (ended, error): an inline [alert](#alerts-and-banners) (`Alert`) above the screen, its text plain (6.1 rule 16).
  - Neutral, `role="status"`, when `claude attach` ended cleanly, with exit code 0 or by a signal, as it does when you detach inside it: "claude attach ended.".
  - Danger, `role="alert"`, when it failed: a non-zero exit, the server refusing or failing ("Couldn't attach:" then the server's reason, in code style, as text: `Detail`), four sessions already attached, the proof refused, or the connection closing. The server's reason is kept apart from pitwall's own words, such as "Couldn't attach: the page couldn't open a connection to pitwall.", which have no code style.
  - `claude attach` is in code style wherever a notice names it ("`claude attach` ended.").
  - Attach again clears it and starts over with a new terminal and socket.

### Theme switch

- **Shape:** a 72 × 24 px track (three 24 px buttons), `--pw-surface-muted`, `inset 0 0 0 1px var(--pw-border-control)`, `--pw-radius-full`.
- **Options:** `theme-system`, `theme-light` and `theme-dark` icons, labelled "System theme", "Light theme" and "Dark theme".
- **Selected:** a `--pw-surface-overlay` circle with `--pw-shadow-control`, its icon in `--pw-text`. Unselected icons are `--pw-text-subtle`, turning `--pw-text` on hover.
- **Semantics:** `role="group"` with `aria-label="Theme"`; each option a button with `aria-pressed`.
- **The theme's one control:** W59 also put the choice in [Preferences](#preferences), as an Appearance section, and W62 took it out again, since Preferences doesn't repeat a setting that has a control of its own. One store holds it (`web/src/theme.ts`), so every switch on a page agrees.

### Keyboard shortcuts dialog

- **Component:** `ShortcutsDialog` (`web/src/components/ShortcutsDialog.tsx`), on `Dialog` with `size="sm"` (`--pw-dialog-sm`, 408 px), titled "Keyboard shortcuts". With nothing to submit, it has no footer; Close and Escape close it, and focus goes back to whatever opened it.
- **Opened** by `?` or the header's `keyboard` icon button.
- **The off switch** comes first, and takes focus as the dialog opens: a [checkbox](#inputs-textareas-and-selects), "Single-key shortcuts", that turns off `/`, `?`, `n`, `j`, `k` and `s` (WCAG 2.1.4, Character Key Shortcuts), with help text below it, indented to the label, linked with `aria-describedby`: "The keys under Anywhere, which are ignored while you type in a field. While they're off, the keyboard button in the header opens this dialog."
  - On by default. Stored in `localStorage` as `pitwall.shortcuts.v1`, `on` or `off`; anything else, nothing stored, or storage that's missing or throws reads as on, and a choice that can't be stored lasts until the page reloads.
  - One store holds it (`web/src/shortcuts.ts`), as the theme's does, so the checkbox, the filter field's key cap and every tooltip agree, and a change made in another tab arrives with the window's `storage` event.
  - While it's off, the Anywhere heading adds "Off" (meta, `--pw-text-muted`), and the rest of the map still works.
  - The setting's one control: W59 also put it in [Preferences](#preferences), as a Keyboard section, and W62 took it out again, since Preferences doesn't repeat a setting that has a control of its own. Here it's where the keys are listed, the discoverable switch WCAG 2.1.4 asks for, and the keyboard button still reaches it while they're off.
- **The map:** every row of [6.2](#62-keyboard-map), in five groups, each a `<section>` named by its `<h3>` (s 13/20, 600): Anywhere (the single-key shortcuts), Lists, Session view, Menus and dialogs, and Closing and moving.
  - Each row is a `<dl>` entry, divided by 1 px `--pw-border` lines, padding 6 px 0: what it does (m 14/20), saying where when the group doesn't, then its [key caps](#key-caps) at the right. When the dialog is too narrow for both, the caps wrap under the text, still at the right.
  - Alternatives are separated by " / " and sets of them by ", " (`--pw-text-subtle`), each read out as " or " and ", "; each combination's caps have their text alternative, such as "Command Enter".
  - ⌘ on Apple platforms and Ctrl elsewhere, as Key caps says.
  - `keyboardMap()` names each row by its Key and Where cells in 6.2, and `ShortcutsDialog.test.tsx` checks the dialog lists exactly the rows the table has.

---

## 5. Content

### Casing and style

- **Sentence case everywhere:** buttons, headings, tabs, menu items, badges, labels, alerts and toasts. Capitalise only names, such as Claude Code, and show a session's own name exactly as written.
- **"pitwall" is always lowercase,** even at the start of a sentence.
- **Commands and literal values** are in code style, exactly as typed: `claude --bg`, `/bg`, `claude agents --json --all`.
- **No capitals for emphasis** and no letter-spaced labels.
- **No em dashes in UI copy:** use a full stop, a colon or a semicolon.
- **The ellipsis character (…)** for progress ("Starting…") and for menu items that open more choices ("Another directory under a root…").
- **Contractions** are fine and preferred: "Couldn't", "isn't", "can't".

### Labels

- **Buttons:** a verb, or a verb and object: "Refresh", "Show 2 older pull requests" and "Hide older pull requests", "Clear filter", "Back to pull requests" (W95), "New session", "Start session", "Send", "Stop session", "Remove session", "Restart and attach", "Attach again", "Detach", "Copy", "Dismiss", "Try again", "Clear filters", "Load earlier", "Jump to latest", "Resume in background", "Copy command", "Show 3 older sessions" and "Hide older sessions" (W67), "Back to sub-agents" (W77), "Attach files" (W82), "Mark not needed now", "Put back in Needs you" and "Undo" (W88), "End session" and "End session anyway" (W90).
- **Cancel** is always "Cancel".
- **Confirmations:** the confirm button repeats the question's verb and object: "Stop this session?" → "Stop session".
- **Progress:** the -ing form with an ellipsis: "Starting…", "Sending…", "Stopping…", "Removing…", "Resuming…", "Attaching…", "Uploading…" (W82), "Loading the conversation…", "Loading the sub-agents…", "Loading earlier…", "Trying again…".
- **Counts:** digits with the noun, singular and plural handled: "1 session", "12 sessions", "1 needs you", "2 need you", "3 tool calls", "No tool calls", "1 sub-agent running", "2 sub-agents running", "2 of 5 sessions".
- **Paths:** home shortened to `~`, middle ellipsis on screen, the full path in a tooltip.
  - **Middle ellipsis:** the end of the path, from its last `/`, shows whole, and the text before it ends in "…" when there isn't room. A path with no `/` after its first character is cut at its end. Both parts stay in the DOM, so screen readers, find in page and copying get the whole path.
    - The start gives way first, down to its first four characters (or fewer, if it's shorter); only then does the end, which ends in "…" too. `MiddleEllipsis` builds it from two spans and flex-shrink factors, since CSS can only cut text at its end.

### Errors

- **Say what happened, then what to do.** "Couldn't load the conversation." and a Try again button: the action is a button (outline sm, `retry` icon, busy as "Trying again…"), not just words.
- **Use the real reason** when Claude Code or the server gives one, after pitwall's own sentence: "Couldn't stop the session. *message from Claude Code*". Show it as text, never as markup, in code style (`Detail`). When the server answered with a status and no reason, the status goes before the full stop instead: "Couldn't stop the session (HTTP 502)." (`couldNot()` in `web/src/format.ts`).
- **Say only what pitwall knows:** "May have reached the session. Check its conversation before sending again." rather than "Sent" or "Failed".
- **No blame, no "Oops", no stack traces,** no error codes on their own.
- **Keep what's on screen** when a refresh fails, and say it may be out of date, rather than emptying the view: "Couldn't refresh the conversation, so it may be out of date." A failed read is an error, never "nothing here".
- **The tone says what's left:** danger when the failure leaves nothing to show, warning when what's shown is kept, as "Couldn't list sessions" keeps the list.
- **Pattern:** "Couldn't *verb* *object*. *Reason or next step*."
- **Field errors** say how to fix it: "Type a model alias, or choose the default."

### Success

Past tense, short, and only when the result isn't already visible: "Copied", "Stopped. Its conversation is kept.", "Started *name*. Its view opens when it shows up in the list.", "Opened *name*'s directory in Cursor."

### Empty states

- **The title** says what's missing.
- **One sentence** says how things get here.
- **One action** makes it happen.

See the [table](#empty-states). Calm wording when there's nothing to do: "Nothing needs you right now".

### Explanations

- **Long explanations** (what the relay can and can't do, what `/bg` does, what "stale" means) go behind an `info` icon or a status's tooltip, not in always-visible paragraphs.
- **Keep each to two sentences.**

---

## 6. Accessibility and keyboard

### 6.1 Rules

1. **Contrast:** text at least 4.5:1, and control edges, focus rings and state indicators at least 3:1, in both themes. The pairs are in [2.5](#25-contrast); a new colour is checked before it's used. Disabled controls are the only exemption.
2. **Never colour alone:** every state has a text label. A row that needs you has its badge as well as its bar.
3. **Visible focus:** every interactive element shows `--pw-ring-focus` on `:focus-visible`, with the transparent-outline fallback for forced colours.
4. **Targets:** at least 24 × 24 px.
5. **Names:**
   - Every icon-only control has an `aria-label` that matches its tooltip.
   - Decorative icons are `aria-hidden="true"` and `focusable="false"`.
   - Visible labels start with the accessible name, so voice control works.
6. **Structure:**
   - One `<h1>` (the wordmark); the session list's title `<h2>`; session names in rows `<h3>`; the session view's title `<h2>`. Headings in messages are styled text, not headings (see [Markdown in messages](#markdown-in-messages)).
   - Landmarks: `<header>`, `<nav aria-label="Repos">` (the repo list), `<main>` (the session list) and the session view. With [root tabs](#root-tabs), the columns that hold the last three are the open tab's `tabpanel`.
   - The filter is in `role="search"`.
7. **The session view's semantics:**
   - As the third column, a `<section aria-labelledby>` region.
   - In overlay mode, `role="dialog"` with `aria-modal="false"`, because the header, and a repo list it doesn't reach, stay usable. What it covers is `inert` instead (see [Session view](#session-view)).
8. **Focus management:**
   - Opening a session from a row (click or Enter) moves focus to the view's heading, and so does opening the open session's row again. Closing it (Close, Back or Escape) returns focus to that session's row button, waiting a frame below 1,200 px so the row exists again and the list is no longer inert, or to the session list's heading when the row isn't shown (filtered out, or in a collapsed Finished section).
   - Opening from the URL or the back button takes no focus, unless focus was in what the view covers below 1,200 px, which goes inert: then it moves to the view's heading. Closing by the back button returns focus to the row only when it was in the view.
   - A session started from New session, selected once it's listed (W63), takes no focus either, unless the switch took away or hid what had it, or it was on the page: then the view's heading takes it. Its toast's Open, which goes with the toast, puts focus on the view's heading, as a row does.
   - The terminal takes focus as it attaches only when you asked for it in this page (W57): right after a click or Enter on the session's row, the Terminal tab, Attach again or Restart and attach, within 5 s, and while focus is still in the view, so focus that has gone elsewhere, into the filter say, stays there. Never by itself: not for a view opened from the URL, a reload, a restored tab, back or forward, a root tab's switch, a started session, or a step, so `j`, `k`, ↑ and ↓ keep stepping. A setting can make it never take focus at all. The terminal's bar then says how to type to it (see [Session view](#session-view-header-tabs-and-footer)).
   - Where focus would go to the session list's heading (a dismissed toast, a choice in the drawer), it goes to the view's heading while the view covers the list.
   - Moving between sessions with ↑/↓ while focus is in the list leaves focus in the list.
   - A focused row that a snapshot takes out of the list, such as a session that moved to its repos, hands focus to the row that took its place, or the one before it, or the session list's heading (see [Session list](#session-list)).
   - Choosing in the repo list leaves focus there; in the drawer, focus moves to the session list's heading.
   - Show older and Hide older keep focus the same way (W67). An empty state's Show older takes its button away, so focus goes to the Finished section's Hide older sessions, or the session list's heading; so does a Hide older that takes the whole selection away. Resume in background goes with an ended session's footer once the session is running, so focus anywhere in the footer goes to the view's Terminal tab, never the terminal, or to its heading when the footer goes because the session left the list.
   - Hide from repo list and Show in repo list keep focus: it's the same button with its other name. Show in repo list for a group in no snapshot takes its button away, so focus goes to the session list's heading. Unhide in the Hidden section moves focus to the group's item, back in the list, or for a group with no sessions to the next Unhide, the one before, or the list's Tab stop (see [Hidden groups](#hidden-groups)). A focused repo list item that leaves the list hands focus to the one that took its place, or the one before it.
   - A star toggle keeps focus as it stars and unstars. Unstarring a row in Starred takes the row away, so focus goes to the star toggle of the row that took its place, so the next can be unstarred too, or the one before it when it was last, or the session list's heading when none is left (see [Starred sessions](#starred-sessions)).
   - A Not needed now toggle keeps focus the same way (W88): marking a row in Needs you takes the row away, so focus goes to the Not needed now toggle of the row that took its place, or the one before it, or the heading. The toast's Undo, which goes with its toast, puts focus on the session's toggle, back in the list, or on the session list's heading when the list doesn't show it (the view's, while the view covers the list). See [Not needed now](#not-needed-now).
   - In the [Sub-agents](#sub-agents) tab (W77): opening a row, or a link in the conversation, puts focus on the transcript's heading; Back puts it on that sub-agent's row; a refresh that takes away what had focus hands it to the row that took its place, Try again on a new alert, or the list.
   - Opening a [root tab](#root-tabs) leaves focus on it. The back button switching tabs with focus in what that hides moves focus to the open tab.
   - In New session's [files](#files-for-the-first-prompt) (W82): Remove puts focus on the next file's Remove, or on Attach files; Try again on its row's Remove; and ⌘/Ctrl + Enter with a file on its way on the list.
   - Choosing in [Preferences](#preferences) leaves focus on the choice, whatever a new grouping does to the selection and the lists; closing the dialog puts it back on the Preferences button.
   - Dialogs trap focus and return it on close. Confirmations focus Cancel.
9. **Announcements:**
   - The connection badge is `role="status"`.
   - Results the user asked for are announced: send results, stop, remove and resume results, copy, and a switch of Group sessions by that replaces the selection. A resume is a toast, and its refusal an inline alert with `role="alert"`; a copy started instead is an error toast and a warning with no role, so it's announced once, by the toast (W67). Stop, remove, copy, open in an editor (W72), a started session, one that's listed but didn't open (W63), and that switch are toasts, announced by the toasts' live region, which is always in the DOM. A star toggle's result is its own pressed state, announced on the toggle; `s`, pressed with focus elsewhere, says it in a toast (W53). A mark of not needed now is a toast too, since the session leaves Needs you, wherever it was made; taking it away from the row is the toggle's pressed state, and from the actions menu a toast (W88).
   - What each file added to New session's first prompt came to, attached, refused or failed, and each Remove, is said by two status regions in its field, taking turns (W82).
   - Snapshot updates, ticking times and the list's re-sorting are never announced. The exceptions are the conversation's count of new entries while you're scrolled up ("3 new"), once per batch, and its working line's "Claude is working", "Finished" or waiting text, once each as a turn starts, ends or waits on you, never its time or its step (W102; see [Conversation](#conversation)).
   - The document title carries the count: "(2) pitwall". With [root tabs](#root-tabs), the open tab's root follows: "(2) pitwall · ~/work"; the count is still every root's.
10. **Forms:**
    - Every control has a label.
    - Errors appear after the first submit, are linked with `aria-describedby`, and focus moves to the first one.
    - Help text is linked too.
11. **Motion:** honour `prefers-reduced-motion` (see [2.13](#213-motion)). Nothing flashes, and nothing loops except progress.
12. **Reflow and zoom:** usable at 320 px wide and 200 % zoom. Rows grow with text; nothing clips.
13. **Tooltips** can be dismissed with Escape, stay while hovered, and are never the only route to essential information.
14. **The terminal** isn't a keyboard trap: F6 leaves it.
15. **Single-key shortcuts** can be turned off, and are ignored while typing (see below).
16. **Text is text:** session names, titles, prompts, replies, questions asked in a dialog and their answers, and server messages render as plain text, never HTML. Markdown in Claude's messages, its messages to pitwall and other sessions' renders as pitwall's own elements, each piece of its text a text node, never as HTML (see [Markdown in messages](#markdown-in-messages)).
17. **Forced colours** (Windows' contrast themes, `@media (forced-colors: active)`): the browser drops every box-shadow and forces every colour that isn't a system colour. So what a shadow or a fill says is drawn again there, in system colours (W31): the open row as a 2 px `Highlight` outline; a chip's edge as a 1 px `ButtonText` border, 2 px `Highlight` while pressed, as wide off as on (W75); the selected repo item, the open root tab, the theme switch's selected option and a question's chosen option as a 2 px `Highlight` border; the open tab's underline and the divider's line in `Highlight` and `CanvasText`; the session view over the list, the drawer, dialogs, menus, toasts and tooltips with a 1 px `CanvasText` edge; and fields, buttons with an edge, inline alerts, confirmations and the Jump to latest bar with a 1 px `ButtonText` border. Code blocks, tables and quotes in messages are drawn with real borders, which forced colours keep, and links in messages, in text and in code, take the system's link colour and keep their underline. A state is a border where its element can also take focus, so the focus outline still shows; padding gives back what a border takes. `web/src/forcedColors.test.tsx` checks the rules use only system colours.

### 6.2 Keyboard map

Single-key shortcuts (`/`, `?`, `n`, `j`, `k`, `s`) work only while they're switched on, in the [shortcuts dialog](#keyboard-shortcuts-dialog), and never:

- while focus is in a text field, a textarea, a select, something contenteditable or the terminal (`.xterm`), so typing is typing;
- with ⌘, Ctrl or Alt held, so the browser's and the system's shortcuts are untouched (Shift is allowed, since `?` needs it on most layouts; `N`, `J`, `K` and `S` aren't shortcuts);
- while a dialog or the repo drawer is open, since both are modal (the session view over the list isn't);
- for a key that something nearer already handled, or while an input method is composing.

Holding `n`, `?` or `s` down doesn't repeat them; holding `j` or `k` does. They're handled in `Dashboard.tsx`, on the document, after every handler inside the app; `web/src/shortcuts.ts` decides which key is which.

| Key | Where | What it does |
|---|---|---|
| `/` | Anywhere | Focus the filter field. Below 1,200 px, close the session view first, since it covers the list |
| `n` | Anywhere | Open the New session dialog |
| `?` | Anywhere | Open the keyboard shortcuts dialog |
| `j` / `k` | Anywhere, including the conversation | Next / previous row in the session list, a session's or a PR's alike (W106), as the rows are shown (shows it if a view is open: a session's view, or a PR's). Onto a running background session, its view opens on Terminal, which attaches only once it has stayed open for `--pw-delay-attach` (W54). Nothing while the message box has a draft or a Stop, Remove or resume runs |
| `s` | Anywhere, with a session open | Star or unstar the open session, as its view's [star toggle](#starred-sessions) does, with a toast that says which, since focus isn't on the toggle (W53). Nothing with no session open |
| ↓ / ↑ | On a session row or a PR row | Move focus to the next / previous row; with a view open, also show that session, or PR (W95, W106). Nothing while the message box has a draft or a Stop, Remove or resume runs |
| ↓ / ↑ | In the session view's header, except in an open menu, which uses them itself, or the PR view's | Show the next / previous row, a session or a PR (W95, W106), with focus on its view's heading. Nothing while the message box has a draft or a Stop, Remove or resume runs |
| Enter | On a session row or a PR row | Open the session, or the PR (W95) |
| ↓ / ↑, Home / End, Enter | The repo list | Move between items, jump to the ends, select |
| Escape | Layered, nearest first | Close a tooltip, a menu or a combobox's list (a menu item's tooltip closes with its menu) → cancel a confirmation (Stop, Remove, the restart before attaching, or a link's question while focus is in it) → close a dialog or the repo drawer → clear the filter (when focused and not empty) → close the session view, or the PR view (W95). Never inside the terminal; never discards a draft in the message box; does nothing while a confirmation's action runs |
| ⌘/Ctrl + Enter | The message box | Send |
| ⌘/Ctrl + Enter | The New session dialog | Start the session |
| ← / →, Home / End | The root tabs, with two or more roots | Move focus between the roots' tabs; Enter or Space opens the focused tab, with its own selection and open session |
| ← / →, Home / End | The session view's tabs | Move focus between Conversation, Terminal and Sub-agents; Enter or Space opens the focused tab |
| ↓ / ↑, Home / End, Enter | The Sub-agents list | Move between the sub-agents' rows, stopping at the ends; jump to the first or last; open one's transcript (W77) |
| ← / →, Home / End | The divider | Resize the session view by 16 px; jump to the minimum or maximum |
| ↑ / ↓, Home / End, Enter, Escape | An open menu | Move, jump, activate, close |
| ↓ / ↑, Alt + ↓, Enter, Escape | A combobox, such as New session's directory | Open the list, or move through it, wrapping; open it without highlighting; accept the highlighted option, never submitting the form; close the list, leaving the dialog open (W70) |
| ↑ / ↓, ← / → | A radio group, in Preferences | Choose the previous or next option, which applies at once; Tab moves on to the next group (W59) |
| F6 | The terminal | Leave the terminal, to the Terminal tab |
| Shift + Enter | The terminal | A new line in Claude Code's prompt: a line feed (Ctrl+J), where Enter's carriage return submits. Not with Ctrl, Alt or ⌘ too, nor while an input method composes |
| Tab / Shift + Tab | Everywhere but the terminal | Header (with root tabs, the open tab, then New session and the rest) → repo list → session list (header, rows) → session view (header, tabs, body, footer; on Sub-agents, the list's one Tab stop, or a transcript's Back, its body and what's in it, and no footer). Below 1,200 px with a session open, the session list is skipped, and below 1,000 px the repo list too: the view covers them, and they're inert |

- **The repo list's Hidden section** is outside its single Tab stop: Tab reaches the "Hidden (*n*)" toggle, then, while it's open, each hidden group's link and Unhide button. ↓, ↑, Home and End keep to the list's own items.
- **"Next" and "previous"** follow the session list's visible order, including an order that's being held while focus or the pointer is in the list. Rows in a closed Finished section and rows hidden by the filter are skipped, and it stops at either end without wrapping.
- **Where `j` and `k` start:** the focused row; or else the open session; or else, with nothing open, the first row, for either key. An open session the list doesn't show (filtered out, in a collapsed Finished section, or not listed) has no next or previous, so they do nothing.
- **Where focus goes:** with no session open, to the row. With one open, the view shows that session, replacing the history entry as ↑/↓ do, and focus stays in the list if it was there, stays in the conversation if it was there, and otherwise goes to the new heading. A view that opens on its Terminal tab (W54) has its conversation hidden, so focus from the conversation goes to its heading; its terminal, attaching after the wait, never takes focus from either, so the next key still steps.
- **In the conversation's body,** ↑/↓ scroll it, as in any scrolling region; use `j` / `k` there to change session.
- **An open menu** closes first when a shortcut moves focus (see [Menus](#menus)).
- **A draft is never lost to a key:** while the message box has a draft, `j` and `k` do nothing, nor do ↑ and ↓ on a session row or in the view's header, nor `/` or the app strip's Details where they would close the view, just as Escape does nothing then. Changing session would discard the draft. ↑ and ↓ on a row are still taken, so the list doesn't scroll either. `j`, `k`, ↑ and ↓ wait for a running Stop or Remove the same way, and for an ended session's resume while its request is out (W67), so its result shows in the view it was asked from.

---

## 7. Open questions

None open. Decisions made while writing this doc are recorded in `PLAN.md` under M3.
