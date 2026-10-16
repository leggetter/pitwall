// One WebSocket client: authenticate with the first message, then stream
// snapshots. `Host` and `Origin` are checked before the upgrade, in server.ts.
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

  const send = (snapshot: IndexSnapshot) => {
    if (ws.readyState === ws.OPEN) ws.send(serialiseSnapshot(snapshot));
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

export function serialiseSnapshot(snapshot: IndexSnapshot): string {
  const message: ServerMessage = { type: 'snapshot', snapshot };
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
