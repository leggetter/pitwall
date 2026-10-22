// The relay (W11, D8): one headless Claude session that pitwall runs as its
// own child process, `claude -p` with stream-json on stdin and stdout, named
// pitwall-relay, on Haiku, with SendMessage as its only tool. It's the only
// way pitwall can message an interactive session (D2), because only a Claude
// session can call SendMessage. Spike 003 has the evidence for most rules
// below; the gate's are from the spike in the W11 review fixes (v2.1.303).
//
// The gate (relayGate.ts, relayGateHook.mjs): a PreToolUse hook in the
// relay's --settings allows a SendMessage call only when it's exactly the one
// pitwall expects, once. Anything else is denied before it runs, including a
// call another session talked the relay into. Each relay process gets its own
// gate id, and pitwall writes no request until the hook has marked the gate
// ready at the relay's SessionStart, so a relay whose hooks didn't load is
// never used.
//
// One request at a time:
//
//   1. check the name against the unfiltered `claude agents --json --all`:
//      exactly one live session has it, ignoring case, and it's the one asked
//      for. ListAgents doesn't show directories, so two sessions with one
//      name can't be told apart, and the request fails as ambiguous rather
//      than guess
//   2. start the relay if it isn't running, wait for its gate, and wait
//      until it's idle: a prompt written mid-turn can be drained into that
//      turn and ignored
//   3. check the name again, then write the expectation for the gate and the
//      framed request (relayPrompt.ts) to its stdin. A retry checks again too
//   4. check its SendMessage call against the request: one call, to the
//      target's name, with the text exactly. The gate has already decided;
//      this second check catches the gate letting through what it shouldn't
//   5. read the call's result: denied by the gate is failed, and nothing was
//      sent. `success: true` is delivered, once pitwall has checked the gate
//      consumed the expectation. A delivery notice with the same msg_id, read
//      from the relay's transcript within a short grace period, turns it into
//      held or refused
//
// The text is the request's with look-alike spaces made plain and CRLF as LF
// (relayText.ts plainSpaces(), W43), before the id is picked, the request is
// framed, the gate's expectation is written and the call is checked, so all
// four use the same text, and the gate still compares it exactly.
//
// A call for the request that differs from it only by a copying slip, in
// its text's whitespace or by leaving out invisible characters
// (relayPrompt.ts callMismatch()'s `slip`, relayText.ts isCopyingSlip()),
// which the gate denied, is tried once more (W43, W52): pitwall restarts the
// relay once its turn ends, as before, and sends the same text on the new
// one, with a new request id and expectation, while the HTTP request waits.
// Only then, and at most once per message: `denied` comes only from Claude
// Code's own tool result (parseSendResult()), which the relay's model can't
// write, so nothing was sent. Never after a call the gate didn't stop, one
// pitwall couldn't confirm, any other result, or any other difference: a call
// to another session, one that asks for idle notices or has a field pitwall
// doesn't check, or a text a slip doesn't explain, which a peer may have
// talked the relay into (W48's F3). If the second copy goes through, the
// result says the first was blocked. If it's blocked too, or the second try
// fails, the result is 'failed', and says where the copy first differed
// (relayText.ts describeCopyDifference()), never with the text.
//
// What pitwall can't confirm is 'uncertain', never 'failed': 'failed' means
// nothing was sent. A request that fails before anything was sent isn't
// recorded as the session's exchange, so it never replaces one that was.
//
// A SendMessage call nobody asked for raises the snapshot's relayAlert, with
// cause 'unrequested'. A call for one of your messages that didn't match it
// raises it with cause 'changed', unless it was a copying slip that the gate
// blocked or pitwall stopped before it ran: nothing was sent, and the
// message's own result says what changed. Any other call for one of your
// messages that the gate blocked or pitwall stopped raises it too, as
// blocked, and isn't tried again. A second call in the turn in which the gate
// blocked the call for one of your messages raises it with cause 'repeated'
// (W48's F8): it's the relay trying again, not another session. A call
// nobody asked for that the gate blocked leaves the relay sound, so it keeps
// running: restarting it for each one would let any session that can reach
// it use up the restart limit. A blocked call for one of pitwall's own
// requests that didn't match it restarts the relay once its turn ends,
// because its conversation may have been poisoned. A call that got past the
// gate when it shouldn't have stops pitwall using the relay until pitwall
// restarts. One for your message that matched it, but ran without the gate
// checking it, raises no alert: nothing unrequested or changed was sent, and
// the snapshot's relayOff says why messaging is off.
//
// The gate needs Claude Code 2.1.295 or later, for the hooks' `onFailure`,
// so pitwall checks `claude --version` before it first starts the relay.
//
// Replies and later notices arrive as peer messages. They start a turn on
// stdout but don't show their text there, so they're read from the relay's
// transcript (src/index/relayTranscript.ts). A reply is attached to a session
// only when the sender's verified pid is that session's pid.
//
// The relay starts on the first request, is restarted when it exits (with
// backoff, and at most `restart.max` starts in `restart.windowMs`), and is
// stopped by close(). It reads requests from a pipe, so when pitwall dies,
// even by SIGKILL, it sees end-of-file and exits. Pitwall only ever signals
// the process it started itself.
import { spawn as spawnProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentsSource, type AgentsSource } from '../index/agents.js';
import { runFile } from '../index/exec.js';
import { isRecord } from '../index/guards.js';
import {
  createRelayTranscriptTail,
  type NoticeOutcome,
  type RelayTranscriptEvent,
  type RelayTranscriptTail,
} from '../index/relayTranscript.js';
import { isSafeSessionId } from '../index/transcripts.js';
import type { RelayAlert, RelayExchange, RelayOff, RelayResult, RelayStatus } from '../shared/protocol.js';
import { childEnvironment } from './command.js';
import { ensureLaunchDir, pitwallHome } from './launch.js';
import { createRelayGate, RELAY_GATE_DIR_NAME, type RelayGate } from './relayGate.js';
import { DENIAL_PREFIX } from './relayGateHook.mjs';
import {
  callMismatch,
  findAnswer,
  frameRequest,
  isAddressable,
  nameKey,
  newRequestId,
  oneLine,
  parseSendResult,
  RELAY_NAME,
  relayArgs,
  userMessageLine,
  type CallMismatch,
  type SendResult,
} from './relayPrompt.js';
import { plainSpaces } from './relayText.js';

/** The session a message is for, from the resolved summary, never from the request. */
export interface RelayTarget {
  sessionId: string;
  name: string;
  pid: number;
  cwd: string;
}

/** A RelayResult, plus how long to wait when the relay was too busy to take the request. */
export interface RelaySendOutcome extends RelayResult {
  retryAfterSeconds?: number;
}

export interface RelayManager {
  /** Relays `text` to `target`, verbatim except for plainSpaces(). Never rejects. */
  send(target: RelayTarget, text: string): Promise<RelaySendOutcome>;
  /** The latest exchange with a session, for its summary in the snapshot. */
  exchange(sessionId: string): RelayExchange | undefined;
  /** The latest thing the relay tried that nobody asked for, for the snapshot. Undefined until the first. */
  alert(): RelayAlert | undefined;
  /** Why pitwall stopped using the relay for this run, for the snapshot. Undefined while it can be used. */
  off(): RelayOff | undefined;
  /** True for a `claude agents` row that is the relay itself, by pid, session id or directory. */
  isRelay(row: { sessionId: string; pid?: number | undefined; cwd: string }): boolean;
  /** Fails what's waiting and stops the relay. Resolves within about 2 seconds. */
  close(): Promise<void>;
}

