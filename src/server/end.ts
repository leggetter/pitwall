// End session for a running interactive session (W90; spike 005; Phil, 2026-10-28; D22): pitwall sends
// its Claude Code process SIGTERM, and its terminal goes back to the shell. Spike 005 measured it: the
// process exits in 0.6 to 1.8 s with code 143, its SessionEnd hooks run, its MCP servers, background
// commands and sub-agents end with it, its transcript stays whole, and `claude --resume` brings it back.
// A reply being written is lost, and running commands are killed, not moved to the background.
//
// SIGTERM, never SIGKILL, and nothing after it: SIGKILL skips the hooks and git's lock-file clean-up,
// and spike 005 recommends no escalation. Not SIGINT, which exits 0, so a shell can't tell it from
// /exit, nor SIGHUP, which says the terminal hung up when it hasn't.
//
// The route comes after the /api/* checks in server.ts: Host, this server's Origin and the apiKey. Then:
//
//   POST endSessionPath(id)       body: EndSessionRequest as JSON      answers: EndSessionResult
//     200  signalled: { ok: true, ended }, `ended` saying whether its process exited within
//          END_SESSION_WAIT_MS
//     400  not `Content-Type: application/json`, not JSON, over 1 KiB, or anything but {} or
//          { whileWorking: true }. Then, from resolveSession(): not a safe id
//     404, 503  from resolveSession(): not listed, no snapshot yet
//     409  nothing signalled, because one of the guards below refused, each with its reason
//     429  4 stop, remove, resume, open and end commands are already running (CommandSlots), or, counted
//          after every guard, just before the signal, DEFAULT_END_RATE's 5 ends in the last minute.
//          Retry-After is set
//     502  `claude agents` or ps failed, so pitwall couldn't check it, or the signal was refused
//
// The guards, in order. Every one must pass, or nothing is signalled:
//
//   1. The snapshot lists it as an interactive session that is running, with a pid, and not ended,
//      and its id is a UUID, as resume's is. No end of it is running already.
//   2. ps says its pid is a `claude` process (processes.ts), read before the listing below.
//   3. A fresh `claude agents --json --all` lists its session id as interactive, running, with the
//      snapshot's pid. No other row names that pid, and no row names another pid for the session, by
//      every row it printed, those parseAgentRows() skipped or merged included (pidOwners(),
//      sessionPids()). It isn't a relay: this pitwall's (relay.ts' isRelay), or any session named
//      RELAY_NAME, as another pitwall's relay is, in the snapshot or the listing. Nor the supervisor
//      (M5, W113): this pitwall's (Supervisor.isOwn()), or any interactive session named
//      SUPERVISOR_NAME, as another pitwall's is.
//   4. The process started no later than the session did, by the listing's startedAt: ps's `lstart`
//      is whole seconds, rounded down, so it's never later than the real start, and Claude Code
//      writes startedAt after its process has started, so the session's own process always passes.
//      One that started later isn't the session's: a later process that took a dead session's pid.
//      W90's live checks saw startedAt 0.5 to 1.7 s after `lstart`, for a resumed session too.
//   5. Without `whileWorking`: its turn has ended, by its transcript's newest entries afresh (W69's
//      rule; Indexer.turnState()), no prompt is on screen, and none of its sub-agents is running, by
//      a scan that starts now (Indexer.runningSubagents()). Otherwise 409 with `working`, for the
//      page's stronger warning, and the page sends again with `whileWorking` once you confirm it. A
//      transcript, or sub-agents, that can't be read count as working.
//   6. It's neither pitwall's own process, nor one pitwall runs under (Phil's dev pitwall once ran
//      under the coordinator's session), nor one pitwall started, as its relay, by ps's parent pids.
//   7. Just before the signal, ps says the pid is still the process from 2: the same start time and
//      the same `claude` command. Between 2 and 7 the process existed throughout, and the listing in 3,
//      made in between, named it, so a pid reused since can't be hit. Nothing that waits comes between
//      7 and the signal.
//
// The pid is always the listing's, never anything the request names: the body has no pid.
//
// After the signal it waits up to END_SESSION_WAIT_MS by the clock, not by a count of lookups: each
// ps gets only the time left, and is abandoned when that runs out, so a ps that hangs can't hold
// the request, its command slot or the session's lock past the wait.
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createAgentsSource, pidOwners, sessionPids, type AgentRow, type AgentsSource } from '../index/agents.js';
import type { Indexer } from '../index/index.js';
import { isSessionUuid } from '../index/transcripts.js';
import { END_SESSION_WAIT_MS, endSessionPath, type EndSessionResult, type EndSessionWorking } from '../shared/protocol.js';
import { CommandSlots, LOOKUP_ERRORS, RateWindow } from './actions.js';
import { ancestry, createProcesses, isClaudeCommand, type ProcessInfo, type ProcessLookup, type Processes } from './processes.js';
import { nameKey, RELAY_NAME } from './relayPrompt.js';
import { SUPERVISOR_NAME } from '../supervisor/prompt.js';
import { resolveSession } from './sessions.js';

