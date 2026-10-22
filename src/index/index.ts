import os from 'node:os';
import {
  DEFAULT_POLL_INTERVAL_MS,
  type ConversationPage,
  type IndexSnapshot,
  type RelayAlert,
  type RelayExchange,
  type RelayOff,
  type SourceHealth,
} from '../shared/protocol.js';
import { createAgentsSource, type AgentRow, type AgentsSource } from './agents.js';
import { ConversationCursorError, readConversationPage, RelayAddressBook } from './conversation.js';
import { oneLine } from './exec.js';
import { createGroupResolver, groupLabel, type GroupResolver } from './grouping.js';
import { inspectCwd, matchRoot, resolveRoots, type Realpath } from './roots.js';
import { buildGroups, toSessionSummary, type PlacedSession } from './summaries.js';
import { createTranscriptReader, type TranscriptReader } from './transcripts.js';
import { createWorkedInScanner, type WorkedInScanner } from './workedIn.js';

export { isSafeSessionId } from './transcripts.js';
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
  stop(): void;
}

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
}

/**
 * Polls `claude agents --json --all` every `intervalMs`, keeps the sessions whose
 * cwd is under a root, groups them by repo and adds what their transcripts
 * say. The first poll starts straight away. Polls never overlap: a tick that
 * comes while one is still running is skipped. Listeners hear about every
 * completed poll, changed or not, including one whose source failed, so a
 * quiet but healthy index can be told apart from a stuck one by `generatedAt`.
 */
export function startIndexer(options: IndexerOptions): Indexer {
  const now = Date.now;
  return createIndexer(options, {
    agents: createAgentsSource(options.claudeBin === undefined ? {} : { claudeBin: options.claudeBin }),
    groups: createGroupResolver({ now }),
    transcripts: createTranscriptReader({ now }),
    workedIn: createWorkedInScanner({ now }),
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

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      let snapshot: IndexSnapshot;
      try {
        snapshot = await poll(options, deps, latest);
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
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  void tick();

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
      const file = deps.transcripts.transcriptFile(sessionId);
      if (file === undefined) return undefined;
      // The newest page is tried twice, in case the file shrank while it was read.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return (await readConversationPage(file, sessionId, before, relayBook === undefined ? {} : { relay: relayBook }))?.page;
        } catch (err) {
          if (err instanceof ConversationCursorError) throw err;
          if (before !== undefined) return undefined;
        }
      }
      return undefined;
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      listeners.clear();
      deps.workedIn?.stop();
    },
  };
}

async function poll(options: IndexerOptions, deps: IndexerDeps, previous: IndexSnapshot | undefined): Promise<IndexSnapshot> {
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

  const rows = result.rows.filter((row) => !calls(() => options.exclude?.(row), false));
  const placed = await mapLimit(rows, deps.concurrency, async (row): Promise<PlacedSession | undefined> => {
    const { path: cwd, missing } = await inspectCwd(row.cwd, deps.realpath);
    const root = matchRoot(cwd, resolvedRoots);
    if (root === undefined) return undefined;
    // A cwd that has gone fails `git -C`, so it groups as a plain directory.
    const [group, transcript] = await Promise.all([
      deps.groups.resolve(cwd),
      deps.transcripts.read(row.sessionId, [row.cwd, cwd]),
    ]);
    const summary = toSessionSummary(row, transcript, nowMs, { cwdMissing: missing });
    const relay = calls(() => options.relayExchange?.(row.sessionId), undefined);
    if (relay !== undefined) summary.relay = relay;
    return { root, group, summary };
  });

  const kept = placed.filter((p): p is PlacedSession => p !== undefined);
  deps.transcripts.retain(new Set(kept.map((p) => p.summary.sessionId)));
  deps.groups.prune();
  addWorkedIn(kept, resolvedRoots, deps);

  return { generatedAt, roots: resolvedRoots, groups: buildGroups(kept, deps.home), source: { ok: true } };
}

/**
 * Hands the scanner this poll's sessions, which queues their scans without waiting for them, and
 * adds what earlier scans found to their summaries, each repo labelled as its group is or would be,
 * with the root that group sits under or would (W42). It never moves a session: the snapshot lists
 * each only where it started (W39), and the web UI groups it by the viewer's View preferences. A
 * session seen for the first time has no workedIn until a later poll. Nothing here can fail the poll.
 */
function addWorkedIn(kept: PlacedSession[], roots: readonly string[], deps: IndexerDeps): void {
  const scanner = deps.workedIn;
  if (scanner === undefined) return;
  try {
    scanner.track(
      kept.map(({ root, group, summary }) => ({
        sessionId: summary.sessionId,
        file: deps.transcripts.transcriptFile(summary.sessionId),
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
