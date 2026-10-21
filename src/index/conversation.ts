// The session view's conversation reader, part of the transcript adapter.
// Transcript JSONL is an internal Claude Code format, so this fails soft: a
// line it can't read is skipped, never an exception.
//
// A page is read backwards from the end of the file (or from a cursor), in
// chunks, until it has 50 entries or has read about 8 MiB. The cursor says
// where the older page ends, which file it belongs to, and which tool results
// the newer pages have seen whose calls are further back.

import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import type { ConversationEntry, ConversationPage } from '../shared/protocol.js';
import { isRecord } from './guards.js';
import { cap, truncate } from './text.js';
import { stripSystemReminders } from './transcripts.js';

const KIB = 1024;
const MIB = 1024 * KIB;

/** The most entries in a page, as the contract allows. */
export const PAGE_ENTRIES = 50;
/** How much is read from the file at a time. */
export const CHUNK_BYTES = 256 * KIB;
/** The most read from the file for one page. */
export const PAGE_READ_BUDGET = 8 * MIB;
/** The most text an entry carries, in UTF-16 code units, as the contract allows. */
export const ENTRY_TEXT_MAX = 32 * KIB;
/** How much of its entries' text a page carries in full, in UTF-16 code units, newest entries first. */
export const PAGE_TEXT_BUDGET = 256 * KIB;
/** How much of an entry's text is kept once the page's budget is spent. */
export const LEAN_TEXT_MAX = 512;
/** Notices are kept short. */
export const NOTICE_MAX = 500;
/** A tool call's one-line summary. */
export const TOOL_SUMMARY_MAX = 200;
/** The longest cursor accepted. Real ones are under 1 KiB; the most pending results makes about 6 KiB. */
export const CURSOR_MAX_LENGTH = 8 * KIB;
/** The most tool results a cursor carries to the older page. */
const MAX_PENDING = 64;
/** How many bytes before the cursor's offset its fingerprint covers. */
const FINGERPRINT_BYTES = 64;
const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

const CROSS_SESSION_PREFIX = 'Another Claude session sent a message:';
const CROSS_SESSION_TAGS = ['cross-session-message', 'agent-message'] as const;

export interface ConversationReadOptions {
  /** Default 50. */
  pageEntries?: number;
  /** Default 256 KiB. */
  chunkBytes?: number;
  /** Default 8 MiB. Most of a real transcript's bytes are internal request records, so 2 MiB filled only 7-43 entries a page. */
  readBudget?: number;
}

/** What one page cost, for tests and calibration. */
export interface ConversationReadStats {
  bytesRead: number;
}

/**
 * Thrown for a `before` cursor that can't be used.
 * - 'invalid': not a cursor this reader made. The server answers 400.
 * - 'stale': made for another version of the file: it was replaced, rotated,
 *   truncated or rewritten since. The server answers 410, and the UI reloads
 *   the newest page.
 */
export class ConversationCursorError extends Error {
  readonly reason: 'invalid' | 'stale';

  constructor(reason: 'invalid' | 'stale') {
    super(reason === 'stale' ? 'the cursor is for another version of the transcript' : 'not a conversation cursor');
    this.name = 'ConversationCursorError';
    this.reason = reason;
  }
}

/** Thrown when the file shrank while a page was being read. */
class TranscriptChangedError extends Error {}

/**
 * Reads one page of a transcript: the newest, or the one before `before`.
 * Undefined when the file has gone or isn't a regular file. Throws
 * ConversationCursorError for a cursor that can't be used, and passes other
 * I/O errors on for the caller to handle.
 */
