// The theme mechanism (docs/design-system.md, 2.2): web/public/theme-init.js, which runs before the
// first paint, and theme.ts, which keeps data-theme right afterwards. Both against fake storage and a
// fake prefers-color-scheme query, so nothing here depends on the machine running the tests.
import { describe, expect, it, vi } from 'vitest';
import themeInit from '../public/theme-init.js?raw';
import type { StorageSource } from './groupState.js';
import { createThemeStore, DARK_QUERY, parseThemeChoice, readThemeChoice, resolveTheme, THEME_KEY, writeThemeChoice } from './theme.js';

/** A prefers-color-scheme: dark query whose answer a test can change, firing `change` as a browser does. */
function fakeQuery(matches: boolean) {
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  return {
    queries,
    matches,
    addEventListener(_type: 'change', listener: () => void) {
      listeners.add(listener);
    },
    flip(next: boolean) {
      this.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

type Stored = string | null | 'blocked';

/** localStorage holding `stored` under the theme key, or one that throws on every read and write. */
function fakeStorage(stored: Stored) {
  const values = new Map<string, string>();
  if (stored !== null && stored !== 'blocked') values.set(THEME_KEY, stored);
  const deny = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return {
    values,
    getItem: (key: string) => (stored === 'blocked' ? deny() : (values.get(key) ?? null)),
    setItem: (key: string, value: string) => (stored === 'blocked' ? deny() : void values.set(key, value)),
  };
}

interface Case {
  name: string;
  stored: Stored;
  /** Whether the system prefers dark, or undefined for a browser with no matchMedia. */
  systemDark: boolean | undefined;
  /** Reading window.localStorage itself throws, as when site data is blocked. */
  storageGetterThrows?: boolean;
  /** The data-theme that results, or null for none. */
  expected: 'light' | 'dark' | null;
}

const CASES: Case[] = [
  { name: 'stored dark, system light', stored: 'dark', systemDark: false, expected: 'dark' },
  { name: 'stored light, system dark', stored: 'light', systemDark: true, expected: 'light' },
  { name: 'stored system, system dark', stored: 'system', systemDark: true, expected: 'dark' },
  { name: 'stored system, system light', stored: 'system', systemDark: false, expected: 'light' },
  { name: 'nothing stored, system dark', stored: null, systemDark: true, expected: 'dark' },
  { name: 'nothing stored, system light', stored: null, systemDark: false, expected: 'light' },
  { name: 'something else stored', stored: 'solarized', systemDark: true, expected: 'dark' },
  { name: 'storage blocked on read', stored: 'blocked', systemDark: true, expected: 'dark' },
  { name: 'storage blocked outright', stored: 'dark', systemDark: false, storageGetterThrows: true, expected: 'light' },
  { name: 'nothing stored, no matchMedia', stored: null, systemDark: undefined, expected: null },
  { name: 'stored dark, no matchMedia', stored: 'dark', systemDark: undefined, expected: 'dark' },
];

/** Runs theme-init.js as the browser would, with `window` and `document` replaced by fakes. */
function runThemeInit(test: Case) {
  const storage = fakeStorage(test.stored);
  const query = test.systemDark === undefined ? undefined : fakeQuery(test.systemDark);
  const fakeWindow: Record<string, unknown> = {};
  Object.defineProperty(fakeWindow, 'localStorage', {
    get: () => {
      if (test.storageGetterThrows) throw new DOMException('The operation is insecure.', 'SecurityError');
      return storage;
    },
  });
  if (query) {
    fakeWindow.matchMedia = (media: string) => {
      query.queries.push(media);
      return query;
    };
  }
  const root = document.createElement('html');
  // The script is ours, read as text, run against the fakes.
  new Function('window', 'document', themeInit)(fakeWindow, { documentElement: root });
  return { root, query };
}

/** createThemeStore on the same fakes. */
function storeFor(test: Case) {
  const storage = fakeStorage(test.stored);
  const source: StorageSource = () => {
    if (test.storageGetterThrows) throw new DOMException('The operation is insecure.', 'SecurityError');
    return storage;
  };
  const query = test.systemDark === undefined ? undefined : fakeQuery(test.systemDark);
  const root = document.createElement('html');
  const store = createThemeStore({ storage: source, darkQuery: () => query, root: () => root });
  return { store, root, query, storage };
}

describe('theme-init.js', () => {
  it.each(CASES)('$name: data-theme is $expected', (test) => {
    const { root } = runThemeInit(test);
    expect(root.getAttribute('data-theme')).toBe(test.expected);
  });

  it('asks the system with prefers-color-scheme: dark, only when System is chosen', () => {
    expect(runThemeInit({ name: '', stored: null, systemDark: false, expected: 'light' }).query?.queries).toEqual([DARK_QUERY]);
    expect(runThemeInit({ name: '', stored: 'light', systemDark: true, expected: 'light' }).query?.queries).toEqual([]);
  });

  it("doesn't throw when storage is blocked", () => {
    expect(() => runThemeInit({ name: '', stored: 'blocked', systemDark: false, expected: 'light' })).not.toThrow();
    expect(() => runThemeInit({ name: '', stored: null, systemDark: false, storageGetterThrows: true, expected: 'light' })).not.toThrow();
  });

  it('reaches storage and matchMedia only through window, so the fakes above are what it reads', () => {
    const code = themeInit.replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/(?<!window\.)\b(?:localStorage|matchMedia|sessionStorage)\b/);
    expect(themeInit).toContain(`'${THEME_KEY}'`);
  });

  it('is plain script: no module syntax, which a classic <script> would reject', () => {
    expect(themeInit).not.toMatch(/^\s*(?:import|export)\b/m);
  });
});

describe('theme.ts agrees with theme-init.js', () => {
  it.each(CASES)('$name', (test) => {
    const { root } = storeFor(test);
    expect(root.getAttribute('data-theme')).toBe(runThemeInit(test).root.getAttribute('data-theme'));
  });
});

describe('the theme store', () => {
  const lightSystem: Case = { name: '', stored: null, systemDark: false, expected: 'light' };

  it('starts from the stored choice', () => {
    expect(storeFor({ ...lightSystem, stored: 'dark' }).store.get()).toEqual({ choice: 'dark', resolved: 'dark' });
    expect(storeFor(lightSystem).store.get()).toEqual({ choice: 'system', resolved: 'light' });
  });

  it('stores a new choice and shows it at once, telling subscribers', () => {
    const { store, root, storage } = storeFor(lightSystem);
    let told = 0;
    store.subscribe(() => {
      told += 1;
    });
    store.set('dark');
    expect(storage.values.get(THEME_KEY)).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(store.get()).toEqual({ choice: 'dark', resolved: 'dark' });
    expect(told).toBe(1);
  });

  it('follows the system live while System is chosen', () => {
    const { store, root, query } = storeFor(lightSystem);
    query?.flip(true);
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(store.get()).toEqual({ choice: 'system', resolved: 'dark' });
    query?.flip(false);
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('ignores the system while Light or Dark is chosen, and picks it up again on System', () => {
    const { store, root, query } = storeFor(lightSystem);
    store.set('light');
    query?.flip(true);
    expect(root.getAttribute('data-theme')).toBe('light');
    store.set('system');
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('still switches when storage is blocked, for as long as the page is open', () => {
    const { store, root } = storeFor({ ...lightSystem, stored: 'blocked' });
    expect(() => store.set('dark')).not.toThrow();
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it("doesn't rewrite data-theme when it's already right, as after theme-init.js", () => {
    const root = document.createElement('html');
    root.setAttribute('data-theme', 'dark');
    const writes: string[] = [];
    new MutationObserver((records) => writes.push(...records.map((record) => String(record.attributeName)))).observe(root, { attributes: true });
    const storage = fakeStorage('dark');
    createThemeStore({ storage: () => storage, darkQuery: () => fakeQuery(false), root: () => root });
    return Promise.resolve().then(() => {
      expect(writes).toEqual([]);
      expect(root.getAttribute('data-theme')).toBe('dark');
    });
  });

  it('stops telling a subscriber that unsubscribed', () => {
    const { store } = storeFor(lightSystem);
    let told = 0;
    const unsubscribe = store.subscribe(() => {
      told += 1;
    });
    unsubscribe();
    store.set('dark');
    expect(told).toBe(0);
  });
});

describe('a choice made in another tab', () => {
  /** The window's `storage` event, which a browser fires in every other tab of the origin. */
  function fakeEvents() {
    const listeners = new Set<(event: { key: string | null }) => void>();
    return {
      addEventListener(_type: 'storage', listener: (event: { key: string | null }) => void) {
        listeners.add(listener);
      },
      fire(key: string | null) {
        for (const listener of listeners) listener({ key });
      },
    };
  }

  function twoTabs(stored: Stored = null) {
    const storage = fakeStorage(stored);
    const events = fakeEvents();
    const root = document.createElement('html');
    const query = fakeQuery(false);
    const store = createThemeStore({ storage: () => storage, darkQuery: () => query, root: () => root, events });
    let told = 0;
    store.subscribe(() => {
      told += 1;
    });
    /** The other tab stores `value` (or clears storage, for null), and the browser tells this one. */
    const otherTab = (value: string | null, key: string | null = THEME_KEY) => {
      if (value === null) storage.values.clear();
      else storage.values.set(key ?? THEME_KEY, value);
      events.fire(key);
    };
    return { store, root, query, storage, otherTab, told: () => told };
  }

  it('shows the choice another tab stored, and tells subscribers, so every switch on the page follows', () => {
    const { store, root, otherTab, told } = twoTabs();

    otherTab('dark');
    expect(store.get()).toEqual({ choice: 'dark', resolved: 'dark' });
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(told()).toBe(1);

    otherTab('system');
    expect(store.get()).toEqual({ choice: 'system', resolved: 'light' });
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('follows the system again after another tab chooses System', () => {
    const { store, root, query, otherTab } = twoTabs('dark');

    otherTab('system');
    query.flip(true);
    expect(store.get()).toEqual({ choice: 'system', resolved: 'dark' });
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('goes back to System when another tab clears storage, which fires with no key', () => {
    const { store, otherTab } = twoTabs('dark');

    otherTab(null, null);
    expect(store.get().choice).toBe('system');
  });

  it("ignores other keys, and a change that doesn't change the choice", () => {
    const { store, otherTab, told } = twoTabs('light');

    otherTab('{"x":true}', 'pitwall.groups.v1');
    otherTab('light');
    expect(store.get().choice).toBe('light');
    expect(told()).toBe(0);
  });

  it("never writes the choice back, so two tabs can't echo it between them", () => {
    const { storage, otherTab } = twoTabs();
    const setItem = vi.spyOn(storage, 'setItem');

    otherTab('dark');
    expect(setItem).not.toHaveBeenCalled();
  });

  it('treats a stored value it can\'t read as System, as on load', () => {
    const { store, otherTab } = twoTabs('dark');

    otherTab('solarized');
    expect(store.get().choice).toBe('system');
  });

  it("listens on the window by default, for the browser's own storage event", () => {
    const store = createThemeStore({ darkQuery: () => fakeQuery(false) });
    expect(store.get().choice).toBe('system');

    window.localStorage.setItem(THEME_KEY, 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY }));

    expect(store.get()).toEqual({ choice: 'dark', resolved: 'dark' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('reading and writing the choice', () => {
  it('reads only system, light and dark; anything else is System', () => {
    for (const value of ['system', 'light', 'dark'] as const) expect(parseThemeChoice(value)).toBe(value);
    for (const value of [null, undefined, '', 'Dark', 'auto', 1]) expect(parseThemeChoice(value)).toBe('system');
  });

  it('treats storage that throws, or is missing, as System, and writes to it without throwing', () => {
    const blocked: StorageSource = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    expect(readThemeChoice(blocked)).toBe('system');
    expect(readThemeChoice(() => null)).toBe('system');
    expect(() => writeThemeChoice('dark', blocked)).not.toThrow();
  });

  it("resolves System from the system, and leaves it unresolved when the browser can't say", () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('system', undefined)).toBeUndefined();
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', undefined)).toBe('dark');
  });
});
