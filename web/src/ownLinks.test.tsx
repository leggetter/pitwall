import { describe, expect, it, vi } from 'vitest';
import { followOwnLink, isOwnLink, ownLinkSearch, type OwnLinkEnv } from './ownLinks.js';

const env = (search = ''): OwnLinkEnv => ({
  location: { origin: 'http://127.0.0.1:4518', pathname: '/', search },
  history: { pushState: vi.fn(), state: null },
  dispatchEvent: vi.fn(() => true),
});

describe('ownLinkSearch (W220)', () => {
  it('gives the query string of a link to this origin at /', () => {
    const e = env();
    expect(ownLinkSearch('http://127.0.0.1:4518/?session=abc&spinoff=latest', e)).toBe('?session=abc&spinoff=latest');
    expect(ownLinkSearch('http://127.0.0.1:4518/', e)).toBe('');
    expect(ownLinkSearch('http://127.0.0.1:4518', e)).toBe('');
    expect(isOwnLink('http://127.0.0.1:4518/?pr=1', e)).toBe(true);
  });

  it('keeps only the query of a parsing edge case: userinfo, a backslash, an encoded #', () => {
    const e = env();
    // Userinfo is dropped: only the query string is followed.
    expect(ownLinkSearch('http://x@127.0.0.1:4518/?session=a', e)).toBe('?session=a');
    // A backslash after the host is a path to the URL parser, so it isn't /.
    expect(ownLinkSearch('http://127.0.0.1:4518\\@evil.example/?session=a', e)).toBeUndefined();
    // %23 stays in the query: no fragment reaches token.ts.
    expect(ownLinkSearch('http://127.0.0.1:4518/?session=a%23token=x', e)).toBe('?session=a%23token=x');
  });

  it('refuses another origin, port, scheme, host or path', () => {
    const e = env();
    for (const href of [
      'http://127.0.0.1:4519/?session=a',
      'https://127.0.0.1:4518/?session=a',
      'http://localhost:4518/?session=a',
      'http://127.0.0.1:4518.evil.example/?session=a',
      'http://127.0.0.1:4518/api/snapshot',
      'http://127.0.0.1:4518/x/?session=a',
      'http://user@127.0.0.1:4518@evil.example/',
      'session=a',
      '',
    ]) {
      expect(ownLinkSearch(href, e), href).toBeUndefined();
    }
  });

  it('refuses any fragment, even an empty one', () => {
    const e = env();
    for (const href of ['http://127.0.0.1:4518/#token=x', 'http://127.0.0.1:4518/?session=a#token=x', 'http://127.0.0.1:4518/#', 'http://127.0.0.1:4518/?session=a#']) {
      expect(ownLinkSearch(href, e), href).toBeUndefined();
    }
  });
});

describe('followOwnLink (W220)', () => {
  it('pushes the query string and fires popstate, without reloading', () => {
    const e = env('?view=all');
    followOwnLink('?session=abc&spinoff=latest', e);
    expect(e.history.pushState).toHaveBeenCalledWith(null, '', '/?session=abc&spinoff=latest');
    expect((e.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBeInstanceOf(PopStateEvent);
  });

  it('adds no entry for the address it is already at, but still fires popstate', () => {
    const e = env('?session=abc');
    followOwnLink('?session=abc', e);
    expect(e.history.pushState).not.toHaveBeenCalled();
    expect(e.dispatchEvent).toHaveBeenCalledTimes(1);
  });
});
