// The transcript adapter. Transcript JSONL is an internal Claude Code format
// that changes between versions, so everything that touches it lives here and
// fails soft: any problem becomes `missing` or `unreadable`, never an exception.

import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AskedYou, TranscriptStatus } from '../shared/protocol.js';
import { detectAskedYou } from './asked.js';
import { isRecord } from './guards.js';
import { cap, truncate } from './text.js';

export interface TranscriptInfo {
  transcript: TranscriptStatus;
  /** ISO 8601. */
  lastActivityAt?: string;
  lastUserPrompt?: string;
  /**
   * Set when the newest assistant text asks the user something and no prompt
   * has come since. Whether the turn is over isn't decided here:
   * `toSessionSummary` drops this while it runs, by `turnEnded`, or by the
   * session's status when the transcript marks no turn's end.
   */
  askedYou?: AskedYou;
  /**
   * The newest title Claude Code generated for the session (an `ai-title`
   * entry), on one line, at most 120 characters. Internal and undocumented.
   */
  aiTitle?: string;
  /**
   * Whether the session's last turn has ended, read from the transcript (spike 007, finding 4):
   * true when a `system` entry with `subtype: 'turn_duration'` follows the newest entry that runs a
   * turn (an assistant entry, a prompt or a tool's result, sidechains' aside), and false when one of
   * those came after it. A meta entry, a local command or a manual /compact doesn't count. Undefined when the entries
   * read have no `turn_duration` at all, as from an older Claude Code: `toSessionSummary` then goes
   * by Claude Code's status, as before W69.
   */
  turnEnded?: boolean;
  /**
   * Milliseconds since the epoch: the newest prompt's time, a prompt being a user entry that
   * lastUserPrompt would show or that the user typed (isTypedPrompt). For NeedsYou's 'restarted',
   * which holds until a prompt newer than the restart.
   */
  lastPromptMs?: number;
  /**
   * Claude Code's newest recap of the session (spike 007, finding 8): the newest `system` entry with
   * `subtype: "away_summary"`, in file order, its `content` trimmed and at most AWAY_SUMMARY_MAX
   * characters, with its time. Internal and undocumented. For M5's recaps, which show it until
   * pitwall has one of its own (SessionRecap's 'claude-code' source); the snapshot doesn't carry it.
   */
  awaySummary?: AwaySummary;
}

/** Claude Code's own short recap of a session, an `away_summary` entry (TranscriptInfo.awaySummary). */
export interface AwaySummary {
  text: string;
  /** ISO 8601. */
  at: string;
}

/** The longest `away_summary` kept. Real ones are about 230 characters (spike 007, spike 010). */
export const AWAY_SUMMARY_MAX = 2000;

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
  /**
   * The transcript file `read` last found for a session, for the session
   * view to page through. Undefined when there's none. Reads no files.
   */
  transcriptFile(sessionId: string): string | undefined;
  /** Forgets every session not in `sessionIds`. */
  retain(sessionIds: ReadonlySet<string>): void;
}

export const USER_PROMPT_MAX = 300;
const KIB = 1024;
const MIB = 1024 * KIB;
/** An incomplete line longer than this is dropped rather than kept for the next read. */
const MAX_CARRY_BYTES = 8 * MIB;
/**
 * How much of the newest assistant message's raw text is kept, its text blocks
 * joined. The "asked you" check reads all of it.
 */
export const ASSISTANT_TEXT_KEEP = 64 * KIB;
/** The longest title kept from an `ai-title` entry. */
export const TITLE_MAX = 120;
const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);
/** Session ids become file names, so anything that could escape the projects directory is refused. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * True for a session id that is safe to use in a file name or a URL path: a
 * letter or digit, then letters, digits, `.`, `_` and `-`. No `/`, `..` or NUL.
 */
export function isSafeSessionId(sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId);
}

/** A UUID in its canonical form: 32 lowercase hex digits in groups of 8, 4, 4, 4 and 12, as Claude Code writes session ids. */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * True for a session id that is a canonical UUID. Stricter than isSafeSessionId(), for the ids
 * pitwall finds itself and hands to `claude --resume`: an ended session's transcript file name
 * (ended.ts), and the resume route's id. `claude --resume` takes a session name too, so an id such as
 * `deploy`, from a crafted `deploy.jsonl`, could resume some other session (W73, W81).
 */
