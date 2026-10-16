// The live connection to the pitwall server: answer the challenge, hand the
// apiKey to the API client, keep the latest snapshot and the latest poll's
// time and health, and reconnect with backoff unless the token was rejected.
//
// The handshake (src/shared/protocol.ts, PROTOCOL_VERSION 2): the server sends
// a challenge with a nonce, and the page answers with base64url(HMAC-SHA256(
// token, nonce)), computed with WebCrypto. The token itself is never sent, on
// the socket or anywhere else. Every connection, including each reconnect,
// answers a fresh challenge and gets the server's current apiKey, so after a
// restart the page has the new key without doing anything.

import { useEffect, useState } from 'react';
import {
  PROTOCOL_VERSION,
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
  type ClientMessage,
  type IndexSnapshot,
  type ServerMessage,
  type SourceHealth,
} from '../../src/shared/protocol.js';
import type { ApiKeys } from './api.js';

/**
 * - `connecting`: the first attempt, until the first snapshot arrives.
 * - `live`: a snapshot or a heartbeat has arrived on the current socket.
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

/** When the index last polled, and whether `claude agents --json` worked then. */
export interface PollStatus {
  generatedAt: string;
  source: SourceHealth;
}

export interface ConnectionView {
  state: ConnectionState;
  snapshot?: IndexSnapshot;
  /**
   * The newest poll the server reported, by a snapshot or a heartbeat. A
   * heartbeat updates this and leaves the snapshot as it is, because nothing
   * else changed.
   */
  lastPoll?: PollStatus;
  /** The newest `{ type: 'error' }` message from the server, or a handshake problem the page can't fix itself. */
  serverError?: string;
}

/** Computes the answer to a challenge. */
export type Prover = (token: string, nonce: string) => Promise<string>;

export interface ConnectionOptions {
  url: string;
  /** Used only to compute proofs. Never sent. */
  token: string;
  createSocket?: SocketFactory;
  onChange: (view: ConnectionView) => void;
  /** Gets each apiKey, and asks for a reconnect when one has gone stale. Usually createApiClient().keys. */
  keys?: ApiKeys;
  /** Default computeProof, with WebCrypto. Tests wrap it so they can wait for it. */
  prove?: Prover;
}

export interface Connection {
  /** Stops the connection for good: closes the socket and cancels any pending reconnect. */
  close(): void;
  /**
   * Replaces an authenticated socket straight away, for a fresh challenge and
   * the server's current apiKey. Does nothing while a connection or
   * reconnect is already underway, since that brings a new key anyway.
   */
  reconnect(): void;
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

/**
 * base64url(HMAC-SHA256(key = token as UTF-8, message = nonce as UTF-8)), the
 * answer to a challenge. WebCrypto is available because pitwall's page is
 * served from http://127.0.0.1, which browsers treat as a secure context.
 */
export async function computeProof(token: string, nonce: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(nonce));
  return toBase64Url(new Uint8Array(signature));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 bytes as base64url, as the contract says for both the nonce and the apiKey. */
const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

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
  if (candidate.type === 'challenge') {
    // Any numeric version parses, so a mismatch can be reported rather than ignored.
    if (typeof candidate.version === 'number' && typeof candidate.nonce === 'string' && SECRET_SHAPE.test(candidate.nonce)) {
      return { type: 'challenge', version: candidate.version, nonce: candidate.nonce };
    }
    return undefined;
  }
  if (candidate.type === 'authenticated') {
    if (typeof candidate.apiKey === 'string' && SECRET_SHAPE.test(candidate.apiKey)) {
      return { type: 'authenticated', apiKey: candidate.apiKey };
    }
    return undefined;
  }
  if (candidate.type === 'snapshot') {
    const snapshot = candidate.snapshot as Record<string, unknown> | undefined;
    if (snapshot && Array.isArray(snapshot.groups) && Array.isArray(snapshot.roots)) {
      return { type: 'snapshot', snapshot: snapshot as unknown as IndexSnapshot };
    }
    return undefined;
  }
  if (candidate.type === 'heartbeat') {
    if (typeof candidate.generatedAt === 'string' && isSourceHealth(candidate.source)) {
      return { type: 'heartbeat', generatedAt: candidate.generatedAt, source: candidate.source };
    }
    return undefined;
  }
  if (candidate.type === 'error' && typeof candidate.error === 'string') {
    return { type: 'error', error: candidate.error };
  }
  return undefined;
}

function isSourceHealth(value: unknown): value is SourceHealth {
  if (typeof value !== 'object' || value === null) return false;
  const { ok, error } = value as Record<string, unknown>;
  return ok === true || (ok === false && typeof error === 'string');
}

