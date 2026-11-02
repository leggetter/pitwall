#!/usr/bin/env node
// @ts-check
// The supervisor's recipient gate (M5, W115; spike 009, recommendation 3): a deny-only PreToolUse
// hook on the supervisor's SendMessage, kept as defence in depth beside pitwall's approvals. Claude
// Code runs it from the supervisor's --settings, in exec form (`process.execPath` with this file,
// the gate directory and the gate id as arguments, and no shell), with `onFailure: "block"`.
//
// Plain JavaScript with no dependencies, so the same file runs from src/ under `npm run dev` and
// from dist/ once built, as the relay's gate does (src/server/relayGateHook.mjs).
//
// It never allows anything. A call that passes gets no decision: exit 0 with nothing printed, so
// Claude Code goes on to the `ask` rule for SendMessage, and so to pitwall's permission prompt tool
// (mcp__pitwall__approve), where you decide. A call that fails is denied with exit 2 and the reason
// on stderr, which blocks it whatever stdout holds, before any card is shown. A crash exits 1, which
// `onFailure: "block"` turns into a denial.
//
// What passes: a SendMessage whose input has only the fields pitwall knows, a plain message, no
// idle notices, a `content` preview that is the message or its start (isPreviewOf()), and `to` exactly one of the names in <dir>/<gate id>.recipients, which pitwall
// rewrites as its list changes: the live, listed sessions with a name no other live one has, never
// pitwall's own. With no such file, or one that isn't well formed, every call is denied.
//
//   {"v":1,"names":["<name>", …]}
//
// For SessionStart, it writes <dir>/<gate id>.ready and prints nothing, so pitwall can tell its
// hooks loaded: a supervisor whose turn starts without it is stopped.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The recipients file's format. */
export const RECIPIENTS_VERSION = 1;

/** A gate id: 32 lowercase hex characters, new for each supervisor process. */
export const GATE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** The most hook input read. A message is at most 20,000 characters. */
const MAX_INPUT_BYTES = 1024 * 1024;

/** The largest recipients file read. */
const MAX_RECIPIENTS_BYTES = 1024 * 1024;

/** Starts every reason the gate gives, so a denial says where it came from. */
export const DENIAL_PREFIX = "pitwall's supervisor gate";

/** pitwall's own sessions, which the supervisor never messages, compared without case. */
export const OWN_NAMES = new Set(['pitwall-relay', 'pitwall-recap', 'pitwall-supervisor']);

/**
 * The fields of SendMessage's input the gate knows, as Claude Code 2.1.312 passes it to hooks and
 * permission prompts (spike 009, finding 6): the call's `to`, `message`, `summary` and
 * `notify_when_idle`, and the `type`, `recipient`, `recipient_kind` and `content` it adds. A call
 * with any other field is denied, because the gate can't tell what it does.
 */
export const KNOWN_INPUT_FIELDS = new Set(['to', 'recipient', 'recipient_kind', 'message', 'content', 'summary', 'type', 'notify_when_idle']);

/** The longest preview (`content`) taken, in UTF-16 code units: Claude Code cuts it at 50 columns. */
const MAX_PREVIEW_LENGTH = 200;

/**
 * Whether `content` is what Claude Code makes of `message` for SendMessage's `content` field: the
 * message itself, or its start cut with an ellipsis (`…`), about 50 columns. Anything else could
 * carry text you never saw on the card, so it's refused (W115's review).
 * @param {unknown} content
 * @param {string} message
 */
export function isPreviewOf(content, message) {
  if (content === undefined || content === message) return true;
  if (typeof content !== 'string' || content.length > MAX_PREVIEW_LENGTH || !content.endsWith('…')) return false;
  const head = content.slice(0, -1);
  return head.trim() !== '' && message.length > head.length && message.startsWith(head.trimEnd());
}

/**
 * @param {string} dir
 * @param {string} gateId
 */
export function recipientsPath(dir, gateId) {
  return path.join(dir, `${gateId}.recipients`);
}

/**
 * @param {string} dir
 * @param {string} gateId
 */
