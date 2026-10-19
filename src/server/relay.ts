// The relay (W11, D8): one headless Claude session that pitwall runs as its
// own child process, `claude -p` with stream-json on stdin and stdout, named
// pitwall-relay, on Haiku, limited to ListAgents and SendMessage. It's the
// only way pitwall can message an interactive session (D2), because only a
// Claude session can call SendMessage. Spike 003 has the evidence for every
// rule below.
//
// One request at a time:
//
//   1. check the name against the unfiltered `claude agents --json --all`: exactly
//      one live session with it, and it's the one asked for. ListAgents
//      doesn't show directories, so two sessions with one name can't be told
//      apart, and the request fails as ambiguous rather than guess
//   2. start the relay if it isn't running, and wait until it's idle: a
//      prompt written mid-turn can be drained into that turn and ignored
//   3. write the framed request (relayPrompt.ts) to its stdin
//   4. check its SendMessage call against the request: one call, to the
//      target's name, with the text exactly. Anything else, including a
//      SendMessage nobody asked for, fails the request and restarts the relay
//   5. read the call's result: `success: true` is delivered. A delivery
//      notice with the same msg_id, read from the relay's transcript within a
//      short grace period, turns it into held or refused
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
import path from 'node:path';
import { createAgentsSource, type AgentsSource } from '../index/agents.js';
import { isRecord } from '../index/guards.js';
import {
  createRelayTranscriptTail,
  type NoticeOutcome,
  type RelayTranscriptEvent,
  type RelayTranscriptTail,
} from '../index/relayTranscript.js';
import { isSafeSessionId } from '../index/transcripts.js';
import type { RelayExchange, RelayResult, RelayStatus } from '../shared/protocol.js';
import { childEnvironment } from './command.js';
import { ensureLaunchDir, pitwallHome } from './launch.js';
import {
  findAnswer,
  frameRequest,
  isAddressable,
  newRequestId,
  oneLine,
  parseSendResult,
  RELAY_NAME,
  relayArgs,
  sendMismatch,
  userMessageLine,
} from './relayPrompt.js';

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
  /** Relays `text`, verbatim, to `target`. Never rejects. */
  send(target: RelayTarget, text: string): Promise<RelaySendOutcome>;
  /** The latest exchange with a session, for its summary in the snapshot. */
  exchange(sessionId: string): RelayExchange | undefined;
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
  /** Reads the relay's transcript. Default createRelayTranscriptTail. */
  transcript?: (options: { sessionId: string; cwd: string }) => RelayTranscriptTail;
  /** Creates the directory if needed, checks it's safe, and returns its realpath. Throws when it isn't safe. */
  prepareDir?: (dir: string) => string;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Requests that can wait behind the one being relayed. Default 4. */
  maxQueue?: number;
  /** How long after a successful send to wait for a held or refused notice. Default 1500. */
  noticeGraceMs?: number;
  /** How often the transcript is read during that wait. Default 150. */
  noticePollMs?: number;
  /** How long a request may take once written, before the relay is restarted. Default 60 seconds. */
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
}

interface Job {
  target: RelayTarget;
  text: string;
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
  retried: boolean;
  timer?: NodeJS.Timeout;
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
  const openTranscript = options.transcript ?? ((o: { sessionId: string; cwd: string }) => createRelayTranscriptTail(o));
  const prepareDir = options.prepareDir ?? prepareRelayDir;
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

