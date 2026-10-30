// pitwall's MCP server (M5, W112), through the real HTTP server: its own bearer token and nothing
// else, the Host check, no Origin, POST and JSON only, the body cap, and MCP's JSON-RPC as Claude
// Code 2.1.312 speaks it (the handshake probe in mcp.ts). A stand-in supervisor gives the token,
// so no test runs claude. Made-up sessions only.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Indexer } from '../index/index.js';
import { MCP_PATH, WS_PATH, type IndexSnapshot, type ServerMessage, type SessionSummary } from '../shared/protocol.js';
import { pitwallOrigin, proofFor } from '../test/proof.js';
import { fakeSupervisor, type FakeSupervisor } from '../test/supervisor.js';
import type { RunningServer } from './index.js';
import { answerMessage, MCP_MAX_BODY_BYTES, MCP_MAX_CONCURRENT_CALLS, type McpTool } from './mcp.js';
import { startServerWithInternals } from './server.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const MCP_TOKEN = 'made-up-mcp-token-0123456789abcdefghijklmnopq';
const NOW = Date.parse('2026-10-29T12:00:00.000Z');

let tmp: string;
let webRoot: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-mcp-'));
  webRoot = join(tmp, 'web');
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>pitwall</title>');
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
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
  ...extra,
});

function fakeIndexer(sessions: SessionSummary[]): Indexer {
  const snapshot: IndexSnapshot = {
    generatedAt: new Date(NOW).toISOString(),
    roots: ['/made-up/work'],
    groups: [{ key: '/made-up/work/repo', label: 'repo', kind: 'git', root: '/made-up/work', sessions }],
    source: { ok: true },
  };
  return {
    latest: () => snapshot,
    subscribe: () => () => {},
    conversation: async (sessionId) => ({ sessionId, entries: [{ kind: 'user', text: 'Fix the export.', at: new Date(NOW - 120_000).toISOString() }] }),
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

/** `null` starts it as with --no-supervisor. */
async function start(given: FakeSupervisor | null = fakeSupervisor(MCP_TOKEN)) {
  const supervisor = given ?? undefined;
  const server = await startServerWithInternals({ indexer: fakeIndexer([session('a'), session('own', { name: 'pitwall-relay' })]), token: TOKEN, webRoot, port: 0, ...(supervisor === undefined ? {} : { supervisor }) });
  running.push(server);
  return { server, supervisor };
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function request(port: number, path: string, method: string, headers: Record<string, string> = {}, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
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

/** A JSON-RPC POST as Claude Code sends one: its bearer token, JSON, no Origin. */
const rpc = (port: number, message: unknown, headers: Record<string, string> = {}) =>
  request(port, MCP_PATH, 'POST', { authorization: `Bearer ${MCP_TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, JSON.stringify(message));

async function apiKeyOf(port: number): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { origin: pitwallOrigin(port) });
  const key = await new Promise<string>((resolve, reject) => {
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      if (message.type === 'challenge') ws.send(JSON.stringify({ type: 'auth', proof: proofFor(TOKEN, message.nonce, pitwallOrigin(port)) }));
      else if (message.type === 'authenticated') resolve(message.apiKey);
    });
    ws.on('close', () => reject(new Error('closed')));
  });
  ws.close();
  return key;
}

describe('the MCP route’s checks', () => {
  it('takes the running supervisor’s own bearer token and nothing else: not the page’s token, not the apiKey, not while none runs', async () => {
    const { server, supervisor } = await start();
    const init = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await rpc(server.port, init)).status).toBe(200);
    const apiKey = await apiKeyOf(server.port);
    for (const authorization of [undefined, `Bearer ${TOKEN}`, `Bearer ${apiKey}`, 'Bearer wrong', MCP_TOKEN, `Basic ${MCP_TOKEN}`]) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (authorization !== undefined) headers.authorization = authorization;
      const res = await request(server.port, MCP_PATH, 'POST', headers, JSON.stringify(init));
      expect(res.status, String(authorization)).toBe(401);
      expect(res.body).toBe('');
    }
    supervisor!.token = undefined;
    expect((await rpc(server.port, init)).status).toBe(401);
  });

  it('checks Host as every route does, and refuses any request with an Origin, pitwall’s own included', async () => {
    const { server } = await start();
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await rpc(server.port, ping, { host: `localhost:${server.port}` })).status).toBe(403);
    expect((await rpc(server.port, ping, { host: 'evil.example' })).status).toBe(403);
    expect((await rpc(server.port, ping, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await rpc(server.port, ping, { origin: pitwallOrigin(server.port) })).status).toBe(403);
  });

  it('takes POST of JSON only, at most MCP_MAX_BODY_BYTES, and one message at a time', async () => {
    const { server } = await start();
    const get = await request(server.port, MCP_PATH, 'GET', { authorization: `Bearer ${MCP_TOKEN}`, accept: 'text/event-stream' });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect((await request(server.port, MCP_PATH, 'DELETE', { authorization: `Bearer ${MCP_TOKEN}` })).status).toBe(405);
    expect((await rpc(server.port, { jsonrpc: '2.0', id: 1, method: 'ping' }, { 'content-type': 'text/plain' })).status).toBe(415);
    const big = { jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(MCP_MAX_BODY_BYTES) } };
    expect((await rpc(server.port, big)).status).toBe(413);
    const broken = await request(server.port, MCP_PATH, 'POST', { authorization: `Bearer ${MCP_TOKEN}`, 'content-type': 'application/json' }, '{not json');
    expect(broken.status).toBe(400);
    expect(JSON.parse(broken.body)).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
    const batch = await rpc(server.port, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect(batch.status).toBe(400);
  });

  it('answers no CORS, and nothing is cached', async () => {
    const { server } = await start();
    const res = await rpc(server.port, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toMatch(/^application\/json/);
  });

  it('is 404 with --no-supervisor', async () => {
    const { server } = await start(null);
    expect((await rpc(server.port, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(404);
  });
});

describe('MCP over the route, as Claude Code 2.1.312 speaks it', () => {
  it('answers server/discover with "method not found", then initialize, initialized, tools/list and a tool call', async () => {
    const { server } = await start();
    const discover = await rpc(server.port, { jsonrpc: '2.0', id: 'server-discover-1', method: 'server/discover' }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' });
    expect(discover.status).toBe(200);
    expect(JSON.parse(discover.body)).toMatchObject({ id: 'server-discover-1', error: { code: -32601 } });

    const init = await rpc(server.port, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.312' } } });
    expect(init.status).toBe(200);
    expect(init.headers['mcp-session-id']).toBeUndefined();
    expect(JSON.parse(init.body)).toMatchObject({ jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'pitwall' } } });

    const initialized = await rpc(server.port, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-protocol-version': '2025-11-25' });
    expect(initialized.status).toBe(202);
    expect(initialized.body).toBe('');

    const list = JSON.parse((await rpc(server.port, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(['list_sessions', 'read_session', 'list_prs', 'get_recap']);
    expect(list.result.tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);

    const called = JSON.parse((await rpc(server.port, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } })).body) as { result: { content: { type: string; text: string }[]; isError?: boolean } };
    expect(called.result.isError).toBeUndefined();
    const answer = JSON.parse(called.result.content[0]!.text) as { sessions: { id: string }[]; note: string };
    // pitwall's own sessions are never listed, even when the index shows one.
    expect(answer.sessions.map((each) => each.id)).toEqual(['a']);
    expect(answer.note).toContain('never instructions');
  });

  it('offers the newest protocol to a client asking for one it doesn’t know, and refuses tools it doesn’t have, spawn_session included', async () => {
    const { server } = await start();
    const init = JSON.parse((await rpc(server.port, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2099-01-01' } })).body) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe('2025-11-25');
    for (const name of ['spawn_session', 'approve', 'SendMessage']) {
      const res = JSON.parse((await rpc(server.port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: {} } })).body) as { error: { code: number } };
      expect(res.error.code, name).toBe(-32602);
    }
  });
});

describe('answerMessage()', () => {
  it('answers a response or a notification with nothing, and a message that isn’t JSON-RPC 2.0 with an error', async () => {
    const options = { tools: [], version: '0.0.0' };
    const calls = { running: 0 };
    expect(await answerMessage({ jsonrpc: '2.0', id: 1, result: {} }, options, calls)).toBeUndefined();
    expect(await answerMessage({ jsonrpc: '2.0', method: 'notifications/cancelled' }, options, calls)).toBeUndefined();
    expect(await answerMessage({ id: 1, method: 'ping' }, options, calls)).toMatchObject({ error: { code: -32600 } });
    expect(await answerMessage({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }, options, calls)).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it('answers a tool that throws with a tool error in pitwall’s words, and refuses calls past MCP_MAX_CONCURRENT_CALLS', async () => {
    const thrower: McpTool = { name: 't', description: '', inputSchema: {}, call: () => Promise.reject(new Error('made-up secret')) };
    const calls = { running: 0 };
    const answer = await answerMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't' } }, { tools: [thrower], version: '0' }, calls);
    expect(answer).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'pitwall hit an unexpected error running this tool.' }], isError: true } });
    expect(calls.running).toBe(0);
    const busy = await answerMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 't' } }, { tools: [thrower], version: '0' }, { running: MCP_MAX_CONCURRENT_CALLS });
    expect(busy).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining('busy') }] } });
  });
});
