// The fake pitwall server the app check drives the web UI against. It serves the production build
// with pitwall's own security headers and CSP, its Host and Origin checks, its static file rules and
// the v3 WebSocket challenge, all imported from the server build (dist/server, dist/shared), never
// copied. Behind them it answers the snapshot, conversation pages, the relay, attach (a made-up
// terminal stream), spawn, stop and remove from the made-up World in fixtures.ts.
//
// It never runs `claude`, reads no transcript, `~/.claude`, `.env` or `~/.pitwall`, and holds no real
// token: the token is random per run and only ever reaches the page in its URL's fragment. It imports
// only security.js, static.js and protocol.js from the build, which read nothing but webRoot.
//
// What the page did is recorded in `records`, for the parts to check: attaches, keys and resizes sent
// to an attached session, spawns, relayed messages, stops and removes, and every request.

import { randomBytes } from 'node:crypto';
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { AttachClientMessage, ConversationPage, IndexSnapshot, RelayResult, SpawnRequest, SpawnResult } from '../../src/shared/protocol.js';
import { terminalScreen, World, type ResetOptions } from './fixtures.js';

type Security = typeof import('../../src/server/security.js');
type Static = typeof import('../../src/server/static.js');
type Protocol = typeof import('../../src/shared/protocol.js');

/** pitwall's own modules, from the build. */
export interface Built {
  security: Security;
  static: Static;
  protocol: Protocol;
}

/** Imports the three modules the fake server uses from a server build, such as dist. */
export async function importBuilt(dist: string): Promise<Built> {
  const load = (path: string) => import(pathToFileURL(join(dist, path)).href);
  const [security, staticFiles, protocol] = await Promise.all([load('server/security.js'), load('server/static.js'), load('shared/protocol.js')]);
  return { security: security as Security, static: staticFiles as Static, protocol: protocol as Protocol };
}

export interface Records {
  /** Each attach socket's `open` the server accepted. */
  attaches: Array<{ sessionId: string; name: string; restart: boolean }>;
  /** Every key and resize the page sent an attached session. */
  inputs: Array<{ name: string; type: 'input' | 'resize'; data: string }>;
  spawns: Array<{ cwd: string; name?: string | undefined; model?: string | undefined; promptLength: number }>;
  relays: Array<{ name: string; length: number }>;
  actions: Array<{ action: 'stop' | 'remove'; name: string }>;
  /** Every HTTP request and upgrade, as `METHOD /path status`. */
  requests: string[];
}

const emptyRecords = (): Records => ({ attaches: [], inputs: [], spawns: [], relays: [], actions: [], requests: [] });

export interface FakeServerOptions {
  port: number;
  webRoot: string;
  built: Built;
  /** Made up per run. The page gets it in its URL's fragment; it's never logged. */
  token: string;
  /** How long a relayed message takes to come back delivered, so Send shows it's busy. */
  relayDelayMs?: number;
  /** How long a spawned session takes to be listed, as the index lists it on a later poll. */
  listDelayMs?: number;
}

export interface FakeServer {
  readonly origin: string;
  readonly port: number;
  readonly world: World;
  readonly records: Records;
  /** The made-up data back to the start, with one root or two, and the records cleared. */
  reset(options?: ResetOptions): void;
  /** The records cleared, and nothing else. */
  clearRecords(): void;
  /** Sends the snapshot to every authenticated index socket, as the index does after a poll that changed it. */
  broadcast(): void;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;
/** The real server's handshake limit (DEFAULT_AUTH_TIMEOUT_MS). */
const AUTH_TIMEOUT_MS = 5000;

export async function startFakeServer(options: FakeServerOptions): Promise<FakeServer> {
  const { port, webRoot, token, built } = options;
  const { security, protocol } = built;
  const origin = security.serverOrigin(port);
  const apiKey = security.randomSecret();
  const headers = Object.entries(security.securityHeaders(port));
  const world = new World();
  let records = emptyRecords();
  const timers = new Set<NodeJS.Timeout>();
  const indexSockets = new Set<WebSocket>();
  const attachSockets = new Set<WebSocket>();
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };

  const broadcast = () => {
    const message = JSON.stringify({ type: 'snapshot', snapshot: world.snapshot() });
    for (const ws of indexSockets) ws.send(message);
  };

