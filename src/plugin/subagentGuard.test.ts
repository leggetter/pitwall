// The fresh sub-agents guard (W197), plugin/hooks/subagentGuard.mjs: run as Claude Code runs it, node with a
// PreToolUse input on stdin, against made-up sub-agent folders and a made-up pitwall. No real session.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { denyReason, thresholdOf } from '../../plugin/hooks/subagentGuard.mjs';
import { makeKit, runScript, sessionFile, subagent, type Kit } from './pluginHookKit.js';

const SCRIPT = fileURLToPath(new URL('../../plugin/hooks/subagentGuard.mjs', import.meta.url));
const AGENT = 'a65f915610a93f47e';
const THRESHOLD = 1000;

let kit: Kit;
let n = 0;
beforeAll(async () => {
  kit = await makeKit('guard');
});
afterAll(async () => {
  await kit.close();
});

/** A session transcript with a subagents/ folder, and the PreToolUse input for a SendMessage to `to`. */
function setup(agent: { context?: number; meta?: Record<string, unknown> | string } | undefined) {
  const transcript = sessionFile(kit.tmp, `session-${++n}`, ['{}']);
  if (agent !== undefined) subagent(transcript, AGENT, agent);
  return transcript;
}
const send = (transcript: string, to: string = AGENT, kind: unknown = 'agent', extra: Record<string, unknown> = {}) => ({
  session_id: '0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
  transcript_path: transcript,
  cwd: kit.tmp,
  hook_event_name: 'PreToolUse',
  tool_name: 'SendMessage',
  tool_input: { to, recipient_kind: kind, message: 'made up' },
  ...extra,
});
const run = (input: Record<string, unknown> | string, home = kit.home) => runScript(SCRIPT, input, { PITWALL_HOME: home, PITWALL_SUBAGENT_THRESHOLD: String(THRESHOLD) });
const quiet = { status: 0, stdout: '', stderr: '' };

