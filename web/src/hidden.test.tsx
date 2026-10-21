import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StorageSource } from './groupState.js';
import { HIDDEN_KEY_PREFIX, hiddenKey, readHidden, useHiddenGroups, writeHidden, type HiddenGroup } from './hidden.js';
import { group, session } from './test/fixtures.js';

const ROOT = '/Users/example/code';
const WORK = '/Users/example/work';

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

const stored = (value: unknown) => JSON.stringify(value);
const old = (over: Partial<HiddenGroup> = {}): HiddenGroup => ({ root: ROOT, key: `${ROOT}/old-repo`, label: 'old-repo', kind: 'git', ...over });

describe('the key', () => {
  it("is pitwall.hidden.v1: and the root's path, exactly as the snapshot gives it", () => {
    expect(HIDDEN_KEY_PREFIX).toBe('pitwall.hidden.v1:');
    expect(hiddenKey(ROOT)).toBe('pitwall.hidden.v1:/Users/example/code');
    expect(hiddenKey('/srv/projects/')).toBe('pitwall.hidden.v1:/srv/projects/');
  });
});

describe('readHidden', () => {
  it('reads each group under the root, with its label and kind, and whether the section is open', () => {
    const { source } = memory({
      [hiddenKey(ROOT)]: stored({ v: 1, open: true, groups: [{ key: `${ROOT}/old-repo`, label: 'old-repo', kind: 'git' }, { key: ROOT, label: 'code', kind: 'directory' }] }),
    });
    expect(readHidden(ROOT, source)).toEqual({ groups: [old(), { root: ROOT, key: ROOT, label: 'code', kind: 'directory' }], open: true });
  });

  it('hides nothing when nothing is stored, or there is no storage', () => {
    expect(readHidden(ROOT, memory().source)).toEqual({ groups: [], open: false });
    expect(readHidden(ROOT, () => null)).toEqual({ groups: [], open: false });
    expect(readHidden(ROOT, () => undefined)).toEqual({ groups: [], open: false });
  });

  it('hides nothing when storage throws, on getItem or on reading the storage at all', () => {
    expect(readHidden(ROOT, () => ({ getItem: denied, setItem: denied }))).toEqual({ groups: [], open: false });
    expect(readHidden(ROOT, denied)).toEqual({ groups: [], open: false });
  });

  it("hides nothing for a value that isn't version 1's shape", () => {
    for (const raw of ['', 'not json', 'null', '[]', '"a"', '1', stored({ groups: [] }), stored({ v: 2, groups: [{ key: '/a', label: 'a', kind: 'git' }] }), stored({ v: '1', groups: [] }), stored({ v: 1, groups: {} }), stored({ v: 1 })]) {
      expect(readHidden(ROOT, memory({ [hiddenKey(ROOT)]: raw }).source), raw).toEqual({ groups: [], open: false });
    }
  });

  it('skips entries that are not groups, and counts a key listed twice once; open is true only when it says true', () => {
    const { source } = memory({
      [hiddenKey(ROOT)]: stored({
        v: 1,
        open: 'yes',
        groups: [null, 'old-repo', { key: '', label: 'x', kind: 'git' }, { key: '/a', label: 1, kind: 'git' }, { key: '/b', label: 'b', kind: 'folder' }, { key: `${ROOT}/old-repo`, label: 'old-repo', kind: 'git' }, { key: `${ROOT}/old-repo`, label: 'again', kind: 'directory' }],
      }),
    });
    expect(readHidden(ROOT, source)).toEqual({ groups: [old()], open: false });
  });

  it("reads only the root's own key", () => {
    const { source } = memory({ [hiddenKey(WORK)]: stored({ v: 1, open: true, groups: [{ key: `${WORK}/svc`, label: 'svc', kind: 'git' }] }) });
    expect(readHidden(ROOT, source)).toEqual({ groups: [], open: false });
    expect(readHidden(WORK, source).groups).toEqual([{ root: WORK, key: `${WORK}/svc`, label: 'svc', kind: 'git' }]);
  });
});

describe('writeHidden', () => {
  it("stores the root's groups as key, label and kind, with the version and the open state, and nothing else", () => {
    const { items, source } = memory();
    writeHidden(ROOT, [old(), old({ root: WORK, key: `${WORK}/svc`, label: 'svc' })], false, source);
    expect(items.get(hiddenKey(ROOT))).toBe('{"v":1,"open":false,"groups":[{"key":"/Users/example/code/old-repo","label":"old-repo","kind":"git"}]}');
    expect([...items.keys()]).toEqual([hiddenKey(ROOT)]);
  });

  it('round-trips through readHidden', () => {
    const { source } = memory();
    const groups = [old(), old({ key: ROOT, label: 'code', kind: 'directory' })];
    writeHidden(ROOT, groups, true, source);
    expect(readHidden(ROOT, source)).toEqual({ groups, open: true });
  });

  it('ignores a storage that throws', () => {
    expect(() => writeHidden(ROOT, [old()], true, () => ({ getItem: denied, setItem: denied }))).not.toThrow();
    expect(() => writeHidden(ROOT, [old()], true, denied)).not.toThrow();
  });
});

