// Snoozes (W154): the store, its file, its timer, the snapshot's decoration and the routes, on a bare
// Hono app. The routes through the real server and its /api/* checks are in relayRoute.test.ts.
// Made-up sessions only.
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SNOOZE_ENDED_SHOWN_MS, SNOOZE_MAX_MS, snoozePath, unsnoozePath, type IndexSnapshot, type SessionSummary, type SnoozeResult } from '../shared/protocol.js';
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