export async function readConversationPage(
  file: string,
  sessionId: string,
  before?: string,
  options: ConversationReadOptions = {},
): Promise<{ page: ConversationPage; stats: ConversationReadStats } | undefined> {
  const cursor = before === undefined ? undefined : decodeCursor(before);
  if (before !== undefined && cursor === undefined) throw new ConversationCursorError('invalid');

  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch (err) {
    if (isGone(err)) return undefined;
    throw err;
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) return undefined;
    const size = Number(info.size);
    const identity = { dev: info.dev.toString(), ino: info.ino.toString() };
    let end = size;
    let midLine = false;
    let pending = new Map<string, boolean>();
    if (cursor !== undefined) {
      if (cursor.dev !== identity.dev || cursor.ino !== identity.ino || cursor.offset > size) {
        throw new ConversationCursorError('stale');
      }
      if ((await fingerprint(handle, cursor.offset)) !== cursor.fingerprint) throw new ConversationCursorError('stale');
      end = cursor.offset;
      midLine = cursor.midLine;
      pending = new Map(cursor.pending);
    }
    try {
      const result = await readBackwards(handle, end, midLine, pending, options);
      const page: ConversationPage = { sessionId, entries: result.builder.finish() };
      if (result.stop !== undefined) {
        page.before = encodeCursor({
          offset: result.stop.offset,
          midLine: result.stop.midLine,
          ...identity,
          fingerprint: await fingerprint(handle, result.stop.offset),
          pending: [...result.builder.pending].slice(-MAX_PENDING),
        });
      }
      return { page, stats: { bytesRead: result.bytesRead } };
    } catch (err) {
      if (err instanceof TranscriptChangedError && cursor !== undefined) throw new ConversationCursorError('stale');
      throw err;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

interface Stop {
  /** The older page covers the bytes before this offset. */
  offset: number;
  /** The offset is inside a line too long to read, so the older page drops bytes back to the newline before it. */
  midLine: boolean;
}

/**
 * Hands lines to a PageBuilder newest first, reading the file backwards in
 * chunks. `buf` always holds exactly the bytes [lo, hi): the start of the
 * file region not yet handed over, back to where the reading has got to.
 */
async function readBackwards(
  handle: FileHandle,
  end: number,
  startsMidLine: boolean,
  pending: Map<string, boolean>,
  options: ConversationReadOptions,
): Promise<{ builder: PageBuilder; stop?: Stop; bytesRead: number }> {
  const chunkBytes = Math.max(1, options.chunkBytes ?? CHUNK_BYTES);
  const budget = Math.max(chunkBytes, options.readBudget ?? PAGE_READ_BUDGET);
  const builder = new PageBuilder(pending, options.pageEntries ?? PAGE_ENTRIES);
  let lo = end;
  let hi = end;
  let buf: Buffer = EMPTY;
  let bytesRead = 0;
  let skipping = startsMidLine;

  for (;;) {
    // Hand over every complete line in the buffer, newest first.
    while (hi > lo) {
      if (skipping) {
        // hi is inside a line too long to read: drop bytes back to the newline before it.
        const k = lastNewline(buf, hi - lo - 1);
        if (k === -1) break;
        hi = lo + k + 1;
        skipping = false;
        continue;
      }
      // The newline that ends the previous line, before this line's own trailing one.
      const k = lastNewline(buf, hi - lo - 2);
      if (k === -1 && lo > 0) break;
      const start = k === -1 ? 0 : lo + k + 1;
      const contentEnd = hi > start && buf[hi - 1 - lo] === NEWLINE ? hi - 1 : hi;
      const verdict = builder.offer(buf.toString('utf8', start - lo, contentEnd - lo));
      if (verdict === 'full') return { builder, stop: { offset: hi, midLine: false }, bytesRead };
      hi = start;
    }
    if (skipping) {
      // Nothing in the buffer is wanted.
      buf = EMPTY;
      hi = lo;
    }
    if (lo === 0) return { builder, bytesRead };
    if (bytesRead >= budget) {
      if (skipping) return { builder, stop: { offset: lo, midLine: true }, bytesRead };
      // A line longer than a whole page's budget can never be read: skip it.
      if (hi === end) return { builder, stop: { offset: lo, midLine: true }, bytesRead };
      return { builder, stop: { offset: hi, midLine: false }, bytesRead };
    }
    const want = Math.min(chunkBytes, lo, budget - bytesRead);
    const chunk = await readRange(handle, lo - want, lo);
    if (chunk.length !== want) throw new TranscriptChangedError();
    bytesRead += want;
    buf = buf.length === 0 ? chunk : Buffer.concat([chunk, buf.subarray(0, hi - lo)]);
    lo -= want;
  }
}

/** The index of the last newline in buf[0..from], or -1. Never searches from a negative offset. */
function lastNewline(buf: Buffer, from: number): number {
  if (from < 0) return -1;
  return buf.lastIndexOf(NEWLINE, from);
}

async function readRange(handle: FileHandle, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(end - start);
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === buffer.length ? buffer : buffer.subarray(0, filled);
}

/** A hash of the bytes just before `offset`, so a file rewritten in place is noticed. */
async function fingerprint(handle: FileHandle, offset: number): Promise<string> {
  const start = Math.max(0, offset - FINGERPRINT_BYTES);
  const bytes = await readRange(handle, start, offset);
  return createHash('sha256').update(bytes).digest().subarray(0, 8).toString('base64url');
}

function isGone(err: unknown): boolean {
  const code = isRecord(err) ? err.code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// --- The cursor ----------------------------------------------------------------

interface Cursor {
  offset: number;
  midLine: boolean;
  dev: string;
  ino: string;
  fingerprint: string;
  /** Tool results seen on newer pages, by tool_use_id: whether each was an error. */
  pending: [string, boolean][];
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DECIMAL = /^\d{1,20}$/;
const FINGERPRINT = /^[A-Za-z0-9_-]{11}$/;
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function encodeCursor(cursor: Cursor): string {
  const body: Record<string, unknown> = { v: 1, o: cursor.offset, d: cursor.dev, i: cursor.ino, f: cursor.fingerprint };
  if (cursor.midLine) body.m = 1;
  const pending = cursor.pending.filter(([id]) => TOOL_USE_ID.test(id));
  if (pending.length > 0) body.p = pending.map(([id, isError]) => [id, isError ? 1 : 0]);
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

/** The cursor in `text`, or undefined when it isn't one this reader made. Bounded: the length is checked first. */
function decodeCursor(text: string): Cursor | undefined {
  if (typeof text !== 'string' || text.length === 0 || text.length > CURSOR_MAX_LENGTH || !BASE64URL.test(text)) {
    return undefined;
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(body) || body.v !== 1) return undefined;
  const { o, d, i, f, m, p } = body;
  if (typeof o !== 'number' || !Number.isSafeInteger(o) || o <= 0) return undefined;
  if (typeof d !== 'string' || !DECIMAL.test(d) || typeof i !== 'string' || !DECIMAL.test(i)) return undefined;
  if (typeof f !== 'string' || !FINGERPRINT.test(f)) return undefined;
  if (m !== undefined && m !== 1) return undefined;
  const pending: [string, boolean][] = [];
  if (p !== undefined) {
    if (!Array.isArray(p) || p.length > MAX_PENDING) return undefined;
    for (const item of p) {
      if (!Array.isArray(item) || item.length !== 2) return undefined;
      const [id, isError] = item as unknown[];
      if (typeof id !== 'string' || !TOOL_USE_ID.test(id) || (isError !== 0 && isError !== 1)) return undefined;
      pending.push([id, isError === 1]);
    }
  }
  return { offset: o, midLine: m === 1, dev: d, ino: i, fingerprint: f, pending };
}

/**
 * True when `text` has the shape of a cursor this reader makes, so the server
 * can refuse anything else with 400 before asking the index. Whether it still
 * matches the file is only known when the page is read.
 */
export function isWellFormedCursor(text: string): boolean {
  return decodeCursor(text) !== undefined;
}

// --- Building a page -------------------------------------------------------------

/** What one transcript line contributes, in file order. */
type Item =
  | { kind: 'text'; messageId: string | undefined; text: string; at: string | undefined }
  | { kind: 'tool'; id: string | undefined; name: string; summary: string; at: string | undefined }
  | { kind: 'result'; id: string; isError: boolean }
  | { kind: 'entry'; entry: ConversationEntry };

/** An entry being built. Assistant text keeps its blocks until the page is finished. */
type Draft =
  | { kind: 'assistant'; messageId: string | undefined; at: string | undefined; parts: string[] }
  | { kind: 'tool'; id: string | undefined; entry: ConversationEntry }
  | { kind: 'entry'; entry: ConversationEntry };

/**
 * Collects entries from lines handed over newest first.
 * - A text block joins the entry before it (in file order) when both are
 *   text from the same assistant message, with only thinking or skipped lines
 *   between. Joined blocks never span pages: a full page still takes lines
 *   that only join its oldest entry.
 * - A tool result is met before its call. It waits in `pending` until the
 *   call turns up, on this page or, through the cursor, an older one.
 */
class PageBuilder {
  /** Newest first. */
  private readonly drafts: Draft[] = [];

  constructor(
    readonly pending: Map<string, boolean>,
    private readonly maxEntries: number,
  ) {}

  /** Takes a line, or says the page is full and the line belongs to the older page. */
  offer(line: string): 'taken' | 'full' {
    const items = itemsOfLine(line);
    if (items.length === 0) return 'taken';
    const added = this.newEntries(items);
    if (this.drafts.length > 0 && this.drafts.length + added > this.maxEntries) return 'full';
    for (let i = items.length - 1; i >= 0; i--) this.apply(items[i] as Item);
    return 'taken';
  }

  /** How many new entries the line's items would add, given the oldest entry so far. */
  private newEntries(items: Item[]): number {
    let oldest: { assistant: boolean; messageId: string | undefined } | undefined = this.oldestText();
    let added = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i] as Item;
      if (item.kind === 'result') continue;
      if (item.kind === 'text' && joins(oldest, item.messageId)) continue;
      added++;
      oldest = { assistant: item.kind === 'text', messageId: item.kind === 'text' ? item.messageId : undefined };
    }
    return added;
  }

  private oldestText(): { assistant: boolean; messageId: string | undefined } | undefined {
    const oldest = this.drafts[this.drafts.length - 1];
    if (oldest === undefined) return undefined;
    return { assistant: oldest.kind === 'assistant', messageId: oldest.kind === 'assistant' ? oldest.messageId : undefined };
  }

  private apply(item: Item): void {
    switch (item.kind) {
      case 'result':
        this.pending.delete(item.id);
        this.pending.set(item.id, item.isError);
        // Results whose calls never turn up are dropped, the oldest seen first.
        while (this.pending.size > MAX_PENDING) {
          const first = this.pending.keys().next().value;
          if (first === undefined) break;
          this.pending.delete(first);
        }
        return;
      case 'text': {
        const oldest = this.drafts[this.drafts.length - 1];
        if (oldest?.kind === 'assistant' && joins(this.oldestText(), item.messageId)) {
          oldest.parts.push(item.text);
          // The entry sits where its first block is, so it keeps the first block's time.
          oldest.at = item.at ?? oldest.at;
          return;
        }
        if (this.full()) return;
        this.drafts.push({ kind: 'assistant', messageId: item.messageId, at: item.at, parts: [item.text] });
        return;
      }
      case 'tool': {
        if (this.full()) return;
        const entry: ConversationEntry = { kind: 'tool', text: item.summary, toolName: item.name };
        if (item.at !== undefined) entry.at = item.at;
        if (item.id !== undefined && this.pending.has(item.id)) {
          entry.toolError = this.pending.get(item.id) === true;
          this.pending.delete(item.id);
        }
        this.drafts.push({ kind: 'tool', id: item.id, entry });
        return;
      }
      case 'entry':
        if (this.full()) return;
        this.drafts.push({ kind: 'entry', entry: item.entry });
        return;
    }
  }

  /** Only a single line with more entries than a page can hold gets here: the rest of it is dropped. */
  private full(): boolean {
    return this.drafts.length >= this.maxEntries;
  }

  /**
   * The entries, oldest first, each with at most 32 KiB of text. The newest
   * keep theirs in full while the page's 256 KiB budget lasts; once an entry
   * doesn't fit what's left, it keeps only its first 512 characters.
   */
  finish(): ConversationEntry[] {
    const entries: ConversationEntry[] = [];
    const budget = { chars: PAGE_TEXT_BUDGET };
    for (const draft of this.drafts) entries.push(withinBudget(finishDraft(draft), budget));
    return entries.reverse();
  }
}

function joins(oldest: { assistant: boolean; messageId: string | undefined } | undefined, messageId: string | undefined): boolean {
  return oldest !== undefined && oldest.assistant && messageId !== undefined && oldest.messageId === messageId;
}

function finishDraft(draft: Draft): ConversationEntry {
  switch (draft.kind) {
    case 'tool':
    case 'entry':
      return draft.entry;
    case 'assistant':
      // Parts were collected newest first. Each block is markdown on its own, so they're joined as
      // separate paragraphs: a table or a list at the end of one doesn't run on into the next.
      return withAt({ kind: 'assistant', text: [...draft.parts].reverse().join('\n\n'), markdown: true }, draft.at);
  }
}

/**
 * The entry with at most 32 KiB of text, without splitting a surrogate pair, and in full while the
 * page's budget lasts: once it doesn't fit what's left, only its first 512 characters. Either cut
 * marks it truncated. The text is cut as it is, never trimmed, so a shorter copy of an entry is
 * always the start of the longer one.
 */
function withinBudget(entry: ConversationEntry, budget: { chars: number }): ConversationEntry {
  let text = cap(entry.text, ENTRY_TEXT_MAX);
  if (text.length <= budget.chars) budget.chars -= text.length;
  else text = cap(text, LEAN_TEXT_MAX);
  if (text.length === entry.text.length) return entry;
  return { ...entry, text, truncated: true };
}

// --- Reading lines ---------------------------------------------------------------

/** What a transcript line contributes. Lines that don't parse, sidechains and other entry types give nothing. */
export function itemsOfLine(line: string): Item[] {
  // Cheap pre-filter: every line this reads names one of these. Not "system":
  // Claude Code's internal api-request lines carry a system prompt, and they
  // can be most of a transcript's bytes.
  if (!line.includes('"user"') && !line.includes('"assistant"') && !line.includes('"local_command"')) return [];
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(entry) || entry.isSidechain === true) return [];
  const at = timestampOf(entry);
  switch (entry.type) {
    case 'assistant':
      return assistantItems(entry, at);
    case 'user':
      return userItems(entry, at);
    case 'system':
      return systemItems(entry, at);
    default:
      return [];
  }
}

function timestampOf(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.timestamp !== 'string') return undefined;
  const ms = Date.parse(entry.timestamp);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** Text blocks, tool calls and, for Claude Code's own API error messages, a notice. Thinking is left out. */
function assistantItems(entry: Record<string, unknown>, at: string | undefined): Item[] {
  const message = entry.message;
  if (!isRecord(message)) return [];
  const messageId = typeof message.id === 'string' ? message.id : undefined;
  const content = message.content;
  if (entry.isApiErrorMessage === true) {
    const text = textOf(content)?.trim();
    return text ? [notice(text, at)] : [];
  }
  if (typeof content === 'string') {
    const text = content.trim();
    return text === '' ? [] : [{ kind: 'text', messageId, text: cap(text, ENTRY_TEXT_MAX + 1), at }];
  }
  if (!Array.isArray(content)) return [];
  const items: Item[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text !== '') items.push({ kind: 'text', messageId, text: cap(text, ENTRY_TEXT_MAX + 1), at });
    } else if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'tool';
      const id = typeof block.id === 'string' ? block.id : undefined;
      items.push({ kind: 'tool', id, name, summary: toolSummary(name, block.input), at });
    }
  }
  return items;
}