/** What the manager needs from the relay's process. */
export interface RelayChild {
  readonly pid: number | undefined;
  /** Writes to its stdin. */
  write(data: string): void;
  /** Closes its stdin. The relay finishes its turn and exits. */
  end(): void;
  /** Signals it, unless it has already exited. */
  kill(signal: NodeJS.Signals): void;
}

/** What the process reports. `exit` is called once, after `error` when it couldn't start. */
export interface RelayChildEvents {
  line(line: string): void;
  stderr(text: string): void;
  error(message: string): void;
  exit(code: number | null, signal: NodeJS.Signals | null): void;
}

/** Starts the relay's process, without a shell. Tests pass a fake that speaks stream-json. */
export type RelaySpawner = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  events: RelayChildEvents,
) => RelayChild;

export interface RestartPolicy {
  /** The first wait after the relay stops soon after starting; it doubles each time. */
  baseMs: number;
  maxMs: number;
  /** At most this many starts in `windowMs`. */
  max: number;
  windowMs: number;
}

export interface RelayOptions {
  /** Default `$PITWALL_HOME/relay`, or `~/.pitwall/relay`. Created 0700, and nothing is written to it. */
  dir?: string;
  /** Default 'claude'. */
  claudeBin?: string;
  /** Default 'pitwall-relay'. The live test uses a `pitwall-test-*` name. */
  name?: string;
  model?: string;
  /** What the relay's environment is made from, before childEnvironment() scrubs it. Default process.env, read at each start. */
  env?: NodeJS.ProcessEnv;
  spawn?: RelaySpawner;
  /** The unfiltered session list. Default `claude agents --json --all`. */
  agents?: AgentsSource;
  /** What `claude --version` prints. Default: runs it. Rejects when it can't. */
  claudeVersion?: () => Promise<string>;
  /** Reads the relay's transcript. Default createRelayTranscriptTail. */
  transcript?: (options: { sessionId: string; cwd: string }) => RelayTranscriptTail;
  /** Creates the directory if needed, checks it's safe, and returns its realpath. Throws when it isn't safe. */
  prepareDir?: (dir: string) => string;
  /** The gate. Default: one in `relay-gate` next to `dir`. */
  gate?: RelayGate;
  /** How long a new relay has to mark its gate ready before pitwall stops it. Default 20 seconds. */
  gateReadyMs?: number;
  /** How often the ready marker is looked for. Default 50. */
  gatePollMs?: number;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Requests that can wait behind the one being relayed. Default 4. */
  maxQueue?: number;
  /** How long after a successful send to wait for a held or refused notice. Default 1500. */
  noticeGraceMs?: number;
  /** How often the transcript is read during that wait. Default 150. */
  noticePollMs?: number;
  /** How long a request may take once written, before the relay is restarted. Also how long its expectation lasts. Default 60 seconds. */
  requestTimeoutMs?: number;
  /** How long a request waits for the relay to finish a turn of its own. Default 30 seconds. */
  idleWaitMs?: number;
  /** How long the relay must stay idle, after a turn that ignored the request, before it's written again once. Default 1500. */
  retryIdleMs?: number;
  restart?: RestartPolicy;
  /** Default: console.error with a `pitwall: relay:` prefix. Never given a message's text. */
  log?: (message: string) => void;
  /** Request ids, for tests. */
  randomId?: () => string;
}

export const DEFAULT_RESTART: RestartPolicy = { baseMs: 1000, maxMs: 30_000, max: 5, windowMs: 10 * 60_000 };
/** Exchanges kept, one per session messaged. */
const MAX_EXCHANGES = 500;
/** The longest reply kept, in UTF-8 bytes, as the contract allows. */
export const REPLY_MAX_BYTES = 2048;
/** A stopped relay that ran at least this long wasn't failing to start, so the backoff starts over. */
const HEALTHY_RUN_MS = 10_000;
/** The longest stdout line read. Longer ones, such as a huge listing, are skipped. */
const MAX_LINE_CHARS = 8 * 1024 * 1024;

const HELD_DETAIL =
  "Held by that session: it's waiting for approval in that session's own terminal, or its settings hold messages from other sessions.";
const REFUSED_DETAIL = "Refused by that session's settings, which don't accept messages from other sessions.";
const MAY_HAVE_REACHED = 'It may have reached the session: check its conversation before sending again.';
const GATE_NOT_READY = "pitwall's gate for the relay didn't start, so pitwall stopped the relay and nothing was sent. Try again in a moment.";

interface Proc {
  child: RelayChild;
  /** The directory it runs in, as a realpath. */
  cwd: string;
  pid?: number;
  sessionId?: string;
  tail?: RelayTranscriptTail;
  /** A turn is running, or a request has been written and its turn hasn't ended. */
  busy: boolean;
  /** The assistant text of the current turn. */
  turnText: string;
  startedAt: number;
  stderr: string;
  error?: string;
  /** Pitwall asked it to stop. */
  stopping: boolean;
  exited: boolean;
  onExit: (() => void)[];
  /** This process's gate: its hooks, expectation and ready marker. */
  gateId: string;
  /** Resolves true once the gate is ready, or false when it wasn't in time, or the relay stopped first. */
  ready: Promise<boolean>;
  /** The gate's SessionStart hook has marked it ready: its hooks loaded. */
  gateReady: boolean;
  /** SendMessage calls nobody asked for, by tool_use id, waiting for their results. */
  strays: Map<string, Stray>;
  /** The gate blocked a call for one of pitwall's requests that didn't match it: start over when the turn ends. */
  restartAfterTurn: boolean;
  /** The gate blocked the call for one of pitwall's requests in this turn: another SendMessage in it is the relay trying again. */
  blockedInTurn: boolean;
  /** Don't start another relay when this one exits; the next request will. */
  noRestart: boolean;
}

/** A SendMessage call nobody asked for, waiting for its result. */
interface Stray {
  /** It came after the call for a request, in that request's turn: a second call for one request. */
  second: boolean;
  /** The gate had already blocked that request's call in this turn: the relay trying again ('repeated'). */
  repeated: boolean;
}

interface Job {
  target: RelayTarget;
  /** The request's text as pitwall relays it: plainSpaces(). */
  text: string;
  /** This attempt's request id. The second try has a new one. */
  id: string;
  resolve: (outcome: RelaySendOutcome) => void;
  done: boolean;
  /** waiting: not written yet. written: waiting for SendMessage. sent: waiting for its result. grace: waiting for a notice. */
  phase: 'waiting' | 'written' | 'sent' | 'grace';
  /** The target's pid, as the fresh listing shows it. */
  pid: number;
  toolUseId?: string;
  msgId?: string;
  attemptedAt: number;
  /** This attempt was written a second time, after a turn that ignored it. */
  retried: boolean;
  timer?: NodeJS.Timeout;
  /** The gate the expectation was written for. */
  gateId?: string;
  /** Why this attempt's SendMessage call didn't match the request, when it didn't. */
  mismatch?: CallMismatch;
  /** Why the first attempt's call didn't match, once the gate blocked it as a copying slip: the message is tried once more, and only once. */
  blockedOnce?: CallMismatch;
  /** The second try has started: the relay that blocked the first has gone. */
  secondTry: boolean;
}

interface ExchangeState {
  exchange: RelayExchange;
  pid: number;
  msgId?: string;
  sentAtMs: number;
}

