import { lazy, useMemo } from 'react';
import { ApiContext, createApiClient, defaultFetch, type FetchLike } from './api.js';
import { AttachContext, type AttachEnv } from './attach.js';
import { Dashboard } from './components/Dashboard.js';
import { NoTokenNotice, TokenRejectedNotice } from './components/Notice.js';
import { defaultSocketFactory, useConnection, type SocketFactory } from './connection.js';
import { createReplyLoader, ReplyLoaderContext } from './lastMessage.js';
import { useToken } from './token.js';
import { UikitRoute } from './uikit/route.js';

export interface AppProps {
  /** Opens the WebSocket. Tests pass a fake; the browser's `WebSocket` otherwise. */
  createSocket?: SocketFactory;
  /** Makes API requests. Tests pass a fake; the browser's `fetch` otherwise. */
  fetch?: FetchLike;
}

/**
 * The design system's gallery (W19, docs/design-system.md), shown at #uikit. Only in dev builds:
 * `npm run dev` builds in Vite's development mode, and the tests run in its test mode. `npm run
 * build` is the production mode, where this is null, so the build leaves out the route, the
 * gallery, its fixtures and its stylesheet.
 */
const Gallery =
  import.meta.env.MODE === 'development' || import.meta.env.MODE === 'test' ? lazy(() => import('./uikit/Gallery.js')) : null;

function Connected({ token, createSocket, fetch }: { token: string; createSocket: SocketFactory; fetch: FetchLike }) {
  // One API client per token. It holds the apiKey in memory only, and the
  // connection hands it a fresh key on every handshake.
  const api = useMemo(() => createApiClient({ fetch }), [fetch]);
  const view = useConnection(token, { createSocket, keys: api.keys });
  const loader = useMemo(() => createReplyLoader({ api }), [api]);
  // Attach sockets answer their own challenge with the same token (W10).
  const attach = useMemo<AttachEnv>(() => ({ token, createSocket, host: window.location.host }), [token, createSocket]);
  // Only a 4401 on the WebSocket means the token is no good. An HTTP 401 means
  // the apiKey is stale, after a server restart: the client reconnects for a
  // new one and retries, so it never shows this.
  if (view.state === 'unauthorized') return <TokenRejectedNotice />;
  return (
    <ApiContext.Provider value={api}>
      <ReplyLoaderContext.Provider value={loader}>
        <AttachContext.Provider value={attach}>
          <Dashboard view={view} />
        </AttachContext.Provider>
      </ReplyLoaderContext.Provider>
    </ApiContext.Provider>
  );
}

function Main({ createSocket = defaultSocketFactory, fetch = defaultFetch }: AppProps) {
  const token = useToken();
  if (!token) return <NoTokenNotice />;
  // Keyed by the token, so a new one starts afresh: a new connection, a new API client, an empty reply cache.
  return <Connected key={token} token={token} createSocket={createSocket} fetch={fetch} />;
}

export function App(props: AppProps) {
  // While the gallery shows, the app is unmounted: no token read, no WebSocket, no API call.
  if (Gallery) {
    return (
      <UikitRoute gallery={Gallery}>
        <Main {...props} />
      </UikitRoute>
    );
  }
  return <Main {...props} />;
}
