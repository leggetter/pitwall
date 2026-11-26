import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { Indexer } from '../index/index.js';
import {
  TRUST_PATH,
  WS_CLOSE_TOO_MANY,
  WS_CLOSE_UNAUTHORIZED,
  type IndexSnapshot,
  type TrustServerMessage,
} from '../shared/protocol.js';
import { WS_CLOSE_POLICY } from './attach.js';
import { isPitwallOwn } from './own.js';
import { WS_CLOSE_TRY_AGAIN } from './handshake.js';
import type { RunningServer } from './index.js';
import type { PtyProcess, PtySpawnOptions } from './pty.js';
import { pitwallOrigin, proofFor as contractProof } from '../test/proof.js';
import { checkDirectory } from './actions.js';
import { startServerWithInternals, type ServerInternals } from './server.js';
import {
  HIDE_AFTER_EXIT_MS,
  KILL_GRACE_MS,
  OPEN_TIMEOUT_MS,
  OwnPids,
  SETTLE_MS,
  TRUST_BUSY,
  TRUST_KEYS,
  TRUST_MARKER_PATH,
  TRUST_OPEN_LATE,
  TRUST_OPENS,
  TrustReader,
  hasScreenMarker,
  screenText,
  trustKey,
} from './trust.js';

// The real checkDirectory(), which a test can make hang for one call.
vi.mock('./actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./actions.js')>();
  return { ...actual, checkDirectory: vi.fn(actual.checkDirectory) };
});

// No test here runs `claude`: every PTY is a FakePty. The screens are written by hand from spike 020's
// strings (TRUST_SCREEN), not taken from a real transcript.

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const ENV = { PATH: '/usr/bin:/bin', HOME: '/Users/example', PITWALL_TOKEN: TOKEN, KEEP_ME: 'yes' };

// ---------------------------------------------------------------- screens

const ESC = '\u001b';
/** The trust prompt, drawn with colours and cursor moves, as Ink draws it: No first, and selected (spike 020, finding 1). */
const PROMPT_SCREEN =
  `${ESC}[2J${ESC}[H${ESC}[1mDo you trust the files in this folder?${ESC}[22m\r\n` +
  `${ESC}[36m❯ No, exit${ESC}[39m\r\n  Yes, I trust this folder\r\n\r\n` +
  `${ESC}[2mEnter to confirm · Esc to cancel${ESC}[22m\r\n`;
/** The welcome banner, once trusted. */
const BANNER_SCREEN = `${ESC}[2J${ESC}[H${ESC}[38;5;174m✻${ESC}[39m Welcome to ${ESC}[1mClaude Code v2.1.332${ESC}[22m\r\n  cwd: /tmp/x\r\n`;
/** A project .mcp.json's question, which spike 020 saw between Yes and the banner. */
const MCP_SCREEN = `\r\n${ESC}[1mNew MCP server found in .mcp.json: example${ESC}[22m\r\n❯ 1. Use this MCP server\r\n  2. Continue without\r\n${ESC}[2mEnter to confirm · Esc to reject${ESC}[22m\r\n`;
/** The prompt line after it's answered, and the empty input box. */
const IDLE_SCREEN = `\r\n${ESC}[2m> ${ESC}[22m\r\n`;
/** What No and Esc print before `claude` exits. */
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const DECLINED_SCREEN = `\r\n${ESC}[31mClaude Code didn’t start because this folder isn’t trusted.${ESC}[39m\r\n`;

// ---------------------------------------------------------------- unit: keys

