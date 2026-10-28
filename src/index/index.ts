import os from 'node:os';
import {
  DEFAULT_POLL_INTERVAL_MS,
  type ConversationPage,
  type IndexSnapshot,
  type RelayAlert,
  type RelayExchange,
  type RelayOff,
  type SourceHealth,
  type SubagentList,
} from '../shared/protocol.js';
import { createAgentsSource, listedSessionIds, type AgentRow, type AgentsSource } from './agents.js';
import { ConversationCursorError, readConversationPage, RelayAddressBook, type ConversationReadOptions } from './conversation.js';
import { createEndedScanner, type EndedScanner, type EndedSession } from './ended.js';
import { oneLine } from './exec.js';
import { createGroupResolver, groupLabel, type GroupResolver } from './grouping.js';
import { createJobReader, type JobNeeds, type JobReader } from './jobs.js';
import { inspectCwd, matchRoot, resolveRoots, type Realpath } from './roots.js';
import { createSubagentTracker, isSafeAgentId, type SubagentLabels, type SubagentTracker } from './subagents.js';
import { buildGroups, isFinished, restartHolds, toSessionSummary, type PlacedSession } from './summaries.js';
import { createTranscriptReader, isSafeSessionId, readNewestEntries, type TranscriptReader } from './transcripts.js';
import { createWorkedInScanner, type WorkedInScanner } from './workedIn.js';

export { isSafeSessionId } from './transcripts.js';
export { isSafeAgentId } from './subagents.js';
export { ConversationCursorError, isWellFormedCursor } from './conversation.js';
export type { AgentRow } from './agents.js';

export interface IndexerOptions {
  /** Absolute paths. The indexer resolves them with realpath. */
  roots: string[];
  /** Poll interval in milliseconds. Default `DEFAULT_POLL_INTERVAL_MS`, 5000. */
  intervalMs?: number;
  /** Path or name of the claude binary. Default 'claude'. */
  claudeBin?: string;
  /**
   * True for a `claude agents` row to leave out of every snapshot: pitwall's
   * own relay session (W11, D8), which lists as interactive. A hook that
   * throws keeps the row.
   */
  exclude?: (row: AgentRow) => boolean;
  /** The latest message relayed to a session (W11), shown as its summary's `relay`. A hook that throws adds nothing. */
  relayExchange?: (sessionId: string) => RelayExchange | undefined;
  /** The latest thing the relay tried that nobody asked for (D8), shown as the snapshot's `relayAlert`. A hook that throws adds nothing. */
  relayAlert?: () => RelayAlert | undefined;
  /** Why pitwall stopped using its relay for this run (D8), shown as the snapshot's `relayOff`. A hook that throws adds nothing. */
  relayOff?: () => RelayOff | undefined;
  /**
   * The relay's session name, RELAY_NAME (D8), passed in: a session's SendMessage calls to it show in
   * its conversation as 'to-pitwall' entries (W46). Without it, they stay tool calls.
   */
  relayName?: string;
}

