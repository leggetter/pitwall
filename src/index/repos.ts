// Every git repo under the roots, and its GitHub remotes (M4 redesign, W105), so the PR list can
// place each PR under the clone of its repo, and work out which GitHub owners each root claims.
// Read-only: it never fetches, pulls or changes a repo.
//
//   which repos   below each root to two levels, as `<root>/<repo>` and `<root>/<dir>/<repo>`: a
//                 directory holding `.git`, a directory or a file. Not below a repo, and never in a
//                 hidden directory, `node_modules` or `.worktrees`. Plus every repo the snapshot
//                 already knows (update()'s `known`: its git groups and the repos sessions worked in),
//                 wherever it is
//   its key       the repo's top-level directory, as grouping.ts keys its group: the directory's real
//                 path for a `.git` directory, and for a `.git` file (a worktree or a submodule) what
//                 createGroupResolver() resolves it to, `git rev-parse --git-common-dir`
//   its root      the root its key is under, else the root it was found under or known with
//   its remotes   `git -C <key> config --no-includes --get-regexp '^remote\..*\.url$'`, through runFile:
//                 no shell, childEnvironment(), and gitEnvironment() so no GIT_DIR points it elsewhere
//                 (D23). It reads the repo's config, never its index or objects, and runs no hooks;
//                 `--no-includes` leaves out included files. Each URL is parsed by githubSlugOf(),
//                 and a remote that isn't GitHub's is left out
//   cadence       a full discovery on the first update(), whenever the roots change, on refresh(),
//                 and every refreshMs (5 minutes) after the last one ends; a repo the snapshot knows
//                 that hasn't been read is read on the update() that names it. Never on the 5 s poll
//   git           at most 2 processes at once, each with a 5 s timeout
//   listeners     told after a discovery or a read changes what repos() returns
//
// Fails soft: a directory it can't read is skipped, and a repo git fails in has no remotes.
// Nothing here throws to its caller, and nothing is logged: paths and repo names are session content.

