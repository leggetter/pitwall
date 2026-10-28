// The PR poller (poller.ts): its timing and refresh limits on a fake clock, with a fake fetch, so
// nothing here runs gh or waits in real time.
import { describe, expect, it } from 'vitest';
import { PRS_POLL_INTERVAL_MS, PRS_REFRESH_MIN_MS, type PullRequestList, type PullRequestSummary } from '../shared/protocol.js';
import { fakeClock, fakeFetch, flush, prNode } from '../test/prs.js';
import type { FetchResult } from './fetch.js';
import { parsePullRequest } from './parse.js';
import { createPrPoller, prsOff, PRS_OFF_ERROR } from './poller.js';

const pr = (number: number, overrides: Record<string, unknown> = {}): PullRequestSummary => parsePullRequest(prNode({ number, ...overrides }))!;
const ok = (prs: PullRequestSummary[], truncated = false): FetchResult => ({ ok: true, prs, truncated });

function setup() {
  const clock = fakeClock();
  const fetch = fakeFetch();
  const poller = createPrPoller({ fetch: fetch.fetch, now: clock.now, timers: clock.timers });
  const seen: PullRequestList[] = [];
  poller.subscribe((list) => seen.push(list));
  return { clock, fetch, poller, seen };
}

describe('createPrPoller: timing', () => {
  it('does nothing until start(), then fetches at once', () => {
    const { fetch, poller, seen } = setup();
    expect(fetch.calls()).toBe(0);
    expect(poller.latest()).toEqual({ source: { ok: true }, refreshing: false, prs: [] });
    poller.start();
    expect(fetch.calls()).toBe(1);
    expect(poller.latest()).toEqual({ source: { ok: true }, refreshing: true, prs: [] });
    expect(seen).toHaveLength(1);
  });

  it(`fetches again ${PRS_POLL_INTERVAL_MS / 60_000} minutes after the previous fetch ends, not after it started`, async () => {
    const { clock, fetch, poller } = setup();
    poller.start();
    // The fetch takes 9 seconds.
    clock.advance(9000);
    await fetch.finish(ok([pr(1)]));
    expect(clock.pending()).toEqual([PRS_POLL_INTERVAL_MS]);
    clock.advance(PRS_POLL_INTERVAL_MS - 1);
    expect(fetch.calls()).toBe(1);
    clock.advance(1);
    expect(fetch.calls()).toBe(2);
    // Nothing else is scheduled while it runs.
    expect(clock.pending()).toEqual([]);
    clock.advance(PRS_POLL_INTERVAL_MS * 3);
    expect(fetch.calls()).toBe(2);
    await fetch.finish(ok([pr(1)]));
    expect(clock.pending()).toEqual([PRS_POLL_INTERVAL_MS]);
  });

  it('never runs two fetches at once', async () => {
    const { clock, fetch, poller } = setup();
    poller.start();
    poller.start();
    clock.advance(PRS_REFRESH_MIN_MS * 4);
    expect(poller.refresh()).toEqual({ kind: 'running' });
    expect(fetch.running()).toBe(1);
    await fetch.finish(ok([]));
    expect(fetch.running()).toBe(0);
  });

  it('keeps polling after a failure', async () => {
    const { clock, fetch, poller } = setup();
    poller.start();
    await fetch.finish({ ok: false, reason: 'error', error: 'pitwall-test failure' });
    clock.advance(PRS_POLL_INTERVAL_MS);
    expect(fetch.calls()).toBe(2);
  });

  it('treats a fetch that throws as a failed one, and keeps polling', async () => {
    const clock = fakeClock();
    let calls = 0;
    const poller = createPrPoller({
      fetch: async () => {
        calls += 1;
        throw new Error('pitwall-test boom');
      },
      now: clock.now,
      timers: clock.timers,
    });
    poller.start();
    await flush();
    expect(poller.latest()).toMatchObject({ refreshing: false, source: { ok: false, reason: 'error' } });
    expect(JSON.stringify(poller.latest())).not.toContain('pitwall-test boom');
    clock.advance(PRS_POLL_INTERVAL_MS);
    expect(calls).toBe(2);
  });

  it('stops cleanly: no timer left, no fetch after, and a fetch still running is dropped', async () => {
    const { clock, fetch, poller, seen } = setup();
    poller.start();
    await fetch.finish(ok([pr(1)]));
    clock.advance(PRS_POLL_INTERVAL_MS);
    expect(fetch.calls()).toBe(2);
    const before = poller.latest();
    const told = seen.length;
    poller.stop();
    await fetch.finish(ok([pr(1), pr(2)]));
    expect(poller.latest()).toBe(before);
    expect(seen).toHaveLength(told);
    expect(clock.pending()).toEqual([]);
    clock.advance(PRS_POLL_INTERVAL_MS * 10);
    expect(fetch.calls()).toBe(2);
    expect(poller.refresh()).toEqual({ kind: 'stopped' });
    poller.start();
    expect(fetch.calls()).toBe(2);
  });

  it('stops before it ever started without fetching', () => {
    const { fetch, poller } = setup();
    poller.stop();
    poller.start();
    expect(fetch.calls()).toBe(0);
  });

  it("uses unref'd real timers by default, so it never keeps pitwall running", async () => {
    let resolveFetch: ((result: FetchResult) => void) | undefined;
    const poller = createPrPoller({ fetch: () => new Promise((resolve) => (resolveFetch = resolve)), intervalMs: 60_000 });
    poller.start();
    const handles = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
    resolveFetch?.(ok([]));
    await flush();
    // The next poll's timer exists, and doesn't count as keeping the event loop alive.
    expect(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length).toBe(handles);
    poller.stop();
  });
});

