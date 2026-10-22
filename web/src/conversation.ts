// The session view's conversation: fetching a page through the app's
// ApiClient (api.ts), which sends the apiKey, never the token, and keeping the
// pages on screen merged without duplicating an entry.

import {
  CONVERSATION_STALE_STATUS,
  conversationPath,
  type ConversationEntry,
  type ConversationEntryKind,
  type ConversationPage,
} from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';

/** The status the server answers for a cursor made for another version of the transcript. */
export const STALE_CURSOR_STATUS = CONVERSATION_STALE_STATUS;

/**
 * The server reads at most four pages at once, server-wide, and answers 429 with Retry-After (1 s
 * today) past that, as fast j or k through the list can reach. A page that gets one is asked for once
 * more after that wait, at most this long, before the view says it failed.
 */
export const BUSY_STATUS = 429;
export const BUSY_WAIT_DEFAULT_MS = 1_000;
export const BUSY_WAIT_MAX_MS = 5_000;

/** Waits `ms`, or until `signal` aborts: true if the time passed, false if it was aborted. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type ConversationResult =
  | { kind: 'ok'; page: ConversationPage }
  /** The cursor no longer matches the transcript, which was replaced or rewritten: reload the newest page. */
  | { kind: 'stale' }
  /** The session isn't listed any more, or has no transcript. */
  | { kind: 'not-found' }
  /** The connection was refused (WebSocket 4401). The app is already showing that the token was rejected. */
  | { kind: 'unauthorized' }
  /**
   * Anything else: a network error, another status, an aborted request, or a body that isn't a
   * ConversationPage. `status` is the HTTP status, when the server answered, and `error` the reason
   * it gave, when its body had one, for the page to show after its own sentence (5: Errors).
   */
  | { kind: 'failed'; status?: number; error?: string };

/**
 * One page of a session's conversation, through the app's ApiClient: the
 * newest, or the one before the `before` cursor. Waits while the page has no
 * apiKey yet, as the client does. Never rejects.
 */
export async function getConversation(
  api: ApiClient,
  sessionId: string,
  before?: string,
  signal?: AbortSignal,
): Promise<ConversationResult> {
  const path = conversationPath(sessionId, before);
  const options = signal ? { signal } : {};
  let result = await api.get(path, options);
  // Too many reads at once: once more, after the wait the server asked for, before it counts as a failure.
  if (result.kind === 'failed' && result.status === BUSY_STATUS) {
    const wait = Math.min(BUSY_WAIT_MAX_MS, result.retryAfter === undefined ? BUSY_WAIT_DEFAULT_MS : result.retryAfter * 1000);
    if (await pause(wait, signal)) result = await api.get(path, options);
  }
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'failed') {
    if (result.status === 404) return { kind: 'not-found' };
    if (result.status === STALE_CURSOR_STATUS) return { kind: 'stale' };
    const failed: Extract<ConversationResult, { kind: 'failed' }> = { kind: 'failed' };
    // A 2xx whose body isn't JSON is a failure too, but its status says nothing about why.
    if (result.status !== undefined && (result.status < 200 || result.status >= 300)) failed.status = result.status;
    const error = reasonIn(result.body);
    if (error !== undefined) failed.error = error;
    return failed;
  }
  const page = asConversationPage(result.body, sessionId);
  return page ? { kind: 'ok', page } : { kind: 'failed' };
}

/** The reason in an error body, `{ error: "…" }`, as other routes send; at most 500 characters. */
function reasonIn(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { error } = body as Record<string, unknown>;
  return typeof error === 'string' && error.trim() !== '' ? error.trim().slice(0, 500) : undefined;
}

const KINDS: ReadonlySet<ConversationEntryKind> = new Set(['user', 'assistant', 'tool', 'cross-session', 'to-pitwall', 'notice']);

/**
 * The body as a ConversationPage for `sessionId`, or undefined when it isn't
 * one. Entries that aren't well formed are dropped rather than failing the page.
 */
export function asConversationPage(body: unknown, sessionId: string): ConversationPage | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { sessionId: id, entries, before } = body as Record<string, unknown>;
  if (id !== sessionId || !Array.isArray(entries)) return undefined;
  if (before !== undefined && (typeof before !== 'string' || before === '')) return undefined;
  const page: ConversationPage = { sessionId, entries: entries.flatMap((entry) => asEntry(entry) ?? []) };
  if (before !== undefined) page.before = before;
  return page;
}

function asEntry(value: unknown): ConversationEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, at, text, markdown, toolName, toolError, from, truncated } = value as Record<string, unknown>;
  if (typeof kind !== 'string' || !KINDS.has(kind as ConversationEntryKind) || typeof text !== 'string') return undefined;
  const entry: ConversationEntry = { kind: kind as ConversationEntryKind, text };
  if (typeof at === 'string') entry.at = at;
  if (markdown === true) entry.markdown = true;
  if (typeof toolName === 'string') entry.toolName = toolName;
  if (typeof toolError === 'boolean') entry.toolError = toolError;
  if (typeof from === 'string') entry.from = from;
  if (truncated === true) entry.truncated = true;
  return entry;
}

