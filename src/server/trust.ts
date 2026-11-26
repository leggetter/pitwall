// The trust terminal at TRUST_PATH (W214, spike 020): a PTY running a bare `claude` in a folder
// Claude Code hasn't trusted, carried over a WebSocket, so you answer Claude Code's own trust
// prompt in the page instead of copying a command into a terminal. pitwall never writes trust
// itself, and never reads ~/.claude.json for it: the page sends the start again afterwards, and
// its answer is the proof.
//
// Host and the required Origin are checked before the upgrade, in server.ts, exactly as for
// ATTACH_PATH, and the socket starts with the same challenge-response handshake (handshake.ts).
//
//   server  challenge                 within 5 s, else 4401
//   client  auth
//   server  ready                     or `error` and close 4429 while another trust socket is past the
//                                     handshake, server-wide: one trust terminal at a time
//   client  open                      cwd, cols, rows. The server checks cwd with checkDirectory(), as
//                                     New session does, under the snapshot's roots, and needs a word for
//                                     it from trustHint(), so only a folder whose 422 has a command to
//                                     copy gets a terminal. Then `claude` with no arguments, in that
//                                     folder's realpath, with childEnvironment() and PWD. At most
//                                     TRUST_OPENS a minute, else `error` and close 1013
//   server  started                   then the PTY's output as binary frames
//   client  input / resize            input is written only when it is exactly Up, Down, Enter or Esc
//                                     (trustKey()); anything else is dropped, here on the server
//   server  outcome                   once `claude` has exited, then close 1000
//
// How it ends (TrustReader reads the screen, escapes stripped, against TRUST_SCREEN's strings):
// - `claude` exits by itself: No or Esc, so 'declined'; or before its trust prompt showed, 'unclear'.
// - the banner shows and no question is open for SETTLE_MS: 'trusted'. pitwall ends `claude` with
//   SIGHUP, then SIGKILL after KILL_GRACE_MS. A question after the banner, such as a project
//   `.mcp.json`'s "New MCP server found", stays open for you to answer with the same four keys.
// - TRUST_TIME_LIMIT_MS passes first: 'unclear', and pitwall ends it the same way.
// Closing the socket ends it too, and so does close(). While it runs, its row in `claude agents`
// is hidden from the list by its pid (OwnPids, src/server/own.ts).
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { AgentRow } from '../index/agents.js';
import type { Indexer } from '../index/index.js';
import { TRUST_TIME_LIMIT_MS, WS_CLOSE_TOO_MANY, type TrustClientMessage, type TrustOutcome, type TrustServerMessage } from '../shared/protocol.js';
import { checkDirectory, RateWindow, trustHint } from './actions.js';
import { COLS_RANGE, ROWS_RANGE, WS_CLOSE_POLICY } from './attach.js';
import { childEnvironment } from './command.js';
import { parseJsonObject, startHandshake, WS_CLOSE_TRY_AGAIN, type HandshakeSlots } from './handshake.js';
import type { PtyProcess, PtySpawner } from './pty.js';

/** Incoming frames are capped at this many bytes: the page sends one key at a time. */
export const TRUST_MAX_PAYLOAD_BYTES = 4 * 1024;

/** How long the banner must show with no question open before pitwall ends `claude` (spike 020: about a second). */
export const SETTLE_MS = 1000;

/** How long `claude` has to exit after SIGHUP before it gets SIGKILL. */
export const KILL_GRACE_MS = 3000;

/** At most this many trust terminals opened in a minute, so a stuck page can't start `claude` over and over. */
export const TRUST_OPENS = { max: 10, windowMs: 60_000 } as const;

/** How long a trust terminal's pid stays hidden after it exits, for a `claude agents` read that began before. */
export const HIDE_AFTER_EXIT_MS = 15_000;

/** How long close() waits for sockets to finish the close handshake. */
const CLOSE_GRACE_MS = 250;

