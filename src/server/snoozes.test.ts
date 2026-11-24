// Snoozes (W154): the store, its file, its timer, the snapshot's decoration and the routes, on a bare
// Hono app. The routes through the real server and its /api/* checks are in relayRoute.test.ts.
// Made-up sessions only.
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SNOOZE_ENDED_SHOWN_MS, SNOOZE_MAX_MS, snoozePath, unsnoozePath, type IndexSnapshot, type PullRequestList, type PullRequestSummary, type SessionSummary, type SnoozeResult } from '../shared/protocol.js';
import { needsAttention } from '../shared/needsYou.js';
import { createSnoozeView, readSnoozeFile, registerSnoozes, SNOOZE_FILE_NAME, SnoozeStore, SNOOZES_HELD_MAX, validateSnoozeRequest } from './snoozes.js';

const ID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const HOUR = 60 * 60 * 1000;
const START = Date.parse('2026-11-06T10:00:00.000Z');

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: ID,
    name: 'pitwall-test-snooze',
    kind: 'background',
    cwd: '/tmp/pitwall-test-root/repo',
    alive: true,
    pid: 4242,
    startedAt: '2026-11-06T00:00:00.000Z',
    stale: false,
    finished: false,
    transcript: 'ok',
    needsYou: { reason: 'recap', text: 'Decide the budget for the test run' },
    ...overrides,
  };
}

function snapshotOf(...sessions: SessionSummary[]): IndexSnapshot {
  return {
    generatedAt: '2026-11-06T10:00:00.000Z',
    roots: ['/tmp/pitwall-test-root'],
    groups: [{ key: '/tmp/pitwall-test-root/repo', label: 'repo', kind: 'git', root: '/tmp/pitwall-test-root', sessions }],
    source: { ok: true },
  };
}

const first = (snapshot: IndexSnapshot) => snapshot.groups[0]!.sessions[0]!;