/** The signal End session sends, and the only one (spike 005). */
export const END_SIGNAL = 'SIGTERM';

/**
 * The most ends in any minute, of any sessions (W90). A person ends a few at most; a page that's gone
 * wrong, or anything else holding the apiKey, can't end every session on the machine in a burst.
 */
export const DEFAULT_END_RATE = { max: 5, windowMs: 60_000 } as const;

/** How often the process is looked up, while waiting for it to exit. */
export const END_POLL_MS = 100;

/** The largest body accepted. `{"whileWorking":true}` is 21 bytes. */
export const MAX_END_BODY_BYTES = 1024;

/** Sends a signal to a pid, as process.kill does: throws with `code` ESRCH or EPERM. */
export type Signaller = (pid: number, signal: typeof END_SIGNAL) => void;

export interface EndOptions {
  /** The fresh `claude agents --json --all`. Default createAgentsSource(). Tests pass a fake. */
  agents?: Pick<AgentsSource, 'list'>;
  /** Path or name of the claude binary, for the default agents source. Default 'claude'. */
  claudeBin?: string;
  /** The ps lookups. Default createProcesses(). Tests pass a fake, so nothing depends on this machine. */
  processes?: Processes;
  /** Default process.kill. Tests pass a fake, so no test signals a process (src/test/noClaude.ts refuses one). */
  signal?: Signaller;
  /** True for a `claude agents` row that is pitwall's own relay (RelayManager.isRelay), or one of its recap calls (RecapEngine.isOwn). Default none. */
  isRelay?: (row: AgentRow) => boolean;
  /** True for a `claude agents` row that is pitwall's supervisor (Supervisor.isOwn()). Default none. */
  isSupervisor?: (row: AgentRow) => boolean;
  /** pitwall's own pid. Default process.pid. */
  selfPid?: number;
  /** The slots shared with stop, remove, resume and open (actions.ts). The server passes its own. Default: new ones. */
  slots?: CommandSlots;
  /** Ends allowed per window. Default DEFAULT_END_RATE, 5 a minute. */
  endRate?: { max: number; windowMs: number };
  /** Milliseconds since the epoch, for the rate limit and the wait's deadline. Default Date.now. */
  now?: () => number;
  /** How long to wait for the process to exit. Default END_SESSION_WAIT_MS. */
  waitMs?: number;
  /** How often to look while waiting. Default END_POLL_MS. */
  pollMs?: number;
  /** The pause between lookups while waiting. Default a timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** True for a session named as a pitwall relay is, this pitwall's or another's (RELAY_NAME). */
export function isRelayName(name: string): boolean {
  return nameKey(name.trim()) === nameKey(RELAY_NAME);
}

/** True for a session named as a pitwall supervisor is, this pitwall's or another's (SUPERVISOR_NAME). */
export function isSupervisorName(name: string): boolean {
  return nameKey(name.trim()) === nameKey(SUPERVISOR_NAME);
}

/** The request, when it's `{}` or `{ whileWorking: true }`. */
export function parseEndRequest(body: unknown): { ok: true; whileWorking: boolean } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'The body must be a JSON object.' };
  const keys = Object.keys(body);
  if (keys.length === 0) return { ok: true, whileWorking: false };
  if (keys.length === 1 && keys[0] === 'whileWorking' && (body as { whileWorking: unknown }).whileWorking === true) return { ok: true, whileWorking: true };
  return { ok: false, error: 'The body must be {} or { "whileWorking": true }.' };
}

