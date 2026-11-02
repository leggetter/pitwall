// The session view's conversation reader, part of the transcript adapter.
// Transcript JSONL is an internal Claude Code format, so this fails soft: a
// line it can't read is skipped, never an exception.
//
// A page is read backwards from the end of the file (or from a cursor), in
// chunks, until it has 50 entries or has read about 8 MiB. The cursor says
// where the older page ends, which file it belongs to, and which tool results
// the newer pages have seen whose calls are further back.
//
// A SendMessage call to pitwall's relay is a 'to-pitwall' entry, its message in
// full, in place of the call (W46). A call is to the relay when its `to` is the
// relay's name, or a `uds:` address that a cross-session message from the
// relay's name came from earlier in the transcript. That's what the transcript
// shows, and all it shows: any local session can take the relay's name, so the
// entry says who the call addressed, not that pitwall's own relay received it. The page itself answers
// that when the message is on it, as a reply a second later usually is. When
// it isn't, the relay's address book (RelayAddressBook, below) reads the
// transcript forward up to the page, once per transcript, and remembers where
// the relay's messages came from.
//
// A question Claude Code asked in its dialog, an AskUserQuestion call, is a
// 'question' entry in place of the call, with its questions, options and
// answers (W49). The answers are in the result's line, as its `toolUseResult`,
// matched to the questions by their text. Claude Code writes the call and its
// result together, once the dialog is answered, so they're almost always on one
// page. When a page boundary falls between them, the result is on the newer
// page: its cursor carries the result line's place in the file, and the older
// page reads that one line again once it meets the call.
//
// What arrives while the session is mid-turn, a prompt typed meanwhile, a message
// from another session or a sub-agent, or a task notification, Claude Code
// records only as a `queued_command` attachment (W99). Each is read as the user
// entry it stands for (queuedEntryOf(), in transcripts.ts), so it becomes what
// that entry would, and a message from the relay that came mid-turn says where
// the relay's messages come from as one that came between turns does. A message
// from a session names its `msg_id` in either form, so a page that met both would
// show it once; Claude Code wasn't seen writing both for any of these.
//
// For the web UI's working line (W102): each of those, a compaction summary and
// Claude Code's own API error notice is marked `midTurn`, since none of them began
// a turn, and the newest page says whether its newest turn has ended, by Claude
// Code's `turn_duration` mark (spike 007, finding 4), which a page otherwise skips,
// with W69's rule for what runs a turn (turnSignalOf(), in transcripts.ts).

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import type { AskedQuestion, ConversationEntry, ConversationPage } from '../shared/protocol.js';
import { isRecord } from './guards.js';
import type { SubagentLabels } from './subagents.js';
import { cap, truncate } from './text.js';
import { queuedEntryOf, stripSystemReminders, turnSignalOf, type TurnSignal } from './transcripts.js';

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

/** The tool one session messages another with. */
const SEND_MESSAGE = 'SendMessage';
/** How a socket address starts, in a SendMessage call's `to` and a cross-session message's `from`. */
const SOCKET_PREFIX = 'uds:';
/** The longest `to` or sender address read. Real ones are under 100 characters; SendMessage takes names up to 300. */
const ADDRESS_MAX = 512;
/**
 * The most addresses the relay's messages came from that are remembered for one transcript: the newest
 * ones. A relay has one, and a new one each time pitwall or its relay restarts, W43's retry included.
 */
export const RELAY_ADDRESSES_MAX = 64;
/** A tool result longer than this is never read as JSON. SendMessage's are under 1 KiB. */
const RESULT_JSON_MAX = 4 * KIB;
/** The longest line the relay's address book reads. A relay message is at most 8 Ki characters. */
const ADDRESS_LINE_MAX = PAGE_READ_BUDGET;
/** How much the relay's address book reads at a time. */
const ADDRESS_CHUNK_BYTES = MIB;

/** The tool Claude Code asks its question dialog with (W49). */
const ASK_USER_QUESTION = 'AskUserQuestion';
/** The contract's caps on a 'question' entry (AskedQuestion), in UTF-16 code units. */
export const QUESTIONS_MAX = 8;
export const OPTIONS_MAX = 8;
export const QUESTION_MAX = 2 * KIB;
export const HEADER_MAX = 256;
export const LABEL_MAX = 256;
export const DESCRIPTION_MAX = KIB;
export const ANSWER_MAX = 2 * KIB;
export const NOTES_MAX = 2 * KIB;
/**
 * The most dialog results a cursor carries the place of, for the older page to read their answers
 * from: the last seen, nearest the boundary. A dialog's result is almost always on its call's page,
 * so a cursor usually carries none, and the others still carry whether they were errors.
 */
const MAX_PENDING_LINES = 8;
/** The longest result line a cursor carries the place of. Real ones are a few KiB, with every option's preview in them. */
export const ANSWER_LINE_MAX = MIB;

export interface ConversationReadOptions {
  /** Default 50. */
  pageEntries?: number;
  /** Default 256 KiB. */
  chunkBytes?: number;
  /** Default 8 MiB. Most of a real transcript's bytes are internal request records, so 2 MiB filled only 7-43 entries a page. */
  readBudget?: number;
  /**
   * pitwall's relay (D8), by its name, with what's known of where its messages came from: a
   * SendMessage call to it becomes a 'to-pitwall' entry (W46). Without it, every call stays a 'tool'
   * entry.
   */
  relay?: RelayAddressBook;
  /**
   * Reads sidechain entries, which are otherwise left out as a sub-agent's: for a sub-agent's own
   * transcript, every entry of which is one (W76).
   */
  sidechain?: boolean;
  /** Opens the file without following a symlink at it, and without waiting on a FIFO's writer: for a sub-agent's transcript (W76). */
  noFollow?: boolean;
  /**
   * The session's sub-agents (W76): an Agent call that started one, a SendMessage call to one and a
   * message from one get its id and description as ConversationEntry.subagent.
   */
  subagents?: SubagentLabels;
}