function userItems(entry: Record<string, unknown>, at: string | undefined): Item[] {
  if (entry.isCompactSummary === true) {
    return [notice('Conversation compacted: Claude continued from a summary of the earlier conversation.', at)];
  }
  const message = entry.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  let images = 0;
  if (Array.isArray(content)) {
    const results: Item[] = [];
    let isResult = false;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        isResult = true;
        if (typeof block.tool_use_id === 'string') results.push({ kind: 'result', id: block.tool_use_id, isError: block.is_error === true });
      } else if (block.type === 'image') {
        images++;
      }
    }
    if (isResult) return results;
  }
  const raw = textOf(content);
  if (raw === undefined && images === 0) return [];
  const unreminded = stripSystemReminders(raw ?? '');
  const text = unreminded.trim();
  const origin = isRecord(entry.origin) ? entry.origin.kind : undefined;
  if (text.startsWith(CROSS_SESSION_PREFIX) || origin === 'peer') return text === '' ? [] : [crossSession(text, at)];
  if (entry.isMeta === true) return [];
  if (origin === 'task-notification' || text.startsWith('<task-notification>')) return [taskNotice(text, at)];
  const local = localCommandNotice(text, at);
  if (local !== undefined) return local;
  if (text.startsWith('Caveat:')) return [];
  if (text === '' && images === 0) return [];
  const imageNote = images === 0 ? '' : `[${images} ${images === 1 ? 'image' : 'images'}]`;
  const typed = asTyped(unreminded);
  const prompt = typed === '' ? imageNote : imageNote === '' ? typed : `${typed}\n\n${imageNote}`;
  return [{ kind: 'entry', entry: withAt({ kind: 'user', text: cap(prompt, ENTRY_TEXT_MAX + 1) }, at) }];
}

