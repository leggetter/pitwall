// Your open pull requests on the server (M4, W93): GET PRS_PATH, POST PRS_REFRESH_PATH and the 'prs'
// WebSocket message, through the real HTTP server and its /api/* checks, with a poller whose fetch is
// fake and whose clock is the test's, so no test runs gh. Made-up PRs only.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Indexer } from '../index/index.js';
import type { FetchResult } from '../prs/fetch.js';
import { parsePullRequest } from '../prs/parse.js';
import { createPrPoller, prsOff, PRS_OFF_ERROR, type PrSource } from '../prs/poller.js';
import {
  PRS_PATH,
  PRS_POLL_INTERVAL_MS,
  PRS_REFRESH_MIN_MS,
  PRS_REFRESH_PATH,
  WS_PATH,
  type IndexSnapshot,
  type PullRequestList,
  type PullRequestSummary,
  type ServerMessage,
} from '../shared/protocol.js';
import { fakeClock, fakeFetch, fetched, fetchFailed, prNode } from '../test/prs.js';
import { pitwallOrigin, proofFor } from '../test/proof.js';
import type { RunningServer } from './index.js';
import { startServerWithInternals } from './server.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';

let tmp: string;
let webRoot: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-prs-'));
  webRoot = join(tmp, 'web');
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>pitwall</title>');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const snapshot = (generatedAt = '2026-10-28T00:00:00.000Z'): IndexSnapshot => ({ generatedAt, roots: ['/tmp/pitwall-test-root'], groups: [], source: { ok: true } });

interface FakeIndexer extends Indexer {
  push(snapshot: IndexSnapshot): void;
}

/** `null` for an index with no snapshot yet. */
function fakeIndexer(initial: IndexSnapshot | null = snapshot()): FakeIndexer {
  let latest = initial ?? undefined;
  const listeners = new Set<(snapshot: IndexSnapshot) => void>();
  return {
    latest: () => latest,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    conversation: async () => undefined,
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

const pr = (number: number, overrides: Record<string, unknown> = {}): PullRequestSummary =>
  parsePullRequest(prNode({ repo: 'example/demo-app', number, ...overrides }))!;
const ok = (prs: PullRequestSummary[]): FetchResult => fetched(prs);

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

/** A server with a real poller on the test's clock and fetch, or with `prs` as given. */
async function start(options: { prs?: PrSource | 'none'; indexer?: Indexer } = {}) {
  const clock = fakeClock();
  const fetch = fakeFetch();
  const poller = options.prs ?? createPrPoller({ fetch: fetch.fetch, now: clock.now, monotonicNow: clock.monotonic, timers: clock.timers });
  const server = await startServerWithInternals({
    indexer: options.indexer ?? fakeIndexer(),
    token: TOKEN,
    webRoot,
    port: 0,
    ...(poller === 'none' ? {} : { prs: poller }),
  });
  running.push(server);
  return { server, clock, fetch, poller };
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

interface Client {
  ws: WebSocket;
  /** Every message after 'authenticated', in order. */
  messages: ServerMessage[];
  closed: Promise<void>;
}

/** A client that answered its challenge; resolves once it's authenticated, with what came after kept in order. */
async function authedClient(port: number): Promise<Client & { apiKey: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { origin: origin(port) });
  const messages: ServerMessage[] = [];
  const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
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
  return { ws, messages, closed, apiKey };
}

/** A client that got its challenge and never answers it. */
async function unauthenticatedClient(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { origin: origin(port) });
  const messages: ServerMessage[] = [];
  const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
  await new Promise<void>((resolve) =>
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      if (message.type === 'challenge') resolve();
      else messages.push(message);
    }),
  );
  return { ws, messages, closed };
}