const NO_FOLLOW_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** What one page cost, for tests and calibration. */
export interface ConversationReadStats {
  bytesRead: number;
  /**
   * What the relay's address book read forward for this page: nothing unless a call to a socket
   * address had no message from the relay before it on its own page, and then only what no earlier
   * page had read.
   */
  addressBytesRead: number;
  /**
   * What was read again for question dialogs' answers (W49): nothing unless a dialog's call is on
   * this page and its result was on a newer one, and then only that result's line.
   */
  answerBytesRead: number;
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
    handle = await open(file, options.noFollow === true ? NO_FOLLOW_FLAGS : 'r');
  } catch (err) {
    if (isGone(err) || (options.noFollow === true && isRecord(err) && err.code === 'ELOOP')) return undefined;
    throw err;
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) return undefined;
    const size = Number(info.size);
    const identity = { dev: info.dev.toString(), ino: info.ino.toString() };
    let end = size;
    let midLine = false;
    let pending = new Map<string, Pending>();
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
      // A call to a socket address whose request isn't on this page: what came before the page says.
      let earlier: ((address: string, offset: number) => boolean) | undefined;
      let addressBytesRead = 0;
      const relay = options.relay;
      if (relay !== undefined && result.stop !== undefined && result.builder.unresolved()) {
        const known = await relay.addressesBefore(sessionId, file, handle, identity, result.stop.offset);
        if (known !== undefined) {
          addressBytesRead = known.bytesRead;
          earlier = (address, offset) => (known.addresses.get(address) ?? Number.POSITIVE_INFINITY) < offset;
        }
      }
      // A question dialog's call on this page whose result was on a newer one: that result's line again.
      const answerBytesRead = await result.builder.readAnswers(handle, size);
      const page: ConversationPage = { sessionId, entries: result.builder.finish(earlier) };
      // Only the newest page runs to the end of the transcript, so only it can say whether the turn has ended (W102).
      if (cursor === undefined && result.builder.turnEnded !== undefined) page.turnEnded = result.builder.turnEnded;
      if (result.stop !== undefined) {
        page.before = encodeCursor({
          offset: result.stop.offset,
          midLine: result.stop.midLine,
          ...identity,
          fingerprint: await fingerprint(handle, result.stop.offset),
          pending: [...result.builder.pending].slice(-MAX_PENDING),
        });
      }
      return { page, stats: { bytesRead: result.bytesRead, addressBytesRead, answerBytesRead } };
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
  pending: Map<string, Pending>,
  options: ConversationReadOptions,
): Promise<{ builder: PageBuilder; stop?: Stop; bytesRead: number }> {
  const chunkBytes = Math.max(1, options.chunkBytes ?? CHUNK_BYTES);
  const budget = Math.max(chunkBytes, options.readBudget ?? PAGE_READ_BUDGET);
  const builder = new PageBuilder(pending, options.pageEntries ?? PAGE_ENTRIES, options.relay?.name, options.sidechain === true, options.subagents);
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
      const verdict = builder.offer(buf.toString('utf8', start - lo, contentEnd - lo), start, contentEnd);
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
  /**
   * Tool results seen on newer pages, by tool_use_id: whether each was an error, or reported a
   * failure, and for a question dialog's result, where its line is (W49).
   */
  pending: [string, Pending][];
}

/**
 * A pending result as the cursor writes it: `[id, code]`, or `[id, code, offset, length]` for a
 * question dialog's result, with its line's place (W49). Code 2 is newer than the cursor's first
 * version, which only had 0 and 1, and the place is newer still.
 */
