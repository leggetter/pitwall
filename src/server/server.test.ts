import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect, createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { Indexer } from '../index/index.js';
import {
  SNAPSHOT_PATH,
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
  type IndexSnapshot,
  type ServerMessage,
} from '../shared/protocol.js';
import { DEFAULT_PORT, PortInUseError, startServer, type RunningServer } from './index.js';
import { securityHeaders } from './security.js';
import { startServerWithInternals, type ServerInternals } from './server.js';
import { DEFAULT_AUTH_TIMEOUT_MS } from './websocket.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';

// ---------------------------------------------------------------- fixtures

interface FakeIndexer extends Indexer {
  push(snapshot: IndexSnapshot): void;
  listenerCount(): number;
}

function fakeIndexer(initial?: IndexSnapshot): FakeIndexer {
  let latest = initial;
  const listeners = new Set<(snapshot: IndexSnapshot) => void>();
  return {
    latest: () => latest,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop: vi.fn(),
    push(snapshot) {
      latest = snapshot;
      for (const listener of [...listeners]) listener(snapshot);
    },
    listenerCount: () => listeners.size,
  };
}

function snapshot(generatedAt: string): IndexSnapshot {
  return { generatedAt, roots: ['/tmp/pitwall-test-root'], groups: [], source: { ok: true } };
}

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

async function authedClient(port: number): Promise<Client> {
  const client = connectWs(port, { origin: origin(port) });
  await once(client.ws, 'open');
  client.ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
  return client;
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

  describe('the WebSocket', () => {
    it('closes with 4401 for a wrong token', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const client = connectWs(server.port, { origin: origin(server.port) });
      await once(client.ws, 'open');
      client.ws.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
      expect((await client.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(client.messages).toEqual([]);
    });

    it.each([
      ['not JSON', 'hello'],
      ['the wrong type', JSON.stringify({ type: 'hello', token: TOKEN })],
      ['no token', JSON.stringify({ type: 'auth' })],
      ['a non-string token', JSON.stringify({ type: 'auth', token: 42 })],
      ['JSON null', 'null'],
    ])('closes with 4401 when the first message is %s', async (_name, message) => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const client = connectWs(server.port, { origin: origin(server.port) });
      await once(client.ws, 'open');
      client.ws.send(message);
      expect((await client.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(client.messages).toEqual([]);
    });

    it('closes with 4401 when the first message is binary', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')));
      const client = connectWs(server.port, { origin: origin(server.port) });
      await once(client.ws, 'open');
      client.ws.send(Buffer.from(JSON.stringify({ type: 'auth', token: TOKEN })));
      expect((await client.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
    });

    it('waits 5 seconds for auth by default', () => {
      expect(DEFAULT_AUTH_TIMEOUT_MS).toBe(5000);
    });

    it('closes with 4401 when no auth arrives in time', async () => {
      const server = await start(fakeIndexer(snapshot('2026-10-16T00:00:00.000Z')), {}, { authTimeoutMs: 50 });
      const client = connectWs(server.port, { origin: origin(server.port) });
      await once(client.ws, 'open');
      const started = Date.now();
      expect((await client.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(Date.now() - started).toBeGreaterThanOrEqual(40);
      expect(client.messages).toEqual([]);
    });

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

    it('sends the latest snapshot after auth, then every push', async () => {
      const indexer = fakeIndexer(snapshot('2026-10-16T00:00:00.000Z'));
      const server = await start(indexer);
      const client = await authedClient(server.port);

      expect(await client.nextMessage()).toEqual({ type: 'snapshot', snapshot: snapshot('2026-10-16T00:00:00.000Z') });

      indexer.push(snapshot('2026-10-16T00:00:02.000Z'));
      indexer.push(snapshot('2026-10-16T00:00:04.000Z'));
      expect(await client.nextMessage()).toEqual({ type: 'snapshot', snapshot: snapshot('2026-10-16T00:00:02.000Z') });
      expect(await client.nextMessage()).toEqual({ type: 'snapshot', snapshot: snapshot('2026-10-16T00:00:04.000Z') });
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
      const client = connectWs(server.port, { origin: origin(server.port) });
      await once(client.ws, 'open');
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