/**
 * The keys the trust terminal forwards, as xterm.js sends them: the arrows in both cursor modes
 * (normal `ESC [`, and application `ESC O`, which a program can switch on), Enter's carriage return
 * and Escape. They answer the trust prompt and a question after it, and can't type a prompt into the
 * `claude` that's trusted once Yes is chosen (Phil, 2026-11-26).
 */
export const TRUST_KEYS: ReadonlyMap<string, 'up' | 'down' | 'enter' | 'esc'> = new Map([
  ['\u001b[A', 'up'],
  ['\u001bOA', 'up'],
  ['\u001b[B', 'down'],
  ['\u001bOB', 'down'],
  ['\r', 'enter'],
  ['\u001b', 'esc'],
]);

/** Which of the four keys `data` is, exactly, or undefined for anything else, which is dropped. */
export function trustKey(data: string): 'up' | 'down' | 'enter' | 'esc' | undefined {
  return TRUST_KEYS.get(data);
}

/**
 * The strings Claude Code shows, matched after escapes are stripped (spike 020, finding 1, Claude
 * Code 2.1.332). They're its display text, not an interface, so a release can change them: they're
 * here alone, so that breaks this one constant, and a screen that never matches falls back to the
 * command to copy at the time limit.
 */
export const TRUST_SCREEN = {
  /** The trust prompt's Yes option. */
  prompt: 'Yes, I trust this folder',
  /** The foot of every question: the trust prompt's "Esc to cancel", the MCP question's "Esc to reject". */
  question: 'Enter to confirm',
  /** The welcome banner, which shows once the folder is trusted and never while the trust prompt is up. */
  banner: 'Claude Code v',
  /** What No and Esc print before `claude` exits. Either quote mark, and a line break between the words. */
  declined: /didn.t\s+start\s+because\s+this\s+folder\s+isn.t\s+trusted/g,
} as const;

/** The escapes the spike's probe strips: CSI, OSC, DCS, PM and APC, character sets, and single-byte escapes. */
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[P^_][^\u001b]*\u001b\\|\u001b[()][0-9A-Za-z]|\u001b[^[\]P^_()]/g;
/** An escape cut off at the end of a chunk: the rest of it is in the next. */
const PARTIAL_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*|[P^_][^\u001b]*|[()])?$/;
/** C0 controls but tab, newline and carriage return, DEL, and C1 controls. */
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/** The longest a cut-off escape is held for the next chunk; past it, it's read as it is. */
const MAX_CARRY = 4096;

/** Screen text with escapes replaced by a space and runs of spaces and tabs made one, as the spike read it. */
export function screenText(raw: string): string {
  return raw.replace(ESCAPES, ' ').replace(CONTROLS, '').replace(/[ \t]+/g, ' ');
}

/**
 * Reads the trust terminal's output as it arrives, for where Claude Code is:
 * - promptSeen: the trust prompt showed;
 * - bannerSeen: the banner showed, so the folder is trusted;
 * - declinedSeen: No or Esc's line showed;
 * - settled(): the banner has shown and no question is open: none after the banner, or every one
 *   after it answered with Enter or Esc (answered()) and none drawn since.
 * It keeps only where each string was last seen, by its offset in all the text so far, and a short
 * tail, so a string split over two chunks is still found.
 */
export class TrustReader {
  #carry = '';
  #tail = '';
  /** The offset in all the text so far where #tail starts. */
  #base = 0;
  #last = { prompt: -1, question: -1, banner: -1, declined: -1 };
  #answeredAt = -1;

  get promptSeen(): boolean {
    return this.#last.prompt >= 0;
  }
  get bannerSeen(): boolean {
    return this.#last.banner >= 0;
  }
  get declinedSeen(): boolean {
    return this.#last.declined >= 0;
  }

