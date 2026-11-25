// The dismissed proposals' storage and Needs you's list of proposals (W163). Made-up sessions only.
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SpinOff } from '../../src/shared/protocol.js';
import type { StorageSource } from './groupState.js';
import type { ApiClient } from './api.js';
import { openSpinOffs, readDismissed, useDismissedSpinOffs, SPIN_OFFS_CAP, SPIN_OFFS_KEY, spinOffCount, spinOffId } from './spinOff.js';
import { NO_WORK } from './work.js';
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

describe('spinOffCount', () => {
  it('counts a proposal unless its session already counts as a row that needs you, so a session counts once', () => {
    const quiet = session({ spinOff: proposal('5555555555555555') });
    const asking = session({
      spinOff: proposal('6666666666666666'),
      needsYou: { reason: 'asked' },
    });
    const listed = openSpinOffs([group({ sessions: [quiet, asking] })], new Set());
    expect(listed).toHaveLength(2);
    expect(spinOffCount(listed, NO_WORK)).toBe(1);
  });
});

describe('settled proposals (W212)', () => {
  it('leaves a proposal the server marks settled out of Needs you, however it was settled', () => {
    const settled = session({ spinOff: { ...proposal('7777777777777777'), settled: { how: 'started', at: '2026-11-24T14:10:00.000Z', name: 'plugin-hosted-mcp-test' } } });
    const open = session({ spinOff: proposal('8888888888888888') });
    expect(openSpinOffs([group({ sessions: [settled, open] })], new Set()).map((item) => item.session.sessionId)).toEqual([open.sessionId]);
  });
});

describe('useDismissedSpinOffs', () => {
  const memory = (initial: string | null) => {
    let value = initial;
    const source: StorageSource = () => ({ getItem: () => value, setItem: (_key, next) => void (value = next) });
    return { source, get: () => value };
  };

  it('sends a start or a dismissal to the server and hides the card at once', async () => {
    const post = vi.fn(async () => ({ kind: 'ok' as const, status: 200, body: { ok: true } }));
    const { result } = renderHook(() => useDismissedSpinOffs({ post } as unknown as ApiClient, memory(null).source));
    result.current.start('s1', 'k1');
    result.current.dismiss('s2', 'k2');
    await waitFor(() => expect(result.current.set.has(spinOffId('s2', 'k2'))).toBe(true));
    expect(result.current.set.has(spinOffId('s1', 'k1'))).toBe(true);
    expect(post).toHaveBeenCalledWith('/api/sessions/s1/spin-off/settle', { key: 'k1', how: 'started' });
    expect(post).toHaveBeenCalledWith('/api/sessions/s2/spin-off/settle', { key: 'k2', how: 'dismissed' });
  });

  it('moves what the browser kept to the server once, then empties it', async () => {
    const post = vi.fn(async () => ({ kind: 'ok' as const, status: 200, body: { ok: true } }));
    const storage = memory(JSON.stringify({ v: 1, dismissed: ['a:1', 'b:2'] }));
    renderHook(() => useDismissedSpinOffs({ post } as unknown as ApiClient, storage.source));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/spin-offs/migrate', { dismissed: ['a:1', 'b:2'] }));
    await waitFor(() => expect(readDismissed(storage.source)).toEqual([]));
  });

  it('keeps what the browser kept when the server doesn’t take it', async () => {
    const post = vi.fn(async () => ({ kind: 'unauthorized' as const }));
    const storage = memory(JSON.stringify({ v: 1, dismissed: ['a:1'] }));
    renderHook(() => useDismissedSpinOffs({ post } as unknown as ApiClient, storage.source));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(readDismissed(storage.source)).toEqual(['a:1']);
  });

  it('hides cards dismissed in the old storage from the first render, and brings a dismissed card back when the server refuses', async () => {
    const refuse = vi.fn(async () => ({ kind: 'unauthorized' as const }));
    const storage = memory(JSON.stringify({ v: 1, dismissed: ['a:1'] }));
    const { result } = renderHook(() => useDismissedSpinOffs({ post: refuse } as unknown as ApiClient, storage.source));
    expect(result.current.set.has('a:1')).toBe(true);
    result.current.dismiss('s2', 'k2');
    result.current.start('s3', 'k3');
    await waitFor(() => expect(refuse).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.set.has(spinOffId('s3', 'k3'))).toBe(true));
    await waitFor(() => expect(result.current.set.has(spinOffId('s2', 'k2'))).toBe(false));
  });
});
