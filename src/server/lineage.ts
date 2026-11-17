// Session lineage (W167): what a session continues, and what continues it. Phil, 2026-11-09:
// "sessions tend to focus on the same thing even after `/clear` is run. So, I want an agent to
// easily be able to track the continuation before and after the `/clear` run."
//
//   $PITWALL_HOME/lineage.jsonl, 0600, one JSON line per link between two sessions:
//     {v, at, from, to, how, job?, cwd?, branch?, inferred?}
//   `from` is the earlier session and `to` the one that carries on. `how` is `clear` (the same job or
//   process got a new session id, Claude Code's /clear) or `continue` (a session pitwall started to
//   carry on from another, W168's card). `job` is a background job's short id. `inferred` marks a
//   `clear` pitwall worked out afterwards, from a job's state.json and the new transcript's opening,
//   rather than saw in a poll.
//
//   Ids, paths and a branch name only: never a prompt, a name, a title, a recap or any other session
//   content. Every field is checked before it's written (parseLine()) and again when it's read, so a
//   file that was tampered with is read as untrusted. Written like the flag log (W153): opened
//   without following a link, appended, 0600, past LINEAGE_LOG_MAX_BYTES rewritten by rename with its
//   newest half. Fails soft: a failed write is dropped, the links hold in memory for this run.
//
// Sources (record() takes all three):
//   observe()    live: between two polls of `claude agents --json --all` (documented), the same
//                background job id lists a new sessionId with a live worker (a pid), and the old one
//                isn't listed. A row that's gone isn't a clear, and nor is a row with no worker: a
//                finished or stopped job lists its first session id again, not its latest (W167's
//                review, F1). Interactive sessions aren't diffed: a pid listing a new id could as well
//                be an in-process /resume to an older conversation (F2).
//   backfill()   inferred: what happened while pitwall wasn't running. A job whose state.json
//                (internal, behind src/index/jobs.ts) names a first and a latest session id, when the
//                latest one's transcript opens with /clear (src/index/lineageSources.ts).
//   record()     `continue`, for W168's card, which knows both ids; also what the other two call.
//
// One line per change: the same from-and-to pair is never written twice, so a restart that sees
// the same listing again adds nothing.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { listedSessionIds, type AgentRow, type AgentsResult } from '../index/agents.js';
import { isRecord } from '../index/guards.js';
import { readJobSessionIds, type JobSessionIds } from '../index/jobs.js';
import { cleanBranch, cleanCwd, findTranscript, readOpening, type TranscriptOpening } from '../index/lineageSources.js';
import { isSessionUuid } from '../index/transcripts.js';
import type { IndexSnapshot, SessionLineageLinks } from '../shared/protocol.js';
import { ensureLaunchDir } from './launch.js';
import { createDecoratedView } from './snapshotRecaps.js';
import type { SnapshotView } from './snapshotLinks.js';

/** The log's name in pitwall's home. */
export const LINEAGE_LOG_NAME = 'lineage.jsonl';
/** Past this, a write keeps the newest half: about 4,000 typical links, fewer with long paths. */
export const LINEAGE_LOG_MAX_BYTES = 1024 * 1024;
/** The most links held in memory; past it the oldest goes. */
export const LINKS_HELD_MAX = 5000;
/** The longest chain walked either way. */
export const CHAIN_MAX = 50;
/** A background job's short id, as Claude Code names its folder in ~/.claude/jobs. */
const SAFE_SHORT_ID = /^[0-9a-f]{8}$/;
/** A time as toISOString() writes it, so no free text rides in `at` (review F3). */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const HOWS = ['clear', 'continue'] as const;
export type LineageHow = (typeof HOWS)[number];

/** One line of the log. */
export interface LineageLine {
  v: 1;
  /** ISO 8601. */
  at: string;
  /** The earlier session. */
  from: string;
  /** The session that carries on. */
  to: string;
  how: LineageHow;
  /** The background job's short id, when the link is a job's. */
  job?: string;
  cwd?: string;
  branch?: string;
  /** Worked out afterwards, not seen in a poll. */
  inferred?: true;
}

/** What record() takes: a line without its version and time. */
export type NewLink = Omit<LineageLine, 'v' | 'at'>;

const isTime = (value: unknown): value is string => typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value));
/** Real session ids are UUIDs; anything looser could carry words into the supervisor's fields (review F4). */
const isId = (value: unknown): value is string => typeof value === 'string' && isSessionUuid(value);

