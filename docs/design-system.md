# pitwall design system

pitwall's design system is inspired by Hookdeck's UX. It's pitwall's own design system, not Hookdeck's, and it uses no Hookdeck logos, illustrations or other artwork.

- **Status:** being applied in M3. The tokens, type, radii, edges, focus ring, theme switch and icons are in the web UI (W20), and so is the shell: the header, the three columns, the repo list and the filters (W21), then the two-line session rows, the badges, the connection badge, the Finished section and the Sort setting (W23), then the session view: its column and overlay, the divider, its header and actions menu, the menu component, the tabs, the footer and `?session=` (W22), then buttons' disabled and busy states, the spinner, inline alerts, the page alerts and the app strip, the message box, key caps and inline confirmations (W24), then tooltips, toasts, the dialog and the New session dialog on it, copy buttons and command chips, and timestamps on one clock (W25), then the single-key shortcuts, the keyboard shortcuts dialog with their off switch, the filter field's `/` key cap and the header's keyboard button (W26), then the conversation: speaker lines with their times, folded tool calls, Load earlier and Jump to latest (W27), then the waiting, empty and error states: skeletons and the long-wait line before the first snapshot, `EmptyState` for every empty state, the session view's waiting and unlisted states, and the conversation's errors with Try again (W28), then the terminal: its bar on `Badge`, `KeyCaps` and `Button`, the screen's font and colours from the tokens and its edge, F6 to leave it, its notices as inline alerts, and the conversation's place kept across the Terminal tab (W29), then the fixes from the integrated branch's review (W31), then sessions under the repos they worked in: distinct counts, the root's group, line 2's start label and the session view's worked-in line (W34), then hiding a repo or directory from the repo list: the session list header's Hide from repo list and the Hidden section at the list's foot (W35), then markdown in the session view: Claude's messages and other sessions' as pitwall's own elements, and your prompts as typed (W36), then links in code: bare URLs in code blocks and inline code open as links (W37), then each session in one group, the one it started in, with the repos it worked in in the session view and the filter, which replaces W34's listing under those repos, its start label and its distinct counts (W39), then roots as tabs: with two or more roots, a tab per root in the header, each narrowing the columns to its root, with its own place, and a need-you badge on the tabs that aren't open (W38), then Shift+Enter in the terminal: a line feed, a new line in Claude Code's prompt (W41), then the page notices: No token and Token rejected say how to bring a tab back, and an interactive session's actions menu has Stop session, off, saying how `/bg` makes it possible (W40), then View preferences: a header menu to group sessions by Main repo, the default, Where it started, or Every repo it worked in, which the page applies to the snapshot itself, and a menu's radio group (W42). The components take the shapes and layouts in sections 3 and 4 as W21 to W29 rebuild them. [Mapping from today's CSS](#215-mapping-from-todays-css) records how today's styles moved onto the tokens.
- **Scope:** the web UI in `web/`. The CLI's terminal output isn't covered.
- **Living reference:** the `#uikit` gallery. Run `npm run dev` and open `http://127.0.0.1:4517/#uikit`.
  - It renders every component the web UI has today, in every state. Its toolbar has the app's own [theme switch](#theme-switch), so it shows and stores the theme the app uses. Components in section 4 that aren't built yet join it as they're built.
  - It uses the real components from `web/src/components/` with made-up fixtures and stubs (`web/src/uikit/`). It doesn't need the token, and makes no API or WebSocket calls.
  - It's in dev builds only: `npm run dev` builds in Vite's development mode, and `npm run build` leaves the gallery out, which `web/src/uikit/build.test.tsx` checks.
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
| `--pw-info-tint-fg` on `--pw-selected` (a pressed filter chip's label) | 6.56 | 7.89 | 4.5:1 |
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
  --pw-toast-timeout: 4s;     /* read by JavaScript */
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
  - Dialogs: 408, 624 (the default) or 840 px. Tooltips: at most 344 px. Toasts: 360 px. Menus: at least 192 px.
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
  - Toasts stay for `--pw-toast-timeout` (4 s).
  - A copy button's `copied` icon stays for `--pw-copied-timeout` (2 s).
  - JavaScript reads these tokens from the element they apply to (`web/src/timing.ts`), so a part of the page can set its own. The `#uikit` gallery sets the two timeouts to an hour on a specimen's stage, so a toast or a copied icon stays for its screenshots, and sets `--pw-delay-spinner` to 0 (and `--pw-delay-long` to 0 or an hour) on a waiting state's, so its skeletons and long-wait line show at once.
- **Reduced motion** (`prefers-reduced-motion: reduce`): the durations drop to 0, skeletons stop pulsing, the spinner slows to 2 s per turn (it still shows something is happening), and scrolling to the latest message jumps rather than animating.
- **Nothing loops** except spinners and skeletons, and nothing pulses to get attention.

### 2.14 Fonts and icons

- **Fonts,** self-hosted as woff2, because the CSP blocks font CDNs:
  - Inter 400, 500 and 600; JetBrains Mono 400 and 500. Latin and Latin Extended subsets.
  - Bundled from the `@fontsource/inter` and `@fontsource/jetbrains-mono` packages, exact devDependencies. Vite copies the woff2 files into `dist/web/assets/` with hashed names, so they're same-origin, which the CSP's `default-src 'self'` allows.
  - Declared in `web/src/fonts.css`, imported from the web entry after `tokens.css`: one `@font-face` per weight and subset, woff2 only, with `font-display: swap` and the package's own `unicode-range`. A browser downloads a file only when text on the page uses that family, weight and subset.
  - **No preload.** The hashed file names would need a build step to reach `web/index.html`, and pitwall is served from localhost, where a preload saves almost nothing: the stylesheet that names the files arrives at once, and `swap` shows the fallback font until they load.
  - **Licence files:** both are SIL OFL 1.1, reproduced in full in the root `THIRD_PARTY_NOTICES.md`. The web build copies that file into `dist/web` as `THIRD_PARTY_NOTICES.txt`, so the licences ship with the font files.
- **Icons:** Material Symbols Rounded, bundled as SVG path data, never as a font or from a CDN.
  - Style: fill 0, weight 400, grade 0. Each size draws its own optical size, which sets the stroke weight for that size: 16 px draws the 20 px design (there's no 16 px one), and 24 px draws the 24 px design.
    - The 48 px design, the only one in the `@material-symbols/svg-400` package, is too thin at 16 px: about 1.0 px strokes, against 1.2 px for the 20 px design.
  - Vendor only the glyphs pitwall uses, from a pinned upstream commit at least 14 days old, as the repo's dependency rule asks. Keep the path data in `web/src/icons/paths.ts`, one path per size, keyed by the semantic names below.
    - Today's source is `google/material-design-icons` at commit `737e3324305806514d7909874fa1818ae1808232` (2026-10-02): `symbols/web/<glyph>/materialsymbolsrounded/<glyph>_20px.svg` and `_24px.svg`. Nothing is installed.
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
| `clear` | cancel | Clearing the filter |
| `add` | add | New session |
| `copy` / `copied` | content_copy / check | Copy buttons |
| `terminal` | terminal | The Terminal tab, attach |
| `conversation` | forum | The Conversation tab |
| `send` | send | The message box |
| `stop` | stop_circle | Stop session |
| `remove` | delete | Remove session |
| `restart` | restart_alt | Restart and attach |
| `retry` | refresh | Try again, attach again |
| `info` / `success` / `warning` / `error` | info / check_circle / warning / error | Alerts and toasts |
| `repo` / `directory` | graph_1 / folder | Group kind. graph_1 is a branch, which reads as git at 16 px; account_tree read as a hierarchy |
| `external` | open_in_new | Links that leave pitwall |
| `latest` | arrow_downward | Jump to latest |
| `back` | arrow_back | Back to the list on narrow windows |
| `keyboard` | keyboard | The header's keyboard shortcuts button, which opens the shortcuts dialog |
| `hide` / `show` | visibility_off / visibility | The session list header's Hide from repo list and Show in repo list, and each hidden group's Unhide (W35). Each draws what the button does |
| `preferences` | tune | The header's [View preferences](#view-preferences) button (W42) |
| `checked` | check | The chosen option in a menu's radio group, as in View preferences (W42). The same glyph as `copied`, for another meaning |
| `theme-system` / `theme-light` / `theme-dark` | computer / light_mode / dark_mode | The theme switch |

### 2.15 Mapping from today's CSS

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
│ Needs you       [2] │ ⑂ pitwall      4 sessions [2 need you] ││ name · title        ⋯  ✕  │
│ All sessions     12 │ [Filter sessions   /] [Interactive]    ││ badge · kind · 5m · cwd   │
│ ─────────────────── │ [Background]         Sort [Urgency ▾]  │├ Conversation | Terminal ──┤
│ ▢ ~/git           3 │────────────────────────────────────────││ body (scrolls)            │
│ ⑂ pitwall       [2] │▌name · title             [waiting] 1m  ││                           │
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
- **Right, 12 px apart:** New session (primary, md, `add` icon, with `n` in its tooltip); the connection badge; "updated 7s ago" (meta, `--pw-text-subtle`, tabular, a [timestamp](#timestamps) with the absolute time in its tooltip); the theme switch; [View preferences](#view-preferences) (ghost md `preferences` [icon button](#icon-buttons), "View preferences", a [menu](#menus) button), which sets how the repo list groups sessions (W42); the keyboard shortcuts button (ghost md `keyboard` icon button, "Keyboard shortcuts", with `?` in its tooltip), which opens the [keyboard shortcuts dialog](#keyboard-shortcuts-dialog).
  - The shortcuts button is there from the first render, before the first snapshot, and stays while the single-key shortcuts are off, so they can be turned back on. View preferences is there from the first render too.
  - New session says its key in `aria-keyshortcuts="n"` while the single-key shortcuts are on. The shortcuts button has none: ARIA 1.2 wants the keys as pressed, modifiers and all, and `?` is Shift and a key that differs by keyboard layout (`/` on a US one), so no value is right everywhere. Its tooltip's key cap and the dialog's map say it.
- **Compact (≤ 600 px):** the right side wraps under the wordmark, and the header grows to fit.

### Root tabs

Phil runs pitwall over two folders of repos and wants both in one window (W38). One pitwall watching several roots, with a tab per root, was chosen over two pitwalls, which double the polling, scanning and relays, and over one page showing other pitwalls, which would need each one's token and a looser CSP. There's no All roots tab: a several-root pitwall without tabs was that view.

- **When:** two or more roots. With one, the header is as above, with no tabs, and the URL names no root.
- **The tabs:** one per root, in the order pitwall was given them, after the wordmark, in a [tablist](#tabs) named "Roots". Each is labelled with its root's path, home as `~`, with the full path in a tooltip that describes the tab. They use the root tabs' look in [Tabs](#tabs).
- **What the open tab narrows to its root:** the repo list (Needs you, All sessions and their counts, the groups, and the Hidden section and its badge), the session list and its summary, the filter, `j` and `k`, and the New session dialog's directories (see [Dialogs](#dialogs)). The columns are the open tab's `role="tabpanel"`, named by its tab.
  - **Which root is a group's:** the index's, never the page's. A group's `SessionGroup.root` is the root the index put it under, the longest configured root that holds its directory (`matchRoot()` in `src/index/roots.ts`). A group the page builds for a repo with none in the snapshot (W42, see [Repo list](#repo-list)) sits under that repo's `WorkedIn.root`, which the index sets the same way. So with one root inside another, the inner root's sessions are in its tab alone, and the outer root's tab never lists them.
  - A tab's Needs you and All sessions are the sessions its groups list, as [View preferences](#view-preferences) groups them, each once. In Main repo and Where it started each session is in one group, and so in one tab, and the tabs' counts add up to every root's; Main repo can move a session started in a root itself to its main repo under another root, and so to that root's tab (Phil, 2026-10-21). In Every repo it worked in, a session is in the tab of each root it's listed under, so the tabs' counts can add up to more.
- **What stays the whole page's:** the header's other controls, the page alerts, the app strip, the toasts, the Sort setting, the single-key shortcuts setting, the session view's width, and the document title's count.
- **The badge:** a tab that isn't open carries a solid warning need-you [badge](#badges) after its label, 6 px from it, whenever any session under its root needs you, counting each session once, though in Every repo it worked in one may be in several of the root's groups, as the Hidden section's badge counts. It's in the tab's name ("~/work, 2 need you"), so nothing that needs you is out of sight in a tab that isn't open. The open tab has none: its repo list's Needs you says the same, just below, and the document title counts every root's.
- **Each tab keeps its own place:** its selection, its open session and its filter, for the page's life. Switching back shows them again.
  - The open session views of the tabs that aren't open stay mounted, `hidden`, so switching never detaches an attached terminal (D9's limit of four counts across tabs), never drops a message box's draft, and never stops a send, or a Stop or Remove, in flight; its result shows when the tab is back. A hidden view has no `id`, so rows' `aria-controls` name only the one shown, and Escape isn't its. Its conversation keeps the reader's place, as behind the Terminal tab.
  - A session started from a tab that's been left by the time it's listed opens in that tab, for when it's back, unless the view open there has a draft or a running action.
- **The URL:** the selection's `&root=<root>` names the open tab, for the views as well as a group: `?view=all&root=/Users/example/work`. Switching pushes one history entry, with the tab's selection and open session; the back button switches back.
  - A URL to a group or session in another root opens its tab: a group by its root, or, without one, by the first group with its key; `?session=` with no selection by the group it selects ([Repo list](#repo-list)). A URL with a root pitwall doesn't watch, or none, opens the stored tab, or the first, and is replaced to match.
  - A root with no sessions keeps its tab, with the usual "No Claude Code sessions under *root*" empty state.
- **Storage:** the open tab, as its root's path alone, in `localStorage` as `pitwall.root-tab.v1`, for a URL with no selection, such as the one the CLI opens. Missing, throwing or empty storage, or a root pitwall no longer watches, opens the first root's tab, as `pitwall.view.v1` falls back (W38).
- **The page title** names the open tab's root after the count: "(3) pitwall · ~/work". The count is every root's, each session once, so the browser's tab shows what needs you anywhere.
- **Focus:** opening a tab leaves focus on it. When the back button switches tabs with focus in what that hides, the last tab's session view, or with focus dropped to the page, it goes to the open tab. Everything else, F6, `/`, `n`, `?` and `j`/`k`, works as before, in the open tab.
- **Widths:** with tabs, the header wraps whenever its line has no room, at any width, not only at 600 px and narrower. First the right side goes under the wordmark and the tabs; then the tabs go under the wordmark, and wrap among themselves; only a tab wider than a whole line is cut, in the middle, its last segment kept. So at 320 px, and 200 % zoom, every tab and every badge is in sight, and nothing scrolls sideways. A select or a menu of roots would hide the badges of the roots not chosen, and a tab strip that scrolls would hide the tabs past its edge, so neither keeps what needs you in sight; and labels stay whole as long as they can, since cut paths such as `~/wo…/git` and `~/pe…/git` are harder to tell apart. One line holds at 52 px, with 12 px above and below.

### Repo list

- **Fill and size:** `--pw-bg`, `--pw-sidebar-w` (240 px) wide, a right `1px solid var(--pw-border)`, padding 8 px. It scrolls on its own.
- **Landmark:** `<nav aria-label="Repos">`, holding a `<ul>` of the two views, an `<hr>` divider, then a `<ul>` of [repo list items](#repo-list-items) for each root's groups, then, while any group is hidden, another `<hr>` and the [Hidden section](#hidden-groups).
  - With two or more roots, it's the open [root tab](#root-tabs)'s: that root's groups and hidden groups alone, under no heading, since the tab names the root.
- **Contents, top to bottom:**
  1. Two views: "Needs you", every session that needs you under the root (the open tab's, with several), and "All sessions".
  2. A 1 px `--pw-border` divider, 8 px above and below.
  3. Every group: a git repo, or a directory that isn't in one.
  4. While any group is hidden, the same divider, then the [Hidden section](#hidden-groups): "Hidden (*n*)", collapsed by default, listing the hidden groups.
- **Hiding a group** (Phil, 2026-10-21, W35): any group, a git repo or a directory, the root's own included, can be hidden from the list with the session list header's Hide from repo list (see [Session list](#session-list)), and shown again there or from the Hidden section. Needs you and All sessions can't be.
  - It takes out only that group's item. Its sessions still show in the group, Needs you and All sessions, with line 2 naming their group as before; the views' counts, the other groups' counts, the document title's and the session view's "Started in … · worked in …" line don't change.
  - It's by the group's root and key, so a group the page builds for a repo hides like any other and stays hidden in every [View preferences](#view-preferences) mode. In a mode that doesn't list it, the Hidden section shows it with "No sessions".
  - It's kept for each root, so two pitwalls watching different roots keep separate lists: see [Hidden groups](#hidden-groups) for the key and what it holds.
  - Rather than an age limit: on Phil's try-out a long-running session was listed under a repo it last worked in weeks earlier, which the grouping rule had read correctly.
- **Grouping, by [View preferences](#view-preferences)** (W42, Phil, 2026-10-21): the snapshot lists each session in the group it started in (W39), and the page groups it again for the mode chosen in the header. Switching is instant and asks the server nothing.
  - **Where a session started:** a repo for a session started in it, its worktrees and subdirectories included; a directory below a root that isn't in a repo for one started there; the root's own directory for one started in the root itself.
  - **The repos a session worked in** beyond where it started are those it changed or whose tool calls touched it at least 5% of the time, its sub-agents' included (`SessionSummary.workedIn`, W34, spike 004). The [session view](#session-view-header-tabs-and-footer)'s line 3 names them in every mode, and the [filter](#search) finds a session by them.
  - **Main repo, the default:** a session started in a root itself that worked in repos is listed under one of them, its main repo: the one with the most changes, ties broken by tool calls, then the newest touch, then the path. It may be under another root, and so in that root's [tab](#root-tabs). A session started in a root itself that worked in no repo stays in the root's own group, and every other session stays where it started, whatever it worked in. Each session is in one group. A root that is itself a repo is a repo like any other: its sessions stay.
  - **Where it started:** the snapshot's groups as they are, each session under the group it started in alone (W39, Phil, 2026-10-21: "The problem is duplication"). The root's own directory lists every session started in the root itself.
  - **Every repo it worked in:** W34's listing. Each session is under the group it started in and under every repo it worked in, except that the root's own directory lists only the sessions started in the root that worked in no repo. A group lists each of its sessions once, so a session is in several groups, and the counts can overlap (see [Repo list items](#repo-list-items)).
  - **A repo with no group in the snapshot,** one that sessions only worked in, gets an item when the mode lists a session under it: a git repo, from the session's `WorkedIn`, its key, label and root. In Where it started it has none.
  - **A group with no sessions in the mode goes,** the root's own included, as any empty group does.
  - **Why three:** Where it started replaced W34's listing after Phil's try-out, where 12 of 20 sessions were in more than one group. Main repo came next: a long session started in the root that did nearly all its work in one repo belonged under that repo, not the root.
- **Group order:** alphanumeric by label, so the column never moves as sessions change (Phil, 2026-10-20).
  - Case-insensitive, with numbers compared as numbers, so `repo-2` comes before `repo-10` (`Intl.Collator` with `numeric: true`).
  - Within each root, the root's own directory comes first, then the rest.
  - A group whose sessions have all finished keeps its place, with its label muted. New groups appear in their place, and removed ones leave it.
- **The root's own directory** is labelled with its path (`~/git`) rather than its last segment, so it doesn't read as a repo called "git", and is first among its root's groups.
- **Below the sidebar breakpoint (900 px): a drawer.**
  - It slides in from the left with the same content, `--pw-sidebar-w` wide (or the window, if that's narrower), opened from the header's `menu` button.
  - `--pw-surface`, `--pw-shadow-overlay`, at `--pw-z-dialog` over a `--pw-backdrop` at `--pw-z-backdrop`, and `role="dialog"` with `aria-modal="true"`, like a dialog.
  - Choosing an item closes it. Escape, or a click on the backdrop, closes it and returns focus to the menu button.
- **The selection is in the URL:** `?view=needs-you`, `?view=all`, or `?repo=<key>`.
  - The group's key, plus `&root=<root>` when pitwall watches more than one root, since a worktree's group can share its main repo's key under another root. With more than one, the views name their root too, which is the open [root tab](#root-tabs). Stable across reloads, and readable: `/`, `~`, `:`, `@` and `,` aren't escaped. Never the token.
  - Other parameters, such as `?session=`, are kept as the selection changes.
  - Choosing pushes a history entry; `popstate` makes the columns match the URL.
  - A URL with no selection uses the last one, saved in `localStorage` as `pitwall.view.v1`, or All sessions the first time, and replaces the URL to match. With root tabs, the stored tab, `pitwall.root-tab.v1`, picks the tab, and the stored selection is used when it's that tab's.
  - Loading `?session=` with no selection selects the group the session is listed under in the chosen [View preferences](#view-preferences) mode: in Every repo it worked in, the group it started in, or, for one started in a root itself that worked in repos, its main repo. That group's root picks the [tab](#root-tabs).
  - A hidden group is selected as any other, from a link, the URL or its entry in the Hidden section, and its sessions show as usual.
  - A selected group that leaves the list stays selected, with the "No sessions in *group* now" empty state (see [Empty states](#empty-states)). That includes a saved selection in `pitwall.view.v1` whose group has since emptied, the root's own directory included, once no session is listed under it in the mode.
  - Switching [View preferences](#view-preferences) is the exception: a selected group the new mode doesn't list gives way to All sessions in the same root tab, with a toast that says so.

### Session list

- **Fill:** `--pw-surface`. Its header stays put; its rows scroll.
- **Page alerts** come first, above the header, full column width, with 12 px 16 px 0 around them and 12 px between them (see [App strip and page alerts](#app-strip-and-page-alerts)). They take at most half the column; past that, they scroll inside themselves, so the header and some rows always show. While they do, their box is a Tab stop, a region named "Alerts" with the inset focus ring, since Safari and Firefox scroll a box from the keyboard only once it has focus (`ScrollBox`, W31).
- **Header** (padding 12 px 16 px, a bottom `--pw-border`):
  - **Line 1:**
    - The selection's name, as the column's `<h2>` (l 16/24, 600).
      - A group shows its kind icon and label. With two or more roots, the open [root tab](#root-tabs) says which root it's under, so the heading doesn't (until W38, it added "in *root*").
      - The views show "Needs you" or "All sessions".
    - At the right, the summary: "4 sessions", or "2 of 4 sessions" while the filter hides some, then a solid warning "2 need you" badge, or " · Nothing needs you" in meta text. The counts are the selection's; Needs you never counts a finished session.
    - **For a group** (W35), after the summary, 8 px from it: Hide from repo list, a ghost sm `hide` [icon button](#icon-buttons) named by its tooltip. For a hidden group it's Show in repo list, with the `show` icon, in the same place. sm is 24 px, the line's height, so the header is as tall for a group as for a view.
      - The summary and the button sit together at the right, and wrap together onto the next line when the heading needs the room.
      - Either one acts at once, with a [toast](#toasts) saying where the group went: "Hid *group*. It's under Hidden, at the foot of the repo list." or "Unhid *group*. It's back in the repo list." (for one with no sessions in the snapshot, "… once it has sessions."). It's one click because it's easy to undo, and the toast and the Hidden section say where the group is.
      - It's the same button with its other name, so focus stays on it. Hiding keeps the group selected, and opens the Hidden section on its entry, scrolled into view in the repo list.
      - A selected group that has left the snapshot and isn't hidden has no button: there's no item to hide. One that's hidden has Show in repo list; once that's pressed the button goes, and focus goes to the heading.
      - Needs you and All sessions have none.
    - No summary where it would only repeat the empty state below it (W31): over no sessions at all ("0 sessions · Nothing needs you" above "No Claude Code sessions under *roots*"), and over Needs you with nothing in it ("Nothing needs you" above "Nothing needs you right now"). The filter's no-match state keeps it, since "0 of 4 sessions" says what the filter hides.
  - **Line 2,** 8 px below, wrapping:
    - the [filter field](#search), at least 200 px wide and growing;
    - then the [filter chips](#filter-chips) and "Clear filters";
    - then, at the right, the sort setting: a visible "Sort" label (label style, `--pw-text-muted`), 6 px before a native [select](#inputs-textareas-and-selects), 28 px tall. It's in the filters' `role="search"` form, after the chips, so it wraps with them: at 360 px the field has its own line, and the chips and Sort share the next.
- **Rows:** [session rows](#session-rows) in a `<ul>`, in the order the sort setting picks (Phil, 2026-10-20):
  - **Urgency,** the default: waiting or blocked first, then asked you, then busy, then most recently active, with stale sessions after those. This is the index's order; the web UI sorts every list itself, in each order.
  - **Recent:** most recently active first.
  - **Name:** alphanumeric by name, as the repo list sorts its groups. It never moves as sessions change.
  - The setting applies to every selection, and is saved in `localStorage` as `pitwall.sort.v1`. Finished sections use it too, except that Urgency orders finished sessions by activity alone.
  - **A group:** its unfinished sessions, then its [Finished section](#finished-section).
  - **Needs you:** every session that needs you, from every group, each once, though in Every repo it worked in one may be in several groups. There's no Finished section, because a finished session never needs you.
  - **All sessions:** every unfinished session from every group, each once, then one Finished section for all of them.
  - With two or more roots, "every group" is the open [root tab](#root-tabs)'s.
  - The summary's counts, and the document title's, count each session once. A group's summary is the sessions listed under it in the [View preferences](#view-preferences) mode, as its repo list item says.
- **Live updates:** each snapshot updates rows in place. If it would reorder rows (under Urgency or Recent) while the pointer is over the list or focus is inside it, keep the current order until both have left, then apply it.
  - Added and removed rows apply at once: a new row goes in after the row it follows in the new order, or first. A session that leaves the selected group, as one does when it's no longer listed, leaves at once too. A scan that finds the repos a session worked in moves it only as [View preferences](#view-preferences) says: never in Where it started; in Main repo a session started in a root itself goes to its main repo; in Every repo it worked in a session is added under each repo.
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
- **The open session is in the URL:** `?session=<sessionId>`, after the selection.
  - Opening a session pushes a history entry, and opening the one that's open adds none; moving with ↑/↓ replaces it; closing pushes one without the parameter.
  - `popstate` makes the view match the URL.
  - **Waiting:** loading a URL with a `?session=` before the first snapshot opens the view in its waiting state, in the column or over the list as the layout says: Close (or Back to sessions) in the header, and after `--pw-delay-spinner` skeleton bars for line 1 (the name, 40 %) and line 2 (70 %), `aria-hidden`, with a visually hidden `role="status"` "Loading the session"; after `--pw-delay-long`, the same long-wait line as the session list's, centred in the body. Its `<h2>` is visually hidden text, "Session", which names the region. The first snapshot replaces it with the session, or with the unlisted state.
  - **Unlisted:** loading a URL with a session that isn't in the snapshot, and wasn't while the page was open, opens the view with an [empty state](#empty-states) centred in its body: the `info` icon, "This session isn't listed under these roots" as its title, which is the view's `<h2>` and names the region, and the sentence "pitwall lists no session with the id `<id>` under *roots*; it may have been removed, or run outside these roots." The header has only Close (or Back to sessions). The id is cut at 120 characters, and the id and roots are text. A session that leaves the snapshot while it's open, or that the back button returns to after it left, shows what it showed last instead, with the "no longer listed" alert.
  - Opening from the URL or the back button never attaches, sends or changes anything, and takes no focus.
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
| **Danger** | `--pw-danger-solid` | none | `--pw-on-danger-solid` | 8 % darker (`filter: brightness(0.92)`) | Confirming a destructive action: Stop session, Remove session |

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
- **Variants:** ghost by default; outline when it stands alone outside a toolbar.
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

### Search

- **The filter field:** height 28 px, at least 200 px wide and growing to fill its line (see [Session list](#session-list)). A 16 px `search` icon at 8 px from the left in `--pw-text-subtle`; text padding-left 32 px, and padding-right 32 px once there's text. A placeholder too long for the field ends in an ellipsis.
- **Right side:** a `/` key cap while it's empty and unfocused, 4 px from the right edge and centred, while the single-key shortcuts are on; a ghost sm `clear` icon button ("Clear filter"), 2 px from the right edge, once there's text. Clearing with it keeps focus in the field. The browser's own clear button is hidden.
  - The key cap is a hint, `aria-hidden`, and clicks go through it to the field. The field says the same in `aria-keyshortcuts="/"`, only while the shortcuts are on.
  - While the shortcuts are on, the text keeps 32 px clear on the right, focused or not, so the placeholder doesn't move when the key cap goes.
- **Behaviour:**
  - Filters as you type (pitwall filters in memory); no Enter needed.
  - Escape in the field clears it if it has text, otherwise leaves the field. Escape that clears stops there (it calls `preventDefault()`); Escape that leaves the field goes on to close the session view, as in the [keyboard map](#62-keyboard-map).
  - Matches are highlighted in session names, titles and the group labels that start a row's line 2: each match is a `<mark>` with `--pw-highlight` fill and `--pw-text` text, whatever the colour of the text around it, since that's the pair 2.5 checks. Matching is case-insensitive, on the trimmed text. The filter also matches a session's directory and the labels of the repos it worked in (`SessionSummary.workedIn`, W39), which the row doesn't show, so a session that matches only by those has no highlight.
  - **A repo's name finds every session that worked there:** typed in All sessions, it lists the sessions started in the repo and those started elsewhere that worked in it, a repo with no group of its own included. That's how to see all of a repo's work, whatever [View preferences](#view-preferences) lists under it.
  - It filters the session list's selection: one group, Needs you or All sessions. The repo list's counts don't change.
- **Accessibility:** inside `role="search"`; a visually hidden label "Filter sessions"; placeholder "Filter by session, title, repo or directory".

### Filter chips

- **Size:** 24 px tall, padding 0 8 px, label style (xs 12/20, 500), `--pw-radius-sm`, an optional count after the label in tabular numbers.
- **Off:** `--pw-surface`, `--pw-shadow-control`, text `--pw-text-muted`. Hover: `--pw-surface-hover`, text `--pw-text`.
- **On:** `--pw-selected`, `--pw-ring-selected` in place of the control edge, text `--pw-info-tint-fg`, and a 16 px `copied` (check) icon before the label, 4 px from it.
- **Focus:** `--pw-ring-focus` added to the chip's edge or ring.
- **Semantics:** `<button aria-pressed>`, in a group with `aria-label="Filters"`, 8 px apart. The check icon is `aria-hidden`, so a chip's name is its label.
- **The chips:** "Interactive" and "Background", which combine as OR, so either one alone narrows the list and both together show every session.
  - "Needs you" is a view in the [repo list](#repo-list), replacing today's "Needs attention only" checkbox, and finished sessions have their own [section](#finished-section), so neither is a chip.
  - A ghost sm "Clear filters" button appears after the chips, inside their group so it wraps with them, when any chip is on or the field has text. It clears the text and the chips, and puts focus in the field, since the button itself goes away.

### Tabs

A row of tabs that switches what's below them: the session view's Conversation and Terminal (see [Session view: header, tabs and footer](#session-view-header-tabs-and-footer)), and the header's [root tabs](#root-tabs) (W38). One pattern, `web/src/tabs.ts`, with a look for each place.

- **ARIA:** `role="tablist"`, named (`aria-label`); each tab a `<button role="tab">` with `aria-selected` and `aria-controls`; the panel `role="tabpanel"` with `aria-labelledby` the open tab. The root tabs all control one panel, the columns, which the open tab names.
- **Keys:** the tablist is one Tab stop, the open tab's (roving `tabindex`). ← and → move focus to the previous and next tab, wrapping at the ends; Home and End to the first and last. A key with ⌘, Ctrl, Alt or Shift is left alone, so Alt + ← still goes back.
- **Opening is manual,** never on focus: Enter, Space or a click opens the focused tab, and focus stays on it. Opening Terminal attaches, and opening a root tab changes all three columns and adds a history entry, neither of which an arrow key should do.
- **What a tab carries:** its label, then, where it has one, a badge or a dot, whose meaning is in the tab's name as visually hidden text (", attached", ", 2 need you").
- **The session view's look:** 28 px tall, padding 4 px 8 px, m 14/20, 500, a 16 px icon; inactive `--pw-text-muted` with a `--pw-surface-hover` fill on hover; open `--pw-text` with a 2 px `--pw-text` underline on the row's bottom edge.
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

| Session state | Label | Style |
|---|---|---|
| Interactive, waiting | "Waiting: *reason*" | solid warning |
| Background, blocked, not stale | "Blocked: *reason*" | solid warning |
| Its last message asked you | "Asked you" | subtle warning |
| Blocked and stale | "Blocked: *reason*", plus a "Stale" badge | outline, plus subtle neutral |
| Failed | "Failed" | subtle danger |
| Done | "Done" | subtle success |
| Stopped | "Stopped" | subtle neutral |
| Process not running | "Not running" | outline |
| Busy / working | "Busy" / "Working", with an 8 px dot in `--pw-info-tint-fg`, the badge's text colour (2.1) | subtle info |
| Idle | No badge in the list; "Idle" in the session view | subtle neutral, in the session view only. Needs-you is unaffected: it comes from waiting, blocked and asked-you, never from the badge |
| Unknown | "Unknown" | subtle neutral |
| Finished, and it asked you | "Asked you", with a tooltip saying it isn't counted | outline |

- **Other badges:**
  - **Counts:** subtle neutral ("4", "2 of 5").
  - **Needs-you counts:** solid warning ("2 need you").
  - **Errors in folded tool calls:** subtle danger: "1 error" or "3 errors" on a fold's toggle, and "error" on each failed call.
- **Stale** carries its explanation in a tooltip, on hover (`Badge`'s `hint`): "Blocked with no activity for more than 7 days, whether or not its process is running. Usually waiting on a question that no longer matters." A badge isn't focusable, so in a row that tooltip is hover-only; the session view shows Stale, and a finished session's Asked you, with an info button after each whose name and tooltip are the explanation, so the keyboard and screen readers reach it (W31).

### Status dot

- **Shape:** 8 px circle, `--pw-radius-full`, in a tone's `-fg` colour on a neutral surface, or the tint's `-tint-fg` inside a subtle badge, as 2.1 asks (3:1 or better against what it sits on, 2.5).
- **Use:** inside badges, and in the connection badge. Never the only sign of a state: a text label always goes with it. It doesn't animate.

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
     - These tooltips, and those below, open on hover only: in a row, only the name's button is focusable, and the tooltip on its heading doesn't open for the button's focus. The full title and line 2 are in the DOM, so screen readers have them, and the session view shows them all.
     - Then, at the right, the status badge(s) and the relative time (meta, `--pw-text-subtle`, tabular). The badges sit just before the time, so they line up down the list.
     - **Line 1 never wraps.** The title gives way first, then the name, then the status badge, which leaves the name and the time at least 10em. "Stale" and a finished session's "Asked you" are short and stay whole. The " · " is drawn with the title (CSS `::before`, not read out), so it goes when the title has.
  2. **What it wants or did last,** on one line with an ellipsis, when the transcript is readable:
     - "Asked: *excerpt*" (meta, the label in `--pw-warning-fg` 500, the excerpt in `--pw-text`); or
     - "You: *last prompt*" (meta, `--pw-text-muted`).
     - The full text is in a tooltip when it's cut short.
     - In Needs you and All sessions, the line starts with the group's label (meta, `--pw-text-subtle`; the root's own directory as its path) and " · ": the group the session is listed under in the [View preferences](#view-preferences) mode, its home group. In Every repo it worked in, which lists it under several, that's the group it started in, or, for one started in a root itself that worked in repos, its main repo (W42). A session with neither a question nor a prompt shows only the label there, and no line 2 in a group.
     - In a group's own list, the line has no label: the heading names the group. W34's "started in" label went with W39, and Every repo it worked in doesn't bring it back: the session view's line 3 says where a session started and the repos it worked in.
- **Not in the row:** the last reply, the relay exchange, the cwd, the attach command and a Message button. They're in the session view: the conversation, the message box, the header and the actions menu. A row stays two lines however long the session's replies are.
- **Opening:** the name is a `<button>` with `aria-controls="session-view"`, `aria-current="true"` when its session is open, and `data-open-session`. The session view has `id="session-view"`.
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
| Finished | `--pw-surface` | the name at 400 weight in `--pw-text-muted`, and the "Asked:" label and excerpt in `--pw-text-muted` too |

- **Needs you has no row tint,** only the bar and the badge. On 2026-10-20, nine of Phil's fifteen sessions needed him, and tinting every one of them turned most of the list yellow. The Needs you view collects them instead.
- **Transcript notes:** "Transcript not found" or "Transcript unreadable", meta, `--pw-text-subtle`, in place of what line 2 would say, after the group label in Needs you and All sessions.
- **Height:** never fixed; rows grow with zoom and text spacing.

### Repo list items

- **Item:** a link, `<a href="?repo=…">` (or `?view=…`), in the repo list's `<ul>`, with `aria-current="page"` when it's the selection. The page handles the click, with no reload.
  - At least 32 px tall, padding 6 px 8 px, `--pw-radius-md`, 8 px gaps. It grows with zoom and text spacing.
  - Left to right:
    1. A group's kind icon (`repo` or `directory`, 16 px, `--pw-text-subtle`). The two views have no icon.
    2. The label (m 14/20, 400), on one line with a middle ellipsis; the full label is in a tooltip when the ellipsis cuts it, on hover and on focus. Then a visually hidden ", git repo" or ", directory", after the label so the link's name starts with what it shows.
    3. At the right, one count, each with a visually hidden noun so it reads as "2 need you" or "4 sessions":
       - a solid warning badge with how many need you, when any do;
       - otherwise, how many sessions there are (meta, `--pw-text-subtle`, tabular).
       - A group's counts are the sessions listed under it, each once, as [View preferences](#view-preferences) groups them. In Main repo and Where it started each session is in one group, so the groups' counts under a root add up to that root's sessions, every root's to All sessions', and the groups' badges to Needs you's, hidden groups' included.
       - In Every repo it worked in, a session counts in each group it's under, so the groups' counts can add up to more than All sessions', and their badges to more than Needs you's. All sessions and Needs you still count each session once, and so do the root tabs' badges.
       - Needs you shows its badge, or nothing when nothing needs you.
       - All sessions always shows how many sessions there are, as in the layout above: the badge would only repeat Needs you's, just above it.
       - Before the first snapshot, the two views show no count.
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
- **A hidden group that's in no snapshot,** such as one whose sessions have all gone, or a repo that sessions only worked in, in a [View preferences](#view-preferences) mode that lists no session under it (W39, W42), is still listed, until it's unhidden: its link shows "No sessions" (meta, `--pw-text-subtle`) under its label, in place of a count, so the label keeps the item's width. Selected, it has the "No sessions in *group* now" empty state, and the header offers Show in repo list.
- **Unhide** puts the group back in its place in the list, with a toast (see [Session list](#session-list) for both toasts). Focus goes to its item, which becomes the list's Tab stop. A group with no sessions has no item, so focus goes to the next entry's Unhide, or the one before, or, once none is left and the section has gone, the list's Tab stop.
- **Storage:** `localStorage`, one key per root, `pitwall.hidden.v1:<root>`, where `<root>` is the group's `SessionGroup.root`, as the snapshot gives it (Phil). Its value: `{"v":1,"open":false,"groups":[{"key":"/Users/example/code/old-repo","label":"old-repo","kind":"git"}]}`.
  - `groups` holds each hidden group's key, its absolute path, with its label and kind, so it can be listed while it's absent from the snapshot. Paths and labels only: no session's name, title or prompt. `open` is whether the section is open.
  - A pitwall watching several roots reads each root's key, and writes a group to its own root's. Opening or closing the section writes `open` to each root with something hidden, and hiding a group opens it; the section starts open when any root with something hidden says so.
  - Not pruned: unlike `pitwall.finished.v1`, an entry stays until it's unhidden, even while its group is absent.
  - When storage is missing or throws, nothing starts hidden, hiding still works for the page's life, and nothing throws. A value that isn't this shape, or another version, hides nothing.
  - Storage is per origin too, so a pitwall on a fallback port starts with nothing hidden; a fixed `--port` keeps the list.
- **Below 900 px** it's in the drawer with the rest of the list, and the drawer's Tab trap goes through its controls, skipping them while it's closed. Below 1,200 px the session view over the list makes it inert with the rest of the repo list where it reaches it, below 1,000 px (see [Session view](#session-view)).

### Finished section

- **Toggle row:** at the bottom of the session list, a `<button aria-expanded aria-controls>` "Finished (*n*)", plus " · *n* asked you" when any did.
  - Padding 6 px 16 px, meta size, 500, `--pw-text-muted`, a top `--pw-border`, hover `--pw-surface-hover`, and the `expand` icon, rotating 90° when open.
  - Collapsed by default, and remembered for each selection in `localStorage` (`pitwall.finished.v1`).
- **Groups no longer collapse.** The repo list is the overview that collapsed groups used to give, so `pitwall.groups.v1` is no longer read or written.

### Session view: header, tabs and footer

**Header** (sticky, `--pw-surface`, a bottom `--pw-border`, padding 12 px 16 px):

1. **Line 1:**
   - The name (l 16/24, 600), then " · " and the title (l 16/24, 400, `--pw-text-muted`), on one line: the title gives way first, then the name, each with an ellipsis, and the full title is in a tooltip when it's cut. The " · " is drawn with the title (`::before`, not read out), so it goes when the title has; screen readers get it from visually hidden text.
   - At the right: the `more` icon button (md, ghost) opening the actions menu, then the `close` icon button ("Close", Escape in its tooltip). At ≤ 600 px, "Back to sessions" at the start replaces Close.
   - The heading is the region's label (`aria-labelledby`) and takes focus when the view is opened from a row (`tabindex="-1"`, no visible ring on the heading itself).
   - A copy's result is a [toast](#toasts): "Copied", or "Couldn't copy; the text is selected" as an error toast. When the copied text isn't on screen (the session ID, the attach command), a refusal also shows it, selected, below line 2, "Session ID: *id*" in code style, until the next copy.
2. **Line 2, 8 px gaps, wrapping:**
   - The status badge.
   - Then the row's other badges: "Asked you" (outline) for a finished session that asked, and "Stale" (subtle neutral), each followed by an info button (`InfoTip`) whose name and tooltip are its explanation, the row's hover-only hint.
   - The kind as meta text in `--pw-text-subtle` ("Interactive" or "Background"). An interactive session adds an info button (`InfoTip`), so Tab reaches it: its name and its tooltip are "Typing /bg in its terminal moves it to the background, so pitwall can attach to it and stop it."
   - "Active 5m ago" (meta, `--pw-text-subtle`, a [timestamp](#timestamps), the absolute time in its tooltip).
   - The cwd (path type, `--pw-text-subtle`, middle ellipsis, the full path, home and all, in a tooltip) with a [copy button](#copy), "Copy path". It takes the rest of the line, or a line of its own below 16em.
   - When the directory no longer exists (`cwdMissing`): "Directory no longer exists" (meta, `--pw-text-muted`), its own item so it wraps rather than squeezing the path, with "The working directory no longer exists, for example after a worktree was removed." in a tooltip.
3. **Where it worked** (W34, W39), once its scan finds repos beyond where it started: "Started in *start* · worked in *repo*, *repo*", meta in `--pw-text-subtle`, the labels in `--pw-text-muted` 500, newest touch first. *start* is the group it started in, from the snapshot, whichever group [View preferences](#view-preferences) lists it under, as the repo list labels it (the root's own directory as its path). The line is the same in every mode. Each *repo* is a repo the session worked in, by its label (`WorkedIn.label`), whether or not it has a group: a repo that sessions only worked in has none, and is named all the same. A repo that is itself a root shows the root's path, as the repo list does. It wraps; nothing in it is cut. The " · " is drawn, and screen readers hear ", and" instead. Then an info button (`InfoTip`) whose name and tooltip are the rule and where to look: "A repo counts when the session changed it, or when at least 5% of its tool calls touched it, its sub-agents' included. View preferences, in the header, sets which of these repos list the session; to find every session that worked in a repo, type its name in the filter on All sessions." A session that worked in no other repo, or hasn't been scanned yet, has no line 3.
   - The names are text, never markup and never links: selecting one does nothing, beyond selecting its text. A repo here may have no group to go to, and the [filter](#search) is what finds the sessions that worked in one.
4. **When the session has left the snapshot:** an inline neutral alert, `role="status"`: "This session is no longer listed, so this is what it showed last."

**Actions menu** (`more`, "Session actions", a [menu](#menus)): Copy session ID (`copy`), Copy attach command (`terminal`); then, in three columns, a separator and Make view wider, Make view narrower and Reset view width (no icons; see the [divider](#session-view)); then a separator, then Stop session (`stop`) and Remove session (`remove`, in danger text).

- **Copy session ID** copies the full session id. **Copy attach command** copies `claude attach <shortId>`, and is there only for a background session whose short id passes `attachCommand()`'s shell-safety check.
- **Stop session and Remove session** are for background sessions that are still listed. Each opens its [inline confirmation](#inline-confirmation). Stop is `aria-disabled` while the session isn't running, and both are while one of them is in progress, with the reason in a tooltip.
- **An interactive session's menu** (W40): Copy session ID, the width items in three columns, then a separator and Stop session, always `aria-disabled`, since pitwall can't stop a session that runs in a terminal. Its tooltip, which describes it, says why and how: "An interactive session can't be stopped here. Type /bg in its terminal to move it to the background, then stop it here." It keeps Stop's icon and place, so the menu reads the same for both kinds, and a voice command for "Stop session" finds it. There's no Remove session, which is `claude rm`'s, for background sessions only. Once the session is no longer listed, Stop goes too.

**Tabs** (a row under the header, sticky, padding 0 16 px, a bottom `--pw-border`, 40 px tall):

- **Tab:** 28 px tall, padding 4 px 8 px, m 14/20, 500, a 16 px icon before the label.
  - Inactive: `--pw-text-muted`; hover fill `--pw-surface-hover`, `--pw-radius-lg`.
  - Active: `--pw-text`, with a 2 px `--pw-text` underline on the row's bottom edge, over the border.
- **"Conversation"** (`conversation`) and **"Terminal"** (`terminal`).
  - An interactive session's Terminal tab is `aria-disabled`, with a tooltip that describes the tab (`aria-describedby`), so it's in the DOM before it shows: "An interactive session can't be attached here. Type /bg in its terminal to move it to the background, then attach to it here." So is a background session's when the app can't attach, or once it's no longer listed. Activating a disabled tab does nothing. Stop session's tooltip in the actions menu says the same of stopping.
  - While attached, the Terminal tab shows an 8 px `--pw-success-fg` dot after its label, and a visually hidden ", attached".
- **ARIA and keys:** the [Tabs](#tabs) pattern, with `aria-label="Session view"`. Opening is manual, never on focus, because opening Terminal attaches.
- **Switching** from Terminal to Conversation detaches, as Detach does. Opening Terminal attaches; for a session that isn't running it first shows the restart confirmation, which the server asks for when the socket opens (D9).
  - Detach, Back to the conversation and the restart's Cancel go back to Conversation, with focus on the Terminal tab. F6 in the terminal moves focus to the Terminal tab too, but leaves the terminal open and attached.
  - Back on Conversation, the conversation is where it was left: at the bottom if it was there, with what arrived meanwhile; otherwise at the same place, with what arrived counted on the "Jump to latest" bar. Its panel is `hidden` behind the Terminal tab, which leaves it no size and lets the browser drop its scroll position, so nothing counts as the reader moving while it's hidden, and it's put back before it's painted.
  - The view opens on Conversation, so opening a session, from a row or the URL, never attaches.

**Body:** scrolls; padding 12 px 16 px 24 px; `overscroll-behavior: contain`. It holds the [conversation](#conversation) or the [terminal](#terminal), each in its `role="tabpanel"`. The conversation's panel is a Tab stop (`tabindex="0"`, `--pw-ring-focus-inset`), so it can be scrolled from the keyboard.

**Footer** (sticky, `--pw-surface-muted`, a top `--pw-border`, padding 12 px 16 px, 8 px 16 px on short windows):

- At most half the view's height; past that, it scrolls inside itself.
- Interactive sessions: the [message box](#message-box).
- A session that can't be messaged: a meta note, "It isn't running, so it can't be messaged."
- Background sessions, and sessions that are no longer listed: no footer. The header's alert says why for the second.
- **A draft is never lost to the session going** (W31): when the session stops running, or leaves the list, while the message box has a draft, the box stays, with the draft in it, still editable, so it can be copied. A meta note above it says why it can't be sent, linked to the textarea: "It isn't running any more, so this can't be sent. Your text stays here until you clear it." or "It's no longer listed, so this can't be sent. …", and Send is `aria-disabled`, its tooltip saying the same. Escape and the shortcuts still keep it (6.2). Cleared, the note or no footer takes its place, as above. A draft the tab kept (W44, [message box](#message-box)) keeps the footer the same way, in a view opened again after its session left the list.

### Message box

The composer in the session view's footer, for interactive sessions. Messages go through pitwall's relay.

- **Region:** a `<section>` named by a visually hidden heading "Message this session".
- **Order, top to bottom:**
  1. **The latest exchange:** "Message from pitwall · 5m ago: *status*" (meta, `--pw-text-muted`; the status in `--pw-warning-fg` while waiting, `--pw-danger-fg` if it failed, with no band behind it). Below it, the reply (body, after "Reply:" in `--pw-text-muted`, 500, so it isn't read as the message pitwall sent), at most three lines (two on short windows), scrolling past that. While it scrolls, it's a Tab stop, a region named "Reply", as the page alerts are (`ScrollBox`).
     - Show the reply once: when the conversation already shows it, the footer shows only the status line. It does when one of Claude's entries since the send has the reply's text, whitespace collapsed: the whole entry, or, for a reply of 40 characters or more, part of one. A reply that's only in the session's `SendMessage` call isn't in its conversation, which shows a tool call by its name, so it stays in the footer.
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
- **Speaker line** on each text entry (yours, Claude's, another session's): label style (xs 12/20, 500, `--pw-text-muted`): "You", "Claude", or "From *name*" (the sender's name as written, as text; "From another session" when there's none), then " · 11:06" in `--pw-text-subtle`, 2 px above the text. The time is a [timestamp](#timestamps) with `format="time"`: always visible, not only on hover, with the full date and time in its tooltip. An entry with no time, or one that isn't a time, has the name alone. Notices and tool calls have no speaker line.

| Entry | Look |
|---|---|
| Your message | `--pw-surface-sunken` fill, `--pw-radius-md`, padding 8 px 12 px, body text |
| Claude | No fill, body text |
| From another session | `--pw-surface-sunken` fill, `--pw-radius-md`, `inset 3px 0 0 var(--pw-info-fg)`, padding 8 px 12 px, body text |
| Tool calls | Folded (below) |
| Notice | Meta (s 13/20), `--pw-text-muted` |
| Cut short | A trailing "Cut short." in meta, `--pw-text-subtle`, after the text of an entry whose `truncated` is set |

- **Text:** body, `overflow-wrap: anywhere`, never HTML. Your messages and notices are plain text, `white-space: pre-wrap`, so a prompt shows as typed, its indents and blank lines kept and its markdown not read. Claude's messages and other sessions' are markdown, which the server flags (`markdown`), shown as pitwall's own elements (see [Markdown in messages](#markdown-in-messages)). The speaker line wraps anywhere too, for a long sender name.
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

### Markdown in messages

- **Component:** `Markdown` (`web/src/components/Markdown.tsx`), on the tree that `web/src/markdown.ts` parses, inside the entry's text (`.entry-text.entry-markdown`). It's for Claude's messages and other sessions' only, which the server sends as written with `markdown` set (W36). Your messages, notices, tool calls, the relayed reply and every other text stay plain text.
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
- **Links:** only absolute `http:` and `https:` URLs, from `[text](url)`, `<url>` and bare URLs, become links, as the browser parses them (`new URL()`), so an internationalised host is in punycode. Each opens in a new tab with `rel="noopener noreferrer"`, in `--pw-link`, underlined 2 px below the text (2 px thick on hover). Its [tooltip](#tooltips), on hover and on focus, and its description, is the full URL it opens, since its text can say anything (as `links.ts` does for the terminal). Any other link (`javascript:`, `data:`, `mailto:`, a relative path) shows as the text it was written as, its target included.
  - A bare URL can't follow a letter or a digit. It runs to a space, `<`, `>`, `"` or a backtick, none of which a URL holds as written (a URL has them percent-encoded), and leaves out trailing punctuation, `'` included, and a `)`, `]` or `}` it didn't open (W37). So the URL in an HTML attribute (`href="https://example.com/docs">`), in JSON (`{"url":"https://example.com/a"}` or `{'url': 'https://example.com/a'}`) or in backticks in a draft links to just the URL, and `https://example.com/users/{id}` stays whole. GFM allows only a space, `*`, `_`, `~` or `(` before one; a quote or a bracket is allowed here too.
  - Links don't nest: one inside a link, such as a linked badge's image, gives only its text, and code inside a link's text stays plain code.
  - **In code** (W37): bare URLs in a code block or in inline code are links too, under the same rule, so a draft or a command Claude puts in code can be opened from it, as a terminal makes a URL clickable wherever it is. Code is literal, as in CommonMark and GitHub, so only bare URLs: markdown's own link syntax in code, `[text](url)`, `<url>` and `![alt](url)`, stays the text it is, and so does any other scheme. The code's text doesn't change: the links are its own characters, its whitespace, line breaks and language label are as they were, and it still scrolls sideways in its own box.
    - **Look:** the code's mono face and size, in `--pw-link`, underlined as every link is. The underline is what tells them apart from the code around them: `--pw-link` is only 2.37:1 (light) and 2.93:1 (dark) against the code's `--pw-text`, short of the 3:1 that colour alone would need (WCAG 1.4.1; 6.1, rule 2). On the code's fill they're 7.46:1 on `--pw-surface-muted`, 7.14:1 on inline code's `--pw-surface-sunken` and 7.78:1 on `--pw-surface` in another session's message, in light; 5.28, 4.99 and 5.51:1 in dark. These are neutral surfaces, so the 2.5 row for `--pw-link` covers them.
    - **Focus:** a link in a code block takes the inset ring, `--pw-ring-focus-inset` with the outline at `-2px`, as the box itself does: the box clips what's drawn past it, and the code's first line has no padding above it, so the outer ring would lose its top there. A link in inline code has the outer ring, as a link in text does.
    - **Tab order:** a code block's Copy button, then the box while it scrolls, then each link in the code, in its order. That's the order they're in, so nothing is reordered, and the box keeps its own stop, so the code can still be scrolled from the keyboard where it has no link. Focus on a link the box doesn't show scrolls the box to it, never the page.
- **Images** are never loaded: an image is its alt text, linked under the link rule, or its URL as written when it has no alt text.
- **Shown as text:** raw HTML, entities, reference links and footnotes, setext headings, indented code, a single `~`, and task-list markers (`[ ]`, `[x]`). A bare URL in any of them is still a link, as in any text: in raw HTML's `<a href="https://example.com">`, the link is pitwall's own, to the URL alone.
- **In another session's message,** whose box is `--pw-surface-sunken`, code blocks and inline code are on `--pw-surface`, so they stand out from it.
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
| Relay blocked a changed copy (`'changed'`, `blocked: true`) | warning | "pitwall blocked a changed copy of your message" | "Its relay's copy didn't match what you sent, so pitwall's gate stopped it, and nothing was sent.", then the same structure. pitwall raises none today: see below |

- **Which one:** the relay alert's `cause` (W43). `unrequested` is a `SendMessage` call with no request of pitwall's behind it, which usually means another session messaged the relay. `changed` is the call for one of your messages, which didn't match it, or which pitwall's gate didn't check, and which the gate didn't stop or pitwall couldn't confirm it stopped. Only `unrequested` mentions another session.
- **A changed copy the gate blocked raises no alert,** and nor does one pitwall stopped before it ran: nothing was sent, and the message's own result, in the message box, says so. pitwall tries a blocked copy once more first, and the result then says where the copy first differed. The `changed`, blocked wording is there in case one is raised.
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
- **Box:** for Stop and Remove, directly under the header (above the tabs), with 8 px 16 px around it. For the restart, at the top of the Terminal tab's panel, under its bar, since that tab's attach is what waits for it. `--pw-surface-muted` fill, `inset 0 0 0 1px var(--pw-border-strong)`, a left bar `inset 3px 0 0 var(--pw-danger-fg)` (or `--pw-warning-indicator` for the restart), each at least 3:1 on the fill (2.5), `--pw-radius-md`, padding 12 px.
- **Content:** a question as the title (m 14/20, 500), the consequence (meta, `--pw-text-muted`), then the buttons at the right, wrapping under the text when there's no room: outline sm "Cancel", then the sm confirm button with its action's icon (`stop`, `remove`, `restart`), 8 px apart.

| Action | Question | Consequence | Confirm button |
|---|---|---|---|
| Stop | "Stop this session?" | "Its conversation is kept. Attaching to it later asks before restarting it." | danger "Stop session" |
| Remove | "Remove this session?" | "It leaves the list. Claude Code keeps a worktree that has unpushed commits." | danger "Remove session" |
| Attach to a session that isn't running | "Restart and attach?" | "This session has finished, or its process has exited. Attaching restarts it." | primary "Restart and attach" |

- **Focus:** Cancel takes focus when the confirmation opens.
  - Escape cancels it, without closing the view, wherever focus is in the page.
  - On cancel, focus goes back to whatever opened it (the actions menu button, or the Terminal tab), without opening that control's tooltip (`focusQuietly`).
- **Semantics:** `role="group"` with `aria-labelledby` (the question) and `aria-describedby` (the consequence). For the restart, `role="alertdialog"`.
- **Busy:** the confirmation stays while its action runs, and the confirm button shows the busy state ("Stopping…", "Removing…", "Restarting…"). Cancel is `aria-disabled`, and Escape does nothing, since the request is already out; the view stays open. The restart stays busy until the attach has started or failed.
- **Result:** the confirmation goes, and focus goes back to the actions menu's button; Remove closes the view instead.
  - Stopped: a [toast](#toasts), "Stopped. Its conversation is kept."
  - Removed: a toast, "Removed *name*", as the view closes.
  - Refused: an inline danger alert, `role="alert"`: "Couldn't stop the session." (or remove), then Claude Code's message in code style.
  - **When the view has gone** while the request was out (Close, Back, `/` or the browser's back button), the result still arrives, from the app's toasts, which outlive the view, and names the session, since nothing on screen says which it was: "Stopped *name*. Its conversation is kept.", "Removed *name*", or an error toast, "Couldn't stop *name*. *Claude Code's message*" (or remove), its message as text, or "Couldn't stop *name* (HTTP 502)." when the server gave no reason.
  - `j`, `k`, ↑ and ↓ do nothing while the action runs, as they do for a draft, so they never move the view away from it.
  - A restart that fails ends the attach, whose notice says why, and Attach again takes focus.
- **No type-to-confirm.** pitwall's destructive actions are recoverable or guarded by Claude Code.

### Dialogs

- **Component:** `Dialog` (`web/src/components/Dialog.tsx`), with `title`, `subtitle`, `size`, `busy`, `dirty`, `footerMeta`, `actions` and `onSubmit`, which makes the body and footer a form. The New session dialog and the keyboard shortcuts dialog are built on it.
- **Backdrop:** `--pw-backdrop`, `--pw-z-backdrop`, centring the card with 48 px top and 16 px side margins.
- **Card:** `--pw-surface-overlay`, `--pw-shadow-3`, `--pw-radius-lg`, `--pw-dialog-md` (624 px) wide, or `-sm` or `-lg`, never wider than the window less its margins, at most `calc(100dvh - 96px)` tall, `--pw-z-dialog`.
- **Sections,** divided by 1 px `--pw-border`. The header and footer are plain elements, not `<header>` and `<footer>`, which outside a sectioning element would be the page's banner and contentinfo landmarks:
  - **Header:** padding 12 px 16 px; the title (l 16/24, 600); a ghost md `close` icon button at the right, "Close", with Esc's key cap in its tooltip; an optional meta subtitle in `--pw-text-muted`, which describes the dialog (`aria-describedby`).
  - **Body:** padding 16 px, scrolls, fields 16 px apart.
  - **Footer:** padding 12 px 16 px; optional meta text at the left, in `--pw-text-subtle`; at the right, outline "Cancel" then the primary action, 12 px apart. A dialog with nothing to submit, such as the keyboard shortcuts dialog, has no footer: it has neither `actions` nor `footerMeta`.
- **Behaviour:**
  - `role="dialog"`, `aria-modal="true"`, `aria-labelledby` (the title).
  - Focus moves to the first field on open, Tab and Shift + Tab are trapped inside, and focus returns to the opener on close, without opening the opener's tooltip (`focusQuietly`), which would take the next Escape: one more Escape then goes on to what's behind, such as the session view.
  - Escape closes it, except while submitting (and it doesn't also close the session view behind).
  - A click on the backdrop closes it only when nothing has been typed. A press that starts in the card and ends on the backdrop, as when selecting text, isn't a click on it, and a press on the backdrop doesn't take focus out of the dialog.
- **Busy:** the primary button's busy state; the other controls are `aria-disabled`, Close included, and the text fields are read-only. Escape and the backdrop do nothing.
- **Failure:** an inline danger alert, `role="alert"`, at the end of the body, above the footer.

**New session dialog:**

- **Fields:**
  - Directory: a select of the groups' directories, plus "Another directory under a root…", which reveals a mono path field. Help text: "Under *roots*.", linked to both.
    - With [root tabs](#root-tabs), the open tab's root alone: its groups' directories, then its root, and "Under *root*.". A typed directory must be in that tab, under its root and under no other root inside it, where the index would list the session: "Use a directory under ~/work. ~/personal has its own tab." (W38).
  - Name: optional, placeholder "Claude Code names it from the prompt".
  - Model: optional; a select of Default, the aliases, and "Other…", which reveals a mono field.
  - First prompt: a textarea, 6 rows.
- **Problems** show after the first submit, then follow the typing; a submit, or ⌘/Ctrl + Enter, puts focus on the first field with one. Each is linked to its field with `aria-describedby`, and the field is `aria-invalid`.
- **Intro:** the subtitle: "Starts a background session with `claude --bg`, which you can open from the list."
- **Footer:** "⌘ ↵ to start" as key caps (Ctrl on other platforms) at the left; "Cancel" and "Start session" ("Starting…" while busy) at the right. ⌘/Ctrl + Enter submits from any field.
- **Failure:** "Couldn't start the session." then the server's message in code style; or pitwall's own sentence, such as "Couldn't start the session (HTTP 500)."
- **Trust failure:** the same alert, then "pitwall never trusts a directory for you. Run this in a terminal, accept Claude Code's trust prompt, then start the session again:", with the command in a [command chip](#copy) and its copy button, "Copy command".
- **Started:** the dialog closes, a toast says "Started *name*. Its view opens when it shows up in the list.", and the view opens once the session is listed. It takes no focus, unless focus has been left on the page, as when the session was started from the no-sessions empty state, whose button goes as the session is listed: then its heading takes it.

### Menus

- **Component:** `MenuButton` (`web/src/components/Menu.tsx`), which takes the button's icon and name and a list of items, separators and radio groups. The session view's actions menu and the header's [View preferences](#view-preferences) use it; anything that later needs a menu builds on it.
- **Panel:** `--pw-surface-overlay`, `--pw-shadow-2`, `--pw-radius-md`, padding 4 px, min-width `--pw-menu-min-w` (192 px), `--pw-z-dropdown`. It opens 4 px below the button, aligned to its end edge, and flips up when the button is on screen and there's no room below but there is above. When aligning to the button's end would cut it off at the window's start edge, as for a button near the start of a narrow window, it moves in to 8 px from that edge.
  - A menu whose radio options have lines saying what they do is as wide as its content up to 20rem, and never wider than the app leaves, 16 px each side (`100cqw`), so the lines wrap and nothing scrolls sideways at 320 px.
- **Items:** 32 px tall, padding 6 px 8 px, `--pw-radius-sm`, m 14/20, a 16 px icon in `--pw-text-muted` 8 px before the label. An item with no icon of its own, in a menu whose other items have them, keeps an icon's room, so the labels line up.
  - Hover and keyboard highlight: `--pw-surface-hover`. Keyboard focus also shows `--pw-ring-focus-inset`, since the panel's 4 px padding would clip the outer ring, and a hover fill alone is under 3:1.
  - Danger items: `--pw-danger-fg` text and icon; highlighted, a `--pw-danger-tint` fill with `--pw-danger-tint-fg` text and icon, the pair 2.5 checks.
  - Disabled items: `aria-disabled`, `--pw-text-disabled`, no highlight on hover, the reason in a [tooltip](#tooltips), on hover and when the arrows reach the item, which it describes (`aria-describedby`). The arrows still reach them, and activating one does nothing and keeps the menu open.
- **Separator:** `role="separator"`, 1 px `--pw-border`, 4 px above and below.
- **Radio group** (W42): a `role="group"` named by its title, which shows above its options in label type (s 13/20, 500, `--pw-text-muted`, padding 6 px 8 px 4 px) and is `aria-hidden`, so it's heard once, as the group's name. Each option is a `role="menuitemradio"` item, `aria-checked`, named by its label (`aria-labelledby`) and, when it has one, described by its line (`aria-describedby`, s 13/20, `--pw-text-muted`, under the label, wrapping). The chosen option has a 16 px `checked` mark in the icon's place and its label at 500; the others keep the icon's room. Items and options highlight alike, and the arrows go through both.
- **Semantics:** a `<button aria-haspopup="menu" aria-expanded aria-controls>` (ghost md icon button, `aria-label` and the same tooltip) opening `role="menu"`, named like the button, with `role="menuitem"` items, each `tabindex="-1"`.
  - Opening, by a click, Enter or Space, focuses the chosen option of a radio group, or else the first item, without scrolling the page. The button's tooltip closes as the menu opens.
  - ↑/↓ move, wrapping at the ends; Home and End jump; Enter or Space activates; Escape and Tab close. ↑/↓ on the closed button don't open it, so the session view's header can use them.
  - Focus returns to the button on close, without opening its tooltip, which would only be one more thing for the next Escape. An item runs after that, so one that opens something, such as a confirmation, can move focus on from there. Choosing a radio option closes the menu the same way, then calls its change, only when the choice changed. Tab goes on from the button to the next control.
  - A press outside closes it, leaving focus where the press puts it. Escape is handled in the menu, so nothing behind it closes too, and it closes a disabled item's tooltip with the menu.
  - A [single-key shortcut](#62-keyboard-map) that moves focus elsewhere closes it first (`closeMenus()`), putting focus back on its button as Escape would, so a dialog the shortcut opens gives focus back there. One with nowhere to go, such as `j` on the last session, leaves it open.

### View preferences

The header's menu of how the page shows sessions (W42, Phil, 2026-10-21: "can we make the options we have configurable? some sort of view preferences?"). It holds one setting, Group sessions by. Sort stays in the [session list](#session-list).

- **Where:** in the [header](#header)'s right side, after the theme switch and before the keyboard shortcuts button, from the first render. At 600 px and narrower it wraps with the rest of the right side.
- **The button:** a ghost md `preferences` (tune) [icon button](#icon-buttons), named "View preferences" by its tooltip and `aria-label`, with `aria-haspopup="menu"`, `aria-expanded`, and `aria-controls` while open: a [menu](#menus) button.
- **The menu:** one [radio group](#menus), "Group sessions by", with three options, each with one line saying what it does:
  - **Main repo,** the default: "A session started in a root goes under the repo it changed most."
  - **Where it started:** "Each session stays under the repo or directory it started in."
  - **Every repo it worked in:** "A session shows under every repo it worked in, so counts can overlap."
  - What each mode lists where is in [Repo list](#repo-list), and its counts in [Repo list items](#repo-list-items).
- **Keyboard and mouse:** a click, Enter or Space on the button opens the menu, with focus on the chosen mode. ↑ and ↓ move through the modes, wrapping, and Home and End jump to the ends. A click, Enter or Space chooses one: the menu closes, focus goes back to the button, and then the page regroups. Escape or Tab closes it without choosing. As with any menu, a single-key shortcut that moves focus closes it first.
- **Widths:** below its button, aligned to its end, and moved in from the window's start edge when that would cut it off, so at 320 px it's 8 px from the edge, its lines wrap, and nothing scrolls sideways.
- **Instant:** the page groups the snapshot itself (`web/src/groupBy.ts`), so a switch asks the server nothing, and each snapshot that follows is grouped the same way. The server still lists each session where it started, and names the root each worked-in repo sits under (`WorkedIn.root`), so the page can build a group for a repo the snapshot has none for.
- **What every mode keeps:** Needs you and All sessions list each session once, each row naming the group it's listed under; the filter, which finds a session by any repo it worked in; the session view's line 3; Sort; hidden groups, by key; the [root tabs](#root-tabs), each showing its root's groups in the mode, its badge counting each session once; and a `?session=` link, which selects the group the session is listed under.
- **Switching:**
  - The selected group stays selected when the new mode lists it, as a repo does in every mode.
  - When it doesn't, as a group the page built for Main repo doesn't in Where it started, All sessions in the same root tab is selected instead, replacing the URL's history entry rather than pushing one, and a [toast](#toasts) says so: "Selected All sessions: *group* has no sessions when grouped by *mode*." (for example "… grouped by where it started.").
  - Another root tab's selection that the new mode doesn't list is replaced the same way, without a toast, for when that tab is back.
  - Focus stays on the View preferences button, never the page. An open session view stays open, on the same session, whichever group or tab it moves to.
- **Storage:** `localStorage` as `pitwall.group-by.v1`, holding the mode alone: `main-repo`, `where-started` or `every-repo`. Missing or throwing storage, or any other value, gives Main repo, as `pitwall.finished.v1` falls back. Storage is per origin, so a pitwall on a fallback port starts on Main repo.

### Toasts

- **Component:** `ToastProvider` and `useToast()` (`web/src/components/Toast.tsx`). The Dashboard keeps the stack inside the app, from its first render.
- **Placement:** a stack at the bottom right, 24 px from the edges (16 px and full width when the app is 600 px wide or narrower), newest at the bottom, 12 px apart, at most three (the oldest goes first), `--pw-z-toast`. Only the toasts take the pointer, not the stack around them.
- **Card:** `--pw-surface-overlay`, `--pw-shadow-3`, `--pw-radius-md`, `--pw-toast-w` wide, padding 8 px.
  - A 28 px icon tile (`--pw-<tone>-tint` with `inset 0 0 0 1px var(--pw-<tone>-border)`, `--pw-radius-sm`, a 16 px icon in `--pw-<tone>-tint-fg`): `success`, `info`, or `error` on the danger tokens.
  - The message (m 14/20, 500), 12 px after the tile, as text.
  - A ghost sm `close` button, named "Dismiss" by its tooltip. Focus it had goes to the next toast's Dismiss, or the one before, or the session list's heading (the view's, while the view covers the list).
- **Timing:**
  - Success and info toasts dismiss after `--pw-toast-timeout` (4 s). The time stops while the pointer is over the stack or focus is inside it, and goes on from where it was.
  - Error toasts stay until dismissed.
  - The same message again replaces the toast that says it, so it's announced again without stacking.
- **Live region:** the stack is an `aria-live="polite"` region that always exists in the DOM, so a toast's text arrives in a region that was already there and is announced; error toasts use `role="alert"`.
- **Use them for** results the user isn't looking at: "Copied", "Couldn't copy; the text is selected" (an error), "Stopped. Its conversation is kept.", "Started *name*. Its view opens when it shows up in the list.", "Removed *name*", a Stop or Remove's result, a refusal included, when its view has gone (see [Inline confirmation](#inline-confirmation)), hiding a group from the repo list or showing it again, saying where it went (see [Session list](#session-list)), and a switch of [View preferences](#view-preferences) that selects All sessions in place of a group the new mode doesn't list.
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
- **Spinner:** `Spinner` (`web/src/components/Spinner.tsx`), a 12 px (inline) or 16 px (in a button) ring: a 2 px conic gradient from transparent to `--pw-info-fg`, or to the text colour of the badge or button it's in (2.1; `--pw-info-fg` on a primary button's accent fill would barely show), turning 0.8 s per turn. It's `aria-hidden`; the busy element carries `aria-busy` or a status message.
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
- **Focus after an action,** since the action's button goes with the empty state: Clear filters and Search all sessions put it in the filter field; Show all sessions on the session list's heading. New session opens its dialog, which returns focus to it; once the session it started is listed, the empty state goes and its button with it, so focus moves to the new session view's heading.

| Where | Icon | Title | Sentence | Action |
|---|---|---|---|---|
| No sessions under the roots | `terminal` | "No Claude Code sessions under *roots*" | "Start one here, or start Claude Code in any terminal under these directories and it appears here." | primary "New session" (`add`), which opens the New session dialog |
| The filter matches nothing | `search` | "No sessions match" | "Nothing in *selection* matches "*text*" with these filters." Without a chip on, it ends at "*text*"; with no text, "Nothing in *selection* matches these filters." | outline "Clear filters", which clears the text and the chips; in a group with text in the field, outline "Search all sessions" too, which selects All sessions and keeps the text |
| A selected group has left the snapshot | `directory` | "No sessions in *group* now" | "Its sessions are no longer listed under these roots." In Where it started a root's own group lists every session started in the root (W39), so it empties only when they've gone. | outline "Show all sessions", which selects All sessions |
| A selected root's own group the [View preferences](#view-preferences) mode empties | `directory` | "No sessions in *group* now" | "Its sessions are listed under the repos they changed most, as View preferences groups them." In Every repo it worked in, "… the repos they worked in, …". The snapshot still has the group: every session started there worked in repos (W42). | outline "Show all sessions" |
| Needs you, and nothing does | `success` | "Nothing needs you right now" | "Sessions that are waiting for you, or asked you something, show here." | outline "Show all sessions" |
| The session view column, nothing open | `conversation` | "Select a session" | "Its conversation, terminal and actions open here." | none |
| The session view, unlisted (see [Session view](#session-view)) | `info` | "This session isn't listed under these roots", the view's heading | "pitwall lists no session with the id `<id>` under *roots*; it may have been removed, or run outside these roots." | none; Close is in the header |
| Conversation, nothing yet | | | "Nothing to show yet." (status line) | none |
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
| No token: opened without one, or a browser restart lost it | "This tab has no token for pitwall." | "Paste the link pitwall prints when it starts into this tab. On a single-user machine, a fixed `PITWALL_TOKEN` keeps a pinned tab working when pitwall restarts." |
| Token rejected: the WebSocket closed with 4401 | "pitwall rejected this tab's token." | "Each run of pitwall has its own token, so this usually follows a restart. Paste the link pitwall printed when it started into this tab; on a single-user machine, a fixed `PITWALL_TOKEN` keeps a pinned tab working when pitwall restarts." |

- **The link** is the URL the CLI prints when it starts, with the token in its fragment, which the page takes out of the address bar ([Session view](#session-view)). Pasted into the tab, it connects it, whether the browser loads the page again or only changes its fragment (`token.ts` reads a new fragment either way).
- **A fixed token:** with `PITWALL_TOKEN` set, every run that uses it has the same token, so a tab that holds it reconnects by itself after a restart, on the same port. The CLI and `npm run dev` say at start that the token is fixed, and to use this only on a single-user machine or for development.
- **The connection badge's** Token rejected state shows only in the gallery: in the app, the notice replaces the page.

### Key caps

- **Component:** `KeyCaps` (`web/src/components/KeyCaps.tsx`), which takes the keys and their text alternative.
- **Shape:** a `<kbd>`, 20 px tall, min-width 20 px, padding 0 5 px, `--pw-radius-xs`, label style (xs 12/20, 500), `--pw-text-muted` on `--pw-surface`, `--pw-shadow-control`, plus `inset 0 -1px 0 var(--pw-border-strong)`.
- **Combinations:** keys in a combination are 2 px apart, with no "+" between them.
- **Platform:** ⌘ on macOS, "Ctrl" elsewhere (from `navigator.userAgentData?.platform ?? navigator.platform`); ↵ for Enter, ↑ ↓ ← → for the arrows, "Esc" for Escape.
- **Screen readers:** inside tooltips and help lines, give the combination a text alternative ("Command Enter") with a visually hidden span.

### Copy

- **Every copy goes through `copy.ts`:** `useCopy()` writes to the clipboard `ClipboardContext` gives, the browser's by default, and the `#uikit` gallery gives a stub.
- **Copy buttons:** `CopyButton` (`web/src/components/CopyButton.tsx`), a ghost sm icon button (`copy`), named by its tooltip with what it copies ("Copy attach command", "Copy session ID", "Copy path", "Copy command", and "Copy code" on a code block in a message).
  - After a successful copy, the icon becomes `copied` for `--pw-copied-timeout` (2 s) and a "Copied" toast appears.
  - If the clipboard refuses, select the text on screen and show "Couldn't copy; the text is selected" as the button's tooltip, which then describes it, until the next copy, and in an error toast.
  - The actions menu's Copy session ID and Copy attach command give the same toasts. Their text isn't on screen, so a refusal shows it under the session view's line 2, selected.
- **Command chips:** `CopyCommand`: code style, `--pw-surface-sunken`, `--pw-radius-sm`, padding 0 6 px, `user-select: all`, with a middle ellipsis and the full command in a tooltip when it's cut. A copy button follows.
- **Write inside the click handler** (Safari rejects a deferred write), and fall back to selecting the text.

### Timestamps

- **Component:** `Timestamp` (`web/src/components/Timestamp.tsx`).
- **Relative, in rows and meta:** "just now" under 5 s, then "42s ago", "5m ago", "3h ago" (under 48 hours), "2d ago".
  - Meta size, `--pw-text-subtle`, tabular, in `<time datetime>`, with the absolute time in a tooltip, on hover: times aren't focusable.
- **The header's "updated 7s ago"** counts in seconds below a minute, so it visibly ticks.
- **Absolute:** the user's locale, with seconds: "20 Oct 2026, 11:06:14". In the conversation's speaker line, only the time of day, in the user's locale ("11:06", or "11:06 AM"), with the full instant in the `datetime` and the absolute date and time in its tooltip (`format="time"`). It never changes, so it doesn't subscribe to the clock.
- **Updates:** relative times update every second from one shared clock (`web/src/clock.ts`): one interval for the page, running only while a time is on screen. Each timestamp re-renders itself on the tick, so nothing else does. They're never in a live region.

### Terminal

The Terminal tab's panel, for background sessions: xterm.js over `claude attach`. `SessionTerminal` (`web/src/components/Terminal.tsx`) draws the bar, the notices and the screen; `web/src/xterm.ts` makes the terminal.

- **Bar** (36 px, padding 4 px 0, 8 px gaps). It wraps when the panel is too narrow: the buttons go to a line of their own, still at the right.
  - A status [badge](#badges) (`Badge`), inside a `role="status"` region so each change is announced, as the connection badge's is: "Attaching…" (subtle neutral, spinner), "Attached" (subtle success, dot), "Detached" (subtle neutral), "Not running" (outline, while the restart confirmation asks).
  - A meta hint, an F6 [key cap](#key-caps) then "to leave the terminal", in `--pw-text-subtle`. It stays after the attach ends, since the screen still takes every key. It describes xterm.js's textarea, which is what has focus in the terminal (`aria-describedby`, set once xterm.js has opened), so a screen reader there hears how to leave.
    - Shift+↵ isn't in it. At 375 px the bar has about 46 px to spare beside the badge, the hint and Detach, so a second key would wrap the bar. The [shortcuts dialog](#keyboard-shortcuts-dialog) lists it (W41).
  - At the right, on `Button`: ghost sm "Attach again" (`retry`) once it has ended, then ghost sm "Detach", which reads "Back to the conversation" once it has ended. Both of those go back to Conversation (see [Session view](#session-view-header-tabs-and-footer)).
- **Screen:** fills the rest of the panel; `--pw-term-bg`, `--pw-radius-md`, padding 6 px, and a 1 px `--pw-border-strong` ring outside it (`box-shadow: 0 0 0 1px`). In the dark theme `--pw-term-bg` is the page's own `--pw-bg`, a shade darker than the view's `--pw-surface`, and the ring is what sets the screen apart; in the light theme the fill does. The ring is decorative (2.5), and ligatures are off (2.7).
  - xterm options: `fontFamily` from `--pw-font-mono`, `fontSize` 13, `fontWeightBold` 500, `cursorBlink` true, `scrollback` 5000, `theme` built from the `--pw-term-*` tokens (background, foreground, cursor, selectionBackground, red, green, yellow, blue; xterm's defaults for the rest), and links limited to http and https (`links.ts`, which asks first, naming the whole URL). Each is read with `getComputedStyle` when a terminal is created, and a token that isn't set is left to xterm's default. Nothing in the terminal's code names a colour or a font family; `web/src/xterm.test.tsx` checks.
  - **The font:** xterm.js measures its cells as it opens, so the terminal opens only once JetBrains Mono's 400 and 500 faces have loaded (`document.fonts.load()` with `--pw-font-mono`), or after 3 s, whichever is first. Otherwise its cells would be sized for the fallback font. A font that arrives after the 3 s makes it measure them again: its `fontFamily` is set to the same list with a trailing space, since xterm.js measures only when that string changes; then it fits the panel and sends the session the new size (W31).
  - **Bold** is drawn with the 500 face (`fontWeightBold: 500`), the heaviest one bundled (2.14). Asking for 700, xterm.js's default, would have the browser synthesise a heavier face from the 500 one.
  - The fit add-on keeps it sized to the panel.
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

### Keyboard shortcuts dialog

- **Component:** `ShortcutsDialog` (`web/src/components/ShortcutsDialog.tsx`), on `Dialog` with `size="sm"` (`--pw-dialog-sm`, 408 px), titled "Keyboard shortcuts". With nothing to submit, it has no footer; Close and Escape close it, and focus goes back to whatever opened it.
- **Opened** by `?` or the header's `keyboard` icon button.
- **The off switch** comes first, and takes focus as the dialog opens: a [checkbox](#inputs-textareas-and-selects), "Single-key shortcuts", that turns off `/`, `?`, `n`, `j` and `k` (WCAG 2.1.4, Character Key Shortcuts), with help text below it, indented to the label, linked with `aria-describedby`: "The keys under Anywhere, which are ignored while you type in a field. While they're off, the keyboard button in the header opens this dialog."
  - On by default. Stored in `localStorage` as `pitwall.shortcuts.v1`, `on` or `off`; anything else, nothing stored, or storage that's missing or throws reads as on, and a choice that can't be stored lasts until the page reloads.
  - One store holds it (`web/src/shortcuts.ts`), as the theme's does, so the checkbox, the filter field's key cap and every tooltip agree, and a change made in another tab arrives with the window's `storage` event.
  - While it's off, the Anywhere heading adds "Off" (meta, `--pw-text-muted`), and the rest of the map still works.
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

- **Buttons:** a verb, or a verb and object: "New session", "Start session", "Send", "Stop session", "Remove session", "Restart and attach", "Attach again", "Detach", "Copy", "Dismiss", "Try again", "Clear filters", "Load earlier", "Jump to latest".
- **Cancel** is always "Cancel".
- **Confirmations:** the confirm button repeats the question's verb and object: "Stop this session?" → "Stop session".
- **Progress:** the -ing form with an ellipsis: "Starting…", "Sending…", "Stopping…", "Removing…", "Attaching…", "Loading the conversation…", "Loading earlier…", "Trying again…".
- **Counts:** digits with the noun, singular and plural handled: "1 session", "12 sessions", "1 needs you", "2 need you", "3 tool calls", "2 of 5 sessions".
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

Past tense, short, and only when the result isn't already visible: "Copied", "Stopped. Its conversation is kept.", "Started *name*. Its view opens when it shows up in the list."

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
   - Where focus would go to the session list's heading (a dismissed toast, a choice in the drawer), it goes to the view's heading while the view covers the list.
   - Moving between sessions with ↑/↓ while focus is in the list leaves focus in the list.
   - A focused row that a snapshot takes out of the list, such as a session that moved to its repos, hands focus to the row that took its place, or the one before it, or the session list's heading (see [Session list](#session-list)).
   - Choosing in the repo list leaves focus there; in the drawer, focus moves to the session list's heading.
   - Hide from repo list and Show in repo list keep focus: it's the same button with its other name. Show in repo list for a group in no snapshot takes its button away, so focus goes to the session list's heading. Unhide in the Hidden section moves focus to the group's item, back in the list, or for a group with no sessions to the next Unhide, the one before, or the list's Tab stop (see [Hidden groups](#hidden-groups)). A focused repo list item that leaves the list hands focus to the one that took its place, or the one before it.
   - Opening a [root tab](#root-tabs) leaves focus on it. The back button switching tabs with focus in what that hides moves focus to the open tab.
   - Choosing a mode in [View preferences](#view-preferences) leaves focus on its button, whatever the switch does to the selection and the lists.
   - Dialogs trap focus and return it on close. Confirmations focus Cancel.
9. **Announcements:**
   - The connection badge is `role="status"`.
   - Results the user asked for are announced: send results, stop and remove results, copy, and a View preferences switch that replaces the selection. Stop, remove, copy, a started session and that switch are toasts, announced by the toasts' live region, which is always in the DOM.
   - Snapshot updates, ticking times and the list's re-sorting are never announced. The one exception is the conversation's count of new entries while you're scrolled up ("3 new"), once per batch (see [Conversation](#conversation)).
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
16. **Text is text:** session names, titles, prompts, replies and server messages render as plain text, never HTML. Markdown in Claude's messages and other sessions' renders as pitwall's own elements, each piece of its text a text node, never as HTML (see [Markdown in messages](#markdown-in-messages)).
17. **Forced colours** (Windows' contrast themes, `@media (forced-colors: active)`): the browser drops every box-shadow and forces every colour that isn't a system colour. So what a shadow or a fill says is drawn again there, in system colours (W31): the open row as a 2 px `Highlight` outline; a chip's edge as a 1 px `ButtonText` border, 2 px `Highlight` while pressed; the selected repo item, the open root tab and the theme switch's selected option as a 2 px `Highlight` border; the open tab's underline and the divider's line in `Highlight` and `CanvasText`; the session view over the list, the drawer, dialogs, menus, toasts and tooltips with a 1 px `CanvasText` edge; and fields, buttons with an edge, inline alerts, confirmations and the Jump to latest bar with a 1 px `ButtonText` border. Code blocks, tables and quotes in messages are drawn with real borders, which forced colours keep, and links in messages, in text and in code, take the system's link colour and keep their underline. A state is a border where its element can also take focus, so the focus outline still shows; padding gives back what a border takes. `web/src/forcedColors.test.tsx` checks the rules use only system colours.

### 6.2 Keyboard map

Single-key shortcuts (`/`, `?`, `n`, `j`, `k`) work only while they're switched on in the [shortcuts dialog](#keyboard-shortcuts-dialog), and never:

- while focus is in a text field, a textarea, a select, something contenteditable or the terminal (`.xterm`), so typing is typing;
- with ⌘, Ctrl or Alt held, so the browser's and the system's shortcuts are untouched (Shift is allowed, since `?` needs it on most layouts; `N`, `J` and `K` aren't shortcuts);
- while a dialog or the repo drawer is open, since both are modal (the session view over the list isn't);
- for a key that something nearer already handled, or while an input method is composing.

Holding `n` or `?` down doesn't repeat them; holding `j` or `k` does. They're handled in `Dashboard.tsx`, on the document, after every handler inside the app; `web/src/shortcuts.ts` decides which key is which.

| Key | Where | What it does |
|---|---|---|
| `/` | Anywhere | Focus the filter field. Below 1,200 px, close the session view first, since it covers the list |
| `n` | Anywhere | Open the New session dialog |
| `?` | Anywhere | Open the keyboard shortcuts dialog |
| `j` / `k` | Anywhere, including the conversation | Next / previous session in the session list (shows it if a session is open). Nothing while the message box has a draft or a Stop or Remove runs |
| ↓ / ↑ | On a session row | Move focus to the next / previous row; with the view open, also show that session. Nothing while the message box has a draft or a Stop or Remove runs |
| ↓ / ↑ | In the session view's header, except in an open menu, which uses them itself | Show the next / previous session, with focus on its heading. Nothing while the message box has a draft or a Stop or Remove runs |
| Enter | On a session row | Open the session |
| ↓ / ↑, Home / End, Enter | The repo list | Move between items, jump to the ends, select |
| Escape | Layered, nearest first | Close a tooltip or menu (a menu item's tooltip closes with its menu) → cancel a confirmation (Stop, Remove, or the restart before attaching) → close a dialog or the repo drawer → clear the filter (when focused and not empty) → close the session view. Never inside the terminal; never discards a draft in the message box; does nothing while a confirmation's action runs |
| ⌘/Ctrl + Enter | The message box | Send |
| ⌘/Ctrl + Enter | The New session dialog | Start the session |
| ← / →, Home / End | The root tabs, with two or more roots | Move focus between the roots' tabs; Enter or Space opens the focused tab, with its own selection and open session |
| ← / →, Home / End | The session view's tabs | Move focus between Conversation and Terminal; Enter or Space opens the focused tab |
| ← / →, Home / End | The divider | Resize the session view by 16 px; jump to the minimum or maximum |
| ↑ / ↓, Home / End, Enter, Escape | An open menu | Move, jump, activate, close |
| F6 | The terminal | Leave the terminal, to the Terminal tab |
| Shift + Enter | The terminal | A new line in Claude Code's prompt: a line feed (Ctrl+J), where Enter's carriage return submits. Not with Ctrl, Alt or ⌘ too, nor while an input method composes |
| Tab / Shift + Tab | Everywhere but the terminal | Header (with root tabs, the open tab, then New session and the rest) → repo list → session list (header, rows) → session view (header, tabs, body, footer). Below 1,200 px with a session open, the session list is skipped, and below 1,000 px the repo list too: the view covers them, and they're inert |

- **The repo list's Hidden section** is outside its single Tab stop: Tab reaches the "Hidden (*n*)" toggle, then, while it's open, each hidden group's link and Unhide button. ↓, ↑, Home and End keep to the list's own items.
- **"Next" and "previous"** follow the session list's visible order, including an order that's being held while focus or the pointer is in the list. Rows in a closed Finished section and rows hidden by the filter are skipped, and it stops at either end without wrapping.
- **Where `j` and `k` start:** the focused row; or else the open session; or else, with nothing open, the first row, for either key. An open session the list doesn't show (filtered out, in a collapsed Finished section, or not listed) has no next or previous, so they do nothing.
- **Where focus goes:** with no session open, to the row. With one open, the view shows that session, replacing the history entry as ↑/↓ do, and focus stays in the list if it was there, stays in the conversation if it was there, and otherwise goes to the new heading.
- **In the conversation's body,** ↑/↓ scroll it, as in any scrolling region; use `j` / `k` there to change session.
- **An open menu** closes first when a shortcut moves focus (see [Menus](#menus)).
- **A draft is never lost to a key:** while the message box has a draft, `j` and `k` do nothing, nor do ↑ and ↓ on a session row or in the view's header, nor `/` or the app strip's Details where they would close the view, just as Escape does nothing then. Changing session would discard the draft. ↑ and ↓ on a row are still taken, so the list doesn't scroll either. `j`, `k`, ↑ and ↓ wait for a running Stop or Remove the same way, so its result shows in the view it was asked from.

---

## 7. Open questions

None open. Decisions made while writing this doc are recorded in `PLAN.md` under M3.
