// D6: group sessions by `git rev-parse --git-common-dir`, so worktrees sit
// under their main repo, falling back to the working directory. A submodule's
// common dir is inside the superproject's `.git/modules/`, so a submodule is
// keyed by its own top-level directory instead.

import { realpath as fsRealpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFile, type RunFile } from './exec.js';
import { isWithin, type Realpath } from './roots.js';

export interface GroupKey {
  /** The repo's top-level directory for git, otherwise the session's cwd. */
  key: string;
  kind: 'git' | 'directory';
}

export interface GroupResolverOptions {
  run?: RunFile;
  realpath?: Realpath;
  /** Milliseconds since the epoch. Default `Date.now`. */
  now?: () => number;
  /** How long a cwd's result is reused. Default 60000, because polls run every 2 seconds. */
  ttlMs?: number;
  /** Default 'git'. */
  gitBin?: string;
  /** Default 5000. */
  timeoutMs?: number;
}

export interface GroupResolver {
  /** Never rejects. `cwd` should already be a realpath where one exists. */
  resolve(cwd: string): Promise<GroupKey>;
  /** Drops cached results that have expired. */
  prune(): void;
}

// Variables that would point git at another repository than the one `-C` names,
// for example when pitwall runs inside a git hook.
const GIT_REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE'];

export function createGroupResolver(options: GroupResolverOptions = {}): GroupResolver {
  const run = options.run ?? runFile;
  const realpath = options.realpath ?? fsRealpath;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 60_000;
  const gitBin = options.gitBin ?? 'git';
  const timeoutMs = options.timeoutMs ?? 5_000;
  const cache = new Map<string, { expiresAt: number; result: Promise<GroupKey> }>();

  const env = { ...process.env };
  for (const name of GIT_REPO_ENV) delete env[name];

  /** The absolute path git prints for `rev-parse <flag>` in `cwd`, or undefined. */
  async function revParse(cwd: string, flag: string): Promise<string | undefined> {
    let stdout: string;
    try {
      stdout = await run(gitBin, ['-C', cwd, 'rev-parse', '--path-format=absolute', flag], { timeoutMs, env });
    } catch {
      return undefined;
    }
    const value = stdout.trim();
    return value !== '' && path.isAbsolute(value) ? value : undefined;
  }

  async function lookup(cwd: string): Promise<GroupKey> {
    const directory: GroupKey = { key: cwd, kind: 'directory' };
    const commonDir = await revParse(cwd, '--git-common-dir');
    if (commonDir === undefined) return directory;
    let key: string;
    if (isSubmoduleGitDir(commonDir)) {
      const topLevel = await revParse(cwd, '--show-toplevel');
      if (topLevel === undefined) return directory;
      key = topLevel;
    } else {
      key = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
    }
    try {
      return { key: await realpath(key), kind: 'git' };
    } catch {
      return { key, kind: 'git' };
    }
  }

  return {
    resolve(cwd) {
      const at = now();
      const hit = cache.get(cwd);
      if (hit && hit.expiresAt > at) return hit.result;
      const result = lookup(cwd);
      cache.set(cwd, { expiresAt: at + ttlMs, result });
      return result;
    },
    prune() {
      const at = now();
      for (const [cwd, entry] of cache) if (entry.expiresAt <= at) cache.delete(cwd);
    },
  };
}

/**
 * True for a git dir under a `modules` directory inside a `.git` directory,
 * where git keeps a submodule's repository: `/repo/.git/modules/libs/ui`, or
 * `/repo/.git/worktrees/<name>/modules/libs/ui` for a submodule checked out in
 * a linked worktree of the superproject.
 */
export function isSubmoduleGitDir(gitDir: string): boolean {
  const parts = gitDir.split(path.sep);
  const dotGit = parts.indexOf('.git');
  if (dotGit === -1) return false;
  const modules = parts.indexOf('modules', dotGit + 1);
  return modules !== -1 && modules < parts.length - 1;
}

/**
 * A group's label: `key` relative to its root, or the root's basename for the
 * root itself. When the key is outside the root, such as a worktree under the
 * root whose main repo isn't, it's the key with the home directory shown as `~`.
 */
export function groupLabel(key: string, root: string, home: string = os.homedir()): string {
  if (key === root) return path.basename(root) || root;
  if (isWithin(root, key)) return path.relative(root, key);
  return shortenHome(key, home);
}

export function shortenHome(p: string, home: string): string {
  if (home === '' || home === path.parse(home).root || !isWithin(home, p)) return p;
  const rel = path.relative(home, p);
  return rel === '' ? '~' : `~${path.sep}${rel}`;
}
