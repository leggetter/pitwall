// Every HTTP API call the web UI makes goes through this file, so one place
// decides what a request carries: `Authorization: Bearer <apiKey>`, the key
// from the WebSocket's 'authenticated' message. Never the token. The token
// only ever leaves the page as an HMAC proof (connection.ts), so a process
// squatting on the port learns nothing it can reuse.
//
// The apiKey lives in memory only, in the ApiClient below, never in storage.
// It belongs to one server process: after a restart (every save under
// `npm run dev`) the old key gets 401. The client then drops it, the
// connection reconnects for a fresh challenge and the new key, and the
// request is retried once with that.
//
// For a new API call, such as a conversation page, in a component:
//
//   const api = useContext(ApiContext);
//   const result = await api.get(conversationPath(sessionId, before));
//   if (result.kind === 'ok') { ...validate result.body, which is unknown JSON... }
//
// api.get() waits while there's no key yet (connecting, or reconnecting after
// a restart), so a component can call it straight away and show its own
// loading state. With a key already in hand, apiGet(path, apiKey) is the
// same request without the waiting or the retry.

import { createContext } from 'react';

/** The subset of `fetch` the API calls use. Tests pass a fake. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The browser's fetch, called on window so it isn't an illegal invocation. */
export const defaultFetch: FetchLike = (url, init) => window.fetch(url, init);

export type ApiResult =
  /** A 2xx response, with its body parsed as JSON. Validate it before use. */
  | { kind: 'ok'; status: number; body: unknown }
  /**
   * From apiGet: the server answered 401, so the key is stale. From
   * ApiClient.get: the connection itself was refused (WebSocket 4401), and
   * the app is already showing that the token was rejected.
   */
  | { kind: 'unauthorized' }
  /**
   * Anything else: a network error, another status, a body that isn't JSON,
   * or an aborted request. `body` is the parsed JSON body of a non-2xx
   * response, when it had one, such as a SpawnResult's error and hint.
   * `retryAfter` is the response's Retry-After, in seconds, when it gave a
   * whole number of them, as the server does with 429.
   */
  | { kind: 'failed'; status?: number; body?: unknown; retryAfter?: number };

export interface ApiGetOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * GETs `path`, which must start with `/api/`, from this page's own server,
 * with the apiKey as a bearer token and no caching. Never rejects, except
 * for a path outside /api/, which is a bug in the caller.
 */
export function apiGet(path: string, apiKey: string, options: ApiGetOptions = {}): Promise<ApiResult> {
  return apiRequest('GET', path, apiKey, undefined, options);
}

/**
 * POSTs `body` as JSON to `path`, which must start with `/api/`, with the
 * apiKey as a bearer token. The browser adds this page's Origin, which the
 * server requires on state-changing requests. Never rejects, except for a
 * path outside /api/.
 */
export function apiPost(path: string, apiKey: string, body: unknown, options: ApiGetOptions = {}): Promise<ApiResult> {
  return apiRequest('POST', path, apiKey, body, options);
}

