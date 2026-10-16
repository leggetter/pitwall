// Full replies, fetched when a row is expanded. The snapshot carries only a
// 500-character preview; GET lastMessagePath(sessionId) returns the rest. The
// request carries the same token as the WebSocket, as a bearer token.

import { createContext } from 'react';
import { lastMessagePath, type LastMessage } from '../../src/shared/protocol.js';

export type ReplyResult =
  | { kind: 'ok'; message: LastMessage }
  /** The server refused the token. The loader has already told its owner. */
  | { kind: 'unauthorized' }
  /** Anything else: not found, a network error, or a response that isn't a LastMessage. */
  | { kind: 'failed' };

export interface ReplyLoader {
  /** The reply already fetched for the session at this activity time, if any. */
  cached(sessionId: string, lastActivityAt: string | undefined): LastMessage | undefined;
  /**
   * Fetches the session's full reply, or returns the cached one. Replies are
   * cached by session id and `lastActivityAt`, so once the session moves on,
   * the next load fetches again. Never rejects.
   */
  load(sessionId: string, lastActivityAt: string | undefined): Promise<ReplyResult>;
}

/** The subset of `fetch` the loader uses. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The browser's fetch, called on window so it isn't an illegal invocation. */
export const defaultFetch: FetchLike = (url, init) => window.fetch(url, init);

export interface ReplyLoaderOptions {
  token: string;
  fetch?: FetchLike;
  /** Called when the server answers 401, so the UI can say the token was rejected. */
  onUnauthorized?: () => void;
  /** How many replies to keep. Each can be 64 KiB of text. Default 32. */
  cacheSize?: number;
}

export const REPLY_CACHE_SIZE = 32;

export function createReplyLoader(options: ReplyLoaderOptions): ReplyLoader {
  const { token, onUnauthorized } = options;
  const fetchImpl = options.fetch ?? defaultFetch;
  const cacheSize = options.cacheSize ?? REPLY_CACHE_SIZE;
  // A Map keeps insertion order, so the first key is the least recently used.
  const cache = new Map<string, LastMessage>();
  const inFlight = new Map<string, Promise<ReplyResult>>();

  const keyOf = (sessionId: string, lastActivityAt: string | undefined) => `${sessionId}\0${lastActivityAt ?? ''}`;

  const remember = (key: string, message: LastMessage) => {
    cache.delete(key);
    cache.set(key, message);
    while (cache.size > cacheSize) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const request = async (sessionId: string, key: string): Promise<ReplyResult> => {
    let response: Response;
    try {
      response = await fetchImpl(lastMessagePath(sessionId), {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
    } catch {
      return { kind: 'failed' };
    }
    if (response.status === 401) {
      onUnauthorized?.();
      return { kind: 'unauthorized' };
    }
    if (!response.ok) return { kind: 'failed' };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: 'failed' };
    }
    const message = asLastMessage(body, sessionId);
    if (!message) return { kind: 'failed' };
    remember(key, message);
    return { kind: 'ok', message };
  };

  return {
    cached(sessionId, lastActivityAt) {
      const key = keyOf(sessionId, lastActivityAt);
      const message = cache.get(key);
      if (message) remember(key, message);
      return message;
    },
    load(sessionId, lastActivityAt) {
      const key = keyOf(sessionId, lastActivityAt);
      const message = cache.get(key);
      if (message) {
        remember(key, message);
        return Promise.resolve({ kind: 'ok', message });
      }
      let pending = inFlight.get(key);
      if (!pending) {
        pending = request(sessionId, key).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      return pending;
    },
  };
}

/** The body as a LastMessage for `sessionId`, or undefined when it isn't one. */
function asLastMessage(body: unknown, sessionId: string): LastMessage | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { sessionId: id, text, truncated, at } = body as Record<string, unknown>;
  if (id !== sessionId || typeof text !== 'string' || typeof truncated !== 'boolean') return undefined;
  if (at !== undefined && typeof at !== 'string') return undefined;
  return at === undefined ? { sessionId, text, truncated } : { sessionId, text, truncated, at };
}

/**
 * The loader for the rows on screen. Without one, as in tests that render the
 * dashboard alone, "Show more" expands the preview and fetches nothing.
 */
export const ReplyLoaderContext = createContext<ReplyLoader | undefined>(undefined);
