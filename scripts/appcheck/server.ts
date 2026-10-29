// The fake pitwall server the app check drives the web UI against. It serves the production build
// with pitwall's own security headers and CSP, its Host and Origin checks, its static file rules and
// the v3 WebSocket challenge, all imported from the server build (dist/server, dist/shared), never
// copied. Behind them it answers the snapshot, the directory list, conversation pages, the relay,
// attach (a made-up terminal screen at the size the page gives, drawn again on each resize), spawn,
// stop, remove, resume and end session (W90), which signals nothing, and a session's sub-agents and
// their transcripts (W77), from the made-up
// World in fixtures.ts, the editor list and open in an editor (W72), which opens nothing, and New
// session's uploads (W82), with the contract's checks, keeping nothing of a file but its size, and
// your made-up open pull requests (W95): GET PRS_PATH, the 'prs' message right after the first
// snapshot and on each change, and POST PRS_REFRESH_PATH, with the contract's 409 and 429; and
// recaps (W111), off unless a case turns them on: GET recapPath() and POST recapRefreshPath().
// Clone and start (W107), POST CLONE_PATH, which clones nothing: the world places the repo's PRs under
// a made-up clone a moment later, as discovery would.
//
// It never runs `claude`, reads no transcript, `~/.claude`, `.env` or `~/.pitwall`, and holds no real
// token: the token is random per run and only ever reaches the page in its URL's fragment. It imports
// only security.js, static.js and protocol.js from the build, which read nothing but webRoot.
//
// What the page did is recorded in `records`, for the parts to check: attaches, keys and resizes sent
// to an attached session, the sizes it gave each one, spawns, relayed messages, stops and removes,
// resumes, opens in an editor, ends, uploads, refreshes of the PR list, and every request.

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type {
  ActionResult,
  CloneResult,
  AttachClientMessage,
  AttachmentResult,
  AttachmentType,
  ConversationPage,
  DirectoryList,
  EditorId,
  EditorList,
  EndSessionResult,
  IndexSnapshot,
  PullRequestList,
  RecapRefreshResult,
  RelayResult,
  SessionRecap,
  ResumeResult,
  SessionSummary,
  SpawnRequest,
  SpawnResult,
  SubagentList,
} from '../../src/shared/protocol.js';
import { COPY_SHORT_ID, NAMES, RECAP_CALL_MS, terminalScreen, World, type ResetOptions, type TerminalSize } from './fixtures.js';

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
  /** Every size the page gave an attached session, in order: its `open`'s, then each resize's (W74). */
  sizes: Array<{ name: string; from: 'open' | 'resize' } & TerminalSize>;
  /** `attachments` only when the request had them (W82). */
  spawns: Array<{ cwd: string; name?: string | undefined; model?: string | undefined; promptLength: number; attachments?: string[] | undefined }>;
  /**
   * Each upload to ATTACHMENTS_PATH (W82), in the order they were answered: its name, type and size,
   * the status it got, and its id when kept. `aborted` is one the page gave up on before its answer.
   */
  uploads: Array<{ name: string; type: string; size: number; status: number | 'aborted'; id?: string }>;
  /** Each DELETE of attachmentPath() (W82), by the id asked for, and the status it got: 204, 404 or 409. */
  deletes: Array<{ id: string; status: number }>;
  relays: Array<{ name: string; length: number }>;
  actions: Array<{ action: 'stop' | 'remove'; name: string }>;
  /** Each resume of an ended session the server answered (W67), by the session's name. */
  resumes: string[];
  /** Each open in an editor the server answered (W72), by the session's name and the editor's id. Nothing is opened. */
  opens: Array<{ name: string; editor: EditorId }>;
  /** Each End session the server answered (W90), by the session's name, whether it was sent with `whileWorking`, and its status. Nothing is signalled. */
  ends: Array<{ name: string; whileWorking: boolean; status: number }>;
  /** Each refresh of the PR list the server answered (W95), by its status: 200, 409 or 429. */
  refreshes: number[];
  /** Each GET of a session's recap (W111), by the session's name and its status: 200 or 404. */
  recapFetches: Array<{ name: string; status: number }>;
  /** Each POST asking for a new recap (W111), by the session's name and its status: 200, 404, 409 or 429. */
  recapRefreshes: Array<{ name: string; status: number }>;
  /** Each Clone and start the server answered (W107): the repo the page sent, and the status it got. */
  clones: Array<{ repo: unknown; status: number }>;
  /** Every HTTP request and upgrade, as `METHOD /path status`. */
  requests: string[];
}

