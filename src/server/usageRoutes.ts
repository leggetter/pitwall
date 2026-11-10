// The Usage view's route (W158). After the /api/* checks in server.ts: Host, Origin and the token or
// the apiKey, as for SNAPSHOT_PATH. Then:
//
//   GET USAGE_PATH?window=<week|24h|14d|30d>         answers: UsageView
//     200  the window's figures, uncached; 'week' when no window is given
//     400  a window that isn't one of those, or given twice
//     404  no usage source (a test's server, as with recaps off)
//     429  USAGE_READS_MAX requests are being read already. Retry-After is set
//
//   GET RUN_RATE_PATH                                answers: RunRate (W159)
//     200  the header's run rate: 'off' with --no-usage, 'unavailable', or the figures, uncached
//     404  no usage source
//
// The run rate reads the plan's percentages through the same reader and its cache (RATE_LIMITS_TTL_MS),
// which shares a call in flight, so however many pages or requests ask, `/usage` runs at most once in
// that time. A page asks only while it's visible (web/src/runRate.ts).
//
// It reads the transcripts on from where the last read stopped, and the plan's week through the
// rate-limits reader's cache (src/usage/service.ts), only when asked: nothing runs while no page
// asks. At most USAGE_READS_MAX requests at once, so a script holding the token can't stack reads.
import type { Hono } from 'hono';
import { RUN_RATE_PATH, USAGE_PATH, USAGE_WINDOWS, type UsageWindowKey } from '../shared/protocol.js';
import type { UsageSource } from '../usage/service.js';

/** Requests read at once: a window chosen while the first read runs, and no more. */
export const USAGE_READS_MAX = 2;

export function registerUsage(app: Hono, usage: UsageSource | undefined): void {
  let running = 0;
  app.get(USAGE_PATH, async (c) => {
    c.header('Cache-Control', 'no-store');
    if (usage === undefined) return c.body(null, 404);
    const given = c.req.queries('window');
    if (given !== undefined && given.length !== 1) return c.body(null, 400);
    const key = (given?.[0] ?? 'week') as UsageWindowKey;
    if (!USAGE_WINDOWS.includes(key)) return c.body(null, 400);
    if (running >= USAGE_READS_MAX) {
      c.header('Retry-After', '2');
      return c.body(null, 429);
    }
    running++;
    try {
      return c.json(await usage.view(key));
    } finally {
      running--;
    }
  });
  app.get(RUN_RATE_PATH, async (c) => {
    c.header('Cache-Control', 'no-store');
    if (usage === undefined) return c.body(null, 404);
    return c.json(await usage.runRate());
  });
}
