// What the repo list has selected (docs/design-system.md, 3: Repo list): the Needs you view, All
// sessions, Starred (W53), or one group. It's in the URL, as ?view=needs-you, ?view=all,
// ?view=starred or ?repo=<key>, with &root=<root> when pitwall watches more than one root, so a
// reload or the back button shows the same columns. The last one chosen is kept in localStorage as
// pitwall.view.v1, for a URL with none.
//
// With more than one root, the root also says which root tab is open (W38, rootTabs.ts), for the
// views as well as a group: ?view=all&root=<root>. A selection without one, or with one pitwall
// doesn't watch, is given its tab's root once the snapshot says what the roots are, and the URL is
// replaced to match. With one root, a view's root is dropped, so the URL is as it always was.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { IndexSnapshot, SessionGroup } from '../../src/shared/protocol.js';
import { browserStorage, type StorageSource } from './groupState.js';
import { shortenHome } from './format.js';
import { hasTabs, readStoredTab, selectionTab } from './rootTabs.js';
import { groupId, groupLabel, startGroup, type Scope } from './sessions.js';

export const VIEW_STATE_KEY = 'pitwall.view.v1';

/** The repo list's views, in its order: Needs you, All sessions, then Starred (W53). */
export type View = 'needs-you' | 'all' | 'starred';

const VIEWS: readonly string[] = ['needs-you', 'all', 'starred'] satisfies readonly View[];

const isView = (value: string): value is View => VIEWS.includes(value);

/** A view, or a group. With more than one root, each names its root, which is the open root tab. */
export type Selection = { view: View; root?: string } | { repo: string; root?: string };

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
  const rooted = root === null || root === '' ? {} : { root };
  if (view !== null) return isView(view) ? { view, ...rooted } : undefined;
  if (repo === null || repo === '') return undefined;
  return { repo, ...rooted };
}

/** Percent-encoding that leaves the characters of a path readable: / ~ : @ and so on. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/%(2F|40|3A|7E|2C)/gi, (match) => decodeURIComponent(match));
}

/** `search` with the selection's parameters set and every other parameter kept. Starts with "?". */
export function withSelection(search: string, selection: Selection): string {
  const kept = [...new URLSearchParams(search)].filter(([name]) => !(PARAMS as readonly string[]).includes(name));
  const root: [string, string][] = selection.root ? [['root', selection.root]] : [];
  const own: [string, string][] = 'view' in selection ? [['view', selection.view], ...root] : [['repo', selection.repo], ...root];
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
  if ((a.root ?? '') !== (b.root ?? '')) return false;
  if ('view' in a || 'view' in b) return 'view' in a && 'view' in b && a.view === b.view;
  return a.repo === b.repo;
}

/** A view in a root tab: with a root when pitwall watches more than one, so the URL says which tab is open. */
export function viewIn(view: View, tab: string | undefined): Selection {
  return tab === undefined ? { view } : { view, root: tab };
}

/**
 * The selection as the URL should have it for these roots (W38). With more than one, it names the
 * tab it opens (selectionTab() in rootTabs.ts says which). With one, a view names no root, as before
 * there were tabs; a group keeps what it has. The same object when nothing changes.
 */
export function rootedSelection(selection: Selection, snapshot: Pick<IndexSnapshot, 'roots' | 'groups'>, stored: string | undefined): Selection {
  if (!hasTabs(snapshot.roots)) {
    if (!('view' in selection) || selection.root === undefined) return selection;
    return { view: selection.view };
  }
  const tab = selectionTab('view' in selection ? { root: selection.root } : selection, snapshot, stored);
  if (tab === undefined || selection.root === tab) return selection;
  return 'view' in selection ? { view: selection.view, root: tab } : { repo: selection.repo, root: tab };
}

/** The group a selection names, if it's in the snapshot. Without a root, the first group with the key. */
export function findGroup(groups: readonly SessionGroup[], selection: Selection): SessionGroup | undefined {
  if ('view' in selection) return undefined;
  return groups.find((group) => group.key === selection.repo && (selection.root === undefined || group.root === selection.root));
}

/**
 * What the session list shows for a selection: a view, the group, or undefined for a group that has
 * left the snapshot. Starred lists the sessions whose ids are in `starred` (W53).
 */
