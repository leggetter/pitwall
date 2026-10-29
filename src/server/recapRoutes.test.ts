// A session's recap on the server (M5, W110): GET recapPath(), POST recapRefreshPath(), and the
// snapshot's recaps, through the real HTTP server and its /api/* checks, with a real engine whose
// `claude` is fake, so no test runs claude. Every session and recap here is made up.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Indexer } from '../index/index.js';
import type { RecapChildEvents } from '../recaps/call.js';
import { createRecapEngine, type RecapEngine } from '../recaps/engine.js';
import { recapPath, recapRefreshPath, SNAPSHOT_PATH, WS_PATH, type IndexSnapshot, type ServerMessage, type SessionSummary } from '../shared/protocol.js';
import { pitwallOrigin, proofFor } from '../test/proof.js';
import type { RunningServer } from './index.js';
import { startServerWithInternals } from './server.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const NOW = Date.parse('2026-10-29T12:00:00.000Z');

let tmp: string;
let webRoot: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-recaps-'));
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
  cwd: `/made-up/work/${id}`,
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

const snapshotOf = (sessions: SessionSummary[]): IndexSnapshot => ({
  generatedAt: new Date(NOW).toISOString(),
  roots: ['/made-up/work'],
  groups: [{ key: '/made-up/work/repo', label: 'repo', kind: 'git', root: '/made-up/work', sessions }],
  source: { ok: true },
});

function fakeIndexer(initial: IndexSnapshot): Indexer & { push(next: IndexSnapshot): void } {
  let latest = initial;
  const listeners = new Set<(snapshot: IndexSnapshot) => void>();
  return {
    latest: () => latest,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    conversation: async (sessionId) => ({ sessionId, entries: [{ kind: 'user', text: 'Fix the export.', at: new Date(NOW - 120_000).toISOString() }] }),
    subagents: async () => undefined,
    subagentConversation: async () => undefined,
    pollSoon: () => {},
    noteRestart: () => {},
    turnState: async () => 'unknown',
    runningSubagents: async () => undefined,
    stop: () => {},
    push(next) {
      latest = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

const RECAP = { why: 'You asked it to fix the export.', now: 'It fixed it.', next: 'It waits for you to merge #42.', waitingOn: 'you', title: 'Fix the export' };

/** A real engine with a fake claude, which holds each call until the test answers it. */
function engineWithFakeClaude(options: { budget?: number } = {}) {
  const calls: RecapChildEvents[] = [];
  const engine = createRecapEngine({
    dir: '/made-up/pitwall-home/recap',
    spawn: (_file, _args, _options, events) => {
      calls.push(events);
      return { pid: 60_000 + calls.length, send: () => undefined, kill: (signal) => events.exit(null, signal) };
    },
    sources: { read: async () => ({ firstPrompt: 'Fix the export.' }), retain: () => undefined },
    prepareDir: (dir) => dir,
    claudeVersion: async () => '2.1.312 (Claude Code)',
    now: () => NOW,
    log: () => undefined,
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  });
  const answer = (index: number) => {
    calls[index]!.stdout(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(RECAP), total_cost_usd: 0.001 }));
    calls[index]!.exit(0, null);
  };
  return { engine, calls, answer };
}

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function start(options: { recaps?: RecapEngine; sessions?: SessionSummary[] } = {}) {
  const indexer = fakeIndexer(snapshotOf(options.sessions ?? [session('a'), session('no-file')]));
  // As the index's sessionFacts hook would: 'a' has a transcript, 'no-file' doesn't.
  options.recaps?.observe(new Map([['a', { file: '/made-up/projects/a.jsonl', turnEnded: true }]]));
  const server = await startServerWithInternals({ indexer, token: TOKEN, webRoot, port: 0, ...(options.recaps === undefined ? {} : { recaps: options.recaps }) });
  running.push(server);
  return { server, indexer };
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function request(port: number, path: string, method: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const origin = (port: number) => `http://127.0.0.1:${port}`;

/** A client that answered its challenge, with every message after 'authenticated'. */
async function authedClient(port: number): Promise<{ ws: WebSocket; apiKey: string; messages: ServerMessage[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { origin: origin(port) });
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

async function waitFor(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const post = (port: number, path: string, apiKey: string) => request(port, path, 'POST', { authorization: `Bearer ${apiKey}`, origin: origin(port) });

describe('the recap routes', () => {
  it('are the paths the contract names', () => {
    expect(recapPath('abc')).toBe('/api/sessions/abc/recap');
    expect(recapRefreshPath('abc')).toBe('/api/sessions/abc/recap/refresh');
  });

  it('GET has the snapshot’s authorization: 401 without a credential, 403 from another Origin or Host', async () => {
    const { engine } = engineWithFakeClaude();
    const { server } = await start({ recaps: engine });
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }] as Record<string, string>[]) {
      expect((await request(server.port, recapPath('a'), 'GET', headers)).status).toBe(401);
    }
    expect((await request(server.port, recapPath('a'), 'GET', { authorization: `Bearer ${TOKEN}`, origin: 'http://evil.example' })).status).toBe(403);
    expect((await request(server.port, recapPath('a'), 'GET', { authorization: `Bearer ${TOKEN}`, host: `localhost:${server.port}` })).status).toBe(403);
  });

  it('GET answers 404 before a recap, 400 for an unsafe id, 404 for a session not listed, then the recap with the token or the apiKey', async () => {
    const recaps = engineWithFakeClaude();
    const { server } = await start({ recaps: recaps.engine });
    const get = (id: string, credential = TOKEN) => request(server.port, recapPath(id), 'GET', { authorization: `Bearer ${credential}` });
    expect((await get('a')).status).toBe(404);
    expect((await get('-unsafe id')).status).toBe(400);
    expect((await get('not-listed')).status).toBe(404);
    const { apiKey, ws } = await authedClient(server.port);
    expect((await post(server.port, recapRefreshPath('a'), apiKey)).status).toBe(200);
    await waitFor(() => recaps.calls.length === 1);
    recaps.answer(0);
    await waitFor(() => recaps.engine.recap(session('a')) !== undefined);
    for (const credential of [TOKEN, apiKey]) {
      const res = await get('a', credential);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(JSON.parse(res.body)).toEqual({ ...RECAP, at: new Date(NOW).toISOString(), throughAt: new Date(NOW - 60_000).toISOString(), source: 'pitwall' });
    }
    ws.close();
  });

  it('POST needs the apiKey and this Origin, as every state-changing request does', async () => {
    const recaps = engineWithFakeClaude();
    const { server } = await start({ recaps: recaps.engine });
    const { apiKey, ws } = await authedClient(server.port);
    expect((await request(server.port, recapRefreshPath('a'), 'POST', { authorization: `Bearer ${TOKEN}`, origin: origin(server.port) })).status).toBe(403);
    expect((await request(server.port, recapRefreshPath('a'), 'POST', { authorization: `Bearer ${apiKey}` })).status).toBe(403);
    expect((await request(server.port, recapRefreshPath('a'), 'POST', { authorization: `Bearer ${apiKey}`, origin: 'http://evil.example' })).status).toBe(403);
    expect(recaps.calls).toHaveLength(0);
    ws.close();
  });

  it('POST answers 404 for a session not listed or with no transcript, 429 while one runs, and 429 with Retry-After once the budget is spent', async () => {
    const recaps = engineWithFakeClaude({ budget: 1 });
    const { server } = await start({ recaps: recaps.engine });
    const { apiKey, ws } = await authedClient(server.port);
    const notListed = await post(server.port, recapRefreshPath('not-listed'), apiKey);
    expect(notListed.status).toBe(404);
    expect(JSON.parse(notListed.body)).toEqual({ ok: false, error: "That session isn't in pitwall's list." });
    const noFile = await post(server.port, recapRefreshPath('no-file'), apiKey);
    expect(noFile.status).toBe(404);
    expect(JSON.parse(noFile.body).ok).toBe(false);

    const first = await post(server.port, recapRefreshPath('a'), apiKey);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ ok: true });
    await waitFor(() => recaps.calls.length === 1);
    const busy = await post(server.port, recapRefreshPath('a'), apiKey);
    expect(busy.status).toBe(429);
    expect(busy.headers['retry-after']).toBe('5');
    recaps.answer(0);
    await waitFor(() => recaps.engine.recap(session('a')) !== undefined);
    const spent = await post(server.port, recapRefreshPath('a'), apiKey);
    expect(spent.status).toBe(429);
    expect(Number(spent.headers['retry-after'])).toBeGreaterThan(0);
    expect(JSON.parse(spent.body).error).toMatch(/after midnight/);
    ws.close();
  });

  it('with --no-recaps: POST answers 409, GET 404, and the snapshot has no recaps', async () => {
    const { server } = await start();
    const { apiKey, ws } = await authedClient(server.port);
    const res = await post(server.port, recapRefreshPath('a'), apiKey);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'Recaps are off: pitwall was started with --no-recaps, so it never runs a recap call.' });
    expect((await request(server.port, recapPath('a'), 'GET', { authorization: `Bearer ${TOKEN}` })).status).toBe(404);
    const snapshot = JSON.parse((await request(server.port, SNAPSHOT_PATH, 'GET', { authorization: `Bearer ${TOKEN}` })).body) as IndexSnapshot;
    expect(snapshot).not.toHaveProperty('recaps');
    expect(snapshot.groups[0]?.sessions[0]).not.toHaveProperty('recap');
    ws.close();
  });
});

