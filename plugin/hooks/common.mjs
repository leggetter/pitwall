// @ts-check
// What the pitwall plugin's context hooks share (W197): handoffNudge.mjs (a session's own context),
// subagentGuard.mjs (a message to a finished sub-agent) and subagentNudge.mjs (a sub-agent's context).
//
// Every hook here runs in each session on the machine, so each fails soft and quiet: a problem means
// no output and exit 0, never a blocked tool call. What they read, all as untrusted:
//
// - the hook's own input on stdin, at most INPUT_MAX_BYTES;
// - `$PITWALL_HOME/server.json` or `~/.pitwall/server.json`, through sessionNote.mjs' checks (pitwallRunning());
// - the tail of a transcript or a sub-agent's transcript, `agent-<id>.jsonl`: opened with O_NOFOLLOW and
//   O_NONBLOCK, a regular file of this user's, read through the end only, in at most three steps;
// - a sub-agent's `agent-<id>.meta.json`, the same way, at most META_MAX_BYTES;
// - the nudge state: one small file per session or sub-agent under os.tmpdir(), a folder that has to be a
//   real folder of this user's. Nothing else is read, and the hooks write nothing but that state.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeOf, isAlive, listening, readServer } from './sessionNote.mjs';

/** Tokens of context at which a session, or a sub-agent, is told to wrap up; twice it is the second level. */
export const THRESHOLD = 200_000;

/** The most hook input read, and how long to wait for it. A PostToolUse input carries the tool's result. */
export const INPUT_MAX_BYTES = 8 * 1024 * 1024;
export const INPUT_TIMEOUT_MS = 2000;

/** The most a sub-agent's `meta.json` may hold; Claude Code's own are a few hundred bytes. */
export const META_MAX_BYTES = 64 * 1024;

/**
 * How much of a transcript's end is read: a little first, then more while no usage is found.
 * Each call writes request lines of a MB or more after the last usage (spike 012), so the tail
 * has to be able to reach past a few of them.
 */
export const TAIL_BYTES = [256 * 1024, 4 * 1024 * 1024, 32 * 1024 * 1024];

/** Claude Code's session ids are UUIDs; anything else is refused before it names a file. */
export const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;
/** A sub-agent's id: letters and digits only, as src/index/subagents.ts has it. */
export const AGENT_ID = /^[A-Za-z0-9]{1,64}$/;

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value */
const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

/**
 * The threshold: `env[name]` when it's a positive whole number (for tests, and for a person who wants
 * another), else 200K.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 */
export function thresholdOf(env, name) {
  const raw = env[name];
  if (raw === undefined || !/^[1-9][0-9]{0,9}$/.test(raw)) return THRESHOLD;
  return Number(raw);
}

/**
 * The highest level the context has reached: 0 under the threshold, 1 past it, 2 past twice it.
 * @param {number} context
 * @param {number} threshold
 */
export const levelOf = (context, threshold) => (context >= 2 * threshold ? 2 : context >= threshold ? 1 : 0);

/** @param {number} n */
export const kilo = (n) => `${Math.round(n / 1000)}K`;

/**
 * True while pitwall is running for this environment: the server file is fresh and trusted, its process
 * lives and its port accepts a connection (sessionNote.mjs' checks).
 * @param {NodeJS.ProcessEnv} env
 * @param {{ home?: string, alive?: (pid: number) => boolean, listening?: (port: number) => Promise<boolean> }} [deps]
 * @returns {Promise<boolean>}
 */
export async function pitwallRunning(env, deps = {}) {
  try {
    const server = readServer(path.join(homeOf(env, deps.home ?? os.homedir()), 'server.json'));
    if (server === undefined) return false;
    if (!(deps.alive ?? isAlive)(server.pid)) return false;
    return await (deps.listening ?? listening)(server.port);
  } catch {
    return false;
  }
}

/**
 * The hook's input from stdin, whole: '' when it is over INPUT_MAX_BYTES or doesn't end in INPUT_TIMEOUT_MS.
 * @returns {Promise<string>}
 */
