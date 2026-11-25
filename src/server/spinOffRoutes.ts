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
//   POST conversationSpinOffPath(id)   body: { key } as JSON, a block the Conversation tab's card showed (W209)
//     as above, but the block is found in the session's transcript, newest messages first, through the
//     conversation reader (at most CONVERSATION_SCAN_PAGES pages), and not in the snapshot: any block in
//     the history counts, not only the one that ends the newest message. 409 also when no message has
//     that block now (it changed, or it's older than the pages read), or two scans already run (429).
//     Still the server's own reading of the transcript: the request names only which block.
//
// The proposal is the snapshot's, never the request's: the request names only which one, so a page
// can't have pitwall check text the session didn't write. Nothing starts here and nothing is sent to
// the session: New session's own request starts it, after you've read and maybe changed what it's
// filled in with, and the spawn route checks that again. A POST, so the /api/* middleware in
// server.ts has already required the apiKey and this server's Origin.
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isRecord } from '../index/guards.js';
import { conversationSpinOffPath, spinOffPath, type ConversationPage, type IndexSnapshot, type SpinOff, type SpinOffCheck } from '../shared/protocol.js';
import { LOOKUP_ERRORS } from './actions.js';
import { resolveSession } from './sessions.js';
import type { ReadLimit } from './server.js';
import { checkSpawn } from './supervisorActions.js';

/** The route as a Hono pattern. spinOffPath() encodes its argument, so the pattern is decoded back. */
const SPIN_OFF_ROUTE = decodeURIComponent(spinOffPath(':sessionId'));

/** The most a check's body can be: `{ "key": "<16 hex>" }` with room to spare. */
export const SPIN_OFF_BODY_MAX_BYTES = 256;

const KEY = /^[0-9a-f]{16}$/;

const CONVERSATION_SPIN_OFF_ROUTE = decodeURIComponent(conversationSpinOffPath(':sessionId'));

/** How many pages of 50 entries a check reads, newest first: 1,000 entries. A block older than that isn't startable from its card. */
export const CONVERSATION_SCAN_PAGES = 20;

/** Checks at once: the scan reads the transcript, as the conversation's pages do, which have their own limit. */
export const CONVERSATION_SCANS_MAX = 2;

/** How long a scan may take: it stops paging after this and answers 503 (W209, F3). */
export const CONVERSATION_SCAN_MS = 5000;

export interface SpinOffRouteSources {
  snapshots: { latest(): IndexSnapshot | undefined };
  /** One page of the session's conversation, as the conversation route reads it (W209). Left out, that check answers 404. */
  conversation?: ((sessionId: string, before?: string) => Promise<ConversationPage | undefined>) | undefined;
  /** The server's limit on transcript reads, shared with the conversation's pages: each page of a scan takes one (W209, F3). Left out, no limit. */
  reads?: ReadLimit | undefined;
  /** How long a scan may run before it stops paging, in ms. Default CONVERSATION_SCAN_MS. */
  scanMs?: number | undefined;
}

export function registerSpinOffs(app: Hono, sources: SpinOffRouteSources): void {
  const answer = (c: Context, result: SpinOffCheck, status: 200 | 400 | 404 | 409 | 413 | 415 | 429 | 503) => {
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

  let scans = 0;
  app.post(
    CONVERSATION_SPIN_OFF_ROUTE,
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
        return answer(c, { ok: false, error: 'The body must be { key }, the block’s key.' }, 400);
      }
      const read = sources.conversation;
      if (read === undefined) return answer(c, { ok: false, error: 'pitwall can’t read this conversation.' }, 404);
      if (scans >= CONVERSATION_SCANS_MAX) {
        c.header('Retry-After', '1');
        return answer(c, { ok: false, error: 'pitwall is checking other blocks. Try again in a moment.' }, 429);
      }
      scans += 1;
      let proposal: SpinOff | undefined;
      try {
        const found = await findBlock(read, lookup.session.sessionId, body.key, sources.reads, Date.now() + (sources.scanMs ?? CONVERSATION_SCAN_MS));
        if (found === 'busy') {
          c.header('Retry-After', '1');
          return answer(c, { ok: false, error: 'pitwall is reading other conversations. Try again in a moment.' }, 429);
        }
        if (found === 'late') return answer(c, { ok: false, error: 'pitwall took too long reading the conversation to check the block. Try again.' }, 503);
        proposal = found;
      } catch {
        return answer(c, { ok: false, error: 'pitwall couldn’t read the conversation to check the block. Try again.' }, 409);
      } finally {
        scans -= 1;
      }
      if (proposal === undefined) return answer(c, { ok: false, error: 'That block isn’t in the session’s recent messages now. Reload the conversation and read it again.' }, 409);
      if (proposal.kind !== 'proposal') return answer(c, { ok: false, error: proposal.problem }, 409);
      const input = { directory: proposal.folder, prompt: proposal.prompt, ...(proposal.name === undefined ? {} : { name: proposal.name }) };
      const checked = await checkSpawn(input, sources.snapshots.latest());
      if (!checked.ok) return answer(c, { ok: false, error: checked.error }, 409);
      const { cwd, name, prompt } = checked.value.spawn;
      return answer(c, { ok: true, cwd, prompt, ...(name === undefined ? {} : { name }) }, 200);
    },
  );
}

/** The newest assistant message's block with `key`, found by reading the transcript's pages from its end. 'busy': the read limit is full. 'late': the deadline passed. */
async function findBlock(
  read: NonNullable<SpinOffRouteSources['conversation']>,
  sessionId: string,
  key: string,
  reads: ReadLimit | undefined,
  deadline: number,
): Promise<SpinOff | undefined | 'busy' | 'late'> {
  let before: string | undefined;
  for (let pages = 0; pages < CONVERSATION_SCAN_PAGES; pages += 1) {
    if (Date.now() > deadline) return 'late';
    if (reads?.full() === true) return 'busy';
    reads?.take();
    let page;
    try {
      page = await read(sessionId, before);
    } finally {
      reads?.release();
    }
    if (page === undefined) return undefined;
    for (let index = page.entries.length - 1; index >= 0; index -= 1) {
      const entry = page.entries[index]!;
      if (entry.kind !== 'assistant') continue;
      const found = entry.spinOffs?.find((each) => each.spinOff.key === key);
      if (found !== undefined) return found.spinOff;
    }
    if (page.before === undefined) return undefined;
    before = page.before;
  }
  return undefined;
}
