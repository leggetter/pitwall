// A session's recap (M5, W110): read it, or ask for one now.
//
// Both routes come after the /api/* checks in server.ts: Host, Origin and the token or the apiKey,
// exactly as for SNAPSHOT_PATH, and for the POST the apiKey, never the raw token, and this
// server's Origin, as for every state-changing request. Then resolveSession() (sessions.ts): a
// safe id, else 400; a snapshot, else 503; the session in it, else 404.
//
//   GET recapPath(id)             no query                                answers: SessionRecap
//     200  pitwall's recap, or Claude Code's away_summary in its place (source 'claude-code')
//     404  none yet, and always with --no-recaps
//
//   POST recapRefreshPath(id)     no body                                 answers: RecapRefreshResult
//     200  queued: the recap arrives in the snapshot, and from GET
//     404  pitwall has no transcript of it to recap
//     409  recaps are off (--no-recaps), so pitwall never runs a recap call
//     429  the day's budget is spent (Retry-After: local midnight), or a call for it is running,
//          which the answer's `busy` says, 'spent' or 'running'
//     503  the server is closing
//
// Neither ever runs claude itself: the engine (src/recaps/engine.ts) does, at most two at a time.
import type { Hono } from 'hono';
import type { Indexer } from '../index/index.js';
import type { RecapEngine } from '../recaps/engine.js';
import { recapPath, recapRefreshPath, type RecapRefreshResult } from '../shared/protocol.js';
import { LOOKUP_ERRORS } from './actions.js';
import { resolveSession } from './sessions.js';

/** The routes as Hono patterns: the paths encode their argument, so `:sessionId` is decoded back. */
const RECAP_ROUTE = decodeURIComponent(recapPath(':sessionId'));
const RECAP_REFRESH_ROUTE = decodeURIComponent(recapRefreshPath(':sessionId'));

export function registerRecaps(app: Hono, indexer: Pick<Indexer, 'latest'>, recaps: RecapEngine | undefined): void {
  app.get(RECAP_ROUTE, (c) => {
    c.header('Cache-Control', 'no-store');
    const lookup = resolveSession(indexer, c.req.param('sessionId'));
    if (!lookup.ok) return c.body(null, lookup.status);
    const recap = recaps?.recap(lookup.session);
    return recap === undefined ? c.body(null, 404) : c.json(recap);
  });

  app.post(RECAP_REFRESH_ROUTE, (c) => {
    c.header('Cache-Control', 'no-store');
    const answer = (result: RecapRefreshResult, status: 200 | 400 | 404 | 409 | 429 | 503) => c.json(result, status);
    if (recaps === undefined) return answer({ ok: false, error: 'Recaps are off: pitwall was started with --no-recaps, so it never runs a recap call.' }, 409);
    const lookup = resolveSession(indexer, c.req.param('sessionId'));
    if (!lookup.ok) return answer({ ok: false, error: LOOKUP_ERRORS[lookup.status] }, lookup.status);
    const result = recaps.refresh(lookup.session);
    switch (result.kind) {
      case 'queued':
        return answer({ ok: true }, 200);
      case 'no-transcript':
        return answer({ ok: false, error: "pitwall can't recap this session: it has no transcript pitwall can read." }, 404);
      case 'spent': {
        c.header('Retry-After', String(result.retryAfterSeconds));
        return answer({ ok: false, error: "Today's recaps are used up, so the next one can be made after midnight.", busy: 'spent' }, 429);
      }
      case 'running':
        c.header('Retry-After', String(result.retryAfterSeconds));
        return answer({ ok: false, error: "A recap of this session is being made now. It'll show here in a few seconds.", busy: 'running' }, 429);
      case 'closed':
        return answer({ ok: false, error: 'pitwall is shutting down.' }, 503);
    }
  });
}