describe('the snapshot with recaps', () => {
  it("carries each session's recap and the day's health, and goes out again over the WebSocket when a recap lands", async () => {
    const recaps = engineWithFakeClaude();
    const { server } = await start({ recaps: recaps.engine });
    const before = JSON.parse((await request(server.port, SNAPSHOT_PATH, 'GET', { authorization: `Bearer ${TOKEN}` })).body) as IndexSnapshot;
    expect(before.recaps).toEqual({ calls: 0, budget: 200, costUsd: 0 });
    const { apiKey, ws, messages } = await authedClient(server.port);
    await waitFor(() => messages.some((m) => m.type === 'snapshot'));
    await post(server.port, recapRefreshPath('a'), apiKey);
    await waitFor(() => recaps.calls.length === 1);
    recaps.answer(0);
    await waitFor(() => messages.some((m) => m.type === 'snapshot' && m.snapshot.groups[0]?.sessions.some((s) => s.recap !== undefined)));
    const after = JSON.parse((await request(server.port, SNAPSHOT_PATH, 'GET', { authorization: `Bearer ${TOKEN}` })).body) as IndexSnapshot;
    const a = after.groups[0]?.sessions.find((s) => s.sessionId === 'a');
    expect(a).toMatchObject({
      title: 'Fix the export',
      titleSource: 'pitwall',
      recap: { waitingOn: 'you', title: 'Fix the export', next: RECAP.next, source: 'pitwall' },
      needsYou: { reason: 'recap', text: RECAP.next },
    });
    expect(after.groups[0]?.sessions[0]?.sessionId).toBe('a');
    expect(after.recaps).toEqual({ calls: 1, budget: 200, costUsd: 0.001 });
    // The whole recap only from GET recapPath(): the list's snapshot has no why or now (D14).
    expect(JSON.stringify(after)).not.toContain(RECAP.why);
    ws.close();
  });
});
