// The worked-in scanner (W34, spike 004): which repos under the configured roots each session worked
// in, beyond the one it started in, from the tool calls in its transcript and its sub-agents'. The
// same pass finds each session's PR links (M4, W94, prLinks.ts), so no transcript is read twice.
//
// The rule: a repo counts when the session changed it, or when at least 5% of its tool calls touched
// it, over the whole of its main transcript and every sub-agent transcript beside it. toolCalls.ts
// says what a call touches and changes. Newest touch first, with no cap. Left out: the session's
// start repo, anything that isn't a repo (the root itself, a directory in no repo), repos under no
// configured root, and repos that no longer exist. A repo under any root counts, whichever root the
// session is under.
//
// PR links: prLinks.ts says what links a session to a PR. 'opened' and 'pushed' come from the
// successful result of a call that creates a PR or pushes, in any of the session's files: the call
// is matched to its result by its tool_use id, and only the ids of those calls are kept while their
// results are awaited. 'prompted' and 'mentioned' come from the main transcript only, since a
// sub-agent's prompts are its parent's. The newest of each link is kept per file, and the session's
// are merged from its files, newest first, at most PR_LINKS_MAX.
//
// The poll never waits on it. The index calls track() with the sessions it lists and reads
// workedIn() and prLinks() synchronously. The first sight of a session queues a full scan of its
// files, one at a time, a chunk at a time, yielding to the event loop between chunks; after that,
// each poll stats the known files, lists the `subagents` directory and reads only what was appended.
// One worker runs the queue, and sessions that have been scanned go before ones that haven't, so a
// long first scan holds up no one else's small update for more than a file.
//
// Memory: files are read in 1 MiB chunks into one buffer, never whole. Only lines that could matter
// are parsed: a tool call, `"type":"tool_use"`; a tool's result, `"type":"tool_result"`, only when
// it holds the id of a call the file waits on; and, in the main transcript, any other line with both
// `github.com/` and `/pull/`. One scan of a line tells a call from a result. What's kept, in memory
// only, never on disk, because paths, repo names and branches from transcripts are session content:
// - per file: { dev, ino, offset, carry }, its calls per repo, and its PR links, so a file that
//   shrank or was replaced is rescanned from 0 without counting anything twice; and the calls whose
//   results it awaits, at most 32, each for at most 10,000 lines;
// - per session: the call total and per-repo counts (summed from its files), and the results;
// - per directory: its repo, found by walking up to the nearest `.git` and resolving only there,
//   with createGroupResolver (runFile, the scrubbed environment, a TTL); and each repo's GitHub
//   remotes, read with `git config --get-regexp`, which neither touches the index nor runs hooks.
// At most 2 git processes run at once, and none on the poll's path: the scanner has its own resolver.
//
// Fails soft: a missing or unreadable transcript, or anything that goes wrong scanning one, leaves
// that session's workedIn() and prLinks() undefined, retried after 30 s. A git failure for one
// directory leaves it counting as no repo. Nothing here throws to the index.

import { open, readdir, realpath as fsRealpath, stat, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PR_LINKS_MAX, type PrLink, type PrLinkKind, type WorkedIn } from '../shared/protocol.js';
import { runFile, RunError, type RunFile } from './exec.js';
import { createGroupResolver, gitEnvironment } from './grouping.js';
import { isRecord } from './guards.js';
import {
  addLink,
  linkingCall,
  mayNamePr,
  newestLinks,
  openedByGh,
  openedByMcp,
  prUrlsIn,
  pruneLinks,
  pushedIn,
  toPrLink,
  type FoundLink,
  type LinkingCall,
  type PrRef,
} from './prLinks.js';
import { isWithin, matchRoot } from './roots.js';
import { placesOf, slugsIn, type CallPlaces } from './toolCalls.js';
import { assistantTextOf, promptTextOf } from './transcripts.js';

/** The share of a session's tool calls that makes a repo count, in percent (spike 004). */
export const WORKED_IN_PERCENT = 5;

/**
 * One repo a session worked in, with the configured root its group sits under, or would
 * (WorkedIn.root): the index labels it from that root (WorkedIn.label), as it labels groups.
 */
