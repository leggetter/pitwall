// The snapshot with recaps (snapshotRecaps.ts, M5, W110): each session as the engine decorates it,
// Needs you first again where a recap added it, the snapshot's `recaps`, the snapshot sent again
// when a recap lands, and W105's view composed on top. Every session here is made up.
import { describe, expect, it } from 'vitest';
import type { RecapEngine } from '../recaps/engine.js';
import type { IndexSnapshot, PullRequestList, RecapHealth, SessionSummary } from '../shared/protocol.js';
import { createSnapshotView } from './snapshotLinks.js';
import { createRecapView, withRecaps } from './snapshotRecaps.js';

const AT = '2026-10-29T12:00:00.000Z';
const session = (id: string, minutesAgo: number, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    sessionId: id,
    name: `pitwall-test-${id}`,
    kind: 'interactive',
    cwd: `/made-up/work/${id}`,
    alive: true,
    startedAt: AT,
    stale: false,
    finished: false,
    transcript: 'ok',
    lastActivityAt: new Date(Date.parse(AT) - minutesAgo * 60_000).toISOString(),
    ...extra,
  }) as SessionSummary;

const snapshot = (sessions: SessionSummary[]): IndexSnapshot => ({
  generatedAt: AT,
  roots: ['/made-up/work'],
  groups: [{ key: '/made-up/work/repo', label: 'repo', kind: 'git', root: '/made-up/work', sessions }],
  source: { ok: true },
});

/** An engine whose recaps the test sets: each waiting on you puts its session in Needs you. */
function fakeEngine() {
  const waiting = new Set<string>();
  let version = 0;
  const listeners = new Set<() => void>();
  const health: RecapHealth = { calls: 0, budget: 200, costUsd: 0 };
  const engine: Pick<RecapEngine, 'decorate' | 'health' | 'version' | 'subscribe'> = {
    decorate(s) {
      if (!waiting.has(s.sessionId)) return s;
      return { ...s, title: 'From the recap', titleSource: 'pitwall', recap: { waitingOn: 'you', title: 'From the recap', next: 'Answer it.', at: AT, source: 'pitwall' }, needsYou: { reason: 'recap', text: 'Answer it.' } };
    },
    health: () => ({ ...health }),
    version: () => version,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    engine,
    health,
    land(id: string) {
      waiting.add(id);
      health.calls += 1;
      version += 1;
      for (const listener of [...listeners]) listener();
    },
    nothingNew() {
      version += 1;
      for (const listener of [...listeners]) listener();
    },
    listeners: () => listeners.size,
  };
}

function fakeIndex(first: IndexSnapshot) {
  let latest = first;
  const listeners = new Set<(s: IndexSnapshot) => void>();
  return {
    latest: () => latest,
    subscribe: (listener: (s: IndexSnapshot) => void) => (listeners.add(listener), () => listeners.delete(listener)),
    poll(next: IndexSnapshot) {
      latest = next;
      for (const listener of [...listeners]) listener(next);
    },
    listeners: () => listeners.size,
  };
}

describe('withRecaps', () => {
  it('decorates each session, lifts one a recap put in Needs you to the top of its group, and adds the health', () => {
    const fake = fakeEngine();
    fake.land('older');
    const given = snapshot([session('newer', 1), session('older', 30)]);
    const view = withRecaps(given, fake.engine);
    expect(view.groups[0]?.sessions.map((s) => s.sessionId)).toEqual(['older', 'newer']);
    expect(view.groups[0]?.sessions[0]).toMatchObject({ title: 'From the recap', titleSource: 'pitwall', needsYou: { reason: 'recap' } });
    expect(view.recaps).toEqual({ calls: 1, budget: 200, costUsd: 0 });
    // The index's snapshot is left as it was.
    expect(given.groups[0]?.sessions.map((s) => s.sessionId)).toEqual(['newer', 'older']);
    expect(given).not.toHaveProperty('recaps');
  });
});

describe('createRecapView', () => {
  it('passes every poll on, and sends the snapshot again when a recap lands and changes it, never when it doesn’t', () => {
    const fake = fakeEngine();
    const index = fakeIndex(snapshot([session('a', 10)]));
    const view = createRecapView(index, fake.engine);
    expect(view.latest()).toBe(view.latest());
    const got: IndexSnapshot[] = [];
    const off = view.subscribe((s) => got.push(s));
    index.poll(snapshot([session('a', 10)]));
    expect(got).toHaveLength(1);
    fake.land('a');
    expect(got).toHaveLength(2);
    expect(got[1]?.groups[0]?.sessions[0]?.recap?.source).toBe('pitwall');
    expect(got[1]?.recaps?.calls).toBe(1);
    fake.nothingNew();
    expect(got).toHaveLength(2);
    off();
    expect(index.listeners()).toBe(0);
    expect(fake.listeners()).toBe(0);
  });

  it("composes under W105's view: the recap, and the links cut to open PRs, on both reads and pushes", () => {
    const fake = fakeEngine();
    const index = fakeIndex(snapshot([session('a', 10, { prLinks: [{ kind: 'opened', repo: 'example/demo-app', number: 9, lastAt: AT }] })]));
    const list: PullRequestList = { source: { ok: false, reason: 'off', error: 'off' }, refreshing: false, prs: [] };
    const prs = { latest: () => list, subscribe: () => () => undefined };
    const view = createSnapshotView(createRecapView(index, fake.engine), prs);
    const got: IndexSnapshot[] = [];
    view.subscribe((s) => got.push(s));
    fake.land('a');
    for (const s of [view.latest()!, got.at(-1)!]) {
      expect(s.groups[0]?.sessions[0]?.recap?.waitingOn).toBe('you');
      expect(s.groups[0]?.sessions[0]).not.toHaveProperty('prLinks');
      expect(s.recaps).toBeDefined();
    }
    view.stop();
    expect(fake.listeners()).toBe(0);
  });
});
