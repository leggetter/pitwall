// Your open pull requests (M4, W93): the list, and Refresh. The list also goes to every
// authenticated WebSocket client as a 'prs' message (websocket.ts).
//
// Both routes come after the /api/* checks in server.ts: Host, Origin and the token or the apiKey,
// exactly as for SNAPSHOT_PATH, and for the POST the apiKey, never the raw token, and this
// server's Origin, as for every state-changing request. Then:
//
//   GET PRS_PATH                  no query                             answers: PullRequestList
//     200  the latest list, uncached. With --no-prs, the 'off' list
//
//   POST PRS_REFRESH_PATH         no body                              answers: ActionResult
//     200  a fetch started, or one was already running: the list arrives as a 'prs' message
//     409  pull requests are off (--no-prs), so pitwall never runs gh
//     429  the latest fetch started less than PRS_REFRESH_MIN_MS ago. Retry-After is set
//     503  the server is closing
//
// Neither ever runs gh itself: the poller (src/prs/) does, on its own timer, one fetch at a time.
import type { Hono } from 'hono';
import type { PrSource } from '../prs/index.js';
import { PRS_PATH, PRS_REFRESH_PATH, type ActionResult } from '../shared/protocol.js';

export function registerPrs(app: Hono, prs: PrSource): void {
  app.get(PRS_PATH, (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(prs.latest());
  });

  app.post(PRS_REFRESH_PATH, (c) => {
    c.header('Cache-Control', 'no-store');
    const answer = (result: ActionResult, status: 200 | 409 | 429 | 503) => c.json(result, status);
    const result = prs.refresh();
    switch (result.kind) {
      case 'started':
      case 'running':
        return answer({ ok: true }, 200);
      case 'off':
        return answer({ ok: false, error: 'Pull requests are off: pitwall was started with --no-prs, so it never runs gh.' }, 409);
      case 'too-soon': {
        const seconds = result.retryAfterSeconds;
        c.header('Retry-After', String(seconds));
        return answer({ ok: false, error: `Your pull requests were fetched moments ago. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.` }, 429);
      }
      case 'stopped':
        return answer({ ok: false, error: 'pitwall is shutting down.' }, 503);
    }
  });
}