export function createRelayManager(options: RelayOptions = {}): RelayManager {
  const dir = path.resolve(options.dir ?? path.join(pitwallHome(), 'relay'));
  const claudeBin = options.claudeBin ?? 'claude';
  const name = options.name ?? RELAY_NAME;
  const spawn = options.spawn ?? spawnRelayChild;
  const agents = options.agents ?? createAgentsSource(options.claudeBin === undefined ? {} : { claudeBin: options.claudeBin });
  const claudeVersion =
    options.claudeVersion ??
    (() => runFile(claudeBin, ['--version'], { cwd: os.tmpdir(), timeoutMs: 10_000, ...(options.env === undefined ? {} : { env: options.env }) }));
  const openTranscript = options.transcript ?? ((o: { sessionId: string; cwd: string }) => createRelayTranscriptTail(o));
  const prepareDir = options.prepareDir ?? prepareRelayDir;
  const gate = options.gate ?? createRelayGate({ dir: path.join(path.dirname(dir), RELAY_GATE_DIR_NAME) });
  const gateReadyMs = options.gateReadyMs ?? 20_000;
  const gatePollMs = options.gatePollMs ?? 50;
  const now = options.now ?? Date.now;
  const maxQueue = options.maxQueue ?? 4;
  const noticeGraceMs = options.noticeGraceMs ?? 1500;
  const noticePollMs = options.noticePollMs ?? 150;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const idleWaitMs = options.idleWaitMs ?? 30_000;
  const retryIdleMs = options.retryIdleMs ?? 1500;
  const restart = options.restart ?? DEFAULT_RESTART;
  const log = options.log ?? ((message: string) => console.error(`pitwall: relay: ${message}`));

  let closed = false;
  let proc: Proc | undefined;
  let current: Job | undefined;
  const queue: Job[] = [];
  const exchanges = new Map<string, ExchangeState>();
  const relayPids = new Set<number>();
  const relaySessionIds = new Set<string>();
  const dirs = new Set<string>([dir]);
  addRealpath(dir);
  let starts: number[] = [];
  let quickFailures = 0;
  let nextStartAt = 0;
  let restartTimer: NodeJS.Timeout | undefined;
  let lastError: string | undefined;
  let idleWaiters: ((idle: boolean) => void)[] = [];
  let tailReads: Promise<void> = Promise.resolve();
  /** Why pitwall stopped using the relay for this run, once its gate let through a call it shouldn't have. */
  let gateBroken: string | undefined;
  /** ISO 8601: when gateBroken was set. */
  let gateBrokenAt: string | undefined;
  let latestAlert: RelayAlert | undefined;
  /** Set once `claude --version` has said it's new enough. Checked again while it hasn't, so an update needs no restart. */
  let versionChecked = false;
  let strayIds = 0;

  function addRealpath(candidate: string): void {
    try {
      dirs.add(realpathSync(candidate));
    } catch {
      // Not created yet.
    }
  }

  // ---------------------------------------------------------------- requests

  function failed(detail: string): RelaySendOutcome {
    return { status: 'failed', detail };
  }

  function brokenDetail(): string {
    return `pitwall stopped using its relay for this run: ${gateBroken} Restart pitwall to use it again.`;
  }

  /**
   * Answers the request. Recording an exchange is separate: only something
   * that may have been sent is recorded. A message whose first copy the gate
   * blocked, and that then wasn't sent, says both. One whose second copy was
   * delivered says the first was blocked (W52), so a retry is never silent.
   */
  function finish(job: Job, outcome: RelaySendOutcome): void {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    if (job.gateId !== undefined) gate.clear(job.gateId);
    if (job.blockedOnce !== undefined && outcome.status === 'failed') {
      const again = job.secondTry ? 'pitwall tried once more, and that wasn’t sent either:' : 'pitwall couldn’t try again:';
      outcome = { ...outcome, detail: `${blockedOnceDetail(job.blockedOnce)} ${again} ${outcome.detail ?? 'no reason given.'}` };
    } else if (job.blockedOnce !== undefined && outcome.status === 'delivered') {
      outcome = { ...outcome, detail: retriedDetail(job.blockedOnce) };
    }
    job.resolve(outcome);
    if (current === job) {
      current = undefined;
      pump();
    }
  }

  function pump(): void {
    if (current !== undefined || closed) return;
    const next = queue.shift();
    if (next === undefined) return;
    current = next;
    run(next).catch((error: unknown) => {
      log(`a request failed unexpectedly: ${oneLine(error instanceof Error ? error.message : String(error))}`);
      if (next.phase === 'waiting') finish(next, failed('pitwall hit an unexpected error while relaying the message.'));
      else unconfirmed(next, 'pitwall hit an unexpected error while relaying the message.');
    });
  }

  async function run(job: Job): Promise<void> {
    const { target } = job;
    if (gateBroken !== undefined) return finish(job, failed(brokenDetail()));
    if (!isAddressable(target.name)) {
      return finish(
        job,
        failed("pitwall can't address this session by its name, which has line breaks, < or >, a space at either end, or is too long. Rename it with /rename in its terminal."),
      );
    }
    // Before starting the relay, so a name that can't work doesn't start one. Checked again right before the write.
    const named = await checkName(job);
    if (job.done) return;
    if (!named.ok) return finish(job, failed(named.detail));

    const started = await ensureRunning();
    if (job.done) return;
    if (!started.ok) {
      return finish(job, started.retryAfterSeconds === undefined ? failed(started.detail) : { ...failed(started.detail), retryAfterSeconds: started.retryAfterSeconds });
    }
    await checkAndWrite(job);
  }

  /** The name check: exactly one live session has the target's name, ignoring case, and it's the target. */
  async function checkName(job: Job): Promise<{ ok: true } | { ok: false; detail: string }> {
    const { target } = job;
    const listed = await agents.list();
    if (!listed.ok) return { ok: false, detail: `Couldn't check that the session's name is unique, so nothing was sent: ${listed.error}` };
    const key = nameKey(target.name);
    const live = listed.rows.filter((row) => row.pid !== undefined && !isRelay(row) && nameKey(row.name) === key);
    if (live.length === 0) return { ok: false, detail: `No running session is named ${target.name} now, so nothing was sent.` };
    if (live.length > 1) {
      return {
        ok: false,
        detail: `Ambiguous name: ${live.length} running sessions are named ${target.name}, counting names that differ only in case, and the relay can't tell them apart by directory. Give this one a unique name with /rename in its terminal.`,
      };
    }
    const row = live[0]!;
    if (row.sessionId !== target.sessionId) return { ok: false, detail: `The name ${target.name} now belongs to another session, so nothing was sent.` };
    if (row.name !== target.name) return { ok: false, detail: "That session's name has just changed, so nothing was sent. Try again in a moment." };
    job.pid = row.pid!;
    return { ok: true };
  }

  /**
   * Waits for the relay's gate and for the relay to be idle, checks the name
   * once more, then writes. Used for the first write and the retry.
   */
  async function checkAndWrite(job: Job): Promise<void> {
    // Counted in rounds rather than by the clock: a peer's turn that starts during the listing, or a new relay, sends it round again.
    for (let round = 0; ; round++) {
      const starting = proc;
      if (starting !== undefined && !starting.stopping && !starting.gateReady) {
        const ready = await starting.ready;
        if (job.done) return;
        if (!ready) return finish(job, failed(gateBroken !== undefined ? brokenDetail() : GATE_NOT_READY));
      }
      const idle = await waitIdle();
      if (job.done) return;
      if (!idle || round >= 3) {
        if (proc === undefined || proc.stopping) {
          return finish(job, failed(`The relay stopped before the message could be sent${lastError === undefined ? '' : ` (${lastError})`}.`));
        }
        return finish(job, { ...failed('The relay is busy with a message from another session. Try again in a moment.'), retryAfterSeconds: 5 });
      }
      const named = await checkName(job);
      if (job.done) return;
      if (!named.ok) return finish(job, failed(named.detail));
      const p = proc;
      if (p === undefined || p.stopping) {
        return finish(job, failed(`The relay stopped before the message could be sent${lastError === undefined ? '' : ` (${lastError})`}.`));
      }
      if (p.gateReady && !p.busy) return write(job, p);
    }
  }

  function write(job: Job, p: Proc): void {
    try {
      gate.expect(p.gateId, { request: job.id, to: job.target.name, text: job.text, expiresAt: now() + requestTimeoutMs });
    } catch (error) {
      log(`couldn't write the gate's expectation: ${oneLine((error as Error).message)}`);
      return finish(job, failed("pitwall couldn't prepare its gate for the message, so nothing was sent."));
    }
    job.gateId = p.gateId;
    job.phase = 'written';
    p.busy = true;
    clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      if (job.done) return;
      anomaly(`The relay didn't finish within ${Math.round(requestTimeoutMs / 1000)}s.`, job);
    }, requestTimeoutMs);
    p.child.write(userMessageLine(frameRequest(job.id, job.target.name, job.text)));
  }

  /**
   * The request was written, and its outcome can't be read: the relay
   * stopped, took too long, or did something else. If a SendMessage call
   * reached the gate, which claims the expectation whatever it decides, it
   * may have been sent; otherwise nothing was.
   */
  function unconfirmed(job: Job, detail: string): void {
    if (job.done) return;
    const reachedGate = job.gateId !== undefined && !gate.pending(job.gateId);
    if (!reachedGate) {
      if (job.mismatch === undefined) return finish(job, failed(`${detail} Nothing was sent.`));
      // A call that never ran: nothing was sent. A copying slip raises no alert, as the gate blocking it wouldn't; anything else does (W52).
      if (job.mismatch.slip === true) log(`${job.mismatch.reason} pitwall stopped the relay before it ran.`);
      else raiseAlert(`${job.mismatch.reason} pitwall stopped the relay before it ran, so nothing was sent.`, true, 'changed');
      return finish(job, failed(`${detail} ${job.mismatch.reason} pitwall stopped it before it ran, so nothing was sent.`));
    }
    if (job.mismatch !== undefined) raiseAlert(`${job.mismatch.reason} pitwall couldn't tell whether its gate stopped it.`, false, 'changed');
    recordOutcome(job, 'uncertain');
    finish(job, { status: 'uncertain', detail: `${detail} ${MAY_HAVE_REACHED}` });
  }

  /** Something the relay did that pitwall didn't ask for: end the request, if any, and restart the relay. */
  function anomaly(detail: string, job?: Job): void {
    log(`${detail} Restarting it.`);
    if (job !== undefined && !job.done) {
      if (job.phase === 'waiting') finish(job, failed(`${detail} pitwall restarted the relay, and nothing was sent.`));
      else unconfirmed(job, `${detail} pitwall restarted the relay.`);
    }
    stopProcess('SIGTERM');
  }

  /** The gate let through a call it shouldn't have: stop the relay, and don't use one again in this run. */
  function breakGate(reason: string): void {
    if (gateBroken === undefined) {
      gateBroken = reason;
      gateBrokenAt = new Date(now()).toISOString();
      log(`pitwall stopped using the relay: ${reason}`);
    }
    if (proc !== undefined) proc.noRestart = true;
    stopProcess('SIGTERM');
  }

  /**
   * `cause`: 'unrequested' for a call with no request behind it, 'changed' for one for a request that didn't
   * match it, 'repeated' for another call in the turn in which the gate blocked the call for a request.
   */
  function raiseAlert(detail: string, blocked: boolean, cause: RelayAlert['cause']): void {
    latestAlert = { at: new Date(now()).toISOString(), detail, count: (latestAlert?.count ?? 0) + 1, blocked, cause };
    log(detail);
  }

  // ---------------------------------------------------------------- the process

  async function ensureRunning(): Promise<{ ok: true } | { ok: false; detail: string; retryAfterSeconds?: number }> {
    // A relay being restarted, after something it did that pitwall didn't ask for: wait for it to go.
    if (proc !== undefined && proc.stopping) await exitedWithin(proc, 3000);
    if (closed) return { ok: false, detail: 'pitwall is shutting down.' };
    if (gateBroken !== undefined) return { ok: false, detail: brokenDetail() };
    if (proc !== undefined && !proc.stopping) return { ok: true };
    if (proc !== undefined) return { ok: false, detail: 'The relay is restarting. Try again in a moment.', retryAfterSeconds: 2 };
    if (!versionChecked) {
      const version = await checkVersion();
      if (!version.ok) return version;
      if (closed) return { ok: false, detail: 'pitwall is shutting down.' };
      if (proc !== undefined) return { ok: true };
    }
    return start();
  }

  /** Refuses to start the relay on a Claude Code too old for the gate's `onFailure`, or one whose version can't be read. */
  async function checkVersion(): Promise<{ ok: true } | { ok: false; detail: string }> {
    let output: string;
    try {
      output = await claudeVersion();
    } catch (error) {
      return { ok: false, detail: `Couldn't run claude --version to check that its gate will work, so nothing was sent: ${oneLine((error as Error).message)}` };
    }
    const checked = checkClaudeVersion(output);
    if (checked.ok) {
      versionChecked = true;
      return { ok: true };
    }
    const which = checked.version === undefined ? "pitwall couldn't read which version this is" : `this is ${checked.version}`;
    return {
      ok: false,
      detail: `pitwall's relay needs Claude Code ${MIN_CLAUDE_VERSION} or later for its gate, and ${which}. Update Claude Code, then try again. Nothing was sent.`,
    };
  }

  function start(): { ok: true } | { ok: false; detail: string; retryAfterSeconds?: number } {
    const at = now();
    starts = starts.filter((startedAt) => at - startedAt < restart.windowMs);
    if (starts.length >= restart.max) {
      const wait = Math.max(1, Math.ceil((starts[0]! + restart.windowMs - at) / 1000));
      return {
        ok: false,
        detail: `The relay stopped ${starts.length} times in ${Math.round(restart.windowMs / 60_000)} minutes, so pitwall stopped restarting it for now${lastError ? `. Last: ${lastError}` : '.'}`,
        retryAfterSeconds: wait,
      };
    }
    if (at < nextStartAt) {
      const wait = Math.max(1, Math.ceil((nextStartAt - at) / 1000));
      return { ok: false, detail: `The relay is restarting. Try again in ${wait}s.`, retryAfterSeconds: wait };
    }
    let real: string;
    try {
      real = prepareDir(dir);
    } catch (error) {
      return { ok: false, detail: `Couldn't prepare the relay's directory: ${oneLine((error as Error).message)}` };
    }
    dirs.add(real);
    let gateId: string;
    let settings: string;
    try {
      gate.prepare();
      gateId = gate.newId();
      settings = gate.settings(gateId);
    } catch (error) {
      return { ok: false, detail: `Couldn't prepare the relay's gate: ${oneLine((error as Error).message)}` };
    }
    const p: Proc = {
      child: undefined as unknown as RelayChild,
      cwd: real,
      busy: false,
      turnText: '',
      startedAt: at,
      stderr: '',
      stopping: false,
      exited: false,
      onExit: [],
      gateId,
      ready: Promise.resolve(false),
      gateReady: false,
      strays: new Map(),
      restartAfterTurn: false,
      blockedInTurn: false,
      noRestart: false,
    };
    const events: RelayChildEvents = {
      line: (line) => onLine(p, line),
      stderr: (text) => {
        p.stderr = (p.stderr + text).slice(-4096);
      },
      error: (message) => {
        p.error = message;
      },
      exit: (code, signal) => onExit(p, code, signal),
    };
    try {
      p.child = spawn(claudeBin, relayArgs({ name, settings, ...(options.model === undefined ? {} : { model: options.model }) }), {
        cwd: real,
        env: relayEnvironment(options.env ?? process.env),
      }, events);
    } catch (error) {
      gate.forget(gateId);
      return { ok: false, detail: `Couldn't start the relay: ${oneLine((error as Error).message)}` };
    }
    if (p.child.pid !== undefined) {
      p.pid = p.child.pid;
      relayPids.add(p.pid);
    }
    starts.push(at);
    proc = p;
    p.ready = waitForGate(p);
    return { ok: true };
  }

  /**
   * Resolves true once the relay's SessionStart hook has marked its gate
   * ready. A relay that doesn't in time is stopped, and not restarted until
   * the next request: its hooks may not have loaded, so its SendMessage
   * isn't gated. Counted in polls rather than by the clock.
   */
  async function waitForGate(p: Proc): Promise<boolean> {
    const polls = Math.max(1, Math.ceil(gateReadyMs / gatePollMs));
    for (let polled = 0; polled <= polls; polled++) {
      if (p.exited || p.stopping) return false;
      if (gate.isReady(p.gateId)) {
        p.gateReady = true;
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, gatePollMs));
    }
    if (p.exited || p.stopping) return false;
    log(`its gate didn't report ready within ${Math.round(gateReadyMs / 1000)}s, so its hooks may not have loaded. Stopping it.`);
    p.noRestart = true;
    if (proc === p) stopProcess('SIGTERM');
    return false;
  }

  function stopProcess(signal: NodeJS.Signals): void {
    const p = proc;
    if (p === undefined || p.stopping) return;
    p.stopping = true;
    p.child.end();
    p.child.kill(signal);
  }

  function onExit(p: Proc, code: number | null, signal: NodeJS.Signals | null): void {
    if (p.exited) return;
    p.exited = true;
    if (p.pid !== undefined) relayPids.delete(p.pid);
    for (const resolve of p.onExit.splice(0)) resolve();
    if (proc !== p) {
      gate.forget(p.gateId);
      return;
    }
    proc = undefined;
    const said = firstLine(p.stderr);
    const why = p.error ?? (code !== null ? `exit code ${code}` : `signal ${signal ?? 'unknown'}`);
    lastError = said === undefined ? why : `${why}: ${said}`;
    if (!p.stopping) log(`it stopped (${lastError}).`);
    // Calls nobody asked for whose results never came.
    for (const stray of p.strays.values()) {
      const said = strayWords(p, stray);
      raiseAlert(`${said.detail} The relay stopped before pitwall saw whether its gate blocked it.`, false, said.cause);
    }
    p.strays.clear();
    if (current !== undefined && current.phase === 'grace') {
      // SendMessage had already delivered it; only the wait for a notice was cut short.
      finish(current, { status: 'delivered' });
    } else if (current !== undefined && current.phase !== 'waiting') {
      const detail = p.stopping
        ? 'The relay was restarted before it answered.'
        : p.error !== undefined
          ? `Couldn't start the relay: ${p.error}.`
          : `The relay stopped (${lastError}).`;
      unconfirmed(current, detail);
    }
    gate.forget(p.gateId);
    settleIdle(false);
    // A relay that never started, or whose gate failed, isn't started again until the next request asks for it.
    if (closed || p.error !== undefined || p.noRestart) return;
    let delay = 0;
    if (!p.stopping) {
      quickFailures = now() - p.startedAt < HEALTHY_RUN_MS ? quickFailures + 1 : 1;
      delay = Math.min(restart.maxMs, restart.baseMs * 2 ** (quickFailures - 1));
    }
    nextStartAt = now() + delay;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (closed || proc !== undefined || gateBroken !== undefined) return;
      // The backoff is over. Date.now() can lag the timer by a millisecond, which start() would take for "still backing off".
      nextStartAt = 0;
      const result = start();
      if (!result.ok) log(`couldn't restart it: ${result.detail}`);
      pump();
    }, delay);
  }

  function waitIdle(): Promise<boolean> {
    const p = proc;
    if (p === undefined || p.stopping) return Promise.resolve(false);
    if (!p.busy) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        idleWaiters = idleWaiters.filter((waiter) => waiter !== done);
        resolve(false);
      }, idleWaitMs);
      const done = (idle: boolean) => {
        clearTimeout(timer);
        resolve(idle);
      };
      idleWaiters.push(done);
    });
  }

  function settleIdle(idle: boolean): void {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const waiter of waiters) waiter(idle);
  }

  // ---------------------------------------------------------------- stream-json

  function onLine(p: Proc, line: string): void {
    if (proc !== p || line.trim() === '') return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') onTurnStart(p, event);
        else if (event.subtype === 'hook_response') onHookResponse(event);
        return;
      case 'assistant':
        p.busy = true;
        for (const block of blocksOf(event)) {
          if (block.type === 'tool_use') onToolUse(p, block);
          else if (block.type === 'text' && typeof block.text === 'string') p.turnText += `${block.text}\n`;
        }
        return;
      case 'user':
        for (const block of blocksOf(event)) if (block.type === 'tool_result') onToolResult(p, block);
        return;
      case 'result':
        onTurnEnd(p);
        return;
      default:
        return;
    }
  }

  function onTurnStart(p: Proc, event: Record<string, unknown>): void {
    p.busy = true;
    p.turnText = '';
    p.blockedInTurn = false;
    const sessionId = event.session_id;
    if (typeof sessionId !== 'string' || !isSafeSessionId(sessionId) || sessionId === p.sessionId) return;
    p.sessionId = sessionId;
    relaySessionIds.add(sessionId);
    const cwd = typeof event.cwd === 'string' && path.isAbsolute(event.cwd) ? event.cwd : p.cwd;
    p.tail = openTranscript({ sessionId, cwd });
  }

  /**
   * From --include-hook-events: a gate hook that failed blocked its call. Say
   * so, without its output. Exit 2 is how the gate denies, not a failure.
   */
  function onHookResponse(event: Record<string, unknown>): void {
    if (event.hook_event !== 'PreToolUse' || event.outcome !== 'error' || event.exit_code === 2) return;
    const code = typeof event.exit_code === 'number' ? ` (exit code ${event.exit_code})` : '';
    log(`its gate hook failed${code}, so Claude Code blocked the call.`);
  }

  function onToolUse(p: Proc, block: Record<string, unknown>): void {
    const job = current;
    if (block.name !== 'SendMessage') return anomaly(`The relay used a tool it isn't allowed (${oneLine(String(block.name), 60)}).`, job);
    const id = typeof block.id === 'string' ? block.id : `pitwall-unknown-${++strayIds}`;
    if (job !== undefined && job.phase === 'written') {
      job.phase = 'sent';
      job.toolUseId = id;
      const mismatch = callMismatch(block.input, job.target.name, job.text);
      if (mismatch !== undefined) job.mismatch = mismatch;
      return;
    }
    // Nobody asked for this one. The gate has no expectation for it, so it should deny it.
    // After the gate blocked the call for a request in this turn, it's the relay trying that request again (W48's F8),
    // whether that request is now 'waiting' for its second try or has its answer. Otherwise, after the call for the
    // request in flight, it's a second call for that request.
    const repeated = p.blockedInTurn;
    p.strays.set(id, { repeated, second: repeated || (job !== undefined && job.phase !== 'waiting') });
  }

  /**
   * What a call nobody asked for was, in pitwall's words, and its alert's cause. Asked again when its
   * result comes, so a repeat whose request's denial arrived after it, as with two calls in one message,
   * is still called a repeat.
   */
  function strayWords(p: Proc, stray: Stray): { detail: string; cause: RelayAlert['cause'] } {
    if (stray.repeated || (stray.second && p.blockedInTurn)) {
      return { detail: 'The relay tried again to send one of your messages, in the same turn, after pitwall’s gate had blocked its copy.', cause: 'repeated' };
    }
    if (stray.second) return { detail: 'The relay tried to send a second message for one request.', cause: 'unrequested' };
    return { detail: 'The relay tried to send a message when pitwall hadn’t asked it to.', cause: 'unrequested' };
  }

  function onToolResult(p: Proc, block: Record<string, unknown>): void {
    const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
    const stray = toolUseId === undefined ? undefined : p.strays.get(toolUseId);
    if (stray !== undefined) {
      p.strays.delete(toolUseId!);
      return onStrayResult(strayWords(p, stray), parseSendResult(block));
    }
    const job = current;
    if (job === undefined || job.phase !== 'sent') return;
    if (job.toolUseId !== undefined && toolUseId !== job.toolUseId) return;
    const result = parseSendResult(block);
    if (result.kind === 'denied') p.blockedInTurn = true;
    if (job.mismatch !== undefined) return onMismatchResult(p, job, job.mismatch, result);
    switch (result.kind) {
      case 'denied':
        return finish(job, failed(denialDetail(result.reason)));
      case 'not-sent':
        return finish(job, failed(result.reason));
      case 'unknown':
        recordOutcome(job, 'uncertain');
        return finish(job, { status: 'uncertain', detail: `${result.reason}. ${MAY_HAVE_REACHED}` });
      case 'sent':
        break;
    }
    if (result.msgId !== undefined) job.msgId = result.msgId;
    job.phase = 'grace';
    recordOutcome(job, 'delivered');
    if (job.gateId !== undefined && gate.pending(job.gateId)) {
      // It ran, and the gate never claimed the expectation: the gate isn't in the way of SendMessage.
      // It was your message, as asked, so nothing unrequested or changed was sent: no alert. relayOff says messaging is off, and why.
      log("The relay's SendMessage ran without pitwall's gate checking it. It was the message you sent, but the relay isn't safe to use.");
      breakGate("its gate didn't check a SendMessage call.");
    }
    // Counted in polls rather than by the clock, so the wait is the same whatever the time does.
    const polls = Math.max(1, Math.ceil(noticeGraceMs / noticePollMs));
    let polled = 0;
    const tick = async () => {
      if (job.done) return;
      await readTail();
      if (job.done) return;
      if (++polled >= polls) return finish(job, { status: 'delivered' });
      job.timer = setTimeout(() => void tick(), noticePollMs);
    };
    clearTimeout(job.timer);
    void tick();
  }

  /**
   * The result of the request's call, which didn't match the request: the
   * gate should have denied it. Denied as a copying slip, it raises no alert,
   * since nothing was sent: the first time, the message is tried once more on
   * a new relay, and the second time, its result says so. Denied as anything
   * else, which a slip doesn't explain and a peer may have caused, it raises
   * a blocked 'changed' alert and isn't tried again (W52, W48's F3).
   */
  function onMismatchResult(p: Proc, job: Job, mismatch: CallMismatch, result: SendResult): void {
    if (result.kind === 'denied') {
      // Blocked, but the relay got pitwall's own request wrong: its conversation may have been poisoned, so it starts over.
      p.restartAfterTurn = true;
      if (mismatch.slip !== true) raiseAlert(`${mismatch.reason} pitwall's gate blocked it, so nothing was sent.`, true, 'changed');
      if (job.blockedOnce === undefined) {
        if (mismatch.slip !== true) return finish(job, failed(notTriedDetail(mismatch)));
        log(`${mismatch.reason} pitwall's gate blocked it, so nothing was sent. pitwall will try once more, on a new relay.`);
        return tryOnceMore(p, job, mismatch);
      }
      if (mismatch.slip === true) log(`${mismatch.reason} pitwall's gate blocked it again, so nothing was sent.`);
      const first = job.blockedOnce;
      // This is the whole story: finish() adds nothing to it.
      delete job.blockedOnce;
      return finish(job, failed(blockedTwiceDetail(first, mismatch)));
    }
    raiseAlert(`${mismatch.reason} pitwall's gate didn't stop it${result.kind === 'not-sent' ? ', though SendMessage didn’t send it' : ''}.`, false, 'changed');
    breakGate('its gate let through a SendMessage call that didn’t match the request.');
    if (result.kind === 'not-sent') return finish(job, failed(result.reason));
    if (result.kind === 'sent' && result.msgId !== undefined) job.msgId = result.msgId;
    recordOutcome(job, 'uncertain');
    finish(job, { status: 'uncertain', detail: `${mismatch.reason} ${MAY_HAVE_REACHED}` });
  }

  /**
   * The gate blocked the first copy: nothing was sent. Once the relay that
   * made it has gone, which it does when its turn ends, send the same text
   * on a new one, with a new request id and expectation. Until then the
   * request is 'waiting', as one not yet written is, and the first write's
   * timer still runs, so a turn that doesn't end can't hold it up.
   */
  function tryOnceMore(p: Proc, job: Job, mismatch: CallMismatch): void {
    job.blockedOnce = mismatch;
    job.phase = 'waiting';
    delete job.mismatch;
    delete job.toolUseId;
    delete job.msgId;
    p.onExit.push(() => {
      // After the rest of onExit(), so the relay that's gone is no longer `proc`.
      setImmediate(() => {
        if (job.done || current !== job) return;
        secondTry(job).catch((error: unknown) => {
          log(`a second try failed unexpectedly: ${oneLine(error instanceof Error ? error.message : String(error))}`);
          if (job.phase === 'waiting') finish(job, failed('pitwall hit an unexpected error while relaying the message.'));
          else unconfirmed(job, 'pitwall hit an unexpected error while relaying the message.');
        });
      });
    });
  }

  async function secondTry(job: Job): Promise<void> {
    clearTimeout(job.timer);
    job.secondTry = true;
    job.retried = false;
    job.id = newRequestId(job.text, options.randomId);
    job.attemptedAt = now();
    const started = await ensureRunning();
    if (job.done) return;
    if (!started.ok) {
      return finish(job, started.retryAfterSeconds === undefined ? failed(started.detail) : { ...failed(started.detail), retryAfterSeconds: started.retryAfterSeconds });
    }
    await checkAndWrite(job);
  }

  /** The result of a call nobody asked for. */
  function onStrayResult({ detail, cause }: { detail: string; cause: RelayAlert['cause'] }, result: SendResult): void {
    // Blocked, so the relay is still sound: no restart, which a peer could otherwise repeat until the restart limit.
    if (result.kind === 'denied') return raiseAlert(`${detail} pitwall's gate blocked it, so nothing was sent.`, true, cause);
    raiseAlert(`${detail} pitwall's gate didn't stop it${result.kind === 'not-sent' ? ', though SendMessage didn’t send it' : ''}, so pitwall stopped the relay.`, false, cause);
    breakGate('its gate let through a SendMessage call nobody asked for.');
  }

  function onTurnEnd(p: Proc): void {
    p.busy = false;
    const text = p.turnText;
    p.turnText = '';
    void readTail();
    const job = current;
    if (job !== undefined && job.phase === 'written') {
      const answer = findAnswer(text, job.id);
      if (answer?.kind === 'not-relayed') finish(job, failed(`Not sent: ${answer.reason}`));
      else if (answer?.kind === 'relayed') anomaly("The relay said it sent the message, but pitwall didn't see it call SendMessage.", job);
      else scheduleRetry(job);
    }
    // A call nobody asked for whose result never came: pitwall can't tell what happened, so it starts over.
    if (p.strays.size > 0 && proc === p && !p.stopping) {
      for (const stray of p.strays.values()) {
        const said = strayWords(p, stray);
        raiseAlert(`${said.detail} Its turn ended before pitwall saw whether its gate blocked it.`, false, said.cause);
      }
      p.blockedInTurn = false;
      p.strays.clear();
      log('restarting it after a turn that ended before a call nobody asked for had its result.');
      stopProcess('SIGTERM');
      return;
    }
    // A call in the next turn isn't a repeat. Calls still waiting for their results, on a relay that's going, keep it for onExit().
    if (p.strays.size === 0) p.blockedInTurn = false;
    if (p.restartAfterTurn && proc === p && !p.stopping) {
      log("restarting it after it sent something other than pitwall's request, which its gate blocked.");
      stopProcess('SIGTERM');
      return;
    }
    settleIdle(true);
  }

  /** The relay ended a turn without acting on the request: write it once more, if it stays idle. */
  function scheduleRetry(job: Job): void {
    setTimeout(() => {
      if (job.done || job.phase !== 'written' || current !== job) return;
      const p = proc;
      if (p === undefined || p.busy) return;
      if (job.retried) return finish(job, failed("The relay didn't act on the message, so nothing was sent."));
      // A call reached the gate without pitwall seeing it: don't send it again.
      if (job.gateId !== undefined && !gate.pending(job.gateId)) return unconfirmed(job, "The relay didn't say what it did with the message.");
      job.retried = true;
      job.phase = 'waiting';
      checkAndWrite(job).catch((error: unknown) => {
        log(`a retry failed unexpectedly: ${oneLine(error instanceof Error ? error.message : String(error))}`);
        finish(job, failed('pitwall hit an unexpected error while relaying the message.'));
      });
    }, retryIdleMs);
  }

  // ---------------------------------------------------------------- outcomes

  /** Records the session's exchange. Only for a message that was, or may have been, sent. */
  function recordOutcome(job: Job, status: RelayStatus): void {
    const sentAtMs = job.attemptedAt;
    const state: ExchangeState = { exchange: { sentAt: new Date(sentAtMs).toISOString(), status }, pid: job.pid, sentAtMs };
    if (job.msgId !== undefined) state.msgId = job.msgId;
    const previous = exchanges.get(job.target.sessionId);
    // The same request again, from delivered to held: keep any reply.
    if (previous !== undefined && previous.sentAtMs === sentAtMs && previous.exchange.reply !== undefined) {
      state.exchange.reply = previous.exchange.reply;
    }
    exchanges.delete(job.target.sessionId);
    exchanges.set(job.target.sessionId, state);
    while (exchanges.size > MAX_EXCHANGES) exchanges.delete(exchanges.keys().next().value!);
  }

  function readTail(): Promise<void> {
    tailReads = tailReads.then(async () => {
      const tail = proc?.tail;
      if (tail === undefined) return;
      for (const event of await tail.read()) apply(event);
    });
    return tailReads;
  }

  function apply(event: RelayTranscriptEvent): void {
    if (event.kind === 'notice') {
      const status = NOTICE_STATUS[event.outcome];
      if (status === undefined) return;
      for (const state of exchanges.values()) {
        if (state.msgId !== event.msgId) continue;
        state.exchange.status = status;
      }
      const job = current;
      if (job !== undefined && job.phase === 'grace' && job.msgId === event.msgId && status !== 'delivered') {
        finish(job, { status, detail: status === 'held' ? HELD_DETAIL : status === 'refused' ? REFUSED_DETAIL : 'It expired before it was delivered.' });
      }
      return;
    }
    if (event.pid === undefined) return;
    const at = event.at !== undefined && Number.isFinite(Date.parse(event.at)) ? Date.parse(event.at) : now();
    let match: ExchangeState | undefined;
    for (const state of exchanges.values()) {
      if (state.pid !== event.pid || state.msgId === undefined) continue;
      if (state.exchange.status === 'failed' || state.exchange.status === 'refused') continue;
      if (at < state.sentAtMs) continue;
      if (match === undefined || state.sentAtMs > match.sentAtMs) match = state;
    }
    if (match === undefined) return;
    const text = replyText(event.body);
    if (text === '') return;
    match.exchange.reply = { at: new Date(at).toISOString(), text };
  }

  // ---------------------------------------------------------------- the manager

  function isRelay(row: { sessionId: string; pid?: number | undefined; cwd: string }): boolean {
    if (row.pid !== undefined && relayPids.has(row.pid)) return true;
    if (relaySessionIds.has(row.sessionId)) return true;
    return dirs.has(path.resolve(row.cwd));
  }

  return {
    send(target, text) {
      if (closed) return Promise.resolve(failed('pitwall is shutting down.'));
      if (gateBroken !== undefined) return Promise.resolve(failed(brokenDetail()));
      if (queue.length >= maxQueue) {
        return Promise.resolve({ ...failed('The relay is busy with other messages. Try again in a moment.'), retryAfterSeconds: 5 });
      }
      // What the relay is asked to copy, what the gate expects and what the call is checked against.
      const plain = plainSpaces(text);
      return new Promise<RelaySendOutcome>((resolve) => {
        queue.push({
          target,
          text: plain,
          id: newRequestId(plain, options.randomId),
          resolve,
          done: false,
          phase: 'waiting',
          pid: target.pid,
          attemptedAt: now(),
          retried: false,
          secondTry: false,
        });
        pump();
      });
    },
    exchange(sessionId) {
      const state = exchanges.get(sessionId);
      if (state === undefined) return undefined;
      const { reply, ...rest } = state.exchange;
      return reply === undefined ? { ...rest } : { ...rest, reply: { ...reply } };
    },
    alert() {
      return latestAlert === undefined ? undefined : { ...latestAlert };
    },
    off() {
      return gateBroken === undefined || gateBrokenAt === undefined ? undefined : { since: gateBrokenAt, reason: gateBroken };
    },
    isRelay,
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(restartTimer);
      for (const job of queue.splice(0)) finish(job, failed('pitwall is shutting down.'));
      if (current !== undefined) {
        if (current.phase === 'waiting') finish(current, failed('pitwall is shutting down.'));
        else if (current.phase === 'grace') finish(current, { status: 'delivered' });
        else unconfirmed(current, 'pitwall is shutting down.');
      }
      settleIdle(false);
      const p = proc;
      if (p === undefined || p.exited) return;
      p.stopping = true;
      p.child.end();
      if (await exitedWithin(p, 1000)) return;
      p.child.kill('SIGTERM');
      if (await exitedWithin(p, 1000)) return;
      p.child.kill('SIGKILL');
    },
  };
}

