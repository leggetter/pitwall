// The HTTP and WebSocket server. Which check applies where:
//
//   every request and upgrade   Host is 127.0.0.1:<port> (not localhost), else 403
//   /api/*                      Origin, when present, is this server's origin, else 403;
//                               then Authorization: Bearer <apiKey> or Bearer <token>, else 401.
//                               A state-changing method (anything but GET and HEAD) also needs
//                               the apiKey, not the token, and an Origin, else 403
//   GET /api/directories        then directories.ts: the directories under the snapshot's roots
//   GET /api/editors            then editors.ts: the editors found at startup
//   GET /api/prs                then prs.ts: your open PRs, the latest list the poller has (M4);
//                               POST /api/prs/refresh asks it for a fetch, at most one a minute,
//                               else 429, and 409 with --no-prs
//   POST /api/attachments       then attachments.ts: the one body that isn't JSON, the file's bytes
//                               with its own Content-Type, at most 10 MiB, its type checked; DELETE
//                               /api/attachments/:id removes one no spawn has used
//   /api/sessions/:sessionId/*  then resolveSession() (sessions.ts): a safe id, else 400; a
//                               snapshot, else 503; the session in it, else 404. Every route that
//                               takes a session id, and every M2 input path, goes through it.
//                               At most 4 conversation reads at once, else 429: a session's
//                               conversation pages, its sub-agent list and its sub-agents' pages
//                               (W76) share the limit. A sub-agent's id is letters and digits
//                               and one of the session's, by a fresh listing of its folder, else
//                               404. Stop, remove, resume, open in an editor and end session
//                               share one limit of 4, else 429
//   WebSocket upgrade at /ws    Origin is required and must be this server's origin, else 403;
//                               at most 32 connections in the handshake at once, on /ws and
//                               /attach together, else close 1013 with no challenge; then the
//                               challenge-response handshake within 5 seconds, with a proof
//                               bound to this server's origin, else 4401 (handshake.ts)
//   WebSocket upgrade at /attach
//                               the same Origin rule and handshake, then attach.ts: at most 4
//                               sockets past the handshake, else 4429, and only a background
//                               session that resolveSession() finds
//   static files                Host only. They are the public build output.
//
// The token can read the API, for scripts. The apiKey, which only a client
// that answered a challenge gets, can read it too, and is the only credential
// for state-changing requests. Neither is ever logged. No response carries
// CORS headers.
import { createServer, STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { getRequestListener } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import { ConversationCursorError, isSafeAgentId, isWellFormedCursor, type Indexer } from '../index/index.js';
import { prsOff } from '../prs/index.js';
import {
  ATTACH_PATH,
  CONVERSATION_STALE_STATUS,
  conversationPath,
  SNAPSHOT_PATH,
  subagentConversationPath,
  subagentsPath,
  WS_PATH,
  type ConversationPage,
} from '../shared/protocol.js';
import { CommandSlots, DEFAULT_MAX_CONCURRENT_COMMANDS, registerActions, type ActionOptions } from './actions.js';
import { createAttachServer, type AttachOptions } from './attach.js';
import { AttachmentStore, registerAttachments, type AttachmentStoreOptions } from './attachments.js';
import { registerDirectories, type DirectoryOptions } from './directories.js';
import { registerEditors, type EditorOptions } from './editors.js';
import { registerEndSession, type EndOptions } from './end.js';
import type { RunningServer, ServerOptions } from './index.js';
import { registerPrs } from './prs.js';
import { createRelayManager } from './relay.js';
import { registerRelay } from './relayRoute.js';
import {
  bearerToken,
  identifyCredential,
  isAllowedHost,
  isAllowedOrigin,
  isStateChanging,
  LOOPBACK_HOST,
  MIN_TOKEN_LENGTH,
  randomSecret,
  securityHeaders,
  serverOrigin,
} from './security.js';
import { spawnPty } from './pty.js';
import { RecentSpawns } from './recentSpawns.js';
import { resolveSession } from './sessions.js';
import { BUILDING_PAGE, BUILDING_SCRIPT, BUILDING_SCRIPT_PATH, resolveStaticFile } from './static.js';
import { HandshakeSlots } from './handshake.js';
import { DEFAULT_AUTH_TIMEOUT_MS, handleClient, MAX_PAYLOAD_BYTES } from './websocket.js';

export const DEFAULT_PORT = 4517;

/**
 * The conversation route as a Hono pattern. conversationPath() encodes its
 * argument, which would turn `:sessionId` into `%3AsessionId`, so the
 * pattern is decoded back.
 */
const CONVERSATION_ROUTE = decodeURIComponent(conversationPath(':sessionId'));
/** The sub-agent routes (W76), decoded the same way. */
const SUBAGENTS_ROUTE = decodeURIComponent(subagentsPath(':sessionId'));
const SUBAGENT_CONVERSATION_ROUTE = decodeURIComponent(subagentConversationPath(':sessionId', ':agentId'));

/**
 * The status for a `before` cursor made for another version of the
 * transcript: it was replaced, rotated, truncated or rewritten since. The UI
 * reloads the newest page.
 */
export const STALE_CURSOR_STATUS = CONVERSATION_STALE_STATUS;

/** How long close() waits for WebSocket clients to finish the close handshake. */
const CLOSE_GRACE_MS = 250;

/**
 * At most this many conversation pages are read at once, server-wide. Each
 * read can scan about 8 MiB of transcript; more get 429 with Retry-After.
 */
export const MAX_CONVERSATION_READS = 4;

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
  /**
   * Adds routes after the /api/* checks and before the catch-all 404, as
   * W10-W12's input routes will be. Tests use it for a state-changing route.
   */
  routes?: (app: Hono) => void;
  /** Spawn, stop, remove and resume (W12, W66, actions.ts): tests pass a fake command runner, agents source and limits. */
  actions?: ActionOptions;
  /**
   * For the attach socket. Tests pass a fake PTY spawner and agents source,
   * so they never run `claude`.
   */
  attach?: Partial<Pick<AttachOptions, 'spawnPty' | 'env' | 'agents' | 'spawned' | 'resumed' | 'processAlive' | 'now'>>;
  /** The directory list (W70, directories.ts): tests pass a wrapped readdir, a clock and limits. */
  directories?: DirectoryOptions;
  /**
   * Open in an editor (W72, editors.ts): tests pass the editors found and a fake runFile, so nothing
   * depends on this machine's editors and none is ever opened. Its limit is `actions.maxConcurrentCommands`.
   */
  editors?: Omit<EditorOptions, 'slots'>;
  /**
   * End session (W90, end.ts): tests pass a fake agents source, process lookups and signaller, so no
   * test signals a process. Its limit of 4 at once is `actions.maxConcurrentCommands`.
   */
  end?: Omit<EndOptions, 'slots'>;
  /**
   * Attachments (W79, attachments.ts): tests pass a clock, a sweep interval, a uid, and the cap, the
   * clean-up's bounds and its log (W84). The folder is ServerOptions.pitwallHome's.
   */
  attachments?: Omit<AttachmentStoreOptions, 'home'>;
}