describe('createPrPoller: refresh', () => {
  it('starts a fetch when none has run yet', () => {
    const { fetch, poller } = setup();
    expect(poller.refresh()).toEqual({ kind: 'started' });
    expect(fetch.calls()).toBe(1);
    // start() after it doesn't fetch twice.
    poller.start();
    expect(fetch.calls()).toBe(1);
  });

  it('is ok while a fetch runs, and starts nothing', () => {
    const { fetch, poller } = setup();
    poller.start();
    expect(poller.refresh()).toEqual({ kind: 'running' });
    expect(fetch.calls()).toBe(1);
  });

  it(`refuses within ${PRS_REFRESH_MIN_MS / 1000} s of the latest fetch's start, with the seconds to wait`, async () => {
    const { clock, fetch, poller } = setup();
    poller.start();
    clock.advance(3000);
    await fetch.finish(ok([]));
    // 3 s after it started.
    expect(poller.refresh()).toEqual({ kind: 'too-soon', retryAfterSeconds: 12 });
    clock.advance(11_500);
    expect(poller.refresh()).toEqual({ kind: 'too-soon', retryAfterSeconds: 1 });
    clock.advance(499);
    expect(poller.refresh()).toEqual({ kind: 'too-soon', retryAfterSeconds: 1 });
    expect(fetch.calls()).toBe(1);
    clock.advance(1);
    expect(poller.refresh()).toEqual({ kind: 'started' });
    expect(fetch.calls()).toBe(2);
  });

  it('rounds the wait up: just after a start, the whole 15 seconds', async () => {
    const { clock, fetch, poller } = setup();
    poller.start();
    clock.advance(1);
    await fetch.finish(ok([]));
    expect(poller.refresh()).toEqual({ kind: 'too-soon', retryAfterSeconds: 15 });
  });

  it('pushes the next scheduled poll back to an interval after its own fetch ends', async () => {
    const { clock, fetch, poller } = setup();
    poller.start();
    await fetch.finish(ok([]));
    clock.advance(60_000);
    expect(clock.pending()).toEqual([PRS_POLL_INTERVAL_MS - 60_000]);
    expect(poller.refresh()).toEqual({ kind: 'started' });
    // The old poll is gone while the refresh runs.
    expect(clock.pending()).toEqual([]);
    clock.advance(5000);
    await fetch.finish(ok([]));
    expect(clock.pending()).toEqual([PRS_POLL_INTERVAL_MS]);
    clock.advance(PRS_POLL_INTERVAL_MS - 60_000);
    expect(fetch.calls()).toBe(2);
    clock.advance(60_000);
    expect(fetch.calls()).toBe(3);
  });
});