const RESULT_CODES: Record<ResultState, number> = { ok: 0, error: 1, failed: 2 };
const RESULT_STATES: readonly ResultState[] = ['ok', 'error', 'failed'];

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DECIMAL = /^\d{1,20}$/;
const FINGERPRINT = /^[A-Za-z0-9_-]{11}$/;
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function encodeCursor(cursor: Cursor): string {
  const body: Record<string, unknown> = { v: 1, o: cursor.offset, d: cursor.dev, i: cursor.ino, f: cursor.fingerprint };
  if (cursor.midLine) body.m = 1;
  const pending = cursor.pending.filter(([id]) => TOOL_USE_ID.test(id));
  // Only the dialog results nearest the boundary, the last seen, keep their line's place, so the cursor stays small.
  let lines = 0;
  const items: unknown[][] = [];
  for (let i = pending.length - 1; i >= 0; i--) {
    const [id, result] = pending[i] as [string, Pending];
    const line = result.line !== undefined && lines < MAX_PENDING_LINES ? result.line : undefined;
    if (line !== undefined) lines++;
    items.push(line === undefined ? [id, RESULT_CODES[result.state]] : [id, RESULT_CODES[result.state], line.offset, line.length]);
  }
  if (items.length > 0) body.p = items.reverse();
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
  const pending: [string, Pending][] = [];
  if (p !== undefined) {
    if (!Array.isArray(p) || p.length > MAX_PENDING) return undefined;
    let lines = 0;
    for (const item of p) {
      if (!Array.isArray(item) || (item.length !== 2 && item.length !== 4)) return undefined;
      const [id, code, start, length] = item as unknown[];
      const state = typeof code === 'number' && Number.isInteger(code) ? RESULT_STATES[code] : undefined;
      if (typeof id !== 'string' || !TOOL_USE_ID.test(id) || state === undefined) return undefined;
      if (item.length === 2) {
        pending.push([id, { state }]);
        continue;
      }
      // A dialog result's line is on a newer page, so it starts at or after the cursor's offset.
      if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < o) return undefined;
      if (typeof length !== 'number' || !Number.isInteger(length) || length < 1 || length > ANSWER_LINE_MAX) return undefined;
      if (++lines > MAX_PENDING_LINES) return undefined;
      pending.push([id, { state, line: { offset: start, length } }]);
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

// --- The relay's address book ----------------------------------------------------

/** How far the address book has read one session's transcript, and what it found. */
interface AddressScan {
  file: string;
  dev: string;
  ino: string;
  /** Every line that starts before this offset has been read. */
  offset: number;
  /** The offset is inside a line too long to read, whose rest is skipped. */
  midLine: boolean;
  /** Of the bytes before `offset`, as a cursor's is, so a file rewritten in place is read again. */
  fingerprint: string;
  /**
   * Of the file's first bytes, up to 4 KiB, which name the session and its first time: a file that was
   * replaced by another as long, even on the same inode, as a file system can reuse one at once.
   */
  head: string;
  /** The addresses the relay's messages came from, each with the offset of the first line that had it. */
  addresses: Map<string, number>;
}

/** How much of a transcript's start the address book's `head` covers. */
const HEAD_BYTES = 4 * KIB;

/** A hash of the bytes in [start, end), as a fingerprint's is. */
async function digest(handle: FileHandle, start: number, end: number): Promise<string> {
  const bytes = await readRange(handle, start, end);
  return createHash('sha256').update(bytes).digest().subarray(0, 8).toString('base64url');
}

/** What the address book knows of the transcript before an offset, and what it read to know it. */
export interface KnownAddresses {
  addresses: ReadonlyMap<string, number>;
  bytesRead: number;
}

/**
 * Where pitwall's relay's messages came from, transcript by transcript (W46): the `uds:` addresses
 * that cross-session messages from the relay's name came from, each with where the first such line
 * starts. A SendMessage call to one of them, after that line, is to pitwall. One per indexer, which
 * passes the relay's name in (RELAY_NAME, D8).
 *
 * A page asks only when a call on it is to a socket address and no message from the relay on the
 * page came from that address before it: a reply whose request is on an older page, or a message to
 * another session's socket. The book then reads the transcript forward, from where it last stopped
 * up to the page's start, so it reads each byte of a transcript at most once while pitwall runs,
 * however many pages ask. It parses only lines that name the relay. A transcript that was replaced,
 * shrank, or was rewritten at its start or just before where the book stopped is read again from the
 * start: by its inode, its size, and hashes of its first 4 KiB and of the 64 bytes before that place.
 *
 * In memory only, for the sessions in the latest snapshot: an offset, two hashes and at most 64
 * addresses each. It fails soft: a transcript it can't read leaves those calls as tool calls.
 */
export class RelayAddressBook {
  private readonly scans = new Map<string, AddressScan>();
  /** One read at a time per session, so two pages never read the same bytes. */
  private readonly busy = new Map<string, Promise<KnownAddresses | undefined>>();
  /** The relay's name as it's written inside a transcript line's JSON. */
  private readonly marker: Buffer;

  constructor(
    readonly name: string,
    private readonly options: { chunkBytes?: number } = {},
  ) {
    this.marker = Buffer.from(JSON.stringify(name).slice(1, -1), 'utf8');
  }

  /** Forgets every session but these. */
  retain(sessionIds: ReadonlySet<string>): void {
    for (const id of this.scans.keys()) if (!sessionIds.has(id)) this.scans.delete(id);
  }

  /**
   * For readConversationPage: the addresses in the lines of `file` that start before `offset`, after
   * reading whatever of them this book hasn't. Undefined when the file couldn't be read.
   */
  addressesBefore(sessionId: string, file: string, handle: FileHandle, identity: { dev: string; ino: string }, offset: number): Promise<KnownAddresses | undefined> {
    const previous = this.busy.get(sessionId) ?? Promise.resolve(undefined);
    const run = previous
      .then(() => this.readTo(sessionId, file, handle, identity, offset))
      .catch(() => {
        this.scans.delete(sessionId);
        return undefined;
      });
    this.busy.set(sessionId, run);
    void run.then(() => {
      if (this.busy.get(sessionId) === run) this.busy.delete(sessionId);
    });
    return run;
  }

  private async readTo(sessionId: string, file: string, handle: FileHandle, identity: { dev: string; ino: string }, offset: number): Promise<KnownAddresses> {
    const size = Number((await handle.stat({ bigint: true })).size);
    let scan = this.scans.get(sessionId);
    if (
      scan !== undefined &&
      !(
        scan.file === file &&
        scan.dev === identity.dev &&
        scan.ino === identity.ino &&
        scan.offset <= size &&
        (await fingerprint(handle, scan.offset)) === scan.fingerprint &&
        (await digest(handle, 0, Math.min(HEAD_BYTES, scan.offset))) === scan.head
      )
    ) {
      scan = undefined;
    }
    if (scan === undefined) {
      const none = await digest(handle, 0, 0);
      scan = { file, ...identity, offset: 0, midLine: false, fingerprint: none, head: none, addresses: new Map() };
      this.scans.set(sessionId, scan);
    }
    const target = Math.min(offset, size);
    const bytesRead = scan.offset < target ? await this.readForward(handle, scan, target) : 0;
    return { addresses: scan.addresses, bytesRead };
  }

  /**
   * Reads [scan.offset, target) a chunk at a time and notes the relay's addresses in the lines there.
   * The target is where a page starts: a line's start, or inside a line too long to read, which is
   * skipped, as the page skips it.
   */
  private async readForward(handle: FileHandle, scan: AddressScan, target: number): Promise<number> {
    const chunkBytes = Math.max(1, this.options.chunkBytes ?? ADDRESS_CHUNK_BYTES);
    const start = scan.offset;
    let pos = start;
    let lineStart = pos;
    let skipping = scan.midLine;
    let parts: Buffer[] = [];
    let partBytes = 0;
    while (pos < target) {
      const want = Math.min(chunkBytes, target - pos);
      const chunk = await readRange(handle, pos, pos + want);
      if (chunk.length !== want) throw new TranscriptChangedError();
      let from = 0;
      for (let newline = chunk.indexOf(NEWLINE); newline !== -1; newline = chunk.indexOf(NEWLINE, from)) {
        if (skipping) skipping = false;
        else this.take(scan, partBytes === 0 ? chunk.subarray(from, newline) : Buffer.concat([...parts, chunk.subarray(from, newline)]), lineStart);
        parts = [];
        partBytes = 0;
        from = newline + 1;
        lineStart = pos + from;
      }
      if (!skipping && from < chunk.length) {
        if (partBytes + chunk.length - from > ADDRESS_LINE_MAX) {
          parts = [];
          partBytes = 0;
          skipping = true;
        } else {
          // readRange gives a new buffer every time, so the part needn't be copied.
          parts.push(chunk.subarray(from));
          partBytes += chunk.length - from;
        }
      }
      pos += want;
    }
    scan.offset = target;
    // A line that runs on past the target is one the page skipped as too long to read: so is its rest.
    scan.midLine = skipping || partBytes > 0;
    scan.fingerprint = await fingerprint(handle, target);
    scan.head = await digest(handle, 0, Math.min(HEAD_BYTES, target));
    return target - start;
  }

  /**
   * Notes the address a message from the relay on this line came from, if it's the first from there.
   * Past 64, the address first seen earliest goes, so the newest are kept: the relay gets a new socket
   * each time it restarts, and a long-lived session's later replies would otherwise stop matching. The
   * book reads forward, so the map's order is the order the addresses were first seen.
   */
  private take(scan: AddressScan, line: Buffer, offset: number): void {
    if (line.indexOf(this.marker) === -1) return;
    for (const item of itemsOfLine(line.toString('utf8'))) {
      const address = item.kind === 'entry' ? relayAddress(item.sender, this.name) : undefined;
      if (address === undefined || scan.addresses.has(address)) continue;
      if (scan.addresses.size >= RELAY_ADDRESSES_MAX) {
        const earliest = scan.addresses.keys().next().value;
        if (earliest !== undefined) scan.addresses.delete(earliest);
      }
      scan.addresses.set(address, offset);
    }
  }
}

// --- Building a page -------------------------------------------------------------

/**
 * What a tool result says: 'error' when it's marked as one; 'failed' when it's JSON whose `success`
 * is false, as SendMessage's is when it couldn't send; otherwise 'ok'.
 */
type ResultState = 'ok' | 'error' | 'failed';

/** A tool result whose call hasn't turned up yet. */
interface Pending {
  state: ResultState;
  /** A question dialog's result (W49): where its line is in the file, to read its answers from again on an older page. */
  line?: { offset: number; length: number };
  /** That result's answers, while its line is in memory: on the page that read it, never in the cursor. */
  answers?: DialogAnswers;
}

/**
 * The answers in a question dialog's result line: its `toolUseResult`'s `answers` and `annotations`,
 * as parsed, each keyed by a question's text. Looked up only for the questions of the call.
 */
interface DialogAnswers {
  answers: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * An AskUserQuestion call in the shape the contract reads (W49): its questions as AskedQuestion,
 * capped, with no answers yet, and each question's text as written, to find its answer by.
 */
interface AskCall {
  questions: AskedQuestion[];
  keys: string[];
  /** A question, an option or a string was cut to the contract's caps. */
  truncated: boolean;
}

/** A SendMessage call with a message: its `to`, trimmed, and its `message` as written. */
interface SendCall {
  to: string;
  message: string;
}

/** Who sent a cross-session message, as it says: a name, and the socket address it came from. */
interface Sender {
  name?: string;
  address?: string;
}

/** What one transcript line contributes, in file order. */
type Item =
  | { kind: 'text'; messageId: string | undefined; text: string; at: string | undefined }
  /** `to`: a SendMessage call's recipient, trimmed, with or without a message, to find a sub-agent by (W76). */
  | { kind: 'tool'; id: string | undefined; name: string; summary: string; at: string | undefined; send?: SendCall; ask?: AskCall; to?: string }
  | { kind: 'result'; id: string; state: ResultState; answers?: DialogAnswers }
  /**
   * `peer`: who a message from a peer came from, as its `origin.from` says: a sub-agent's id for its report (W76).
   * `msgId`: its `origin.msg_id`, the same in the user entry and the mid-turn attachment that can stand for it (W99).
   */
  | { kind: 'entry'; entry: ConversationEntry; sender?: Sender; peer?: string; msgId?: string }
  /** What the line says of the turn (turnSignalOf(), W102): it ended, one runs, or something arrived that starts one. */
  | { kind: 'turn'; signal: TurnSignal };

/** A SendMessage call on the page whose result, if it has one yet, didn't fail, and where its line starts. */
interface SendDraft extends SendCall {
  offset: number;
}

/** An entry being built. Assistant text keeps its blocks until the page is finished. */
type Draft =
  | { kind: 'assistant'; messageId: string | undefined; at: string | undefined; parts: string[] }
  | { kind: 'tool'; id: string | undefined; entry: ConversationEntry; send?: SendDraft }
  | { kind: 'entry'; entry: ConversationEntry }
  /**
   * A question dialog (W49). `entry.questions` gets its answers once they're found: from the result
   * on this page, or, for a result on a newer page, from its line, read again (`reread`).
   */
  | { kind: 'question'; entry: ConversationEntry; keys: string[]; reread?: { id: string; offset: number; length: number } };

/** The socket address a message from pitwall's relay came from, or undefined for any other message. */
function relayAddress(sender: Sender | undefined, relayName: string): string | undefined {
  // Claude Code's own record of the sender's name, which is the relay's --name exactly (spike 003).
  return sender?.address !== undefined && sender.name === relayName ? sender.address : undefined;
}

/**
 * Collects entries from lines handed over newest first.
 * - A text block joins the entry before it (in file order) when both are
 *   text from the same assistant message, with only thinking or skipped lines
 *   between. Joined blocks never span pages: a full page still takes lines
 *   that only join its oldest entry.
 * - A tool result is met before its call. It waits in `pending` until the
 *   call turns up, on this page or, through the cursor, an older one.
 * - A SendMessage call to pitwall's relay is a 'to-pitwall' entry. It's to the
 *   relay by name at once; by a socket address once a message from the relay
 *   that came from it is found before it: on this page, or, through
 *   `finish()`, earlier in the transcript.
 * - An AskUserQuestion call in the dialog's shape is a 'question' entry. Its
 *   answers come from its result: in memory on this page, or, through
 *   `readAnswers()`, from the result's line on a newer page.
 */
class PageBuilder {
  /** Newest first. */
  private readonly drafts: Draft[] = [];
  /** The addresses the relay's messages on this page came from, each with the offset of the earliest such line. */
  private readonly relayFrom = new Map<string, number>();
  /** The `msg_id`s of the messages from peers on this page, so one written twice shows once (W99). At most a page's entries. */
  private readonly msgIds = new Set<string>();
  /** Whether the newest turn on the page has ended (noteTurn()), once a line has said; undefined until then (W102). */
  turnEnded: boolean | undefined;

  constructor(
    readonly pending: Map<string, Pending>,
    private readonly maxEntries: number,
    private readonly relayName?: string,
    private readonly sidechain = false,
    private readonly subagents?: SubagentLabels,
  ) {}

  /**
   * Takes a line, which starts at `offset` in the file and ends at `end`, before its newline, or says
   * the page is full and the line belongs to the older page.
   */
  offer(line: string, offset: number, end: number): 'taken' | 'full' {
    const items = itemsOfLine(line, this.sidechain);
    if (items.length === 0) return 'taken';
    this.noteTurn(items);
    const added = this.newEntries(items);
    if (this.drafts.length > 0 && this.drafts.length + added > this.maxEntries) return 'full';
    for (let i = items.length - 1; i >= 0; i--) this.apply(items[i] as Item, offset, end);
    return 'taken';
  }

  /**
   * Whether the newest turn has ended (W102), from the newest line that says either, by W69's rule
   * (turnSignalOf()): a `turn_duration` mark says it has; any assistant line, a thinking block's alone
   * included, a tool's result or a prompt says one is running, and so does a message or a task
   * notification that arrived, which Claude Code starts a turn for. A local command and its output, a
   * compaction and the rest say neither. Lines are offered newest first, so the first that says wins.
   */
  private noteTurn(items: Item[]): void {
    if (this.turnEnded !== undefined) return;
    const turn = items.find((item) => item.kind === 'turn');
    if (turn?.kind === 'turn') this.turnEnded = turn.signal === 'ended';
  }

  /** How many new entries the line's items would add, given the oldest entry so far. */
  private newEntries(items: Item[]): number {
    let oldest: { assistant: boolean; messageId: string | undefined } | undefined = this.oldestText();
    let added = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i] as Item;
      if (item.kind === 'result' || item.kind === 'turn') continue;
      if (item.kind === 'text' && joins(oldest, item.messageId)) continue;
      if (item.kind === 'entry' && item.msgId !== undefined && this.msgIds.has(item.msgId)) continue;
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

  private apply(item: Item, offset: number, end: number): void {
    switch (item.kind) {
      case 'turn':
        return;
      case 'result': {
        this.pending.delete(item.id);
        const result: Pending = { state: item.state };
        if (item.answers !== undefined) {
          result.answers = item.answers;
          // Too long a line is never read again: an older page would show its questions without answers.
          if (end - offset <= ANSWER_LINE_MAX) result.line = { offset, length: end - offset };
        }
        this.pending.set(item.id, result);
        // Results whose calls never turn up are dropped, the oldest seen first.
        while (this.pending.size > MAX_PENDING) {
          const first = this.pending.keys().next().value;
          if (first === undefined) break;
          this.pending.delete(first);
        }
        return;
      }
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
        let result: Pending | undefined;
        if (item.id !== undefined) {
          result = this.pending.get(item.id);
          this.pending.delete(item.id);
        }
        const state = result?.state;
        if (item.ask !== undefined) {
          this.drafts.push(questionDraft(item.ask, item.at, item.id, result));
          return;
        }
        const entry: ConversationEntry = { kind: 'tool', text: item.summary, toolName: item.name };
        if (item.at !== undefined) entry.at = item.at;
        if (state !== undefined) entry.toolError = state === 'error';
        const subagent = this.subagentOfCall(item);
        if (subagent !== undefined) entry.subagent = subagent;
        const draft: Draft = { kind: 'tool', id: item.id, entry };
        // A call whose result was an error, or said it didn't send, stays a tool call. One with no result yet doesn't.
        if (item.send !== undefined && this.relayName !== undefined && state !== 'error' && state !== 'failed') draft.send = { ...item.send, offset };
        this.drafts.push(draft);
        return;
      }
      case 'entry': {
        // Noted for every line the page takes, so a call after it on the page knows where the relay's messages came from.
        const address = this.relayName === undefined ? undefined : relayAddress(item.sender, this.relayName);
        if (address !== undefined) this.relayFrom.set(address, Math.min(offset, this.relayFrom.get(address) ?? offset));
        if (this.full()) return;
        // Already on the page, from the newer of its two forms.
        if (item.msgId !== undefined) {
          if (this.msgIds.has(item.msgId)) return;
          this.msgIds.add(item.msgId);
        }
        const subagent = item.entry.kind === 'cross-session' ? this.subagentOf(item.peer) ?? this.subagentOf(item.entry.from) : undefined;
        this.drafts.push({ kind: 'entry', entry: subagent === undefined ? item.entry : { ...item.entry, subagent } });
        return;
      }
    }
  }

  /** The sub-agent with this id, when it's one of the session's (W76). */
  private subagentOf(agentId: string | undefined): { agentId: string; description: string } | undefined {
    const description = agentId === undefined ? undefined : this.subagents?.descriptions.get(agentId);
    return agentId === undefined || description === undefined ? undefined : { agentId, description };
  }

  /** The sub-agent an Agent call started, or a SendMessage call was sent to (W76). */
  private subagentOfCall(item: Extract<Item, { kind: 'tool' }>): { agentId: string; description: string } | undefined {
    if ((item.name === 'Agent' || item.name === 'Task') && item.id !== undefined) return this.subagentOf(this.subagents?.started.get(item.id));
    if (item.name === SEND_MESSAGE) return this.subagentOf(item.to);
    return undefined;
  }

  /** Only a single line with more entries than a page can hold gets here: the rest of it is dropped. */
  private full(): boolean {
    return this.drafts.length >= this.maxEntries;
  }

  /**
   * The answers of the question dialogs on this page whose results were on a newer page (W49): each
   * result's line, read again from where the cursor said it was, in a file `size` long. A line that
   * has gone, changed or no longer holds that call's result leaves its questions without answers.
   * At most 8 lines of at most 1 MiB, the cursor's limits. Returns the bytes read.
   */
  async readAnswers(handle: FileHandle, size: number): Promise<number> {
    let bytesRead = 0;
    for (const draft of this.drafts) {
      if (draft.kind !== 'question' || draft.reread === undefined) continue;
      const { id, offset, length } = draft.reread;
      draft.reread = undefined;
      if (offset + length > size) continue;
      const bytes = await readRange(handle, offset, offset + length);
      bytesRead += bytes.length;
      if (bytes.length !== length) continue;
      const result = itemsOfLine(bytes.toString('utf8'), this.sidechain).find((item) => item.kind === 'result' && item.id === id);
      if (result?.kind === 'result' && result.state !== 'error' && result.answers !== undefined) answerQuestions(draft, result.answers);
    }
    return bytesRead;
  }

  /** True when a call on the page is to a socket address that no message from the relay on the page came from before it. */
  unresolved(): boolean {
    return this.drafts.some((draft) => draft.kind === 'tool' && draft.send !== undefined && !this.byName(draft.send) && this.bySocket(draft.send) === undefined);
  }

  /**
   * The `to` (trimmed) is the relay's name exactly. Not ignoring case: the web UI names the recipient
   * as the call addressed it, "To pitwall-relay", and claims no more than that (W48).
   */
  private byName(send: SendDraft): boolean {
    return this.relayName !== undefined && send.to === this.relayName;
  }

  /** True when a message from the relay on this page came from the call's address before it; false when none did; undefined when the call isn't to a socket. */
  private bySocket(send: SendDraft): boolean | undefined {
    if (!send.to.startsWith(SOCKET_PREFIX)) return false;
    const first = this.relayFrom.get(send.to);
    return first !== undefined && first < send.offset ? true : undefined;
  }

  /**
   * The entries, oldest first, each with at most 32 KiB of text. The newest
   * keep theirs in full while the page's 256 KiB budget lasts; once an entry
   * doesn't fit what's left, it keeps only its first 512 characters.
   * `earlier` says whether a message from the relay came from an address
   * before the page, and before the call's offset.
   */
  finish(earlier?: (address: string, offset: number) => boolean): ConversationEntry[] {
    const toRelay = (send: SendDraft) =>
      this.byName(send) || (send.to.startsWith(SOCKET_PREFIX) && (this.bySocket(send) === true || earlier?.(send.to, send.offset) === true));
    const entries: ConversationEntry[] = [];
    const budget = { chars: PAGE_TEXT_BUDGET };
    for (const draft of this.drafts) entries.push(withinBudget(finishDraft(draft, toRelay), budget));
    return entries.reverse();
  }
}

function joins(oldest: { assistant: boolean; messageId: string | undefined } | undefined, messageId: string | undefined): boolean {
  return oldest !== undefined && oldest.assistant && messageId !== undefined && oldest.messageId === messageId;
}

function finishDraft(draft: Draft, toRelay: (send: SendDraft) => boolean): ConversationEntry {
  switch (draft.kind) {
    case 'tool':
      // The message as the session wrote it, at the call's time, in the call's place (W46).
      if (draft.send !== undefined && toRelay(draft.send)) return withAt({ kind: 'to-pitwall', text: draft.send.message, markdown: true }, draft.entry.at);
      return draft.entry;
    case 'entry':
    case 'question':
      return draft.entry;
    case 'assistant':
      // Parts were collected newest first. Each block is markdown on its own, so they're joined as
      // separate paragraphs: a table or a list at the end of one doesn't run on into the next.
      return withAt({ kind: 'assistant', text: [...draft.parts].reverse().join('\n\n'), markdown: true }, draft.at);
  }
}

/**
 * A question dialog's draft (W49): its questions, at the call's time, with the first as the entry's
 * one-line text. With a result, `toolError` says whether it was an error, and the answers come from
 * it: at once when it's in memory, or else from its line, read again by `readAnswers()`. An error,
 * such as a dismissed dialog, has none.
 */
function questionDraft(ask: AskCall, at: string | undefined, id: string | undefined, result: Pending | undefined): Extract<Draft, { kind: 'question' }> {
  const entry: ConversationEntry = withAt({ kind: 'question', text: oneLine(ask.questions[0]?.question ?? '', TOOL_SUMMARY_MAX), questions: ask.questions }, at);
  if (ask.truncated) entry.truncated = true;
  if (result !== undefined) entry.toolError = result.state === 'error';
  const draft: Extract<Draft, { kind: 'question' }> = { kind: 'question', entry, keys: ask.keys };
  if (result === undefined || result.state === 'error') return draft;
  if (result.answers !== undefined) answerQuestions(draft, result.answers);
  else if (result.line !== undefined && id !== undefined) draft.reread = { id, ...result.line };
  return draft;
}

/**
 * Each question's answer and notes, found by the question's text as the call wrote it, trimmed and
 * capped as the contract says. Only a string counts, and a blank one is none: the result's prose is
 * never read for answers.
 */
function answerQuestions(draft: Extract<Draft, { kind: 'question' }>, found: DialogAnswers): void {
  const questions = draft.entry.questions ?? [];
  questions.forEach((question, i) => {
    const key = draft.keys[i];
    if (key === undefined) return;
    const value = ownValue(found.answers, key);
    const answer = typeof value === 'string' ? field(value, ANSWER_MAX) : undefined;
    const annotation = found.annotations === undefined ? undefined : ownValue(found.annotations, key);
    const notes = isRecord(annotation) && typeof annotation.notes === 'string' ? field(annotation.notes, NOTES_MAX) : undefined;
    if (answer !== undefined) question.answer = answer.text;
    if (notes !== undefined) question.notes = notes.text;
    if (answer?.cut === true || notes?.cut === true) draft.entry.truncated = true;
  });
}

/** `record[key]` when it's the record's own, so a question named like `constructor` finds nothing it didn't have. */
function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * The entry with at most 32 KiB of text, without splitting a surrogate pair, and in full while the
 * page's budget lasts: once it doesn't fit what's left, only its first 512 characters. Either cut
 * marks it truncated. The text is cut as it is, never trimmed, so a shorter copy of an entry is
 * always the start of the longer one.
 */
function withinBudget(entry: ConversationEntry, budget: { chars: number }): ConversationEntry {
  if (entry.questions !== undefined) return questionWithinBudget(entry, entry.questions, budget);
  let text = cap(entry.text, ENTRY_TEXT_MAX);
  if (text.length <= budget.chars) budget.chars -= text.length;
  else text = cap(text, LEAN_TEXT_MAX);
  if (text.length === entry.text.length) return entry;
  return { ...entry, text, truncated: true };
}

/**
 * A question entry (W49) in full while the page's budget lasts, its text and every string of its
 * questions counting against it: the questions, headers, labels, descriptions, answers and notes.
 * Once it doesn't fit what's left, each string keeps only its first 512 characters, and a cut marks
 * it truncated. Its text, a one-line summary of at most 200, is never cut, so its key holds.
 */
function questionWithinBudget(entry: ConversationEntry, questions: AskedQuestion[], budget: { chars: number }): ConversationEntry {
  let size = entry.text.length;
  for (const question of questions) {
    size += question.question.length + (question.header?.length ?? 0) + (question.answer?.length ?? 0) + (question.notes?.length ?? 0);
    for (const option of question.options) size += option.label.length + (option.description?.length ?? 0);
  }
  if (size <= budget.chars) {
    budget.chars -= size;
    return entry;
  }
  let cut = false;
  const lean = (text: string) => {
    const kept = cap(text, LEAN_TEXT_MAX);
    if (kept.length < text.length) cut = true;
    return kept;
  };
  const leaned = questions.map((question) => {
    const copy: AskedQuestion = {
      question: lean(question.question),
      options: question.options.map((option) => (option.description === undefined ? { label: lean(option.label) } : { label: lean(option.label), description: lean(option.description) })),
    };
    if (question.header !== undefined) copy.header = lean(question.header);
    if (question.multiSelect === true) copy.multiSelect = true;
    if (question.answer !== undefined) copy.answer = lean(question.answer);
    if (question.notes !== undefined) copy.notes = lean(question.notes);
    return copy;
  });
  return cut ? { ...entry, questions: leaned, truncated: true } : entry;
}

// --- Reading lines ---------------------------------------------------------------

/**
 * What a transcript line contributes. Lines that don't parse, sidechains (unless `sidechain`, for a
 * sub-agent's own transcript) and other entry types give nothing.
 */
export function itemsOfLine(line: string, sidechain = false): Item[] {
  // Cheap pre-filter: every line this reads names one of these. Not "system":
  // Claude Code's internal api-request lines carry a system prompt, and they
  // can be most of a transcript's bytes. Nor "attachment": Claude Code writes
  // many kinds, and only a queued_command's is read (W99).
  // A turn's end is a small `system` entry of its own, `turn_duration` (W102).
  if (
    !line.includes('"user"') &&
    !line.includes('"assistant"') &&
    !line.includes('"local_command"') &&
    !line.includes('"queued_command"') &&
    !line.includes('"turn_duration"')
  ) {
    return [];
  }
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(entry) || (entry.isSidechain === true && !sidechain)) return [];
  const items = entryItems(entry, timestampOf(entry));
  // What the line says of the session's turn (W102). Never a sidechain's, so a sub-agent's page has none.
  const signal = turnSignalOf(entry);
  if (signal !== undefined) items.push({ kind: 'turn', signal });
  return items;
}

/** The entries, tool calls and results a parsed line contributes, by its type. */
function entryItems(entry: Record<string, unknown>, at: string | undefined): Item[] {
  switch (entry.type) {
    case 'assistant':
      return assistantItems(entry, at);
    case 'user':
      return userItems(entry, at);
    case 'system':
      return systemItems(entry, at);
    case 'attachment': {
      // What arrived mid-turn, as the user entry it stands for (W99), marked as having come mid-turn,
      // so it doesn't read as what started the turn (W102).
      const queued = queuedEntryOf(entry);
      const items = queued === undefined ? [] : userItems(queued, at);
      for (const item of items) if (item.kind === 'entry') item.entry.midTurn = true;
      return items;
    }
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
    // Claude Code's own error, written on Claude's side of a turn: never what started one (W102).
    const text = textOf(content)?.trim();
    return text ? [midTurn(notice(text, at))] : [];
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
      const item: Extract<Item, { kind: 'tool' }> = { kind: 'tool', id, name, summary: toolSummary(name, block.input), at };
      const send = name === SEND_MESSAGE ? sendCall(block.input) : undefined;
      if (send !== undefined) item.send = send;
      const to = name === SEND_MESSAGE ? recipientOf(block.input) : undefined;
      if (to !== undefined) item.to = to;
      const ask = name === ASK_USER_QUESTION ? askCall(block.input) : undefined;
      if (ask !== undefined) item.ask = ask;
      items.push(item);
    }
  }
  return items;
}