import type { Dirent } from 'node:fs';
import { readdir, realpath as fsRealpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { GITHUB_OWNER_PATTERN, GITHUB_REPO_NAME_PATTERN } from '../shared/protocol.js';
import { runFile, type RunFile } from './exec.js';
import { createGroupResolver, gitEnvironment, type GroupResolver } from './grouping.js';
import { matchRoot } from './roots.js';

/** A GitHub remote of a local repo. */
export interface RepoRemote {
  /** The remote's name, such as `origin`. */
  name: string;
  /** Lowercase `owner/name`, as PullRequestSummary.repo is. */
  slug: string;
}

/** A git repo under a root, with its GitHub remotes. */
export interface LocalRepo {
  /** The repo's top-level directory, real path: the SessionGroup.key its group has or would have. */
  key: string;
  /** The root its group sits under, or would: SessionGroup.root. */
  root: string;
  /** Its GitHub remotes, in the order git lists them. At least one. */
  remotes: RepoRemote[];
}

/** What the last full discovery found, for the benchmark and the plan: counts and time only. */
export interface DiscoveryStats {
  /** Full discoveries finished. */
  discoveries: number;
  /** Milliseconds the last one took, from its start to its last remote read. */
  lastMs?: number;
  /** Directories it read. */
  dirsRead: number;
  /** Repos it found under the roots, plus those the snapshot knew. */
  repos: number;
  /** Of those, the ones with at least one GitHub remote. */
  withGitHub: number;
  /** git processes started, in all. */
  gitRuns: number;
}

export interface RepoDiscovery {
  /**
   * The roots, absolute real paths in the order given (IndexSnapshot.roots), and the repos the
   * snapshot knows, each with its root. Starts a full discovery the first time and when the roots
   * change, and reads the remotes of a known repo not read yet. Returns at once; never throws.
   */
  update(roots: readonly string[], known: Iterable<{ key: string; root: string }>): void;
  /** Every repo with a GitHub remote, by key. Empty until the first discovery has finished. */
  repos(): readonly LocalRepo[];
  /** True once a full discovery has finished. */
  ready(): boolean;
  /** Calls `listener` after repos() changes. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** A full discovery now, or straight after the one running: for a repo just cloned (W107). */
  refresh(): void;
  /** Resolves once nothing is running. For tests and the benchmark. */
  settled(): Promise<void>;
  stats(): DiscoveryStats;
  stop(): void;
}

/** The file system calls discovery makes, so tests can count or refuse them. */
export interface DiscoveryFs {
  readdir(dir: string): Promise<Dirent[]>;
  /** What `.git` is: a directory, a file, or null when there's none. */
  dotGit(dir: string): Promise<'dir' | 'file' | null>;
  realpath(p: string): Promise<string>;
}

/** Timers discovery schedules with. The defaults are unref'd, so they never keep pitwall running. */
export interface DiscoveryTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RepoDiscoveryOptions {
  /** Runs git. Default runFile. */
  run?: RunFile;
  fs?: Partial<DiscoveryFs>;
  timers?: DiscoveryTimers;
  /** A monotonic clock, for DiscoveryStats.lastMs. Default performance.now(). */
  monotonicNow?: () => number;
  /** How long after a full discovery ends the next one starts. Default REPOS_REFRESH_MS. */
  refreshMs?: number;
  /** Default 'git'. */
  gitBin?: string;
  /** Per git process. Default 5000. */
  timeoutMs?: number;
  /** Default 2. */
  gitConcurrency?: number;
}

/** How often every repo under the roots is found again, and its remotes read: 5 minutes. */
export const REPOS_REFRESH_MS = 5 * 60_000;

/** How deep below a root a repo is looked for: `<root>/<repo>` and `<root>/<dir>/<repo>`. */
export const REPOS_DEPTH = 2;

/** Directories never looked in, beside every hidden one. */
const SKIPPED = new Set(['node_modules']);

/** The most repos kept, so a pathological tree can't grow the list without end. */
const MAX_REPOS = 5_000;

const OWNER_NAME = new RegExp(`^(${GITHUB_OWNER_PATTERN})/(${GITHUB_REPO_NAME_PATTERN})$`);

/**
 * The GitHub repo a remote URL points at, as lowercase `owner/name`, or undefined: `https://github.com/`,
 * `git@github.com:` and `ssh://git@github.com/`, each with or without `.git` and a trailing `/`, the
 * host in any case. Owner and name by the contract's patterns, not `.` or `..`. Anything else, such
 * as another host, an SSH alias (`github-work:owner/name`), a credential in the URL or a longer
 * path, is undefined.
 */
export function githubSlugOf(url: string): string | undefined {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  const slug = match?.[1];
  if (slug === undefined) return undefined;
  const parts = OWNER_NAME.exec(slug);
  const name = parts?.[2];
  if (name === undefined || name === '.' || name === '..') return undefined;
  return slug.toLowerCase();
}

/**
 * The GitHub remotes in `git config --get-regexp '^remote\..*\.url$'`'s output: one `remote.<name>.url
 * <url>` per line. git lowercases the section and the key, and keeps the remote's name as it is, dots
 * included. A remote named twice keeps its first GitHub URL.
 */
export function parseRemotes(output: string): RepoRemote[] {
  const remotes: RepoRemote[] = [];
  for (const line of output.split('\n')) {
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const key = line.slice(0, space);
    if (!key.startsWith('remote.') || !key.endsWith('.url') || key.length <= 'remote.'.length + '.url'.length) continue;
    const name = key.slice('remote.'.length, -'.url'.length);
    const slug = githubSlugOf(line.slice(space + 1));
    if (slug === undefined || remotes.some((remote) => remote.name === name)) continue;
    remotes.push({ name, slug });
  }
  return remotes;
}

const realTimers: DiscoveryTimers = {
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return timer;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const nodeFs: DiscoveryFs = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  dotGit: (dir) =>
    stat(path.join(dir, '.git')).then(
      (info) => (info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null),
      () => null,
    ),
  realpath: (p) => fsRealpath(p),
};

/** At most `max` of `fn` at once, each waiting its turn in order. */
function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

const sameRoots = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((root, i) => root === b[i]);

export function createRepoDiscovery(options: RepoDiscoveryOptions = {}): RepoDiscovery {
  const fs: DiscoveryFs = { ...nodeFs, ...options.fs };
  const timers = options.timers ?? realTimers;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const refreshMs = options.refreshMs ?? REPOS_REFRESH_MS;
  const gitBin = options.gitBin ?? 'git';
  const timeoutMs = options.timeoutMs ?? 5_000;
  const baseRun = options.run ?? runFile;
  const limit = createLimiter(options.gitConcurrency ?? 2);
  const counters: DiscoveryStats = { discoveries: 0, dirsRead: 0, repos: 0, withGitHub: 0, gitRuns: 0 };
  const run: RunFile = (file, args, runOptions) =>
    limit(() => {
      counters.gitRuns++;
      return baseRun(file, args, runOptions);
    });
  // Its own, so discovery never waits behind the poll's git, nor the poll behind it.
  const resolver: GroupResolver = createGroupResolver({ run, gitBin, timeoutMs, realpath: fs.realpath, ttlMs: refreshMs });
  const env = gitEnvironment();

  let roots: string[] = [];
  /** What the last full discovery found under the roots: key to the root it's under. */
  let found = new Map<string, string>();
  /** What the snapshot knows: key to its root. */
  let known = new Map<string, string>();
  /** Each repo's GitHub remotes, as last read; an empty list when it has none or git failed. */
  let remotes = new Map<string, RepoRemote[]>();
  /** Known repos whose remotes are being read now. */
  const reading = new Set<string>();
  let list: LocalRepo[] = [];
  let content = '[]';
  let ready = false;
  let stopped = false;
  let running: Promise<void> | undefined;
  /** refresh() or new roots while a discovery ran: run another straight after. */
  let again = false;
  let timer: unknown;
  const pending = new Set<Promise<void>>();
  const listeners = new Set<() => void>();

  /** A repo's GitHub remotes. Never rejects. */
  async function readRemotes(key: string): Promise<RepoRemote[]> {
    try {
      return parseRemotes(await run(gitBin, ['-C', key, 'config', '--no-includes', '--get-regexp', '^remote\\..*\\.url$'], { timeoutMs, env }));
    } catch {
      // Exit 1: no remotes. Anything else, such as a repo that has gone or a timeout: none either.
      return [];
    }
  }

  /** The repo `dir` holds, by its `.git`: its key, or undefined when git says it isn't one. */
  async function keyOf(dir: string, dotGit: 'dir' | 'file'): Promise<string | undefined> {
    const real = await fs.realpath(dir).catch(() => dir);
    if (dotGit === 'dir') return real;
    const group = await resolver.resolve(real);
    return group.kind === 'git' ? group.key : undefined;
  }

  /** The directories in `dir` worth looking in: not hidden, not node_modules, and directories or links to one. */
  async function children(dir: string): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    counters.dirsRead++;
    return entries
      .filter((entry) => !entry.name.startsWith('.') && !SKIPPED.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  }

  /** The repos at and below `dir`, to `depth` more levels, never below a repo. */
  async function findUnder(dir: string, root: string, depth: number, into: Map<string, string>): Promise<void> {
    if (stopped || into.size >= MAX_REPOS) return;
    const dotGit = await fs.dotGit(dir).catch(() => null);
    if (dotGit !== null) {
      const key = await keyOf(dir, dotGit);
      if (key !== undefined && !into.has(key)) into.set(key, root);
      return;
    }
    if (depth === 0) return;
    const dirs = await children(dir);
    await Promise.all(dirs.map((child) => findUnder(child, root, depth - 1, into)));
  }

  /** The root a repo's group sits under: the one its key is in, else the one it was found or known under. */
  const rootOf = (key: string, given: string) => matchRoot(key, roots) ?? given;

  /** Every repo found or known, by key, with its root and remotes, and tells the listeners if that changed. */
  function rebuild(): void {
    const all = new Map<string, string>(found);
    for (const [key, root] of known) if (!all.has(key)) all.set(key, root);
    const next: LocalRepo[] = [];
    for (const [key, given] of all) {
      const repoRemotes = remotes.get(key);
      if (repoRemotes === undefined || repoRemotes.length === 0) continue;
      next.push({ key, root: rootOf(key, given), remotes: repoRemotes.map((remote) => ({ ...remote })) });
    }
    next.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    counters.repos = all.size;
    counters.withGitHub = next.length;
    const nextContent = JSON.stringify(next);
    if (nextContent === content) return;
    list = next;
    content = nextContent;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One listener's failure mustn't stop the others.
      }
    }
  }

  async function discover(): Promise<void> {
    const startedAt = monotonicNow();
    const forRoots = [...roots];
    const into = new Map<string, string>();
    for (const root of forRoots) await findUnder(root, root, REPOS_DEPTH, into);
    if (stopped) return;
    const keys = new Set([...into.keys(), ...known.keys()]);
    const read = new Map(await Promise.all([...keys].map(async (key) => [key, await readRemotes(key)] as const)));
    if (stopped) return;
    // If the roots changed meanwhile, what was found is for the old ones, and another discovery follows.
    found = into;
    // A repo the snapshot named while this ran was read on its own: keep that.
    const previous = remotes;
    remotes = read;
    for (const key of known.keys()) {
      const kept = previous.get(key);
      if (!remotes.has(key) && kept !== undefined) remotes.set(key, kept);
    }
    ready = true;
    counters.discoveries++;
    counters.lastMs = Math.round(monotonicNow() - startedAt);
    rebuild();
    readNew();
  }

  function schedule(): void {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = undefined;
      kick();
    }, refreshMs);
  }

  function kick(): void {
    if (stopped) return;
    if (running !== undefined) {
      again = true;
      return;
    }
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
    running = discover()
      .catch(() => undefined)
      .finally(() => {
        running = undefined;
        if (stopped) return;
        if (again) {
          again = false;
          kick();
        } else schedule();
      });
  }

  /** Reads the remotes of known repos that no discovery has read yet. Not before the first, which reads them all. */
  function readNew(): void {
    if (!ready) return;
    for (const key of known.keys()) {
      if (remotes.has(key) || reading.has(key)) continue;
      reading.add(key);
      const done = readRemotes(key).then((read) => {
        reading.delete(key);
        if (stopped) return;
        // Kept even if it's no longer known: a discovery replaces the whole map anyway.
        remotes.set(key, read);
        rebuild();
      });
      pending.add(done);
      void done.finally(() => pending.delete(done));
    }
  }

  return {
    update(nextRoots, nextKnown) {
      if (stopped) return;
      try {
        const knownNow = new Map<string, string>();
        for (const { key, root } of nextKnown) {
          if (knownNow.size >= MAX_REPOS) break;
          if (typeof key === 'string' && path.isAbsolute(key) && !knownNow.has(key)) knownNow.set(key, root);
        }
        const rootsChanged = !sameRoots(roots, nextRoots);
        const knownChanged = knownNow.size !== known.size || [...knownNow].some(([key, root]) => known.get(key) !== root);
        known = knownNow;
        if (rootsChanged) {
          roots = [...nextRoots];
          kick();
          return;
        }
        if (running === undefined && !ready) kick();
        if (knownChanged && ready) {
          readNew();
          rebuild();
        }
      } catch {
        // Never fails the caller.
      }
    },
    repos: () => list,
    ready: () => ready,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh() {
      kick();
    },
    async settled() {
      for (;;) {
        if (running !== undefined) await running;
        else if (pending.size > 0) await Promise.all([...pending]);
        else return;
      }
    },
    stats: () => ({ ...counters }),
    stop() {
      stopped = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
      listeners.clear();
    },
  };
}
