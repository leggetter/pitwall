// A browser history of its own for tests: entries, push and replace, and back and forward that fire
// popstate, so a test can tell a pushed entry from a replaced one.

import { act } from '@testing-library/react';
import type { NavigationEnv } from '../selection.js';

/** A history of its own: entries, push, replace, and back and forward that fire popstate. */
export function fakeHistory(search = '', hash = '') {
  const entries = [search];
  let index = 0;
  const listeners = new Set<() => void>();
  const location = { pathname: '/', search, hash };
  const searchOf = (url: string | URL | null | undefined) => new URL(String(url), 'http://pitwall.invalid/').search;
  const go = (by: number) => {
    index = Math.min(entries.length - 1, Math.max(0, index + by));
    location.search = entries[index] ?? '';
    act(() => {
      for (const listener of listeners) listener();
    });
  };
  const navigation: NavigationEnv = {
    location,
    history: {
      state: null,
      pushState: (_state, _unused, url) => {
        entries.splice(index + 1);
        entries.push(searchOf(url));
        index += 1;
        location.search = entries[index] ?? '';
      },
      replaceState: (_state, _unused, url) => {
        entries[index] = searchOf(url);
        location.search = entries[index] ?? '';
      },
    },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  return { navigation, entries, location, index: () => index, back: () => go(-1), forward: () => go(1) };
}

