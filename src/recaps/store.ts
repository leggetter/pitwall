// Recaps kept across restarts (W132; reverses D26's "not now"): each session's newest recap of
// pitwall's own, so a restart, or a second pitwall on the same home, doesn't make every session's
// recap again. One file per session, in a 0700 folder of pitwall's own beside `recap/`, never in it:
//
//   $PITWALL_HOME/recap-store/<session uuid>.json   0600
//   {"version":1,"sessionId":"<uuid>","at":"<ISO>","throughAt":"<ISO>",
//    "recap":{"summary":"…","todos":[{"text":"…","owner":"you"}],"waitingOn":"you","title":"…",
//             "goal":"…","workingOn":"…","plan":"…",
//             "items":[{"text":"…","state":"now"}],"changes":"…"}}
//
// What's kept is the recap as the page shows it and nothing more: its summary, to-dos, what it waits
// on and its title, since W150 (the recap strip gives the picture) its goal, working on and plan, and
// since W172 (the plan is part of the recap) the plan's items and how it changed, in the answer's own
// keys, `items` and `changes` ("" for none), only when the plan isn't empty, as the model answered and
// pitwall's strict reading kept them; when it was made;
// and `throughAt`, the newest transcript entry it covers, which says whether the session has moved on
// since. No transcript excerpt, prompt, name, directory, token or cost.
//
// Written by rename, so a reader sees the old file or the new one, never half of one. Read as
// untrusted: the folder must be a real directory of this user's with no group or other access
// (ensureLaunchDir()), each file a regular file of this user's, not a link, not writable by group or
// others, at most MAX_BYTES, with exactly these fields, this version, the session id its name says,
// canonical times, and a recap that readRecapAnswer() (prompt.ts), the check a model's answer gets,
// takes back unchanged. A recap kept before W150, without the three, still loads, at the same
// version: a version 2 would gain nothing, since a pitwall from before W150 ignores a file with the
// three either way, as it would one of another version, and makes that session's recap again. The
// same holds for W172's two: one kept before it loads without them, and a pitwall from before it
// ignores a file with them. Anything else is ignored and counted, never a crash, and never shown.
//
// A file is removed when its session leaves the list for good (the engine's call, remove()), and at
// load once both its times are older than RECAP_KEEP_MS. Writing fails soft: the recap in memory
// still holds for this run.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isRecord } from '../index/guards.js';
import { isSessionUuid } from '../index/transcripts.js';
import { ENDED_LISTED_DAYS, type SessionRecap } from '../shared/protocol.js';
import { ensureLaunchDir } from '../server/launch.js';
import { readRecapAnswer, todoOf } from './prompt.js';

/** The folder's name in pitwall's home. */
export const RECAP_STORE_DIR_NAME = 'recap-store';

/** The file format's version: a file with any other is ignored. */
export const RECAP_STORE_VERSION = 1;

/**
 * How long a recap is kept, from the newer of when it was made and the newest entry it covers:
 * ENDED_LISTED_DAYS, 30, the longest pitwall lists a session that has ended (D17, Show older), and
 * Claude Code's own default for keeping the transcript it summarises (`cleanupPeriodDays`). Past it,
 * the session is very likely gone from the list, and a running one that isn't costs one call.
 */
export const RECAP_KEEP_MS = ENDED_LISTED_DAYS * 24 * 60 * 60 * 1000;

/**
 * The most read of a file. A real one is under 8 KiB: a summary, up to 6 to-dos, a goal, a working on
 * and a plan line, each at most RECAP_FIELD_MAX (400) characters, and a title of at most 120, are
 * about 4,120 characters, 16.5 KB at 4 bytes a character, so W150's three fields raised it from 16 KiB.
 * W172's items, up to PLAN_ITEMS_MAX (15) of PLAN_ITEM_MAX (200) characters, and its changes, at most
 * 400, add 3,400 characters, 7,520 in all, about 30 KB at 4 bytes a character with the JSON around
 * them, so 40 KiB.
 */
export const RECAP_STORE_MAX_BYTES = 40 * 1024;

/** The most files read at load: pitwall lists at most ENDED_LISTED_MAX ended sessions, plus those running. */
export const RECAP_STORE_MAX_FILES = 1000;

/** How far ahead of now a time may be, for a clock that has moved back a little. */
const FUTURE_SLACK_MS = 5 * 60_000;

/** A temporary file left by a write that never reached its rename is removed at load once it's this old. */
const TEMP_MAX_AGE_MS = 10 * 60_000;

/** What load() found. */
export interface StoredRecaps {
  /** Usable recaps, by session id, each with source 'pitwall'. */
  recaps: Map<string, SessionRecap>;
  /** Files that weren't usable: odd, too big, the wrong shape or version, or past RECAP_STORE_MAX_FILES. */
  ignored: number;
  /** Files older than RECAP_KEEP_MS, removed. */
  expired: number;
}

/** Where recaps are kept. None of its methods throws. */
export interface RecapStore {
  /** The kept recaps, at `nowMs`. Removes expired files. */
  load(nowMs: number): StoredRecaps;
  /** Keeps `recap` as the session's, replacing any before it. Only pitwall's own recaps are kept. */
  save(sessionId: string, recap: SessionRecap): void;
  /** Forgets the session's recap. */
  remove(sessionId: string): void;
}

