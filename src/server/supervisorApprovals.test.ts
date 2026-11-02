// The supervisor's approvals on the server (M5, W115), end to end through the real HTTP server: the
// permission prompt tool, approve, called over MCP as Claude Code calls it; the card on the snapshot;
// your decision through supervisorApprovalPath() with the /api/* checks; spawn_session's one-time
// pass; and every way a call is denied. A stand-in supervisor with a real approval queue, and a fake
// command runner for `claude --bg`, so no test runs claude. Made-up sessions, folders and text only.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Indexer } from '../index/index.js';
import { MCP_PATH, supervisorApprovalPath, WS_PATH, type IndexSnapshot, type ServerMessage, type SessionSummary } from '../shared/protocol.js';
import { createApprovalQueue, DECLINED_MESSAGE, timeoutMessage, type ApprovalQueue } from '../supervisor/approvals.js';
import { pitwallOrigin, proofFor } from '../test/proof.js';
import { fakeSupervisor, type FakeSupervisor } from '../test/supervisor.js';
import type { CommandOptions, CommandResult } from './command.js';
import type { RunningServer } from './index.js';
import { startServerWithInternals } from './server.js';
import { checkMessage, recipientNames } from './supervisorActions.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const MCP_TOKEN = 'made-up-mcp-token-0123456789abcdefghijklmnopq';
const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const TARGET = 'pitwall-test-target';

let tmp: string;
let webRoot: string;
let root: string;
let repo: string;
beforeAll(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-test-approvals-')));
  webRoot = join(tmp, 'web');
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>pitwall</title>');
  root = join(tmp, 'work');
  repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await mkdir(join(tmp, 'outside'));
  await symlink(join(tmp, 'outside'), join(root, 'escape'));
  await writeFile(join(root, 'a-file'), 'not a folder');
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  name: `pitwall-test-${id}`,
  kind: 'interactive',
  cwd: repo,
  pid: 4000,
  alive: true,
  status: 'idle',
  startedAt: new Date(NOW - 3_600_000).toISOString(),
  stale: false,
  finished: false,
  transcript: 'ok',
  lastActivityAt: new Date(NOW - 60_000).toISOString(),
  ...extra,
});

const SESSIONS = [
  session('target'),
  session('ended', { alive: false, ended: true, finished: true, pid: undefined }),
  session('twin-1', { name: 'pitwall-test-twin' }),
  session('twin-2', { name: 'Pitwall-Test-Twin' }),
  session('relay', { name: 'pitwall-relay' }),
];

function fakeIndexer(state: { sessions: SessionSummary[] }): Indexer & { refresh(): void } {
  let snapshot: IndexSnapshot;
  const listeners = new Set<(snapshot: IndexSnapshot) => void>();
  const make = () => {
    snapshot = {
      generatedAt: new Date(NOW).toISOString(),
      roots: [root],
      groups: [{ key: repo, label: 'repo', kind: 'git', root, sessions: state.sessions }],
      source: { ok: true },
    };
  };
  make();
  return {
    latest: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh() {
      make();
      for (const listener of listeners) listener(snapshot);
    },
    conversation: async () => undefined,
    subagents: async () => undefined,
    subagentConversation: async () => undefined,
    pollSoon: () => {},
    noteRestart: () => {},
    turnState: async () => 'unknown',
    runningSubagents: async () => undefined,
    stop: () => {},
  };
}

interface Setup {
  server: RunningServer;
  supervisor: FakeSupervisor;
  queue: ApprovalQueue;
  indexer: ReturnType<typeof fakeIndexer>;
  state: { sessions: SessionSummary[] };
  runs: { file: string; args: readonly string[]; options: CommandOptions }[];
}

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function start(options: { timeoutMs?: number } = {}): Promise<Setup> {
  const queue = createApprovalQueue({ ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), now: () => NOW });
  const supervisor = fakeSupervisor(MCP_TOKEN, queue);
  const state = { sessions: [...SESSIONS] };
  const indexer = fakeIndexer(state);
  const runs: Setup['runs'] = [];
  const run = async (file: string, args: readonly string[], runOptions: CommandOptions): Promise<CommandResult> => {
    runs.push({ file, args, options: runOptions });
    return { kind: 'exited', code: 0, stdout: 'backgrounded · c0ffee12 · pitwall-test-new\n', stderr: '' };
  };
  const server = await startServerWithInternals({ indexer, token: TOKEN, webRoot, port: 0, supervisor }, { actions: { run } });
  running.push(server);
  return { server, supervisor, queue, indexer, state, runs };
}

