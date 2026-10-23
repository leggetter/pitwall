// When the terminal takes the keyboard (W57; docs/design-system.md, 4: Session view: header, tabs and
// footer, and 4: Terminal). Phil, 2026-10-23: "go with your call. But make that a config option in
// preferences." Two choices, and no "always", which is what W48's second pass (H1) found unsafe: after
// a reload onto a session waiting on a permission prompt, the next Enter approved it.
//
// - `after-open`, the default: the terminal takes the keyboard as it attaches only right after you
//   open the session or its Terminal tab with a click or Enter in this page, or press Attach again or
//   Restart and attach, and only while focus is still in the view (focusGesture.ts). Never after a
//   reload, the URL, back or forward, a root tab's switch, or a step with j, k, ↑ or ↓.
// - `never`: the terminal never takes the keyboard by itself. You click it or Tab to it, and its bar
//   says so: "Click the terminal, or Tab to it, to type to the session".
//
// This module is the store and its hook alone: the control is W59's, in the Preferences dialog. The
// view reads the choice each time a terminal attaches, so a change applies from the next attach. It's
// kept in localStorage as pitwall.terminal-focus.v1, holding the value alone. Missing, throwing or any
// other value gives `after-open`, as backgroundTab.ts falls back.

import { useCallback, useState } from 'react';
import { browserStorage, type StorageSource } from './groupState.js';

export type TerminalFocus = 'after-open' | 'never';

export const TERMINAL_FOCUS_KEY = 'pitwall.terminal-focus.v1';

export const DEFAULT_TERMINAL_FOCUS: TerminalFocus = 'after-open';

/** The choices in the order a control would list them, the default first. */
export const TERMINAL_FOCUSES: readonly TerminalFocus[] = ['after-open', 'never'];

/** A name for the setting, which reads on into each label: "The terminal takes the keyboard when you open it". */
export const TERMINAL_FOCUS_TITLE = 'The terminal takes the keyboard';

/** Each choice's label, after the title. */
export const TERMINAL_FOCUS_LABELS: Readonly<Record<TerminalFocus, string>> = {
  'after-open': 'When you open it',
  never: 'Never',
};

/** Each choice's one plain line, under its label. */
export const TERMINAL_FOCUS_DESCRIPTIONS: Readonly<Record<TerminalFocus, string>> = {
  'after-open': 'Right after you open the session or its Terminal tab with a click or Enter. Never after a reload, the back button or j and k.',
  never: 'Click the terminal, or Tab to it, to type to the session.',
};

export function isTerminalFocus(value: unknown): value is TerminalFocus {
  return typeof value === 'string' && (TERMINAL_FOCUSES as readonly string[]).includes(value);
}

/** The stored choice, or `after-open` when there's none, it can't be read, or it isn't one of the two. */
export function readTerminalFocus(storage: StorageSource = browserStorage): TerminalFocus {
  try {
    const stored = storage()?.getItem(TERMINAL_FOCUS_KEY);
    return isTerminalFocus(stored) ? stored : DEFAULT_TERMINAL_FOCUS;
  } catch {
    return DEFAULT_TERMINAL_FOCUS;
  }
}

export function writeTerminalFocus(choice: TerminalFocus, storage: StorageSource = browserStorage): void {
  try {
    storage()?.setItem(TERMINAL_FOCUS_KEY, choice);
  } catch {
    // Blocked or full: the choice lasts until the page reloads.
  }
}

/** The choice, read once, and a setter that stores each choice. */
export function useTerminalFocus(storage: StorageSource = browserStorage): [TerminalFocus, (choice: TerminalFocus) => void] {
  const [choice, setChoice] = useState(() => readTerminalFocus(storage));
  const choose = useCallback(
    (next: TerminalFocus) => {
      setChoice(next);
      writeTerminalFocus(next, storage);
    },
    [storage],
  );
  return [choice, choose];
}