export type RepoWorkedIn = Omit<WorkedIn, 'label'>;

/** A session the index lists, as the scanner needs it. */
export interface TrackedSession {
  sessionId: string;
  /** Its main transcript, from the transcript reader. Undefined when there's none. */
  file: string | undefined;
  /** The key of the group it started in, which its workedIn leaves out. */
  startKey: string;
}

export interface WorkedInScanner {
  /**
   * The sessions in the latest poll, under `roots`: queues a full scan for each one seen for the
   * first time, and an incremental one for the rest, and forgets every session not listed. Returns
   * at once; never throws.
   */
  track(sessions: readonly TrackedSession[], roots: readonly string[]): void;
  /** The repos a session worked in, newest touch first, as of its last scan. Undefined until it has been scanned, and after a failure. */
  workedIn(sessionId: string): readonly RepoWorkedIn[] | undefined;
  /**
   * The session's PR links (SessionSummary.prLinks, prLinks.ts), newest first, at most
   * PR_LINKS_MAX, as of its last scan. Empty when it has none; undefined until it has been
   * scanned, and after a failure.
   */
  prLinks(sessionId: string): readonly PrLink[] | undefined;
  /** Resolves once nothing is queued or running. For tests and the benchmark. */
  settled(): Promise<void>;
  /** What the scanner has done so far. */
  stats(): ScannerStats;
  stop(): void;
}

export interface ScannerStats {
  /** Transcript bytes read. */
  bytesRead: number;
  /** Tool calls counted. */
  calls: number;
  /** Session scans that finished, full and incremental. */
  scans: number;
  /** git processes started. */
  gitRuns: number;
  /** The most git processes running at once. */
  gitPeak: number;
}

