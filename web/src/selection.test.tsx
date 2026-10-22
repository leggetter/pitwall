// The repo list's selection in the URL (docs/design-system.md, 3: Repo list): ?view=needs-you,
// ?view=all, ?view=starred (W53) or ?repo=<key>, with &root=<root> when there's more than one root; pitwall.view.v1 for a
// URL with none; popstate; and ?session= selecting its session's group.
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { IndexSnapshot } from '../../src/shared/protocol.js';
import type { StorageSource } from './groupState.js';
import {
  ALL_SESSIONS,
  findGroup,
  finishedStateId,
  groupSelection,
  NEEDS_YOU,
  parseSelection,
  readStoredSelection,
  rootedSelection,
  sameSelection,
  scopeFor,
  selectionHref,
  selectionName,
  useSelection,
  VIEW_STATE_KEY,
  viewIn,
  withSelection,
  writeStoredSelection,
  type NavigationEnv,
  type Selection,
} from './selection.js';
import { group, session, snapshot } from './test/fixtures.js';

const ROOT = '/Users/example/code';
const WORK = '/Users/example/work';

describe('parseSelection and withSelection', () => {
  it('reads the two views and a group, with or without its root', () => {
    expect(parseSelection('?view=needs-you')).toEqual(NEEDS_YOU);
    expect(parseSelection('?view=all&session=abc')).toEqual(ALL_SESSIONS);
    expect(parseSelection(`?repo=${ROOT}/pitwall`)).toEqual({ repo: `${ROOT}/pitwall` });
    expect(parseSelection(`?repo=${WORK}/api&root=${WORK}`)).toEqual({ repo: `${WORK}/api`, root: WORK });
  });

  it('reads and writes Starred, with or without its root (W53)', () => {
    expect(parseSelection('?view=starred')).toEqual({ view: 'starred' });
    expect(parseSelection(`?view=starred&root=${WORK}&session=abc`)).toEqual({ view: 'starred', root: WORK });
    expect(withSelection('?session=abc', viewIn('starred', WORK))).toBe('?view=starred&root=/Users/example/work&session=abc');
    expect(selectionHref({ view: 'starred' })).toBe('?view=starred');
    expect(sameSelection({ view: 'starred' }, ALL_SESSIONS)).toBe(false);
    for (const search of ['?view=Starred', '?view=star', '?view=pinned']) expect(parseSelection(search), search).toBeUndefined();
  });

  it('has no selection for no parameters, an unknown view or an empty repo', () => {
    for (const search of ['', '?', '?session=abc', '?view=mine', '?view=', '?repo=', '?root=/x']) expect(parseSelection(search), search).toBeUndefined();
  });

  it('writes the selection, keeping every other parameter, with paths left readable', () => {
    expect(withSelection('', NEEDS_YOU)).toBe('?view=needs-you');
    expect(withSelection('?session=abc&view=all', { repo: `${ROOT}/pitwall` })).toBe('?repo=/Users/example/code/pitwall&session=abc');
    expect(withSelection('?repo=/a&root=/b', ALL_SESSIONS)).toBe('?view=all');
    expect(withSelection('', { repo: `${WORK}/a b&c`, root: WORK })).toBe('?repo=/Users/example/work/a%20b%26c&root=/Users/example/work');
  });

  it('round-trips any path through the URL', () => {
    const selections: Selection[] = [NEEDS_YOU, ALL_SESSIONS, { view: 'starred' }, { repo: '~/odd path/#1?&=+%' }, { repo: '/a:b@c,d', root: '/a' }];
    for (const selection of selections) expect(parseSelection(withSelection('', selection))).toEqual(selection);
  });

  it("reads and writes a view's root, which with several roots names the open root tab (W38)", () => {
    expect(parseSelection(`?view=all&root=${WORK}`)).toEqual({ view: 'all', root: WORK });
    expect(parseSelection(`?view=needs-you&root=`)).toEqual(NEEDS_YOU);
    expect(withSelection('?session=abc', { view: 'needs-you', root: WORK })).toBe('?view=needs-you&root=/Users/example/work&session=abc');
    expect(viewIn('all', undefined)).toEqual(ALL_SESSIONS);
    expect(viewIn('all', WORK)).toEqual({ view: 'all', root: WORK });
    expect(sameSelection({ view: 'all', root: WORK }, ALL_SESSIONS)).toBe(false);
    expect(sameSelection({ view: 'all', root: WORK }, { view: 'all', root: WORK })).toBe(true);
    expect(sameSelection({ view: 'all', root: WORK }, { view: 'needs-you', root: WORK })).toBe(false);
  });

  it('never carries the token, which lives in sessionStorage, not the query string', () => {
    expect(withSelection('?view=all', ALL_SESSIONS)).not.toMatch(/token/);
    expect(selectionHref({ repo: `${ROOT}/pitwall` })).toBe('?repo=/Users/example/code/pitwall');
  });
});

