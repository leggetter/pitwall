import { describe, expect, it, vi } from 'vitest';
import { parseHashToken, takeToken, TOKEN_STORAGE_KEY, type TokenEnv } from './token.js';

function fakeEnv(hash: string, stored: Record<string, string> = {}) {
  const storage = new Map(Object.entries(stored));
  const env = {
    location: { hash, pathname: '/', search: '' },
    history: { state: null, replaceState: vi.fn() },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    },
  } satisfies TokenEnv;
  return { env, storage };
}

describe('parseHashToken', () => {
  it('reads the token and leaves nothing behind', () => {
    expect(parseHashToken('#token=abc123')).toEqual({ token: 'abc123', rest: '' });
  });

  it('keeps other fragment parameters', () => {
    expect(parseHashToken('#token=abc123&view=all')).toEqual({ token: 'abc123', rest: '#view=all' });
  });

  it('reports no token when the fragment has none', () => {
    expect(parseHashToken('')).toEqual({ token: undefined, rest: '' });
    expect(parseHashToken('#view=all')).toEqual({ token: undefined, rest: '#view=all' });
  });
});

describe('takeToken', () => {
  it('stores the token from the fragment and removes it from the address bar', () => {
    const { env, storage } = fakeEnv('#token=abc123');

    expect(takeToken(env)).toBe('abc123');
    expect(storage.get(TOKEN_STORAGE_KEY)).toBe('abc123');
    expect(env.history.replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('falls back to the stored token when the fragment has none', () => {
    const { env } = fakeEnv('', { [TOKEN_STORAGE_KEY]: 'stored-token' });

    expect(takeToken(env)).toBe('stored-token');
    expect(env.history.replaceState).not.toHaveBeenCalled();
  });

  it('prefers a new token in the fragment over the stored one', () => {
    const { env, storage } = fakeEnv('#token=fresh', { [TOKEN_STORAGE_KEY]: 'old' });

    expect(takeToken(env)).toBe('fresh');
    expect(storage.get(TOKEN_STORAGE_KEY)).toBe('fresh');
  });

  it('returns null when there is no token anywhere', () => {
    expect(takeToken(fakeEnv('').env)).toBeNull();
  });

  it('cleans an empty token out of the address bar and returns null', () => {
    const { env } = fakeEnv('#token=');

    expect(takeToken(env)).toBeNull();
    expect(env.history.replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('still returns the fragment token when storage is unavailable', () => {
    const { env } = fakeEnv('#token=abc123');
    env.sessionStorage.setItem = () => {
      throw new Error('storage disabled');
    };

    expect(takeToken(env)).toBe('abc123');
  });

  it('works against the real window: the token leaves the URL and lands in sessionStorage', () => {
    window.history.replaceState(null, '', '/?x=1#token=abc123');

    expect(takeToken()).toBe('abc123');
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('abc123');
    expect(window.location.search).toBe('?x=1');
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe('abc123');
  });
});
