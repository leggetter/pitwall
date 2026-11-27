// Link codes (W175, D7): how a pitwall link opened in a new tab gets the token from a tab that already
// has it, without a page from another process getting it too.
//
// A tab opened at a pitwall link has no token (it lives in each tab's sessionStorage). It asks the
// pitwall tabs already open, on a BroadcastChannel, which is shared by every page on the same origin,
// and the origin is only a string: a page that another account's process served on this port, and that
// is still open, shares it. So the tab must prove which server served it, and the answer must be
// readable by that tab alone.
//
// - A code goes only to a navigation that no page started: Sec-Fetch-Dest: document, Sec-Fetch-Mode:
//   navigate and Sec-Fetch-Site: none (typed, bookmarked, or opened from outside the browser, such as a
//   terminal link), with no Sec-Purpose (prefetch, prerender). window.open, location.reload(),
//   location.href= and history.go(0) arrive as same-origin, so a stale page on this origin can't open
//   pitwall and read the code from its tag. Page scripts can't set these headers. The page blanks the
//   tag once it has read the code (tokenLink.ts). The cost: a link clicked on a web page shows
//   the sign-in notice, as before W175. A link to pitwall's own address clicked inside pitwall navigates in
//   the same tab, which has the token (W220, web/src/ownLinks.ts), so it never gets here.
// - Cross-Origin-Opener-Policy: same-origin (security.ts) is defence in depth only. A stale page can send
//   the same header itself and keep its handle on a window it opens, so it is not what protects the code.
// - The tab sends the channel only the code's hash. A tab that has the token, and a signed-in
//   WebSocket, sends that hash to the server over the socket. The server returns the code once, if it
//   issued it, hasn't seen it used and it hasn't expired, with a MAC under the token (security.ts,
//   linkConfirmMac()) that the tab checks before it uses the code, so a process that took the port after
//   pitwall stopped can't pick the code. The tab encrypts the token under the code and broadcasts the
//   ciphertext. Only the page with the code can read the answer, so a listener on the channel learns
//   nothing, and a request replayed with the hash is answered with nothing, since the code is spent.
// - F2 (W175's review; Phil chose the fix on 2026-11-16): a stale page from another account plus a local
//   process of that account that forges Fetch Metadata could have obtained a code. So a code is issued only
//   when the TCP peer of the request's socket is a process owned by pitwall's own uid (peerUid.ts). A process
//   of the same user is out of scope: it can read ~/.pitwall/ and the launch file anyway. macOS asks lsof,
//   Linux reads /proc/net/tcp and tcp6; any other platform, an error, a timeout or output it can't read fails
//   closed, and the page shows the sign-in notice. Residual: a small race between the check and the request,
//   and a process of another account that can inject into one of this user's processes is out of scope.
//   peerUid.ts matches the connection's exact addresses, not only its ports (W175's re-review, finding 1).
// - G2 (W175's re-review): a reload or restored tab (Cache-Control: max-age=0 or no-cache, or Pragma) gets no
//   code, since an old page may hold a window handle to that tab. Accepted residual: a URL typed into a
//   window an old page holds still gets one; the server can't tell it from a link opened from outside.
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

/**
 * Whether the request is a navigation no page started: the browser loading a page for a typed or
 * bookmarked address or a link from outside the browser (Sec-Fetch-Site: none), and not a prefetch or
 * prerender (Sec-Purpose). A script's fetch, a frame, and a navigation a page made (window.open,
 * location.reload() and the like, which are same-origin) all fail it.
 */
export function isDocumentNavigation(header: (name: string) => string | undefined): boolean {
  return (
    header('sec-fetch-dest') === 'document' &&
    header('sec-fetch-mode') === 'navigate' &&
    header('sec-fetch-site') === 'none' &&
    header('sec-purpose') === undefined &&
    // Not a reload (W175's re-review, G2): a reloaded or restored tab may be one an old page holds a
    // window handle to. Browsers send these on a reload and not on a link opened from outside.
    !/\b(?:max-age=0|no-cache)\b/i.test(header('cache-control') ?? '') &&
    header('pragma') === undefined
  );
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
