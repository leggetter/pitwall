#!/usr/bin/env node
// @ts-check
// The sub-agent context nudge (W197, spike 018, finding 6): a PostToolUse hook. Stop never fires inside
// a sub-agent, so one that grows within a single piece of work isn't told by the hand-off nudge
// (handoffNudge.mjs). A PostToolUse call from inside one carries `agent_id`; once that agent's context
// passes 200K tokens, and again past 400K, this adds a note to what it sees: finish this piece to a safe
// point and report; don't start new work.
//
// It runs after every tool call of every session and sub-agent, so it returns at once, before any file is
// read, when:
// - the input has no `agent_id` (the main session's calls), or the id isn't letters and digits;
// - this agent has already been told at the second level (a small state file, never read back down);
// and otherwise reads only the end of the agent's own transcript, agent-<id>.jsonl in the subagents/ folder
// beside the session's transcript (common.mjs, subagentsDirOf()). It acts only while pitwall runs. The
// size is a step behind: the latest finished call's. Fails soft like the others: any error prints nothing.
//
// The threshold is 200K, or PITWALL_SUBAGENT_THRESHOLD in the session's environment (the guard's, too).
// The levels already told are kept per session and agent under os.tmpdir() (common.mjs, writeLevel()).
import path from 'node:path';
import { AGENT_ID, SESSION_ID, contextOf, isMain, isRecord, kilo, levelOf, pitwallRunning, readInput, readLevel, stateDirOf, subagentsDirOf, thresholdOf as thresholdFrom, writeLevel } from './common.mjs';

/**
 * The threshold, from PITWALL_SUBAGENT_THRESHOLD when it's a positive whole number.
 * @param {NodeJS.ProcessEnv} env
 */
export const thresholdOf = (env) => thresholdFrom(env, 'PITWALL_SUBAGENT_THRESHOLD');

/**
 * What the sub-agent is told, by level.
 * @param {number} level 1 past the threshold, 2 past twice it
 * @param {number} context
 * @param {number} threshold
 */
export function nudge(level, context, threshold) {
  const lead = `pitwall: your context is about ${kilo(context)} tokens, past ${kilo(level === 2 ? 2 * threshold : threshold)}, and every step re-reads all of it.`;
  const finish =
    `Finish the piece you're on to a safe point, so no change is left half-made, then report: what's done, what's decided, what's left, ` +
    `and how to check it. Don't start new work; the session that started you will give the next piece to a fresh agent.`;
  return level === 2 ? `${lead} This is the second warning. Stop at the next safe point and report now. ${finish}` : `${lead} ${finish}`;
}

/**
 * The hook: the JSON to print, or undefined for nothing. Never throws.
 * @param {string} inputText
 * @param {NodeJS.ProcessEnv} env
 * @param {Parameters<typeof pitwallRunning>[1]} [deps]
 * @returns {Promise<string | undefined>}
 */
export async function runHook(inputText, env, deps) {
  try {
    // It runs after every tool call in every session with the plugin, and only a sub-agent's input
    // names an agent_id: skip the parse for the rest (W197's review, F5).
    if (!inputText.includes('"agent_id"')) return undefined;
    const input = JSON.parse(inputText);
    if (!isRecord(input) || input.hook_event_name !== 'PostToolUse') return undefined;
    const agentId = input.agent_id;
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return undefined;
    const sessionId = input.session_id;
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return undefined;
    const dir = stateDirOf(env);
    const key = `${sessionId}.agent-${agentId}`;
    const told = readLevel(dir, key);
    if (told >= 2) return undefined;
    const folder = subagentsDirOf(input.transcript_path);
    if (folder === undefined) return undefined;
    if (!(await pitwallRunning(env, deps))) return undefined;

    const context = contextOf(path.join(folder, `agent-${agentId}.jsonl`), { sidechain: true });
    if (context === undefined) return undefined;
    const threshold = thresholdOf(env);
    const level = levelOf(context, threshold);
    if (level <= told) return undefined;
    writeLevel(dir, key, level);
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudge(level, context, threshold) } });
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