function request(port: number, path: string, method: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let ids = 0;
/** A tools/call as Claude Code makes one, and the text of its result. */
async function callTool(port: number, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const message = { jsonrpc: '2.0', id: ++ids, method: 'tools/call', params: { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) } };
  const res = await request(port, MCP_PATH, 'POST', { authorization: `Bearer ${MCP_TOKEN}`, 'content-type': 'application/json' }, JSON.stringify(message));
  const parsed = JSON.parse(res.body) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: parsed.result.content[0]!.text, ...(parsed.result.isError === undefined ? {} : { isError: parsed.result.isError }) };
}

/** approve, as Claude Code calls it for a permission prompt, and its parsed answer. */
/** `null` leaves the tool_use_id out. */
async function approve(port: number, toolName: string, input: unknown, toolUseId: string | null = `toolu_${++ids}`): Promise<Record<string, unknown>> {
  const result = await callTool(port, 'approve', { tool_name: toolName, input, ...(toolUseId === null ? {} : { tool_use_id: toolUseId }) });
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.text) as Record<string, unknown>;
}

async function authedClient(port: number): Promise<{ ws: WebSocket; apiKey: string; messages: ServerMessage[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { origin: pitwallOrigin(port) });
  const messages: ServerMessage[] = [];
  const apiKey = await new Promise<string>((resolve, reject) => {
    let authenticated = false;
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      if (message.type === 'challenge') ws.send(JSON.stringify({ type: 'auth', proof: proofFor(TOKEN, message.nonce, pitwallOrigin(port)) }));
      else if (message.type === 'authenticated' && !authenticated) {
        authenticated = true;
        resolve(message.apiKey);
      } else messages.push(message);
    });
    ws.on('close', () => reject(new Error('closed before authenticated')));
  });
  return { ws, apiKey, messages };
}

const decide = (port: number, apiKey: string, id: string, body: unknown, headers: Record<string, string> = {}) =>
  request(port, supervisorApprovalPath(id), 'POST', { authorization: `Bearer ${apiKey}`, origin: pitwallOrigin(port), 'content-type': 'application/json', ...headers }, typeof body === 'string' ? body : JSON.stringify(body));

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** SendMessage's input as Claude Code 2.1.312 passes it to a permission prompt (spike 009, finding 6). */
const sendInput = (to: string, message: string, extra: Record<string, unknown> = {}) => ({
  to,
  summary: 'a greeting',
  message,
  type: 'message',
  recipient: to,
  recipient_kind: 'name',
  content: message.slice(0, 50),
  ...extra,
});

