// The challenge proof for server tests, computed here with node:crypto rather
// than with the server's own helper (security.ts), so the tests pin the
// contract in src/shared/protocol.ts. A change to the proof changes this file
// and security.ts, not every test. Test-only: tsconfig.build.json leaves
// src/test/ out of the build.
import { createHmac } from 'node:crypto';

/** `http://127.0.0.1:<port>`: the one origin a pitwall server on `port` allows, and binds proofs to. */
export function pitwallOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * The PROTOCOL_VERSION 3 proof: base64url(HMAC-SHA256(key = the token as
 * UTF-8, message = the nonce, a line feed, then the origin, as UTF-8)).
 */
export function proofFor(token: string, nonce: string, origin: string): string {
  return createHmac('sha256', Buffer.from(token, 'utf8')).update(`${nonce}\n${origin}`, 'utf8').digest('base64url');
}

/** The PROTOCOL_VERSION 2 proof, HMAC-SHA256 of the nonce alone, which a version 3 server refuses. */
export function version2ProofFor(token: string, nonce: string): string {
  return createHmac('sha256', Buffer.from(token, 'utf8')).update(nonce, 'utf8').digest('base64url');
}
