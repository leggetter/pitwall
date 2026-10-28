// Synthetic fixtures only: made-up sessions, ids and descriptions, never a real transcript.
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunError } from './exec.js';
import { SUBAGENTS_MAX, type SubagentSummary } from '../shared/protocol.js';
import {
  createSubagentTracker,
  DEFAULT_SUBAGENT_DESCRIPTION,
  descriptionText,
  isSafeAgentId,
  META_MAX_BYTES,
  processStartTime,
  RESUMED_AFTER_MS,
  SUBAGENT_DESCRIPTION_MAX,
  SUBAGENT_RECHECK_MS,
  UNSTARTED_ACTIVE_MS,
  type SubagentTracker,
  type TrackedSubagentSession,
} from './subagents.js';

const SID = '11111111-1111-4111-8111-111111111111';
const T0 = Date.parse('2026-10-27T10:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

// --- Transcript lines, in the shapes the coordinator's notes describe ---------------------------------

function agentCall(toolUseId: string, description: string, seconds: number, input: Record<string, unknown> = {}, sidechain = false): string {
  return line({
    type: 'assistant',
    ...(sidechain ? { isSidechain: true } : {}),
    sessionId: SID,
    timestamp: at(seconds),
    message: { id: `msg_${toolUseId}`, content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description, prompt: 'Do the made-up thing.', subagent_type: 'general-purpose', ...input } }] },
  });
}

function agentResult(toolUseId: string, seconds: number, options: { text?: string; error?: boolean; toolUseResult?: unknown; sidechain?: boolean } = {}): string {
  return line({
    type: 'user',
    ...(options.sidechain === true ? { isSidechain: true } : {}),
    sessionId: SID,
    timestamp: at(seconds),
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, ...(options.error === true ? { is_error: true } : {}), content: [{ type: 'text', text: options.text ?? 'Done.' }] }] },
    ...(options.toolUseResult === undefined ? {} : { toolUseResult: options.toolUseResult }),
  });
}

/** A background launch's result, which comes back at once. */
function launched(toolUseId: string, agentId: string, seconds: number, sidechain = false): string {
  return agentResult(toolUseId, seconds, { text: `Async agent launched successfully. agentId: ${agentId}`, toolUseResult: { isAsync: true, status: 'async_launched', agentId }, sidechain });
}

function notice(agentId: string, status: string, seconds: number, sidechain = false): string {
  return line({
    type: 'user',
    ...(sidechain ? { isSidechain: true } : {}),
    sessionId: SID,
    timestamp: at(seconds),
    origin: { kind: 'task-notification' },
    message: { content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>` },
  });
}

function report(agentId: string, text: string, seconds: number): string {
  return line({ type: 'user', sessionId: SID, timestamp: at(seconds), origin: { kind: 'peer', from: agentId }, message: { content: text } });
}

/** A sub-agent's own transcript: its prompt, then `calls` tool calls with their results. */
function subTranscript(agentId: string, seconds: number, calls: number): string {
  let out = line({ type: 'user', isSidechain: true, agentId, sessionId: SID, timestamp: at(seconds), message: { role: 'user', content: 'Do the made-up thing.' } });
  for (let i = 0; i < calls; i++) {
    out += line({ type: 'assistant', isSidechain: true, agentId, sessionId: SID, timestamp: at(seconds + 1 + i), message: { id: `m_${agentId}_${i}`, content: [{ type: 'tool_use', id: `toolu_${agentId}_${i}`, name: 'Bash', input: { command: `echo ${i}` } }] } });
    out += line({ type: 'user', isSidechain: true, agentId, sessionId: SID, timestamp: at(seconds + 1 + i), message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${agentId}_${i}`, content: `${i}` }] } });
  }
  return out;
}

function meta(toolUseId: string, description: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ agentType: 'general-purpose', isBuiltIn: true, description, toolUseId, spawnDepth: 1, requestShape: 'background', requestNonInteractive: true, ...extra });
}

// --- The fixture -------------------------------------------------------------------------------------

let dir: string;
let main: string;
let folder: string;
let tracker: SubagentTracker;
let clock: number;
/** What the tracker is told the session's process's start was: unknown unless a test says. */
let processStart: ReturnType<typeof vi.fn<(pid: number) => Promise<number | undefined>>>;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-subagents-')));
  const project = path.join(dir, 'projects', '-work-app');
  folder = path.join(project, SID, 'subagents');
  await mkdir(folder, { recursive: true });
  main = path.join(project, `${SID}.jsonl`);
  clock = T0 + 3_600_000;
  processStart = vi.fn(async (_pid: number) => undefined as number | undefined);
  tracker = createSubagentTracker({ now: () => clock, processStartMs: processStart });
});

afterEach(async () => {
  tracker.stop();
  await rm(dir, { recursive: true, force: true });
});

const live = (overrides: Partial<TrackedSubagentSession> = {}): TrackedSubagentSession => ({ sessionId: SID, file: main, alive: true, pid: 4242, startedAt: at(0), ...overrides });

/** A sub-agent the session started in the background: its meta, its transcript, its call and launch in the session's transcript. */
async function background(agentId: string, description: string, seconds: number, calls = 1): Promise<string> {
  await writeFile(path.join(folder, `agent-${agentId}.meta.json`), meta(`toolu_${agentId}`, description));
  await writeFile(path.join(folder, `agent-${agentId}.jsonl`), subTranscript(agentId, seconds + 1, calls));
  return agentCall(`toolu_${agentId}`, description, seconds, { run_in_background: true }) + launched(`toolu_${agentId}`, agentId, seconds);
}