/**
 * A prompt as typed, with nothing stripped: only the blank lines before it and the whitespace after
 * it go, which the reminders taken out of it can leave. Spaces at the start of its first line stay.
 */
function asTyped(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}

/** Claude Code writes local slash-command output as `system` entries too. Other system entries are left out. */
function systemItems(entry: Record<string, unknown>, at: string | undefined): Item[] {
  if (entry.subtype !== 'local_command' || typeof entry.content !== 'string') return [];
  return localCommandNotice(entry.content.trim(), at) ?? [];
}

/**
 * A notice for a local slash command, its output, a `!` shell command and its
 * output, or an interruption marker. Undefined when `text` is none of these,
 * and an empty list when it is one with nothing to show.
 */
function localCommandNotice(text: string, at: string | undefined): Item[] | undefined {
  const shown = (value: string) => (value === '' ? [] : [notice(value, at)]);
  if (text.startsWith('<local-command-stdout>')) return shown(innerText(text, 'local-command-stdout'));
  if (text.startsWith('<local-command-stderr>')) return shown(innerText(text, 'local-command-stderr'));
  if (text.startsWith('<bash-input>')) {
    const command = innerText(text, 'bash-input');
    return command === '' ? [] : [notice(`! ${command}`, at)];
  }
  if (text.startsWith('<bash-stdout>') || text.startsWith('<bash-stderr>')) {
    const output = [innerText(text, 'bash-stdout'), innerText(text, 'bash-stderr')].filter((part) => part !== '');
    return shown(output.join('\n'));
  }
  if (text.startsWith('<command-name>')) {
    return shown(`${innerText(text, 'command-name')} ${innerText(text, 'command-args')}`.trim());
  }
  if (text.startsWith('[Request interrupted')) return shown(firstLine(text));
  return undefined;
}

