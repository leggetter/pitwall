// Not for me (W188): the store, its file read as untrusted, the merge before each write, its bounds,
// the PR list's decoration and the routes, on a bare Hono app. The routes through the real server
// and its /api/* checks are in prs.test.ts. Made-up PRs only.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrSource } from '../prs/poller.js';
import {
  PR_DISMISS_PATH,
  PR_DISMISSAL_ENDED_SHOWN_MS,
  PR_UNDISMISS_PATH,
  prNeedsAttention,
  type PrDismissResult,
  type PullRequestList,
  type PullRequestSummary,
} from '../shared/protocol.js';
import {
  isPrDismissalKey,
  PR_DISMISS_BODY_MAX_BYTES,
  PR_DISMISSAL_FILE_MAX_BYTES,
  PR_DISMISSAL_FILE_NAME,
  PR_DISMISSAL_MAX_AGE_MS,
  PR_DISMISSALS_HELD_MAX,
  PrDismissalStore,
  readPrDismissalFile,
  registerPrDismissals,
  validatePrDismissRequest,
  withDismissals,
} from './prDismissals.js';

const START = Date.parse('2026-11-11T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const HASH_A = '0123456789abcdef';
const HASH_B = 'fedcba9876543210';
const KEY = 'example/demo-app#7';

function pr(number = 7, overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    url: `https://github.com/example/demo-app/pull/${number}`,
    repo: 'example/demo-app',
    repoLabel: 'example/demo-app',
    number,
    title: 'Add a demo feature',
    draft: false,
    createdAt: '2026-11-01T09:00:00Z',
    updatedAt: '2026-11-10T09:00:00Z',
    checks: 'passing',
    mergeable: 'clean',
    relation: 'review-requested',
    reviewRequest: { via: 'direct' },
    stateHash: HASH_A,
    ...overrides,
  };
}

/** A list from a fetch in which every search worked: complete, so an unlisted PR has closed. */
function listOf(prs: PullRequestSummary[], complete = true): PullRequestList {
  const search = { fetchedAt: '2026-11-11T09:59:00.000Z' };
  return {
    fetchedAt: '2026-11-11T09:59:00.000Z',
    source: { ok: true },
    refreshing: false,
    prs,
    searches: complete ? { authored: search, 'review-requested': search, mentioned: search } : { authored: search, 'review-requested': { ...search, failed: { reason: 'error', error: 'x' } }, mentioned: search },
  };
}