export function scopeFor(groups: readonly SessionGroup[], selection: Selection, starred: ReadonlySet<string> = new Set()): Scope | undefined {
  if ('view' in selection) {
    if (selection.view === 'starred') return { kind: 'starred', ids: starred };
    return selection.view === 'all' ? { kind: 'all' } : { kind: 'needs-you' };
  }
  const group = findGroup(groups, selection);
  return group ? { kind: 'group', group } : undefined;
}

/** Each view's name on screen, as the repo list and the session list's heading show it. */
export const VIEW_NAMES: Readonly<Record<View, string>> = { 'needs-you': 'Needs you', all: 'All sessions', starred: 'Starred' };

/**
 * A selection's name on screen. A group that has left the snapshot is named from its key: a root's
 * own directory by its path, as the repo list labels it, and any other by its last segment.
 */
export function selectionName(groups: readonly SessionGroup[], selection: Selection, roots: readonly string[] = []): string {
  if ('view' in selection) return VIEW_NAMES[selection.view];
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
 * id, as before the three columns, or the view's name. Needs you has no Finished section.
 */
export function finishedStateId(selection: Selection, group: SessionGroup | undefined): string | undefined {
  if ('view' in selection) return selection.view === 'needs-you' ? undefined : `view:${selection.view}`;
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

/** What useSelection() gives besides the selection and choosing one. */
export interface SelectionExtras {
  /** The open root tab, with more than one root once the snapshot says what they are (W38): the selection's root. */
  tab: string | undefined;
  /** Makes the selection match the URL again, after something else pushed an entry for it, as a root tab does. */
  follow: () => void;
}

/**
 * The selection, from the URL, and a way to choose another. A URL with none takes the stored one, or
 * All sessions, and is replaced to match, except that ?session= with no selection waits for the
 * snapshot and selects that session's group: its home group in `home`, the one the chosen grouping lists
 * it under (groupBy.ts, W42), or else the first group that lists it. Choosing pushes a history entry;
 * popstate follows the URL. With more than one root, once the snapshot is in, a selection is given the
 * root of the tab it opens, as rootedSelection() says, and the URL is replaced to match.
 *
 * `snapshot` is the snapshot's roots with the groups as the chosen grouping has them, so a group the
 * page built for a repo with none in the snapshot opens its own tab.
 */
export function useSelection(
  snapshot: Pick<IndexSnapshot, 'roots' | 'groups'> | undefined,
  {
    navigation = browserNavigation,
    storage = browserStorage,
    home,
  }: { navigation?: NavigationEnv; storage?: StorageSource; home?: ReadonlyMap<string, SessionGroup> | undefined } = {},
): [Selection, (next: Selection) => void, SelectionExtras] {
  const url = (search: string) => `${navigation.location.pathname}${search}${navigation.location.hash}`;
  // ?session=, with no selection: the session's home group, once the snapshot says which it is.
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

  // The open root tab when the URL doesn't say, read once: a URL with no selection, or none pitwall watches.
  const [storedTab] = useState(() => readStoredTab(storage));

  // Before it's painted, so the columns never show a tab or a group the URL is about to leave.
  useLayoutEffect(() => {
    if (!snapshot) return;
    let next = selection;
    const sessionId = pending.current;
    if (sessionId !== undefined) {
      pending.current = undefined;
      // The group the chosen grouping lists it under (W42), or the first that lists it.
      const listed = snapshot.groups.flatMap((candidate) => candidate.sessions).find((session) => session.sessionId === sessionId);
      const group = listed ? (home?.get(sessionId) ?? startGroup(snapshot.groups, listed)) : undefined;
      if (group) next = groupSelection(group, snapshot.roots);
    }
    // With several roots, the selection names its tab; with one, a view names none.
    next = rootedSelection(next, snapshot, storedTab);
    if (sessionId === undefined && next === selection) return;
    navigation.history.replaceState(navigation.history.state, '', url(withSelection(navigation.location.search, next)));
    setSelection(next);
  }, [snapshot, selection, navigation, home]);

  const follow = useCallback(() => {
    const fromUrl = parseSelection(navigation.location.search);
    if (fromUrl) setSelection(fromUrl);
  }, [navigation]);

  useEffect(() => {
    navigation.addEventListener('popstate', follow);
    return () => navigation.removeEventListener('popstate', follow);
  }, [navigation, follow]);

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

  const tab = snapshot ? selectionTab('view' in selection ? { root: selection.root } : selection, snapshot, storedTab) : undefined;
  return [selection, choose, { tab, follow }];
}
