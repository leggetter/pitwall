// The theme (docs/design-system.md, 2.2): System, the default, Light or Dark, stored in localStorage
// as pitwall.theme.v1. What it resolves to is data-theme on <html>, the only thing tokens.css reads.
//
// web/public/theme-init.js sets data-theme before the first paint. From then on this module keeps it
// right: when the choice changes, and while System is chosen, when the system's own setting changes.
// One store holds the choice, so every theme switch on the page shows the same one.

import { createContext, useContext, useSyncExternalStore } from 'react';
import { browserStorage, type StorageSource } from './groupState.js';

export const THEME_KEY = 'pitwall.theme.v1';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const DARK_QUERY = '(prefers-color-scheme: dark)';

/** A stored value as a choice. Anything else, missing or unreadable, is System. */
export function parseThemeChoice(value: unknown): ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export function readThemeChoice(storage: StorageSource = browserStorage): ThemeChoice {
  try {
    return parseThemeChoice(storage()?.getItem(THEME_KEY));
  } catch {
    // Blocked: follow the system.
    return 'system';
  }
}

export function writeThemeChoice(choice: ThemeChoice, storage: StorageSource = browserStorage): void {
  try {
    storage()?.setItem(THEME_KEY, choice);
  } catch {
    // Blocked or full: the choice lasts until the page reloads.
  }
}

/**
 * The theme a choice shows. `systemDark` is whether the system prefers dark, or undefined when the
 * browser can't say, in which case System leaves data-theme unset and tokens.css follows
 * prefers-color-scheme on its own.
 */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean | undefined): ResolvedTheme | undefined {
  if (choice !== 'system') return choice;
  return systemDark === undefined ? undefined : systemDark ? 'dark' : 'light';
}

export interface ThemeState {
  choice: ThemeChoice;
  /** What's on screen. Undefined only when System can't be resolved in JavaScript. */
  resolved: ResolvedTheme | undefined;
}

export interface ThemeStore {
  get(): ThemeState;
  /** Stores the choice and shows it at once, with no reload. */
  set(choice: ThemeChoice): void;
  subscribe(listener: () => void): () => void;
}

/** The part of matchMedia(DARK_QUERY)'s MediaQueryList the store uses. */
export interface DarkQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
}

/** The parts of the page the store uses, so tests can pass their own. */
export interface ThemeEnv {
  storage?: StorageSource;
  /** matchMedia(DARK_QUERY), or undefined where the browser has no matchMedia. */
  darkQuery?: () => DarkQuery | undefined;
  root?: () => Element;
}

const defaultDarkQuery = (): DarkQuery | undefined => (typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : undefined);

export function createThemeStore({ storage = browserStorage, darkQuery = defaultDarkQuery, root = () => document.documentElement }: ThemeEnv = {}): ThemeStore {
  const query = darkQuery();
  const listeners = new Set<() => void>();
  const stateFor = (choice: ThemeChoice): ThemeState => ({ choice, resolved: resolveTheme(choice, query?.matches) });
  let state = stateFor(readThemeChoice(storage));

  const show = (next: ThemeState) => {
    state = next;
    if (next.resolved) root().setAttribute('data-theme', next.resolved);
    else root().removeAttribute('data-theme');
    for (const listener of listeners) listener();
  };

  // While System is chosen, follow the system as it changes: a schedule, or the user switching.
  query?.addEventListener('change', () => {
    if (state.choice === 'system') show(stateFor('system'));
  });
  // The same as theme-init.js did before the first paint, and a fallback if it didn't run.
  show(state);

  return {
    get: () => state,
    set(choice) {
      writeThemeChoice(choice, storage);
      show(stateFor(choice));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The page's store, made the first time something asks for it. Tests can provide their own. */
let pageStore: ThemeStore | undefined;
export const ThemeStoreContext = createContext<ThemeStore | undefined>(undefined);

export function useThemeStore(): ThemeStore {
  const provided = useContext(ThemeStoreContext);
  if (provided) return provided;
  pageStore ??= createThemeStore();
  return pageStore;
}

/** The current choice and what it shows, and a way to change it. */
export function useTheme(): ThemeState & { setChoice: (choice: ThemeChoice) => void } {
  const store = useThemeStore();
  const state = useSyncExternalStore(store.subscribe, store.get);
  return { ...state, setChoice: store.set };
}
