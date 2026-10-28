// The motion and timing tokens that JavaScript reads (docs/design-system.md, 2.13): --pw-delay-tooltip,
// --pw-delay-spinner, --pw-delay-long, --pw-delay-attach, --pw-toast-timeout, --pw-toast-action-timeout,
// --pw-copied-timeout and --pw-duration-base.
// Each is read from the element it applies to, so a part of the page can set its own, as the #uikit
// gallery does to keep a toast or a copied icon on screen for its screenshots, or to show a waiting
// state's skeletons and long-wait line at once. Where there's no stylesheet, as in the tests, the
// fallback is the doc's value.

/** A CSS <time> in ms: "300ms", "4s" or "0.5s". Undefined when it isn't one. */
export function parseCssTime(value: string): number | undefined {
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(value.trim());
  if (!match) return undefined;
  return Number(match[1]) * (match[2] === 's' ? 1000 : 1);
}

/** The custom property `name` on `element`, as ms, or `fallback` when it isn't set or isn't a time. */
export function cssTime(element: Element | null | undefined, name: string, fallback: number): number {
  if (!element || typeof getComputedStyle !== 'function') return fallback;
  return parseCssTime(getComputedStyle(element).getPropertyValue(name)) ?? fallback;
}

/** The doc's values, for when there's no stylesheet. */
export const TOOLTIP_DELAY_MS = 300;
/** Before a skeleton, a spinner or a waiting status line shows, so a fast answer never flashes one. */
export const SPINNER_DELAY_MS = 500;
/** Before a waiting state adds the line saying what's slow. */
export const LONG_DELAY_MS = 10_000;
/**
 * How long a running background session opened by stepping (j, k, ↑, ↓) stays open before its
 * terminal attaches, so passing through it attaches nothing (W54).
 */
export const ATTACH_DELAY_MS = 500;
export const TOAST_TIMEOUT_MS = 4_000;
/**
 * A toast with an action (W63): long enough to read it, look up from what you were doing and reach
 * its button, which a plain toast's 4 s isn't. Its time stops while it's hovered or focused, as any toast's.
 */
export const TOAST_ACTION_TIMEOUT_MS = 10_000;
export const COPIED_TIMEOUT_MS = 2_000;
