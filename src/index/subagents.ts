// Sub-agents (W76): each session's sub-agents, from the `subagents` folder beside its transcript and
// the start and end records in its transcripts. Part of the transcript adapter: the folder, the meta
// files and the transcript entries are internal Claude Code formats, so this fails soft. A file
// that's missing, malformed or unreadable means fewer fields, never an exception.
//
// Where (coordinator, 2026-10-27, from transcript structure):
//   <projects>/<project>/<sessionId>.jsonl                           the session's transcript
//   <projects>/<project>/<sessionId>/subagents/agent-<id>.jsonl      a sub-agent's own transcript
//   <projects>/<project>/<sessionId>/subagents/agent-<id>.meta.json  its description, type, depth and
//                                                                    the tool call that started it
// Only regular files directly in a real `subagents` folder count. The session's folder and the
// `subagents` folder may not be symlinks, a symlink or anything else that isn't a regular file in
// the folder is skipped, and files are opened with O_NOFOLLOW and O_NONBLOCK. An agent id is letters
// and digits only, and a path is only ever built from a name the folder's listing gave.
//
// What says where one is:
// - its start: an `Agent` tool call (`Task` in older versions) whose id is the meta's `toolUseId`, in
//   the session's transcript or, for a nested one, in the transcript of the sub-agent that started
//   it, which is its `startedBy`. Without a meta, the call's result can name it: its
//   `toolUseResult.agentId`, or `agentId: <id>` in its text;
// - its end, in the transcript of whoever started it:
//   - a task notification: `<task-notification>` with `<task-id>`, the agent id, and `<status>`.
//     completed is 'done'; failed or error is 'failed'; killed, stopped, cancelled or aborted is
//     'stopped'; anything else is no end. Read from a user entry's text, a queue-operation's
//     content, or a string in an attachment, each of which must start with the tag, so a tool's
//     output that quotes one isn't taken for one. The newest wins;
//   - for one the session waited for, its call's result: an error is 'failed', or 'stopped' when
//     it's Claude Code's interrupt marker, `[Request interrupted…`; anything else is 'done'. A
//     background one's result comes back at once, so it's no end unless it's an error. It's
//     background by the meta's `requestShape` 'background', the call's `run_in_background`, a
//     result marked async (`toolUseResult.isAsync`, or its `status` 'async_launched'), or a task
//     notification about it; and not background by `requestShape` 'foreground' or
//     `run_in_background: false`. Any other shape leaves it unknown;
//   - an end is no end once the sub-agent's own transcript has entries more than 10 s newer than
//     it, as when SendMessage resumes one that had finished;
// - no end: 'running' while the session's process is alive, else 'unknown'. Not 'running' either
//   when it has no activity since the session's current process started: its newest entry, its
//   files' mtimes and its call. The process's start is the OS's (`ps -o etime=`, once per pid);
//   without it, the later of the session's startedAt and the poll that last saw the old process
//   when pitwall saw it change (a new pid, or alive again after it wasn't). Those died with the old
//   process. And one with no start record, an Agent call, counts only with activity in the last
//   10 minutes, so a stray meta file or transcript doesn't count for the whole session.
//
// Cost. The poll never waits on it. The index calls track() with the sessions it lists, which queues
// a scan of each one whose process is alive, and reads running() synchronously. A scan lists the
// folder, reads the meta files that changed, and reads what was appended to each transcript since
// the last scan, a chunk at a time, yielding to the event loop between chunks, with one file system
// call at a time. The first scan of a session reads its transcripts in full; later ones stat them and
// read only what's new. In the session's transcript, only lines that name an Agent call, a result of
// one, or a task notification are parsed; in a sub-agent's, also its tool calls, its first line, and
// the last lines of each chunk read until one has a time, for its first and newest times. A session
// whose process isn't alive is scanned only when its list is asked for. One that's no longer listed
// is forgotten.
//
// Memory, never on disk, because descriptions and ids are session content: per transcript, its
// inode, offset and what its lines said (the Agent calls, their results and the task notifications,
// at most 10,000 of each, and for a sub-agent's, its first and newest times and its tool-call
// count); per meta file, its fields.