describe('useHiddenGroups', () => {
  const repo = (name: string, root = ROOT) => group({ key: `${root}/${name}`, label: name, root, sessions: [session({ name: `in-${name}`, cwd: `${root}/${name}` })] });

  it('reads nothing before there are roots, then each root once, as it appears', () => {
    const { source, writes } = memory({ [hiddenKey(ROOT)]: stored({ v: 1, open: false, groups: [{ key: `${ROOT}/old-repo`, label: 'old-repo', kind: 'git' }] }) });
    const { result, rerender } = renderHook(({ roots }) => useHiddenGroups(roots, source), { initialProps: { roots: [] as string[] } });
    expect(result.current.groups).toEqual([]);
    rerender({ roots: [ROOT] });
    expect(result.current.groups).toEqual([old()]);
    expect(result.current.open).toBe(false);
    expect(result.current.find(`${ROOT}/old-repo`)).toEqual(old());
    expect(result.current.find(`${ROOT}/old-repo`, WORK)).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("hides a group under its own root's key, opening the section, and unhides it", () => {
    const { items, source } = memory();
    const { result } = renderHook(() => useHiddenGroups([ROOT, WORK], source));
    act(() => result.current.hide(repo('svc', WORK)));
    expect(result.current.groups).toEqual([{ root: WORK, key: `${WORK}/svc`, label: 'svc', kind: 'git' }]);
    expect(result.current.open).toBe(true);
    expect(JSON.parse(items.get(hiddenKey(WORK)) ?? 'null')).toEqual({ v: 1, open: true, groups: [{ key: `${WORK}/svc`, label: 'svc', kind: 'git' }] });
    expect(items.has(hiddenKey(ROOT))).toBe(false);

    act(() => result.current.hide(repo('app')));
    act(() => result.current.hide(repo('app')));
    expect(result.current.groups.map((hidden) => hidden.key)).toEqual([`${ROOT}/app`, `${WORK}/svc`]);
    expect(JSON.parse(items.get(hiddenKey(ROOT)) ?? 'null').groups).toEqual([{ key: `${ROOT}/app`, label: 'app', kind: 'git' }]);

    act(() => result.current.unhide({ root: WORK, key: `${WORK}/svc` }));
    expect(result.current.groups.map((hidden) => hidden.key)).toEqual([`${ROOT}/app`]);
    expect(JSON.parse(items.get(hiddenKey(WORK)) ?? 'null')).toEqual({ v: 1, open: true, groups: [] });
  });

  it('writes the open state to every root with something hidden, and reads it open when any of them says so', () => {
    const { items, source } = memory({
      [hiddenKey(ROOT)]: stored({ v: 1, open: false, groups: [{ key: `${ROOT}/old-repo`, label: 'old-repo', kind: 'git' }] }),
      [hiddenKey(WORK)]: stored({ v: 1, open: true, groups: [{ key: `${WORK}/svc`, label: 'svc', kind: 'git' }] }),
      // Open, but nothing hidden: it opens nothing.
      [hiddenKey('/srv/empty')]: stored({ v: 1, open: true, groups: [] }),
    });
    const { result } = renderHook(() => useHiddenGroups([ROOT, WORK], source));
    expect(result.current.open).toBe(true);
    act(() => result.current.setOpen(false));
    expect(JSON.parse(items.get(hiddenKey(ROOT)) ?? 'null').open).toBe(false);
    expect(JSON.parse(items.get(hiddenKey(WORK)) ?? 'null').open).toBe(false);

    const empty = renderHook(() => useHiddenGroups(['/srv/empty'], source));
    expect(empty.result.current.open).toBe(false);
  });

  it("never prunes an entry, and leaves a root it doesn't watch alone", () => {
    const { items, source, writes } = memory({
      [hiddenKey(ROOT)]: stored({ v: 1, open: false, groups: [{ key: `${ROOT}/gone`, label: 'gone', kind: 'git' }] }),
      [hiddenKey('/srv/other')]: stored({ v: 1, open: false, groups: [{ key: '/srv/other/x', label: 'x', kind: 'git' }] }),
    });
    const { result } = renderHook(() => useHiddenGroups([ROOT], source));
    act(() => result.current.hide(repo('app')));
    expect(JSON.parse(items.get(hiddenKey(ROOT)) ?? 'null').groups.map((entry: { key: string }) => entry.key)).toEqual([`${ROOT}/gone`, `${ROOT}/app`]);
    expect(writes).toEqual([hiddenKey(ROOT)]);
    expect(result.current.groups.map((hidden) => hidden.key)).toEqual([`${ROOT}/gone`, `${ROOT}/app`]);
  });

  it('hides for the page’s life when storage is missing or throws, and never throws', () => {
    for (const source of [() => null, denied, () => ({ getItem: denied, setItem: denied })] as StorageSource[]) {
      const { result } = renderHook(() => useHiddenGroups([ROOT], source));
      expect(result.current.groups).toEqual([]);
      act(() => result.current.hide(repo('app')));
      expect(result.current.groups.map((hidden) => hidden.key)).toEqual([`${ROOT}/app`]);
      act(() => result.current.setOpen(false));
      expect(result.current.open).toBe(false);
      act(() => result.current.unhide({ root: ROOT, key: `${ROOT}/app` }));
      expect(result.current.groups).toEqual([]);
    }
  });
});
