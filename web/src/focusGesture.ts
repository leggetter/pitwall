// When a terminal may take the keyboard (W57; docs/design-system.md, 4: Terminal, and 6.1 rule 8).
// A running background session's view attaches as it opens, however it opened (W54), but its terminal
// takes focus only right after this page's user asked for it here: a click or Enter on the session's
// row, on the view's Terminal tab, on Attach again, or on Restart and attach. That's a gesture. The
// attach that follows spends it, once, within GESTURE_MS, and only while focus is still in the view or
// on the gesture's own element, so what's typed in the filter meanwhile never reaches the session.
//
// Nothing else gives one: not the URL, a reload, back or forward, a restored tab, a root tab's switch,
// a session started from New session, or a step with j, k, ↑ or ↓. So after a reload onto a session
// waiting on a permission prompt, the next Enter can't approve it: the terminal's bar says how to type
// to it instead.

/**
 * How long a gesture lasts: long enough for the terminal to load, which waits up to 3 s for its font
 * (4: Terminal), and attach; short enough that a slow attach can't take focus long after.
 */
export const GESTURE_MS = 5_000;

export interface FocusGesture {
  /** When it happened, by Date.now(). */
  readonly at: number;
  /** The element it was on, a row's button, the Terminal tab or Attach again, when there's one. */
  readonly target: Element | undefined;
  /** Spent: the attach that followed it has asked. */
  used: boolean;
}

export function focusGesture(target?: Element | null, now = Date.now()): FocusGesture {
  return { at: now, target: target ?? undefined, used: false };
}

/** Focus is nowhere: on the page itself, or on an element that has left it. */
function nowhere(active: Element | null): boolean {
  return active === null || active === document.body || active === document.documentElement || !active.isConnected;
}

/**
 * Whether a terminal that has just attached may take focus, spending the gesture whatever the answer:
 * yes when there's one, not yet spent and at most GESTURE_MS old, and focus is in `view`, on the
 * gesture's own element, or nowhere because that element has gone, as Attach again goes once the
 * attach starts. A clock that went backwards counts as too old.
 */
export function spendGesture(gesture: FocusGesture | undefined, view: Element | null | undefined, now = Date.now()): boolean {
  if (!gesture || gesture.used) return false;
  gesture.used = true;
  const age = now - gesture.at;
  if (age < 0 || age > GESTURE_MS) return false;
  const active = document.activeElement;
  if (nowhere(active)) return gesture.target !== undefined && !gesture.target.isConnected;
  return active === gesture.target || (view?.contains(active) ?? false);
}
