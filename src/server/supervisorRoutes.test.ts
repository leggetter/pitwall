// The supervisor on the server (M5, W113): its routes through the real HTTP server and its /api/*
// checks, the snapshot's `supervisor`, sent again when it changes, its conversation, `--no-supervisor`,
// and the real manager behind the routes with a fake claude, so no test runs claude. Made-up
// sessions and text only.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createIndexer, type Indexer, type IndexerDeps } from '../index/index.js';
import type { AgentRow } from '../index/agents.js';
import {
  MCP_PATH,
  SNAPSHOT_PATH,
  SUPERVISOR_INTERRUPT_PATH,
  SUPERVISOR_MESSAGE_MAX,
  SUPERVISOR_MESSAGE_PATH,
  SUPERVISOR_START_PATH,
  supervisorApprovalPath,
  supervisorConversationPath,
  WS_PATH,
  type IndexSnapshot,
  type ServerMessage,
  type SessionSummary,
} from '../shared/protocol.js';
import { createSupervisor } from '../supervisor/supervisor.js';
import type { RelayChildEvents } from './relay.js';
import { pitwallOrigin, proofFor } from '../test/proof.js';
import { fakeSupervisor, type FakeSupervisor } from '../test/supervisor.js';
import type { RunningServer } from './index.js';
import { startServerWithInternals } from './server.js';
import { SUPERVISOR_OFF_ERROR } from './supervisorRoutes.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const SESSION = 'aaaaaaaa-0000-4000-8000-000000000001';

let tmp: string;
let webRoot: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-supervisor-routes-'));
  webRoot = join(tmp, 'web');
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>pitwall</title>');
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const session = (id: string): SessionSummary => ({
  sessionId: id,
  name: `pitwall-test-${id}`,
  kind: 'interactive',
  cwd: '/made-up/work/repo',
  pid: 4000,
  alive: true,
  status: 'idle',
  startedAt: new Date(NOW - 3_600_000).toISOString(),
  stale: false,
  finished: false,
  transcript: 'ok',
  lastActivityAt: new Date(NOW - 60_000).toISOString(),
});