  const server = createServer((req, res) => {
    for (const [name, value] of headers) res.setHeader(name, value);
    const path = req.url?.split('?')[0] ?? '';
    res.on('finish', () => records.requests.push(`${req.method} ${path} ${res.statusCode}`));
    // As the real server's gateStatus(): Host first, then an origin-form target.
    if (!security.isAllowedHost(req.headers.host, port)) return end(res, 403);
    if (!req.url?.startsWith('/')) return end(res, 400);
    if (path.startsWith('/api/')) return void api(req, res).catch(() => end(res, 500));
    if (path === protocol.WS_PATH || path === protocol.ATTACH_PATH) return end(res, 426);
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405);
    void serveStatic(req, res).catch(() => end(res, 500));
  });

  async function serveStatic(req: IncomingMessage, res: ServerResponse) {
    const result = await built.static.resolveStaticFile(webRoot, new URL(req.url ?? '/', origin).pathname);
    if (result.kind !== 'file') return end(res, 404);
    res.setHeader('Content-Type', result.contentType);
    if (result.isIndex) res.setHeader('Cache-Control', 'no-store');
    res.end(result.body);
  }

  /** The real server's /api/* checks, in its order, then the routes. */
  async function api(req: IncomingMessage, res: ServerResponse) {
    const requestOrigin = req.headers.origin;
    if (requestOrigin !== undefined && !security.isAllowedOrigin(requestOrigin, port)) return end(res, 403);
    const presented = security.bearerToken(req.headers.authorization);
    const credential = presented === undefined ? undefined : security.identifyCredential(presented, apiKey, token);
    if (credential === undefined) return end(res, 401);
    const method = req.method ?? 'GET';
    if (security.isStateChanging(method) && (credential !== 'apiKey' || requestOrigin === undefined)) return end(res, 403);
    res.setHeader('Cache-Control', 'no-store');

    const url = new URL(req.url ?? '/', origin);
    if (method === 'GET' && url.pathname === protocol.SNAPSHOT_PATH) return json(res, 200, world.snapshot() satisfies IndexSnapshot);
    if (method === 'POST' && url.pathname === protocol.SPAWN_PATH) return spawn(req, res);

    const match = /^\/api\/sessions\/([^/]+)\/(conversation|relay|stop|remove)$/.exec(url.pathname);
    if (!match) return end(res, 404);
    const session = world.session(decodeURIComponent(match[1]!));
    if (!session) return end(res, 404);
    const route = match[2];
    if (route === 'conversation' && method === 'GET') return json(res, 200, world.conversation(session.sessionId) satisfies ConversationPage | undefined);
    if (route === 'relay' && method === 'POST') {
      if (session.kind !== 'interactive' || !session.alive) return json(res, 409, { status: 'failed', detail: 'Made up: only a running interactive session.' } satisfies RelayResult);
      const body = await readJson(req);
      if (!isRecord(body) || typeof body.text !== 'string' || body.text.trim() === '') return json(res, 400, { status: 'failed', detail: 'Made up: no text.' } satisfies RelayResult);
      records.relays.push({ name: session.name, length: body.text.length });
      const sentAt = new Date().toISOString();
      return later(options.relayDelayMs ?? 400, () => {
        world.relayed(session.sessionId, { sentAt, status: 'delivered' });
        json(res, 200, { status: 'delivered' } satisfies RelayResult);
        broadcast();
      });
    }
    if ((route === 'stop' || route === 'remove') && method === 'POST') {
      if (session.kind !== 'background') return json(res, 409, { ok: false, error: 'Made up: background sessions only.' });
      records.actions.push({ action: route, name: session.name });
      return json(res, 200, { ok: true });
    }
    return end(res, 405);
  }

  /** New session: pitwall's JSON checks, a made-up background session, and its listing a moment later. */
  async function spawn(req: IncomingMessage, res: ServerResponse) {
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { ok: false, error: 'Send the request as application/json.' } satisfies SpawnResult);
    const body = await readJson(req);
    if (!isRecord(body) || typeof body.cwd !== 'string' || typeof body.prompt !== 'string' || body.prompt.trim() === '') {
      return json(res, 400, { ok: false, error: 'Made up: a directory and a prompt.' } satisfies SpawnResult);
    }
    const root = world.rootFor(body.cwd);
    if (root === undefined) return json(res, 400, { ok: false, error: 'Made up: that directory is under no root.' } satisfies SpawnResult);
    const request: SpawnRequest = { cwd: body.cwd, prompt: body.prompt, ...(typeof body.name === 'string' ? { name: body.name } : {}), ...(typeof body.model === 'string' ? { model: body.model } : {}) };
    records.spawns.push({ cwd: request.cwd, name: request.name, model: request.model, promptLength: request.prompt.length });
    const started = world.spawn(request, root);
    json(res, 201, { ok: true, shortId: started.summary.shortId ?? '', name: started.summary.name } satisfies SpawnResult);
    later(options.listDelayMs ?? 800, () => {
      started.list();
      broadcast();
    });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const path = req.url?.split('?')[0];
    const refuse = (status: number) => {
      records.requests.push(`UPGRADE ${path} ${status}`);
      socket.once('finish', () => socket.destroy());
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (!security.isAllowedHost(req.headers.host, port)) return refuse(403);
    if (path !== protocol.WS_PATH && path !== protocol.ATTACH_PATH) return refuse(404);
    // Browsers always send Origin on a WebSocket upgrade, so a missing one is refused, as pitwall does.
    if (!security.isAllowedOrigin(req.headers.origin, port)) return refuse(403);
    records.requests.push(`UPGRADE ${path} 101`);
    wss.handleUpgrade(req, socket, head, (ws) => (path === protocol.WS_PATH ? indexSocket(ws) : attachSocket(ws)));
  });

  /** The v3 challenge, then `then` once the page's proof, bound to this origin, is good; 4401 otherwise. */
  function handshake(ws: WebSocket, then: () => void, onMessage: (message: unknown) => void) {
    const nonce = security.randomSecret();
    let authed = false;
    const timer = setTimeout(() => ws.close(protocol.WS_CLOSE_UNAUTHORIZED), AUTH_TIMEOUT_MS);
    ws.on('close', () => clearTimeout(timer));
    ws.send(JSON.stringify({ type: 'challenge', version: protocol.PROTOCOL_VERSION, nonce }));
    ws.on('message', (data: RawData, binary: boolean) => {
      if (binary) return;
      let message: unknown;
      try {
        message = JSON.parse(String(data));
      } catch {
        return ws.close(protocol.WS_CLOSE_UNAUTHORIZED);
      }
      if (!authed) {
        const proof = isRecord(message) && message.type === 'auth' && typeof message.proof === 'string' ? message.proof : undefined;
        if (proof === undefined || !security.proofMatches(proof, token, nonce, origin)) return ws.close(protocol.WS_CLOSE_UNAUTHORIZED);
        authed = true;
        clearTimeout(timer);
        then();
        return;
      }
      onMessage(message);
    });
  }

  function indexSocket(ws: WebSocket) {
    ws.on('close', () => indexSockets.delete(ws));
    handshake(
      ws,
      () => {
        ws.send(JSON.stringify({ type: 'authenticated', apiKey }));
        ws.send(JSON.stringify({ type: 'snapshot', snapshot: world.snapshot() }));
        indexSockets.add(ws);
      },
      () => {},
    );
  }

  function attachSocket(ws: WebSocket) {
    let opened: { name: string } | undefined;
    ws.on('close', () => attachSockets.delete(ws));
    handshake(
      ws,
      () => {
        if (attachSockets.size >= protocol.MAX_ATTACHED) return ws.close(protocol.WS_CLOSE_TOO_MANY);
        attachSockets.add(ws);
        ws.send(JSON.stringify({ type: 'ready' }));
      },
      (raw) => {
        const message = raw as AttachClientMessage;
        if (opened && (message.type === 'input' || message.type === 'resize')) {
          records.inputs.push({ name: opened.name, type: message.type, data: message.type === 'input' ? message.data : `${message.cols}x${message.rows}` });
          return;
        }
        if (message.type !== 'open' || opened) return;
        const session = world.session(message.sessionId);
        if (!session || session.kind !== 'background') {
          ws.send(JSON.stringify({ type: 'error', error: 'Made up: no such background session.' }));
          return ws.close(1008);
        }
        if ((session.finished || !session.alive) && message.restart !== true) return ws.send(JSON.stringify({ type: 'needs-restart' }));
        opened = { name: session.name };
        records.attaches.push({ sessionId: session.sessionId, name: session.name, restart: message.restart === true });
        ws.send(JSON.stringify({ type: 'attached' }));
        ws.send(Buffer.from(terminalScreen(session), 'utf8'), { binary: true });
      },
    );
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: security.LOOPBACK_HOST }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const listening = (server.address() as AddressInfo).port;
  if (listening !== port) throw new Error(`the fake server listened on ${listening}, not ${port}`);

  let closed: Promise<void> | undefined;
  return {
    origin,
    port,
    world,
    get records() {
      return records;
    },
    reset(resetOptions) {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const ws of [...indexSockets, ...attachSockets]) ws.terminate();
      world.reset(resetOptions);
      records = emptyRecords();
    },
    clearRecords() {
      records = emptyRecords();
    },
    broadcast,
    close() {
      closed ??= (async () => {
        for (const timer of timers) clearTimeout(timer);
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      })();
      return closed;
    },
  };
}

/** A made-up token for one run: as long as the CLI's, random, and never printed. */
export function madeUpToken(): string {
  return randomBytes(32).toString('base64url');
}

function end(res: ServerResponse, status: number) {
  res.writeHead(status, { 'Content-Length': 0 }).end();
}

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) }).end(text);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(size > MAX_BODY_BYTES ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
