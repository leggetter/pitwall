// A pitwall link opened in a new tab (W175, D7). The new tab has no token, since each tab keeps its own
// in sessionStorage (token.ts). It asks the pitwall tabs already open, on a BroadcastChannel, which every
// page on this origin can read, so nothing secret goes on it in the clear:
//
//   1. The server put a one-time code in this page when the browser loaded it (the <meta name="pitwall-link">
//      tag; src/server/linkCodes.ts). Only a page loaded by a navigation gets one. The tab sends the channel
//      the code's SHA-256, never the code.
//   2. A tab that has the token, and a WebSocket signed in to the server that served it, sends that hash to
//      the server. The server returns the code once, if it issued it, hasn't seen it used and it hasn't
//      expired (LinkConfirmer, below).
//   3. That tab encrypts the token under the code with AES-GCM and broadcasts the ciphertext. Only the tab
//      with the code in its page can read it, so another page on the origin, such as a stale one a different
//      process served, learns nothing from the request or the answer, and has no code of its own.
//
// The token never goes in a URL, localStorage or a cookie. The new tab stores it in its own sessionStorage,
// as if from the launch file, and signs in as usual (connection.ts).

import { useEffect, useState } from 'react';
import { TOKEN_STORAGE_KEY } from './token.js';

export const LINK_CHANNEL = 'pitwall.link';
export const LINK_META = 'pitwall-link';

/** How long a tab with no token waits for an answer before it shows the notice. */
export const LINK_ANSWER_TIMEOUT_MS = 2_000;
/** How long a tab with a token waits for the server to confirm a code. */
export const LINK_CONFIRM_TIMEOUT_MS = 3_000;
/** A tab with the token answers at most this many requests in LINK_RATE_WINDOW_MS, and none twice. */
export const LINK_RATE_MAX = 10;
export const LINK_RATE_WINDOW_MS = 10_000;
const SEEN_MAX = 128;

const HASH_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export type LinkRequest = { type: 'link-request'; hash: string };
export type LinkAnswer = { type: 'link-answer'; hash: string; iv: string; data: string };

/** The part of BroadcastChannel the link uses. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type ChannelFactory = () => ChannelLike;

export const defaultChannel: ChannelFactory | undefined =
  typeof BroadcastChannel === 'function' ? () => new BroadcastChannel(LINK_CHANNEL) as unknown as ChannelLike : undefined;

/** The link code the server put in this page, or null. */
export function pageLinkCode(doc: Pick<Document, 'querySelector'> = document): string | null {
  const content = doc.querySelector(`meta[name="${LINK_META}"]`)?.getAttribute('content');
  return content && /^[A-Za-z0-9_-]{43}$/.test(content) ? content : null;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** base64url(SHA-256(code as UTF-8)): what the server computes for the code it issued. */
export async function linkCodeHash(code: string, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  return toBase64Url(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(code))));
}

function codeKey(code: string, subtle: SubtleCrypto, usage: KeyUsage): Promise<CryptoKey> {
  return subtle.importKey('raw', fromBase64Url(code), 'AES-GCM', false, [usage]);
}

/** Encrypts the token under the code, bound to the hash: the answer for the page that holds the code. */
export async function sealToken(token: string, code: string, hash: string, subtle: SubtleCrypto = crypto.subtle): Promise<LinkAnswer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(hash) },
    await codeKey(code, subtle, 'encrypt'),
    new TextEncoder().encode(token),
  );
  return { type: 'link-answer', hash, iv: toBase64Url(iv), data: toBase64Url(new Uint8Array(data)) };
}

export interface AskOptions {
  /** The link code in this page. Default: the page's own tag. */
  code?: string | null;
  channel?: ChannelFactory | undefined;
  subtle?: SubtleCrypto;
  timeoutMs?: number;
  /** Where a token goes once it's read. Default: this tab's sessionStorage. */
  store?: (token: string) => void;
}

/**
 * Asks the open pitwall tabs for the token. Resolves with it, after keeping it in this tab's
 * sessionStorage, or with null: no code in this page, no BroadcastChannel, or no answer in time.
 * Only an answer that decrypts under this page's code counts, so an answer for another page, or one
 * from a page that has no code, is ignored.
 */
