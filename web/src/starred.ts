// Starred sessions (docs/design-system.md, 4: Starred sessions), W53. Phil, 2026-10-22: "it would be
// good to be able to pin or star sessions. they then live under a pinned/starred group. Then you can
// easily switch between those you are actively working on." A star toggle on each row and in the
// session view's header marks a session, and the repo list's Starred view lists the starred sessions
// under the open root tab. "Starred", not "pinned": the docs already say "pinned tab" for a browser
// tab that keeps its token (D7).
//
// Kept in the browser, as hidden repos are: a viewer's preference, with no server change. One
// localStorage key, pitwall.starred.v1, shared across roots and tabs on the origin, since session ids
// are unique and each root tab's view lists only the sessions under its root. It holds a small
// versioned JSON value:
//
//   {"v":1,"ids":["00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002"]}
//
// - ids: each starred session's id, oldest star first. Ids only: never a session's name, title or
//   prompt, as with the other pitwall.*.v1 keys.
//
// Never pruned because a session is missing from a snapshot, since a failed poll can empty the list:
// a star stays until it's unstarred. So that the list can't grow forever, it holds at most
// STARRED_CAP ids, and starring past that drops the oldest star. A star made or cleared in another of
// pitwall's tabs arrives with the window's `storage` event, as the shortcuts setting does.
//
// Keyed on sessionId, as drafts are (drafts.ts): if Claude Code ever gave a running session a new id,
// its star wouldn't follow it.
//
// Storage can be missing or throw, in a private window or with site data blocked, as in
// groupState.ts: then nothing starts starred, starring still works for the page's life, and nothing
// throws. A value that isn't this shape stars nothing; an entry in it that isn't an id is skipped.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browserStorage, type StorageSource } from './groupState.js';

export const STARRED_KEY = 'pitwall.starred.v1';

/**
 * The most ids kept: five times the 20 sessions of Phil's try-out (W39), so it should only ever drop
 * stars on sessions long gone, and at about 40 bytes an id, the key stays near 4 KB.
 */
export const STARRED_CAP = 100;

/** Longer than any session id: Claude Code's are UUIDs, 36 characters. A longer entry isn't one. */
export const MAX_ID_LENGTH = 256;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= MAX_ID_LENGTH;

/** At most STARRED_CAP of `ids`, each once, the newest stars kept. */
function capped(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  return unique.length > STARRED_CAP ? unique.slice(unique.length - STARRED_CAP) : unique;
}

/**
 * The starred sessions' ids, oldest star first: none when nothing is stored, storage is missing or
 * throws, or the value isn't version 1's shape. An entry that isn't an id is skipped, an id listed
 * twice counts once, and past STARRED_CAP the oldest go.
 */
export function readStarred(storage: StorageSource = browserStorage): string[] {
  try {
    const raw = storage()?.getItem(STARRED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.ids)) return [];
    return capped((parsed.ids as unknown[]).filter(isId));
  } catch {
    return [];
  }
}

/** Stores the starred ids, at most STARRED_CAP of them. A failure to write is ignored. */
export function writeStarred(ids: readonly string[], storage: StorageSource = browserStorage): void {
  try {
    storage()?.setItem(STARRED_KEY, JSON.stringify({ v: 1, ids: capped(ids.filter(isId)) }));
  } catch {
    // Blocked or full: the stars last until the page reloads.
  }
}

/**
 * `ids` with `sessionId` starred or not. A new star goes last, dropping the oldest past STARRED_CAP; a
 * session already starred keeps its place. The same array when nothing changes.
 */
export function withStar(ids: readonly string[], sessionId: string, on: boolean): readonly string[] {
  const has = ids.includes(sessionId);
  if (on === has) return ids;
  return on ? capped([...ids, sessionId]) : ids.filter((id) => id !== sessionId);
}

/** The window's `storage` event, so tests and the gallery can pass their own. */
export interface StarredEvents {
  addEventListener(type: 'storage', listener: (event: Pick<StorageEvent, 'key'>) => void): void;
  removeEventListener(type: 'storage', listener: (event: Pick<StorageEvent, 'key'>) => void): void;
}

export interface Starred {
  /** The starred sessions' ids, oldest star first, whether or not they're in the snapshot. */
  ids: readonly string[];
  /** The same, to look up. */
  set: ReadonlySet<string>;
  /** Stars `sessionId`, or unstars it. */
  star: (sessionId: string, on: boolean) => void;
}

/**
 * The starred sessions, read once from storage, and a way to star or unstar one. Each change is kept
 * in memory first, so it lasts for the page's life whatever storage does, then written. A change in
 * another tab, or storage cleared (a null key), is read again; never written back, so two tabs can't
 * echo a change between them.
 */
export function useStarred(storage: StorageSource = browserStorage, events: StarredEvents = window): Starred {
  const [ids, setIds] = useState<readonly string[]>(() => readStarred(storage));
  const latest = useRef(ids);
  latest.current = ids;

  useEffect(() => {
    const onStorage = (event: Pick<StorageEvent, 'key'>) => {
      if (event.key !== STARRED_KEY && event.key !== null) return;
      const next = readStarred(storage);
      latest.current = next;
      setIds(next);
    };
    events.addEventListener('storage', onStorage);
    return () => events.removeEventListener('storage', onStorage);
  }, [storage, events]);

  const star = useCallback(
    (sessionId: string, on: boolean) => {
      const next = withStar(latest.current, sessionId, on);
      if (next === latest.current) return;
      latest.current = next;
      setIds(next);
      writeStarred(next, storage);
    },
    [storage],
  );

  const set = useMemo(() => new Set(ids), [ids]);
  return { ids, set, star };
}
