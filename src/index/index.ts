import os from 'node:os';
import type { IndexSnapshot, SourceHealth } from '../shared/protocol.js';
import { createAgentsSource, type AgentsSource } from './agents.js';
import { oneLine } from './exec.js';
import { createGroupResolver, type GroupResolver } from './grouping.js';
import { matchRoot, resolveCwd, resolveRoots, type Realpath } from './roots.js';
import { buildGroups, toSessionSummary, type PlacedSession } from './summaries.js';
import { createTranscriptReader, type TranscriptReader } from './transcripts.js';

export interface IndexerOptions {
  /** Absolute paths. The indexer resolves them with realpath. */
  roots: string[];
  /** Poll interval in milliseconds. Default 2000. */
  intervalMs?: number;
  /** Path or name of the claude binary. Default 'claude'. */
  claudeBin?: string;
}

export interface Indexer {
  /** The latest snapshot, or undefined before the first poll completes. */
  latest(): IndexSnapshot | undefined;
  /** Called with every new snapshot. Returns an unsubscribe function. */
  subscribe(listener: (snapshot: IndexSnapshot) => void): () => void;
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
}

/**
 * Polls `claude agents --json` every `intervalMs`, keeps the sessions whose
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
    now,
    home: os.homedir(),
    concurrency: 8,
  });
}

/** `startIndexer` with its dependencies passed in. */
export function createIndexer(options: IndexerOptions, deps: IndexerDeps): Indexer {
  const intervalMs = options.intervalMs ?? 2000;
  const listeners = new Set<(snapshot: IndexSnapshot) => void>();
  let latest: IndexSnapshot | undefined;
  let running = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      let snapshot: IndexSnapshot;
      try {
        snapshot = await poll(options.roots, deps, latest);
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
      latest = snapshot;
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
    stop() {
      stopped = true;
      clearInterval(timer);
      listeners.clear();
    },
  };
}

async function poll(
  roots: readonly string[],
  deps: IndexerDeps,
  previous: IndexSnapshot | undefined,
): Promise<IndexSnapshot> {
  const resolvedRoots = await resolveRoots(roots, deps.realpath);
  const result = await deps.agents.list();
  const nowMs = deps.now();
  const generatedAt = new Date(nowMs).toISOString();

  if (!result.ok) {
    // Keep the last known sessions, flagged by the source error, rather than
    // blanking the list because one call failed.
    const source: SourceHealth = { ok: false, error: result.error };
    return { generatedAt, roots: resolvedRoots, groups: previous?.groups ?? [], source };
  }

  const placed = await mapLimit(result.rows, deps.concurrency, async (row): Promise<PlacedSession | undefined> => {
    const cwd = await resolveCwd(row.cwd, deps.realpath);
    const root = matchRoot(cwd, resolvedRoots);
    if (root === undefined) return undefined;
    const [group, transcript] = await Promise.all([
      deps.groups.resolve(cwd),
      deps.transcripts.read(row.sessionId, [row.cwd, cwd]),
    ]);
    return { root, group, summary: toSessionSummary(row, transcript, nowMs) };
  });

  const kept = placed.filter((p): p is PlacedSession => p !== undefined);
  deps.transcripts.retain(new Set(kept.map((p) => p.summary.sessionId)));
  deps.groups.prune();

  return { generatedAt, roots: resolvedRoots, groups: buildGroups(kept, deps.home), source: { ok: true } };
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