function fakeIndexer(): Indexer {
  const snapshot: IndexSnapshot = {
    generatedAt: new Date(NOW).toISOString(),
    roots: ['/made-up/work'],
    groups: [{ key: '/made-up/work/repo', label: 'repo', kind: 'git', root: '/made-up/work', sessions: [session('a')] }],
    source: { ok: true },
  };
  return {
    latest: () => snapshot,
    subscribe: () => () => {},
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

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function start(supervisor: FakeSupervisor | ReturnType<typeof createSupervisor> | null = fakeSupervisor('made-up-mcp-token-0123456789abcdefghijklmnopq')) {
  const server = await startServerWithInternals({ indexer: fakeIndexer(), token: TOKEN, webRoot, port: 0, ...(supervisor === null ? {} : { supervisor }) });
  running.push(server);
  return server;
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function request(port: number, urlPath: string, method: string, headers: Record<string, string> = {}, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: urlPath, method, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A client that answered its challenge, with every message after 'authenticated'. */
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

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const post = (port: number, urlPath: string, apiKey: string, body?: unknown, headers: Record<string, string> = {}) =>
  request(
    port,
    urlPath,
    'POST',
    { authorization: `Bearer ${apiKey}`, origin: pitwallOrigin(port), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  );

describe('the supervisor’s routes', () => {
  it('are the paths the contract names', () => {
    expect(SUPERVISOR_MESSAGE_PATH).toBe('/api/supervisor/message');
    expect(SUPERVISOR_START_PATH).toBe('/api/supervisor/start');
    expect(SUPERVISOR_INTERRUPT_PATH).toBe('/api/supervisor/interrupt');
    expect(supervisorConversationPath()).toBe('/api/supervisor/conversation');
    expect(MCP_PATH).toBe('/mcp');
  });

  it('need what every state-changing request needs: the apiKey, never the token, pitwall’s Origin and its Host', async () => {
    const supervisor = fakeSupervisor();
    const server = await start(supervisor);
    const { apiKey, ws } = await authedClient(server.port);
    for (const urlPath of [SUPERVISOR_MESSAGE_PATH, SUPERVISOR_START_PATH, SUPERVISOR_INTERRUPT_PATH]) {
      const body = JSON.stringify({ text: 'hello' });
      const json = { 'content-type': 'application/json' };
      expect((await request(server.port, urlPath, 'POST', { ...json }, body)).status, urlPath).toBe(401);
      expect((await request(server.port, urlPath, 'POST', { ...json, authorization: `Bearer ${TOKEN}`, origin: pitwallOrigin(server.port) }, body)).status, urlPath).toBe(403);
      expect((await request(server.port, urlPath, 'POST', { ...json, authorization: `Bearer ${apiKey}` }, body)).status, urlPath).toBe(403);
      expect((await request(server.port, urlPath, 'POST', { ...json, authorization: `Bearer ${apiKey}`, origin: 'http://evil.example' }, body)).status, urlPath).toBe(403);
      expect((await request(server.port, urlPath, 'POST', { ...json, authorization: `Bearer ${apiKey}`, origin: pitwallOrigin(server.port), host: `localhost:${server.port}` }, body)).status, urlPath).toBe(403);
    }
    expect(supervisor.sent).toEqual([]);
    expect(supervisor.starts).toBe(0);
    expect(supervisor.interrupts).toBe(0);
    ws.close();
  });

  it('message: your text to the supervisor, checked: JSON, { text } alone, not blank, no NUL, within SUPERVISOR_MESSAGE_MAX', async () => {
    const supervisor = fakeSupervisor();
    const server = await start(supervisor);
    const { apiKey, ws } = await authedClient(server.port);
    const ok = await post(server.port, SUPERVISOR_MESSAGE_PATH, apiKey, { text: 'Which of my sessions need me, and why?' });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true });
    expect(supervisor.sent).toEqual(['Which of my sessions need me, and why?']);
    expect((await post(server.port, SUPERVISOR_MESSAGE_PATH, apiKey, { text: 'hello' }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(server.port, SUPERVISOR_MESSAGE_PATH, apiKey, '{oops')).status).toBe(400);
    expect((await post(server.port, SUPERVISOR_MESSAGE_PATH, apiKey, { text: '   ' })).status).toBe(400);
    expect((await post(server.port, SUPERVISOR_MESSAGE_PATH, apiKey, { text: 'a', to: 'pitwall-test-target' })).status).toBe(400);
    expect((await post(server.port, SUPERVISOR_MESSAGE_PATH, apiKey, { text: 'a\u0000b' })).status).toBe(400);
    const long = await post(server.port, SUPERVISOR_MESSAGE_PATH, apiKey, { text: 'x'.repeat(SUPERVISOR_MESSAGE_MAX + 1) });
    expect(long.status).toBe(413);
    expect(JSON.parse(long.body)).toEqual({ ok: false, error: 'A message to the supervisor can be at most 20,000 characters.' });
    expect((await post(server.port, SUPERVISOR_MESSAGE_PATH, apiKey, { text: '"'.repeat(SUPERVISOR_MESSAGE_MAX) })).status).toBe(200);
    expect((await post(server.port, SUPERVISOR_MESSAGE_PATH, apiKey, JSON.stringify({ text: 'x'.repeat(200 * 1024) }))).status).toBe(413);
    expect(supervisor.sent).toHaveLength(2);
    ws.close();
  });

  it('answers held with 409, a failed start with 502, a full queue with 429 and Retry-After, and closing with 503', async () => {
    const supervisor = fakeSupervisor();
    const server = await start(supervisor);
    const { apiKey, ws } = await authedClient(server.port);
    const cases = [
      [{ kind: 'held', error: 'A background session is running the supervisor’s conversation.' }, 409],
      [{ kind: 'failed', error: 'The supervisor stopped as it started (exit code 1). Press Start to try again.' }, 502],
      [{ kind: 'busy' }, 429],
      [{ kind: 'closed' }, 503],
    ] as const;
    for (const [outcome, status] of cases) {
      supervisor.outcome = outcome;
      const res = await post(server.port, SUPERVISOR_MESSAGE_PATH, apiKey, { text: 'hello' });
      expect(res.status, outcome.kind).toBe(status);
      expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: expect.any(String) });
      if (outcome.kind === 'busy') expect(res.headers['retry-after']).toBe('5');
      if (outcome.kind !== 'busy') expect((await post(server.port, SUPERVISOR_START_PATH, apiKey)).status, `start ${outcome.kind}`).toBe(status);
    }
    ws.close();
  });

  it('start and interrupt: 200 when they did something, interrupt 409 when nothing runs', async () => {
    const supervisor = fakeSupervisor();
    const server = await start(supervisor);
    const { apiKey, ws } = await authedClient(server.port);
    expect((await post(server.port, SUPERVISOR_START_PATH, apiKey)).status).toBe(200);
    expect(supervisor.starts).toBe(1);
    expect((await post(server.port, SUPERVISOR_INTERRUPT_PATH, apiKey)).status).toBe(200);
    supervisor.interruptOutcome = { kind: 'idle' };
    const idle = await post(server.port, SUPERVISOR_INTERRUPT_PATH, apiKey);
    expect(idle.status).toBe(409);
    expect(JSON.parse(idle.body)).toEqual({ ok: false, error: "The supervisor isn't working on anything." });
    ws.close();
  });

  it('approvals answer 404 until W115', async () => {
    const server = await start();
    const { apiKey, ws } = await authedClient(server.port);
    expect((await post(server.port, supervisorApprovalPath('anything'), apiKey, { decision: 'send' })).status).toBe(404);
    ws.close();
  });

  it('its conversation: the snapshot’s token check, its own transcript paged with before, and 404 before it has one', async () => {
    const supervisor = fakeSupervisor();
    supervisor.pages.set(undefined, { sessionId: SESSION, entries: [{ kind: 'user', text: 'Which of my sessions need me?' }] });
    const server = await start(supervisor);
    expect((await request(server.port, supervisorConversationPath(), 'GET')).status).toBe(401);
    const page = await request(server.port, supervisorConversationPath(), 'GET', { authorization: `Bearer ${TOKEN}` });
    expect(page.status).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(page.body)).toEqual({ sessionId: SESSION, entries: [{ kind: 'user', text: 'Which of my sessions need me?' }] });
    expect((await request(server.port, `${supervisorConversationPath()}?before=not-a-cursor`, 'GET', { authorization: `Bearer ${TOKEN}` })).status).toBe(400);
    supervisor.pages.clear();
    expect((await request(server.port, supervisorConversationPath(), 'GET', { authorization: `Bearer ${TOKEN}` })).status).toBe(404);
  });
});

describe('the snapshot’s supervisor', () => {
  it('is on GET SNAPSHOT_PATH and the WebSocket, and sent again when its state changes', async () => {
    const supervisor = fakeSupervisor();
    const server = await start(supervisor);
    expect(supervisor.boundUrl).toBe(`http://127.0.0.1:${server.port}${MCP_PATH}`);
    const snapshot = JSON.parse((await request(server.port, SNAPSHOT_PATH, 'GET', { authorization: `Bearer ${TOKEN}` })).body) as IndexSnapshot;
    expect(snapshot.supervisor).toEqual({ status: 'off', approvals: [] });
    const { ws, messages } = await authedClient(server.port);
    await until(() => messages.some((message) => message.type === 'snapshot'));
    const before = messages.length;
    supervisor.set({ status: 'working', approvals: [], sessionId: SESSION });
    await until(() => messages.length > before);
    const latest = messages.at(-1)!;
    expect(latest).toMatchObject({ type: 'snapshot', snapshot: { supervisor: { status: 'working', sessionId: SESSION } } });
    // The same state again carries nothing new: no snapshot for it.
    const count = messages.length;
    supervisor.set({ status: 'working', approvals: [], sessionId: SESSION });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messages.length).toBe(count);
    ws.close();
  });
});