describe('groups and selections', () => {
  const app = group({ key: `${ROOT}/app`, label: 'app', sessions: [session({ name: 'one' })] });
  // A worktree grouped under its main repo's key, but listed under a second root.
  const appElsewhere = group({ key: `${ROOT}/app`, label: '~/code/app', root: WORK, sessions: [session({ name: 'two' })] });

  it("names a group by its key, and adds the root only when there's more than one", () => {
    expect(groupSelection(app, [ROOT])).toEqual({ repo: `${ROOT}/app` });
    expect(groupSelection(appElsewhere, [ROOT, WORK])).toEqual({ repo: `${ROOT}/app`, root: WORK });
  });

  it('finds the group a selection names, telling two with the same key apart by root', () => {
    expect(findGroup([app, appElsewhere], { repo: `${ROOT}/app` })).toBe(app);
    expect(findGroup([app, appElsewhere], { repo: `${ROOT}/app`, root: WORK })).toBe(appElsewhere);
    expect(findGroup([app], { repo: `${ROOT}/gone` })).toBeUndefined();
    expect(findGroup([app], ALL_SESSIONS)).toBeUndefined();
  });

  it('gives each selection its scope, and none for a group that has left the snapshot', () => {
    expect(scopeFor([app], NEEDS_YOU)).toEqual({ kind: 'needs-you' });
    expect(scopeFor([app], ALL_SESSIONS)).toEqual({ kind: 'all' });
    expect(scopeFor([app], { repo: `${ROOT}/app` })).toEqual({ kind: 'group', group: app });
    expect(scopeFor([app], { repo: `${ROOT}/gone` })).toBeUndefined();
    // Starred's is the starred ids, or none (W53).
    const ids = new Set([app.sessions[0]!.sessionId]);
    expect(scopeFor([app], { view: 'starred' }, ids)).toEqual({ kind: 'starred', ids });
    expect(scopeFor([app], { view: 'starred' })).toEqual({ kind: 'starred', ids: new Set() });
  });

  it('names a selection on screen, and a group that has gone by its key', () => {
    expect(selectionName([app], NEEDS_YOU)).toBe('Needs you');
    expect(selectionName([app], ALL_SESSIONS)).toBe('All sessions');
    expect(selectionName([app], { view: 'starred', root: WORK })).toBe('Starred');
    expect(selectionName([app], { repo: `${ROOT}/app` })).toBe('app');
    expect(selectionName([], { repo: `${ROOT}/gone/` })).toBe('gone');
  });

  it("keeps a Finished section's state for All sessions, Starred and each group, and has none for Needs you", () => {
    expect(finishedStateId(ALL_SESSIONS, undefined)).toBe('view:all');
    expect(finishedStateId({ view: 'starred', root: WORK }, undefined)).toBe('view:starred');
    expect(finishedStateId(NEEDS_YOU, undefined)).toBeUndefined();
    expect(finishedStateId({ repo: `${ROOT}/app` }, app)).toBe(`${ROOT}\0${ROOT}/app`);
  });

  it('compares selections', () => {
    expect(sameSelection(ALL_SESSIONS, { view: 'all' })).toBe(true);
    expect(sameSelection(ALL_SESSIONS, NEEDS_YOU)).toBe(false);
    expect(sameSelection({ repo: '/a' }, { repo: '/a' })).toBe(true);
    expect(sameSelection({ repo: '/a' }, { repo: '/a', root: '/r' })).toBe(false);
    expect(sameSelection({ repo: '/a' }, ALL_SESSIONS)).toBe(false);
  });
});

/** localStorage of its own. */
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const source: StorageSource = () => ({ getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) });
  return { items, source };
}

