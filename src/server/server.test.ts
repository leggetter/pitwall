import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect, createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createIndexer, type Indexer } from '../index/index.js';
import {
  lastMessagePath,
  PROTOCOL_VERSION,
  SNAPSHOT_PATH,
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
  type IndexSnapshot,
  type LastMessage,
  type ServerMessage,
} from '../shared/protocol.js';
import { DEFAULT_PORT, PortInUseError, startServer, type RunningServer } from './index.js';
import { securityHeaders } from './security.js';
import { BUILDING_SCRIPT, BUILDING_SCRIPT_PATH } from './static.js';
import { startServerWithInternals, type ServerInternals } from './server.js';
import { DEFAULT_AUTH_TIMEOUT_MS } from './websocket.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';

// ---------------------------------------------------------------- fixtures

interface FakeIndexer extends Indexer {
  push(snapshot: IndexSnapshot): void;
  listenerCount(): number;
  /** What lastMessage() answers, by session id. */
  messages: Map<string, LastMessage>;
}

function fakeIndexer(initial?: IndexSnapshot): FakeIndexer {
  let latest = initial;
  const listeners = new Set<(snapshot: IndexSnapshot) => void>();
  const messages = new Map<string, LastMessage>();
  return {
    latest: () => latest,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    lastMessage: vi.fn((sessionId: string) => messages.get(sessionId)),
    messages,
    stop: vi.fn(),
    push(snapshot) {
      latest = snapshot;
      for (const listener of [...listeners]) listener(snapshot);
    },
    listenerCount: () => listeners.size,
  };
}

function snapshot(generatedAt: string, overrides: Partial<IndexSnapshot> = {}): IndexSnapshot {
  return { generatedAt, roots: ['/tmp/pitwall-test-root'], groups: [], source: { ok: true }, ...overrides };
}

/** A snapshot whose content differs from snapshot()'s: one group with one session. */
function withSession(generatedAt: string, name = 'pitwall-test-a', sessionId = '99999999-9999-4999-8999-999999999999'): IndexSnapshot {
  return snapshot(generatedAt, {
    groups: [
      {
        key: '/tmp/pitwall-test-root/repo',
        label: 'repo',
        kind: 'git',
        root: '/tmp/pitwall-test-root',
        sessions: [
          {
            sessionId,
            name,
            kind: 'interactive',
            cwd: '/tmp/pitwall-test-root/repo',
            alive: true,
            startedAt: '2026-10-16T00:00:00.000Z',
            stale: false,
            transcript: 'missing',
          },
        ],
      },
    ],
  });
}

const heartbeat = (s: IndexSnapshot): ServerMessage => ({ type: 'heartbeat', generatedAt: s.generatedAt, source: s.source });

let tmp: string;
let webRoot: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
  webRoot = join(tmp, 'web');
  await mkdir(join(webRoot, 'assets'), { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>pitwall</title>');
  await writeFile(join(webRoot, 'assets', 'app.js'), 'console.log("pitwall");');
  await writeFile(join(webRoot, '.hidden'), 'hidden');
  await writeFile(join(tmp, 'secret.txt'), 'SECRET');
  await symlink(join(tmp, 'secret.txt'), join(webRoot, 'escape.txt'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const running: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function start(
  indexer: Indexer = fakeIndexer(),
  overrides: { webRoot?: string; port?: number } = {},
  internals: ServerInternals = {},
): Promise<RunningServer> {
  const server = await startServerWithInternals(
    { indexer, token: TOKEN, webRoot: overrides.webRoot ?? webRoot, port: overrides.port ?? 0 },
    internals,
  );
  running.push(server);
  return server;
}

// ---------------------------------------------------------------- clients

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A real HTTP request. Pass `host` in headers to override the Host header. */
function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<HttpResult> {
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

/** Writes bytes as given, for request targets an HTTP client would normalise. */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (response += chunk));
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
    socket.write(text);
  });
}

function statusOf(response: string): number {
  return Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1] ?? 0);
}

const origin = (port: number) => `http://127.0.0.1:${port}`;
const bearer = { authorization: `Bearer ${TOKEN}` };

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
  closed: Promise<{ code: number }>;
  nextMessage(): Promise<ServerMessage>;
}