export function readyPath(dir, gateId) {
  return path.join(dir, `${gateId}.ready`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The names in a parsed recipients file, or undefined when it isn't a well-formed one.
 * @param {unknown} value
 * @returns {Set<string> | undefined}
 */
export function asRecipients(value) {
  if (!isRecord(value) || value.v !== RECIPIENTS_VERSION || !Array.isArray(value.names)) return undefined;
  if (!value.names.every((name) => typeof name === 'string' && name !== '')) return undefined;
  return new Set(/** @type {string[]} */ (value.names));
}

/**
 * Whether the SendMessage call in a PreToolUse input may go on to the approval card: undefined when
 * it may, else why not. Pure, so it's tested without files. `recipients` is undefined when pitwall
 * wrote no list, or one that couldn't be read.
 *
 * @param {unknown} input the hook's JSON input
 * @param {Set<string> | undefined} recipients
 * @returns {string | undefined}
 */
export function refusal(input, recipients) {
  if (!isRecord(input) || input.hook_event_name !== 'PreToolUse') return 'it was asked about something other than a tool call';
  if (input.tool_name !== 'SendMessage') return undefined;
  const call = input.tool_input;
  if (!isRecord(call)) return 'the call has no arguments';
  if (Object.keys(call).some((field) => !KNOWN_INPUT_FIELDS.has(field))) return 'the call has a field pitwall doesn’t check';
  if (call.type !== undefined && call.type !== 'message') return 'the call isn’t a plain message';
  if (call.notify_when_idle !== undefined && call.notify_when_idle !== false) return 'the call asks to be told when the session goes idle';
  if (typeof call.message !== 'string') return 'the call has no message';
  if (!isPreviewOf(call.content, call.message)) return 'the call’s preview isn’t its message';
  const to = call.to;
  if (typeof to !== 'string' || to === '') return 'the call names no session';
  if (call.recipient !== undefined && call.recipient !== to) return 'the call names two different recipients';
  if (call.recipient_kind !== undefined && call.recipient_kind !== 'name') return 'the call is addressed to something other than a session’s name';
  if (OWN_NAMES.has(to.toLowerCase())) return 'the supervisor never messages pitwall’s own sessions';
  if (recipients === undefined) return 'pitwall has no list of sessions it can message';
  if (!recipients.has(to)) return 'the message is addressed to something other than one running session pitwall lists, by its exact name';
  return undefined;
}

/**
 * Checks that `dir` is a real directory, not a symlink, owned by this user and closed to everyone
 * else. Throws otherwise.
 * @param {string} dir
 */
export function checkGateDir(dir) {
  if (!path.isAbsolute(dir)) throw new Error('the gate directory isn’t an absolute path');
  const stats = lstatSync(dir);
  if (!stats.isDirectory()) throw new Error('the gate directory isn’t a directory');
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) throw new Error('the gate directory belongs to another user');
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) throw new Error('other users can open the gate directory');
}

/**
 * The names in <dir>/<gateId>.recipients, never through a symlink; undefined when there's none, or
 * it isn't a well-formed one in a regular file of this user's.
 * @param {string} dir
 * @param {string} gateId
 * @returns {Set<string> | undefined}
 */
export function readRecipients(dir, gateId) {
  let fd;
  try {
    fd = openSync(recipientsPath(dir, gateId), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return undefined;
  }
  try {
    const stats = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stats.isFile() || stats.size > MAX_RECIPIENTS_BYTES || (uid !== undefined && stats.uid !== uid)) return undefined;
    const buffer = Buffer.alloc(stats.size);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return asRecipients(JSON.parse(buffer.subarray(0, read).toString('utf8')));
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes the ready marker for `gateId`, 0600, never through a symlink.
 * @param {string} dir
 * @param {string} gateId
 */
export function markReady(dir, gateId) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(readyPath(dir, gateId), flags, 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ v: RECIPIENTS_VERSION, pid: process.ppid })}\n`);
  } finally {
    closeSync(fd);
  }
}

/**
 * @typedef {{ exitCode: 0 } | { exitCode: 2, stderr: string }} HookResult
 */

/**
 * What the hook does with one input: for SessionStart, marks the gate ready; for a tool call, no
 * decision or a denial. Never throws for PreToolUse: an error is a denial.
 * @param {string[]} args the gate directory and the gate id
 * @param {string | undefined} raw the hook's stdin, or undefined when it was too large
 * @returns {HookResult}
 */
export function runHook(args, raw) {
  const [dir = '', gateId = ''] = args;
  /** @type {unknown} */
  let input;
  try {
    input = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    input = undefined;
  }
  if (isRecord(input) && input.hook_event_name === 'SessionStart') {
    // Errors propagate: the marker isn't written, and pitwall stops this supervisor at its first turn.
    if (!GATE_ID_PATTERN.test(gateId)) throw new Error('not a gate id');
    checkGateDir(dir);
    markReady(dir, gateId);
    return { exitCode: 0 };
  }
  /** @param {string} why */
  const deny = (why) => /** @type {HookResult} */ ({ exitCode: 2, stderr: `${DENIAL_PREFIX} denied this SendMessage: ${why}. Don't call SendMessage again for it.` });
  try {
    if (raw === undefined) return deny('the call was too large to check');
    if (!GATE_ID_PATTERN.test(gateId)) return deny('it was started without a gate id');
    checkGateDir(dir);
    const why = refusal(input, readRecipients(dir, gateId));
    return why === undefined ? { exitCode: 0 } : deny(why);
  } catch {
    return deny('it couldn’t check the call');
  }
}

/**
 * Reads stdin, at most MAX_INPUT_BYTES. Undefined when there was more.
 * @returns {Promise<string | undefined>}
 */
async function readInput() {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  readInput()
    .then((raw) => {
      const result = runHook(process.argv.slice(2), raw);
      if (result.exitCode === 2) {
        // Set first, so a denial still blocks if stderr can't be written.
        process.exitCode = 2;
        writeSync(2, result.stderr);
      } else {
        // No decision, and nothing on stdout: Claude Code goes on to the ask rule.
        process.exitCode = 0;
      }
    })
    .catch(() => {
      // A SessionStart that failed. Exit 2 blocks a tool call outright.
      process.exitCode = 2;
    });
}