describe('the stored selection', () => {
  it('round-trips through pitwall.view.v1, as the URL writes it', () => {
    const { items, source } = memoryStorage();
    writeStoredSelection({ repo: `${WORK}/api`, root: WORK }, source);
    expect(items.get(VIEW_STATE_KEY)).toBe('repo=/Users/example/work/api&root=/Users/example/work');
    expect(readStoredSelection(source)).toEqual({ repo: `${WORK}/api`, root: WORK });
  });

  it('is none when missing, unreadable or blocked, and writing to blocked storage is harmless', () => {
    const denied = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    expect(readStoredSelection(memoryStorage().source)).toBeUndefined();
    expect(readStoredSelection(memoryStorage({ [VIEW_STATE_KEY]: 'view=nope' }).source)).toBeUndefined();
    expect(readStoredSelection(denied)).toBeUndefined();
    expect(() => writeStoredSelection(ALL_SESSIONS, denied)).not.toThrow();
  });
});

/** The address bar and history, in memory, recording each push and replace, with a way to go back. */
function fakeNavigation(search = '') {
  const listeners = new Set<() => void>();
  const entries = [search];
  let at = 0;
  const pushes: string[] = [];
  const replaces: string[] = [];
  const location = { pathname: '/', search, hash: '' };
  const searchOf = (url: string | URL | null | undefined) => new URL(String(url), 'http://127.0.0.1:4517/').search;
  const navigation: NavigationEnv = {
    location,
    history: {
      state: null,
      pushState(_state, _unused, url) {
        location.search = searchOf(url);
        entries.splice(at + 1, Infinity, location.search);
        at += 1;
        pushes.push(location.search);
      },
      replaceState(_state, _unused, url) {
        location.search = searchOf(url);
        entries[at] = location.search;
        replaces.push(location.search);
      },
    },
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
  };
  const back = () => {
    at -= 1;
    location.search = entries[at] ?? '';
    for (const listener of listeners) listener();
  };
  return { navigation, location, pushes, replaces, back };
}

function renderSelection(snap: IndexSnapshot | undefined, search = '', stored: Record<string, string> = {}) {
  const nav = fakeNavigation(search);
  const storage = memoryStorage(stored);
  const hook = renderHook(({ current }: { current: IndexSnapshot | undefined }) => useSelection(current, { navigation: nav.navigation, storage: storage.source }), {
    initialProps: { current: snap },
  });
  return { ...nav, ...storage, hook, selection: () => hook.result.current[0], choose: (next: Selection) => act(() => hook.result.current[1](next)) };
}

