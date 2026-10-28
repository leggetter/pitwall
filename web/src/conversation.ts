// The session view's conversation: fetching a page through the app's
// ApiClient (api.ts), which sends the apiKey, never the token, and keeping the
// pages on screen merged without duplicating an entry.

import {
  CONVERSATION_STALE_STATUS,
  conversationPath,
  subagentConversationPath,
  type AskedQuestion,
  type ConversationEntry,
  type ConversationEntryKind,
  type ConversationPage,
} from '../../src/shared/protocol.js';
import type { ApiClient, ApiResult } from './api.js';

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
 * GETs `path` through the app's ApiClient, and asks once more after the wait the server asked for
 * when it answers 429 (BUSY_STATUS), before that counts as a failure. Never rejects.
 */
export async function getRetryingBusy(api: ApiClient, path: string, signal?: AbortSignal): Promise<ApiResult> {
  const options = signal ? { signal } : {};
  let result = await api.get(path, options);
  // Too many reads at once: once more, after the wait the server asked for, before it counts as a failure.
  if (result.kind === 'failed' && result.status === BUSY_STATUS) {
    const wait = Math.min(BUSY_WAIT_MAX_MS, result.retryAfter === undefined ? BUSY_WAIT_DEFAULT_MS : result.retryAfter * 1000);
    if (await pause(wait, signal)) result = await api.get(path, options);
  }
  return result;
}

/**
 * A failed read as the page shows it (5: Errors): the HTTP status, when the server answered with
 * something other than a success, and the reason its body gave, when it gave one.
 */
export function failedResult(result: Extract<ApiResult, { kind: 'failed' }>): { kind: 'failed'; status?: number; error?: string } {
  const failed: { kind: 'failed'; status?: number; error?: string } = { kind: 'failed' };
  // A 2xx whose body isn't JSON is a failure too, but its status says nothing about why.
  if (result.status !== undefined && (result.status < 200 || result.status >= 300)) failed.status = result.status;
  const error = reasonIn(result.body);
  if (error !== undefined) failed.error = error;
  return failed;
}

/**
 * One page of a session's conversation, through the app's ApiClient: the
 * newest, or the one before the `before` cursor. Waits while the page has no
 * apiKey yet, as the client does. Never rejects.
 */
export function getConversation(api: ApiClient, sessionId: string, before?: string, signal?: AbortSignal): Promise<ConversationResult> {
  return getPage(api, conversationPath(sessionId, before), sessionId, signal);
}

/**
 * One page of a sub-agent's transcript (W77), as getConversation() pages the session's: the newest, or
 * the one before `before`. Its page names the session, not the sub-agent.
 */
export function getSubagentConversation(api: ApiClient, sessionId: string, agentId: string, before?: string, signal?: AbortSignal): Promise<ConversationResult> {
  return getPage(api, subagentConversationPath(sessionId, agentId, before), sessionId, signal);
}

async function getPage(api: ApiClient, path: string, sessionId: string, signal: AbortSignal | undefined): Promise<ConversationResult> {
  const result = await getRetryingBusy(api, path, signal);
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'failed') {
    if (result.status === 404) return { kind: 'not-found' };
    if (result.status === STALE_CURSOR_STATUS) return { kind: 'stale' };
    return failedResult(result);
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

/** Claude Code's id for a sub-agent: letters and digits only (SubagentSummary.agentId), at most 64 of them. */
export function isAgentId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9]{1,64}$/.test(value);
}

