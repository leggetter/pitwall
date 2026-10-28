// Not needed now's marks (W88, notNeeded.ts, docs/design-system.md, 4: Not needed now):
// pitwall.not-needed.v1, ids and hashes only, validated, capped at 200, pruned once what a session
// needed changes but never for a session missing from a snapshot, a change from another tab, storage
// that's missing, malformed or throws; and what needsAttention() and the helpers that use it make of a
// mark. Made-up sessions only.

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/shared/protocol.js';
import type { StorageSource } from './groupState.js';
import {
  fnv1a64,
  markedNow,
  needHash,
  NOT_NEEDED_CAP,
  NOT_NEEDED_KEY,
  pruned,
  readNotNeeded,
  useNotNeeded,
  withMark,
  withoutMark,
  writeNotNeeded,
  type NotNeeded,
} from './notNeeded.js';
import { tabAttention } from './rootTabs.js';
import { countAttention, isNotNeeded, listScope, needsAttention, rowStatusBadge, sessionOrder, statusBadge } from './sessions.js';
import type { StarredEvents } from './starred.js';
import { group, minutesAgo, session } from './test/fixtures.js';

const id = (n: number) => `00000000-0000-4000-8000-0000000088${String(n).padStart(2, '0')}`;
const HASH = 'a1b2c3d4e5f60718';

function memory(initial: Record<string, string> = {}) {
  const items = new Map<string, string>(Object.entries(initial));
  const writes: string[] = [];
  const source: StorageSource = () => ({
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      writes.push(key);
      items.set(key, value);
    },
  });
  return { items, writes, source };
}

const denied = () => {
  throw new DOMException('The operation is insecure.', 'SecurityError');
};

const stored = (entries: unknown) => JSON.stringify({ v: 1, entries });
const entriesIn = (items: Map<string, string>) => (JSON.parse(items.get(NOT_NEEDED_KEY) ?? '{"v":1,"entries":[]}') as { entries: { id: string; hash: string }[] }).entries;

/** Another tab's `storage` events, sent by hand. */
function tabs() {
  const listeners = new Set<(event: { key: string | null }) => void>();
  const events: StarredEvents = {
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
  };
  return {
    events,
    listening: () => listeners.size,
    fire: (key: string | null) =>
      act(() => {
        for (const listener of listeners) listener({ key });
      }),
  };
}

/** Phil's case: a background job Claude Code calls blocked, whose own line says what it's waiting for. */
function waitingOnAuthor(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return session({
    sessionId: id(1),
    name: 'pitwall-test-review-bot',
    kind: 'background',
    shortId: 'pt88rev',
    status: 'idle',
    state: 'blocked',
    needsYou: { reason: 'claude-code', text: "Waiting for the made-up author's fix before re-running the check" },
    ...overrides,
  });
}

describe('the key', () => {
  it('is pitwall.not-needed.v1, one for every root and tab on the origin, holding at most 200', () => {
    expect(NOT_NEEDED_KEY).toBe('pitwall.not-needed.v1');
    expect(NOT_NEEDED_CAP).toBe(200);
  });
});

describe('needHash', () => {
  it('is 16 hex digits, never the text', () => {
    const job = waitingOnAuthor();
    const hash = needHash(job);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).not.toContain('author');
  });

  it('is FNV-1a 64 over the UTF-8 bytes', () => {
    // The published FNV-1a 64 test vectors.
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });

  it("is the same for the same need, whatever else changes: the time, the prompt, the title", () => {
    const before = waitingOnAuthor({ lastActivityAt: minutesAgo(30), title: 'A made-up review', lastUserPrompt: 'a made-up prompt' });
    const after = waitingOnAuthor({ lastActivityAt: minutesAgo(1), title: 'Another made-up title', lastUserPrompt: 'another made-up prompt', subagentsRunning: 2 });
    expect(needHash(after)).toBe(needHash(before));
  });

  it("changes with each part of what it needs: needsYou's reason and text, askedYou's excerpt, state, status and waitingFor", () => {
    const base = waitingOnAuthor();
    const changed = [
      waitingOnAuthor({ needsYou: { reason: 'blocked' } }),
      waitingOnAuthor({ needsYou: { reason: 'claude-code', text: 'The made-up author pushed a fix' } }),
      waitingOnAuthor({ askedYou: { reason: 'question', excerpt: 'Shall I re-run the made-up check?' } }),
      waitingOnAuthor({ state: 'working' }),
      waitingOnAuthor({ status: 'busy' }),
      waitingOnAuthor({ waitingFor: 'input needed' }),
    ];
    const hashes = new Set([base, ...changed].map(needHash));
    expect(hashes.size).toBe(changed.length + 1);
  });
});

