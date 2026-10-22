// Starred sessions' storage (W53, starred.ts, docs/design-system.md, 4: Starred sessions):
// pitwall.starred.v1, ids only, validated, capped, never pruned, a change from another tab, and
// storage that's missing, malformed or throws.

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StorageSource } from './groupState.js';
import { MAX_ID_LENGTH, readStarred, STARRED_CAP, STARRED_KEY, useStarred, withStar, writeStarred, type StarredEvents } from './starred.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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

const stored = (ids: unknown) => JSON.stringify({ v: 1, ids });

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

describe('the key', () => {
  it('is pitwall.starred.v1, one for every root and tab on the origin', () => {
    expect(STARRED_KEY).toBe('pitwall.starred.v1');
  });
});

describe('readStarred', () => {
  it('reads the ids, oldest star first', () => {
    expect(readStarred(memory({ [STARRED_KEY]: stored([id(2), id(1)]) }).source)).toEqual([id(2), id(1)]);
  });

  it('stars nothing when nothing is stored, or there is no storage', () => {
    expect(readStarred(memory().source)).toEqual([]);
    expect(readStarred(() => null)).toEqual([]);
    expect(readStarred(() => undefined)).toEqual([]);
  });

  it('stars nothing when storage throws, on getItem or on reading the storage at all', () => {
    expect(readStarred(() => ({ getItem: denied, setItem: denied }))).toEqual([]);
    expect(readStarred(denied)).toEqual([]);
  });

  it("stars nothing for a value that isn't version 1's shape", () => {
    for (const raw of ['', 'not json', 'null', '[]', `["${id(1)}"]`, '"a"', '1', JSON.stringify({ ids: [id(1)] }), JSON.stringify({ v: 2, ids: [id(1)] }), JSON.stringify({ v: '1', ids: [id(1)] }), JSON.stringify({ v: 1, ids: {} }), JSON.stringify({ v: 1 })]) {
      expect(readStarred(memory({ [STARRED_KEY]: raw }).source), raw).toEqual([]);
    }
  });

  it('skips entries that are not ids, and counts an id listed twice once, where it was first starred', () => {
    const long = 'x'.repeat(MAX_ID_LENGTH + 1);
    const { source } = memory({ [STARRED_KEY]: stored([null, 1, '', long, { id: id(9) }, [id(8)], id(1), id(2), id(1)]) });
    expect(readStarred(source)).toEqual([id(1), id(2)]);
    expect(readStarred(memory({ [STARRED_KEY]: stored(['x'.repeat(MAX_ID_LENGTH)]) }).source)).toEqual(['x'.repeat(MAX_ID_LENGTH)]);
  });

  it('keeps the newest STARRED_CAP ids of a longer list, as one written by hand might be', () => {
    const ids = Array.from({ length: STARRED_CAP + 5 }, (_, n) => id(n));
    expect(readStarred(memory({ [STARRED_KEY]: stored(ids) }).source)).toEqual(ids.slice(5));
  });
});

describe('writeStarred', () => {
  it('writes version 1 with the ids alone', () => {
    const { items, source } = memory();
    writeStarred([id(1), id(2)], source);
    expect(JSON.parse(items.get(STARRED_KEY)!)).toEqual({ v: 1, ids: [id(1), id(2)] });
    expect(readStarred(source)).toEqual([id(1), id(2)]);
  });

  it('ignores storage that throws or is missing', () => {
    expect(() => writeStarred([id(1)], () => ({ getItem: denied, setItem: denied }))).not.toThrow();
    expect(() => writeStarred([id(1)], denied)).not.toThrow();
    expect(() => writeStarred([id(1)], () => null)).not.toThrow();
  });
});

describe('withStar', () => {
  it('stars a session last, and unstars one wherever it is', () => {
    expect(withStar([id(1)], id(2), true)).toEqual([id(1), id(2)]);
    expect(withStar([id(1), id(2), id(3)], id(2), false)).toEqual([id(1), id(3)]);
  });

  it('changes nothing for a session already starred, or one that is not, and keeps the place of the first', () => {
    const ids = [id(1), id(2)];
    expect(withStar(ids, id(1), true)).toBe(ids);
    expect(withStar(ids, id(3), false)).toBe(ids);
  });

  it('drops the oldest star past the cap, so the list holds at most STARRED_CAP', () => {
    const full = Array.from({ length: STARRED_CAP }, (_, n) => id(n));
    const next = withStar(full, id(1000), true);
    expect(next).toHaveLength(STARRED_CAP);
    expect(next[0]).toBe(id(1));
    expect(next.at(-1)).toBe(id(1000));
    expect(next).not.toContain(id(0));
  });
});

