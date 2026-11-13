// The supervisor's process (M5, W113), with a fake child that speaks stream-json as Claude Code
// 2.1.312 does (spike 009, and the handshake probe in src/server/mcp.ts), a fake session list and a
// state store in memory. No test runs `claude`. Made-up sessions and text only.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRow } from '../index/agents.js';
import { encodeProjectDir } from '../index/transcripts.js';
import { SUPERVISOR_MODEL, type WorkChoice } from '../shared/protocol.js';
import { modelRejectedMessage } from '../server/work.js';
import type { RelayChild, RelayChildEvents } from '../server/relay.js';
import { createApprovalQueue } from './approvals.js';
import type { SupervisorConnector } from './connectors.js';
import { SUPERVISOR_ALLOWED_TOOLS, SUPERVISOR_ASK_TOOLS, SUPERVISOR_MAX_TURNS, SUPERVISOR_NAME } from './prompt.js';
import { markReady, readRecipients } from './supervisorGateHook.mjs';
import { memoryState, type SupervisorRecord } from './state.js';
import { createSupervisor, heldBy, heldError, streamContextTokens, sweepMcpConfigs, turnCost, withNotes, type Supervisor, type SupervisorOptions } from './supervisor.js';

const SESSION = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_SESSION = 'bbbbbbbb-0000-4000-8000-000000000002';
const MCP_URL = 'http://127.0.0.1:4599/mcp';

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'pitwall-test-supervisor-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** How the fake answers what's written to it. */
type Behaviour = (line: Record<string, unknown>, child: FakeChild) => void;

/** Answers the initialize request as Claude Code 2.1.312 does: success, in default mode (W115), idle. */
const answersInitialize: Behaviour = (line, child) => {
  if (line.type === 'control_request' && (line.request as { subtype?: string }).subtype === 'initialize') {
    child.emit({ type: 'control_response', response: { subtype: 'success', request_id: line.request_id, response: { current_permission_mode: 'default', session_state: 'idle', pid: child.pid } } });
  }
};

class FakeChild implements RelayChild {
  readonly written: string[] = [];
  readonly signals: NodeJS.Signals[] = [];
  ended = false;
  exited = false;
  exitOnEnd = true;
  exitOnSignal = true;
  behaviour: Behaviour = answersInitialize;

  constructor(
    readonly events: RelayChildEvents,
    readonly pid: number,
    readonly args: string[],
    readonly options: { cwd: string; env: NodeJS.ProcessEnv },
  ) {}

  write(data: string): void {
    this.written.push(data);
    const line = JSON.parse(data) as Record<string, unknown>;
    setImmediate(() => this.behaviour(line, this));
  }
  end(): void {
    this.ended = true;
    if (this.exitOnEnd) setImmediate(() => this.exit(0, null));
  }
  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    if (this.exitOnSignal || signal === 'SIGKILL') setImmediate(() => this.exit(null, signal));
  }
  emit(event: Record<string, unknown>): void {
    if (!this.exited) this.events.line(JSON.stringify(event));
  }
  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.events.exit(code, signal);
  }
  /** What was written, parsed. */
  lines(): Record<string, unknown>[] {
    return this.written.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  /** The user messages written, as their text. */
  messages(): string[] {
    return this.lines()
      .filter((line) => line.type === 'user')
      .map((line) => (line.message as { content: string }).content);
  }
  /** A turn's start, as system/init. */
  init(sessionId = SESSION, extra: Record<string, unknown> = {}): void {
    this.emit({ type: 'system', subtype: 'init', session_id: sessionId, tools: ['SendMessage', ...SUPERVISOR_ALLOWED_TOOLS, 'mcp__pitwall__spawn_session'], permissionMode: 'default', mcp_servers: [{ name: 'pitwall', status: 'connected' }], ...extra });
  }
  /** A turn's end, as result. */
  result(extra: Record<string, unknown> = {}): void {
    this.emit({ type: 'result', subtype: 'success', is_error: false, ...extra });
  }
}

interface Harness {
  supervisor: Supervisor;
  children: FakeChild[];
  store: ReturnType<typeof memoryState>;
  rows: AgentRow[];
  logs: string[];
  home: string;
  dir: string;
  sessionDir: string;
  configDir: string;
}

const made: Supervisor[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((supervisor) => supervisor.close()));
});

let homes = 0;
/** The gate's hook folder and id, from the --settings a child was given. */
function gateOf(child: FakeChild): { dir: string; id: string } {
  const settings = JSON.parse(flag(child.args, '--settings')!) as { hooks: { SessionStart: { hooks: { args: string[] }[] }[] } };
  const [, dir, id] = settings.hooks.SessionStart[0]!.hooks[0]!.args;
  return { dir: dir!, id: id! };
}

function harness(options: Partial<SupervisorOptions> & { record?: SupervisorRecord; transcript?: boolean; bind?: boolean; behaviour?: Behaviour; hooksLoad?: boolean } = {}): Harness {
  const home = path.join(tmp, `home-${++homes}`);
  mkdirSync(home, { mode: 0o700 });
  const configDir = path.join(tmp, `claude-${homes}`);
  mkdirSync(configDir, { mode: 0o700 });
  const children: FakeChild[] = [];
  const store = memoryState(options.record);
  const rows: AgentRow[] = [];
  const logs: string[] = [];
  const dir = path.join(home, 'supervisor');
  const sessionDir = path.join(dir, 'session');
  if (options.record !== undefined && options.transcript !== false) {
    // The resumed conversation's transcript, where Claude Code keeps it for the folder it runs in.
    mkdirSync(dir, { mode: 0o700 });
    mkdirSync(sessionDir, { mode: 0o700 });
    const project = path.join(configDir, 'projects', encodeProjectDir(realpathSync(sessionDir)));
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, `${options.record.sessionId}.jsonl`), transcriptLines());
  }
  const supervisor = createSupervisor({
    home,
    configDir,
    store,
    spawn: (_file, args, spawnOptions, events) => {
      const child = new FakeChild(events, 70_000 + children.length, args, spawnOptions);
      if (options.behaviour !== undefined) child.behaviour = options.behaviour;
      // Its SessionStart hook, as Claude Code runs it before the first turn: the gate is ready.
      if (options.hooksLoad !== false) {
        const gate = gateOf(child);
        markReady(gate.dir, gate.id);
      }
      children.push(child);
      return child;
    },
    agents: { list: async () => ({ ok: true, rows: [...rows] }) },
    claudeVersion: async () => '2.1.312 (Claude Code)',
    env: { PATH: '/usr/bin:/bin', HOME: '/made-up/home', NODE_OPTIONS: '--require /made-up/evil.js', CLAUDE_CODE_EFFORT_LEVEL: 'max', ANTHROPIC_API_KEY: 'made-up-key' },
    log: (message) => logs.push(message),
    promptVersion: 1,
    ...options,
  });
  if (options.bind !== false) supervisor.bind({ mcpUrl: MCP_URL });
  made.push(supervisor);
  return { supervisor, children, store, rows, logs, home, dir, sessionDir, configDir };
}