/** Why a working session wasn't ended, in a sentence, from what's running. */
export function workingError(working: EndSessionWorking): string {
  const parts: string[] = [];
  if (working.turn === 'running') parts.push('its turn is still running');
  if (working.turn === 'unknown') parts.push("pitwall can't tell from its transcript whether its turn has ended");
  if (working.subagents === 'unknown') parts.push("pitwall can't tell whether its sub-agents are running");
  else if (working.subagents !== undefined) parts.push(`${working.subagents} ${working.subagents === 1 ? 'sub-agent is' : 'sub-agents are'} running`);
  return `pitwall didn't end it: ${parts.join(', and ')}. Ending it now loses a reply being written and stops what it's running.`;
}

/** True when `later` is the same process as `first`: the same start time, and still `claude`. */
function sameProcess(first: ProcessInfo, later: ProcessInfo | undefined): boolean {
  return later !== undefined && later.startedAtMs === first.startedAtMs && later.command === first.command && isClaudeCommand(later.command);
}

const END_ROUTE = decodeURIComponent(endSessionPath(':sessionId'));

const defaultSignal: Signaller = (pid, signal) => {
  process.kill(pid, signal);
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** A lookup, or undefined once `ms` have passed without its answer, by a real timer, whatever the ps does. */
function within(lookup: Promise<ProcessLookup>, ms: number): Promise<ProcessLookup | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([lookup, cap]).finally(() => clearTimeout(timer));
}

/**
 * Adds POST endSessionPath(). Call it after the /api/* checks and before the /api/* catch-all, as
 * ServerInternals.routes does.
 */