export interface Indexer {
  /** The latest snapshot, or undefined before the first poll completes. */
  latest(): IndexSnapshot | undefined;
  /** Called with every new snapshot. Returns an unsubscribe function. */
  subscribe(listener: (snapshot: IndexSnapshot) => void): () => void;
  /**
   * One page of a session's conversation, read from its transcript backwards:
   * the newest page, or the one before the `before` cursor. Undefined for a
   * session not in the latest snapshot, and for one with no transcript. Reads
   * at most about 8 MiB per page. Rejects with ConversationCursorError for a
   * cursor that's malformed ('invalid') or made for another version of the
   * file ('stale'), and never for anything else.
   */
  conversation(sessionId: string, before?: string): Promise<ConversationPage | undefined>;
  /**
   * The sub-agents of a session in the latest snapshot (W76), read afresh from its `subagents`
   * folder and what's new in its transcripts: running ones first, then the newest started, at most
   * SUBAGENTS_MAX. Undefined for a session not in the latest snapshot; an empty list for one with
   * no transcript or no sub-agents. Never rejects.
   */
  subagents(sessionId: string): Promise<SubagentList | undefined>;
  /**
   * One page of a sub-agent's own transcript (W76), as conversation() reads a session's: newest
   * first, with `before` cursors, and the page's sessionId the session's. Undefined for a session
   * not in the latest snapshot, and for an agent id that isn't one of the session's sub-agents by
   * a fresh listing of its folder. A sub-agent listed only by its meta file so far has an empty
   * page. Rejects with ConversationCursorError as conversation() does, and never for anything else.
   */
  subagentConversation(sessionId: string, agentId: string, before?: string): Promise<ConversationPage | undefined>;
  /**
   * Polls again as soon as it can: now, or straight after the poll that's running. For a change
   * pitwall made itself, such as resuming an ended session, so the snapshot shows it within a poll
   * rather than up to an interval later. Never throws.
   */
  pollSoon(): void;
  /**
   * Records that you resumed the session, or confirmed a restart of it, at `atMs`, milliseconds
   * since the epoch, and polls soon. Until its transcript has a prompt newer than that, it needs you
   * with NeedsYou's 'restarted', unless it's stale or finished. Kept in memory only, so it ends when
   * pitwall does, and dropped once the session is no longer listed. An unsafe id or a time that
   * isn't finite is ignored. Never throws.
   */
  noteRestart(sessionId: string, atMs: number): void;
  /**
   * Whether a running session's turn has ended, read afresh from its transcript's newest entries
   * by W69's rule (TranscriptInfo.turnEnded), for End session's idle check (W90, spike 005):
   * 'ended', 'running', or 'unknown' when the session isn't in the latest snapshot, has no
   * transcript pitwall has found, or its newest entries record no turn's end, as from an older
   * Claude Code or a turn longer than the window read. Reads the file once, outside the poll's own
   * reads. Never rejects.
   */
  turnState(sessionId: string): Promise<TurnState>;
  /**
   * How many of a session's sub-agents are running, by a scan that starts now
   * (SubagentTracker.runningFresh()), for End session's idle check (W90). Unlike subagents(), which
   * shows an empty list when it can't read them, this is undefined when it can't say: the session
   * isn't in the latest snapshot, there's no sub-agent tracker, or the scan couldn't read what it
   * needed. End counts undefined as working. Never rejects.
   */
  runningSubagents(sessionId: string): Promise<number | undefined>;
  stop(): void;
}

/** Indexer.turnState()'s answer. */
export type TurnState = 'ended' | 'running' | 'unknown';

/** Everything the poller depends on, so tests can replace any of it. */
export interface IndexerDeps {
  agents: AgentsSource;
  groups: GroupResolver;
  transcripts: TranscriptReader;
  /** Default `fs.promises.realpath`. */
  realpath?: Realpath;
  /** Milliseconds since the epoch. */
  now: () => number;
  /** For group labels outside their root, shown with `~`. */
  home: string;
  /** How many sessions are resolved and read at the same time. */
  concurrency: number;
  /**
   * The repos each session worked in (workedIn.ts), read synchronously on every poll, which never
   * waits for a scan. Without one, no session has workedIn.
   */
  workedIn?: WorkedInScanner;
  /**
   * The interactive sessions that have ended (ended.ts), read synchronously on every poll, which
   * never waits for a scan. A scan that finds a different set makes the index poll soon. Without
   * one, none are listed.
   */
  ended?: EndedScanner;
  /**
   * What each background job's `state.json` says it needs (jobs.ts), read on every poll for the
   * background rows that haven't finished. Without one, no job's file is read, and a blocked job
   * needs you as it did before W69 (NeedsYou's 'blocked').
   */
  jobs?: JobReader;
  /**
   * Each session's sub-agents (subagents.ts, W76): their running count, read synchronously on every
   * poll, which never waits for a scan; their list and transcripts; and the labels conversation
   * pages give their entries. A scan that changes a running count makes the index poll soon.
   * Without one, no session has subagentsRunning, and every list is empty.
   */
  subagents?: SubagentTracker;
}