/**
 * A SendMessage call's `to`, trimmed, and its `message` as written, capped as entries are. Undefined
 * without both, or with a message that's only whitespace. Its `content` is only a short preview, so
 * it's never read; nor are `summary`, `recipient` and `recipient_kind`.
 */
function sendCall(input: unknown): SendCall | undefined {
  if (!isRecord(input)) return undefined;
  const { to, message } = input;
  if (typeof to !== 'string' || typeof message !== 'string' || !/\S/.test(message)) return undefined;
  const address = to.trim();
  if (address === '' || address.length > ADDRESS_MAX) return undefined;
  return { to: address, message: cap(message, ENTRY_TEXT_MAX + 1) };
}

/** A SendMessage call's `to`, trimmed, whatever else it has. Undefined when it's not a string, blank or too long. */
function recipientOf(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.to !== 'string') return undefined;
  const to = input.to.trim();
  return to === '' || to.length > ADDRESS_MAX ? undefined : to;
}

/**
 * An AskUserQuestion call's input in the dialog's shape (W49), as seen in October 2026: `questions`,
 * a list of at least one, each with a `question` and `options`, a list of `{ label }`, the question
 * and each label a string that isn't blank. A `header`, an option's `description` and `multiSelect:
 * true` are kept when they're there and of their type; anything else, such as an option's `preview`,
 * is ignored. Any other input is undefined, so the call stays a tool call.
 *
 * Every string is trimmed and capped as the contract says, and only the first 8 questions, and the
 * first 8 options of each, are read; past a cap, the entry is marked truncated. Each question's text
 * as the call wrote it is kept, to find its answer by.
 */
