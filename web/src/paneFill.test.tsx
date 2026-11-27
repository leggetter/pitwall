import { describe, expect, it } from 'vitest';
import { PANE_FILL_KEY, readCollapsed } from './paneFill.js';

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
