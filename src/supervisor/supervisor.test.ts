// The supervisor's process (M5, W113), with a fake child that speaks stream-json as Claude Code
// 2.1.312 does (spike 009, and the handshake probe in src/server/mcp.ts), a fake session list and a
// state store in memory. No test runs `claude`. Made-up sessions and text only.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRow } from '../index/agents.js';
import { encodeProjectDir } from '../index/transcripts.js';
import { SUPERVISOR_MODEL } from '../shared/protocol.js';
import type { RelayChild, RelayChildEvents } from '../server/relay.js';
import { SUPERVISOR_ALLOWED_TOOLS, SUPERVISOR_NAME } from './prompt.js';
import { memoryState, type SupervisorRecord } from './state.js';
import { createSupervisor, heldBy, heldError, sweepMcpConfigs, turnCost, type Supervisor, type SupervisorOptions } from './supervisor.js';

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

/** Answers the initialize request as Claude Code 2.1.312 does: success, in dontAsk mode, idle. */
const answersInitialize: Behaviour = (line, child) => {
  if (line.type === 'control_request' && (line.request as { subtype?: string }).subtype === 'initialize') {
    child.emit({ type: 'control_response', response: { subtype: 'success', request_id: line.request_id, response: { current_permission_mode: 'dontAsk', session_state: 'idle', pid: child.pid } } });
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
    this.emit({ type: 'system', subtype: 'init', session_id: sessionId, tools: [...SUPERVISOR_ALLOWED_TOOLS], permissionMode: 'dontAsk', ...extra });
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
function harness(options: Partial<SupervisorOptions> & { record?: SupervisorRecord; transcript?: boolean; bind?: boolean; behaviour?: Behaviour } = {}): Harness {
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
      children.push(child);
      return child;
    },
    agents: { list: async () => ({ ok: true, rows: [...rows] }) },
    claudeVersion: async () => '2.1.312 (Claude Code)',
    env: { PATH: '/usr/bin:/bin', HOME: '/made-up/home', NODE_OPTIONS: '--require /made-up/evil.js', CLAUDE_CODE_EFFORT_LEVEL: 'max', ANTHROPIC_API_KEY: 'made-up-key' },
    log: (message) => logs.push(message),
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
  ]
    .map((line) => JSON.stringify(line))
    .join('\n')
    .concat('\n');
}

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const flag = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

describe('starting the supervisor', () => {
  it('starts a new conversation with spike 009’s command line: no built-in tools, only the read-only MCP tools, your settings off', async () => {
    const { supervisor, children, sessionDir } = harness();
    expect(supervisor.state()).toEqual({ status: 'off', approvals: [] });
    expect(await supervisor.start()).toEqual({ kind: 'ok' });
    expect(children).toHaveLength(1);
    const { args, options } = children[0]!;
    expect(args.slice(0, 7)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-hook-events']);
    expect(flag(args, '--name')).toBe(SUPERVISOR_NAME);
    expect(flag(args, '--model')).toBe(SUPERVISOR_MODEL);
    expect(flag(args, '--tools')).toBe('');
    expect(flag(args, '--permission-mode')).toBe('dontAsk');
    expect(flag(args, '--setting-sources')).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(flag(args, '--allowed-tools')).toBe('mcp__pitwall__list_sessions,mcp__pitwall__read_session,mcp__pitwall__list_prs,mcp__pitwall__get_recap');
    expect(flag(args, '--settings')).toBe('{"autoMemoryEnabled":false,"crossSessionInbound":"refuse"}');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--permission-prompt-tool');
    expect(options.cwd).toBe(realpathSync(sessionDir));
    // The relay's environment, at the model's default effort, credentials passed on.
    expect(options.env.NODE_OPTIONS).toBeUndefined();
    expect(options.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    expect(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(options.env.ANTHROPIC_API_KEY).toBe('made-up-key');
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
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mcpServers: { pitwall: { type: 'http', url: MCP_URL, headers: { Authorization: `Bearer ${token}` } } } });
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

  it('says how to start afresh when a resume fails for another reason', async () => {
    const { supervisor, children, dir } = harness({ record: { sessionId: SESSION, promptVersion: 1 }, behaviour: () => undefined, readyMs: 50 });
    const started = supervisor.start();
    await until(() => children.length === 1);
    children[0]!.exit(1, null);
    expect(await started).toEqual({
      kind: 'failed',
      error: `pitwall couldn't resume the supervisor's conversation: claude stopped as it started (exit code 1). Press Start to try again. To start a new conversation instead, delete ${path.join(path.resolve(dir), 'state.json')}.`,
    });
  });

  it('fails when it exits mid-turn, drops what was queued, and starts again only with the next message', async () => {
    const { supervisor, children } = harness();
    await supervisor.send('first');
    await supervisor.send('queued');
    children[0]!.init();
    children[0]!.exit(143, null);
    await until(() => supervisor.state().status === 'failed');
    expect(supervisor.state().error).toBe('The supervisor stopped (exit code 143). Send it a message, or press Start, to start it again.');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(children).toHaveLength(1);
    await supervisor.send('next');
    expect(children).toHaveLength(2);
    expect(children[1]!.messages()).toEqual(['next']);
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
      { type: 'control_response', response: { subtype: 'success', request_id: 'perm-1', response: { behavior: 'deny', message: "pitwall's supervisor can only read." } } },
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

  it('stops a supervisor that isn’t in dontAsk mode, by its initialize answer or its init', async () => {
    const byAnswer = harness({
      behaviour: (line, child) => {
        if (line.type === 'control_request') child.emit({ type: 'control_response', response: { subtype: 'success', request_id: line.request_id, response: { current_permission_mode: 'bypassPermissions' } } });
      },
    });
    expect(await byAnswer.supervisor.start()).toEqual({ kind: 'failed', error: "The supervisor started in a permission mode pitwall didn't ask for, so pitwall stopped it." });
    const byInit = harness();
    await byInit.supervisor.send('hello');
    byInit.children[0]!.init(SESSION, { permissionMode: 'default' });
    await until(() => byInit.supervisor.state().status === 'failed');
  });
});

describe('hidden from the index', () => {
  it('is its own by pid, folder, its name on an interactive row, and its session id on a row with no process; a background session with its id stays listed', async () => {
    const { supervisor, children, sessionDir } = harness({ record: { sessionId: SESSION, promptVersion: 1 } });
    await supervisor.start();
    const base = { sessionId: OTHER_SESSION, name: 'pitwall-test-other', kind: 'interactive' as const, cwd: '/made-up/work/repo' };
    expect(supervisor.isOwn({ ...base, pid: children[0]!.pid })).toBe(true);
    expect(supervisor.isOwn({ ...base, cwd: realpathSync(sessionDir) })).toBe(true);
    expect(supervisor.isOwn({ ...base, name: ' Pitwall-Supervisor ' })).toBe(true);
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
    ]);
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