describe('--no-supervisor', () => {
  it('leaves supervisor out of the snapshot, answers 409 to its routes and 404 to its conversation and the MCP route', async () => {
    const server = await start(null);
    const snapshot = JSON.parse((await request(server.port, SNAPSHOT_PATH, 'GET', { authorization: `Bearer ${TOKEN}` })).body) as IndexSnapshot;
    expect('supervisor' in snapshot).toBe(false);
    const { apiKey, ws } = await authedClient(server.port);
    for (const urlPath of [SUPERVISOR_START_PATH, SUPERVISOR_INTERRUPT_PATH]) {
      const res = await post(server.port, urlPath, apiKey);
      expect(res.status, urlPath).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ ok: false, error: SUPERVISOR_OFF_ERROR });
    }
    expect((await post(server.port, SUPERVISOR_MESSAGE_PATH, apiKey, { text: 'hello' })).status).toBe(409);
    expect((await request(server.port, supervisorConversationPath(), 'GET', { authorization: `Bearer ${TOKEN}` })).status).toBe(404);
    expect((await request(server.port, MCP_PATH, 'POST', { 'content-type': 'application/json' }, '{}')).status).toBe(404);
    ws.close();
  });
});

describe('the real supervisor behind the routes, with a fake claude', () => {
  it('starts it on your first message, writes the message to its stdin, and shows it working in the snapshot', async () => {
    const children: { written: string[]; events: RelayChildEvents; args: string[] }[] = [];
    const home = path.join(tmp, 'home-real');
    await mkdir(home, { mode: 0o700 });
    const supervisor = createSupervisor({
      home,
      configDir: path.join(tmp, 'claude-real'),
      claudeVersion: async () => '2.1.312 (Claude Code)',
      agents: { list: async () => ({ ok: true, rows: [] }) },
      log: () => undefined,
      spawn: (_file, args, _options, events) => {
        const child = { written: [] as string[], events, args };
        children.push(child);
        return {
          pid: 71_000,
          write(data: string) {
            child.written.push(data);
            const line = JSON.parse(data) as { type: string; request_id?: string };
            if (line.type === 'control_request') setImmediate(() => events.line(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: line.request_id, response: { current_permission_mode: 'dontAsk' } } })));
          },
          end: () => setImmediate(() => events.exit(0, null)),
          kill: (signal) => setImmediate(() => events.exit(null, signal)),
        };
      },
    });
    const server = await start(supervisor);
    const { apiKey, ws, messages } = await authedClient(server.port);
    expect((await post(server.port, SUPERVISOR_MESSAGE_PATH, apiKey, { text: 'Which of my sessions need me, and why?' })).status).toBe(200);
    expect(children).toHaveLength(1);
    const userLines = children[0]!.written.map((line) => JSON.parse(line) as { type: string; message?: { content: string } }).filter((line) => line.type === 'user');
    expect(userLines).toEqual([{ type: 'user', message: { role: 'user', content: 'Which of my sessions need me, and why?' } }]);
    expect(children[0]!.args.join(' ')).not.toContain('Which of my sessions');
    await until(() => messages.some((message) => message.type === 'snapshot' && message.snapshot.supervisor?.status === 'working'));
    // The MCP route takes this process's token, which is in its config file alone.
    const token = supervisor.mcpToken()!;
    const ping = await request(server.port, MCP_PATH, 'POST', { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    expect(ping.status).toBe(200);
    ws.close();
  });
});

