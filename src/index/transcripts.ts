// The transcript adapter. Transcript JSONL is an internal Claude Code format
// that changes between versions, so everything that touches it lives here and
// fails soft: any problem becomes `missing` or `unreadable`, never an exception.

import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptStatus } from '../shared/protocol.js';
import { isRecord } from './guards.js';

export interface TranscriptInfo {
  transcript: TranscriptStatus;
  /** ISO 8601. */
  lastActivityAt?: string;
  lastAssistantText?: string;
  lastUserPrompt?: string;
}

export interface TranscriptReaderOptions {
  /** Default `$CLAUDE_CONFIG_DIR`, or `~/.claude` when it isn't set. */
  configDir?: string;
  /** Milliseconds since the epoch. Default `Date.now`. */
  now?: () => number;
  /** Bytes read from the end of a file the first time it's seen. Default 256 KiB. */
  initialWindowBytes?: number;
  /**
   * The one wider window used when the first one lacks a field, and the most
   * a file may grow between polls before it's read afresh. Default 2 MiB.
   */
  maxWindowBytes?: number;
  /** How long a transcript that couldn't be found anywhere is not searched for again. Default 30000. */
  missingRetryMs?: number;
}

export interface TranscriptReader {
  /**
   * Reads what's new in a session's transcript and returns the latest fields.
   * `cwds` are the directories to try for the encoded project path, usually
   * the cwd `claude agents` reported and its realpath. Never rejects.
   */
  read(sessionId: string, cwds: readonly string[]): Promise<TranscriptInfo>;
  /** Forgets every session not in `sessionIds`. */
  retain(sessionIds: ReadonlySet<string>): void;
}

export const ASSISTANT_TEXT_MAX = 500;
export const USER_PROMPT_MAX = 300;
const KIB = 1024;
const MIB = 1024 * KIB;
/** An incomplete line longer than this is dropped rather than kept for the next read. */
const MAX_CARRY_BYTES = 8 * MIB;
/** Kept from a message's text before truncation, so later text blocks of the same message can be joined. */
const TEXT_KEEP = 4 * ASSISTANT_TEXT_MAX;
const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);
/** Session ids become file names, so anything that could escape the projects directory is refused. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR;
  return fromEnv ? path.resolve(fromEnv) : path.join(home, '.claude');
}

/** Claude Code's project directory name for a cwd: every non-alphanumeric character becomes `-`. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function createTranscriptReader(options: TranscriptReaderOptions = {}): TranscriptReader {
  const projectsDir = path.join(options.configDir ?? defaultConfigDir(), 'projects');
  const now = options.now ?? Date.now;
  const initialWindow = options.initialWindowBytes ?? 256 * KIB;
  const maxWindow = Math.max(options.maxWindowBytes ?? 2 * MIB, initialWindow);
  const missingRetryMs = options.missingRetryMs ?? 30_000;

  const files = new Map<string, FileState>();
  const located = new Map<string, string>();
  const missingUntil = new Map<string, number>();

  async function locate(sessionId: string, cwds: readonly string[]): Promise<string | undefined> {
    const cached = located.get(sessionId);
    if (cached !== undefined) return cached;
    const fileName = `${sessionId}.jsonl`;
    for (const cwd of new Set(cwds)) {
      const candidate = path.join(projectsDir, encodeProjectDir(cwd), fileName);
      if (await isFile(candidate)) return remember(sessionId, candidate);
    }
    // Long paths are truncated and hashed, so the encoded name can't always be
    // predicted. Search every project directory, but not on every poll.
    const retryAt = missingUntil.get(sessionId);
    if (retryAt !== undefined && retryAt > now()) return undefined;
    const found = await search(fileName);
    if (found !== undefined) return remember(sessionId, found);
    missingUntil.set(sessionId, now() + missingRetryMs);
    return undefined;
  }

  function remember(sessionId: string, file: string): string {
    located.set(sessionId, file);
    missingUntil.delete(sessionId);
    return file;
  }

  async function search(fileName: string): Promise<string | undefined> {
    let entries;
    try {
      entries = await readdir(projectsDir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(projectsDir, entry.name, fileName);
      if (await isFile(candidate)) return candidate;
    }
    return undefined;
  }

  /** Undefined when the file has gone. */
  async function readFile(sessionId: string, file: string): Promise<TranscriptInfo | undefined> {
    let handle: FileHandle;
    try {
      handle = await open(file, 'r');
    } catch (err) {
      if (isGone(err)) return undefined;
      throw err;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) return { transcript: 'unreadable' };
      let state = files.get(sessionId);
      const reset =
        state === undefined ||
        state.file !== file ||
        state.ino !== info.ino ||
        state.dev !== info.dev ||
        info.size < state.offset ||
        info.size - state.offset > maxWindow;
      if (reset || state === undefined) {
        state = await firstRead(handle, file, info.size, info.ino, info.dev);
        files.set(sessionId, state);
      } else if (info.size > state.offset) {
        const chunk = await readRange(handle, state.offset, info.size);
        consume(state, chunk);
        state.offset += chunk.length;
      }
      return toInfo(state.fields);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async function firstRead(handle: FileHandle, file: string, size: number, ino: number, dev: number): Promise<FileState> {
    let state = await readWindow(handle, file, size, ino, dev, Math.min(size, initialWindow));
    if (size > initialWindow && !isComplete(state.fields)) {
      state = await readWindow(handle, file, size, ino, dev, Math.min(size, maxWindow));
    }
    return state;
  }

  return {
    async read(sessionId, cwds) {
      try {
        if (!SAFE_SESSION_ID.test(sessionId)) return { transcript: 'missing' };
        for (let attempt = 0; attempt < 2; attempt++) {
          const file = await locate(sessionId, cwds);
          if (file === undefined) break;
          const info = await readFile(sessionId, file);
          if (info !== undefined) return info;
          // The file went away since it was found: look for it again, once.
          located.delete(sessionId);
          files.delete(sessionId);
        }
        files.delete(sessionId);
        return { transcript: 'missing' };
      } catch {
        return { transcript: 'unreadable' };
      }
    },
    retain(sessionIds) {
      for (const map of [files, located, missingUntil]) {
        for (const id of map.keys()) if (!sessionIds.has(id)) map.delete(id);
      }
    },
  };
}