/** Sets a sub-agent's files' mtimes, as if it was last active at `seconds`. */
async function age(agentId: string, seconds: number): Promise<void> {
  const when = new Date(Date.parse(at(seconds)));
  for (const name of [`agent-${agentId}.jsonl`, `agent-${agentId}.meta.json`]) await utimes(path.join(folder, name), when, when).catch(() => undefined);
}

async function listed(): Promise<Map<string, SubagentSummary>> {
  const list = await tracker.list(SID);
  return new Map((list?.subagents ?? []).map((s) => [s.agentId, s]));
}

describe('descriptionText and isSafeAgentId', () => {
  it('keeps a description as plain text on one line, at most 200 characters', () => {
    expect(descriptionText('  Build\nW72\topen in an editor  ')).toBe('Build W72 open in an editor');
    expect(descriptionText('Fix \u001b[31mred\u001b[0m \u0007tests\u0000')).toBe('Fix red tests');
    expect(descriptionText('Rename \u202egnp.exe\u202c and \u2066this\u2069\u200f')).toBe('Rename gnp.exe and this');
    const long = descriptionText(`${'word '.repeat(100)}end`);
    expect(long?.length).toBeLessThanOrEqual(SUBAGENT_DESCRIPTION_MAX);
    expect(long?.endsWith('…')).toBe(true);
    expect(descriptionText('x'.repeat(1_000_000))?.length).toBe(SUBAGENT_DESCRIPTION_MAX);
    expect(descriptionText(' \n\u200e ')).toBeUndefined();
    expect(descriptionText(42)).toBeUndefined();
  });

  it('takes agent ids of letters and digits only', () => {
    expect(isSafeAgentId('a7bfea4102a9f1853')).toBe(true);
    for (const bad of ['', '../x', 'a/b', 'a.b', 'a-b', 'a_b', 'a b', 'a\u0000', 'é1', 'x'.repeat(65)]) expect(isSafeAgentId(bad)).toBe(false);
  });
});

