// Clear and continue (W168, spike 014): a hand-off from a background job, carried on in the same job.
// pitwall types `/clear` into the job through its own `claude attach` PTY, waits until `claude agents
// --json` lists the job with a new session id, then types the hand-off's prompt as a bracketed paste, so
// a multi-line prompt arrives as one message. The job, its name and its PRs are kept. Nothing runs
// until you click Clear and continue on the card.
//
//   POST clearAndContinuePath(id)   body: { key } as JSON, the proposal the card showed
//                                   answers: ClearAndContinueResult
//     200  { ok: true, sessionId }: the job's new session id; the prompt was typed
//     400, 404, 503  from resolveSession(); 400 also when the body isn't { key }
//     409  it isn't a hand-off from a running background job now, the text isn't one pitwall types,
//          or the job changed under it (it vanished, started working, or stopped listing a worker)
//     413, 415  as the spin-off check's
//     429  another Clear and continue is running
//     502  claude couldn't be run, or `claude agents --json` failed
//     504  the PTY wasn't ready, or the job didn't list a new session id in time. The prompt was
//          not typed; `/clear` may have run
//   POST continuedPath(id)          body: { shortId }   answers: ContinuedResult
//     the page tells pitwall which session it just started from a hand-off card's Start, so the lineage
//     log gets a `continue` line (LineageStore.expectContinue()). Only a short id this pitwall started
//     a moment ago is taken.
//
// What is typed is the card's own prompt, from the snapshot, never the request's: refused when it
// starts with `/` or `!` (a slash command or a shell line in Claude Code's input), or has a control,
// zero-width, bidi or other invisible character (hiddenCharacter(), W163's rule, so the paste's own end
// marker, which starts with ESC, can't be in it), or is blank or over SPAWN_PROMPT_MAX. The PTY is this
// server's own, for the job clicked, one at a time, and killed afterwards on every path. It's never
// opened for a job that has no worker (attaching would restart it) or is working or blocked (the input
// would go to a turn or a dialog, not the prompt), and the typing stops, without the prompt, at the
// first thing that isn't as expected.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AgentRow, AgentsSource } from '../index/agents.js';
import { isRecord } from '../index/guards.js';
import { isOwnHandoff, typedPromptProblem } from '../shared/handoff.js';
import {
  clearAndContinuePath,
  continuedPath,
  type ClearAndContinueResult,
  type ContinuedResult,
  type IndexSnapshot,
  type SessionSummary,
  type SpinOff,
} from '../shared/protocol.js';
import { childEnvironment } from './command.js';
import { LOOKUP_ERRORS } from './actions.js';
import type { LineageStore } from './lineage.js';
import type { PtyProcess, PtySpawner } from './pty.js';
import type { RecentSpawns } from './recentSpawns.js';
import { resolveSession } from './sessions.js';

/** Waits and limits, in milliseconds. The defaults are spike 014's measurements, with room. */
export interface ClearTimings {
  /** Attach output must have been quiet this long before anything is typed (spike 014: 0.75 s). */
  quietMs: number;
  /** The most to wait for that. */
  readyMaxMs: number;
  /** Between typing `/clear` and Enter, and between the paste and Enter (spike 014: 300 ms). */
  enterGapMs: number;
  /** The most to wait for the new session id (spike 014: 1.6 s). */
  clearMaxMs: number;
  /** Between two reads of `claude agents --json`. */
  pollMs: number;
  /** Between the new session id and the paste (spike 014: 500 ms). */
  settleMs: number;
  /** After Enter, before the PTY is closed, so the prompt has gone in. */
  afterPromptMs: number;
}

export const CLEAR_TIMINGS: ClearTimings = {
  quietMs: 1000,
  readyMaxMs: 15_000,
  enterGapMs: 300,
  clearMaxMs: 30_000,
  pollMs: 250,
  settleMs: 500,
  afterPromptMs: 1500,
};

/** Terminal sizes for the PTY: the attach socket's own range, a plain size. */
const COLS = 120;
const ROWS = 40;
/** How long the PTY has to exit after SIGHUP before it gets SIGKILL, as attach.ts has it. */
const KILL_GRACE_MS = 3000;
/** A short id `claude attach` can take as one argument. */
const SAFE_SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Bracketed paste on: the terminal program asks for it with this escape sequence. */
const BRACKETED_PASTE_ON = '\u001b[?2004h';
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/** The job a Clear and continue is for, from the snapshot's summary of the session that proposed it. */
export interface ClearJob {
  sessionId: string;
  shortId: string;
  cwd: string;
}

