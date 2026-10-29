// What a recap reads from a session's transcript besides its latest turns (M5, spike 010, finding
// 2), part of the transcript adapter. The conversation reader keeps neither Claude Code's own recap
// (`away_summary`) nor a compaction summary's text (finding 4), so these come from the raw entries:
//
//   the first prompt         the first user entry promptTextOf() accepts, reading forward, a prompt
//                            queued mid-turn included (queuedEntryOf()), within FIRST_PROMPT_BUDGET
//   the newest away_summary  awaySummaryOf(), reading backwards from the end
//   the newest compaction    the newest user entry with `isCompactSummary: true`, reading backwards
//
// The backward read stops once it has both, or after NEWEST_BUDGET bytes. What's read is kept per
// file, in memory, so the next recap reads only what was appended since: newer entries replace older
// ones. A file that was replaced or shrank is read afresh. Transcript JSONL is an internal Claude
// Code format, so this fails soft: a line it can't read is skipped, and a file it can't read gives
// nothing, never an exception.
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { isRecord } from './guards.js';
import { cap, tail } from './text.js';
import { awaySummaryOf, promptTextOf, queuedEntryOf, stripSystemReminders, type AwaySummary } from './transcripts.js';

const KIB = 1024;
const MIB = 1024 * KIB;

/** How far into a transcript the first prompt is looked for. It's almost always in the first few KiB. */
export const FIRST_PROMPT_BUDGET = 8 * MIB;
/** How far back from the end the newest away_summary and compaction summary are looked for. */
export const NEWEST_BUDGET = 32 * MIB;
/** How much is read at a time. */
const CHUNK_BYTES = MIB;
/** A line longer than this is skipped. A compaction summary is under 64 KiB (spike 010: 15.9k to 36.3k characters). */
const MAX_LINE_BYTES = 8 * MIB;
/** The most of a first prompt or a compaction summary kept, its start and end. A recap sends far less (src/recaps/input.ts). */
export const SOURCE_TEXT_MAX = 64 * KIB;
const NEWLINE = 0x0a;

/** A compaction summary: Claude Code's summary of the conversation before it, written when it compacted. */
export interface CompactionSummary {
  /** Its text, with `<system-reminder>` blocks removed, at most SOURCE_TEXT_MAX characters, its start and end. */
  text: string;
  /** ISO 8601, when its entry has a time. */
  at?: string;
}

export interface RecapSources {
  /** The first prompt, whole and trimmed, or its start and end when it's over SOURCE_TEXT_MAX. */
  firstPrompt?: string;
  awaySummary?: AwaySummary;
  compaction?: CompactionSummary;
}

export interface RecapSourceReader {
  /** What's in `file`, read as above. Never rejects: what it can't read is left out. */
  read(file: string): Promise<RecapSources>;
  /** Forgets every file but these. */
  retain(files: ReadonlySet<string>): void;
}

export interface RecapSourceOptions {
  /** Default FIRST_PROMPT_BUDGET. */
  firstPromptBudget?: number;
  /** Default NEWEST_BUDGET. */
  newestBudget?: number;
  /** Default 1 MiB. */
  chunkBytes?: number;
}

interface FileState {
  dev: number;
  ino: number;
  /** The first prompt, once found. */
  firstPrompt?: string;
  /** Where the forward search for the first prompt goes on from: a line's start. */
  forwardOffset: number;
  /** The end of the last complete line the newest entries were read up to. */
  newestEnd: number;
  awaySummary?: AwaySummary;
  compaction?: CompactionSummary;
}

/** The text of `text` at most `max` characters long, keeping its start and end. */
function startAndEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 3) / 2);
  return `${cap(text, half)} … ${tail(text, half)}`;
}

/** A string content, or the text blocks of an array content joined with newlines. */
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** A compaction summary's entry: a user entry with `isCompactSummary: true`, not a sidechain's, with text. */
export function compactionOf(entry: Record<string, unknown>): CompactionSummary | undefined {
  if (entry.type !== 'user' || entry.isCompactSummary !== true || entry.isSidechain === true) return undefined;
  const message = entry.message;
  const raw = isRecord(message) ? textOf(message.content) : undefined;
  if (raw === undefined) return undefined;
  const text = startAndEnd(stripSystemReminders(raw).trim(), SOURCE_TEXT_MAX);
  if (text === '') return undefined;
  const ms = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(ms) ? { text, at: new Date(ms).toISOString() } : { text };
}