const emptyRecords = (): Records => ({
  attaches: [],
  inputs: [],
  sizes: [],
  spawns: [],
  relays: [],
  actions: [],
  resumes: [],
  opens: [],
  ends: [],
  refreshes: [],
  recapFetches: [],
  recapRefreshes: [],
  clones: [],
  uploads: [],
  deletes: [],
  requests: [],
});

/** How long a made-up clone takes, so Clone shows it's busy (W107). */
const CLONE_MS = 600;

/** How long a refresh's made-up fetch takes, so Refresh shows its spinner (W95). */
const PRS_FETCH_MS = 700;

/** A name the contract's 400 refuses: a path separator, a control or a bidi control (ATTACHMENTS_PATH). */
const UNSAFE_NAME = /[/\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** The first bytes an image or a PDF starts with; text types have none to check. */
const SIGNATURES: Partial<Record<AttachmentType, (head: Buffer) => boolean>> = {
  'image/png': (head) => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (head) => head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  'image/gif': (head) => /^GIF8[79]a/.test(head.subarray(0, 6).toString('latin1')),
  'image/webp': (head) => head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (head) => head.subarray(0, 5).toString('latin1') === '%PDF-',
};

/**
 * Names the fake server answers differently, for the steps that check an upload's busy state and a
 * failure: one starting SLOW_UPLOAD is answered after a moment; one starting FAIL_UPLOAD gets a 500,
 * a file that couldn't be written, the first time it's sent; one starting UNAVAILABLE_UPLOAD a
 * 503, as from a pitwall that keeps no attachments on its machine; and STALLED_UPLOAD below a 408.
 */
export const SLOW_UPLOAD = 'pitwall-test-slow';
export const FAIL_UPLOAD = 'pitwall-test-fail';
export const UNAVAILABLE_UPLOAD = 'pitwall-test-unavailable';
/** A name the fake server answers 408, as W79's route does an upload that stalls, keeping nothing. */
export const STALLED_UPLOAD = 'pitwall-test-stalled';

/** Text that's UTF-8 with no NUL, as W79's route wants of a text or JSON file. */
function isText(body: Buffer): boolean {
  try {
    return !new TextDecoder('utf-8', { fatal: true }).decode(body).includes('\u0000');
  } catch {
    return false;
  }
}

/** The session whose opens in an editor the fake server answers with 429, past the opens a minute (W87), and what it says. */
export const OPEN_LIMITED = NAMES.running2;
export const OPEN_LIMITED_ERROR = 'pitwall opens at most 10 directories in an editor every 60 seconds. Try again in 42s.';

/**
 * End session's answers (W90), by the session's name, in the server's words (src/server/end.ts):
 * END_WORKING's turn is running, as a prompt on screen makes it, and END_SUBAGENTS' sub-agents are,
 * so each gets the 409 with `working` until it's sent `whileWorking`; END_REFUSED's process changed
 * while pitwall checked it; END_LIMITED is past the 5 ends a minute. Every other running interactive
 * session ends, and is listed as ended a moment later.
 */
export const END_WORKING = NAMES.waiting;
export const END_SUBAGENTS = NAMES.inApi;
export const END_REFUSED = NAMES.conversation;
export const END_REFUSED_ERROR = "Its process changed while pitwall checked it, so pitwall didn't signal it.";
export const END_LIMITED = NAMES.fromRoot;
export const END_LIMITED_ERROR = 'pitwall ends at most 5 sessions every 60 seconds. Try again in 42s.';

/** The editors the fake server says it found at startup (W72), as pitwall's would on a Mac with both. */
export const EDITORS: EditorList = { editors: [{ id: 'vscode', label: 'VS Code' }, { id: 'cursor', label: 'Cursor' }] };

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
  /** Sends the PR list to every authenticated index socket, as the PR poller does after a change (W95). */
  broadcastPrs(): void;
  /**
   * The order a resume's answer and the snapshot that follows it arrive in (W67), for the steps that
   * check the other order; reset() puts both back to false. `listedFirst`: NAMES.ended is listed as
   * running before the 200, which comes a moment later, as a poll can beat the answer. `copyReopens`:
   * a moment after NAMES.endedCopy's 409, the snapshot lists the original as running in its terminal,
   * as the next poll most likely does, since the server polls soon before it answers.
   */
  readonly resumeOrder: { listedFirst: boolean; copyReopens: boolean };
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
  world.setRecapBudget(protocol.RECAP_DAILY_BUDGET);
  let records = emptyRecords();
  // The uploads kept (W82), by id, and the names that have had their one failure.
  const uploaded = new Map<string, { used: boolean }>();
  const failedOnce = new Set<string>();
  const resumeOrder = { listedFirst: false, copyReopens: false };
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
  const broadcastPrs = () => {
    const message = JSON.stringify({ type: 'prs', prs: world.prList() satisfies PullRequestList });
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
    if (method === 'GET' && url.pathname === protocol.DIRECTORIES_PATH) return json(res, 200, world.directories() satisfies DirectoryList);
    if (method === 'GET' && url.pathname === protocol.EDITORS_PATH) return json(res, 200, EDITORS);
    if (method === 'GET' && url.pathname === protocol.PRS_PATH) return json(res, 200, world.prList() satisfies PullRequestList);
    if (method === 'POST' && url.pathname === protocol.PRS_REFRESH_PATH) return refreshPrs(req, res);
    if (method === 'POST' && url.pathname === protocol.CLONE_PATH) return clone(req, res);
    if (method === 'POST' && url.pathname === protocol.SPAWN_PATH) return spawn(req, res);
    if (method === 'POST' && url.pathname === protocol.ATTACHMENTS_PATH) return upload(req, res);
    // An unused upload removed (W82): attachmentPath(id).
    const kept = /^\/api\/attachments\/([^/]+)$/.exec(url.pathname);
    if (kept && method === 'DELETE') return removeUpload(res, decodeURIComponent(kept[1]!));

    // A sub-agent's transcript (W77): 404 unless the session is listed and the agent is one of its sub-agents.
    const agent = /^\/api\/sessions\/([^/]+)\/subagents\/([^/]+)\/conversation$/.exec(url.pathname);
    if (agent && method === 'GET') {
      const before = url.searchParams.get('before') ?? undefined;
      const page = world.subagentConversation(decodeURIComponent(agent[1]!), decodeURIComponent(agent[2]!), before);
      // A cursor it doesn't know is stale, as the real route's is.
      if (!page) return end(res, before === undefined ? 404 : 410);
      return json(res, 200, page satisfies ConversationPage);
    }

    // Refresh a session's recap (W111): recapRefreshPath(id).
    const recapRefresh = /^\/api\/sessions\/([^/]+)\/recap\/refresh$/.exec(url.pathname);
    if (recapRefresh && method === 'POST') return refreshRecap(req, res, decodeURIComponent(recapRefresh[1]!));

    const match = /^\/api\/sessions\/([^/]+)\/(conversation|relay|stop|remove|resume|open|subagents|end|recap)$/.exec(url.pathname);
    if (!match) return end(res, 404);
    const session = world.session(decodeURIComponent(match[1]!));
    if (!session) return end(res, 404);
    const route = match[2];
    if (route === 'conversation' && method === 'GET') return json(res, 200, world.conversation(session.sessionId) satisfies ConversationPage | undefined);
    if (route === 'subagents' && method === 'GET') return json(res, 200, world.subagents(session.sessionId) satisfies SubagentList | undefined);
    if (route === 'recap' && method === 'GET') {
      // recapPath(id) (W111): the session's whole recap, or 404 while it has none, as the contract says.
      const recap = world.recapHealth() ? world.recap(session.sessionId) : undefined;
      records.recapFetches.push({ name: session.name, status: recap ? 200 : 404 });
      return recap ? json(res, 200, recap satisfies SessionRecap) : end(res, 404);
    }
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
    if (route === 'resume' && method === 'POST') return resume(req, res, session.sessionId);
    if (route === 'open' && method === 'POST') return openInEditor(req, res, session.sessionId);
    if (route === 'end' && method === 'POST') return endSession(req, res, session.sessionId);
    return end(res, 405);
  }

  /**
   * End session (W90), with the server's body check and words (src/server/end.ts): JSON, `{}` or
   * `{ whileWorking: true }`, for a running interactive session. It answers each by its name (END_*),
   * records the end, signals nothing, and lists one it ended as ended a moment later, as the index
   * lists it on the poll after (W67).
   */
  async function endSession(req: IncomingMessage, res: ServerResponse, sessionId: string) {
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) return json(res, 400, { ok: false, error: 'Send the request as application/json.' } satisfies EndSessionResult);
    const body = await readJson(req);
    const keys = isRecord(body) ? Object.keys(body) : undefined;
    const whileWorking = keys?.length === 1 && keys[0] === 'whileWorking' && isRecord(body) && body.whileWorking === true;
    if (!(keys?.length === 0 || whileWorking)) return json(res, 400, { ok: false, error: 'The body must be {} or { "whileWorking": true }.' } satisfies EndSessionResult);
    const session = world.session(sessionId);
    if (!session) return end(res, 404);
    const answer = (status: number, result: EndSessionResult) => {
      records.ends.push({ name: session.name, whileWorking, status });
      return json(res, status, result);
    };
    if (session.kind !== 'interactive' || session.ended || !session.alive) {
      return answer(409, { ok: false, error: 'Only a running interactive session can be ended from pitwall. Stop a background session instead.' });
    }
    if (session.name === END_REFUSED) return answer(409, { ok: false, error: END_REFUSED_ERROR });
    if (session.name === END_LIMITED) {
      res.setHeader('Retry-After', '42');
      return answer(429, { ok: false, error: END_LIMITED_ERROR });
    }
    if (!whileWorking && session.name === END_WORKING) {
      return answer(409, { ok: false, error: "pitwall didn't end it: its turn is still running. Ending it now loses a reply being written and stops what it's running.", working: { turn: 'running' } });
    }
    if (!whileWorking && session.name === END_SUBAGENTS) {
      return answer(409, { ok: false, error: "pitwall didn't end it: 2 sub-agents are running. Ending it now loses a reply being written and stops what it's running.", working: { subagents: 2 } });
    }
    // Checked, signalled and gone within the server's wait, so it answers after a moment.
    later(300, () => {
      answer(200, { ok: true, ended: true });
      later(options.listDelayMs ?? 800, () => {
        world.end(sessionId);
        broadcast();
      });
    });
  }

  /**
   * Refresh the PR list (W95), as the contract and W93's route (src/server/prs.ts) have it, in its
   * words: no body is read; 409 with pull requests off; 200 while a fetch runs, which it leaves to finish;
   * 429 with Retry-After within PRS_REFRESH_MIN_MS of the latest fetch's start; otherwise 200, and the
   * list as a 'prs' message, refreshing, then fetched a moment later.
   */
  async function refreshPrs(req: IncomingMessage, res: ServerResponse) {
    await readJson(req);
    const answer = world.refreshPrs(protocol.PRS_REFRESH_MIN_MS);
    if (answer.result === 'off') {
      records.refreshes.push(409);
      return json(res, 409, { ok: false, error: 'Pull requests are off: pitwall was started with --no-prs, so it never runs gh.' } satisfies ActionResult);
    }
    // A fetch is running: ok, and its list comes as a 'prs' message, as the real route answers.
    if (answer.result === 'running') {
      records.refreshes.push(200);
      return json(res, 200, { ok: true } satisfies ActionResult);
    }
    if (answer.result === 'soon') {
      records.refreshes.push(429);
      res.setHeader('Retry-After', String(answer.seconds));
      return json(res, 429, { ok: false, error: `Your pull requests were fetched moments ago. Try again in ${answer.seconds} ${answer.seconds === 1 ? 'second' : 'seconds'}.` } satisfies ActionResult);
    }
    records.refreshes.push(200);
    json(res, 200, { ok: true } satisfies ActionResult);
    broadcastPrs();
    later(PRS_FETCH_MS, () => {
      answer.done();
      broadcastPrs();
    });
  }

  /**
   * Ask for a new recap (W111), as the contract has recapRefreshPath() answer, in made-up words: no
   * body is read; 404 for a session it doesn't list or with no transcript, 409 with recaps off, 429,
   * with `busy`, with the day's budget spent or a call for it running, otherwise 200, and the new recap in the snapshot a moment
   * later, or, while recaps are failing, none.
   */
  async function refreshRecap(req: IncomingMessage, res: ServerResponse, sessionId: string) {
    await readJson(req);
    const session = world.session(sessionId);
    const answer = session ? world.refreshRecap(sessionId) : ({ result: 'not-recapped' } as const);
    const record = (status: number) => {
      if (session) records.recapRefreshes.push({ name: session.name, status });
    };
    if (answer.result === 'off') {
      record(409);
      return json(res, 409, { ok: false, error: 'Made up: recaps are off, as with --no-recaps.' } satisfies ActionResult);
    }
    if (answer.result === 'not-recapped') {
      record(404);
      return json(res, 404, { ok: false, error: "Made up: pitwall can't recap this session: it has no transcript pitwall can read." } satisfies ActionResult);
    }
    if (answer.result === 'spent' || answer.result === 'running') {
      record(429);
      return json(res, 429, { ok: false, error: answer.result === 'spent' ? "Made up: today's recaps are used up." : 'Made up: a recap of it is already being made.', busy: answer.result } satisfies RecapRefreshResult);
    }
    record(200);
    json(res, 200, { ok: true } satisfies ActionResult);
    later(RECAP_CALL_MS, () => {
      answer.done();
      broadcast();
    });
  }

  /**
   * Clone and start (W107), with src/server/clone.ts's statuses and words: the page sends only the repo,
   * and the world decides where. Cloned, it answers 201 with the new directory and the command that
   * trusts it a moment later, and the PR list then places the repo's PRs under the made-up clone.
   */
  async function clone(req: IncomingMessage, res: ServerResponse) {
    const answer = (status: number, body: CloneResult, repo: unknown) => {
      records.clones.push({ repo, status });
      json(res, status, body);
    };
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) return answer(415, { ok: false, error: 'Send the request as application/json.' }, undefined);
    const body = await readJson(req);
    const repo = isRecord(body) ? body.repo : undefined;
    if (!isRecord(body) || typeof repo !== 'string' || Object.keys(body).length !== 1) return answer(400, { ok: false, error: 'The repo must be owner/name, as GitHub names it.' }, repo);
    const cloned = world.clone(repo);
    if (cloned.result === 'missing') return answer(404, { ok: false, error: `${repo} isn't the repo of any of your open pull requests that pitwall lists.` }, repo);
    if (cloned.result === 'placed') return answer(409, { ok: false, error: `${repo} is cloned already.` }, repo);
    later(CLONE_MS, () => {
      if (cloned.result !== 'cloned') {
        answer(502, { ok: false, error: `gh couldn't clone ${repo} (exit code 1). Check that you can open it on GitHub and that gh auth status works, then try again.` }, repo);
        return;
      }
      answer(201, { ok: true, cwd: cloned.cwd, hint: `cd ${cloned.cwd} && claude` }, repo);
      broadcastPrs();
    });
  }

  /**
   * Open in an editor (W72), with pitwall's own checks and words (src/server/editors.ts): JSON, `{ editor }`
   * alone with an editor in EDITORS, and a directory that's there. It records the open and opens nothing.
   */
  async function openInEditor(req: IncomingMessage, res: ServerResponse, sessionId: string) {
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) return json(res, 400, { ok: false, error: 'Send the request as application/json.' } satisfies ActionResult);
    const body = await readJson(req);
    const editor = isRecord(body) && Object.keys(body).length === 1 ? EDITORS.editors.find((each) => each.id === body.editor) : undefined;
    if (!editor) return json(res, 400, { ok: false, error: "That isn't an editor pitwall knows." } satisfies ActionResult);
    const session = world.session(sessionId);
    if (!session) return end(res, 404);
    if (session.cwdMissing) return json(res, 409, { ok: false, error: `Its directory, ${session.cwd}, no longer exists.` } satisfies ActionResult);
    // Past the opens a minute (W87), for one session by its name, in pitwall's words: it opened nothing.
    if (session.name === OPEN_LIMITED) {
      res.setHeader('Retry-After', '42');
      return json(res, 429, { ok: false, error: OPEN_LIMITED_ERROR } satisfies ActionResult);
    }
    records.opens.push({ name: session.name, editor: editor.id });
    return json(res, 200, { ok: true } satisfies ActionResult);
  }

  /**
   * The 422 for a directory Claude Code doesn't trust, in W66's words (untrustedResult() in
   * src/server/actions.ts): Claude Code's line, with the command that trusts it, or, for a path with a
   * `'` or `\`, which shells don't all read the same way, with none (W87). Every made-up path but those
   * is a plain word.
   */
  function untrusted(cwd: string): ResumeResult {
    const line = `Workspace not trusted. Run \`claude\` in ${cwd} once and accept the trust prompt, then retry.`;
    return /['\\]/.test(cwd) ? { ok: false, error: line } : { ok: false, error: line, hint: `cd ${cwd} && claude` };
  }

  /**
   * Resume in background (W67): NAMES.ended resumes, and is listed as a running background session a
   * moment later, as the index lists it on a later poll; each other ended session fails one way, by
   * its name, with W66's status and words (src/server/actions.ts), the paths made up.
   */
  function resume(req: IncomingMessage, res: ServerResponse, sessionId: string) {
    const session = world.session(sessionId);
    // An ended session, or since W107 a background one that isn't running.
    if (!session?.ended && !(session?.kind === 'background' && !session.alive)) {
      return json(res, 409, { ok: false, error: "Only an interactive session that has ended, or a background session that isn't running, can be resumed from pitwall." } satisfies ResumeResult);
    }
    if (session.cwdMissing) {
      return json(res, 409, { ok: false, error: `It started in ${session.cwd}, which no longer exists, and Claude Code resumes a session only from where it started.` } satisfies ResumeResult);
    }
    records.resumes.push(session.name);
    switch (session.name) {
      case NAMES.endedAsked:
        return json(res, 422, untrusted(session.cwd) satisfies ResumeResult);
      case NAMES.endedCopy:
        json(res, 409, {
          ok: false,
          error: `It was open in another Claude Code process after all, so Claude Code started a copy as ${COPY_SHORT_ID} instead. The copy is listed as a background session with no name, which you can stop and remove.`,
          copyShortId: COPY_SHORT_ID,
        } satisfies ResumeResult);
        if (resumeOrder.copyReopens) {
          later(options.listDelayMs ?? 800, () => {
            world.reopen(sessionId);
            broadcast();
          });
        }
        return;
      case NAMES.endedBusy:
        res.setHeader('Retry-After', '1');
        return json(res, 429, { ok: false, error: 'pitwall is already running 4 stop, remove, resume or open commands. Try again in a moment.' } satisfies ResumeResult);
      case NAMES.endedRefused:
        return json(res, 409, { ok: false, error: "It's running again, in a terminal or in the background, so pitwall didn't resume it: that would start a copy." } satisfies ResumeResult);
      case NAMES.endedSlow:
        return json(res, 504, { ok: false, error: "claude --resume didn't finish within 30s. The session may still appear in the list." } satisfies ResumeResult);
      case NAMES.endedNoAnswer:
        // No answer at all: the connection closes, as when pitwall stops in the middle of one.
        req.socket.destroy();
        return;
    }
    const resumed = world.resume(sessionId);
    const answer = () => json(res, 200, { ok: true, shortId: resumed.shortId } satisfies ResumeResult);
    const list = () => {
      resumed.list();
      broadcast();
    };
    if (resumeOrder.listedFirst) {
      list();
      later(options.listDelayMs ?? 800, answer);
      return;
    }
    answer();
    later(options.listDelayMs ?? 800, list);
  }

  /**
   * An upload for New session's first prompt (W82), with the checks of W79's route
   * (src/server/attachments.ts), in its order: the type, a Content-Encoding other than identity, the
   * name, a Content-Length over the limit; then, as its store has them, no attachments here (503),
   * too many unused (429, with Retry-After), and, as the bytes arrive, a stall (408), the size, an
   * empty file, and that an image's or a PDF's first bytes are that type's and text is UTF-8 with no
   * NUL. It keeps the name, type and size, never the bytes.
   */
  async function upload(req: IncomingMessage, res: ServerResponse) {
    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const header = req.headers['x-pitwall-filename'];
    let name = '';
    try {
      name = typeof header === 'string' ? decodeURIComponent(header) : '';
    } catch {
      // Not URL-encoded: refused below, as an empty name.
    }
    const { size, body: bytes } = await readUpload(req);
    const head = bytes.subarray(0, 16);
    const answer = (status: number, body: AttachmentResult) => {
      records.uploads.push({ name, type, size, status, ...(body.ok ? { id: body.attachment.id } : {}) });
      json(res, status, body);
    };
    if (!(protocol.ATTACHMENT_TYPES as readonly string[]).includes(type)) return answer(415, { ok: false, error: 'Made up: pitwall takes images, PDFs and text files.' });
    const encoding = req.headers['content-encoding'];
    if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') return answer(415, { ok: false, error: 'Made up: no Content-Encoding.' });
    const known = type as AttachmentType;
    const clean = name.normalize('NFC').trim();
    if (UNSAFE_NAME.test(name) || clean === '' || clean.length > 200) return answer(400, { ok: false, error: 'Made up: that name has a character pitwall refuses.' });
    if (Number(req.headers['content-length'] ?? 0) > protocol.ATTACHMENT_MAX_BYTES) return answer(413, { ok: false, error: 'Made up: it is over 10 MiB.' });
    if (name.startsWith(UNAVAILABLE_UPLOAD)) return answer(503, { ok: false, error: "Made up: this pitwall doesn't keep attachments." });
    if ([...uploaded.values()].filter((each) => !each.used).length >= protocol.ATTACHMENTS_MAX_PENDING) {
      res.setHeader('Retry-After', '3600');
      return answer(429, { ok: false, error: 'Made up: too many unused uploads.' });
    }
    if (name.startsWith(STALLED_UPLOAD)) return answer(408, { ok: false, error: 'Made up: the upload stalled, so pitwall kept nothing.' });
    if (size > protocol.ATTACHMENT_MAX_BYTES) return answer(413, { ok: false, error: 'Made up: it is over 10 MiB.' });
    if (size === 0) return answer(400, { ok: false, error: 'Made up: the file is empty.' });
    if (SIGNATURES[known] && !SIGNATURES[known](head)) return answer(415, { ok: false, error: `Made up: its first bytes aren't those of ${known}.` });
    if (!SIGNATURES[known] && !isText(bytes)) return answer(415, { ok: false, error: "Made up: it isn't UTF-8 text." });
    if (name.startsWith(FAIL_UPLOAD) && !failedOnce.has(name)) {
      failedOnce.add(name);
      return answer(500, { ok: false, error: "Made up: pitwall couldn't write it." });
    }
    const keep = () => {
      const id = randomUUID();
      uploaded.set(id, { used: false });
      answer(201, { ok: true, attachment: { id, name: clean, type: known, size } });
    };
    if (!name.startsWith(SLOW_UPLOAD)) return keep();
    // A slow one: the page may give up first, as Remove does.
    res.on('close', () => {
      if (!res.writableFinished) records.uploads.push({ name, type, size, status: 'aborted' });
    });
    later(1200, () => {
      if (!res.destroyed) keep();
    });
  }

  /** DELETE attachmentPath(id) (W82): 204 for an upload no spawn has used, 404 for one it doesn't know, 409 for one a spawn used. */
  function removeUpload(res: ServerResponse, id: string) {
    const kept = uploaded.get(id);
    const status = kept === undefined ? 404 : kept.used ? 409 : 204;
    records.deletes.push({ id, status });
    if (status === 204) {
      uploaded.delete(id);
      return end(res, 204);
    }
    return json(res, status, { ok: false, error: status === 404 ? 'Made up: no upload with that id.' : 'Made up: a session has used it.' } satisfies AttachmentResult);
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
    // The files (W82): uploads this server kept and no spawn has used, each once, at most ATTACHMENTS_MAX_PER_SESSION.
    let attachments: string[] | undefined;
    if (body.attachments !== undefined) {
      const ids = body.attachments;
      const usable =
        Array.isArray(ids) &&
        ids.length <= protocol.ATTACHMENTS_MAX_PER_SESSION &&
        new Set(ids).size === ids.length &&
        ids.every((id) => typeof id === 'string' && uploaded.get(id)?.used === false);
      if (!usable) return json(res, 400, { ok: false, error: 'Made up: an attachment that is unknown or already used.' } satisfies SpawnResult);
      attachments = ids as string[];
      for (const id of attachments) uploaded.set(id, { used: true });
    }
    const request: SpawnRequest = {
      cwd: body.cwd,
      prompt: body.prompt,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(attachments ? { attachments } : {}),
    };
    records.spawns.push({ cwd: request.cwd, name: request.name, model: request.model, promptLength: request.prompt.length, attachments: request.attachments });
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
        // Right after the first snapshot, as the server sends it (W95).
        ws.send(JSON.stringify({ type: 'prs', prs: world.prList() }));
        indexSockets.add(ws);
      },
      () => {},
    );
  }

  function attachSocket(ws: WebSocket) {
    let opened: { session: SessionSummary } | undefined;
    ws.on('close', () => attachSockets.delete(ws));
    /** The made-up screen at the session's size, drawn afresh, as Claude Code redraws on a resize. */
    const draw = (session: SessionSummary, size: TerminalSize) => ws.send(Buffer.from(terminalScreen(session, size), 'utf8'), { binary: true });
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
          const { name } = opened.session;
          records.inputs.push({ name, type: message.type, data: message.type === 'input' ? message.data : `${message.cols}x${message.rows}` });
          if (message.type === 'resize') {
            records.sizes.push({ name, from: 'resize', cols: message.cols, rows: message.rows });
            draw(opened.session, message);
          }
          return;
        }
        if (message.type !== 'open' || opened) return;
        const session = world.session(message.sessionId);
        if (!session || session.kind !== 'background') {
          ws.send(JSON.stringify({ type: 'error', error: 'Made up: no such background session.' }));
          return ws.close(1008);
        }
        if ((session.finished || !session.alive) && message.restart !== true) return ws.send(JSON.stringify({ type: 'needs-restart' }));
        opened = { session };
        records.attaches.push({ sessionId: session.sessionId, name: session.name, restart: message.restart === true });
        records.sizes.push({ name: session.name, from: 'open', cols: message.cols, rows: message.rows });
        ws.send(JSON.stringify({ type: 'attached' }));
        draw(session, message);
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
    resumeOrder,
    reset(resetOptions) {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const ws of [...indexSockets, ...attachSockets]) ws.terminate();
      world.reset(resetOptions);
      records = emptyRecords();
      uploaded.clear();
      failedOnce.clear();
      resumeOrder.listedFirst = false;
      resumeOrder.copyReopens = false;
    },
    clearRecords() {
      records = emptyRecords();
    },
    broadcast,
    broadcastPrs,
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

/** An upload's body, for its checks, and how many bytes it had: past the limit, only the count goes on. */
function readUpload(req: IncomingMessage, limit = 10 * 1024 * 1024): Promise<{ size: number; body: Buffer }> {
  return new Promise((resolve) => {
    const kept: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      if (size <= limit) kept.push(chunk);
      size += chunk.length;
    });
    const done = () => resolve({ size, body: Buffer.concat(kept) });
    req.on('end', done);
    req.on('error', done);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