describe('readNotNeeded', () => {
  it('reads each id and hash, oldest mark first', () => {
    const { source } = memory({ [NOT_NEEDED_KEY]: stored([{ id: id(2), hash: HASH }, { id: id(1), hash: '0000000000000001' }]) });
    expect([...readNotNeeded(source)]).toEqual([
      [id(2), HASH],
      [id(1), '0000000000000001'],
    ]);
  });

  it('marks nothing when nothing is stored, or there is no storage', () => {
    expect(readNotNeeded(memory().source).size).toBe(0);
    expect(readNotNeeded(() => null).size).toBe(0);
    expect(readNotNeeded(() => undefined).size).toBe(0);
  });

  it('marks nothing when storage throws, on getItem or on reading the storage at all', () => {
    expect(readNotNeeded(() => ({ getItem: denied, setItem: denied })).size).toBe(0);
    expect(readNotNeeded(denied).size).toBe(0);
  });

  it("marks nothing for a value that isn't version 1's shape", () => {
    for (const raw of ['', 'not json', 'null', '[]', '"a"', '1', JSON.stringify({ entries: [{ id: id(1), hash: HASH }] }), JSON.stringify({ v: 2, entries: [{ id: id(1), hash: HASH }] }), JSON.stringify({ v: 1, entries: {} }), JSON.stringify({ v: 1 })]) {
      expect(readNotNeeded(memory({ [NOT_NEEDED_KEY]: raw }).source).size, raw).toBe(0);
    }
  });

  it("skips entries that aren't an id and a 16-digit hash, and keeps an id's last mark", () => {
    const { source } = memory({
      [NOT_NEEDED_KEY]: stored([
        null,
        id(9),
        { id: id(8) },
        { hash: HASH },
        { id: '', hash: HASH },
        { id: 'x'.repeat(257), hash: HASH },
        { id: id(7), hash: 'not a hash' },
        { id: id(6), hash: HASH.toUpperCase() },
        { id: id(5), hash: `${HASH}0` },
        { id: id(1), hash: '0000000000000001' },
        { id: id(2), hash: HASH },
        { id: id(1), hash: '0000000000000002' },
      ]),
    });
    expect([...readNotNeeded(source)]).toEqual([
      [id(2), HASH],
      [id(1), '0000000000000002'],
    ]);
  });

  it('keeps the newest 200 of a longer list, as one written by hand might be', () => {
    const entries = Array.from({ length: NOT_NEEDED_CAP + 5 }, (_, n) => ({ id: `made-up-${n}`, hash: HASH }));
    const read = readNotNeeded(memory({ [NOT_NEEDED_KEY]: stored(entries) }).source);
    expect(read.size).toBe(NOT_NEEDED_CAP);
    expect([...read.keys()][0]).toBe('made-up-5');
  });
});

describe('writeNotNeeded', () => {
  it('writes version 1 with ids and hashes alone, never what was needed', () => {
    const { items, source } = memory();
    const job = waitingOnAuthor();
    writeNotNeeded(withMark(new Map(), job), source);
    const raw = items.get(NOT_NEEDED_KEY)!;
    expect(JSON.parse(raw)).toEqual({ v: 1, entries: [{ id: job.sessionId, hash: needHash(job) }] });
    for (const text of [job.name, 'author', 'claude-code', 'blocked', 'idle']) expect(raw).not.toContain(text);
    expect(readNotNeeded(source).get(job.sessionId)).toBe(needHash(job));
  });

  it('ignores storage that throws or is missing', () => {
    const marks = new Map([[id(1), HASH]]);
    expect(() => writeNotNeeded(marks, () => ({ getItem: denied, setItem: denied }))).not.toThrow();
    expect(() => writeNotNeeded(marks, denied)).not.toThrow();
    expect(() => writeNotNeeded(marks, () => null)).not.toThrow();
  });
});