/** A task notification's summary, or its status when it has none. */
function taskNotice(text: string, at: string | undefined): Item {
  const summary = innerText(text, 'summary');
  if (summary !== '') return notice(summary, at);
  const status = innerText(text, 'status');
  return notice(status === '' ? 'Task notification' : `Task ${status}`, at);
}

/**
 * A message from another Claude session: `Another Claude session sent a
 * message:`, then the message wrapped in `<cross-session-message from="..."
 * from-name="...">` or, from newer Claude Code versions, `<agent-message
 * from="...">`. The sender is the from-name, or the from when that isn't a
 * socket address.
 */
function crossSession(text: string, at: string | undefined): Item {
  const rest = text.startsWith(CROSS_SESSION_PREFIX) ? text.slice(CROSS_SESSION_PREFIX.length) : text;
  let tag: string | undefined;
  let open = -1;
  for (const candidate of CROSS_SESSION_TAGS) {
    const index = rest.indexOf(`<${candidate}`);
    if (index !== -1 && (open === -1 || index < open)) {
      open = index;
      tag = candidate;
    }
  }
  let body = rest;
  let from: string | undefined;
  if (tag !== undefined) {
    const openEnd = rest.indexOf('>', open);
    if (openEnd !== -1) {
      // Attributes are short; bounding the slice bounds the patterns below.
      const attributes = rest.slice(open + 1 + tag.length, Math.min(openEnd, open + 2048));
      const fromName = /(?:^|\s)from-name="([^"]*)"/.exec(attributes)?.[1];
      const fromAttr = /(?:^|\s)from="([^"]*)"/.exec(attributes)?.[1];
      from = fromName ?? (fromAttr !== undefined && !fromAttr.startsWith('uds:') ? fromAttr : undefined);
      const close = rest.lastIndexOf(`</${tag}>`);
      body = close > openEnd ? rest.slice(openEnd + 1, close) : rest.slice(openEnd + 1);
    }
  }
  const entry: ConversationEntry = withAt({ kind: 'cross-session', text: cap(body.trim(), ENTRY_TEXT_MAX + 1), markdown: true }, at);
  const sender = from === undefined ? '' : oneLine(decodeEntities(from), 120);
  if (sender !== '') entry.from = sender;
  return { kind: 'entry', entry };
}

