// Open in an editor (W72): detection against a fake file system, then both routes through the real
// HTTP server and its /api/* checks, with the editors found given and a fake runFile, so no test
// depends on this machine's editors or opens one. src/test/noClaude.ts refuses a real one anyway.
// Made-up sessions only.
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { RunError, type RunFile, type RunOptions } from '../index/exec.js';
import type { Indexer } from '../index/index.js';
import { EDITORS_PATH, openInEditorPath, removePath, stopPath, WS_PATH, type IndexSnapshot, type ServerMessage, type SessionSummary } from '../shared/protocol.js';
import { pitwallOrigin, proofFor } from '../test/proof.js';
import { takeRefusals } from '../test/noClaude.js';
import type { CommandOptions, CommandResult } from './command.js';
import { DEFAULT_OPEN_RATE, detectEditors, EDITOR_TIMEOUT_MS, KNOWN_EDITORS, MAC_OPEN, parseOpenRequest, type DetectionFs, type EditorOptions, type FoundEditor } from './editors.js';
import type { RunningServer } from './index.js';
import { startServerWithInternals, type ServerInternals } from './server.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';

// ---------------------------------------------------------------- detection

type Entry = 'dir' | 'file' | 'exe' | 'symlink-to-dir' | 'hang';

/** A file system of `entries` by absolute path; anything else doesn't exist. */
function fakeFs(entries: Record<string, Entry>): DetectionFs & { seen: string[] } {
  const seen: string[] = [];
  const missing = (file: string) => Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  const entry = async (file: string) => {
    seen.push(file);
    const kind = entries[file];
    if (kind === 'hang') return new Promise<never>(() => {});
    if (kind === undefined) throw missing(file);
    return kind;
  };
  return {
    seen,
    async lstat(file) {
      const kind = await entry(file);
      return { isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'symlink-to-dir' };
    },
    async stat(file) {
      const kind = await entry(file);
      return { isFile: () => kind === 'file' || kind === 'exe' };
    },
    async access(file) {
      if ((await entry(file)) !== 'exe') throw Object.assign(new Error(`EACCES: ${file}`), { code: 'EACCES' });
    },
  };
}

const VSCODE_APP = '/Applications/Visual Studio Code.app';
const CURSOR_APP = '/Applications/Cursor.app';
const HOME = '/Users/pitwall-test';

describe('detection, on macOS', () => {
  it('finds each app bundle in /Applications, opened with /usr/bin/open -a', async () => {
    const found = await detectEditors({ platform: 'darwin', home: HOME, fs: fakeFs({ [VSCODE_APP]: 'dir', [CURSOR_APP]: 'dir' }) });
    expect(found).toEqual([
      { id: 'vscode', label: 'VS Code', file: MAC_OPEN, args: ['-a', VSCODE_APP] },
      { id: 'cursor', label: 'Cursor', file: '/usr/bin/open', args: ['-a', CURSOR_APP] },
    ]);
  });

  it('looks in ~/Applications after /Applications', async () => {
    const mine = `${HOME}/Applications/Cursor.app`;
    const fs = fakeFs({ [mine]: 'dir' });
    expect(await detectEditors({ platform: 'darwin', home: HOME, fs })).toEqual([{ id: 'cursor', label: 'Cursor', file: MAC_OPEN, args: ['-a', mine] }]);
    expect(fs.seen).toEqual([VSCODE_APP, `${HOME}/Applications/Visual Studio Code.app`, CURSOR_APP, mine]);
  });

  it("never takes a symlink, even to a directory, or a bundle that isn't a directory, and goes on to the next place", async () => {
    const mine = `${HOME}/Applications/Visual Studio Code.app`;
    const fs = fakeFs({ [VSCODE_APP]: 'symlink-to-dir', [mine]: 'dir', [CURSOR_APP]: 'file' });
    expect(await detectEditors({ platform: 'darwin', home: HOME, fs })).toEqual([{ id: 'vscode', label: 'VS Code', file: MAC_OPEN, args: ['-a', mine] }]);
  });

  it("finds none where neither is installed, and skips ~/Applications for a home that isn't absolute", async () => {
    const fs = fakeFs({});
    expect(await detectEditors({ platform: 'darwin', home: 'relative', fs })).toEqual([]);
    expect(fs.seen).toEqual([VSCODE_APP, CURSOR_APP]);
  });

  it("doesn't look on PATH on macOS", async () => {
    const fs = fakeFs({ '/usr/local/bin/code': 'exe' });
    expect(await detectEditors({ platform: 'darwin', home: HOME, path: '/usr/local/bin', fs })).toEqual([]);
  });
});

