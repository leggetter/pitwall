// The job-file adapter (W69, spike 007). A background job's
// `<configDir>/jobs/<shortId>/state.json` holds Claude Code's own one-line `needs`: what the job is
// waiting on you for. It's internal, and documented as not stable, so everything that reads it
// lives here and fails soft: a file that's missing, unreadable, malformed, too big, or written for
// another session is 'unknown', never an exception. `claude agents --json` doesn't carry the line
// (spike 007, finding 2).
//
// What's taken, and nothing else:
//   sessionId  must equal the row's, or the file is 'unknown'
//   needs      a string, trimmed, its control characters and terminal escapes removed, cut to 200;
//              absent, null or empty is 'none', and so is the start placeholder, "send a prompt to
//              start", which a resumed session shows though it asked nothing (spike 006, finding 2)

import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from './guards.js';
import { cap, truncate } from './text.js';
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
}

export interface JobReader {
  /**
   * What the job `shortId` needs, from its `state.json`, checked against the row's `sessionId`. A
   * file whose size and mtime haven't changed since the last read isn't parsed again. Never rejects.
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

/** A short id that's safe as one folder name: never empty, `.` or `..`, and no separator. */
const SAFE_SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Terminal escapes (CSI, OSC and two-character ones), then any control character left: C0, DEL and C1.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]/g;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
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
  const cache = new Map<string, Cached>();

  return {
    async read(shortId, sessionId) {
      if (!SAFE_SHORT_ID.test(shortId)) return UNKNOWN;
      const file = path.join(jobsDir, shortId, 'state.json');
      let handle: FileHandle;
      try {
        handle = await open(file, 'r');
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
          cached.mtimeMs === info.mtimeMs
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
  // Bounded first, so a huge value isn't scanned in full. Line breaks and tabs become spaces, so words don't run together.
  const plain = cap(raw, 8 * NEEDS_MAX).replace(ESCAPES, '').replace(/[\t\n\v\f\r]+/g, ' ').replace(CONTROLS, '');
  return truncate(plain.replace(/\s+/g, ' ').trim(), NEEDS_MAX);
}
