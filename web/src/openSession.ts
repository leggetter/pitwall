// The open session, in the URL (docs/design-system.md, 3: Session view): ?session=<sessionId>,
// alongside the repo list's ?view= or ?repo= (selection.ts), so a reload, a shared link or the back
// button shows the same session. Opening pushes a history entry, moving between sessions with ↑/↓
// replaces it, closing pushes one without the parameter, and popstate makes the view follow the URL.
//
// Only the session's id goes in the query string, never the token. The token is in the fragment,
// and token.ts has taken it out of the address bar before the dashboard, and so this, first reads it.
//
// The third column shows one thing (M4, W95): a session, or a pull request, ?pr= (openPr.ts). So a
// session opened drops ?pr=, in the same history entry, and a PR opened drops ?session=.

import { useCallback, useEffect, useRef, useState } from 'react';
import { browserNavigation, type NavigationEnv } from './selection.js';

export const SESSION_PARAM = 'session';

/** The open pull request's parameter (openPr.ts), which a session opened takes the place of. */
export const PR_PARAM = 'pr';

/** The open session's id in a query string, or undefined when there's none. */
export function parseSession(search: string): string | undefined {
  const id = new URLSearchParams(search).get(SESSION_PARAM);
  return id === null || id === '' ? undefined : id;
}

/**
 * `search` without the parameters named in `names`, and every other kept exactly as written, in
 * order. Starts with "?", or is empty when no parameter is left.
 */
export function withoutParams(search: string, names: readonly string[]): string {
  // The other parameters stay exactly as written: the selection's own encoding (selection.ts) leaves paths readable.
  const kept = search
    .replace(/^\?/, '')
    .split('&')
    .filter((part) => part !== '' && !names.includes(decodeName(part)));
  return kept.length > 0 ? `?${kept.join('&')}` : '';
}

/**
 * `search` with ?session= set to `sessionId`, or removed when it's undefined, and every other
 * parameter kept, in order, with the session last, except that a session set takes the place of an
 * open pull request's ?pr= (W95). Starts with "?", or is empty when no parameter is left.
 */
export function withSession(search: string, sessionId: string | undefined): string {
  const kept = withoutParams(search, sessionId === undefined ? [SESSION_PARAM] : [SESSION_PARAM, PR_PARAM]);
  if (sessionId === undefined) return kept;
  return `${kept === '' ? '?' : `${kept}&`}${SESSION_PARAM}=${encodeURIComponent(sessionId)}`;
}

function decodeName(part: string): string {
  const name = part.split('=')[0] ?? '';
  try {
    return decodeURIComponent(name.replace(/\+/g, ' '));
  } catch {
    return name;
  }
}

/** How a change to the open session goes into history. */
export type HistoryMode = 'push' | 'replace';

export interface OpenSession {
  /** The open session's id, from the URL, or undefined with nothing open. */
  id: string | undefined;
  /** Opens a session. Push for opening it, replace for moving to it with ↑/↓. */
  open: (sessionId: string, mode?: HistoryMode) => void;
  /** Closes the view, pushing an entry without ?session=. */
  close: () => void;
  /** Makes the open session match the URL again, after something else pushed an entry for it, as a root tab does. */
  follow: () => void;
}

/**
 * The open session, from the URL. Reading it opens nothing else: no message, nothing that changes a
 * session. The view it opens picks its own tab: a running background session's opens on Terminal,
 * which attaches, unless Preferences says Conversation (W54, SessionView.tsx).
 */
export function useOpenSession(navigation: NavigationEnv = browserNavigation): OpenSession {
  const [id, setId] = useState<string | undefined>(() => parseSession(navigation.location.search));
  const current = useRef(id);
  current.current = id;

  const follow = useCallback(() => {
    const next = parseSession(navigation.location.search);
    current.current = next;
    setId(next);
  }, [navigation]);

  useEffect(() => {
    navigation.addEventListener('popstate', follow);
    return () => navigation.removeEventListener('popstate', follow);
  }, [navigation, follow]);

  const write = useCallback(
    (sessionId: string | undefined, mode: HistoryMode) => {
      const { pathname, search, hash } = navigation.location;
      const url = `${pathname}${withSession(search, sessionId)}${hash}`;
      if (mode === 'push') navigation.history.pushState(navigation.history.state, '', url);
      else navigation.history.replaceState(navigation.history.state, '', url);
    },
    [navigation],
  );

  const open = useCallback(
    (sessionId: string, mode: HistoryMode = 'push') => {
      // The same session again adds no entry.
      if (sessionId !== current.current) write(sessionId, mode);
      current.current = sessionId;
      setId(sessionId);
    },
    [write],
  );

  const close = useCallback(() => {
    if (current.current === undefined) return;
    write(undefined, 'push');
    current.current = undefined;
    setId(undefined);
  }, [write]);

  return { id, open, close, follow };
}
