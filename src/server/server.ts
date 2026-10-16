// The HTTP and WebSocket server. Which check applies where:
//
//   every request and upgrade   Host is 127.0.0.1:<port> or localhost:<port>, else 403
//   /api/*                      Origin, when present, is this server's origin, else 403;
//                               then Authorization: Bearer <token>, else 401
//   WebSocket upgrade at /ws    Origin is required and must be this server's origin, else 403;
//                               then the first message must be a valid auth within 5 seconds, else 4401
//   static files                Host only. They are the public build output.
//
// No response carries CORS headers.
import { createServer, STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Indexer } from '../index/index.js';
import { SNAPSHOT_PATH, WS_PATH } from '../shared/protocol.js';
import type { RunningServer, ServerOptions } from './index.js';
import {
  bearerToken,
  isAllowedHost,
  isAllowedOrigin,
  LOOPBACK_HOST,
  MIN_TOKEN_LENGTH,
  securityHeaders,
  tokensMatch,
} from './security.js';
import { BUILDING_PAGE, resolveStaticFile } from './static.js';
import { DEFAULT_AUTH_TIMEOUT_MS, handleClient, MAX_PAYLOAD_BYTES } from './websocket.js';

export const DEFAULT_PORT = 4517;

/** How long close() waits for WebSocket clients to finish the close handshake. */
const CLOSE_GRACE_MS = 250;

/** Thrown when an explicitly requested port is taken. The default port falls back instead. */
export class PortInUseError extends Error {
  readonly port: number;

  constructor(port: number, options?: ErrorOptions) {
    super(`${LOOPBACK_HOST}:${port} is already in use`, options);
    this.name = 'PortInUseError';
    this.port = port;
  }
}

/** Knobs for tests. Not part of ServerOptions, so the public contract stays as declared. */
export interface ServerInternals {
  authTimeoutMs?: number;
  /** The port tried when options.port is undefined. Default 4517. */
  defaultPort?: number;
}

export async function startServerWithInternals(
  options: ServerOptions,
  internals: ServerInternals = {},
): Promise<RunningServer> {
  const { indexer, token, webRoot } = options;
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`startServer: the token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }

  // Set once the server is listening. Until then, nothing is allowed.
  let port: number | undefined;
  // Also set once listening, because the CSP names the WebSocket origins with the real port.
  let headers: [string, string][] = [];
  let closing = false;

  const app = createApp({ indexer, token, webRoot, port: () => port ?? -1 });
  const honoListener = getRequestListener(app.fetch);

  const server = createServer((req, res) => {
    for (const [name, value] of headers) res.setHeader(name, value);
    const status = gateStatus(req, port);
    if (status !== undefined) {
      res.writeHead(status, { 'Content-Length': 0 }).end();
      return;
    }
    void honoListener(req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false });
  const authTimeoutMs = internals.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    if (closing) return rejectUpgrade(socket, 503);
    const status = gateStatus(req, port);
    if (status !== undefined) return rejectUpgrade(socket, status);
    if (req.url?.split('?')[0] !== WS_PATH) return rejectUpgrade(socket, 404);
    // Browsers always send Origin on a WebSocket upgrade, so a missing one is refused.
    if (!isAllowedOrigin(req.headers.origin, port!)) return rejectUpgrade(socket, 403);
    wss.handleUpgrade(req, socket, head, (ws) => handleClient(ws, { indexer, token, authTimeoutMs }));
  });

  const requested = options.port ?? internals.defaultPort ?? DEFAULT_PORT;
  try {
    port = await listen(server, requested);
  } catch (error) {
    if (!isAddressInUse(error)) throw error;
    if (options.port !== undefined) throw new PortInUseError(requested, { cause: error });
    port = await listen(server, 0);
  }
  headers = Object.entries(securityHeaders(port));

  let closed: Promise<void> | undefined;
  return {
    url: `http://${LOOPBACK_HOST}:${port}`,
    port,
    close() {
      closed ??= closeAll(server, wss, () => {
        closing = true;
      });
      return closed;
    },
  };
}

/** The status to refuse a request or upgrade with before routing, or undefined to let it through. */
function gateStatus(req: IncomingMessage, port: number | undefined): number | undefined {
  if (port === undefined) return 503;
  if (!isAllowedHost(req.headers.host, port)) return 403;
  // Origin-form only (`/path`), so Host is always the authority that was checked.
  // Browsers never send absolute-form request targets to a server that isn't a proxy.
  if (!req.url?.startsWith('/')) return 400;
  return undefined;
}

interface AppContext {
  indexer: Indexer;
  token: string;
  webRoot: string;
  port(): number;
}

function createApp({ indexer, token, webRoot, port }: AppContext): Hono {
  const app = new Hono();

  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin !== undefined && !isAllowedOrigin(origin, port())) return c.body(null, 403);
    const presented = bearerToken(c.req.header('authorization'));
    if (presented === undefined || !tokensMatch(presented, token)) return c.body(null, 401);
    await next();
  });

  app.get(SNAPSHOT_PATH, (c) => {
    c.header('Cache-Control', 'no-store');
    const snapshot = indexer.latest();
    if (!snapshot) return c.body(null, 503);
    return c.json(snapshot);
  });

  app.all('/api/*', (c) => c.body(null, 404));

  // A plain request to the WebSocket path, without an upgrade.
  app.all(WS_PATH, (c) => c.body(null, 426));

  app.get('*', async (c) => {
    const result = await resolveStaticFile(webRoot, new URL(c.req.url).pathname);
    switch (result.kind) {
      case 'file':
        c.header('Content-Type', result.contentType);
        if (result.isIndex) c.header('Cache-Control', 'no-store');
        return c.body(new Uint8Array(result.body));
      case 'building':
        c.header('Cache-Control', 'no-store');
        c.header('Retry-After', '1');
        return c.html(BUILDING_PAGE, 503);
      case 'not-found':
        return c.body(null, 404);
    }
  });

  app.all('*', (c) => c.body(null, 405));

  app.onError((error, c) => {
    console.error('pitwall: request failed:', error);
    return c.body(null, 500);
  });

  return app;
}

function rejectUpgrade(socket: Duplex, status: number): void {
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host: LOOPBACK_HOST });
  });
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';
}

async function closeAll(server: Server, wss: WebSocketServer, markClosing: () => void): Promise<void> {
  markClosing();
  const clients = [...wss.clients];
  for (const ws of clients) ws.close(1001);
  await settleWithin(clients.map(closedPromise), CLOSE_GRACE_MS);
  for (const ws of clients) if (ws.readyState !== ws.CLOSED) ws.terminate();
  wss.close();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function closedPromise(ws: WebSocket): Promise<void> {
  if (ws.readyState === ws.CLOSED) return Promise.resolve();
  return new Promise((resolve) => ws.once('close', () => resolve()));
}

async function settleWithin(promises: Promise<void>[], ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(promises),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}
