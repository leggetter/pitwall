import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunFile } from './exec.js';
import { createGroupResolver, groupLabel, isSubmoduleGitDir, shortenHome } from './grouping.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c', 'user.name=pitwall-test',
      '-c', 'user.email=pitwall-test@example.invalid',
      '-c', 'commit.gpgsign=false',
      '-c', 'init.defaultBranch=main',
      '-c', 'core.hooksPath=/dev/null',
      // Submodules are cloned from a local path; never from the network.
      '-c', 'protocol.file.allow=always',
      ...args,
    ],
    { cwd, stdio: 'ignore' },
  );
}

describe('createGroupResolver against temporary repos', () => {
  let dir: string;
  let main: string;
  let worktree: string;
  let plain: string;
  let submodule: string;
  let worktreeWithSubmodule: string;

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-git-')));
    main = path.join(dir, 'main');
    worktree = path.join(dir, 'worktrees', 'feature');
    plain = path.join(dir, 'plain');
    await mkdir(path.join(main, 'packages', 'app'), { recursive: true });
    await mkdir(path.join(dir, 'worktrees'), { recursive: true });
    await mkdir(plain, { recursive: true });
    git(main, 'init', '-q');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', worktree);

    // A submodule cloned from a local repo, and a linked worktree of the
    // superproject with the submodule checked out in it too.
    const library = path.join(dir, 'library');
    await mkdir(library);
    git(library, 'init', '-q');
    git(library, 'commit', '-q', '--allow-empty', '-m', 'library');
    git(main, 'submodule', 'add', '-q', library, 'libs/library');
    git(main, 'commit', '-q', '-m', 'add the submodule');
    submodule = path.join(main, 'libs', 'library');
    await mkdir(path.join(submodule, 'src'));
    worktreeWithSubmodule = path.join(dir, 'worktrees', 'with-submodule');
    git(main, 'worktree', 'add', '-q', '-b', 'with-submodule', worktreeWithSubmodule);
    git(worktreeWithSubmodule, 'submodule', 'update', '-q', '--init');
  }, 30_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keys a repo by its top-level directory', async () => {
    const groups = createGroupResolver();
    expect(await groups.resolve(main)).toEqual({ key: main, kind: 'git' });
  });

  it('keys a subdirectory by its repo', async () => {
    const groups = createGroupResolver();
    expect(await groups.resolve(path.join(main, 'packages', 'app'))).toEqual({ key: main, kind: 'git' });
  });

  it('puts a git worktree under its main repo', async () => {
    const groups = createGroupResolver();
    expect(await groups.resolve(worktree)).toEqual({ key: main, kind: 'git' });
  });

  it('keys a submodule by its own top-level directory, not by its git dir in .git/modules', async () => {
    const groups = createGroupResolver();
    expect(await groups.resolve(submodule)).toEqual({ key: submodule, kind: 'git' });
    expect(await groups.resolve(path.join(submodule, 'src'))).toEqual({ key: submodule, kind: 'git' });
  });

  it('keys a submodule in a linked worktree of the superproject by its own top-level directory', async () => {
    const checkout = path.join(worktreeWithSubmodule, 'libs', 'library');
    expect(await createGroupResolver().resolve(checkout)).toEqual({ key: checkout, kind: 'git' });
  });

  it('still keys the superproject and its worktree by the superproject', async () => {
    const groups = createGroupResolver();
    expect(await groups.resolve(main)).toEqual({ key: main, kind: 'git' });
    expect(await groups.resolve(worktreeWithSubmodule)).toEqual({ key: main, kind: 'git' });
  });

  it('falls back to the directory when it is not a repo', async () => {
    const groups = createGroupResolver();
    expect(await groups.resolve(plain)).toEqual({ key: plain, kind: 'directory' });
  });

  it('falls back to the directory when it no longer exists', async () => {
    const groups = createGroupResolver();
    const gone = path.join(dir, 'gone');
    expect(await groups.resolve(gone)).toEqual({ key: gone, kind: 'directory' });
  });

  it('ignores GIT_DIR in its own environment', async () => {
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(main, '.git');
    try {
      const groups = createGroupResolver();
      expect(await groups.resolve(plain)).toEqual({ key: plain, kind: 'directory' });
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });
});