/** A store in memory only, for tests: what was saved, as the file would hold it. */
export function memoryRecapStore(initial: ReadonlyMap<string, SessionRecap> = new Map()): RecapStore & { current(): Map<string, SessionRecap> } {
  const kept = new Map<string, string>();
  for (const [id, recap] of initial) kept.set(id, storedText(id, recap));
  return {
    load(nowMs) {
      const recaps = new Map<string, SessionRecap>();
      let ignored = 0;
      let expired = 0;
      for (const [id, text] of kept) {
        const read = parseStoredRecap(text, id, nowMs);
        if (read === 'expired') {
          kept.delete(id);
          expired++;
        } else if (read === undefined) ignored++;
        else recaps.set(id, read);
      }
      return { recaps, ignored, expired };
    },
    save(sessionId, recap) {
      if (isSessionUuid(sessionId) && recap.source === 'pitwall') kept.set(sessionId, storedText(sessionId, recap));
    },
    remove(sessionId) {
      kept.delete(sessionId);
    },
    current() {
      const out = new Map<string, SessionRecap>();
      for (const [id, text] of kept) {
        const read = parseStoredRecap(text, id, Number.MAX_SAFE_INTEGER / 2, { ignoreAge: true });
        if (read !== undefined && read !== 'expired') out.set(id, read);
      }
      return out;
    },
  };
}

/**
 * The file's text for a recap: these fields alone, in this order; the goal, working on and plan only
 * when it has all three (W150), and the plan's items and changes, as `items` and `changes`, only with
 * them and the items (W172).
 */
export function storedText(sessionId: string, recap: SessionRecap): string {
  const { goal, workingOn, plan, planItems, planChanges } = recap;
  const items = planItems === undefined ? {} : { items: planItems.map(({ text, state }) => ({ text, state })), changes: planChanges ?? '' };
  const picture = goal === undefined || workingOn === undefined || plan === undefined ? {} : { goal, workingOn, plan, ...items };
  return `${JSON.stringify({
    version: RECAP_STORE_VERSION,
    sessionId,
    at: recap.at,
    throughAt: recap.throughAt,
    recap: { summary: recap.summary, todos: recap.todos.map(todoOf), waitingOn: recap.waitingOn, title: recap.title, ...picture },
  })}\n`;
}

const FILE_KEYS = ['version', 'sessionId', 'at', 'throughAt', 'recap'] as const;

/** Exactly `keys`, no more and no fewer. */
function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** A time as pitwall writes one, toISOString()'s, and not after `nowMs` by more than FUTURE_SLACK_MS; else NaN. */
function storedTime(raw: unknown, nowMs: number): number {
  if (typeof raw !== 'string' || raw.length !== 24) return NaN;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== raw) return NaN;
  return ms > nowMs + FUTURE_SLACK_MS ? NaN : ms;
}

/**
 * A kept recap read from `text`, the file for `sessionId`, checked as above: the recap, 'expired'
 * once both its times are older than RECAP_KEEP_MS at `nowMs`, or undefined for anything else.
 */
export function parseStoredRecap(text: string, sessionId: string, nowMs: number, { ignoreAge = false } = {}): SessionRecap | 'expired' | undefined {
  if (!isSessionUuid(sessionId)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !hasExactly(parsed, FILE_KEYS)) return undefined;
  if (parsed.version !== RECAP_STORE_VERSION || parsed.sessionId !== sessionId) return undefined;
  const atMs = storedTime(parsed.at, nowMs);
  const throughMs = storedTime(parsed.throughAt, nowMs);
  if (Number.isNaN(atMs) || Number.isNaN(throughMs)) return undefined;
  const raw = parsed.recap;
  if (!isRecord(raw) || !Array.isArray(raw.todos)) return undefined;
  // The check a model's answer gets, and it must take the recap back exactly: one pitwall wrote was
  // already read that way, so anything it would cut, make plain or repair wasn't written by pitwall.
  const reading = readRecapAnswer(JSON.stringify(raw), { stored: true });
  if (!reading.ok || reading.repaired.length > 0) return undefined;
  const { answer } = reading;
  if (answer.summary !== raw.summary || answer.title !== raw.title || answer.waitingOn !== raw.waitingOn) return undefined;
  if (answer.goal !== raw.goal || answer.workingOn !== raw.workingOn || answer.plan !== raw.plan) return undefined;
  if (answer.todos.length !== raw.todos.length) return undefined;
  // The plan's items (W172): kept only with a plan, and then exactly as written, changes "" for none.
  if (Object.hasOwn(raw, 'items')) {
    if (answer.planItems === undefined || !Array.isArray(raw.items) || answer.planItems.length !== raw.items.length) return undefined;
    if ((answer.planChanges ?? '') !== raw.changes) return undefined;
    for (let i = 0; i < answer.planItems.length; i++) {
      const kept = raw.items[i] as Record<string, unknown>;
      if (answer.planItems[i]!.text !== kept.text || answer.planItems[i]!.state !== kept.state) return undefined;
    }
  }
  for (let i = 0; i < answer.todos.length; i++) {
    const kept = raw.todos[i] as Record<string, unknown>;
    if (answer.todos[i]!.text !== kept.text || answer.todos[i]!.owner !== kept.owner || answer.todos[i]!.after !== kept.after) return undefined;
  }
  if (!ignoreAge && nowMs - Math.max(atMs, throughMs) > RECAP_KEEP_MS) return 'expired';
  return { ...answer, at: parsed.at as string, throughAt: parsed.throughAt as string, source: 'pitwall' };
}

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const FILE_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const TEMP_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.\d+\.[0-9a-f]{12}\.tmp$/;

