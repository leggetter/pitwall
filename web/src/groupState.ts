// Which groups are open. Groups start collapsed, and the ones opened or closed
// are remembered in localStorage, so the screen looks the same after a refresh
// or a browser restart. Storage can be missing or throw, in a private window or
// with site data blocked; that only means every group starts collapsed.

/** One versioned key, so a later format can replace this one cleanly. */
export const GROUP_STATE_KEY = 'pitwall.groups.v1';

/**
 * Which groups have their "Finished" sub-list open, in the same format, by
 * group id. Kept apart from GROUP_STATE_KEY so a group's own state and its
 * finished list's state don't share an entry.
 */
export const FINISHED_STATE_KEY = 'pitwall.finished.v1';

/** Group id (see `groupId`) to true when the group is open. A group with no entry is collapsed. */
export type GroupState = ReadonlyMap<string, boolean>;

/**
 * Returns the storage to use. A function, because in some browsers reading
 * `window.localStorage` itself throws when site data is blocked.
 */
export type StorageSource = () => Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

export const browserStorage: StorageSource = () => window.localStorage;

/**
 * The stored state, or an empty one when there is none, it can't be read, or it
 * isn't the expected shape. `key` is GROUP_STATE_KEY or FINISHED_STATE_KEY.
 */
export function readGroupState(storage: StorageSource = browserStorage, key: string = GROUP_STATE_KEY): Map<string, boolean> {
  const state = new Map<string, boolean>();
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return state;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return state;
    for (const [id, open] of Object.entries(parsed)) {
      if (typeof open === 'boolean') state.set(id, open);
    }
  } catch {
    state.clear();
  }
  return state;
}

/**
 * Stores the state of the groups in `current`, the ids in the latest snapshot.
 * Entries for any other group are dropped, so the stored data doesn't grow as
 * repos and worktrees come and go. A failure to write is ignored.
 */
export function writeGroupState(
  state: GroupState,
  current: ReadonlySet<string>,
  storage: StorageSource = browserStorage,
  key: string = GROUP_STATE_KEY,
): void {
  const kept = Object.fromEntries([...state].filter(([id]) => current.has(id)));
  try {
    storage()?.setItem(key, JSON.stringify(kept));
  } catch {
    // Blocked or full: the state lasts until the page reloads.
  }
}
