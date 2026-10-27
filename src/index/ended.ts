// Ended interactive sessions (W66, spike 006): the interactive sessions whose process has exited, as
// when their terminal closed or the machine restarted, so `claude agents --json --all` no longer
// lists them. Their transcripts stay, and this finds them there.
//
// The rule (spike 006, finding 7). A transcript `<configDir>/projects/<folder>/<sessionId>.jsonl`,
// one level down only (a sub-agent's transcript sits in a subfolder and isn't a session), whose
// sessionId is a canonical UUID (isSessionUuid(), W81: `claude --resume` takes a name too, so a
// crafted `deploy.jsonl` must not become `claude --resume deploy`), is an ended interactive session
// when:
// - its first entry with an `entrypoint` says `cli`. `sdk-cli` is `claude -p`, pitwall's own relay
//   among them, and `sdk-ts` is the Agent SDK; anything else, such as an editor's, is left out;
// - `claude agents --json --all` doesn't list its session id in any row, a row the index can't
//   otherwise use included (listedSessionIds(), W81). A listed session always wins: the index
//   filters by the current listing on every poll (sessions()), so none is ever in both;
// - its newest user or assistant entry has no `sessionKind: "bg"`. One that last ran in the
//   background was removed on purpose with `claude rm`, which keeps the transcript (finding 6);
// - it has no `continued-in` entry after its newest user or assistant entry, in file order. Claude
//   Code writes one when the conversation carries on under another session id, as `/bg` does, and
//   that session is listed, or ended, under its own id: listing this one too would show the same
//   conversation twice, and resuming it would bring back a stale branch. The entry's target isn't
//   followed or checked;
// - it has a typed prompt: `promptSource: "typed"` on a user entry that isn't meta;
// - its start directory, the `cwd` of its first entry that has one, not a later entry's (which
//   follows `cd`), encodes to its folder's name, because `claude --resume` looks the session up
//   from that directory; and the directory's realpath is at or under a root;
// - its newest entry is at most ENDED_LISTED_DAYS old. A file whose mtime is older isn't read.
// At most ENDED_LISTED_MAX are listed, newest first.
//
// The poll never waits on it. The index calls track() on every poll, which starts a scan in the
// background when the listing changed (that's when a session ends, or is resumed), when the roots
// changed, or when ENDED_RESCAN_MS have passed, and reads the last scan's sessions() synchronously.
// A scan that finds a different set tells its subscribers, so the index polls again soon rather
// than up to an interval later.
//
// Cost. A scan lists the project folders and stats every transcript in them. It reads a file only
// when its size or mtime changed since it last read it, newest mtime first, and stops reading once
// ENDED_LISTED_MAX sessions are found that no unread file could be newer than. It skips a file whose
// session `claude agents` lists, so a live session's growing transcript isn't read on every scan.
// A changed file is read in two places:
// - its start, 64 KiB at a time, only until its first entry with an `entrypoint`, a `cwd` and a
//   time, usually in the first KiB. A file that isn't `cli`, or whose folder isn't its start
//   directory's, is never read again while it keeps its inode and only grows;
// - its end, as the transcript reader first reads a listed session's (readNewestEntries): the last
//   256 KiB, or 2 MiB when those lack a field. A `continued-in` entry sits after the last turn, so
//   it's in that window whenever the last turn is.
// Only when neither has a typed prompt does the read of its start go on to the end of the file, once
// per change, and from where it stopped when the file has only grown. One file is read at a time,
// yielding to the event loop between chunks and between files.
//
// Memory, never on disk, because paths and prompts from transcripts are session content: per
// transcript with a recent mtime, its inode, how far its start was read and what that found; per
// ended session, what its end read found, which holds at most a prompt, a title and a question's
// excerpt. A file that has gone, or whose mtime has aged out, is forgotten.
//
// Fails soft: a transcript that can't be read or parsed is skipped, and read afresh on a later scan.
// A scan that can't list the projects directory keeps the last result. Nothing here throws to the
// index.

import { open, readdir, realpath as fsRealpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ENDED_LISTED_DAYS, ENDED_LISTED_MAX } from '../shared/protocol.js';
import { isRecord } from './guards.js';
import { matchRoot, type Realpath } from './roots.js';
import {
  defaultConfigDir,
  encodeProjectDir,
  isSessionUuid,
  isTypedPrompt,
  readNewestEntries,
  setNameOf,
  type NewestEntries,
  type TranscriptInfo,
} from './transcripts.js';