export async function startServerWithInternals(
  options: ServerOptions,
  internals: ServerInternals = {},
): Promise<RunningServer> {
  const { indexer, token, webRoot } = options;
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`startServer: the token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }

  // Authorizes HTTP API calls for clients that answered a challenge. One per
  // server process, so it dies with the process, and a page that reconnects
  // to a restarted server gets the new one from a fresh handshake.
  const apiKey = randomSecret();

  // Set once the server is listening. Until then, nothing is allowed.
  let port: number | undefined;
  // Also set once listening, because the CSP names the WebSocket origins with the real port.
  let headers: [string, string][] = [];
  let closing = false;

  // Messages to interactive sessions (W11, D8). Started on the first one, stopped on close().
  const relay = options.relay ?? createRelayManager();
  // What spawn and resume started lately, so attach can tell a session that's starting from one that crashed.
  const spawned = new RecentSpawns();
  // The ended sessions resume brought back lately, by session id, which the snapshot shows as ended until its next poll.
  const resumed = new RecentSpawns();
  // Stop, remove, resume, open in an editor and end session, running now: one limit for all five.
  const commandSlots = internals.actions?.slots ?? new CommandSlots(internals.actions?.maxConcurrentCommands ?? DEFAULT_MAX_CONCURRENT_COMMANDS);
  // Uploads for New session's first prompt (W79), which spawn looks up. Swept once listening.
  const attachments = new AttachmentStore({ ...internals.attachments, home: options.pitwallHome });
  // Your open PRs (M4): the CLI's poller, or off. Started once listening, stopped on close().
  const prs = options.prs ?? prsOff();
  // The directory list (W70), your open PRs and Refresh (M4), then the input routes: attachments
  // (W79), spawn, stop and remove (W12), resume (W66), the editors and open in an editor (W72), whose
  // detection starts here, end session (W90), which never ends the relay, the relay (W11), then any a
  // test adds.
  const routes = (app: Hono) => {
    registerDirectories(app, indexer, internals.directories);
    registerPrs(app, prs);
    registerAttachments(app, attachments);
    registerActions(app, indexer, { token, spawned, resumed, ...internals.actions, slots: commandSlots, attachments });
    registerEditors(app, indexer, { token, ...internals.editors, slots: commandSlots });
    registerEndSession(app, indexer, { isRelay: (row) => relay.isRelay(row), ...internals.end, slots: commandSlots });
    registerRelay(app, indexer, relay);
    internals.routes?.(app);
  };
  const app = createApp({ indexer, token, apiKey, webRoot, port: () => port ?? -1, routes });
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
  // Connections still in the handshake, on /ws and /attach together. Extras close with 1013.
  const slots = new HandshakeSlots();
  // The CLI's hook, which deletes the launch file. It must never break a handshake.
  const onAuthenticated = () => {
    try {
      options.onAuthenticated?.();
    } catch {
      // Ignored, as ServerOptions says.
    }
  };
  const attach = createAttachServer({
    indexer,
    token,
    origin: () => serverOrigin(port ?? -1),
    authTimeoutMs,
    spawnPty,
    onAuthenticated,
    spawned,
    resumed,
    slots,
    ...internals.attach,
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    if (closing) return rejectUpgrade(socket, 503);
    const status = gateStatus(req, port);
    if (status !== undefined) return rejectUpgrade(socket, status);
    const path = req.url?.split('?')[0];
    if (path !== WS_PATH && path !== ATTACH_PATH) return rejectUpgrade(socket, 404);
    // Browsers always send Origin on a WebSocket upgrade, so a missing one is refused.
    if (!isAllowedOrigin(req.headers.origin, port!)) return rejectUpgrade(socket, 403);
    if (path === ATTACH_PATH) return attach.handleUpgrade(req, socket, head);
    wss.handleUpgrade(req, socket, head, (ws) =>
      handleClient(ws, { indexer, token, origin: serverOrigin(port!), apiKey, authTimeoutMs, onAuthenticated, slots, prs }),
    );
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
  // At startup, for anything an earlier run left, then on a timer.
  attachments.start();
  // The first fetch of your open PRs, now that there's a server to show them.
  prs.start();

  let closed: Promise<void> | undefined;
  return {
    url: `http://${LOOPBACK_HOST}:${port}`,
    port,
    close() {
      // No more fetches, and no more 'prs' messages to clients that are closing.
      prs.stop();
      closed ??= Promise.all([
        closeAll(server, wss, () => {
          closing = true;
        }),
        attach.close(),
        relay.close(),
        attachments.close(),
      ]).then(() => undefined);
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
  apiKey: string;
  webRoot: string;
  port(): number;
  routes: ServerInternals['routes'];
}

function createApp({ indexer, token, apiKey, webRoot, port, routes }: AppContext): Hono {
  const app = new Hono();
  // Conversation pages being read now.
  let conversationReads = 0;

  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin !== undefined && !isAllowedOrigin(origin, port())) return c.body(null, 403);
    const presented = bearerToken(c.req.header('authorization'));
    const credential = presented === undefined ? undefined : identifyCredential(presented, apiKey, token);
    if (credential === undefined) return c.body(null, 401);
    // Anything that can change state needs the apiKey, which only a page that
    // answered a challenge holds, and must come from this server's own page.
    // Browsers send Origin on every such request. 403, not 401: the web UI
    // takes a 401 to mean its apiKey is stale and reconnects.
    if (isStateChanging(c.req.method) && (credential !== 'apiKey' || origin === undefined)) return c.body(null, 403);
    await next();
  });

  app.get(SNAPSHOT_PATH, (c) => {
    c.header('Cache-Control', 'no-store');
    const snapshot = indexer.latest();
    if (!snapshot) return c.body(null, 503);
    return c.json(snapshot);
  });

  /**
   * A page of a transcript, for the session's conversation and a sub-agent's (W76) alike: the
   * cursor is checked before the index sees it, the shared limit applies, and a cursor the index
   * can't use is 400, or 410 when it's stale.
   */
  async function pageOf(c: Context, read: (before: string | undefined) => Promise<ConversationPage | undefined>): Promise<Response> {
    const cursors = c.req.queries('before');
    if (cursors !== undefined && cursors.length !== 1) return c.body(null, 400);
    const before = cursors?.[0];
    if (before !== undefined && !isWellFormedCursor(before)) return c.body(null, 400);
    if (conversationReads >= MAX_CONVERSATION_READS) {
      c.header('Retry-After', '1');
      return c.body(null, 429);
    }
    conversationReads += 1;
    let page;
    try {
      page = await read(before);
    } catch (error) {
      if (error instanceof ConversationCursorError) {
        return c.body(null, error.reason === 'stale' ? STALE_CURSOR_STATUS : 400);
      }
      throw error;
    } finally {
      conversationReads -= 1;
    }
    if (!page) return c.body(null, 404);
    return c.json(page);
  }

  // Read from the transcript, a page at a time and at most about 8 MiB per
  // page, only for sessions in the latest snapshot. The guard checks the id
  // first, and the cursor is checked before the index sees it.
  app.get(CONVERSATION_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store');
    const lookup = resolveSession(indexer, c.req.param('sessionId'));
    if (!lookup.ok) return c.body(null, lookup.status);
    return pageOf(c, (before) => indexer.conversation(lookup.session.sessionId, before));
  });

  // A listed session's sub-agents (W76), from its folder and its transcripts. Under the same limit
  // as the pages, since it can read what's new in every sub-agent's transcript.
  app.get(SUBAGENTS_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store');
    const lookup = resolveSession(indexer, c.req.param('sessionId'));
    if (!lookup.ok) return c.body(null, lookup.status);
    if (conversationReads >= MAX_CONVERSATION_READS) {
      c.header('Retry-After', '1');
      return c.body(null, 429);
    }
    conversationReads += 1;
    try {
      const list = await indexer.subagents(lookup.session.sessionId);
      return list === undefined ? c.body(null, 404) : c.json(list);
    } finally {
      conversationReads -= 1;
    }
  });

  // One of a listed session's sub-agents' own transcript, paged as the session's is (W76). The
  // agent id is checked before the index sees it, and the index finds its file only by listing
  // the session's folder, never by building a path from the id.
  app.get(SUBAGENT_CONVERSATION_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store');
    const lookup = resolveSession(indexer, c.req.param('sessionId'));
    if (!lookup.ok) return c.body(null, lookup.status);
    const agentId = c.req.param('agentId');
    if (agentId === undefined || !isSafeAgentId(agentId)) return c.body(null, 404);
    return pageOf(c, (before) => indexer.subagentConversation(lookup.session.sessionId, agentId, before));
  });

  routes?.(app);

  app.all('/api/*', (c) => c.body(null, 404));

  // A plain request to a WebSocket path, without an upgrade.
  app.all(WS_PATH, (c) => c.body(null, 426));
  app.all(ATTACH_PATH, (c) => c.body(null, 426));

  // Loaded by the "still building" page so it reloads itself, keeping the URL
  // and its #token fragment. Served from here because webRoot doesn't exist yet.
  app.get(BUILDING_SCRIPT_PATH, (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    return c.body(BUILDING_SCRIPT);
  });

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
