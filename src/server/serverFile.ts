// The server file (W176, the pitwall plugin): where this pitwall listens, for the plugin's
// SessionStart hook (plugin/hooks/sessionNote.mjs), which tells every session that pitwall watches it
// and how to link a session in pitwall.
//
//   $PITWALL_HOME/server.json   0600, in the 0700 home   { "v": 1, "url": "http://127.0.0.1:<port>", "pid": <n> }
//
// The URL and the pid only: never the token, the apiKey or any session content. `"dev": true` marks
// a run under `npm run dev`. Written whole by rename, so a reader never sees half of it.
//
// Which pitwall's file it is, when more than one runs on one home:
//
// - At start, a CLI run writes its own, replacing whatever is there. A run under `npm run dev` doesn't
//   replace a live CLI run's, so Phil's everyday pitwall keeps the note while he develops.
// - Every RECLAIM_MS it looks again. Its own file it writes again, so the file's mtime says it's alive:
//   the hook ignores a file older than three of these (W176's review, F1), so a pitwall killed without
//   its exit hook (SIGKILL, out of memory) stops being named within about 90 s, even if its pid is
//   reused and something else takes its port. Another's it replaces only when the file is gone, can't
//   be read, or names a pid that no longer runs, never a live pitwall's, so two never take turns.
// - On close it deletes the file only while it still names this run's URL and pid, so the one still
//   running keeps its file, or gets it back within RECLAIM_MS of the other's close.
//
// Everything here fails soft: a home that isn't a private directory of this user's (ensureLaunchDir)
// or a write that fails leaves no file and never stops pitwall. The hook then adds nothing.
//
// The file is read back as untrusted, as the snoozes are: a regular file of this user's, not a link,
// not writable by group or others, at most SERVER_FILE_MAX_BYTES, its URL exactly
// `http://127.0.0.1:<port>`. The hook reads it the same way, and also checks the pid with kill(pid, 0)
// and that the port listens.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureLaunchDir } from './launch.js';

export const SERVER_FILE_NAME = 'server.json';

/** The most the file may hold. pitwall's own is under 100 bytes. */
export const SERVER_FILE_MAX_BYTES = 1024;

/**
 * How often a running pitwall writes its own file again, so its mtime stays fresh, and looks at
 * another's, to take it back once its holder has gone. The hook trusts a file at most
 * SERVER_FILE_FRESH_MS old (plugin/hooks/sessionNote.mjs, FRESH_MS).
 */
export const RECLAIM_MS = 30_000;

/** How old a server file the hook still trusts: three of RECLAIM_MS. */
export const SERVER_FILE_FRESH_MS = 3 * RECLAIM_MS;

/** The only URL the file may hold: pitwall's own address, as startServer() gives it. */
const SERVER_URL = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;

export interface ServerFileBody {
  v: 1;
  url: string;
  pid: number;
  /** A run under `npm run dev`, which never replaces a live CLI run's file. */
  dev?: true;
}

/** A pid kill(pid, 0) can be asked about: a positive integer, never 0 or -1, which mean process groups. */
export const isPid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 1 && value < 2 ** 31;

/** True when `url` is exactly `http://127.0.0.1:<port>`, with a port from 1 to 65535. */
export function isServerUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = SERVER_URL.exec(value);
  return match !== null && Number(match[1]) <= 65_535;
}

/** True while `pid` names a process this user may signal: kill(pid, 0), which sends nothing. */
export function isAlive(pid: number): boolean {
  if (!isPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The file at `file`, or undefined when there's none or it can't be trusted: not a regular file of this
 * user's, a link, writable by group or others, over SERVER_FILE_MAX_BYTES, not JSON, or without an
 * exact URL and a pid. Opened with O_NOFOLLOW and O_NONBLOCK, so a planted link or FIFO can't redirect
 * or hang it, and read only up to the size fstat gave.
 */
export function readServerFile(file: string): ServerFileBody | undefined {
  let fd: number | undefined;
  let value: unknown;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0 || stat.size > SERVER_FILE_MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    value = JSON.parse(buffer.subarray(0, read).toString('utf8'));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { url, pid, dev } = value as Record<string, unknown>;
  if (!isServerUrl(url) || !isPid(pid)) return undefined;
  return { v: 1, url, pid, ...(dev === true ? { dev: true as const } : {}) };
}

export interface ServerFileOptions {
  /** pitwall's home, `$PITWALL_HOME` or `~/.pitwall` (pitwallHome()). */
  home: string;
  /** This server's URL, `http://127.0.0.1:<port>`. */
  url: string;
  /** A run under `npm run dev`. */
  dev: boolean;
  /** Default process.pid. */
  pid?: number;
  /** Default isAlive(). */
  alive?: (pid: number) => boolean;
  /** Default RECLAIM_MS; 0 for no timer. */
  reclaimMs?: number;
}

export interface ServerFileHandle {
  /** The file's path. */
  readonly file: string;
  /** Stops looking again, and deletes the file if it still names this run. Synchronous, so it can run on exit. Idempotent. */
  close(): void;
}

/**
 * Writes this run's server file, as the rules at the top say, and keeps it while the run lasts. Never
 * throws.
 */
export function claimServerFile(options: ServerFileOptions): ServerFileHandle {
  const file = join(options.home, SERVER_FILE_NAME);
  const pid = options.pid ?? process.pid;
  const alive = options.alive ?? isAlive;
  const mine: ServerFileBody = { v: 1, url: options.url, pid, ...(options.dev ? { dev: true as const } : {}) };
  const ours = (body: ServerFileBody | undefined) => body !== undefined && body.pid === pid && body.url === options.url;

  const write = (): void => {
    if (!isServerUrl(options.url) || !isPid(pid)) return;
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      ensureLaunchDir(options.home);
      writeFileSync(temporary, `${JSON.stringify(mine)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
    } catch {
      try {
        unlinkSync(temporary);
      } catch {
        // Never written.
      }
    }
  };

  // At start: a CLI run replaces any file; a dev run only one that isn't a live CLI run's.
  const existing = readServerFile(file);
  if (!(options.dev && existing !== undefined && existing.dev !== true && existing.pid !== pid && alive(existing.pid))) write();

  // Then: write its own again, so its mtime stays fresh, and take the file back only from nobody,
  // never from a live pitwall. Between this read and the rename another run can write its own, which
  // this replaces; that run takes it back at its next look once this one has gone, so it heals itself.
  const reclaimMs = options.reclaimMs ?? RECLAIM_MS;
  const timer =
    reclaimMs > 0
      ? setInterval(() => {
          const now = readServerFile(file);
          if (now === undefined || ours(now) || !alive(now.pid)) write();
        }, reclaimMs)
      : undefined;
  timer?.unref();

  let closed = false;
  return {
    file,
    close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      // Between this read and the unlink another run can write its own, which this deletes; that run
      // writes it again at its next look, within RECLAIM_MS.
      try {
        if (ours(readServerFile(file))) unlinkSync(file);
      } catch {
        // Gone already, or not ours to remove.
      }
    },
  };
}
