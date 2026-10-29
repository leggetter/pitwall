// The recap engine (M5, W110; spike 010): a short `claude -p` call per session that says why it was
// started, where it is now, and what's next or what it's waiting on, kept in memory only.
//
// Which sessions, and when:
//
//   automatically   a listed session whose process is running (`alive`), not ended or finished, with
//                   a readable transcript, once its turn has ended (the transcript's turn mark, as
//                   W69 reads it, SessionFacts.turnEnded; Claude Code's status when the transcript
//                   has none) and it's been idle RECAP_DEBOUNCE_MS since activity newer than its
//                   last recap's `throughAt`. pitwall's own sessions (the relay, recap calls) are
//                   never listed, and sub-agents aren't sessions in the snapshot
//   on demand       refresh(), for any listed session with a transcript, ended ones included
//
// At most two calls at a time. Each session is queued at most once: on-demand requests first, then
// automatic ones, each in the order they came, and automatic ones that come together newest
// activity first. RECAP_DAILY_BUDGET calls per local day, counted when a call starts: once it's
// spent, nothing automatic runs until midnight, and refresh() answers 'spent'. A call that fails
// isn't tried again automatically for the same activity for RETRY_AFTER_FAILURE_MS, and after
// PAUSE_AFTER_FAILURES failures in a row nothing automatic runs for a while, so a broken `claude`
// can't spend the day's budget.
//
// The call is an update (the previous recap and the turns since) when there's a previous recap and
// turns since it, else a first recap (src/recaps/input.ts). Activity with no turn the input shows,
// such as a tool's result, moves the recap's `throughAt` on without a call.
//
// The call runs from one fixed 0700 directory, `$PITWALL_HOME/recap`, with recapArgs() and
// recapEnvironment() (prompt.ts), no shell and a timeout, once `claude --version` says it's at
// least MIN_RECAP_CLAUDE_VERSION. While it runs, Claude Code lists it in `claude agents --json`
// and it binds a messaging socket (spike 010, finding 1), so isOwn() leaves it out of the index, as
// isRelay() does the relay: by its directory, its name and its pid.
//
// What the snapshot shows (decorate()): each session's recap (RecapSummary), its title from the
// recap, and Needs you's 'recap' reason (protocol.ts NeedsYou) when the recap is current, says it's
// waiting on you, and no earlier reason holds; never for a working, stale or finished session.
// Before pitwall's first recap of a session, and while the day's budget is spent, Claude Code's own
// `away_summary` stands in for it (source 'claude-code'), which never sets Needs you.
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Indexer, SessionFacts } from '../index/index.js';
import { runFile } from '../index/exec.js';
import { createRecapSourceReader, type RecapSourceReader } from '../index/recapSources.js';
import { titleText } from '../index/transcripts.js';
import {
  RECAP_DAILY_BUDGET,
  RECAP_DEBOUNCE_MS,
  RECAP_FIELD_MAX,
  type IndexSnapshot,
  type NeedsYou,
  type RecapHealth,
  type RecapSummary,
  type SessionRecap,
  type SessionSummary,
} from '../shared/protocol.js';
import { pitwallHome } from '../server/launch.js';
import { checkClaudeVersion, prepareRelayDir } from '../server/relay.js';
import { runRecapCall, spawnRecapChild, type CallOutcome, type RecapSpawner } from './call.js';
import { firstRecapInput, TurnCollector, updateRecapInput } from './input.js';
import {
  ANSWER_INVALID,
  MIN_RECAP_CLAUDE_VERSION,
  parseEnvelope,
  parseRecapAnswer,
  plainField,
  RECAP_DIR_NAME,
  RECAP_NAME,
  recapArgs,
  recapEnvironment,
  type RecapAnswer,
} from './prompt.js';

/** What the engine reads from the index. */
export type RecapIndex = Pick<Indexer, 'latest' | 'subscribe' | 'conversation'>;