export function createConnection(options: ConnectionOptions): Connection {
  const { url, token, onChange, keys } = options;
  const createSocket = options.createSocket ?? defaultSocketFactory;
  const prove = options.prove ?? computeProof;

  let view: ConnectionView = { state: 'connecting' };
  let socket: SocketLike | undefined;
  // The socket the current apiKey came from, once the server has accepted its proof.
  let authenticated: SocketLike | undefined;
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

  /** Stops listening to a socket and closes it. Its key, if it had one, is no longer current. */
  const discard = (current: SocketLike) => {
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    current.close();
    if (socket === current) socket = undefined;
    if (authenticated === current) authenticated = undefined;
    keys?.clear();
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
    // One answer per connection: a second challenge on the same socket is ignored.
    let answered = false;

    current.onmessage = (event) => {
      if (stopped || socket !== current) return;
      const message = parseServerMessage(event.data);
      if (!message) return;

      if (message.type === 'challenge') {
        if (answered) return;
        answered = true;
        if (message.version !== PROTOCOL_VERSION) {
          // Not a server this page can talk to, probably a newer pitwall: no
          // proof for it. A reload fetches the page that matches the server.
          update({
            serverError: `The server speaks pitwall protocol version ${message.version}, and this page speaks version ${PROTOCOL_VERSION}. Reload the page.`,
          });
          discard(current);
          scheduleReconnect();
          return;
        }
        prove(token, message.nonce).then(
          (proof) => {
            if (stopped || socket !== current) return;
            const auth: ClientMessage = { type: 'auth', proof };
            current.send(JSON.stringify(auth));
          },
          () => {
            if (stopped || socket !== current) return;
            update({ serverError: "This browser couldn't compute the sign-in proof (WebCrypto is unavailable)." });
            discard(current);
            scheduleReconnect();
          },
        );
        return;
      }

      if (message.type === 'authenticated') {
        if (!answered || authenticated === current) return;
        authenticated = current;
        keys?.set(message.apiKey);
        return;
      }

      // Nothing else counts until the server has accepted this socket's proof.
      if (authenticated !== current) return;
      if (message.type === 'snapshot') {
        attempt = 0;
        const { generatedAt, source } = message.snapshot;
        update({ state: 'live', snapshot: message.snapshot, lastPoll: { generatedAt, source } });
      } else if (message.type === 'heartbeat') {
        // The index is alive and nothing changed: the snapshot stays as it is.
        attempt = 0;
        update({ state: 'live', lastPoll: { generatedAt: message.generatedAt, source: message.source } });
      } else if (message.type === 'error') {
        update({ serverError: message.error });
      }
    };

    // A failed connection fires `error` and then `close`; the close handler decides.
    current.onerror = () => {};

    current.onclose = (event) => {
      if (stopped || socket !== current) return;
      socket = undefined;
      if (authenticated === current) authenticated = undefined;
      if (event.code === WS_CLOSE_UNAUTHORIZED) {
        stop();
        keys?.reject();
        update({ state: 'unauthorized' });
        return;
      }
      keys?.clear();
      scheduleReconnect();
    };
  };

  const reconnect = () => {
    if (stopped || !authenticated || socket !== authenticated) return;
    discard(authenticated);
    update({ state: 'reconnecting' });
    connect();
  };

  const unsubscribeStale = keys?.onStale(reconnect);

  const stop = () => {
    stopped = true;
    unsubscribeStale?.();
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  onChange(view);
  connect();

  return {
    close() {
      stop();
      const current = socket;
      if (current) discard(current);
    },
    reconnect,
  };
}

export interface UseConnectionOptions {
  /** Opens the WebSocket. Tests pass a fake; the browser's `WebSocket` otherwise. */
  createSocket?: SocketFactory;
  /** Default window.location.host: the server that served this page. */
  host?: string;
  /** Gets each apiKey. Usually the app's createApiClient().keys. */
  keys?: ApiKeys;
}

/** Holds a connection open for as long as the component is mounted and the token stays the same. */
export function useConnection(token: string | null, options: UseConnectionOptions = {}): ConnectionView {
  const { createSocket = defaultSocketFactory, host = window.location.host, keys } = options;
  const [view, setView] = useState<ConnectionView>({ state: 'connecting' });

  useEffect(() => {
    if (!token) return;
    const connection = createConnection({ url: socketUrl(host), token, createSocket, onChange: setView, ...(keys ? { keys } : {}) });
    return () => connection.close();
  }, [token, createSocket, host, keys]);

  return view;
}