  /** PTY output, as it arrives. */
  feed(chunk: string): void {
    let raw = this.#carry + chunk;
    this.#carry = '';
    const partial = PARTIAL_ESCAPE.exec(raw);
    if (partial && partial[0].length <= MAX_CARRY) {
      this.#carry = partial[0];
      raw = raw.slice(0, partial.index);
    }
    const added = screenText(raw);
    if (added === '') return;
    const longest = 64;
    const from = Math.max(0, this.#tail.length - longest);
    this.#tail += added;
    for (const key of ['prompt', 'question', 'banner'] as const) {
      const at = this.#tail.lastIndexOf(TRUST_SCREEN[key]);
      if (at >= from) this.#last[key] = this.#base + at;
    }
    for (const match of this.#tail.slice(from).matchAll(TRUST_SCREEN.declined)) this.#last.declined = this.#base + from + match.index;
    if (this.#tail.length > longest * 2) {
      const cut = this.#tail.length - longest;
      this.#base += cut;
      this.#tail = this.#tail.slice(cut);
    }
  }

  /** An Enter or Esc was forwarded: it answers whatever question is on the screen now. */
  answered(): void {
    this.#answeredAt = this.#base + this.#tail.length;
  }

  /** The banner has shown, and no question drawn after it is still unanswered. */
  settled(): boolean {
    const { banner, question } = this.#last;
    return banner >= 0 && question < Math.max(banner, this.#answeredAt);
  }

  /** What it means when `claude` exited by itself, before pitwall ended it. */
  exitOutcome(): TrustOutcome {
    if (this.bannerSeen) return 'trusted';
    return this.promptSeen || this.declinedSeen ? 'declined' : 'unclear';
  }
}

/**
 * The pids of pitwall's own trust terminals, which the index leaves out of the list while they run
 * (spike 020, finding 2: after Yes, `claude agents --json` lists the PTY's `claude` as an interactive
 * row until it ends), and for HIDE_AFTER_EXIT_MS after.
 */
export class OwnPids {
  readonly #pids = new Map<number, NodeJS.Timeout | undefined>();

  add(pid: number): void {
    clearTimeout(this.#pids.get(pid));
    this.#pids.set(pid, undefined);
  }

  /** Forgets `pid` after `afterMs`, unless it's added again meanwhile. */
  release(pid: number, afterMs = HIDE_AFTER_EXIT_MS): void {
    if (!this.#pids.has(pid)) return;
    clearTimeout(this.#pids.get(pid));
    const timer = setTimeout(() => this.#pids.delete(pid), afterMs);
    timer.unref();
    this.#pids.set(pid, timer);
  }

  has(pid: number): boolean {
    return this.#pids.has(pid);
  }

  /** For isPitwallOwn(): a row whose pid is one of these. */
  isOwn(row: Pick<AgentRow, 'pid'>): boolean {
    return row.pid !== undefined && this.#pids.has(row.pid);
  }
}

export interface TrustOptions {
  /** The snapshot's roots, which the folder must be under. */
  indexer: Pick<Indexer, 'latest'>;
  token: string;
  /** The server's one allowed origin, which the proof is bound to. */
  origin: () => string;
  authTimeoutMs: number;
  spawnPty: PtySpawner;
  /** Default 'claude'. */
  claudeBin?: string;
  /** The environment the PTY's is made from. Default process.env. */
  env?: NodeJS.ProcessEnv;
  onAuthenticated?: () => void;
  /** The server's pending-handshake count, shared with WS_PATH and ATTACH_PATH. */
  slots?: HandshakeSlots;
  /** Where each trust terminal's pid goes while it runs, for the index's exclude. */
  own: OwnPids;
  timeLimitMs?: number;
  settleMs?: number;
  killGraceMs?: number;
  /** Milliseconds since the epoch, for TRUST_OPENS. Default Date.now. */
  now?: () => number;
}

export interface TrustServer {
  /** Takes an upgrade at TRUST_PATH that already passed the Host and Origin checks. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Closes every trust socket with 1001 and ends every trust terminal. */
  close(): Promise<void>;
}

/** The answer to a second trust socket while one is open. */
export const TRUST_BUSY = "Another folder's trust prompt is open in pitwall. Close it first.";

export function createTrustServer(options: TrustOptions): TrustServer {
  const { indexer, token, authTimeoutMs, spawnPty, own } = options;
  const claudeBin = options.claudeBin ?? 'claude';
  const timeLimitMs = options.timeLimitMs ?? TRUST_TIME_LIMIT_MS;
  const settleMs = options.settleMs ?? SETTLE_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const opens = new RateWindow(TRUST_OPENS, options.now ?? Date.now);

  const wss = new WebSocketServer({ noServer: true, maxPayload: TRUST_MAX_PAYLOAD_BYTES, perMessageDeflate: false });
  // The one socket past the handshake, if any.
  let admitted: WebSocket | undefined;
  const ptys = new Map<PtyProcess, { exited: Promise<void>; kill: () => void }>();
  let closing = false;

  const handle = (ws: WebSocket) => {
    let state: 'handshake' | 'ready' | 'opening' | 'running' | 'done' = 'handshake';
    let pty: PtyProcess | undefined;
    // Set once pitwall decides how it ended, before it ends `claude`.
    let decided: TrustOutcome | undefined;
    const reader = new TrustReader();
    let settleTimer: NodeJS.Timeout | undefined;
    let limitTimer: NodeJS.Timeout | undefined;

    const send = (message: TrustServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const end = (code: number, message?: TrustServerMessage) => {
      if (state === 'done') return;
      state = 'done';
      if (message) send(message);
      ws.close(code);
    };
    const fail = (error: string, code = WS_CLOSE_POLICY) => end(code, { type: 'error', error });
    const stopTimers = () => {
      clearTimeout(settleTimer);
      clearTimeout(limitTimer);
      settleTimer = undefined;
    };
    /** Decides how it ended, once, and ends `claude`; the outcome goes out when it has exited. */
    const finish = (outcome: TrustOutcome) => {
      if (decided !== undefined) return;
      decided = outcome;
      stopTimers();
      if (pty) ptys.get(pty)?.kill();
    };
    /** Arms the settle timer while the screen is settled, and disarms it when a question shows. */
    const watch = () => {
      if (decided !== undefined) return;
      if (!reader.settled()) {
        clearTimeout(settleTimer);
        settleTimer = undefined;
        return;
      }
      settleTimer ??= setTimeout(() => {
        settleTimer = undefined;
        if (reader.settled()) finish('trusted');
      }, settleMs);
    };

    const open = async (message: Extract<TrustClientMessage, { type: 'open' }>) => {
      const snapshot = indexer.latest();
      if (snapshot === undefined) return fail("pitwall hasn't listed the sessions yet. Try again in a moment.", WS_CLOSE_TRY_AGAIN);
      state = 'opening';
      const dir = await checkDirectory(message.cwd, snapshot.roots);
      if (state !== 'opening' || ws.readyState !== ws.OPEN) return;
      if (closing) return end(1001);
      if (!dir.ok) return fail(dir.error);
      // Only where the card has a command to copy: a path with a ' or \ has none (W87).
      if (trustHint(dir.path) === undefined) return fail("pitwall has no trust terminal for a folder whose path has a ' or \\.");
      const taken = opens.take();
      if (!taken.ok) return fail(`pitwall opens at most ${TRUST_OPENS.max} trust prompts a minute. Try again in ${taken.retryAfterSeconds}s.`, WS_CLOSE_TRY_AGAIN);

      let started: PtyProcess;
      try {
        // No arguments: the smallest `claude` that shows the trust prompt (spike 020's recommendation 2).
        started = spawnPty(claudeBin, [], {
          cols: message.cols,
          rows: message.rows,
          cwd: dir.path,
          env: { ...childEnvironment(options.env ?? process.env, token), PWD: dir.path },
          name: 'xterm-256color',
        });
      } catch (error) {
        return fail(`Couldn't start claude: ${(error as Error).message}`, 1011);
      }
      pty = started;
      const pid = typeof started.pid === 'number' && Number.isInteger(started.pid) && started.pid > 0 ? started.pid : undefined;
      if (pid !== undefined) own.add(pid);
      state = 'running';
      send({ type: 'started' });

      let exited!: () => void;
      const exitedPromise = new Promise<void>((resolve) => (exited = resolve));
      let killTimer: NodeJS.Timeout | undefined;
      const kill = () => {
        if (killTimer !== undefined) return;
        safely(() => started.kill());
        killTimer = setTimeout(() => safely(() => started.kill('SIGKILL')), killGraceMs);
        killTimer.unref();
      };
      ptys.set(started, { exited: exitedPromise, kill });

      started.onData((data) => {
        reader.feed(data);
        if (ws.readyState === ws.OPEN && decided === undefined) ws.send(Buffer.from(data, 'utf8'), { binary: true });
        watch();
      });
      started.onExit(() => {
        clearTimeout(killTimer);
        stopTimers();
        ptys.delete(started);
        if (pid !== undefined) own.release(pid);
        if (pty === started) pty = undefined;
        exited();
        end(1000, { type: 'outcome', outcome: decided ?? reader.exitOutcome() });
      });
      limitTimer = setTimeout(() => finish('unclear'), timeLimitMs);
      limitTimer.unref();
    };

    const onMessage = (data: RawData, isBinary: boolean) => {
      if (state === 'done') return;
      const parsed = isBinary ? { error: 'Binary frames are not accepted.' } : parseTrustMessage(data);
      if ('error' in parsed) return fail(parsed.error);
      const message = parsed.message;
      if (state === 'ready') {
        if (message.type !== 'open') return fail('Send open first.');
        open(message).catch(() => fail("Couldn't check the folder.", 1011));
        return;
      }
      if (state === 'opening') return fail('Wait for the answer to open.');
      if (state !== 'running' || !pty) return;
      if (message.type === 'open') return fail('Already open.');
      if (decided !== undefined) return;
      if (message.type === 'resize') return safely(() => pty?.resize(message.cols, message.rows));
      if (message.type !== 'input') return;
      // Up, Down, Enter and Esc alone. Anything else, a paste or a typed letter included, is dropped.
      const key = trustKey(message.data);
      if (key === undefined) return;
      if (key === 'enter' || key === 'esc') reader.answered();
      const keyData = message.data;
      safely(() => pty?.write(keyData));
      watch();
    };

    ws.on('close', () => {
      state = 'done';
      if (admitted === ws) admitted = undefined;
      stopTimers();
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
        // Counted only after the handshake, so a client without the token can't take the place.
        if (admitted !== undefined) return fail(TRUST_BUSY, WS_CLOSE_TOO_MANY);
        admitted = ws;
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
        await settleWithin(
          running.map(({ exited }) => exited),
          killGraceMs + 500,
        );
        wss.close();
      })();
      return closed;
    },
  };
}

type Parsed = { message: TrustClientMessage } | { error: string };

/** One client message after the handshake, in exactly the contract's shape, or why not. Unknown fields are refused. */
export function parseTrustMessage(data: RawData): Parsed {
  const fields = parseJsonObject(data);
  if (fields === undefined) return { error: 'Not a JSON object.' };
  const keys = Object.keys(fields);
  const only = (...allowed: string[]) => keys.every((key) => allowed.includes(key));
  switch (fields.type) {
    case 'open': {
      if (!only('type', 'cwd', 'cols', 'rows')) return { error: 'Unexpected fields in open.' };
      if (typeof fields.cwd !== 'string') return { error: 'open needs a cwd.' };
      const size = parseSize(fields.cols, fields.rows);
      if ('error' in size) return size;
      return { message: { type: 'open', cwd: fields.cwd, ...size } };
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
  const inRange = (value: unknown, range: { min: number; max: number }) => Number.isInteger(value) && (value as number) >= range.min && (value as number) <= range.max;
  if (!inRange(cols, COLS_RANGE) || !inRange(rows, ROWS_RANGE)) {
    return { error: `cols must be a whole number from ${COLS_RANGE.min} to ${COLS_RANGE.max}, and rows from ${ROWS_RANGE.min} to ${ROWS_RANGE.max}.` };
  }
  return { cols: cols as number, rows: rows as number };
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
  await Promise.race([Promise.all(promises), new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}
