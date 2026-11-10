// Spin-off proposals (W163): a session's proposal for a new session (SessionSummary.spinOff, read by
// src/index/spinOff.ts), checked before New session opens with it. The proposal is untrusted session
// text, so it gets the checks the supervisor's spawn_session gets, by the same function, checkSpawn()
// (supervisorActions.ts), not a copy: the folder an existing directory under a root, by its real path;
// the name New session's; the prompt not blank, at most SPAWN_PROMPT_MAX, not just a claude command;
// no character that doesn't show as itself.
//
//   POST spinOffPath(id)   body: { key } as JSON, the proposal the card showed   answers: SpinOffCheck
//     200  { ok: true, cwd, name?, prompt }: what New session opens with, the folder by its real path
//     400, 404, 503  from resolveSession(); 400 also when the body isn't { key }
//     409  it proposes nothing now, or another proposal than the card showed, or one pitwall
//          couldn't read; or the checks refuse it, with why
//     413  the body is over SPIN_OFF_BODY_MAX_BYTES
//     415  the body isn't `Content-Type: application/json`
//
// The proposal is the snapshot's, never the request's: the request names only which one, so a page
// can't have pitwall check text the session didn't write. Nothing starts here and nothing is sent to
// the session: New session's own request starts it, after you've read and maybe changed what it's
// filled in with, and the spawn route checks that again. A POST, so the /api/* middleware in
// server.ts has already required the apiKey and this server's Origin.
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isRecord } from '../index/guards.js';
import { spinOffPath, type IndexSnapshot, type SpinOffCheck } from '../shared/protocol.js';
import { LOOKUP_ERRORS } from './actions.js';
import { resolveSession } from './sessions.js';
import { checkSpawn } from './supervisorActions.js';

/** The route as a Hono pattern. spinOffPath() encodes its argument, so the pattern is decoded back. */
const SPIN_OFF_ROUTE = decodeURIComponent(spinOffPath(':sessionId'));

/** The most a check's body can be: `{ "key": "<16 hex>" }` with room to spare. */
export const SPIN_OFF_BODY_MAX_BYTES = 256;

const KEY = /^[0-9a-f]{16}$/;

export interface SpinOffRouteSources {
  snapshots: { latest(): IndexSnapshot | undefined };
}

export function registerSpinOffs(app: Hono, sources: SpinOffRouteSources): void {
  const answer = (c: Context, result: SpinOffCheck, status: 200 | 400 | 404 | 409 | 413 | 415 | 503) => {
    c.header('Cache-Control', 'no-store');
    return c.json(result, status);
  };

  app.post(
    SPIN_OFF_ROUTE,
    bodyLimit({ maxSize: SPIN_OFF_BODY_MAX_BYTES, onError: (c) => answer(c, { ok: false, error: 'The request is too large.' }, 413) }),
    async (c) => {
      const lookup = resolveSession(sources.snapshots, c.req.param('sessionId'));
      if (!lookup.ok) return answer(c, { ok: false, error: LOOKUP_ERRORS[lookup.status] }, lookup.status);
      const type = c.req.header('content-type') ?? '';
      if (!/^application\/json\s*(;|$)/i.test(type)) return answer(c, { ok: false, error: 'Send the request as application/json.' }, 415);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return answer(c, { ok: false, error: "The body isn't valid JSON." }, 400);
      }
      if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.key !== 'string' || !KEY.test(body.key)) {
        return answer(c, { ok: false, error: 'The body must be { key }, the proposal’s key.' }, 400);
      }
      const proposal = lookup.session.spinOff;
      if (proposal === undefined) return answer(c, { ok: false, error: 'That session doesn’t propose a new session now.' }, 409);
      if (proposal.key !== body.key) return answer(c, { ok: false, error: 'That session has proposed something else since. Read its new proposal first.' }, 409);
      if (proposal.kind !== 'proposal') return answer(c, { ok: false, error: proposal.problem }, 409);
      const input = { directory: proposal.folder, prompt: proposal.prompt, ...(proposal.name === undefined ? {} : { name: proposal.name }) };
      const checked = await checkSpawn(input, sources.snapshots.latest());
      if (!checked.ok) return answer(c, { ok: false, error: checked.error }, 409);
      const { cwd, name, prompt } = checked.value.spawn;
      return answer(c, { ok: true, cwd, prompt, ...(name === undefined ? {} : { name }) }, 200);
    },
  );
}