describe('createSubagentTracker', () => {
  it('says each state: running, done, failed and stopped, and unknown once the process has ended', async () => {
    let body = '';
    body += await background('a1', 'Still going', 10);
    body += await background('a2', 'Finished fine', 20);
    body += await background('a3', 'Broke', 30);
    body += await background('a4', 'Was stopped', 40);
    body += notice('a2', 'completed', 100) + report('a2', 'Here is the made-up report.', 101);
    body += notice('a3', 'failed', 110);
    body += notice('a4', 'killed', 120);
    await writeFile(main, body);

    tracker.track([live()]);
    let agents = await listed();
    expect(Object.fromEntries([...agents].map(([id, s]) => [id, s.state]))).toEqual({ a1: 'running', a2: 'done', a3: 'failed', a4: 'stopped' });
    expect(agents.get('a1')).toEqual({
      agentId: 'a1',
      description: 'Still going',
      agentType: 'general-purpose',
      background: true,
      state: 'running',
      startedAt: at(11),
      lastActivityAt: at(12),
      toolCalls: 1,
    });
    expect(tracker.running(SID)).toBe(1);

    tracker.track([live({ alive: false, pid: undefined })]);
    agents = await listed();
    expect(agents.get('a1')?.state).toBe('unknown');
    expect(agents.get('a2')?.state).toBe('done');
    expect(tracker.running(SID)).toBe(0);
  });

  it('reads stopped from any of its words, and leaves a status it doesn’t know as no end', async () => {
    let body = '';
    for (const [id, status] of [['b1', 'stopped'], ['b2', 'Cancelled'], ['b3', 'aborted'], ['b4', 'error'], ['b5', 'running'], ['b6', 'something-new']] as const) {
      body += (await background(id, `Job ${id}`, 10)) + notice(id, status, 50);
    }
    await writeFile(main, body);
    tracker.track([live()]);
    const states = Object.fromEntries([...(await listed())].map(([id, s]) => [id, s.state]));
    expect(states).toEqual({ b1: 'stopped', b2: 'stopped', b3: 'stopped', b4: 'failed', b5: 'running', b6: 'running' });
  });

  it('finds a task notification in a queue-operation or an attachment, but not one a tool’s output quotes', async () => {
    let body = '';
    body += await background('q1', 'Queued', 10);
    body += await background('q2', 'Attached', 20);
    body += await background('q3', 'Quoted', 30);
    body += line({ type: 'queue-operation', operation: 'enqueue', timestamp: at(60), sessionId: SID, content: '<task-notification><task-id>q1</task-id><status>completed</status></task-notification>' });
    body += line({ type: 'attachment', timestamp: at(61), sessionId: SID, attachment: { type: 'queued_command', prompt: '<task-notification><task-id>q2</task-id><status>failed</status></task-notification>' } });
    // A Read of a file that holds one, and an assistant quoting one: neither is a notification.
    body += line({ type: 'user', timestamp: at(62), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: '<task-notification><task-id>q3</task-id><status>completed</status></task-notification>' }] } });
    body += line({ type: 'user', timestamp: at(63), message: { content: 'Look at this: <task-notification><task-id>q3</task-id><status>completed</status></task-notification>' } });
    body += line({ type: 'assistant', timestamp: at(64), message: { content: [{ type: 'text', text: '<task-notification><task-id>q3</task-id><status>completed</status></task-notification>' }] } });
    await writeFile(main, body);
    tracker.track([live()]);
    const states = Object.fromEntries([...(await listed())].map(([id, s]) => [id, s.state]));
    expect(states).toEqual({ q1: 'done', q2: 'failed', q3: 'running' });
  });

  it('ends a sub-agent the session waited for with its call’s result: done, or failed for an error; running until then', async () => {
    await writeFile(path.join(folder, 'agent-f1.meta.json'), meta('toolu_f1', 'Waited for', { requestShape: 'foreground' }));
    await writeFile(path.join(folder, 'agent-f1.jsonl'), subTranscript('f1', 11, 2));
    await writeFile(path.join(folder, 'agent-f2.meta.json'), meta('toolu_f2', 'Waited for and broke', { requestShape: 'foreground' }));
    await writeFile(path.join(folder, 'agent-f2.jsonl'), subTranscript('f2', 21, 1));
    // No requestShape and no run_in_background: a result that isn't marked async is its end.
    await writeFile(path.join(folder, 'agent-f3.meta.json'), JSON.stringify({ description: 'Shape not recorded', toolUseId: 'toolu_f3' }));
    await writeFile(path.join(folder, 'agent-f4.meta.json'), meta('toolu_f4', 'Still waited for', { requestShape: 'foreground' }));
    await writeFile(path.join(folder, 'agent-f4.jsonl'), subTranscript('f4', 41, 3));
    await writeFile(
      main,
      agentCall('toolu_f1', 'Waited for', 10) +
        agentResult('toolu_f1', 15, { text: 'The made-up report.\nagentId: f1 (use SendMessage to continue)' }) +
        agentCall('toolu_f2', 'Waited for and broke', 20) +
        agentResult('toolu_f2', 25, { error: true, text: 'It failed.' }) +
        agentCall('toolu_f3', 'Shape not recorded', 30) +
        agentResult('toolu_f3', 35) +
        agentCall('toolu_f4', 'Still waited for', 40),
    );
    tracker.track([live()]);
    const agents = await listed();
    expect(agents.get('f1')).toMatchObject({ state: 'done', background: false, toolCalls: 2 });
    expect(agents.get('f2')).toMatchObject({ state: 'failed', background: false });
    expect(agents.get('f3')?.state).toBe('done');
    expect(agents.get('f3')).not.toHaveProperty('background');
    expect(agents.get('f4')).toMatchObject({ state: 'running', background: false, toolCalls: 3 });
    expect(tracker.running(SID)).toBe(1);
  });

  it('a background launch that failed at once is failed, though its result came back at once', async () => {
    await writeFile(path.join(folder, 'agent-e1.meta.json'), meta('toolu_e1', 'Never started'));
    await writeFile(main, agentCall('toolu_e1', 'Never started', 10, { run_in_background: true }) + agentResult('toolu_e1', 11, { error: true, text: 'Could not start.' }));
    tracker.track([live()]);
    expect((await listed()).get('e1')).toMatchObject({ state: 'failed', background: true, toolCalls: 0 });
  });

  it('gives a nested sub-agent startedBy the sub-agent whose transcript has its Agent call, and its end from there', async () => {
    await writeFile(path.join(folder, 'agent-n1.meta.json'), meta('toolu_n1', 'Parent job'));
    await writeFile(path.join(folder, 'agent-n2.meta.json'), meta('toolu_n2', 'Child job', { spawnDepth: 2 }));
    await writeFile(path.join(folder, 'agent-n3.meta.json'), meta('toolu_n3', 'Another child', { spawnDepth: 2 }));
    await writeFile(
      path.join(folder, 'agent-n1.jsonl'),
      subTranscript('n1', 11, 1) +
        agentCall('toolu_n2', 'Child job', 20, { run_in_background: true }, true) +
        launched('toolu_n2', 'n2', 20, true) +
        agentCall('toolu_n3', 'Another child', 21, { run_in_background: true }, true) +
        launched('toolu_n3', 'n3', 21, true) +
        notice('n2', 'completed', 40, true),
    );
    await writeFile(path.join(folder, 'agent-n2.jsonl'), subTranscript('n2', 22, 1));
    await writeFile(path.join(folder, 'agent-n3.jsonl'), subTranscript('n3', 23, 1));
    await writeFile(main, agentCall('toolu_n1', 'Parent job', 10, { run_in_background: true }) + launched('toolu_n1', 'n1', 10));
    tracker.track([live()]);
    const agents = await listed();
    expect(agents.get('n1')).toMatchObject({ state: 'running', toolCalls: 3 });
    expect(agents.get('n1')).not.toHaveProperty('startedBy');
    expect(agents.get('n2')).toMatchObject({ state: 'done', startedBy: 'n1', description: 'Child job' });
    expect(agents.get('n3')).toMatchObject({ state: 'running', startedBy: 'n1' });
    expect(tracker.running(SID)).toBe(2);
  });

  it('with a missing or malformed meta file, has fewer fields and never fails', async () => {
    // m1: no meta, but its launch names it, so its call gives the description and type.
    await writeFile(path.join(folder, 'agent-m1.jsonl'), subTranscript('m1', 11, 1));
    // m2: no meta and nothing names it.
    await writeFile(path.join(folder, 'agent-m2.jsonl'), subTranscript('m2', 21, 1));
    // m3 to m6: a meta that isn't JSON, isn't an object, has the wrong types, or is too big.
    await writeFile(path.join(folder, 'agent-m3.meta.json'), '{"description": "cut off');
    await writeFile(path.join(folder, 'agent-m4.meta.json'), '["Build W72"]');
    await writeFile(path.join(folder, 'agent-m5.meta.json'), JSON.stringify({ description: 7, agentType: ['x'], toolUseId: '../../etc', requestShape: 3 }));
    await writeFile(path.join(folder, 'agent-m6.meta.json'), JSON.stringify({ description: 'Too big', pad: 'x'.repeat(META_MAX_BYTES) }));
    // m7: a meta and no transcript yet.
    await writeFile(path.join(folder, 'agent-m7.meta.json'), meta('toolu_m7', 'Just started'));
    // A transcript with lines that aren't JSON among its own.
    await writeFile(path.join(folder, 'agent-m8.jsonl'), `not json\n{"type":\n${subTranscript('m8', 81, 2)}[1,2]\n`);
    await writeFile(
      main,
      `garbage\n${agentCall('toolu_m1', 'Named by its launch', 10, { subagent_type: 'Explore', run_in_background: true })}${launched('toolu_m1', 'm1', 10)}${agentCall('toolu_m7', 'Just started', 70, { run_in_background: true })}`,
    );
    tracker.track([live()]);
    const agents = await listed();
    expect([...agents.keys()].sort()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']);
    expect(agents.get('m1')).toMatchObject({ description: 'Named by its launch', agentType: 'Explore', background: true, state: 'running', toolCalls: 1 });
    for (const id of ['m2', 'm3', 'm4', 'm5', 'm6']) {
      const agent = agents.get(id);
      expect(agent?.description).toBe(DEFAULT_SUBAGENT_DESCRIPTION);
      expect(agent).not.toHaveProperty('agentType');
      expect(agent).not.toHaveProperty('background');
    }
    expect(agents.get('m7')).toMatchObject({ description: 'Just started', state: 'running', toolCalls: 0 });
    expect(agents.get('m7')).not.toHaveProperty('startedAt');
    expect(agents.get('m8')).toMatchObject({ toolCalls: 2, startedAt: at(81), lastActivityAt: at(83) });
  });

  it('cleans a meta file’s description and type', async () => {
    await writeFile(path.join(folder, 'agent-c1.meta.json'), meta('toolu_c1', 'Line one\nline \u202etwo\u0007', { agentType: ' Explore\t' }));
    await writeFile(path.join(folder, 'agent-c2.meta.json'), meta('toolu_c2', ' \u200f\n '));
    await writeFile(path.join(folder, 'agent-c3.meta.json'), meta('toolu_c3', 'y'.repeat(500)));
    tracker.track([live()]);
    const agents = await listed();
    expect(agents.get('c1')).toMatchObject({ description: 'Line one line two', agentType: 'Explore' });
    expect(agents.get('c2')?.description).toBe(DEFAULT_SUBAGENT_DESCRIPTION);
    expect(agents.get('c3')?.description).toHaveLength(SUBAGENT_DESCRIPTION_MAX);
  });

  it('never follows a symlink in the subagents folder, or a symlinked folder', async () => {
    const outside = path.join(dir, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.jsonl'), subTranscript('s1', 1, 4));
    await writeFile(path.join(outside, 'secret.meta.json'), meta('toolu_s1', 'Outside'));
    await symlink(path.join(outside, 'secret.jsonl'), path.join(folder, 'agent-s1.jsonl'));
    await symlink(path.join(outside, 'secret.meta.json'), path.join(folder, 'agent-s1.meta.json'));
    // A folder named like a transcript is skipped too.
    await mkdir(path.join(folder, 'agent-d1.jsonl'));
    await writeFile(path.join(folder, 'agent-ok.jsonl'), subTranscript('ok', 1, 1));
    tracker.track([live()]);
    expect([...(await listed()).keys()]).toEqual(['ok']);
    expect(await tracker.transcript(SID, 's1')).toBeUndefined();
    expect(await tracker.transcript(SID, 'd1')).toBeUndefined();
    expect(await tracker.transcript(SID, 'ok')).toEqual({ file: path.join(folder, 'agent-ok.jsonl') });

    // The subagents folder itself a symlink to a folder full of agents: none.
    await rm(folder, { recursive: true });
    const elsewhere = path.join(outside, 'subagents');
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, 'agent-x1.jsonl'), subTranscript('x1', 1, 1));
    await symlink(elsewhere, folder);
    expect((await tracker.list(SID))?.subagents).toEqual([]);
    expect(await tracker.transcript(SID, 'x1')).toBeUndefined();
  });

  it('keeps agent ids to letters and digits, and builds no path from an id it wasn’t listed with', async () => {
    for (const name of ['agent-a.b.jsonl', 'agent-a-b.jsonl', 'agent-.jsonl', 'agent-a_b.meta.json', 'Agent-up.jsonl', 'agent-ok.jsonl.bak', 'notes.txt']) {
      await writeFile(path.join(folder, name), subTranscript('zz', 1, 1));
    }
    await writeFile(path.join(folder, 'agent-good1.jsonl'), subTranscript('good1', 1, 1));
    // A file one level up, which `../` would reach.
    await writeFile(path.join(folder, '..', 'agent-up.jsonl'), subTranscript('up', 1, 1));
    tracker.track([live()]);
    expect([...(await listed()).keys()]).toEqual(['good1']);
    for (const id of ['../agent-up', '..', '../../secret', 'good1/../good1', 'good1.jsonl', 'a.b', '', 'up']) {
      expect(await tracker.transcript(SID, id)).toBeUndefined();
    }
  });

  it(`lists at most ${SUBAGENTS_MAX}, running ones first and then the newest started, and says it left the oldest out`, async () => {
    let body = '';
    for (let n = 0; n < SUBAGENTS_MAX + 5; n++) {
      const id = `t${n}`;
      await writeFile(path.join(folder, `agent-${id}.meta.json`), meta(`toolu_${id}`, `Job ${n}`));
      await writeFile(path.join(folder, `agent-${id}.jsonl`), subTranscript(id, 1000 + n * 10, 0));
      body += agentCall(`toolu_${id}`, `Job ${n}`, 1000 + n * 10 - 1, { run_in_background: true }) + launched(`toolu_${id}`, id, 1000 + n * 10 - 1);
      // The three oldest are still running; the rest are done.
      if (n >= 3) body += notice(id, 'completed', 5000 + n);
    }
    await writeFile(main, body);
    tracker.track([live()]);
    const list = await tracker.list(SID);
    expect(list?.sessionId).toBe(SID);
    expect(list?.truncated).toBe(true);
    expect(list?.subagents).toHaveLength(SUBAGENTS_MAX);
    const ids = list?.subagents.map((s) => s.agentId) ?? [];
    expect(ids.slice(0, 3)).toEqual(['t2', 't1', 't0']);
    expect(ids.slice(3, 6)).toEqual(['t204', 't203', 't202']);
    // The five oldest done ones are the ones left out.
    for (const id of ['t3', 't4', 't5', 't6', 't7']) expect(ids).not.toContain(id);
    expect(ids.at(-1)).toBe('t8');
    expect(tracker.running(SID)).toBe(3);

    await rm(path.join(folder, 'agent-t204.jsonl'));
    await rm(path.join(folder, 'agent-t204.meta.json'));
    await rm(path.join(folder, 'agent-t203.jsonl'));
    await rm(path.join(folder, 'agent-t203.meta.json'));
    await rm(path.join(folder, 'agent-t202.jsonl'));
    await rm(path.join(folder, 'agent-t202.meta.json'));
    await rm(path.join(folder, 'agent-t201.jsonl'));
    await rm(path.join(folder, 'agent-t201.meta.json'));
    await rm(path.join(folder, 'agent-t200.jsonl'));
    await rm(path.join(folder, 'agent-t200.meta.json'));
    const exactly = await tracker.list(SID);
    expect(exactly?.subagents).toHaveLength(SUBAGENTS_MAX);
    expect(exactly?.truncated).toBe(false);
  });

  it('updates the running count when one ends, tells its subscribers once, and reads only what was appended', async () => {
    await writeFile(main, (await background('r1', 'First', 10)) + (await background('r2', 'Second', 20)));
    let told = 0;
    tracker.subscribe(() => told++);
    tracker.track([live()]);
    await tracker.settled();
    expect(told).toBe(1);
    expect(tracker.running(SID)).toBe(2);

    // Nothing new: no news, and nothing read.
    const before = tracker.stats().bytesRead;
    tracker.track([live()]);
    await tracker.settled();
    expect(told).toBe(1);
    expect(tracker.stats().bytesRead).toBe(before);

    const ending = notice('r1', 'completed', 60);
    await appendFile(main, ending);
    tracker.track([live()]);
    await tracker.settled();
    expect(tracker.stats().bytesRead).toBe(before + Buffer.byteLength(ending));
    expect(told).toBe(2);
    expect(tracker.running(SID)).toBe(1);
    expect((await listed()).get('r1')?.state).toBe('done');
  });

  it(`rechecks an ended sub-agent’s transcript and the meta files it has read every ${SUBAGENT_RECHECK_MS / 1000} s in the background, and at once when the list is asked for`, async () => {
    await writeFile(main, (await background('v1', 'Ended', 10)) + (await background('v2', 'Running', 20)) + notice('v1', 'completed', 40));
    tracker.track([live()]);
    await tracker.settled();
    const read = () => tracker.stats().bytesRead;
    let before = read();
    const grown = subTranscript('v1', 50, 1);
    await appendFile(path.join(folder, 'agent-v1.jsonl'), grown);
    await writeFile(path.join(folder, 'agent-v2.meta.json'), meta('toolu_v2', 'Renamed'));
    tracker.track([live()]);
    await tracker.settled();
    expect(read()).toBe(before);
    expect(Object.fromEntries((await tracker.labels(SID))?.descriptions ?? [])).toMatchObject({ v2: 'Running' });

    clock += SUBAGENT_RECHECK_MS;
    tracker.track([live()]);
    await tracker.settled();
    expect(read()).toBe(before + Buffer.byteLength(grown));
    expect(Object.fromEntries((await tracker.labels(SID))?.descriptions ?? [])).toMatchObject({ v2: 'Renamed' });

    // A list asked for reads it at once.
    before = read();
    const more = subTranscript('v1', 60, 2);
    await appendFile(path.join(folder, 'agent-v1.jsonl'), more);
    expect((await listed()).get('v1')?.toolCalls).toBe(4);
    expect(read()).toBe(before + Buffer.byteLength(more));
  });

  it('without the OS’s start time, isn’t running with no activity since the session’s startedAt, or since a new pid was seen', async () => {
    await writeFile(main, (await background('o1', 'From before', 10)) + (await background('o2', 'From now', 500)));
    await age('o1', 12);
    await age('o2', 502);
    // The session's process started at 100 s: o1 was from an earlier one.
    clock = T0 + 550_000;
    tracker.track([live({ startedAt: at(100) })]);
    let agents = await listed();
    expect(agents.get('o1')?.state).toBe('unknown');
    expect(agents.get('o2')?.state).toBe('running');
    expect(tracker.running(SID)).toBe(1);

    // A new pid seen at 600 s, with startedAt unchanged, as a background job's createdAt is: o2,
    // started before the poll that last saw the old pid (550 s), died with the old process.
    clock = T0 + 600_000;
    tracker.track([live({ startedAt: at(0), pid: 5151 })]);
    agents = await listed();
    expect(agents.get('o2')?.state).toBe('unknown');
    expect(tracker.running(SID)).toBe(0);
    // One the new process started is running.
    await appendFile(main, await background('o3', 'New process', 1000));
    expect((await listed()).get('o3')?.state).toBe('running');
  });

  it('with the OS’s start time: an orphan of an earlier process isn’t running the first time it’s seen, and one resumed since is', async () => {
    // A background job's startedAt is when the job was made, long before its current process.
    processStart.mockImplementation(async () => Date.parse(at(1000)));
    let body = '';
    body += await background('o1', 'Orphan of the old process', 10);
    await age('o1', 12);
    // Finished under the old process, then resumed by SendMessage under the new one.
    body += (await background('r1', 'Resumed after the restart', 20)) + notice('r1', 'completed', 40);
    body += line({ type: 'assistant', timestamp: at(1100), message: { content: [{ type: 'tool_use', id: 'toolu_send_r1', name: 'SendMessage', input: { to: 'r1', message: 'More please.' } }] } });
    await writeFile(main, body);
    await appendFile(path.join(folder, 'agent-r1.jsonl'), subTranscript('r1', 1100, 2));
    await age('r1', 1102);
    // Started by the new process.
    await appendFile(main, await background('n1', 'New', 1050));
    await age('n1', 1052);
    tracker.track([live({ pid: 4242, startedAt: at(0) })]);
    const states = Object.fromEntries([...(await listed())].map(([id, s]) => [id, s.state]));
    expect(states).toEqual({ o1: 'unknown', r1: 'running', n1: 'running' });
    expect(tracker.running(SID)).toBe(2);
    expect(processStart).toHaveBeenCalledWith(4242);
    // Once per pid; a new pid is looked up again.
    tracker.track([live({ pid: 4242, startedAt: at(0) })]);
    await tracker.settled();
    expect(processStart).toHaveBeenCalledTimes(1);
    processStart.mockImplementation(async () => Date.parse(at(1200)));
    tracker.track([live({ pid: 5151, startedAt: at(0) })]);
    expect(Object.fromEntries([...(await listed())].map(([id, s]) => [id, s.state]))).toEqual({ o1: 'unknown', r1: 'unknown', n1: 'unknown' });
    expect(processStart).toHaveBeenLastCalledWith(5151);
  });

  it('looks up the process’s start only for a session with sub-agents, at most 2 at a time', async () => {
    const waiting: (() => void)[] = [];
    let most = 0;
    let now = 0;
    const lookups: number[] = [];
    const slow = vi.fn(async (pid: number) => {
      lookups.push(pid);
      most = Math.max(most, ++now);
      await new Promise<void>((resolve) => waiting.push(resolve));
      now--;
      return undefined;
    });
    const many = createSubagentTracker({ processStartMs: slow });
    try {
      const sessions: TrackedSubagentSession[] = [];
      for (let i = 0; i < 6; i++) {
        const id = `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`;
        const file = path.join(dir, 'projects', '-work-app', `${id}.jsonl`);
        await writeFile(file, '');
        // Every other one has a sub-agent.
        if (i % 2 === 0) {
          await mkdir(path.join(dir, 'projects', '-work-app', id, 'subagents'), { recursive: true });
          await writeFile(path.join(dir, 'projects', '-work-app', id, 'subagents', 'agent-z1.meta.json'), meta('toolu_z1', 'Job'));
        }
        sessions.push({ sessionId: id, file, alive: true, pid: 7000 + i, startedAt: at(0) });
      }
      many.track(sessions);
      const lists = Promise.all(sessions.map((session) => many.list(session.sessionId)));
      for (let tries = 0; tries < 200 && lookups.length < 3; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        for (const finish of waiting.splice(0)) finish();
      }
      await lists;
      await many.settled();
      expect([...new Set(lookups)].sort()).toEqual([7000, 7002, 7004]);
      expect(most).toBeLessThanOrEqual(2);
    } finally {
      many.stop();
    }
  });

  it(`clears an end once the sub-agent’s own transcript goes on more than ${RESUMED_AFTER_MS / 1000} s after it, as SendMessage resuming it does`, async () => {
    let body = '';
    body += (await background('s1', 'Resumed', 10)) + notice('s1', 'completed', 30);
    // Entries a few seconds after its end, within the slack: still done.
    body += (await background('s2', 'Finished', 20)) + notice('s2', 'completed', 40);
    // Waited for, done, then resumed.
    await writeFile(path.join(folder, 'agent-f1.meta.json'), meta('toolu_f1', 'Waited for', { requestShape: 'foreground' }));
    await writeFile(path.join(folder, 'agent-f1.jsonl'), subTranscript('f1', 51, 1));
    body += agentCall('toolu_f1', 'Waited for', 50) + agentResult('toolu_f1', 55);
    body += line({ type: 'assistant', timestamp: at(100), message: { content: [{ type: 'tool_use', id: 'toolu_send', name: 'SendMessage', input: { to: 's1', message: 'More please.' } }] } });
    await writeFile(main, body);
    await appendFile(path.join(folder, 'agent-s1.jsonl'), subTranscript('s1', 100, 2));
    await appendFile(path.join(folder, 'agent-s2.jsonl'), subTranscript('s2', 40 + RESUMED_AFTER_MS / 1000 - 2, 1));
    await appendFile(path.join(folder, 'agent-f1.jsonl'), subTranscript('f1', 120, 1));
    tracker.track([live()]);
    let states = Object.fromEntries([...(await listed())].map(([id, s]) => [id, s.state]));
    expect(states).toEqual({ s1: 'running', s2: 'done', f1: 'running' });
    expect(tracker.running(SID)).toBe(2);
    // Its next end ends it again.
    await appendFile(main, notice('s1', 'completed', 200));
    states = Object.fromEntries([...(await listed())].map(([id, s]) => [id, s.state]));
    expect(states).toMatchObject({ s1: 'done' });
  });

  it(`counts one with no Agent call on record only with activity in the last ${UNSTARTED_ACTIVE_MS / 60_000} minutes`, async () => {
    clock = Date.now();
    // A meta file whose call isn't in any transcript, and a transcript with no meta and no call.
    await writeFile(path.join(folder, 'agent-m1.meta.json'), meta('toolu_gone1', 'Fresh meta'));
    await writeFile(path.join(folder, 'agent-m2.meta.json'), meta('toolu_gone2', 'Old meta'));
    await writeFile(path.join(folder, 'agent-i1.jsonl'), subTranscript('i1', 1, 1));
    await writeFile(path.join(folder, 'agent-i2.jsonl'), subTranscript('i2', 1, 1));
    const old = new Date(clock - UNSTARTED_ACTIVE_MS - 60_000);
    await utimes(path.join(folder, 'agent-m2.meta.json'), old, old);
    await utimes(path.join(folder, 'agent-i2.jsonl'), old, old);
    await writeFile(main, '');
    tracker.track([live()]);
    const states = Object.fromEntries([...(await listed())].map(([id, s]) => [id, s.state]));
    expect(states).toEqual({ m1: 'running', m2: 'unknown', i1: 'running', i2: 'unknown' });
    expect(tracker.running(SID)).toBe(2);
  });

  it('a sub-agent the session waited for that you interrupted is stopped; any other error is failed', async () => {
    for (const id of ['x1', 'x2', 'x3']) {
      await writeFile(path.join(folder, `agent-${id}.meta.json`), meta(`toolu_${id}`, `Job ${id}`, { requestShape: 'foreground' }));
    }
    await writeFile(
      main,
      agentCall('toolu_x1', 'Job x1', 10) +
        agentResult('toolu_x1', 11, { error: true, text: '[Request interrupted by user for tool use]' }) +
        agentCall('toolu_x2', 'Job x2', 20) +
        line({ type: 'user', timestamp: at(21), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x2', is_error: true, content: [] }] }, toolUseResult: 'Error: [Request interrupted by user for tool use]' }) +
        agentCall('toolu_x3', 'Job x3', 30) +
        agentResult('toolu_x3', 31, { error: true, text: 'Agent failed: the made-up error.' }),
    );
    tracker.track([live()]);
    const states = Object.fromEntries([...(await listed())].map(([id, s]) => [id, s.state]));
    expect(states).toEqual({ x1: 'stopped', x2: 'stopped', x3: 'failed' });
  });

  it('says background only for a requestShape it knows, and leaves any other unset', async () => {
    for (const [id, shape] of [['k1', 'background'], ['k2', 'foreground'], ['k3', 'async'], ['k4', '']] as const) {
      await writeFile(path.join(folder, `agent-${id}.meta.json`), meta(`toolu_${id}`, `Job ${id}`, { requestShape: shape }));
    }
    tracker.track([live()]);
    const agents = await listed();
    expect(agents.get('k1')?.background).toBe(true);
    expect(agents.get('k2')?.background).toBe(false);
    expect(agents.get('k3')).not.toHaveProperty('background');
    expect(agents.get('k4')).not.toHaveProperty('background');
  });

  it('reads a sub-agent transcript’s times from its first line and its last lines, without parsing the rest', async () => {
    let body = '';
    for (let i = 0; i < 200; i++) body += line({ type: 'user', isSidechain: true, timestamp: at(100 + i), message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(2000) }] } });
    // A last line with no time: the one before it gives the newest.
    body += line({ type: 'summary', isSidechain: true, summary: 'no time' });
    await writeFile(path.join(folder, 'agent-q1.jsonl'), body);
    await writeFile(main, '');
    tracker.track([live()]);
    const before = tracker.stats().linesParsed;
    expect((await listed()).get('q1')).toMatchObject({ startedAt: at(100), lastActivityAt: at(299), toolCalls: 0 });
    expect(tracker.stats().linesParsed - before).toBeLessThanOrEqual(4);
  });

  it('a session that comes back after its process ended: what ran before isn’t running', async () => {
    await writeFile(main, await background('w1', 'Before the restart', 10));
    await age('w1', 12);
    tracker.track([live({ alive: false, pid: undefined })]);
    expect((await listed()).get('w1')?.state).toBe('unknown');
    clock = T0 + 7_200_000;
    tracker.track([live({ pid: 6000 })]);
    expect((await listed()).get('w1')?.state).toBe('unknown');
    expect(tracker.running(SID)).toBe(0);
  });

  it('scans in the background only the sessions whose process is alive', async () => {
    await writeFile(main, await background('k1', 'Job', 10));
    tracker.track([live({ alive: false, pid: undefined })]);
    await tracker.settled();
    expect(tracker.stats().scans).toBe(0);
    // Asked for, it's scanned.
    expect((await listed()).get('k1')?.state).toBe('unknown');
    expect(tracker.stats().scans).toBe(1);
  });

  it('labels: each sub-agent’s description by its id, and the Agent call that started it', async () => {
    await writeFile(main, (await background('l1', 'Labelled', 10)) + agentCall('toolu_l2', 'Named by its launch', 20, { run_in_background: true }) + launched('toolu_l2', 'l2', 20));
    await writeFile(path.join(folder, 'agent-l2.jsonl'), subTranscript('l2', 21, 0));
    tracker.track([live()]);
    await tracker.settled();
    const labels = await tracker.labels(SID);
    expect(Object.fromEntries(labels?.descriptions ?? [])).toEqual({ l1: 'Labelled', l2: 'Named by its launch' });
    expect(Object.fromEntries(labels?.started ?? [])).toEqual({ toolu_l1: 'l1', toolu_l2: 'l2' });
    expect(await tracker.labels('22222222-2222-4222-8222-222222222222')).toBeUndefined();
  });

  it('lists the folder’s sub-agents when the session’s transcript is missing, and forgets a session no longer tracked', async () => {
    await writeFile(path.join(folder, 'agent-g1.meta.json'), meta('toolu_g1', 'Orphan'));
    tracker.track([live()]);
    expect((await listed()).get('g1')).toMatchObject({ description: 'Orphan', state: 'running' });
    expect(await tracker.transcript(SID, 'g1')).toEqual({});
    tracker.track([]);
    expect(await tracker.list(SID)).toBeUndefined();
    expect(await tracker.transcript(SID, 'g1')).toBeUndefined();
    expect(tracker.running(SID)).toBe(0);
  });

  describe('runningFresh, for End session (W90)', () => {
    it('counts the running ones after a scan that starts now, and 0 with none, or with no subagents folder', async () => {
      await writeFile(main, (await background('r1', 'Still going', 10)) + (await background('r2', 'Finished fine', 20)) + notice('r2', 'completed', 100));
      tracker.track([live()]);
      expect(await tracker.runningFresh(SID)).toBe(1);
      // Written after the poll: the scan that starts now sees it.
      await appendFile(main, notice('r1', 'completed', 200));
      expect(await tracker.runningFresh(SID)).toBe(0);
      await rm(folder, { recursive: true, force: true });
      await writeFile(main, line({ type: 'user', sessionId: SID, timestamp: at(300), message: { content: 'A made-up prompt.' } }));
      expect(await tracker.runningFresh(SID)).toBe(0);
    });

    it("can't say, and says undefined, for a session it doesn't track, a transcript it can't read, or a folder it can't read", async () => {
      expect(await tracker.runningFresh(SID)).toBeUndefined();
      // Tracked, but its own transcript isn't there: where sub-agents start and end can't be read.
      tracker.track([live()]);
      expect(await tracker.runningFresh(SID)).toBeUndefined();
      // Readable: it can say.
      await writeFile(main, await background('u1', 'Still going', 10));
      expect(await tracker.runningFresh(SID)).toBe(1);
      // A folder that's there but can't be read, unlike one that isn't there, which list() shows as none.
      await import('node:fs/promises').then(({ chmod }) => chmod(folder, 0o000));
      try {
        expect(await tracker.runningFresh(SID)).toBeUndefined();
      } finally {
        await import('node:fs/promises').then(({ chmod }) => chmod(folder, 0o755));
      }
      expect(await tracker.runningFresh(SID)).toBe(1);
      // No longer tracked.
      tracker.track([]);
      expect(await tracker.runningFresh(SID)).toBeUndefined();
    });
  });

  it('reads a transcript afresh when it’s replaced or shrinks, without counting it twice', async () => {
    await writeFile(main, await background('h1', 'Job', 10, 3));
    tracker.track([live()]);
    expect((await listed()).get('h1')?.toolCalls).toBe(3);
    await writeFile(path.join(folder, 'agent-h1.jsonl'), subTranscript('h1', 11, 1));
    expect((await listed()).get('h1')?.toolCalls).toBe(1);
    await rm(path.join(folder, 'agent-h1.jsonl'));
    await writeFile(path.join(folder, 'agent-h1.jsonl'), subTranscript('h1', 11, 2));
    expect((await listed()).get('h1')?.toolCalls).toBe(2);
  });

  it('finishes a line split between reads, and skips one too long to keep', async () => {
    const small = createSubagentTracker({ chunkBytes: 7, maxLineBytes: 4096, processStartMs: async () => undefined });
    try {
      await writeFile(main, (await background('p1', 'Split', 10, 2)) + line({ type: 'user', pad: 'x'.repeat(8192) }) + notice('p1', 'completed', 60));
      small.track([live()]);
      expect((await small.list(SID))?.subagents[0]).toMatchObject({ agentId: 'p1', state: 'done', toolCalls: 2 });
    } finally {
      small.stop();
    }
  });
});