/** refresh()'s answer, which the route turns into a status (src/server/recapRoutes.ts). */
export type RefreshResult =
  /** Queued, or already queued: the recap arrives in the snapshot. */
  | { kind: 'queued' }
  /** pitwall has no transcript of it to read. */
  | { kind: 'no-transcript' }
  /** The day's budget is spent: Retry-After is midnight. */
  | { kind: 'spent'; retryAfterSeconds: number }
  /** A call for it is already running. */
  | { kind: 'running'; retryAfterSeconds: number }
  | { kind: 'closed' };

export interface RecapEngine {
  /** Starts scheduling from the index's snapshots. Once; the server calls it when it's listening. */
  start(index: RecapIndex): void;
  /** The index's sessionFacts hook: what it read of each session's transcript on its latest poll. */
  observe(facts: ReadonlyMap<string, SessionFacts>): void;
  /** True for a `claude agents` row that is a recap call: by pid, its name, or its directory. For the index's `exclude`. */
  isOwn(row: { name: string; cwd: string; pid?: number | undefined }): boolean;
  /** Asks for a recap of `session` now (POST recapRefreshPath()). Never throws. */
  refresh(session: SessionSummary): RefreshResult;
  /** The session's recap as GET recapPath() answers it, or undefined when there's none. */
  recap(session: SessionSummary): SessionRecap | undefined;
  /** `session` as the snapshot carries it: with its recap, its title from the recap, and Needs you's 'recap' reason. The same object when there's no recap. */
  decorate(session: SessionSummary): SessionSummary;
  /** How recaps are doing today (IndexSnapshot.recaps). */
  health(): RecapHealth;
  /** Changes whenever decorate() or health() could answer differently for the same snapshot. */
  version(): number;
  /** Called when a recap lands, a call fails or the day turns. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Stops scheduling, drops what's queued and stops running calls. Resolves within about 3 seconds. */
  close(): Promise<void>;
}

export interface RecapEngineOptions {
  /** Default 'claude'. */
  claudeBin?: string;
  /** Default RECAP_MODEL. */
  model?: string;
  /** Default `$PITWALL_HOME/recap`, or `~/.pitwall/recap`. Created 0700, and nothing is written to it. */
  dir?: string;
  /** What the call's environment is made from, before recapEnvironment(). Default process.env, read at each call. */
  env?: NodeJS.ProcessEnv;
  spawn?: RecapSpawner;
  /** What `claude --version` prints. Default: runs it. Rejects when it can't. */
  claudeVersion?: () => Promise<string>;
  /** Default createRecapSourceReader(). */
  sources?: RecapSourceReader;
  /** Creates the directory if needed, checks it's safe, and returns its realpath. Throws when it isn't safe. */
  prepareDir?: (dir: string) => string;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Default RECAP_DEBOUNCE_MS. */
  debounceMs?: number;
  /** Default RECAP_DAILY_BUDGET. */
  budget?: number;
  /** Default 2. */
  maxConcurrent?: number;
  /** How long a call may run. Default 60 seconds; spike 010's took 3 to 7. */
  timeoutMs?: number;
  /** pitwall's relay's name (RELAY_NAME): its messages are the user's own (finding 4). */
  relayName?: string;
  /** How many conversation pages a recap reads at most. Default 8. */
  maxPages?: number;
  /** Default: console.error with a `pitwall: recaps:` prefix. Never given session content. */
  log?: (message: string) => void;
  /** Frame ids, for tests. */
  randomId?: () => string;
}

/** A failed call isn't tried again automatically, for the same activity, sooner than this. */
export const RETRY_AFTER_FAILURE_MS = 30 * 60_000;
/** After this many failures in a row, automatic recaps pause. */
export const PAUSE_AFTER_FAILURES = 3;
/** The first pause, doubling with each failure after that, up to PAUSE_MAX_MS. */
export const PAUSE_BASE_MS = 5 * 60_000;
export const PAUSE_MAX_MS = 60 * 60_000;
/** How soon `claude --version` is asked again after it said too old, or couldn't be run. */
const VERSION_RETRY_MS = 10 * 60_000;

interface Job {
  sessionId: string;
  /** Asked for with refresh(). */
  demand: boolean;
}

interface Running {
  /** Set once its process has a pid. */
  pid?: number;
  done: Promise<void>;
}

