import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { AgentRow, Indexer } from '../index/index.js';
import type { AgentsResult } from '../index/agents.js';
import {
  ATTACH_PATH,
  MAX_ATTACHED,
  PROTOCOL_VERSION,
  SPAWN_PATH,
  WS_CLOSE_TOO_MANY,
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
  type AttachServerMessage,
  type IndexSnapshot,
  type ServerMessage,
  type SessionSummary,
} from '../shared/protocol.js';
import {
  ATTACH_MAX_PAYLOAD_BYTES,
  attachDecision,
  COLS_RANGE,
  ROWS_RANGE,
  STARTING_GRACE_MS,
  STILL_STARTING,
  WS_CLOSE_POLICY,
  WS_CLOSE_TRY_AGAIN,
} from './attach.js';
import type { CommandResult } from './command.js';
import { RECENT_SPAWN_MS } from './recentSpawns.js';
import type { RunningServer } from './index.js';
import { spawnPty, type PtyProcess, type PtySpawnOptions } from './pty.js';
import { pitwallOrigin, proofFor as contractProof, version2ProofFor } from '../test/proof.js';
import { startServerWithInternals, type ServerInternals } from './server.js';

// Made-up sessions only. No test here runs `claude`: every PTY is a FakePty,
// except one that runs /bin/echo through the real node-pty.

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const ROOT = '/tmp/pitwall-test-root';
const BG_ID = '11111111-1111-4111-8111-111111111111';
const IDLE_ID = '22222222-2222-4222-8222-222222222222';
const DONE_ID = '33333333-3333-4333-8333-333333333333';
const INTERACTIVE_ID = '44444444-4444-4444-8444-444444444444';
const NO_SHORT_ID = '55555555-5555-4555-8555-555555555555';
const FLAG_SHORT_ID = '66666666-6666-4666-8666-666666666666';
/** An interactive session that has ended (W66): no process, no short id. */
const ENDED_ID = '77777777-7777-4777-8777-777777777777';
const UNLISTED_ID = '99999999-9999-4999-8999-999999999999';

// ---------------------------------------------------------------- fixtures

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'sessionId'>): SessionSummary {
  const merged: SessionSummary = {
    name: 'pitwall-test-attach',
    kind: 'background',
    shortId: 'bg1234',
    cwd: ROOT,
    pid: 4242,
    alive: true,
    status: 'idle',
    state: 'working',
    startedAt: '2026-10-16T00:00:00.000Z',
    stale: false,
    finished: false,
    transcript: 'missing',
    ...overrides,
  };
  for (const key of Object.keys(merged) as (keyof SessionSummary)[]) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged;
}

const SESSIONS: SessionSummary[] = [
  summary({ sessionId: BG_ID }),
  summary({ sessionId: IDLE_ID, shortId: 'bgidle', pid: undefined, alive: false, status: undefined, state: 'blocked' }),
  // Stopped: `claude stop` leaves a session 'done' with no process.
  summary({ sessionId: DONE_ID, shortId: 'bgdone', state: 'done', pid: undefined, alive: false, status: undefined, finished: true }),
  summary({ sessionId: INTERACTIVE_ID, kind: 'interactive', shortId: undefined, state: undefined }),
  summary({ sessionId: NO_SHORT_ID, shortId: undefined }),
  summary({ sessionId: FLAG_SHORT_ID, shortId: '--help' }),
  summary({
    sessionId: ENDED_ID,
    kind: 'interactive',
    shortId: undefined,
    pid: undefined,
    alive: false,
    status: undefined,
    state: undefined,
    finished: true,
    ended: true,
    transcript: 'ok',
  }),
];

function snapshot(sessions: SessionSummary[] = SESSIONS): IndexSnapshot {
  return {
    generatedAt: '2026-10-16T00:00:00.000Z',
    roots: [ROOT],
    groups: [{ key: ROOT, label: 'root', kind: 'directory', root: ROOT, sessions }],
    source: { ok: true },
  };
}

/** `null` for an index that hasn't finished its first poll. */
function fakeIndexer(latest: IndexSnapshot | null = snapshot()): Indexer {
  return {
    latest: () => latest ?? undefined,
    subscribe: () => () => {},
    conversation: async () => undefined,
    subagents: async () => undefined,
    subagentConversation: async () => undefined,
    pollSoon: () => {},
    noteRestart: () => {},
    stop: () => {},
  };
}

/** A PTY that echoes what's written to it, and exits when killed. */
class FakePty implements PtyProcess {
  written: string[] = [];
  sizes: [number, number][] = [];
  killed: string[] = [];
  paused = false;
  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  private exited = false;

  constructor(
    readonly file: string,
    readonly args: string[],
    readonly options: PtySpawnOptions,
  ) {}