function decision(stdout: string) {
  return (JSON.parse(stdout) as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput;
}

describe('a finished sub-agent', () => {
  it('is refused past the threshold, by a JSON deny whose reason names the agent, the size and a fresh Agent call, and no path', () => {
    const result = run(send(setup({ context: 5000, meta: { finished: true } })));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const out = decision(result.stdout);
    expect(out.hookEventName).toBe('PreToolUse');
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toMatch(new RegExp(`sub-agent ${AGENT} has finished`));
    expect(out.permissionDecisionReason).toMatch(/about 5K tokens/);
    expect(out.permissionDecisionReason).toMatch(/new Agent call/);
    expect(out.permissionDecisionReason).toMatch(/last report/);
    expect(out.permissionDecisionReason).not.toContain(kit.tmp);
    expect(out.permissionDecisionReason).not.toContain('/');
  });

  it('is refused at exactly the threshold, and allowed under it', () => {
    expect(run(send(setup({ context: THRESHOLD, meta: { finished: true } }))).stdout).toContain('"deny"');
    expect(run(send(setup({ context: THRESHOLD - 1, meta: { finished: true } })))).toEqual(quiet);
  });

  it('is allowed while pitwall isn’t running', () => {
    expect(run(send(setup({ context: 5000, meta: { finished: true } })), kit.emptyHome)).toEqual(quiet);
  });
});

describe('a running sub-agent', () => {
  it('is allowed under the threshold, and past it with a warning that still lets the message through', () => {
    expect(run(send(setup({ context: 500, meta: {} })))).toEqual(quiet);
    const out = decision(run(send(setup({ context: 5000, meta: { name: 'x' } }))).stdout);
    expect(out.permissionDecision).toBeUndefined();
    expect(out.additionalContext).toMatch(/still running/);
    expect(out.additionalContext).toMatch(/goes through/);
  });

  it('is one that was resumed: the finished key is gone, so it is allowed with the warning', () => {
    const out = decision(run(send(setup({ context: 5000, meta: { finished: false } }))).stdout);
    expect(out.permissionDecision).toBeUndefined();
    expect(out.additionalContext).toMatch(/still running/);
  });
});

describe('when the state or the size is unknown', () => {
  it('allows with no meta file, no agent transcript, an unparsable or oversized meta file, or no usage', () => {
    expect(run(send(setup({ context: 5000 })))).toEqual(quiet);
    expect(run(send(setup({ meta: { finished: true } })))).toEqual(quiet);
    expect(run(send(setup({ context: 5000, meta: '{"finished": tru' })))).toEqual(quiet);
    expect(run(send(setup({ context: 5000, meta: `{"finished":true,"pad":"${'x'.repeat(70_000)}"}` })))).toEqual(quiet);
    expect(run(send(setup(undefined)))).toEqual(quiet);
    const noUsage = setup({ meta: { finished: true } });
    writeFileSync(path.join(noUsage.slice(0, -6), 'subagents', `agent-${AGENT}.jsonl`), '{"type":"user"}\nnot json\n');
    expect(run(send(noUsage))).toEqual(quiet);
  });
});

describe('targets it leaves alone', () => {
  const big = () => setup({ context: 5000, meta: { finished: true } });

  it('a session name, a uds: address, any other recipient kind, and no kind', () => {
    const t = big();
    expect(run(send(t, 'pitwall-test-w197-other', 'name'))).toEqual(quiet);
    expect(run(send(t, 'uds:/tmp/made-up.sock', 'uds'))).toEqual(quiet);
    expect(run(send(t, AGENT, 'name'))).toEqual(quiet);
    expect(run(send(t, AGENT, null))).toEqual(quiet);
  });

  it('an id that is not letters and digits, such as one that climbs out of the folder', () => {
    const t = big();
    for (const to of ['../x', `${AGENT}/../${AGENT}`, `${AGENT}.meta`, '', 'a'.repeat(65), 'a b']) expect(run(send(t, to)), to).toEqual(quiet);
  });

  it('an agent with no file in subagents/, and other tools and events', () => {
    const t = big();
    expect(run(send(t, 'b0000000000000000'))).toEqual(quiet);
    expect(run(send(t, AGENT, 'agent', { tool_name: 'Bash' }))).toEqual(quiet);
    expect(run(send(t, AGENT, 'agent', { hook_event_name: 'PostToolUse' }))).toEqual(quiet);
  });
});

describe('files that are not what Claude Code writes', () => {
  it('a symlinked meta file or agent transcript is not read', () => {
    const t = setup({ context: 5000, meta: { finished: true } });
    const dir = path.join(t.slice(0, -6), 'subagents');
    const elsewhere = path.join(kit.tmp, `elsewhere-${n}.json`);
    writeFileSync(elsewhere, '{"finished":true}');
    const meta = path.join(dir, `agent-${AGENT}.meta.json`);
    writeFileSync(`${meta}.real`, '{"finished":true}');
    const linked = setup(undefined);
    const linkedDir = subagent(linked, AGENT, { context: 5000 });
    symlinkSync(elsewhere, path.join(linkedDir, `agent-${AGENT}.meta.json`));
    expect(run(send(linked))).toEqual(quiet);
    // A link in place of the agent's transcript.
    const other = setup({ meta: { finished: true } });
    const otherDir = path.join(other.slice(0, -6), 'subagents');
    const real = path.join(kit.tmp, `real-agent-${n}.jsonl`);
    writeFileSync(real, '{"type":"assistant","isSidechain":true,"message":{"model":"m","usage":{"input_tokens":5000}}}\n');
    symlinkSync(real, path.join(otherDir, `agent-${AGENT}.jsonl`));
    expect(run(send(other))).toEqual(quiet);
  });

  it('a subagents/ folder that is a link, or a session folder that is a file, is not entered', () => {
    const t = sessionFile(kit.tmp, `session-link-${++n}`, ['{}']);
    const real = mkdtempSync(path.join(kit.tmp, 'real-subagents-'));
    writeFileSync(path.join(real, `agent-${AGENT}.meta.json`), '{"finished":true}');
    writeFileSync(path.join(real, `agent-${AGENT}.jsonl`), '{"type":"assistant","isSidechain":true,"message":{"model":"m","usage":{"input_tokens":5000}}}\n');
    mkdirSync(t.slice(0, -6));
    symlinkSync(real, path.join(t.slice(0, -6), 'subagents'));
    expect(run(send(t))).toEqual(quiet);
    const f = sessionFile(kit.tmp, `session-file-${++n}`, ['{}']);
    writeFileSync(f.slice(0, -6), 'a file, not a folder');
    expect(run(send(f))).toEqual(quiet);
  });

  it('a transcript path that is relative, not .jsonl, or missing', () => {
    expect(run(send('relative/session.jsonl'))).toEqual(quiet);
    expect(run(send(path.join(kit.tmp, 'session.txt')))).toEqual(quiet);
    expect(run(send(path.join(kit.tmp, 'nothing-here.jsonl')))).toEqual(quiet);
  });
});

describe('bad input', () => {
  it('exits 0 and prints nothing for input that is not JSON, empty, or the wrong shape', () => {
    for (const input of ['not json', '', '[]', 'null', '{"tool_input":5,"tool_name":"SendMessage","hook_event_name":"PreToolUse"}']) expect(run(input), input).toEqual(quiet);
  });
});

describe('the threshold and the reason', () => {
  it('is 200K by default, with a positive whole-number override only', () => {
    expect(thresholdOf({})).toBe(200_000);
    expect(thresholdOf({ PITWALL_SUBAGENT_THRESHOLD: '1000' })).toBe(1000);
    for (const bad of ['0', '-5', 'lots', '1e6', '']) expect(thresholdOf({ PITWALL_SUBAGENT_THRESHOLD: bad })).toBe(200_000);
  });

  it('names no path', () => {
    expect(denyReason(AGENT, 255_000, 200_000)).not.toMatch(/[\\/]/);
  });
});
