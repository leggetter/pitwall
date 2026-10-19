// The challenge-response handshake every pitwall WebSocket starts with: the
// index socket at WS_PATH (websocket.ts) and the attach socket at ATTACH_PATH
// (attach.ts). Host and Origin are checked before the upgrade, in server.ts.
//
// The handshake (PROTOCOL_VERSION 3, src/shared/protocol.ts):
//   server  { type: 'challenge', version, nonce }   a fresh 32-byte nonce per connection
//   client  { type: 'auth', proof }                 base64url(HMAC-SHA256(token, nonce + "\n" + origin))
//   server  what the socket is for: 'authenticated' on WS_PATH, 'ready' on ATTACH_PATH
//
// The raw token never crosses the socket, so a process squatting on the port
// learns nothing it can reuse: a proof is good for one nonce, and each nonce
// belongs to one connection. The proof is also bound to the page's origin,
// and the server checks it against its own, http://127.0.0.1:<port>, so a
// squatter on another port can't pass a challenge to a real pitwall page and
// relay back the proof. Each connection gets one attempt. A wrong proof, a
// version 2 proof (no origin), no proof within the timeout, M1's
// `{ type: 'auth', token }`, a binary frame, or any other message closes the
// connection with 4401.
import type { RawData, WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  WS_CLOSE_UNAUTHORIZED,
  type AttachServerMessage,
  type ServerMessage,
} from '../shared/protocol.js';
import { proofMatches, randomSecret } from './security.js';

/** How long a new connection has to answer the challenge. */
export const DEFAULT_AUTH_TIMEOUT_MS = 5000;

/** At most this many connections, on WS_PATH and ATTACH_PATH together, wait in the handshake at once. */
export const MAX_PENDING_HANDSHAKES = 32;

/**
 * WebSocket close code 1013, Try Again Later: a connection over
 * MAX_PENDING_HANDSHAKES, which gets no challenge, or an attach to a session
 * that's still starting (attach.ts).
 */
export const WS_CLOSE_TRY_AGAIN = 1013;

/**
 * Counts connections that haven't finished the handshake, server-wide, so a
 * flood of connections that never answer can't hold a challenge and a timer
 * each without limit. Each is counted from its upgrade until it authenticates,
 * fails or closes.
 */
export class HandshakeSlots {
  private pending = 0;

  constructor(readonly max: number = MAX_PENDING_HANDSHAKES) {}

  /** Takes a slot, or undefined when all are taken. The returned function frees it, once. */
  take(): (() => void) | undefined {
    if (this.pending >= this.max) return undefined;
    this.pending += 1;
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      this.pending -= 1;
    };
  }

  get size(): number {
    return this.pending;
  }
}

export interface HandshakeOptions {
  token: string;
  /** The server's one allowed origin, serverOrigin(port). The proof must be bound to it. */
  origin: string;
  timeoutMs: number;
  /** The server's pending-handshake count. Without one, nothing is counted. */
  slots?: HandshakeSlots;
  /**
   * Called once, when the proof is valid. The handshake stops listening
   * first, so a 'message' listener added here gets every later frame.
   */
  onAuthenticated: () => void;
}

/**
 * Sends the challenge and waits for one valid proof. Closes the socket with
 * 4401 for anything else, or for nothing within `timeoutMs`.
 */
export function startHandshake(ws: WebSocket, options: HandshakeOptions): void {
  // Oversized frames and protocol errors land here, followed by 'close'.
  // Without a listener, ws would throw and take the process down.
  ws.on('error', () => {});

  const free = options.slots ? options.slots.take() : () => {};
  if (free === undefined) {
    // Too many connections are already waiting: no challenge for this one.
    ws.close(WS_CLOSE_TRY_AGAIN);
    return;
  }

  let state: 'pending' | 'authed' | 'rejected' = 'pending';
  // Fresh for every connection and never stored anywhere else, so a proof for
  // it can't be replayed on another connection.
  const nonce = randomSecret();

  const reject = () => {
    state = 'rejected';
    clearTimeout(timer);
    free();
    ws.close(WS_CLOSE_UNAUTHORIZED);
  };
  const timer = setTimeout(reject, options.timeoutMs);

  const onMessage = (data: RawData, isBinary: boolean) => {
    // One attempt per connection.
    if (state !== 'pending') return;
    const proof = isBinary ? undefined : parseAuth(data);
    if (proof === undefined || !proofMatches(proof, options.token, nonce, options.origin)) {
      reject();
      return;
    }
    state = 'authed';
    clearTimeout(timer);
    free();
    ws.off('message', onMessage);
    options.onAuthenticated();
  };
  ws.on('message', onMessage);

  ws.on('close', () => {
    clearTimeout(timer);
    free();
  });

  // The same message on both sockets: ServerMessage and AttachServerMessage share it.
  const challenge: ServerMessage & AttachServerMessage = { type: 'challenge', version: PROTOCOL_VERSION, nonce };
  ws.send(JSON.stringify(challenge));
}

/**
 * The proof from `{ "type": "auth", "proof": "..." }`, exactly that shape and
 * nothing more, or undefined. Extra fields are refused rather than ignored, so
 * a message that also carries M1's `token`, or a `version` the contract
 * doesn't define for the client, fails the handshake.
 */
function parseAuth(data: RawData): string | undefined {
  const message = parseJsonObject(data);
  if (message === undefined) return undefined;
  if (Object.keys(message).length !== 2 || message.type !== 'auth' || typeof message.proof !== 'string') return undefined;
  return message.proof;
}

/** A text frame's JSON, when it's an object (not an array or null), or undefined. */
export function parseJsonObject(data: RawData): Record<string, unknown> | undefined {
  let message: unknown;
  try {
    message = JSON.parse(rawToString(data));
  } catch {
    return undefined;
  }
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined;
  return message as Record<string, unknown>;
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
