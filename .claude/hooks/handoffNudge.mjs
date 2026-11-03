#!/usr/bin/env node
// @ts-check
// The hand-off nudge (M5.1, W133 B; spike 012): a Stop hook in pitwall's own .claude/settings.json
// that, once a session's context passes 200K tokens, tells it to finish safely and hand off with
// the `handoff` skill. Claude Code runs it in exec form, `node` with this file, after each turn of
// the main session. Sub-agents finish with SubagentStop, which isn't hooked, so they're left alone.
//
// The context size isn't in the hook's input, so it's read from the transcript, `transcript_path`:
// the last main-chain assistant entry's `message.usage`, input_tokens + cache_read_input_tokens +
// cache_creation_input_tokens, which is what that call sent. At Stop, the turn's last call isn't
// written yet, so this is the call before it: a step behind (spike 012). Internal and undocumented, as in
// src/usage/scan.ts, so it fails soft: any error, an unreadable transcript or a missing field
// exits 0 with nothing printed, which lets the session stop as usual. It reads the file's tail only.
//
// It nudges once per session per level: the threshold, then twice it. The levels already nudged
// are kept in a small file per session id under os.tmpdir(), never in the transcript's folder.
// A compaction that brings the context back under a level re-arms it.
//
// Plain JavaScript with no dependencies, checked through its JSDoc (tsconfig.json).
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Tokens of context at which a session is told to hand off; twice it is the second nudge. */
export const THRESHOLD = 200_000;

/** The most hook input read. */
const MAX_INPUT_BYTES = 1024 * 1024;

/**
 * How much of the transcript's end is read: a little first, then more while no usage is found.
 * Each call writes request lines of a MB or more after the last usage (spike 012), so the tail
 * has to be able to reach past a few of them.
 */
const TAIL_BYTES = [256 * 1024, 4 * 1024 * 1024, 32 * 1024 * 1024];

/** Claude Code's session ids are UUIDs; anything else is refused before it names a file. */
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value */
const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

/**
 * The context the last main-chain call sent, from the end of a transcript's text. Undefined when
 * there's none, or when a compaction comes after it, since its usage is no longer the context.
 * Sidechain entries (a sub-agent's calls in the main file, as older versions wrote them) and
 * synthetic messages are skipped. Lines that aren't JSON, such as a first line cut by the tail, too.
 * @param {string} text
 * @returns {number | undefined}
 */
export function lastContext(text) {
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
    if (entry.type !== 'assistant' || entry.isSidechain === true) continue;
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
 * Reads the transcript's tail, growing it once if no usage was found, and returns the context.
 * @param {string} file
 * @returns {number | undefined}
 */
export function contextOf(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    for (const want of TAIL_BYTES) {
      const length = Math.min(want, size);
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, size - length + read);
        if (n === 0) break;
        read += n;
      }
      const context = lastContext(buffer.toString('utf8', 0, read));
      if (context !== undefined || length === size) return context;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * The highest level the context has reached: 0 under the threshold, 1 past it, 2 past twice it.
 * @param {number} context
 * @param {number} threshold
 */
export const levelOf = (context, threshold) => (context >= 2 * threshold ? 2 : context >= threshold ? 1 : 0);

/**
 * What the session is told.
 * @param {number} context
 * @param {number} threshold
 */
export function nudge(context, threshold) {
  /** @param {number} n */
  const k = (n) => `${Math.round(n / 1000)}K`;
  return (
    `pitwall's hand-off hook: this session's context is about ${k(context)} tokens, past the ${k(threshold)} at which pitwall's ` +
    `sessions hand off (AGENTS.md, "Efficiency"), and every turn re-reads all of it. Don't drop what you're doing: finish the current step ` +
    `to a safe point first, so no change is left half-made, and if you're waiting on the user for an answer or an ` +
    `approval, ask for it and hand off after. Then use the handoff skill (.claude/skills/handoff/SKILL.md): update ` +
    `NOW.md, commit, and tell the user to run /clear and start the next session with "Read NOW.md".`
  );
}

/**
 * @param {string} dir
 * @param {string} sessionId
 */
const stateFile = (dir, sessionId) => path.join(dir, `${sessionId}.json`);

/**
 * The level last nudged for this session, 0 when there's no state.
 * @param {string} dir
 * @param {string} sessionId
 */
function readLevel(dir, sessionId) {
  try {
    const state = JSON.parse(readFileSync(stateFile(dir, sessionId), 'utf8'));
    return isRecord(state) && (state.level === 1 || state.level === 2) ? state.level : 0;
  } catch {
    return 0;
  }
}

/**
 * @param {string} dir
 * @param {string} sessionId
 * @param {number} level
 */
function writeLevel(dir, sessionId, level) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(stateFile(dir, sessionId), JSON.stringify({ v: 1, level }), { mode: 0o600 });
}

/**
 * The threshold, from PITWALL_HANDOFF_THRESHOLD when it's a positive whole number (for tests).
 * @param {NodeJS.ProcessEnv} env
 */
export function thresholdOf(env) {
  const raw = env.PITWALL_HANDOFF_THRESHOLD;
  if (raw === undefined || !/^[1-9][0-9]{0,9}$/.test(raw)) return THRESHOLD;
  return Number(raw);
}

/**
 * The state folder: PITWALL_HANDOFF_STATE_DIR when set (for tests), else under os.tmpdir().
 * @param {NodeJS.ProcessEnv} env
 */
export const stateDirOf = (env) => env.PITWALL_HANDOFF_STATE_DIR || path.join(os.tmpdir(), 'pitwall-handoff-nudge');

/**
 * The hook: the JSON to print, or undefined to print nothing and let the session stop. Never throws.
 * @param {string} inputText
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
export function runHook(inputText, env) {
  try {
    const input = JSON.parse(inputText);
    if (!isRecord(input) || input.hook_event_name !== 'Stop') return undefined;
    // Already continuing because of a Stop hook, this one or another: never block again.
    if (input.stop_hook_active === true) return undefined;
    // A sub-agent's context, should Stop ever arrive with one.
    if (input.agent_id !== undefined) return undefined;
    const sessionId = input.session_id;
    const transcript = input.transcript_path;
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return undefined;
    if (typeof transcript !== 'string' || !path.isAbsolute(transcript)) return undefined;

    const context = contextOf(transcript);
    if (context === undefined) return undefined;
    const threshold = thresholdOf(env);
    const dir = stateDirOf(env);
    const level = levelOf(context, threshold);
    const nudged = readLevel(dir, sessionId);
    if (level <= nudged) {
      // Back under a level after a compaction: re-arm it.
      if (level < nudged) writeLevel(dir, sessionId, level);
      return undefined;
    }
    writeLevel(dir, sessionId, level);
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: nudge(context, threshold) } });
  } catch {
    return undefined;
  }
}

/** Reads stdin up to MAX_INPUT_BYTES; more than that is treated as no input. */
async function readInput() {
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > MAX_INPUT_BYTES) return '';
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const output = runHook(await readInput(), process.env);
    if (output !== undefined) process.stdout.write(`${output}\n`);
  } catch {
    // Fail soft: nothing printed, exit 0.
  }
  process.exitCode = 0;
}