function askCall(input: unknown): AskCall | undefined {
  if (!isRecord(input) || !Array.isArray(input.questions) || input.questions.length === 0) return undefined;
  let truncated = input.questions.length > QUESTIONS_MAX;
  const questions: AskedQuestion[] = [];
  const keys: string[] = [];
  for (const value of input.questions.slice(0, QUESTIONS_MAX)) {
    if (!isRecord(value) || typeof value.question !== 'string' || !Array.isArray(value.options)) return undefined;
    const question = field(value.question, QUESTION_MAX);
    if (question === undefined) return undefined;
    if (value.options.length > OPTIONS_MAX) truncated = true;
    const options: AskedQuestion['options'] = [];
    for (const choice of value.options.slice(0, OPTIONS_MAX)) {
      const label = isRecord(choice) && typeof choice.label === 'string' ? field(choice.label, LABEL_MAX) : undefined;
      if (label === undefined) return undefined;
      const description = isRecord(choice) && typeof choice.description === 'string' ? field(choice.description, DESCRIPTION_MAX) : undefined;
      options.push(description === undefined ? { label: label.text } : { label: label.text, description: description.text });
      if (label.cut || description?.cut === true) truncated = true;
    }
    const asked: AskedQuestion = { question: question.text, options };
    const header = typeof value.header === 'string' ? field(value.header, HEADER_MAX) : undefined;
    if (header !== undefined) asked.header = header.text;
    if (value.multiSelect === true) asked.multiSelect = true;
    if (question.cut || header?.cut === true) truncated = true;
    questions.push(asked);
    keys.push(value.question);
  }
  return { questions, keys, truncated };
}

