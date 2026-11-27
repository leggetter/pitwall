// The relay route (W11, D8): POST relayPath(id) with a RelayRequest, answered
// with a RelayResult. The /api/* middleware in server.ts has already required
// the apiKey (never the raw token) and this server's Origin, because it's a
// POST. Then:
//
//   200  the relay's outcome: delivered, held, refused, failed (nothing was
//        sent) with why, or uncertain (it may have been sent) with why
//   400  the body isn't a RelayRequest: `text` must be 1 to 8,192 characters
//        as received, not only whitespace, with no NUL. Or resolveSession():
//        not a safe id. The relay then makes look-alike spaces plain and CRLF
//        LF (relayText.ts plainSpaces(), W43), which only shortens it
//   404  resolveSession(): not in the current snapshot
//   409  not a session with a live process, such as one that has ended
//        (SessionSummary.ended), which has no process to deliver to; or a
//        background session and a text that isn't the one paragraph pitwall
//        writes for it (W226), or one it already sent for the same lead
//   413  the body is over 64 KiB
//   415  the body isn't `Content-Type: application/json`
//   429  the relay is busy, or restarting. Retry-After is set
//   503  resolveSession(): no snapshot yet
//
// A background session (W226) is messaged through the same relay and gate, by its name as SendMessage
// takes it (spike 021, finding 4), but only with the paragraph Report to… offers: the route sends the
// text only when it is exactly `sources.workerText(id)`, the server's own workerBrief() text for that
// worker's lead, so the page can't have the relay send anything else to a background session. Each
// (session, lead, text) goes once in a few minutes: a repeat is a 409 (each delivery starts a turn in
// an unattended worker), and a changed lead link clears the entry. Without `workerText`, a background
// session is refused.
//
// Every answer, success or not, is a RelayResult, so the web UI reads one
// shape. The target comes from the resolved summary: its name, pid and
// directory, never anything in the request beyond `text`.
import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Indexer } from '../index/index.js';
import { relayPath, type RelayResult } from '../shared/protocol.js';
import type { RelayManager } from './relay.js';
import { resolveSession } from './sessions.js';

export const MAX_RELAY_TEXT_LENGTH = 8192;
/** 8,192 characters are at most about 48 KiB of JSON, every one escaped. */
export const MAX_RELAY_BODY_BYTES = 64 * 1024;

/** How long a delivered background paragraph counts as already sent (W226). */
export const WORKER_TEXT_REPEAT_MS = 5 * 60 * 1000;

/** The route as a Hono pattern. relayPath() encodes its argument, so the pattern is decoded back. */
const RELAY_ROUTE = decodeURIComponent(relayPath(':sessionId'));

const LOOKUP_ERRORS = {
  400: 'That is not a valid session id.',
  404: "That session isn't in pitwall's list.",
  503: "pitwall hasn't listed the sessions yet. Try again in a moment.",
} as const;

/** The text of a RelayRequest, or why it isn't one. */
export function validateRelayRequest(body: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'The body must be a JSON object.' };
  const { text } = body as Record<string, unknown>;
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'Write a message to send.' };
  if (text.length > MAX_RELAY_TEXT_LENGTH) return { ok: false, error: `A message can be at most ${MAX_RELAY_TEXT_LENGTH} characters.` };
  if (text.includes('\u0000')) return { ok: false, error: 'The message contains a NUL character.' };
  return { ok: true, text };
}

/**
 * Adds the relay route. Call it after the /api/* checks and before the
 * /api/* catch-all, as ServerInternals.routes does.
 */
export function registerRelay(
  app: Hono,
  indexer: Pick<Indexer, 'latest'>,
  relay: Pick<RelayManager, 'send'>,
  sources: {
    /** The only text a background session is sent: workerBrief()'s for it, or undefined when there's none. */
    workerText?: (sessionId: string) => string | undefined;
    /** The lead the worker reports to now: a change clears its repeat entry. */
    leadOf?: (sessionId: string) => string | undefined;
    now?: () => number;
  } = {},
): void {
  /** For each background session, the text hash and lead of its last send, and when. */
  const sent = new Map<string, { hash: string; lead: string | undefined; at: number }>();
  const now = sources.now ?? Date.now;
  const answer = (c: Context, result: RelayResult, status: 200 | 400 | 404 | 409 | 413 | 415 | 429 | 503) => {
    c.header('Cache-Control', 'no-store');
    return c.json(result, status);
  };
  const failed = (detail: string): RelayResult => ({ status: 'failed', detail });

  app.post(
    RELAY_ROUTE,
    bodyLimit({ maxSize: MAX_RELAY_BODY_BYTES, onError: (c) => answer(c, failed('The message is too large.'), 413) }),
    async (c) => {
      const lookup = resolveSession(indexer, c.req.param('sessionId'));
      if (!lookup.ok) return answer(c, failed(LOOKUP_ERRORS[lookup.status]), lookup.status);
      const { session } = lookup;
      const background = session.kind === 'background';
      const workerText = sources.workerText;
      if (background && workerText === undefined) {
        return answer(c, failed('Only interactive sessions are messaged through the relay. Attach to a background session instead.'), 409);
      }
      if (session.ended === true) {
        return answer(c, failed("That session has ended, so there's no process to deliver to. Resume it in the background first."), 409);
      }
      if (!session.alive || session.pid === undefined) {
        return answer(c, failed("That session isn't running, so there's nothing to message."), 409);
      }

      const type = c.req.header('content-type') ?? '';
      if (!/^application\/json\s*(;|$)/i.test(type)) return answer(c, failed('Send the request as application/json.'), 415);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return answer(c, failed("The body isn't valid JSON."), 400);
      }
      const request = validateRelayRequest(body);
      if (!request.ok) return answer(c, failed(request.error), 400);
      let record: { hash: string; lead: string | undefined; at: number } | undefined;
      if (background && workerText !== undefined) {
        // Only the server's own paragraph for this worker's lead, byte for byte (W226).
        const own = workerText(session.sessionId);
        if (own === undefined || request.text !== own) {
          return answer(
            c,
            failed('pitwall sends a background session only the paragraph Report to… offers it, and that has changed or isn’t available now. Open Report to… again, or attach to the session.'),
            409,
          );
        }
        const lead = sources.leadOf?.(session.sessionId);
        const hash = createHash('sha256').update(request.text).digest('hex');
        const before = sent.get(session.sessionId);
        if (before !== undefined && (before.lead !== lead || now() - before.at >= WORKER_TEXT_REPEAT_MS)) sent.delete(session.sessionId);
        else if (before?.hash === hash) {
          return answer(c, failed('already told: pitwall sent this session its lead’s name a moment ago, so it didn’t send it again.'), 409);
        }
        record = { hash, lead, at: now() };
        sent.set(session.sessionId, record);
      }

      // From the resolved summary, never the request.
      const outcome = await relay.send({ sessionId: session.sessionId, name: session.name, pid: session.pid, cwd: session.cwd }, request.text);
      const { retryAfterSeconds, ...result } = outcome;
      // Nothing was sent: the click can be tried again.
      if (record !== undefined && (retryAfterSeconds !== undefined || result.status === 'failed' || result.status === 'refused') && sent.get(session.sessionId) === record) {
        sent.delete(session.sessionId);
      }
      if (retryAfterSeconds !== undefined) {
        c.header('Retry-After', String(retryAfterSeconds));
        return answer(c, result, 429);
      }
      return answer(c, result, 200);
    },
  );
}
