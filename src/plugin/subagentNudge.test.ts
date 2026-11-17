// The sub-agent context nudge (W197), plugin/hooks/subagentNudge.mjs: run as Claude Code runs it, node with a
// PostToolUse input on stdin, against made-up sub-agent files and a made-up pitwall. No real session.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { thresholdOf } from '../../plugin/hooks/subagentNudge.mjs';
import { makeKit, runScript, sessionFile, subagent, type Kit } from './pluginHookKit.js';

const SCRIPT = fileURLToPath(new URL('../../plugin/hooks/subagentNudge.mjs', import.meta.url));
const THRESHOLD = 1000;

let kit: Kit;
let n = 0;
beforeAll(async () => {
  kit = await makeKit('nudge');
});
afterAll(async () => {
  await kit.close();
});

const newSession = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const agentId = () => `a${String(++n).padStart(8, '0')}`;

/** A session transcript and one sub-agent file at `context`; the PostToolUse input for the sub-agent's tool call. */
function call(context: number, extra: Record<string, unknown> = {}) {
  const session = newSession();
  const id = agentId();
  const transcript = sessionFile(kit.tmp, `s-${session}`, ['{}']);
  subagent(transcript, id, { context, meta: {} });
  return { transcript, session, id, input: { session_id: session, transcript_path: transcript, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: { stdout: 'made up' }, agent_id: id, agent_type: 'general-purpose', ...extra } };
}
const run = (input: Record<string, unknown> | string, home = kit.home) => runScript(SCRIPT, input, { PITWALL_HOME: home, PITWALL_SUBAGENT_THRESHOLD: String(THRESHOLD), PITWALL_HANDOFF_STATE_DIR: kit.stateDir });
const quiet = { status: 0, stdout: '', stderr: '' };
const told = (stdout: string) => {
  const out = (JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;
  expect(out.hookEventName).toBe('PostToolUse');
  return out.additionalContext;
};

describe('a sub-agent’s tool call', () => {
  it('adds nothing under the threshold', () => {
    expect(run(call(999).input)).toEqual(quiet);
  });

  it('adds a note past the threshold: finish this piece and report, no new work', () => {
    const message = told(run(call(1500).input).stdout);
    expect(message).toMatch(/about 2K tokens/);
    expect(message).toMatch(/Finish the piece/);
    expect(message).toMatch(/report/);
    expect(message).toMatch(/fresh agent/);
  });

  it('says it once per level: at the threshold, again at twice it, then never', () => {
    const { transcript, session, id } = call(1100);
    const input = { session_id: session, transcript_path: transcript, hook_event_name: 'PostToolUse', agent_id: id };
    expect(told(run(input).stdout)).toMatch(/about 1K/);
    expect(run(input)).toEqual(quiet);
    const file = path.join(transcript.slice(0, -6), 'subagents', `agent-${id}.jsonl`);
    const grow = (context: number) => writeFileSync(file, `${JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'm', usage: { input_tokens: context } } })}\n`);
    grow(1500);
    expect(run(input)).toEqual(quiet);
    grow(2100);
    expect(told(run(input).stdout)).toMatch(/second warning/);
    expect(run(input)).toEqual(quiet);
    grow(9000);
    expect(run(input)).toEqual(quiet);
  });

  it('keeps agents apart', () => {
    expect(run(call(5000).input).stdout).not.toBe('');
    expect(run(call(5000).input).stdout).not.toBe('');
  });

  it('measures the context of the agent named in the input, not another’s in the same folder', () => {
    const big = call(5000);
    const other = agentId();
    subagent(big.transcript, other, { context: 300, meta: {} });
    expect(run({ ...big.input, agent_id: other })).toEqual(quiet);
  });

  it('reads only the end of the file: a large transcript with the usage before large lines still works', () => {
    const c = call(5000);
    const file = path.join(c.transcript.slice(0, -6), 'subagents', `agent-${c.id}.jsonl`);
    const blob = JSON.stringify({ type: 'api-request-blob', blob: 'x'.repeat(3 * 1024 * 1024) });
    const usageLine = JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'm', usage: { input_tokens: 5000 } } });
    writeFileSync(file, `${usageLine}\n${blob}\n${blob}\n`);
    expect(told(run(c.input).stdout)).toMatch(/about 5K/);
  });
});

describe('when it does not apply', () => {
  it('returns at once for the main session’s calls: no agent_id, or one that is not letters and digits', () => {
    const c = call(5000);
    const { agent_id: _drop, ...main } = c.input;
    expect(run(main)).toEqual(quiet);
    for (const bad of ['../x', 'a b', '', 'a'.repeat(65), 7, null]) expect(run({ ...c.input, agent_id: bad }), String(bad)).toEqual(quiet);
  });

  it('adds nothing while pitwall isn’t running', () => {
    expect(run(call(5000).input, kit.emptyHome)).toEqual(quiet);
  });

  it('adds nothing for another event, a missing agent file, an odd session id or a bad transcript path', () => {
    const c = call(5000);
    expect(run({ ...c.input, hook_event_name: 'PreToolUse' })).toEqual(quiet);
    expect(run({ ...c.input, agent_id: 'b0000000000' })).toEqual(quiet);
    expect(run({ ...c.input, session_id: '../escape' })).toEqual(quiet);
    expect(run({ ...c.input, transcript_path: 'relative.jsonl' })).toEqual(quiet);
    expect(run({ ...c.input, transcript_path: path.join(kit.tmp, 'none.jsonl') })).toEqual(quiet);
  });

  it('exits 0 and prints nothing for input that is not JSON, empty, or large', () => {
    for (const input of ['not json', '', '[]', 'null']) expect(run(input), input).toEqual(quiet);
    const c = call(5000);
    expect(told(run({ ...c.input, tool_response: { stdout: 'x'.repeat(3 * 1024 * 1024) } }).stdout)).toMatch(/about 5K/);
  });
});

describe('the threshold', () => {
  it('is 200K by default, with a positive whole-number override only', () => {
    expect(thresholdOf({})).toBe(200_000);
    expect(thresholdOf({ PITWALL_SUBAGENT_THRESHOLD: '1000' })).toBe(1000);
    expect(thresholdOf({ PITWALL_SUBAGENT_THRESHOLD: '0' })).toBe(200_000);
  });
});