async function waitFor(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const prsMessages = (client: Client): PullRequestList[] =>
  client.messages.flatMap((message) => (message.type === 'prs' ? [message.prs] : []));

describe('GET PRS_PATH', () => {
  it('serves the path the contract names', () => {
    expect(PRS_PATH).toBe('/api/prs');
    expect(PRS_REFRESH_PATH).toBe('/api/prs/refresh');
  });

  it('returns the latest list as JSON, uncached, with the token or the apiKey, with or without this Origin', async () => {
    const { server, fetch, poller } = await start();
    await fetch.finish(ok([pr(1), pr(2)]));
    const { apiKey, ws } = await authedClient(server.port);
    ws.close();
    for (const credential of [TOKEN, apiKey]) {
      for (const extra of [{}, { origin: origin(server.port) }] as Record<string, string>[]) {
        const res = await request(server.port, PRS_PATH, 'GET', { authorization: `Bearer ${credential}`, ...extra });
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['content-type']).toMatch(/^application\/json/);
        expect(JSON.parse(res.body)).toEqual(poller === 'none' ? undefined : poller.latest());
        expect((await request(server.port, PRS_PATH, 'HEAD', { authorization: `Bearer ${credential}`, ...extra })).status).toBe(200);
      }
    }
  });

  it('has the snapshot’s authorization: 401 with no detail for a missing or wrong credential', async () => {
    const { server } = await start();
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: `Bearer ${TOKEN}x` }, { authorization: TOKEN }] as Record<string, string>[]) {
      const res = await request(server.port, PRS_PATH, 'GET', headers);
      expect(res.status).toBe(401);
      expect(res.body).toBe('');
    }
    expect((await request(server.port, `${PRS_PATH}?token=${TOKEN}`, 'GET')).status).toBe(401);
  });

  it('refuses another Origin with 403, even with the token', async () => {
    const { server } = await start();
    for (const value of ['http://evil.example', 'null', `http://localhost:${server.port}`, `https://127.0.0.1:${server.port}`]) {
      const res = await request(server.port, PRS_PATH, 'GET', { authorization: `Bearer ${TOKEN}`, origin: value });
      expect(res.status, value).toBe(403);
      expect(res.body).toBe('');
    }
  });

  it('refuses another Host with 403, even with the token', async () => {
    const { server } = await start();
    for (const host of [`localhost:${server.port}`, `evil.example:${server.port}`, '127.0.0.1', `127.0.0.1:${server.port + 1}`]) {
      expect((await request(server.port, PRS_PATH, 'GET', { authorization: `Bearer ${TOKEN}`, host })).status, host).toBe(403);
    }
  });

  it("answers the 'off' list without a poller, as with --no-prs", async () => {
    for (const prs of ['none', prsOff()] as const) {
      const { server } = await start({ prs });
      const res = await request(server.port, PRS_PATH, 'GET', { authorization: `Bearer ${TOKEN}` });
      expect(JSON.parse(res.body)).toEqual({ source: { ok: false, reason: 'off', error: PRS_OFF_ERROR }, refreshing: false, prs: [] });
    }
  });

  it('refuses other methods: 403 with the raw token, 404 with the apiKey and this Origin', async () => {
    const { server, fetch } = await start();
    const { apiKey, ws } = await authedClient(server.port);
    ws.close();
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect((await request(server.port, PRS_PATH, method, { authorization: `Bearer ${TOKEN}`, origin: origin(server.port) })).status, method).toBe(403);
      expect((await request(server.port, PRS_PATH, method, { authorization: `Bearer ${apiKey}`, origin: origin(server.port) })).status, method).toBe(404);
    }
    expect(fetch.calls()).toBe(1);
  });
});

