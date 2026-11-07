// The dismissed proposals' storage and Needs you's list of proposals (W163). Made-up sessions only.
import { describe, expect, it } from 'vitest';
import type { SpinOff } from '../../src/shared/protocol.js';
import type { StorageSource } from './groupState.js';
import { openSpinOffs, readDismissed, SPIN_OFFS_CAP, SPIN_OFFS_KEY, spinOffId } from './spinOff.js';
import { group, minutesAgo, session } from './test/fixtures.js';

const proposal = (key: string): SpinOff => ({ kind: 'proposal', key, folder: '/Users/example/code/demo-app', prompt: 'Go.' });

const stored = (value: string | null, throws = false): StorageSource => () => ({
  getItem: () => {
    if (throws) throw new Error('blocked');
    return value;
  },
  setItem: () => {},
});

describe('readDismissed', () => {
  it('reads version 1, skipping what isn’t an entry, and keeps the newest SPIN_OFFS_CAP', () => {
    expect(readDismissed(stored(JSON.stringify({ v: 1, dismissed: ['a:1', 7, '', 'a:1', 'b:2'] })))).toEqual(['a:1', 'b:2']);
    const many = Array.from({ length: SPIN_OFFS_CAP + 5 }, (_, index) => `s:${index}`);
    const read = readDismissed(stored(JSON.stringify({ v: 1, dismissed: many })));
    expect(read).toHaveLength(SPIN_OFFS_CAP);
    expect(read[0]).toBe('s:5');
  });

  it('reads nothing from storage that’s empty, throws, or holds another shape', () => {
    expect(readDismissed(stored(null))).toEqual([]);
    expect(readDismissed(stored('{', false))).toEqual([]);
    expect(readDismissed(stored(JSON.stringify({ v: 2, dismissed: ['a:1'] })))).toEqual([]);
    expect(readDismissed(stored('x', true))).toEqual([]);
    expect(SPIN_OFFS_KEY).toBe('pitwall.spinOffs.v1');
  });
});

describe('openSpinOffs', () => {
  it('lists each session’s proposal once, newest first, leaving out dismissed and stale ones', () => {
    const older = session({ lastActivityAt: minutesAgo(30), spinOff: proposal('1111111111111111') });
    const newer = session({ lastActivityAt: minutesAgo(2), spinOff: proposal('2222222222222222') });
    const dismissed = session({ spinOff: proposal('3333333333333333') });
    const stale = session({ stale: true, spinOff: proposal('4444444444444444') });
    const none = session();
    const groups = [group({ sessions: [older, dismissed, stale, none] }), group({ key: 'other', sessions: [newer, older] })];
    const listed = openSpinOffs(groups, new Set([spinOffId(dismissed.sessionId, '3333333333333333')]));
    expect(listed.map((item) => item.session.sessionId)).toEqual([newer.sessionId, older.sessionId]);
  });
});