describe('withMark, withoutMark and pruned', () => {
  it('marks a session last, for what it needs now, and takes a mark away', () => {
    const one = waitingOnAuthor();
    const two = waitingOnAuthor({ sessionId: id(2) });
    const marks = withMark(withMark(new Map(), one), two);
    expect([...marks.keys()]).toEqual([one.sessionId, two.sessionId]);
    expect(marks.get(one.sessionId)).toBe(needHash(one));
    expect([...withoutMark(marks, one.sessionId).keys()]).toEqual([two.sessionId]);
  });

  it('changes nothing for a mark already made for the same need, or one that is not there', () => {
    const job = waitingOnAuthor();
    const marks = withMark(new Map(), job);
    expect(withMark(marks, waitingOnAuthor())).toBe(marks);
    expect(withoutMark(marks, id(9))).toBe(marks);
  });

  it('marks again, last, a session whose need has changed', () => {
    const job = waitingOnAuthor();
    const other = waitingOnAuthor({ sessionId: id(2) });
    const later = waitingOnAuthor({ needsYou: { reason: 'claude-code', text: 'Another made-up line' } });
    const marks = withMark(withMark(withMark(new Map(), job), other), later);
    expect([...marks]).toEqual([
      [other.sessionId, needHash(other)],
      [job.sessionId, needHash(later)],
    ]);
  });

  it('drops the oldest mark past the cap, so it holds at most 200', () => {
    let marks: NotNeeded = new Map();
    for (let n = 0; n < NOT_NEEDED_CAP + 3; n += 1) marks = withMark(marks, waitingOnAuthor({ sessionId: `made-up-${n}` }));
    expect(marks.size).toBe(NOT_NEEDED_CAP);
    expect([...marks.keys()][0]).toBe('made-up-3');
    expect([...marks.keys()].at(-1)).toBe(`made-up-${NOT_NEEDED_CAP + 2}`);
  });

  it('drops a mark once its session is listed needing something else, and keeps one whose session is missing', () => {
    const job = waitingOnAuthor();
    const gone = waitingOnAuthor({ sessionId: id(2) });
    const marks = withMark(withMark(new Map(), job), gone);
    // The same need, and the other session missing from the snapshot: nothing goes.
    expect(pruned(marks, [waitingOnAuthor()])).toBe(marks);
    expect(pruned(marks, [])).toBe(marks);
    // The author pushed a fix: the job's line changed.
    const next = pruned(marks, [waitingOnAuthor({ needsYou: { reason: 'claude-code', text: 'The made-up author pushed a fix' } })]);
    expect([...next.keys()]).toEqual([gone.sessionId]);
    // Done, needing nothing: its state changed.
    expect([...pruned(marks, [waitingOnAuthor({ state: 'done', needsYou: undefined, finished: true, alive: false })]).keys()]).toEqual([gone.sessionId]);
  });
});

