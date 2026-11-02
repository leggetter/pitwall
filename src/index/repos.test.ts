import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunError, type RunFile, type RunOptions } from './exec.js';
import { createRepoDiscovery, githubSlugOf, parseRemotes, REPOS_FS_TIMEOUT_MS, REPOS_REFRESH_MS, type DiscoveryTimers, type RepoDiscovery, type RepoDiscoveryOptions } from './repos.js';

// Every repo, remote and path here is made up: example/* on GitHub, and temp directories.

describe('githubSlugOf', () => {
  it('reads https, git@ and ssh:// URLs to github.com, with or without .git, as lowercase owner/name', () => {
    for (const url of [
      'https://github.com/Example/Demo-App',
      'https://github.com/Example/Demo-App.git',
      'https://github.com/Example/Demo-App/',
      'https://github.com/Example/Demo-App.git/',
      'git@github.com:Example/Demo-App.git',
      'git@github.com:Example/Demo-App',
      'ssh://git@github.com/Example/Demo-App.git',
      'ssh://git@github.com/Example/Demo-App',
      'HTTPS://GitHub.com/Example/Demo-App.git',
      '  git@github.com:Example/Demo-App.git  ',
    ]) {
      expect(githubSlugOf(url), url).toBe('example/demo-app');
    }
    expect(githubSlugOf('git@github.com:pat_example/demo.app-2.git')).toBe('pat_example/demo.app-2');
    expect(githubSlugOf('https://github.com/example/demo.git.git')).toBe('example/demo.git');
  });

  it('is nothing for anything else', () => {
    for (const url of [
      'https://gitlab.com/example/demo-app.git',
      'https://github.example.com/example/demo-app.git',
      'https://github.com.example.com/example/demo-app.git',
      'http://github.com/example/demo-app.git',
      'git://github.com/example/demo-app.git',
      'github-work:example/demo-app.git',
      'git@github-work:example/demo-app.git',
      'https://user:secret@github.com/example/demo-app.git',
      'ssh://git@github.com:22/example/demo-app.git',
      'https://github.com/example/demo-app/tree/main',
      'https://github.com/example',
      'https://github.com/example/.',
      'https://github.com/example/..',
      'https://github.com/-example/demo-app',
      'https://github.com/exa mple/demo-app',
      '/home/someone/demo-app',
      '../demo-app',
      '',
    ]) {
      expect(githubSlugOf(url), url).toBeUndefined();
    }
  });
});

describe('parseRemotes', () => {
  it("reads each remote's name and GitHub repo, dots in names included, and leaves out others", () => {
    const output = [
      'remote.origin.url git@github.com:example/demo-app.git',
      'remote.upstream.url https://github.com/example-org/demo-app',
      'remote.my.fork.url ssh://git@github.com/someone/demo-app.git',
      'remote.lab.url https://gitlab.com/example/demo-app.git',
      'remote.origin.url https://github.com/example/second-url.git',
      'remote..url https://github.com/example/no-name.git',
      'remote.nospace',
      'branch.main.remote origin',
      '',
    ].join('\n');
    expect(parseRemotes(output)).toEqual([
      { name: 'origin', slug: 'example/demo-app' },
      { name: 'upstream', slug: 'example-org/demo-app' },
      { name: 'my.fork', slug: 'someone/demo-app' },
    ]);
  });
});

interface GitCall {
  args: readonly string[];
  options: RunOptions;
}

