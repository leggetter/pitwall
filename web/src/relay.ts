// Messaging an interactive session through pitwall's relay (W11, D8): the API
// call, through the app's ApiClient (api.ts), which sends the apiKey, never
// the token, and the words the UI uses for each outcome. The server
// (src/server/relayRoute.ts, relay.ts) is the authority on every check.

import { relayPath, type RelayExchange, type RelayResult, type RelayStatus, type SessionSummary } from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';

/** The server's limit, repeated so the box can say so before sending. */
export const MAX_RELAY_TEXT_LENGTH = 8192;

export type RelayOutcome =
  /** The server's answer: the relay's outcome, or why the request was refused. */
  | { kind: 'result'; result: RelayResult }
  /** The connection was refused (WebSocket 4401). The app is already showing that the token was rejected. */
  | { kind: 'unauthorized' }
  /** No answer pitwall understands: a network error, or a response that isn't a RelayResult. */
  | { kind: 'failed'; error: string };

const STATUSES: readonly RelayStatus[] = ['delivered', 'held', 'refused', 'failed'];

function asRelayResult(body: unknown): RelayResult | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const { status, detail } = body as Record<string, unknown>;
  if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) return undefined;
  if (detail !== undefined && typeof detail !== 'string') return undefined;
  return detail === undefined ? { status: status as RelayStatus } : { status: status as RelayStatus, detail };
}

/**
 * The text as it's sent: without blank lines before it or whitespace after
 * it. They're invisible in a message, and the relay can't be relied on to
 * copy them, which the server would then report as a changed text. Anything
 * else, leading spaces included, is sent exactly as typed.
 */
export function outgoingText(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}

/** Sends `text` to a session with POST relayPath(), as outgoingText() makes it. Never rejects. */
export async function sendRelay(api: ApiClient, sessionId: string, text: string, signal?: AbortSignal): Promise<RelayOutcome> {
  const result = await api.post(relayPath(sessionId), { text: outgoingText(text) }, signal ? { signal } : {});
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  const relayed = asRelayResult(result.body);
  if (relayed !== undefined) return { kind: 'result', result: relayed };
  return {
    kind: 'failed',
    error: result.kind === 'failed' && result.status !== undefined ? `pitwall answered ${result.status}, so it may not have been sent.` : "Couldn't reach pitwall, so it may not have been sent.",
  };
}

/** Whether a session can be messaged: interactive, with a live process. */
export function canMessage(session: Pick<SessionSummary, 'kind' | 'alive'>): boolean {
  return session.kind === 'interactive' && session.alive;
}

/** What an outcome means, in a sentence. */
export const STATUS_TEXT: Record<RelayStatus, string> = {
  delivered: "Delivered. It's in the session's inbox: it reads it at its next step, or starts a turn if it's idle.",
  held: "Held for approval in that session's own terminal. It isn't delivered until it's approved there.",
  refused: "Refused: that session's settings don't accept messages from other sessions.",
  failed: 'Not sent.',
};

/** A short label for an exchange's status, for a row. */
export const STATUS_LABEL: Record<RelayStatus, string> = {
  delivered: 'delivered',
  held: 'held for approval in its terminal',
  refused: 'refused',
  failed: 'not sent',
};

/** The latest exchange, for a row: when it was sent and what happened. */
export function exchangeSummary(exchange: RelayExchange): { status: string; tone: 'ok' | 'waiting' | 'failed' } {
  const tone = exchange.status === 'delivered' ? 'ok' : exchange.status === 'held' ? 'waiting' : 'failed';
  return { status: STATUS_LABEL[exchange.status], tone };
}

// The row's "Message" quick action opens the session view, and the view's
// message box takes the focus: straight away when the box is already on
// screen, otherwise once it appears, after the view has focused its own
// Close button. A request nobody takes within 2 seconds lapses.
const FOCUS_REQUEST_MS = 2000;
let focusRequest: { sessionId: string; at: number } | undefined;
const mountedBoxes = new Map<string, () => void>();

/** Asks the message box for this session to take the focus. */
export function requestRelayFocus(sessionId: string): void {
  const focus = mountedBoxes.get(sessionId);
  if (focus) {
    focusRequest = undefined;
    focus();
    return;
  }
  focusRequest = { sessionId, at: Date.now() };
}

/**
 * Called by a message box when it appears. Takes a pending request for its
 * session, and takes later ones until the returned function is called.
 */
export function registerRelayFocus(sessionId: string, focus: () => void): () => void {
  mountedBoxes.set(sessionId, focus);
  if (focusRequest?.sessionId === sessionId && Date.now() - focusRequest.at <= FOCUS_REQUEST_MS) {
    focusRequest = undefined;
    // After the effects that run when the session view opens, which focus its Close button.
    setTimeout(focus, 0);
  }
  return () => {
    if (mountedBoxes.get(sessionId) === focus) mountedBoxes.delete(sessionId);
  };
}
