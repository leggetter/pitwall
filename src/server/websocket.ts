// One WebSocket client: a challenge-response handshake (handshake.ts), then
// the latest snapshot, and after every poll either the new snapshot, when it
// changed, or a heartbeat. `Host` and `Origin` are checked before the
// upgrade, in server.ts.
//
// After a valid proof the server sends { type: 'authenticated', apiKey },
// then the snapshot. There are no client messages after auth, so anything an
// authenticated client sends is ignored.
import type { WebSocket } from 'ws';
import type { Indexer } from '../index/index.js';
import type { IndexSnapshot, ServerMessage } from '../shared/protocol.js';
import { DEFAULT_AUTH_TIMEOUT_MS, startHandshake } from './handshake.js';

export { DEFAULT_AUTH_TIMEOUT_MS };

/** Incoming frames are capped at this many bytes. An auth message is about 70. */
export const MAX_PAYLOAD_BYTES = 1024;

export interface ClientContext {
  indexer: Indexer;
  token: string;
  /** Sent in 'authenticated'. One per server process, made in startServer. */
  apiKey: string;
  authTimeoutMs: number;
}

export function handleClient(ws: WebSocket, context: ClientContext): void {
  let unsubscribe: (() => void) | undefined;

  // What the last snapshot sent to this client held, without generatedAt.
  // Kept per client, so one that joined late is compared with what it got.
  let lastSent: string | undefined;

  const send = (snapshot: IndexSnapshot) => {
    if (ws.readyState !== ws.OPEN) return;
    const content = snapshotContent(snapshot);
    if (content === lastSent) {
      ws.send(serialiseHeartbeat(snapshot));
      return;
    }
    ws.send(serialiseSnapshot(snapshot));
    lastSent = content;
  };

  ws.on('close', () => {
    unsubscribe?.();
    unsubscribe = undefined;
  });

  startHandshake(ws, {
    token: context.token,
    timeoutMs: context.authTimeoutMs,
    onAuthenticated: () => {
      sendMessage(ws, { type: 'authenticated', apiKey: context.apiKey });
      // The first snapshot may have arrived before this client connected, so send
      // it now. Reading it and subscribing happen in the same tick, so no
      // snapshot is missed or sent twice.
      const current = context.indexer.latest();
      if (current) send(current);
      unsubscribe = context.indexer.subscribe(send);
    },
  });
}

function sendMessage(ws: WebSocket, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}

// Every client is sent the same snapshot objects, so each is serialised once.
const contents = new WeakMap<IndexSnapshot, string>();
const snapshotMessages = new WeakMap<IndexSnapshot, string>();

/** Everything in the snapshot but generatedAt, as JSON, to tell whether anything changed. */
export function snapshotContent(snapshot: IndexSnapshot): string {
  let content = contents.get(snapshot);
  if (content === undefined) {
    const { generatedAt: _generatedAt, ...rest } = snapshot;
    content = JSON.stringify(rest);
    contents.set(snapshot, content);
  }
  return content;
}

export function serialiseSnapshot(snapshot: IndexSnapshot): string {
  let serialised = snapshotMessages.get(snapshot);
  if (serialised === undefined) {
    const message: ServerMessage = { type: 'snapshot', snapshot };
    serialised = JSON.stringify(message);
    snapshotMessages.set(snapshot, serialised);
  }
  return serialised;
}

/** The poll happened and found nothing new: when, and whether the session source worked. */
export function serialiseHeartbeat(snapshot: IndexSnapshot): string {
  const message: ServerMessage = { type: 'heartbeat', generatedAt: snapshot.generatedAt, source: snapshot.source };
  return JSON.stringify(message);
}
