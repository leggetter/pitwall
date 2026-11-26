// The trust terminal's socket (W214, spike 020): Claude Code's own trust prompt for a folder it
// hasn't trusted, in a PTY on the server, answered from the page. The handshake is attach's
// (attach.ts, proof.ts): the server sends a challenge, and the page answers with an HMAC of its
// nonce and the page's origin. The token itself is never sent.
//
//   server  challenge        page  auth { proof }
//   server  ready            page  open { cwd, cols, rows }
//   server  started          then the PTY's output as binary frames; the page sends input and resize
//   server  outcome          trusted, declined or unclear, then the server closes 1000
//   server  error            a refusal or failure, then a close
//
// The page sends only Up, Down, Enter and Esc (TRUST_INPUT), and the server drops anything else
// itself (trustKey() in src/server/trust.ts). Closing the socket ends `claude`.

import { PROTOCOL_VERSION, TRUST_PATH, WS_CLOSE_TOO_MANY, WS_CLOSE_UNAUTHORIZED, type TrustClientMessage, type TrustOutcome, type TrustServerMessage } from '../../src/shared/protocol.js';
import { clampSize, toBytes } from './attach.js';
import type { SocketFactory, SocketLike } from './connection.js';
import { computeProof, parseChallenge, type Prover } from './proof.js';

/**
 * The only input the page sends, as xterm.js sends the keys: Up and Down in both cursor modes, Enter's
 * carriage return and Escape. The same set as the server's TRUST_KEYS. Anything else, a paste or a
 * typed character included, goes nowhere.
 */
export const TRUST_INPUT: ReadonlySet<string> = new Set(['\u001b[A', '\u001bOA', '\u001b[B', '\u001bOB', '\r', '\u001b']);

/** Close codes the trust socket uses besides attach's: refused or rate-limited, and spawn failed. */
export const TRUST_CLOSE_TRY_AGAIN = 1013;
export const TRUST_CLOSE_SPAWN_FAILED = 1011;

/** Why a trust terminal ended. */
export type TrustEnd =
  /** Claude Code's answer, as the server read it. */
  | { kind: 'outcome'; outcome: TrustOutcome }
  /** The server refused or failed, with its own message. */
  | { kind: 'server'; reason: string }
  /** The page couldn't do its part, in pitwall's own words. */
  | { kind: 'error'; error: string }
  /** The server refused the proof (4401). */
  | { kind: 'unauthorized' }
  /** Another trust terminal is open (4429), with no message. */
  | { kind: 'busy' }
  /** Refused or rate-limited (1013), with no message. */
  | { kind: 'try-again' }
  /** `claude` couldn't be started (1011), with no message. */
  | { kind: 'spawn-failed' }
  /** The connection closed without saying why. */
  | { kind: 'closed' }
  /** The page closed it: Cancel, or the card went. */
  | { kind: 'cancelled' };

export type TrustStatus = { kind: 'connecting' } | { kind: 'running' } | { kind: 'ended'; end: TrustEnd };

export interface TrustOptions {
  url: string;
  /** Used only to compute the proof. Never sent. */
  token: string;
  /** The folder to trust. The server checks it as New session does. */
  cwd: string;
  /** The terminal's size now, sent with the open. */
  size: () => { cols: number; rows: number };
  createSocket: SocketFactory;
  /** Default computeProof, with WebCrypto. */
  prove?: Prover;
  onStatus: (status: TrustStatus) => void;
  /** PTY output, as UTF-8 bytes. */
  onOutput: (data: Uint8Array) => void;
}

export interface TrustSession {
  /** Sends a key once `claude` is running, only when it is one of TRUST_INPUT; anything else is dropped. */
  input(data: string): void;
  /** Sends the new size, clamped, once running and only when it changed. */
  resize(cols: number, rows: number): void;
  /** Closes the socket, which ends `claude`. Nothing is trusted unless Claude Code already had its answer. */
  cancel(): void;
}

export function trustSocketUrl(host: string): string {
  return `ws://${host}${TRUST_PATH}`;
}

/** Parses a text frame, ignoring anything malformed or of a type this page doesn't know. */
export function parseTrustMessage(data: unknown): TrustServerMessage | undefined {
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
    case 'started':
      return { type: candidate.type };
    case 'outcome':
      return candidate.outcome === 'trusted' || candidate.outcome === 'declined' || candidate.outcome === 'unclear'
        ? { type: 'outcome', outcome: candidate.outcome }
        : undefined;
    case 'error':
      return typeof candidate.error === 'string' ? { type: 'error', error: candidate.error } : undefined;
    default:
      return undefined;
  }
}

