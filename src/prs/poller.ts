// The PR poller (M4, W93): your open pull requests, fetched at start, then PRS_POLL_INTERVAL_MS
// after each fetch ends, and on Refresh. Never tied to the session poll.
//
//   overlap      none: one fetch at a time. A refresh while one runs is ok, and changes nothing
//   refresh      starts a fetch now, unless the latest started less than PRS_REFRESH_MIN_MS ago,
//                when it says how many seconds to wait (429 and Retry-After). It pushes the next
//                poll back: that comes PRS_POLL_INTERVAL_MS after the refresh's fetch ends
//   on failure   each search on its own (W101): one that failed keeps its last good PRs, and
//                `searches` says it failed and when it last worked, while the others' are new.
//                When every one failed, the whole last list stays, with its fetchedAt, and `source`
//                says what went wrong
//   listeners    told only when the list's content changes, `refreshing` included, so every fetch
//                tells them twice: when it starts and when it ends
//   timers       injected with the clocks, for tests; the real ones don't keep the process alive.
//                The refresh gap and the fetch's deadline are measured on a monotonic clock, so
//                a change to the system clock can't open or close them; fetchedAt is wall time
//   stop()       no more fetches; a fetch still running is left to its timeout, and what it finds
//                is dropped. The server stops it on close()
//   places       with `index` (W105), every PR gets its place and the list its roots' owners
//                (placed.ts): from the repos under the snapshot's roots, found again every 5 minutes,
//                and `ownersByRoot` from the config file (W103). Without it, neither is set
//
// Never logs: a title from a private repo is as sensitive as session data.
import { runFile as realRunFile, type RunFile } from '../index/exec.js';
import type { Indexer } from '../index/index.js';
import type { RepoDiscovery } from '../index/repos.js';
import {
  PR_RELATIONS,
  PRS_POLL_INTERVAL_MS,
  PRS_REFRESH_MIN_MS,
  type PullRequestList,
  type PullRequestRelation,
  type PullRequestSearchState,
  type PullRequestSummary,
} from '../shared/protocol.js';
import { fetchPullRequests, mergeSearches, type FetchResult, type SearchResult } from './fetch.js';
import type { OwnersByRoot } from './place.js';
import { withPlaces } from './placed.js';

/** What a refresh did, for POST PRS_REFRESH_PATH. */
export type PrRefreshResult =
  | { kind: 'started' }
  /** A fetch was already running; its result is what you'll get. */
  | { kind: 'running' }
  /** Pull requests are off (`--no-prs`): 409. */
  | { kind: 'off' }
  /** The latest fetch started less than PRS_REFRESH_MIN_MS ago: 429 with Retry-After. */
  | { kind: 'too-soon'; retryAfterSeconds: number }
  /** Stopped, as the server is closing: 503. */
  | { kind: 'stopped' };

/** Your open pull requests, as the server reads them: GET PRS_PATH, the 'prs' message and Refresh. */
export interface PrSource {
  /** The latest list. A new object whenever anything in it changes, so it can be serialised once per change. */
  latest(): PullRequestList;
  /** Calls `listener` with each new list, after it changes. Returns the unsubscribe. */
  subscribe(listener: (list: PullRequestList) => void): () => void;
  refresh(): PrRefreshResult;
  /** Starts polling: a fetch now, unless one has already started. The server calls it once listening. */
  start(): void;
  /** Stops polling. The server calls it on close(). */
  stop(): void;
}

/** Timers the poller schedules with. The defaults are unref'd, so they never keep pitwall running. */
export interface PrTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PrPollerOptions {
  /** One fetch. Default fetchPullRequests() through `runFile`. */
  fetch?: () => Promise<FetchResult>;
  /** For the default fetch. Default the real runFile. */
  runFile?: RunFile;
  /** For the default fetch: the gh to run. Default `gh` on PATH. */
  ghBin?: string;
  /** Wall time, for fetchedAt. Default Date.now. */
  now?: () => number;
  /** A monotonic clock in milliseconds, for the refresh gap and the default fetch's deadline. Default performance.now(). */
  monotonicNow?: () => number;
  timers?: PrTimers;
  /** Default PRS_POLL_INTERVAL_MS. */
  intervalMs?: number;
  /** Default PRS_REFRESH_MIN_MS. */
  refreshMinMs?: number;
  /**
   * The index (M4 redesign, W105): with it, every PR gets PullRequestSummary.place and the list
   * PullRequestList.roots, from the repos under its snapshot's roots and those it knows. Without
   * it, neither is set.
   */
  index?: Pick<Indexer, 'latest' | 'subscribe'>;
  /**
   * Which GitHub owners each root claims, keyed by real-path root (RootOwners): a list, 'all' or
   * 'none', from the config file (W103). A root it names doesn't infer its owners from its clones.
   * Only with `index`.
   */
  ownersByRoot?: OwnersByRoot;
  /** For tests, with `index`: the repo discovery. Default createRepoDiscovery(). */
  repos?: RepoDiscovery;
  /** For tests, with `index`: the home directory labels shorten to `~`. Default os.homedir(). */
  home?: string;
}