describe('a message to a session, behind your click', () => {
  it('Send: shows a card on the snapshot, holds the call, and allows what the card showed, { to, message } alone', async () => {
    const { server, queue } = await start();
    const { ws, apiKey, messages } = await authedClient(server.port);
    const input = sendInput(TARGET, 'hello from a test');
    const answer = approve(server.port, 'SendMessage', input, 'toolu_send');
    await until(() => queue.list().length === 1);
    const card = queue.list()[0]!;
    expect(card).toMatchObject({ kind: 'message', to: TARGET, text: 'hello from a test', at: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 29 * 60_000).toISOString() });
    await until(() => messages.some((message) => message.type === 'snapshot' && message.snapshot.supervisor?.approvals.length === 1));
    const res = await decide(server.port, apiKey, card.id, { decision: 'send' });
    expect(res.status).toBe(200);
    // Never the model's summary or its content preview: Claude Code fills the preview in from the message.
    expect(await answer).toEqual({ behavior: 'allow', updatedInput: { to: TARGET, message: 'hello from a test' } });
    expect(queue.list()).toEqual([]);
    expect(queue.takeNotes()).toEqual([]);
    // Answered once: the card has gone.
    expect((await decide(server.port, apiKey, card.id, { decision: 'send' })).status).toBe(404);
    ws.close();
  });

  it('Edit: allows it with your text in place of the message, checked again, and notes what was sent for the supervisor', async () => {
    const { server, queue } = await start();
    const { ws, apiKey } = await authedClient(server.port);
    const input = sendInput(TARGET, 'draft text');
    const answer = approve(server.port, 'SendMessage', input);
    await until(() => queue.list().length === 1);
    const id = queue.list()[0]!.id;
    // An edit that isn't valid text is refused, and the card stays for you to fix.
    expect((await decide(server.port, apiKey, id, { decision: 'edit', text: '   ' })).status).toBe(400);
    expect((await decide(server.port, apiKey, id, { decision: 'edit', text: 'a\u0000b' })).status).toBe(400);
    expect(queue.list()).toHaveLength(1);
    expect((await decide(server.port, apiKey, id, { decision: 'edit', text: 'your own words' })).status).toBe(200);
    expect(await answer).toEqual({ behavior: 'allow', updatedInput: { to: TARGET, message: 'your own words' } });
    expect(queue.takeNotes()).toEqual([`the user edited your message to "${TARGET}" before it was sent. What was sent: "your own words"`]);
    ws.close();
  });

  it('Don’t send: denies it, saying you declined', async () => {
    const { server, queue } = await start();
    const { ws, apiKey } = await authedClient(server.port);
    const answer = approve(server.port, 'SendMessage', sendInput(TARGET, 'hello'));
    await until(() => queue.list().length === 1);
    expect((await decide(server.port, apiKey, queue.list()[0]!.id, { decision: 'decline' })).status).toBe(200);
    expect(await answer).toEqual({ behavior: 'deny', message: DECLINED_MESSAGE });
    ws.close();
  });

  it('a card you don’t answer is denied when it runs out, saying so, and a late answer finds it gone', async () => {
    const { server, queue } = await start({ timeoutMs: 60 });
    const { ws, apiKey } = await authedClient(server.port);
    const answer = approve(server.port, 'SendMessage', sendInput(TARGET, 'hello'));
    await until(() => queue.list().length === 1);
    const id = queue.list()[0]!.id;
    expect(await answer).toEqual({ behavior: 'deny', message: timeoutMessage(60) });
    expect(timeoutMessage()).toContain('within 29 minutes');
    expect(timeoutMessage()).toContain('ask the user again');
    expect((await decide(server.port, apiKey, id, { decision: 'send' })).status).toBe(404);
    ws.close();
  });

  it('pitwall closing denies every card waiting', async () => {
    const { server, queue } = await start();
    const answer = approve(server.port, 'SendMessage', sendInput(TARGET, 'hello')).catch(() => ({ behavior: 'deny' }));
    await until(() => queue.list().length === 1);
    await server.close();
    expect(await answer).toMatchObject({ behavior: 'deny' });
    expect(queue.list()).toEqual([]);
  });

  it('a call cancelled while it waits takes its card away', async () => {
    const { server, queue } = await start();
    const answer = approve(server.port, 'SendMessage', sendInput(TARGET, 'hello'), 'toolu_cancel');
    await until(() => queue.list().length === 1);
    const cancelled = await request(server.port, MCP_PATH, 'POST', { authorization: `Bearer ${MCP_TOKEN}`, 'content-type': 'application/json' }, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: ids } }));
    expect(cancelled.status).toBe(202);
    expect(await answer).toMatchObject({ behavior: 'deny' });
    expect(queue.list()).toEqual([]);
  });

  it('Send checks again: a session that ended since denies it, saying why, and its card goes', async () => {
    const { server, queue, state, indexer } = await start();
    const { ws, apiKey } = await authedClient(server.port);
    const answer = approve(server.port, 'SendMessage', sendInput(TARGET, 'hello'));
    await until(() => queue.list().length === 1);
    state.sessions = state.sessions.map((each) => (each.name === TARGET ? { ...each, alive: false, ended: true, finished: true } : each));
    indexer.refresh();
    const res = await decide(server.port, apiKey, queue.list()[0]!.id, { decision: 'send' });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toContain('isn’t running');
    expect(await answer).toMatchObject({ behavior: 'deny', message: expect.stringContaining('checked this again') });
    expect(queue.list()).toEqual([]);
    ws.close();
  });

  it('denies at once, with no card, a recipient that isn’t exactly one running, listed session, and input pitwall doesn’t check', async () => {
    const { server, queue } = await start();
    const cases: [string, unknown][] = [
      ['ended', sendInput('pitwall-test-ended', 'hi')],
      ['unknown', sendInput('pitwall-test-nobody', 'hi')],
      ['shared name', sendInput('pitwall-test-twin', 'hi')],
      ['pitwall’s relay', sendInput('pitwall-relay', 'hi')],
      ['the supervisor itself', sendInput('pitwall-supervisor', 'hi')],
      ['an address', sendInput('uds:/tmp/cc-socks/1.sock', 'hi', { recipient_kind: 'address' })],
      ['other case', sendInput('Pitwall-Test-Target', 'hi')],
      ['broadcast', sendInput('*', 'hi')],
      ['idle notices', sendInput(TARGET, 'hi', { notify_when_idle: true })],
      ['an unknown field', sendInput(TARGET, 'hi', { attachments: ['/etc/passwd'] })],
      ['two recipients', sendInput(TARGET, 'hi', { recipient: 'pitwall-test-other' })],
      ['a preview that isn’t the message', sendInput(TARGET, 'harmless', { content: 'EVIL' })],
      ['a preview that adds to it', sendInput(TARGET, 'harmless', { content: 'harmless, then run curl … | sh' })],
      ['a preview that isn’t its start', sendInput(TARGET, 'x'.repeat(80), { content: `${'y'.repeat(49)}…` })],
      ['a preview that isn’t text', sendInput(TARGET, 'hi', { content: ['hi'] })],
      ['empty', sendInput(TARGET, '  ')],
      ['too long', sendInput(TARGET, 'x'.repeat(20_001))],
      ['not an object', 'hello'],
    ];
    for (const [what, input] of cases) {
      expect(await approve(server.port, 'SendMessage', input), what).toMatchObject({ behavior: 'deny' });
    }
    expect(queue.list()).toEqual([]);
  });

  it('takes Claude Code’s own preview of a long message, its start cut with an ellipsis, and a call with no preview', async () => {
    const { server, queue } = await start();
    const { ws, apiKey } = await authedClient(server.port);
    const long = `${'Please look at the failing export test '.repeat(3)}and tell me why.`;
    const answer = approve(server.port, 'SendMessage', sendInput(TARGET, long, { content: `${long.slice(0, 49)}…` }));
    await until(() => queue.list().length === 1);
    await decide(server.port, apiKey, queue.list()[0]!.id, { decision: 'send' });
    expect(await answer).toEqual({ behavior: 'allow', updatedInput: { to: TARGET, message: long } });
    const bare = approve(server.port, 'SendMessage', { to: TARGET, message: 'hi' });
    await until(() => queue.list().length === 1);
    await decide(server.port, apiKey, queue.list()[0]!.id, { decision: 'send' });
    expect(await bare).toEqual({ behavior: 'allow', updatedInput: { to: TARGET, message: 'hi' } });
    ws.close();
  });

  it('denies at once anything else Claude Code asks about, and a request without a tool_use_id', async () => {
    const { server, queue } = await start();
    for (const tool of ['Bash', 'mcp__pitwall__approve', 'mcp__pitwall__list_sessions', 'Agent', 'Write']) {
      const answer = await approve(server.port, tool, { command: 'ls' });
      expect(answer, tool).toMatchObject({ behavior: 'deny', message: expect.stringContaining('only propose messages to sessions and new sessions') });
    }
    expect(await approve(server.port, 'SendMessage', sendInput(TARGET, 'hi'), null)).toMatchObject({ behavior: 'deny' });
    expect(await approve(server.port, 'SendMessage', sendInput(TARGET, 'hi'), 'not a tool use id!')).toMatchObject({ behavior: 'deny' });
    const missing = await callTool(server.port, 'approve', { input: {} });
    expect(JSON.parse(missing.text)).toMatchObject({ behavior: 'deny' });
    expect(queue.list()).toEqual([]);
  });
});

