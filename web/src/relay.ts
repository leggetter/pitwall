// Messaging an interactive session through pitwall's relay (W11, D8): the API
// call, through the app's ApiClient (api.ts), which sends the apiKey, never
// the token, and the words the UI uses for each outcome. The server
// (src/server/relayRoute.ts, relay.ts) is the authority on every check.

import {
  relayPath,
  type ConversationEntry,
  type RelayAlert,
  type RelayExchange,
  type RelayOff,
  type RelayResult,
  type RelayStatus,
  type SessionSummary,
} from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';

/** The server's limit, repeated so the box can say so before sending. */
export const MAX_RELAY_TEXT_LENGTH = 8192;

export type RelayOutcome =
  /** The server's answer: the relay's outcome, or why the request was refused. */
  | { kind: 'result'; result: RelayResult }
  /** The connection was refused (WebSocket 4401). The app is already showing that the token was rejected. */
  | { kind: 'unauthorized' }
  /**
   * No answer pitwall understands: a network error, or a response that isn't a RelayResult. `uncertain`
   * when the message may have gone: pitwall didn't answer, or answered with a server error or a
   * success it didn't explain. Otherwise pitwall refused the request before the relay ran.
   */
  | { kind: 'failed'; error: string; uncertain: boolean };

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

/** What pitwall can say, after its own sentence, when a send's outcome isn't known (5: Errors). */
export const CHECK_BEFORE_RESENDING = 'Check its conversation before sending again.';

/**
 * What a send with no RelayResult means (docs/design-system.md, 4: Message box, and 5: Errors). The
 * relay route answers every request it handles with one, so without one pitwall knows only this:
 * - no answer, a server error or an unexplained success: the message may have gone, so it says so,
 *   as the relay's own "uncertain" does, rather than inviting a resend, which starts another turn;
 * - any other status: pitwall refused the request before the relay ran, so nothing was sent.
 */
export function unexplainedSend(status: number | undefined): Extract<RelayOutcome, { kind: 'failed' }> {
  if (status === undefined) {
    return { kind: 'failed', uncertain: true, error: `pitwall didn't answer, so it may have reached the session. ${CHECK_BEFORE_RESENDING}` };
  }
  if (status >= 500 || (status >= 200 && status < 300)) {
    const what = status >= 500 ? `with an error (HTTP ${status})` : `without saying what happened (HTTP ${status})`;
    return { kind: 'failed', uncertain: true, error: `pitwall answered ${what}, so it may have reached the session. ${CHECK_BEFORE_RESENDING}` };
  }
  return { kind: 'failed', uncertain: false, error: `Not sent: pitwall refused the request (HTTP ${status}).` };
}