import { constants } from 'node:fs';
import { lstat, open, readdir, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { SUBAGENTS_MAX, type SubagentList, type SubagentState, type SubagentSummary } from '../shared/protocol.js';
import { runFile, type RunFile } from './exec.js';
import { isRecord } from './guards.js';
import { cap, plainLine, tail } from './text.js';
import { stripSystemReminders } from './transcripts.js';

/** The longest description kept, as SubagentSummary.description says. */
export const SUBAGENT_DESCRIPTION_MAX = 200;
/** A sub-agent's description when it has none. */
export const DEFAULT_SUBAGENT_DESCRIPTION = 'Sub-agent';
/** The longest type kept, such as `general-purpose`. */
export const AGENT_TYPE_MAX = 100;
/** A bigger meta file is ignored: Claude Code's are a few hundred bytes. */
export const META_MAX_BYTES = 64 * 1024;
/** The most sub-agents read from one session's folder. The busiest session in Phil's week had 72. */
export const SUBAGENTS_LISTED_MAX = 5000;
/** The most of each kind of record kept per transcript; past it, the oldest go. */
const FACTS_MAX = 10_000;
/** A line up to this long in a sub-agent's transcript is parsed for its time alone. */
const TIME_LINE_MAX = 1 << 20;
/** How many of a chunk's last lines are kept to read the newest time from. */
const TAIL_LINES = 4;
/** Activity this close before the process's start is taken as after it: `ps` counts whole seconds. */
const PROCESS_SLACK_MS = 2000;
/** Entries in a sub-agent's own transcript more than this newer than its end mean it was resumed. */
export const RESUMED_AFTER_MS = 10_000;
/** A sub-agent with no Agent call on record counts as running only with activity this recent. */
export const UNSTARTED_ACTIVE_MS = 10 * 60_000;
/** How long `ps` may take, and how many run at once. */
const PS_TIMEOUT_MS = 2000;
const PS_CONCURRENCY = 2;
/** A meta file changed this recently is read again whatever its size and mtime say. */
const META_SETTLE_MS = 2000;
/**
 * How often a background scan checks again the meta files it has read and the transcripts of the
 * sub-agents that have ended, which seldom change. Every other scan checks only the folder, new
 * meta files, and the transcripts of the session and of the sub-agents with no end. A list asked
 * for checks everything.
 */
export const SUBAGENT_RECHECK_MS = 30_000;

const AGENT_ID = /^[A-Za-z0-9]{1,64}$/;
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LISTED_NAME = /^agent-([A-Za-z0-9]{1,64})\.(jsonl|meta\.json)$/;
const AGENT_TOOLS = new Set(['Agent', 'Task']);
/** Read-only, without following a symlink at the file, and without waiting on a FIFO's writer. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const FOLLOW_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

const MARK_AGENT = Buffer.from('"name":"Agent"');
const MARK_TASK = Buffer.from('"name":"Task"');
const MARK_TOOL_USE = Buffer.from('"type":"tool_use"');
const MARK_RESULT = Buffer.from('"tool_use_id":"');
const MARK_NOTICE = Buffer.from('<task-notification>');
const NOTICE_OPEN = '<task-notification>';
const NOTICE_CLOSE = '</task-notification>';
const NEWLINE = 0x0a;
const QUOTE = 0x22;

type EndState = Exclude<SubagentState, 'running' | 'unknown'>;

const END_STATES: Readonly<Record<string, EndState>> = {
  completed: 'done',
  failed: 'failed',
  error: 'failed',
  killed: 'stopped',
  stopped: 'stopped',
  cancelled: 'stopped',
  canceled: 'stopped',
  aborted: 'stopped',
};

/** True for an agent id pitwall uses: letters and digits only, at most 64. */
export function isSafeAgentId(agentId: string): boolean {
  return AGENT_ID.test(agentId);
}

/** A sub-agent's description as the contract has it: plain text on one line, at most 200 characters. Undefined when there's none. */
export function descriptionText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = plainLine(raw, SUBAGENT_DESCRIPTION_MAX);
  return text === '' ? undefined : text;
}

function typeText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = plainLine(raw, AGENT_TYPE_MAX);
  return text === '' ? undefined : text;
}

/** A session the index lists, as the tracker needs it. */
export interface TrackedSubagentSession {
  sessionId: string;
  /** Its transcript, from the transcript reader or the ended scanner. Undefined when there's none. */
  file: string | undefined;
  /** SessionSummary.alive. */
  alive: boolean;
  /** SessionSummary.pid, to notice a new process. */
  pid?: number;
  /** ISO 8601: SessionSummary.startedAt. */
  startedAt?: string;
}

/** What the conversation reader labels its entries with (ConversationEntry.subagent). */
export interface SubagentLabels {
  /** Each of the session's sub-agents, by agent id: its description. */
  descriptions: ReadonlyMap<string, string>;
  /** The agent id an Agent call started, by the call's tool_use id. */
  started: ReadonlyMap<string, string>;
}

export interface SubagentTracker {
  /**
   * The sessions in the latest poll: queues a scan of each one whose process is alive, notes a
   * session's new process, and forgets every session not listed. Returns at once; never throws.
   */
  track(sessions: readonly TrackedSubagentSession[]): void;
  /** How many of the session's sub-agents are 'running', as of its last scan: 0 while its process isn't alive, and before its first scan. */
  running(sessionId: string): number;
  /** The session's SubagentList, after scanning what's new. Undefined for a session not tracked with a transcript. Never rejects. */
  list(sessionId: string): Promise<SubagentList | undefined>;
  /** The labels for the session's conversation: its folder listed and its meta files read afresh, its transcripts as last scanned. Never rejects. */
  labels(sessionId: string): Promise<SubagentLabels | undefined>;
  /**
   * Whether the agent is one of the session's sub-agents, from a fresh listing of its folder: its
   * transcript, with `file` undefined when it has only a meta file so far, or undefined when it
   * isn't one, or its id isn't safe. Never rejects.
   */
  transcript(sessionId: string, agentId: string): Promise<{ file?: string } | undefined>;
  /** Called after a scan that changed a session's running count since the index last read it. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Resolves once nothing is queued or running. For tests and the benchmark. */
  settled(): Promise<void>;
  stats(): SubagentTrackerStats;
  stop(): void;
}

export interface SubagentTrackerStats {
  /** Transcript bytes read. */
  bytesRead: number;
  /** Lines parsed as JSON. */
  linesParsed: number;
  /** Session scans that finished. */
  scans: number;
}

export interface SubagentTrackerOptions {
  /** Milliseconds since the epoch. Default Date.now. */
  now?: () => number;
  /** When a process started, in milliseconds since the epoch, or undefined. Default processStartTime(), which runs `ps`. */
  processStartMs?: (pid: number) => Promise<number | undefined>;
  /** Bytes read at a time. Default 1 MiB. */
  chunkBytes?: number;
  /** A line longer than this is skipped. Default 16 MiB. */
  maxLineBytes?: number;
}

interface Call {
  atMs?: number;
  description?: string;
  agentType?: string;
  background?: boolean;
}

