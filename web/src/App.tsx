import { useMemo, type ReactNode } from 'react';
import { ApiContext, createApiClient, defaultFetch, type FetchLike } from './api.js';
import { AttachContext, type AttachEnv } from './attach.js';
import { Dashboard } from './components/Dashboard.js';
import { defaultSocketFactory, useConnection, type SocketFactory } from './connection.js';
import { createReplyLoader, ReplyLoaderContext } from './lastMessage.js';
import { useToken } from './token.js';

export interface AppProps {
  /** Opens the WebSocket. Tests pass a fake; the browser's `WebSocket` otherwise. */
  createSocket?: SocketFactory;
  /** Makes API requests. Tests pass a fake; the browser's `fetch` otherwise. */
  fetch?: FetchLike;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <main className="notice">
      <h1 className="brand">pitwall</h1>
      <p>{children}</p>
    </main>
  );
}

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
  if (view.state === 'unauthorized') {
    return <Notice>Token rejected; reopen pitwall from the URL the command printed.</Notice>;
  }
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

export function App({ createSocket = defaultSocketFactory, fetch = defaultFetch }: AppProps) {
  const token = useToken();
  if (!token) {
    return (
      <Notice>
        Open pitwall from the URL the <code>pitwall</code> command printed.
      </Notice>
    );
  }
  // Keyed by the token, so a new one starts afresh: a new connection, a new API client, an empty reply cache.
  return <Connected key={token} token={token} createSocket={createSocket} fetch={fetch} />;
}
