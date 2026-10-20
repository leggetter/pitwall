# pitwall design system

pitwall's design system is inspired by Hookdeck's UX. It's pitwall's own design system, not Hookdeck's, and it uses no Hookdeck logos, illustrations or other artwork.

- **Status:** being applied in M3. The tokens, type, radii, edges, focus ring, theme switch and icons are in the web UI (W20). The components take the shapes and layouts in sections 3 and 4 as W21 to W29 rebuild them. [Mapping from today's CSS](#215-mapping-from-todays-css) records how today's styles moved onto the tokens.
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
- **After the first paint,** `web/src/theme.ts` keeps `data-theme` right: it applies a new choice, and follows the system's `change` event while System is chosen. One store holds the choice, so every switch on the page shows the same one. `web/src/theme.test.tsx` runs `theme-init.js` against the same cases and checks the two agree.
- **Without JavaScript,** or if the script fails, no `data-theme` is set. Then `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { … } }` applies the dark block.
  - That block is a copy of the `:root[data-theme='dark']` block. Keep the copy generated, or add a unit test that parses `tokens.css` and checks the two blocks are identical.
- **`color-scheme`:** set to `light` or `dark` in each block, so native controls and scrollbars match. Keep `<meta name="color-scheme" content="light dark">` in `web/index.html`.
- **The switch:** a three-option theme control in the header (see [Theme switch](#theme-switch)). Changing it writes the key, updates `data-theme`, and takes effect without a reload.
- **The terminal stays dark** in both modes for now (see [Terminal](#terminal)).

### 2.3 Colour roles

| Token | Light | Dark | Use |
|---|---|---|---|
| `--pw-bg` | `#FAFAF8` | `#141412` | The page: behind the header, the toolbar and the cards |
| `--pw-surface` | `#FFFFFF` | `#191917` | Cards, rows, the session view, inputs |
| `--pw-surface-muted` | `#FAFAFA` | `#1D1D1B` | Group headers, the session view's footer band, code blocks |
| `--pw-surface-sunken` | `#F5F5F5` | `#222220` | Skeleton bars, key caps, disabled fields, the user's messages |
| `--pw-surface-strong` | `#EBEBEB` | `#353533` | Pressed and active fills only |
| `--pw-surface-hover` | `#F5F5F5` | `#272725` | Hover on something that sits on `--pw-surface` |
| `--pw-surface-hover-bg` | `#EBEBEB` | `#222220` | Hover on something that sits on `--pw-bg` |
| `--pw-surface-overlay` | `#FFFFFF` | `#1D1D1B` | Dialogs, menus, tooltips, toasts |
| `--pw-selected` | `#E5ECFA` | `#001B52` | The open session's row, pressed filter chips |
| `--pw-selected-border` | `#0044CC` | `#668FE0` | The 1 px ring around a selected item |
| `--pw-highlight` | `#FFEB99` | `#665200` | Filter matches inside text |
| `--pw-backdrop` | `rgb(0 0 0 / 0.1)` | `rgb(0 0 0 / 0.5)` | Behind a dialog |
| `--pw-text` | `#141412` | `#F5F5F5` | Body text, names, titles |
| `--pw-text-muted` | `#52504A` | `#CCCCCC` | Secondary text: titles after a name, previews, help text |
| `--pw-text-subtle` | `#6A6860` | `#9D9D9D` | Tertiary text: times, paths, placeholders, kind |
| `--pw-text-disabled` | `#A3A093` | `#525252` | Disabled controls only (exempt from contrast, see [2.4](#24-contrast)) |
| `--pw-text-inverse` | `#FFFFFF` | `#141412` | Text on `--pw-text` (the app strip) |
| `--pw-border` | `#EBEBEB` | `#2C2C2A` | Dividers between rows and sections (decorative) |
| `--pw-border-strong` | `#E0E0E0` | `#3E3E3D` | Card edges where a divider isn't enough (decorative) |
| `--pw-border-dashed` | `#CCCCCC` | `#3A3A38` | Dashed outlines: not-running badges, placeholders |
| `--pw-border-control` | `#8C897E` | `#6E6E6C` | The edge of outline buttons, chips, checkboxes, the theme switch |
| `--pw-border-input` | `#8C897E` | `#6E6E6C` | The edge of text fields, textareas and selects |
| `--pw-accent` | `#0044CC` | `#0044CC` | Primary button fill, checkbox fill |
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
| `--pw-selected-border` on surface and selected | 6.56 (selected) | 5.14 (selected) | 3:1 |
| `--pw-warning-indicator` on surface, bg and warning tint | 3.73 (warning tint) | 6.04 (warning tint) | 3:1 |

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
  --pw-toolbar-h: 44px;
  --pw-strip-h: 32px;

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
  --pw-z-popover: 50;
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
  --pw-shadow-card: 0 0 0 1px var(--pw-border-strong), 0 1px 2px rgb(0 0 0 / 0.04);
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
  --pw-shadow-card: 0 0 0 1px var(--pw-border-strong), 0 2px 4px rgb(0 0 0 / 0.16);
  --pw-shadow-control: 0 0 0 1px var(--pw-border-control), 0 2px 4px rgb(0 0 0 / 0.16);
  --pw-shadow-input: 0 0 0 1px var(--pw-border-input), inset 0 2px 4px rgb(0 0 0 / 0.24);
  --pw-shadow-input-error: 0 0 0 1px var(--pw-danger-fg), inset 0 2px 4px rgb(0 0 0 / 0.24);
  --pw-shadow-accent: inset 0 1px 0 rgb(255 255 255 / 0.24), 0 0 0 1px var(--pw-accent-hover), 0 2px 4px rgb(0 0 0 / 0.16);
}

/* 4. pitwall's session states, as tone aliases */
:root {
  --pw-state-attention-bg: var(--pw-warning-solid);   /* "needs you": the only solid badge */
  --pw-state-attention-fg: var(--pw-on-warning-solid);
  --pw-state-attention-row: var(--pw-warning-tint);
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
  --pw-live: var(--pw-success-fg);
  --pw-pending: var(--pw-warning-fg);
  --pw-broken: var(--pw-danger-fg);
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
- **Fields and code turn ligatures off** (`font-variant-ligatures: none`), so `//`, `->` and `!=` show as typed.
- **Inline `code`** in text: mono s, `--pw-surface-sunken` fill, `--pw-radius-sm`, padding `0 4px`, colour `--pw-text`.
- **Weights:** 400, 500 and 600 only.

### 2.8 Space

- **4 px grid:** use the `--pw-space-*` steps. Half steps (2, 6, 10 px) only inside small components.
- **Recurring values:**

| Where | Value |
|---|---|
| Page and pane gutters | 16 px; 24 px from 1,100 px wide |
| Gap between group cards | 12 px |
| Row padding | 8 px 12 px |
| Group header padding | 8 px 12 px |
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
| `--pw-shadow-card` | Group cards |
| `--pw-shadow-control` | Outline buttons, chips, the theme switch's selected thumb, key caps |
| `--pw-shadow-input` / `-input-error` | Text fields, textareas, selects |
| `--pw-shadow-accent` | Primary buttons |
| `--pw-shadow-1` | Tooltips, the row preview |
| `--pw-shadow-2` | Menus |
| `--pw-shadow-3`, `--pw-shadow-overlay` | Dialogs, toasts, the session view when it overlays the list |
| `--pw-ring-focus` | Keyboard focus, on top of the element's own shadow |
| `--pw-ring-focus-inset` | Keyboard focus on a full-width control inside a card that clips its content, such as a group header or the Finished toggle, where the outer ring would be cut off |
| `--pw-ring-selected` | The open row and pressed chips (inset, so nothing moves) |

- **Edges are rings:** controls are outlined with `box-shadow: 0 0 0 1px …`, not `border`, so they line up with elements that have no edge. Dividers between rows and sections are a real `1px solid var(--pw-border)`.
- **Focus:** `:focus-visible { box-shadow: <own shadow>, var(--pw-ring-focus); outline: 2px solid transparent; }`.
  - The ring is a 2 px gap in the surface colour and a 2 px ring in `--pw-focus`.
  - The transparent outline becomes visible in Windows forced-colours mode, where shadows are dropped.
  - Inside a card with `overflow: hidden`, a full-width control uses `--pw-ring-focus-inset` and `outline-offset: -2px` instead, so neither is clipped. The 2 px ring sits on the control's own fill, so there's no gap; `--pw-focus` is at least 3:1 on every surface it's drawn on (2.5).
  - Never remove focus styles without that replacement.
- **No other shadows,** and only one elevation per element.

### 2.11 Layers

`--pw-z-*` keeps this order: sticky headers 10, the overlay session view 20, menus 30, dialog backdrop 40, dialog 41, popovers 50, tooltips 60, toasts 70. Don't add a z-index outside this scale.

### 2.12 Breakpoints and widths

CSS custom properties don't work in media queries, so these are constants. Use them as written.

| Name | Query | What changes |
|---|---|---|
| **split** | `(min-width: 1100px)` | The session view sits beside the list. Below it, the view overlays the list |
| **compact** | `(max-width: 600px)` | The header's right side wraps under the wordmark; the toolbar wraps; the overlay session view is full width; toasts are full width |
| **short** | `(max-height: 760px)` | The session view's footer padding tightens and the latest reply shows two lines, not three |

- **Fixed widths:**
  - List: at least `--pw-list-min-w` (360 px).
  - Session view: `--pw-panel-w` (760 px) by default, at least `--pw-panel-min-w` (560 px, about 80 terminal columns), at most the window less 360 px.
  - Dialogs: 408, 624 (the default) or 840 px. Tooltips: at most 344 px. Toasts: 360 px. Menus: at least 192 px.
- **Reflow:** the UI works at 320 px wide and at 200 % zoom. Only the terminal and code blocks may scroll sideways.

### 2.13 Motion

| What | Duration | Easing |
|---|---|---|
| Hover, colour and chevron rotation | `--pw-duration-fast` 150 ms | `--pw-ease-standard` |
| Toast in and out (fade and scale from 0.96) | `--pw-duration-base` 220 ms | `--pw-ease-out` |
| Overlay session view in (slide 16 px and fade) | `--pw-duration-base` 220 ms | `--pw-ease-out` |
| Spinner turn | 0.8 s per turn, linear | |
| Skeleton pulse (opacity 1 → 0.6 → 1) | 1.5 s, starting after 0.5 s | ease-in-out |

- **Delays as design:**
  - Spinners and skeletons wait `--pw-delay-spinner` (500 ms) before appearing, so fast loads never flash.
  - After `--pw-delay-long` (10 s), a waiting state adds a sentence saying what's taking long.
  - Tooltips open after `--pw-delay-tooltip` (300 ms) and close at once; moving to a neighbouring control with a tooltip opens its tooltip at once.
  - Toasts stay for `--pw-toast-timeout` (4 s).
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
| `expand` | chevron_right | Group, finished-list and tool-call toggles, rotated 90° when open |
| `select` | keyboard_arrow_down (formerly expand_more) | The chevron in selects |
| `more` | more_horiz | The session view's actions menu |
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
| `keyboard` | keyboard | The shortcuts dialog |
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
| `--attention-row` | `#fff6e5` / `#2a2008` | `--pw-state-attention-row` |
| `--attention-strong` | `#9a5800` / `#fcc94a` | `--pw-warning-fg` (also the "Asked:" label, the checkbox accent and the line for a relay message that's held or uncertain); `--pw-state-asked-fg` for the "asked you" badge's text |
| `--busy-bg`, `--busy-text` | `#dbe8fe`, `#1d3f99` / `#18294a`, `#a9c7ff` | `--pw-state-busy-bg`, `--pw-state-busy-fg` |
| `--idle-bg`, `--idle-text` | `#eceef1`, `#474f59` / `#232932`, `#b7bfc9` | `--pw-state-idle-bg`, `--pw-state-idle-fg` |
| `--done-bg`, `--done-text` | `#dcf5e4`, `#165c32` / `#12301e`, `#8ee6ac` | `--pw-state-done-bg`, `--pw-state-done-fg` |
| `--failed-bg`, `--failed-text` | `#fde2e2`, `#921c1c` / `#3b1717`, `#ffaaaa` | `--pw-state-failed-bg`, `--pw-state-failed-fg` |
| `--offline-text` | `#5a626c` / `#9ca5b1` | `--pw-state-offline-fg` |
| `--offline-border` | `#9aa1ab` / `#535c69` | `--pw-state-offline-border` |
| `--live`, `--pending`, `--broken` | `#16833d`, `#b26b00`, `#c42b2b` / `#4ade80`, `#fbbf24`, `#f87171` | `--pw-live`, `--pw-pending`, `--pw-broken` |
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

```
┌─ app strip, 32 px, only while the relay is off ───────────────────────────────┐
├─ header, 52 px ───────────────────────────────────────────────────────────────┤
│ pitwall  ~/git, ~/work                [+ New session]  ● Live  7s ago  ◐ ⌨   │
├─ toolbar, 44 px ──────────────────────────────────────────────────────────────┤
│ [Filter sessions    /]  [Needs you 2] [Background] [Finished]   12 sessions │
├─ list pane (scrolls) ───────────────────┬┬─ session view (≥ 1,100 px) ────────┤
│ page alerts                             ││ header: name · title   ⋯  ✕       │
│ ┌ group: pitwall  4  [2 need you] ────┐ ││ badge · kind · active 5m · cwd     │
│ │ row                                  │ │├ tabs: Conversation | Terminal ────┤
│ │ row (open)                           │ ││ body (scrolls)                     │
│ └──────────────────────────────────────┘ ││                                    │
│ ┌ group: api-server  3 ────────────────┐ │├ footer: message box ──────────────┤
└─────────────────────────────────────────┴┴────────────────────────────────────┘
```

- **The page doesn't scroll.** The app is `height: 100dvh` as a grid of strip, header, toolbar and panes. The list pane and the session view's body scroll on their own; the header, toolbar, panel header, tabs and footer stay put.
- **Full width.** No centred max-width column. The list pane fills whatever the session view leaves.

### Header

- **Size and fill:** 52 px tall, `--pw-bg`, a bottom `--pw-border`, 16 px gutters (24 px from 1,100 px).
- **Left:** the wordmark "pitwall" (l 16/24, 600), then the roots: path type, `--pw-text-subtle`, home shortened to `~`, middle ellipsis, the full list in a tooltip.
- **Right, 12 px apart:** New session (primary, md, `add` icon); the connection badge; "updated 7s ago" (meta, `--pw-text-subtle`, tabular); the theme switch; the keyboard-shortcuts icon button.
- **Compact (≤ 600 px):** the right side wraps under the wordmark, and the header grows to fit.

### Toolbar

- **Size and fill:** 44 px tall, `--pw-bg`, a bottom `--pw-border`. Shown once there's at least one session.
- **Left:** the filter field (240 to 420 px wide), then the filter chips.
- **Right:** the summary: "12 sessions", then a solid warning badge "2 need you", or meta text "Nothing needs you".

### List pane

- **Fill and padding:** `--pw-bg`, padding 16 px (24 px from 1,100 px).
- **Order:** page alerts first, then group cards 12 px apart.
- **Groups** are cards: `--pw-surface`, `--pw-shadow-card`, `--pw-radius-md`, `overflow: hidden`.
- **Empty and loading states** fill the pane, centred (see [Empty states](#empty-states)).
- **Live updates:** each snapshot updates rows in place. If it would reorder rows or groups while the pointer is over the list or focus is inside it, keep the current order until both have left, then apply it. Added and removed rows apply at once.

### Session view

- **From 1,100 px: beside the list.**
  - A pane on `--pw-surface`, full height under the toolbar, separated from the list by a divider.
  - The list stays interactive and keeps its scroll position.
  - With nothing open, the pane is closed and the list takes the full width.
- **Below 1,100 px: over the list.**
  - Fixed to the right edge, `width: min(var(--pw-panel-w), 100vw)`, `--pw-shadow-overlay`, `--pw-z-panel`, sliding in from the right.
  - It's non-modal: no backdrop, and the visible part of the list stays usable.
  - At ≤ 600 px it's full width, with a "Back to sessions" ghost button (`back` icon) at the start of its header in place of the close icon.
- **Divider** (split mode only):
  - An 8 px hit area with a 1 px `--pw-border` line in it; on hover or focus the line becomes 2 px `--pw-focus`.
  - `role="separator"`, `aria-orientation="vertical"`, `aria-valuenow` (the panel width in px), `aria-valuemin`, `aria-valuemax`, `aria-label="Resize the session view"`, `tabindex="0"`.
  - Drag to resize. ← and → move it 16 px, Home and End jump to the minimum and maximum, and a double-click resets to 760 px.
  - Save the width in `localStorage` as `pitwall.panel-width.v1`.
- **The open session is in the URL:** `?session=<sessionId>`.
  - Opening a session pushes a history entry; moving with ↑/↓ replaces it; closing pushes one without the parameter.
  - `popstate` makes the view match the URL.
  - Loading a URL with a session that isn't in the snapshot opens the view with the state "This session isn't listed under these roots" and a Close button.
  - Opening from the URL never attaches, sends or changes anything.
  - Never put the token in the query string.
- **Inside:** a sticky header, the tabs, the scrolling body and a sticky footer (see [Session view](#session-view-header-tabs-and-footer)).

### App strip and page alerts

- **App strip:** a 32 px strip above the header for a state that affects the whole app and outlasts a dismissed alert. Today that's one: the relay is off until restart. See [Alerts and banners](#alerts-and-banners).
- **Page alerts:** inline alerts at the top of the list pane, full pane width: the poll failed, a server error, the relay alert, "Lost the connection".

---

## 4. Components

Each component lists its anatomy, sizes, states and tokens. "Hover" means `@media (hover: hover)`; on touch screens, anything revealed on hover is always visible.

### Buttons

| Variant | Fill | Edge | Text and icon | Hover | Use |
|---|---|---|---|---|---|
| **Primary** | `--pw-accent` | `--pw-shadow-accent` | `--pw-on-accent` | fill `--pw-accent-hover` | The one main action in a region: New session, Start session, Send |
| **Outline** | `--pw-surface` | `--pw-shadow-control` | `--pw-text`, icon `--pw-text-muted` | fill `--pw-surface-hover` | Secondary actions: Cancel, Try again, Clear filters |
| **Ghost** | none | none | `--pw-text-muted`, icon `--pw-text-muted` | fill `--pw-surface-hover`, text `--pw-text`, edge `--pw-shadow-control` | Toolbar and header actions, icon buttons, Dismiss |
| **Danger** | `--pw-danger-solid` | none | `--pw-on-danger-solid` | 8 % darker (`filter: brightness(0.92)`) | Confirming a destructive action: Stop session, Remove session |

| Size | Height | Padding | Text |
|---|---|---|---|
| sm | 24 px | 2 px 8 px | s 13/20, 500 |
| md (default) | 28 px | 4 px 8 px | m 14/20, 500 |
| lg | 32 px | 6 px 12 px | m 14/20, 500 |

- **Anatomy:** an optional 16 px leading icon, 6 px before the label; `--pw-radius-md`; `white-space: nowrap`.
- **Pressed:** `--pw-surface-strong` fill (outline and ghost), or `--pw-accent-hover` (primary).
- **Focus:** `--pw-ring-focus` added to the variant's shadow.
- **Disabled:**
  - Uses `aria-disabled="true"`, not `disabled`, so it stays focusable and its tooltip can say why. The click handler ignores activation.
  - Text and icon `--pw-text-disabled`; fill `--pw-surface-sunken` (primary, outline and danger), or none (ghost).
  - The edge stays `--pw-shadow-control`; the cursor is `not-allowed`.
- **Busy:**
  - A spinner replaces the icon (or comes before the label), the label changes to the progressive verb ("Starting…"), and `aria-busy="true"` is set.
  - The button keeps its width (set `min-width` to the idle width), and repeat clicks are ignored.
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
- **Placeholder:** `--pw-text-subtle`. Placeholders are examples, never the only label.
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
- **Select:** native `<select>` in the same box, with a 16 px `select` icon at the right in `--pw-text-muted` (`appearance: none`).

### Search

- **The filter field:** height 28 px. A 16 px `search` icon at 8 px from the left in `--pw-text-subtle`; text padding-left 32 px.
- **Right side:** a `/` key cap while it's empty and unfocused; a ghost sm `clear` icon button ("Clear filter") once there's text.
- **Behaviour:**
  - Filters as you type (pitwall filters in memory); no Enter needed.
  - Escape in the field clears it if it has text, otherwise leaves the field.
  - Matches are highlighted in names, titles and paths with `--pw-highlight`.
- **Accessibility:** inside `role="search"`; a visually hidden label "Filter sessions"; placeholder "Filter by session, title, repo or directory".

### Filter chips

- **Size:** 24 px tall, padding 0 8 px, label style (xs 12/20, 500), `--pw-radius-sm`, an optional count after the label in tabular numbers.
- **Off:** `--pw-surface`, `--pw-shadow-control`, text `--pw-text-muted`.
- **On:** `--pw-selected`, `--pw-ring-selected` in place of the control edge, text `--pw-info-tint-fg`, and a 16 px `copied` (check) icon before the label.
- **Semantics:** `<button aria-pressed>`, in a group with `aria-label="Filters"`, 8 px apart.
- **The chips:** "Needs you", "Interactive", "Background", "Finished".
  - "Needs you" replaces today's checkbox.
  - Chips of the same kind combine as OR; different kinds combine as AND.
  - A ghost sm "Clear filters" button appears after the chips when any chip is on or the field has text.

### Badges

- **Shape:** 20 px tall, min-width 20 px, padding 0 6 px, `--pw-radius-sm`, label style (xs 12/20, 500), tabular numbers, `white-space: nowrap`.
- **Optional leading element:** a 16 px icon, or an 8 px status dot, with 4 px gap.

| Style | Fill | Edge | Text |
|---|---|---|---|
| **Solid** | `--pw-<tone>-solid` | none | `--pw-on-<tone>-solid` |
| **Subtle** | `--pw-<tone>-tint` | `inset 0 0 0 1px var(--pw-<tone>-border)` | `--pw-<tone>-tint-fg` |
| **Outline** | none | `outline: 1px dashed var(--pw-border-dashed); outline-offset: -1px` (badges aren't focusable, so the outline is free) | `--pw-text-subtle` |

- **Solid is for "needs you" only.** Everything else is subtle or outline.

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
| Busy / working | "Busy" / "Working", with an 8 px dot in `--pw-info-fg` | subtle info |
| Idle | No badge in the list; "Idle" in the session view | subtle neutral, in the session view only. Needs-you is unaffected: it comes from waiting, blocked and asked-you, never from the badge |
| Unknown | "Unknown" | subtle neutral |
| Finished, and it asked you | "Asked you", with a tooltip saying it isn't counted | outline |

- **Other badges:**
  - **Counts:** subtle neutral ("4", "2 of 5").
  - **Needs-you counts:** solid warning ("2 need you").
  - **Errors in folded tool calls:** subtle danger ("1 error").
- **Stale** carries its explanation in a tooltip: "Blocked with no activity for more than 7 days, whether or not its process is running. Usually waiting on a question that no longer matters."

### Status dot

- **Shape:** 8 px circle, `--pw-radius-full`, in a tone's `-fg` colour (3:1 or better against every neutral surface).
- **Use:** inside badges, and in the connection badge. Never the only sign of a state: a text label always goes with it. It doesn't animate.

### Connection badge

`role="status"`, in the header:

| Connection | Badge |
|---|---|
| Connecting | subtle neutral "Connecting…", with a spinner |
| Live | subtle success "Live", with a dot |
| Reconnecting | subtle warning "Reconnecting…", with a spinner |
| Token rejected | subtle danger "Token rejected" |

### Session rows

- **Container:** an `<li>` in the group's `<ul>`, padding 8 px 12 px, a 1 px `--pw-border` line between rows, `--pw-surface`.
- **Lines,** 2 px apart:
  1. **Identity:**
     - The name (m 14/20, 500, `--pw-text`), then " · " and the title (m 14/20, 400, `--pw-text-muted`, one line with an ellipsis, the full title and where it came from in a tooltip).
     - Then the status badge(s), and at the far right the relative time (meta, `--pw-text-subtle`, tabular).
  2. **What it wants or did last** (when the transcript is readable):
     - "Asked: *excerpt*" (body, the label in `--pw-warning-fg` 500); or
     - "You: *last prompt*" (meta, `--pw-text-muted`, one line, ellipsis).
  3. **The last reply:** meta, `--pw-text-muted`, clamped to two lines, with a "Show more" link button that loads the full reply in place (scrolling inside the row past 70 % of the window height).
  4. **The last relay exchange,** when there is one: the compact one-line form.
  5. **Footer:**
     - Left: the cwd within the group (path type, `--pw-text-subtle`, middle ellipsis, the full path in a tooltip), or "directory no longer exists" (meta, `--pw-text-subtle`).
     - Right: a copy icon button for the attach command, and a ghost sm "Message" button for interactive sessions that can be messaged.
     - The footer's buttons show on hover, on focus within the row, and on the open row; they're always visible on touch screens.
- **Opening:** the name is a `<button>` with `aria-controls="session-view"`, `aria-current="true"` when its session is open, and `data-open-session`.
  - A click anywhere on the row that isn't a control (and isn't the end of a text selection) opens the session too. Keyboard users use the button.
- **States:**

| State | Fill | Marker |
|---|---|---|
| Default | `--pw-surface` | |
| Hover | `--pw-surface-hover` | |
| Open | `--pw-selected` | `--pw-ring-selected` |
| Needs you | `--pw-state-attention-row` | `inset 3px 0 0 var(--pw-state-attention-bar)` |
| Needs you and open | `--pw-selected` | both the ring and the left bar |
| Finished | `--pw-surface` | the name at 400 weight, its text `--pw-text-muted` |

- **Transcript notes:** "Transcript not found" or "Transcript unreadable", meta, `--pw-text-subtle`, in place of lines 2 and 3.
- **Height:** never fixed; rows grow with zoom and text spacing.

### Group sections

- **Card:** as in the [layout shell](#list-pane).
- **Header:** a `<h2>` containing a full-width `<button aria-expanded aria-controls>`.
  - At least 40 px tall, padding 8 px 12 px, `--pw-surface-muted`, a bottom `--pw-border` when expanded.
  - Left to right:
    1. The `expand` icon (16 px, `--pw-text-subtle`, rotating 90° when open).
    2. The kind icon (`repo` or `directory`, 16 px, `--pw-text-subtle`, with a visually hidden "git repo" or "directory").
    3. The label (m 14/20, 500).
    4. "in *root*" (meta, `--pw-text-subtle`) when pitwall watches more than one root.
    5. At the right: a subtle neutral count badge ("4 sessions" or "2 of 5 sessions"), then a solid warning "*n* need you" badge when any do.
  - Hover: `--pw-surface-hover`.
- **Collapsed by default,** with each group's state remembered in `localStorage` (`pitwall.groups.v1`). Its header's needs-you badge shows what's waiting inside.
- **Finished sub-list:** at the bottom of a group, a toggle row "Finished (*n*)", plus " · *n* asked you" when any did.
  - padding 6 px 12 px, meta size, 500, `--pw-text-muted`, a top `--pw-border`, hover `--pw-surface-hover`.
  - Collapsed by default and remembered (`pitwall.finished.v1`).

### Session view: header, tabs and footer

**Header** (sticky, `--pw-surface`, a bottom `--pw-border`, padding 12 px 16 px):

1. **Line 1:**
   - The name (l 16/24, 600), then " · " and the title (l 16/24, 400, `--pw-text-muted`, ellipsis).
   - At the right: the `more` icon button (md, ghost) opening the actions menu, then the `close` icon button ("Close", Escape in its tooltip).
   - The heading is the region's label (`aria-labelledby`) and takes focus when the view opens (`tabindex="-1"`, no visible ring on the heading itself).
2. **Line 2, 8 px gaps, wrapping:**
   - The status badge.
   - The kind as meta text in `--pw-text-subtle` ("Interactive" or "Background"). An interactive session adds an `info` icon whose tooltip says that typing `/bg` in its terminal moves it to the background, so pitwall can drive it fully.
   - "Active 5m ago" (meta, `--pw-text-subtle`, the absolute time in a tooltip).
   - The cwd (path type, `--pw-text-subtle`, middle ellipsis) with a copy icon button.
3. **When the session has left the snapshot:** an inline neutral alert: "This session is no longer listed, so this is what it showed last."

**Actions menu** (`more`): Copy session ID, Copy attach command, then a separator, then Stop session and Remove session (background sessions; Remove in danger text). Each opens its [inline confirmation](#inline-confirmation).

**Tabs** (a row under the header, sticky, padding 0 16 px, a bottom `--pw-border`, 40 px tall):

- **Tab:** 28 px tall, padding 4 px 8 px, m 14/20, 500, a 16 px icon before the label.
  - Inactive: `--pw-text-muted`; hover fill `--pw-surface-hover`, `--pw-radius-lg`.
  - Active: `--pw-text`, with a 2 px `--pw-text` underline on the row's bottom edge, over the border.
- **"Conversation"** (`conversation`) and **"Terminal"** (`terminal`).
  - An interactive session's Terminal tab is `aria-disabled`, with a tooltip saying it can't be attached and how `/bg` changes that.
  - While attached, the Terminal tab shows an 8 px success dot.
- **ARIA:** `role="tablist"` with `aria-label="Session view"`, `role="tab"` with `aria-selected` and `aria-controls`, `role="tabpanel"` with `aria-labelledby`. Roving `tabindex`.
  - ← and → (and Home, End) move focus between tabs; Enter or Space opens one.
  - Opening is manual, never on focus, because opening Terminal attaches.
- **Switching** from Terminal to Conversation detaches, as Detach does. Opening Terminal attaches; for a session that isn't running it first shows the restart confirmation.

**Body:** scrolls; padding 12 px 16 px 24 px; `overscroll-behavior: contain`. It holds the [conversation](#conversation) or the [terminal](#terminal).

**Footer** (sticky, `--pw-surface-muted`, a top `--pw-border`, padding 12 px 16 px, 8 px 16 px on short windows):

- At most half the view's height; past that, it scrolls inside itself.
- Interactive sessions: the [message box](#message-box).
- A session that can't be messaged: a meta note, "It isn't running, so it can't be messaged."
- Background sessions: no footer.

### Message box

The composer in the session view's footer, for interactive sessions. Messages go through pitwall's relay.

- **Region:** a `<section>` named by a visually hidden heading "Message this session".
- **Order, top to bottom:**
  1. **The latest exchange:** "Message from pitwall · 5m ago: *status*" (meta, `--pw-text-muted`; the status in `--pw-warning-fg` while waiting, `--pw-danger-fg` if it failed). Below it, the reply (body), at most three lines (two on short windows), scrolling past that.
     - Show the reply once: when the conversation already shows it, the footer shows only the status line.
  2. **The result of the last send,** as an inline alert: delivered (success), held for approval (warning), may have arrived (warning), refused (danger), not sent (danger). The text is the relay's status sentence. `role="status"` for delivered, `role="alert"` otherwise.
  3. **The text row:** the textarea (auto-growing, one to eight lines), then the primary md "Send" button (`send` icon), aligned to the textarea's bottom.
  4. **The help line** (meta, `--pw-text-subtle`):
     - Left: "⌘ ↵ to send" as key caps (Ctrl on other platforms), then an `info` icon whose tooltip holds the limits note ("Starts a turn on that session's model. The session sees it as a message from another session, not from you, so it can't approve prompts.").
     - Right: the character count, shown only from 80 % of the limit, in `--pw-danger-fg` with "*n* characters over the *limit* limit" once over it.
- **Behaviour:**
  - ⌘/Ctrl + Enter sends; Enter adds a line. Send is `aria-disabled` while empty, over the limit or sending.
  - While sending: the busy state ("Sending…"), and the textarea is read-only.
  - After a send, focus stays in the textarea. The draft clears when the message was delivered, held or refused; it stays when it wasn't sent or may not have been.
  - Escape with a draft does nothing, so a draft is never lost to the shortcut that closes the view.
  - The row's Message button opens the view, scrolls the conversation to the newest message, and focuses the textarea.

### Conversation

- **List:** an `<ol>`, oldest at the top, 12 px between entries. It opens scrolled to the newest entry.
- **Speaker line** on each text entry: label style (xs 12/20, 500, `--pw-text-muted`): "You", "Claude", or "From *name*" (the sender's name as written), then " · 11:06" in `--pw-text-subtle`. Times are always visible, not only on hover.

| Entry | Look |
|---|---|
| Your message | `--pw-surface-sunken` fill, `--pw-radius-md`, padding 8 px 12 px, body text |
| Claude | No fill, body text |
| From another session | `--pw-surface-sunken` fill, `--pw-radius-md`, `inset 3px 0 0 var(--pw-info-fg)`, body text |
| Tool calls | Folded (below) |
| Notice | Meta, `--pw-text-muted` |
| Cut short | A trailing "Cut short." in meta, `--pw-text-subtle` |

- **Text:** body, `white-space: pre-wrap`, `overflow-wrap: anywhere`, always as text, never as markup.
- **Folded tool calls:**
  - Consecutive tool calls fold into one row: an `expand` toggle button "*n* tool calls" (code style, `--pw-text-muted`), plus a subtle danger "*n* error(s)" badge when any failed.
  - Expanded, each call is one line of code text with an ellipsis and its own "error" badge; the full text is in a tooltip.
  - A single tool call isn't folded.
- **Loading earlier:** an outline sm "Load earlier" button centred at the top ("Loading earlier…" while busy). The scroll position holds when older entries arrive.
- **Following new entries:**
  - At the bottom (within 24 px), new entries keep it at the bottom.
  - Scrolled up, the place is kept, and a "Jump to latest" bar appears, sticky at the bottom of the body: `--pw-info-tint`, `--pw-info-tint-fg` text, the `latest` icon, "*n* new · Jump to latest", full width, `--pw-radius-md`, 8 px from the footer. It's a button.
  - Under reduced motion, jumping to latest doesn't animate.
- **States:** see [Empty states](#empty-states) and [Errors](#5-content).

### Alerts and banners

**Inline alert** (the default; inside panes, dialogs and the footer):

- **Box:** padding 12 px, `--pw-radius-md`, `--pw-<tone>-tint` fill, `inset 0 0 0 1px var(--pw-<tone>-border)`.
- **Icon:** 16 px, in `--pw-<tone>-tint-fg`, top-aligned in a 20 px line box: `info` (neutral, info), `success`, `warning`, `error` (danger).
- **Text:** an optional title (m 14/20, 500, `--pw-text`), then the body (m 14/20, 400, `--pw-text`), 8 px after the icon.
  - Detail that comes from Claude Code or the server (such as the relay's "Latest:" text) is in code style, inside `plainText`.
- **Actions:** outline sm buttons at the right; they wrap under the text below 600 px.
- **Roles:** `role="alert"` for warning and danger alerts that appear after an action or arrive live; `role="status"` for the rest. An alert that is there on page load has neither.
- **Dismiss:** ghost sm "Dismiss". A dismissed alert stays dismissed until its content changes (a new time or count brings it back).

| Alert | Tone | Title | Body |
|---|---|---|---|
| The poll failed | warning | "Couldn't list sessions" | "`claude agents --json --all` failed on the latest poll: *error*" |
| Server error | danger | | The error, with Dismiss |
| Connection lost | neutral | | "Lost the connection to pitwall. Reconnecting; this list may be out of date." |
| Relay sent a message you didn't ask for | danger | "pitwall's relay sent a message you didn't ask for" | What it means, the count since start, "Latest: *detail*", with Dismiss |
| Relay blocked one | warning | "pitwall blocked a message you didn't ask for" | The same structure |
| Session started | neutral | | "Started *name*. Its view opens when it shows up in the list.", with Dismiss |

**App strip** (one at a time):

- **Box:** 32 px tall, full width above the header, `--pw-text` fill, `--pw-text-inverse` text (18.4:1 in light, 16.9:1 in dark), meta size; a 16 px `warning` icon in the text colour; a link button in `--pw-text-inverse` with an underline. The strip inverts with the theme, so it never uses a tone colour.
- **Use:** while the relay is off until restart: "Messaging is off until you restart pitwall." with "Details", which reopens the relay alert. It stays after the alert is dismissed and can't itself be dismissed.

### Inline confirmation

For a destructive or surprising action in the session view, without a dialog.

- **Box:** directly under the header (above the tabs). `--pw-surface-muted` fill, `inset 0 0 0 1px var(--pw-border-strong)`, a left bar `inset 3px 0 0 var(--pw-danger-solid)` (or `--pw-warning-indicator` for the restart), `--pw-radius-md`, padding 12 px, margin 8 px 16 px.
- **Content:** a question as the title (m 14/20, 500), the consequence (meta, `--pw-text-muted`), then the buttons at the right: outline sm "Cancel", then the confirm button, 8 px apart.

| Action | Question | Consequence | Confirm button |
|---|---|---|---|
| Stop | "Stop this session?" | "Its conversation is kept. Attaching to it later asks before restarting it." | danger "Stop session" |
| Remove | "Remove this session?" | "It leaves the list. Claude Code keeps a worktree that has unpushed commits." | danger "Remove session" |
| Attach to a session that isn't running | "Restart and attach?" | "This session has finished, or its process has exited. Attaching restarts it." | primary "Restart and attach" |

- **Focus:** Cancel takes focus when the confirmation opens.
  - Escape cancels it, without closing the view.
  - On cancel, focus goes back to whatever opened it (the actions menu button, or the Terminal tab).
- **Semantics:** `role="group"` with `aria-labelledby` (the question) and `aria-describedby` (the consequence). For the restart, `role="alertdialog"`.
- **Busy:** the confirm button shows the busy state ("Stopping…", "Removing…"). The result shows as a toast ("Stopped. Its conversation is kept."), or as an inline danger alert with Claude Code's message when it refused.
- **No type-to-confirm.** pitwall's destructive actions are recoverable or guarded by Claude Code.

### Dialogs

- **Backdrop:** `--pw-backdrop`, `--pw-z-backdrop`, centring the card with 48 px top and 16 px side margins.
- **Card:** `--pw-surface-overlay`, `--pw-shadow-3`, `--pw-radius-lg`, `--pw-dialog-md` (624 px) wide, at most `calc(100dvh - 96px)` tall, `--pw-z-dialog`.
- **Sections,** divided by 1 px `--pw-border`:
  - **Header:** padding 12 px 16 px; the title (l 16/24, 600); a ghost md `close` icon button at the right; an optional meta subtitle in `--pw-text-muted`.
  - **Body:** padding 16 px, scrolls, fields 16 px apart.
  - **Footer:** padding 12 px 16 px; optional meta text at the left; at the right, outline "Cancel" then the primary action, 12 px apart.
- **Behaviour:**
  - `role="dialog"`, `aria-modal="true"`, `aria-labelledby` (the title).
  - Focus moves to the first field on open, Tab is trapped inside, and focus returns to the opener on close.
  - Escape closes it, except while submitting (and it doesn't also close the session view behind).
  - A click on the backdrop closes it only when nothing has been typed.
- **Busy:** the primary button's busy state; the other controls are `aria-disabled`.
- **Failure:** an inline danger alert at the end of the body, above the footer.

**New session dialog:**

- **Fields:**
  - Directory: a select of the groups' directories, plus "Another directory under a root…", which reveals a mono path field. Help text: "Under *roots*."
  - Name: optional, placeholder "Claude Code names it from the prompt".
  - Model: optional; a select of Default, the aliases, and "Other…", which reveals a field.
  - First prompt: a textarea, 6 rows.
- **Intro:** meta text under the title: "Starts a background session with `claude --bg`, which you can open from the list."
- **Footer:** "Cancel" and "Start session". ⌘/Ctrl + Enter submits from any field.
- **Trust failure:** an inline danger alert, "pitwall never trusts a directory for you. Run this in a terminal, accept Claude Code's trust prompt, then start the session again:", with the command and a copy button.

### Menus

- **Panel:** `--pw-surface-overlay`, `--pw-shadow-2`, `--pw-radius-md`, padding 4 px, min-width 192 px, `--pw-z-dropdown`. It opens below the button, aligned to its end edge, and flips up when there's no room.
- **Items:** 32 px tall, padding 6 px 8 px, `--pw-radius-sm`, m 14/20, a 16 px icon in `--pw-text-muted` 8 px before the label.
  - Hover and keyboard highlight: `--pw-surface-hover`.
  - Danger items: `--pw-danger-fg` text and icon, `--pw-danger-tint` highlight.
- **Separator:** 1 px `--pw-border`, 4 px margin.
- **Semantics:** a `<button aria-haspopup="menu" aria-expanded>` opening `role="menu"` with `role="menuitem"` items.
  - ↑/↓ move, Home and End jump, Enter or Space activates, Escape and Tab close.
  - Focus returns to the button on close.

### Toasts

- **Placement:** a stack at the bottom right, 24 px from the edges (16 px and full width below 600 px), newest at the bottom, 12 px apart, at most three (the oldest goes first), `--pw-z-toast`.
- **Card:** `--pw-surface-overlay`, `--pw-shadow-3`, `--pw-radius-md`, `--pw-toast-w` wide, padding 8 px.
  - A 28 px icon tile (`--pw-<tone>-tint` with `inset 0 0 0 1px var(--pw-<tone>-border)`, `--pw-radius-sm`, a 16 px icon in `--pw-<tone>-tint-fg`).
  - The message (m 14/20, 500), 12 px after the tile.
  - A ghost sm `close` button ("Dismiss").
- **Timing:**
  - Success and info toasts dismiss after `--pw-toast-timeout` (4 s), pausing while hovered or while focus is inside.
  - Error toasts stay until dismissed.
- **Live region:** the stack is an `aria-live="polite"` region that always exists in the DOM; error toasts use `role="alert"`.
- **Use them for** results the user isn't looking at: "Copied", "Stopped. Its conversation is kept.", "Session started", "Removed *name*".
- **Don't use them for** form errors, the relay's delivery result, or anything that needs a decision. Those stay inline.

### Tooltips

- **Card:** `--pw-surface-overlay`, `--pw-shadow-1`, `--pw-radius-md`, padding 6 px 8 px, meta size (13/20), `--pw-text`, at most 344 px wide, `--pw-z-tooltip`, 6 px from its trigger.
  - It sits above the trigger by default and flips when there's no room.
  - Key caps go at the end, 8 px after the text.
- **Opens** on hover after `--pw-delay-tooltip` and on keyboard focus at once.
- **Closes** on Escape, blur and pointer leave. It stays while the pointer is over the tooltip itself (WCAG 1.4.13).
- **Semantics:** the trigger's `aria-describedby` points at the tooltip, or the tooltip is the trigger's `aria-label` for an icon button.
- **Replace `title` attributes** with this component, except on elements that are never focusable. Keep those `title`s short and duplicate their content elsewhere when it matters.
- **Never the only place** for essential information; touch users can't hover.

### Skeletons and spinners

- **Skeleton row:** the height of a session row; three bars (identity 40 %, preview 70 %, footer 30 % of the width), 12 px tall, `--pw-surface-sunken`, `--pw-radius-sm`, 6 px apart, pulsing.
  - On first connect: two group cards of three rows. The cards have `aria-hidden="true"`, and a visually hidden `role="status"` says "Loading sessions".
- **Spinner:** a 12 px (inline) or 16 px (in a button) ring: a 2 px conic gradient from transparent to `--pw-info-fg`, turning 0.8 s per turn. It's `aria-hidden`; the busy element carries `aria-busy` or a status message.
- **Waiting:** both wait `--pw-delay-spinner` (500 ms) before showing. After `--pw-delay-long` (10 s), add a meta line saying what's slow ("Still waiting for `claude agents`…").
- **Long waits for pitwall's own work** (connecting, loading the conversation) use a status line, not an overlay: meta, `--pw-text-muted`, centred, `role="status"`.

### Empty states

- **Anatomy:** centred in its pane, at most 408 px wide.
  1. A 24 px icon in `--pw-text-subtle`.
  2. The title (l 16/24, 600), 8 px below.
  3. One sentence (m 14/20, `--pw-text-muted`), 4 px below.
  4. One action, 16 px below.
- **No illustrations.**

| Where | Title | Sentence | Action |
|---|---|---|---|
| No sessions under the roots | "No Claude Code sessions under *roots*" | "Start one here, or start Claude Code in any terminal under these directories and it appears here." | primary "New session" |
| The filter matches nothing | "No sessions match" | "Nothing matches "*text*" with these filters." | outline "Clear filters" |
| Needs you, and nothing does | "Nothing needs you right now" | "Sessions that are waiting for you, or asked you something, show here." | outline "Show all sessions" |
| Split view, nothing open | "Select a session" | "Its conversation, terminal and actions open here." | none |
| Conversation, nothing yet | | "Nothing to show yet." (status line) | none |
| No transcript | | "No transcript for this session." (status line) | none |

### Key caps

- **Shape:** a `<kbd>`, 20 px tall, min-width 20 px, padding 0 5 px, `--pw-radius-xs`, label style (xs 12/20, 500), `--pw-text-muted` on `--pw-surface`, `--pw-shadow-control`, plus `inset 0 -1px 0 var(--pw-border-strong)`.
- **Combinations:** keys in a combination are 2 px apart, with no "+" between them.
- **Platform:** ⌘ on macOS, "Ctrl" elsewhere (from `navigator.userAgentData?.platform ?? navigator.platform`); ↵ for Enter, ↑ ↓ ← → for the arrows, "Esc" for Escape.
- **Screen readers:** inside tooltips and help lines, give the combination a text alternative ("Command Enter") with a visually hidden span.

### Copy

- **Copy buttons:** a ghost sm icon button (`copy`), labelled with what it copies ("Copy attach command", "Copy session ID", "Copy path").
  - After a successful copy, the icon becomes `copied` for 2 s and a "Copied" toast appears.
  - If the clipboard refuses, select the text on screen and show "Couldn't copy; the text is selected" as the button's tooltip and in the toast.
- **Command chips:** code style, `--pw-surface-sunken`, `--pw-radius-sm`, padding 0 6 px, `user-select: all`, with a middle ellipsis and the full command in a tooltip. A copy button follows.
- **Write inside the click handler** (Safari rejects a deferred write), and fall back to selecting the text.

### Timestamps

- **Relative, in rows and meta:** "just now" under 5 s, then "42s ago", "5m ago", "3h ago" (under 48 hours), "2d ago".
  - Meta size, `--pw-text-subtle`, tabular, in `<time datetime>`, with the absolute time in a tooltip.
- **The header's "updated 7s ago"** counts in seconds below a minute, so it visibly ticks.
- **Absolute:** the user's locale, with seconds: "20 Oct 2026, 11:06:14". In the conversation's speaker line, only the time ("11:06"), with the full date in the `datetime`.
- **Updates:** relative times update every second from one shared clock. They're never in a live region.

### Terminal

The Terminal tab's panel, for background sessions: xterm.js over `claude attach`.

- **Bar** (36 px, padding 4 px 0, 8 px gaps):
  - A status badge: "Attaching…" (subtle neutral, spinner), "Attached" (subtle success, dot), "Detached" (subtle neutral), "Not running" (outline).
  - A meta hint "F6 to leave the terminal" in `--pw-text-subtle`.
  - At the right: ghost sm "Attach again" (`retry`) once detached, and ghost sm "Detach".
- **Screen:** fills the rest of the panel; `--pw-term-bg`, `--pw-radius-md`, padding 6 px.
  - xterm options: `fontFamily` from `--pw-font-mono`, `fontSize` 13, `cursorBlink` true, `scrollback` 5000, `theme` built from the `--pw-term-*` tokens (background, foreground, cursor, selectionBackground, red, green, yellow, blue; xterm's defaults for the rest), and links limited to http and https.
  - The fit add-on keeps it sized to the panel.
- **Dark in both themes** for now, because Claude Code's interface is usually set to its dark theme and a light terminal behind it could be unreadable.
  - If it follows the page theme later, rebuild `theme` from the tokens on every theme change.
- **Keys:**
  - Every key goes to the terminal, Escape included (it interrupts Claude), so Escape never closes the view from here.
  - F6 moves focus out, to the Terminal tab, so the terminal isn't a keyboard trap (WCAG 2.1.2). Check during the build that Claude Code doesn't use F6; if it does, pick another key and update this doc.
- **Notices** (ended, error): an inline alert above the screen; neutral when you detached, danger when it failed.

### Theme switch

- **Shape:** a 72 × 24 px track (three 24 px buttons), `--pw-surface-muted`, `inset 0 0 0 1px var(--pw-border-control)`, `--pw-radius-full`.
- **Options:** `theme-system`, `theme-light` and `theme-dark` icons, labelled "System theme", "Light theme" and "Dark theme".
- **Selected:** a `--pw-surface-overlay` circle with `--pw-shadow-control`, its icon in `--pw-text`. Unselected icons are `--pw-text-subtle`, turning `--pw-text` on hover.
- **Semantics:** `role="group"` with `aria-label="Theme"`; each option a button with `aria-pressed`.

### Keyboard shortcuts dialog

- **Opened** by `?` or the header's `keyboard` icon button. A small dialog (`--pw-dialog-sm`) listing the [keyboard map](#62-keyboard-map) with key caps.
- **The off switch:** a checkbox, "Single-key shortcuts", that turns off `/`, `?`, `n`, `j` and `k`, stored as `pitwall.shortcuts.v1` (WCAG 2.1.4).

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
- **Progress:** the -ing form with an ellipsis: "Starting…", "Sending…", "Stopping…", "Removing…", "Attaching…", "Loading the conversation…", "Loading earlier…".
- **Counts:** digits with the noun, singular and plural handled: "1 session", "12 sessions", "1 needs you", "2 need you", "3 tool calls", "2 of 5 sessions".
- **Paths:** home shortened to `~`, middle ellipsis on screen, the full path in a tooltip.

### Errors

- **Say what happened, then what to do.** "Couldn't load the conversation. Try again". The action is a button, not just words.
- **Use the real reason** when Claude Code or the server gives one, after pitwall's own sentence: "Couldn't stop the session. *message from Claude Code*". Show it as text, never as markup.
- **Say only what pitwall knows:** "May have reached the session. Check its conversation before sending again." rather than "Sent" or "Failed".
- **No blame, no "Oops", no stack traces,** no error codes on their own.
- **Keep what's on screen** when a refresh fails, and say it may be out of date, rather than emptying the view. A failed read is an error, never "nothing here".
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
2. **Never colour alone:** every state has a text label. A row that needs you has its badge as well as its tint and bar.
3. **Visible focus:** every interactive element shows `--pw-ring-focus` on `:focus-visible`, with the transparent-outline fallback for forced colours.
4. **Targets:** at least 24 × 24 px.
5. **Names:**
   - Every icon-only control has an `aria-label` that matches its tooltip.
   - Decorative icons are `aria-hidden="true"` and `focusable="false"`.
   - Visible labels start with the accessible name, so voice control works.
6. **Structure:**
   - One `<h1>` (the wordmark); group titles `<h2>`; session names in rows `<h3>`; the session view's title `<h2>`.
   - Landmarks: `<header>`, `<main>` (the list pane) and the session view.
   - The filter is in `role="search"`.
7. **The session view's semantics:**
   - In split mode, a `<section aria-labelledby>` region.
   - In overlay mode, `role="dialog"` with `aria-modal="false"`, because the list stays usable.
8. **Focus management:**
   - Opening a session from a row (click or Enter) moves focus to the view's heading. Closing it returns focus to that session's row button, waiting a frame on narrow windows so the row exists again.
   - Moving between sessions with ↑/↓ while focus is in the list leaves focus in the list.
   - Dialogs trap focus and return it on close. Confirmations focus Cancel.
9. **Announcements:**
   - The connection badge is `role="status"`.
   - Results the user asked for are announced: send results, stop and remove results, copy.
   - Snapshot updates, ticking times and the list's re-sorting are never announced.
   - The document title carries the count: "(2) pitwall".
10. **Forms:**
    - Every control has a label.
    - Errors appear after the first submit, are linked with `aria-describedby`, and focus moves to the first one.
    - Help text is linked too.
11. **Motion:** honour `prefers-reduced-motion` (see [2.13](#213-motion)). Nothing flashes, and nothing loops except progress.
12. **Reflow and zoom:** usable at 320 px wide and 200 % zoom. Rows grow with text; nothing clips.
13. **Tooltips** can be dismissed with Escape, stay while hovered, and are never the only route to essential information.
14. **The terminal** isn't a keyboard trap: F6 leaves it.
15. **Single-key shortcuts** can be turned off, and are ignored while typing (see below).
16. **Text is text:** session names, titles, prompts, replies and server messages render as plain text, never HTML.

### 6.2 Keyboard map

Single-key shortcuts (`/`, `?`, `n`, `j`, `k`) work only when focus isn't in a text field, a select or the terminal, and only while they're switched on in the shortcuts dialog.

| Key | Where | What it does |
|---|---|---|
| `/` | Anywhere | Focus the filter field |
| `n` | Anywhere | Open the New session dialog |
| `?` | Anywhere | Open the keyboard shortcuts dialog |
| `j` / `k` | Anywhere, including the conversation | Next / previous session (opens it if the view is open) |
| ↓ / ↑ | On a session row | Move focus to the next / previous row; with the view open, also show that session |
| ↓ / ↑ | In the session view's header | Show the next / previous session |
| Enter | On a session row | Open the session |
| Escape | Layered, nearest first | Close a tooltip or menu → cancel a confirmation → close a dialog → clear the filter (when focused and not empty) → close the session view. Never inside the terminal; never discards a draft in the message box |
| ⌘/Ctrl + Enter | The message box | Send |
| ⌘/Ctrl + Enter | The New session dialog | Start the session |
| ← / →, Home / End | The tab list | Move focus between Conversation and Terminal; Enter or Space opens the focused tab |
| ← / →, Home / End | The divider | Resize the session view by 16 px; jump to the minimum or maximum |
| ↑ / ↓, Home / End, Enter, Escape | An open menu | Move, jump, activate, close |
| F6 | The terminal | Leave the terminal, to the Terminal tab |
| Tab / Shift + Tab | Everywhere but the terminal | Header → toolbar → list → session view (header, tabs, body, footer) |

- **"Next" and "previous"** follow the visible list order across groups. Collapsed groups and rows hidden by the filter are skipped, and it stops at either end without wrapping.
- **In the conversation's body,** ↑/↓ scroll it, as in any scrolling region; use `j` / `k` there to change session.

---

## 7. Open questions

None open. Decisions made while writing this doc are recorded in `PLAN.md` under M3.