/** A local day, for the budget: midnight to midnight. */
function dayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** Seconds from `ms` to the next local midnight, at least 1. */
export function secondsToMidnight(ms: number): number {
  const date = new Date(ms);
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  return Math.max(1, Math.ceil((midnight - ms) / 1000));
}

function parseMs(at: string | undefined): number {
  const ms = at === undefined ? NaN : Date.parse(at);
  return Number.isFinite(ms) ? ms : NaN;
}

/** Whether a title says nothing the name doesn't, as the index judges Claude Code's (summaries.ts). */
function sameTitle(title: string, name: string): boolean {
  const shown = titleText(title).toLowerCase();
  return shown === '' || shown === titleText(name).toLowerCase();
}

/** The session with this id in the snapshot. */
function findSession(snapshot: IndexSnapshot | undefined, sessionId: string): SessionSummary | undefined {
  for (const group of snapshot?.groups ?? []) for (const session of group.sessions) if (session.sessionId === sessionId) return session;
  return undefined;
}

/** True for a session pitwall recaps by itself: its process runs, and it hasn't ended or finished. */
export function recapsAutomatically(session: SessionSummary): boolean {
  return session.alive && session.ended !== true && !session.finished;
}

export function createRecapEngine(options: RecapEngineOptions = {}): RecapEngine {
  const claudeBin = options.claudeBin ?? 'claude';
  const dir = path.resolve(options.dir ?? path.join(pitwallHome(), RECAP_DIR_NAME));
  const spawn = options.spawn ?? spawnRecapChild;
  const claudeVersion =
    options.claudeVersion ??
    (() => runFile(claudeBin, ['--version'], { cwd: os.tmpdir(), timeoutMs: 10_000, ...(options.env === undefined ? {} : { env: options.env }) }));
  const sources = options.sources ?? createRecapSourceReader();
  const prepareDir = options.prepareDir ?? prepareRelayDir;
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? RECAP_DEBOUNCE_MS;
  const budget = options.budget ?? RECAP_DAILY_BUDGET;
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxPages = Math.max(1, options.maxPages ?? 8);
  const log = options.log ?? ((message: string) => console.error(`pitwall: recaps: ${message}`));

  let index: RecapIndex | undefined;
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  let changes = 0;
  const listeners = new Set<() => void>();
  /** pitwall's recaps, by session id: source 'pitwall', never `stale`, which is worked out when shown. */
  const recaps = new Map<string, SessionRecap>();
  /** What the index read on its latest poll. */
  let facts: ReadonlyMap<string, SessionFacts> = new Map();
  /** Sessions whose latest call failed: for what activity, and when. */
  const failures = new Map<string, { throughMs: number; atMs: number }>();
  const demandQueue: Job[] = [];
  const autoQueue: Job[] = [];
  const running = new Map<string, Running>();
  /** Calls started today: their processes have been spawned, or are about to be. */
  let day = dayKey(now());
  let calls = 0;
  let costUsd = 0;
  let lastError: string | undefined;
  let failuresInRow = 0;
  let pausedUntil = 0;
  /** Set once `claude --version` has said it's new enough; until then, when to ask again. */
  let versionOk = false;
  let versionRetryAt = 0;
  let versionError: string | undefined;
  /** Recap calls' pids while they run, and the directory's paths, for isOwn(). */
  const pids = new Set<number>();
  const dirs = new Set<string>([dir]);
  addRealpath(dir);
  let closing: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    closing = resolve;
  });

  function addRealpath(candidate: string): void {
    try {
      dirs.add(realpathSync(candidate));
    } catch {
      // Not created yet.
    }
  }

  function changed(): void {
    changes++;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        log(`a listener threw: ${(error as Error).message}`);
      }
    }
  }

  /** Starts a new day's count at local midnight. True when it did. */
  function rollDay(): boolean {
    const today = dayKey(now());
    if (today === day) return false;
    day = today;
    calls = 0;
    costUsd = 0;
    changes++;
    return true;
  }

  /** Calls started or about to start, against the budget. */
  function spent(): boolean {
    rollDay();
    return calls >= budget;
  }

  // ---------------------------------------------------------------- scheduling

  function queued(sessionId: string): Job | undefined {
    return demandQueue.find((job) => job.sessionId === sessionId) ?? autoQueue.find((job) => job.sessionId === sessionId);
  }

  /** Whether the snapshot's `session` is due an automatic recap now. */
  function due(session: SessionSummary, nowMs: number): boolean {
    if (!recapsAutomatically(session) || session.transcript !== 'ok') return false;
    const activity = parseMs(session.lastActivityAt);
    if (Number.isNaN(activity)) return false;
    const previous = recaps.get(session.sessionId);
    if (previous !== undefined && activity <= parseMs(previous.throughAt)) return false;
    const failed = failures.get(session.sessionId);
    if (failed !== undefined && failed.throughMs >= activity && nowMs - failed.atMs < RETRY_AFTER_FAILURE_MS) return false;
    if (nowMs - activity < debounceMs) return false;
    return turnOver(session);
  }

  /** The turn has ended: by the transcript's mark, or, when it has none, by Claude Code's status. */
  function turnOver(session: SessionSummary): boolean {
    const turnEnded = facts.get(session.sessionId)?.turnEnded;
    if (turnEnded !== undefined) return turnEnded;
    return session.status !== 'busy' && session.status !== 'waiting' && session.state !== 'working';
  }

  /** Working, for Needs you: the transcript says its turn runs, or, with no mark, Claude Code says it's busy. */
  function working(session: SessionSummary): boolean {
    const turnEnded = facts.get(session.sessionId)?.turnEnded;
    if (turnEnded !== undefined) return !turnEnded;
    return session.status === 'busy' || session.state === 'working';
  }

  function schedule(snapshot: IndexSnapshot): void {
    if (closed) return;
    if (rollDay()) changed();
    const listed = new Set<string>();
    for (const group of snapshot.groups) for (const session of group.sessions) listed.add(session.sessionId);
    // Only listed sessions are kept: one that comes back later gets a first recap.
    for (const map of [recaps, failures]) for (const id of map.keys()) if (!listed.has(id)) map.delete(id);
    sources.retain(new Set([...facts.values()].flatMap((each) => (each.file === undefined ? [] : [each.file]))));
    if (!snapshot.source.ok) return pump();
    const nowMs = now();
    if (!spent() && nowMs >= pausedUntil) {
      const candidates: SessionSummary[] = [];
      for (const group of snapshot.groups) {
        for (const session of group.sessions) {
          if (running.has(session.sessionId) || queued(session.sessionId) !== undefined) continue;
          if (due(session, nowMs)) candidates.push(session);
        }
      }
      candidates.sort((a, b) => parseMs(b.lastActivityAt) - parseMs(a.lastActivityAt));
      for (const session of candidates) autoQueue.push({ sessionId: session.sessionId, demand: false });
    }
    pump();
  }

  function pump(): void {
    while (!closed && running.size < maxConcurrent) {
      const job = demandQueue.shift() ?? autoQueue.shift();
      if (job === undefined) return;
      if (spent()) {
        // Nothing more today. What's queued is dropped: an on-demand request was answered while the budget lasted.
        demandQueue.length = 0;
        autoQueue.length = 0;
        return;
      }
      if (!job.demand && now() < pausedUntil) {
        autoQueue.length = 0;
        continue;
      }
      start(job);
    }
  }

  function start(job: Job): void {
    const entry: Running = { done: Promise.resolve() };
    running.set(job.sessionId, entry);
    entry.done = run(job, entry)
      .catch((error: unknown) => {
        log(`a recap failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
        fail(job.sessionId, NaN, 'pitwall hit an unexpected error while making a recap.', 'setup');
      })
      .finally(() => {
        running.delete(job.sessionId);
        if (entry.pid !== undefined) pids.delete(entry.pid);
        pump();
      });
  }

  /**
   * No recap came of a job: hold off on that session for the same activity, and say why, in
   * pitwall's words. 'call': a call that ran and failed, shown as RecapHealth's error, and counted
   * towards the pause. 'setup': pitwall couldn't make the call, which spent nothing, shown but not
   * counted. 'quiet': nothing to recap, only remembered.
   */
  function fail(sessionId: string, throughMs: number, reason: string, kind: 'call' | 'setup' | 'quiet'): void {
    if (!Number.isNaN(throughMs)) failures.set(sessionId, { throughMs, atMs: now() });
    if (kind === 'quiet') return;
    lastError = reason;
    if (kind === 'call') {
      failuresInRow++;
      if (failuresInRow >= PAUSE_AFTER_FAILURES) {
        const pause = Math.min(PAUSE_MAX_MS, PAUSE_BASE_MS * 2 ** (failuresInRow - PAUSE_AFTER_FAILURES));
        pausedUntil = now() + pause;
        log(`${failuresInRow} recap calls failed in a row, so automatic recaps pause for ${Math.round(pause / 60_000)} minutes. Last: ${reason}`);
      } else {
        log(reason);
      }
    } else {
      log(reason);
    }
    changed();
  }

  // ---------------------------------------------------------------- one recap

  async function run(job: Job, entry: Running): Promise<void> {
    const source = index;
    if (source === undefined) return;
    const session = findSession(source.latest(), job.sessionId);
    if (session === undefined) return;
    const startedActivity = parseMs(session.lastActivityAt);
    const file = facts.get(job.sessionId)?.file;
    if (file === undefined || session.transcript !== 'ok') {
      return fail(job.sessionId, startedActivity, "pitwall couldn't find this session's transcript, so it couldn't make a recap.", 'quiet');
    }

    const previous = recaps.get(job.sessionId);
    const update = previous !== undefined && !(startedActivity <= parseMs(previous.throughAt));
    const read = await sources.read(file);
    const collector = new TurnCollector({
      ...(options.relayName === undefined ? {} : { relayName: options.relayName }),
      ...(update ? { after: previous.throughAt } : {}),
    });
    await collectTurns(source, job.sessionId, collector);
    if (closed) return;
    const throughMs = Math.max(Number.isNaN(startedActivity) ? 0 : startedActivity, collector.newestMs ?? 0);

    if (update && collector.count === 0) {
      // New activity, but no turn the input would show: the recap still holds, through it.
      recaps.set(job.sessionId, { ...previous, throughAt: new Date(throughMs).toISOString() });
      return changed();
    }
    if (!update && collector.count === 0 && read.firstPrompt === undefined) {
      return fail(job.sessionId, throughMs, 'This session has nothing pitwall can recap yet.', 'quiet');
    }
    const input = update
      ? updateRecapInput({ ...(read.firstPrompt === undefined ? {} : { firstPrompt: read.firstPrompt }), previous: answerOf(previous), turns: collector.text() }, options.randomId)
      : firstRecapInput(
          {
            ...(read.firstPrompt === undefined ? {} : { firstPrompt: read.firstPrompt }),
            ...(read.awaySummary === undefined ? {} : { awaySummary: read.awaySummary }),
            ...(read.compaction === undefined ? {} : { compaction: read.compaction }),
            turns: collector.text(),
          },
          options.randomId,
        );

    let cwd: string;
    try {
      cwd = prepareDir(dir);
      dirs.add(cwd);
    } catch {
      return fail(job.sessionId, throughMs, `pitwall couldn't prepare its folder for recap calls, ${dir}.`, 'setup');
    }
    const version = await checkVersion();
    if (closed) return;
    if (version !== undefined) return fail(job.sessionId, throughMs, version, 'setup');
    if (spent()) return;

    calls++;
    changes++;
    const outcome = await runRecapCall({
      claudeBin,
      args: recapArgs(options.model === undefined ? {} : { model: options.model }),
      cwd,
      env: recapEnvironment(options.env ?? process.env),
      input,
      timeoutMs,
      spawn,
      onPid(pid) {
        entry.pid = pid;
        pids.add(pid);
      },
      stopped,
    });
    if (outcome.kind === 'stopped') return;
    const result = readOutcome(outcome);
    if (result.costUsd !== undefined) costUsd += result.costUsd;
    if (!result.ok) return fail(job.sessionId, throughMs, result.reason, 'call');
    const at = now();
    recaps.set(job.sessionId, {
      ...result.answer,
      at: new Date(at).toISOString(),
      throughAt: new Date(throughMs).toISOString(),
      source: 'pitwall',
    });
    failures.delete(job.sessionId);
    failuresInRow = 0;
    pausedUntil = 0;
    lastError = undefined;
    changed();
  }

  /** The latest turns, newest first through the conversation's pages, until the collector is done. Fails soft. */
  async function collectTurns(source: RecapIndex, sessionId: string, collector: TurnCollector): Promise<void> {
    let before: string | undefined;
    for (let page = 0; page < maxPages && !collector.done; page++) {
      let read;
      try {
        read = await source.conversation(sessionId, before);
      } catch {
        break;
      }
      if (read === undefined) break;
      for (let i = read.entries.length - 1; i >= 0; i--) if (!collector.add(read.entries[i]!)) break;
      if (read.before === undefined) break;
      before = read.before;
    }
    collector.finish();
  }

  /** Undefined when Claude Code is new enough, else why not, in pitwall's words. */
  async function checkVersion(): Promise<string | undefined> {
    if (versionOk) return undefined;
    if (now() < versionRetryAt && versionError !== undefined) return versionError;
    let output: string;
    try {
      output = await claudeVersion();
    } catch {
      versionRetryAt = now() + VERSION_RETRY_MS;
      versionError = "pitwall couldn't run claude --version, so it made no recap.";
      return versionError;
    }
    const checked = checkClaudeVersion(output, MIN_RECAP_CLAUDE_VERSION);
    if (checked.ok) {
      versionOk = true;
      versionError = undefined;
      return undefined;
    }
    versionRetryAt = now() + VERSION_RETRY_MS;
    const which = checked.version === undefined ? "pitwall couldn't read which version this is" : `this is ${checked.version}`;
    versionError = `Recaps need Claude Code ${MIN_RECAP_CLAUDE_VERSION} or later, and ${which}.`;
    return versionError;
  }

  // ---------------------------------------------------------------- what's shown

  /**
   * The recap shown for `session`, with `stale` worked out: pitwall's; or Claude Code's away_summary
   * in its place, for a session pitwall recaps by itself, before pitwall's first recap of it, or
   * while the day's budget is spent and pitwall's is out of date and older than the away_summary.
   */
  function shown(session: SessionSummary): SessionRecap | undefined {
    const ours = recaps.get(session.sessionId);
    const away = recapsAutomatically(session) ? facts.get(session.sessionId)?.awaySummary : undefined;
    const activity = parseMs(session.lastActivityAt);
    const isStale = (recap: SessionRecap) => !Number.isNaN(activity) && activity > parseMs(recap.throughAt);
    let chosen = ours;
    if (away !== undefined && (ours === undefined || (isStale(ours) && spent() && parseMs(away.at) > parseMs(ours.throughAt)))) {
      const text = plainField(away.text, RECAP_FIELD_MAX);
      if (text !== '') chosen = { why: '', now: text, next: '', waitingOn: 'nothing', title: '', at: away.at, throughAt: away.at, source: 'claude-code' };
    }
    if (chosen === undefined) return undefined;
    return isStale(chosen) ? { ...chosen, stale: true } : { ...chosen };
  }

  function summaryOf(recap: SessionRecap): RecapSummary {
    const summary: RecapSummary = { waitingOn: recap.waitingOn, title: recap.title, at: recap.at, source: recap.source };
    if (recap.waitingOn === 'you' && recap.next !== '') summary.next = recap.next;
    if (recap.stale === true) summary.stale = true;
    return summary;
  }

  /** Needs you's 'recap' reason, when it holds and no earlier reason does (NeedsYou's order). */
  function needsYouOf(session: SessionSummary, recap: SessionRecap): NeedsYou | undefined {
    if (recap.source !== 'pitwall' || recap.stale === true || recap.waitingOn !== 'you' || recap.next === '') return undefined;
    if (session.stale || session.finished || working(session)) return undefined;
    const reason = session.needsYou?.reason;
    if (reason !== undefined && reason !== 'restarted' && reason !== 'blocked') return undefined;
    return { reason: 'recap', text: recap.next };
  }

  return {
    start(given) {
      if (index !== undefined || closed) return;
      index = given;
      unsubscribe = given.subscribe((snapshot) => schedule(snapshot));
      const latest = given.latest();
      if (latest !== undefined) schedule(latest);
    },
    observe(given) {
      facts = given;
    },
    isOwn(row) {
      if (row.pid !== undefined && pids.has(row.pid)) return true;
      if (row.name === RECAP_NAME) return true;
      return dirs.has(path.resolve(row.cwd));
    },
    refresh(session) {
      if (closed) return { kind: 'closed' };
      if (session.transcript !== 'ok' || facts.get(session.sessionId)?.file === undefined) return { kind: 'no-transcript' };
      if (running.has(session.sessionId)) return { kind: 'running', retryAfterSeconds: 5 };
      if (spent()) return { kind: 'spent', retryAfterSeconds: secondsToMidnight(now()) };
      const automatic = autoQueue.findIndex((job) => job.sessionId === session.sessionId);
      if (automatic !== -1) autoQueue.splice(automatic, 1);
      if (!demandQueue.some((job) => job.sessionId === session.sessionId)) demandQueue.push({ sessionId: session.sessionId, demand: true });
      pump();
      return { kind: 'queued' };
    },
    recap(session) {
      return shown(session);
    },
    decorate(session) {
      const recap = shown(session);
      if (recap === undefined) return session;
      const decorated: SessionSummary = { ...session, recap: summaryOf(recap) };
      // pitwall's title, even while Claude Code's away_summary stands in for its recap.
      const title = recaps.get(session.sessionId)?.title;
      if (title !== undefined && !sameTitle(title, session.name)) {
        decorated.title = title;
        decorated.titleSource = 'pitwall';
      }
      const needsYou = needsYouOf(session, recap);
      if (needsYou !== undefined) decorated.needsYou = needsYou;
      return decorated;
    },
    health() {
      rollDay();
      const health: RecapHealth = { calls, budget, costUsd: Math.round(costUsd * 1e6) / 1e6 };
      if (lastError !== undefined) health.error = lastError;
      return health;
    },
    version() {
      rollDay();
      return changes;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      listeners.clear();
      demandQueue.length = 0;
      autoQueue.length = 0;
      closing?.();
      const done = [...running.values()].map((each) => each.done);
      await Promise.race([Promise.all(done), new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
    },
  };
}

/** A stored recap's answer fields, for an update's input. */
function answerOf(recap: SessionRecap): RecapAnswer {
  return { why: recap.why, now: recap.now, next: recap.next, waitingOn: recap.waitingOn, title: recap.title };
}

/** What a call's process gave: a recap, or why not, in pitwall's words, with its cost when it reported one. */
export function readOutcome(outcome: Exclude<CallOutcome, { kind: 'stopped' }>): { ok: true; answer: RecapAnswer; costUsd?: number } | { ok: false; reason: string; costUsd?: number } {
  switch (outcome.kind) {
    case 'spawn-error':
      return { ok: false, reason: outcome.notFound ? "claude wasn't found, so pitwall couldn't make a recap." : "pitwall couldn't start claude for a recap." };
    case 'timeout':
      return { ok: false, reason: "The recap call didn't finish in time, so pitwall stopped it." };
    case 'too-large':
      return { ok: false, reason: 'The recap call printed far more than a recap, so pitwall stopped it.' };
    case 'exit': {
      const envelope = parseEnvelope(outcome.stdout);
      const cost = envelope.costUsd === undefined ? {} : { costUsd: envelope.costUsd };
      if (outcome.code !== 0) {
        const how = outcome.code === null ? `was stopped by ${outcome.signal ?? 'a signal'}` : `exited with code ${outcome.code}`;
        return { ok: false, reason: `The recap call ${how}.`, ...cost };
      }
      if (!envelope.ok) return { ok: false, reason: envelope.reason, ...cost };
      const answer = parseRecapAnswer(envelope.text);
      if (answer === undefined) return { ok: false, reason: ANSWER_INVALID, ...cost };
      return { ok: true, answer, ...cost };
    }
  }
}