/** A clock and timers the test moves by hand. */
function fakeTime() {
  let now = START;
  const pending = new Map<number, { fn: () => void; at: number }>();
  let next = 1;
  return {
    now: () => new Date(now),
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { fn, at: now + ms });
        return id;
      },
      clear: (handle: unknown) => void pending.delete(handle as number),
    },
    pending: () => [...pending.values()].map((timer) => timer.at - now),
    /** Moves the clock on by `ms`, firing the timers due on the way, in order. */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pitwall-test-snoozes-'));
  chmodSync(home, 0o700);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('SnoozeStore', () => {
  it('decorates a snoozed session until its time is up, then says why it came back, for SNOOZE_ENDED_SHOWN_MS', () => {
    const time = fakeTime();
    const store = new SnoozeStore({ now: time.now, timers: time.timers });
    store.snooze(ID, new Date(START + HOUR));
    expect(first(store.decorate(snapshotOf(session()))).snoozed).toEqual({ at: '2026-11-06T10:00:00.000Z', until: '2026-11-06T11:00:00.000Z' });
    expect(time.pending()).toEqual([HOUR]);
    time.advance(HOUR);
    const back = first(store.decorate(snapshotOf(session())));
    expect(back.snoozed).toBeUndefined();
    expect(back.snoozeEnded).toEqual({ at: '2026-11-06T11:00:00.000Z', why: 'time' });
    time.advance(SNOOZE_ENDED_SHOWN_MS);
    expect(first(store.decorate(snapshotOf(session()))).snoozeEnded).toBeUndefined();
    store.close();
  });

  it('ends a snooze, timed or Later, when the session is woken after it, and not by a wake before it', () => {
    const time = fakeTime();
    const store = new SnoozeStore({ now: time.now, timers: time.timers });
    store.snooze(ID);
    store.snooze(OTHER, new Date(START + 3 * HOUR));
    const before = '2026-11-06T09:59:00.000Z';
    let view = store.decorate(snapshotOf(session({ wokenAt: before }), session({ sessionId: OTHER, wokenAt: before })));
    expect(view.groups[0]!.sessions.map((s) => s.snoozed !== undefined)).toEqual([true, true]);
    time.advance(60_000);
    const after = '2026-11-06T10:00:30.000Z';
    view = store.decorate(snapshotOf(session({ wokenAt: after }), session({ sessionId: OTHER, wokenAt: after })));
    expect(view.groups[0]!.sessions.map((s) => s.snoozeEnded?.why)).toEqual(['woken', 'woken']);
    expect(view.groups[0]!.sessions.every((s) => s.snoozed === undefined)).toBe(true);
    store.close();
  });

  it('keeps a Later snooze while what it needs changes, and while the session is missing from the list', () => {
    const store = new SnoozeStore();
    store.snooze(ID);
    expect(first(store.decorate(snapshotOf(session({ needsYou: { reason: 'recap', text: 'Reworded to-do' } })))).snoozed).toBeDefined();
    store.decorate(snapshotOf(session({ sessionId: OTHER })));
    expect(first(store.decorate(snapshotOf(session()))).snoozed).toBeDefined();
  });

  it('drops a snooze, saying nothing, once you start or join a turn after it, so a later need shows', () => {
    const time = fakeTime();
    const store = new SnoozeStore({ now: time.now, timers: time.timers });
    store.snooze(ID);
    store.snooze(OTHER, new Date(START + 3 * HOUR));
    const before = '2026-11-06T09:59:00.000Z';
    let view = store.decorate(snapshotOf(session({ attendedAt: before }), session({ sessionId: OTHER, attendedAt: before })));
    expect(view.groups[0]!.sessions.map((s) => s.snoozed !== undefined)).toEqual([true, true]);
    time.advance(60_000);
    // A prompt you typed, and a message pitwall's relay sent, after the snooze; a wake after both.
    const after = '2026-11-06T10:00:30.000Z';
    const woken = '2026-11-06T10:00:40.000Z';
    view = store.decorate(snapshotOf(session({ attendedAt: after }), session({ sessionId: OTHER, attendedAt: after, wokenAt: woken })));
    expect(view.groups[0]!.sessions.map((s) => [s.snoozed, s.snoozeEnded])).toEqual([[undefined, undefined], [undefined, undefined]]);
    expect(time.pending()).toEqual([]);
    expect(first(store.decorate(snapshotOf(session({ attendedAt: after })))).snoozed).toBeUndefined();
    store.close();
  });

  it('takes `at` from the snapshot it was snoozed from, if earlier, so a wake the page had not shown counts', () => {
    const time = fakeTime();
    const store = new SnoozeStore({ now: time.now, timers: time.timers });
    const seen = '2026-11-06T09:59:55.000Z';
    expect(store.snooze(ID, undefined, seen)).toEqual({ at: seen });
    expect(store.snooze(OTHER, undefined, '2026-11-06T10:05:00.000Z')).toEqual({ at: '2026-11-06T10:00:00.000Z' });
    expect(store.snooze(OTHER, undefined, 'not a time')).toEqual({ at: '2026-11-06T10:00:00.000Z' });
    // Woken at 09:59:58, after the snapshot the page showed, before the click at 10:00.
    expect(first(store.decorate(snapshotOf(session({ wokenAt: '2026-11-06T09:59:58.000Z' })))).snoozeEnded?.why).toBe('woken');
    store.close();
  });

  it('drops a timed snooze on a session no longer listed once its end would no longer show', () => {
    const time = fakeTime();
    const store = new SnoozeStore({ now: time.now, timers: time.timers });
    store.snooze(ID, new Date(START + HOUR));
    time.advance(HOUR + SNOOZE_ENDED_SHOWN_MS - 1);
    store.decorate(snapshotOf(session({ sessionId: OTHER })));
    store.decorate(snapshotOf(session({ sessionId: OTHER })));
    time.advance(1);
    store.decorate(snapshotOf(session({ sessionId: OTHER })));
    // Listed again: neither snoozed nor an end, since it ended unseen.
    const back = first(store.decorate(snapshotOf(session())));
    expect([back.snoozed, back.snoozeEnded]).toEqual([undefined, undefined]);
    store.close();
  });

  it('drops a snooze on a session listed as ended or finished, saying nothing', () => {
    const store = new SnoozeStore();
    store.snooze(ID);
    const finished = first(store.decorate(snapshotOf(session({ finished: true, alive: false, needsYou: undefined }))));
    expect(finished.snoozed).toBeUndefined();
    expect(finished.snoozeEnded).toBeUndefined();
    expect(first(store.decorate(snapshotOf(session()))).snoozed).toBeUndefined();
  });

  it('takes a snooze off, and an end still shown, and a new snooze clears the end', () => {
    const time = fakeTime();
    const store = new SnoozeStore({ now: time.now, timers: time.timers });
    store.snooze(ID, new Date(START + HOUR));
    expect(store.unsnooze(ID)).toBe(true);
    expect(store.unsnooze(ID)).toBe(false);
    expect(time.pending()).toEqual([]);
    store.snooze(ID, new Date(START + HOUR));
    time.advance(HOUR);
    expect(first(store.decorate(snapshotOf(session()))).snoozeEnded).toBeDefined();
    store.snooze(ID);
    const again = first(store.decorate(snapshotOf(session())));
    expect(again.snoozeEnded).toBeUndefined();
    expect(again.snoozed).toEqual({ at: '2026-11-06T11:00:00.000Z' });
    store.close();
  });

  it('never spins its timer on a snooze already due when nothing decorates', () => {
    const time = fakeTime();
    const store = new SnoozeStore({ now: time.now, timers: time.timers });
    store.snooze(ID, new Date(START + HOUR));
    time.advance(2 * HOUR);
    expect(time.pending()).toEqual([]);
    expect(first(store.decorate(snapshotOf(session()))).snoozeEnded?.why).toBe('time');
    store.close();
  });

  it('keeps its snoozes in a 0600 file, read back after a restart, ids and times only', () => {
    const store = new SnoozeStore({ home, now: () => new Date(START) });
    store.snooze(ID, new Date(START + HOUR));
    store.snooze(OTHER);
    store.close();
    const file = join(home, SNOOZE_FILE_NAME);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      v: 1,
      snoozes: [
        { id: ID, at: '2026-11-06T10:00:00.000Z', until: '2026-11-06T11:00:00.000Z' },
        { id: OTHER, at: '2026-11-06T10:00:00.000Z' },
      ],
      ended: [],
    });
    const again = new SnoozeStore({ home, now: () => new Date(START) });
    const view = again.decorate(snapshotOf(session(), session({ sessionId: OTHER })));
    expect(view.groups[0]!.sessions.map((s) => s.snoozed?.until ?? null)).toEqual(['2026-11-06T11:00:00.000Z', null]);
    again.close();
  });

  it('ignores a file that is a link or writable by others, and entries that don’t check out', () => {
    const file = join(home, SNOOZE_FILE_NAME);
    const body = { v: 1, snoozes: [{ id: ID, at: '2026-11-06T10:00:00.000Z' }, { id: '../x', at: '2026-11-06T10:00:00.000Z' }, { id: OTHER, at: 'soon' }, { id: OTHER, at: '2026-11-06T10:00:00.000Z', until: 7 }], ended: [{ id: OTHER, at: '2026-11-06T10:00:00.000Z', why: 'bored' }] };
    writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    expect(readSnoozeFile(file)).toEqual({ snoozes: [{ id: ID, at: '2026-11-06T10:00:00.000Z' }], ended: [] });
    chmodSync(file, 0o622);
    expect(readSnoozeFile(file).snoozes).toEqual([]);
    chmodSync(file, 0o600);
    const link = join(home, 'link.json');
    symlinkSync(file, link);
    expect(readSnoozeFile(link).snoozes).toEqual([]);
    writeFileSync(file, 'not json', { mode: 0o600 });
    expect(readSnoozeFile(file).snoozes).toEqual([]);
  });

  it('reads a time after now as now, and an until past SNOOZE_MAX_MS from its at as that', () => {
    const file = join(home, SNOOZE_FILE_NAME);
    const now = new Date(START);
    const body = {
      v: 1,
      snoozes: [
        { id: ID, at: '2026-11-06T09:00:00.000Z', until: '9999-01-01T00:00:00.000Z' },
        { id: OTHER, at: '2030-01-01T00:00:00.000Z' },
      ],
      ended: [{ id: '44444444-4444-4444-8444-444444444444', at: '2030-01-01T00:00:00.000Z', why: 'time' }],
    };
    writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    expect(readSnoozeFile(file, now)).toEqual({
      snoozes: [
        { id: ID, at: '2026-11-06T09:00:00.000Z', until: new Date(Date.parse('2026-11-06T09:00:00.000Z') + SNOOZE_MAX_MS).toISOString() },
        { id: OTHER, at: '2026-11-06T10:00:00.000Z' },
      ],
      ended: [{ id: '44444444-4444-4444-8444-444444444444', at: '2026-11-06T10:00:00.000Z', why: 'time' }],
    });
  });

  it('holds at most SNOOZES_HELD_MAX, the oldest going first', () => {
    const store = new SnoozeStore();
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    for (let n = 0; n <= SNOOZES_HELD_MAX; n++) store.snooze(id(n));
    const view = store.decorate(snapshotOf(session({ sessionId: id(0) }), session({ sessionId: id(SNOOZES_HELD_MAX) })));
    expect(view.groups[0]!.sessions.map((s) => s.snoozed !== undefined)).toEqual([false, true]);
  });
});

