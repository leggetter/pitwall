// The one place pitwall touches node-pty, its first native dependency. The
// attach socket (attach.ts) takes a PtySpawner, so tests pass a fake and never
// run `claude`; the server uses spawnPty() below.
//
// node-pty is loaded on the first attach, not at startup. A missing or broken
// native build then fails that attach with a message, and the rest of pitwall
// (the index, the session view) keeps working.
import { closeSync, constants, existsSync, fchmodSync, fstatSync, openSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { isatty } from 'node:tty';

/** What attach.ts needs from a PTY. node-pty's IPty has all of it. */
export interface PtyProcess {
  /** Output, decoded as UTF-8. */
  onData(listener: (data: string) => void): unknown;
  /** `signal` is 0 or undefined when the process exited on its own. */
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** SIGHUP by default. */
  kill(signal?: string): void;
  /** Flow control: stop and restart reading output. */
  pause(): void;
  resume(): void;
}

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  cwd: string;
  /** The complete environment: nothing is inherited. */
  env: Record<string, string>;
  /** $TERM. */
  name: string;
}

/** Starts `file` with `args` in a new PTY, without a shell. Throws when it can't. */
export type PtySpawner = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess;

type NodePty = typeof import('node-pty');

/** What spawnPty needs once node-pty has loaded: its spawn, and its spawn-helper, if it has one. */
export interface LoadedPty {
  spawn: NodePty['spawn'];
  /** undefined off macOS, or when there's none. */
  helper: string | undefined;
}

/**
 * A PtySpawner that loads node-pty on its first spawn and makes sure the
 * helper is executable before every spawn, not once per process: an `npm ci`
 * under a running server reinstalls it without its execute bit, and every
 * attach after it would fail until a restart (W169). After each spawn it
 * closes the terminal descriptors node-pty left behind (W202): see
 * closeStrayTerminals().
 */
export function ptySpawner(load: () => LoadedPty, fds: FdTable = processFds): PtySpawner {
  let loaded: LoadedPty | undefined;
  return (file, args, options) => {
    loaded ??= load();
    if (loaded.helper !== undefined) makeExecutable(loaded.helper);
    const before = listFds(fds);
    const started = loaded.spawn(file, args, { ...options, encoding: 'utf8' });
    closeStrayTerminals(fds, before, started);
    return started;
  };
}

/** The descriptors closeStrayTerminals() reads and closes: this process's own, or a test's made-up ones. */
export interface FdTable {
  /** The open descriptors. Throws when they can't be listed. */
  list(): number[];
  isTerminal(fd: number): boolean;
  close(fd: number): void;
}

/**
 * This process's descriptors: /dev/fd on macOS and Linux, less any that
 * fstat refuses. Reading /dev/fd lists the descriptor it reads through, which
 * is closed again by the time the list returns, and node-pty's spare /dev/ptmx
 * takes that same lowest free number: counted as open before the spawn, it
 * would never be closed.
 */
const processFds: FdTable = {
  list: () => readdirSync('/dev/fd').map(Number).filter(isOpen),
  isTerminal: (fd) => isatty(fd),
  close: (fd) => closeSync(fd),
};

function isOpen(fd: number): boolean {
  if (!Number.isInteger(fd)) return false;
  try {
    fstatSync(fd);
    return true;
  } catch {
    return false;
  }
}

function listFds(fds: FdTable): Set<number> | undefined {
  try {
    return new Set(fds.list());
  } catch {
    return undefined;
  }
}

/**
 * node-pty 1.1.0's macOS spawn (pty_posix_spawn in src/unix/pty.cc) leaves two
 * terminal descriptors open in pitwall's process on every spawn, however the
 * process ends (W202): the slave side of the new PTY, which the parent opens
 * and never closes (lsof shows it "(revoked)" once the child's session ends),
 * and a spare /dev/ptmx from its low-descriptor guard, whose clean-up loop
 * never closes index 0. Each holds a PTY device, and macOS allows 511 for the
 * whole machine (kern.tty.ptmx_max): on 2026-11-18 a pitwall two days old held
 * 472 and no process on the Mac could open a terminal. Upstream:
 * microsoft/node-pty#907 and #950; the 1.2.0 betas close both. Remove this
 * when a stable node-pty does.
 *
 * The spawn is synchronous, and nothing else in pitwall opens a terminal, so
 * a terminal descriptor that wasn't open before the spawn, other than the
 * PTY's own master (`fd`), is one of the two. It's closed; node-pty never uses
 * either again. Anything that isn't a terminal is left alone, and so is
 * everything when the master's descriptor isn't known or the list can't be
 * read. Never throws.
 */
export function closeStrayTerminals(fds: FdTable, before: Set<number> | undefined, started: PtyProcess): void {
  const master = (started as { fd?: unknown }).fd;
  if (before === undefined || typeof master !== 'number') return;
  const after = listFds(fds);
  if (after === undefined) return;
  for (const fd of after) {
    if (before.has(fd) || fd === master) continue;
    try {
      if (fds.isTerminal(fd)) fds.close(fd);
    } catch {
      // Closed already, or not ours to close: left as it is.
    }
  }
}

/** The real PtySpawner, over node-pty. */
export const spawnPty: PtySpawner = ptySpawner(loadNodePty);

function loadNodePty(): LoadedPty {
  const require = createRequire(import.meta.url);
  const pty = require('node-pty') as NodePty;
  const helper =
    process.platform === 'darwin'
      ? findSpawnHelper(dirname(require.resolve('node-pty/package.json')), `${process.platform}-${process.arch}`)
      : undefined;
  return { spawn: pty.spawn.bind(pty), helper };
}

/**
 * node-pty 1.1.0's macOS prebuilds ship `spawn-helper` without its execute
 * bit (mode 0644 in the published tarball), so every spawn fails with
 * `posix_spawnp failed.` pitwall sets the bit when it's missing. Linux builds
 * from source and doesn't use the helper. Remove this when a stable release
 * ships the helper executable (the 1.2.0 betas do; 1.1.0 is still `latest`).
 *
 * The helper node-pty uses: its own build first, then the prebuild, the
 * order node-pty loads its native module in.
 */
export function findSpawnHelper(root: string, platformArch: string): string | undefined {
  for (const dir of ['build/Release', `prebuilds/${platformArch}`]) {
    const helper = join(root, dir, 'spawn-helper');
    if (existsSync(helper)) return helper;
  }
  return undefined;
}

/**
 * Adds the execute bits when the owner's is missing, and nothing else. Never throws. Opened without
 * following a link, then fstat'ed, and changed through that descriptor only when it's a regular file
 * of this user's, so a link planted in its place, or a file swapped in after the check, is never
 * changed, and no read bit is ever added (W180's F1).
 */
export function makeExecutable(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) return;
    if ((stat.mode & 0o100) !== 0) return;
    // Without setuid, setgid or sticky bits: only the permission bits, plus execute (W180's N6).
    fchmodSync(fd, (stat.mode & 0o777) | 0o111);
  } catch {
    // A link, a read-only install, or no file: the spawn then fails with node-pty's own error.
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