export function registerEndSession(
  app: Hono,
  indexer: Pick<Indexer, 'latest' | 'pollSoon' | 'runningSubagents' | 'turnState'>,
  options: EndOptions = {},
): void {
  const agents = options.agents ?? createAgentsSource({ claudeBin: options.claudeBin ?? 'claude' });
  const processes = options.processes ?? createProcesses();
  const signal = options.signal ?? defaultSignal;
  const isRelay = options.isRelay ?? (() => false);
  const isSupervisor = options.isSupervisor ?? (() => false);
  const selfPid = options.selfPid ?? process.pid;
  const slots = options.slots ?? new CommandSlots();
  const endRate = options.endRate ?? DEFAULT_END_RATE;
  const now = options.now ?? Date.now;
  const ends = new RateWindow(endRate, now);
  const waitMs = options.waitMs ?? END_SESSION_WAIT_MS;
  const pollMs = options.pollMs ?? END_POLL_MS;
  const sleep = options.sleep ?? defaultSleep;
  // Session ids being ended now: a second end of one waits for the first's answer.
  const ending = new Set<string>();

  const answer = (c: Context, result: EndSessionResult, status: 200 | 400 | 404 | 409 | 429 | 502 | 503) => {
    c.header('Cache-Control', 'no-store');
    return c.json(result, status);
  };
  const refuse = (c: Context, error: string, status: 400 | 404 | 409 | 502 | 503) => answer(c, { ok: false, error }, status);

  /**
   * Whether the process from `first` has gone, or `pid` is another process now, before waitMs have
   * passed by the clock. Each lookup gets the time left, and is abandoned when that runs out.
   */
  async function exited(pid: number, first: ProcessInfo): Promise<boolean> {
    const deadline = now() + waitMs;
    for (;;) {
      if (deadline - now() <= 0) return false;
      await sleep(Math.max(0, Math.min(pollMs, deadline - now())));
      const left = deadline - now();
      if (left <= 0) return false;
      const found = await within(processes.lookup(pid, left), left);
      if (found?.ok && !sameProcess(first, found.process)) return true;
    }
  }

  app.post(
    END_ROUTE,
    bodyLimit({ maxSize: MAX_END_BODY_BYTES, onError: (c) => refuse(c, 'The request is too large.', 400) }),
    async (c) => {
      if (!/^application\/json\s*(;|$)/i.test(c.req.header('content-type') ?? '')) return refuse(c, 'Send the request as application/json.', 400);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return refuse(c, "The body isn't valid JSON.", 400);
      }
      const request = parseEndRequest(body);
      if (!request.ok) return refuse(c, request.error, 400);

      const lookup = resolveSession(indexer, c.req.param('sessionId'));
      if (!lookup.ok) return refuse(c, LOOKUP_ERRORS[lookup.status], lookup.status);
      // 1. From the resolved summary, never the route parameter.
      const { session } = lookup;
      const { sessionId } = session;
      if (session.kind !== 'interactive' || session.ended === true) {
        return refuse(c, 'Only a running interactive session can be ended from pitwall. Stop a background session instead.', 409);
      }
      const pid = session.pid;
      if (!session.alive || pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return refuse(c, "It isn't running, so there's nothing to end.", 409);
      if (!isSessionUuid(sessionId)) return refuse(c, "Its session id isn't one pitwall can act on.", 409);
      if (isRelayName(session.name)) return refuse(c, "That's a pitwall relay, which pitwall never ends.", 409);
      if (isSupervisorName(session.name)) return refuse(c, "That's a pitwall supervisor, which pitwall never ends.", 409);
      if (ending.has(sessionId)) return refuse(c, 'pitwall is already ending this session.', 409);

      const release = slots.acquire();
      if (!release) {
        c.header('Retry-After', '1');
        return answer(c, { ok: false, error: slots.busyError }, 429);
      }
      ending.add(sessionId);
      try {
        // 2. The process at that pid now, before the listing, so 7 can tell it's the one the listing named.
        const first = await processes.lookup(pid);
        if (!first.ok) return refuse(c, `pitwall couldn't check its process, so it didn't end it: ${first.error}.`, 502);
        if (first.process === undefined) {
          indexer.pollSoon();
          return refuse(c, "Its process has already exited, so there's nothing to end.", 409);
        }
        const before = first.process;
        if (!isClaudeCommand(before.command)) {
          return refuse(c, "Its process isn't Claude Code's as far as pitwall can tell, so pitwall didn't signal it.", 409);
        }

        // 3. Afresh, as resume checks: the snapshot may be a poll old.
        const listing = await agents.list();
        if (!listing.ok) return refuse(c, `pitwall couldn't check that it's still running, so it didn't end it: ${listing.error}.`, 502);
        const row = listing.rows.find((each) => each.sessionId === sessionId);
        if (row === undefined || row.pid === undefined) {
          indexer.pollSoon();
          return refuse(c, "It isn't running any more, so there's nothing to end.", 409);
        }
        if (row.kind !== 'interactive') return refuse(c, "It's a background session now. Stop it instead.", 409);
        if (row.pid !== pid) {
          indexer.pollSoon();
          return refuse(c, "It's running in a different process from the one pitwall listed. Try again once the list updates.", 409);
        }
        // Every row claude agents printed, those parseAgentRows() skipped or merged included.
        const pids = sessionPids(listing, sessionId);
        if (pidOwners(listing, pid).some((owner) => owner !== sessionId) || pids.size !== 1 || !pids.has(pid)) {
          return refuse(c, "claude agents names that process for another row too, or another process for this session, so pitwall can't tell which is the session's. It didn't signal it.", 409);
        }
        if (isRelay(row)) return refuse(c, "That's pitwall's own relay, which pitwall never ends.", 409);
        if (isRelayName(row.name)) return refuse(c, "That's a pitwall relay, which pitwall never ends.", 409);
        if (isSupervisor(row)) return refuse(c, "That's pitwall's own supervisor, which pitwall never ends.", 409);
        if (isSupervisorName(row.name)) return refuse(c, "That's a pitwall supervisor, which pitwall never ends.", 409);

        // 4. A process that started after the session did isn't the session's: lstart is rounded down, and startedAt is written after the start.
        const sessionStart = Date.parse(row.startedAt);
        if (!Number.isFinite(sessionStart) || before.startedAtMs > sessionStart) {
          return refuse(
            c,
            `Its process started after the time claude agents gives for the session's start, as a process that took a dead session's pid would, so pitwall didn't signal it. If the session is still running in its terminal, type /exit there.`,
            409,
          );
        }

        // 5. Idle only, unless you confirmed the stronger warning.
        if (!request.whileWorking) {
          const working: EndSessionWorking = {};
          const turn = row.status === 'waiting' ? 'running' : await indexer.turnState(sessionId);
          if (turn !== 'ended') working.turn = turn;
          // Afresh, and undefined when the scan couldn't read them, which counts as working, as a transcript that can't say does.
          const running = await indexer.runningSubagents(sessionId);
          if (running === undefined) working.subagents = 'unknown';
          else if (running > 0) working.subagents = running;
          if (working.turn !== undefined || working.subagents !== undefined) {
            return answer(c, { ok: false, error: workingError(working), working }, 409);
          }
        }

        // 6. Never pitwall itself, what it runs under, or what it started.
        const tree = await processes.parents();
        if (!tree.ok) return refuse(c, `pitwall couldn't check that it isn't running under this session, so it didn't end it: ${tree.error}.`, 502);
        if (ancestry(selfPid, tree.parents).includes(pid)) {
          return refuse(c, 'pitwall itself is running under this session, so ending it would end pitwall too.', 409);
        }
        if (ancestry(pid, tree.parents).includes(selfPid)) return refuse(c, "It's a process pitwall started, which pitwall never ends.", 409);

        // 7. Still the same process, just before the signal.
        const last = await processes.lookup(pid);
        if (!last.ok) return refuse(c, `pitwall couldn't check its process again, so it didn't end it: ${last.error}.`, 502);
        if (!sameProcess(before, last.process)) {
          indexer.pollSoon();
          return refuse(c, "Its process changed while pitwall checked it, so pitwall didn't signal it.", 409);
        }
        // Counted only now, after every guard, as resume counts a start: a refused end doesn't count.
        const taken = ends.take();
        if (!taken.ok) {
          c.header('Retry-After', String(taken.retryAfterSeconds));
          const every = Math.round(endRate.windowMs / 1000);
          return answer(c, { ok: false, error: `pitwall ends at most ${endRate.max} ${endRate.max === 1 ? 'session' : 'sessions'} every ${every} seconds. Try again in ${taken.retryAfterSeconds}s.` }, 429);
        }

        try {
          signal(pid, END_SIGNAL);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          indexer.pollSoon();
          if (code === 'ESRCH') return refuse(c, "Its process exited before pitwall signalled it, so there's nothing to end.", 409);
          if (code === 'EPERM') return refuse(c, "pitwall isn't allowed to signal its process, which may run as another user.", 502);
          return refuse(c, "pitwall couldn't signal its process.", 502);
        }
        const ended = await exited(pid, before);
        // It leaves `claude agents` at once (spike 005, finding 5), and the index then lists it as ended.
        indexer.pollSoon();
        return answer(c, { ok: true, ended }, 200);
      } finally {
        release();
        ending.delete(sessionId);
      }
    },
  );
}