describe('createSnoozeView()', () => {
  it('sends the snapshot again when a snooze changes what it carries, and when its time is up', () => {
    const time = fakeTime();
    const store = new SnoozeStore({ now: time.now, timers: time.timers });
    const base = snapshotOf(session());
    const view = createSnoozeView({ latest: () => base, subscribe: () => () => {} }, store);
    const seen: IndexSnapshot[] = [];
    view.subscribe((snapshot) => seen.push(snapshot));
    store.snooze(ID, new Date(START + HOUR));
    expect(seen.map((s) => first(s).snoozed !== undefined)).toEqual([true]);
    time.advance(HOUR);
    expect(seen).toHaveLength(2);
    expect(first(seen[1]!).snoozeEnded?.why).toBe('time');
    view.stop();
    store.close();
  });
});

describe('validateSnoozeRequest()', () => {
  const now = new Date(START);
  it('takes no until, for Later, or a time ahead of now and at most SNOOZE_MAX_MS away, and nothing else', () => {
    expect(validateSnoozeRequest({}, now)).toEqual({ ok: true });
    expect(validateSnoozeRequest({ until: '2026-11-06T11:00:00.000Z' }, now)).toEqual({ ok: true, until: new Date(START + HOUR) });
    expect(validateSnoozeRequest({ until: new Date(START + SNOOZE_MAX_MS).toISOString() }, now).ok).toBe(true);
    expect(validateSnoozeRequest({ until: new Date(START + SNOOZE_MAX_MS + 1).toISOString() }, now).ok).toBe(false);
    expect(validateSnoozeRequest({ until: '2026-11-06T10:00:00.000Z' }, now).ok).toBe(false);
    expect(validateSnoozeRequest({ until: 'tomorrow' }, now).ok).toBe(false);
    expect(validateSnoozeRequest({ until: null }, now).ok).toBe(false);
    expect(validateSnoozeRequest({ until: '2026-11-06T11:00:00.000Z', why: 'x' }, now).ok).toBe(false);
    expect(validateSnoozeRequest([], now).ok).toBe(false);
  });
});

