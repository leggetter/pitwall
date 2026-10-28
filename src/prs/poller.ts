// The PR poller (M4, W93): your open pull requests, fetched at start, then PRS_POLL_INTERVAL_MS
// after each fetch ends, and on Refresh. Never tied to the session poll.
//
//   overlap      none: one fetch at a time. A refresh while one runs is ok, and changes nothing
//   refresh      starts a fetch now, unless the latest started less than PRS_REFRESH_MIN_MS ago,
//                when it says how many seconds to wait (429 and Retry-After). It pushes the next
//                poll back: that comes PRS_POLL_INTERVAL_MS after the refresh's fetch ends
//   on failure   the last good list stays, with its fetchedAt; `source` says what went wrong
//   listeners    told only when the list's content changes, `refreshing` included, so every fetch
//                tells them twice: when it starts and when it ends
//   timers       injected with the clock, for tests; the real ones don't keep the process alive
//   stop()       no more fetches; a fetch still running is left to its timeout, and what it finds
//                is dropped. The server stops it on close()
//
// Never logs: a title from a private repo is as sensitive as session data.
import { runFile as realRunFile, type RunFile } from '../index/exec.js';
import { PRS_POLL_INTERVAL_MS, PRS_REFRESH_MIN_MS, type PullRequestList } from '../shared/protocol.js';
import { fetchPullRequests, type FetchResult } from './fetch.js';

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
  /** Default Date.now. */
  now?: () => number;
  timers?: PrTimers;
  /** Default PRS_POLL_INTERVAL_MS. */
  intervalMs?: number;
  /** Default PRS_REFRESH_MIN_MS. */
  refreshMinMs?: number;
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

/** A poller of your open PRs. Nothing runs until start(), or a refresh. */
export function createPrPoller(options: PrPollerOptions = {}): PrSource {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? realTimers;
  const intervalMs = options.intervalMs ?? PRS_POLL_INTERVAL_MS;
  const refreshMinMs = options.refreshMinMs ?? PRS_REFRESH_MIN_MS;
  const runFile = options.runFile ?? realRunFile;
  const fetch =
    options.fetch ?? (() => fetchPullRequests({ runFile, now, ...(options.ghBin === undefined ? {} : { ghBin: options.ghBin }) }));

  let list = initialList();
  let content = JSON.stringify(list);
  const listeners = new Set<(list: PullRequestList) => void>();
  let fetching = false;
  let stopped = false;
  /** When the latest fetch started, by `now`. */
  let lastStartedAt: number | undefined;
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
    lastStartedAt = now();
    update({ ...list, refreshing: true });
    let result: FetchResult;
    try {
      result = await fetch();
    } catch {
      // fetchPullRequests never throws; an injected fetch might.
      result = { ok: false, reason: 'error', error: "pitwall couldn't fetch your pull requests. Refresh to try again." };
    }
    fetching = false;
    if (stopped) return;
    if (result.ok) {
      const next: PullRequestList = { fetchedAt: new Date(now()).toISOString(), source: { ok: true }, refreshing: false, prs: result.prs };
      if (result.truncated) next.truncated = true;
      update(next);
    } else {
      update({ ...list, source: { ok: false, reason: result.reason, error: result.error }, refreshing: false });
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
        const wait = lastStartedAt + refreshMinMs - now();
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
