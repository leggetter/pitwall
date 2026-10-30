// The supervisor's routes (M5, W113): message it, start it, stop its turn, and its approvals,
// which W115 brings. Its conversation, GET supervisorConversationPath(), is with the other
// conversation pages in server.ts, under their shared limit.
//
// Each comes after the /api/* checks in server.ts: Host, this server's Origin, and, since each is
// a POST, the apiKey, never the raw token. None ever puts your text on a command line: a message
// goes to the supervisor's stdin as a stream-json user message (src/supervisor/supervisor.ts).
//
//   POST SUPERVISOR_MESSAGE_PATH   body: { text } as JSON              answers: ActionResult
//     200  written, or queued behind the running turn; the supervisor was started or resumed first if needed
//     400  not JSON, or not { text } with text that isn't blank and has no NUL
//     409  the supervisor is off (--no-supervisor), or held: a running session has its id
//     413  the body is over SUPERVISOR_MAX_BODY_BYTES, or text is over SUPERVISOR_MESSAGE_MAX characters
//     415  not `Content-Type: application/json`
//     429  the supervisor's queue is full. Retry-After is set
//     502  it couldn't start, or exited as it started: `error` says why, in pitwall's words
//     503  pitwall is closing
//
//   POST SUPERVISOR_START_PATH     no body                             answers: ActionResult
//     200  running: started, resumed, or already up
//     409, 502, 503  as for a message
//
//   POST SUPERVISOR_INTERRUPT_PATH no body                             answers: ActionResult
//     200  the interrupt was sent: the turn ends, and the snapshot says so
//     409  off, or no turn is running
//
//   POST supervisorApprovalPath(id)                                    answers: ActionResult
//     404  always, until W115 brings approvals
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isRecord } from '../index/guards.js';
import { SUPERVISOR_INTERRUPT_PATH, SUPERVISOR_MESSAGE_MAX, SUPERVISOR_MESSAGE_PATH, SUPERVISOR_START_PATH, supervisorApprovalPath, type ActionResult } from '../shared/protocol.js';
import type { Supervisor, SupervisorOutcome } from '../supervisor/supervisor.js';

/** SUPERVISOR_MESSAGE_MAX characters are at most about 120 KiB of JSON, every one escaped. */
export const SUPERVISOR_MAX_BODY_BYTES = 160 * 1024;

/** What every route says with `--no-supervisor`. */
export const SUPERVISOR_OFF_ERROR = 'The supervisor is off: pitwall was started with --no-supervisor.';

const APPROVAL_ROUTE = decodeURIComponent(supervisorApprovalPath(':id'));

type Status = 200 | 400 | 404 | 409 | 413 | 415 | 429 | 502 | 503;

/** The text of a message, or why it isn't one, with its status. */
export function validateSupervisorMessage(body: unknown): { ok: true; text: string } | { ok: false; error: string; status: 400 | 413 } {
  if (!isRecord(body)) return { ok: false, error: 'The body must be a JSON object.', status: 400 };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'text') return { ok: false, error: 'The body must be { "text": … } and nothing else.', status: 400 };
  const { text } = body;
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'Write a message to send.', status: 400 };
  if (text.length > SUPERVISOR_MESSAGE_MAX) return { ok: false, error: `A message to the supervisor can be at most ${SUPERVISOR_MESSAGE_MAX.toLocaleString('en-US')} characters.`, status: 413 };
  if (text.includes('\u0000')) return { ok: false, error: 'The message contains a NUL character.', status: 400 };
  return { ok: true, text };
}

/** Adds the routes. Call it after the /api/* checks and before the /api/* catch-all, as ServerInternals.routes does. */
export function registerSupervisor(app: Hono, supervisor: Supervisor | undefined): void {
  const answer = (c: Context, result: ActionResult, status: Status) => {
    c.header('Cache-Control', 'no-store');
    return c.json(result, status);
  };
  const off = (c: Context) => answer(c, { ok: false, error: SUPERVISOR_OFF_ERROR }, 409);
  const outcomeAnswer = (c: Context, outcome: SupervisorOutcome) => {
    switch (outcome.kind) {
      case 'ok':
        return answer(c, { ok: true }, 200);
      case 'held':
        return answer(c, { ok: false, error: outcome.error }, 409);
      case 'failed':
        return answer(c, { ok: false, error: outcome.error }, 502);
      case 'busy':
        c.header('Retry-After', '5');
        return answer(c, { ok: false, error: 'The supervisor has messages waiting already. Send this once it has answered them.' }, 429);
      case 'closed':
        return answer(c, { ok: false, error: 'pitwall is shutting down.' }, 503);
    }
  };

  app.post(
    SUPERVISOR_MESSAGE_PATH,
    bodyLimit({ maxSize: SUPERVISOR_MAX_BODY_BYTES, onError: (c) => answer(c, { ok: false, error: 'The message is too large.' }, 413) }),
    async (c) => {
      if (supervisor === undefined) return off(c);
      if (!/^application\/json\s*(;|$)/i.test(c.req.header('content-type') ?? '')) return answer(c, { ok: false, error: 'Send the request as application/json.' }, 415);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return answer(c, { ok: false, error: "The body isn't valid JSON." }, 400);
      }
      const message = validateSupervisorMessage(body);
      if (!message.ok) return answer(c, { ok: false, error: message.error }, message.status);
      return outcomeAnswer(c, await supervisor.send(message.text));
    },
  );

  app.post(SUPERVISOR_START_PATH, async (c) => {
    if (supervisor === undefined) return off(c);
    return outcomeAnswer(c, await supervisor.start());
  });

  app.post(SUPERVISOR_INTERRUPT_PATH, (c) => {
    if (supervisor === undefined) return off(c);
    const outcome = supervisor.interrupt();
    if (outcome.kind === 'idle') return answer(c, { ok: false, error: "The supervisor isn't working on anything." }, 409);
    return answer(c, { ok: true }, 200);
  });

  // W115 brings approvals; until then there are none to answer.
  app.post(APPROVAL_ROUTE, (c) => answer(c, { ok: false, error: 'There is no such approval.' }, 404));
}
