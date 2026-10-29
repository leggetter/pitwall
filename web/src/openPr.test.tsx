// The open pull request in the URL (openPr.ts, W95): ?pr=, kept alongside the selection, taking the
// place of ?session= and the other way round, pushed on open and close, replaced on a move, and
// followed on popstate.

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parsePr, useOpenPr, withPr } from './openPr.js';
import { withSession } from './openSession.js';
import { withSelection } from './selection.js';
import { fakeHistory } from './test/history.js';

describe('parsePr and withPr', () => {
  it("reads ?pr= when it's a PR's key, and not while ?session= shows instead", () => {
    expect(parsePr('?view=prs&pr=example/demo-app/42')).toBe('example/demo-app/42');
    expect(parsePr('?pr=example%2Fdemo-app%2F42')).toBe('example/demo-app/42');
    for (const search of ['', '?pr=', '?pr=example/demo-app', '?pr=Example/Demo/1', '?pr=example/demo-app/0', '?pr=a/b/1/2', '?pr=../x/1']) {
      expect(parsePr(search), search).toBeUndefined();
    }
    expect(parsePr('?pr=example/demo-app/42&session=abc')).toBeUndefined();
    // An Enterprise Managed User's owner, and a long one, as the contract's pattern allows.
    expect(parsePr('?pr=pitwall_test-shortcode/demo-app/7')).toBe('pitwall_test-shortcode/demo-app/7');
    expect(parsePr(`?pr=${'o'.repeat(45)}/demo-app/7`)).toBe(`${'o'.repeat(45)}/demo-app/7`);
    for (const search of ['?pr=example/../1', '?pr=_x/demo-app/1', `?pr=${'o'.repeat(101)}/demo-app/1`]) expect(parsePr(search), search).toBeUndefined();
  });

  it('sets it last, readable, in place of ?session=, and a session set takes the place of ?pr=', () => {
    const search = withSession(withSelection('', { view: 'all' }), 'abc');
    expect(withPr(search, 'example/demo-app/42')).toBe('?view=all&pr=example/demo-app/42');
    expect(withPr('?view=prs&pr=example/demo-app/42', undefined)).toBe('?view=prs');
    expect(withPr('', 'example/event-relay/7')).toBe('?pr=example/event-relay/7');
    expect(withSession('?view=prs&pr=example/demo-app/42', 'abc')).toBe('?view=prs&session=abc');
    // Closing a session leaves a ?pr= alone, though one can't be there with it.
    expect(withSession('?pr=example/demo-app/42&session=abc', undefined)).toBe('?pr=example/demo-app/42');
    expect(withSelection('?view=prs&pr=example/demo-app/42', { view: 'all' })).toBe('?view=all&pr=example/demo-app/42');
  });
});

describe('useOpenPr', () => {
  it('pushes an entry to open and to close, replaces one to move, and follows popstate', () => {
    const history = fakeHistory('?view=prs&session=abc', '#rest');
    const { result } = renderHook(() => useOpenPr(history.navigation));
    expect(result.current.key).toBeUndefined();

    act(() => result.current.open('example/demo-app/42'));
    expect(history.entries).toEqual(['?view=prs&session=abc', '?view=prs&pr=example/demo-app/42']);
    act(() => result.current.open('example/demo-app/7', 'replace'));
    expect(history.entries.at(-1)).toBe('?view=prs&pr=example/demo-app/7');
    // The same PR again adds nothing.
    act(() => result.current.open('example/demo-app/7'));
    expect(history.entries).toHaveLength(2);
    act(() => result.current.close());
    expect(history.entries).toEqual(['?view=prs&session=abc', '?view=prs&pr=example/demo-app/7', '?view=prs']);
    expect(result.current.key).toBeUndefined();
    history.back();
    expect(result.current.key).toBe('example/demo-app/7');
    history.back();
    expect(result.current.key).toBeUndefined();
    expect(history.location.hash).toBe('#rest');
  });
});