describe('trustKey', () => {
  it.each([
    ['\u001b[A', 'up'],
    ['\u001bOA', 'up'],
    ['\u001b[B', 'down'],
    ['\u001bOB', 'down'],
    ['\r', 'enter'],
    ['\u001b', 'esc'],
  ])('forwards %j as %s', (data, key) => {
    expect(trustKey(data)).toBe(key);
  });

  it('has exactly those six sequences', () => {
    expect([...TRUST_KEYS.keys()].sort()).toEqual(['\r', '\u001b', '\u001b[A', '\u001b[B', '\u001bOA', '\u001bOB'].sort());
  });

  it.each([
    ['a pasted string', 'claude --dangerously-skip-permissions\r'],
    ['a bracketed paste', '\u001b[200~rm -rf ~\u001b[201~'],
    ['Ctrl-C', '\u0003'],
    ['Ctrl-D', '\u0004'],
    ['Tab', '\t'],
    ['a newline', '\n'],
    ['a letter', 'y'],
    ['a digit', '1'],
    ['Right', '\u001b[C'],
    ['Left', '\u001b[D'],
    ['Up twice', '\u001b[A\u001b[A'],
    ['Up then a letter', '\u001b[Ax'],
    ['a letter then Enter', 'y\r'],
    ['Enter then a newline', '\r\n'],
    ['Esc with a modifier', '\u001b[1;5A'],
    ['the empty string', ''],
  ])('drops %s', (_name, data) => {
    expect(trustKey(data)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- unit: reader

describe('screenText', () => {
  it('replaces escapes with a space, strips controls and collapses spaces', () => {
    expect(screenText(`${ESC}[1mYes,${ESC}[1CI  trust${ESC}]0;title\u0007\u0000 this`)).toBe(' Yes, I trust this');
  });
});

describe('TrustReader', () => {
  it('reads the prompt, then Yes, then the banner, as settled', () => {
    const reader = new TrustReader();
    expect(reader.settled()).toBe(false);
    reader.feed(PROMPT_SCREEN);
    expect(reader.promptSeen).toBe(true);
    expect(reader.bannerSeen).toBe(false);
    expect(reader.settled()).toBe(false);
    // No is the default, so Yes is Down, then Enter, which answers it.
    reader.answered();
    expect(reader.settled()).toBe(false);
    reader.feed(BANNER_SCREEN);
    expect(reader.bannerSeen).toBe(true);
    expect(reader.settled()).toBe(true);
    reader.feed(IDLE_SCREEN);
    expect(reader.settled()).toBe(true);
    expect(reader.exitOutcome()).toBe('trusted');
  });

  it('finds a string split across two chunks', () => {
    const reader = new TrustReader();
    reader.feed('Do you trust the files? ❯ 1. Yes, I tr');
    expect(reader.promptSeen).toBe(false);
    reader.feed('ust this folder\r\n');
    expect(reader.promptSeen).toBe(true);
    reader.feed('Welcome to Claude Co');
    expect(reader.bannerSeen).toBe(false);
    reader.feed('de v2.1.332');
    expect(reader.bannerSeen).toBe(true);
  });

  it('holds an escape cut off at the end of a chunk for the next', () => {
    const reader = new TrustReader();
    // Cut inside the CSI: without the carry, "8;5;174m" would land between the words.
    reader.feed(`Yes, I trust ${ESC}[3`);
    reader.feed(`8;5;174mthis folder`);
    expect(reader.promptSeen).toBe(true);
    // A whole escape at the start of the next chunk, after a space: one space between the words.
    const whole = new TrustReader();
    whole.feed('Yes, I trust ');
    whole.feed(`${ESC}[1mthis folder`);
    expect(whole.promptSeen).toBe(true);
    const other = new TrustReader();
    // Cut right after ESC.
    other.feed(`Claude Code${ESC}`);
    other.feed(`[1C v2.1.332`);
    expect(other.bannerSeen).toBe(true);
  });

  it('finds a string split across many small chunks, past the tail it keeps', () => {
    const reader = new TrustReader();
    // A long screen first, so the tail is trimmed between chunks.
    reader.feed('x'.repeat(500));
    for (const char of PROMPT_SCREEN) reader.feed(char);
    expect(reader.promptSeen).toBe(true);
    reader.answered();
    for (const char of BANNER_SCREEN) reader.feed(char);
    expect(reader.settled()).toBe(true);
  });

  it('keeps a question after the banner open until it is answered', () => {
    const reader = new TrustReader();
    reader.feed(PROMPT_SCREEN);
    reader.answered();
    reader.feed(BANNER_SCREEN);
    expect(reader.settled()).toBe(true);
    reader.feed(MCP_SCREEN);
    expect(reader.settled()).toBe(false);
    reader.feed(`${ESC}[2K`); // a redraw with nothing new
    expect(reader.settled()).toBe(false);
    reader.answered();
    expect(reader.settled()).toBe(true);
    reader.feed(IDLE_SCREEN);
    expect(reader.settled()).toBe(true);
    // A second question after that one.
    reader.feed(MCP_SCREEN);
    expect(reader.settled()).toBe(false);
  });

  it('keeps a question before the banner open until it is answered, then settles on the banner', () => {
    const reader = new TrustReader();
    reader.feed(PROMPT_SCREEN);
    expect(reader.questionOpen()).toBe(true);
    reader.answered();
    expect(reader.questionOpen()).toBe(false);
    reader.feed(MCP_SCREEN);
    expect(reader.questionOpen()).toBe(true);
    expect(reader.settled()).toBe(false);
    reader.answered();
    expect(reader.questionOpen()).toBe(false);
    expect(reader.settled()).toBe(false);
    reader.feed(BANNER_SCREEN);
    expect(reader.settled()).toBe(true);
  });

  it('has a question open only from its drawing to the next Enter or Esc', () => {
    const reader = new TrustReader();
    expect(reader.questionOpen()).toBe(false);
    reader.feed(BANNER_SCREEN + IDLE_SCREEN);
    expect(reader.questionOpen()).toBe(false);
    reader.feed(MCP_SCREEN);
    expect(reader.questionOpen()).toBe(true);
    reader.feed(`${ESC}[2K`);
    expect(reader.questionOpen()).toBe(true);
    reader.answered();
    expect(reader.questionOpen()).toBe(false);
    reader.feed(IDLE_SCREEN);
    expect(reader.questionOpen()).toBe(false);
  });

  it('keeps the banner and a question in one chunk unsettled', () => {
    const reader = new TrustReader();
    reader.feed(PROMPT_SCREEN);
    reader.answered();
    reader.feed(BANNER_SCREEN + MCP_SCREEN);
    expect(reader.settled()).toBe(false);
  });

  it('reads declined, with either quote mark and a line break between the words', () => {
    const curly = new TrustReader();
    curly.feed(PROMPT_SCREEN);
    curly.feed(DECLINED_SCREEN);
    expect(curly.declinedSeen).toBe(true);
    expect(curly.exitOutcome()).toBe('declined');
    const straight = new TrustReader();
    straight.feed("Claude Code didn't start because this\r\nfolder isn't trusted.");
    expect(straight.declinedSeen).toBe(true);
    expect(straight.exitOutcome()).toBe('declined');
  });

  it('gives the exit outcomes', () => {
    expect(new TrustReader().exitOutcome()).toBe('unclear');
    const garbage = new TrustReader();
    garbage.feed('Error: something went wrong\r\n');
    expect(garbage.exitOutcome()).toBe('unclear');
    const prompted = new TrustReader();
    prompted.feed(PROMPT_SCREEN);
    expect(prompted.exitOutcome()).toBe('declined');
    const trusted = new TrustReader();
    trusted.feed(BANNER_SCREEN);
    expect(trusted.exitOutcome()).toBe('trusted');
  });

  it('gives declined for the declined line after the banner, as a path with the banner in it would show', () => {
    const reader = new TrustReader();
    reader.feed(PROMPT_SCREEN.replace('this folder?', 'this folder?\r\n/tmp/Claude Code v1'));
    expect(reader.bannerSeen).toBe(true);
    reader.answered();
    reader.feed(DECLINED_SCREEN);
    expect(reader.exitOutcome()).toBe('declined');
    // The declined line before a real banner doesn't undo it.
    const before = new TrustReader();
    before.feed(DECLINED_SCREEN + BANNER_SCREEN);
    expect(before.exitOutcome()).toBe('trusted');
  });
});

describe('hasScreenMarker', () => {
  it.each([
    ['the banner', '/r/Claude Code v2'],
    ['the banner in another case and spacing', '/r/claude   CODE\tv'],
    ['the question', '/r/enter to confirm'],
    ["Yes's text", '/r/Yes, I trust this folder'],
    ['the declined line', "/r/didn't start because this folder isn't trusted"],
    ['the declined line with a curly quote, spaced, in capitals', '/r/DIDN’T  START because this folder ISN’T trusted'],
  ])('finds %s', (_name, path) => {
    expect(hasScreenMarker(path)).toBe(true);
  });

  it.each(['/r/project', '/r/claude-code', '/r/Claude Code', '/r/enter-to-confirm', '/r/trust this folder'])('passes %s', (path) => {
    expect(hasScreenMarker(path)).toBe(false);
  });
});

// ---------------------------------------------------------------- unit: pids

describe('OwnPids', () => {
  afterEach(() => vi.useRealTimers());

  it('hides a pid while it runs and for HIDE_AFTER_EXIT_MS after', () => {
    vi.useFakeTimers();
    const own = new OwnPids();
    expect(own.isOwn({ pid: 4242 })).toBe(false);
    own.add(4242);
    expect(own.isOwn({ pid: 4242 })).toBe(true);
    expect(own.isOwn({ pid: 4243 })).toBe(false);
    expect(own.isOwn({})).toBe(false);
    own.release(4242);
    vi.advanceTimersByTime(HIDE_AFTER_EXIT_MS - 1);
    expect(own.has(4242)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(own.has(4242)).toBe(false);
  });

  it('keeps a pid that is added again before its release runs out', () => {
    vi.useFakeTimers();
    const own = new OwnPids();
    own.add(7);
    own.release(7);
    vi.advanceTimersByTime(HIDE_AFTER_EXIT_MS - 1);
    own.add(7);
    vi.advanceTimersByTime(HIDE_AFTER_EXIT_MS * 2);
    expect(own.has(7)).toBe(true);
  });

  it("is isPitwallOwn()'s trust source", () => {
    const own = new OwnPids();
    const exclude = isPitwallOwn({ relay: { isRelay: () => false }, trust: own });
    const row = { sessionId: '88888888-8888-4888-8888-888888888888', name: 'pitwall-test-trust', kind: 'interactive', cwd: '/tmp/x', startedAt: '2026-11-26T00:00:00.000Z', pid: 31 } as const;
    expect(exclude(row)).toBe(false);
    own.add(31);
    expect(exclude(row)).toBe(true);
    expect(exclude({ ...row, pid: 32 })).toBe(false);
  });

  it('ignores the release of a pid it never had', () => {
    const own = new OwnPids();
    own.release(9);
    expect(own.has(9)).toBe(false);
  });
});

// ---------------------------------------------------------------- fixtures

let base: string;
/** The snapshot's one root, as its realpath (macOS's tmpdir is under a symlink). */
let root: string;
let inside: string;
let outside: string;
let link: string;
let file: string;
let quoted: string;
let bannerDir: string;
let questionDir: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-test-trust-')));
  root = join(base, 'root');
  inside = join(root, 'project');
  outside = join(base, 'elsewhere');
  link = join(root, 'link-out');
  file = join(root, 'notes.txt');
  quoted = join(root, "it's");
  bannerDir = join(root, 'Claude Code v9');
  questionDir = join(root, 'press ENTER  to confirm');
  await mkdir(inside, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(quoted, { recursive: true });
  await mkdir(bannerDir, { recursive: true });
  await mkdir(questionDir, { recursive: true });
  await symlink(outside, link);
  await writeFile(file, 'not a folder\n');
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

function snapshot(): IndexSnapshot {
  return { generatedAt: '2026-11-26T00:00:00.000Z', roots: [root], groups: [], source: { ok: true } };
}

function fakeIndexer(latest: () => IndexSnapshot | undefined = snapshot): Indexer {
  return {
    latest,
    subscribe: () => () => {},
    conversation: async () => undefined,
    subagents: async () => undefined,
    subagentConversation: async () => undefined,
    pollSoon: () => {},
    noteRestart: () => {},
    turnState: async () => 'unknown',
    runningSubagents: async () => undefined,
    stop: () => {},
  };
}

let nextPid = 70_000;

/** A stand-in for `claude`: records what's written, and exits on a signal unless it's stubborn. */
class FakePty implements PtyProcess {
  readonly pid = nextPid++;
  written: string[] = [];
  sizes: [number, number][] = [];
  killed: string[] = [];
  /** Ignores SIGHUP, so only SIGKILL ends it. */
  stubborn = false;
  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  exited = false;

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
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  kill(signal = 'SIGHUP') {
    this.killed.push(signal);
    if (this.stubborn && signal !== 'SIGKILL') return;
    setImmediate(() => this.exit(signal === 'SIGKILL' ? 137 : 129));
  }
  pause() {}
  resume() {}
  emit(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }
  exit(exitCode: number) {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener({ exitCode });
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
  vi.useRealTimers();
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function start(
  options: {
    indexer?: Indexer;
    spawner?: ReturnType<typeof fakeSpawner>;
    trust?: ServerInternals['trust'];
    trustPids?: OwnPids;
    authTimeoutMs?: number;
  } = {},
) {
  const spawner = options.spawner ?? fakeSpawner();
  const trustPids = options.trustPids ?? new OwnPids();
  const server = await startServerWithInternals(
    { indexer: options.indexer ?? fakeIndexer(), token: TOKEN, webRoot, port: 0, trustPids },
    {
      ...(options.authTimeoutMs === undefined ? {} : { authTimeoutMs: options.authTimeoutMs }),
      // Short by default, so a test needn't wait the real second; the timing test uses the real ones.
      trust: { spawnPty: spawner.spawn, env: ENV, settleMs: 20, killGraceMs: 100, ...options.trust },
    },
  );
  running.push(server);
  return { server, spawner, trustPids };
}

// ---------------------------------------------------------------- clients

interface Client {
  ws: WebSocket;
  port: number;
  messages: TrustServerMessage[];
  output: Buffer[];
  closed: Promise<{ code: number }>;
  next(): Promise<TrustServerMessage>;
  text(): string;
}

function connect(port: number, options: { origin?: string | null; host?: string } = {}): Client {
  const origin = options.origin === undefined ? `http://127.0.0.1:${port}` : options.origin;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${TRUST_PATH}`, {
    ...(origin === null ? {} : { origin }),
    headers: options.host ? { host: options.host } : {},
  });
  const messages: TrustServerMessage[] = [];
  const output: Buffer[] = [];
  const waiters: ((message: TrustServerMessage) => void)[] = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      output.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      return;
    }
    const message = JSON.parse(String(data)) as TrustServerMessage;
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

const send = (client: Client, message: unknown) => client.ws.send(typeof message === 'string' ? message : JSON.stringify(message));

async function handshake(client: Client, token = TOKEN): Promise<TrustServerMessage | { code: number }> {
  const challenge = await client.next();
  if (challenge.type !== 'challenge') throw new Error(`expected a challenge, got ${challenge.type}`);
  send(client, { type: 'auth', proof: contractProof(token, challenge.nonce, pitwallOrigin(client.port)) });
  return Promise.race([client.next(), client.closed]);
}

/**
 * A socket past the handshake. The server forgets the one before when its own side of that socket
 * closes, which can land just after the client's, so a 4429 right after a close is tried again.
 */
async function ready(port: number): Promise<Client> {
  for (let attempt = 0; ; attempt += 1) {
    const client = connect(port);
    const reply = await handshake(client);
    if (attempt < 20 && 'type' in reply && reply.type === 'error' && reply.error === TRUST_BUSY) {
      await client.closed;
      await delay(10);
      continue;
    }
    expect(reply).toEqual({ type: 'ready' });
    return client;
  }
}

async function opened(port: number, cwd = inside): Promise<Client> {
  const client = await ready(port);
  send(client, { type: 'open', cwd, cols: 100, rows: 30 });
  expect(await client.next()).toEqual({ type: 'started' });
  return client;
}

async function expectRefused(client: Client, code = WS_CLOSE_POLICY): Promise<string> {
  const message = await client.next();
  if (message.type !== 'error') throw new Error(`expected an error, got ${message.type}`);
  expect((await client.closed).code).toBe(code);
  return message.error;
}

async function expectOutcome(client: Client, outcome: string): Promise<void> {
  expect(await client.next()).toEqual({ type: 'outcome', outcome });
  expect((await client.closed).code).toBe(1000);
}

function upgradeStatus(client: Client): Promise<number> {
  return new Promise((resolve, reject) => {
    client.ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    client.ws.on('open', () => reject(new Error('upgrade was accepted')));
  });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await delay(5);
  }
}

// ---------------------------------------------------------------- socket

describe('the trust socket', () => {
  describe('upgrade and auth', () => {
    it('requires this server Origin', async () => {
      const { server, spawner } = await start();
      expect(await upgradeStatus(connect(server.port, { origin: null }))).toBe(403);
      expect(await upgradeStatus(connect(server.port, { origin: 'http://evil.example' }))).toBe(403);
      expect(await upgradeStatus(connect(server.port, { origin: `http://localhost:${server.port}` }))).toBe(403);
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it('requires Host 127.0.0.1:<port>', async () => {
      const { server } = await start();
      expect(await upgradeStatus(connect(server.port, { host: `localhost:${server.port}` }))).toBe(403);
      expect(await upgradeStatus(connect(server.port, { host: `evil.example:${server.port}` }))).toBe(403);
    });

    it('answers a plain request with 426', async () => {
      const { server } = await start();
      const response = await fetch(`http://127.0.0.1:${server.port}${TRUST_PATH}`);
      expect(response.status).toBe(426);
    });

    it('closes 4401 for a proof made with the wrong token', async () => {
      const { server, spawner } = await start();
      const client = connect(server.port);
      expect(await handshake(client, 'pitwall-test-wrong-token-0123456789abcdefghij')).toEqual({ code: WS_CLOSE_UNAUTHORIZED });
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it('closes 4401 when no proof comes in time', async () => {
      const { server } = await start({ authTimeoutMs: 50 });
      const client = connect(server.port);
      expect((await client.next()).type).toBe('challenge');
      expect((await client.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
    });

    it('closes 4401 for an open before auth', async () => {
      const { server, spawner } = await start();
      const client = connect(server.port);
      expect((await client.next()).type).toBe('challenge');
      send(client, { type: 'open', cwd: inside, cols: 80, rows: 24 });
      expect((await client.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(spawner.spawn).not.toHaveBeenCalled();
    });
  });

  describe('one at a time', () => {
    it('refuses a second socket past the handshake with 4429, and takes one after the first closes', async () => {
      const { server } = await start();
      const first = await ready(server.port);
      const second = connect(server.port);
      const reply = await handshake(second);
      expect(reply).toEqual({ type: 'error', error: TRUST_BUSY });
      expect((await second.closed).code).toBe(WS_CLOSE_TOO_MANY);
      first.ws.close();
      await first.closed;
      const third = await ready(server.port);
      third.ws.close();
    });

    it("doesn't count a socket that never authenticated", async () => {
      const { server } = await start();
      const waiting = connect(server.port);
      expect((await waiting.next()).type).toBe('challenge');
      const client = await ready(server.port);
      client.ws.close();
      waiting.ws.close();
    });
  });

  describe('the folder', () => {
    it('runs bare claude in the folder, with a child environment and PWD', async () => {
      const { server, spawner } = await start();
      const client = await opened(server.port);
      const pty = spawner.last;
      expect(pty.file).toBe('claude');
      expect(pty.args).toEqual([]);
      expect(pty.options.cwd).toBe(inside);
      expect(pty.options.cols).toBe(100);
      expect(pty.options.rows).toBe(30);
      expect(pty.options.env.PWD).toBe(inside);
      expect(pty.options.env.KEEP_ME).toBe('yes');
      expect(Object.values(pty.options.env)).not.toContain(TOKEN);
      client.ws.close();
    });

    it.each([
      ['outside the roots', () => outside, /isn't under the root/],
      ['a symlink out of the roots', () => link, /isn't under the root/],
      ['a control character', () => join(root, 'bad\u0007name'), /control characters/],
      ['a bidi control', () => join(root, 'bad‮name'), /control characters or bidi/],
      ['a file, not a folder', () => file, /isn't a directory/],
      ['a folder that is missing', () => join(root, 'missing'), /doesn't exist/],
      ['a relative path', () => 'project', /absolute/],
      ['the empty string', () => '', /required/],
      ["a path with a ' (no command to copy)", () => quoted, /has a ' or/],
      ["a path with the banner's text", () => bannerDir, TRUST_MARKER_PATH],
      ["a path with the question's text, in another case and spacing", () => questionDir, TRUST_MARKER_PATH],
    ])('refuses %s', async (_name, cwd, error) => {
      const { server, spawner } = await start();
      const client = await ready(server.port);
      send(client, { type: 'open', cwd: cwd(), cols: 80, rows: 24 });
      expect(await expectRefused(client)).toMatch(error);
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it("asks to try again before the index's first snapshot", async () => {
      const { server, spawner } = await start({ indexer: fakeIndexer(() => undefined) });
      const client = await ready(server.port);
      send(client, { type: 'open', cwd: inside, cols: 80, rows: 24 });
      await expectRefused(client, WS_CLOSE_TRY_AGAIN);
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it("says so when claude can't start", async () => {
      const spawner = fakeSpawner();
      spawner.spawn.mockImplementationOnce(() => {
        throw new Error('posix_spawnp failed.');
      });
      const { server } = await start({ spawner });
      const client = await ready(server.port);
      send(client, { type: 'open', cwd: inside, cols: 80, rows: 24 });
      expect(await expectRefused(client, 1011)).toMatch(/Couldn't start claude/);
    });
  });

  it('opens at most TRUST_OPENS.max a minute', async () => {
    let now = 1_000_000;
    const { server, spawner } = await start({ trust: { now: () => now } });
    for (let i = 0; i < TRUST_OPENS.max; i += 1) {
      const client = await opened(server.port);
      client.ws.close();
      await client.closed;
    }
    const refused = await ready(server.port);
    send(refused, { type: 'open', cwd: inside, cols: 80, rows: 24 });
    expect(await expectRefused(refused, WS_CLOSE_TRY_AGAIN)).toMatch(/at most 10 trust prompts a minute/);
    expect(spawner.spawn).toHaveBeenCalledTimes(TRUST_OPENS.max);
    now += TRUST_OPENS.windowMs;
    const again = await opened(server.port);
    again.ws.close();
  });

  describe('messages', () => {
    it.each([
      ['an unknown field in open', { type: 'open', cwd: '', cols: 80, rows: 24, args: ['--dangerously-skip-permissions'] }],
      ['an unknown type', { type: 'spawn', cwd: '' }],
      ['a size out of range', { type: 'open', cwd: '', cols: 1, rows: 24 }],
      ['a fractional size', { type: 'open', cwd: '', cols: 80.5, rows: 24 }],
      ['input before open', { type: 'input', data: '\r' }],
      ['not JSON', 'open please'],
      ['a JSON array', '[]'],
    ])('refuses %s', async (_name, message) => {
      const { server, spawner } = await start();
      const client = await ready(server.port);
      const filled = typeof message === 'object' && 'cwd' in message ? { ...message, cwd: inside } : message;
      send(client, filled);
      await expectRefused(client);
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it('refuses a binary frame', async () => {
      const { server } = await start();
      const client = await ready(server.port);
      client.ws.send(Buffer.from('\r'));
      expect(await expectRefused(client)).toMatch(/Binary/);
    });

    it('refuses unknown fields in input and resize once open, and a second open', async () => {
      const { server, spawner } = await start();
      for (const message of [
        { type: 'input', data: '\r', paste: true },
        { type: 'resize', cols: 80, rows: 24, x: 0 },
        { type: 'open', cwd: inside, cols: 80, rows: 24 },
      ]) {
        const client = await opened(server.port);
        send(client, message);
        await expectRefused(client);
        await waitFor(() => spawner.last.exited);
        expect(spawner.last.written).toEqual([]);
      }
    });

    it('forwards only Up, Down, Enter and Esc to the PTY', async () => {
      const { server, spawner } = await start();
      const client = await opened(server.port);
      const pty = spawner.last;
      pty.emit(PROMPT_SCREEN);
      const dropped = ['y', 'hello', '\u0003', '\t', '\n', '\u001b[C', '\u001b[A\u001b[A', '\u001b[Ax', 'y\r', '\u001b[200~claude\u001b[201~'];
      const kept = ['\u001b[B', '\u001b[A', '\u001bOB', '\u001bOA', '\r'];
      for (const data of [...dropped, ...kept]) send(client, { type: 'input', data });
      send(client, { type: 'resize', cols: 120, rows: 40 });
      await waitFor(() => pty.sizes.length === 1);
      expect(pty.written).toEqual(kept);
      expect(pty.sizes).toEqual([[120, 40]]);
      client.ws.close();
    });

    it('forwards keys only while a question is open: never at the prompt box after the banner', async () => {
      // A long settle, so the terminal stays open through the banner for the keys after it.
      const { server, spawner } = await start({ trust: { settleMs: 60_000 } });
      const client = await opened(server.port);
      const pty = spawner.last;
      /** Sends `keys`, then a resize, and waits for the resize, so every key before it was handled. */
      let resizes = 0;
      const keys = async (...data: string[]) => {
        for (const key of data) send(client, { type: 'input', data: key });
        send(client, { type: 'resize', cols: 100, rows: 30 });
        resizes += 1;
        await waitFor(() => pty.sizes.length === resizes);
      };
      // Nothing on the screen yet.
      await keys(UP, '\r');
      expect(pty.written).toEqual([]);
      // The trust prompt: Yes is Down, then Enter.
      pty.emit(PROMPT_SCREEN);
      await keys(DOWN, '\r');
      expect(pty.written).toEqual([DOWN, '\r']);
      // The banner and the prompt box, with no question: Up would recall a past prompt, and Enter send it.
      pty.emit(BANNER_SCREEN + IDLE_SCREEN);
      await keys(UP, '\r', '\u001b');
      expect(pty.written).toEqual([DOWN, '\r']);
      // A question after the banner takes the keys.
      pty.emit(MCP_SCREEN);
      await keys(DOWN, '\r');
      expect(pty.written).toEqual([DOWN, '\r', DOWN, '\r']);
      // Answered, and settled again: dropped again.
      pty.emit(IDLE_SCREEN);
      await keys(UP, '\r');
      expect(pty.written).toEqual([DOWN, '\r', DOWN, '\r']);
      expect(pty.killed).toEqual([]);
      client.ws.close();
    });

    it('ends claude as it refuses a message, before the page answers the close frame', async () => {
      const { server, spawner } = await start();
      const client = await opened(server.port);
      const pty = spawner.last;
      pty.stubborn = true;
      send(client, { type: 'open', cwd: inside, cols: 80, rows: 24 });
      const message = await client.next();
      expect(message).toEqual({ type: 'error', error: 'Already open.' });
      // The client hasn't answered the close frame yet, so the socket's 'close' hasn't run on the server.
      expect(pty.killed).toEqual(['SIGHUP']);
      expect((await client.closed).code).toBe(WS_CLOSE_POLICY);
      await waitFor(() => pty.exited);
      expect(pty.killed).toEqual(['SIGHUP', 'SIGKILL']);
    });

    it('sends the PTY output as binary frames', async () => {
      const { server, spawner } = await start();
      const client = await opened(server.port);
      spawner.last.emit(PROMPT_SCREEN);
      await waitFor(() => client.text().includes('Yes, I trust this folder'));
      client.ws.close();
    });
  });

  describe('how it ends', () => {
    it('settles once the banner shows: trusted, SIGHUP, then the outcome', async () => {
      const { server, spawner } = await start();
      const client = await opened(server.port);
      const pty = spawner.last;
      pty.emit(PROMPT_SCREEN);
      send(client, { type: 'input', data: DOWN });
      send(client, { type: 'input', data: '\r' });
      await waitFor(() => pty.written.length === 2);
      pty.emit(BANNER_SCREEN);
      await expectOutcome(client, 'trusted');
      expect(pty.killed).toEqual(['SIGHUP']);
    });

    it('waits SETTLE_MS, then SIGHUP, then SIGKILL after KILL_GRACE_MS', async () => {
      const { server, spawner } = await start({ trust: { settleMs: SETTLE_MS, killGraceMs: KILL_GRACE_MS } });
      const client = await opened(server.port);
      const pty = spawner.last;
      pty.stubborn = true;
      pty.emit(PROMPT_SCREEN);
      send(client, { type: 'input', data: DOWN });
      send(client, { type: 'input', data: '\r' });
      await waitFor(() => pty.written.length === 2);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      pty.emit(BANNER_SCREEN);
      vi.advanceTimersByTime(SETTLE_MS - 1);
      expect(pty.killed).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(pty.killed).toEqual(['SIGHUP']);
      vi.advanceTimersByTime(KILL_GRACE_MS - 1);
      expect(pty.killed).toEqual(['SIGHUP']);
      vi.advanceTimersByTime(1);
      expect(pty.killed).toEqual(['SIGHUP', 'SIGKILL']);
      vi.useRealTimers();
      await expectOutcome(client, 'trusted');
    });

    it('stops sending output once it has decided', async () => {
      const { server, spawner } = await start();
      const client = await opened(server.port);
      const pty = spawner.last;
      pty.stubborn = true;
      pty.emit(BANNER_SCREEN);
      await waitFor(() => pty.killed.length === 1);
      pty.emit('after the decision');
      await waitFor(() => pty.killed.length === 2);
      await expectOutcome(client, 'trusted');
      expect(client.text()).not.toContain('after the decision');
    });

    it('keeps the terminal open for a question after the banner, until it is answered', async () => {
      const { server, spawner } = await start();
      const client = await opened(server.port);
      const pty = spawner.last;
      pty.emit(PROMPT_SCREEN);
      send(client, { type: 'input', data: DOWN });
      send(client, { type: 'input', data: '\r' });
      await waitFor(() => pty.written.length === 2);
      pty.emit(BANNER_SCREEN + MCP_SCREEN);
      await delay(100);
      expect(pty.killed).toEqual([]);
      send(client, { type: 'input', data: DOWN });
      await waitFor(() => pty.written.length === 3);
      await delay(60);
      expect(pty.killed).toEqual([]);
      send(client, { type: 'input', data: '\r' });
      await expectOutcome(client, 'trusted');
      expect(pty.written).toEqual([DOWN, '\r', DOWN, '\r']);
    });

    it('keeps the terminal open for a question before the banner, as spike 020 saw the MCP question', async () => {
      const { server, spawner } = await start();
      const client = await opened(server.port);
      const pty = spawner.last;
      pty.emit(PROMPT_SCREEN);
      send(client, { type: 'input', data: DOWN });
      send(client, { type: 'input', data: '\r' });
      await waitFor(() => pty.written.length === 2);
      pty.emit(MCP_SCREEN);
      await delay(100);
      expect(pty.killed).toEqual([]);
      send(client, { type: 'input', data: DOWN });
      send(client, { type: 'input', data: '\r' });
      await waitFor(() => pty.written.length === 4);
      await delay(60);
      expect(pty.killed).toEqual([]);
      pty.emit(BANNER_SCREEN);
      await expectOutcome(client, 'trusted');
      expect(pty.written).toEqual([DOWN, '\r', DOWN, '\r']);
    });

    it('disarms the settle timer when a question shows within SETTLE_MS of the banner', async () => {
      const { server, spawner } = await start({ trust: { settleMs: 80 } });
      const client = await opened(server.port);
      const pty = spawner.last;
      pty.emit(BANNER_SCREEN);
      await delay(20);
      pty.emit(MCP_SCREEN);
      await delay(150);
      expect(pty.killed).toEqual([]);
      client.ws.close();
    });

    it('gives declined when claude exits by itself after No or Esc', async () => {
      const { server, spawner } = await start();
      const client = await opened(server.port);
      const pty = spawner.last;
      pty.emit(PROMPT_SCREEN);
      send(client, { type: 'input', data: '\u001b' });
      await waitFor(() => pty.written.length === 1);
      pty.emit(DECLINED_SCREEN);
      pty.exit(1);
      await expectOutcome(client, 'declined');
      expect(pty.killed).toEqual([]);
    });

    it('gives unclear when claude exits before its prompt showed', async () => {
      const { server, spawner } = await start();
      const client = await opened(server.port);
      spawner.last.emit('Error: something went wrong\r\n');
      spawner.last.exit(1);
      await expectOutcome(client, 'unclear');
    });

    it('gives unclear at the time limit, and ends claude', async () => {
      const { server, spawner } = await start({ trust: { timeLimitMs: 80 } });
      const client = await opened(server.port);
      spawner.last.emit(PROMPT_SCREEN);
      await expectOutcome(client, 'unclear');
      expect(spawner.last.killed).toEqual(['SIGHUP']);
    });

    it('closes 1013 when no open comes within OPEN_TIMEOUT_MS of ready, and gives the slot back', async () => {
      const { server, spawner } = await start();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const client = await ready(server.port);
      vi.advanceTimersByTime(OPEN_TIMEOUT_MS - 1);
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(client.messages).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(await expectRefused(client, WS_CLOSE_TRY_AGAIN)).toBe(TRUST_OPEN_LATE);
      vi.useRealTimers();
      expect(spawner.spawn).not.toHaveBeenCalled();
      const next = await opened(server.port);
      next.ws.close();
    });

    it('closes 1013 when the folder check hangs past OPEN_TIMEOUT_MS', async () => {
      const { server, spawner } = await start();
      let checking!: () => void;
      const checked = new Promise<void>((resolve) => (checking = resolve));
      vi.mocked(checkDirectory).mockImplementationOnce(() => {
        checking();
        return new Promise(() => {});
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const client = await ready(server.port);
      send(client, { type: 'open', cwd: inside, cols: 80, rows: 24 });
      await checked;
      vi.advanceTimersByTime(OPEN_TIMEOUT_MS);
      expect(await expectRefused(client, WS_CLOSE_TRY_AGAIN)).toBe(TRUST_OPEN_LATE);
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it('counts the time limit from open, so it bounds a folder check that hangs too', async () => {
      const { server, spawner } = await start({ trust: { timeLimitMs: 1000, openTimeoutMs: 60_000 } });
      let checking!: () => void;
      const checked = new Promise<void>((resolve) => (checking = resolve));
      vi.mocked(checkDirectory).mockImplementationOnce(() => {
        checking();
        return new Promise(() => {});
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const client = await ready(server.port);
      send(client, { type: 'open', cwd: inside, cols: 80, rows: 24 });
      await checked;
      vi.advanceTimersByTime(999);
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(client.messages).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(await expectRefused(client, WS_CLOSE_TRY_AGAIN)).toBe(TRUST_OPEN_LATE);
      expect(spawner.spawn).not.toHaveBeenCalled();
    });

    it('ends claude when the socket closes', async () => {
      const { server, spawner } = await start();
      const client = await opened(server.port);
      const pty = spawner.last;
      pty.stubborn = true;
      client.ws.close();
      await waitFor(() => pty.killed.length === 1);
      expect(pty.killed).toEqual(['SIGHUP']);
      await waitFor(() => pty.exited);
      expect(pty.killed).toEqual(['SIGHUP', 'SIGKILL']);
    });

    it('ends claude, and closes the socket with 1001, on close()', async () => {
      const { server, spawner } = await start();
      const client = await opened(server.port);
      const pty = spawner.last;
      await server.close();
      expect(pty.killed).toEqual(['SIGHUP']);
      expect(pty.exited).toBe(true);
      expect((await client.closed).code).toBe(1001);
    });
  });

  it("hides the PTY's pid while it runs and for HIDE_AFTER_EXIT_MS after", async () => {
    const trustPids = new OwnPids();
    const { server, spawner } = await start({ trustPids });
    const client = await opened(server.port);
    const pty = spawner.last;
    expect(trustPids.isOwn({ pid: pty.pid })).toBe(true);
    // The release's timer, under a fake clock; the socket's own I/O needs no timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    pty.exit(1);
    await expectOutcome(client, 'unclear');
    expect(trustPids.isOwn({ pid: pty.pid })).toBe(true);
    vi.advanceTimersByTime(HIDE_AFTER_EXIT_MS - 1);
    expect(trustPids.has(pty.pid)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(trustPids.has(pty.pid)).toBe(false);
  });
});
