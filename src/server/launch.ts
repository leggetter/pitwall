// The launch file (D7): how the CLI hands the token to the browser without
// putting it in any process's arguments, where `ps` shows it to every user on
// the machine.
//
// The CLI writes a small page to ~/.pitwall/launch-<port>-<random>.html, at
// 0600 in a 0700 directory, and opens that file. The page sends the browser on
// to http://127.0.0.1:<port>/#token=<token>. `ps` shows only the file's path.
// The file is deleted as soon as a page authenticates, 60 seconds after it was
// written if none does, or when the CLI exits, whichever comes first. A later
// run deletes any left behind by one that was killed. Jupyter does the same.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';

/** Launch files older than this are left over from a run that was killed, and are deleted on startup. */
export const LAUNCH_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How long a launch file waits for a page to authenticate before it's deleted
 * anyway: long enough for a browser to start cold and read it.
 */
export const LAUNCH_FILE_TTL_MS = 60_000;

/** Names the CLI gives launch files. Startup cleanup deletes only these. */
const LAUNCH_FILE_NAME = /^launch-.*\.html$/;

/** The only URL a launch page may send the browser to. The token is base64url (cli.ts resolveToken). */
const LAUNCH_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/#token=[A-Za-z0-9_-]+$/;

/** The launch directory can't be used safely. The CLI prints the message and exits 1. */
export class LaunchDirError extends Error {
  override name = 'LaunchDirError';
}

/** `~/.pitwall`, or `PITWALL_HOME` when it's set. */
export function pitwallHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const fromEnv = env.PITWALL_HOME;
  return fromEnv ? resolve(fromEnv) : join(home, '.pitwall');
}

export interface DirCheckContext {
  platform?: NodeJS.Platform;
  /** The current user's uid. Undefined on Windows. */
  uid?: number;
}

/**
 * Creates `dir` with mode 0700 if it's missing, then checks it is a real
 * directory, not a symlink, owned by the current user, with no group or other
 * access. Throws LaunchDirError otherwise. It never changes an existing
 * directory: a loose mode is reported, not fixed, so pitwall doesn't silently
 * chmod someone else's directory.
 *
 * Windows has no POSIX owner or mode bits, so there only the symlink and
 * directory checks apply.
 */
export function ensureLaunchDir(dir: string, context: DirCheckContext = {}): void {
  const platform = context.platform ?? process.platform;
  const uid = 'uid' in context ? context.uid : process.getuid?.();
  try {
    // Not recursive: a missing parent is an error, rather than a chain of new directories.
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new LaunchDirError(`couldn't create ${dir}: ${(error as Error).message}`);
    }
  }

  let stats;
  try {
    stats = lstatSync(dir);
  } catch (error) {
    throw new LaunchDirError(`couldn't check ${dir}: ${(error as Error).message}`);
  }
  if (stats.isSymbolicLink()) {
    throw new LaunchDirError(
      `${dir} is a symbolic link. pitwall writes its launch file only to a real directory that you own. Remove the link and run pitwall again.`,
    );
  }
  if (!stats.isDirectory()) throw new LaunchDirError(`${dir} exists but is not a directory. Move it aside and run pitwall again.`);
  if (platform === 'win32') return;
  if (uid !== undefined && stats.uid !== uid) {
    throw new LaunchDirError(
      `${dir} belongs to another user (uid ${stats.uid}). pitwall writes its launch file only to a directory that you own.`,
    );
  }
  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new LaunchDirError(
      `${dir} can be read or entered by other users (mode ${mode.toString(8).padStart(3, '0')}). Run chmod 700 ${dir}, then run pitwall again.`,
    );
  }
}

/**
 * The launch page: it sends the browser straight on to `url` with
 * location.replace, so the file doesn't stay in the tab's history, or with a
 * meta refresh when script doesn't run. No external resources. `url` must be
 * exactly `http://127.0.0.1:<port>/#token=<base64url>`, which also means
 * nothing in it needs escaping in HTML or in a script string.
 */
export function launchPage(url: string): string {
  if (!LAUNCH_URL.test(url)) throw new Error('launchPage: not a pitwall URL');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>Opening pitwall</title>
<script>location.replace(${JSON.stringify(url)});</script>
<meta http-equiv="refresh" content="0; url=${url}">
</head>
<body><p>Opening <a href="${url}">pitwall</a>.</p></body>
</html>
`;
}

/**
 * Writes the launch page for `url` to a new file in `dir`, named
 * `launch-<port>-<random>.html`, and returns its path. The file is created
 * with O_EXCL (and O_NOFOLLOW where there is one), so an existing file or a
 * planted symlink with that name makes it fail rather than be written
 * through. Its mode is set to exactly 0600.
 */
export function writeLaunchFile(
  dir: string,
  port: number,
  url: string,
  random: () => string = () => randomBytes(12).toString('hex'),
): string {
  const page = launchPage(url);
  const file = join(dir, `launch-${port}-${random()}.html`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(file, flags, 0o600);
  try {
    // The umask can only take bits away from 0600; set it exactly anyway.
    fchmodSync(fd, 0o600);
    writeSync(fd, page);
  } catch (error) {
    closeSync(fd);
    unlinkSync(file);
    throw error;
  }
  closeSync(fd);
  return file;
}

/**
 * Deletes the launch files in `dir` last modified more than 24 hours ago,
 * left by a pitwall that was killed before it could delete its own. Returns
 * the names it deleted. Anything it can't read or delete is skipped.
 */
export function removeStaleLaunchFiles(dir: string, now: number = Date.now(), maxAgeMs: number = LAUNCH_FILE_MAX_AGE_MS): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!LAUNCH_FILE_NAME.test(name)) continue;
    const path = join(dir, name);
    try {
      const stats = lstatSync(path);
      if (stats.isDirectory() || now - stats.mtimeMs <= maxAgeMs) continue;
      unlinkSync(path);
      removed.push(name);
    } catch {
      // Gone already, or not ours to delete.
    }
  }
  return removed;
}

/**
 * Checks the launch directory, creating it if needed, and deletes stale
 * launch files. Throws LaunchDirError when the directory isn't safe to use.
 */
export function prepareLaunchDir(dir: string, context: DirCheckContext = {}): void {
  ensureLaunchDir(dir, context);
  removeStaleLaunchFiles(dir);
}

/**
 * Deletes `file` when the process exits: a normal exit, process.exit() from a
 * SIGINT, SIGTERM or SIGHUP handler, or an uncaught exception. Only SIGKILL
 * and a crash of Node itself skip it, which is what the 24-hour cleanup is
 * for. Returns a function that deletes the file now and drops the exit hook.
 */
export function removeOnExit(file: string): () => void {
  const remove = () => {
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
  };
  process.once('exit', remove);
  return () => {
    process.off('exit', remove);
    remove();
  };
}

/**
 * Deletes `file` once it has done its job, so the token doesn't sit on disk
 * for the whole run: when the returned function is called, which the CLI does
 * when a page first authenticates, or `ttlMs` after this call, whichever comes
 * first. Until then removeOnExit() still deletes it on exit. Calling the
 * returned function again does nothing.
 */
export function removeWhenUsed(file: string, ttlMs: number = LAUNCH_FILE_TTL_MS): () => void {
  const remove = removeOnExit(file);
  let done = false;
  const used = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    remove();
  };
  const timer = setTimeout(used, ttlMs);
  // Never what keeps the CLI alive.
  timer.unref();
  return used;
}