export type ClearOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; status: 409 | 429 | 502 | 504; error: string; typed?: true };

export interface ClearAndContinueOptions {
  spawnPty: PtySpawner;
  claudeBin?: string;
  env?: NodeJS.ProcessEnv;
  /** The server's token, which childEnvironment() scrubs out of the PTY's environment. */
  token: string;
  /** `claude agents --json --all`, as attach.ts re-reads it. */
  agents: Pick<AgentsSource, 'list'>;
  /** Where the clear is recorded (W167): the same store the listing's diff writes. */
  lineage?: Pick<LineageStore, 'record'>;
  timings?: Partial<ClearTimings>;
  /** Tests pass a fake clock and sleep. Defaults: Date.now and setTimeout. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ClearAndContinue {
  run(job: ClearJob, prompt: string): Promise<ClearOutcome>;
  /** Server shutdown: a run in flight types nothing further and kills its PTY; later runs are refused. */
  close(): Promise<void>;
}

export { typedPromptProblem };

export function createClearAndContinue(options: ClearAndContinueOptions): ClearAndContinue {
  const timings: ClearTimings = { ...CLEAR_TIMINGS, ...options.timings };
  const claudeBin = options.claudeBin ?? 'claude';
  const now = options.now ?? Date.now;
  const baseSleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** A sleep that ends early on close() and then stops the run. */
  const sleep = async (ms: number): Promise<void> => {
    if (aborted) throw new Aborted(ABORTED);
    await Promise.race([baseSleep(ms), new Promise<void>((resolve) => (wake = resolve))]);
    if (aborted) throw new Aborted(ABORTED);
  };
  // One at a time, server-wide: each holds a PTY and a job's input.
  let running = false;
  // Server shutdown (F4): set by close(), which also wakes any sleep and kills the PTY of a run in flight.
  let aborted = false;
  let wake: (() => void) | undefined;
  let killNow: (() => void) | undefined;
  let current: Promise<unknown> | undefined;
  const ABORTED = 'pitwall is closing, so Clear and continue stopped.';
  class Aborted extends Error {}

  const fail = (status: 409 | 429 | 502 | 504, error: string, typed?: true): ClearOutcome => ({ ok: false, status, error, ...(typed === true ? { typed } : {}) });

  /** The job's row in a fresh listing, or why not. */
  const readRow = async (job: ClearJob): Promise<{ row: AgentRow } | { gone: true } | { error: string }> => {
    const listing = await options.agents.list();
    if (!listing.ok) return { error: 'pitwall couldn’t read claude agents --json.' };
    const rows = listing.rows.filter((row) => row.kind === 'background' && row.shortId === job.shortId);
    return rows.length === 1 ? { row: rows[0]! } : { gone: true };
  };

  /**
   * The job's row if it is still the idle job pitwall means to type into: the single background row
   * with this short id, the expected session id, a worker, and exactly state done with status idle
   * (an allowlist: a missing or unknown state, a turn, a dialog and a failed job all refuse). `typed`
   * says in the error what has gone in so far.
   */
  const idleRow = async (job: ClearJob, sessionId: string, typed: string, before: boolean): Promise<{ row: AgentRow } | { outcome: ClearOutcome }> => {
    const read = await readRow(job);
    const hasTyped = typed !== 'Nothing was typed.';
    const refuse = (why: string): { outcome: ClearOutcome } => ({ outcome: fail(409, `${why} ${typed}`, hasTyped ? true : undefined) });
    if ('error' in read) return { outcome: fail(502, `${read.error} ${typed}`, hasTyped ? true : undefined) };
    if ('gone' in read) return refuse('The job isn’t listed any more.');
    const row = read.row;
    if (row.sessionId !== sessionId) return refuse(before ? 'That job has moved on to another session since the card was drawn. Read its new state first.' : 'The job’s session id isn’t the one pitwall expected.');
    if (row.pid === undefined) return refuse('The job has no running process, and attaching to it would restart it.');
    if (row.state !== 'done' || row.status !== 'idle') {
      const what = row.state === 'working' ? 'still working' : row.state === 'blocked' ? 'waiting for you' : `not idle (${row.state ?? 'no state'}, ${row.status ?? 'no status'})`;
      return refuse(`The job is ${what}, so pitwall stopped before the next keystroke.`);
    }
    return { row };
  };

  const run = async (job: ClearJob, prompt: string): Promise<ClearOutcome> => {
    const problem = typedPromptProblem(prompt);
    if (problem !== undefined) return fail(409, problem);
    if (!SAFE_SHORT_ID.test(job.shortId)) return fail(409, 'This session has no id that claude attach can use.');
    if (aborted) return fail(409, ABORTED);
    if (running) return fail(429, 'Another Clear and continue is running. Try again in a moment.');
    running = true;
    let pty: PtyProcess | undefined;
    let exited = false;
    let killTimer: NodeJS.Timeout | undefined;
    try {
      // 1. The job as it is now: a worker, and not in a turn or waiting on a dialog.
      const NOTHING = 'Nothing was typed.';
      const first = await idleRow(job, job.sessionId, NOTHING, true);
      if ('outcome' in first) return first.outcome;
      const before = first.row;

      // 2. The server's own PTY, for this job only.
      let lastData = now();
      let seen = false;
      let tail = '';
      let bracketed = false;
      try {
        const cwd = existsSync(before.cwd) ? before.cwd : homedir();
        pty = options.spawnPty(claudeBin, ['attach', job.shortId], {
          cols: COLS,
          rows: ROWS,
          cwd,
          env: { ...childEnvironment(options.env ?? process.env, options.token), FORCE_HYPERLINK: '1' },
          name: 'xterm-256color',
        });
      } catch (error) {
        return fail(502, `Couldn't start claude attach: ${(error as Error).message}`);
      }
      const started = pty;
      killNow = () => {
        try {
          started.kill();
        } catch {
          // Already gone.
        }
      };
      started.onData((data) => {
        seen = true;
        lastData = now();
        const joined = tail + data;
        if (joined.includes(BRACKETED_PASTE_ON)) bracketed = true;
        tail = joined.slice(-BRACKETED_PASTE_ON.length);
      });
      started.onExit(() => {
        exited = true;
      });

      // 3. Ready to type: the output has been quiet, and the job's input takes a bracketed paste.
      const readyBy = now() + timings.readyMaxMs;
      while (!(seen && now() - lastData >= timings.quietMs)) {
        if (exited) return fail(409, '`claude attach` ended before pitwall could type. Nothing was typed.');
        if (now() >= readyBy) return fail(504, 'The job didn’t settle in time for pitwall to type into it. Nothing was typed.');
        await sleep(timings.pollMs);
      }
      if (exited) return fail(409, '`claude attach` ended before pitwall could type. Nothing was typed.');
      if (!bracketed) return fail(409, 'The job’s terminal didn’t turn on bracketed paste, so pitwall can’t type a multi-line prompt as one message. Nothing was typed.');

      // 4. /clear, then Enter as its own write. The job is read again before each keystroke group, so a
      // job that turned to a dialog meanwhile gets no Enter (a dialog's default is Yes).
      const beforeClear = await idleRow(job, job.sessionId, NOTHING, true);
      if ('outcome' in beforeClear) return beforeClear.outcome;
      started.write('/clear');
      await sleep(timings.enterGapMs);
      const beforeEnter = await idleRow(job, job.sessionId, '“/clear” was typed but not run: check the job’s input box.', false);
      if ('outcome' in beforeEnter) return beforeEnter.outcome;
      started.write('\r');

      // 5. Wait for the same job to list a new session id, with a worker.
      const clearBy = now() + timings.clearMaxMs;
      let after: AgentRow | undefined;
      let misses = 0;
      while (after === undefined) {
        if (exited) return fail(409, '`claude attach` ended after /clear was typed, so the prompt was not typed. Check the job.');
        if (now() >= clearBy) return fail(504, 'The job didn’t list a new session id in time, so the prompt was not typed. /clear may or may not have run: check the job.');
        await sleep(timings.pollMs);
        const next = await readRow(job);
        if ('error' in next) continue;
        if ('gone' in next) {
          // Two listings in a row, so one odd read doesn't end it.
          misses += 1;
          if (misses >= 2) return fail(409, 'The job disappeared from the list after /clear, so the prompt was not typed.');
          continue;
        }
        misses = 0;
        // Taken only when idle too: a new id on a job that is working or waiting is read again, not typed into.
        if (next.row.sessionId !== job.sessionId && next.row.pid !== undefined && next.row.state === 'done' && next.row.status === 'idle') after = next.row;
      }

      // 6. The prompt, bracketed, then Enter.
      await sleep(timings.settleMs);
      if (exited) return fail(409, '`claude attach` ended after /clear, so the prompt was not typed. The job has a new session; check it.');
      const newId = after.sessionId;
      const beforePaste = await idleRow(job, newId, '/clear ran; the prompt was not typed.', false);
      if ('outcome' in beforePaste) return beforePaste.outcome;
      started.write(`${PASTE_START}${prompt}${PASTE_END}`);
      await sleep(timings.enterGapMs);
      const beforePromptEnter = await idleRow(job, newId, 'The prompt was pasted but not sent: check the job’s input box.', false);
      if ('outcome' in beforePromptEnter) return beforePromptEnter.outcome;
      started.write('\r');
      await sleep(timings.afterPromptMs);

      // The listing already gave both ids; the live diff may have recorded the clear first, and then this adds nothing.
      options.lineage?.record({ from: job.sessionId, to: after.sessionId, how: 'clear', job: job.shortId, cwd: after.cwd });
      return { ok: true, sessionId: after.sessionId };
    } catch (error) {
      if (error instanceof Aborted) return fail(409, error.message);
      return fail(502, `Clear and continue stopped: ${(error as Error).message}`);
    } finally {
      // Closed on every path: SIGHUP detaches (the job keeps running, spike 014), SIGKILL if it lingers.
      if (pty !== undefined && !exited) {
        const closing = pty;
        try {
          closing.kill();
        } catch {
          // Already gone.
        }
        killTimer = setTimeout(() => {
          try {
            closing.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }, KILL_GRACE_MS);
        killTimer.unref();
        closing.onExit(() => clearTimeout(killTimer));
      }
      running = false;
      killNow = undefined;
    }
  };

  return {
    run: (job, prompt) => {
      const promise = run(job, prompt);
      current = promise;
      return promise;
    },
    async close() {
      aborted = true;
      wake?.();
      killNow?.();
      await current?.catch(() => undefined);
    },
  };
}

// --- The routes ------------------------------------------------------------------------------------

/** The most a request's body can be: `{ "key": "<16 hex>" }` or `{ "shortId": "<id>" }` with room to spare. */
export const CLEAR_BODY_MAX_BYTES = 256;

const KEY = /^[0-9a-f]{16}$/;
const JOB_ID = /^[0-9a-f]{8}$/;

const CLEAR_ROUTE = decodeURIComponent(clearAndContinuePath(':sessionId'));
const CONTINUED_ROUTE = decodeURIComponent(continuedPath(':sessionId'));

export interface ClearRouteSources {
  snapshots: { latest(): IndexSnapshot | undefined };
  runner: ClearAndContinue;
  /** The short ids this pitwall started a moment ago (actions.ts). */
  spawned?: Pick<RecentSpawns, 'has'>;
  lineage?: Pick<LineageStore, 'expectContinue'>;
  /**
   * W210: the session's hand-off from its recap, worked out again now from the recap and the transcript's
   * newest assistant message (RecapEngine.handoffOf()). A proposal with source 'recap' is typed only
   * when this gives the same key and prompt, so a message that has changed since the snapshot was
   * drawn is refused. Without it, no recap-sourced proposal is typed.
   */
  recapHandoff?: (session: SessionSummary) => SpinOff | undefined;
}

export function registerClearAndContinue(app: Hono, sources: ClearRouteSources): void {
  const clearAnswer = (c: Context, result: ClearAndContinueResult, status: 200 | 400 | 404 | 409 | 413 | 415 | 429 | 502 | 503 | 504) => {
    c.header('Cache-Control', 'no-store');
    return c.json(result, status);
  };
  const continuedAnswer = (c: Context, result: ContinuedResult, status: 200 | 400 | 404 | 409 | 413 | 415 | 503) => {
    c.header('Cache-Control', 'no-store');
    return c.json(result, status);
  };
  const tooLarge = { onError: (c: Context) => c.json({ ok: false, error: 'The request is too large.' }, 413) };

  /** The JSON body as a record with exactly `field`, or why not. */
  const readBody = async (c: Context, field: string): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string; status: 400 | 415 }> => {
    const type = c.req.header('content-type') ?? '';
    if (!/^application\/json\s*(;|$)/i.test(type)) return { ok: false, error: 'Send the request as application/json.', status: 415 };
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return { ok: false, error: "The body isn't valid JSON.", status: 400 };
    }
    if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body[field] !== 'string') return { ok: false, error: `The body must be { ${field} }.`, status: 400 };
    return { ok: true, value: body };
  };

  app.post(CLEAR_ROUTE, bodyLimit({ maxSize: CLEAR_BODY_MAX_BYTES, onError: (c) => clearAnswer(c, { ok: false, error: 'The request is too large.' }, 413) }), async (c) => {
    const lookup = resolveSession(sources.snapshots, c.req.param('sessionId'));
    if (!lookup.ok) return clearAnswer(c, { ok: false, error: LOOKUP_ERRORS[lookup.status] }, lookup.status);
    const body = await readBody(c, 'key');
    if (!body.ok) return clearAnswer(c, { ok: false, error: body.error }, body.status);
    const key = body.value.key as string;
    if (!KEY.test(key)) return clearAnswer(c, { ok: false, error: 'The body must be { key }, the proposal’s key.' }, 400);
    const { session } = lookup;
    const proposal = session.spinOff;
    if (proposal === undefined) return clearAnswer(c, { ok: false, error: 'That session doesn’t propose a new session now.' }, 409);
    if (proposal.key !== key) return clearAnswer(c, { ok: false, error: 'That session has proposed something else since. Read its new proposal first.' }, 409);
    if (proposal.kind !== 'proposal') return clearAnswer(c, { ok: false, error: proposal.problem }, 409);
    // From the resolved summary, never the route parameter.
    if (session.kind !== 'background' || session.shortId === undefined || session.ended === true || session.stale) {
      return clearAnswer(c, { ok: false, error: 'Clear and continue is for a running background session. Start a new session instead.' }, 409);
    }
    if (!isOwnHandoff(session.sessionId, proposal)) {
      return clearAnswer(c, { ok: false, error: 'That proposal isn’t a hand-off from this session: its prompt doesn’t start with “Continues session” and this session’s id.' }, 409);
    }
    // A hand-off from the recap (W210) is worked out again, now, from the transcript: the text typed is the
    // server's own, word for word in the session's newest message as it is this moment, never the request's.
    if (proposal.source === 'recap') {
      const current = sources.recapHandoff?.(session);
      if (current?.kind !== 'proposal' || current.key !== proposal.key || current.prompt !== proposal.prompt) {
        return clearAnswer(c, { ok: false, error: 'That session’s newest message has changed since the card was drawn. Read its new state first.' }, 409);
      }
    }
    const outcome = await sources.runner.run({ sessionId: session.sessionId, shortId: session.shortId, cwd: session.cwd }, proposal.prompt);
    if (outcome.ok) return clearAnswer(c, { ok: true, sessionId: outcome.sessionId }, 200);
    return clearAnswer(c, { ok: false, error: outcome.error, ...(outcome.typed === true ? { typed: true as const } : {}) }, outcome.status);
  });

  app.post(CONTINUED_ROUTE, bodyLimit({ maxSize: CLEAR_BODY_MAX_BYTES, ...tooLarge }), async (c) => {
    const lookup = resolveSession(sources.snapshots, c.req.param('sessionId'));
    if (!lookup.ok) return continuedAnswer(c, { ok: false, error: LOOKUP_ERRORS[lookup.status] }, lookup.status);
    const body = await readBody(c, 'shortId');
    if (!body.ok) return continuedAnswer(c, { ok: false, error: body.error }, body.status);
    const shortId = body.value.shortId as string;
    if (!JOB_ID.test(shortId)) return continuedAnswer(c, { ok: false, error: 'The body must be { shortId }, a job’s short id.' }, 400);
    // Only for a session that proposes its own hand-off now, so the link can't name just any session.
    const proposed = lookup.session.spinOff;
    if (!isOwnHandoff(lookup.session.sessionId, proposed)) {
      return continuedAnswer(c, { ok: false, error: 'That session doesn’t propose a hand-off now, so pitwall won’t link a session to it.' }, 409);
    }
    // Only a session this pitwall started a moment ago, so the page can't link two sessions that merely exist.
    if (sources.spawned?.has(shortId) !== true || sources.lineage === undefined) {
      return continuedAnswer(c, { ok: false, error: 'pitwall didn’t start that session a moment ago, so it won’t link it.' }, 409);
    }
    if (!sources.lineage.expectContinue(shortId, lookup.session.sessionId)) {
      return continuedAnswer(c, { ok: false, error: 'pitwall couldn’t note that link.' }, 409);
    }
    return continuedAnswer(c, { ok: true }, 200);
  });
}
