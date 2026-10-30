// What pitwall keeps of the supervisor between runs (M5, W113): its Claude Code session id, so the
// next run resumes the same conversation (spike 009, finding 2), and the version of the system
// prompt that conversation started with, since the prompt is frozen at its first request. Nothing
// else: no message, no answer, no name and no time.
//
//   $PITWALL_HOME/supervisor/state.json   0600    {"sessionId":"<uuid>","promptVersion":1}
//
// Written by rename, so a reader sees the old file or the new one, never half of one. Read
// strictly: a file that's missing, a symbolic link, not a regular file, too big or not exactly
// this shape counts as none, and the supervisor starts a new conversation. Writing fails soft: the
// session id in memory still holds for this run.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isRecord } from '../index/guards.js';
import { isSessionUuid } from '../index/transcripts.js';

/** The state file's name in the supervisor's folder. */
export const SUPERVISOR_STATE_FILE = 'state.json';

/** The most read of it: a real one is under 100 bytes. */
const MAX_BYTES = 4096;

export interface SupervisorRecord {
  /** The conversation's Claude Code session id, a canonical UUID, as `--resume` takes it. */
  sessionId: string;
  /** SUPERVISOR_PROMPT_VERSION when the conversation started. */
  promptVersion: number;
}

/** Where the record is kept. */
export interface SupervisorStateStore {
  /** The record on file, or undefined when there's none that can be used. Never throws. */
  read(): SupervisorRecord | undefined;
  /** Replaces it. Never throws; false when it couldn't be written. */
  write(record: SupervisorRecord): boolean;
}

/** A store in memory only, for tests. */
export function memoryState(initial?: SupervisorRecord): SupervisorStateStore & { current(): SupervisorRecord | undefined } {
  let record = initial === undefined ? undefined : { ...initial };
  return {
    read: () => (record === undefined ? undefined : { ...record }),
    write(next) {
      record = { ...next };
      return true;
    },
    current: () => (record === undefined ? undefined : { ...record }),
  };
}

/** A record read from the file, checked: exactly `sessionId` and `promptVersion`, else undefined. */
export function parseSupervisorRecord(text: string): SupervisorRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !Object.hasOwn(parsed, 'sessionId') || !Object.hasOwn(parsed, 'promptVersion')) return undefined;
  const { sessionId, promptVersion } = parsed;
  if (typeof sessionId !== 'string' || !isSessionUuid(sessionId)) return undefined;
  if (typeof promptVersion !== 'number' || !Number.isSafeInteger(promptVersion) || promptVersion < 1) return undefined;
  return { sessionId, promptVersion };
}

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** The file in `dir`, the supervisor's folder, which the caller has made 0700. `log` hears about a failed write, in pitwall's words. */
export function supervisorStateFile(dir: string, log: (message: string) => void = () => undefined): SupervisorStateStore {
  const file = path.join(dir, SUPERVISOR_STATE_FILE);
  return {
    read() {
      let fd: number;
      try {
        fd = openSync(file, READ_FLAGS);
      } catch {
        return undefined;
      }
      try {
        const stats = fstatSync(fd);
        if (!stats.isFile() || stats.size > MAX_BYTES) return undefined;
        const uid = process.getuid?.();
        if (uid !== undefined && stats.uid !== uid) return undefined;
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const read = readSync(fd, buffer, 0, buffer.length, 0);
        if (read > MAX_BYTES) return undefined;
        return parseSupervisorRecord(buffer.toString('utf8', 0, read));
      } catch {
        return undefined;
      } finally {
        closeSync(fd);
      }
    },
    write(record) {
      const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify({ sessionId: record.sessionId, promptVersion: record.promptVersion })}\n`, { mode: 0o600, flag: 'wx' });
        renameSync(temporary, file);
        return true;
      } catch (error) {
        try {
          unlinkSync(temporary);
        } catch {
          // It wasn't made.
        }
        log(`couldn't save the supervisor's session id in ${file} (${(error as Error).message}), so the next run starts a new conversation.`);
        return false;
      }
    },
  };
}
