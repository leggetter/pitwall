// Made-up search results, shaped as `gh api graphql` prints them for fetch.ts's query, for the PR
// source's tests. Every repo, title and branch here is invented: example/demo-app and its friends.
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

/** One page of the search, as JSON text. */
export function searchPage(
  nodes: unknown[],
  options: { total?: number; hasNextPage?: boolean; endCursor?: string | null } = {},
): string {
  return JSON.stringify({
    data: {
      search: {
        issueCount: options.total ?? nodes.length,
        pageInfo: { hasNextPage: options.hasNextPage ?? false, endCursor: options.endCursor ?? null },
        nodes,
      },
    },
  });
}

// ---------------------------------------------------------------- the poller's clock and fetch

/** A clock and timers that move only when the test says. */
export function fakeClock(start = Date.UTC(2026, 9, 28, 12, 0, 0)) {
  let now = start;
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
    now: () => now,
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