/** Today's reason for a call that didn't match, as the rest of a sentence: "the relay changed the text …". */
function lowerFirst(reason: string): string {
  return reason.charAt(0).toLowerCase() + reason.slice(1);
}

/** The first copy, which the gate blocked: what the result says before why the second try didn't go. */
function blockedOnceDetail(first: CallMismatch): string {
  return `pitwall's gate stopped the relay's copy of your message, because it didn't match, so nothing was sent. ${first.reason}`;
}

/** A blocked copy that a slip doesn't explain (W52): nothing was sent, and pitwall didn't try again. */
function notTriedDetail(mismatch: CallMismatch): string {
  return `${blockedOnceDetail(mismatch)} A copying slip doesn’t explain that, so pitwall didn’t try again.`;
}

/** The second copy delivered (W52): the result says the first was blocked, and where it differed, never with the text. */
function retriedDetail(first: CallMismatch): string {
  return `pitwall's gate stopped the relay's first copy of your message, because it didn't match, so pitwall tried once more, on a new relay, and the second copy went through. The first time, ${lowerFirst(first.reason)}`;
}

/** Both copies blocked: nothing was sent, and where each first differed, or today's reason for another mismatch. */
function blockedTwiceDetail(first: CallMismatch, second: CallMismatch): string {
  const lead = "pitwall's gate stopped the relay's copy of your message twice, because it didn't match, so nothing was sent.";
  if (first.reason === second.reason) return `${lead} Both times, ${lowerFirst(first.reason)}`;
  return `${lead} The first time, ${lowerFirst(first.reason)} The second time, ${lowerFirst(second.reason)}`;
}

