#!/usr/bin/env node
// @ts-check
// pitwall's relay gate (D8): the hook that decides, before it runs, whether
// the relay's SendMessage call is the one pitwall asked for. Claude Code runs
// it as the relay's PreToolUse hook, from the relay's --settings, in exec form
// (`process.execPath` with this file, the gate directory and the gate id as
// arguments, and no shell), with `onFailure: "block"`.
//
// Plain JavaScript with no dependencies, so the same file runs from src/ under
// `npm run dev` and from dist/ once built. tsc copies it to dist/ (allowJs).
//
// Before pitwall writes a request to the relay's stdin, it writes the
// expectation to <dir>/<gate id>.expect (0600, in a 0700 directory):
//
//   {"v":1,"request":"<id>","to":"<name>","sha256":"<hex>","expiresAt":<epoch ms>}
//
// `sha256` is of the text's UTF-16 code units (`utf16le`), so two texts that
// differ only in a lone surrogate never hash alike. The text itself is never
// written anywhere.
//
// The hook claims the expectation by renaming it, which only one call can do,
// and then deletes it, so each expectation answers exactly one call, allowed
// or not. It allows the call only when the expectation hasn't expired, `to`
// is the expected name exactly, the message hashes to the expected hash, and
// notify_when_idle is unset or false. Anything else, including any error, is
// denied, with a reason Claude reads in the tool result. Claude Code treats a
// hook that exits 0 without a decision as "no decision", and runs the call,
// so every PreToolUse path here prints one: a crash exits non-zero, which
// `onFailure: "block"` turns into a denial.
//
// For SessionStart, it writes <dir>/<gate id>.ready and prints nothing. pitwall
// writes no request until that file appears, so a relay whose hooks didn't load
// is never used.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The expectation file's format. */
export const EXPECTATION_VERSION = 1;

/** A gate id: 32 lowercase hex characters, new for each relay process. */
export const GATE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** The most hook input read. A request's text is at most 8,192 characters. */
const MAX_INPUT_BYTES = 1024 * 1024;

/** The largest expectation file read. */
const MAX_EXPECTATION_BYTES = 4096;

/** Starts every reason the gate gives, so a denial in the relay's output says where it came from. */
export const DENIAL_PREFIX = "pitwall's relay gate";

/**
 * @typedef {{ v: number, request: string, to: string, sha256: string, expiresAt: number }} Expectation
 * @typedef {{ allow: true, reason: string } | { allow: false, reason: string }} Decision
 */

/**
 * @param {string} dir
 * @param {string} gateId
 */
export function expectationPath(dir, gateId) {
  return path.join(dir, `${gateId}.expect`);
}

/**
 * @param {string} dir
 * @param {string} gateId
 */
export function readyPath(dir, gateId) {
  return path.join(dir, `${gateId}.ready`);
}

/**
 * The hash the gate compares: SHA-256 of the text's UTF-16 code units, as hex.
 * @param {string} text
 */
export function textHash(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf16le')).digest('hex');
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An expectation, if `value` is a well-formed one.
 * @param {unknown} value
 * @returns {Expectation | undefined}
 */
export function asExpectation(value) {
  if (!isRecord(value)) return undefined;
  const { v, request, to, sha256, expiresAt } = value;
  if (v !== EXPECTATION_VERSION) return undefined;
  if (typeof request !== 'string' || !/^[0-9a-f]{16}$/.test(request)) return undefined;
  if (typeof to !== 'string' || to === '') return undefined;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return undefined;
  return { v, request, to, sha256, expiresAt };
}

/**
 * Whether the SendMessage call in a PreToolUse input is the one `expectation`
 * describes. Pure, so it can be tested without files. `expectation` is
 * undefined when none was waiting.
 *
 * Claude Code passes SendMessage's input normalized (v2.1.303): `recipient`
 * copies `to`, and must agree with it. `content` is only a preview of
 * `message`, cut at about 50 characters with an ellipsis, so it isn't
 * compared: `message` is what's sent.
 *
 * @param {unknown} input the hook's JSON input
 * @param {Expectation | undefined} expectation
 * @param {number} now milliseconds since the epoch
 * @returns {Decision}
 */
export function decide(input, expectation, now) {
  if (!isRecord(input) || input.hook_event_name !== 'PreToolUse') return deny('it was asked about something other than a tool call');
  if (input.tool_name !== 'SendMessage') return deny('the relay may only use SendMessage');
  if (expectation === undefined) return deny('pitwall has no request waiting for this message');
  if (expectation.expiresAt <= now) return deny("pitwall's request for this message has expired");
  const call = input.tool_input;
  if (!isRecord(call)) return deny('the call has no arguments');
  if (call.to !== expectation.to || (call.recipient !== undefined && call.recipient !== expectation.to)) {
    return deny('the message is addressed to a session pitwall didn’t ask for');
  }
  if (typeof call.message !== 'string' || textHash(call.message) !== expectation.sha256) return deny('the text isn’t the text pitwall asked for');
  if (call.type !== undefined && call.type !== 'message') return deny('the call isn’t a plain message');
  if (call.notify_when_idle !== undefined && call.notify_when_idle !== false) return deny('the call asks to be told when the session goes idle');
  return { allow: true, reason: `${DENIAL_PREFIX} allowed request ${expectation.request}` };
}

/**
 * @param {string} why
 * @returns {Decision}
 */
function deny(why) {
  return { allow: false, reason: `${DENIAL_PREFIX} denied this SendMessage: ${why}. Don't call SendMessage again for it.` };
}

/**
 * The hook's stdout for a decision: Claude Code's documented PreToolUse output.
 * @param {Decision} decision
 */
export function hookOutput(decision) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.allow ? 'allow' : 'deny',
      permissionDecisionReason: decision.reason,
    },
  });
}