function notice(text: string, at: string | undefined): Item {
  const entry: ConversationEntry = withAt({ kind: 'notice', text: truncate(text, NOTICE_MAX) }, at);
  if (text.length > NOTICE_MAX) entry.truncated = true;
  return { kind: 'entry', entry };
}

function withAt(entry: ConversationEntry, at: string | undefined): ConversationEntry {
  if (at !== undefined) entry.at = at;
  return entry;
}

/**
 * A tool call on one line: `Bash: <the command's first line>`, `Read`,
 * `Edit` or `Write: <file_path>`, `Grep` or `Glob: <pattern>`, `WebFetch:
 * <url>`, `WebSearch: <query>`, `Agent: <description>`, otherwise the tool's
 * name. At most 200 characters. The input is never shown beyond that.
 */
export function toolSummary(name: string, input: unknown): string {
  const field = (key: string) => (isRecord(input) && typeof input[key] === 'string' ? input[key] : undefined);
  let detail: string | undefined;
  switch (name) {
    case 'Bash': {
      const command = field('command');
      if (command !== undefined) {
        const trimmed = cap(command, 4 * TOOL_SUMMARY_MAX).trimStart();
        const first = firstLine(trimmed);
        detail = first.length < trimmed.trimEnd().length ? `${first} …` : first;
      }
      break;
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      detail = field('file_path');
      break;
    case 'NotebookEdit':
      detail = field('notebook_path');
      break;
    case 'Grep':
    case 'Glob':
      detail = field('pattern');
      break;
    case 'WebFetch':
      detail = field('url');
      break;
    case 'WebSearch':
      detail = field('query');
      break;
    case 'Agent':
    case 'Task':
      detail = field('description');
      break;
  }
  const label = oneLine(name, TOOL_SUMMARY_MAX);
  const shown = detail === undefined ? '' : oneLine(detail, TOOL_SUMMARY_MAX);
  return shown === '' ? label : truncate(`${label}: ${shown}`, TOOL_SUMMARY_MAX);
}

/** On one line, trimmed, at most `max` characters. Capped before collapsing, so a huge value isn't scanned in full. */
function oneLine(text: string, max: number): string {
  return truncate(cap(text, 4 * max).replace(/\s+/g, ' ').trim(), max);
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  return (newline === -1 ? text : text.slice(0, newline)).trim();
}

/** What's between `<tag>` and `</tag>`, trimmed, or to the end when it isn't closed. Empty when there's no `<tag>`. */
function innerText(text: string, tag: string): string {
  const open = `<${tag}>`;
  const start = text.indexOf(open);
  if (start === -1) return '';
  const from = start + open.length;
  const end = text.indexOf(`</${tag}>`, from);
  return (end === -1 ? text.slice(from) : text.slice(from, end)).trim();
}

/** A string content, or the text blocks of an array content joined with newlines. */
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };

function decodeEntities(text: string): string {
  return text.replace(/&(?:lt|gt|quot|apos|amp);/g, (entity) => ENTITIES[entity] ?? entity);
}