  onData(listener: (data: string) => void) {
    this.dataListeners.push(listener);
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.push(listener);
  }
  write(data: string) {
    this.written.push(data);
    this.emit(`echo:${data}`);
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  kill(signal = 'SIGHUP') {
    this.killed.push(signal);
    // As `claude attach` does on SIGHUP: it detaches and exits 0.
    setImmediate(() => this.exit(0));
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  emit(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }
  exit(exitCode: number, signal?: number) {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener({ exitCode, ...(signal === undefined ? {} : { signal }) });
  }
}

function fakeSpawner() {
  const ptys: FakePty[] = [];
  const spawn = vi.fn((file: string, args: string[], options: PtySpawnOptions) => {
    const pty = new FakePty(file, args, options);
    ptys.push(pty);
    return pty;
  });
  return {
    ptys,
    spawn,
    get last(): FakePty {
      const pty = ptys.at(-1);
      if (!pty) throw new Error('no PTY spawned');
      return pty;
    },
  };
}

let webRoot: string;
beforeAll(async () => {
  webRoot = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
});
afterAll(async () => {
  await rm(webRoot, { recursive: true, force: true });
});

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

const ENV = { PATH: '/usr/bin:/bin', HOME: '/Users/example' };

/**
 * A stand-in for `claude agents --json --all`, which attach re-reads on open
 * when the snapshot shows no live process. It answers `result`, which a test
 * can change, and counts the reads.
 */
function fakeAgents(result: AgentsResult = { ok: true, rows: [] }) {
  const agents = {
    result,
    reads: 0,
    list: vi.fn(async () => {
      agents.reads += 1;
      return agents.result;
    }),
  };
  return agents;
}

/** A `claude agents` row for a session in SESSIONS. */
function row(overrides: Partial<AgentRow> & Pick<AgentRow, 'sessionId'>): AgentRow {
  return { name: 'pitwall-test-attach', kind: 'background', cwd: ROOT, startedAt: '2026-10-16T00:00:00.000Z', ...overrides };
}

async function start(
  options: {
    indexer?: Indexer;
    spawner?: ReturnType<typeof fakeSpawner>;
    env?: NodeJS.ProcessEnv;
    agents?: ReturnType<typeof fakeAgents>;
    processAlive?: (pid: number) => boolean;
    now?: () => number;
  } & ServerInternals = {},
) {
  const spawner = options.spawner ?? fakeSpawner();
  const agents = options.agents ?? fakeAgents();
  const server = await startServerWithInternals(
    { indexer: options.indexer ?? fakeIndexer(), token: TOKEN, webRoot, port: 0 },
    {
      ...(options.authTimeoutMs === undefined ? {} : { authTimeoutMs: options.authTimeoutMs }),
      ...(options.actions === undefined ? {} : { actions: options.actions }),
      attach: {
        spawnPty: spawner.spawn,
        env: options.env ?? ENV,
        agents,
        // The fixtures' pids aren't real processes; a test that wants one gone says so.
        processAlive: options.processAlive ?? (() => true),
        ...(options.now === undefined ? {} : { now: options.now }),
      },
    },
  );
  running.push(server);
  return { server, spawner, agents };
}

// ---------------------------------------------------------------- clients

interface Client {
  ws: WebSocket;
  /** The server's port, which the proof is bound to through its origin. */
  port: number;
  /** Text frames, parsed. */
  messages: AttachServerMessage[];
  /** Binary frames. */
  output: Buffer[];
  closed: Promise<{ code: number }>;
  next(): Promise<AttachServerMessage>;
  /** All binary output so far, as UTF-8. */
  text(): string;
}

function connect(port: number, options: { origin?: string | null; host?: string } = {}): Client {
  const origin = options.origin === undefined ? `http://127.0.0.1:${port}` : options.origin;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${ATTACH_PATH}`, {
    ...(origin === null ? {} : { origin }),
    headers: options.host ? { host: options.host } : {},
  });
  const messages: AttachServerMessage[] = [];
  const output: Buffer[] = [];
  const waiters: ((message: AttachServerMessage) => void)[] = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      output.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      return;
    }
    const message = JSON.parse(String(data)) as AttachServerMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  ws.on('error', () => {});
  const closed = new Promise<{ code: number }>((resolve) => ws.on('close', (code) => resolve({ code })));
  return {
    ws,
    port,
    messages,
    output,
    closed,
    next: () => {
      const queued = messages.shift();
      return queued ? Promise.resolve(queued) : new Promise((resolve) => waiters.push(resolve));
    },
    text: () => Buffer.concat(output).toString('utf8'),
  };
}

/** The proof for a nonce from the server on `port`, as its own page computes it (src/test/proof.ts). */
function proofFor(nonce: string, port: number, token = TOKEN): string {
  return contractProof(token, nonce, pitwallOrigin(port));
}

const send = (client: Client, message: unknown) => client.ws.send(typeof message === 'string' ? message : JSON.stringify(message));

/** Answers the challenge. Resolves with the message after it: 'ready', unless the socket is refused. */
async function handshake(client: Client, token = TOKEN): Promise<AttachServerMessage | { code: number }> {
  const challenge = await client.next();
  if (challenge.type !== 'challenge') throw new Error(`expected a challenge, got ${challenge.type}`);
  send(client, { type: 'auth', proof: proofFor(challenge.nonce, client.port, token) });
  return Promise.race([client.next(), client.closed]);
}

async function ready(port: number): Promise<Client> {
  const client = connect(port);
  const reply = await handshake(client);
  expect(reply).toEqual({ type: 'ready' });
  return client;
}

async function attached(port: number, sessionId = BG_ID, size = { cols: 120, rows: 40 }): Promise<Client> {
  const client = await ready(port);
  send(client, { type: 'open', sessionId, ...size });
  expect(await client.next()).toEqual({ type: 'attached' });
  return client;
}

async function waitFor(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function upgradeStatus(client: Client): Promise<number> {
  return new Promise((resolve, reject) => {
    client.ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    client.ws.on('open', () => reject(new Error('upgrade was accepted')));
  });
}

/** Expects an error message, then the socket closed with `code`. */
/** The apiKey, from the index socket's handshake, for the spawn route. */
async function apiKeyOf(port: number): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { origin: pitwallOrigin(port) });
  return new Promise<string>((resolve, reject) => {
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      if (message.type === 'challenge') ws.send(JSON.stringify({ type: 'auth', proof: proofFor(message.nonce, port) }));
      else if (message.type === 'authenticated') {
        ws.close();
        resolve(message.apiKey);
      }
    });
    ws.on('close', () => reject(new Error('closed before authenticated')));
  });
}

async function expectRefused(client: Client, code = WS_CLOSE_POLICY): Promise<string> {
  const message = await client.next();
  if (message.type !== 'error') throw new Error(`expected an error, got ${message.type}`);
  expect((await client.closed).code).toBe(code);
  return message.error;
}

// ---------------------------------------------------------------- tests

describe('the attach socket', () => {
  describe('upgrade', () => {
    it('requires this server Origin, like the index socket', async () => {
      const { server } = await start();
      expect(await upgradeStatus(connect(server.port, { origin: null }))).toBe(403);
      expect(await upgradeStatus(connect(server.port, { origin: 'http://evil.example' }))).toBe(403);
      expect(await upgradeStatus(connect(server.port, { origin: `http://localhost:${server.port}` }))).toBe(403);
    });

