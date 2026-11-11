#!/usr/bin/env node
// pitwall's SessionStart hook (W176, the pitwall plugin). Claude Code runs it at a session's start,
// /clear, compact, resume and fork. While pitwall is running, it adds a few lines of context: pitwall
// watches this session, at which URL; how to link a session in pitwall; and that the pitwall skill
// proposes a new session. With no pitwall running it prints nothing.
//
// It runs in every session on the machine, so it trusts nothing and fails soft and quiet: any problem
// means no output and exit 0, never a message on stderr.
//
// Where pitwall is: `~/.pitwall/server.json`, or `$PITWALL_HOME/server.json` when this session's own
// environment has an absolute PITWALL_HOME. pitwall writes it (src/server/serverFile.ts) as
// `{ "v": 1, "url": "http://127.0.0.1:<port>", "pid": <n> }`, never the token. A background session's
// hooks get the background service's environment, not the shell's (spike 015, finding 3), so those
// find only ~/.pitwall's. The file is read as untrusted:
//
// - opened with O_NOFOLLOW and O_NONBLOCK, so a planted link can't redirect it and a FIFO can't hang it;
// - fstat: a regular file of this user's, not writable by group or others, at most MAX_BYTES;
// - read only up to the size fstat gave, whatever the file grows to meanwhile;
// - its mtime at most FRESH_MS old, and not more than FUTURE_SKEW_MS ahead: pitwall writes it again every
//   30 s, so a pitwall killed without its exit hook stops being named within about 90 s, even when its
//   pid is reused and another listener takes its port (W176's review, F1);
// - its URL exactly `http://127.0.0.1:<port>`, its pid a positive integer above 1;
// - then trusted only while kill(pid, 0) finds that process and the port accepts a connection within
//   CONNECT_TIMEOUT_MS, so a crashed pitwall's file, whose port something else may have taken, adds nothing.
//
// The note is the same text for the same URL and session, so a resume doesn't add it twice. Claude Code
// adds it again only when its text changed, and then keeps the old one too (spike 015, finding 4), so
// it says it replaces any earlier one.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_BYTES = 1024;
/** How old a file is still trusted: three of pitwall's 30 s rewrites (src/server/serverFile.ts, SERVER_FILE_FRESH_MS). */
export const FRESH_MS = 90_000;
/** How far ahead of now an mtime may be, for clock skew between the write and this read. */
export const FUTURE_SKEW_MS = 10_000;
export const CONNECT_TIMEOUT_MS = 300;
/** The most of the hook's input read from stdin, and how long to wait for its end. */
const INPUT_MAX_BYTES = 64 * 1024;
const INPUT_TIMEOUT_MS = 1000;

const SERVER_URL = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * pitwall's home for this session: PITWALL_HOME when it's set and absolute, otherwise ~/.pitwall.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 * @returns {string}
 */
export function homeOf(env, home) {
  const fromEnv = env.PITWALL_HOME;
  return typeof fromEnv === 'string' && fromEnv !== '' && path.isAbsolute(fromEnv) ? fromEnv : path.join(home, '.pitwall');
}

/**
 * The server file's URL, port and pid, or undefined when it's missing, stale or can't be trusted.
 * @param {string} file
 * @param {number} [now] the time, in ms since the epoch
 * @returns {{ url: string, port: number, pid: number } | undefined}
 */
export function readServer(file, now = Date.now()) {
  /** @type {number | undefined} */
  let fd;
  /** @type {unknown} */
  let value;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0 || stat.size > MAX_BYTES) return undefined;
    if (!(stat.mtimeMs >= now - FRESH_MS && stat.mtimeMs <= now + FUTURE_SKEW_MS)) return undefined;
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
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to do.
      }
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { url, pid } = /** @type {Record<string, unknown>} */ (value);
  const match = typeof url === 'string' ? SERVER_URL.exec(url) : null;
  if (match === null || typeof url !== 'string') return undefined;
  const port = Number(match[1]);
  if (port > 65_535) return undefined;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 || pid >= 2 ** 31) return undefined;
  return { url, port, pid };
}

/**
 * True while `pid` names a process this user may signal. Signal 0 sends nothing.
 * @param {number} pid
 * @returns {boolean}
 */
export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when something accepts a TCP connection on 127.0.0.1:`port` within `timeoutMs`.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function listening(port, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    /** @param {boolean} ok */
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * The note, for pitwall at `url` and this session's id when it's a UUID.
 * @param {string} url
 * @param {string | undefined} sessionId
 * @returns {string}
 */
export function noteFor(url, sessionId) {
  const self = sessionId === undefined ? '' : `: ${url}/?session=${sessionId}`;
  return [
    `pitwall (${url}) watches this machine's Claude Code sessions, this one included${self}.`,
    `When you mention a session, say in a few words what it is, then link its short ID (the first 8 characters): [<short id>](${url}/?session=<full session ID>).`,
    'To propose a new, separate session, use the pitwall skill; the user starts it from pitwall.',
    'This replaces any earlier pitwall note in this conversation.',
  ].join('\n');
}

/**
 * What the hook prints for its input, or '' for nothing.
 * @param {string} inputText the hook's JSON input
 * @param {NodeJS.ProcessEnv} env
 * @param {{ home?: string, alive?: (pid: number) => boolean, listening?: (port: number) => Promise<boolean> }} [deps]
 * @returns {Promise<string>}
 */
export async function runHook(inputText, env, deps = {}) {
  try {
    /** @type {unknown} */
    let input;
    try {
      input = JSON.parse(inputText);
    } catch {
      input = undefined;
    }
    const raw = input !== null && typeof input === 'object' ? /** @type {Record<string, unknown>} */ (input).session_id : undefined;
    const sessionId = typeof raw === 'string' && UUID.test(raw) ? raw : undefined;
    const server = readServer(path.join(homeOf(env, deps.home ?? os.homedir()), 'server.json'));
    if (server === undefined) return '';
    if (!(deps.alive ?? isAlive)(server.pid)) return '';
    if (!(await (deps.listening ?? listening)(server.port))) return '';
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: noteFor(server.url, sessionId) } });
  } catch {
    return '';
  }
}

/**
 * The hook's input from stdin: at most INPUT_MAX_BYTES, within INPUT_TIMEOUT_MS. '' past either.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;
    /** @param {string} text */
    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.destroy();
      resolve(text);
    };
    const timer = setTimeout(() => finish(''), INPUT_TIMEOUT_MS);
    process.stdin.on('data', (/** @type {Buffer} */ chunk) => {
      size += chunk.length;
      if (size > INPUT_MAX_BYTES) finish('');
      else chunks.push(chunk);
    });
    process.stdin.once('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.once('error', () => finish(''));
  });
}

/** True when node runs this file, by a path with links in it or not (a plugin's root may have some). */
function isMain() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMain()) {
  readStdin()
    .then((text) => runHook(text, process.env))
    .then(
      (out) => {
        if (out !== '') process.stdout.write(out);
      },
      () => {},
    );
}