/** One line of the log, checked field by field, or undefined. Unknown fields are dropped. */
export function parseLine(raw: string): LineageLine | undefined {
  if (raw.trim() === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.v !== 1 || !isTime(value.at) || !isId(value.from) || !isId(value.to) || value.from === value.to) return undefined;
  if (!(HOWS as readonly unknown[]).includes(value.how)) return undefined;
  const line: LineageLine = { v: 1, at: value.at, from: value.from, to: value.to, how: value.how as LineageHow };
  if (typeof value.job === 'string' && SAFE_SHORT_ID.test(value.job)) line.job = value.job;
  const cwd = cleanCwd(value.cwd);
  if (cwd !== undefined) line.cwd = cwd;
  const branch = cleanBranch(value.branch);
  if (branch !== undefined) line.branch = branch;
  if (value.inferred === true) line.inferred = true;
  return line;
}

/**
 * The lines of the log at `file` that check out, oldest first; none when there's no log or it can't
 * be trusted: not a regular file of this user's, a link, writable by group or others, or over
 * LINEAGE_LOG_MAX_BYTES * 2. For the store and scripts/lineage.ts.
 */
export function readLineageLog(file: string): LineageLine[] {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0 || stat.size > LINEAGE_LOG_MAX_BYTES * 2) return [];
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    return buffer
      .subarray(0, read)
      .toString('utf8')
      .split('\n')
      .map(parseLine)
      .filter((line): line is LineageLine => line !== undefined);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A session in a chain: the link that leads to it from the session asked about. */
export type ChainLink = LineageLine;

/** The chain around a session, nearest first each way. */
export interface LineageChain {
  /** The sessions it continues, nearest first: `back[0].to` is the session, `back[0].from` its predecessor. */
  back: ChainLink[];
  /** The sessions that continue it, nearest first: `forward[0].from` is the session. */
  forward: ChainLink[];
}

/**
 * The chain around `sessionId` in `lines`, oldest line first. Each step takes the newest line, a
 * non-inferred one before an inferred one, so a session continued twice follows its latest successor.
 * Stops at CHAIN_MAX links or a session already seen, so a cycle in a tampered file ends.
 */
export function chainOf(lines: readonly LineageLine[], sessionId: string): LineageChain {
  return chainIn(indexLines(lines), sessionId);
}

/** The newest line into and out of each session, a non-inferred one before an inferred one. */
export interface LineIndex {
  byTo: Map<string, LineageLine>;
  byFrom: Map<string, LineageLine>;
}

export function indexLines(lines: readonly LineageLine[]): LineIndex {
  const byTo = new Map<string, LineageLine>();
  const byFrom = new Map<string, LineageLine>();
  const better = (a: LineageLine | undefined, b: LineageLine): LineageLine => (a === undefined || b.inferred !== true || a.inferred === true ? b : a);
  for (const line of lines) {
    byTo.set(line.to, better(byTo.get(line.to), line));
    byFrom.set(line.from, better(byFrom.get(line.from), line));
  }
  return { byTo, byFrom };
}

export function chainIn(index: LineIndex, sessionId: string): LineageChain {
  const walk = (start: string, next: (id: string) => LineageLine | undefined, step: (line: LineageLine) => string): ChainLink[] => {
    const seen = new Set<string>([start]);
    const links: ChainLink[] = [];
    for (let id = start; links.length < CHAIN_MAX; ) {
      const line = next(id);
      if (line === undefined) break;
      const following = step(line);
      if (seen.has(following)) break;
      seen.add(following);
      links.push(line);
      id = following;
    }
    return links;
  };
  return { back: walk(sessionId, (id) => index.byTo.get(id), (line) => line.from), forward: walk(sessionId, (id) => index.byFrom.get(id), (line) => line.to) };
}

export interface LineageStoreOptions {
  /** pitwall's home. Without one, links are held in memory only and nothing is logged. */
  home?: string;
  now?: () => Date;
  /** The jobs folder, for tests. Default Claude Code's. */
  jobsDir?: string;
  /** Claude Code's config directory, for tests. */
  configDir?: string;
}

/** What observe() remembers of a listed session. */
interface Seen {
  sessionId: string;
  cwd: string;
}

/** The links held, their log, and the snapshot's decoration. */
export class LineageStore {
  readonly #file: string | undefined;
  readonly #home: string | undefined;
  readonly #now: () => Date;
  readonly #jobsDir: string | undefined;
  readonly #configDir: string | undefined;
  #lines: LineageLine[] = [];
  readonly #pairs = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #version = 0;
  #indexed: { version: number; index: LineIndex } | undefined;
  /** The last listing's background rows by job short id. */
  #jobs = new Map<string, Seen>();
  /** Jobs backfilled this run, by short id and the session id the listing gave. */
  readonly #backfilled = new Set<string>();
  #backfilling = false;

