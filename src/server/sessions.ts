// The one way a route turns a session id from its URL into a session.
//
// Every route that takes a session id goes through resolveSession(), and every
// M2 input path must: attach (W10), messaging through the relay (W11), and
// stop and remove (W12). It does three things, in this order:
//
//   1. checks the id with the index's safe-id rule, so nothing unsafe reaches
//      a file path or a command line                                 else 400
//   2. waits for the index: before the first poll there's nothing to act on else 503
//   3. requires the session in the current snapshot, which holds only sessions
//      under the roots pitwall was started with                      else 404
//
// It returns the session's summary. Build any command from that summary's
// fields (`shortId`, `cwd`, `kind`), never from the raw route parameter.
//
// The guard comes after the /api/* checks in server.ts (Host, Origin and the
// bearer credential, plus the apiKey and Origin rule for state-changing
// methods), not instead of them.
import { isSafeSessionId, type Indexer } from '../index/index.js';
import type { IndexSnapshot, SessionSummary } from '../shared/protocol.js';

export type SessionLookup =
  | { ok: true; session: SessionSummary }
  /** 400: not a safe id. 503: no snapshot yet. 404: not in the current snapshot. */
  | { ok: false; status: 400 | 404 | 503 };

/** Resolves a route's session id against the current snapshot. See the top of this file. */
export function resolveSession(indexer: Pick<Indexer, 'latest'>, sessionId: string | undefined): SessionLookup {
  if (sessionId === undefined || !isSafeSessionId(sessionId)) return { ok: false, status: 400 };
  const snapshot = indexer.latest();
  if (!snapshot) return { ok: false, status: 503 };
  const session = findSession(snapshot, sessionId);
  return session ? { ok: true, session } : { ok: false, status: 404 };
}

/** The session with this exact id in the snapshot, if any. */
export function findSession(snapshot: IndexSnapshot, sessionId: string): SessionSummary | undefined {
  for (const group of snapshot.groups) {
    for (const session of group.sessions) {
      if (session.sessionId === sessionId) return session;
    }
  }
  return undefined;
}
