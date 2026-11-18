import { describe, expect, it } from 'vitest';
import { readStatesDoc, statesDocPath } from './referenceDocs.js';

describe('the states reference (W178)', () => {
  it('is found from the source tree, and reads as markdown', () => {
    expect(statesDocPath()).toMatch(/docs[\\/]states\.md$/);
    expect(readStatesDoc()).toContain('# How pitwall decides');
  });
  it('is found beside a built server, and fails soft when it is missing', () => {
    expect(statesDocPath('/nowhere/dist/server/referenceDocs.js')).toBeUndefined();
    expect(readStatesDoc('/nowhere/states.md')).toBeUndefined();
    expect(readStatesDoc(undefined)).toBeDefined(); // the default path
  });
});
