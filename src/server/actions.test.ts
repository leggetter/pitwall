// Spawn, stop and remove, through the real HTTP server and its /api/* checks,
// with a fake command runner, so no test ever runs `claude`. Made-up sessions
// only.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { AgentRow, AgentsResult } from '../index/agents.js';
import type { Indexer } from '../index/index.js';
import {
  removePath,
  resumePath,
  SPAWN_PATH,
  stopPath,
  WS_PATH,
  type IndexSnapshot,
  type ServerMessage,
  type SessionSummary,
} from '../shared/protocol.js';
import {
  DEFAULT_MAX_CONCURRENT_COMMANDS,
  firstLine,
  MAX_PROMPT_LENGTH,
  parseBackgrounded,
  parseCopyNote,
  resumeArgs,
  shellQuote,
  spawnArgs,
  SpawnLimiter,
  trustHint,
  type ActionOptions,
} from './actions.js';
import type { CommandOptions, CommandResult, RunCommand } from './command.js';
import type { RunningServer } from './index.js';
import { startServerWithInternals } from './server.js';
import { pitwallOrigin, proofFor } from '../test/proof.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';

// ---------------------------------------------------------------- fixtures

let tmp: string;
/** The root pitwall watches, as a realpath, as the snapshot carries it. */
let root: string;
let repo: string;
let outside: string;
let webRoot: string;