/**
 * The store in `home`, pitwall's folder, which must exist: its `recap-store/` folder is made 0700 on
 * the first write. `log` hears, in pitwall's words and never with a recap's text, about a folder
 * pitwall won't use and a write that failed, once until one succeeds.
 */
export function recapStoreDir(home: string, log: (message: string) => void = () => undefined): RecapStore {
  const dir = path.join(home, RECAP_STORE_DIR_NAME);
  let warned = false;
  const warn = (message: string) => {
    if (!warned) log(message);
    warned = true;
  };
  const fileOf = (sessionId: string) => path.join(dir, `${sessionId}.json`);

  /** The text of one file, or undefined when it isn't one pitwall would have written. */
  function readOne(file: string): string | undefined {
    let fd: number;
    try {
      fd = openSync(file, READ_FLAGS);
    } catch {
      return undefined;
    }
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile() || stats.size > RECAP_STORE_MAX_BYTES) return undefined;
      if (process.platform !== 'win32') {
        const uid = process.getuid?.();
        if (uid !== undefined && stats.uid !== uid) return undefined;
        if ((stats.mode & 0o022) !== 0) return undefined;
      }
      const buffer = Buffer.alloc(RECAP_STORE_MAX_BYTES + 1);
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      if (read > RECAP_STORE_MAX_BYTES) return undefined;
      return buffer.toString('utf8', 0, read);
    } catch {
      return undefined;
    } finally {
      closeSync(fd);
    }
  }

  /** Whether a folder is one save() would write to: a real directory of this user's that no one else can enter. Makes nothing. */
  function isOurs(folder: string): boolean {
    try {
      const stats = lstatSync(folder);
      if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
      if (process.platform === 'win32') return true;
      const uid = process.getuid?.();
      if (uid !== undefined && stats.uid !== uid) return false;
      return (stats.mode & 0o077) === 0;
    } catch {
      return false;
    }
  }

  function unlinkQuietly(file: string): void {
    try {
      unlinkSync(file);
    } catch {
      // Gone already, or not ours to remove: either way nothing more to do.
    }
  }

  return {
    load(nowMs) {
      const recaps = new Map<string, SessionRecap>();
      let ignored = 0;
      let expired = 0;
      try {
        lstatSync(dir);
      } catch {
        // None kept yet.
        return { recaps, ignored, expired };
      }
      let names: string[];
      try {
        // Checks the folder as the launch file's is checked: a real directory of this user's, 0700.
        ensureLaunchDir(dir);
        names = readdirSync(dir);
      } catch (error) {
        log(`didn't read the recaps kept in ${dir} (${(error as Error).message}), so every session gets a new one.`);
        return { recaps, ignored: 1, expired };
      }
      let read = 0;
      for (const name of names) {
        const file = path.join(dir, name);
        if (TEMP_NAME.test(name)) {
          try {
            const stats = lstatSync(file);
            if (stats.isFile() && nowMs - stats.mtimeMs > TEMP_MAX_AGE_MS) unlinkQuietly(file);
          } catch {
            // Gone meanwhile.
          }
          continue;
        }
        const id = FILE_NAME.exec(name)?.[1];
        if (id === undefined || read >= RECAP_STORE_MAX_FILES) {
          ignored++;
          continue;
        }
        read++;
        const text = readOne(file);
        const recap = text === undefined ? undefined : parseStoredRecap(text, id, nowMs);
        if (recap === 'expired') {
          unlinkQuietly(file);
          expired++;
        } else if (recap === undefined) ignored++;
        else recaps.set(id, recap);
      }
      return { recaps, ignored, expired };
    },
    save(sessionId, recap) {
      if (!isSessionUuid(sessionId) || recap.source !== 'pitwall') return;
      const file = fileOf(sessionId);
      const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        ensureLaunchDir(home);
        ensureLaunchDir(dir);
        writeFileSync(temporary, storedText(sessionId, recap), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, file);
        warned = false;
      } catch (error) {
        unlinkQuietly(temporary);
        warn(`couldn't keep a recap in ${dir} (${(error as Error).message}), so a restart makes it again.`);
      }
    },
    remove(sessionId) {
      // The same checks as load() and save(), so a recap-store swapped for a link never has files deleted through it.
      if (!isSessionUuid(sessionId) || !isOurs(home) || !isOurs(dir)) return;
      unlinkQuietly(fileOf(sessionId));
    },
  };
}