const realTimers: PrTimers = {
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return timer;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** A search's result when the fetch itself failed, as an injected one can by throwing. */
const FETCH_FAILED: SearchResult = { ok: false, reason: 'error', error: "pitwall couldn't fetch your pull requests. Refresh to try again." };

/** What the list says with `--no-prs`. */
export const PRS_OFF_ERROR = 'Pull requests are off: pitwall was started with --no-prs.';

/** The list before the first fetch has finished: nothing yet, and nothing wrong. */
function initialList(): PullRequestList {
  return { source: { ok: true }, refreshing: false, prs: [] };
}

/** The PR source for `--no-prs`: always the 'off' list, and never runs gh. */
export function prsOff(): PrSource {
  const list: PullRequestList = { source: { ok: false, reason: 'off', error: PRS_OFF_ERROR }, refreshing: false, prs: [] };
  return {
    latest: () => list,
    subscribe: () => () => {},
    refresh: () => ({ kind: 'off' }),
    start: () => {},
    stop: () => {},
  };
}

/**
 * A poller of your open PRs, each placed when `index` is given (withPlaces()). Nothing runs until
 * start(), or a refresh.
 */
export function createPrPoller(options: PrPollerOptions = {}): PrSource {
  const poller = createUnplacedPoller(options);
  if (options.index === undefined) return poller;
  return withPlaces(poller, {
    index: options.index,
    ...(options.ownersByRoot === undefined ? {} : { ownersByRoot: options.ownersByRoot }),
    ...(options.repos === undefined ? {} : { repos: options.repos }),
    ...(options.home === undefined ? {} : { home: options.home }),
  });
}

/** The poller itself, without places. */
function createUnplacedPoller(options: PrPollerOptions): PrSource {
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const timers = options.timers ?? realTimers;
  const intervalMs = options.intervalMs ?? PRS_POLL_INTERVAL_MS;
  const refreshMinMs = options.refreshMinMs ?? PRS_REFRESH_MIN_MS;
  const runFile = options.runFile ?? realRunFile;
  const fetch =
    options.fetch ?? (() => fetchPullRequests({ runFile, monotonicNow, ...(options.ghBin === undefined ? {} : { ghBin: options.ghBin }) }));

  let list = initialList();
  let content = JSON.stringify(list);
  const listeners = new Set<(list: PullRequestList) => void>();
  let fetching = false;
  let stopped = false;
  /** When the latest fetch started, by monotonicNow. */
  let lastStartedAt: number | undefined;
  /** Each search's last good result, and when it was fetched, by wall time. */
  const good = new Map<PullRequestRelation, { prs: PullRequestSummary[]; truncated: boolean; fetchedAt: string }>();
  let timer: unknown;

  const update = (next: PullRequestList) => {
    const nextContent = JSON.stringify(next);
    if (nextContent === content) return;
    list = next;
    content = nextContent;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // One listener's failure, such as a socket that closed, mustn't stop the others or the poller.
      }
    }
  };

  const cancelTimer = () => {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  };

  const run = async () => {
    cancelTimer();
    fetching = true;
    lastStartedAt = monotonicNow();
    update({ ...list, refreshing: true });
    let result: Partial<FetchResult> | undefined;
    try {
      result = await fetch();
    } catch {
      // fetchPullRequests never throws; an injected fetch might.
      result = undefined;
    }
    fetching = false;
    if (stopped) return;
    const at = new Date(now()).toISOString();
    const searches: Partial<Record<PullRequestRelation, PullRequestSearchState>> = {};
    let failure: Extract<SearchResult, { ok: false }> | undefined;
    let worked = false;
    for (const relation of PR_RELATIONS) {
      const each = result?.[relation] ?? FETCH_FAILED;
      if (each.ok) {
        worked = true;
        good.set(relation, { prs: each.prs, truncated: each.truncated, fetchedAt: at });
        searches[relation] = { fetchedAt: at };
      } else {
        failure ??= each;
        const kept = good.get(relation);
        searches[relation] = { ...(kept ? { fetchedAt: kept.fetchedAt } : {}), failed: { reason: each.reason, error: each.error } };
      }
    }
    if (worked) {
      const prs = mergeSearches(Object.fromEntries([...good].map(([relation, { prs }]) => [relation, prs])));
      const next: PullRequestList = { fetchedAt: at, source: { ok: true }, refreshing: false, searches, prs };
      if ([...good.values()].some(({ truncated }) => truncated)) next.truncated = true;
      update(next);
    } else if (failure !== undefined) {
      update({ ...list, source: { ok: false, reason: failure.reason, error: failure.error }, refreshing: false, searches });
    }
    timer = timers.setTimeout(() => {
      timer = undefined;
      if (!stopped && !fetching) void run();
    }, intervalMs);
  };

  return {
    latest: () => list,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh() {
      if (stopped) return { kind: 'stopped' };
      if (fetching) return { kind: 'running' };
      if (lastStartedAt !== undefined) {
        const wait = lastStartedAt + refreshMinMs - monotonicNow();
        if (wait > 0) return { kind: 'too-soon', retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) };
      }
      void run();
      return { kind: 'started' };
    },
    start() {
      if (stopped || fetching || lastStartedAt !== undefined) return;
      void run();
    },
    stop() {
      stopped = true;
      cancelTimer();
      listeners.clear();
    },
  };
}