/** The file system calls the scanner makes, so tests can hold one back. */
export interface ScannerFs {
  open(file: string): Promise<FileHandle>;
  stat(p: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  readdir(p: string): Promise<string[]>;
  realpath(p: string): Promise<string>;
}

export interface WorkedInScannerOptions {
  /** Runs git. Default runFile. */
  run?: RunFile;
  fs?: Partial<ScannerFs>;
  /** Milliseconds since the epoch. Default Date.now. */
  now?: () => number;
  /** How long a directory's repo, a repo's remotes and the roots' repos are reused. Default 5 minutes. */
  ttlMs?: number;
  /** Expands `~` and `$HOME` in commands. Default os.homedir(). */
  home?: string;
  /** Default 2. */
  gitConcurrency?: number;
  /** Bytes read at a time. Default 1 MiB. */
  chunkBytes?: number;
  /** A line longer than this is skipped rather than kept whole. Default 16 MiB. */
  maxLineBytes?: number;
  /** How long a session whose scan failed waits before it's tried again. Default 30000. */
  retryMs?: number;
  /** Default 'git'. */
  gitBin?: string;
  /** Per git process. Default 5000. */
  timeoutMs?: number;
}

/**
 * `"type":"tool_use"` and `"type":"tool_result"` share this start, so one scan of a line finds
 * either. A result's comes before its output, near the start of the line, so the long lines, which
 * are mostly results, are cheap to tell apart.
 */
const TOOL_MARK = Buffer.from('"type":"tool_');
const USE_TAIL = Buffer.from('use"');
const RESULT_TAIL = Buffer.from('result"');
/** Both on a line of the main transcript, which may then have a PR URL in a prompt or in Claude's text. */
const GITHUB_MARK = Buffer.from('github.com/');
const PULL_MARK = Buffer.from('/pull/');
/** The most calls one file waits on for a result. Past this, the oldest is dropped. */
const MAX_PENDING = 32;
/** Lines read in a file after a call before its result is no longer waited for: one that never came, as after a crash. */
const MAX_WAIT_LINES = 10_000;
/** A file's links past this are pruned to what the result could keep (pruneLinks()). */
const MAX_FILE_LINKS = 4 * PR_LINKS_MAX;
const NEWLINE = 0x0a;
/** A cache past this many entries is emptied, so a pathological transcript can't grow one without end. */
const MAX_CACHE_ENTRIES = 100_000;

const nodeFs: ScannerFs = {
  open: (file) => open(file, 'r'),
  stat: (p) => stat(p),
  readdir: (p) => readdir(p),
  realpath: (p) => fsRealpath(p),
};

interface Placement {
  key: string;
  root: string;
}

interface Count {
  root: string;
  calls: number;
  changes: number;
  /** Epoch ms of the newest call that touched it; 0 when none had a time. */
  lastAt: number;
}

/** A call whose result can link the session to a PR, waiting for that result. */
interface Pending extends LinkingCall {
  /** The call's time, epoch ms, for a result without one; 0 when it had none. */
  at: number;
  /** FileState.lines when the call was read. */
  line: number;
}

interface FileState {
  /** The session's main transcript, rather than a sub-agent's: only there do prompts and Claude's text link. */
  main: boolean;
  dev: number;
  ino: number;
  /** Bytes read so far, including the carry. */
  offset: number;
  /** The bytes after the last newline read: the start of a line a later read finishes. */
  carry: Buffer[];
  carryBytes: number;
  /** Drop everything up to the next newline: a line too long to keep. */
  skip: boolean;
  /** Tool calls in this file. */
  calls: number;
  /** Calls per repo key. */
  repos: Map<string, Count>;
  /** The calls that can link, by tool_use id, oldest first, until their results are read. */
  pending: Map<string, Pending>;
  /** Lines read, for how long a call is waited on. */
  lines: number;
  /** This file's PR links, the newest of each (linkKey()). */
  links: Map<string, FoundLink>;
}

interface SessionState {
  main: string;
  startKey: string;
  files: Map<string, FileState>;
  /** Set once a scan has finished. */
  result: RepoWorkedIn[] | undefined;
  /** Set with `result`: every file's links, merged, newest first and capped. */
  links: PrLink[] | undefined;
  /** After a failure: not tried again before this. */
  retryAt?: number;
}

interface RawCall {
  name: string;
  input: unknown;
  cwd: unknown;
  at: number;
}

/** A cache of promises that expire, emptied when it grows past MAX_CACHE_ENTRIES. */
class Expiring<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<T> }>();
  constructor(
    private readonly now: () => number,
    private readonly ttlMs: number,
  ) {}

  get(key: string, make: () => Promise<T>): Promise<T> {
    const at = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > at) return hit.value;
    if (this.entries.size >= MAX_CACHE_ENTRIES) this.entries.clear();
    const value = make();
    this.entries.set(key, { expiresAt: at + this.ttlMs, value });
    return value;
  }

  prune(): void {
    const at = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= at) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

/** At most `max` of `fn` at once, each waiting its turn in order. */
function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    // A finishing call hands its slot straight to the next one, so none can slip in between.
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Whether a line's first `"type":"tool_use"` or `"type":"tool_result"` is a call or a result. A
 * call's comes first in an assistant entry, and a result's in a user entry; only those are read.
 */
function toolMark(line: Buffer): 'use' | 'result' | undefined {
  for (let at = line.indexOf(TOOL_MARK); at !== -1; at = line.indexOf(TOOL_MARK, at + 1)) {
    const tail = at + TOOL_MARK.length;
    if (startsAt(line, USE_TAIL, tail)) return 'use';
    if (startsAt(line, RESULT_TAIL, tail)) return 'result';
  }
  return undefined;
}

function startsAt(line: Buffer, bytes: Buffer, at: number): boolean {
  return at + bytes.length <= line.length && line.compare(bytes, 0, bytes.length, at, at + bytes.length) === 0;
}