/** The prompt a line holds, by promptTextOf()'s rule, a prompt queued mid-turn included. */
function promptOf(line: string): string | undefined {
  if (!line.includes('"user"') && !line.includes('"queued_command"')) return undefined;
  const entry = parse(line);
  if (entry === undefined) return undefined;
  const user = entry.type === 'attachment' ? queuedEntryOf(entry) : entry;
  if (user === undefined || user.type !== 'user') return undefined;
  const text = promptTextOf(user);
  return text === undefined ? undefined : startAndEnd(text, SOURCE_TEXT_MAX);
}

/** What a line says of the newest entries: an away_summary, a compaction summary, or neither. */
function newestOf(line: string): { away?: AwaySummary; compaction?: CompactionSummary } | undefined {
  if (!line.includes('"away_summary"') && !line.includes('isCompactSummary')) return undefined;
  const entry = parse(line);
  if (entry === undefined) return undefined;
  const away = awaySummaryOf(entry);
  if (away !== undefined) return { away };
  const compaction = compactionOf(entry);
  return compaction === undefined ? undefined : { compaction };
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const entry: unknown = JSON.parse(line);
    return isRecord(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

async function readRange(handle: FileHandle, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === buffer.length ? buffer : buffer.subarray(0, filled);
}

const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

export function createRecapSourceReader(options: RecapSourceOptions = {}): RecapSourceReader {
  const firstPromptBudget = options.firstPromptBudget ?? FIRST_PROMPT_BUDGET;
  const newestBudget = options.newestBudget ?? NEWEST_BUDGET;
  const chunkBytes = Math.max(1, options.chunkBytes ?? CHUNK_BYTES);
  const files = new Map<string, FileState>();
  /** One read at a time per file, so two recaps never read the same bytes twice. */
  const busy = new Map<string, Promise<unknown>>();

  /**
   * Reads complete lines forward from `from`, at most to `to`, handing each to `each` until it says
   * stop. Returns the offset after the last complete line read: where a later read goes on from.
   */
  async function forward(handle: FileHandle, from: number, to: number, each: (line: string) => boolean): Promise<number> {
    let pos = from;
    let lineStart = from;
    let parts: Buffer[] = [];
    let partBytes = 0;
    let skipping = false;
    while (pos < to) {
      const chunk = await readRange(handle, pos, Math.min(to, pos + chunkBytes));
      if (chunk.length === 0) break;
      let at = 0;
      for (let newline = chunk.indexOf(NEWLINE, at); newline !== -1; newline = chunk.indexOf(NEWLINE, at)) {
        const piece = chunk.subarray(at, newline);
        if (!skipping && partBytes + piece.length <= MAX_LINE_BYTES) {
          const line = parts.length === 0 ? piece.toString('utf8') : Buffer.concat([...parts, piece]).toString('utf8');
          if (each(line)) return pos + newline + 1;
        }
        parts = [];
        partBytes = 0;
        skipping = false;
        at = newline + 1;
        lineStart = pos + at;
      }
      const rest = chunk.subarray(at);
      if (!skipping) {
        if (partBytes + rest.length > MAX_LINE_BYTES) {
          parts = [];
          partBytes = 0;
          skipping = true;
        } else if (rest.length > 0) {
          parts.push(Buffer.from(rest));
          partBytes += rest.length;
        }
      }
      pos += chunk.length;
    }
    return lineStart;
  }

  /**
   * Reads complete lines backwards from `end`, a line's end, to at most `budget` bytes before it,
   * newest first, handing each to `each` until it says stop.
   */
  async function backward(handle: FileHandle, end: number, budget: number, each: (line: string) => boolean): Promise<void> {
    const floor = Math.max(0, end - budget);
    let pos = end;
    // The start of a line whose end was read, from the chunk after this one.
    let carry: Buffer = Buffer.alloc(0);
    let skipping = false;
    while (pos > floor) {
      const start = Math.max(floor, pos - chunkBytes);
      const chunk = await readRange(handle, start, pos);
      if (chunk.length !== pos - start) return;
      const data = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      let lineEnd = data.length;
      for (let newline = data.lastIndexOf(NEWLINE, lineEnd - 1); newline !== -1; newline = lineEnd > 0 ? data.lastIndexOf(NEWLINE, lineEnd - 1) : -1) {
        if (!skipping && lineEnd - newline - 1 <= MAX_LINE_BYTES) {
          if (each(data.toString('utf8', newline + 1, lineEnd))) return;
        }
        skipping = false;
        lineEnd = newline;
      }
      carry = Buffer.from(data.subarray(0, lineEnd));
      if (carry.length > MAX_LINE_BYTES) {
        carry = Buffer.alloc(0);
        skipping = true;
      }
      pos = start;
    }
    // At the file's start, what's left is its first line. At the budget's edge, it may be part of one.
    if (pos === 0 && !skipping && carry.length > 0) each(carry.toString('utf8'));
  }

  async function readFile(file: string): Promise<RecapSources> {
    let handle: FileHandle;
    try {
      handle = await open(file, READ_FLAGS);
    } catch {
      files.delete(file);
      return {};
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        files.delete(file);
        return {};
      }
      let state = files.get(file);
      if (state === undefined || state.dev !== info.dev || state.ino !== info.ino || info.size < state.newestEnd || info.size < state.forwardOffset) {
        state = { dev: info.dev, ino: info.ino, forwardOffset: 0, newestEnd: -1 };
        files.set(file, state);
      }
      const current = state;
      if (current.firstPrompt === undefined && current.forwardOffset < Math.min(info.size, firstPromptBudget)) {
        current.forwardOffset = await forward(handle, current.forwardOffset, Math.min(info.size, firstPromptBudget), (line) => {
          const prompt = promptOf(line);
          if (prompt === undefined) return false;
          current.firstPrompt = prompt;
          return true;
        });
      }
      if (current.newestEnd < 0) {
        // The first read: backwards from the last complete line's end.
        const end = await lastLineEnd(handle, info.size);
        await backward(handle, end, newestBudget, (line) => {
          const found = newestOf(line);
          if (found?.away !== undefined && current.awaySummary === undefined) current.awaySummary = found.away;
          if (found?.compaction !== undefined && current.compaction === undefined) current.compaction = found.compaction;
          return current.awaySummary !== undefined && current.compaction !== undefined;
        });
        current.newestEnd = end;
      } else if (info.size > current.newestEnd) {
        // What was appended since: anything found is newer than what was kept.
        current.newestEnd = await forward(handle, current.newestEnd, info.size, (line) => {
          const found = newestOf(line);
          if (found?.away !== undefined) current.awaySummary = found.away;
          if (found?.compaction !== undefined) current.compaction = found.compaction;
          return false;
        });
      }
      const sources: RecapSources = {};
      if (current.firstPrompt !== undefined) sources.firstPrompt = current.firstPrompt;
      if (current.awaySummary !== undefined) sources.awaySummary = { ...current.awaySummary };
      if (current.compaction !== undefined) sources.compaction = { ...current.compaction };
      return sources;
    } catch {
      files.delete(file);
      return {};
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** The offset after the file's last newline: where its last complete line ends. 0 when it has none. */
  async function lastLineEnd(handle: FileHandle, size: number): Promise<number> {
    let pos = size;
    while (pos > 0 && size - pos < MAX_LINE_BYTES + chunkBytes) {
      const start = Math.max(0, pos - chunkBytes);
      const chunk = await readRange(handle, start, pos);
      const newline = chunk.lastIndexOf(NEWLINE);
      if (newline !== -1) return start + newline + 1;
      pos = start;
    }
    return 0;
  }

  return {
    read(file) {
      const previous = busy.get(file) ?? Promise.resolve();
      const run = previous.then(() => readFile(file)).catch(() => ({}) as RecapSources);
      busy.set(file, run);
      void run.then(() => {
        if (busy.get(file) === run) busy.delete(file);
      });
      return run;
    },
    retain(keep) {
      for (const file of files.keys()) if (!keep.has(file)) files.delete(file);
    },
  };
}
