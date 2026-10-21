// One attach socket (W10, D3, D9): a background session's `claude attach`,
// driven from the page. The handshake is the index connection's (proof.ts):
// the server sends a challenge, and the page answers with an HMAC of its
// nonce and the page's origin. The token itself is never sent.
//
//   server  challenge        page  auth { proof }
//   server  ready            page  open { sessionId, cols, rows }
//   server  needs-restart    the session has finished or its process has exited: the user confirms, then
//                            open again with restart: true. A session that's still starting gets `error`
//                            instead, and is never restarted from here
//   server  attached         then the PTY's output as binary frames; the page sends input and resize
//   server  exit / error     then the server closes
//
// Closing the socket detaches. The session keeps running.

import { createContext } from 'react';
import {
  ATTACH_PATH,
  MAX_ATTACHED,
  PROTOCOL_VERSION,
  WS_CLOSE_TOO_MANY,
  WS_CLOSE_UNAUTHORIZED,
  type AttachClientMessage,
  type AttachServerMessage,
} from '../../src/shared/protocol.js';
import type { SocketFactory, SocketLike } from './connection.js';
import { computeProof, parseChallenge, type Prover } from './proof.js';

/** The terminal sizes the server accepts (src/server/attach.ts). The page clamps to them. */
export const COLS_RANGE = { min: 2, max: 500 } as const;
export const ROWS_RANGE = { min: 2, max: 200 } as const;

/**
 * Input is sent in pieces of at most this many UTF-16 code units. Even if
 * every one were escaped in JSON (6 bytes), a message stays well under the
 * server's 64 KiB frame cap, so a large paste arrives as several messages.
 */
export const INPUT_CHUNK = 8192;

/** Why an attach ended. */
export type AttachEnd =
  /** `claude attach` exited. */
  | { kind: 'exit'; code: number | null }
  /** The server refused or failed, with its own message, which the notice shows in code style. */
  | { kind: 'server'; reason: string }
  /** The page couldn't do its part, such as the handshake, in pitwall's own words. */
  | { kind: 'error'; error: string }
  /** MAX_ATTACHED sessions are already attached. */
  | { kind: 'too-many' }
  /** The server refused the proof. */
  | { kind: 'unauthorized' }
  /** The connection closed without saying why. */
  | { kind: 'closed' }
  /** The page detached, or the user declined the restart. */
  | { kind: 'detached' };

export type AttachStatus =
  | { kind: 'connecting' }
  /** The session has finished or its process has exited: attaching restarts it. Waits for confirmRestart() or detach(). */
  | { kind: 'confirm-restart' }
  | { kind: 'attached' }
  | { kind: 'ended'; end: AttachEnd };

/** The command a notice names, which the terminal shows in code style wherever it's in the text. */
export const ATTACH_COMMAND = 'claude attach';

/** What an ended attach's notice says: pitwall's sentence, then the server's own reason when it gave one. */
export interface EndNotice {
  /** pitwall's words. ATTACH_COMMAND, where it appears, is a command, for code style. */
  text: string;
  /** The server's reason, as it sent it: shown after the text, in code style, as text. */
  detail?: string;
}

/** The notice for an ended attach, or undefined when there's nothing to say. */
export function endMessage(end: AttachEnd): EndNotice | undefined {
  switch (end.kind) {
    case 'exit':
      return { text: end.code === null || end.code === 0 ? `${ATTACH_COMMAND} ended.` : `${ATTACH_COMMAND} ended with exit code ${end.code}.` };
    case 'server':
      return { text: "Couldn't attach:", detail: end.reason };
    case 'error':
      return { text: `Couldn't attach: ${end.error}` };
    case 'too-many':
      return { text: `${MAX_ATTACHED} sessions are already attached; detach one first.` };
    case 'unauthorized':
      return { text: 'pitwall refused the sign-in proof. Reopen pitwall from the URL the command printed.' };
    case 'closed':
      return { text: 'The connection to pitwall closed, so this terminal is detached.' };
    case 'detached':
      return undefined;
  }
}

export interface AttachOptions {
  url: string;
  /** Used only to compute the proof. Never sent. */
  token: string;
  sessionId: string;
  /** The terminal's size now, sent with each open. */
  size: () => { cols: number; rows: number };
  createSocket: SocketFactory;
  /** Default computeProof, with WebCrypto. */
  prove?: Prover;
  onStatus: (status: AttachStatus) => void;
  /** PTY output, as UTF-8 bytes. */
  onOutput: (data: Uint8Array) => void;
}

export interface AttachSession {
  /** Sends keystrokes or a paste, once attached. */
  input(data: string): void;
  /** Sends the new size, clamped, once attached and only when it changed. */
  resize(cols: number, rows: number): void;
  /** After 'confirm-restart': the user agreed, so open again with restart: true. */
  confirmRestart(): void;
  /** Closes the socket, which detaches. The session keeps running. */
  detach(): void;
}

export function attachSocketUrl(host: string): string {
  return `ws://${host}${ATTACH_PATH}`;
}

export function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  const clamp = (value: number, range: { min: number; max: number }) =>
    Math.min(range.max, Math.max(range.min, Number.isFinite(value) ? Math.floor(value) : range.min));
  return { cols: clamp(cols, COLS_RANGE), rows: clamp(rows, ROWS_RANGE) };
}

/** Splits input into INPUT_CHUNK pieces, never between the two halves of a surrogate pair. */
export function inputChunks(data: string, size = INPUT_CHUNK): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + size, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && end - start > 1 && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

