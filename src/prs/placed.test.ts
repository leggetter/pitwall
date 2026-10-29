// The PR list with every PR placed (placed.ts, W105), through createPrPoller({ index }), with a fake
// fetch, index and discovery: no test here runs gh or git. Every repo and path here is made up.
import { describe, expect, it } from 'vitest';
import type { Indexer } from '../index/index.js';
import type { LocalRepo, RepoDiscovery } from '../index/repos.js';
import { PRS_REFRESH_MIN_MS, type IndexSnapshot, type PullRequestList, type SessionSummary } from '../shared/protocol.js';
import { fakeClock, fakeFetch, fetched, flush, prNode } from '../test/prs.js';
import { parsePullRequest } from './parse.js';
import { knownRepos } from './placed.js';
import { createPrPoller } from './poller.js';

const HOME = '/home/someone';
const WORK = '/home/someone/work';
const OSS = '/home/someone/oss';

const pr = (repo: string, number: number) => parsePullRequest(prNode({ repo, number }))!;

const snapshot = (roots: string[], groups: IndexSnapshot['groups'] = []): IndexSnapshot => ({ generatedAt: '2026-10-29T12:00:00.000Z', roots, groups, source: { ok: true } });

function fakeIndex(initial?: IndexSnapshot) {
  let latest = initial;
  const listeners = new Set<(snapshot: IndexSnapshot) => void>();
  const index: Pick<Indexer, 'latest' | 'subscribe'> = {
    latest: () => latest,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    index,
    listeners: () => listeners.size,
    push(next: IndexSnapshot) {
      latest = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

function fakeRepos(initial: LocalRepo[] = []) {
  let repos = initial;
  const listeners = new Set<() => void>();
  const updates: { roots: readonly string[]; known: { key: string; root: string }[] }[] = [];
  let refreshes = 0;
  let stopped = false;
  const discovery: RepoDiscovery = {
    update(roots, known) {
      updates.push({ roots: [...roots], known: [...known] });
    },
    repos: () => repos,
    ready: () => true,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh() {
      refreshes++;
    },
    settled: async () => {},
    stats: () => ({ discoveries: 0, dirsRead: 0, repos: 0, withGitHub: 0, gitRuns: 0 }),
    stop() {
      stopped = true;
    },
  };
  return {
    discovery,
    updates,
    refreshes: () => refreshes,
    stopped: () => stopped,
    set(next: LocalRepo[]) {
      repos = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const appClone: LocalRepo = { key: `${WORK}/demo-app`, root: WORK, remotes: [{ name: 'origin', slug: 'example/demo-app' }] };

function start(options: { snapshot?: IndexSnapshot; repos?: LocalRepo[]; ownersByRoot?: Map<string, string[] | 'all' | 'none'> } = {}) {
  const clock = fakeClock();
  const fetch = fakeFetch();
  const index = fakeIndex(options.snapshot ?? snapshot([WORK, OSS]));
  const repos = fakeRepos(options.repos ?? [appClone]);
  const poller = createPrPoller({
    fetch: fetch.fetch,
    now: clock.now,
    monotonicNow: clock.monotonic,
    timers: clock.timers,
    index: index.index,
    repos: repos.discovery,
    home: HOME,
    ...(options.ownersByRoot === undefined ? {} : { ownersByRoot: options.ownersByRoot }),
  });
  const lists: PullRequestList[] = [];
  poller.subscribe((list) => lists.push(list));
  return { poller, clock, fetch, index, repos, lists };
}

describe('createPrPoller({ index }): every PR placed (W105)', () => {
  it("places each PR in the list, and the list's roots, as the poller's lists come", async () => {
    const { poller, fetch, lists } = start();
    poller.start();
    expect(poller.latest()).toEqual({
      source: { ok: true },
      refreshing: true,
      prs: [],
      roots: [
        { root: WORK, owners: ['example'], source: 'clones' },
        { root: OSS, owners: [], source: 'clones' },
      ],
    });
    await fetch.finish(fetched([pr('example/demo-app', 1), pr('example/other', 2), pr('stranger/x', 3)]));
    expect(poller.latest().prs.map((p) => [p.number, p.place])).toEqual([
      [1, { kind: 'cloned', root: WORK, key: `${WORK}/demo-app`, label: 'demo-app' }],
      [2, { kind: 'not-cloned', root: WORK }],
      [3, { kind: 'unclaimed' }],
    ]);
    expect(lists.at(-1)).toBe(poller.latest());
    poller.stop();
  });

  it("hands discovery the snapshot's roots and the repos it knows, on start and on each snapshot", async () => {
    const session = { workedIn: [{ key: `${OSS}/site`, label: 'site', root: OSS, calls: 3, changes: 1, lastAt: '2026-10-29T11:00:00.000Z' }] } as unknown as SessionSummary;
    const groups: IndexSnapshot['groups'] = [
      { key: `${WORK}/demo-app`, label: 'demo-app', kind: 'git', root: WORK, sessions: [session] },
      { key: WORK, label: 'work', kind: 'directory', root: WORK, sessions: [] },
    ];
    expect(knownRepos(snapshot([WORK, OSS], groups))).toEqual([
      { key: `${WORK}/demo-app`, root: WORK },
      { key: `${OSS}/site`, root: OSS },
    ]);
    const { poller, index, repos } = start({ snapshot: snapshot([WORK], groups) });
    // Nothing before start().
    expect(repos.updates).toEqual([]);
    expect(index.listeners()).toBe(0);
    poller.start();
    expect(repos.updates).toEqual([{ roots: [WORK], known: knownRepos(snapshot([WORK], groups)) }]);
    index.push(snapshot([WORK, OSS]));
    expect(repos.updates.at(-1)).toEqual({ roots: [WORK, OSS], known: [] });
    poller.stop();
    expect(repos.stopped()).toBe(true);
    expect(index.listeners()).toBe(0);
  });

  it('places again when the repos or the roots change, telling listeners only of a list that changed', async () => {
    const { poller, fetch, index, repos, lists } = start({ repos: [] });
    poller.start();
    await fetch.finish(fetched([pr('example/demo-app', 1)]));
    const told = lists.length;
    const before = poller.latest();
    expect(before.prs[0]?.place).toEqual({ kind: 'unclaimed' });
    // The same snapshot again: the same list, the same object.
    index.push(snapshot([WORK, OSS]));
    expect(lists).toHaveLength(told);
    expect(poller.latest()).toBe(before);
    // A clone found: placed under it.
    repos.set([appClone]);
    expect(lists).toHaveLength(told + 1);
    expect(poller.latest().prs[0]?.place).toMatchObject({ kind: 'cloned', key: appClone.key });
    // Repos that change nothing the list says: no new list.
    const after = poller.latest();
    repos.set([appClone, { key: `${OSS}/unrelated`, root: OSS, remotes: [{ name: 'origin', slug: 'example/unrelated' }] }]);
    expect(lists).toHaveLength(told + 1);
    expect(poller.latest()).toBe(after);
    // New roots: placed again.
    index.push(snapshot([OSS, WORK]));
    expect(lists).toHaveLength(told + 2);
    expect(poller.latest().roots?.map((r) => r.root)).toEqual([OSS, WORK]);
    poller.stop();
  });

  it('takes the config file’s owners for the roots it names (W103)', async () => {
    const { poller, fetch } = start({ ownersByRoot: new Map<string, string[] | 'all' | 'none'>([[OSS, ['example']], [WORK, 'none']]) });
    poller.start();
    await fetch.finish(fetched([pr('example/demo-app', 1), pr('example/other', 2)]));
    expect(poller.latest().roots).toEqual([
      { root: WORK, owners: 'none', source: 'config' },
      { root: OSS, owners: ['example'], source: 'config' },
    ]);
    expect(poller.latest().prs.map((p) => p.place?.kind)).toEqual(['cloned', 'not-cloned']);
    poller.stop();
  });

  it('finds the repos again when a refresh starts a fetch, not when it is refused', async () => {
    const { poller, fetch, clock, repos } = start();
    poller.start();
    expect(poller.refresh()).toEqual({ kind: 'running' });
    await fetch.finish(fetched([]));
    expect(poller.refresh()).toMatchObject({ kind: 'too-soon' });
    expect(repos.refreshes()).toBe(0);
    clock.advance(PRS_REFRESH_MIN_MS);
    expect(poller.refresh()).toEqual({ kind: 'started' });
    expect(repos.refreshes()).toBe(1);
    await flush();
    poller.stop();
  });

  it('places a list that comes from a refresh before start(), without discovery', async () => {
    const { poller, fetch, repos } = start({ repos: [] });
    expect(poller.refresh()).toEqual({ kind: 'started' });
    await fetch.finish(fetched([pr('example/demo-app', 1)]));
    // No snapshot read yet: no roots, so nothing is placed but as unclaimed.
    expect(poller.latest()).toMatchObject({ prs: [{ place: { kind: 'unclaimed' } }], roots: [] });
    expect(repos.updates).toEqual([]);
    expect(repos.refreshes()).toBe(0);
    poller.stop();
  });

  it('without an index, places nothing, as before', async () => {
    const clock = fakeClock();
    const fetch = fakeFetch();
    const poller = createPrPoller({ fetch: fetch.fetch, now: clock.now, monotonicNow: clock.monotonic, timers: clock.timers });
    poller.start();
    await fetch.finish(fetched([pr('example/demo-app', 1)]));
    expect(poller.latest().prs[0]).not.toHaveProperty('place');
    expect(poller.latest()).not.toHaveProperty('roots');
    poller.stop();
  });
});
