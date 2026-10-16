// One WebSocket client: a challenge-response handshake, then the latest
// snapshot, and after every poll either the new snapshot, when it changed, or
// a heartbeat. `Host` and `Origin` are checked before the upgrade, in
// server.ts.
//
// The handshake (PROTOCOL_VERSION 2, src/shared/protocol.ts):
//   server  { type: 'challenge', version, nonce }   a fresh 32-byte nonce per connection
//   client  { type: 'auth', proof }                 base64url(HMAC-SHA256(token, nonce))
//   server  { type: 'authenticated', apiKey }       then the snapshot
//
// The raw token never crosses the socket, so a process squatting on the port
// learns nothing it can reuse: a proof is good for one nonce, and each nonce
// belongs to one connection. Each connection gets one attempt. A wrong proof,
// no proof within the timeout, M1's `{ type: 'auth', token }`, a binary frame,
// or any other message closes the connection with 4401.
import type { RawData, WebSocket } from 'ws';
import type { Indexer } from '../index/index.js';
import {
  PROTOCOL_VERSION,
  WS_CLOSE_UNAUTHORIZED,
  type IndexSnapshot,
  type ServerMessage,
} from '../shared/protocol.js';
import { proofMatches, randomSecret } from './security.js';

/** Incoming frames are capped at this many bytes. An auth message is about 70. */
export const MAX_PAYLOAD_BYTES = 1024;

/** How long a new connection has to answer the challenge. */
export const DEFAULT_AUTH_TIMEOUT_MS = 5000;

export interface ClientContext {
  indexer: Indexer;
  token: string;
  /** Sent in 'authenticated'. One per server process, made in startServer. */
  apiKey: string;
  authTimeoutMs: number;
}

export function handleClient(ws: WebSocket, context: ClientContext): void {
  let state: 'pending' | 'authed' | 'rejected' = 'pending';
  let unsubscribe: (() => void) | undefined;
  // Fresh for every connection and never stored anywhere else, so a proof for
  // it can't be replayed on another connection.
  const nonce = randomSecret();

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
    // One attempt per connection. There are no client messages after auth, so
    // anything an authenticated client sends is ignored.
    if (state !== 'pending') return;
    const proof = isBinary ? undefined : parseAuth(data);
    if (proof === undefined || !proofMatches(proof, context.token, nonce)) {
      reject();
      return;
    }
    state = 'authed';
    clearTimeout(timer);
    sendMessage(ws, { type: 'authenticated', apiKey: context.apiKey });
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

  sendMessage(ws, { type: 'challenge', version: PROTOCOL_VERSION, nonce });
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

/**
 * The proof from `{ "type": "auth", "proof": "..." }`, exactly that shape and
 * nothing more, or undefined. Extra fields are refused rather than ignored, so
 * a message that also carries M1's `token`, or a `version` the contract
 * doesn't define for the client, fails the handshake.
 */
function parseAuth(data: RawData): string | undefined {
  let message: unknown;
  try {
    message = JSON.parse(rawToString(data));
  } catch {
    return undefined;
  }
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined;
  const fields = message as Record<string, unknown>;
  if (Object.keys(fields).length !== 2 || fields.type !== 'auth' || typeof fields.proof !== 'string') return undefined;
  return fields.proof;
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
