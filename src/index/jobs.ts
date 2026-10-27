// The job-file adapter (W69, spike 007). A background job's
// `<configDir>/jobs/<shortId>/state.json` holds Claude Code's own one-line `needs`: what the job is
// waiting on you for. It's internal, and documented as not stable, so everything that reads it
// lives here and fails soft: a file that's missing, unreadable, malformed, too big, or written for
// another session is 'unknown', never an exception. `claude agents --json` doesn't carry the line
// (spike 007, finding 2).
//
// Only a regular file in a real folder directly under the jobs folder is read: the job's folder may
// not be a symlink, and the file is opened with O_NOFOLLOW and O_NONBLOCK, so a symlink, a FIFO or a
// device there is 'unknown' at once and can't hold up a poll.
//
// What's taken, and nothing else:
//   sessionId  must equal the row's, or the file is 'unknown'
//   needs      a string, trimmed, its control characters, bidi marks and terminal escapes removed,
//              cut to 200;
//              absent, null or empty is 'none', and so is the start placeholder, "send a prompt to
//              start", which a resumed session shows though it asked nothing (spike 006, finding 2)

import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from './guards.js';
import { plainLine } from './text.js';
import { defaultConfigDir } from './transcripts.js';

/** What a job's file says it needs. */
export type JobNeeds =
  /** Claude Code's line, as plain text, at most NEEDS_MAX characters. */
  | { kind: 'needs'; text: string }
  /** The file was read and asks nothing: no line, an empty one, or the start placeholder. */
  | { kind: 'none' }
  /** The file couldn't be used: missing, unreadable, malformed, too big, or another session's. */
  | { kind: 'unknown' };

export interface JobReaderOptions {
  /** The directory holding one folder per job. Default `<configDir>/jobs`, `~/.claude/jobs` unless `$CLAUDE_CONFIG_DIR` is set. */
  jobsDir?: string;
  /** Milliseconds since the epoch, to tell how recently a file changed. Default `Date.now`. */
  now?: () => number;
}

export interface JobReader {
  /**
   * What the job `shortId` needs, from its `state.json`, checked against the row's `sessionId`. A
   * file whose size and mtime haven't changed since the last read isn't parsed again, unless it
   * changed in the last CACHE_SETTLE_MS, when a same-size rewrite could share its mtime. Never rejects.
   */
  read(shortId: string, sessionId: string): Promise<JobNeeds>;
  /** Forgets every job not in `shortIds`. */
  retain(shortIds: ReadonlySet<string>): void;
}

/** The longest `needs` line kept, as NeedsYou.text says. */
export const NEEDS_MAX = 200;
/** A bigger `state.json` is 'unknown': Claude Code's are a few hundred bytes. */
export const JOB_FILE_MAX_BYTES = 256 * 1024;
/** Claude Code's line for a job that was started with no prompt, as a resumed session is. Not an ask. */
export const START_PLACEHOLDER = 'send a prompt to start';

/**
 * A file changed this recently is parsed again whatever the cache says: a rewrite of the same size
 * within one mtime tick would otherwise look unchanged.
 */
export const CACHE_SETTLE_MS = 2000;

/** Read-only, without following a symlink at the file, and without waiting on a FIFO's writer. 0 where a flag doesn't exist. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** A short id that's safe as one folder name: never empty, `.` or `..`, and no separator. */
const SAFE_SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const UNKNOWN: JobNeeds = { kind: 'unknown' };
const NONE: JobNeeds = { kind: 'none' };

interface Cached {
  file: string;
  sessionId: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  needs: JobNeeds;
}

export function createJobReader(options: JobReaderOptions = {}): JobReader {
  const jobsDir = options.jobsDir ?? path.join(defaultConfigDir(), 'jobs');
  const now = options.now ?? Date.now;
  const cache = new Map<string, Cached>();

  return {
    async read(shortId, sessionId) {
      if (!SAFE_SHORT_ID.test(shortId)) return UNKNOWN;
      const folder = path.join(jobsDir, shortId);
      const file = path.join(folder, 'state.json');
      let handle: FileHandle;
      try {
        // The job's folder itself, not where a symlink there points; the jobs folder may be a symlink.
        if (!(await lstat(folder)).isDirectory()) throw new Error('not a folder');
        handle = await open(file, OPEN_FLAGS);
      } catch {
        cache.delete(shortId);
        return UNKNOWN;
      }
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > JOB_FILE_MAX_BYTES) {
          cache.delete(shortId);
          return UNKNOWN;
        }
        const cached = cache.get(shortId);
        if (
          cached !== undefined &&
          cached.file === file &&
          cached.sessionId === sessionId &&
          cached.dev === info.dev &&
          cached.ino === info.ino &&
          cached.size === info.size &&
          cached.mtimeMs === info.mtimeMs &&
          now() - info.mtimeMs >= CACHE_SETTLE_MS
        ) {
          return cached.needs;
        }
        const needs = parseJobState(await handle.readFile('utf8'), sessionId);
        cache.set(shortId, { file, sessionId, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, needs });
        return needs;
      } catch {
        cache.delete(shortId);
        return UNKNOWN;
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
    retain(shortIds) {
      for (const id of cache.keys()) if (!shortIds.has(id)) cache.delete(id);
    },
  };
}

/** What a `state.json`'s text says the job needs, for the session `sessionId`. Pure; never throws. */
export function parseJobState(text: string, sessionId: string): JobNeeds {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return UNKNOWN;
  }
  if (!isRecord(parsed) || parsed.sessionId !== sessionId) return UNKNOWN;
  const needs = parsed.needs;
  if (needs === undefined || needs === null) return NONE;
  if (typeof needs !== 'string') return UNKNOWN;
  const line = needsText(needs);
  if (line === '' || line.toLowerCase() === START_PLACEHOLDER) return NONE;
  return { kind: 'needs', text: line };
}

/** Claude Code's line as plain text: escapes and control characters removed, on one line, trimmed, at most NEEDS_MAX. */
export function needsText(raw: string): string {
  return plainLine(raw, NEEDS_MAX);
}