function transcriptLines(): string {
  const at = (s: number) => new Date(Date.parse('2026-10-29T10:00:00.000Z') + s * 1000).toISOString();
  return [
    { type: 'user', isSidechain: false, timestamp: at(1), message: { role: 'user', content: 'Which of my sessions need me?' } },
    { type: 'assistant', isSidechain: false, timestamp: at(2), message: { id: 'msg_1', role: 'assistant', model: 'test-model', content: [{ type: 'text', text: 'Two of them do.' }] } },
    // A connector search: the panel shows what it searched (W192's G2).
    { type: 'assistant', isSidechain: false, timestamp: at(3), message: { id: 'msg_2', role: 'assistant', model: 'test-model', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__example__search', input: { query: 'release notes' } }] } },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n')
    .concat('\n');
}

const flag = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}


describe('starting the supervisor', () => {
  it('carries what you approved in this run, its hand-offs, once there are any (W124)', () => {
    const approvals = createApprovalQueue({ now: () => Date.parse('2026-11-02T12:00:00.000Z'), randomId: () => 'h1' });
    const { supervisor } = harness({ approvals });
    expect(supervisor.state().handoffs).toBeUndefined();
    approvals.handoff({ kind: 'spawn', name: 'pitwall-test-new', shortId: 'abc12345' });
    expect(supervisor.state().handoffs).toEqual([{ id: 'h1', kind: 'spawn', name: 'pitwall-test-new', shortId: 'abc12345', at: '2026-11-02T12:00:00.000Z' }]);
  });

  it('starts a new conversation with SendMessage alone, the read-only MCP tools allowed, the two that act asking approve, and your settings off', async () => {
    const { supervisor, children, sessionDir } = harness();
    expect(supervisor.state()).toEqual({ status: 'off', approvals: [] });
    expect(await supervisor.start()).toEqual({ kind: 'ok' });
    expect(children).toHaveLength(1);
    const { args, options } = children[0]!;
    expect(args.slice(0, 7)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-hook-events']);
    expect(flag(args, '--name')).toBe(SUPERVISOR_NAME);
    expect(flag(args, '--model')).toBe(SUPERVISOR_MODEL);
    expect(flag(args, '--tools')).toBe('SendMessage');
    expect(flag(args, '--permission-mode')).toBe('default');
    expect(flag(args, '--permission-prompt-tool')).toBe('mcp__pitwall__approve');
    expect(flag(args, '--setting-sources')).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(flag(args, '--allowed-tools')).toBe('mcp__pitwall__list_sessions,mcp__pitwall__read_session,mcp__pitwall__list_prs,mcp__pitwall__get_recap,mcp__pitwall__get_usage');
    const settings = JSON.parse(flag(args, '--settings')!) as Record<string, unknown>;
    expect(settings).toMatchObject({ autoMemoryEnabled: false, crossSessionInbound: 'refuse', permissions: { ask: [...SUPERVISOR_ASK_TOOLS] } });
    // The recipient gate: a deny-only hook on SendMessage, which blocks if it can't run.
    expect(settings.hooks).toMatchObject({ PreToolUse: [{ matcher: 'SendMessage', hooks: [{ type: 'command', onFailure: 'block' }] }], SessionStart: [{}] });
    expect(args).not.toContain('--resume');
    expect(options.cwd).toBe(realpathSync(sessionDir));
    // The relay's environment, at the model's default effort, credentials passed on.
    expect(options.env.NODE_OPTIONS).toBeUndefined();
    expect(options.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    expect(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(options.env.ANTHROPIC_API_KEY).toBe('made-up-key');
    expect(options.env.MCP_TOOL_TIMEOUT).toBe('1800000');
    // The first thing written: the initialize request, whose answer says it reads stdin.
    expect(children[0]!.lines()[0]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } });
    expect(supervisor.state()).toEqual({ status: 'idle', approvals: [] });
  });

  it('writes the MCP config at 0600 in its 0700 folder, with this process’s bearer token, and never in claude’s arguments or environment', async () => {
    const { supervisor, children, dir, sessionDir } = harness();
    await supervisor.start();
    const file = flag(children[0]!.args, '--mcp-config')!;
    expect(file).toBe(path.join(path.resolve(dir), `mcp-${process.pid}.json`));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(sessionDir).mode & 0o777).toBe(0o700);
    const token = supervisor.mcpToken()!;
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mcpServers: { pitwall: { type: 'http', url: MCP_URL, headers: { Authorization: `Bearer ${token}` }, timeout: 1_800_000 } } });
    expect(children[0]!.args.join('\n')).not.toContain(token);
    expect(JSON.stringify(children[0]!.options.env)).not.toContain(token);
  });

  it('makes a new token for each process, valid only while it runs, and removes the config when it exits', async () => {
    const { supervisor, children } = harness();
    await supervisor.start();
    const first = supervisor.mcpToken();
    const file = flag(children[0]!.args, '--mcp-config')!;
    children[0]!.exit(1, null);
    await until(() => supervisor.state().status === 'failed');
    expect(supervisor.mcpToken()).toBeUndefined();
    expect(() => lstatSync(file)).toThrow();
    await supervisor.start();
    expect(supervisor.mcpToken()).toBeDefined();
    expect(supervisor.mcpToken()).not.toBe(first);
  });

  it('doesn’t start before pitwall’s server is listening, or on a Claude Code older than spike 009’s', async () => {
    const unbound = harness({ bind: false });
    expect(await unbound.supervisor.start()).toMatchObject({ kind: 'failed' });
    expect(unbound.children).toHaveLength(0);
    const old = harness({ claudeVersion: async () => '2.1.300 (Claude Code)' });
    const outcome = await old.supervisor.start();
    expect(outcome).toEqual({ kind: 'failed', error: 'The supervisor needs Claude Code 2.1.312 or later, and this is 2.1.300. Update Claude Code, then try again.' });
    expect(old.children).toHaveLength(0);
    expect(old.supervisor.state()).toMatchObject({ status: 'failed', error: outcome.kind === 'failed' ? outcome.error : '' });
  });

  it('takes a process that never answers the initialize request as started once readyMs pass', async () => {
    const { supervisor } = harness({ readyMs: 20, behaviour: () => undefined });
    const started = supervisor.start();
    await until(() => supervisor.state().status === 'starting');
    expect(await started).toEqual({ kind: 'ok' });
    expect(supervisor.state().status).toBe('idle');
  });
});