  function finish(job: Job, outcome: RelaySendOutcome, record = true): void {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    if (record) recordOutcome(job, outcome.status);
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
      finish(next, failed('pitwall hit an unexpected error while relaying the message.'));
    });
  }

  async function run(job: Job): Promise<void> {
    const { target } = job;
    if (!isAddressable(target.name)) {
      return finish(job, failed("pitwall can't address this session by its name, which has line breaks, < or >, or is too long. Rename it with /rename in its terminal."));
    }
    const listed = await agents.list();
    if (job.done) return;
    if (!listed.ok) return finish(job, failed(`Couldn't check that the session's name is unique, so nothing was sent: ${listed.error}`));
    const live = listed.rows.filter((row) => row.name === target.name && row.pid !== undefined && !isRelay(row));
    if (live.length === 0) return finish(job, failed(`No running session is named ${target.name} now, so nothing was sent.`));
    if (live.length > 1) {
      return finish(
        job,
        failed(
          `Ambiguous name: ${live.length} running sessions are named ${target.name}, and the relay can't tell them apart by directory. Give this one a unique name with /rename in its terminal.`,
        ),
      );
    }
    const row = live[0]!;
    if (row.sessionId !== target.sessionId) {
      return finish(job, failed(`The name ${target.name} now belongs to another session, so nothing was sent.`));
    }
    job.pid = row.pid!;

    const started = await ensureRunning();
    if (job.done) return;
    if (!started.ok) {
      return finish(job, started.retryAfterSeconds === undefined ? failed(started.detail) : { ...failed(started.detail), retryAfterSeconds: started.retryAfterSeconds }, false);
    }
    const idle = await waitIdle();
    if (job.done) return;
    if (!idle) {
      if (proc === undefined || proc.stopping) {
        return finish(job, failed(`The relay stopped before the message could be sent${lastError === undefined ? '' : ` (${lastError})`}.`));
      }
      return finish(job, { ...failed('The relay is busy with a message from another session. Try again in a moment.'), retryAfterSeconds: 5 }, false);
    }
    write(job);
  }

  function write(job: Job): void {
    const p = proc;
    if (p === undefined) return finish(job, failed(lastError ?? 'The relay stopped before the message could be sent.'));
    job.phase = 'written';
    p.busy = true;
    clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      if (job.done) return;
      anomaly(`The relay didn't finish within ${Math.round(requestTimeoutMs / 1000)}s.`, job);
    }, requestTimeoutMs);
    p.child.write(userMessageLine(frameRequest(job.id, job.target.name, job.text)));
  }

  /** Something the relay did that pitwall didn't ask for: fail the request, if any, and restart the relay. */
  function anomaly(detail: string, job?: Job): void {
    log(`${detail} Restarting it.`);
    if (job !== undefined && !job.done) finish(job, failed(`${detail} pitwall restarted the relay.`));
    stopProcess('SIGTERM');
  }

  // ---------------------------------------------------------------- the process

  async function ensureRunning(): Promise<{ ok: true } | { ok: false; detail: string; retryAfterSeconds?: number }> {
    // A relay being restarted, after something it did that pitwall didn't ask for: wait for it to go.
    if (proc !== undefined && proc.stopping) await exitedWithin(proc, 3000);
    if (closed) return { ok: false, detail: 'pitwall is shutting down.' };
    if (proc !== undefined && !proc.stopping) return { ok: true };
    if (proc !== undefined) return { ok: false, detail: 'The relay is restarting. Try again in a moment.', retryAfterSeconds: 2 };
    return start();
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
      p.child = spawn(claudeBin, relayArgs({ name, ...(options.model === undefined ? {} : { model: options.model }) }), {
        cwd: real,
        env: childEnvironment(options.env ?? process.env),
      }, events);
    } catch (error) {
      return { ok: false, detail: `Couldn't start the relay: ${oneLine((error as Error).message)}` };
    }
    if (p.child.pid !== undefined) {
      p.pid = p.child.pid;
      relayPids.add(p.pid);
    }
    starts.push(at);
    proc = p;
    return { ok: true };
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
    if (proc !== p) return;
    proc = undefined;
    const said = firstLine(p.stderr);
    const why = p.error ?? (code !== null ? `exit code ${code}` : `signal ${signal ?? 'unknown'}`);
    lastError = said === undefined ? why : `${why}: ${said}`;
    if (!p.stopping) log(`it stopped (${lastError}).`);
    if (current !== undefined && current.phase === 'grace') {
      // SendMessage had already delivered it; only the wait for a notice was cut short.
      finish(current, { status: 'delivered' }, false);
    } else if (current !== undefined && current.phase !== 'waiting') {
      const detail = p.stopping
        ? 'The relay was restarted before it answered.'
        : p.error !== undefined
          ? `Couldn't start the relay: ${p.error}.`
          : `The relay stopped (${lastError}).`;
      finish(current, failed(detail));
    }
    settleIdle(false);
    // A relay that never started isn't started again until the next request asks for it.
    if (closed || p.error !== undefined) return;
    let delay = 0;
    if (!p.stopping) {
      quickFailures = now() - p.startedAt < HEALTHY_RUN_MS ? quickFailures + 1 : 1;
      delay = Math.min(restart.maxMs, restart.baseMs * 2 ** (quickFailures - 1));
    }
    nextStartAt = now() + delay;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (closed || proc !== undefined) return;
      const result = start();
      if (!result.ok) log(`couldn't restart it: ${result.detail}`);
      pump();
    }, delay);
  }

  function waitIdle(): Promise<boolean> {
    const p = proc;
    if (p === undefined) return Promise.resolve(false);
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
        return;
      case 'assistant':
        p.busy = true;
        for (const block of blocksOf(event)) {
          if (block.type === 'tool_use') onToolUse(block);
          else if (block.type === 'text' && typeof block.text === 'string') p.turnText += `${block.text}\n`;
        }
        return;
      case 'user':
        for (const block of blocksOf(event)) if (block.type === 'tool_result') onToolResult(block);
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
    const sessionId = event.session_id;
    if (typeof sessionId !== 'string' || !isSafeSessionId(sessionId) || sessionId === p.sessionId) return;
    p.sessionId = sessionId;
    relaySessionIds.add(sessionId);
    const cwd = typeof event.cwd === 'string' && path.isAbsolute(event.cwd) ? event.cwd : p.cwd;
    p.tail = openTranscript({ sessionId, cwd });
  }

  function onToolUse(block: Record<string, unknown>): void {
    if (block.name === 'ListAgents') return;
    const job = current;
    if (block.name !== 'SendMessage') return anomaly(`The relay used a tool it isn't allowed (${oneLine(String(block.name), 60)}).`, job);
    if (job === undefined || job.phase !== 'written') {
      return anomaly(
        job === undefined ? 'The relay sent a message nobody asked for.' : 'The relay sent more than one message for a request.',
        job,
      );
    }
    const mismatch = sendMismatch(block.input, job.target.name, job.text);
    if (mismatch !== undefined) return anomaly(`${mismatch} It may still have reached the session.`, job);
    job.phase = 'sent';
    if (typeof block.id === 'string') job.toolUseId = block.id;
  }

  function onToolResult(block: Record<string, unknown>): void {
    const job = current;
    if (job === undefined || job.phase !== 'sent') return;
    if (job.toolUseId !== undefined && block.tool_use_id !== job.toolUseId) return;
    const result = parseSendResult(block);
    if (!result.ok) return finish(job, failed(result.reason));
    if (result.msgId !== undefined) job.msgId = result.msgId;
    job.phase = 'grace';
    recordOutcome(job, 'delivered');
    // Counted in polls rather than by the clock, so the wait is the same whatever the time does.
    const polls = Math.max(1, Math.ceil(noticeGraceMs / noticePollMs));
    let polled = 0;
    const tick = async () => {
      if (job.done) return;
      await readTail();
      if (job.done) return;
      if (++polled >= polls) return finish(job, { status: 'delivered' }, false);
      job.timer = setTimeout(() => void tick(), noticePollMs);
    };
    clearTimeout(job.timer);
    void tick();
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
    settleIdle(true);
  }

  /** The relay ended a turn without acting on the request: write it once more, if it stays idle. */
  function scheduleRetry(job: Job): void {
    setTimeout(() => {
      if (job.done || job.phase !== 'written' || current !== job) return;
      const p = proc;
      if (p === undefined || p.busy) return;
      if (job.retried) return finish(job, failed("The relay didn't act on the message, so nothing was sent."));
      job.retried = true;
      write(job);
    }, retryIdleMs);
  }

  // ---------------------------------------------------------------- outcomes

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
        finish(job, { status, detail: status === 'held' ? HELD_DETAIL : status === 'refused' ? REFUSED_DETAIL : 'It expired before it was delivered.' }, false);
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
      if (queue.length >= maxQueue) {
        return Promise.resolve({ ...failed('The relay is busy with other messages. Try again in a moment.'), retryAfterSeconds: 5 });
      }
      return new Promise<RelaySendOutcome>((resolve) => {
        queue.push({
          target,
          text,
          id: newRequestId(text, options.randomId),
          resolve,
          done: false,
          phase: 'waiting',
          pid: target.pid,
          attemptedAt: now(),
          retried: false,
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
    isRelay,
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(restartTimer);
      for (const job of queue.splice(0)) finish(job, failed('pitwall is shutting down.'), false);
      if (current !== undefined) finish(current, failed('pitwall is shutting down.'), false);
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

/** What a delivery notice makes of a relayed message's status. */
const NOTICE_STATUS: Record<NoticeOutcome, RelayStatus | undefined> = {
  held: 'held',
  refused: 'refused',
  denied: 'refused',
  expired: 'failed',
  released: 'delivered',
  other: undefined,
};

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