/**
 * How much of an entry's text its key holds: less than the 512 characters the server keeps of an
 * entry once a page's text budget is spent, so one sent in full on one page and cut on the next is
 * the same entry (W36). The server cuts it as it is, so the shorter is the start of the longer.
 */
export const KEY_TEXT_MAX = 500;

/**
 * What identifies an entry across fetches. Entries have no id, so it's their
 * kind, time and sender, plus the start of their text where it can't change. An
 * assistant entry's text grows as more of its message is written, and a tool
 * entry gains its error flag when the result arrives, so neither of those counts.
 */
export function entryKey(entry: ConversationEntry): string {
  const text = entry.kind === 'assistant' && entry.at !== undefined ? '' : entry.text.slice(0, KEY_TEXT_MAX);
  return [entry.kind, entry.at ?? '', entry.toolName ?? '', entry.from ?? '', text].join('\u0000');
}

/**
 * The entries on screen with a newer copy of the newest page merged in, or
 * undefined when the two don't overlap, so the page should replace them.
 *
 * The newest page always runs to the end of the transcript, so from its first
 * entry onwards it's the truth: entries on screen from that one on are
 * replaced, which picks up a grown assistant message or a tool's result
 * without duplicating either, and anything after is new.
 */
export function mergeNewest(current: readonly ConversationEntry[], newest: readonly ConversationEntry[]): ConversationEntry[] | undefined {
  // An empty newest page, such as one that met only a line too long to read, says nothing new.
  if (newest.length === 0) return [...current];
  const anchor = entryKey(newest[0] as ConversationEntry);
  for (let i = current.length - 1; i >= 0; i--) {
    if (entryKey(current[i] as ConversationEntry) === anchor) return [...current.slice(0, i), ...newest];
  }
  return undefined;
}

/**
 * An older page put before the entries on screen. Pages don't overlap, but
 * any entry of the older page already on screen is dropped, to be safe.
 */
export function prependOlder(older: readonly ConversationEntry[], current: readonly ConversationEntry[]): ConversationEntry[] {
  const shown = new Set(current.slice(0, older.length).map(entryKey));
  return [...older.filter((entry) => !shown.has(entryKey(entry))), ...current];
}

/** Stable React keys for a list of entries: the entry's key, numbered when it repeats. */
export function entryKeys(entries: readonly ConversationEntry[]): string[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const key = entryKey(entry);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? key : `${key}\u0000${count}`;
  });
}

/**
 * How many of `next`'s entries weren't in `current`: those a newer copy of the newest page added.
 * An assistant message that grew, or a tool call that got its result, is the same entry, so neither
 * counts.
 */
export function countAdded(current: readonly ConversationEntry[], next: readonly ConversationEntry[]): number {
  const shown = new Set(entryKeys(current));
  return entryKeys(next).filter((key) => !shown.has(key)).length;
}

/** An entry with its stable key (entryKeys). */
export interface KeyedEntry {
  key: string;
  entry: ConversationEntry;
}

/**
 * What the conversation shows, one item per line of its list (docs/design-system.md, 4: Conversation):
 * - `entry`: a message, a notice, or a tool call on its own, which isn't folded. A message to pitwall
 *   (`to-pitwall`, W46) is a message, in its call's place, so it ends a run of tool calls;
 * - `fold`: two or more tool calls in a row, folded into one toggle.
 */
export type ConversationRow = ({ kind: 'entry' } & KeyedEntry) | { kind: 'fold'; key: string; calls: KeyedEntry[] };

/** The entries as rows: each run of two or more consecutive tool calls folds into one, keyed by its first call. */
export function conversationRows(entries: readonly ConversationEntry[]): ConversationRow[] {
  const keys = entryKeys(entries);
  const rows: ConversationRow[] = [];
  let run: KeyedEntry[] = [];
  const flush = () => {
    const [first] = run;
    if (first && run.length === 1) rows.push({ kind: 'entry', ...first });
    else if (first) rows.push({ kind: 'fold', key: `fold\u0000${first.key}`, calls: run });
    run = [];
  };
  entries.forEach((entry, index) => {
    const keyed = { key: keys[index] ?? String(index), entry };
    if (entry.kind === 'tool') {
      run.push(keyed);
      return;
    }
    flush();
    rows.push({ kind: 'entry', ...keyed });
  });
  flush();
  return rows;
}

/**
 * Whether a fold is open, from the keys of the calls in the folds that were opened. A fold stays
 * open as long as one of its calls is one that was in an open fold: when a newer call joins it at the
 * end, after a refresh, and when "Load earlier" adds older calls at its start.
 */
export function foldOpen(open: ReadonlySet<string>, calls: readonly KeyedEntry[]): boolean {
  return calls.some(({ key }) => open.has(key));
}

/** The open folds' calls after `calls`' fold is toggled: opened by its first call, or closed by all of them. */
export function toggleFold(open: ReadonlySet<string>, calls: readonly KeyedEntry[]): Set<string> {
  const next = new Set(open);
  const wasOpen = foldOpen(open, calls);
  for (const { key } of calls) next.delete(key);
  const [first] = calls;
  if (!wasOpen && first) next.add(first.key);
  return next;
}
