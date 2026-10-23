// The open session in the URL (openSession.ts): ?session=, kept alongside the selection, pushed on
// open and close, replaced on a move, and followed on popstate.

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parseSession, useOpenSession, withSession } from './openSession.js';
import { withSelection } from './selection.js';
import { fakeHistory } from './test/history.js';

describe('parseSession and withSession', () => {
  it('reads ?session=, and nothing when it is missing or empty', () => {
    expect(parseSession('?view=all&session=abc')).toBe('abc');
    expect(parseSession('?session=a%2Fb')).toBe('a/b');
    for (const search of ['', '?', '?view=all', '?session=']) expect(parseSession(search), search).toBeUndefined();
  });

  it('sets it last, keeping every other parameter exactly as written, and removes it', () => {
    expect(withSession('?repo=/Users/example/code/pitwall&root=/Users/example/code', 'abc')).toBe(
      '?repo=/Users/example/code/pitwall&root=/Users/example/code&session=abc',
    );
    expect(withSession('?session=old&view=all', 'new')).toBe('?view=all&session=new');
    expect(withSession('?view=all&session=abc', undefined)).toBe('?view=all');
    expect(withSession('?session=abc', undefined)).toBe('');
    expect(withSession('', 'a b&c')).toBe('?session=a%20b%26c');
  });

  it('survives the selection changing around it, and the selection survives it', () => {
    const search = withSession(withSelection('', { view: 'needs-you' }), 'abc');
    expect(search).toBe('?view=needs-you&session=abc');
    expect(withSelection(search, { repo: '/Users/example/code/notes' })).toBe('?repo=/Users/example/code/notes&session=abc');
    expect(withSession(withSelection(search, { view: 'all' }), undefined)).toBe('?view=all');
  });
});

describe('useOpenSession', () => {
  it('starts from the URL, and with nothing open without ?session=', () => {
    expect(renderHook(() => useOpenSession(fakeHistory('?view=all&session=abc').navigation)).result.current.id).toBe('abc');
    expect(renderHook(() => useOpenSession(fakeHistory('?view=all').navigation)).result.current.id).toBeUndefined();
  });

  it('pushes an entry to open and to close, and replaces one to move', () => {
    const history = fakeHistory('?view=all', '#rest');
    const { result } = renderHook(() => useOpenSession(history.navigation));

    act(() => result.current.open('a'));
    expect(history.entries).toEqual(['?view=all', '?view=all&session=a']);
    act(() => result.current.open('b', 'replace'));
    expect(history.entries).toEqual(['?view=all', '?view=all&session=b']);
    expect(result.current.id).toBe('b');
    act(() => result.current.close());
    expect(history.entries).toEqual(['?view=all', '?view=all&session=b', '?view=all']);
    expect(result.current.id).toBeUndefined();
    // The fragment is left alone.
    expect(history.location.hash).toBe('#rest');
  });

  it('adds no entry for the session that is already open, or for closing with nothing open', () => {
    const history = fakeHistory('?view=all');
    const { result } = renderHook(() => useOpenSession(history.navigation));
    act(() => result.current.close());
    act(() => result.current.open('a'));
    act(() => result.current.open('a'));
    expect(history.entries).toEqual(['?view=all', '?view=all&session=a']);
  });

  it('follows the URL on popstate, back and forward', () => {
    const history = fakeHistory('?view=all');
    const { result } = renderHook(() => useOpenSession(history.navigation));
    act(() => result.current.open('a'));
    act(() => result.current.close());

    history.back();
    expect(result.current.id).toBe('a');
    history.back();
    expect(result.current.id).toBeUndefined();
    history.forward();
    expect(result.current.id).toBe('a');
  });
});