async function apiRequest(
  method: 'GET' | 'POST',
  path: string,
  apiKey: string,
  body: unknown,
  options: ApiGetOptions,
): Promise<ApiResult> {
  // A relative /api/ path only, so the key can't be sent to another origin.
  if (!path.startsWith('/api/')) throw new TypeError(`api${method === 'GET' ? 'Get' : 'Post'}: not an API path: ${path}`);
  const fetchImpl = options.fetch ?? defaultFetch;
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  // GET is fetch's default, so a GET's init stays exactly as it was before POST existed.
  const init: RequestInit = { headers, cache: 'no-store' };
  if (method === 'POST') {
    init.method = 'POST';
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  if (options.signal) init.signal = options.signal;
  let response: Response;
  try {
    response = await fetchImpl(path, init);
  } catch {
    return { kind: 'failed' };
  }
  if (response.status === 401) return { kind: 'unauthorized' };
  let parsed: unknown;
  let isJson = true;
  try {
    parsed = await response.json();
  } catch {
    isJson = false;
  }
  if (!response.ok) {
    const failed: ApiResult = isJson ? { kind: 'failed', status: response.status, body: parsed } : { kind: 'failed', status: response.status };
    const retryAfter = retryAfterSeconds(response.headers?.get?.('Retry-After') ?? null);
    return retryAfter === undefined ? failed : { ...failed, retryAfter };
  }
  return isJson ? { kind: 'ok', status: response.status, body: parsed } : { kind: 'failed', status: response.status };
}

/** A Retry-After header's delay in seconds, when it's a whole number of them; an HTTP date, or anything else, isn't read. */
export function retryAfterSeconds(header: string | null): number | undefined {
  if (header === null || !/^\s*\d{1,6}\s*$/.test(header)) return undefined;
  return Number(header.trim());
}

/** What components use. App provides one per connection, through ApiContext. */
export interface ApiClient {
  /**
   * GETs `path` with the current apiKey. Waits while there's none. On a 401
   * the key is stale: it's dropped, the connection is asked to reconnect,
   * and the request is retried once with the next key. Resolves
   * 'unauthorized' only when the connection was refused (4401), and 'failed'
   * when `signal` aborts. Never rejects, except for a path outside /api/.
   */
  get(path: string, options?: { signal?: AbortSignal }): Promise<ApiResult>;
  /**
   * POSTs `body` as JSON with the current apiKey, with the same waiting and
   * the same single retry after a 401 as get(). Retrying is safe because the
   * server refuses a stale key before the route runs. Other failures aren't
   * retried, because the route may have acted.
   */
  post(path: string, body: unknown, options?: { signal?: AbortSignal }): Promise<ApiResult>;
}

/** The connection's side of an ApiClient: it hands over each apiKey, and hears when one has gone stale. */
export interface ApiKeys {
  /** The server sent 'authenticated'. Requests waiting for a key go now. */
  set(apiKey: string): void;
  /** The socket closed or is being replaced: requests wait for the next key. */
  clear(): void;
  /** The server closed with 4401: waiting and later requests resolve 'unauthorized'. */
  reject(): void;
  /** Called when a request got 401 with the current key. Returns an unsubscribe function. */
  onStale(listener: () => void): () => void;
}

export interface ApiClientOptions {
  fetch?: FetchLike;
  /** Start with this key, as a test or a story would, instead of waiting for a connection's. */
  apiKey?: string;
}

type KeyState = { kind: 'waiting' } | { kind: 'ready'; apiKey: string } | { kind: 'rejected' };

export function createApiClient(options: ApiClientOptions = {}): ApiClient & { keys: ApiKeys } {
  const fetchImpl = options.fetch ?? defaultFetch;
  let state: KeyState = options.apiKey ? { kind: 'ready', apiKey: options.apiKey } : { kind: 'waiting' };
  const waiters = new Set<(apiKey: string | undefined) => void>();
  const staleListeners = new Set<() => void>();

  const settle = (apiKey: string | undefined) => {
    for (const waiter of [...waiters]) waiter(apiKey);
  };

  /** The current key, or the next one; undefined once rejected or aborted. */
  const nextKey = (signal: AbortSignal | undefined): Promise<string | undefined> => {
    if (state.kind === 'ready') return Promise.resolve(state.apiKey);
    if (state.kind === 'rejected' || signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const done = (apiKey: string | undefined) => {
        waiters.delete(done);
        signal?.removeEventListener('abort', onAbort);
        resolve(apiKey);
      };
      const onAbort = () => done(undefined);
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.add(done);
    });
  };

  const keys: ApiKeys = {
    set(apiKey) {
      state = { kind: 'ready', apiKey };
      settle(apiKey);
    },
    clear() {
      if (state.kind === 'ready') state = { kind: 'waiting' };
    },
    reject() {
      state = { kind: 'rejected' };
      settle(undefined);
    },
    onStale(listener) {
      staleListeners.add(listener);
      return () => {
        staleListeners.delete(listener);
      };
    },
  };

  const request = async (
    send: (apiKey: string, options: ApiGetOptions) => Promise<ApiResult>,
    signal: AbortSignal | undefined,
  ): Promise<ApiResult> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // With a key in hand, the request goes out in this same call, before any await.
      const apiKey = state.kind === 'ready' ? state.apiKey : await nextKey(signal);
      if (apiKey === undefined) return signal?.aborted ? { kind: 'failed' } : { kind: 'unauthorized' };
      const result = await send(apiKey, { fetch: fetchImpl, ...(signal ? { signal } : {}) });
      if (result.kind !== 'unauthorized') return result;
      // Nobody to fetch a new key from: give up rather than wait forever.
      if (staleListeners.size === 0) return { kind: 'failed', status: 401 };
      // The key is stale, as after a server restart. Unless another request
      // has already dropped it, drop it and ask for a fresh handshake.
      if (state.kind === 'ready' && state.apiKey === apiKey) {
        state = { kind: 'waiting' };
        for (const listener of [...staleListeners]) listener();
      }
    }
    return { kind: 'failed', status: 401 };
  };

  return {
    keys,
    get(path, { signal } = {}) {
      return request((apiKey, options) => apiGet(path, apiKey, options), signal);
    },
    post(path, body, { signal } = {}) {
      return request((apiKey, options) => apiPost(path, apiKey, body, options), signal);
    },
  };
}

/**
 * The ApiClient for the current connection. App provides it; it's undefined
 * only where a component is rendered without App, as in some tests.
 */
export const ApiContext = createContext<ApiClient | undefined>(undefined);
