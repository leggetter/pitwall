import type { ReactNode } from 'react';
import { Dashboard } from './components/Dashboard.js';
import { defaultSocketFactory, useConnection, type SocketFactory } from './connection.js';
import { useToken } from './token.js';

export interface AppProps {
  /** Opens the WebSocket. Tests pass a fake; the browser's `WebSocket` otherwise. */
  createSocket?: SocketFactory;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <main className="notice">
      <h1 className="brand">pitwall</h1>
      <p>{children}</p>
    </main>
  );
}

function Connected({ token, createSocket }: { token: string; createSocket: SocketFactory }) {
  const view = useConnection(token, createSocket);
  if (view.state === 'unauthorized') {
    return <Notice>Token rejected; reopen pitwall from the URL the command printed.</Notice>;
  }
  return <Dashboard view={view} />;
}

export function App({ createSocket = defaultSocketFactory }: AppProps) {
  const token = useToken();
  if (!token) {
    return (
      <Notice>
        Open pitwall from the URL the <code>pitwall</code> command printed.
      </Notice>
    );
  }
  return <Connected token={token} createSocket={createSocket} />;
}