/** A string trimmed and capped at `max`, and whether the cap cut it. Undefined when it's blank. */
function field(value: string, max: number): { text: string; cut: boolean } | undefined {
  const text = value.trim();
  if (text === '') return undefined;
  const kept = cap(text, max);
  return { text: kept, cut: kept.length < text.length };
}

/**
 * The answers in a question dialog's result (W49): the result line's `toolUseResult`, as seen in
 * October 2026, `{ questions, answers: { <question>: <answer> }, annotations: { <question>: { notes?,
 * preview? } } }`. Only `answers`, a record, is needed; `annotations` is read when it's a record.
 * Undefined for anything else, such as a dismissed dialog's string.
 */
function dialogAnswers(value: unknown): DialogAnswers | undefined {
  if (!isRecord(value) || !isRecord(value.answers)) return undefined;
  return isRecord(value.annotations) ? { answers: value.answers, annotations: value.annotations } : { answers: value.answers };
}

/** A tool result's state (ResultState). Only a short result is read as JSON, and only one that starts like an object with a `success`. */
function resultState(block: Record<string, unknown>): ResultState {
  if (block.is_error === true) return 'error';
  const text = shortText(block.content, RESULT_JSON_MAX)?.trim();
  if (text === undefined || !text.startsWith('{') || !text.includes('"success"')) return 'ok';
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) && value.success === false ? 'failed' : 'ok';
  } catch {
    return 'ok';
  }
}