describe('hidden from the index', () => {
  it('leaves the supervisor’s row out of the snapshot through the CLI’s exclude hook', async () => {
    const supervisor = createSupervisor({ home: path.join(tmp, 'home-hidden'), configDir: path.join(tmp, 'claude-hidden'), log: () => undefined });
    const rows: AgentRow[] = [
      { sessionId: 'mine', name: 'pitwall-test-mine', kind: 'interactive', cwd: '/work/repo/a', pid: 1000, startedAt: new Date(NOW).toISOString() },
      { sessionId: SESSION, name: 'pitwall-supervisor', kind: 'interactive', cwd: path.join(tmp, 'home-hidden', 'supervisor', 'session'), pid: 1001, startedAt: new Date(NOW).toISOString() },
    ];
    const deps: IndexerDeps = {
      agents: { list: async () => ({ ok: true, rows }) },
      groups: { resolve: async (cwd) => ({ key: path.dirname(cwd), kind: 'git' }), prune: () => {} },
      transcripts: { read: async () => ({ transcript: 'missing' }), transcriptFile: () => undefined, retain: () => {} },
      realpath: async (p) => p,
      now: () => NOW,
      home: '/home/someone',
      concurrency: 4,
    };
    // The supervisor's folder sits under a root here, so only the hook keeps its row out.
    const indexer = createIndexer({ roots: ['/work', tmp], exclude: (row) => supervisor.isOwn(row) }, deps);
    await until(() => indexer.latest() !== undefined);
    expect(indexer.latest()!.groups.flatMap((group) => group.sessions.map((each) => each.sessionId))).toEqual(['mine']);
    indexer.stop();
    await supervisor.close();
  });
});
