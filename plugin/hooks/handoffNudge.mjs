#!/usr/bin/env node
// @ts-check
// The hand-off nudge (M5.1, W133 B; spike 012; moved into the pitwall plugin by W197): a Stop hook
// that, once a session's context passes 200K tokens, tells it to finish safely and hand off. It was in
// pitwall's own .claude/settings.json; in the plugin, every session pitwall watches gets it. Claude
// Code runs it in exec form, `node` with this file, after each turn of the main session. Sub-agents
// finish with SubagentStop, and Stop never fires inside one, so a sub-agent's own growth is
// subagentNudge.mjs' (PostToolUse).
//
// It acts only while pitwall runs (common.mjs, pitwallRunning()).
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
import path from 'node:path';
import { SESSION_ID, isMain, THRESHOLD, contextOf, isRecord, kilo, levelOf, pitwallRunning, readInput, readLevel, stateDirOf, thresholdOf as thresholdFrom, writeLevel } from './common.mjs';

export { THRESHOLD, levelOf };
export { lastContext } from './common.mjs';

/**
 * The threshold, from PITWALL_HANDOFF_THRESHOLD when it's a positive whole number (for tests).
 * @param {NodeJS.ProcessEnv} env
 */
export const thresholdOf = (env) => thresholdFrom(env, 'PITWALL_HANDOFF_THRESHOLD');

/**
 * What the session is told.
 * @param {number} context
 * @param {number} threshold
 */
export function nudge(context, threshold) {
  return (
    `pitwall's hand-off hook: this session's context is about ${kilo(context)} tokens, past the ${kilo(threshold)} at which pitwall ` +
    `asks sessions to hand off, and every turn re-reads all of it. Don't drop what you're doing: finish the current step ` +
    `to a safe point first, so no change is left half-made, and if you're waiting on the user for an answer or an ` +
    `approval, ask for it and hand off after. Then hand off: use the handoff skill if this project has one; otherwise ` +
    `write what's done, what's decided and what's next into the file the next session reads first (NOW.md or a notes file), ` +
    `commit, and tell the user to run /clear and start the next session from that file.`
  );
}

/**
 * The hook: the JSON to print, or undefined to print nothing and let the session stop. Never throws.
 * @param {string} inputText
 * @param {NodeJS.ProcessEnv} env
 * @param {Parameters<typeof pitwallRunning>[1]} [deps]
 * @returns {Promise<string | undefined>}
 */
export async function runHook(inputText, env, deps) {
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
    if (!(await pitwallRunning(env, deps))) return undefined;

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

if (isMain(import.meta.url)) {
  try {
    const output = await runHook(await readInput(), process.env);
    if (output !== undefined) process.stdout.write(`${output}\n`);
  } catch {
    // Fail soft: nothing printed, exit 0.
  }
  process.exitCode = 0;
}