/** A string content, or the text blocks of an array content joined with newlines, when that's at most `max` long. */
function shortText(content: unknown, max: number): string | undefined {
  if (typeof content === 'string') return content.length <= max ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  let length = 0;
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
    length += block.text.length + (parts.length > 0 ? 1 : 0);
    if (length > max) return undefined;
    parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function userItems(entry: Record<string, unknown>, at: string | undefined): Item[] {
  if (entry.isCompactSummary === true) {
    // Written as a turn goes on, or by a /compact that runs no turn of its own: never what started one (W102).
    return [midTurn(notice('Conversation compacted: Claude continued from a summary of the earlier conversation.', at))];
  }
  const message = entry.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  let images = 0;
  if (Array.isArray(content)) {
    const results: Extract<Item, { kind: 'result' }>[] = [];
    let blocks = 0;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        blocks++;
        if (typeof block.tool_use_id === 'string') results.push({ kind: 'result', id: block.tool_use_id, state: resultState(block) });
      } else if (block.type === 'image') {
        images++;
      }
    }
    if (blocks > 0) {
      // The line's toolUseResult is its one result's: a question dialog's answers, when it has them (W49).
      const [only] = results;
      const answers = blocks === 1 && only !== undefined && only.state !== 'error' ? dialogAnswers(entry.toolUseResult) : undefined;
      if (only !== undefined && answers !== undefined) only.answers = answers;
      return results;
    }
  }
  const raw = textOf(content);
  if (raw === undefined && images === 0) return [];
  const unreminded = stripSystemReminders(raw ?? '');
  const text = unreminded.trim();
  const origin = isRecord(entry.origin) ? entry.origin.kind : undefined;
  // A message from another session, whatever else says so: never the user's prompt (W99).
  if (text.startsWith(CROSS_SESSION_PREFIX) || origin === 'peer' || startsWithCrossSessionTag(text)) {
    if (text === '') return [];
    const item = crossSession(text, at);
    // Who it came from, as Claude Code recorded it: a sub-agent's id for its report (W76).
    const from = origin === 'peer' && isRecord(entry.origin) ? entry.origin.from : undefined;
    if (item.kind === 'entry' && typeof from === 'string' && from.length <= ADDRESS_MAX) item.peer = from;
    // Which message it is, a session's to this one (W99): on the entry too, for recaps (W110).
    const msgId = origin === 'peer' && isRecord(entry.origin) ? entry.origin.msg_id : undefined;
    if (item.kind === 'entry' && typeof msgId === 'string' && msgId !== '' && msgId.length <= ADDRESS_MAX) {
      item.msgId = msgId;
      item.entry.msgId = msgId;
    }
    return [item];
  }
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

