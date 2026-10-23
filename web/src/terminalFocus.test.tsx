// The setting for when the terminal takes the keyboard (W57): its two values, its default, and storage
// that's missing, holds something else, or throws.

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StorageSource } from './groupState.js';
import {
  DEFAULT_TERMINAL_FOCUS,
  isTerminalFocus,
  readTerminalFocus,
  TERMINAL_FOCUS_DESCRIPTIONS,
  TERMINAL_FOCUS_KEY,
  TERMINAL_FOCUS_LABELS,
  TERMINAL_FOCUSES,
  useTerminalFocus,
  writeTerminalFocus,
} from './terminalFocus.js';

function memory(entries: Record<string, string> = {}): StorageSource & { values: Map<string, string> } {
  const values = new Map(Object.entries(entries));
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  return Object.assign(() => storage, { values });
}
const throwing = (() => ({
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
})) as StorageSource;
const unavailable = (() => {
  throw new Error('blocked');
}) as StorageSource;

describe('the terminal focus setting', () => {
  it('has two values, after-open first and the default, and no "always"', () => {
    expect(TERMINAL_FOCUSES).toEqual(['after-open', 'never']);
    expect(DEFAULT_TERMINAL_FOCUS).toBe('after-open');
    expect(TERMINAL_FOCUS_KEY).toBe('pitwall.terminal-focus.v1');
    expect(isTerminalFocus('always')).toBe(false);
    expect(Object.keys(TERMINAL_FOCUS_LABELS)).toEqual(['after-open', 'never']);
    expect(Object.keys(TERMINAL_FOCUS_DESCRIPTIONS)).toEqual(['after-open', 'never']);
  });

  it('reads each stored value', () => {
    expect(readTerminalFocus(memory({ [TERMINAL_FOCUS_KEY]: 'after-open' }))).toBe('after-open');
    expect(readTerminalFocus(memory({ [TERMINAL_FOCUS_KEY]: 'never' }))).toBe('never');
  });

  it('reads after-open with nothing stored, any other value, or storage that throws', () => {
    for (const storage of [
      memory(),
      memory({ [TERMINAL_FOCUS_KEY]: 'always' }),
      memory({ [TERMINAL_FOCUS_KEY]: 'Never' }),
      memory({ [TERMINAL_FOCUS_KEY]: '' }),
      throwing,
      unavailable,
    ]) {
      expect(readTerminalFocus(storage)).toBe('after-open');
    }
  });

  it('stores the value alone, under its own key, and a write that throws is ignored', () => {
    const storage = memory();
    writeTerminalFocus('never', storage);
    expect([...storage.values]).toEqual([[TERMINAL_FOCUS_KEY, 'never']]);
    expect(() => writeTerminalFocus('never', throwing)).not.toThrow();
    expect(() => writeTerminalFocus('never', unavailable)).not.toThrow();
  });

  it('gives a hook that reads the choice once and stores each new one, and works for the page when storage throws', () => {
    const storage = memory({ [TERMINAL_FOCUS_KEY]: 'never' });
    const { result } = renderHook(() => useTerminalFocus(storage));
    expect(result.current[0]).toBe('never');
    act(() => result.current[1]('after-open'));
    expect(result.current[0]).toBe('after-open');
    expect(storage.values.get(TERMINAL_FOCUS_KEY)).toBe('after-open');

    const blocked = renderHook(() => useTerminalFocus(throwing));
    expect(blocked.result.current[0]).toBe('after-open');
    act(() => blocked.result.current[1]('never'));
    expect(blocked.result.current[0]).toBe('never');
  });

  it('reads after-open when the browser’s own localStorage throws, as with site data blocked', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      expect(readTerminalFocus()).toBe('after-open');
      expect(() => writeTerminalFocus('never')).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