describe('POST PRS_REFRESH_PATH', () => {
  /** A server whose first fetch has finished, PRS_REFRESH_MIN_MS ago, with the apiKey. */
  async function ready() {
    const started = await start();
    await started.fetch.finish(ok([pr(1)]));
    started.clock.advance(PRS_REFRESH_MIN_MS);
    const { apiKey, ws } = await authedClient(started.server.port);
    ws.close();
    const asPage = (extra: Record<string, string> = {}) =>
      request(started.server.port, PRS_REFRESH_PATH, 'POST', { authorization: `Bearer ${apiKey}`, origin: origin(started.server.port), ...extra });
    return { ...started, apiKey, asPage };
  }

  it('starts a fetch with the apiKey and this Origin: 200 and { ok: true }, uncached', async () => {
    const { asPage, fetch } = await ready();
    const res = await asPage();
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(fetch.calls()).toBe(2);
  });

  it('is ok while a fetch runs, and starts no other', async () => {
    const { asPage, fetch } = await ready();
    expect((await asPage()).status).toBe(200);
    const again = await asPage();
    expect(again.status).toBe(200);
    expect(JSON.parse(again.body)).toEqual({ ok: true });
    expect(fetch.calls()).toBe(2);
    expect(fetch.running()).toBe(1);
  });

  it(`answers 429 with Retry-After within ${PRS_REFRESH_MIN_MS / 1000} s of the latest fetch's start`, async () => {
    const { asPage, fetch, clock } = await ready();
    expect((await asPage()).status).toBe(200);
    clock.advance(4000);
    await fetch.finish(ok([pr(1)]));
    const res = await asPage();
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('56');
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'Your pull requests were fetched moments ago. Try again in 56 seconds.' });
    expect(fetch.calls()).toBe(2);
    clock.advance(55_500);
    const soon = await asPage();
    expect(soon.headers['retry-after']).toBe('1');
    expect(JSON.parse(soon.body).error).toBe('Your pull requests were fetched moments ago. Try again in 1 second.');
    clock.advance(500);
    expect((await asPage()).status).toBe(200);
    expect(fetch.calls()).toBe(3);
  });

  it('answers 409 when pull requests are off, and runs nothing', async () => {
    for (const prs of ['none', prsOff()] as const) {
      const { server } = await start({ prs });
      const { apiKey, ws } = await authedClient(server.port);
      ws.close();
      const res = await request(server.port, PRS_REFRESH_PATH, 'POST', { authorization: `Bearer ${apiKey}`, origin: origin(server.port) });
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'Pull requests are off: pitwall was started with --no-prs, so it never runs gh.' });
    }
  });

  it('refuses the raw token with 403, even from this Origin, and starts nothing', async () => {
    const { server, fetch } = await ready();
    const res = await request(server.port, PRS_REFRESH_PATH, 'POST', { authorization: `Bearer ${TOKEN}`, origin: origin(server.port) });
    expect(res.status).toBe(403);
    expect(res.body).toBe('');
    expect(fetch.calls()).toBe(1);
  });

  it('refuses the apiKey with no Origin, or a bad one, with 403, and starts nothing', async () => {
    const { server, fetch, apiKey } = await ready();
    const authorization = `Bearer ${apiKey}`;
    expect((await request(server.port, PRS_REFRESH_PATH, 'POST', { authorization })).status).toBe(403);
    for (const value of ['http://evil.example', 'null', `http://localhost:${server.port}`, `https://127.0.0.1:${server.port}`]) {
      expect((await request(server.port, PRS_REFRESH_PATH, 'POST', { authorization, origin: value })).status, value).toBe(403);
    }
    expect(fetch.calls()).toBe(1);
  });

  it('refuses another Host with 403, even with the apiKey and this Origin', async () => {
    const { server, fetch, asPage } = await ready();
    for (const host of [`localhost:${server.port}`, `evil.example:${server.port}`, '127.0.0.1']) {
      expect((await asPage({ host })).status, host).toBe(403);
    }
    expect(fetch.calls()).toBe(1);
  });

  it('refuses no credential, or a wrong one, with 401, and starts nothing', async () => {
    const { server, fetch } = await ready();
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: `Bearer ${TOKEN}x` }] as Record<string, string>[]) {
      expect((await request(server.port, PRS_REFRESH_PATH, 'POST', { ...headers, origin: origin(server.port) })).status).toBe(401);
    }
    expect(fetch.calls()).toBe(1);
  });

  it('refuses a preflight and other methods: OPTIONS 403, GET 404, and starts nothing', async () => {
    const { server, fetch, apiKey } = await ready();
    const preflight = { origin: 'http://evil.example', 'access-control-request-method': 'POST' };
    expect((await request(server.port, PRS_REFRESH_PATH, 'OPTIONS', preflight)).status).toBe(403);
    expect((await request(server.port, PRS_REFRESH_PATH, 'OPTIONS', { authorization: `Bearer ${apiKey}`, origin: origin(server.port) })).status).toBe(404);
    expect((await request(server.port, PRS_REFRESH_PATH, 'GET', { authorization: `Bearer ${TOKEN}` })).status).toBe(404);
    expect((await request(server.port, PRS_REFRESH_PATH, 'GET', { authorization: `Bearer ${apiKey}` })).status).toBe(404);
    expect(fetch.calls()).toBe(1);
  });

  it('sends no CORS headers', async () => {
    const { asPage } = await ready();
    const res = await asPage();
    expect(Object.keys(res.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
  });
});