describe('processStartTime', () => {
  const NOW_MS = Date.parse('2026-10-28T00:00:00.000Z');
  const answering = (out: string) => vi.fn(async (_file: string, _args: readonly string[]) => out);

  it('takes the start from ps’s time since it started, in each of its forms', async () => {
    for (const [out, seconds] of [
      ['00:05\n', 5],
      ['  12:34\n', 12 * 60 + 34],
      ['1:02:03', 3723],
      ['03-11:44:39\n', ((3 * 24 + 11) * 60 + 44) * 60 + 39],
    ] as const) {
      expect(await processStartTime(4242, answering(out), () => NOW_MS), out).toBe(NOW_MS - seconds * 1000);
    }
    const run = answering('00:01');
    await processStartTime(4242, run, () => NOW_MS);
    expect(run).toHaveBeenCalledWith('ps', ['-o', 'etime=', '-p', '4242'], expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });

  it('is undefined for no such process, a failure, something else printed, or a pid that isn’t one', async () => {
    const failing = vi.fn(async () => {
      throw new RunError('exit', 'exited with code 1', 1);
    });
    expect(await processStartTime(4242, failing)).toBeUndefined();
    for (const out of ['', 'ELAPSED', '5', 'a:bc', '00:05 00:06']) expect(await processStartTime(4242, answering(out)), out).toBeUndefined();
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(await processStartTime(pid, answering('00:05'))).toBeUndefined();
  });

  it('finds this process’s own start, before now', async () => {
    const start = await processStartTime(process.pid);
    expect(start).toBeDefined();
    expect(start).toBeLessThanOrEqual(Date.now() + 1000);
    expect(start).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000);
  });
});