describe('messages', () => {
  it('writes your text as a stream-json user message; system/init gives the session id, kept on file; result ends the turn with its own cost', async () => {
    const { supervisor, children, store } = harness({ now: () => Date.parse('2026-10-29T12:00:00.000Z') });
    expect(await supervisor.send('Which of my sessions need me, and why?')).toEqual({ kind: 'ok' });
    const child = children[0]!;
    expect(child.messages()).toEqual(['Which of my sessions need me, and why?']);
    expect(child.args.join('\n')).not.toContain('Which of my sessions');
    expect(supervisor.state().status).toBe('working');
    child.init();
    expect(supervisor.state()).toMatchObject({ status: 'working', sessionId: SESSION });
    expect(store.current()).toEqual({ sessionId: SESSION, promptVersion: 1 });
    child.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__pitwall__list_sessions', input: {} }] } });
    child.result({ total_cost_usd: 1.5, model_usage_since_last_result: { [SUPERVISOR_MODEL]: { costUSD: 0.0099 } } });
    expect(supervisor.state()).toEqual({ status: 'idle', approvals: [], sessionId: SESSION, lastTurnAt: '2026-10-29T12:00:00.000Z', costUsd: 0.0099 });
    expect(supervisor.stats()).toEqual({ starts: 1, turns: 1, toolCalls: { mcp__pitwall__list_sessions: 1 } });
  });

  it('queues a message sent while a turn runs, writes it once the turn ends, and refuses more than maxQueue waiting', async () => {
    const { supervisor, children } = harness({ maxQueue: 2 });
    await supervisor.send('first');
    expect(await supervisor.send('second')).toEqual({ kind: 'ok' });
    expect(await supervisor.send('third')).toEqual({ kind: 'ok' });
    expect(await supervisor.send('fourth')).toEqual({ kind: 'busy' });
    const child = children[0]!;
    expect(child.messages()).toEqual(['first']);
    child.init();
    child.result();
    expect(child.messages()).toEqual(['first', 'second']);
    expect(supervisor.state().status).toBe('working');
    child.result();
    child.result();
    expect(child.messages()).toEqual(['first', 'second', 'third']);
    expect(supervisor.state().status).toBe('idle');
  });

  it('stops itself when a message from another session reaches it, since it refuses them (W113’s review)', async () => {
    const { supervisor, children } = harness();
    await supervisor.start();
    children[0]!.init();
    expect(supervisor.state().status).toBe('working');
    children[0]!.result({ origin: { kind: 'peer', name: 'pitwall-test-target' } });
    expect(supervisor.state()).toMatchObject({ status: 'failed', error: expect.stringContaining('A message from another session reached the supervisor') });
  });

  it('stops itself when pitwall’s MCP server failed to connect, or is missing (W113’s review)', async () => {
    for (const servers of [[{ name: 'pitwall', status: 'failed' }], [{ name: 'another', status: 'connected' }]]) {
      const { supervisor, children } = harness();
      await supervisor.start();
      children[0]!.init(undefined, { mcp_servers: servers });
      expect(supervisor.state()).toMatchObject({ status: 'failed', error: expect.stringContaining("without pitwall's tools connected") });
    }
  });

  it('interrupts a running turn with the stream’s interrupt control request, and says when nothing runs', async () => {
    const { supervisor, children } = harness();
    expect(supervisor.interrupt()).toEqual({ kind: 'idle' });
    await supervisor.start();
    expect(supervisor.interrupt()).toEqual({ kind: 'idle' });
    await supervisor.send('a long question');
    expect(supervisor.interrupt()).toEqual({ kind: 'ok' });
    expect(children[0]!.lines().at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
    children[0]!.result({ subtype: 'error_during_execution', is_error: true });
    expect(supervisor.state().status).toBe('idle');
  });
});

describe('resuming', () => {
  it('resumes the conversation on file, when it started on this prompt and its transcript is there', async () => {
    const { supervisor, children } = harness({ record: { sessionId: SESSION, promptVersion: 1 } });
    expect(supervisor.state().sessionId).toBeUndefined();
    await supervisor.start();
    expect(flag(children[0]!.args, '--resume')).toBe(SESSION);
    expect(supervisor.state()).toMatchObject({ status: 'idle', sessionId: SESSION });
  });

  it('starts a new conversation when the system prompt’s version changed, since Claude Code froze the old one', async () => {
    const { supervisor, children, store, logs } = harness({ record: { sessionId: SESSION, promptVersion: 1 }, promptVersion: 2 });
    await supervisor.send('hello');
    expect(children[0]!.args).not.toContain('--resume');
    expect(supervisor.state().sessionId).toBeUndefined();
    children[0]!.init(OTHER_SESSION);
    expect(store.current()).toEqual({ sessionId: OTHER_SESSION, promptVersion: 2 });
    expect(logs.some((line) => line.includes('version 2 now'))).toBe(true);
  });

  it('starts a new conversation when the transcript is gone', async () => {
    const { supervisor, children } = harness({ record: { sessionId: SESSION, promptVersion: 1 }, transcript: false });
    await supervisor.start();
    expect(children[0]!.args).not.toContain('--resume');
  });

  it('is held, starting nothing, while a background session has its id; says which `claude stop` frees it; and resumes once it’s gone', async () => {
    const { supervisor, children, rows } = harness({ record: { sessionId: SESSION, promptVersion: 1 } });
    rows.push({ sessionId: SESSION, shortId: 'ab12cd34', name: SUPERVISOR_NAME, kind: 'background', cwd: '/made-up/elsewhere', pid: 4242, startedAt: '2026-10-29T09:00:00.000Z' });
    const outcome = await supervisor.start();
    expect(outcome.kind).toBe('held');
    expect(children).toHaveLength(0);
    expect(supervisor.state()).toEqual({
      status: 'held',
      approvals: [],
      sessionId: SESSION,
      error: "A background session is running the supervisor's conversation, so pitwall can't resume it. Run `claude stop ab12cd34` to hand it back, then press Start. pitwall won't stop it for you.",
    });
    expect(await supervisor.send('hello')).toMatchObject({ kind: 'held' });
    rows.length = 0;
    expect(await supervisor.start()).toEqual({ kind: 'ok' });
    expect(flag(children[0]!.args, '--resume')).toBe(SESSION);
  });

  it('is held when Claude Code refuses the resume because a background session has it (spike 009, finding 3)', async () => {
    const { supervisor, children } = harness({ record: { sessionId: SESSION, promptVersion: 1 }, behaviour: () => undefined, readyMs: 50 });
    const started = supervisor.start();
    await until(() => children.length === 1);
    const child = children[0]!;
    child.events.stderr("Error: That session is running in the background (ab12cd34). Run `claude attach ab12cd34` to open it, or `claude stop ab12cd34` first to resume it here. Add --fork-session to branch off a copy instead.\n");
    child.exit(1, null);
    expect(await started).toMatchObject({ kind: 'held' });
    expect(supervisor.state().error).toContain('`claude stop ab12cd34`');
    expect(child.signals).toEqual([]);
  });
});

describe('when it stops', () => {
  it('fails in pitwall’s words, never claude’s output, when it exits as it starts, and doesn’t start again by itself', async () => {
    const { supervisor, children } = harness({ behaviour: () => undefined, readyMs: 50 });
    const started = supervisor.start();
    await until(() => children.length === 1);
    children[0]!.events.stderr('made-up secret output from claude\n');
    children[0]!.exit(1, null);
    const outcome = await started;
    expect(outcome).toEqual({ kind: 'failed', error: 'The supervisor stopped as it started (exit code 1). Press Start to try again.' });
    expect(JSON.stringify(supervisor.state())).not.toContain('secret');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(children).toHaveLength(1);
    expect(await supervisor.start()).toEqual({ kind: 'ok' });
    expect(children).toHaveLength(2);
  });

  it('says how to start afresh, with New conversation, when a resume fails for another reason', async () => {
    const { supervisor, children } = harness({ record: { sessionId: SESSION, promptVersion: 1 }, behaviour: () => undefined, readyMs: 50 });
    const started = supervisor.start();
    await until(() => children.length === 1);
    children[0]!.exit(1, null);
    expect(await started).toEqual({
      kind: 'failed',
      error: `pitwall couldn't resume the supervisor's conversation: claude stopped as it started (exit code 1). Press Start to try again, or New conversation to start a new one instead.`,
    });
  });

  it('fails when it exits mid-turn, keeps what was queued for the next start, says so, and starts again only when asked', async () => {
    const { supervisor, children } = harness();
    await supervisor.send('first');
    await supervisor.send('queued');
    children[0]!.init();
    children[0]!.exit(143, null);
    await until(() => supervisor.state().status === 'failed');
    expect(supervisor.state().error).toBe('The supervisor stopped (exit code 143). Send it a message, or press Start, to start it again. Your message waits to be sent when it starts.');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(children).toHaveLength(1);
    await supervisor.send('next');
    expect(children).toHaveLength(2);
    // The kept one first, then the new one once its turn ends.
    expect(children[1]!.messages()).toEqual(['queued']);
    children[1]!.init();
    children[1]!.result();
    await until(() => children[1]!.messages().length === 2);
    expect(children[1]!.messages()).toEqual(['queued', 'next']);
  });

  it('keeps a message you send while a tripped process stops, and sends it after the next start (W114’s review)', async () => {
    const { supervisor, children } = harness();
    await supervisor.send('hello');
    const child = children[0]!;
    child.exitOnSignal = false;
    child.exitOnEnd = false;
    child.init(SESSION, { tools: ['Bash'] });
    expect(supervisor.state().status).toBe('failed');
    // Sent while it's stopping: taken, and kept when it exits.
    const sending = supervisor.send('while it stops');
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.exit(null, 'SIGTERM');
    expect(await sending).toEqual({ kind: 'ok' });
    await until(() => children.length === 2 && children[1]!.messages().length === 1);
    expect(children[1]!.messages()).toEqual(['while it stops']);
  });

  it('says in its error that your messages wait while it’s stopped, once a trip has stopped it', async () => {
    const { supervisor, children } = harness();
    await supervisor.send('first');
    await supervisor.send('second');
    await supervisor.send('third');
    children[0]!.init(SESSION, { tools: ['Bash'] });
    await until(() => children[0]!.exited);
    expect(supervisor.state()).toMatchObject({ status: 'failed', error: "The supervisor started with a tool pitwall didn't give it (Bash), so pitwall stopped it. Your 2 messages wait to be sent when it starts." });
    await supervisor.start();
    expect(children[1]!.messages()).toEqual(['second']);
  });

  it('says claude wasn’t found when it can’t be started', async () => {
    const { supervisor, children } = harness({ behaviour: () => undefined, readyMs: 50 });
    const started = supervisor.start();
    await until(() => children.length === 1);
    children[0]!.events.error('claude was not found');
    children[0]!.exit(null, null);
    expect(await started).toEqual({ kind: 'failed', error: "claude wasn't found, so the supervisor didn't start." });
  });

  it('closes with pitwall: stdin, then SIGTERM, then SIGKILL, and removes its MCP config', async () => {
    const { supervisor, children } = harness();
    await supervisor.start();
    const child = children[0]!;
    child.exitOnEnd = false;
    child.exitOnSignal = false;
    const file = flag(child.args, '--mcp-config')!;
    const started = Date.now();
    await supervisor.close();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(child.ended).toBe(true);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(() => lstatSync(file)).toThrow();
    expect(await supervisor.send('after')).toEqual({ kind: 'closed' });
    expect(children).toHaveLength(1);
  });
});

describe('what it can do', () => {
  it('denies a permission prompt, and answers any other request with an error, so nothing is allowed', async () => {
    const { supervisor, children } = harness();
    await supervisor.start();
    const child = children[0]!;
    child.emit({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'SendMessage', input: { to: 'x' } } });
    child.emit({ type: 'control_request', request_id: 'other-1', request: { subtype: 'elicitation' } });
    expect(child.lines().slice(-2)).toEqual([
      { type: 'control_response', response: { subtype: 'success', request_id: 'perm-1', response: { behavior: 'deny', message: 'pitwall answers permission prompts only through its approve tool.' } } },
      { type: 'control_response', response: { subtype: 'error', request_id: 'other-1', error: "pitwall doesn't handle this request." } },
    ]);
  });

  it('stops a supervisor that starts a turn with a tool pitwall didn’t give it', async () => {
    const { supervisor, children } = harness();
    await supervisor.send('hello');
    children[0]!.init(SESSION, { tools: [...SUPERVISOR_ALLOWED_TOOLS, 'Bash'] });
    // At once, before it has gone: shown as failed, and its MCP token taken back.
    expect(supervisor.state().status).toBe('failed');
    expect(supervisor.mcpToken()).toBeUndefined();
    await until(() => children[0]!.exited);
    expect(children[0]!.signals).toContain('SIGTERM');
    expect(supervisor.state().error).toBe("The supervisor started with a tool pitwall didn't give it (Bash), so pitwall stopped it.");
  });

  it('stops a supervisor that isn’t in default mode, by its initialize answer or its init', async () => {
    const byAnswer = harness({
      behaviour: (line, child) => {
        if (line.type === 'control_request') child.emit({ type: 'control_response', response: { subtype: 'success', request_id: line.request_id, response: { current_permission_mode: 'bypassPermissions' } } });
      },
    });
    expect(await byAnswer.supervisor.start()).toEqual({ kind: 'failed', error: "The supervisor started in a permission mode pitwall didn't ask for, so pitwall stopped it." });
    const byInit = harness();
    await byInit.supervisor.send('hello');
    byInit.children[0]!.init(SESSION, { permissionMode: 'dontAsk' });
    await until(() => byInit.supervisor.state().status === 'failed');
    const bypass = harness();
    await bypass.supervisor.send('hello');
    bypass.children[0]!.init(SESSION, { permissionMode: 'bypassPermissions' });
    await until(() => bypass.supervisor.state().status === 'failed');
  });

  it('accepts SendMessage, spawn_session and approve in its init, and stops one that lists any other tool', async () => {
    const { supervisor, children } = harness();
    await supervisor.send('hello');
    children[0]!.init(SESSION, { tools: ['SendMessage', ...SUPERVISOR_ALLOWED_TOOLS, 'mcp__pitwall__spawn_session', 'mcp__pitwall__approve'] });
    expect(supervisor.state().status).toBe('working');
    children[0]!.result();
    await supervisor.send('again');
    children[0]!.init(SESSION, { tools: ['SendMessage', 'mcp__pitwall__run_command'] });
    expect(supervisor.state()).toMatchObject({ status: 'failed', error: "The supervisor started with a tool pitwall didn't give it (mcp__pitwall__run_command), so pitwall stopped it." });
  });

  describe('connectors (W184, D28)', () => {
    const connectors: SupervisorConnector[] = [
      { name: 'fake', server: { kind: 'stdio', command: 'fake-mcp', args: ['--flag'], env: ['FAKE_KEY'] }, tools: ['fake_search'], otherTools: ['fake_post'] },
      { name: 'notion', server: { kind: 'http', url: 'https://mcp.made-up.example/mcp', headers: { Authorization: 'Bearer ${NOTION_API_KEY}' } }, tools: ['search'], otherTools: [] },
    ];
    const launcher = { node: '/made-up/node', script: '/made-up/connectorLauncher.mjs' };
    const env = { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'made-up-key', FAKE_KEY: 'made-up-fake-secret', NOTION_API_KEY: 'made-up-notion-secret' };

    it('puts each connector in the 0600 MCP config with its values, allows only its chosen tools, disallows the rest, and keeps every value off the command line and out of claude’s environment', async () => {
      const { supervisor, children, logs } = harness({ connectors, connectorLauncher: launcher, env });
      await supervisor.start();
      const { args, options } = children[0]!;
      expect(flag(args, '--allowed-tools')).toBe([...SUPERVISOR_ALLOWED_TOOLS, 'mcp__fake__fake_search', 'mcp__notion__search'].join(','));
      expect(flag(args, '--disallowed-tools')).toBe('mcp__fake__fake_post');
      expect(args).toContain('--strict-mcp-config');
      expect(flag(args, '--setting-sources')).toBe('');
      expect(flag(args, '--tools')).toBe('SendMessage');
      const file = flag(args, '--mcp-config')!;
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const config = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };
      expect(Object.keys(config.mcpServers).sort()).toEqual(['fake', 'notion', 'pitwall']);
      expect(config.mcpServers.fake).toMatchObject({ command: '/made-up/node', args: ['/made-up/connectorLauncher.mjs', '--keep', 'FAKE_KEY', '--', 'fake-mcp', '--flag'], env: { PATH: '/usr/bin:/bin', FAKE_KEY: 'made-up-fake-secret' } });
      expect(config.mcpServers.notion).toMatchObject({ type: 'http', headers: { Authorization: 'Bearer made-up-notion-secret' } });
      expect(JSON.stringify(config.mcpServers.fake)).not.toContain('made-up-key');
      for (const secret of ['made-up-fake-secret', 'made-up-notion-secret']) {
        expect(args.join('\n')).not.toContain(secret);
        expect(logs.join('\n')).not.toContain(secret);
        expect(JSON.stringify(supervisor.state())).not.toContain(secret);
      }
      // The cap on a result, a connector's above all.
      expect(options.env.MAX_MCP_OUTPUT_TOKENS).toBe('11000');
      expect(options.env.ENABLE_MCP_LARGE_OUTPUT_FILES).toBe('0');
    });

    it('accepts a turn whose init lists the chosen tools, and stops one that lists a tool you didn’t choose, saying to choose again', async () => {
      const { supervisor, children } = harness({ connectors, connectorLauncher: launcher, env });
      await supervisor.send('hello');
      const base = ['SendMessage', ...SUPERVISOR_ALLOWED_TOOLS, 'mcp__pitwall__spawn_session'];
      const servers = [{ name: 'pitwall', status: 'connected' }, { name: 'fake', status: 'connected' }, { name: 'notion', status: 'connected' }];
      children[0]!.init(SESSION, { tools: [...base, 'mcp__fake__fake_search', 'mcp__notion__search'], mcp_servers: servers });
      expect(supervisor.state().status).toBe('working');
      children[0]!.result();
      await supervisor.send('again');
      // A tool the server added since you chose: in the model's list, since it's in neither list (D28).
      children[0]!.init(SESSION, { tools: [...base, 'mcp__fake__fake_search', 'mcp__fake__fake_delete'], mcp_servers: servers });
      expect(supervisor.state()).toMatchObject({
        status: 'failed',
        error: expect.stringContaining("The supervisor's connector fake offers a tool you haven't chosen (mcp__fake__fake_delete), so pitwall stopped it. Run pitwall --connector-tools fake"),
      });
    });

    it('stops one whose init lists a disallowed tool anyway, as Claude Code should never', async () => {
      const { supervisor, children } = harness({ connectors, connectorLauncher: launcher, env });
      await supervisor.send('hello');
      children[0]!.init(SESSION, { tools: ['SendMessage', ...SUPERVISOR_ALLOWED_TOOLS, 'mcp__fake__fake_post'] });
      expect(supervisor.state()).toMatchObject({ status: 'failed', error: expect.stringContaining('(mcp__fake__fake_post)') });
    });

    it('without connectors, or with a connector’s variable missing, its tools are a tool pitwall didn’t give it', async () => {
      const none = harness({ env });
      await none.supervisor.send('hello');
      expect(flag(none.children[0]!.args, '--disallowed-tools')).toBeUndefined();
      none.children[0]!.init(SESSION, { tools: ['SendMessage', 'mcp__fake__fake_search'] });
      expect(none.supervisor.state()).toMatchObject({ status: 'failed', error: "The supervisor started with a tool pitwall didn't give it (mcp__fake__fake_search), so pitwall stopped it." });

      const missing = harness({ connectors, connectorLauncher: launcher, env: { ...env, FAKE_KEY: undefined } });
      await missing.supervisor.start();
      expect(missing.logs).toContain("its connector fake is off for this start: pitwall's environment has no usable FAKE_KEY (unset, or holding ${ or a line break).");
      const args = missing.children[0]!.args;
      expect(flag(args, '--allowed-tools')).toBe([...SUPERVISOR_ALLOWED_TOOLS, 'mcp__notion__search'].join(','));
      expect(flag(args, '--disallowed-tools')).toBeUndefined();
      expect(Object.keys((JSON.parse(readFileSync(flag(args, '--mcp-config')!, 'utf8')) as { mcpServers: object }).mcpServers).sort()).toEqual(['notion', 'pitwall']);
    });

    it('goes on without a connector that failed to connect, saying so', async () => {
      const { supervisor, children, logs } = harness({ connectors, connectorLauncher: launcher, env });
      await supervisor.send('hello');
      children[0]!.init(SESSION, { mcp_servers: [{ name: 'pitwall', status: 'connected' }, { name: 'fake', status: 'failed' }, { name: 'notion', status: 'connected' }] });
      expect(supervisor.state().status).toBe('working');
      expect(logs).toContain("its connector fake is failed, so its tools aren't there.");
      children[0]!.result();
      await supervisor.send('again');
      children[0]!.init(SESSION, { mcp_servers: [{ name: 'pitwall', status: 'connected' }, { name: 'fake', status: 'failed' }, { name: 'notion', status: 'needs-auth' }] });
      expect(logs.filter((line) => line.includes('fake is failed'))).toHaveLength(1);
      expect(logs).toContain("its connector notion needs a sign-in, so it's off until pitwall restarts. Run pitwall --connector-tools notion for how.");
    });

    it('leaves a connector that needed a sign-in out of every later start in the run, said once (W186’s F5)', async () => {
      const { supervisor, children, logs } = harness({ connectors, connectorLauncher: launcher, env });
      await supervisor.send('hello');
      children[0]!.init(SESSION, { mcp_servers: [{ name: 'pitwall', status: 'connected' }, { name: 'fake', status: 'connected' }, { name: 'notion', status: 'needs-auth' }] });
      children[0]!.init(SESSION, { mcp_servers: [{ name: 'pitwall', status: 'connected' }, { name: 'fake', status: 'connected' }, { name: 'notion', status: 'needs-auth' }] });
      expect(logs.filter((line) => line.includes('notion needs a sign-in'))).toHaveLength(1);
      children[0]!.exit(1, null);
      await until(() => supervisor.state().status === 'failed');
      await supervisor.start();
      const args = children[1]!.args;
      expect(flag(args, '--allowed-tools')).toBe([...SUPERVISOR_ALLOWED_TOOLS, 'mcp__fake__fake_search'].join(','));
      expect(Object.keys((JSON.parse(readFileSync(flag(args, '--mcp-config')!, 'utf8')) as { mcpServers: object }).mcpServers).sort()).toEqual(['fake', 'pitwall']);
    });

    it('checks at each start that its project folder is 0700, logging once a run if not, and never changes it (W186’s N1)', async () => {
      const { supervisor, children, logs, configDir, sessionDir } = harness({ env });
      await supervisor.start();
      const folder = path.join(configDir, 'projects', encodeProjectDir(realpathSync(sessionDir)));
      expect(logs.filter((line) => line.includes('is open to other users'))).toHaveLength(0);
      mkdirSync(folder, { recursive: true, mode: 0o755 });
      chmodSync(folder, 0o755);
      children[0]!.exit(1, null);
      await until(() => supervisor.state().status === 'failed');
      await supervisor.start();
      children[1]!.exit(1, null);
      await until(() => supervisor.state().status === 'failed');
      await supervisor.start();
      expect(logs.filter((line) => line.includes('is open to other users'))).toEqual([expect.stringContaining('(mode 755)')]);
      expect(statSync(folder).mode & 0o777).toBe(0o755);
    });

    it('logs once a run when Claude Code saved a tool result to a file anyway (W186’s F3), and goes on', async () => {
      const { supervisor, children, logs } = harness({ connectors, connectorLauncher: launcher, env });
      await supervisor.send('hello');
      children[0]!.init();
      const saved = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '<persisted-output>\nOutput too large (200KB). Full output saved to: /made-up/tool-results/mcp-fake-x.txt' }] } };
      children[0]!.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'a short result' }] } });
      expect(logs.filter((line) => line.includes('saved a large tool result'))).toHaveLength(0);
      children[0]!.emit(saved);
      children[0]!.emit(saved);
      expect(logs.filter((line) => line.includes('saved a large tool result'))).toHaveLength(1);
      expect(supervisor.state().status).toBe('working');
    });
  });

  it('stops a supervisor whose recipient gate didn’t load: its SessionStart hook never ran', async () => {
    const { supervisor, children } = harness({ hooksLoad: false });
    await supervisor.send('hello');
    children[0]!.init();
    expect(supervisor.state()).toMatchObject({ status: 'failed', error: "The supervisor started without pitwall's message gate, so pitwall stopped it. Press Start to try again." });
  });

  it('writes the names it may message for its gate, 0600, at start and as they change, and removes them when it exits', async () => {
    const { supervisor, children } = harness();
    supervisor.setRecipients(['pitwall-test-target']);
    await supervisor.start();
    const gate = gateOf(children[0]!);
    expect(statSync(gate.dir).mode & 0o777).toBe(0o700);
    expect(readRecipients(gate.dir, gate.id)).toEqual(new Set(['pitwall-test-target']));
    expect(statSync(path.join(gate.dir, `${gate.id}.recipients`)).mode & 0o777).toBe(0o600);
    supervisor.setRecipients(['pitwall-test-a', 'pitwall-test-b']);
    expect(readRecipients(gate.dir, gate.id)).toEqual(new Set(['pitwall-test-a', 'pitwall-test-b']));
    children[0]!.exit(0, null);
    await until(() => supervisor.state().status === 'failed');
    expect(readRecipients(gate.dir, gate.id)).toBeUndefined();
    expect(readdirSync(gate.dir)).toEqual([]);
  });

  it('shows its approvals in its state, denies them when it exits or pitwall closes, and puts pitwall’s notes before your next message', async () => {
    const approvals = createApprovalQueue();
    const { supervisor, children } = harness({ approvals });
    await supervisor.start();
    const added = approvals.add({ draft: { kind: 'message', to: 'pitwall-test-target', text: 'hello' }, toolName: 'SendMessage', toolUseId: 'toolu_1', input: { to: 'pitwall-test-target', message: 'hello' } });
    if (!added.ok) throw new Error('not added');
    expect(supervisor.state().approvals).toMatchObject([{ id: added.id, kind: 'message', to: 'pitwall-test-target', text: 'hello' }]);
    approvals.note('the user edited your message');
    await supervisor.send('next question');
    expect(children[0]!.messages()).toEqual(['[pitwall: the user edited your message]\n\nnext question']);
    children[0]!.exit(1, null);
    expect(await added.answer).toEqual({ behavior: 'deny', message: "The supervisor stopped before the user answered, so this wasn't sent." });
    expect(supervisor.state().approvals).toEqual([]);
    const again = approvals.add({ draft: { kind: 'message', to: 'pitwall-test-target', text: 'hi' }, toolName: 'SendMessage', toolUseId: 'toolu_2', input: {} });
    if (!again.ok) throw new Error('not added');
    await supervisor.close();
    expect(await again.answer).toEqual({ behavior: 'deny', message: "pitwall is closing, so this wasn't sent." });
  });
});

