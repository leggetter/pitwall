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
//   readDerivedFrom()  the same first 64 KiB, only for Claude Code's `derived-from` entry (W218, spike
//                      021, finding 2; undocumented, seen on 2.1.332): the session that launched this one
//                      with `claude --bg` from its shell (`via: "launch"`), and the one this one carries on
//                      from after /clear (`via: "clear"`). Its shape:
//                        {"type":"derived-from","v":1,"sessionId":"<this one>","sessions":[
//                          {"type":"claude_code_session","id":"<other>","via":"launch","started":"<this one>"}]}
//                      Only an entry whose `sessionId` is the transcript's own, at `v` 1, with each id a
//                      canonical UUID other than its own, is taken; anything else is skipped.
//
// Nothing here returns a prompt or any other transcript text: only a boolean, an absolute path, a
// branch name and session ids, each cleaned and capped.

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

/** What a transcript's `derived-from` entry says (W218): session ids only. */
export interface DerivedFrom {
  /** The session that started this one with `claude --bg` from its shell. */
  launchedBy?: string;
  /** The session this one carries on from after /clear. */
  clearedFrom?: string;
}

/** How many entries of `sessions` are looked at; Claude Code writes one or two. */
const DERIVED_SESSIONS_MAX = 4;

/**
 * The `derived-from` entry of session `sessionId` in the start of its transcript, `text`: the first one
 * that checks out, or undefined. Pure; a cut last line is dropped.
 */
export function parseDerivedFrom(text: string, sessionId: string): DerivedFrom | undefined {
  if (!isSessionUuid(sessionId)) return undefined;
  const lines = text.split('\n');
  lines.pop();
  for (const line of lines) {
    // Cheap first: most lines aren't it, and some are large.
    if (!line.includes('"derived-from"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.type !== 'derived-from' || entry.v !== 1 || entry.sessionId !== sessionId || !Array.isArray(entry.sessions)) continue;
    const found: DerivedFrom = {};
    for (const each of (entry.sessions as unknown[]).slice(0, DERIVED_SESSIONS_MAX)) {
      if (!isRecord(each) || each.type !== 'claude_code_session' || typeof each.id !== 'string' || !isSessionUuid(each.id) || each.id === sessionId) continue;
      if (each.via === 'launch' && found.launchedBy === undefined) found.launchedBy = each.id;
      if (each.via === 'clear' && found.clearedFrom === undefined) found.clearedFrom = each.id;
    }
    return found;
  }
  return undefined;
}

/** The first OPENING_BYTES of the regular file at `file`, as text, or undefined. Never rejects. */
async function readStart(file: string): Promise<string | undefined> {
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
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The `derived-from` entry in the start of `sessionId`'s transcript at `file`: `{}` when it has none,
 * undefined when the file couldn't be read. Never rejects.
 */
export async function readDerivedFrom(file: string, sessionId: string): Promise<DerivedFrom | undefined> {
  const text = await readStart(file);
  return text === undefined ? undefined : (parseDerivedFrom(text, sessionId) ?? {});
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