  constructor(options: LineageStoreOptions = {}) {
    this.#home = options.home === undefined ? undefined : path.resolve(options.home);
    this.#file = this.#home === undefined ? undefined : path.join(this.#home, LINEAGE_LOG_NAME);
    this.#now = options.now ?? (() => new Date());
    this.#jobsDir = options.jobsDir;
    this.#configDir = options.configDir;
    if (this.#file !== undefined) for (const line of readLineageLog(this.#file)) this.#hold(line);
  }

  /** Every link held, oldest first. */
  lines(): readonly LineageLine[] {
    return this.#lines;
  }

  /** The chain around `sessionId`. */
  chain(sessionId: string): LineageChain {
    return chainIn(this.#index(), sessionId);
  }

  #index(): LineIndex {
    if (this.#indexed === undefined || this.#indexed.version !== this.#version) this.#indexed = { version: this.#version, index: indexLines(this.#lines) };
    return this.#indexed.index;
  }

  /** The session `sessionId` continues, and the one that continues it, nearest only. */
  linksOf(sessionId: string): SessionLineageLinks {
    const { back, forward } = this.chain(sessionId);
    const links: SessionLineageLinks = {};
    if (back[0] !== undefined) links.from = back[0].from;
    if (forward[0] !== undefined) links.to = forward[0].to;
    return links;
  }

  /**
   * Records that `to` carries on from `from`, unless that pair is held already, isn't two
   * different, valid session ids, or would close a loop: `from` already carries on from `to`,
   * directly or along the chain (review F1). Writes one line. Returns whether it did. Never throws.
   */
  record(link: NewLink): boolean {
    const line = parseLine(JSON.stringify({ ...link, v: 1, at: this.#now().toISOString() }));
    if (line === undefined || this.#pairs.has(pairKey(line))) return false;
    if (this.chain(line.to).forward.some((step) => step.to === line.from)) return false;
    this.#hold(line);
    this.#append(line);
    for (const listener of [...this.#listeners]) listener();
    return true;
  }

  /**
   * Live `clear`s from a successful listing of `claude agents --json --all`: a background row with a
   * live worker whose job id was listed last time with another session id that is no longer listed.
   * A row with no worker keeps what was remembered for its job, since a finished job lists its first
   * session id, not its latest. The first listing only remembers. Never throws.
   */
  observe(result: Extract<AgentsResult, { ok: true }>): void {
    try {
      const listed = listedSessionIds(result);
      const jobs = new Map<string, Seen>();
      // A job id that more than one row names is ambiguous: neither a clear nor remembered.
      const count = new Map<string, number>();
      for (const row of result.rows) if (row.shortId !== undefined) count.set(row.shortId, (count.get(row.shortId) ?? 0) + 1);
      for (const row of result.rows) {
        if (row.kind !== 'background' || row.shortId === undefined || !SAFE_SHORT_ID.test(row.shortId) || count.get(row.shortId)! > 1) continue;
        const before = this.#jobs.get(row.shortId);
        if (before !== undefined && before.sessionId !== row.sessionId && row.pid === undefined) {
          // No worker: the listing has fallen back to the job's first id. Keep the latest one seen.
          jobs.set(row.shortId, before);
          continue;
        }
        if (before !== undefined && before.sessionId !== row.sessionId && !listed.has(before.sessionId)) this.#clear(before, row, row.shortId);
        jobs.set(row.shortId, { sessionId: row.sessionId, cwd: row.cwd });
      }
      this.#jobs = jobs;
    } catch {
      // Lineage never breaks a poll.
    }
  }

  #clear(before: Seen, row: AgentRow, job: string): void {
    this.record({ from: before.sessionId, to: row.sessionId, how: 'clear', job, cwd: row.cwd });
  }

  /**
   * Inferred `clear`s for what happened while pitwall wasn't running: each listed background job
   * whose state.json names a first and a latest session id that aren't linked yet, when the latest
   * one's transcript opens with /clear. Once per job and listed session id per run, one job at a
   * time, in the background. Never throws or rejects.
   */
  backfill(result: Extract<AgentsResult, { ok: true }>): void {
    if (this.#backfilling) return;
    const todo = result.rows.filter((row) => row.kind === 'background' && row.shortId !== undefined && SAFE_SHORT_ID.test(row.shortId) && !this.#backfilled.has(`${row.shortId}:${row.sessionId}`));
    if (todo.length === 0) return;
    this.#backfilling = true;
    void (async () => {
      try {
        for (const row of todo) {
          this.#backfilled.add(`${row.shortId}:${row.sessionId}`);
          await this.#backfillJob(row);
        }
      } catch {
        // Fails soft.
      } finally {
        this.#backfilling = false;
      }
    })();
  }

  async #backfillJob(row: AgentRow): Promise<void> {
    const shortId = row.shortId!;
    const ids: JobSessionIds | undefined = await readJobSessionIds(shortId, this.#jobsDir === undefined ? {} : { jobsDir: this.#jobsDir });
    if (ids?.latest === undefined) return;
    // Already linked to something earlier, or a pair pitwall has: nothing to infer.
    if (this.#pairs.has(`${ids.first}>${ids.latest}`) || this.#lines.some((line) => line.to === ids.latest)) return;
    const found = this.#configDir === undefined ? {} : { configDir: this.#configDir };
    const file = await findTranscript(ids.latest, [row.cwd], found);
    if (file === undefined) return;
    const opening: TranscriptOpening | undefined = await readOpening(file);
    if (opening === undefined || !opening.clear) return;
    this.record({
      from: ids.first,
      to: ids.latest,
      how: 'clear',
      job: shortId,
      cwd: opening.cwd ?? row.cwd,
      ...(opening.branch === undefined ? {} : { branch: opening.branch }),
      inferred: true,
    });
  }

  /** `snapshot` with `lineage` on each session that continues or is continued. A copy when any session changed. */
  decorate(snapshot: IndexSnapshot): IndexSnapshot {
    if (this.#lines.length === 0) return snapshot;
    let changed = false;
    const groups = snapshot.groups.map((group) => {
      let groupChanged = false;
      const sessions = group.sessions.map((session) => {
        const lineage = this.linksOf(session.sessionId);
        if (lineage.from === undefined && lineage.to === undefined) return session;
        groupChanged = true;
        return { ...session, lineage };
      });
      if (!groupChanged) return group;
      changed = true;
      return { ...group, sessions };
    });
    return changed ? { ...snapshot, groups } : snapshot;
  }

  /** Changes whenever decorate() could answer differently for the same snapshot. */
  version(): number {
    return this.#version;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #hold(line: LineageLine): void {
    const key = pairKey(line);
    if (this.#pairs.has(key)) return;
    this.#pairs.add(key);
    this.#lines.push(line);
    this.#version += 1;
    if (this.#lines.length > LINKS_HELD_MAX) {
      const dropped = this.#lines.shift()!;
      this.#pairs.delete(pairKey(dropped));
    }
  }

  /** Appends `line`; past LINEAGE_LOG_MAX_BYTES, rewrites the log with its newest half first. Fails soft. */
  #append(line: LineageLine): void {
    if (this.#file === undefined || this.#home === undefined) return;
    const text = `${JSON.stringify(line)}\n`;
    let fd: number | undefined;
    try {
      ensureLaunchDir(this.#home);
      fd = openSync(this.#file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const stat = fstatSync(fd);
      const uid = process.getuid?.();
      if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) return;
      if (stat.size + Buffer.byteLength(text) <= LINEAGE_LOG_MAX_BYTES) {
        writeSync(fd, text);
        return;
      }
      closeSync(fd);
      fd = undefined;
      this.#rewrite(text);
    } catch {
      // The link holds in memory for this run.
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Already closed.
        }
      }
    }
  }

  /** The log's newest lines, up to half of LINEAGE_LOG_MAX_BYTES, then `text`, written by rename. */
  #rewrite(text: string): void {
    const file = this.#file!;
    const kept: string[] = [];
    let size = Buffer.byteLength(text);
    const lines = readLineageLog(file).map((line) => `${JSON.stringify(line)}\n`);
    for (let i = lines.length - 1; i >= 0; i--) {
      const bytes = Buffer.byteLength(lines[i]!);
      if (size + bytes > LINEAGE_LOG_MAX_BYTES / 2) break;
      kept.unshift(lines[i]!);
      size += bytes;
    }
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, kept.join('') + text, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // Never written.
      }
      throw error;
    }
  }
}

function pairKey(line: Pick<LineageLine, 'from' | 'to'>): string {
  return `${line.from}>${line.to}`;
}

/** `source`'s snapshots with each continued or continuing session's `lineage`. */
export function createLineageView(source: Pick<SnapshotView, 'latest' | 'subscribe'>, store: LineageStore): SnapshotView {
  return createDecoratedView(source, { decorate: (snapshot) => store.decorate(snapshot), version: () => store.version(), subscribe: (listener) => store.subscribe(listener) });
}
