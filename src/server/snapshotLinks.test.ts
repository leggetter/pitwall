// The snapshot clients get (snapshotLinks.ts, D14, W105's review): each session's PR links cut to
// those that match a PR in the list. Every session, repo and PR here is made up.
import { describe, expect, it } from 'vitest';
import { parsePullRequest } from '../prs/parse.js';
import type { IndexSnapshot, PrLink, PullRequestList, SessionSummary } from '../shared/protocol.js';
import { prNode } from '../test/prs.js';
import { createSnapshotView, withOpenPrLinks } from './snapshotLinks.js';

const AT = '2026-10-29T12:00:00.000Z';
const link = (kind: PrLink['kind'], repo: string, numberOrBranch: number | string): PrLink =>
  typeof numberOrBranch === 'string' ? { kind, repo, branch: numberOrBranch, lastAt: AT } : { kind, repo, number: numberOrBranch, lastAt: AT };

const session = (id: string, prLinks?: PrLink[]) => ({ sessionId: id, ...(prLinks === undefined ? {} : { prLinks }) }) as unknown as SessionSummary;

const snapshot = (sessions: SessionSummary[], generatedAt = AT): IndexSnapshot => ({
  generatedAt,
  roots: ['/home/someone/work'],
  groups: [
    { key: '/home/someone/work/demo-app', label: 'demo-app', kind: 'git', root: '/home/someone/work', sessions },
    { key: '/home/someone/work/other', label: 'other', kind: 'git', root: '/home/someone/work', sessions: [session('s-none')] },
  ],
  source: { ok: true },
});

const list = (...prs: [string, number, string?][]): PullRequestList => ({
  source: { ok: true },
  refreshing: false,
  prs: prs.map(([repo, number, branch]) => parsePullRequest(prNode({ repo, number, headRefName: branch ?? 'feature/demo' }))!),
});

describe('withOpenPrLinks', () => {
  it("keeps a session's links that match a PR in the list, by repo and number, or a push by the PR's head", () => {
    const links = [
      link('opened', 'example/demo-app', 1),
      link('linked', 'example/demo-app', 2),
      link('mentioned', 'example/demo-app', 1),
      link('pushed', 'example/demo-app', 'feature/one'),
      link('pushed', 'example/demo-app', 'feature/closed'),
      link('prompted', 'example/other', 1),
    ];
    const given = snapshot([session('s-1', links), session('s-2', [link('opened', 'example/closed', 9)])]);
    const view = withOpenPrLinks(given, list(['example/demo-app', 1, 'feature/one']));
    expect(view.groups[0]?.sessions.map((s) => s.prLinks)).toEqual([[links[0], links[2], links[3]], undefined]);
    expect(view.groups[0]?.sessions[1]).not.toHaveProperty('prLinks');
    // The rest is shared, and the index's snapshot is left as it was.
    expect(view.groups[1]).toBe(given.groups[1]);
    expect(given.groups[0]?.sessions[0]?.prLinks).toHaveLength(6);
  });

  it('is the same snapshot when no session has a link, and cuts every link without a PR list', () => {
    const none = snapshot([session('s-1')]);
    expect(withOpenPrLinks(none, list(['example/demo-app', 1]))).toBe(none);
    const off: PullRequestList = { source: { ok: false, reason: 'off', error: 'off' }, refreshing: false, prs: [] };
    expect(withOpenPrLinks(snapshot([session('s-1', [link('opened', 'example/demo-app', 1)])]), off).groups[0]?.sessions[0]).not.toHaveProperty('prLinks');
  });
});

function fakeSources(first: IndexSnapshot, prs: PullRequestList) {
  let latest = first;
  let current = prs;
  const indexListeners = new Set<(snapshot: IndexSnapshot) => void>();
  const prListeners = new Set<(list: PullRequestList) => void>();
  return {
    indexer: { latest: () => latest, subscribe: (l: (snapshot: IndexSnapshot) => void) => (indexListeners.add(l), () => indexListeners.delete(l)) },
    prs: { latest: () => current, subscribe: (l: (list: PullRequestList) => void) => (prListeners.add(l), () => prListeners.delete(l)) },
    poll(next: IndexSnapshot) {
      latest = next;
      for (const l of [...indexListeners]) l(next);
    },
    fetched(next: PullRequestList) {
      current = next;
      for (const l of [...prListeners]) l(next);
    },
    listeners: () => indexListeners.size + prListeners.size,
  };
}

