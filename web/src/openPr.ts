// The open pull request, in the URL (M4, W95; docs/design-system.md, 4: Pull requests): ?pr=<owner>/
// <name>/<number>, its lowercase repo and its number (prKey() in prs.ts), alongside the repo list's
// selection, as ?session= is (openSession.ts). The third column shows one thing, so a PR opened takes
// the place of ?session=, in the same history entry, and a session opened takes the place of ?pr=.
// With both in a URL, as only one typed by hand can have, the session shows.
//
// Opening pushes a history entry, moving between PRs with ↑/↓ replaces it, closing pushes one without
// the parameter, and popstate makes the view follow the URL.

import { useCallback, useEffect, useRef, useState } from 'react';
import { PR_PARAM, parseSession, SESSION_PARAM, withoutParams } from './openSession.js';
import { isRepoKey } from './prs.js';
import { browserNavigation, type NavigationEnv } from './selection.js';
import type { HistoryMode } from './openSession.js';

export { PR_PARAM };

/** A PR's key as ?pr= has it: a lowercase `owner/name` (isRepoKey()), then its number. */
const PR_VALUE = /^(.+)\/([1-9][0-9]{0,9})$/;

/** The open PR's key in a query string, or undefined with none, one that isn't a PR's key, or a ?session= that shows instead. */
export function parsePr(search: string): string | undefined {
  if (parseSession(search) !== undefined) return undefined;
  const value = new URLSearchParams(search).get(PR_PARAM);
  const repo = value === null ? undefined : PR_VALUE.exec(value)?.[1];
  return repo !== undefined && isRepoKey(repo) ? (value ?? undefined) : undefined;
}

/**
 * `search` with ?pr= set to `key`, in place of any ?session=, or removed when it's undefined, every
 * other parameter kept, in order, with the PR last. Its `/` stay readable, as a selection's do.
 */
export function withPr(search: string, key: string | undefined): string {
  const kept = withoutParams(search, key === undefined ? [PR_PARAM] : [PR_PARAM, SESSION_PARAM]);
  if (key === undefined) return kept;
  return `${kept === '' ? '?' : `${kept}&`}${PR_PARAM}=${encodeURIComponent(key).replace(/%2F/gi, '/')}`;
}

export interface OpenPr {
  /** The open PR's key, from the URL, or undefined with none open. */
  key: string | undefined;
  /** Opens a PR, in place of an open session. Push for opening it, replace for moving to it with ↑/↓. */
  open: (key: string, mode?: HistoryMode) => void;
  /** Closes its view, pushing an entry without ?pr=. */
  close: () => void;
  /** Makes the open PR match the URL again, after something else changed it, as opening a session does. */
  follow: () => void;
}

/** The open PR, from the URL, as useOpenSession() has the open session. Reading it opens nothing else. */
export function useOpenPr(navigation: NavigationEnv = browserNavigation): OpenPr {
  const [key, setKey] = useState<string | undefined>(() => parsePr(navigation.location.search));
  const current = useRef(key);
  current.current = key;

  const follow = useCallback(() => {
    const next = parsePr(navigation.location.search);
    current.current = next;
    setKey(next);
  }, [navigation]);

  useEffect(() => {
    navigation.addEventListener('popstate', follow);
    return () => navigation.removeEventListener('popstate', follow);
  }, [navigation, follow]);

  const write = useCallback(
    (next: string | undefined, mode: HistoryMode) => {
      const { pathname, search, hash } = navigation.location;
      const url = `${pathname}${withPr(search, next)}${hash}`;
      if (mode === 'push') navigation.history.pushState(navigation.history.state, '', url);
      else navigation.history.replaceState(navigation.history.state, '', url);
    },
    [navigation],
  );

  const open = useCallback(
    (next: string, mode: HistoryMode = 'push') => {
      // The same PR again adds no entry, unless a session is in the URL too, which it takes the place of.
      if (next !== current.current || parseSession(navigation.location.search) !== undefined) write(next, mode);
      current.current = next;
      setKey(next);
    },
    [write, navigation],
  );

  const close = useCallback(() => {
    if (current.current === undefined) return;
    write(undefined, 'push');
    current.current = undefined;
    setKey(undefined);
  }, [write]);

  return { key, open, close, follow };
}