export function readInput() {
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

/**
 * Opens `file` for reading as a regular file of this user's: no link followed, no FIFO waited on.
 * Returns the descriptor and size; the caller closes it. Throws on anything else.
 * @param {string} file
 * @returns {{ fd: number, size: number }}
 */
function openRegular(file) {
  const fd = openSync(file, OPEN_FLAGS);
  try {
    const stat = fstatSync(fd);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) throw new Error('not a regular file of ours');
    return { fd, size: stat.size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * The context the last call sent, from the end of a transcript's text: input_tokens + cache_read_input_tokens
 * + cache_creation_input_tokens of the last assistant entry with usage. Undefined when there's none, or when
 * a compaction comes after it, since its usage is no longer the context. Synthetic messages and lines that
 * aren't JSON (such as a first line cut by the tail) are skipped. In a session's own transcript, sidechain
 * entries (a sub-agent's calls, as older versions wrote them in the main file) are skipped too; a sub-agent's
 * own file is all sidechain, so it asks for them.
 * @param {string} text
 * @param {{ sidechain?: boolean }} [options]
 * @returns {number | undefined}
 */
export function lastContext(text, options = {}) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    // The request records are the large lines, and never the usage: skip them without parsing.
    if (line.startsWith('{"type":"api-request')) continue;
    /** @type {unknown} */
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    if (entry.isCompactSummary === true || (entry.type === 'system' && entry.subtype === 'compact_boundary')) return undefined;
    if (entry.type !== 'assistant' || (entry.isSidechain === true && options.sidechain !== true)) continue;
    const message = entry.message;
    if (!isRecord(message) || message.model === '<synthetic>') continue;
    const usage = message.usage;
    if (!isRecord(usage)) continue;
    const total = count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
    if (total > 0) return total;
  }
  return undefined;
}

/**
 * Reads the transcript's tail, growing it while no usage is found, and returns the context. Throws when
 * the file can't be opened as a regular file; the hooks catch it and stay silent.
 * @param {string} file
 * @param {{ sidechain?: boolean }} [options]
 * @returns {number | undefined}
 */
export function contextOf(file, options = {}) {
  const { fd, size } = openRegular(file);
  try {
    for (const want of TAIL_BYTES) {
      const length = Math.min(want, size);
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, size - length + read);
        if (n === 0) break;
        read += n;
      }
      const context = lastContext(buffer.toString('utf8', 0, read), options);
      if (context !== undefined || length === size) return context;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * A sub-agent's `meta.json`, parsed: a regular file of at most META_MAX_BYTES. Undefined when it can't
 * be read or isn't a JSON object.
 * @param {string} file
 * @returns {Record<string, unknown> | undefined}
 */
export function readMeta(file) {
  try {
    const { fd, size } = openRegular(file);
    try {
      if (size > META_MAX_BYTES) return undefined;
      const buffer = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const n = readSync(fd, buffer, read, size - read, read);
        if (n === 0) break;
        read += n;
      }
      const value = JSON.parse(buffer.toString('utf8', 0, read));
      return isRecord(value) ? value : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * The sub-agents folder beside a session's transcript, `<transcript minus .jsonl>/subagents`, or undefined
 * when the transcript path isn't an absolute `.jsonl` path or the folder, or the session folder above it,
 * isn't a real folder (a link is none, as in src/index/subagents.ts).
 * @param {unknown} transcriptPath
 * @returns {string | undefined}
 */
export function subagentsDirOf(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath) || !transcriptPath.endsWith('.jsonl')) return undefined;
  try {
    const sessionDir = transcriptPath.slice(0, -'.jsonl'.length);
    if (!lstatSync(sessionDir).isDirectory()) return undefined;
    const folder = path.join(sessionDir, 'subagents');
    return lstatSync(folder).isDirectory() ? folder : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The state folder: PITWALL_HANDOFF_STATE_DIR when set (for tests), else a per-user folder under
 * os.tmpdir(), which is per-user on macOS but can be a shared /tmp on Linux.
 * @param {NodeJS.ProcessEnv} env
 */
export const stateDirOf = (env) => {
  if (env.PITWALL_HANDOFF_STATE_DIR) return env.PITWALL_HANDOFF_STATE_DIR;
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return path.join(os.tmpdir(), uid === undefined ? 'pitwall-handoff-nudge' : `pitwall-handoff-nudge-${uid}`);
};

/** The state file's key: letters, digits, dots and dashes only, so it names one file in the folder. */
const STATE_KEY = /^[A-Za-z0-9.-]{1,200}$/;

/**
 * The level last nudged for this key, 0 when there's no state.
 * @param {string} dir
 * @param {string} key
 */
export function readLevel(dir, key) {
  try {
    if (!STATE_KEY.test(key)) return 0;
    const state = JSON.parse(readFileSync(path.join(dir, `${key}.json`), 'utf8'));
    return isRecord(state) && (state.level === 1 || state.level === 2) ? state.level : 0;
  } catch {
    return 0;
  }
}

/**
 * @param {string} dir
 * @param {string} key
 * @param {number} level
 */
export function writeLevel(dir, key, level) {
  if (!STATE_KEY.test(key)) throw new Error('odd state key');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A shared /tmp (Linux) lets another user plant the folder or a link: use it only when it's
  // a real folder of ours; otherwise throw, and the hook stays silent.
  const st = lstatSync(dir);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) throw new Error('state folder not ours');
  writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ v: 1, level }), { mode: 0o600 });
}

/**
 * True when node runs the module at `moduleUrl` (its import.meta.url) as the script, by a path with links
 * in it or not (a plugin's root may have some).
 * @param {string} moduleUrl
 */
export function isMain(moduleUrl) {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
