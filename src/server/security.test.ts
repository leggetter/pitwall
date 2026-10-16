import { describe, expect, it } from 'vitest';
import {
  bearerToken,
  challengeProof,
  contentSecurityPolicy,
  identifyCredential,
  isAllowedHost,
  isAllowedOrigin,
  isStateChanging,
  proofMatches,
  randomSecret,
  tokensMatch,
} from './security.js';

/**
 * Test vectors for the challenge proof. The web UI's test (web/src/connection.test.tsx)
 * checks its WebCrypto implementation against the same two.
 * - RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?",
 *   HMAC-SHA256 5bdcc146...64ec3843, here as base64url.
 * - A pitwall-shaped one: a 45-character token and a nonce of the bytes 0-31.
 */
const PROOF_VECTORS = [
  { token: 'Jefe', nonce: 'what do ya want for nothing?', proof: 'W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM' },
  {
    token: 'pitwall-test-token-0123456789abcdefghijklmnop',
    nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    proof: 'It5IfJWj2OciIOPUib9GDD0Q16VZrTBep087XrZVHnI',
  },
] as const;

describe('isAllowedHost', () => {
  it('allows exactly 127.0.0.1:<port>, not localhost', () => {
    expect(isAllowedHost('127.0.0.1:4517', 4517)).toBe(true);
    for (const host of [undefined, '', '127.0.0.1', 'localhost', 'localhost:4517', '127.0.0.1:4518', '0.0.0.0:4517', '[::1]:4517', 'evil.example:4517', ' 127.0.0.1:4517']) {
      expect(isAllowedHost(host, 4517), String(host)).toBe(false);
    }
  });
});

describe('isAllowedOrigin', () => {
  it('allows exactly http://127.0.0.1:<port>, not localhost', () => {
    expect(isAllowedOrigin('http://127.0.0.1:4517', 4517)).toBe(true);
    for (const origin of [undefined, '', 'null', 'http://127.0.0.1', 'https://127.0.0.1:4517', 'http://127.0.0.1:4518', 'http://evil.example', 'http://localhost:4517', 'http://[::1]:4517']) {
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

describe('contentSecurityPolicy', () => {
  it('names the WebSocket origin on the given port in connect-src, and not localhost', () => {
    expect(contentSecurityPolicy(4517)).toBe(
      "default-src 'self'; connect-src 'self' ws://127.0.0.1:4517; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  });
});

describe('challengeProof', () => {
  it('is base64url(HMAC-SHA256(token, nonce)), matching the test vectors', () => {
    expect(Buffer.from(PROOF_VECTORS[0].proof, 'base64url').toString('hex')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    for (const { token, nonce, proof } of PROOF_VECTORS) expect(challengeProof(token, nonce)).toBe(proof);
  });
});

describe('proofMatches', () => {
  const { token, nonce, proof } = PROOF_VECTORS[1];

  it('accepts the proof for this token and nonce only', () => {
    expect(proofMatches(proof, token, nonce)).toBe(true);
    expect(proofMatches(proof, token, `${nonce}x`)).toBe(false);
    expect(proofMatches(proof, `${token}x`, nonce)).toBe(false);
    for (const presented of ['', proof.slice(1), `${proof}=`, proof.toLowerCase(), token, nonce]) {
      expect(proofMatches(presented, token, nonce), presented).toBe(false);
    }
  });
});

describe('identifyCredential', () => {
  const apiKey = 'k'.repeat(43);
  const token = 't'.repeat(43);

  it('tells the apiKey from the token, and refuses anything else', () => {
    expect(identifyCredential(apiKey, apiKey, token)).toBe('apiKey');
    expect(identifyCredential(token, apiKey, token)).toBe('token');
    for (const presented of ['', 'k', `${apiKey}k`, `${token}t`, apiKey.slice(1)]) {
      expect(identifyCredential(presented, apiKey, token), presented).toBeUndefined();
    }
  });
});

describe('isStateChanging', () => {
  it('is false for GET and HEAD only', () => {
    expect(isStateChanging('GET')).toBe(false);
    expect(isStateChanging('HEAD')).toBe(false);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'get', 'CONNECT']) {
      expect(isStateChanging(method), method).toBe(true);
    }
  });
});

describe('randomSecret', () => {
  it('is 32 random bytes as base64url', () => {
    const a = randomSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(randomSecret()).not.toBe(a);
  });
});
