// Clone and start's route (W107, clone.ts), through the real HTTP server and its /api/* checks, with a
// fake runFile, so no test runs gh, and a made-up root in a temp directory, so none touches a real one.
// Made-up repos only.
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os, { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { RunError, type RunFile, type RunOptions } from '../index/exec.js';
import type { Indexer } from '../index/index.js';
import type { PrSource } from '../prs/poller.js';
import {
  CLONE_PATH,
  CLONE_TEMP_PREFIX,
  WS_PATH,
  type IndexSnapshot,
  type PullRequestList,
  type PullRequestPlace,
  type PullRequestSummary,
  type ServerMessage,
} from '../shared/protocol.js';
import { pitwallOrigin, proofFor } from '../test/proof.js';
import { cloneArgs, holdsHome, homeRefusal, ownTempDir, planClone, unsafeName, type CloneFs, type CloneOptions } from './clone.js';
import type { RunningServer } from './index.js';
import { startServerWithInternals } from './server.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';

let tmp: string;
let webRoot: string;
/** The made-up root, a real path, made afresh for each test. */
let root: string;
let other: string;

beforeAll(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-test-clone-')));
  webRoot = join(tmp, 'web');
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>pitwall</title>');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

let n = 0;
beforeEach(async () => {
  n += 1;
  root = join(tmp, `root-${n}`);
  other = join(tmp, `other-${n}`);
  await mkdir(root, { recursive: true });
  await mkdir(other, { recursive: true });
});

/** A made-up PR in `repo`, placed `place`. GitHub's spelling is `label`. */
function pr(label: string, place: PullRequestPlace | undefined, number = 9): PullRequestSummary {
  const repo = label.toLowerCase();
  return {
    url: `https://github.com/${label}/pull/${number}`,
    repo,
    repoLabel: label,
    number,
    title: 'A made-up change',
    draft: false,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    checks: 'passing',
    mergeable: 'clean',
    relation: 'authored',
    ...(place ? { place } : {}),
  };
}

const notCloned = (label = 'Example/Demo-App') => pr(label, { kind: 'not-cloned', root });

function fakePrs(prs: () => PullRequestSummary[], off = false) {
  const rediscover = vi.fn();
  const source: PrSource & { rediscover: typeof rediscover } = {
    latest: (): PullRequestList => (off ? { source: { ok: false, reason: 'off', error: 'off' }, refreshing: false, prs: [] } : { source: { ok: true }, refreshing: false, prs: prs() }),
    subscribe: () => () => {},
    refresh: () => ({ kind: 'running' }),
    start: () => {},
    stop: () => {},
    rediscover,
  };
  return source;
}

function fakeIndexer(roots: () => string[] | null): Indexer {
  return {
    latest: () => {
      const listed = roots();
      return listed === null ? undefined : ({ generatedAt: '2026-10-29T00:00:00.000Z', roots: listed, groups: [], source: { ok: true } } satisfies IndexSnapshot);
    },
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

interface Call {
  file: string;
  args: readonly string[];
  options: RunOptions;
}

/** A gh that makes a clone where it's told to: a directory with a `.git` and a file, as `gh repo clone` leaves. */
function fakeGh(behave: (dir: string, options: RunOptions) => Promise<void> = makeClone) {
  const calls: Call[] = [];
  const run = vi.fn(async (file: string, args: readonly string[], options: RunOptions) => {
    calls.push({ file, args, options });
    await behave(args[3] as string, options);
    return '';
  });
  return Object.assign(run as RunFile, { calls });
}

async function makeClone(dir: string): Promise<void> {
  await mkdir(join(dir, '.git'), { recursive: true });
  await writeFile(join(dir, 'README.md'), 'made up');
}

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

interface Started {
  server: RunningServer;
  apiKey: string;
  prs: ReturnType<typeof fakePrs>;
}

async function start(options: { prs?: () => PullRequestSummary[]; off?: boolean; roots?: () => string[] | null; clone?: CloneOptions } = {}): Promise<Started> {
  const prs = fakePrs(options.prs ?? (() => [notCloned()]), options.off);
  const indexer = fakeIndexer(options.roots ?? (() => [root, other]));
  const server = await startServerWithInternals({ indexer, token: TOKEN, webRoot, port: 0, prs }, { clone: { runFile: fakeGh(), env: {}, ...options.clone } });
  running.push(server);
  return { server, apiKey: await apiKeyOf(server.port), prs };
}

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: unknown;
}

function post(port: number, body: string | undefined, headers: Record<string, string>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: CLONE_PATH, method: 'POST', headers, agent: false }, (res) => {
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

function clone(started: Started, body: unknown = { repo: 'example/demo-app' }): Promise<HttpResult> {
  return post(started.server.port, JSON.stringify(body), { authorization: `Bearer ${started.apiKey}`, origin: origin(started.server.port), 'content-type': 'application/json' });
}

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
  let reply = await next();
  // The 'prs' message may come before the reply's turn; the apiKey is in 'authenticated'.
  while (reply.type !== 'authenticated') reply = await next();
  ws.close();
  return reply.apiKey;
}

const errorOf = (res: HttpResult) => (res.json as { error: string }).error;
/** What's in the root now, without what every test makes. */
const rootEntries = async () => (await readdir(root)).sort();
const temps = async () => (await readdir(root)).filter((name) => name.startsWith(CLONE_TEMP_PREFIX));

describe('POST CLONE_PATH: the checks of every state-changing request', () => {
  it('needs the apiKey, never the token, and this server’s Origin and Host, and runs nothing otherwise', async () => {
    const gh = fakeGh();
    const started = await start({ clone: { runFile: gh } });
    const { port } = started.server;
    const body = JSON.stringify({ repo: 'example/demo-app' });
    const json = { 'content-type': 'application/json' };
    expect((await post(port, body, { ...json, origin: origin(port) })).status).toBe(401);
    expect((await post(port, body, { ...json, authorization: `Bearer ${TOKEN}`, origin: origin(port) })).status).toBe(403);
    expect((await post(port, body, { ...json, authorization: `Bearer ${started.apiKey}` })).status).toBe(403);
    expect((await post(port, body, { ...json, authorization: `Bearer ${started.apiKey}`, origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(port, body, { ...json, authorization: `Bearer ${started.apiKey}`, origin: origin(port), host: `localhost:${port}` })).status).toBe(403);
    expect(gh.calls).toEqual([]);
    expect(await rootEntries()).toEqual([]);
  });

  it('answers 415 without JSON, 400 for a body that isn’t one, and 413 past 4 KiB', async () => {
    const started = await start();
    const { port } = started.server;
    const auth = { authorization: `Bearer ${started.apiKey}`, origin: origin(port) };
    expect((await post(port, '{"repo":"example/demo-app"}', { ...auth, 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(port, '{', { ...auth, 'content-type': 'application/json' })).status).toBe(400);
    expect((await post(port, JSON.stringify({ repo: 'x'.repeat(5000) }), { ...auth, 'content-type': 'application/json' })).status).toBe(413);
  });
});

describe('POST CLONE_PATH: what may be cloned, from the server’s own list', () => {
  it('answers 400 for a repo that isn’t owner/name, before looking anything up', async () => {
    const gh = fakeGh();
    const started = await start({ clone: { runFile: gh } });
    for (const repo of ['demo-app', '../demo-app', 'example/../../x', 'example/demo app', '-example/demo-app', 'example/demo-app/extra', 'example/', 42, null]) {
      const res = await clone(started, { repo });
      expect(res.status, String(repo)).toBe(400);
    }
    expect((await clone(started, ['example/demo-app'])).status).toBe(400);
    expect(gh.calls).toEqual([]);
  });

  it('answers 404 for a repo with no PR in the list, whatever the request says of its root or directory', async () => {
    const gh = fakeGh();
    const started = await start({ clone: { runFile: gh } });
    const res = await clone(started, { repo: 'example/elsewhere', root: other, cwd: join(other, 'x') });
    expect(res.status).toBe(404);
    expect(errorOf(res)).toMatch(/isn't the repo of any of your open pull requests/);
    expect(gh.calls).toEqual([]);
  });

  it('answers 409 for a repo cloned already, one no root claims, and one whose root is no longer a root', async () => {
    const gh = fakeGh();
    let prs = [pr('Example/Demo-App', { kind: 'cloned', root, key: join(root, 'demo-app'), label: 'demo-app' })];
    let roots = [root, other];
    const started = await start({ prs: () => prs, roots: () => roots, clone: { runFile: gh } });
    let res = await clone(started);
    expect([res.status, errorOf(res)]).toEqual([409, expect.stringMatching(/is cloned already/)]);
    prs = [pr('Example/Demo-App', { kind: 'unclaimed' })];
    res = await clone(started);
    expect([res.status, errorOf(res)]).toEqual([409, expect.stringMatching(/No root claims/)]);
    prs = [pr('Example/Demo-App', undefined)];
    expect((await clone(started)).status).toBe(409);
    prs = [notCloned()];
    roots = [other];
    res = await clone(started);
    expect([res.status, errorOf(res)]).toEqual([409, expect.stringMatching(/isn't one of pitwall's roots now/)]);
    expect(gh.calls).toEqual([]);
  });

  it('answers 400 for a name that is ., .., or starts with a dot, and never runs gh', async () => {
    for (const label of ['example/.', 'example/..', 'example/.github', 'example/.hidden-repo']) {
      const gh = fakeGh();
      const started = await start({ prs: () => [notCloned(label)], clone: { runFile: gh } });
      const res = await clone(started, { repo: label });
      expect(res.status, label).toBe(400);
      expect(gh.calls).toEqual([]);
    }
    expect(await rootEntries()).toEqual([]);
  });

  it('answers 409 with pull requests off, and 503 before the first snapshot', async () => {
    expect((await clone(await start({ off: true }))).status).toBe(409);
    expect((await clone(await start({ roots: () => null }))).status).toBe(503);
  });
});

describe('POST CLONE_PATH: the target', () => {
  it('answers 409 when <root>/<name> exists as a directory, a file or a broken symlink, and leaves it as it was', async () => {
    for (const make of [
      () => mkdir(join(root, 'Demo-App')),
      () => writeFile(join(root, 'Demo-App'), 'mine'),
      () => symlink(join(root, 'nowhere'), join(root, 'Demo-App')),
    ]) {
      await rm(join(root, 'Demo-App'), { recursive: true, force: true });
      await make();
      const gh = fakeGh();
      const started = await start({ clone: { runFile: gh } });
      const res = await clone(started);
      expect([res.status, errorOf(res)]).toEqual([409, expect.stringMatching(/already exists, so pitwall didn't clone into it/)]);
      expect(gh.calls).toEqual([]);
      expect(await rootEntries()).toEqual(['Demo-App']);
    }
  });

  it('answers 409 when the root isn’t a directory at its own real path', async () => {
    const link = join(tmp, `root-link-${n}`);
    await symlink(root, link);
    const started = await start({ prs: () => [pr('Example/Demo-App', { kind: 'not-cloned', root: link })], roots: () => [link] });
    const res = await clone(started);
    expect([res.status, errorOf(res)]).toEqual([409, expect.stringMatching(/isn't a directory at its own path/)]);
    expect(await rootEntries()).toEqual([]);
  });
});

describe('POST CLONE_PATH: never into your home folder or above it (W108)', () => {
  it('answers 409, saying why, for a root that is your home folder, or holds it, and runs nothing', async () => {
    // A made-up home folder: the root itself, then a folder inside the root, which the root holds.
    for (const home of [root, join(root, 'someone')]) {
      await mkdir(home, { recursive: true });
      const gh = fakeGh();
      const started = await start({ clone: { runFile: gh, home } });
      const res = await clone(started);
      expect(res.status).toBe(409);
      expect(errorOf(res)).toBe(homeRefusal(root, home));
      const opening = home === root ? "pitwall doesn't clone into your home folder: " : `pitwall doesn't clone into ${root}, which holds your home folder: `;
      expect(errorOf(res).startsWith(opening)).toBe(true);
      expect(errorOf(res)).toMatch(/~\/bin, which some shells' profiles put on PATH, or ~\/Applications, where pitwall looks for editors/);
      expect(gh.calls).toEqual([]);
      await started.server.close();
    }
  });

  it('compares real paths: a home folder given through a symlink to the root is the root', async () => {
    const link = join(tmp, `home-link-${n}`);
    await symlink(root, link);
    const gh = fakeGh();
    const res = await clone(await start({ clone: { runFile: gh, home: link } }));
    expect([res.status, errorOf(res)]).toEqual([409, homeRefusal(root, root)]);
    expect(gh.calls).toEqual([]);
  });

  it('clones into a root beside the home folder, or inside it', async () => {
    // A made-up home folder beside the root, then one that holds it, as ~ holds ~/code.
    for (const home of [other, tmp]) {
      const gh = fakeGh();
      const res = await clone(await start({ clone: { runFile: gh, home } }));
      expect(res.status).toBe(201);
      expect(gh.calls).toHaveLength(1);
      await rm(join(root, 'Demo-App'), { recursive: true, force: true });
    }
  });

  it('clones nothing when it can’t tell where your home folder is', async () => {
    const gh = fakeGh();
    const res = await clone(await start({ clone: { runFile: gh, home: 'not-absolute' } }));
    expect([res.status, errorOf(res)]).toEqual([409, "pitwall can't tell where your home folder is, so it doesn't clone: it never clones into your home folder or a folder above it."]);
    expect(gh.calls).toEqual([]);
  });

  it('holdsHome is true for the home folder and the folders above it, by path segment, and false for the rest', () => {
    expect(holdsHome('/home/someone', '/home/someone')).toBe(true);
    expect(holdsHome('/home', '/home/someone')).toBe(true);
    expect(holdsHome('/', '/home/someone')).toBe(true);
    expect(holdsHome('/home/someone/code', '/home/someone')).toBe(false);
    expect(holdsHome('/home/some', '/home/someone')).toBe(false);
    expect(holdsHome('/home/someone-else', '/home/someone')).toBe(false);
    expect(holdsHome('/srv', '/home/someone')).toBe(false);
    expect(holdsHome('/home/..someone', '/home/..someone/x')).toBe(true);
  });
});

describe('POST CLONE_PATH: cloning', () => {
  it('runs gh repo clone with GitHub’s spelling into a temp directory in the root, then moves it into place', async () => {
    let cwdMode = 0;
    const gh = fakeGh(async (dir, options) => {
      cwdMode = (await stat(options.cwd as string)).mode & 0o777;
      await makeClone(dir);
    });
    const started = await start({ clone: { runFile: gh, env: { PATH: '/usr/bin', GH_FORCE_TTY: '1', CLICOLOR_FORCE: '1', HOME: '/Users/example', GH_HOST: 'ghe.example.com' } } });
    const res = await clone(started, { repo: 'example/demo-app' });
    const target = join(root, 'Demo-App');
    expect([res.status, res.json]).toEqual([201, { ok: true, cwd: target, hint: `cd ${target} && claude` }]);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(gh.calls).toHaveLength(1);
    const [call] = gh.calls;
    expect(call?.file).toBe('gh');
    const into = call?.args[3] as string;
    expect(call?.args).toEqual(['repo', 'clone', 'Example/Demo-App', into, '--', '--quiet']);
    expect(ownTempDir(join(into, '..'), root)).toBe(true);
    expect(call?.options).toMatchObject({ processGroup: true, timeoutMs: 5 * 60_000 });
    expect(call?.options.signal).toBeInstanceOf(AbortSignal);
    // gh ran in a 0700 directory of pitwall's own in the temp directory, removed after.
    expect(join(call?.options.cwd as string, '..')).toBe(os.tmpdir());
    expect(basename(call?.options.cwd as string)).toMatch(/^pitwall-gh-[A-Za-z0-9]{6}$/);
    expect(cwdMode).toBe(0o700);
    expect(await lstat(call?.options.cwd as string).then(() => true, () => false)).toBe(false);
    expect(call?.options.env).toEqual({ PATH: '/usr/bin', HOME: '/Users/example', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_HOST: 'github.com', GIT_TERMINAL_PROMPT: '0' });
    // In place, and nothing else left in the root.
    expect((await lstat(join(target, '.git'))).isDirectory()).toBe(true);
    expect(await rootEntries()).toEqual(['Demo-App']);
    expect(started.prs.rediscover).toHaveBeenCalledTimes(1);
  });

  it('says what failed in its own words, and removes only its temp directory, when gh is missing, isn’t logged in, fails or takes too long', async () => {
    const cases: [RunError, number, RegExp][] = [
      [new RunError('not-found', 'gh was not found'), 502, /gh, GitHub's CLI, isn't installed/],
      [new RunError('exit', 'exited with code 4', 4), 502, /gh isn't logged in to github.com/],
      [new RunError('exit', 'exited with code 1', 1), 502, /gh couldn't clone Example\/Demo-App \(exit code 1\)/],
      [new RunError('timeout', 'timed out after 300000ms'), 504, /didn't finish within 5 minutes/],
    ];
    await writeFile(join(root, 'keep.txt'), 'not pitwall’s');
    for (const [error, status, message] of cases) {
      const later = vi.fn();
      // It wrote part of a clone first, as a failing git does.
      const gh = fakeGh(async (dir) => {
        await mkdir(join(dir, '.git'), { recursive: true });
        throw error;
      });
      const started = await start({ clone: { runFile: gh, later } });
      const res = await clone(started);
      expect(res.status, error.reason).toBe(status);
      expect(errorOf(res)).toMatch(message);
      expect(errorOf(res)).not.toMatch(/exited with|was not found|timed out after/);
      expect(await rootEntries()).toEqual(['keep.txt']);
      expect(started.prs.rediscover).not.toHaveBeenCalled();
      // A stopped one is removed again a moment later, in case its git was still writing.
      expect(later).toHaveBeenCalledTimes(error.reason === 'timeout' ? 1 : 0);
    }
  });

  it('answers 502 and removes what it made when gh leaves no clone', async () => {
    const started = await start({ clone: { runFile: fakeGh(async () => {}) } });
    const res = await clone(started);
    expect([res.status, errorOf(res)]).toEqual([502, expect.stringMatching(/left no clone/)]);
    expect(await rootEntries()).toEqual([]);
  });

  it('never overwrites a target that appears while it clones: it leaves it alone and removes only its own clone (the rename race)', async () => {
    // The target appears after the check, while gh runs.
    const gh = fakeGh(async (dir) => {
      await makeClone(dir);
      await mkdir(join(root, 'Demo-App'));
      await writeFile(join(root, 'Demo-App', 'theirs.txt'), 'theirs');
    });
    const started = await start({ clone: { runFile: gh } });
    const res = await clone(started);
    expect([res.status, errorOf(res)]).toEqual([409, expect.stringMatching(/appeared while pitwall was cloning/)]);
    expect(await rootEntries()).toEqual(['Demo-App']);
    expect(await readdir(join(root, 'Demo-App'))).toEqual(['theirs.txt']);
  });

  it('leaves a claimed directory that something filled before the rename, and removes its own clone', async () => {
    const real = await import('node:fs/promises');
    const fs: CloneFs = {
      ...real,
      // Between the claim and the rename, something writes into the claimed directory.
      rename: (async (from: string, to: string) => {
        await writeFile(join(to, 'theirs.txt'), 'theirs');
        return real.rename(from, to);
      }) as CloneFs['rename'],
    };
    const started = await start({ clone: { fs } });
    const res = await clone(started);
    expect([res.status, errorOf(res)]).toEqual([409, expect.stringMatching(/changed while pitwall was moving its clone/)]);
    expect(await rootEntries()).toEqual(['Demo-App']);
    expect(await readdir(join(root, 'Demo-App'))).toEqual(['theirs.txt']);
    expect(await temps()).toEqual([]);
  });

  it('clones one repo at a time: another answers 429, the same one 409, and nothing runs for either', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const gh = fakeGh(async (dir) => {
      await gate;
      await makeClone(dir);
    });
    const started = await start({ prs: () => [notCloned(), notCloned('example/other-repo')], clone: { runFile: gh } });
    const first = clone(started);
    await vi.waitFor(() => expect(gh.calls).toHaveLength(1));
    const same = await clone(started);
    const another = await clone(started, { repo: 'example/other-repo' });
    expect([same.status, another.status]).toEqual([409, 429]);
    expect(another.headers['retry-after']).toBe('5');
    release();
    expect((await first).status).toBe(201);
    expect(gh.calls).toHaveLength(1);
  });

  it('clones at most 3 repos a minute, with Retry-After, and a refused request takes none of them', async () => {
    let now = Date.parse('2026-10-29T12:00:00.000Z');
    const labels = ['example/a-1', 'example/a-2', 'example/a-3', 'example/a-4'];
    const started = await start({ prs: () => labels.map((label) => notCloned(label)), clone: { now: () => now } });
    // Refused for an existing target: not counted.
    await mkdir(join(root, 'a-1'));
    expect((await clone(started, { repo: 'example/a-1' })).status).toBe(409);
    await rm(join(root, 'a-1'), { recursive: true });
    for (const label of labels.slice(0, 3)) expect((await clone(started, { repo: label })).status, label).toBe(201);
    now += 20_000;
    const limited = await clone(started, { repo: 'example/a-4' });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('40');
    expect(await temps()).toEqual([]);
  });
});

describe('POST CLONE_PATH: git where it was asked, and shutting down', () => {
  it('drops the GIT_* variables that would put the clone somewhere else, and keeps the rest', async () => {
    const gh = fakeGh();
    const redirects = {
      GIT_DIR: '/x/.git',
      GIT_WORK_TREE: '/x',
      GIT_INDEX_FILE: '/x/index',
      GIT_OBJECT_DIRECTORY: '/x/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/x/alt',
      GIT_COMMON_DIR: '/x/common',
      GIT_NAMESPACE: 'x',
      GIT_CONFIG_PARAMETERS: "'core.worktree'='/x'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree',
      GIT_CONFIG_VALUE_0: '/x',
      GIT_TEMPLATE_DIR: '/x/templates',
    };
    const started = await start({ clone: { runFile: gh, env: { PATH: '/usr/bin', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', ...redirects } } });
    expect((await clone(started)).status).toBe(201);
    const env = gh.calls[0]?.options.env ?? {};
    for (const name of Object.keys(redirects)) expect(env[name], name).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
  });

  it('on close, stops a clone that is running and removes its temp directory', async () => {
    let aborted = false;
    const gh = fakeGh(async (dir, options) => {
      await makeClone(dir);
      await new Promise<void>((_resolve, reject) =>
        options.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new RunError('aborted', 'was stopped'));
        }),
      );
    });
    const started = await start({ clone: { runFile: gh } });
    const request = clone(started).catch(() => undefined);
    await vi.waitFor(() => expect(gh.calls).toHaveLength(1));
    expect(await temps()).toHaveLength(1);
    await started.server.close();
    expect(aborted).toBe(true);
    expect(await rootEntries()).toEqual([]);
    const res = await request;
    // Answered 503 when the connection was still open, or closed with the server.
    if (res) expect(res.status).toBe(503);
  });
});

describe('the sweep at start (W107)', () => {
  const later = Date.now() + 60 * 60_000;
  /** A temp directory named as a clone's, with a clone inside it, `minutesOld` before `later`. */
  const tempDir = async (name: string, minutesOld = 60, inside = minutesOld) => {
    const dir = join(root, name);
    await mkdir(join(dir, 'Demo-App'), { recursive: true });
    const at = (minutes: number) => (later - minutes * 60_000) / 1000;
    await utimes(join(dir, 'Demo-App'), at(inside), at(inside));
    await utimes(dir, at(minutesOld), at(minutesOld));
    return dir;
  };

  it('removes only a real temp directory of this user’s, directly in a root, older than the timeout and a margin', async () => {
    await tempDir('.pitwall-clone-Stale1');
    await tempDir('.pitwall-clone-Fresh1', 5);
    // Its clone is still being written: left alone.
    await tempDir('.pitwall-clone-Busy01', 60, 2);
    await tempDir('.pitwall-clone-short');
    await mkdir(join(root, 'sub'));
    await tempDir('sub/.pitwall-clone-Deep01');
    const target = join(other, 'kept');
    await mkdir(target);
    await symlink(target, join(root, '.pitwall-clone-Link01'));
    await writeFile(join(root, '.pitwall-clone-File01'), 'not a directory');
    const started = await start({ clone: { now: () => later } });
    await started.server.close();
    expect(await rootEntries()).toEqual(['.pitwall-clone-Busy01', '.pitwall-clone-File01', '.pitwall-clone-Fresh1', '.pitwall-clone-Link01', '.pitwall-clone-short', 'sub']);
    expect(await readdir(join(root, 'sub'))).toEqual(['.pitwall-clone-Deep01']);
    expect(await readdir(other)).toEqual(['kept']);
  });

  it('waits for the first snapshot’s roots, looking once a second', async () => {
    await tempDir('.pitwall-clone-Stale3');
    let roots: string[] | null = null;
    const started = await start({ roots: () => roots, clone: { now: () => later } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await rootEntries()).toEqual(['.pitwall-clone-Stale3']);
    roots = [root];
    await vi.waitFor(async () => expect(await rootEntries()).toEqual([]), { timeout: 3000 });
    await started.server.close();
  });

  it('removes nothing of another user’s, or with no user to compare, as on Windows', async () => {
    await tempDir('.pitwall-clone-Stale2');
    for (const uid of [(process.getuid?.() ?? 0) + 1, undefined]) {
      const started = await start({ clone: { now: () => later, uid } });
      await started.server.close();
      expect(await rootEntries()).toEqual(['.pitwall-clone-Stale2']);
    }
  });
});

describe('the pure parts', () => {
  it('planClone takes the root from the place and the name from GitHub’s spelling, never from the request', () => {
    const list: PullRequestList = { source: { ok: true }, refreshing: false, prs: [notCloned()] };
    expect(planClone({ repo: 'EXAMPLE/demo-APP', root: other }, list, [root])).toEqual({
      ok: true,
      plan: { slug: 'Example/Demo-App', name: 'Demo-App', root, target: join(root, 'Demo-App') },
    });
  });

  it('unsafeName refuses ., .., a leading dot and anything GitHub never names a repo', () => {
    for (const name of ['.', '..', '.github', 'a/b', 'a b', '', 'x'.repeat(101)]) expect(unsafeName(name), name).toBeDefined();
    for (const name of ['demo-app', 'Demo_App.js', 'a..b', 'x'.repeat(100)]) expect(unsafeName(name), name).toBeUndefined();
  });

  it('cloneArgs is gh’s documented form, the repo never an option, git’s flags after --', () => {
    expect(cloneArgs('Example/Demo-App', '/r/.pitwall-clone-abc123/Demo-App')).toEqual(['repo', 'clone', 'Example/Demo-App', '/r/.pitwall-clone-abc123/Demo-App', '--', '--quiet']);
  });

  it('ownTempDir is only a CLONE_TEMP_PREFIX directory directly in the root', () => {
    expect(ownTempDir('/r/.pitwall-clone-Ab12Cd', '/r')).toBe(true);
    for (const dir of ['/r/.pitwall-clone-Ab12Cd/x', '/r/x/.pitwall-clone-Ab12Cd', '/r/.pitwall-clone-', '/r/Demo-App', '/r', '/.pitwall-clone-Ab12Cd', '/r/.pitwall-clone-Ab12Cd7']) {
      expect(ownTempDir(dir, '/r'), dir).toBe(false);
    }
  });
});