export function isSessionUuid(sessionId: string): boolean {
  return SESSION_UUID.test(sessionId);
}

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
        state = await firstRead(handle, file, info.size, info.ino, info.dev, initialWindow, maxWindow);
        files.set(sessionId, state);
      } else if (info.size > state.offset) {
        const chunk = await readRange(handle, state.offset, info.size);
        consume(state, chunk);
        state.offset += chunk.length;
      }
      return toInfo(state);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  return {
    async read(sessionId, cwds) {
      try {
        if (!isSafeSessionId(sessionId)) return { transcript: 'missing' };
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
    transcriptFile(sessionId) {
      return isSafeSessionId(sessionId) ? located.get(sessionId) : undefined;
    },
    retain(sessionIds) {
      for (const map of [files, located, missingUntil]) {
        for (const id of map.keys()) if (!sessionIds.has(id)) map.delete(id);
      }
    },
  };
}

/** What readNewestEntries() finds: the fields `read` gives a listed session, and four that ended.ts needs. */
export interface NewestEntries {
  info: TranscriptInfo;
  /** Fields.inBackground. Undefined when no user or assistant entry was read. */
  inBackground?: boolean;
  /** Fields.setName. */
  setName?: string;
  /** Fields.typedPrompt: a typed prompt among the entries read, not necessarily the whole file's. */
  typedPrompt: boolean;
  /** Fields.continuedElsewhere. */
  continuedElsewhere: boolean;
}

/**
 * Reads a transcript's newest entries once, as `read` does the first time it sees a file: the last
 * 256 KiB, or 2 MiB when those lack a field `read` looks for. For the ended-session scanner
 * (ended.ts), whose transcripts belong to sessions that have stopped writing, so there's nothing
 * to read incrementally, and a file is read again only when it changes. Undefined when the file
 * has gone; rejects on any other failure.
 */
export async function readNewestEntries(
  file: string,
  options: Pick<TranscriptReaderOptions, 'initialWindowBytes' | 'maxWindowBytes'> = {},
): Promise<NewestEntries | undefined> {
  const initialWindow = options.initialWindowBytes ?? 256 * KIB;
  const maxWindow = Math.max(options.maxWindowBytes ?? 2 * MIB, initialWindow);
  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch (err) {
    if (isGone(err)) return undefined;
    throw err;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('not a file');
    const state = await firstRead(handle, file, info.size, info.ino, info.dev, initialWindow, maxWindow);
    const { fields } = state;
    const newest: NewestEntries = {
      info: toInfo(state),
      typedPrompt: fields.typedPrompt === true,
      continuedElsewhere: fields.continuedElsewhere === true,
    };
    if (fields.inBackground !== undefined) newest.inBackground = fields.inBackground;
    if (fields.setName !== undefined) newest.setName = fields.setName;
    return newest;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// --- Reading -----------------------------------------------------------------

/** The last `initialWindow` bytes, or `maxWindow` when those lack a field. */
async function firstRead(
  handle: FileHandle,
  file: string,
  size: number,
  ino: number,
  dev: number,
  initialWindow: number,
  maxWindow: number,
): Promise<FileState> {
  let state = await readWindow(handle, file, size, ino, dev, Math.min(size, initialWindow));
  if (size > initialWindow && !isComplete(state.fields)) {
    state = await readWindow(handle, file, size, ino, dev, Math.min(size, maxWindow));
  }
  return state;
}

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
  /** What was worked out from `fields.assistantText`, kept until the text changes. */
  derived?: Derived;
}

interface Derived {
  source: string;
  askedYou: AskedYou | undefined;
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
  /** The newest assistant message's raw text, its text blocks joined, capped at 64 KiB. */
  assistantText?: string;
  userPrompt?: string;
  /** True when a prompt came after the newest assistant text, in file order. */
  promptAfterText?: boolean;
  /** The newest `ai-title` entry's title, in file order. */
  aiTitle?: string;
  /**
   * Whether the newest user or assistant entry, in file order, has `sessionKind: "bg"`: Claude Code
   * marks every entry a session writes while it runs in the background (spike 006, finding 7).
   * Only the ended-session scanner uses it (ended.ts).
   */
  inBackground?: boolean;
  /** The newest name set with `--name`: a `custom-title` entry's title or an `agent-name` entry's name, in file order (ended.ts). */
  setName?: string;
  /** True once a prompt the user typed has been read: `promptSource: "typed"` on a user entry that isn't meta (ended.ts). */
  typedPrompt?: boolean;
  /**
   * True when the newest `continued-in` entry comes after the newest user or assistant entry, in
   * file order: the conversation carried on under another session id, as `/bg` does (ended.ts).
   * The entry's `continuedInSessionId` isn't read.
   */
  continuedElsewhere?: boolean;
  /**
   * True when a `turn_duration` entry comes after the newest entry that runs a turn, in file order:
   * an assistant entry, a prompt or a tool's result, not a sidechain's; false when one of those came
   * after it. Undefined until the first `turn_duration` entry is read (TranscriptInfo.turnEnded).
   */
  turnEnded?: boolean;
  /** The newest prompt's timestamp, in file order (TranscriptInfo.lastPromptMs). */
  lastPromptMs?: number;
  /** The newest `away_summary` with a time, in file order (TranscriptInfo.awaySummary). */
  awaySummary?: AwaySummary;
}

/** Applies one JSONL line. Lines that don't parse, and entry types the index doesn't use, are skipped. */
export function applyLine(fields: Fields, line: string): void {
  // Cheap pre-filter: every entry the index uses names one of these types.
  if (
    !line.includes('"user"') &&
    !line.includes('"assistant"') &&
    !line.includes('"queued_command"') &&
    !line.includes('"ai-title"') &&
    !line.includes('"custom-title"') &&
    !line.includes('"agent-name"') &&
    !line.includes('"continued-in"') &&
    !line.includes('"turn_duration"') &&
    !line.includes('"away_summary"')
  ) {
    return;
  }
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
  if (entry.type === 'attachment') {
    // What arrived mid-turn counts as the user entry it stands for (W99): a prompt typed then is a prompt.
    const queued = queuedEntryOf(entry);
    if (queued !== undefined) applyEntry(fields, queued);
    return;
  }
  const type = entry.type;
  if (type === 'ai-title') {
    // No timestamp, and not activity: Claude Code writes these on its own.
    const title = aiTitleOf(entry);
    if (title !== undefined) fields.aiTitle = title;
    return;
  }
  if (type === 'continued-in') {
    // Not activity: Claude Code writes it after the last turn, when the conversation moves on.
    fields.continuedElsewhere = true;
    return;
  }
  if (type === 'custom-title' || type === 'agent-name') {
    // No timestamp either, and not activity.
    const name = setNameOf(entry);
    if (name !== undefined) fields.setName = name;
    return;
  }
  if (type === 'system') {
    // Claude Code writes it when a turn ends, after the turn's last entry (spike 007, finding 4). Not activity.
    if (turnSignalOf(entry) === 'ended') fields.turnEnded = true;
    // Its own recap, written when you've been away (spike 007, finding 8). Not activity either.
    const away = awaySummaryOf(entry);
    if (away !== undefined) fields.awaySummary = away;
    return;
  }
  if (type !== 'user' && type !== 'assistant') return;

  const ms = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  const at = Number.isFinite(ms) ? ms : undefined;
  if (at !== undefined && (fields.lastActivityMs === undefined || at > fields.lastActivityMs)) {
    fields.lastActivityMs = at;
  }
  fields.inBackground = entry.sessionKind === 'bg';
  // A turn after a `continued-in` means the conversation came back here.
  fields.continuedElsewhere = false;
  const typed = isTypedPrompt(entry);
  if (typed) fields.typedPrompt = true;

  if (type === 'assistant') {
    // A turn is running again, once the transcript has marked one's end. A sidechain's entries are a
    // sub-agent's, which can run on after the main turn has ended.
    if (fields.turnEnded !== undefined && turnSignalOf(entry) === 'running') fields.turnEnded = false;
    const text = assistantTextOf(entry);
    if (text === undefined) return;
    const sameMessage =
      text.id !== undefined && text.id === fields.assistantMessageId && fields.assistantText !== undefined;
    const joined = sameMessage ? `${fields.assistantText}\n${text.text}` : text.text;
    if (!sameMessage) fields.assistantMessageId = text.id;
    fields.assistantText = cap(joined, ASSISTANT_TEXT_KEEP);
    fields.promptAfterText = false;
    return;
  }

  const prompt = userPromptOf(entry);
  if (prompt !== undefined) {
    fields.userPrompt = prompt;
    fields.promptAfterText = true;
  }
  // Only a prompt or a tool's result means a turn is running again. A meta entry, a local command such
  // as /model and its output, or a manual /compact's summary come with no turn and no turn_duration
  // after them, so they leave the last turn's end, and the question it asked, as they were. So does a
  // message or a task notification that arrived ('arrived'): one isn't always followed by a turn, and
  // a question should stay in Needs you until one runs (W102 reads it the other way, turnSignalOf()).
  if (fields.turnEnded !== undefined && turnSignalOf(entry) === 'running') fields.turnEnded = false;
  if ((prompt !== undefined || typed) && at !== undefined && (fields.lastPromptMs === undefined || at > fields.lastPromptMs)) {
    fields.lastPromptMs = at;
  }
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

/**
 * An `away_summary` entry's recap: a `system` entry with `subtype: "away_summary"` and a `content`
 * string, not a sidechain's, with a timestamp that parses. Its content trimmed, at most
 * AWAY_SUMMARY_MAX characters, and its time in ISO 8601. Internal and undocumented, so anything else
 * is ignored. Part of the transcript adapter, for M5's recaps (recapSources.ts reads it too).
 */
export function awaySummaryOf(entry: Record<string, unknown>): AwaySummary | undefined {
  if (entry.type !== 'system' || entry.subtype !== 'away_summary' || entry.isSidechain === true) return undefined;
  if (typeof entry.content !== 'string' || typeof entry.timestamp !== 'string') return undefined;
  const ms = Date.parse(entry.timestamp);
  if (!Number.isFinite(ms)) return undefined;
  const text = cap(entry.content, 4 * AWAY_SUMMARY_MAX).trim();
  if (text === '') return undefined;
  return { text: truncate(text, AWAY_SUMMARY_MAX), at: new Date(ms).toISOString() };
}

/**
 * An `ai-title` entry's title: Claude Code's generated title for the session,
 * set from its first prompt. Internal and undocumented, so anything but a
 * non-empty string is ignored. Whitespace is collapsed to single spaces and
 * the result truncated to 120 characters.
 */
export function aiTitleOf(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.aiTitle !== 'string') return undefined;
  const title = titleText(entry.aiTitle);
  return title === '' ? undefined : title;
}

/**
 * The name a `custom-title` entry's `customTitle` or an `agent-name` entry's `agentName` sets, as
 * `--name` writes them, on one line and at most 120 characters. Claude Code writes the two as a
 * pair and writes them again as the session goes on, so the newest is near the end of the file.
 * Internal and undocumented, so anything but a non-empty string is ignored.
 */
export function setNameOf(entry: Record<string, unknown>): string | undefined {
  const raw = entry.type === 'custom-title' ? entry.customTitle : entry.type === 'agent-name' ? entry.agentName : undefined;
  if (typeof raw !== 'string') return undefined;
  const name = titleText(raw);
  return name === '' ? undefined : name;
}

/**
 * True for a user entry the user typed, by Claude Code's own marker, `promptSource: "typed"`, and
 * not meta. Other sources include `sdk` (`claude -p` and the Agent SDK), `system`, `queued` and
 * `suggestion_accepted`. Internal and undocumented (spike 006, finding 7).
 */
export function isTypedPrompt(entry: Record<string, unknown>): boolean {
  return entry.type === 'user' && entry.promptSource === 'typed' && entry.isMeta !== true;
}

/** A title as the index shows it: on one line, trimmed, at most 120 characters. */
export function titleText(text: string): string {
  // Cap before collapsing, so a huge value isn't scanned in full.
  return truncate(cap(text, 4 * TITLE_MAX).replace(/\s+/g, ' ').trim(), TITLE_MAX);
}

const CROSS_SESSION_PREFIX = 'Another Claude session sent a message:';
/** The tags a message from another session is wrapped in: the older one, and newer versions' (W99). */
const CROSS_SESSION_TAGS = ['cross-session-message', 'agent-message'] as const;

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
 * A user entry's prompt, truncated to USER_PROMPT_MAX characters, or undefined
 * when the entry isn't one the user typed, by promptTextOf()'s rule.
 */
export function userPromptOf(entry: Record<string, unknown>): string | undefined {
  const text = promptTextOf(entry);
  return text === undefined ? undefined : truncate(text, USER_PROMPT_MAX);
}

/**
 * A user entry's prompt, whole and trimmed, or undefined when the entry isn't
 * one the user typed: meta entries (including cross-session messages), compact
 * summaries, sidechains, tool results, entries whose `origin.kind` marks them
 * as from another session or a task notification, and Claude Code's own
 * wrappers. `<system-reminder>` blocks are stripped first. The rule behind
 * lastUserPrompt, and behind the 'prompted' PR links (prLinks.ts, W94). A
 * prompt typed mid-turn is read from the user entry its attachment stands for
 * (queuedEntryOf(), W99).
 */
export function promptTextOf(entry: Record<string, unknown>): string | undefined {
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
  if (text === '' || CROSS_SESSION_TAGS.some((tag) => text.includes(`<${tag}`))) return undefined;
  if (NOT_A_PROMPT_PREFIXES.some((prefix) => text.startsWith(prefix))) return undefined;
  return text;
}

/** The modes of a `queued_command` attachment that stand for a user entry: a prompt, or a task notification. */
const QUEUED_MODES = new Set(['prompt', 'task-notification']);
/** The origins of one that stand for a user entry: a prompt the user typed, a message from a peer, a task notification. */
const QUEUED_KINDS = new Set(['human', 'peer', 'task-notification']);

/**
 * The user entry a `queued_command` attachment stands for, or undefined for any other entry (W99).
 * Claude Code (v2.1.312) writes one, and no user entry, for what arrives while a session is mid-turn:
 * a prompt the user typed meanwhile (`origin.kind: "human"`), a message from another session or a
 * sub-agent's report (`peer`), a task notification (`task-notification`, or no `origin` in older
 * versions) and, in a sub-agent's transcript, a message from the session that started it
 * (`coordinator`, meta). Its `prompt` is the user entry's content, a string or text and image blocks,
 * and its `origin` and `isMeta` are the user entry's, so read as one it becomes what that would: the
 * readers' own rules then say whether it's a prompt, a message or a notice. Only text and image
 * blocks are kept, so it's never a tool's result.
 *
 * The attachment has no `Another Claude session sent a message:` line, the user entry's second sign
 * that a message isn't the user's, so its origin has to say what it is: only `human`, `peer` and
 * `task-notification` are read, and with no origin only `commandMode: "task-notification"`, which then
 * reads as one. Anything else gives undefined: a `coordinator` message, shown in neither form; an
 * origin that isn't a record or is of an unknown kind; a prompt with no origin. `commandMode` is
 * `prompt` or `task-notification`, or absent, as on the coordinator's, peers' and meta prompts in
 * sub-agents' transcripts; another, unseen so far, gives undefined too: a shell command's, say,
 * wouldn't read as typed. Meta on the attachment or on the entry. Internal and undocumented.
 */
export function queuedEntryOf(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const attachment = entry.attachment;
  if (entry.type !== 'attachment' || !isRecord(attachment) || attachment.type !== 'queued_command') return undefined;
  const mode = attachment.commandMode;
  if (mode !== undefined && !(typeof mode === 'string' && QUEUED_MODES.has(mode))) return undefined;
  const origin = attachment.origin;
  if (origin === undefined ? mode !== 'task-notification' : !isRecord(origin) || typeof origin.kind !== 'string' || !QUEUED_KINDS.has(origin.kind)) return undefined;
  const prompt = attachment.prompt;
  const content =
    typeof prompt === 'string' ? prompt : Array.isArray(prompt) ? prompt.filter((block) => isRecord(block) && (block.type === 'text' || block.type === 'image')) : undefined;
  if (content === undefined) return undefined;
  const user: Record<string, unknown> = { type: 'user', message: { role: 'user', content }, origin: origin ?? { kind: 'task-notification' } };
  for (const key of ['timestamp', 'isSidechain', 'sessionKind'] as const) if (entry[key] !== undefined) user[key] = entry[key];
  if (attachment.isMeta === true || entry.isMeta === true) user.isMeta = true;
  return user;
}

/**
 * What an entry says of the session's turn: one rule for W69's turn's end (applyEntry(), for askedYou
 * and End session's turnState) and the conversation page's (ConversationPage.turnEnded, W102). Never
 * for a sidechain's entry, a sub-agent's, which can run on after the main turn has ended.
 * - 'ended': Claude Code's mark that a turn ended, a `system` entry of subtype `turn_duration`
 *   (spike 007, finding 4).
 * - 'running': an entry that runs a turn: any assistant entry, a thinking block's alone included; a
 *   prompt you typed (promptTextOf()), mid-turn ones included (W99); a tool's result.
 * - 'arrived': a message from another session or a sub-agent, or a task notification. Claude Code
 *   starts a turn for most that come between turns (the W102 review: 428 of 438 task notifications
 *   after a turn's end), but not all. The working line reads it as running, since Claude Code's own
 *   status says first whether it works; W69 leaves the turn's end as it was, so a question asked
 *   stays in Needs you, and End session's check reads the session as idle until Claude's first entry,
 *   a few seconds later.
 * Undefined for anything else: a meta entry, a local command and its output, a compaction, a slash
 * command's wrapper, other system entries and attachments.
 */
export type TurnSignal = 'ended' | 'running' | 'arrived';

export function turnSignalOf(entry: Record<string, unknown>): TurnSignal | undefined {
  if (entry.isSidechain === true) return undefined;
  if (entry.type === 'attachment') {
    // What arrived mid-turn, as the user entry it stands for (W99).
    const queued = queuedEntryOf(entry);
    return queued === undefined ? undefined : turnSignalOf(queued);
  }
  if (entry.type === 'system') return entry.subtype === 'turn_duration' ? 'ended' : undefined;
  if (entry.type === 'assistant') return 'running';
  if (entry.type !== 'user') return undefined;
  if (isToolResult(entry) || promptTextOf(entry) !== undefined) return 'running';
  return arrived(entry) ? 'arrived' : undefined;
}

/** The longest text read to tell what arrived: the markers are at its start. */
const ARRIVED_READ_MAX = 4 * 1024;

/** A user entry that's a message from another session or a sub-agent, or a task notification, by its origin or how it starts. */
function arrived(entry: Record<string, unknown>): boolean {
  const origin = isRecord(entry.origin) ? entry.origin.kind : undefined;
  if (origin === 'peer' || origin === 'task-notification') return true;
  const message = entry.message;
  const raw = isRecord(message) ? textOf(message.content) : undefined;
  if (raw === undefined) return false;
  const text = stripSystemReminders(cap(raw, ARRIVED_READ_MAX)).trim();
  return text.startsWith(CROSS_SESSION_PREFIX) || text.startsWith('<task-notification>') || CROSS_SESSION_TAGS.some((tag) => text.startsWith(`<${tag}`));
}

/** A user entry carrying a tool's result, from the main conversation rather than a sub-agent's: part of a running turn. */
function isToolResult(entry: Record<string, unknown>): boolean {
  if (entry.type !== 'user' || entry.isSidechain === true) return false;
  const message = entry.message;
  const content = isRecord(message) ? message.content : undefined;
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'tool_result');
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

const REMINDER_OPEN = '<system-reminder>';
const REMINDER_CLOSE = '</system-reminder>';

/**
 * Removes every `<system-reminder>...</system-reminder>` block. An opening tag
 * with no closing tag after it is left as it is. Done with indexOf rather than
 * `/<system-reminder>[\s\S]*?<\/system-reminder>/g`, which scans to the end
 * of the text from every unclosed tag: quadratic on a prompt full of them.
 */
export function stripSystemReminders(text: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const start = text.indexOf(REMINDER_OPEN, pos);
    if (start === -1) break;
    const end = text.indexOf(REMINDER_CLOSE, start + REMINDER_OPEN.length);
    // No closing tag after this one, so none after any later opening tag either.
    if (end === -1) break;
    out += text.slice(pos, start);
    pos = end + REMINDER_CLOSE.length;
  }
  return pos === 0 ? text : out + text.slice(pos);
}

function isComplete(fields: Fields): boolean {
  return (
    fields.lastActivityMs !== undefined &&
    fields.assistantText !== undefined &&
    fields.userPrompt !== undefined &&
    fields.aiTitle !== undefined
  );
}

function toInfo(state: FileState): TranscriptInfo {
  const { fields } = state;
  const info: TranscriptInfo = { transcript: 'ok' };
  if (fields.lastActivityMs !== undefined) info.lastActivityAt = new Date(fields.lastActivityMs).toISOString();
  if (fields.assistantText !== undefined) {
    const derived = derive(state, fields.assistantText);
    if (derived.askedYou !== undefined && fields.promptAfterText !== true) info.askedYou = derived.askedYou;
  }
  if (fields.userPrompt !== undefined) info.lastUserPrompt = fields.userPrompt;
  if (fields.aiTitle !== undefined) info.aiTitle = fields.aiTitle;
  if (fields.turnEnded !== undefined) info.turnEnded = fields.turnEnded;
  if (fields.lastPromptMs !== undefined) info.lastPromptMs = fields.lastPromptMs;
  if (fields.awaySummary !== undefined) info.awaySummary = { ...fields.awaySummary };
  return info;
}

/** Checks the assistant text once per change, not on every poll. */
function derive(state: FileState, source: string): Derived {
  if (state.derived?.source !== source) {
    state.derived = { source, askedYou: detectAskedYou(source) };
  }
  return state.derived;
}