    it('requires Host 127.0.0.1:<port>', async () => {
      const { server } = await start();
      expect(await upgradeStatus(connect(server.port, { host: `localhost:${server.port}` }))).toBe(403);
    });

    it('answers a plain request with 426', async () => {
      const { server } = await start();
      const response = await fetch(`http://127.0.0.1:${server.port}${ATTACH_PATH}`);
      expect(response.status).toBe(426);
    });
  });

  describe('the handshake', () => {
    it('opens with a challenge, then answers a valid proof with ready', async () => {
      const { server } = await start();
      const client = connect(server.port);
      const challenge = await client.next();
      expect(challenge).toEqual({ type: 'challenge', version: PROTOCOL_VERSION, nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
      if (challenge.type !== 'challenge') return;
      send(client, { type: 'auth', proof: proofFor(challenge.nonce, server.port) });
      expect(await client.next()).toEqual({ type: 'ready' });
    });

    it("calls the server's onAuthenticated after a valid proof", async () => {
      const onAuthenticated = vi.fn();
      const spawner = fakeSpawner();
      const server = await startServerWithInternals(
        { indexer: fakeIndexer(), token: TOKEN, webRoot, port: 0, onAuthenticated },
        { attach: { spawnPty: spawner.spawn, env: ENV } },
      );
      running.push(server);
      await ready(server.port);
      expect(onAuthenticated).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a version 2 proof, without the origin', (nonce: string) => version2ProofFor(TOKEN, nonce)],
      ['a proof bound to another port', (nonce: string, port: number) => proofFor(nonce, port + 1)],
      ['a proof bound to localhost', (nonce: string, port: number) => contractProof(TOKEN, nonce, `http://localhost:${port}`)],
    ])('closes with 4401 for %s', async (_name, build) => {
      const { server, spawner } = await start();
      const client = connect(server.port);
      const challenge = await client.next();
      if (challenge.type !== 'challenge') throw new Error('expected a challenge');
      send(client, { type: 'auth', proof: build(challenge.nonce, server.port) });
      expect((await client.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(client.messages).toEqual([]);
      expect(spawner.ptys).toHaveLength(0);
    });

    it('closes with 4401 for a wrong proof', async () => {
      const { server, spawner } = await start();
      const client = connect(server.port);
      expect(await handshake(client, 'not-the-token-0123456789abcdefghijklmnop')).toEqual({ code: WS_CLOSE_UNAUTHORIZED });
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it('closes with 4401 when open comes before auth', async () => {
      const { server, spawner } = await start();
      const client = connect(server.port);
      await client.next();
      send(client, { type: 'open', sessionId: BG_ID, cols: 80, rows: 24 });
      expect((await client.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it('closes with 4401 when no proof arrives in time', async () => {
      const { server } = await start({ authTimeoutMs: 50 });
      const client = connect(server.port);
      await client.next();
      expect((await client.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
    });

    it('never sends the token', async () => {
      const { server } = await start();
      const client = await attached(server.port);
      send(client, { type: 'input', data: 'x' });
      await waitFor(() => client.output.length > 0);
      client.ws.close();
      await client.closed;
      expect(JSON.stringify(client.messages)).not.toContain(TOKEN);
      expect(client.text()).not.toContain(TOKEN);
    });
  });

  describe('open', () => {
    it('refuses a session that is not listed, without spawning', async () => {
      const { server, spawner } = await start();
      const client = await ready(server.port);
      send(client, { type: 'open', sessionId: UNLISTED_ID, cols: 80, rows: 24 });
      expect(await expectRefused(client)).toMatch(/isn't listed/);
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it('refuses an id that is not safe', async () => {
      const { server, spawner } = await start();
      const client = await ready(server.port);
      send(client, { type: 'open', sessionId: '../etc/passwd', cols: 80, rows: 24 });
      expect(await expectRefused(client)).toMatch(/Not a valid session id/);
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it('refuses before the first snapshot', async () => {
      const { server, spawner } = await start({ indexer: fakeIndexer(null) });
      const client = await ready(server.port);
      send(client, { type: 'open', sessionId: BG_ID, cols: 80, rows: 24 });
      expect(await expectRefused(client)).toMatch(/hasn't listed the sessions yet/);
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it('refuses an interactive session, pointing at /bg', async () => {
      const { server, spawner } = await start();
      const client = await ready(server.port);
      send(client, { type: 'open', sessionId: INTERACTIVE_ID, cols: 80, rows: 24 });
      expect(await expectRefused(client)).toMatch(/Only background sessions.*\/bg/);
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it('refuses an ended interactive session, saying to resume it first, without re-reading or spawning', async () => {
      const { server, spawner, agents } = await start();
      const client = await ready(server.port);
      send(client, { type: 'open', sessionId: ENDED_ID, cols: 80, rows: 24, restart: true });
      expect(await expectRefused(client)).toBe('This session has ended. Resume it in the background first, then attach.');
      expect(agents.reads).toBe(0);
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it('refuses a background session without a usable short id, including one that looks like an option', async () => {
      const { server, spawner } = await start();
      for (const sessionId of [NO_SHORT_ID, FLAG_SHORT_ID]) {
        const client = await ready(server.port);
        send(client, { type: 'open', sessionId, cols: 80, rows: 24 });
        expect(await expectRefused(client)).toMatch(/no id that claude attach can use/);
      }
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it('spawns `claude attach <shortId>` from the resolved session, at the requested size', async () => {
      const { server, spawner } = await start();
      await attached(server.port, BG_ID, { cols: 132, rows: 43 });
      expect(spawner.spawn).toHaveBeenCalledTimes(1);
      const pty = spawner.last;
      expect(pty.file).toBe('claude');
      expect(pty.args).toEqual(['attach', 'bg1234']);
      expect(pty.options).toMatchObject({ cols: 132, rows: 43, name: 'xterm-256color' });
    });

    it('refuses unexpected fields, and a second open once attached', async () => {
      const { server } = await start();
      const extra = await ready(server.port);
      send(extra, { type: 'open', sessionId: BG_ID, cols: 80, rows: 24, shortId: '--help' });
      expect(await expectRefused(extra)).toMatch(/Unexpected fields/);

      const client = await attached(server.port);
      send(client, { type: 'open', sessionId: BG_ID, cols: 80, rows: 24 });
      expect(await expectRefused(client)).toMatch(/Already attached/);
    });

    it('refuses input or resize before open', async () => {
      const { server } = await start();
      const client = await ready(server.port);
      send(client, { type: 'input', data: 'ls\r' });
      expect(await expectRefused(client)).toMatch(/Send open first/);
    });
  });

  describe('a session that is not running', () => {
    it('answers needs-restart for one with no process, and spawns nothing', async () => {
      const { server, spawner } = await start();
      const client = await ready(server.port);
      send(client, { type: 'open', sessionId: IDLE_ID, cols: 80, rows: 24 });
      expect(await client.next()).toEqual({ type: 'needs-restart' });
      send(client, { type: 'open', sessionId: IDLE_ID, cols: 80, rows: 24, restart: false });
      expect(await client.next()).toEqual({ type: 'needs-restart' });
      expect(spawner.spawn).not.toHaveBeenCalled();
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
    });

    it('attaches on the same socket once open says restart: true', async () => {
      const { server, spawner } = await start();
      const client = await ready(server.port);
      send(client, { type: 'open', sessionId: IDLE_ID, cols: 80, rows: 24 });
      expect(await client.next()).toEqual({ type: 'needs-restart' });
      send(client, { type: 'open', sessionId: IDLE_ID, cols: 90, rows: 30, restart: true });
      expect(await client.next()).toEqual({ type: 'attached' });
      expect(spawner.last.args).toEqual(['attach', 'bgidle']);
      expect(spawner.last.options).toMatchObject({ cols: 90, rows: 30 });
    });

    it('asks first for a stopped session (done, with no process)', async () => {
      const { server } = await start();
      const client = await ready(server.port);
      send(client, { type: 'open', sessionId: DONE_ID, cols: 80, rows: 24 });
      expect(await client.next()).toEqual({ type: 'needs-restart' });
    });

    it('notes a restart you confirmed, by session id, for Needs you (W69)', async () => {
      const at = Date.parse('2026-10-27T12:00:00.000Z');
      const indexer = { ...fakeIndexer(), noteRestart: vi.fn() };
      const { server } = await start({ indexer, now: () => at });
      const client = await ready(server.port);
      send(client, { type: 'open', sessionId: IDLE_ID, cols: 80, rows: 24 });
      expect(await client.next()).toEqual({ type: 'needs-restart' });
      expect(indexer.noteRestart).not.toHaveBeenCalled();
      send(client, { type: 'open', sessionId: IDLE_ID, cols: 80, rows: 24, restart: true });
      expect(await client.next()).toEqual({ type: 'attached' });
      expect(indexer.noteRestart.mock.calls).toEqual([[IDLE_ID, at]]);
    });

    it('notes no restart for an attach that restarts nothing, even when told restart: true', async () => {
      const indexer = { ...fakeIndexer(), noteRestart: vi.fn() };
      const { server } = await start({ indexer });
      await attached(server.port);
      const told = await ready(server.port);
      send(told, { type: 'open', sessionId: BG_ID, cols: 80, rows: 24, restart: true });
      expect(await told.next()).toEqual({ type: 'attached' });
      expect(indexer.noteRestart).not.toHaveBeenCalled();
    });

    it('notes no restart when the PTY fails to start', async () => {
      const indexer = { ...fakeIndexer(), noteRestart: vi.fn() };
      const spawner = fakeSpawner();
      spawner.spawn.mockImplementation(() => {
        throw new Error('made-up failure');
      });
      const { server } = await start({ indexer, spawner });
      const client = await ready(server.port);
      send(client, { type: 'open', sessionId: IDLE_ID, cols: 80, rows: 24, restart: true });
      expect(await client.next()).toMatchObject({ type: 'error' });
      expect(indexer.noteRestart).not.toHaveBeenCalled();
    });
  });

  describe('deciding on open, from fresh facts, whether attaching restarts the session', () => {
    const NOW = Date.parse('2026-10-19T12:00:00.000Z');
    const ago = (ms: number) => new Date(NOW - ms).toISOString();
    const now = () => NOW;
    const context = { now: NOW, recentlySpawned: false };

    it('attachDecision: a process means attach, whatever the state', () => {
      for (const state of [undefined, 'working', 'blocked', 'done', 'stopped', 'failed'] as const) {
        expect(attachDecision({ pid: 4242, ...(state ? { state } : {}), startedAt: ago(0) }, context), String(state)).toBe('attach');
      }
    });

    it('attachDecision: finished with no process means ask, however new', () => {
      for (const state of ['done', 'stopped', 'failed'] as const) {
        expect(attachDecision({ state, startedAt: ago(0) }, { now: NOW, recentlySpawned: true }), state).toBe('confirm');
      }
    });

    it('attachDecision: working or blocked with no process is starting within 20 s or a recent spawn, and crashed after', () => {
      expect(STARTING_GRACE_MS).toBe(20_000);
      expect(RECENT_SPAWN_MS).toBe(30_000);
      for (const state of ['working', 'blocked'] as const) {
        expect(attachDecision({ state, startedAt: ago(0) }, context), state).toBe('starting');
        expect(attachDecision({ state, startedAt: ago(19_999) }, context), state).toBe('starting');
        // In the future, as a clock step could make it: still starting.
        expect(attachDecision({ state, startedAt: new Date(NOW + 5_000).toISOString() }, context), state).toBe('starting');
        expect(attachDecision({ state, startedAt: ago(20_000) }, context), state).toBe('confirm');
        expect(attachDecision({ state, startedAt: ago(3_600_000) }, { now: NOW, recentlySpawned: true }), state).toBe('starting');
        expect(attachDecision({ state, startedAt: 'not a date' }, context), state).toBe('confirm');
      }
    });

    it('attachDecision: no process and no known state means ask', () => {
      expect(attachDecision({ startedAt: ago(0) }, { now: NOW, recentlySpawned: true })).toBe('confirm');
    });

    it("doesn't re-read for a session whose process is still running, and attaches", async () => {
      const { server, agents } = await start({ now });
      await attached(server.port);
      expect(agents.reads).toBe(0);
    });

    it('attaches with no prompt when the snapshot shows no process but the re-read does', async () => {
      const agents = fakeAgents({ ok: true, rows: [row({ sessionId: IDLE_ID, shortId: 'bgidle', pid: 5151, state: 'blocked' })] });
      const { server, spawner } = await start({ agents, now });
      const client = await ready(server.port);
      send(client, { type: 'open', sessionId: IDLE_ID, cols: 80, rows: 24 });
      expect(await client.next()).toEqual({ type: 'attached' });
      expect(agents.reads).toBe(1);
      expect(spawner.last.args).toEqual(['attach', 'bgidle']);
    });

    it('asks first when the process died since the last poll, rather than letting claude attach restart it unasked', async () => {
      const agents = fakeAgents({ ok: true, rows: [row({ sessionId: BG_ID, shortId: 'bg1234', state: 'working', startedAt: ago(3_600_000) })] });
      const { server, spawner } = await start({ agents, now, processAlive: (pid) => pid !== 4242 });
      const client = await ready(server.port);
      send(client, { type: 'open', sessionId: BG_ID, cols: 80, rows: 24 });
      expect(await client.next()).toEqual({ type: 'needs-restart' });
      expect(agents.reads).toBe(1);
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it('says a just-spawned session is still starting, without asking, even when told restart: true', async () => {
      const agents = fakeAgents({ ok: true, rows: [row({ sessionId: IDLE_ID, shortId: 'bgidle', state: 'working', startedAt: ago(5_000) })] });
      const { server, spawner } = await start({ agents, now });
      for (const restart of [undefined, true]) {
        const client = await ready(server.port);
        send(client, { type: 'open', sessionId: IDLE_ID, cols: 80, rows: 24, ...(restart ? { restart } : {}) });
        expect(await expectRefused(client, WS_CLOSE_TRY_AGAIN)).toBe(STILL_STARTING);
      }
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it("judges by the fresh row, not the snapshot's: a new row is starting even if the snapshot's is old", async () => {
      // The snapshot says IDLE_ID started on 2026-10-16; the re-read says 3 s ago.
      const agents = fakeAgents({ ok: true, rows: [row({ sessionId: IDLE_ID, shortId: 'bgidle', state: 'working', startedAt: ago(3_000) })] });
      const { server } = await start({ agents, now });
      const client = await ready(server.port);
      send(client, { type: 'open', sessionId: IDLE_ID, cols: 80, rows: 24 });
      expect(await expectRefused(client, WS_CLOSE_TRY_AGAIN)).toBe(STILL_STARTING);
    });

    it('asks first for a working session with no process that started long ago: it crashed', async () => {
      const agents = fakeAgents({ ok: true, rows: [row({ sessionId: IDLE_ID, shortId: 'bgidle', state: 'working', startedAt: ago(60_000) })] });
      const { server } = await start({ agents, now });
      const client = await ready(server.port);
      send(client, { type: 'open', sessionId: IDLE_ID, cols: 80, rows: 24 });
      expect(await client.next()).toEqual({ type: 'needs-restart' });
    });

    it("falls back to the snapshot's facts, without its pid, when the re-read fails or no longer lists the session", async () => {
      for (const result of [{ ok: false, error: 'claude agents --json --all timed out after 5s' }, { ok: true, rows: [] }] as AgentsResult[]) {
        const agents = fakeAgents(result);
        const { server } = await start({ agents, now, processAlive: () => false });
        const client = await ready(server.port);
        send(client, { type: 'open', sessionId: BG_ID, cols: 80, rows: 24 });
        expect(await client.next()).toEqual({ type: 'needs-restart' });
      }
    });

    it('re-reads once for several sockets that open at the same time', async () => {
      let answer!: (result: AgentsResult) => void;
      const agents = fakeAgents();
      agents.list.mockImplementation(() => {
        agents.reads += 1;
        return new Promise<AgentsResult>((resolve) => (answer = resolve));
      });
      const { server } = await start({ agents, now });
      const clients = await Promise.all([ready(server.port), ready(server.port), ready(server.port)]);
      for (const client of clients) send(client, { type: 'open', sessionId: IDLE_ID, cols: 80, rows: 24 });
      await waitFor(() => agents.reads === 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(agents.reads).toBe(1);
      answer({ ok: true, rows: [] });
      for (const client of clients) expect(await client.next()).toEqual({ type: 'needs-restart' });
    });

    it('refuses another message while it decides, and starts nothing for a socket that closed meanwhile', async () => {
      let answer!: (result: AgentsResult) => void;
      const agents = fakeAgents();
      agents.list.mockImplementation(() => new Promise<AgentsResult>((resolve) => (answer = resolve)));
      const { server, spawner } = await start({ agents, now });

      const impatient = await ready(server.port);
      send(impatient, { type: 'open', sessionId: IDLE_ID, cols: 80, rows: 24 });
      await waitFor(() => agents.list.mock.calls.length === 1);
      send(impatient, { type: 'open', sessionId: IDLE_ID, cols: 80, rows: 24, restart: true });
      expect(await expectRefused(impatient)).toMatch(/Wait for the answer to open/);

      const gone = await ready(server.port);
      send(gone, { type: 'open', sessionId: IDLE_ID, cols: 80, rows: 24, restart: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      gone.ws.close();
      await gone.closed;
      answer({ ok: true, rows: [row({ sessionId: IDLE_ID, shortId: 'bgidle', pid: 5151, state: 'blocked' })] });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it('treats a session this pitwall just spawned as starting, through the spawn route', async () => {
      // A real directory for the root, because spawn checks the cwd's realpath.
      const root = await realpath(webRoot);
      const spawnedRow = summary({ sessionId: IDLE_ID, shortId: 'bgnew', cwd: root, pid: undefined, alive: false, status: undefined, state: 'working' });
      const indexer = fakeIndexer({ ...snapshot([spawnedRow]), roots: [root], groups: [{ key: root, label: 'root', kind: 'directory', root, sessions: [spawnedRow] }] });
      const run = vi.fn(async (): Promise<CommandResult> => ({ kind: 'exited', code: 0, stdout: 'backgrounded · bgnew · pitwall-test-spawned\n', stderr: '' }));
      // The fresh row still has no process, and startedAt is an hour old, as for a restarted job.
      const agents = fakeAgents({ ok: true, rows: [row({ sessionId: IDLE_ID, shortId: 'bgnew', cwd: root, state: 'working', startedAt: ago(3_600_000) })] });
      const { server } = await start({ indexer, agents, now, actions: { run, env: {} } });

      // Before the spawn, it would be asked about.
      const before = await ready(server.port);
      send(before, { type: 'open', sessionId: IDLE_ID, cols: 80, rows: 24 });
      expect(await before.next()).toEqual({ type: 'needs-restart' });

      const response = await fetch(`http://127.0.0.1:${server.port}${SPAWN_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await apiKeyOf(server.port)}`, origin: pitwallOrigin(server.port), 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: root, prompt: 'Reply with: ready', name: 'pitwall-test-spawned' }),
      });
      expect(response.status).toBe(201);

      const after = await ready(server.port);
      send(after, { type: 'open', sessionId: IDLE_ID, cols: 80, rows: 24 });
      expect(await expectRefused(after, WS_CLOSE_TRY_AGAIN)).toBe(STILL_STARTING);
    });

    it('says an ended session this pitwall just resumed is starting, through the resume route, while the snapshot still shows it ended', async () => {
      const root = await realpath(webRoot);
      const endedRow = summary({ ...(SESSIONS.find((s) => s.sessionId === ENDED_ID) as SessionSummary), cwd: root });
      const indexer = fakeIndexer({ ...snapshot([endedRow]), roots: [root], groups: [{ key: root, label: 'root', kind: 'directory', root, sessions: [endedRow] }] });
      const run = vi.fn(async (): Promise<CommandResult> => ({ kind: 'exited', code: 0, stdout: 'backgrounded · 77777777 (idle — send a prompt to start)\n', stderr: '' }));
      const { server, spawner } = await start({ indexer, now, actions: { run, env: {}, agents: fakeAgents() } });

      const before = await ready(server.port);
      send(before, { type: 'open', sessionId: ENDED_ID, cols: 80, rows: 24 });
      expect(await expectRefused(before)).toMatch(/has ended/);

      const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${ENDED_ID}/resume`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await apiKeyOf(server.port)}`, origin: pitwallOrigin(server.port) },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, shortId: '77777777' });

      const after = await ready(server.port);
      send(after, { type: 'open', sessionId: ENDED_ID, cols: 80, rows: 24 });
      expect(await expectRefused(after, WS_CLOSE_TRY_AGAIN)).toBe(STILL_STARTING);
      expect(spawner.spawn).not.toHaveBeenCalled();
    });
  });

  describe('once attached', () => {
    it('sends the PTY output as binary frames', async () => {
      const { server, spawner } = await start();
      const client = await attached(server.port);
      spawner.last.emit('\u001b[2Jhello ✓');
      await waitFor(() => client.output.length > 0);
      expect(client.text()).toBe('\u001b[2Jhello ✓');
      expect(client.messages).toEqual([]);
    });

    it('writes input to the PTY', async () => {
      const { server, spawner } = await start();
      const client = await attached(server.port);
      send(client, { type: 'input', data: 'what is 2+2?\r' });
      await waitFor(() => client.text() === 'echo:what is 2+2?\r');
      expect(spawner.last.written).toEqual(['what is 2+2?\r']);
    });

    it('resizes the PTY', async () => {
      const { server, spawner } = await start();
      const client = await attached(server.port);
      send(client, { type: 'resize', cols: COLS_RANGE.max, rows: ROWS_RANGE.max });
      send(client, { type: 'resize', cols: COLS_RANGE.min, rows: ROWS_RANGE.min });
      await waitFor(() => spawner.last.sizes.length === 2);
      expect(spawner.last.sizes).toEqual([
        [500, 200],
        [2, 2],
      ]);
    });

    it.each([
      { cols: 1, rows: 24 },
      { cols: 501, rows: 24 },
      { cols: 80, rows: 1 },
      { cols: 80, rows: 201 },
      { cols: 80.5, rows: 24 },
      { cols: '80', rows: 24 },
      { cols: 80 },
    ])('refuses a resize to $cols x $rows, and detaches', async (size) => {
      const { server, spawner } = await start();
      const client = await attached(server.port);
      send(client, { type: 'resize', ...size });
      expect(await expectRefused(client)).toMatch(/cols must be a whole number from 2 to 500, and rows from 2 to 200/);
      expect(spawner.last.sizes).toEqual([]);
      await waitFor(() => spawner.last.killed.length > 0);
    });

    it('refuses an open with a size out of bounds, without spawning', async () => {
      const { server, spawner } = await start();
      const client = await ready(server.port);
      send(client, { type: 'open', sessionId: BG_ID, cols: 80, rows: 1000 });
      expect(await expectRefused(client)).toMatch(/rows from 2 to 200/);
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it('closes the socket on an input frame over the cap, and kills the PTY', async () => {
      const { server, spawner } = await start();
      const client = await attached(server.port);
      send(client, { type: 'input', data: 'a'.repeat(ATTACH_MAX_PAYLOAD_BYTES) });
      expect((await client.closed).code).toBe(1009);
      await waitFor(() => spawner.last.killed.length > 0);
      expect(spawner.last.written).toEqual([]);
    });

    it('accepts input just under the cap', async () => {
      const { server, spawner } = await start();
      const client = await attached(server.port);
      const data = 'a'.repeat(ATTACH_MAX_PAYLOAD_BYTES - 64);
      send(client, { type: 'input', data });
      await waitFor(() => spawner.last.written.length === 1);
      expect(spawner.last.written[0]).toBe(data);
    });

    it('refuses binary frames, malformed JSON and unknown types', async () => {
      const { server } = await start();
      const binary = await attached(server.port);
      binary.ws.send(Buffer.from('{"type":"input","data":"x"}'));
      expect(await expectRefused(binary)).toMatch(/Binary frames/);

      const malformed = await attached(server.port);
      send(malformed, '{not json');
      expect(await expectRefused(malformed)).toMatch(/Not a JSON object/);

      const unknown = await attached(server.port);
      send(unknown, { type: 'stop' });
      expect(await expectRefused(unknown)).toMatch(/Unknown message type/);
    });

    it('pauses the PTY while the socket is backed up', async () => {
      const { server, spawner } = await start();
      const client = await attached(server.port);
      // Stop reading on the client, so the server's send buffer fills.
      (client.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket.pause();
      const chunk = 'x'.repeat(256 * 1024);
      for (let i = 0; i < 64 && !spawner.last.paused; i += 1) spawner.last.emit(chunk);
      expect(spawner.last.paused).toBe(true);
      (client.ws as unknown as { _socket: { resume(): void } })._socket.resume();
      await waitFor(() => !spawner.last.paused, 5000);
    });
  });

  describe('detaching and exit', () => {
    it('kills the PTY when the socket closes, and sends nothing more', async () => {
      const { server, spawner } = await start();
      const client = await attached(server.port);
      client.ws.close(1000);
      await client.closed;
      await waitFor(() => spawner.last.killed.length > 0);
      expect(spawner.last.killed).toEqual(['SIGHUP']);
      expect(client.messages).toEqual([]);
    });

    it('sends exit with the code and closes when claude attach ends on its own', async () => {
      const { server, spawner } = await start();
      const client = await attached(server.port);
      spawner.last.exit(3);
      expect(await client.next()).toEqual({ type: 'exit', code: 3 });
      expect((await client.closed).code).toBe(1000);
      expect(spawner.last.killed).toEqual([]);
    });

    it('reports a null code when claude attach was ended by a signal', async () => {
      const { server, spawner } = await start();
      const client = await attached(server.port);
      spawner.last.exit(0, 9);
      expect(await client.next()).toEqual({ type: 'exit', code: null });
    });

    it('reports a PTY that fails to start, and closes with 1011', async () => {
      const spawner = fakeSpawner();
      spawner.spawn.mockImplementationOnce(() => {
        throw new Error('posix_spawnp failed.');
      });
      const { server } = await start({ spawner });
      const client = await ready(server.port);
      send(client, { type: 'open', sessionId: BG_ID, cols: 80, rows: 24 });
      expect(await expectRefused(client, 1011)).toBe("Couldn't start claude attach: posix_spawnp failed.");
    });
  });

  describe('the limit', () => {
    it(`allows ${MAX_ATTACHED} sockets past the handshake, and closes the next with ${WS_CLOSE_TOO_MANY}`, async () => {
      const { server, spawner } = await start();
      const clients: Client[] = [];
      for (let i = 0; i < MAX_ATTACHED; i += 1) clients.push(await attached(server.port));

      const fifth = connect(server.port);
      expect(await handshake(fifth)).toEqual({ code: WS_CLOSE_TOO_MANY });
      expect(fifth.messages).toEqual([]);
      expect(spawner.spawn).toHaveBeenCalledTimes(MAX_ATTACHED);

      // Detaching one frees its place.
      clients[0]!.ws.close();
      await waitFor(() => spawner.ptys[0]!.killed.length > 0);
      await attached(server.port);
    });

    it('counts a socket waiting at ready, and not one still in the handshake', async () => {
      const { server } = await start();
      const pending = connect(server.port);
      const challenge = await pending.next();
      for (let i = 0; i < MAX_ATTACHED; i += 1) await ready(server.port);
      expect(await handshake(connect(server.port))).toEqual({ code: WS_CLOSE_TOO_MANY });
      // The one that hadn't answered yet didn't hold a place, and can't take one now.
      if (challenge.type !== 'challenge') throw new Error('expected a challenge');
      send(pending, { type: 'auth', proof: proofFor(challenge.nonce, server.port) });
      expect((await pending.closed).code).toBe(WS_CLOSE_TOO_MANY);
    });
  });

  describe('close()', () => {
    it('closes every attach socket with 1001 and kills every PTY', async () => {
      const { server, spawner } = await start();
      const clients = [await attached(server.port), await attached(server.port), await ready(server.port)];
      await server.close();
      for (const client of clients) expect((await client.closed).code).toBe(1001);
      expect(spawner.ptys).toHaveLength(2);
      for (const pty of spawner.ptys) expect(pty.killed).toEqual(['SIGHUP']);
    });

    it('kills a PTY that ignores SIGHUP with SIGKILL', async () => {
      const spawner = fakeSpawner();
      const { server } = await start({ spawner });
      await attached(server.port);
      const pty = spawner.last;
      pty.kill = (signal = 'SIGHUP') => {
        pty.killed.push(signal);
        if (signal === 'SIGKILL') setImmediate(() => pty.exit(0, 9));
      };
      await server.close();
      expect(pty.killed).toEqual(['SIGHUP', 'SIGKILL']);
    }, 10_000);
  });

  describe('the environment', () => {
    // The scrubber itself, name by name, is tested in command.test.ts.
    it("gives the PTY the environment through the shared scrubber: no PITWALL_*, npm's, the session's identity or anything holding the token", async () => {
      const env = {
        ...ENV,
        PITWALL_TOKEN: TOKEN,
        PITWALL_HOME: '/Users/example/.pitwall',
        pitwall_open_marker: '/tmp/marker',
        COPIED: `Bearer ${TOKEN}`,
        npm_config_save_exact: 'true',
        INIT_CWD: '/Users/example/pitwall',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: '99999999-9999-4999-8999-999999999999',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_MESSAGING_TOKEN: 'inbox',
        CLAUDE_JOB_DIR: '/j',
        UNSET: undefined,
      };
      const { server, spawner } = await start({ env });
      await attached(server.port);
      const childEnv = spawner.last.options.env;
      expect(childEnv).toEqual(ENV);
      expect(JSON.stringify(childEnv)).not.toContain(TOKEN);
    });
  });
});

// The real node-pty, with /bin/echo rather than claude, so CI shows the native
// module was built and can start a process.
describe.skipIf(process.platform === 'win32')('spawnPty', () => {
  it('runs a process in a PTY through node-pty', async () => {
    const pty = spawnPty('/bin/echo', ['pitwall-pty-ok'], {
      cols: 80,
      rows: 24,
      cwd: tmpdir(),
      env: { PATH: '/usr/bin:/bin' },
      name: 'xterm-256color',
    });
    let output = '';
    pty.onData((data) => {
      output += data;
    });
    const exit = await new Promise<{ exitCode: number }>((resolve) => pty.onExit(resolve));
    expect(exit.exitCode).toBe(0);
    await waitFor(() => output.includes('pitwall-pty-ok'));
  });
});