/** What a delivery notice makes of a relayed message's status. */
const NOTICE_STATUS: Record<NoticeOutcome, RelayStatus | undefined> = {
  held: 'held',
  refused: 'refused',
  denied: 'refused',
  expired: 'failed',
  released: 'delivered',
  other: undefined,
};

/**
 * A gate denial, in pitwall's words: the gate's own reason, which Claude Code
 * v2.1.303 puts after `PreToolUse:SendMessage hook error: [<command>]: `, or
 * that the hook couldn't run. Never the command line, which has paths in it.
 */
export function denialDetail(reason: string): string {
  const prefix = `${DENIAL_PREFIX} denied this SendMessage: `;
  const at = reason.indexOf(prefix);
  if (at !== -1) {
    const why = reason
      .slice(at + prefix.length)
      .replace(/\. Don't call SendMessage again for it\..*$/, '')
      .replace(/\.$/, '');
    return `pitwall's gate didn't let the relay send it, because ${oneLine(why, 200)}. Nothing was sent.`;
  }
  if (/hook error/i.test(reason)) return "pitwall's gate couldn't check the relay's send, so it was blocked and nothing was sent.";
  return "The relay's send was denied before it ran, so nothing was sent.";
}

/**
 * Variables that make a process load code other than the program it was
 * given: Node.js preloads and loaders (NODE_OPTIONS' --require, --import and
 * --loader), a module in place of the REPL, extra module search paths, a
 * compile cache whose code it runs, OpenSSL configuration that can load
 * engines and providers, and the dynamic linker's preloads. The relay's gate
 * hook is a node process that inherits the relay's environment, so these
 * are dropped from it: whatever they'd load would run inside the gate.
 * NODE_EXTRA_CA_CERTS, NODE_TLS_REJECT_UNAUTHORIZED and the like only
 * change trust, and stay, because Claude Code may need them to reach its API.
 */
export const CODE_LOADING_VARIABLES: ReadonlySet<string> = new Set([
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_PATH',
  'NODE_COMPILE_CACHE',
  'OPENSSL_CONF',
  'OPENSSL_ENGINES',
  'OPENSSL_MODULES',
  'LD_PRELOAD',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
]);

/**
 * The relay's environment: childEnvironment(), without CODE_LOADING_VARIABLES,
 * and with auto memory off, which would otherwise be the only thing loaded
 * from the user's files, as `--setting-sources ""` leaves it on.
 */
export function relayEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result = childEnvironment(env);
  for (const name of Object.keys(result)) {
    if (CODE_LOADING_VARIABLES.has(name.toUpperCase())) delete result[name];
  }
  result.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return result;
}