/** ENDED_LISTED_DAYS in milliseconds. */
export const ENDED_LISTED_MS = ENDED_LISTED_DAYS * 24 * 60 * 60 * 1000;

/** How often the transcripts are scanned again when the listing and the roots haven't changed. */
export const ENDED_RESCAN_MS = 30_000;

/** One ended interactive session, as the index needs it to make its summary (SessionSummary.ended). */
export interface EndedSession {
  sessionId: string;
  /** Its transcript, which the conversation and the worked-in scan read. */
  file: string;
  /** The directory it started in, as its first entry with a `cwd` recorded it: not a realpath. */
  cwd: string;
  /** The newest name set with `--name`, else the directory's basename and the session id's first 8 characters. */
  name: string;
  /** ISO 8601: its first entry's time. */
  startedAt: string;
  /** Its newest entries, read as the transcript reader reads a listed session's. */
  transcript: TranscriptInfo & { lastActivityAt: string };
}

export interface EndedScanner {
  /**
   * Every session id the latest `claude agents --json --all` listed, and the roots. Starts a scan in
   * the background when either has changed since the last scan started, or ENDED_RESCAN_MS have
   * passed. Returns at once; never throws.
   */
  track(listed: ReadonlySet<string>, roots: readonly string[]): void;
  /**
   * The ended sessions the last scan found that `listed` doesn't name, and whose newest entry is at
   * most ENDED_LISTED_DAYS old at `nowMs`: newest first, at most ENDED_LISTED_MAX. Reads no files.
   */
  sessions(listed: ReadonlySet<string>, nowMs: number): EndedSession[];
  /** The transcript of a session the last scan found ended. Reads no files. */
  file(sessionId: string): string | undefined;
  /** Calls `listener` after each scan that found a different set of ended sessions, or a change in one. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Resolves once no scan is running or due. For tests and the benchmark. */
  settled(): Promise<void>;
  /** What the scanner has done so far. */
  stats(): EndedStats;
  stop(): void;
}

export interface EndedStats {
  /** Scans that finished. */
  scans: number;
  /** Transcripts statted, over every scan. */
  statted: number;
  /** Bytes read from transcripts' starts, the reads to the end for the typed-prompt check included. */
  bytesRead: number;
  /** Reads of a transcript's end (readNewestEntries). */
  tailReads: number;
  /** Reads of a transcript's start that went on to its end, for the typed-prompt check. */
  fullReads: number;
  /** How long the last scan took, in milliseconds. */
  lastScanMs: number;
}

export interface EndedScannerOptions {
  /** Default `$CLAUDE_CONFIG_DIR`, or `~/.claude` when it isn't set. */
  configDir?: string;
  /** Milliseconds since the epoch. Default Date.now. */
  now?: () => number;
  /** For the start directory's root. Default `fs.promises.realpath`. */
  realpath?: Realpath;
  /** Default ENDED_RESCAN_MS. */
  rescanMs?: number;
  /** Bytes read at a time from a transcript's start. Default 64 KiB. */
  chunkBytes?: number;
  /** A line longer than this, at a transcript's start, is skipped rather than kept whole. Default 16 MiB. */
  maxLineBytes?: number;
  /** For readNewestEntries. Default 256 KiB. */
  initialWindowBytes?: number;
  /** For readNewestEntries. Default 2 MiB. */
  maxWindowBytes?: number;
}

/** What a transcript's start has given so far, and its end read. */
interface FileState {
  dev: number;
  ino: number;
  /** How far the start has been read: bytes from the beginning, the carry included. */
  offset: number;
  /** The bytes after the last newline read: the start of a line a later read finishes. */
  carry: Buffer[];
  carryBytes: number;
  /** Drop everything up to the next newline: a line too long to keep. */
  skip: boolean;
  /** The first entry's `entrypoint`, `cwd` and time. */
  entrypoint?: string;
  cwd?: string;
  startedAtMs?: number;
  /** A typed prompt among the entries read from the start. */
  typed: boolean;
  /** The newest name among the entries read from the start. */
  name?: string;
  /** Not `cli`, or its start directory doesn't encode to its folder: never an ended session while this inode only grows. */
  never: boolean;
  /** The end, and the size and mtime it was read at. */
  tail?: { size: number; mtimeMs: number; newest: NewestEntries };
}