// --- Reading -----------------------------------------------------------------

interface FileState {
  file: string;
  ino: number;
  dev: number;
  /** Bytes of the file read so far, including `carry`. */
  offset: number;
  /** The bytes after the last newline: an incomplete line, finished by a later read. */
  carry: Buffer;
  /** Drop bytes up to the next newline: the read started mid-line, or a line was too long to keep. */
  skipToNewline: boolean;
  fields: Fields;
}

async function readWindow(
  handle: FileHandle,
  file: string,
  size: number,
  ino: number,
  dev: number,
  windowBytes: number,
): Promise<FileState> {
  const start = size - windowBytes;
  const state: FileState = { file, ino, dev, offset: 0, carry: EMPTY, skipToNewline: false, fields: {} };
  if (start > 0) {
    // Read one byte early: if it's a newline, the window starts on a line
    // boundary and its first line is kept; otherwise the partial line is dropped.
    state.skipToNewline = true;
    const chunk = await readRange(handle, start - 1, size);
    consume(state, chunk);
    state.offset = start - 1 + chunk.length;
  } else {
    const chunk = await readRange(handle, 0, size);
    consume(state, chunk);
    state.offset = chunk.length;
  }
  return state;
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

/** Feeds new bytes through the line splitter, applying every complete line. */
function consume(state: FileState, chunk: Buffer): void {
  const data = state.carry.length > 0 ? Buffer.concat([state.carry, chunk]) : chunk;
  let pos = 0;
  if (state.skipToNewline) {
    const newline = data.indexOf(NEWLINE);
    if (newline === -1) {
      state.carry = EMPTY;
      return;
    }
    pos = newline + 1;
    state.skipToNewline = false;
  }
  for (let newline = data.indexOf(NEWLINE, pos); newline !== -1; newline = data.indexOf(NEWLINE, pos)) {
    applyLine(state.fields, data.toString('utf8', pos, newline));
    pos = newline + 1;
  }
  const rest = data.length - pos;
  if (rest > MAX_CARRY_BYTES) {
    state.carry = EMPTY;
    state.skipToNewline = true;
  } else {
    // Copy, so the carry doesn't keep the whole chunk alive.
    state.carry = rest === 0 ? EMPTY : Buffer.from(data.subarray(pos));
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function isGone(err: unknown): boolean {
  const code = isRecord(err) ? err.code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// --- Extracting --------------------------------------------------------------

/** What the index keeps from a transcript, newest first-come. */
export interface Fields {
  lastActivityMs?: number;
  /** The `message.id` of the newest assistant message with text, to join text blocks written on separate lines. */
  assistantMessageId?: string;
  assistantText?: string;
  userPrompt?: string;
}

/** Applies one JSONL line. Lines that don't parse, and entry types the index doesn't use, are skipped. */
export function applyLine(fields: Fields, line: string): void {
  // Cheap pre-filter: every entry the index uses names one of these types.
  if (!line.includes('"user"') && !line.includes('"assistant"')) return;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  applyEntry(fields, entry);
}

export function applyEntry(fields: Fields, entry: unknown): void {
  if (!isRecord(entry)) return;
  const type = entry.type;
  if (type !== 'user' && type !== 'assistant') return;

  if (typeof entry.timestamp === 'string') {
    const ms = Date.parse(entry.timestamp);
    if (Number.isFinite(ms) && (fields.lastActivityMs === undefined || ms > fields.lastActivityMs)) {
      fields.lastActivityMs = ms;
    }
  }

  if (type === 'assistant') {
    const text = assistantTextOf(entry);
    if (text === undefined) return;
    if (text.id !== undefined && text.id === fields.assistantMessageId && fields.assistantText !== undefined) {
      fields.assistantText = `${fields.assistantText}\n${text.text}`.slice(0, TEXT_KEEP);
    } else {
      fields.assistantMessageId = text.id;
      fields.assistantText = text.text.slice(0, TEXT_KEEP);
    }
    return;
  }

  const prompt = userPromptOf(entry);
  if (prompt !== undefined) fields.userPrompt = prompt;
}

/**
 * The text blocks of an assistant entry, joined. `thinking`, `tool_use` and any
 * other block types are left out. Claude Code writes one content block per
 * line, so a message's text can arrive on several lines with the same
 * `message.id`; `applyEntry` joins those.
 */
export function assistantTextOf(entry: Record<string, unknown>): { id?: string; text: string } | undefined {
  if (entry.isSidechain === true) return undefined;
  const message = entry.message;
  if (!isRecord(message)) return undefined;
  const text = textOf(message.content)?.trim();
  if (!text) return undefined;
  return typeof message.id === 'string' ? { id: message.id, text } : { text };
}

const CROSS_SESSION_PREFIX = 'Another Claude session sent a message:';

/**
 * Text that starts with one of these is written by Claude Code, not typed as a
 * prompt: slash-command wrappers and output, background task notices, the
 * caveat before local command output, interruption markers, and `!` shell
 * commands with their output.
 */
const NOT_A_PROMPT_PREFIXES = [
  '<command-',
  '<local-command-',
  '<task-notification>',
  'Caveat:',
  '[Request interrupted',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  CROSS_SESSION_PREFIX,
];

/**
 * A user entry's prompt, or undefined when the entry isn't one the user typed:
 * meta entries (including cross-session messages), compact summaries,
 * sidechains, tool results, entries whose `origin.kind` marks them as from
 * another session or a task notification, and Claude Code's own wrappers.
 * `<system-reminder>` blocks are stripped first.
 */
export function userPromptOf(entry: Record<string, unknown>): string | undefined {
  if (entry.isMeta === true || entry.isCompactSummary === true || entry.isSidechain === true) return undefined;
  const origin = entry.origin;
  if (isRecord(origin) && (origin.kind === 'peer' || origin.kind === 'task-notification')) return undefined;
  const message = entry.message;
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'tool_result')) {
    return undefined;
  }
  const raw = textOf(content);
  if (raw === undefined) return undefined;
  const text = stripSystemReminders(raw).trim();
  if (text === '' || text.includes('<cross-session-message')) return undefined;
  if (NOT_A_PROMPT_PREFIXES.some((prefix) => text.startsWith(prefix))) return undefined;
  return truncate(text, USER_PROMPT_MAX);
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

export function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
}

/**
 * At most `max` characters. A cut text ends with `…`, within the limit, and
 * never splits a surrogate pair.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max - 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut).trimEnd()}…`;
}

function isComplete(fields: Fields): boolean {
  return fields.lastActivityMs !== undefined && fields.assistantText !== undefined && fields.userPrompt !== undefined;
}

function toInfo(fields: Fields): TranscriptInfo {
  const info: TranscriptInfo = { transcript: 'ok' };
  if (fields.lastActivityMs !== undefined) info.lastActivityAt = new Date(fields.lastActivityMs).toISOString();
  if (fields.assistantText !== undefined) {
    const text = truncate(fields.assistantText.trim(), ASSISTANT_TEXT_MAX);
    if (text !== '') info.lastAssistantText = text;
  }
  if (fields.userPrompt !== undefined) info.lastUserPrompt = fields.userPrompt;
  return info;
}
