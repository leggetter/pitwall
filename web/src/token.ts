// Token transport: the CLI opens a launch file that sends the browser to
// http://127.0.0.1:<port>/#token=<token> (D7). The UI takes the token from the
// fragment, keeps it in sessionStorage, and removes it from the address bar so
// it doesn't linger in history, bookmarks or screen shares.
//
// The token never leaves the page. It's used only to answer the WebSocket's
// challenge with an HMAC (connection.ts); HTTP API calls carry the apiKey the
// server sends back (api.ts).

import { useEffect, useState } from 'react';

export const TOKEN_STORAGE_KEY = 'pitwall.token';

/** The parts of `window` the token handling touches, so tests can pass their own. */
export interface TokenEnv {
  location: Pick<Location, 'hash' | 'pathname' | 'search'>;
  history: Pick<History, 'replaceState' | 'state'>;
  sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
}

/**
 * Reads `token` from the URL fragment. Returns `undefined` when the fragment has
 * no `token` parameter, the token (possibly empty) when it does, and the
 * fragment with the token removed.
 */
export function parseHashToken(hash: string): { token: string | undefined; rest: string } {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const token = params.get('token') ?? undefined;
  params.delete('token');
  const rest = params.toString();
  return { token, rest: rest ? `#${rest}` : '' };
}

/**
 * Takes the token from the fragment if there is one, storing it and cleaning
 * the address bar, and otherwise falls back to the stored token. Returns null
 * when there is no token anywhere.
 */
export function takeToken(env: TokenEnv = window): string | null {
  const { token, rest } = parseHashToken(env.location.hash);

  if (token !== undefined) {
    env.history.replaceState(env.history.state, '', `${env.location.pathname}${env.location.search}${rest}`);
    if (token) {
      try {
        env.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      } catch {
        // Storage can be disabled. The token still works until the page reloads.
      }
      return token;
    }
  }

  try {
    return env.sessionStorage.getItem(TOKEN_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * The current token. Re-reads it when the fragment changes, because opening a
 * fresh pitwall URL in a tab that already shows pitwall is a fragment
 * navigation, not a page load.
 */
export function useToken(env: TokenEnv & Pick<Window, 'addEventListener' | 'removeEventListener'> = window): string | null {
  const [token, setToken] = useState(() => takeToken(env));

  useEffect(() => {
    const onHashChange = () => {
      const next = takeToken(env);
      if (next) setToken(next);
    };
    env.addEventListener('hashchange', onHashChange);
    return () => env.removeEventListener('hashchange', onHashChange);
  }, [env]);

  return token;
}