/** A tool result's text: its string content, or its text blocks joined, as an MCP tool's are. */
function resultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function isGone(err: unknown): boolean {
  const code = isRecord(err) ? err.code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function createWorkedInScanner(options: WorkedInScannerOptions = {}): WorkedInScanner {
  const fs: ScannerFs = { ...nodeFs, ...options.fs };
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const home = options.home ?? os.homedir();
  const chunkBytes = options.chunkBytes ?? 1 << 20;
  const maxLineBytes = options.maxLineBytes ?? 16 << 20;
  const retryMs = options.retryMs ?? 30_000;
  const gitBin = options.gitBin ?? 'git';
  const timeoutMs = options.timeoutMs ?? 5_000;
  const baseRun = options.run ?? runFile;

  const counters: ScannerStats = { bytesRead: 0, calls: 0, scans: 0, gitRuns: 0, gitPeak: 0 };
  let gitNow = 0;
  const limit = createLimiter(options.gitConcurrency ?? 2);
  const run: RunFile = (file, args, runOptions) =>
    limit(async () => {
      counters.gitRuns++;
      gitNow++;
      counters.gitPeak = Math.max(counters.gitPeak, gitNow);
      try {
        return await baseRun(file, args, runOptions);
      } finally {
        gitNow--;
      }
    });
  // Its own resolver, so the poll's never waits behind the scanner's git.
  const resolver = createGroupResolver({ run, now, ttlMs, gitBin, timeoutMs, realpath: fs.realpath });
  const env = gitEnvironment();

  const kinds = new Expiring<'dir' | 'file' | null>(now, ttlMs);
  const reals = new Expiring<string>(now, ttlMs);
  const places = new Expiring<Placement | null>(now, ttlMs);
  const gitdirs = new Expiring<string | undefined>(now, ttlMs);
  const remotes = new Expiring<string[]>(now, ttlMs);
  const slugPlaces = new Expiring<Placement | null>(now, ttlMs);
  const caches = [kinds, reals, places, gitdirs, remotes, slugPlaces];
  /** Every repo the scanner has found under a root, with its root: the candidates for a GitHub repo's local clone. */
  const known = new Map<string, string>();
  let rootRepos: { at: number; done: Promise<void> } | undefined;

  let roots: string[] = [];
  const sessions = new Map<string, SessionState>();
  // Sessions with a finished scan go first: their updates are small.
  const again: string[] = [];
  const fresh: string[] = [];
  const queued = new Set<string>();
  let running: Promise<void> | undefined;
  let stopped = false;
  const buffer = Buffer.alloc(chunkBytes);

  // --- Places --------------------------------------------------------------------------------------

  function kindOf(p: string): Promise<'dir' | 'file' | null> {
    return kinds.get(p, () =>
      fs.stat(p).then(
        (info) => (info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null),
        () => null,
      ),
    );
  }

  function realOf(dir: string): Promise<string> {
    return reals.get(dir, () => fs.realpath(dir).catch(() => dir));
  }

  /** The nearest directory at or above `dir` that holds `.git`, and whether that's a directory, as in a main repo. */
  async function boundaryOf(dir: string): Promise<{ dir: string; main: boolean } | undefined> {
    for (let at = dir; ; ) {
      const kind = await kindOf(path.join(at, '.git'));
      if (kind !== null) return { dir: at, main: kind === 'dir' };
      const parent = path.dirname(at);
      if (parent === at) return undefined;
      at = parent;
    }
  }

  /** Where a `.git` file points: a worktree's or a submodule's git dir. */
  function gitdirOf(dir: string): Promise<string | undefined> {
    return gitdirs.get(dir, async () => {
      let handle: FileHandle | undefined;
      try {
        handle = await fs.open(path.join(dir, '.git'));
        const head = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        // The rest of the line, then trimmed: `(.+?)\s*$` would be quadratic on a run of spaces
        // inside it, 35 ms for a made-up 4 KiB file.
        const target = /^gitdir:\s*(.*)$/m.exec(head.toString('utf8', 0, bytesRead))?.[1]?.trimEnd();
        return target ? path.resolve(dir, target) : undefined;
      } catch {
        return undefined;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    });
  }

  /**
   * The repo a path is in, and the root its group sits under, or null: in no repo, under no root,
   * or below a root in a directory that has gone, as a removed repo's paths are.
   */
  function place(p: string): Promise<Placement | null> {
    return places.get(p, () => locate(p).catch(() => null));
  }

  async function locate(p: string): Promise<Placement | null> {
    const given = path.resolve(p);
    const givenRoot = matchRoot(given, roots);
    let at = given;
    let missing = false;
    for (;;) {
      const kind = await kindOf(at);
      if (kind === 'dir') break;
      if (kind === 'file') {
        at = path.dirname(at);
        break;
      }
      missing = true;
      const parent = path.dirname(at);
      if (parent === at) return null;
      at = parent;
    }
    // Below a root, with only the root or what's above it left: a repo that no longer exists.
    if (missing && givenRoot !== undefined && given !== givenRoot && (at === givenRoot || !isWithin(givenRoot, at))) return null;
    const real = await realOf(at);
    const underRoot = matchRoot(real, roots);
    const boundary = await boundaryOf(real);
    if (boundary === undefined) return null;
    if (underRoot === undefined) {
      // Outside every root, only a worktree or submodule whose repository is under one can count.
      if (boundary.main) return null;
      const gitdir = await gitdirOf(boundary.dir);
      if (gitdir === undefined || matchRoot(gitdir, roots) === undefined) return null;
    }
    const group = await resolver.resolve(boundary.dir);
    if (group.kind !== 'git') return null;
    const root = underRoot ?? matchRoot(group.key, roots);
    if (root === undefined) return null;
    remember(group.key, root);
    return { key: group.key, root };
  }

  function remember(key: string, root: string): void {
    if (known.has(key)) return;
    known.set(key, root);
    // A repo found since may be the one a GitHub reference names.
    slugPlaces.clear();
  }

  // --- GitHub repos ----------------------------------------------------------------------------------

  /** The local repo under a root whose remotes name `slug`. With several, the one named like it, else the first by path. */
  function placeSlug(slug: string): Promise<Placement | null> {
    return slugPlaces.get(slug, async () => {
      try {
        await findRootRepos();
        const candidates = await Promise.all(
          [...known].map(async ([key, root]) => ({ key, root, slugs: await remotesOf(key) })),
        );
        const matches = candidates.filter((c) => roots.includes(c.root) && c.slugs.includes(slug)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const name = slug.split('/')[1] ?? '';
        const match = matches.find((c) => path.basename(c.key).toLowerCase() === name) ?? matches[0];
        return match ? { key: match.key, root: match.root } : null;
      } catch {
        return null;
      }
    });
  }

  /** The repos at each root and directly in it, found once per TTL and only once a GitHub reference needs them. */
  function findRootRepos(): Promise<void> {
    if (rootRepos === undefined || now() - rootRepos.at >= ttlMs) {
      rootRepos = {
        at: now(),
        done: (async () => {
          for (const root of roots) {
            let names: string[];
            try {
              names = await fs.readdir(root);
            } catch {
              continue;
            }
            const dirs = [root, ...names.filter((name) => !name.startsWith('.')).map((name) => path.join(root, name))];
            await Promise.all(
              dirs.map(async (dir) => {
                if ((await kindOf(path.join(dir, '.git'))) !== null) await place(dir);
              }),
            );
          }
        })(),
      };
    }
    return rootRepos.done;
  }

  /** A repo's GitHub remotes, from its config: read-only, and it runs no hooks. */
  function remotesOf(key: string): Promise<string[]> {
    return remotes.get(key, async () => {
      let stdout: string;
      try {
        stdout = await run(gitBin, ['-C', key, 'config', '--get-regexp', '^remote\\..*\\.url$'], { timeoutMs, env });
      } catch (err) {
        // Exit 1: no remotes.
        if (!(err instanceof RunError)) throw err;
        return [];
      }
      return [...new Set(stdout.split('\n').flatMap((line) => slugsIn(line)))];
    });
  }

  // --- Reading -------------------------------------------------------------------------------------

  /**
   * Splits a chunk into lines, finishing the carried one first, and returns the tool calls in them.
   * The PR links in them go straight into the file's links.
   */
  function consume(file: FileState, chunk: Buffer): RawCall[] {
    const calls: RawCall[] = [];
    let newline = chunk.indexOf(NEWLINE);
    if (newline === -1) {
      carry(file, chunk);
      return calls;
    }
    if (file.skip) {
      file.skip = false;
    } else {
      const first = file.carryBytes > 0 ? Buffer.concat([...file.carry, chunk.subarray(0, newline)]) : chunk.subarray(0, newline);
      take(file, first, calls);
    }
    file.carry = [];
    file.carryBytes = 0;
    let pos = newline + 1;
    for (newline = chunk.indexOf(NEWLINE, pos); newline !== -1; newline = chunk.indexOf(NEWLINE, pos)) {
      take(file, chunk.subarray(pos, newline), calls);
      pos = newline + 1;
    }
    if (pos < chunk.length) carry(file, chunk.subarray(pos));
    return calls;
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
   * The tool calls and PR links on one line. Only a line that could hold one is parsed: a tool call;
   * a tool's result that holds the id of a call the file waits on; and, in the main transcript, any
   * other line that holds both `github.com/` and `/pull/`.
   */
  function take(file: FileState, line: Buffer, calls: RawCall[]): void {
    file.lines++;
    const mark = toolMark(line);
    if (mark === 'result') {
      if (!awaits(file, line)) return;
    } else if (mark === undefined && (!file.main || line.indexOf(GITHUB_MARK) === -1 || line.indexOf(PULL_MARK) === -1)) {
      return;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line.toString('utf8'));
    } catch {
      return;
    }
    if (!isRecord(entry) || !isRecord(entry.message)) return;
    const content = entry.message.content;
    const ms = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    const at = Number.isFinite(ms) ? ms : 0;
    if (entry.type === 'assistant') {
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isRecord(block) && block.type === 'tool_use' && typeof block.name === 'string') {
            calls.push({ name: block.name, input: block.input, cwd: entry.cwd, at });
            if (typeof block.id === 'string') {
              const linking = linkingCall(block.name, block.input);
              if (linking !== undefined) wait(file, block.id, { ...linking, at });
            }
          }
        }
      }
      // Claude's own text: assistantTextOf() leaves out tool calls, thinking and sidechains.
      const text = file.main ? assistantTextOf(entry)?.text : undefined;
      if (text !== undefined && mayNamePr(text)) for (const pr of prUrlsIn(text)) link(file, 'mentioned', pr, at);
      return;
    }
    if (entry.type !== 'user') return;
    if (Array.isArray(content) && file.pending.size > 0) {
      for (const block of content) if (isRecord(block) && block.type === 'tool_result') settle(file, block, at);
    }
    // A prompt you typed, by lastUserPrompt's rule: no cross-session messages, meta lines or tool results.
    const prompt = file.main ? promptTextOf(entry) : undefined;
    if (prompt !== undefined && mayNamePr(prompt)) for (const pr of prUrlsIn(prompt)) link(file, 'prompted', pr, at);
  }

  /** True when a line holds the id of a call the file waits on, after dropping those waited on too long. */
  function awaits(file: FileState, line: Buffer): boolean {
    // Oldest first, so the stale ones are at the front.
    for (const [id, pending] of file.pending) {
      if (file.lines - pending.line <= MAX_WAIT_LINES) break;
      file.pending.delete(id);
    }
    for (const id of file.pending.keys()) if (line.indexOf(id) !== -1) return true;
    return false;
  }

  function wait(file: FileState, id: string, pending: Omit<Pending, 'line'>): void {
    file.pending.delete(id);
    file.pending.set(id, { ...pending, line: file.lines });
    if (file.pending.size > MAX_PENDING) {
      const oldest = file.pending.keys().next();
      if (oldest.done !== true) file.pending.delete(oldest.value);
    }
  }

  /** A tool's result: the links a successful one of a call the file waits on makes. */
  function settle(file: FileState, block: Record<string, unknown>, lineAt: number): void {
    const id = block.tool_use_id;
    if (typeof id !== 'string') return;
    const pending = file.pending.get(id);
    if (pending === undefined) return;
    file.pending.delete(id);
    if (block.is_error === true) return;
    const output = resultText(block.content);
    if (output === undefined) return;
    const at = lineAt || pending.at;
    if (pending.opens !== undefined) {
      for (const pr of pending.opens === 'gh' ? openedByGh(output) : openedByMcp(output)) link(file, 'opened', pr, at);
    }
    if (pending.pushes === true) {
      for (const { repo, branch } of pushedIn(output)) add(file, { kind: 'pushed', repo, branch, at });
    }
  }

  function link(file: FileState, kind: Exclude<PrLinkKind, 'pushed'>, pr: PrRef, at: number): void {
    add(file, { kind, repo: pr.repo, number: pr.number, at });
  }

  function add(file: FileState, found: FoundLink): void {
    // A link with no time can't be placed among the rest.
    if (found.at <= 0) return;
    addLink(file.links, found);
    if (file.links.size > MAX_FILE_LINKS) pruneLinks(file.links);
  }

  /**
   * Counts calls into a file's per-repo counts, after finding the repo of every place they name.
   * placesOf() runs on the main thread for every call, so toolCalls.ts keeps it linear and cuts
   * long input short.
   */
  async function count(file: FileState, calls: readonly RawCall[]): Promise<void> {
    const named: CallPlaces[] = calls.map((call) => placesOf(call.name, call.input, call.cwd, home));
    const paths = [...new Set(named.flatMap((n) => n.paths))];
    const slugs = [...new Set(named.flatMap((n) => n.slugs))];
    const pathPlaces = new Map(await Promise.all(paths.map(async (p) => [p, await place(p)] as const)));
    const slugPlaceList = new Map(await Promise.all(slugs.map(async (s) => [s, await placeSlug(s)] as const)));
    calls.forEach((call, index) => {
      const places = named[index] as CallPlaces;
      file.calls++;
      counters.calls++;
      const touched = new Map<string, string>();
      const changed = new Set<string>();
      const add = (placement: Placement | null | undefined, change: boolean) => {
        if (!placement) return;
        if (!touched.has(placement.key)) touched.set(placement.key, placement.root);
        if (change) changed.add(placement.key);
      };
      for (const p of places.paths) add(pathPlaces.get(p), false);
      for (const p of places.changedPaths) add(pathPlaces.get(p), true);
      for (const s of places.slugs) add(slugPlaceList.get(s), false);
      for (const s of places.changedSlugs) add(slugPlaceList.get(s), true);
      for (const [key, root] of touched) {
        let repo = file.repos.get(key);
        if (repo === undefined) file.repos.set(key, (repo = { root, calls: 0, changes: 0, lastAt: 0 }));
        repo.calls++;
        if (changed.has(key)) repo.changes++;
        if (call.at > repo.lastAt) repo.lastAt = call.at;
      }
    });
  }

  /**
   * Reads what's new in one file: from 0 the first time, or when it shrank or was replaced, else
   * from where the last read ended. False when the file has gone.
   */
  async function scanFile(state: SessionState, file: string, alive: () => boolean): Promise<boolean> {
    let handle: FileHandle;
    try {
      handle = await fs.open(file);
    } catch (err) {
      if (isGone(err)) return false;
      throw err;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('not a file');
      let known = state.files.get(file);
      if (known === undefined || known.dev !== info.dev || known.ino !== info.ino || info.size < known.offset) {
        known = { main: file === state.main, dev: info.dev, ino: info.ino, offset: 0, carry: [], carryBytes: 0, skip: false, calls: 0, repos: new Map(), pending: new Map(), lines: 0, links: new Map() };
        state.files.set(file, known);
      }
      const end = info.size;
      while (known.offset < end) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - known.offset), known.offset);
        if (bytesRead === 0) break;
        counters.bytesRead += bytesRead;
        known.offset += bytesRead;
        const calls = consume(known, buffer.subarray(0, bytesRead));
        if (calls.length > 0) await count(known, calls);
        await yieldToLoop();
        if (!alive()) return true;
      }
      return true;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** The main transcript, then each sub-agent transcript beside it, in name order. */
  async function filesOf(main: string): Promise<string[]> {
    const dir = path.join(path.dirname(main), path.basename(main, '.jsonl'), 'subagents');
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      // No sub-agents.
    }
    return [main, ...names.filter((name) => name.endsWith('.jsonl')).sort().map((name) => path.join(dir, name))];
  }

  async function refresh(id: string): Promise<void> {
    const state = sessions.get(id);
    if (state === undefined) return;
    const alive = () => !stopped && sessions.get(id) === state;
    try {
      const files = await filesOf(state.main);
      const listed = new Set(files);
      for (const file of state.files.keys()) if (!listed.has(file)) state.files.delete(file);
      for (const file of files) {
        const there = await scanFile(state, file, alive);
        if (!alive()) return;
        if (there) continue;
        if (file === state.main) throw new Error('the transcript has gone');
        state.files.delete(file);
      }
      const result = await resultOf(state);
      if (!alive()) return;
      state.result = result;
      state.links = linksOf(state);
      counters.scans++;
    } catch {
      if (!alive()) return;
      state.files.clear();
      state.result = undefined;
      state.links = undefined;
      state.retryAt = now() + retryMs;
    }
  }

  /** The rule, over every file's counts. */
  async function resultOf(state: SessionState): Promise<RepoWorkedIn[]> {
    let total = 0;
    const repos = new Map<string, Count>();
    for (const file of state.files.values()) {
      total += file.calls;
      for (const [key, count] of file.repos) {
        const sum = repos.get(key);
        if (sum === undefined) repos.set(key, { ...count });
        else {
          sum.calls += count.calls;
          sum.changes += count.changes;
          sum.lastAt = Math.max(sum.lastAt, count.lastAt);
        }
      }
    }
    const passing = [...repos].filter(
      ([key, count]) => key !== state.startKey && roots.includes(count.root) && (count.changes > 0 || count.calls * 100 >= WORKED_IN_PERCENT * total),
    );
    // Fresh, not from the cache: one stat for each repo that passes, so one removed since shows at once.
    const there = await Promise.all(passing.map(([key]) => fs.stat(key).then((info) => info.isDirectory(), () => false)));
    return passing
      .filter((_, index) => there[index])
      .sort(([ka, a], [kb, b]) => b.lastAt - a.lastAt || (ka < kb ? -1 : ka > kb ? 1 : 0))
      .map(([key, count]) => ({ key, root: count.root, calls: count.calls, changes: count.changes, lastAt: new Date(count.lastAt).toISOString() }));
  }

  /** Every file's links, the newest of each, newest first and capped (newestLinks()). */
  function linksOf(state: SessionState): PrLink[] {
    const merged = new Map<string, FoundLink>();
    for (const file of state.files.values()) for (const found of file.links.values()) addLink(merged, found);
    return newestLinks(merged.values()).map(toPrLink);
  }

  // --- The queue -----------------------------------------------------------------------------------

  function kick(): void {
    if (running !== undefined || stopped) return;
    running = (async () => {
      for (const cache of caches) cache.prune();
      resolver.prune();
      for (;;) {
        if (stopped) break;
        const id = again.shift() ?? fresh.shift();
        if (id === undefined) break;
        queued.delete(id);
        await refresh(id);
      }
    })().finally(() => {
      running = undefined;
      if (!stopped && (again.length > 0 || fresh.length > 0)) kick();
    });
  }

  return {
    track(list, nextRoots) {
      if (stopped) return;
      try {
        roots = [...nextRoots];
        const listed = new Set<string>();
        for (const session of list) {
          listed.add(session.sessionId);
          if (session.file === undefined) {
            sessions.delete(session.sessionId);
            continue;
          }
          let state = sessions.get(session.sessionId);
          if (state === undefined || state.main !== session.file) {
            state = { main: session.file, startKey: session.startKey, files: new Map(), result: undefined, links: undefined };
            sessions.set(session.sessionId, state);
          }
          state.startKey = session.startKey;
          if (state.retryAt !== undefined && state.retryAt > now()) continue;
          if (queued.has(session.sessionId)) continue;
          queued.add(session.sessionId);
          (state.result === undefined ? fresh : again).push(session.sessionId);
        }
        for (const id of sessions.keys()) if (!listed.has(id)) sessions.delete(id);
        kick();
      } catch {
        // Never fails a poll.
      }
    },
    workedIn(sessionId) {
      const state = sessions.get(sessionId);
      return state?.result?.filter((repo) => repo.key !== state.startKey);
    },
    prLinks(sessionId) {
      return sessions.get(sessionId)?.links;
    },
    async settled() {
      while (running !== undefined) await running;
    },
    stats: () => ({ ...counters }),
    stop() {
      stopped = true;
      again.length = 0;
      fresh.length = 0;
      queued.clear();
      sessions.clear();
    },
  };
}