function clock(start = START) {
  let now = start;
  return { now: () => new Date(now), advance: (ms: number) => (now += ms) };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pitwall-test-pr-dismissals-'));
  chmodSync(home, 0o700);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const file = () => join(home, PR_DISMISSAL_FILE_NAME);
const dismissedOf = (list: PullRequestList, number = 7) => list.prs.find((each) => each.number === number)?.dismissed;

describe('PrDismissalStore', () => {
  it('decorates a PR dismissed in the state it’s in, which then needs you nowhere', () => {
    const time = clock();
    const store = new PrDismissalStore({ home, now: time.now });
    expect(prNeedsAttention(pr())).toBe(true);
    expect(store.dismiss(KEY, HASH_A)).toEqual({ at: '2026-11-11T10:00:00.000Z' });
    const list = store.decorate(listOf([pr(), pr(8)]));
    expect(dismissedOf(list)).toEqual({ at: '2026-11-11T10:00:00.000Z' });
    expect(prNeedsAttention(list.prs[0]!)).toBe(false);
    expect(dismissedOf(list, 8)).toBeUndefined();
    expect(prNeedsAttention(list.prs[1]!)).toBe(true);
  });

  it('keeps it through refreshes with nothing new, and ends it, saying so, when the state changes', () => {
    const time = clock();
    const store = new PrDismissalStore({ home, now: time.now });
    store.dismiss(KEY, HASH_A);
    for (let i = 0; i < 3; i++) {
      time.advance(3 * 60 * 1000);
      expect(dismissedOf(store.decorate(listOf([pr(7, { updatedAt: `2026-11-11T1${i}:00:00Z` })])))).toBeDefined();
    }
    time.advance(HOUR);
    const back = store.decorate(listOf([pr(7, { stateHash: HASH_B })]));
    expect(back.prs[0]!.dismissed).toBeUndefined();
    expect(back.prs[0]!.dismissalEnded).toEqual({ at: new Date(time.now()).toISOString() });
    expect(prNeedsAttention(back.prs[0]!)).toBe(true);
    expect(store.get(KEY)).toBeUndefined();
    // The old state again doesn't hide it: the dismissal is gone, not paused.
    expect(store.decorate(listOf([pr()])).prs[0]!.dismissed).toBeUndefined();
    time.advance(PR_DISMISSAL_ENDED_SHOWN_MS);
    expect(store.decorate(listOf([pr()])).prs[0]!.dismissalEnded).toBeUndefined();
  });

  it('keeps a dismissal whose PR has no stateHash this time, unapplied and saying nothing, and applies it again once it has (W188’s review)', () => {
    const store = new PrDismissalStore({ home, now: clock().now });
    store.dismiss(KEY, HASH_A);
    const { stateHash: _gone, ...unhashed } = pr();
    const blind = store.decorate(listOf([unhashed])).prs[0]!;
    expect(blind.dismissed).toBeUndefined();
    expect(blind.dismissalEnded).toBeUndefined();
    expect(store.get(KEY)).toBeDefined();
    expect(dismissedOf(store.decorate(listOf([pr()])))).toBeDefined();
  });

  it('holds through CI pending, on a re-run or a push, and red again on the same head; ends when a new head goes red (W188’s review)', () => {
    const RED_X = '1111111111111111';
    const RED_Y = '2222222222222222';
    const store = new PrDismissalStore({ home, now: clock().now });
    const own = (red?: string) => pr(7, { relation: 'authored', checks: red === undefined ? 'pending' : 'failing', ...(red === undefined ? {} : { redHash: red }) });
    store.dismiss(KEY, HASH_A, RED_X);
    expect(dismissedOf(store.decorate(listOf([own()])))).toBeDefined();
    expect(dismissedOf(store.decorate(listOf([own(RED_X)])))).toBeDefined();
    const back = store.decorate(listOf([own(RED_Y)])).prs[0]!;
    expect(back.dismissed).toBeUndefined();
    expect(back.dismissalEnded).toBeDefined();
    // Dismissed while it wasn't red: CI going red at all brings it back.
    store.dismiss(KEY, HASH_A);
    expect(dismissedOf(store.decorate(listOf([own()])))).toBeDefined();
    expect(store.decorate(listOf([own(RED_X)])).prs[0]!.dismissalEnded).toBeDefined();
  });

  it('keeps a dismissal whose PR a list that isn’t complete leaves out, and drops it once a complete one does', () => {
    const store = new PrDismissalStore({ home, now: clock().now });
    store.dismiss(KEY, HASH_A);
    store.decorate(listOf([pr(8)], false));
    store.decorate({ source: { ok: true }, refreshing: true, prs: [] });
    store.decorate({ fetchedAt: '2026-11-11T09:59:00.000Z', source: { ok: true }, refreshing: false, prs: [], truncated: true, searches: listOf([]).searches! });
    expect(store.get(KEY)).toBeDefined();
    store.decorate(listOf([pr(8)]));
    expect(store.get(KEY)).toBeUndefined();
    expect(JSON.parse(readFileSync(file(), 'utf8')).dismissals).toEqual([]);
  });

  it('drops a dismissal after PR_DISMISSAL_MAX_AGE_MS, whatever its PR', () => {
    const time = clock();
    const store = new PrDismissalStore({ home, now: time.now });
    store.dismiss(KEY, HASH_A);
    time.advance(PR_DISMISSAL_MAX_AGE_MS - 1);
    expect(dismissedOf(store.decorate(listOf([pr()])))).toBeDefined();
    time.advance(1);
    expect(dismissedOf(store.decorate(listOf([pr()])))).toBeUndefined();
    // And at start, from the file.
    const again = new PrDismissalStore({ home, now: clock(START - PR_DISMISSAL_MAX_AGE_MS - 1000).now });
    again.dismiss(KEY, HASH_A);
    expect(new PrDismissalStore({ home, now: clock().now }).get(KEY)).toBeUndefined();
  });

  it('holds at most PR_DISMISSALS_HELD_MAX, the oldest going first', () => {
    const time = clock();
    const store = new PrDismissalStore({ home, now: time.now });
    for (let n = 1; n <= PR_DISMISSALS_HELD_MAX + 2; n++) {
      store.dismiss(`example/demo-app#${n}`, HASH_A);
      time.advance(1000);
    }
    expect(store.size()).toBe(PR_DISMISSALS_HELD_MAX);
    expect(store.get('example/demo-app#1')).toBeUndefined();
    expect(store.get('example/demo-app#2')).toBeUndefined();
    expect(store.get('example/demo-app#3')).toBeDefined();
    const stored = JSON.parse(readFileSync(file(), 'utf8')) as { dismissals: unknown[] };
    expect(stored.dismissals).toHaveLength(PR_DISMISSALS_HELD_MAX);
    expect(statSync(file()).size).toBeLessThan(PR_DISMISSAL_FILE_MAX_BYTES);
  });

  it('takes a dismissal off, and an end still shown', () => {
    const store = new PrDismissalStore({ home, now: clock().now });
    store.dismiss(KEY, HASH_A);
    expect(store.undismiss(KEY)).toBe(true);
    expect(dismissedOf(store.decorate(listOf([pr()])))).toBeUndefined();
    expect(store.undismiss(KEY)).toBe(false);
    store.dismiss(KEY, HASH_A);
    store.decorate(listOf([pr(7, { stateHash: HASH_B })]));
    expect(store.undismiss(KEY)).toBe(true);
    expect(store.decorate(listOf([pr(7, { stateHash: HASH_B })])).prs[0]!.dismissalEnded).toBeUndefined();
  });
});

describe('its file', () => {
  it('is 0600, written whole by rename, with keys, times and hashes only, and read back after a restart', () => {
    const store = new PrDismissalStore({ home, now: clock().now });
    store.dismiss(KEY, HASH_A);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    const text = readFileSync(file(), 'utf8');
    expect(JSON.parse(text)).toEqual({ v: 1, dismissals: [{ key: KEY, at: '2026-11-11T10:00:00.000Z', hash: HASH_A }], ended: [], removed: [] });
    expect(text).not.toContain('demo feature');
    const again = new PrDismissalStore({ home, now: clock().now });
    expect(dismissedOf(again.decorate(listOf([pr()])))).toEqual({ at: '2026-11-11T10:00:00.000Z' });
  });

  it('is read only when it’s a regular file of this user’s, not a link or a FIFO, not writable by group or others, within the cap', () => {
    const body = JSON.stringify({ v: 1, dismissals: [{ key: KEY, at: '2026-11-11T09:00:00.000Z', hash: HASH_A }], ended: [] });
    writeFileSync(file(), body, { mode: 0o600 });
    expect(readPrDismissalFile(file(), new Date(START)).dismissals).toHaveLength(1);
    chmodSync(file(), 0o620);
    expect(readPrDismissalFile(file(), new Date(START)).dismissals).toEqual([]);
    chmodSync(file(), 0o602);
    expect(readPrDismissalFile(file(), new Date(START)).dismissals).toEqual([]);
    chmodSync(file(), 0o600);
    const link = join(home, 'link.json');
    symlinkSync(file(), link);
    expect(readPrDismissalFile(link, new Date(START)).dismissals).toEqual([]);
    const fifo = join(home, 'fifo.json');
    execFileSync('mkfifo', [fifo]);
    // O_NONBLOCK: a FIFO with no writer doesn't hang the read, and isn't a regular file.
    expect(readPrDismissalFile(fifo, new Date(START)).dismissals).toEqual([]);
    const folder = join(home, 'folder.json');
    mkdirSync(folder);
    expect(readPrDismissalFile(folder, new Date(START)).dismissals).toEqual([]);
    writeFileSync(file(), `${body}${' '.repeat(PR_DISMISSAL_FILE_MAX_BYTES)}`, { mode: 0o600 });
    expect(readPrDismissalFile(file(), new Date(START)).dismissals).toEqual([]);
    writeFileSync(file(), 'not json', { mode: 0o600 });
    expect(readPrDismissalFile(file(), new Date(START)).dismissals).toEqual([]);
    writeFileSync(file(), JSON.stringify({ v: 2, dismissals: [] }), { mode: 0o600 });
    expect(readPrDismissalFile(file(), new Date(START)).dismissals).toEqual([]);
  });

  it('checks each record, keeps only its checked fields, by own property, and reads a time after now as now', () => {
    const at = '2026-11-11T09:00:00.000Z';
    const body = `{"v":1,"dismissals":[
      {"key":"${KEY}","at":"${at}","hash":"${HASH_A}","title":"a title","__proto__":{"polluted":true}},
      {"key":"Example/Demo-App#8","at":"${at}","hash":"${HASH_A}"},
      {"key":"example/..#9","at":"${at}","hash":"${HASH_A}"},
      {"key":"example/demo-app#0","at":"${at}","hash":"${HASH_A}"},
      {"key":"example/demo-app#10","at":"soon","hash":"${HASH_A}"},
      {"key":"example/demo-app#11","at":"${at}","hash":"ABCDEF0123456789"},
      {"key":"example/demo-app#12","at":"${at}"},
      {"key":"example/demo-app#13","at":"2027-01-01T00:00:00.000Z","hash":"${HASH_B}","red":"${HASH_A}"},
      {"key":"example/demo-app#15","at":"${at}","hash":"${HASH_B}","red":"NOT-A-HASH"},
      "not a record",
      {"key":"${KEY}","at":"2026-11-11T08:00:00.000Z","hash":"${HASH_B}"}
    ],"ended":[{"key":"example/demo-app#14","at":"${at}","why":"x"},{"key":"../etc#1","at":"${at}"}],
    "removed":[{"key":"example/demo-app#16","at":"${at}"},{"key":"../etc#2","at":"${at}"},{"key":"example/demo-app#17","at":"soon"}]}`;
    writeFileSync(file(), body, { mode: 0o600 });
    const read = readPrDismissalFile(file(), new Date(START));
    expect(read.dismissals).toEqual([
      { key: KEY, at, hash: HASH_A },
      { key: 'example/demo-app#13', at: '2026-11-11T10:00:00.000Z', hash: HASH_B, red: HASH_A },
    ]);
    expect(Object.keys(read.dismissals[0]!)).toEqual(['key', 'at', 'hash']);
    expect(Object.getPrototypeOf(read.dismissals[0]!)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(read.ended).toEqual([{ key: 'example/demo-app#14', at }]);
    expect(read.removed).toEqual([{ key: 'example/demo-app#16', at }]);
    // A file whose `v` comes from a prototype isn't read.
    writeFileSync(file(), '{"__proto__":{"v":1},"dismissals":[]}', { mode: 0o600 });
    expect(readPrDismissalFile(file(), new Date(START))).toEqual({ dismissals: [], ended: [], removed: [] });
  });

  it('is read again and merged before each write, so a second pitwall on the same home keeps the first’s', () => {
    const time = clock();
    const one = new PrDismissalStore({ home, now: time.now });
    const two = new PrDismissalStore({ home, now: time.now });
    one.dismiss('example/demo-app#1', HASH_A);
    time.advance(1000);
    two.dismiss('example/demo-app#2', HASH_B);
    const stored = JSON.parse(readFileSync(file(), 'utf8')) as { dismissals: { key: string }[] };
    expect(stored.dismissals.map((each) => each.key)).toEqual(['example/demo-app#1', 'example/demo-app#2']);
    // `two` now holds the first's too, and shows it from its next decoration.
    expect(two.get('example/demo-app#1')).toEqual({ at: '2026-11-11T10:00:00.000Z', hash: HASH_A });
  });

  it('doesn’t merge back what this run took away, but does a newer dismissal from the other', () => {
    const time = clock();
    const one = new PrDismissalStore({ home, now: time.now });
    one.dismiss('example/demo-app#1', HASH_A);
    one.dismiss('example/demo-app#2', HASH_A);
    time.advance(1000);
    one.undismiss('example/demo-app#1');
    const stored = () => (JSON.parse(readFileSync(file(), 'utf8')) as { dismissals: { key: string }[] }).dismissals.map((each) => each.key);
    expect(stored()).toEqual(['example/demo-app#2']);
    // The other pitwall dismisses #1 again, later: kept by this one's next write.
    time.advance(1000);
    const two = new PrDismissalStore({ home, now: time.now });
    two.dismiss('example/demo-app#1', HASH_B);
    time.advance(1000);
    one.dismiss('example/demo-app#3', HASH_A);
    expect(stored().sort()).toEqual(['example/demo-app#1', 'example/demo-app#2', 'example/demo-app#3']);
    expect(one.get('example/demo-app#1')?.hash).toBe(HASH_B);
  });

  it('writes each removal as a tombstone, so an Undo in one pitwall isn’t reversed by another’s copy (W188’s review)', () => {
    const time = clock();
    const one = new PrDismissalStore({ home, now: time.now });
    one.dismiss(KEY, HASH_A);
    const two = new PrDismissalStore({ home, now: time.now });
    expect(two.get(KEY)).toBeDefined();
    time.advance(1000);
    one.undismiss(KEY);
    const stored = () => JSON.parse(readFileSync(file(), 'utf8')) as { dismissals: { key: string }[]; removed: { key: string; at: string }[] };
    expect(stored().removed).toEqual([{ key: KEY, at: '2026-11-11T10:00:01.000Z' }]);
    // `two` still holds its copy, and writes: the tombstone takes it away there too, and it isn't written back.
    time.advance(1000);
    two.dismiss('example/demo-app#8', HASH_B);
    expect(stored().dismissals.map((each) => each.key)).toEqual(['example/demo-app#8']);
    expect(two.get(KEY)).toBeUndefined();
    expect(dismissedOf(two.decorate(listOf([pr(), pr(8, { stateHash: HASH_B })])))).toBeUndefined();
    // A dismissal after the tombstone, in either, holds.
    time.advance(1000);
    two.dismiss(KEY, HASH_A);
    one.dismiss('example/demo-app#9', HASH_A);
    expect(stored().dismissals.map((each) => each.key).sort()).toEqual([KEY, 'example/demo-app#8', 'example/demo-app#9'].sort());
  });

  it('keeps at most PR_DISMISSALS_HELD_MAX tombstones, the oldest going first', () => {
    const time = clock();
    const store = new PrDismissalStore({ home, now: time.now });
    for (let n = 1; n <= PR_DISMISSALS_HELD_MAX + 3; n++) {
      store.dismiss(`example/demo-app#${n}`, HASH_A);
      store.undismiss(`example/demo-app#${n}`);
      time.advance(1000);
    }
    const removed = (JSON.parse(readFileSync(file(), 'utf8')) as { removed: { key: string }[] }).removed;
    expect(removed).toHaveLength(PR_DISMISSALS_HELD_MAX);
    expect(removed[0]!.key).toBe('example/demo-app#4');
    expect(statSync(file()).size).toBeLessThan(PR_DISMISSAL_FILE_MAX_BYTES);
  });

  it('fails soft when it can’t write: the dismissal holds for this run', () => {
    const missing = join(home, 'missing', 'deeper');
    const store = new PrDismissalStore({ home: missing, now: clock().now });
    store.dismiss(KEY, HASH_A);
    expect(dismissedOf(store.decorate(listOf([pr()])))).toBeDefined();
  });
});

describe('withDismissals()', () => {
  function source(initial: PullRequestList) {
    let list = initial;
    const listeners = new Set<(list: PullRequestList) => void>();
    const calls: string[] = [];
    const inner: PrSource = {
      latest: () => list,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      refresh: () => (calls.push('refresh'), { kind: 'started' }),
      start: () => void calls.push('start'),
      stop: () => void calls.push('stop'),
    };
    return { inner, calls, set: (next: PullRequestList) => ((list = next), [...listeners].forEach((listener) => listener(next))) };
  }

  it('keeps one object until the list or the store changes, and tells its listeners of either', () => {
    const store = new PrDismissalStore({ home, now: clock().now });
    const { inner, set, calls } = source(listOf([pr()]));
    const wrapped = withDismissals(inner, store);
    const told: PullRequestList[] = [];
    wrapped.subscribe((list) => told.push(list));
    const first = wrapped.latest();
    expect(wrapped.latest()).toBe(first);
    store.dismiss(KEY, HASH_A);
    expect(told).toHaveLength(1);
    expect(dismissedOf(told[0]!)).toBeDefined();
    expect(wrapped.latest()).toBe(told[0]);
    set(listOf([pr(7, { stateHash: HASH_B })]));
    expect(told).toHaveLength(2);
    expect(told[1]!.prs[0]!.dismissalEnded).toBeDefined();
    wrapped.refresh();
    wrapped.start();
    wrapped.stop();
    expect(calls).toEqual(['refresh', 'start', 'stop']);
  });
});

describe('validatePrDismissRequest()', () => {
  it('takes a lowercase repo, a whole number and, to dismiss, a hash, and nothing else', () => {
    expect(validatePrDismissRequest({ repo: 'example/demo-app', number: 7, seen: HASH_A }, true)).toEqual({ ok: true, repo: 'example/demo-app', number: 7, seen: HASH_A });
    expect(validatePrDismissRequest({ repo: 'example/demo-app', number: 7 }, false)).toEqual({ ok: true, repo: 'example/demo-app', number: 7 });
    for (const body of [
      null,
      [],
      'example/demo-app#7',
      { repo: 'example/demo-app', number: 7 },
      { repo: 'Example/demo-app', number: 7, seen: HASH_A },
      { repo: 'example/..', number: 7, seen: HASH_A },
      { repo: 'example/demo-app/x', number: 7, seen: HASH_A },
      { repo: 'example/demo-app', number: 0, seen: HASH_A },
      { repo: 'example/demo-app', number: 1.5, seen: HASH_A },
      { repo: 'example/demo-app', number: '7', seen: HASH_A },
      { repo: 'example/demo-app', number: 7, seen: 'ABCDEF0123456789' },
      { repo: 'example/demo-app', number: 7, seen: HASH_A, title: 'x' },
    ]) {
      expect(validatePrDismissRequest(body, true).ok, JSON.stringify(body)).toBe(false);
    }
    expect(validatePrDismissRequest({ repo: 'example/demo-app', number: 7, seen: HASH_A }, false).ok).toBe(false);
  });

  it('agrees with the store’s key pattern', () => {
    expect(isPrDismissalKey(KEY)).toBe(true);
    for (const key of ['Example/demo-app#7', 'example/demo-app', 'example/.#1', 'example/demo-app#01', '#1', 'example/demo app#1', 7]) expect(isPrDismissalKey(key), String(key)).toBe(false);
  });
});

describe('the routes', () => {
  function setup(prs: PullRequestSummary[]) {
    const store = new PrDismissalStore({ home, now: clock().now });
    let list = listOf(prs);
    const wrapped = withDismissals({ latest: () => list, subscribe: () => () => {}, refresh: () => ({ kind: 'off' }), start: () => {}, stop: () => {} }, store);
    const app = new Hono();
    registerPrDismissals(app, { prs: wrapped, store });
    const post = (path: string, body: unknown, type = 'application/json') =>
      app.request(path, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { store, wrapped, post, setList: (next: PullRequestSummary[]) => (list = listOf(next)) };
  }

  it('dismisses a listed PR in the state the page saw, and Undo takes it off', async () => {
    const { post, wrapped } = setup([pr()]);
    const res = await post(PR_DISMISS_PATH, { repo: 'example/demo-app', number: 7, seen: HASH_A });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()) as PrDismissResult).toEqual({ ok: true, dismissed: { at: '2026-11-11T10:00:00.000Z' } });
    expect(dismissedOf(wrapped.latest())).toBeDefined();
    const undo = await post(PR_UNDISMISS_PATH, { repo: 'example/demo-app', number: 7 });
    expect(undo.status).toBe(200);
    expect(await undo.json()).toEqual({ ok: true });
    expect(dismissedOf(wrapped.latest())).toBeUndefined();
    // Undo of one that isn't dismissed is fine too.
    expect((await post(PR_UNDISMISS_PATH, { repo: 'example/demo-app', number: 99 })).status).toBe(200);
  });

  it('dismisses your own red PR with the red hash the page saw, and refuses one that went red since (W188’s review)', async () => {
    const RED = '3333333333333333';
    const { post, store } = setup([pr(9, { relation: 'authored', checks: 'failing', redHash: RED })]);
    expect((await post(PR_DISMISS_PATH, { repo: 'example/demo-app', number: 9, seen: HASH_A })).status).toBe(409);
    expect((await post(PR_DISMISS_PATH, { repo: 'example/demo-app', number: 9, seen: HASH_A, seenRed: 'nope' })).status).toBe(400);
    expect((await post(PR_DISMISS_PATH, { repo: 'example/demo-app', number: 9, seen: HASH_A, seenRed: RED })).status).toBe(200);
    expect(store.get('example/demo-app#9')).toEqual({ at: '2026-11-11T10:00:00.000Z', hash: HASH_A, red: RED });
  });

  it('refuses a PR that isn’t listed, one with no hash, and a state the page saw that has changed since', async () => {
    const { stateHash: _none, ...unhashed } = pr(8);
    const { post, store } = setup([pr(), unhashed]);
    expect((await post(PR_DISMISS_PATH, { repo: 'example/demo-app', number: 99, seen: HASH_A })).status).toBe(404);
    expect((await post(PR_DISMISS_PATH, { repo: 'example/demo-app', number: 8, seen: HASH_A })).status).toBe(409);
    const stale = await post(PR_DISMISS_PATH, { repo: 'example/demo-app', number: 7, seen: HASH_B });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toContain('Something new');
    expect(store.size()).toBe(0);
  });

  it('refuses a body that isn’t a request, isn’t JSON, isn’t sent as JSON, or is too large', async () => {
    const { post, store } = setup([pr()]);
    expect((await post(PR_DISMISS_PATH, { repo: 'example/demo-app', number: 7 })).status).toBe(400);
    expect((await post(PR_DISMISS_PATH, '{not json')).status).toBe(400);
    expect((await post(PR_DISMISS_PATH, { repo: 'example/demo-app', number: 7, seen: HASH_A }, 'text/plain')).status).toBe(415);
    expect((await post(PR_DISMISS_PATH, { repo: 'example/demo-app', number: 7, seen: HASH_A, pad: 'x'.repeat(PR_DISMISS_BODY_MAX_BYTES) })).status).toBe(413);
    expect((await post(PR_UNDISMISS_PATH, { repo: '../etc', number: 7 })).status).toBe(400);
    expect((await post(PR_UNDISMISS_PATH, { repo: 'example/demo-app', number: 7 }, 'text/plain')).status).toBe(415);
    expect(store.size()).toBe(0);
  });
});
