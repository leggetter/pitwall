import { describe, expect, it } from 'vitest';
import { bearerToken, isAllowedHost, isAllowedOrigin, tokensMatch } from './security.js';

describe('isAllowedHost', () => {
  it('allows exactly 127.0.0.1:<port> and localhost:<port>', () => {
    expect(isAllowedHost('127.0.0.1:4517', 4517)).toBe(true);
    expect(isAllowedHost('localhost:4517', 4517)).toBe(true);
    for (const host of [undefined, '', '127.0.0.1', 'localhost', '127.0.0.1:4518', '0.0.0.0:4517', '[::1]:4517', 'evil.example:4517', ' 127.0.0.1:4517']) {
      expect(isAllowedHost(host, 4517), String(host)).toBe(false);
    }
  });
});

describe('isAllowedOrigin', () => {
  it('allows exactly http://127.0.0.1:<port> and http://localhost:<port>', () => {
    expect(isAllowedOrigin('http://127.0.0.1:4517', 4517)).toBe(true);
    expect(isAllowedOrigin('http://localhost:4517', 4517)).toBe(true);
    for (const origin of [undefined, '', 'null', 'http://127.0.0.1', 'https://127.0.0.1:4517', 'http://127.0.0.1:4518', 'http://evil.example']) {
      expect(isAllowedOrigin(origin, 4517), String(origin)).toBe(false);
    }
  });
});

describe('bearerToken', () => {
  it('reads the token from a Bearer header only', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    for (const header of [undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'abc', 'Bearer a b']) {
      expect(bearerToken(header), String(header)).toBeUndefined();
    }
  });
});

describe('tokensMatch', () => {
  it('matches equal tokens only, whatever the lengths', () => {
    const token = 'a'.repeat(43);
    expect(tokensMatch(token, token)).toBe(true);
    expect(tokensMatch(`${token}b`, token)).toBe(false);
    expect(tokensMatch(token.slice(1), token)).toBe(false);
    expect(tokensMatch('', token)).toBe(false);
  });
});