/**
 * Polls `claude agents --json --all` every `intervalMs`, keeps the sessions whose
 * cwd is under a root, groups them by repo and adds what their transcripts
 * say. Interactive sessions that have ended, which `claude agents` no longer
 * lists, are added from their transcripts (ended.ts). The first poll starts
 * straight away. Polls never overlap: a tick that comes while one is still
 * running is skipped, and pollSoon() runs one straight after. Listeners hear
 * about every completed poll, changed or not, including one whose source
 * failed, so a quiet but healthy index can be told apart from a stuck one by
 * `generatedAt`.
 */
export function startIndexer(options: IndexerOptions): Indexer {
  const now = Date.now;
  return createIndexer(options, {
    agents: createAgentsSource(options.claudeBin === undefined ? {} : { claudeBin: options.claudeBin }),
    groups: createGroupResolver({ now }),
    transcripts: createTranscriptReader({ now }),
    workedIn: createWorkedInScanner({ now }),
    ended: createEndedScanner({ now }),
    jobs: createJobReader(),
    subagents: createSubagentTracker({ now }),
    now,
    home: os.homedir(),
    concurrency: 8,
  });
}

/** `startIndexer` with its dependencies passed in. */
export function createIndexer(options: IndexerOptions, deps: IndexerDeps): Indexer {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const listeners = new Set<(snapshot: IndexSnapshot) => void>();
  let latest: IndexSnapshot | undefined;
  /** The session ids in `latest`: the only ones conversation() answers for. */
  let current = new Set<string>();
  /** Where the relay's messages came from, per transcript, for the conversation's 'to-pitwall' entries. */
  const relayBook = options.relayName === undefined ? undefined : new RelayAddressBook(options.relayName);
  let running = false;
  let stopped = false;
  /** pollSoon() was called while a poll ran: poll again once it's done. */
  let soon = false;
  /** Session id to when you resumed it or confirmed its restart, in this run (noteRestart). */
  const restarts = new Map<string, number>();

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      let snapshot: IndexSnapshot;
      try {
        snapshot = await poll(options, deps, latest, restarts);
      } catch (err) {
        // poll() handles every expected failure itself; this guards against bugs.
        const message = oneLine(err instanceof Error ? err.message : String(err));
        snapshot = {
          generatedAt: new Date(deps.now()).toISOString(),
          roots: latest?.roots ?? [],
          groups: latest?.groups ?? [],
          source: { ok: false, error: `index poll failed: ${message}` },
        };
      }
      if (stopped) return;
      const alert = calls(() => options.relayAlert?.(), undefined);
      if (alert !== undefined) snapshot.relayAlert = alert;
      const off = calls(() => options.relayOff?.(), undefined);
      if (off !== undefined) snapshot.relayOff = off;
      latest = snapshot;
      current = new Set(snapshot.groups.flatMap((group) => group.sessions.map((session) => session.sessionId)));
      relayBook?.retain(current);
      for (const listener of [...listeners]) {
        try {
          listener(snapshot);
        } catch (err) {
          console.error('pitwall: an index listener threw:', err);
        }
      }
    } finally {
      running = false;
      if (soon && !stopped) {
        soon = false;
        void tick();
      }
    }
  }

  function pollSoon(): void {
    if (stopped) return;
    if (running) soon = true;
    else void tick();
  }

  const timer = setInterval(() => void tick(), intervalMs);
  // A scan that found sessions newly ended, or no longer ended, shows at the next poll: make that one soon.
  const unsubscribeEnded = deps.ended?.subscribe(pollSoon);
  // Likewise a sub-agent scan that changed a session's running count.
  const unsubscribeSubagents = deps.subagents?.subscribe(pollSoon);
  void tick();

  /** The labels for a session's conversation entries (W76), or none when they can't be had. */
  async function labelsOf(sessionId: string): Promise<SubagentLabels | undefined> {
    try {
      return await deps.subagents?.labels(sessionId);
    } catch {
      return undefined;
    }
  }

  return {
    latest: () => latest,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async conversation(sessionId, before) {
      if (!current.has(sessionId)) return undefined;
      const file = transcriptFile(deps, sessionId);
      if (file === undefined) return undefined;
      const subagents = await labelsOf(sessionId);
      return readPage(file, sessionId, before, { ...(relayBook === undefined ? {} : { relay: relayBook }), ...(subagents === undefined ? {} : { subagents }) });
    },
    async subagents(sessionId) {
      if (!current.has(sessionId)) return undefined;
      const empty: SubagentList = { sessionId, subagents: [], truncated: false };
      try {
        return (await deps.subagents?.list(sessionId)) ?? empty;
      } catch {
        return empty;
      }
    },
    async subagentConversation(sessionId, agentId, before) {
      if (!current.has(sessionId) || !isSafeAgentId(agentId) || deps.subagents === undefined) return undefined;
      let found: { file?: string } | undefined;
      try {
        found = await deps.subagents.transcript(sessionId, agentId);
      } catch {
        return undefined;
      }
      if (found === undefined) return undefined;
      // Listed by its meta file, with no transcript yet: nothing to page, and no page to be before.
      if (found.file === undefined) return before === undefined ? { sessionId, entries: [] } : undefined;
      const subagents = await labelsOf(sessionId);
      return readPage(found.file, sessionId, before, { sidechain: true, noFollow: true, ...(subagents === undefined ? {} : { subagents }) });
    },
    pollSoon,
    async turnState(sessionId) {
      if (!current.has(sessionId)) return 'unknown';
      const file = deps.transcripts.transcriptFile(sessionId);
      if (file === undefined) return 'unknown';
      try {
        const turnEnded = (await readNewestEntries(file))?.info.turnEnded;
        return turnEnded === true ? 'ended' : turnEnded === false ? 'running' : 'unknown';
      } catch {
        return 'unknown';
      }
    },
    async runningSubagents(sessionId) {
      if (!current.has(sessionId) || deps.subagents === undefined) return undefined;
      try {
        return await deps.subagents.runningFresh(sessionId);
      } catch {
        return undefined;
      }
    },
    noteRestart(sessionId, atMs) {
      if (stopped || !isSafeSessionId(sessionId) || !Number.isFinite(atMs)) return;
      restarts.set(sessionId, atMs);
      pollSoon();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      listeners.clear();
      unsubscribeEnded?.();
      unsubscribeSubagents?.();
      deps.workedIn?.stop();
      deps.ended?.stop();
      deps.subagents?.stop();
    },
  };
}