/**
 * Checks that `dir` is a real directory, not a symlink, owned by this user
 * and closed to everyone else. Throws otherwise.
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
 * Takes the expectation waiting in `dir` for `gateId`, if any, so no other
 * call can: renames it, reads it and deletes it. Undefined when none was
 * waiting, or when it wasn't a well-formed expectation in a regular file.
 * @param {string} dir
 * @param {string} gateId
 * @returns {Expectation | undefined}
 */
export function claimExpectation(dir, gateId) {
  const claimed = path.join(dir, `${gateId}.claim-${randomBytes(6).toString('hex')}`);
  try {
    renameSync(expectationPath(dir, gateId), claimed);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const fd = openSync(claimed, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile() || stats.size > MAX_EXPECTATION_BYTES) return undefined;
      const buffer = Buffer.alloc(stats.size);
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      return asExpectation(JSON.parse(buffer.subarray(0, read).toString('utf8')));
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  } finally {
    try {
      unlinkSync(claimed);
    } catch {
      // Already gone.
    }
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
    writeSync(fd, `${JSON.stringify({ v: EXPECTATION_VERSION, pid: process.ppid })}\n`);
  } finally {
    closeSync(fd);
  }
}

/**
 * What the hook does with one input: for SessionStart, marks the gate ready
 * and prints nothing; for anything else, decides and returns the output to
 * print. Never throws for PreToolUse: an error is a denial.
 * @param {string[]} args the gate directory and the gate id
 * @param {string | undefined} raw the hook's stdin, or undefined when it was too large
 * @param {number} now
 * @returns {string | undefined} what to print
 */
export function runHook(args, raw, now) {
  const [dir = '', gateId = ''] = args;
  /** @type {unknown} */
  let input;
  try {
    input = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    input = undefined;
  }
  if (isRecord(input) && input.hook_event_name === 'SessionStart') {
    // Errors propagate: the marker isn't written, and pitwall doesn't use this relay.
    if (!GATE_ID_PATTERN.test(gateId)) throw new Error('not a gate id');
    checkGateDir(dir);
    markReady(dir, gateId);
    return undefined;
  }
  try {
    if (raw === undefined) return hookOutput(deny('the call was too large to check'));
    if (!GATE_ID_PATTERN.test(gateId)) return hookOutput(deny('it was started without a gate id'));
    checkGateDir(dir);
    // Only a SendMessage call claims the expectation; decide() denies the rest.
    const expectation = isRecord(input) && input.hook_event_name === 'PreToolUse' && input.tool_name === 'SendMessage' ? claimExpectation(dir, gateId) : undefined;
    return hookOutput(decide(input, expectation, now));
  } catch {
    return hookOutput(deny('it couldn’t check the call'));
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
      const output = runHook(process.argv.slice(2), raw, Date.now());
      if (output !== undefined) writeSync(1, output);
      process.exitCode = 0;
    })
    .catch(() => {
      // A SessionStart that failed, or stdout that can't be written. Exit 2 blocks a tool call outright.
      process.exitCode = 2;
    });
}
