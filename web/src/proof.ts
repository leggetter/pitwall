// Answering a pitwall WebSocket's challenge, shared by the index connection
// (connection.ts) and every attach socket (attach.ts). The page proves it
// holds the token with an HMAC of the server's nonce and the page's own
// origin; the token itself is never sent.

/** Computes the answer to a challenge. */
export type Prover = (token: string, nonce: string) => Promise<string>;

/**
 * base64url(HMAC-SHA256(key = token as UTF-8, message = nonce + "\n" + origin
 * as UTF-8)), the answer to a challenge (PROTOCOL_VERSION 3). `origin` is
 * this page's own, `location.origin`, so a proof computed here is good only
 * for the server that served the page: a page on another origin that passed
 * a challenge on to this one couldn't use the answer. WebCrypto is available
 * because pitwall's page is served from http://127.0.0.1, which browsers
 * treat as a secure context.
 */
export async function computeProof(token: string, nonce: string, origin: string = location.origin): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${nonce}\n${origin}`));
  return toBase64Url(new Uint8Array(signature));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 bytes as base64url, as the contract says for both the nonce and the apiKey. */
export const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * A parsed `{ type: 'challenge', version, nonce }`, or undefined when it isn't
 * one. Any numeric version parses, so a mismatch can be reported rather than
 * ignored.
 */
export function parseChallenge(candidate: Record<string, unknown>): { type: 'challenge'; version: number; nonce: string } | undefined {
  if (candidate.type !== 'challenge') return undefined;
  if (typeof candidate.version !== 'number' || typeof candidate.nonce !== 'string' || !SECRET_SHAPE.test(candidate.nonce)) return undefined;
  return { type: 'challenge', version: candidate.version, nonce: candidate.nonce };
}