describe('useStarred', () => {
  it('reads the stars once, and stars and unstars, writing each change', () => {
    const { items, source } = memory({ [STARRED_KEY]: stored([id(1)]) });
    const { events } = tabs();
    const { result } = renderHook(() => useStarred(source, events));
    expect(result.current.ids).toEqual([id(1)]);
    expect(result.current.set.has(id(1))).toBe(true);

    act(() => result.current.star(id(2), true));
    expect(result.current.ids).toEqual([id(1), id(2)]);
    expect(JSON.parse(items.get(STARRED_KEY)!)).toEqual({ v: 1, ids: [id(1), id(2)] });

    act(() => result.current.star(id(1), false));
    expect(result.current.ids).toEqual([id(2)]);
    expect(result.current.set.has(id(1))).toBe(false);
    expect(JSON.parse(items.get(STARRED_KEY)!)).toEqual({ v: 1, ids: [id(2)] });
  });

  it("writes nothing for a change that changes nothing, and two stars in one event both count", () => {
    const { writes, items, source } = memory();
    const { result } = renderHook(() => useStarred(source, tabs().events));
    act(() => result.current.star(id(1), false));
    expect(writes).toEqual([]);
    act(() => {
      result.current.star(id(1), true);
      result.current.star(id(2), true);
    });
    expect(result.current.ids).toEqual([id(1), id(2)]);
    expect(JSON.parse(items.get(STARRED_KEY)!).ids).toEqual([id(1), id(2)]);
  });

  it('never prunes a star whose session is missing: nothing it reads or writes depends on a snapshot', () => {
    const { source } = memory({ [STARRED_KEY]: stored([id(1), id(2)]) });
    const { result, rerender } = renderHook(() => useStarred(source, tabs().events));
    rerender();
    act(() => result.current.star(id(3), true));
    expect(result.current.ids).toEqual([id(1), id(2), id(3)]);
  });

  it('holds the cap as stars are added, dropping the oldest', () => {
    const { items, source } = memory();
    const { result } = renderHook(() => useStarred(source, tabs().events));
    act(() => {
      for (let n = 0; n < STARRED_CAP + 3; n += 1) result.current.star(id(n), true);
    });
    expect(result.current.ids).toHaveLength(STARRED_CAP);
    expect(result.current.ids[0]).toBe(id(3));
    expect(JSON.parse(items.get(STARRED_KEY)!).ids).toHaveLength(STARRED_CAP);
  });

  it('follows a change made in another tab, and storage cleared, without writing it back', () => {
    const { items, writes, source } = memory({ [STARRED_KEY]: stored([id(1)]) });
    const other = tabs();
    const { result } = renderHook(() => useStarred(source, other.events));
    items.set(STARRED_KEY, stored([id(1), id(5)]));
    other.fire('pitwall.sort.v1');
    expect(result.current.ids).toEqual([id(1)]);
    other.fire(STARRED_KEY);
    expect(result.current.ids).toEqual([id(1), id(5)]);
    items.clear();
    other.fire(null);
    expect(result.current.ids).toEqual([]);
    expect(writes).toEqual([]);
    // A star after it builds on what the other tab left.
    items.set(STARRED_KEY, stored([id(7)]));
    other.fire(STARRED_KEY);
    act(() => result.current.star(id(8), true));
    expect(JSON.parse(items.get(STARRED_KEY)!).ids).toEqual([id(7), id(8)]);
  });

  it('stops listening once it unmounts', () => {
    const other = tabs();
    const { unmount } = renderHook(() => useStarred(memory().source, other.events));
    expect(other.listening()).toBe(1);
    unmount();
    expect(other.listening()).toBe(0);
  });

  it('works for the page when storage throws: nothing starts starred, and stars last in memory', () => {
    const { result } = renderHook(() => useStarred(() => ({ getItem: denied, setItem: denied }), tabs().events));
    expect(result.current.ids).toEqual([]);
    act(() => result.current.star(id(1), true));
    expect(result.current.ids).toEqual([id(1)]);
    const blocked = renderHook(() => useStarred(denied, tabs().events));
    act(() => blocked.result.current.star(id(2), true));
    expect(blocked.result.current.ids).toEqual([id(2)]);
  });
});
