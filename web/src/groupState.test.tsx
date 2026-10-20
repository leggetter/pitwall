import { describe, expect, it } from 'vitest';
import { FINISHED_STATE_KEY, readGroupState, writeGroupState, type StorageSource } from './groupState.js';

function memory(initial?: string) {
  const items = new Map<string, string>(initial === undefined ? [] : [[FINISHED_STATE_KEY, initial]]);
  const source: StorageSource = () => ({
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  });
  return { items, source };
}

const denied = () => {
  throw new DOMException('The operation is insecure.', 'SecurityError');
};

describe('readGroupState', () => {
  it('is empty when nothing is stored, or there is no storage', () => {
    expect(readGroupState(memory().source)).toEqual(new Map());
    expect(readGroupState(() => null)).toEqual(new Map());
    expect(readGroupState(() => undefined)).toEqual(new Map());
  });

  it('reads each group id with its open state, skipping values that are not booleans', () => {
    const { source } = memory(JSON.stringify({ a: true, b: false, c: 'yes', d: 1, e: null }));
    expect(readGroupState(source)).toEqual(
      new Map([
        ['a', true],
        ['b', false],
      ]),
    );
  });

  it('is empty for stored data that is not a JSON object', () => {
    for (const raw of ['', 'not json', '[]', '[["a",true]]', 'null', 'true', '"a"']) {
      expect(readGroupState(memory(raw).source), raw).toEqual(new Map());
    }
  });

  it('is empty when storage throws, on getItem or on reading the storage at all', () => {
    expect(readGroupState(() => ({ getItem: denied, setItem: denied }))).toEqual(new Map());
    expect(readGroupState(denied)).toEqual(new Map());
  });
});

describe('writeGroupState', () => {
  it('stores the groups in the current snapshot and drops the rest', () => {
    const { items, source } = memory();
    const state = new Map([
      ['here', true],
      ['also-here', false],
      ['gone', true],
    ]);
    writeGroupState(state, new Set(['here', 'also-here', 'new']), source);
    expect(JSON.parse(items.get(FINISHED_STATE_KEY) ?? 'null')).toEqual({ here: true, 'also-here': false });
  });

  it('round-trips through readGroupState', () => {
    const { source } = memory();
    const state = new Map([['/root\0/root/repo', true]]);
    writeGroupState(state, new Set(state.keys()), source);
    expect(readGroupState(source)).toEqual(state);
  });

  it('ignores a storage that throws', () => {
    expect(() => writeGroupState(new Map([['a', true]]), new Set(['a']), () => ({ getItem: denied, setItem: denied }))).not.toThrow();
    expect(() => writeGroupState(new Map([['a', true]]), new Set(['a']), denied)).not.toThrow();
  });
});

describe('the key', () => {
  it('is pitwall.finished.v1, and pitwall.groups.v1 is never read or written', () => {
    expect(FINISHED_STATE_KEY).toBe('pitwall.finished.v1');
    const items = new Map<string, string>([['pitwall.groups.v1', JSON.stringify({ a: true })]]);
    const source: StorageSource = () => ({ getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) });
    expect(readGroupState(source)).toEqual(new Map());
    writeGroupState(new Map([['a', false]]), new Set(['a']), source);
    expect([...items.keys()]).toEqual(['pitwall.groups.v1', 'pitwall.finished.v1']);
    expect(items.get('pitwall.groups.v1')).toBe(JSON.stringify({ a: true }));
  });

  it('fails safe to empty, and ignores a failed write, when storage throws', () => {
    expect(readGroupState(denied, FINISHED_STATE_KEY)).toEqual(new Map());
    expect(() => writeGroupState(new Map([['a', true]]), new Set(['a']), denied, FINISHED_STATE_KEY)).not.toThrow();
  });
});
