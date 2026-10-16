// One WebSocket client: authenticate with the first message, then get the
// latest snapshot, and after every poll either the new snapshot, when it
// changed, or a heartbeat. `Host` and `Origin` are checked before the upgrade,
// in server.ts.
import type { RawData, WebSocket } from 'ws';
import type { Indexer } from '../index/index.js';
import { WS_CLOSE_UNAUTHORIZED, type IndexSnapshot, type ServerMessage } from '../shared/protocol.js';
import { tokensMatch } from './security.js';

/** Incoming frames are capped at this many bytes. An auth message is about 60. */
export const MAX_PAYLOAD_BYTES = 1024;

/** How long a new connection has to send `{ type: 'auth' }`. */
export const DEFAULT_AUTH_TIMEOUT_MS = 5000;

export interface ClientContext {
  indexer: Indexer;
  token: string;
  authTimeoutMs: number;
}

export function handleClient(ws: WebSocket, context: ClientContext): void {
  let state: 'pending' | 'authed' | 'rejected' = 'pending';
  let unsubscribe: (() => void) | undefined;

  const reject = () => {
    state = 'rejected';
    clearTimeout(timer);
    ws.close(WS_CLOSE_UNAUTHORIZED);
  };
  const timer = setTimeout(reject, context.authTimeoutMs);

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

  ws.on('message', (data, isBinary) => {
    // M1 has no client messages after auth, so anything else is ignored.
    if (state !== 'pending') return;
    if (isBinary || !isValidAuth(data, context.token)) {
      reject();
      return;
    }
    state = 'authed';
    clearTimeout(timer);
    // The first snapshot may have arrived before this client connected, so send
    // it now. Reading it and subscribing happen in the same tick, so no
    // snapshot is missed or sent twice.
    const current = context.indexer.latest();
    if (current) send(current);
    unsubscribe = context.indexer.subscribe(send);
  });

  ws.on('close', () => {
    clearTimeout(timer);
    unsubscribe?.();
    unsubscribe = undefined;
  });

  // Oversized frames and protocol errors land here, followed by 'close'.
  // Without a listener, ws would throw and take the process down.
  ws.on('error', () => {});
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

function isValidAuth(data: RawData, token: string): boolean {
  let message: unknown;
  try {
    message = JSON.parse(rawToString(data));
  } catch {
    return false;
  }
  if (typeof message !== 'object' || message === null) return false;
  const { type, token: presented } = message as Record<string, unknown>;
  return type === 'auth' && typeof presented === 'string' && tokensMatch(presented, token);
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
