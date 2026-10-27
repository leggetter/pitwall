// The directory list (W70): the walk, its limits and cache, and the route through the real HTTP
// server and its /api/* checks. Temporary folders only, made here and removed afterwards.
import type { Dirent } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Indexer } from '../index/index.js';
import { DIRECTORIES_PATH, DIRECTORY_DEPTH, type DirectoryList, type IndexSnapshot } from '../shared/protocol.js';
import { compareEntries, createDirectoryLister, isListable, walkRoot, type ReadDirectory } from './directories.js';
import type { RunningServer } from './index.js';
import { startServerWithInternals, type ServerInternals } from './server.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';

let tmp: string;
/** The tree most tests walk, under tmp/root. */
let root: string;
/** Outside the root, for a symlink to point at. */
let outside: string;
let webRoot: string;

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

async function dirs(base: string, ...paths: string[]) {
  for (const path of paths) await mkdir(join(base, path), { recursive: true });
}

beforeAll(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-test-dirs-')));
  root = join(tmp, 'root');
  outside = join(tmp, 'outside');
  webRoot = join(tmp, 'web');
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>pitwall</title>');

  await dirs(outside, 'secret-a', 'secret-b/deeper');
  await dirs(
    root,
    'alpha/beta/gamma/delta',
    'alpha/Beta2',
    'zeta',
    'repo/src',
    'worktree',
    '.hidden/inside',
    'node_modules/pkg',
    'tools/node_modules/pkg',
    'tools/.cache/x',
  );
  await mkdir(join(root, 'repo', '.git'));
  await writeFile(join(root, 'worktree', '.git'), 'gitdir: /elsewhere/.git/worktrees/worktree\n');
  await mkdir(join(root, 'alpha', 'beta', 'gamma', '.git'));
  await writeFile(join(root, 'file.txt'), 'not a directory');
  await symlink(outside, join(root, 'link-out'));
  await symlink(join(root, 'zeta'), join(root, 'link-in'));
  // Names a terminal or a bidi-aware renderer would show as something else.
  for (const name of ['bell\u0007name', 'c1\u0085name', 'del\u007fname', 'rtl\u202ename', 'isolate\u2066name', 'mark\u200fname', 'arabic\u061cmark']) {
    await mkdir(join(root, name, 'inside'), { recursive: true });
  }
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const paths = (list: Awaited<ReturnType<typeof walkRoot>>) => list.dirs.map((entry) => entry.path);

describe('the walk', () => {
  it('lists the directories to three levels below the root, shallower first, then by path', async () => {
    const walked = await walkRoot(root);
    expect(walked.root).toBe(root);
    expect(walked.truncated).toBe(false);
    expect(paths(walked)).toEqual([
      'alpha',
      'repo',
      'tools',
      'worktree',
      'zeta',
      'alpha/Beta2',
      'alpha/beta',
      'repo/src',
      'alpha/beta/gamma',
    ]);
    expect(DIRECTORY_DEPTH).toBe(3);
    // alpha/beta/gamma/delta is a fourth level.
    expect(paths(walked)).not.toContain('alpha/beta/gamma/delta');
  });

  it('never lists or follows a symlink, to a folder outside the root or inside it', async () => {
    const listed = paths(await walkRoot(root));
    expect(listed.some((path) => path.startsWith('link-out'))).toBe(false);
    expect(listed.some((path) => path.startsWith('link-in'))).toBe(false);
    expect(listed.some((path) => path.includes('secret'))).toBe(false);
  });

  it('skips files, hidden folders, node_modules and names with control or bidi characters, and everything inside them', async () => {
    const listed = paths(await walkRoot(root));
    expect(listed).not.toContain('file.txt');
    for (const path of listed) {
      expect(path).not.toMatch(/(^|\/)\./);
      expect(path).not.toMatch(/node_modules/);
      expect(path).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
      expect(path).not.toMatch(/inside/);
    }
    expect(isListable('ok-name')).toBe(true);
    for (const name of ['', '.git', '.env', 'node_modules', 'a\u0000b', 'a\nb', 'a\u009bb', 'a\u202ab', 'a\u2069b', 'a\ufffdb']) {
      expect(isListable(name)).toBe(false);
    }
    // Only the exact name: a folder called node_modules2 is listed.
    expect(isListable('node_modules2')).toBe(true);
  });

  it('marks an entry with a .git folder or file as a repo, at any level', async () => {
    const walked = await walkRoot(root);
    const repos = walked.dirs.filter((entry) => entry.repo === true).map((entry) => entry.path);
    expect(repos).toEqual(['repo', 'worktree', 'alpha/beta/gamma']);
    expect(walked.dirs.find((entry) => entry.path === 'zeta')).toEqual({ path: 'zeta' });
  });

  it('goes as deep as `depth` says', async () => {
    expect(paths(await walkRoot(root, { depth: 1 }))).toEqual(['alpha', 'repo', 'tools', 'worktree', 'zeta']);
    expect(paths(await walkRoot(root, { depth: 4 }))).toContain('alpha/beta/gamma/delta');
    expect(paths(await walkRoot(root, { depth: 0 }))).toEqual([]);
  });

  it('stops at `max` entries, the shallowest first, and says it was truncated', async () => {
    const walked = await walkRoot(root, { max: 6 });
    expect(walked.truncated).toBe(true);
    expect(walked.dirs).toHaveLength(6);
    expect(paths(walked).slice(0, 5)).toEqual(['alpha', 'repo', 'tools', 'worktree', 'zeta']);
    // Exactly as many as there are isn't truncated.
    const all = await walkRoot(root);
    expect((await walkRoot(root, { max: all.dirs.length })).truncated).toBe(false);
  });

  it('stops at the time limit, even when a read never comes back, and says it was truncated', async () => {
    const slow: ReadDirectory = async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true });
      if (dir === root) return entries;
      // Anything below the root never answers.
      return new Promise<Dirent[]>(() => {});
    };
    const started = Date.now();
    const walked = await walkRoot(root, { readdir: slow, timeLimitMs: 50 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(walked.truncated).toBe(true);
    // The first level was listed before the deadline, though none of it could be checked.
    expect(paths(walked)).toEqual(['alpha', 'repo', 'tools', 'worktree', 'zeta']);

    const never: ReadDirectory = () => new Promise<Dirent[]>(() => {});
    expect(await walkRoot(root, { readdir: never, timeLimitMs: 20 })).toEqual({ root, dirs: [], truncated: true });
  });

  it('leaves out a folder it can not read, and everything inside it, silently', async () => {
    const failing: ReadDirectory = async (dir) => {
      if (dir === join(root, 'alpha')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return readdir(dir, { withFileTypes: true });
    };
    const listed = paths(await walkRoot(root, { readdir: failing }));
    expect(listed.some((path) => path.startsWith('alpha'))).toBe(false);
    expect(listed).toContain('zeta');
  });

  it.skipIf(isRoot)('leaves out a folder whose permissions refuse a read', async () => {
    const locked = await mkdtemp(join(tmp, 'locked-root-'));
    await dirs(locked, 'open/inside', 'shut/inside');
    await chmod(join(locked, 'shut'), 0o000);
    try {
      const walked = await walkRoot(locked);
      expect(paths(walked)).toEqual(['open', 'open/inside']);
      expect(walked.truncated).toBe(false);
    } finally {
      await chmod(join(locked, 'shut'), 0o755);
    }
  });

  it('lists none for a root it can not read, or that has gone', async () => {
    expect(await walkRoot(join(tmp, 'no-such-root'))).toEqual({ root: join(tmp, 'no-such-root'), dirs: [], truncated: false });
  });

  it('sorts as the contract says: by depth, then by UTF-16 code unit', () => {
    const entries = [{ path: 'b/a' }, { path: 'a-x' }, { path: 'B' }, { path: 'a/b' }, { path: 'a' }, { path: 'é' }];
    expect([...entries].sort(compareEntries).map((entry) => entry.path)).toEqual(['B', 'a', 'a-x', 'é', 'a/b', 'b/a']);
  });
});

describe('the cache', () => {
  /** A readdir that counts its reads. */
  function counted() {
    const reads: string[] = [];
    const fn: ReadDirectory = (dir) => {
      reads.push(dir);
      return readdir(dir, { withFileTypes: true });
    };
    return { reads, fn };
  }

  it('reuses a result for 30 seconds, then walks again', async () => {
    let now = 1_000_000;
    const { reads, fn } = counted();
    const lister = createDirectoryLister({ readdir: fn, now: () => now });
    const first = await lister.list([root]);
    const walkReads = reads.length;
    expect(walkReads).toBeGreaterThan(1);
    now += 29_999;
    expect(await lister.list([root])).toBe(first);
    expect(reads.length).toBe(walkReads);
    now += 1;
    const second = await lister.list([root]);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(reads.length).toBe(2 * walkReads);
  });

  it('walks again for other roots', async () => {
    const { reads, fn } = counted();
    const lister = createDirectoryLister({ readdir: fn });
    await lister.list([root]);
    const once = reads.length;
    const both = await lister.list([root, outside]);
    expect(both.roots.map((each) => each.root)).toEqual([root, outside]);
    expect(reads.length).toBeGreaterThan(once);
  });

  it('shares a walk that is running between the requests that come in during it', async () => {
    const { reads, fn } = counted();
    const lister = createDirectoryLister({ readdir: fn });
    const [a, b, c] = await Promise.all([lister.list([root]), lister.list([root]), lister.list([root])]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    const alone = counted();
    await createDirectoryLister({ readdir: alone.fn }).list([root]);
    expect(reads.length).toBe(alone.reads.length);
  });
});

// ---------------------------------------------------------------- the route

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function fakeIndexer(snapshot: IndexSnapshot | undefined): Indexer {
  return {
    latest: () => snapshot,
    subscribe: () => () => {},
    conversation: async () => undefined,
    pollSoon: () => {},
    stop: () => {},
  };
}

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function start(snapshot: IndexSnapshot | undefined, internals: ServerInternals = {}): Promise<RunningServer> {
  const server = await startServerWithInternals({ indexer: fakeIndexer(snapshot), token: TOKEN, webRoot, port: 0 }, internals);
  running.push(server);
  return server;
}

const snapshotOf = (roots: string[]): IndexSnapshot => ({ generatedAt: '2026-10-27T00:00:00.000Z', roots, groups: [], source: { ok: true } });
const bearer = { authorization: `Bearer ${TOKEN}` };

describe(`GET ${DIRECTORIES_PATH}`, () => {
  it("answers each of the snapshot's roots, in its order, with no caching", async () => {
    const server = await start(snapshotOf([root, outside]));
    const response = await get(server.port, DIRECTORIES_PATH, { ...bearer, origin: `http://127.0.0.1:${server.port}` });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    const list = JSON.parse(response.body) as DirectoryList;
    expect(list.roots.map((each) => each.root)).toEqual([root, outside]);
    expect(list.roots[0]?.dirs.find((entry) => entry.path === 'repo')).toEqual({ path: 'repo', repo: true });
    expect(list.roots[1]).toEqual({ root: outside, dirs: [{ path: 'secret-a' }, { path: 'secret-b' }, { path: 'secret-b/deeper' }], truncated: false });
  });

  it('refuses a request without the token, or with a wrong one', async () => {
    const server = await start(snapshotOf([root]));
    expect((await get(server.port, DIRECTORIES_PATH)).status).toBe(401);
    expect((await get(server.port, DIRECTORIES_PATH, { authorization: 'Bearer not-the-token-0123456789abcdefghijklmnop' })).status).toBe(401);
    expect((await get(server.port, DIRECTORIES_PATH, { authorization: TOKEN })).status).toBe(401);
  });

  it('refuses a wrong Host, even with the token', async () => {
    const server = await start(snapshotOf([root]));
    for (const host of [`localhost:${server.port}`, `127.0.0.1:${server.port + 1}`, 'example.com', `127.0.0.1.example.com:${server.port}`]) {
      const response = await get(server.port, DIRECTORIES_PATH, { ...bearer, host });
      expect(response.status, host).toBe(403);
      expect(response.body).toBe('');
    }
  });

  it('refuses a wrong Origin, even with the token', async () => {
    const server = await start(snapshotOf([root]));
    for (const origin of ['http://example.com', `http://localhost:${server.port}`, `http://127.0.0.1:${server.port + 1}`, 'null']) {
      const response = await get(server.port, DIRECTORIES_PATH, { ...bearer, origin });
      expect(response.status, origin).toBe(403);
      expect(response.body).toBe('');
    }
  });

  it('answers 503 before the first snapshot', async () => {
    const server = await start(undefined);
    expect((await get(server.port, DIRECTORIES_PATH, bearer)).status).toBe(503);
  });

  it('takes the limits the server is given', async () => {
    const server = await start(snapshotOf([root]), { directories: { max: 2 } });
    const list = JSON.parse((await get(server.port, DIRECTORIES_PATH, bearer)).body) as DirectoryList;
    expect(list.roots[0]).toEqual({ root, dirs: [{ path: 'alpha' }, { path: 'repo', repo: true }], truncated: true });
  });
});