describe('a new session, behind your click', () => {
  it('Send: a card with the real directory, then spawn_session runs pitwall’s spawn once, on a pass for exactly the input allowed', async () => {
    const { server, queue, runs } = await start();
    const { ws, apiKey } = await authedClient(server.port);
    const input = { directory: join(root, '.', 'repo'), prompt: 'Write the release notes for 1.2.', name: 'pitwall-test-new' };
    const answer = approve(server.port, 'mcp__pitwall__spawn_session', input, 'toolu_spawn');
    await until(() => queue.list().length === 1);
    expect(queue.list()[0]).toMatchObject({ kind: 'spawn', directory: repo, name: 'pitwall-test-new', prompt: 'Write the release notes for 1.2.' });
    // Before your click, a call starts nothing.
    expect((await callTool(server.port, 'spawn_session', { directory: repo, prompt: input.prompt, name: input.name }, { 'claudecode/toolUseId': 'toolu_spawn' })).isError).toBe(true);
    expect(runs).toEqual([]);
    expect((await decide(server.port, apiKey, queue.list()[0]!.id, { decision: 'send' })).status).toBe(200);
    const allowed = (await answer) as { behavior: string; updatedInput: Record<string, unknown> };
    expect(allowed).toEqual({ behavior: 'allow', updatedInput: { directory: repo, prompt: 'Write the release notes for 1.2.', name: 'pitwall-test-new' } });
    // Another call's tool_use_id, or other arguments: nothing, and the pass stays.
    expect((await callTool(server.port, 'spawn_session', allowed.updatedInput, { 'claudecode/toolUseId': 'toolu_other' })).isError).toBe(true);
    expect((await callTool(server.port, 'spawn_session', { ...allowed.updatedInput, prompt: 'Something else.' })).isError).toBe(true);
    expect(runs).toEqual([]);
    const started = await callTool(server.port, 'spawn_session', allowed.updatedInput, { 'claudecode/toolUseId': 'toolu_spawn' });
    expect(started.isError).toBeUndefined();
    expect(JSON.parse(started.text)).toEqual({ started: true, name: 'pitwall-test-new', shortId: 'c0ffee12', directory: repo });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.args).toEqual(['--bg', '--name', 'pitwall-test-new', '--', 'Write the release notes for 1.2.']);
    expect(runs[0]!.options.cwd).toBe(repo);
    // Once, with its tool_use_id or without.
    expect((await callTool(server.port, 'spawn_session', allowed.updatedInput, { 'claudecode/toolUseId': 'toolu_spawn' })).isError).toBe(true);
    expect((await callTool(server.port, 'spawn_session', allowed.updatedInput)).isError).toBe(true);
    expect(runs).toHaveLength(1);
    ws.close();
  });

  it('without Claude Code’s tool_use_id, which isn’t documented, a call runs on a pass for exactly its arguments, once per approval', async () => {
    const { server, queue, runs } = await start();
    const { ws, apiKey } = await authedClient(server.port);
    const input = { directory: repo, prompt: 'Tidy the README.' };
    for (const toolUseId of ['toolu_a', 'toolu_b']) {
      const answer = approve(server.port, 'mcp__pitwall__spawn_session', input, toolUseId);
      await until(() => queue.list().length === 1);
      await decide(server.port, apiKey, queue.list()[0]!.id, { decision: 'send' });
      await answer;
    }
    // Two approvals of the same input: two passes, so two calls, and no third.
    for (let call = 0; call < 2; call++) expect((await callTool(server.port, 'spawn_session', input)).isError).toBeUndefined();
    expect((await callTool(server.port, 'spawn_session', input)).isError).toBe(true);
    expect(runs).toHaveLength(2);
    ws.close();
  });

  it('a pass is spent by a call with its tool_use_id whose arguments differ from what you allowed', async () => {
    const { server, queue, runs } = await start();
    const { ws, apiKey } = await authedClient(server.port);
    const answer = approve(server.port, 'mcp__pitwall__spawn_session', { directory: repo, prompt: 'Tidy the README.' }, 'toolu_swap');
    await until(() => queue.list().length === 1);
    await decide(server.port, apiKey, queue.list()[0]!.id, { decision: 'send' });
    await answer;
    expect((await callTool(server.port, 'spawn_session', { directory: repo, prompt: 'Something else.' }, { 'claudecode/toolUseId': 'toolu_swap' })).isError).toBe(true);
    expect((await callTool(server.port, 'spawn_session', { directory: repo, prompt: 'Tidy the README.' }, { 'claudecode/toolUseId': 'toolu_swap' })).isError).toBe(true);
    expect((await callTool(server.port, 'spawn_session', { directory: repo, prompt: 'Tidy the README.' })).isError).toBe(true);
    expect(runs).toEqual([]);
    ws.close();
  });

  it('Edit replaces the first prompt, checked again, and notes it; Don’t send starts nothing', async () => {
    const { server, queue, runs } = await start();
    const { ws, apiKey } = await authedClient(server.port);
    const first = approve(server.port, 'mcp__pitwall__spawn_session', { directory: repo, prompt: 'Draft prompt.' }, 'toolu_edit');
    await until(() => queue.list().length === 1);
    const id = queue.list()[0]!.id;
    expect((await decide(server.port, apiKey, id, { decision: 'edit', text: 'x'.repeat(16_385) })).status).toBe(400);
    expect((await decide(server.port, apiKey, id, { decision: 'edit', text: 'Your own prompt.' })).status).toBe(200);
    expect(await first).toEqual({ behavior: 'allow', updatedInput: { directory: repo, prompt: 'Your own prompt.' } });
    expect(queue.takeNotes()).toEqual([`the user edited the first prompt of your new session in ${JSON.stringify(repo)} before it started. What was sent: "Your own prompt."`]);
    const second = approve(server.port, 'mcp__pitwall__spawn_session', { directory: repo, prompt: 'Another.' }, 'toolu_decline');
    await until(() => queue.list().length === 1);
    expect((await decide(server.port, apiKey, queue.list()[0]!.id, { decision: 'decline' })).status).toBe(200);
    expect(await second).toEqual({ behavior: 'deny', message: DECLINED_MESSAGE });
    expect((await callTool(server.port, 'spawn_session', { directory: repo, prompt: 'Another.' }, { 'claudecode/toolUseId': 'toolu_decline' })).isError).toBe(true);
    expect(runs).toEqual([]);
    ws.close();
  });

  it('denies at once, with no card, a directory that isn’t an existing one under a root by its real path, a bad name or prompt, or another argument', async () => {
    const { server, queue } = await start();
    const cases: [string, unknown][] = [
      ['outside the roots', { directory: join(tmp, 'outside'), prompt: 'Go.' }],
      ['a symlink out of the root', { directory: join(root, 'escape'), prompt: 'Go.' }],
      ['missing', { directory: join(root, 'nope'), prompt: 'Go.' }],
      ['a file', { directory: join(root, 'a-file'), prompt: 'Go.' }],
      ['relative', { directory: 'work/repo', prompt: 'Go.' }],
      ['a bad name', { directory: repo, prompt: 'Go.', name: '--dangerously-skip-permissions' }],
      ['no prompt', { directory: repo, prompt: '' }],
      ['too long', { directory: repo, prompt: 'x'.repeat(16_385) }],
      ['a claude command', { directory: repo, prompt: 'update' }],
      ['a model', { directory: repo, prompt: 'Go.', model: 'opus' }],
      ['attachments', { directory: repo, prompt: 'Go.', attachments: ['a'] }],
    ];
    for (const [what, input] of cases) {
      expect(await approve(server.port, 'mcp__pitwall__spawn_session', input), what).toMatchObject({ behavior: 'deny' });
    }
    expect(queue.list()).toEqual([]);
  });
});