describe("the 'prs' message", () => {
  it('comes right after the first snapshot, with the latest list', async () => {
    const { server, poller } = await start();
    const client = await authedClient(server.port);
    await waitFor(() => client.messages.length >= 2);
    expect(client.messages.map((message) => message.type)).toEqual(['snapshot', 'prs']);
    expect(client.messages[1]).toEqual({ type: 'prs', prs: poller === 'none' ? undefined : poller.latest() });
    // The server started the poller once listening: its first fetch is running.
    expect(prsMessages(client)[0]).toEqual({ source: { ok: true }, refreshing: true, prs: [] });
  });

  it("is the 'off' list once, without a poller", async () => {
    const { server } = await start({ prs: 'none' });
    const client = await authedClient(server.port);
    await waitFor(() => client.messages.length >= 2);
    expect(client.messages.map((message) => message.type)).toEqual(['snapshot', 'prs']);
    expect(prsMessages(client)).toEqual([{ source: { ok: false, reason: 'off', error: PRS_OFF_ERROR }, refreshing: false, prs: [] }]);
  });

  it('waits for the first snapshot, then comes right after it', async () => {
    const indexer = fakeIndexer(null);
    const { server, fetch } = await start({ indexer });
    const client = await authedClient(server.port);
    // A list that changes before the first snapshot isn't sent on its own.
    await fetch.finish(ok([pr(1)]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.messages).toEqual([]);
    indexer.push(snapshot());
    await waitFor(() => client.messages.length >= 2);
    expect(client.messages.map((message) => message.type)).toEqual(['snapshot', 'prs']);
    expect(prsMessages(client)[0]?.prs).toEqual([pr(1)]);
  });

  it('goes to every authenticated client on each change, and to no client still in the handshake', async () => {
    const { server, fetch, clock, poller } = await start();
    const a = await authedClient(server.port);
    const b = await authedClient(server.port);
    const pending = await unauthenticatedClient(server.port);
    await waitFor(() => a.messages.length >= 2 && b.messages.length >= 2);

    await fetch.finish(ok([pr(1), pr(2)]));
    await waitFor(() => prsMessages(a).length >= 2 && prsMessages(b).length >= 2);
    expect(prsMessages(a).at(-1)).toEqual(poller === 'none' ? undefined : poller.latest());
    expect(prsMessages(a).at(-1)).toMatchObject({ refreshing: false, source: { ok: true } });

    // The next poll: refreshing on, then the new list.
    clock.advance(PRS_POLL_INTERVAL_MS);
    await waitFor(() => prsMessages(a).length >= 3 && prsMessages(b).length >= 3);
    expect(prsMessages(b).at(-1)).toMatchObject({ refreshing: true });
    await fetch.finish(fetchFailed('gh-auth', "gh isn't logged in to github.com. Run gh auth login, then Refresh."));
    await waitFor(() => prsMessages(a).length >= 4 && prsMessages(b).length >= 4);
    expect(prsMessages(a).at(-1)).toMatchObject({ refreshing: false, source: { ok: false, reason: 'gh-auth' }, prs: [pr(1), pr(2)] });
    expect(prsMessages(a)).toEqual(prsMessages(b));

    expect(pending.messages).toEqual([]);
  });

  it('a refresh shows as refreshing on every client before the POST answers', async () => {
    const { server, fetch, clock } = await start();
    await fetch.finish(ok([]));
    clock.advance(PRS_REFRESH_MIN_MS);
    const client = await authedClient(server.port);
    await waitFor(() => client.messages.length >= 2);
    const res = await request(server.port, PRS_REFRESH_PATH, 'POST', { authorization: `Bearer ${client.apiKey}`, origin: origin(server.port) });
    expect(res.status).toBe(200);
    await waitFor(() => prsMessages(client).length >= 2);
    expect(prsMessages(client).at(-1)).toMatchObject({ refreshing: true });
  });

  it("leaves the snapshot's messages as they were: a heartbeat for an unchanged poll, between the PR lists", async () => {
    const indexer = fakeIndexer();
    const { server, fetch } = await start({ indexer });
    const client = await authedClient(server.port);
    await waitFor(() => client.messages.length >= 2);
    indexer.push(snapshot('2026-10-28T00:00:05.000Z'));
    await fetch.finish(ok([pr(1)]));
    indexer.push(snapshot('2026-10-28T00:00:10.000Z'));
    await waitFor(() => client.messages.length >= 5);
    expect(client.messages.map((message) => message.type)).toEqual(['snapshot', 'prs', 'heartbeat', 'prs', 'heartbeat']);
  });

  it('stops being sent to a client that closed, and the server stops the poller on close()', async () => {
    const { server, fetch, clock, poller } = await start();
    const client = await authedClient(server.port);
    await waitFor(() => client.messages.length >= 2);
    client.ws.close();
    await client.closed;
    await fetch.finish(ok([pr(1)]));
    expect(clock.pending()).toEqual([PRS_POLL_INTERVAL_MS]);

    await server.close();
    expect(clock.pending()).toEqual([]);
    clock.advance(PRS_POLL_INTERVAL_MS * 2);
    expect(fetch.calls()).toBe(1);
    expect(poller === 'none' ? undefined : poller.refresh()).toEqual({ kind: 'stopped' });
  });

  it('never carries the token or the apiKey', async () => {
    const { server, fetch } = await start();
    const client = await authedClient(server.port);
    await fetch.finish(ok([pr(1)]));
    await waitFor(() => prsMessages(client).length >= 2);
    const sent = JSON.stringify(client.messages);
    expect(sent).not.toContain(TOKEN);
    expect(sent).not.toContain(client.apiKey);
  });
});