/** Parses a text frame, ignoring anything malformed or of a type this page doesn't know. */
export function parseAttachMessage(data: unknown): AttachServerMessage | undefined {
  if (typeof data !== 'string') return undefined;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof message !== 'object' || message === null) return undefined;
  const candidate = message as Record<string, unknown>;
  switch (candidate.type) {
    case 'challenge':
      return parseChallenge(candidate);
    case 'ready':
    case 'needs-restart':
    case 'attached':
      return { type: candidate.type };
    case 'exit':
      if (candidate.code === null || (typeof candidate.code === 'number' && Number.isInteger(candidate.code))) {
        return { type: 'exit', code: candidate.code };
      }
      return undefined;
    case 'error':
      return typeof candidate.error === 'string' ? { type: 'error', error: candidate.error } : undefined;
    default:
      return undefined;
  }
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

export function startAttach(options: AttachOptions): AttachSession {
  const { token, sessionId, onStatus, onOutput } = options;
  const prove = options.prove ?? computeProof;
  let status: AttachStatus = { kind: 'connecting' };
  let lastSize: { cols: number; rows: number } | undefined;
  let answered = false;
  let opened = false;

  const setStatus = (next: AttachStatus) => {
    status = next;
    onStatus(next);
  };

  let socket: SocketLike | undefined;
  try {
    socket = options.createSocket(options.url);
  } catch {
    socket = undefined;
  }

  const sendMessage = (message: AttachClientMessage) => socket?.send(JSON.stringify(message));

  /** Ends the attach once: the first reason wins. */
  const end = (reason: AttachEnd) => {
    if (status.kind === 'ended') return;
    const current = socket;
    socket = undefined;
    if (current) {
      current.onopen = null;
      current.onmessage = null;
      current.onclose = null;
      current.onerror = null;
      current.close();
    }
    setStatus({ kind: 'ended', end: reason });
  };

  const open = (restart: boolean) => {
    const current = options.size();
    const size = clampSize(current.cols, current.rows);
    lastSize = size;
    const message: AttachClientMessage = { type: 'open', sessionId, ...size };
    if (restart) message.restart = true;
    sendMessage(message);
  };

  onStatus(status);

  if (!socket) {
    setStatus({ kind: 'ended', end: { kind: 'error', error: "the page couldn't open a connection to pitwall." } });
  } else {
    const current = socket;
    // ArrayBuffer rather than Blob, so output can go straight to the terminal.
    (current as SocketLike & { binaryType?: BinaryType }).binaryType = 'arraybuffer';

    current.onmessage = (event) => {
      if (socket !== current) return;
      const bytes = toBytes(event.data);
      if (bytes) {
        if (status.kind === 'attached') onOutput(bytes);
        return;
      }
      const message = parseAttachMessage(event.data);
      if (!message) return;
      switch (message.type) {
        case 'challenge':
          if (answered) return;
          answered = true;
          if (message.version !== PROTOCOL_VERSION) {
            end({
              kind: 'error',
              error: `the server speaks pitwall protocol version ${message.version}, and this page speaks version ${PROTOCOL_VERSION}. Reload the page.`,
            });
            return;
          }
          prove(token, message.nonce).then(
            (proof) => {
              if (socket === current) sendMessage({ type: 'auth', proof });
            },
            () => end({ kind: 'error', error: "this browser couldn't compute the sign-in proof (WebCrypto is unavailable)." }),
          );
          return;
        case 'ready':
          if (!answered || opened) return;
          opened = true;
          open(false);
          return;
        case 'needs-restart':
          if (opened && status.kind === 'connecting') setStatus({ kind: 'confirm-restart' });
          return;
        case 'attached':
          if (opened && status.kind === 'connecting') setStatus({ kind: 'attached' });
          return;
        case 'exit':
          end({ kind: 'exit', code: message.code });
          return;
        case 'error':
          // The server's own words, kept apart from the page's, so the notice can show them as its detail.
          end({ kind: 'server', reason: message.error });
          return;
      }
    };

    // A failed connection fires `error` and then `close`; the close handler decides.
    current.onerror = () => {};

    current.onclose = (event) => {
      if (socket !== current) return;
      if (event.code === WS_CLOSE_TOO_MANY) end({ kind: 'too-many' });
      else if (event.code === WS_CLOSE_UNAUTHORIZED) end({ kind: 'unauthorized' });
      else end({ kind: 'closed' });
    };
  }

  return {
    input(data) {
      if (status.kind !== 'attached') return;
      for (const chunk of inputChunks(data)) sendMessage({ type: 'input', data: chunk });
    },
    resize(cols, rows) {
      if (status.kind !== 'attached') return;
      const size = clampSize(cols, rows);
      if (lastSize && lastSize.cols === size.cols && lastSize.rows === size.rows) return;
      lastSize = size;
      sendMessage({ type: 'resize', ...size });
    },
    confirmRestart() {
      if (status.kind !== 'confirm-restart') return;
      setStatus({ kind: 'connecting' });
      open(true);
    },
    detach() {
      end({ kind: 'detached' });
    },
  };
}

/** What an attach needs from the app: the token for the proof, and how to open a socket. App provides it. */
export interface AttachEnv {
  /** Used only to compute proofs. Never sent. */
  token: string;
  createSocket: SocketFactory;
  /** The server that served this page, as window.location.host. */
  host: string;
}

/** Undefined where a component is rendered without App, as in some tests: the view then offers no Attach. */
export const AttachContext = createContext<AttachEnv | undefined>(undefined);