describe('createGroupResolver with a fake git', () => {
  function counting(output: string | Error) {
    const calls: string[][] = [];
    const run: RunFile = async (_file, args) => {
      calls.push([...args]);
      if (output instanceof Error) throw output;
      return output;
    };
    return { calls, run };
  }

  it('runs rev-parse for the absolute common dir', async () => {
    const { calls, run } = counting('/repos/a/.git\n');
    await createGroupResolver({ run, realpath: async (p) => p }).resolve('/repos/a/src');
    expect(calls).toEqual([['-C', '/repos/a/src', 'rev-parse', '--path-format=absolute', '--git-common-dir']]);
  });

  it('uses the common dir itself when it is not named .git, as for a bare repo', async () => {
    const { run } = counting('/repos/b.git\n');
    expect(await createGroupResolver({ run, realpath: async (p) => p }).resolve('/wt/b')).toEqual({
      key: '/repos/b.git',
      kind: 'git',
    });
  });

  it('asks for the top-level directory when the common dir is a submodule git dir', async () => {
    const calls: string[][] = [];
    const run: RunFile = async (_file, args) => {
      calls.push([...args]);
      return args.includes('--show-toplevel') ? '/repos/super/libs/ui\n' : '/repos/super/.git/modules/libs/ui\n';
    };
    expect(await createGroupResolver({ run, realpath: async (p) => p }).resolve('/repos/super/libs/ui/src')).toEqual({
      key: '/repos/super/libs/ui',
      kind: 'git',
    });
    expect(calls).toEqual([
      ['-C', '/repos/super/libs/ui/src', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      ['-C', '/repos/super/libs/ui/src', 'rev-parse', '--path-format=absolute', '--show-toplevel'],
    ]);
  });

  it('falls back to the directory when the top-level directory of a submodule is unavailable', async () => {
    const run: RunFile = async (_file, args) => {
      if (args.includes('--show-toplevel')) throw new Error('fatal: not a work tree');
      return '/repos/super/.git/modules/ui\n';
    };
    expect(await createGroupResolver({ run }).resolve('/repos/super/ui')).toEqual({ key: '/repos/super/ui', kind: 'directory' });
  });

  it('falls back to the directory for empty or relative output', async () => {
    for (const output of ['', '.git\n']) {
      const { run } = counting(output);
      expect(await createGroupResolver({ run }).resolve('/x')).toEqual({ key: '/x', kind: 'directory' });
    }
  });

  it('caches each cwd for 60 seconds', async () => {
    let now = 1_000_000;
    const { calls, run } = counting('/repos/a/.git\n');
    const groups = createGroupResolver({ run, now: () => now, realpath: async (p) => p });

    await Promise.all([groups.resolve('/repos/a'), groups.resolve('/repos/a')]);
    expect(calls).toHaveLength(1);

    now += 59_999;
    await groups.resolve('/repos/a');
    expect(calls).toHaveLength(1);

    await groups.resolve('/repos/a/other');
    expect(calls).toHaveLength(2);

    now += 1;
    await groups.resolve('/repos/a');
    expect(calls).toHaveLength(3);
  });

  it('caches failures too, and prune drops expired entries', async () => {
    let now = 0;
    const { calls, run } = counting(new Error('not a repo'));
    const groups = createGroupResolver({ run, now: () => now });
    await groups.resolve('/plain');
    await groups.resolve('/plain');
    expect(calls).toHaveLength(1);
    now = 60_000;
    groups.prune();
    await groups.resolve('/plain');
    expect(calls).toHaveLength(2);
  });
});

describe('isSubmoduleGitDir', () => {
  it('is true under a modules directory inside .git, including in a linked worktree', () => {
    expect(isSubmoduleGitDir('/repo/.git/modules/ui')).toBe(true);
    expect(isSubmoduleGitDir('/repo/.git/modules/libs/ui')).toBe(true);
    expect(isSubmoduleGitDir('/repo/.git/modules/a/modules/b')).toBe(true);
    expect(isSubmoduleGitDir('/repo/.git/worktrees/feature/modules/ui')).toBe(true);
  });

  it('is false for a repo, a bare repo, or a directory merely named modules', () => {
    expect(isSubmoduleGitDir('/repo/.git')).toBe(false);
    expect(isSubmoduleGitDir('/repos/b.git')).toBe(false);
    expect(isSubmoduleGitDir('/repo/.git/modules')).toBe(false);
    expect(isSubmoduleGitDir('/src/modules/ui/.git')).toBe(false);
  });
});

describe('groupLabel', () => {
  const home = '/Users/someone';

  it('is the root basename for the root itself', () => {
    expect(groupLabel('/Users/someone/git', '/Users/someone/git', home)).toBe('git');
  });

  it('is the key relative to its root', () => {
    expect(groupLabel('/Users/someone/git/acme/api', '/Users/someone/git', home)).toBe('acme/api');
  });

  it('is the key with ~ for home when the key is outside the root', () => {
    // A worktree under the root whose main repo isn't.
    expect(groupLabel('/Users/someone/git/repo', '/Users/someone/git/repo-worktrees', home)).toBe('~/git/repo');
  });

  it('is the full key when it is outside both the root and home', () => {
    expect(groupLabel('/srv/repo', '/Users/someone/git', home)).toBe('/srv/repo');
  });

  it('is / for the filesystem root', () => {
    expect(groupLabel('/', '/', home)).toBe('/');
  });
});

describe('shortenHome', () => {
  it('only shortens home itself and paths below it', () => {
    expect(shortenHome('/Users/someone', '/Users/someone')).toBe('~');
    expect(shortenHome('/Users/someone/x', '/Users/someone')).toBe('~/x');
    expect(shortenHome('/Users/someoneelse/x', '/Users/someone')).toBe('/Users/someoneelse/x');
  });

  it('does not shorten when home is the filesystem root or empty', () => {
    expect(shortenHome('/x', '/')).toBe('/x');
    expect(shortenHome('/x', '')).toBe('/x');
  });
});