describe('useNotNeeded', () => {
  it('reads the marks once, and marks and takes marks away, writing each change', () => {
    const job = waitingOnAuthor();
    const { items, source } = memory({ [NOT_NEEDED_KEY]: stored([{ id: id(5), hash: HASH }]) });
    const { result } = renderHook(() => useNotNeeded(source, tabs().events));
    expect([...result.current.entries.keys()]).toEqual([id(5)]);

    act(() => result.current.mark(job));
    expect(entriesIn(items)).toEqual([
      { id: id(5), hash: HASH },
      { id: job.sessionId, hash: needHash(job) },
    ]);
    expect(markedNow(job, result.current.entries)).toBe(true);

    act(() => result.current.unmark(id(5)));
    expect(entriesIn(items)).toEqual([{ id: job.sessionId, hash: needHash(job) }]);
  });

  it('writes nothing for a change that changes nothing, and two changes in one event both count', () => {
    const { writes, items, source } = memory();
    const { result } = renderHook(() => useNotNeeded(source, tabs().events));
    act(() => result.current.unmark(id(1)));
    act(() => result.current.prune([waitingOnAuthor()]));
    expect(writes).toEqual([]);
    act(() => {
      result.current.mark(waitingOnAuthor());
      result.current.mark(waitingOnAuthor({ sessionId: id(2) }));
    });
    expect(entriesIn(items).map((entry) => entry.id)).toEqual([id(1), id(2)]);
  });

  it('prunes what changed, writing once, and never what a snapshot leaves out', () => {
    const { items, writes, source } = memory();
    const { result } = renderHook(() => useNotNeeded(source, tabs().events));
    act(() => {
      result.current.mark(waitingOnAuthor());
      result.current.mark(waitingOnAuthor({ sessionId: id(2) }));
    });
    const before = writes.length;
    act(() => result.current.prune([]));
    expect(writes.length).toBe(before);
    act(() => result.current.prune([waitingOnAuthor({ status: 'busy' })]));
    expect(writes.length).toBe(before + 1);
    expect(entriesIn(items).map((entry) => entry.id)).toEqual([id(2)]);
  });

  it('holds the cap as marks are made, dropping the oldest', () => {
    const { items, source } = memory();
    const { result } = renderHook(() => useNotNeeded(source, tabs().events));
    act(() => {
      for (let n = 0; n < NOT_NEEDED_CAP + 3; n += 1) result.current.mark(waitingOnAuthor({ sessionId: `made-up-${n}` }));
    });
    expect(result.current.entries.size).toBe(NOT_NEEDED_CAP);
    expect(entriesIn(items)).toHaveLength(NOT_NEEDED_CAP);
    expect(entriesIn(items)[0]?.id).toBe('made-up-3');
  });

  it('follows a change made in another tab, and storage cleared, without writing it back', () => {
    const { items, writes, source } = memory({ [NOT_NEEDED_KEY]: stored([{ id: id(1), hash: HASH }]) });
    const other = tabs();
    const { result } = renderHook(() => useNotNeeded(source, other.events));
    items.set(NOT_NEEDED_KEY, stored([{ id: id(1), hash: HASH }, { id: id(2), hash: HASH }]));
    other.fire('pitwall.starred.v1');
    expect([...result.current.entries.keys()]).toEqual([id(1)]);
    other.fire(NOT_NEEDED_KEY);
    expect([...result.current.entries.keys()]).toEqual([id(1), id(2)]);
    items.clear();
    other.fire(null);
    expect(result.current.entries.size).toBe(0);
    expect(writes).toEqual([]);
    // A mark after it builds on what the other tab left.
    items.set(NOT_NEEDED_KEY, stored([{ id: id(7), hash: HASH }]));
    other.fire(NOT_NEEDED_KEY);
    act(() => result.current.mark(waitingOnAuthor()));
    expect(entriesIn(items).map((entry) => entry.id)).toEqual([id(7), id(1)]);
  });

  it('stops listening once it unmounts', () => {
    const other = tabs();
    const { unmount } = renderHook(() => useNotNeeded(memory().source, other.events));
    expect(other.listening()).toBe(1);
    unmount();
    expect(other.listening()).toBe(0);
  });

  it('works for the page when storage throws: nothing starts marked, and marks last in memory', () => {
    const job = waitingOnAuthor();
    for (const source of [() => ({ getItem: denied, setItem: denied }), denied] as StorageSource[]) {
      const { result } = renderHook(() => useNotNeeded(source, tabs().events));
      expect(result.current.entries.size).toBe(0);
      act(() => result.current.mark(job));
      expect(markedNow(job, result.current.entries)).toBe(true);
      act(() => result.current.prune([waitingOnAuthor({ status: 'busy' })]));
      expect(result.current.entries.size).toBe(0);
    }
  });
});

