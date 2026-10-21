// Groups hidden from the repo list (docs/design-system.md, 3: Repo list, and 4: Hidden groups), W35.
// A repo or directory can be hidden from the list, from the session list's header, and the hidden
// ones are listed at the list's foot under "Hidden (n)", to select or unhide. Hiding changes only
// the repo list: every session still shows in Needs you, All sessions and every other group.
//
// Kept in localStorage under one key per root, pitwall.hidden.v1:<root>, where <root> is the
// group's SessionGroup.root exactly as the snapshot gives it (Phil, 2026-10-21), so two pitwalls
// watching different roots keep separate lists, and a pitwall watching several reads and writes each
// root's key. Each key holds a small versioned JSON value:
//
//   {"v":1,"open":false,"groups":[{"key":"/Users/example/code/old-repo","label":"old-repo","kind":"git"}]}
//
// - groups: each hidden group's key (its absolute path), with its label and kind, so it can still be
//   listed while it's absent from the snapshot. Paths and labels only: no session's name, title or
//   prompt, as with the other pitwall.*.v1 keys.
// - open: whether the Hidden section is open.
//
// Unlike pitwall.finished.v1 (groupState.ts), an entry is never pruned: it stays until it's unhidden,
// even while its group is absent from the snapshot. Storage can be missing or throw, in a private
// window or with site data blocked, as in groupState.ts: then nothing starts hidden, hiding still
// works for the page's life, and nothing throws. A value that isn't this shape hides nothing.

import { useCallback, useRef, useState } from 'react';
import type { SessionGroup } from '../../src/shared/protocol.js';
import { browserStorage, type StorageSource } from './groupState.js';

/** Every root's key starts with this; the root's path follows it. */
export const HIDDEN_KEY_PREFIX = 'pitwall.hidden.v1:';

/** The key that holds what's hidden under `root`, a SessionGroup.root. */
export function hiddenKey(root: string): string {
  return `${HIDDEN_KEY_PREFIX}${root}`;
}

/** A hidden group: its root and key, which say which group it is, and enough to list it while it's absent from the snapshot. */
export interface HiddenGroup {
  root: string;
  key: string;
  label: string;
  kind: SessionGroup['kind'];
}

/** What one root's key holds, once read. */
export interface StoredHidden {
  groups: HiddenGroup[];
  open: boolean;
}

const NOTHING: StoredHidden = { groups: [], open: false };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What's hidden under `root`: nothing when nothing is stored, storage is missing or throws, or the
 * value isn't version 1's shape. An entry that isn't a group is skipped, and a key listed twice counts once.
 */
export function readHidden(root: string, storage: StorageSource = browserStorage): StoredHidden {
  try {
    const raw = storage()?.getItem(hiddenKey(root));
    if (!raw) return NOTHING;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.groups)) return NOTHING;
    const groups: HiddenGroup[] = [];
    for (const entry of parsed.groups as unknown[]) {
      if (!isRecord(entry)) continue;
      const { key, label, kind } = entry;
      if (typeof key !== 'string' || key === '' || typeof label !== 'string' || (kind !== 'git' && kind !== 'directory')) continue;
      if (groups.some((group) => group.key === key)) continue;
      groups.push({ root, key, label, kind });
    }
    return { groups, open: parsed.open === true };
  } catch {
    return NOTHING;
  }
}

/** Stores what's hidden under `root`, the groups whose root it is. A failure to write is ignored. */
export function writeHidden(root: string, groups: readonly HiddenGroup[], open: boolean, storage: StorageSource = browserStorage): void {
  const value = { v: 1, open, groups: groups.filter((group) => group.root === root).map(({ key, label, kind }) => ({ key, label, kind })) };
  try {
    storage()?.setItem(hiddenKey(root), JSON.stringify(value));
  } catch {
    // Blocked or full: what's hidden lasts until the page reloads.
  }
}

/** Whether `hidden` names `group`: the same key under the same root. */
export function sameGroup(hidden: Pick<HiddenGroup, 'root' | 'key'>, group: Pick<SessionGroup, 'root' | 'key'>): boolean {
  return hidden.root === group.root && hidden.key === group.key;
}

