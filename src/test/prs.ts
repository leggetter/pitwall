// Made-up search results, shaped as `gh api graphql` prints them for fetch.ts's query, for the PR
// source's tests. Every repo, title, branch, login and team here is invented: example/demo-app and
// its friends.
// In src/test/, so not built.
import type { FetchResult } from '../prs/fetch.js';
import type { PrTimers } from '../prs/poller.js';

/** One PullRequest node as GitHub returns it. Override any field; `null` stands for GitHub's null. */
export function prNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const repo = (overrides.repo as string | undefined) ?? 'example/demo-app';
  const number = (overrides.number as number | undefined) ?? 1;
  const { repo: _repo, checks, ...rest } = overrides;
  return {
    url: `https://github.com/${repo}/pull/${number}`,
    number,
    title: 'Add a demo feature',
    isDraft: false,
    createdAt: '2026-10-01T09:00:00Z',
    updatedAt: '2026-10-20T09:00:00Z',
    headRefName: 'feature/demo',
    headRepository: { nameWithOwner: repo },
    repository: { nameWithOwner: repo },
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    commits: { nodes: [{ commit: { statusCheckRollup: checks === undefined ? null : checks } }] },
    ...rest,
  };
}

/** A statusCheckRollup with the given state and contexts. */
export function rollup(state: string, contexts: unknown[] = []): Record<string, unknown> {
  return { state, contexts: { nodes: contexts } };
}

export const checkRun = (name: unknown, conclusion: string | null, status = 'COMPLETED'): Record<string, unknown> => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
});

export const statusContext = (context: unknown, state: string): Record<string, unknown> => ({
  __typename: 'StatusContext',
  context,
  state,
});

/** One search's page, as it sits under its alias in the answer. */
export interface PageOptions {
  total?: number;
  hasNextPage?: boolean;
  endCursor?: string | null;
}

/** The login the made-up answers give for the viewer: never a real one. */
export const VIEWER = 'pitwall-test-viewer';

function page(nodes: unknown[], options: PageOptions = {}): Record<string, unknown> {
  return {
    issueCount: options.total ?? nodes.length,
    pageInfo: { hasNextPage: options.hasNextPage ?? false, endCursor: options.endCursor ?? null },
    nodes,
  };
}

/**
 * One call's answer, as JSON text (W101): each search under its alias, `authored`,
 * `reviewRequested` and `mentioned`, with none found for any not given, and the viewer's login, or
 * with `null`, no viewer.
 */
export function searchResponse(
  searches: Partial<Record<'authored' | 'reviewRequested' | 'mentioned', { nodes: unknown[] } & PageOptions>>,
  viewer: unknown = VIEWER,
): string {
  const data: Record<string, unknown> = { viewer: viewer === null ? null : { login: viewer } };
  for (const alias of ['authored', 'reviewRequested', 'mentioned'] as const) {
    const search = searches[alias];
    data[alias] = page(search?.nodes ?? [], search);
  }
  return JSON.stringify({ data });
}

/** One call's answer with `nodes` as the author search's page, and none found for the other two. */
export function searchPage(nodes: unknown[], options: PageOptions = {}): string {
  return searchResponse({ authored: { nodes, ...options } });
}

/** A PR's review requests, as the review-requested search asks for them: each a User's login or a Team's `org/slug`. */
export function reviewRequests(...reviewers: ({ user: unknown } | { team: unknown } | Record<string, unknown>)[]): Record<string, unknown> {
  return {
    nodes: reviewers.map((reviewer) =>
      'user' in reviewer
        ? { requestedReviewer: { __typename: 'User', login: reviewer.user } }
        : 'team' in reviewer
          ? { requestedReviewer: { __typename: 'Team', combinedSlug: reviewer.team } }
          : { requestedReviewer: reviewer },
    ),
  };
}

// ---------------------------------------------------------------- the poller's clock and fetch

/** A clock and timers that move only when the test says. */
export function fakeClock(start = Date.UTC(2026, 9, 28, 12, 0, 0)) {
  // The monotonic clock, which advance() moves and the timers run on. Wall time is it plus an
  // offset that only jumpWall() changes, as when the system clock is set.
  let now = start;
  let wallOffset = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: PrTimers = {
    setTimeout(callback, ms) {
      const id = nextId++;
      pending.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    /** Wall time, for fetchedAt. */
    now: () => now + wallOffset,
    /** Monotonic time, for the refresh gap and the fetch's deadline. */
    monotonic: () => now,
    /** Sets the wall clock on or back by `ms`, leaving monotonic time and the timers alone. */
    jumpWall(ms: number) {
      wallOffset += ms;
    },
    timers,
    pending: () => [...pending.values()].map((timer) => timer.at - now),
    /** Moves the clock on, running each timer that comes due, in order. */
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    },
  };
}

/** A fetch the test finishes by hand. */
export function fakeFetch() {
  const waiting: ((result: FetchResult) => void)[] = [];
  let calls = 0;
  return {
    fetch: () => {
      calls += 1;
      return new Promise<FetchResult>((resolve) => waiting.push(resolve));
    },
    calls: () => calls,
    running: () => waiting.length,
    /** Finishes the oldest fetch, and lets the poller see it. */
    async finish(result: FetchResult) {
      const resolve = waiting.shift();
      if (resolve === undefined) throw new Error('no fetch is running');
      resolve(result);
      await flush();
    },
  };
}

export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