describe('what a mark does to needsAttention() and what it drives', () => {
  const job = waitingOnAuthor({ lastActivityAt: minutesAgo(1) });
  const asked = session({ sessionId: id(2), name: 'pitwall-test-asked', askedYou: { reason: 'question', excerpt: 'A made-up question?' }, lastActivityAt: minutesAgo(5) });
  const busy = session({ sessionId: id(3), name: 'pitwall-test-busy', status: 'busy', lastActivityAt: minutesAgo(9) });
  const idle = session({ sessionId: id(4), name: 'pitwall-test-idle', lastActivityAt: minutesAgo(20) });
  const marks = withMark(new Map(), job);

  it('takes a marked session out while it needs what it needed, and gives it back once that changes', () => {
    expect(needsAttention(job)).toBe(true);
    expect(needsAttention(job, marks)).toBe(false);
    expect(isNotNeeded(job, marks)).toBe(true);
    const changed = waitingOnAuthor({ needsYou: { reason: 'claude-code', text: 'The made-up author pushed a fix' } });
    expect(needsAttention(changed, marks)).toBe(true);
    expect(isNotNeeded(changed, marks)).toBe(false);
    // Never one that doesn't need you, marked or not.
    expect(isNotNeeded(idle, withMark(new Map(), idle))).toBe(false);
  });

  it('keeps the badge, outlined, since solid is for needing you, in the row and the view', () => {
    expect(statusBadge(job)).toEqual({ status: 'blocked', label: 'Blocked', look: 'solid-warning' });
    expect(statusBadge(job, marks)).toEqual({ status: 'blocked', label: 'Blocked', look: 'outline', notNeeded: true });
    expect(rowStatusBadge(job, marks)).toEqual({ status: 'blocked', label: 'Blocked', look: 'outline', notNeeded: true });
    expect(statusBadge(asked, withMark(new Map(), asked)).look).toBe('outline');
  });

  it('counts it nowhere: the views, the groups, the tabs and the title', () => {
    expect(countAttention([job, asked, busy, idle])).toBe(2);
    expect(countAttention([job, asked, busy, idle], marks)).toBe(1);
    const groups = [group({ sessions: [job, asked, busy, idle] })];
    expect(tabAttention(groups, '/Users/example/code')).toBe(2);
    expect(tabAttention(groups, '/Users/example/code', marks)).toBe(1);
  });

  it('leaves Needs you, and stays in All sessions and its group', () => {
    const groups = [group({ sessions: [job, asked, busy, idle] })];
    const names = (listed: { session: SessionSummary }[]) => listed.map(({ session: shown }) => shown.name);
    expect(names(listScope(groups, { kind: 'needs-you' }).current)).toEqual([job.name, asked.name]);
    expect(names(listScope(groups, { kind: 'needs-you' }, 'urgency', undefined, marks).current)).toEqual([asked.name]);
    expect(names(listScope(groups, { kind: 'all' }, 'urgency', undefined, marks).current)).toContain(job.name);
    expect(names(listScope(groups, { kind: 'group', group: groups[0]! }, 'urgency', undefined, marks).current)).toContain(job.name);
  });

  it('sorts it under Urgency as one that needs nothing, by its status, then its activity', () => {
    const order = (notNeeded?: NotNeeded) => [idle, busy, asked, job].sort(sessionOrder('urgency', false, notNeeded)).map((shown) => shown.name);
    expect(order()).toEqual([job.name, asked.name, busy.name, idle.name]);
    // Idle, active a minute ago: after the one that needs you and the busy one, before the older idle one.
    expect(order(marks)).toEqual([asked.name, busy.name, job.name, idle.name]);
    // Recent and Name don't look at needing you at all.
    expect([idle, busy, asked, job].sort(sessionOrder('recent', false, marks)).map((shown) => shown.name)).toEqual([job.name, asked.name, busy.name, idle.name]);
  });
});