/**
 * One page of a transcript, for conversation() and subagentConversation(): the newest page is tried
 * twice, in case the file shrank while it was read. Rejects only with ConversationCursorError.
 */
async function readPage(file: string, sessionId: string, before: string | undefined, options: ConversationReadOptions): Promise<ConversationPage | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return (await readConversationPage(file, sessionId, before, options))?.page;
    } catch (err) {
      if (err instanceof ConversationCursorError) throw err;
      if (before !== undefined) return undefined;
    }
  }
  return undefined;
}

/** A session's transcript: the reader's for a listed session, the ended scanner's for an ended one. */
function transcriptFile(deps: IndexerDeps, sessionId: string): string | undefined {
  return deps.transcripts.transcriptFile(sessionId) ?? deps.ended?.file(sessionId);
}

async function poll(
  options: IndexerOptions,
  deps: IndexerDeps,
  previous: IndexSnapshot | undefined,
  restarts: Map<string, number>,
): Promise<IndexSnapshot> {
  const resolvedRoots = await resolveRoots(options.roots, deps.realpath);
  const result = await deps.agents.list();
  const nowMs = deps.now();
  const generatedAt = new Date(nowMs).toISOString();

  if (!result.ok) {
    // Keep the last known sessions, flagged by the source error, rather than
    // blanking the list because one call failed.
    const source: SourceHealth = { ok: false, error: result.error };
    return { generatedAt, roots: resolvedRoots, groups: previous?.groups ?? [], source };
  }

  // Every session `claude agents --all` lists, those left out below included, and those in rows
  // parseAgentRows() skipped, such as one with an unknown kind (W81): none of them has ended.
  const listed = listedSessionIds(result);
  const rows = result.rows.filter((row) => !calls(() => options.exclude?.(row), false));
  const placed = await mapLimit(rows, deps.concurrency, async (row): Promise<PlacedSession | undefined> => {
    const { path: cwd, missing } = await inspectCwd(row.cwd, deps.realpath);
    const root = matchRoot(cwd, resolvedRoots);
    if (root === undefined) return undefined;
    // A cwd that has gone fails `git -C`, so it groups as a plain directory.
    const [group, transcript, job] = await Promise.all([
      deps.groups.resolve(cwd),
      deps.transcripts.read(row.sessionId, [row.cwd, cwd]),
      readJob(deps, row),
    ]);
    const restartedAtMs = restarts.get(row.sessionId);
    const summary = toSessionSummary(row, transcript, nowMs, {
      cwdMissing: missing,
      ...(job === undefined ? {} : { job }),
      ...(restartedAtMs === undefined ? {} : { restartedAtMs }),
    });
    // A prompt since the restart ends its wait for good, even if the transcript can't be read later.
    if (restartedAtMs !== undefined && !restartHolds(restartedAtMs, transcript)) restarts.delete(row.sessionId);
    const relay = calls(() => options.relayExchange?.(row.sessionId), undefined);
    if (relay !== undefined) summary.relay = relay;
    return { root, group, summary };
  });

  const live = placed.filter((p): p is PlacedSession => p !== undefined);
  deps.transcripts.retain(new Set(live.map((p) => p.summary.sessionId)));
  deps.jobs?.retain(new Set(rows.flatMap((row) => (row.shortId === undefined ? [] : [row.shortId]))));
  const kept = [...live, ...(await placeEnded(listed, resolvedRoots, options, deps, nowMs))];
  deps.groups.prune();
  addWorkedIn(kept, resolvedRoots, deps);
  addSubagentsRunning(kept, deps);
  // A restart is noted only for a session in the snapshot, so one no longer listed won't come back.
  const keptIds = new Set(kept.map((p) => p.summary.sessionId));
  for (const id of restarts.keys()) if (!keptIds.has(id)) restarts.delete(id);

  return { generatedAt, roots: resolvedRoots, groups: buildGroups(kept, deps.home), source: { ok: true } };
}

