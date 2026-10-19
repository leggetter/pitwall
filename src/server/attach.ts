// The attach socket at ATTACH_PATH (W10, D3, D9): a PTY running
// `claude attach <shortId>` for one background session, carried over a
// WebSocket. Host and the required Origin are checked before the upgrade, in
// server.ts, exactly as for WS_PATH.
//
//   server  challenge                 the handshake (handshake.ts), within 5 s, else 4401
//   client  auth
//   server  ready                     or close 4429 when MAX_ATTACHED sockets are already past
//                                     the handshake, server-wide
//   client  open                      sessionId, cols, rows, and restart once the user confirmed
//   server  needs-restart             the session has finished or crashed (attachDecision), and
//                                     restart wasn't true: the socket waits for another open
//   server  error                     the session is still starting: try again in a moment,
//                                     then close 1013
//   server  attached                  then the PTY's output as binary frames
//   client  input / resize            any number
//   server  exit                      `claude attach` ended on its own; then close 1000
//
// Whether attaching would restart the session is decided on `open`, not from
// the snapshot alone, which can be a poll old: see attachDecision().
//
// Anything malformed or out of order gets `error` and close 1008. The session
// is resolved with resolveSession(), and the command is built from the
// resolved summary's shortId, never from the client's id. The PTY gets the
// server's environment through childEnvironment() (command.ts), the scrubber
// every child of pitwall goes through.
//
// Closing the socket kills the PTY, which ends `claude attach` and detaches:
// the session keeps running (spike S3). close() does the same for every PTY.
import type { IncomingMessage } from 'node:http';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { createAgentsSource, type AgentsSource } from '../index/agents.js';
import type { Indexer } from '../index/index.js';
import {
  MAX_ATTACHED,
  WS_CLOSE_TOO_MANY,
  type AttachClientMessage,
  type AttachServerMessage,
  type BackgroundState,
  type SessionSummary,
} from '../shared/protocol.js';
import { parseJsonObject, startHandshake, WS_CLOSE_TRY_AGAIN, type HandshakeSlots } from './handshake.js';
import { childEnvironment } from './command.js';
import type { PtyProcess, PtySpawner } from './pty.js';
import type { RecentSpawns } from './recentSpawns.js';
import { resolveSession } from './sessions.js';

/**
 * Incoming frames are capped at this many bytes; a bigger one closes the
 * socket with 1009. The web UI sends input in chunks well under it, so a
 * large paste arrives as several `input` messages.
 */
export const ATTACH_MAX_PAYLOAD_BYTES = 64 * 1024;

/** The terminal sizes `open` and `resize` accept, inclusive. */
export const COLS_RANGE = { min: 2, max: 500 } as const;
export const ROWS_RANGE = { min: 2, max: 200 } as const;

/** Close code for a malformed or out-of-order message, or an `open` that was refused. */
export const WS_CLOSE_POLICY = 1008;

/** Pause the PTY's output while more than this many bytes wait to go out on the socket. */
const HIGH_WATER_BYTES = 1024 * 1024;

/** How long a PTY has to exit after SIGHUP before it gets SIGKILL. */
const KILL_GRACE_MS = 3000;

/** How long close() waits for sockets to finish the close handshake. */
const CLOSE_GRACE_MS = 250;

