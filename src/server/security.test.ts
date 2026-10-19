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
  serverOrigin,
  tokensMatch,
} from './security.js';

/**
 * Known answers for the challenge proof (PROTOCOL_VERSION 3), computed with
 * openssl rather than node:crypto or WebCrypto:
 *   printf '%s\n%s' "$nonce" "$origin" | openssl dgst -sha256 -hmac "$token" -binary | base64 | tr '+/' '-_' | tr -d '='
 * The web UI's test (web/src/connection.test.tsx) checks its WebCrypto
 * implementation against the same three.
 * - A pitwall-shaped one: a 45-character token, a nonce of the bytes 0-31 and
 *   the default port's origin.
 * - The same token and nonce from the next port, as a squatter's page would have.
 * - RFC 4231 test case 2's key, with its data split at the line feed the
 *   proof puts between the nonce and the origin.
 */
const PROOF_VECTORS = [
  {
    token: 'pitwall-test-token-0123456789abcdefghijklmnop',
    nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    origin: 'http://127.0.0.1:4517',
    proof: 'VfgdQHb0QdfmEBEAg8W5N3W6RclVQBVetrxzeG2xnFY',
  },
  {
    token: 'pitwall-test-token-0123456789abcdefghijklmnop',
    nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    origin: 'http://127.0.0.1:4518',
    proof: 'Xk3hWH6P6KC1u51qPg77f3JuauFOnETYWqncpr6PLjc',
  },
  { token: 'Jefe', nonce: 'what do ya want', origin: 'for nothing?', proof: 'UP-f1VK6b3166pqI6T8uvuKHC_hgz9eits8su-2SoT4' },
] as const;

/** The version 2 proof for PROOF_VECTORS[0]'s token and nonce: HMAC of the nonce alone. */
const VERSION_2_PROOF = 'It5IfJWj2OciIOPUib9GDD0Q16VZrTBep087XrZVHnI';

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

describe('serverOrigin', () => {
  it('is http://127.0.0.1:<port>, the one origin isAllowedOrigin allows', () => {
    expect(serverOrigin(4517)).toBe('http://127.0.0.1:4517');
    expect(isAllowedOrigin(serverOrigin(4517), 4517)).toBe(true);
  });
});

describe('challengeProof', () => {
  it('is base64url(HMAC-SHA256(token, nonce + "\\n" + origin)), matching the known answers', () => {
    for (const { token, nonce, origin, proof } of PROOF_VECTORS) expect(challengeProof(token, nonce, origin), origin).toBe(proof);
  });

  it('differs for another origin, and from the version 2 proof', () => {
    const { token, nonce, origin } = PROOF_VECTORS[0];
    expect(challengeProof(token, nonce, origin)).not.toBe(challengeProof(token, nonce, PROOF_VECTORS[1].origin));
    expect(challengeProof(token, nonce, origin)).not.toBe(VERSION_2_PROOF);
  });
});

describe('proofMatches', () => {
  const { token, nonce, origin, proof } = PROOF_VECTORS[0];

  it('accepts the proof for this token, nonce and origin only', () => {
    expect(proofMatches(proof, token, nonce, origin)).toBe(true);
    expect(proofMatches(proof, token, `${nonce}x`, origin)).toBe(false);
    expect(proofMatches(proof, `${token}x`, nonce, origin)).toBe(false);
    for (const other of ['http://127.0.0.1:4518', 'http://localhost:4517', 'https://127.0.0.1:4517', 'http://127.0.0.1:4517/', '']) {
      expect(proofMatches(proof, token, nonce, other), other).toBe(false);
    }
    for (const presented of ['', proof.slice(1), `${proof}=`, proof.toLowerCase(), token, nonce, VERSION_2_PROOF]) {
      expect(proofMatches(presented, token, nonce, origin), presented).toBe(false);
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
