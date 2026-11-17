// The transcript side of session lineage (W167), behind the adapter rules: transcript JSONL is
// Claude Code's internal format, so everything that reads it for lineage is here and fails soft.
//
//   findTranscript()   a session's transcript file, by a canonical UUID only (isSessionUuid()): the
//                      file name comes from the id, never from a path in any file. Tries the
//                      directory the cwd encodes to, then every project folder, as the transcript
//                      reader's locate() does.
//   readOpening()      the first 64 KiB of a transcript, only to answer "does it open with /clear?" and
//                      to take its cwd and branch. A cleared session's transcript opens with a user
//                      entry holding `<command-name>/clear</command-name>` (checked on Claude Code
//                      2.1.325); one of the first OPENING_ENTRIES user or system entries is enough,
//                      since a caveat entry can come before it.
//
// Nothing here returns a prompt or any other transcript text: only a boolean, an absolute path and a
// branch name, each cleaned and capped.

import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { hiddenCharacter } from '../shared/hiddenText.js';
import { isRecord } from './guards.js';
import { plainLine } from './text.js';
import { defaultConfigDir, encodeProjectDir, isSessionUuid } from './transcripts.js';

/** How much of a transcript's start is read: its first entries are small, but a snapshot entry can be large. */
export const OPENING_BYTES = 64 * 1024;
/** How many user or system entries are looked at for the `/clear`. */
export const OPENING_ENTRIES = 3;
/** The longest cwd and branch taken. */
export const CWD_MAX = 500;
export const BRANCH_MAX = 255;

const CLEAR_MARKER = '<command-name>/clear</command-name>';
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export interface TranscriptOpening {
  /** The transcript's first user or system entries include the `/clear` command. */
  clear: boolean;
  /** The first entry's absolute working directory, when it has a clean one. */
  cwd?: string;
  /** The first entry's git branch, when it has a clean one. */
  branch?: string;
}

export interface FindOptions {
  /** Default Claude Code's config directory. */
  configDir?: string;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The transcript of `sessionId`, or undefined: not a canonical UUID, not found or unreadable. Never rejects. */
export async function findTranscript(sessionId: string, cwds: readonly string[] = [], options: FindOptions = {}): Promise<string | undefined> {
  if (!isSessionUuid(sessionId)) return undefined;
  const projects = path.join(options.configDir ?? defaultConfigDir(), 'projects');
  const fileName = `${sessionId}.jsonl`;
  try {
    for (const cwd of new Set(cwds)) {
      if (!path.isAbsolute(cwd)) continue;
      const candidate = path.join(projects, encodeProjectDir(cwd), fileName);
      if (await isFile(candidate)) return candidate;
    }
    for (const entry of await readdir(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(projects, entry.name, fileName);
      if (await isFile(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** True for text that is only printable characters: no control, bidi or zero-width character. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/;

/** A working directory from an entry: absolute, clean and short enough, or undefined. */
export function cleanCwd(value: unknown): string | undefined {
  // hiddenCharacter() as well: tag characters, a soft hyphen and other invisibles aren't in UNSAFE (W167's review, F5).
  return typeof value === 'string' && value.length <= CWD_MAX && path.isAbsolute(value) && !UNSAFE.test(value) && hiddenCharacter(value) === undefined ? value : undefined;
}

/** A branch name from an entry: one clean line, or undefined. */
export function cleanBranch(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || value.length > BRANCH_MAX || UNSAFE.test(value)) return undefined;
  return plainLine(value, BRANCH_MAX) === value ? value : undefined;
}

/** What the start of a transcript's text says. Pure: the entries are the whole lines of `text`, a cut last line dropped. */
export function parseOpening(text: string): TranscriptOpening {
  const lines = text.split('\n');
  // The last piece may be cut by the read.
  lines.pop();
  let clear = false;
  let cwd: string | undefined;
  let branch: string | undefined;
  let seen = 0;
  for (const line of lines) {
    if (line === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    if (cwd === undefined) cwd = cleanCwd(entry.cwd);
    if (branch === undefined) branch = cleanBranch(entry.gitBranch);
    if ((entry.type === 'user' || entry.type === 'system') && seen < OPENING_ENTRIES) {
      seen += 1;
      const message = entry.message;
      const content = isRecord(message) ? message.content : entry.content;
      const body = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('\n') : '';
      if (body.includes(CLEAR_MARKER)) clear = true;
    }
  }
  return { clear, ...(cwd === undefined ? {} : { cwd }), ...(branch === undefined ? {} : { branch }) };
}

/** The opening of the transcript at `file`, or undefined when it can't be read as a regular file. Never rejects. */
export async function readOpening(file: string): Promise<TranscriptOpening | undefined> {
  let handle;
  try {
    handle = await open(file, OPEN_FLAGS);
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const size = Math.min(info.size, OPENING_BYTES);
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const { bytesRead } = await handle.read(buffer, read, size - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    // The last line may be cut by the read; parseOpening() drops it.
    return parseOpening(buffer.subarray(0, read).toString('utf8'));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