/** The oldest Claude Code the gate works on: `onFailure` came in 2.1.295. */
export const MIN_CLAUDE_VERSION = '2.1.295';

/**
 * Whether `claude --version` output names MIN_CLAUDE_VERSION or later, and
 * the version it named. Output that doesn't start with a version counts as
 * too old.
 */
export function checkClaudeVersion(output: string): { ok: boolean; version?: string } {
  const match = /^\s*(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (match === null) return { ok: false };
  const version = `${match[1]}.${match[2]}.${match[3]}`;
  const found = [match[1], match[2], match[3]].map(Number);
  const min = MIN_CLAUDE_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (found[i]! !== min[i]!) return { ok: found[i]! > min[i]!, version };
  }
  return { ok: true, version };
}

function exitedWithin(p: Proc, ms: number): Promise<boolean> {
  if (p.exited) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    p.onExit.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function blocksOf(event: Record<string, unknown>): Record<string, unknown>[] {
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

// Terminal escapes, then the remaining controls except tab and newline.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]/g;
const CONTROLS_BUT_NEWLINES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** A reply as plain text: no terminal escapes or controls other than tab and newline, at most 2 KiB of UTF-8. */
export function replyText(body: string): string {
  const clean = body
    .slice(0, 4 * REPLY_MAX_BYTES)
    .replace(ESCAPES, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROLS_BUT_NEWLINES, '')
    .trim();
  if (Buffer.byteLength(clean, 'utf8') <= REPLY_MAX_BYTES) return clean;
  // Leave room for the ellipsis, and drop a character the cut split in two.
  let cut = Buffer.from(clean, 'utf8').subarray(0, REPLY_MAX_BYTES - 3).toString('utf8');
  if (cut.endsWith('�')) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function firstLine(text: string): string | undefined {
  const line = text
    .replace(ESCAPES, '')
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== '');
  return line === undefined ? undefined : oneLine(line, 200);
}

/** `~/.pitwall` and its `relay` directory, each 0700, a real directory and the user's own. Returns the realpath. */
export function prepareRelayDir(dir: string): string {
  ensureLaunchDir(path.dirname(dir));
  ensureLaunchDir(dir);
  return realpathSync(dir);
}

/** The real RelaySpawner: a child process with piped stdio and no shell. */
export const spawnRelayChild: RelaySpawner = (file, args, options, events) => {
  const child = spawnProcess(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  let buffer = '';
  let skipping = false;
  let exited = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    let text = chunk;
    for (;;) {
      const newline = text.indexOf('\n');
      if (newline === -1) break;
      const line = buffer + text.slice(0, newline);
      buffer = '';
      text = text.slice(newline + 1);
      if (skipping) skipping = false;
      else events.line(line);
    }
    if (skipping) return;
    buffer += text;
    if (buffer.length > MAX_LINE_CHARS) {
      buffer = '';
      skipping = true;
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => events.stderr(chunk));
  // Writing after the relay exits raises EPIPE here; the exit is reported below.
  child.stdin.on('error', () => undefined);
  const exit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    events.exit(code, signal);
  };
  child.on('error', (error: NodeJS.ErrnoException) => {
    events.error(error.code === 'ENOENT' ? `${file} was not found` : oneLine(error.message));
    // A process that never started emits no exit.
    if (child.pid === undefined) exit(null, null);
  });
  child.on('close', exit);
  return {
    get pid() {
      return child.pid;
    },
    write(data) {
      if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(data);
    },
    end() {
      if (!child.stdin.destroyed) child.stdin.end();
    },
    kill(signal) {
      if (!exited && child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
  };
};
