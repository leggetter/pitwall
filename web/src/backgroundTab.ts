// Preferences: Open running background sessions on (docs/design-system.md, 4: Preferences, and 4:
// Session view: header, tabs and footer), W54. Phil, 2026-10-22: a background session
// "defaults to the conversation view when I select the session even though I can't do anything in
// it." A background session takes input only in its terminal (D3), so a running one's view opens on
// its Terminal tab, which attaches. A finished one still opens on Conversation, since attaching
// restarts it, and so does every session whose Terminal tab is off. This setting is the way back to
// Conversation for running ones too.
//
// It decides only the tab a view opens on: once it's open, the tab you choose is yours, and the view
// never switches it for you. SessionView reads it as it opens.
//
// The choice is kept in localStorage as pitwall.background-tab.v1, holding the tab alone: "terminal"
// or "conversation". Missing, throwing or any other value gives Terminal, as groupBy.ts falls back.

import { useCallback, useState } from 'react';
import { browserStorage, type StorageSource } from './groupState.js';

export type BackgroundTab = 'terminal' | 'conversation';

export const BACKGROUND_TAB_KEY = 'pitwall.background-tab.v1';

export const DEFAULT_BACKGROUND_TAB: BackgroundTab = 'terminal';

/** The choices in the Preferences dialog's order, the default first. */
export const BACKGROUND_TABS: readonly BackgroundTab[] = ['terminal', 'conversation'];

/** Each choice's label: the tab's own name. */
export const BACKGROUND_TAB_LABELS: Readonly<Record<BackgroundTab, string>> = {
  terminal: 'Terminal',
  conversation: 'Conversation',
};

/**
 * Each choice's one plain line in the Preferences dialog, under its label. Terminal's says the terminal
 * is ready, not that it takes the keyboard: whether it does is The terminal takes the keyboard's (W57).
 */
export const BACKGROUND_TAB_DESCRIPTIONS: Readonly<Record<BackgroundTab, string>> = {
  terminal: 'The session attaches as its view opens, so its terminal is ready to use.',
  conversation: 'The session attaches only once you open its Terminal tab.',
};

/** The radio group's legend, which reads on into each choice: "… on Terminal". */
export const BACKGROUND_TAB_TITLE = 'Open running background sessions on';

export function isBackgroundTab(value: unknown): value is BackgroundTab {
  return typeof value === 'string' && (BACKGROUND_TABS as readonly string[]).includes(value);
}

/** The stored choice, or Terminal when there's none, it can't be read, or it isn't one of the two. */
export function readBackgroundTab(storage: StorageSource = browserStorage): BackgroundTab {
  try {
    const stored = storage()?.getItem(BACKGROUND_TAB_KEY);
    return isBackgroundTab(stored) ? stored : DEFAULT_BACKGROUND_TAB;
  } catch {
    return DEFAULT_BACKGROUND_TAB;
  }
}

export function writeBackgroundTab(tab: BackgroundTab, storage: StorageSource = browserStorage): void {
  try {
    storage()?.setItem(BACKGROUND_TAB_KEY, tab);
  } catch {
    // Blocked or full: the choice lasts until the page reloads.
  }
}

/** The choice, read once, and a setter that stores each choice. */
export function useBackgroundTab(storage: StorageSource = browserStorage): [BackgroundTab, (tab: BackgroundTab) => void] {
  const [tab, setTab] = useState(() => readBackgroundTab(storage));
  const choose = useCallback(
    (next: BackgroundTab) => {
      setTab(next);
      writeBackgroundTab(next, storage);
    },
    [storage],
  );
  return [tab, choose];
}
