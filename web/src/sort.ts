// The session list's Sort setting (docs/design-system.md, 3: Session list): Urgency, Recent or Name,
// for every selection, saved in localStorage as pitwall.sort.v1. Storage can be missing or throw, in
// a private window or with site data blocked; that only means the list starts sorted by urgency.

import { useCallback, useState } from 'react';
import { browserStorage, type StorageSource } from './groupState.js';
import { SORT_ORDERS, type SortOrder } from './sessions.js';

export const SORT_KEY = 'pitwall.sort.v1';

/** The index's own order. */
export const DEFAULT_SORT: SortOrder = 'urgency';

function isSortOrder(value: unknown): value is SortOrder {
  return typeof value === 'string' && (SORT_ORDERS as readonly string[]).includes(value);
}

/** The stored order, or Urgency when there's none, it can't be read, or it isn't one of the three. */
export function readSort(storage: StorageSource = browserStorage): SortOrder {
  try {
    const stored = storage()?.getItem(SORT_KEY);
    return isSortOrder(stored) ? stored : DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
  }
}

export function writeSort(order: SortOrder, storage: StorageSource = browserStorage): void {
  try {
    storage()?.setItem(SORT_KEY, order);
  } catch {
    // Blocked or full: the order lasts until the page reloads.
  }
}

/** The order, read once, and a setter that stores each choice. */
export function useSort(storage: StorageSource = browserStorage): [SortOrder, (order: SortOrder) => void] {
  const [order, setOrder] = useState(() => readSort(storage));
  const choose = useCallback(
    (next: SortOrder) => {
      setOrder(next);
      writeSort(next, storage);
    },
    [storage],
  );
  return [order, choose];
}