/** Sends `text` to a session with POST relayPath(), as outgoingText() makes it. Never rejects. */
export async function sendRelay(api: ApiClient, sessionId: string, text: string, signal?: AbortSignal): Promise<RelayOutcome> {
  const result = await api.post(relayPath(sessionId), { text: outgoingText(text) }, signal ? { signal } : {});
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  const relayed = asRelayResult(result.body);
  if (relayed !== undefined) return { kind: 'result', result: relayed };
  return unexplainedSend(result.status);
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

/** The result of a send, or 'error' for pitwall's own failure before the relay answered. */
export type SendResultStatus = RelayStatus | 'error';

const RESULT_TONES: Record<RelayTone, 'success' | 'warning' | 'danger'> = { ok: 'success', waiting: 'warning', failed: 'danger' };

/**
 * The inline alert for a send's result (docs/design-system.md, 4: Message box): delivered is success
 * and role="status"; held and "may have arrived" are warnings, refused and not sent are danger, all
 * role="alert", since they need a look.
 */
export function resultLook(status: SendResultStatus): { tone: 'success' | 'warning' | 'danger'; role: 'status' | 'alert' } {
  const tone = status === 'error' ? 'danger' : RESULT_TONES[statusTone(status)];
  return { tone, role: status === 'delivered' ? 'status' : 'alert' };
}

/** The character count shows from this share of the limit. */
export const COUNT_FROM = 0.8;

/**
 * The message box's character count: nothing below 80 % of the limit, then "6,554 / 8,192", then
 * "12 characters over the 8,192 limit" once over it.
 */
export function characterCount(length: number, limit = MAX_RELAY_TEXT_LENGTH): { text: string; over: boolean } | undefined {
  if (length < limit * COUNT_FROM) return undefined;
  const format = (n: number) => n.toLocaleString('en');
  if (length <= limit) return { text: `${format(length)} / ${format(limit)}`, over: false };
  const over = length - limit;
  return { text: `${format(over)} ${over === 1 ? 'character' : 'characters'} over the ${format(limit)} limit`, over: true };
}

/** Whitespace collapsed, for comparing text the conversation and the relay each cleaned in their own way. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Replies at least this long may sit inside a longer entry; shorter ones must be the whole entry, or "Done." would match everything. */
const CONTAINED_FROM = 40;

/** What the status line adds once the conversation shows the reply, after the exchange's status (W46). */
export const REPLY_IN_CONVERSATION = 'It replied, and the reply is in the conversation.';

/**
 * Whether a message to pitwall is the relay's copy of the reply, whitespace collapsed: the same text, or,
 * when the relay cut its copy (`cut`), text that starts with it. Either way the conversation shows at
 * least as much as the footer would, so an entry the server cut shorter than the reply, past its
 * page's budget, never counts: the footer keeps its copy (W48's G1).
 */
function isReply(entry: ConversationEntry, reply: string, cut: boolean): boolean {
  const text = squash(entry.text);
  return text === reply || (cut && text.startsWith(reply));
}

/**
 * Whether the conversation already shows the exchange's reply, so the message box shows only its
 * status line, which says so (docs/design-system.md, 4: Message box). Only the reply pitwall's relay
 * received counts, `exchange.reply`, and it does when:
 * - a message the session sent to pitwall's relay (`to-pitwall`, W46: its SendMessage, in full) at or
 *   after the send is the reply's text, whitespace collapsed, or starts with it when the relay cut its
 *   copy at 2 KiB, so it shows at least as much as the footer would. The text, not the address alone, is what says it's the reply the relay received,
 *   since any local session can take the relay's name (W48). A message to pitwall with no time isn't
 *   known to be since the send, so it doesn't count; or,
 * - as before W46, one of Claude's entries since the send has the reply's text: the whole entry, or
 *   for a reply of 40 characters or more, part of one.
 * Before the conversation loads there are no entries, so the reply shows in the footer until it does.
 */
export function replyInConversation(exchange: RelayExchange, entries: readonly ConversationEntry[]): boolean {
  if (!exchange.reply) return false;
  // The relay cuts a long reply with an ellipsis; the rest is a prefix of what was sent.
  const cut = exchange.reply.text.endsWith('…');
  const reply = squash(exchange.reply.text.replace(/…$/, ''));
  if (reply === '') return false;
  const sent = Date.parse(exchange.sentAt);
  const since = (at: string | undefined) => at !== undefined && Date.parse(at) >= sent;
  if (entries.some((entry) => entry.kind === 'to-pitwall' && since(entry.at) && isReply(entry, reply, cut))) return true;
  return entries.some((entry) => {
    if (entry.kind !== 'assistant') return false;
    if (entry.at !== undefined && Date.parse(entry.at) < sent) return false;
    const text = squash(entry.text);
    return text === reply || (reply.length >= CONTAINED_FROM && text.includes(reply));
  });
}

/**
 * The page alert for the snapshot's relayAlert (docs/design-system.md, 4: Alerts and banners): what
 * pitwall's relay tried that you didn't ask for. Its `cause` says which: 'unrequested', a message
 * nobody asked for, which usually means another session messaged the relay; 'changed', a copy of
 * your message that didn't match it (W43), such as one to another session or with other words; or
 * 'repeated', the relay trying your message again in the same turn, after pitwall's gate had stopped
 * its copy (W52). Only 'unrequested' mentions another session. Blocked is a warning, since nothing
 * was sent; otherwise it's danger, since pitwall saw it only afterwards. A blocked copy whose text
 * alone differs is tried once more (W52): the server raises no alert for a copying slip, in
 * whitespace, and the blocked 'changed' one for any other text, so the blocked 'changed' words fit
 * a copy that was tried again and one that wasn't; its `detail` says which. It says messaging is off
 * only when the snapshot's relayOff says so: some alerts only restart the relay. `detail` is
 * pitwall's own words, never a message's text.
 */
export function relayAlertText(alert: RelayAlert, off?: RelayOff): { title: string; summary: string; count: string } {
  const offNote = off ? ' Messaging is off until you restart pitwall.' : '';
  const count = alert.count === 1 ? 'Once since pitwall started.' : `${alert.count.toLocaleString('en')} times since pitwall started.`;
  if (alert.cause === 'repeated') {
    if (alert.blocked) {
      return {
        title: 'pitwall blocked a repeated send of your message',
        summary: `After pitwall's gate stopped its relay's copy of your message, the relay tried again in the same turn. The gate stopped that too, so the repeat wasn't sent.${offNote}`,
        count,
      };
    }
    return {
      title: "pitwall's relay may have repeated a send of your message",
      summary: `After pitwall's gate stopped its relay's copy of your message, the relay tried again in the same turn, and the gate may not have stopped it. Check your sessions' conversations for a message from pitwall-relay.${offNote}`,
      count,
    };
  }
  if (alert.cause === 'changed') {
    if (alert.blocked) {
      return {
        title: 'pitwall blocked a changed copy of your message',
        summary: `Its relay's copy didn't match what you sent, so pitwall stopped it, and that copy wasn't sent. When only its text differed, pitwall tried once more, and the message's own result says how that went.${offNote}`,
        count,
      };
    }
    return {
      title: "pitwall's relay may have sent a changed copy of your message",
      summary: `pitwall's gate may not have stopped it. Check the conversation of the session you messaged for a message from pitwall-relay.${offNote}`,
      count,
    };
  }
  if (alert.blocked) {
    return {
      title: "pitwall blocked a message you didn't ask for",
      summary: `Its relay tried to send it, and pitwall's gate stopped it, so nothing was sent. That usually means another session messaged the relay.${offNote}`,
      count,
    };
  }
  return {
    title: "pitwall's relay may have sent a message you didn't ask for",
    summary: `That usually means another session messaged the relay. Check your sessions' conversations for a message from pitwall-relay.${offNote}`,
    count,
  };
}