/** A fake git: `config` answers from `remotes` by the `-C` directory, `rev-parse` resolves a worktree's `.git` file. */
function fakeGit(remotes: Map<string, string[]>, delayMs = 0) {
  const calls: GitCall[] = [];
  let running = 0;
  let peak = 0;
  const run: RunFile = async (file, args, options) => {
    expect(file).toBe('git');
    calls.push({ args, options });
    running++;
    peak = Math.max(peak, running);
    try {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const dir = args[1] ?? '';
      if (args[2] === 'rev-parse') {
        const text = await readFile(path.join(dir, '.git'), 'utf8').catch(() => undefined);
        const gitdir = text === undefined ? undefined : /gitdir: (.+)/.exec(text)?.[1];
        if (gitdir === undefined) throw new RunError('exit', 'not a git repository', 128);
        return `${path.dirname(path.dirname(gitdir))}\n`;
      }
      if (args[2] === 'config') {
        const urls = remotes.get(dir);
        if (urls === undefined) throw new RunError('exit', 'exited with code 128', 128);
        if (urls.length === 0) throw new RunError('exit', 'exited with code 1', 1);
        return urls.map((url, i) => `remote.${i === 0 ? 'origin' : `r${i}`}.url ${url}\n`).join('');
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    } finally {
      running--;
    }
  };
  return { run, calls, peak: () => peak, configs: () => calls.filter((call) => call.args[2] === 'config').map((call) => call.args[1]) };
}

/** Timers that run only when the test says. */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { ms: number; callback: () => void }>();
  const timers: DiscoveryTimers = {
    setTimeout(callback, ms) {
      const id = nextId++;
      pending.set(id, { ms, callback });
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    delays: () => [...pending.values()].map((timer) => timer.ms),
    /** Runs every pending timer. */
    fire() {
      const due = [...pending.values()];
      pending.clear();
      for (const timer of due) timer.callback();
    },
  };
}

describe('createRepoDiscovery', () => {
  let dir: string;
  let work: string;
  let oss: string;
  let discovery: RepoDiscovery | undefined;

  const repo = async (at: string, dotGit: 'dir' | string = 'dir') => {
    await mkdir(at, { recursive: true });
    if (dotGit === 'dir') await mkdir(path.join(at, '.git'), { recursive: true });
    else await writeFile(path.join(at, '.git'), dotGit);
    return at;
  };

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-repos-')));
    work = path.join(dir, 'work');
    oss = path.join(dir, 'oss');
    await mkdir(work, { recursive: true });
    await mkdir(oss, { recursive: true });
  });

  afterEach(async () => {
    discovery?.stop();
    discovery = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  function start(options: RepoDiscoveryOptions) {
    discovery = createRepoDiscovery({ timers: fakeTimers().timers, ...options });
    return discovery;
  }

  async function discover(d: RepoDiscovery, roots: string[] = [work, oss], known: { key: string; root: string }[] = []) {
    d.update(roots, known);
    await d.settled();
    return d.repos();
  }

  it('finds the repos in each root and one level down, with their GitHub remotes, by key', async () => {
    const app = await repo(path.join(work, 'demo-app'));
    const api = await repo(path.join(work, 'services', 'demo-api'));
    const site = await repo(path.join(oss, 'site'));
    const git = fakeGit(
      new Map([
        [app, ['git@github.com:example/demo-app.git', 'https://github.com/someone/demo-app']],
        [api, ['https://github.com/example/demo-api.git']],
        [site, ['ssh://git@github.com/example-oss/site.git']],
      ]),
    );
    expect(await discover(start({ run: git.run }))).toEqual([
      { key: site, root: oss, remotes: [{ name: 'origin', slug: 'example-oss/site' }] },
      {
        key: app,
        root: work,
        remotes: [
          { name: 'origin', slug: 'example/demo-app' },
          { name: 'r1', slug: 'someone/demo-app' },
        ],
      },
      { key: api, root: work, remotes: [{ name: 'origin', slug: 'example/demo-api' }] },
    ]);
    expect(discovery?.ready()).toBe(true);
  });

  it('reads remotes with git config --local --no-includes --get-regexp, no shell, and without GIT_DIR and the like', async () => {
    const app = await repo(path.join(work, 'demo-app'));
    const git = fakeGit(new Map([[app, ['git@github.com:example/demo-app.git']]]));
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = '/somewhere/else/.git';
    try {
      await discover(start({ run: git.run }), [work]);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
    expect(git.calls).toHaveLength(1);
    expect(git.calls[0]?.args).toEqual(['-C', app, 'config', '--local', '--no-includes', '--get-regexp', '^remote\\..*\\.url$']);
    expect(git.calls[0]?.options.env?.GIT_DIR).toBeUndefined();
    expect(git.calls[0]?.options.timeoutMs).toBe(5000);
  });

  it('looks no deeper than two levels, nor in hidden directories, node_modules or .worktrees, nor below a repo', async () => {
    const app = await repo(path.join(work, 'demo-app'));
    const deep = await repo(path.join(work, 'a', 'b', 'too-deep'));
    const hidden = await repo(path.join(work, '.hidden', 'repo'));
    const modules = await repo(path.join(work, 'node_modules', 'pkg'));
    const worktree = await repo(path.join(work, 'demo-app', '.worktrees', 'feature'));
    const nested = await repo(path.join(work, 'demo-app', 'vendor'));
    const dotDir = await repo(path.join(work, 'tools', '.cache'));
    const remotes = new Map([deep, hidden, modules, worktree, nested, dotDir, app].map((key) => [key, [`https://github.com/example/${path.basename(key)}`]]));
    const git = fakeGit(remotes);
    expect((await discover(start({ run: git.run }), [work])).map((r) => r.key)).toEqual([app]);
    expect(git.configs()).toEqual([app]);
  });

  it('keys a worktree or submodule by what git resolves its .git file to, and leaves out one git refuses', async () => {
    const main = await repo(path.join(dir, 'elsewhere', 'demo-app'));
    const linked = await repo(path.join(work, 'demo-app-feature'), `gitdir: ${path.join(main, '.git', 'worktrees', 'feature')}\n`);
    await repo(path.join(work, 'broken'), 'not a gitdir line\n');
    const git = fakeGit(new Map([[main, ['git@github.com:example/demo-app.git']]]));
    const repos = await discover(start({ run: git.run }), [work]);
    // Its key is outside every root: its root is the one it was found under.
    expect(repos).toEqual([{ key: main, root: work, remotes: [{ name: 'origin', slug: 'example/demo-app' }] }]);
    expect(git.calls.filter((call) => call.args[2] === 'rev-parse').map((call) => call.args[1])).toEqual(expect.arrayContaining([linked]));
  });

  it('follows a link to a directory, keyed by its real path', async () => {
    const real = await repo(path.join(dir, 'elsewhere', 'linked'));
    await symlink(real, path.join(work, 'linked'));
    const git = fakeGit(new Map([[real, ['git@github.com:example/linked.git']]]));
    expect((await discover(start({ run: git.run }), [work])).map((r) => [r.key, r.root])).toEqual([[real, work]]);
  });

  it('leaves out repos with no GitHub remote, and those git fails in, but counts them', async () => {
    const app = await repo(path.join(work, 'demo-app'));
    const lab = await repo(path.join(work, 'lab'));
    const none = await repo(path.join(work, 'none'));
    await repo(path.join(work, 'fails'));
    const git = fakeGit(new Map([[app, ['git@github.com:example/demo-app.git']], [lab, ['https://gitlab.com/example/lab.git']], [none, []]]));
    const d = start({ run: git.run });
    expect((await discover(d, [work])).map((r) => r.key)).toEqual([app]);
    expect(d.stats()).toMatchObject({ discoveries: 1, repos: 4, withGitHub: 1, gitRuns: 4 });
  });

  it('adds the repos the snapshot knows, wherever they are, with the root it gives unless the key is under one', async () => {
    const app = await repo(path.join(work, 'demo-app'));
    const deep = await repo(path.join(work, 'a', 'b', 'deep'));
    const outside = await repo(path.join(dir, 'outside', 'tool'));
    const git = fakeGit(new Map([[app, ['git@github.com:example/demo-app.git']], [deep, ['git@github.com:example/deep.git']], [outside, ['git@github.com:example/tool.git']]]));
    const repos = await discover(start({ run: git.run }), [work, oss], [
      { key: deep, root: oss },
      { key: outside, root: oss },
      { key: 'relative/path', root: work },
    ]);
    expect(repos.map((r) => [r.key, r.root])).toEqual([
      [app, work],
      [deep, work],
      [outside, oss],
    ].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));
  });

  it('reads a repo the snapshot knows once it names it, without another discovery, and tells the listeners', async () => {
    const app = await repo(path.join(work, 'demo-app'));
    const deep = await repo(path.join(work, 'a', 'b', 'deep'));
    const git = fakeGit(new Map([[app, ['git@github.com:example/demo-app.git']], [deep, ['git@github.com:example/deep.git']]]));
    const d = start({ run: git.run });
    let told = 0;
    d.subscribe(() => told++);
    await discover(d, [work]);
    expect(told).toBe(1);
    // The same snapshot again: nothing new to read, nothing to tell.
    await discover(d, [work]);
    expect(told).toBe(1);
    expect((await discover(d, [work], [{ key: deep, root: work }])).map((r) => r.key)).toEqual([deep, app].sort());
    expect(told).toBe(2);
    expect(git.configs()).toEqual([app, deep]);
    expect(d.stats().discoveries).toBe(1);
  });

  it('reads each repo once while the first discovery runs, a repo the snapshot names meanwhile included', async () => {
    const app = await repo(path.join(work, 'demo-app'));
    const deep = await repo(path.join(work, 'a', 'b', 'deep'));
    const later = await repo(path.join(work, 'a', 'b', 'later'));
    const git = fakeGit(new Map([app, deep, later].map((key) => [key, [`git@github.com:example/${path.basename(key)}.git`]])), 5);
    const d = start({ run: git.run });
    d.update([work], [{ key: deep, root: work }]);
    d.update([work], [{ key: deep, root: work }, { key: later, root: work }]);
    await d.settled();
    expect(d.repos().map((r) => r.key)).toEqual([deep, later, app].sort());
    expect(git.configs().sort()).toEqual([deep, later, app].sort());
  });

  it('finds every repo again every 5 minutes after the last ends, and at once when the roots change or on refresh()', async () => {
    const app = await repo(path.join(work, 'demo-app'));
    const site = await repo(path.join(oss, 'site'));
    const remotes = new Map([[app, ['git@github.com:example/demo-app.git']], [site, ['git@github.com:example/site.git']]]);
    const git = fakeGit(remotes);
    const clock = fakeTimers();
    discovery = createRepoDiscovery({ run: git.run, timers: clock.timers });
    const d = discovery;
    expect((await discover(d, [work])).map((r) => r.key)).toEqual([app]);
    expect(clock.delays()).toEqual([REPOS_REFRESH_MS]);
    // A new remote, seen at the next discovery, not before.
    remotes.set(app, ['git@github.com:example/renamed.git']);
    await discover(d, [work]);
    expect(d.repos()[0]?.remotes[0]?.slug).toBe('example/demo-app');
    clock.fire();
    await d.settled();
    expect(d.repos()[0]?.remotes[0]?.slug).toBe('example/renamed');
    expect(d.stats().discoveries).toBe(2);
    // New roots: at once.
    expect((await discover(d, [work, oss])).map((r) => r.key)).toEqual([site, app].sort());
    expect(d.stats().discoveries).toBe(3);
    d.refresh();
    await d.settled();
    expect(d.stats().discoveries).toBe(4);
    expect(clock.delays()).toEqual([REPOS_REFRESH_MS]);
  });

  it('runs at most 2 git processes at once', async () => {
    const remotes = new Map<string, string[]>();
    for (let i = 0; i < 8; i++) remotes.set(await repo(path.join(work, `repo-${i}`)), [`git@github.com:example/repo-${i}.git`]);
    const git = fakeGit(remotes, 10);
    expect(await discover(start({ run: git.run }), [work])).toHaveLength(8);
    expect(git.peak()).toBe(2);
  });

  it("skips a directory it can't read, and carries on", async () => {
    const app = await repo(path.join(work, 'demo-app'));
    const api = await repo(path.join(work, 'locked', 'demo-api'));
    const git = fakeGit(new Map([[app, ['git@github.com:example/demo-app.git']], [api, ['git@github.com:example/demo-api.git']]]));
    const d = start({
      run: git.run,
      fs: {
        readdir: async (at) => {
          if (at === path.join(work, 'locked')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          return readdir(at, { withFileTypes: true });
        },
      },
    });
    expect((await discover(d, [work, path.join(dir, 'missing-root')])).map((r) => r.key)).toEqual([app]);
  });

  it("skips a directory that doesn't answer within REPOS_FS_TIMEOUT_MS, so the discovery ends and the next one runs, and asks it again only once it has answered (W108)", async () => {
    expect(REPOS_FS_TIMEOUT_MS).toBe(2_000);
    const app = await repo(path.join(work, 'demo-app'));
    const site = await repo(path.join(oss, 'site'));
    // Two hung directories, as on a network mount that stopped answering: one whose listing never
    // comes, with a repo below it, and one whose `.git` lookup never does.
    const hung = path.join(work, 'hung');
    const api = await repo(path.join(hung, 'demo-api'));
    const stuck = await repo(path.join(oss, 'stuck'));
    const git = fakeGit(
      new Map([
        [app, ['git@github.com:example/demo-app.git']],
        [site, ['git@github.com:example/site.git']],
        [api, ['git@github.com:example/demo-api.git']],
        [stuck, ['git@github.com:example/stuck.git']],
      ]),
    );
    const asked = { readdir: 0, dotGit: 0 };
    const answers: (() => void)[] = [];
    const never = () => new Promise<void>((resolve) => answers.push(resolve));
    const d = start({
      run: git.run,
      fsTimeoutMs: 50,
      fs: {
        readdir: async (at) => {
          if (at === hung && asked.readdir++ === 0) await never();
          return readdir(at, { withFileTypes: true });
        },
        dotGit: async (at) => {
          if (at === stuck && asked.dotGit++ === 0) await never();
          return stat(path.join(at, '.git')).then((info) => (info.isDirectory() ? 'dir' : 'file'), () => null);
        },
      },
    });
    const started = performance.now();
    expect((await discover(d)).map((r) => r.key)).toEqual([app, site].sort());
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(d.ready()).toBe(true);
    // The next discovery runs, and doesn't ask either again while it hasn't answered.
    d.refresh();
    await d.settled();
    expect(d.stats().discoveries).toBe(2);
    expect(asked).toEqual({ readdir: 1, dotGit: 1 });
    // Once they answer, late, the next one reads them.
    for (const answer of answers) answer();
    await new Promise((resolve) => setTimeout(resolve, 10));
    d.refresh();
    await d.settled();
    expect(asked).toEqual({ readdir: 2, dotGit: 2 });
    expect(d.repos().map((r) => r.key)).toEqual([app, api, site, stuck].sort());
  });

  it('never throws from update(), and does nothing once stopped', async () => {
    const app = await repo(path.join(work, 'demo-app'));
    const git = fakeGit(new Map([[app, ['git@github.com:example/demo-app.git']]]));
    const d = start({ run: git.run });
    expect(() => d.update([work], null as unknown as [])).not.toThrow();
    d.stop();
    d.update([work, oss], []);
    d.refresh();
    await d.settled();
    expect(git.calls).toHaveLength(0);
  });
});

describe('createRepoDiscovery against real git repos', () => {
  let dir: string;
  let discovery: RepoDiscovery | undefined;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'pitwall test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'pitwall test', GIT_COMMITTER_EMAIL: 'test@example.com' } });

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-repos-git-')));
  });

  afterEach(async () => {
    discovery?.stop();
    discovery = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  /** Every file under `.git`, with its size and modification time. */
  async function gitFiles(repo: string): Promise<string[]> {
    const files = await readdir(path.join(repo, '.git'), { recursive: true });
    return Promise.all(files.sort().map(async (file) => {
      const info = await stat(path.join(repo, '.git', file));
      return `${file} ${info.size} ${info.mtimeMs}`;
    }));
  }

  it("reads each form of GitHub remote, leaves out an included file and the environment's and global config's remotes, a worktree goes to its repo, and changes nothing", async () => {
    const root = path.join(dir, 'oss');
    const app = path.join(root, 'demo-app');
    await mkdir(app, { recursive: true });
    git(app, 'init', '-q');
    git(app, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(app, 'remote', 'add', 'origin', 'git@github.com:Example/Demo-App.git');
    git(app, 'remote', 'add', 'upstream', 'https://github.com/example-org/demo-app');
    git(app, 'remote', 'add', 'fork', 'ssh://git@github.com/someone/demo-app.git');
    git(app, 'remote', 'add', 'lab', 'https://gitlab.com/example/demo-app.git');
    // An included file's remote, which --no-includes leaves out.
    await writeFile(path.join(dir, 'included.gitconfig'), '[remote "included"]\n\turl = https://github.com/example/included.git\n');
    git(app, 'config', 'include.path', path.join(dir, 'included.gitconfig'));
    git(app, 'worktree', 'add', '-q', '-b', 'feature', path.join(root, 'demo-app-feature'));
    const before = await gitFiles(app);
    // Remotes from the environment's config and a global file, which aren't the repo's.
    const globalFile = path.join(dir, 'global.gitconfig');
    await writeFile(globalFile, '[remote "global"]\n\turl = https://github.com/example/global.git\n');
    const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.fake.url', GIT_CONFIG_VALUE_0: 'https://github.com/example/fake.git', GIT_CONFIG_GLOBAL: globalFile };
    const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
    Object.assign(process.env, env);
    try {
      discovery = createRepoDiscovery();
      discovery.update([root], []);
      await discovery.settled();
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(discovery.repos()).toEqual([
      {
        key: app,
        root,
        remotes: [
          { name: 'origin', slug: 'example/demo-app' },
          { name: 'upstream', slug: 'example-org/demo-app' },
          { name: 'fork', slug: 'someone/demo-app' },
        ],
      },
    ]);
    expect(await gitFiles(app)).toEqual(before);
  });
});