describe('a turn past --max-turns', () => {
  it('keeps the supervisor running, and tells it before your next message that its last turn reached the limit (W120)', async () => {
    const { supervisor, children } = harness();
    await supervisor.start();
    await supervisor.send('first');
    children[0]!.init();
    children[0]!.result({ subtype: 'error_max_turns', is_error: true });
    await until(() => supervisor.state().status === 'idle');
    await supervisor.send('second');
    await until(() => children[0]!.messages().length === 2);
    expect(children[0]!.messages()[1]).toBe(
      `[pitwall: your last turn reached pitwall's limit of ${SUPERVISOR_MAX_TURNS} steps for one message, so it ended before you answered. Answer with what you have, or say what you'd still read.]\n\nsecond`,
    );
  });
});

describe('withNotes()', () => {
  it('puts each note on a line of its own in brackets before your text, and leaves it alone with none', () => {
    expect(withNotes([], 'hello')).toBe('hello');
    expect(withNotes(['one', 'two'], 'hello')).toBe('[pitwall: one]\n[pitwall: two]\n\nhello');
  });
});

describe('hidden from the index', () => {
  it('is its own by pid, folder, its name on an interactive row in a supervisor’s folder, and its session id on a row with no process; a background session with its id stays listed', async () => {
    const { supervisor, children, sessionDir } = harness({ record: { sessionId: SESSION, promptVersion: 1 } });
    await supervisor.start();
    const base = { sessionId: OTHER_SESSION, name: 'pitwall-test-other', kind: 'interactive' as const, cwd: '/made-up/work/repo' };
    expect(supervisor.isOwn({ ...base, pid: children[0]!.pid })).toBe(true);
    expect(supervisor.isOwn({ ...base, cwd: realpathSync(sessionDir) })).toBe(true);
    // Another pitwall's supervisor, on another home: hidden by its name in a supervisor's folder.
    expect(supervisor.isOwn({ ...base, name: ' Pitwall-Supervisor ', cwd: '/made-up/home/.pitwall-dev/supervisor/session' })).toBe(true);
    // A session of yours that took the name anywhere else stays listed (W120, W116's F4).
    expect(supervisor.isOwn({ ...base, name: ' Pitwall-Supervisor ' })).toBe(false);
    expect(supervisor.isOwn({ ...base, name: SUPERVISOR_NAME, cwd: '/made-up/work/supervisor' })).toBe(false);
    expect(supervisor.isOwn({ ...base, sessionId: SESSION })).toBe(true);
    expect(supervisor.isOwn(base)).toBe(false);
    expect(supervisor.isOwn({ ...base, pid: 1234 })).toBe(false);
    expect(supervisor.isOwn({ ...base, sessionId: SESSION, kind: 'background', name: SUPERVISOR_NAME, pid: 4242 })).toBe(false);
    expect(supervisor.ownSessionIds()).toEqual(new Set([SESSION]));
  });
});

