// The checks that stand between the network and the index. pitwall's web UI
// will eventually type into agents, so anything that reaches this server can
// run code as the user. See "Security" in PLAN.md.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The only address the server listens on. */
export const LOOPBACK_HOST = '127.0.0.1';

/**
 * The CSP for a server on `port`. connect-src names the WebSocket origin as
 * well as 'self', because older Safari doesn't match ws: against 'self'.
 */
export function contentSecurityPolicy(port: number): string {
  return [
    "default-src 'self'",
    `connect-src 'self' ws://${LOOPBACK_HOST}:${port}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Sent on every HTTP response. Never add CORS headers here or anywhere else. */
export function securityHeaders(port: number): Readonly<Record<string, string>> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(port),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

/** The shortest token the server accepts. The CLI's random token is 43 characters. */
export const MIN_TOKEN_LENGTH = 32;

/**
 * True when `Host` is exactly `127.0.0.1:<port>`. This is what blocks DNS
 * rebinding: a page on evil.example that rebinds its name to 127.0.0.1 still
 * sends `Host: evil.example:<port>`.
 *
 * `localhost` isn't trusted. The server listens on 127.0.0.1 only, and
 * `localhost` can resolve to `::1` first, where another local user could
 * listen on the same port and serve a page with a trusted origin.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `${LOOPBACK_HOST}:${port}`;
}

/** True when `Origin` is exactly `http://127.0.0.1:<port>`. Not `localhost`: see isAllowedHost. */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  return origin === `http://${LOOPBACK_HOST}:${port}`;
}

/** The token from `Authorization: Bearer <token>`, or undefined for any other shape. */
export function bearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined;
  return /^Bearer +(\S+) *$/i.exec(authorization)?.[1];
}

/**
 * Constant-time token comparison. Hashing both sides first gives
 * `timingSafeEqual` two equal-length buffers, so neither the content nor the
 * length of the expected token leaks through timing.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** 32 random bytes as base64url: a challenge nonce, or the per-process API key. */
export function randomSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The proof that answers a challenge: base64url(HMAC-SHA256(key = the token
 * as UTF-8, message = the nonce as UTF-8)). The web UI computes the same with
 * WebCrypto, so the token itself never travels.
 */
export function challengeProof(token: string, nonce: string): string {
  return createHmac('sha256', Buffer.from(token, 'utf8')).update(nonce, 'utf8').digest('base64url');
}

/** Constant-time check of a presented proof against the one this token and nonce call for. */
export function proofMatches(presented: string, token: string, nonce: string): boolean {
  return tokensMatch(presented, challengeProof(token, nonce));
}

/**
 * What an HTTP API caller authenticated with.
 * - 'apiKey': the per-process key from the WebSocket's 'authenticated' message. The web UI uses only this.
 * - 'token': the raw token, accepted for reads, so scripts such as curl keep working.
 */
export type Credential = 'apiKey' | 'token';

/** Which credential a bearer value is, if any. Both comparisons always run, each in constant time. */
export function identifyCredential(presented: string, apiKey: string, token: string): Credential | undefined {
  const isApiKey = tokensMatch(presented, apiKey);
  const isToken = tokensMatch(presented, token);
  if (isApiKey) return 'apiKey';
  if (isToken) return 'token';
  return undefined;
}

/**
 * True for a method that can change state: anything but GET and HEAD. Such a
 * request must carry the apiKey, not the raw token, and this server's Origin.
 */
export function isStateChanging(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}
