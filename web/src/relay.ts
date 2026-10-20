// Messaging an interactive session through pitwall's relay (W11, D8): the API
// call, through the app's ApiClient (api.ts), which sends the apiKey, never
// the token, and the words the UI uses for each outcome. The server
// (src/server/relayRoute.ts, relay.ts) is the authority on every check.

import { relayPath, type RelayAlert, type RelayExchange, type RelayResult, type RelayStatus, type SessionSummary } from '../../src/shared/protocol.js';
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

const STATUSES: readonly RelayStatus[] = ['delivered', 'held', 'refused', 'failed', 'uncertain'];

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

/** What an outcome means, in a sentence. 'failed' means nothing was sent; 'uncertain' that pitwall can't tell. */
export const STATUS_TEXT: Record<RelayStatus, string> = {
  delivered: "Delivered. It's in the session's inbox: it reads it at its next step, or starts a turn if it's idle.",
  held: "Held for approval in that session's own terminal. It isn't delivered until it's approved there.",
  refused: "Refused: that session's settings don't accept messages from other sessions.",
  failed: 'Not sent.',
  uncertain: 'May have reached the session. Check its conversation before sending again.',
};

/** A short label for an exchange's status, for the line above the message box. */
export const STATUS_LABEL: Record<RelayStatus, string> = {
  delivered: 'delivered',
  held: 'held for approval in its terminal',
  refused: 'refused',
  failed: 'not sent',
  uncertain: 'may have reached it: check its conversation',
};

export type RelayTone = 'ok' | 'waiting' | 'failed';

/** How an outcome looks: delivered is good, held and uncertain need a look, refused and failed weren't delivered. */
export function statusTone(status: RelayStatus): RelayTone {
  return status === 'delivered' ? 'ok' : status === 'held' || status === 'uncertain' ? 'waiting' : 'failed';
}

/** The latest exchange, above the message box: when it was sent and what happened. */
export function exchangeSummary(exchange: RelayExchange): { status: string; tone: RelayTone } {
  return { status: STATUS_LABEL[exchange.status], tone: statusTone(exchange.status) };
}

/**
 * The banner for the snapshot's relayAlert: what pitwall's relay tried that
 * nobody asked for. `detail` is pitwall's own words, never a message's text.
 */
export function relayAlertText(alert: RelayAlert): { summary: string; count: string } {
  const summary = alert.blocked
    ? "pitwall's relay tried to send a message nobody asked for, and pitwall blocked it. That usually means another session messaged the relay."
    : "pitwall's relay sent a message nobody asked for, or one pitwall couldn't check, before pitwall could stop it. It may have reached one of your sessions: check their conversations for a message from pitwall-relay. That usually means another session messaged the relay, and pitwall has stopped using it until you restart pitwall.";
  return { summary, count: alert.count === 1 ? 'Once since pitwall started.' : `${alert.count} times since pitwall started.` };
}
