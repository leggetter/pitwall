// Link codes (W175, D7): how a pitwall link opened in a new tab gets the token from a tab that already
// has it, without a page from another process getting it too.
//
// A tab opened at a pitwall link has no token (it lives in each tab's sessionStorage). It asks the
// pitwall tabs already open, on a BroadcastChannel, which is shared by every page on the same origin,
// and the origin is only a string: a page that another account's process served on this port, and that
// is still open, shares it. So the tab must prove which server served it, and the answer must be
// readable by that tab alone.
//
// - Every navigation to the app's index.html is given a fresh code, in a <meta> tag of the page. It
//   goes only to a real navigation (Sec-Fetch-Dest: document and Sec-Fetch-Mode: navigate, headers
//   a page's script can't set). A script on a stale same-origin page can fetch() the index but is
//   given no code, can't frame it (frame-ancestors 'none'), and can't read a window it opens onto it
//   (Cross-Origin-Opener-Policy: same-origin, security.ts).
// - The tab sends the channel only the code's hash. A tab that has the token, and a signed-in
//   WebSocket, sends that hash to the server over the socket. The server returns the code once, if it
//   issued it, hasn't seen it used and it hasn't expired; the tab encrypts the token under it and
//   broadcasts the ciphertext. Only the page with the code in its <meta> can read the answer, so a
//   listener on the channel learns nothing, and a request replayed with the hash is answered with
//   nothing, since the code is spent.
//
// This file is the server's side: the codes, and putting one in the page.
import { createHash, randomBytes } from 'node:crypto';

/** A code is good for this long after the page that holds it was served. */
export const LINK_CODE_TTL_MS = 30_000;

/** At most this many codes wait to be used at once; a newer one pushes out the oldest. */
export const MAX_LINK_CODES = 64;

/** At most this many confirmations on one WebSocket in LINK_CONFIRM_WINDOW_MS. */
export const MAX_LINK_CONFIRMS = 10;
export const LINK_CONFIRM_WINDOW_MS = 10_000;

/** base64url(SHA-256(code)): 43 characters. What goes over the channel and to the server. */
export function linkCodeHash(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('base64url');
}

export function isLinkCodeHash(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export interface LinkCodeOptions {
  ttlMs?: number;
  max?: number;
  now?: () => number;
}

/** The codes issued and not yet used or expired, in memory only, bounded. */
export class LinkCodes {
  readonly #byHash = new Map<string, { code: string; expires: number }>();
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;

  constructor(options: LinkCodeOptions = {}) {
    this.#ttlMs = options.ttlMs ?? LINK_CODE_TTL_MS;
    this.#max = options.max ?? MAX_LINK_CODES;
    this.#now = options.now ?? Date.now;
  }

  /** A new code: 32 random bytes as base64url. */
  issue(): string {
    this.#sweep();
    // Map keeps insertion order, so the first key is the oldest.
    while (this.#byHash.size >= this.#max) {
      const oldest = this.#byHash.keys().next().value;
      if (oldest === undefined) break;
      this.#byHash.delete(oldest);
    }
    const code = randomBytes(32).toString('base64url');
    this.#byHash.set(linkCodeHash(code), { code, expires: this.#now() + this.#ttlMs });
    return code;
  }

  /** The code for this hash, once: it's forgotten as it's returned. Undefined when it isn't one issued, is used or expired. */
  redeem(hash: string): string | undefined {
    if (!isLinkCodeHash(hash)) return undefined;
    const held = this.#byHash.get(hash);
    if (held === undefined) return undefined;
    this.#byHash.delete(hash);
    return held.expires > this.#now() ? held.code : undefined;
  }

  get size(): number {
    this.#sweep();
    return this.#byHash.size;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [hash, held] of this.#byHash) {
      if (held.expires <= now) this.#byHash.delete(hash);
    }
  }
}

/** Whether the request is the browser loading a page, as a person or a link does, and not a script's fetch, frame or fetch-like request. */
export function isDocumentNavigation(header: (name: string) => string | undefined): boolean {
  return header('sec-fetch-dest') === 'document' && header('sec-fetch-mode') === 'navigate';
}

const LINK_META = /(<meta\s+name="pitwall-link"\s+content=")(")/;

/** Puts `code` in the page's <meta name="pitwall-link"> tag, or returns the page as it was when it has none. */
export function withLinkCode(html: string, code: string): string {
  return html.replace(LINK_META, (_match, open: string, close: string) => `${open}${code}${close}`);
}

/** Whether the page has the tag a code goes in. */
export function hasLinkTag(html: string): boolean {
  return LINK_META.test(html);
}

/**
 * Limits one WebSocket's confirmations: at most MAX_LINK_CONFIRMS in LINK_CONFIRM_WINDOW_MS. A tab that
 * is signed in is trusted with the token, so this is only to keep one stuck loop from hammering the server.
 */
export class ConfirmLimit {
  #times: number[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly max = MAX_LINK_CONFIRMS,
    private readonly windowMs = LINK_CONFIRM_WINDOW_MS,
  ) {}

  allow(): boolean {
    const now = this.now();
    this.#times = this.#times.filter((time) => now - time < this.windowMs);
    if (this.#times.length >= this.max) return false;
    this.#times.push(now);
    return true;
  }
}