describe('detection, elsewhere', () => {
  it('finds each command on PATH, in its order, as an absolute path, run with the directory alone', async () => {
    const fs = fakeFs({ '/usr/bin/code': 'exe', '/opt/bin/code': 'exe', '/home/pitwall-test/.local/bin/cursor': 'exe' });
    const found = await detectEditors({ platform: 'linux', path: '/opt/bin:/usr/bin:/home/pitwall-test/.local/bin', fs });
    expect(found).toEqual([
      { id: 'vscode', label: 'VS Code', file: '/opt/bin/code', args: [] },
      { id: 'cursor', label: 'Cursor', file: '/home/pitwall-test/.local/bin/cursor', args: [] },
    ]);
  });

  it("skips PATH entries that aren't absolute, and files that aren't regular and executable", async () => {
    const fs = fakeFs({ 'bin/code': 'exe', './code': 'exe', '/a/code': 'dir', '/b/code': 'file', '/c/code': 'exe', '/a/cursor': 'file' });
    const found = await detectEditors({ platform: 'linux', path: ':bin:.:/a:/b:/c', fs });
    expect(found).toEqual([{ id: 'vscode', label: 'VS Code', file: '/c/code', args: [] }]);
    expect(fs.seen.every((file) => file.startsWith('/'))).toBe(true);
  });

  it('finds none with no PATH, and none on Windows, where the commands are .cmd scripts that need a shell', async () => {
    expect(await detectEditors({ platform: 'linux', path: undefined, fs: fakeFs({}) })).toEqual([]);
    expect(await detectEditors({ platform: 'linux', path: '', fs: fakeFs({}) })).toEqual([]);
    const fs = fakeFs({ 'C:\\code': 'exe' });
    expect(await detectEditors({ platform: 'win32', path: 'C:\\', fs })).toEqual([]);
    expect(fs.seen).toEqual([]);
  });

  it('gives up after its time limit with what it found, as on a PATH entry that hangs', async () => {
    const fs = fakeFs({ '/usr/bin/code': 'exe', '/mnt/hung/cursor': 'hang' });
    const started = Date.now();
    const found = await detectEditors({ platform: 'linux', path: '/usr/bin:/mnt/hung', fs, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(found.map((editor) => editor.id)).toEqual(['vscode']);
  });
});

describe('parseOpenRequest', () => {
  it('takes { editor } with a known id and nothing else', () => {
    for (const { id } of KNOWN_EDITORS) expect(parseOpenRequest({ editor: id })).toEqual({ ok: true, editor: id });
    for (const body of [null, [], 'cursor', 1, {}, { editor: 'vim' }, { editor: 1 }, { editor: 'cursor', cwd: '/' }, { Editor: 'cursor' }]) {
      expect(parseOpenRequest(body).ok, JSON.stringify(body)).toBe(false);
    }
    expect(parseOpenRequest(JSON.parse('{"__proto__": {}, "editor": "cursor"}')).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- the routes: fixtures

let tmp: string;
let root: string;
let repo: string;
/** A directory whose name starts with `-`: absolute, so it's never read as an option. */
let dashed: string;
/** Directories under the root whose names have a bidi override and a C1 control (W81). */
let bidiDir: string;
let c1Dir: string;
let webRoot: string;

beforeAll(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-test-editors-')));
  root = join(tmp, 'root');
  repo = join(root, 'repo');
  dashed = join(root, '-n');
  bidiDir = join(root, 'safe\u202eexe.txt');
  c1Dir = join(root, 'csi\u009b2J');
  webRoot = join(tmp, 'web');
  const outside = join(tmp, 'outside');
  for (const dir of [repo, dashed, bidiDir, c1Dir, webRoot, outside]) await mkdir(dir, { recursive: true });
  await symlink(outside, join(root, 'escape'));
  await symlink(repo, join(root, 'alias'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const BG_ID = '11111111-1111-4111-8111-111111111111';
const INTERACTIVE_ID = '22222222-2222-4222-8222-222222222222';
const ENDED_ID = '33333333-3333-4333-8333-333333333333';
const MISSING_ID = '44444444-4444-4444-8444-444444444444';
const GONE_ID = '55555555-5555-4555-8555-555555555555';
const ESCAPE_ID = '66666666-6666-4666-8666-666666666666';
const DASHED_ID = '77777777-7777-4777-8777-777777777777';
const RELATIVE_ID = '88888888-8888-4888-8888-888888888888';
const ALIAS_ID = '99999999-9999-4999-8999-aaaaaaaaaaaa';
const BIDI_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const C1_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function session(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId,
    name: `pitwall-test-${sessionId.slice(0, 8)}`,
    kind: 'background',
    shortId: sessionId.slice(0, 8),
    cwd: repo,
    alive: true,
    startedAt: '2026-10-27T00:00:00.000Z',
    stale: false,
    finished: false,
    transcript: 'missing',
    ...overrides,
  };
}

function snapshot(): IndexSnapshot {
  return {
    generatedAt: '2026-10-27T00:00:00.000Z',
    roots: [root],
    groups: [
      {
        key: repo,
        label: 'repo',
        kind: 'git',
        root,
        sessions: [
          session(BG_ID),
          session(INTERACTIVE_ID, { kind: 'interactive', shortId: undefined, pid: 4242 }),
          session(ENDED_ID, { kind: 'interactive', shortId: undefined, alive: false, finished: true, ended: true }),
          session(MISSING_ID, { cwd: join(repo, 'removed-worktree'), cwdMissing: true }),
          // Gone since the poll, so the snapshot doesn't say so yet.
          session(GONE_ID, { cwd: join(repo, 'gone-since') }),
          session(ESCAPE_ID, { cwd: join(root, 'escape') }),
          session(DASHED_ID, { cwd: dashed }),
          // Never one the index lists: a cwd an editor could read as an option.
          session(RELATIVE_ID, { cwd: '--new-window' }),
          // A symlink under the root to a directory under it.
          session(ALIAS_ID, { cwd: join(root, 'alias') }),
          // Directories under the root with a bidi override and a C1 control in their names (W81).
          session(BIDI_ID, { cwd: bidiDir }),
          session(C1_ID, { cwd: c1Dir }),
        ],
      },
    ],
    source: { ok: true },
  };
}

function fakeIndexer(latest: IndexSnapshot | null = snapshot()): Indexer {
  return {
    latest: () => latest ?? undefined,
    subscribe: () => () => {},
    conversation: async () => undefined,
    subagents: async () => undefined,
    subagentConversation: async () => undefined,
    pollSoon: vi.fn(),
    noteRestart: vi.fn(),
    turnState: async () => 'unknown',
    runningSubagents: async () => undefined,
    stop: () => {},
  };
}

const MAC_EDITORS: FoundEditor[] = [
  { id: 'vscode', label: 'VS Code', file: MAC_OPEN, args: ['-a', VSCODE_APP] },
  { id: 'cursor', label: 'Cursor', file: MAC_OPEN, args: ['-a', CURSOR_APP] },
];

interface RunCall {
  file: string;
  args: readonly string[];
  options: RunOptions;
}

/** A runFile that records each call, then resolves, or does what `answer` says. */
function fakeRunFile(answer: (call: RunCall) => Promise<string> = async () => ''): RunFile & { calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run: RunFile = (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    return answer(call);
  };
  return Object.assign(run, { calls });
}

// ---------------------------------------------------------------- the routes: clients

const running: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

interface Started {
  server: RunningServer;
  apiKey: string;
  runFile: ReturnType<typeof fakeRunFile>;
}

async function start(
  {
    runFile = fakeRunFile(),
    found = MAC_EDITORS,
    indexer = fakeIndexer(),
    internals = {},
    editors = {},
  }: { runFile?: ReturnType<typeof fakeRunFile>; found?: FoundEditor[]; indexer?: Indexer; internals?: ServerInternals; editors?: Pick<EditorOptions, 'openRate' | 'now'> } = {},
): Promise<Started> {
  const server = await startServerWithInternals(
    { indexer, token: TOKEN, webRoot, port: 0 },
    {
      editors: { found, runFile, env: { HOME: '/Users/pitwall-test', PITWALL_TOKEN: TOKEN, PITWALL_LAUNCH: 'x', KEEP_ME: 'yes', LEAKED: `a${TOKEN}b`, npm_config_x: 'y' }, ...editors },
      ...internals,
    },
  );
  running.push(server);
  return { server, apiKey: await apiKeyOf(server.port), runFile };
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  json: unknown;
}

function request(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const origin = (port: number) => `http://127.0.0.1:${port}`;

/** POSTs as the web UI does: the apiKey, this server's Origin, and `body` as JSON. */
function open(started: Started, sessionId: string, body: unknown = { editor: 'cursor' }, headers: Record<string, string> = {}): Promise<HttpResult> {
  return request(
    started.server.port,
    'POST',
    openInEditorPath(sessionId),
    { authorization: `Bearer ${started.apiKey}`, origin: origin(started.server.port), 'content-type': 'application/json', ...headers },
    typeof body === 'string' ? body : JSON.stringify(body),
  );
}

const errorOf = (res: HttpResult) => (res.json as { error?: string } | undefined)?.error;

async function apiKeyOf(port: number): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { origin: origin(port) });
  const messages: ServerMessage[] = [];
  const waiters: ((message: ServerMessage) => void)[] = [];
  ws.on('message', (data) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  const next = () => {
    const queued = messages.shift();
    return queued ? Promise.resolve(queued) : new Promise<ServerMessage>((resolve) => waiters.push(resolve));
  };
  const challenge = await next();
  if (challenge.type !== 'challenge') throw new Error(`expected a challenge, got ${challenge.type}`);
  ws.send(JSON.stringify({ type: 'auth', proof: proofFor(TOKEN, challenge.nonce, pitwallOrigin(port)) }));
  const reply = await next();
  ws.close();
  if (reply.type !== 'authenticated') throw new Error(`expected authenticated, got ${reply.type}`);
  return reply.apiKey;
}

// ---------------------------------------------------------------- GET EDITORS_PATH

describe('GET EDITORS_PATH', () => {
  it('lists the editors found, by id and label alone, with no-store', async () => {
    const started = await start();
    const res = await request(started.server.port, 'GET', EDITORS_PATH, { authorization: `Bearer ${started.apiKey}` });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ editors: [{ id: 'vscode', label: 'VS Code' }, { id: 'cursor', label: 'Cursor' }] });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers an empty list when none was found, and takes the token too, as every GET does', async () => {
    const started = await start({ found: [] });
    const res = await request(started.server.port, 'GET', EDITORS_PATH, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ editors: [] });
  });

  it('answers what detection found, when the server is given what to look at', async () => {
    const indexer = fakeIndexer();
    const server = await startServerWithInternals(
      { indexer, token: TOKEN, webRoot, port: 0 },
      { editors: { detection: { platform: 'darwin', home: HOME, fs: fakeFs({ [CURSOR_APP]: 'dir' }) }, runFile: fakeRunFile() } },
    );
    running.push(server);
    const res = await request(server.port, 'GET', EDITORS_PATH, { authorization: `Bearer ${TOKEN}` });
    expect(res.json).toEqual({ editors: [{ id: 'cursor', label: 'Cursor' }] });
  });

  it('refuses no credential with 401, and another Origin or Host with 403', async () => {
    const started = await start();
    const { port } = started.server;
    expect((await request(port, 'GET', EDITORS_PATH, {})).status).toBe(401);
    expect((await request(port, 'GET', EDITORS_PATH, { authorization: 'Bearer wrong' })).status).toBe(401);
    for (const value of ['http://evil.example', `http://localhost:${port}`, 'null']) {
      expect((await request(port, 'GET', EDITORS_PATH, { authorization: `Bearer ${started.apiKey}`, origin: value })).status, value).toBe(403);
    }
    for (const host of ['evil.example', `localhost:${port}`]) {
      expect((await request(port, 'GET', EDITORS_PATH, { authorization: `Bearer ${started.apiKey}`, host })).status, host).toBe(403);
    }
  });
});

// ---------------------------------------------------------------- POST openInEditorPath

describe('POST openInEditorPath: credentials', () => {
  it('refuses the raw token, the apiKey without this Origin or with another, and no credential, opening nothing', async () => {
    const started = await start();
    const { port } = started.server;
    const body = JSON.stringify({ editor: 'cursor' });
    const post = (headers: Record<string, string>) => request(port, 'POST', openInEditorPath(BG_ID), { 'content-type': 'application/json', ...headers }, body);
    expect((await post({ authorization: `Bearer ${TOKEN}`, origin: origin(port) })).status).toBe(403);
    expect((await post({ authorization: `Bearer ${started.apiKey}` })).status).toBe(403);
    for (const value of ['http://evil.example', `http://localhost:${port}`, `https://127.0.0.1:${port}`]) {
      expect((await post({ authorization: `Bearer ${started.apiKey}`, origin: value })).status, value).toBe(403);
    }
    expect((await post({ origin: origin(port) })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${started.apiKey}`, origin: origin(port), host: `localhost:${port}` })).status).toBe(403);
    expect(started.runFile.calls).toEqual([]);
  });

  it('is a POST only', async () => {
    const started = await start();
    const res = await request(started.server.port, 'GET', openInEditorPath(BG_ID), { authorization: `Bearer ${started.apiKey}` });
    expect(res.status).toBe(404);
    expect(started.runFile.calls).toEqual([]);
  });
});

describe('POST openInEditorPath: opening', () => {
  it("opens the session's own directory with /usr/bin/open -a and the bundle, each a separate argument, in the temp directory", async () => {
    const started = await start();
    const res = await open(started, BG_ID, { editor: 'cursor' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(started.runFile.calls).toHaveLength(1);
    const [call] = started.runFile.calls;
    expect(call?.file).toBe('/usr/bin/open');
    expect(call?.args).toEqual(['-a', '/Applications/Cursor.app', repo]);
    expect(call?.options.cwd).toBe(tmpdir());
    expect(call?.options.timeoutMs).toBe(EDITOR_TIMEOUT_MS);
    expect(EDITOR_TIMEOUT_MS).toBe(10_000);
  });

  it('runs a command found on PATH with the directory alone', async () => {
    const started = await start({ found: [{ id: 'vscode', label: 'VS Code', file: '/usr/bin/code', args: [] }] });
    expect((await open(started, BG_ID, { editor: 'vscode' })).status).toBe(200);
    expect(started.runFile.calls.map(({ file, args }) => [file, args])).toEqual([['/usr/bin/code', [repo]]]);
  });

  it("starts the editor in a scrubbed environment: no PITWALL_ or npm_ variables, nothing holding the token", async () => {
    const started = await start();
    await open(started, BG_ID);
    const env = started.runFile.calls[0]?.options.env ?? {};
    expect(env).toEqual({ HOME: '/Users/pitwall-test', KEEP_ME: 'yes' });
  });

  it('opens any listed session whose directory is there: interactive, background and ended', async () => {
    const started = await start();
    for (const id of [BG_ID, INTERACTIVE_ID, ENDED_ID]) expect((await open(started, id)).status, id).toBe(200);
    expect(started.runFile.calls).toHaveLength(3);
  });

  it('opens the realpath it checked, not the path the snapshot has, so a symlink swapped in later goes nowhere else', async () => {
    const started = await start();
    expect((await open(started, ALIAS_ID)).status).toBe(200);
    expect(started.runFile.calls[0]?.args).toEqual(['-a', CURSOR_APP, repo]);
  });

  it('passes a directory whose name starts with - as an absolute path, so it is never an option', async () => {
    const started = await start();
    expect((await open(started, DASHED_ID)).status).toBe(200);
    const args = started.runFile.calls[0]?.args ?? [];
    expect(args).toEqual(['-a', CURSOR_APP, dashed]);
    expect(args[args.length - 1]?.startsWith('/')).toBe(true);
  });
});

describe('POST openInEditorPath: refusals', () => {
  it('400 for anything but { editor } with a known id, as application/json', async () => {
    const started = await start();
    const cases: Array<[unknown, Record<string, string>?]> = [
      [{ editor: 'cursor' }, { 'content-type': 'text/plain' }],
      [{ editor: 'cursor' }, { 'content-type': 'application/x-www-form-urlencoded' }],
      ['{"editor":'],
      ['null'],
      [[{ editor: 'cursor' }]],
      [{}],
      [{ editor: 'vim' }],
      [{ editor: 'cursor', cwd: '/etc' }],
      [{ editor: 'cursor', sessionId: BG_ID }],
      [{ editor: 'x'.repeat(2000) }],
    ];
    for (const [body, headers] of cases) {
      const res = await open(started, BG_ID, body, headers);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect((res.json as { ok?: boolean }).ok).toBe(false);
    }
    expect(errorOf(await open(started, BG_ID, { editor: 'cursor' }, { 'content-type': 'text/plain' }))).toBe('Send the request as application/json.');
    expect(started.runFile.calls).toEqual([]);
  });

  it("400 for an editor that wasn't found at startup", async () => {
    const started = await start({ found: [MAC_EDITORS[0]!] });
    const res = await open(started, BG_ID, { editor: 'cursor' });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe("Cursor wasn't found on this machine when pitwall started.");
    expect(started.runFile.calls).toEqual([]);
  });

  it("400 for an id that isn't safe, 404 for one that isn't listed, and 503 before the first snapshot", async () => {
    const started = await start();
    expect((await open(started, '../../etc')).status).toBe(400);
    expect((await open(started, 'not-a-session id')).status).toBe(400);
    const unlisted = await open(started, '99999999-9999-4999-8999-999999999999');
    expect(unlisted.status).toBe(404);
    expect(errorOf(unlisted)).toBe("That session isn't in pitwall's list.");
    const early = await start({ indexer: fakeIndexer(null) });
    expect((await open(early, BG_ID)).status).toBe(503);
    expect([...started.runFile.calls, ...early.runFile.calls]).toEqual([]);
  });

  it('409 when the snapshot says its directory has gone', async () => {
    const started = await start();
    const res = await open(started, MISSING_ID);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe(`Its directory, ${join(repo, 'removed-worktree')}, no longer exists.`);
    expect(started.runFile.calls).toEqual([]);
  });

  it("409 when it has gone since the poll, now points outside the roots, or isn't absolute", async () => {
    const started = await start();
    const gone = await open(started, GONE_ID);
    expect(gone.status).toBe(409);
    expect(errorOf(gone)).toBe(`${join(repo, 'gone-since')} doesn't exist.`);
    const escape = await open(started, ESCAPE_ID);
    expect(escape.status).toBe(409);
    expect(errorOf(escape)).toMatch(/isn't under the root/);
    const relative = await open(started, RELATIVE_ID);
    expect(relative.status).toBe(409);
    expect(errorOf(relative)).toBe('The directory must be an absolute path.');
    expect(started.runFile.calls).toEqual([]);
  });

  it('409 for a directory with a bidi override or a C1 control, as spawn and resume refuse it, opening nothing (W81)', async () => {
    const started = await start();
    for (const id of [BIDI_ID, C1_ID]) {
      const res = await open(started, id);
      expect(res.status, id).toBe(409);
      expect(errorOf(res)).toBe('The directory path contains control characters or bidi controls.');
    }
    expect(started.runFile.calls).toEqual([]);
  });

  it("502 when the editor doesn't start or exits non-zero: a short line, never its output", async () => {
    const moved = "Cursor didn't open. If it has moved, restart pitwall so it looks again.";
    const failures: Array<[unknown, string]> = [
      // As `open -a` exits when the bundle found at startup has moved, and a command that has gone isn't found.
      [new RunError('exit', 'exited with code 1', 1), moved],
      [new RunError('not-found', '/usr/bin/open was not found'), moved],
      [new RunError('signal', 'was killed by SIGKILL'), "Cursor didn't open: /usr/bin/open was stopped by a signal."],
      [new RunError('spawn', 'spawn EACCES: some detail from the OS'), "Cursor didn't open: /usr/bin/open couldn't be started."],
      [new Error('LSOpenURLsWithRole() failed with error -10810 for the file /secret.'), "Cursor didn't open: /usr/bin/open couldn't be started."],
    ];
    for (const [error, message] of failures) {
      const started = await start({ runFile: fakeRunFile(async () => Promise.reject(error)) });
      const res = await open(started, BG_ID);
      expect(res.status).toBe(502);
      expect(errorOf(res)).toBe(message);
    }
  });

  it("504 when it doesn't return within 10 seconds", async () => {
    const started = await start({ runFile: fakeRunFile(async () => Promise.reject(new RunError('timeout', 'timed out after 10s'))) });
    const res = await open(started, BG_ID);
    expect(res.status).toBe(504);
    expect(errorOf(res)).toBe("Cursor didn't answer within 10 seconds. It may still open.");
  });
});

describe('POST openInEditorPath: the limit it shares with stop, remove and resume', () => {
  /** A command runner for stop and remove that holds each until released. */
  function heldCommands() {
    const waiting: (() => void)[] = [];
    const run = vi.fn(async (_file: string, _args: readonly string[], _options: CommandOptions): Promise<CommandResult> => {
      await new Promise<void>((resolve) => waiting.push(resolve));
      return { kind: 'exited', code: 0, stdout: '', stderr: '' };
    });
    return { run, waiting };
  }

  it('answers 429 with Retry-After while 4 stop and remove commands run, and opens once one is done', async () => {
    const held = heldCommands();
    const started = await start({ internals: { actions: { run: held.run, env: {} } } });
    const post = (path: string) =>
      request(started.server.port, 'POST', path, { authorization: `Bearer ${started.apiKey}`, origin: origin(started.server.port), 'content-type': 'application/json' }, '{}');
    const slow = [stopPath(BG_ID), removePath(BG_ID), stopPath(BG_ID), removePath(BG_ID)].map(post);
    await vi.waitFor(() => expect(held.waiting).toHaveLength(4));

    const refused = await open(started, BG_ID);
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBe('1');
    expect(errorOf(refused)).toBe('pitwall is already running 4 stop, remove, resume or open commands. Try again in a moment.');
    expect(started.runFile.calls).toEqual([]);

    held.waiting.shift()?.();
    await vi.waitFor(async () => expect((await open(started, BG_ID)).status).toBe(200));
    for (const finish of held.waiting.splice(0)) finish();
    for (const res of await Promise.all(slow)) expect(res.status).toBe(200);
    expect(started.runFile.calls).toHaveLength(1);
  });

  it('takes a slot while it opens, so stop gets 429 while 4 opens are out', async () => {
    const releases: (() => void)[] = [];
    const runFile = fakeRunFile(() => new Promise<string>((resolve) => releases.push(() => resolve(''))));
    const held = heldCommands();
    const started = await start({ runFile, internals: { actions: { run: held.run, env: {} } } });
    const opens = [BG_ID, INTERACTIVE_ID, ENDED_ID, DASHED_ID].map((id) => open(started, id));
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    const stop = await request(
      started.server.port,
      'POST',
      stopPath(BG_ID),
      { authorization: `Bearer ${started.apiKey}`, origin: origin(started.server.port), 'content-type': 'application/json' },
      '{}',
    );
    expect(stop.status).toBe(429);
    expect(held.run).not.toHaveBeenCalled();
    expect((await open(started, BG_ID)).status).toBe(429);
    for (const release of releases.splice(0)) release();
    for (const res of await Promise.all(opens)) expect(res.status).toBe(200);
  });

  it('gives its slot back when it fails', async () => {
    const started = await start({ runFile: fakeRunFile(async () => Promise.reject(new RunError('exit', 'exited with code 1', 1))), internals: { actions: { maxConcurrentCommands: 1 } } });
    for (let i = 0; i < 3; i += 1) expect((await open(started, BG_ID)).status).toBe(502);
    expect((await open(started, MISSING_ID)).status).toBe(409);
    expect((await open(started, GONE_ID)).status).toBe(409);
    expect((await open(started, BG_ID)).status).toBe(502);
  });
});

describe('POST openInEditorPath: opens a minute (W87)', () => {
  it(`is ${DEFAULT_OPEN_RATE.max} a minute by default: the next answers 429 with Retry-After, and opens nothing`, async () => {
    let now = 1_000_000;
    const started = await start({ editors: { now: () => now } });
    // Any session, either editor: one limit for all of them.
    for (let i = 0; i < DEFAULT_OPEN_RATE.max; i += 1) {
      const res = await open(started, i % 2 === 0 ? BG_ID : ENDED_ID, { editor: i % 3 === 0 ? 'vscode' : 'cursor' });
      expect(res.status, `open ${i + 1}`).toBe(200);
      now += 1000;
    }
    const refused = await open(started, INTERACTIVE_ID);
    expect(refused.status).toBe(429);
    // The first was 10 s ago, so a place frees in 50 s.
    expect(refused.headers['retry-after']).toBe('50');
    expect(refused.headers['cache-control']).toBe('no-store');
    expect(refused.json).toEqual({ ok: false, error: `pitwall opens at most ${DEFAULT_OPEN_RATE.max} directories in an editor every 60 seconds. Try again in 50s.` });
    expect(started.runFile.calls).toHaveLength(DEFAULT_OPEN_RATE.max);
  });

  it('opens again once the oldest open is a window old, and says at least 1 second until then', async () => {
    let now = 0;
    const started = await start({ editors: { openRate: { max: 2, windowMs: 60_000 }, now: () => now } });
    expect((await open(started, BG_ID)).status).toBe(200);
    expect((await open(started, BG_ID)).status).toBe(200);
    now = 59_999;
    const last = await open(started, BG_ID);
    expect([last.status, last.headers['retry-after']]).toEqual([429, '1']);
    now = 60_000;
    expect((await open(started, BG_ID)).status).toBe(200);
    expect(started.runFile.calls).toHaveLength(3);
  });

  it("doesn't count an open refused before it runs, and counts one whose editor failed, which did run", async () => {
    const runFile = fakeRunFile(async () => Promise.reject(new RunError('exit', 'exited with code 1', 1)));
    const started = await start({ runFile, editors: { openRate: { max: 2, windowMs: 60_000 }, now: () => 0 } });
    expect((await open(started, MISSING_ID)).status).toBe(409);
    expect((await open(started, GONE_ID)).status).toBe(409);
    expect((await open(started, BG_ID, { editor: 'zed' })).status).toBe(400);
    expect((await open(started, 'nope')).status).toBe(404);
    expect((await open(started, BG_ID)).status).toBe(502);
    expect((await open(started, BG_ID)).status).toBe(502);
    expect((await open(started, BG_ID)).status).toBe(429);
    expect(runFile.calls).toHaveLength(2);
  });

  it("doesn't count toward spawn and resume's limit of sessions started a minute, or consult it", async () => {
    const started = await start({ internals: { actions: { spawnRate: { max: 1, windowMs: 60_000 }, now: () => 0 } }, editors: { now: () => 0 } });
    for (let i = 0; i < 3; i += 1) expect((await open(started, BG_ID)).status).toBe(200);
  });
});

describe('no test opens a real editor', () => {
  it("the real runFile is refused by the test guard, so the route answers 502 and nothing opens", async () => {
    const indexer = fakeIndexer();
    // No runFile: the route's default, the real one. Neither the opener nor the app exists, so even a
    // broken guard couldn't open anything: never /usr/bin/open, which LaunchServices would answer.
    const server = await startServerWithInternals(
      { indexer, token: TOKEN, webRoot, port: 0 },
      { editors: { found: [{ id: 'cursor', label: 'Cursor', file: '/nonexistent/pitwall-test/open', args: ['-a', '/nonexistent/pitwall-test/Cursor.app'] }] } },
    );
    running.push(server);
    const started = { server, apiKey: await apiKeyOf(server.port), runFile: fakeRunFile() };
    const res = await open(started, BG_ID);
    expect(res.status).toBe(502);
    expect(takeRefusals()).toEqual([expect.stringMatching(/would open an editor/)]);
  });
});
