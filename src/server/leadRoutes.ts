// The routes for leads and workers (W218, spike 021, option B): Make lead and Not a lead, Report to… and
// Not a worker, and Start a worker…'s note of the session it started. Each records ids in the LeadStore
// (src/server/leads.ts) and nothing else: no message goes to any session from here.
//
// Behind the /api/* checks in server.ts, like every route: the token or apiKey, Host and Origin, and for
// a POST the apiKey and this Origin. Here:
//   POST leadPath(id)          { on: boolean }       Make lead, or Not a lead
//   POST workerPath(id)        { lead: id | null }   Report to… that lead, or Not a worker
//   POST workerStartedPath(id) { shortId }           Start a worker… started `shortId` for this session
// Each answers a LeadResult, Cache-Control: no-store:
//   200  done, or nothing to do
//   400  a session id that isn't a canonical UUID, a body that isn't the one above, or JSON that doesn't parse
//   404  the session in the path isn't in pitwall's list
//   409  the store refused the change (a worker made a lead, a lead made a worker, a lead that isn't one),
//        the body's lead isn't in pitwall's list, or a short id this pitwall didn't start a moment ago
//   413  the body is over LEAD_BODY_MAX_BYTES
//   415  not application/json
//   503  pitwall hasn't listed the sessions yet
// No rate limit, as for flags and snoozes: a change is one small entry, the file is capped, and nothing runs.
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isRecord } from '../index/guards.js';
import { isSessionUuid } from '../index/transcripts.js';
import { leadPath, workerPath, workerStartedPath, type LeadResult } from '../shared/protocol.js';
import type { LeadStore } from './leads.js';
import type { RecentSpawns } from './recentSpawns.js';
import { findSession, resolveSession } from './sessions.js';
import type { SnapshotView } from './snapshotLinks.js';

/** The largest body taken: `{"lead":"<uuid>"}` is 47 bytes. */
export const LEAD_BODY_MAX_BYTES = 1024;

const LEAD_ROUTE = decodeURIComponent(leadPath(':sessionId'));
const WORKER_ROUTE = decodeURIComponent(workerPath(':sessionId'));
const WORKER_STARTED_ROUTE = decodeURIComponent(workerStartedPath(':sessionId'));
const SHORT_ID = /^[0-9a-f]{8}$/;

const LOOKUP_ERRORS = {
  400: 'That is not a valid session id.',
  404: "That session isn't in pitwall's list.",
  503: "pitwall hasn't listed the sessions yet. Try again in a moment.",
} as const;

export interface LeadRouteSources {
  /** The snapshot the page sees: the session in the path, and a body's lead, must be listed in it. */
  snapshots: Pick<SnapshotView, 'latest'>;
  store: Pick<LeadStore, 'mark' | 'link' | 'unlink' | 'expectWorker' | 'isWorker'>;
  /** The short ids this pitwall's New session started a moment ago (W168's check). Without it, worker-started refuses every one. */
  spawned?: Pick<RecentSpawns, 'has'>;
}

type Status = 200 | 400 | 404 | 409 | 413 | 415 | 503;

/** Adds the lead and worker routes. Call it after the /api/* checks and before the /api/* catch-all. */
export function registerLeads(app: Hono, sources: LeadRouteSources): void {
  const answer = (c: Context, result: LeadResult, status: Status) => {
    c.header('Cache-Control', 'no-store');
    return c.json(result, status);
  };
  const limit = bodyLimit({ maxSize: LEAD_BODY_MAX_BYTES, onError: (c) => answer(c, { ok: false, error: 'The request is too large.' }, 413) });

  /** The listed session in the path, with a UUID id, and the body as an object with exactly `field`; or the refusal. */
  const read = async (c: Context, field: string): Promise<{ ok: true; sessionId: string; value: unknown } | { ok: false; error: string; status: Status }> => {
    const lookup = resolveSession(sources.snapshots, c.req.param('sessionId'));
    if (!lookup.ok) return { ok: false, error: LOOKUP_ERRORS[lookup.status], status: lookup.status };
    if (!isSessionUuid(lookup.session.sessionId)) return { ok: false, error: LOOKUP_ERRORS[400], status: 400 };
    const type = c.req.header('content-type') ?? '';
    if (!/^application\/json\s*(;|$)/i.test(type)) return { ok: false, error: 'Send the request as application/json.', status: 415 };
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return { ok: false, error: "The body isn't valid JSON.", status: 400 };
    }
    if (!isRecord(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, field)) return { ok: false, error: `The body must be { ${field} }.`, status: 400 };
    return { ok: true, sessionId: lookup.session.sessionId, value: body[field] };
  };

  app.post(LEAD_ROUTE, limit, async (c) => {
    const body = await read(c, 'on');
    if (!body.ok) return answer(c, { ok: false, error: body.error }, body.status);
    if (typeof body.value !== 'boolean') return answer(c, { ok: false, error: 'The body must be { on }, true or false.' }, 400);
    const result = sources.store.mark(body.sessionId, body.value);
    return result.ok ? answer(c, { ok: true }, 200) : answer(c, result, 409);
  });

  app.post(WORKER_ROUTE, limit, async (c) => {
    const body = await read(c, 'lead');
    if (!body.ok) return answer(c, { ok: false, error: body.error }, body.status);
    if (body.value === null) {
      const result = sources.store.unlink(body.sessionId);
      return result.ok ? answer(c, { ok: true }, 200) : answer(c, result, 409);
    }
    if (typeof body.value !== 'string' || !isSessionUuid(body.value)) return answer(c, { ok: false, error: 'The body must be { lead }, a session id, or null.' }, 400);
    // Only a lead pitwall lists, so the page can't link a session to an id it made up.
    const snapshot = sources.snapshots.latest();
    if (snapshot === undefined || findSession(snapshot, body.value) === undefined) return answer(c, { ok: false, error: "That lead isn't in pitwall's list." }, 409);
    const result = sources.store.link(body.sessionId, body.value, 'reported');
    return result.ok ? answer(c, { ok: true }, 200) : answer(c, result, 409);
  });

  app.post(WORKER_STARTED_ROUTE, limit, async (c) => {
    const body = await read(c, 'shortId');
    if (!body.ok) return answer(c, { ok: false, error: body.error }, body.status);
    if (typeof body.value !== 'string' || !SHORT_ID.test(body.value)) return answer(c, { ok: false, error: 'The body must be { shortId }, a job’s short id.' }, 400);
    // A worker isn't a lead, so it can't have workers of its own.
    if (sources.store.isWorker(body.sessionId)) return answer(c, { ok: false, error: 'It’s a worker, so it can’t have workers. Choose Not a worker on it first.' }, 409);
    // Only a session this pitwall started a moment ago, so the page can't link two sessions that merely exist.
    if (sources.spawned?.has(body.value) !== true) return answer(c, { ok: false, error: 'pitwall didn’t start that session a moment ago, so it won’t link it.' }, 409);
    if (!sources.store.expectWorker(body.value, body.sessionId)) return answer(c, { ok: false, error: 'pitwall couldn’t note that link.' }, 409);
    return answer(c, { ok: true }, 200);
  });
}