describe('its conversation', () => {
  it('reads its own transcript as a ConversationPage, and has none before its first turn', async () => {
    const fresh = harness();
    expect(await fresh.supervisor.conversation()).toBeUndefined();
    const { supervisor } = harness({ record: { sessionId: SESSION, promptVersion: 1 } });
    const page = await supervisor.conversation();
    expect(page?.sessionId).toBe(SESSION);
    expect(page?.entries.map((entry) => [entry.kind, entry.text])).toEqual([
      ['user', 'Which of my sessions need me?'],
      ['assistant', 'Two of them do.'],
      ['tool', 'mcp__example__search: {"query":"release notes"}'],
    ]);
  });
});

describe('New conversation (W136)', () => {
  /** An assistant message on the stream, with its call's usage. */
  const assistant = (id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) => ({
    type: 'assistant',
    message: { id, role: 'assistant', model: SUPERVISOR_MODEL, content: [{ type: 'text', text: 'Made-up answer.' }], usage },
    parent_tool_use_id: null,
    ...extra,
  });

  it('stops it, forgets the conversation on file, and the next start begins a new one, never resuming the old id', async () => {
    const approvals = createApprovalQueue({ now: () => Date.parse('2026-11-04T12:00:00.000Z') });
    const { supervisor, children, store } = harness({ record: { sessionId: SESSION, promptVersion: 1 }, approvals, now: () => Date.parse('2026-11-04T12:00:00.000Z') });
    await supervisor.send('first');
    const child = children[0]!;
    expect(flag(child.args, '--resume')).toBe(SESSION);
    child.init();
    child.emit(assistant('msg_1', { input_tokens: 10, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 4_000, output_tokens: 50 }));
    child.result({ model_usage_since_last_result: { [SUPERVISOR_MODEL]: { costUSD: 0.5 } } });
    approvals.handoff({ kind: 'spawn', name: 'pitwall-test-new', shortId: 'abc12345' });
    approvals.note('the user edited your message');
    expect(supervisor.state()).toMatchObject({ status: 'idle', sessionId: SESSION, contextTokens: 84_010, costUsd: 0.5, lastTurnAt: '2026-11-04T12:00:00.000Z' });

    expect(await supervisor.newConversation()).toEqual({ kind: 'ok' });
    expect(child.exited).toBe(true);
    expect(store.current()).toBeUndefined();
    // What belonged to that conversation goes; this run's cost stays.
    expect(supervisor.state()).toEqual({ status: 'off', approvals: [], costUsd: 0.5 });
    expect(await supervisor.conversation()).toBeUndefined();
    // It started nothing by itself.
    expect(children).toHaveLength(1);

    await supervisor.send('second');
    const next = children[1]!;
    expect(next.args).not.toContain('--resume');
    // The note about the old conversation isn't put before the new one's first message.
    expect(next.messages()).toEqual(['second']);
    next.init(OTHER_SESSION);
    expect(store.current()).toEqual({ sessionId: OTHER_SESSION, promptVersion: 1 });
    expect(supervisor.state().sessionId).toBe(OTHER_SESSION);
  });

  it('keeps the old conversation’s id its own, so it’s never listed, and its transcript on disk', async () => {
    const { supervisor, children, configDir, sessionDir } = harness({ record: { sessionId: SESSION, promptVersion: 1 } });
    await supervisor.start();
    expect(await supervisor.newConversation()).toEqual({ kind: 'ok' });
    await supervisor.start();
    children[1]!.init(OTHER_SESSION);
    expect(supervisor.ownSessionIds()).toEqual(new Set([SESSION, OTHER_SESSION]));
    const ended = { sessionId: SESSION, name: SUPERVISOR_NAME, kind: 'interactive' as const, cwd: '/made-up/work/repo' };
    expect(supervisor.isOwn(ended)).toBe(true);
    expect(statSync(path.join(configDir, 'projects', encodeProjectDir(realpathSync(sessionDir)), `${SESSION}.jsonl`)).isFile()).toBe(true);
  });

  it('never resumes the conversation it left in this run, even when its state file couldn’t be removed', async () => {
    const record = { sessionId: SESSION, promptVersion: 1 };
    const stuck = { read: () => ({ ...record }), write: () => true, clear: () => false };
    const { supervisor, children, logs } = harness({ record, store: stuck });
    await supervisor.start();
    expect(flag(children[0]!.args, '--resume')).toBe(SESSION);
    expect(await supervisor.newConversation()).toEqual({ kind: 'ok' });
    expect(await supervisor.conversation()).toBeUndefined();
    await supervisor.start();
    expect(children[1]!.args).not.toContain('--resume');
    expect(logs).toContain('its state file still names the conversation you left, so pitwall starts a new conversation.');
  });

  it('is refused, in pitwall’s words, while a turn runs, drafts wait or it starts, and does nothing then', async () => {
    const approvals = createApprovalQueue();
    const { supervisor, children, store } = harness({ record: { sessionId: SESSION, promptVersion: 1 }, approvals, readyMs: 5_000, behaviour: () => undefined });
    const starting = supervisor.start();
    expect(await supervisor.newConversation()).toEqual({ kind: 'refused', error: 'The supervisor is starting. Start a new conversation once it has started.' });
    await until(() => children.length === 1);
    const child = children[0]!;
    child.events.line(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: child.lines()[0]!.request_id, response: { current_permission_mode: 'default' } } }));
    await starting;
    await supervisor.send('a long question');
    expect(await supervisor.newConversation()).toEqual({
      kind: 'refused',
      error: 'The supervisor is working on a turn of this conversation. Stop it, or wait for it to end, then start a new conversation.',
    });
    child.init();
    child.result();
    const added = approvals.add({ draft: { kind: 'message', to: 'pitwall-test-target', text: 'hello' }, toolName: 'SendMessage', toolUseId: 'toolu_1', input: {} });
    if (!added.ok) throw new Error('not added');
    expect(await supervisor.newConversation()).toEqual({ kind: 'refused', error: "A draft from this conversation waits for you. Send or don't send it first, then start a new conversation." });
    expect(child.exited).toBe(false);
    expect(store.current()).toEqual({ sessionId: SESSION, promptVersion: 1 });
    expect(supervisor.state().sessionId).toBe(SESSION);
  });

  it('is refused while it’s held', async () => {
    const held = harness({ record: { sessionId: SESSION, promptVersion: 1 } });
    held.rows.push({ sessionId: SESSION, shortId: 'pt136bg1', name: 'pitwall-test-holder', kind: 'background', cwd: '/made-up/work/repo', pid: 4242 } as AgentRow);
    expect((await held.supervisor.start()).kind).toBe('held');
    expect(await held.supervisor.newConversation()).toMatchObject({ kind: 'refused', error: expect.stringContaining("Another session is running the supervisor's conversation") });
    expect(held.store.current()).toEqual({ sessionId: SESSION, promptVersion: 1 });

  });

  it('drops your messages waiting when a resume keeps failing, so New conversation is a way out (W136’s review)', async () => {
    // The resume (the second process) never answers its initialize request, so it fails as it starts.
    const silentResume: Behaviour = (line, child) => (child === children[1] ? undefined : answersInitialize(line, child));
    const { supervisor, children, store } = harness({ record: { sessionId: SESSION, promptVersion: 1 }, behaviour: silentResume });
    await supervisor.send('first');
    await supervisor.send('second');
    children[0]!.exit(1, null);
    await until(() => supervisor.state().status === 'failed');
    expect(supervisor.state().error).toContain('Your message waits');
    // Start resumes, and the resume fails as it starts again.
    void supervisor.start();
    await until(() => children.length === 2);
    expect(children[1]!.args).toContain('--resume');
    children[1]!.exit(1, null);
    await until(() => supervisor.state().status === 'failed');
    expect(children[1]!.messages()).toEqual([]);
    expect(supervisor.state().error).toMatch(/couldn't resume .* Your message waits to be sent when it starts\.$/);
    expect(await supervisor.newConversation()).toEqual({ kind: 'ok' });
    expect(store.current()).toBeUndefined();
    expect(supervisor.state().error).toBeUndefined();
    // The next Start begins a new conversation, and sends neither message to it.
    void supervisor.start();
    await until(() => children.length === 3);
    expect(children[2]!.args).not.toContain('--resume');
    await until(() => supervisor.state().status === 'idle');
    expect(children[2]!.messages()).toEqual([]);
  });

  it('is done at once while it’s off, with nothing to stop, and is closed once pitwall closes', async () => {
    const { supervisor, children, store } = harness({ record: { sessionId: SESSION, promptVersion: 1 } });
    expect(await supervisor.newConversation()).toEqual({ kind: 'ok' });
    expect(children).toHaveLength(0);
    expect(store.current()).toBeUndefined();
    await supervisor.close();
    expect(await supervisor.newConversation()).toEqual({ kind: 'closed' });
  });

  it('reads its context from its newest call, never a sub-agent’s, unknown until the first call of a run', async () => {
    const { supervisor, children } = harness();
    await supervisor.send('first');
    const child = children[0]!;
    child.init();
    expect(supervisor.state().contextTokens).toBeUndefined();
    child.emit(assistant('msg_1', { input_tokens: 3, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 1_000, output_tokens: 9 }));
    expect(supervisor.state().contextTokens).toBe(21_003);
    child.emit(assistant('msg_2', { input_tokens: 999_999 }, { parent_tool_use_id: 'toolu_agent' }));
    expect(supervisor.state().contextTokens).toBe(21_003);
    child.emit(assistant('msg_3', { input_tokens: 5, cache_read_input_tokens: 22_000 }));
    expect(supervisor.state().contextTokens).toBe(22_005);
  });
});