/**
 * The interactive sessions that have ended (ended.ts), as the last scan found them, less any this
 * poll's `claude agents --all` lists, so a session is never both. Hands the scanner this poll's
 * listing, which starts a scan without waiting for it. Each is placed as a listed session is: its
 * start directory's realpath under a root, its group, and toSessionSummary with SummaryExtras.ended,
 * kind 'interactive' and no process. Nothing here can fail the poll.
 */
async function placeEnded(
  listed: ReadonlySet<string>,
  roots: readonly string[],
  options: IndexerOptions,
  deps: IndexerDeps,
  nowMs: number,
): Promise<PlacedSession[]> {
  const scanner = deps.ended;
  if (scanner === undefined) return [];
  let sessions: EndedSession[];
  try {
    scanner.track(listed, roots);
    sessions = scanner.sessions(listed, nowMs);
  } catch {
    return [];
  }
  const placed = await mapLimit(sessions, deps.concurrency, async (ended): Promise<PlacedSession | undefined> => {
    // sessions() leaves out what `listed` names; this keeps "never both" true whatever the scanner does.
    if (listed.has(ended.sessionId)) return undefined;
    const row: AgentRow = { sessionId: ended.sessionId, name: ended.name, kind: 'interactive', cwd: ended.cwd, startedAt: ended.startedAt };
    if (calls(() => options.exclude?.(row), false)) return undefined;
    // Afresh, as for a listed session: the scan's root check may be a scan old.
    const { path: cwd, missing } = await inspectCwd(ended.cwd, deps.realpath);
    const root = matchRoot(cwd, roots);
    if (root === undefined) return undefined;
    const group = await deps.groups.resolve(cwd);
    const summary = toSessionSummary(row, ended.transcript, nowMs, { cwdMissing: missing, ended: true });
    const relay = calls(() => options.relayExchange?.(ended.sessionId), undefined);
    if (relay !== undefined) summary.relay = relay;
    return { root, group, summary };
  });
  return placed.filter((p): p is PlacedSession => p !== undefined);
}