function connectWs(port: number, options: { origin?: string; headers?: Record<string, string> } = {}): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    headers: options.headers ?? {},
  });
  const messages: ServerMessage[] = [];
  const waiters: ((message: ServerMessage) => void)[] = [];
  ws.on('message', (data) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  const closed = new Promise<{ code: number }>((resolve) => ws.on('close', (code) => resolve({ code })));
  return {
    ws,
    messages,
    closed,
    nextMessage: () => {
      const queued = messages.shift();
      return queued ? Promise.resolve(queued) : new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/** Resolves with the HTTP status of a refused upgrade. */
function upgradeRefusal(client: Client): Promise<number> {
  return new Promise((resolve, reject) => {
    client.ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    client.ws.on('open', () => reject(new Error('upgrade was accepted')));
    client.ws.on('error', () => {});
  });
}

/**
 * The proof for a nonce, computed here with node:crypto rather than with the
 * server's own helper, so the test pins the contract: base64url(HMAC-SHA256(
 * key = token as UTF-8, message = nonce as UTF-8)).
 */
function proofFor(nonce: string, token = TOKEN): string {
  return createHmac('sha256', Buffer.from(token, 'utf8')).update(nonce, 'utf8').digest('base64url');
}

/** Opens a socket and waits for its challenge. */
async function challenged(port: number): Promise<{ client: Client; nonce: string }> {
  const client = connectWs(port, { origin: origin(port) });
  const challenge = await client.nextMessage();
  if (challenge.type !== 'challenge') throw new Error(`expected a challenge, got ${challenge.type}`);
  return { client, nonce: challenge.nonce };
}

/** Completes the handshake. The challenge and 'authenticated' are consumed, so nextMessage() gives what follows. */
async function authedClient(port: number): Promise<Client & { apiKey: string; nonce: string; proof: string }> {
  const { client, nonce } = await challenged(port);
  const proof = proofFor(nonce);
  client.ws.send(JSON.stringify({ type: 'auth', proof }));
  const reply = await client.nextMessage();
  if (reply.type !== 'authenticated') throw new Error(`expected authenticated, got ${reply.type}`);
  return Object.assign(client, { apiKey: reply.apiKey, nonce, proof });
}

/** The apiKey a client gets from this server, for HTTP tests. */
async function apiKeyOf(port: number): Promise<string> {
  const client = await authedClient(port);
  client.ws.close();
  return client.apiKey;
}

async function waitFor(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------- tests

describe('startServer', () => {
  it('listens on 127.0.0.1 and reports the real port', async () => {
    const server = await start();
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
  });

  it('defaults to port 4517', () => {
    expect(DEFAULT_PORT).toBe(4517);
  });

  it('refuses a short token', async () => {
    await expect(startServer({ indexer: fakeIndexer(), token: 'short', webRoot, port: 0 })).rejects.toThrow(
      /at least 32 characters/,
    );
  });

  describe('ports', () => {
    async function occupy(): Promise<{ port: number; close(): Promise<void> }> {
      const blocker = createNetServer();
      blocker.listen(0, '127.0.0.1');
      await once(blocker, 'listening');
      return {
        port: (blocker.address() as AddressInfo).port,
        close: () => new Promise((resolve) => blocker.close(() => resolve())),
      };
    }

    it('falls back to a free port when the default port is busy', async () => {
      const blocker = await occupy();
      try {
        const server = await startServerWithInternals(
          { indexer: fakeIndexer(), token: TOKEN, webRoot },
          { defaultPort: blocker.port },
        );
        running.push(server);
        expect(server.port).not.toBe(blocker.port);
        expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
        const res = await get(server.port, '/');
        expect(res.status).toBe(200);
        // The CSP names the port actually in use, not the busy one.
        expect(res.headers['content-security-policy']).toContain(`ws://127.0.0.1:${server.port};`);
        expect(res.headers['content-security-policy']).not.toContain(String(blocker.port));
      } finally {
        await blocker.close();
      }
    });

    it('fails with a clear error when an explicit port is busy', async () => {
      const blocker = await occupy();
      try {
        const attempt = startServer({ indexer: fakeIndexer(), token: TOKEN, webRoot, port: blocker.port });
        await expect(attempt).rejects.toBeInstanceOf(PortInUseError);
        await expect(attempt).rejects.toThrow(`127.0.0.1:${blocker.port} is already in use`);
      } finally {
        await blocker.close();
      }
    });
  });

  describe('Host', () => {
    it.each([
      ['another name', 'evil.example'],
      ['another name on the right port', 'evil.example:PORT'],
      ['a rebinding-style name', '127.0.0.1.evil.example:PORT'],
      ['no port', '127.0.0.1'],
      ['the wrong port', '127.0.0.1:1'],
      ['an IPv6 loopback', '[::1]:PORT'],
      ['localhost', 'localhost:PORT'],
      ['upper case', 'LOCALHOST:PORT'],
    ])('rejects %s with 403 and no detail', async (_name, host) => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const headers = { host: host.replace('PORT', String(server.port)) };
      for (const path of ['/', '/assets/app.js', SNAPSHOT_PATH]) {
        const res = await get(server.port, path, { ...headers, ...bearer });
        expect(res.status).toBe(403);
        expect(res.body).toBe('');
      }
    });

    it('rejects a missing Host', async () => {
      const server = await start();
      const res = await raw(server.port, 'GET / HTTP/1.0\r\n\r\n');
      expect(statusOf(res)).toBe(403);
    });

    it('accepts 127.0.0.1:<port>', async () => {
      const server = await start();
      expect((await get(server.port, '/', { host: `127.0.0.1:${server.port}` })).status).toBe(200);
    });

    it('rejects an absolute-form request target', async () => {
      const server = await start();
      const res = await raw(
        server.port,
        `GET http://evil.example/ HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
      );
      expect(statusOf(res)).toBe(400);
    });

    it('rejects a WebSocket upgrade with the wrong Host', async () => {
      const server = await start();
      const client = connectWs(server.port, { origin: origin(server.port), headers: { host: 'evil.example' } });
      expect(await upgradeRefusal(client)).toBe(403);
    });
  });

  describe('Origin', () => {
    it.each([
      ['another site', 'http://evil.example'],
      ['null', 'null'],
      ['https on the right host', 'https://127.0.0.1:PORT'],
      ['the wrong port', 'http://127.0.0.1:1'],
      ['a trailing slash', 'http://127.0.0.1:PORT/'],
      ['localhost', 'http://localhost:PORT'],
      ['an IPv6 loopback', 'http://[::1]:PORT'],
    ])('rejects an API request from %s with 403, even with the token', async (_name, value) => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const res = await get(server.port, SNAPSHOT_PATH, { origin: value.replace('PORT', String(server.port)), ...bearer });
      expect(res.status).toBe(403);
      expect(res.body).toBe('');
    });

    it('allows an API request from this origin, or with no Origin, with the token', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      expect((await get(server.port, SNAPSHOT_PATH, { origin: origin(server.port), ...bearer })).status).toBe(200);
      expect((await get(server.port, SNAPSHOT_PATH, bearer)).status).toBe(200);
    });

    it('rejects an API request with no Origin and no token', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      expect((await get(server.port, SNAPSHOT_PATH)).status).toBe(401);
    });

    it('rejects a WebSocket upgrade with no Origin', async () => {
      const server = await start();
      expect(await upgradeRefusal(connectWs(server.port))).toBe(403);
    });

    it('rejects a WebSocket upgrade from another origin', async () => {
      const server = await start();
      expect(await upgradeRefusal(connectWs(server.port, { origin: 'http://evil.example' }))).toBe(403);
    });

    it('rejects a WebSocket upgrade from http://localhost:<port>, or with Host localhost:<port>', async () => {
      const server = await start();
      const localhost = `localhost:${server.port}`;
      expect(await upgradeRefusal(connectWs(server.port, { origin: `http://${localhost}` }))).toBe(403);
      expect(
        await upgradeRefusal(connectWs(server.port, { origin: `http://${localhost}`, headers: { host: localhost } })),
      ).toBe(403);
    });

    it('rejects an upgrade on any path but the WebSocket path', async () => {
      const server = await start();
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/snapshot`, { origin: origin(server.port) });
      const status = await new Promise<number>((resolve) => {
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('error', () => {});
      });
      expect(status).toBe(404);
    });
  });

  describe('CORS', () => {
    it('never sends CORS headers', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const evil = { origin: 'http://evil.example' };
      const responses = await Promise.all([
        get(server.port, '/', evil),
        get(server.port, '/assets/app.js', evil),
        get(server.port, '/missing', evil),
        get(server.port, SNAPSHOT_PATH, evil),
        get(server.port, SNAPSHOT_PATH, { ...evil, ...bearer }),
        get(server.port, SNAPSHOT_PATH, { origin: origin(server.port), ...bearer }),
        get(server.port, SNAPSHOT_PATH, { ...evil, 'access-control-request-method': 'GET' }, 'OPTIONS'),
        get(server.port, SNAPSHOT_PATH, { ...bearer, 'access-control-request-method': 'GET' }, 'OPTIONS'),
        get(server.port, '/', { ...evil, 'access-control-request-method': 'POST' }, 'OPTIONS'),
        get(server.port, '/', { host: 'evil.example' }),
      ]);
      for (const res of responses) {
        expect(Object.keys(res.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
      }
    });
  });

  describe('the snapshot API', () => {
    it('returns 401 with no detail for a missing or wrong token', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      for (const authorization of [
        undefined,
        '',
        'Bearer',
        'Bearer wrong',
        `Bearer ${TOKEN}x`,
        `Bearer ${TOKEN.slice(0, -1)}`,
        `Basic ${TOKEN}`,
        TOKEN,
      ]) {
        const res = await get(server.port, SNAPSHOT_PATH, authorization === undefined ? {} : { authorization });
        expect(res.status, String(authorization)).toBe(401);
        expect(res.body).toBe('');
      }
    });

    it('does not accept the token in the query string', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      expect((await get(server.port, `${SNAPSHOT_PATH}?token=${TOKEN}`)).status).toBe(401);
    });

    it('returns 503 before the first snapshot', async () => {
      const server = await start(fakeIndexer());
      const res = await get(server.port, SNAPSHOT_PATH, bearer);
      expect(res.status).toBe(503);
    });

    it('returns the latest snapshot as JSON, uncached', async () => {
      const indexer = fakeIndexer(snapshot('2026-10-16T00:00:00.000Z'));
      const server = await start(indexer);
      const res = await get(server.port, SNAPSHOT_PATH, bearer);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(JSON.parse(res.body)).toEqual(indexer.latest());
    });

    it('requires the token on unknown API paths, then 404s', async () => {
      const server = await start();
      expect((await get(server.port, '/api/other')).status).toBe(401);
      expect((await get(server.port, '/api/other', bearer)).status).toBe(404);
    });
  });

  describe('API credentials', () => {
    /** A server with a state-changing test route, standing in for W10-W12's input routes. */
    async function withInputRoute(): Promise<{ server: RunningServer; apiKey: string; hits: string[] }> {
      const hits: string[] = [];
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')), {}, {
        routes: (app) => {
          app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/api/test-input', (c) => {
            hits.push(c.req.method);
            return c.json({ ok: true });
          });
        },
      });
      return { server, apiKey: await apiKeyOf(server.port), hits };
    }

    it('accepts the apiKey and the raw token for GET and HEAD', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const apiKey = await apiKeyOf(server.port);
      for (const credential of [apiKey, TOKEN]) {
        for (const headers of [{}, { origin: origin(server.port) }] as Record<string, string>[]) {
          const authorization = `Bearer ${credential}`;
          expect((await get(server.port, SNAPSHOT_PATH, { ...headers, authorization })).status).toBe(200);
          expect((await get(server.port, SNAPSHOT_PATH, { ...headers, authorization }, 'HEAD')).status).toBe(200);
        }
      }
    });

    it("refuses another server's apiKey", async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const other = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const otherKey = await apiKeyOf(other.port);
      expect((await get(server.port, SNAPSHOT_PATH, { authorization: `Bearer ${otherKey}` })).status).toBe(401);
    });

    it('lets a state-changing request through with the apiKey and this Origin', async () => {
      const { server, apiKey, hits } = await withInputRoute();
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await get(server.port, '/api/test-input', { authorization: `Bearer ${apiKey}`, origin: origin(server.port) }, method);
        expect(res.status, method).toBe(200);
      }
      expect(hits).toEqual(['POST', 'PUT', 'PATCH', 'DELETE']);
    });

    it('refuses a state-changing request with the raw token, even from this Origin', async () => {
      const { server, hits } = await withInputRoute();
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await get(server.port, '/api/test-input', { authorization: `Bearer ${TOKEN}`, origin: origin(server.port) }, method);
        expect(res.status, method).toBe(403);
        expect(res.body).toBe('');
      }
      expect(hits).toEqual([]);
    });

    it('refuses a state-changing request with the apiKey but no Origin, or a bad one', async () => {
      const { server, apiKey, hits } = await withInputRoute();
      const authorization = `Bearer ${apiKey}`;
      expect((await get(server.port, '/api/test-input', { authorization }, 'POST')).status).toBe(403);
      for (const value of ['http://evil.example', 'null', `http://localhost:${server.port}`, `https://127.0.0.1:${server.port}`]) {
        expect((await get(server.port, '/api/test-input', { authorization, origin: value }, 'POST')).status, value).toBe(403);
      }
      expect(hits).toEqual([]);
    });

    it('refuses a state-changing request with no credential, or a wrong one, with 401', async () => {
      const { server, hits } = await withInputRoute();
      for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: `Bearer ${TOKEN}x` }] as Record<string, string>[]) {
        expect((await get(server.port, '/api/test-input', { ...headers, origin: origin(server.port) }, 'POST')).status).toBe(401);
      }
      expect(hits).toEqual([]);
    });

    it('treats OPTIONS as state-changing too, so a preflight gets nothing', async () => {
      const { server, apiKey } = await withInputRoute();
      const preflight = { origin: 'http://evil.example', 'access-control-request-method': 'POST' };
      expect((await get(server.port, '/api/test-input', preflight, 'OPTIONS')).status).toBe(403);
      expect((await get(server.port, '/api/test-input', { authorization: `Bearer ${TOKEN}` }, 'OPTIONS')).status).toBe(403);
      expect((await get(server.port, '/api/test-input', { authorization: `Bearer ${apiKey}` }, 'OPTIONS')).status).toBe(403);
    });
  });

  describe('the last-message API', () => {
    const SID = '77777777-7777-4777-8777-777777777777';
    const message: LastMessage = { sessionId: SID, text: `Full reply.\n\n${'More detail. '.repeat(100)}`, truncated: false, at: '2026-10-16T00:00:00.000Z' };

    /** SID is in the snapshot, as resolveSession() requires, and the index has its message. */
    function withMessage(): FakeIndexer {
      const indexer = fakeIndexer(withSession('2026-10-16T00:00:00.000Z', 'pitwall-test-reply', SID));
      indexer.messages.set(SID, message);
      return indexer;
    }

    it('serves the path the contract names', () => {
      expect(lastMessagePath(SID)).toBe(`/api/sessions/${SID}/last-message`);
    });

    it('returns 401 with no detail for a missing or wrong token, without asking the index', async () => {
      const indexer = withMessage();
      const server = await start(indexer);
      const attempts: Record<string, string>[] = [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }];
      for (const headers of attempts) {
        const res = await get(server.port, lastMessagePath(SID), headers);
        expect(res.status).toBe(401);
        expect(res.body).toBe('');
      }
      expect(indexer.lastMessage).not.toHaveBeenCalled();
    });

    it('returns 403 for another Origin, even with the token', async () => {
      const indexer = withMessage();
      const server = await start(indexer);
      for (const value of ['http://evil.example', 'null', `http://localhost:${server.port}`]) {
        const res = await get(server.port, lastMessagePath(SID), { origin: value, ...bearer });
        expect(res.status).toBe(403);
        expect(res.body).toBe('');
      }
      expect(indexer.lastMessage).not.toHaveBeenCalled();
    });

    it('returns 403 for another Host', async () => {
      const server = await start(withMessage());
      expect((await get(server.port, lastMessagePath(SID), { host: 'evil.example', ...bearer })).status).toBe(403);
    });

    it("returns a known session's full reply as JSON, uncached", async () => {
      const server = await start(withMessage());
      for (const headers of [bearer, { origin: origin(server.port), ...bearer }]) {
        const res = await get(server.port, lastMessagePath(SID), headers);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^application\/json/);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(JSON.parse(res.body)).toEqual(message);
      }
    });

    it('returns 404, uncached, for a session the index has no message for', async () => {
      const server = await start(withMessage());
      const res = await get(server.port, lastMessagePath('88888888-8888-4888-8888-888888888888'), bearer);
      expect(res.status).toBe(404);
      expect(res.body).toBe('');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('returns 404 for a session missing from the snapshot, even when the index would answer, without asking it', async () => {
      // The guard doesn't rely on the index to refuse: it checks the snapshot itself.
      const indexer = fakeIndexer(snapshot('2026-10-16T00:00:00.000Z'));
      indexer.messages.set(SID, message);
      const server = await start(indexer);
      const res = await get(server.port, lastMessagePath(SID), bearer);
      expect(res.status).toBe(404);
      expect(indexer.lastMessage).not.toHaveBeenCalled();
    });

    it('returns 503 before the first snapshot', async () => {
      const indexer = fakeIndexer();
      indexer.messages.set(SID, message);
      const server = await start(indexer);
      expect((await get(server.port, lastMessagePath(SID), bearer)).status).toBe(503);
      expect(indexer.lastMessage).not.toHaveBeenCalled();
    });

    it('returns 404 for a session outside the roots, which the index never serves', async () => {
      const inside = '77777777-7777-4777-8777-000000000001';
      const outside = '77777777-7777-4777-8777-000000000002';
      const row = (sessionId: string, cwd: string) => ({
        sessionId,
        name: `pitwall-test-${sessionId.slice(-1)}`,
        kind: 'interactive' as const,
        cwd,
        startedAt: '2026-10-16T00:00:00.000Z',
      });
      const indexer = createIndexer(
        { roots: ['/work'], intervalMs: 60_000 },
        {
          agents: { list: async () => ({ ok: true, rows: [row(inside, '/work/repo'), row(outside, '/elsewhere/repo')] }) },
          groups: { resolve: async (cwd) => ({ key: cwd, kind: 'directory' }), prune() {} },
          // A reader that would answer for either session, as it may hold both.
          transcripts: {
            read: async () => ({ transcript: 'ok' }),
            lastMessage: (sessionId) => ({ sessionId, text: 'a reply', truncated: false }),
            retain() {},
          },
          realpath: async (p) => p,
          now: () => Date.parse('2026-10-16T00:00:00.000Z'),
          home: '/home/someone',
          concurrency: 2,
        },
      );
      try {
        await new Promise<IndexSnapshot>((resolve) => indexer.subscribe(resolve));
        const server = await start(indexer);
        expect((await get(server.port, lastMessagePath(inside), bearer)).status).toBe(200);
        const res = await get(server.port, lastMessagePath(outside), bearer);
        expect(res.status).toBe(404);
        expect(res.body).toBe('');
      } finally {
        indexer.stop();
      }
    });

    it.each([
      ['an encoded ..', '/api/sessions/%2e%2e/last-message'],
      ['an encoded ../..', '/api/sessions/..%2F..%2Fsecret.txt/last-message'],
      ['an encoded / in the id', '/api/sessions/a%2Fb/last-message'],
      ['an encoded backslash', '/api/sessions/..%5Csecret.txt/last-message'],
      ['an encoded NUL', '/api/sessions/a%00b/last-message'],
      ['a double-encoded ..', '/api/sessions/%252e%252e/last-message'],
      ['a leading dot', '/api/sessions/.hidden/last-message'],
      ['a bad escape', '/api/sessions/%E0%A4%A/last-message'],
      ['a plain ..', '/api/sessions/../last-message'],
    ])('answers %s with 400 or 404, and never asks the index for an unsafe id', async (_name, path) => {
      const indexer = withMessage();
      const server = await start(indexer);
      const res = await raw(
        server.port,
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`,
      );
      expect([400, 404]).toContain(statusOf(res));
      expect(res).not.toContain('SECRET');
      for (const [id] of vi.mocked(indexer.lastMessage).mock.calls) {
        expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      }
    });

    it('refuses other methods: 403 with the raw token, 404 with the apiKey and this Origin', async () => {
      const server = await start(withMessage());
      expect((await get(server.port, lastMessagePath(SID), bearer, 'POST')).status).toBe(403);
      const apiKey = await apiKeyOf(server.port);
      const allowed = { authorization: `Bearer ${apiKey}`, origin: origin(server.port) };
      expect((await get(server.port, lastMessagePath(SID), allowed, 'POST')).status).toBe(404);
    });

    it('serves the reply with the apiKey too', async () => {
      const server = await start(withMessage());
      const apiKey = await apiKeyOf(server.port);
      const res = await get(server.port, lastMessagePath(SID), { authorization: `Bearer ${apiKey}`, origin: origin(server.port) });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual(message);
    });
  });

  describe('the WebSocket handshake', () => {
    it('opens with a challenge: protocol version 2 and a fresh 32-byte base64url nonce', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const client = connectWs(server.port, { origin: origin(server.port) });
      const challenge = await client.nextMessage();
      expect(challenge).toEqual({ type: 'challenge', version: PROTOCOL_VERSION, nonce: expect.any(String) });
      expect(PROTOCOL_VERSION).toBe(2);
      const { nonce } = challenge as Extract<ServerMessage, { type: 'challenge' }>;
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(nonce, 'base64url')).toHaveLength(32);
    });

    it('answers a valid proof with authenticated and the apiKey, then the snapshot', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const { client, nonce } = await challenged(server.port);
      client.ws.send(JSON.stringify({ type: 'auth', proof: proofFor(nonce) }));

      const authenticated = await client.nextMessage();
      expect(authenticated).toEqual({ type: 'authenticated', apiKey: expect.any(String) });
      const { apiKey } = authenticated as Extract<ServerMessage, { type: 'authenticated' }>;
      expect(apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(apiKey).not.toBe(TOKEN);
      expect(await client.nextMessage()).toEqual({ type: 'snapshot', snapshot: snapshot('2026-10-16T00:00:00.000Z') });
    });

    it.each([
      ['a proof for another nonce', (nonce: string) => ({ type: 'auth', proof: proofFor(`${nonce}x`) })],
      ['a proof made with another token', (nonce: string) => ({ type: 'auth', proof: proofFor(nonce, `${TOKEN}x`) })],
      ['the nonce itself', (nonce: string) => ({ type: 'auth', proof: nonce })],
      ['an empty proof', () => ({ type: 'auth', proof: '' })],
      ['a non-string proof', () => ({ type: 'auth', proof: 42 })],
      ['no proof', () => ({ type: 'auth' })],
      ["M1's raw token", () => ({ type: 'auth', token: TOKEN })],
      ['a valid proof that also carries the token', (nonce: string) => ({ type: 'auth', proof: proofFor(nonce), token: TOKEN })],
      ['a valid proof with a garbage version', (nonce: string) => ({ type: 'auth', proof: proofFor(nonce), version: 'garbage' })],
      ['a valid proof with version 1', (nonce: string) => ({ type: 'auth', proof: proofFor(nonce), version: 1 })],
      ['a valid proof with the wrong type', (nonce: string) => ({ type: 'hello', proof: proofFor(nonce) })],
      ['JSON null', () => null],
      ['a JSON array', (nonce: string) => ['auth', proofFor(nonce)]],
    ])('closes with 4401 for %s, and never authenticates', async (_name, build) => {
      const indexer = fakeIndexer(snapshot('2026-10-16T00:00:00.000Z'));
      const server = await start(indexer);
      const { client, nonce } = await challenged(server.port);
      client.ws.send(JSON.stringify(build(nonce)));
      expect((await client.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(client.messages).toEqual([]);
      expect(indexer.listenerCount()).toBe(0);
    });

    it('closes with 4401 for a message that is not JSON', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const { client } = await challenged(server.port);
      client.ws.send('hello');
      expect((await client.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(client.messages).toEqual([]);
    });

    it('closes with 4401 for a binary frame, even one holding a valid proof', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const { client, nonce } = await challenged(server.port);
      client.ws.send(Buffer.from(JSON.stringify({ type: 'auth', proof: proofFor(nonce) })));
      expect((await client.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(client.messages).toEqual([]);
    });

    it('allows one attempt: a wrong proof, then the right one, still closes with 4401', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const { client, nonce } = await challenged(server.port);
      client.ws.send(JSON.stringify({ type: 'auth', proof: proofFor('not-the-nonce') }));
      client.ws.send(JSON.stringify({ type: 'auth', proof: proofFor(nonce) }));
      expect((await client.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(client.messages).toEqual([]);
    });

    it('refuses a captured proof replayed on a new connection', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const first = await authedClient(server.port);
      expect((await first.nextMessage()).type).toBe('snapshot');

      // Whoever saw the first connection's proof replays it on a second.
      const { client: second, nonce } = await challenged(server.port);
      expect(nonce).not.toBe(first.nonce);
      second.ws.send(JSON.stringify({ type: 'auth', proof: first.proof }));
      expect((await second.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(second.messages).toEqual([]);
    });

    it('never reuses a nonce across 1,000 connections', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const nonces = new Set<string>();
      for (let batch = 0; batch < 20; batch++) {
        const clients = await Promise.all(Array.from({ length: 50 }, () => challenged(server.port)));
        for (const { client, nonce } of clients) {
          nonces.add(nonce);
          client.ws.terminate();
        }
      }
      expect(nonces.size).toBe(1000);
    }, 30_000);

    it('gives every client of one server the same apiKey, and another server a different one', async () => {
      const a = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const b = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const [a1, a2, b1] = await Promise.all([apiKeyOf(a.port), apiKeyOf(a.port), apiKeyOf(b.port)]);
      expect(a1).toBe(a2);
      expect(b1).not.toBe(a1);
    });

    it('never sends the token, and ignores whatever an authenticated client sends', async () => {
      const indexer = fakeIndexer(snapshot('2026-10-16T00:00:00.000Z'));
      const server = await start(indexer);
      const client = await authedClient(server.port);
      expect((await client.nextMessage()).type).toBe('snapshot');

      client.ws.send(JSON.stringify({ type: 'auth', proof: client.proof }));
      client.ws.send('not json');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
      expect(client.messages).toEqual([]);

      indexer.push(snapshot('2026-10-16T00:00:05.000Z'));
      expect((await client.nextMessage()).type).toBe('heartbeat');
    });

    it('waits 5 seconds for the proof by default', () => {
      expect(DEFAULT_AUTH_TIMEOUT_MS).toBe(5000);
    });

    it('closes with 4401 when no proof arrives in time', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')), {}, { authTimeoutMs: 50 });
      const started = Date.now();
      const { client } = await challenged(server.port);
      expect((await client.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(Date.now() - started).toBeGreaterThanOrEqual(40);
      expect(client.messages).toEqual([]);
    });

    it('closes with 4401 when a valid proof arrives too late', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')), {}, { authTimeoutMs: 50 });
      const { client, nonce } = await challenged(server.port);
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify({ type: 'auth', proof: proofFor(nonce) }));
      expect((await client.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(client.messages).toEqual([]);
    });
  });

  describe('the WebSocket', () => {

    it('stays open past the timeout once authenticated', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')), {}, { authTimeoutMs: 50 });
      const client = await authedClient(server.port);
      await client.nextMessage();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
    });

    it('closes the connection on a frame over 1 KB', async () => {
      const server = await start(fakeIndexer());
      const client = connectWs(server.port, { origin: origin(server.port) });
      await once(client.ws, 'open');
      client.ws.send('x'.repeat(1025));
      expect((await client.closed).code).toBe(1009);
    });

    it('sends the latest snapshot after auth, then a heartbeat for an unchanged poll and a snapshot for a changed one', async () => {
      const indexer = fakeIndexer(snapshot('2026-10-16T00:00:00.000Z'));
      const server = await start(indexer);
      const client = await authedClient(server.port);

      expect(await client.nextMessage()).toEqual({ type: 'snapshot', snapshot: snapshot('2026-10-16T00:00:00.000Z') });

      // Only generatedAt changed: a heartbeat, not the whole snapshot again.
      indexer.push(snapshot('2026-10-16T00:00:05.000Z'));
      expect(await client.nextMessage()).toEqual({
        type: 'heartbeat',
        generatedAt: '2026-10-16T00:00:05.000Z',
        source: { ok: true },
      });

      const changed = withSession('2026-10-16T00:00:10.000Z');
      indexer.push(changed);
      expect(await client.nextMessage()).toEqual({ type: 'snapshot', snapshot: changed });

      const same = withSession('2026-10-16T00:00:15.000Z');
      indexer.push(same);
      expect(await client.nextMessage()).toEqual(heartbeat(same));

      // A change inside a session counts.
      const renamed = withSession('2026-10-16T00:00:20.000Z', 'pitwall-test-renamed');
      indexer.push(renamed);
      expect(await client.nextMessage()).toEqual({ type: 'snapshot', snapshot: renamed });
    });

    it('sends a snapshot when only the source health changed', async () => {
      const indexer = fakeIndexer(snapshot('2026-10-16T00:00:00.000Z'));
      const server = await start(indexer);
      const client = await authedClient(server.port);
      await client.nextMessage();

      const failed = snapshot('2026-10-16T00:00:05.000Z', { source: { ok: false, error: 'claude agents --json timed out after 10s' } });
      indexer.push(failed);
      expect(await client.nextMessage()).toEqual({ type: 'snapshot', snapshot: failed });

      const stillFailing = snapshot('2026-10-16T00:00:10.000Z', { source: { ok: false, error: 'claude agents --json timed out after 10s' } });
      indexer.push(stillFailing);
      expect(await client.nextMessage()).toEqual(heartbeat(stillFailing));

      const recovered = snapshot('2026-10-16T00:00:15.000Z');
      indexer.push(recovered);
      expect(await client.nextMessage()).toEqual({ type: 'snapshot', snapshot: recovered });
    });

    it('sends a client that joins late a snapshot first, and compares each client with what it was sent', async () => {
      const indexer = fakeIndexer(snapshot('2026-10-16T00:00:00.000Z'));
      const server = await start(indexer);
      const early = await authedClient(server.port);
      expect((await early.nextMessage()).type).toBe('snapshot');

      indexer.push(snapshot('2026-10-16T00:00:05.000Z'));
      expect((await early.nextMessage()).type).toBe('heartbeat');

      // Joins after polls that sent the early client only heartbeats.
      const late = await authedClient(server.port);
      expect(await late.nextMessage()).toEqual({ type: 'snapshot', snapshot: snapshot('2026-10-16T00:00:05.000Z') });

      const next = snapshot('2026-10-16T00:00:10.000Z');
      indexer.push(next);
      expect(await early.nextMessage()).toEqual(heartbeat(next));
      expect(await late.nextMessage()).toEqual(heartbeat(next));

      const changed = withSession('2026-10-16T00:00:15.000Z');
      indexer.push(changed);
      expect(await early.nextMessage()).toEqual({ type: 'snapshot', snapshot: changed });
      expect(await late.nextMessage()).toEqual({ type: 'snapshot', snapshot: changed });
    });

    it('sends nothing until the first snapshot exists, then sends it', async () => {
      const indexer = fakeIndexer();
      const server = await start(indexer);
      const client = await authedClient(server.port);
      await waitFor(() => indexer.listenerCount() === 1);
      expect(client.messages).toEqual([]);

      indexer.push(snapshot('2026-10-16T00:00:00.000Z'));
      expect(await client.nextMessage()).toEqual({ type: 'snapshot', snapshot: snapshot('2026-10-16T00:00:00.000Z') });
    });

    it('does not subscribe before auth', async () => {
      const indexer = fakeIndexer(snapshot('2026-10-16T00:00:00.000Z'));
      const server = await start(indexer);
      const { client } = await challenged(server.port);
      indexer.push(snapshot('2026-10-16T00:00:02.000Z'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(indexer.listenerCount()).toBe(0);
      expect(client.messages).toEqual([]);
    });

    it('unsubscribes when the socket closes', async () => {
      const indexer = fakeIndexer(snapshot('2026-10-16T00:00:00.000Z'));
      const server = await start(indexer);
      const a = await authedClient(server.port);
      const b = await authedClient(server.port);
      await a.nextMessage();
      await b.nextMessage();
      expect(indexer.listenerCount()).toBe(2);

      a.ws.close();
      await a.closed;
      await waitFor(() => indexer.listenerCount() === 1);

      b.ws.terminate();
      await waitFor(() => indexer.listenerCount() === 0);
    });
  });

  describe('static files', () => {
    it('serves index.html for / with the security headers, uncached', async () => {
      const server = await start();
      const res = await get(server.port, '/');
      expect(res.status).toBe(200);
      expect(res.body).toBe('<!doctype html><title>pitwall</title>');
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      for (const [name, value] of Object.entries(securityHeaders(server.port))) {
        expect(res.headers[name.toLowerCase()]).toBe(value);
      }
    });

    it('sends the exact CSP, naming the WebSocket origin on the real port, plus nosniff and no-referrer', async () => {
      const server = await start();
      const res = await get(server.port, '/');
      expect(res.headers['content-security-policy']).toBe(
        `default-src 'self'; connect-src 'self' ws://127.0.0.1:${server.port}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('serves assets with their content type and the security headers, without a token', async () => {
      const server = await start();
      const res = await get(server.port, '/assets/app.js');
      expect(res.status).toBe(200);
      expect(res.body).toBe('console.log("pitwall");');
      expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(res.headers['cache-control']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBe(securityHeaders(server.port)['Content-Security-Policy']);
    });

    it('sends the security headers on errors too', async () => {
      const server = await start();
      for (const res of [await get(server.port, '/missing'), await get(server.port, SNAPSHOT_PATH)]) {
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['content-security-policy']).toBe(securityHeaders(server.port)['Content-Security-Policy']);
      }
    });

    it('answers HEAD without a body', async () => {
      const server = await start();
      const res = await get(server.port, '/', {}, 'HEAD');
      expect(res.status).toBe(200);
      expect(res.body).toBe('');
    });

    it('refuses other methods', async () => {
      const server = await start();
      expect((await get(server.port, '/', {}, 'POST')).status).toBe(405);
    });

    it.each([
      '/../secret.txt',
      '/assets/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E/secret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/..%2fsecret.txt',
      '/..%5csecret.txt',
      '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
      '/%252e%252e/secret.txt',
      '/escape.txt',
      '/.hidden',
      '/assets/',
      '//etc/passwd',
      '/assets//app.js',
      '/%00',
      '/%E0%A4%A',
    ])('blocks %s', async (path) => {
      const server = await start();
      const res = await raw(server.port, `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`);
      expect(res).not.toContain('SECRET');
      expect(res).not.toContain('hidden');
      expect([400, 404]).toContain(statusOf(res));
    });

    it('responds 503 with a short page while webRoot does not exist', async () => {
      const server = await start(fakeIndexer(), { webRoot: join(tmp, 'not-built-yet') });
      const res = await get(server.port, '/');
      expect(res.status).toBe(503);
      expect(res.body).toContain('still building');
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('has the building page reload itself with a same-origin script, which needs no token', async () => {
      const server = await start(fakeIndexer(), { webRoot: join(tmp, 'not-built-yet') });
      expect((await get(server.port, '/')).body).toContain(`<script src="${BUILDING_SCRIPT_PATH}"></script>`);
      const script = await get(server.port, BUILDING_SCRIPT_PATH);
      expect(script.status).toBe(200);
      expect(script.body).toBe(BUILDING_SCRIPT);
      expect(script.body).toContain('location.reload()');
      expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(script.headers['cache-control']).toBe('no-store');
      // The CSP's default-src 'self' covers it; no inline script is allowed.
      expect(script.headers['content-security-policy']).toBe(securityHeaders(server.port)['Content-Security-Policy']);
      expect((await get(server.port, BUILDING_SCRIPT_PATH, { host: 'evil.example' })).status).toBe(403);
    });

    it('responds 503 while index.html is missing from an emptied webRoot', async () => {
      const empty = join(tmp, 'emptied');
      await mkdir(empty, { recursive: true });
      const server = await start(fakeIndexer(), { webRoot: empty });
      expect((await get(server.port, '/')).status).toBe(503);
      expect((await get(server.port, '/assets/app.js')).status).toBe(404);
    });

    it('still checks Host while webRoot does not exist', async () => {
      const server = await start(fakeIndexer(), { webRoot: join(tmp, 'not-built-yet') });
      expect((await get(server.port, '/', { host: 'evil.example' })).status).toBe(403);
    });

    it('answers a plain request to the WebSocket path with 426', async () => {
      const server = await start();
      expect((await get(server.port, WS_PATH)).status).toBe(426);
    });
  });

  describe('close()', () => {
    it('closes WebSocket clients and the HTTP server, but not the indexer', async () => {
      const indexer = fakeIndexer(snapshot('2026-10-16T00:00:00.000Z'));
      const server = await startServerWithInternals({ indexer, token: TOKEN, webRoot, port: 0 });
      const client = await authedClient(server.port);
      await client.nextMessage();

      await server.close();
      expect((await client.closed).code).toBe(1001);
      expect(indexer.listenerCount()).toBe(0);
      expect(indexer.stop).not.toHaveBeenCalled();
      await expect(get(server.port, '/')).rejects.toThrow(/ECONNREFUSED/);
    });

    it('can be called twice', async () => {
      const server = await startServerWithInternals({ indexer: fakeIndexer(), token: TOKEN, webRoot, port: 0 });
      await Promise.all([server.close(), server.close()]);
      await server.close();
    });
  });
});
