import type { ReactNode } from 'react';

/** A whole-page message in place of the dashboard. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <main className="notice">
      <h1 className="brand">pitwall</h1>
      <p>{children}</p>
    </main>
  );
}

/** The page was opened without a token, or its tab lost it. */
export function NoTokenNotice() {
  return (
    <Notice>
      Open pitwall from the URL the <code>pitwall</code> command printed.
    </Notice>
  );
}

/** The server closed the WebSocket with 4401: the token is no good. */
export function TokenRejectedNotice() {
  return <Notice>Token rejected; reopen pitwall from the URL the command printed.</Notice>;
}
