// The session pane filling the browser window (W224, docs/design-system.md, 3: Session pane, and
// docs/ui-map.md). A control in the view header collapses the repo list and the session list, each to
// a narrow rail with a button that opens it again on its own, so the session pane takes the window
// under the header. Only in three columns (from 1,200 px): below that the session view already lies
// over the session list, and the control isn't offered.
//
// Kept in localStorage as pitwall.pane-fill.v1, a small versioned JSON value, {"v":1,"repos":true,"list":true},
// for which column is collapsed: booleans only, no session content. Storage can be missing or throw
// (a private window, site data blocked): then nothing starts collapsed, the control still works for
// the page's life, and nothing throws. A value that isn't this shape collapses nothing.

import { createContext, useCallback, useState } from 'react';
import { browserStorage, type StorageSource } from './groupState.js';

export const PANE_FILL_KEY = 'pitwall.pane-fill.v1';

export interface Collapsed {
  /** The repo list is collapsed to its rail. */
  repos: boolean;
  /** The session list is collapsed to its rail. */
  list: boolean;
}

const NOTHING: Collapsed = { repos: false, list: false };

export function readCollapsed(storage: StorageSource = browserStorage): Collapsed {
  try {
    const raw = storage()?.getItem(PANE_FILL_KEY);
    if (!raw) return NOTHING;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return NOTHING;
    const { v, repos, list } = value as Record<string, unknown>;
    return v === 1 ? { repos: repos === true, list: list === true } : NOTHING;
  } catch {
    return NOTHING;
  }
}

function writeCollapsed(storage: StorageSource, value: Collapsed): void {
  try {
    storage()?.setItem(PANE_FILL_KEY, JSON.stringify({ v: 1, ...value }));
  } catch {
    // Not remembered; it still works for the page's life.
  }
}

export interface PaneFill {
  collapsed: Collapsed;
  /** Both columns collapsed: the session pane fills the window. */
  filled: boolean;
  /** Collapse both, or, when both are collapsed, open both. With one opened on its own, it collapses both again. */
  toggle: () => void;
  /** Open one column again, leaving the other as it is. */
  open: (column: keyof Collapsed) => void;
}

export function usePaneFill(storage: StorageSource = browserStorage): PaneFill {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(storage));
  const apply = useCallback(
    (next: Collapsed) => {
      writeCollapsed(storage, next);
      setCollapsed(next);
    },
    [storage],
  );
  const toggle = useCallback(() => apply(collapsed.repos && collapsed.list ? NOTHING : { repos: true, list: true }), [apply, collapsed]);
  const open = useCallback((column: keyof Collapsed) => apply({ ...collapsed, [column]: false }), [apply, collapsed]);
  return { collapsed, filled: collapsed.repos && collapsed.list, toggle, open };
}

/** What the session view's header needs to offer the control, provided only while it can: from 1,200 px (W224). */
export interface PaneFillControl {
  /** Both columns are collapsed, so the control opens them again. */
  filled: boolean;
  onToggle: () => void;
}

export const PaneFillContext = createContext<PaneFillControl | undefined>(undefined);