describe('createPrPoller: the list', () => {
  it('sets fetchedAt by the clock when a fetch ends, and refreshing while it runs', async () => {
    const { clock, fetch, poller } = setup();
    poller.start();
    clock.advance(8500);
    await fetch.finish(ok([pr(1)]));
    expect(poller.latest()).toEqual({ fetchedAt: '2026-10-28T12:00:08.500Z', source: { ok: true }, refreshing: false, prs: [pr(1)] });
    clock.advance(PRS_POLL_INTERVAL_MS);
    expect(poller.latest()).toEqual({ fetchedAt: '2026-10-28T12:00:08.500Z', source: { ok: true }, refreshing: true, prs: [pr(1)] });
  });

  it('marks a truncated list, and drops the mark when the next one is whole', async () => {
    const { clock, fetch, poller } = setup();
    poller.start();
    await fetch.finish(ok([pr(1)], true));
    expect(poller.latest().truncated).toBe(true);
    clock.advance(PRS_POLL_INTERVAL_MS);
    await fetch.finish(ok([pr(1)]));
    expect(poller.latest()).not.toHaveProperty('truncated');
  });

  it('keeps the last good list and its fetchedAt after a failure, with source saying why, then recovers', async () => {
    const { clock, fetch, poller } = setup();
    poller.start();
    await fetch.finish(ok([pr(1), pr(2)], true));
    const good = poller.latest();
    clock.advance(PRS_POLL_INTERVAL_MS);
    await fetch.finish({ ok: false, reason: 'gh-auth', error: "gh isn't logged in to github.com. Run gh auth login, then Refresh." });
    expect(poller.latest()).toEqual({
      fetchedAt: good.fetchedAt,
      source: { ok: false, reason: 'gh-auth', error: "gh isn't logged in to github.com. Run gh auth login, then Refresh." },
      refreshing: false,
      prs: good.prs,
      truncated: true,
    });
    clock.advance(PRS_POLL_INTERVAL_MS);
    await fetch.finish(ok([pr(3)]));
    expect(poller.latest()).toMatchObject({ source: { ok: true }, prs: [pr(3)] });
  });

  it('fails before any fetch worked with an empty list and no fetchedAt', async () => {
    const { fetch, poller } = setup();
    poller.start();
    await fetch.finish({ ok: false, reason: 'gh-missing', error: 'pitwall-test missing' });
    expect(poller.latest()).toEqual({ source: { ok: false, reason: 'gh-missing', error: 'pitwall-test missing' }, refreshing: false, prs: [] });
  });

  it('tells listeners only when the content changes: refreshing on and off, a new fetchedAt, a new source', async () => {
    const { clock, fetch, poller, seen } = setup();
    poller.start();
    expect(seen.map((list) => list.refreshing)).toEqual([true]);
    await fetch.finish(ok([pr(1)]));
    expect(seen).toHaveLength(2);
    // Refresh while nothing runs: a change. Refresh while it runs: none.
    clock.advance(PRS_REFRESH_MIN_MS);
    poller.refresh();
    poller.refresh();
    expect(seen).toHaveLength(3);
    // The same failure twice in a row still turns refreshing off each time, and nothing more.
    const failure: FetchResult = { ok: false, reason: 'error', error: 'pitwall-test failure' };
    await fetch.finish(failure);
    expect(seen).toHaveLength(4);
    clock.advance(PRS_POLL_INTERVAL_MS);
    await fetch.finish(failure);
    expect(seen).toHaveLength(6);
    expect(seen.at(-1)).toBe(poller.latest());
    // Each change is a new object; an unchanged list stays the same one.
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('keeps telling the other listeners when one throws, and stops telling one that unsubscribed', async () => {
    const { fetch, poller } = setup();
    const told: string[] = [];
    poller.subscribe(() => {
      throw new Error('pitwall-test listener');
    });
    const off = poller.subscribe(() => told.push('b'));
    poller.start();
    expect(told).toEqual(['b']);
    off();
    await fetch.finish(ok([]));
    expect(told).toEqual(['b']);
  });
});

describe('prsOff', () => {
  it("is the 'off' list, refuses refresh, and never fetches", () => {
    const off = prsOff();
    expect(off.latest()).toEqual({ source: { ok: false, reason: 'off', error: PRS_OFF_ERROR }, refreshing: false, prs: [] });
    expect(PRS_OFF_ERROR).toBe('Pull requests are off: pitwall was started with --no-prs.');
    off.start();
    expect(off.refresh()).toEqual({ kind: 'off' });
    const unsubscribe = off.subscribe(() => {
      throw new Error('never called');
    });
    unsubscribe();
    off.stop();
    expect(off.latest().source).toMatchObject({ reason: 'off' });
  });
});