beforeAll(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-test-actions-')));
  root = join(tmp, 'root');
  repo = join(root, 'repo');
  outside = join(tmp, 'outside');
  webRoot = join(tmp, 'web');
  await mkdir(join(repo, 'packages', 'worker'), { recursive: true });
  await mkdir(join(root, "it's a dir"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>pitwall</title>');
  await writeFile(join(repo, 'README.md'), 'not a directory');
  await symlink(outside, join(root, 'escape'));
  await symlink(join(repo, 'packages'), join(root, 'alias'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const BG_ID = '11111111-1111-4111-8111-111111111111';
const INTERACTIVE_ID = '22222222-2222-4222-8222-222222222222';
const NO_SHORT_ID = '33333333-3333-4333-8333-333333333333';
const BAD_SHORT_ID = '44444444-4444-4444-8444-444444444444';
/** Ended interactive sessions (W66): one that can be resumed, and ones whose directory has gone or moved. */
const ENDED_ID = '66666666-6666-4666-8666-666666666666';
const ENDED_OTHER_ID = '77777777-7777-4777-8777-777777777777';
const ENDED_MISSING_ID = '88888888-8888-4888-8888-888888888888';
const ENDED_GONE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENDED_ESCAPE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENDED_QUOTED_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function session(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'sessionId'>): SessionSummary {
  return {
    name: 'pitwall-test-a',
    kind: 'background',
    cwd: repo,
    alive: true,
    startedAt: '2026-10-16T00:00:00.000Z',
    stale: false,
    finished: false,
    transcript: 'missing',
    ...overrides,
  };
}

/** An ended interactive session, as the index lists one (SessionSummary.ended). */
function ended(sessionId: string, cwd: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return session({ sessionId, kind: 'interactive', name: `worker-${sessionId.slice(0, 8)}`, cwd, alive: false, finished: true, ended: true, transcript: 'ok', ...overrides });
}

function snapshot(): IndexSnapshot {
  return {
    generatedAt: '2026-10-16T00:00:00.000Z',
    roots: [root],
    groups: [
      {
        key: repo,
        label: 'repo',
        kind: 'git',
        root,
        sessions: [
          session({ sessionId: BG_ID, shortId: 'b3899da0', name: 'pitwall-test-bg' }),
          session({ sessionId: INTERACTIVE_ID, kind: 'interactive', name: 'pitwall-test-interactive', pid: 4242 }),
          session({ sessionId: NO_SHORT_ID, name: 'pitwall-test-no-short-id' }),
          session({ sessionId: BAD_SHORT_ID, shortId: '-h', name: 'pitwall-test-bad-short-id' }),
          ended(ENDED_ID, join(repo, 'packages', 'worker')),
          ended(ENDED_OTHER_ID, repo),
          ended(ENDED_MISSING_ID, join(repo, 'removed-worktree'), { cwdMissing: true }),
          // Gone since the poll, so the snapshot doesn't say so yet.
          ended(ENDED_GONE_ID, join(repo, 'gone-since')),
          ended(ENDED_ESCAPE_ID, join(root, 'escape')),
          ended(ENDED_QUOTED_ID, join(root, "it's a dir")),
        ],
      },
    ],
    source: { ok: true },
  };
}

/** An index holding `latest`; `null` for one that hasn't finished its first poll. */
function fakeIndexer(latest: IndexSnapshot | null = snapshot()): Indexer {
  return {
    latest: () => latest ?? undefined,
    subscribe: () => () => {},
    conversation: async () => undefined,
    pollSoon: vi.fn(),
    stop: () => {},
  };
}

/** A stand-in for the fresh `claude agents --json --all` a resume reads first. It answers `result`, which a test can change. */
function fakeAgents(result: AgentsResult = { ok: true, rows: [] }) {
  const agents = {
    result,
    list: vi.fn(async () => agents.result),
  };
  return agents;
}

const agentRow = (sessionId: string, overrides: Partial<AgentRow> = {}): AgentRow => ({
  sessionId,
  name: 'pitwall-test-open-again',
  kind: 'interactive',
  cwd: repo,
  pid: 5151,
  startedAt: '2026-10-16T00:00:00.000Z',
  ...overrides,
});

interface Call {
  file: string;
  args: readonly string[];
  options: CommandOptions;
}

/** A runner that records each call and answers with `answer`, or the next of `answers`. */
function fakeRunner(...answers: CommandResult[]): RunCommand & { calls: Call[] } {
  const calls: Call[] = [];
  let next = 0;
  const run = vi.fn(async (file: string, args: readonly string[], options: CommandOptions) => {
    calls.push({ file, args, options });
    const answer = answers[Math.min(next, answers.length - 1)];
    next += 1;
    if (!answer) throw new Error('no answer');
    return answer;
  });
  return Object.assign(run, { calls });
}

const exited = (code: number, stdout = '', stderr = ''): CommandResult => ({ kind: 'exited', code, stdout, stderr });
const backgrounded = (id = 'c0ffee12', name = 'pitwall-test-spawn') => exited(0, `backgrounded · ${id} · ${name}\n`);
/** What `claude --resume <id> --bg` prints (spike 006, finding 2). */
const resumedOutput = (id = '66666666') =>
  exited(0, `backgrounded · ${id} (idle — send a prompt to start)\n  claude attach ${id}\n  claude logs ${id}\n  claude stop ${id}\n`);
/** What it prints when the session is open in another Claude Code process (finding 5). */
const copyOutput = (copy = 'ee8a7a26', original = '66666666') =>
  exited(
    0,
    `backgrounded · ${copy} (idle — send a prompt to start)\n`,
    `note: session ${original} is open in another Claude Code process, so this started a copy as ${copy}. The original conversation is unchanged.\n`,
  );

// ---------------------------------------------------------------- clients

const running: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

interface Started {
  server: RunningServer;
  apiKey: string;
  run: ReturnType<typeof fakeRunner>;
}

async function start(run = fakeRunner(backgrounded()), actions: ActionOptions = {}, indexer: Indexer = fakeIndexer()): Promise<Started> {
  // A fake agents source by default, so no test can reach the real `claude agents`.
  const server = await startServerWithInternals({ indexer, token: TOKEN, webRoot, port: 0 }, { actions: { run, env: {}, agents: fakeAgents(), ...actions } });
  running.push(server);
  return { server, apiKey: await apiKeyOf(server.port), run };
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: unknown;
}

function post(port: number, path: string, body: string | undefined, headers: Record<string, string>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers, agent: false }, (res) => {
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
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const origin = (port: number) => `http://127.0.0.1:${port}`;

/** POSTs as the web UI does: the apiKey, this server's Origin and a JSON body. */
function postAsPage(started: Started, path: string, body?: unknown): Promise<HttpResult> {
  return post(started.server.port, path, body === undefined ? undefined : JSON.stringify(body), {
    authorization: `Bearer ${started.apiKey}`,
    origin: origin(started.server.port),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  });
}

const spawnAsPage = (started: Started, body: unknown) => postAsPage(started, SPAWN_PATH, body);

/** The apiKey, from W8's challenge-response handshake. */
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
  const proof = proofFor(TOKEN, challenge.nonce, pitwallOrigin(port));
  ws.send(JSON.stringify({ type: 'auth', proof }));
  const reply = await next();
  ws.close();
  if (reply.type !== 'authenticated') throw new Error(`expected authenticated, got ${reply.type}`);
  return reply.apiKey;
}

const valid = () => ({ cwd: repo, prompt: 'Reply with: ready', name: 'pitwall-test-spawn', model: 'haiku' });

// ---------------------------------------------------------------- tests

describe('the action routes: credentials', () => {
  const paths = () => [SPAWN_PATH, stopPath(BG_ID), removePath(BG_ID), resumePath(ENDED_ID)];

  it('refuse the raw token, even from this Origin, without running anything', async () => {
    const started = await start();
    for (const path of paths()) {
      const res = await post(started.server.port, path, JSON.stringify(valid()), {
        authorization: `Bearer ${TOKEN}`,
        origin: origin(started.server.port),
        'content-type': 'application/json',
      });
      expect(res.status, path).toBe(403);
    }
    expect(started.run.calls).toEqual([]);
  });

  it('refuse the apiKey without this Origin, or with another one', async () => {
    const started = await start();
    for (const path of paths()) {
      for (const value of [undefined, 'http://evil.example', `http://localhost:${started.server.port}`]) {
        const headers: Record<string, string> = { authorization: `Bearer ${started.apiKey}`, 'content-type': 'application/json' };
        if (value !== undefined) headers.origin = value;
        expect((await post(started.server.port, path, JSON.stringify(valid()), headers)).status, `${path} ${value}`).toBe(403);
      }
    }
    expect(started.run.calls).toEqual([]);
  });

  it('refuse no credential, or a wrong one, with 401', async () => {
    const started = await start();
    for (const path of paths()) {
      for (const authorization of [undefined, 'Bearer wrong']) {
        const headers: Record<string, string> = { origin: origin(started.server.port), 'content-type': 'application/json' };
        if (authorization) headers.authorization = authorization;
        expect((await post(started.server.port, path, JSON.stringify(valid()), headers)).status).toBe(401);
      }
    }
    expect(started.run.calls).toEqual([]);
  });

  it('let the apiKey with this Origin through', async () => {
    const started = await start(fakeRunner(backgrounded(), exited(0), exited(0), resumedOutput()));
    expect((await spawnAsPage(started, valid())).status).toBe(201);
    expect((await postAsPage(started, stopPath(BG_ID))).status).toBe(200);
    expect((await postAsPage(started, removePath(BG_ID))).status).toBe(200);
    expect((await postAsPage(started, resumePath(ENDED_ID))).status).toBe(200);
    expect(started.run.calls).toHaveLength(4);
  });
});

describe('spawn: validation', () => {
  async function expect400(body: unknown, error?: RegExp) {
    const started = await start();
    const res = await spawnAsPage(started, body);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(res.json).toMatchObject({ ok: false, error: expect.any(String) });
    if (error) expect((res.json as { error: string }).error).toMatch(error);
    expect(started.run.calls).toEqual([]);
  }

  it('refuses a body that is not a JSON object', async () => {
    for (const body of [null, [], 'text', 42]) await expect400(body, /JSON object/);
  });

  it('refuses invalid JSON with 400, a body that is not JSON with 415, and a huge body with 413', async () => {
    const started = await start();
    const headers = { authorization: `Bearer ${started.apiKey}`, origin: origin(started.server.port) };
    const bad = await post(started.server.port, SPAWN_PATH, '{"cwd":', { ...headers, 'content-type': 'application/json' });
    expect([bad.status, bad.json]).toEqual([400, { ok: false, error: "The body isn't valid JSON." }]);
    const text = await post(started.server.port, SPAWN_PATH, JSON.stringify(valid()), { ...headers, 'content-type': 'text/plain' });
    expect(text.status).toBe(415);
    const form = await post(started.server.port, SPAWN_PATH, 'cwd=/', { ...headers, 'content-type': 'application/x-www-form-urlencoded' });
    expect(form.status).toBe(415);
    const huge = await post(started.server.port, SPAWN_PATH, JSON.stringify({ ...valid(), prompt: 'x'.repeat(200_000) }), {
      ...headers,
      'content-type': 'application/json',
    });
    expect(huge.status).toBe(413);
    expect(started.run.calls).toEqual([]);
  });

  it('requires a prompt of 1 to 16,384 characters that is not blank and has no NUL', async () => {
    const { prompt: _, ...noPrompt } = valid();
    await expect400(noPrompt, /prompt is required/);
    await expect400({ ...valid(), prompt: '' }, /prompt is required/);
    await expect400({ ...valid(), prompt: '  \n\t ' }, /prompt is required/);
    await expect400({ ...valid(), prompt: 42 }, /prompt is required/);
    await expect400({ ...valid(), prompt: 'x'.repeat(MAX_PROMPT_LENGTH + 1) }, /at most 16384/);
    await expect400({ ...valid(), prompt: 'a\u0000b' }, /NUL/);

    const started = await start();
    expect((await spawnAsPage(started, { ...valid(), prompt: 'x'.repeat(MAX_PROMPT_LENGTH) })).status).toBe(201);
  });

  // Never with a real claude: these prompts are exactly the ones that could run `claude update` or `claude logout`.
  it('refuses a prompt that is just the name of a claude command, without running anything', async () => {
    for (const prompt of ['logout', 'update', ' Upgrade\n', 'purge', 'rm', 'agents', 'rc']) {
      await expect400({ ...valid(), prompt }, /that's the name of a claude command/);
    }
    const started = await start();
    expect((await spawnAsPage(started, { ...valid(), prompt: 'update the README' })).status).toBe(201);
    expect(started.run.calls.at(-1)?.args.at(-1)).toBe('update the README');
  });

  it("refuses a name outside the contract's characters, over 64, or that could read as an option", async () => {
    for (const name of ['a;b', 'a/b', 'a$b', 'naïve', 'tab\there', 'x'.repeat(65), '-h', '--bg', ' leading', 'trailing ', '', 42, null]) {
      await expect400({ ...valid(), name }, /name/);
    }
  });

  it('accepts a name with letters, digits, spaces, ".", "_" and "-", up to 64', async () => {
    for (const name of ['pitwall-test-spawn', 'Fix the docs 2.0', '_private', '.dot', 'x'.repeat(64), 'a']) {
      const started = await start();
      const res = await spawnAsPage(started, { ...valid(), name });
      expect(res.status, name).toBe(201);
      expect(started.run.calls[0]?.args).toContain(name);
    }
  });

  it('refuses a model that is not a short alias', async () => {
    for (const model of ['opus 4', '-x', 'sonnet[1m]', 'a/b', 'x'.repeat(41), '', 7]) await expect400({ ...valid(), model }, /model/);
  });

  it('accepts short aliases and full model names', async () => {
    for (const model of ['haiku', 'sonnet', 'opus', 'claude-haiku-4-5', 'x'.repeat(40)]) {
      const started = await start();
      expect((await spawnAsPage(started, { ...valid(), model })).status, model).toBe(201);
    }
  });

  it('requires an absolute cwd with no control characters', async () => {
    const { cwd: _, ...noCwd } = valid();
    await expect400(noCwd, /directory is required/);
    await expect400({ ...valid(), cwd: '' }, /directory is required/);
    await expect400({ ...valid(), cwd: 42 }, /directory is required/);
    await expect400({ ...valid(), cwd: 'root/repo' }, /absolute/);
    await expect400({ ...valid(), cwd: `${repo}\n` }, /control characters/);
    await expect400({ ...valid(), cwd: `/${'a'.repeat(5000)}` }, /too long/);
  });

  it("refuses a cwd that doesn't exist, or isn't a directory", async () => {
    await expect400({ ...valid(), cwd: join(repo, 'missing') }, /doesn't exist/);
    await expect400({ ...valid(), cwd: join(repo, 'README.md', 'below') }, /doesn't exist/);
    await expect400({ ...valid(), cwd: join(repo, 'README.md') }, /isn't a directory/);
  });

  it('refuses a cwd outside the roots, including through .. and through a symlink under a root', async () => {
    await expect400({ ...valid(), cwd: outside }, /isn't under the root/);
    await expect400({ ...valid(), cwd: tmp }, /isn't under the root/);
    await expect400({ ...valid(), cwd: join(root, '..', 'outside') }, /isn't under the root/);
    await expect400({ ...valid(), cwd: join(root, 'escape') }, /isn't under the root/);
    await expect400({ ...valid(), cwd: `${root}-sibling` }, /doesn't exist|isn't under/);
  });

  it('runs in the realpath: the root itself, a subdirectory, or a symlink that stays under the root', async () => {
    const cases: [string, string][] = [
      [root, root],
      [join(repo, 'packages', 'worker'), join(repo, 'packages', 'worker')],
      [join(root, 'alias', 'worker'), join(repo, 'packages', 'worker')],
      [`${repo}/`, repo],
    ];
    for (const [cwd, real] of cases) {
      const started = await start();
      expect((await spawnAsPage(started, { ...valid(), cwd })).status, cwd).toBe(201);
      expect(started.run.calls[0]?.options.cwd).toBe(real);
    }
  });

  it('answers 503 before the first snapshot, since the roots are not known yet', async () => {
    const started = await start(fakeRunner(backgrounded()), {}, fakeIndexer(null));
    const res = await spawnAsPage(started, valid());
    expect(res.status).toBe(503);
    expect(started.run.calls).toEqual([]);
  });
});

describe('spawn: running claude --bg', () => {
  it('runs claude --bg with the name, the model and the prompt after --, in the directory', async () => {
    const started = await start();
    await spawnAsPage(started, valid());
    expect(started.run.calls).toHaveLength(1);
    const [call] = started.run.calls;
    expect(call?.file).toBe('claude');
    expect(call?.args).toEqual(['--bg', '--name', 'pitwall-test-spawn', '--model', 'haiku', '--', 'Reply with: ready']);
    expect(call?.options.cwd).toBe(repo);
    expect(call?.options.timeoutMs).toBe(30_000);
  });

  it('leaves out the name and model when they are not given, and keeps a prompt that starts with - as the prompt', async () => {
    const started = await start();
    await spawnAsPage(started, { cwd: repo, prompt: '--dangerously-skip-permissions' });
    expect(started.run.calls[0]?.args).toEqual(['--bg', '--', '--dangerously-skip-permissions']);
  });

  it('uses the configured claude binary', async () => {
    const started = await start(fakeRunner(backgrounded()), { claudeBin: '/opt/claude/bin/claude' });
    await spawnAsPage(started, valid());
    expect(started.run.calls[0]?.file).toBe('/opt/claude/bin/claude');
  });

  it('answers 201 with the short id and name from the backgrounded line', async () => {
    const started = await start(fakeRunner(backgrounded('b3899da0', 'pitwall-test-spawn')));
    const res = await spawnAsPage(started, valid());
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ ok: true, shortId: 'b3899da0', name: 'pitwall-test-spawn' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('records the short id it started, for attach, and nothing for a spawn that failed', async () => {
    const spawned = { add: vi.fn() };
    const started = await start(fakeRunner(backgrounded('b3899da0', 'pitwall-test-spawn'), exited(1, '', 'boom\n')), { spawned });
    expect((await spawnAsPage(started, valid())).status).toBe(201);
    expect((await spawnAsPage(started, valid())).status).toBe(502);
    expect(spawned.add.mock.calls).toEqual([['b3899da0']]);
  });

  // The scrubber itself, name by name, is tested in command.test.ts.
  it("scrubs the environment through the shared scrubber: no PITWALL_*, npm's, the session's identity or the token reach claude", async () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/Users/example',
      PITWALL_TOKEN: TOKEN,
      PITWALL_HOME: '/tmp/p',
      npm_config_save_exact: 'true',
      INIT_CWD: '/x',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: '99999999-9999-4999-8999-999999999999',
      CLAUDE_CODE_CHILD_SESSION: '1',
      COPIED: `Bearer ${TOKEN}`,
    };
    const started = await start(fakeRunner(backgrounded(), exited(0), exited(0), resumedOutput()), { env });
    await spawnAsPage(started, valid());
    await postAsPage(started, stopPath(BG_ID));
    await postAsPage(started, removePath(BG_ID));
    await postAsPage(started, resumePath(ENDED_ID));
    expect(started.run.calls).toHaveLength(4);
    for (const call of started.run.calls) expect(call.options.env).toEqual({ PATH: '/usr/bin', HOME: '/Users/example' });
  });

  it("answers 422 with Claude Code's message and a hint for an untrusted workspace, and never trusts it", async () => {
    const message = `Workspace not trusted. Run \`claude\` in ${repo} once and accept the trust prompt, then retry.\n`;
    const started = await start(fakeRunner(exited(1, '', message)));
    const res = await spawnAsPage(started, valid());
    expect(res.status).toBe(422);
    expect(res.json).toEqual({ ok: false, error: message.trim(), hint: `cd ${repo} && claude` });
    // One call, and it was the spawn: nothing ran to accept the trust prompt.
    expect(started.run.calls.map((call) => call.args[0])).toEqual(['--bg']);
  });

  it('quotes the hint so a shell runs it in exactly that directory', async () => {
    const dir = join(root, "it's a dir");
    const started = await start(fakeRunner(exited(1, '', `Workspace not trusted. Run \`claude\` in ${dir} once.`)));
    const res = await spawnAsPage(started, { ...valid(), cwd: dir });
    const { hint } = res.json as { hint: string };
    expect(hint).toBe(`cd '${dir.replace("'", `'\\''`)}' && claude`);
    // The hint's cd, run by a real shell with pwd in place of claude.
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', hint.replace(/ && claude$/, ' && pwd')]);
    expect(stdout.trim()).toBe(dir);
  });

  it("answers 502 with Claude Code's first error line for any other failure", async () => {
    const started = await start(
      fakeRunner(
        exited(1, '', '\u001b[31mError: model "nope" not found\u001b[0m\n    at somewhere\n'),
        exited(2, 'Something went wrong on stdout\n', ''),
        exited(3),
      ),
    );
    const first = await spawnAsPage(started, valid());
    expect([first.status, first.json]).toEqual([502, { ok: false, error: 'Error: model "nope" not found' }]);
    const second = await spawnAsPage(started, valid());
    expect(second.json).toEqual({ ok: false, error: 'Something went wrong on stdout' });
    const third = await spawnAsPage(started, valid());
    expect(third.json).toEqual({ ok: false, error: 'claude --bg exited with code 3.' });
  });

  it('answers 502 when claude exits 0 without a backgrounded line, or with an id that is not safe', async () => {
    const started = await start(fakeRunner(exited(0, 'Started something\n'), exited(0, 'backgrounded · -rf · x\n')));
    const first = await spawnAsPage(started, valid());
    expect(first.status).toBe(502);
    expect((first.json as { error: string }).error).toMatch(/didn't report the new session's id: Started something/);
    expect((await spawnAsPage(started, valid())).status).toBe(502);
  });

  it("answers 502 when claude can't be run, and 504 when it times out", async () => {
    const started = await start(
      fakeRunner(
        { kind: 'failed', reason: 'not-found', message: 'claude was not found' },
        { kind: 'failed', reason: 'timeout', message: "didn't finish within 30s" },
      ),
    );
    const missing = await spawnAsPage(started, valid());
    expect([missing.status, missing.json]).toEqual([502, { ok: false, error: "Couldn't run claude: claude was not found." }]);
    const slow = await spawnAsPage(started, valid());
    expect(slow.status).toBe(504);
    expect((slow.json as { error: string }).error).toMatch(/may still appear/);
  });
});

describe('spawn: limits', () => {
  it('runs one spawn at a time, and answers 429 with Retry-After to another meanwhile', async () => {
    let release: (result: CommandResult) => void = () => {};
    const run = fakeRunner(backgrounded());
    const blocking: RunCommand & { calls: Call[] } = Object.assign(
      vi.fn(async (file: string, args: readonly string[], options: CommandOptions) => {
        blocking.calls.push({ file, args, options });
        if (blocking.calls.length === 1) return new Promise<CommandResult>((resolve) => (release = resolve));
        return run(file, args, options);
      }),
      { calls: [] as Call[] },
    );
    const started = await start(blocking);

    const first = spawnAsPage(started, valid());
    await vi.waitFor(() => expect(blocking.calls).toHaveLength(1));
    const second = await spawnAsPage(started, valid());
    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBe('1');
    expect((second.json as { error: string }).error).toMatch(/still starting/);

    release(backgrounded('aaaa1111'));
    expect((await first).status).toBe(201);
    expect((await spawnAsPage(started, valid())).status).toBe(201);
    expect(blocking.calls).toHaveLength(2);
  });

  it('frees the slot when the runner fails', async () => {
    const started = await start(fakeRunner({ kind: 'failed', reason: 'timeout', message: 'x' }, backgrounded()));
    expect((await spawnAsPage(started, valid())).status).toBe(504);
    expect((await spawnAsPage(started, valid())).status).toBe(201);
  });

  it('starts at most 5 a minute by default, and not counting refused requests', async () => {
    let now = 1_000_000;
    const started = await start(fakeRunner(backgrounded()), { now: () => now });
    for (let i = 0; i < 3; i++) expect((await spawnAsPage(started, { ...valid(), name: 'bad;name' })).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await spawnAsPage(started, valid())).status, `spawn ${i}`).toBe(201);
    now += 20_000;
    const limited = await spawnAsPage(started, valid());
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('40');
    expect((limited.json as { error: string }).error).toMatch(/at most 5 sessions every 60 seconds/);
    expect(started.run.calls).toHaveLength(5);
    now += 40_000;
    expect((await spawnAsPage(started, valid())).status).toBe(201);
  });
});

describe('stop and remove', () => {
  it('runs at most 4 stop and remove commands at once, and answers 429 with Retry-After to more meanwhile', async () => {
    expect(DEFAULT_MAX_CONCURRENT_COMMANDS).toBe(4);
    const waiting: (() => void)[] = [];
    let hold = true;
    const calls: Call[] = [];
    const run = Object.assign(
      vi.fn(async (file: string, args: readonly string[], options: CommandOptions) => {
        calls.push({ file, args, options });
        if (hold) await new Promise<void>((resolve) => waiting.push(resolve));
        return exited(0);
      }),
      { calls },
    );
    const started = await start(run);
    const slow = [stopPath(BG_ID), removePath(BG_ID), stopPath(BG_ID), removePath(BG_ID)].map((path) => postAsPage(started, path));
    await vi.waitFor(() => expect(waiting).toHaveLength(4));

    for (const path of [stopPath(BG_ID), removePath(BG_ID)]) {
      const refused = await postAsPage(started, path);
      expect(refused.status).toBe(429);
      expect(refused.headers['retry-after']).toBe('1');
      expect((refused.json as { error: string }).error).toMatch(/already running 4 stop, remove or resume commands/);
    }
    expect(run.calls).toHaveLength(4);

    hold = false;
    for (const finish of waiting.splice(0)) finish();
    for (const res of await Promise.all(slow)) expect(res.status).toBe(200);
    expect((await postAsPage(started, stopPath(BG_ID))).status).toBe(200);
    expect(run.calls).toHaveLength(5);
  });

  it("stops a background session with claude stop and the resolved short id, in the temp directory", async () => {
    const started = await start(fakeRunner(exited(0)));
    const res = await postAsPage(started, stopPath(BG_ID));
    expect([res.status, res.json]).toEqual([200, { ok: true }]);
    expect(started.run.calls).toHaveLength(1);
    expect(started.run.calls[0]?.file).toBe('claude');
    expect(started.run.calls[0]?.args).toEqual(['stop', 'b3899da0']);
    expect(started.run.calls[0]?.options.cwd).toBe(tmpdir());
  });

  it('removes a background session with claude rm and the short id only, never a discard or force flag', async () => {
    const started = await start(fakeRunner(exited(0)));
    const res = await postAsPage(started, removePath(BG_ID), { discardUnpushed: 'abc@wt', force: true });
    expect([res.status, res.json]).toEqual([200, { ok: true }]);
    expect(started.run.calls[0]?.args).toEqual(['rm', 'b3899da0']);
  });

  it("passes Claude Code's refusal through: claude rm keeps a worktree with unpushed commits", async () => {
    const refusal = [
      'Kept the worktree pitwall-test-wt: it has 2 unpushed commits.',
      "To discard them, run 'claude rm b3899da0 --discard-unpushed 1a2b3c@pitwall-test-wt'.",
    ].join('\n');
    const started = await start(fakeRunner(exited(1, '', `${refusal}\n`)));
    const res = await postAsPage(started, removePath(BG_ID));
    expect([res.status, res.json]).toEqual([409, { ok: false, error: refusal }]);
    expect(started.run.calls).toHaveLength(1);
  });

  it("passes claude stop's error through, or says how it exited", async () => {
    const started = await start(fakeRunner(exited(1, '', "No job matching 'b3899da0'.\n"), exited(1)));
    expect((await postAsPage(started, stopPath(BG_ID))).json).toEqual({ ok: false, error: "No job matching 'b3899da0'." });
    expect((await postAsPage(started, stopPath(BG_ID))).json).toEqual({ ok: false, error: 'claude stop exited with code 1.' });
  });

  it("answers 409 for an interactive session, an ended one included, and for a background one without a safe short id, without running anything", async () => {
    const started = await start();
    for (const id of [INTERACTIVE_ID, ENDED_ID, NO_SHORT_ID, BAD_SHORT_ID]) {
      for (const path of [stopPath(id), removePath(id)]) {
        const res = await postAsPage(started, path);
        expect(res.status, path).toBe(409);
        expect(res.json).toMatchObject({ ok: false, error: expect.any(String) });
      }
    }
    expect(started.run.calls).toEqual([]);
  });

  it("answers 404 for a session that isn't listed, 400 for an unsafe id and 503 before the first snapshot, as JSON", async () => {
    const started = await start();
    const unknown = await postAsPage(started, stopPath('55555555-5555-4555-8555-555555555555'));
    expect([unknown.status, (unknown.json as { ok: boolean }).ok]).toEqual([404, false]);
    const unsafe = await postAsPage(started, removePath('../../etc'));
    expect(unsafe.status).toBe(400);
    expect(unsafe.json).toMatchObject({ ok: false });
    const early = await start(fakeRunner(exited(0)), {}, fakeIndexer(null));
    expect((await postAsPage(early, stopPath(BG_ID))).status).toBe(503);
    expect(started.run.calls).toEqual([]);
    expect(early.run.calls).toEqual([]);
  });

  it("answers 502 when claude can't be run, and 504 when it times out", async () => {
    const started = await start(
      fakeRunner({ kind: 'failed', reason: 'not-found', message: 'claude was not found' }, { kind: 'failed', reason: 'timeout', message: "didn't finish within 30s" }),
    );
    expect((await postAsPage(started, stopPath(BG_ID))).status).toBe(502);
    const slow = await postAsPage(started, removePath(BG_ID));
    expect([slow.status, slow.json]).toEqual([504, { ok: false, error: "claude rm didn't finish within 30s." }]);
  });

  it('only answers POST', async () => {
    const started = await start();
    const res = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: started.server.port, path: stopPath(BG_ID), method: 'GET', headers: { authorization: `Bearer ${started.apiKey}` }, agent: false },
        (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(res).toBe(404);
    expect(started.run.calls).toEqual([]);
  });
});

describe('resume (W66)', () => {
  const worker = () => join(repo, 'packages', 'worker');
  const errorOf = (res: HttpResult) => (res.json as { error: string }).error;

  it('runs claude --resume <id> --bg, with no prompt, in the directory the session started in, after a fresh claude agents', async () => {
    const order: string[] = [];
    const agents = fakeAgents();
    agents.list.mockImplementation(async () => {
      order.push('agents');
      return agents.result;
    });
    const calls: Call[] = [];
    const run = Object.assign(
      vi.fn(async (file: string, args: readonly string[], options: CommandOptions) => {
        order.push('run');
        calls.push({ file, args, options });
        return resumedOutput();
      }),
      { calls },
    );
    const started = await start(run, { agents });
    const res = await postAsPage(started, resumePath(ENDED_ID));
    expect([res.status, res.json]).toEqual([200, { ok: true, shortId: '66666666' }]);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(order).toEqual(['agents', 'run']);
    expect(started.run.calls).toHaveLength(1);
    const [call] = started.run.calls;
    expect(call?.file).toBe('claude');
    expect(call?.args).toEqual(['--resume', ENDED_ID, '--bg']);
    expect(call?.options.cwd).toBe(worker());
    expect(call?.options.timeoutMs).toBe(30_000);
  });

  it('takes nothing from the request: a body naming another directory or session changes nothing', async () => {
    const started = await start(fakeRunner(resumedOutput()));
    const res = await postAsPage(started, resumePath(ENDED_ID), { cwd: outside, sessionId: ENDED_OTHER_ID, prompt: 'hello' });
    expect(res.status).toBe(200);
    expect(started.run.calls[0]?.args).toEqual(['--resume', ENDED_ID, '--bg']);
    expect(started.run.calls[0]?.options.cwd).toBe(worker());
  });

  it('records the short id for attach and the session id as resumed, and makes the index poll soon', async () => {
    const spawned = { add: vi.fn() };
    const resumed = { add: vi.fn() };
    const indexer = fakeIndexer();
    const started = await start(fakeRunner(resumedOutput('66666666')), { spawned, resumed }, indexer);
    expect((await postAsPage(started, resumePath(ENDED_ID))).status).toBe(200);
    expect(spawned.add.mock.calls).toEqual([['66666666']]);
    expect(resumed.add.mock.calls).toEqual([[ENDED_ID]]);
    expect(indexer.pollSoon).toHaveBeenCalled();
  });

  it("answers 409 for a session that hasn't ended, without checking or running anything", async () => {
    const agents = fakeAgents();
    const started = await start(fakeRunner(resumedOutput()), { agents });
    for (const id of [BG_ID, INTERACTIVE_ID, NO_SHORT_ID]) {
      const res = await postAsPage(started, resumePath(id));
      expect(res.status, id).toBe(409);
      expect(errorOf(res)).toMatch(/Only an interactive session that has ended can be resumed/);
    }
    expect(agents.list).not.toHaveBeenCalled();
    expect(started.run.calls).toEqual([]);
  });

  it('answers 409 when its directory has gone, by the snapshot or found afresh, or now leads outside the roots', async () => {
    const agents = fakeAgents();
    const started = await start(fakeRunner(resumedOutput()), { agents });
    const missing = await postAsPage(started, resumePath(ENDED_MISSING_ID));
    expect(missing.status).toBe(409);
    expect(errorOf(missing)).toMatch(/no longer exists/);
    const gone = await postAsPage(started, resumePath(ENDED_GONE_ID));
    expect(gone.status).toBe(409);
    expect(errorOf(gone)).toMatch(/doesn't exist/);
    const escape = await postAsPage(started, resumePath(ENDED_ESCAPE_ID));
    expect(escape.status).toBe(409);
    expect(errorOf(escape)).toMatch(/isn't under the root/);
    expect(agents.list).not.toHaveBeenCalled();
    expect(started.run.calls).toEqual([]);
  });

  it('answers 409 and resumes nothing when a fresh claude agents lists it, as when its terminal is open again', async () => {
    for (const listed of [agentRow(ENDED_ID), agentRow(ENDED_ID, { kind: 'background', shortId: '66666666', pid: undefined, state: 'done' })]) {
      const agents = fakeAgents({ ok: true, rows: [agentRow(ENDED_OTHER_ID), listed] });
      const indexer = fakeIndexer();
      const started = await start(fakeRunner(resumedOutput()), { agents }, indexer);
      const res = await postAsPage(started, resumePath(ENDED_ID));
      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatch(/running again.*would start a copy/);
      expect(started.run.calls).toEqual([]);
      expect(indexer.pollSoon).toHaveBeenCalled();
    }
  });

  it("fails closed with 502 when the fresh claude agents fails, and resumes nothing", async () => {
    const agents = fakeAgents({ ok: false, error: 'claude agents --json --all timed out after 10s' });
    const started = await start(fakeRunner(resumedOutput()), { agents });
    const res = await postAsPage(started, resumePath(ENDED_ID));
    expect(res.status).toBe(502);
    expect(errorOf(res)).toMatch(/couldn't check that the session isn't running again, so it didn't resume it: claude agents --json --all timed out after 10s/);
    expect(started.run.calls).toEqual([]);
  });

  it('answers 409 to a second resume of the same session while the first runs, but not to another session', async () => {
    let release: (result: CommandResult) => void = () => {};
    const calls: Call[] = [];
    const run = Object.assign(
      vi.fn(async (file: string, args: readonly string[], options: CommandOptions) => {
        calls.push({ file, args, options });
        if (calls.length === 1) return new Promise<CommandResult>((resolve) => (release = resolve));
        return resumedOutput(String(args[1]).slice(0, 8));
      }),
      { calls },
    );
    const started = await start(run);
    const first = postAsPage(started, resumePath(ENDED_ID));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const again = await postAsPage(started, resumePath(ENDED_ID));
    expect([again.status, errorOf(again)]).toEqual([409, 'pitwall is already resuming this session.']);
    expect((await postAsPage(started, resumePath(ENDED_OTHER_ID))).status).toBe(200);
    release(resumedOutput());
    expect((await first).status).toBe(200);
    // Free again once the first has answered.
    expect((await postAsPage(started, resumePath(ENDED_ID))).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it('shares the limit of 4 with stop and remove, and answers 429 with Retry-After past it', async () => {
    const waiting: (() => void)[] = [];
    let hold = true;
    const calls: Call[] = [];
    const run = Object.assign(
      vi.fn(async (file: string, args: readonly string[], options: CommandOptions) => {
        calls.push({ file, args, options });
        if (hold) await new Promise<void>((resolve) => waiting.push(resolve));
        return args[0] === '--resume' ? resumedOutput() : exited(0);
      }),
      { calls },
    );
    const started = await start(run);
    const slow = [stopPath(BG_ID), removePath(BG_ID), stopPath(BG_ID), resumePath(ENDED_ID)].map((path) => postAsPage(started, path));
    await vi.waitFor(() => expect(waiting).toHaveLength(4));
    for (const path of [resumePath(ENDED_OTHER_ID), stopPath(BG_ID)]) {
      const refused = await postAsPage(started, path);
      expect(refused.status, path).toBe(429);
      expect(refused.headers['retry-after']).toBe('1');
      expect(errorOf(refused)).toMatch(/already running 4 stop, remove or resume commands/);
    }
    hold = false;
    for (const finish of waiting.splice(0)) finish();
    for (const res of await Promise.all(slow)) expect(res.status).toBe(200);
    expect((await postAsPage(started, resumePath(ENDED_OTHER_ID))).status).toBe(200);
    expect(calls).toHaveLength(5);
  });

  it("reports the copy Claude Code started instead, with its short id, and leaves it alone", async () => {
    const spawned = { add: vi.fn() };
    const resumed = { add: vi.fn() };
    const indexer = fakeIndexer();
    const started = await start(fakeRunner(copyOutput('ee8a7a26')), { spawned, resumed }, indexer);
    const res = await postAsPage(started, resumePath(ENDED_ID));
    expect(res.status).toBe(409);
    expect(res.json).toEqual({
      ok: false,
      error:
        'It was open in another Claude Code process after all, so Claude Code started a copy as ee8a7a26 instead. The copy is listed as a background session with no name, which you can stop and remove.',
      copyShortId: 'ee8a7a26',
    });
    // Nothing stopped or removed the copy: the one command was the resume.
    expect(started.run.calls.map((call) => call.args[0])).toEqual(['--resume']);
    expect(spawned.add.mock.calls).toEqual([['ee8a7a26']]);
    expect(resumed.add).not.toHaveBeenCalled();
    expect(indexer.pollSoon).toHaveBeenCalled();
  });

  it("still reports a copy whose short id isn't safe to act on, without the id", async () => {
    const started = await start(fakeRunner(exited(0, 'backgrounded · -rf\n', 'note: session 66666666 is open in another Claude Code process, so this started a copy as -rf. The original conversation is unchanged.\n')));
    const res = await postAsPage(started, resumePath(ENDED_ID));
    expect(res.status).toBe(409);
    expect(res.json).not.toHaveProperty('copyShortId');
    expect(errorOf(res)).toMatch(/started a copy instead/);
  });

  it("answers 422 with Claude Code's message and a hint, quoted, for an untrusted workspace, and never trusts it", async () => {
    const dir = join(root, "it's a dir");
    const message = `Workspace not trusted. Run \`claude\` in ${dir} once and accept the trust prompt, then retry.\n`;
    const started = await start(fakeRunner(exited(1, '', message)));
    const res = await postAsPage(started, resumePath(ENDED_QUOTED_ID));
    expect(res.status).toBe(422);
    expect(res.json).toEqual({ ok: false, error: message.trim(), hint: trustHint(dir) });
    expect(started.run.calls.map((call) => call.args[0])).toEqual(['--resume']);
  });

  it("answers 502 with Claude Code's first error line, or how it exited, or when it reported no id", async () => {
    const started = await start(
      fakeRunner(exited(1, '', `No conversation found with session ID: ${ENDED_ID}\n    at somewhere\n`), exited(2), exited(0, 'Resumed something\n')),
    );
    const first = await postAsPage(started, resumePath(ENDED_ID));
    expect([first.status, first.json]).toEqual([502, { ok: false, error: `No conversation found with session ID: ${ENDED_ID}` }]);
    const second = await postAsPage(started, resumePath(ENDED_ID));
    expect(second.json).toEqual({ ok: false, error: 'claude --resume exited with code 2.' });
    const third = await postAsPage(started, resumePath(ENDED_ID));
    expect(third.status).toBe(502);
    expect(errorOf(third)).toMatch(/didn't report the resumed session's id: Resumed something/);
  });

  it("answers 502 when claude can't be run, and 504 when it times out", async () => {
    const started = await start(
      fakeRunner({ kind: 'failed', reason: 'not-found', message: 'claude was not found' }, { kind: 'failed', reason: 'timeout', message: "didn't finish within 30s" }),
    );
    expect((await postAsPage(started, resumePath(ENDED_ID))).json).toEqual({ ok: false, error: "Couldn't run claude: claude was not found." });
    const slow = await postAsPage(started, resumePath(ENDED_ID));
    expect(slow.status).toBe(504);
    expect(errorOf(slow)).toMatch(/claude --resume didn't finish within 30s\. The session may still appear/);
  });

  it("answers 404 for a session that isn't listed, 400 for an unsafe id and 503 before the first snapshot, without running anything", async () => {
    const agents = fakeAgents();
    const started = await start(fakeRunner(resumedOutput()), { agents });
    expect((await postAsPage(started, resumePath('dddddddd-dddd-4ddd-8ddd-dddddddddddd'))).status).toBe(404);
    expect((await postAsPage(started, resumePath('../../etc'))).status).toBe(400);
    const early = await start(fakeRunner(resumedOutput()), { agents }, fakeIndexer(null));
    expect((await postAsPage(early, resumePath(ENDED_ID))).status).toBe(503);
    expect(agents.list).not.toHaveBeenCalled();
    expect(started.run.calls).toEqual([]);
    expect(early.run.calls).toEqual([]);
  });
});

describe('helpers', () => {
  it('parseBackgrounded reads the id and name, ignoring other lines and terminal escapes', () => {
    expect(parseBackgrounded('backgrounded · b3899da0 · pitwall-test-a\n')).toEqual({ shortId: 'b3899da0', name: 'pitwall-test-a' });
    expect(parseBackgrounded('Starting background service…\r\n\u001b[2mbackgrounded · b3899da0 · Fix the docs 2.0\u001b[0m\n')).toEqual({
      shortId: 'b3899da0',
      name: 'Fix the docs 2.0',
    });
    expect(parseBackgrounded('backgrounded · b3899da0\n')).toEqual({ shortId: 'b3899da0' });
    // claude --resume <id> --bg prints a state in brackets, and no name (spike 006).
    expect(parseBackgrounded('backgrounded · 5e66fcb3 (idle — send a prompt to start)\n  claude attach 5e66fcb3\n')).toEqual({ shortId: '5e66fcb3' });
    expect(parseBackgrounded('backgrounded · b3899da0 · Fix (the docs)\n')).toEqual({ shortId: 'b3899da0', name: 'Fix (the docs)' });
    expect(parseBackgrounded('started b3899da0\n')).toBeUndefined();
    expect(parseBackgrounded('backgrounded · -h · x')).toBeUndefined();
    expect(parseBackgrounded('')).toBeUndefined();
  });

  it('shellQuote leaves plain words alone and single-quotes everything else', () => {
    expect(shellQuote('/Users/example/code/demo-app')).toBe('/Users/example/code/demo-app');
    expect(shellQuote('/tmp/with space')).toBe("'/tmp/with space'");
    expect(shellQuote("/tmp/it's")).toBe("'/tmp/it'\\''s'");
    expect(shellQuote('/tmp/$HOME/`id`;rm')).toBe("'/tmp/$HOME/`id`;rm'");
    expect(shellQuote('~/code')).toBe("'~/code'");
    expect(shellQuote('')).toBe("''");
    expect(trustHint('/tmp/a b')).toBe("cd '/tmp/a b' && claude");
  });

  it('firstLine skips blank lines and strips escapes', () => {
    expect(firstLine('\n\n  \u001b[31mError: x\u001b[0m  \nmore')).toBe('Error: x');
    expect(firstLine('  \n ')).toBeUndefined();
  });

  it('parseCopyNote reads the copy from the note, wherever it is, and leaves out an id that is not safe', () => {
    const note = 'note: session bea3e368 is open in another Claude Code process, so this started a copy as ee8a7a26. The original conversation is unchanged.';
    expect(parseCopyNote(`backgrounded · ee8a7a26 (idle)\n${note}\n`)).toEqual({ found: true, shortId: 'ee8a7a26' });
    expect(parseCopyNote(`\u001b[33m${note}\u001b[0m`)).toEqual({ found: true, shortId: 'ee8a7a26' });
    expect(parseCopyNote('note: … so this started a copy as --help. …')).toEqual({ found: true });
    expect(parseCopyNote('backgrounded · 5e66fcb3 (idle — send a prompt to start)')).toBeUndefined();
  });

  it('resumeArgs passes the session id and --bg, and no prompt', () => {
    expect(resumeArgs('5e66fcb3-0000-4000-8000-000000000000')).toEqual(['--resume', '5e66fcb3-0000-4000-8000-000000000000', '--bg']);
  });

  it('spawnArgs always ends the options before the prompt', () => {
    expect(spawnArgs({ cwd: '/x', prompt: '-p' })).toEqual(['--bg', '--', '-p']);
    expect(spawnArgs({ cwd: '/x', prompt: 'p', name: 'n', model: 'm' })).toEqual(['--bg', '--name', 'n', '--model', 'm', '--', 'p']);
  });

  it('SpawnLimiter releases a slot once, however often release is called', () => {
    const limiter = new SpawnLimiter(1, { max: 10, windowMs: 1000 }, () => 0);
    const first = limiter.acquire();
    expect(first.ok).toBe(true);
    expect(limiter.acquire().ok).toBe(false);
    if (first.ok) {
      first.release();
      first.release();
    }
    const second = limiter.acquire();
    expect(second.ok).toBe(true);
    expect(limiter.acquire().ok).toBe(false);
  });
});
