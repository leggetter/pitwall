// What the repo list has selected (docs/design-system.md, 3: Repo list): the Needs you view, All
// sessions, or one group. It's in the URL, as ?view=needs-you, ?view=all or ?repo=<key>, with
// &root=<root> when pitwall watches more than one root, so a reload or the back button shows the
// same columns. The last one chosen is kept in localStorage as pitwall.view.v1, for a URL with none.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { IndexSnapshot, SessionGroup } from '../../src/shared/protocol.js';
import { browserStorage, type StorageSource } from './groupState.js';
import { shortenHome } from './format.js';
import { groupId, groupLabel, primaryGroup, type Scope } from './sessions.js';

export const VIEW_STATE_KEY = 'pitwall.view.v1';

export type Selection = { view: 'needs-you' | 'all' } | { repo: string; root?: string };

export const ALL_SESSIONS: Selection = { view: 'all' };
export const NEEDS_YOU: Selection = { view: 'needs-you' };

/** The query parameters a selection uses; any others, such as ?session=, are left as they are. */
const PARAMS = ['view', 'repo', 'root'] as const;

/** The selection in a query string, or undefined when it has none, or one that isn't valid. */
export function parseSelection(search: string): Selection | undefined {
  const params = new URLSearchParams(search);
  const view = params.get('view');
  const repo = params.get('repo');
  const root = params.get('root');
  if (view !== null) return view === 'needs-you' || view === 'all' ? { view } : undefined;
  if (repo === null || repo === '') return undefined;
  return root === null || root === '' ? { repo } : { repo, root };
}

/** Percent-encoding that leaves the characters of a path readable: / ~ : @ and so on. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/%(2F|40|3A|7E|2C)/gi, (match) => decodeURIComponent(match));
}

/** `search` with the selection's parameters set and every other parameter kept. Starts with "?". */
export function withSelection(search: string, selection: Selection): string {
  const kept = [...new URLSearchParams(search)].filter(([name]) => !(PARAMS as readonly string[]).includes(name));
  const own: [string, string][] = 'view' in selection ? [['view', selection.view]] : [['repo', selection.repo], ...(selection.root ? [['root', selection.root] as [string, string]] : [])];
  return `?${[...own, ...kept].map(([name, value]) => `${encode(name)}=${encode(value)}`).join('&')}`;
}

/** The link for a selection, as a repo list item's href. */
export function selectionHref(selection: Selection): string {
  return withSelection('', selection);
}

/** The selection for a group: its key, and its root when there's more than one root to tell apart. */
export function groupSelection(group: Pick<SessionGroup, 'root' | 'key'>, roots: readonly string[]): Selection {
  return roots.length > 1 ? { repo: group.key, root: group.root } : { repo: group.key };
}

export function sameSelection(a: Selection, b: Selection): boolean {
  if ('view' in a || 'view' in b) return 'view' in a && 'view' in b && a.view === b.view;
  return a.repo === b.repo && (a.root ?? '') === (b.root ?? '');
}

/** The group a selection names, if it's in the snapshot. Without a root, the first group with the key. */
export function findGroup(groups: readonly SessionGroup[], selection: Selection): SessionGroup | undefined {
  if ('view' in selection) return undefined;
  return groups.find((group) => group.key === selection.repo && (selection.root === undefined || group.root === selection.root));
}

/** What the session list shows for a selection: a view, the group, or undefined for a group that has left the snapshot. */
export function scopeFor(groups: readonly SessionGroup[], selection: Selection): Scope | undefined {
  if ('view' in selection) return selection.view === 'all' ? { kind: 'all' } : { kind: 'needs-you' };
  const group = findGroup(groups, selection);
  return group ? { kind: 'group', group } : undefined;
}

/**
 * A selection's name on screen. A group that has left the snapshot is named from its key: a root's
 * own directory, which empties once its sessions are listed under the repos they worked in (W34),
 * by its path, as the repo list labels it, and any other by its last segment.
 */
export function selectionName(groups: readonly SessionGroup[], selection: Selection, roots: readonly string[] = []): string {
  if ('view' in selection) return selection.view === 'all' ? 'All sessions' : 'Needs you';
  const group = findGroup(groups, selection);
  if (group) return groupLabel(group);
  const key = selection.repo.replace(/\/+$/, '');
  if (isRootSelection(selection, roots)) return shortenHome(key);
  return key.split('/').pop() || selection.repo;
}

/** Whether a selection is a root's own directory, whether or not its group is in the snapshot. */
export function isRootSelection(selection: Selection, roots: readonly string[]): boolean {
  if ('view' in selection) return false;
  const key = selection.repo.replace(/\/+$/, '');
  return roots.some((root) => root.replace(/\/+$/, '') === key);
}

