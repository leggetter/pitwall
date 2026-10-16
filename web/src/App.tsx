import { useMemo, useState, type ReactNode } from 'react';
import { Dashboard } from './components/Dashboard.js';
import { defaultSocketFactory, useConnection, type SocketFactory } from './connection.js';
import { createReplyLoader, defaultFetch, ReplyLoaderContext, type FetchLike } from './lastMessage.js';
import { useToken } from './token.js';

export interface AppProps {
  /** Opens the WebSocket. Tests pass a fake; the browser's `WebSocket` otherwise. */
  createSocket?: SocketFactory;
  /** Fetches full replies. Tests pass a fake; the browser's `fetch` otherwise. */
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
  // A 401 from the API means what a 4401 on the WebSocket means: this token is no good.
  const [rejected, setRejected] = useState(false);
  const view = useConnection(rejected ? null : token, createSocket);
  const loader = useMemo(
    () => createReplyLoader({ token, fetch, onUnauthorized: () => setRejected(true) }),
    [token, fetch],
  );
  if (rejected || view.state === 'unauthorized') {
    return <Notice>Token rejected; reopen pitwall from the URL the command printed.</Notice>;
  }
  return (
    <ReplyLoaderContext.Provider value={loader}>
      <Dashboard view={view} />
    </ReplyLoaderContext.Provider>
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
  // Keyed by the token, so a new one starts afresh: a new connection, an empty reply cache, not rejected.
  return <Connected key={token} token={token} createSocket={createSocket} fetch={fetch} />;
}
