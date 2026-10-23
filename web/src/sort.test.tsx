// The Sort setting's storage (docs/design-system.md, 3: Session list): pitwall.sort.v1, one setting
// for every selection, and Urgency whenever there's nothing usable stored.
import { describe, expect, it } from 'vitest';
import type { StorageSource } from './groupState.js';
import { DEFAULT_SORT, readSort, SORT_KEY, writeSort } from './sort.js';

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: StorageSource = () => ({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  });
  return { values, storage };
}

const denied: StorageSource = () => {
  throw new DOMException('The operation is insecure.', 'SecurityError');
};

describe('the Sort setting in storage', () => {
  it('is kept under pitwall.sort.v1', () => {
    expect(SORT_KEY).toBe('pitwall.sort.v1');
    const { values, storage } = memory();
    writeSort('name', storage);
    expect(values.get('pitwall.sort.v1')).toBe('name');
    expect(readSort(storage)).toBe('name');
  });

  it('reads each of the three orders back', () => {
    for (const order of ['urgency', 'recent', 'name'] as const) expect(readSort(memory({ [SORT_KEY]: order }).storage)).toBe(order);
  });

  it('is Urgency with nothing stored, something else stored, or storage that throws', () => {
    expect(DEFAULT_SORT).toBe('urgency');
    expect(readSort(memory().storage)).toBe('urgency');
    expect(readSort(memory({ [SORT_KEY]: 'Name' }).storage)).toBe('urgency');
    expect(readSort(memory({ [SORT_KEY]: '"name"' }).storage)).toBe('urgency');
    expect(readSort(denied)).toBe('urgency');
    expect(() => writeSort('recent', denied)).not.toThrow();
  });
});