/**
 * Where a selection's Finished section remembers whether it's open, in pitwall.finished.v1: a group's
 * id, as before the three columns, or the view's name.
 */
export function finishedStateId(selection: Selection, group: SessionGroup | undefined): string | undefined {
  if ('view' in selection) return selection.view === 'all' ? 'view:all' : undefined;
  return group ? groupId(group) : undefined;
}

export function readStoredSelection(storage: StorageSource = browserStorage): Selection | undefined {
  try {
    const raw = storage()?.getItem(VIEW_STATE_KEY);
    return raw ? parseSelection(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredSelection(selection: Selection, storage: StorageSource = browserStorage): void {
  try {
    storage()?.setItem(VIEW_STATE_KEY, withSelection('', selection).slice(1));
  } catch {
    // Blocked or full: the URL still has it.
  }
}

/** The parts of `window` the selection uses, so tests and the gallery can pass their own. */
export interface NavigationEnv {
  location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  history: Pick<History, 'pushState' | 'replaceState' | 'state'>;
  addEventListener(type: 'popstate', listener: () => void): void;
  removeEventListener(type: 'popstate', listener: () => void): void;
}

export const browserNavigation: NavigationEnv = window;

/** A navigation of its own, in memory, that never touches the address bar: for the gallery's pages. */
export function memoryNavigation(search = ''): NavigationEnv {
  const location = { pathname: '/', search, hash: '' };
  return {
    location,
    history: {
      state: null,
      pushState: (_state, _unused, url) => {
        location.search = new URL(String(url), 'http://pitwall.invalid/').search;
      },
      replaceState: (_state, _unused, url) => {
        location.search = new URL(String(url), 'http://pitwall.invalid/').search;
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

/**
 * The selection, from the URL, and a way to choose another. A URL with none takes the stored one, or
 * All sessions, and is replaced to match, except that ?session= with no selection waits for the
 * snapshot and selects that session's group: where it started, or, for one started in the root that
 * worked in repos, the repo it touched most recently. Choosing pushes a history entry; popstate
 * follows the URL.
 */
export function useSelection(
  snapshot: IndexSnapshot | undefined,
  { navigation = browserNavigation, storage = browserStorage }: { navigation?: NavigationEnv; storage?: StorageSource } = {},
): [Selection, (next: Selection) => void] {
  const url = (search: string) => `${navigation.location.pathname}${search}${navigation.location.hash}`;
  // ?session=, with no selection: the session's group, once the snapshot says which it is.
  const pending = useRef<string | undefined>(undefined);
  const [selection, setSelection] = useState<Selection>(() => {
    const fromUrl = parseSelection(navigation.location.search);
    if (fromUrl) return fromUrl;
    const session = new URLSearchParams(navigation.location.search).get('session');
    if (session) pending.current = session;
    return readStoredSelection(storage) ?? ALL_SESSIONS;
  });

  // Put a selection taken from storage, or the default, into the URL.
  useEffect(() => {
    if (pending.current === undefined && !parseSelection(navigation.location.search)) {
      navigation.history.replaceState(navigation.history.state, '', url(withSelection(navigation.location.search, selection)));
    }
    // Only on mount: later selections write the URL themselves.
  }, []);

  useEffect(() => {
    const sessionId = pending.current;
    if (sessionId === undefined || !snapshot) return;
    pending.current = undefined;
    // The group it started in, or for one started in the root that worked in repos, the newest of those.
    const listed = snapshot.groups.flatMap((candidate) => candidate.sessions).find((session) => session.sessionId === sessionId);
    const group = listed ? primaryGroup(snapshot.groups, listed) : undefined;
    const next = group ? groupSelection(group, snapshot.roots) : selection;
    navigation.history.replaceState(navigation.history.state, '', url(withSelection(navigation.location.search, next)));
    setSelection(next);
  }, [snapshot, selection, navigation]);

  useEffect(() => {
    const onPopState = () => {
      const fromUrl = parseSelection(navigation.location.search);
      if (fromUrl) setSelection(fromUrl);
    };
    navigation.addEventListener('popstate', onPopState);
    return () => navigation.removeEventListener('popstate', onPopState);
  }, [navigation]);

  const current = useRef(selection);
  current.current = selection;
  const choose = useCallback(
    (next: Selection) => {
      pending.current = undefined;
      writeStoredSelection(next, storage);
      if (!sameSelection(current.current, next)) {
        navigation.history.pushState(navigation.history.state, '', `${navigation.location.pathname}${withSelection(navigation.location.search, next)}${navigation.location.hash}`);
      }
      setSelection(next);
    },
    [navigation, storage],
  );

  return [selection, choose];
}