describe('useSelection', () => {
  const pitwall = group({ key: `${ROOT}/pitwall`, label: 'pitwall', sessions: [session({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'one' })] });
  const snap = snapshot([pitwall]);

  it('takes the selection from the URL, and leaves the URL as it is', () => {
    const { selection, replaces, pushes } = renderSelection(snap, '?view=needs-you');

    expect(selection()).toEqual(NEEDS_YOU);
    expect([...replaces, ...pushes]).toEqual([]);
  });

  it('with none in the URL, takes All sessions the first time, and replaces the URL to match', () => {
    const { selection, replaces, pushes } = renderSelection(snap);

    expect(selection()).toEqual(ALL_SESSIONS);
    expect(replaces.at(-1)).toBe('?view=all');
    expect(pushes).toEqual([]);
  });

  it('with none in the URL, takes the last one chosen, from pitwall.view.v1', () => {
    const { selection, location } = renderSelection(snap, '', { [VIEW_STATE_KEY]: `repo=${ROOT}/pitwall` });

    expect(selection()).toEqual({ repo: `${ROOT}/pitwall` });
    expect(location.search).toBe('?repo=/Users/example/code/pitwall');
  });

  it('pushes a history entry for each choice, stores it, and follows the URL back with popstate', () => {
    const { selection, choose, pushes, items, back } = renderSelection(snap, '?view=all');

    choose({ repo: `${ROOT}/pitwall` });
    expect(selection()).toEqual({ repo: `${ROOT}/pitwall` });
    expect(pushes).toEqual(['?repo=/Users/example/code/pitwall']);
    expect(items.get(VIEW_STATE_KEY)).toBe('repo=/Users/example/code/pitwall');

    choose(NEEDS_YOU);
    act(() => back());
    expect(selection()).toEqual({ repo: `${ROOT}/pitwall` });
    act(() => back());
    expect(selection()).toEqual(ALL_SESSIONS);
  });

  it("doesn't push an entry for choosing what's already selected", () => {
    const { choose, pushes } = renderSelection(snap, '?view=all');

    choose(ALL_SESSIONS);
    expect(pushes).toEqual([]);
  });

  it('keeps the other parameters, such as ?session=, as it changes the selection', () => {
    const { choose, location } = renderSelection(snap, '?view=all&session=abc');

    choose(NEEDS_YOU);
    expect(location.search).toBe('?view=needs-you&session=abc');
  });

  it('with ?session= and no selection, selects that session\'s group once the snapshot arrives', () => {
    const { selection, hook, location, pushes } = renderSelection(undefined, '?session=aaaaaaaa-0000-4000-8000-000000000001', {
      [VIEW_STATE_KEY]: 'view=needs-you',
    });
    // Nothing is written to the URL until the snapshot says which group it is.
    expect(location.search).toBe('?session=aaaaaaaa-0000-4000-8000-000000000001');

    hook.rerender({ current: snap });
    expect(selection()).toEqual({ repo: `${ROOT}/pitwall` });
    expect(location.search).toBe('?repo=/Users/example/code/pitwall&session=aaaaaaaa-0000-4000-8000-000000000001');
    expect(pushes).toEqual([]);
  });

  it('with ?session= for a session that isn\'t listed, falls back to the stored selection', () => {
    const { selection, hook, location } = renderSelection(undefined, '?session=nope', { [VIEW_STATE_KEY]: 'view=needs-you' });

    hook.rerender({ current: snap });
    expect(selection()).toEqual(NEEDS_YOU);
    expect(location.search).toBe('?view=needs-you&session=nope');
  });

  it("with ?session= and a selection, keeps the selection: the URL's says what to show", () => {
    const { selection, hook } = renderSelection(undefined, '?view=needs-you&session=aaaaaaaa-0000-4000-8000-000000000001');

    hook.rerender({ current: snap });
    expect(selection()).toEqual(NEEDS_YOU);
  });
});

describe('rootedSelection (W38)', () => {
  const two = snapshot(
    [group({ key: `${ROOT}/api`, label: 'api', sessions: [] }), group({ key: `${WORK}/api`, label: 'api', root: WORK, sessions: [] }), group({ key: `${WORK}/web`, label: 'web', root: WORK, sessions: [] })],
    { roots: [ROOT, WORK] },
  );
  const one = snapshot([group({ key: `${ROOT}/api`, label: 'api', sessions: [] })]);

  it('with several roots, gives a selection its tab: its own root, its group’s, the stored tab, or the first', () => {
    const rooted = { view: 'all', root: WORK } as const;
    expect(rootedSelection(rooted, two, undefined)).toBe(rooted);
    expect(rootedSelection(ALL_SESSIONS, two, WORK)).toEqual({ view: 'all', root: WORK });
    expect(rootedSelection(ALL_SESSIONS, two, '/Users/example/gone')).toEqual({ view: 'all', root: ROOT });
    expect(rootedSelection({ view: 'all', root: '/Users/example/gone' }, two, undefined)).toEqual({ view: 'all', root: ROOT });
    // A group named without a root: the first with its key, as findGroup picks it.
    expect(rootedSelection({ repo: `${WORK}/web` }, two, undefined)).toEqual({ repo: `${WORK}/web`, root: WORK });
    expect(rootedSelection({ repo: `${ROOT}/api` }, two, WORK)).toEqual({ repo: `${ROOT}/api`, root: ROOT });
    // One no snapshot lists: the stored tab's, where it shows as gone.
    expect(rootedSelection({ repo: `${WORK}/gone` }, two, WORK)).toEqual({ repo: `${WORK}/gone`, root: WORK });
  });

  it('with one root, drops a view’s root and leaves a group as it is', () => {
    expect(rootedSelection({ view: 'needs-you', root: ROOT }, one, undefined)).toEqual(NEEDS_YOU);
    const group = { repo: `${ROOT}/api`, root: ROOT };
    expect(rootedSelection(group, one, undefined)).toBe(group);
    expect(rootedSelection(ALL_SESSIONS, one, WORK)).toBe(ALL_SESSIONS);
  });
});