export function startTrust(options: TrustOptions): TrustSession {
  const { token, cwd, onStatus, onOutput } = options;
  const prove = options.prove ?? computeProof;
  let status: TrustStatus = { kind: 'connecting' };
  let lastSize: { cols: number; rows: number } | undefined;
  let answered = false;
  let opened = false;

  const setStatus = (next: TrustStatus) => {
    status = next;
    onStatus(next);
  };

  let socket: SocketLike | undefined;
  try {
    socket = options.createSocket(options.url);
  } catch {
    socket = undefined;
  }

  const sendMessage = (message: TrustClientMessage) => socket?.send(JSON.stringify(message));

  /** Ends it once: the first reason wins. */
  const end = (reason: TrustEnd) => {
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

  onStatus(status);

  if (!socket) {
    setStatus({ kind: 'ended', end: { kind: 'error', error: "the page couldn't open a connection to pitwall." } });
  } else {
    const current = socket;
    (current as SocketLike & { binaryType?: BinaryType }).binaryType = 'arraybuffer';

    current.onmessage = (event) => {
      if (socket !== current) return;
      const bytes = toBytes(event.data);
      if (bytes) {
        if (status.kind === 'running') onOutput(bytes);
        return;
      }
      const message = parseTrustMessage(event.data);
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
        case 'ready': {
          if (!answered || opened) return;
          opened = true;
          const now = options.size();
          const size = clampSize(now.cols, now.rows);
          lastSize = size;
          sendMessage({ type: 'open', cwd, ...size });
          return;
        }
        case 'started':
          if (opened && status.kind === 'connecting') setStatus({ kind: 'running' });
          return;
        case 'outcome':
          end({ kind: 'outcome', outcome: message.outcome });
          return;
        case 'error':
          end({ kind: 'server', reason: message.error });
          return;
      }
    };

    // A failed connection fires `error` and then `close`; the close handler decides.
    current.onerror = () => {};

    current.onclose = (event) => {
      if (socket !== current) return;
      if (event.code === WS_CLOSE_UNAUTHORIZED) end({ kind: 'unauthorized' });
      else if (event.code === WS_CLOSE_TOO_MANY) end({ kind: 'busy' });
      else if (event.code === TRUST_CLOSE_TRY_AGAIN) end({ kind: 'try-again' });
      else if (event.code === TRUST_CLOSE_SPAWN_FAILED) end({ kind: 'spawn-failed' });
      else end({ kind: 'closed' });
    };
  }

  return {
    input(data) {
      if (status.kind !== 'running' || !TRUST_INPUT.has(data)) return;
      sendMessage({ type: 'input', data });
    },
    resize(cols, rows) {
      if (status.kind !== 'running') return;
      const size = clampSize(cols, rows);
      if (lastSize && lastSize.cols === size.cols && lastSize.rows === size.rows) return;
      lastSize = size;
      sendMessage({ type: 'resize', ...size });
    },
    cancel() {
      end({ kind: 'cancelled' });
    },
  };
}

/** What the card says once a trust terminal has ended other than as trusted, or undefined for nothing. */
export interface TrustNotice {
  /** pitwall's words. */
  text: string;
  /** The server's reason, as it sent it, shown after the text in code style. */
  detail?: string;
}

export const TRUST_DECLINED =
  "Claude Code didn't trust this folder, so the session wasn't started. You can try again, or choose another folder.";
export const TRUST_DECLINED_RESUME =
  "Claude Code didn't trust this folder, so the session wasn't resumed. You can try again, or run the command above.";
/** The fallback, after any end that isn't Claude Code's yes or no. */
export const TRUST_FALLBACK = 'Run the command above instead.';

export function trustEndMessage(end: TrustEnd, resume = false): TrustNotice | undefined {
  switch (end.kind) {
    case 'outcome':
      if (end.outcome === 'declined') return { text: resume ? TRUST_DECLINED_RESUME : TRUST_DECLINED };
      if (end.outcome === 'unclear') return { text: `pitwall couldn't tell whether Claude Code trusted this folder. ${TRUST_FALLBACK}` };
      return undefined;
    case 'server':
      return { text: `Couldn't open Claude Code's trust prompt. ${TRUST_FALLBACK}`, detail: end.reason };
    case 'error':
      return { text: `Couldn't open Claude Code's trust prompt: ${end.error} ${TRUST_FALLBACK}` };
    case 'unauthorized':
      return {
        text: 'pitwall refused the sign-in proof. Reopen pitwall from the link it printed, or, if PITWALL_TOKEN is set, add #token= and that token to the address.',
      };
    case 'busy':
      return { text: "Another folder's trust prompt is open in pitwall. Close it first." };
    case 'try-again':
      return { text: `pitwall couldn't open the trust prompt just now. Try again in a moment, or run the command above.` };
    case 'spawn-failed':
      return { text: `pitwall couldn't start claude for the trust prompt. ${TRUST_FALLBACK}` };
    case 'closed':
      return { text: `The connection to pitwall closed before Claude Code answered. ${TRUST_FALLBACK}` };
    case 'cancelled':
      return undefined;
  }
}
