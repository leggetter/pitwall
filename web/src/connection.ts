// The live connection to the pitwall server: authenticate, keep the latest
// snapshot, and reconnect with backoff unless the token was rejected.

import { useEffect, useState } from 'react';
import {
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
  type ClientMessage,
  type IndexSnapshot,
  type ServerMessage,
} from '../../src/shared/protocol.js';

/**
 * - `connecting`: the first attempt, until the first snapshot arrives.
 * - `live`: a snapshot has arrived on the current socket.
 * - `reconnecting`: the socket closed and a new attempt is pending or underway.
 * - `unauthorized`: the server closed with 4401. Pitwall stops trying.
 */
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'unauthorized';

/** The subset of the browser `WebSocket` the connection uses. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url);

export interface ConnectionView {
  state: ConnectionState;
  snapshot?: IndexSnapshot;
  /** The newest `{ type: 'error' }` message from the server. */
  serverError?: string;
}

export interface ConnectionOptions {
  url: string;
  token: string;
  createSocket?: SocketFactory;
  onChange: (view: ConnectionView) => void;
}

export interface Connection {
  /** Stops the connection for good: closes the socket and cancels any pending reconnect. */
  close(): void;
}

export const BACKOFF_INITIAL_MS = 1_000;
export const BACKOFF_MAX_MS = 10_000;

/** Delay before reconnect attempt `attempt` (0-based): 1 s, 2 s, 4 s, 8 s, then 10 s. */
export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_INITIAL_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

export function socketUrl(host: string): string {
  return `ws://${host}${WS_PATH}`;
}

/** Parses a server message, ignoring anything malformed or of a type this UI doesn't know. */
export function parseServerMessage(data: unknown): ServerMessage | undefined {
  if (typeof data !== 'string') return undefined;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof message !== 'object' || message === null) return undefined;
  const candidate = message as Record<string, unknown>;
  if (candidate.type === 'snapshot') {
    const snapshot = candidate.snapshot as Record<string, unknown> | undefined;
    if (snapshot && Array.isArray(snapshot.groups) && Array.isArray(snapshot.roots)) {
      return { type: 'snapshot', snapshot: snapshot as unknown as IndexSnapshot };
    }
    return undefined;
  }
  if (candidate.type === 'error' && typeof candidate.error === 'string') {
    return { type: 'error', error: candidate.error };
  }
  return undefined;
}

export function createConnection(options: ConnectionOptions): Connection {
  const { url, token, onChange } = options;
  const createSocket = options.createSocket ?? defaultSocketFactory;

  let view: ConnectionView = { state: 'connecting' };
  let socket: SocketLike | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;

  const update = (patch: Partial<ConnectionView>) => {
    view = { ...view, ...patch };
    onChange(view);
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    const delay = backoffDelay(attempt);
    attempt += 1;
    if (view.state !== 'reconnecting') update({ state: 'reconnecting' });
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, delay);
  };

  const connect = () => {
    if (stopped) return;
    let current: SocketLike;
    try {
      current = createSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = current;

    current.onopen = () => {
      const auth: ClientMessage = { type: 'auth', token };
      current.send(JSON.stringify(auth));
    };

    current.onmessage = (event) => {
      if (stopped || socket !== current) return;
      const message = parseServerMessage(event.data);
      if (!message) return;
      if (message.type === 'snapshot') {
        attempt = 0;
        update({ state: 'live', snapshot: message.snapshot });
      } else {
        update({ serverError: message.error });
      }
    };

    // A failed connection fires `error` and then `close`; the close handler decides.
    current.onerror = () => {};

    current.onclose = (event) => {
      if (stopped || socket !== current) return;
      socket = undefined;
      if (event.code === WS_CLOSE_UNAUTHORIZED) {
        stopped = true;
        update({ state: 'unauthorized' });
        return;
      }
      scheduleReconnect();
    };
  };

  onChange(view);
  connect();

  return {
    close() {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      const current = socket;
      socket = undefined;
      if (current) {
        current.onopen = null;
        current.onmessage = null;
        current.onclose = null;
        current.onerror = null;
        current.close();
      }
    },
  };
}

/** Holds a connection open for as long as the component is mounted and the token stays the same. */
export function useConnection(
  token: string | null,
  createSocket: SocketFactory = defaultSocketFactory,
  host: string = window.location.host,
): ConnectionView {
  const [view, setView] = useState<ConnectionView>({ state: 'connecting' });

  useEffect(() => {
    if (!token) return;
    const connection = createConnection({ url: socketUrl(host), token, createSocket, onChange: setView });
    return () => connection.close();
  }, [token, createSocket, host]);

  return view;
}
