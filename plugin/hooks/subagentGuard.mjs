#!/usr/bin/env node
// @ts-check
// The fresh sub-agents guard (W197, spike 018): a PreToolUse hook on SendMessage. One sub-agent per
// piece of work: a message to a sub-agent that has finished and whose context is past 200K tokens is
// refused, with a reason that tells the session to start a new Agent call with a brief built from the
// repo and the agent's last report. Resuming it would re-read all of that context for every turn.
//
//   target                                  what happens
//   a name, a `uds:` address, anything      left alone: only `recipient_kind` "agent" with an id of letters
//   but an agent id with a file             and digits that names an agent-<id>.jsonl in the session's
//                                           subagents/ folder is looked at
//   a running agent (no `finished` key)     allowed; past the threshold, with a warning added
//   a finished agent, under the threshold   allowed (resuming is cheaper than a fresh agent)
//   a finished agent, past the threshold    refused (JSON deny; exit 2 would show the model this script's path)
//   state or size unknown, any error        allowed, nothing printed
//
// "Finished" is `"finished": true` in agent-<id>.meta.json, which Claude Code drops again when it
// resumes the agent (spike 018, finding 3); the size is the latest assistant entry's usage in
// agent-<id>.jsonl (finding 4), as common.mjs reads it. Both are internal and undocumented, so a
// missing file or key means "can't tell", which allows. A message to a running agent that finishes
// before it's delivered still resumes it: left allowed.
//
// It acts only while pitwall runs. The threshold is 200K, or PITWALL_SUBAGENT_THRESHOLD when it is set
// in the session's environment. What it reads is listed in common.mjs.
import path from 'node:path';
import { AGENT_ID, contextOf, isMain, isRecord, kilo, pitwallRunning, readInput, readMeta, subagentsDirOf, thresholdOf as thresholdFrom } from './common.mjs';

/**
 * The threshold, from PITWALL_SUBAGENT_THRESHOLD when it's a positive whole number.
 * @param {NodeJS.ProcessEnv} env
 */
export const thresholdOf = (env) => thresholdFrom(env, 'PITWALL_SUBAGENT_THRESHOLD');

/**
 * Why a message to a finished, big sub-agent is refused. The id is letters and digits; there is no path.
 * @param {string} agentId
 * @param {number} context
 * @param {number} threshold
 */
export function denyReason(agentId, context, threshold) {
  return (
    `pitwall: sub-agent ${agentId} has finished and its context is about ${kilo(context)} tokens, past the ${kilo(threshold)} ` +
    `at which a fresh agent is cheaper than resuming it: every turn would re-read all of it. Don't send it new work. ` +
    `Start a new Agent call for this piece, with a brief built from the repo (the branch and commit, what's done and decided, ` +
    `what to do next, how to check it's done) and that agent's last report. A message to a sub-agent that is still running is allowed.`
  );
}

/**
 * The warning on a message to a running sub-agent past the threshold.
 * @param {string} agentId
 * @param {number} context
 * @param {number} threshold
 */
export function warning(agentId, context, threshold) {
  return (
    `pitwall: sub-agent ${agentId} is still running and its context is about ${kilo(context)} tokens, past ${kilo(threshold)}. ` +
    `This message goes through, so a correction still reaches it. When it reports, start a new Agent call, with a brief from the repo ` +
    `and its report, for anything new, rather than sending it another message.`
  );
}

/**
 * The hook: the JSON to print, or undefined for nothing (allow). Never throws.
 * @param {string} inputText
 * @param {NodeJS.ProcessEnv} env
 * @param {Parameters<typeof pitwallRunning>[1]} [deps]
 * @returns {Promise<string | undefined>}
 */
export async function runHook(inputText, env, deps) {
  try {
    const input = JSON.parse(inputText);
    if (!isRecord(input) || input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'SendMessage') return undefined;
    const toolInput = input.tool_input;
    if (!isRecord(toolInput) || toolInput.recipient_kind !== 'agent') return undefined;
    const agentId = toolInput.to;
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return undefined;
    const folder = subagentsDirOf(input.transcript_path);
    if (folder === undefined) return undefined;

    // Cheapest first: the small meta file says whether there is anything to decide.
    const meta = readMeta(path.join(folder, `agent-${agentId}.meta.json`));
    const finished = meta?.finished === true;
    if (meta === undefined) return undefined;
    const threshold = thresholdOf(env);
    const context = contextOf(path.join(folder, `agent-${agentId}.jsonl`), { sidechain: true });
    if (context === undefined || context < threshold) return undefined;
    if (!(await pitwallRunning(env, deps))) return undefined;
    if (finished) {
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyReason(agentId, context, threshold) } });
    }
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warning(agentId, context, threshold) } });
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
