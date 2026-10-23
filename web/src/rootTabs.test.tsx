// The root tabs' storage and rules (W38): pitwall.root-tab.v1 holds a root's path alone, read and
// written with groupState.ts's failure handling; which tab a selection opens; and a tab's groups and
// need-you count, by the index's SessionGroup.root.
import { describe, expect, it } from 'vitest';
import type { StorageSource } from './groupState.js';
import { readStoredTab, ROOT_TAB_KEY, selectionTab, tabAttention, tabGroups, writeStoredTab } from './rootTabs.js';
import { group, session, snapshot } from './test/fixtures.js';

const WORK = '/Users/example/work';
const PERSONAL = '/Users/example/personal';

function memory(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  const source: StorageSource = () => ({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) });
  return { values, source };
}

const throwing: StorageSource = () => {
  throw new Error('made-up: site data blocked');
};

describe('the stored tab', () => {
  it('is the root’s path alone, under pitwall.root-tab.v1', () => {
    const { values, source } = memory();
    writeStoredTab(PERSONAL, source);
    expect(ROOT_TAB_KEY).toBe('pitwall.root-tab.v1');
    expect([...values]).toEqual([['pitwall.root-tab.v1', '/Users/example/personal']]);
    expect(readStoredTab(source)).toBe(PERSONAL);
  });

  it('reads as none when storage is missing, throws, or holds nothing, and a write that fails is ignored', () => {
    expect(readStoredTab(() => null)).toBeUndefined();
    expect(readStoredTab(throwing)).toBeUndefined();
    expect(readStoredTab(memory({ [ROOT_TAB_KEY]: '' }).source)).toBeUndefined();
    expect(() => writeStoredTab(WORK, throwing)).not.toThrow();
    expect(() => writeStoredTab(WORK, () => ({ getItem: () => null, setItem: () => { throw new Error('made-up: full'); } }))).not.toThrow();
  });
});

describe('selectionTab', () => {
  const snap = snapshot([group({ key: `${PERSONAL}/blog`, label: 'blog', root: PERSONAL, sessions: [] })], { roots: [WORK, PERSONAL] });

  it('is undefined with one root', () => {
    expect(selectionTab({ root: WORK }, snapshot([]), WORK)).toBeUndefined();
  });

  it("is the selection's root, else its group's, else the stored tab, else the first root, ignoring roots pitwall doesn't watch", () => {
    expect(selectionTab({ root: PERSONAL }, snap, WORK)).toBe(PERSONAL);
    expect(selectionTab({ repo: `${PERSONAL}/blog` }, snap, WORK)).toBe(PERSONAL);
    expect(selectionTab({ repo: `${PERSONAL}/blog`, root: '/Users/example/gone' }, snap, WORK)).toBe(PERSONAL);
    expect(selectionTab({}, snap, PERSONAL)).toBe(PERSONAL);
    expect(selectionTab({}, snap, '/Users/example/gone')).toBe(WORK);
    expect(selectionTab({ root: '/Users/example/gone' }, snap, undefined)).toBe(WORK);
  });
});

describe("a tab's groups and badge", () => {
  it('are the groups the index put under its root, and their sessions that need you, added up', () => {
    const waits = (name: string) => session({ name, status: 'waiting', waitingFor: 'permission prompt' });
    const groups = [
      group({ key: `${WORK}/api`, label: 'api', root: WORK, sessions: [waits('api-waits'), session({ name: 'calm' })] }),
      group({ key: `${WORK}/web`, label: 'web', root: WORK, sessions: [waits('web-waits')] }),
      group({ key: `${PERSONAL}/blog`, label: 'blog', root: PERSONAL, sessions: [session({ name: 'asked', askedYou: { reason: 'question', excerpt: 'Made up?' } })] }),
    ];
    expect(tabGroups(groups, WORK).map((each) => each.label)).toEqual(['api', 'web']);
    expect(tabGroups(groups, undefined)).toBe(groups);
    expect(tabAttention(groups, WORK)).toBe(2);
    expect(tabAttention(groups, PERSONAL)).toBe(1);
    expect(tabAttention(groups, '/Users/example/none')).toBe(0);
  });
});