/** A hidden group as a group with no sessions, for one that's absent from the snapshot. */
export function absentGroup(hidden: HiddenGroup): SessionGroup {
  return { key: hidden.key, label: hidden.label, kind: hidden.kind, root: hidden.root, sessions: [] };
}

/** What's in memory: each root read so far, with its hidden groups, and whether the section is open. */
interface State {
  byRoot: ReadonlyMap<string, readonly HiddenGroup[]>;
  open: boolean;
}

/** `state` with every root in `roots` read from storage, or `state` itself when each has been already. */
function withRoots(state: State, roots: readonly string[], storage: StorageSource): State {
  const missing = roots.filter((root) => !state.byRoot.has(root));
  if (missing.length === 0) return state;
  const byRoot = new Map(state.byRoot);
  let open = state.open;
  for (const root of missing) {
    const stored = readHidden(root, storage);
    byRoot.set(root, stored.groups);
    // Open when a root with something hidden says so.
    if (stored.open && stored.groups.length > 0) open = true;
  }
  return { byRoot, open };
}

export interface HiddenGroups {
  /** The hidden groups under the roots pitwall watches, root by root in their order, then in the order they were hidden. */
  groups: readonly HiddenGroup[];
  /** Whether the Hidden section is open. */
  open: boolean;
  /** The hidden group a selection names, if it's one: as findGroup, a selection without a root takes the first with its key. */
  find: (repo: string, root?: string) => HiddenGroup | undefined;
  /** Hides `group` and opens the Hidden section, so it shows where it went. */
  hide: (group: SessionGroup) => void;
  unhide: (group: Pick<HiddenGroup, 'root' | 'key'>) => void;
  setOpen: (open: boolean) => void;
}

/**
 * The groups hidden under `roots`, read once for each root as it appears, and ways to change them.
 * Each change is kept in memory first, so it lasts for the page's life whatever storage does, then
 * written to its root's key; opening or closing the section writes every root with something hidden.
 */
export function useHiddenGroups(roots: readonly string[], storage: StorageSource = browserStorage): HiddenGroups {
  const [stored, setStored] = useState<State>(() => withRoots({ byRoot: new Map(), open: false }, roots, storage));
  const state = withRoots(stored, roots, storage);
  // A root seen for the first time, read during render, as React allows for state that follows props.
  if (state !== stored) setStored(state);
  const latest = useRef(state);
  latest.current = state;
  const watched = useRef(roots);
  watched.current = roots;

  const commit = useCallback(
    (next: State, changed?: string) => {
      latest.current = next;
      setStored(next);
      for (const root of watched.current) {
        const groups = next.byRoot.get(root) ?? [];
        if (root === changed || groups.length > 0) writeHidden(root, groups, next.open, storage);
      }
    },
    [storage],
  );

  const hide = useCallback(
    (group: SessionGroup) => {
      const current = latest.current;
      const list = current.byRoot.get(group.root) ?? [];
      const already = list.some((hidden) => sameGroup(hidden, group));
      const groups = already ? list : [...list, { root: group.root, key: group.key, label: group.label, kind: group.kind }];
      commit({ byRoot: new Map(current.byRoot).set(group.root, groups), open: true }, group.root);
    },
    [commit],
  );

  const unhide = useCallback(
    (group: Pick<HiddenGroup, 'root' | 'key'>) => {
      const current = latest.current;
      const list = current.byRoot.get(group.root) ?? [];
      if (!list.some((hidden) => sameGroup(hidden, group))) return;
      commit({ byRoot: new Map(current.byRoot).set(group.root, list.filter((hidden) => !sameGroup(hidden, group))), open: current.open }, group.root);
    },
    [commit],
  );

  const setOpen = useCallback(
    (open: boolean) => {
      const current = latest.current;
      if (current.open !== open) commit({ ...current, open });
    },
    [commit],
  );

  const groups = roots.flatMap((root) => state.byRoot.get(root) ?? []);
  const find = (repo: string, root?: string) => groups.find((hidden) => hidden.key === repo && (root === undefined || hidden.root === root));
  return { groups, open: state.open, find, hide, unhide, setOpen };
}
