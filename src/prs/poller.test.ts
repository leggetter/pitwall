// The PR poller (poller.ts): its timing and refresh limits on a fake clock, with a fake fetch, so
// nothing here runs gh or waits in real time.
import { describe, expect, it, vi } from 'vitest';
import { PRS_POLL_INTERVAL_MS, PRS_REFRESH_MIN_MS, type PullRequestList, type PullRequestSummary } from '../shared/protocol.js';
import { fakeClock, fakeFetch, fetched, fetchFailed, flush, prNode, searchPage } from '../test/prs.js';
import { FETCH_ERRORS, PRS_SEARCHES, type FetchResult } from './fetch.js';
import { parsePullRequest } from './parse.js';
import { createPrPoller, prsOff, PRS_OFF_ERROR } from './poller.js';

const pr = (number: number, overrides: Record<string, unknown> = {}): PullRequestSummary => parsePullRequest(prNode({ number, ...overrides }))!;
const ok = (prs: PullRequestSummary[], truncated = false): FetchResult => fetched(prs, truncated);
/** Each search's state after a fetch in which every one worked, at `at`. */
const allWorked = (at: string) => ({ authored: { fetchedAt: at }, 'review-requested': { fetchedAt: at }, mentioned: { fetchedAt: at } });

function setup() {
  const clock = fakeClock();
  const fetch = fakeFetch();
  const poller = createPrPoller({ fetch: fetch.fetch, now: clock.now, monotonicNow: clock.monotonic, timers: clock.timers });
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
    await fetch.finish(fetchFailed('error', 'pitwall-test failure'));
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
    expect(poller.refresh()).toEqual({ kind: 'too-soon', retryAfterSeconds: PRS_REFRESH_MIN_MS / 1000 - 3 });
    clock.advance(PRS_REFRESH_MIN_MS - 3500);
    expect(poller.refresh()).toEqual({ kind: 'too-soon', retryAfterSeconds: 1 });
    clock.advance(499);
    expect(poller.refresh()).toEqual({ kind: 'too-soon', retryAfterSeconds: 1 });
    expect(fetch.calls()).toBe(1);
    clock.advance(1);
    expect(poller.refresh()).toEqual({ kind: 'started' });
    expect(fetch.calls()).toBe(2);
  });

  it('measures the gap on the monotonic clock, so setting the system clock neither opens nor closes it', async () => {
    const { clock, fetch, poller } = setup();
    poller.start();
    await fetch.finish(ok([]));
    // An hour on: on wall time alone, the gap would be long past.
    clock.jumpWall(60 * 60_000);
    expect(poller.refresh()).toEqual({ kind: 'too-soon', retryAfterSeconds: PRS_REFRESH_MIN_MS / 1000 });
    // An hour back: on wall time alone, it would be an hour away.
    clock.jumpWall(-2 * 60 * 60_000);
    clock.advance(PRS_REFRESH_MIN_MS);
    expect(poller.refresh()).toEqual({ kind: 'started' });
    expect(fetch.calls()).toBe(2);
  });

  it('rounds the wait up: just after a start, the whole minute', async () => {
    const { clock, fetch, poller } = setup();
    poller.start();
    clock.advance(1);
    await fetch.finish(ok([]));
    expect(poller.refresh()).toEqual({ kind: 'too-soon', retryAfterSeconds: 60 });
  });

  it('keeps Refresh to one fetch a minute (W100)', () => {
    expect(PRS_REFRESH_MIN_MS).toBe(60_000);
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
  it('sets fetchedAt by wall time, wherever the system clock was set', async () => {
    const { clock, fetch, poller } = setup();
    poller.start();
    clock.jumpWall(-24 * 60 * 60_000);
    await fetch.finish(ok([]));
    expect(poller.latest().fetchedAt).toBe('2026-10-27T12:00:00.000Z');
  });

  it('sets fetchedAt by the clock when a fetch ends, and refreshing while it runs', async () => {
    const { clock, fetch, poller } = setup();
    poller.start();
    clock.advance(8500);
    await fetch.finish(ok([pr(1)]));
    const searches = allWorked('2026-10-28T12:00:08.500Z');
    expect(poller.latest()).toEqual({ fetchedAt: '2026-10-28T12:00:08.500Z', source: { ok: true }, refreshing: false, searches, prs: [pr(1)] });
    clock.advance(PRS_POLL_INTERVAL_MS);
    expect(poller.latest()).toEqual({ fetchedAt: '2026-10-28T12:00:08.500Z', source: { ok: true }, refreshing: true, searches, prs: [pr(1)] });
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
    const auth = "gh isn't logged in to github.com. Run gh auth login, then Refresh.";
    await fetch.finish(fetchFailed('gh-auth', auth));
    const failed = { fetchedAt: good.fetchedAt, failed: { reason: 'gh-auth', error: auth } };
    expect(poller.latest()).toEqual({
      fetchedAt: good.fetchedAt,
      source: { ok: false, reason: 'gh-auth', error: auth },
      refreshing: false,
      searches: { authored: failed, 'review-requested': failed, mentioned: failed },
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
    await fetch.finish(fetchFailed('gh-missing', 'pitwall-test missing'));
    const failed = { failed: { reason: 'gh-missing', error: 'pitwall-test missing' } };
    expect(poller.latest()).toEqual({
      source: { ok: false, reason: 'gh-missing', error: 'pitwall-test missing' },
      refreshing: false,
      searches: { authored: failed, 'review-requested': failed, mentioned: failed },
      prs: [],
    });
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
    const failure: FetchResult = fetchFailed('error', 'pitwall-test failure');
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

describe('createPrPoller: each search on its own (W101)', () => {
  const failure = (error: string) => ({ ok: false as const, reason: 'error' as const, error });

  it('keeps a failed search’s last good PRs, marked with when they’re from, and takes the others’ new ones', async () => {
    const { clock, fetch, poller } = setup();
    poller.start();
    const mine = pr(1);
    const askedPr = { ...pr(2), relation: 'review-requested' as const, reviewRequest: { via: 'direct' as const } };
    const mention = { ...pr(3), relation: 'mentioned' as const };
    await fetch.finish(ok([mine, askedPr, mention]));
    const first = poller.latest().fetchedAt!;
    clock.advance(PRS_POLL_INTERVAL_MS);
    const mineNow = pr(4);
    await fetch.finish({ authored: { ok: true, prs: [mineNow], truncated: false }, 'review-requested': failure('pitwall-test slow'), mentioned: { ok: true, prs: [], truncated: false } });
    const latest = poller.latest();
    expect(latest.source).toEqual({ ok: true });
    expect(latest.fetchedAt).not.toBe(first);
    // Yours are new, the mention has gone, and the review request is the last good one: updated at the same time, so by URL.
    expect(latest.prs.map((each) => [each.number, each.relation])).toEqual([
      [2, 'review-requested'],
      [4, 'authored'],
    ]);
    expect(latest.searches).toEqual({
      authored: { fetchedAt: latest.fetchedAt },
      'review-requested': { fetchedAt: first, failed: { reason: 'error', error: 'pitwall-test slow' } },
      mentioned: { fetchedAt: latest.fetchedAt },
    });
    // Once it works again, it's new too, and nothing is marked.
    clock.advance(PRS_POLL_INTERVAL_MS);
    await fetch.finish(ok([mineNow]));
    expect(poller.latest().prs.map((each) => each.number)).toEqual([4]);
    expect(Object.values(poller.latest().searches ?? {}).some((each) => each.failed !== undefined)).toBe(false);
  });

  it('marks a search that has never worked as failed with no fetchedAt, and lists the others', async () => {
    const { fetch, poller } = setup();
    poller.start();
    await fetch.finish({ authored: { ok: true, prs: [pr(1)], truncated: false }, 'review-requested': { ok: true, prs: [], truncated: false }, mentioned: failure('pitwall-test failed') });
    expect(poller.latest()).toMatchObject({ source: { ok: true }, prs: [pr(1)] });
    expect(poller.latest().searches?.mentioned).toEqual({ failed: { reason: 'error', error: 'pitwall-test failed' } });
  });

  it('dedupes across the searches as their results merge: yours first, then review requested, then mentioned', async () => {
    const { fetch, poller } = setup();
    poller.start();
    const both = pr(5);
    await fetch.finish({
      authored: { ok: true, prs: [], truncated: false },
      'review-requested': { ok: true, prs: [{ ...both, relation: 'review-requested' }], truncated: false },
      mentioned: { ok: true, prs: [{ ...both, relation: 'mentioned' }], truncated: false },
    });
    expect(poller.latest().prs.map((each) => each.relation)).toEqual(['review-requested']);
  });

  it('treats a fetch that throws, or a search missing from its result, as failed', async () => {
    const clock = fakeClock();
    const results: (() => Promise<FetchResult>)[] = [
      async () => ({ authored: { ok: true, prs: [pr(1)], truncated: false } }) as unknown as FetchResult,
      async () => {
        throw new Error('pitwall-test boom');
      },
    ];
    const poller = createPrPoller({ fetch: () => results.shift()!(), now: clock.now, monotonicNow: clock.monotonic, timers: clock.timers });
    poller.start();
    await flush();
    expect(poller.latest()).toMatchObject({ source: { ok: true }, prs: [pr(1)] });
    expect(poller.latest().searches?.mentioned?.failed?.reason).toBe('error');
    clock.advance(PRS_POLL_INTERVAL_MS);
    await flush();
    expect(poller.latest()).toMatchObject({ source: { ok: false, reason: 'error' }, prs: [pr(1)] });
    expect(JSON.stringify(poller.latest())).not.toContain('pitwall-test boom');
    poller.stop();
  });
});

describe('createPrPoller: with the real fetch and a fake runFile', () => {
  it('keeps a search’s last good PRs when every PR in its next answer is dropped, as after a change in its shape, and the others go on', async () => {
    const clock = fakeClock();
    const authored = [searchPage([prNode({ number: 1 }), prNode({ number: 2 })]), searchPage([{ changed: true }, { changed: true }])];
    const poller = createPrPoller({
      runFile: async (_file, args) => (args.includes(`q=${PRS_SEARCHES.authored}`) ? (authored.shift() ?? '') : searchPage([])),
      now: clock.now,
      monotonicNow: clock.monotonic,
      timers: clock.timers,
    });
    poller.start();
    // The real fetch makes gh's directory on disk first (W108), so it takes more than a turn of the loop.
    await vi.waitFor(() => expect(poller.latest().prs.map((each) => each.number)).toEqual([1, 2]));
    const good = poller.latest();
    clock.advance(PRS_POLL_INTERVAL_MS);
    await vi.waitFor(() => expect(poller.latest().searches?.authored?.failed).toBeDefined());
    const latest = poller.latest();
    expect(latest.source).toEqual({ ok: true });
    expect(latest.prs).toEqual(good.prs);
    expect(latest.searches?.authored).toEqual({ fetchedAt: good.fetchedAt, failed: { reason: 'error', error: FETCH_ERRORS.unreadable } });
    poller.stop();
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