/** A transcript a scan stat'ed. */
interface Listed {
  file: string;
  folder: string;
  sessionId: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

const NEWLINE = 0x0a;
/** Lines past a transcript's first entry are parsed only when they name one of these. */
const MARKS = ['"promptSource"', '"custom-title"', '"agent-name"'].map((mark) => Buffer.from(mark));
/** C0 controls and DEL. A start directory with one is skipped: it would read differently in a command than it runs. */
const CONTROL = /[\u0000-\u001f\u007f]/;
const JSONL = '.jsonl';

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function isGone(err: unknown): boolean {
  const code = isRecord(err) ? err.code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function hasStart(state: FileState): state is FileState & { entrypoint: string; cwd: string; startedAtMs: number } {
  return state.entrypoint !== undefined && state.cwd !== undefined && state.startedAtMs !== undefined;
}

/** `<basename(cwd)>-<first 8 characters of the id>`, as SessionSummary.ended says, since Claude Code's default name isn't recorded. */
export function endedDefaultName(cwd: string, sessionId: string): string {
  const base = path.basename(cwd);
  const short = sessionId.slice(0, 8);
  return base === '' ? short : `${base}-${short}`;
}

export function createEndedScanner(options: EndedScannerOptions = {}): EndedScanner {
  const projectsDir = path.join(options.configDir ?? defaultConfigDir(), 'projects');
  const now = options.now ?? Date.now;
  const realpath = options.realpath ?? fsRealpath;
  const rescanMs = options.rescanMs ?? ENDED_RESCAN_MS;
  const maxLineBytes = options.maxLineBytes ?? 16 << 20;
  const windows = {
    ...(options.initialWindowBytes === undefined ? {} : { initialWindowBytes: options.initialWindowBytes }),
    ...(options.maxWindowBytes === undefined ? {} : { maxWindowBytes: options.maxWindowBytes }),
  };
  const buffer = Buffer.alloc(options.chunkBytes ?? 64 * 1024);

  const counters: EndedStats = { scans: 0, statted: 0, bytesRead: 0, tailReads: 0, fullReads: 0, lastScanMs: 0 };
  const files = new Map<string, FileState>();
  const listeners = new Set<() => void>();
  /** The last scan's sessions, newest first, before the listing and age filters sessions() applies. */
  let found: EndedSession[] = [];
  let byId = new Map<string, EndedSession>();
  let signature = '';

  /** What the latest track() asked for, and what the running or last scan started from. */
  let wanted: { listed: ReadonlySet<string>; roots: string[]; key: string } | undefined;
  let scanned: { key: string; at: number } | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;

  // --- Reading a transcript's start --------------------------------------------------------------

  /** Splits a chunk into lines, finishing the carried one first, and takes each. */
  function consume(state: FileState, chunk: Buffer): void {
    let pos = 0;
    for (let newline = chunk.indexOf(NEWLINE); newline !== -1; newline = chunk.indexOf(NEWLINE, pos)) {
      if (state.skip) state.skip = false;
      else if (state.carryBytes > 0) take(state, Buffer.concat([...state.carry, chunk.subarray(pos, newline)]));
      else take(state, chunk.subarray(pos, newline));
      state.carry = [];
      state.carryBytes = 0;
      pos = newline + 1;
    }
    if (pos < chunk.length) carry(state, chunk.subarray(pos));
  }

  function carry(state: FileState, bytes: Buffer): void {
    if (state.skip) return;
    if (state.carryBytes + bytes.length > maxLineBytes) {
      state.carry = [];
      state.carryBytes = 0;
      state.skip = true;
      return;
    }
    // A copy: the chunk's buffer is read into again.
    state.carry.push(Buffer.from(bytes));
    state.carryBytes += bytes.length;
  }

  /** One line from a transcript's start. Every line is parsed until the first entry's fields are in, then only one that names a mark. */
  function take(state: FileState, line: Buffer): void {
    if (hasStart(state) && !MARKS.some((mark) => line.indexOf(mark) !== -1)) return;
    let entry: unknown;
    try {
      entry = JSON.parse(line.toString('utf8'));
    } catch {
      return;
    }
    if (!isRecord(entry)) return;
    if (state.entrypoint === undefined && typeof entry.entrypoint === 'string') state.entrypoint = entry.entrypoint;
    if (state.cwd === undefined && typeof entry.cwd === 'string' && path.isAbsolute(entry.cwd)) state.cwd = entry.cwd;
    if (state.startedAtMs === undefined && typeof entry.timestamp === 'string') {
      const ms = Date.parse(entry.timestamp);
      if (Number.isFinite(ms)) state.startedAtMs = ms;
    }
    if (isTypedPrompt(entry)) state.typed = true;
    const name = setNameOf(entry);
    if (name !== undefined) state.name = name;
  }

  /** Reads on from where the start's read stopped, a chunk at a time, until `enough()` or `end`. */
  async function readStart(file: string, state: FileState, end: number, enough: () => boolean): Promise<void> {
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      // Replaced since the stat: the next scan starts it afresh.
      if (info.dev !== state.dev || info.ino !== state.ino) throw new Error('the transcript was replaced');
      const stop = Math.min(end, info.size);
      while (!enough() && state.offset < stop && !stopped) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stop - state.offset), state.offset);
        if (bytesRead === 0) break;
        counters.bytesRead += bytesRead;
        state.offset += bytesRead;
        consume(state, buffer.subarray(0, bytesRead));
        await yieldToLoop();
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  // --- One transcript ----------------------------------------------------------------------------

  /** The rule, for one transcript, reading only what it must. Undefined when it isn't an ended session. */
  async function consider(
    entry: Listed,
    roots: readonly string[],
    cutoff: number,
    realpaths: Map<string, Promise<string>>,
  ): Promise<EndedSession | undefined> {
    const { file, folder, sessionId } = entry;
    let state = files.get(file);
    if (state === undefined || state.dev !== entry.dev || state.ino !== entry.ino || entry.size < state.offset) {
      state = { dev: entry.dev, ino: entry.ino, offset: 0, carry: [], carryBytes: 0, skip: false, typed: false, never: false };
      files.set(file, state);
    }
    if (state.never) return undefined;

    // Its start: the first entry's `entrypoint`, `cwd` and time.
    const current = state;
    if (!hasStart(current)) await readStart(file, current, entry.size, () => hasStart(current));
    if (current.entrypoint !== undefined && current.entrypoint !== 'cli') current.never = true;
    if (current.cwd !== undefined && (encodeProjectDir(current.cwd) !== folder || CONTROL.test(current.cwd))) current.never = true;
    if (current.never || !hasStart(current)) return undefined;

    // Under a root, by the realpath, before anything costlier is read.
    let real = realpaths.get(current.cwd);
    if (real === undefined) {
      real = realpath(current.cwd).catch(() => current.cwd);
      realpaths.set(current.cwd, real);
    }
    if (matchRoot(await real, roots) === undefined) return undefined;

    // Its end.
    if (current.tail === undefined || current.tail.size !== entry.size || current.tail.mtimeMs !== entry.mtimeMs) {
      counters.tailReads++;
      const newest = await readNewestEntries(file, windows);
      if (newest === undefined) return undefined;
      current.tail = { size: entry.size, mtimeMs: entry.mtimeMs, newest };
    }
    const { newest } = current.tail;
    // It last ran in the background, or no user or assistant entry was read to say.
    if (newest.inBackground !== false) return undefined;
    // Its conversation carried on under another session id after its last turn.
    if (newest.continuedElsewhere) return undefined;

    // A typed prompt: in what was read of its start or its end, or else in the rest of the file.
    if (!current.typed && !newest.typedPrompt && current.offset < entry.size) {
      counters.fullReads++;
      await readStart(file, current, entry.size, () => current.typed);
    }
    if (!current.typed && !newest.typedPrompt) return undefined;

    const last = newest.info.lastActivityAt;
    if (last === undefined || !(Date.parse(last) >= cutoff)) return undefined;
    return {
      sessionId,
      file,
      cwd: current.cwd,
      name: newest.setName ?? current.name ?? endedDefaultName(current.cwd, sessionId),
      startedAt: new Date(current.startedAtMs).toISOString(),
      transcript: { ...newest.info, transcript: 'ok', lastActivityAt: last },
    };
  }

  // --- A scan ------------------------------------------------------------------------------------

  /** Every top-level transcript whose mtime is recent enough, newest first. Undefined when the projects directory can't be listed. */
  async function list(listed: ReadonlySet<string>, cutoff: number, keep: Set<string>): Promise<Listed[] | undefined> {
    let folders: string[];
    try {
      folders = (await readdir(projectsDir, { withFileTypes: true })).filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
    } catch (err) {
      if (!isGone(err)) return undefined;
      folders = [];
    }
    const result: Listed[] = [];
    for (const folder of folders) {
      if (stopped) break;
      let names: string[];
      try {
        names = await readdir(path.join(projectsDir, folder));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(JSONL)) continue;
        const sessionId = name.slice(0, -JSONL.length);
        if (!isSessionUuid(sessionId)) continue;
        const file = path.join(projectsDir, folder, name);
        // Listed, so not ended: what's known about it is kept, and nothing is read.
        if (listed.has(sessionId)) {
          keep.add(file);
          continue;
        }
        let info;
        try {
          info = await stat(file);
        } catch {
          continue;
        }
        counters.statted++;
        if (!info.isFile() || info.mtimeMs < cutoff) continue;
        keep.add(file);
        result.push({ file, folder, sessionId, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
    return result.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }

  async function scan(listed: ReadonlySet<string>, roots: readonly string[]): Promise<void> {
    const began = now();
    const cutoff = began - ENDED_LISTED_MS;
    const keep = new Set<string>();
    const transcripts = await list(listed, cutoff, keep);
    if (transcripts === undefined || stopped) return;
    const next: EndedSession[] = [];
    const realpaths = new Map<string, Promise<string>>();
    for (const entry of transcripts) {
      if (stopped) return;
      // A transcript's newest entry is no newer than its mtime, so once ENDED_LISTED_MAX are found,
      // none in an older file could take one's place.
      const floor = next.length >= ENDED_LISTED_MAX ? Date.parse((next[ENDED_LISTED_MAX - 1] as EndedSession).transcript.lastActivityAt) : -Infinity;
      if (entry.mtimeMs < floor) break;
      try {
        const session = await consider(entry, roots, cutoff, realpaths);
        if (session !== undefined) {
          next.push(session);
          next.sort(newestFirst);
        }
      } catch {
        // Read afresh on a later scan.
        files.delete(entry.file);
      }
      await yieldToLoop();
    }
    if (stopped) return;
    for (const file of files.keys()) if (!keep.has(file)) files.delete(file);
    counters.scans++;
    counters.lastScanMs = now() - began;
    const nextSignature = JSON.stringify(next);
    if (nextSignature === signature) return;
    signature = nextSignature;
    found = next;
    byId = new Map(next.map((session) => [session.sessionId, session]));
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  function start(): void {
    if (wanted === undefined || stopped) return;
    const { listed, roots, key } = wanted;
    scanned = { key, at: now() };
    running = scan(listed, roots)
      .catch(() => undefined)
      .finally(() => {
        running = undefined;
        if (again && !stopped) {
          again = false;
          start();
        }
      });
  }

  return {
    track(listed, roots) {
      if (stopped) return;
      try {
        const key = `${[...roots].join('\n')}\0${[...listed].sort().join('\n')}`;
        wanted = { listed: new Set(listed), roots: [...roots], key };
        if (scanned !== undefined && scanned.key === key && now() - scanned.at < rescanMs) return;
        if (running !== undefined) {
          again = true;
          return;
        }
        start();
      } catch {
        // Never fails a poll.
      }
    },
    sessions(listed, nowMs) {
      const cutoff = nowMs - ENDED_LISTED_MS;
      return found
        .filter((session) => !listed.has(session.sessionId) && Date.parse(session.transcript.lastActivityAt) >= cutoff)
        .slice(0, ENDED_LISTED_MAX);
    },
    file(sessionId) {
      return byId.get(sessionId)?.file;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async settled() {
      while (running !== undefined) await running;
    },
    stats: () => ({ ...counters }),
    stop() {
      stopped = true;
      listeners.clear();
      files.clear();
      found = [];
      byId = new Map();
    },
  };
}

function newestFirst(a: EndedSession, b: EndedSession): number {
  return (
    Date.parse(b.transcript.lastActivityAt) - Date.parse(a.transcript.lastActivityAt) ||
    (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
  );
}