interface Result {
  error: boolean;
  /** An error that's Claude Code's interrupt marker. */
  interrupted?: boolean;
  atMs?: number;
  /** Marked as a background launch. */
  async?: boolean;
  /** The agent it names. */
  agentId?: string;
}

interface Notice {
  state: EndState;
  atMs?: number;
}

/** What one transcript's lines said. */
interface Facts {
  /** Agent calls, by tool_use id. */
  calls: Map<string, Call>;
  /** Those calls' results, by tool_use id. */
  results: Map<string, Result>;
  /** Task notifications, by task id: the newest in file order. */
  notices: Map<string, Notice>;
  /** A sub-agent's transcript: its first and newest entries' times, and its tool calls. */
  firstMs?: number;
  lastMs?: number;
  toolCalls: number;
}

interface FileState {
  /** The agent whose transcript it is; undefined for the session's own. */
  owner: string | undefined;
  dev: number;
  ino: number;
  /** As of the last scan. */
  mtimeMs: number;
  /** Bytes read so far, including the carry. */
  offset: number;
  /** The bytes after the last newline read: the start of a line a later read finishes. */
  carry: Buffer[];
  carryBytes: number;
  /** Drop everything up to the next newline: a line too long to keep. */
  skip: boolean;
  facts: Facts;
}

interface Meta {
  description?: string;
  agentType?: string;
  toolUseId?: string;
  background?: boolean;
}

interface MetaState {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  meta: Meta;
}

/** One agent in the folder: the names of its files there. */
interface Listed {
  transcript?: string;
  meta?: string;
}

/** A sub-agent as of the last scan, before its state is decided by whether the session's process is alive. */
interface Row {
  summary: Omit<SubagentSummary, 'state'>;
  end?: EndState;
  /** Its Agent call is on record. */
  started: boolean;
  /** Its newest sign of life: its newest entry, its files' mtimes, its call. */
  activityMs?: number;
  /** For the order: its transcript's first entry, else its call's time. */
  sortMs?: number;
}