/** A short id `claude attach` can take as one argument: never empty, never an option such as `--help`. */
const SAFE_SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * A working or blocked session with no process, started less than this long
 * ago, is taken to be starting rather than crashed. `startedAt` in `claude
 * agents --json` is when the job was created (it matches `createdAt` in the
 * job's state), so it's the spawn time for a new session, but not for one
 * that was restarted: those rely on RecentSpawns, or are asked about.
 */
export const STARTING_GRACE_MS = 20_000;

/** How long the re-read of `claude agents --json --all` on `open` may take. It usually takes about 0.15 s. */
export const REREAD_TIMEOUT_MS = 5_000;

/** Close code for a session that's still starting: the client may try again. */
export { WS_CLOSE_TRY_AGAIN };

/** The answer to `open` for a session that's starting. */
export const STILL_STARTING = 'This session is still starting. Try again in a moment.';

export interface AttachOptions {
  indexer: Pick<Indexer, 'latest'>;
  token: string;
  /** The server's one allowed origin, which the proof is bound to. Read at each handshake, because the port is known only once listening. */
  origin: () => string;
  authTimeoutMs: number;
  spawnPty: PtySpawner;
  /** Default 'claude'. */
  claudeBin?: string;
  /** The environment the PTY's is made from. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Called after a valid proof, whether or not the socket then gets a place. */
  onAuthenticated?: () => void;
  /** The server's pending-handshake count, shared with WS_PATH. */
  slots?: HandshakeSlots;
  /** Re-read on `open` when the snapshot shows no live process. Default createAgentsSource(), the index's own source. */
  agents?: Pick<AgentsSource, 'list'>;
  /** The short ids this pitwall spawned recently (actions.ts). */
  spawned?: Pick<RecentSpawns, 'has'>;
  /** Whether a pid is still running. Default: process.kill(pid, 0). */
  processAlive?: (pid: number) => boolean;
  /** Milliseconds since the epoch. Default Date.now. */
  now?: () => number;
}

export interface AttachServer {
  /** Takes an upgrade at ATTACH_PATH that already passed the Host and Origin checks. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Closes every attach socket with 1001 and kills every PTY. */
  close(): Promise<void>;
}

/**
 * What `open` does with a background session, from what's known about it now:
 * a fresh `claude agents --json --all` row when the snapshot showed no live
 * process, the snapshot's own otherwise.
 * - 'attach': it has a process, so `claude attach` restarts nothing. That
 *   includes a session that's 'done' and idle with its process still alive.
 * - 'starting': working or blocked with no process yet, and started within
 *   STARTING_GRACE_MS, or spawned by this pitwall within RECENT_SPAWN_MS.
 *   Attaching now would restart a session that's only starting, so the
 *   client is told to try again rather than asked.
 * - 'confirm': no process, and it has finished (done, stopped or failed), or
 *   it's working or blocked and older than that, so it crashed, or its state
 *   is unknown. Attaching restarts it, so the user is asked first (D9).
 */
export type AttachDecision = 'attach' | 'starting' | 'confirm';

export interface AttachFacts {
  pid?: number;
  state?: BackgroundState;
  /** ISO 8601. */
  startedAt: string;
}

export function attachDecision(facts: AttachFacts, context: { now: number; recentlySpawned: boolean }): AttachDecision {
  if (facts.pid !== undefined) return 'attach';
  if (facts.state === 'working' || facts.state === 'blocked') {
    const started = Date.parse(facts.startedAt);
    // A startedAt in the future counts as just started.
    const young = Number.isFinite(started) && context.now - started < STARTING_GRACE_MS;
    if (young || context.recentlySpawned) return 'starting';
  }
  return 'confirm';
}

function facts(pid: number | undefined, state: BackgroundState | undefined, startedAt: string): AttachFacts {
  const result: AttachFacts = { startedAt };
  if (pid !== undefined) result.pid = pid;
  if (state !== undefined) result.state = state;
  return result;
}

/** process.kill(pid, 0): true unless the pid is gone. EPERM means it exists but isn't ours. */
function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function createAttachServer(options: AttachOptions): AttachServer {
  const { indexer, token, authTimeoutMs, spawnPty } = options;
  const claudeBin = options.claudeBin ?? 'claude';
  const agents = options.agents ?? createAgentsSource({ claudeBin, timeoutMs: REREAD_TIMEOUT_MS });
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const now = options.now ?? Date.now;
  // One re-read at a time, shared by every socket that opens meanwhile.
  let reading: ReturnType<AgentsSource['list']> | undefined;
  const reread = () => (reading ??= agents.list().finally(() => (reading = undefined)));

  /**
   * The facts attachDecision() works from. The snapshot's when its pid is
   * still running; otherwise a fresh row, or the snapshot's without the dead
   * pid when the re-read fails or no longer lists the session.
   */
  const currentFacts = async (session: SessionSummary): Promise<AttachFacts> => {
    if (session.pid !== undefined && session.alive && processAlive(session.pid)) return facts(session.pid, session.state, session.startedAt);
    const fresh = await reread();
    const row = fresh.ok ? fresh.rows.find((candidate) => candidate.sessionId === session.sessionId) : undefined;
    if (row) return facts(row.pid, row.state, row.startedAt);
    return facts(undefined, session.state, session.startedAt);
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: ATTACH_MAX_PAYLOAD_BYTES, perMessageDeflate: false });
  // Sockets past the handshake. At most MAX_ATTACHED, counted until they close.
  const admitted = new Set<WebSocket>();
  // Every PTY still running, with what ends it.
  const ptys = new Map<PtyProcess, { exited: Promise<void>; kill: () => void }>();
  let closing = false;

  const handle = (ws: WebSocket) => {
    // 'opening': an open is being decided, which may wait for a re-read.
    let state: 'handshake' | 'ready' | 'opening' | 'attached' | 'done' = 'handshake';
    let pty: PtyProcess | undefined;

    const send = (message: AttachServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const end = (code: number, message?: AttachServerMessage) => {
      if (state === 'done') return;
      state = 'done';
      if (message) send(message);
      ws.close(code);
    };
    const fail = (error: string, code = WS_CLOSE_POLICY) => end(code, { type: 'error', error });

    const open = async (message: Extract<AttachClientMessage, { type: 'open' }>) => {
      const lookup = resolveSession(indexer, message.sessionId);
      if (!lookup.ok) return fail(LOOKUP_ERRORS[lookup.status]);
      const session = lookup.session;
      if (session.kind !== 'background') {
        return fail('Only background sessions can be attached. Type /bg in its terminal to move it to the background.');
      }
      const shortId = session.shortId;
      if (shortId === undefined || !SAFE_SHORT_ID.test(shortId)) return fail('This session has no id that claude attach can use.');

      state = 'opening';
      const facts = await currentFacts(session);
      // The socket closed or started closing, or the server did, while the re-read ran.
      if (state !== 'opening' || ws.readyState !== ws.OPEN) return;
      if (closing) return end(1001);
      const decision = attachDecision(facts, { now: now(), recentlySpawned: options.spawned?.has(shortId) ?? false });
      if (decision === 'starting') return fail(STILL_STARTING, WS_CLOSE_TRY_AGAIN);
      if (decision === 'confirm' && message.restart !== true) {
        // Wait for the user to confirm, then another open with restart: true.
        state = 'ready';
        send({ type: 'needs-restart' });
        return;
      }

      let started: PtyProcess;
      try {
        started = spawnPty(claudeBin, ['attach', shortId], {
          cols: message.cols,
          rows: message.rows,
          cwd: session.cwdMissing || !existsSync(session.cwd) ? homedir() : session.cwd,
          env: childEnvironment(options.env ?? process.env, token),
          name: 'xterm-256color',
        });
      } catch (error) {
        return fail(`Couldn't start claude attach: ${(error as Error).message}`, 1011);
      }
      pty = started;
      state = 'attached';
      send({ type: 'attached' });

      let paused = false;
      const resumeWhenDrained = () => {
        if (paused && ws.bufferedAmount < HIGH_WATER_BYTES / 2) {
          paused = false;
          started.resume();
        }
      };
      started.onData((data) => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(Buffer.from(data, 'utf8'), { binary: true }, resumeWhenDrained);
        if (!paused && ws.bufferedAmount > HIGH_WATER_BYTES) {
          paused = true;
          started.pause();
        }
      });

      let exited!: () => void;
      const exitedPromise = new Promise<void>((resolve) => (exited = resolve));
      let killTimer: NodeJS.Timeout | undefined;
      const kill = () => {
        if (killTimer !== undefined) return;
        safely(() => started.kill());
        killTimer = setTimeout(() => safely(() => started.kill('SIGKILL')), KILL_GRACE_MS);
        killTimer.unref();
      };
      ptys.set(started, { exited: exitedPromise, kill });
      started.onExit(({ exitCode, signal }) => {
        clearTimeout(killTimer);
        ptys.delete(started);
        if (pty === started) pty = undefined;
        exited();
        // `claude attach` ended on its own, not because the socket closed.
        end(1000, { type: 'exit', code: signal ? null : exitCode });
      });
    };

    const onMessage = (data: RawData, isBinary: boolean) => {
      if (state === 'done') return;
      const parsed = isBinary ? { error: 'Binary frames are not accepted.' } : parseAttachMessage(data);
      if ('error' in parsed) return fail(parsed.error);
      const message = parsed.message;
      if (state === 'ready') {
        if (message.type !== 'open') return fail('Send open first.');
        open(message).catch(() => fail("Couldn't check whether the session is running.", 1011));
        return;
      }
      if (state === 'opening') return fail('Wait for the answer to open.');
      if (state !== 'attached' || !pty) return;
      if (message.type === 'input') return safely(() => pty?.write(message.data));
      if (message.type === 'resize') return safely(() => pty?.resize(message.cols, message.rows));
      fail('Already attached.');
    };

    ws.on('close', () => {
      state = 'done';
      admitted.delete(ws);
      // Detaches. The session itself keeps running.
      if (pty) ptys.get(pty)?.kill();
    });

    startHandshake(ws, {
      token,
      origin: options.origin(),
      timeoutMs: authTimeoutMs,
      ...(options.slots ? { slots: options.slots } : {}),
      onAuthenticated: () => {
        options.onAuthenticated?.();
        if (closing) return end(1001);
        // Counted only after the handshake, so a client without the token
        // can't take a place, or learn how many are taken.
        if (admitted.size >= MAX_ATTACHED) return end(WS_CLOSE_TOO_MANY);
        admitted.add(ws);
        state = 'ready';
        ws.on('message', onMessage);
        send({ type: 'ready' });
      },
    });
  };

  let closed: Promise<void> | undefined;
  return {
    handleUpgrade(req, socket, head) {
      if (closing) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, handle);
    },
    close() {
      closed ??= (async () => {
        closing = true;
        const sockets = [...wss.clients];
        for (const ws of sockets) ws.close(1001);
        const running = [...ptys.values()];
        for (const { kill } of running) kill();
        await settleWithin(sockets.map(closedPromise), CLOSE_GRACE_MS);
        for (const ws of sockets) if (ws.readyState !== ws.CLOSED) ws.terminate();
        // SIGKILL follows SIGHUP after KILL_GRACE_MS for any PTY still running.
        await settleWithin(
          running.map(({ exited }) => exited),
          KILL_GRACE_MS + 500,
        );
        wss.close();
      })();
      return closed;
    },
  };
}