describe('the snooze routes', () => {
  function setup(sessions: SessionSummary[]) {
    const store = new SnoozeStore({ home, now: () => new Date(START) });
    let current = snapshotOf(...sessions);
    const view = createSnoozeView({ latest: () => current, subscribe: () => () => {} }, store);
    const app = new Hono();
    registerSnoozes(app, { snapshots: view, store, now: () => new Date(START) });
    const snooze = (id: string, body: unknown, type = 'application/json') =>
      app.request(snoozePath(id), { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const unsnooze = (id: string) => app.request(unsnoozePath(id), { method: 'POST' });
    return { store, view, snooze, unsnooze, setSessions: (next: SessionSummary[]) => (current = snapshotOf(...next)) };
  }

  it('snoozes from the time of the snapshot it reads, when that is earlier than now', async () => {
    const store = new SnoozeStore({ home, now: () => new Date(START) });
    const earlier = { ...snapshotOf(session()), generatedAt: '2026-11-06T09:59:57.000Z' };
    const view = createSnoozeView({ latest: () => earlier, subscribe: () => () => {} }, store);
    const app = new Hono();
    registerSnoozes(app, { snapshots: view, store, now: () => new Date(START) });
    const res = await app.request(snoozePath(ID), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(await res.json()).toEqual({ ok: true, snoozed: { at: '2026-11-06T09:59:57.000Z' } });
    store.close();
  });

  it('snoozes for a time, or Later, and the snapshot carries it', async () => {
    const { snooze, view, store } = setup([session()]);
    const res = await snooze(ID, { until: '2026-11-06T13:00:00.000Z' });
    expect(res.status).toBe(200);
    expect((await res.json()) as SnoozeResult).toEqual({ ok: true, snoozed: { at: '2026-11-06T10:00:00.000Z', until: '2026-11-06T13:00:00.000Z' } });
    expect(first(view.latest()!).snoozed?.until).toBe('2026-11-06T13:00:00.000Z');
    expect(await (await snooze(ID, {})).json()).toEqual({ ok: true, snoozed: { at: '2026-11-06T10:00:00.000Z' } });
    expect(first(view.latest()!).snoozed).toEqual({ at: '2026-11-06T10:00:00.000Z' });
    store.close();
  });

  it('refuses a session that doesn’t need you, or has finished', async () => {
    const { snooze, setSessions, store } = setup([session({ needsYou: undefined })]);
    expect((await snooze(ID, {})).status).toBe(409);
    setSessions([session({ finished: true, alive: false })]);
    expect((await snooze(ID, {})).status).toBe(409);
    store.close();
  });

  it('refuses a bad id, an unlisted session, a past time, a body that isn’t a SnoozeRequest or isn’t JSON', async () => {
    const { snooze, store } = setup([session()]);
    expect((await snooze('../x', {})).status).toBe(400);
    expect((await snooze(OTHER, {})).status).toBe(404);
    expect((await snooze(ID, { until: '2026-11-06T09:00:00.000Z' })).status).toBe(400);
    expect((await snooze(ID, { later: true })).status).toBe(400);
    expect((await snooze(ID, '{')).status).toBe(400);
    expect((await snooze(ID, {}, 'text/plain')).status).toBe(415);
    expect((await snooze(ID, { until: 'x'.repeat(5000) })).status).toBe(413);
    store.close();
  });

  it('takes a snooze off', async () => {
    const { snooze, unsnooze, view, store } = setup([session()]);
    await snooze(ID, {});
    const res = await unsnooze(ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(first(view.latest()!).snoozed).toBeUndefined();
    expect((await unsnooze(OTHER)).status).toBe(404);
    store.close();
  });
});

describe('a snooze holds the session’s PR too (W199)', () => {
  const HASH_A = '0123456789abcdef';
  const HASH_B = 'fedcba9876543210';
  const RED_A = 'aaaaaaaaaaaaaaaa';
  const RED_B = 'bbbbbbbbbbbbbbbb';

  const owner = (): SessionSummary => session({ prLinks: [{ kind: 'opened', repo: 'example/demo-app', number: 7, lastAt: '2026-11-06T09:00:00.000Z' }] });
  const pr = (number: number, overrides: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
    url: `https://github.com/example/demo-app/pull/${number}`,
    repo: 'example/demo-app',
    repoLabel: 'example/demo-app',
    number,
    title: 'Add a demo feature',
    draft: false,
    createdAt: '2026-11-01T09:00:00Z',
    updatedAt: '2026-11-05T09:00:00Z',
    checks: 'failing',
    mergeable: 'clean',
    relation: 'authored',
    stateHash: HASH_A,
    redHash: RED_A,
    ...overrides,
  });
  function source(prs: PullRequestSummary[], loaded = true) {
    let list: PullRequestList = { source: { ok: true }, refreshing: false, prs, ...(loaded ? { fetchedAt: '2026-11-06T09:59:00.000Z' } : {}) };
    const listeners = new Set<(list: PullRequestList) => void>();
    return {
      latest: () => list,
      subscribe: (listener: (list: PullRequestList) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      set: (prs: PullRequestSummary[]) => {
        list = { ...list, prs };
        for (const listener of listeners) listener(list);
      },
    };
  }
  const decorated = (store: SnoozeStore, ...sessions: SessionSummary[]) => first(store.decorate(snapshotOf(...sessions)));

  it('records the hashes of each needing PR it owns, and not one with no stateHash or one that needs nothing', () => {
    const prs = source([pr(7), pr(8, { stateHash: undefined }), pr(9, { checks: 'passing' })]);
    const store = new SnoozeStore({ prs, now: fakeTime().now });
    const snoozed = store.snooze(ID, undefined, undefined, owner(), [owner()]);
    expect(snoozed.heldPrs).toEqual([{ key: 'example/demo-app#7', stateHash: HASH_A, redHash: RED_A }]);
  });

  it('records nothing before the PR list has loaded, so it holds none and ends on none', () => {
    const prs = source([], false);
    const store = new SnoozeStore({ prs, now: fakeTime().now });
    expect(store.snooze(ID, undefined, undefined, owner(), [owner()]).heldPrs).toBeUndefined();
    prs.set([pr(7)]);
    expect(decorated(store, owner()).snoozed).toBeDefined();
    expect(decorated(store, owner()).snoozeEnded).toBeUndefined();
  });

  it('holds while the PRs are unchanged: the snooze stays, and the PR no longer needs you (the row is out of Needs you)', () => {
    const prs = source([pr(7)]);
    const store = new SnoozeStore({ prs, now: fakeTime().now });
    store.snooze(ID, undefined, undefined, owner(), [owner()]);
    const row = decorated(store, owner());
    expect(row.snoozed?.heldPrs).toHaveLength(1);
    expect(needsAttention(row)).toBe(false);
  });

  it.each([
    ['its stateHash changes', { stateHash: HASH_B }],
    ['its head goes red on a new commit', { redHash: RED_B }],
  ])('ends with why pr when %s', (_name, change) => {
    const prs = source([pr(7)]);
    const store = new SnoozeStore({ prs, now: fakeTime().now });
    store.snooze(ID, undefined, undefined, owner(), [owner()]);
    prs.set([pr(7, change)]);
    const row = decorated(store, owner());
    expect(row.snoozed).toBeUndefined();
    expect(row.snoozeEnded).toMatchObject({ why: 'pr', pr: { ref: 'example/demo-app#7', need: 'checks-failing' } });
  });

  it('drops a PR’s end once that PR no longer needs you, so its line 2 doesn’t linger (review F1)', () => {
    const prs = source([pr(7)]);
    const store = new SnoozeStore({ prs, now: fakeTime().now });
    store.snooze(ID, undefined, undefined, owner(), [owner()]);
    prs.set([pr(7, { stateHash: HASH_B })]);
    expect(decorated(store, owner()).snoozeEnded).toMatchObject({ why: 'pr' });
    prs.set([pr(7, { stateHash: HASH_B, checks: 'passing' })]);
    expect(decorated(store, owner()).snoozeEnded).toBeUndefined();
    prs.set([]);
    expect(decorated(store, owner()).snoozeEnded).toBeUndefined();
  });

  it('ends when another PR the session owns starts to need you, but not for one with no hash', () => {
    const prs = source([pr(7)]);
    const store = new SnoozeStore({ prs, now: fakeTime().now });
    store.snooze(ID, undefined, undefined, owner(), [owner()]);
    const both = { ...owner(), prLinks: [...owner().prLinks!, { kind: 'opened' as const, repo: 'example/demo-app', number: 8, lastAt: '2026-11-06T09:00:00.000Z' }] };
    prs.set([pr(7), pr(8, { stateHash: undefined })]);
    expect(decorated(store, both).snoozed).toBeDefined();
    prs.set([pr(7), pr(8, { stateHash: HASH_B })]);
    expect(decorated(store, both).snoozeEnded).toMatchObject({ why: 'pr', pr: { ref: 'example/demo-app#8' } });
  });

  it('does not end a snooze while the session is busy, and a snooze without heldPrs never ends on a PR', () => {
    const prs = source([pr(7)]);
    const store = new SnoozeStore({ prs, now: fakeTime().now });
    store.snooze(ID, undefined, undefined, owner(), [owner()]);
    prs.set([pr(7, { stateHash: HASH_B })]);
    expect(decorated(store, { ...owner(), status: 'busy' }).snoozed).toBeDefined();
    const plain = new SnoozeStore({ now: fakeTime().now });
    plain.snooze(ID);
    expect(decorated(plain, owner()).snoozed).toBeDefined();
  });

  it('tells the views when the PR list changes, only while a snooze holds PRs', () => {
    const prs = source([pr(7)]);
    const store = new SnoozeStore({ prs, now: fakeTime().now });
    let heard = 0;
    store.subscribe(() => (heard += 1));
    prs.set([pr(7)]);
    expect(heard).toBe(0);
    store.snooze(ID, undefined, undefined, owner(), [owner()]);
    heard = 0;
    prs.set([pr(7, { stateHash: HASH_B })]);
    expect(heard).toBe(1);
  });

  it('reads the hashes and the PR end back from the file, checking each', () => {
    const file = join(home, SNOOZE_FILE_NAME);
    const at = '2026-11-06T09:00:00.000Z';
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        snoozes: [
          { id: ID, at, heldPrs: [{ key: 'example/demo-app#7', stateHash: HASH_A, redHash: RED_A }, { key: 'not a key', stateHash: HASH_A }, { key: 'example/demo-app#8', stateHash: 'XYZ' }, 'x'] },
          { id: OTHER, at, heldPrs: 'nope' },
        ],
        ended: [
          { id: ID, at, why: 'pr', pr: { ref: 'example/demo-app#7', need: 'conflicts' } },
          { id: OTHER, at, why: 'pr', pr: { ref: 'example/demo-app#7', need: 'made up' } },
        ],
      }),
      { mode: 0o600 },
    );
    const read = readSnoozeFile(file, new Date(START));
    expect(read.snoozes[0]!.heldPrs).toEqual([{ key: 'example/demo-app#7', stateHash: HASH_A, redHash: RED_A }]);
    expect(read.snoozes[1]!.heldPrs).toBeUndefined();
    expect(read.ended).toEqual([{ id: ID, at, why: 'pr', pr: { ref: 'example/demo-app#7', need: 'conflicts' } }]);
  });

  it('keeps hashes across a restart', () => {
    const prs = source([pr(7)]);
    const first = new SnoozeStore({ home, prs, now: fakeTime().now });
    first.snooze(ID, undefined, undefined, owner(), [owner()]);
    first.close();
    const again = new SnoozeStore({ home, prs, now: fakeTime().now });
    expect(decorated(again, owner()).snoozed?.heldPrs).toEqual([{ key: 'example/demo-app#7', stateHash: HASH_A, redHash: RED_A }]);
    again.close();
  });

  it('the route records them from the PR list', async () => {
    const prs = source([pr(7)]);
    const store = new SnoozeStore({ prs, now: () => new Date(START) });
    const view = createSnoozeView({ latest: () => snapshotOf(owner()), subscribe: () => () => {} }, store);
    const app = new Hono();
    registerSnoozes(app, { snapshots: view, store, now: () => new Date(START) });
    const res = await app.request(snoozePath(ID), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(((await res.json()) as { snoozed: { heldPrs: unknown } }).snoozed.heldPrs).toEqual([{ key: 'example/demo-app#7', stateHash: HASH_A, redHash: RED_A }]);
    store.close();
  });
});