interface SessionState {
  main: string;
  sessionDir: string;
  folder: string;
  alive: boolean;
  pid: number | undefined;
  startedAtMs: number | undefined;
  /** Sub-agents started before this belonged to an earlier process (see the top of the file). */
  restartMs: number | undefined;
  /** When track() last saw it. */
  trackedMs: number | undefined;
  /** The pid whose start is being or was looked up, the lookup, and what it found. */
  startPid: number | undefined;
  startLookup: Promise<void> | undefined;
  processStartMs: number | undefined;
  /** When a scan that checked everything last started. */
  checkedMs: number | undefined;
  files: Map<string, FileState>;
  metas: Map<string, MetaState>;
  listing: Map<string, Listed>;
  rows: Row[];
  scanning: Promise<void> | undefined;
  scanned: boolean;
  /** The running count the index last read. */
  told: number;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createSubagentTracker(options: SubagentTrackerOptions = {}): SubagentTracker {
  const now = options.now ?? Date.now;
  const lookupStart = limited(options.processStartMs ?? ((pid: number) => processStartTime(pid)), PS_CONCURRENCY);
  const chunkBytes = Math.max(1, options.chunkBytes ?? 1 << 20);
  const maxLineBytes = options.maxLineBytes ?? 16 << 20;

  const counters: SubagentTrackerStats = { bytesRead: 0, linesParsed: 0, scans: 0 };
  const sessions = new Map<string, SessionState>();
  const listeners = new Set<() => void>();
  // Sessions with a finished scan go first: their updates are small.
  const again: string[] = [];
  const fresh: string[] = [];
  const queued = new Set<string>();
  let worker: Promise<void> | undefined;
  let stopped = false;

  // --- The folder and its meta files -------------------------------------------------------------

  async function listFolder(state: SessionState): Promise<Map<string, Listed>> {
    const listing = new Map<string, Listed>();
    try {
      // lstat: a symlink at either is no folder, so nothing outside is read through it.
      if (!(await lstat(state.sessionDir)).isDirectory()) return listing;
      if (!(await lstat(state.folder)).isDirectory()) return listing;
      for (const entry of await readdir(state.folder, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const match = LISTED_NAME.exec(entry.name);
        const agentId = match?.[1];
        if (match === null || agentId === undefined) continue;
        let listed = listing.get(agentId);
        if (listed === undefined) {
          if (listing.size >= SUBAGENTS_LISTED_MAX) continue;
          listing.set(agentId, (listed = {}));
        }
        if (match[2] === 'jsonl') listed.transcript = entry.name;
        else listed.meta = entry.name;
      }
    } catch {
      // No folder, or it can't be read: no sub-agents.
    }
    return listing;
  }

  /** Reads the listing's meta files that changed, or with `onlyNew`, those not read before. */
  async function readMetas(state: SessionState, listing: ReadonlyMap<string, Listed>, onlyNew: boolean): Promise<void> {
    for (const [agentId, listed] of listing) {
      if (listed.meta === undefined || (onlyNew && state.metas.has(agentId))) continue;
      const file = path.join(state.folder, listed.meta);
      try {
        const info = await lstat(file);
        if (!info.isFile()) {
          state.metas.delete(agentId);
          continue;
        }
        const cached = state.metas.get(agentId);
        const unchanged =
          cached !== undefined &&
          cached.dev === info.dev &&
          cached.ino === info.ino &&
          cached.size === info.size &&
          cached.mtimeMs === info.mtimeMs &&
          now() - info.mtimeMs > META_SETTLE_MS;
        if (unchanged) continue;
        state.metas.set(agentId, { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, meta: await readMeta(file) });
      } catch {
        state.metas.delete(agentId);
      }
    }
  }

  // --- Reading transcripts -----------------------------------------------------------------------

  /** Reads what's new in one transcript: from 0 the first time, or when it shrank or was replaced. A file that can't be read is forgotten, to be read afresh. */
  async function scanFile(state: SessionState, file: string, owner: string | undefined, current: () => boolean): Promise<void> {
    let handle: FileHandle | undefined;
    // The session's own transcript is where the transcript reader found it; a sub-agent's is never followed out of the folder.
    const follow = owner === undefined;
    try {
      const info = follow ? await stat(file) : await lstat(file);
      const known = state.files.get(file);
      if (!info.isFile()) {
        state.files.delete(file);
        return;
      }
      if (known !== undefined && known.dev === info.dev && known.ino === info.ino && known.offset === info.size) {
        known.mtimeMs = info.mtimeMs;
        return;
      }
      handle = await open(file, follow ? FOLLOW_FLAGS : OPEN_FLAGS);
      const opened = await handle.stat();
      if (!opened.isFile()) {
        state.files.delete(file);
        return;
      }
      let target = known;
      if (target === undefined || target.dev !== opened.dev || target.ino !== opened.ino || opened.size < target.offset) {
        target = { owner, dev: opened.dev, ino: opened.ino, mtimeMs: opened.mtimeMs, offset: 0, carry: [], carryBytes: 0, skip: false, facts: emptyFacts() };
        state.files.set(file, target);
      }
      target.mtimeMs = opened.mtimeMs;
      const end = opened.size;
      if (target.offset >= end) return;
      const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, end - target.offset));
      while (target.offset < end) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - target.offset), target.offset);
        if (bytesRead === 0) break;
        counters.bytesRead += bytesRead;
        target.offset += bytesRead;
        consume(target, buffer.subarray(0, bytesRead));
        await yieldToLoop();
        if (!current()) return;
      }
    } catch {
      state.files.delete(file);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /**
   * Splits a chunk into lines, finishing the carried one first, and takes each complete one. In a
   * sub-agent's transcript, its newest time then comes from the chunk's last lines that weren't
   * parsed, newest first, until one has a time.
   */
  function consume(file: FileState, chunk: Buffer): void {
    const unparsed: Buffer[] = [];
    const take = (line: Buffer) => {
      if (takeLine(file, line)) unparsed.length = 0;
      else if (file.owner !== undefined) {
        unparsed.push(line);
        if (unparsed.length > TAIL_LINES) unparsed.shift();
      }
    };
    let newline = chunk.indexOf(NEWLINE);
    if (newline === -1) {
      carry(file, chunk);
      return;
    }
    if (file.skip) file.skip = false;
    else take(file.carryBytes > 0 ? Buffer.concat([...file.carry, chunk.subarray(0, newline)]) : chunk.subarray(0, newline));
    file.carry = [];
    file.carryBytes = 0;
    let pos = newline + 1;
    for (newline = chunk.indexOf(NEWLINE, pos); newline !== -1; newline = chunk.indexOf(NEWLINE, pos)) {
      take(chunk.subarray(pos, newline));
      pos = newline + 1;
    }
    // Before the carry: these are views of the chunk, which is read into again.
    for (let i = unparsed.length - 1; i >= 0; i--) if (timeOfLine(file, unparsed[i] as Buffer)) break;
    if (pos < chunk.length) carry(file, chunk.subarray(pos));
  }

  function carry(file: FileState, bytes: Buffer): void {
    if (file.skip) return;
    if (file.carryBytes + bytes.length > maxLineBytes) {
      file.carry = [];
      file.carryBytes = 0;
      file.skip = true;
      return;
    }
    // A copy: the chunk's buffer is read into again.
    file.carry.push(Buffer.from(bytes));
    file.carryBytes += bytes.length;
  }

  /**
   * One line, parsed only when it names something kept, or, in a sub-agent's transcript, when its
   * first time is still to be found. True when it gave a sub-agent's transcript a time.
   */
  function takeLine(file: FileState, line: Buffer): boolean {
    const sub = file.owner !== undefined;
    const calls = line.indexOf(MARK_AGENT) !== -1 || line.indexOf(MARK_TASK) !== -1 || (sub && line.indexOf(MARK_TOOL_USE) !== -1);
    const results = file.facts.calls.size > 0 && namesKnownCall(file.facts, line);
    const notices = line.indexOf(MARK_NOTICE) !== -1;
    const first = sub && file.facts.firstMs === undefined && line.length <= TIME_LINE_MAX;
    if (!calls && !results && !notices && !first) return false;
    const entry = parse(line);
    if (entry === undefined) return false;
    const atMs = timeOf(entry);
    if (calls) takeCalls(file, entry, atMs);
    if (results) takeResults(file.facts, entry, atMs);
    if (notices) takeNotices(file.facts, entry, atMs);
    return noteTime(file, atMs);
  }

  /** A line of a sub-agent's transcript read for its time alone. True when it had one. */
  function timeOfLine(file: FileState, line: Buffer): boolean {
    if (line.length > TIME_LINE_MAX) return false;
    const entry = parse(line);
    return entry !== undefined && noteTime(file, timeOf(entry));
  }

  function parse(line: Buffer): Record<string, unknown> | undefined {
    try {
      const entry: unknown = JSON.parse(line.toString('utf8'));
      counters.linesParsed++;
      return isRecord(entry) ? entry : undefined;
    } catch {
      return undefined;
    }
  }

  /** A sub-agent's transcript's first and newest times. */
  function noteTime(file: FileState, atMs: number | undefined): boolean {
    if (file.owner === undefined || atMs === undefined) return false;
    const { facts } = file;
    if (facts.firstMs === undefined) facts.firstMs = atMs;
    if (facts.lastMs === undefined || atMs > facts.lastMs) facts.lastMs = atMs;
    return true;
  }

  // --- The session's process ---------------------------------------------------------------------

  /**
   * Looks up when the session's process started, once per pid: from a scan that found sub-agents,
   * so a session with none never runs `ps`. The scan waits for it before it decides anything.
   */
  function lookUpStart(state: SessionState, pid: number | undefined): void {
    if (pid === state.startPid) return;
    state.startPid = pid;
    state.processStartMs = undefined;
    if (pid === undefined) {
      state.startLookup = undefined;
      return;
    }
    const lookup: Promise<void> = lookupStart(pid)
      .then(
        (startMs) => {
          if (state.startPid === pid && typeof startMs === 'number' && Number.isFinite(startMs)) state.processStartMs = startMs;
        },
        () => undefined,
      )
      .finally(() => {
        if (state.startLookup === lookup) state.startLookup = undefined;
      });
    state.startLookup = lookup;
  }

  /** Not 'running' unless it shows activity since the session's current process started, and, with no start on record, lately. */
  function isRunning(row: Row, state: SessionState): boolean {
    if (row.end !== undefined || !state.alive) return false;
    if (!row.started && (row.activityMs === undefined || row.activityMs < now() - UNSTARTED_ACTIVE_MS)) return false;
    const since = state.processStartMs ?? Math.max(state.startedAtMs ?? -Infinity, state.restartMs ?? -Infinity);
    return row.activityMs === undefined || row.activityMs >= since - PROCESS_SLACK_MS;
  }

  // --- Scans and the queue -----------------------------------------------------------------------

  /** A scan; with `full` false, it leaves out what SUBAGENT_RECHECK_MS says can wait. */
  async function doScan(sessionId: string, state: SessionState, full: boolean): Promise<void> {
    const current = () => !stopped && sessions.get(sessionId) === state;
    const startedMs = now();
    const ended = new Set(full ? [] : state.rows.flatMap((row) => (row.end === undefined ? [] : [row.summary.agentId])));
    const listing = await listFolder(state);
    if (!current()) return;
    state.listing = listing;
    for (const agentId of state.metas.keys()) if (listing.get(agentId)?.meta === undefined) state.metas.delete(agentId);
    const transcripts = new Map<string, string | undefined>([[state.main, undefined]]);
    for (const [agentId, listed] of listing) if (listed.transcript !== undefined) transcripts.set(path.join(state.folder, listed.transcript), agentId);
    for (const file of state.files.keys()) if (!transcripts.has(file)) state.files.delete(file);
    await readMetas(state, listing, !full);
    for (const [file, owner] of transcripts) {
      if (!current()) return;
      if (owner !== undefined && ended.has(owner) && state.files.has(file)) continue;
      await scanFile(state, file, owner, current);
    }
    if (listing.size > 0) lookUpStart(state, state.alive ? state.pid : undefined);
    if (state.startLookup !== undefined) await state.startLookup;
    if (!current()) return;
    state.rows = rowsOf(state);
    state.scanned = true;
    if (full) state.checkedMs = startedMs;
    counters.scans++;
  }

  /** One scan of the session at a time: a second caller shares the one running. */
  function scanOf(sessionId: string, state: SessionState, full: boolean): Promise<void> {
    state.scanning ??= doScan(sessionId, state, full)
      .catch(() => {
        // Only a bug gets here: read everything afresh next time.
        state.files.clear();
        state.metas.clear();
      })
      .finally(() => {
        state.scanning = undefined;
      });
    return state.scanning;
  }

  /** A scan that checks everything and starts after this call, so it sees what was written before it. */
  async function scanFresh(sessionId: string, state: SessionState): Promise<void> {
    if (state.scanning !== undefined) await state.scanning;
    await scanOf(sessionId, state, true);
  }

  function runningOf(state: SessionState): number {
    let count = 0;
    for (const row of state.rows) if (isRunning(row, state)) count++;
    return count;
  }

  /** Tells the subscribers when the running count differs from what the index last read. */
  function report(state: SessionState): void {
    if (runningOf(state) === state.told) return;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A listener can't break a scan.
      }
    }
  }

  function kick(): void {
    if (worker !== undefined || stopped) return;
    worker = (async () => {
      for (;;) {
        if (stopped) break;
        const id = again.shift() ?? fresh.shift();
        if (id === undefined) break;
        queued.delete(id);
        const state = sessions.get(id);
        if (state === undefined || !state.alive) continue;
        await scanOf(id, state, state.checkedMs === undefined || now() - state.checkedMs >= SUBAGENT_RECHECK_MS);
        if (sessions.get(id) === state) report(state);
      }
    })().finally(() => {
      worker = undefined;
      if (!stopped && (again.length > 0 || fresh.length > 0)) kick();
    });
  }

  return {
    track(list) {
      if (stopped) return;
      try {
        const nowMs = now();
        const listed = new Set<string>();
        for (const session of list) {
          listed.add(session.sessionId);
          if (session.file === undefined) {
            sessions.delete(session.sessionId);
            continue;
          }
          let state = sessions.get(session.sessionId);
          if (state === undefined || state.main !== session.file) {
            state = newSession(session.file);
            sessions.set(session.sessionId, state);
          }
          // A new process: the sub-agents started before the poll that last saw the old one died with it.
          const newProcess =
            state.trackedMs !== undefined &&
            ((session.alive && !state.alive) || (session.pid !== undefined && state.pid !== undefined && session.pid !== state.pid));
          if (newProcess) state.restartMs = state.trackedMs;
          state.alive = session.alive;
          state.pid = session.pid;
          // Another process, or none: its start is looked up again by the next scan.
          if (state.startPid !== undefined && state.startPid !== (session.alive ? session.pid : undefined)) lookUpStart(state, undefined);
          const startedMs = session.startedAt === undefined ? NaN : Date.parse(session.startedAt);
          state.startedAtMs = Number.isFinite(startedMs) ? startedMs : undefined;
          state.trackedMs = nowMs;
          if (!session.alive || queued.has(session.sessionId)) continue;
          queued.add(session.sessionId);
          (state.scanned ? again : fresh).push(session.sessionId);
        }
        for (const id of sessions.keys()) if (!listed.has(id)) sessions.delete(id);
        kick();
      } catch {
        // Never fails a poll.
      }
    },
    running(sessionId) {
      const state = sessions.get(sessionId);
      if (state === undefined) return 0;
      state.told = runningOf(state);
      return state.told;
    },
    async list(sessionId) {
      try {
        const state = sessions.get(sessionId);
        if (state === undefined) return undefined;
        await scanFresh(sessionId, state);
        if (sessions.get(sessionId) === state) report(state);
        return listOf(sessionId, state, isRunning);
      } catch {
        return undefined;
      }
    },
    async labels(sessionId) {
      try {
        const state = sessions.get(sessionId);
        if (state === undefined) return undefined;
        const listing = await listFolder(state);
        await readMetas(state, listing, true);
        return labelsOf(state, listing);
      } catch {
        return undefined;
      }
    },
    async transcript(sessionId, agentId) {
      try {
        if (!isSafeAgentId(agentId)) return undefined;
        const state = sessions.get(sessionId);
        if (state === undefined) return undefined;
        const listed = (await listFolder(state)).get(agentId);
        if (listed === undefined) return undefined;
        // Built from the listing's own name, which matched the agent id.
        return listed.transcript === undefined ? {} : { file: path.join(state.folder, listed.transcript) };
      } catch {
        return undefined;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async settled() {
      while (worker !== undefined) await worker;
    },
    stats: () => ({ ...counters }),
    stop() {
      stopped = true;
      again.length = 0;
      fresh.length = 0;
      queued.clear();
      sessions.clear();
      listeners.clear();
    },
  };
}

/**
 * When a process started, in milliseconds since the epoch, from `ps -o etime= -p <pid>`, the time
 * since it started, to the second ([[dd-]hh:]mm:ss on macOS and Linux). Undefined when there's no
 * such process, or `ps` fails or says something else. Never rejects.
 */
export async function processStartTime(pid: number, run: RunFile = runFile, now: () => number = Date.now): Promise<number | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const out = await run('ps', ['-o', 'etime=', '-p', String(pid)], { timeoutMs: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' }, maxStdoutBytes: 1024 });
    const match = /^\s*(?:(\d{1,5})-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$/.exec(out);
    if (match === null) return undefined;
    const [, days, hours, minutes, seconds] = match;
    const elapsed = ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
    return now() - elapsed * 1000;
  } catch {
    return undefined;
  }
}

function newSession(main: string): SessionState {
  const sessionDir = path.join(path.dirname(main), path.basename(main, '.jsonl'));
  return {
    main,
    sessionDir,
    folder: path.join(sessionDir, 'subagents'),
    alive: false,
    pid: undefined,
    startedAtMs: undefined,
    restartMs: undefined,
    trackedMs: undefined,
    startPid: undefined,
    startLookup: undefined,
    processStartMs: undefined,
    checkedMs: undefined,
    files: new Map(),
    metas: new Map(),
    listing: new Map(),
    rows: [],
    scanning: undefined,
    scanned: false,
    told: 0,
  };
}

function emptyFacts(): Facts {
  return { calls: new Map(), results: new Map(), notices: new Map(), toolCalls: 0 };
}

/** `fn`, with at most `max` calls running at once, the rest waiting their turn in order. */
function limited<A, R>(fn: (arg: A) => Promise<R>, max: number): (arg: A) => Promise<R> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (arg) => {
    // A finishing call hands its place straight to the next one.
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn(arg);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** Sets a record, dropping the oldest once there are FACTS_MAX. */
function put<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  if (map.size >= FACTS_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function timeOf(entry: Record<string, unknown>): number | undefined {
  if (typeof entry.timestamp !== 'string') return undefined;
  const ms = Date.parse(entry.timestamp);
  return Number.isFinite(ms) ? ms : undefined;
}

/** True when the line names, as a tool result's id, an Agent call this transcript made. Only then is it parsed. */
function namesKnownCall(facts: Facts, line: Buffer): boolean {
  for (let at = line.indexOf(MARK_RESULT); at !== -1; at = line.indexOf(MARK_RESULT, at + MARK_RESULT.length)) {
    const start = at + MARK_RESULT.length;
    const end = line.indexOf(QUOTE, start);
    if (end === -1 || end - start > 128) continue;
    if (facts.calls.has(line.toString('latin1', start, end))) return true;
  }
  return false;
}

/** An assistant entry's tool calls: each one counts in a sub-agent's transcript, and an Agent call is kept, wherever it is. */
function takeCalls(file: FileState, entry: Record<string, unknown>, atMs: number | undefined): void {
  if (entry.type !== 'assistant' || !isRecord(entry.message)) return;
  const content = entry.message.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_use') continue;
    if (file.owner !== undefined) file.facts.toolCalls++;
    if (typeof block.name !== 'string' || !AGENT_TOOLS.has(block.name)) continue;
    if (typeof block.id !== 'string' || !TOOL_USE_ID.test(block.id)) continue;
    const input = isRecord(block.input) ? block.input : {};
    const call: Call = {};
    if (atMs !== undefined) call.atMs = atMs;
    const description = descriptionText(input.description);
    if (description !== undefined) call.description = description;
    const agentType = typeText(input.subagent_type);
    if (agentType !== undefined) call.agentType = agentType;
    if (typeof input.run_in_background === 'boolean') call.background = input.run_in_background;
    put(file.facts.calls, block.id, call);
  }
}

const AGENT_ID_IN_TEXT = /\bagentId:\s*([A-Za-z0-9]{1,64})\b/;

/** Claude Code's text for a tool call the user interrupted. */
const INTERRUPTED = '[Request interrupted';

/** A user entry's results for this transcript's Agent calls: whether each was an error, an interrupt, marked as a background launch, and the agent it names. */
function takeResults(facts: Facts, entry: Record<string, unknown>, atMs: number | undefined): void {
  if (entry.type !== 'user' || !isRecord(entry.message)) return;
  const content = entry.message.content;
  if (!Array.isArray(content)) return;
  const blocks = content.filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'tool_result');
  for (const block of blocks) {
    const id = block.tool_use_id;
    if (typeof id !== 'string' || !facts.calls.has(id)) continue;
    const result: Result = { error: block.is_error === true };
    if (atMs !== undefined) result.atMs = atMs;
    if (result.error) {
      const text = textOf(block.content) ?? (typeof entry.toolUseResult === 'string' ? entry.toolUseResult : undefined);
      const said = text === undefined ? '' : cap(text, 256).trim().replace(/^Error:\s*/, '');
      if (said.startsWith(INTERRUPTED)) result.interrupted = true;
    }
    // The line's toolUseResult is its one result's.
    const about = blocks.length === 1 ? entry.toolUseResult : undefined;
    if (isRecord(about)) {
      if (about.isAsync === true || about.status === 'async_launched') result.async = true;
      if (typeof about.agentId === 'string' && AGENT_ID.test(about.agentId)) result.agentId = about.agentId;
    }
    if (result.agentId === undefined) {
      const text = textOf(block.content);
      // At the start of a background launch's text, at the end of a finished one's report.
      const named = text === undefined ? undefined : (AGENT_ID_IN_TEXT.exec(cap(text, 2048)) ?? AGENT_ID_IN_TEXT.exec(tail(text, 2048)));
      if (named?.[1] !== undefined) result.agentId = named[1];
    }
    put(facts.results, id, result);
  }
}

/** The task notifications in an entry Claude Code writes them in, each a text that starts with the tag. */
function takeNotices(facts: Facts, entry: Record<string, unknown>, atMs: number | undefined): void {
  const texts: string[] = [];
  if (entry.type === 'user' && isRecord(entry.message)) {
    const text = textOf(entry.message.content);
    if (text !== undefined) texts.push(stripSystemReminders(text));
  } else if (entry.type === 'queue-operation') {
    if (typeof entry.content === 'string') texts.push(entry.content);
  } else if (entry.type === 'attachment') {
    stringsIn(entry.attachment, texts, 3);
  }
  for (const text of texts) {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith(NOTICE_OPEN)) continue;
    for (let at = 0; at !== -1 && at < trimmed.length; ) {
      const open = trimmed.indexOf(NOTICE_OPEN, at);
      if (open === -1) break;
      const close = trimmed.indexOf(NOTICE_CLOSE, open);
      const body = trimmed.slice(open + NOTICE_OPEN.length, close === -1 ? undefined : close);
      at = close === -1 ? -1 : close + NOTICE_CLOSE.length;
      const taskId = innerText(body, 'task-id');
      const state = END_STATES[innerText(body, 'status').toLowerCase()];
      if (state === undefined || !AGENT_ID.test(taskId)) continue;
      const notice: Notice = { state };
      if (atMs !== undefined) notice.atMs = atMs;
      put(facts.notices, taskId, notice);
    }
  }
}

/** The strings in a value, at most `depth` levels down and at most 32 of them. */
function stringsIn(value: unknown, out: string[], depth: number): void {
  if (out.length >= 32) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (depth <= 0 || typeof value !== 'object' || value === null) return;
  for (const item of Array.isArray(value) ? value : Object.values(value)) stringsIn(item, out, depth - 1);
}

/** What's between `<tag>` and `</tag>`, trimmed. Empty when there's no `<tag>`. */
function innerText(text: string, tag: string): string {
  const open = `<${tag}>`;
  const start = text.indexOf(open);
  if (start === -1) return '';
  const from = start + open.length;
  const end = text.indexOf(`</${tag}>`, from);
  return cap(end === -1 ? text.slice(from) : text.slice(from, end), 256).trim();
}

/** A string content, or the text blocks of an array content joined with newlines. Tool results' content isn't read. */
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** A meta file's fields, each checked. Anything that can't be read is no fields, never an error. */
async function readMeta(file: string): Promise<Meta> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, OPEN_FLAGS);
    const info = await handle.stat();
    if (!info.isFile() || info.size > META_MAX_BYTES) return {};
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const parsed: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead));
    if (!isRecord(parsed)) return {};
    const meta: Meta = {};
    const description = descriptionText(parsed.description);
    if (description !== undefined) meta.description = description;
    const agentType = typeText(parsed.agentType);
    if (agentType !== undefined) meta.agentType = agentType;
    if (typeof parsed.toolUseId === 'string' && TOOL_USE_ID.test(parsed.toolUseId)) meta.toolUseId = parsed.toolUseId;
    // Only the shapes known for each: any other leaves it unknown.
    if (parsed.requestShape === 'background') meta.background = true;
    else if (parsed.requestShape === 'foreground') meta.background = false;
    return meta;
  } catch {
    return {};
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// --- From facts to sub-agents ----------------------------------------------------------------------

interface Merged {
  /** Agent calls by tool_use id, with whose transcript each is in. */
  calls: Map<string, { owner: string | undefined; call: Call }>;
  results: Map<string, Result>;
  notices: Map<string, Notice>;
  /** The tool_use id whose result names an agent, by agent id. */
  named: Map<string, string>;
}

function merge(state: SessionState): Merged {
  const merged: Merged = { calls: new Map(), results: new Map(), notices: new Map(), named: new Map() };
  for (const file of state.files.values()) {
    for (const [id, call] of file.facts.calls) if (!merged.calls.has(id)) merged.calls.set(id, { owner: file.owner, call });
    for (const [id, result] of file.facts.results) {
      merged.results.set(id, result);
      if (result.agentId !== undefined && !merged.named.has(result.agentId)) merged.named.set(result.agentId, id);
    }
    for (const [id, notice] of file.facts.notices) {
      const known = merged.notices.get(id);
      if (known === undefined || (notice.atMs ?? -Infinity) >= (known.atMs ?? -Infinity)) merged.notices.set(id, notice);
    }
  }
  return merged;
}

function rowsOf(state: SessionState): Row[] {
  const merged = merge(state);
  const rows: Row[] = [];
  for (const [agentId, listed] of state.listing) {
    const meta = state.metas.get(agentId)?.meta ?? {};
    const toolUseId = meta.toolUseId ?? merged.named.get(agentId);
    const started = toolUseId === undefined ? undefined : merged.calls.get(toolUseId);
    const call = started?.call;
    const result = toolUseId === undefined ? undefined : merged.results.get(toolUseId);
    const notice = merged.notices.get(agentId);
    const own = listed.transcript === undefined ? undefined : state.files.get(path.join(state.folder, listed.transcript))?.facts;

    let background = meta.background ?? call?.background;
    if (background === undefined && (notice !== undefined || result?.async === true)) background = true;
    let end = notice?.state;
    let endMs = notice?.atMs;
    if (end === undefined && result !== undefined) {
      if (result.error) end = result.interrupted === true ? 'stopped' : 'failed';
      else if (background !== true && result.async !== true) end = 'done';
      endMs = result.atMs;
    }
    // Its own transcript went on after its end: SendMessage resumed it.
    if (end !== undefined && endMs !== undefined && own?.lastMs !== undefined && own.lastMs > endMs + RESUMED_AFTER_MS) end = undefined;

    const summary: Row['summary'] = {
      agentId,
      description: meta.description ?? call?.description ?? DEFAULT_SUBAGENT_DESCRIPTION,
      toolCalls: own?.toolCalls ?? 0,
    };
    const agentType = meta.agentType ?? call?.agentType;
    if (agentType !== undefined) summary.agentType = agentType;
    if (background !== undefined) summary.background = background;
    if (started?.owner !== undefined && started.owner !== agentId && state.listing.has(started.owner)) summary.startedBy = started.owner;
    if (own?.firstMs !== undefined) summary.startedAt = new Date(own.firstMs).toISOString();
    if (own?.lastMs !== undefined) summary.lastActivityAt = new Date(own.lastMs).toISOString();
    const row: Row = { summary, started: call !== undefined };
    if (end !== undefined) row.end = end;
    const ownFile = listed.transcript === undefined ? undefined : state.files.get(path.join(state.folder, listed.transcript));
    const signs = [own?.lastMs, ownFile?.mtimeMs, state.metas.get(agentId)?.mtimeMs, call?.atMs].filter((ms): ms is number => ms !== undefined && Number.isFinite(ms));
    if (signs.length > 0) row.activityMs = Math.max(...signs);
    const sortMs = own?.firstMs ?? call?.atMs;
    if (sortMs !== undefined) row.sortMs = sortMs;
    rows.push(row);
  }
  return rows;
}

function listOf(sessionId: string, state: SessionState, isRunning: (row: Row, state: SessionState) => boolean): SubagentList {
  const all = state.rows.map((row) => {
    const subagent: SubagentSummary = { ...row.summary, state: row.end ?? (isRunning(row, state) ? 'running' : 'unknown') };
    return { subagent, sortMs: row.sortMs };
  });
  // Running first, then the newest started, those with no time last, then by id so the order holds.
  all.sort((a, b) => {
    const running = Number(b.subagent.state === 'running') - Number(a.subagent.state === 'running');
    if (running !== 0) return running;
    const at = (x: { sortMs?: number | undefined }) => x.sortMs ?? -Infinity;
    if (at(a) !== at(b)) return at(b) > at(a) ? 1 : -1;
    return a.subagent.agentId < b.subagent.agentId ? -1 : a.subagent.agentId > b.subagent.agentId ? 1 : 0;
  });
  return { sessionId, subagents: all.slice(0, SUBAGENTS_MAX).map((item) => item.subagent), truncated: all.length > SUBAGENTS_MAX };
}

function labelsOf(state: SessionState, listing: ReadonlyMap<string, Listed>): SubagentLabels {
  const merged = merge(state);
  const descriptions = new Map<string, string>();
  const started = new Map<string, string>();
  for (const agentId of listing.keys()) {
    const meta = state.metas.get(agentId)?.meta ?? {};
    const toolUseId = meta.toolUseId ?? merged.named.get(agentId);
    const call = toolUseId === undefined ? undefined : merged.calls.get(toolUseId)?.call;
    descriptions.set(agentId, meta.description ?? call?.description ?? DEFAULT_SUBAGENT_DESCRIPTION);
    if (toolUseId !== undefined && !started.has(toolUseId)) started.set(toolUseId, agentId);
  }
  return { descriptions, started };
}