const LOOKUP_ERRORS: Record<400 | 404 | 503, string> = {
  400: 'Not a valid session id.',
  404: "That session isn't listed under pitwall's roots.",
  503: "pitwall hasn't listed the sessions yet. Try again in a moment.",
};

type Parsed = { message: AttachClientMessage } | { error: string };

/**
 * One client message after the handshake, in exactly the shape the contract
 * gives, or why not. Unknown fields are refused rather than ignored.
 */
export function parseAttachMessage(data: RawData): Parsed {
  const fields = parseJsonObject(data);
  if (fields === undefined) return { error: 'Not a JSON object.' };
  const keys = Object.keys(fields);
  const only = (...allowed: string[]) => keys.every((key) => allowed.includes(key));
  switch (fields.type) {
    case 'open': {
      if (!only('type', 'sessionId', 'cols', 'rows', 'restart')) return { error: 'Unexpected fields in open.' };
      if (typeof fields.sessionId !== 'string') return { error: 'open needs a sessionId.' };
      if (fields.restart !== undefined && typeof fields.restart !== 'boolean') return { error: 'restart must be true or false.' };
      const size = parseSize(fields.cols, fields.rows);
      if ('error' in size) return size;
      const message: AttachClientMessage = { type: 'open', sessionId: fields.sessionId, ...size };
      if (fields.restart !== undefined) message.restart = fields.restart;
      return { message };
    }
    case 'input':
      if (!only('type', 'data') || typeof fields.data !== 'string') return { error: 'input needs data, a string.' };
      return { message: { type: 'input', data: fields.data } };
    case 'resize': {
      if (!only('type', 'cols', 'rows')) return { error: 'Unexpected fields in resize.' };
      const size = parseSize(fields.cols, fields.rows);
      if ('error' in size) return size;
      return { message: { type: 'resize', ...size } };
    }
    default:
      return { error: 'Unknown message type.' };
  }
}

function parseSize(cols: unknown, rows: unknown): { cols: number; rows: number } | { error: string } {
  if (!inRange(cols, COLS_RANGE) || !inRange(rows, ROWS_RANGE)) {
    return {
      error: `cols must be a whole number from ${COLS_RANGE.min} to ${COLS_RANGE.max}, and rows from ${ROWS_RANGE.min} to ${ROWS_RANGE.max}.`,
    };
  }
  return { cols, rows };
}

function inRange(value: unknown, range: { min: number; max: number }): value is number {
  return Number.isInteger(value) && (value as number) >= range.min && (value as number) <= range.max;
}

/** A PTY that has already exited throws on write, resize and kill. Its exit is handled elsewhere. */
function safely(action: () => void): void {
  try {
    action();
  } catch {
    // Already gone.
  }
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