describe('the decision route’s checks', () => {
  it('takes the apiKey, this server’s Origin and Host, JSON and a SupervisorDecision alone; 404 for an approval that’s gone', async () => {
    const { server, queue } = await start();
    const { ws, apiKey } = await authedClient(server.port);
    const answer = approve(server.port, 'SendMessage', sendInput(TARGET, 'hello'));
    await until(() => queue.list().length === 1);
    const id = queue.list()[0]!.id;
    const body = JSON.stringify({ decision: 'send' });
    const json = { 'content-type': 'application/json' };
    const path = supervisorApprovalPath(id);
    expect((await request(server.port, path, 'POST', json, body)).status).toBe(401);
    expect((await request(server.port, path, 'POST', { ...json, authorization: `Bearer ${TOKEN}`, origin: pitwallOrigin(server.port) }, body)).status).toBe(403);
    expect((await request(server.port, path, 'POST', { ...json, authorization: `Bearer ${apiKey}` }, body)).status).toBe(403);
    expect((await request(server.port, path, 'POST', { ...json, authorization: `Bearer ${apiKey}`, origin: 'http://evil.example' }, body)).status).toBe(403);
    expect((await request(server.port, path, 'POST', { ...json, authorization: `Bearer ${apiKey}`, origin: pitwallOrigin(server.port), host: `localhost:${server.port}` }, body)).status).toBe(403);
    expect((await request(server.port, path, 'POST', { authorization: `Bearer ${MCP_TOKEN}`, origin: pitwallOrigin(server.port), ...json }, body)).status).toBe(401);
    expect((await decide(server.port, apiKey, id, { decision: 'send' }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await decide(server.port, apiKey, id, '{oops')).status).toBe(400);
    expect((await decide(server.port, apiKey, id, { decision: 'maybe' })).status).toBe(400);
    expect((await decide(server.port, apiKey, id, { decision: 'send', text: 'extra' })).status).toBe(400);
    expect((await decide(server.port, apiKey, id, { decision: 'edit' })).status).toBe(400);
    expect((await decide(server.port, apiKey, id, { decision: 'edit', text: 'x'.repeat(20_001) })).status).toBe(413);
    expect((await decide(server.port, apiKey, 'ffffffff', { decision: 'send' })).status).toBe(404);
    // None of those answered it.
    expect(queue.list()).toHaveLength(1);
    await decide(server.port, apiKey, id, { decision: 'decline' });
    expect(await answer).toMatchObject({ behavior: 'deny' });
    ws.close();
  });

  it('is 404 with --no-supervisor', async () => {
    const server = await startServerWithInternals({ indexer: fakeIndexer({ sessions: SESSIONS }), token: TOKEN, webRoot, port: 0 });
    running.push(server);
    const { ws, apiKey } = await authedClient(server.port);
    expect((await decide(server.port, apiKey, 'abc', { decision: 'send' })).status).toBe(404);
    ws.close();
  });
});

describe('the names the recipient gate lets through', () => {
  it('are the running, listed sessions whose name no other running one shares, never pitwall’s own, kept up with the list', async () => {
    const snapshot = fakeIndexer({ sessions: SESSIONS }).latest()!;
    expect(recipientNames(snapshot)).toEqual([TARGET]);
    expect(recipientNames(snapshot, new Set(['target']))).toEqual([]);
    expect(recipientNames(undefined)).toEqual([]);
    expect(checkMessage(sendInput(TARGET, 'hi'), snapshot)).toEqual({ ok: true, value: { to: TARGET, text: 'hi' } });
    const { supervisor, state, indexer } = await start();
    expect(supervisor.recipients).toEqual([TARGET]);
    state.sessions = [...state.sessions, session('second')];
    indexer.refresh();
    expect(supervisor.recipients).toEqual(['pitwall-test-second', TARGET]);
  });
});