describe('streamContextTokens()', () => {
  it('adds input, cache read and cache creation tokens, and has none for a sub-agent’s, a synthetic one, or bad usage', () => {
    const event = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'assistant', message: { id: 'msg_1', model: 'test-model', ...message }, ...extra });
    expect(streamContextTokens(event({ usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 100 } }))).toBe(6);
    expect(streamContextTokens(event({ usage: { input_tokens: 1 } }, { parent_tool_use_id: 'toolu_1' }))).toBeUndefined();
    expect(streamContextTokens(event({ model: '<synthetic>', usage: { input_tokens: 1 } }))).toBeUndefined();
    expect(streamContextTokens(event({ usage: { input_tokens: '12', cache_read_input_tokens: -4 } }))).toBeUndefined();
    expect(streamContextTokens(event({}))).toBeUndefined();
    expect(streamContextTokens({ type: 'assistant', message: { usage: { input_tokens: 5 } } })).toBeUndefined();
  });
});

describe('turnCost()', () => {
  it('is the turn’s own usage; else the change in the conversation’s total; else the total, unless the process resumed', () => {
    expect(turnCost({ model_usage_since_last_result: { a: { costUSD: 0.002 }, b: { costUSD: 0.001 } }, total_cost_usd: 3 }, true, undefined)).toBeCloseTo(0.003);
    expect(turnCost({ total_cost_usd: 0.05 }, true, 0.04)).toBeCloseTo(0.01);
    expect(turnCost({ total_cost_usd: 0.05 }, false, undefined)).toBe(0.05);
    expect(turnCost({ total_cost_usd: 0.05 }, true, undefined)).toBeUndefined();
    expect(turnCost({ total_cost_usd: 'x' }, false, undefined)).toBeUndefined();
  });
});