export async function askForToken(options: AskOptions = {}): Promise<string | null> {
  const code = options.code === undefined ? pageLinkCode() : options.code;
  const factory = 'channel' in options ? options.channel : defaultChannel;
  if (!code || !factory) return null;
  const subtle = options.subtle ?? crypto.subtle;
  const store =
    options.store ??
    ((token: string) => {
      try {
        sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      } catch {
        // Storage can be disabled. The token still works until the page reloads.
      }
    });

  let hash: string;
  let key: CryptoKey;
  try {
    hash = await linkCodeHash(code, subtle);
    key = await codeKey(code, subtle, 'decrypt');
  } catch {
    return null;
  }

  return new Promise<string | null>((resolve) => {
    let channel: ChannelLike;
    try {
      channel = factory();
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (token: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      channel.onmessage = null;
      channel.close();
      resolve(token);
    };
    const timer = setTimeout(() => finish(null), options.timeoutMs ?? LINK_ANSWER_TIMEOUT_MS);

    channel.onmessage = (event) => {
      const message = event.data as Partial<LinkAnswer> | null;
      if (done || typeof message !== 'object' || message === null) return;
      if (message.type !== 'link-answer' || message.hash !== hash || typeof message.iv !== 'string' || typeof message.data !== 'string') return;
      void (async () => {
        try {
          const plain = await subtle.decrypt(
            { name: 'AES-GCM', iv: fromBase64Url(message.iv as string), additionalData: new TextEncoder().encode(hash) },
            key,
            fromBase64Url(message.data as string),
          );
          const token = new TextDecoder().decode(plain);
          if (!token) return;
          store(token);
          finish(token);
        } catch {
          // Not encrypted under this page's code: not an answer to this page.
        }
      })();
    };
    const request: LinkRequest = { type: 'link-request', hash };
    channel.postMessage(request);
  });
}

type LinkSend = (message: { type: 'link-confirm'; hash: string }) => void;

/**
 * Asks the server, over a signed-in WebSocket, whether it issued the code with this hash and hasn't seen
 * it used. There is no socket to ask on while the connection isn't signed in, and then the answer is no.
 */
export class LinkConfirmer {
  #send: LinkSend | undefined;
  readonly #pending = new Map<string, Array<(code: string | undefined) => void>>();

  constructor(private readonly timeoutMs: number = LINK_CONFIRM_TIMEOUT_MS) {}

  /** The connection signed in: confirmations can go on this socket. */
  open(send: LinkSend): void {
    this.#send = send;
  }

  /** The socket closed, or was replaced: every confirmation waiting gets no. */
  close(): void {
    this.#send = undefined;
    for (const [hash, waiters] of [...this.#pending]) {
      this.#pending.delete(hash);
      for (const resolve of waiters) resolve(undefined);
    }
  }

  confirm(hash: string): Promise<string | undefined> {
    const send = this.#send;
    if (!send) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiters = this.#pending.get(hash) ?? [];
      const timer = setTimeout(() => settle(undefined), this.timeoutMs);
      const settle = (code: string | undefined) => {
        clearTimeout(timer);
        const rest = (this.#pending.get(hash) ?? []).filter((each) => each !== settle);
        if (rest.length === 0) this.#pending.delete(hash);
        else this.#pending.set(hash, rest);
        resolve(code);
      };
      waiters.push(settle);
      this.#pending.set(hash, waiters);
      try {
        send({ type: 'link-confirm', hash });
      } catch {
        settle(undefined);
      }
    });
  }

  /** The server's reply, `link-confirmed` or `link-denied`, from the signed-in socket. */
  handle(message: { type: 'link-confirmed'; hash: string; code: string } | { type: 'link-denied'; hash: string }): void {
    const waiters = this.#pending.get(message.hash);
    if (!waiters) return;
    this.#pending.delete(message.hash);
    for (const resolve of waiters) resolve(message.type === 'link-confirmed' ? message.code : undefined);
  }
}

export interface AnswerOptions {
  token: string;
  confirmer: Pick<LinkConfirmer, 'confirm'>;
  channel?: ChannelFactory | undefined;
  subtle?: SubtleCrypto;
  now?: () => number;
}

/**
 * Answers other tabs' requests for as long as this tab holds the token and is signed in. A request is
 * answered only after the server confirms its code: `confirmer` says no while the socket is down. A
 * request that isn't the right shape, one seen before, and any over the rate limit are ignored.
 * Returns a function that stops listening.
 */
export function answerLinkRequests(options: AnswerOptions): () => void {
  const factory = 'channel' in options ? options.channel : defaultChannel;
  if (!factory) return () => {};
  const subtle = options.subtle ?? crypto.subtle;
  const now = options.now ?? Date.now;
  let channel: ChannelLike;
  try {
    channel = factory();
  } catch {
    return () => {};
  }
  const seen = new Set<string>();
  let times: number[] = [];

  channel.onmessage = (event) => {
    const message = event.data as Partial<LinkRequest> | null;
    if (typeof message !== 'object' || message === null || message.type !== 'link-request') return;
    const hash = message.hash;
    if (typeof hash !== 'string' || !HASH_SHAPE.test(hash)) return;
    // The first request with a hash is the only one considered: a copy of it with the same hash, from a
    // page that saw it on the channel, is not a second chance.
    if (seen.has(hash)) return;
    const at = now();
    times = times.filter((time) => at - time < LINK_RATE_WINDOW_MS);
    if (times.length >= LINK_RATE_MAX) return;
    times.push(at);
    seen.add(hash);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);

    void (async () => {
      try {
        const code = await options.confirmer.confirm(hash);
        if (code === undefined) return;
        channel.postMessage(await sealToken(options.token, code, hash, subtle));
      } catch {
        // Nothing is sent.
      }
    })();
  };

  return () => {
    channel.onmessage = null;
    channel.close();
  };
}

const requests = new Map<string, Promise<string | null>>();

/**
 * Asks for the token once when this page has none and the server gave it a link code. `asking` is true
 * from the first render until the answer or the timeout, so the notice never flashes.
 */
export function useLinkedToken(needed: boolean, channel: ChannelFactory | undefined): { token: string | null; asking: boolean } {
  const [state, setState] = useState<{ token: string | null; asking: boolean }>(() => ({
    token: null,
    asking: needed && channel !== undefined && pageLinkCode() !== null,
  }));

  useEffect(() => {
    if (!state.asking) return;
    let cancelled = false;
    // One request per code, however many times React runs this effect: a second request with the same
    // hash is ignored by the tabs that answer, and the code is spent after the first.
    const code = pageLinkCode();
    let asked = code === null ? undefined : requests.get(code);
    if (asked === undefined) {
      asked = askForToken({ channel, code });
      if (code !== null) requests.set(code, asked);
    }
    void asked.then((token) => {
      if (!cancelled) setState({ token, asking: false });
    });
    return () => {
      cancelled = true;
    };
    // Once per page load: the code is single use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
