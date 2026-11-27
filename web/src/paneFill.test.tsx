import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PANE_FILL_KEY, readCollapsed, usePaneFill } from './paneFill.js';

const stored = (value: string | null) => () => ({ getItem: () => value, setItem: () => {} });

describe('readCollapsed (W224)', () => {
  it('reads both columns', () => {
    expect(readCollapsed(stored('{"v":1,"repos":true,"list":false}'))).toEqual({ repos: true, list: false });
  });
  it('collapses nothing for a missing value, another version, another shape or no storage', () => {
    const nothing = { repos: false, list: false };
    for (const value of [null, '{"v":2,"repos":true,"list":true}', 'not json', '7', 'null', '{"v":1,"repos":"yes"}']) {
      expect(readCollapsed(stored(value))).toEqual(nothing);
    }
    expect(readCollapsed(() => undefined)).toEqual(nothing);
    expect(
      readCollapsed(() => ({
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {},
      })),
    ).toEqual(nothing);
    expect(PANE_FILL_KEY).toBe('pitwall.pane-fill.v1');
  });
});

describe('usePaneFill (W224)', () => {
  const memory = () => {
    const values = new Map<string, string>();
    return { values, source: () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) }) };
  };

  it('toggles both columns, opens one on its own, and stores booleans only', () => {
    const { values, source } = memory();
    const { result } = renderHook(() => usePaneFill(source));
    expect(result.current.filled).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.collapsed).toEqual({ repos: true, list: true });
    expect(result.current.filled).toBe(true);
    expect(JSON.parse(values.get(PANE_FILL_KEY)!)).toEqual({ v: 1, repos: true, list: true });
    act(() => result.current.open('repos'));
    expect(result.current.collapsed).toEqual({ repos: false, list: true });
    expect(result.current.filled).toBe(false);
    // With one opened on its own, the control collapses both again.
    act(() => result.current.toggle());
    expect(result.current.collapsed).toEqual({ repos: true, list: true });
    act(() => result.current.toggle());
    expect(result.current.collapsed).toEqual({ repos: false, list: false });
    expect(JSON.parse(values.get(PANE_FILL_KEY)!)).toEqual({ v: 1, repos: false, list: false });
  });

  it('starts from what was stored', () => {
    const { result } = renderHook(() => usePaneFill(stored('{"v":1,"repos":false,"list":true}')));
    expect(result.current.collapsed).toEqual({ repos: false, list: true });
  });

  it('still works for the page when storage throws on write', () => {
    const throwing = () => ({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    });
    const { result } = renderHook(() => usePaneFill(throwing));
    expect(() => act(() => result.current.toggle())).not.toThrow();
    expect(result.current.filled).toBe(true);
  });
});