/**
 * Claude Code writes local slash-command output as `system` entries too. Other system entries are left
 * out, its mark that a turn has ended (W102) included: that's no entry, and itemsOfLine() notes it.
 */
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
  let address: string | undefined;
  if (tag !== undefined) {
    const openEnd = rest.indexOf('>', open);
    if (openEnd !== -1) {
      // Attributes are short; bounding the slice bounds the patterns below.
      const attributes = rest.slice(open + 1 + tag.length, Math.min(openEnd, open + 2048));
      const fromName = /(?:^|\s)from-name="([^"]*)"/.exec(attributes)?.[1];
      const fromAttr = /(?:^|\s)from="([^"]*)"/.exec(attributes)?.[1];
      const isSocket = fromAttr?.startsWith(SOCKET_PREFIX) === true;
      from = fromName ?? (fromAttr !== undefined && !isSocket ? fromAttr : undefined);
      // Where it came from, which a reply's `to` names (W46).
      if (isSocket && fromAttr !== undefined && fromAttr.length <= ADDRESS_MAX) address = decodeEntities(fromAttr);
      const close = rest.lastIndexOf(`</${tag}>`);
      body = close > openEnd ? rest.slice(openEnd + 1, close) : rest.slice(openEnd + 1);
    }
  }
  const entry: ConversationEntry = withAt({ kind: 'cross-session', text: cap(body.trim(), ENTRY_TEXT_MAX + 1), markdown: true }, at);
  const name = from === undefined ? undefined : decodeEntities(from);
  const sender = name === undefined ? '' : oneLine(name, 120);
  if (sender !== '') entry.from = sender;
  if (address === undefined) return { kind: 'entry', entry };
  return { kind: 'entry', entry, sender: name === undefined ? { address } : { name, address } };
}

/** True when `text` opens with one of the tags a message from another session is wrapped in. */
function startsWithCrossSessionTag(text: string): boolean {
  return CROSS_SESSION_TAGS.some((tag) => text.startsWith(`<${tag}`) && /^[\s>]/.test(text.charAt(tag.length + 1)));
}

function notice(text: string, at: string | undefined): Item {
  const entry: ConversationEntry = withAt({ kind: 'notice', text: truncate(text, NOTICE_MAX) }, at);
  if (text.length > NOTICE_MAX) entry.truncated = true;
  return { kind: 'entry', entry };
}

/** An entry item marked as written during a turn, so it isn't read as what started one (ConversationEntry.midTurn, W102). */
function midTurn(item: Item): Item {
  if (item.kind === 'entry') item.entry.midTurn = true;
  return item;
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
