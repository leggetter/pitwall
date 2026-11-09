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
//   children   W170: the one pull request it links, when its `pr` children name exactly one, each
//              `href` exactly `https://github.com/<owner>/<name>/pull/<n>` (prRefOfUrl()). Claude
//              Code lists the PRs a job made or touched there, `{ kind: "pr", id, href }`, and a
//              long-running one can list dozens, so with more than one none is taken: pitwall can't
//              tell which one it waits on. Anything else there, or a malformed entry, is left out
//              without making the file 'unknown': the line on what it needs still counts.
//
// And, for a resume's card only (W129, the re-review's L1), readSavedPermission(): the permission
// mode in the job's `respawnFlags`, the flags Claude Code saved when the job started and wakes it
// with on `claude --resume` ("woke session <id> with its saved options", spike 011). An array of
// strings, such as `["--name", "n", "--permission-mode", "plan", "--model", "haiku"]` (W129, checked
// live on Claude Code 2.1.316): `--permission-mode <mode>` or `--permission-mode=<mode>` is taken
// when it's one of Claude Code's mode names, `--dangerously-skip-permissions` reads as
// bypassPermissions, and anything else is 'unknown', never shown.

import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { PERMISSION_MODES, type JobPr, type PermissionModeName, type SavedPermission } from '../shared/protocol.js';
import { isRecord } from './guards.js';
import { prRefOfUrl } from './prLinks.js';
import { plainLine } from './text.js';
import { defaultConfigDir } from './transcripts.js';

/** What a job's file says it needs, and the one PR it links, if it links just one (W170). */
export type JobNeeds =
  /** Claude Code's line, as plain text, at most NEEDS_MAX characters. */
  | { kind: 'needs'; text: string; pr?: JobPr }
  /** The file was read and asks nothing: no line, an empty one, or the start placeholder. */
  | { kind: 'none'; pr?: JobPr }
  /** The file couldn't be used: missing, unreadable, malformed, too big, or another session's. */
  | { kind: 'unknown' };

/** The most `children` entries looked at: Claude Code's are a few, and dozens for a long-running job. */
export const CHILDREN_MAX = 500;

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

/** What a `state.json`'s text says the job's saved permission mode is, for the session `sessionId`. Pure; never throws. */
export function parseSavedPermission(text: string, sessionId: string): SavedPermission {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unknown' };
  }
  if (!isRecord(parsed) || parsed.sessionId !== sessionId) return { kind: 'unknown' };
  const flags = parsed.respawnFlags;
  if (!Array.isArray(flags) || flags.length > 200 || !flags.every((flag) => typeof flag === 'string')) return { kind: 'unknown' };
  let found: PermissionModeName | undefined;
  let unknown = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i] as string;
    let value: string | undefined;
    if (flag === '--dangerously-skip-permissions') value = 'bypassPermissions';
    else if (flag === '--permission-mode') value = flags[++i] ?? '';
    else if (flag.startsWith('--permission-mode=')) value = flag.slice('--permission-mode='.length);
    else continue;
    if (!(PERMISSION_MODES as readonly string[]).includes(value)) {
      unknown = true;
      continue;
    }
    // Skipping permissions wins over any mode beside it.
    if (found !== 'bypassPermissions') found = value as PermissionModeName;
  }
  // Bypassed wins whatever else is there, an unknown mode included, so its warning never drops (#133's re-check).
  if (found === 'bypassPermissions') return { kind: 'mode', mode: found };
  if (unknown) return { kind: 'unknown' };
  return found === undefined ? { kind: 'unset' } : { kind: 'mode', mode: found };
}

/**
 * The saved permission mode of the background job `shortId`, from its `state.json`, checked against
 * `sessionId`, read as read() reads, without a cache: only for a resume's card. Never rejects.
 */
export async function readSavedPermission(shortId: string, sessionId: string, options: Pick<JobReaderOptions, 'jobsDir'> = {}): Promise<SavedPermission> {
  const text = await readJobFile(options.jobsDir ?? path.join(defaultConfigDir(), 'jobs'), shortId);
  return text === undefined ? { kind: 'unknown' } : parseSavedPermission(text, sessionId);
}

/** A job's `state.json` as text, by read()'s rules, or undefined when it can't be used. */
async function readJobFile(jobsDir: string, shortId: string): Promise<string | undefined> {
  if (!SAFE_SHORT_ID.test(shortId)) return undefined;
  const folder = path.join(jobsDir, shortId);
  let handle: FileHandle;
  try {
    if (!(await lstat(folder)).isDirectory()) return undefined;
    handle = await open(path.join(folder, 'state.json'), OPEN_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > JOB_FILE_MAX_BYTES) return undefined;
    return await handle.readFile('utf8');
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
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
  if (needs !== undefined && needs !== null && typeof needs !== 'string') return UNKNOWN;
  const pr = onlyPrOf(parsed.children);
  const withPr = pr === undefined ? {} : { pr };
  const line = typeof needs === 'string' ? needsText(needs) : '';
  if (line === '' || line.toLowerCase() === START_PLACEHOLDER) return pr === undefined ? NONE : { kind: 'none', ...withPr };
  return { kind: 'needs', text: line, ...withPr };
}

/**
 * The one PR a job's `children` link (W170): the `pr` entries' `href`s, when every one that is a PR
 * URL names the same PR. Undefined for none, for more than one, and for anything that isn't an array.
 * An entry of another kind, or a `pr` entry whose `href` isn't a PR URL, is passed over.
 */
export function onlyPrOf(children: unknown): JobPr | undefined {
  if (!Array.isArray(children) || children.length > CHILDREN_MAX) return undefined;
  let found: JobPr | undefined;
  for (const child of children) {
    if (!isRecord(child) || child.kind !== 'pr') continue;
    const ref = prRefOfUrl(child.href);
    if (ref === undefined) continue;
    if (found !== undefined && (found.repo !== ref.repo || found.number !== ref.number)) return undefined;
    found = { repo: ref.repo, number: ref.number };
  }
  return found;
}

/** Claude Code's line as plain text: escapes and control characters removed, on one line, trimmed, at most NEEDS_MAX. */
export function needsText(raw: string): string {
  return plainLine(raw, NEEDS_MAX);
}