/**
 * Hands the scanner this poll's sessions, which queues their scans without waiting for them, and
 * adds what earlier scans found to their summaries, each repo labelled as its group is or would be,
 * with the root that group sits under or would (W42). It never moves a session: the snapshot lists
 * each only where it started (W39), and the web UI groups it by the viewer's Group sessions by, in Preferences (W59). A
 * session seen for the first time has no workedIn until a later poll. Nothing here can fail the poll.
 */
function addWorkedIn(kept: PlacedSession[], roots: readonly string[], deps: IndexerDeps): void {
  const scanner = deps.workedIn;
  if (scanner === undefined) return;
  try {
    scanner.track(
      kept.map(({ root, group, summary }) => ({
        sessionId: summary.sessionId,
        file: transcriptFile(deps, summary.sessionId),
        // A session started in no repo has the root's group or a directory's, which no repo matches.
        startKey: group.kind === 'git' ? group.key : root,
      })),
      roots,
    );
    for (const { summary } of kept) {
      const repos = scanner.workedIn(summary.sessionId);
      if (repos === undefined || repos.length === 0) continue;
      // The label buildGroups would give the repo's group, and the root that group would sit under,
      // which the web UI needs to list the session under a repo with no group (W42).
      summary.workedIn = repos.map(({ key, root, calls, changes, lastAt }) => ({ key, label: groupLabel(key, root, deps.home), root, calls, changes, lastAt }));
    }
  } catch {
    // What was added stays, and the poll goes on: a scanner failure only leaves workedIn out.
  }
}

/**
 * Hands the sub-agent tracker this poll's sessions, which queues scans of the live ones without
 * waiting for them, and adds each live session's running count from earlier scans, when it's at
 * least 1 (SessionSummary.subagentsRunning). A session seen for the first time has none until its
 * first scan, which makes the index poll soon. Nothing here can fail the poll.
 */
function addSubagentsRunning(kept: PlacedSession[], deps: IndexerDeps): void {
  const tracker = deps.subagents;
  if (tracker === undefined) return;
  try {
    tracker.track(
      kept.map(({ summary }) => ({
        sessionId: summary.sessionId,
        file: transcriptFile(deps, summary.sessionId),
        alive: summary.alive,
        ...(summary.pid === undefined ? {} : { pid: summary.pid }),
        startedAt: summary.startedAt,
      })),
    );
    for (const { summary } of kept) {
      // Read for every session, so the tracker knows what the snapshot shows: 0 for one not alive.
      const running = tracker.running(summary.sessionId);
      if (summary.alive && running >= 1) summary.subagentsRunning = running;
    }
  } catch {
    // What was added stays, and the poll goes on.
  }
}

/**
 * What a background row's job file says it needs, for one that hasn't finished: a finished session
 * never needs you, so its file isn't read. Undefined with no reader, for an interactive row, and for
 * a row with no short id.
 */
async function readJob(deps: IndexerDeps, row: AgentRow): Promise<JobNeeds | undefined> {
  if (deps.jobs === undefined || row.kind !== 'background' || row.shortId === undefined) return undefined;
  if (isFinished({ kind: row.kind, alive: row.pid !== undefined, pid: row.pid, state: row.state })) return undefined;
  try {
    return await deps.jobs.read(row.shortId, row.sessionId);
  } catch {
    return { kind: 'unknown' };
  }
}

/** A hook's answer, or `fallback` when it throws or answers nothing, so one bad hook can't break a poll. */
function calls<T>(hook: () => T | undefined, fallback: T): T {
  try {
    return hook() ?? fallback;
  } catch {
    return fallback;
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