const KINDS: ReadonlySet<ConversationEntryKind> = new Set(['user', 'assistant', 'tool', 'cross-session', 'to-pitwall', 'question', 'notice']);

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
  const { kind, at, text, markdown, toolName, toolError, from, subagent, questions, truncated } = value as Record<string, unknown>;
  if (typeof kind !== 'string' || !KINDS.has(kind as ConversationEntryKind) || typeof text !== 'string') return undefined;
  const entry: ConversationEntry = { kind: kind as ConversationEntryKind, text };
  if (typeof at === 'string') entry.at = at;
  if (markdown === true) entry.markdown = true;
  if (typeof toolName === 'string') entry.toolName = toolName;
  if (typeof toolError === 'boolean') entry.toolError = toolError;
  if (typeof from === 'string') entry.from = from;
  // The sub-agent a report, an Agent call or a SendMessage call is about (W76, W77), on the kinds that have one.
  if ((kind === 'cross-session' || kind === 'tool') && typeof subagent === 'object' && subagent !== null) {
    const { agentId, description } = subagent as Record<string, unknown>;
    if (isAgentId(agentId) && typeof description === 'string') entry.subagent = { agentId, description };
  }
  if (kind === 'question' && Array.isArray(questions)) entry.questions = questions.slice(0, QUESTIONS_SHOWN).flatMap((question) => asQuestion(question) ?? []);
  if (truncated === true) entry.truncated = true;
  return entry;
}

/** The most questions, and options to a question, the contract allows (AskedQuestion). */
const QUESTIONS_SHOWN = 8;

const isText = (value: unknown): value is string => typeof value === 'string';

/** One question of a 'question' entry (W49), or undefined when it isn't one. Options that aren't well formed are dropped. */
function asQuestion(value: unknown): AskedQuestion | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { question, header, options, multiSelect, answer, notes } = value as Record<string, unknown>;
  if (!isText(question) || !Array.isArray(options)) return undefined;
  const asked: AskedQuestion = {
    question,
    options: options.slice(0, QUESTIONS_SHOWN).flatMap((option: unknown) => {
      if (typeof option !== 'object' || option === null) return [];
      const { label, description } = option as Record<string, unknown>;
      if (!isText(label)) return [];
      return [isText(description) ? { label, description } : { label }];
    }),
  };
  if (isText(header)) asked.header = header;
  if (multiSelect === true) asked.multiSelect = true;
  if (isText(answer)) asked.answer = answer;
  if (isText(notes)) asked.notes = notes;
  return asked;
}

/**
 * The separators a multi-select answer might join its labels with. How Claude Code joins them isn't
 * known (W49), so an answer counts as several labels only when it's nothing but labels joined by one
 * of these.
 */
const ANSWER_JOINS = [',', '\n', ';'] as const;

/** What a question's answer chose: the options it named by their labels, or else the answer as it was typed. */
export interface ChosenAnswer {
  /** The indexes of the options chosen. */
  chosen: ReadonlySet<number>;
  /** The answer itself, when it named no option by its label: text typed in place of one. */
  typed?: string;
}

/**
 * Which options a question's answer chose, by label (W49), or undefined when it has no answer. The
 * answer is text: an option is chosen when the answer is its label exactly. A multi-select answer
 * that's two or more labels joined by a comma, a newline or a semicolon chooses each of them. Any
 * other answer chooses none, and is shown as typed. So does one that names a label two or more
 * options share, since the answer can't say which of them was chosen (W58).
 */
export function chosenAnswer(question: AskedQuestion): ChosenAnswer | undefined {
  const { answer, options } = question;
  if (answer === undefined) return undefined;
  /** The one option whose label is `text`, or -1 when none is, or more than one. */
  const index = (text: string) => {
    let found = -1;
    for (const [i, option] of options.entries()) {
      if (option.label.trim() !== text.trim()) continue;
      if (found !== -1) return -1;
      found = i;
    }
    return found;
  };
  const exact = index(answer);
  if (exact !== -1) return { chosen: new Set([exact]) };
  if (question.multiSelect === true) {
    for (const join of ANSWER_JOINS) {
      const parts = answer.split(join).filter((part) => part.trim() !== '');
      if (parts.length < 2) continue;
      const chosen = parts.map(index);
      if (chosen.every((i) => i !== -1)) return { chosen: new Set(chosen) };
    }
  }
  return { chosen: new Set(), typed: answer };
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
 *   (`to-pitwall`, W46) is a message, in its call's place, so it ends a run of tool calls; so is a
 *   question asked in a dialog (`question`, W49);
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