describe('sweepMcpConfigs()', () => {
  it('removes the config files of pitwalls that are gone, and nothing else (W113’s review)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pitwall-test-sweep-'));
    try {
      for (const name of ['mcp-111.json', 'mcp-222.json', `mcp-${process.pid}.json`, 'mcp.json', 'state.json', 'mcp-333.json.tmp']) writeFileSync(path.join(dir, name), '{}');
      mkdirSync(path.join(dir, 'mcp-444.json'));
      sweepMcpConfigs(dir, (pid) => pid === 222);
      expect(readdirSync(dir).sort()).toEqual(['mcp-222.json', 'mcp-333.json.tmp', 'mcp-444.json', `mcp-${process.pid}.json`, 'mcp.json', 'state.json'].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('heldBy() and heldError()', () => {
  it('reads Claude Code’s refusal for its short id, and says what to run, never doing it', () => {
    expect(heldBy('Error: That session is running in the background (ab12cd34). Run `claude attach ab12cd34`')).toEqual({ id: 'ab12cd34' });
    expect(heldBy('That session is running in the background ($(rm -rf ~)).')).toEqual({});
    expect(heldBy('No conversation found')).toBeUndefined();
    expect(heldError('ab12cd34', 'background')).toContain('Run `claude stop ab12cd34` to hand it back');
    expect(heldError(undefined, 'interactive')).toContain('Exit that session');
    expect(heldError(undefined, 'interactive', 'pitwall-supervisor')).toBe("Another pitwall, or a terminal where you resumed it, is running the supervisor's conversation, so this one can't resume it. Close that, then press Start.");
  });
});

describe('its model and effort (W119)', () => {
  it("reads the store's choice at each start, so a change in Preferences reaches its next start", async () => {
    let choice: WorkChoice = { model: 'sonnet', effort: 'high' };
    const { supervisor, children } = harness({ work: () => choice });
    await supervisor.start();
    expect(flag(children[0]!.args, '--model')).toBe('sonnet');
    expect(flag(children[0]!.args, '--effort')).toBe('high');
    // An inherited CLAUDE_CODE_EFFORT_LEVEL, which Claude Code puts first, never reaches it.
    expect(children[0]!.options.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    await supervisor.close();
    choice = { model: 'default', effort: 'default' };
    const second = harness({ work: () => choice });
    await second.supervisor.start();
    expect(second.children[0]!.args).not.toContain('--model');
    expect(second.children[0]!.args).not.toContain('--effort');
  });

  it("stops, in pitwall's words, when Claude Code refuses its model", async () => {
    const { supervisor, children } = harness({ work: () => ({ model: 'claude-opus-9-9' }) });
    await supervisor.start();
    children[0]!.init();
    children[0]!.result({ is_error: true, result: "There's an issue with the selected model (claude-opus-9-9). It may not exist or you may not have access to it." });
    await until(() => supervisor.state().status === 'failed');
    expect(supervisor.state().error).toBe(modelRejectedMessage('supervisor'));
  });
});