describe('createSnapshotView', () => {
  const links = [link('opened', 'example/demo-app', 1), link('opened', 'example/demo-app', 2)];

  it('passes on every poll, cut, and keeps one object for the same snapshot and list', () => {
    const sources = fakeSources(snapshot([session('s-1', links)]), list(['example/demo-app', 1]));
    const view = createSnapshotView(sources.indexer, sources.prs);
    const told: IndexSnapshot[] = [];
    view.subscribe((s) => told.push(s));
    expect(view.latest()?.groups[0]?.sessions[0]?.prLinks).toEqual([links[0]]);
    expect(view.latest()).toBe(view.latest());
    sources.poll(snapshot([session('s-1', links)], '2026-10-29T12:00:05.000Z'));
    sources.poll(snapshot([session('s-1', links)], '2026-10-29T12:00:10.000Z'));
    expect(told).toHaveLength(2);
    expect(told[1]?.groups[0]?.sessions[0]?.prLinks).toEqual([links[0]]);
    view.stop();
    expect(sources.listeners()).toBe(0);
  });

  it('starts each listener from the snapshot it read, so a list that changes nothing tells it nothing', () => {
    const sources = fakeSources(snapshot([session('s-1', links)]), list(['example/demo-app', 1]));
    const view = createSnapshotView(sources.indexer, sources.prs);
    const told: IndexSnapshot[] = [];
    view.subscribe((s) => told.push(s));
    sources.fetched({ ...list(['example/demo-app', 1]), refreshing: true });
    expect(told).toEqual([]);
    sources.fetched(list(['example/demo-app', 2]));
    expect(told.map((s) => s.groups[0]?.sessions[0]?.prLinks)).toEqual([[links[1]]]);
    view.stop();
  });

  it('passes the snapshot on again when a new PR list changes the links it carries, and only then', () => {
    const sources = fakeSources(snapshot([session('s-1', links)]), list(['example/demo-app', 1]));
    const view = createSnapshotView(sources.indexer, sources.prs);
    const told: IndexSnapshot[] = [];
    view.subscribe((s) => told.push(s));
    sources.poll(snapshot([session('s-1', links)]));
    expect(told).toHaveLength(1);
    // The same PRs, refreshed: nothing new to send.
    sources.fetched({ ...list(['example/demo-app', 1]), refreshing: true });
    expect(told).toHaveLength(1);
    // #2 opened: the snapshot again, with its link, which the index kept.
    sources.fetched(list(['example/demo-app', 1], ['example/demo-app', 2]));
    expect(told).toHaveLength(2);
    expect(told[1]?.groups[0]?.sessions[0]?.prLinks).toEqual(links);
    // Both closed: again, with none.
    sources.fetched(list());
    expect(told).toHaveLength(3);
    expect(told[2]?.groups[0]?.sessions[0]).not.toHaveProperty('prLinks');
    view.stop();
  });

  it('is undefined before the first snapshot, and a PR list then tells nobody', () => {
    const sources = fakeSources(undefined as unknown as IndexSnapshot, list());
    const view = createSnapshotView(sources.indexer, sources.prs);
    const told: IndexSnapshot[] = [];
    view.subscribe((s) => told.push(s));
    expect(view.latest()).toBeUndefined();
    sources.fetched(list(['example/demo-app', 1]));
    expect(told).toEqual([]);
    // Each listener subscribes on its own, and goes with stop().
    expect(sources.listeners()).toBe(2);
    view.subscribe(() => {});
    expect(sources.listeners()).toBe(4);
    view.stop();
    expect(sources.listeners()).toBe(0);
  });
});
